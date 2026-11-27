#!/usr/bin/env python3
"""Real multi-file Python OSS repository harvester for on-demand `code.load` tasks.

Walks local Python repositories, identifies cohesive multi-file packages (3-25
`.py` files including real sibling/distractor files), extracts unit-test call
inputs and arity-matched fallback probes, probes execution in an isolated
in-memory virtual codebase subprocess to keep only tasks that genuinely cross
into at least one non-entry file, and verifies 100% of admitted tasks through
`export_python_example(..., trace_format="compact")`.
"""

from __future__ import annotations

import argparse
import ast
import builtins
import concurrent.futures
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
from typing import Any
import warnings

warnings.filterwarnings("ignore", category=SyntaxWarning)

_REPO_ROOT = Path(__file__).resolve().parents[1]
_TRAINING_DIR = str(_REPO_ROOT / "training")
if _TRAINING_DIR not in sys.path:
    sys.path.insert(0, _TRAINING_DIR)

from tinker_py.codebase import CODE_LOAD_OPERATION, module_name_and_package_for  # noqa: E402
from tinker_py.codec import encode_readable  # noqa: E402
from tinker_py.execution import (  # noqa: E402
    assistant_thinking_text,
    assistant_visible_text,
    export_python_example,
)

SKIP_DIRS = frozenset({
    ".git",
    "__pycache__",
    "venv",
    ".venv",
    "env",
    "node_modules",
    "build",
    "dist",
    "migrations",
    "docs",
    "doc",
    "examples",
    "example",
    "benchmarks",
    "scripts",
    ".tox",
    ".mypy_cache",
    ".pytest_cache",
    "site-packages",
})

BLOCKED_STDLIB_MODULES = frozenset({
    "socket",
    "ctypes",
    "multiprocessing",
    "signal",
    "shutil",
    "ftplib",
    "smtplib",
    "imaplib",
    "poplib",
    "webbrowser",
    "venv",
    "ensurepip",
    "pip",
    "pty",
    "tty",
    "termios",
    "fcntl",
    "mmap",
    "ssl",
    "getpass",
    "curses",
    "readline",
    "rlcompleter",
    "tkinter",
    "turtle",
    "xmlrpc",
    "wsgiref",
    "socketserver",
})

STDLIB_MODULES = frozenset(getattr(sys, "stdlib_module_names", ())) | frozenset({
    "abc",
    "array",
    "ast",
    "base64",
    "binascii",
    "bisect",
    "builtins",
    "calendar",
    "cmath",
    "codecs",
    "collections",
    "contextlib",
    "copy",
    "csv",
    "dataclasses",
    "datetime",
    "decimal",
    "difflib",
    "enum",
    "errno",
    "fnmatch",
    "fractions",
    "functools",
    "hashlib",
    "heapq",
    "hmac",
    "html",
    "inspect",
    "io",
    "ipaddress",
    "itertools",
    "json",
    "keyword",
    "logging",
    "math",
    "numbers",
    "operator",
    "pprint",
    "random",
    "re",
    "statistics",
    "string",
    "struct",
    "sys",
    "textwrap",
    "time",
    "token",
    "tokenize",
    "types",
    "typing",
    "unicodedata",
    "urllib",
    "uuid",
    "warnings",
    "weakref",
    "xml",
    "zlib",
})

IGNORED_TEST_CALLEES = frozenset(dir(builtins)) | frozenset({
    "assertEqual",
    "assertNotEqual",
    "assertTrue",
    "assertFalse",
    "assertIs",
    "assertIsNot",
    "assertIsNone",
    "assertIsNotNone",
    "assertIn",
    "assertNotIn",
    "assertRaises",
    "assertRaisesRegex",
    "assertAlmostEqual",
    "assertCountEqual",
    "assertDictEqual",
    "assertListEqual",
    "assertSetEqual",
    "assertTupleEqual",
    "raises",
    "approx",
    "parametrize",
    "skip",
    "xfail",
    "fail",
    "main",
    "fixture",
})

FALLBACK_PROBES_BY_ARITY: dict[int, list[list[Any]]] = {
    0: [[]],
    1: [
        ["hello world, python 42!"],
        [[3, 1, 4, 1, 5, 9, 2]],
        [{"a": 1, "b": 2, "c": 3}],
        [12],
        ["https://example.com/path?x=1&y=2"],
        ["foo_bar_baz"],
        [[1, 2, 3, 4, 5]],
    ],
    2: [
        ["abracadabra", "abra"],
        [[3, 1, 4, 1, 5], 2],
        [18, 12],
        [{"a": 1, "b": 2}, {"b": 3, "c": 4}],
        ["hello world", "world"],
    ],
    3: [
        ["hello world", "world", "python"],
        [[1, 2, 3, 4, 5], 1, 4],
        [2, 5, 13],
    ],
}

_MULTIFILE_PROBE_SCRIPT = r"""
import builtins
import io
import json
import random
import signal
import sys
import time

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

def _timeout(_sig, _frame):
    raise TimeoutError("multifile probe timeout")

if hasattr(signal, "SIGALRM"):
    signal.signal(signal.SIGALRM, _timeout)
    signal.setitimer(signal.ITIMER_REAL, 6.0)

real_stdout = sys.stdout
try:
    req = json.loads(sys.stdin.read())
    files, entry_file, _init = normalize_codebase_files(req["files"], req["entryFile"])
    entry = req["entry"]
    args = decode_readable(req["args"])

    recorded = []
    rng = random.Random(17)
    time_counter = [0]
    io_depth = [0]
    real_time = time.time
    real_monotonic = time.monotonic
    real_random = random.random

    def _next_det_time():
        val = 1700000000.0 + time_counter[0] * 0.25
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
        if len(recorded) >= MAX_LIVE_CALLS:
            raise RuntimeError("too many recorded calls")
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
        if len(recorded) >= MAX_LIVE_CALLS:
            raise RuntimeError("too many recorded calls")
        val = _next_det_time()
        recorded.append({
            "operation": "platform.time",
            "arguments": [],
            "status": "fulfilled",
            "result": val,
        })
        return val

    def _rec_random():
        if not is_guest_caller(io_depth):
            return real_random()
        if len(recorded) >= MAX_LIVE_CALLS:
            raise RuntimeError("too many recorded calls")
        val = rng.random()
        recorded.append({
            "operation": "platform.random",
            "arguments": [],
            "status": "fulfilled",
            "result": val,
        })
        return val

    all_src = "\n".join(files.values())
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
    random.random = _rec_random

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

    guest_to_rel = {guest_filename_for(p): p for p in files}
    touched_non_entry = set()
    call_events = [0]

    def _call_trace(frame, event, _arg):
        if event != "call":
            return None
        rel = guest_to_rel.get(frame.f_code.co_filename)
        if rel is None:
            return None
        call_events[0] += 1
        if call_events[0] > 20000:
            raise RuntimeError("call event budget exceeded")
        if rel != entry_file:
            touched_non_entry.add(rel)
        return None

    sys.stdout = io.StringIO()
    kind = "return"
    try:
        entry_mod, _finder = load_virtual_entry_module(files, entry_file, guest_builtins, {})
        fn = getattr(entry_mod, entry, None)
        if not callable(fn):
            raise TypeError(f"Entry {entry!r} not callable")
        sys.settrace(_call_trace)
        try:
            result = fn(*args)
        except Exception as exc:
            kind = "throw"
            result = encode_exception(exc)
        finally:
            sys.settrace(None)
            flush_io()
    finally:
        sys.stdout = real_stdout
        if hasattr(signal, "SIGALRM"):
            signal.setitimer(signal.ITIMER_REAL, 0.0)

    enc_out = encode_readable({"arguments": args, "value": result})
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


def _json_compact(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def _sha256(value: Any) -> str:
    text = value if isinstance(value, str) else _json_compact(value)
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _slug(text: str) -> str:
    return re.sub(r"[^A-Za-z0-9_.-]+", "_", text).strip("_")[:64] or "mod"


def _is_test_file(rel_path: Path) -> bool:
    parts = {p.lower() for p in rel_path.parts[:-1]}
    if parts & {"tests", "test", "testing"}:
        return True
    name = rel_path.name.lower()
    return name.startswith("test_") or name.endswith("_test.py") or name == "conftest.py"


def _walk_py_files(repo_dir: Path) -> tuple[list[Path], list[Path]]:
    source_files: list[Path] = []
    test_files: list[Path] = []
    for root, dirs, files in os.walk(repo_dir):
        dirs[:] = sorted(d for d in dirs if d not in SKIP_DIRS and not d.endswith(".egg-info"))
        root_path = Path(root)
        for fname in sorted(files):
            if not fname.endswith(".py"):
                continue
            full = root_path / fname
            rel = full.relative_to(repo_dir)
            if _is_test_file(rel):
                test_files.append(full)
            else:
                source_files.append(full)
    return source_files, test_files


def _eval_const_expr(node: ast.AST, env: dict[str, Any], depth: int = 0) -> tuple[bool, Any]:
    if depth > 16:
        return False, None
    if isinstance(node, ast.Constant):
        if isinstance(node.value, (type(None), bool, int, float, str, bytes)):
            return True, node.value
        return False, None
    if isinstance(node, ast.Name):
        if node.id in env:
            return True, env[node.id]
        return False, None
    if isinstance(node, ast.UnaryOp) and isinstance(node.op, (ast.UAdd, ast.USub)):
        ok, val = _eval_const_expr(node.operand, env, depth + 1)
        if ok and isinstance(val, (int, float)) and not isinstance(val, bool):
            return True, (-val if isinstance(node.op, ast.USub) else +val)
        return False, None
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
        ok_l, left = _eval_const_expr(node.left, env, depth + 1)
        ok_r, right = _eval_const_expr(node.right, env, depth + 1)
        if ok_l and ok_r:
            if type(left) is type(right) and isinstance(left, (str, bytes, list, tuple)):
                return True, left + right
            if (
                isinstance(left, (int, float))
                and not isinstance(left, bool)
                and isinstance(right, (int, float))
                and not isinstance(right, bool)
            ):
                return True, left + right
        return False, None
    if isinstance(node, ast.List):
        items = []
        for elt in node.elts:
            ok, val = _eval_const_expr(elt, env, depth + 1)
            if not ok:
                return False, None
            items.append(val)
        return True, items
    if isinstance(node, ast.Tuple):
        items = []
        for elt in node.elts:
            ok, val = _eval_const_expr(elt, env, depth + 1)
            if not ok:
                return False, None
            items.append(val)
        return True, tuple(items)
    if isinstance(node, ast.Set):
        items = []
        for elt in node.elts:
            ok, val = _eval_const_expr(elt, env, depth + 1)
            if not ok:
                return False, None
            items.append(val)
        try:
            return True, set(items)
        except TypeError:
            return False, None
    if isinstance(node, ast.Dict):
        out: dict[Any, Any] = {}
        for k_node, v_node in zip(node.keys, node.values):
            if k_node is None:
                return False, None
            ok_k, kv = _eval_const_expr(k_node, env, depth + 1)
            ok_v, vv = _eval_const_expr(v_node, env, depth + 1)
            if not (ok_k and ok_v):
                return False, None
            try:
                out[kv] = vv
            except TypeError:
                return False, None
        return True, out
    if isinstance(node, ast.Call) and isinstance(node.func, ast.Name):
        if node.func.id == "set" and not node.args and not node.keywords:
            return True, set()
        if node.func.id == "dict" and not node.args and not node.keywords:
            return True, {}
        if node.func.id == "list" and not node.args and not node.keywords:
            return True, []
        if node.func.id == "tuple" and not node.args and not node.keywords:
            return True, ()
    return False, None


def _resolve_callee(node: ast.AST, aliases: dict[str, str]) -> str | None:
    if isinstance(node, ast.Name):
        return aliases.get(node.id, node.id)
    if isinstance(node, ast.Attribute):
        owner = node.value
        if isinstance(owner, ast.Name) and owner.id in ("self", "cls", "pytest", "unittest", "assert"):
            return None
        return node.attr
    return None


def _bind_loop_target(target: ast.AST, value: Any, env: dict[str, Any]) -> bool:
    if isinstance(target, ast.Name):
        env[target.id] = value
        return True
    if isinstance(target, (ast.Tuple, ast.List)):
        if not isinstance(value, (tuple, list)) or len(value) != len(target.elts):
            return False
        for sub_target, sub_val in zip(target.elts, value):
            if not _bind_loop_target(sub_target, sub_val, env):
                return False
        return True
    return False


def _extract_parametrize_envs(decorators: list[ast.expr], env: dict[str, Any]) -> list[dict[str, Any]]:
    envs: list[dict[str, Any]] = [{}]
    for dec in decorators:
        if not isinstance(dec, ast.Call):
            continue
        is_paramz = (
            (isinstance(dec.func, ast.Attribute) and dec.func.attr == "parametrize")
            or (isinstance(dec.func, ast.Name) and dec.func.id == "parametrize")
        )
        if not is_paramz:
            continue
        argnames_node: ast.AST | None = dec.args[0] if len(dec.args) >= 1 else None
        argvalues_node: ast.AST | None = dec.args[1] if len(dec.args) >= 2 else None
        for kw in dec.keywords:
            if kw.arg == "argnames" and argnames_node is None:
                argnames_node = kw.value
            elif kw.arg == "argvalues" and argvalues_node is None:
                argvalues_node = kw.value
        if argnames_node is None or argvalues_node is None:
            continue
        ok_names, raw_names = _eval_const_expr(argnames_node, env)
        if not ok_names:
            continue
        if isinstance(raw_names, str):
            names = [p.strip() for p in raw_names.split(",") if p.strip()]
        elif isinstance(raw_names, (list, tuple)) and all(isinstance(x, str) for x in raw_names):
            names = [x.strip() for x in raw_names if x.strip()]
        else:
            continue
        ok_rows, rows = _eval_const_expr(argvalues_node, env)
        if not ok_rows or not isinstance(rows, (list, tuple)) or not names:
            continue
        row_dicts: list[dict[str, Any]] = []
        if len(names) == 1:
            for r in rows:
                row_dicts.append({names[0]: r})
        else:
            for r in rows:
                if isinstance(r, (tuple, list)) and len(r) == len(names):
                    row_dicts.append(dict(zip(names, r)))
        if not row_dicts:
            continue
        combined: list[dict[str, Any]] = []
        for base in envs:
            for rd in row_dicts:
                combined.append({**base, **rd})
                if len(combined) >= 64:
                    break
            if len(combined) >= 64:
                break
        envs = combined
    return envs


def extract_unit_test_inputs(repo_dir: Path, test_files: list[Path]) -> dict[str, list[dict[str, Any]]]:
    """Extract real unit-test call inputs from test files via AST."""
    by_fn: dict[str, list[dict[str, Any]]] = {}
    seen_per_fn: dict[str, set[str]] = {}

    def record_call(fn_name: str, args: list[Any], rel_file: str) -> None:
        if fn_name.startswith("_") or fn_name in IGNORED_TEST_CALLEES:
            return
        try:
            encoded = encode_readable(args)
            sig = _json_compact(encoded)
        except Exception:
            return
        if len(sig) > 6000:
            return
        seen = seen_per_fn.setdefault(fn_name, set())
        if sig in seen:
            return
        seen.add(sig)
        by_fn.setdefault(fn_name, []).append({"args": encoded, "file": rel_file})

    def scan_expr(node: ast.AST, env: dict[str, Any], aliases: dict[str, str], rel_file: str) -> None:
        for sub in ast.walk(node):
            if isinstance(sub, ast.Call):
                if sub.keywords or any(isinstance(a, ast.Starred) for a in sub.args):
                    continue
                callee = _resolve_callee(sub.func, aliases)
                if not callee or callee.startswith("_") or callee in IGNORED_TEST_CALLEES:
                    continue
                vals: list[Any] = []
                ok_all = True
                for a in sub.args:
                    ok, v = _eval_const_expr(a, env)
                    if not ok:
                        ok_all = False
                        break
                    vals.append(v)
                if ok_all:
                    record_call(callee, vals, rel_file)

    def walk_body(stmts: list[ast.stmt], env: dict[str, Any], aliases: dict[str, str], rel_file: str) -> None:
        local_env = dict(env)
        for stmt in stmts:
            if isinstance(stmt, ast.Assign):
                scan_expr(stmt.value, local_env, aliases, rel_file)
                ok, val = _eval_const_expr(stmt.value, local_env)
                if ok:
                    for tgt in stmt.targets:
                        if isinstance(tgt, ast.Name):
                            local_env[tgt.id] = val
            elif isinstance(stmt, ast.For):
                ok, seq = _eval_const_expr(stmt.iter, local_env)
                if ok and isinstance(seq, (list, tuple)):
                    for item in list(seq)[:32]:
                        iter_env = dict(local_env)
                        if _bind_loop_target(stmt.target, item, iter_env):
                            walk_body(stmt.body, iter_env, aliases, rel_file)
                else:
                    walk_body(stmt.body, local_env, aliases, rel_file)
            elif isinstance(stmt, (ast.If, ast.With)):
                scan_expr(stmt, local_env, aliases, rel_file)
                walk_body(stmt.body, local_env, aliases, rel_file)
                if isinstance(stmt, ast.If):
                    walk_body(stmt.orelse, local_env, aliases, rel_file)
            else:
                scan_expr(stmt, local_env, aliases, rel_file)

    for tf in test_files:
        try:
            text = tf.read_text(encoding="utf-8", errors="ignore")
            tree = ast.parse(text)
        except Exception:
            continue
        rel_file = str(tf.relative_to(repo_dir))
        aliases: dict[str, str] = {}
        mod_env: dict[str, Any] = {}
        for stmt in tree.body:
            if isinstance(stmt, ast.ImportFrom):
                for a in stmt.names:
                    if a.asname:
                        aliases[a.asname] = a.name
            elif isinstance(stmt, ast.Assign):
                ok, val = _eval_const_expr(stmt.value, mod_env)
                if ok:
                    for tgt in stmt.targets:
                        if isinstance(tgt, ast.Name):
                            mod_env[tgt.id] = val
            elif isinstance(stmt, ast.FunctionDef):
                for p_env in _extract_parametrize_envs(stmt.decorator_list, mod_env):
                    walk_body(stmt.body, {**mod_env, **p_env}, aliases, rel_file)
            elif isinstance(stmt, ast.ClassDef):
                cls_env = dict(mod_env)
                for item in stmt.body:
                    if isinstance(item, ast.Assign):
                        ok, val = _eval_const_expr(item.value, cls_env)
                        if ok:
                            for tgt in item.targets:
                                if isinstance(tgt, ast.Name):
                                    cls_env[tgt.id] = val
                    elif isinstance(item, ast.FunctionDef):
                        for p_env in _extract_parametrize_envs(item.decorator_list, cls_env):
                            walk_body(item.body, {**cls_env, **p_env}, aliases, rel_file)
    return by_fn


def _fn_arity_bounds(fn_node: ast.FunctionDef) -> tuple[int, int | None]:
    args = fn_node.args
    pos_count = len(args.posonlyargs) + len(args.args)
    default_count = len(args.defaults)
    min_arity = max(0, pos_count - default_count)
    # Require no mandatory keyword-only args without defaults.
    for kw, kw_def in zip(args.kwonlyargs, args.kw_defaults):
        if kw_def is None:
            return (99, 99)
    max_arity = None if args.vararg is not None else pos_count
    return min_arity, max_arity


def _resolve_internal_imports(
    rel_path: str,
    tree: ast.Module,
    mod_to_rel: dict[str, str],
) -> tuple[set[str], set[str]]:
    """Return (internal_target_rel_paths, unconditional_external_top_modules)."""
    cur_mod, cur_pkg = module_name_and_package_for(rel_path)
    internal: set[str] = set()
    external_top: set[str] = set()

    def _add_mod_if_internal(mod_name: str) -> bool:
        if mod_name in mod_to_rel:
            target = mod_to_rel[mod_name]
            if target != rel_path:
                internal.add(target)
            return True
        return False

    # Inspect all imports for intra-package edges, and top-level body imports for unconditional external deps.
    top_level_nodes = set(id(n) for n in tree.body if isinstance(n, (ast.Import, ast.ImportFrom)))

    for node in ast.walk(tree):
        is_unconditional = id(node) in top_level_nodes
        if isinstance(node, ast.Import):
            for alias in node.names:
                name = alias.name
                matched = _add_mod_if_internal(name)
                if not matched:
                    top = name.split(".", 1)[0]
                    if not any(m == top or m.startswith(top + ".") for m in mod_to_rel):
                        if is_unconditional:
                            external_top.add(top)
        elif isinstance(node, ast.ImportFrom):
            level = node.level or 0
            if level > 0:
                pkg_parts = cur_pkg.split(".") if cur_pkg else []
                up = level - 1
                base_parts = pkg_parts[: len(pkg_parts) - up] if up <= len(pkg_parts) else []
                if node.module:
                    base_mod = ".".join([*base_parts, *node.module.split(".")])
                else:
                    base_mod = ".".join(base_parts)
                if base_mod:
                    _add_mod_if_internal(base_mod)
                for alias in node.names:
                    if alias.name == "*":
                        continue
                    sub = f"{base_mod}.{alias.name}" if base_mod else alias.name
                    _add_mod_if_internal(sub)
            elif node.module:
                matched = _add_mod_if_internal(node.module)
                for alias in node.names:
                    if alias.name == "*":
                        continue
                    if _add_mod_if_internal(f"{node.module}.{alias.name}"):
                        matched = True
                if not matched:
                    top = node.module.split(".", 1)[0]
                    if not any(m == top or m.startswith(top + ".") for m in mod_to_rel):
                        if is_unconditional:
                            external_top.add(top)
    return internal, external_top


def _discover_package_sets(
    repo_dir: Path,
    *,
    min_files: int,
    max_files: int,
    max_single_file_bytes: int = 60_000,
    max_package_bytes: int = 220_000,
) -> list[dict[str, Any]]:
    """Discover candidate multi-file package layouts inside a repository."""
    source_files, _ = _walk_py_files(repo_dir)
    if len(source_files) < min_files:
        return []

    # Group by outermost package directory (directory with __init__.py whose parent has no __init__.py).
    pkg_roots: list[tuple[Path, Path]] = []  # (import_root, pkg_dir)
    seen_pkg_dirs: set[Path] = set()

    for sf in source_files:
        if sf.name == "__init__.py":
            cur = sf.parent
            while cur != repo_dir and (cur.parent / "__init__.py").exists():
                cur = cur.parent
            if cur != repo_dir and cur not in seen_pkg_dirs:
                seen_pkg_dirs.add(cur)
                pkg_roots.append((cur.parent, cur))
            # Also allow direct subpackages inside large packages as standalone import roots if self-contained.
            if sf.parent != cur and sf.parent != repo_dir and sf.parent not in seen_pkg_dirs:
                seen_pkg_dirs.add(sf.parent)
                pkg_roots.append((sf.parent.parent, sf.parent))

    # Fallback: flat multi-file directory if no __init__.py packages exist.
    if not pkg_roots:
        by_dir: dict[Path, list[Path]] = {}
        for sf in source_files:
            if sf.name in ("setup.py", "conftest.py"):
                continue
            by_dir.setdefault(sf.parent, []).append(sf)
        for d, flist in sorted(by_dir.items()):
            if len(flist) >= min_files:
                pkg_roots.append((d, d))

    package_bundles: list[dict[str, Any]] = []
    for import_root, pkg_dir in pkg_roots:
        files_map: dict[str, str] = {}
        trees_map: dict[str, ast.Module] = {}
        for sf in source_files:
            try:
                sf.relative_to(pkg_dir)
            except ValueError:
                continue
            if sf.name == "setup.py":
                continue
            try:
                raw_bytes = sf.read_bytes()
            except OSError:
                continue
            if len(raw_bytes) == 0 or len(raw_bytes) > max_single_file_bytes:
                continue
            text = raw_bytes.decode("utf-8", errors="ignore")
            try:
                tree = ast.parse(text)
            except SyntaxError:
                continue
            rel_path = sf.relative_to(import_root).as_posix()
            files_map[rel_path] = text
            trees_map[rel_path] = tree

        if len(files_map) < min_files:
            continue

        mod_to_rel: dict[str, str] = {}
        for rel_path in files_map:
            mod, _ = module_name_and_package_for(rel_path)
            mod_to_rel[mod] = rel_path

        edges: dict[str, set[str]] = {}
        ext_imports: dict[str, set[str]] = {}
        for rel_path, tree in trees_map.items():
            internal, ext = _resolve_internal_imports(rel_path, tree, mod_to_rel)
            edges[rel_path] = internal
            ext_imports[rel_path] = ext

        package_bundles.append({
            "pkgName": pkg_dir.name,
            "files": files_map,
            "trees": trees_map,
            "edges": edges,
            "extImports": ext_imports,
            "modToRel": mod_to_rel,
            "maxPackageBytes": max_package_bytes,
            "minFiles": min_files,
            "maxFiles": max_files,
        })

    return package_bundles


def _select_subpackage_for_entry(
    bundle: dict[str, Any],
    entry_rel: str,
) -> dict[str, str] | None:
    """Return a bounded 3..max_files file subset for `entry_rel` including real distractors."""
    all_files: dict[str, str] = bundle["files"]
    edges: dict[str, set[str]] = bundle["edges"]
    ext_imports: dict[str, set[str]] = bundle["extImports"]
    min_files: int = bundle["minFiles"]
    max_files: int = bundle["maxFiles"]
    max_pkg_bytes: int = bundle["maxPackageBytes"]

    # Compute transitive intra-package import closure + parent __init__.py files.
    closure: set[str] = {entry_rel}
    queue = [entry_rel]
    while queue:
        cur = queue.pop(0)
        # Include parent __init__.py files along path.
        parts = cur.split("/")
        for i in range(1, len(parts)):
            init_rel = "/".join(parts[:i]) + "/__init__.py"
            if init_rel in all_files and init_rel not in closure:
                closure.add(init_rel)
                queue.append(init_rel)
        for dep in sorted(edges.get(cur, ())):
            if dep not in closure:
                closure.add(dep)
                queue.append(dep)

    # Must statically reference at least 1 other non-entry file.
    if len(closure) < 2:
        return None
    if len(closure) > max_files:
        return None

    # Check that unconditional imports inside the closure are portable pure Python + allowed stdlib.
    for rel in closure:
        for ext_mod in ext_imports.get(rel, ()):
            if ext_mod in BLOCKED_STDLIB_MODULES or ext_mod not in STDLIB_MODULES:
                return None

    # If the entire package fits within [min_files, max_files] and size budget, keep it verbatim!
    total_all_bytes = sum(len(s.encode("utf-8")) for s in all_files.values())
    if min_files <= len(all_files) <= max_files and total_all_bytes <= max_pkg_bytes:
        return dict(sorted(all_files.items()))

    # Otherwise, start with closure and add real sibling/distractor files from the same package.
    selected: dict[str, str] = {p: all_files[p] for p in sorted(closure)}
    used_bytes = sum(len(s.encode("utf-8")) for s in selected.values())
    if used_bytes > max_pkg_bytes:
        return None

    entry_dir = entry_rel.rsplit("/", 1)[0] if "/" in entry_rel else ""
    distractor_candidates = [p for p in sorted(all_files.keys()) if p not in selected]
    # Prefer same-directory siblings first, then deterministic other files in the package.
    distractor_candidates.sort(
        key=lambda p: (
            0 if (p.rsplit("/", 1)[0] if "/" in p else "") == entry_dir else 1,
            len(all_files[p]),
            p,
        )
    )
    target_count = min(max_files, max(min_files, len(selected) + 5))
    for p in distractor_candidates:
        if len(selected) >= target_count:
            break
        b = len(all_files[p].encode("utf-8"))
        if used_bytes + b > max_pkg_bytes:
            continue
        selected[p] = all_files[p]
        used_bytes += b

    if len(selected) < min_files:
        return None
    return dict(sorted(selected.items()))


def _probe_multifile(files: dict[str, str], entry_file: str, entry: str, encoded_args: list[Any]) -> dict[str, Any]:
    payload = _json_compact({
        "files": files,
        "entryFile": entry_file,
        "entry": entry,
        "args": encoded_args,
    })
    try:
        with tempfile.TemporaryDirectory(prefix="py-mf-probe-") as tmpdir:
            proc = subprocess.run(
                [sys.executable, "-c", _MULTIFILE_PROBE_SCRIPT, _TRAINING_DIR],
                input=payload,
                capture_output=True,
                text=True,
                cwd=tmpdir,
                timeout=6.0,
                check=False,
            )
        out = proc.stdout.strip()
        if not out:
            return {"ok": False, "error": proc.stderr.strip()[-200:] or "empty probe output"}
        return json.loads(out.splitlines()[-1])
    except Exception as exc:
        return {"ok": False, "error": f"{type(exc).__name__}: {exc}"}


def _smart_probes_for_fn(fn_node: ast.FunctionDef, min_arity: int, max_arity: int | None) -> list[list[Any]]:
    arg_names = [a.arg.lower() for a in [*fn_node.args.posonlyargs, *fn_node.args.args]]
    probes: list[list[Any]] = []

    def _guess_for_name(name: str) -> list[Any]:
        if any(k in name for k in ("url", "uri", "link", "href")):
            return ["https://example.com/a/b?k=1"]
        if any(k in name for k in ("text", "str", "msg", "line", "word", "name", "title", "slug", "html", "sql", "code", "src", "s")):
            return ["hello world 123", "foo_bar-baz"]
        if any(k in name for k in ("dict", "map", "cfg", "config", "obj", "data", "mapping", "kwargs")):
            return [{"a": 1, "b": 2, "c": 3}]
        if any(k in name for k in ("items", "vals", "values", "nums", "list", "seq", "arr", "tokens", "xs")):
            return [[3, 1, 4, 1, 5], ["alpha", "beta", "gamma"]]
        if any(k in name for k in ("num", "count", "size", "limit", "index", "idx", "n", "x", "y", "k")):
            return [12, 5]
        return []

    if min_arity == 1 and arg_names:
        for val in _guess_for_name(arg_names[0]):
            probes.append([val])
    elif min_arity == 2 and len(arg_names) >= 2:
        g0 = _guess_for_name(arg_names[0])
        g1 = _guess_for_name(arg_names[1])
        if g0 and g1:
            probes.append([g0[0], g1[0]])

    fallback_arity = min_arity if min_arity in FALLBACK_PROBES_BY_ARITY else (
        max_arity if max_arity in FALLBACK_PROBES_BY_ARITY else None
    )
    if fallback_arity is not None:
        probes.extend(FALLBACK_PROBES_BY_ARITY[fallback_arity])
    return probes


def harvest_repo_multifile(
    repo_dir: Path,
    *,
    max_per_repo: int,
    max_per_fn: int,
    min_files: int,
    max_files: int,
    min_code_loads: int,
    drop_probe_type_errors: bool = True,
) -> list[dict[str, Any]]:
    repo_name = _slug(repo_dir.name)
    _, test_files = _walk_py_files(repo_dir)
    unit_inputs = extract_unit_test_inputs(repo_dir, test_files)
    bundles = _discover_package_sets(repo_dir, min_files=min_files, max_files=max_files)

    unit_candidates: list[dict[str, Any]] = []
    probe_candidates: list[dict[str, Any]] = []
    repo_cap = max_per_repo * 3
    fn_probe_cap = max(max_per_fn * 2, max_per_fn + 2)

    for bundle in bundles:
        if len(unit_candidates) >= repo_cap:
            break
        pkg_name = _slug(bundle["pkgName"])
        for entry_rel in sorted(bundle["files"].keys()):
            if len(unit_candidates) >= repo_cap:
                break
            if entry_rel.endswith("/__init__.py") or entry_rel == "__init__.py":
                # Allow __init__.py only if it defines public functions directly
                pass
            selected_files = _select_subpackage_for_entry(bundle, entry_rel)
            if selected_files is None:
                continue

            tree: ast.Module = bundle["trees"][entry_rel]
            mod_slug = _slug(entry_rel[:-3] if entry_rel.endswith(".py") else entry_rel)

            fn_nodes = [
                s for s in tree.body
                if isinstance(s, ast.FunctionDef) and not s.name.startswith("_")
            ]
            # Prioritize functions that have unit-test inputs first, then limit per file to keep scanning fast.
            fn_nodes.sort(key=lambda s: (0 if s.name in unit_inputs else 1, s.lineno))
            for stmt in fn_nodes[:25]:
                if len(unit_candidates) >= repo_cap:
                    break
                min_arity, max_arity = _fn_arity_bounds(stmt)
                if min_arity > 4:
                    continue

                probes: list[tuple[list[Any], bool, str | None]] = []
                for u_entry in unit_inputs.get(stmt.name, []):
                    arg_len = len(u_entry["args"])
                    if arg_len >= min_arity and (max_arity is None or arg_len <= max_arity):
                        probes.append((u_entry["args"], True, u_entry["file"]))

                if len(probes) < max_per_fn and len(probe_candidates) < repo_cap:
                    for raw_args in _smart_probes_for_fn(stmt, min_arity, max_arity):
                        probes.append((encode_readable(raw_args), False, None))

                kept_for_fn = 0
                kept_unit_for_fn = 0
                seen_sigs: set[str] = set()
                for encoded_args, from_unit_test, test_file in probes:
                    if from_unit_test:
                        if kept_unit_for_fn >= fn_probe_cap or len(unit_candidates) >= repo_cap:
                            continue
                    else:
                        if kept_for_fn >= fn_probe_cap or len(probe_candidates) >= repo_cap:
                            break
                    sig = _json_compact(encoded_args)
                    if sig in seen_sigs:
                        continue
                    seen_sigs.add(sig)

                    probe = _probe_multifile(selected_files, entry_rel, stmt.name, encoded_args)
                    if not probe.get("ok"):
                        continue
                    touched = probe.get("touchedFiles") or []
                    if len(touched) < min_code_loads:
                        continue
                    if drop_probe_type_errors and not from_unit_test and probe.get("kind") == "throw":
                        val = (probe.get("result") or {}).get("value")
                        if isinstance(val, dict) and val.get("name") in ("TypeError", "AttributeError"):
                            continue

                    recorded_calls = probe.get("recordedCalls") or []
                    uses_tool_random = any(c["operation"] == "platform.random" for c in recorded_calls)
                    distractors = sorted(
                        p for p in selected_files.keys() if p != entry_rel and p not in touched
                    )
                    features = ["multifile-codebase", "code-load"]
                    if from_unit_test:
                        features.append("unit-test-input")
                    if distractors:
                        features.append("distractor-files")
                    if recorded_calls:
                        features.append("effectful")
                    origin = "py-multifile-unit-test" if from_unit_test else "py-multifile-probe"
                    task: dict[str, Any] = {
                        "id": f"pymf-{repo_name}-{mod_slug}-{stmt.name}-{kept_for_fn}",
                        "family": f"py-multifile:{repo_name}:{pkg_name}:{mod_slug}:{stmt.name}",
                        "language": "py",
                        "files": selected_files,
                        "entryFile": entry_rel,
                        "entry": stmt.name,
                        "args": encoded_args,
                        "randomMode": "tool" if uses_tool_random else "seeded",
                        "randomSeed": 17,
                        "fixture": {"calls": recorded_calls},
                        "features": features,
                        "metadata": {
                            "repo": repo_name,
                            "package": pkg_name,
                            "entryFile": entry_rel,
                            "testFile": test_file,
                            "sourceOrigin": origin,
                            "touchedFiles": touched,
                            "distractorFiles": distractors,
                            "distractorCount": len(distractors),
                            "lineage": [
                                f"py-repo:{repo_name}",
                                f"py-pkg:{repo_name}:{pkg_name}",
                                f"py-fn:{repo_name}:{mod_slug}:{stmt.name}",
                            ],
                        },
                    }
                    cand = {"repo": repo_name, "origin": origin, "task": task}
                    if from_unit_test:
                        unit_candidates.append(cand)
                        kept_unit_for_fn += 1
                    else:
                        probe_candidates.append(cand)
                    kept_for_fn += 1

    return [*unit_candidates, *probe_candidates]


def _qualify_multifile_candidate(
    cand: dict[str, Any],
    *,
    min_code_loads: int,
    min_trace_lines: int,
    max_conversation_chars: int,
    drop_probe_type_errors: bool,
) -> dict[str, Any]:
    task = cand["task"]
    try:
        exported = export_python_example(task, trace_format="compact")
        audit = exported["metadata"]["traceAudit"]
        if not audit.get("replayVerified"):
            return {
                "status": "refused",
                "reason": "replay-not-verified",
                "id": task["id"],
                "repo": cand["repo"],
                "origin": cand["origin"],
                "family": task["family"],
            }

        code_load_calls = int(exported["metadata"].get("codeLoadCalls", 0))
        if code_load_calls < min_code_loads:
            return {
                "status": "refused",
                "reason": f"insufficient-code-loads ({code_load_calls} < {min_code_loads})",
                "id": task["id"],
                "repo": cand["repo"],
                "origin": cand["origin"],
                "family": task["family"],
            }

        messages = exported["messages"]
        trace_chars = sum(
            len(assistant_thinking_text(m)) + len(assistant_visible_text(m))
            for m in messages
            if m.get("role") == "assistant"
        )
        conv_chars = len(_json_compact(messages))
        if conv_chars > max_conversation_chars:
            return {
                "status": "refused",
                "reason": f"conversation-too-long ({conv_chars} chars)",
                "id": task["id"],
                "repo": cand["repo"],
                "origin": cand["origin"],
                "family": task["family"],
            }

        narration_lines = int(audit["narrationLines"])
        if min_trace_lines > 0 and narration_lines < min_trace_lines:
            return {
                "status": "refused",
                "reason": f"trace-too-short ({narration_lines} < {min_trace_lines})",
                "id": task["id"],
                "repo": cand["repo"],
                "origin": cand["origin"],
                "family": task["family"],
            }

        if drop_probe_type_errors and cand["origin"] == "py-multifile-probe":
            final_msg = messages[-1]
            final_vis = assistant_visible_text(final_msg)
            fence_match = re.search(r"```json\s*([\s\S]*?)```", final_vis)
            comp = json.loads(fence_match.group(1)) if fence_match else {}
            comp_val = comp.get("value")
            if comp.get("kind") == "throw" and isinstance(comp_val, dict) and comp_val.get("name") in ("TypeError", "AttributeError"):
                return {
                    "status": "refused",
                    "reason": f"probe-{comp_val['name']}",
                    "id": task["id"],
                    "repo": cand["repo"],
                    "origin": cand["origin"],
                    "family": task["family"],
                }

        # Collect actual loaded paths from teacher's code.load tool calls.
        loaded_paths: set[str] = {task["entryFile"]}
        for msg in messages:
            if msg.get("role") == "assistant" and isinstance(msg.get("tool_calls"), list):
                for tc in msg["tool_calls"]:
                    fn = tc.get("function") or {}
                    if fn.get("name") == CODE_LOAD_OPERATION:
                        raw_a = json.loads(fn.get("arguments") or "{}")
                        for req in raw_a.get("arguments") or []:
                            if isinstance(req, dict) and isinstance(req.get("path"), str):
                                loaded_paths.add(req["path"])

        distractor_files = sorted(p for p in exported["task"]["files"] if p not in loaded_paths)
        enriched_task = {
            **exported["task"],
            "metadata": {
                **(task.get("metadata") or {}),
                "sourceHash": exported["sourceHash"],
                "fileCount": len(exported["task"]["files"]),
                "loadedFileCount": len(loaded_paths),
                "distractorFiles": distractor_files,
                "distractorCount": len(distractor_files),
                "codeLoadCalls": code_load_calls,
                "codeLoadBytes": int(exported["metadata"].get("codeLoadBytes", 0)),
                "externalCalls": len(exported["task"]["fixture"]["calls"]),
                "traceChars": trace_chars,
                "conversationChars": conv_chars,
                "estimatedTokens": conv_chars // 4,
                "narrationLines": narration_lines,
                "replayVerified": True,
            },
        }
        return {
            "status": "admitted",
            "id": task["id"],
            "repo": cand["repo"],
            "origin": cand["origin"],
            "family": task["family"],
            "sourceHash": exported["sourceHash"],
            "task": enriched_task,
        }
    except Exception as exc:
        return {
            "status": "refused",
            "reason": f"{type(exc).__name__}: {str(exc)[:180]}",
            "id": task["id"],
            "repo": cand["repo"],
            "origin": cand["origin"],
            "family": task["family"],
        }


def _stats(vals: list[int]) -> dict[str, int] | None:
    if not vals:
        return None
    s = sorted(vals)
    return {
        "min": s[0],
        "median": s[len(s) // 2],
        "p90": s[int(len(s) * 0.9)],
        "max": s[-1],
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Harvest verified multi-file Python execution tasks from local OSS repos.")
    parser.add_argument(
        "--local-repos",
        required=True,
        nargs="+",
        help="One or more directories containing local Python repository folders.",
    )
    parser.add_argument(
        "--output-dir",
        default="runs/tinker-harvest-multifile-py",
        help="Output directory for harvested.jsonl and census.json.",
    )
    parser.add_argument("--max-repos", type=int, default=0, help="Optional cap on total repositories scanned (0 = all).")
    parser.add_argument("--jobs", type=int, default=4, help="Parallel qualification workers.")
    parser.add_argument("--max-per-repo", type=int, default=20, help="Max admitted tasks per repo.")
    parser.add_argument("--max-per-fn", type=int, default=3, help="Max admitted inputs per function.")
    parser.add_argument("--min-files", type=int, default=3, help="Minimum .py files per task package.")
    parser.add_argument("--max-files", type=int, default=25, help="Maximum .py files per task package.")
    parser.add_argument("--min-code-loads", type=int, default=1, help="Minimum code.load calls required.")
    parser.add_argument("--min-trace-lines", type=int, default=2, help="Minimum compact trace lines required.")
    parser.add_argument(
        "--max-conversation-chars",
        type=int,
        default=180_000,
        help="Maximum total serialized conversation chars (default 180k, well within 65k tokens).",
    )
    parser.add_argument(
        "--drop-probe-type-errors",
        dest="drop_probe_type_errors",
        action="store_true",
        default=True,
    )
    parser.add_argument(
        "--keep-probe-type-errors",
        dest="drop_probe_type_errors",
        action="store_false",
    )
    args = parser.parse_args(argv)

    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    jobs = max(1, min(16, args.jobs))

    started = datetime.now(timezone.utc).isoformat()
    repo_dirs: list[Path] = []
    for raw_root in args.local_repos:
        root = Path(raw_root).resolve()
        if not root.exists():
            continue
        if (root / ".git").exists():
            repo_dirs.append(root)
            continue
        subdirs = sorted(
            p for p in root.iterdir()
            if p.is_dir() and p.name not in SKIP_DIRS and not p.name.startswith(".")
        )
        if subdirs:
            repo_dirs.extend(subdirs)
        elif any(root.glob("*.py")):
            repo_dirs.append(root)

    if args.max_repos and args.max_repos > 0:
        repo_dirs = repo_dirs[: args.max_repos]

    def _harvest_one(rdir: Path) -> list[dict[str, Any]]:
        return harvest_repo_multifile(
            rdir,
            max_per_repo=args.max_per_repo,
            max_per_fn=args.max_per_fn,
            min_files=args.min_files,
            max_files=args.max_files,
            min_code_loads=args.min_code_loads,
            drop_probe_type_errors=args.drop_probe_type_errors,
        )

    all_candidates: list[dict[str, Any]] = []
    if repo_dirs:
        if jobs == 1:
            for rdir in repo_dirs:
                all_candidates.extend(_harvest_one(rdir))
        else:
            with concurrent.futures.ThreadPoolExecutor(max_workers=jobs) as pool:
                for cands in pool.map(_harvest_one, repo_dirs):
                    all_candidates.extend(cands)

    def _qualify(cand: dict[str, Any]) -> dict[str, Any]:
        return _qualify_multifile_candidate(
            cand,
            min_code_loads=args.min_code_loads,
            min_trace_lines=args.min_trace_lines,
            max_conversation_chars=args.max_conversation_chars,
            drop_probe_type_errors=args.drop_probe_type_errors,
        )

    records: list[dict[str, Any]] = []
    if all_candidates:
        if jobs == 1:
            records = [_qualify(c) for c in all_candidates]
        else:
            with concurrent.futures.ThreadPoolExecutor(max_workers=jobs) as pool:
                records = list(pool.map(_qualify, all_candidates))

    records.sort(key=lambda r: 0 if r["origin"] == "py-multifile-unit-test" else 1)

    seen_dedup: set[tuple[str, str]] = set()
    repo_counts: dict[str, int] = {}
    fn_counts: dict[str, int] = {}
    admitted: list[dict[str, Any]] = []
    by_repo: dict[str, dict[str, int]] = {}
    by_origin: dict[str, dict[str, int]] = {}
    refusals: dict[str, int] = {}

    for rec in records:
        r_stat = by_repo.setdefault(rec["repo"], {"candidates": 0, "admitted": 0})
        r_stat["candidates"] += 1
        o_stat = by_origin.setdefault(rec["origin"], {"candidates": 0, "admitted": 0})
        o_stat["candidates"] += 1
        if rec["status"] != "admitted":
            key = re.sub(r"\d+", "N", rec["reason"])[:100]
            refusals[key] = refusals.get(key, 0) + 1
            continue
        if repo_counts.get(rec["repo"], 0) >= args.max_per_repo:
            continue
        if fn_counts.get(rec["family"], 0) >= args.max_per_fn:
            continue
        task = rec["task"]
        input_sig = _sha256([task["entryFile"], task["entry"], task["args"], task["fixture"]])
        dedup_key = (rec["sourceHash"], input_sig)
        if dedup_key in seen_dedup:
            continue
        seen_dedup.add(dedup_key)
        repo_counts[rec["repo"]] = repo_counts.get(rec["repo"], 0) + 1
        fn_counts[rec["family"]] = fn_counts.get(rec["family"], 0) + 1
        r_stat["admitted"] += 1
        o_stat["admitted"] += 1
        admitted.append(task)

    census = {
        "started": started,
        "finished": datetime.now(timezone.utc).isoformat(),
        "reposScanned": len(repo_dirs),
        "totalCandidates": len(all_candidates),
        "admittedUnique": len(admitted),
        "families": len({t["family"] for t in admitted}),
        "reposAdmitted": sum(1 for v in by_repo.values() if v["admitted"] > 0),
        "effectfulAdmitted": sum(1 for t in admitted if len(t.get("fixture", {}).get("calls", [])) > 0),
        "unitTestInputAdmitted": sum(1 for t in admitted if "unit-test-input" in (t.get("features") or [])),
        "withDistractorsAdmitted": sum(1 for t in admitted if t["metadata"]["distractorCount"] > 0),
        "codeLoadCalls": _stats([t["metadata"]["codeLoadCalls"] for t in admitted]),
        "fileCount": _stats([t["metadata"]["fileCount"] for t in admitted]),
        "distractorCount": _stats([t["metadata"]["distractorCount"] for t in admitted]),
        "conversationChars": _stats([t["metadata"]["conversationChars"] for t in admitted]),
        "estimatedTokens": _stats([t["metadata"]["estimatedTokens"] for t in admitted]),
        "traceChars": _stats([t["metadata"]["traceChars"] for t in admitted]),
        "byOrigin": by_origin,
        "byRepo": by_repo,
        "topRefusals": [
            {"reason": k, "count": v}
            for k, v in sorted(refusals.items(), key=lambda kv: -kv[1])[:20]
        ],
    }

    (output_dir / "harvested.jsonl").write_text(
        "\n".join(_json_compact(t) for t in admitted) + ("\n" if admitted else ""),
        encoding="utf-8",
    )
    (output_dir / "census.json").write_text(
        json.dumps(census, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    print(json.dumps(census, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
