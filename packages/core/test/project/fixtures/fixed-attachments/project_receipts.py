"""Hold the same fixed reads inside a Project-owned sandbox and audit them after its removal."""

import hashlib
import json
import os
from pathlib import Path
import signal
import sys
import time

sys.path.insert(0, "/fixture")
from attachment import ERR_HEADER, FIRST, OUT_HEADER, SECOND, WIDTH, log_path, row
from observations import add_run, begin, initialize, recover, released


def streams(sid):
    result = []
    for stream in ("stdout", "stderr"):
        data = log_path(sid, stream).read_bytes()
        result.append({"bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()})
    return result


def hold(phase):
    sample = "misc1" if phase == "failed" else "misc2"
    directory = Path("/workspace/.fixed-attachment-receipts")
    directory.mkdir()
    os.chdir(directory)
    initialize()
    add_run(phase)
    saved = []
    if phase == "failed":
        sid, known = begin(phase, "alpha", "format-error", sample)
        known.window(SECOND)
        assert known.wait_for_exit(delay_confirmation=True) == 2
        saved.append(sid)
    active = []
    for reader in (("alpha", "beta") if phase == "close" else ("beta",)):
        sid, handle = begin(phase, reader, "active", sample, lifetime=10000)
        assert handle.window(FIRST) == "ack"
        until = time.monotonic() + 3
        first_window_size = WIDTH + len(OUT_HEADER) + len(ERR_HEADER) + 1
        while sum(s["bytes"] for s in streams(sid)) != first_window_size:
            if time.monotonic() >= until:
                raise TimeoutError("attachment bytes not flushed")
            time.sleep(0.01)
        # Freeze the controlled worker while the host restarts. Only removal of
        # this sandbox will release its lease during the integration check.
        os.kill(handle.child.pid, signal.SIGSTOP)
        _, status = os.waitpid(handle.child.pid, os.WUNTRACED)
        assert os.WIFSTOPPED(status) and not released(sid)
        active.append(handle)
        saved.append(sid)
    receipt = {"phase": phase, "sessions": []}
    for sid in saved:
        before = row(sid)
        receipt["sessions"].append({
            "id": sid, "pid": before["pid"], "state": before["state"],
            "exitCode": before["exit_code"], "boots": before["boots"], "streams": streams(sid),
        })
    with open("ready.tmp", "x") as file:
        json.dump(receipt, file)
        file.flush()
        os.fsync(file.fileno())
    os.replace("ready.tmp", "ready.json")
    signal.alarm(60)
    signal.pause()


def inspect(reconcile):
    os.chdir("/receipt")
    receipt = json.loads(Path("ready.json").read_text())
    if reconcile:
        receipt["visited"] = recover()
    for item in receipt["sessions"]:
        sid = item["id"]
        assert streams(sid) == item["streams"]
        item["held"] = not released(sid)
        if reconcile:
            current = row(sid)
            item.update(state=current["state"], exitCode=current["exit_code"],
                        pending=bool(current["pending"]), boots=current["boots"])
    print(json.dumps(receipt), flush=True)


if __name__ == "__main__":
    action = sys.argv[1]
    if action in ("failed", "writeup", "close"):
        hold(action)
    elif action in ("inspect", "reconcile"):
        inspect(action == "reconcile")
    else:
        raise ValueError("unknown fixed receipt check")
