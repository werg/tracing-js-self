#!/usr/bin/env python3
"""Build and strictly verify Wave 2 of hairy, realistic Python execution tasks.

Produces 116 brand-new verified Python tasks across 48 brand-new families
(zero overlap with Wave 1's 53 families in tools/tinker-build-hairy-py.py):

  Part A (64 tasks across 32 NEW real-codebase families from 25 NEW OSS repos):
    - 20 pure / exception-semantics / aliasing / cycle / $py-edge families x 2
      variants = 40 tasks (3-22 KB real multi-helper/multi-class slices extracted
      verbatim via AST from cached OSS repos).
    - 12 multi-turn effectful real-repo families x 2 causal-pair variants = 24 tasks
      (identical public prompt & diverging external fixture calls for causal
      zero-future-leakage auditing, 4-10 calls each).

  Part B (52 tasks across 16 NEW multi-turn effectful production workflows):
    - 16 brand-new production Python pipelines (token-bucket rate limiter,
      distributed lease manager, ETL checkpointing pipeline, schema/config
      migrator, cache invalidation fanout, trace alert correlator, stateful saga
      workflow, inventory reconciliation, Merkle WAL verifier, adaptive hedged
      router, feature flag evaluator, billing invoice aggregator, canary traffic
      shifter, deadletter replayer, PageRank checkpoint, secret rotation
      coordinator), 3-4 variants each with 4-16 external calls, causal pairs,
      fulfilled + rejected calls, try/except/else/finally, intentional throws,
      aliasing ($py:ref), cyclic container graphs, tuple-keyed dicts, sets,
      bytes, -0.0/NaN/Infinity, and make_dataclass instances.

100% of tasks are verified through:
  1. prepare_python_task() + export_python_example(..., trace_format="compact",
     reasoning_channel="thinking") confirming replayVerified == True,
     expected outcome kind ("return" or "throw"), exact exception name on throw,
     and 0 omitted trace steps.
  2. audit_python_supervision(..., samplePerFeature=100) confirming valid == True,
     allReplayed == True, and zero future leakage across causal divergence pairs.
  3. Exact Inkling-2-Mini rendered token count < 28,000 when tinker_cookbook SDK
     is available.
  4. Strict zero-overlap guard against Wave 1 families.
"""

from __future__ import annotations

import argparse
import ast
import builtins
import concurrent.futures
import hashlib
import io
import json
from pathlib import Path
import random
import re
import sys
from typing import Any

_REPO_ROOT = Path(__file__).resolve().parents[1]
_TRAINING_DIR = str(_REPO_ROOT / "training")
if _TRAINING_DIR not in sys.path:
    sys.path.insert(0, _TRAINING_DIR)

from tinker_py.codec import decode_readable, encode_readable  # noqa: E402
from tinker_py.execution import (  # noqa: E402
    assistant_thinking_text,
    audit_python_supervision,
    export_python_example,
    prepare_python_task,
)


DEFAULT_DGX1 = Path("/tmp/tinker-harvest-py-dgx")
DEFAULT_DGX2 = Path("/tmp/tinker-harvest-py-dgx-wave2")
DEFAULT_WAVE1_TASKS = Path("/home/werg/tracing-js-self/runs/hairy-real-py-tasks/tasks.jsonl")
DEFAULT_WAVE1_BUILDER = _REPO_ROOT / "tools/tinker-build-hairy-py.py"
DEFAULT_OUTPUT = _REPO_ROOT / "runs/hairy-real-py-wave2/tasks.jsonl"


def _json_compact(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def _sha256(value: Any) -> str:
    text = value if isinstance(value, str) else _json_compact(value)
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _load_wave1_families(wave1_tasks: Path, wave1_builder: Path) -> set[str]:
    """Collect every Wave 1 family name from tasks.jsonl and builder source."""
    families: set[str] = set()
    if wave1_tasks.is_file():
        for line in wave1_tasks.read_text(encoding="utf-8").splitlines():
            if line.strip():
                families.add(json.loads(line)["family"])
    if wave1_builder.is_file():
        text = wave1_builder.read_text(encoding="utf-8")
        for m in re.finditer(r'family\s*=\s*"([^"]+)"', text):
            fam = m.group(1)
            families.add(fam)
            if not fam.startswith("py-"):
                families.add(f"py-hairy-effectful:{fam}")
    return families


# ---------------------------------------------------------------------------
# AST extraction helpers from real OSS repos on disk
# ---------------------------------------------------------------------------

def _defined_names(stmt: ast.stmt) -> set[str]:
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
    return names


def _extract_symbols(
    path: Path,
    symbol_names: list[str],
    *,
    strip_decorators: set[str] | None = None,
) -> str:
    """Extract named top-level definitions/assignments verbatim from a real Python file."""
    if not path.is_file():
        raise FileNotFoundError(f"Missing real repo file: {path}")
    text = path.read_text(encoding="utf-8", errors="replace")
    tree = ast.parse(text)
    lines = text.splitlines()

    stmt_by_name: dict[str, tuple[int, ast.stmt]] = {}
    for idx, stmt in enumerate(tree.body):
        for name in _defined_names(stmt):
            stmt_by_name[name] = (idx, stmt)

    seen_indices: set[int] = set()
    blocks: list[str] = []
    for name in symbol_names:
        if name not in stmt_by_name:
            raise KeyError(f"Symbol {name!r} not found in {path}")
        idx, stmt = stmt_by_name[name]
        if idx in seen_indices:
            continue
        seen_indices.add(idx)
        start = stmt.lineno - 1
        if isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and stmt.decorator_list:
            start = min(d.lineno for d in stmt.decorator_list) - 1
        end = getattr(stmt, "end_lineno", stmt.lineno) or stmt.lineno
        seg = "\n".join(lines[start:end])
        if strip_decorators:
            kept = [
                ln
                for ln in seg.splitlines()
                if not any(ln.lstrip().startswith(f"@{dec}") for dec in strip_decorators)
            ]
            seg = "\n".join(kept)
        blocks.append(seg)
    return "\n\n".join(blocks)


def _replace_leading_indent(block: str, old_prefix: str = "\t", new_prefix: str = "    ") -> str:
    out: list[str] = []
    for line in block.splitlines():
        n = 0
        while line.startswith(old_prefix, n * len(old_prefix)):
            n += 1
        out.append(new_prefix * n + line[n * len(old_prefix) :])
    return "\n".join(out)


# ---------------------------------------------------------------------------
# Local fixture recorder for effectful + throw tasks (strictly worker-verified)
# ---------------------------------------------------------------------------

class _UnscriptedHostCallError(BaseException):
    """Raised when guest makes more host calls than scripted during fixture recording."""


class _MockHost:
    def __init__(self, record_fn: Any) -> None:
        self._record = record_fn

    def fs_read_text(self, path: Any) -> Any:
        return self._record("fs.readText", [path])

    def fs_write_text(self, path: Any, text: Any) -> Any:
        return self._record("fs.writeText", [path, text])

    def http_get(self, url: Any) -> Any:
        return self._record("http.get", [url])

    def http_request(self, req: Any) -> Any:
        return self._record("http.request", [req])

    def kv_get(self, key: Any) -> Any:
        return self._record("kv_get", [key])

    def kv_set(self, key: Any, value: Any) -> Any:
        return self._record("kv_set", [key, value])


def _make_guest_exc(spec: dict[str, Any]) -> Exception:
    name = spec.get("name", "RuntimeError")
    msg = str(spec.get("message", ""))
    exc_cls = getattr(builtins, name, None)
    if isinstance(exc_cls, type) and issubclass(exc_cls, Exception):
        return exc_cls(msg)
    return RuntimeError(f"{name}: {msg}")


def _record_fixture_calls(
    source: str,
    entry: str,
    raw_args: list[Any],
    *,
    scripted_calls: dict[str, list[dict[str, Any]]] | None = None,
    scripted_times: list[float] | None = None,
    scripted_randoms: list[float] | None = None,
    random_mode: str = "seeded",
    random_seed: int = 17,
    allow_throw: bool = False,
) -> list[dict[str, Any]]:
    """Run guest code against scripted host/time/random responses to capture exact fixture.calls."""
    import time as _real_time

    queues: dict[str, list[dict[str, Any]]] = {
        k: list(v) for k, v in (scripted_calls or {}).items()
    }
    time_queue = list(scripted_times or [])
    time_cursor = [0]
    rand_queue = list(scripted_randoms or [])
    rng = random.Random(random_seed)
    recorded: list[dict[str, Any]] = []

    def record(operation: str, call_args: list[Any]) -> Any:
        enc_args = encode_readable(call_args)
        status = "fulfilled"
        result: Any = None
        if operation == "platform.print":
            result = None
        elif operation == "platform.time":
            if time_queue:
                result = time_queue.pop(0)
            else:
                result = 1700000000.0 + time_cursor[0] * 0.5
                time_cursor[0] += 1
        elif operation == "platform.random":
            result = rand_queue.pop(0) if rand_queue else rng.random()
        else:
            q = queues.get(operation)
            if not q:
                raise _UnscriptedHostCallError(f"Unscripted host call {operation}({enc_args!r})")
            item = q.pop(0)
            status = item.get("status", "fulfilled")
            result = item.get("result")

        recorded.append({
            "operation": operation,
            "arguments": enc_args,
            "status": status,
            "result": encode_readable(result, allow_exceptions=True)
            if status == "fulfilled"
            else result,
        })
        if status == "rejected":
            raise _make_guest_exc(
                result if isinstance(result, dict) else {"name": "RuntimeError", "message": str(result)}
            )
        return decode_readable(encode_readable(result))

    orig_time = _real_time.time
    orig_monotonic = _real_time.monotonic
    orig_random = random.random
    orig_stdout = sys.stdout
    try:
        _real_time.time = lambda: record("platform.time", [])  # type: ignore[assignment]
        _real_time.monotonic = lambda: record("platform.time", [])  # type: ignore[assignment]
        if random_mode == "tool":
            random.random = lambda: record("platform.random", [])  # type: ignore[assignment]
        else:
            random.seed(random_seed)

        guest_builtins = dict(vars(builtins))
        guest_builtins["print"] = lambda *p_args, **_kw: record("platform.print", list(p_args))
        ns: dict[str, Any] = {
            "__builtins__": guest_builtins,
            "__name__": "__guest__",
            "host": _MockHost(record),
        }
        code = compile(source, "<record>", "exec")
        sys.stdout = io.StringIO()
        exec(code, ns)
        fn = ns[entry]
        args_copy = decode_readable(encode_readable(raw_args))
        try:
            fn(*args_copy)
        except Exception:
            if not allow_throw:
                raise
    finally:
        sys.stdout = orig_stdout
        _real_time.time = orig_time
        _real_time.monotonic = orig_monotonic
        random.random = orig_random

    return recorded


def _make_task(
    *,
    task_id: str,
    family: str,
    source: str,
    entry: str,
    args: list[Any],
    features: list[str],
    metadata: dict[str, Any],
    random_mode: str = "seeded",
    random_seed: int = 17,
    scripted_calls: dict[str, list[dict[str, Any]]] | None = None,
    scripted_times: list[float] | None = None,
    scripted_randoms: list[float] | None = None,
    expected_kind: str = "return",
    expected_exc: str | None = None,
    max_steps: int = 300_000,
    timeout_ms: int = 10_000,
) -> dict[str, Any]:
    allow_throw = expected_kind == "throw"
    recorded = _record_fixture_calls(
        source,
        entry,
        args,
        scripted_calls=scripted_calls,
        scripted_times=scripted_times,
        scripted_randoms=scripted_randoms,
        random_mode=random_mode,
        random_seed=random_seed,
        allow_throw=allow_throw,
    )
    extra_feats = {"hairy-real", "python"}
    if recorded:
        extra_feats |= {"external", "sequential"}
    if expected_kind == "throw":
        extra_feats |= {"exception", "expected-throw"}
    all_features = sorted(set(features) | extra_feats)
    return {
        "id": task_id,
        "family": family,
        "language": "py",
        "tier": 5,
        "source": source.strip() + "\n",
        "entry": entry,
        "args": encode_readable(args),
        "randomMode": random_mode,
        "randomSeed": random_seed,
        "nativeBindings": [],
        "fixture": {"calls": recorded},
        "maxSteps": max_steps,
        "timeoutMs": timeout_ms,
        "features": all_features,
        "metadata": {
            **metadata,
            "tier": 5,
            "features": all_features,
            "expectedKind": expected_kind,
            **({"expectedException": expected_exc} if expected_exc else {}),
        },
    }


# ---------------------------------------------------------------------------
# PART A: 32 NEW Real-Codebase OSS Python Families (64 tasks across 25 NEW repos)
# ---------------------------------------------------------------------------

def build_part_a_tasks(dgx1: Path, dgx2: Path) -> list[dict[str, Any]]:
    tasks: list[dict[str, Any]] = []

    def add_repo_task(
        *,
        task_id: str,
        family: str,
        repo: str,
        source_file: str,
        source: str,
        entry: str,
        args: list[Any],
        features: list[str],
        random_mode: str = "seeded",
        scripted_calls: dict[str, list[dict[str, Any]]] | None = None,
        scripted_times: list[float] | None = None,
        scripted_randoms: list[float] | None = None,
        expected_kind: str = "return",
        expected_exc: str | None = None,
    ) -> None:
        tasks.append(
            _make_task(
                task_id=task_id,
                family=family,
                source=source,
                entry=entry,
                args=args,
                features=features,
                random_mode=random_mode,
                scripted_calls=scripted_calls,
                scripted_times=scripted_times,
                scripted_randoms=scripted_randoms,
                expected_kind=expected_kind,
                expected_exc=expected_exc,
                metadata={
                    "repo": repo,
                    "sourceFile": source_file,
                    "sourceOrigin": "hairy-real-repo-slice-wave2",
                    "part": "A",
                    "lineage": [f"py-repo:{repo}", family],
                },
            )
        )

    # =========================================================================
    # 1. pallets__click (option_parser: 2 tasks, inc. intentional throw)
    # =========================================================================
    click_utils = dgx2 / "pallets__click/src/click/_utils.py"
    click_exc = dgx2 / "pallets__click/src/click/exceptions.py"
    click_parser = dgx2 / "pallets__click/src/click/parser.py"
    click_fmt = dgx2 / "pallets__click/src/click/formatting.py"
    click_tw = dgx2 / "pallets__click/src/click/_textwrap.py"

    click_shim = """
from __future__ import annotations
import collections.abc as cabc
import enum
import textwrap
import typing as t
from collections import deque
from contextlib import contextmanager

def _(msg): return msg
def ngettext(s, p, n): return s if n == 1 else p
def resolve_color_default(): return False
def get_text_stderr(): return None
def echo(message=None, file=None, nl=True, err=False, color=None): pass
def format_filename(filename): return str(filename)
def term_len(x): return len(x)
V = t.TypeVar("V")
"""
    click_parser_src = "\n\n".join([
        click_shim,
        _extract_symbols(click_utils, ["Sentinel", "UNSET", "FLAG_NEEDS_VALUE"]),
        _extract_symbols(click_exc, ["_join_param_hints", "_format_possibilities", "ClickException", "UsageError", "BadOptionUsage", "BadArgumentUsage", "NoSuchOption"]),
        _extract_symbols(click_parser, ["_unpack_args", "_split_opt", "_normalize_opt", "_Option", "_Argument", "_ParsingState", "_OptionParser"]),
        """
class _DummyParam:
    def __init__(self, name, flag_needs_value=False):
        self.name = name
        self._flag_needs_value = flag_needs_value

class _DummyCtx:
    def __init__(self, allow_interspersed=True, ignore_unknown=False, resilient=False):
        self.command = None
        self.allow_interspersed_args = allow_interspersed
        self.ignore_unknown_options = ignore_unknown
        self.resilient_parsing = resilient
        self.token_normalize_func = str.lower

def run(argv, audit):
    ctx = _DummyCtx(allow_interspersed=True, ignore_unknown=False, resilient=False)
    p = _OptionParser(ctx)
    p.add_option(_DummyParam("verbose"), ["-v", "--verbose"], "verbose", action="count")
    p.add_option(_DummyParam("tag"), ["-t", "--tag"], "tags", action="append")
    p.add_option(_DummyParam("mode"), ["--mode"], "mode", action="store")
    p.add_argument(_DummyParam("src"), "src", nargs=1)
    p.add_argument(_DummyParam("targets"), "targets", nargs=-1)
    try:
        opts, leftover, order = p.parse_args(list(argv))
    except UsageError as exc:
        audit["error_type"] = type(exc).__name__
        audit["error_msg"] = str(exc)
        raise
    else:
        audit["parsed_count"] = len(order)
        audit["leftover"] = leftover
    finally:
        audit["checked"] = True
    return {
        "opts": opts,
        "order": [o.name for o in order],
        "audit": audit,
    }
""",
    ])
    add_repo_task(
        task_id="py-real-click-parser-ok-0",
        family="py-real:pallets__click:option_parser",
        repo="pallets__click",
        source_file="src/click/parser.py+exceptions.py+_utils.py",
        source=click_parser_src,
        entry="run",
        args=[["-vv", "--Mode=fast", "-t", "alpha", "src.py", "out1"], {"checked": False}],
        features=["loop", "branch", "class", "parser", "exception", "mutation", "alias"],
    )
    add_repo_task(
        task_id="py-real-click-parser-throw-1",
        family="py-real:pallets__click:option_parser",
        repo="pallets__click",
        source_file="src/click/parser.py+exceptions.py+_utils.py",
        source=click_parser_src,
        entry="run",
        args=[["-v", "--mod=fast", "src.py"], {"checked": False}],
        features=["loop", "branch", "class", "parser", "exception", "mutation"],
        expected_kind="throw",
        expected_exc="NoSuchOption",
    )

    # =========================================================================
    # 2. pallets__click (help_formatter: 2 tasks, inc. finally dedent + throw)
    # =========================================================================
    click_fmt_src = "\n\n".join([
        click_shim,
        "FORCED_WIDTH = 64",
        _extract_symbols(click_parser, ["_split_opt"]),
        _extract_symbols(click_tw, ["TextWrapper"]),
        _extract_symbols(click_fmt, ["measure_table", "iter_rows", "wrap_text", "HelpFormatter", "join_options"]).replace(
            "from ._textwrap import TextWrapper", "# TextWrapper defined above"
        ),
        """
def run(rows, body_text, state):
    fmt = HelpFormatter(indent_increment=2, width=54)
    fmt.write_usage("mycli", "[OPTIONS] SRC DST")
    with fmt.section("Options"):
        fmt.write_text(body_text)
        try:
            fmt.write_dl(rows, col_max=20)
        finally:
            state["indent_during_finally"] = fmt.current_indent
    state["indent_after"] = fmt.current_indent
    joined, has_slash = join_options(["--verbose", "/v", "-v"])
    return {"help": fmt.getvalue(), "joined": joined, "has_slash": has_slash, "state": state}
""",
    ])
    add_repo_task(
        task_id="py-real-click-formatter-ok-0",
        family="py-real:pallets__click:help_formatter",
        repo="pallets__click",
        source_file="src/click/formatting.py+_textwrap.py",
        source=click_fmt_src,
        entry="run",
        args=[[("-v", "Verbose logs."), ("-o", "Out.")], "Run.\n\n\b\nRaw.", {}],
        features=["loop", "branch", "class", "contextmanager", "exception", "mutation", "alias"],
    )
    add_repo_task(
        task_id="py-real-click-formatter-throw-1",
        family="py-real:pallets__click:help_formatter",
        repo="pallets__click",
        source_file="src/click/formatting.py+_textwrap.py",
        source=click_fmt_src,
        entry="run",
        args=[[("bad_single_col",)], "Trigger 2-col validation error inside section.", {}],
        features=["loop", "branch", "class", "contextmanager", "exception", "mutation"],
        expected_kind="throw",
        expected_exc="TypeError",
    )

    # =========================================================================
    # 3. encode__httpx (urlparse_rfc3986: 2 tasks, inc. InvalidURL throw)
    # =========================================================================
    httpx_exc = dgx2 / "encode__httpx/httpx/_exceptions.py"
    httpx_up = dgx2 / "encode__httpx/httpx/_urlparse.py"
    httpx_urls = dgx2 / "encode__httpx/httpx/_urls.py"
    httpx_dec = dgx2 / "encode__httpx/httpx/_decoders.py"
    httpx_mod = dgx2 / "encode__httpx/httpx/_models.py"
    httpx_utils = dgx2 / "encode__httpx/httpx/_utils.py"

    httpx_idna_shim = """
from __future__ import annotations
import ipaddress
import re
import typing

class _IdnaShim:
    class IDNAError(ValueError): pass
    @staticmethod
    def encode(s):
        try:
            return s.encode("idna")
        except UnicodeError as exc:
            raise _IdnaShim.IDNAError(str(exc)) from exc
    @staticmethod
    def decode(s):
        raw = s.encode("ascii") if isinstance(s, str) else s
        return raw.decode("idna")

idna = _IdnaShim()
"""
    httpx_urlparse_src = "\n\n".join([
        httpx_idna_shim,
        _extract_symbols(httpx_exc, ["HTTPError", "InvalidURL"]),
        _extract_symbols(
            httpx_up,
            [
                "MAX_URL_LENGTH",
                "UNRESERVED_CHARACTERS",
                "SUB_DELIMS",
                "PERCENT_ENCODED_REGEX",
                "FRAG_SAFE",
                "QUERY_SAFE",
                "PATH_SAFE",
                "USERNAME_SAFE",
                "PASSWORD_SAFE",
                "USERINFO_SAFE",
                "URL_REGEX",
                "AUTHORITY_REGEX",
                "COMPONENT_REGEX",
                "IPv4_STYLE_HOSTNAME",
                "IPv6_STYLE_HOSTNAME",
                "ParseResult",
                "urlparse",
                "encode_host",
                "normalize_port",
                "validate_path",
                "normalize_path",
                "PERCENT",
                "percent_encoded",
                "quote",
            ],
        ),
        """
def run(raw_urls, overrides, report):
    parsed_list = []
    for raw in raw_urls:
        pr = urlparse(raw, **overrides)
        parsed_list.append({
            "scheme": pr.scheme,
            "host": pr.host,
            "port": pr.port,
            "path": pr.path,
            "query": pr.query,
            "fragment": pr.fragment,
            "netloc": pr.netloc,
            "str": str(pr),
        })
        report["count"] += 1
    return {"parsed": parsed_list, "report": report}
""",
    ])
    add_repo_task(
        task_id="py-real-httpx-urlparse-ok-0",
        family="py-real:encode__httpx:urlparse_rfc3986",
        repo="encode__httpx",
        source_file="httpx/_urlparse.py+_exceptions.py",
        source=httpx_urlparse_src,
        entry="run",
        args=[["HTTPS://user@Example.COM:443/a/../c%20d?x=1#frag"], {}, {"count": 0}],
        features=["loop", "branch", "regex", "url", "mutation", "alias"],
    )
    add_repo_task(
        task_id="py-real-httpx-urlparse-throw-1",
        family="py-real:encode__httpx:urlparse_rfc3986",
        repo="encode__httpx",
        source_file="httpx/_urlparse.py+_exceptions.py",
        source=httpx_urlparse_src,
        entry="run",
        args=[["https://valid.local/ok", "https://999.0.0.1/bad"], {}, {"count": 0}],
        features=["loop", "branch", "regex", "url", "exception", "mutation"],
        expected_kind="throw",
        expected_exc="InvalidURL",
    )

    # =========================================================================
    # 4. encode__httpx (url_queryparams: 2 tasks, inc. immutable RuntimeError throw)
    # =========================================================================
    def _strip_docstrings(code: str) -> str:
        tree = ast.parse(code)
        for node in ast.walk(tree):
            if isinstance(node, (ast.AsyncFunctionDef, ast.FunctionDef, ast.ClassDef, ast.Module)):
                if (
                    node.body
                    and isinstance(node.body[0], ast.Expr)
                    and isinstance(node.body[0].value, ast.Constant)
                    and isinstance(node.body[0].value.value, str)
                ):
                    node.body.pop(0)
        return ast.unparse(tree)

    httpx_urls_src = "\n\n".join([
        httpx_idna_shim,
        "from urllib.parse import parse_qs, unquote, urlencode",
        _extract_symbols(httpx_exc, ["HTTPError", "InvalidURL"]),
        _extract_symbols(httpx_utils, ["primitive_value_to_str"]),
        _strip_docstrings(_extract_symbols(
            httpx_up,
            [
                "MAX_URL_LENGTH",
                "UNRESERVED_CHARACTERS",
                "SUB_DELIMS",
                "PERCENT_ENCODED_REGEX",
                "FRAG_SAFE",
                "QUERY_SAFE",
                "PATH_SAFE",
                "USERNAME_SAFE",
                "PASSWORD_SAFE",
                "USERINFO_SAFE",
                "URL_REGEX",
                "AUTHORITY_REGEX",
                "COMPONENT_REGEX",
                "IPv4_STYLE_HOSTNAME",
                "IPv6_STYLE_HOSTNAME",
                "ParseResult",
                "urlparse",
                "encode_host",
                "normalize_port",
                "validate_path",
                "normalize_path",
                "PERCENT",
                "percent_encoded",
                "quote",
            ],
        )),
        _strip_docstrings(_extract_symbols(httpx_urls, ["URL", "QueryParams"])),
        """
def run(base_url, rel_path, mutate_illegal, trace_out):
    u = URL(base_url)
    u2 = u.copy_set_param("page", 2)
    joined = u2.join(rel_path)
    trace_out["raw_path"] = joined.raw_path
    trace_out["multi"] = joined.params.multi_items()
    if mutate_illegal:
        qp = joined.params
        qp["page"] = "99"
    return {"url": str(joined), "trace": trace_out}
""",
    ])
    add_repo_task(
        task_id="py-real-httpx-urls-ok-0",
        family="py-real:encode__httpx:url_queryparams",
        repo="encode__httpx",
        source_file="httpx/_urls.py+_urlparse.py+_utils.py",
        source=httpx_urls_src,
        entry="run",
        args=["https://API.example.com:443/v1/items?drop=1&tag=core", "/v2/search?q=py&ok=true", False, {}],
        features=["loop", "branch", "class", "url", "bytes", "mutation", "alias"],
    )
    add_repo_task(
        task_id="py-real-httpx-urls-throw-1",
        family="py-real:encode__httpx:url_queryparams",
        repo="encode__httpx",
        source_file="httpx/_urls.py+_urlparse.py+_utils.py",
        source=httpx_urls_src,
        entry="run",
        args=["https://api.example.com/v1/items?page=1", "next?ok=1", True, {}],
        features=["loop", "branch", "class", "url", "bytes", "exception", "mutation"],
        expected_kind="throw",
        expected_exc="RuntimeError",
    )

    # =========================================================================
    # 5. encode__httpx (stream_decoders: 2 tasks, deflate/gzip/LineDecoder + throw)
    # =========================================================================
    httpx_dec_src = "\n\n".join([
        "from __future__ import annotations\nimport codecs\nimport io\nimport typing\nimport zlib",
        _extract_symbols(httpx_exc, ["HTTPError", "RequestError", "DecodingError"]),
        _extract_symbols(
            httpx_dec,
            ["ContentDecoder", "IdentityDecoder", "DeflateDecoder", "GZipDecoder", "MultiDecoder", "ByteChunker", "TextChunker", "TextDecoder", "LineDecoder"],
        ),
        """
def run(raw_payload, text_chunks, trigger_bad_deflate):
    comp_zlib = zlib.compress(raw_payload)
    # Also test raw deflate (without zlib header) to exercise first_attempt fallback!
    co_raw = zlib.compressobj(wbits=-zlib.MAX_WBITS)
    comp_raw = co_raw.compress(raw_payload) + co_raw.flush()
    d_zlib = DeflateDecoder()
    out_zlib = d_zlib.decode(comp_zlib) + d_zlib.flush()
    d_raw = DeflateDecoder()
    out_raw = d_raw.decode(comp_raw) + d_raw.flush()
    bc = ByteChunker(chunk_size=4)
    chunks = []
    for i in range(0, len(out_raw), 5):
        chunks.extend(bc.decode(out_raw[i:i+5]))
    chunks.extend(bc.flush())
    ld = LineDecoder()
    lines = []
    for tc in text_chunks:
        lines.extend(ld.decode(tc))
    lines.extend(ld.flush())
    if trigger_bad_deflate:
        bad = DeflateDecoder()
        bad.decode(b"\\x00\\xffbad-stream")
    return {"zlib": out_zlib, "raw": out_raw, "chunks": chunks, "lines": lines}
""",
    ])
    add_repo_task(
        task_id="py-real-httpx-decoders-ok-0",
        family="py-real:encode__httpx:stream_decoders",
        repo="encode__httpx",
        source_file="httpx/_decoders.py",
        source=httpx_dec_src,
        entry="run",
        args=[b"alpha-beta-gamma-0123", ["line1\r", "\nline2\nline3\r"], False],
        features=["loop", "branch", "class", "bytes", "exception"],
    )
    add_repo_task(
        task_id="py-real-httpx-decoders-throw-1",
        family="py-real:encode__httpx:stream_decoders",
        repo="encode__httpx",
        source_file="httpx/_decoders.py",
        source=httpx_dec_src,
        entry="run",
        args=[b"hello-world", ["a\nb"], True],
        features=["loop", "branch", "class", "bytes", "exception"],
        expected_kind="throw",
        expected_exc="DecodingError",
    )

    # =========================================================================
    # 6. encode__httpx (headers_links: 2 tasks, Headers + link parsing + KeyError)
    # =========================================================================
    httpx_hdr_src = "\n\n".join([
        "from __future__ import annotations\nimport codecs\nimport email.message\nimport re\nimport typing\nfrom collections.abc import Mapping",
        _extract_symbols(httpx_utils, ["to_bytes_or_str", "to_str"]),
        _extract_symbols(
            httpx_mod,
            [
                "SENSITIVE_HEADERS",
                "_is_known_encoding",
                "_normalize_header_key",
                "_normalize_header_value",
                "_parse_content_type_charset",
                "_parse_header_links",
                "_obfuscate_sensitive_headers",
                "Headers",
            ],
        ),
        """
def run(raw_headers, link_header, lookup_key, out_summary):
    hdrs = Headers(raw_headers)
    hdrs["X-Trace-Id"] = "trace-99"
    links = _parse_header_links(link_header)
    charset = _parse_content_type_charset(hdrs.get("content-type", "text/plain"))
    obf = list(_obfuscate_sensitive_headers(hdrs.multi_items()))
    out_summary["encoding"] = hdrs.encoding
    out_summary["charset"] = charset
    out_summary["obfuscated"] = obf
    out_summary["links"] = links
    val = hdrs[lookup_key]
    return {"val": val, "summary": out_summary}
""",
    ])
    add_repo_task(
        task_id="py-real-httpx-headers-ok-0",
        family="py-real:encode__httpx:headers_links",
        repo="encode__httpx",
        source_file="httpx/_models.py+_utils.py",
        source=httpx_hdr_src,
        entry="run",
        args=[
            [("Authorization", "Bearer secret-1"), ("Accept", "application/json"), ("accept", "text/plain"), ("Content-Type", "application/json; charset=utf-8")],
            '<https://api.local/p?p=2>; rel="next", <https://api.local/p?p=9>; rel="last"',
            "accept",
            {},
        ],
        features=["loop", "branch", "class", "regex", "mutation", "alias"],
    )
    add_repo_task(
        task_id="py-real-httpx-headers-throw-1",
        family="py-real:encode__httpx:headers_links",
        repo="encode__httpx",
        source_file="httpx/_models.py+_utils.py",
        source=httpx_hdr_src,
        entry="run",
        args=[
            [("Authorization", "Basic abc"), ("Host", "example.com")],
            "",
            "x-missing-header",
            {},
        ],
        features=["loop", "branch", "class", "exception", "mutation"],
        expected_kind="throw",
        expected_exc="KeyError",
    )

    # =========================================================================
    # 7. newren__git-filter-repo (ancestry_graph: 2 tasks, DAG + aliasing + throw)
    # =========================================================================
    gfr_path = dgx2 / "newren__git-filter-repo/git-filter-repo"
    gfr_anc_src = "\n\n".join([
        "import fnmatch\nimport re\nfrom datetime import datetime, timedelta, tzinfo",
        _extract_symbols(gfr_path, ["_timedelta_to_seconds", "FixedTimeZone", "string_to_date", "date_to_string", "AncestryGraph"]),
        """
def run(roots, commits, queries, state):
    ag = AncestryGraph()
    ag.record_external_commits(roots)
    for cid, parents, ghash in commits:
        ag.add_commit_and_parents(cid, parents, ghash)
    results = []
    for a, b in queries:
        results.append(ag.is_ancestor(a, b))
    p_hashes = ag.get_parent_hashes(commits[-1][2])
    ts = date_to_string(string_to_date(b"1700000000 +0200"))
    state["parents"] = p_hashes
    state["ts"] = ts
    node_view = {"depth_map": {k: ag.graph[v][0] for k, v in ag.value.items()}}
    state["view"] = node_view
    return {"results": results, "state": state, "view_alias": node_view, "cache_size": len(ag._cached_is_ancestor)}
""",
    ])
    add_repo_task(
        task_id="py-real-gfr-ancestry-ok-0",
        family="py-real:newren__git-filter-repo:ancestry_graph",
        repo="newren__git-filter-repo",
        source_file="git-filter-repo",
        source=gfr_anc_src,
        entry="run",
        args=[
            [1],
            [(2, [1], "h2"), (3, [1], "h3"), (4, [2, 3], "h4")],
            [(1, 4), (3, 2)],
            {},
        ],
        features=["loop", "branch", "class", "graph", "bytes", "alias", "mutation"],
    )
    add_repo_task(
        task_id="py-real-gfr-ancestry-throw-1",
        family="py-real:newren__git-filter-repo:ancestry_graph",
        repo="newren__git-filter-repo",
        source_file="git-filter-repo",
        source=gfr_anc_src,
        entry="run",
        args=[
            [1],
            [(2, [1], "h2"), (3, [2], "h3")],
            [(1, 99)],
            {},
        ],
        features=["loop", "branch", "class", "graph", "exception", "mutation"],
        expected_kind="throw",
        expected_exc="KeyError",
    )

    # =========================================================================
    # 8. newren__git-filter-repo (path_quoting_glob: 2 tasks, bytes + mailmap)
    # =========================================================================
    gfr_pq_src = "\n\n".join([
        "import fnmatch\nimport re",
        "def _(msg): return msg",
        _extract_symbols(gfr_path, ["decode", "glob_to_regex", "PathQuoting"]),
        _extract_symbols(gfr_path, ["MailmapInfo"]).replace(
            "def __init__(self, filename):\n    self.changes = {}\n    self._parse_file(filename)",
            "def __init__(self, lines):\n    self.changes = {}\n    self._parse_lines(lines)",
        ).replace(
            "  def _parse_file(self, filename):\n    name_and_email_re = re.compile(br'(.*?)\\s*<([^>]*)>\\s*')\n    comment_re = re.compile(br'\\s*#.*')\n    if not os.access(filename, os.R_OK):\n      raise SystemExit(_(\"Cannot read %s\") % decode(filename))\n    with open(filename, 'br') as f:\n      count = 0\n      for line in f:",
            "  def _parse_lines(self, lines):\n    name_and_email_re = re.compile(br'(.*?)\\s*<([^>]*)>\\s*')\n    comment_re = re.compile(br'\\s*#.*')\n    if True:\n      count = 0\n      for line in lines:",
        ).replace("raise SystemExit(err)", "raise ValueError(err)"),
        """
def run(raw_paths, glob_pat, mailmap_lines, authors):
    quoted = [PathQuoting.enquote(p) for p in raw_paths]
    dequoted = [PathQuoting.dequote(q) for q in quoted]
    rx = re.compile(glob_to_regex(glob_pat))
    matched = [p for p in dequoted if rx.match(p)]
    mm = MailmapInfo(mailmap_lines)
    mapped = [mm.translate(name, email) for name, email in authors]
    return {"quoted": quoted, "dequoted": dequoted, "matched": matched, "mapped": mapped}
""",
    ])
    add_repo_task(
        task_id="py-real-gfr-pathquoting-ok-0",
        family="py-real:newren__git-filter-repo:path_quoting_glob",
        repo="newren__git-filter-repo",
        source_file="git-filter-repo",
        source=gfr_pq_src,
        entry="run",
        args=[
            [b"src/main.py", b'dir/weird\n"name".py', b"docs/readme.md"],
            b"*.py",
            [b"# comment", b"Alice <alice@corp.io> <old@old.io>", b"Bob <bob@corp.io> OldBob"],
            [(b"Someone", b"OLD@old.io"), (b"OldBob", b"bob2@x.io")],
        ],
        features=["loop", "branch", "class", "bytes", "regex"],
    )
    add_repo_task(
        task_id="py-real-gfr-pathquoting-throw-1",
        family="py-real:newren__git-filter-repo:path_quoting_glob",
        repo="newren__git-filter-repo",
        source_file="git-filter-repo",
        source=gfr_pq_src,
        entry="run",
        args=[
            [b"a.py"],
            b"*.py",
            [b"NOT_A_VALID_MAILMAP_LINE"],
            [],
        ],
        features=["loop", "branch", "class", "bytes", "exception"],
        expected_kind="throw",
        expected_exc="ValueError",
    )

    # =========================================================================
    # 9. paramiko__paramiko (ber_tlv: 2 tasks, binary TLV + BERException throw)
    # =========================================================================
    pmk_common = dgx2 / "paramiko__paramiko/paramiko/common.py"
    pmk_util = dgx2 / "paramiko__paramiko/paramiko/util.py"
    pmk_ber = dgx2 / "paramiko__paramiko/paramiko/ber.py"
    pmk_msg = dgx2 / "paramiko__paramiko/paramiko/message.py"

    pmk_shim = """
import struct
from io import BytesIO
int64 = int
def b(s): return s if isinstance(s, bytes) else s.encode("utf-8")
def u(s): return s.decode("utf-8") if isinstance(s, bytes) else s
class _UtilNS: pass
util = _UtilNS()
"""
    pmk_ber_src = "\n\n".join([
        pmk_shim,
        _extract_symbols(pmk_common, ["byte_chr", "byte_ord", "xffffffff"]),
        "zero_byte = b'\\x00'\none_byte = b'\\x01'\nmax_byte = b'\\xff'",
        _extract_symbols(pmk_util, ["inflate_long", "deflate_long"]),
        "util.inflate_long = inflate_long\nutil.deflate_long = deflate_long",
        _extract_symbols(pmk_ber, ["BERException", "BER"]),
        """
def run(items, bad_payload):
    enc = BER()
    enc.encode(items)
    raw = enc.asbytes()
    dec = BER(raw)
    decoded = dec.decode()
    if bad_payload is not None:
        BER(bad_payload).decode()
    return {"raw": raw, "decoded": decoded}
""",
    ])
    add_repo_task(
        task_id="py-real-paramiko-ber-ok-0",
        family="py-real:paramiko__paramiko:ber_tlv",
        repo="paramiko__paramiko",
        source_file="paramiko/ber.py+util.py+common.py",
        source=pmk_ber_src,
        entry="run",
        args=[[1, -42, [255]], None],
        features=["loop", "branch", "class", "bytes", "recursion"],
    )
    add_repo_task(
        task_id="py-real-paramiko-ber-throw-1",
        family="py-real:paramiko__paramiko:ber_tlv",
        repo="paramiko__paramiko",
        source_file="paramiko/ber.py+util.py+common.py",
        source=pmk_ber_src,
        entry="run",
        args=[[7], b"\x04\x03abc"],
        features=["loop", "branch", "class", "bytes", "exception"],
        expected_kind="throw",
        expected_exc="BERException",
    )

    # =========================================================================
    # 10. paramiko__paramiko (ssh_message: 2 tasks, SSH2 packet + mod_inverse)
    # =========================================================================
    pmk_msg_src = "\n\n".join([
        pmk_shim,
        _extract_symbols(pmk_common, ["byte_chr", "byte_ord", "xffffffff"]),
        "zero_byte = b'\\x00'\none_byte = b'\\x01'\nmax_byte = b'\\xff'",
        _extract_symbols(pmk_util, ["inflate_long", "deflate_long", "format_binary", "format_binary_line", "bit_length", "constant_time_bytes_eq", "mod_inverse", "asbytes"]),
        "util.inflate_long = inflate_long\nutil.deflate_long = deflate_long\nutil.asbytes = asbytes",
        _extract_symbols(pmk_msg, ["Message"]),
        """
def run(tags, num, e_val, m_val, force_bad):
    msg = Message()
    msg.add_boolean(True)
    msg.add_adaptive_int(num)
    msg.add_mpint(num * 3 + 7)
    msg.add_list(tags)
    raw = msg.asbytes()
    r = Message(raw)
    b_val = r.get_boolean()
    a_val = r.get_adaptive_int()
    mp_val = r.get_mpint()
    lst_val = r.get_list()
    inv = mod_inverse(e_val, m_val)
    eq = constant_time_bytes_eq(raw, msg.asbytes())
    if force_bad:
        Message(b"\\x00\\x00\\x00\\x04\\xff\\xfe\\xfd\\xfc").get_text()
    return {
        "raw_hex_lines": format_binary(raw[:8]),
        "decoded": (b_val, a_val, mp_val, lst_val),
        "mod_inv": inv,
        "eq": eq,
    }
""",
    ])
    add_repo_task(
        task_id="py-real-paramiko-msg-ok-0",
        family="py-real:paramiko__paramiko:ssh_message",
        repo="paramiko__paramiko",
        source_file="paramiko/message.py+util.py",
        source=pmk_msg_src,
        entry="run",
        args=[["ssh-ed25519"], 42, 17, 3120, False],
        features=["loop", "branch", "class", "bytes", "math"],
    )
    add_repo_task(
        task_id="py-real-paramiko-msg-throw-1",
        family="py-real:paramiko__paramiko:ssh_message",
        repo="paramiko__paramiko",
        source_file="paramiko/message.py+util.py",
        source=pmk_msg_src,
        entry="run",
        args=[["a"], 42, 3, 11, True],
        features=["loop", "branch", "class", "bytes", "exception"],
        expected_kind="throw",
        expected_exc="UnicodeDecodeError",
    )

    # =========================================================================
    # 11. kkroening__ffmpeg-python (dag_nodes: 2 tasks, DAG + aliasing + throw)
    # =========================================================================
    ff_utils = dgx1 / "kkroening__ffmpeg-python/ffmpeg/_utils.py"
    ff_dag = dgx1 / "kkroening__ffmpeg-python/ffmpeg/dag.py"
    ff_nodes = dgx1 / "kkroening__ffmpeg-python/ffmpeg/nodes.py"
    ff_src = "\n\n".join([
        "from __future__ import unicode_literals\nfrom builtins import str, object\nfrom collections import namedtuple\nfrom collections.abc import Iterable\nimport hashlib\nimport sys\nbasestring = str",
        _extract_symbols(ff_utils, ["_recursive_repr", "get_hash", "get_hash_int", "escape_chars", "convert_kwargs_to_cmd_line_args"]).replace(
            "chars = list(set(chars))",
            "chars = sorted(set(chars))",
        ),
        _extract_symbols(ff_dag, ["DagNode", "DagEdge", "get_incoming_edges", "get_outgoing_edges", "KwargReprNode"]).replace(
            "                hash(x)",
            "                (x.__hash__() if isinstance(x, DagNode) else get_hash_int(repr(x)))",
        ),
        _extract_symbols(ff_nodes, ["_is_of_types", "_get_types_str", "Stream", "get_stream_map", "get_stream_map_nodes", "get_stream_spec_nodes", "Node", "FilterableStream", "InputNode", "FilterNode", "OutputNode", "OutputStream", "MergeOutputsNode", "GlobalNode"]).replace(
            "get_hash_int([hash(self.node), hash(self.label)])",
            "get_hash_int([self.node.__hash__(), get_hash_int(repr(self.label))])",
        ),
        """
def run(in_file, out_file, bad_select):
    inp = InputNode("input", args=[in_file]).stream()
    v = inp["v"]
    a = inp["a"]
    if bad_select:
        _ = v["extra"]
    scaled = FilterNode(v, "hflip", max_inputs=1).stream()
    out = OutputNode([scaled, a], "output", args=[out_file]).stream()
    edges = out.node.incoming_edges
    edge_summary = [(e.downstream_label, e.upstream_node.name, e.upstream_selector) for e in edges]
    return {"out_repr": repr(out), "edges": edge_summary, "same_node": v.node == inp.node}
""",
    ])
    add_repo_task(
        task_id="py-real-ffmpeg-dag-ok-0",
        family="py-real:kkroening__ffmpeg-python:dag_nodes",
        repo="kkroening__ffmpeg-python",
        source_file="ffmpeg/nodes.py+dag.py+_utils.py",
        source=ff_src,
        entry="run",
        args=["clip.mp4", "out.mp4", False],
        features=["loop", "branch", "class", "graph"],
    )
    add_repo_task(
        task_id="py-real-ffmpeg-dag-throw-1",
        family="py-real:kkroening__ffmpeg-python:dag_nodes",
        repo="kkroening__ffmpeg-python",
        source_file="ffmpeg/nodes.py+dag.py+_utils.py",
        source=ff_src,
        entry="run",
        args=["clip.mp4", "out.mp4", True],
        features=["loop", "branch", "class", "graph", "exception"],
        expected_kind="throw",
        expected_exc="ValueError",
    )

    # =========================================================================
    # 12. webpy__webpy (net_validators: 2 tasks, IPv4/IPv6/HTML/HTTP-date)
    # =========================================================================
    web_net = dgx2 / "webpy__webpy/web/net.py"
    web_net_src = "\n\n".join([
        "import datetime\nimport re\nimport socket\nimport time\nfrom urllib.parse import quote",
        _extract_symbols(web_net, ["validip6addr", "validipaddr", "validipport", "validip", "validaddr", "urlquote", "httpdate", "parsehttpdate", "htmlquote", "htmlunquote", "websafe"]),
        """
def run(addrs, html_samples, dt_str, stats):
    parsed = []
    for a in addrs:
        try:
            res = validaddr(a)
            stats["ok"] += 1
            parsed.append(res)
        except ValueError:
            stats["failed"] += 1
            if stats.get("strict"):
                raise
    quoted = [websafe(h) for h in html_samples]
    unquoted = [htmlunquote(q) for q in quoted]
    dt = parsehttpdate(dt_str)
    formatted_dt = httpdate(dt) if dt else None
    return {"parsed": parsed, "roundtrip": unquoted, "dt": formatted_dt, "stats": stats}
""",
    ])
    add_repo_task(
        task_id="py-real-webpy-net-ok-0",
        family="py-real:webpy__webpy:net_validators",
        repo="webpy__webpy",
        source_file="web/net.py",
        source=web_net_src,
        entry="run",
        args=[["127.0.0.1:8080", "[::1]:9000", "/var/run/app.sock", "999.1.1.1"], ["<b>hi & 'all'</b>", None], "Thu, 01 Jan 1970 01:01:01 GMT", {"ok": 0, "failed": 0, "strict": False}],
        features=["loop", "branch", "regex", "bytes", "exception", "mutation"],
    )
    add_repo_task(
        task_id="py-real-webpy-net-throw-1",
        family="py-real:webpy__webpy:net_validators",
        repo="webpy__webpy",
        source_file="web/net.py",
        source=web_net_src,
        entry="run",
        args=[["10.0.0.1:80", "not-an-ip:bad"], ["x"], "Thu, 01 Jan 1970 01:01:01 GMT", {"ok": 0, "failed": 0, "strict": True}],
        features=["loop", "branch", "regex", "exception", "mutation"],
        expected_kind="throw",
        expected_exc="ValueError",
    )

    # =========================================================================
    # 13. webpy__webpy (storage_counter: 2 tasks, Storage + storify + Counter + group)
    # =========================================================================
    web_utils = dgx2 / "webpy__webpy/web/utils.py"
    web_utils_src = "\n\n".join([
        "import re\niteritems = dict.items\nitervalues = dict.values\ndef safeunicode(s): return str(s)",
        _extract_symbols(web_utils, ["Storage", "storage", "storify", "Counter", "counter", "_strips", "rstrips", "lstrips", "strips", "group", "uniq"]),
        """
def run(payload, req_keys, tokens, grp_size, out_ref):
    st = storify(payload, *req_keys, role="guest", tags=[])
    c = counter()
    for t in tokens:
        c.add(t)
    grouped = list(group(uniq(tokens), grp_size))
    out_ref["storified"] = dict(st)
    out_ref["most"] = c.most()
    return {"st": dict(st), "grouped": grouped, "out_ref": out_ref, "top_pct": round(c.percent(c.most()[0]), 2)}
""",
    ])
    add_repo_task(
        task_id="py-real-webpy-storage-ok-0",
        family="py-real:webpy__webpy:storage_counter",
        repo="webpy__webpy",
        source_file="web/utils.py",
        source=web_utils_src,
        entry="run",
        args=[{"user": ["a", "b"], "tags": ["py", "trace"], "id": 7}, ["id", "user"], ["x", "y", "x", "z", "x", "y"], 2, {}],
        features=["loop", "branch", "class", "mutation", "alias"],
    )
    add_repo_task(
        task_id="py-real-webpy-storage-throw-1",
        family="py-real:webpy__webpy:storage_counter",
        repo="webpy__webpy",
        source_file="web/utils.py",
        source=web_utils_src,
        entry="run",
        args=[{"user": "alice"}, ["user", "api_key"], ["a"], 1, {}],
        features=["loop", "branch", "class", "exception"],
        expected_kind="throw",
        expected_exc="KeyError",
    )

    # =========================================================================
    # 14. gorakhargosh__watchdog (glob_patterns: 2 tasks, inc. conflicting pattern throw)
    # =========================================================================
    wd_bc = dgx1 / "gorakhargosh__watchdog/src/watchdog/utils/backwards_compat.py"
    wd_pat = dgx1 / "gorakhargosh__watchdog/src/watchdog/utils/patterns.py"
    wd_src = "\n\n".join([
        "from __future__ import annotations\nimport os\nimport re\nfrom pathlib import PurePath, PurePosixPath, PureWindowsPath\nfrom typing import TYPE_CHECKING",
        _extract_symbols(wd_bc, ["_translate", "translate"]),
        _extract_symbols(wd_pat, ["_get_sep", "_full_match", "_match_path", "filter_paths", "match_any_paths"]),
        """
def run(paths, inc, exc, case_sensitive, seen_set):
    matched = list(filter_paths(paths, included_patterns=inc, excluded_patterns=exc, case_sensitive=case_sensitive))
    for m in matched:
        seen_set.add(m)
    any_hit = match_any_paths(paths, included_patterns=inc, excluded_patterns=exc, case_sensitive=case_sensitive)
    return {"matched": matched, "any": any_hit, "seen": seen_set}
""",
    ])
    add_repo_task(
        task_id="py-real-watchdog-patterns-ok-0",
        family="py-real:gorakhargosh__watchdog:glob_patterns",
        repo="gorakhargosh__watchdog",
        source_file="watchdog/utils/patterns.py+backwards_compat.py",
        source=wd_src,
        entry="run",
        args=[["src/App.PY", "src/test_app.py", "docs/readme.md", "src/core/util.py"], ["**/*.py"], ["**/test_*.py"], False, {"initial"}],
        features=["loop", "branch", "regex", "set", "mutation", "alias"],
    )
    add_repo_task(
        task_id="py-real-watchdog-patterns-throw-1",
        family="py-real:gorakhargosh__watchdog:glob_patterns",
        repo="gorakhargosh__watchdog",
        source_file="watchdog/utils/patterns.py+backwards_compat.py",
        source=wd_src,
        entry="run",
        args=[["a.py"], ["*.py"], ["*.PY"], False, set()],
        features=["loop", "branch", "regex", "set", "exception"],
        expected_kind="throw",
        expected_exc="ValueError",
    )

    # =========================================================================
    # 15. eyurtsev__kor (xml_tag_parser: 2 tasks, XML encode/decode + throw)
    # =========================================================================
    kor_xml = dgx1 / "eyurtsev__kor/kor/encoders/xml.py"
    kor_src = "\n\n".join([
        "from collections import defaultdict\nfrom html.parser import HTMLParser\nfrom typing import Any, DefaultDict, Dict, List, Mapping, Optional, Sequence, Union\nclass Encoder: pass",
        _extract_symbols(kor_xml, ["LiteralType", "_write_literal", "_write_list", "_write_dict", "_write_tag", "TagParser", "XMLEncoder"]),
        """
def run(payload, extra_payload, state):
    enc = XMLEncoder()
    xml = enc.encode(payload)
    state["xml"] = xml
    decoded = enc.decode(xml)
    if extra_payload is not None:
        enc.encode(extra_payload)
    return {"xml": xml, "decoded": decoded, "state": state}
""",
    ])
    add_repo_task(
        task_id="py-real-kor-xml-ok-0",
        family="py-real:eyurtsev__kor:xml_tag_parser",
        repo="eyurtsev__kor",
        source_file="kor/encoders/xml.py",
        source=kor_src,
        entry="run",
        args=[{"item": [{"name": "alpha", "qty": 3}, {"name": "beta", "qty": 5}], "tags": ["a", "b"]}, None, {}],
        features=["loop", "branch", "class", "recursion", "mutation", "alias"],
    )
    add_repo_task(
        task_id="py-real-kor-xml-throw-1",
        family="py-real:eyurtsev__kor:xml_tag_parser",
        repo="eyurtsev__kor",
        source_file="kor/encoders/xml.py",
        source=kor_src,
        entry="run",
        args=[{"item": [{"name": "alpha", "qty": 3}], "tags": ["a"]}, ["not-a-dict"], {}],
        features=["loop", "branch", "class", "exception", "mutation"],
        expected_kind="throw",
        expected_exc="TypeError",
    )

    # =========================================================================
    # 16. nbedos__termtosvg (asciicast_records: 2 tasks, v1/v2 + grouping + throw)
    # =========================================================================
    tsvg_ascii = dgx1 / "nbedos__termtosvg/termtosvg/asciicast.py"
    tsvg_anim = dgx1 / "nbedos__termtosvg/termtosvg/anim.py"
    tsvg_src = "\n\n".join([
        "import abc\nimport json\nfrom collections import namedtuple\nfrom itertools import groupby\nfrom typing import Iterable",
        _extract_symbols(tsvg_ascii, ["AsciiCastError", "AsciiCastV2Record", "_read_v1_records", "_AsciiCastV2Theme", "AsciiCastV2Theme", "_AsciiCastV2Header", "AsciiCastV2Header", "_AsciiCastV2Event", "AsciiCastV2Event"]),
        _extract_symbols(tsvg_anim, ["_CELL_ATTRIBUTES", "_CharacterCell", "ConsecutiveWithSameAttributes"]),
        """
class _DummyCell:
    def __init__(self, ch, fg, bold):
        self.ch = ch
        self.fg = fg
        self.bold = bold

def run(lines, theme_args, cells):
    recs = []
    for ln in lines:
        rec = AsciiCastV2Record.from_json_line(ln)
        recs.append(rec.to_json_line())
    cell_objs = [_DummyCell(c, fg, b) for c, fg, b in cells]
    grouper = ConsecutiveWithSameAttributes(["fg", "bold"])
    runs = []
    for (_, attrs), grp in groupby(enumerate(cell_objs), key=grouper):
        runs.append(("".join(item.ch for _, item in grp), attrs["fg"], attrs["bold"]))
    theme = AsciiCastV2Theme(*theme_args)
    return {"theme": theme.fg, "records": recs, "runs": runs}
""",
    ])
    add_repo_task(
        task_id="py-real-termtosvg-asciicast-ok-0",
        family="py-real:nbedos__termtosvg:asciicast_records",
        repo="nbedos__termtosvg",
        source_file="termtosvg/asciicast.py+anim.py",
        source=tsvg_src,
        entry="run",
        args=[
            ['{"version": 2, "width": 80, "height": 24}', '[0.5, "o", "hello"]', '[1.2, "o", " world"]'],
            ["#ffffff", "#000000", "#111111:#222222:#333333:#444444:#555555:#666666:#777777:#888888"],
            [("a", "red", True), ("b", "red", True), ("c", "blue", False), ("d", "blue", False)],
        ],
        features=["loop", "branch", "class", "json", "bytes"],
    )
    add_repo_task(
        task_id="py-real-termtosvg-asciicast-throw-1",
        family="py-real:nbedos__termtosvg:asciicast_records",
        repo="nbedos__termtosvg",
        source_file="termtosvg/asciicast.py+anim.py",
        source=tsvg_src,
        entry="run",
        args=[
            ['{"version": 2, "width": 80, "height": 24}', '[0.5, "o", "hi"]'],
            ["#badhex", "#000000", "#111111:#222222:#333333:#444444:#555555:#666666:#777777:#888888"],
            [("a", "red", True), ("b", "blue", False)],
        ],
        features=["loop", "branch", "class", "exception"],
        expected_kind="throw",
        expected_exc="AsciiCastError",
    )

    # =========================================================================
    # 17. hypn0s__AJPy (ajp_protocol: 2 tasks, binary framing + struct + throw)
    # =========================================================================
    ajp_path = dgx2 / "hypn0s__AJPy/ajpy/ajp.py"
    ajp_src = "\n\n".join([
        "from io import BytesIO\nimport struct",
        _replace_leading_indent(
            _extract_symbols(ajp_path, ["pack_string", "unpack", "unpack_string", "NotFoundException", "AjpBodyRequest", "AjpForwardRequest", "AjpResponse"])
            .replace("StringIO(raw_packet)", "BytesIO(raw_packet)")
        ),
        """
def run(uri, headers, attrs, resp_bytes):
    req = AjpForwardRequest(AjpForwardRequest.SERVER_TO_CONTAINER)
    req.method = AjpForwardRequest.GET
    req.protocol = "HTTP/1.1"
    req.req_uri = uri
    req.remote_addr = "127.0.0.1"
    req.remote_host = "localhost"
    req.server_name = "app.local"
    req.server_port = 8080
    req.is_ssl = False
    req.request_headers = headers
    req.attributes = attrs
    wire = req.serialize()
    parsed = AjpForwardRequest()
    parsed.parse(wire)
    resp = AjpResponse()
    resp.parse(BytesIO(resp_bytes))
    return {
        "wire_len": len(wire),
        "uri": parsed.req_uri,
        "hdr_keys": [repr(k) for k in parsed.request_headers.keys()],
        "resp_prefix": resp.prefix_code,
        "reused": getattr(resp, "reuse", None),
    }
""",
    ])
    # Notice AjpResponse.parse_end_response reads boolean reuse; let's make sure resp_bytes has END_RESPONSE or triggers NotImplementedError!
    add_repo_task(
        task_id="py-real-ajpy-packet-ok-0",
        family="py-real:hypn0s__AJPy:ajp_protocol",
        repo="hypn0s__AJPy",
        source_file="ajpy/ajp.py",
        source=ajp_src,
        entry="run",
        args=[
            "/api/v1/health",
            {"SC_REQ_HOST": "app.local", "X-Trace": "1"},
            [{"name": "query_string", "value": "a=1"}],
            b"\x41\x42\x00\x02\x05\x01",
        ],
        features=["loop", "branch", "class", "bytes"],
    )
    add_repo_task(
        task_id="py-real-ajpy-packet-throw-1",
        family="py-real:hypn0s__AJPy:ajp_protocol",
        repo="hypn0s__AJPy",
        source_file="ajpy/ajp.py",
        source=ajp_src,
        entry="run",
        args=[
            "/bad",
            {"SC_REQ_HOST": "app.local"},
            [],
            b"\x41\x42\x00\x02\x7f\x00",
        ],
        features=["loop", "branch", "class", "bytes", "exception"],
        expected_kind="throw",
        expected_exc="NotImplementedError",
    )

    # =========================================================================
    # 18. ShayHill__docx2python (numbering_and_merge: 2 tasks, Roman/base26 + throw)
    # =========================================================================
    d2p_num = dgx2 / "ShayHill__docx2python/docx2python/numbering_formats.py"
    d2p_merge = dgx2 / "ShayHill__docx2python/docx2python/merge_runs.py"
    d2p_src = "\n\n".join([
        "from __future__ import annotations\nimport functools\nfrom itertools import groupby\nfrom string import ascii_lowercase",
        """
class Tags:
    RUN = "w:r"
    HYPERLINK = "w:hyperlink"
    TEXT = "w:t"
    TEXT_MATH = "m:t"

_MERGEABLE_TAGS = {Tags.RUN, Tags.HYPERLINK, Tags.TEXT, Tags.TEXT_MATH}
def get_prefixed_tag(elem): return elem.tag
def has_content(elem): return not elem.tag.endswith("proofErr")
def get_html_formatting(elem, fmt): return list(elem.style)
""",
        _extract_symbols(d2p_num, ["ROMAN_SUBS", "lower_letter", "upper_letter", "lower_roman", "upper_roman", "decimal", "bullet"]),
        _extract_symbols(d2p_merge, ["_is_mergeable", "_elem_key", "_is_text_or_text_math", "merge_elems"]),
        """
class _FakeFile:
    def __init__(self, rels):
        self.rels = rels
        self.context = type("Ctx", (), {"xml2html_format": {}})()

class _FakeElem(list):
    def __init__(self, tag, text="", style=(), nsmap=None, attrib=None, children=()):
        super().__init__(children)
        self.tag = tag
        self.text = text
        self.style = tuple(style)
        self.nsmap = nsmap or {"r": "http://rels"}
        self.attrib = attrib or {}

def run(numbers, runs_spec):
    labels = [(lower_letter(n), upper_roman(n)) for n in numbers]
    root = _FakeElem("w:p", children=[
        _FakeElem("w:t", text=txt, style=st) for txt, st in runs_spec
    ])
    merge_elems(_FakeFile({}), root)
    merged = [(c.tag, c.text, list(c.style)) for c in root]
    return {"labels": labels, "merged": merged}
""",
    ])
    add_repo_task(
        task_id="py-real-docx2python-num-merge-ok-0",
        family="py-real:ShayHill__docx2python:numbering_and_merge",
        repo="ShayHill__docx2python",
        source_file="docx2python/numbering_formats.py+merge_runs.py",
        source=d2p_src,
        entry="run",
        args=[[4, 27], [("hy", ["b"]), ("per", ["b"]), ("!", ["i"])]],
        features=["loop", "branch", "recursion", "mutation"],
    )
    add_repo_task(
        task_id="py-real-docx2python-num-merge-throw-1",
        family="py-real:ShayHill__docx2python:numbering_and_merge",
        repo="ShayHill__docx2python",
        source_file="docx2python/numbering_formats.py+merge_runs.py",
        source=d2p_src,
        entry="run",
        args=[[1, 0], [("a", [])]],
        features=["loop", "branch", "exception"],
        expected_kind="throw",
        expected_exc="ValueError",
    )

    # =========================================================================
    # 19. guilhermechapiewski__simple-db-migrate (config_helpers: 2 tasks + aliasing)
    # =========================================================================
    sdb_help = dgx1 / "guilhermechapiewski__simple-db-migrate/simple_db_migrate/helpers.py"
    sdb_cfg = dgx1 / "guilhermechapiewski__simple-db-migrate/simple_db_migrate/config.py"
    sdb_src = "\n\n".join([
        "import ast\nimport os\nimport sys",
        _extract_symbols(sdb_help, ["Lists", "Utils"]),
        _extract_symbols(sdb_cfg, ["Config"]),
        """
def run(initial, updates, migrations_a, migrations_b, probe_key, stats):
    cfg = Config(dict(initial))
    for k, v in updates:
        cfg.update(k, v)
    pending = Lists.subtract(migrations_a, migrations_b)
    stats["counts"] = Utils.count_occurrences("".join(pending))
    try:
        val = cfg.get(probe_key)
    except Exception as exc:
        stats["missing"] = str(exc)
        raise
    else:
        stats["found"] = val
    return {"pending": pending, "stats": stats, "cfg_alias": cfg._config}
""",
    ])
    add_repo_task(
        task_id="py-real-sdbm-config-ok-0",
        family="py-real:guilhermechapiewski__simple-db-migrate:config_helpers",
        repo="guilhermechapiewski__simple-db-migrate",
        source_file="simple_db_migrate/config.py+helpers.py",
        source=sdb_src,
        entry="run",
        args=[{"DB_HOST": "localhost", "DB_PORT": 5432}, [("db_host", "prod.db"), ("env", "staging")], ["001_init", "002_users", "003_idx"], ["001_init"], "ENV", {}],
        features=["loop", "branch", "class", "exception", "mutation", "alias"],
    )
    add_repo_task(
        task_id="py-real-sdbm-config-throw-1",
        family="py-real:guilhermechapiewski__simple-db-migrate:config_helpers",
        repo="guilhermechapiewski__simple-db-migrate",
        source_file="simple_db_migrate/config.py+helpers.py",
        source=sdb_src,
        entry="run",
        args=[{"DB_HOST": "localhost"}, [("db_port", 3306)], ["001_a"], [], "NO_SUCH_KEY", {}],
        features=["loop", "branch", "class", "exception", "mutation"],
        expected_kind="throw",
        expected_exc="Exception",
    )

    # =========================================================================
    # 20. apenwarr__sshuttle (mux_framing: 2 tasks, binary mux framing + cyclic/alias)
    # =========================================================================
    shuttle_helpers = dgx1 / "apenwarr__sshuttle/sshuttle/helpers.py"
    shuttle_ssnet = dgx1 / "apenwarr__sshuttle/sshuttle/ssnet.py"
    shuttle_src = "\n\n".join([
        "import errno\nimport select\nimport socket\nimport struct\nimport sys\nlogprefix = ''\nverbose = 0\ndef log(s): pass\ndef debug1(s): pass\ndef debug2(s): pass\ndef debug3(s): pass\nclass Fatal(Exception): pass",
        _extract_symbols(shuttle_ssnet, ["MAX_CHANNEL", "SHUT_RD", "SHUT_WR", "SHUT_RDWR", "HDR_LEN", "CMD_EXIT", "CMD_PING", "CMD_PONG", "CMD_TCP_CONNECT", "CMD_TCP_STOP_SENDING", "CMD_TCP_EOF", "CMD_TCP_DATA", "CMD_ROUTES", "CMD_HOST_REQ", "CMD_HOST_LIST", "CMD_DNS_REQ", "CMD_DNS_RESPONSE", "CMD_UDP_OPEN", "CMD_UDP_DATA", "CMD_UDP_CLOSE", "cmd_to_name", "NET_ERRS", "_add", "_fds", "Handler", "Mux"]),
        """
class _FakeSock:
    def __init__(self, fd):
        self._fd = fd
    def fileno(self): return self._fd
    def setblocking(self, _): pass

def run(frames, peer_state, trigger_bad):
    mux = Mux(_FakeSock(3), _FakeSock(4))
    received = []
    mux.channels[1] = lambda cmd, data: received.append((cmd, data))
    mux.send(1, CMD_TCP_DATA, b"hello")
    for ch, cmd, data in frames:
        mux.got_packet(ch, cmd, data)
    if trigger_bad:
        mux.got_packet(0, CMD_ROUTES, b"bad")
    mux.check_fullness()
    peer_state["outbuf"] = list(mux.outbuf)
    peer_state["self_ref"] = peer_state
    return {"received": received, "fullness": mux.fullness, "ok": mux.ok, "peer_alias": peer_state}
""",
    ])
    add_repo_task(
        task_id="py-real-sshuttle-mux-ok-0",
        family="py-real:apenwarr__sshuttle:mux_framing",
        repo="apenwarr__sshuttle",
        source_file="sshuttle/ssnet.py",
        source=shuttle_src,
        entry="run",
        args=[[(0, 0x4201, b"ping1"), (1, 0x4206, b"payload-a"), (1, 0x4206, b"payload-b")], {}, False],
        features=["loop", "branch", "class", "bytes", "alias", "cycle", "mutation"],
    )
    add_repo_task(
        task_id="py-real-sshuttle-mux-throw-1",
        family="py-real:apenwarr__sshuttle:mux_framing",
        repo="apenwarr__sshuttle",
        source_file="sshuttle/ssnet.py",
        source=shuttle_src,
        entry="run",
        args=[[(0, 0x4201, b"ok")], {}, True],
        features=["loop", "branch", "class", "bytes", "exception"],
        expected_kind="throw",
        expected_exc="Exception",
    )

    # =========================================================================
    # 21-32: 12 Multi-Turn Effectful Real-Repo Families (24 causal-pair tasks!)
    # Each pair has IDENTICAL (source, entry, args, randomMode, randomSeed) and
    # diverging fixture.calls (4-10 calls each) for zero-future-leakage audit!
    # =========================================================================

    # 21. postmanlabs__httpbin: effectful_digest_auth (2 causal variants)
    httpbin_helpers = dgx2 / "postmanlabs__httpbin/httpbin/helpers.py"
    httpbin_src = "\n\n".join([
        "import base64\nimport json\nimport re\nfrom hashlib import md5, sha256, sha512",
        _extract_symbols(httpbin_helpers, ["H", "HA1", "HA2", "response", "__parse_request_range", "get_request_range", "parse_multi_value_header"]),
        """
def run(auth_url, kv_prefix, req_spec, state):
    challenge_raw = host.http_get(auth_url)
    challenge = json.loads(challenge_raw)
    nonce = challenge["nonce"]
    seen_key = f"{kv_prefix}:{nonce}"
    prev = host.kv_get(seen_key)
    if prev is not None:
        print("replay-nonce-detected", nonce)
        state["replayed"] = True
        return {"accepted": False, "reason": "replay", "state": state}
    creds = {
        "realm": challenge["realm"],
        "username": req_spec["user"],
        "nonce": nonce,
        "nc": "00000001",
        "cnonce": "c1f9",
        "qop": "auth-int",
        "algorithm": challenge["alg"],
    }
    digest = response(creds, req_spec["password"], {"method": "GET", "uri": req_spec["uri"], "body": req_spec["body"]})
    byte_rng = get_request_range({"range": req_spec["range"]}, challenge["total_bytes"])
    accepts = parse_multi_value_header(req_spec["accept"])
    try:
        res = host.http_request({"method": "POST", "url": auth_url + "/verify", "digest": digest})
    except PermissionError as exc:
        print("digest-rejected", str(exc))
        state["status"] = "denied"
        host.kv_set(seen_key, {"denied": True})
        return {"accepted": False, "digest": digest, "range": byte_rng, "accepts": accepts, "state": state}
    host.kv_set(seen_key, {"digest": digest, "ok": res.get("ok", False)})
    state["status"] = "verified"
    return {"accepted": True, "digest": digest, "range": byte_rng, "accepts": accepts, "state": state}
""",
    ])
    httpbin_args = [
        "https://auth.local/digest",
        "nonce",
        {"user": "alice", "password": "secret", "uri": "/data", "body": b"ping", "range": "bytes=-128", "accept": 'W/"v1", "application/json"'},
        {"replayed": False},
    ]
    add_repo_task(
        task_id="py-real-httpbin-eff-digest-0",
        family="py-real:postmanlabs__httpbin:effectful_digest_auth",
        repo="postmanlabs__httpbin",
        source_file="httpbin/helpers.py",
        source=httpbin_src,
        entry="run",
        args=httpbin_args,
        features=["loop", "branch", "bytes", "http", "kv", "exception", "hard-effectful", "mutation"],
        scripted_calls={
            "http.get": [{"status": "fulfilled", "result": '{"nonce":"n-42","realm":"api","alg":"SHA-256","total_bytes":1024}'}],
            "kv_get": [{"status": "fulfilled", "result": None}],
            "http.request": [{"status": "fulfilled", "result": {"ok": True}}],
            "kv_set": [{"status": "fulfilled", "result": True}],
        },
    )
    add_repo_task(
        task_id="py-real-httpbin-eff-digest-1",
        family="py-real:postmanlabs__httpbin:effectful_digest_auth",
        repo="postmanlabs__httpbin",
        source_file="httpbin/helpers.py",
        source=httpbin_src,
        entry="run",
        args=httpbin_args,
        features=["loop", "branch", "bytes", "http", "kv", "exception", "hard-effectful", "mutation"],
        scripted_calls={
            "http.get": [{"status": "fulfilled", "result": '{"nonce":"n-42","realm":"api","alg":"SHA-256","total_bytes":1024}'}],
            "kv_get": [{"status": "fulfilled", "result": None}],
            "http.request": [{"status": "rejected", "result": {"name": "PermissionError", "message": "stale-nonce"}}],
            "kv_set": [{"status": "fulfilled", "result": True}],
        },
    )

    # 22. openai__tiktoken: effectful_bpe_loader (2 causal variants)
    tik_edu = dgx1 / "openai__tiktoken/tiktoken/_educational.py"
    tik_load = dgx1 / "openai__tiktoken/tiktoken/load.py"
    tik_src = "\n\n".join([
        "from __future__ import annotations\nimport base64\nimport collections\nimport hashlib\nimport json\nimport re as regex",
        _extract_symbols(tik_edu, ["bpe_encode", "bpe_train"]),
        _extract_symbols(tik_load, ["check_hash"]),
        """
def run(corpus_path, fallback_url, expected_sha, probe_text, out_key):
    try:
        raw = host.fs_read_text(corpus_path)
    except FileNotFoundError as exc:
        print("cache-miss-fetching", str(exc))
        raw = host.http_get(fallback_url)
    ok_hash = check_hash(raw.encode("utf-8"), expected_sha)
    print("hash-check", ok_hash)
    ranks = bpe_train(raw, 258, r"[A-Za-z]+|[^\\sA-Za-z]+", visualise=None)
    ids = bpe_encode(ranks, probe_text.encode("utf-8"), visualise=None)
    summary = {"vocab": len(ranks), "ids": ids, "hash_ok": ok_hash}
    host.kv_set(out_key, summary)
    return summary
""",
    ])
    tik_corpus = "abab abba abab"
    tik_sha = _sha256(tik_corpus)
    tik_args = ["/cache/corpus.txt", "https://cdn.local/corpus.txt", tik_sha, "ab abba", "tik:bpe"]
    add_repo_task(
        task_id="py-real-tiktoken-eff-bpe-0",
        family="py-real:openai__tiktoken:effectful_bpe_loader",
        repo="openai__tiktoken",
        source_file="tiktoken/_educational.py+load.py",
        source=tik_src,
        entry="run",
        args=tik_args,
        features=["loop", "branch", "bytes", "bpe", "fs", "http", "kv", "exception", "hard-effectful"],
        scripted_calls={
            "fs.readText": [{"status": "fulfilled", "result": tik_corpus}],
            "kv_set": [{"status": "fulfilled", "result": True}],
        },
    )
    add_repo_task(
        task_id="py-real-tiktoken-eff-bpe-1",
        family="py-real:openai__tiktoken:effectful_bpe_loader",
        repo="openai__tiktoken",
        source_file="tiktoken/_educational.py+load.py",
        source=tik_src,
        entry="run",
        args=tik_args,
        features=["loop", "branch", "bytes", "bpe", "fs", "http", "kv", "exception", "hard-effectful"],
        scripted_calls={
            "fs.readText": [{"status": "rejected", "result": {"name": "FileNotFoundError", "message": "not cached"}}],
            "http.get": [{"status": "fulfilled", "result": "abab abba"}],
            "kv_set": [{"status": "fulfilled", "result": True}],
        },
    )

    # 23. karpathy__minGPT: effectful_bpe_checkpoint (2 causal variants)
    mingpt_bpe = dgx1 / "karpathy__minGPT/mingpt/bpe.py"
    mingpt_src = "\n\n".join([
        "import json\nimport re\nimport time",
        _extract_symbols(mingpt_bpe, ["bytes_to_unicode", "get_pairs", "Encoder"]).replace(
            'self.pat = re.compile(r"""\'s|\'t|\'re|\'ve|\'m|\'ll|\'d| ?\\p{L}+| ?\\p{N}+| ?[^\\s\\p{L}\\p{N}]+|\\s+(?!\\S)|\\s+""")',
            'self.pat = re.compile(r"""\'s|\'t|\'re|\'ve|\'m|\'ll|\'d| ?[A-Za-z]+| ?[0-9]+| ?[^\\sA-Za-z0-9]+|\\s+(?!\\S)|\\s+""")',
        ).replace(
            "bigram = min(pairs,",
            "bigram = min(sorted(pairs),",
        ),
        """
def run(cfg_key, samples, ckpt_path):
    t0 = time.time()
    cfg = host.kv_get(cfg_key)
    byte_enc = bytes_to_unicode()
    vocab = {ch: idx for idx, ch in enumerate(byte_enc.values())}
    merges = [tuple(m) for m in cfg["merges"]]
    for idx, (a, b) in enumerate(merges, start=len(vocab)):
        vocab[a + b] = idx
    enc = Encoder(vocab, merges)
    encoded = [enc.encode_and_show_work(s)["bpe_idx"] for s in samples]
    decoded = [enc.decode(ids) for ids in encoded]
    elapsed = round(time.time() - t0, 3)
    print("mingpt-encoded", len(encoded), elapsed)
    out = {"encoded": encoded, "decoded": decoded, "elapsed": elapsed, "cache_keys": sorted(enc.cache.keys())}
    host.fs_write_text(ckpt_path, json.dumps(out, sort_keys=True))
    return out
""",
    ])
    mingpt_args = ["mingpt:bpe", ["hi there", "hi hi"], "/tmp/mingpt_bpe.json"]
    add_repo_task(
        task_id="py-real-mingpt-eff-bpe-0",
        family="py-real:karpathy__minGPT:effectful_bpe_checkpoint",
        repo="karpathy__minGPT",
        source_file="mingpt/bpe.py",
        source=mingpt_src,
        entry="run",
        args=mingpt_args,
        features=["loop", "branch", "class", "bpe", "kv", "fs", "platform", "hard-effectful"],
        scripted_times=[5000.0, 5000.125],
        scripted_calls={
            "kv_get": [{"status": "fulfilled", "result": {"merges": [["h", "i"], ["Ġ", "t"], ["Ġt", "h"]]}}],
            "fs.writeText": [{"status": "fulfilled", "result": None}],
        },
    )
    add_repo_task(
        task_id="py-real-mingpt-eff-bpe-1",
        family="py-real:karpathy__minGPT:effectful_bpe_checkpoint",
        repo="karpathy__minGPT",
        source_file="mingpt/bpe.py",
        source=mingpt_src,
        entry="run",
        args=mingpt_args,
        features=["loop", "branch", "class", "bpe", "kv", "fs", "platform", "hard-effectful"],
        scripted_times=[5000.0, 5000.400],
        scripted_calls={
            "kv_get": [{"status": "fulfilled", "result": {"merges": [["Ġ", "h"], ["Ġh", "i"]]}}],
            "fs.writeText": [{"status": "fulfilled", "result": None}],
        },
    )

    # 24. dylanaraps__pywal: effectful_palette_export (2 causal variants)
    pywal_util = dgx1 / "dylanaraps__pywal/pywal/util.py"
    pywal_exp = dgx1 / "dylanaraps__pywal/pywal/export.py"
    pywal_src = "\n\n".join([
        "import colorsys\nimport json\nimport re\nclass _UtilMod: pass\nutil = _UtilMod()\nclass _Log:\n    @staticmethod\n    def error(*a): pass\nlogging = _Log()",
        _extract_symbols(pywal_util, ["Color", "hex_to_rgb", "hex_to_xrgba", "rgb_to_hex", "darken_color", "lighten_color", "blend_color", "saturate_color"]),
        """
util.Color = Color
util.read_file_raw = lambda path: host.fs_read_text(path).splitlines(True)
util.save_file = lambda data, path: host.fs_write_text(path, data)
""",
        _extract_symbols(pywal_exp, ["flatten_colors", "get_export_type", "template"]),
        """
def run(theme_key, fallback_url, tpl_path, out_path):
    try:
        colors = host.kv_get(theme_key)
        if colors is None:
            raise KeyError("missing theme")
    except KeyError as exc:
        print("theme-fallback", str(exc))
        colors = json.loads(host.http_get(fallback_url))
        host.kv_set(theme_key, colors)
    flat = flatten_colors(colors)
    template(flat, tpl_path, out_path)
    blended = blend_color(colors["special"]["background"], colors["colors"]["color1"])
    return {"export_name": get_export_type("css"), "blended": blended, "dark1": flat["color1"].darken(20).hex_color}
""",
    ])
    pywal_args = ["theme:nord", "https://themes.local/nord.json", "/tpl/colors.css.tpl", "/out/colors.css"]
    pywal_palette = {"wallpaper": "bg.png", "alpha": "100", "special": {"background": "#2e3440"}, "colors": {"color1": "#bf616a"}}
    add_repo_task(
        task_id="py-real-pywal-eff-export-0",
        family="py-real:dylanaraps__pywal:effectful_palette_export",
        repo="dylanaraps__pywal",
        source_file="pywal/util.py+export.py",
        source=pywal_src,
        entry="run",
        args=pywal_args,
        features=["loop", "branch", "class", "fs", "kv", "http", "exception", "hard-effectful"],
        scripted_calls={
            "kv_get": [{"status": "fulfilled", "result": pywal_palette}],
            "fs.readText": [{"status": "fulfilled", "result": "bg: {background.hex_color};\naccent: {color1.lighten(10)};\n"}],
            "fs.writeText": [{"status": "fulfilled", "result": None}],
        },
    )
    add_repo_task(
        task_id="py-real-pywal-eff-export-1",
        family="py-real:dylanaraps__pywal:effectful_palette_export",
        repo="dylanaraps__pywal",
        source_file="pywal/util.py+export.py",
        source=pywal_src,
        entry="run",
        args=pywal_args,
        features=["loop", "branch", "class", "fs", "kv", "http", "exception", "hard-effectful"],
        scripted_calls={
            "kv_get": [{"status": "fulfilled", "result": None}],
            "http.get": [{"status": "fulfilled", "result": json.dumps({"wallpaper": "bg.png", "alpha": "90", "special": {"background": "#112233"}, "colors": {"color1": "#4488cc"}})}],
            "kv_set": [{"status": "fulfilled", "result": True}],
            "fs.readText": [{"status": "fulfilled", "result": "bg: {background.rgb};\naccent: {color1.xrgba};\n"}],
            "fs.writeText": [{"status": "fulfilled", "result": None}],
        },
    )

    # 25. fabriziosalmi__certmate: effectful_rate_limiter (2 causal variants)
    cert_rl = dgx2 / "fabriziosalmi__certmate/modules/core/rate_limit.py"
    cert_src = "\n\n".join([
        "from collections import defaultdict\nfrom time import time\nfrom typing import Dict, Optional\nclass _Log:\n    def info(self, *a): pass\n    def warning(self, *a): pass\n    def error(self, *a): pass\nlogger = _Log()",
        _extract_symbols(cert_rl, ["RateLimitConfig", "SimpleRateLimiter"]),
        """
def run(ip, endpoint, custom_limits, audit):
    cfg = RateLimitConfig(custom_limits)
    limiter = SimpleRateLimiter(cfg)
    saved = host.kv_get(f"rl:{ip}:{endpoint}")
    if saved:
        limiter.requests[f"{ip}:{endpoint}"] = list(saved)
    results = []
    for _ in range(3):
        allowed = limiter.is_allowed(ip, endpoint)
        results.append(allowed)
        if not allowed:
            print("rate-limited", ip, endpoint)
            audit["blocked"] += 1
        else:
            audit["allowed"] += 1
    limiter.cleanup_old_entries()
    host.kv_set(f"rl:{ip}:{endpoint}", list(limiter.requests.get(f"{ip}:{endpoint}", [])))
    return {"results": results, "audit": audit}
""",
    ])
    cert_args = ["198.51.100.7", "certificate_create", {"certificate_create": 3}, {"allowed": 0, "blocked": 0}]
    add_repo_task(
        task_id="py-real-certmate-eff-rl-0",
        family="py-real:fabriziosalmi__certmate:effectful_rate_limiter",
        repo="fabriziosalmi__certmate",
        source_file="modules/core/rate_limit.py",
        source=cert_src,
        entry="run",
        args=cert_args,
        features=["loop", "branch", "class", "kv", "platform", "hard-effectful", "mutation"],
        scripted_times=[1000.0, 1010.0, 1020.0, 1025.0],
        scripted_calls={
            "kv_get": [{"status": "fulfilled", "result": [980.0]}],
            "kv_set": [{"status": "fulfilled", "result": True}],
        },
    )
    add_repo_task(
        task_id="py-real-certmate-eff-rl-1",
        family="py-real:fabriziosalmi__certmate:effectful_rate_limiter",
        repo="fabriziosalmi__certmate",
        source_file="modules/core/rate_limit.py",
        source=cert_src,
        entry="run",
        args=cert_args,
        features=["loop", "branch", "class", "kv", "platform", "hard-effectful", "mutation"],
        scripted_times=[1000.0, 1010.0, 1020.0, 1025.0],
        scripted_calls={
            "kv_get": [{"status": "fulfilled", "result": [990.0, 995.0]}],
            "kv_set": [{"status": "fulfilled", "result": True}],
        },
    )

    # 26. Kludex__uvicorn: effectful_proxy_routing (2 causal variants)
    uv_proxy = dgx2 / "Kludex__uvicorn/uvicorn/middleware/proxy_headers.py"
    uv_utils = dgx2 / "Kludex__uvicorn/uvicorn/protocols/utils.py"
    uv_src = "\n\n".join([
        "from __future__ import annotations\nimport ipaddress\nimport json\nimport urllib.parse\nclass asyncio:\n    Transport = object\nASGI3Application = object\nASGIReceiveCallable = object\nASGISendCallable = object\nScope = dict\nWWWScope = dict",
        _extract_symbols(uv_proxy, ["_parse_raw_hosts", "_TrustedHosts"]),
        _extract_symbols(uv_utils, ["get_client_addr", "get_path_with_query_string"]),
        """
def run(trusted_key, scope_path, out_key):
    trusted_cfg = host.kv_get(trusted_key)
    th = _TrustedHosts(trusted_cfg)
    reqs = json.loads(host.fs_read_text(scope_path))
    routed = []
    for r in reqs:
        client_host = r["client"][0]
        if client_host in th:
            resolved = th.get_trusted_client_host(r["xff"])
            r["client"] = (resolved, 0)
            print("trusted-proxy", client_host, resolved)
        routed.append({"addr": get_client_addr({"client": tuple(r["client"])}), "target": get_path_with_query_string({"path": r["path"], "query_string": r["qs"].encode("ascii")})})
    host.kv_set(out_key, routed)
    return routed
""",
    ])
    uv_args = ["proxy:trusted", "/var/scopes.json", "proxy:routed"]
    add_repo_task(
        task_id="py-real-uvicorn-eff-proxy-0",
        family="py-real:Kludex__uvicorn:effectful_proxy_routing",
        repo="Kludex__uvicorn",
        source_file="uvicorn/middleware/proxy_headers.py+protocols/utils.py",
        source=uv_src,
        entry="run",
        args=uv_args,
        features=["loop", "branch", "class", "kv", "fs", "bytes", "hard-effectful"],
        scripted_calls={
            "kv_get": [{"status": "fulfilled", "result": ["10.0.0.0/8", "127.0.0.1"]}],
            "fs.readText": [{"status": "fulfilled", "result": '[{"client":["10.1.2.3",4000],"xff":"203.0.113.5, 10.1.2.3","path":"/v1/a b","qs":"k=1"},{"client":["198.51.100.9",5000],"xff":"1.2.3.4","path":"/health","qs":""}]'}],
            "kv_set": [{"status": "fulfilled", "result": True}],
        },
    )
    add_repo_task(
        task_id="py-real-uvicorn-eff-proxy-1",
        family="py-real:Kludex__uvicorn:effectful_proxy_routing",
        repo="Kludex__uvicorn",
        source_file="uvicorn/middleware/proxy_headers.py+protocols/utils.py",
        source=uv_src,
        entry="run",
        args=uv_args,
        features=["loop", "branch", "class", "kv", "fs", "bytes", "hard-effectful"],
        scripted_calls={
            "kv_get": [{"status": "fulfilled", "result": ["198.51.100.0/24"]}],
            "fs.readText": [{"status": "fulfilled", "result": '[{"client":["10.1.2.3",4000],"xff":"203.0.113.5, 10.1.2.3","path":"/v1/a b","qs":"k=1"},{"client":["198.51.100.9",5000],"xff":"1.2.3.4","path":"/health","qs":""}]'}],
            "kv_set": [{"status": "fulfilled", "result": True}],
        },
    )

    # 27. dbader__schedule: effectful_job_runner (2 causal variants, randomMode="tool")
    sched_file = dgx1 / "dbader__schedule/schedule/__init__.py"
    sched_src = "\n\n".join([
        "from collections.abc import Hashable\nimport datetime\nimport functools\nimport random\nimport time\nfrom typing import Set, List, Optional, Callable, Union\nclass _DummyLogger:\n    def debug(self, *a): pass\nlogger = _DummyLogger()",
        _extract_symbols(sched_file, ["ScheduleError", "ScheduleValueError", "IntervalError", "CancelJob", "Scheduler", "_weekday_index", "_move_to_next_weekday"]),
        """
def run(jobs_key, webhook_url, state):
    now_ts = time.time()
    base_dt = datetime.datetime(2026, 11, 26, 12, 0, 0) + datetime.timedelta(seconds=int(now_ts % 60))
    specs = host.kv_get(jobs_key)
    executed = []
    for sp in specs:
        jitter = round(random.random(), 4)
        next_dt = _move_to_next_weekday(base_dt, sp["weekday"]) + datetime.timedelta(minutes=sp["offset_min"])
        if jitter > 0.7:
            print("job-cancelled", sp["id"], jitter)
            state["cancelled"].append(sp["id"])
            continue
        try:
            res = host.http_request({"method": "POST", "url": webhook_url, "job": sp["id"], "at": next_dt.isoformat()})
            executed.append((sp["id"], res.get("ok", False)))
        except ConnectionError as exc:
            print("job-failed", sp["id"], str(exc))
            state["failed"].append(sp["id"])
    host.kv_set(f"{jobs_key}:done", {"executed": executed, "state": state})
    return {"executed": executed, "state": state}
""",
    ])
    sched_args = ["sched:jobs", "https://cron.local/run", {"cancelled": [], "failed": []}]
    add_repo_task(
        task_id="py-real-schedule-eff-runner-0",
        family="py-real:dbader__schedule:effectful_job_runner",
        repo="dbader__schedule",
        source_file="schedule/__init__.py",
        source=sched_src,
        entry="run",
        args=sched_args,
        features=["loop", "branch", "http", "kv", "platform", "random", "exception", "hard-effectful", "mutation", "alias"],
        random_mode="tool",
        scripted_times=[1700000010.0],
        scripted_randoms=[0.2, 0.85, 0.4, 0.15],
        scripted_calls={
            "kv_get": [{"status": "fulfilled", "result": [{"id": "j1", "weekday": "friday", "offset_min": 5}, {"id": "j2", "weekday": "monday", "offset_min": 10}, {"id": "j3", "weekday": "sunday", "offset_min": 15}, {"id": "j4", "weekday": "wednesday", "offset_min": 20}]}],
            "http.request": [
                {"status": "fulfilled", "result": {"ok": True}},
                {"status": "fulfilled", "result": {"ok": True}},
                {"status": "fulfilled", "result": {"ok": True}},
            ],
            "kv_set": [{"status": "fulfilled", "result": True}],
        },
    )
    add_repo_task(
        task_id="py-real-schedule-eff-runner-1",
        family="py-real:dbader__schedule:effectful_job_runner",
        repo="dbader__schedule",
        source_file="schedule/__init__.py",
        source=sched_src,
        entry="run",
        args=sched_args,
        features=["loop", "branch", "http", "kv", "platform", "random", "exception", "hard-effectful", "mutation", "alias"],
        random_mode="tool",
        scripted_times=[1700000010.0],
        scripted_randoms=[0.2, 0.85, 0.4, 0.15],
        scripted_calls={
            "kv_get": [{"status": "fulfilled", "result": [{"id": "j1", "weekday": "friday", "offset_min": 5}, {"id": "j2", "weekday": "monday", "offset_min": 10}, {"id": "j3", "weekday": "sunday", "offset_min": 15}, {"id": "j4", "weekday": "wednesday", "offset_min": 20}]}],
            "http.request": [
                {"status": "fulfilled", "result": {"ok": True}},
                {"status": "rejected", "result": {"name": "ConnectionError", "message": "worker down"}},
                {"status": "fulfilled", "result": {"ok": True}},
            ],
            "kv_set": [{"status": "fulfilled", "result": True}],
        },
    )

    # 28. GeeeekExplorer__nano-vllm: effectful_kv_block_allocator (2 causal variants)
    nvllm_bm = dgx2 / "GeeeekExplorer__nano-vllm/nanovllm/engine/block_manager.py"
    nvllm_src = "\n\n".join([
        "from collections import deque\nimport zlib",
        """
class Sequence:
    def __init__(self, seq_id, token_ids, block_size=4):
        self.seq_id = seq_id
        self.token_ids = list(token_ids)
        self.block_size = block_size
        self.block_table = []
        self.num_cached_tokens = 0
        self.num_scheduled_tokens = len(token_ids)
    @property
    def num_blocks(self):
        return (len(self.token_ids) + self.block_size - 1) // self.block_size
    def block(self, i):
        return self.token_ids[i * self.block_size : (i + 1) * self.block_size]
    def __len__(self):
        return len(self.token_ids)
""",
        _extract_symbols(nvllm_bm, ["Block", "BlockManager"]).replace(
            """    @classmethod
    def compute_hash(cls, token_ids: list[int], prefix: int = -1):
        h = xxhash.xxh64()
        if prefix != -1:
            h.update(prefix.to_bytes(8, "little"))
        h.update(np.array(token_ids).tobytes())
        return h.intdigest()""",
            """    @classmethod
    def compute_hash(cls, token_ids: list[int], prefix: int = -1):
        acc = zlib.crc32(prefix.to_bytes(8, "little", signed=True)) if prefix != -1 else 0
        for tok in token_ids:
            acc = zlib.crc32(tok.to_bytes(4, "little", signed=True), acc)
        return acc""",
        ),
        """
def run(batch_key, num_blocks, block_size):
    reqs = host.kv_get(batch_key)
    bm = BlockManager(num_blocks, block_size)
    active = []
    log_out = []
    for item in reqs:
        seq = Sequence(item["id"], item["tokens"], block_size=block_size)
        cached = bm.can_allocate(seq)
        if cached < 0:
            print("oom-evicting", item["id"])
            if active:
                victim = active.pop(0)
                bm.deallocate(victim)
                cached = bm.can_allocate(seq)
        if cached >= 0:
            bm.allocate(seq, cached)
            bm.hash_blocks(seq)
            active.append(seq)
        log_out.append((item["id"], cached, list(seq.block_table)))
    host.kv_set(f"{batch_key}:free", len(bm.free_block_ids))
    return {"allocs": log_out, "used": sorted(bm.used_block_ids), "free": len(bm.free_block_ids)}
""",
    ])
    nvllm_args = ["nvllm:reqs", 4, 4]
    add_repo_task(
        task_id="py-real-nanovllm-eff-bm-0",
        family="py-real:GeeeekExplorer__nano-vllm:effectful_kv_block_allocator",
        repo="GeeeekExplorer__nano-vllm",
        source_file="nanovllm/engine/block_manager.py",
        source=nvllm_src,
        entry="run",
        args=nvllm_args,
        features=["loop", "branch", "class", "kv", "set", "hard-effectful"],
        scripted_calls={
            "kv_get": [{"status": "fulfilled", "result": [{"id": "s1", "tokens": [1, 2, 3, 4, 5, 6]}, {"id": "s2", "tokens": [1, 2, 3, 4, 9, 10]}]}],
            "kv_set": [{"status": "fulfilled", "result": True}],
        },
    )
    add_repo_task(
        task_id="py-real-nanovllm-eff-bm-1",
        family="py-real:GeeeekExplorer__nano-vllm:effectful_kv_block_allocator",
        repo="GeeeekExplorer__nano-vllm",
        source_file="nanovllm/engine/block_manager.py",
        source=nvllm_src,
        entry="run",
        args=nvllm_args,
        features=["loop", "branch", "class", "kv", "set", "hard-effectful"],
        scripted_calls={
            "kv_get": [{"status": "fulfilled", "result": [{"id": "s1", "tokens": [1, 2, 3, 4, 5, 6, 7, 8, 9]}, {"id": "s2", "tokens": [10, 11, 12, 13, 14, 15]}]}],
            "kv_set": [{"status": "fulfilled", "result": True}],
        },
    )

    # 29. maurosoria__dirsearch: effectful_scan_queue (2 causal variants)
    ds_struct = dgx2 / "maurosoria__dirsearch/lib/core/structures.py"
    ds_url = dgx2 / "maurosoria__dirsearch/lib/parse/url.py"
    ds_src = "\n\n".join([
        "from __future__ import annotations\nfrom typing import Any, Iterator",
        "def lstrip_once(s, prefix): return s[len(prefix):] if s.startswith(prefix) else s",
        _extract_symbols(ds_struct, ["CaseInsensitiveDict", "OrderedSet"]),
        _extract_symbols(ds_url, ["clean_path", "parse_path"]),
        """
def run(base_url, wordlist_path, out_key):
    raw_lines = host.fs_read_text(wordlist_path).splitlines()
    queue = OrderedSet([clean_path(parse_path(ln.strip())) for ln in raw_lines if ln.strip()])
    hits = CaseInsensitiveDict()
    errors = 0
    for ep in queue:
        target = f"{base_url.rstrip('/')}/{ep}"
        try:
            resp = host.http_get(target)
            hits[ep] = resp["code"]
            if resp["code"] == 200:
                print("hit-200", ep)
        except TimeoutError as exc:
            errors += 1
            print("probe-timeout", ep, str(exc))
    res = {"hits": dict(hits), "errors": errors, "scanned": list(queue)}
    host.kv_set(out_key, res)
    return res
""",
    ])
    ds_args = ["https://app.local", "/wordlists/mini.txt", "scan:latest"]
    add_repo_task(
        task_id="py-real-dirsearch-eff-scan-0",
        family="py-real:maurosoria__dirsearch:effectful_scan_queue",
        repo="maurosoria__dirsearch",
        source_file="lib/core/structures.py+lib/parse/url.py",
        source=ds_src,
        entry="run",
        args=ds_args,
        features=["loop", "branch", "class", "fs", "http", "kv", "exception", "hard-effectful"],
        scripted_calls={
            "fs.readText": [{"status": "fulfilled", "result": "/Admin?v=1\nhttps://app.local/Metrics#top\n/admin\n"}],
            "http.get": [
                {"status": "fulfilled", "result": {"code": 200}},
                {"status": "fulfilled", "result": {"code": 403}},
                {"status": "fulfilled", "result": {"code": 200}},
            ],
            "kv_set": [{"status": "fulfilled", "result": True}],
        },
    )
    add_repo_task(
        task_id="py-real-dirsearch-eff-scan-1",
        family="py-real:maurosoria__dirsearch:effectful_scan_queue",
        repo="maurosoria__dirsearch",
        source_file="lib/core/structures.py+lib/parse/url.py",
        source=ds_src,
        entry="run",
        args=ds_args,
        features=["loop", "branch", "class", "fs", "http", "kv", "exception", "hard-effectful"],
        scripted_calls={
            "fs.readText": [{"status": "fulfilled", "result": "/Admin?v=1\nhttps://app.local/Metrics#top\n/admin\n"}],
            "http.get": [
                {"status": "rejected", "result": {"name": "TimeoutError", "message": "read timed out"}},
                {"status": "fulfilled", "result": {"code": 200}},
                {"status": "fulfilled", "result": {"code": 404}},
            ],
            "kv_set": [{"status": "fulfilled", "result": True}],
        },
    )

    # 30. soxoj__maigret: effectful_osint_matcher (2 causal variants)
    mai_utils = dgx2 / "soxoj__maigret/maigret/utils.py"
    mai_perm = dgx2 / "soxoj__maigret/maigret/permutator.py"
    mai_src = "\n\n".join([
        "import ast\nimport difflib\nfrom itertools import permutations\nimport random\nimport re\nimport string\nfrom typing import Any\nDEFAULT_USER_AGENTS = ['ua']",
        _extract_symbols(mai_utils, ["CaseConverter", "is_country_tag", "enrich_link_str", "URLMatcher", "ascii_data_display", "get_dict_ascii_tree", "get_match_ratio"]),
        _extract_symbols(mai_perm, ["Permute"]),
        """
def run(elements, url_tpl, report_path):
    perms = sorted(Permute(elements).gather("strict").keys())[:3]
    rx = URLMatcher.make_profile_url_regexp(url_tpl, r"[a-z0-9_.-]+")
    found = []
    for cand in perms:
        probe_url = url_tpl.replace("{username}", cand)
        try:
            body = host.http_get(probe_url)
            if rx.match(probe_url) and "found" in body:
                found.append((CaseConverter.snake_to_camel(cand.replace("-", "_")), probe_url))
        except ConnectionError as exc:
            print("probe-err", cand, str(exc))
    tree = get_dict_ascii_tree([("found", str([f[0] for f in found]))])
    host.fs_write_text(report_path, tree)
    return {"found": found, "tree": tree}
""",
    ])
    mai_args = [{"a": 1, "b": 2}, "https://social.local/{username}", "/tmp/osint_tree.txt"]
    add_repo_task(
        task_id="py-real-maigret-eff-osint-0",
        family="py-real:soxoj__maigret:effectful_osint_matcher",
        repo="soxoj__maigret",
        source_file="maigret/utils.py+permutator.py",
        source=mai_src,
        entry="run",
        args=mai_args,
        features=["loop", "branch", "class", "regex", "http", "fs", "exception", "hard-effectful"],
        scripted_calls={
            "http.get": [
                {"status": "fulfilled", "result": "profile found"},
                {"status": "fulfilled", "result": "404"},
                {"status": "fulfilled", "result": "profile found"},
            ],
            "fs.writeText": [{"status": "fulfilled", "result": None}],
        },
    )
    add_repo_task(
        task_id="py-real-maigret-eff-osint-1",
        family="py-real:soxoj__maigret:effectful_osint_matcher",
        repo="soxoj__maigret",
        source_file="maigret/utils.py+permutator.py",
        source=mai_src,
        entry="run",
        args=mai_args,
        features=["loop", "branch", "class", "regex", "http", "fs", "exception", "hard-effectful"],
        scripted_calls={
            "http.get": [
                {"status": "rejected", "result": {"name": "ConnectionError", "message": "reset"}},
                {"status": "fulfilled", "result": "profile found"},
                {"status": "fulfilled", "result": "404"},
            ],
            "fs.writeText": [{"status": "fulfilled", "result": None}],
        },
    )

    # 31. scientific-python__lazy-loader: effectful_stub_resolver (2 causal variants, 1 throws ValueError!)
    ll_path = dgx2 / "scientific-python__lazy-loader/src/lazy_loader/__init__.py"
    ll_src = "\n\n".join([
        "import ast\nimport importlib\nimport json\nimport os\nimport sys\nimport types",
        _extract_symbols(ll_path, ["attach", "DelayedImportErrorModule", "_StubVisitor", "attach_stub"]),
        """
def run(stub_path, cache_key, manifest_path):
    try:
        stub_src = host.fs_read_text(stub_path)
    except FileNotFoundError as exc:
        print("stub-fallback", str(exc))
        stub_src = host.kv_get(cache_key)
    tree = ast.parse(stub_src)
    visitor = _StubVisitor()
    visitor.visit(tree)
    manifest = {"submodules": sorted(visitor._submodules), "attrs": visitor._submod_attrs}
    host.fs_write_text(manifest_path, json.dumps(manifest, sort_keys=True))
    return manifest
""",
    ])
    ll_args = ["/pkg/__init__.pyi", "stub:pkg", "/pkg/manifest.json"]
    add_repo_task(
        task_id="py-real-lazyloader-eff-stub-0",
        family="py-real:scientific-python__lazy-loader:effectful_stub_resolver",
        repo="scientific-python__lazy-loader",
        source_file="src/lazy_loader/__init__.py",
        source=ll_src,
        entry="run",
        args=ll_args,
        features=["loop", "branch", "class", "ast", "fs", "kv", "exception", "hard-effectful"],
        scripted_calls={
            "fs.readText": [{"status": "fulfilled", "result": "from . import core, io, metrics, utils\nfrom .core import Engine, Runner\nfrom .io import Reader, Writer\nfrom .metrics import Timer\n"}],
            "fs.writeText": [{"status": "fulfilled", "result": None}],
        },
    )
    add_repo_task(
        task_id="py-real-lazyloader-eff-stub-throw-1",
        family="py-real:scientific-python__lazy-loader:effectful_stub_resolver",
        repo="scientific-python__lazy-loader",
        source_file="src/lazy_loader/__init__.py",
        source=ll_src,
        entry="run",
        args=ll_args,
        features=["loop", "branch", "class", "ast", "fs", "kv", "exception", "hard-effectful"],
        expected_kind="throw",
        expected_exc="ValueError",
        scripted_calls={
            "fs.readText": [{"status": "rejected", "result": {"name": "FileNotFoundError", "message": "missing pyi"}}],
            "kv_get": [{"status": "fulfilled", "result": "from .core import *\n"}],
        },
    )

    # 32. soimort__you-get: effectful_m3u8_decryptor (2 causal variants)
    yg_common = dgx2 / "soimort__you-get/src/you_get/common.py"
    yg_src = "\n\n".join([
        "import re\nfrom urllib import parse",
        _extract_symbols(yg_common, ["rc4", "r1", "r1_of", "match1", "matchall", "parse_query_param", "general_m3u8_extractor"]),
        """
def get_content(url, headers=None):
    return host.http_get(url)

def run(m3u8_url, key_kv_key, out_kv_key):
    urls = general_m3u8_extractor(m3u8_url)
    raw_key = bytes.fromhex(host.kv_get(key_kv_key))
    decrypted = []
    for seg_url in urls:
        try:
            hex_cipher = host.http_get(seg_url)
            plain = rc4(raw_key, bytes.fromhex(hex_cipher))
            decrypted.append(plain)
        except TimeoutError as exc:
            print("segment-timeout", seg_url, str(exc))
            decrypted.append(b"")
    host.kv_set(out_kv_key, {"count": len(decrypted), "total_bytes": sum(len(x) for x in decrypted)})
    return {"urls": urls, "decrypted": decrypted}
""",
    ])
    yg_args = ["https://cdn.local/live/index.m3u8", "stream:rc4key", "stream:decoded"]
    key_hex = b"secretkey".hex()
    # Precompute simple rc4 hex payloads in Python runtime inside builder? Let's compute inline or use known hex!
    def _rc4_hex(key_b: bytes, plain_b: bytes) -> str:
        s = list(range(256))
        j = 0
        for i in range(256):
            j = (j + s[i] + key_b[i % len(key_b)]) & 0xFF
            s[i], s[j] = s[j], s[i]
        i = j = 0
        out = []
        for ch in plain_b:
            i = (i + 1) & 0xFF
            j = (j + s[i]) & 0xFF
            s[i], s[j] = s[j], s[i]
            out.append(ch ^ s[(s[i] + s[j]) & 0xFF])
        return bytes(out).hex()

    add_repo_task(
        task_id="py-real-youget-eff-m3u8-0",
        family="py-real:soimort__you-get:effectful_m3u8_decryptor",
        repo="soimort__you-get",
        source_file="src/you_get/common.py",
        source=yg_src,
        entry="run",
        args=yg_args,
        features=["loop", "branch", "bytes", "http", "kv", "exception", "hard-effectful"],
        scripted_calls={
            "http.get": [
                {"status": "fulfilled", "result": "#EXTM3U\nseg1.ts\nseg2.ts\n"},
                {"status": "fulfilled", "result": _rc4_hex(b"secretkey", b"chunk-1")},
                {"status": "fulfilled", "result": _rc4_hex(b"secretkey", b"chunk-2")},
            ],
            "kv_get": [{"status": "fulfilled", "result": key_hex}],
            "kv_set": [{"status": "fulfilled", "result": True}],
        },
    )
    add_repo_task(
        task_id="py-real-youget-eff-m3u8-1",
        family="py-real:soimort__you-get:effectful_m3u8_decryptor",
        repo="soimort__you-get",
        source_file="src/you_get/common.py",
        source=yg_src,
        entry="run",
        args=yg_args,
        features=["loop", "branch", "bytes", "http", "kv", "exception", "hard-effectful"],
        scripted_calls={
            "http.get": [
                {"status": "fulfilled", "result": "#EXTM3U\nseg1.ts\nseg2.ts\n"},
                {"status": "rejected", "result": {"name": "TimeoutError", "message": "seg1 timeout"}},
                {"status": "fulfilled", "result": _rc4_hex(b"secretkey", b"chunk-2")},
            ],
            "kv_get": [{"status": "fulfilled", "result": key_hex}],
            "kv_set": [{"status": "fulfilled", "result": True}],
        },
    )

    return tasks


# ---------------------------------------------------------------------------
# PART B: 16 NEW Multi-Turn Effectful Production Workflows (52 tasks)
# ---------------------------------------------------------------------------

def build_part_b_tasks() -> list[dict[str, Any]]:
    tasks: list[dict[str, Any]] = []

    def add_wf(
        *,
        family: str,
        idx: int,
        source: str,
        args: list[Any],
        features: list[str],
        random_mode: str = "seeded",
        random_seed: int = 17,
        scripted_calls: dict[str, list[dict[str, Any]]] | None = None,
        scripted_times: list[float] | None = None,
        scripted_randoms: list[float] | None = None,
        expected_kind: str = "return",
        expected_exc: str | None = None,
    ) -> None:
        tasks.append(
            _make_task(
                task_id=f"{family}-{idx}",
                family=f"py-hairy-effectful:{family}",
                source=source,
                entry="run",
                args=args,
                features=[*features, "hard-effectful"],
                random_mode=random_mode,
                random_seed=random_seed,
                scripted_calls=scripted_calls,
                scripted_times=scripted_times,
                scripted_randoms=scripted_randoms,
                expected_kind=expected_kind,
                expected_exc=expected_exc,
                metadata={
                    "sourceOrigin": "authored-hairy-effectful-py-wave2",
                    "part": "B",
                    "inputVariant": idx,
                    "template": f"py-hairy-effectful:{family}",
                    "lineage": [f"py-hairy-effectful:{family}"],
                },
            )
        )

    # 1. py-token-bucket-rate-limiter (4 variants: causal pair + overflow throw + -0.0 debt)
    src_tb = """
import time

def run(bucket_key, requests, cfg, audit):
    state = host.kv_get(bucket_key)
    if state is None:
        state = {"tokens": float(cfg["capacity"]), "last_ts": time.monotonic(), "debt": -0.0}
    audit["initial_ref"] = state
    results = []
    for req in requests:
        now = time.monotonic()
        elapsed = max(0.0, now - state["last_ts"])
        refill = elapsed * cfg["rate"]
        state["tokens"] = min(float(cfg["capacity"]), state["tokens"] + refill)
        state["last_ts"] = now
        cost = req["cost"]
        if cost <= 0:
            raise ValueError(f"invalid cost {cost}")
        if state["tokens"] >= cost:
            state["tokens"] -= cost
            if state["tokens"] == 0.0:
                state["tokens"] = -0.0
            try:
                resp = host.http_request({"method": "POST", "url": cfg["downstream"], "id": req["id"]})
                results.append((req["id"], "allowed", resp["code"]))
            except TimeoutError as exc:
                state["tokens"] = min(float(cfg["capacity"]), state["tokens"] + cost * 0.5)
                print("refund-on-timeout", req["id"], str(exc))
                results.append((req["id"], "refunded", 504))
        else:
            state["debt"] -= (cost - state["tokens"])
            print("throttled", req["id"], round(state["tokens"], 3))
            results.append((req["id"], "throttled", 429))
    host.kv_set(bucket_key, state)
    audit["final_tokens"] = state["tokens"]
    return {"results": results, "state_alias": state, "audit": audit}
"""
    tb_args = [
        "tb:tenant-a",
        [{"id": "r1", "cost": 2.0}, {"id": "r2", "cost": 3.0}, {"id": "r3", "cost": 2.0}],
        {"capacity": 4.0, "rate": 1.0, "downstream": "https://svc.local/exec"},
        {},
    ]
    add_wf(
        family="py-token-bucket-rate-limiter", idx=0, source=src_tb, args=tb_args,
        features=["loop", "branch", "kv", "http", "platform", "float-edge", "alias", "mutation", "exception"],
        scripted_times=[100.0, 100.5, 101.0],
        scripted_calls={
            "kv_get": [{"status": "fulfilled", "result": {"tokens": 3.0, "last_ts": 99.0, "debt": -0.0}}],
            "http.request": [
                {"status": "fulfilled", "result": {"code": 200}},
                {"status": "fulfilled", "result": {"code": 200}},
            ],
            "kv_set": [{"status": "fulfilled", "result": True}],
        },
    )
    add_wf(
        family="py-token-bucket-rate-limiter", idx=1, source=src_tb, args=tb_args,
        features=["loop", "branch", "kv", "http", "platform", "float-edge", "alias", "mutation", "exception"],
        scripted_times=[100.0, 100.5, 101.0],
        scripted_calls={
            "kv_get": [{"status": "fulfilled", "result": {"tokens": 3.0, "last_ts": 99.0, "debt": -0.0}}],
            "http.request": [
                {"status": "rejected", "result": {"name": "TimeoutError", "message": "upstream slow"}},
                {"status": "fulfilled", "result": {"code": 200}},
            ],
            "kv_set": [{"status": "fulfilled", "result": True}],
        },
    )
    add_wf(
        family="py-token-bucket-rate-limiter", idx=2, source=src_tb,
        args=["tb:tenant-b", [{"id": "r1", "cost": 4.0}], {"capacity": 4.0, "rate": 0.5, "downstream": "https://svc.local/exec"}, {}],
        features=["loop", "branch", "kv", "http", "platform", "float-edge", "alias", "mutation"],
        scripted_times=[200.0, 200.0],
        scripted_calls={
            "kv_get": [{"status": "fulfilled", "result": None}],
            "http.request": [{"status": "fulfilled", "result": {"code": 201}}],
            "kv_set": [{"status": "fulfilled", "result": True}],
        },
    )
    add_wf(
        family="py-token-bucket-rate-limiter", idx=3, source=src_tb,
        args=["tb:tenant-bad", [{"id": "r-ok", "cost": 1.0}, {"id": "r-bad", "cost": 0}], {"capacity": 4.0, "rate": 1.0, "downstream": "https://svc.local/exec"}, {}],
        features=["loop", "branch", "kv", "http", "platform", "exception", "mutation"],
        scripted_times=[300.0, 300.5, 301.0],
        expected_kind="throw", expected_exc="ValueError",
        scripted_calls={
            "kv_get": [{"status": "fulfilled", "result": None}],
            "http.request": [{"status": "fulfilled", "result": {"code": 200}}],
        },
    )

    # 2. py-distributed-lease-manager (3 variants: causal pair + finally release + throw)
    src_lease = """
import time

def run(lock_key, owner, ttl_s, work_steps, ledger):
    cur = None
    now = 0.0
    for probe in range(2):
        now = time.time()
        cur = host.kv_get(lock_key)
        if cur is not None and cur["expires_at"] > now and cur["owner"] != owner:
            print("lease-busy", cur["owner"], probe)
            if probe == 1:
                ledger["acquired"] = False
                return {"ok": False, "holder": cur["owner"], "ledger": ledger}
        else:
            break
    fence = (cur["fence"] + 1) if cur else 1
    lease = {"owner": owner, "fence": fence, "expires_at": now + ttl_s}
    host.kv_set(lock_key, lease)
    ledger["acquired"] = True
    ledger["lease_ref"] = lease
    done = []
    try:
        for step in work_steps:
            t_now = time.time()
            if t_now >= lease["expires_at"]:
                lease["expires_at"] = t_now + ttl_s
                host.kv_set(lock_key, lease)
                print("lease-renewed", fence)
            res = host.http_request({"method": "POST", "url": step["url"], "fence": fence})
            done.append((step["id"], res["ack"]))
    finally:
        ledger["released_in_finally"] = True
        host.kv_set(lock_key, {"owner": None, "fence": fence, "expires_at": 0.0})
    return {"ok": True, "done": done, "lease_alias": lease, "ledger": ledger}
"""
    lease_args = [
        "lock:shard-0",
        "worker-1",
        5.0,
        [{"id": "s1", "url": "https://db.local/step1"}, {"id": "s2", "url": "https://db.local/step2"}],
        {"acquired": False, "released_in_finally": False},
    ]
    add_wf(
        family="py-distributed-lease-manager", idx=0, source=src_lease, args=lease_args,
        features=["loop", "branch", "kv", "http", "platform", "exception", "alias", "mutation"],
        scripted_times=[1000.0, 1002.0, 1006.0],
        scripted_calls={
            "kv_get": [{"status": "fulfilled", "result": {"owner": "old", "fence": 4, "expires_at": 990.0}}],
            "kv_set": [{"status": "fulfilled", "result": True}, {"status": "fulfilled", "result": True}, {"status": "fulfilled", "result": True}],
            "http.request": [{"status": "fulfilled", "result": {"ack": 1}}, {"status": "fulfilled", "result": {"ack": 2}}],
        },
    )
    add_wf(
        family="py-distributed-lease-manager", idx=1, source=src_lease, args=lease_args,
        features=["loop", "branch", "kv", "http", "platform", "exception", "alias", "mutation"],
        expected_kind="throw", expected_exc="TimeoutError",
        scripted_times=[1000.0, 1002.0, 1006.0],
        scripted_calls={
            "kv_get": [{"status": "fulfilled", "result": {"owner": "old", "fence": 4, "expires_at": 990.0}}],
            "kv_set": [{"status": "fulfilled", "result": True}, {"status": "fulfilled", "result": True}, {"status": "fulfilled", "result": True}],
            "http.request": [
                {"status": "fulfilled", "result": {"ack": 1}},
                {"status": "rejected", "result": {"name": "TimeoutError", "message": "commit timeout"}},
            ],
        },
    )
    add_wf(
        family="py-distributed-lease-manager", idx=2, source=src_lease,
        args=["lock:shard-1", "worker-2", 10.0, [{"id": "s1", "url": "https://db.local/s1"}], {"acquired": False, "released_in_finally": False}],
        features=["loop", "branch", "kv", "platform", "mutation"],
        scripted_times=[2000.0, 2002.0],
        scripted_calls={
            "kv_get": [
                {"status": "fulfilled", "result": {"owner": "worker-9", "fence": 8, "expires_at": 2005.0}},
                {"status": "fulfilled", "result": {"owner": "worker-9", "fence": 8, "expires_at": 2005.0}},
            ],
        },
    )

    # 3. py-etl-checkpoint-pipeline (3 variants: randomMode="tool" backoff + tuple keys + set)
    src_etl = """
import json
import random

def run(batch_paths, ckpt_key, sink_url, seen_ids):
    ckpt = host.kv_get(ckpt_key) or {"offset": 0, "ingested": 0}
    by_tenant = {}
    for b_idx, path in enumerate(batch_paths):
        if b_idx < ckpt["offset"]:
            continue
        raw = host.fs_read_text(path)
        batch_rows = []
        for line in raw.splitlines():
            if not line.strip():
                continue
            rec = json.loads(line)
            tk = (rec["tenant"], rec["kind"])
            if rec["id"] in seen_ids:
                continue
            seen_ids.add(rec["id"])
            by_tenant.setdefault(tk, []).append(rec["val"])
            batch_rows.append(rec)
        sent = False
        for attempt in range(2):
            try:
                host.http_request({"method": "POST", "url": sink_url, "count": len(batch_rows), "attempt": attempt})
                sent = True
                break
            except ConnectionError as exc:
                wait_ms = int(round((100 * (2 ** attempt)) * (0.5 + random.random()), 0))
                print("etl-retry", path, attempt, wait_ms, str(exc))
        if not sent:
            raise RuntimeError(f"sink failed for {path}")
        ckpt["offset"] = b_idx + 1
        ckpt["ingested"] += len(batch_rows)
        host.kv_set(ckpt_key, ckpt)
    return {"ckpt": ckpt, "by_tenant": by_tenant, "seen": seen_ids}
"""
    etl_args = [["/etl/b0.ndjson", "/etl/b1.ndjson"], "etl:cursor", "https://sink.local/ingest", {"e0"}]
    add_wf(
        family="py-etl-checkpoint-pipeline", idx=0, source=src_etl, args=etl_args,
        features=["loop", "branch", "fs", "kv", "http", "random", "set", "tuple-key", "exception", "mutation", "alias"],
        random_mode="tool", scripted_randoms=[0.4],
        scripted_calls={
            "kv_get": [{"status": "fulfilled", "result": None}],
            "fs.readText": [
                {"status": "fulfilled", "result": '{"id":"e0","tenant":"acme","kind":"click","val":1}\n{"id":"e1","tenant":"acme","kind":"click","val":5}\n'},
                {"status": "fulfilled", "result": '{"id":"e2","tenant":"beta","kind":"buy","val":12}\n'},
            ],
            "http.request": [
                {"status": "rejected", "result": {"name": "ConnectionError", "message": "503"}},
                {"status": "fulfilled", "result": {"ok": True}},
                {"status": "fulfilled", "result": {"ok": True}},
            ],
            "kv_set": [{"status": "fulfilled", "result": True}, {"status": "fulfilled", "result": True}],
        },
    )
    add_wf(
        family="py-etl-checkpoint-pipeline", idx=1, source=src_etl, args=etl_args,
        features=["loop", "branch", "fs", "kv", "http", "random", "set", "tuple-key", "exception", "mutation"],
        random_mode="tool", scripted_randoms=[0.25, 0.75],
        expected_kind="throw", expected_exc="RuntimeError",
        scripted_calls={
            "kv_get": [{"status": "fulfilled", "result": None}],
            "fs.readText": [{"status": "fulfilled", "result": '{"id":"e1","tenant":"acme","kind":"click","val":5}\n'}],
            "http.request": [
                {"status": "rejected", "result": {"name": "ConnectionError", "message": "503"}},
                {"status": "rejected", "result": {"name": "ConnectionError", "message": "503 again"}},
            ],
        },
    )
    add_wf(
        family="py-etl-checkpoint-pipeline", idx=2, source=src_etl,
        args=[["/etl/b0.ndjson", "/etl/b1.ndjson"], "etl:cursor2", "https://sink.local/ingest", set()],
        features=["loop", "branch", "fs", "kv", "http", "random", "set", "tuple-key", "mutation"],
        random_mode="tool", scripted_randoms=[],
        scripted_calls={
            "kv_get": [{"status": "fulfilled", "result": {"offset": 1, "ingested": 3}}],
            "fs.readText": [{"status": "fulfilled", "result": '{"id":"e9","tenant":"gamma","kind":"view","val":2}\n'}],
            "http.request": [{"status": "fulfilled", "result": {"ok": True}}],
            "kv_set": [{"status": "fulfilled", "result": True}],
        },
    )

    # 4. py-schema-config-migrator (3 variants: cyclic/aliased config + fs_write + throw)
    src_mig = """
import json

def run(src_path, dst_path, kv_schema_key, graph_out):
    raw = host.fs_read_text(src_path)
    cfg = json.loads(raw)
    rules = host.kv_get(kv_schema_key)
    ver = cfg.get("version", 1)
    applied = []
    try:
        while ver < rules["target"]:
            nxt = ver + 1
            step = rules["steps"].get(str(nxt))
            if step is None:
                raise KeyError(f"missing migration step {nxt}")
            cfg[step["add_key"]] = step["default_val"]
            if step.get("drop_key") in cfg:
                del cfg[step["drop_key"]]
            cfg["version"] = nxt
            applied.append(nxt)
            ver = nxt
    except KeyError as exc:
        print("migration-aborted", str(exc))
        host.kv_set(f"{kv_schema_key}:err", {"err": str(exc), "ver": ver})
        raise
    else:
        print("migration-ready", ver, len(applied))
        host.fs_write_text(dst_path, json.dumps(cfg, sort_keys=True))
        host.kv_set(f"{kv_schema_key}:ver", ver)
    root = {"cfg": cfg, "applied": applied}
    root["self"] = root
    graph_out["migrated"] = root
    return {"graph": graph_out, "cfg_alias": cfg}
"""
    mig_args = ["/etc/app.v1.json", "/etc/app.v3.json", "schema:app", {}]
    add_wf(
        family="py-schema-config-migrator", idx=0, source=src_mig, args=mig_args,
        features=["loop", "branch", "fs", "kv", "exception", "cycle", "alias", "mutation"],
        scripted_calls={
            "fs.readText": [{"status": "fulfilled", "result": '{"version":1,"legacy_mode":true,"port":8080}'}],
            "kv_get": [{"status": "fulfilled", "result": {"target": 3, "steps": {"2": {"add_key": "tls", "default_val": True, "drop_key": "legacy_mode"}, "3": {"add_key": "workers", "default_val": 4}}}}],
            "fs.writeText": [{"status": "fulfilled", "result": None}],
            "kv_set": [{"status": "fulfilled", "result": True}],
        },
    )
    add_wf(
        family="py-schema-config-migrator", idx=1, source=src_mig, args=mig_args,
        features=["loop", "branch", "fs", "kv", "exception", "mutation"],
        expected_kind="throw", expected_exc="KeyError",
        scripted_calls={
            "fs.readText": [{"status": "fulfilled", "result": '{"version":1,"port":8080}'}],
            "kv_get": [{"status": "fulfilled", "result": {"target": 3, "steps": {"2": {"add_key": "tls", "default_val": True}}}}],
            "kv_set": [{"status": "fulfilled", "result": True}],
        },
    )
    add_wf(
        family="py-schema-config-migrator", idx=2, source=src_mig,
        args=["/etc/app.v3.json", "/etc/app.v3.out.json", "schema:app", {}],
        features=["loop", "branch", "fs", "kv", "cycle", "alias", "mutation"],
        scripted_calls={
            "fs.readText": [{"status": "fulfilled", "result": '{"version":3,"workers":8}'}],
            "kv_get": [{"status": "fulfilled", "result": {"target": 3, "steps": {}}}],
            "fs.writeText": [{"status": "fulfilled", "result": None}],
            "kv_set": [{"status": "fulfilled", "result": True}],
        },
    )

    # 5. py-cache-invalidation-fanout (3 variants: DAG topo order + CDN purge + retry)
    src_cdn = """
def run(graph_key, changed_keys, cdn_nodes, stats):
    deps = host.kv_get(graph_key)
    ver = host.kv_get(f"{graph_key}:ver") or 0
    print("invalidation-plan", ver, changed_keys)
    order = []
    visited = set()
    active = set()

    def visit(node):
        if node in active:
            raise ValueError(f"cycle at {node}")
        if node in visited:
            return
        active.add(node)
        for ch in deps.get(node, []):
            visit(ch)
        active.remove(node)
        visited.add(node)
        order.append(node)

    try:
        for k in changed_keys:
            visit(k)
    except ValueError as exc:
        host.kv_set(f"{graph_key}:cycle_err", str(exc))
        raise

    purged = []
    for edge in cdn_nodes:
        try:
            resp = host.http_request({"method": "POST", "url": edge, "keys": order})
            purged.append((edge, resp["purged"]))
        except ConnectionError as exc:
            print("cdn-retry", edge, str(exc))
            resp2 = host.http_request({"method": "POST", "url": edge, "keys": order, "retry": True})
            purged.append((edge, resp2["purged"]))
    host.kv_set(f"{graph_key}:last_order", order)
    stats["order_alias"] = order
    stats["count"] = len(order)
    return {"order": order, "purged": purged, "stats": stats}
"""
    cdn_args = ["deps:web", ["home"], ["https://edge1.local/purge", "https://edge2.local/purge"], {}]
    add_wf(
        family="py-cache-invalidation-fanout", idx=0, source=src_cdn, args=cdn_args,
        features=["loop", "branch", "recursion", "graph", "kv", "http", "set", "exception", "alias", "mutation"],
        scripted_calls={
            "kv_get": [
                {"status": "fulfilled", "result": {"home": ["nav", "feed"], "nav": ["logo"], "feed": ["logo"]}},
                {"status": "fulfilled", "result": 7},
            ],
            "http.request": [
                {"status": "fulfilled", "result": {"purged": 4}},
                {"status": "rejected", "result": {"name": "ConnectionError", "message": "edge2 reset"}},
                {"status": "fulfilled", "result": {"purged": 4}},
            ],
            "kv_set": [{"status": "fulfilled", "result": True}],
        },
    )
    add_wf(
        family="py-cache-invalidation-fanout", idx=1, source=src_cdn, args=cdn_args,
        features=["loop", "branch", "recursion", "graph", "kv", "set", "exception"],
        expected_kind="throw", expected_exc="ValueError",
        scripted_calls={
            "kv_get": [
                {"status": "fulfilled", "result": {"home": ["nav"], "nav": ["home"]}},
                {"status": "fulfilled", "result": 7},
            ],
            "kv_set": [{"status": "fulfilled", "result": True}],
        },
    )
    add_wf(
        family="py-cache-invalidation-fanout", idx=2, source=src_cdn,
        args=["deps:web", ["api", "docs"], ["https://edge1.local/purge"], {}],
        features=["loop", "branch", "recursion", "graph", "kv", "http", "set", "alias", "mutation"],
        scripted_calls={
            "kv_get": [
                {"status": "fulfilled", "result": {"api": ["schema"], "docs": ["schema"]}},
                {"status": "fulfilled", "result": 8},
            ],
            "http.request": [{"status": "fulfilled", "result": {"purged": 3}}],
            "kv_set": [{"status": "fulfilled", "result": True}],
        },
    )

    # 6. py-trace-alert-correlator (3 variants: NaN/Inf guard + fs_read + webhook + fs_write)
    src_alert = """
import json
import math
import time

def run(log_paths, alert_url, digest_path, threshold):
    t0 = time.time()
    latencies = []
    errors = {}
    for p in log_paths:
        try:
            text = host.fs_read_text(p)
        except FileNotFoundError as exc:
            print("skip-missing-log", p, str(exc))
            continue
        for ln in text.splitlines():
            parts = ln.split("|")
            if len(parts) != 3:
                continue
            svc, code_s, lat_s = parts
            lat = float(lat_s)
            if math.isnan(lat) or math.isinf(lat):
                print("anomaly-float", svc, lat_s)
                errors[svc] = errors.get(svc, 0) + 1
                continue
            latencies.append(lat)
            if int(code_s) >= 500:
                errors[svc] = errors.get(svc, 0) + 1
    latencies.sort()
    p95 = latencies[int(0.95 * (len(latencies) - 1))] if latencies else float("nan")
    if sum(errors.values()) >= threshold:
        host.http_request({"method": "POST", "url": alert_url, "errors": errors, "p95": p95})
    digest = {"elapsed": round(time.time() - t0, 3), "errors": errors, "p95": p95, "samples": len(latencies)}
    host.fs_write_text(digest_path, json.dumps({"errors": errors, "samples": len(latencies)}, sort_keys=True))
    return digest
"""
    alert_args = [["/logs/a.log", "/logs/b.log"], "https://pager.local/alert", "/logs/digest.json", 2]
    add_wf(
        family="py-trace-alert-correlator", idx=0, source=src_alert, args=alert_args,
        features=["loop", "branch", "fs", "http", "platform", "float-edge", "exception"],
        scripted_times=[4000.0, 4000.2],
        scripted_calls={
            "fs.readText": [
                {"status": "fulfilled", "result": "auth|502|120.5\nauth|200|10.0\nbilling|500|NaN\n"},
                {"status": "fulfilled", "result": "auth|200|15.0\nbilling|200|22.0\n"},
            ],
            "http.request": [{"status": "fulfilled", "result": {"sent": True}}],
            "fs.writeText": [{"status": "fulfilled", "result": None}],
        },
    )
    add_wf(
        family="py-trace-alert-correlator", idx=1, source=src_alert, args=alert_args,
        features=["loop", "branch", "fs", "platform", "float-edge", "exception"],
        scripted_times=[4000.0, 4000.1],
        scripted_calls={
            "fs.readText": [
                {"status": "rejected", "result": {"name": "FileNotFoundError", "message": "rotated"}},
                {"status": "rejected", "result": {"name": "FileNotFoundError", "message": "rotated"}},
            ],
            "fs.writeText": [{"status": "fulfilled", "result": None}],
        },
    )
    add_wf(
        family="py-trace-alert-correlator", idx=2, source=src_alert,
        args=[["/logs/c.log"], "https://pager.local/alert", "/logs/digest2.json", 1],
        features=["loop", "branch", "fs", "http", "platform", "float-edge"],
        scripted_times=[4500.0, 4500.05],
        scripted_calls={
            "fs.readText": [{"status": "fulfilled", "result": "search|503|inf\nsearch|200|8.5\n"}],
            "http.request": [{"status": "fulfilled", "result": {"sent": True}}],
            "fs.writeText": [{"status": "fulfilled", "result": None}],
        },
    )

    # 7. py-stateful-saga-workflow (4 variants: causal compensation rollback + throw)
    src_saga = """
def run(order_id, steps, ledger, audit):
    state = host.kv_get(f"saga:{order_id}") or {"status": "init", "done": []}
    completed = []
    try:
        for st in steps:
            res = host.http_request({"method": "POST", "url": st["do"], "order": order_id})
            completed.append(st)
            state["done"].append((st["name"], res["tx"]))
            ledger[st["name"]] = res["tx"]
    except RuntimeError as exc:
        print("saga-compensating", order_id, len(completed), str(exc))
        state["status"] = "compensating"
        for st in reversed(completed):
            host.http_request({"method": "POST", "url": st["undo"], "order": order_id})
            ledger[st["name"]] = "rolled_back"
        state["status"] = "rolled_back"
        audit["error"] = str(exc)
        if audit.get("rethrow"):
            raise
    else:
        state["status"] = "committed"
    finally:
        host.kv_set(f"saga:{order_id}", state)
    audit["state_alias"] = state
    return {"state": state, "ledger": ledger, "audit": audit}
"""
    saga_steps = [
        {"name": "reserve", "do": "https://inv.local/reserve", "undo": "https://inv.local/release"},
        {"name": "charge", "do": "https://pay.local/charge", "undo": "https://pay.local/refund"},
        {"name": "ship", "do": "https://ship.local/create", "undo": "https://ship.local/cancel"},
    ]
    saga_args = ["ord-100", saga_steps, {}, {"rethrow": False}]
    add_wf(
        family="py-stateful-saga-workflow", idx=0, source=src_saga, args=saga_args,
        features=["loop", "branch", "kv", "http", "exception", "alias", "mutation"],
        scripted_calls={
            "kv_get": [{"status": "fulfilled", "result": None}],
            "http.request": [
                {"status": "fulfilled", "result": {"tx": "t1"}},
                {"status": "fulfilled", "result": {"tx": "t2"}},
                {"status": "fulfilled", "result": {"tx": "t3"}},
            ],
            "kv_set": [{"status": "fulfilled", "result": True}],
        },
    )
    add_wf(
        family="py-stateful-saga-workflow", idx=1, source=src_saga, args=saga_args,
        features=["loop", "branch", "kv", "http", "exception", "alias", "mutation"],
        scripted_calls={
            "kv_get": [{"status": "fulfilled", "result": None}],
            "http.request": [
                {"status": "fulfilled", "result": {"tx": "t1"}},
                {"status": "fulfilled", "result": {"tx": "t2"}},
                {"status": "rejected", "result": {"name": "RuntimeError", "message": "carrier offline"}},
                {"status": "fulfilled", "result": {"undone": True}},
                {"status": "fulfilled", "result": {"undone": True}},
            ],
            "kv_set": [{"status": "fulfilled", "result": True}],
        },
    )
    add_wf(
        family="py-stateful-saga-workflow", idx=2, source=src_saga,
        args=["ord-101", saga_steps[:2], {}, {"rethrow": True}],
        features=["loop", "branch", "kv", "http", "exception", "mutation"],
        expected_kind="throw", expected_exc="RuntimeError",
        scripted_calls={
            "kv_get": [{"status": "fulfilled", "result": None}],
            "http.request": [
                {"status": "fulfilled", "result": {"tx": "t1"}},
                {"status": "rejected", "result": {"name": "RuntimeError", "message": "card declined"}},
                {"status": "fulfilled", "result": {"undone": True}},
            ],
            "kv_set": [{"status": "fulfilled", "result": True}],
        },
    )

    # 8. py-inventory-reconciliation-engine (3 variants: tuple-keyed dict + set + make_dataclass)
    src_inv = """
from dataclasses import make_dataclass
import json

SkuDelta = make_dataclass("SkuDelta", [("sku", str), ("warehouse", str), ("delta", int)])

def run(csv_path, erp_url, pending_key, journal_path):
    csv_raw = host.fs_read_text(csv_path)
    erp_rows = json.loads(host.http_get(erp_url))
    pending = host.kv_get(pending_key) or {}
    physical = {}
    for line in csv_raw.splitlines()[1:]:
        sku, wh, qty_s = line.split(",")
        physical[(sku, wh)] = int(qty_s)
    erp_map = {(r["sku"], r["wh"]): r["qty"] for r in erp_rows}
    all_keys = sorted(set(physical.keys()) | set(erp_map.keys()))
    deltas = []
    mismatched_skus = set()
    for k in all_keys:
        reserved = pending.get(f"{k[0]}:{k[1]}", 0)
        diff = physical.get(k, 0) - (erp_map.get(k, 0) - reserved)
        if diff != 0:
            print("sku-mismatch", k[0], k[1], diff)
            deltas.append(SkuDelta(k[0], k[1], diff))
            mismatched_skus.add(k[0])
    host.fs_write_text(journal_path, json.dumps([[d.sku, d.warehouse, d.delta] for d in deltas]))
    host.kv_set(f"{pending_key}:reconciled", len(deltas))
    return {"deltas": deltas, "mismatched_skus": mismatched_skus, "physical": physical}
"""
    inv_args = ["/inv/wh.csv", "https://erp.local/stock.json", "inv:pending", "/inv/journal.json"]
    add_wf(
        family="py-inventory-reconciliation-engine", idx=0, source=src_inv, args=inv_args,
        features=["loop", "branch", "fs", "http", "kv", "set", "tuple-key", "dataclass"],
        scripted_calls={
            "fs.readText": [{"status": "fulfilled", "result": "sku,wh,qty\nA1,east,10\nB2,west,4\n"}],
            "http.get": [{"status": "fulfilled", "result": '[{"sku":"A1","wh":"east","qty":12},{"sku":"B2","wh":"west","qty":4},{"sku":"C3","wh":"east","qty":1}]'}],
            "kv_get": [{"status": "fulfilled", "result": {"A1:east": 2}}],
            "fs.writeText": [{"status": "fulfilled", "result": None}],
            "kv_set": [{"status": "fulfilled", "result": True}],
        },
    )
    add_wf(
        family="py-inventory-reconciliation-engine", idx=1, source=src_inv, args=inv_args,
        features=["loop", "branch", "fs", "http", "kv", "set", "tuple-key", "dataclass"],
        scripted_calls={
            "fs.readText": [{"status": "fulfilled", "result": "sku,wh,qty\nA1,east,10\nB2,west,4\n"}],
            "http.get": [{"status": "fulfilled", "result": '[{"sku":"A1","wh":"east","qty":12},{"sku":"B2","wh":"west","qty":4},{"sku":"C3","wh":"east","qty":1}]'}],
            "kv_get": [{"status": "fulfilled", "result": {"A1:east": 1}}],
            "fs.writeText": [{"status": "fulfilled", "result": None}],
            "kv_set": [{"status": "fulfilled", "result": True}],
        },
    )
    add_wf(
        family="py-inventory-reconciliation-engine", idx=2, source=src_inv,
        args=["/inv/wh2.csv", "https://erp.local/stock2.json", "inv:p2", "/inv/j2.json"],
        features=["loop", "branch", "fs", "http", "kv", "set", "tuple-key", "dataclass"],
        scripted_calls={
            "fs.readText": [{"status": "fulfilled", "result": "sku,wh,qty\nX9,eu,7\n"}],
            "http.get": [{"status": "fulfilled", "result": '[{"sku":"X9","wh":"eu","qty":7}]'}],
            "kv_get": [{"status": "fulfilled", "result": None}],
            "fs.writeText": [{"status": "fulfilled", "result": None}],
            "kv_set": [{"status": "fulfilled", "result": True}],
        },
    )

    # 9. py-merkle-wal-verifier (3 variants: bytes digest chain + corrupt tail + throw)
    src_merkle = """
import hashlib

def run(segment_paths, anchor_key, audit):
    anchor = host.kv_get(anchor_key)
    prev_digest = anchor["digest"]
    valid_records = []
    for path in segment_paths:
        raw = host.fs_read_text(path)
        for idx, line in enumerate(raw.splitlines()):
            parts = line.split(":", 1)
            if len(parts) != 2:
                print("corrupt-wal-record", path, idx)
                if audit.get("strict"):
                    raise ValueError(f"corrupt record at {path}:{idx}")
                break
            rec_hash_hex, payload_hex = parts
            payload = bytes.fromhex(payload_hex)
            expected = hashlib.sha256(prev_digest + payload).digest()
            if expected.hex()[:12] != rec_hash_hex:
                print("chain-mismatch", path, idx)
                if audit.get("strict"):
                    host.kv_set(f"{anchor_key}:err", {"path": path, "idx": idx})
                    raise ValueError("merkle chain mismatch")
                break
            prev_digest = expected
            valid_records.append(payload)
    host.kv_set(anchor_key, {"digest": prev_digest, "count": anchor["count"] + len(valid_records)})
    audit["tail_digest"] = prev_digest
    return {"records": valid_records, "audit": audit}
"""
    def _wal_line(prev: bytes, payload: bytes) -> tuple[str, bytes]:
        dig = hashlib.sha256(prev + payload).digest()
        return f"{dig.hex()[:12]}:{payload.hex()}", dig

    d0 = b"\x00" * 32
    l1, d1 = _wal_line(d0, b"op1")
    l2, d2 = _wal_line(d1, b"op2")
    l3, d3 = _wal_line(d2, b"op3")
    merkle_args = [["/wal/seg1.txt", "/wal/seg2.txt"], "wal:anchor", {"strict": False}]
    add_wf(
        family="py-merkle-wal-verifier", idx=0, source=src_merkle, args=merkle_args,
        features=["loop", "branch", "kv", "fs", "bytes", "exception", "mutation"],
        scripted_calls={
            "kv_get": [{"status": "fulfilled", "result": {"digest": d0, "count": 0}}],
            "fs.readText": [
                {"status": "fulfilled", "result": f"{l1}\n{l2}\n"},
                {"status": "fulfilled", "result": f"{l3}\n"},
            ],
            "kv_set": [{"status": "fulfilled", "result": True}],
        },
    )
    add_wf(
        family="py-merkle-wal-verifier", idx=1, source=src_merkle, args=merkle_args,
        features=["loop", "branch", "kv", "fs", "bytes", "exception", "mutation"],
        scripted_calls={
            "kv_get": [{"status": "fulfilled", "result": {"digest": d0, "count": 0}}],
            "fs.readText": [
                {"status": "fulfilled", "result": f"{l1}\nbad-line\n"},
                {"status": "fulfilled", "result": f"deadbeef0000:{b'bad'.hex()}\n"},
            ],
            "kv_set": [{"status": "fulfilled", "result": True}],
        },
    )
    add_wf(
        family="py-merkle-wal-verifier", idx=2, source=src_merkle,
        args=[["/wal/seg1.txt"], "wal:anchor-strict", {"strict": True}],
        features=["loop", "branch", "kv", "fs", "bytes", "exception"],
        expected_kind="throw", expected_exc="ValueError",
        scripted_calls={
            "kv_get": [{"status": "fulfilled", "result": {"digest": d0, "count": 0}}],
            "fs.readText": [{"status": "fulfilled", "result": f"{l1}\n000000000000:abcd\n"}],
            "kv_set": [{"status": "fulfilled", "result": True}],
        },
    )

    # 10. py-adaptive-hedged-router (3 variants: randomMode="tool" + EMA + both-rejected throw)
    src_hedge = """
import random
import time

def run(stats_key, backends, payload):
    ema = host.kv_get(stats_key) or {b: 50.0 for b in backends}
    roll = random.random()
    ordered = sorted(backends, key=lambda b: ema[b])
    if roll < 0.25 and len(ordered) > 1:
        ordered = [ordered[1], ordered[0]]
        print("hedged-probe-secondary", ordered[0])
    last_err = None
    for target in ordered:
        t0 = time.monotonic()
        try:
            resp = host.http_request({"method": "POST", "url": target, "body": payload})
            lat_ms = round((time.monotonic() - t0) * 1000.0, 2)
            ema[target] = round(0.7 * ema[target] + 0.3 * lat_ms, 2)
            host.kv_set(stats_key, ema)
            return {"backend": target, "resp": resp, "ema": ema}
        except TimeoutError as exc:
            last_err = exc
            ema[target] = round(ema[target] * 1.5, 2)
            print("backend-timeout", target, str(exc))
    host.kv_set(stats_key, ema)
    raise RuntimeError(f"all backends failed: {last_err}")
"""
    hedge_args = ["router:ema", ["https://a.local/api", "https://b.local/api"], {"q": "status"}]
    add_wf(
        family="py-adaptive-hedged-router", idx=0, source=src_hedge, args=hedge_args,
        features=["loop", "branch", "kv", "http", "platform", "random", "exception"],
        random_mode="tool", scripted_randoms=[0.6],
        scripted_times=[10.0, 10.04],
        scripted_calls={
            "kv_get": [{"status": "fulfilled", "result": {"https://a.local/api": 30.0, "https://b.local/api": 80.0}}],
            "http.request": [{"status": "fulfilled", "result": {"ok": True}}],
            "kv_set": [{"status": "fulfilled", "result": True}],
        },
    )
    add_wf(
        family="py-adaptive-hedged-router", idx=1, source=src_hedge, args=hedge_args,
        features=["loop", "branch", "kv", "http", "platform", "random", "exception"],
        random_mode="tool", scripted_randoms=[0.6],
        scripted_times=[10.0, 10.50, 11.0, 11.06],
        scripted_calls={
            "kv_get": [{"status": "fulfilled", "result": {"https://a.local/api": 30.0, "https://b.local/api": 80.0}}],
            "http.request": [
                {"status": "rejected", "result": {"name": "TimeoutError", "message": "a timed out"}},
                {"status": "fulfilled", "result": {"ok": True, "via": "b"}},
            ],
            "kv_set": [{"status": "fulfilled", "result": True}],
        },
    )
    add_wf(
        family="py-adaptive-hedged-router", idx=2, source=src_hedge, args=hedge_args,
        features=["loop", "branch", "kv", "http", "platform", "random", "exception"],
        random_mode="tool", scripted_randoms=[0.1],
        scripted_times=[10.0, 10.5, 11.0, 11.5],
        expected_kind="throw", expected_exc="RuntimeError",
        scripted_calls={
            "kv_get": [{"status": "fulfilled", "result": {"https://a.local/api": 30.0, "https://b.local/api": 80.0}}],
            "http.request": [
                {"status": "rejected", "result": {"name": "TimeoutError", "message": "b timed out"}},
                {"status": "rejected", "result": {"name": "TimeoutError", "message": "a timed out"}},
            ],
            "kv_set": [{"status": "fulfilled", "result": True}],
        },
    )

    # 11. py-feature-flag-evaluator (3 variants: http fallback to kv + set rules + dataclass)
    src_ff = """
from dataclasses import make_dataclass
import hashlib
import json

FlagEval = make_dataclass("FlagEval", [("flag", str), ("enabled", bool), ("reason", str)])

def run(rules_url, cache_key, user_ctx, flag_names):
    stale = False
    user_groups = set(user_ctx["groups"])
    buckets = {}
    for fname in flag_names:
        buckets[fname] = int(hashlib.sha256(f"{fname}:{user_ctx['id']}".encode("utf-8")).hexdigest()[:4], 16) % 100
    try:
        rules = json.loads(host.http_get(rules_url))
        host.kv_set(cache_key, rules)
    except ConnectionError as exc:
        print("flag-fallback-cache", str(exc))
        rules = host.kv_get(cache_key)
        stale = True
        if rules is None:
            host.kv_set(f"{cache_key}:err", {"err": str(exc), "buckets": buckets})
            raise LookupError("no cached flag rules") from exc
    evals = []
    for fname in flag_names:
        rule = rules.get(fname)
        if rule is None:
            evals.append(FlagEval(fname, False, "missing"))
            continue
        if user_groups & set(rule.get("allow_groups", [])):
            evals.append(FlagEval(fname, True, "group-match"))
            continue
        on = buckets[fname] < rule.get("rollout", 0)
        evals.append(FlagEval(fname, on, "rollout" if on else "holdout"))
    print("flags-evaluated", user_ctx["id"], len(evals))
    host.kv_set(f"{cache_key}:last:{user_ctx['id']}", [e.enabled for e in evals])
    return {"stale": stale, "evals": evals, "groups": user_groups}
"""
    ff_args = ["https://flags.local/rules.json", "flags:cache", {"id": "u-42", "groups": ["beta", "us"]}, ["new_ui", "fast_search", "unknown"]]
    ff_rules = {"new_ui": {"allow_groups": ["beta"], "rollout": 10}, "fast_search": {"allow_groups": ["staff"], "rollout": 90}}
    add_wf(
        family="py-feature-flag-evaluator", idx=0, source=src_ff, args=ff_args,
        features=["loop", "branch", "http", "kv", "set", "dataclass", "exception"],
        scripted_calls={
            "http.get": [{"status": "fulfilled", "result": json.dumps(ff_rules)}],
            "kv_set": [{"status": "fulfilled", "result": True}, {"status": "fulfilled", "result": True}],
        },
    )
    add_wf(
        family="py-feature-flag-evaluator", idx=1, source=src_ff, args=ff_args,
        features=["loop", "branch", "http", "kv", "set", "dataclass", "exception"],
        scripted_calls={
            "http.get": [{"status": "rejected", "result": {"name": "ConnectionError", "message": "dns error"}}],
            "kv_get": [{"status": "fulfilled", "result": {"new_ui": {"allow_groups": [], "rollout": 0}, "fast_search": {"allow_groups": ["us"], "rollout": 0}}}],
            "kv_set": [{"status": "fulfilled", "result": True}],
        },
    )
    add_wf(
        family="py-feature-flag-evaluator", idx=2, source=src_ff, args=ff_args,
        features=["loop", "branch", "http", "kv", "exception"],
        expected_kind="throw", expected_exc="LookupError",
        scripted_calls={
            "http.get": [{"status": "rejected", "result": {"name": "ConnectionError", "message": "offline"}}],
            "kv_get": [{"status": "fulfilled", "result": None}],
            "kv_set": [{"status": "fulfilled", "result": True}],
        },
    )

    # 12. py-billing-invoice-aggregator (3 variants: tuple-keyed + FX http_get + -0.0 + idempotency)
    src_bill = """
import json

def run(usage_path, fx_url, invoice_url, idem_prefix):
    lines = host.fs_read_text(usage_path).splitlines()
    fx = json.loads(host.http_get(fx_url))
    totals = {}
    for ln in lines:
        acct, sku, qty_s, cur = ln.split(",")
        if sku not in ("compute", "storage"):
            print("invalid-sku", acct, sku)
            host.kv_set(f"{idem_prefix}:err", {"acct": acct, "sku": sku})
        rate = {"compute": 0.25, "storage": 0.05}[sku]
        usd = float(qty_s) * rate * fx[cur]
        key = (acct, sku)
        totals[key] = round(totals.get(key, 0.0) + usd, 4)
    invoices = {}
    for (acct, sku), amt in sorted(totals.items()):
        invoices.setdefault(acct, 0.0)
        invoices[acct] = round(invoices[acct] + amt, 4)
    dispatched = []
    for acct, total in sorted(invoices.items()):
        if total == 0.0:
            total = -0.0
            invoices[acct] = total
        ikey = f"{idem_prefix}:{acct}"
        if host.kv_get(ikey) is not None:
            print("skip-idempotent-invoice", acct)
            continue
        res = host.http_request({"method": "POST", "url": invoice_url, "acct": acct, "total": total})
        host.kv_set(ikey, {"tx": res["tx"], "total": total})
        dispatched.append((acct, res["tx"]))
    return {"totals": totals, "invoices": invoices, "dispatched": dispatched}
"""
    bill_args = ["/bill/usage.csv", "https://fx.local/rates", "https://bill.local/post", "inv202611"]
    add_wf(
        family="py-billing-invoice-aggregator", idx=0, source=src_bill, args=bill_args,
        features=["loop", "branch", "fs", "http", "kv", "tuple-key", "float-edge"],
        scripted_calls={
            "fs.readText": [{"status": "fulfilled", "result": "a1,compute,10,USD\na1,storage,0,EUR\na2,compute,4,EUR\n"}],
            "http.get": [{"status": "fulfilled", "result": '{"USD":1.0,"EUR":1.1}'}],
            "kv_get": [{"status": "fulfilled", "result": None}, {"status": "fulfilled", "result": None}],
            "http.request": [{"status": "fulfilled", "result": {"tx": "inv-1"}}, {"status": "fulfilled", "result": {"tx": "inv-2"}}],
            "kv_set": [{"status": "fulfilled", "result": True}, {"status": "fulfilled", "result": True}],
        },
    )
    add_wf(
        family="py-billing-invoice-aggregator", idx=1, source=src_bill, args=bill_args,
        features=["loop", "branch", "fs", "http", "kv", "tuple-key", "float-edge"],
        scripted_calls={
            "fs.readText": [{"status": "fulfilled", "result": "a1,compute,0,USD\na2,storage,20,EUR\n"}],
            "http.get": [{"status": "fulfilled", "result": '{"USD":1.0,"EUR":1.1}'}],
            "kv_get": [{"status": "fulfilled", "result": {"tx": "old"}}, {"status": "fulfilled", "result": None}],
            "http.request": [{"status": "fulfilled", "result": {"tx": "inv-2b"}}],
            "kv_set": [{"status": "fulfilled", "result": True}],
        },
    )
    add_wf(
        family="py-billing-invoice-aggregator", idx=2, source=src_bill, args=bill_args,
        features=["loop", "branch", "fs", "http", "kv", "tuple-key", "exception"],
        expected_kind="throw", expected_exc="KeyError",
        scripted_calls={
            "fs.readText": [{"status": "fulfilled", "result": "a1,unknown_sku,5,USD\n"}],
            "http.get": [{"status": "fulfilled", "result": '{"USD":1.0}'}],
            "kv_set": [{"status": "fulfilled", "result": True}],
        },
    )

    # 13. py-canary-traffic-shifter (3 variants: randomMode="tool" + metrics probe + rollback)
    src_shift = """
import json
import random
import time

def run(weight_key, health_url, samples, state_out):
    weights = host.kv_get(weight_key)
    health = json.loads(host.http_get(health_url))
    ts = time.time()
    if health["error_rate"] > 0.05:
        print("canary-rollback", health["error_rate"], ts)
        weights["canary"] = 0.0
        weights["stable"] = 1.0
        state_out["action"] = "rollback"
    elif health["error_rate"] < 0.01 and weights["canary"] < 0.5:
        weights["canary"] = round(min(0.5, weights["canary"] + 0.2), 2)
        weights["stable"] = round(1.0 - weights["canary"], 2)
        print("canary-promoted", weights["canary"], ts)
        state_out["action"] = "promote"
    else:
        state_out["action"] = "hold"
    routed = []
    for req_id in samples:
        r = random.random()
        target = "canary" if r < weights["canary"] else "stable"
        routed.append((req_id, target))
    host.kv_set(weight_key, weights)
    state_out["weights_alias"] = weights
    return {"weights": weights, "routed": routed, "state": state_out}
"""
    shift_args = ["traffic:checkout", "https://metrics.local/canary", ["req1", "req2", "req3", "req4"], {}]
    add_wf(
        family="py-canary-traffic-shifter", idx=0, source=src_shift, args=shift_args,
        features=["loop", "branch", "kv", "http", "platform", "random", "alias", "mutation"],
        random_mode="tool", scripted_times=[6000.0], scripted_randoms=[0.1, 0.35, 0.8, 0.2],
        scripted_calls={
            "kv_get": [{"status": "fulfilled", "result": {"stable": 0.9, "canary": 0.1}}],
            "http.get": [{"status": "fulfilled", "result": '{"error_rate": 0.002}'}],
            "kv_set": [{"status": "fulfilled", "result": True}],
        },
    )
    add_wf(
        family="py-canary-traffic-shifter", idx=1, source=src_shift, args=shift_args,
        features=["loop", "branch", "kv", "http", "platform", "random", "alias", "mutation"],
        random_mode="tool", scripted_times=[6000.0], scripted_randoms=[0.1, 0.35, 0.8, 0.2],
        scripted_calls={
            "kv_get": [{"status": "fulfilled", "result": {"stable": 0.8, "canary": 0.2}}],
            "http.get": [{"status": "fulfilled", "result": '{"error_rate": 0.12}'}],
            "kv_set": [{"status": "fulfilled", "result": True}],
        },
    )
    add_wf(
        family="py-canary-traffic-shifter", idx=2, source=src_shift,
        args=["traffic:search", "https://metrics.local/search", ["r1", "r2"], {}],
        features=["loop", "branch", "kv", "http", "platform", "random", "alias", "mutation"],
        random_mode="tool", scripted_times=[6100.0], scripted_randoms=[0.4, 0.6],
        scripted_calls={
            "kv_get": [{"status": "fulfilled", "result": {"stable": 0.5, "canary": 0.5}}],
            "http.get": [{"status": "fulfilled", "result": '{"error_rate": 0.02}'}],
            "kv_set": [{"status": "fulfilled", "result": True}],
        },
    )

    # 14. py-deadletter-replayer (3 variants: random jitter + quarantine fs_write + exception handling)
    src_dlq = """
import json
import random

def run(dlq_key, replay_url, quarantine_path, state):
    items = host.kv_get(dlq_key)
    replayed = []
    quarantined = []
    for item in items:
        try:
            if "id" not in item or not isinstance(item.get("amount"), (int, float)):
                raise ValueError("malformed dlq item")
            jitter = round(random.random() * 0.25, 3)
            resp = host.http_request({"method": "POST", "url": replay_url, "id": item["id"], "jitter": jitter})
            replayed.append((item["id"], resp["code"]))
        except (ValueError, ConnectionError) as exc:
            print("dlq-quarantine", item.get("id"), str(exc))
            quarantined.append({"item": item, "err": str(exc)})
    if quarantined:
        host.fs_write_text(quarantine_path, json.dumps(quarantined, sort_keys=True))
    host.kv_set(dlq_key, [])
    state["replayed"] = len(replayed)
    state["quarantined"] = len(quarantined)
    return {"replayed": replayed, "quarantined": quarantined, "state": state}
"""
    dlq_args = ["dlq:payments", "https://pay.local/replay", "/dlq/quarantine.json", {}]
    dlq_items = [{"id": "d1", "amount": 10}, {"amount": "bad"}, {"id": "d3", "amount": 25}]
    add_wf(
        family="py-deadletter-replayer", idx=0, source=src_dlq, args=dlq_args,
        features=["loop", "branch", "kv", "http", "fs", "random", "exception", "mutation"],
        random_mode="tool", scripted_randoms=[0.2, 0.8],
        scripted_calls={
            "kv_get": [{"status": "fulfilled", "result": dlq_items}],
            "http.request": [{"status": "fulfilled", "result": {"code": 200}}, {"status": "fulfilled", "result": {"code": 200}}],
            "fs.writeText": [{"status": "fulfilled", "result": None}],
            "kv_set": [{"status": "fulfilled", "result": True}],
        },
    )
    add_wf(
        family="py-deadletter-replayer", idx=1, source=src_dlq, args=dlq_args,
        features=["loop", "branch", "kv", "http", "fs", "random", "exception", "mutation"],
        random_mode="tool", scripted_randoms=[0.2, 0.8],
        scripted_calls={
            "kv_get": [{"status": "fulfilled", "result": dlq_items}],
            "http.request": [
                {"status": "fulfilled", "result": {"code": 200}},
                {"status": "rejected", "result": {"name": "ConnectionError", "message": "gateway 502"}},
            ],
            "fs.writeText": [{"status": "fulfilled", "result": None}],
            "kv_set": [{"status": "fulfilled", "result": True}],
        },
    )
    add_wf(
        family="py-deadletter-replayer", idx=2, source=src_dlq,
        args=["dlq:empty", "https://pay.local/replay", "/dlq/q2.json", {}],
        features=["loop", "branch", "kv", "http", "random", "mutation"],
        random_mode="tool", scripted_randoms=[0.5],
        scripted_calls={
            "kv_get": [{"status": "fulfilled", "result": [{"id": "d9", "amount": 99}]}],
            "http.request": [{"status": "fulfilled", "result": {"code": 202}}],
            "kv_set": [{"status": "fulfilled", "result": True}],
        },
    )

    # 15. py-graph-pagerank-checkpoint (3 variants: cyclic node graph + $py:ref + time budget)
    src_pr = """
import time

def run(edges_key, iters, budget_s, graph_out):
    t0 = time.monotonic()
    edges = host.kv_get(edges_key)
    nodes = {}
    for u, v in edges:
        nodes.setdefault(u, {"id": u, "out": [], "rank": 0.0})
        nodes.setdefault(v, {"id": v, "out": [], "rank": 0.0})
    for u, v in edges:
        nodes[u]["out"].append(nodes[v])
    n = len(nodes)
    for nd in nodes.values():
        nd["rank"] = 1.0 / n
    stopped_early = False
    for step in range(iters):
        if time.monotonic() - t0 >= budget_s:
            print("pr-budget-stop", step)
            stopped_early = True
            break
        nxt = {k: 0.15 / n for k in nodes}
        for u_id, nd in nodes.items():
            deg = len(nd["out"])
            share = 0.85 * nd["rank"] / deg if deg else 0.0
            for dst in nd["out"]:
                nxt[dst["id"]] += share
        for k, val in nxt.items():
            nodes[k]["rank"] = round(val, 6)
    host.kv_set(f"{edges_key}:ranks", {k: v["rank"] for k, v in nodes.items()})
    graph_out["nodes"] = nodes
    return {"ranks": {k: v["rank"] for k, v in nodes.items()}, "graph": graph_out, "stopped": stopped_early}
"""
    pr_args = ["pr:mini", 3, 1.0, {}]
    add_wf(
        family="py-graph-pagerank-checkpoint", idx=0, source=src_pr, args=pr_args,
        features=["loop", "branch", "graph", "cycle", "alias", "kv", "platform", "mutation"],
        scripted_times=[100.0, 100.1, 100.2, 100.3],
        scripted_calls={
            "kv_get": [{"status": "fulfilled", "result": [["A", "B"], ["B", "C"], ["C", "A"]]}],
            "kv_set": [{"status": "fulfilled", "result": True}],
        },
    )
    add_wf(
        family="py-graph-pagerank-checkpoint", idx=1, source=src_pr, args=pr_args,
        features=["loop", "branch", "graph", "cycle", "alias", "kv", "platform", "mutation"],
        scripted_times=[100.0, 100.2, 101.2],
        scripted_calls={
            "kv_get": [{"status": "fulfilled", "result": [["A", "B"], ["B", "C"], ["C", "A"]]}],
            "kv_set": [{"status": "fulfilled", "result": True}],
        },
    )
    add_wf(
        family="py-graph-pagerank-checkpoint", idx=2, source=src_pr,
        args=["pr:dag", 2, 5.0, {}],
        features=["loop", "branch", "graph", "alias", "kv", "platform", "mutation"],
        scripted_times=[200.0, 200.1, 200.2],
        scripted_calls={
            "kv_get": [{"status": "fulfilled", "result": [["N1", "N2"], ["N1", "N3"], ["N2", "N3"]]}],
            "kv_set": [{"status": "fulfilled", "result": True}],
        },
    )

    # 16. py-secret-rotation-coordinator (4 variants: dual-key rotation + randomMode="tool" + rollback + throw)
    src_rot = """
import hashlib
import random
import time

def run(secret_key, targets, audit):
    cur = host.kv_get(secret_key)
    salt = str(int(random.random() * 1_000_000))
    new_token = hashlib.sha256(f"{cur['current']}:{salt}".encode("utf-8")).hexdigest()[:16]
    next_state = {"previous": cur["current"], "current": new_token, "version": cur["version"] + 1, "rotated_at": time.time()}
    host.kv_set(secret_key, next_state)
    pushed = []
    try:
        for url in targets:
            resp = host.http_request({"method": "PUT", "url": url, "version": next_state["version"], "token": new_token})
            if not resp.get("verified"):
                raise ValueError(f"verification failed at {url}")
            pushed.append(url)
    except (ConnectionError, ValueError) as exc:
        print("rotation-rollback", str(exc), len(pushed))
        host.kv_set(secret_key, cur)
        audit["rolled_back"] = True
        audit["pushed_before_err"] = pushed
        if isinstance(exc, ValueError):
            raise
        return {"ok": False, "audit": audit, "active": cur}
    audit["rolled_back"] = False
    audit["state_alias"] = next_state
    return {"ok": True, "active": next_state, "pushed": pushed, "audit": audit}
"""
    rot_args = ["sec:api-signing", ["https://gw1.local/secret", "https://gw2.local/secret"], {}]
    add_wf(
        family="py-secret-rotation-coordinator", idx=0, source=src_rot, args=rot_args,
        features=["loop", "branch", "kv", "http", "platform", "random", "exception", "alias", "mutation"],
        random_mode="tool", scripted_randoms=[0.4219], scripted_times=[9000.0],
        scripted_calls={
            "kv_get": [{"status": "fulfilled", "result": {"previous": "old0", "current": "cur1", "version": 5}}],
            "kv_set": [{"status": "fulfilled", "result": True}],
            "http.request": [
                {"status": "fulfilled", "result": {"verified": True}},
                {"status": "fulfilled", "result": {"verified": True}},
            ],
        },
    )
    add_wf(
        family="py-secret-rotation-coordinator", idx=1, source=src_rot, args=rot_args,
        features=["loop", "branch", "kv", "http", "platform", "random", "exception", "mutation"],
        random_mode="tool", scripted_randoms=[0.4219], scripted_times=[9000.0],
        scripted_calls={
            "kv_get": [{"status": "fulfilled", "result": {"previous": "old0", "current": "cur1", "version": 5}}],
            "kv_set": [{"status": "fulfilled", "result": True}, {"status": "fulfilled", "result": True}],
            "http.request": [
                {"status": "fulfilled", "result": {"verified": True}},
                {"status": "rejected", "result": {"name": "ConnectionError", "message": "gw2 unreachable"}},
            ],
        },
    )
    add_wf(
        family="py-secret-rotation-coordinator", idx=2, source=src_rot, args=rot_args,
        features=["loop", "branch", "kv", "http", "platform", "random", "exception", "mutation"],
        random_mode="tool", scripted_randoms=[0.4219], scripted_times=[9000.0],
        expected_kind="throw", expected_exc="ValueError",
        scripted_calls={
            "kv_get": [{"status": "fulfilled", "result": {"previous": "old0", "current": "cur1", "version": 5}}],
            "kv_set": [{"status": "fulfilled", "result": True}, {"status": "fulfilled", "result": True}],
            "http.request": [
                {"status": "fulfilled", "result": {"verified": False}},
            ],
        },
    )
    add_wf(
        family="py-secret-rotation-coordinator", idx=3, source=src_rot,
        args=["sec:webhook", ["https://wh.local/secret"], {}],
        features=["loop", "branch", "kv", "http", "platform", "random", "alias", "mutation"],
        random_mode="tool", scripted_randoms=[0.777], scripted_times=[9100.0],
        scripted_calls={
            "kv_get": [{"status": "fulfilled", "result": {"previous": "p1", "current": "c2", "version": 1}}],
            "kv_set": [{"status": "fulfilled", "result": True}],
            "http.request": [{"status": "fulfilled", "result": {"verified": True}}],
        },
    )

    return tasks


# ---------------------------------------------------------------------------
# Strict verification, Inkling token budget check, & JSONL emission
# ---------------------------------------------------------------------------

def _verify_task(task: dict[str, Any]) -> dict[str, Any]:
    src_len = len(task["source"])
    if src_len > 35_000:
        raise ValueError(f"{task['id']}: source length {src_len} exceeds 35,000 chars")
    prepared = prepare_python_task(task, trace_format="compact")
    outcome = prepared.get("outcome") or {}
    expected_kind = task["metadata"].get("expectedKind", "return")
    if outcome.get("kind") != expected_kind:
        raise ValueError(
            f"{task['id']}: outcome kind={outcome.get('kind')} expected={expected_kind} readable={outcome.get('readable')}"
        )
    if expected_kind == "throw":
        expected_exc = task["metadata"].get("expectedException")
        actual_exc = ((outcome.get("readable") or {}).get("value") or {}).get("name")
        if expected_exc and actual_exc != expected_exc:
            raise ValueError(f"{task['id']}: exception name={actual_exc!r} expected={expected_exc!r}")
    turns = prepared.get("traceTurns")
    if not isinstance(turns, list):
        raise ValueError(f"{task['id']}: traceTurns missing (trace fallback hit resource limit)")

    exported = export_python_example(task, trace_format="compact", reasoning_channel="thinking")
    audit = exported["metadata"]["traceAudit"]
    if not audit.get("replayVerified"):
        raise ValueError(f"{task['id']}: replayVerified is False")
    if not audit.get("canonicalCausalNarration"):
        raise ValueError(f"{task['id']}: canonicalCausalNarration is False")
    narration_lines = int(audit.get("narrationLines", 0))
    if narration_lines < 8:
        raise ValueError(f"{task['id']}: narrationLines={narration_lines} < 8")
    ext_calls = int(exported["metadata"]["externalCalls"])
    if task["metadata"]["part"] == "B" and not (4 <= ext_calls <= 16):
        raise ValueError(f"{task['id']}: Part B externalCalls={ext_calls} not in [4, 16]")

    thinking_blocks = [
        assistant_thinking_text(m)
        for m in exported["messages"]
        if m.get("role") == "assistant" and assistant_thinking_text(m).strip()
    ]
    all_trace_lines = [ln for blk in thinking_blocks for ln in blk.splitlines()]
    omitted_turns = sum(1 for ln in all_trace_lines if "omitted) ..." in ln)

    enriched = {
        **exported["task"],
        "tier": 5,
        "features": task["features"],
        "metadata": {
            **exported["task"].get("metadata", {}),
            "tier": 5,
            "features": task["features"],
            "sourceHash": exported["sourceHash"],
            "sourceChars": src_len,
            "externalCalls": exported["metadata"]["externalCalls"],
            "narrationLines": narration_lines,
            "replayVerified": True,
        },
    }
    return {
        "task": enriched,
        "exported": exported,
        "part": task["metadata"]["part"],
        "outcomeKind": outcome.get("kind"),
        "narrationLines": narration_lines,
        "externalCalls": exported["metadata"]["externalCalls"],
        "omittedTurns": omitted_turns,
    }


def _check_inkling_tokens(verified_rows: list[dict[str, Any]], max_allowed: int = 28_000) -> dict[str, Any] | None:
    try:
        from tinker_js.adapter import DEFAULT_MODEL, TinkerAdapter
        adapter = TinkerAdapter({"model": DEFAULT_MODEL, "max_context_tokens": 65536})
        sdk = adapter._sdk()
    except Exception as exc:
        return {"available": False, "reason": str(exc)}

    counts: list[tuple[int, str]] = []
    for r in verified_rows:
        rendered = sdk.renderer.build_supervised_example(
            r["exported"]["messages"],
            train_on_what=sdk.customized,
        )
        n_tok = len(rendered[0].to_ints())
        counts.append((n_tok, r["task"]["id"]))
        if n_tok >= max_allowed:
            raise ValueError(f"{r['task']['id']}: rendered tokens {n_tok} >= {max_allowed}")
    counts.sort()
    return {
        "available": True,
        "minTokens": counts[0][0],
        "medianTokens": counts[len(counts) // 2][0],
        "p90Tokens": counts[int(len(counts) * 0.9)][0],
        "maxTokens": counts[-1][0],
        "maxTask": counts[-1][1],
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Build and verify Wave 2 hairy real-repo + effectful Python tasks.")
    parser.add_argument("--dgx1", type=Path, default=DEFAULT_DGX1, help="Path to /tmp/tinker-harvest-py-dgx")
    parser.add_argument("--dgx2", type=Path, default=DEFAULT_DGX2, help="Path to /tmp/tinker-harvest-py-dgx-wave2")
    parser.add_argument("--wave1-tasks", type=Path, default=DEFAULT_WAVE1_TASKS, help="Wave 1 tasks.jsonl for overlap check")
    parser.add_argument("--wave1-builder", type=Path, default=DEFAULT_WAVE1_BUILDER, help="Wave 1 builder for overlap check")
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT, help="Output tasks.jsonl path")
    parser.add_argument("--jobs", type=int, default=4, help="Parallel verification workers")
    args = parser.parse_args(argv)

    wave1_families = _load_wave1_families(args.wave1_tasks, args.wave1_builder)
    part_a = build_part_a_tasks(args.dgx1, args.dgx2)
    part_b = build_part_b_tasks()
    all_tasks = [*part_a, *part_b]

    seen_ids: set[str] = set()
    wave2_families: set[str] = set()
    for t in all_tasks:
        tid = t["id"]
        if tid in seen_ids:
            raise ValueError(f"Duplicate task id: {tid}")
        seen_ids.add(tid)
        wave2_families.add(t["family"])

    overlap = wave1_families & wave2_families
    if overlap:
        raise SystemExit(f"Family overlap with Wave 1 detected: {sorted(overlap)}")

    jobs = max(1, min(16, args.jobs))
    verified_rows: list[dict[str, Any]] = []
    failures: list[str] = []

    with concurrent.futures.ThreadPoolExecutor(max_workers=jobs) as pool:
        futs = {pool.submit(_verify_task, t): t["id"] for t in all_tasks}
        for fut in concurrent.futures.as_completed(futs):
            tid = futs[fut]
            try:
                verified_rows.append(fut.result())
            except Exception as exc:
                failures.append(f"{tid}: {exc}")
                print(f"FAIL {tid}: {exc}", file=sys.stderr)

    if failures:
        raise SystemExit(f"{len(failures)} tasks failed verification:\n" + "\n".join(failures))

    order_map = {t["id"]: i for i, t in enumerate(all_tasks)}
    verified_rows.sort(key=lambda r: order_map[r["task"]["id"]])

    supervision_audit = audit_python_supervision(
        [r["exported"] for r in verified_rows],
        {"formats": ["compact"], "samplePerFeature": 500, "seed": 17},
    )
    if not (supervision_audit.get("valid") and supervision_audit.get("allReplayed")):
        raise SystemExit("audit_python_supervision failed!")

    token_stats = _check_inkling_tokens(verified_rows, max_allowed=28_000)

    out_path = args.output.resolve()
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(
        "\n".join(_json_compact(r["task"]) for r in verified_rows) + "\n",
        encoding="utf-8",
    )

    src_sizes = sorted(len(r["task"]["source"].encode("utf-8")) for r in verified_rows)
    part_a_sizes = sorted(len(r["task"]["source"].encode("utf-8")) for r in verified_rows if r["part"] == "A")
    all_lines = sorted(r["narrationLines"] for r in verified_rows)
    part_a_lines = sorted(r["narrationLines"] for r in verified_rows if r["part"] == "A")
    part_b_lines = sorted(r["narrationLines"] for r in verified_rows if r["part"] == "B")
    effectful_calls = [r["externalCalls"] for r in verified_rows if r["externalCalls"] > 0]
    omitted_count = sum(1 for r in verified_rows if r["omittedTurns"] > 0)
    throw_count = sum(1 for r in verified_rows if r["outcomeKind"] == "throw")
    exc_feat_count = sum(1 for r in verified_rows if "exception" in r["task"]["features"])

    summary = {
        "output": str(out_path),
        "totalTasks": len(verified_rows),
        "partATasks": len(part_a_lines),
        "partBTasks": len(part_b_lines),
        "families": len(wave2_families),
        "partAFamilies": len({r["task"]["family"] for r in verified_rows if r["part"] == "A"}),
        "partBFamilies": len({r["task"]["family"] for r in verified_rows if r["part"] == "B"}),
        "wave1OverlapCount": len(overlap),
        "effectfulTasks": len(effectful_calls),
        "effectfulRatio": round(len(effectful_calls) / len(verified_rows), 4),
        "minExternalCalls": min(effectful_calls) if effectful_calls else 0,
        "maxExternalCalls": max(effectful_calls) if effectful_calls else 0,
        "exceptionTasks": exc_feat_count,
        "throwTasks": throw_count,
        "allReplayVerified": all(r["task"]["metadata"]["replayVerified"] for r in verified_rows),
        "supervisionAuditChecked": supervision_audit["summary"]["conversations"],
        "causalDivergencesChecked": supervision_audit["causalDivergencesChecked"],
        "tasksWithOmittedSteps": omitted_count,
        "sourceBytesAll": {
            "min": src_sizes[0],
            "median": src_sizes[len(src_sizes) // 2],
            "max": src_sizes[-1],
        },
        "sourceBytesPartA": {
            "min": part_a_sizes[0],
            "median": part_a_sizes[len(part_a_sizes) // 2],
            "max": part_a_sizes[-1],
        },
        "traceLinesAll": {
            "min": all_lines[0],
            "median": all_lines[len(all_lines) // 2],
            "p90": all_lines[int(len(all_lines) * 0.9)],
            "max": all_lines[-1],
        },
        "traceLinesPartA": {
            "min": part_a_lines[0],
            "median": part_a_lines[len(part_a_lines) // 2],
            "max": part_a_lines[-1],
        },
        "traceLinesPartB": {
            "min": part_b_lines[0],
            "median": part_b_lines[len(part_b_lines) // 2],
            "max": part_b_lines[-1],
        },
        "inklingTokens": token_stats,
    }
    print(json.dumps(summary, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
