#!/usr/bin/env python3
"""End-to-end: drive the real TUI over a PTY, send a message so the context
token count grows, then /new and assert the status bar resets to the fresh
session's baseline. Uses pyte to reconstruct the terminal screen (the TUI
renders incrementally, so a flat ANSI strip is unreliable).

Requires: pip3 install pyte
"""
import json
import os
import pty
import re
import select
import signal
import shutil
import struct
import subprocess
import sys
import tempfile
import termios
import time
import fcntl
from pathlib import Path

import pyte

ROOT = Path(__file__).resolve().parent.parent
CLI = ROOT / "packages/coding-agent/dist/cli.js"
FAKE = ROOT / "scripts/fake-openai.mjs"
NODE = os.environ.get("NODE", "node")
COLS, ROWS = 120, 40


def answer_queries(fd, data: bytes):
    if b"\x1b[>0q" in data or b"\x1b[>q" in data:
        os.write(fd, b"\x1b[>0u")
    if b"\x1bP+q" in data:
        os.write(fd, b"\x1bP0+r\x1b\\")
    if b"\x1b[c" in data or b"\x1b[0c" in data:
        os.write(fd, b"\x1b[?62;22c")
    if b"\x1b[6n" in data:
        os.write(fd, b"\x1b[1;1R")


def main():
    tmp = Path(tempfile.mkdtemp(prefix="cletus-e2e-new-"))
    home = tmp / "home"; work = tmp / "work"
    home.mkdir(); work.mkdir()

    server = subprocess.Popen([NODE, str(FAKE), "--port", "0"],
                              stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    port = None
    deadline = time.time() + 10
    while time.time() < deadline:
        line = server.stdout.readline().decode()
        m = re.search(r"PORT (\d+)", line)
        if m:
            port = int(m.group(1)); break
    if not port:
        print("FAIL: fake server did not start"); return 1

    config = {
        "defaultModel": "openai/fake",
        "models": [{
            "provider": "openai", "id": "fake", "ref": "openai/fake",
            "baseUrl": f"http://127.0.0.1:{port}/v1", "apiKeyEnv": "FAKE_KEY",
            "contextWindow": 128000, "maxOutputTokens": 8192,
        }],
        "compaction": {"reserveTokens": 16384, "keepRecentTokens": 20000},
        "permissions": {"allowWrite": []},
        "tui": {"showThinking": True, "theme": "dark", "keybindings": {},
                "symbols": {"preset": "unicode"}},
    }
    (home / "config.json").write_text(json.dumps(config))

    pid, fd = pty.fork()
    if pid == 0:
        os.environ["CLETUS_HOME"] = str(home)
        os.environ["FAKE_KEY"] = "dummy"
        os.environ["TERM"] = "xterm-256color"
        os.chdir(work)
        os.execvp(NODE, [NODE, "--disable-warning=ExperimentalWarning",
                         "--experimental-ffi", str(CLI), "--model", "openai/fake"])

    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, COLS, 0, 0))
    screen = pyte.Screen(COLS, ROWS)
    stream = pyte.Stream(screen)

    def drain(seconds):
        end = time.time() + seconds
        while time.time() < end:
            r, _, _ = select.select([fd], [], [], 0.1)
            if r:
                try:
                    chunk = os.read(fd, 65536)
                except OSError:
                    break
                if not chunk:
                    break
                answer_queries(fd, chunk)
                stream.feed(chunk.decode("utf-8", "replace"))

    def send(text):
        os.write(fd, text.encode())

    def screen_text():
        return "\n".join(screen.display)

    def context_used():
        # status bar shows "<used>/128k <pct>%"; used may be ".4k", "4.4k", "3404"
        matches = re.findall(r"(\.?\d[\d.]*[km]?)/128k", screen_text())
        return matches[-1] if matches else None

    def to_tokens(s):
        if s is None: return None
        mult = 1
        if s.endswith("k"): mult, s = 1000, s[:-1]
        elif s.endswith("m"): mult, s = 1_000_000, s[:-1]
        if s.startswith("."): s = "0" + s
        return float(s) * mult

    failed = []
    try:
        for _ in range(40):
            drain(0.5)
            if context_used() is not None:
                break
        baseline = context_used()
        if baseline is None:
            failed.append(f"no context label at startup; screen:\n{screen_text()}")
        elif to_tokens(baseline) != 0:
            failed.append(f"fresh session should show 0 used, got {baseline}")
        send("hello " + "x" * 4000 + "\r")
        for _ in range(20):
            drain(0.5)
            if to_tokens(context_used()) and to_tokens(context_used()) > (to_tokens(baseline) or 0):
                break
        after_msg = context_used()
        if to_tokens(after_msg) is None or (to_tokens(baseline) is not None and to_tokens(after_msg) <= to_tokens(baseline)):
            failed.append(f"usage did not grow: baseline={baseline} after_msg={after_msg}")
        send("/new\r")
        for _ in range(20):
            drain(0.5)
            cur = to_tokens(context_used())
            if cur is not None and to_tokens(after_msg) is not None and cur < to_tokens(after_msg):
                break
        after_new = context_used()
        if to_tokens(after_new) is None or (to_tokens(after_msg) is not None and to_tokens(after_new) >= to_tokens(after_msg)):
            failed.append(f"usage did not reset on /new: after_msg={after_msg} after_new={after_new}")
        if to_tokens(after_new) is not None and to_tokens(after_new) != 0:
            failed.append(f"after /new should reset to 0, got {after_new}")
        print(f"baseline={baseline} after_msg={after_msg} after_new={after_new}")
    finally:
        try: os.write(fd, b"/quit\r")
        except OSError: pass
        drain(0.5)
        try: os.kill(pid, signal.SIGKILL)
        except ProcessLookupError: pass
        try: os.waitpid(pid, 0)
        except ChildProcessError: pass
        os.close(fd)
        server.kill()
        shutil.rmtree(tmp, ignore_errors=True)

    if failed:
        for f in failed: print("FAIL:", f)
        return 1
    print("e2e-new-session passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
