"""Behavior checks for the pinned attachment reader. Each case has its own Docker namespace."""

import array
import base64
from concurrent.futures import ThreadPoolExecutor
import fcntl
import hashlib
import json
import os
from pathlib import Path
import signal
import sys
import tempfile
import termios
import threading
import time
import traceback

sys.path.insert(0, "/fixture")
from attachment import EXPIRED, FIRST, LIMIT, SECOND, SAMPLES, database, log_path, now_ms, row, sample_bytes
from observations import (
    ReaderView, add_run, begin, close_observations, initialize, raw_page, recover,
    released, text_at, wait_for_turn,
)


def until(predicate, seconds=5):
    end = time.monotonic() + seconds
    while not predicate():
        if time.monotonic() >= end:
            raise AssertionError("timed out waiting for " + repr(predicate))
        time.sleep(0.01)


def rejected(error_type, operation, message=None):
    try:
        operation()
    except error_type as error:
        if message:
            assert message in str(error), str(error)
        return
    raise AssertionError(f"expected {error_type.__name__}")


def crash_fixture(action):
    owner = os.fork()
    if owner == 0:
        try:
            action()
        except BaseException:
            traceback.print_exc()
        os._exit(1)
    _, status = os.waitpid(owner, 0)
    assert os.waitstatus_to_exitcode(status) == 79, status
    return owner


def known_windows(sample):
    contents = sample_bytes(sample)
    first = b"\0\xff" + "中".encode() + contents[:12288] + b"\xe2"
    second = b"\x82\xac\0\xff" + "中".encode() + contents[16384:28672]
    err = b"\xfe\0" + "🌍".encode()
    return first, second, err + contents[12288:16384], err + contents[28672:32768]


def t29():
    add_run("a")
    sid, job = begin("a", "alpha", "two-windows", "misc1")
    due = row(sid)["deadline"]
    assert job.child.poll() is None and row(sid)["turns"] == 0
    for index, token in enumerate((FIRST, SECOND), start=1):
        assert job.window(token) == "ack"
        assert job.child.poll() is None
        assert (row(sid)["turns"], row(sid)["deadline"]) == (index, due)
    job.eof()
    job.eof()
    assert job.wait_for_exit() == 0
    assert row(sid)["exit_code"] == 0 and not row(sid)["pending"]
    return dict(turns=2, inputHex=(FIRST+SECOND).hex(), exitCode=0, deadline=due)


def t30():
    add_run("a")
    sid, job = begin("a", "alpha", "binary", "misc2")
    first, second, e1, e2 = known_windows("misc2")
    assert job.window(FIRST) == "ack"
    out_path = log_path(sid, "stdout")
    until(lambda: out_path.stat().st_size == len(first))
    tail = len(first)-1
    assert job.child.poll() is None
    assert text_at(sid, tail, 3) == ("", tail)
    assert job.window(SECOND) == "ack"
    until(lambda: out_path.stat().st_size == len(first+second))
    assert text_at(sid, tail, 3) == ("€", tail+3)
    rejected(UnicodeDecodeError, lambda: text_at(sid, 1, 1))
    job.eof()
    assert job.wait_for_exit() == 0
    expected = [first+second, e1+e2]
    offsets = [0, 0]
    pages = 0
    while offsets != [len(stream) for stream in expected]:
        budget = (3, 379, 1024)[pages % 3]
        result = raw_page(sid, offsets, budget)
        consumed = 0
        for index, (encoded, end) in enumerate(result):
            decoded = base64.b64decode(encoded, validate=True)
            assert decoded == expected[index][offsets[index]:end]
            assert end == offsets[index]+len(decoded)
            consumed += len(decoded)
            offsets[index] = end
        assert 0 < consumed <= budget
        pages += 1
    assert raw_page(sid, offsets, 1) == [("", offsets[0]), ("", offsets[1])]
    partial, short = begin("a", "beta", "terminal-utf8", "misc2")
    assert short.window(FIRST) == "ack"
    short.eof()
    assert short.wait_for_exit() == 0
    rejected(UnicodeDecodeError, lambda: text_at(partial, tail, 3))
    return dict(pages=pages, lengths=offsets, sha256=[hashlib.sha256(s).hexdigest() for s in expected],
                liveUtf8="pending/€", terminalPartial="invalid_encoding")


def t31():
    add_run("a")
    gate = threading.Barrier(6)
    def concurrent_claim(_):
        gate.wait(3)
        return begin("a", "alpha", "same", "misc1")
    with ThreadPoolExecutor(6) as pool:
        claims = list(pool.map(concurrent_claim, range(6)))
    ids = {sid for sid, _ in claims}
    jobs = [job for _, job in claims if job is not None]
    assert len(ids) == len(jobs) == 1 and row(jobs[0].id)["boots"] == 1
    rejected(ValueError, lambda: begin("a", "alpha", "same", "misc2"), "request_key_conflict")
    jobs[0].eof()
    assert jobs[0].wait_for_exit() == 0
    assert begin("a", "alpha", "same", "misc1") == (jobs[0].id, None)
    starts = {}
    for window, expected_boots in (("reserved", 0), ("spawned", 1), ("recorded", 1)):
        crash_fixture(lambda: begin("a", "beta", window, "misc2", crash_at=window))
        sid, duplicate = begin("a", "beta", window, "misc2")
        assert duplicate is None
        until(lambda: released(sid))
        recover()
        observed = row(sid)
        assert observed["state"] == "interrupted" and observed["exit_code"] is None
        assert observed["pending"] == 0 and observed["boots"] == expected_boots
        assert begin("a", "beta", window, "misc2") == (sid, None)
        starts[window] = observed["boots"]
    return dict(concurrentCallers=6, launches=1, conflict="request_key_conflict", crashLaunches=starts)


def t32():
    add_run("a")
    first, _, err, _ = known_windows("misc1")
    counts = {}
    for name, fault in (("closed", 1), ("silent", 2)):
        sid, job = begin("a", "alpha", name, "misc1", lose_ack=fault)
        assert job.window(FIRST) == "delivery_unknown"
        assert job.child.poll() is None
        assert wait_for_turn(sid, 1, threading.Event(), 100) == "no_change"
        job.eof()
        assert job.wait_for_exit() == 0
        assert log_path(sid, "stdout").read_bytes() == first
        assert log_path(sid, "stderr").read_bytes() == err
        assert row(sid)["turns"] == row(sid)["boots"] == 1
        counts[name] = row(sid)["turns"]
    return dict(receipt="delivery_unknown", observedTurns=counts, stdoutBytes=len(first), stderrBytes=len(err))


def t33():
    add_run("a")
    sid, job = begin("a", "alpha", "cancel-wait", "misc2", witness=True)
    witness = row(sid)["witness"]
    assert witness and os.getpgid(witness) == job.child.pid
    cancel, entered = threading.Event(), threading.Event()
    def waiting():
        entered.set()
        return wait_for_turn(sid, 0, cancel, 3000)
    with ThreadPoolExecutor(1) as pool:
        waiter = pool.submit(waiting)
        assert entered.wait(1)
        cancel.set()
        assert waiter.result(2) == "poll_aborted"
    assert job.window(FIRST) == "ack"
    assert job.wait_for_exit("manual_stop") == -signal.SIGTERM
    assert job.wait_for_exit("manual_stop") == -signal.SIGTERM
    until(lambda: not Path(f"/proc/{witness}").exists())
    assert row(sid)["reason"] == "manual_stop" and released(sid)
    cancelled, second = begin("a", "beta", "cancel-reader", "misc1", witness=True)
    child = row(cancelled)["witness"]
    assert second.wait_for_exit("reader_cancelled") == -signal.SIGTERM
    until(lambda: not Path(f"/proc/{child}").exists())
    assert row(cancelled)["state"] == "cancelled"
    timed, third = begin("a", "alpha", "deadline", "misc2", lifetime=1200, witness=True)
    due = row(timed)["deadline"]
    assert third.window(FIRST) == "ack"
    assert wait_for_turn(timed, 1, threading.Event(), 80) == "no_change"
    assert third.wait_for_exit() == EXPIRED
    measured = now_ms()
    observed = row(timed)
    until(lambda: not Path(f"/proc/{observed['witness']}").exists())
    assert observed["state"] == "timed_out" and observed["deadline"] == due
    assert due <= measured < due + 2000 and released(timed)
    return dict(poll="poll_aborted", subsequentInput="ack", groupsReaped=3,
                stop="manual_stop", cancel="reader_cancelled", deadline=due, observedAt=measured)


def t34():
    add_run("slow")
    sid, slow = begin("slow", "alpha", "backpressure", "misc1", hold_output=True)
    with ThreadPoolExecutor(1) as pool:
        pending = pool.submit(slow.window, FIRST)
        until(lambda: row(sid)["pipe_full"])
        queued = array.array("i", [0])
        fcntl.ioctl(slow.child.stdout, termios.FIONREAD, queued, True)
        capacity = fcntl.fcntl(slow.child.stdout, fcntl.F_GETPIPE_SZ)
        assert 0 < queued[0] <= capacity and not pending.done()
        assert log_path(sid, "stdout").stat().st_size == 0
        slow.capture.set()
        assert pending.result(3) == "ack"
    slow.eof()
    assert slow.wait_for_exit() == 0
    first, _, err, _ = known_windows("misc1")
    assert log_path(sid, "stdout").read_bytes() == first and log_path(sid, "stderr").read_bytes() == err
    add_run("limited", limit=18000)
    lengths = []
    for reader, sample, expected_length in (("alpha", "misc1", 12000), ("beta", "misc2", 6000)):
        key, job = begin("limited", reader, sample, sample, byte_limit=12000)
        job.window(FIRST)
        assert job.wait_for_exit() == LIMIT
        receipt = row(key)
        assert (receipt["state"], receipt["reason"]) == ("cancelled", "output_limit")
        assert receipt["charged"] == expected_length
        assert log_path(key, "stdout").read_bytes() == known_windows(sample)[0][:expected_length]
        assert log_path(key, "stderr").stat().st_size == 0 and released(key)
        lengths.append(expected_length)
    assert recover() == []
    empty, job = begin("limited", "alpha", "after-reopen", "misc1")
    job.window(FIRST)
    assert job.wait_for_exit() == LIMIT and row(empty)["charged"] == 0
    add_run("simultaneous", limit=14000)
    pair = [begin("simultaneous", reader, sample, sample, byte_limit=11000)
            for reader, sample in (("alpha", "misc1"), ("beta", "misc2"))]
    with ThreadPoolExecutor(2) as pool:
        list(pool.map(lambda item: item[1].window(FIRST), pair))
    for _, job in pair:
        assert job.wait_for_exit() == LIMIT
    volumes = [row(key)["charged"] for key, _ in pair]
    assert sum(volumes) == 14000 and max(volumes) <= 11000
    for (key, _), length, sample in zip(pair, volumes, ("misc1", "misc2")):
        assert log_path(key, "stdout").read_bytes() == known_windows(sample)[0][:length]
    return dict(blockedBytes=queued[0], pipeCapacity=capacity, retainedBytes=lengths,
                grantedAfterReopen=0, concurrentBytes=volumes)


def t35():
    for name in ("a", "b"):
        add_run(name)
    sid, job = begin("a", "alpha", "owned", "misc1")
    foreign, other = begin("b", "alpha", "owned", "misc2")
    owner, lead = ReaderView("a", "alpha"), ReaderView("a", "reviewer")
    denied = 0
    for view in (ReaderView("a", "beta"), ReaderView("b", "alpha"), ReaderView("b", "reviewer")):
        assert sid not in view.ids()
        for action in (lambda: view.window(job, FIRST), lambda: view.stop(job), lambda: view.observe(job)):
            rejected(PermissionError, action)
            denied += 1
    assert row(sid)["turns"] == 0 and job.child.poll() is None
    assert owner.window(job, FIRST) == lead.window(job, SECOND) == "ack"
    assert lead.observe(job)["reader"] == owner.observe(job)["reader"] == "alpha"
    assert lead.ids() == [sid] and ReaderView("b", "reviewer").ids() == [foreign]
    assert lead.stop(job) == -signal.SIGTERM
    assert other.child.poll() is None and row(foreign)["turns"] == 0
    other.eof()
    assert other.wait_for_exit() == 0
    return dict(deniedOperations=denied, readWindows=2, originalReader=row(sid)["reader"], otherRunExit=0)


def t36():
    add_run("failed", state="failed", error="original attachment observation")
    add_run("writeup", state="writing_writeup")
    def owner():
        _, known = begin("failed", "alpha", "known", "misc1")
        known.window(SECOND)  # An observed format error exits the fixed reader with code 2.
        assert known.wait_for_exit(delay_confirmation=True) == 2
        lost, waiting = begin("writeup", "beta", "lost", "misc2")
        assert waiting.window(FIRST) == "ack"
        first, _, stderr, _ = known_windows("misc2")
        until(lambda: log_path(lost, "stdout").stat().st_size == len(first)
              and log_path(lost, "stderr").stat().st_size == len(stderr))
        os.kill(waiting.child.pid, signal.SIGSTOP)
        _, status = os.waitpid(waiting.child.pid, os.WUNTRACED)
        assert os.WIFSTOPPED(status)
        os._exit(79)
    dead_owner = crash_fixture(owner)
    with database() as db:
        known, lost = [r["id"] for r in db.execute("SELECT id FROM copies ORDER BY id")]
    assert released(known) and not released(lost)
    survivor = row(lost)["pid"]
    try:
        first_scan = recover()
        assert first_scan == [known, lost] and row(known)["pending"] == 0 and row(lost)["pending"] == 1
        assert (row(known)["state"], row(known)["exit_code"]) == ("exited", 2)
        assert (row(lost)["state"], row(lost)["exit_code"]) == ("interrupted", None)
        assert begin("writeup", "beta", "lost", "misc2") == (lost, None)
    finally:
        os.kill(survivor, signal.SIGCONT)
    until(lambda: released(lost) and not Path(f"/proc/{survivor}").exists())
    assert recover() == [lost] and recover() == []
    assert row(lost)["boots"] == row(lost)["turns"] == 1
    assert row(lost)["state"] == "interrupted" and row(lost)["exit_code"] is None
    first, _, stderr, _ = known_windows("misc2")
    assert log_path(lost, "stdout").read_bytes() == first and log_path(lost, "stderr").read_bytes() == stderr
    with database() as db:
        failed = db.execute("SELECT state,error FROM runs WHERE name='failed'").fetchone()
        assert tuple(failed) == ("failed", "original attachment observation")
        assert db.execute("SELECT state FROM runs WHERE name='writeup'").fetchone()[0] == "writing_writeup"
    return dict(ownerPid=dead_owner, workerPid=survivor, scans=[2,1,0], preservedExit=2,
                unobservedExit=None, launchesAfterRecovery=row(lost)["boots"], retainedBytes=len(first)+len(stderr))


def t38():
    add_run("a", state="failed", error="original attachment error")
    one, first = begin("a", "alpha", "first", "misc1")
    two, second = begin("a", "beta", "second", "misc2")
    assert first.window(FIRST) == second.window(FIRST) == "ack"
    closed_notes = open("first-observer.notes", "wb")
    closed_notes.close()
    with open("second-observer.notes", "wb") as other_notes:
        other_notes.write(b"second observer")
        errors = close_observations([(first, closed_notes), (second, other_notes)])
        assert Path("second-observer.notes").read_bytes() == b"second observer"
    assert len(errors) == 1 and errors[0][0] == one and "closed" in errors[0][1]
    assert row(one)["cleanup_error"] == errors[0][1] and row(two)["cleanup_error"] is None
    for sid, job, sample in ((one, first, "misc1"), (two, second, "misc2")):
        assert job.child.poll() == -signal.SIGTERM and released(sid)
        assert row(sid)["state"] == "cancelled" and row(sid)["pending"] == 0
        out, _, err, _ = known_windows(sample)
        assert log_path(sid, "stdout").read_bytes() == out and log_path(sid, "stderr").read_bytes() == err
    assert recover() == []
    with database() as db:
        assert db.execute("SELECT error FROM runs WHERE name='a'").fetchone()[0] == "original attachment error"
    return dict(confirmedStops=2, hookError=errors[0][1], otherObserverFlushed=True,
                pending=0, originalRunError="original attachment error")


CASES = {"T29": t29, "T30": t30, "T31": t31, "T32": t32, "T33": t33, "T34": t34,
         "T35": t35, "T36": t36, "T38": t38}

if __name__ == "__main__":
    case = sys.argv[1]
    if not __debug__:
        raise RuntimeError("assertions must be enabled for the attachment checks")
    for name in SAMPLES:
        sample_bytes(name)
    # Only this container's disposable tmpfs holds the ledger and raw observations.
    os.chdir(tempfile.mkdtemp(dir="/tmp", prefix="attachment-"))
    initialize()
    observations = CASES[case]()
    print(json.dumps({"case": case, "samples": SAMPLES, "observations": observations}), flush=True)
