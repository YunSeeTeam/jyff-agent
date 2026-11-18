"""Trusted, bounded control plane for one attached process in the Solver container.

Only JSON control frames use stdout. Child output is written as raw bytes to the
Run's dedicated mount, and never crosses the Docker CLI's text channel.
"""

import base64
import json
import os
import selectors
import signal
import subprocess
import sys
import time


def frame(**data):
    sys.stdout.write(json.dumps(data, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def main():
    command, cwd, directory, deadline_text, quota_text = sys.argv[1:]
    deadline = float(deadline_text)
    quota = int(quota_text)
    try:
        os.mkdir(directory, 0o700)
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW
        stdout_file = os.open(directory + "/stdout.bin", flags, 0o600)
        stderr_file = os.open(directory + "/stderr.bin", flags, 0o600)
        child = subprocess.Popen(
            ["bash", "-c", command], cwd=cwd, stdin=subprocess.PIPE,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True,
            bufsize=0,
        )
    except Exception as error:
        frame(type="start_error", message=str(error)[:512])
        return 1

    frame(type="started", pid=child.pid)
    selector = selectors.DefaultSelector()
    os.set_blocking(0, False)
    selector.register(0, selectors.EVENT_READ, "control")
    files = {"stdout": stdout_file, "stderr": stderr_file}
    lengths = {"stdout": 0, "stderr": 0}
    for name, pipe in (("stdout", child.stdout), ("stderr", child.stderr)):
        os.set_blocking(pipe.fileno(), False)
        selector.register(pipe, selectors.EVENT_READ, name)
    os.set_blocking(child.stdin.fileno(), False)
    control = bytearray()
    pending = bytearray()
    pending_seq = None
    pending_eof = False
    reason = None
    kill_at = None

    def terminate(why, grace=2.0):
        nonlocal reason, kill_at
        if reason is not None:
            return
        reason = why
        kill_at = time.monotonic() + grace
        try:
            os.killpg(child.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass

    def acknowledge():
        nonlocal pending_seq, pending_eof
        if pending_seq is None or pending:
            return
        selector.unregister(child.stdin)
        if pending_eof and not child.stdin.closed:
            child.stdin.close()
        frame(type="ack", seq=pending_seq, acceptedBytes=accepted)
        pending_seq = None
        pending_eof = False

    accepted = 0
    while True:
        now = time.time()
        if now >= deadline and reason is None:
            terminate("deadline")
        if kill_at is not None and time.monotonic() >= kill_at:
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            kill_at = None
        for key, _ in selector.select(0.05):
            if key.data in files:
                name = key.data
                chunk = os.read(key.fileobj.fileno(), 65536)
                if not chunk:
                    selector.unregister(key.fileobj)
                    continue
                remaining = quota - lengths["stdout"] - lengths["stderr"]
                part = chunk[:max(0, remaining)]
                while part:
                    written = os.write(files[name], part)
                    lengths[name] += written
                    part = part[written:]
                if len(chunk) > remaining or remaining == 0:
                    terminate("output_limit")
            elif key.data == "input":
                try:
                    written = os.write(child.stdin.fileno(), pending)
                    del pending[:written]
                    acknowledge()
                except (BrokenPipeError, OSError):
                    selector.unregister(child.stdin)
                    child.stdin.close()
                    frame(type="write_error", seq=pending_seq, message="stdin closed")
                    pending.clear()
                    pending_seq = None
            else:
                chunk = os.read(0, 65536)
                if not chunk:
                    selector.unregister(0)
                    terminate("disconnected")
                    continue
                control.extend(chunk)
                if len(control) > 65536:
                    terminate("invalid_control")
                    continue
                while b"\n" in control:
                    line, _, rest = control.partition(b"\n")
                    control = bytearray(rest)
                    try:
                        request = json.loads(line)
                        kind = request["type"]
                        if kind == "stop":
                            terminate("stopped", min(10, max(0, int(request.get("graceMs", 2000))) / 1000))
                        elif kind == "write":
                            seq = request["seq"]
                            data = base64.b64decode(request.get("data", ""), validate=True)
                            if pending_seq is not None or len(data) > 16384 or child.stdin.closed:
                                raise ValueError("invalid or overlapping write")
                            pending_seq = seq
                            pending.extend(data)
                            accepted = len(data)
                            pending_eof = request.get("eof") is True
                            if pending:
                                selector.register(child.stdin, selectors.EVENT_WRITE, "input")
                            elif pending_eof:
                                child.stdin.close()
                                frame(type="ack", seq=seq, acceptedBytes=0)
                                pending_seq = None
                            else:
                                frame(type="ack", seq=seq, acceptedBytes=0)
                                pending_seq = None
                        else:
                            raise ValueError("unknown control frame")
                    except Exception as error:
                        frame(type="control_error", message=str(error)[:256])
        if child.poll() is not None and not any(
            key.data in files for key in selector.get_map().values()
        ):
            break

    for descriptor in files.values():
        os.fsync(descriptor)
        os.close(descriptor)
    code = child.returncode if child.returncode is not None and child.returncode >= 0 else None
    state = "exited" if reason is None else (
        "timed_out" if reason == "deadline" else
        "cancelled" if reason in ("stopped", "output_limit") else "interrupted"
    )
    frame(type="exit", state=state, exitCode=code, stopReason=reason,
          stdoutBytes=lengths["stdout"], stderrBytes=lengths["stderr"])
    return 0


if __name__ == "__main__":
    sys.exit(main())
