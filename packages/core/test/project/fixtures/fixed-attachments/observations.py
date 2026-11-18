"""Receipts and observations for the two attachment windows inside the test container."""

import base64
import codecs
import errno
import fcntl
import os
from pathlib import Path
import select
import signal
import subprocess
import sys
import threading
import time

from attachment import EXPIRED, FIRST, LIMIT, SAMPLES, SECOND, database, log_path, now_ms, row


def initialize():
    with database() as db:
        db.executescript("""
            PRAGMA journal_mode=WAL;
            CREATE TABLE runs(name TEXT PRIMARY KEY, byte_limit INTEGER, state TEXT, error TEXT);
            CREATE TABLE copies(
                id INTEGER PRIMARY KEY, run TEXT, reader TEXT, request TEXT, sample TEXT,
                lifetime INTEGER, deadline INTEGER, byte_limit INTEGER, lose_ack INTEGER,
                state TEXT DEFAULT 'starting', reason TEXT, exit_code INTEGER,
                pending INTEGER DEFAULT 1, cleanup_error TEXT, boots INTEGER DEFAULT 0,
                charged INTEGER DEFAULT 0, turns INTEGER DEFAULT 0, pipe_full INTEGER DEFAULT 0,
                pid INTEGER, witness INTEGER, UNIQUE(run,reader,request)
            );
        """)


def add_run(name, limit=262144, state="running", error=None):
    with database() as db:
        db.execute("INSERT INTO runs VALUES(?,?,?,?)", (name, limit, state, error))


def lease_path(copy_id):
    return Path(f"attachment-{copy_id}.lease")


def released(copy_id):
    try:
        lease = lease_path(copy_id).open("rb")
    except FileNotFoundError:
        return True
    with lease:
        try:
            fcntl.flock(lease, fcntl.LOCK_SH | fcntl.LOCK_NB)
            return True
        except BlockingIOError:
            return False


class AttachmentRead:
    def __init__(self, copy_id, hold_output, witness):
        self.id = copy_id
        self.observed = False
        self.capture = threading.Event()
        self.errors = []
        self.drains = []
        if not hold_output:
            self.capture.set()
        self.ack, ack_writer = os.pipe()
        try:
            with lease_path(copy_id).open("xb") as lease:
                fcntl.flock(lease, fcntl.LOCK_EX)
                self.child = subprocess.Popen(
                    [sys.executable, "-I", "-B", "/fixture/attachment.py", str(copy_id),
                     str(ack_writer), str(lease.fileno()), "witness" if witness else "single"],
                    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                    pass_fds=(ack_writer, lease.fileno()), bufsize=0, start_new_session=True,
                )
        except BaseException:
            os.close(self.ack)
            raise
        finally:
            os.close(ack_writer)
        for stream in ("stdout", "stderr"):
            drain = threading.Thread(target=self._capture, args=(stream,), daemon=True)
            drain.start()
            self.drains.append(drain)

    def _capture(self, stream):
        try:
            with getattr(self.child, stream) as source, log_path(self.id, stream).open("xb", buffering=0) as sink:
                if not self.capture.wait(12):
                    raise TimeoutError("attachment capture gate")
                while block := source.read(2048):
                    sink.write(block)
        except Exception as error:
            self.errors.append(error)

    def control_byte(self, timeout=10):
        if not select.select([self.ack], [], [], timeout)[0]:
            raise TimeoutError("attachment acknowledgement")
        return os.read(self.ack, 1)

    def window(self, token):
        if token not in (FIRST, SECOND):
            raise ValueError("only the two attachment windows are selectable")
        self.child.stdin.write(token)
        try:
            return "ack" if self.control_byte(timeout=2) == b"A" else "delivery_unknown"
        except TimeoutError:
            return "delivery_unknown"

    def eof(self):
        self.child.stdin.close()

    def wait_for_exit(self, cancelled=None, delay_confirmation=False):
        if self.observed:
            return self.child.returncode
        self.capture.set()
        try:
            if cancelled and self.child.poll() is None:
                try:
                    os.killpg(self.child.pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
            try:
                code = self.child.wait(timeout=1 if cancelled else 12)
            except subprocess.TimeoutExpired:
                if not cancelled:
                    raise
                os.killpg(self.child.pid, signal.SIGKILL)
                code = self.child.wait(timeout=2)
            for drain in self.drains:
                drain.join(3)
                if drain.is_alive():
                    raise TimeoutError("attachment stream still open")
            if self.errors:
                raise self.errors[0]
        finally:
            self.eof()
            os.close(self.ack)
        state, reason, exit_code = "exited", None, code
        if code == EXPIRED:
            state, reason, exit_code = "timed_out", "deadline", None
        elif code == LIMIT:
            state, reason, exit_code = "cancelled", "output_limit", None
        elif code < 0 and cancelled:
            state, reason, exit_code = "cancelled", cancelled, None
        pending = delay_confirmation or not released(self.id)
        with database() as db:
            db.execute("UPDATE copies SET state=?,reason=?,exit_code=?,pending=? WHERE id=?",
                       (state, reason, exit_code, pending, self.id))
        self.observed = True
        return code


def begin(run, reader, request, sample, *, lifetime=8000, byte_limit=65536, lose_ack=False,
          hold_output=False, witness=False, crash_at=None):
    if sample not in SAMPLES or reader not in ("alpha", "beta"):
        raise ValueError("unknown fixed sample or reader")
    if not 1 <= lifetime <= 10000 or not 0 <= byte_limit <= 262144:
        raise ValueError("invalid attachment fixture limits")
    with database() as db:
        db.execute("BEGIN IMMEDIATE")
        if not db.execute("SELECT 1 FROM runs WHERE name=?", (run,)).fetchone():
            raise KeyError(run)
        old = db.execute("SELECT id,sample,lifetime FROM copies WHERE run=? AND reader=? AND request=?",
                         (run, reader, request)).fetchone()
        if old:
            if (old["sample"], old["lifetime"]) != (sample, lifetime):
                raise ValueError("request_key_conflict")
            return old["id"], None
        deadline = now_ms() + lifetime
        copy_id = db.execute(
            """INSERT INTO copies(run,reader,request,sample,lifetime,deadline,byte_limit,lose_ack)
               VALUES(?,?,?,?,?,?,?,?)""", (run, reader, request, sample, lifetime, deadline, byte_limit, lose_ack)
        ).lastrowid
        db.commit()
    if crash_at == "reserved":
        os._exit(79)
    if now_ms() >= deadline:
        with database() as db:
            db.execute("UPDATE copies SET state='timed_out',reason='deadline',pending=0 WHERE id=?", (copy_id,))
        return copy_id, None
    handle = AttachmentRead(copy_id, hold_output, witness)
    try:
        if handle.control_byte() != b"R":
            raise RuntimeError("attachment reader did not become ready")
        if crash_at == "spawned":
            os._exit(79)
        with database() as db:
            db.execute("UPDATE copies SET state='running' WHERE id=?", (copy_id,))
        if crash_at == "recorded":
            os._exit(79)
    except BaseException:
        handle.wait_for_exit("start_failed")
        raise
    return copy_id, handle


def recover():
    # Called by a fresh observer after owner death, with no old pipe handles.
    with database() as db:
        db.execute("BEGIN IMMEDIATE")
        db.execute("""UPDATE copies SET state='interrupted',exit_code=NULL,pending=1
                      WHERE state IN ('starting','running')""")
        pending = db.execute("SELECT id FROM copies WHERE pending=1 ORDER BY id").fetchall()
        for item in pending:
            if released(item["id"]):
                db.execute("UPDATE copies SET pending=0 WHERE id=?", (item["id"],))
        db.commit()
    return [item["id"] for item in pending]


def raw_page(copy_id, offsets, limit):
    if not 1 <= limit <= 32768 or len(offsets) != 2:
        raise ValueError("invalid attachment page")
    paths = [log_path(copy_id, stream) for stream in ("stdout", "stderr")]
    remaining = [p.stat().st_size - at for p, at in zip(paths, offsets)]
    if min(offsets) < 0 or min(remaining) < 0:
        raise ValueError("invalid attachment offset")
    left = min(remaining[0], (limit + 1) // 2)
    right = min(remaining[1], limit - left)
    sizes = [min(remaining[0], limit - right), right]
    result = []
    for path, at, count in zip(paths, offsets, sizes):
        with path.open("rb") as file:
            file.seek(at)
            data = file.read(count)
        if len(data) != count:
            raise IOError("short attachment prefix")
        result.append((base64.b64encode(data).decode("ascii"), at + count))
    return result


def text_at(copy_id, offset, limit):
    with log_path(copy_id, "stdout").open("rb") as file:
        file.seek(offset)
        data = file.read(limit)
        end = offset + len(data) == os.fstat(file.fileno()).st_size
    complete = row(copy_id)["state"] not in ("starting", "running")
    decoder = codecs.getincrementaldecoder("utf-8")("strict")
    text = decoder.decode(data, final=complete and end)
    return text, offset + len(text.encode("utf-8"))


def wait_for_turn(copy_id, previous, cancel, wait_ms):
    until = time.monotonic() + wait_ms / 1000
    while time.monotonic() < until:
        if row(copy_id)["turns"] != previous:
            return "changed"
        if cancel.wait(min(0.01, max(0, until - time.monotonic()))):
            return "poll_aborted"
    return "no_change"


class ReaderView:
    """A bound observer of the fixed copies; the original reader never changes."""

    def __init__(self, run, reader):
        if reader not in ("reviewer", "alpha", "beta"):
            raise ValueError("unknown reader")
        self.run, self.reader = run, reader

    def ids(self):
        with database() as db:
            records = db.execute(
                "SELECT id FROM copies WHERE run=? AND (?='reviewer' OR reader=?) ORDER BY id",
                (self.run, self.reader, self.reader),
            )
            return [r["id"] for r in records]

    def require(self, copy_id):
        if copy_id not in self.ids():
            raise PermissionError(errno.EACCES, "attachment copy outside this reader's view")

    def window(self, handle, token):
        self.require(handle.id)
        return handle.window(token)

    def stop(self, handle):
        self.require(handle.id)
        return handle.wait_for_exit("manual_stop")

    def observe(self, handle):
        self.require(handle.id)
        return row(handle.id)


def close_observations(items):
    # An observer can fail to flush its own notes. The other attachment pipes
    # and every worker still need to close before the errors are reported.
    errors = []
    for handle, notes in items:
        try:
            notes.flush()
        except (OSError, ValueError) as error:
            errors.append((handle.id, str(error)))
            with database() as db:
                db.execute("UPDATE copies SET cleanup_error=? WHERE id=?", (str(error), handle.id))
        try:
            handle.wait_for_exit("run_closed")
        except Exception as error:
            errors.append((handle.id, str(error)))
    return errors
