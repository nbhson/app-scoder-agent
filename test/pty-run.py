#!/usr/bin/env python3
"""
PTY runner for TUI integration tests (runs a command in a real pseudo-terminal
from a non-TTY process, where `script`/node-pty are unusable).

Usage:
  pty-run.py [--timeout SECS] [--out FILE] [--send-after PAT:TEXT]... -- CMD [ARGS]...

Behavior:
  - fork a PTY, exec CMD inside it (TERM=xterm-256color, 100x30)
  - stream output into --out file (default stdout)
  - each --send-after PAT:TEXT: once PAT (python regex) matches accumulated
    output, write TEXT (supports \\r \\n) to the PTY, once
  - exit with the child's exit code; on timeout: kill child, exit 124
"""
import argparse
import fcntl
import os
import pty
import re
import select
import signal
import struct
import sys
import termios
import time

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--timeout", type=float, default=40.0)
    ap.add_argument("--out", default=None)
    ap.add_argument("--send-after", action="append", default=[])
    ap.add_argument("cmd", nargs="+")
    args = ap.parse_args()

    sends = []
    for spec in args.send_after:
        text = ""
        count = 1
        # Syntax: [N:]PAT:TEXT — fire on the Nth occurrence of PAT (default 1st)
        m = re.match(r"^(\d+):", spec)
        if m:
            count = int(m.group(1))
            spec = spec[m.end():]
        pat, _, text = spec.partition(":")
        text = text.replace("\\r", "\r").replace("\\n", "\n")
        sends.append([re.compile(pat, re.IGNORECASE), text, False, count, 0])

    out_path = args.out
    pid, fd = pty.fork()
    if pid == 0:
        os.environ["TERM"] = "xterm-256color"
        os.environ.setdefault("COLUMNS", "100")
        os.environ.setdefault("LINES", "30")
        os.execvp(args.cmd[0], args.cmd)
        os._exit(127)

    # PTYs start at 0x0 — TUI frameworks (Ink) need a real window size.
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 30, 100, 0, 0))

    buf = b""
    status = [None]
    deadline = time.monotonic() + args.timeout

    def on_exit():
        pass

    while True:
        if time.monotonic() > deadline:
            os.kill(pid, signal.SIGKILL)
            os.waitpid(pid, 0)
            if out_path:
                with open(out_path, "wb") as f:
                    f.write(buf)
            sys.stderr.write("pty-run: TIMEOUT\n")
            return 124
        try:
            r, _, _ = select.select([fd], [], [], 0.2)
        except OSError:
            break
        if r:
            try:
                chunk = os.read(fd, 65536)
            except OSError:
                break
            if not chunk:
                break
            buf += chunk
            # fire send-after rules
            decoded = buf.decode("utf-8", "replace")
            for entry in sends:
                pat, text, fired, count, seen = entry
                if not fired:
                    entry[4] = seen = len(pat.findall(decoded))
                    if seen >= count:
                        os.write(fd, text.encode())
                        entry[2] = True
        # check child exit (non-blocking)
        try:
            wpid, wstatus = os.waitpid(pid, os.WNOHANG)
            if wpid == pid:
                status[0] = wstatus
                # drain remaining output
                deadline_drain = time.monotonic() + 1.0
                while time.monotonic() < deadline_drain:
                    r, _, _ = select.select([fd], [], [], 0.2)
                    if not r:
                        break
                    try:
                        chunk = os.read(fd, 65536)
                    except OSError:
                        break
                    if not chunk:
                        break
                    buf += chunk
                break
        except ChildProcessError:
            break

    if out_path:
        with open(out_path, "wb") as f:
            f.write(buf)
    else:
        sys.stdout.buffer.write(buf)

    if status[0] is None:
        # Child closed its side (EIO/EOF) — reap its exit status (blocking).
        try:
            _, wstatus = os.waitpid(pid, 0)
            status[0] = wstatus
        except (ProcessLookupError, ChildProcessError):
            pass

    if status[0] is None:
        try:
            os.kill(pid, signal.SIGKILL)
            os.waitpid(pid, 0)
        except (ProcessLookupError, ChildProcessError):
            pass
        sys.stderr.write("pty-run: child did not report an exit status\n")
        return 125
    return os.waitstatus_to_exitcode(status[0])

if __name__ == "__main__":
    sys.exit(main())
