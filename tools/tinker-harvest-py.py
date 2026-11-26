#!/usr/bin/env python3
"""Automated OSS Python & unit-test execution harvester.

Walks local Python repositories, extracts real unit-test call inputs via AST,
builds self-contained Python snippets via AST dependency closure, probes in an
isolated recording subprocess that auto-records print()/time.time()/random.random()
into fixture.calls, and verifies 100% of admitted tasks through
export_python_example(..., trace_format="compact").
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

_REPO_ROOT = Path(__file__).resolve().parents[1]
_TRAINING_DIR = str(_REPO_ROOT / "training")
if _TRAINING_DIR not in sys.path:
    sys.path.insert(0, _TRAINING_DIR)

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
    ".tox",
    ".mypy_cache",
    ".pytest_cache",
    "site-packages",
})

BLOCKED_STDLIB_MODULES = frozenset({
    "os",
    "subprocess",
    "socket",
    "ctypes",
    "multiprocessing",
    "threading",
    "signal",
    "shutil",
    "sqlite3",
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
    "http",
    "pathlib",
    "tempfile",
    "sys",
    "importlib",
    "inspect",
    "gc",
    "atexit",
    "faulthandler",
    "pdb",
    "bdb",
    "profile",
    "cProfile",
    "trace",
    "tracemalloc",
    "zipimport",
    "pkgutil",
    "runpy",
    "code",
    "codeop",
    "compileall",
    "py_compile",
    "concurrent",
    "asyncio",
    "selectors",
    "select",
    "queue",
    "sched",
    "logging",
    "getpass",
    "curses",
    "readline",
    "rlcompleter",
    "tkinter",
    "turtle",
    "platform",
    "sysconfig",
    "site",
    "fileinput",
    "filecmp",
    "glob",
    "linecache",
    "xmlrpc",
    "wsgiref",
    "socketserver",
    "secrets",
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

BUILTIN_NAMES = frozenset(dir(builtins)) | frozenset({"__name__", "__file__", "__doc__", "host"})

FALLBACK_PROBES_BY_ARITY: dict[int, list[list[Any]]] = {
    0: [[]],
    1: [
        [[3, 1, 4, 1, 5, 9, 2]],
        ["hello world, python 42!"],
        [{"a": 1, "b": 2, "c": 3}],
        [12],
        [0],
        [[1, 2, 3, 4, 5]],
    ],
    2: [
        [[3, 1, 4, 1, 5], 2],
        ["abracadabra", "abra"],
        [18, 12],
        [{"a": 1, "b": 2}, {"b": 3, "c": 4}],
        [[1, 2, 3], [2, 3, 4]],
    ],
    3: [
        [[1, 2, 3, 4, 5], 1, 4],
        ["hello world", "world", "python"],
        [2, 5, 13],
    ],
}

_PROBE_SCRIPT = r"""
import builtins
import io
import json
import random
import signal
import sys
import time

sys.path.insert(0, sys.argv[1])
from tinker_py.codec import decode_readable, encode_exception, encode_readable
from tinker_py.http_tools import DEFAULT_HTTP_TIMEOUT_S, MAX_HTTP_BODY_BYTES, install_live_http_hooks

def _timeout(_sig, _frame):
    raise TimeoutError("probe timeout")

if hasattr(signal, "SIGALRM"):
    signal.signal(signal.SIGALRM, _timeout)
    signal.setitimer(signal.ITIMER_REAL, 8.0)

real_stdout = sys.stdout
try:
    req = json.loads(sys.stdin.read())
    source = req["source"]
    entry = req["entry"]
    args = decode_readable(req["args"])
    recorded = []
    rng = random.Random(17)
    time_counter = [0]
    io_depth = [0]
    real_time = time.time
    real_monotonic = time.monotonic
    real_random = random.random

    def _rec_print(*p_args, **_kwargs):
        if io_depth[0] > 0:
            return
        enc_args = encode_readable(list(p_args))
        recorded.append({
            "operation": "platform.print",
            "arguments": enc_args,
            "status": "fulfilled",
            "result": None,
        })

    def _rec_time():
        if io_depth[0] > 0:
            return real_time()
        val = 1700000000.0 + time_counter[0] * 0.25
        time_counter[0] += 1
        recorded.append({
            "operation": "platform.time",
            "arguments": [],
            "status": "fulfilled",
            "result": val,
        })
        return val

    def _rec_monotonic():
        if io_depth[0] > 0:
            return real_monotonic()
        val = 1700000000.0 + time_counter[0] * 0.25
        time_counter[0] += 1
        recorded.append({
            "operation": "platform.time",
            "arguments": [],
            "status": "fulfilled",
            "result": val,
        })
        return val

    def _rec_random():
        if io_depth[0] > 0:
            return real_random()
        val = rng.random()
        recorded.append({
            "operation": "platform.random",
            "arguments": [],
            "status": "fulfilled",
            "result": val,
        })
        return val

    enable_urllib = ("urllib" in source) or ("urlopen" in source)
    enable_requests = "requests" in source
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
    ns = {"__builtins__": guest_builtins, "__name__": "__guest__"}
    code = compile(source, "<guest>", "exec")
    sys.stdout = io.StringIO()
    kind = "return"
    try:
        exec(code, ns)
        fn = ns[entry]
        result = fn(*args)
    except Exception as exc:
        kind = "throw"
        result = encode_exception(exc)
    finally:
        sys.stdout = real_stdout
        if hasattr(signal, "SIGALRM"):
            signal.setitimer(signal.ITIMER_REAL, 0.0)

    if len(recorded) > 32:
        raise RuntimeError("too many recorded calls")
    enc_out = encode_readable({"arguments": args, "value": result})
    real_stdout.write(json.dumps({
        "ok": True,
        "kind": kind,
        "result": enc_out,
        "recordedCalls": recorded,
    }, ensure_ascii=False, separators=(",", ":"), allow_nan=False) + "\n")
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
    if parts & {"tests", "test"}:
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
    """Safely evaluate constant/literal AST expressions using bound local/module constants."""
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
            if isinstance(left, str) and isinstance(right, str):
                return True, left + right
            if isinstance(left, bytes) and isinstance(right, bytes):
                return True, left + right
            if isinstance(left, list) and isinstance(right, list):
                return True, left + right
            if isinstance(left, tuple) and isinstance(right, tuple):
                return True, left + right
            if (
                isinstance(left, (int, float))
                and not isinstance(left, bool)
                and isinstance(right, (int, float))
                and not isinstance(right, bool)
            ):
                return True, left + right
        return False, None
    if isinstance(node, ast.JoinedStr):
        parts: list[str] = []
        for piece in node.values:
            if isinstance(piece, ast.Constant) and isinstance(piece.value, str):
                parts.append(piece.value)
            elif isinstance(piece, ast.FormattedValue) and piece.format_spec is None and piece.conversion == -1:
                ok_v, val = _eval_const_expr(piece.value, env, depth + 1)
                if not ok_v or not isinstance(val, (str, int, float, bool)):
                    return False, None
                parts.append(str(val))
            else:
                return False, None
        return True, "".join(parts)
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


def _eval_parametrize_rows(node: ast.AST, env: dict[str, Any], num_names: int) -> list[Any]:
    ok, val = _eval_const_expr(node, env)
    if ok and isinstance(val, (list, tuple)):
        return list(val)
    if isinstance(node, (ast.List, ast.Tuple)):
        rows: list[Any] = []
        for elt in node.elts:
            if isinstance(elt, ast.Call):
                is_param = (
                    (isinstance(elt.func, ast.Attribute) and elt.func.attr == "param")
                    or (isinstance(elt.func, ast.Name) and elt.func.id == "param")
                )
                if is_param and not any(isinstance(a, ast.Starred) for a in elt.args):
                    pvals: list[Any] = []
                    all_ok = True
                    for a in elt.args:
                        a_ok, a_val = _eval_const_expr(a, env)
                        if not a_ok:
                            all_ok = False
                            break
                        pvals.append(a_val)
                    if all_ok and pvals:
                        if num_names == 1 and len(pvals) == 1:
                            rows.append(pvals[0])
                        else:
                            rows.append(tuple(pvals))
                    continue
            e_ok, e_val = _eval_const_expr(elt, env)
            if e_ok:
                rows.append(e_val)
        return rows
    return []


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
        if not names:
            continue

        rows = _eval_parametrize_rows(argvalues_node, env, len(names))
        if not rows:
            continue
        row_dicts: list[dict[str, Any]] = []
        if len(names) == 1:
            key = names[0]
            for r in rows:
                row_dicts.append({key: r})
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
        if len(sig) > 8000:
            return
        seen = seen_per_fn.setdefault(fn_name, set())
        if sig in seen:
            return
        seen.add(sig)
        by_fn.setdefault(fn_name, []).append({"args": encoded, "file": rel_file, "sig": sig})

    def scan_body(
        stmts: list[ast.stmt],
        env: dict[str, Any],
        rel_file: str,
        aliases: dict[str, str],
    ) -> None:
        local_env = dict(env)
        local_aliases = dict(aliases)
        for stmt in stmts:
            if isinstance(stmt, ast.ImportFrom):
                for a in stmt.names:
                    if a.name != "*" and a.asname:
                        local_aliases[a.asname] = a.name
                continue
            # Update constant bindings sequentially before walking calls in subsequent statements.
            if isinstance(stmt, ast.Assign):
                ok, val = _eval_const_expr(stmt.value, local_env)
                if ok:
                    for target in stmt.targets:
                        if isinstance(target, ast.Name):
                            local_env[target.id] = val
            elif isinstance(stmt, ast.AnnAssign) and isinstance(stmt.target, ast.Name) and stmt.value is not None:
                ok, val = _eval_const_expr(stmt.value, local_env)
                if ok:
                    local_env[stmt.target.id] = val
            elif isinstance(stmt, ast.For):
                ok, iter_val = _eval_const_expr(stmt.iter, local_env)
                if ok and isinstance(iter_val, (list, tuple)) and len(iter_val) <= 64:
                    for item in iter_val:
                        loop_env = dict(local_env)
                        if _bind_loop_target(stmt.target, item, loop_env):
                            scan_body(stmt.body, loop_env, rel_file, local_aliases)
                    continue

            # Walk nested calls in this statement (covers assert fn(...) == ...,
            # self.assertEqual(fn(...), ...), with pytest.raises(...): fn(...),
            # pytest.raises(Exc, fn, *args), and self.assertRaises(Exc, fn, *args)).
            for sub in ast.walk(stmt):
                if isinstance(sub, ast.Call):
                    raises_name = (
                        sub.func.attr
                        if isinstance(sub.func, ast.Attribute)
                        else (sub.func.id if isinstance(sub.func, ast.Name) else None)
                    )
                    callee_idx: int | None = None
                    if raises_name in ("raises", "assertRaises") and len(sub.args) >= 2:
                        callee_idx = 1
                    elif raises_name == "assertRaisesRegex" and len(sub.args) >= 3:
                        callee_idx = 2
                    if callee_idx is not None:
                        call_arg_nodes = sub.args[callee_idx + 1 :]
                        if not sub.keywords and not any(isinstance(a, ast.Starred) for a in call_arg_nodes):
                            fn_name = _resolve_callee(sub.args[callee_idx], local_aliases)
                            if fn_name and fn_name not in IGNORED_TEST_CALLEES:
                                evaluated: list[Any] = []
                                all_ok = True
                                for arg_node in call_arg_nodes:
                                    ok, val = _eval_const_expr(arg_node, local_env)
                                    if not ok:
                                        all_ok = False
                                        break
                                    evaluated.append(val)
                                if all_ok:
                                    record_call(fn_name, evaluated, rel_file)
                        continue

                    if sub.keywords:
                        continue
                    if any(isinstance(a, ast.Starred) for a in sub.args):
                        continue
                    fn_name = _resolve_callee(sub.func, local_aliases)
                    if not fn_name or fn_name in IGNORED_TEST_CALLEES:
                        continue
                    evaluated = []
                    all_ok = True
                    for arg_node in sub.args:
                        ok, val = _eval_const_expr(arg_node, local_env)
                        if not ok:
                            all_ok = False
                            break
                        evaluated.append(val)
                    if all_ok:
                        record_call(fn_name, evaluated, rel_file)

    for tfile in test_files:
        try:
            text = tfile.read_text(encoding="utf-8", errors="ignore")
            tree = ast.parse(text)
        except Exception:
            continue
        rel_file = str(tfile.relative_to(repo_dir))
        mod_env: dict[str, Any] = {}
        mod_aliases: dict[str, str] = {}
        for stmt in tree.body:
            if isinstance(stmt, ast.ImportFrom):
                for a in stmt.names:
                    if a.name != "*" and a.asname:
                        mod_aliases[a.asname] = a.name
            elif isinstance(stmt, ast.Assign):
                ok, val = _eval_const_expr(stmt.value, mod_env)
                if ok:
                    for target in stmt.targets:
                        if isinstance(target, ast.Name):
                            mod_env[target.id] = val
            elif isinstance(stmt, ast.AnnAssign) and isinstance(stmt.target, ast.Name) and stmt.value is not None:
                ok, val = _eval_const_expr(stmt.value, mod_env)
                if ok:
                    mod_env[stmt.target.id] = val
        for stmt in tree.body:
            if isinstance(stmt, ast.FunctionDef):
                for p_env in _extract_parametrize_envs(stmt.decorator_list, mod_env):
                    scan_body(stmt.body, {**mod_env, **p_env}, rel_file, mod_aliases)
            elif isinstance(stmt, ast.ClassDef):
                cls_envs = _extract_parametrize_envs(stmt.decorator_list, mod_env)
                for item in stmt.body:
                    if isinstance(item, ast.FunctionDef):
                        for c_env in cls_envs:
                            base_env = {**mod_env, **c_env}
                            for f_env in _extract_parametrize_envs(item.decorator_list, base_env):
                                scan_body(item.body, {**base_env, **f_env}, rel_file, mod_aliases)
            else:
                scan_body([stmt], mod_env, rel_file, mod_aliases)

    return by_fn


def _is_allowed_stdlib_import(module_name: str) -> bool:
    if module_name in ("urllib.parse", "urllib.request", "urllib.error", "urllib.response", "urllib"):
        return True
    if module_name == "requests" or module_name.startswith("requests."):
        return True
    root = module_name.split(".")[0]
    if root in BLOCKED_STDLIB_MODULES:
        return False
    return root in sys.stdlib_module_names


def _resolve_local_module_path(
    repo_dir: Path,
    current_file: Path,
    module: str | None,
    level: int,
) -> Path | None:
    if level > 0:
        base = current_file.parent
        for _ in range(level - 1):
            base = base.parent
        rel_parts = module.split(".") if module else []
        candidate_py = base.joinpath(*rel_parts).with_suffix(".py") if rel_parts else None
        if candidate_py and candidate_py.is_file():
            return candidate_py
        candidate_init = base.joinpath(*rel_parts, "__init__.py")
        if candidate_init.is_file():
            return candidate_init
        return None
    if not module:
        return None
    parts = module.split(".")
    for base in (repo_dir, repo_dir / "src", current_file.parent):
        cand_py = base.joinpath(*parts).with_suffix(".py")
        if cand_py.is_file():
            return cand_py
        cand_init = base.joinpath(*parts, "__init__.py")
        if cand_init.is_file():
            return cand_init
    return None


def _defined_names_in_stmt(stmt: ast.stmt) -> set[str]:
    names: set[str] = set()
    if isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
        names.add(stmt.name)
    elif isinstance(stmt, ast.Assign):
        for target in stmt.targets:
            for sub in ast.walk(target):
                if isinstance(sub, ast.Name) and isinstance(sub.ctx, ast.Store):
                    names.add(sub.id)
    elif isinstance(stmt, ast.AnnAssign) and isinstance(stmt.target, ast.Name):
        names.add(stmt.target.id)
    elif isinstance(stmt, (ast.Import, ast.ImportFrom)):
        for alias in stmt.names:
            names.add(alias.asname or alias.name.split(".")[0])
    return names


def _arg_names(args: ast.arguments) -> set[str]:
    names: set[str] = set()
    for arg in (
        args.posonlyargs
        + args.args
        + args.kwonlyargs
        + ([args.vararg] if args.vararg else [])
        + ([args.kwarg] if args.kwarg else [])
    ):
        names.add(arg.arg)
    return names


def _referenced_names(node: ast.AST) -> set[str]:
    loaded: set[str] = set()
    bound: set[str] = set()
    for sub in ast.walk(node):
        if isinstance(sub, (ast.FunctionDef, ast.AsyncFunctionDef)):
            bound.update(_arg_names(sub.args))
            if sub is not node:
                bound.add(sub.name)
        elif isinstance(sub, ast.Lambda):
            bound.update(_arg_names(sub.args))
        elif isinstance(sub, ast.ClassDef) and sub is not node:
            bound.add(sub.name)
        elif isinstance(sub, ast.Name):
            if isinstance(sub.ctx, ast.Load):
                loaded.add(sub.id)
            elif isinstance(sub.ctx, ast.Store):
                bound.add(sub.id)
        elif isinstance(sub, ast.ExceptHandler) and sub.name:
            bound.add(sub.name)
        elif isinstance(sub, (ast.Import, ast.ImportFrom)):
            for alias in sub.names:
                bound.add(alias.asname or alias.name.split(".")[0])
        elif isinstance(sub, (ast.MatchAs, ast.MatchStar)) and sub.name:
            bound.add(sub.name)
        elif isinstance(sub, ast.MatchMapping) and sub.rest:
            bound.add(sub.rest)
    return loaded - bound - BUILTIN_NAMES


def _stmt_source_slice(lines: list[str], stmt: ast.stmt) -> str:
    start = stmt.lineno - 1
    if isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and stmt.decorator_list:
        start = min(d.lineno for d in stmt.decorator_list) - 1
    end = getattr(stmt, "end_lineno", stmt.lineno) or stmt.lineno
    return "\n".join(lines[start:end])


def _is_generator(fn: ast.FunctionDef) -> bool:
    for sub in ast.walk(fn):
        if isinstance(sub, (ast.Yield, ast.YieldFrom)):
            return True
    return False


def _fn_arity_bounds(fn: ast.FunctionDef) -> tuple[int, int | None]:
    total_pos = len(fn.args.posonlyargs) + len(fn.args.args)
    defaults = len(fn.args.defaults)
    min_args = max(0, total_pos - defaults)
    max_args = None if fn.args.vararg is not None else total_pos
    return min_args, max_args


def _extract_local_symbol_closure(
    repo_dir: Path,
    mod_path: Path,
    symbol_names: set[str],
    depth: int = 0,
) -> tuple[bool, list[str], list[str]]:
    """Extract self-contained import lines and definition lines for symbols from a local module."""
    if depth > 4:
        return False, [], []
    try:
        text = mod_path.read_text(encoding="utf-8", errors="ignore")
        tree = ast.parse(text)
    except Exception:
        return False, [], []
    lines = text.splitlines()
    stmt_by_name: dict[str, int] = {}
    import_indices_by_name: dict[str, list[int]] = {}
    for idx, stmt in enumerate(tree.body):
        for name in _defined_names_in_stmt(stmt):
            stmt_by_name[name] = idx
            if isinstance(stmt, ast.Import):
                import_indices_by_name.setdefault(name, []).append(idx)

    needed_indices: set[int] = set()
    queue = list(symbol_names)
    visited: set[str] = set()
    extra_imports: list[str] = []
    extra_defs: list[str] = []

    while queue:
        name = queue.pop()
        if name in visited or name in BUILTIN_NAMES:
            continue
        visited.add(name)
        idx = stmt_by_name.get(name)
        if idx is None:
            return False, [], []
        stmt = tree.body[idx]
        if isinstance(stmt, ast.Import):
            for imp_idx in import_indices_by_name.get(name, [idx]):
                imp_stmt = tree.body[imp_idx]
                assert isinstance(imp_stmt, ast.Import)
                for alias in imp_stmt.names:
                    if (alias.asname or alias.name.split(".")[0]) == name:
                        if not _is_allowed_stdlib_import(alias.name):
                            return False, [], []
                        needed_indices.add(imp_idx)
        elif isinstance(stmt, ast.ImportFrom):
            mod = stmt.module or ""
            if stmt.level == 0 and _is_allowed_stdlib_import(mod):
                needed_indices.add(idx)
            else:
                target_path = _resolve_local_module_path(repo_dir, mod_path, stmt.module, stmt.level)
                if target_path is None:
                    return False, [], []
                orig = next((a.name for a in stmt.names if (a.asname or a.name) == name), None)
                if not orig or orig == "*":
                    return False, [], []
                ok, imp_l, def_l = _extract_local_symbol_closure(repo_dir, target_path, {orig}, depth + 1)
                if not ok:
                    return False, [], []
                extra_imports.extend(imp_l)
                extra_defs.extend(def_l)
                if orig != name:
                    extra_defs.append(f"{name} = {orig}")
        else:
            needed_indices.add(idx)
            for ref in _referenced_names(stmt):
                if ref not in visited:
                    queue.append(ref)

    imports_out = list(extra_imports)
    defs_out = list(extra_defs)
    for idx in sorted(needed_indices):
        stmt = tree.body[idx]
        snippet = _stmt_source_slice(lines, stmt)
        if isinstance(stmt, (ast.Import, ast.ImportFrom)):
            imports_out.append(snippet)
        else:
            defs_out.append(snippet)
    return True, imports_out, defs_out


def build_self_contained_snippet(
    repo_dir: Path,
    source_file: Path,
    tree: ast.Module,
    lines: list[str],
    target_idx: int,
) -> str | None:
    """Compute AST dependency closure for one top-level function and emit self-contained source."""
    target_stmt = tree.body[target_idx]
    if not isinstance(target_stmt, ast.FunctionDef):
        return None
    if target_stmt.name.startswith("_") or _is_generator(target_stmt):
        return None
    if target_stmt.decorator_list:
        return None

    stmt_by_name: dict[str, int] = {}
    import_indices_by_name: dict[str, list[int]] = {}
    for idx, stmt in enumerate(tree.body):
        for name in _defined_names_in_stmt(stmt):
            stmt_by_name[name] = idx
            if isinstance(stmt, ast.Import):
                import_indices_by_name.setdefault(name, []).append(idx)

    needed_indices: set[int] = {target_idx}
    queue = list(_referenced_names(target_stmt))
    visited: set[str] = {target_stmt.name}
    inlined_imports: list[str] = []
    inlined_defs: list[str] = []

    while queue:
        name = queue.pop()
        if name in visited or name in BUILTIN_NAMES:
            continue
        visited.add(name)
        idx = stmt_by_name.get(name)
        if idx is None:
            # Unresolved global name (could be missing import or runtime global) -> reject.
            return None
        stmt = tree.body[idx]
        if isinstance(stmt, ast.Import):
            for imp_idx in import_indices_by_name.get(name, [idx]):
                imp_stmt = tree.body[imp_idx]
                assert isinstance(imp_stmt, ast.Import)
                for alias in imp_stmt.names:
                    bound = alias.asname or alias.name.split(".")[0]
                    if bound == name:
                        if not _is_allowed_stdlib_import(alias.name):
                            return None
                        needed_indices.add(imp_idx)
        elif isinstance(stmt, ast.ImportFrom):
            mod = stmt.module or ""
            if stmt.level == 0 and _is_allowed_stdlib_import(mod):
                needed_indices.add(idx)
            else:
                target_path = _resolve_local_module_path(repo_dir, source_file, stmt.module, stmt.level)
                if target_path is None:
                    return None
                orig = next((a.name for a in stmt.names if (a.asname or a.name) == name), None)
                if not orig or orig == "*":
                    return None
                ok, imp_l, def_l = _extract_local_symbol_closure(repo_dir, target_path, {orig}, 0)
                if not ok:
                    return None
                inlined_imports.extend(imp_l)
                inlined_defs.extend(def_l)
                if orig != name:
                    inlined_defs.append(f"{name} = {orig}")
        else:
            needed_indices.add(idx)
            for ref in _referenced_names(stmt):
                if ref not in visited:
                    queue.append(ref)

    import_blocks: list[str] = []
    def_blocks: list[str] = []
    seen_imports: set[str] = set()

    for imp in inlined_imports:
        if imp not in seen_imports:
            seen_imports.add(imp)
            import_blocks.append(imp)

    for idx in sorted(needed_indices):
        stmt = tree.body[idx]
        seg = _stmt_source_slice(lines, stmt)
        if isinstance(stmt, (ast.Import, ast.ImportFrom)):
            if seg not in seen_imports:
                seen_imports.add(seg)
                import_blocks.append(seg)
        else:
            def_blocks.append(seg)

    all_blocks = [*import_blocks, *inlined_defs, *def_blocks]
    snippet = "\n\n".join(b for b in all_blocks if b.strip()) + "\n"
    try:
        ast.parse(snippet)
    except SyntaxError:
        return None
    return snippet


def _probe_snippet(snippet: str, entry: str, encoded_args: list[Any]) -> dict[str, Any]:
    payload = _json_compact({"source": snippet, "entry": entry, "args": encoded_args})
    try:
        with tempfile.TemporaryDirectory(prefix="py-probe-") as tmpdir:
            proc = subprocess.run(
                [sys.executable, "-c", _PROBE_SCRIPT, _TRAINING_DIR],
                input=payload,
                capture_output=True,
                text=True,
                cwd=tmpdir,
                timeout=12.0,
                check=False,
            )
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": "timeout"}
    out = proc.stdout.strip()
    if not out:
        return {"ok": False, "error": proc.stderr.strip()[:200] or "empty probe output"}
    try:
        return json.loads(out.splitlines()[-1])
    except ValueError:
        return {"ok": False, "error": "invalid probe JSON"}


def _detect_features(snippet: str, recorded_calls: list[dict[str, Any]], from_unit_test: bool) -> list[str]:
    feats: set[str] = {"python"}
    if from_unit_test:
        feats.add("unit-test-input")
    if recorded_calls:
        feats.add("external")
        for c in recorded_calls:
            op = c["operation"]
            feats.add(op)
            if op.startswith("http."):
                feats.add("http")
    try:
        tree = ast.parse(snippet)
        for node in ast.walk(tree):
            if isinstance(node, (ast.For, ast.While)):
                feats.add("loop")
            elif isinstance(node, ast.If):
                feats.add("branch")
            elif isinstance(node, ast.Try):
                feats.add("exception")
            elif isinstance(node, ast.ClassDef):
                feats.add("class")
            elif isinstance(node, (ast.ListComp, ast.DictComp, ast.SetComp, ast.GeneratorExp)):
                feats.add("comprehension")
    except SyntaxError:
        pass
    return sorted(feats)


_FIRST_LINE_TYPE_ERR_RE = re.compile(
    r"^raise(?:\s+\([^)]+\))?\s+(?:TypeError|AttributeError)\b"
)


def _extract_completion_outcome(messages: list[dict[str, Any]]) -> tuple[str | None, Any]:
    for msg in reversed(messages):
        if msg.get("role") != "assistant":
            continue
        vis = assistant_visible_text(msg)
        if "```json\n" in vis:
            try:
                body = vis.split("```json\n", 1)[1].split("\n```", 1)[0]
                comp = json.loads(body)
                if isinstance(comp, dict):
                    return comp.get("kind"), comp.get("value")
            except Exception:
                return None, None
        break
    return None, None


def _qualify_candidate(
    cand: dict[str, Any],
    *,
    min_trace_lines: int = 0,
    drop_probe_type_errors: bool = True,
) -> dict[str, Any]:
    task = cand["task"]
    try:
        exported = export_python_example(task, trace_format="compact", reasoning_channel="thinking")
        trace_lines: list[str] = []
        trace_chars = 0
        for m in exported["messages"]:
            if m.get("role") != "assistant":
                continue
            thinking = assistant_thinking_text(m)
            if thinking.strip():
                trace_lines.extend(thinking.strip().splitlines())
            trace_chars += (
                len(assistant_visible_text(m))
                + len(thinking)
                + (len(_json_compact(m["tool_calls"])) if m.get("tool_calls") else 0)
            )

        if drop_probe_type_errors and cand["origin"] == "py-oss-probe":
            if trace_lines and _FIRST_LINE_TYPE_ERR_RE.match(trace_lines[0]):
                return {
                    "status": "refused",
                    "reason": "probe-first-line-type-error",
                    "id": task["id"],
                    "repo": cand["repo"],
                    "origin": cand["origin"],
                    "family": task["family"],
                }
            comp_kind, comp_val = _extract_completion_outcome(exported["messages"])
            if (
                comp_kind == "throw"
                and isinstance(comp_val, dict)
                and comp_val.get("name") in ("TypeError", "AttributeError")
            ):
                return {
                    "status": "refused",
                    "reason": f"probe-{comp_val['name']}",
                    "id": task["id"],
                    "repo": cand["repo"],
                    "origin": cand["origin"],
                    "family": task["family"],
                }

        narration_lines = int(exported["metadata"]["traceAudit"]["narrationLines"])
        if min_trace_lines > 0 and narration_lines < min_trace_lines:
            return {
                "status": "refused",
                "reason": f"trace-too-short ({narration_lines} < {min_trace_lines} lines)",
                "id": task["id"],
                "repo": cand["repo"],
                "origin": cand["origin"],
                "family": task["family"],
            }

        if trace_chars > 80_000:
            return {
                "status": "refused",
                "reason": f"trace-too-long ({trace_chars} chars)",
                "id": task["id"],
                "repo": cand["repo"],
                "origin": cand["origin"],
                "family": task["family"],
            }
        enriched_task = {
            **exported["task"],
            "metadata": {
                **(task.get("metadata") or {}),
                "sourceHash": exported["sourceHash"],
                "sourceChars": len(exported["task"]["source"]),
                "traceChars": trace_chars,
                "externalCalls": len(exported["task"]["fixture"]["calls"]),
                "narrationLines": narration_lines,
            },
        }
        return {
            "status": "admitted",
            "id": task["id"],
            "repo": cand["repo"],
            "origin": cand["origin"],
            "family": task["family"],
            "sourceHash": exported["sourceHash"],
            "traceChars": trace_chars,
            "externalCalls": len(exported["task"]["fixture"]["calls"]),
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


def harvest_repo(
    repo_dir: Path,
    *,
    max_per_repo: int,
    max_per_fn: int,
    min_source_chars: int,
    max_source_chars: int,
    drop_probe_type_errors: bool = True,
) -> list[dict[str, Any]]:
    repo_name = _slug(repo_dir.name)
    source_files, test_files = _walk_py_files(repo_dir)
    unit_inputs = extract_unit_test_inputs(repo_dir, test_files)

    unit_candidates: list[dict[str, Any]] = []
    probe_candidates: list[dict[str, Any]] = []
    repo_cap = max_per_repo * 3
    fn_probe_cap = max(max_per_fn * 2, max_per_fn + 2)

    for src_file in source_files:
        if len(unit_candidates) >= repo_cap:
            break
        try:
            text = src_file.read_text(encoding="utf-8", errors="ignore")
            tree = ast.parse(text)
        except Exception:
            continue
        lines = text.splitlines()
        rel_src = str(src_file.relative_to(repo_dir))
        mod_slug = _slug(str(src_file.relative_to(repo_dir).with_suffix("")))

        for idx, stmt in enumerate(tree.body):
            if len(unit_candidates) >= repo_cap:
                break
            if not isinstance(stmt, ast.FunctionDef):
                continue
            snippet = build_self_contained_snippet(repo_dir, src_file, tree, lines, idx)
            if snippet is None:
                continue
            if not (min_source_chars <= len(snippet) <= max_source_chars):
                continue

            min_arity, max_arity = _fn_arity_bounds(stmt)
            probes: list[tuple[list[Any], bool, str | None]] = []

            for entry in unit_inputs.get(stmt.name, []):
                arg_len = len(entry["args"])
                if arg_len >= min_arity and (max_arity is None or arg_len <= max_arity):
                    probes.append((entry["args"], True, entry["file"]))

            # Add compact fallback probes matching arity if unit-test inputs are scarce
            # and we haven't already saturated the synthetic probe budget for this repo.
            if len(probes) < max_per_fn and len(probe_candidates) < repo_cap:
                fallback_arity = min_arity if min_arity in FALLBACK_PROBES_BY_ARITY else (
                    max_arity if max_arity in FALLBACK_PROBES_BY_ARITY else None
                )
                if fallback_arity is not None:
                    for raw_args in FALLBACK_PROBES_BY_ARITY[fallback_arity]:
                        probes.append((encode_readable(raw_args), False, None))

            kept_for_fn = 0
            kept_unit_for_fn = 0
            seen_probe_sigs: set[str] = set()
            for encoded_args, from_unit_test, test_file in probes:
                if from_unit_test:
                    if kept_unit_for_fn >= fn_probe_cap or len(unit_candidates) >= repo_cap:
                        continue
                else:
                    if kept_for_fn >= fn_probe_cap or len(probe_candidates) >= repo_cap:
                        break
                sig = _json_compact(encoded_args)
                if sig in seen_probe_sigs:
                    continue
                seen_probe_sigs.add(sig)

                probe = _probe_snippet(snippet, stmt.name, encoded_args)
                if not probe.get("ok"):
                    continue
                # For synthetic fallback probes, skip TypeError/AttributeError mismatches when enabled.
                if drop_probe_type_errors and not from_unit_test and probe.get("kind") == "throw":
                    val = probe.get("result", {}).get("value")
                    if isinstance(val, dict) and val.get("name") in ("TypeError", "AttributeError"):
                        continue

                recorded_calls = probe.get("recordedCalls") or []
                uses_tool_random = any(c["operation"] == "platform.random" for c in recorded_calls)
                features = _detect_features(snippet, recorded_calls, from_unit_test)
                origin = "py-unit-test" if from_unit_test else "py-oss-probe"
                task: dict[str, Any] = {
                    "id": f"py-{repo_name}-{mod_slug}-{stmt.name}-{kept_for_fn}",
                    "family": f"py-oss:{repo_name}:{mod_slug}:{stmt.name}",
                    "language": "py",
                    "source": snippet,
                    "entry": stmt.name,
                    "args": encoded_args,
                    "randomMode": "tool" if uses_tool_random else "seeded",
                    "randomSeed": 17,
                    "fixture": {"calls": recorded_calls},
                    "features": features,
                    "metadata": {
                        "repo": repo_name,
                        "sourceFile": rel_src,
                        "testFile": test_file,
                        "sourceOrigin": origin,
                        "lineage": [f"py-repo:{repo_name}", f"py-fn:{repo_name}:{mod_slug}:{stmt.name}"],
                    },
                }
                cand = {"repo": repo_name, "origin": origin, "task": task}
                if from_unit_test:
                    unit_candidates.append(cand)
                    kept_unit_for_fn += 1
                else:
                    probe_candidates.append(cand)
                kept_for_fn += 1

    # Always prioritize real py-unit-test candidates before synthetic probes.
    return [*unit_candidates, *probe_candidates]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Harvest verified Python execution tasks from local repos.")
    parser.add_argument("--local-repos", required=True, help="Directory containing local Python repository folders.")
    parser.add_argument("--output-dir", default="runs/tinker-harvest-py", help="Output directory for harvested.jsonl and census.json.")
    parser.add_argument("--jobs", type=int, default=4, help="Parallel qualification workers.")
    parser.add_argument("--max-per-repo", type=int, default=30, help="Max admitted tasks per repo.")
    parser.add_argument("--max-per-fn", type=int, default=3, help="Max admitted inputs per function.")
    parser.add_argument("--min-source-chars", type=int, default=200, help="Minimum self-contained snippet length.")
    parser.add_argument("--max-source-chars", type=int, default=35000, help="Maximum self-contained snippet length.")
    parser.add_argument("--min-trace-lines", type=int, default=0, help="Minimum compact trace line count required to admit a task.")
    parser.add_argument(
        "--drop-probe-type-errors",
        dest="drop_probe_type_errors",
        action="store_true",
        default=True,
        help="Drop synthetic py-oss-probe candidates whose first trace event or outcome is TypeError/AttributeError (default: enabled).",
    )
    parser.add_argument(
        "--keep-probe-type-errors",
        dest="drop_probe_type_errors",
        action="store_false",
        help="Keep synthetic py-oss-probe TypeError/AttributeError candidates.",
    )
    args = parser.parse_args(argv)

    local_repos_dir = Path(args.local_repos).resolve()
    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    jobs = max(1, min(16, args.jobs))

    started = datetime.now(timezone.utc).isoformat()
    repo_dirs = sorted(
        p for p in local_repos_dir.iterdir()
        if p.is_dir() and p.name not in SKIP_DIRS and not p.name.startswith(".")
    )
    if not repo_dirs and any(local_repos_dir.glob("*.py")):
        repo_dirs = [local_repos_dir]

    all_candidates: list[dict[str, Any]] = []
    for rdir in repo_dirs:
        cands = harvest_repo(
            rdir,
            max_per_repo=args.max_per_repo,
            max_per_fn=args.max_per_fn,
            min_source_chars=args.min_source_chars,
            max_source_chars=args.max_source_chars,
            drop_probe_type_errors=args.drop_probe_type_errors,
        )
        all_candidates.extend(cands)

    def _qualify(cand: dict[str, Any]) -> dict[str, Any]:
        return _qualify_candidate(
            cand,
            min_trace_lines=args.min_trace_lines,
            drop_probe_type_errors=args.drop_probe_type_errors,
        )

    records: list[dict[str, Any]] = []
    if all_candidates:
        if jobs == 1:
            records = [_qualify(c) for c in all_candidates]
        else:
            with concurrent.futures.ThreadPoolExecutor(max_workers=jobs) as pool:
                records = list(pool.map(_qualify, all_candidates))

    # Give py-unit-test candidates priority before synthetic probes when enforcing caps.
    records.sort(key=lambda r: 0 if r["origin"] == "py-unit-test" else 1)

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
        fn_key = rec["family"]
        if fn_counts.get(fn_key, 0) >= args.max_per_fn:
            continue
        task = rec["task"]
        input_sig = _sha256([task["entry"], task["args"], task["fixture"]])
        dedup_key = (rec["sourceHash"], input_sig)
        if dedup_key in seen_dedup:
            continue
        seen_dedup.add(dedup_key)
        repo_counts[rec["repo"]] = repo_counts.get(rec["repo"], 0) + 1
        fn_counts[fn_key] = fn_counts.get(fn_key, 0) + 1
        r_stat["admitted"] += 1
        o_stat["admitted"] += 1
        admitted.append(task)

    trace_lens = sorted(t["metadata"]["traceChars"] for t in admitted)
    effectful = sum(1 for t in admitted if len(t.get("fixture", {}).get("calls", [])) > 0)
    unit_test_admitted = sum(1 for t in admitted if "unit-test-input" in (t.get("features") or []))

    census = {
        "started": started,
        "finished": datetime.now(timezone.utc).isoformat(),
        "totalCandidates": len(all_candidates),
        "admittedUnique": len(admitted),
        "families": len({t["family"] for t in admitted}),
        "reposAdmitted": sum(1 for v in by_repo.values() if v["admitted"] > 0),
        "effectfulAdmitted": effectful,
        "unitTestInputAdmitted": unit_test_admitted,
        "traceChars": (
            {
                "min": trace_lens[0],
                "median": trace_lens[len(trace_lens) // 2],
                "p90": trace_lens[int(len(trace_lens) * 0.9)],
                "max": trace_lens[-1],
            }
            if trace_lens
            else None
        ),
        "byOrigin": by_origin,
        "byRepo": by_repo,
        "topRefusals": [
            {"reason": k, "count": v}
            for k, v in sorted(refusals.items(), key=lambda kv: -kv[1])[:20]
        ],
    }

    harvested_path = output_dir / "harvested.jsonl"
    harvested_path.write_text(
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
