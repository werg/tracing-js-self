"""Tests for expanded Python virtual I/O, shutil, tempfile, subprocess.Popen, and CLI capture in python-reference-worker.py."""

from __future__ import annotations

import json
from pathlib import Path
import subprocess
import sys
import unittest

from tinker_py.codec import decode_readable, encode_readable

REPO = Path(__file__).resolve().parents[2]
WORKER = REPO / "tools" / "python-reference-worker.py"


def _run_worker(payload: dict) -> dict:
    proc = subprocess.run(
        [sys.executable, str(WORKER)],
        input=json.dumps(payload),
        text=True,
        capture_output=True,
        check=False,
        timeout=15,
    )
    if proc.returncode != 0:
        raise AssertionError(f"Worker failed (rc={proc.returncode}): stdout={proc.stdout!r} stderr={proc.stderr!r}")
    return json.loads(proc.stdout)


class PythonWorkerIoExpansionTests(unittest.TestCase):
    def test_os_and_pathlib_mkdir_unlink_rename(self) -> None:
        source = """\
import os
from pathlib import Path

def run():
    os.mkdir("/work/a")
    os.makedirs("/work/a/b", exist_ok=True)
    os.rename("/work/a/old.txt", "/work/a/mid.txt")
    os.replace("/work/a/mid.txt", "/work/a/new.txt")
    os.remove("/work/a/new.txt")
    os.unlink("/work/a/extra.txt")

    p = Path("/work/p")
    p.mkdir(parents=True, exist_ok=True)
    moved = Path("/work/p/f1.txt").rename("/work/p/f2.txt")
    Path("/work/p/f2.txt").unlink()
    Path("/work/p/missing.txt").unlink(missing_ok=True)
    return {"moved": str(moved), "ok": True}
"""
        resp = _run_worker({
            "source": source,
            "entry": "run",
            "args": [],
            "fixture": {
                "calls": [
                    {"operation": "fs.mkdir", "arguments": ["/work/a"], "status": "fulfilled", "result": None},
                    {
                        "operation": "fs.mkdir",
                        "arguments": ["/work/a/b"],
                        "status": "rejected",
                        "result": {"name": "FileExistsError", "message": "already exists"},
                    },
                    {"operation": "fs.rename", "arguments": ["/work/a/old.txt", "/work/a/mid.txt"], "status": "fulfilled", "result": None},
                    {"operation": "fs.rename", "arguments": ["/work/a/mid.txt", "/work/a/new.txt"], "status": "fulfilled", "result": None},
                    {"operation": "fs.unlink", "arguments": ["/work/a/new.txt"], "status": "fulfilled", "result": None},
                    {"operation": "fs.unlink", "arguments": ["/work/a/extra.txt"], "status": "fulfilled", "result": None},
                    {"operation": "fs.mkdir", "arguments": ["/work/p"], "status": "fulfilled", "result": None},
                    {"operation": "fs.rename", "arguments": ["/work/p/f1.txt", "/work/p/f2.txt"], "status": "fulfilled", "result": None},
                    {"operation": "fs.unlink", "arguments": ["/work/p/f2.txt"], "status": "fulfilled", "result": None},
                    {
                        "operation": "fs.unlink",
                        "arguments": ["/work/p/missing.txt"],
                        "status": "rejected",
                        "result": {"name": "FileNotFoundError", "message": "missing"},
                    },
                ],
            },
        })
        self.assertEqual(resp["outcome"]["kind"], "return")
        self.assertEqual(resp["outcome"]["readable"]["value"], {"moved": "/work/p/f2.txt", "ok": True})
        self.assertNotIn("cli", resp)

    def test_shutil_copy_copyfile_move_rmtree(self) -> None:
        source = """\
import shutil

def run():
    r1 = shutil.copyfile("/work/src.bin", "/work/copy1.bin")
    r2 = shutil.copy("/work/copy1.bin", "/work/dir/")
    r3 = shutil.move("/work/dir/copy1.bin", "/work/final.bin")
    shutil.rmtree("/work/dir")
    shutil.rmtree("/work/missing_dir", ignore_errors=True)
    return {"r1": r1, "r2": r2, "r3": r3}
"""
        blob = encode_readable(b"\x01\x02hello")
        resp = _run_worker({
            "source": source,
            "entry": "run",
            "args": [],
            "fixture": {
                "calls": [
                    {"operation": "fs.readBytes", "arguments": ["/work/src.bin"], "status": "fulfilled", "result": blob},
                    {"operation": "fs.writeBytes", "arguments": ["/work/copy1.bin", blob], "status": "fulfilled", "result": None},
                    {"operation": "fs.readBytes", "arguments": ["/work/copy1.bin"], "status": "fulfilled", "result": blob},
                    {"operation": "fs.writeBytes", "arguments": ["/work/dir/copy1.bin", blob], "status": "fulfilled", "result": None},
                    {"operation": "fs.rename", "arguments": ["/work/dir/copy1.bin", "/work/final.bin"], "status": "fulfilled", "result": None},
                    {"operation": "fs.unlink", "arguments": ["/work/dir"], "status": "fulfilled", "result": None},
                    {
                        "operation": "fs.unlink",
                        "arguments": ["/work/missing_dir"],
                        "status": "rejected",
                        "result": {"name": "FileNotFoundError", "message": "not found"},
                    },
                ],
            },
        })
        self.assertEqual(resp["outcome"]["kind"], "return")
        self.assertEqual(
            resp["outcome"]["readable"]["value"],
            {"r1": "/work/copy1.bin", "r2": "/work/dir/copy1.bin", "r3": "/work/final.bin"},
        )

    def test_tempfile_deterministic_virtual_paths(self) -> None:
        source = """\
import tempfile

def run():
    root = tempfile.gettempdir()
    d1 = tempfile.mkdtemp(prefix="job_")
    with tempfile.TemporaryDirectory(prefix="ctx_", suffix="_d") as td:
        inside = td
    with tempfile.NamedTemporaryFile(mode="w", prefix="note_", suffix=".txt", delete=False) as tf1:
        tf1.write("persisted")
        kept_name = tf1.name
    with tempfile.NamedTemporaryFile(mode="w+b", prefix="bin_", suffix=".dat", delete=True) as tf2:
        tf2.write(b"abc")
        tf2.seek(0)
        read_back = tf2.read()
        temp_name = tf2.name
    return {
        "root": root,
        "d1": d1,
        "inside": inside,
        "kept_name": kept_name,
        "temp_name": temp_name,
        "read_back": read_back,
    }
"""
        resp = _run_worker({
            "source": source,
            "entry": "run",
            "args": [],
            "fixture": {
                "calls": [
                    {"operation": "fs.mkdir", "arguments": ["/tmp/job__0001"], "status": "fulfilled", "result": None},
                    {"operation": "fs.mkdir", "arguments": ["/tmp/ctx__0002_d"], "status": "fulfilled", "result": None},
                    {"operation": "fs.unlink", "arguments": ["/tmp/ctx__0002_d"], "status": "fulfilled", "result": None},
                    {"operation": "fs.writeText", "arguments": ["/tmp/note__0003.txt", "persisted"], "status": "fulfilled", "result": None},
                    {
                        "operation": "fs.writeBytes",
                        "arguments": ["/tmp/bin__0004.dat", encode_readable(b"abc")],
                        "status": "fulfilled",
                        "result": None,
                    },
                    {"operation": "fs.unlink", "arguments": ["/tmp/bin__0004.dat"], "status": "fulfilled", "result": None},
                ],
            },
        })
        self.assertEqual(resp["outcome"]["kind"], "return")
        val = decode_readable(resp["outcome"]["readable"]["value"])
        self.assertEqual(val, {
            "root": "/tmp",
            "d1": "/tmp/job__0001",
            "inside": "/tmp/ctx__0002_d",
            "kept_name": "/tmp/note__0003.txt",
            "temp_name": "/tmp/bin__0004.dat",
            "read_back": b"abc",
        })

    def test_subprocess_popen_wrapper(self) -> None:
        source = """\
import subprocess

def run():
    with subprocess.Popen(
        ["tr", "a-z", "A-Z"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        cwd="/workspace",
    ) as p1:
        out1, err1 = p1.communicate(input="hello")
        rc1 = p1.returncode
        polled1 = p1.poll()

    p2 = subprocess.Popen(["check"], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    rc2 = p2.wait()
    out2 = p2.stdout.read()
    err2 = p2.stderr.read()
    return {
        "out1": out1,
        "err1": err1,
        "rc1": rc1,
        "polled1": polled1,
        "is_popen": isinstance(p2, subprocess.Popen),
        "rc2": rc2,
        "out2": out2,
        "err2": err2,
    }
"""
        resp = _run_worker({
            "source": source,
            "entry": "run",
            "args": [],
            "fixture": {
                "calls": [
                    {
                        "operation": "shell.exec",
                        "arguments": [{"args": ["tr", "a-z", "A-Z"], "shell": False, "cwd": "/workspace", "input": "hello"}],
                        "status": "fulfilled",
                        "result": {"returncode": 0, "stdout": "HELLO", "stderr": ""},
                    },
                    {
                        "operation": "shell.exec",
                        "arguments": [{"args": ["check"], "shell": False}],
                        "status": "fulfilled",
                        "result": {"returncode": 3, "stdout": "part", "stderr": "warn"},
                    },
                ],
            },
        })
        self.assertEqual(resp["outcome"]["kind"], "return")
        val = decode_readable(resp["outcome"]["readable"]["value"])
        self.assertEqual(val, {
            "out1": "HELLO",
            "err1": "",
            "rc1": 0,
            "polled1": 0,
            "is_popen": True,
            "rc2": 3,
            "out2": b"part",
            "err2": b"warn",
        })

    def test_cli_capture_mode_and_normal_mode_untouched(self) -> None:
        cli_source = """\
import sys

if __name__ == "__main__":
    data = sys.stdin.read().strip()
    args = sys.argv[1:]
    print(f"args={','.join(args)} stdin={data}")
    print("diag-note", file=sys.stderr)
    if "--fail" in args:
        sys.exit(2)
"""
        ok_resp = _run_worker({
            "source": cli_source,
            "cli": {"argv": ["tool.py", "--mode", "fast"], "stdin": "hello world\n"},
            "fixture": {"calls": []},
        })
        self.assertEqual(ok_resp["outcome"]["kind"], "return")
        self.assertEqual(ok_resp["cli"], {
            "stdout": "args=--mode,fast stdin=hello world\n",
            "stderr": "diag-note\n",
            "exitCode": 0,
        })

        fail_resp = _run_worker({
            "source": cli_source,
            "cli": {"argv": ["tool.py", "--fail"], "stdin": "bad"},
            "fixture": {"calls": []},
        })
        self.assertEqual(fail_resp["outcome"]["kind"], "return")
        self.assertEqual(fail_resp["cli"], {
            "stdout": "args=--fail stdin=bad\n",
            "stderr": "diag-note\n",
            "exitCode": 2,
        })

        # Normal entry(args) mode without cli field stays 100% untouched (print -> platform.print, no cli block)
        normal_resp = _run_worker({
            "source": 'def run(x):\n    print("val", x)\n    return x + 1\n',
            "entry": "run",
            "args": [41],
            "fixture": {
                "calls": [
                    {"operation": "platform.print", "arguments": ["val", 41], "status": "fulfilled", "result": None},
                ],
            },
        })
        self.assertEqual(normal_resp["outcome"]["kind"], "return")
        self.assertEqual(normal_resp["outcome"]["readable"]["value"], 42)
        self.assertNotIn("cli", normal_resp)


if __name__ == "__main__":
    unittest.main()
