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

def _timeout(_sig, _frame):
    raise TimeoutError("probe timeout")

if hasattr(signal, "SIGALRM"):
    signal.signal(signal.SIGALRM, _timeout)
    signal.setitimer(signal.ITIMER_REAL, 2.5)

real_stdout = sys.stdout
try:
    req = json.loads(sys.stdin.read())
    source = req["source"]
    entry = req["entry"]
    args = decode_readable(req["args"])
    recorded = []
    rng = random.Random(17)
    time_counter = [0]

    def _rec_print(*p_args, **_kwargs):
        enc_args = encode_readable(list(p_args))
        recorded.append({
            "operation": "platform.print",
            "arguments": enc_args,
            "status": "fulfilled",
            "result": None,
        })

    def _rec_time():
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
        val = rng.random()
        recorded.append({
            "operation": "platform.random",
            "arguments": [],
            "status": "fulfilled",
            "result": val,
        })
        return val

    time.time = _rec_time
    time.monotonic = _rec_time
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

    def scan_body(stmts: list[ast.stmt], env: dict[str, Any], rel_file: str) -> None:
        local_env = dict(env)
        for stmt in stmts:
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

            # Walk nested calls in this statement.
            for sub in ast.walk(stmt):
                if isinstance(sub, ast.Call):
                    if sub.keywords:
                        continue
                    if any(isinstance(a, ast.Starred) for a in sub.args):
                        continue
                    fn_name: str | None = None
                    if isinstance(sub.func, ast.Name):
                        fn_name = sub.func.id
                    elif isinstance(sub.func, ast.Attribute):
                        owner = sub.func.value
                        if isinstance(owner, ast.Name) and owner.id in ("self", "cls", "pytest", "unittest", "assert"):
                            continue
                        fn_name = sub.func.attr
                    if not fn_name or fn_name in IGNORED_TEST_CALLEES:
                        continue
                    evaluated: list[Any] = []
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
        for stmt in tree.body:
            if isinstance(stmt, ast.Assign):
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
                scan_body(stmt.body, mod_env, rel_file)
            elif isinstance(stmt, ast.ClassDef):
                for item in stmt.body:
                    if isinstance(item, ast.FunctionDef):
                        scan_body(item.body, mod_env, rel_file)
            else:
                scan_body([stmt], mod_env, rel_file)

    return by_fn


def _is_allowed_stdlib_import(module_name: str) -> bool:
    if module_name == "urllib.parse":
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
    for idx, stmt in enumerate(tree.body):
        for name in _defined_names_in_stmt(stmt):
            stmt_by_name[name] = idx

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
            for alias in stmt.names:
                if (alias.asname or alias.name.split(".")[0]) == name:
                    if not _is_allowed_stdlib_import(alias.name):
                        return False, [], []
                    needed_indices.add(idx)
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
    for idx, stmt in enumerate(tree.body):
        for name in _defined_names_in_stmt(stmt):
            stmt_by_name[name] = idx

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
            for alias in stmt.names:
                bound = alias.asname or alias.name.split(".")[0]
                if bound == name:
                    if not _is_allowed_stdlib_import(alias.name):
                        return None
                    needed_indices.add(idx)
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
        proc = subprocess.run(
            [sys.executable, "-c", _PROBE_SCRIPT, _TRAINING_DIR],
            input=payload,
            capture_output=True,
            text=True,
            timeout=4.0,
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
            feats.add(c["operation"])
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


def _qualify_candidate(cand: dict[str, Any]) -> dict[str, Any]:
    task = cand["task"]
    try:
        exported = export_python_example(task, trace_format="compact", reasoning_channel="thinking")
        trace_chars = sum(
            len(assistant_visible_text(m))
            + len(assistant_thinking_text(m))
            + (len(_json_compact(m["tool_calls"])) if m.get("tool_calls") else 0)
            for m in exported["messages"]
            if m.get("role") == "assistant"
        )
        if trace_chars > 80_000:
            return {
                "status": "refused",
                "reason": f"trace-too-long ({trace_chars} chars)",
                "id": task["id"],
                "repo": cand["repo"],
                "origin": cand["origin"],
            }
        enriched_task = {
            **exported["task"],
            "metadata": {
                **(task.get("metadata") or {}),
                "sourceHash": exported["sourceHash"],
                "sourceChars": len(exported["task"]["source"]),
                "traceChars": trace_chars,
                "externalCalls": len(exported["task"]["fixture"]["calls"]),
                "narrationLines": exported["metadata"]["traceAudit"]["narrationLines"],
            },
        }
        return {
            "status": "admitted",
            "id": task["id"],
            "repo": cand["repo"],
            "origin": cand["origin"],
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
        }


def harvest_repo(
    repo_dir: Path,
    *,
    max_per_repo: int,
    max_per_fn: int,
    min_source_chars: int,
    max_source_chars: int,
) -> list[dict[str, Any]]:
    repo_name = _slug(repo_dir.name)
    source_files, test_files = _walk_py_files(repo_dir)
    unit_inputs = extract_unit_test_inputs(repo_dir, test_files)

    candidates: list[dict[str, Any]] = []
    for src_file in source_files:
        if len(candidates) >= max_per_repo * 3:
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
            if len(candidates) >= max_per_repo * 3:
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

            # Add compact fallback probes matching arity if unit-test inputs are scarce.
            if len(probes) < max_per_fn:
                fallback_arity = min_arity if min_arity in FALLBACK_PROBES_BY_ARITY else (
                    max_arity if max_arity in FALLBACK_PROBES_BY_ARITY else None
                )
                if fallback_arity is not None:
                    for raw_args in FALLBACK_PROBES_BY_ARITY[fallback_arity]:
                        probes.append((encode_readable(raw_args), False, None))

            kept_for_fn = 0
            seen_probe_sigs: set[str] = set()
            for encoded_args, from_unit_test, test_file in probes:
                if kept_for_fn >= max_per_fn:
                    break
                sig = _json_compact(encoded_args)
                if sig in seen_probe_sigs:
                    continue
                seen_probe_sigs.add(sig)

                probe = _probe_snippet(snippet, stmt.name, encoded_args)
                if not probe.get("ok"):
                    continue
                # For synthetic fallback probes, skip TypeError mismatches (wrong arg types).
                if not from_unit_test and probe.get("kind") == "throw":
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
                candidates.append({"repo": repo_name, "origin": origin, "task": task})
                kept_for_fn += 1

    return candidates


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Harvest verified Python execution tasks from local repos.")
    parser.add_argument("--local-repos", required=True, help="Directory containing local Python repository folders.")
    parser.add_argument("--output-dir", default="runs/tinker-harvest-py", help="Output directory for harvested.jsonl and census.json.")
    parser.add_argument("--jobs", type=int, default=4, help="Parallel qualification workers.")
    parser.add_argument("--max-per-repo", type=int, default=30, help="Max admitted tasks per repo.")
    parser.add_argument("--max-per-fn", type=int, default=3, help="Max admitted inputs per function.")
    parser.add_argument("--min-source-chars", type=int, default=200, help="Minimum self-contained snippet length.")
    parser.add_argument("--max-source-chars", type=int, default=35000, help="Maximum self-contained snippet length.")
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
        )
        all_candidates.extend(cands)

    records: list[dict[str, Any]] = []
    if all_candidates:
        if jobs == 1:
            records = [_qualify_candidate(c) for c in all_candidates]
        else:
            with concurrent.futures.ThreadPoolExecutor(max_workers=jobs) as pool:
                records = list(pool.map(_qualify_candidate, all_candidates))

    seen_dedup: set[tuple[str, str]] = set()
    repo_counts: dict[str, int] = {}
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
        task = rec["task"]
        input_sig = _sha256([task["entry"], task["args"], task["fixture"]])
        dedup_key = (rec["sourceHash"], input_sig)
        if dedup_key in seen_dedup:
            continue
        seen_dedup.add(dedup_key)
        repo_counts[rec["repo"]] = repo_counts.get(rec["repo"], 0) + 1
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
