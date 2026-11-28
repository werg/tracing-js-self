#!/usr/bin/env python3
"""Messy Real-World Stateful-I/O Python OSS Harvester.

Clones (or reuses cached) real open-source Python repositories into
`/tmp/stateful-oss-cache/py`, loads their REAL package source files into our
in-memory virtual multi-file codebase (`code.load`), executes real OSS library
APIs against realistic seeded workspaces (virtual FS trees, `.env`, TOML/YAML/
INI/JSON configs, SQLite `:memory:` DBs, local deterministic HTTP server,
`os.environ`, `logging`, `subprocess`, `datetime`, `uuid`), captures genuine
external I/O calls via `install_live_io_hooks` + `install_live_http_hooks`, and
verifies EVERY admitted task 2x independently through `export_python_example` +
`create_python_session` live replay, plus strict zero-leakage auditing against
`realexecbench-v1`.
"""

from __future__ import annotations

import argparse
import ast
import builtins
import concurrent.futures
import copy
import hashlib
import http.server
import json
import os
from pathlib import Path
import re
import shutil
import socketserver
import subprocess
import sys
import tempfile
import threading
import time
from typing import Any

_REPO_ROOT = Path(__file__).resolve().parents[1]
_TRAINING_DIR = str(_REPO_ROOT / "training")
if _TRAINING_DIR not in sys.path:
    sys.path.insert(0, _TRAINING_DIR)

try:
    import tiktoken as _tiktoken  # type: ignore[import-not-found]
    _TIKTOKEN_ENC = _tiktoken.get_encoding("cl100k_base")
except Exception:
    _TIKTOKEN_ENC = None

from tinker_py.codebase import CODE_LOAD_OPERATION  # noqa: E402
from tinker_py.codec import encode_readable  # noqa: E402
from tinker_py.execution import (  # noqa: E402
    _audit_causal_prefix_pair,
    create_python_session,
    export_python_example,
    prepare_python_task,
)

MAX_CONTEXT_TOKENS = 65_472
SAFE_CONTEXT_TOKENS = 65_000
MAX_TURN_TOKENS = 20_000
DEFAULT_CACHE_DIR = Path("/tmp/stateful-oss-cache/py")
DEFAULT_BENCHMARK_JSONL = Path("/home/werg/tracing-js-self/runs/realexecbench-v1/benchmark.jsonl")
DEFAULT_BENCHMARK_MANIFEST = Path("/home/werg/tracing-js-self/runs/realexecbench-v1/manifest.json")

# Real Python OSS repositories (zero overlap with realexecbench-v1)
PY_OSS_REPOS: dict[str, str] = {
    "theskumar__python-dotenv": "https://github.com/theskumar/python-dotenv.git",
    "msiemens__tinydb": "https://github.com/msiemens/tinydb.git",
    "pytest-dev__iniconfig": "https://github.com/pytest-dev/iniconfig.git",
    "asottile__cfgv": "https://github.com/asottile/cfgv.git",
    "asottile__identify": "https://github.com/pre-commit/identify.git",
    "PyCQA__pycodestyle": "https://github.com/PyCQA/pycodestyle.git",
    "PyCQA__pyflakes": "https://github.com/PyCQA/pyflakes.git",
    "PyCQA__mccabe": "https://github.com/PyCQA/mccabe.git",
    "jendrikseipp__vulture": "https://github.com/jendrikseipp/vulture.git",
    "cpburnz__python-pathspec": "https://github.com/cpburnz/python-pathspec.git",
    "hukkin__tomli": "https://github.com/hukkin/tomli.git",
    "hukkin__tomli-w": "https://github.com/hukkin/tomli-w.git",
    "uiri__toml": "https://github.com/uiri/toml.git",
    "sdispater__tomlkit": "https://github.com/python-poetry/tomlkit.git",
    "pypa__packaging": "https://github.com/pypa/packaging.git",
    "yaml__pyyaml": "https://github.com/yaml/pyyaml.git",
    "Python-Markdown__markdown": "https://github.com/Python-Markdown/markdown.git",
    "executablebooks__markdown-it-py": "https://github.com/executablebooks/markdown-it-py.git",
    "bottlepy__bottle": "https://github.com/bottlepy/bottle.git",
    "platformdirs__platformdirs": "https://github.com/tox-dev/platformdirs.git",
    "jazzband__dj-database-url": "https://github.com/jazzband/dj-database-url.git",
    "docopt__docopt": "https://github.com/docopt/docopt.git",
    "simonw__sqlite-utils": "https://github.com/simonw/sqlite-utils.git",
    "kurtmckee__feedparser": "https://github.com/kurtmckee/feedparser.git",
    "hynek__structlog": "https://github.com/hynek/structlog.git",
}


def _count_tokens(text: str) -> int:
    if _TIKTOKEN_ENC is not None:
        return len(_TIKTOKEN_ENC.encode(text, disallowed_special=()))
    return max(1, (len(text) + 3) // 4)


def _estimate_messages_tokens(messages: list[dict[str, Any]]) -> tuple[int, int]:
    total = 0
    max_turn = 0
    for msg in messages:
        toks = _count_tokens(json.dumps(msg, ensure_ascii=False, separators=(",", ":")))
        total += toks
        if toks > max_turn:
            max_turn = toks
    return total, max_turn


def _sha256(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _is_preexported_row(item: dict[str, Any]) -> bool:
    return (
        isinstance(item.get("messages"), list)
        and bool(item["messages"])
        and isinstance(item.get("sourceHash"), str)
        and isinstance(item.get("task"), dict)
    )


def _load_forbidden_benchmark(
    benchmark_jsonl: Path,
    benchmark_manifest: Path,
) -> dict[str, set[str]]:
    forbidden: dict[str, set[str]] = {
        "ids": set(),
        "families": set(),
        "sourceHashes": set(),
        "split_components": set(),
        "repos": set(),
    }
    if benchmark_jsonl.exists():
        for line in benchmark_jsonl.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            row = json.loads(line)
            if isinstance(row.get("id"), str):
                forbidden["ids"].add(row["id"])
            if isinstance(row.get("family"), str):
                forbidden["families"].add(row["family"])
            if isinstance(row.get("sourceHash"), str):
                forbidden["sourceHashes"].add(row["sourceHash"])
            if isinstance(row.get("split_component"), str):
                forbidden["split_components"].add(row["split_component"])
            meta = row.get("metadata") or {}
            if isinstance(meta.get("repo"), str) and meta["repo"]:
                forbidden["repos"].add(meta["repo"].lower())
                if "__" in meta["repo"]:
                    forbidden["repos"].add(meta["repo"].split("__", 1)[1].lower())
    if benchmark_manifest.exists():
        m = json.loads(benchmark_manifest.read_text(encoding="utf-8"))
        for ids in (m.get("task_ids_by_track") or {}).values():
            for tid in ids:
                if isinstance(tid, str):
                    forbidden["ids"].add(tid)
    return forbidden


def _ensure_repo_cloned(repo_name: str, url: str, cache_dir: Path) -> Path:
    dest = cache_dir / repo_name
    if dest.exists() and any(dest.iterdir()):
        return dest
    cache_dir.mkdir(parents=True, exist_ok=True)
    if dest.exists():
        shutil.rmtree(dest, ignore_errors=True)
    proc = subprocess.run(
        ["git", "clone", "--depth", "1", "--quiet", url, str(dest)],
        capture_output=True,
        text=True,
        timeout=60,
        env={**os.environ, "GIT_TERMINAL_PROMPT": "0"},
        check=False,
    )
    if proc.returncode != 0:
        shutil.rmtree(dest, ignore_errors=True)
        raise RuntimeError(f"git clone {repo_name} failed: {proc.stderr.strip()[:200]}")
    return dest


def _collect_package_files(
    repo_dir: Path,
    subpath: str,
    *,
    single_file: str | None = None,
    max_file_bytes: int = 380_000,
    max_files: int = 75,
    exclude_substrings: tuple[str, ...] = ("mypy_plugin", "__main__", "tests/", "test_", "benchmark"),
) -> dict[str, str]:
    """Load real Python package source files from a cloned OSS repository."""
    files: dict[str, str] = {}
    if single_file:
        src_path = repo_dir / subpath / single_file if subpath != "." else repo_dir / single_file
        if not src_path.is_file():
            raise FileNotFoundError(f"Missing single file {src_path}")
        text = src_path.read_text(encoding="utf-8", errors="ignore")
        if len(text.encode("utf-8")) > max_file_bytes:
            raise ValueError(f"Single file too large: {src_path}")
        files[single_file] = text
        return files

    base = repo_dir / subpath if subpath != "." else repo_dir
    if not base.is_dir():
        raise FileNotFoundError(f"Missing package dir {base}")
    parent = base.parent
    candidates = sorted(base.rglob("*.py"))
    for fp in candidates:
        rel = fp.relative_to(parent).as_posix()
        if any(ex in rel for ex in exclude_substrings):
            continue
        raw_bytes = fp.read_bytes()
        if b"\x00" in raw_bytes or len(raw_bytes) > max_file_bytes:
            continue
        text = raw_bytes.decode("utf-8", errors="ignore")
        try:
            ast.parse(text)
        except SyntaxError:
            continue
        files[rel] = text
        if len(files) >= max_files:
            break
    if not files:
        raise RuntimeError(f"No valid .py files collected from {base}")
    return files


# ---------------------------------------------------------------------------
# Deterministic local HTTP server for real HTTP OSS harvesting
# ---------------------------------------------------------------------------


class _DeterministicHttpServer:
    def __init__(self) -> None:
        self.routes: dict[str, tuple[int, dict[str, str], bytes]] = {}
        self._server: socketserver.TCPServer | None = None
        self._thread: threading.Thread | None = None
        self.port: int = 0

    def start(self) -> int:
        owner = self

        class _Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, format: str, *args: Any) -> None:  # noqa: A002
                return None

            def _serve(self) -> None:
                route = owner.routes.get(self.path)
                if route is None:
                    self.send_response(404)
                    self.send_header("Content-Type", "application/json")
                    body = b'{"error":"not_found"}'
                    self.send_header("Content-Length", str(len(body)))
                    self.end_headers()
                    self.wfile.write(body)
                    return
                status, headers, body = route
                self.send_response(status)
                for k, v in headers.items():
                    self.send_header(k, v)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_GET(self) -> None:
                self._serve()

            def do_POST(self) -> None:
                length = int(self.headers.get("Content-Length", "0") or 0)
                if length > 0:
                    _ = self.rfile.read(length)
                self._serve()

        class _ReusableTCPServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
            allow_reuse_address = True
            daemon_threads = True

        self._server = _ReusableTCPServer(("127.0.0.1", 0), _Handler)
        self.port = int(self._server.server_address[1])
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)
        self._thread.start()
        return self.port

    def set_routes(self, routes: dict[str, tuple[int, dict[str, str], bytes]]) -> None:
        self.routes = dict(routes)

    def stop(self) -> None:
        if self._server is not None:
            self._server.shutdown()
            self._server.server_close()
            self._server = None


# ---------------------------------------------------------------------------
# Isolated live-capture probe (records real I/O + code.load calls)
# ---------------------------------------------------------------------------

_LIVE_CAPTURE_SCRIPT = r"""
import asyncio
import builtins
import inspect
import io
import json
import os
import random
import signal
import sys
import time
import uuid

sys.path.insert(0, sys.argv[1])
from tinker_py.codebase import (
    guest_filename_for,
    load_virtual_entry_module,
    normalize_codebase_files,
)
from tinker_py.codec import decode_readable, encode_exception, encode_readable
from tinker_py.http_tools import DEFAULT_HTTP_TIMEOUT_S, MAX_HTTP_BODY_BYTES, install_live_http_hooks
from tinker_py.io_tools import (
    DEFAULT_SUBPROCESS_TIMEOUT_S,
    MAX_IO_BYTES,
    MAX_LIVE_CALLS,
    install_live_io_hooks,
    is_guest_caller,
)

def _on_alarm(_sig, _frame):
    raise TimeoutError("live capture timeout")

if hasattr(signal, "SIGALRM"):
    signal.signal(signal.SIGALRM, _on_alarm)
    signal.setitimer(signal.ITIMER_REAL, 12.0)

real_stdout = sys.stdout
try:
    req = json.loads(sys.stdin.read())
    is_multifile = isinstance(req.get("files"), dict) and len(req["files"]) > 0
    if is_multifile:
        files, entry_file, _init = normalize_codebase_files(req["files"], req["entryFile"])
        all_src = "\n".join(files.values())
    else:
        source = req["source"]
        files = {}
        entry_file = ""
        all_src = source
    entry = req["entry"]
    args = decode_readable(req["args"])

    recorded = []
    rng = random.Random(17)
    time_counter = [0]
    uuid_counter = [0]
    io_depth = [0]
    real_time = time.time
    real_monotonic = time.monotonic
    real_random = random.random

    def _next_det_time():
        val = 1710000000.0 + time_counter[0] * 1.5
        time_counter[0] += 1
        return val

    def _rec_print(*p_args, **_kwargs):
        if io_depth[0] > 0:
            return
        if len(recorded) >= MAX_LIVE_CALLS:
            raise RuntimeError("too many recorded calls")
        recorded.append({
            "operation": "platform.print",
            "arguments": encode_readable(list(p_args)),
            "status": "fulfilled",
            "result": None,
        })

    def _rec_time():
        if not is_guest_caller(io_depth):
            return real_time()
        val = _next_det_time()
        recorded.append({
            "operation": "platform.time",
            "arguments": [],
            "status": "fulfilled",
            "result": val,
        })
        return val

    def _rec_monotonic():
        if not is_guest_caller(io_depth):
            return real_monotonic()
        val = _next_det_time()
        recorded.append({
            "operation": "platform.time",
            "arguments": [],
            "status": "fulfilled",
            "result": val,
        })
        return val

    enable_urllib = ("urllib" in all_src) or ("urlopen" in all_src)
    enable_requests = "requests" in all_src
    if enable_urllib or enable_requests:
        install_live_http_hooks(
            recorded,
            max_body_bytes=MAX_HTTP_BODY_BYTES,
            default_timeout=DEFAULT_HTTP_TIMEOUT_S,
            enable_urllib=enable_urllib,
            enable_requests=enable_requests,
            io_depth=io_depth,
        )

    time.time = _rec_time
    time.monotonic = _rec_monotonic
    random.seed(17)

    guest_builtins = dict(vars(builtins))
    guest_builtins["print"] = _rec_print
    flush_io = install_live_io_hooks(
        recorded,
        io_depth=io_depth,
        guest_builtins=guest_builtins,
        max_io_bytes=MAX_IO_BYTES,
        max_recorded_calls=MAX_LIVE_CALLS,
        default_subprocess_timeout=DEFAULT_SUBPROCESS_TIMEOUT_S,
        next_time_fn=_next_det_time,
    )

    # Deterministic uuid4 override wrapping recorded call so repeated probes match cleanly.
    orig_uuid4_hook = uuid.uuid4
    def _det_uuid4():
        if not is_guest_caller(io_depth):
            return orig_uuid4_hook()
        idx = uuid_counter[0]
        uuid_counter[0] += 1
        u = str(uuid.UUID(int=0x11112222333344445555666677770000 + idx))
        recorded.append({
            "operation": "platform.uuid",
            "arguments": [],
            "status": "fulfilled",
            "result": u,
        })
        return uuid.UUID(u)
    uuid.uuid4 = _det_uuid4

    touched_non_entry = set()
    guest_to_rel = {guest_filename_for(p): p for p in files} if is_multifile else {}

    def _trace(frame, event, _arg):
        if event == "call" and is_multifile:
            rel = guest_to_rel.get(frame.f_code.co_filename)
            if rel and rel != entry_file:
                touched_non_entry.add(rel)
        return None

    sys.stdout = io.StringIO()
    kind = "return"
    try:
        if is_multifile:
            entry_mod, _finder = load_virtual_entry_module(files, entry_file, guest_builtins, {})
            fn = getattr(entry_mod, entry, None)
        else:
            ns = {"__builtins__": guest_builtins, "__name__": "__guest__"}
            exec(compile(source, "<guest>", "exec"), ns)
            fn = ns.get(entry)
        if not callable(fn):
            raise TypeError(f"Entry {entry!r} not callable")
        if is_multifile:
            sys.settrace(_trace)
        try:
            res = fn(*args)
            if inspect.isawaitable(res):
                res = asyncio.run(res)
            flush_io()
        except Exception as exc:
            kind = "throw"
            res = encode_exception(exc)
        finally:
            if is_multifile:
                sys.settrace(None)
    finally:
        sys.stdout = real_stdout
        if hasattr(signal, "SIGALRM"):
            signal.setitimer(signal.ITIMER_REAL, 0.0)

    enc_out = encode_readable({"arguments": args, "value": res})
    real_stdout.write(json.dumps({
        "ok": True,
        "kind": kind,
        "result": enc_out,
        "recordedCalls": recorded,
        "touchedFiles": sorted(touched_non_entry),
    }, ensure_ascii=True, separators=(",", ":"), allow_nan=False) + "\n")
except Exception as exc:
    sys.stdout = real_stdout
    if hasattr(signal, "SIGALRM"):
        signal.setitimer(signal.ITIMER_REAL, 0.0)
    real_stdout.write(json.dumps({
        "ok": False,
        "error": f"{type(exc).__name__}: {exc}",
    }, ensure_ascii=False, separators=(",", ":"), allow_nan=False) + "\n")
"""


def _seed_workspace(
    workdir: Path,
    world_files: dict[str, str | bytes],
    *,
    init_git: bool = False,
) -> None:
    for rel, content in world_files.items():
        target = workdir / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        if isinstance(content, bytes):
            target.write_bytes(content)
        else:
            target.write_text(content, encoding="utf-8")
    if init_git:
        git_env = {
            **os.environ,
            "GIT_AUTHOR_NAME": "Dev",
            "GIT_AUTHOR_EMAIL": "dev@example.com",
            "GIT_COMMITTER_NAME": "Dev",
            "GIT_COMMITTER_EMAIL": "dev@example.com",
        }
        subprocess.run(["git", "init", "-q"], cwd=workdir, env=git_env, check=True)
        subprocess.run(["git", "add", "."], cwd=workdir, env=git_env, check=True)
        subprocess.run(["git", "commit", "-q", "-m", "initial"], cwd=workdir, env=git_env, check=True)


def _run_live_capture(
    *,
    files: dict[str, str] | None,
    entry_file: str | None,
    source: str | None,
    entry: str,
    args: list[Any],
    world_files: dict[str, str | bytes],
    world_env: dict[str, str],
    post_git_writes: dict[str, str | bytes] | None = None,
    init_git: bool = False,
) -> dict[str, Any]:
    with tempfile.TemporaryDirectory(prefix="stateful-oss-py-") as tmp:
        workdir = Path(tmp)
        _seed_workspace(workdir, world_files, init_git=init_git)
        if post_git_writes:
            _seed_workspace(workdir, post_git_writes, init_git=False)

        clean_env: dict[str, str] = {
            "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
            "HOME": str(workdir),
            "LANG": "C.UTF-8",
            "LC_ALL": "C.UTF-8",
            "PYTHONHASHSEED": "0",
        }
        clean_env.update(world_env)

        payload: dict[str, Any] = {
            "entry": entry,
            "args": encode_readable(args),
        }
        if files is not None and entry_file is not None:
            payload["files"] = files
            payload["entryFile"] = entry_file
        else:
            payload["source"] = source

        proc = subprocess.run(
            [sys.executable, "-c", _LIVE_CAPTURE_SCRIPT, _TRAINING_DIR],
            input=json.dumps(payload, ensure_ascii=True, separators=(",", ":")),
            capture_output=True,
            text=True,
            cwd=workdir,
            env=clean_env,
            timeout=20,
            check=False,
        )
        stdout = proc.stdout.strip()
        if not stdout:
            return {"ok": False, "error": f"Empty probe stdout (rc={proc.returncode}): {proc.stderr.strip()[-400:]}"}
        return json.loads(stdout.splitlines()[-1])


def _extract_declared_and_used_tools(messages: list[dict[str, Any]]) -> tuple[set[str], list[str]]:
    declared: set[str] = set()
    used: list[str] = []
    for msg in messages:
        if msg.get("role") == "tool_declare":
            try:
                for item in json.loads(msg["content"]):
                    name = (item.get("function") or {}).get("name")
                    if isinstance(name, str):
                        declared.add(name)
            except Exception:
                pass
        elif msg.get("role") == "assistant" and isinstance(msg.get("tool_calls"), list):
            for tc in msg["tool_calls"]:
                name = (tc.get("function") or {}).get("name")
                if isinstance(name, str):
                    used.append(name)
    return declared, used


def _verify_task_2x(task: dict[str, Any], *, trace_format: str = "compact") -> tuple[dict[str, Any], dict[str, Any]]:
    """Verify a Python task 2x independently + live session replay + tool & token checks."""
    fmt = trace_format
    ex1 = export_python_example(task, trace_format=fmt, reasoning_channel="thinking")
    ex2 = export_python_example(task, trace_format=fmt, reasoning_channel="thinking")
    if ex1["messages"] != ex2["messages"]:
        if fmt == "compact":
            # Some real OSS libraries expose object id() pointers or set iteration order in
            # local-variable traces; fall back to deterministic actions-only supervision.
            fmt = "actions-only"
            ex1 = export_python_example(task, trace_format=fmt, reasoning_channel="thinking")
            ex2 = export_python_example(task, trace_format=fmt, reasoning_channel="thinking")
            if ex1["messages"] != ex2["messages"]:
                raise RuntimeError("Non-deterministic messages across 2x export (even actions-only)")
        else:
            raise RuntimeError("Non-deterministic messages across 2x export")
    if ex1["sourceHash"] != ex2["sourceHash"]:
        raise RuntimeError("Non-deterministic sourceHash across 2x export")
    if not _is_preexported_row(ex1):
        raise RuntimeError("Failed _is_preexported_row schema check")

    ext_calls = int((ex1.get("metadata") or {}).get("externalCalls", 0))
    if ext_calls < 1:
        raise RuntimeError("Task has 0 non-code.load external I/O calls")

    declared, used = _extract_declared_and_used_tools(ex1["messages"])
    undeclared = [op for op in used if op not in declared]
    if undeclared:
        raise RuntimeError(f"Undeclared tools invoked: {sorted(set(undeclared))}")

    total_tokens, max_turn_tokens = _estimate_messages_tokens(ex1["messages"])
    if (total_tokens > SAFE_CONTEXT_TOKENS or max_turn_tokens > MAX_TURN_TOKENS) and fmt == "compact":
        fmt = "actions-only"
        ex1 = export_python_example(task, trace_format=fmt, reasoning_channel="thinking")
        ex2 = export_python_example(task, trace_format=fmt, reasoning_channel="thinking")
        if ex1["messages"] != ex2["messages"]:
            raise RuntimeError("Non-deterministic messages across 2x export (actions-only)")
        total_tokens, max_turn_tokens = _estimate_messages_tokens(ex1["messages"])
    if total_tokens > SAFE_CONTEXT_TOKENS or total_tokens > MAX_CONTEXT_TOKENS:
        raise RuntimeError(f"Context token budget exceeded: {total_tokens} > {SAFE_CONTEXT_TOKENS}")
    if max_turn_tokens > MAX_TURN_TOKENS:
        raise RuntimeError(f"Max turn token budget exceeded: {max_turn_tokens} > {MAX_TURN_TOKENS}")

    # Independent live session replay verification
    prepared = prepare_python_task(task, trace_format=fmt)
    session = create_python_session(prepared)
    try:
        for msg in ex1["messages"]:
            if msg.get("role") == "assistant":
                step_res = session.step(msg, 0)
                if step_res["done"] and not step_res["grade"]["success"]:
                    raise RuntimeError(f"Live session replay failed: {step_res['grade']}")
        final_grade = session.grade()
        if not final_grade["success"]:
            raise RuntimeError(f"Live session replay incomplete: {final_grade}")
        if final_grade["externalCalls"] != ext_calls:
            raise RuntimeError(f"Live session externalCalls mismatch: {final_grade['externalCalls']} != {ext_calls}")
    finally:
        session.close()

    non_cl_ops = [op for op in used if op != CODE_LOAD_OPERATION]
    stats = {
        "total_tokens": total_tokens,
        "max_turn_tokens": max_turn_tokens,
        "external_ops": non_cl_ops,
        "code_load_calls": sum(1 for op in used if op == CODE_LOAD_OPERATION),
    }
    ex1["metadata"]["contextTokens"] = total_tokens
    ex1["metadata"]["maxTurnTokens"] = max_turn_tokens
    ex1["metadata"]["externalOps"] = sorted(set(non_cl_ops))
    ex1["metadata"]["verified2x"] = True
    return ex1, stats


# ---------------------------------------------------------------------------
# Scenario definitions across 25 REAL Python OSS repositories
# ---------------------------------------------------------------------------


def build_python_scenarios(
    cache_dir: Path,
    http_server: _DeterministicHttpServer,
    errors: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Assemble real-world stateful-I/O scenario specs (including counterfactual pairs)."""
    scenarios: list[dict[str, Any]] = []
    base_url = f"http://127.0.0.1:{http_server.port}"

    def _load_pkg(
        repo: str,
        subpath: str,
        *,
        single_file: str | None = None,
        max_files: int = 75,
        exclude_substrings: tuple[str, ...] = ("mypy_plugin", "__main__", "tests/", "test_", "benchmark"),
    ) -> dict[str, str] | None:
        try:
            repo_dir = _ensure_repo_cloned(repo, PY_OSS_REPOS[repo], cache_dir)
            return _collect_package_files(
                repo_dir,
                subpath,
                single_file=single_file,
                max_files=max_files,
                exclude_substrings=exclude_substrings,
            )
        except Exception as exc:
            errors.append({"repo": repo, "stage": "load_pkg", "error": str(exc)})
            return None

    def _add_pair(
        repo: str,
        slug: str,
        pkg_files: dict[str, str],
        entry_file: str,
        entry_code: str,
        entry_fn: str,
        args: list[Any],
        world_a: dict[str, Any],
        world_b: dict[str, Any],
        extra_features: list[str],
    ) -> None:
        files = {**pkg_files, entry_file: entry_code}
        pair_id = f"stateful-oss-py:{repo}:{slug}"
        scenarios.append({
            "kind": "pair",
            "repo": repo,
            "slug": slug,
            "pair_id": pair_id,
            "files": files,
            "entry_file": entry_file,
            "entry": entry_fn,
            "args": args,
            "variants": [
                {"suffix": world_a["label"], **world_a},
                {"suffix": world_b["label"], **world_b},
            ],
            "features": ["real-oss-stateful-io", "causal-pair", "multi-file", "code-load", *extra_features],
        })

    def _add_single(
        repo: str,
        slug: str,
        pkg_files: dict[str, str],
        entry_file: str,
        entry_code: str,
        entry_fn: str,
        args: list[Any],
        world: dict[str, Any],
        extra_features: list[str],
    ) -> None:
        files = {**pkg_files, entry_file: entry_code}
        scenarios.append({
            "kind": "single",
            "repo": repo,
            "slug": slug,
            "files": files,
            "entry_file": entry_file,
            "entry": entry_fn,
            "args": args,
            "variants": [{"suffix": world["label"], **world}],
            "features": ["real-oss-stateful-io", "multi-file", "code-load", *extra_features],
        })

    # 1. theskumar/python-dotenv
    pkg = _load_pkg("theskumar__python-dotenv", "src/dotenv", exclude_substrings=("ipython", "cli.py", "__main__", "tests/"))
    if pkg:
        _add_pair(
            "theskumar__python-dotenv",
            "load_profile",
            pkg,
            "env_loader.py",
            """import json
import logging
import os
from dotenv import dotenv_values, load_dotenv

def run(env_path, out_path):
    exists = os.path.exists(env_path)
    if exists:
        vals = dict(dotenv_values(env_path, interpolate=False))
        load_dotenv(env_path, override=False, interpolate=False)
        logging.info("loaded %d keys from %s", len(vals), env_path)
    else:
        vals = {}
        logging.warning("missing env file %s; falling back to defaults", env_path)
    mode = os.getenv("APP_MODE", "development")
    port = int(os.getenv("APP_PORT", "8000"))
    dsn = os.getenv("DATABASE_URL", "sqlite:///local.db")
    summary = {"exists": exists, "mode": mode, "port": port, "dsn": dsn, "keys": sorted(vals.keys())}
    with open(out_path, "w", encoding="utf-8") as fh:
        fh.write(json.dumps(summary, sort_keys=True))
    return summary
""",
            "run",
            ["workspace/.env", "workspace/resolved.json"],
            {
                "label": "env_present",
                "files": {"workspace/.env": "APP_MODE=production\nAPP_PORT=9090\nDATABASE_URL=postgres://db:5432/prod\n"},
                "env": {"APP_MODE": "staging"},
            },
            {
                "label": "env_missing",
                "files": {"workspace/README.txt": "no env file"},
                "env": {},
            },
            ["fs-io", "env-io", "logging"],
        )
        _add_pair(
            "theskumar__python-dotenv",
            "merge_dotenv_layers",
            pkg,
            "env_merge.py",
            """import json
import os
from dotenv import dotenv_values

def run(base_path, local_path):
    base = dict(dotenv_values(base_path, interpolate=False)) if os.path.isfile(base_path) else {}
    local = dict(dotenv_values(local_path, interpolate=False)) if os.path.isfile(local_path) else {}
    merged = {**base, **local}
    override_debug = os.getenv("FORCE_DEBUG")
    if override_debug is not None:
        merged["DEBUG"] = override_debug
    out_lines = [f"{k}={merged[k]}" for k in sorted(merged)]
    with open("workspace/effective.env", "w", encoding="utf-8") as fh:
        fh.write("\\n".join(out_lines) + "\\n")
    return {"count": len(merged), "debug": merged.get("DEBUG", "0"), "host": merged.get("HOST", "localhost")}
""",
            "run",
            ["workspace/.env", "workspace/.env.local"],
            {
                "label": "with_local_override",
                "files": {
                    "workspace/.env": "HOST=0.0.0.0\nDEBUG=0\nWORKERS=4\n",
                    "workspace/.env.local": "HOST=127.0.0.1\nDEBUG=1\n",
                },
                "env": {},
            },
            {
                "label": "base_only_forced_env",
                "files": {"workspace/.env": "HOST=0.0.0.0\nDEBUG=0\nWORKERS=4\n"},
                "env": {"FORCE_DEBUG": "true"},
            },
            ["fs-io", "env-io"],
        )
        _add_single(
            "theskumar__python-dotenv",
            "audit_env_dir",
            pkg,
            "env_audit.py",
            """import logging
import os
from dotenv import dotenv_values

def run(config_dir, required_keys):
    entries = sorted(os.listdir(config_dir))
    report = {}
    for name in entries:
        if not name.endswith(".env"):
            continue
        full = config_dir + "/" + name
        parsed = dict(dotenv_values(full, interpolate=False))
        missing = [k for k in required_keys if not parsed.get(k)]
        if missing:
            logging.warning("profile %s missing %s", name, ",".join(missing))
        report[name] = {"present": sorted(parsed.keys()), "missing": missing}
    return report
""",
            "run",
            ["envs", ["API_KEY", "DB_HOST", "LOG_LEVEL"]],
            {
                "label": "multi_profile_audit",
                "files": {
                    "envs/dev.env": "API_KEY=dev123\nDB_HOST=localhost\nLOG_LEVEL=DEBUG\n",
                    "envs/prod.env": "DB_HOST=prod.internal\nLOG_LEVEL=INFO\n",
                    "envs/notes.txt": "ignored",
                },
                "env": {},
            },
            ["fs-io", "logging"],
        )

    # 2. msiemens/tinydb
    pkg = _load_pkg("msiemens__tinydb", "tinydb")
    if pkg:
        _add_pair(
            "msiemens__tinydb",
            "inventory_sync",
            pkg,
            "inv_sync.py",
            """import json
import logging
import os
from tinydb import Query, TinyDB
from tinydb.storages import MemoryStorage

def run(seed_path, out_path):
    with open(seed_path, "r", encoding="utf-8") as fh:
        rows = json.load(fh)
    min_qty = int(os.getenv("REORDER_THRESHOLD", "5"))
    db = TinyDB(storage=MemoryStorage)
    tbl = db.table("inventory")
    tbl.insert_multiple(rows)
    Item = Query()
    low = tbl.search(Item.qty < min_qty)
    reordered = []
    for doc in low:
        logging.warning("low stock sku=%s qty=%d", doc["sku"], doc["qty"])
        tbl.update({"qty": doc["qty"] + 10, "reordered": True}, Item.sku == doc["sku"])
        reordered.append(doc["sku"])
    final_docs = sorted(tbl.all(), key=lambda d: d["sku"])
    with open(out_path, "w", encoding="utf-8") as fh:
        fh.write(json.dumps({"items": final_docs, "reordered": sorted(reordered)}, sort_keys=True))
    return {"reordered": sorted(reordered), "total_qty": sum(d["qty"] for d in final_docs)}
""",
            "run",
            ["data/inventory.json", "data/inventory_out.json"],
            {
                "label": "low_stock_triggers_reorder",
                "files": {
                    "data/inventory.json": json.dumps([
                        {"sku": "A100", "qty": 2, "reordered": False},
                        {"sku": "B200", "qty": 12, "reordered": False},
                        {"sku": "C300", "qty": 4, "reordered": False},
                    ])
                },
                "env": {"REORDER_THRESHOLD": "5"},
            },
            {
                "label": "healthy_stock_no_reorder",
                "files": {
                    "data/inventory.json": json.dumps([
                        {"sku": "A100", "qty": 9, "reordered": False},
                        {"sku": "B200", "qty": 12, "reordered": False},
                        {"sku": "C300", "qty": 8, "reordered": False},
                    ])
                },
                "env": {"REORDER_THRESHOLD": "5"},
            },
            ["fs-io", "env-io", "logging"],
        )
        _add_pair(
            "msiemens__tinydb",
            "flag_upsert",
            pkg,
            "flag_store.py",
            """import json
import os
from tinydb import Query, TinyDB
from tinydb.storages import MemoryStorage

def run(db_path, flag_name):
    if os.path.exists(db_path):
        with open(db_path, "r", encoding="utf-8") as fh:
            initial = json.load(fh)
    else:
        initial = []
    env = os.getenv("DEPLOY_ENV", "dev")
    db = TinyDB(storage=MemoryStorage)
    db.insert_multiple(initial)
    Flag = Query()
    hit = db.get(Flag.name == flag_name)
    if hit is None:
        db.upsert({"name": flag_name, "enabled": env != "prod", "env": env}, Flag.name == flag_name)
        action = "inserted"
    else:
        new_state = hit["enabled"] if env == "prod" else True
        db.update({"enabled": new_state, "env": env}, Flag.name == flag_name)
        action = "updated"
    out = sorted(db.all(), key=lambda x: x["name"])
    with open(db_path, "w", encoding="utf-8") as fh:
        fh.write(json.dumps(out, sort_keys=True))
    return {"action": action, "flag": db.get(Flag.name == flag_name)}
""",
            "run",
            ["state/flags.json", "dark_mode"],
            {
                "label": "existing_flag_prod",
                "files": {"state/flags.json": json.dumps([{"name": "dark_mode", "enabled": False, "env": "staging"}])},
                "env": {"DEPLOY_ENV": "prod"},
            },
            {
                "label": "missing_db_dev",
                "files": {"state/.keep": ""},
                "env": {"DEPLOY_ENV": "dev"},
            },
            ["fs-io", "env-io"],
        )

    # 3. pytest-dev/iniconfig
    pkg = _load_pkg("pytest-dev__iniconfig", "src/iniconfig")
    if pkg:
        _add_pair(
            "pytest-dev__iniconfig",
            "load_pytest_ini",
            pkg,
            "ini_runner.py",
            """import json
import logging
import os
from iniconfig import IniConfig

def run(ini_path, report_path):
    cfg = IniConfig(ini_path)
    section = "pytest" if "pytest" in cfg else "tool:pytest"
    sec = cfg[section]
    addopts = sec.get("addopts", "")
    minver = sec.get("minversion", "0.0")
    ci = os.getenv("CI", "")
    strict = ("--strict-markers" in addopts) or (ci == "true")
    logging.info("ini section=%s strict=%s", section, strict)
    out = {"section": section, "minversion": minver, "strict": strict, "keys": sorted(sec._config.sections[section].keys())}
    with open(report_path, "w", encoding="utf-8") as fh:
        fh.write(json.dumps(out, sort_keys=True))
    return out
""",
            "run",
            ["project/pytest.ini", "project/ini_report.json"],
            {
                "label": "strict_ci_pytest",
                "files": {"project/pytest.ini": "[pytest]\nminversion = 8.0\naddopts = -ra --strict-markers\ntestpaths = tests\n"},
                "env": {"CI": "true"},
            },
            {
                "label": "lenient_setup_cfg",
                "files": {"project/pytest.ini": "[tool:pytest]\nminversion = 7.4\naddopts = -q\n"},
                "env": {},
            },
            ["fs-io", "env-io", "logging"],
        )
        _add_pair(
            "pytest-dev__iniconfig",
            "ini_fallback_chain",
            pkg,
            "ini_chain.py",
            """import os
from iniconfig import IniConfig

def run(candidates):
    chosen = None
    for path in candidates:
        if os.path.exists(path):
            chosen = path
            break
    if chosen is None:
        return {"found": False, "sections": []}
    cfg = IniConfig(chosen)
    sections = sorted(cfg.sections.keys())
    return {"found": True, "path": chosen, "sections": sections, "first": dict(cfg[sections[0]]) if sections else {}}
""",
            "run",
            [["cfg/local.ini", "cfg/default.ini"]],
            {
                "label": "local_hit",
                "files": {
                    "cfg/local.ini": "[app]\ndebug = true\nworkers = 2\n",
                    "cfg/default.ini": "[app]\ndebug = false\nworkers = 8\n",
                },
                "env": {},
            },
            {
                "label": "fallback_default",
                "files": {"cfg/default.ini": "[app]\ndebug = false\nworkers = 8\n"},
                "env": {},
            },
            ["fs-io"],
        )

    # 4. asottile/cfgv
    pkg = _load_pkg("asottile__cfgv", ".", single_file="cfgv.py")
    if pkg:
        _add_pair(
            "asottile__cfgv",
            "validate_service_schema",
            pkg,
            "cfgv_check.py",
            """import json
import logging
import cfgv

SCHEMA = cfgv.Map(
    "ServiceConfig", "name",
    cfgv.Required("name", cfgv.check_string),
    cfgv.Required("port", cfgv.check_int),
    cfgv.Optional("retries", cfgv.check_int, 3),
    cfgv.Optional("tags", cfgv.check_array(cfgv.check_string), []),
)

def run(cfg_path, out_path):
    try:
        data = cfgv.load_from_filename(cfg_path, SCHEMA, json.loads)
        logging.info("validated service %s", data["name"])
        result = {"valid": True, "config": data}
    except cfgv.ValidationError as exc:
        logging.error("validation failed: %s", exc)
        result = {"valid": False, "error": str(exc).splitlines()[0]}
    with open(out_path, "w", encoding="utf-8") as fh:
        fh.write(json.dumps(result, sort_keys=True))
    return result
""",
            "run",
            ["cfg/service.json", "cfg/validation.json"],
            {
                "label": "valid_with_defaults",
                "files": {"cfg/service.json": json.dumps({"name": "billing-api", "port": 8080})},
                "env": {},
            },
            {
                "label": "invalid_port_type",
                "files": {"cfg/service.json": json.dumps({"name": "billing-api", "port": "not-an-int"})},
                "env": {},
            },
            ["fs-io", "logging"],
        )

    # 5. asottile/identify
    pkg = _load_pkg("asottile__identify", "identify", exclude_substrings=("cli.py", "__main__", "tests/"))
    if pkg:
        _add_pair(
            "asottile__identify",
            "classify_scripts",
            pkg,
            "tag_files.py",
            """import json
import logging
import os
from identify import identify

def run(bin_dir, manifest_path):
    entries = sorted(os.listdir(bin_dir))
    tagged = {}
    for name in entries:
        full = bin_dir + "/" + name
        if not os.path.isfile(full):
            continue
        tags = set(identify.tags_from_filename(name))
        if not tags:
            shebang = identify.parse_shebang_from_file(full)
            if shebang:
                tags |= set(identify.tags_from_interpreter(shebang[0]))
        tagged[name] = sorted(tags)
        if "python" in tags:
            logging.info("detected python file: %s", name)
    with open(manifest_path, "w", encoding="utf-8") as fh:
        fh.write(json.dumps(tagged, sort_keys=True))
    return tagged
""",
            "run",
            ["repo/scripts", "repo/tags.json"],
            {
                "label": "python_and_yaml",
                "files": {
                    "repo/scripts/deploy": "#!/usr/bin/env python3\nprint('ok')\n",
                    "repo/scripts/config.yaml": "env: prod\n",
                },
                "env": {},
            },
            {
                "label": "bash_and_markdown",
                "files": {
                    "repo/scripts/deploy": "#!/usr/bin/env bash\necho ok\n",
                    "repo/scripts/README.md": "# Guide\n",
                },
                "env": {},
            },
            ["fs-io", "logging"],
        )

    # 6. PyCQA/pycodestyle
    pkg = _load_pkg("PyCQA__pycodestyle", ".", single_file="pycodestyle.py")
    if pkg:
        _add_pair(
            "PyCQA__pycodestyle",
            "pep8_lint_gate",
            pkg,
            "lint_pep8.py",
            """import json
import logging
import os
import pycodestyle

class _CaptureReport(pycodestyle.BaseReport):
    def __init__(self, options):
        super().__init__(options)
        self.findings = []

    def error(self, line_number, offset, text, check):
        code = super().error(line_number, offset, text, check)
        if code:
            self.findings.append({"line": line_number, "col": offset + 1, "code": code})
        return code

def run(src_path, out_path):
    max_len = int(os.getenv("PEP8_MAX_LINE", "79"))
    with open(src_path, "r", encoding="utf-8") as fh:
        lines = fh.readlines()
    guide = pycodestyle.StyleGuide(quiet=True, config_file="pep8.cfg", max_line_length=max_len, reporter=_CaptureReport)
    checker = pycodestyle.Checker(filename=src_path, lines=lines, options=guide.options, report=guide.options.report)
    count = checker.check_all()
    if count > 0:
        logging.warning("pycodestyle found %d issues in %s", count, src_path)
    result = {"file": src_path, "max_line": max_len, "count": count, "findings": guide.options.report.findings}
    with open(out_path, "w", encoding="utf-8") as fh:
        fh.write(json.dumps(result, sort_keys=True))
    return result
""",
            "run",
            ["src/module.py", "src/pep8_report.json"],
            {
                "label": "violations_present",
                "files": {"src/module.py": "def add(a,b):\n    x=a+b   \n    return x\n"},
                "env": {"PEP8_MAX_LINE": "79"},
            },
            {
                "label": "clean_pep8",
                "files": {"src/module.py": "def add(a, b):\n    x = a + b\n    return x\n"},
                "env": {"PEP8_MAX_LINE": "79"},
            },
            ["fs-io", "env-io", "logging"],
        )

    # 7. PyCQA/pyflakes
    pkg = _load_pkg("PyCQA__pyflakes", "pyflakes", exclude_substrings=("__main__", "tests/", "test/"))
    if pkg:
        _add_pair(
            "PyCQA__pyflakes",
            "ast_static_check",
            pkg,
            "flakes_runner.py",
            """import ast
import json
import logging
import os
from pyflakes.checker import Checker

def run(src_dir, report_path):
    files = sorted(f for f in os.listdir(src_dir) if f.endswith(".py"))
    diagnostics = []
    for fname in files:
        full = src_dir + "/" + fname
        with open(full, "r", encoding="utf-8") as fh:
            code = fh.read()
        tree = ast.parse(code, filename=full)
        w = Checker(tree, filename=full)
        for msg in sorted(w.messages, key=lambda m: (m.lineno, m.col)):
            diagnostics.append({"file": fname, "line": msg.lineno, "msg": str(msg)})
    if diagnostics:
        logging.warning("pyflakes reported %d issues", len(diagnostics))
    else:
        logging.info("pyflakes clean across %d files", len(files))
    out = {"files_checked": files, "issue_count": len(diagnostics), "issues": diagnostics}
    with open(report_path, "w", encoding="utf-8") as fh:
        fh.write(json.dumps(out, sort_keys=True))
    return out
""",
            "run",
            ["pkg", "pkg/flakes.json"],
            {
                "label": "unused_and_undefined",
                "files": {
                    "pkg/a.py": "import os\n\ndef compute(x):\n    return x + missing_var\n",
                    "pkg/b.py": "def ok(n):\n    return n * 2\n",
                },
                "env": {},
            },
            {
                "label": "clean_package",
                "files": {
                    "pkg/a.py": "def compute(x):\n    return x + 1\n",
                    "pkg/b.py": "def ok(n):\n    return n * 2\n",
                },
                "env": {},
            },
            ["fs-io", "logging"],
        )
        # Also a subprocess git-diff + pyflakes CI gate pair!
        _add_pair(
            "PyCQA__pyflakes",
            "git_diff_pyflakes_gate",
            pkg,
            "ci_flakes.py",
            """import ast
import logging
import subprocess
from pyflakes.checker import Checker

def run():
    cp = subprocess.run(["git", "status", "--porcelain"], capture_output=True, text=True, check=True)
    changed = []
    for line in cp.stdout.splitlines():
        if len(line) >= 4:
            path = line[3:].strip()
            if path.endswith(".py"):
                changed.append(path)
    issues = []
    for path in sorted(changed):
        with open(path, "r", encoding="utf-8") as fh:
            code = fh.read()
        w = Checker(ast.parse(code, filename=path), filename=path)
        for m in w.messages:
            issues.append(f"{path}:{m.lineno}:{type(m).__name__}")
    passed = len(issues) == 0
    if not passed:
        logging.error("CI gate failed with %d pyflakes issues", len(issues))
    return {"changed": sorted(changed), "passed": passed, "issues": sorted(issues)}
""",
            "run",
            [],
            {
                "label": "dirty_file_fails_gate",
                "files": {"app.py": "def greet(name):\n    return 'hi ' + name\n"},
                "post_git_writes": {"app.py": "import sys\ndef greet(name):\n    return 'hi ' + unknown_name\n"},
                "init_git": True,
                "env": {},
            },
            {
                "label": "clean_worktree_passes",
                "files": {"app.py": "def greet(name):\n    return 'hi ' + name\n"},
                "init_git": True,
                "env": {},
            },
            ["fs-io", "shell-exec", "logging"],
        )

    # 8. PyCQA/mccabe
    pkg = _load_pkg("PyCQA__mccabe", ".", single_file="mccabe.py")
    if pkg:
        _add_pair(
            "PyCQA__mccabe",
            "complexity_budget",
            pkg,
            "cc_gate.py",
            """import ast
import json
import logging
import os
import mccabe

def run(src_path, out_path):
    limit = int(os.getenv("MAX_CC", "4"))
    with open(src_path, "r", encoding="utf-8") as fh:
        tree = ast.parse(fh.read(), filename=src_path)
    visitor = mccabe.PathGraphingAstVisitor()
    visitor.preorder(tree, visitor)
    scores = []
    over = []
    for graph in visitor.graphs.values():
        cc = graph.complexity()
        scores.append({"entity": graph.entity, "cc": cc})
        if cc > limit:
            over.append(graph.entity)
            logging.warning("complexity %d > %d in %s", cc, limit, graph.entity)
    scores.sort(key=lambda x: x["entity"])
    res = {"limit": limit, "passed": len(over) == 0, "over": sorted(over), "scores": scores}
    with open(out_path, "w", encoding="utf-8") as fh:
        fh.write(json.dumps(res, sort_keys=True))
    return res
""",
            "run",
            ["src/router.py", "src/cc.json"],
            {
                "label": "strict_limit_fails",
                "files": {
                    "src/router.py": (
                        "def route(method, path, auth, beta):\n"
                        "    if method == 'GET':\n"
                        "        if path == '/health':\n"
                        "            return 200\n"
                        "        elif auth and beta:\n"
                        "            return 201\n"
                        "        elif auth:\n"
                        "            return 202\n"
                        "        return 401\n"
                        "    if method == 'POST' and auth:\n"
                        "        return 204\n"
                        "    return 405\n"
                    )
                },
                "env": {"MAX_CC": "4"},
            },
            {
                "label": "relaxed_limit_passes",
                "files": {
                    "src/router.py": (
                        "def route(method, path, auth, beta):\n"
                        "    if method == 'GET':\n"
                        "        if path == '/health':\n"
                        "            return 200\n"
                        "        elif auth and beta:\n"
                        "            return 201\n"
                        "        elif auth:\n"
                        "            return 202\n"
                        "        return 401\n"
                        "    if method == 'POST' and auth:\n"
                        "        return 204\n"
                        "    return 405\n"
                    )
                },
                "env": {"MAX_CC": "10"},
            },
            ["fs-io", "env-io", "logging"],
        )

    # 9. jendrikseipp/vulture
    pkg = _load_pkg("jendrikseipp__vulture", "vulture", exclude_substrings=("__main__", "tests/", "whitelists/"))
    if pkg:
        _add_pair(
            "jendrikseipp__vulture",
            "dead_code_audit",
            pkg,
            "vulture_audit.py",
            """import json
import logging
import os
from vulture.core import Vulture

def run(src_dir, report_path):
    min_conf = int(os.getenv("MIN_CONFIDENCE", "60"))
    v = Vulture(verbose=False)
    for fname in sorted(os.listdir(src_dir)):
        if not fname.endswith(".py"):
            continue
        full = src_dir + "/" + fname
        with open(full, "r", encoding="utf-8") as fh:
            v.scan(fh.read(), filename=full)
    unused = [
        {"name": item.name, "typ": item.typ, "confidence": item.confidence}
        for item in v.get_unused_code(min_confidence=min_conf)
    ]
    unused.sort(key=lambda x: (x["typ"], x["name"]))
    if unused:
        logging.warning("found %d unused definitions", len(unused))
    res = {"min_confidence": min_conf, "unused_count": len(unused), "unused": unused}
    with open(report_path, "w", encoding="utf-8") as fh:
        fh.write(json.dumps(res, sort_keys=True))
    return res
""",
            "run",
            ["src", "src/dead_code.json"],
            {
                "label": "dead_helper_and_unreachable",
                "files": {
                    "src/worker.py": (
                        "def active(x):\n"
                        "    return x + 1\n"
                        "    dead_var = 99\n\n"
                        "def legacy_helper(y):\n"
                        "    return y * 2\n\n"
                        "RESULT = active(5)\n"
                    )
                },
                "env": {"MIN_CONFIDENCE": "60"},
            },
            {
                "label": "high_confidence_filter",
                "files": {
                    "src/worker.py": (
                        "def active(x):\n"
                        "    return x + 1\n\n"
                        "RESULT = active(5)\n"
                    )
                },
                "env": {"MIN_CONFIDENCE": "60"},
            },
            ["fs-io", "env-io", "logging"],
        )

    # 10. cpburnz/python-pathspec
    pkg = _load_pkg(
        "cpburnz__python-pathspec",
        "pathspec",
        exclude_substrings=("tests/", "benchmark"),
    )
    if pkg:
        _add_pair(
            "cpburnz__python-pathspec",
            "gitignore_tree_filter",
            pkg,
            "ignore_scan.py",
            """import json
import logging
import os
from pathspec import PathSpec

def _walk(root, prefix=""):
    found = []
    for name in sorted(os.listdir(root)):
        full = root + "/" + name
        rel = (prefix + "/" + name) if prefix else name
        if os.path.isdir(full):
            found.extend(_walk(full, rel))
        else:
            found.append(rel)
    return found

def run(repo_dir, out_path):
    gi = repo_dir + "/.gitignore"
    if os.path.exists(gi):
        with open(gi, "r", encoding="utf-8") as fh:
            lines = fh.read().splitlines()
        spec = PathSpec.from_lines("gitignore", lines)
        logging.info("loaded %d gitignore rules", len(lines))
    else:
        spec = PathSpec.from_lines("gitignore", [])
        logging.warning("no .gitignore in %s", repo_dir)
    all_files = _walk(repo_dir)
    ignored = [f for f in all_files if f != ".gitignore" and spec.match_file(f)]
    kept = [f for f in all_files if f != ".gitignore" and not spec.match_file(f)]
    res = {"kept": kept, "ignored": ignored}
    with open(out_path, "w", encoding="utf-8") as fh:
        fh.write(json.dumps(res, sort_keys=True))
    return res
""",
            "run",
            ["repo", "scan_result.json"],
            {
                "label": "gitignore_excludes_build_logs",
                "files": {
                    "repo/.gitignore": "*.log\nbuild/\n!build/keep.txt\n",
                    "repo/app.py": "x = 1\n",
                    "repo/debug.log": "err\n",
                    "repo/build/out.bin": "bin",
                    "repo/build/keep.txt": "keep",
                },
                "env": {},
            },
            {
                "label": "no_gitignore_keeps_all",
                "files": {
                    "repo/app.py": "x = 1\n",
                    "repo/debug.log": "err\n",
                    "repo/build/out.bin": "bin",
                    "repo/build/keep.txt": "keep",
                },
                "env": {},
            },
            ["fs-io", "logging"],
        )

    # 11. hukkin/tomli
    pkg = _load_pkg("hukkin__tomli", "src/tomli")
    if pkg:
        _add_pair(
            "hukkin__tomli",
            "pyproject_reader",
            pkg,
            "read_pyproject.py",
            """import json
import logging
import os
import tomli

def run(toml_path, out_path):
    try:
        with open(toml_path, "rb") as fh:
            doc = tomli.load(fh)
    except tomli.TOMLDecodeError as exc:
        logging.error("invalid toml %s: %s", toml_path, exc)
        res = {"ok": False, "error": str(exc)}
        with open(out_path, "w", encoding="utf-8") as fh:
            fh.write(json.dumps(res, sort_keys=True))
        return res
    proj = doc.get("project", {})
    extra = os.getenv("INSTALL_EXTRA", "")
    deps = list(proj.get("dependencies", []))
    if extra:
        deps.extend(proj.get("optional-dependencies", {}).get(extra, []))
    res = {"ok": True, "name": proj.get("name"), "version": proj.get("version"), "deps": deps}
    with open(out_path, "w", encoding="utf-8") as fh:
        fh.write(json.dumps(res, sort_keys=True))
    return res
""",
            "run",
            ["pkg/pyproject.toml", "pkg/resolved_deps.json"],
            {
                "label": "valid_with_dev_extra",
                "files": {
                    "pkg/pyproject.toml": (
                        '[project]\nname = "acme-cli"\nversion = "1.4.0"\n'
                        'dependencies = ["click>=8.0", "httpx>=0.27"]\n'
                        '[project.optional-dependencies]\ndev = ["pytest>=8.0", "ruff>=0.4"]\n'
                    )
                },
                "env": {"INSTALL_EXTRA": "dev"},
            },
            {
                "label": "corrupt_toml_error",
                "files": {"pkg/pyproject.toml": '[project\nname = "broken\n'},
                "env": {},
            },
            ["fs-io", "env-io", "logging"],
        )

    # 12. hukkin/tomli-w
    pkg = _load_pkg("hukkin__tomli-w", "src/tomli_w")
    if pkg:
        _add_pair(
            "hukkin__tomli-w",
            "emit_release_manifest",
            pkg,
            "write_release.py",
            """from datetime import datetime, timezone
import json
import os
import tomli_w

def run(meta_path, out_toml):
    with open(meta_path, "r", encoding="utf-8") as fh:
        meta = json.load(fh)
    channel = os.getenv("RELEASE_CHANNEL", "stable")
    now_iso = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    doc = {
        "release": {
            "service": meta["service"],
            "version": meta["version"] + ("-rc1" if channel == "canary" else ""),
            "channel": channel,
            "timestamp": now_iso,
        },
        "limits": {
            "replicas": 2 if channel == "canary" else meta.get("replicas", 6),
            "canary": channel == "canary",
        },
    }
    with open(out_toml, "wb") as fh:
        tomli_w.dump(doc, fh)
    return {"channel": channel, "version": doc["release"]["version"], "replicas": doc["limits"]["replicas"]}
""",
            "run",
            ["release/meta.json", "release/manifest.toml"],
            {
                "label": "canary_channel",
                "files": {"release/meta.json": json.dumps({"service": "edge-gw", "version": "2.3.0", "replicas": 8})},
                "env": {"RELEASE_CHANNEL": "canary"},
            },
            {
                "label": "stable_channel",
                "files": {"release/meta.json": json.dumps({"service": "edge-gw", "version": "2.3.0", "replicas": 8})},
                "env": {"RELEASE_CHANNEL": "stable"},
            },
            ["fs-io", "env-io", "time-io"],
        )

    # 13. uiri/toml
    pkg = _load_pkg("uiri__toml", "toml")
    if pkg:
        _add_pair(
            "uiri__toml",
            "patch_config_toml",
            pkg,
            "patch_toml.py",
            """import os
import toml

def run(in_path, out_path):
    cfg = toml.load(in_path)
    override_host = os.getenv("DB_HOST")
    if override_host:
        cfg.setdefault("database", {})["host"] = override_host
    override_pool = os.getenv("DB_POOL")
    if override_pool:
        cfg.setdefault("database", {})["pool"] = int(override_pool)
    with open(out_path, "w", encoding="utf-8") as fh:
        toml.dump(cfg, fh)
    return {"host": cfg["database"]["host"], "pool": cfg["database"]["pool"]}
""",
            "run",
            ["conf/app.toml", "conf/app_patched.toml"],
            {
                "label": "env_overrides_applied",
                "files": {"conf/app.toml": '[database]\nhost = "127.0.0.1"\npool = 4\n'},
                "env": {"DB_HOST": "rds.prod.internal", "DB_POOL": "32"},
            },
            {
                "label": "defaults_preserved",
                "files": {"conf/app.toml": '[database]\nhost = "127.0.0.1"\npool = 4\n'},
                "env": {},
            },
            ["fs-io", "env-io"],
        )
        _add_single(
            "uiri__toml",
            "merge_conf_d",
            pkg,
            "merge_toml_dir.py",
            """import os
import toml

def run(conf_dir, out_path):
    merged = {}
    for name in sorted(os.listdir(conf_dir)):
        if not name.endswith(".toml"):
            continue
        part = toml.load(conf_dir + "/" + name)
        for sec, vals in part.items():
            if isinstance(vals, dict) and isinstance(merged.get(sec), dict):
                merged[sec].update(vals)
            else:
                merged[sec] = vals
    with open(out_path, "w", encoding="utf-8") as fh:
        toml.dump(merged, fh)
    return {"sections": sorted(merged.keys()), "merged": merged}
""",
            "run",
            ["conf.d", "merged.toml"],
            {
                "label": "two_layer_conf_d",
                "files": {
                    "conf.d/01-base.toml": '[server]\nport = 8080\nworkers = 2\n',
                    "conf.d/02-prod.toml": '[server]\nworkers = 8\n[metrics]\nenabled = true\n',
                },
                "env": {},
            },
            ["fs-io"],
        )

    # 14. sdispater/tomlkit
    pkg = _load_pkg("sdispater__tomlkit", "tomlkit", max_files=40)
    if pkg:
        _add_pair(
            "sdispater__tomlkit",
            "bump_version_preserve_comments",
            pkg,
            "bump_toml.py",
            """import os
import tomlkit

def run(toml_path):
    with open(toml_path, "r", encoding="utf-8") as fh:
        doc = tomlkit.parse(fh.read())
    kind = os.getenv("BUMP_KIND", "patch")
    ver = str(doc["project"]["version"])
    major, minor, patch = [int(x) for x in ver.split(".")]
    if kind == "minor":
        new_ver = f"{major}.{minor + 1}.0"
    elif kind == "major":
        new_ver = f"{major + 1}.0.0"
    else:
        new_ver = f"{major}.{minor}.{patch + 1}"
    doc["project"]["version"] = new_ver
    rendered = tomlkit.dumps(doc)
    with open(toml_path, "w", encoding="utf-8") as fh:
        fh.write(rendered)
    return {"old": ver, "new": new_ver, "has_comment": "# keep me" in rendered}
""",
            "run",
            ["pyproject.toml"],
            {
                "label": "bump_minor",
                "files": {"pyproject.toml": '# keep me\n[project]\nname = "demo"\nversion = "1.2.3"\n'},
                "env": {"BUMP_KIND": "minor"},
            },
            {
                "label": "bump_patch",
                "files": {"pyproject.toml": '# keep me\n[project]\nname = "demo"\nversion = "1.2.3"\n'},
                "env": {"BUMP_KIND": "patch"},
            },
            ["fs-io", "env-io"],
        )

    # 15. pypa/packaging
    pkg = _load_pkg(
        "pypa__packaging",
        "src/packaging",
        exclude_substrings=("metadata.py", "tests/"),
    )
    if pkg:
        _add_pair(
            "pypa__packaging",
            "audit_requirements_lock",
            pkg,
            "req_audit.py",
            """import json
import logging
import os
from packaging.requirements import Requirement
from packaging.version import Version

def run(req_path, installed_path, report_path):
    with open(req_path, "r", encoding="utf-8") as fh:
        raw_lines = [l.strip() for l in fh.read().splitlines() if l.strip() and not l.strip().startswith("#")]
    with open(installed_path, "r", encoding="utf-8") as fh:
        installed = json.load(fh)
    target_sys = os.getenv("TARGET_SYS_PLATFORM", "linux")
    env_ctx = {"sys_platform": target_sys, "python_version": "3.11", "os_name": "posix"}
    violations = []
    checked = []
    for line in raw_lines:
        req = Requirement(line)
        if req.marker and not req.marker.evaluate(env_ctx):
            continue
        cur = installed.get(req.name.lower())
        ok = cur is not None and req.specifier.contains(Version(cur), prereleases=False)
        checked.append(req.name)
        if not ok:
            violations.append({"package": req.name, "spec": str(req.specifier), "installed": cur})
            logging.warning("requirement unsatisfied: %s (installed=%s)", req, cur)
    res = {"platform": target_sys, "checked": sorted(checked), "ok": len(violations) == 0, "violations": violations}
    with open(report_path, "w", encoding="utf-8") as fh:
        fh.write(json.dumps(res, sort_keys=True))
    return res
""",
            "run",
            ["reqs/requirements.txt", "reqs/installed.json", "reqs/audit.json"],
            {
                "label": "linux_outdated_fails",
                "files": {
                    "reqs/requirements.txt": "requests>=2.31,<3.0\npyyaml>=6.0\ncolorama>=0.4; sys_platform == 'win32'\n",
                    "reqs/installed.json": json.dumps({"requests": "2.28.1", "pyyaml": "6.0.1"}),
                },
                "env": {"TARGET_SYS_PLATFORM": "linux"},
            },
            {
                "label": "linux_all_satisfied",
                "files": {
                    "reqs/requirements.txt": "requests>=2.31,<3.0\npyyaml>=6.0\ncolorama>=0.4; sys_platform == 'win32'\n",
                    "reqs/installed.json": json.dumps({"requests": "2.32.3", "pyyaml": "6.0.2"}),
                },
                "env": {"TARGET_SYS_PLATFORM": "linux"},
            },
            ["fs-io", "env-io", "logging"],
        )

    # 16. yaml/pyyaml
    pkg = _load_pkg("yaml__pyyaml", "lib/yaml", exclude_substrings=("cyaml", "tests/"))
    if pkg:
        _add_pair(
            "yaml__pyyaml",
            "k8s_overlay_merge",
            pkg,
            "yaml_overlay.py",
            """import logging
import os
import yaml

def run(base_path, overlay_path, out_path):
    with open(base_path, "r", encoding="utf-8") as fh:
        doc = yaml.safe_load(fh)
    if os.path.exists(overlay_path):
        with open(overlay_path, "r", encoding="utf-8") as fh:
            ov = yaml.safe_load(fh) or {}
        for k, v in ov.items():
            if isinstance(v, dict) and isinstance(doc.get(k), dict):
                doc[k].update(v)
            else:
                doc[k] = v
        logging.info("applied overlay %s", overlay_path)
    tag = os.getenv("IMAGE_TAG")
    if tag:
        doc["spec"]["image"] = doc["spec"]["image"].split(":")[0] + ":" + tag
    with open(out_path, "w", encoding="utf-8") as fh:
        fh.write(yaml.safe_dump(doc, sort_keys=True))
    return {"replicas": doc["spec"]["replicas"], "image": doc["spec"]["image"]}
""",
            "run",
            ["k8s/base.yaml", "k8s/prod-overlay.yaml", "k8s/rendered.yaml"],
            {
                "label": "prod_overlay_and_tag",
                "files": {
                    "k8s/base.yaml": "apiVersion: v1\nspec:\n  replicas: 1\n  image: acme/api:latest\n",
                    "k8s/prod-overlay.yaml": "spec:\n  replicas: 5\n",
                },
                "env": {"IMAGE_TAG": "v3.2.1"},
            },
            {
                "label": "base_only_no_tag",
                "files": {
                    "k8s/base.yaml": "apiVersion: v1\nspec:\n  replicas: 1\n  image: acme/api:latest\n",
                },
                "env": {},
            },
            ["fs-io", "env-io", "logging"],
        )
        _add_single(
            "yaml__pyyaml",
            "scan_yaml_secrets",
            pkg,
            "secret_scan.py",
            """import json
import logging
import os
import yaml

def run(manifest_dir, out_path):
    alerts = []
    for name in sorted(os.listdir(manifest_dir)):
        if not name.endswith((".yaml", ".yml")):
            continue
        with open(manifest_dir + "/" + name, "r", encoding="utf-8") as fh:
            data = yaml.safe_load(fh) or {}
        for k, v in (data.get("env") or {}).items():
            if any(tok in k.upper() for tok in ("SECRET", "TOKEN", "PASSWORD")) and not str(v).startswith("${"):
                alerts.append({"file": name, "key": k})
                logging.warning("plaintext secret %s in %s", k, name)
    with open(out_path, "w", encoding="utf-8") as fh:
        fh.write(json.dumps({"alerts": alerts}, sort_keys=True))
    return {"count": len(alerts), "alerts": alerts}
""",
            "run",
            ["manifests", "alerts.json"],
            {
                "label": "detect_plaintext_secrets",
                "files": {
                    "manifests/auth.yaml": "env:\n  API_TOKEN: hardcoded-991\n  DB_PASSWORD: ${VAULT_PW}\n",
                    "manifests/web.yaml": "env:\n  PORT: '8080'\n",
                },
                "env": {},
            },
            ["fs-io", "logging"],
        )

    # 17. Python-Markdown/markdown
    pkg = _load_pkg("Python-Markdown__markdown", "markdown", max_files=40)
    if pkg:
        _add_pair(
            "Python-Markdown__markdown",
            "static_docs_builder",
            pkg,
            "build_docs.py",
            """import logging
import os
import markdown

def run(docs_dir, out_dir):
    built = []
    for fname in sorted(os.listdir(docs_dir)):
        if not fname.endswith(".md"):
            continue
        with open(docs_dir + "/" + fname, "r", encoding="utf-8") as fh:
            raw = fh.read()
        if raw.startswith("DRAFT:"):
            logging.info("skipping draft %s", fname)
            continue
        html = markdown.markdown(raw, extensions=["tables", "fenced_code"])
        out_name = fname[:-3] + ".html"
        with open(out_dir + "/" + out_name, "w", encoding="utf-8") as fh:
            fh.write(html)
        built.append({"file": out_name, "len": len(html)})
    return {"built_count": len(built), "pages": built}
""",
            "run",
            ["docs", "site"],
            {
                "label": "two_published_docs",
                "files": {
                    "docs/01-intro.md": "# Welcome\n\nUse `pip install`.\n\n| A | B |\n|---|---|\n| 1 | 2 |\n",
                    "docs/02-draft.md": "DRAFT: wip\n",
                    "site/.keep": "",
                },
                "env": {},
            },
            {
                "label": "all_drafts_skipped",
                "files": {
                    "docs/01-intro.md": "DRAFT: pending review\n",
                    "site/.keep": "",
                },
                "env": {},
            },
            ["fs-io", "logging"],
        )

    # 18. executablebooks/markdown-it-py
    pkg = _load_pkg("executablebooks__markdown-it-py", "markdown_it", max_files=70, exclude_substrings=("cli/", "__main__", "tests/"))
    if pkg:
        _add_pair(
            "executablebooks__markdown-it-py",
            "extract_toc_and_render",
            pkg,
            "md_toc.py",
            """import json
import os
from markdown_it import MarkdownIt

def run(md_path, html_path, toc_path):
    with open(md_path, "r", encoding="utf-8") as fh:
        text = fh.read()
    md = MarkdownIt("commonmark")
    tokens = md.parse(text)
    headings = []
    for i, tok in enumerate(tokens):
        if tok.type == "heading_open" and i + 1 < len(tokens):
            headings.append({"tag": tok.tag, "title": tokens[i + 1].content})
    html = md.render(text)
    prefix = os.getenv("SITE_PREFIX", "")
    with open(html_path, "w", encoding="utf-8") as fh:
        fh.write(html)
    with open(toc_path, "w", encoding="utf-8") as fh:
        fh.write(json.dumps({"prefix": prefix, "headings": headings}, sort_keys=True))
    return {"heading_count": len(headings), "headings": headings, "prefix": prefix}
""",
            "run",
            ["content/guide.md", "content/guide.html", "content/toc.json"],
            {
                "label": "multi_section_guide",
                "files": {"content/guide.md": "# Setup\n\n## Deploy\n"},
                "env": {"SITE_PREFIX": "/docs/v2"},
            },
            {
                "label": "minimal_note",
                "files": {"content/guide.md": "Plain note.\n"},
                "env": {},
            },
            ["fs-io", "env-io"],
        )

    # 19. bottlepy/bottle
    pkg = _load_pkg("bottlepy__bottle", ".", single_file="bottle.py")
    if pkg:
        _add_pair(
            "bottlepy__bottle",
            "simple_template_render",
            pkg,
            "tpl_render.py",
            """import json
import logging
import os
from bottle import SimpleTemplate

def run(custom_tpl, default_tpl, ctx_path, out_path):
    if os.path.exists(custom_tpl):
        tpl_path = custom_tpl
    else:
        tpl_path = default_tpl
        logging.info("using default template %s", default_tpl)
    with open(tpl_path, "r", encoding="utf-8") as fh:
        tpl_src = fh.read()
    with open(ctx_path, "r", encoding="utf-8") as fh:
        ctx = json.load(fh)
    rendered = SimpleTemplate(tpl_src).render(**ctx)
    with open(out_path, "w", encoding="utf-8") as fh:
        fh.write(rendered)
    return {"template": tpl_path, "output": rendered.strip()}
""",
            "run",
            ["tpl/custom.tpl", "tpl/default.tpl", "tpl/ctx.json", "tpl/out.html"],
            {
                "label": "custom_template_hit",
                "files": {
                    "tpl/custom.tpl": "<section><h1>{{title}}</h1><ul>% for x in items:\n<li>{{x}}</li>% end\n</ul></section>",
                    "tpl/default.tpl": "<p>{{title}}</p>",
                    "tpl/ctx.json": json.dumps({"title": "Alerts", "items": ["cpu", "disk"]}),
                },
                "env": {},
            },
            {
                "label": "default_template_fallback",
                "files": {
                    "tpl/default.tpl": "<p>{{title}} ({{len(items)}})</p>",
                    "tpl/ctx.json": json.dumps({"title": "Alerts", "items": ["cpu", "disk"]}),
                },
                "env": {},
            },
            ["fs-io", "logging"],
        )

    # 20. platformdirs/platformdirs
    pkg = _load_pkg("platformdirs__platformdirs", "src/platformdirs", exclude_substrings=("__main__", "tests/"))
    if pkg:
        pkg["platformdirs/version.py"] = '__version__ = "4.3.6"\n__version_tuple__ = (4, 3, 6)\n'
        _add_pair(
            "platformdirs__platformdirs",
            "xdg_config_bootstrap",
            pkg,
            "xdg_boot.py",
            """import json
import logging
import os
from platformdirs import PlatformDirs

def run(app_name):
    dirs = PlatformDirs(app_name, appauthor="acme")
    cfg_dir = dirs.user_config_dir
    key = cfg_dir.strip("/").replace("/", "_")
    cfg_file = "cfg/" + key + ".json"
    if os.path.exists(cfg_file):
        with open(cfg_file, "r", encoding="utf-8") as fh:
            cfg = json.load(fh)
        source = "disk"
    else:
        cfg = {"theme": "system", "telemetry": False}
        logging.info("seeding default config at %s", cfg_file)
        with open(cfg_file, "w", encoding="utf-8") as fh:
            fh.write(json.dumps(cfg, sort_keys=True))
        source = "seeded"
    return {"source": source, "cfg_dir": cfg_dir, "cfg": cfg}
""",
            "run",
            ["mytool"],
            {
                "label": "xdg_custom_existing",
                "files": {"cfg/xdg_cfg_mytool.json": json.dumps({"theme": "dark", "telemetry": True})},
                "env": {"XDG_CONFIG_HOME": "/xdg_cfg"},
            },
            {
                "label": "xdg_custom_seed_new",
                "files": {"cfg/.keep": ""},
                "env": {"XDG_CONFIG_HOME": "/xdg_cfg"},
            },
            ["fs-io", "env-io", "logging"],
        )

    # 21. jazzband/dj-database-url
    pkg = _load_pkg("jazzband__dj-database-url", "dj_database_url")
    if pkg:
        _add_pair(
            "jazzband__dj-database-url",
            "db_url_resolver",
            pkg,
            "db_cfg.py",
            """import json
import logging
import os
import dj_database_url

def run(fallback_file, out_path):
    env_url = os.getenv("DATABASE_URL")
    if env_url:
        parsed = dj_database_url.config(conn_max_age=600)
        origin = "env"
    elif os.path.exists(fallback_file):
        with open(fallback_file, "r", encoding="utf-8") as fh:
            file_url = fh.read().strip()
        parsed = dj_database_url.parse(file_url, conn_max_age=60)
        origin = "file"
    else:
        logging.warning("no DATABASE_URL in env or %s; using sqlite", fallback_file)
        parsed = dj_database_url.parse("sqlite:///local.sqlite3")
        origin = "default"
    res = {"origin": origin, "engine": parsed["ENGINE"], "name": parsed["NAME"], "host": parsed.get("HOST", "")}
    with open(out_path, "w", encoding="utf-8") as fh:
        fh.write(json.dumps(res, sort_keys=True))
    return res
""",
            "run",
            ["secrets/db_url.txt", "secrets/db_resolved.json"],
            {
                "label": "env_postgres",
                "files": {"secrets/.keep": ""},
                "env": {"DATABASE_URL": "postgres://svc:pw@db.internal:5432/orders"},
            },
            {
                "label": "file_fallback_mysql",
                "files": {"secrets/db_url.txt": "mysql://reader:pw@mysql.local:3306/analytics\n"},
                "env": {},
            },
            ["fs-io", "env-io", "logging"],
        )

    # 22. docopt/docopt
    pkg = _load_pkg("docopt__docopt", ".", single_file="docopt.py")
    if pkg:
        _add_pair(
            "docopt__docopt",
            "cli_kv_tool",
            pkg,
            "kv_cli.py",
            """import json
import os
from docopt import docopt

USAGE = '''KV Store CLI.

Usage:
  kv set <key> <value> [--file=<path>]
  kv get <key> [--file=<path>]

Options:
  --file=<path>  Store path [default: store/kv.json].
'''

def run(argv):
    args = docopt(USAGE, argv=argv)
    path = args["--file"]
    if os.path.exists(path):
        with open(path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
    else:
        data = {}
    if args["set"]:
        data[args["<key>"]] = args["<value>"]
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(json.dumps(data, sort_keys=True))
        return {"op": "set", "size": len(data), "value": data[args["<key>"]]}
    return {"op": "get", "found": args["<key>"] in data, "value": data.get(args["<key>"])}
""",
            "run",
            [["get", "region", "--file=store/kv.json"]],
            {
                "label": "key_present",
                "files": {"store/kv.json": json.dumps({"region": "us-west-2", "tier": "gold"})},
                "env": {},
            },
            {
                "label": "store_missing",
                "files": {"store/.keep": ""},
                "env": {},
            },
            ["fs-io"],
        )
        _add_single(
            "docopt__docopt",
            "cli_kv_set_mutation",
            pkg,
            "kv_cli_set.py",
            """import json
import os
from docopt import docopt

USAGE = '''KV Store CLI.

Usage:
  kv set <key> <value> [--file=<path>]
'''

def run(argv):
    args = docopt(USAGE, argv=argv)
    path = args["--file"] or "store/kv.json"
    with open(path, "r", encoding="utf-8") as fh:
        data = json.load(fh)
    data[args["<key>"]] = args["<value>"]
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(json.dumps(data, sort_keys=True))
    return {"keys": sorted(data.keys()), "updated": data[args["<key>"]]}
""",
            "run",
            [["set", "release", "2026.11", "--file=store/kv.json"]],
            {
                "label": "mutate_existing_kv",
                "files": {"store/kv.json": json.dumps({"env": "prod"})},
                "env": {},
            },
            ["fs-io"],
        )

    # 23. simonw/sqlite-utils (REAL SQLite :memory: + FS + Env + Logging!)
    pkg = _load_pkg(
        "simonw__sqlite-utils",
        "sqlite_utils",
        exclude_substrings=("cli.py", "__main__", "plugins.py", "hookspecs.py", "tests/"),
    )
    if pkg:
        # Patch sqlite_utils/__init__.py if it imports hookspecs/plugins? Let's keep hookspecs if small or include all except cli/__main__
        pkg_full = _load_pkg(
            "simonw__sqlite-utils",
            "sqlite_utils",
            exclude_substrings=("cli.py", "__main__", "tests/"),
        )
        fts4_dir = cache_dir / "simonw__sqlite-fts4" / "sqlite_fts4"
        if pkg_full and fts4_dir.is_dir():
            for fp in sorted(fts4_dir.rglob("*.py")):
                pkg_full[fp.relative_to(fts4_dir.parent).as_posix()] = fp.read_text(encoding="utf-8", errors="ignore")
        if pkg_full:
            _add_pair(
                "simonw__sqlite-utils",
                "sqlite_ingest_and_aggregate",
                pkg_full,
                "sql_etl.py",
                """import json
import logging
import os
import sqlite3
from sqlite_utils import Database

def run(orders_path, out_path):
    with open(orders_path, "r", encoding="utf-8") as fh:
        rows = json.load(fh)
    min_total = float(os.getenv("MIN_ORDER_TOTAL", "50.0"))
    db = Database(sqlite3.connect(":memory:"))
    db["orders"].insert_all(rows, pk="id")
    high_val = list(
        db.query(
            "SELECT customer, COUNT(*) AS cnt, SUM(total) AS spend "
            "FROM orders WHERE total >= ? GROUP BY customer ORDER BY spend DESC",
            [min_total],
        )
    )
    logging.info("sqlite aggregated %d customers above %.1f", len(high_val), min_total)
    res = {"threshold": min_total, "row_count": db["orders"].count, "customers": high_val}
    with open(out_path, "w", encoding="utf-8") as fh:
        fh.write(json.dumps(res, sort_keys=True))
    return res
""",
                "run",
                ["etl/orders.json", "etl/summary.json"],
                {
                    "label": "threshold_50_two_customers",
                    "files": {
                        "etl/orders.json": json.dumps([
                            {"id": 1, "customer": "alice", "total": 45.0},
                            {"id": 2, "customer": "alice", "total": 80.0},
                            {"id": 3, "customer": "bob", "total": 120.0},
                            {"id": 4, "customer": "carol", "total": 20.0},
                        ])
                    },
                    "env": {"MIN_ORDER_TOTAL": "50.0"},
                },
                {
                    "label": "threshold_100_one_customer",
                    "files": {
                        "etl/orders.json": json.dumps([
                            {"id": 1, "customer": "alice", "total": 45.0},
                            {"id": 2, "customer": "alice", "total": 80.0},
                            {"id": 3, "customer": "bob", "total": 120.0},
                            {"id": 4, "customer": "carol", "total": 20.0},
                        ])
                    },
                    "env": {"MIN_ORDER_TOTAL": "100.0"},
                },
                ["fs-io", "env-io", "sqlite3", "logging"],
            )
            _add_pair(
                "simonw__sqlite-utils",
                "sqlite_sql_migrations",
                pkg_full,
                "sql_migrate.py",
                """import json
import logging
import os
import sqlite3
from sqlite_utils import Database

def run(mig_dir, out_path):
    db = Database(sqlite3.connect(":memory:"))
    applied = []
    for fname in sorted(os.listdir(mig_dir)):
        if not fname.endswith(".sql"):
            continue
        with open(mig_dir + "/" + fname, "r", encoding="utf-8") as fh:
            sql = fh.read()
        db.executescript(sql)
        applied.append(fname)
        logging.info("applied migration %s", fname)
    tables = {t: [c.name for c in db[t].columns] for t in sorted(db.table_names())}
    counts = {t: db[t].count for t in sorted(db.table_names())}
    res = {"applied": applied, "tables": tables, "counts": counts}
    with open(out_path, "w", encoding="utf-8") as fh:
        fh.write(json.dumps(res, sort_keys=True))
    return res
""",
                "run",
                ["migrations", "migrations/schema_report.json"],
                {
                    "label": "two_migrations",
                    "files": {
                        "migrations/001_users.sql": "CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT);\nINSERT INTO users VALUES (1, 'a@x.io');\n",
                        "migrations/002_roles.sql": "ALTER TABLE users ADD COLUMN role TEXT DEFAULT 'member';\nUPDATE users SET role='admin' WHERE id=1;\n",
                    },
                    "env": {},
                },
                {
                    "label": "three_migrations_with_audit",
                    "files": {
                        "migrations/001_users.sql": "CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT);\nINSERT INTO users VALUES (1, 'a@x.io');\n",
                        "migrations/002_roles.sql": "ALTER TABLE users ADD COLUMN role TEXT DEFAULT 'member';\n",
                        "migrations/003_audit.sql": "CREATE TABLE audit (id INTEGER PRIMARY KEY, event TEXT);\nINSERT INTO audit VALUES (1, 'init');\n",
                    },
                    "env": {},
                },
                ["fs-io", "sqlite3", "logging"],
            )

    # 24. kurtmckee/feedparser (REAL HTTP urllib.request.urlopen -> http.request + FS cache!)
    pkg = _load_pkg(
        "kurtmckee__feedparser",
        "feedparser",
        max_files=40,
        exclude_substrings=("__main__", "tests/", "sgmllib3k"),
    )
    if pkg:
        rss_ok = (
            b'<?xml version="1.0" encoding="UTF-8"?>'
            b'<rss version="2.0"><channel><title>Engineering Feed</title>'
            b'<item><title>Release 2.1</title><link>https://example.org/2.1</link></item>'
            b'<item><title>Postmortem 42</title><link>https://example.org/pm42</link></item>'
            b'</channel></rss>'
        )
        _add_pair(
            "kurtmckee__feedparser",
            "http_rss_sync_with_cache",
            pkg,
            "feed_sync.py",
            """import json
import logging
import os
import urllib.error
import urllib.request
import feedparser

def run(feed_url, cache_path):
    try:
        with urllib.request.urlopen(feed_url) as resp:
            raw = resp.read()
        parsed = feedparser.parse(raw)
        titles = [e.get("title", "") for e in parsed.entries]
        out = {"source": "http", "feed_title": parsed.feed.get("title", ""), "titles": titles}
        with open(cache_path, "w", encoding="utf-8") as fh:
            fh.write(json.dumps(out, sort_keys=True))
        logging.info("synced %d feed items from %s", len(titles), feed_url)
        return out
    except urllib.error.HTTPError as exc:
        logging.warning("http fetch failed (%s); checking cache %s", exc.code, cache_path)
        if os.path.exists(cache_path):
            with open(cache_path, "r", encoding="utf-8") as fh:
                cached = json.load(fh)
            cached["source"] = "cache"
            return cached
        return {"source": "error", "status": exc.code, "titles": []}
""",
            "run",
            [f"{base_url}/rss.xml", "cache/feed.json"],
            {
                "label": "http_200_live_sync",
                "files": {"cache/.keep": ""},
                "env": {},
                "http_routes": {"/rss.xml": (200, {"Content-Type": "application/rss+xml"}, rss_ok)},
            },
            {
                "label": "http_503_cache_fallback",
                "files": {
                    "cache/feed.json": json.dumps({
                        "source": "http",
                        "feed_title": "Cached Feed",
                        "titles": ["Old Entry 1"],
                    })
                },
                "env": {},
                "http_routes": {"/rss.xml": (503, {"Content-Type": "text/plain"}, b"Service Unavailable")},
            },
            ["http-io", "fs-io", "logging"],
        )

    # 25. hynek/structlog (REAL structured logging + uuid + time + env + fs!)
    pkg = _load_pkg(
        "hynek__structlog",
        "src/structlog",
        max_files=35,
        exclude_substrings=("twisted", "testing", "tests/"),
    )
    if pkg:
        _add_pair(
            "hynek__structlog",
            "structured_audit_pipeline",
            pkg,
            "audit_log.py",
            """from datetime import datetime, timezone
import json
import logging
import os
import uuid
import structlog

def run(events_path, out_path):
    level = os.getenv("AUDIT_LEVEL", "INFO").upper()
    req_id = str(uuid.uuid4())
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    with open(events_path, "r", encoding="utf-8") as fh:
        events = json.load(fh)
    renderer = structlog.processors.JSONRenderer(sort_keys=True)
    rendered_lines = []
    for ev in events:
        if level == "ERROR" and ev.get("level") != "ERROR":
            continue
        payload = {"event": ev["msg"], "level": ev["level"], "request_id": req_id, "ts": ts}
        line = renderer(None, ev["level"].lower(), payload)
        rendered_lines.append(line)
        if ev["level"] == "ERROR":
            logging.error("%s", line)
        else:
            logging.info("%s", line)
    with open(out_path, "w", encoding="utf-8") as fh:
        fh.write("\\n".join(rendered_lines) + ("\\n" if rendered_lines else ""))
    return {"request_id": req_id, "emitted": len(rendered_lines), "level": level}
""",
            "run",
            ["audit/events.json", "audit/out.ndjson"],
            {
                "label": "level_info_all_events",
                "files": {
                    "audit/events.json": json.dumps([
                        {"level": "INFO", "msg": "job_started"},
                        {"level": "ERROR", "msg": "checksum_mismatch"},
                    ])
                },
                "env": {"AUDIT_LEVEL": "INFO"},
            },
            {
                "label": "level_error_only",
                "files": {
                    "audit/events.json": json.dumps([
                        {"level": "INFO", "msg": "job_started"},
                        {"level": "ERROR", "msg": "checksum_mismatch"},
                    ])
                },
                "env": {"AUDIT_LEVEL": "ERROR"},
            },
            ["fs-io", "env-io", "logging", "time-io", "uuid-io"],
        )

    # Additional rich stateful scenarios on top repos to reach 120+ diverse verified Python tasks!
    # 26. Extra python-dotenv + http remote config sync
    pkg = _load_pkg("theskumar__python-dotenv", "src/dotenv", exclude_substrings=("ipython", "cli.py", "__main__", "tests/"))
    if pkg:
        _add_pair(
            "theskumar__python-dotenv",
            "remote_config_with_dotenv_token",
            pkg,
            "remote_sync.py",
            """import json
import logging
import os
import urllib.error
import urllib.request
from dotenv import dotenv_values

def run(env_path, endpoint_url, out_path):
    vals = dict(dotenv_values(env_path, interpolate=False)) if os.path.exists(env_path) else {}
    token = vals.get("API_TOKEN") or os.getenv("API_TOKEN", "")
    req = urllib.request.Request(endpoint_url, headers={"Authorization": "Bearer " + token})
    try:
        with urllib.request.urlopen(req) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        out = {"ok": True, "token_used": bool(token), "settings": data}
    except urllib.error.HTTPError as exc:
        logging.error("remote config rejected: %s", exc.code)
        out = {"ok": False, "status": exc.code, "token_used": bool(token)}
    with open(out_path, "w", encoding="utf-8") as fh:
        fh.write(json.dumps(out, sort_keys=True))
    return out
""",
            "run",
            ["cfg/.env", f"{base_url}/api/config", "cfg/remote.json"],
            {
                "label": "auth_ok_200",
                "files": {"cfg/.env": "API_TOKEN=tok-live-99\n"},
                "env": {},
                "http_routes": {"/api/config": (200, {"Content-Type": "application/json"}, b'{"rate_limit":100,"tier":"pro"}')},
            },
            {
                "label": "missing_token_401",
                "files": {"cfg/.keep": ""},
                "env": {},
                "http_routes": {"/api/config": (401, {"Content-Type": "application/json"}, b'{"error":"unauthorized"}')},
            },
            ["http-io", "fs-io", "env-io", "logging"],
        )

    # 27. Extra yaml/pyyaml + subprocess (`shell.exec`) git tag release notes generator
    pkg = _load_pkg("yaml__pyyaml", "lib/yaml", exclude_substrings=("cyaml", "tests/"))
    if pkg:
        _add_pair(
            "yaml__pyyaml",
            "git_status_yaml_manifest",
            pkg,
            "repo_manifest.py",
            """import subprocess
import yaml

def run(meta_path, out_path):
    with open(meta_path, "r", encoding="utf-8") as fh:
        meta = yaml.safe_load(fh)
    cp = subprocess.run(["git", "status", "--short"], capture_output=True, text=True, check=True)
    dirty = [line.strip() for line in cp.stdout.splitlines() if line.strip()]
    meta["clean"] = len(dirty) == 0
    meta["dirty_files"] = dirty
    with open(out_path, "w", encoding="utf-8") as fh:
        fh.write(yaml.safe_dump(meta, sort_keys=True))
    return {"service": meta["service"], "clean": meta["clean"], "dirty_count": len(dirty)}
""",
            "run",
            ["service.yaml", "release_state.yaml"],
            {
                "label": "clean_repo",
                "files": {"service.yaml": "service: payments\nversion: 4.1.0\n"},
                "init_git": True,
                "env": {},
            },
            {
                "label": "dirty_repo",
                "files": {"service.yaml": "service: payments\nversion: 4.1.0\n"},
                "post_git_writes": {"untracked.txt": "wip\n"},
                "init_git": True,
                "env": {},
            },
            ["fs-io", "shell-exec"],
        )

    # 28. Extra pypa/packaging + sqlite3 (`sqlite-utils` style pure stdlib sqlite3 + packaging)
    pkg = _load_pkg(
        "pypa__packaging",
        "src/packaging",
        exclude_substrings=("metadata.py", "tests/"),
    )
    if pkg:
        _add_pair(
            "pypa__packaging",
            "sqlite_package_registry",
            pkg,
            "pkg_registry.py",
            """import json
import sqlite3
from packaging.specifiers import SpecifierSet
from packaging.version import Version

def run(catalog_path, spec_str, out_path):
    with open(catalog_path, "r", encoding="utf-8") as fh:
        entries = json.load(fh)
    conn = sqlite3.connect(":memory:")
    conn.execute("CREATE TABLE releases (pkg TEXT, ver TEXT, yanked INT)")
    conn.executemany("INSERT INTO releases VALUES (?, ?, ?)", [(e["pkg"], e["ver"], int(e["yanked"])) for e in entries])
    spec = SpecifierSet(spec_str)
    rows = conn.execute("SELECT pkg, ver FROM releases WHERE yanked = 0").fetchall()
    matched = sorted(
        [(pkg, ver) for pkg, ver in rows if spec.contains(Version(ver))],
        key=lambda item: Version(item[1]),
        reverse=True,
    )
    best = matched[0] if matched else None
    res = {"spec": spec_str, "best": best, "candidates": len(matched)}
    with open(out_path, "w", encoding="utf-8") as fh:
        fh.write(json.dumps(res, sort_keys=True))
    return res
""",
            "run",
            ["reg/catalog.json", ">=2.0,<3.0", "reg/selected.json"],
            {
                "label": "matching_v2_available",
                "files": {
                    "reg/catalog.json": json.dumps([
                        {"pkg": "httpx", "ver": "1.9.0", "yanked": False},
                        {"pkg": "httpx", "ver": "2.4.0", "yanked": False},
                        {"pkg": "httpx", "ver": "2.5.0", "yanked": True},
                        {"pkg": "httpx", "ver": "3.0.0", "yanked": False},
                    ])
                },
                "env": {},
            },
            {
                "label": "all_v2_yanked",
                "files": {
                    "reg/catalog.json": json.dumps([
                        {"pkg": "httpx", "ver": "1.9.0", "yanked": False},
                        {"pkg": "httpx", "ver": "2.4.0", "yanked": True},
                        {"pkg": "httpx", "ver": "3.0.0", "yanked": False},
                    ])
                },
                "env": {},
            },
            ["fs-io", "sqlite3"],
        )

    # 29. Extra asottile/identify + pathspec combined workspace security scanner
    pkg = _load_pkg("cpburnz__python-pathspec", "pathspec", exclude_substrings=("tests/", "benchmark"))
    if pkg:
        _add_pair(
            "cpburnz__python-pathspec",
            "deploy_bundle_checksum",
            pkg,
            "bundle_hash.py",
            """import hashlib
import json
import os
from pathspec import PathSpec

def run(root_dir, out_path):
    spec_path = root_dir + "/.bundleignore"
    rules = []
    if os.path.exists(spec_path):
        with open(spec_path, "r", encoding="utf-8") as fh:
            rules = fh.read().splitlines()
    spec = PathSpec.from_lines("gitignore", rules)
    include_tests = os.getenv("INCLUDE_TESTS", "0") == "1"
    hashes = {}
    for name in sorted(os.listdir(root_dir)):
        if name == ".bundleignore":
            continue
        if not include_tests and name.startswith("test_"):
            continue
        if spec.match_file(name):
            continue
        full = root_dir + "/" + name
        if os.path.isfile(full):
            with open(full, "rb") as fh:
                hashes[name] = hashlib.sha256(fh.read()).hexdigest()[:16]
    with open(out_path, "w", encoding="utf-8") as fh:
        fh.write(json.dumps(hashes, sort_keys=True))
    return {"files": sorted(hashes.keys()), "hashes": hashes}
""",
            "run",
            ["bundle", "bundle_manifest.json"],
            {
                "label": "exclude_tests_and_tmp",
                "files": {
                    "bundle/.bundleignore": "*.tmp\n",
                    "bundle/main.py": "print('hi')\n",
                    "bundle/test_main.py": "assert True\n",
                    "bundle/scratch.tmp": "tmp\n",
                },
                "env": {"INCLUDE_TESTS": "0"},
            },
            {
                "label": "include_tests",
                "files": {
                    "bundle/.bundleignore": "*.tmp\n",
                    "bundle/main.py": "print('hi')\n",
                    "bundle/test_main.py": "assert True\n",
                    "bundle/scratch.tmp": "tmp\n",
                },
                "env": {"INCLUDE_TESTS": "1"},
            },
            ["fs-io", "env-io"],
        )

    # 30. Extra hukkin/tomli + subprocess + logging build metadata validator
    pkg = _load_pkg("hukkin__tomli", "src/tomli")
    if pkg:
        _add_pair(
            "hukkin__tomli",
            "verify_toml_and_git_head",
            pkg,
            "verify_build.py",
            """import json
import logging
import subprocess
import tomli

def run(toml_path, out_path):
    with open(toml_path, "rb") as fh:
        cfg = tomli.load(fh)
    cp = subprocess.run(["git", "rev-parse", "--abbrev-ref", "HEAD"], capture_output=True, text=True, check=True)
    branch = cp.stdout.strip()
    allowed = cfg.get("release", {}).get("allowed_branches", ["main"])
    ok = branch in allowed
    if not ok:
        logging.warning("branch %s not in allowed %s", branch, allowed)
    res = {"branch": branch, "allowed": allowed, "can_release": ok}
    with open(out_path, "w", encoding="utf-8") as fh:
        fh.write(json.dumps(res, sort_keys=True))
    return res
""",
            "run",
            ["release.toml", "gate.json"],
            {
                "label": "branch_allowed",
                "files": {"release.toml": '[release]\nallowed_branches = ["main", "master"]\n'},
                "init_git": True,
                "env": {},
            },
            {
                "label": "branch_blocked",
                "files": {"release.toml": '[release]\nallowed_branches = ["release-prod"]\n'},
                "init_git": True,
                "env": {},
            },
            ["fs-io", "shell-exec", "logging"],
        )

    # 31. Extra msiemens/tinydb + http webhook alert dispatch
    pkg = _load_pkg("msiemens__tinydb", "tinydb")
    if pkg:
        _add_pair(
            "msiemens__tinydb",
            "tinydb_incident_webhook",
            pkg,
            "incident_dispatch.py",
            """import json
import logging
import urllib.error
import urllib.request
from tinydb import Query, TinyDB
from tinydb.storages import MemoryStorage

def run(db_path, webhook_url):
    with open(db_path, "r", encoding="utf-8") as fh:
        incidents = json.load(fh)
    db = TinyDB(storage=MemoryStorage)
    db.insert_multiple(incidents)
    Inc = Query()
    critical = db.search((Inc.severity == "critical") & (Inc.acked == False))
    if not critical:
        logging.info("no unacked critical incidents")
        return {"dispatched": False, "count": 0}
    body = json.dumps({"count": len(critical), "ids": [c["id"] for c in critical]}).encode("utf-8")
    req = urllib.request.Request(webhook_url, data=body, headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req) as resp:
        resp_data = json.loads(resp.read().decode("utf-8"))
    return {"dispatched": True, "count": len(critical), "webhook": resp_data}
""",
            "run",
            ["ops/incidents.json", f"{base_url}/hooks/pager"],
            {
                "label": "critical_dispatched",
                "files": {
                    "ops/incidents.json": json.dumps([
                        {"id": "INC-1", "severity": "critical", "acked": False},
                        {"id": "INC-2", "severity": "warning", "acked": False},
                    ])
                },
                "env": {},
                "http_routes": {"/hooks/pager": (200, {"Content-Type": "application/json"}, b'{"queued":true}')},
            },
            {
                "label": "all_acked_no_http",
                "files": {
                    "ops/incidents.json": json.dumps([
                        {"id": "INC-1", "severity": "critical", "acked": True},
                        {"id": "INC-2", "severity": "warning", "acked": False},
                    ])
                },
                "env": {},
                "http_routes": {"/hooks/pager": (200, {"Content-Type": "application/json"}, b'{"queued":true}')},
            },
            ["fs-io", "http-io", "logging"],
        )

    # 32. Extra asottile/cfgv + env secret policy check
    pkg = _load_pkg("asottile__cfgv", ".", single_file="cfgv.py")
    if pkg:
        _add_pair(
            "asottile__cfgv",
            "policy_env_check",
            pkg,
            "policy_runner.py",
            """import json
import os
import cfgv

POLICY_SCHEMA = cfgv.Map(
    "Policy", "id",
    cfgv.Required("id", cfgv.check_string),
    cfgv.Required("max_mb", cfgv.check_int),
    cfgv.Optional("require_tls", cfgv.check_bool, True),
)

def run(policy_path):
    cfg = cfgv.load_from_filename(policy_path, POLICY_SCHEMA, json.loads)
    size_mb = int(os.getenv("UPLOAD_MB", "10"))
    tls = os.getenv("TLS_ENABLED", "true").lower() == "true"
    allowed = (size_mb <= cfg["max_mb"]) and (not cfg["require_tls"] or tls)
    return {"policy_id": cfg["id"], "allowed": allowed, "size_mb": size_mb, "tls": tls}
""",
            "run",
            ["policy.json"],
            {
                "label": "upload_allowed",
                "files": {"policy.json": json.dumps({"id": "uploads-v1", "max_mb": 25})},
                "env": {"UPLOAD_MB": "12", "TLS_ENABLED": "true"},
            },
            {
                "label": "upload_rejected_no_tls",
                "files": {"policy.json": json.dumps({"id": "uploads-v1", "max_mb": 25})},
                "env": {"UPLOAD_MB": "12", "TLS_ENABLED": "false"},
            },
            ["fs-io", "env-io"],
        )

    # 33. Extra Python-Markdown/markdown + env theme wrapper
    pkg = _load_pkg("Python-Markdown__markdown", "markdown", max_files=40)
    if pkg:
        _add_pair(
            "Python-Markdown__markdown",
            "changelog_release_html",
            pkg,
            "changelog_gen.py",
            """import os
import markdown

def run(md_path, out_path):
    with open(md_path, "r", encoding="utf-8") as fh:
        text = fh.read()
    theme = os.getenv("HTML_THEME", "light")
    body = markdown.markdown(text)
    wrapped = f'<article data-theme="{theme}">{body}</article>'
    with open(out_path, "w", encoding="utf-8") as fh:
        fh.write(wrapped)
    return {"theme": theme, "bytes": len(wrapped), "has_list": "<li>" in body}
""",
            "run",
            ["CHANGELOG.md", "CHANGELOG.html"],
            {
                "label": "dark_theme_list",
                "files": {"CHANGELOG.md": "# v2.0\n\n- Added OAuth\n- Fixed retry\n"},
                "env": {"HTML_THEME": "dark"},
            },
            {
                "label": "default_light_prose",
                "files": {"CHANGELOG.md": "# v2.1\n\nMaintenance release.\n"},
                "env": {},
            },
            ["fs-io", "env-io"],
        )

    # 34. Extra bottlepy/bottle + env + time email digest renderer
    pkg = _load_pkg("bottlepy__bottle", ".", single_file="bottle.py")
    if pkg:
        _add_pair(
            "bottlepy__bottle",
            "digest_email_render",
            pkg,
            "digest_render.py",
            """from datetime import datetime, timezone
import json
import os
from bottle import SimpleTemplate

def run(tpl_path, data_path, out_path):
    with open(tpl_path, "r", encoding="utf-8") as fh:
        tpl = fh.read()
    with open(data_path, "r", encoding="utf-8") as fh:
        items = json.load(fh)
    org = os.getenv("ORG_NAME", "Acme")
    day = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    html = SimpleTemplate(tpl).render(org=org, day=day, items=items)
    with open(out_path, "w", encoding="utf-8") as fh:
        fh.write(html)
    return {"org": org, "day": day, "count": len(items)}
""",
            "run",
            ["mail/digest.tpl", "mail/items.json", "mail/out.txt"],
            {
                "label": "acme_three_items",
                "files": {
                    "mail/digest.tpl": "[{{org}} {{day}}] {{len(items)}} updates: {{', '.join(items)}}",
                    "mail/items.json": json.dumps(["api", "billing", "search"]),
                },
                "env": {"ORG_NAME": "Nebula"},
            },
            {
                "label": "default_org_one_item",
                "files": {
                    "mail/digest.tpl": "[{{org}} {{day}}] {{len(items)}} updates: {{', '.join(items)}}",
                    "mail/items.json": json.dumps(["hotfix"]),
                },
                "env": {},
            },
            ["fs-io", "env-io", "time-io"],
        )

    # 35. Extra PyCQA/pycodestyle directory scanner
    pkg = _load_pkg("PyCQA__pycodestyle", ".", single_file="pycodestyle.py")
    if pkg:
        _add_pair(
            "PyCQA__pycodestyle",
            "dir_pep8_summary",
            pkg,
            "dir_pep8.py",
            """import json
import os
import pycodestyle

def run(src_dir, out_path):
    summary = {}
    for name in sorted(os.listdir(src_dir)):
        if not name.endswith(".py"):
            continue
        full = src_dir + "/" + name
        with open(full, "r", encoding="utf-8") as fh:
            lines = fh.readlines()
        guide = pycodestyle.StyleGuide(quiet=True, config_file="pep8.cfg")
        checker = pycodestyle.Checker(filename=full, lines=lines, options=guide.options, report=guide.options.report)
        summary[name] = checker.check_all()
    with open(out_path, "w", encoding="utf-8") as fh:
        fh.write(json.dumps(summary, sort_keys=True))
    return {"total_errors": sum(summary.values()), "by_file": summary}
""",
            "run",
            ["src", "pep8_dir.json"],
            {
                "label": "mixed_errors",
                "files": {
                    "src/a.py": "x=1\n",
                    "src/b.py": "y = 2\n",
                },
                "env": {},
            },
            {
                "label": "all_clean",
                "files": {
                    "src/a.py": "x = 1\n",
                    "src/b.py": "y = 2\n",
                },
                "env": {},
            },
            ["fs-io"],
        )

    # 36. Extra PyCQA/mccabe multi-file directory check
    pkg = _load_pkg("PyCQA__mccabe", ".", single_file="mccabe.py")
    if pkg:
        _add_pair(
            "PyCQA__mccabe",
            "dir_complexity_scan",
            pkg,
            "dir_cc.py",
            """import ast
import json
import os
import mccabe

def run(pkg_dir, out_path):
    report = {}
    for fname in sorted(os.listdir(pkg_dir)):
        if not fname.endswith(".py"):
            continue
        full = pkg_dir + "/" + fname
        with open(full, "r", encoding="utf-8") as fh:
            tree = ast.parse(fh.read(), filename=full)
        visitor = mccabe.PathGraphingAstVisitor()
        visitor.preorder(tree, visitor)
        report[fname] = max((g.complexity() for g in visitor.graphs.values()), default=0)
    with open(out_path, "w", encoding="utf-8") as fh:
        fh.write(json.dumps(report, sort_keys=True))
    return {"max_cc": max(report.values(), default=0), "files": report}
""",
            "run",
            ["pkg", "cc_dir.json"],
            {
                "label": "branchy_module",
                "files": {
                    "pkg/calc.py": "def f(x):\n    if x < 0:\n        return -1\n    elif x == 0:\n        return 0\n    elif x < 10:\n        return 1\n    return 2\n",
                    "pkg/id.py": "def ident(v):\n    return v\n",
                },
                "env": {},
            },
            {
                "label": "simple_modules",
                "files": {
                    "pkg/calc.py": "def f(x):\n    return x + 1\n",
                    "pkg/id.py": "def ident(v):\n    return v\n",
                },
                "env": {},
            },
            ["fs-io"],
        )

    # 37. Extra pytest-dev/iniconfig multi-env service ini merger
    pkg = _load_pkg("pytest-dev__iniconfig", "src/iniconfig")
    if pkg:
        _add_pair(
            "pytest-dev__iniconfig",
            "ini_feature_matrix",
            pkg,
            "ini_matrix.py",
            """import json
import os
from iniconfig import IniConfig

def run(ini_path, out_path):
    cfg = IniConfig(ini_path)
    profile = os.getenv("PROFILE", "default")
    sec_name = profile if profile in cfg else "default"
    data = dict(cfg[sec_name])
    res = {"profile": sec_name, "workers": int(data.get("workers", "1")), "cache": data.get("cache", "off")}
    with open(out_path, "w", encoding="utf-8") as fh:
        fh.write(json.dumps(res, sort_keys=True))
    return res
""",
            "run",
            ["app.ini", "resolved_ini.json"],
            {
                "label": "prod_profile",
                "files": {"app.ini": "[default]\nworkers = 2\ncache = memory\n[prod]\nworkers = 16\ncache = redis\n"},
                "env": {"PROFILE": "prod"},
            },
            {
                "label": "unknown_profile_fallback",
                "files": {"app.ini": "[default]\nworkers = 2\ncache = memory\n[prod]\nworkers = 16\ncache = redis\n"},
                "env": {"PROFILE": "canary"},
            },
            ["fs-io", "env-io"],
        )

    # 38. Extra sdispater/tomlkit dependency injector
    pkg = _load_pkg("sdispater__tomlkit", "tomlkit", max_files=40)
    if pkg:
        _add_pair(
            "sdispater__tomlkit",
            "add_optional_dep_tomlkit",
            pkg,
            "add_dep.py",
            """import os
import tomlkit

def run(toml_path, dep_spec):
    with open(toml_path, "r", encoding="utf-8") as fh:
        doc = tomlkit.parse(fh.read())
    deps = doc["project"]["dependencies"]
    if dep_spec not in deps:
        deps.append(dep_spec)
        added = True
    else:
        added = False
    with open(toml_path, "w", encoding="utf-8") as fh:
        fh.write(tomlkit.dumps(doc))
    return {"added": added, "count": len(deps)}
""",
            "run",
            ["pyproject.toml", "rich>=13.0"],
            {
                "label": "dep_added",
                "files": {"pyproject.toml": '[project]\nname = "tool"\ndependencies = ["click>=8.0"]\n'},
                "env": {},
            },
            {
                "label": "dep_already_present",
                "files": {"pyproject.toml": '[project]\nname = "tool"\ndependencies = ["click>=8.0", "rich>=13.0"]\n'},
                "env": {},
            },
            ["fs-io"],
        )

    # 39. Extra asottile/identify shebang + secrets token script generator
    pkg = _load_pkg("asottile__identify", "identify", exclude_substrings=("cli.py", "__main__", "tests/"))
    if pkg:
        _add_pair(
            "asottile__identify",
            "audit_script_shebangs",
            pkg,
            "shebang_audit.py",
            """import json
import os
from identify import identify

def run(script_path, out_path):
    if not os.path.exists(script_path):
        res = {"exists": False, "tags": []}
    else:
        shebang = identify.parse_shebang_from_file(script_path)
        tags = sorted(identify.tags_from_interpreter(shebang[0])) if shebang else []
        res = {"exists": True, "shebang": list(shebang), "tags": tags}
    with open(out_path, "w", encoding="utf-8") as fh:
        fh.write(json.dumps(res, sort_keys=True))
    return res
""",
            "run",
            ["bin/run-job", "bin/audit.json"],
            {
                "label": "python3_shebang",
                "files": {"bin/run-job": "#!/usr/bin/env python3\nimport sys\n"},
                "env": {},
            },
            {
                "label": "missing_script",
                "files": {"bin/.keep": ""},
                "env": {},
            },
            ["fs-io"],
        )

    # 40. Extra simonw/sqlite-utils CSV/JSON upsert + HTTP enrich
    pkg_full = _load_pkg("simonw__sqlite-utils", "sqlite_utils", exclude_substrings=("cli.py", "__main__", "tests/"))
    fts4_dir = cache_dir / "simonw__sqlite-fts4" / "sqlite_fts4"
    if pkg_full and fts4_dir.is_dir():
        for fp in sorted(fts4_dir.rglob("*.py")):
            pkg_full[fp.relative_to(fts4_dir.parent).as_posix()] = fp.read_text(encoding="utf-8", errors="ignore")
    if pkg_full:
        _add_pair(
            "simonw__sqlite-utils",
            "sqlite_http_enrichment",
            pkg_full,
            "sql_enrich.py",
            """import json
import sqlite3
import urllib.request
from sqlite_utils import Database

def run(users_path, rates_url, out_path):
    with open(users_path, "r", encoding="utf-8") as fh:
        users = json.load(fh)
    with urllib.request.urlopen(rates_url) as resp:
        rates = json.loads(resp.read().decode("utf-8"))
    db = Database(sqlite3.connect(":memory:"))
    db["balances"].insert_all(users, pk="user")
    enriched = []
    for row in db["balances"].rows:
        mult = float(rates.get(row["currency"], 1.0))
        usd = round(row["amount"] * mult, 2)
        db["balances"].update(row["user"], {"usd": usd})
        enriched.append({"user": row["user"], "usd": usd})
    enriched.sort(key=lambda x: x["user"])
    with open(out_path, "w", encoding="utf-8") as fh:
        fh.write(json.dumps(enriched, sort_keys=True))
    return {"total_usd": round(sum(x["usd"] for x in enriched), 2), "rows": enriched}
""",
            "run",
            ["fin/balances.json", f"{base_url}/fx/rates", "fin/usd.json"],
            {
                "label": "fx_eur_110",
                "files": {
                    "fin/balances.json": json.dumps([
                        {"user": "alice", "currency": "EUR", "amount": 100.0},
                        {"user": "bob", "currency": "USD", "amount": 50.0},
                    ])
                },
                "env": {},
                "http_routes": {"/fx/rates": (200, {"Content-Type": "application/json"}, b'{"EUR":1.10,"USD":1.0}')},
            },
            {
                "label": "fx_eur_125",
                "files": {
                    "fin/balances.json": json.dumps([
                        {"user": "alice", "currency": "EUR", "amount": 100.0},
                        {"user": "bob", "currency": "USD", "amount": 50.0},
                    ])
                },
                "env": {},
                "http_routes": {"/fx/rates": (200, {"Content-Type": "application/json"}, b'{"EUR":1.25,"USD":1.0}')},
            },
            ["fs-io", "http-io", "sqlite3"],
        )

    # 41. Extra platformdirs + logging + env cache invalidation
    pkg = _load_pkg("platformdirs__platformdirs", "src/platformdirs", exclude_substrings=("__main__", "tests/"))
    if pkg:
        pkg["platformdirs/version.py"] = '__version__ = "4.3.6"\n__version_tuple__ = (4, 3, 6)\n'
        _add_pair(
            "platformdirs__platformdirs",
            "xdg_cache_version_check",
            pkg,
            "xdg_cache.py",
            """import json
import logging
import os
from platformdirs import PlatformDirs

def run(app_name, expected_ver):
    dirs = PlatformDirs(app_name)
    key = dirs.user_cache_dir.strip("/").replace("/", "_")
    meta_path = "cache/" + key + ".json"
    if os.path.exists(meta_path):
        with open(meta_path, "r", encoding="utf-8") as fh:
            meta = json.load(fh)
        if meta.get("version") == expected_ver:
            return {"status": "hit", "version": expected_ver, "cache_dir": dirs.user_cache_dir}
        logging.warning("cache version mismatch: %s != %s", meta.get("version"), expected_ver)
    fresh = {"version": expected_ver, "entries": 0}
    with open(meta_path, "w", encoding="utf-8") as fh:
        fh.write(json.dumps(fresh, sort_keys=True))
    return {"status": "rebuilt", "version": expected_ver, "cache_dir": dirs.user_cache_dir}
""",
            "run",
            ["indexer", "v4"],
            {
                "label": "cache_hit",
                "files": {"cache/xdg_cache_indexer.json": json.dumps({"version": "v4", "entries": 42})},
                "env": {"XDG_CACHE_HOME": "/xdg_cache"},
            },
            {
                "label": "cache_stale_rebuild",
                "files": {"cache/xdg_cache_indexer.json": json.dumps({"version": "v3", "entries": 12})},
                "env": {"XDG_CACHE_HOME": "/xdg_cache"},
            },
            ["fs-io", "env-io", "logging"],
        )

    # 42. Extra docopt + logging + env feature runner
    pkg = _load_pkg("docopt__docopt", ".", single_file="docopt.py")
    if pkg:
        _add_pair(
            "docopt__docopt",
            "cli_report_exporter",
            pkg,
            "export_cli.py",
            """import json
import logging
import os
from docopt import docopt

USAGE = '''Metrics Exporter.

Usage:
  metrics export <src> <dst> [--min=<n>]

Options:
  --min=<n>  Minimum value [default: 0].
'''

def run(argv):
    opts = docopt(USAGE, argv=argv)
    threshold = int(os.getenv("METRICS_MIN", opts["--min"]))
    with open(opts["<src>"], "r", encoding="utf-8") as fh:
        records = json.load(fh)
    kept = [r for r in records if r["score"] >= threshold]
    logging.info("kept %d/%d records (min=%d)", len(kept), len(records), threshold)
    with open(opts["<dst>"], "w", encoding="utf-8") as fh:
        fh.write(json.dumps(kept, sort_keys=True))
    return {"kept": len(kept), "threshold": threshold}
""",
            "run",
            [["export", "m/in.json", "m/out.json", "--min=50"]],
            {
                "label": "env_overrides_min_80",
                "files": {"m/in.json": json.dumps([{"id": 1, "score": 60}, {"id": 2, "score": 90}])},
                "env": {"METRICS_MIN": "80"},
            },
            {
                "label": "cli_default_min_50",
                "files": {"m/in.json": json.dumps([{"id": 1, "score": 60}, {"id": 2, "score": 90}])},
                "env": {},
            },
            ["fs-io", "env-io", "logging"],
        )

    # 43. Extra hukkin/tomli-w + uiri/toml roundtrip config normalizer
    pkg = _load_pkg("hukkin__tomli-w", "src/tomli_w")
    if pkg:
        _add_pair(
            "hukkin__tomli-w",
            "json_to_toml_export",
            pkg,
            "json2toml.py",
            """import json
import os
import tomli_w

def run(src_dir, out_toml):
    bundle = {}
    for name in sorted(os.listdir(src_dir)):
        if not name.endswith(".json"):
            continue
        with open(src_dir + "/" + name, "r", encoding="utf-8") as fh:
            bundle[name[:-5]] = json.load(fh)
    with open(out_toml, "wb") as fh:
        tomli_w.dump(bundle, fh)
    return {"sections": sorted(bundle.keys())}
""",
            "run",
            ["parts", "combined.toml"],
            {
                "label": "two_json_parts",
                "files": {
                    "parts/auth.json": json.dumps({"issuer": "https://id.acme.io", "ttl": 3600}),
                    "parts/cache.json": json.dumps({"driver": "redis", "db": 1}),
                },
                "env": {},
            },
            {
                "label": "single_json_part",
                "files": {
                    "parts/auth.json": json.dumps({"issuer": "https://id.acme.io", "ttl": 900}),
                },
                "env": {},
            },
            ["fs-io"],
        )

    # 44. Extra executablebooks/markdown-it-py link extractor + HTTP health check
    pkg = _load_pkg("executablebooks__markdown-it-py", "markdown_it", max_files=70, exclude_substrings=("cli/", "__main__", "tests/"))
    if pkg:
        _add_pair(
            "executablebooks__markdown-it-py",
            "md_link_checker_http",
            pkg,
            "link_check.py",
            """import json
import logging
import urllib.error
import urllib.request
from markdown_it import MarkdownIt

def run(md_path, base_url, out_path):
    with open(md_path, "r", encoding="utf-8") as fh:
        text = fh.read()
    tokens = MarkdownIt("commonmark").parse(text)
    links = []
    for tok in tokens:
        if tok.children:
            for ch in tok.children:
                if ch.type == "link_open":
                    href = ch.attrGet("href")
                    if href and href.startswith("/"):
                        links.append(href)
    results = []
    for href in links:
        url = base_url + href
        try:
            with urllib.request.urlopen(url) as resp:
                results.append({"href": href, "status": resp.status})
        except urllib.error.HTTPError as exc:
            logging.warning("broken link %s -> %s", href, exc.code)
            results.append({"href": href, "status": exc.code})
    with open(out_path, "w", encoding="utf-8") as fh:
        fh.write(json.dumps(results, sort_keys=True))
    return {"checked": len(results), "broken": sum(1 for r in results if r["status"] >= 400), "results": results}
""",
            "run",
            ["docs/index.md", base_url, "docs/links.json"],
            {
                "label": "all_links_200",
                "files": {"docs/index.md": "See [Docs](/docs) and [API](/api).\n"},
                "env": {},
                "http_routes": {
                    "/docs": (200, {"Content-Type": "text/html"}, b"<h1>Docs</h1>"),
                    "/api": (200, {"Content-Type": "text/html"}, b"<h1>API</h1>"),
                },
            },
            {
                "label": "one_link_404",
                "files": {"docs/index.md": "See [Docs](/docs) and [API](/api).\n"},
                "env": {},
                "http_routes": {
                    "/docs": (200, {"Content-Type": "text/html"}, b"<h1>Docs</h1>"),
                    "/api": (404, {"Content-Type": "text/html"}, b"Not Found"),
                },
            },
            ["fs-io", "http-io", "logging"],
        )

    # 45. Extra kurtmckee/feedparser local XML file digest (offline FS + time)
    pkg = _load_pkg("kurtmckee__feedparser", "feedparser", max_files=40, exclude_substrings=("__main__", "tests/", "sgmllib3k"))
    if pkg:
        _add_pair(
            "kurtmckee__feedparser",
            "local_atom_archive",
            pkg,
            "atom_index.py",
            """import json
import os
import feedparser

def run(feed_dir, out_path):
    entries = []
    for name in sorted(os.listdir(feed_dir)):
        if not name.endswith(".xml"):
            continue
        with open(feed_dir + "/" + name, "rb") as fh:
            parsed = feedparser.parse(fh.read())
        for item in parsed.entries:
            entries.append({"file": name, "title": item.get("title", "")})
    with open(out_path, "w", encoding="utf-8") as fh:
        fh.write(json.dumps(entries, sort_keys=True))
    return {"count": len(entries), "titles": [e["title"] for e in entries]}
""",
            "run",
            ["feeds", "feeds/index.json"],
            {
                "label": "two_atom_feeds",
                "files": {
                    "feeds/a.xml": '<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>A</title><entry><title>Alpha</title></entry></feed>',
                    "feeds/b.xml": '<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>B</title><entry><title>Beta</title></entry></feed>',
                },
                "env": {},
            },
            {
                "label": "one_atom_feed",
                "files": {
                    "feeds/a.xml": '<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>A</title><entry><title>Alpha</title></entry></feed>',
                },
                "env": {},
            },
            ["fs-io"],
        )

    # 46. Extra jendrikseipp/vulture + subprocess git-tracked dead code check
    pkg = _load_pkg("jendrikseipp__vulture", "vulture", exclude_substrings=("__main__", "tests/", "whitelists/"))
    if pkg:
        _add_pair(
            "jendrikseipp__vulture",
            "vulture_whitelist_check",
            pkg,
            "vulture_wl.py",
            """import json
import os
from vulture.core import Vulture

def run(src_path, whitelist_path, out_path):
    v = Vulture(verbose=False)
    with open(src_path, "r", encoding="utf-8") as fh:
        v.scan(fh.read(), filename=src_path)
    if os.path.exists(whitelist_path):
        with open(whitelist_path, "r", encoding="utf-8") as fh:
            v.scan(fh.read(), filename=whitelist_path)
    unused = sorted(item.name for item in v.get_unused_code(min_confidence=60))
    res = {"unused": unused, "clean": len(unused) == 0}
    with open(out_path, "w", encoding="utf-8") as fh:
        fh.write(json.dumps(res, sort_keys=True))
    return res
""",
            "run",
            ["app/mod.py", "app/whitelist.py", "app/vulture.json"],
            {
                "label": "with_whitelist_clean",
                "files": {
                    "app/mod.py": "def plugin_hook(x):\n    return x + 1\n",
                    "app/whitelist.py": "plugin_hook\n",
                },
                "env": {},
            },
            {
                "label": "without_whitelist_flagged",
                "files": {
                    "app/mod.py": "def plugin_hook(x):\n    return x + 1\n",
                },
                "env": {},
            },
            ["fs-io"],
        )

    # 47. Extra jazzband/dj-database-url multi-replica config builder
    pkg = _load_pkg("jazzband__dj-database-url", "dj_database_url")
    if pkg:
        _add_pair(
            "jazzband__dj-database-url",
            "multi_replica_db_map",
            pkg,
            "replicas.py",
            """import json
import os
import dj_database_url

def run(out_path):
    primary = dj_database_url.config(env="PRIMARY_DB_URL", default="sqlite:///primary.db")
    replica_raw = os.getenv("REPLICA_DB_URL")
    dbs = {"default": {"engine": primary["ENGINE"], "host": primary.get("HOST", "")}}
    if replica_raw:
        rep = dj_database_url.parse(replica_raw)
        dbs["replica"] = {"engine": rep["ENGINE"], "host": rep.get("HOST", "")}
    with open(out_path, "w", encoding="utf-8") as fh:
        fh.write(json.dumps(dbs, sort_keys=True))
    return {"aliases": sorted(dbs.keys()), "dbs": dbs}
""",
            "run",
            ["db_map.json"],
            {
                "label": "primary_and_replica",
                "files": {},
                "env": {
                    "PRIMARY_DB_URL": "postgres://u:p@primary.db:5432/app",
                    "REPLICA_DB_URL": "postgres://u:p@replica.db:5432/app",
                },
            },
            {
                "label": "primary_only_default",
                "files": {},
                "env": {},
            },
            ["fs-io", "env-io"],
        )

    # 48. Extra hynek/structlog + env redaction processor
    pkg = _load_pkg(
        "hynek__structlog",
        "src/structlog",
        max_files=35,
        exclude_substrings=("twisted", "testing", "tests/"),
    )
    if pkg:
        _add_pair(
            "hynek__structlog",
            "structlog_kv_redactor",
            pkg,
            "kv_redact.py",
            """import json
import logging
import os
import structlog

def run(in_path, out_path):
    redact = os.getenv("REDACT_PII", "1") == "1"
    with open(in_path, "r", encoding="utf-8") as fh:
        records = json.load(fh)
    renderer = structlog.processors.KeyValueRenderer(sort_keys=True)
    lines = []
    for rec in records:
        ev = dict(rec)
        if redact and "email" in ev:
            ev["email"] = "[REDACTED]"
        line = renderer(None, "info", ev)
        lines.append(line)
        logging.info("%s", line)
    with open(out_path, "w", encoding="utf-8") as fh:
        fh.write("\\n".join(lines) + "\\n")
    return {"redact": redact, "count": len(lines), "first": lines[0] if lines else ""}
""",
            "run",
            ["logs/in.json", "logs/out.log"],
            {
                "label": "pii_redacted",
                "files": {"logs/in.json": json.dumps([{"event": "signup", "email": "alice@corp.io", "plan": "pro"}])},
                "env": {"REDACT_PII": "1"},
            },
            {
                "label": "pii_raw_debug",
                "files": {"logs/in.json": json.dumps([{"event": "signup", "email": "alice@corp.io", "plan": "pro"}])},
                "env": {"REDACT_PII": "0"},
            },
            ["fs-io", "env-io", "logging"],
        )

    # 49-56: Additional diverse stateful scenarios across top OSS repos to comfortably exceed 110+ Python tasks
    # 49. uiri/toml + secrets token rotation
    pkg = _load_pkg("uiri__toml", "toml")
    if pkg:
        _add_pair(
            "uiri__toml",
            "rotate_api_key_toml",
            pkg,
            "rotate_key.py",
            """import logging
import os
import secrets
import toml

def run(cfg_path):
    cfg = toml.load(cfg_path)
    force = os.getenv("FORCE_ROTATE", "0") == "1"
    if force or not cfg.get("auth", {}).get("api_key"):
        new_key = secrets.token_hex(8)
        cfg.setdefault("auth", {})["api_key"] = new_key
        with open(cfg_path, "w", encoding="utf-8") as fh:
            toml.dump(cfg, fh)
        logging.info("rotated api key in %s", cfg_path)
        return {"rotated": True, "key_len": len(new_key)}
    return {"rotated": False, "key_len": len(cfg["auth"]["api_key"])}
""",
            "run",
            ["auth.toml"],
            {
                "label": "force_rotate_secrets",
                "files": {"auth.toml": '[auth]\napi_key = "old-key-123"\n'},
                "env": {"FORCE_ROTATE": "1"},
            },
            {
                "label": "keep_existing_key",
                "files": {"auth.toml": '[auth]\napi_key = "old-key-123"\n'},
                "env": {"FORCE_ROTATE": "0"},
            },
            ["fs-io", "env-io", "logging", "secrets-io"],
        )

    # 50. theskumar/python-dotenv + pathlib Path APIs
    pkg = _load_pkg("theskumar__python-dotenv", "src/dotenv", exclude_substrings=("ipython", "cli.py", "__main__", "tests/"))
    if pkg:
        _add_pair(
            "theskumar__python-dotenv",
            "pathlib_dotenv_snapshot",
            pkg,
            "path_env.py",
            """import json
from pathlib import Path
from dotenv import dotenv_values

def run(root_str, out_str):
    root = Path(root_str)
    env_p = root / ".env"
    if env_p.exists() and env_p.is_file():
        data = dict(dotenv_values(str(env_p), interpolate=False))
    else:
        data = {}
    out_p = Path(out_str)
    out_p.write_text(json.dumps(data, sort_keys=True), encoding="utf-8")
    return {"found": bool(data), "keys": sorted(data.keys())}
""",
            "run",
            ["svc", "svc/env_dump.json"],
            {
                "label": "pathlib_found",
                "files": {"svc/.env": "SERVICE=search\nSHARDS=4\n"},
                "env": {},
            },
            {
                "label": "pathlib_missing",
                "files": {"svc/README.md": "hi\n"},
                "env": {},
            },
            ["fs-io", "pathlib"],
        )

    # 51. pypa/packaging + pathlib wheel directory resolver
    pkg = _load_pkg(
        "pypa__packaging",
        "src/packaging",
        exclude_substrings=("metadata.py", "tests/"),
    )
    if pkg:
        _add_pair(
            "pypa__packaging",
            "select_latest_wheel",
            pkg,
            "wheel_pick.py",
            """import os
from pathlib import Path
from packaging.version import Version

def run(dist_dir):
    allow_pre = os.getenv("ALLOW_PRE", "0") == "1"
    versions = []
    for p in Path(dist_dir).iterdir():
        name = p.name
        if not name.endswith(".whl"):
            continue
        ver_str = name.split("-")[1]
        v = Version(ver_str)
        if v.is_prerelease and not allow_pre:
            continue
        versions.append((v, name))
    versions.sort(key=lambda pair: pair[0], reverse=True)
    return {"allow_pre": allow_pre, "selected": versions[0][1] if versions else None, "count": len(versions)}
""",
            "run",
            ["dist"],
            {
                "label": "stable_only",
                "files": {
                    "dist/acme-1.2.0-py3-none-any.whl": "w1",
                    "dist/acme-1.3.0a1-py3-none-any.whl": "w2",
                },
                "env": {"ALLOW_PRE": "0"},
            },
            {
                "label": "allow_prerelease",
                "files": {
                    "dist/acme-1.2.0-py3-none-any.whl": "w1",
                    "dist/acme-1.3.0a1-py3-none-any.whl": "w2",
                },
                "env": {"ALLOW_PRE": "1"},
            },
            ["fs-io", "env-io", "pathlib"],
        )

    # 52. hukkin/tomli + pathlib multi-project monorepo scanner
    pkg = _load_pkg("hukkin__tomli", "src/tomli")
    if pkg:
        _add_pair(
            "hukkin__tomli",
            "monorepo_pyproject_index",
            pkg,
            "mono_index.py",
            """import json
from pathlib import Path
import tomli

def run(pkgs_dir, out_path):
    index = {}
    for entry in Path(pkgs_dir).iterdir():
        if not entry.is_dir():
            continue
        toml_p = entry / "pyproject.toml"
        if not toml_p.exists():
            continue
        doc = tomli.loads(toml_p.read_bytes().decode("utf-8"))
        proj = doc.get("project", {})
        index[proj.get("name", entry.name)] = proj.get("version", "0.0.0")
    Path(out_path).write_text(json.dumps(index, sort_keys=True), encoding="utf-8")
    return {"packages": index}
""",
            "run",
            ["packages", "packages/index.json"],
            {
                "label": "two_packages",
                "files": {
                    "packages/core/pyproject.toml": '[project]\nname = "core"\nversion = "1.0.0"\n',
                    "packages/cli/pyproject.toml": '[project]\nname = "cli"\nversion = "0.4.2"\n',
                },
                "env": {},
            },
            {
                "label": "one_package_one_unconfigured",
                "files": {
                    "packages/core/pyproject.toml": '[project]\nname = "core"\nversion = "1.0.0"\n',
                    "packages/legacy/setup.txt": "old\n",
                },
                "env": {},
            },
            ["fs-io", "pathlib"],
        )

    # 53. yaml/pyyaml + pathlib + logging environment diff
    pkg = _load_pkg("yaml__pyyaml", "lib/yaml", exclude_substrings=("cyaml", "tests/"))
    if pkg:
        _add_pair(
            "yaml__pyyaml",
            "yaml_env_diff",
            pkg,
            "yaml_diff.py",
            """import json
import logging
from pathlib import Path
import yaml

def run(a_path, b_path, out_path):
    a = yaml.safe_load(Path(a_path).read_text(encoding="utf-8")) or {}
    b = yaml.safe_load(Path(b_path).read_text(encoding="utf-8")) or {}
    changed = sorted(k for k in set(a) | set(b) if a.get(k) != b.get(k))
    if changed:
        logging.warning("config drift detected on keys: %s", ",".join(changed))
    res = {"drifted": bool(changed), "changed_keys": changed}
    Path(out_path).write_text(json.dumps(res, sort_keys=True), encoding="utf-8")
    return res
""",
            "run",
            ["env/staging.yaml", "env/prod.yaml", "env/diff.json"],
            {
                "label": "drift_detected",
                "files": {
                    "env/staging.yaml": "timeout: 5\nretries: 3\nregion: us-east\n",
                    "env/prod.yaml": "timeout: 15\nretries: 3\nregion: us-west\n",
                },
                "env": {},
            },
            {
                "label": "in_sync",
                "files": {
                    "env/staging.yaml": "timeout: 15\nretries: 3\nregion: us-west\n",
                    "env/prod.yaml": "timeout: 15\nretries: 3\nregion: us-west\n",
                },
                "env": {},
            },
            ["fs-io", "pathlib", "logging"],
        )

    # 54. PyCQA/pyflakes + pathlib single file check
    pkg = _load_pkg("PyCQA__pyflakes", "pyflakes", exclude_substrings=("__main__", "tests/", "test/"))
    if pkg:
        _add_pair(
            "PyCQA__pyflakes",
            "pathlib_check_module",
            pkg,
            "check_mod.py",
            """import ast
from pathlib import Path
from pyflakes.checker import Checker

def run(mod_path):
    p = Path(mod_path)
    if not p.exists():
        return {"exists": False, "warnings": []}
    code = p.read_text(encoding="utf-8")
    w = Checker(ast.parse(code, filename=mod_path), filename=mod_path)
    warns = sorted(type(m).__name__ for m in w.messages)
    return {"exists": True, "warnings": warns}
""",
            "run",
            ["src/handler.py"],
            {
                "label": "redefined_unused",
                "files": {"src/handler.py": "import json\n\ndef handle(x):\n    unused_local = 1\n    return x\n"},
                "env": {},
            },
            {
                "label": "missing_module",
                "files": {"src/.keep": ""},
                "env": {},
            },
            ["fs-io", "pathlib"],
        )

    # 55. simonw/sqlite-utils + pathlib CSV-like ingestion & query
    pkg_full = _load_pkg("simonw__sqlite-utils", "sqlite_utils", exclude_substrings=("cli.py", "__main__", "tests/"))
    fts4_dir = cache_dir / "simonw__sqlite-fts4" / "sqlite_fts4"
    if pkg_full and fts4_dir.is_dir():
        for fp in sorted(fts4_dir.rglob("*.py")):
            pkg_full[fp.relative_to(fts4_dir.parent).as_posix()] = fp.read_text(encoding="utf-8", errors="ignore")
    if pkg_full:
        _add_pair(
            "simonw__sqlite-utils",
            "sqlite_csv_import_filter",
            pkg_full,
            "csv_sql.py",
            """import csv
import io
import json
import sqlite3
from pathlib import Path
from sqlite_utils import Database

def run(csv_path, status_filter, out_path):
    text = Path(csv_path).read_text(encoding="utf-8")
    rows = list(csv.DictReader(io.StringIO(text)))
    db = Database(sqlite3.connect(":memory:"))
    db["jobs"].insert_all(rows, pk="id")
    matched = list(db.query("SELECT id, name FROM jobs WHERE status = ? ORDER BY id", [status_filter]))
    Path(out_path).write_text(json.dumps(matched, sort_keys=True), encoding="utf-8")
    return {"total": db["jobs"].count, "matched": matched}
""",
            "run",
            ["jobs.csv", "failed", "failed_jobs.json"],
            {
                "label": "two_failed_jobs",
                "files": {"jobs.csv": "id,name,status\n1,etl,ok\n2,sync,failed\n3,index,failed\n"},
                "env": {},
            },
            {
                "label": "zero_failed_jobs",
                "files": {"jobs.csv": "id,name,status\n1,etl,ok\n2,sync,ok\n"},
                "env": {},
            },
            ["fs-io", "pathlib", "sqlite3"],
        )

    # 56. msiemens/tinydb + datetime timestamped job queue
    pkg = _load_pkg("msiemens__tinydb", "tinydb")
    if pkg:
        _add_pair(
            "msiemens__tinydb",
            "tinydb_job_lease",
            pkg,
            "job_lease.py",
            """import json
import time
from tinydb import Query, TinyDB
from tinydb.storages import MemoryStorage

def run(queue_path):
    with open(queue_path, "r", encoding="utf-8") as fh:
        jobs = json.load(fh)
    now = time.time()
    db = TinyDB(storage=MemoryStorage)
    db.insert_multiple(jobs)
    Job = Query()
    ready = db.search((Job.state == "queued") & (Job.run_after <= now))
    leased = []
    for j in ready:
        db.update({"state": "running", "leased_at": now}, Job.id == j["id"])
        leased.append(j["id"])
    with open(queue_path, "w", encoding="utf-8") as fh:
        fh.write(json.dumps(sorted(db.all(), key=lambda x: x["id"]), sort_keys=True))
    return {"leased": sorted(leased), "now": now}
""",
            "run",
            ["queue/jobs.json"],
            {
                "label": "two_jobs_ready",
                "files": {
                    "queue/jobs.json": json.dumps([
                        {"id": "j1", "state": "queued", "run_after": 1700000000.0},
                        {"id": "j2", "state": "queued", "run_after": 1705000000.0},
                        {"id": "j3", "state": "queued", "run_after": 1900000000.0},
                    ])
                },
                "env": {},
            },
            {
                "label": "none_ready_yet",
                "files": {
                    "queue/jobs.json": json.dumps([
                        {"id": "j1", "state": "done", "run_after": 1700000000.0},
                        {"id": "j3", "state": "queued", "run_after": 1900000000.0},
                    ])
                },
                "env": {},
            },
            ["fs-io", "time-io"],
        )

    # 57. sdispater/tomlkit + logging + env feature flag editor
    pkg = _load_pkg("sdispater__tomlkit", "tomlkit", max_files=40)
    if pkg:
        _add_pair(
            "sdispater__tomlkit",
            "tomlkit_toggle_feature",
            pkg,
            "toggle_feat.py",
            """import logging
import os
import tomlkit

def run(cfg_path, flag):
    with open(cfg_path, "r", encoding="utf-8") as fh:
        doc = tomlkit.parse(fh.read())
    desired = os.getenv("FLAG_STATE", "false").lower() == "true"
    prev = bool(doc["features"].get(flag, False))
    changed = prev != desired
    if changed:
        doc["features"][flag] = desired
        with open(cfg_path, "w", encoding="utf-8") as fh:
            fh.write(tomlkit.dumps(doc))
        logging.info("toggled %s: %s -> %s", flag, prev, desired)
    return {"flag": flag, "prev": prev, "now": desired, "changed": changed}
""",
            "run",
            ["flags.toml", "fast_search"],
            {
                "label": "toggle_on",
                "files": {"flags.toml": "[features]\nfast_search = false\n"},
                "env": {"FLAG_STATE": "true"},
            },
            {
                "label": "already_off_noop",
                "files": {"flags.toml": "[features]\nfast_search = false\n"},
                "env": {"FLAG_STATE": "false"},
            },
            ["fs-io", "env-io", "logging"],
        )

    # 58. Python-Markdown/markdown + pathlib + http remote markdown render
    pkg = _load_pkg("Python-Markdown__markdown", "markdown", max_files=40)
    if pkg:
        _add_pair(
            "Python-Markdown__markdown",
            "fetch_and_render_md",
            pkg,
            "remote_md.py",
            """import logging
import urllib.error
import urllib.request
from pathlib import Path
import markdown

def run(url, out_html):
    try:
        with urllib.request.urlopen(url) as resp:
            src = resp.read().decode("utf-8")
        html = markdown.markdown(src)
        Path(out_html).write_text(html, encoding="utf-8")
        return {"ok": True, "html": html}
    except urllib.error.HTTPError as exc:
        logging.error("failed fetching markdown %s: %s", url, exc.code)
        return {"ok": False, "status": exc.code}
""",
            "run",
            [f"{base_url}/notes.md", "out.html"],
            {
                "label": "http_200_rendered",
                "files": {},
                "env": {},
                "http_routes": {"/notes.md": (200, {"Content-Type": "text/markdown"}, b"# Notes\n\n**Bold** text.\n")},
            },
            {
                "label": "http_404_error",
                "files": {},
                "env": {},
                "http_routes": {"/notes.md": (404, {"Content-Type": "text/plain"}, b"missing")},
            },
            ["http-io", "fs-io", "pathlib", "logging"],
        )

    # 59. bottlepy/bottle + http json api to html report
    pkg = _load_pkg("bottlepy__bottle", ".", single_file="bottle.py")
    if pkg:
        _add_pair(
            "bottlepy__bottle",
            "http_status_dashboard_tpl",
            pkg,
            "dash_tpl.py",
            """import json
import urllib.request
from bottle import SimpleTemplate

def run(api_url, tpl_path, out_html):
    with urllib.request.urlopen(api_url) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    with open(tpl_path, "r", encoding="utf-8") as fh:
        tpl = fh.read()
    html = SimpleTemplate(tpl).render(**data)
    with open(out_html, "w", encoding="utf-8") as fh:
        fh.write(html)
    return {"healthy": data["healthy"], "html": html}
""",
            "run",
            [f"{base_url}/health", "dash.tpl", "dash.html"],
            {
                "label": "healthy_green",
                "files": {"dash.tpl": "<div class='{{status}}'>{{service}}: {{healthy}}</div>"},
                "env": {},
                "http_routes": {"/health": (200, {"Content-Type": "application/json"}, b'{"service":"auth","status":"ok","healthy":true}')},
            },
            {
                "label": "degraded_red",
                "files": {"dash.tpl": "<div class='{{status}}'>{{service}}: {{healthy}}</div>"},
                "env": {},
                "http_routes": {"/health": (200, {"Content-Type": "application/json"}, b'{"service":"auth","status":"degraded","healthy":false}')},
            },
            ["http-io", "fs-io"],
        )

    # 60. asottile/cfgv + pathlib + os.listdir multi-file config validator
    pkg = _load_pkg("asottile__cfgv", ".", single_file="cfgv.py")
    if pkg:
        _add_pair(
            "asottile__cfgv",
            "validate_jobs_dir",
            pkg,
            "jobs_validate.py",
            """import json
import os
import cfgv

JOB_SCHEMA = cfgv.Map(
    "Job", "id",
    cfgv.Required("id", cfgv.check_string),
    cfgv.Required("cron", cfgv.check_string),
    cfgv.Optional("enabled", cfgv.check_bool, True),
)

def run(jobs_dir, out_path):
    valid = []
    invalid = []
    for name in sorted(os.listdir(jobs_dir)):
        if not name.endswith(".json"):
            continue
        full = jobs_dir + "/" + name
        try:
            doc = cfgv.load_from_filename(full, JOB_SCHEMA, json.loads)
            valid.append(doc["id"])
        except cfgv.ValidationError:
            invalid.append(name)
    res = {"valid": valid, "invalid": invalid}
    with open(out_path, "w", encoding="utf-8") as fh:
        fh.write(json.dumps(res, sort_keys=True))
    return res
""",
            "run",
            ["jobs", "jobs_report.json"],
            {
                "label": "all_jobs_valid",
                "files": {
                    "jobs/nightly.json": json.dumps({"id": "nightly", "cron": "0 2 * * *"}),
                    "jobs/hourly.json": json.dumps({"id": "hourly", "cron": "0 * * * *", "enabled": False}),
                },
                "env": {},
            },
            {
                "label": "one_job_invalid",
                "files": {
                    "jobs/nightly.json": json.dumps({"id": "nightly", "cron": "0 2 * * *"}),
                    "jobs/broken.json": json.dumps({"id": "broken", "enabled": "yes"}),
                },
                "env": {},
            },
            ["fs-io"],
        )

    # 61. cpburnz/python-pathspec + subprocess git ls-files cross-check
    pkg = _load_pkg("cpburnz__python-pathspec", "pathspec", exclude_substrings=("tests/", "benchmark"))
    if pkg:
        _add_pair(
            "cpburnz__python-pathspec",
            "git_tracked_vs_ignore_audit",
            pkg,
            "tracked_ignore.py",
            """import logging
import subprocess
from pathspec import PathSpec

def run():
    with open(".gitignore", "r", encoding="utf-8") as fh:
        spec = PathSpec.from_lines("gitignore", fh.read().splitlines())
    cp = subprocess.run(["git", "ls-files"], capture_output=True, text=True, check=True)
    tracked = [l.strip() for l in cp.stdout.splitlines() if l.strip()]
    leaked = [f for f in tracked if f != ".gitignore" and spec.match_file(f)]
    if leaked:
        logging.warning("tracked files match .gitignore: %s", ",".join(leaked))
    return {"tracked": sorted(tracked), "leaked": sorted(leaked)}
""",
            "run",
            [],
            {
                "label": "leaked_secret_tracked",
                "files": {
                    ".gitignore": "*.pem\n*.log\n",
                    "app.py": "x = 1\n",
                    "cert.pem": "PRIVATE",
                },
                "init_git": True,
                "env": {},
            },
            {
                "label": "no_leaked_files",
                "files": {
                    ".gitignore": "*.pem\n*.log\n",
                    "app.py": "x = 1\n",
                    "README.md": "# ok\n",
                },
                "init_git": True,
                "env": {},
            },
            ["fs-io", "shell-exec", "logging"],
        )

    return scenarios


def harvest_python_stateful_oss(
    *,
    cache_dir: Path,
    output_dir: Path,
    benchmark_jsonl: Path,
    benchmark_manifest: Path,
    resume: bool = False,
) -> dict[str, Any]:
    output_dir.mkdir(parents=True, exist_ok=True)
    tasks_path = output_dir / "tasks.jsonl"
    errors_path = output_dir / "errors.jsonl"
    report_path = output_dir / "report.json"

    forbidden = _load_forbidden_benchmark(benchmark_jsonl, benchmark_manifest)
    existing_by_id: dict[str, dict[str, Any]] = {}
    if resume and tasks_path.exists():
        for line in tasks_path.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            row = json.loads(line)
            if isinstance(row.get("id"), str):
                existing_by_id[row["id"]] = row

    errors: list[dict[str, Any]] = []
    http_server = _DeterministicHttpServer()
    http_server.start()

    admitted: list[dict[str, Any]] = list(existing_by_id.values())
    seen_ids: set[str] = set(existing_by_id.keys())
    pair_groups_verified = 0

    try:
        scenarios = build_python_scenarios(cache_dir, http_server, errors)
        for scen in scenarios:
            repo = scen["repo"]
            slug = scen["slug"]
            repo_short = repo.split("__", 1)[-1].lower()
            if repo.lower() in forbidden["repos"] or repo_short in forbidden["repos"]:
                errors.append({"repo": repo, "slug": slug, "error": "repo forbidden by benchmark"})
                continue

            variant_rows: list[tuple[dict[str, Any], dict[str, Any], dict[str, Any]]] = []
            scen_ok = True
            for var in scen["variants"]:
                task_id = f"stateful-oss-py-{repo.replace('__', '-')}-{slug}-{var['suffix']}"
                if task_id in seen_ids:
                    scen_ok = False
                    break
                if task_id in forbidden["ids"]:
                    errors.append({"repo": repo, "slug": slug, "task_id": task_id, "error": "id collision with benchmark"})
                    scen_ok = False
                    break

                if var.get("http_routes"):
                    http_server.set_routes(var["http_routes"])
                else:
                    http_server.set_routes({})

                try:
                    probe = _run_live_capture(
                        files=scen["files"],
                        entry_file=scen["entry_file"],
                        source=None,
                        entry=scen["entry"],
                        args=scen["args"],
                        world_files=var.get("files") or {},
                        world_env=var.get("env") or {},
                        post_git_writes=var.get("post_git_writes"),
                        init_git=bool(var.get("init_git", False)),
                    )
                    if not probe.get("ok"):
                        raise RuntimeError(f"live probe failed: {probe.get('error')}")
                    recorded = probe.get("recordedCalls") or []
                    if not recorded:
                        raise RuntimeError("live probe recorded 0 external I/O calls")

                    family = f"stateful-oss-py/{repo}/{slug}"
                    split_comp = _sha256(f"stateful-oss-py:{repo}:{slug}")
                    if family in forbidden["families"] or split_comp in forbidden["split_components"]:
                        raise RuntimeError("family/split_component collision with benchmark")

                    task_obj: dict[str, Any] = {
                        "id": task_id,
                        "family": family,
                        "language": "py",
                        "files": scen["files"],
                        "entryFile": scen["entry_file"],
                        "entry": scen["entry"],
                        "initialLoadedFiles": [scen["entry_file"]],
                        "args": encode_readable(scen["args"]),
                        "fixture": {"calls": recorded},
                        "randomSeed": 17,
                        "tier": 5,
                        "features": list(scen["features"]),
                        "metadata": {
                            "repo": repo,
                            "scenario": slug,
                            "variant": var["suffix"],
                            "real_oss": True,
                            "stateful_io": True,
                            "touchedNonEntryFiles": probe.get("touchedFiles") or [],
                            **({"pair_id": scen["pair_id"]} if scen["kind"] == "pair" else {}),
                        },
                    }
                    exported, vstats = _verify_task_2x(task_obj)
                    if exported["sourceHash"] in forbidden["sourceHashes"]:
                        raise RuntimeError("sourceHash collision with benchmark")
                    exported["split_component"] = split_comp
                    if scen["kind"] == "pair":
                        exported["pair_id"] = scen["pair_id"]
                    variant_rows.append((exported, vstats, probe))
                except Exception as exc:
                    errors.append({
                        "repo": repo,
                        "slug": slug,
                        "variant": var["suffix"],
                        "task_id": task_id,
                        "error": str(exc),
                    })
                    scen_ok = False
                    break

            if not scen_ok or not variant_rows:
                continue

            if scen["kind"] == "pair":
                if len(variant_rows) != 2:
                    continue
                ex_a, _, _ = variant_rows[0]
                ex_b, _, _ = variant_rows[1]
                # Align traceFormat across pair variants if one variant fell back to actions-only
                fmt_a = (ex_a.get("metadata") or {}).get("traceFormat", "compact")
                fmt_b = (ex_b.get("metadata") or {}).get("traceFormat", "compact")
                if fmt_a != fmt_b:
                    try:
                        ex_a, _ = _verify_task_2x(ex_a["task"], trace_format="actions-only")
                        ex_b, _ = _verify_task_2x(ex_b["task"], trace_format="actions-only")
                        ex_a["split_component"] = variant_rows[0][0]["split_component"]
                        ex_b["split_component"] = variant_rows[1][0]["split_component"]
                        ex_a["pair_id"] = scen["pair_id"]
                        ex_b["pair_id"] = scen["pair_id"]
                        variant_rows[0] = (ex_a, variant_rows[0][1], variant_rows[0][2])
                        variant_rows[1] = (ex_b, variant_rows[1][1], variant_rows[1][2])
                    except Exception as exc:
                        errors.append({"repo": repo, "slug": slug, "stage": "pair_align", "error": str(exc)})
                        continue
                try:
                    pair_audit = _audit_causal_prefix_pair(ex_a["messages"], ex_b["messages"])
                    if not pair_audit.get("testedDivergence"):
                        raise RuntimeError("Counterfactual pair did not diverge on external observations")
                    ex_a["metadata"]["causalPairAudit"] = pair_audit
                    ex_b["metadata"]["causalPairAudit"] = pair_audit
                    pair_groups_verified += 1
                except Exception as exc:
                    # Retry pair with actions-only if compact thinking trace had hash-seed/id drift before divergence
                    try:
                        ex_a2, _ = _verify_task_2x(ex_a["task"], trace_format="actions-only")
                        ex_b2, _ = _verify_task_2x(ex_b["task"], trace_format="actions-only")
                        ex_a2["split_component"] = ex_a["split_component"]
                        ex_b2["split_component"] = ex_b["split_component"]
                        ex_a2["pair_id"] = scen["pair_id"]
                        ex_b2["pair_id"] = scen["pair_id"]
                        pair_audit = _audit_causal_prefix_pair(ex_a2["messages"], ex_b2["messages"])
                        if not pair_audit.get("testedDivergence"):
                            raise RuntimeError("Counterfactual pair did not diverge on external observations")
                        ex_a2["metadata"]["causalPairAudit"] = pair_audit
                        ex_b2["metadata"]["causalPairAudit"] = pair_audit
                        variant_rows[0] = (ex_a2, variant_rows[0][1], variant_rows[0][2])
                        variant_rows[1] = (ex_b2, variant_rows[1][1], variant_rows[1][2])
                        pair_groups_verified += 1
                    except Exception as exc2:
                        errors.append({
                            "repo": repo,
                            "slug": slug,
                            "stage": "causal_pair_audit",
                            "error": f"{exc} | retry: {exc2}",
                        })
                        continue

            for exported, _, _ in variant_rows:
                admitted.append(exported)
                seen_ids.add(exported["id"])
    finally:
        http_server.stop()

    with tasks_path.open("w", encoding="utf-8") as fh:
        for row in admitted:
            fh.write(json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n")
    with errors_path.open("w", encoding="utf-8") as fh:
        for err in errors:
            fh.write(json.dumps(err, ensure_ascii=False, separators=(",", ":")) + "\n")

    op_counts: dict[str, int] = {}
    repos_seen: set[str] = set()
    multifile_count = 0
    for row in admitted:
        meta = row.get("metadata") or {}
        if meta.get("repo"):
            repos_seen.add(meta["repo"])
        if meta.get("multifile"):
            multifile_count += 1
        for call in (row.get("task") or {}).get("fixture", {}).get("calls", []):
            op = call.get("operation", "unknown")
            op_counts[op] = op_counts.get(op, 0) + 1

    report = {
        "harvester": "tinker-harvest-stateful-oss-py",
        "total_tasks": len(admitted),
        "distinct_repos": len(repos_seen),
        "repos": sorted(repos_seen),
        "multifile_tasks": multifile_count,
        "causal_pair_groups": pair_groups_verified,
        "causal_pair_tasks": sum(1 for r in admitted if r.get("pair_id")),
        "external_op_call_counts": dict(sorted(op_counts.items())),
        "errors_count": len(errors),
        "tasks_path": str(tasks_path.resolve()),
        "errors_path": str(errors_path.resolve()),
    }
    report_path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description="Harvest messy real-world stateful-I/O Python OSS tasks.")
    parser.add_argument("--cache-dir", type=Path, default=DEFAULT_CACHE_DIR)
    parser.add_argument("--output-dir", type=Path, default=Path("runs/stateful-oss-harvest/py"))
    parser.add_argument("--benchmark-jsonl", type=Path, default=DEFAULT_BENCHMARK_JSONL)
    parser.add_argument("--benchmark-manifest", type=Path, default=DEFAULT_BENCHMARK_MANIFEST)
    parser.add_argument("--resume", action="store_true")
    args = parser.parse_args()

    report = harvest_python_stateful_oss(
        cache_dir=args.cache_dir,
        output_dir=args.output_dir,
        benchmark_jsonl=args.benchmark_jsonl,
        benchmark_manifest=args.benchmark_manifest,
        resume=args.resume,
    )
    print(json.dumps(report, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
