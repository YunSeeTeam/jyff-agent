"""The only job in this offline fixture: copy two fixed windows from a pinned ZIP."""

import contextlib
import fcntl
import hashlib
import os
from pathlib import Path
import select
import signal
import sqlite3
import sys
import time


SAMPLES = {
    "misc1": "b4f338efcdd52d870708498d6c06bb3d5fe9755a5575a57e464d32037453ee05",
    "misc2": "e4744f33f74a384df4f162898c8b045624bd98a37446079af045b81f42407e66",
}
FIRST, SECOND = b"\xa1", b"\xa2"
WIDTH = 16384
LIMIT, EXPIRED = 72, 73
OUT_HEADER, ERR_HEADER = b"\x00\xff\xe4\xb8\xad", b"\xfe\x00\xf0\x9f\x8c\x8d"


def sample_bytes(name):
    expected = SAMPLES[name]
    data = Path("/samples", name + ".zip").read_bytes()
    if hashlib.sha256(data).hexdigest() != expected:
        raise ValueError("unexpected attachment digest: " + name)
    return data


@contextlib.contextmanager
def database():
    db = sqlite3.connect("copies.sqlite", isolation_level=None, timeout=5)
    db.row_factory = sqlite3.Row
    try:
        yield db
    finally:
        db.close()


def now_ms():
    return time.time_ns() // 1_000_000


def row(copy_id):
    with database() as db:
        result = db.execute("SELECT * FROM copies WHERE id=?", (copy_id,)).fetchone()
    if result is None:
        raise KeyError(copy_id)
    return dict(result)


def log_path(copy_id, stream):
    if stream not in ("stdout", "stderr"):
        raise ValueError("unknown attachment stream")
    return Path(f"copy-{copy_id}-{stream}.bin")


def charge(copy_id, wanted):
    # Count granted bytes before the pipe write. A lost observation cannot free
    # credit on reopen. Both streams and all copies of a Run share this counter.
    with database() as db:
        db.execute("BEGIN IMMEDIATE")
        limits = db.execute(
            """SELECT c.byte_limit-c.charged AS per_copy,
                      r.byte_limit-(SELECT SUM(charged) FROM copies WHERE run=c.run) AS per_run
               FROM copies c JOIN runs r ON r.name=c.run WHERE c.id=?""", (copy_id,)
        ).fetchone()
        allowed = min(wanted, limits["per_copy"], limits["per_run"])
        db.execute("UPDATE copies SET charged=charged+? WHERE id=?", (allowed, copy_id))
        db.commit()
    return allowed


def emit(copy_id, fd, data, deadline):
    view = memoryview(data)[:charge(copy_id, len(data))]
    allowed = len(view)
    while view:
        left = (deadline - now_ms()) / 1000
        if left <= 0:
            return EXPIRED
        try:
            sent = os.write(fd, view[:4096])
            view = view[sent:]
        except BlockingIOError:
            with database() as db:
                db.execute("UPDATE copies SET pipe_full=1 WHERE id=?", (copy_id,))
            if not select.select([], [fd], [], left)[1]:
                return EXPIRED
    return 0 if allowed == len(data) else LIMIT


def run_copy(copy_id, ack, lease, observe_group):
    receipt = row(copy_id)
    data = sample_bytes(receipt["sample"])
    deadline = receipt["deadline"]
    for fd in (1, 2):
        fcntl.fcntl(fd, fcntl.F_SETPIPE_SZ, 4096)
        os.set_blocking(fd, False)
    # A known child in the same group is used only in the cancellation case.
    witness = os.fork() if observe_group else None
    if witness == 0:
        for fd in (ack, lease, 0, 1, 2):
            os.close(fd)
        signal.alarm(15)
        signal.pause()
        os._exit(0)
    try:
        with database() as db:
            db.execute("UPDATE copies SET boots=boots+1,pid=?,witness=? WHERE id=?",
                       (os.getpid(), witness, copy_id))
        os.write(ack, b"R")
        turns = 0
        while True:
            left = (deadline - now_ms()) / 1000
            if left <= 0 or not select.select([0], [], [], left)[0]:
                return EXPIRED
            token = os.read(0, 1)
            if not token:
                return 0
            if turns >= 2 or token != (FIRST, SECOND)[turns]:
                return 2
            start = turns * WIDTH
            turns += 1
            with database() as db:
                db.execute("UPDATE copies SET turns=turns+1 WHERE id=?", (copy_id,))
            # The euro sign straddles the two separately acknowledged windows.
            out = OUT_HEADER + data[start:start + 12288]
            out = out + b"\xe2" if turns == 1 else b"\x82\xac" + out
            for fd, block in ((1, out),
                              (2, ERR_HEADER + data[start + 12288:start + WIDTH])):
                failure = emit(copy_id, fd, block, deadline)
                if failure:
                    return failure
            if receipt["lose_ack"] == 2 and turns == 1:
                continue  # Leave the receipt pipe open, but drop this acknowledgement.
            if receipt["lose_ack"] == 1 and turns == 1:
                os.close(ack)
                ack = None
            if ack is not None:
                os.write(ack, b"A")
    finally:
        if witness:
            try:
                os.kill(witness, signal.SIGTERM)
            except ProcessLookupError:
                pass
            os.waitpid(witness, 0)


if __name__ == "__main__":
    # No command, path or data is accepted from the control pipe.
    sys.exit(run_copy(int(sys.argv[1]), int(sys.argv[2]), int(sys.argv[3]), sys.argv[4] == "witness"))
