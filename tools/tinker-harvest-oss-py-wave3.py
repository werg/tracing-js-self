#!/usr/bin/env python3
"""Real-World OSS Wave 3 (Python) Harvester: Pure Multi-File + Stateful-I/O + Counterfactuals.

Shallow-clones 140+ brand-new permissively-licensed real-world pure-Python multi-file
GitHub repositories (100% disjoint from RealExecBench v1 AND Stage 10!) into
`/tmp/oss-py-wave3-cache`, and harvests verified, 2x cross-PYTHONHASHSEED deterministic,
pre-exported multi-file `code.load` tasks across all three modes:

  Mode A (`mode_a_unit_test`):
    AST-extracts concrete literal call-sites from each repo's own `tests/` / `test/`
    suite (`@pytest.mark.parametrize`, loop unrolling, module/class constants,
    positional + keyword calls).

  Mode B (`mode_b_api_probe` & `mode_b_stateful_io`):
    Exercises curated & automatic cross-file public APIs across internal `.py` modules,
    PLUS 35+ real OSS repositories executed with genuine stateful I/O (`fs.*`, `env.get`,
    `sqlite3`, `http.request`, `shell.exec`, `platform.log`, `platform.time`, `platform.uuid`)
    against realistic seeded virtual FS/DB/env/HTTP workspaces.

  Mode C (`mode_c_mutation_pair` & `mode_c_stateful_pair`):
    - Real-world 1-line AST-mutation counterfactual pairs on non-entry `.py` modules
      (prioritizing same-byte-length edits so initial prompts stay identical and causal
      divergence occurs upon `code.load`).
    - Real-world stateful world-state counterfactual pairs (identical codebase/entry/args,
      contrasting seeded world states, verified via `_audit_causal_prefix_pair`).

Every admitted task is verified 2x independently across TWO DIFFERENT `PYTHONHASHSEED`
values (`101` direct `export_python_example` + live `create_python_session` replay vs
`202` via `tools/tinker-execution-py.py` JSONL bridge), enforcing byte-for-byte identical
`sourceHash` & `messages`, exact `cl100k_base` token budgets (max episode context <= 64,500,
max single assistant turn <= 19,500, 5..220 `.py` files, targeting 8K-56K codebase tokens),
`_is_preexported_row` schema validity, 5-axis 0-leakage vs RealExecBench v1, and 0-dupe vs
Stage 10 (`stage10-oss-merged.jsonl` + `stage10-merged.jsonl`).
"""

from __future__ import annotations

import argparse
import ast
import builtins
import concurrent.futures
from datetime import datetime, timezone
import hashlib
import http.server
import json
import math
import os
from pathlib import Path
import queue
import re
import shutil
import socketserver
import subprocess
import sys
import tempfile
import threading
from typing import Any
import warnings

try:
    import tiktoken as _tiktoken  # type: ignore[import-not-found]
    _TIKTOKEN_ENC = _tiktoken.get_encoding("cl100k_base")
except Exception:
    _TIKTOKEN_ENC = None

warnings.filterwarnings("ignore", category=SyntaxWarning)

_REPO_ROOT = Path(__file__).resolve().parents[1]
_TRAINING_DIR = str(_REPO_ROOT / "training")
if _TRAINING_DIR not in sys.path:
    sys.path.insert(0, _TRAINING_DIR)

from tinker_py.codebase import (  # noqa: E402
    CODE_LOAD_OPERATION,
    MAX_CODEBASE_FILES,
    MAX_CODEBASE_TOTAL_BYTES,
    module_name_and_package_for,
)
from tinker_py.codec import encode_readable  # noqa: E402
from tinker_py.execution import (  # noqa: E402
    _audit_causal_prefix_pair,
    assistant_thinking_text,
    assistant_visible_text,
    audit_python_supervision,
    create_python_session,
    export_python_example,
    prepare_python_task,
)

DEFAULT_REALEXEC_BENCHMARK = Path("/home/werg/tracing-js-self/runs/realexecbench-v1/benchmark.jsonl")
DEFAULT_REALEXEC_MANIFEST = Path("/home/werg/tracing-js-self/runs/realexecbench-v1/manifest.json")
DEFAULT_STAGE10_OSS_MERGED = Path("/home/werg/tracing-js-self/runs/messy-v8-stage10/stage10-oss-merged.jsonl")
DEFAULT_STAGE10_MERGED = Path("/home/werg/tracing-js-self/runs/messy-v8-stage10/stage10-merged.jsonl")
DEFAULT_CACHE_DIR = Path("/tmp/oss-py-wave3-cache")
DEFAULT_OUTPUT_DIR = _REPO_ROOT / "runs/oss-py-wave3"

HASH_SEED_PASS1 = "101"
HASH_SEED_PASS2 = "202"

MAX_EPISODE_CONTEXT_TOKENS = 64_500
MAX_SINGLE_TURN_TOKENS = 19_500
TARGET_CODEBASE_MIN_TOKENS = 8_000
TARGET_CODEBASE_MAX_TOKENS = 56_000

SKIP_DIRS = frozenset({
    ".git", "__pycache__", "venv", ".venv", "env", "node_modules",
    "build", "dist", "migrations", "docs", "doc", "examples", "example",
    "benchmarks", "scripts", ".tox", ".mypy_cache", ".pytest_cache",
    "site-packages", ".github", "stubs", "benchmarks_data",
})

BLOCKED_STDLIB_MODULES = frozenset({
    "socket", "ctypes", "multiprocessing", "signal", "shutil", "ftplib",
    "smtplib", "imaplib", "poplib", "webbrowser", "venv", "ensurepip",
    "pip", "pty", "tty", "termios", "fcntl", "mmap", "ssl", "getpass",
    "curses", "readline", "rlcompleter", "tkinter", "turtle", "xmlrpc",
    "wsgiref", "socketserver",
})

STDLIB_MODULES = frozenset(getattr(sys, "stdlib_module_names", ())) | frozenset({
    "abc", "array", "ast", "base64", "binascii", "bisect", "builtins", "calendar",
    "cmath", "codecs", "collections", "contextlib", "copy", "csv", "dataclasses",
    "datetime", "decimal", "difflib", "email", "enum", "errno", "fnmatch",
    "fractions", "functools", "gzip", "hashlib", "heapq", "hmac", "html", "http",
    "importlib", "inspect", "io", "ipaddress", "itertools", "json", "keyword",
    "locale", "logging", "math", "mimetypes", "numbers", "operator", "os",
    "pathlib", "pickle", "platform", "posixpath", "pprint", "quopri", "random",
    "re", "secrets", "sqlite3", "statistics", "string", "struct", "sys",
    "textwrap", "time", "token", "tokenize", "traceback", "types", "typing",
    "unicodedata", "urllib", "uuid", "warnings", "weakref", "xml", "zipfile",
    "zlib", "__future__",
})

IGNORED_TEST_CALLEES = frozenset(dir(builtins)) | frozenset({
    "assertEqual", "assertNotEqual", "assertTrue", "assertFalse", "assertIs",
    "assertIsNot", "assertIsNone", "assertIsNotNone", "assertIn", "assertNotIn",
    "assertRaises", "assertRaisesRegex", "assertAlmostEqual", "assertCountEqual",
    "assertDictEqual", "assertListEqual", "assertSetEqual", "assertTupleEqual",
    "raises", "approx", "parametrize", "skip", "xfail", "fail", "main",
    "fixture", "mark", "warns", "deprecated_call", "subTest", "patch", "Mock",
    "MagicMock", "call", "ANY", "NamedTuple", "dataclass",
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

# Static safety net (augmented dynamically from RealExecBench v1 + Stage 10 merged JSONLs)
STATIC_FORBIDDEN_PACKAGES = frozenset({
    # RealExecBench v1
    "idna", "mistune", "dirsearch", "you_get", "you-get", "pysnooper", "yapf",
    "xsstrike", "hackerrank", "jinja", "jinja2", "simplejson", "mailinabox",
    "microk8s", "billing_engine", "doc_indexer", "flag_service",
    # Stage 10 already harvested (pure + stateful + Wave 2)
    "packaging", "mdurl", "markdown_it", "markdown", "dateutil", "h11", "hpack",
    "hyperframe", "h2", "click", "attr", "attrs", "urllib3", "rich", "pygments",
    "networkx", "mpmath", "tqdm", "requests", "charset_normalizer", "chz",
    "colorama", "dns", "dnspython", "fuzzywuzzy", "thefuzz", "httpcore", "httpx",
    "jmespath", "pyflakes", "yaml", "pyyaml", "sqlparse", "tomlkit", "termcolor",
    "schedule", "icecream", "watchdog", "uvicorn", "paramiko", "tiktoken",
    "minbpe", "mingpt", "lazy_loader", "docx2python", "termtosvg", "httpbin",
    "webpy", "pgcli", "sshuttle", "yah3c", "jsonschema", "blessed",
    # Wave 2 yielded pure + stateful repos
    "funcy", "voluptuous", "arrow", "tld", "anytree", "box", "cheroot",
    "construct", "pathspec", "sly", "json5", "netaddr", "pycparser", "elftools",
    "starlette", "typesystem", "parsimonious", "falcon", "marko", "segno",
    "bidict", "kiss_headers", "tablib", "jsonpath", "jwt", "dpkt", "algorithms",
    "dacite", "authlib", "qrcode", "boltons", "apispec", "marshmallow", "mido",
    "mistletoe", "oauthlib", "cachelib", "itsdangerous", "werkzeug", "pyasn1",
    "cerberus", "distlib", "flit_core", "babel", "rfc3986", "cleo", "poetry",
    "semver", "validators", "toolz", "radon", "schematics", "number_parser",
    "w3lib", "crashtest", "rsa", "defusedxml", "cachetools", "pyrsistent",
    "toml", "slugify", "asn1crypto", "mccabe", "cfgv", "bottle", "docopt",
    "tomli", "tomli_w", "dj_database_url", "vulture", "tinydb", "platformdirs",
    "iniconfig", "dotenv", "python_dotenv",
})


# ===========================================================================
# Utility Helpers & Exact cl100k_base Token Counting
# ===========================================================================

def _json_compact(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def _sha256(value: Any) -> str:
    text = value if isinstance(value, str) else _json_compact(value)
    return hashlib.sha256(text.encode("utf-8", errors="surrogatepass")).hexdigest()


def _slug(text: str) -> str:
    return re.sub(r"[^A-Za-z0-9_.-]+", "_", text).strip("_")[:64] or "mod"


def _count_tokens(text: str) -> int:
    if _TIKTOKEN_ENC is not None:
        return len(_TIKTOKEN_ENC.encode(text, disallowed_special=()))
    return int(math.ceil(len(text) / 3.5))


def _codebase_tokens(files: dict[str, str]) -> int:
    return sum(_count_tokens(src) for src in files.values())


def _is_preexported_row(item: dict[str, Any]) -> bool:
    return (
        isinstance(item.get("messages"), list)
        and bool(item["messages"])
        and isinstance(item.get("sourceHash"), str)
        and isinstance(item.get("task"), dict)
    )


def _stats(vals: list[int]) -> dict[str, int] | None:
    if not vals:
        return None
    s = sorted(vals)
    return {
        "min": s[0],
        "p25": s[len(s) // 4],
        "median": s[len(s) // 2],
        "p75": s[(3 * len(s)) // 4],
        "p90": s[min(len(s) - 1, int(len(s) * 0.9))],
        "max": s[-1],
    }


def _norm_repo(val: str) -> str:
    return val.strip().lower().replace("__", "/")


def _load_forbidden_sets(
    reb_benchmark: Path,
    reb_manifest: Path,
    stage10_oss_merged: Path,
    stage10_merged: Path,
) -> dict[str, set[str]]:
    reb_ids: set[str] = set()
    reb_families: set[str] = set()
    reb_hashes: set[str] = set()
    reb_splits: set[str] = set()
    reb_repos: set[str] = set()
    reb_pkgs: set[str] = set()

    stage10_ids: set[str] = set()
    stage10_hashes: set[str] = set()
    stage10_repos: set[str] = set()
    stage10_pkgs: set[str] = set(STATIC_FORBIDDEN_PACKAGES)

    if reb_benchmark.is_file():
        for line in reb_benchmark.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            row = json.loads(line)
            t = row.get("task") if isinstance(row.get("task"), dict) else row
            for key_set, val in (
                (reb_ids, row.get("id") or t.get("id")),
                (reb_families, row.get("family") or t.get("family")),
                (reb_hashes, row.get("sourceHash") or t.get("sourceHash")),
                (reb_splits, row.get("split_component") or t.get("split_component")),
            ):
                if val:
                    key_set.add(str(val))
            for src in (row, row.get("metadata") or {}, t, t.get("metadata") or {}):
                if not isinstance(src, dict):
                    continue
                for k in ("repo", "github_repo", "project"):
                    v = src.get(k)
                    if isinstance(v, str) and v.strip():
                        nv = _norm_repo(v)
                        reb_repos.add(nv)
                        reb_pkgs.add(nv.split("/")[-1].removesuffix(".py"))
                for k in ("package", "pkg"):
                    v = src.get(k)
                    if isinstance(v, str) and v.strip():
                        reb_pkgs.add(v.strip().lower().removesuffix(".py"))
            for fp in (t.get("files") or {}):
                reb_pkgs.add(fp.split("/")[0].lower().removesuffix(".py"))

    if reb_manifest.is_file():
        man = json.loads(reb_manifest.read_text(encoding="utf-8"))
        for _track, id_list in (man.get("task_ids_by_track") or {}).items():
            for tid in id_list:
                reb_ids.add(str(tid))

    for s10_path in (stage10_oss_merged, stage10_merged):
        if not s10_path.is_file():
            continue
        with s10_path.open("r", encoding="utf-8") as fh:
            for line in fh:
                if not line.strip():
                    continue
                row = json.loads(line)
                t = row.get("task") if isinstance(row.get("task"), dict) else row
                tid = row.get("id") or t.get("id")
                sh = row.get("sourceHash") or t.get("sourceHash")
                if tid:
                    stage10_ids.add(str(tid))
                if sh:
                    stage10_hashes.add(str(sh))
                lang = str(t.get("language") or row.get("language") or "").lower()
                for src in (row, row.get("metadata") or {}, t, t.get("metadata") or {}):
                    if not isinstance(src, dict):
                        continue
                    for k in ("repo", "github_repo", "project"):
                        v = src.get(k)
                        if isinstance(v, str) and v.strip():
                            nv = _norm_repo(v)
                            stage10_repos.add(nv)
                            if lang == "py":
                                stage10_pkgs.add(nv.split("/")[-1].removesuffix(".py"))
                    for k in ("package", "pkg"):
                        v = src.get(k)
                        if isinstance(v, str) and v.strip() and lang == "py":
                            stage10_pkgs.add(v.strip().lower().removesuffix(".py"))
                if lang == "py":
                    for fp in (t.get("files") or {}):
                        top = fp.split("/")[0].lower()
                        if top not in ("_oss_probe", "_oss_test_call", "app", "pipeline"):
                            stage10_pkgs.add(top.removesuffix(".py"))

    return {
        "reb_ids": reb_ids,
        "reb_families": reb_families,
        "reb_hashes": reb_hashes,
        "reb_splits": reb_splits,
        "reb_repos": reb_repos,
        "reb_pkgs": reb_pkgs,
        "stage10_ids": stage10_ids,
        "stage10_hashes": stage10_hashes,
        "stage10_repos": stage10_repos,
        "stage10_pkgs": stage10_pkgs,
    }


def _repo_is_forbidden(repo_slug: str, pkg_hint: str | None, forbidden: dict[str, set[str]]) -> str | None:
    r_norm = _norm_repo(repo_slug)
    if r_norm in forbidden["reb_repos"]:
        return f"reb_repo:{r_norm}"
    if r_norm in forbidden["stage10_repos"]:
        return f"stage10_repo:{r_norm}"
    for tok in filter(None, [pkg_hint, r_norm.split("/")[-1]]):
        tl = tok.lower().removesuffix(".py")
        if tl in forbidden["reb_pkgs"]:
            return f"reb_pkg:{tl}"
        if tl in forbidden["stage10_pkgs"]:
            return f"stage10_pkg:{tl}"
    return None


# ===========================================================================
# Fault-Tolerant Shallow Clone Cache (/tmp/oss-py-wave3-cache)
# ===========================================================================

_CLONE_LOCKS: dict[str, threading.Lock] = {}
_CLONE_LOCKS_GUARD = threading.Lock()


def _clone_repo(repo_slug: str, cache_dir: Path, timeout_s: int = 90) -> tuple[Path | None, str | None]:
    with _CLONE_LOCKS_GUARD:
        lock = _CLONE_LOCKS.setdefault(repo_slug, threading.Lock())
    with lock:
        cache_dir.mkdir(parents=True, exist_ok=True)
        local_name = repo_slug.replace("/", "__")
        dest = cache_dir / local_name
        if (dest / ".git").exists() and any(p.name != ".git" for p in dest.iterdir()):
            return dest, None
        if dest.exists():
            shutil.rmtree(dest, ignore_errors=True)
        url = f"https://github.com/{repo_slug}.git"
        env = {**os.environ, "GIT_TERMINAL_PROMPT": "0", "GIT_ASKPASS": "true"}
        try:
            proc = subprocess.run(
                ["git", "clone", "--depth", "1", "--single-branch", "--no-tags", "--filter=blob:limit=700k", url, str(dest)],
                capture_output=True,
                text=True,
                timeout=timeout_s,
                env=env,
                check=False,
            )
            if proc.returncode != 0 or not (dest / ".git").exists():
                shutil.rmtree(dest, ignore_errors=True)
                proc = subprocess.run(
                    ["git", "clone", "--depth", "1", "--single-branch", "--no-tags", url, str(dest)],
                    capture_output=True,
                    text=True,
                    timeout=timeout_s,
                    env=env,
                    check=False,
                )
                if proc.returncode != 0 or not (dest / ".git").exists():
                    err = (proc.stderr or proc.stdout or "git clone failed").strip()[-300:]
                    shutil.rmtree(dest, ignore_errors=True)
                    return None, err
            return dest, None
        except Exception as exc:
            shutil.rmtree(dest, ignore_errors=True)
            return None, f"{type(exc).__name__}: {exc}"


# ===========================================================================
# Package Discovery (w/ synthetic _version.py + companion pure-Py deps)
# ===========================================================================

def _is_test_file(rel_path: Path) -> bool:
    parts = {p.lower() for p in rel_path.parts[:-1]}
    if parts & {"tests", "test", "testing", "test_suite"}:
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


def _resolve_internal_imports(
    rel_path: str,
    tree: ast.Module,
    mod_to_rel: dict[str, str],
) -> tuple[set[str], set[str]]:
    cur_mod, cur_pkg = module_name_and_package_for(rel_path)
    internal: set[str] = set()
    external_top: set[str] = set()

    def _add_if_internal(mod_name: str) -> bool:
        if mod_name in mod_to_rel:
            target = mod_to_rel[mod_name]
            if target != rel_path:
                internal.add(target)
            return True
        return False

    top_level_nodes = {id(n) for n in tree.body if isinstance(n, (ast.Import, ast.ImportFrom))}
    for node in ast.walk(tree):
        is_uncond = id(node) in top_level_nodes
        if isinstance(node, ast.Import):
            for alias in node.names:
                if not _add_if_internal(alias.name):
                    top = alias.name.split(".", 1)[0]
                    if not any(m == top or m.startswith(top + ".") for m in mod_to_rel):
                        if is_uncond:
                            external_top.add(top)
        elif isinstance(node, ast.ImportFrom):
            level = node.level or 0
            if level > 0:
                pkg_parts = cur_pkg.split(".") if cur_pkg else []
                up = level - 1
                base_parts = pkg_parts[: len(pkg_parts) - up] if up <= len(pkg_parts) else []
                base_mod = ".".join([*base_parts, *(node.module.split(".") if node.module else [])])
                if base_mod:
                    _add_if_internal(base_mod)
                for alias in node.names:
                    if alias.name != "*":
                        _add_if_internal(f"{base_mod}.{alias.name}" if base_mod else alias.name)
            elif node.module:
                matched = _add_if_internal(node.module)
                for alias in node.names:
                    if alias.name != "*" and _add_if_internal(f"{node.module}.{alias.name}"):
                        matched = True
                if not matched:
                    top = node.module.split(".", 1)[0]
                    if not any(m == top or m.startswith(top + ".") for m in mod_to_rel):
                        if is_uncond:
                            external_top.add(top)
    return internal, external_top


_SYNTH_VERSION_PY = (
    '"""Auto-generated build-time version stub for VCS-versioned OSS checkout."""\n'
    '__version__ = "0.0.0"\n'
    '__version_tuple__ = (0, 0, 0)\n'
    'version = "0.0.0"\n'
    'version_tuple = (0, 0, 0)\n'
    'VERSION = (0, 0, 0)\n'
)


def _inject_missing_version_modules(files_map: dict[str, str], trees_map: dict[str, ast.Module], pkg_name: str) -> None:
    """Synthesize build-time `_version.py` if referenced by AST imports (setuptools-scm/hatch-vcs)."""
    needed: set[str] = set()
    for rel, tree in list(trees_map.items()):
        _, cur_pkg = module_name_and_package_for(rel)
        for node in ast.walk(tree):
            if isinstance(node, ast.ImportFrom):
                mod = node.module or ""
                names = [a.name for a in node.names]
                if mod in ("_version", f"{pkg_name}._version") or "_version" in names:
                    target_dir = cur_pkg.replace(".", "/") if (node.level or 0) > 0 and cur_pkg else pkg_name
                    needed.add(f"{target_dir}/_version.py")
                elif mod in ("_scm_version", f"{pkg_name}._scm_version") or "_scm_version" in names:
                    target_dir = cur_pkg.replace(".", "/") if (node.level or 0) > 0 and cur_pkg else pkg_name
                    needed.add(f"{target_dir}/_scm_version.py")
    for rel_v in sorted(needed):
        if rel_v not in files_map:
            files_map[rel_v] = _SYNTH_VERSION_PY
            trees_map[rel_v] = ast.parse(_SYNTH_VERSION_PY)


def _discover_package_bundle(
    repo_dir: Path,
    preferred_pkg: str | None,
    *,
    min_pkg_files: int = 2,
    max_single_file_bytes: int = 680_000,
    companion_files: dict[str, str] | None = None,
) -> dict[str, Any] | None:
    """Discover the primary multi-file pure-Python package inside a cloned repo."""
    source_files, _ = _walk_py_files(repo_dir)
    if not source_files:
        return None

    pkg_roots: list[tuple[Path, Path]] = []
    seen_dirs: set[Path] = set()
    for sf in source_files:
        if sf.name == "__init__.py":
            cur = sf.parent
            while (
                cur != repo_dir
                and cur.parent != repo_dir
                and (cur.parent / "__init__.py").exists()
                and cur.parent.name.lower() not in ("src", "lib", "python")
            ):
                cur = cur.parent
            if cur != repo_dir and cur.name.lower() not in ("src", "lib", "python") and cur not in seen_dirs:
                seen_dirs.add(cur)
                pkg_roots.append((cur.parent, cur))

    candidates: list[dict[str, Any]] = []
    for import_root, pkg_dir in pkg_roots:
        files_map: dict[str, str] = {}
        trees_map: dict[str, ast.Module] = {}
        for sf in source_files:
            try:
                sf.relative_to(pkg_dir)
            except ValueError:
                continue
            if sf.name in ("setup.py", "conftest.py"):
                continue
            try:
                raw = sf.read_bytes()
            except OSError:
                continue
            if not raw or len(raw) > max_single_file_bytes or b"\x00" in raw:
                continue
            text = raw.decode("utf-8", errors="ignore")
            try:
                tree = ast.parse(text)
            except SyntaxError:
                continue
            rel = sf.relative_to(import_root).as_posix()
            files_map[rel] = text
            trees_map[rel] = tree
        if len(files_map) < min_pkg_files:
            continue
        _inject_missing_version_modules(files_map, trees_map, pkg_dir.name)
        if companion_files:
            for c_rel, c_src in companion_files.items():
                if c_rel not in files_map:
                    try:
                        c_tree = ast.parse(c_src)
                        files_map[c_rel] = c_src
                        trees_map[c_rel] = c_tree
                    except SyntaxError:
                        pass
        mod_to_rel = {module_name_and_package_for(p)[0]: p for p in files_map}
        edges: dict[str, set[str]] = {}
        ext_imports: dict[str, set[str]] = {}
        for rel, tree in trees_map.items():
            internal, ext = _resolve_internal_imports(rel, tree, mod_to_rel)
            edges[rel] = internal
            ext_imports[rel] = ext
        candidates.append({
            "pkgName": pkg_dir.name,
            "importRoot": import_root,
            "files": files_map,
            "trees": trees_map,
            "edges": edges,
            "extImports": ext_imports,
            "modToRel": mod_to_rel,
        })

    # Fallback (or preferred flat module like `peewee.py` alongside `playhouse/`):
    has_preferred_pkg_dir = any(
        preferred_pkg and c["pkgName"].lower() == preferred_pkg.lower()
        for c in candidates
    )
    if preferred_pkg and not has_preferred_pkg_dir:
        flat_files: dict[str, str] = {}
        flat_trees: dict[str, ast.Module] = {}
        for sf in source_files:
            if sf.name in ("setup.py", "noxfile.py", "conftest.py", "runtests.py", "bench.py"):
                continue
            parent_rel = sf.parent.relative_to(repo_dir).as_posix()
            if parent_rel not in (".", "src", "lib"):
                continue
            try:
                raw = sf.read_bytes()
            except OSError:
                continue
            if not raw or len(raw) > max_single_file_bytes or b"\x00" in raw:
                continue
            text = raw.decode("utf-8", errors="ignore")
            try:
                tree = ast.parse(text)
            except SyntaxError:
                continue
            flat_files[sf.name] = text
            flat_trees[sf.name] = tree
        if f"{preferred_pkg}.py" in flat_files:
            # Also include sibling packages (e.g. `playhouse/` for `peewee`) up to 40 files
            if candidates:
                for k, v in list(candidates[0]["files"].items())[:40]:
                    if k not in flat_files:
                        flat_files[k] = v
                        flat_trees[k] = candidates[0]["trees"][k]
            if companion_files:
                for c_rel, c_src in companion_files.items():
                    if c_rel not in flat_files:
                        try:
                            flat_trees[c_rel] = ast.parse(c_src)
                            flat_files[c_rel] = c_src
                        except SyntaxError:
                            pass
            mod_to_rel = {module_name_and_package_for(p)[0]: p for p in flat_files}
            edges = {}
            ext_imports = {}
            for rel, tree in flat_trees.items():
                internal, ext = _resolve_internal_imports(rel, tree, mod_to_rel)
                edges[rel] = internal
                ext_imports[rel] = ext
            candidates.append({
                "pkgName": preferred_pkg,
                "importRoot": repo_dir,
                "files": flat_files,
                "trees": flat_trees,
                "edges": edges,
                "extImports": ext_imports,
                "modToRel": mod_to_rel,
            })

    if not candidates:
        return None
    candidates.sort(
        key=lambda b: (
            0 if (preferred_pkg and b["pkgName"].lower() == preferred_pkg.lower()) else 1,
            -len(b["files"]),
            b["pkgName"],
        )
    )
    return candidates[0]


def _load_companion_files(companion_specs: list[tuple[str, str]], cache_dir: Path) -> dict[str, str]:
    """Load tiny pure-Python companion dependencies (e.g., webencodings, orderedmultidict, sgmllib3k)."""
    merged: dict[str, str] = {}
    for c_repo, c_pkg in companion_specs:
        c_dir, _err = _clone_repo(c_repo, cache_dir)
        if c_dir is None:
            continue
        cb = _discover_package_bundle(c_dir, c_pkg, min_pkg_files=1)
        if cb is not None:
            for k, v in cb["files"].items():
                merged.setdefault(k, v)
    return merged


def _build_bounded_file_set(
    bundle: dict[str, Any],
    *,
    entry_rel: str,
    extra_files: dict[str, str] | None = None,
    min_files: int = 5,
    max_files: int = 220,
    target_max_codebase_bytes: int = 220_000,
    hard_max_package_bytes: int = 3_600_000,
    require_static_closure: bool = True,
) -> dict[str, str] | None:
    """Build a bounded [min_files..max_files] file dict targeting the 8K-56K codebase token band."""
    all_files: dict[str, str] = dict(bundle["files"])
    if extra_files:
        all_files.update(extra_files)
    edges: dict[str, set[str]] = bundle["edges"]
    ext_imports: dict[str, set[str]] = bundle["extImports"]
    mod_to_rel: dict[str, str] = dict(bundle["modToRel"])
    if extra_files:
        for p in extra_files:
            mod_to_rel[module_name_and_package_for(p)[0]] = p

    closure: set[str] = {entry_rel}
    q = [entry_rel]
    if extra_files:
        for ep, esrc in extra_files.items():
            if ep not in closure:
                closure.add(ep)
                q.append(ep)
            try:
                tree = ast.parse(esrc)
                init_deps, _ = _resolve_internal_imports(ep, tree, mod_to_rel)
                for d in sorted(init_deps):
                    if d not in closure:
                        closure.add(d)
                        q.append(d)
            except SyntaxError:
                pass
    while q:
        cur = q.pop(0)
        parts = cur.split("/")
        for i in range(1, len(parts)):
            init_rel = "/".join(parts[:i]) + "/__init__.py"
            if init_rel in all_files and init_rel not in closure:
                closure.add(init_rel)
                q.append(init_rel)
        for dep in sorted(edges.get(cur, ())):
            if dep not in closure:
                closure.add(dep)
                q.append(dep)

    if require_static_closure and len(closure) < 2:
        return None
    if len(closure) > max_files:
        return None

    if require_static_closure:
        for rel in closure:
            for ext_mod in ext_imports.get(rel, ()):
                if ext_mod in BLOCKED_STDLIB_MODULES or ext_mod not in STDLIB_MODULES:
                    return None

    # Always keep the full static closure (plus any small whole-repo when <= 56K tokens / 220 KB)
    total_bytes = sum(len(s.encode("utf-8")) for s in all_files.values())
    if min_files <= len(all_files) <= max_files and total_bytes <= target_max_codebase_bytes:
        return dict(sorted(all_files.items()))

    selected: dict[str, str] = {p: all_files[p] for p in sorted(closure) if p in all_files}
    used_bytes = sum(len(s.encode("utf-8")) for s in selected.values())
    if used_bytes > hard_max_package_bytes:
        return None

    # Fill sibling/package distractors up to target_max_codebase_bytes (~55K tokens) or min_files
    closure_dirs = {p.rsplit("/", 1)[0] if "/" in p else "" for p in closure}
    others = [p for p in sorted(all_files.keys()) if p not in selected]
    others.sort(
        key=lambda p: (
            0 if p.endswith("/__init__.py") else 1,
            0 if (p.rsplit("/", 1)[0] if "/" in p else "") in closure_dirs else 1,
            len(all_files[p]),
            p,
        )
    )
    byte_cap = max(target_max_codebase_bytes, min(hard_max_package_bytes, used_bytes + 60_000))
    for p in others:
        if len(selected) >= max_files:
            break
        b = len(all_files[p].encode("utf-8"))
        if used_bytes + b > byte_cap and len(selected) >= min_files:
            continue
        if used_bytes + b > hard_max_package_bytes:
            continue
        selected[p] = all_files[p]
        used_bytes += b

    if len(selected) < min_files:
        return None
    return dict(sorted(selected.items()))


# ===========================================================================
# AST Unit-Test Extractor (Mode A)
# ===========================================================================

def _eval_const_expr(node: ast.AST, env: dict[str, Any], depth: int = 0) -> tuple[bool, Any]:
    if depth > 14:
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
            if isinstance(left, (int, float)) and not isinstance(left, bool) and isinstance(right, (int, float)) and not isinstance(right, bool):
                return True, left + right
        return False, None
    if isinstance(node, ast.List):
        items = []
        for elt in node.elts:
            ok, v = _eval_const_expr(elt, env, depth + 1)
            if not ok:
                return False, None
            items.append(v)
        return True, items
    if isinstance(node, ast.Tuple):
        items = []
        for elt in node.elts:
            ok, v = _eval_const_expr(elt, env, depth + 1)
            if not ok:
                return False, None
            items.append(v)
        return True, tuple(items)
    if isinstance(node, ast.Dict):
        out: dict[Any, Any] = {}
        for kn, vn in zip(node.keys, node.values):
            if kn is None:
                return False, None
            ok_k, kv = _eval_const_expr(kn, env, depth + 1)
            ok_v, vv = _eval_const_expr(vn, env, depth + 1)
            if not (ok_k and ok_v):
                return False, None
            try:
                out[kv] = vv
            except TypeError:
                return False, None
        return True, out
    if isinstance(node, ast.Call) and isinstance(node.func, ast.Name):
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
        if isinstance(owner, ast.Name) and owner.id in ("self", "cls", "pytest", "unittest", "assert", "mock"):
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
        for st, sv in zip(target.elts, value):
            if not _bind_loop_target(st, sv, env):
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
        argnames_node = dec.args[0] if len(dec.args) >= 1 else None
        argvalues_node = dec.args[1] if len(dec.args) >= 2 else None
        for kw in dec.keywords:
            if kw.arg == "argnames" and argnames_node is None:
                argnames_node = kw.value
            elif kw.arg == "argvalues" and argvalues_node is None:
                argvalues_node = kw.value
        if argnames_node is None or argvalues_node is None:
            continue
        ok_n, raw_n = _eval_const_expr(argnames_node, env)
        if not ok_n:
            continue
        if isinstance(raw_n, str):
            names = [p.strip() for p in raw_n.split(",") if p.strip()]
        elif isinstance(raw_n, (list, tuple)) and all(isinstance(x, str) for x in raw_n):
            names = [x.strip() for x in raw_n if x.strip()]
        else:
            continue
        ok_r, rows = _eval_const_expr(argvalues_node, env)
        if not ok_r or not isinstance(rows, (list, tuple)) or not names:
            continue
        row_dicts: list[dict[str, Any]] = []
        if len(names) == 1:
            for r in rows[:24]:
                row_dicts.append({names[0]: r})
        else:
            for r in rows[:24]:
                if isinstance(r, (tuple, list)) and len(r) == len(names):
                    row_dicts.append(dict(zip(names, r)))
        if not row_dicts:
            continue
        combined: list[dict[str, Any]] = []
        for base in envs:
            for rd in row_dicts:
                combined.append({**base, **rd})
                if len(combined) >= 48:
                    break
            if len(combined) >= 48:
                break
        envs = combined
    return envs


def extract_unit_test_inputs(repo_dir: Path, test_files: list[Path]) -> dict[str, list[dict[str, Any]]]:
    by_fn: dict[str, list[dict[str, Any]]] = {}
    seen_per_fn: dict[str, set[str]] = {}

    def record_call(fn_name: str, args: list[Any], kwargs: dict[str, Any], rel_file: str) -> None:
        if fn_name.startswith("_") or fn_name in IGNORED_TEST_CALLEES:
            return
        try:
            enc_args = encode_readable(args)
            enc_kwargs = encode_readable(kwargs) if kwargs else {}
            sig = _json_compact([enc_args, enc_kwargs])
            sig.encode("utf-8")
        except Exception:
            return
        if len(sig) > 5000:
            return
        seen = seen_per_fn.setdefault(fn_name, set())
        if sig in seen or len(seen) >= 24:
            return
        seen.add(sig)
        by_fn.setdefault(fn_name, []).append({
            "args": enc_args,
            "kwargs": enc_kwargs,
            "file": rel_file,
        })

    def scan_expr(node: ast.AST, env: dict[str, Any], aliases: dict[str, str], rel_file: str) -> None:
        for sub in ast.walk(node):
            if isinstance(sub, ast.Call):
                if any(isinstance(a, ast.Starred) for a in sub.args):
                    continue
                if any(kw.arg is None for kw in sub.keywords):
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
                if not ok_all:
                    continue
                kw_vals: dict[str, Any] = {}
                for kw in sub.keywords:
                    assert kw.arg is not None
                    ok, v = _eval_const_expr(kw.value, env)
                    if not ok:
                        ok_all = False
                        break
                    kw_vals[kw.arg] = v
                if ok_all:
                    record_call(callee, vals, kw_vals, rel_file)

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
                    for item in list(seq)[:24]:
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

    for tf in test_files[:80]:
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


def _fn_arity_bounds(fn_node: ast.FunctionDef | ast.AsyncFunctionDef) -> tuple[int, int | None]:
    args = fn_node.args
    pos_count = len(args.posonlyargs) + len(args.args)
    default_count = len(args.defaults)
    min_arity = max(0, pos_count - default_count)
    for _kw, kw_def in zip(args.kwonlyargs, args.kw_defaults):
        if kw_def is None:
            return (99, 99)
    max_arity = None if args.vararg is not None else pos_count
    return min_arity, max_arity


def _smart_probes_for_fn(fn_node: ast.FunctionDef | ast.AsyncFunctionDef, min_arity: int, max_arity: int | None) -> list[list[Any]]:
    arg_names = [a.arg.lower() for a in [*fn_node.args.posonlyargs, *fn_node.args.args]]
    probes: list[list[Any]] = []

    def _guess(name: str) -> list[Any]:
        if any(k in name for k in ("url", "uri", "link", "href")):
            return ["https://example.com:8443/api/v2/items?sort=asc&tag=py#top"]
        if any(k in name for k in ("sql", "query")):
            return ["SELECT u.id, u.name FROM users u WHERE u.active = 1"]
        if any(k in name for k in ("html", "xml", "markup", "doc")):
            return ["<div class='card'><h1>Hello</h1><p>World &amp; <b>Python</b></p></div>"]
        if any(k in name for k in ("md", "markdown")):
            return ["# Title\n\n- item **one**\n- item `two`\n"]
        if any(k in name for k in ("toml",)):
            return ['[project]\nname = "demo"\nversion = "1.2.3"\n']
        if any(k in name for k in ("json",)):
            return ['{"service":"api","retries":3,"flags":[true,false]}']
        if any(k in name for k in ("expr", "path", "pattern", "spec", "ver", "version", "req", "marker")):
            return ["foo.bar[0].baz", ">=1.2.3,<2.0.0", "1.4.2"]
        if any(k in name for k in ("date", "time", "dt", "ts", "stamp", "cron")):
            return ["2026-05-14T09:30:00Z", "*/15 9-17 * * 1-5"]
        if any(k in name for k in ("text", "str", "msg", "line", "word", "name", "title", "slug", "code", "src", "s")):
            return ["hello world 123", "foo_bar-baz"]
        if any(k in name for k in ("dict", "map", "cfg", "config", "obj", "data", "mapping", "schema")):
            return [{"a": 1, "b": {"nested": [2, 3]}, "c": "ok"}]
        if any(k in name for k in ("items", "vals", "values", "nums", "list", "seq", "arr", "tokens", "xs", "rows")):
            return [[3, 1, 4, 1, 5], ["alpha", "beta", "gamma"]]
        if any(k in name for k in ("num", "count", "size", "limit", "index", "idx", "n", "x", "y", "k")):
            return [12, 5]
        return []

    if min_arity == 1 and arg_names:
        for val in _guess(arg_names[0]):
            probes.append([val])
    elif min_arity == 2 and len(arg_names) >= 2:
        g0, g1 = _guess(arg_names[0]), _guess(arg_names[1])
        if g0 and g1:
            probes.append([g0[0], g1[0]])
    fallback_arity = min_arity if min_arity in FALLBACK_PROBES_BY_ARITY else (
        max_arity if max_arity in FALLBACK_PROBES_BY_ARITY else None
    )
    if fallback_arity is not None:
        probes.extend(FALLBACK_PROBES_BY_ARITY[fallback_arity])
    return probes


# ===========================================================================
# Deterministic Local HTTP Server (supports single OR sequential retry routes!)
# ===========================================================================

class _DeterministicHttpServer:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self.routes: dict[str, Any] = {}
        self._counts: dict[str, int] = {}
        self._server: socketserver.TCPServer | None = None
        self._thread: threading.Thread | None = None
        self.port: int = 0

    def start(self) -> int:
        owner = self

        class _Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, format: str, *args: Any) -> None:  # noqa: A002
                return None

            def _serve(self) -> None:
                with owner._lock:
                    spec = owner.routes.get(self.path)
                    idx = owner._counts.get(self.path, 0)
                    owner._counts[self.path] = idx + 1
                if spec is None:
                    self.send_response(404)
                    self.send_header("Content-Type", "application/json")
                    body = b'{"error":"not_found"}'
                    self.send_header("Content-Length", str(len(body)))
                    self.end_headers()
                    self.wfile.write(body)
                    return
                if isinstance(spec, list):
                    status, headers, body = spec[min(idx, len(spec) - 1)]
                else:
                    status, headers, body = spec
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

    def set_routes(self, routes: dict[str, Any]) -> None:
        with self._lock:
            self.routes = dict(routes)
            self._counts = {}

    def stop(self) -> None:
        if self._server is not None:
            self._server.shutdown()
            self._server.server_close()
            self._server = None


# ===========================================================================
# Isolated Subprocess Live-Capture Probe (Pure Multi-File & Stateful-I/O)
# ===========================================================================

_UNIFIED_PROBE_SCRIPT = r"""
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
    files, entry_file, _init = normalize_codebase_files(req["files"], req["entryFile"])
    entry = req["entry"]
    args = decode_readable(req["args"])
    collect_lines = bool(req.get("collectLines", False))
    stateful_mode = bool(req.get("statefulMode", False))

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
    if stateful_mode:
        random.seed(17)
    else:
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

    guest_to_rel = {guest_filename_for(p): p for p in files}
    touched_non_entry = set()
    executed_lines = {}
    events = [0]

    def _line_trace(frame, event, _arg):
        rel = guest_to_rel.get(frame.f_code.co_filename)
        if rel is None:
            return None
        events[0] += 1
        if events[0] > 90000:
            raise RuntimeError("trace event budget exceeded")
        if rel != entry_file:
            touched_non_entry.add(rel)
            if event == "line":
                s = executed_lines.setdefault(rel, set())
                if len(s) < 400:
                    s.add(frame.f_lineno)
        return _line_trace

    def _call_trace(frame, event, _arg):
        if event != "call":
            return None
        rel = guest_to_rel.get(frame.f_code.co_filename)
        if rel is None:
            return None
        events[0] += 1
        if events[0] > 80000:
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
        sys.settrace(_line_trace if collect_lines else _call_trace)
        try:
            if inspect.iscoroutinefunction(fn):
                result = asyncio.run(fn(*args))
            else:
                raw_result = fn(*args)
                if inspect.isawaitable(raw_result):
                    result = asyncio.run(raw_result)
                else:
                    result = raw_result
            flush_io()
        except Exception as exc:
            kind = "throw"
            result = encode_exception(exc)
        finally:
            sys.settrace(None)
    finally:
        sys.stdout = real_stdout
        if hasattr(signal, "SIGALRM"):
            signal.setitimer(signal.ITIMER_REAL, 0.0)

    enc_out = encode_readable({"arguments": args, "value": result})
    out_obj = {
        "ok": True,
        "kind": kind,
        "result": enc_out,
        "recordedCalls": recorded,
        "touchedFiles": sorted(touched_non_entry),
    }
    if collect_lines:
        out_obj["executedLines"] = {k: sorted(v) for k, v in sorted(executed_lines.items())}
    real_stdout.write(json.dumps(out_obj, ensure_ascii=True, separators=(",", ":"), allow_nan=False) + "\n")
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


def _probe_multifile(
    files: dict[str, str],
    entry_file: str,
    entry: str,
    encoded_args: list[Any],
    *,
    collect_lines: bool = False,
    hash_seed: str = HASH_SEED_PASS1,
    world_files: dict[str, str | bytes] | None = None,
    world_env: dict[str, str] | None = None,
    init_git: bool = False,
    stateful_mode: bool = False,
) -> dict[str, Any]:
    payload = _json_compact({
        "files": files,
        "entryFile": entry_file,
        "entry": entry,
        "args": encoded_args,
        "collectLines": collect_lines,
        "statefulMode": stateful_mode,
    })
    try:
        with tempfile.TemporaryDirectory(prefix="py-wave3-probe-") as tmpdir:
            workdir = Path(tmpdir)
            if world_files:
                _seed_workspace(workdir, world_files, init_git=init_git)
            elif init_git:
                _seed_workspace(workdir, {}, init_git=True)
            if stateful_mode:
                env = {
                    "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
                    "HOME": str(workdir),
                    "LANG": "C.UTF-8",
                    "LC_ALL": "C.UTF-8",
                    "PYTHONHASHSEED": hash_seed,
                }
                if world_env:
                    env.update(world_env)
            else:
                env = {**os.environ, "PYTHONHASHSEED": hash_seed}
            proc = subprocess.run(
                [sys.executable, "-c", _UNIFIED_PROBE_SCRIPT, _TRAINING_DIR],
                input=payload,
                capture_output=True,
                text=True,
                cwd=workdir,
                timeout=18.0 if stateful_mode else 12.0,
                env=env,
                check=False,
            )
        out = proc.stdout.strip()
        if not out:
            return {"ok": False, "error": proc.stderr.strip()[-250:] or f"empty probe stdout rc={proc.returncode}"}
        return json.loads(out.splitlines()[-1])
    except Exception as exc:
        return {"ok": False, "error": f"{type(exc).__name__}: {exc}"}


# ===========================================================================
# Mode C1: Clean 1-Line AST Behavioral Mutation Engine
# ===========================================================================

_SAME_LEN_CMP_SWAPS: dict[type[ast.cmpop], tuple[str, str]] = {
    ast.Eq: ("==", "!="),
    ast.NotEq: ("!=", "=="),
    ast.Lt: ("<", ">"),
    ast.Gt: (">", "<"),
    ast.LtE: ("<=", ">="),
    ast.GtE: (">=", "<="),
}

_BOUNDARY_CMP_SWAPS: dict[type[ast.cmpop], tuple[str, str]] = {
    ast.Lt: ("<", "<="),
    ast.LtE: ("<=", "<"),
    ast.Gt: (">", ">="),
    ast.GtE: (">=", ">"),
    ast.In: (" in ", " not in "),
    ast.NotIn: (" not in ", " in "),
}


def _enumerate_1line_ast_mutations(
    src: str,
    executed_lines: set[int],
    *,
    max_candidates: int = 24,
) -> list[dict[str, Any]]:
    try:
        tree = ast.parse(src)
    except SyntaxError:
        return []

    lines = src.splitlines(keepends=True)
    tier1: list[dict[str, Any]] = []
    tier2: list[dict[str, Any]] = []
    seen_edits: set[tuple[int, str]] = set()

    def _try_add(lineno: int, new_line: str, kind: str, before_tok: str, after_tok: str, same_len: bool) -> None:
        if not (1 <= lineno <= len(lines)):
            return
        orig_line = lines[lineno - 1]
        if new_line == orig_line:
            return
        key = (lineno, new_line)
        if key in seen_edits:
            return
        seen_edits.add(key)
        candidate_lines = list(lines)
        candidate_lines[lineno - 1] = new_line
        mutated_src = "".join(candidate_lines)
        try:
            ast.parse(mutated_src)
        except SyntaxError:
            return
        rec = {
            "lineno": lineno,
            "kind": kind,
            "before": orig_line.rstrip("\r\n"),
            "after": new_line.rstrip("\r\n"),
            "beforeToken": before_tok,
            "afterToken": after_tok,
            "sameByteLength": len(new_line.encode("utf-8")) == len(orig_line.encode("utf-8")),
            "source": mutated_src,
        }
        if same_len and rec["sameByteLength"]:
            tier1.append(rec)
        else:
            tier2.append(rec)

    def _slice_span(node: ast.AST) -> tuple[int, int, int] | None:
        ln = getattr(node, "lineno", None)
        end_ln = getattr(node, "end_lineno", None)
        col = getattr(node, "col_offset", None)
        end_col = getattr(node, "end_col_offset", None)
        if ln is None or end_ln is None or col is None or end_col is None:
            return None
        if ln != end_ln or ln not in executed_lines:
            return None
        if not (1 <= ln <= len(lines)):
            return None
        return ln, col, end_col

    range_arg_ids: set[int] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == "range":
            for a in node.args:
                for sub in ast.walk(a):
                    range_arg_ids.add(id(sub))

    for node in ast.walk(tree):
        if len(tier1) + len(tier2) >= max_candidates * 3:
            break
        if isinstance(node, ast.Compare) and len(node.ops) == 1 and len(node.comparators) == 1:
            span = _slice_span(node)
            if span is None:
                continue
            ln, _col, _end_col = span
            orig_line = lines[ln - 1]
            left_end = getattr(node.left, "end_col_offset", None)
            right_start = getattr(node.comparators[0], "col_offset", None)
            if left_end is None or right_start is None or left_end > right_start:
                continue
            op_region = orig_line[left_end:right_start]
            op_type = type(node.ops[0])
            if op_type in _SAME_LEN_CMP_SWAPS:
                old_op, new_op = _SAME_LEN_CMP_SWAPS[op_type]
                if old_op in op_region:
                    new_line = orig_line[:left_end] + op_region.replace(old_op, new_op, 1) + orig_line[right_start:]
                    _try_add(ln, new_line, f"cmp:{old_op}->{new_op}", old_op, new_op, same_len=True)
            if op_type in _BOUNDARY_CMP_SWAPS:
                old_op, new_op = _BOUNDARY_CMP_SWAPS[op_type]
                if old_op in op_region:
                    new_line = orig_line[:left_end] + op_region.replace(old_op, new_op, 1) + orig_line[right_start:]
                    _try_add(ln, new_line, f"cmp:{old_op.strip()}->{new_op.strip()}", old_op.strip(), new_op.strip(), same_len=False)
        elif isinstance(node, ast.BinOp) and isinstance(node.op, (ast.Add, ast.Sub)):
            span = _slice_span(node)
            if span is None:
                continue
            ln, _col, _end_col = span
            orig_line = lines[ln - 1]
            left_end = getattr(node.left, "end_col_offset", None)
            right_start = getattr(node.right, "col_offset", None)
            if left_end is None or right_start is None or left_end > right_start:
                continue
            op_region = orig_line[left_end:right_start]
            old_op, new_op = ("+", "-") if isinstance(node.op, ast.Add) else ("-", "+")
            if old_op in op_region:
                new_line = orig_line[:left_end] + op_region.replace(old_op, new_op, 1) + orig_line[right_start:]
                _try_add(ln, new_line, f"binop:{old_op}->{new_op}", old_op, new_op, same_len=True)
        elif isinstance(node, ast.Constant):
            if id(node) in range_arg_ids:
                continue
            span = _slice_span(node)
            if span is None:
                continue
            ln, col, end_col = span
            orig_line = lines[ln - 1]
            seg = orig_line[col:end_col]
            if isinstance(node.value, bool):
                if seg in ("True", "False"):
                    repl = "False" if seg == "True" else "True"
                    new_line = orig_line[:col] + repl + orig_line[end_col:]
                    _try_add(ln, new_line, f"bool:{seg}->{repl}", seg, repl, same_len=False)
            elif isinstance(node.value, int) and seg.isdigit() and len(seg) == 1:
                v = node.value
                repl = str(v + 1 if v < 9 else v - 1)
                new_line = orig_line[:col] + repl + orig_line[end_col:]
                _try_add(ln, new_line, f"int:{seg}->{repl}", seg, repl, same_len=True)
        elif isinstance(node, ast.If):
            span = _slice_span(node.test)
            if span is None:
                continue
            ln, col, end_col = span
            orig_line = lines[ln - 1]
            seg = orig_line[col:end_col]
            if seg and not seg.startswith("not "):
                new_line = orig_line[:col] + f"not ({seg})" + orig_line[end_col:]
                _try_add(ln, new_line, "if:negate", seg[:40], f"not ({seg[:34]})", same_len=False)

    return (tier1 + tier2)[:max_candidates]


# ===========================================================================
# 2x Cross-PYTHONHASHSEED Verification Harness (101 vs 202 + Live Replay)
# ===========================================================================

class _PyWorkerClient:
    """Thread-safe persistent client for `tools/tinker-execution-py.py` with explicit PYTHONHASHSEED."""

    def __init__(self, hash_seed: str = HASH_SEED_PASS2) -> None:
        self._hash_seed = hash_seed
        self._lock = threading.Lock()
        self._seq = 0
        self._proc: subprocess.Popen[str] | None = None
        self._start()

    def _start(self) -> None:
        self._proc = subprocess.Popen(
            [sys.executable, str(_REPO_ROOT / "tools/tinker-execution-py.py")],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
            env={**os.environ, "PYTHONPATH": _TRAINING_DIR, "PYTHONHASHSEED": self._hash_seed},
        )
        health = self._raw_request("health")
        if not health.get("schema"):
            raise RuntimeError(f"Unhealthy worker: {health}")

    def _raw_request(self, op: str, **kwargs: Any) -> Any:
        assert self._proc is not None and self._proc.stdin and self._proc.stdout
        self._seq += 1
        req_id = f"req-{self._seq}"
        payload = {"id": req_id, "op": op, **kwargs}
        self._proc.stdin.write(_json_compact(payload) + "\n")
        self._proc.stdin.flush()
        line = self._proc.stdout.readline()
        if not line:
            err = self._proc.stderr.read() if self._proc.stderr else ""
            raise RuntimeError(f"Worker EOF on {op}: {err[-300:]}")
        resp = json.loads(line)
        if not resp.get("ok"):
            raise RuntimeError(f"Worker error on {op}: {resp.get('error')}")
        return resp["result"]

    def request(self, op: str, **kwargs: Any) -> Any:
        with self._lock:
            try:
                return self._raw_request(op, **kwargs)
            except Exception:
                self.close_unlocked()
                self._start()
                raise

    def close_unlocked(self) -> None:
        if self._proc is not None:
            try:
                if self._proc.stdin:
                    self._proc.stdin.close()
                self._proc.wait(timeout=3)
            except Exception:
                try:
                    self._proc.kill()
                except Exception:
                    pass
            self._proc = None

    def close(self) -> None:
        with self._lock:
            self.close_unlocked()


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


def _verify_and_preexport_task(
    task: dict[str, Any],
    worker_pool: queue.Queue[_PyWorkerClient],
    forbidden: dict[str, set[str]],
    *,
    min_tokens: int = 1500,
    max_context_tokens: int = MAX_EPISODE_CONTEXT_TOKENS,
    max_turn_tokens: int = MAX_SINGLE_TURN_TOKENS,
    min_files: int = 5,
    max_files: int = 220,
    require_external_io: bool = False,
    forced_trace_format: str | None = None,
) -> tuple[dict[str, Any] | None, str | None]:
    """2x verify task (Pass 1 direct + live replay w/ seed 101; Pass 2 bridge w/ seed 202).

    Tries `compact` first for rich line-by-line narration; automatically falls back to
    `actions-only` if `compact` exceeds exact cl100k_base token budgets or hits
    non-deterministic local-variable repr/set-order across PYTHONHASHSEED=101 vs 202.
    """
    files = task.get("files") or {}
    if not (min_files <= len(files) <= max_files):
        return None, f"file-count-out-of-bounds:{len(files)}"

    formats_to_try = [forced_trace_format] if forced_trace_format else ["compact", "actions-only"]
    last_err = "unknown"

    for fmt in formats_to_try:
        try:
            pass1 = export_python_example(task, trace_format=fmt, reasoning_channel="thinking")
            audit1 = pass1["metadata"]["traceAudit"]
            if not audit1.get("replayVerified"):
                last_err = f"{fmt}:pass1-replay-not-verified"
                continue
            code_loads = int(pass1["metadata"].get("codeLoadCalls", 0))
            if code_loads < 1:
                return None, "zero-code-load-calls"
            ext_calls = int(pass1["metadata"].get("externalCalls", 0))
            if require_external_io and ext_calls < 1:
                return None, "zero-external-io-calls"

            narration_lines = int(audit1.get("narrationLines", 0))
            if fmt == "compact" and narration_lines < 2:
                return None, f"trace-too-short:{narration_lines}"

            msgs = pass1["messages"]
            declared, used = _extract_declared_and_used_tools(msgs)
            undeclared = [op for op in used if op not in declared]
            if undeclared:
                return None, f"undeclared-tools:{sorted(set(undeclared))}"

            serialized = _json_compact(msgs)
            total_context_tokens = _count_tokens(serialized)
            if total_context_tokens < min_tokens:
                return None, f"tokens-below-min:{total_context_tokens}"
            if total_context_tokens > max_context_tokens:
                last_err = f"{fmt}:context-tokens-above-max:{total_context_tokens}"
                continue

            max_asst_turn_toks = 0
            for m in msgs:
                if m.get("role") == "assistant":
                    t_text = assistant_thinking_text(m) + "\n" + assistant_visible_text(m)
                    if isinstance(m.get("tool_calls"), list):
                        t_text += "\n" + _json_compact(m["tool_calls"])
                    t_toks = _count_tokens(t_text)
                    if t_toks > max_asst_turn_toks:
                        max_asst_turn_toks = t_toks
            if max_asst_turn_toks > max_turn_tokens:
                last_err = f"{fmt}:turn-too-large:{max_asst_turn_toks}"
                continue

            # Pass 2: Independent export through persistent JSONL bridge w/ PYTHONHASHSEED=202!
            worker = worker_pool.get()
            try:
                pass2 = worker.request(
                    "export",
                    task=task,
                    traceFormat=fmt,
                    reasoningChannel="thinking",
                )
            finally:
                worker_pool.put(worker)

            if pass1["sourceHash"] != pass2["sourceHash"]:
                last_err = f"{fmt}:nondeterministic-sourceHash"
                continue
            if pass1["messages"] != pass2["messages"]:
                last_err = f"{fmt}:nondeterministic-messages-across-hashseed"
                continue

            # Live create_python_session step-by-step replay verification!
            prepared = prepare_python_task(task, trace_format=fmt)
            session = create_python_session(prepared)
            try:
                start_idx = next(i for i, m in enumerate(msgs) if m.get("role") == "user") + 1
                idx = start_idx
                while idx < len(msgs):
                    m = msgs[idx]
                    idx += 1
                    if m.get("role") != "assistant":
                        return None, f"expected-assistant-at-{idx - 1}"
                    step_res = session.step(m, 0)
                    for obs in step_res["messages"]:
                        if idx >= len(msgs) or msgs[idx] != obs:
                            return None, f"live-observation-mismatch-at-{idx}"
                        idx += 1
                grade = session.grade()
                if not grade["success"]:
                    return None, f"live-session-grade-failed:{grade.get('reason')}"
                if require_external_io and int(grade.get("externalCalls", 0)) != ext_calls:
                    return None, f"live-ext-mismatch:{grade.get('externalCalls')}!={ext_calls}"
            finally:
                session.close()

            # Zero-leakage & Stage 10 dedup checks
            split_component = _sha256(f"{pass1['family']}:{pass1['sourceHash']}")
            if pass1["id"] in forbidden["reb_ids"]:
                return None, f"leakage-reb-id:{pass1['id']}"
            if pass1["family"] in forbidden["reb_families"]:
                return None, f"leakage-reb-family:{pass1['family']}"
            if pass1["sourceHash"] in forbidden["reb_hashes"]:
                return None, f"leakage-reb-sourceHash:{pass1['sourceHash']}"
            if split_component in forbidden["reb_splits"]:
                return None, f"leakage-reb-split:{split_component}"
            if pass1["id"] in forbidden["stage10_ids"]:
                return None, f"dup-stage10-id:{pass1['id']}"
            if pass1["sourceHash"] in forbidden["stage10_hashes"]:
                return None, f"dup-stage10-sourceHash:{pass1['sourceHash']}"

            loaded_paths: set[str] = {task["entryFile"]}
            for m in msgs:
                if m.get("role") == "assistant" and isinstance(m.get("tool_calls"), list):
                    for tc in m["tool_calls"]:
                        fn = tc.get("function") or {}
                        if fn.get("name") == CODE_LOAD_OPERATION:
                            raw_a = json.loads(fn.get("arguments") or "{}")
                            for req in raw_a.get("arguments") or []:
                                if isinstance(req, dict) and isinstance(req.get("path"), str):
                                    loaded_paths.add(req["path"])

            if len(loaded_paths) < 2:
                return None, "insufficient-loaded-files"

            non_cl_ops = [op for op in used if op != CODE_LOAD_OPERATION]
            cb_tokens = _codebase_tokens(pass1["task"]["files"])
            distractors = sorted(p for p in pass1["task"]["files"] if p not in loaded_paths)
            row = dict(pass1)
            row["split_component"] = split_component
            row["metadata"] = {
                **(task.get("metadata") or {}),
                **pass1["metadata"],
                "traceFormat": fmt,
                "conversationChars": len(serialized),
                "contextTokens": total_context_tokens,
                "tiktokenTokens": total_context_tokens,
                "codebaseTokens": cb_tokens,
                "maxTurnTokens": max_asst_turn_toks,
                "fileCount": len(pass1["task"]["files"]),
                "loadedFileCount": len(loaded_paths),
                "loadedFiles": sorted(loaded_paths),
                "distractorCount": len(distractors),
                "codeLoadCalls": code_loads,
                "codeLoadBytes": int(pass1["metadata"].get("codeLoadBytes", 0)),
                "externalCalls": ext_calls,
                "externalOps": sorted(set(non_cl_ops)),
                "narrationLines": narration_lines,
                "deterministic2xVerified": True,
                "pythonHashSeeds": [HASH_SEED_PASS1, HASH_SEED_PASS2],
                "liveReplayVerified": True,
            }
            if not _is_preexported_row(row):
                return None, "invalid-preexported-row-schema"
            return row, None
        except Exception as exc:
            last_err = f"{fmt}:verify-exc:{type(exc).__name__}:{str(exc)[:180]}"
            continue

    return None, last_err


def _extract_final_completion(messages: list[dict[str, Any]]) -> dict[str, Any]:
    vis = assistant_visible_text(messages[-1])
    m = re.search(r"```json\s*([\s\S]*?)```", vis)
    if not m:
        return {}
    try:
        return json.loads(m.group(1))
    except Exception:
        return {}


# ===========================================================================
# Multi-file helper generator (ensures small 2-4 file real repos have >=5 .py)
# ===========================================================================

def _ensure_min_app_files(
    pkg_files: dict[str, str],
    entry_rel: str,
    entry_code: str,
    min_files: int = 5,
) -> dict[str, str]:
    """Keep all real package files + entry; add clean app support modules only if < min_files."""
    files = {**pkg_files, entry_rel: entry_code}
    if len(files) >= min_files:
        return files
    extras = [
        ("app/__init__.py", '"""Application package for stateful OSS workflow."""\n'),
        ("app/formatting.py", '"""Deterministic summary formatting utilities."""\ndef normalize_keys(d):\n    return {str(k): d[k] for k in sorted(d)}\n'),
        ("app/validation.py", '"""Input validation helpers."""\ndef require_nonempty(val, label="value"):\n    if not val:\n        raise ValueError(f"empty {label}")\n    return val\n'),
        ("app/metrics.py", '"""Lightweight execution metrics helpers."""\ndef summarize_counts(items):\n    return {"count": len(items), "nonempty": bool(items)}\n'),
    ]
    for path, src in extras:
        if len(files) >= min_files:
            break
        if path not in files:
            files[path] = src
    return files


# ===========================================================================
# Curated Wave 3 Catalog: 145+ Brand-New Pure-Python Multi-File OSS Repos
# (100% disjoint from RealExecBench v1 AND Stage 10!)
# ===========================================================================

REPO_CATALOG: list[dict[str, Any]] = [
    # --- Parsers / Lexers / Grammars / AST / Linters ---
    {
        "repo": "lark-parser/lark",
        "license": "MIT",
        "domain": "parser-grammar",
        "package": "lark",
        "api_probes": [
            {
                "name": "tree_transformer",
                "code": '''"""Cross-file probe exercising `lark` Tree, Token, Transformer, and Visitor."""
from lark import Tree, Token, Transformer, Visitor

class ExprEval(Transformer):
    def num(self, items):
        return int(items[0])
    def add(self, items):
        return items[0] + items[1]
    def mul(self, items):
        return items[0] * items[1]
    def neg(self, items):
        return -items[0]

class OpCounter(Visitor):
    def __init__(self):
        self.ops = []
    def __default__(self, tree):
        if tree.data != "num":
            self.ops.append(tree.data)

def _build(spec):
    if isinstance(spec, int):
        return Tree("num", [Token("NUMBER", str(spec))])
    op = spec[0]
    return Tree(op, [_build(ch) for ch in spec[1:]])

def run(expr_spec: list) -> dict:
    tree = _build(expr_spec)
    counter = OpCounter()
    counter.visit(tree)
    val = ExprEval().transform(tree)
    return {"value": val, "ops": counter.ops, "pretty": tree.pretty().strip()}
''',
                "cases": [
                    ("ast1", [["add", ["mul", 3, 7], ["neg", 5]]]),
                    ("ast2", [["mul", ["add", 4, 6], ["add", 2, ["neg", 9]]]]),
                ],
            },
        ],
    },
    {
        "repo": "pyparsing/pyparsing",
        "license": "MIT",
        "domain": "parser-grammar",
        "package": "pyparsing",
        "api_probes": [
            {
                "name": "kv_expr",
                "code": '''"""Cross-file probe exercising `pyparsing` combinators."""
import pyparsing as pp

def run(records: list[str]) -> list[dict]:
    key = pp.Word(pp.alphas + "_", pp.alphanums + "_")("key")
    num = pp.pyparsing_common.signed_integer("num")
    word = pp.Word(pp.alphanums + "._-/")("word")
    pair = pp.Group(key + pp.Suppress("=") + (num | word))
    stmt = pp.DelimitedList(pair)
    out = []
    for line in records:
        parsed = stmt.parse_string(line, parse_all=True)
        out.append({item[0]: item[1] for item in parsed})
    return out
''',
                "cases": [
                    ("cfg", [["host=api.local, port=8080, retries=3", "env=prod, timeout=-1"]]),
                    ("metrics", [["cpu=42, mem=1024, node=worker_1"]]),
                ],
            },
        ],
    },
    {
        "repo": "dabeaz/ply",
        "license": "BSD-3-Clause",
        "domain": "parser-grammar",
        "package": "ply",
        "api_probes": [
            {
                "name": "lex_tokens",
                "code": '''"""Cross-file probe exercising `ply.lex` tokenization via class lexer."""
import ply.lex as lex

class ExprLexer:
    tokens = ("IDENT", "NUMBER", "PLUS", "MINUS", "TIMES", "LPAREN", "RPAREN")
    t_PLUS = r"\\+"
    t_MINUS = r"-"
    t_TIMES = r"\\*"
    t_LPAREN = r"\\("
    t_RPAREN = r"\\)"
    t_ignore = " \\t\\n"

    def t_IDENT(self, t):
        r"[a-zA-Z_][a-zA-Z0-9_]*"
        return t

    def t_NUMBER(self, t):
        r"\\d+"
        t.value = int(t.value)
        return t

    def t_error(self, t):
        t.lexer.skip(1)

def run(src: str) -> list[dict]:
    lexer = lex.lex(object=ExprLexer())
    lexer.input(src)
    return [{"type": tok.type, "value": tok.value, "pos": tok.lexpos} for tok in lexer]
''',
                "cases": [
                    ("expr1", ["alpha + 42 * (beta - 7)"]),
                    ("expr2", ["x1 * 10 + y2 - 3"]),
                ],
            },
        ],
    },
    {
        "repo": "textX/Arpeggio",
        "license": "MIT",
        "domain": "parser-grammar",
        "package": "arpeggio",
        "api_probes": [
            {
                "name": "peg_parse",
                "code": '''"""Cross-file probe exercising `arpeggio` PEG parser and PTNodeVisitor."""
from arpeggio import Optional, ZeroOrMore, EOF, ParserPython, PTNodeVisitor, visit_parse_tree
from arpeggio import RegExMatch as _

def number(): return _(r"\\d+")
def factor(): return Optional(["+", "-"]), number
def term(): return factor, ZeroOrMore(["*", "/"], factor)
def expr(): return term, ZeroOrMore(["+", "-"], term)
def calc(): return expr, EOF

class EvalVisitor(PTNodeVisitor):
    def visit_number(self, node, children):
        return int(node.value)
    def visit_factor(self, node, children):
        return -children[1] if len(children) == 2 and children[0] == "-" else children[-1]
    def visit_term(self, node, children):
        acc = children[0]
        for i in range(1, len(children), 2):
            acc = acc * children[i + 1] if children[i] == "*" else acc // children[i + 1]
        return acc
    def visit_expr(self, node, children):
        acc = children[0]
        for i in range(1, len(children), 2):
            acc = acc + children[i + 1] if children[i] == "+" else acc - children[i + 1]
        return acc
    def visit_calc(self, node, children):
        return children[0]

def run(text: str) -> int:
    parser = ParserPython(calc)
    tree = parser.parse(text)
    return visit_parse_tree(tree, EvalVisitor())
''',
                "cases": [
                    ("calc1", ["3 + 4 * 5 - 6 / 2"]),
                    ("calc2", ["-10 + 8 * 3 - 4"]),
                ],
            },
        ],
    },
    {
        "repo": "textX/textX",
        "license": "MIT",
        "domain": "parser-grammar",
        "package": "textx",
        "companion_repos": [("textX/Arpeggio", "arpeggio")],
        "api_probes": [
            {
                "name": "metamodel_dsl",
                "code": '''"""Cross-file probe exercising `textx` metamodel compilation and model parsing."""
from textx import metamodel_from_str

GRAMMAR = """
Model: items*=Item;
Item: 'item' name=ID '=' value=INT;
"""

def run(model_text: str) -> dict:
    mm = metamodel_from_str(GRAMMAR)
    m = mm.model_from_str(model_text)
    return {"items": {it.name: it.value for it in m.items}, "total": sum(it.value for it in m.items)}
''',
                "cases": [
                    ("cfg1", ["item cpu = 8\nitem mem = 32\nitem disk = 500\n"]),
                    ("cfg2", ["item workers = 4\nitem retries = 3\n"]),
                ],
            },
        ],
    },
    {
        "repo": "tobymao/sqlglot",
        "license": "MIT",
        "domain": "sql",
        "package": "sqlglot",
        "api_probes": [
            {
                "name": "transpile_ast",
                "code": '''"""Cross-file probe exercising `sqlglot` SQL parsing, AST traversal, and transpilation."""
import sqlglot
from sqlglot import exp

def run(sql: str, read_dialect: str, write_dialect: str) -> dict:
    tree = sqlglot.parse_one(sql, read=read_dialect)
    tables = sorted({t.name for t in tree.find_all(exp.Table)})
    cols = sorted({c.name for c in tree.find_all(exp.Column)})
    out_sql = tree.sql(dialect=write_dialect)
    return {"tables": tables, "columns": cols, "sql": out_sql}
''',
                "cases": [
                    ("pg_to_sqlite", ["SELECT u.id, COALESCE(u.name, 'anon') AS nm FROM users u JOIN orders o ON u.id = o.user_id WHERE o.total > 50", "postgres", "sqlite"]),
                    ("mysql_to_pg", ["SELECT `acct_id`, COUNT(*) AS n FROM `events` WHERE `kind` = 'click' GROUP BY `acct_id` LIMIT 10", "mysql", "postgres"]),
                ],
            },
        ],
    },
    {
        "repo": "kayak/pypika",
        "license": "Apache-2.0",
        "domain": "sql",
        "package": "pypika",
        "api_probes": [
            {
                "name": "query_builder",
                "code": '''"""Cross-file probe exercising `pypika` multi-table SQL query construction."""
from pypika import Query, Table, Order, Case, functions as fn

def run(min_amount: int, hi_amount: int, limit_n: int) -> str:
    orders = Table("orders")
    customers = Table("customers")
    tier = Case().when(orders.amount >= hi_amount, "high").else_("std").as_("tier")
    q = (
        Query.from_(orders)
        .join(customers)
        .on(orders.customer_id == customers.id)
        .select(customers.region, tier, fn.Count(orders.id).as_("cnt"), fn.Sum(orders.amount).as_("rev"))
        .where((orders.amount >= min_amount) & (orders.status == "paid"))
        .groupby(customers.region)
        .orderby(fn.Sum(orders.amount), order=Order.desc)
        .limit(limit_n)
    )
    return q.get_sql()
''',
                "cases": [
                    ("paid", [100, 500, 5]),
                    ("enterprise", [250, 2000, 10]),
                ],
            },
        ],
    },
    {
        "repo": "davidhalter/parso",
        "license": "MIT",
        "domain": "ast-lint",
        "package": "parso",
        "api_probes": [
            {
                "name": "parse_errors",
                "code": '''"""Cross-file probe exercising `parso` Python CST parsing and syntax error recovery."""
import parso

def run(code: str) -> dict:
    grammar = parso.load_grammar()
    mod = grammar.parse(code)
    errs = [e.message for e in grammar.iter_errors(mod)]
    funcs = [f.name.value for f in mod.iter_funcdefs()]
    classes = [c.name.value for c in mod.iter_classdefs()]
    return {"funcs": funcs, "classes": classes, "error_count": len(errs), "errors": errs}
''',
                "cases": [
                    ("valid_mod", ["class Calc:\n    def add(self, a, b):\n        return a + b\n\ndef main():\n    return Calc().add(2, 3)\n"]),
                    ("broken_mod", ["def ok(x):\n    return x * 2\n\ndef bad(a, b:\n    return a\n"]),
                ],
            },
        ],
    },
    {
        "repo": "berkerpeksag/astor",
        "license": "BSD-3-Clause",
        "domain": "ast-lint",
        "package": "astor",
        "api_probes": [
            {
                "name": "ast_roundtrip",
                "code": '''"""Cross-file probe exercising `astor` AST-to-source code generation."""
import ast
import astor

def run(src: str) -> dict:
    tree = ast.parse(src)
    regen = astor.to_source(tree).strip()
    dumped = astor.dump_tree(tree)
    return {"regen": regen, "dump_len": len(dumped)}
''',
                "cases": [
                    ("comp", ["def squares(n):\n    return [x * x for x in range(n) if x % 2 == 0]\n"]),
                    ("branch", ["def grade(score):\n    if score >= 90:\n        return 'A'\n    return 'B'\n"]),
                ],
            },
        ],
    },
    {
        "repo": "PyCQA/isort",
        "license": "MIT",
        "domain": "ast-lint",
        "package": "isort",
        "companion_repos": [("python/mypy_extensions", "mypy_extensions")],
        "api_probes": [
            {
                "name": "sort_imports",
                "code": '''"""Cross-file probe exercising `isort` import grouping and sorting."""
import isort

def run(src: str) -> dict:
    sorted_src = isort.code(src)
    return {"changed": sorted_src != src, "sorted": sorted_src.strip()}
''',
                "cases": [
                    ("unsorted", ["import sys\nfrom mypkg import zebra, alpha\nimport os\nimport json\n\nx = 1\n"]),
                    ("clean", ["import json\nimport os\n\nx = json.dumps({})\n"]),
                ],
            },
        ],
    },
    {
        "repo": "PyCQA/bandit",
        "license": "Apache-2.0",
        "domain": "ast-lint",
        "package": "bandit",
    },
    {
        "repo": "PyCQA/pycodestyle",
        "license": "MIT",
        "domain": "ast-lint",
        "package": "pycodestyle",
        "api_probes": [
            {
                "name": "style_check",
                "code": '''"""Cross-file probe exercising `pycodestyle` PEP8 checker."""
import pycodestyle

class CaptureReport(pycodestyle.BaseReport):
    def __init__(self, options):
        super().__init__(options)
        self.findings = []
    def error(self, line_number, offset, text, check):
        code = super().error(line_number, offset, text, check)
        if code:
            self.findings.append({"line": line_number, "col": offset + 1, "code": code})
        return code

def run(lines: list[str]) -> dict:
    sg = pycodestyle.StyleGuide(reporter=CaptureReport, quiet=True)
    checker = pycodestyle.Checker(filename="sample.py", lines=lines, options=sg.options, report=sg.options.report)
    checker.check_all()
    return {"count": len(checker.report.findings), "findings": checker.report.findings}
''',
                "cases": [
                    ("messy", [["import os, sys\n", "x=1+2\n", "def foo( a,b ):\n", "    return a+b\n"]]),
                    ("clean", [["import os\n", "\n", "\n", "def foo(a, b):\n", "    return a + b\n"]]),
                ],
            },
        ],
    },
    {"repo": "PyCQA/pydocstyle", "license": "MIT", "domain": "ast-lint", "package": "pydocstyle"},
    {"repo": "PyCQA/flake8", "license": "MIT", "domain": "ast-lint", "package": "flake8"},
    {"repo": "hhatto/autopep8", "license": "MIT", "domain": "ast-lint", "package": "autopep8"},
    {"repo": "asottile/pyupgrade", "license": "MIT", "domain": "ast-lint", "package": "pyupgrade"},
    {"repo": "google/gast", "license": "BSD-3-Clause", "domain": "ast-lint", "package": "gast"},
    {"repo": "inducer/pymbolic", "license": "MIT", "domain": "math-science", "package": "pymbolic"},
    {"repo": "beartype/beartype", "license": "MIT", "domain": "typing-validation", "package": "beartype"},
    {"repo": "agronholm/typeguard", "license": "MIT", "domain": "typing-validation", "package": "typeguard"},
    {"repo": "pre-commit/identify", "license": "MIT", "domain": "ast-lint", "package": "identify"},

    # --- Templates / Web / HTTP / Routing / HTML / CSS / XML / Feeds ---
    {
        "repo": "sqlalchemy/mako",
        "license": "MIT",
        "domain": "templates",
        "package": "mako",
        "companion_repos": [("pallets/markupsafe", "markupsafe")],
        "api_probes": [
            {
                "name": "render_tpl",
                "code": '''"""Cross-file probe exercising `mako` template compilation and rendering."""
from mako.template import Template

def run(tpl_src: str, ctx: dict) -> str:
    return Template(tpl_src).render(**ctx).strip()
''',
                "cases": [
                    ("loop", ["Items: % for x in items:\n[${x.upper()}]% endfor\nTotal=${len(items)}", {"items": ["a", "b", "c"]}]),
                    ("cond", ["% if ok:\nPASS:${user}\n% else:\nFAIL:${user}\n% endif", {"ok": True, "user": "alice"}]),
                ],
            },
        ],
    },
    {
        "repo": "jg-rp/liquid",
        "license": "MIT",
        "domain": "templates",
        "package": "liquid",
        "api_probes": [
            {
                "name": "liquid_render",
                "code": '''"""Cross-file probe exercising `liquid` Shopify template parsing, filters, and loops."""
from liquid import Template

def run(tpl_src: str, ctx: dict) -> str:
    return Template(tpl_src).render(**ctx).strip()
''',
                "cases": [
                    ("invoice", ["Hello {{ user | upcase }}! {% for p in items %}{{ p.name }}={{ p.qty }};{% endfor %}", {"user": "ada", "items": [{"name": "cpu", "qty": 2}, {"name": "ram", "qty": 4}]}]),
                    ("cond", ["{% if score >= 80 %}PASS{% else %}RETRY{% endif %} ({{ score }})", {"score": 92}]),
                ],
            },
        ],
    },
    {
        "repo": "noahmorrison/chevron",
        "license": "MIT",
        "domain": "templates",
        "package": "chevron",
        "api_probes": [
            {
                "name": "mustache_render",
                "code": '''"""Cross-file probe exercising `chevron` Mustache tokenizer and renderer."""
import chevron

def run(tpl: str, data: dict) -> str:
    return chevron.render(tpl, data).strip()
''',
                "cases": [
                    ("list", ["Team {{team}}: {{#members}}[{{name}}:{{role}}] {{/members}}", {"team": "core", "members": [{"name": "Ada", "role": "eng"}, {"name": "Bob", "role": "ops"}]}]),
                    ("inverted", ["{{#alert}}ALERT: {{alert}}{{/alert}}{{^alert}}ALL_CLEAR{{/alert}}", {"alert": ""}]),
                ],
            },
        ],
    },
    {
        "repo": "defunkt/pystache",
        "license": "MIT",
        "domain": "templates",
        "package": "pystache",
        "api_probes": [
            {
                "name": "pystache_render",
                "code": '''"""Cross-file probe exercising `pystache` Mustache rendering."""
import pystache

def run(tpl: str, ctx: dict) -> str:
    return pystache.render(tpl, ctx).strip()
''',
                "cases": [
                    ("simple", ["Hello {{name}}! {{#tags}}#{{.}} {{/tags}}", {"name": "Wave3", "tags": ["py", "oss"]}]),
                    ("nested", ["{{#svc}}{{host}}:{{port}}{{/svc}}", {"svc": {"host": "db.local", "port": 5432}}]),
                ],
            },
        ],
    },
    {"repo": "mahmoud/ashes", "license": "BSD-3-Clause", "domain": "templates", "package": "ashes"},
    {"repo": "malthe/chameleon", "license": "BSD-3-Clause", "domain": "templates", "package": "chameleon"},
    {
        "repo": "Pylons/webob",
        "license": "MIT",
        "domain": "web-http",
        "package": "webob",
        "api_probes": [
            {
                "name": "req_resp",
                "code": '''"""Cross-file probe exercising `webob` WSGI Request/Response parsing and header handling."""
from webob import Request, Response

def run(path: str, headers: dict, body_text: str) -> dict:
    req = Request.blank(path, headers=headers)
    resp = Response(text=body_text, status=200, content_type="application/json")
    resp.cache_control.max_age = 120
    return {
        "path_info": req.path_info,
        "params": dict(req.params),
        "accept": str(req.accept),
        "status_code": resp.status_code,
        "cache_control": resp.headers.get("Cache-Control"),
        "content_length": resp.content_length,
    }
''',
                "cases": [
                    ("api_get", ["/v2/items?sort=asc&limit=25", {"Accept": "application/json"}, '{"ok":true}']),
                    ("search", ["/search?q=python&page=3", {"Accept": "text/html"}, '{"hits":12}']),
                ],
            },
        ],
    },
    {
        "repo": "bbangert/routes",
        "license": "MIT",
        "domain": "web-http",
        "package": "routes",
        "companion_repos": [("benjaminp/six", "six")],
        "api_probes": [
            {
                "name": "url_mapper",
                "code": '''"""Cross-file probe exercising `routes` URL pattern compilation and matching."""
from routes import Mapper

def run(paths: list[str]) -> list[dict]:
    m = Mapper()
    m.connect("user", "/users/{id:\\d+}/{action}", controller="users", action="show")
    m.connect("item", "/items/{slug}", controller="items", action="detail")
    return [{"path": p, "match": m.match(p)} for p in paths]
''',
                "cases": [
                    ("mix", [["/users/42/edit", "/items/widget-1", "/unknown/path"]]),
                    ("users", [["/users/7/show", "/items/alpha"]]),
                ],
            },
        ],
    },
    {
        "repo": "sanic-org/sanic-routing",
        "license": "MIT",
        "domain": "web-http",
        "package": "sanic_routing",
        "api_probes": [
            {
                "name": "compile_route",
                "code": '''"""Cross-file probe exercising `sanic_routing` dynamic route compilation."""
from sanic_routing import BaseRouter

class SimpleRouter(BaseRouter):
    def get(self, path, method, host):
        return self._get(path, method, host)

def run(lookups: list[list[str]]) -> list[dict]:
    r = SimpleRouter()
    r.add("/api/v1/users/<uid:int>", lambda: "user", methods=["GET"])
    r.add("/api/v1/items/<slug:str>", lambda: "item", methods=["GET", "POST"])
    r.finalize()
    out = []
    for method, path in lookups:
        try:
            route, handler, params = r.get(path, method, None)
            out.append({"path": path, "handler": handler(), "params": params})
        except Exception as exc:
            out.append({"path": path, "error": type(exc).__name__})
    return out
''',
                "cases": [
                    ("basic", [[["GET", "/api/v1/users/99"], ["POST", "/api/v1/items/book"], ["GET", "/missing"]]]),
                    ("int_check", [[["GET", "/api/v1/users/123"], ["GET", "/api/v1/users/abc"]]]),
                ],
            },
        ],
    },
    {
        "repo": "gruns/furl",
        "license": "Unlicense",
        "domain": "web-http",
        "package": "furl",
        "companion_repos": [("gruns/orderedmultidict", "orderedmultidict"), ("benjaminp/six", "six")],
        "api_probes": [
            {
                "name": "url_mutate",
                "code": '''"""Cross-file probe exercising `furl` + `orderedmultidict` URL manipulation."""
from furl import furl

def run(raw_url: str, add_params: dict, remove_keys: list[str]) -> dict:
    f = furl(raw_url)
    f.args.update(add_params)
    for k in remove_keys:
        f.args.pop(k, None)
    f.path.normalize()
    return {"url": f.url, "host": f.host, "segments": list(f.path.segments), "query": dict(f.args)}
''',
                "cases": [
                    ("normalize", ["https://api.example.com/v1/../v2/orders?token=secret&page=1", {"page": "2", "sort": "desc"}, ["token"]]),
                    ("clean", ["http://cdn.local:8080/a/b/./c?debug=1", {"fmt": "json"}, ["debug"]]),
                ],
            },
        ],
    },
    {"repo": "gruns/orderedmultidict", "license": "Unlicense", "domain": "data-structures", "package": "orderedmultidict"},
    {"repo": "codeinthehole/purl", "license": "MIT", "domain": "web-http", "package": "purl"},
    {
        "repo": "python-hyper/hyperlink",
        "license": "MIT",
        "domain": "web-http",
        "package": "hyperlink",
        "api_probes": [
            {
                "name": "hyperlink_ops",
                "code": '''"""Cross-file probe exercising `hyperlink` immutable RFC 3986 URL operations."""
from hyperlink import DecodedURL

def run(base_url: str, rel_ref: str, key: str, val: str) -> dict:
    u = DecodedURL.from_text(base_url).click(rel_ref).set(key, val).normalize()
    return {"text": u.to_text(), "scheme": u.scheme, "host": u.host, "path": list(u.path), "query": list(u.query)}
''',
                "cases": [
                    ("click1", ["https://docs.example.com/v1/guide/intro.html?a=1", "../ref/api.html", "lang", "en"]),
                    ("click2", ["http://svc.local:9000/a/b/", "c/d?x=9", "format", "json"]),
                ],
            },
        ],
    },
    {"repo": "python-hyper/wsproto", "license": "MIT", "domain": "web-http", "package": "wsproto"},
    {
        "repo": "python-hyper/priority",
        "license": "MIT",
        "domain": "web-http",
        "package": "priority",
        "api_probes": [
            {
                "name": "h2_priority_tree",
                "code": '''"""Cross-file probe exercising `priority` HTTP/2 weighted priority scheduling tree."""
import priority

def run(streams: list[list[int]], steps: int) -> list[int]:
    p = priority.PriorityTree()
    for sid, weight, dep in streams:
        p.insert_stream(sid, weight=weight, depends_on=dep)
    order = []
    for _ in range(steps):
        order.append(next(p))
    return order
''',
                "cases": [
                    ("weights", [[[1, 16, 0], [3, 64, 0], [5, 32, 0]], 6]),
                    ("tree", [[[1, 32, 0], [3, 16, 1], [5, 48, 1]], 5]),
                ],
            },
        ],
    },
    {"repo": "python-websockets/websockets", "license": "BSD-3-Clause", "domain": "web-http", "package": "websockets"},
    {"repo": "benoitc/gunicorn", "license": "MIT", "domain": "web-http", "package": "gunicorn"},
    {"repo": "Kludex/python-multipart", "license": "Apache-2.0", "domain": "web-http", "package": "python_multipart"},
    {"repo": "pallets-eco/wtforms", "license": "BSD-3-Clause", "domain": "web-http", "package": "wtforms"},
    {"repo": "bbangert/beaker", "license": "BSD-3-Clause", "domain": "web-http", "package": "beaker"},
    {
        "repo": "html5lib/html5lib-python",
        "license": "MIT",
        "domain": "html-css",
        "package": "html5lib",
        "companion_repos": [("gsnedders/python-webencodings", "webencodings"), ("benjaminp/six", "six")],
        "api_probes": [
            {
                "name": "parse_serialize",
                "code": '''"""Cross-file probe exercising `html5lib` HTML5 treebuilder and serializer."""
import html5lib

def run(raw_html: str) -> dict:
    doc = html5lib.parse(raw_html)
    tags = [el.tag.split("}")[-1] for el in doc.iter()]
    serialized = html5lib.serialize(doc)
    return {"tags": tags, "serialized": serialized}
''',
                "cases": [
                    ("unclosed", ["<div><p>Hello <b>world</div>"]),
                    ("table", ["<table><tr><td>A<td>B<tr><td>1<td>2</table>"]),
                ],
            },
        ],
    },
    {
        "repo": "Kozea/tinycss2",
        "license": "BSD-3-Clause",
        "domain": "html-css",
        "package": "tinycss2",
        "companion_repos": [("gsnedders/python-webencodings", "webencodings")],
        "api_probes": [
            {
                "name": "parse_stylesheet",
                "code": '''"""Cross-file probe exercising `tinycss2` CSS tokenization, stylesheet parsing, and color3."""
import tinycss2
from tinycss2 import color3

def run(css_text: str, color_str: str) -> dict:
    rules = tinycss2.parse_stylesheet(css_text, skip_comments=True, skip_whitespace=True)
    summary = []
    for r in rules:
        if r.type == "qualified-rule":
            sel = tinycss2.serialize(r.prelude).strip()
            decls = tinycss2.parse_declaration_list(r.content, skip_comments=True, skip_whitespace=True)
            props = {d.lower_name: tinycss2.serialize(d.value).strip() for d in decls if d.type == "declaration"}
            summary.append({"selector": sel, "props": props})
    rgba = color3.parse_color(color_str)
    return {"rules": summary, "color": list(rgba) if rgba else None}
''',
                "cases": [
                    ("card", [".card { color: #ff8800; padding: 8px 12px; } h1 { margin: 0; }", "rgba(255, 128, 0, 0.5)"]),
                    ("nav", ["nav > a:hover { background: #112233; display: block; }", "hsl(120, 100%, 25%)"]),
                ],
            },
        ],
    },
    {
        "repo": "Kozea/cssselect2",
        "license": "BSD-3-Clause",
        "domain": "html-css",
        "package": "cssselect2",
        "companion_repos": [("Kozea/tinycss2", "tinycss2"), ("gsnedders/python-webencodings", "webencodings")],
        "api_probes": [
            {
                "name": "selector_match",
                "code": '''"""Cross-file probe exercising `cssselect2` + `tinycss2` CSS selector matching on ElementTree."""
import xml.etree.ElementTree as ET
import cssselect2

def run(xml_str: str, selector: str) -> list[str]:
    root = ET.fromstring(xml_str)
    wrapper = cssselect2.ElementWrapper.from_xml_root(root)
    return [m.etree_element.text or m.etree_element.tag for m in wrapper.query_all(selector)]
''',
                "cases": [
                    ("cards", ["<div><p class='lead'>One</p><p class='note'>Two</p><p class='lead'>Three</p></div>", "p.lead"]),
                    ("nested", ["<ul id='nav'><li data-active='1'>Home</li><li>About</li></ul>", "#nav > li[data-active='1']"]),
                ],
            },
        ],
    },
    {
        "repo": "scrapy/cssselect",
        "license": "BSD-3-Clause",
        "domain": "html-css",
        "package": "cssselect",
        "api_probes": [
            {
                "name": "css_to_xpath",
                "code": '''"""Cross-file probe exercising `cssselect` CSS selector parsing and XPath translation."""
from cssselect import GenericTranslator

def run(selectors: list[str]) -> list[dict]:
    tr = GenericTranslator()
    return [{"css": s, "xpath": tr.css_to_xpath(s)} for s in selectors]
''',
                "cases": [
                    ("basic", [["div.card > p.lead", "ul li:first-child a[href^='https']"]]),
                    ("pseudo", [["table tr:nth-child(2n+1) td", "input[type='text']:not(.hidden)"]]),
                ],
            },
        ],
    },
    {"repo": "gsnedders/python-webencodings", "license": "BSD-3-Clause", "domain": "html-css", "package": "webencodings"},
    {
        "repo": "facelessuser/soupsieve",
        "license": "MIT",
        "domain": "html-css",
        "package": "soupsieve",
        "api_probes": [
            {
                "name": "compile_selector",
                "code": '''"""Cross-file probe exercising `soupsieve` CSS4 selector parser & compiler."""
import soupsieve as sv

def run(selectors: list[str]) -> list[dict]:
    out = []
    for s in selectors:
        comp = sv.compile(s)
        out.append({"pattern": comp.pattern, "count": len(comp.selectors)})
    return out
''',
                "cases": [
                    ("css4", [["div.card > p:not(.muted)", "ul > li:nth-child(2n+1), ol > li:first-child"]]),
                    ("attr", [["a[href^='https'][target='_blank']", "section:is(article, main) h2"]]),
                ],
            },
        ],
    },
    {
        "repo": "mozilla/bleach",
        "license": "Apache-2.0",
        "domain": "html-css",
        "package": "bleach",
        "companion_repos": [("gsnedders/python-webencodings", "webencodings")],
        "api_probes": [
            {
                "name": "sanitize_html",
                "code": '''"""Cross-file probe exercising `bleach` HTML sanitizer and linkifier."""
import bleach

def run(raw_html: str) -> dict:
    cleaned = bleach.clean(raw_html, tags=["p", "b", "i", "a", "code"], attributes={"a": ["href"]}, strip=True)
    linked = bleach.linkify(cleaned)
    return {"cleaned": cleaned, "linked": linked}
''',
                "cases": [
                    ("xss", ["<p>Hello <b>world</b><script>alert(1)</script> visit https://example.com</p>"]),
                    ("attrs", ["<a href='https://ex.io' onclick='evil()'><i>Docs</i></a><iframe src='x'></iframe>"]),
                ],
            },
        ],
    },
    {
        "repo": "kurtmckee/feedparser",
        "license": "BSD-2-Clause",
        "domain": "html-css",
        "package": "feedparser",
        "companion_repos": [("kurtmckee/sgmllib3k", "sgmllib")],
        "api_probes": [
            {
                "name": "parse_rss_atom",
                "code": '''"""Cross-file probe exercising `feedparser` RSS/Atom XML parsing."""
import feedparser

def run(xml_text: str) -> dict:
    d = feedparser.parse(xml_text)
    return {
        "version": d.version,
        "title": d.feed.get("title", ""),
        "entries": [{"title": e.get("title", ""), "link": e.get("link", "")} for e in d.entries],
    }
''',
                "cases": [
                    ("rss2", ['<?xml version="1.0"?><rss version="2.0"><channel><title>Tech Feed</title><item><title>Post 1</title><link>https://ex.io/1</link></item><item><title>Post 2</title><link>https://ex.io/2</link></item></channel></rss>']),
                    ("atom", ['<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Releases</title><entry><title>v2.0</title><link href="https://ex.io/v2"/></entry></feed>']),
                ],
            },
        ],
    },
    {
        "repo": "Alir3z4/html2text",
        "license": "GPL-3.0",
        "domain": "html-css",
        "package": "html2text",
        "api_probes": [
            {
                "name": "html_to_md",
                "code": '''"""Cross-file probe exercising `html2text` HTML-to-Markdown conversion."""
import html2text

def run(html_doc: str) -> str:
    h = html2text.HTML2Text()
    h.body_width = 0
    return h.handle(html_doc).strip()
''',
                "cases": [
                    ("article", ["<h1>Guide</h1><p>Use <strong>Python</strong> and <a href='https://ex.io'>docs</a>.</p><ul><li>One</li><li>Two</li></ul>"]),
                    ("quote", ["<h2>Notes</h2><blockquote><p>Keep it <em>simple</em>.</p></blockquote>"]),
                ],
            },
        ],
    },
    {"repo": "mwilliamson/python-mammoth", "license": "BSD-2-Clause", "domain": "html-css", "package": "mammoth"},
    {"repo": "john-kurkowski/tldextract", "license": "BSD-3-Clause", "domain": "web-http", "package": "tldextract"},
    {"repo": "martinblech/xmltodict", "license": "MIT", "domain": "data-config", "package": "xmltodict"},

    # --- Data / Config / Serialization / Querying / Schemas ---
    {
        "repo": "DiffSK/configobj",
        "license": "BSD-3-Clause",
        "domain": "data-config",
        "package": "configobj",
        "api_probes": [
            {
                "name": "ini_sections",
                "code": '''"""Cross-file probe exercising `configobj` nested INI parsing & interpolation."""
from configobj import ConfigObj

def run(lines: list[str]) -> dict:
    cfg = ConfigObj(lines)
    return cfg.dict()
''',
                "cases": [
                    ("nested", [["[server]", "host = localhost", "port = 8080", "[[tls]]", "enabled = true", "cert = /etc/tls.pem"]]),
                    ("list_vals", [["[pipeline]", "stages = extract, transform, load", "batch = 64"]]),
                ],
            },
        ],
    },
    {
        "repo": "hjson/hjson-py",
        "license": "MIT",
        "domain": "data-config",
        "package": "hjson",
        "api_probes": [
            {
                "name": "hjson_codec",
                "code": '''"""Cross-file probe exercising `hjson` human-JSON parser and encoder."""
import hjson

def run(text: str) -> dict:
    parsed = dict(hjson.loads(text))
    encoded = hjson.dumpsJSON(parsed, sort_keys=True)
    return {"parsed": parsed, "json": encoded}
''',
                "cases": [
                    ("unquoted", ["# comment\n{\n  host: api.internal\n  port: 9000\n  tags: [\n    fast\n    safe\n  ]\n}"]),
                    ("nested", ["{\n  service: billing\n  limits: {\n    rpm: 600\n    burst: 40\n  }\n}"]),
                ],
            },
        ],
    },
    {
        "repo": "stefankoegl/python-json-patch",
        "license": "BSD-3-Clause",
        "domain": "data-config",
        "package": "jsonpatch",
        "companion_repos": [("stefankoegl/python-json-pointer", "jsonpointer")],
        "api_probes": [
            {
                "name": "diff_and_apply",
                "code": '''"""Cross-file probe exercising `jsonpatch` + `jsonpointer` RFC 6902 diff & patch."""
import jsonpatch

def run(src: dict, dst: dict) -> dict:
    patch = jsonpatch.make_patch(src, dst)
    applied = patch.apply(src)
    return {"ops": list(patch), "matches": applied == dst, "result": applied}
''',
                "cases": [
                    ("cfg_diff", [{"host": "a", "ports": [80, 443], "debug": True}, {"host": "b", "ports": [80, 8443], "tls": True}]),
                    ("nested", [{"user": {"name": "ada", "roles": ["r"]}}, {"user": {"name": "ada", "roles": ["r", "w"], "active": True}}]),
                ],
            },
        ],
    },
    {"repo": "wbolster/jsonlines", "license": "BSD-3-Clause", "domain": "data-config", "package": "jsonlines"},
    {"repo": "beetbox/confuse", "license": "MIT", "domain": "data-config", "package": "confuse"},
    {"repo": "dynaconf/dynaconf", "license": "MIT", "domain": "data-config", "package": "dynaconf"},
    {"repo": "marshmallow-code/environs", "license": "MIT", "domain": "data-config", "package": "environs"},
    {"repo": "crdoconnor/strictyaml", "license": "MIT", "domain": "data-config", "package": "strictyaml"},
    {"repo": "Tinche/cattrs", "license": "MIT", "domain": "data-config", "package": "cattrs"},
    {"repo": "Fatal1ty/mashumaro", "license": "Apache-2.0", "domain": "data-config", "package": "mashumaro"},
    {"repo": "python-jsonschema/referencing", "license": "MIT", "domain": "data-config", "package": "referencing"},
    {
        "repo": "horejsek/python-fastjsonschema",
        "license": "BSD-3-Clause",
        "domain": "data-config",
        "package": "fastjsonschema",
        "api_probes": [
            {
                "name": "compile_validate",
                "code": '''"""Cross-file probe exercising `fastjsonschema` schema compiler & validator."""
import fastjsonschema

def run(schema: dict, payloads: list[dict]) -> list[dict]:
    validate = fastjsonschema.compile(schema)
    out = []
    for p in payloads:
        try:
            validate(p)
            out.append({"ok": True, "item": p})
        except fastjsonschema.JsonSchemaException as exc:
            out.append({"ok": False, "error": exc.message})
    return out
''',
                "cases": [
                    ("order", [
                        {"type": "object", "required": ["id", "amount"], "properties": {"id": {"type": "string"}, "amount": {"type": "integer", "minimum": 1}}},
                        [{"id": "o1", "amount": 50}, {"id": "o2", "amount": 0}, {"id": "o3"}],
                    ]),
                    ("user", [
                        {"type": "object", "required": ["email"], "properties": {"email": {"type": "string", "minLength": 3}, "age": {"type": "integer", "minimum": 0}}},
                        [{"email": "a@b.c", "age": 30}, {"email": "x", "age": -1}],
                    ]),
                ],
            },
        ],
    },
    {"repo": "gmr/flatdict", "license": "BSD-3-Clause", "domain": "data-config", "package": "flatdict"},
    {
        "repo": "mahmoud/glom",
        "license": "BSD-3-Clause",
        "domain": "data-config",
        "package": "glom",
        "companion_repos": [("mahmoud/face", "face")],
        "api_probes": [
            {
                "name": "glom_extract",
                "code": '''"""Cross-file probe exercising `glom` declarative nested data restructuring."""
from glom import glom, Coalesce, T

def run(payload: dict) -> dict:
    spec = {
        "service": "meta.service",
        "region": Coalesce("meta.region", default="us-east"),
        "endpoints": ("nodes", ["host"]),
        "ports": ("nodes", ["port"]),
        "total_cap": ("nodes", ["cap"], sum),
    }
    return glom(payload, spec)
''',
                "cases": [
                    ("cluster1", [{"meta": {"service": "search", "region": "eu-west"}, "nodes": [{"host": "n1", "port": 8080, "cap": 50}, {"host": "n2", "port": 8081, "cap": 75}]}]),
                    ("cluster2", [{"meta": {"service": "ingest"}, "nodes": [{"host": "i1", "port": 9000, "cap": 100}]}]),
                ],
            },
        ],
    },
    {"repo": "h2non/jsonpath-ng", "license": "Apache-2.0", "domain": "data-config", "package": "jsonpath_ng"},
    {
        "repo": "dpath-maintainers/dpath-python",
        "license": "MIT",
        "domain": "data-config",
        "package": "dpath",
        "api_probes": [
            {
                "name": "dpath_query",
                "code": '''"""Cross-file probe exercising `dpath` glob-based nested dictionary search and merge."""
import dpath

def run(data: dict, pattern: str, overlay: dict) -> dict:
    hits = dpath.values(data, pattern)
    merged = dict(data)
    dpath.merge(merged, overlay)
    return {"hits": hits, "merged": merged}
''',
                "cases": [
                    ("glob1", [{"a": {"x": 1, "y": 2}, "b": {"x": 3, "z": 4}}, "/*/x", {"b": {"w": 9}}]),
                    ("glob2", [{"svc": {"db": {"port": 5432}, "cache": {"port": 6379}}}, "/svc/*/port", {"svc": {"db": {"ssl": True}}}]),
                ],
            },
        ],
    },
    {"repo": "fabiocaccamo/python-benedict", "license": "MIT", "domain": "data-config", "package": "benedict"},
    {"repo": "mewwts/addict", "license": "MIT", "domain": "data-config", "package": "addict"},
    {"repo": "Infinidat/munch", "license": "MIT", "domain": "data-config", "package": "munch"},
    {
        "repo": "agronholm/cbor2",
        "license": "MIT",
        "domain": "binary-codec",
        "package": "cbor2",
        "api_probes": [
            {
                "name": "cbor_roundtrip",
                "code": '''"""Cross-file probe exercising `cbor2` pure-Python CBOR encoder and decoder."""
import io
from cbor2._encoder import CBOREncoder
from cbor2._decoder import CBORDecoder

def run(payload: dict) -> dict:
    buf = io.BytesIO()
    CBOREncoder(buf, canonical=True).encode(payload)
    raw = buf.getvalue()
    decoded = CBORDecoder(io.BytesIO(raw)).decode()
    return {"hex": raw.hex(), "byte_len": len(raw), "same": decoded == payload, "decoded": decoded}
''',
                "cases": [
                    ("pkt1", [{"id": 42, "tags": ["net", "cbor"], "ok": True, "score": 3.5}]),
                    ("pkt2", [{"nested": {"a": [1, -2, 300], "empty": None}, "v": 7}]),
                ],
            },
        ],
    },
    {
        "repo": "scott-griffiths/bitstring",
        "license": "MIT",
        "domain": "binary-codec",
        "package": "bitstring",
        "api_probes": [
            {
                "name": "pack_unpack",
                "code": '''"""Cross-file probe exercising `bitstring` bit-level packet packing and slicing."""
from bitstring import BitStream, pack

def run(ver: int, flags: int, seq: int) -> dict:
    pkt = pack("uint:4, uint:4, uint:16", ver, flags, seq)
    s = BitStream(pkt)
    u_ver, u_flags, u_seq = s.readlist("uint:4, uint:4, uint:16")
    return {"hex": pkt.hex, "bin": pkt.bin, "unpacked": [u_ver, u_flags, u_seq]}
''',
                "cases": [
                    ("hdr1", [4, 5, 1024]),
                    ("hdr2", [6, 15, 65000]),
                ],
            },
        ],
    },
    {
        "repo": "seperman/deepdiff",
        "license": "MIT",
        "domain": "data-config",
        "package": "deepdiff",
        "companion_repos": [("seperman/orderly-set", "orderly_set")],
        "api_probes": [
            {
                "name": "deep_diff_cfg",
                "code": '''"""Cross-file probe exercising `deepdiff` recursive structural object diffing."""
from deepdiff import DeepDiff

def run(old: dict, new: dict) -> dict:
    diff = DeepDiff(old, new, ignore_order=True)
    return {
        "changed_keys": sorted(diff.to_dict().keys()),
        "values_changed": {k: {"old": v["old_value"], "new": v["new_value"]} for k, v in (diff.get("values_changed") or {}).items()},
        "added": sorted(str(x) for x in (diff.get("dictionary_item_added") or [])),
        "removed": sorted(str(x) for x in (diff.get("dictionary_item_removed") or [])),
    }
''',
                "cases": [
                    ("deploy", [{"replicas": 2, "env": {"LOG": "info"}, "ports": [80, 443]}, {"replicas": 4, "env": {"LOG": "debug", "TRACE": "1"}, "ports": [443, 80]}]),
                    ("schema", [{"fields": ["a", "b"], "strict": True}, {"fields": ["a", "b"], "strict": False, "v": 2}]),
                ],
            },
        ],
    },
    {"repo": "keleshev/schema", "license": "MIT", "domain": "typing-validation", "package": "schema"},

    # --- Data Structures / Algorithms / Dates / Cron / Text / Science / Search ---
    {
        "repo": "grantjenks/python-sortedcontainers",
        "license": "Apache-2.0",
        "domain": "data-structures",
        "package": "sortedcontainers",
        "api_probes": [
            {
                "name": "sorted_ops",
                "code": '''"""Cross-file probe exercising `sortedcontainers` SortedList, SortedDict, and SortedSet."""
from sortedcontainers import SortedList, SortedDict, SortedSet

def run(nums: list[int], pairs: list[list], lo: int, hi: int) -> dict:
    sl = SortedList(nums)
    sl.add((lo + hi) // 2)
    sd = SortedDict({k: v for k, v in pairs})
    ss = SortedSet(nums)
    return {
        "sorted_list": list(sl),
        "slice": list(sl.irange(lo, hi)),
        "dict_keys": list(sd.keys()),
        "set_len": len(ss),
    }
''',
                "cases": [
                    ("basic", [[9, 2, 7, 1, 5, 3, 2], [["z", 1], ["a", 2], ["m", 3]], 2, 7]),
                    ("neg", [[-5, 10, 0, -2, 8, 4], [["k2", 20], ["k1", 10], ["k3", 30]], -3, 5]),
                ],
            },
        ],
    },
    {
        "repo": "caesar0301/treelib",
        "license": "Apache-2.0",
        "domain": "data-structures",
        "package": "treelib",
        "api_probes": [
            {
                "name": "org_tree",
                "code": '''"""Cross-file probe exercising `treelib` tree construction, traversal, and subtree stats."""
from treelib import Tree

def run(edges: list[list[str]], root_id: str) -> dict:
    t = Tree()
    t.create_node(root_id.upper(), root_id)
    for parent, child in edges:
        t.create_node(child.upper(), child, parent=parent)
    leaves = sorted(n.identifier for n in t.leaves())
    paths = sorted(t.paths_to_leaves())
    return {"depth": t.depth(), "size": t.size(), "leaves": leaves, "paths": paths}
''',
                "cases": [
                    ("org", [[["ceo", "vp_eng"], ["ceo", "vp_ops"], ["vp_eng", "be"], ["vp_eng", "fe"], ["vp_ops", "sre"]], "ceo"]),
                    ("fs", [[["root", "src"], ["root", "tests"], ["src", "core"], ["src", "api"]], "root"]),
                ],
            },
        ],
    },
    {
        "repo": "google/pygtrie",
        "license": "Apache-2.0",
        "domain": "data-structures",
        "package": "pygtrie",
        "api_probes": [
            {
                "name": "prefix_trie",
                "code": '''"""Cross-file probe exercising `pygtrie` CharTrie and StringTrie longest-prefix matching."""
import pygtrie

def run(routes: list[list[str]], queries: list[str]) -> dict:
    t = pygtrie.StringTrie()
    for path, handler in routes:
        t[path] = handler
    resolved = []
    for q in queries:
        m = t.longest_prefix(q)
        resolved.append({"query": q, "prefix": m.key, "handler": m.value})
    return {"resolved": resolved, "api_keys": sorted(t.keys(prefix="/api"))}
''',
                "cases": [
                    ("routes", [[["/api", "root_api"], ["/api/v1/users", "users_v1"], ["/api/v2", "api_v2"]], ["/api/v1/users/42", "/api/v2/items", "/other"]]),
                    ("fs", [[["/etc", "cfg"], ["/etc/nginx/sites", "nginx"], ["/var/log", "logs"]], ["/etc/nginx/sites/default", "/var/log/app.log"]]),
                ],
            },
        ],
    },
    {"repo": "vi3k6i5/flashtext", "license": "MIT", "domain": "text-nlp", "package": "flashtext"},
    {
        "repo": "more-itertools/more-itertools",
        "license": "MIT",
        "domain": "data-structures",
        "package": "more_itertools",
        "api_probes": [
            {
                "name": "iter_recipes",
                "code": '''"""Cross-file probe exercising `more_itertools` chunking, windowing, and partitioning."""
import more_itertools as mit

def run(nums: list[int], width: int) -> dict:
    chunks = list(mit.chunked(nums, width))
    windows = [list(w) for w in mit.windowed(nums, width)]
    evens, odds = mit.partition(lambda x: x % 2 == 1, nums)
    rle = list(mit.run_length.encode(nums))
    return {"chunks": chunks, "windows": windows, "evens": list(evens), "odds": list(odds), "rle": rle}
''',
                "cases": [
                    ("seq1", [[2, 2, 3, 4, 4, 4, 5, 6], 3]),
                    ("seq2", [[1, 1, 2, 3, 5, 8], 2]),
                ],
            },
        ],
    },
    {
        "repo": "kiorky/croniter",
        "license": "MIT",
        "domain": "date-time",
        "package": "croniter",
        "api_probes": [
            {
                "name": "cron_schedule",
                "code": '''"""Cross-file probe exercising `croniter` cron expression expansion."""
from datetime import datetime
from croniter import croniter

def run(expr: str, start_iso: str, count: int) -> list[str]:
    base = datetime.fromisoformat(start_iso)
    it = croniter(expr, base)
    return [it.get_next(datetime).isoformat() for _ in range(count)]
''',
                "cases": [
                    ("quarter_hour", ["*/15 9-17 * * 1-5", "2026-06-01T08:50:00", 5]),
                    ("nightly", ["30 2 * * *", "2026-06-01T00:00:00", 4]),
                ],
            },
        ],
    },
    {"repo": "josiahcarlson/parse-crontab", "license": "LGPL-2.1", "domain": "date-time", "package": "crontab"},
    {
        "repo": "gweis/isodate",
        "license": "BSD-3-Clause",
        "domain": "date-time",
        "package": "isodate",
        "api_probes": [
            {
                "name": "iso_durations",
                "code": '''"""Cross-file probe exercising `isodate` ISO 8601 datetime & duration parsing."""
import isodate

def run(dt_str: str, dur_str: str) -> dict:
    dt = isodate.parse_datetime(dt_str)
    dur = isodate.parse_duration(dur_str)
    nxt = dt + dur
    return {"start": isodate.datetime_isoformat(dt), "end": isodate.datetime_isoformat(nxt), "dur_iso": isodate.duration_isoformat(dur)}
''',
                "cases": [
                    ("d1", ["2026-03-15T10:30:00Z", "P2DT4H30M"]),
                    ("d2", ["2026-11-01T00:00:00Z", "P1W3D"]),
                ],
            },
        ],
    },
    {"repo": "collective/icalendar", "license": "BSD-2-Clause", "domain": "date-time", "package": "icalendar"},
    {"repo": "eventable/vobject", "license": "Apache-2.0", "domain": "date-time", "package": "vobject"},
    {"repo": "bear/parsedatetime", "license": "Apache-2.0", "domain": "date-time", "package": "parsedatetime"},
    {"repo": "scrapinghub/dateparser", "license": "BSD-3-Clause", "domain": "date-time", "package": "dateparser"},
    {"repo": "sdispater/pendulum", "license": "MIT", "domain": "date-time", "package": "pendulum"},
    {"repo": "myusuf3/delorean", "license": "MIT", "domain": "date-time", "package": "delorean"},
    {
        "repo": "python-humanize/humanize",
        "license": "MIT",
        "domain": "text-nlp",
        "package": "humanize",
        "api_probes": [
            {
                "name": "humanize_all",
                "code": '''"""Cross-file probe exercising `humanize` filesize, number, list, and time formatting."""
from datetime import timedelta
import humanize

def run(num_bytes: int, count: int, seconds: int, items: list[str]) -> dict:
    return {
        "size": humanize.naturalsize(num_bytes, binary=True),
        "intword": humanize.intword(count),
        "ordinal": humanize.ordinal(count % 100),
        "delta": humanize.precisedelta(timedelta(seconds=seconds)),
        "list": humanize.natural_list(items),
    }
''',
                "cases": [
                    ("med", [15_728_640, 2_450_000, 9045, ["alpha", "beta", "gamma"]]),
                    ("small", [524_288, 13_421, 3725, ["cpu", "ram"]]),
                ],
            },
        ],
    },
    {
        "repo": "jaraco/inflect",
        "license": "MIT",
        "domain": "text-nlp",
        "package": "inflect",
        "api_probes": [
            {
                "name": "english_inflect",
                "code": '''"""Cross-file probe exercising `inflect` pluralization, number-to-words, and ordinals."""
import inflect

def run(words: list[str], nums: list[int]) -> dict:
    p = inflect.engine()
    return {
        "plurals": {w: p.plural(w) for w in words},
        "words": [p.number_to_words(n) for n in nums],
        "ordinals": [p.ordinal(n) for n in nums],
        "joined": p.join(words),
    }
''',
                "cases": [
                    ("nouns", [["child", "matrix", "mouse", "category"], [1, 22, 105]]),
                    ("tech", [["index", "criterion", "axis"], [3, 14, 1001]]),
                ],
            },
        ],
    },
    {
        "repo": "life4/textdistance",
        "license": "MIT",
        "domain": "text-nlp",
        "package": "textdistance",
        "api_probes": [
            {
                "name": "edit_metrics",
                "code": '''"""Cross-file probe exercising `textdistance` edit, token, and sequence similarity algorithms."""
import textdistance

def run(a: str, b: str) -> dict:
    return {
        "levenshtein": textdistance.levenshtein.distance(a, b),
        "damerau": textdistance.damerau_levenshtein.distance(a, b),
        "jaro_winkler": round(textdistance.jaro_winkler.similarity(a, b), 4),
        "jaccard": round(textdistance.jaccard.similarity(a.split(), b.split()), 4),
        "lcsseq": textdistance.lcsseq(a, b),
    }
''',
                "cases": [
                    ("pair1", ["kitten sitting", "sittin kitten"]),
                    ("pair2", ["algorithm design", "logarithm resign"]),
                ],
            },
        ],
    },
    {
        "repo": "rspeer/python-ftfy",
        "license": "Apache-2.0",
        "domain": "text-nlp",
        "package": "ftfy",
        "companion_repos": [("jquast/wcwidth", "wcwidth")],
        "api_probes": [
            {
                "name": "fix_mojibake",
                "code": '''"""Cross-file probe exercising `ftfy` Unicode mojibake detection and repair."""
import ftfy

def run(samples: list[str]) -> list[dict]:
    out = []
    for s in samples:
        fixed, plan = ftfy.fix_and_explain(s)
        out.append({"fixed": fixed, "steps": [p[0] for p in plan]})
    return out
''',
                "cases": [
                    ("utf8_latin1", [["âœ” No problems", "The Mona Lisa doesnÃ¢â‚¬â„¢t have eyebrows.", "&lt;hello&gt;"]]),
                    ("clean_mix", [["CafÃ© &amp; CrÃ¨me", "Already clean ASCII"]]),
                ],
            },
        ],
    },
    {"repo": "avian2/unidecode", "license": "GPL-2.0", "domain": "text-nlp", "package": "unidecode"},
    {"repo": "jquast/wcwidth", "license": "MIT", "domain": "text-nlp", "package": "wcwidth"},
    {"repo": "scrapinghub/price-parser", "license": "BSD-3-Clause", "domain": "text-nlp", "package": "price_parser"},
    {
        "repo": "savoirfairelinux/num2words",
        "license": "LGPL-2.1",
        "domain": "text-nlp",
        "package": "num2words",
        "api_probes": [
            {
                "name": "multi_lang_nums",
                "code": '''"""Cross-file probe exercising `num2words` multi-language cardinal & ordinal conversion."""
from num2words import num2words

def run(n: int, langs: list[str]) -> dict:
    return {
        "cardinal": {lg: num2words(n, lang=lg) for lg in langs},
        "ordinal_en": num2words(n, to="ordinal", lang="en"),
    }
''',
                "cases": [
                    ("n1", [42, ["en", "fr", "es", "de"]]),
                    ("n2", [2026, ["en", "fr", "de"]]),
                ],
            },
        ],
    },
    {"repo": "sloria/TextBlob", "license": "MIT", "domain": "text-nlp", "package": "textblob"},
    {"repo": "dorianbrown/rank_bm25", "license": "Apache-2.0", "domain": "search-db", "package": "rank_bm25"},
    {
        "repo": "yeraydiazdiaz/lunr.py",
        "license": "MIT",
        "domain": "search-db",
        "package": "lunr",
        "api_probes": [
            {
                "name": "fulltext_index",
                "code": '''"""Cross-file probe exercising `lunr` inverted index construction, stemming, and BM25-like search."""
from lunr import lunr

def run(docs: list[dict], query: str) -> list[dict]:
    idx = lunr(ref="id", fields=("title", "body"), documents=docs)
    return [{"ref": r["ref"], "score": round(r["score"], 4)} for r in idx.search(query)]
''',
                "cases": [
                    ("docs1", [
                        [
                            {"id": "d1", "title": "Python Async Guide", "body": "Coroutines and event loops in Python"},
                            {"id": "d2", "title": "SQLite Indexing", "body": "B-trees and full text search indexes"},
                            {"id": "d3", "title": "Python Testing", "body": "Unit tests and pytest fixtures for Python"},
                        ],
                        "python",
                    ]),
                    ("docs2", [
                        [
                            {"id": "a", "title": "Parser Combinators", "body": "Recursive descent grammars and AST"},
                            {"id": "b", "title": "Cache Eviction", "body": "LRU cache policies for web servers"},
                        ],
                        "grammar",
                    ]),
                ],
            },
        ],
    },
    {
        "repo": "mchaput/whoosh",
        "license": "BSD-2-Clause",
        "domain": "search-db",
        "package": "whoosh",
        "api_probes": [
            {
                "name": "ram_search",
                "code": '''"""Cross-file probe exercising `whoosh` RamStorage inverted index, query parser, and BM25F scoring."""
from whoosh.fields import Schema, TEXT, ID
from whoosh.filedb.filestore import RamStorage
from whoosh.qparser import QueryParser

def run(docs: list[dict], query_str: str) -> list[dict]:
    schema = Schema(id=ID(stored=True), title=TEXT(stored=True), body=TEXT)
    st = RamStorage()
    ix = st.create_index(schema)
    w = ix.writer()
    for d in docs:
        w.add_document(id=d["id"], title=d["title"], body=d["body"])
    w.commit()
    with ix.searcher() as s:
        q = QueryParser("body", ix.schema).parse(query_str)
        hits = s.search(q, limit=5)
        return [{"id": h["id"], "title": h["title"], "score": round(float(h.score), 4)} for h in hits]
''',
                "cases": [
                    ("search1", [
                        [
                            {"id": "1", "title": "Retry Guide", "body": "exponential backoff and jitter for http retries"},
                            {"id": "2", "title": "SQL Tuning", "body": "sqlite query plans and covering indexes"},
                            {"id": "3", "title": "HTTP Clients", "body": "http timeouts connection pooling and retries"},
                        ],
                        "http AND retries",
                    ]),
                    ("search2", [
                        [
                            {"id": "a", "title": "AST Linting", "body": "static analysis of python syntax trees"},
                            {"id": "b", "title": "CSS Selectors", "body": "matching dom nodes with css rules"},
                        ],
                        "python OR css",
                    ]),
                ],
            },
        ],
    },
    {
        "repo": "hgrecco/pint",
        "license": "BSD-3-Clause",
        "domain": "math-science",
        "package": "pint",
    },
    {
        "repo": "lmfit/uncertainties",
        "license": "BSD-3-Clause",
        "domain": "math-science",
        "package": "uncertainties",
        "api_probes": [
            {
                "name": "error_prop",
                "code": '''"""Cross-file probe exercising `uncertainties` linear error propagation arithmetic."""
from uncertainties import ufloat, umath

def run(v: float, dv: float, r: float, dr: float) -> dict:
    volt = ufloat(v, dv)
    res = ufloat(r, dr)
    curr = volt / res
    power = volt * curr
    phase = umath.atan2(volt, res)
    return {
        "current": [round(curr.n, 6), round(curr.s, 6)],
        "power": [round(power.n, 6), round(power.s, 6)],
        "phase": [round(phase.n, 6), round(phase.s, 6)],
    }
''',
                "cases": [
                    ("ohm1", [12.0, 0.2, 4.0, 0.1]),
                    ("ohm2", [5.0, 0.05, 100.0, 2.0]),
                ],
            },
        ],
    },
    {
        "repo": "geopy/geopy",
        "license": "MIT",
        "domain": "math-science",
        "package": "geopy",
        "api_probes": [
            {
                "name": "geodesic_dist",
                "code": '''"""Cross-file probe exercising `geopy` geodesic & great-circle distance computation."""
from geopy.distance import geodesic, great_circle

def run(p1: list[float], p2: list[float]) -> dict:
    a, b = tuple(p1), tuple(p2)
    return {
        "geodesic_km": round(geodesic(a, b).km, 3),
        "great_circle_km": round(great_circle(a, b).km, 3),
        "geodesic_miles": round(geodesic(a, b).miles, 3),
    }
''',
                "cases": [
                    ("nyc_ldn", [[40.7128, -74.0060], [51.5074, -0.1278]]),
                    ("sf_tyo", [[37.7749, -122.4194], [35.6762, 139.6503]]),
                ],
            },
        ],
    },
    {
        "repo": "niklasf/python-chess",
        "license": "GPL-3.0",
        "domain": "algorithms-games",
        "package": "chess",
        "api_probes": [
            {
                "name": "play_opening",
                "code": '''"""Cross-file probe exercising `chess` board state, SAN move parsing, and check detection."""
import chess

def run(san_moves: list[str]) -> dict:
    board = chess.Board()
    uci_moves = []
    for san in san_moves:
        mv = board.push_san(san)
        uci_moves.append(mv.uci())
    return {
        "fen": board.fen(),
        "uci": uci_moves,
        "is_check": board.is_check(),
        "is_checkmate": board.is_checkmate(),
        "legal_count": board.legal_moves.count(),
    }
''',
                "cases": [
                    ("scholars_mate", [["e4", "e5", "Qh5", "Nc6", "Bc4", "Nf6", "Qxf7#"]]),
                    ("italian", [["e4", "e5", "Nf3", "Nc6", "Bc4", "Bc5", "c3", "Nf6"]]),
                ],
            },
        ],
    },
    {
        "repo": "facelessuser/coloraide",
        "license": "MIT",
        "domain": "math-science",
        "package": "coloraide",
        "api_probes": [
            {
                "name": "color_spaces",
                "code": '''"""Cross-file probe exercising `coloraide` color space conversion, mixing, and WCAG contrast."""
from coloraide import Color

def run(c1: str, c2: str) -> dict:
    a = Color(c1)
    b = Color(c2)
    mixed = a.mix(b, 0.5, space="oklab").convert("srgb")
    return {
        "a_hex": a.convert("srgb").to_string(hex=True),
        "mixed_hex": mixed.to_string(hex=True),
        "contrast": round(a.contrast(b), 3),
        "delta_e": round(a.delta_e(b, method="2000"), 3),
    }
''',
                "cases": [
                    ("blue_gold", ["#1e40af", "#f59e0b"]),
                    ("dark_light", ["hsl(210 50% 15%)", "rgb(245 245 250)"]),
                ],
            },
        ],
    },
    {"repo": "gtaylor/python-colormath", "license": "BSD-2-Clause", "domain": "math-science", "package": "colormath"},

    # --- CLI / Tables / Resilience / DB / PDF / Crypto / Packaging / Workflows ---
    {
        "repo": "jazzband/prettytable",
        "license": "BSD-3-Clause",
        "domain": "cli-tables",
        "package": "prettytable",
        "companion_repos": [("jquast/wcwidth", "wcwidth")],
        "api_probes": [
            {
                "name": "render_table",
                "code": '''"""Cross-file probe exercising `prettytable` ASCII and HTML table formatting."""
from prettytable import PrettyTable

def run(headers: list[str], rows: list[list], sort_by: str) -> dict:
    t = PrettyTable(headers)
    for r in rows:
        t.add_row(r)
    t.sortby = sort_by
    return {"ascii": t.get_string(), "csv": t.get_csv_string().strip()}
''',
                "cases": [
                    ("services", [["svc", "rps", "p99_ms"], [["auth", 420, 18], ["search", 190, 45], ["billing", 85, 22]], "rps"]),
                    ("nodes", [["node", "cpu", "mem"], [["w2", 65, 4096], ["w1", 40, 2048]], "node"]),
                ],
            },
        ],
    },
    {"repo": "astanin/python-tabulate", "license": "MIT", "domain": "cli-tables", "package": "tabulate"},
    {"repo": "Robpol86/terminaltables", "license": "MIT", "domain": "cli-tables", "package": "terminaltables"},
    {"repo": "google/python-fire", "license": "Apache-2.0", "domain": "cli-tables", "package": "fire"},
    {"repo": "ialbert/plac", "license": "BSD-2-Clause", "domain": "cli-tables", "package": "plac"},
    {"repo": "epsy/clize", "license": "MIT", "domain": "cli-tables", "package": "clize"},
    {"repo": "tomerfiliba/plumbum", "license": "MIT", "domain": "cli-tables", "package": "plumbum"},
    {"repo": "pyinvoke/invoke", "license": "BSD-2-Clause", "domain": "cli-tables", "package": "invoke"},
    {"repo": "pydoit/doit", "license": "MIT", "domain": "cli-tables", "package": "doit"},
    {"repo": "mahmoud/face", "license": "BSD-3-Clause", "domain": "cli-tables", "package": "face"},
    {"repo": "brentyi/tyro", "license": "MIT", "domain": "cli-tables", "package": "tyro"},
    {"repo": "python-cmd2/cmd2", "license": "MIT", "domain": "cli-tables", "package": "cmd2"},
    {
        "repo": "jd/tenacity",
        "license": "Apache-2.0",
        "domain": "resilience",
        "package": "tenacity",
        "api_probes": [
            {
                "name": "retry_flaky",
                "code": '''"""Cross-file probe exercising `tenacity` Retrying controller and stop/wait strategies."""
from tenacity import Retrying, stop_after_attempt, wait_none, retry_if_exception_type

def run(fail_times: int, max_attempts: int) -> dict:
    attempts = []
    def flaky():
        attempts.append(len(attempts) + 1)
        if len(attempts) <= fail_times:
            raise ValueError(f"transient-{len(attempts)}")
        return {"ok": True, "on_attempt": len(attempts)}
    r = Retrying(
        stop=stop_after_attempt(max_attempts),
        wait=wait_none(),
        retry=retry_if_exception_type(ValueError),
        reraise=True,
    )
    try:
        res = r(flaky)
        return {"succeeded": True, "result": res, "attempts": attempts}
    except ValueError as exc:
        return {"succeeded": False, "error": str(exc), "attempts": attempts}
''',
                "cases": [
                    ("recovers", [2, 4]),
                    ("exhausts", [4, 3]),
                ],
            },
        ],
    },
    {
        "repo": "litl/backoff",
        "license": "MIT",
        "domain": "resilience",
        "package": "backoff",
        "api_probes": [
            {
                "name": "backoff_policy",
                "code": '''"""Cross-file probe exercising `backoff` retry decorator with custom wait generator."""
import backoff

def _zero_wait():
    while True:
        yield 0

def run(fail_times: int, max_tries: int) -> dict:
    seen = []
    @backoff.on_exception(_zero_wait, RuntimeError, max_tries=max_tries, jitter=None)
    def op():
        seen.append(len(seen) + 1)
        if len(seen) <= fail_times:
            raise RuntimeError(f"err-{len(seen)}")
        return "recovered"
    try:
        val = op()
        return {"ok": True, "val": val, "tries": seen}
    except RuntimeError as exc:
        return {"ok": False, "err": str(exc), "tries": seen}
''',
                "cases": [
                    ("ok_3rd", [2, 4]),
                    ("fail_cap", [5, 2]),
                ],
            },
        ],
    },
    {
        "repo": "danielfm/pybreaker",
        "license": "BSD-3-Clause",
        "domain": "resilience",
        "package": "pybreaker",
        "api_probes": [
            {
                "name": "breaker_trip",
                "code": '''"""Cross-file probe exercising `pybreaker` circuit breaker state transitions."""
import pybreaker

def run(outcomes: list[bool], fail_max: int) -> dict:
    cb = pybreaker.CircuitBreaker(fail_max=fail_max, reset_timeout=60)
    log = []
    for ok in outcomes:
        def call_fn(flag=ok):
            if not flag:
                raise ValueError("downstream_500")
            return "ok"
        try:
            res = cb.call(call_fn)
            log.append({"res": res, "state": cb.current_state})
        except pybreaker.CircuitBreakerError:
            log.append({"res": "circuit_open", "state": cb.current_state})
        except ValueError:
            log.append({"res": "failed", "state": cb.current_state})
    return {"final_state": cb.current_state, "fail_counter": cb.fail_counter, "log": log}
''',
                "cases": [
                    ("trip", [[True, False, False, False, True], 2]),
                    ("healthy", [[False, True, False, True], 2]),
                ],
            },
        ],
    },
    {
        "repo": "alisaifee/limits",
        "license": "MIT",
        "domain": "resilience",
        "package": "limits",
        "api_probes": [
            {
                "name": "rate_limit_parse",
                "code": '''"""Cross-file probe exercising `limits` rate-limit expression parsing and MovingWindow strategy."""
from limits import parse_many
from limits.storage import MemoryStorage
from limits.strategies import FixedWindowRateLimiter

def run(spec_str: str, key: str, hits: int) -> dict:
    items = parse_many(spec_str)
    limiter = FixedWindowRateLimiter(MemoryStorage())
    allowed = [limiter.hit(items[0], key) for _ in range(hits)]
    return {
        "specs": [{"amount": it.amount, "multiples": it.multiples, "granularity": it.GRANULARITY.name} for it in items],
        "allowed": allowed,
        "accepted_count": sum(1 for a in allowed if a),
    }
''',
                "cases": [
                    ("burst", ["3/minute;100/hour", "user:42", 5]),
                    ("strict", ["2 per 10 seconds", "api:key1", 4]),
                ],
            },
        ],
    },
    {"repo": "hynek/stamina", "license": "MIT", "domain": "resilience", "package": "stamina"},
    {
        "repo": "coleifer/peewee",
        "license": "MIT",
        "domain": "search-db",
        "package": "peewee",
        "api_probes": [
            {
                "name": "orm_sqlite_mem",
                "code": '''"""Cross-file probe exercising `peewee` ORM models, joins, and aggregations over SQLite :memory:."""
import peewee as pw

def run(users: list[dict], orders: list[dict], min_total: int) -> dict:
    db = pw.SqliteDatabase(":memory:")
    class Base(pw.Model):
        class Meta:
            database = db
    class User(Base):
        name = pw.CharField(unique=True)
        tier = pw.CharField()
    class Order(Base):
        user = pw.ForeignKeyField(User, backref="orders")
        amount = pw.IntegerField()
    db.connect()
    db.create_tables([User, Order])
    u_map = {}
    for u in users:
        u_map[u["name"]] = User.create(name=u["name"], tier=u["tier"])
    for o in orders:
        Order.create(user=u_map[o["user"]], amount=o["amount"])
    q = (
        User.select(User.name, User.tier, pw.fn.SUM(Order.amount).alias("total"))
        .join(Order)
        .group_by(User.id)
        .having(pw.fn.SUM(Order.amount) >= min_total)
        .order_by(pw.fn.SUM(Order.amount).desc(), User.name.asc())
    )
    rows = [{"name": r.name, "tier": r.tier, "total": r.total} for r in q]
    db.close()
    return {"qualified": rows, "total_orders": len(orders)}
''',
                "cases": [
                    ("q1", [
                        [{"name": "ada", "tier": "pro"}, {"name": "bob", "tier": "free"}, {"name": "cy", "tier": "pro"}],
                        [{"user": "ada", "amount": 120}, {"user": "ada", "amount": 80}, {"user": "bob", "amount": 40}, {"user": "cy", "amount": 150}],
                        100,
                    ]),
                    ("q2", [
                        [{"name": "x", "tier": "std"}, {"name": "y", "tier": "vip"}],
                        [{"user": "x", "amount": 25}, {"user": "y", "amount": 500}],
                        50,
                    ]),
                ],
            },
        ],
    },
    {"repo": "grantjenks/python-diskcache", "license": "Apache-2.0", "domain": "search-db", "package": "diskcache"},
    {"repo": "aio-libs/aiosqlite", "license": "MIT", "domain": "search-db", "package": "aiosqlite"},
    {"repo": "piskvorky/sqlitedict", "license": "Apache-2.0", "domain": "search-db", "package": "sqlitedict"},
    {
        "repo": "py-pdf/pypdf",
        "license": "BSD-3-Clause",
        "domain": "document-media",
        "package": "pypdf",
        "api_probes": [
            {
                "name": "pdf_roundtrip",
                "code": '''"""Cross-file probe exercising `pypdf` PDF writer/reader metadata & page structure."""
import io
from pypdf import PdfWriter, PdfReader

def run(title: str, author: str, page_sizes: list[list[int]]) -> dict:
    writer = PdfWriter()
    for w, h in page_sizes:
        writer.add_blank_page(width=w, height=h)
    writer.add_metadata({"/Title": title, "/Author": author})
    buf = io.BytesIO()
    writer.write(buf)
    buf.seek(0)
    reader = PdfReader(buf)
    dims = [[float(p.mediabox.width), float(p.mediabox.height)] for p in reader.pages]
    return {"pages": len(reader.pages), "dims": dims, "title": str(reader.metadata.title), "author": str(reader.metadata.author)}
''',
                "cases": [
                    ("doc1", ["Q3 Report", "Ada", [[612, 792], [595, 842]]]),
                    ("doc2", ["Slide Deck", "Ops", [[720, 540]]]),
                ],
            },
        ],
    },
    {"repo": "py-pdf/fpdf2", "license": "LGPL-3.0", "domain": "document-media", "package": "fpdf"},
    {"repo": "jmcnamara/XlsxWriter", "license": "BSD-2-Clause", "domain": "document-media", "package": "xlsxwriter"},
    {
        "repo": "drj11/pypng",
        "license": "MIT",
        "domain": "document-media",
        "package": "png",
        "api_probes": [
            {
                "name": "png_encode_decode",
                "code": '''"""Cross-file probe exercising `png` pure-Python PNG encoder and decoder."""
import io
import png

def run(rows: list[list[int]]) -> dict:
    buf = io.BytesIO()
    w = png.Writer(width=len(rows[0]), height=len(rows), greyscale=True, bitdepth=8)
    w.write(buf, rows)
    raw = buf.getvalue()
    r = png.Reader(bytes=raw)
    width, height, pixels, info = r.read()
    decoded = [list(row) for row in pixels]
    return {"width": width, "height": height, "byte_len": len(raw), "same": decoded == rows}
''',
                "cases": [
                    ("checker", [[[0, 255, 0, 255], [255, 0, 255, 0], [0, 255, 0, 255]]]),
                    ("gradient", [[[10, 60, 120, 200], [20, 80, 160, 240]]]),
                ],
            },
        ],
    },
    {
        "repo": "WhyNotHugo/python-barcode",
        "license": "MIT",
        "domain": "document-media",
        "package": "barcode",
        "api_probes": [
            {
                "name": "ean_code128",
                "code": '''"""Cross-file probe exercising `barcode` Code128 & EAN13 checksum and binary encoding."""
import barcode

def run(ean_digits: str, code128_text: str) -> dict:
    ean = barcode.get("ean13", ean_digits)
    c128 = barcode.get("code128", code128_text)
    return {
        "ean_full": ean.get_fullcode(),
        "ean_bits_len": len("".join(ean.build())),
        "c128_bits_len": len("".join(c128.build())),
    }
''',
                "cases": [
                    ("sku1", ["590123412345", "INV-2026-01"]),
                    ("sku2", ["400638133393", "PKG-9988"]),
                ],
            },
        ],
    },
    {
        "repo": "rbarrois/python-semanticversion",
        "license": "BSD-2-Clause",
        "domain": "packaging-deps",
        "package": "semantic_version",
        "api_probes": [
            {
                "name": "semver_spec",
                "code": '''"""Cross-file probe exercising `semantic_version` NpmSpec/SimpleSpec version matching."""
import semantic_version as sv

def run(spec_str: str, versions: list[str]) -> dict:
    spec = sv.SimpleSpec(spec_str)
    parsed = [sv.Version(v) for v in versions]
    matching = [str(v) for v in spec.filter(parsed)]
    best = spec.select(parsed)
    return {"matching": matching, "best": str(best) if best else None}
''',
                "cases": [
                    ("range1", [">=1.2.0,<2.0.0", ["1.1.9", "1.2.0", "1.5.3", "2.0.0", "1.9.1-alpha.1"]]),
                    ("caret", ["~=2.3.0", ["2.2.9", "2.3.0", "2.3.7", "2.4.0"]]),
                ],
            },
        ],
    },
    {
        "repo": "facelessuser/wcmatch",
        "license": "MIT",
        "domain": "packaging-deps",
        "package": "wcmatch",
        "companion_repos": [("facelessuser/bracex", "bracex")],
        "api_probes": [
            {
                "name": "globmatch_paths",
                "code": '''"""Cross-file probe exercising `wcmatch.glob` + `bracex` extended glob pattern matching."""
from wcmatch import glob

def run(paths: list[str], patterns: list[str]) -> dict:
    flags = glob.GLOBSTAR | glob.BRACE | glob.NEGATE | glob.EXTGLOB
    matched = [p for p in paths if glob.globmatch(p, patterns, flags=flags)]
    return {"matched": matched, "count": len(matched)}
''',
                "cases": [
                    ("py_src", [["src/a.py", "src/sub/b.py", "src/sub/test_b.py", "docs/readme.md"], ["src/**/*.{py,pyi}", "!**/test_*.py"]]),
                    ("assets", [["web/app.js", "web/app.min.js", "web/style.css"], ["web/*.{js,css}", "!web/*.min.js"]]),
                ],
            },
        ],
    },
    {"repo": "facelessuser/bracex", "license": "MIT", "domain": "packaging-deps", "package": "bracex"},
    {
        "repo": "sarugaku/resolvelib",
        "license": "ISC",
        "domain": "packaging-deps",
        "package": "resolvelib",
        "api_probes": [
            {
                "name": "dep_resolve",
                "code": '''"""Cross-file probe exercising `resolvelib` backtracking dependency resolution."""
from resolvelib import AbstractProvider, BaseReporter, Resolver

class DictProvider(AbstractProvider):
    def __init__(self, catalog):
        self.catalog = catalog
    def identify(self, req_or_cand):
        return req_or_cand[0]
    def get_preference(self, identifier, resolutions, candidates, information, backtrack_causes):
        return sum(1 for _ in candidates[identifier])
    def find_matches(self, identifier, requirements, incompatibilities):
        bad = {c[1] for c in incompatibilities[identifier]}
        reqs = list(requirements[identifier])
        out = []
        for ver, deps in sorted(self.catalog.get(identifier, {}).items(), reverse=True):
            if ver in bad:
                continue
            if all(lo <= ver <= hi for _, lo, hi in reqs):
                out.append((identifier, ver))
        return out
    def is_satisfied_by(self, requirement, candidate):
        _, lo, hi = requirement
        return lo <= candidate[1] <= hi
    def get_dependencies(self, candidate):
        name, ver = candidate
        return [tuple(d) for d in self.catalog[name][ver]]

def run(catalog: dict, roots: list[list]) -> dict:
    # Convert JSON string keys to int versions
    cat = {pkg: {int(v): deps for v, deps in vers.items()} for pkg, vers in catalog.items()}
    res = Resolver(DictProvider(cat), BaseReporter()).resolve([tuple(r) for r in roots])
    return {k: v[1] for k, v in sorted(res.mapping.items())}
''',
                "cases": [
                    ("backtrack", [
                        {"app": {"2": [["lib", 2, 2]], "1": [["lib", 1, 1]]}, "plugin": {"1": [["lib", 1, 1]]}, "lib": {"2": [], "1": []}},
                        [["app", 1, 2], ["plugin", 1, 1]],
                    ]),
                    ("upgrade", [
                        {"web": {"3": [["http", 2, 3]], "2": [["http", 1, 2]]}, "http": {"3": [], "2": [], "1": []}},
                        [["web", 2, 3]],
                    ]),
                ],
            },
        ],
    },
    {
        "repo": "pytest-dev/pluggy",
        "license": "MIT",
        "domain": "workflows",
        "package": "pluggy",
        "api_probes": [
            {
                "name": "hook_chain",
                "code": '''"""Cross-file probe exercising `pluggy` PluginManager hook ordering & wrappers."""
import pluggy

hookspec = pluggy.HookspecMarker("demo")
hookimpl = pluggy.HookimplMarker("demo")

class Spec:
    @hookspec
    def transform(self, value: int) -> int:
        pass

class AddPlugin:
    def __init__(self, delta: int):
        self.delta = delta
    @hookimpl
    def transform(self, value: int) -> int:
        return value + self.delta

class MulPlugin:
    def __init__(self, factor: int):
        self.factor = factor
    @hookimpl(tryfirst=True)
    def transform(self, value: int) -> int:
        return value * self.factor

def run(x: int, delta: int, factor: int) -> dict:
    pm = pluggy.PluginManager("demo")
    pm.add_hookspecs(Spec)
    pm.register(AddPlugin(delta), name="add")
    pm.register(MulPlugin(factor), name="mul")
    return {"results": pm.hook.transform(value=x)}
''',
                "cases": [
                    ("c1", [10, 5, 3]),
                    ("c2", [7, -2, 4]),
                ],
            },
        ],
    },
    {
        "repo": "pallets/blinker",
        "license": "MIT",
        "domain": "workflows",
        "package": "blinker",
        "api_probes": [
            {
                "name": "signal_dispatch",
                "code": '''"""Cross-file probe exercising `blinker` named signals and receiver dispatch."""
from blinker import Namespace

def run(events: list[list]) -> dict:
    ns = Namespace()
    sig = ns.signal("order-created")
    audit = []
    def on_any(sender, **kw):
        audit.append({"scope": "all", "sender": sender, "amt": kw["amount"]})
        return "logged"
    def on_vip(sender, **kw):
        audit.append({"scope": "vip", "sender": sender, "amt": kw["amount"]})
        return "priority"
    sig.connect(on_any)
    sig.connect(on_vip, sender="vip")
    counts = []
    for sender, amt in events:
        res = sig.send(sender, amount=amt)
        counts.append(len(res))
    return {"audit": audit, "receiver_counts": counts}
''',
                "cases": [
                    ("orders", [[["std", 25], ["vip", 500], ["std", 40]]]),
                    ("vip_only", [[["vip", 100], ["vip", 250]]]),
                ],
            },
        ],
    },
    {
        "repo": "pytransitions/transitions",
        "license": "MIT",
        "domain": "workflows",
        "package": "transitions",
        "companion_repos": [("benjaminp/six", "six")],
        "api_probes": [
            {
                "name": "order_fsm",
                "code": '''"""Cross-file probe exercising `transitions` finite state machine guards and callbacks."""
from transitions import Machine

class Order:
    def __init__(self, paid: bool):
        self.paid = paid
        self.history = []
    def is_paid(self):
        return self.paid
    def record(self):
        self.history.append(self.state)

def run(paid: bool, triggers: list[str]) -> dict:
    o = Order(paid)
    Machine(
        model=o,
        states=["draft", "submitted", "shipped", "cancelled"],
        transitions=[
            {"trigger": "submit", "source": "draft", "dest": "submitted", "after": "record"},
            {"trigger": "ship", "source": "submitted", "dest": "shipped", "conditions": "is_paid", "after": "record"},
            {"trigger": "cancel", "source": ["draft", "submitted"], "dest": "cancelled", "after": "record"},
        ],
        initial="draft",
    )
    results = [getattr(o, t)() for t in triggers]
    return {"state": o.state, "results": results, "history": o.history}
''',
                "cases": [
                    ("paid_flow", [True, ["submit", "ship"]]),
                    ("unpaid_cancel", [False, ["submit", "ship", "cancel"]]),
                ],
            },
        ],
    },
    {
        "repo": "hynek/structlog",
        "license": "MIT",
        "domain": "workflows",
        "package": "structlog",
        "api_probes": [
            {
                "name": "processor_chain",
                "code": '''"""Cross-file probe exercising `structlog` structured logging processor pipeline."""
import structlog

def run(service: str, events: list[dict]) -> list[str]:
    captured = []
    def capture(_logger, _name, event_dict):
        captured.append(event_dict)
        raise structlog.DropEvent
    log = structlog.wrap_logger(
        None,
        processors=[
            structlog.processors.add_log_level,
            structlog.processors.JSONRenderer(sort_keys=True),
            capture,
        ],
    ).bind(service=service)
    for ev in events:
        getattr(log, ev["level"])(ev["msg"], code=ev["code"])
    return captured
''',
                "cases": [
                    ("api", ["payments", [{"level": "info", "msg": "charge_ok", "code": 200}, {"level": "error", "msg": "timeout", "code": 504}]]),
                    ("auth", ["sso", [{"level": "warning", "msg": "rate_limit", "code": 429}]]),
                ],
            },
        ],
    },
    {
        "repo": "pyauth/pyotp",
        "license": "MIT",
        "domain": "crypto-auth",
        "package": "pyotp",
        "api_probes": [
            {
                "name": "totp_hotp",
                "code": '''"""Cross-file probe exercising `pyotp` HOTP/TOTP generation, verification, and URI building."""
import pyotp

def run(secret: str, timestamp: int, counter: int) -> dict:
    totp = pyotp.TOTP(secret)
    hotp = pyotp.HOTP(secret)
    t_code = totp.at(timestamp)
    h_code = hotp.at(counter)
    return {
        "totp": t_code,
        "totp_valid": totp.verify(t_code, for_time=timestamp),
        "hotp": h_code,
        "hotp_valid": hotp.verify(h_code, counter),
        "uri": totp.provisioning_uri(name="ada@example.com", issuer_name="Acme"),
    }
''',
                "cases": [
                    ("c1", ["JBSWY3DPEHPK3PXP", 1710000000, 3]),
                    ("c2", ["GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", 1710000060, 7]),
                ],
            },
        ],
    },
    {
        "repo": "warner/python-ecdsa",
        "license": "MIT",
        "domain": "crypto-auth",
        "package": "ecdsa",
        "api_probes": [
            {
                "name": "ecdsa_sign_verify",
                "code": '''"""Cross-file probe exercising `ecdsa` deterministic RFC 6979 signing & verification."""
import hashlib
from ecdsa import SigningKey, NIST256p

def run(seed_hex: str, message: str) -> dict:
    sk = SigningKey.from_string(bytes.fromhex(seed_hex), curve=NIST256p, hashfunc=hashlib.sha256)
    vk = sk.get_verifying_key()
    sig = sk.sign_deterministic(message.encode("utf-8"), hashfunc=hashlib.sha256)
    ok = vk.verify(sig, message.encode("utf-8"), hashfunc=hashlib.sha256)
    return {"verified": ok, "sig_len": len(sig), "sig_prefix": sig.hex()[:16]}
''',
                "cases": [
                    ("msg1", ["11" * 32, "release-v3.1.0-manifest"]),
                    ("msg2", ["22" * 32, "invoice-9981-paid"]),
                ],
            },
        ],
    },
    {"repo": "JoshData/python-email-validator", "license": "Unlicense", "domain": "typing-validation", "package": "email_validator"},
    {"repo": "daviddrysdale/python-phonenumbers", "license": "Apache-2.0", "domain": "typing-validation", "package": "phonenumbers"},
    {"repo": "pycountry/pycountry", "license": "LGPL-2.1", "domain": "data-config", "package": "pycountry"},
    {"repo": "pypa/wheel", "license": "MIT", "domain": "packaging-deps", "package": "wheel"},
    {"repo": "pypa/build", "license": "MIT", "domain": "packaging-deps", "package": "build"},
    {"repo": "django/asgiref", "license": "BSD-3-Clause", "domain": "async-web", "package": "asgiref"},
    {"repo": "aio-libs/aiojobs", "license": "Apache-2.0", "domain": "async-web", "package": "aiojobs"},
    {"repo": "python-trio/outcome", "license": "MIT", "domain": "async-web", "package": "outcome"},
    {"repo": "dry-python/returns", "license": "BSD-2-Clause", "domain": "functional", "package": "returns"},
    {"repo": "dabeaz/curio", "license": "BSD-3-Clause", "domain": "async-web", "package": "curio"},
    {"repo": "sdispater/pastel", "license": "MIT", "domain": "cli-tables", "package": "pastel"},
    {"repo": "timofurrer/colorful", "license": "MIT", "domain": "cli-tables", "package": "colorful"},
    {"repo": "mahmoud/lithoxyl", "license": "BSD-3-Clause", "domain": "workflows", "package": "lithoxyl"},
    {"repo": "nedbat/scriv", "license": "Apache-2.0", "domain": "packaging-deps", "package": "scriv"},
    {"repo": "frostming/unearth", "license": "MIT", "domain": "packaging-deps", "package": "unearth"},
    {"repo": "hukkin/mdformat", "license": "MIT", "domain": "html-css", "package": "mdformat"},
    {"repo": "zytedata/url-matcher", "license": "BSD-3-Clause", "domain": "web-http", "package": "url_matcher"},
    {"repo": "facelessuser/backrefs", "license": "MIT", "domain": "text-nlp", "package": "backrefs"},
    {"repo": "joke2k/faker", "license": "MIT", "domain": "testing-data", "package": "faker"},
    {"repo": "FactoryBoy/factory_boy", "license": "MIT", "domain": "testing-data", "package": "factory"},
    {"repo": "spulec/freezegun", "license": "Apache-2.0", "domain": "testing-data", "package": "freezegun"},
    {"repo": "Delgan/loguru", "license": "MIT", "domain": "workflows", "package": "loguru"},
    {"repo": "agronholm/apscheduler", "license": "MIT", "domain": "workflows", "package": "apscheduler"},
    {"repo": "pallets/markupsafe", "license": "BSD-3-Clause", "domain": "templates", "package": "markupsafe"},
    {"repo": "eclipse-paho/paho.mqtt.python", "license": "EPL-2.0", "domain": "protocols", "package": "paho"},
    {"repo": "stub42/pytz", "license": "MIT", "domain": "date-time", "package": "pytz"},
    {"repo": "python-json-logger/python-json-logger", "license": "BSD-2-Clause", "domain": "workflows", "package": "pythonjsonlogger"},
    {"repo": "pydicom/pydicom", "license": "MIT", "domain": "binary-codec", "package": "pydicom"},
    {"repo": "sqlfluff/sqlfluff", "license": "MIT", "domain": "sql", "package": "sqlfluff"},
    {"repo": "mpdavis/python-jose", "license": "MIT", "domain": "crypto-auth", "package": "jose"},
    {"repo": "pallets/quart", "license": "MIT", "domain": "web-http", "package": "quart"},
    {"repo": "scrapinghub/parsel", "license": "BSD-3-Clause", "domain": "html-css", "package": "parsel"},
    {"repo": "sqlalchemy/alembic", "license": "MIT", "domain": "search-db", "package": "alembic"},
    {"repo": "fastapi/sqlmodel", "license": "MIT", "domain": "search-db", "package": "sqlmodel"},
    # Additional diverse pure-Python multi-file OSS repos (pushing catalog to 145+)
    {
        "repo": "m-lundberg/simple-pid",
        "license": "MIT",
        "domain": "math-science",
        "package": "simple_pid",
        "api_probes": [
            {
                "name": "pid_sim",
                "code": '''"""Cross-file probe exercising `simple_pid` PID controller loop simulation."""
from simple_pid import PID

def run(setpoint: float, kp: float, ki: float, kd: float, steps: int) -> list[float]:
    pid = PID(kp, ki, kd, setpoint=setpoint, sample_time=None, output_limits=(-10, 10))
    val = 0.0
    traj = []
    for _ in range(steps):
        ctrl = pid(val, dt=0.1)
        val += ctrl * 0.1
        traj.append(round(val, 4))
    return traj
''',
                "cases": [
                    ("step1", [10.0, 2.0, 0.5, 0.1, 8]),
                    ("step2", [5.0, 1.5, 0.2, 0.05, 6]),
                ],
            },
        ],
    },
    {
        "repo": "keleshev/docopt-ng",
        "license": "MIT",
        "domain": "cli-tables",
        "package": "docopt_ng",
    },
    {
        "repo": "jawah/charset_mnbvc",
        "license": "MIT",
        "domain": "text-nlp",
        "package": "charset_mnbvc",
    },
    {
        "repo": "python-attrs/cattrs",
        "license": "MIT",
        "domain": "data-config",
        "package": "cattrs",
    },
    {
        "repo": "jazzband/django-environ",
        "license": "MIT",
        "domain": "data-config",
        "package": "environ",
    },
    {
        "repo": "klen/muffin",
        "license": "MIT",
        "domain": "web-http",
        "package": "muffin",
    },
    {
        "repo": "sdispater/orator",
        "license": "MIT",
        "domain": "search-db",
        "package": "orator",
    },
    {
        "repo": "encode/databases",
        "license": "BSD-3-Clause",
        "domain": "search-db",
        "package": "databases",
    },
    {
        "repo": "encode/orm",
        "license": "BSD-3-Clause",
        "domain": "search-db",
        "package": "orm",
    },
    {
        "repo": "encode/apistar",
        "license": "BSD-3-Clause",
        "domain": "web-http",
        "package": "apistar",
    },
    {
        "repo": "mahmoud/clastic",
        "license": "BSD-3-Clause",
        "domain": "web-http",
        "package": "clastic",
    },
    {
        "repo": "mahmoud/hyperlink",
        "license": "MIT",
        "domain": "web-http",
        "package": "hyperlink",
    },
    {
        "repo": "pallets/quart-cors",
        "license": "MIT",
        "domain": "web-http",
        "package": "quart_cors",
    },
    {
        "repo": "pypa/pyproject-hooks",
        "license": "MIT",
        "domain": "packaging-deps",
        "package": "pyproject_hooks",
    },
    {
        "repo": "pypa/trove-classifiers",
        "license": "Apache-2.0",
        "domain": "packaging-deps",
        "package": "trove_classifiers",
    },
    {
        "repo": "python-poetry/poetry-plugin-export",
        "license": "MIT",
        "domain": "packaging-deps",
        "package": "poetry_plugin_export",
    },
    {
        "repo": "ofek/hatch",
        "license": "MIT",
        "domain": "packaging-deps",
        "package": "hatchling",
    },
    {
        "repo": "tox-dev/filelock",
        "license": "Unlicense",
        "domain": "workflows",
        "package": "filelock",
    },
    {
        "repo": "tox-dev/pyproject-api",
        "license": "MIT",
        "domain": "packaging-deps",
        "package": "pyproject_api",
    },
    {
        "repo": "jaraco/path",
        "license": "MIT",
        "domain": "workflows",
        "package": "path",
    },
    {
        "repo": "jaraco/zipp",
        "license": "MIT",
        "domain": "packaging-deps",
        "package": "zipp",
    },
    {
        "repo": "jaraco/importlib_resources",
        "license": "Apache-2.0",
        "domain": "packaging-deps",
        "package": "importlib_resources",
    },
    {
        "repo": "jaraco/more-itertools",
        "license": "MIT",
        "domain": "data-structures",
        "package": "more_itertools",
    },
    {
        "repo": "gruns/furl",
        "license": "Unlicense",
        "domain": "web-http",
        "package": "furl",
    },
    {
        "repo": "tartley/colorama",
        "license": "BSD-3-Clause",
        "domain": "cli-tables",
        "package": "colorama",  # dynamically filtered if forbidden
    },
    {
        "repo": "mitsuhiko/unp",
        "license": "BSD-3-Clause",
        "domain": "cli-tables",
        "package": "unp",
    },
    {
        "repo": "jazzband/pip-tools",
        "license": "BSD-3-Clause",
        "domain": "packaging-deps",
        "package": "piptools",
    },
    {
        "repo": "pallets-eco/itsdangerous",
        "license": "BSD-3-Clause",
        "domain": "crypto-auth",
        "package": "itsdangerous",  # dynamically filtered if forbidden
    },
    {
        "repo": "alisaifee/flask-limiter",
        "license": "MIT",
        "domain": "resilience",
        "package": "flask_limiter",
    },
    {
        "repo": "marshmallow-code/webargs",
        "license": "MIT",
        "domain": "web-http",
        "package": "webargs",
    },
    {
        "repo": "koxudaxi/datamodel-code-generator",
        "license": "MIT",
        "domain": "ast-lint",
        "package": "datamodel_code_generator",
    },
    {
        "repo": "Textualize/rich-cli",
        "license": "MIT",
        "domain": "cli-tables",
        "package": "rich_cli",
    },
    {
        "repo": "tiangolo/typer",
        "license": "MIT",
        "domain": "cli-tables",
        "package": "typer",
    },
    {
        "repo": "python-validators/fqdn",
        "license": "MPL-2.0",
        "domain": "web-http",
        "package": "fqdn",
    },
    {
        "repo": "mozilla/nh3",
        "license": "MIT",
        "domain": "html-css",
        "package": "nh3",
    },
    {
        "repo": "yaml/pyyaml-env-tag",
        "license": "MIT",
        "domain": "data-config",
        "package": "yaml_env_tag",
    },
    {
        "repo": "mkdocs/mkdocs",
        "license": "MIT",
        "domain": "document-media",
        "package": "mkdocs",
    },
    {
        "repo": "facelessuser/pymdown-extensions",
        "license": "MIT",
        "domain": "html-css",
        "package": "pymdownx",
    },
    {
        "repo": "hukkin/tomli-w",
        "license": "MIT",
        "domain": "data-config",
        "package": "tomli_w",  # dynamically filtered if forbidden
    },
    {
        "repo": "nedbat/coveragepy",
        "license": "Apache-2.0",
        "domain": "ast-lint",
        "package": "coverage",
    },
    {
        "repo": "pytest-dev/py",
        "license": "MIT",
        "domain": "workflows",
        "package": "py",
    },
    {
        "repo": "python-trio/trio",
        "license": "MIT",
        "domain": "async-web",
        "package": "trio",
    },
    {
        "repo": "agronholm/anyio",
        "license": "MIT",
        "domain": "async-web",
        "package": "anyio",
    },
    {
        "repo": "encode/sniffio",
        "license": "MIT",
        "domain": "async-web",
        "package": "sniffio",
    },
    {
        "repo": "MagicStack/immutables",
        "license": "Apache-2.0",
        "domain": "data-structures",
        "package": "immutables",
    },
    {
        "repo": "klen/aio-pika",
        "license": "Apache-2.0",
        "domain": "protocols",
        "package": "aio_pika",
    },
    {
        "repo": "jd/daiquiri",
        "license": "Apache-2.0",
        "domain": "workflows",
        "package": "daiquiri",
    },
    {
        "repo": "python-attrs/structlog",
        "license": "MIT",
        "domain": "workflows",
        "package": "structlog",
    },
    {
        "repo": "Textualize/textual",
        "license": "MIT",
        "domain": "cli-tables",
        "package": "textual",
    },
    {
        "repo": "prompt-toolkit/python-prompt-toolkit",
        "license": "BSD-3-Clause",
        "domain": "cli-tables",
        "package": "prompt_toolkit",
    },
    {
        "repo": "psf/black",
        "license": "MIT",
        "domain": "ast-lint",
        "package": "blib2to3",
    },
    {
        "repo": "google/abseil-py",
        "license": "Apache-2.0",
        "domain": "cli-tables",
        "package": "absl",
    },
    {
        "repo": "pypa/packaging",
        "license": "MIT",
        "domain": "packaging-deps",
        "package": "packaging",  # dynamically filtered
    },
    {
        "repo": "encode/django-rest-framework",
        "license": "BSD-3-Clause",
        "domain": "web-http",
        "package": "rest_framework",
    },
    {
        "repo": "aio-libs/yarl",
        "license": "Apache-2.0",
        "domain": "web-http",
        "package": "yarl",
    },
    {
        "repo": "aio-libs/multidict",
        "license": "Apache-2.0",
        "domain": "data-structures",
        "package": "multidict",
    },
    {
        "repo": "python-hyper/h11",
        "license": "MIT",
        "domain": "web-http",
        "package": "h11",  # dynamically filtered
    },
    {
        "repo": "jpadilla/django-dotenv",
        "license": "MIT",
        "domain": "data-config",
        "package": "dotenv",  # dynamically filtered
    },
    # --- Wave 3 Expansion: 32 High-Signal Curated Pure-Python Repos ---
    {
        "repo": "scrapy/protego",
        "license": "BSD-3-Clause",
        "domain": "web-http",
        "package": "protego",
        "api_probes": [{
            "name": "robots_parse",
            "code": '''"""Cross-file probe exercising `protego` robots.txt parser and crawl-delay lookup."""
from protego import Protego

def run(robots_txt: str, agent: str, urls: list[str]) -> dict:
    rp = Protego.parse(robots_txt)
    return {
        "allowed": {u: rp.can_fetch(u, agent) for u in urls},
        "crawl_delay": rp.crawl_delay(agent),
        "sitemaps": list(rp.sitemaps),
    }
''',
            "cases": [
                ("googlebot", ["User-agent: *\nDisallow: /admin/\nAllow: /admin/public\nCrawl-delay: 5\nSitemap: https://ex.io/sm.xml\n", "mybot", ["https://ex.io/home", "https://ex.io/admin/secret", "https://ex.io/admin/public/a"]]),
                ("specific", ["User-agent: crawler\nDisallow: /private/\nUser-agent: *\nAllow: /\n", "crawler", ["https://ex.io/private/x", "https://ex.io/docs"]]),
            ],
        }],
    },
    {
        "repo": "scrapy/itemadapter",
        "license": "BSD-3-Clause",
        "domain": "data-config",
        "package": "itemadapter",
        "api_probes": [{
            "name": "adapt_items",
            "code": '''"""Cross-file probe exercising `itemadapter` unified dataclass/dict item inspection."""
from dataclasses import dataclass
from itemadapter import ItemAdapter

@dataclass
class Product:
    sku: str
    price: int
    tags: list

def run(sku: str, price: int, tags: list[str], extra: dict) -> dict:
    p = Product(sku=sku, price=price, tags=tags)
    a1 = ItemAdapter(p)
    a2 = ItemAdapter(dict(extra))
    a2["normalized"] = a1["sku"].lower()
    return {"fields": sorted(a1.field_names()), "as_dict": a1.asdict(), "extra": a2.asdict()}
''',
            "cases": [
                ("p1", ["SKU-101", 49, ["sale", "new"], {"region": "us"}]),
                ("p2", ["SKU-202", 120, ["pro"], {"region": "eu"}]),
            ],
        }],
    },
    {
        "repo": "scrapy/queuelib",
        "license": "BSD-3-Clause",
        "domain": "data-structures",
        "package": "queuelib",
        "api_probes": [{
            "name": "priority_queue",
            "code": '''"""Cross-file probe exercising `queuelib` PriorityQueue and FifoMemoryQueue."""
from queuelib.pqueue import PriorityQueue
from queuelib.queue import FifoMemoryQueue

def run(items: list[list]) -> list:
    pq = PriorityQueue(lambda _prio: FifoMemoryQueue())
    for val, prio in items:
        pq.push(val, prio)
    out = []
    while len(pq):
        out.append(pq.pop())
    return out
''',
            "cases": [
                ("tasks", [[["low", 10], ["high1", 1], ["med", 5], ["high2", 1]]]),
                ("jobs", [[["j1", 3], ["j2", 0], ["j3", 2], ["j4", 0]]]),
            ],
        }],
    },
    {
        "repo": "celery/vine",
        "license": "BSD-3-Clause",
        "domain": "workflows",
        "package": "vine",
        "api_probes": [{
            "name": "promise_barrier",
            "code": '''"""Cross-file probe exercising `vine` promise chains and barrier synchronization."""
from vine import promise, barrier

def run(nums: list[int], scale: int) -> dict:
    log = []
    def on_done():
        log.append("all_done")
    b = barrier([promise(lambda x: x * scale) for _ in nums], callback=promise(on_done))
    results = [p(n) for p, n in zip(b.p.args[0] if False else [promise(lambda x: x * scale) for _ in nums], nums)]
    b2 = barrier(size=len(nums), callback=promise(on_done))
    for _ in nums:
        b2()
    return {"scaled": results, "ready": b2.ready, "log": log}
''',
            "cases": [
                ("s1", [[2, 4, 6], 3]),
                ("s2", [[1, 5, 9, 10], 2]),
            ],
        }],
    },
    {
        "repo": "micheles/decorator",
        "license": "BSD-2-Clause",
        "domain": "functional",
        "package": "decorator",
        "api_probes": [{
            "name": "signature_preserve",
            "code": '''"""Cross-file probe exercising `decorator` signature-preserving decorators."""
import inspect
from decorator import decorator

def run(xs: list[int], mult: int) -> dict:
    calls = []
    @decorator
    def trace(fn, *args, **kw):
        res = fn(*args, **kw)
        calls.append({"args": list(args), "res": res})
        return res
    @trace
    def compute(a, b=1):
        return a * b
    out = [compute(x, mult) for x in xs]
    return {"sig": str(inspect.signature(compute)), "out": out, "calls": calls}
''',
            "cases": [
                ("m1", [[2, 3, 5], 4]),
                ("m2", [[1, 10], 7]),
            ],
        }],
    },
    {
        "repo": "keleshev/schema",
        "license": "MIT",
        "domain": "typing-validation",
        "package": "schema",
        "api_probes": [{
            "name": "validate_records",
            "code": '''"""Cross-file probe exercising `schema` declarative Python data validation & coercion."""
from schema import Schema, And, Use, Optional, SchemaError

def run(records: list[dict]) -> list[dict]:
    s = Schema({
        "name": And(str, len),
        "age": And(Use(int), lambda n: 0 <= n <= 120),
        Optional("role", default="user"): And(str, lambda r: r in ("user", "admin")),
    })
    out = []
    for r in records:
        try:
            out.append({"ok": True, "val": s.validate(r)})
        except SchemaError as exc:
            out.append({"ok": False, "err": str(exc.code or "invalid")})
    return out
''',
            "cases": [
                ("r1", [[{"name": "Ada", "age": "36", "role": "admin"}, {"name": "", "age": 20}, {"name": "Bob", "age": 42}]]),
                ("r2", [[{"name": "Cy", "age": 150}, {"name": "Di", "age": "19"}]]),
            ],
        }],
    },
    {
        "repo": "mewwts/addict",
        "license": "MIT",
        "domain": "data-config",
        "package": "addict",
        "api_probes": [{
            "name": "nested_attr_dict",
            "code": '''"""Cross-file probe exercising `addict.Dict` auto-vivifying nested attribute access."""
from addict import Dict

def run(base: dict, patch: dict) -> dict:
    d = Dict(base)
    d.runtime.enabled = True
    d.update(Dict(patch))
    d.prune()
    return d.to_dict()
''',
            "cases": [
                ("c1", [{"svc": {"host": "a", "port": 80}}, {"svc": {"port": 443}, "meta": {"v": 2}}]),
                ("c2", [{"a": {"x": 1}}, {"b": {"y": 2}}]),
            ],
        }],
    },
    {
        "repo": "Infinidat/munch",
        "license": "MIT",
        "domain": "data-config",
        "package": "munch",
        "api_probes": [{
            "name": "munchify_roundtrip",
            "code": '''"""Cross-file probe exercising `munch` recursive attribute-dict conversion."""
from munch import munchify, unmunchify

def run(data: dict) -> dict:
    m = munchify(data)
    m.meta.processed = True
    m.meta.count = len(m.items)
    return unmunchify(m)
''',
            "cases": [
                ("d1", [{"meta": {"env": "prod"}, "items": [{"id": 1}, {"id": 2}]}]),
                ("d2", [{"meta": {"env": "dev"}, "items": [{"id": 9}]}]),
            ],
        }],
    },
    {
        "repo": "gmr/flatdict",
        "license": "BSD-3-Clause",
        "domain": "data-config",
        "package": "flatdict",
        "api_probes": [{
            "name": "flatten_unflatten",
            "code": '''"""Cross-file probe exercising `flatdict.FlatterDict` nested key flattening."""
import flatdict

def run(nested: dict) -> dict:
    fd = flatdict.FlatterDict(nested, delimiter=".")
    return {"flat": dict(fd.items()), "keys": sorted(fd.keys()), "restored": fd.as_dict()}
''',
            "cases": [
                ("f1", [{"db": {"host": "pg", "ports": [5432, 5433]}, "cache": {"ttl": 60}}]),
                ("f2", [{"a": {"b": {"c": 1}}, "d": [10, 20]}]),
            ],
        }],
    },
    {
        "repo": "martinblech/xmltodict",
        "license": "MIT",
        "domain": "data-config",
        "package": "xmltodict",
        "api_probes": [{
            "name": "xml_roundtrip",
            "code": '''"""Cross-file probe exercising `xmltodict` XML parsing and unparsing."""
import xmltodict

def run(xml_str: str) -> dict:
    parsed = xmltodict.parse(xml_str)
    back = xmltodict.unparse(parsed, full_document=False)
    return {"parsed": parsed, "back": back}
''',
            "cases": [
                ("catalog", ['<catalog><book id="1"><title>Py</title><price>30</price></book><book id="2"><title>SQL</title><price>25</price></book></catalog>']),
                ("cfg", ['<config env="prod"><host>api.local</host><port>8443</port></config>']),
            ],
        }],
    },
    {
        "repo": "astanin/python-tabulate",
        "license": "MIT",
        "domain": "cli-tables",
        "package": "tabulate",
        "api_probes": [{
            "name": "format_tables",
            "code": '''"""Cross-file probe exercising `tabulate` multi-format table rendering."""
from tabulate import tabulate

def run(headers: list[str], rows: list[list], fmts: list[str]) -> dict:
    return {f: tabulate(rows, headers=headers, tablefmt=f) for f in fmts}
''',
            "cases": [
                ("svc", [["name", "qps", "ok"], [["auth", 410.5, True], ["pay", 92.25, True]], ["github", "grid"]]),
                ("inv", [["sku", "qty"], [["A1", 12], ["B2", 0]], ["simple", "pipe"]]),
            ],
        }],
    },
    {
        "repo": "dorianbrown/rank_bm25",
        "license": "Apache-2.0",
        "domain": "search-db",
        "package": "rank_bm25",
        "api_probes": [{
            "name": "bm25_rank",
            "code": '''"""Cross-file probe exercising `rank_bm25` BM25Okapi corpus scoring."""
from rank_bm25 import BM25Okapi

def run(docs: list[str], query: str) -> list[dict]:
    tokenized = [d.lower().split() for d in docs]
    bm25 = BM25Okapi(tokenized)
    scores = bm25.get_scores(query.lower().split())
    ranked = sorted(enumerate(scores), key=lambda kv: (-kv[1], kv[0]))
    return [{"idx": i, "score": round(float(s), 4)} for i, s in ranked]
''',
            "cases": [
                ("q1", [["python async event loop", "sqlite full text index", "python retry backoff loop"], "python loop"]),
                ("q2", [["css grid layout", "html parser tree", "css selector matching"], "css selector"]),
            ],
        }],
    },
    {
        "repo": "avian2/unidecode",
        "license": "GPL-2.0",
        "domain": "text-nlp",
        "package": "unidecode",
        "api_probes": [{
            "name": "transliterate",
            "code": '''"""Cross-file probe exercising `unidecode` Unicode-to-ASCII transliteration."""
from unidecode import unidecode

def run(samples: list[str]) -> list[str]:
    return [unidecode(s) for s in samples]
''',
            "cases": [
                ("intl", [["Café Crème", "München Straße", "東京タワー", "Москва"]]),
                ("math_sym", [["naïve résumé", "Łódź — 100€"]]),
            ],
        }],
    },
    {
        "repo": "facelessuser/bracex",
        "license": "MIT",
        "domain": "packaging-deps",
        "package": "bracex",
        "api_probes": [{
            "name": "brace_expand",
            "code": '''"""Cross-file probe exercising `bracex` Bash-style brace & numeric sequence expansion."""
import bracex

def run(patterns: list[str]) -> dict:
    return {p: list(bracex.expand(p)) for p in patterns}
''',
            "cases": [
                ("p1", [["srv-{01..04}.{us,eu}.local", "log_{a..d}.txt"]]),
                ("p2", [["v{1..3}/{api,web}/app.{py,ts}"]]),
            ],
        }],
    },
    {
        "repo": "python-trio/outcome",
        "license": "MIT",
        "domain": "async-web",
        "package": "outcome",
        "api_probes": [{
            "name": "capture_outcomes",
            "code": '''"""Cross-file probe exercising `outcome` Value/Error capture and unwrap."""
import outcome

def run(pairs: list[list[int]]) -> list[dict]:
    out = []
    for a, b in pairs:
        res = outcome.capture(lambda x=a, y=b: x // y)
        if isinstance(res, outcome.Value):
            out.append({"kind": "value", "val": res.unwrap()})
        else:
            out.append({"kind": "error", "err": type(res.error).__name__})
    return out
''',
            "cases": [
                ("div1", [[[10, 2], [7, 0], [15, 4]]]),
                ("div2", [[[0, 5], [9, 3], [1, 0]]]),
            ],
        }],
    },
    {
        "repo": "gruns/orderedmultidict",
        "license": "Unlicense",
        "domain": "data-structures",
        "package": "orderedmultidict",
        "companion_repos": [("benjaminp/six", "six")],
        "api_probes": [{
            "name": "omd_ops",
            "code": '''"""Cross-file probe exercising `orderedmultidict` multi-value ordered dictionary."""
from orderedmultidict import omdict

def run(pairs: list[list]) -> dict:
    m = omdict(pairs)
    return {
        "keys": list(m.keys()),
        "all_items": list(m.allitems()),
        "tags": m.getlist("tag"),
        "size": m.size(),
    }
''',
            "cases": [
                ("c1", [[["tag", "py"], ["env", "prod"], ["tag", "oss"], ["tag", "wave3"]]]),
                ("c2", [[["a", 1], ["b", 2], ["a", 3]]]),
            ],
        }],
    },
    {
        "repo": "codeinthehole/purl",
        "license": "MIT",
        "domain": "web-http",
        "package": "purl",
        "companion_repos": [("benjaminp/six", "six")],
        "api_probes": [{
            "name": "purl_build",
            "code": '''"""Cross-file probe exercising `purl` immutable URL builder & RFC 6570 Templates."""
from purl import URL, Template

def run(raw_url: str, tpl_str: str, tpl_vars: dict) -> dict:
    u = URL(raw_url).add_path_segment("details").query_param("v", "2")
    expanded = Template(tpl_str).expand(tpl_vars)
    return {"url": u.as_string(), "segments": list(u.path_segments()), "expanded": expanded.as_string()}
''',
            "cases": [
                ("u1", ["https://api.ex.io/items?sort=asc", "https://ex.io/users/{id}{?lang,fmt}", {"id": "42", "lang": "en", "fmt": "json"}]),
                ("u2", ["http://svc.local:8080/v1", "http://svc.local/orgs/{org}/repos", {"org": "acme"}]),
            ],
        }],
    },
    {
        "repo": "wbolster/jsonlines",
        "license": "BSD-3-Clause",
        "domain": "data-config",
        "package": "jsonlines",
        "api_probes": [{
            "name": "jsonl_stream",
            "code": '''"""Cross-file probe exercising `jsonlines` streaming Reader and Writer."""
import io
import jsonlines

def run(records: list[dict]) -> dict:
    buf = io.StringIO()
    with jsonlines.Writer(buf, sort_keys=True) as w:
        w.write_all(records)
    raw = buf.getvalue()
    with jsonlines.Reader(io.StringIO(raw)) as r:
        back = list(r)
    return {"lines": len(raw.splitlines()), "same": back == records, "back": back}
''',
            "cases": [
                ("s1", [[{"id": 1, "ok": True}, {"id": 2, "ok": False, "msg": "retry"}]]),
                ("s2", [[{"k": "a", "v": [1, 2]}, {"k": "b", "v": [3]}]]),
            ],
        }],
    },
    {
        "repo": "vi3k6i5/flashtext",
        "license": "MIT",
        "domain": "text-nlp",
        "package": "flashtext",
        "api_probes": [{
            "name": "keyword_trie",
            "code": '''"""Cross-file probe exercising `flashtext` Aho-Corasick keyword extraction & replacement."""
from flashtext import KeywordProcessor

def run(mapping: dict, text: str) -> dict:
    kp = KeywordProcessor(case_sensitive=False)
    for clean, aliases in mapping.items():
        kp.add_keywords_from_dict({clean: aliases})
    found = kp.extract_keywords(text, span_info=True)
    replaced = kp.replace_keywords(text)
    return {"found": [list(x) for x in found], "replaced": replaced}
''',
            "cases": [
                ("tech", [{"Python": ["py3", "python3"], "SQLite": ["sqlite3", "sqlite"]}, "Use py3 with sqlite3 for fast local DBs."]),
                ("cities", [{"New York": ["NYC", "Big Apple"], "San Francisco": ["SF"]}, "Flight from NYC to SF tonight."]),
            ],
        }],
    },
    {
        "repo": "Robpol86/terminaltables",
        "license": "MIT",
        "domain": "cli-tables",
        "package": "terminaltables",
        "api_probes": [{
            "name": "ascii_table",
            "code": '''"""Cross-file probe exercising `terminaltables` AsciiTable and GithubFlavoredMarkdownTable."""
from terminaltables import AsciiTable, GithubFlavoredMarkdownTable

def run(title: str, rows: list[list[str]]) -> dict:
    a = AsciiTable(rows, title=title)
    g = GithubFlavoredMarkdownTable(rows)
    return {"ascii": a.table, "gfm": g.table}
''',
            "cases": [
                ("t1", ["Services", [["Name", "Status"], ["api", "UP"], ["db", "UP"]]]),
                ("t2", ["Jobs", [["ID", "State"], ["j1", "DONE"], ["j2", "FAIL"]]]),
            ],
        }],
    },
    {
        "repo": "sdispater/pastel",
        "license": "MIT",
        "domain": "cli-tables",
        "package": "pastel",
        "api_probes": [{
            "name": "color_markup",
            "code": '''"""Cross-file probe exercising `pastel` ANSI tag parsing and colorization."""
import pastel

def run(markup: str) -> dict:
    p = pastel.Pastel(with_colors=True)
    p_plain = pastel.Pastel(with_colors=False)
    return {"ansi": p.colorize(markup), "plain": p_plain.colorize(markup)}
''',
            "cases": [
                ("m1", ["<info>PASS</info>: <comment>42 tests</comment> (<error>0 failed</error>)"]),
                ("m2", ["<fg=green;options=bold>OK</> deployed <fg=cyan>v3.0</>"]),
            ],
        }],
    },
    {
        "repo": "zytedata/url-matcher",
        "license": "BSD-3-Clause",
        "domain": "web-http",
        "package": "url_matcher",
        "api_probes": [{
            "name": "url_rules",
            "code": '''"""Cross-file probe exercising `url_matcher` include/exclude URL pattern matching."""
from url_matcher import URLMatcher, Patterns

def run(urls: list[str]) -> list[dict]:
    m = URLMatcher()
    m.add_or_update("product", Patterns(include=["shop.example.com/p/"], exclude=["/reviews"]))
    m.add_or_update("blog", Patterns(include=["example.com/blog/"]))
    return [{"url": u, "rule": m.match(u)} for u in urls]
''',
            "cases": [
                ("u1", [["https://shop.example.com/p/42", "https://shop.example.com/p/42/reviews", "https://example.com/blog/intro", "https://other.io/x"]]),
                ("u2", [["https://shop.example.com/p/99?ref=1", "https://example.com/about"]]),
            ],
        }],
    },
    {
        "repo": "python-validators/fqdn",
        "license": "MPL-2.0",
        "domain": "web-http",
        "package": "fqdn",
        "api_probes": [{
            "name": "validate_fqdns",
            "code": '''"""Cross-file probe exercising `fqdn` RFC 1035/1123 domain validation."""
from fqdn import FQDN

def run(hosts: list[str]) -> list[dict]:
    out = []
    for h in hosts:
        f = FQDN(h)
        out.append({"host": h, "valid": f.is_valid, "absolute": f.is_valid_absolute, "relative": f.relative})
    return out
''',
            "cases": [
                ("h1", [["api.example.com", "bad_host.local", "sub.domain.org.", "localhost"]]),
                ("h2", [["a-1.b-2.io", "-leading.com", "x.y.z"]]),
            ],
        }],
    },
    {
        "repo": "mahmoud/face",
        "license": "BSD-3-Clause",
        "domain": "cli-tables",
        "package": "face",
        "api_probes": [{
            "name": "cli_parse",
            "code": '''"""Cross-file probe exercising `face` CLI parser and subcommand dispatch."""
from face import Command, Flag

def run(argv: list[str]) -> dict:
    def deploy(env, retries, dry_run):
        return {"env": env, "retries": retries, "dry_run": dry_run}
    cmd = Command(deploy, name="ctl")
    cmd.add(Flag("--env", parse_as=str, missing="staging"))
    cmd.add(Flag("--retries", parse_as=int, missing=3))
    cmd.add(Flag("--dry-run", parse_as=bool))
    return cmd.run(["ctl", *argv])
''',
            "cases": [
                ("prod", [["--env", "prod", "--retries", "5", "--dry-run"]]),
                ("defaults", [[]]),
            ],
        }],
    },
    {
        "repo": "pallets/markupsafe",
        "license": "BSD-3-Clause",
        "domain": "templates",
        "package": "markupsafe",
        "api_probes": [{
            "name": "markup_escape",
            "code": '''"""Cross-file probe exercising `markupsafe` HTML escaping, striptags, and safe formatting."""
from markupsafe import Markup, escape

def run(user_input: str, html_snippet: str) -> dict:
    tmpl = Markup("<p>Hello <strong>%s</strong></p>")
    rendered = str(tmpl % user_input)
    stripped = Markup(html_snippet).striptags()
    return {"rendered": rendered, "escaped": str(escape(user_input)), "stripped": stripped}
''',
            "cases": [
                ("xss", ["<script>alert('x')</script>", "<div>Hello   <b>World</b> &amp; <i>Py</i></div>"]),
                ("plain", ["Ada & Bob", "<p>Item <span>#42</span></p>"]),
            ],
        }],
    },
    {
        "repo": "pypa/trove-classifiers",
        "license": "Apache-2.0",
        "domain": "packaging-deps",
        "package": "trove_classifiers",
        "api_probes": [{
            "name": "check_classifiers",
            "code": '''"""Cross-file probe exercising `trove_classifiers` PyPI classifier validation."""
import trove_classifiers as tc

def run(items: list[str]) -> list[dict]:
    return [
        {"clf": c, "valid": c in tc.classifiers, "deprecated": c in tc.deprecated_classifiers}
        for c in items
    ]
''',
            "cases": [
                ("c1", [["License :: OSI Approved :: MIT License", "Programming Language :: Python :: 3.12", "Fake :: Classifier"]]),
                ("c2", [["Topic :: Software Development :: Compilers", "Development Status :: 5 - Production/Stable"]]),
            ],
        }],
    },
    {
        "repo": "scrapinghub/price-parser",
        "license": "BSD-3-Clause",
        "domain": "text-nlp",
        "package": "price_parser",
        "api_probes": [{
            "name": "parse_prices",
            "code": '''"""Cross-file probe exercising `price_parser` multi-locale currency & amount extraction."""
from price_parser import Price

def run(samples: list[str]) -> list[dict]:
    out = []
    for s in samples:
        p = Price.fromstring(s)
        out.append({"raw": s, "amount": float(p.amount) if p.amount is not None else None, "currency": p.currency})
    return out
''',
            "cases": [
                ("intl", [["$1,299.95", "€ 49,50", "GBP 120.00", "Free"]]),
                ("jp_us", [["¥15,000", "USD 19.99", "22.90 EUR"]]),
            ],
        }],
    },
    {
        "repo": "keleshev/docopt-ng",
        "license": "MIT",
        "domain": "cli-tables",
        "package": "docopt",
        "api_probes": [{
            "name": "cli_usage_parse",
            "code": '''"""Cross-file probe exercising `docopt-ng` POSIX usage specification parser."""
from docopt import docopt

DOC = """Tool.

Usage:
  tool sync <src> <dst> [--workers=<n>] [--dry-run]
  tool status [--verbose]

Options:
  --workers=<n>  Worker count [default: 4].
  --dry-run      Preview only.
  --verbose      Extra output.
"""

def run(argv: list[str]) -> dict:
    return dict(docopt(DOC, argv=argv))
''',
            "cases": [
                ("sync", [["sync", "s3://a", "s3://b", "--workers=8", "--dry-run"]]),
                ("status", [["status", "--verbose"]]),
            ],
        }],
    },
    {
        "repo": "pallets-eco/wtforms",
        "license": "BSD-3-Clause",
        "domain": "web-http",
        "package": "wtforms",
        "companion_repos": [("pallets/markupsafe", "markupsafe")],
        "api_probes": [{
            "name": "form_validate",
            "code": '''"""Cross-file probe exercising `wtforms` Form fields, validators, and HTML rendering."""
from wtforms import Form, StringField, IntegerField, validators

class UserForm(Form):
    username = StringField("Username", [validators.Length(min=3, max=20)])
    age = IntegerField("Age", [validators.NumberRange(min=13, max=120)])

def run(data: dict) -> dict:
    f = UserForm(data=data)
    ok = f.validate()
    return {"valid": ok, "errors": dict(f.errors), "data": dict(f.data)}
''',
            "cases": [
                ("ok", [{"username": "alice_dev", "age": 29}]),
                ("bad", [{"username": "a", "age": 10}]),
            ],
        }],
    },
    {
        "repo": "python-hyper/wsproto",
        "license": "MIT",
        "domain": "web-http",
        "package": "wsproto",
        "api_probes": [{
            "name": "ws_frame_codec",
            "code": '''"""Cross-file probe exercising `wsproto.frame_protocol` RFC 6455 WebSocket framing."""
from wsproto.frame_protocol import FrameProtocol, Opcode

def run(messages: list[str]) -> list[dict]:
    client = FrameProtocol(client=True, extensions=[])
    server = FrameProtocol(client=False, extensions=[])
    out = []
    for m in messages:
        wire = client.send_data(m, fin=True)
        server.receive_bytes(wire)
        for frame in server.received_frames():
            out.append({"opcode": frame.opcode.name, "payload": frame.payload, "fin": frame.frame_finished})
    return out
''',
            "cases": [
                ("text", [["hello websocket", "ping-2026"]]),
                ("multi", [["alpha", "beta", "gamma"]]),
            ],
        }],
    },
    {
        "repo": "Kludex/python-multipart",
        "license": "Apache-2.0",
        "domain": "web-http",
        "package": "python_multipart",
        "api_probes": [{
            "name": "parse_multipart",
            "code": '''"""Cross-file probe exercising `python_multipart` streaming MultipartParser."""
from python_multipart.multipart import MultipartParser

def run(boundary: str, body: str) -> list[dict]:
    parts = []
    cur = {"headers": {}, "data": b""}
    cur_hdr = [b""]
    def on_h_field(data, start, end):
        cur_hdr[0] = data[start:end]
    def on_h_val(data, start, end):
        cur["headers"][cur_hdr[0].decode().lower()] = data[start:end].decode()
    def on_part_data(data, start, end):
        cur["data"] += data[start:end]
    def on_part_end():
        parts.append({"headers": dict(cur["headers"]), "body": cur["data"].decode()})
        cur["headers"] = {}
        cur["data"] = b""
    parser = MultipartParser(boundary.encode(), {
        "on_header_field": on_h_field,
        "on_header_value": on_h_val,
        "on_part_data": on_part_data,
        "on_part_end": on_part_end,
    })
    parser.write(body.encode())
    parser.finalize()
    return parts
''',
            "cases": [
                ("form1", ["BOUND", '--BOUND\r\nContent-Disposition: form-data; name="user"\r\n\r\nada\r\n--BOUND\r\nContent-Disposition: form-data; name="role"\r\n\r\nadmin\r\n--BOUND--\r\n']),
                ("form2", ["XYZ", '--XYZ\r\nContent-Disposition: form-data; name="msg"\r\n\r\nhello world\r\n--XYZ--\r\n']),
            ],
        }],
    },
    {
        "repo": "dry-python/returns",
        "license": "BSD-2-Clause",
        "domain": "functional",
        "package": "returns",
        "api_probes": [{
            "name": "result_pipeline",
            "code": '''"""Cross-file probe exercising `returns.result` Success/Failure monadic bind pipeline."""
from returns.result import Result, Success, Failure

def parse_int(s: str) -> Result[int, str]:
    try:
        return Success(int(s))
    except ValueError:
        return Failure(f"bad_int:{s}")

def check_pos(n: int) -> Result[int, str]:
    return Success(n) if n > 0 else Failure(f"non_pos:{n}")

def run(items: list[str]) -> list[dict]:
    out = []
    for s in items:
        r = parse_int(s).bind(check_pos).map(lambda x: x * 10)
        if isinstance(r, Success):
            out.append({"ok": True, "val": r.unwrap()})
        else:
            out.append({"ok": False, "err": r.failure()})
    return out
''',
            "cases": [
                ("p1", [["4", "-2", "abc", "7"]]),
                ("p2", [["0", "12", "99"]]),
            ],
        }],
    },
]


# ===========================================================================
# Messy Real-World Stateful-I/O Python OSS Scenarios (40+ Brand-New Repos!)
# Every scenario is a causal world-state counterfactual pair verified 2x
# across PYTHONHASHSEED=101 vs 202 + _audit_causal_prefix_pair!
# ===========================================================================

def _load_stateful_pkg(
    repo_slug: str,
    pkg_hint: str,
    cache_dir: Path,
    *,
    companion_repos: list[tuple[str, str]] | None = None,
    max_files: int = 180,
    target_max_bytes: int = 240_000,
) -> tuple[dict[str, str] | None, str | None]:
    repo_dir, clone_err = _clone_repo(repo_slug, cache_dir)
    if repo_dir is None:
        return None, f"clone:{clone_err}"
    comp_files = _load_companion_files(companion_repos or [], cache_dir) if companion_repos else None
    bundle = _discover_package_bundle(
        repo_dir,
        pkg_hint,
        min_pkg_files=1,
        max_single_file_bytes=680_000,
        companion_files=comp_files,
    )
    if bundle is None:
        return None, f"discover:missing-{pkg_hint}"
    files = dict(bundle["files"])
    if len(files) > max_files or sum(len(v.encode("utf-8")) for v in files.values()) > MAX_CODEBASE_TOTAL_BYTES - 200_000:
        # Keep __init__.py and core modules first up to max_files / target_max_bytes
        keys = sorted(files.keys(), key=lambda p: (0 if p.endswith("__init__.py") else 1, p.count("/"), len(files[p]), p))
        trimmed: dict[str, str] = {}
        used = 0
        cap = max(target_max_bytes, 1_800_000)
        for k in keys:
            if len(trimmed) >= max_files:
                break
            b = len(files[k].encode("utf-8"))
            if used + b > cap:
                continue
            trimmed[k] = files[k]
            used += b
        files = trimmed
    return files, None


def build_stateful_scenarios(
    cache_dir: Path,
    http_server: _DeterministicHttpServer,
    forbidden: dict[str, set[str]],
    errors: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Build 40+ real-world stateful-I/O counterfactual pair scenarios across brand-new OSS repos."""
    scenarios: list[dict[str, Any]] = []
    base_url = f"http://127.0.0.1:{http_server.port}"

    def _pkg(
        repo: str,
        pkg_hint: str,
        *,
        companions: list[tuple[str, str]] | None = None,
        max_files: int = 160,
    ) -> dict[str, str] | None:
        reason = _repo_is_forbidden(repo, pkg_hint, forbidden)
        if reason:
            errors.append({"repo": repo, "stage": "stateful_filter", "error": reason})
            return None
        files, err = _load_stateful_pkg(
            repo, pkg_hint, cache_dir, companion_repos=companions, max_files=max_files
        )
        if files is None:
            errors.append({"repo": repo, "stage": "stateful_load", "error": err})
            return None
        return files

    def _add_pair(
        repo: str,
        pkg_hint: str,
        domain: str,
        slug: str,
        pkg_files: dict[str, str],
        entry_file: str,
        entry_code: str,
        entry_fn: str,
        args: list[Any],
        world_a: dict[str, Any],
        world_b: dict[str, Any],
        io_tags: list[str],
    ) -> None:
        files = _ensure_min_app_files(pkg_files, entry_file, entry_code, min_files=5)
        repo_id = _slug(repo.replace("/", "__"))
        pair_id = f"oss3-stateful-pair:{repo_id}:{slug}"
        scenarios.append({
            "repo": repo,
            "package": pkg_hint,
            "domain": domain,
            "slug": slug,
            "pair_id": pair_id,
            "files": files,
            "entry_file": entry_file,
            "entry": entry_fn,
            "args": args,
            "variants": [world_a, world_b],
            "features": ["multifile-codebase", "code-load", "oss-real-repo", "real-oss-stateful-io", "causal-pair", *io_tags],
        })

    # 1. kayak/pypika + sqlite3 + fs
    pkg = _pkg("kayak/pypika", "pypika")
    if pkg:
        _add_pair(
            "kayak/pypika", "pypika", "sql", "sqlite_revenue_report", pkg,
            "_oss_probe/pypika_sql_report.py",
            """import csv
import io
import json
import logging
import os
import sqlite3
from pathlib import Path
from pypika import Query, Table, Order, functions as fn

def run(csv_path, out_path):
    min_amt = int(os.getenv("MIN_AMOUNT", "50"))
    raw = Path(csv_path).read_text(encoding="utf-8")
    rows = list(csv.DictReader(io.StringIO(raw)))
    conn = sqlite3.connect(":memory:")
    conn.execute("CREATE TABLE sales (region TEXT, amount INTEGER, status TEXT)")
    for r in rows:
        conn.execute("INSERT INTO sales VALUES (?, ?, ?)", (r["region"], int(r["amount"]), r["status"]))
    sales = Table("sales")
    sql = (
        Query.from_(sales)
        .select(sales.region, fn.Count("*").as_("cnt"), fn.Sum(sales.amount).as_("rev"))
        .where((sales.status == "paid") & (sales.amount >= min_amt))
        .groupby(sales.region)
        .orderby(sales.region, order=Order.asc)
        .get_sql()
    )
    res = [{"region": r[0], "cnt": r[1], "rev": r[2]} for r in conn.execute(sql).fetchall()]
    conn.close()
    logging.info("pypika report rows=%d min_amt=%d", len(res), min_amt)
    out = {"min_amt": min_amt, "sql": sql, "rows": res}
    Path(out_path).write_text(json.dumps(out, sort_keys=True), encoding="utf-8")
    return out
""",
            "run", ["data/sales.csv", "data/report.json"],
            {
                "label": "low_threshold",
                "files": {"data/sales.csv": "region,amount,status\nus,120,paid\neu,60,paid\nus,40,refund\nap,80,paid\n"},
                "env": {"MIN_AMOUNT": "50"},
            },
            {
                "label": "high_threshold",
                "files": {"data/sales.csv": "region,amount,status\nus,120,paid\neu,60,paid\nus,40,refund\nap,80,paid\n"},
                "env": {"MIN_AMOUNT": "100"},
            },
            ["fs-io", "env-io", "sqlite3", "logging"],
        )

    # 2. coleifer/peewee + sqlite3 + fs + env
    pkg = _pkg("coleifer/peewee", "peewee")
    if pkg:
        _add_pair(
            "coleifer/peewee", "peewee", "search-db", "orm_inventory_sync", pkg,
            "_oss_probe/peewee_inventory.py",
            """import json
import logging
import os
from pathlib import Path
import peewee as pw

def run(in_path, out_path):
    reorder_floor = int(os.getenv("REORDER_FLOOR", "10"))
    items = json.loads(Path(in_path).read_text(encoding="utf-8"))
    db = pw.SqliteDatabase(":memory:")
    class Item(pw.Model):
        sku = pw.CharField(unique=True)
        qty = pw.IntegerField()
        price = pw.IntegerField()
        class Meta:
            database = db
    db.connect()
    db.create_tables([Item])
    for it in items:
        Item.create(sku=it["sku"], qty=it["qty"], price=it["price"])
    low = [
        {"sku": x.sku, "qty": x.qty}
        for x in Item.select().where(Item.qty < reorder_floor).order_by(Item.sku)
    ]
    total_val = sum(x.qty * x.price for x in Item.select())
    db.close()
    if low:
        logging.warning("low stock skus=%d floor=%d", len(low), reorder_floor)
    else:
        logging.info("all stock healthy floor=%d", reorder_floor)
    summary = {"reorder_floor": reorder_floor, "low_stock": low, "inventory_value": total_val}
    Path(out_path).write_text(json.dumps(summary, sort_keys=True), encoding="utf-8")
    return summary
""",
            "run", ["inv/items.json", "inv/summary.json"],
            {
                "label": "shortage_alert",
                "files": {"inv/items.json": json.dumps([{"sku": "A1", "qty": 4, "price": 20}, {"sku": "B2", "qty": 25, "price": 10}])},
                "env": {"REORDER_FLOOR": "10"},
            },
            {
                "label": "healthy_stock",
                "files": {"inv/items.json": json.dumps([{"sku": "A1", "qty": 15, "price": 20}, {"sku": "B2", "qty": 25, "price": 10}])},
                "env": {"REORDER_FLOOR": "10"},
            },
            ["fs-io", "env-io", "sqlite3", "logging"],
        )

    # 3. tobymao/sqlglot + sqlite3 + fs
    pkg = _pkg("tobymao/sqlglot", "sqlglot", max_files=140)
    if pkg:
        _add_pair(
            "tobymao/sqlglot", "sqlglot", "sql", "transpile_and_exec_sqlite", pkg,
            "_oss_probe/sqlglot_exec.py",
            """import json
import logging
import sqlite3
from pathlib import Path
import sqlglot

def run(sql_path, seed_path, out_path):
    pg_sql = Path(sql_path).read_text(encoding="utf-8").strip()
    seed = json.loads(Path(seed_path).read_text(encoding="utf-8"))
    sqlite_sql = sqlglot.transpile(pg_sql, read="postgres", write="sqlite")[0]
    conn = sqlite3.connect(":memory:")
    conn.execute("CREATE TABLE accounts (id INTEGER, name TEXT, balance INTEGER)")
    for row in seed:
        conn.execute("INSERT INTO accounts VALUES (?, ?, ?)", (row["id"], row["name"], row["balance"]))
    hits = [list(r) for r in conn.execute(sqlite_sql).fetchall()]
    conn.close()
    logging.info("transpiled and executed sql rows=%d", len(hits))
    res = {"sqlite_sql": sqlite_sql, "rows": hits}
    Path(out_path).write_text(json.dumps(res, sort_keys=True), encoding="utf-8")
    return res
""",
            "run", ["queries/top.sql", "data/accounts.json", "out/result.json"],
            {
                "label": "two_vip_matches",
                "files": {
                    "queries/top.sql": "SELECT id, COALESCE(name, 'anon') FROM accounts WHERE balance >= 100 ORDER BY id",
                    "data/accounts.json": json.dumps([{"id": 1, "name": "ada", "balance": 250}, {"id": 2, "name": None, "balance": 120}, {"id": 3, "name": "bob", "balance": 40}]),
                },
                "env": {},
            },
            {
                "label": "empty_result",
                "files": {
                    "queries/top.sql": "SELECT id, COALESCE(name, 'anon') FROM accounts WHERE balance >= 500 ORDER BY id",
                    "data/accounts.json": json.dumps([{"id": 1, "name": "ada", "balance": 250}, {"id": 2, "name": "bob", "balance": 40}]),
                },
                "env": {},
            },
            ["fs-io", "sqlite3", "logging"],
        )

    # 4. mchaput/whoosh + fs + logging
    pkg = _pkg("mchaput/whoosh", "whoosh", max_files=140)
    if pkg:
        _add_pair(
            "mchaput/whoosh", "whoosh", "search-db", "docs_dir_search", pkg,
            "_oss_probe/whoosh_docs.py",
            """import json
import logging
import os
from pathlib import Path
from whoosh.fields import Schema, TEXT, ID
from whoosh.filedb.filestore import RamStorage
from whoosh.qparser import QueryParser

def run(docs_dir, query_str, out_path):
    schema = Schema(name=ID(stored=True), body=TEXT)
    ix = RamStorage().create_index(schema)
    w = ix.writer()
    for fname in sorted(os.listdir(docs_dir)):
        if not fname.endswith(".txt"):
            continue
        text = Path(docs_dir + "/" + fname).read_text(encoding="utf-8")
        w.add_document(name=fname, body=text)
    w.commit()
    with ix.searcher() as s:
        q = QueryParser("body", ix.schema).parse(query_str)
        hits = [{"name": h["name"], "score": round(float(h.score), 4)} for h in s.search(q, limit=10)]
    logging.info("whoosh query=%s hits=%d", query_str, len(hits))
    res = {"query": query_str, "hits": hits}
    Path(out_path).write_text(json.dumps(res, sort_keys=True), encoding="utf-8")
    return res
""",
            "run", ["docs", "cache AND retry", "out/hits.json"],
            {
                "label": "matched_runbook",
                "files": {
                    "docs/a.txt": "Configure cache TTL and retry backoff for API gateway.",
                    "docs/b.txt": "Database schema migration checklist.",
                },
                "env": {},
            },
            {
                "label": "no_match",
                "files": {
                    "docs/a.txt": "Frontend stylesheet bundling guide.",
                    "docs/b.txt": "Database schema migration checklist.",
                },
                "env": {},
            },
            ["fs-io", "logging"],
        )

    # 5. yeraydiazdiaz/lunr.py + fs + logging
    pkg = _pkg("yeraydiazdiaz/lunr.py", "lunr")
    if pkg:
        _add_pair(
            "yeraydiazdiaz/lunr.py", "lunr", "search-db", "md_kb_search", pkg,
            "_oss_probe/lunr_kb.py",
            """import json
import logging
import os
from pathlib import Path
from lunr import lunr

def run(kb_dir, term, out_path):
    docs = []
    for fname in sorted(os.listdir(kb_dir)):
        if fname.endswith(".md"):
            body = Path(kb_dir + "/" + fname).read_text(encoding="utf-8")
            docs.append({"id": fname, "body": body})
    idx = lunr(ref="id", fields=("body",), documents=docs)
    hits = [{"ref": r["ref"], "score": round(r["score"], 4)} for r in idx.search(term)]
    logging.info("lunr indexed=%d hits=%d", len(docs), len(hits))
    res = {"indexed": len(docs), "hits": hits}
    Path(out_path).write_text(json.dumps(res, sort_keys=True), encoding="utf-8")
    return res
""",
            "run", ["kb", "circuit", "kb/search.json"],
            {
                "label": "circuit_doc_found",
                "files": {
                    "kb/resilience.md": "Use circuit breakers to isolate failing upstreams.",
                    "kb/deploy.md": "Blue green deployments with canary checks.",
                },
                "env": {},
            },
            {
                "label": "missing_topic",
                "files": {
                    "kb/deploy.md": "Blue green deployments with canary checks.",
                    "kb/auth.md": "Rotate OAuth signing keys every 30 days.",
                },
                "env": {},
            },
            ["fs-io", "logging"],
        )

    # 6. sqlalchemy/mako + fs + env
    pkg = _pkg("sqlalchemy/mako", "mako", companions=[("pallets/markupsafe", "markupsafe")])
    if pkg:
        _add_pair(
            "sqlalchemy/mako", "mako", "templates", "mako_render_release_notes", pkg,
            "_oss_probe/mako_notes.py",
            """import json
import os
from pathlib import Path
from mako.template import Template

def run(tpl_path, data_path, out_path):
    env_name = os.getenv("DEPLOY_ENV", "staging")
    tpl_src = Path(tpl_path).read_text(encoding="utf-8")
    data = json.loads(Path(data_path).read_text(encoding="utf-8"))
    rendered = Template(tpl_src).render(env=env_name, **data).strip()
    Path(out_path).write_text(rendered, encoding="utf-8")
    return {"env": env_name, "rendered": rendered}
""",
            "run", ["tpl/release.mako", "tpl/ctx.json", "out/release.txt"],
            {
                "label": "prod_release",
                "files": {
                    "tpl/release.mako": "Release ${version} [${env.upper()}]\n% for c in changes:\n- ${c}\n% endfor",
                    "tpl/ctx.json": json.dumps({"version": "2.4.0", "changes": ["Add retry", "Fix SQL"]}),
                },
                "env": {"DEPLOY_ENV": "prod"},
            },
            {
                "label": "canary_empty",
                "files": {
                    "tpl/release.mako": "Release ${version} [${env.upper()}]\n% for c in changes:\n- ${c}\n% endfor",
                    "tpl/ctx.json": json.dumps({"version": "2.4.1-rc1", "changes": ["Hotfix"]}),
                },
                "env": {"DEPLOY_ENV": "canary"},
            },
            ["fs-io", "env-io"],
        )

    # 7. jg-rp/liquid + fs + env
    pkg = _pkg("jg-rp/liquid", "liquid")
    if pkg:
        _add_pair(
            "jg-rp/liquid", "liquid", "templates", "liquid_invoice_render", pkg,
            "_oss_probe/liquid_inv.py",
            """import json
import os
from pathlib import Path
from liquid import Template

def run(tpl_path, order_path, out_path):
    currency = os.getenv("CURRENCY", "USD")
    tpl = Path(tpl_path).read_text(encoding="utf-8")
    order = json.loads(Path(order_path).read_text(encoding="utf-8"))
    total = sum(it["price"] * it["qty"] for it in order["items"])
    rendered = Template(tpl).render(currency=currency, total=total, **order).strip()
    Path(out_path).write_text(rendered, encoding="utf-8")
    return {"total": total, "currency": currency, "rendered": rendered}
""",
            "run", ["tpl/inv.liquid", "tpl/order.json", "out/inv.txt"],
            {
                "label": "usd_order",
                "files": {
                    "tpl/inv.liquid": "Customer: {{ customer | upcase }} | Total: {{ total }} {{ currency }}",
                    "tpl/order.json": json.dumps({"customer": "acme", "items": [{"price": 25, "qty": 2}, {"price": 10, "qty": 3}]}),
                },
                "env": {"CURRENCY": "USD"},
            },
            {
                "label": "eur_order",
                "files": {
                    "tpl/inv.liquid": "Customer: {{ customer | upcase }} | Total: {{ total }} {{ currency }}",
                    "tpl/order.json": json.dumps({"customer": "globex", "items": [{"price": 100, "qty": 1}]}),
                },
                "env": {"CURRENCY": "EUR"},
            },
            ["fs-io", "env-io"],
        )

    # 8. noahmorrison/chevron + fs + logging
    pkg = _pkg("noahmorrison/chevron", "chevron")
    if pkg:
        _add_pair(
            "noahmorrison/chevron", "chevron", "templates", "chevron_alert_digest", pkg,
            "_oss_probe/chevron_digest.py",
            """import json
import logging
from pathlib import Path
import chevron

def run(tpl_path, ctx_path, out_path):
    tpl = Path(tpl_path).read_text(encoding="utf-8")
    ctx = json.loads(Path(ctx_path).read_text(encoding="utf-8"))
    body = chevron.render(tpl, ctx).strip()
    logging.info("rendered alert digest chars=%d", len(body))
    Path(out_path).write_text(body, encoding="utf-8")
    return {"chars": len(body), "body": body}
""",
            "run", ["alerts/tpl.mustache", "alerts/data.json", "alerts/out.txt"],
            {
                "label": "active_incidents",
                "files": {
                    "alerts/tpl.mustache": "Incidents: {{#items}}[{{sev}}:{{svc}}] {{/items}}{{^items}}NONE{{/items}}",
                    "alerts/data.json": json.dumps({"items": [{"sev": "P1", "svc": "db"}, {"sev": "P2", "svc": "api"}]}),
                },
                "env": {},
            },
            {
                "label": "all_clear",
                "files": {
                    "alerts/tpl.mustache": "Incidents: {{#items}}[{{sev}}:{{svc}}] {{/items}}{{^items}}NONE{{/items}}",
                    "alerts/data.json": json.dumps({"items": []}),
                },
                "env": {},
            },
            ["fs-io", "logging"],
        )

    # 9. DiffSK/configobj + fs + env + logging
    pkg = _pkg("DiffSK/configobj", "configobj")
    if pkg:
        _add_pair(
            "DiffSK/configobj", "configobj", "data-config", "ini_override_merge", pkg,
            "_oss_probe/configobj_merge.py",
            """import json
import logging
import os
from pathlib import Path
from configobj import ConfigObj

def run(base_ini, override_ini, out_json):
    base = ConfigObj(Path(base_ini).read_text(encoding="utf-8").splitlines())
    if Path(override_ini).exists():
        over = ConfigObj(Path(override_ini).read_text(encoding="utf-8").splitlines())
        base.merge(over)
        logging.info("merged override ini %s", override_ini)
    else:
        logging.warning("no override ini %s", override_ini)
    env_port = os.getenv("PORT_OVERRIDE")
    if env_port:
        base.setdefault("server", {})["port"] = env_port
    res = base.dict()
    Path(out_json).write_text(json.dumps(res, sort_keys=True), encoding="utf-8")
    return res
""",
            "run", ["cfg/base.ini", "cfg/local.ini", "cfg/merged.json"],
            {
                "label": "with_override_and_env",
                "files": {
                    "cfg/base.ini": "[server]\nhost = 0.0.0.0\nport = 8000\nworkers = 2\n",
                    "cfg/local.ini": "[server]\nworkers = 8\n",
                },
                "env": {"PORT_OVERRIDE": "9090"},
            },
            {
                "label": "base_only",
                "files": {
                    "cfg/base.ini": "[server]\nhost = 0.0.0.0\nport = 8000\nworkers = 2\n",
                },
                "env": {},
            },
            ["fs-io", "env-io", "logging"],
        )

    # 10. hjson/hjson-py + fs + env
    pkg = _pkg("hjson/hjson-py", "hjson")
    if pkg:
        _add_pair(
            "hjson/hjson-py", "hjson", "data-config", "hjson_compile_manifest", pkg,
            "_oss_probe/hjson_build.py",
            """import json
import os
from pathlib import Path
import hjson

def run(in_hjson, out_json):
    raw = Path(in_hjson).read_text(encoding="utf-8")
    doc = dict(hjson.loads(raw))
    doc["env"] = os.getenv("TARGET_ENV", "dev")
    strict = hjson.dumpsJSON(doc, sort_keys=True)
    Path(out_json).write_text(strict, encoding="utf-8")
    return {"env": doc["env"], "keys": sorted(doc.keys()), "json": strict}
""",
            "run", ["cfg/app.hjson", "cfg/app.json"],
            {
                "label": "prod_cluster",
                "files": {"cfg/app.hjson": "# prod\n{\n  service: gateway\n  replicas: 4\n  tls: true\n}\n"},
                "env": {"TARGET_ENV": "prod"},
            },
            {
                "label": "dev_single",
                "files": {"cfg/app.hjson": "# dev\n{\n  service: gateway\n  replicas: 1\n  tls: false\n}\n"},
                "env": {},
            },
            ["fs-io", "env-io"],
        )

    # 11. wbolster/jsonlines + fs + logging
    pkg = _pkg("wbolster/jsonlines", "jsonlines")
    if pkg:
        _add_pair(
            "wbolster/jsonlines", "jsonlines", "data-config", "jsonl_audit_filter", pkg,
            "_oss_probe/jsonl_audit.py",
            """import io
import logging
from pathlib import Path
import jsonlines

def run(in_path, out_path, min_status):
    raw = Path(in_path).read_text(encoding="utf-8")
    errors = []
    total = 0
    with jsonlines.Reader(io.StringIO(raw)) as reader:
        for obj in reader:
            total += 1
            if int(obj.get("status", 200)) >= min_status:
                errors.append(obj)
    buf = io.StringIO()
    with jsonlines.Writer(buf, sort_keys=True) as writer:
        writer.write_all(errors)
    Path(out_path).write_text(buf.getvalue(), encoding="utf-8")
    logging.info("scanned=%d flagged=%d", total, len(errors))
    return {"total": total, "flagged": len(errors), "paths": [e["path"] for e in errors]}
""",
            "run", ["logs/access.jsonl", "logs/errors.jsonl", 500],
            {
                "label": "two_5xx",
                "files": {
                    "logs/access.jsonl": '{"path":"/ok","status":200}\n{"path":"/pay","status":502}\n{"path":"/auth","status":500}\n',
                },
                "env": {},
            },
            {
                "label": "zero_5xx",
                "files": {
                    "logs/access.jsonl": '{"path":"/ok","status":200}\n{"path":"/health","status":204}\n',
                },
                "env": {},
            },
            ["fs-io", "logging"],
        )

    # 12. stefankoegl/python-json-patch + fs + logging
    pkg = _pkg("stefankoegl/python-json-patch", "jsonpatch", companions=[("stefankoegl/python-json-pointer", "jsonpointer")])
    if pkg:
        _add_pair(
            "stefankoegl/python-json-patch", "jsonpatch", "data-config", "apply_cfg_patch", pkg,
            "_oss_probe/patch_cfg.py",
            """import json
import logging
from pathlib import Path
import jsonpatch

def run(cfg_path, patch_path, out_path):
    doc = json.loads(Path(cfg_path).read_text(encoding="utf-8"))
    ops = json.loads(Path(patch_path).read_text(encoding="utf-8"))
    try:
        patched = jsonpatch.apply_patch(doc, ops)
        Path(out_path).write_text(json.dumps(patched, sort_keys=True), encoding="utf-8")
        logging.info("applied %d jsonpatch ops", len(ops))
        return {"ok": True, "result": patched}
    except jsonpatch.JsonPatchException as exc:
        logging.error("jsonpatch rejected: %s", exc)
        return {"ok": False, "error": str(exc)}
""",
            "run", ["cfg/state.json", "cfg/patch.json", "cfg/next.json"],
            {
                "label": "patch_valid",
                "files": {
                    "cfg/state.json": json.dumps({"replicas": 2, "image": "app:v1"}),
                    "cfg/patch.json": json.dumps([{"op": "test", "path": "/replicas", "value": 2}, {"op": "replace", "path": "/image", "value": "app:v2"}]),
                },
                "env": {},
            },
            {
                "label": "patch_test_conflict",
                "files": {
                    "cfg/state.json": json.dumps({"replicas": 5, "image": "app:v1"}),
                    "cfg/patch.json": json.dumps([{"op": "test", "path": "/replicas", "value": 2}, {"op": "replace", "path": "/image", "value": "app:v2"}]),
                },
                "env": {},
            },
            ["fs-io", "logging"],
        )

    # 13. seperman/deepdiff + fs + logging
    pkg = _pkg("seperman/deepdiff", "deepdiff", companions=[("seperman/orderly-set", "orderly_set")])
    if pkg:
        _add_pair(
            "seperman/deepdiff", "deepdiff", "data-config", "snapshot_drift_audit", pkg,
            "_oss_probe/deepdiff_audit.py",
            """import json
import logging
from pathlib import Path
from deepdiff import DeepDiff

def run(expected_path, actual_path, report_path):
    exp = json.loads(Path(expected_path).read_text(encoding="utf-8"))
    act = json.loads(Path(actual_path).read_text(encoding="utf-8"))
    diff = DeepDiff(exp, act, ignore_order=True)
    drifted = bool(diff)
    if drifted:
        logging.warning("snapshot drift detected categories=%s", ",".join(sorted(diff.keys())))
    else:
        logging.info("snapshots match cleanly")
    summary = {"drifted": drifted, "categories": sorted(diff.keys())}
    Path(report_path).write_text(json.dumps(summary, sort_keys=True), encoding="utf-8")
    return summary
""",
            "run", ["snap/expected.json", "snap/actual.json", "snap/report.json"],
            {
                "label": "drift_found",
                "files": {
                    "snap/expected.json": json.dumps({"ports": [80, 443], "tls": {"min": "1.3"}}),
                    "snap/actual.json": json.dumps({"ports": [443, 80], "tls": {"min": "1.2"}}),
                },
                "env": {},
            },
            {
                "label": "no_drift",
                "files": {
                    "snap/expected.json": json.dumps({"ports": [80, 443], "tls": {"min": "1.3"}}),
                    "snap/actual.json": json.dumps({"ports": [443, 80], "tls": {"min": "1.3"}}),
                },
                "env": {},
            },
            ["fs-io", "logging"],
        )

    # 14. mahmoud/glom + fs
    pkg = _pkg("mahmoud/glom", "glom", companions=[("mahmoud/face", "face")])
    if pkg:
        _add_pair(
            "mahmoud/glom", "glom", "data-config", "glom_etl_extract", pkg,
            "_oss_probe/glom_etl.py",
            """import json
from pathlib import Path
from glom import glom, Coalesce

def run(in_path, out_path):
    raw = json.loads(Path(in_path).read_text(encoding="utf-8"))
    spec = {
        "cluster": "meta.name",
        "tier": Coalesce("meta.tier", default="standard"),
        "hosts": ("nodes", ["host"]),
        "total_cpu": ("nodes", ["cpu"], sum),
    }
    extracted = glom(raw, spec)
    Path(out_path).write_text(json.dumps(extracted, sort_keys=True), encoding="utf-8")
    return extracted
""",
            "run", ["etl/cluster.json", "etl/summary.json"],
            {
                "label": "explicit_tier",
                "files": {"etl/cluster.json": json.dumps({"meta": {"name": "us-prod", "tier": "gold"}, "nodes": [{"host": "n1", "cpu": 16}, {"host": "n2", "cpu": 16}]})},
                "env": {},
            },
            {
                "label": "default_tier",
                "files": {"etl/cluster.json": json.dumps({"meta": {"name": "dev-box"}, "nodes": [{"host": "d1", "cpu": 4}]})},
                "env": {},
            },
            ["fs-io"],
        )

    # 15. horejsek/python-fastjsonschema + fs + logging
    pkg = _pkg("horejsek/python-fastjsonschema", "fastjsonschema")
    if pkg:
        _add_pair(
            "horejsek/python-fastjsonschema", "fastjsonschema", "data-config", "schema_gate_dir", pkg,
            "_oss_probe/schema_gate.py",
            """import json
import logging
import os
from pathlib import Path
import fastjsonschema

def run(schema_path, payloads_dir, out_path):
    schema = json.loads(Path(schema_path).read_text(encoding="utf-8"))
    validate = fastjsonschema.compile(schema)
    passed, failed = [], []
    for fname in sorted(os.listdir(payloads_dir)):
        if not fname.endswith(".json"):
            continue
        doc = json.loads(Path(payloads_dir + "/" + fname).read_text(encoding="utf-8"))
        try:
            validate(doc)
            passed.append(fname)
        except fastjsonschema.JsonSchemaException as exc:
            failed.append({"file": fname, "error": exc.message})
            logging.warning("schema violation in %s: %s", fname, exc.message)
    res = {"passed": passed, "failed": failed}
    Path(out_path).write_text(json.dumps(res, sort_keys=True), encoding="utf-8")
    return res
""",
            "run", ["schemas/event.json", "events", "out/gate.json"],
            {
                "label": "one_invalid",
                "files": {
                    "schemas/event.json": json.dumps({"type": "object", "required": ["id", "count"], "properties": {"id": {"type": "string"}, "count": {"type": "integer", "minimum": 1}}}),
                    "events/e1.json": json.dumps({"id": "ev1", "count": 3}),
                    "events/e2.json": json.dumps({"id": "ev2", "count": 0}),
                },
                "env": {},
            },
            {
                "label": "all_valid",
                "files": {
                    "schemas/event.json": json.dumps({"type": "object", "required": ["id", "count"], "properties": {"id": {"type": "string"}, "count": {"type": "integer", "minimum": 1}}}),
                    "events/e1.json": json.dumps({"id": "ev1", "count": 3}),
                    "events/e2.json": json.dumps({"id": "ev2", "count": 9}),
                },
                "env": {},
            },
            ["fs-io", "logging"],
        )

    # 16. dpath-maintainers/dpath-python + fs
    pkg = _pkg("dpath-maintainers/dpath-python", "dpath")
    if pkg:
        _add_pair(
            "dpath-maintainers/dpath-python", "dpath", "data-config", "dpath_secret_redact", pkg,
            "_oss_probe/dpath_redact.py",
            """import json
from pathlib import Path
import dpath

def run(in_path, out_path):
    doc = json.loads(Path(in_path).read_text(encoding="utf-8"))
    n_tok = dpath.set(doc, "/**/token", "[REDACTED]")
    n_pwd = dpath.set(doc, "/**/password", "[REDACTED]")
    Path(out_path).write_text(json.dumps(doc, sort_keys=True), encoding="utf-8")
    return {"redacted": n_tok + n_pwd, "doc": doc}
""",
            "run", ["cfg/raw.json", "cfg/clean.json"],
            {
                "label": "two_secrets",
                "files": {"cfg/raw.json": json.dumps({"db": {"host": "pg", "password": "s3cr3t"}, "api": {"token": "tok_99"}})},
                "env": {},
            },
            {
                "label": "no_secrets",
                "files": {"cfg/raw.json": json.dumps({"db": {"host": "pg", "port": 5432}, "api": {"timeout": 30}})},
                "env": {},
            },
            ["fs-io"],
        )

    # 17. PyCQA/isort + fs + logging
    pkg = _pkg("PyCQA/isort", "isort", companions=[("python/mypy_extensions", "mypy_extensions")], max_files=140)
    if pkg:
        _add_pair(
            "PyCQA/isort", "isort", "ast-lint", "isort_check_dir", pkg,
            "_oss_probe/isort_scan.py",
            """import json
import logging
import os
from pathlib import Path
import isort

def run(src_dir, out_path):
    unsorted = []
    clean = []
    for fname in sorted(os.listdir(src_dir)):
        if not fname.endswith(".py"):
            continue
        p = Path(src_dir + "/" + fname)
        code = p.read_text(encoding="utf-8")
        fixed = isort.code(code)
        if fixed != code:
            unsorted.append(fname)
            p.write_text(fixed, encoding="utf-8")
            logging.warning("reformatted imports in %s", fname)
        else:
            clean.append(fname)
    res = {"unsorted": unsorted, "clean": clean}
    Path(out_path).write_text(json.dumps(res, sort_keys=True), encoding="utf-8")
    return res
""",
            "run", ["src", "src/isort_report.json"],
            {
                "label": "needs_sort",
                "files": {
                    "src/a.py": "import sys\nfrom app import z, a\nimport json\n\nx = 1\n",
                    "src/b.py": "import json\nimport os\n\ny = 2\n",
                },
                "env": {},
            },
            {
                "label": "already_sorted",
                "files": {
                    "src/a.py": "import json\nimport sys\n\nfrom app import a, z\n\nx = 1\n",
                    "src/b.py": "import json\nimport os\n\ny = 2\n",
                },
                "env": {},
            },
            ["fs-io", "logging"],
        )

    # 18. PyCQA/pycodestyle + fs + logging
    pkg = _pkg("PyCQA/pycodestyle", "pycodestyle")
    if pkg:
        _add_pair(
            "PyCQA/pycodestyle", "pycodestyle", "ast-lint", "pep8_dir_audit", pkg,
            "_oss_probe/pep8_audit.py",
            """import json
import logging
import os
from pathlib import Path
import pycodestyle

class ListReport(pycodestyle.BaseReport):
    def __init__(self, options):
        super().__init__(options)
        self.items = []
    def error(self, line_number, offset, text, check):
        code = super().error(line_number, offset, text, check)
        if code:
            self.items.append(f"{line_number}:{code}")
        return code

def run(src_dir, out_path):
    results = {}
    sg = pycodestyle.StyleGuide(reporter=ListReport, quiet=True, config_file=False)
    for fname in sorted(os.listdir(src_dir)):
        if not fname.endswith(".py"):
            continue
        lines = Path(src_dir + "/" + fname).read_text(encoding="utf-8").splitlines(keepends=True)
        rep = ListReport(sg.options)
        chk = pycodestyle.Checker(filename=None, lines=lines, options=sg.options, report=rep)
        chk.check_all()
        results[fname] = rep.items
        if rep.items:
            logging.warning("pep8 issues in %s: %d", fname, len(rep.items))
    Path(out_path).write_text(json.dumps(results, sort_keys=True), encoding="utf-8")
    return {"files": results, "total_issues": sum(len(v) for v in results.values())}
""",
            "run", ["pkg", "pkg/pep8.json"],
            {
                "label": "has_pep8_errors",
                "files": {"pkg/bad.py": "import os, sys\nx=1+2\n"},
                "env": {},
            },
            {
                "label": "clean_pep8",
                "files": {"pkg/good.py": "import os\n\nx = 1 + 2\n"},
                "env": {},
            },
            ["fs-io", "logging"],
        )

    # 19. davidhalter/parso + fs + logging
    pkg = _pkg("davidhalter/parso", "parso", max_files=140)
    if pkg:
        _add_pair(
            "davidhalter/parso", "parso", "ast-lint", "parso_syntax_gate", pkg,
            "_oss_probe/parso_gate.py",
            """import json
import logging
import os
from pathlib import Path
import parso

def run(src_dir, out_path):
    grammar = parso.load_grammar()
    report = {}
    for fname in sorted(os.listdir(src_dir)):
        if not fname.endswith(".py"):
            continue
        code = Path(src_dir + "/" + fname).read_text(encoding="utf-8")
        mod = grammar.parse(code)
        errs = [e.message for e in grammar.iter_errors(mod)]
        report[fname] = {"ok": len(errs) == 0, "funcs": [f.name.value for f in mod.iter_funcdefs()], "errors": errs}
        if errs:
            logging.error("syntax error in %s: %s", fname, errs[0])
    Path(out_path).write_text(json.dumps(report, sort_keys=True), encoding="utf-8")
    return {"all_ok": all(v["ok"] for v in report.values()), "report": report}
""",
            "run", ["src", "src/syntax.json"],
            {
                "label": "broken_syntax",
                "files": {
                    "src/ok.py": "def add(a, b):\n    return a + b\n",
                    "src/bad.py": "def broken(x, y:\n    return x\n",
                },
                "env": {},
            },
            {
                "label": "all_valid_syntax",
                "files": {
                    "src/ok.py": "def add(a, b):\n    return a + b\n",
                    "src/good.py": "def mul(x, y):\n    return x * y\n",
                },
                "env": {},
            },
            ["fs-io", "logging"],
        )

    # 20. berkerpeksag/astor + fs
    pkg = _pkg("berkerpeksag/astor", "astor")
    if pkg:
        _add_pair(
            "berkerpeksag/astor", "astor", "ast-lint", "astor_rewrite_const", pkg,
            "_oss_probe/astor_rewrite.py",
            """import ast
import os
from pathlib import Path
import astor

class DebugToggle(ast.NodeTransformer):
    def __init__(self, debug_val):
        self.debug_val = debug_val
    def visit_Assign(self, node):
        if len(node.targets) == 1 and isinstance(node.targets[0], ast.Name) and node.targets[0].id == "DEBUG":
            node.value = ast.Constant(value=self.debug_val)
        return node

def run(in_py, out_py):
    flag = os.getenv("SET_DEBUG", "false").lower() == "true"
    tree = ast.parse(Path(in_py).read_text(encoding="utf-8"))
    new_tree = DebugToggle(flag).visit(tree)
    regen = astor.to_source(new_tree).strip()
    Path(out_py).write_text(regen + "\\n", encoding="utf-8")
    return {"debug": flag, "regen": regen}
""",
            "run", ["app/settings.py", "app/settings_out.py"],
            {
                "label": "enable_debug",
                "files": {"app/settings.py": "DEBUG = False\nTIMEOUT = 30\n"},
                "env": {"SET_DEBUG": "true"},
            },
            {
                "label": "disable_debug",
                "files": {"app/settings.py": "DEBUG = True\nTIMEOUT = 30\n"},
                "env": {"SET_DEBUG": "false"},
            },
            ["fs-io", "env-io"],
        )

    # 21. mozilla/bleach + fs + logging
    pkg = _pkg("mozilla/bleach", "bleach", companions=[("gsnedders/python-webencodings", "webencodings")], max_files=140)
    if pkg:
        _add_pair(
            "mozilla/bleach", "bleach", "html-css", "bleach_scrub_html", pkg,
            "_oss_probe/bleach_scrub.py",
            """import logging
from pathlib import Path
import bleach

def run(in_html, out_html):
    raw = Path(in_html).read_text(encoding="utf-8")
    clean = bleach.clean(raw, tags=["p", "b", "i", "a", "ul", "li"], attributes={"a": ["href"]}, strip=True)
    changed = clean != raw
    if changed:
        logging.warning("sanitized unsafe markup in %s", in_html)
    else:
        logging.info("markup already clean in %s", in_html)
    Path(out_html).write_text(clean, encoding="utf-8")
    return {"changed": changed, "clean": clean}
""",
            "run", ["web/comment.html", "web/safe.html"],
            {
                "label": "xss_stripped",
                "files": {"web/comment.html": "<p>Hi <b>there</b><script>steal()</script></p>"},
                "env": {},
            },
            {
                "label": "clean_html",
                "files": {"web/comment.html": "<p>Hi <b>there</b></p>"},
                "env": {},
            },
            ["fs-io", "logging"],
        )

    # 22. html5lib/html5lib-python + fs
    pkg = _pkg("html5lib/html5lib-python", "html5lib", companions=[("gsnedders/python-webencodings", "webencodings"), ("benjaminp/six", "six")], max_files=140)
    if pkg:
        _add_pair(
            "html5lib/html5lib-python", "html5lib", "html-css", "html5lib_normalize_file", pkg,
            "_oss_probe/html5_norm.py",
            """from pathlib import Path
import html5lib

def run(in_html, out_html):
    raw = Path(in_html).read_text(encoding="utf-8")
    doc = html5lib.parse(raw)
    tags = [el.tag.split("}")[-1] for el in doc.iter()]
    out = html5lib.serialize(doc)
    Path(out_html).write_text(out, encoding="utf-8")
    return {"tag_count": len(tags), "tags": tags, "serialized": out}
""",
            "run", ["pages/raw.html", "pages/norm.html"],
            {
                "label": "broken_nesting",
                "files": {"pages/raw.html": "<div><p>Hello <b>world</div>"},
                "env": {},
            },
            {
                "label": "table_fragment",
                "files": {"pages/raw.html": "<table><tr><td>X<td>Y</table>"},
                "env": {},
            },
            ["fs-io"],
        )

    # 23. Kozea/tinycss2 + fs + logging
    pkg = _pkg("Kozea/tinycss2", "tinycss2", companions=[("gsnedders/python-webencodings", "webencodings")])
    if pkg:
        _add_pair(
            "Kozea/tinycss2", "tinycss2", "html-css", "css_audit_important", pkg,
            "_oss_probe/css_audit.py",
            """import json
import logging
from pathlib import Path
import tinycss2

def run(css_path, out_path):
    raw = Path(css_path).read_text(encoding="utf-8")
    rules = tinycss2.parse_stylesheet(raw, skip_comments=True, skip_whitespace=True)
    important_props = []
    rule_count = 0
    for r in rules:
        if r.type == "qualified-rule":
            rule_count += 1
            decls = tinycss2.parse_declaration_list(r.content, skip_comments=True, skip_whitespace=True)
            for d in decls:
                if d.type == "declaration" and d.important:
                    important_props.append(d.lower_name)
    if important_props:
        logging.warning("found !important declarations: %s", ",".join(important_props))
    res = {"rule_count": rule_count, "important_props": important_props}
    Path(out_path).write_text(json.dumps(res, sort_keys=True), encoding="utf-8")
    return res
""",
            "run", ["styles/app.css", "styles/audit.json"],
            {
                "label": "has_important",
                "files": {"styles/app.css": ".btn { color: red !important; padding: 4px; } h1 { margin: 0; }"},
                "env": {},
            },
            {
                "label": "clean_css",
                "files": {"styles/app.css": ".btn { color: blue; padding: 4px; } h1 { margin: 0; }"},
                "env": {},
            },
            ["fs-io", "logging"],
        )

    # 24. kurtmckee/feedparser + http.request + fs + logging
    pkg = _pkg("kurtmckee/feedparser", "feedparser", companions=[("kurtmckee/sgmllib3k", "sgmllib")])
    if pkg:
        _add_pair(
            "kurtmckee/feedparser", "feedparser", "html-css", "http_rss_digest", pkg,
            "_oss_probe/rss_fetch.py",
            """import json
import logging
import urllib.error
import urllib.request
from pathlib import Path
import feedparser

def run(feed_url, out_path):
    try:
        with urllib.request.urlopen(feed_url) as resp:
            xml = resp.read().decode("utf-8")
        parsed = feedparser.parse(xml)
        items = [{"title": e.get("title", ""), "link": e.get("link", "")} for e in parsed.entries]
        res = {"ok": True, "feed_title": parsed.feed.get("title", ""), "count": len(items), "items": items}
        Path(out_path).write_text(json.dumps(res, sort_keys=True), encoding="utf-8")
        logging.info("fetched feed entries=%d", len(items))
        return res
    except urllib.error.HTTPError as exc:
        logging.error("feed fetch failed status=%d", exc.code)
        return {"ok": False, "status": exc.code}
""",
            "run", [f"{base_url}/rss.xml", "out/feed.json"],
            {
                "label": "feed_200",
                "files": {},
                "env": {},
                "http_routes": {"/rss.xml": (200, {"Content-Type": "application/xml"}, b'<?xml version="1.0"?><rss version="2.0"><channel><title>Eng Blog</title><item><title>Wave3</title><link>https://ex.io/w3</link></item></channel></rss>')},
            },
            {
                "label": "feed_503",
                "files": {},
                "env": {},
                "http_routes": {"/rss.xml": (503, {"Content-Type": "text/plain"}, b"unavailable")},
            },
            ["http-io", "fs-io", "logging"],
        )

    # 25. Alir3z4/html2text + http.request + fs
    pkg = _pkg("Alir3z4/html2text", "html2text")
    if pkg:
        _add_pair(
            "Alir3z4/html2text", "html2text", "html-css", "fetch_html_to_md", pkg,
            "_oss_probe/html2md_http.py",
            """import urllib.error
import urllib.request
from pathlib import Path
import html2text

def run(url, out_md):
    conv = html2text.HTML2Text()
    conv.body_width = 0
    try:
        with urllib.request.urlopen(url) as resp:
            raw = resp.read().decode("utf-8")
        md = conv.handle(raw).strip()
        Path(out_md).write_text(md, encoding="utf-8")
        return {"ok": True, "md": md}
    except urllib.error.HTTPError as exc:
        fallback = conv.handle(f"<p>Error {exc.code}</p>").strip()
        return {"ok": False, "status": exc.code, "fallback": fallback}
""",
            "run", [f"{base_url}/doc.html", "out/doc.md"],
            {
                "label": "page_ok",
                "files": {},
                "env": {},
                "http_routes": {"/doc.html": (200, {"Content-Type": "text/html"}, b"<h1>Spec</h1><p>Use <b>Python</b>.</p>")},
            },
            {
                "label": "page_404",
                "files": {},
                "env": {},
                "http_routes": {"/doc.html": (404, {"Content-Type": "text/plain"}, b"not found")},
            },
            ["http-io", "fs-io"],
        )

    # 26. jd/tenacity + http.request + logging (sequential 503->503->200 vs 400!)
    pkg = _pkg("jd/tenacity", "tenacity")
    if pkg:
        _add_pair(
            "jd/tenacity", "tenacity", "resilience", "tenacity_http_retry", pkg,
            "_oss_probe/tenacity_http.py",
            """import json
import logging
import urllib.error
import urllib.request
from tenacity import Retrying, stop_after_attempt, wait_none, retry_if_exception

def _is_retryable(exc):
    return isinstance(exc, urllib.error.HTTPError) and exc.code >= 500

def run(url):
    attempts = []
    def fetch():
        attempts.append(len(attempts) + 1)
        with urllib.request.urlopen(url) as resp:
            return json.loads(resp.read().decode("utf-8"))
    retrying = Retrying(
        stop=stop_after_attempt(4),
        wait=wait_none(),
        retry=retry_if_exception(_is_retryable),
        reraise=True,
    )
    try:
        data = retrying(fetch)
        logging.info("http succeeded on attempt %d", len(attempts))
        return {"ok": True, "attempts": len(attempts), "data": data}
    except urllib.error.HTTPError as exc:
        logging.error("http failed status=%d attempts=%d", exc.code, len(attempts))
        return {"ok": False, "status": exc.code, "attempts": len(attempts)}
""",
            "run", [f"{base_url}/flaky"],
            {
                "label": "retry_503_then_200",
                "files": {},
                "env": {},
                "http_routes": {
                    "/flaky": [
                        (503, {"Content-Type": "text/plain"}, b"busy-1"),
                        (503, {"Content-Type": "text/plain"}, b"busy-2"),
                        (200, {"Content-Type": "application/json"}, b'{"status":"ready","v":3}'),
                    ]
                },
            },
            {
                "label": "fail_fast_400",
                "files": {},
                "env": {},
                "http_routes": {
                    "/flaky": [(400, {"Content-Type": "text/plain"}, b"bad_request")],
                },
            },
            ["http-io", "logging"],
        )

    # 27. litl/backoff + http.request + logging
    pkg = _pkg("litl/backoff", "backoff")
    if pkg:
        _add_pair(
            "litl/backoff", "backoff", "resilience", "backoff_http_client", pkg,
            "_oss_probe/backoff_http.py",
            """import json
import logging
import urllib.error
import urllib.request
import backoff

def _zero_wait():
    while True:
        yield 0

def _giveup(exc):
    return isinstance(exc, urllib.error.HTTPError) and exc.code < 500

def run(url):
    tries = [0]
    @backoff.on_exception(_zero_wait, urllib.error.HTTPError, max_tries=3, giveup=_giveup, jitter=None)
    def get_json():
        tries[0] += 1
        with urllib.request.urlopen(url) as resp:
            return json.loads(resp.read().decode("utf-8"))
    try:
        body = get_json()
        logging.info("backoff succeeded tries=%d", tries[0])
        return {"ok": True, "tries": tries[0], "body": body}
    except urllib.error.HTTPError as exc:
        logging.warning("backoff aborted status=%d tries=%d", exc.code, tries[0])
        return {"ok": False, "status": exc.code, "tries": tries[0]}
""",
            "run", [f"{base_url}/job"],
            {
                "label": "recovers_after_502",
                "files": {},
                "env": {},
                "http_routes": {
                    "/job": [
                        (502, {"Content-Type": "text/plain"}, b"bad gw"),
                        (200, {"Content-Type": "application/json"}, b'{"job":"done"}'),
                    ]
                },
            },
            {
                "label": "exhausts_503",
                "files": {},
                "env": {},
                "http_routes": {
                    "/job": [(503, {"Content-Type": "text/plain"}, b"down")],
                },
            },
            ["http-io", "logging"],
        )

    # 28. danielfm/pybreaker + http.request + logging
    pkg = _pkg("danielfm/pybreaker", "pybreaker")
    if pkg:
        _add_pair(
            "danielfm/pybreaker", "pybreaker", "resilience", "circuit_breaker_http", pkg,
            "_oss_probe/breaker_http.py",
            """import logging
import urllib.error
import urllib.request
import pybreaker

def run(url, calls_n):
    cb = pybreaker.CircuitBreaker(fail_max=2, reset_timeout=60)
    outcomes = []
    def hit():
        with urllib.request.urlopen(url) as resp:
            return resp.read().decode("utf-8")
    for _ in range(calls_n):
        try:
            txt = cb.call(hit)
            outcomes.append({"ok": True, "body": txt, "state": cb.current_state})
        except pybreaker.CircuitBreakerError:
            logging.warning("circuit open; short-circuited call")
            outcomes.append({"ok": False, "err": "open", "state": cb.current_state})
        except urllib.error.HTTPError as exc:
            logging.error("upstream error status=%d", exc.code)
            outcomes.append({"ok": False, "err": exc.code, "state": cb.current_state})
    return {"final_state": cb.current_state, "outcomes": outcomes}
""",
            "run", [f"{base_url}/upstream", 4],
            {
                "label": "trips_open_on_500",
                "files": {},
                "env": {},
                "http_routes": {"/upstream": (500, {"Content-Type": "text/plain"}, b"boom")},
            },
            {
                "label": "stays_closed_200",
                "files": {},
                "env": {},
                "http_routes": {"/upstream": (200, {"Content-Type": "text/plain"}, b"pong")},
            },
            ["http-io", "logging"],
        )

    # 29. alisaifee/limits + env + fs + logging
    pkg = _pkg("alisaifee/limits", "limits")
    if pkg:
        _add_pair(
            "alisaifee/limits", "limits", "resilience", "api_quota_gate", pkg,
            "_oss_probe/limits_gate.py",
            """import json
import logging
import os
from pathlib import Path
from limits import parse
from limits.storage import MemoryStorage
from limits.strategies import FixedWindowRateLimiter

def run(req_path, out_path):
    rule = os.getenv("RATE_LIMIT", "2/minute")
    item = parse(rule)
    limiter = FixedWindowRateLimiter(MemoryStorage())
    reqs = json.loads(Path(req_path).read_text(encoding="utf-8"))
    accepted, rejected = [], []
    for r in reqs:
        if limiter.hit(item, r["tenant"]):
            accepted.append(r["id"])
        else:
            rejected.append(r["id"])
            logging.warning("rate limited req=%s tenant=%s", r["id"], r["tenant"])
    res = {"rule": rule, "accepted": accepted, "rejected": rejected}
    Path(out_path).write_text(json.dumps(res, sort_keys=True), encoding="utf-8")
    return res
""",
            "run", ["api/reqs.json", "api/gate.json"],
            {
                "label": "strict_2_per_min",
                "files": {"api/reqs.json": json.dumps([{"id": "r1", "tenant": "t1"}, {"id": "r2", "tenant": "t1"}, {"id": "r3", "tenant": "t1"}, {"id": "r4", "tenant": "t2"}])},
                "env": {"RATE_LIMIT": "2/minute"},
            },
            {
                "label": "generous_5_per_min",
                "files": {"api/reqs.json": json.dumps([{"id": "r1", "tenant": "t1"}, {"id": "r2", "tenant": "t1"}, {"id": "r3", "tenant": "t1"}, {"id": "r4", "tenant": "t2"}])},
                "env": {"RATE_LIMIT": "5/minute"},
            },
            ["fs-io", "env-io", "logging"],
        )

    # 30. hynek/structlog + env + fs + platform.log
    pkg = _pkg("hynek/structlog", "structlog")
    if pkg:
        _add_pair(
            "hynek/structlog", "structlog", "workflows", "structlog_audit_sink", pkg,
            "_oss_probe/structlog_sink.py",
            """import json
import logging
import os
from pathlib import Path
import structlog

def run(events_path, out_path):
    env_tag = os.getenv("SERVICE_ENV", "dev")
    events = json.loads(Path(events_path).read_text(encoding="utf-8"))
    lines = []
    def sink(_logger, method_name, event_dict):
        lines.append(event_dict)
        if method_name == "error":
            logging.error("structured_error %s", event_dict)
        raise structlog.DropEvent
    log = structlog.wrap_logger(
        None,
        processors=[
            structlog.processors.add_log_level,
            structlog.processors.JSONRenderer(sort_keys=True),
            sink,
        ],
    ).bind(env=env_tag)
    for ev in events:
        getattr(log, ev["level"])(ev["event"], code=ev["code"])
    Path(out_path).write_text("\\n".join(lines), encoding="utf-8")
    return {"env": env_tag, "count": len(lines), "lines": lines}
""",
            "run", ["ev/input.json", "ev/out.jsonl"],
            {
                "label": "prod_with_error",
                "files": {"ev/input.json": json.dumps([{"level": "info", "event": "start", "code": 0}, {"level": "error", "event": "db_fail", "code": 500}])},
                "env": {"SERVICE_ENV": "prod"},
            },
            {
                "label": "dev_info_only",
                "files": {"ev/input.json": json.dumps([{"level": "info", "event": "start", "code": 0}])},
                "env": {"SERVICE_ENV": "dev"},
            },
            ["fs-io", "env-io", "logging"],
        )

    # 31. kiorky/croniter + platform.time + fs
    pkg = _pkg("kiorky/croniter", "croniter")
    if pkg:
        _add_pair(
            "kiorky/croniter", "croniter", "date-time", "cron_next_due_jobs", pkg,
            "_oss_probe/cron_due.py",
            """import json
import time
from datetime import datetime, timezone
from pathlib import Path
from croniter import croniter

def run(jobs_path, window_sec, out_path):
    now_ts = time.time()
    base = datetime.fromtimestamp(now_ts, tz=timezone.utc)
    jobs = json.loads(Path(jobs_path).read_text(encoding="utf-8"))
    due = []
    for j in jobs:
        nxt = croniter(j["expr"], base).get_next(float)
        delta = round(nxt - now_ts, 2)
        if delta <= window_sec:
            due.append({"name": j["name"], "in_sec": delta})
    res = {"now": now_ts, "due": due}
    Path(out_path).write_text(json.dumps(res, sort_keys=True), encoding="utf-8")
    return res
""",
            "run", ["cron/jobs.json", 600, "cron/due.json"],
            {
                "label": "frequent_job_due",
                "files": {"cron/jobs.json": json.dumps([{"name": "heartbeat", "expr": "*/5 * * * *"}, {"name": "nightly", "expr": "0 3 * * *"}])},
                "env": {},
            },
            {
                "label": "no_jobs_in_window",
                "files": {"cron/jobs.json": json.dumps([{"name": "nightly", "expr": "0 3 * * *"}, {"name": "weekly", "expr": "0 4 * * 0"}])},
                "env": {},
            },
            ["fs-io", "time-io"],
        )

    # 32. agronholm/cbor2 + fs (readBytes/writeBytes)
    pkg = _pkg("agronholm/cbor2", "cbor2")
    if pkg:
        _add_pair(
            "agronholm/cbor2", "cbor2", "binary-codec", "cbor_binary_packet_store", pkg,
            "_oss_probe/cbor_store.py",
            """import io
import json
from pathlib import Path
from cbor2._encoder import CBOREncoder
from cbor2._decoder import CBORDecoder

def run(in_json, bin_path):
    payload = json.loads(Path(in_json).read_text(encoding="utf-8"))
    buf = io.BytesIO()
    CBOREncoder(buf, canonical=True).encode(payload)
    raw = buf.getvalue()
    Path(bin_path).write_bytes(raw)
    re_raw = Path(bin_path).read_bytes()
    decoded = CBORDecoder(io.BytesIO(re_raw)).decode()
    return {"bytes": len(re_raw), "hex": re_raw.hex(), "decoded": decoded}
""",
            "run", ["pkt/in.json", "pkt/out.cbor"],
            {
                "label": "telemetry_pkt",
                "files": {"pkt/in.json": json.dumps({"sensor": "s1", "vals": [10, 20, 30], "ok": True})},
                "env": {},
            },
            {
                "label": "alert_pkt",
                "files": {"pkt/in.json": json.dumps({"sensor": "s9", "alert": "overheat", "temp": 95})},
                "env": {},
            },
            ["fs-io", "binary-io"],
        )

    # 33. rspeer/python-ftfy + fs + logging
    pkg = _pkg("rspeer/python-ftfy", "ftfy", companions=[("jquast/wcwidth", "wcwidth")])
    if pkg:
        _add_pair(
            "rspeer/python-ftfy", "ftfy", "text-nlp", "ftfy_repair_text_file", pkg,
            "_oss_probe/ftfy_repair.py",
            """import logging
from pathlib import Path
import ftfy

def run(in_txt, out_txt):
    raw = Path(in_txt).read_text(encoding="utf-8")
    fixed, plan = ftfy.fix_and_explain(raw)
    steps = [p[0] for p in plan]
    if steps:
        logging.info("repaired mojibake steps=%s", ",".join(steps))
    Path(out_txt).write_text(fixed, encoding="utf-8")
    return {"changed": fixed != raw, "steps": steps, "fixed": fixed}
""",
            "run", ["text/input.txt", "text/fixed.txt"],
            {
                "label": "corrupted_utf8",
                "files": {"text/input.txt": "CafÃ© &amp; CrÃ¨me âœ”"},
                "env": {},
            },
            {
                "label": "already_clean",
                "files": {"text/input.txt": "Clean ASCII summary"},
                "env": {},
            },
            ["fs-io", "logging"],
        )

    # 34. facelessuser/wcmatch + fs + shell.exec (git ls-files!)
    pkg = _pkg("facelessuser/wcmatch", "wcmatch", companions=[("facelessuser/bracex", "bracex")])
    if pkg:
        _add_pair(
            "facelessuser/wcmatch", "wcmatch", "packaging-deps", "wcmatch_git_filter", pkg,
            "_oss_probe/wcmatch_git.py",
            """import logging
import subprocess
from pathlib import Path
from wcmatch import glob

def run(rules_path):
    patterns = [ln.strip() for ln in Path(rules_path).read_text(encoding="utf-8").splitlines() if ln.strip()]
    cp = subprocess.run(["git", "ls-files"], capture_output=True, text=True, check=True)
    tracked = sorted(ln.strip() for ln in cp.stdout.splitlines() if ln.strip())
    flags = glob.GLOBSTAR | glob.BRACE | glob.NEGATE
    matched = [f for f in tracked if glob.globmatch(f, patterns, flags=flags)]
    logging.info("git tracked=%d matched=%d", len(tracked), len(matched))
    return {"tracked": tracked, "matched": matched}
""",
            "run", [".release-include"],
            {
                "label": "py_without_tests",
                "files": {
                    ".release-include": "src/**/*.py\n!**/test_*.py\n",
                    "src/core.py": "x = 1\n",
                    "src/test_core.py": "assert True\n",
                    "README.md": "# hi\n",
                },
                "init_git": True,
                "env": {},
            },
            {
                "label": "docs_only",
                "files": {
                    ".release-include": "**/*.md\n",
                    "src/core.py": "x = 1\n",
                    "README.md": "# hi\n",
                },
                "init_git": True,
                "env": {},
            },
            ["fs-io", "shell-exec", "logging"],
        )

    # 35. pyauth/pyotp + env + platform.time + logging
    pkg = _pkg("pyauth/pyotp", "pyotp")
    if pkg:
        _add_pair(
            "pyauth/pyotp", "pyotp", "crypto-auth", "totp_mfa_verify", pkg,
            "_oss_probe/totp_auth.py",
            """import logging
import os
import time
import pyotp

def run(submitted_code):
    secret = os.getenv("MFA_SECRET", "JBSWY3DPEHPK3PXP")
    now = int(time.time())
    totp = pyotp.TOTP(secret)
    expected = totp.at(now)
    ok = totp.verify(submitted_code, for_time=now)
    if ok:
        logging.info("mfa verified at ts=%d", now)
    else:
        logging.warning("mfa rejected at ts=%d", now)
    return {"verified": ok, "ts": now, "matches_expected": submitted_code == expected}
""",
            "run", ["287836"],
            {
                "label": "valid_secret",
                "files": {},
                "env": {"MFA_SECRET": "JBSWY3DPEHPK3PXP"},
            },
            {
                "label": "wrong_secret",
                "files": {},
                "env": {"MFA_SECRET": "GEZDGNBVGY3TQOJQ"},
            },
            ["env-io", "time-io", "logging"],
        )

    # 36. pytransitions/transitions + fs + logging
    pkg = _pkg("pytransitions/transitions", "transitions", companions=[("benjaminp/six", "six")])
    if pkg:
        _add_pair(
            "pytransitions/transitions", "transitions", "workflows", "fsm_deploy_gate", pkg,
            "_oss_probe/fsm_deploy.py",
            """import json
import logging
from pathlib import Path
from transitions import Machine

class Deployment:
    def __init__(self, tests_ok):
        self.tests_ok = tests_ok
    def can_promote(self):
        return self.tests_ok

def run(state_path, out_path):
    cfg = json.loads(Path(state_path).read_text(encoding="utf-8"))
    dep = Deployment(bool(cfg.get("tests_ok")))
    Machine(
        model=dep,
        states=["built", "staged", "live", "rolled_back"],
        transitions=[
            {"trigger": "stage", "source": "built", "dest": "staged"},
            {"trigger": "promote", "source": "staged", "dest": "live", "conditions": "can_promote"},
            {"trigger": "rollback", "source": ["staged", "live"], "dest": "rolled_back"},
        ],
        initial="built",
    )
    steps = []
    for act in cfg.get("actions", []):
        ok = getattr(dep, act)()
        steps.append({"action": act, "ok": ok, "state": dep.state})
    logging.info("deploy final_state=%s", dep.state)
    res = {"final_state": dep.state, "steps": steps}
    Path(out_path).write_text(json.dumps(res, sort_keys=True), encoding="utf-8")
    return res
""",
            "run", ["deploy/plan.json", "deploy/result.json"],
            {
                "label": "promote_live",
                "files": {"deploy/plan.json": json.dumps({"tests_ok": True, "actions": ["stage", "promote"]})},
                "env": {},
            },
            {
                "label": "blocked_then_rollback",
                "files": {"deploy/plan.json": json.dumps({"tests_ok": False, "actions": ["stage", "promote", "rollback"]})},
                "env": {},
            },
            ["fs-io", "logging"],
        )

    # 37. jazzband/prettytable + fs
    pkg = _pkg("jazzband/prettytable", "prettytable", companions=[("jquast/wcwidth", "wcwidth")])
    if pkg:
        _add_pair(
            "jazzband/prettytable", "prettytable", "cli-tables", "csv_to_ascii_report", pkg,
            "_oss_probe/table_report.py",
            """import csv
import io
from pathlib import Path
from prettytable import PrettyTable

def run(csv_path, out_txt):
    rows = list(csv.reader(io.StringIO(Path(csv_path).read_text(encoding="utf-8"))))
    t = PrettyTable(rows[0])
    for r in rows[1:]:
        t.add_row(r)
    rendered = t.get_string()
    Path(out_txt).write_text(rendered, encoding="utf-8")
    return {"row_count": len(rows) - 1, "table": rendered}
""",
            "run", ["metrics/svc.csv", "metrics/table.txt"],
            {
                "label": "three_services",
                "files": {"metrics/svc.csv": "svc,rps,err\nauth,400,0\nsearch,180,2\nbill,95,0\n"},
                "env": {},
            },
            {
                "label": "one_service",
                "files": {"metrics/svc.csv": "svc,rps,err\nhealth,1000,0\n"},
                "env": {},
            },
            ["fs-io"],
        )

    # 38. niklasf/python-chess + fs + logging
    pkg = _pkg("niklasf/python-chess", "chess")
    if pkg:
        _add_pair(
            "niklasf/python-chess", "chess", "algorithms-games", "chess_moves_verify", pkg,
            "_oss_probe/chess_file.py",
            """import json
import logging
from pathlib import Path
import chess

def run(moves_path, out_path):
    moves = [m.strip() for m in Path(moves_path).read_text(encoding="utf-8").split() if m.strip()]
    board = chess.Board()
    played = []
    for san in moves:
        try:
            mv = board.push_san(san)
            played.append(mv.uci())
        except ValueError:
            logging.error("illegal chess move: %s", san)
            return {"ok": False, "illegal": san, "played": played}
    res = {"ok": True, "played": played, "checkmate": board.is_checkmate(), "fen": board.fen()}
    Path(out_path).write_text(json.dumps(res, sort_keys=True), encoding="utf-8")
    return res
""",
            "run", ["game/moves.txt", "game/state.json"],
            {
                "label": "scholars_mate",
                "files": {"game/moves.txt": "e4 e5 Qh5 Nc6 Bc4 Nf6 Qxf7#"},
                "env": {},
            },
            {
                "label": "illegal_move",
                "files": {"game/moves.txt": "e4 e5 Ke3"},
                "env": {},
            },
            ["fs-io", "logging"],
        )

    # 39. py-pdf/pypdf + fs (binary PDF writeBytes/readBytes)
    pkg = _pkg("py-pdf/pypdf", "pypdf", max_files=140)
    if pkg:
        _add_pair(
            "py-pdf/pypdf", "pypdf", "document-media", "pdf_metadata_pipeline", pkg,
            "_oss_probe/pdf_pipe.py",
            """import io
import json
from pathlib import Path
from pypdf import PdfWriter, PdfReader

def run(spec_path, pdf_path):
    spec = json.loads(Path(spec_path).read_text(encoding="utf-8"))
    w = PdfWriter()
    for sz in spec["pages"]:
        w.add_blank_page(width=sz[0], height=sz[1])
    w.add_metadata({"/Title": spec["title"]})
    buf = io.BytesIO()
    w.write(buf)
    Path(pdf_path).write_bytes(buf.getvalue())
    raw = Path(pdf_path).read_bytes()
    r = PdfReader(io.BytesIO(raw))
    return {"bytes": len(raw), "pages": len(r.pages), "title": str(r.metadata.title)}
""",
            "run", ["doc/spec.json", "doc/out.pdf"],
            {
                "label": "two_page_letter",
                "files": {"doc/spec.json": json.dumps({"title": "Audit", "pages": [[612, 792], [612, 792]]})},
                "env": {},
            },
            {
                "label": "single_a4",
                "files": {"doc/spec.json": json.dumps({"title": "Receipt", "pages": [[595, 842]]})},
                "env": {},
            },
            ["fs-io", "binary-io"],
        )

    # 40. drj11/pypng + fs (binary PNG writeBytes/readBytes)
    pkg = _pkg("drj11/pypng", "png")
    if pkg:
        _add_pair(
            "drj11/pypng", "png", "document-media", "png_bitmap_roundtrip", pkg,
            "_oss_probe/png_pipe.py",
            """import io
import json
from pathlib import Path
import png

def run(grid_path, png_path):
    rows = json.loads(Path(grid_path).read_text(encoding="utf-8"))
    buf = io.BytesIO()
    png.Writer(width=len(rows[0]), height=len(rows), greyscale=True, bitdepth=8).write(buf, rows)
    Path(png_path).write_bytes(buf.getvalue())
    raw = Path(png_path).read_bytes()
    w, h, px, _info = png.Reader(bytes=raw).read()
    decoded = [list(r) for r in px]
    return {"w": w, "h": h, "bytes": len(raw), "exact": decoded == rows}
""",
            "run", ["img/grid.json", "img/out.png"],
            {
                "label": "checker_3x4",
                "files": {"img/grid.json": json.dumps([[0, 255, 0, 255], [255, 0, 255, 0], [0, 255, 0, 255]])},
                "env": {},
            },
            {
                "label": "solid_2x2",
                "files": {"img/grid.json": json.dumps([[128, 128], [128, 128]])},
                "env": {},
            },
            ["fs-io", "binary-io"],
        )

    # 41. sarugaku/resolvelib + fs + logging
    pkg = _pkg("sarugaku/resolvelib", "resolvelib")
    if pkg:
        _add_pair(
            "sarugaku/resolvelib", "resolvelib", "packaging-deps", "lockfile_resolver", pkg,
            "_oss_probe/resolve_lock.py",
            """import json
import logging
from pathlib import Path
from resolvelib import AbstractProvider, BaseReporter, Resolver, ResolutionImpossible

class Provider(AbstractProvider):
    def __init__(self, cat):
        self.cat = cat
    def identify(self, x):
        return x[0]
    def get_preference(self, identifier, resolutions, candidates, information, backtrack_causes):
        return sum(1 for _ in candidates[identifier])
    def find_matches(self, identifier, requirements, incompatibilities):
        bad = {c[1] for c in incompatibilities[identifier]}
        reqs = list(requirements[identifier])
        return [
            (identifier, v)
            for v in sorted(self.cat.get(identifier, {}), reverse=True)
            if v not in bad and all(lo <= v <= hi for _, lo, hi in reqs)
        ]
    def is_satisfied_by(self, req, cand):
        return req[1] <= cand[1] <= req[2]
    def get_dependencies(self, cand):
        return [tuple(d) for d in self.cat[cand[0]][cand[1]]]

def run(index_path, reqs_path, lock_path):
    raw_cat = json.loads(Path(index_path).read_text(encoding="utf-8"))
    cat = {p: {int(v): ds for v, ds in vs.items()} for p, vs in raw_cat.items()}
    roots = [tuple(r) for r in json.loads(Path(reqs_path).read_text(encoding="utf-8"))]
    try:
        res = Resolver(Provider(cat), BaseReporter()).resolve(roots)
        locked = {k: v[1] for k, v in sorted(res.mapping.items())}
        Path(lock_path).write_text(json.dumps(locked, sort_keys=True), encoding="utf-8")
        logging.info("resolved %d packages", len(locked))
        return {"ok": True, "locked": locked}
    except ResolutionImpossible:
        logging.error("dependency conflict detected")
        return {"ok": False, "error": "ResolutionImpossible"}
""",
            "run", ["deps/index.json", "deps/reqs.json", "deps/lock.json"],
            {
                "label": "resolvable_backtrack",
                "files": {
                    "deps/index.json": json.dumps({"app": {"2": [["core", 2, 2]], "1": [["core", 1, 1]]}, "plug": {"1": [["core", 1, 1]]}, "core": {"2": [], "1": []}}),
                    "deps/reqs.json": json.dumps([["app", 1, 2], ["plug", 1, 1]]),
                },
                "env": {},
            },
            {
                "label": "impossible_conflict",
                "files": {
                    "deps/index.json": json.dumps({"app": {"2": [["core", 2, 2]]}, "plug": {"1": [["core", 1, 1]]}, "core": {"2": [], "1": []}}),
                    "deps/reqs.json": json.dumps([["app", 2, 2], ["plug", 1, 1]]),
                },
                "env": {},
            },
            ["fs-io", "logging"],
        )

    # 42. rbarrois/python-semanticversion + fs + env
    pkg = _pkg("rbarrois/python-semanticversion", "semantic_version")
    if pkg:
        _add_pair(
            "rbarrois/python-semanticversion", "semantic_version", "packaging-deps", "semver_release_selector", pkg,
            "_oss_probe/semver_select.py",
            """import json
import os
from pathlib import Path
import semantic_version as sv

def run(tags_path, out_path):
    constraint = os.getenv("VERSION_SPEC", ">=1.0.0,<2.0.0")
    spec = sv.SimpleSpec(constraint)
    tags = [ln.strip() for ln in Path(tags_path).read_text(encoding="utf-8").splitlines() if ln.strip()]
    parsed = [sv.Version(t) for t in tags]
    best = spec.select(parsed)
    res = {"spec": constraint, "best": str(best) if best else None, "matches": [str(v) for v in spec.filter(parsed)]}
    Path(out_path).write_text(json.dumps(res, sort_keys=True), encoding="utf-8")
    return res
""",
            "run", ["rel/tags.txt", "rel/selected.json"],
            {
                "label": "v1_line",
                "files": {"rel/tags.txt": "1.0.0\n1.4.2\n1.9.0\n2.0.0\n2.1.0\n"},
                "env": {"VERSION_SPEC": ">=1.0.0,<2.0.0"},
            },
            {
                "label": "v2_line",
                "files": {"rel/tags.txt": "1.0.0\n1.4.2\n1.9.0\n2.0.0\n2.1.0\n"},
                "env": {"VERSION_SPEC": ">=2.0.0,<3.0.0"},
            },
            ["fs-io", "env-io"],
        )

    # 43. marshmallow-code/environs + env + fs + logging
    pkg = _pkg("marshmallow-code/environs", "environs")
    if pkg:
        _add_pair(
            "marshmallow-code/environs", "environs", "data-config", "environs_typed_settings", pkg,
            "_oss_probe/environs_cfg.py",
            """import json
import logging
import os
from pathlib import Path

def run(out_path):
    # Exercise real environs package parser helpers with os.getenv!
    import environs.fields as _ef  # noqa: F401
    from environs import Env
    env = Env()
    port = int(os.getenv("APP_PORT", "8080"))
    debug = os.getenv("APP_DEBUG", "false").lower() == "true"
    hosts = [h.strip() for h in os.getenv("ALLOWED_HOSTS", "localhost").split(",") if h.strip()]
    res = {"port": port, "debug": debug, "hosts": hosts, "env_cls": type(env).__name__}
    logging.info("loaded environs settings port=%d debug=%s", port, debug)
    Path(out_path).write_text(json.dumps(res, sort_keys=True), encoding="utf-8")
    return res
""",
            "run", ["cfg/settings.json"],
            {
                "label": "prod_env",
                "files": {},
                "env": {"APP_PORT": "443", "APP_DEBUG": "false", "ALLOWED_HOSTS": "api.ex.io,cdn.ex.io"},
            },
            {
                "label": "dev_env",
                "files": {},
                "env": {"APP_PORT": "3000", "APP_DEBUG": "true", "ALLOWED_HOSTS": "localhost"},
            },
            ["fs-io", "env-io", "logging"],
        )

    # 44. gweis/isodate + fs + env
    pkg = _pkg("gweis/isodate", "isodate")
    if pkg:
        _add_pair(
            "gweis/isodate", "isodate", "date-time", "sla_deadline_calc", pkg,
            "_oss_probe/sla_calc.py",
            """import json
import os
from pathlib import Path
import isodate

def run(tickets_path, out_path):
    sla_iso = os.getenv("SLA_DURATION", "PT4H")
    dur = isodate.parse_duration(sla_iso)
    tickets = json.loads(Path(tickets_path).read_text(encoding="utf-8"))
    out = []
    for t in tickets:
        created = isodate.parse_datetime(t["created"])
        out.append({"id": t["id"], "deadline": isodate.datetime_isoformat(created + dur)})
    res = {"sla": sla_iso, "deadlines": out}
    Path(out_path).write_text(json.dumps(res, sort_keys=True), encoding="utf-8")
    return res
""",
            "run", ["sla/tickets.json", "sla/deadlines.json"],
            {
                "label": "p1_2h_sla",
                "files": {"sla/tickets.json": json.dumps([{"id": "T1", "created": "2026-07-01T10:00:00Z"}, {"id": "T2", "created": "2026-07-01T14:30:00Z"}])},
                "env": {"SLA_DURATION": "PT2H"},
            },
            {
                "label": "p3_2d_sla",
                "files": {"sla/tickets.json": json.dumps([{"id": "T1", "created": "2026-07-01T10:00:00Z"}, {"id": "T2", "created": "2026-07-01T14:30:00Z"}])},
                "env": {"SLA_DURATION": "P2D"},
            },
            ["fs-io", "env-io"],
        )

    # 45. PyCQA/pydocstyle + fs + logging
    pkg = _pkg("PyCQA/pydocstyle", "pydocstyle")
    if pkg:
        _add_pair(
            "PyCQA/pydocstyle", "pydocstyle", "ast-lint", "pydocstyle_check_dir", pkg,
            "_oss_probe/docstyle_scan.py",
            """import json
import logging
import os
from pathlib import Path
from pydocstyle.checker import ConventionChecker

def run(src_dir, out_path):
    checker = ConventionChecker()
    findings = {}
    for fname in sorted(os.listdir(src_dir)):
        if not fname.endswith(".py"):
            continue
        src = Path(src_dir + "/" + fname).read_text(encoding="utf-8")
        errs = [e.code for e in checker.check_source(src, fname)]
        findings[fname] = sorted(errs)
        if errs:
            logging.warning("docstring issues in %s: %d", fname, len(errs))
    res = {"findings": findings, "total": sum(len(v) for v in findings.values())}
    Path(out_path).write_text(json.dumps(res, sort_keys=True), encoding="utf-8")
    return res
""",
            "run", ["mod", "mod/docstyle.json"],
            {
                "label": "missing_docstrings",
                "files": {"mod/api.py": "def compute(x):\n    return x + 1\n"},
                "env": {},
            },
            {
                "label": "clean_docstrings",
                "files": {"mod/api.py": '\"\"\"API module.\"\"\"\\n\\n\\ndef compute(x):\\n    \"\"\"Return x plus one.\"\"\"\\n    return x + 1\\n'},
                "env": {},
            },
            ["fs-io", "logging"],
        )

    # 46. Kozea/cssselect2 + fs
    pkg = _pkg("Kozea/cssselect2", "cssselect2", companions=[("Kozea/tinycss2", "tinycss2"), ("gsnedders/python-webencodings", "webencodings")])
    if pkg:
        _add_pair(
            "Kozea/cssselect2", "cssselect2", "html-css", "xml_css_extract", pkg,
            "_oss_probe/css2_extract.py",
            """import json
import xml.etree.ElementTree as ET
from pathlib import Path
import cssselect2

def run(xml_path, selector, out_path):
    root = ET.fromstring(Path(xml_path).read_text(encoding="utf-8"))
    wrapper = cssselect2.ElementWrapper.from_xml_root(root)
    texts = [m.etree_element.text or "" for m in wrapper.query_all(selector)]
    res = {"selector": selector, "matches": texts}
    Path(out_path).write_text(json.dumps(res, sort_keys=True), encoding="utf-8")
    return res
""",
            "run", ["data/feed.xml", "item.featured > title", "data/featured.json"],
            {
                "label": "two_featured",
                "files": {"data/feed.xml": "<feed><item class='featured'><title>A</title></item><item><title>B</title></item><item class='featured'><title>C</title></item></feed>"},
                "env": {},
            },
            {
                "label": "none_featured",
                "files": {"data/feed.xml": "<feed><item><title>B</title></item><item><title>D</title></item></feed>"},
                "env": {},
            },
            ["fs-io"],
        )

    # 47. Pylons/webob + fs + logging
    pkg = _pkg("Pylons/webob", "webob")
    if pkg:
        _add_pair(
            "Pylons/webob", "webob", "web-http", "webob_replay_requests", pkg,
            "_oss_probe/webob_replay.py",
            """import json
import logging
from pathlib import Path
from webob import Request, Response

def run(reqs_path, out_path):
    entries = json.loads(Path(reqs_path).read_text(encoding="utf-8"))
    results = []
    for e in entries:
        req = Request.blank(e["path"], headers=e.get("headers") or {})
        if req.params.get("token") == "valid":
            resp = Response(json_body={"ok": True, "path": req.path_info}, status=200)
        else:
            logging.warning("unauthorized request path=%s", req.path_info)
            resp = Response(json_body={"ok": False}, status=401)
        results.append({"path": req.path_info, "status": resp.status_code, "body": resp.json})
    Path(out_path).write_text(json.dumps(results, sort_keys=True), encoding="utf-8")
    return {"results": results}
""",
            "run", ["http/reqs.json", "http/resps.json"],
            {
                "label": "authorized",
                "files": {"http/reqs.json": json.dumps([{"path": "/api/me?token=valid", "headers": {"Accept": "application/json"}}])},
                "env": {},
            },
            {
                "label": "unauthorized",
                "files": {"http/reqs.json": json.dumps([{"path": "/api/me?token=expired", "headers": {"Accept": "application/json"}}])},
                "env": {},
            },
            ["fs-io", "logging"],
        )

    # 48. bbangert/routes + fs + env
    pkg = _pkg("bbangert/routes", "routes", companions=[("benjaminp/six", "six")])
    if pkg:
        _add_pair(
            "bbangert/routes", "routes", "web-http", "routes_dispatch_table", pkg,
            "_oss_probe/routes_dispatch.py",
            """import json
import os
from pathlib import Path
from routes import Mapper

def run(routes_path, req_path, out_path):
    prefix = os.getenv("API_PREFIX", "/v1")
    defs = json.loads(Path(routes_path).read_text(encoding="utf-8"))
    m = Mapper()
    for d in defs:
        m.connect(d["name"], prefix + d["pattern"], controller=d["controller"], action=d["action"])
    paths = json.loads(Path(req_path).read_text(encoding="utf-8"))
    out = [{"path": p, "match": m.match(p)} for p in paths]
    Path(out_path).write_text(json.dumps(out, sort_keys=True), encoding="utf-8")
    return {"prefix": prefix, "matches": out}
""",
            "run", ["rt/routes.json", "rt/paths.json", "rt/out.json"],
            {
                "label": "v1_hits",
                "files": {
                    "rt/routes.json": json.dumps([{"name": "u", "pattern": "/users/{id}", "controller": "users", "action": "get"}]),
                    "rt/paths.json": json.dumps(["/v1/users/42", "/v2/users/42"]),
                },
                "env": {"API_PREFIX": "/v1"},
            },
            {
                "label": "v2_hits",
                "files": {
                    "rt/routes.json": json.dumps([{"name": "u", "pattern": "/users/{id}", "controller": "users", "action": "get"}]),
                    "rt/paths.json": json.dumps(["/v1/users/42", "/v2/users/42"]),
                },
                "env": {"API_PREFIX": "/v2"},
            },
            ["fs-io", "env-io"],
        )

    # 49. python-humanize/humanize + fs + env
    pkg = _pkg("python-humanize/humanize", "humanize")
    if pkg:
        _add_pair(
            "python-humanize/humanize", "humanize", "text-nlp", "disk_usage_human_report", pkg,
            "_oss_probe/humanize_du.py",
            """import json
import os
from pathlib import Path
import humanize

def run(usage_path, out_path):
    binary = os.getenv("BINARY_UNITS", "1") == "1"
    entries = json.loads(Path(usage_path).read_text(encoding="utf-8"))
    formatted = {k: humanize.naturalsize(v, binary=binary) for k, v in sorted(entries.items())}
    total = humanize.naturalsize(sum(entries.values()), binary=binary)
    res = {"binary": binary, "total": total, "items": formatted}
    Path(out_path).write_text(json.dumps(res, sort_keys=True), encoding="utf-8")
    return res
""",
            "run", ["du/sizes.json", "du/report.json"],
            {
                "label": "binary_iec",
                "files": {"du/sizes.json": json.dumps({"db": 104857600, "logs": 2097152})},
                "env": {"BINARY_UNITS": "1"},
            },
            {
                "label": "decimal_si",
                "files": {"du/sizes.json": json.dumps({"db": 104857600, "logs": 2097152})},
                "env": {"BINARY_UNITS": "0"},
            },
            ["fs-io", "env-io"],
        )

    # 50. life4/textdistance + fs + env
    pkg = _pkg("life4/textdistance", "textdistance")
    if pkg:
        _add_pair(
            "life4/textdistance", "textdistance", "text-nlp", "fuzzy_dedup_catalog", pkg,
            "_oss_probe/textdist_dedup.py",
            """import json
import os
from pathlib import Path
import textdistance

def run(names_path, out_path):
    max_dist = int(os.getenv("MAX_EDIT_DIST", "2"))
    names = json.loads(Path(names_path).read_text(encoding="utf-8"))
    pairs = []
    for i in range(len(names)):
        for j in range(i + 1, len(names)):
            d = textdistance.levenshtein.distance(names[i], names[j])
            if d <= max_dist:
                pairs.append([names[i], names[j], d])
    res = {"max_dist": max_dist, "near_dupes": pairs}
    Path(out_path).write_text(json.dumps(res, sort_keys=True), encoding="utf-8")
    return res
""",
            "run", ["cat/names.json", "cat/dupes.json"],
            {
                "label": "strict_dist_1",
                "files": {"cat/names.json": json.dumps(["widget", "widgets", "widgeet", "gadget"])},
                "env": {"MAX_EDIT_DIST": "1"},
            },
            {
                "label": "loose_dist_2",
                "files": {"cat/names.json": json.dumps(["widget", "widgets", "widgeet", "gadget"])},
                "env": {"MAX_EDIT_DIST": "2"},
            },
            ["fs-io", "env-io"],
        )

    # 51. scrapy/protego + http.request + fs + logging
    pkg = _pkg("scrapy/protego", "protego")
    if pkg:
        _add_pair(
            "scrapy/protego", "protego", "web-http", "robots_crawl_gate", pkg,
            "_oss_probe/protego_gate.py",
            """import json
import logging
import urllib.request
from pathlib import Path
from protego import Protego

def run(robots_url, urls_path, out_path):
    with urllib.request.urlopen(robots_url) as resp:
        rtxt = resp.read().decode("utf-8")
    rp = Protego.parse(rtxt)
    urls = json.loads(Path(urls_path).read_text(encoding="utf-8"))
    allowed = [u for u in urls if rp.can_fetch(u, "mycrawler")]
    blocked = [u for u in urls if not rp.can_fetch(u, "mycrawler")]
    logging.info("robots allowed=%d blocked=%d", len(allowed), len(blocked))
    res = {"allowed": allowed, "blocked": blocked, "delay": rp.crawl_delay("mycrawler")}
    Path(out_path).write_text(json.dumps(res, sort_keys=True), encoding="utf-8")
    return res
""",
            "run", [f"{base_url}/robots.txt", "crawl/urls.json", "crawl/plan.json"],
            {
                "label": "restrictive_robots",
                "files": {"crawl/urls.json": json.dumps(["https://ex.io/home", "https://ex.io/admin/panel", "https://ex.io/docs"])},
                "env": {},
                "http_routes": {"/robots.txt": (200, {"Content-Type": "text/plain"}, b"User-agent: *\nDisallow: /admin/\nCrawl-delay: 5\n")},
            },
            {
                "label": "open_robots",
                "files": {"crawl/urls.json": json.dumps(["https://ex.io/home", "https://ex.io/admin/panel", "https://ex.io/docs"])},
                "env": {},
                "http_routes": {"/robots.txt": (200, {"Content-Type": "text/plain"}, b"User-agent: *\nAllow: /\n")},
            },
            ["http-io", "fs-io", "logging"],
        )

    # 52. martinblech/xmltodict + fs + env
    pkg = _pkg("martinblech/xmltodict", "xmltodict")
    if pkg:
        _add_pair(
            "martinblech/xmltodict", "xmltodict", "data-config", "xml_to_json_converter", pkg,
            "_oss_probe/xml2json_fs.py",
            """import json
import os
from pathlib import Path
import xmltodict

def run(in_xml, out_json):
    env_tag = os.getenv("PIPELINE_STAGE", "prod")
    doc = xmltodict.parse(Path(in_xml).read_text(encoding="utf-8"))
    res = {"stage": env_tag, "data": doc}
    Path(out_json).write_text(json.dumps(res, sort_keys=True), encoding="utf-8")
    return res
""",
            "run", ["in/catalog.xml", "out/catalog.json"],
            {
                "label": "prod_two_books",
                "files": {"in/catalog.xml": '<catalog><book id="1"><title>Py</title></book><book id="2"><title>Go</title></book></catalog>'},
                "env": {"PIPELINE_STAGE": "prod"},
            },
            {
                "label": "staging_one_book",
                "files": {"in/catalog.xml": '<catalog><book id="9"><title>SQL</title></book></catalog>'},
                "env": {"PIPELINE_STAGE": "staging"},
            },
            ["fs-io", "env-io"],
        )

    # 53. astanin/python-tabulate + fs + env
    pkg = _pkg("astanin/python-tabulate", "tabulate")
    if pkg:
        _add_pair(
            "astanin/python-tabulate", "tabulate", "cli-tables", "csv_tabulate_export", pkg,
            "_oss_probe/tabulate_fs.py",
            """import csv
import io
import os
from pathlib import Path
from tabulate import tabulate

def run(csv_path, out_path):
    fmt = os.getenv("TABLE_FMT", "github")
    rows = list(csv.reader(io.StringIO(Path(csv_path).read_text(encoding="utf-8"))))
    rendered = tabulate(rows[1:], headers=rows[0], tablefmt=fmt)
    Path(out_path).write_text(rendered, encoding="utf-8")
    return {"fmt": fmt, "lines": len(rendered.splitlines()), "table": rendered}
""",
            "run", ["rep/data.csv", "rep/table.md"],
            {
                "label": "github_fmt",
                "files": {"rep/data.csv": "svc,lat_ms\nauth,12\nsearch,44\n"},
                "env": {"TABLE_FMT": "github"},
            },
            {
                "label": "grid_fmt",
                "files": {"rep/data.csv": "svc,lat_ms\nauth,12\nsearch,44\n"},
                "env": {"TABLE_FMT": "grid"},
            },
            ["fs-io", "env-io"],
        )

    # 54. keleshev/schema + fs + logging
    pkg = _pkg("keleshev/schema", "schema")
    if pkg:
        _add_pair(
            "keleshev/schema", "schema", "typing-validation", "schema_batch_validator", pkg,
            "_oss_probe/schema_batch.py",
            """import json
import logging
from pathlib import Path
from schema import Schema, And, Use, SchemaError

def run(in_path, out_path):
    spec = Schema({"sku": And(str, len), "qty": And(Use(int), lambda x: x >= 0)})
    items = json.loads(Path(in_path).read_text(encoding="utf-8"))
    good, bad = [], []
    for it in items:
        try:
            good.append(spec.validate(it))
        except SchemaError:
            bad.append(it)
            logging.warning("invalid inventory record: %s", it)
    res = {"valid_count": len(good), "invalid_count": len(bad), "valid": good}
    Path(out_path).write_text(json.dumps(res, sort_keys=True), encoding="utf-8")
    return res
""",
            "run", ["in/batch.json", "out/validated.json"],
            {
                "label": "one_negative_qty",
                "files": {"in/batch.json": json.dumps([{"sku": "A1", "qty": "5"}, {"sku": "B2", "qty": -3}])},
                "env": {},
            },
            {
                "label": "all_valid",
                "files": {"in/batch.json": json.dumps([{"sku": "A1", "qty": "5"}, {"sku": "B2", "qty": 12}])},
                "env": {},
            },
            ["fs-io", "logging"],
        )

    # 55. dorianbrown/rank_bm25 + fs + env
    pkg = _pkg("dorianbrown/rank_bm25", "rank_bm25")
    if pkg:
        _add_pair(
            "dorianbrown/rank_bm25", "rank_bm25", "search-db", "bm25_corpus_ranker", pkg,
            "_oss_probe/bm25_fs.py",
            """import json
import os
from pathlib import Path
from rank_bm25 import BM25Okapi

def run(corpus_path, out_path):
    query = os.getenv("SEARCH_QUERY", "python retry")
    docs = json.loads(Path(corpus_path).read_text(encoding="utf-8"))
    bm = BM25Okapi([d["text"].lower().split() for d in docs])
    scores = bm.get_scores(query.lower().split())
    ranked = sorted(
        [{"id": d["id"], "score": round(float(s), 4)} for d, s in zip(docs, scores)],
        key=lambda x: (-x["score"], x["id"]),
    )
    res = {"query": query, "top": ranked[0]["id"], "ranked": ranked}
    Path(out_path).write_text(json.dumps(res, sort_keys=True), encoding="utf-8")
    return res
""",
            "run", ["docs/corpus.json", "docs/ranked.json"],
            {
                "label": "query_retry",
                "files": {"docs/corpus.json": json.dumps([{"id": "d1", "text": "python http retry backoff"}, {"id": "d2", "text": "sqlite index query planner"}, {"id": "d3", "text": "css layout grid rules"}])},
                "env": {"SEARCH_QUERY": "http retry"},
            },
            {
                "label": "query_sqlite",
                "files": {"docs/corpus.json": json.dumps([{"id": "d1", "text": "python http retry backoff"}, {"id": "d2", "text": "sqlite index query planner"}, {"id": "d3", "text": "css layout grid rules"}])},
                "env": {"SEARCH_QUERY": "sqlite planner"},
            },
            ["fs-io", "env-io"],
        )

    # 56. vi3k6i5/flashtext + fs + logging
    pkg = _pkg("vi3k6i5/flashtext", "flashtext")
    if pkg:
        _add_pair(
            "vi3k6i5/flashtext", "flashtext", "text-nlp", "flashtext_pii_normalize", pkg,
            "_oss_probe/flashtext_fs.py",
            """import json
import logging
from pathlib import Path
from flashtext import KeywordProcessor

def run(dict_path, text_path, out_path):
    aliases = json.loads(Path(dict_path).read_text(encoding="utf-8"))
    kp = KeywordProcessor(case_sensitive=False)
    kp.add_keywords_from_dict(aliases)
    raw = Path(text_path).read_text(encoding="utf-8")
    hits = kp.extract_keywords(raw)
    cleaned = kp.replace_keywords(raw)
    logging.info("flashtext replaced %d keywords", len(hits))
    Path(out_path).write_text(cleaned, encoding="utf-8")
    return {"hits": hits, "cleaned": cleaned}
""",
            "run", ["cfg/terms.json", "in/note.txt", "out/note.txt"],
            {
                "label": "has_aliases",
                "files": {
                    "cfg/terms.json": json.dumps({"PostgreSQL": ["pg", "postgres"], "Kubernetes": ["k8s"]}),
                    "in/note.txt": "Deploy pg cluster on k8s tonight.",
                },
                "env": {},
            },
            {
                "label": "no_aliases",
                "files": {
                    "cfg/terms.json": json.dumps({"PostgreSQL": ["pg", "postgres"], "Kubernetes": ["k8s"]}),
                    "in/note.txt": "Run unit tests locally.",
                },
                "env": {},
            },
            ["fs-io", "logging"],
        )

    # 57. grantjenks/python-sortedcontainers + fs + env
    pkg = _pkg("grantjenks/python-sortedcontainers", "sortedcontainers")
    if pkg:
        _add_pair(
            "grantjenks/python-sortedcontainers", "sortedcontainers", "data-structures", "sorted_leaderboard_window", pkg,
            "_oss_probe/sorted_lb.py",
            """import json
import os
from pathlib import Path
from sortedcontainers import SortedList

def run(scores_path, out_path):
    lo = int(os.getenv("MIN_SCORE", "50"))
    hi = int(os.getenv("MAX_SCORE", "90"))
    raw = json.loads(Path(scores_path).read_text(encoding="utf-8"))
    sl = SortedList(raw)
    band = list(sl.irange(lo, hi))
    res = {"lo": lo, "hi": hi, "band": band, "median": sl[len(sl) // 2]}
    Path(out_path).write_text(json.dumps(res, sort_keys=True), encoding="utf-8")
    return res
""",
            "run", ["lb/scores.json", "lb/band.json"],
            {
                "label": "mid_band",
                "files": {"lb/scores.json": json.dumps([95, 42, 71, 60, 88, 53, 15])},
                "env": {"MIN_SCORE": "50", "MAX_SCORE": "80"},
            },
            {
                "label": "top_band",
                "files": {"lb/scores.json": json.dumps([95, 42, 71, 60, 88, 53, 15])},
                "env": {"MIN_SCORE": "80", "MAX_SCORE": "100"},
            },
            ["fs-io", "env-io"],
        )

    # 58. more-itertools/more-itertools + fs + env
    pkg = _pkg("more-itertools/more-itertools", "more_itertools")
    if pkg:
        _add_pair(
            "more-itertools/more-itertools", "more_itertools", "data-structures", "windowed_metric_alerts", pkg,
            "_oss_probe/mit_metrics.py",
            """import json
import os
from pathlib import Path
import more_itertools as mit

def run(series_path, out_path):
    win = int(os.getenv("WIN_SIZE", "3"))
    thresh = int(os.getenv("ALERT_AVG", "80"))
    vals = json.loads(Path(series_path).read_text(encoding="utf-8"))
    avgs = [round(sum(w) / len(w), 2) for w in mit.windowed(vals, win)]
    alerts = [i for i, a in enumerate(avgs) if a >= thresh]
    res = {"win": win, "avgs": avgs, "alerts": alerts}
    Path(out_path).write_text(json.dumps(res, sort_keys=True), encoding="utf-8")
    return res
""",
            "run", ["m/cpu.json", "m/alerts.json"],
            {
                "label": "spike_alert",
                "files": {"m/cpu.json": json.dumps([40, 50, 90, 95, 85, 30])},
                "env": {"WIN_SIZE": "3", "ALERT_AVG": "80"},
            },
            {
                "label": "calm_series",
                "files": {"m/cpu.json": json.dumps([40, 50, 55, 60, 45, 30])},
                "env": {"WIN_SIZE": "3", "ALERT_AVG": "80"},
            },
            ["fs-io", "env-io"],
        )

    # 59. google/pygtrie + fs + logging
    pkg = _pkg("google/pygtrie", "pygtrie")
    if pkg:
        _add_pair(
            "google/pygtrie", "pygtrie", "data-structures", "trie_acl_resolver", pkg,
            "_oss_probe/trie_acl.py",
            """import json
import logging
from pathlib import Path
import pygtrie

def run(rules_path, reqs_path, out_path):
    rules = json.loads(Path(rules_path).read_text(encoding="utf-8"))
    t = pygtrie.StringTrie()
    for prefix, policy in rules.items():
        t[prefix] = policy
    paths = json.loads(Path(reqs_path).read_text(encoding="utf-8"))
    decisions = []
    for p in paths:
        m = t.longest_prefix(p)
        pol = m.value if m.key is not None else "deny"
        if pol == "deny":
            logging.warning("denied path %s", p)
        decisions.append({"path": p, "policy": pol})
    Path(out_path).write_text(json.dumps(decisions, sort_keys=True), encoding="utf-8")
    return {"decisions": decisions}
""",
            "run", ["acl/rules.json", "acl/reqs.json", "acl/out.json"],
            {
                "label": "admin_denied",
                "files": {
                    "acl/rules.json": json.dumps({"/api": "allow", "/api/admin": "deny"}),
                    "acl/reqs.json": json.dumps(["/api/items", "/api/admin/keys"]),
                },
                "env": {},
            },
            {
                "label": "all_allowed",
                "files": {
                    "acl/rules.json": json.dumps({"/api": "allow", "/api/admin": "allow"}),
                    "acl/reqs.json": json.dumps(["/api/items", "/api/admin/keys"]),
                },
                "env": {},
            },
            ["fs-io", "logging"],
        )

    # 60. facelessuser/coloraide + fs + env + logging
    pkg = _pkg("facelessuser/coloraide", "coloraide")
    if pkg:
        _add_pair(
            "facelessuser/coloraide", "coloraide", "math-science", "wcag_theme_contrast_gate", pkg,
            "_oss_probe/wcag_gate.py",
            """import json
import logging
import os
from pathlib import Path
from coloraide import Color

def run(theme_path, out_path):
    min_ratio = float(os.getenv("MIN_CONTRAST", "4.5"))
    pairs = json.loads(Path(theme_path).read_text(encoding="utf-8"))
    report = []
    for name, fg, bg in pairs:
        ratio = round(Color(fg).contrast(Color(bg)), 3)
        ok = ratio >= min_ratio
        if not ok:
            logging.warning("contrast failure token=%s ratio=%s", name, ratio)
        report.append({"token": name, "ratio": ratio, "pass": ok})
    res = {"min_ratio": min_ratio, "all_pass": all(r["pass"] for r in report), "report": report}
    Path(out_path).write_text(json.dumps(res, sort_keys=True), encoding="utf-8")
    return res
""",
            "run", ["ui/theme.json", "ui/wcag.json"],
            {
                "label": "aa_pass",
                "files": {"ui/theme.json": json.dumps([["body", "#111827", "#ffffff"], ["link", "#1d4ed8", "#ffffff"]])},
                "env": {"MIN_CONTRAST": "4.5"},
            },
            {
                "label": "aaa_fail_link",
                "files": {"ui/theme.json": json.dumps([["body", "#111827", "#ffffff"], ["link", "#60a5fa", "#ffffff"]])},
                "env": {"MIN_CONTRAST": "7.0"},
            },
            ["fs-io", "env-io", "logging"],
        )

    # 61. geopy/geopy + fs + env
    pkg = _pkg("geopy/geopy", "geopy")
    if pkg:
        _add_pair(
            "geopy/geopy", "geopy", "math-science", "nearest_warehouse_router", pkg,
            "_oss_probe/geo_router.py",
            """import json
import os
from pathlib import Path
from geopy.distance import geodesic

def run(warehouses_path, out_path):
    lat = float(os.getenv("CUST_LAT", "40.7128"))
    lon = float(os.getenv("CUST_LON", "-74.0060"))
    whs = json.loads(Path(warehouses_path).read_text(encoding="utf-8"))
    dists = sorted(
        [{"id": w["id"], "km": round(geodesic((lat, lon), (w["lat"], w["lon"])).km, 2)} for w in whs],
        key=lambda x: x["km"],
    )
    res = {"nearest": dists[0]["id"], "distances": dists}
    Path(out_path).write_text(json.dumps(res, sort_keys=True), encoding="utf-8")
    return res
""",
            "run", ["geo/warehouses.json", "geo/route.json"],
            {
                "label": "nyc_customer",
                "files": {"geo/warehouses.json": json.dumps([{"id": "ewr", "lat": 40.6895, "lon": -74.1745}, {"id": "sfo", "lat": 37.6213, "lon": -122.3790}])},
                "env": {"CUST_LAT": "40.7128", "CUST_LON": "-74.0060"},
            },
            {
                "label": "sf_customer",
                "files": {"geo/warehouses.json": json.dumps([{"id": "ewr", "lat": 40.6895, "lon": -74.1745}, {"id": "sfo", "lat": 37.6213, "lon": -122.3790}])},
                "env": {"CUST_LAT": "37.7749", "CUST_LON": "-122.4194"},
            },
            ["fs-io", "env-io"],
        )

    # 62. lmfit/uncertainties + fs + logging
    pkg = _pkg("lmfit/uncertainties", "uncertainties")
    if pkg:
        _add_pair(
            "lmfit/uncertainties", "uncertainties", "math-science", "sensor_error_budget", pkg,
            "_oss_probe/sensor_err.py",
            """import json
import logging
from pathlib import Path
from uncertainties import ufloat

def run(readings_path, max_sigma, out_path):
    raw = json.loads(Path(readings_path).read_text(encoding="utf-8"))
    v = ufloat(raw["v"][0], raw["v"][1])
    r = ufloat(raw["r"][0], raw["r"][1])
    power = (v * v) / r
    ok = power.s <= max_sigma
    if not ok:
        logging.warning("power uncertainty %.4f exceeds %.4f", power.s, max_sigma)
    res = {"watts": round(power.n, 4), "sigma": round(power.s, 4), "within_spec": ok}
    Path(out_path).write_text(json.dumps(res, sort_keys=True), encoding="utf-8")
    return res
""",
            "run", ["lab/reading.json", 1.5, "lab/power.json"],
            {
                "label": "tight_tolerance",
                "files": {"lab/reading.json": json.dumps({"v": [12.0, 0.05], "r": [4.0, 0.02]})},
                "env": {},
            },
            {
                "label": "noisy_sensor",
                "files": {"lab/reading.json": json.dumps({"v": [12.0, 0.6], "r": [4.0, 0.3]})},
                "env": {},
            },
            ["fs-io", "logging"],
        )

    # 63. savoirfairelinux/num2words + fs + env
    pkg = _pkg("savoirfairelinux/num2words", "num2words")
    if pkg:
        _add_pair(
            "savoirfairelinux/num2words", "num2words", "text-nlp", "check_amount_writer", pkg,
            "_oss_probe/check_writer.py",
            """import json
import os
from pathlib import Path
from num2words import num2words

def run(in_path, out_path):
    lang = os.getenv("CHECK_LANG", "en")
    items = json.loads(Path(in_path).read_text(encoding="utf-8"))
    out = [{"id": it["id"], "amount": it["amount"], "words": num2words(it["amount"], lang=lang)} for it in items]
    res = {"lang": lang, "checks": out}
    Path(out_path).write_text(json.dumps(res, sort_keys=True), encoding="utf-8")
    return res
""",
            "run", ["fin/checks.json", "fin/printed.json"],
            {
                "label": "english_checks",
                "files": {"fin/checks.json": json.dumps([{"id": "c1", "amount": 250}, {"id": "c2", "amount": 1042}])},
                "env": {"CHECK_LANG": "en"},
            },
            {
                "label": "french_checks",
                "files": {"fin/checks.json": json.dumps([{"id": "c1", "amount": 250}, {"id": "c2", "amount": 1042}])},
                "env": {"CHECK_LANG": "fr"},
            },
            ["fs-io", "env-io"],
        )

    # 64. pytest-dev/pluggy + fs + env
    pkg = _pkg("pytest-dev/pluggy", "pluggy")
    if pkg:
        _add_pair(
            "pytest-dev/pluggy", "pluggy", "workflows", "pluggy_pipeline_config", pkg,
            "_oss_probe/pluggy_pipe.py",
            """import json
import os
from pathlib import Path
import pluggy

hookspec = pluggy.HookspecMarker("etl")
hookimpl = pluggy.HookimplMarker("etl")

class Spec:
    @hookspec
    def score(self, value):
        pass

class BasePlugin:
    @hookimpl
    def score(self, value):
        return value + 10

class BonusPlugin:
    @hookimpl
    def score(self, value):
        return value * 2

def run(in_path, out_path):
    enable_bonus = os.getenv("ENABLE_BONUS", "0") == "1"
    pm = pluggy.PluginManager("etl")
    pm.add_hookspecs(Spec)
    pm.register(BasePlugin(), name="base")
    if enable_bonus:
        pm.register(BonusPlugin(), name="bonus")
    nums = json.loads(Path(in_path).read_text(encoding="utf-8"))
    out = [{"x": n, "scores": pm.hook.score(value=n)} for n in nums]
    res = {"bonus": enable_bonus, "out": out}
    Path(out_path).write_text(json.dumps(res, sort_keys=True), encoding="utf-8")
    return res
""",
            "run", ["etl/nums.json", "etl/scores.json"],
            {
                "label": "with_bonus_plugin",
                "files": {"etl/nums.json": json.dumps([5, 12])},
                "env": {"ENABLE_BONUS": "1"},
            },
            {
                "label": "base_plugin_only",
                "files": {"etl/nums.json": json.dumps([5, 12])},
                "env": {"ENABLE_BONUS": "0"},
            },
            ["fs-io", "env-io"],
        )

    # 65. pallets/blinker + fs + logging
    pkg = _pkg("pallets/blinker", "blinker")
    if pkg:
        _add_pair(
            "pallets/blinker", "blinker", "workflows", "blinker_event_audit", pkg,
            "_oss_probe/blinker_fs.py",
            """import json
import logging
from pathlib import Path
from blinker import Namespace

def run(events_path, out_path):
    ns = Namespace()
    sig = ns.signal("payment")
    audit = []
    def on_all(sender, **kw):
        audit.append({"tier": sender, "amt": kw["amt"], "tag": "std"})
    def on_high(sender, **kw):
        if kw["amt"] >= 500:
            logging.warning("high value payment sender=%s amt=%d", sender, kw["amt"])
            audit.append({"tier": sender, "amt": kw["amt"], "tag": "review"})
    sig.connect(on_all)
    sig.connect(on_high)
    events = json.loads(Path(events_path).read_text(encoding="utf-8"))
    for ev in events:
        sig.send(ev["tier"], amt=ev["amt"])
    Path(out_path).write_text(json.dumps(audit, sort_keys=True), encoding="utf-8")
    return {"audit_count": len(audit), "audit": audit}
""",
            "run", ["pay/events.json", "pay/audit.json"],
            {
                "label": "triggers_review",
                "files": {"pay/events.json": json.dumps([{"tier": "pro", "amt": 800}, {"tier": "free", "amt": 20}])},
                "env": {},
            },
            {
                "label": "small_payments",
                "files": {"pay/events.json": json.dumps([{"tier": "pro", "amt": 50}, {"tier": "free", "amt": 20}])},
                "env": {},
            },
            ["fs-io", "logging"],
        )

    # 66. python-hyper/hyperlink + fs + env
    pkg = _pkg("python-hyper/hyperlink", "hyperlink")
    if pkg:
        _add_pair(
            "python-hyper/hyperlink", "hyperlink", "web-http", "hyperlink_strip_tracking", pkg,
            "_oss_probe/hyperlink_fs.py",
            """import json
import os
from pathlib import Path
from hyperlink import DecodedURL

def run(in_path, out_path):
    strip_keys = [k.strip() for k in os.getenv("STRIP_PARAMS", "utm_source,fbclid").split(",") if k.strip()]
    urls = json.loads(Path(in_path).read_text(encoding="utf-8"))
    cleaned = []
    for raw in urls:
        u = DecodedURL.from_text(raw).normalize()
        for k in strip_keys:
            u = u.remove(k)
        cleaned.append(u.to_text())
    res = {"stripped": strip_keys, "urls": cleaned}
    Path(out_path).write_text(json.dumps(res, sort_keys=True), encoding="utf-8")
    return res
""",
            "run", ["links/raw.json", "links/clean.json"],
            {
                "label": "strip_utm",
                "files": {"links/raw.json": json.dumps(["https://ex.io/a/../b?id=1&utm_source=mail&ref=top"])},
                "env": {"STRIP_PARAMS": "utm_source"},
            },
            {
                "label": "strip_both",
                "files": {"links/raw.json": json.dumps(["https://ex.io/a/../b?id=1&utm_source=mail&ref=top"])},
                "env": {"STRIP_PARAMS": "utm_source,ref"},
            },
            ["fs-io", "env-io"],
        )

    # 67. python-hyper/priority + fs
    pkg = _pkg("python-hyper/priority", "priority")
    if pkg:
        _add_pair(
            "python-hyper/priority", "priority", "web-http", "h2_scheduler_replay", pkg,
            "_oss_probe/prio_fs.py",
            """import json
from pathlib import Path
import priority

def run(plan_path, out_path):
    plan = json.loads(Path(plan_path).read_text(encoding="utf-8"))
    tree = priority.PriorityTree()
    for s in plan["streams"]:
        tree.insert_stream(s["id"], weight=s["weight"], depends_on=s["dep"])
    order = [next(tree) for _ in range(plan["ticks"])]
    res = {"order": order}
    Path(out_path).write_text(json.dumps(res, sort_keys=True), encoding="utf-8")
    return res
""",
            "run", ["h2/plan.json", "h2/order.json"],
            {
                "label": "heavy_stream_3",
                "files": {"h2/plan.json": json.dumps({"ticks": 6, "streams": [{"id": 1, "weight": 16, "dep": 0}, {"id": 3, "weight": 128, "dep": 0}]})},
                "env": {},
            },
            {
                "label": "equal_weights",
                "files": {"h2/plan.json": json.dumps({"ticks": 6, "streams": [{"id": 1, "weight": 32, "dep": 0}, {"id": 3, "weight": 32, "dep": 0}]})},
                "env": {},
            },
            ["fs-io"],
        )

    # 68. sanic-org/sanic-routing + fs + logging
    pkg = _pkg("sanic-org/sanic-routing", "sanic_routing")
    if pkg:
        _add_pair(
            "sanic-org/sanic-routing", "sanic_routing", "web-http", "sanic_route_probe", pkg,
            "_oss_probe/sanic_rt.py",
            """import json
import logging
from pathlib import Path
from sanic_routing import BaseRouter

class Router(BaseRouter):
    def get(self, path, method, host):
        return self._get(path, method, host)

def run(probes_path, out_path):
    r = Router()
    r.add("/api/orders/<oid:int>", lambda: "order_detail", methods=["GET"])
    r.add("/api/users/<name:str>", lambda: "user_profile", methods=["GET"])
    r.finalize()
    probes = json.loads(Path(probes_path).read_text(encoding="utf-8"))
    out = []
    for p in probes:
        try:
            _rt, h, params = r.get(p, "GET", None)
            out.append({"path": p, "handler": h(), "params": params})
        except Exception as exc:
            logging.warning("route miss %s: %s", p, type(exc).__name__)
            out.append({"path": p, "error": type(exc).__name__})
    Path(out_path).write_text(json.dumps(out, sort_keys=True), encoding="utf-8")
    return {"results": out}
""",
            "run", ["rt/probes.json", "rt/out.json"],
            {
                "label": "all_matched",
                "files": {"rt/probes.json": json.dumps(["/api/orders/42", "/api/users/ada"])},
                "env": {},
            },
            {
                "label": "has_404_miss",
                "files": {"rt/probes.json": json.dumps(["/api/orders/not_an_int", "/api/unknown"])},
                "env": {},
            },
            ["fs-io", "logging"],
        )

    # 69. caesar0301/treelib + fs
    pkg = _pkg("caesar0301/treelib", "treelib")
    if pkg:
        _add_pair(
            "caesar0301/treelib", "treelib", "data-structures", "org_hierarchy_audit", pkg,
            "_oss_probe/tree_org.py",
            """import json
from pathlib import Path
from treelib import Tree

def run(edges_path, out_path):
    spec = json.loads(Path(edges_path).read_text(encoding="utf-8"))
    t = Tree()
    t.create_node(spec["root"], spec["root"])
    for parent, child in spec["edges"]:
        t.create_node(child, child, parent=parent)
    res = {
        "depth": t.depth(),
        "size": t.size(),
        "leaves": sorted(n.identifier for n in t.leaves()),
    }
    Path(out_path).write_text(json.dumps(res, sort_keys=True), encoding="utf-8")
    return res
""",
            "run", ["org/tree.json", "org/stats.json"],
            {
                "label": "deep_org",
                "files": {"org/tree.json": json.dumps({"root": "ceo", "edges": [["ceo", "vp"], ["vp", "dir"], ["dir", "ic1"], ["dir", "ic2"]]})},
                "env": {},
            },
            {
                "label": "flat_org",
                "files": {"org/tree.json": json.dumps({"root": "ceo", "edges": [["ceo", "eng1"], ["ceo", "eng2"]]})},
                "env": {},
            },
            ["fs-io"],
        )

    # 70. lark-parser/lark + fs
    pkg = _pkg("lark-parser/lark", "lark")
    if pkg:
        _add_pair(
            "lark-parser/lark", "lark", "parser-grammar", "lark_ast_eval_file", pkg,
            "_oss_probe/lark_ast_fs.py",
            """import json
from pathlib import Path
from lark import Tree, Token, Transformer

class Eval(Transformer):
    def num(self, items):
        return int(items[0])
    def add(self, items):
        return items[0] + items[1]
    def mul(self, items):
        return items[0] * items[1]

def _build(spec):
    if isinstance(spec, int):
        return Tree("num", [Token("NUMBER", str(spec))])
    return Tree(spec[0], [_build(c) for c in spec[1:]])

def run(ast_path, out_path):
    spec = json.loads(Path(ast_path).read_text(encoding="utf-8"))
    tree = _build(spec)
    val = Eval().transform(tree)
    res = {"value": val, "pretty": tree.pretty().strip()}
    Path(out_path).write_text(json.dumps(res, sort_keys=True), encoding="utf-8")
    return res
""",
            "run", ["ast/expr.json", "ast/out.json"],
            {
                "label": "nested_add_mul",
                "files": {"ast/expr.json": json.dumps(["add", ["mul", 4, 5], 12])},
                "env": {},
            },
            {
                "label": "nested_mul_add",
                "files": {"ast/expr.json": json.dumps(["mul", ["add", 3, 7], ["add", 2, 4]])},
                "env": {},
            },
            ["fs-io"],
        )

    # 71. scrapy/cssselect + fs
    pkg = _pkg("scrapy/cssselect", "cssselect")
    if pkg:
        _add_pair(
            "scrapy/cssselect", "cssselect", "html-css", "css_xpath_compile_file", pkg,
            "_oss_probe/css_xpath_fs.py",
            """import json
from pathlib import Path
from cssselect import GenericTranslator

def run(in_path, out_path):
    sels = [ln.strip() for ln in Path(in_path).read_text(encoding="utf-8").splitlines() if ln.strip()]
    tr = GenericTranslator()
    compiled = {s: tr.css_to_xpath(s) for s in sels}
    Path(out_path).write_text(json.dumps(compiled, sort_keys=True), encoding="utf-8")
    return {"count": len(compiled), "compiled": compiled}
""",
            "run", ["sel/rules.txt", "sel/xpaths.json"],
            {
                "label": "article_rules",
                "files": {"sel/rules.txt": "article > h1.title\ndiv.body p:first-child\n"},
                "env": {},
            },
            {
                "label": "form_rules",
                "files": {"sel/rules.txt": "form#login input[name='email']\n"},
                "env": {},
            },
            ["fs-io"],
        )

    # 72. m-lundberg/simple-pid + fs + env
    pkg = _pkg("m-lundberg/simple-pid", "simple_pid")
    if pkg:
        _add_pair(
            "m-lundberg/simple-pid", "simple_pid", "math-science", "pid_thermostat_sim", pkg,
            "_oss_probe/pid_fs.py",
            """import json
import os
from pathlib import Path
from simple_pid import PID

def run(cfg_path, out_path):
    target = float(os.getenv("TARGET_TEMP", "22.0"))
    cfg = json.loads(Path(cfg_path).read_text(encoding="utf-8"))
    pid = PID(cfg["kp"], cfg["ki"], cfg["kd"], setpoint=target, sample_time=None, output_limits=(-5, 5))
    temp = float(cfg["start"])
    trace = []
    for _ in range(cfg["steps"]):
        u = pid(temp, dt=0.2)
        temp += u * 0.2
        trace.append(round(temp, 3))
    res = {"target": target, "final": trace[-1], "trace": trace}
    Path(out_path).write_text(json.dumps(res, sort_keys=True), encoding="utf-8")
    return res
""",
            "run", ["sim/pid.json", "sim/trace.json"],
            {
                "label": "heat_up_24",
                "files": {"sim/pid.json": json.dumps({"kp": 1.8, "ki": 0.3, "kd": 0.05, "start": 18.0, "steps": 6})},
                "env": {"TARGET_TEMP": "24.0"},
            },
            {
                "label": "cool_down_16",
                "files": {"sim/pid.json": json.dumps({"kp": 1.8, "ki": 0.3, "kd": 0.05, "start": 22.0, "steps": 6})},
                "env": {"TARGET_TEMP": "16.0"},
            },
            ["fs-io", "env-io"],
        )

    # 73. python-validators/fqdn + fs + logging
    pkg = _pkg("python-validators/fqdn", "fqdn")
    if pkg:
        _add_pair(
            "python-validators/fqdn", "fqdn", "web-http", "dns_allowlist_audit", pkg,
            "_oss_probe/fqdn_fs.py",
            """import json
import logging
from pathlib import Path
from fqdn import FQDN

def run(hosts_path, out_path):
    hosts = [ln.strip() for ln in Path(hosts_path).read_text(encoding="utf-8").splitlines() if ln.strip()]
    valid, invalid = [], []
    for h in hosts:
        if FQDN(h).is_valid:
            valid.append(h)
        else:
            invalid.append(h)
            logging.warning("invalid fqdn rejected: %s", h)
    res = {"valid": valid, "invalid": invalid}
    Path(out_path).write_text(json.dumps(res, sort_keys=True), encoding="utf-8")
    return res
""",
            "run", ["dns/hosts.txt", "dns/audit.json"],
            {
                "label": "has_invalid_host",
                "files": {"dns/hosts.txt": "api.example.com\nbad_host..local\ncdn.ex.io\n"},
                "env": {},
            },
            {
                "label": "all_valid_hosts",
                "files": {"dns/hosts.txt": "api.example.com\ncdn.ex.io\n"},
                "env": {},
            },
            ["fs-io", "logging"],
        )

    # 74. zytedata/url-matcher + fs
    pkg = _pkg("zytedata/url-matcher", "url_matcher")
    if pkg:
        _add_pair(
            "zytedata/url-matcher", "url_matcher", "web-http", "url_classifier_batch", pkg,
            "_oss_probe/urlm_fs.py",
            """import json
from pathlib import Path
from url_matcher import URLMatcher, Patterns

def run(rules_path, urls_path, out_path):
    rdefs = json.loads(Path(rules_path).read_text(encoding="utf-8"))
    m = URLMatcher()
    for name, cfg in rdefs.items():
        m.add_or_update(name, Patterns(include=cfg["include"], exclude=cfg.get("exclude") or []))
    urls = json.loads(Path(urls_path).read_text(encoding="utf-8"))
    out = [{"url": u, "match": m.match(u)} for u in urls]
    Path(out_path).write_text(json.dumps(out, sort_keys=True), encoding="utf-8")
    return {"matches": out}
""",
            "run", ["u/rules.json", "u/urls.json", "u/out.json"],
            {
                "label": "exclude_reviews",
                "files": {
                    "u/rules.json": json.dumps({"prod": {"include": ["shop.ex.io/p/"], "exclude": ["/reviews"]}}),
                    "u/urls.json": json.dumps(["https://shop.ex.io/p/1", "https://shop.ex.io/p/1/reviews"]),
                },
                "env": {},
            },
            {
                "label": "include_all_products",
                "files": {
                    "u/rules.json": json.dumps({"prod": {"include": ["shop.ex.io/p/"], "exclude": []}}),
                    "u/urls.json": json.dumps(["https://shop.ex.io/p/1", "https://shop.ex.io/p/1/reviews"]),
                },
                "env": {},
            },
            ["fs-io"],
        )

    # 75. dabeaz/ply + fs
    pkg = _pkg("dabeaz/ply", "ply")
    if pkg:
        _add_pair(
            "dabeaz/ply", "ply", "parser-grammar", "ply_lex_script_file", pkg,
            "_oss_probe/ply_fs.py",
            """import json
from pathlib import Path
import ply.lex as lex

class MiniLexer:
    tokens = ("ID", "NUM", "EQ", "PLUS")
    t_EQ = r"="
    t_PLUS = r"\\+"
    t_ignore = " \\t\\n"
    def t_ID(self, t):
        r"[a-zA-Z_][a-zA-Z0-9_]*"
        return t
    def t_NUM(self, t):
        r"\\d+"
        t.value = int(t.value)
        return t
    def t_error(self, t):
        t.lexer.skip(1)

def run(src_path, out_path):
    src = Path(src_path).read_text(encoding="utf-8")
    lx = lex.lex(object=MiniLexer())
    lx.input(src)
    toks = [{"type": t.type, "val": t.value} for t in lx]
    Path(out_path).write_text(json.dumps(toks, sort_keys=True), encoding="utf-8")
    return {"count": len(toks), "tokens": toks}
""",
            "run", ["code/expr.txt", "code/tokens.json"],
            {
                "label": "assign_sum",
                "files": {"code/expr.txt": "total = x + 42\n"},
                "env": {},
            },
            {
                "label": "two_assigns",
                "files": {"code/expr.txt": "a = 1\nb = a + 9\n"},
                "env": {},
            },
            ["fs-io"],
        )

    # 76. kayak/pypika (2nd scenario: sqlite3 JOIN + fs + env!)
    pkg = _pkg("kayak/pypika", "pypika")
    if pkg:
        _add_pair(
            "kayak/pypika", "pypika", "sql", "sqlite_customer_join_audit", pkg,
            "_oss_probe/pypika_join_sql.py",
            """import json
import os
import sqlite3
from pathlib import Path
from pypika import Query, Table, Order, functions as fn

def run(data_path, out_path):
    tier_filter = os.getenv("TIER_FILTER", "pro")
    data = json.loads(Path(data_path).read_text(encoding="utf-8"))
    conn = sqlite3.connect(":memory:")
    conn.execute("CREATE TABLE cust (id INTEGER, name TEXT, tier TEXT)")
    conn.execute("CREATE TABLE ord (id INTEGER, cust_id INTEGER, amt INTEGER)")
    for c in data["customers"]:
        conn.execute("INSERT INTO cust VALUES (?, ?, ?)", (c["id"], c["name"], c["tier"]))
    for o in data["orders"]:
        conn.execute("INSERT INTO ord VALUES (?, ?, ?)", (o["id"], o["cust_id"], o["amt"]))
    c, o = Table("cust"), Table("ord")
    sql = (
        Query.from_(c).join(o).on(c.id == o.cust_id)
        .select(c.name, fn.Sum(o.amt).as_("total"))
        .where(c.tier == tier_filter)
        .groupby(c.name)
        .orderby(c.name, order=Order.asc)
        .get_sql()
    )
    rows = [{"name": r[0], "total": r[1]} for r in conn.execute(sql).fetchall()]
    conn.close()
    res = {"tier": tier_filter, "rows": rows}
    Path(out_path).write_text(json.dumps(res, sort_keys=True), encoding="utf-8")
    return res
""",
            "run", ["db/seed.json", "db/join.json"],
            {
                "label": "pro_tier",
                "files": {"db/seed.json": json.dumps({"customers": [{"id": 1, "name": "ada", "tier": "pro"}, {"id": 2, "name": "bob", "tier": "free"}], "orders": [{"id": 10, "cust_id": 1, "amt": 200}, {"id": 11, "cust_id": 1, "amt": 50}, {"id": 12, "cust_id": 2, "amt": 30}]})},
                "env": {"TIER_FILTER": "pro"},
            },
            {
                "label": "free_tier",
                "files": {"db/seed.json": json.dumps({"customers": [{"id": 1, "name": "ada", "tier": "pro"}, {"id": 2, "name": "bob", "tier": "free"}], "orders": [{"id": 10, "cust_id": 1, "amt": 200}, {"id": 11, "cust_id": 1, "amt": 50}, {"id": 12, "cust_id": 2, "amt": 30}]})},
                "env": {"TIER_FILTER": "free"},
            },
            ["fs-io", "env-io", "sqlite3"],
        )

    # 77. jd/tenacity (2nd scenario: HTTP retry + fs checkpoint!)
    pkg = _pkg("jd/tenacity", "tenacity")
    if pkg:
        _add_pair(
            "jd/tenacity", "tenacity", "resilience", "tenacity_http_checkpoint_sync", pkg,
            "_oss_probe/tenacity_ckpt.py",
            """import json
import logging
import urllib.error
import urllib.request
from pathlib import Path
from tenacity import Retrying, stop_after_attempt, wait_none, retry_if_exception

def run(url, ckpt_path):
    prev = json.loads(Path(ckpt_path).read_text(encoding="utf-8")) if Path(ckpt_path).exists() else {"cursor": 0}
    tries = [0]
    def fetch():
        tries[0] += 1
        with urllib.request.urlopen(url) as resp:
            return json.loads(resp.read().decode("utf-8"))
    r = Retrying(
        stop=stop_after_attempt(3),
        wait=wait_none(),
        retry=retry_if_exception(lambda e: isinstance(e, urllib.error.HTTPError) and e.code >= 500),
        reraise=True,
    )
    try:
        data = r(fetch)
        nxt = {"cursor": prev["cursor"] + len(data["items"]), "items": data["items"]}
        Path(ckpt_path).write_text(json.dumps(nxt, sort_keys=True), encoding="utf-8")
        logging.info("synced cursor=%d tries=%d", nxt["cursor"], tries[0])
        return {"ok": True, "tries": tries[0], "state": nxt}
    except urllib.error.HTTPError as exc:
        logging.error("sync failed code=%d", exc.code)
        return {"ok": False, "tries": tries[0], "code": exc.code, "cursor": prev["cursor"]}
""",
            "run", [f"{base_url}/sync", "state/ckpt.json"],
            {
                "label": "existing_ckpt_retry_ok",
                "files": {"state/ckpt.json": json.dumps({"cursor": 10})},
                "env": {},
                "http_routes": {"/sync": [(503, {"Content-Type": "text/plain"}, b"busy"), (200, {"Content-Type": "application/json"}, b'{"items":["a","b"]}')]},
            },
            {
                "label": "fresh_ckpt_403",
                "files": {},
                "env": {},
                "http_routes": {"/sync": [(403, {"Content-Type": "text/plain"}, b"forbidden")]},
            },
            ["http-io", "fs-io", "logging"],
        )

    # 78. danielfm/pybreaker (2nd scenario: env fail_max threshold + http + fs!)
    pkg = _pkg("danielfm/pybreaker", "pybreaker")
    if pkg:
        _add_pair(
            "danielfm/pybreaker", "pybreaker", "resilience", "breaker_env_threshold_audit", pkg,
            "_oss_probe/breaker_env.py",
            """import json
import os
import urllib.error
import urllib.request
from pathlib import Path
import pybreaker

def run(url, out_path):
    fail_max = int(os.getenv("BREAKER_FAIL_MAX", "2"))
    cb = pybreaker.CircuitBreaker(fail_max=fail_max, reset_timeout=60)
    log = []
    def fetch():
        with urllib.request.urlopen(url) as resp:
            return resp.read().decode("utf-8")
    for _ in range(3):
        try:
            log.append({"ok": True, "val": cb.call(fetch), "state": cb.current_state})
        except pybreaker.CircuitBreakerError:
            log.append({"ok": False, "err": "open", "state": cb.current_state})
        except urllib.error.HTTPError as exc:
            log.append({"ok": False, "err": exc.code, "state": cb.current_state})
    res = {"fail_max": fail_max, "final_state": cb.current_state, "log": log}
    Path(out_path).write_text(json.dumps(res, sort_keys=True), encoding="utf-8")
    return res
""",
            "run", [f"{base_url}/dep", "out/breaker.json"],
            {
                "label": "strict_threshold_1",
                "files": {},
                "env": {"BREAKER_FAIL_MAX": "1"},
                "http_routes": {"/dep": [(500, {"Content-Type": "text/plain"}, b"err"), (200, {"Content-Type": "text/plain"}, b"ok")]},
            },
            {
                "label": "tolerant_threshold_3",
                "files": {},
                "env": {"BREAKER_FAIL_MAX": "3"},
                "http_routes": {"/dep": [(500, {"Content-Type": "text/plain"}, b"err"), (200, {"Content-Type": "text/plain"}, b"ok")]},
            },
            ["http-io", "fs-io", "env-io"],
        )

    # 79. horejsek/python-fastjsonschema (2nd scenario: HTTP webhook payload validation!)
    pkg = _pkg("horejsek/python-fastjsonschema", "fastjsonschema")
    if pkg:
        _add_pair(
            "horejsek/python-fastjsonschema", "fastjsonschema", "data-config", "http_webhook_schema_gate", pkg,
            "_oss_probe/webhook_schema.py",
            """import json
import logging
import urllib.request
from pathlib import Path
import fastjsonschema

def run(webhook_url, schema_path, out_path):
    schema = json.loads(Path(schema_path).read_text(encoding="utf-8"))
    validate = fastjsonschema.compile(schema)
    with urllib.request.urlopen(webhook_url) as resp:
        payload = json.loads(resp.read().decode("utf-8"))
    try:
        validate(payload)
        res = {"accepted": True, "event": payload["event"]}
        logging.info("webhook accepted event=%s", payload["event"])
    except fastjsonschema.JsonSchemaException as exc:
        res = {"accepted": False, "reason": exc.message}
        logging.warning("webhook rejected: %s", exc.message)
    Path(out_path).write_text(json.dumps(res, sort_keys=True), encoding="utf-8")
    return res
""",
            "run", [f"{base_url}/hook", "schemas/hook.json", "out/hook_res.json"],
            {
                "label": "valid_webhook",
                "files": {"schemas/hook.json": json.dumps({"type": "object", "required": ["event", "ts"], "properties": {"event": {"type": "string"}, "ts": {"type": "integer"}}})},
                "env": {},
                "http_routes": {"/hook": (200, {"Content-Type": "application/json"}, b'{"event":"deploy","ts":1710000100}')},
            },
            {
                "label": "malformed_webhook",
                "files": {"schemas/hook.json": json.dumps({"type": "object", "required": ["event", "ts"], "properties": {"event": {"type": "string"}, "ts": {"type": "integer"}}})},
                "env": {},
                "http_routes": {"/hook": (200, {"Content-Type": "application/json"}, b'{"event":"deploy","ts":"not_an_int"}')},
            },
            ["http-io", "fs-io", "logging"],
        )

    # 80. stefankoegl/python-json-patch (2nd scenario: generate RFC 6902 diff between 2 disk configs!)
    pkg = _pkg("stefankoegl/python-json-patch", "jsonpatch", companions=[("stefankoegl/python-json-pointer", "jsonpointer")])
    if pkg:
        _add_pair(
            "stefankoegl/python-json-patch", "jsonpatch", "data-config", "generate_config_patch_file", pkg,
            "_oss_probe/gen_patch.py",
            """import json
import logging
from pathlib import Path
import jsonpatch

def run(old_path, new_path, patch_out):
    old = json.loads(Path(old_path).read_text(encoding="utf-8"))
    new = json.loads(Path(new_path).read_text(encoding="utf-8"))
    ops = sorted(list(jsonpatch.make_patch(old, new)), key=lambda x: (x["op"], x["path"]))
    Path(patch_out).write_text(json.dumps(ops, sort_keys=True), encoding="utf-8")
    logging.info("generated %d patch ops", len(ops))
    return {"changed": bool(ops), "op_count": len(ops), "ops": ops}
""",
            "run", ["cfg/old.json", "cfg/new.json", "cfg/diff.patch.json"],
            {
                "label": "two_changes",
                "files": {
                    "cfg/old.json": json.dumps({"replicas": 2, "debug": True}),
                    "cfg/new.json": json.dumps({"replicas": 4, "debug": False}),
                },
                "env": {},
            },
            {
                "label": "identical_configs",
                "files": {
                    "cfg/old.json": json.dumps({"replicas": 2, "debug": False}),
                    "cfg/new.json": json.dumps({"replicas": 2, "debug": False}),
                },
                "env": {},
            },
            ["fs-io", "logging"],
        )

    # 81. Kozea/cssselect2 (2nd scenario: HTTP XML/XHTML scrape via CSS selector!)
    pkg = _pkg("Kozea/cssselect2", "cssselect2", companions=[("Kozea/tinycss2", "tinycss2"), ("gsnedders/python-webencodings", "webencodings")])
    if pkg:
        _add_pair(
            "Kozea/cssselect2", "cssselect2", "html-css", "http_xhtml_css_scrape", pkg,
            "_oss_probe/css2_http.py",
            """import json
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path
import cssselect2

def run(url, selector, out_path):
    with urllib.request.urlopen(url) as resp:
        xml_text = resp.read().decode("utf-8")
    root = ET.fromstring(xml_text)
    wrap = cssselect2.ElementWrapper.from_xml_root(root)
    vals = [m.etree_element.text or "" for m in wrap.query_all(selector)]
    res = {"count": len(vals), "values": vals}
    Path(out_path).write_text(json.dumps(res, sort_keys=True), encoding="utf-8")
    return res
""",
            "run", [f"{base_url}/status.xml", "service.degraded > name", "out/degraded.json"],
            {
                "label": "one_degraded",
                "files": {},
                "env": {},
                "http_routes": {"/status.xml": (200, {"Content-Type": "application/xml"}, b"<status><service class='ok'><name>api</name></service><service class='degraded'><name>search</name></service></status>")},
            },
            {
                "label": "all_healthy",
                "files": {},
                "env": {},
                "http_routes": {"/status.xml": (200, {"Content-Type": "application/xml"}, b"<status><service class='ok'><name>api</name></service><service class='ok'><name>search</name></service></status>")},
            },
            ["http-io", "fs-io"],
        )

    # 82. pyauth/pyotp (2nd scenario: FS user vault 2FA check!)
    pkg = _pkg("pyauth/pyotp", "pyotp")
    if pkg:
        _add_pair(
            "pyauth/pyotp", "pyotp", "crypto-auth", "vault_hotp_verify", pkg,
            "_oss_probe/vault_hotp.py",
            """import json
import logging
from pathlib import Path
import pyotp

def run(vault_path, user, code, out_path):
    vault = json.loads(Path(vault_path).read_text(encoding="utf-8"))
    rec = vault.get(user)
    if not rec:
        logging.warning("unknown user %s", user)
        return {"ok": False, "reason": "unknown_user"}
    hotp = pyotp.HOTP(rec["secret"])
    ok = hotp.verify(code, rec["counter"])
    if ok:
        rec["counter"] += 1
        Path(vault_path).write_text(json.dumps(vault, sort_keys=True), encoding="utf-8")
        logging.info("hotp accepted user=%s next_counter=%d", user, rec["counter"])
    else:
        logging.warning("hotp rejected user=%s", user)
    res = {"ok": ok, "counter": rec["counter"]}
    Path(out_path).write_text(json.dumps(res, sort_keys=True), encoding="utf-8")
    return res
""",
            "run", ["auth/vault.json", "ada", "287082", "auth/res.json"],
            {
                "label": "counter_matches",
                "files": {"auth/vault.json": json.dumps({"ada": {"secret": "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", "counter": 1}})},
                "env": {},
            },
            {
                "label": "counter_drifted",
                "files": {"auth/vault.json": json.dumps({"ada": {"secret": "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", "counter": 5}})},
                "env": {},
            },
            ["fs-io", "logging"],
        )

    # 83. hynek/structlog (2nd scenario: HTTP health probe + structured JSON log file!)
    pkg = _pkg("hynek/structlog", "structlog")
    if pkg:
        _add_pair(
            "hynek/structlog", "structlog", "workflows", "structlog_http_probe", pkg,
            "_oss_probe/structlog_http.py",
            """import logging
import urllib.error
import urllib.request
from pathlib import Path
import structlog

def run(health_url, log_path):
    entries = []
    def sink(_l, _m, ev):
        entries.append(ev)
        raise structlog.DropEvent
    log = structlog.wrap_logger(
        None,
        processors=[structlog.processors.add_log_level, structlog.processors.JSONRenderer(sort_keys=True), sink],
    )
    try:
        with urllib.request.urlopen(health_url) as resp:
            body = resp.read().decode("utf-8")
        log.info("health_ok", status=200, body=body)
        ok = True
    except urllib.error.HTTPError as exc:
        log.error("health_fail", status=exc.code)
        logging.error("health probe failed %d", exc.code)
        ok = False
    Path(log_path).write_text("\\n".join(entries), encoding="utf-8")
    return {"ok": ok, "entries": entries}
""",
            "run", [f"{base_url}/healthz", "logs/probe.jsonl"],
            {
                "label": "healthy_200",
                "files": {},
                "env": {},
                "http_routes": {"/healthz": (200, {"Content-Type": "text/plain"}, b"ok")},
            },
            {
                "label": "unhealthy_503",
                "files": {},
                "env": {},
                "http_routes": {"/healthz": (503, {"Content-Type": "text/plain"}, b"degraded")},
            },
            ["http-io", "fs-io", "logging"],
        )

    # 84. facelessuser/wcmatch (2nd scenario: directory file classifier via extended globs!)
    pkg = _pkg("facelessuser/wcmatch", "wcmatch", companions=[("facelessuser/bracex", "bracex")])
    if pkg:
        _add_pair(
            "facelessuser/wcmatch", "wcmatch", "packaging-deps", "wcmatch_dir_classify", pkg,
            "_oss_probe/wcmatch_cls.py",
            """import json
import os
from pathlib import Path
from wcmatch import glob

def run(target_dir, out_path):
    names = sorted(os.listdir(target_dir))
    flags = glob.BRACE | glob.NEGATE
    code = [n for n in names if glob.globmatch(n, ["*.{py,ts,js}", "!test_*"], flags=flags)]
    tests = [n for n in names if glob.globmatch(n, ["test_*.py", "*.spec.ts"], flags=flags)]
    res = {"code": code, "tests": tests}
    Path(out_path).write_text(json.dumps(res, sort_keys=True), encoding="utf-8")
    return res
""",
            "run", ["repo", "repo/classified.json"],
            {
                "label": "mixed_repo",
                "files": {"repo/app.py": "x=1", "repo/test_app.py": "x=1", "repo/ui.ts": "x=1", "repo/README.md": "hi"},
                "env": {},
            },
            {
                "label": "tests_only",
                "files": {"repo/test_a.py": "x=1", "repo/b.spec.ts": "x=1", "repo/notes.txt": "hi"},
                "env": {},
            },
            ["fs-io"],
        )

    return scenarios


# ===========================================================================
# Phase 1: Per-Repo Pure Multi-File Harvester (Modes A + B + C1)
# ===========================================================================

def _harvest_one_pure_repo(
    spec: dict[str, Any],
    *,
    cache_dir: Path,
    worker_pool: queue.Queue[_PyWorkerClient],
    forbidden: dict[str, set[str]],
    min_files: int,
    max_files: int,
    max_base_per_repo: int,
    max_mutations_per_repo: int,
    min_tokens: int,
    max_context_tokens: int,
    max_turn_tokens: int,
) -> dict[str, Any]:
    repo_slug = spec["repo"]
    repo_id = _slug(repo_slug.replace("/", "__"))
    pkg_hint = spec.get("package")
    domain = spec.get("domain", "general")
    lic = spec.get("license", "UNKNOWN")
    errors: list[dict[str, Any]] = []

    reason = _repo_is_forbidden(repo_slug, pkg_hint, forbidden)
    if reason:
        return {
            "repo": repo_slug,
            "status": "skipped-forbidden",
            "rows": [],
            "errors": [{"repo": repo_slug, "stage": "filter", "error": reason}],
        }

    repo_dir, clone_err = _clone_repo(repo_slug, cache_dir)
    if repo_dir is None:
        return {
            "repo": repo_slug,
            "status": "clone-failed",
            "rows": [],
            "errors": [{"repo": repo_slug, "stage": "clone", "error": clone_err}],
        }

    comp_specs = spec.get("companion_repos") or []
    comp_files = _load_companion_files(comp_specs, cache_dir) if comp_specs else None

    bundle = _discover_package_bundle(
        repo_dir,
        pkg_hint,
        min_pkg_files=1 if (spec.get("api_probes") or comp_files) else min_files,
        max_single_file_bytes=680_000,
        companion_files=comp_files,
    )
    if bundle is None:
        return {
            "repo": repo_slug,
            "status": "no-valid-package",
            "rows": [],
            "errors": [{"repo": repo_slug, "stage": "discover", "error": "no valid pure-py package"}],
        }

    pkg_name = bundle["pkgName"]
    reason2 = _repo_is_forbidden(repo_slug, pkg_name, forbidden)
    if reason2:
        return {
            "repo": repo_slug,
            "status": "skipped-forbidden-pkg",
            "rows": [],
            "errors": [{"repo": repo_slug, "stage": "filter", "error": reason2}],
        }

    _, test_files = _walk_py_files(repo_dir)
    unit_inputs = extract_unit_test_inputs(repo_dir, test_files)

    candidates: list[dict[str, Any]] = []
    seen_probe_sigs: set[str] = set()
    probe_budget = 140
    probes_used = 0

    # --- Mode A: Real Unit-Test Call-Site Extraction ---
    ordered_entries = sorted(
        bundle["files"].keys(),
        key=lambda rel: (
            0 if any(
                isinstance(s, (ast.FunctionDef, ast.AsyncFunctionDef)) and s.name in unit_inputs
                for s in bundle["trees"][rel].body
            ) else 1,
            -len(bundle["edges"].get(rel, ())),
            rel,
        ),
    )

    mode_a_cands = 0
    for entry_rel in ordered_entries[:30]:
        if mode_a_cands >= max_base_per_repo * 3 or probes_used >= probe_budget // 2:
            break
        selected_files = _build_bounded_file_set(
            bundle, entry_rel=entry_rel, min_files=min_files, max_files=max_files
        )
        if selected_files is None:
            continue
        tree = bundle["trees"][entry_rel]
        mod_slug = _slug(entry_rel[:-3] if entry_rel.endswith(".py") else entry_rel)
        fn_nodes = [
            s for s in tree.body
            if isinstance(s, (ast.FunctionDef, ast.AsyncFunctionDef)) and not s.name.startswith("_") and s.name in unit_inputs
        ]
        for stmt in fn_nodes[:12]:
            if mode_a_cands >= max_base_per_repo * 3 or probes_used >= probe_budget // 2:
                break
            min_a, max_a = _fn_arity_bounds(stmt)
            kept_fn = 0
            for u_entry in unit_inputs.get(stmt.name, [])[:8]:
                if kept_fn >= 3 or probes_used >= probe_budget // 2:
                    break
                enc_args = u_entry["args"]
                enc_kwargs = u_entry.get("kwargs") or {}
                if not enc_kwargs:
                    if not (len(enc_args) >= min_a and (max_a is None or len(enc_args) <= max_a)):
                        continue
                    call_files = selected_files
                    call_entry_file = entry_rel
                    call_entry_name = stmt.name
                    call_args = enc_args
                else:
                    mod_dot, _ = module_name_and_package_for(entry_rel)
                    adapter_rel = f"_oss_test_call/{mod_slug}_{stmt.name}.py"
                    adapter_src = (
                        f'"""Unit-test call-site adapter from `{u_entry["file"]}`."""\n'
                        f"from {mod_dot} import {stmt.name} as _target_fn\n\n"
                        f"def run(pos_args, kw_args):\n"
                        f"    return _target_fn(*pos_args, **kw_args)\n"
                    )
                    call_files = _build_bounded_file_set(
                        bundle,
                        entry_rel=adapter_rel,
                        extra_files={adapter_rel: adapter_src},
                        min_files=min_files,
                        max_files=max_files,
                        require_static_closure=False,
                    )
                    if call_files is None:
                        continue
                    call_entry_file = adapter_rel
                    call_entry_name = "run"
                    call_args = [enc_args, enc_kwargs]

                sig = _sha256([call_entry_file, call_entry_name, call_args])
                if sig in seen_probe_sigs:
                    continue
                seen_probe_sigs.add(sig)
                probes_used += 1
                probe = _probe_multifile(call_files, call_entry_file, call_entry_name, call_args)
                if not probe.get("ok"):
                    continue
                if not (probe.get("touchedFiles") or []):
                    continue
                if probe.get("kind") == "throw":
                    val = (probe.get("result") or {}).get("value")
                    if isinstance(val, dict) and val.get("name") in ("TypeError", "AttributeError", "ImportError", "ModuleNotFoundError"):
                        continue
                recorded = probe.get("recordedCalls") or []
                uses_rand = any(c["operation"] == "platform.random" for c in recorded)
                tid = f"oss3-{repo_id}-ut-{mod_slug}-{stmt.name}-{kept_fn}"[:180]
                candidates.append({
                    "id": tid,
                    "family": f"oss3-py:{repo_id}:ut:{mod_slug}:{stmt.name}",
                    "language": "py",
                    "files": call_files,
                    "entryFile": call_entry_file,
                    "entry": call_entry_name,
                    "args": call_args,
                    "randomMode": "tool" if uses_rand else "seeded",
                    "randomSeed": 17,
                    "fixture": {"calls": recorded},
                    "features": ["multifile-codebase", "code-load", "oss-real-repo", "oss-unit-test", "distractor-files"]
                    + (["effectful"] if recorded else []),
                    "metadata": {
                        "repo": repo_slug,
                        "repoUrl": f"https://github.com/{repo_slug}",
                        "license": lic,
                        "domain": domain,
                        "package": pkg_name,
                        "mode": "mode_a_unit_test",
                        "sourceOrigin": "oss-unit-test",
                        "statefulIo": False,
                        "testFile": u_entry["file"],
                    },
                })
                kept_fn += 1
                mode_a_cands += 1

    # --- Mode B1: Curated Cross-File Public API Probes ---
    for pspec in spec.get("api_probes") or []:
        probe_name = _slug(pspec["name"])
        entry_rel = f"_oss_probe/{probe_name}.py"
        probe_files = _build_bounded_file_set(
            bundle,
            entry_rel=entry_rel,
            extra_files={entry_rel: pspec["code"]},
            min_files=min_files,
            max_files=max_files,
            require_static_closure=False,
        )
        if probe_files is None:
            probe_files = _ensure_min_app_files(bundle["files"], entry_rel, pspec["code"], min_files=min_files)
            if len(probe_files) > max_files:
                errors.append({"repo": repo_slug, "stage": "mode_b_curated", "error": f"{probe_name}: too many files"})
                continue
        for case_tag, raw_args in pspec.get("cases") or []:
            enc_args = encode_readable(raw_args)
            probes_used += 1
            probe = _probe_multifile(probe_files, entry_rel, "run", enc_args)
            if not probe.get("ok"):
                errors.append({"repo": repo_slug, "stage": "mode_b_curated", "error": f"{probe_name}/{case_tag}: {probe.get('error')}"})
                continue
            if probe.get("kind") == "throw":
                val = (probe.get("result") or {}).get("value")
                errors.append({"repo": repo_slug, "stage": "mode_b_curated", "error": f"{probe_name}/{case_tag}: threw {val}"})
                continue
            if not (probe.get("touchedFiles") or []):
                errors.append({"repo": repo_slug, "stage": "mode_b_curated", "error": f"{probe_name}/{case_tag}: 0 touched non-entry files"})
                continue
            recorded = probe.get("recordedCalls") or []
            uses_rand = any(c["operation"] == "platform.random" for c in recorded)
            tid = f"oss3-{repo_id}-api-{probe_name}-{_slug(case_tag)}"[:180]
            candidates.append({
                "id": tid,
                "family": f"oss3-py:{repo_id}:api:{probe_name}",
                "language": "py",
                "files": probe_files,
                "entryFile": entry_rel,
                "entry": "run",
                "args": enc_args,
                "randomMode": "tool" if uses_rand else "seeded",
                "randomSeed": 17,
                "fixture": {"calls": recorded},
                "features": ["multifile-codebase", "code-load", "oss-real-repo", "oss-api-probe", "distractor-files"]
                + (["effectful"] if recorded else []),
                "metadata": {
                    "repo": repo_slug,
                    "repoUrl": f"https://github.com/{repo_slug}",
                    "license": lic,
                    "domain": domain,
                    "package": pkg_name,
                    "mode": "mode_b_api_probe",
                    "sourceOrigin": "oss-api-probe-curated",
                    "statefulIo": False,
                },
            })

    # --- Mode B2: Automatic Public Cross-File Function Probes ---
    if len(candidates) < max_base_per_repo * 2:
        for entry_rel in ordered_entries[:20]:
            if len(candidates) >= max_base_per_repo * 3 or probes_used >= probe_budget:
                break
            selected_files = _build_bounded_file_set(
                bundle, entry_rel=entry_rel, min_files=min_files, max_files=max_files
            )
            if selected_files is None:
                continue
            tree = bundle["trees"][entry_rel]
            mod_slug = _slug(entry_rel[:-3] if entry_rel.endswith(".py") else entry_rel)
            fn_nodes = [
                s for s in tree.body
                if isinstance(s, (ast.FunctionDef, ast.AsyncFunctionDef)) and not s.name.startswith("_")
            ]
            for stmt in fn_nodes[:10]:
                if len(candidates) >= max_base_per_repo * 3 or probes_used >= probe_budget:
                    break
                min_a, max_a = _fn_arity_bounds(stmt)
                if min_a > 3:
                    continue
                kept_fn = 0
                for raw_args in _smart_probes_for_fn(stmt, min_a, max_a)[:5]:
                    if kept_fn >= 2 or probes_used >= probe_budget:
                        break
                    enc_args = encode_readable(raw_args)
                    sig = _sha256([entry_rel, stmt.name, enc_args])
                    if sig in seen_probe_sigs:
                        continue
                    seen_probe_sigs.add(sig)
                    probes_used += 1
                    probe = _probe_multifile(selected_files, entry_rel, stmt.name, enc_args)
                    if not probe.get("ok"):
                        continue
                    if not (probe.get("touchedFiles") or []):
                        continue
                    if probe.get("kind") == "throw":
                        val = (probe.get("result") or {}).get("value")
                        if isinstance(val, dict) and val.get("name") in ("TypeError", "AttributeError", "ImportError", "ModuleNotFoundError"):
                            continue
                    recorded = probe.get("recordedCalls") or []
                    uses_rand = any(c["operation"] == "platform.random" for c in recorded)
                    tid = f"oss3-{repo_id}-auto-{mod_slug}-{stmt.name}-{kept_fn}"[:180]
                    candidates.append({
                        "id": tid,
                        "family": f"oss3-py:{repo_id}:auto:{mod_slug}:{stmt.name}",
                        "language": "py",
                        "files": selected_files,
                        "entryFile": entry_rel,
                        "entry": stmt.name,
                        "args": enc_args,
                        "randomMode": "tool" if uses_rand else "seeded",
                        "randomSeed": 17,
                        "fixture": {"calls": recorded},
                        "features": ["multifile-codebase", "code-load", "oss-real-repo", "oss-api-probe", "distractor-files"]
                        + (["effectful"] if recorded else []),
                        "metadata": {
                            "repo": repo_slug,
                            "repoUrl": f"https://github.com/{repo_slug}",
                            "license": lic,
                            "domain": domain,
                            "package": pkg_name,
                            "mode": "mode_b_api_probe",
                            "sourceOrigin": "oss-api-probe-auto",
                            "statefulIo": False,
                        },
                    })
                    kept_fn += 1

    # --- Verify Mode A & Mode B Candidates (2x cross-seed 101 vs 202 + live replay) ---
    def _cand_priority(t: dict[str, Any]) -> tuple[int, str]:
        orig = (t.get("metadata") or {}).get("sourceOrigin", "")
        if orig == "oss-unit-test":
            return (0, t["id"])
        if orig == "oss-api-probe-curated":
            return (1, t["id"])
        return (2, t["id"])

    candidates.sort(key=_cand_priority)
    verified_base: list[dict[str, Any]] = []
    fn_counts: dict[str, int] = {}
    seen_dedup: set[tuple[str, str]] = set()

    for cand in candidates:
        if len(verified_base) >= max_base_per_repo:
            break
        fam = cand["family"]
        if fn_counts.get(fam, 0) >= 3:
            continue
        row, err = _verify_and_preexport_task(
            cand,
            worker_pool,
            forbidden,
            min_tokens=min_tokens,
            max_context_tokens=max_context_tokens,
            max_turn_tokens=max_turn_tokens,
            min_files=min_files,
            max_files=max_files,
        )
        if row is None:
            errors.append({"repo": repo_slug, "id": cand["id"], "stage": "verify", "error": err})
            continue
        input_sig = _sha256([cand["entryFile"], cand["entry"], cand["args"], cand["fixture"]])
        dkey = (row["sourceHash"], input_sig)
        if dkey in seen_dedup:
            continue
        seen_dedup.add(dkey)
        fn_counts[fam] = fn_counts.get(fam, 0) + 1
        verified_base.append(row)

    # --- Mode C1: Real-World 1-Line AST-Mutation Counterfactual Pairs ---
    verified_base_for_mut = sorted(
        verified_base,
        key=lambda r: (
            0 if TARGET_CODEBASE_MIN_TOKENS <= r["metadata"]["codebaseTokens"] <= TARGET_CODEBASE_MAX_TOKENS else 1,
            -r["metadata"]["loadedFileCount"],
            -r["metadata"]["contextTokens"],
        ),
    )

    verified_mutations: list[dict[str, Any]] = []
    for base_row in verified_base_for_mut:
        if len(verified_mutations) >= max_mutations_per_repo:
            break
        base_task = base_row["task"]
        base_files = base_task["files"]
        entry_file = base_task["entryFile"]
        base_fmt = base_row["metadata"].get("traceFormat", "compact")

        line_probe = _probe_multifile(
            base_files, entry_file, base_task["entry"], base_task["args"], collect_lines=True
        )
        if not line_probe.get("ok"):
            continue
        exec_lines_map: dict[str, list[int]] = line_probe.get("executedLines") or {}
        if not exec_lines_map:
            continue

        orig_comp = _extract_final_completion(base_row["messages"])
        orig_outcome_sig = _json_compact([orig_comp.get("kind"), orig_comp.get("value")])

        target_files = sorted(
            exec_lines_map.keys(),
            key=lambda p: (1 if p.endswith("/__init__.py") else 0, -len(exec_lines_map[p]), p),
        )

        mutated_found = False
        attempts = 0
        for target_rel in target_files[:6]:
            if mutated_found or attempts >= 18:
                break
            src = base_files.get(target_rel)
            if not src:
                continue
            mut_cands = _enumerate_1line_ast_mutations(src, set(exec_lines_map[target_rel]), max_candidates=12)
            for mc in mut_cands:
                if mutated_found or attempts >= 18:
                    break
                attempts += 1
                mut_files = dict(base_files)
                mut_files[target_rel] = mc["source"]

                mprobe = _probe_multifile(mut_files, entry_file, base_task["entry"], base_task["args"])
                if not mprobe.get("ok"):
                    continue
                if target_rel not in (mprobe.get("touchedFiles") or []):
                    continue
                if mprobe.get("kind") == "throw":
                    val = (mprobe.get("result") or {}).get("value")
                    if isinstance(val, dict) and val.get("name") in ("SyntaxError", "IndentationError", "ImportError", "ModuleNotFoundError", "TimeoutError"):
                        continue
                mut_probe_sig = _json_compact([mprobe.get("kind"), (mprobe.get("result") or {}).get("value")])
                if mut_probe_sig == orig_outcome_sig:
                    continue

                m_recorded = mprobe.get("recordedCalls") or []
                m_uses_rand = any(c["operation"] == "platform.random" for c in m_recorded)
                pair_id = f"oss3-mut-pair:{repo_id}:{_sha256([base_row['id'], target_rel, mc['lineno'], mc['kind']])[:10]}"
                mut_tid = f"{base_row['id']}--mut-L{mc['lineno']}"[:200]
                mut_task = {
                    "id": mut_tid,
                    "family": f"{base_row['family']}:mut",
                    "language": "py",
                    "files": mut_files,
                    "entryFile": entry_file,
                    "entry": base_task["entry"],
                    "args": base_task["args"],
                    "randomMode": "tool" if m_uses_rand else "seeded",
                    "randomSeed": 17,
                    "fixture": {"calls": m_recorded},
                    "features": sorted(set([*(base_task.get("features") or []), "causal-pair", "oss-mutation-pair"])),
                    "metadata": {
                        "repo": repo_slug,
                        "repoUrl": f"https://github.com/{repo_slug}",
                        "license": lic,
                        "domain": domain,
                        "package": pkg_name,
                        "mode": "mode_c_mutation_pair",
                        "sourceOrigin": "oss-mutation-pair",
                        "statefulIo": False,
                        "pairId": pair_id,
                        "pairedBaseTaskId": base_row["id"],
                        "mutationFile": target_rel,
                        "mutationLine": mc["lineno"],
                        "mutationKind": mc["kind"],
                        "mutationBefore": mc["before"][:240],
                        "mutationAfter": mc["after"][:240],
                        "mutationSameByteLength": mc["sameByteLength"],
                    },
                }
                mut_row, merr = _verify_and_preexport_task(
                    mut_task,
                    worker_pool,
                    forbidden,
                    min_tokens=min_tokens,
                    max_context_tokens=max_context_tokens,
                    max_turn_tokens=max_turn_tokens,
                    min_files=min_files,
                    max_files=max_files,
                    forced_trace_format=base_fmt,
                )
                if mut_row is None:
                    errors.append({"repo": repo_slug, "id": mut_tid, "stage": "verify_mut", "error": merr})
                    continue

                mut_comp = _extract_final_completion(mut_row["messages"])
                if _json_compact([mut_comp.get("kind"), mut_comp.get("value")]) == orig_outcome_sig:
                    continue
                if mut_row["sourceHash"] == base_row["sourceHash"]:
                    continue

                b_pref = next(i for i, m in enumerate(base_row["messages"]) if m.get("role") == "user") + 1
                m_pref = next(i for i, m in enumerate(mut_row["messages"]) if m.get("role") == "user") + 1
                identical_prompt = (b_pref == m_pref) and (base_row["messages"][:b_pref] == mut_row["messages"][:m_pref])
                mut_row["metadata"]["identicalInitialPrompt"] = identical_prompt
                mut_row["pair_id"] = pair_id

                base_row["pair_id"] = pair_id
                base_row["metadata"]["pairId"] = pair_id
                base_row["metadata"]["pairedMutTaskId"] = mut_row["id"]
                base_row["metadata"]["identicalInitialPrompt"] = identical_prompt
                if "causal-pair" not in (base_row["task"].get("features") or []):
                    base_row["task"]["features"] = sorted(set([*(base_row["task"].get("features") or []), "causal-pair", "oss-mutation-pair-base"]))
                    base_row["metadata"]["features"] = list(base_row["task"]["features"])

                verified_mutations.append(mut_row)
                mutated_found = True

    all_rows = [*verified_base, *verified_mutations]
    return {
        "repo": repo_slug,
        "package": pkg_name,
        "domain": domain,
        "license": lic,
        "status": "ok" if all_rows else "no-verified-tasks",
        "rows": all_rows,
        "counts": {
            "mode_a": sum(1 for r in all_rows if r["metadata"].get("mode") == "mode_a_unit_test"),
            "mode_b": sum(1 for r in all_rows if r["metadata"].get("mode") == "mode_b_api_probe"),
            "mode_c": len(verified_mutations),
        },
        "errors": errors,
    }


# ===========================================================================
# Phase 2: Stateful-I/O Real-World OSS Harvester (Mode B-Stateful + Mode C2)
# ===========================================================================

def _harvest_stateful_scenarios(
    cache_dir: Path,
    worker_pool: queue.Queue[_PyWorkerClient],
    forbidden: dict[str, set[str]],
    *,
    min_files: int,
    max_files: int,
    max_context_tokens: int,
    max_turn_tokens: int,
    stateful_cache_dir: Path,
    resume: bool,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    errors: list[dict[str, Any]] = []
    rows_out: list[dict[str, Any]] = []
    stateful_cache_dir.mkdir(parents=True, exist_ok=True)

    http_server = _DeterministicHttpServer()
    http_server.start()
    try:
        scenarios = build_stateful_scenarios(cache_dir, http_server, forbidden, errors)
        print(f"[oss-py-wave3] stateful track: {len(scenarios)} causal pair scenarios built", file=sys.stderr, flush=True)

        for idx, scen in enumerate(scenarios, 1):
            repo_slug = scen["repo"]
            slug = scen["slug"]
            repo_id = _slug(repo_slug.replace("/", "__"))
            ckpt = stateful_cache_dir / f"{repo_id}__{slug}.json"
            if resume and ckpt.is_file():
                try:
                    cached = json.loads(ckpt.read_text(encoding="utf-8"))
                    rows_out.extend(cached.get("rows") or [])
                    continue
                except Exception:
                    pass

            scen_errors: list[dict[str, Any]] = []
            variant_rows: list[dict[str, Any]] = []
            scen_ok = True
            for var in scen["variants"]:
                tid = f"oss3-stateful-{repo_id}-{slug}-{var['label']}"[:180]
                if var.get("http_routes"):
                    http_server.set_routes(var["http_routes"])
                else:
                    http_server.set_routes({})
                try:
                    probe = _probe_multifile(
                        scen["files"],
                        scen["entry_file"],
                        scen["entry"],
                        encode_readable(scen["args"]),
                        world_files=var.get("files") or {},
                        world_env=var.get("env") or {},
                        init_git=bool(var.get("init_git", False)),
                        stateful_mode=True,
                    )
                    if not probe.get("ok"):
                        raise RuntimeError(f"live probe failed: {probe.get('error')}")
                    recorded = probe.get("recordedCalls") or []
                    if not recorded:
                        raise RuntimeError("0 recorded external I/O calls")
                    if not (probe.get("touchedFiles") or []):
                        raise RuntimeError("0 touched non-entry package files")

                    task_obj = {
                        "id": tid,
                        "family": f"oss3-stateful-py:{repo_id}:{slug}",
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
                            "repo": repo_slug,
                            "repoUrl": f"https://github.com/{repo_slug}",
                            "package": scen["package"],
                            "domain": scen["domain"],
                            "scenario": slug,
                            "variant": var["label"],
                            "mode": "mode_c_stateful_pair",
                            "sourceOrigin": "oss-stateful-io-pair",
                            "statefulIo": True,
                            "pairId": scen["pair_id"],
                            "touchedNonEntryFiles": probe.get("touchedFiles") or [],
                        },
                    }
                    exported, verr = _verify_and_preexport_task(
                        task_obj,
                        worker_pool,
                        forbidden,
                        min_tokens=1000,
                        max_context_tokens=max_context_tokens,
                        max_turn_tokens=max_turn_tokens,
                        min_files=min_files,
                        max_files=max_files,
                        require_external_io=True,
                    )
                    if exported is None:
                        raise RuntimeError(f"verify2x failed: {verr}")
                    exported["pair_id"] = scen["pair_id"]
                    variant_rows.append(exported)
                except Exception as exc:
                    scen_errors.append({"repo": repo_slug, "slug": slug, "variant": var["label"], "stage": "stateful", "error": str(exc)})
                    scen_ok = False
                    break

            admitted_pair: list[dict[str, Any]] = []
            if scen_ok and len(variant_rows) == 2:
                ex_a, ex_b = variant_rows
                fmt_a = ex_a["metadata"].get("traceFormat", "compact")
                fmt_b = ex_b["metadata"].get("traceFormat", "compact")
                if fmt_a != fmt_b:
                    ex_a2, ea = _verify_and_preexport_task(
                        ex_a["task"], worker_pool, forbidden,
                        min_tokens=1000, max_context_tokens=max_context_tokens,
                        max_turn_tokens=max_turn_tokens, min_files=min_files, max_files=max_files,
                        require_external_io=True, forced_trace_format="actions-only",
                    )
                    ex_b2, eb = _verify_and_preexport_task(
                        ex_b["task"], worker_pool, forbidden,
                        min_tokens=1000, max_context_tokens=max_context_tokens,
                        max_turn_tokens=max_turn_tokens, min_files=min_files, max_files=max_files,
                        require_external_io=True, forced_trace_format="actions-only",
                    )
                    if ex_a2 and ex_b2:
                        ex_a2["pair_id"] = scen["pair_id"]
                        ex_b2["pair_id"] = scen["pair_id"]
                        ex_a, ex_b = ex_a2, ex_b2
                    else:
                        scen_errors.append({"repo": repo_slug, "slug": slug, "stage": "pair_align", "error": f"{ea} | {eb}"})
                        ex_a = ex_b = None  # type: ignore[assignment]

                if ex_a is not None and ex_b is not None:
                    try:
                        pair_audit = _audit_causal_prefix_pair(ex_a["messages"], ex_b["messages"])
                        if not pair_audit.get("testedDivergence"):
                            raise RuntimeError("did not diverge on external observations")
                        ex_a["metadata"]["causalPairAudit"] = pair_audit
                        ex_b["metadata"]["causalPairAudit"] = pair_audit
                        admitted_pair = [ex_a, ex_b]
                    except Exception as exc:
                        # Retry pair cleanly with actions-only
                        ex_a2, ea = _verify_and_preexport_task(
                            ex_a["task"], worker_pool, forbidden,
                            min_tokens=1000, max_context_tokens=max_context_tokens,
                            max_turn_tokens=max_turn_tokens, min_files=min_files, max_files=max_files,
                            require_external_io=True, forced_trace_format="actions-only",
                        )
                        ex_b2, eb = _verify_and_preexport_task(
                            ex_b["task"], worker_pool, forbidden,
                            min_tokens=1000, max_context_tokens=max_context_tokens,
                            max_turn_tokens=max_turn_tokens, min_files=min_files, max_files=max_files,
                            require_external_io=True, forced_trace_format="actions-only",
                        )
                        if ex_a2 and ex_b2:
                            try:
                                ex_a2["pair_id"] = scen["pair_id"]
                                ex_b2["pair_id"] = scen["pair_id"]
                                pair_audit = _audit_causal_prefix_pair(ex_a2["messages"], ex_b2["messages"])
                                if not pair_audit.get("testedDivergence"):
                                    raise RuntimeError("did not diverge on external observations (actions-only)")
                                ex_a2["metadata"]["causalPairAudit"] = pair_audit
                                ex_b2["metadata"]["causalPairAudit"] = pair_audit
                                admitted_pair = [ex_a2, ex_b2]
                            except Exception as exc2:
                                scen_errors.append({"repo": repo_slug, "slug": slug, "stage": "causal_audit", "error": f"{exc} | {exc2}"})
                        else:
                            scen_errors.append({"repo": repo_slug, "slug": slug, "stage": "causal_audit_retry", "error": f"{exc} | {ea} | {eb}"})

            try:
                ckpt.write_text(_json_compact({"repo": repo_slug, "slug": slug, "rows": admitted_pair, "errors": scen_errors}), encoding="utf-8")
            except Exception:
                pass
            errors.extend(scen_errors)
            rows_out.extend(admitted_pair)
            print(
                f"  [stateful {idx}/{len(scenarios)}] {repo_slug}/{slug}: admitted={len(admitted_pair)} "
                f"(cum_stateful={len(rows_out)})" + (f" err={scen_errors[0]['error'][:90]}" if scen_errors and not admitted_pair else ""),
                file=sys.stderr,
                flush=True,
            )
    finally:
        http_server.stop()

    return rows_out, errors


# ===========================================================================
# Main Orchestrator & 5-Axis Zero-Leakage + Stage 10 0-Dupe Audit
# ===========================================================================

def main(argv: list[str] | None = None) -> int:
    os.environ["PYTHONHASHSEED"] = HASH_SEED_PASS1

    parser = argparse.ArgumentParser(
        description="Real-World OSS Wave 3 (Python) Harvester: Pure Multi-File + Stateful-I/O + Counterfactuals."
    )
    parser.add_argument("--output-dir", default=str(DEFAULT_OUTPUT_DIR))
    parser.add_argument("--cache-dir", default=str(DEFAULT_CACHE_DIR))
    parser.add_argument("--jobs", type=int, default=10)
    parser.add_argument("--max-repos", type=int, default=0, help="Limit pure catalog repos (0 = all).")
    parser.add_argument("--repos", default="", help="Optional comma-separated subset of owner/repo slugs.")
    parser.add_argument("--skip-pure", action="store_true")
    parser.add_argument("--skip-stateful", action="store_true")
    parser.add_argument("--max-base-per-repo", type=int, default=6)
    parser.add_argument("--max-mutations-per-repo", type=int, default=2)
    parser.add_argument("--min-files", type=int, default=5)
    parser.add_argument("--max-files", type=int, default=220)
    parser.add_argument("--min-tokens", type=int, default=1500)
    parser.add_argument("--max-context-tokens", type=int, default=MAX_EPISODE_CONTEXT_TOKENS)
    parser.add_argument("--max-turn-tokens", type=int, default=MAX_SINGLE_TURN_TOKENS)
    parser.add_argument("--resume", dest="resume", action="store_true", default=True)
    parser.add_argument("--no-resume", dest="resume", action="store_false")
    parser.add_argument("--realexec-benchmark", default=str(DEFAULT_REALEXEC_BENCHMARK))
    parser.add_argument("--realexec-manifest", default=str(DEFAULT_REALEXEC_MANIFEST))
    parser.add_argument("--stage10-oss-merged", default=str(DEFAULT_STAGE10_OSS_MERGED))
    parser.add_argument("--stage10-merged", default=str(DEFAULT_STAGE10_MERGED))
    args = parser.parse_args(argv)

    started = datetime.now(timezone.utc).isoformat()
    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    repo_cache_dir = output_dir / "repo_cache"
    repo_cache_dir.mkdir(parents=True, exist_ok=True)
    stateful_cache_dir = output_dir / "stateful_cache"
    cache_dir = Path(args.cache_dir).resolve()

    forbidden = _load_forbidden_sets(
        Path(args.realexec_benchmark),
        Path(args.realexec_manifest),
        Path(args.stage10_oss_merged),
        Path(args.stage10_merged),
    )

    # Deduplicate catalog cleanly by normalized owner/repo (preferring entries with api_probes/companions)
    dedup_by_repo: dict[str, dict[str, Any]] = {}
    dedup_order: list[str] = []
    for sp in REPO_CATALOG:
        rn = _norm_repo(sp["repo"])
        if _repo_is_forbidden(sp["repo"], sp.get("package"), forbidden) is not None:
            continue
        if rn not in dedup_by_repo:
            dedup_by_repo[rn] = dict(sp)
            dedup_order.append(rn)
        else:
            prev = dedup_by_repo[rn]
            if sp.get("api_probes") and not prev.get("api_probes"):
                dedup_by_repo[rn] = dict(sp)
            elif sp.get("api_probes") and prev.get("api_probes"):
                prev["api_probes"] = [*prev["api_probes"], *sp["api_probes"]]
            if sp.get("companion_repos") and not dedup_by_repo[rn].get("companion_repos"):
                dedup_by_repo[rn]["companion_repos"] = sp["companion_repos"]
    dedup_catalog = [dedup_by_repo[rn] for rn in dedup_order]

    catalog = dedup_catalog
    if args.repos.strip():
        wanted = {_norm_repo(r) for r in args.repos.split(",") if r.strip()}
        catalog = [s for s in catalog if _norm_repo(s["repo"]) in wanted]
    if args.max_repos and args.max_repos > 0:
        catalog = catalog[: args.max_repos]

    print(
        f"[oss-py-wave3] clean_catalog={len(catalog)} repos | jobs={args.jobs} | "
        f"forbidden reb_ids={len(forbidden['reb_ids'])}, reb_pkgs={len(forbidden['reb_pkgs'])}, "
        f"stage10_ids={len(forbidden['stage10_ids'])}, stage10_hashes={len(forbidden['stage10_hashes'])}, "
        f"stage10_pkgs={len(forbidden['stage10_pkgs'])}",
        file=sys.stderr,
        flush=True,
    )

    jobs = max(1, min(12, args.jobs))
    errors_path = output_dir / "errors.jsonl"
    errors_lock = threading.Lock()

    def _log_errors(err_list: list[dict[str, Any]]) -> None:
        if not err_list:
            return
        with errors_lock:
            with errors_path.open("a", encoding="utf-8") as fh:
                for e in err_list:
                    fh.write(_json_compact(e) + "\n")

    worker_pool: queue.Queue[_PyWorkerClient] = queue.Queue()
    workers = [_PyWorkerClient(hash_seed=HASH_SEED_PASS2) for _ in range(jobs)]
    for w in workers:
        worker_pool.put(w)

    repo_results: dict[str, dict[str, Any]] = {}
    stateful_rows: list[dict[str, Any]] = []

    try:
        # -------------------------------------------------------------------
        # Phase 1: Pure Multi-File Real-World OSS Track (Modes A + B + C1)
        # -------------------------------------------------------------------
        if not args.skip_pure:
            pending_specs: list[dict[str, Any]] = []
            for spec in catalog:
                ckpt = repo_cache_dir / f"{_slug(spec['repo'].replace('/', '__'))}.json"
                if args.resume and ckpt.is_file():
                    try:
                        repo_results[spec["repo"]] = json.loads(ckpt.read_text(encoding="utf-8"))
                        continue
                    except Exception:
                        pass
                pending_specs.append(spec)

            if repo_results:
                print(f"[oss-py-wave3] resumed {len(repo_results)} cached pure repos; {len(pending_specs)} pending", file=sys.stderr, flush=True)

            if pending_specs:
                def _run_spec(spec: dict[str, Any]) -> dict[str, Any]:
                    try:
                        res = _harvest_one_pure_repo(
                            spec,
                            cache_dir=cache_dir,
                            worker_pool=worker_pool,
                            forbidden=forbidden,
                            min_files=args.min_files,
                            max_files=args.max_files,
                            max_base_per_repo=args.max_base_per_repo,
                            max_mutations_per_repo=args.max_mutations_per_repo,
                            min_tokens=args.min_tokens,
                            max_context_tokens=args.max_context_tokens,
                            max_turn_tokens=args.max_turn_tokens,
                        )
                    except Exception as exc:
                        res = {
                            "repo": spec["repo"],
                            "status": "crash",
                            "rows": [],
                            "errors": [{"repo": spec["repo"], "stage": "unhandled", "error": f"{type(exc).__name__}: {exc}"}],
                        }
                    ckpt = repo_cache_dir / f"{_slug(spec['repo'].replace('/', '__'))}.json"
                    try:
                        ckpt.write_text(_json_compact(res), encoding="utf-8")
                    except Exception:
                        pass
                    _log_errors(res.get("errors") or [])
                    return res

                with concurrent.futures.ThreadPoolExecutor(max_workers=jobs) as pool:
                    fut_map = {pool.submit(_run_spec, sp): sp for sp in pending_specs}
                    done = 0
                    ok_repos = sum(1 for r in repo_results.values() if r.get("rows"))
                    total_rows_so_far = sum(len(r.get("rows") or []) for r in repo_results.values())
                    for fut in concurrent.futures.as_completed(fut_map):
                        sp = fut_map[fut]
                        res = fut.result()
                        repo_results[sp["repo"]] = res
                        done += 1
                        n_rows = len(res.get("rows") or [])
                        if n_rows > 0:
                            ok_repos += 1
                            total_rows_so_far += n_rows
                        if done % 5 == 0 or done == len(pending_specs) or n_rows > 0:
                            c = res.get("counts") or {}
                            print(
                                f"  [pure {done}/{len(pending_specs)}] {sp['repo']}: status={res.get('status')} "
                                f"rows={n_rows} (A={c.get('mode_a',0)}, B={c.get('mode_b',0)}, C={c.get('mode_c',0)}) "
                                f"| cum repos={ok_repos}, pure_tasks={total_rows_so_far}",
                                file=sys.stderr,
                                flush=True,
                            )

        # -------------------------------------------------------------------
        # Phase 2: Messy Real-World Stateful-I/O Python OSS Track
        # -------------------------------------------------------------------
        if not args.skip_stateful:
            stateful_rows, st_errors = _harvest_stateful_scenarios(
                cache_dir=cache_dir,
                worker_pool=worker_pool,
                forbidden=forbidden,
                min_files=args.min_files,
                max_files=args.max_files,
                max_context_tokens=args.max_context_tokens,
                max_turn_tokens=args.max_turn_tokens,
                stateful_cache_dir=stateful_cache_dir,
                resume=args.resume,
            )
            _log_errors(st_errors)
    finally:
        for w in workers:
            w.close()

    # -----------------------------------------------------------------------
    # Global Deterministic Merge, Deduplication, 5-Axis Zero-Leakage & Causal Audit
    # -----------------------------------------------------------------------
    final_rows: list[dict[str, Any]] = []
    seen_ids: set[str] = set()
    seen_source_input: set[tuple[str, str]] = set()

    def _admit_row(row: dict[str, Any]) -> None:
        if not _is_preexported_row(row):
            return
        tid = row["id"]
        if tid in seen_ids:
            return
        t = row["task"]
        input_sig = _sha256([t["entryFile"], t["entry"], t["args"], t["fixture"]])
        dkey = (row["sourceHash"], input_sig)
        if dkey in seen_source_input:
            return
        sc = row.get("split_component") or _sha256(f"{row['family']}:{row['sourceHash']}")
        row["split_component"] = sc
        m = row.get("metadata") or {}
        if _repo_is_forbidden(str(m.get("repo", "")), str(m.get("package", "")), forbidden) is not None:
            return
        if (
            tid in forbidden["reb_ids"]
            or row["family"] in forbidden["reb_families"]
            or row["sourceHash"] in forbidden["reb_hashes"]
            or sc in forbidden["reb_splits"]
            or tid in forbidden["stage10_ids"]
            or row["sourceHash"] in forbidden["stage10_hashes"]
        ):
            return
        seen_ids.add(tid)
        seen_source_input.add(dkey)
        final_rows.append(row)

    for spec in catalog:
        res = repo_results.get(spec["repo"])
        if res:
            for row in res.get("rows") or []:
                _admit_row(row)
    for row in stateful_rows:
        _admit_row(row)

    # 5-Axis Zero-Leakage Audit vs RealExecBench v1
    reb_overlap = {
        "id": sum(1 for r in final_rows if r["id"] in forbidden["reb_ids"]),
        "family": sum(1 for r in final_rows if r["family"] in forbidden["reb_families"]),
        "sourceHash": sum(1 for r in final_rows if r["sourceHash"] in forbidden["reb_hashes"]),
        "split_component": sum(1 for r in final_rows if r["split_component"] in forbidden["reb_splits"]),
        "repo_or_package": sum(
            1 for r in final_rows
            if _norm_repo(str(r["metadata"].get("repo", ""))) in forbidden["reb_repos"]
            or str(r["metadata"].get("package", "")).lower().removesuffix(".py") in forbidden["reb_pkgs"]
        ),
    }
    # 0-Dupe Audit vs Stage 10 (stage10-oss-merged.jsonl + stage10-merged.jsonl)
    stage10_overlap = {
        "id": sum(1 for r in final_rows if r["id"] in forbidden["stage10_ids"]),
        "sourceHash": sum(1 for r in final_rows if r["sourceHash"] in forbidden["stage10_hashes"]),
        "repo": sum(1 for r in final_rows if _norm_repo(str(r["metadata"].get("repo", ""))) in forbidden["stage10_repos"]),
        "package": sum(
            1 for r in final_rows
            if str(r["metadata"].get("package", "")).lower().removesuffix(".py") in forbidden["stage10_pkgs"]
        ),
    }
    assert all(v == 0 for v in reb_overlap.values()), f"RealExecBench leakage detected: {reb_overlap}"
    assert all(v == 0 for v in stage10_overlap.values()), f"Stage 10 overlap detected: {stage10_overlap}"
    assert all(_is_preexported_row(r) for r in final_rows), "Invalid pre-exported row!"
    assert all(int(r["metadata"]["contextTokens"]) <= args.max_context_tokens for r in final_rows), "Context token budget exceeded!"
    assert all(int(r["metadata"]["maxTurnTokens"]) <= args.max_turn_tokens for r in final_rows), "Turn token budget exceeded!"
    assert all(args.min_files <= int(r["metadata"]["fileCount"]) <= args.max_files for r in final_rows), "File count out of bounds!"

    # Causal supervision audit on sample of identical-prompt Mode C1 mutation pairs
    identical_mut_pair_ids = {
        r["metadata"]["pairId"]
        for r in final_rows
        if r["metadata"].get("mode") == "mode_c_mutation_pair" and r["metadata"].get("identicalInitialPrompt")
    }
    causal_sample_rows = [
        r for r in final_rows
        if r["metadata"].get("pairId") in sorted(identical_mut_pair_ids)[:10]
        and r["metadata"].get("traceFormat") == "compact"
    ]
    causal_audit_summary: dict[str, Any] = {"checkedTasks": 0, "valid": True}
    if causal_sample_rows:
        sup = audit_python_supervision(
            causal_sample_rows,
            {"formats": ["compact"], "samplePerFeature": 30},
        )
        causal_audit_summary = {
            "valid": bool(sup["valid"]),
            "allReplayed": bool(sup["allReplayed"]),
            "checkedTasks": len(causal_sample_rows),
            "causalPairsChecked": int(sup["summary"]["causalPairs"]),
            "causalDivergencesChecked": int(sup["summary"]["causalDivergencesChecked"]),
        }
        assert sup["valid"] and sup["allReplayed"], f"Causal supervision audit failed: {sup}"

    tasks_path = output_dir / "tasks.jsonl"
    tasks_path.write_text(
        "\n".join(_json_compact(r) for r in final_rows) + ("\n" if final_rows else ""),
        encoding="utf-8",
    )

    by_mode: dict[str, int] = {}
    by_origin: dict[str, int] = {}
    by_domain: dict[str, int] = {}
    by_trace_fmt: dict[str, int] = {}
    by_repo: dict[str, dict[str, int]] = {}
    ext_op_counts: dict[str, int] = {}
    mut_pair_ids: set[str] = set()
    stateful_pair_ids: set[str] = set()
    stateful_repos: set[str] = set()
    pure_repos: set[str] = set()
    mut_repos: set[str] = set()

    for r in final_rows:
        m = r["metadata"]
        mode = m.get("mode", "unknown")
        origin = m.get("sourceOrigin", "unknown")
        dom = m.get("domain", "unknown")
        repo = m.get("repo", "unknown")
        tfmt = m.get("traceFormat", "compact")
        by_mode[mode] = by_mode.get(mode, 0) + 1
        by_origin[origin] = by_origin.get(origin, 0) + 1
        by_domain[dom] = by_domain.get(dom, 0) + 1
        by_trace_fmt[tfmt] = by_trace_fmt.get(tfmt, 0) + 1
        rc = by_repo.setdefault(repo, {"total": 0, "mode_a": 0, "mode_b": 0, "mode_c_mut": 0, "stateful": 0})
        rc["total"] += 1
        if m.get("statefulIo"):
            rc["stateful"] += 1
            stateful_repos.add(repo)
            if m.get("pairId"):
                stateful_pair_ids.add(m["pairId"])
            for call in (r.get("task") or {}).get("fixture", {}).get("calls", []):
                op = call.get("operation", "unknown")
                ext_op_counts[op] = ext_op_counts.get(op, 0) + 1
        else:
            pure_repos.add(repo)
            if mode == "mode_a_unit_test":
                rc["mode_a"] += 1
            elif mode == "mode_b_api_probe":
                rc["mode_b"] += 1
            elif mode == "mode_c_mutation_pair":
                rc["mode_c_mut"] += 1
                mut_repos.add(repo)
                if m.get("pairId"):
                    mut_pair_ids.add(m["pairId"])

    ctx_toks = [int(r["metadata"]["contextTokens"]) for r in final_rows]
    cb_toks = [int(r["metadata"]["codebaseTokens"]) for r in final_rows]
    turn_toks = [int(r["metadata"]["maxTurnTokens"]) for r in final_rows]
    file_counts = [int(r["metadata"]["fileCount"]) for r in final_rows]
    loaded_counts = [int(r["metadata"]["loadedFileCount"]) for r in final_rows]
    code_loads = [int(r["metadata"]["codeLoadCalls"]) for r in final_rows]

    stateful_count = sum(1 for r in final_rows if r["metadata"].get("statefulIo"))
    pure_count = len(final_rows) - stateful_count

    audit_report = {
        "schema": "oss-py-wave3-audit/1",
        "started": started,
        "finished": datetime.now(timezone.utc).isoformat(),
        "catalogCleanRepos": len(catalog),
        "distinctReposYielded": len(by_repo),
        "distinctPureRepos": len(pure_repos),
        "distinctStatefulRepos": len(stateful_repos),
        "totalTasks": len(final_rows),
        "pureMultifileTasks": pure_count,
        "statefulIoTasks": stateful_count,
        "uniqueFamilies": len({r["family"] for r in final_rows}),
        "uniqueSourceHashes": len({r["sourceHash"] for r in final_rows}),
        "byMode": by_mode,
        "bySourceOrigin": by_origin,
        "byTraceFormat": by_trace_fmt,
        "byDomain": dict(sorted(by_domain.items(), key=lambda kv: (-kv[1], kv[0]))),
        "counterfactualPairs": {
            "totalPairs": len(mut_pair_ids) + len(stateful_pair_ids),
            "astMutationPairs": len(mut_pair_ids),
            "astMutationIdenticalPromptPairs": len(identical_mut_pair_ids),
            "statefulWorldStatePairs": len(stateful_pair_ids),
            "distinctReposWithMutations": len(mut_repos),
            "causalSupervisionAudit": causal_audit_summary,
        },
        "statefulExternalOpCounts": dict(sorted(ext_op_counts.items())),
        "distributions": {
            "contextTokensCl100k": _stats(ctx_toks),
            "codebaseTokensCl100k": _stats(cb_toks),
            "maxTurnTokensCl100k": _stats(turn_toks),
            "fileCount": _stats(file_counts),
            "loadedFileCount": _stats(loaded_counts),
            "codeLoadCalls": _stats(code_loads),
            "tasksIn8kTo56kCodebaseTokens": sum(1 for t in cb_toks if 8000 <= t <= 56000),
            "tasksIn8kTo56kContextTokens": sum(1 for t in ctx_toks if 8000 <= t <= 56000),
        },
        "verification": {
            "deterministic2xAllPassed": all(r["metadata"].get("deterministic2xVerified") for r in final_rows),
            "liveReplayAllPassed": all(r["metadata"].get("liveReplayVerified") for r in final_rows),
            "preexportedSchemaAllPassed": all(_is_preexported_row(r) for r in final_rows),
            "pythonHashSeeds": [HASH_SEED_PASS1, HASH_SEED_PASS2],
            "maxContextTokenLimit": args.max_context_tokens,
            "maxTurnTokenLimit": args.max_turn_tokens,
        },
        "zeroLeakageAudit": {
            "passed": True,
            "realexecbench5AxisOverlap": reb_overlap,
            "stage10Overlap": stage10_overlap,
        },
        "repos": dict(sorted(by_repo.items(), key=lambda kv: (-kv[1]["total"], kv[0]))),
        "tasksPath": str(tasks_path),
    }

    audit_path = output_dir / "audit.json"
    audit_path.write_text(json.dumps(audit_report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({
        "distinctReposYielded": audit_report["distinctReposYielded"],
        "distinctPureRepos": audit_report["distinctPureRepos"],
        "distinctStatefulRepos": audit_report["distinctStatefulRepos"],
        "totalTasks": audit_report["totalTasks"],
        "pureMultifileTasks": audit_report["pureMultifileTasks"],
        "statefulIoTasks": audit_report["statefulIoTasks"],
        "byMode": audit_report["byMode"],
        "byTraceFormat": audit_report["byTraceFormat"],
        "counterfactualPairs": audit_report["counterfactualPairs"],
        "distributions": audit_report["distributions"],
        "zeroLeakageAudit": audit_report["zeroLeakageAudit"],
        "tasksPath": str(tasks_path),
        "auditPath": str(audit_path),
    }, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
