#!/usr/bin/env python3
"""Build and 2x-verify Wave 2 Counterfactual Effectful I/O & Shell pairs for Python.

Generates 66 brand-new realistic Python effectful families (156+ paired tasks, all causal-pair)
covering shell.exec, http.request (urllib & requests), fs.*, env.get, kv_get/kv_set,
platform.time/log/uuid/secrets/random, and multi-service chains.

Every task is recorded via the exact replay I/O & HTTP hooks, then independently verified 2x:
  (1) export_python_example() via tools/python-reference-worker.py + audit_python_conversation()
  (2) separate child process tools/tinker-execution-py.py (export + live start/step/grade replay)
Plus causal-prefix invariance checks and zero-future-leakage audit_python_supervision().
"""

from __future__ import annotations

import argparse
import builtins
import concurrent.futures
import hashlib
import io
import json
from pathlib import Path
import random
import subprocess
import sys
import time
from typing import Any

_REPO_ROOT = Path(__file__).resolve().parents[1]
_TRAINING_DIR = str(_REPO_ROOT / "training")
if _TRAINING_DIR not in sys.path:
    sys.path.insert(0, _TRAINING_DIR)

from tinker_py.codec import decode_readable, encode_readable  # noqa: E402
from tinker_py.execution import (  # noqa: E402
    audit_python_supervision,
    export_python_example,
)
from tinker_py.http_tools import install_replay_http_hooks  # noqa: E402
from tinker_py.io_tools import install_replay_io_hooks, is_guest_caller  # noqa: E402


def _json_compact(val: Any) -> str:
    return json.dumps(val, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def _sha256(val: str) -> str:
    return hashlib.sha256(val.encode("utf-8")).hexdigest()


# ---------------------------------------------------------------------------
# In-process recorder backed by exact tinker_py replay hooks
# ---------------------------------------------------------------------------
_ACTIVE_RESPONDER: list[Any] = [None]
_ACTIVE_RECORDED: list[list[dict[str, Any]]] = [[]]
_IO_DEPTH: list[int] = [0]
_HOOKS_INSTALLED = False
_GUEST_BUILTINS_BASE: dict[str, Any] = {}
_ORIG_TIME = time.time
_ORIG_MONOTONIC = time.monotonic
_ORIG_RANDOM = random.random
_ACTIVE_TOOL_RANDOM: list[bool] = [False]


def _build_guest_exc(value: Any) -> Exception:
    if isinstance(value, dict) and isinstance(value.get("name"), str):
        exc_cls = getattr(builtins, value["name"], None)
        if isinstance(exc_cls, type) and issubclass(exc_cls, Exception):
            return exc_cls(str(value.get("message", "")))
        return RuntimeError(f"{value['name']}: {value.get('message', '')}")
    return RuntimeError(str(value))


def _record_invoke(operation: str, call_args: list[Any], exc_builder: Any = None) -> Any:
    responder = _ACTIVE_RESPONDER[0]
    if responder is None:
        raise RuntimeError(f"Recorder invoked without active responder for {operation}")
    recorded = _ACTIVE_RECORDED[0]
    idx = len(recorded)
    if idx >= 128:
        raise RuntimeError("Too many recorded calls")
    cloned_args = decode_readable(encode_readable(call_args))
    reply = responder(operation, cloned_args, idx)
    status = reply.get("status", "fulfilled")
    result = reply.get("result")
    recorded.append({
        "operation": operation,
        "arguments": encode_readable(call_args),
        "status": status,
        "result": encode_readable(result, allow_exceptions=True) if status == "fulfilled" else result,
    })
    if status == "rejected":
        if callable(exc_builder):
            raise exc_builder(result)
        raise _build_guest_exc(result)
    return decode_readable(encode_readable(result, allow_exceptions=True))


class _HostRecorderProxy:
    _METHODS = {
        "fs_read_text": "fs.readText",
        "fs_write_text": "fs.writeText",
        "http_get": "http.get",
        "http_request": "http.request",
        "kv_get": "kv_get",
        "kv_set": "kv_set",
    }

    def __getattr__(self, name: str) -> Any:
        if name in self._METHODS:
            op = self._METHODS[name]
            return lambda *a: _record_invoke(op, list(a))
        raise AttributeError(name)


def _ensure_hooks_installed() -> Any:
    global _HOOKS_INSTALLED, _GUEST_BUILTINS_BASE
    if _HOOKS_INSTALLED:
        return _FLUSH_FN
    _GUEST_BUILTINS_BASE = dict(vars(builtins))
    _GUEST_BUILTINS_BASE["print"] = lambda *a, **_kw: _record_invoke("platform.print", list(a))
    flush_fn = install_replay_io_hooks(
        _record_invoke,
        io_depth=_IO_DEPTH,
        guest_builtins=_GUEST_BUILTINS_BASE,
    )
    install_replay_http_hooks(_record_invoke, enable_urllib=True, enable_requests=True)

    def _p_time() -> float:
        if not is_guest_caller(_IO_DEPTH):
            return _ORIG_TIME()
        return float(_record_invoke("platform.time", []))

    def _p_monotonic() -> float:
        if not is_guest_caller(_IO_DEPTH):
            return _ORIG_MONOTONIC()
        return float(_record_invoke("platform.time", []))

    def _p_random() -> float:
        if _ACTIVE_TOOL_RANDOM[0] and is_guest_caller(_IO_DEPTH):
            return float(_record_invoke("platform.random", []))
        return _ORIG_RANDOM()

    time.time = _p_time  # type: ignore[assignment]
    time.monotonic = _p_monotonic  # type: ignore[assignment]
    random.random = _p_random  # type: ignore[assignment]
    _HOOKS_INSTALLED = True
    return flush_fn


_FLUSH_FN: Any = None


def _record_py_fixture(
    *,
    source: str,
    entry: str,
    args: list[Any],
    script: dict[str, list[Any]],
    native_bindings: list[dict[str, Any]] | None = None,
    random_mode: str = "seeded",
    random_seed: int = 17,
    allow_throw: bool = False,
) -> list[dict[str, Any]]:
    global _FLUSH_FN
    _FLUSH_FN = _ensure_hooks_installed()
    queues: dict[str, list[Any]] = {k: list(v) for k, v in script.items()}

    def responder(op: str, call_args: list[Any], idx: int) -> dict[str, Any]:
        if op in ("platform.log", "platform.print"):
            return {"status": "fulfilled", "result": None}
        q = queues.get(op)
        if not q:
            raise RuntimeError(f"Queue exhausted for {op} at call #{idx} args={call_args!r}")
        item = q.pop(0)
        if isinstance(item, dict) and set(item.keys()).issubset({"status", "result"}) and ("status" in item or "result" in item):
            return {"status": item.get("status", "fulfilled"), "result": item.get("result")}
        return {"status": "fulfilled", "result": item}

    recorded: list[dict[str, Any]] = []
    _ACTIVE_RESPONDER[0] = responder
    _ACTIVE_RECORDED[0] = recorded
    _ACTIVE_TOOL_RANDOM[0] = random_mode == "tool"
    if random_mode != "tool":
        random.seed(random_seed)

    extra_globals: dict[str, Any] = {"host": _HostRecorderProxy()}
    for b in native_bindings or []:
        bname = b["name"]
        extra_globals[bname] = (lambda _op: (lambda *a: _record_invoke(_op, list(a))))(bname)

    guest_ns: dict[str, Any] = {
        "__builtins__": dict(_GUEST_BUILTINS_BASE),
        "__name__": "__guest__",
        **extra_globals,
    }
    code = compile(source, "<guest>", "exec")
    old_stdout = sys.stdout
    try:
        sys.stdout = io.StringIO()
        exec(code, guest_ns)
        fn = guest_ns[entry]
        args_copy = decode_readable(encode_readable(args))
        try:
            fn(*args_copy)
            _FLUSH_FN()
        except Exception:
            if not allow_throw:
                raise
    finally:
        sys.stdout = old_stdout
        _ACTIVE_RESPONDER[0] = None
        _ACTIVE_TOOL_RANDOM[0] = False

    return recorded


def ok(val: Any) -> dict[str, Any]:
    return {"status": "fulfilled", "result": val}


def fail(name: str, message: str) -> dict[str, Any]:
    return {"status": "rejected", "result": {"name": name, "message": message}}


def sh(stdout: str = "", stderr: str = "", rc: int = 0) -> dict[str, Any]:
    return ok({"returncode": rc, "stdout": stdout, "stderr": stderr})


def hresp(status: int, body: Any, headers: dict[str, str] | None = None, url: str = "") -> dict[str, Any]:
    text_body = body if isinstance(body, (str, bytes)) else json.dumps(body)
    hdrs = headers if headers is not None else {"Content-Type": "application/json"}
    return ok({"status": status, "url": url, "headers": hdrs, "body": text_body})


KV_DEL_BINDINGS = [
    {"name": "kv_del", "kind": "synchronous", "description": "Delete key from KV store; returns bool."},
]


# ===========================================================================
# 66 Brand-New Realistic Python Effectful Families (158 Paired Tasks)
#   Group 1: 14 shell.exec families (34 tasks)
#   Group 2: 20 http.request families (48 tasks)
#   Group 3: 16 fs.* families (38 tasks)
#   Group 4: 16 kv / env / platform / random / uuid / secrets / multi-service families (38 tasks)
# ===========================================================================
def build_family_specs() -> list[dict[str, Any]]:
    specs: list[dict[str, Any]] = []

    # =========================================================================
    # GROUP 1: SHELL.EXEC (14 families, 34 tasks)
    # =========================================================================

    # 1. git-status-diff-commit
    specs.append({
        "slug": "git-status-diff-commit",
        "domain": "shell",
        "features": ["shell", "shell.exec", "logging", "platform.log"],
        "source": """\
import logging
import subprocess


def run(repo_dir, commit_msg):
    st = subprocess.run(["git", "-C", repo_dir, "status", "--porcelain"], capture_output=True, text=True)
    lines = [ln for ln in st.stdout.splitlines() if ln.strip()]
    if not lines:
        logging.info("repo clean %s", repo_dir)
        return {"committed": False, "reason": "clean", "changed": []}
    changed = [ln.split()[-1] for ln in lines]
    diff = subprocess.run(["git", "-C", repo_dir, "diff", "--cached", "--quiet"], capture_output=True, text=True)
    if diff.returncode == 0:
        logging.warning("no staged files in %s", repo_dir)
        return {"committed": False, "reason": "nothing-staged", "changed": changed}
    cm = subprocess.run(["git", "-C", repo_dir, "commit", "-m", commit_msg], capture_output=True, text=True)
    if cm.returncode != 0:
        logging.error("commit failed rc=%d", cm.returncode)
        return {"committed": False, "reason": "commit-error", "stderr": cm.stderr.strip()}
    return {"committed": True, "reason": "ok", "changed": changed, "first_line": cm.stdout.splitlines()[0]}
""",
        "args": ["/srv/pyrepo", "feat: add cache"],
        "branches": [
            ("clean-tree", {"shell.exec": [sh("")]}),
            ("unstaged-only", {"shell.exec": [sh(" M app.py\n?? notes.txt\n"), sh("", "", 0)]}),
            ("staged-commit-ok", {"shell.exec": [sh("M  app.py\n"), sh("", "", 1), sh("[main 3f9c11a] feat: add cache\n 1 file changed\n")]}),
        ],
    })

    # 2. pytest-rerun-failed-only
    specs.append({
        "slug": "pytest-rerun-failed-only",
        "domain": "shell",
        "features": ["shell", "shell.exec", "logging", "platform.log"],
        "source": """\
import logging
import subprocess


def run(test_path):
    p1 = subprocess.run(["pytest", "-q", test_path], capture_output=True, text=True)
    if p1.returncode == 0:
        return {"passed": True, "retried": False, "summary": p1.stdout.strip().splitlines()[-1]}
    logging.warning("first pytest failed rc=%d retrying --lf", p1.returncode)
    p2 = subprocess.run(["pytest", "-q", "--lf", test_path], capture_output=True, text=True)
    if p2.returncode == 0:
        return {"passed": True, "retried": True, "summary": p2.stdout.strip().splitlines()[-1]}
    logging.error("retry failed rc=%d", p2.returncode)
    return {"passed": False, "retried": True, "stderr": p2.stderr.strip(), "rc": p2.returncode}
""",
        "args": ["tests/test_billing.py"],
        "branches": [
            ("first-pass", {"shell.exec": [sh("18 passed in 0.42s\n")]}),
            ("flaky-recovered", {"shell.exec": [sh("1 failed, 17 passed\n", "", 1), sh("1 passed in 0.11s\n")]}),
            ("persistent-failure", {"shell.exec": [sh("2 failed\n", "", 1), sh("2 failed\n", "AssertionError", 1)]}),
        ],
    })

    # 3. pip-audit-vuln-gate
    specs.append({
        "slug": "pip-audit-vuln-gate",
        "domain": "shell",
        "features": ["shell", "shell.exec", "json", "logging", "platform.log"],
        "source": """\
import json
import logging
import subprocess


def run(req_file, max_allowed):
    proc = subprocess.run(["pip-audit", "-r", req_file, "-f", "json"], capture_output=True, text=True)
    data = json.loads(proc.stdout or "{}")
    vulns = []
    for dep in data.get("dependencies", []):
        for v in dep.get("vulns", []):
            vulns.append({"pkg": dep["name"], "id": v["id"]})
    if len(vulns) > max_allowed:
        logging.error("audit blocked count=%d max=%d", len(vulns), max_allowed)
        return {"allowed": False, "count": len(vulns), "vulns": vulns}
    return {"allowed": True, "count": len(vulns), "vulns": vulns}
""",
        "args": ["requirements.txt", 0],
        "branches": [
            ("zero-vulns", {"shell.exec": [sh(json.dumps({"dependencies": [{"name": "httpx", "vulns": []}]}))]}),
            ("vulns-blocked", {"shell.exec": [sh(json.dumps({"dependencies": [{"name": "urllib3", "vulns": [{"id": "CVE-2026-1111"}]}]}), "", 1)]}),
        ],
    })

    # 4. ruff-check-and-autofix
    specs.append({
        "slug": "ruff-check-and-autofix",
        "domain": "shell",
        "features": ["shell", "shell.exec", "logging", "platform.log"],
        "source": """\
import logging
import subprocess


def run(src_dir):
    chk = subprocess.run(["ruff", "check", src_dir], capture_output=True, text=True)
    if chk.returncode == 0:
        return {"clean": True, "fixed": False, "issues": 0}
    logging.info("running ruff --fix on %s", src_dir)
    fix = subprocess.run(["ruff", "check", "--fix", src_dir], capture_output=True, text=True)
    if fix.returncode == 0:
        return {"clean": True, "fixed": True, "issues": 0}
    rem = [ln for ln in fix.stdout.splitlines() if ln.strip() and not ln.startswith("Found")]
    return {"clean": False, "fixed": True, "issues": len(rem)}
""",
        "args": ["src/service"],
        "branches": [
            ("already-clean", {"shell.exec": [sh("All checks passed!\n")]}),
            ("autofix-resolved", {"shell.exec": [sh("src/service/a.py:1:1 F401\n", "", 1), sh("Fixed 1 error.\n")]}),
            ("unfixable-remain", {"shell.exec": [sh("src/service/a.py:5:1 E722\n", "", 1), sh("src/service/a.py:5:1 E722\nFound 1 error.\n", "", 1)]}),
        ],
    })

    # 5. tar-gzip-and-checksum-manifest
    specs.append({
        "slug": "tar-gzip-and-checksum-manifest",
        "domain": "shell",
        "features": ["shell", "shell.exec", "fs", "fs.writeText"],
        "source": """\
import subprocess


def run(source_dir, out_tgz):
    pack = subprocess.run(["tar", "-czf", out_tgz, source_dir], capture_output=True, text=True)
    if pack.returncode != 0:
        return {"ok": False, "stage": "tar", "stderr": pack.stderr.strip()}
    sha_out = subprocess.check_output(["sha256sum", out_tgz], text=True).strip()
    digest = sha_out.split()[0]
    with open(out_tgz + ".sha256", "w") as fh:
        fh.write(f"{digest}  {out_tgz}\\n")
    return {"ok": True, "archive": out_tgz, "sha256": digest[:16]}
""",
        "args": ["/srv/release", "/srv/release.tar.gz"],
        "branches": [
            ("archive-verified", {"shell.exec": [sh(""), sh("0123456789abcdef9988776655443322  /srv/release.tar.gz\n")], "fs.writeText": [ok(None)]}),
            ("tar-disk-full", {"shell.exec": [sh("", "tar: write error: No space left", 2)]}),
        ],
    })

    # 6. alembic-migrate-or-rollback
    specs.append({
        "slug": "alembic-migrate-or-rollback",
        "domain": "shell",
        "features": ["shell", "shell.exec", "logging", "platform.log"],
        "source": """\
import logging
import subprocess


def run(target_rev):
    cur = subprocess.check_output(["alembic", "current"], text=True).strip().split()[0]
    if cur == target_rev:
        return {"migrated": False, "rev": cur, "rolled_back": False}
    up = subprocess.run(["alembic", "upgrade", target_rev], capture_output=True, text=True)
    if up.returncode == 0:
        return {"migrated": True, "rev": target_rev, "rolled_back": False}
    logging.error("upgrade failed from %s to %s; rolling back", cur, target_rev)
    down = subprocess.run(["alembic", "downgrade", cur], capture_output=True, text=True)
    return {"migrated": False, "rev": cur, "rolled_back": down.returncode == 0, "err": up.stderr.strip()}
""",
        "args": ["rev_0042"],
        "branches": [
            ("already-at-target", {"shell.exec": [sh("rev_0042 (head)\n")]}),
            ("upgrade-ok", {"shell.exec": [sh("rev_0041\n"), sh("Running upgrade rev_0041 -> rev_0042\n")]}),
            ("upgrade-fail-rollback", {"shell.exec": [sh("rev_0041\n"), sh("", "DuplicateColumn", 1), sh("Downgraded to rev_0041\n")]}),
        ],
    })

    # 7. systemd-service-watchdog
    specs.append({
        "slug": "systemd-service-watchdog",
        "domain": "shell",
        "features": ["shell", "shell.exec", "logging", "platform.log"],
        "source": """\
import logging
import subprocess


def run(unit_name, heal):
    st = subprocess.run(["systemctl", "is-active", unit_name], capture_output=True, text=True)
    state = st.stdout.strip() or "unknown"
    if st.returncode == 0 and state == "active":
        return {"unit": unit_name, "state": "active", "healed": False}
    if not heal:
        logging.warning("unit %s is %s", unit_name, state)
        return {"unit": unit_name, "state": state, "healed": False}
    subprocess.run(["systemctl", "restart", unit_name], capture_output=True, text=True, check=True)
    recheck = subprocess.run(["systemctl", "is-active", unit_name], capture_output=True, text=True)
    return {"unit": unit_name, "state": recheck.stdout.strip(), "healed": True, "prev": state}
""",
        "args": ["redis-worker.service", True],
        "branches": [
            ("active-ok", {"shell.exec": [sh("active\n")]}),
            ("restarted-active", {"shell.exec": [sh("failed\n", "", 3), sh(""), sh("active\n")]}),
        ],
    })

    # 8. docker-compose-health-wait
    specs.append({
        "slug": "docker-compose-health-wait",
        "domain": "shell",
        "features": ["shell", "shell.exec", "json", "loop"],
        "source": """\
import json
import subprocess


def run(service, max_checks):
    for attempt in range(1, max_checks + 1):
        out = subprocess.check_output(
            ["docker", "inspect", "--format", "{{json .State.Health}}", service],
            text=True,
        )
        health = json.loads(out)
        status = health.get("Status")
        if status == "healthy":
            return {"healthy": True, "attempts": attempt, "failing_streak": health.get("FailingStreak", 0)}
        if status == "unhealthy":
            return {"healthy": False, "attempts": attempt, "failing_streak": health.get("FailingStreak", 0)}
    return {"healthy": False, "attempts": max_checks, "reason": "timeout"}
""",
        "args": ["api-gateway", 3],
        "branches": [
            ("healthy-second-check", {"shell.exec": [sh('{"Status":"starting","FailingStreak":0}'), sh('{"Status":"healthy","FailingStreak":0}')]}),
            ("unhealthy-abort", {"shell.exec": [sh('{"Status":"unhealthy","FailingStreak":3}')]}),
        ],
    })

    # 9. subprocess-timeout-fallback
    specs.append({
        "slug": "subprocess-timeout-fallback",
        "domain": "shell",
        "features": ["shell", "shell.exec", "exception", "logging", "platform.log"],
        "source": """\
import logging
import subprocess


def run(host_name):
    try:
        out = subprocess.check_output(["dig", "+short", host_name], text=True, timeout=2)
        ips = [ln.strip() for ln in out.splitlines() if ln.strip()]
        return {"ok": bool(ips), "source": "dig", "ips": ips}
    except subprocess.TimeoutExpired:
        logging.warning("dig timed out for %s; falling back to getent", host_name)
        fb = subprocess.run(["getent", "hosts", host_name], capture_output=True, text=True)
        if fb.returncode != 0:
            return {"ok": False, "source": "getent", "ips": []}
        ips = [ln.split()[0] for ln in fb.stdout.splitlines() if ln.strip()]
        return {"ok": bool(ips), "source": "getent", "ips": ips}
""",
        "args": ["db.internal.wave2"],
        "branches": [
            ("dig-fast-ok", {"shell.exec": [sh("10.0.1.5\n10.0.1.6\n")]}),
            ("dig-timeout-getent-ok", {"shell.exec": [fail("TimeoutExpired", "Command timed out after 2.0 seconds"), sh("10.0.1.5 db.internal.wave2\n")]}),
        ],
    })

    # 10. git-rev-list-ahead-behind
    specs.append({
        "slug": "git-rev-list-ahead-behind",
        "domain": "shell",
        "features": ["shell", "shell.exec", "branch"],
        "source": """\
import subprocess


def run(repo_dir, base_ref):
    subprocess.run(["git", "-C", repo_dir, "fetch", "origin"], capture_output=True, text=True, check=True)
    out = subprocess.check_output(
        ["git", "-C", repo_dir, "rev-list", "--left-right", "--count", f"{base_ref}...HEAD"],
        text=True,
    ).strip()
    behind_s, ahead_s = out.split()
    behind, ahead = int(behind_s), int(ahead_s)
    if behind > 0:
        return {"can_ff": False, "needs_rebase": True, "ahead": ahead, "behind": behind}
    return {"can_ff": ahead > 0, "needs_rebase": False, "ahead": ahead, "behind": 0}
""",
        "args": ["/srv/core", "origin/main"],
        "branches": [
            ("clean-ahead", {"shell.exec": [sh(""), sh("0\t3\n")]}),
            ("diverged-needs-rebase", {"shell.exec": [sh(""), sh("4\t2\n")]}),
        ],
    })

    # 11. shell-pipeline-log-error-counter
    specs.append({
        "slug": "shell-pipeline-log-error-counter",
        "domain": "shell",
        "features": ["shell", "shell.exec", "logging", "platform.log"],
        "source": """\
import logging
import subprocess


def run(log_file, threshold):
    cmd = f"grep -c ERROR {log_file}"
    res = subprocess.run(cmd, shell=True, capture_output=True, text=True)
    if res.returncode == 1:
        return {"errors": 0, "alert": False}
    if res.returncode != 0:
        logging.error("grep failed rc=%d err=%s", res.returncode, res.stderr.strip())
        return {"errors": -1, "alert": True, "error": res.stderr.strip()}
    count = int(res.stdout.strip())
    alert = count >= threshold
    if alert:
        logging.warning("error spike count=%d", count)
    return {"errors": count, "alert": alert}
""",
        "args": ["/var/log/api.log", 10],
        "branches": [
            ("zero-matches-rc1", {"shell.exec": [sh("0\n", "", 1)]}),
            ("spike-over-threshold", {"shell.exec": [sh("27\n", "", 0)]}),
            ("missing-log-rc2", {"shell.exec": [sh("", "No such file", 2)]}),
        ],
    })

    # 12. pg-backup-and-gzip-check
    specs.append({
        "slug": "pg-backup-and-gzip-check",
        "domain": "shell",
        "features": ["shell", "shell.exec", "fs", "fs.exists"],
        "source": """\
import os
import subprocess


def run(db_url, out_file):
    if os.path.exists(out_file):
        return {"ok": False, "reason": "already-exists"}
    dump = subprocess.run(["pg_dump", db_url, "-f", out_file], capture_output=True, text=True)
    if dump.returncode != 0:
        return {"ok": False, "reason": "dump-failed", "stderr": dump.stderr.strip()}
    gz = subprocess.run(["gzip", "-f", out_file], capture_output=True, text=True)
    return {"ok": gz.returncode == 0, "file": out_file + ".gz"}
""",
        "args": ["postgres://db/prod", "/backups/prod.sql"],
        "branches": [
            ("already-exists-skip", {"fs.exists": [ok(True)]}),
            ("dump-and-gzip-ok", {"fs.exists": [ok(False)], "shell.exec": [sh(""), sh("")]}),
        ],
    })

    # 13. wheel-build-and-twine-check
    specs.append({
        "slug": "wheel-build-and-twine-check",
        "domain": "shell",
        "features": ["shell", "shell.exec", "fs", "fs.listdir"],
        "source": """\
import os
import subprocess


def run(project_dir):
    b = subprocess.run(["python", "-m", "build", "--wheel", project_dir], capture_output=True, text=True)
    if b.returncode != 0:
        return {"ok": False, "stage": "build", "stderr": b.stderr.strip()}
    dist_dir = project_dir + "/dist"
    wheels = sorted(f for f in os.listdir(dist_dir) if f.endswith(".whl"))
    if not wheels:
        return {"ok": False, "stage": "no-wheel"}
    chk = subprocess.run(["twine", "check", dist_dir + "/" + wheels[-1]], capture_output=True, text=True)
    return {"ok": chk.returncode == 0, "stage": "check", "wheel": wheels[-1], "passed": "PASSED" in chk.stdout}
""",
        "args": ["/workspace/mylib"],
        "branches": [
            ("build-and-check-pass", {"shell.exec": [sh("Built mylib-1.2.0.whl\n"), sh("Checking mylib-1.2.0.whl: PASSED\n")], "fs.listdir": [ok(["mylib-1.2.0-py3-none-any.whl"])]}),
            ("twine-check-fail", {"shell.exec": [sh("Built mylib-1.2.0.whl\n"), sh("Checking mylib-1.2.0.whl: FAILED\n", "Bad RST", 1)], "fs.listdir": [ok(["mylib-1.2.0-py3-none-any.whl"])]}),
        ],
    })

    # 14. k8s-rollout-status-rollback
    specs.append({
        "slug": "k8s-rollout-status-rollback",
        "domain": "shell",
        "features": ["shell", "shell.exec", "logging", "platform.log"],
        "source": """\
import logging
import subprocess


def run(namespace, deployment):
    st = subprocess.run(
        ["kubectl", "-n", namespace, "rollout", "status", "deployment/" + deployment, "--timeout=60s"],
        capture_output=True,
        text=True,
    )
    if st.returncode == 0:
        return {"healthy": True, "rolled_back": False, "msg": st.stdout.strip()}
    logging.error("rollout stalled for %s/%s", namespace, deployment)
    undo = subprocess.run(
        ["kubectl", "-n", namespace, "rollout", "undo", "deployment/" + deployment],
        capture_output=True,
        text=True,
    )
    return {"healthy": False, "rolled_back": undo.returncode == 0, "err": st.stderr.strip()}
""",
        "args": ["prod", "checkout-api"],
        "branches": [
            ("rollout-healthy", {"shell.exec": [sh('deployment "checkout-api" successfully rolled out\n')]}),
            ("rollout-undo", {"shell.exec": [sh("", "exceeded progress deadline", 1), sh('deployment.apps/checkout-api rolled back\n')]}),
        ],
    })

    # =========================================================================
    # GROUP 2: HTTP.REQUEST (urllib & requests) (20 families, 48 tasks)
    # =========================================================================

    # 15. requests-retry-after-429-vs-400
    specs.append({
        "slug": "requests-retry-after-429-vs-400",
        "domain": "http",
        "features": ["http", "http.request", "logging", "platform.log", "loop"],
        "source": """\
import logging
import requests


def run(url, max_attempts):
    waits = []
    for attempt in range(1, max_attempts + 1):
        resp = requests.get(url, headers={"Accept": "application/json", "X-Attempt": str(attempt)})
        if resp.status_code == 200:
            return {"ok": True, "attempts": attempt, "waits": waits, "data": resp.json()}
        if resp.status_code in (429, 503):
            delay = int(resp.headers.get("Retry-After", str(attempt * 2)))
            waits.append(delay)
            logging.warning("retry status=%d wait=%d", resp.status_code, delay)
            continue
        logging.error("abort non-retryable status=%d", resp.status_code)
        return {"ok": False, "attempts": attempt, "status": resp.status_code, "waits": waits}
    return {"ok": False, "attempts": max_attempts, "status": 503, "waits": waits}
""",
        "args": ["https://api.pywave2.test/v1/ledger", 3],
        "branches": [
            ("retry-429-ok", {"http.request": [
                hresp(429, {"err": "slow"}, {"Retry-After": "3", "Content-Type": "application/json"}),
                hresp(200, {"rows": 19}),
            ]}),
            ("abort-400", {"http.request": [hresp(400, {"err": "bad_query"})]}),
            ("exhaust-503", {"http.request": [
                hresp(503, "down", {"Retry-After": "1"}),
                hresp(503, "down", {}),
                hresp(503, "down", {"Retry-After": "5"}),
            ]}),
        ],
    })

    # 16. oauth2-token-refresh-on-401
    specs.append({
        "slug": "oauth2-token-refresh-on-401",
        "domain": "http",
        "features": ["http", "http.request", "kv_get", "kv_set", "logging", "platform.log"],
        "source": """\
import logging
import requests


def run(api_url, token_url, svc_id):
    tok = host.kv_get("tok:" + svc_id)
    r = requests.get(api_url, headers={"Authorization": "Bearer " + tok})
    if r.status_code == 401:
        logging.info("refreshing oauth token for %s", svc_id)
        tr = requests.post(token_url, json={"grant_type": "client_credentials", "client_id": svc_id})
        if tr.status_code != 200:
            return {"ok": False, "refreshed": False, "status": tr.status_code}
        tok = tr.json()["access_token"]
        host.kv_set("tok:" + svc_id, tok)
        r = requests.get(api_url, headers={"Authorization": "Bearer " + tok})
        return {"ok": r.ok, "refreshed": True, "status": r.status_code, "body": r.json() if r.ok else None}
    return {"ok": r.ok, "refreshed": False, "status": r.status_code, "body": r.json() if r.ok else None}
""",
        "args": ["https://api.pywave2.test/profile", "https://auth.pywave2.test/oauth/token", "svc-9"],
        "branches": [
            ("token-valid", {"kv_get": [ok("live_t1")], "http.request": [hresp(200, {"org": "acme"})]}),
            ("refresh-and-retry-ok", {
                "kv_get": [ok("old_t0")],
                "http.request": [
                    hresp(401, {"error": "expired"}),
                    hresp(200, {"access_token": "fresh_t2"}),
                    hresp(200, {"org": "acme"}),
                ],
                "kv_set": [ok(True)],
            }),
            ("refresh-rejected-403", {
                "kv_get": [ok("old_t0")],
                "http.request": [
                    hresp(401, {"error": "expired"}),
                    hresp(403, {"error": "revoked"}),
                ],
            }),
        ],
    })

    # 17. urllib-etag-304-cache
    specs.append({
        "slug": "urllib-etag-304-cache",
        "domain": "http",
        "features": ["http", "http.request", "kv_get", "kv_set", "json"],
        "source": """\
import json
import urllib.error
import urllib.request


def run(url, cache_key):
    cached = host.kv_get(cache_key)
    headers = {"Accept": "application/json"}
    if cached and cached.get("etag"):
        headers["If-None-Match"] = cached["etag"]
    req = urllib.request.Request(url, headers=headers, method="GET")
    try:
        with urllib.request.urlopen(req) as resp:
            body = json.loads(resp.read().decode("utf-8"))
            etag = resp.getheader("ETag") or ""
            if resp.status == 304 and cached:
                return {"hit": True, "etag": cached["etag"], "data": cached["data"]}
            host.kv_set(cache_key, {"etag": etag, "data": body})
            return {"hit": False, "etag": etag, "data": body}
    except urllib.error.HTTPError as exc:
        if exc.code == 304 and cached:
            return {"hit": True, "etag": cached["etag"], "data": cached["data"]}
        return {"hit": False, "error_status": exc.code}
""",
        "args": ["https://cdn.pywave2.test/rules.json", "rules:v1"],
        "branches": [
            ("not-modified-304", {"kv_get": [ok({"etag": '"v5"', "data": {"active": 3}})], "http.request": [hresp(304, "{}", {"ETag": '"v5"'})]}),
            ("stale-updated-200", {"kv_get": [ok({"etag": '"v5"', "data": {"active": 3}})], "http.request": [hresp(200, {"active": 4}, {"ETag": '"v6"'})], "kv_set": [ok(True)]}),
            ("cold-miss-200", {"kv_get": [ok(None)], "http.request": [hresp(200, {"active": 4}, {"ETag": '"v6"'})], "kv_set": [ok(True)]}),
        ],
    })

    # 18. requests-cursor-pagination
    specs.append({
        "slug": "requests-cursor-pagination",
        "domain": "http",
        "features": ["http", "http.request", "loop", "json"],
        "source": """\
import requests


def run(endpoint, max_pages):
    cursor = None
    collected = []
    pages = 0
    with requests.Session() as sess:
        sess.headers["Accept"] = "application/json"
        while pages < max_pages:
            params = {"cursor": cursor} if cursor else None
            r = sess.get(endpoint, params=params)
            if r.status_code != 200:
                return {"ok": False, "pages": pages, "items": collected, "status": r.status_code}
            payload = r.json()
            pages += 1
            for item in payload["items"]:
                collected.append(item["id"])
            cursor = payload.get("next_cursor")
            if not cursor:
                return {"ok": True, "complete": True, "pages": pages, "items": collected}
    return {"ok": True, "complete": False, "pages": pages, "items": collected}
""",
        "args": ["https://api.pywave2.test/audit-logs", 3],
        "branches": [
            ("complete-two-pages", {"http.request": [
                hresp(200, {"items": [{"id": "a1"}, {"id": "a2"}], "next_cursor": "p2"}),
                hresp(200, {"items": [{"id": "a3"}], "next_cursor": None}),
            ]}),
            ("mid-page-500", {"http.request": [
                hresp(200, {"items": [{"id": "a1"}], "next_cursor": "p2"}),
                hresp(500, "internal"),
            ]}),
        ],
    })

    # 19. webhook-hmac-signature-post
    specs.append({
        "slug": "webhook-hmac-signature-post",
        "domain": "http",
        "features": ["http", "http.request", "json", "logging", "platform.log"],
        "source": """\
import hashlib
import hmac
import json
import logging
import requests


def run(hook_url, secret, event):
    raw = json.dumps(event, sort_keys=True)
    sig = hmac.new(secret.encode("utf-8"), raw.encode("utf-8"), hashlib.sha256).hexdigest()
    headers = {
        "Content-Type": "application/json",
        "Idempotency-Key": "evt-" + str(event["id"]),
        "X-Signature-256": "sha256=" + sig,
    }
    resp = requests.post(hook_url, data=raw, headers=headers)
    if resp.status_code == 409:
        logging.info("duplicate webhook %s", event["id"])
        return {"delivered": True, "duplicate": True, "status": 409}
    return {"delivered": resp.ok, "duplicate": False, "status": resp.status_code, "sig_prefix": sig[:10]}
""",
        "args": ["https://hooks.pywave2.test/billing", "sec_key_1", {"id": 88, "type": "paid"}],
        "branches": [
            ("delivered-201", {"http.request": [hresp(201, {"accepted": True})]}),
            ("duplicate-409", {"http.request": [hresp(409, {"reason": "already_seen"})]}),
        ],
    })

    # 20. http-circuit-breaker-state
    specs.append({
        "slug": "http-circuit-breaker-state",
        "domain": "http",
        "features": ["http", "http.request", "kv_get", "kv_set", "platform.time", "logging", "platform.log"],
        "source": """\
import logging
import time
import requests


def run(svc, url, max_fails, cooldown_s):
    now = time.time()
    st = host.kv_get("cb:" + svc) or {"fails": 0, "open_until": 0.0}
    if st["open_until"] > now:
        logging.warning("circuit open for %s", svc)
        return {"ok": False, "short_circuited": True, "wait": round(st["open_until"] - now, 1)}
    try:
        r = requests.get(url)
        if r.status_code >= 500:
            raise requests.HTTPError(f"HTTP {r.status_code}")
        host.kv_set("cb:" + svc, {"fails": 0, "open_until": 0.0})
        return {"ok": True, "short_circuited": False, "status": r.status_code}
    except requests.RequestException as exc:
        fails = st["fails"] + 1
        open_until = now + cooldown_s if fails >= max_fails else 0.0
        host.kv_set("cb:" + svc, {"fails": fails, "open_until": open_until})
        logging.error("cb failure svc=%s fails=%d", svc, fails)
        return {"ok": False, "short_circuited": False, "tripped": open_until > 0.0, "err": str(exc)}
""",
        "args": ["search", "https://search.pywave2.test/q", 2, 30.0],
        "branches": [
            ("open-short-circuit", {"platform.time": [ok(1000.0)], "kv_get": [ok({"fails": 2, "open_until": 1020.0})]}),
            ("half-open-success", {"platform.time": [ok(1050.0)], "kv_get": [ok({"fails": 2, "open_until": 1020.0})], "http.request": [hresp(200, {"hits": 3})], "kv_set": [ok(True)]}),
            ("trips-on-conn-error", {"platform.time": [ok(1000.0)], "kv_get": [ok({"fails": 1, "open_until": 0.0})], "http.request": [fail("ConnectionError", "refused")], "kv_set": [ok(True)]}),
        ],
    })

    # 21. batch-delete-fanout-partial
    specs.append({
        "slug": "batch-delete-fanout-partial",
        "domain": "http",
        "features": ["http", "http.request", "loop", "exception"],
        "source": """\
import requests


def run(base_url, item_ids):
    ok_ids = []
    failed = []
    for iid in item_ids:
        try:
            r = requests.delete(f"{base_url}/{iid}")
            if r.status_code in (200, 204, 404):
                ok_ids.append(iid)
            else:
                failed.append({"id": iid, "status": r.status_code})
        except requests.RequestException as exc:
            failed.append({"id": iid, "error": type(exc).__name__})
    return {"all_ok": not failed, "ok_ids": ok_ids, "failed": failed}
""",
        "args": ["https://store.pywave2.test/tokens", ["t1", "t2", "t3"]],
        "branches": [
            ("all-ok", {"http.request": [hresp(204, ""), hresp(404, ""), hresp(200, "ok")]}),
            ("partial-timeout-and-500", {"http.request": [hresp(204, ""), fail("TimeoutError", "read timed out"), hresp(500, "err")]}),
        ],
    })

    # 22. urllib-basic-auth-or-anon
    specs.append({
        "slug": "urllib-basic-auth-or-anon",
        "domain": "http",
        "features": ["http", "http.request", "env", "env.get", "json"],
        "source": """\
import base64
import json
import os
import urllib.request


def run(url):
    user = os.getenv("API_USER")
    pw = os.getenv("API_PASS")
    headers = {"Accept": "application/json"}
    authed = False
    if user and pw:
        tok = base64.b64encode(f"{user}:{pw}".encode("utf-8")).decode("ascii")
        headers["Authorization"] = "Basic " + tok
        authed = True
    req = urllib.request.Request(url, headers=headers, method="GET")
    with urllib.request.urlopen(req) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    return {"authed": authed, "data": data}
""",
        "args": ["https://registry.pywave2.test/pkg"],
        "branches": [
            ("with-basic-auth", {"env.get": [ok("ci"), ok("s3cr3t")], "http.request": [hresp(200, {"private": True})]}),
            ("anonymous-access", {"env.get": [ok(None), ok(None)], "http.request": [hresp(200, {"private": False})]}),
        ],
    })

    # 23. graphql-query-envelope
    specs.append({
        "slug": "graphql-query-envelope",
        "domain": "http",
        "features": ["http", "http.request", "json", "branch"],
        "source": """\
import requests


def run(endpoint, query, variables):
    r = requests.post(endpoint, json={"query": query, "variables": variables})
    if r.status_code != 200:
        return {"ok": False, "kind": "http", "status": r.status_code}
    body = r.json()
    errs = body.get("errors") or []
    if errs:
        return {"ok": False, "kind": "graphql", "messages": [e.get("message") for e in errs]}
    return {"ok": True, "kind": "data", "data": body.get("data")}
""",
        "args": ["https://gql.pywave2.test/v1", "query($k:ID!){item(id:$k){sku}}", {"k": "9"}],
        "branches": [
            ("data-ok", {"http.request": [hresp(200, {"data": {"item": {"sku": "X-9"}}})]}),
            ("graphql-err", {"http.request": [hresp(200, {"data": None, "errors": [{"message": "not found"}]})]}),
            ("http-502", {"http.request": [hresp(502, "bad gateway")]}),
        ],
    })

    # 24. presigned-s3-upload-flow
    specs.append({
        "slug": "presigned-s3-upload-flow",
        "domain": "http",
        "features": ["http", "http.request", "json"],
        "source": """\
import requests


def run(api_base, name, payload):
    r1 = requests.post(api_base + "/presign", json={"name": name, "size": len(payload)})
    if r1.status_code != 200:
        return {"ok": False, "stage": "presign", "status": r1.status_code}
    meta = r1.json()
    r2 = requests.put(meta["upload_url"], data=payload, headers={"Content-Type": "text/plain"})
    if r2.status_code not in (200, 201):
        return {"ok": False, "stage": "upload", "status": r2.status_code}
    etag = r2.headers.get("ETag", "")
    r3 = requests.post(api_base + "/commit", json={"key": meta["key"], "etag": etag})
    return {"ok": r3.ok, "stage": "commit", "key": meta["key"], "etag": etag}
""",
        "args": ["https://blobs.pywave2.test", "report.csv", "a,b\n1,2\n"],
        "branches": [
            ("upload-commit-ok", {"http.request": [
                hresp(200, {"upload_url": "https://s3.pywave2.test/u/1", "key": "k/1"}),
                hresp(200, "", {"ETag": '"e123"'}),
                hresp(200, {"committed": True}),
            ]}),
            ("upload-403-stop", {"http.request": [
                hresp(200, {"upload_url": "https://s3.pywave2.test/u/1", "key": "k/1"}),
                hresp(403, "AccessDenied"),
            ]}),
        ],
    })

    # 25. multi-region-failover-client
    specs.append({
        "slug": "multi-region-failover-client",
        "domain": "http",
        "features": ["http", "http.request", "loop", "exception", "logging", "platform.log"],
        "source": """\
import logging
import requests


def run(regions, path):
    tried = []
    for reg in regions:
        tried.append(reg)
        url = f"https://{reg}.pywave2.test{path}"
        try:
            r = requests.get(url, headers={"X-Region": reg})
            if r.status_code == 200:
                return {"ok": True, "region": reg, "tried": tried, "data": r.json()}
            logging.warning("region %s status=%d", reg, r.status_code)
        except requests.RequestException as exc:
            logging.warning("region %s error=%s", reg, type(exc).__name__)
    return {"ok": False, "region": None, "tried": tried, "data": None}
""",
        "args": [["us-east", "eu-central", "ap-east"], "/health"],
        "branches": [
            ("primary-ok", {"http.request": [hresp(200, {"ok": True})]}),
            ("failover-second", {"http.request": [fail("TimeoutError", "timed out"), hresp(200, {"ok": True})]}),
            ("all-failed", {"http.request": [hresp(503, "busy"), fail("ConnectionError", "reset"), hresp(500, "err")]}),
        ],
    })

    # 26. async-job-submit-and-poll
    specs.append({
        "slug": "async-job-submit-and-poll",
        "domain": "http",
        "features": ["http", "http.request", "loop", "logging", "platform.log"],
        "source": """\
import logging
import requests


def run(submit_url, spec, max_polls):
    sub = requests.post(submit_url, json=spec)
    if sub.status_code != 202:
        return {"ok": False, "stage": "submit", "status": sub.status_code}
    info = sub.json()
    for i in range(1, max_polls + 1):
        st = requests.get(info["poll_url"]).json()
        if st["state"] == "succeeded":
            return {"ok": True, "job_id": info["id"], "polls": i, "artifact": st["artifact"]}
        if st["state"] == "failed":
            return {"ok": False, "job_id": info["id"], "polls": i, "reason": st["reason"]}
        logging.info("job %s still %s poll=%d", info["id"], st["state"], i)
    return {"ok": False, "job_id": info["id"], "polls": max_polls, "reason": "timeout"}
""",
        "args": ["https://jobs.pywave2.test/run", {"kind": "train"}, 3],
        "branches": [
            ("done-second-poll", {"http.request": [
                hresp(202, {"id": "j-5", "poll_url": "https://jobs.pywave2.test/jobs/j-5"}),
                hresp(200, {"state": "running"}),
                hresp(200, {"state": "succeeded", "artifact": "s3://out/j-5.bin"}),
            ]}),
            ("job-failed", {"http.request": [
                hresp(202, {"id": "j-5", "poll_url": "https://jobs.pywave2.test/jobs/j-5"}),
                hresp(200, {"state": "failed", "reason": "oom"}),
            ]}),
        ],
    })

    # 27. optimistic-etag-put-retry
    specs.append({
        "slug": "optimistic-etag-put-retry",
        "domain": "http",
        "features": ["http", "http.request", "loop", "logging", "platform.log"],
        "source": """\
import logging
import requests


def run(doc_url, inc):
    for attempt in range(1, 3):
        g = requests.get(doc_url)
        etag = g.headers.get("ETag", "")
        doc = g.json()
        new_doc = {"val": doc["val"] + inc}
        p = requests.put(doc_url, json=new_doc, headers={"If-Match": etag})
        if p.status_code in (200, 204):
            return {"ok": True, "attempts": attempt, "val": new_doc["val"]}
        if p.status_code != 412:
            return {"ok": False, "attempts": attempt, "status": p.status_code}
        logging.warning("cas conflict attempt=%d", attempt)
    return {"ok": False, "attempts": 2, "status": 412}
""",
        "args": ["https://kv.pywave2.test/doc/7", 10],
        "branches": [
            ("clean-first-put", {"http.request": [
                hresp(200, {"val": 5}, {"ETag": '"1"'}),
                hresp(200, {"val": 15}, {"ETag": '"2"'}),
            ]}),
            ("conflict-412-then-ok", {"http.request": [
                hresp(200, {"val": 5}, {"ETag": '"1"'}),
                hresp(412, "conflict"),
                hresp(200, {"val": 8}, {"ETag": '"2"'}),
                hresp(200, {"val": 18}, {"ETag": '"3"'}),
            ]}),
        ],
    })

    # 28. redirect-chain-validator
    specs.append({
        "slug": "redirect-chain-validator",
        "domain": "http",
        "features": ["http", "http.request", "loop"],
        "source": """\
import requests


def run(start_url, max_hops):
    cur = start_url
    seen = [cur]
    for _ in range(max_hops):
        r = requests.head(cur)
        if r.status_code in (301, 302, 307, 308):
            nxt = r.headers.get("Location")
            if not nxt:
                return {"ok": False, "reason": "no-location", "chain": seen}
            if nxt in seen:
                return {"ok": False, "reason": "loop", "chain": seen}
            seen.append(nxt)
            cur = nxt
            continue
        return {"ok": r.status_code == 200, "final_url": cur, "status": r.status_code, "hops": len(seen) - 1}
    return {"ok": False, "reason": "too-many-hops", "chain": seen}
""",
        "args": ["https://go.pywave2.test/a", 3],
        "branches": [
            ("resolved-cleanly", {"http.request": [
                hresp(301, "", {"Location": "https://go.pywave2.test/b"}),
                hresp(200, "", {}),
            ]}),
            ("cycle-detected", {"http.request": [
                hresp(302, "", {"Location": "https://go.pywave2.test/b"}),
                hresp(302, "", {"Location": "https://go.pywave2.test/a"}),
            ]}),
        ],
    })

    # 29. ratelimit-header-throttled-crawler
    specs.append({
        "slug": "ratelimit-header-throttled-crawler",
        "domain": "http",
        "features": ["http", "http.request", "loop", "json"],
        "source": """\
import requests


def run(base_url, slugs, min_reserve):
    results = {}
    deferred = []
    remaining = 999
    for slug in slugs:
        if remaining <= min_reserve:
            deferred.append(slug)
            continue
        r = requests.get(f"{base_url}/{slug}")
        hdr = r.headers.get("X-RateLimit-Remaining")
        if hdr is not None:
            remaining = int(hdr)
        if r.status_code == 200:
            results[slug] = r.json()["score"]
        else:
            deferred.append(slug)
    return {"results": results, "deferred": deferred, "remaining": remaining}
""",
        "args": ["https://api.pywave2.test/repos", ["r1", "r2", "r3"], 2],
        "branches": [
            ("all-fetched", {"http.request": [
                hresp(200, {"score": 9}, {"X-RateLimit-Remaining": "50"}),
                hresp(200, {"score": 7}, {"X-RateLimit-Remaining": "49"}),
                hresp(200, {"score": 8}, {"X-RateLimit-Remaining": "48"}),
            ]}),
            ("stopped-at-reserve", {"http.request": [
                hresp(200, {"score": 9}, {"X-RateLimit-Remaining": "3"}),
                hresp(200, {"score": 7}, {"X-RateLimit-Remaining": "2"}),
            ]}),
        ],
    })

    # 30. urllib-json-download-sha-check
    specs.append({
        "slug": "urllib-json-download-sha-check",
        "domain": "http",
        "features": ["http", "http.request", "json", "logging", "platform.log"],
        "source": """\
import hashlib
import json
import logging
import urllib.request


def run(url, expected_sha):
    with urllib.request.urlopen(url) as resp:
        raw = resp.read()
    actual = hashlib.sha256(raw).hexdigest()
    if actual != expected_sha:
        logging.error("digest mismatch got=%s", actual[:12])
        return {"verified": False, "actual": actual[:12]}
    return {"verified": True, "payload": json.loads(raw.decode("utf-8"))}
""",
        "args": ["https://cdn.pywave2.test/index.json", _sha256('{"ver":4}')],
        "branches": [
            ("digest-match", {"http.request": [hresp(200, '{"ver":4}')]}),
            ("digest-mismatch", {"http.request": [hresp(200, '{"ver":9}')]}),
        ],
    })

    # 31. service-registry-dispatch
    specs.append({
        "slug": "service-registry-dispatch",
        "domain": "http",
        "features": ["http", "http.request", "json", "branch"],
        "source": """\
import requests


def run(registry_url, svc_name, msg):
    r = requests.get(f"{registry_url}/nodes/{svc_name}")
    if r.status_code != 200:
        return {"ok": False, "stage": "registry", "status": r.status_code}
    nodes = [n for n in r.json()["nodes"] if n["ready"]]
    if not nodes:
        return {"ok": False, "stage": "no-ready-nodes"}
    target = nodes[0]["endpoint"]
    p = requests.post(target + "/tasks", json=msg)
    return {"ok": p.ok, "stage": "dispatch", "target": target, "status": p.status_code}
""",
        "args": ["https://disc.pywave2.test", "mailer", {"to": "a@b.test"}],
        "branches": [
            ("dispatched-ready", {"http.request": [
                hresp(200, {"nodes": [{"endpoint": "https://m1.test", "ready": False}, {"endpoint": "https://m2.test", "ready": True}]}),
                hresp(202, {"queued": True}),
            ]}),
            ("no-ready-nodes", {"http.request": [hresp(200, {"nodes": [{"endpoint": "https://m1.test", "ready": False}]})]}),
        ],
    })

    # 32. webhook-dlq-kv-fallback
    specs.append({
        "slug": "webhook-dlq-kv-fallback",
        "domain": "http",
        "features": ["http", "http.request", "kv_set", "logging", "platform.log"],
        "source": """\
import logging
import requests


def run(url, event_id, body):
    try:
        r = requests.post(url, json=body, headers={"X-Event-Id": event_id})
        if r.ok:
            return {"status": "sent", "code": r.status_code}
        reason = f"http-{r.status_code}"
    except requests.RequestException as exc:
        reason = type(exc).__name__
    host.kv_set("dlq:" + event_id, {"url": url, "reason": reason, "body": body})
    logging.error("moved %s to dlq reason=%s", event_id, reason)
    return {"status": "dlq", "reason": reason}
""",
        "args": ["https://partner.pywave2.test/cb", "ev-71", {"amt": 50}],
        "branches": [
            ("sent-200", {"http.request": [hresp(200, {"ok": True})]}),
            ("timeout-to-dlq", {"http.request": [fail("TimeoutError", "timed out")], "kv_set": [ok(True)]}),
        ],
    })

    # 33. api-v2-v1-fallback-client
    specs.append({
        "slug": "api-v2-v1-fallback-client",
        "domain": "http",
        "features": ["http", "http.request", "json"],
        "source": """\
import requests


def run(base_url, account_id):
    r2 = requests.get(f"{base_url}/v2/accounts/{account_id}")
    if r2.status_code == 200:
        d = r2.json()
        return {"api": "v2", "name": d["fullName"], "active": d["status"] == "active"}
    if r2.status_code in (404, 501):
        r1 = requests.get(f"{base_url}/v1/accounts/{account_id}")
        if r1.status_code == 200:
            d = r1.json()
            return {"api": "v1", "name": d["name"], "active": bool(d["enabled"])}
        return {"api": "none", "status": r1.status_code}
    return {"api": "error", "status": r2.status_code}
""",
        "args": ["https://crm.pywave2.test", "acc-9"],
        "branches": [
            ("v2-ok", {"http.request": [hresp(200, {"fullName": "Ada Lovelace", "status": "active"})]}),
            ("v1-fallback", {"http.request": [hresp(404, "not found"), hresp(200, {"name": "Ada L.", "enabled": 1})]}),
        ],
    })

    # 34. host-http-get-role-enricher
    specs.append({
        "slug": "host-http-get-role-enricher",
        "domain": "http",
        "features": ["http", "http.get", "json", "exception", "logging", "platform.log"],
        "source": """\
import json
import logging


def run(api_base, uid):
    user = json.loads(host.http_get(f"{api_base}/users/{uid}"))
    try:
        role_data = json.loads(host.http_get(f"{api_base}/roles/{user['role']}"))
        scopes = role_data["scopes"]
    except Exception as exc:
        logging.warning("role fetch failed for %s: %s", user["role"], exc)
        scopes = ["basic"]
    return {"uid": uid, "role": user["role"], "scopes": scopes}
""",
        "args": ["https://auth.pywave2.test", "u-15"],
        "branches": [
            ("scopes-loaded", {"http.get": [ok('{"role":"editor"}'), ok('{"scopes":["read","write"]}')]}),
            ("role-service-down", {"http.get": [ok('{"role":"editor"}'), fail("RuntimeError", "503")]}),
        ],
    })

    # =========================================================================
    # GROUP 3: FS.* (16 families, 38 tasks)
    # =========================================================================

    # 35. pathlib-config-cascade-merge
    specs.append({
        "slug": "pathlib-config-cascade-merge",
        "domain": "fs",
        "features": ["fs", "fs.exists", "fs.readText", "fs.writeText", "json", "loop"],
        "source": """\
import json
from pathlib import Path


def run(cfg_paths, out_path):
    merged = {"workers": 2, "timeout": 30}
    applied = []
    for raw in cfg_paths:
        p = Path(raw)
        if p.exists():
            merged.update(json.loads(p.read_text()))
            applied.append(raw)
    if applied:
        Path(out_path).write_text(json.dumps(merged, sort_keys=True))
    return {"applied": applied, "merged": merged, "wrote": bool(applied)}
""",
        "args": [["/etc/svc/base.json", "/etc/svc/env.json", "/etc/svc/local.json"], "/var/run/effective.json"],
        "branches": [
            ("base-and-env", {"fs.exists": [ok(True), ok(True), ok(False)], "fs.readText": [ok('{"workers":4}'), ok('{"timeout":60,"region":"eu"}')], "fs.writeText": [ok(None)]}),
            ("none-exist", {"fs.exists": [ok(False), ok(False), ok(False)]}),
            ("local-only", {"fs.exists": [ok(False), ok(False), ok(True)], "fs.readText": [ok('{"workers":1,"debug":true}')], "fs.writeText": [ok(None)]}),
        ],
    })

    # 36. atomic-temp-verify-commit
    specs.append({
        "slug": "atomic-temp-verify-commit",
        "domain": "fs",
        "features": ["fs", "fs.exists", "fs.readText", "fs.writeText", "json"],
        "source": """\
import json
import os


def run(target_path, updates):
    base = {}
    if os.path.exists(target_path):
        with open(target_path, "r") as fh:
            base = json.loads(fh.read())
    merged = {**base, **updates}
    encoded = json.dumps(merged, sort_keys=True)
    tmp_path = target_path + ".tmp"
    with open(tmp_path, "w") as fh:
        fh.write(encoded)
    with open(tmp_path, "r") as fh:
        readback = fh.read()
    if readback != encoded:
        return {"ok": False, "reason": "readback-mismatch"}
    with open(target_path, "w") as fh:
        fh.write(encoded)
    return {"ok": True, "existed": bool(base), "keys": sorted(merged.keys())}
""",
        "args": ["/etc/app/state.json", {"mode": "strict", "limit": 50}],
        "branches": [
            ("merge-existing", {
                "fs.exists": [ok(True)],
                "fs.readText": [ok('{"limit":10,"host":"a"}'), ok('{"host": "a", "limit": 50, "mode": "strict"}')],
                "fs.writeText": [ok(None), ok(None)],
            }),
            ("seed-new", {
                "fs.exists": [ok(False)],
                "fs.writeText": [ok(None), ok(None)],
                "fs.readText": [ok('{"limit": 50, "mode": "strict"}')],
            }),
        ],
    })

    # 37. dir-scan-filter-isfile-sum
    specs.append({
        "slug": "dir-scan-filter-isfile-sum",
        "domain": "fs",
        "features": ["fs", "fs.listdir", "fs.isFile", "fs.readText", "json", "loop"],
        "source": """\
import json
import os


def run(data_dir):
    names = sorted(os.listdir(data_dir))
    total = 0
    files = []
    skipped = []
    for name in names:
        if not name.endswith(".json"):
            continue
        full = data_dir + "/" + name
        if not os.path.isfile(full):
            skipped.append(name)
            continue
        with open(full, "r") as fh:
            obj = json.loads(fh.read())
        total += obj.get("qty", 0)
        files.append(name)
    return {"files": files, "skipped": skipped, "total": total}
""",
        "args": ["/srv/orders"],
        "branches": [
            ("two-json-files", {
                "fs.listdir": [ok(["notes.txt", "b.json", "a.json"])],
                "fs.isFile": [ok(True), ok(True)],
                "fs.readText": [ok('{"qty":12}'), ok('{"qty":8}')],
            }),
            ("subdir-skipped", {
                "fs.listdir": [ok(["archive.json", "ok.json"])],
                "fs.isFile": [ok(False), ok(True)],
                "fs.readText": [ok('{"qty":5}')],
            }),
        ],
    })

    # 38. lockfile-stale-lease-takeover
    specs.append({
        "slug": "lockfile-stale-lease-takeover",
        "domain": "fs",
        "features": ["fs", "fs.exists", "fs.readText", "fs.writeText", "platform.time", "logging", "platform.log"],
        "source": """\
import json
import logging
import time
from pathlib import Path


def run(lock_path, owner, ttl_s):
    now = time.time()
    p = Path(lock_path)
    if p.exists():
        cur = json.loads(p.read_text())
        if cur["owner"] != owner and now < cur["exp"]:
            logging.warning("lock held by %s", cur["owner"])
            return {"acquired": False, "holder": cur["owner"], "takeover": False}
        p.write_text(json.dumps({"owner": owner, "exp": now + ttl_s}, sort_keys=True))
        return {"acquired": True, "holder": owner, "takeover": cur["owner"] != owner}
    p.write_text(json.dumps({"owner": owner, "exp": now + ttl_s}, sort_keys=True))
    return {"acquired": True, "holder": owner, "takeover": False}
""",
        "args": ["/var/lock/sync.lock", "w2", 60.0],
        "branches": [
            ("fresh-lock", {"platform.time": [ok(1000.0)], "fs.exists": [ok(False)], "fs.writeText": [ok(None)]}),
            ("held-busy", {"platform.time": [ok(1000.0)], "fs.exists": [ok(True)], "fs.readText": [ok('{"owner":"w1","exp":1040.0}')]}),
            ("stale-takeover", {"platform.time": [ok(1100.0)], "fs.exists": [ok(True)], "fs.readText": [ok('{"owner":"w1","exp":1040.0}')], "fs.writeText": [ok(None)]}),
        ],
    })

    # 39. log-rotate-archive-truncate
    specs.append({
        "slug": "log-rotate-archive-truncate",
        "domain": "fs",
        "features": ["fs", "fs.readText", "fs.writeText", "platform.time", "logging", "platform.log"],
        "source": """\
import logging
import time
from pathlib import Path


def run(log_path, max_lines):
    p = Path(log_path)
    text = p.read_text()
    lines = text.splitlines()
    if len(lines) < max_lines:
        return {"rotated": False, "lines": len(lines)}
    ts = int(time.time())
    arch = f"{log_path}.{ts}"
    Path(arch).write_text(text)
    p.write_text("")
    logging.info("rotated %s -> %s", log_path, arch)
    return {"rotated": True, "lines": len(lines), "archive": arch}
""",
        "args": ["/var/log/worker.log", 3],
        "branches": [
            ("below-max-lines", {"fs.readText": [ok("l1\nl2\n")]}),
            ("rotate-and-clear", {"fs.readText": [ok("l1\nl2\nl3\nl4\n")], "platform.time": [ok(1700001234.0)], "fs.writeText": [ok(None), ok(None)]}),
        ],
    })

    # 40. migration-file-rollback-on-error
    specs.append({
        "slug": "migration-file-rollback-on-error",
        "domain": "fs",
        "features": ["fs", "fs.readText", "fs.writeText", "json", "exception", "logging", "platform.log"],
        "source": """\
import json
import logging
from pathlib import Path


def run(db_path, patch_path):
    db_p = Path(db_path)
    backup = db_p.read_text()
    data = json.loads(backup)
    try:
        patch = json.loads(Path(patch_path).read_text())
        for op in patch["ops"]:
            if op["op"] == "set":
                data[op["k"]] = op["v"]
            elif op["op"] == "del":
                data.pop(op["k"], None)
            else:
                raise ValueError("bad op " + str(op["op"]))
        db_p.write_text(json.dumps(data, sort_keys=True))
        return {"committed": True, "rolled_back": False, "keys": sorted(data.keys())}
    except Exception as exc:
        logging.error("migration rollback: %s", exc)
        db_p.write_text(backup)
        return {"committed": False, "rolled_back": True, "error": str(exc)}
""",
        "args": ["/data/kv.json", "/data/mig.json"],
        "branches": [
            ("commit-ok", {"fs.readText": [ok('{"a":1,"b":2}'), ok('{"ops":[{"op":"set","k":"c","v":3},{"op":"del","k":"b"}]}')], "fs.writeText": [ok(None)]}),
            ("bad-op-rollback", {"fs.readText": [ok('{"a":1,"b":2}'), ok('{"ops":[{"op":"wipe","k":"a"}]}')], "fs.writeText": [ok(None)]}),
        ],
    })

    # 41. binary-magic-bytes-classifier
    specs.append({
        "slug": "binary-magic-bytes-classifier",
        "domain": "fs",
        "features": ["fs", "fs.readBytes", "bytes", "branch"],
        "source": """\
from pathlib import Path


def run(file_path):
    raw = Path(file_path).read_bytes()
    if raw.startswith(b"\\x89PNG\\r\\n\\x1a\\n"):
        return {"kind": "png", "size": len(raw), "valid": True}
    if raw.startswith(b"PK\\x03\\x04"):
        return {"kind": "zip", "size": len(raw), "valid": True}
    if raw.startswith(b"\\x1f\\x8b"):
        return {"kind": "gzip", "size": len(raw), "valid": True}
    return {"kind": "unknown", "size": len(raw), "valid": False}
""",
        "args": ["/uploads/sample.bin"],
        "branches": [
            ("png-magic", {"fs.readBytes": [ok(b"\x89PNG\r\n\x1a\n\x00\x00")]}),
            ("zip-magic", {"fs.readBytes": [ok(b"PK\x03\x04\x14\x00")]}),
            ("unknown-magic", {"fs.readBytes": [ok(b"PLAIN_TEXT")]}),
        ],
    })

    # 42. binary-header-patch-writebytes
    specs.append({
        "slug": "binary-header-patch-writebytes",
        "domain": "fs",
        "features": ["fs", "fs.readBytes", "fs.writeBytes", "bytes"],
        "source": """\
from pathlib import Path


def run(bin_path, magic):
    p = Path(bin_path)
    data = p.read_bytes()
    if data.startswith(magic):
        return {"patched": False, "size": len(data)}
    patched = magic + data
    p.write_bytes(patched)
    return {"patched": True, "size": len(patched)}
""",
        "args": ["/data/frame.bin", b"HDR1"],
        "branches": [
            ("already-tagged", {"fs.readBytes": [ok(b"HDR1payload")]}),
            ("prepended-header", {"fs.readBytes": [ok(b"payload")], "fs.writeBytes": [ok(None)]}),
        ],
    })

    # 43. dotenv-parser-with-defaults
    specs.append({
        "slug": "dotenv-parser-with-defaults",
        "domain": "fs",
        "features": ["fs", "fs.exists", "fs.readText", "loop"],
        "source": """\
import os


def run(env_file, defaults):
    cfg = dict(defaults)
    if not os.path.exists(env_file):
        return {"loaded": False, "count": 0, "cfg": cfg}
    count = 0
    with open(env_file, "r") as fh:
        for raw in fh.read().splitlines():
            ln = raw.strip()
            if not ln or ln.startswith("#") or "=" not in ln:
                continue
            k, v = ln.split("=", 1)
            cfg[k.strip()] = v.strip()
            count += 1
    return {"loaded": True, "count": count, "cfg": cfg}
""",
        "args": ["/srv/.env", {"PORT": "8000", "DEBUG": "0"}],
        "branches": [
            ("file-loaded", {"fs.exists": [ok(True)], "fs.readText": [ok("# prod\nPORT=9000\nWORKERS=8\n")]}),
            ("file-missing", {"fs.exists": [ok(False)]}),
        ],
    })

    # 44. filenotfound-seed-checkpoint
    specs.append({
        "slug": "filenotfound-seed-checkpoint",
        "domain": "fs",
        "features": ["fs", "fs.readText", "fs.writeText", "exception", "json"],
        "source": """\
import json


def run(cp_path, initial):
    try:
        with open(cp_path, "r") as fh:
            data = json.loads(fh.read())
        return {"seeded": False, "state": data}
    except FileNotFoundError:
        with open(cp_path, "w") as fh:
            fh.write(json.dumps(initial, sort_keys=True))
        return {"seeded": True, "state": dict(initial)}
""",
        "args": ["/var/lib/ingest/cursor.json", {"seq": 0, "gen": 1}],
        "branches": [
            ("existing-cursor", {"fs.readText": [ok('{"seq": 105, "gen": 2}')]}),
            ("missing-seeded", {"fs.readText": [fail("FileNotFoundError", "No such file")], "fs.writeText": [ok(None)]}),
        ],
    })

    # 45. pathlib-iterdir-manifest-hash
    specs.append({
        "slug": "pathlib-iterdir-manifest-hash",
        "domain": "fs",
        "features": ["fs", "fs.listdir", "fs.isFile", "fs.readText", "fs.writeText", "json"],
        "source": """\
import hashlib
import json
from pathlib import Path


def run(root_dir, manifest_path):
    entries = sorted(Path(root_dir).iterdir(), key=lambda p: p.name)
    index = {}
    for entry in entries:
        if entry.name.endswith(".cfg") and entry.is_file():
            body = entry.read_text()
            index[entry.name] = hashlib.sha256(body.encode("utf-8")).hexdigest()[:12]
    if not index:
        return {"count": 0, "wrote": False, "index": {}}
    Path(manifest_path).write_text(json.dumps(index, sort_keys=True))
    return {"count": len(index), "wrote": True, "index": index}
""",
        "args": ["/etc/plugins", "/etc/plugins/manifest.json"],
        "branches": [
            ("two-cfg-files", {"fs.listdir": [ok(["b.cfg", "a.cfg", "sub"])], "fs.isFile": [ok(True), ok(True)], "fs.readText": [ok("x=1"), ok("y=2")], "fs.writeText": [ok(None)]}),
            ("no-cfg-files", {"fs.listdir": [ok(["README.md", "sub"])]}),
        ],
    })

    # 46. csv-reconciler-strict-gate
    specs.append({
        "slug": "csv-reconciler-strict-gate",
        "domain": "fs",
        "features": ["fs", "fs.readText", "fs.writeText", "json", "loop"],
        "source": """\
import json
from pathlib import Path


def run(csv_path, out_json):
    lines = Path(csv_path).read_text().strip().splitlines()
    cr = 0
    dr = 0
    bad = 0
    for ln in lines[1:]:
        parts = ln.split(",")
        if len(parts) != 3 or parts[1] not in ("CR", "DR"):
            bad += 1
            continue
        amt = int(parts[2])
        if parts[1] == "CR":
            cr += amt
        else:
            dr += amt
    summary = {"cr": cr, "dr": dr, "net": cr - dr, "bad": bad}
    if bad == 0:
        Path(out_json).write_text(json.dumps(summary, sort_keys=True))
    return {"summary": summary, "saved": bad == 0}
""",
        "args": ["/data/tx.csv", "/data/tx_summary.json"],
        "branches": [
            ("clean-saved", {"fs.readText": [ok("id,kind,amt\n1,CR,300\n2,DR,120\n")], "fs.writeText": [ok(None)]}),
            ("bad-row-skips-save", {"fs.readText": [ok("id,kind,amt\n1,CR,300\n2,ERR,50\n")]}),
        ],
    })

    # 47. template-file-render-strict
    specs.append({
        "slug": "template-file-render-strict",
        "domain": "fs",
        "features": ["fs", "fs.readText", "fs.writeText", "regex"],
        "source": """\
import re
from pathlib import Path


def run(tpl_path, values, out_path):
    tpl = Path(tpl_path).read_text()
    missing = []

    def sub(m):
        key = m.group(1)
        if key in values:
            return str(values[key])
        missing.append(key)
        return m.group(0)

    rendered = re.sub(r"\\{\\{([A-Z0-9_]+)\\}\\}", sub, tpl)
    if missing:
        return {"ok": False, "missing": missing, "wrote": False}
    Path(out_path).write_text(rendered)
    return {"ok": True, "missing": [], "wrote": True, "rendered": rendered}
""",
        "args": ["/tpl/service.ini", {"HOST": "10.0.0.2", "PORT": 5000}, "/etc/service.ini"],
        "branches": [
            ("all-resolved", {"fs.readText": [ok("bind={{HOST}}:{{PORT}}")], "fs.writeText": [ok(None)]}),
            ("missing-placeholder", {"fs.readText": [ok("bind={{HOST}}:{{PORT}} key={{SECRET}}")]}),
        ],
    })

    # 48. directory-tree-type-audit
    specs.append({
        "slug": "directory-tree-type-audit",
        "domain": "fs",
        "features": ["fs", "fs.isDir", "fs.listdir", "fs.isFile", "loop"],
        "source": """\
import os


def run(target_dir):
    if not os.path.isdir(target_dir):
        return {"ok": False, "reason": "not-a-dir", "files": [], "dirs": []}
    files = []
    dirs = []
    for name in sorted(os.listdir(target_dir)):
        full = target_dir + "/" + name
        if os.path.isfile(full):
            files.append(name)
        elif os.path.isdir(full):
            dirs.append(name)
    return {"ok": True, "files": files, "dirs": dirs}
""",
        "args": ["/srv/workspace"],
        "branches": [
            ("valid-dir-mixed", {
                "fs.isDir": [ok(True), ok(True)],
                "fs.listdir": [ok(["a.py", "pkg"])],
                "fs.isFile": [ok(True), ok(False)],
            }),
            ("not-a-directory", {"fs.isDir": [ok(False)]}),
        ],
    })

    # 49. ndjson-tail-cursor-advance
    specs.append({
        "slug": "ndjson-tail-cursor-advance",
        "domain": "fs",
        "features": ["fs", "fs.exists", "fs.readText", "fs.writeText", "json", "loop"],
        "source": """\
import json
from pathlib import Path


def run(log_file, cursor_file):
    cp = Path(cursor_file)
    offset = int(cp.read_text().strip()) if cp.exists() else 0
    lines = [ln for ln in Path(log_file).read_text().splitlines() if ln.strip()]
    new_events = [json.loads(ln)["id"] for ln in lines[offset:]]
    if new_events:
        cp.write_text(str(len(lines)))
    return {"offset": offset, "new_offset": len(lines), "events": new_events}
""",
        "args": ["/var/log/stream.ndjson", "/var/log/stream.pos"],
        "branches": [
            ("new-events-advance", {"fs.exists": [ok(True)], "fs.readText": [ok("1"), ok('{"id":"x1"}\n{"id":"x2"}\n{"id":"x3"}\n')], "fs.writeText": [ok(None)]}),
            ("caught-up-noop", {"fs.exists": [ok(True)], "fs.readText": [ok("2"), ok('{"id":"x1"}\n{"id":"x2"}\n')]}),
            ("no-cursor-starts-zero", {"fs.exists": [ok(False)], "fs.readText": [ok('{"id":"x1"}\n')], "fs.writeText": [ok(None)]}),
        ],
    })

    # 50. json-schema-config-validator
    specs.append({
        "slug": "json-schema-config-validator",
        "domain": "fs",
        "features": ["fs", "fs.exists", "fs.readText", "json", "logging", "platform.log"],
        "source": """\
import json
import logging
import os


def run(cfg_path, required_keys):
    if not os.path.exists(cfg_path):
        logging.error("missing config %s", cfg_path)
        return {"valid": False, "reason": "missing", "missing": list(required_keys)}
    with open(cfg_path, "r") as fh:
        data = json.loads(fh.read())
    missing = [k for k in required_keys if k not in data]
    if missing:
        logging.warning("incomplete config missing=%s", ",".join(missing))
        return {"valid": False, "reason": "missing-keys", "missing": missing}
    return {"valid": True, "reason": "ok", "key_count": len(data)}
""",
        "args": ["/etc/svc/app.json", ["db_url", "secret_key"]],
        "branches": [
            ("valid-cfg", {"fs.exists": [ok(True)], "fs.readText": [ok('{"db_url":"pg://a","secret_key":"k1","debug":false}')]}),
            ("missing-key", {"fs.exists": [ok(True)], "fs.readText": [ok('{"db_url":"pg://a"}')]}),
            ("missing-file", {"fs.exists": [ok(False)]}),
        ],
    })

    # =========================================================================
    # GROUP 4: KV + ENV + PLATFORM + RANDOM + UUID + SECRETS + MULTI-SERVICE (16 families, 38 tasks)
    # =========================================================================

    # 51. ttl-cache-fresh-stale-cold
    specs.append({
        "slug": "ttl-cache-fresh-stale-cold",
        "domain": "kv-platform",
        "features": ["kv_get", "kv_set", "http", "http.request", "platform.time", "logging", "platform.log"],
        "source": """\
import logging
import time
import requests


def run(cache_key, origin_url, ttl_s):
    now = time.time()
    entry = host.kv_get(cache_key)
    if entry and now < entry["exp"]:
        return {"state": "fresh-hit", "val": entry["val"]}
    r = requests.get(origin_url)
    if r.status_code == 200:
        val = r.json()
        host.kv_set(cache_key, {"val": val, "exp": now + ttl_s})
        return {"state": "stale-refreshed" if entry else "cold-filled", "val": val}
    if entry:
        logging.warning("serving stale for %s status=%d", cache_key, r.status_code)
        return {"state": "stale-fallback", "val": entry["val"]}
    return {"state": "miss-error", "status": r.status_code}
""",
        "args": ["user:7", "https://origin.pywave2.test/user/7", 120.0],
        "branches": [
            ("fresh-hit", {"platform.time": [ok(1000.0)], "kv_get": [ok({"val": {"plan": "pro"}, "exp": 1100.0})]}),
            ("stale-refresh", {"platform.time": [ok(1200.0)], "kv_get": [ok({"val": {"plan": "free"}, "exp": 1100.0})], "http.request": [hresp(200, {"plan": "enterprise"})], "kv_set": [ok(True)]}),
            ("stale-fallback-503", {"platform.time": [ok(1200.0)], "kv_get": [ok({"val": {"plan": "free"}, "exp": 1100.0})], "http.request": [hresp(503, "down")]}),
        ],
    })

    # 52. sliding-window-rate-limiter
    specs.append({
        "slug": "sliding-window-rate-limiter",
        "domain": "kv-platform",
        "features": ["kv_get", "kv_set", "platform.time", "logging", "platform.log"],
        "source": """\
import logging
import time


def run(tenant, window_s, limit):
    now = time.time()
    key = "rl:" + tenant
    hits = host.kv_get(key) or []
    active = [t for t in hits if now - t < window_s]
    if len(active) >= limit:
        logging.warning("rate limit hit tenant=%s count=%d", tenant, len(active))
        return {"allowed": False, "count": len(active), "remaining": 0}
    active.append(now)
    host.kv_set(key, active)
    return {"allowed": True, "count": len(active), "remaining": limit - len(active)}
""",
        "args": ["tenant-alpha", 60.0, 3],
        "branches": [
            ("allowed-fresh", {"platform.time": [ok(500.0)], "kv_get": [ok([480.0])], "kv_set": [ok(True)]}),
            ("expired-pruned-allowed", {"platform.time": [ok(600.0)], "kv_get": [ok([400.0, 410.0, 420.0, 590.0])], "kv_set": [ok(True)]}),
            ("denied-at-cap", {"platform.time": [ok(500.0)], "kv_get": [ok([470.0, 480.0, 495.0])]}),
        ],
    })

    # 53. feature-flag-rollout-env-random
    specs.append({
        "slug": "feature-flag-rollout-env-random",
        "domain": "kv-platform",
        "features": ["env", "env.get", "kv_get", "random", "platform.random"],
        "randomMode": "tool",
        "source": """\
import os
import random


def run(flag_key, user_id):
    if os.getenv("DISABLE_FLAGS") == "1":
        return {"enabled": False, "reason": "global-off"}
    cfg = host.kv_get("flag:" + flag_key)
    if not cfg or not cfg.get("enabled"):
        return {"enabled": False, "reason": "disabled"}
    if user_id in cfg.get("allow", []):
        return {"enabled": True, "reason": "allowlist"}
    roll = random.random()
    hit = roll < cfg["ratio"]
    return {"enabled": hit, "reason": "rollout-hit" if hit else "rollout-miss", "roll": roll}
""",
        "args": ["smart-search", "u-55"],
        "branches": [
            ("global-killswitch", {"env.get": [ok("1")]}),
            ("allowlist-hit", {"env.get": [ok(None)], "kv_get": [ok({"enabled": True, "ratio": 0.1, "allow": ["u-55"]})]}),
            ("random-rollout-hit", {"env.get": [ok("0")], "kv_get": [ok({"enabled": True, "ratio": 0.3, "allow": []})], "platform.random": [ok(0.14)]}),
        ],
    })

    # 54. idempotent-charge-uuid-kv
    specs.append({
        "slug": "idempotent-charge-uuid-kv",
        "domain": "kv-platform",
        "features": ["kv_get", "kv_set", "uuid", "platform.uuid", "http", "http.request"],
        "source": """\
import uuid
import requests


def run(idem_key, cents):
    prev = host.kv_get("charge:" + idem_key)
    if prev:
        return {"replayed": True, "tx_id": prev["tx_id"], "status": prev["status"]}
    tx_id = str(uuid.uuid4())
    r = requests.post("https://pay.pywave2.test/v1/charges", json={"tx_id": tx_id, "cents": cents})
    status = "paid" if r.ok else "declined"
    host.kv_set("charge:" + idem_key, {"tx_id": tx_id, "status": status})
    return {"replayed": False, "tx_id": tx_id, "status": status}
""",
        "args": ["ord-332", 1999],
        "branches": [
            ("idempotent-replay", {"kv_get": [ok({"tx_id": "11111111-1111-4111-8111-111111111111", "status": "paid"})]}),
            ("new-charge-paid", {"kv_get": [ok(None)], "platform.uuid": [ok("22222222-2222-4222-8222-222222222222")], "http.request": [hresp(201, {"ok": True})], "kv_set": [ok(True)]}),
            ("new-charge-declined", {"kv_get": [ok(None)], "platform.uuid": [ok("33333333-3333-4333-8333-333333333333")], "http.request": [hresp(402, {"err": "card"})], "kv_set": [ok(True)]}),
        ],
    })

    # 55. saga-compensator-workflow
    specs.append({
        "slug": "saga-compensator-workflow",
        "domain": "kv-platform",
        "features": ["http", "http.request", "kv_set", "logging", "platform.log"],
        "source": """\
import logging
import requests


def run(order_id, sku, amount):
    r_inv = requests.post("https://inv.pywave2.test/hold", json={"order_id": order_id, "sku": sku})
    if not r_inv.ok:
        host.kv_set("saga:" + order_id, {"state": "inv-failed"})
        return {"ok": False, "state": "inv-failed", "compensated": False}
    r_pay = requests.post("https://pay.pywave2.test/charge", json={"order_id": order_id, "amount": amount})
    if not r_pay.ok:
        logging.warning("compensating inventory for %s", order_id)
        requests.post("https://inv.pywave2.test/release", json={"order_id": order_id, "sku": sku})
        host.kv_set("saga:" + order_id, {"state": "compensated"})
        return {"ok": False, "state": "compensated", "compensated": True}
    host.kv_set("saga:" + order_id, {"state": "done"})
    return {"ok": True, "state": "done", "compensated": False}
""",
        "args": ["ord-88", "ITEM-4", 7500],
        "branches": [
            ("saga-done", {"http.request": [hresp(200, {"ok": True}), hresp(200, {"ok": True})], "kv_set": [ok(True)]}),
            ("pay-fail-compensates", {"http.request": [hresp(200, {"ok": True}), hresp(402, "declined"), hresp(200, {"released": True})], "kv_set": [ok(True)]}),
            ("inv-fail-early", {"http.request": [hresp(409, "no-stock")], "kv_set": [ok(True)]}),
        ],
    })

    # 56. secrets-api-key-mint-and-store
    specs.append({
        "slug": "secrets-api-key-mint-and-store",
        "domain": "kv-platform",
        "features": ["secrets", "platform.secrets", "env", "env.get", "platform.time", "kv_set"],
        "source": """\
import os
import secrets
import time


def run(account_id):
    ttl = int(os.getenv("KEY_TTL_SEC") or "86400")
    now = int(time.time())
    tok = "sk_" + secrets.token_hex(8)
    exp = now + ttl
    host.kv_set("apikey:" + tok, {"account": account_id, "exp": exp})
    return {"key": tok, "account": account_id, "ttl": ttl, "exp": exp}
""",
        "args": ["acct-42"],
        "branches": [
            ("custom-ttl", {"env.get": [ok("3600")], "platform.time": [ok(1700000000.0)], "platform.secrets": [ok("a1b2c3d4e5f60708")], "kv_set": [ok(True)]}),
            ("default-ttl", {"env.get": [ok(None)], "platform.time": [ok(1700000000.0)], "platform.secrets": [ok("ffeeddccbbaa9988")], "kv_set": [ok(True)]}),
        ],
    })

    # 57. deploy-pipeline-env-fs-shell-http-kv
    specs.append({
        "slug": "deploy-pipeline-env-fs-shell-http-kv",
        "domain": "multi-service",
        "features": ["env", "env.get", "fs", "fs.readText", "kv_get", "kv_set", "shell", "shell.exec", "http", "http.request", "logging", "platform.log"],
        "source": """\
import json
import logging
import os
import subprocess
import requests


def run(manifest_path):
    stage = os.getenv("DEPLOY_STAGE") or "staging"
    with open(manifest_path, "r") as fh:
        manifest = json.loads(fh.read())
    ver = manifest["version"]
    live = host.kv_get("live:" + stage)
    if live and live.get("version") == ver:
        return {"deployed": False, "reason": "already-live", "stage": stage, "version": ver}
    smoke = subprocess.run(["pytest", "-q", "tests/smoke.py"], capture_output=True, text=True)
    if smoke.returncode != 0:
        logging.error("smoke failed stage=%s ver=%s", stage, ver)
        return {"deployed": False, "reason": "smoke-failed", "stage": stage, "rc": smoke.returncode}
    r = requests.post("https://deploy.pywave2.test/hook", json={"stage": stage, "version": ver})
    host.kv_set("live:" + stage, {"version": ver, "notified": r.ok})
    return {"deployed": True, "stage": stage, "version": ver, "notified": r.ok}
""",
        "args": ["/release/app.json"],
        "branches": [
            ("deploy-ok", {
                "env.get": [ok("prod")],
                "fs.readText": [ok('{"version":"2.5.0"}')],
                "kv_get": [ok({"version": "2.4.0"})],
                "shell.exec": [sh("4 passed\n")],
                "http.request": [hresp(200, {"ok": True})],
                "kv_set": [ok(True)],
            }),
            ("already-live-noop", {
                "env.get": [ok("prod")],
                "fs.readText": [ok('{"version":"2.5.0"}')],
                "kv_get": [ok({"version": "2.5.0"})],
            }),
            ("smoke-failed-abort", {
                "env.get": [ok(None)],
                "fs.readText": [ok('{"version":"2.5.1"}')],
                "kv_get": [ok(None)],
                "shell.exec": [sh("1 failed\n", "", 1)],
            }),
        ],
    })

    # 58. pager-alert-dedup-window
    specs.append({
        "slug": "pager-alert-dedup-window",
        "domain": "multi-service",
        "features": ["env", "env.get", "kv_get", "kv_set", "platform.time", "http", "http.request", "logging", "platform.log"],
        "source": """\
import logging
import os
import time
import requests


def run(alert_id, severity):
    now = time.time()
    silence = float(os.getenv("ALERT_SILENCE_S") or "300")
    prev = host.kv_get("alert:" + alert_id)
    if prev and (now - prev["ts"] < silence) and severity != "critical":
        logging.info("suppressed alert %s", alert_id)
        return {"paged": False, "reason": "silenced"}
    r = requests.post("https://pager.pywave2.test/incidents", json={"id": alert_id, "severity": severity})
    host.kv_set("alert:" + alert_id, {"ts": now, "severity": severity})
    return {"paged": r.ok, "reason": "paged", "status": r.status_code}
""",
        "args": ["redis-oom", "warning"],
        "branches": [
            ("silenced-dedup", {"platform.time": [ok(2000.0)], "env.get": [ok("600")], "kv_get": [ok({"ts": 1800.0, "severity": "warning"})]}),
            ("expired-triggers-page", {"platform.time": [ok(2500.0)], "env.get": [ok("300")], "kv_get": [ok({"ts": 1800.0, "severity": "warning"})], "http.request": [hresp(202, {"inc": "i1"})], "kv_set": [ok(True)]}),
        ],
    })

    # 59. ab-sticky-experiment-assigner
    specs.append({
        "slug": "ab-sticky-experiment-assigner",
        "domain": "kv-platform",
        "features": ["kv_get", "kv_set", "random", "platform.random", "http", "http.request"],
        "randomMode": "tool",
        "source": """\
import random
import requests


def run(exp_name, user_id, split):
    key = f"exp:{exp_name}:{user_id}"
    cur = host.kv_get(key)
    if cur is not None:
        return {"arm": cur, "sticky": True}
    r = random.random()
    arm = "B" if r < split else "A"
    host.kv_set(key, arm)
    requests.post("https://telemetry.pywave2.test/exp", json={"exp": exp_name, "user": user_id, "arm": arm})
    return {"arm": arm, "sticky": False, "roll": r}
""",
        "args": ["pricing-v3", "u-204", 0.4],
        "branches": [
            ("sticky-existing", {"kv_get": [ok("A")]}),
            ("new-arm-B", {"kv_get": [ok(None)], "platform.random": [ok(0.22)], "kv_set": [ok(True)], "http.request": [hresp(204, "")]}),
        ],
    })

    # 60. secret-rotation-vault-kv-fs
    specs.append({
        "slug": "secret-rotation-vault-kv-fs",
        "domain": "multi-service",
        "features": ["env", "env.get", "secrets", "platform.secrets", "http", "http.request", "kv_set", "fs", "fs.writeText"],
        "source": """\
import os
import secrets
from pathlib import Path
import requests


def run(svc, key_file):
    dry = os.getenv("DRY_RUN") == "1"
    new_tok = secrets.token_urlsafe(12)
    if dry:
        return {"rotated": False, "dry_run": True, "prefix": new_tok[:6]}
    r = requests.put(f"https://vault.pywave2.test/kv/{svc}", json={"token": new_tok})
    if not r.ok:
        return {"rotated": False, "dry_run": False, "status": r.status_code}
    host.kv_set("ver:" + svc, new_tok[:6])
    Path(key_file).write_text(new_tok)
    return {"rotated": True, "dry_run": False, "prefix": new_tok[:6]}
""",
        "args": ["payments", "/run/secrets/pay.tok"],
        "branches": [
            ("dry-run", {"env.get": [ok("1")], "platform.secrets": [ok("DryToken12345678")]}),
            ("live-rotated", {"env.get": [ok("0")], "platform.secrets": [ok("LiveToken9876543")], "http.request": [hresp(200, {"ok": True})], "kv_set": [ok(True)], "fs.writeText": [ok(None)]}),
        ],
    })

    # 61. cache-purge-kv-del-cdn
    specs.append({
        "slug": "cache-purge-kv-del-cdn",
        "domain": "kv-platform",
        "features": ["kv_get", "native-bindings", "http", "http.request", "loop"],
        "nativeBindings": KV_DEL_BINDINGS,
        "source": """\
import requests


def run(keys, purge_url):
    removed = []
    for k in keys:
        if host.kv_get(k) is not None:
            kv_del(k)
            removed.append(k)
    if not removed:
        return {"cdn_purged": False, "removed": []}
    r = requests.post(purge_url, json={"keys": removed})
    return {"cdn_purged": r.ok, "removed": removed, "status": r.status_code}
""",
        "args": [["doc:1", "doc:2"], "https://cdn.pywave2.test/purge"],
        "branches": [
            ("nothing-to-purge", {"kv_get": [ok(None), ok(None)]}),
            ("deleted-one-purges-cdn", {"kv_get": [ok({"v": 1}), ok(None)], "kv_del": [ok(True)], "http.request": [hresp(200, {"ok": True})]}),
        ],
    })

    # 62. leader-elected-cron-shell-fs
    specs.append({
        "slug": "leader-elected-cron-shell-fs",
        "domain": "multi-service",
        "features": ["kv_get", "kv_set", "platform.time", "shell", "shell.exec", "fs", "fs.writeText", "logging", "platform.log"],
        "source": """\
import logging
import subprocess
import time
from pathlib import Path


def run(node_id, cmd, out_file):
    now = time.time()
    lease = host.kv_get("cron:leader")
    if lease and lease["node"] != node_id and now < lease["exp"]:
        return {"ran": False, "leader": lease["node"]}
    host.kv_set("cron:leader", {"node": node_id, "exp": now + 120.0})
    res = subprocess.run(cmd, capture_output=True, text=True)
    if res.returncode != 0:
        logging.error("cron command failed rc=%d", res.returncode)
        return {"ran": True, "ok": False, "leader": node_id, "rc": res.returncode}
    Path(out_file).write_text(res.stdout.strip())
    return {"ran": True, "ok": True, "leader": node_id, "out": res.stdout.strip()}
""",
        "args": ["worker-b", ["cleanup-tmp", "--age=7d"], "/var/log/cleanup.txt"],
        "branches": [
            ("follower-skips", {"platform.time": [ok(500.0)], "kv_get": [ok({"node": "worker-a", "exp": 600.0})]}),
            ("leader-runs-ok", {"platform.time": [ok(700.0)], "kv_get": [ok({"node": "worker-a", "exp": 600.0})], "kv_set": [ok(True)], "shell.exec": [sh("removed 14 files\n")], "fs.writeText": [ok(None)]}),
            ("leader-cmd-fails", {"platform.time": [ok(700.0)], "kv_get": [ok(None)], "kv_set": [ok(True)], "shell.exec": [sh("", "permission denied", 1)]}),
        ],
    })

    # 63. datetime-sla-window-audit
    specs.append({
        "slug": "datetime-sla-window-audit",
        "domain": "kv-platform",
        "features": ["platform.time", "kv_get", "kv_set", "logging", "platform.log"],
        "source": """\
import datetime
import logging


def run(job_name, max_age_sec):
    now_dt = datetime.datetime.utcnow()
    now_ts = int(now_dt.timestamp())
    last = host.kv_get("heartbeat:" + job_name)
    if last is None:
        logging.error("no heartbeat recorded for %s", job_name)
        return {"healthy": False, "reason": "never-ran", "day": now_dt.strftime("%Y-%m-%d")}
    age = now_ts - int(last["ts"])
    if age > max_age_sec:
        logging.warning("heartbeat stale job=%s age=%d", job_name, age)
        host.kv_set("alerted:" + job_name, {"at": now_ts, "age": age})
        return {"healthy": False, "reason": "stale", "age": age}
    return {"healthy": True, "reason": "fresh", "age": age}
""",
        "args": ["etl-hourly", 3600],
        "branches": [
            ("fresh-heartbeat", {"platform.time": [ok(1700005000.0)], "kv_get": [ok({"ts": 1700004000})]}),
            ("stale-triggers-alert", {"platform.time": [ok(1700010000.0)], "kv_get": [ok({"ts": 1700004000})], "kv_set": [ok(True)]}),
        ],
    })

    # 64. log-spool-shipper-checkpoint
    specs.append({
        "slug": "log-spool-shipper-checkpoint",
        "domain": "multi-service",
        "features": ["fs", "fs.listdir", "fs.readText", "kv_get", "kv_set", "http", "http.request", "platform.time"],
        "source": """\
import os
import time
import requests


def run(spool_dir, ingest_url):
    files = sorted(f for f in os.listdir(spool_dir) if f.endswith(".log"))
    shipped = []
    for name in files:
        if host.kv_get("sent:" + name):
            continue
        with open(spool_dir + "/" + name, "r") as fh:
            body = fh.read()
        r = requests.post(ingest_url, data=body, headers={"X-Log-Name": name})
        if not r.ok:
            return {"ok": False, "shipped": shipped, "stopped_at": name, "status": r.status_code}
        host.kv_set("sent:" + name, int(time.time()))
        shipped.append(name)
    return {"ok": True, "shipped": shipped, "stopped_at": None}
""",
        "args": ["/var/spool/pylogs", "https://ingest.pywave2.test/logs"],
        "branches": [
            ("ships-new-skips-old", {
                "fs.listdir": [ok(["01.log", "02.log"])],
                "kv_get": [ok(1700000010), ok(None)],
                "fs.readText": [ok("WARN disk\n")],
                "http.request": [hresp(202, "ok")],
                "platform.time": [ok(1700000900.0)],
                "kv_set": [ok(True)],
            }),
            ("backpressure-503", {
                "fs.listdir": [ok(["01.log", "02.log"])],
                "kv_get": [ok(None)],
                "fs.readText": [ok("INFO start\n")],
                "http.request": [hresp(503, "busy")],
            }),
        ],
    })

    # 65. release-promote-env-fs-shell-http
    specs.append({
        "slug": "release-promote-env-fs-shell-http",
        "domain": "multi-service",
        "features": ["env", "env.get", "fs", "fs.exists", "shell", "shell.exec", "http", "http.request"],
        "source": """\
import os
import subprocess
import requests


def run(pkg_path, tag):
    token = os.getenv("RELEASE_API_TOKEN")
    if not token:
        return {"promoted": False, "reason": "no-token"}
    if not os.path.exists(pkg_path):
        return {"promoted": False, "reason": "no-package"}
    sha = subprocess.check_output(["sha256sum", pkg_path], text=True).strip().split()[0]
    r = requests.post(
        "https://rel.pywave2.test/promote",
        json={"tag": tag, "sha": sha},
        headers={"Authorization": "Bearer " + token},
    )
    return {"promoted": r.ok, "status": r.status_code, "sha": sha[:12]}
""",
        "args": ["/dist/app-2.0.whl", "v2.0.0"],
        "branches": [
            ("promoted-ok", {
                "env.get": [ok("tok_991")],
                "fs.exists": [ok(True)],
                "shell.exec": [sh("11223344556677889900aabb  /dist/app-2.0.whl\n")],
                "http.request": [hresp(200, {"live": True})],
            }),
            ("missing-pkg-blocks", {"env.get": [ok("tok_991")], "fs.exists": [ok(False)]}),
        ],
    })

    # 66. jittered-mutex-retry-secrets-kv
    specs.append({
        "slug": "jittered-mutex-retry-secrets-kv",
        "domain": "kv-platform",
        "features": ["kv_get", "kv_set", "platform.time", "secrets", "platform.secrets", "logging", "platform.log"],
        "source": """\
import logging
import secrets
import time


def run(lock_key, worker_id, max_tries):
    delays = []
    for i in range(max_tries):
        now = time.time()
        cur = host.kv_get(lock_key)
        if not cur or now >= cur["exp"]:
            host.kv_set(lock_key, {"owner": worker_id, "exp": now + 10.0})
            return {"acquired": True, "tries": i + 1, "delays": delays}
        delay = secrets.randbelow(50) + 10
        delays.append(delay)
        logging.info("mutex busy try=%d wait_ms=%d", i + 1, delay)
    return {"acquired": False, "tries": max_tries, "delays": delays}
""",
        "args": ["lock:compactor", "w-5", 3],
        "branches": [
            ("acquired-second-try", {
                "platform.time": [ok(100.0), ok(115.0)],
                "kv_get": [ok({"owner": "w-1", "exp": 110.0}), ok({"owner": "w-1", "exp": 110.0})],
                "platform.secrets": [ok(23)],
                "kv_set": [ok(True)],
            }),
            ("exhausted-busy", {
                "platform.time": [ok(100.0), ok(101.0), ok(102.0)],
                "kv_get": [ok({"owner": "w-1", "exp": 200.0}), ok({"owner": "w-1", "exp": 200.0}), ok({"owner": "w-1", "exp": 200.0})],
                "platform.secrets": [ok(12), ok(34), ok(7)],
            }),
        ],
    })

    return specs


# ---------------------------------------------------------------------------
# Independent 2nd verification via separate tools/tinker-execution-py.py worker
# ---------------------------------------------------------------------------
class PyWorkerClient:
    def __init__(self) -> None:
        self.proc = subprocess.Popen(
            [sys.executable, str(_REPO_ROOT / "tools" / "tinker-execution-py.py")],
            cwd=str(_REPO_ROOT),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=sys.stderr,
            text=True,
        )
        self._next_id = 1

    def request(self, payload: dict[str, Any]) -> Any:
        assert self.proc.stdin is not None and self.proc.stdout is not None
        rid = self._next_id
        self._next_id += 1
        self.proc.stdin.write(_json_compact({"id": rid, **payload}) + "\n")
        self.proc.stdin.flush()
        line = self.proc.stdout.readline()
        if not line:
            raise RuntimeError("Python worker exited unexpectedly")
        msg = json.loads(line)
        if not msg.get("ok"):
            err = msg.get("error") or {}
            raise RuntimeError(f"{err.get('name', 'Error')}: {err.get('message', 'worker failed')}")
        return msg["result"]

    def close(self) -> None:
        if self.proc.stdin:
            self.proc.stdin.close()
        self.proc.wait(timeout=10)


def _initial_prefix_len(messages: list[dict[str, Any]]) -> int:
    for idx, m in enumerate(messages):
        if m.get("role") == "user":
            return idx + 1
    return 2


def _audit_causal_pair_group(rows: list[dict[str, Any]]) -> int:
    if len(rows) < 2:
        raise ValueError("Causal pair group needs >= 2 rows")
    p0 = _initial_prefix_len(rows[0]["messages"])
    base_prompt = _json_compact(rows[0]["messages"][:p0])
    divergences = 0
    for i in range(len(rows)):
        for j in range(i + 1, len(rows)):
            a = rows[i]["messages"]
            b = rows[j]["messages"]
            pa = _initial_prefix_len(a)
            pb = _initial_prefix_len(b)
            if pa != pb or _json_compact(a[:pa]) != _json_compact(b[:pb]) or _json_compact(a[:pa]) != base_prompt:
                raise ValueError(f"Causal prompt mismatch in {rows[i]['id']} vs {rows[j]['id']}")
            ao = [(k, m) for k, m in enumerate(a) if k >= pa and m.get("role") == "tool"]
            bo = [(k, m) for k, m in enumerate(b) if k >= pb and m.get("role") == "tool"]
            div = -1
            for idx in range(min(len(ao), len(bo))):
                if ao[idx][1] != bo[idx][1]:
                    div = idx
                    break
            if div < 0:
                if len(ao) == len(bo) and a == b:
                    raise ValueError(f"Identical conversations in counterfactual pair {rows[i]['id']} vs {rows[j]['id']}")
                continue
            ai, bi = ao[div][0], bo[div][0]
            if ai != bi or a[:ai] != b[:bi]:
                raise ValueError(f"Future leakage in {rows[i]['id']} vs {rows[j]['id']} before obs {div}")
            divergences += 1
    return divergences


def main() -> int:
    parser = argparse.ArgumentParser(description="Build & 2x-verify Wave 2 Python Counterfactual Effectful I/O pairs.")
    parser.add_argument("-o", "--output", default="runs/stage10-effectful-wave2/py-tasks.jsonl")
    parser.add_argument("--trace-format", default="compact")
    parser.add_argument("--reasoning-channel", default="thinking")
    parser.add_argument("--jobs", type=int, default=4)
    args_ns = parser.parse_args()

    specs = build_family_specs()
    raw_tasks: list[dict[str, Any]] = []
    for spec in specs:
        slug = spec["slug"]
        family = f"eff-wave2-py:{slug}"
        pair_id = f"eff-wave2-pair:py:{slug}"
        rand_mode = spec.get("randomMode", "seeded")
        rand_seed = spec.get("randomSeed", 17)
        nb = spec.get("nativeBindings", [])
        for branch_name, script in spec["branches"]:
            recorded = _record_py_fixture(
                source=spec["source"],
                entry=spec.get("entry", "run"),
                args=spec["args"],
                script=script,
                native_bindings=nb,
                random_mode=rand_mode,
                random_seed=rand_seed,
            )
            ops = sorted({c["operation"] for c in recorded})
            features = sorted(
                set(spec["features"])
                | set(ops)
                | {"python", "external", "effectful", "hard-effectful", "causal-pair", "sequential", spec["domain"]}
            )
            raw_tasks.append({
                "id": f"eff-wave2-py-{slug}-{branch_name}",
                "family": family,
                "language": "py",
                "tier": 5,
                "source": spec["source"].strip() + "\n",
                "entry": spec.get("entry", "run"),
                "args": encode_readable(spec["args"]),
                "randomMode": rand_mode,
                "randomSeed": rand_seed,
                "nativeBindings": nb,
                "fixture": {"calls": recorded},
                "maxSteps": 200000,
                "timeoutMs": 10000,
                "features": features,
                "metadata": {
                    "sourceOrigin": "stage10-effectful-pairs-py-wave2",
                    "domain": spec["domain"],
                    "language": "py",
                    "tier": 5,
                    "features": features,
                    "pair_id": pair_id,
                    "pair_branch": branch_name,
                },
            })

    # Pass 1: export_python_example (spawns tools/python-reference-worker.py + audit_python_conversation)
    def _export_pass1(task: dict[str, Any]) -> dict[str, Any]:
        exp = export_python_example(
            task,
            trace_format=args_ns.trace_format,
            reasoning_channel=args_ns.reasoning_channel,
        )
        if not (exp.get("metadata", {}).get("traceAudit") or {}).get("replayVerified"):
            raise RuntimeError(f"Pass 1 replayVerified false for {task['id']}")
        return exp

    with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, min(8, args_ns.jobs))) as pool:
        pass1 = list(pool.map(_export_pass1, raw_tasks))

    # Pass 2: Independent verification via separate tools/tinker-execution-py.py worker processes
    pass2: list[dict[str, Any] | None] = [None] * len(raw_tasks)
    n_workers = max(1, min(8, args_ns.jobs))
    chunks: list[list[int]] = [[] for _ in range(n_workers)]
    for i in range(len(raw_tasks)):
        chunks[i % n_workers].append(i)

    def _run_worker_chunk(indices: list[int]) -> None:
        client = PyWorkerClient()
        try:
            for idx in indices:
                task = raw_tasks[idx]
                exp2 = client.request({
                    "op": "export",
                    "task": task,
                    "traceFormat": args_ns.trace_format,
                    "reasoningChannel": args_ns.reasoning_channel,
                })
                if not (exp2.get("metadata", {}).get("traceAudit") or {}).get("replayVerified"):
                    raise RuntimeError(f"Pass 2 replayVerified false for {task['id']}")
                if exp2["sourceHash"] != pass1[idx]["sourceHash"]:
                    raise RuntimeError(f"Determinism sourceHash mismatch on {task['id']}")
                if exp2["messages"] != pass1[idx]["messages"]:
                    raise RuntimeError(f"Determinism messages mismatch on {task['id']}")
                # Live session start -> step -> grade replay on independent worker
                started = client.request({"op": "start", "task": exp2["task"]})
                sid = started["sessionId"]
                try:
                    p_len = _initial_prefix_len(exp2["messages"])
                    final_grade = None
                    for msg in exp2["messages"][p_len:]:
                        if msg.get("role") != "assistant":
                            continue
                        step_res = client.request({"op": "step", "sessionId": sid, "action": msg, "generatedTokens": 0})
                        if step_res.get("done"):
                            final_grade = step_res.get("grade")
                    if not (final_grade and final_grade.get("success")):
                        raise RuntimeError(f"Live session replay failed for {task['id']}: {final_grade}")
                finally:
                    client.request({"op": "close", "sessionId": sid})
                pair_id = task["metadata"]["pair_id"]
                exp2["pair_id"] = pair_id
                exp2["split_component"] = _sha256(f"{exp2['family']}:{exp2['sourceHash']}")
                exp2["metadata"] = {
                    **task["metadata"],
                    **exp2["metadata"],
                    "pair_id": pair_id,
                    "pair_branch": task["metadata"]["pair_branch"],
                    "determinismVerified2x": True,
                }
                pass2[idx] = exp2
        finally:
            client.close()

    with concurrent.futures.ThreadPoolExecutor(max_workers=n_workers) as pool:
        futs = [pool.submit(_run_worker_chunk, ch) for ch in chunks if ch]
        for f in futs:
            f.result()

    verified_rows: list[dict[str, Any]] = [r for r in pass2 if r is not None]
    assert len(verified_rows) == len(raw_tasks)

    # Causal-prefix invariance audit across every pair group
    by_pair: dict[str, list[dict[str, Any]]] = {}
    for row in verified_rows:
        by_pair.setdefault(row["pair_id"], []).append(row)
    total_divergences = sum(_audit_causal_pair_group(grp) for grp in by_pair.values())

    # Also run audit_python_supervision on a stratified sample (fast check)
    sup_audit = audit_python_supervision(
        verified_rows,
        {"formats": ["compact"], "samplePerFeature": 3, "seed": 17},
    )
    if not sup_audit.get("valid") or not sup_audit.get("allReplayed"):
        raise RuntimeError(f"audit_python_supervision failed: {sup_audit}")

    out_path = (_REPO_ROOT / args_ns.output).resolve()
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text("\n".join(_json_compact(r) for r in verified_rows) + "\n", encoding="utf-8")

    op_counts: dict[str, int] = {}
    domain_counts: dict[str, int] = {}
    for r in verified_rows:
        dom = r["metadata"].get("domain", "unknown")
        domain_counts[dom] = domain_counts.get(dom, 0) + 1
        for c in r["task"]["fixture"]["calls"]:
            op_counts[c["operation"]] = op_counts.get(c["operation"], 0) + 1

    print(
        json.dumps(
            {
                "ok": True,
                "output": str(out_path),
                "totalTasks": len(verified_rows),
                "uniqueFamilies": len({r["family"] for r in verified_rows}),
                "causalPairGroups": len(by_pair),
                "causalDivergencesVerified": total_divergences,
                "determinismVerified2x": len(verified_rows),
                "supervisionAuditValid": sup_audit.get("valid"),
                "domains": domain_counts,
                "operationCallCounts": op_counts,
            },
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
