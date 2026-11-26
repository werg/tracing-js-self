#!/usr/bin/env python3
"""Build and strictly verify 60-75 hairy, realistic Python execution tasks.

Produces two complementary halves:
  Part A (~43 tasks): Hairy real-codebase slices extracted directly from the local
      OSS Python repositories under /tmp/tinker-harvest-py-dgx/ and
      /tmp/tinker-harvest-py-dgx-wave2/, driven with realistic multi-step inputs
      (including effectful drivers around real repo code).
  Part B (30 tasks): 10 hairy multi-turn effectful workflow families x 3 instances
      each (4-16 external calls per task across platform.print, platform.time,
      platform.random, fs.readText, fs.writeText, http.get, http.request,
      kv_get, kv_set) with aliasing, in-place mutation, $py types, and
      try/except failure recovery.

100% of emitted tasks are verified through:
  export_python_example(task, trace_format="compact", reasoning_channel="thinking")
which executes in the isolated python-reference-worker subprocess with
sys.settrace container tracing and verifies replayVerified == True via
audit_python_conversation().
"""

from __future__ import annotations

import argparse
import ast
import builtins
import concurrent.futures
import copy
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

from tinker_py.codec import decode_readable, encode_exception, encode_readable  # noqa: E402
from tinker_py.execution import (  # noqa: E402
    assistant_thinking_text,
    audit_python_supervision,
    export_python_example,
    prepare_python_task,
)


DEFAULT_DGX1 = Path("/tmp/tinker-harvest-py-dgx")
DEFAULT_DGX2 = Path("/tmp/tinker-harvest-py-dgx-wave2")
DEFAULT_OUTPUT = _REPO_ROOT / "runs/hairy-real-py-tasks/tasks.jsonl"


def _json_compact(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def _sha256(value: Any) -> str:
    text = value if isinstance(value, str) else _json_compact(value)
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


# ---------------------------------------------------------------------------
# AST extraction helpers from real repos on disk
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


def _stmt_slice(lines: list[str], stmt: ast.stmt) -> str:
    start = stmt.lineno - 1
    if isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and stmt.decorator_list:
        start = min(d.lineno for d in stmt.decorator_list) - 1
    end = getattr(stmt, "end_lineno", stmt.lineno) or stmt.lineno
    return "\n".join(lines[start:end])


def _extract_symbols(path: Path, symbol_names: list[str], *, strip_decorators: set[str] | None = None) -> str:
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
        seg = _stmt_slice(lines, stmt)
        if strip_decorators:
            kept_lines = [
                ln
                for ln in seg.splitlines()
                if not any(ln.lstrip().startswith(f"@{dec}") for dec in strip_decorators)
            ]
            seg = "\n".join(kept_lines)
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
# Local fixture recorder for effectful tasks (then strictly verified via worker)
# ---------------------------------------------------------------------------

class _UnscriptedHostCallError(BaseException):
    """Raised when a guest makes more host calls than scripted during fixture recording."""


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
            raise _make_guest_exc(result if isinstance(result, dict) else {"name": "RuntimeError", "message": str(result)})
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
        fn(*args_copy)
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
    max_steps: int = 200_000,
    timeout_ms: int = 10_000,
) -> dict[str, Any]:
    recorded = _record_fixture_calls(
        source,
        entry,
        args,
        scripted_calls=scripted_calls,
        scripted_times=scripted_times,
        scripted_randoms=scripted_randoms,
        random_mode=random_mode,
        random_seed=random_seed,
    )
    all_features = sorted(set(features) | {"hairy-real", "python"} | ({"external", "sequential"} if recorded else set()))
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
        },
    }


# ---------------------------------------------------------------------------
# PART A: 42 Hairy Real-Repo Python Slices
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
                metadata={
                    "repo": repo,
                    "sourceFile": source_file,
                    "sourceOrigin": "hairy-real-repo-slice",
                    "part": "A",
                    "lineage": [f"py-repo:{repo}", family],
                },
            )
        )

    # =========================================================================
    # 1. karpathy__minbpe (4 tasks: pure train/encode/decode, regex BPE, 2 effectful)
    # =========================================================================
    minbpe_base = dgx1 / "karpathy__minbpe/minbpe/base.py"
    minbpe_basic = dgx1 / "karpathy__minbpe/minbpe/basic.py"
    minbpe_regex = dgx1 / "karpathy__minbpe/minbpe/regex.py"

    minbpe_core_src = "\n\n".join([
        "import unicodedata",
        "_INIT_BYTE_VOCAB = {idx: bytes([idx]) for idx in range(256)}",
        _extract_symbols(minbpe_base, ["get_stats", "merge", "replace_control_characters", "render_token", "Tokenizer"]),
        _extract_symbols(minbpe_basic, ["BasicTokenizer"]),
    ]).replace("{idx: bytes([idx]) for idx in range(256)} # int -> bytes", "dict(_INIT_BYTE_VOCAB)").replace(
        "vocab = {idx: bytes([idx]) for idx in range(256)}", "vocab = dict(_INIT_BYTE_VOCAB)"
    )

    minbpe_pipeline_src = minbpe_core_src + """

def run(train_text, vocab_size, probe_text):
    tok = BasicTokenizer()
    tok.train(train_text, vocab_size, verbose=False)
    ids = tok.encode(probe_text)
    decoded = tok.decode(ids)
    merges_out = {f"{p[0]}+{p[1]}": idx for p, idx in tok.merges.items()}
    rendered = [render_token(tok.vocab[i]) for i in ids[:6]]
    return {
        "merges": merges_out,
        "ids": ids,
        "decoded": decoded,
        "roundtrip": decoded == probe_text,
        "rendered_head": rendered,
    }
"""
    add_repo_task(
        task_id="py-real-minbpe-basic-pipeline-0",
        family="py-real:karpathy__minbpe:basic_pipeline",
        repo="karpathy__minbpe",
        source_file="minbpe/base.py+minbpe/basic.py",
        source=minbpe_pipeline_src,
        entry="run",
        args=["abab", 257, "ab ab"],
        features=["loop", "branch", "class", "bpe", "bytes"],
    )

    # RegexTokenizer slice (stdlib re pattern compatible with Python's re engine)
    minbpe_regex_src = "\n\n".join([
        "import re",
        "import unicodedata",
        "_INIT_BYTE_VOCAB = {idx: bytes([idx]) for idx in range(256)}",
        _extract_symbols(minbpe_base, ["get_stats", "merge", "replace_control_characters", "render_token", "Tokenizer"]),
        _extract_symbols(minbpe_regex, ["RegexTokenizer"]),
    ]).replace(
        "vocab = {idx: bytes([idx]) for idx in range(256)}", "vocab = dict(_INIT_BYTE_VOCAB)"
    )
    minbpe_regex_driver = (
        'GPT4_SPLIT_PATTERN = r"""\'(?:[sdmt]|ll|ve|re)| ?[A-Za-z]+| ?[0-9]+| ?[^\\sA-Za-z0-9]+|\\s+(?!\\S)|\\s+"""\n\n'
        + minbpe_regex_src
        + """

def run(train_text, probe_text, vocab_size):
    tok = RegexTokenizer()
    tok.train(train_text, vocab_size, verbose=False)
    tok.register_special_tokens({"<|endoftext|>": vocab_size})
    ids = tok.encode(probe_text, allowed_special={"<|endoftext|>"})
    back = tok.decode(ids)
    return {
        "num_merges": len(tok.merges),
        "ids": ids,
        "decoded": back,
        "exact": back == probe_text,
    }
"""
    )
    add_repo_task(
        task_id="py-real-minbpe-regex-special-0",
        family="py-real:karpathy__minbpe:regex_tokenizer",
        repo="karpathy__minbpe",
        source_file="minbpe/regex.py",
        source=minbpe_regex_driver,
        entry="run",
        args=["abab", "ab<|endoftext|>ab", 257],
        features=["loop", "branch", "class", "regex", "bpe"],
    )

    # Effectful minbpe driver #1: verbose merge progress + time.time() + kv_set
    minbpe_eff_train_src = "import time\n\n" + minbpe_core_src + """

def run(corpus, vocab_size, state_out):
    t0 = time.time()
    tok = BasicTokenizer()
    tok.train(corpus, vocab_size, verbose=True)
    elapsed = round(time.time() - t0, 3)
    encoded = tok.encode(corpus[:18])
    state_out["merges"] = len(tok.merges)
    state_out["elapsed"] = elapsed
    host.kv_set("bpe:latest", {"merges": len(tok.merges), "sample": encoded})
    return (state_out, encoded)
"""
    add_repo_task(
        task_id="py-real-minbpe-effectful-train-0",
        family="py-real:karpathy__minbpe:effectful_train",
        repo="karpathy__minbpe",
        source_file="minbpe/basic.py",
        source=minbpe_eff_train_src,
        entry="run",
        args=["abaab", 257, {"merges": 0}],
        features=["loop", "branch", "class", "bpe", "hard-effectful", "platform", "kv"],
        scripted_times=[1700001000.0, 1700001000.25],
        scripted_calls={"kv_set": [{"status": "fulfilled", "result": True}]},
    )

    # Effectful minbpe driver #2: http_get text -> train -> render_token -> print -> fs_write_text
    minbpe_eff_http_src = minbpe_core_src + """
import json

def run(url, out_path):
    raw = host.http_get(url)
    tok = BasicTokenizer()
    tok.train(raw, 257, verbose=True)
    ids = tok.encode(raw)
    tokens = [render_token(tok.vocab[i]) for i in ids]
    print("tokens", len(tokens))
    summary = {"tokens": tokens, "ids": ids, "merges": len(tok.merges)}
    host.fs_write_text(out_path, json.dumps(summary, sort_keys=True))
    return summary
"""
    add_repo_task(
        task_id="py-real-minbpe-effectful-http-0",
        family="py-real:karpathy__minbpe:effectful_http_encode",
        repo="karpathy__minbpe",
        source_file="minbpe/base.py+minbpe/basic.py",
        source=minbpe_eff_http_src,
        entry="run",
        args=["https://corpus.local/sample.txt", "/tmp/bpe_summary.json"],
        features=["loop", "branch", "class", "bpe", "hard-effectful", "http", "fs"],
        scripted_calls={
            "http.get": [{"status": "fulfilled", "result": "aaab"}],
            "fs.writeText": [{"status": "fulfilled", "result": None}],
        },
    )

    # =========================================================================
    # 2. pallets__jinja (6 tasks: filters, utils, lexer)
    # =========================================================================
    jinja_filters = dgx1 / "pallets__jinja/src/jinja2/filters.py"
    jinja_utils = dgx1 / "pallets__jinja/src/jinja2/utils.py"
    jinja_lexer = dgx1 / "pallets__jinja/src/jinja2/lexer.py"

    jinja_shim = """
import html
import math
import re
import typing as t
from collections import abc, deque
from itertools import groupby
from urllib.parse import quote_from_bytes

F = t.TypeVar("F")
K = t.TypeVar("K")
V = t.TypeVar("V")

class _Markup(str):
    def striptags(self):
        return re.sub(r"\\s+", " ", re.sub(r"<[^>]+>", " ", self)).strip()

class _MarkupSafe:
    @staticmethod
    def escape(val):
        return _Markup(html.escape(str(val), quote=True))
    Markup = _Markup

markupsafe = _MarkupSafe()
escape = markupsafe.escape
Markup = _Markup
soft_str = str

class Undefined:
    def __init__(self, hint=None, name=None):
        self.hint = hint
        self.name = name

class FilterArgumentError(ValueError):
    pass

class EvalContext:
    def __init__(self, env, autoescape=False):
        self.environment = env
        self.autoescape = autoescape

class Environment:
    def __init__(self, autoescape=False):
        self.newline_sequence = "\\n"
        self.policies = {"truncate.leeway": 5, "urlize.rel": None, "urlize.target": None, "urlize.extra_schemes": None}
        self.autoescape = autoescape
    def getitem(self, obj, argument):
        if isinstance(obj, dict):
            return obj.get(argument, Undefined(name=str(argument)))
        if isinstance(obj, (list, tuple)) and isinstance(argument, int) and -len(obj) <= argument < len(obj):
            return obj[argument]
        return getattr(obj, str(argument), Undefined(name=str(argument)))
    def undefined(self, hint=None, name=None):
        return Undefined(hint=hint, name=name)

class _NoopLock:
    def __enter__(self): return self
    def __exit__(self, *args): return False

def Lock():
    return _NoopLock()

def pass_environment(f): return f
def pass_eval_context(f): return f
def pass_context(f): return f
"""

    jinja_groupby_src = jinja_shim + "\n" + _extract_symbols(
        jinja_filters,
        ["ignore_case", "make_attrgetter", "make_multi_attrgetter", "_prepare_attribute_parts", "do_dictsort", "do_sort", "_GroupTuple", "sync_do_groupby", "do_round"],
        strip_decorators={"pass_environment", "pass_eval_context", "pass_context"},
    ) + """

def run(records, extra_map):
    env = Environment()
    groups = sync_do_groupby(env, records, "dept.code", default="UNASSIGNED", case_sensitive=False)
    summary = {}
    for grp in groups:
        ordered = do_sort(env, grp.list, reverse=True, attribute="score,name")
        avg = do_round(sum(x["score"] for x in ordered) / len(ordered), 2, "common")
        summary[grp.grouper] = {"names": [x["name"] for x in ordered], "avg": avg}
    sorted_extra = do_dictsort(extra_map, case_sensitive=False, by="value", reverse=True)
    return {"groups": summary, "extra": sorted_extra}
"""
    add_repo_task(
        task_id="py-real-jinja-groupby-dictsort-0",
        family="py-real:pallets__jinja:groupby_dictsort",
        repo="pallets__jinja",
        source_file="src/jinja2/filters.py",
        source=jinja_groupby_src,
        entry="run",
        args=[
            [
                {"name": "ada", "dept": {"code": "eng"}, "score": 91.2},
                {"name": "Bob", "dept": {"code": "ENG"}, "score": 85.4},
            ],
            {"Beta": 12, "alpha": 30},
        ],
        features=["loop", "branch", "comprehension", "sorting", "jinja"],
    )

    jinja_wrap_src = jinja_shim + "\n" + _extract_symbols(
        jinja_filters,
        ["do_wordwrap", "do_truncate", "do_indent", "sync_do_slice", "do_batch", "_word_re", "do_wordcount", "do_title", "_word_beginning_split_re"],
        strip_decorators={"pass_environment", "pass_eval_context", "pass_context"},
    ) + """

def run(text, items, width):
    env = Environment()
    titled = do_title(text)
    wrapped = do_wordwrap(env, titled, width=width, break_on_hyphens=True)
    indented = do_indent(wrapped, width=2, first=True)
    trunc = do_truncate(env, titled, length=18, killwords=False, end="...", leeway=2)
    batched = list(do_batch(items, 3, fill_with="-"))
    sliced = list(sync_do_slice(items, 2, fill_with="PAD"))
    return {
        "words": do_wordcount(text),
        "indented": indented,
        "truncated": trunc,
        "batched": batched,
        "sliced": sliced,
    }
"""
    add_repo_task(
        task_id="py-real-jinja-wordwrap-batch-0",
        family="py-real:pallets__jinja:wordwrap_batch",
        repo="pallets__jinja",
        source_file="src/jinja2/filters.py",
        source=jinja_wrap_src,
        entry="run",
        args=["multi-line TEMPLATE engine wrap test", ["a", "b", "c", "d", "e"], 16],
        features=["loop", "branch", "regex", "textwrap", "jinja"],
    )

    jinja_urlize_src = jinja_shim + "\n" + _extract_symbols(
        jinja_utils,
        ["_http_re", "_email_re", "urlize", "url_quote"],
    ) + "\n\n" + _extract_symbols(
        jinja_filters,
        ["do_urlencode", "_attr_key_re", "do_xmlattr"],
        strip_decorators={"pass_environment", "pass_eval_context", "pass_context"},
    ) + """

def run(text, query_dict, attrs_ok, attrs_bad):
    env = Environment(autoescape=True)
    ctx = EvalContext(env, autoescape=True)
    linked = urlize(text, trim_url_limit=24, rel="noopener", target="_blank")
    qs = do_urlencode(query_dict)
    xml_ok = str(do_xmlattr(ctx, attrs_ok))
    err_msg = None
    try:
        do_xmlattr(ctx, attrs_bad)
    except ValueError as exc:
        err_msg = str(exc)
    return {"linked": linked, "qs": qs, "xml": xml_ok, "err": err_msg}
"""
    add_repo_task(
        task_id="py-real-jinja-urlize-xmlattr-0",
        family="py-real:pallets__jinja:urlize_xmlattr",
        repo="pallets__jinja",
        source_file="src/jinja2/utils.py+filters.py",
        source=jinja_urlize_src,
        entry="run",
        args=[
            "See https://a.co/x_(1)",
            {"q": "hi"},
            {"id": "box-1", "skip": None},
            {"bad=key": "1"},
        ],
        features=["loop", "branch", "exception", "regex", "url", "jinja"],
    )

    jinja_lru_src = jinja_shim + "\n" + _extract_symbols(
        jinja_utils,
        ["LRUCache", "Cycler", "Joiner"],
    ) + """

def run(ops):
    cache = LRUCache(3)
    cyc = Cycler("odd", "even")
    joiner = Joiner("|")
    log = []
    for op in ops:
        kind = op[0]
        if kind == "put":
            cache[op[1]] = op[2]
        elif kind == "get":
            val = cache.get(op[1], "MISS")
            log.append(f"{joiner()}{cyc.next()}:{op[1]}={val}")
        elif kind == "del" and op[1] in cache:
            del cache[op[1]]
    return {"items": list(cache.items()), "log": "".join(log)}
"""
    add_repo_task(
        task_id="py-real-jinja-lru-cycler-0",
        family="py-real:pallets__jinja:lru_cache",
        repo="pallets__jinja",
        source_file="src/jinja2/utils.py",
        source=jinja_lru_src,
        entry="run",
        args=[[("put", "a", 1), ("put", "b", 2), ("put", "c", 3), ("get", "a"), ("put", "d", 4), ("get", "b"), ("get", "a"), ("del", "c")]],
        features=["loop", "branch", "class", "cache", "jinja"],
    )

    jinja_filesize_src = jinja_shim + "\n" + _extract_symbols(
        jinja_filters,
        ["ignore_case", "_prepare_attribute_parts", "make_attrgetter", "make_multi_attrgetter", "do_filesizeformat", "do_int", "do_float", "do_sort", "sync_do_unique"],
        strip_decorators={"pass_environment", "pass_eval_context", "pass_context"},
    ) + """

def run(artifacts):
    env = Environment()
    parsed = []
    for item in artifacts:
        parsed.append({
            "name": item["name"],
            "tier": do_int(item["tier"], default=9),
            "bytes": do_int(item["bytes"], default=0),
            "ratio": do_float(item["ratio"], default=1.0),
        })
    ordered = do_sort(env, parsed, attribute="tier,bytes")
    uniq = list(sync_do_unique(env, ordered, case_sensitive=False, attribute="name"))
    return [
        (u["name"], u["tier"], do_filesizeformat(u["bytes"], binary=True))
        for u in uniq
    ]
"""
    add_repo_task(
        task_id="py-real-jinja-filesize-sort-unique-0",
        family="py-real:pallets__jinja:filesize_sort",
        repo="pallets__jinja",
        source_file="src/jinja2/filters.py",
        source=jinja_filesize_src,
        entry="run",
        args=[[
            {"name": "Alpha", "tier": "0x2", "bytes": "2048", "ratio": "0.5"},
            {"name": "alpha", "tier": "2", "bytes": "1536", "ratio": "bad"},
            {"name": "Beta", "tier": "bad", "bytes": "1500000", "ratio": "0.1"},
        ]],
        features=["loop", "branch", "exception", "sorting", "jinja"],
    )

    jinja_lexer_syms = [
        "whitespace_re", "newline_re", "integer_re", "float_re",
        "TOKEN_ADD", "TOKEN_ASSIGN", "TOKEN_COLON", "TOKEN_COMMA", "TOKEN_DIV",
        "TOKEN_DOT", "TOKEN_EQ", "TOKEN_FLOORDIV", "TOKEN_GT", "TOKEN_GTEQ",
        "TOKEN_LBRACE", "TOKEN_LBRACKET", "TOKEN_LPAREN", "TOKEN_LT", "TOKEN_LTEQ",
        "TOKEN_MOD", "TOKEN_MUL", "TOKEN_NE", "TOKEN_PIPE", "TOKEN_POW",
        "TOKEN_RBRACE", "TOKEN_RBRACKET", "TOKEN_RPAREN", "TOKEN_SEMICOLON",
        "TOKEN_SUB", "TOKEN_TILDE", "TOKEN_WHITESPACE", "TOKEN_FLOAT", "TOKEN_INTEGER",
        "TOKEN_NAME", "TOKEN_STRING", "TOKEN_OPERATOR", "TOKEN_BLOCK_BEGIN", "TOKEN_BLOCK_END",
        "TOKEN_VARIABLE_BEGIN", "TOKEN_VARIABLE_END", "TOKEN_COMMENT_BEGIN", "TOKEN_COMMENT_END",
        "TOKEN_COMMENT", "TOKEN_LINESTATEMENT_BEGIN", "TOKEN_LINESTATEMENT_END",
        "TOKEN_LINECOMMENT_BEGIN", "TOKEN_LINECOMMENT_END", "TOKEN_LINECOMMENT",
        "TOKEN_DATA", "TOKEN_INITIAL", "TOKEN_EOF",
        "operators", "reverse_operators", "operator_re",
        "_describe_token_type", "describe_token_expr", "count_newlines",
    ]
    jinja_lexer_src = "\n".join([
        "from ast import literal_eval",
        "import re",
        "from sys import intern",
        _extract_symbols(jinja_lexer, jinja_lexer_syms),
    ]) + """

def run(expr_src):
    pos = 0
    tokens = []
    stack = []
    pairs = {"(": ")", "[": "]", "{": "}"}
    while pos < len(expr_src):
        m_ws = whitespace_re.match(expr_src, pos)
        if m_ws:
            pos = m_ws.end()
            continue
        m_fl = float_re.match(expr_src, pos)
        if m_fl:
            tokens.append((TOKEN_FLOAT, literal_eval(m_fl.group().replace("_", ""))))
            pos = m_fl.end()
            continue
        m_int = integer_re.match(expr_src, pos)
        if m_int:
            tokens.append((TOKEN_INTEGER, int(m_int.group().replace("_", ""), 0)))
            pos = m_int.end()
            continue
        m_op = operator_re.match(expr_src, pos)
        if m_op:
            op = m_op.group()
            tok = operators[op]
            if op in pairs:
                stack.append(pairs[op])
            elif op in (")", "]", "}"):
                if not stack or stack.pop() != op:
                    return {"error": f"unbalanced {op}", "tokens": tokens}
            tokens.append((tok, describe_token_expr(tok)))
            pos = m_op.end()
            continue
        m_id = re.match(r"[A-Za-z_][A-Za-z0-9_]*", expr_src[pos:])
        if m_id:
            tokens.append((TOKEN_NAME, m_id.group()))
            pos += len(m_id.group())
            continue
        tokens.append(("unknown", expr_src[pos]))
        pos += 1
    return {"tokens": tokens, "balanced": len(stack) == 0, "newlines": count_newlines(expr_src)}
"""
    add_repo_task(
        task_id="py-real-jinja-lexer-expr-0",
        family="py-real:pallets__jinja:lexer_expr",
        repo="pallets__jinja",
        source_file="src/jinja2/lexer.py",
        source=jinja_lexer_src,
        entry="run",
        args=["(score + 0x1_a) >= 2.5e1 and items[0]"],
        features=["loop", "branch", "regex", "lexer", "jinja"],
    )

    # =========================================================================
    # 3. simplejson__simplejson (5 tasks: encoder, HTML encoder, decoder, errors, effectful)
    # =========================================================================
    sj_compat = dgx1 / "simplejson__simplejson/simplejson/compat.py"
    sj_errors = dgx1 / "simplejson__simplejson/simplejson/errors.py"
    sj_raw = dgx1 / "simplejson__simplejson/simplejson/raw_json.py"
    sj_scanner = dgx1 / "simplejson__simplejson/simplejson/scanner.py"
    sj_decoder = dgx1 / "simplejson__simplejson/simplejson/decoder.py"
    sj_encoder = dgx1 / "simplejson__simplejson/simplejson/encoder.py"

    sj_shared_header = "\n".join([
        "import decimal",
        "import re",
        "from operator import itemgetter",
        "PY3 = True",
        "text_type = str",
        "binary_type = bytes",
        "string_types = (str,)",
        "integer_types = (int,)",
        "unichr = chr",
        "c_encode_basestring_ascii = None",
        "c_make_encoder = None",
        "c_scanstring = None",
        "c_make_scanner = None",
        "NaN, PosInf, NegInf = float('nan'), float('inf'), float('-inf')",
        "_CONSTANTS = {'-Infinity': NegInf, 'Infinity': PosInf, 'NaN': NaN}",
        "bounded_int = int",
        "DEFAULT_ENCODING = 'utf-8'",
    ])
    sj_errors_src = _extract_symbols(sj_errors, ["linecol", "errmsg", "JSONDecodeError"])
    sj_raw_src = _extract_symbols(sj_raw, ["RawJSON"])
    sj_decode_only = "\n\n".join([
        sj_shared_header,
        sj_errors_src,
        _extract_symbols(sj_scanner, ["NUMBER_RE", "py_make_scanner"]),
        "make_scanner = py_make_scanner",
        _extract_symbols(sj_decoder, ["FLAGS", "STRINGCHUNK", "BACKSLASH", "scan_four_digit_hex", "py_scanstring"]),
        "scanstring = py_scanstring",
        _extract_symbols(sj_decoder, ["WHITESPACE", "WHITESPACE_STR", "JSONObject", "JSONArray", "JSONDecoder"]),
    ]).replace("_maxunicode=sys.maxunicode", "_maxunicode=0x10FFFF")

    def _deterministic_markers(src: str) -> str:
        # Map simplejson circular markers via object identity without ever touching raw ASLR id() ints
        src = src.replace(
            "    if _use_decimal and Decimal is None:",
            "    _seen_objs = []\n    def _det_id(obj):\n        for idx, item in enumerate(_seen_objs):\n            if item is obj:\n                return idx + 1\n        _seen_objs.append(obj)\n        return len(_seen_objs)\n    if _use_decimal and Decimal is None:",
        )
        return src.replace("markerid = id(", "markerid = _det_id(")

    sj_encode_only = _deterministic_markers("\n\n".join([
        sj_shared_header,
        sj_raw_src,
        _extract_symbols(sj_encoder, ["ESCAPE", "ESCAPE_ASCII", "ESCAPE_DCT", "FLOAT_REPR", "encode_basestring", "py_encode_basestring_ascii"]),
        "encode_basestring_ascii = py_encode_basestring_ascii",
        _extract_symbols(sj_encoder, ["JSONEncoder", "JSONEncoderForHTML", "_make_iterencode"]),
    ]))

    def _compact_docstrings(src: str) -> str:
        # Remove multi-line triple-quoted docstrings & comment lines when combining both encoder+decoder
        out = re.sub(r'\n([ \t]*)("""|\'\'\')[\s\S]*?\2', "", src)
        return "\n".join(ln for ln in out.splitlines() if not ln.lstrip().startswith("#"))

    sj_both_compact = _deterministic_markers(_compact_docstrings(
        sj_decode_only
        + "\n\n"
        + sj_raw_src
        + "\n\n"
        + _extract_symbols(sj_encoder, ["ESCAPE", "ESCAPE_ASCII", "ESCAPE_DCT", "FLOAT_REPR", "encode_basestring", "py_encode_basestring_ascii"])
        + "\nencode_basestring_ascii = py_encode_basestring_ascii\n\n"
        + _extract_symbols(sj_encoder, ["JSONEncoder", "JSONEncoderForHTML", "_make_iterencode"])
    ))

    sj_encode_src = sj_encode_only + """

def run(items):
    enc = JSONEncoder(ensure_ascii=True, sort_keys=True, bigint_as_string=True, allow_nan=False)
    res_ok = enc.encode(items)
    cyc = [1]
    cyc.append(cyc)
    circ_err = None
    try:
        enc.encode(cyc)
    except ValueError as exc:
        circ_err = str(exc)
    return {"encoded": res_ok, "circ_err": circ_err}
"""
    add_repo_task(
        task_id="py-real-simplejson-encode-circular-0",
        family="py-real:simplejson__simplejson:encoder_edges",
        repo="simplejson__simplejson",
        source_file="simplejson/encoder.py",
        source=sj_encode_src,
        entry="run",
        args=[{"s": "\u2603", "n": 9007199254740993}],
        features=["loop", "branch", "exception", "class", "json", "unicode"],
    )

    sj_html_src = sj_encode_only + """

def run(payload):
    enc_html = JSONEncoderForHTML(ensure_ascii=False, ignore_nan=True, sort_keys=True)
    html_obj = {"r": RawJSON('{"k":1}'), "d": ["<&>" + chr(0x2028), payload]}
    return {"html_safe": enc_html.encode(html_obj)}
"""
    add_repo_task(
        task_id="py-real-simplejson-html-nan-0",
        family="py-real:simplejson__simplejson:html_encoder",
        repo="simplejson__simplejson",
        source_file="simplejson/encoder.py",
        source=sj_html_src,
        entry="run",
        args=[float("nan")],
        features=["loop", "branch", "class", "json", "unicode"],
    )

    sj_decode_src = sj_decode_only + """

def run(raw_json):
    dec = JSONDecoder(allow_nan=True, parse_float=lambda s: round(float(s), 4), object_pairs_hook=lambda pairs: [(k.upper(), v) for k, v in pairs])
    parsed = dec.decode(raw_json)
    return parsed
"""
    add_repo_task(
        task_id="py-real-simplejson-decode-surrogate-0",
        family="py-real:simplejson__simplejson:decoder_surrogates",
        repo="simplejson__simplejson",
        source_file="simplejson/decoder.py+scanner.py",
        source=sj_decode_src,
        entry="run",
        args=[r'{"e": "\ud83d\ude80", "n": [NaN, -Infinity]}'],
        features=["loop", "branch", "class", "json", "unicode"],
    )

    sj_stream_err_src = sj_decode_only + """

def run(stream_text):
    dec = JSONDecoder(strict=True)
    idx = 0
    objs = []
    errors = []
    n = len(stream_text)
    while idx < n:
        idx = WHITESPACE.match(stream_text, idx).end()
        if idx >= n:
            break
        try:
            obj, idx = dec.raw_decode(stream_text, idx)
            objs.append(obj)
        except JSONDecodeError as exc:
            errors.append({"msg": exc.msg, "line": exc.lineno, "col": exc.colno})
            nl = stream_text.find("\\n", idx)
            idx = n if nl < 0 else nl + 1
    return {"objs": objs, "errors": errors}
"""
    add_repo_task(
        task_id="py-real-simplejson-raw-decode-stream-0",
        family="py-real:simplejson__simplejson:stream_recovery",
        repo="simplejson__simplejson",
        source_file="simplejson/decoder.py+errors.py",
        source=sj_stream_err_src,
        entry="run",
        args=['{"a":1}\n{bad}\n'],
        features=["loop", "branch", "exception", "class", "json"],
    )

    sj_effectful_src = sj_both_compact + """

def run(in_path, out_path):
    raw = host.fs_read_text(in_path)
    dec = JSONDecoder(strict=True)
    enc = JSONEncoderForHTML(sort_keys=True, ignore_nan=True)
    idx = 0
    good = []
    bad_count = 0
    while idx < len(raw):
        idx = WHITESPACE.match(raw, idx).end()
        if idx >= len(raw):
            break
        try:
            obj, idx = dec.raw_decode(raw, idx)
            good.append(obj)
        except JSONDecodeError as exc:
            bad_count += 1
            print("decode-error", exc.lineno, exc.colno)
            nl = raw.find("\\n", idx)
            idx = len(raw) if nl < 0 else nl + 1
    print("parsed", len(good), bad_count)
    out_text = enc.encode([bad_count, good])
    host.fs_write_text(out_path, out_text)
    return {"count": len(good), "errors": bad_count}
"""
    add_repo_task(
        task_id="py-real-simplejson-effectful-stream-0",
        family="py-real:simplejson__simplejson:effectful_stream",
        repo="simplejson__simplejson",
        source_file="simplejson/decoder.py+encoder.py",
        source=sj_effectful_src,
        entry="run",
        args=["/var/log/events.ndjson", "/var/log/clean.json"],
        features=["loop", "branch", "exception", "class", "json", "hard-effectful", "fs"],
        scripted_calls={
            "fs.readText": [{"status": "fulfilled", "result": '[1]\n{bad\n'}],
            "fs.writeText": [{"status": "fulfilled", "result": None}],
        },
    )

    # =========================================================================
    # 4. seatgeek__fuzzywuzzy (5 tasks: ratios, dedupe/extract, partial edge, 2 effectful)
    # =========================================================================
    fw_sp = dgx1 / "seatgeek__fuzzywuzzy/fuzzywuzzy/string_processing.py"
    fw_utils = dgx1 / "seatgeek__fuzzywuzzy/fuzzywuzzy/utils.py"
    fw_fuzz = dgx1 / "seatgeek__fuzzywuzzy/fuzzywuzzy/fuzz.py"
    fw_proc = dgx1 / "seatgeek__fuzzywuzzy/fuzzywuzzy/process.py"

    fw_base = "\n\n".join([
        "from difflib import SequenceMatcher",
        "import functools",
        "from functools import partial",
        "import heapq",
        "import re",
        "from types import SimpleNamespace",
        "PY3 = True",
        "string = str",
        "unicode = str",
        _extract_symbols(fw_sp, ["StringProcessor"]),
        _extract_symbols(
            fw_utils,
            [
                "validate_string", "check_for_equivalence", "check_for_none", "check_empty_string",
                "bad_chars", "asciionly", "asciidammit", "make_type_consistent",
                "full_process", "intr",
            ],
        ),
        "translation_table = dict((ord(c), None) for c in bad_chars)",
        """class _NoopLog:
    @staticmethod
    def warning(msg): pass
logging = _NoopLog()
utils = SimpleNamespace(
    validate_string=validate_string,
    check_for_equivalence=check_for_equivalence,
    check_for_none=check_for_none,
    check_empty_string=check_empty_string,
    asciionly=asciionly,
    asciidammit=asciidammit,
    make_type_consistent=make_type_consistent,
    full_process=full_process,
    intr=intr,
)""",
        _extract_symbols(
            fw_fuzz,
            [
                "ratio", "partial_ratio", "_process_and_sort", "_token_sort",
                "token_sort_ratio", "partial_token_sort_ratio", "_token_set",
                "token_set_ratio", "partial_token_set_ratio", "QRatio", "UQRatio",
                "WRatio", "UWRatio",
            ],
        ),
        """fuzz = SimpleNamespace(
    ratio=ratio,
    partial_ratio=partial_ratio,
    token_sort_ratio=token_sort_ratio,
    partial_token_sort_ratio=partial_token_sort_ratio,
    token_set_ratio=token_set_ratio,
    partial_token_set_ratio=partial_token_set_ratio,
    QRatio=QRatio,
    UQRatio=UQRatio,
    WRatio=WRatio,
    UWRatio=UWRatio,
)
default_scorer = fuzz.WRatio
default_processor = utils.full_process""",
        _extract_symbols(fw_proc, ["extractWithoutOrder", "extract", "extractBests", "extractOne", "dedupe"]),
    ])

    fw_ratios_src = fw_base + """

def run(pairs):
    results = []
    for a, b in pairs:
        results.append({
            "partial": partial_ratio(a, b),
            "token_sort": token_sort_ratio(a, b),
            "wratio": WRatio(a, b),
        })
    return results
"""
    add_repo_task(
        task_id="py-real-fuzzywuzzy-ratios-0",
        family="py-real:seatgeek__fuzzywuzzy:ratios",
        repo="seatgeek__fuzzywuzzy",
        source_file="fuzzywuzzy/fuzz.py+utils.py",
        source=fw_ratios_src,
        entry="run",
        args=[[("New York Mets!", "Mets, New York")]],
        features=["loop", "branch", "fuzzy"],
    )

    fw_dedupe_src = fw_base + """

def run(items, query, choices_dict):
    deduped = list(dedupe(items, threshold=70, scorer=fuzz.ratio))
    top = extractOne(query, choices_dict, scorer=fuzz.ratio)
    return {"deduped": deduped, "top": top}
"""
    add_repo_task(
        task_id="py-real-fuzzywuzzy-dedupe-extract-0",
        family="py-real:seatgeek__fuzzywuzzy:dedupe_extract",
        repo="seatgeek__fuzzywuzzy",
        source_file="fuzzywuzzy/process.py",
        source=fw_dedupe_src,
        entry="run",
        args=[
            ["Frodo B.", "Frodo Baggins"],
            "frodo",
            {"k1": "Frodo B.", "k2": "Sam"},
        ],
        features=["loop", "branch", "sorting", "fuzzy"],
    )

    # Effectful fuzzywuzzy #1: fetch items via http.get, match, print low confidence, kv_set
    fw_eff_http_src = fw_base + """
import json

def run(url, catalog, kv_prefix):
    raw = host.http_get(url)
    queries = json.loads(raw)
    matched = {}
    for q in queries:
        hit = extractOne(q, catalog, scorer=fuzz.ratio, score_cutoff=55)
        if hit is None:
            print("no-match", q)
            matched[q] = None
        else:
            print("matched", q, hit[0], hit[1])
            matched[q] = hit[0]
            host.kv_set(f"{kv_prefix}:{q}", {"target": hit[0], "score": hit[1]})
    return matched
"""
    add_repo_task(
        task_id="py-real-fuzzywuzzy-effectful-catalog-0",
        family="py-real:seatgeek__fuzzywuzzy:effectful_catalog",
        repo="seatgeek__fuzzywuzzy",
        source_file="fuzzywuzzy/process.py",
        source=fw_eff_http_src,
        entry="run",
        args=[
            "https://api.local/queries.json",
            ["MacBook Pro", "ThinkPad X1"],
            "sku",
        ],
        features=["loop", "branch", "fuzzy", "hard-effectful", "http", "kv"],
        scripted_calls={
            "http.get": [{"status": "fulfilled", "result": '["macbook pro", "unknown tablet"]'}],
            "kv_set": [{"status": "fulfilled", "result": True}],
        },
    )

    # Effectful fuzzywuzzy #2: fs_read_text -> dedupe -> time.time -> print -> kv_set
    fw_eff_fs_src = fw_base + """
import time

def run(path, threshold):
    t0 = time.time()
    raw = host.fs_read_text(path)
    lines = [ln.strip() for ln in raw.splitlines() if ln.strip()]
    canon = list(dedupe(lines, threshold=threshold, scorer=fuzz.ratio))
    elapsed = round(time.time() - t0, 3)
    print("deduped", len(lines), len(canon))
    host.kv_set("vendors:canonical", canon)
    return {"canonical": canon, "elapsed": elapsed}
"""
    add_repo_task(
        task_id="py-real-fuzzywuzzy-effectful-dedupe-0",
        family="py-real:seatgeek__fuzzywuzzy:effectful_dedupe",
        repo="seatgeek__fuzzywuzzy",
        source_file="fuzzywuzzy/process.py",
        source=fw_eff_fs_src,
        entry="run",
        args=["/etc/vendors.txt", 70],
        features=["loop", "branch", "fuzzy", "hard-effectful", "fs", "kv", "platform"],
        scripted_times=[1700002000.0, 1700002000.125],
        scripted_calls={
            "fs.readText": [{"status": "fulfilled", "result": "Acme Co\nAcme Corp\nBeta\n"}],
            "kv_set": [{"status": "fulfilled", "result": True}],
        },
    )

    # =========================================================================
    # 5. x-hw__amazing-qr (3 tasks: GF(256) Reed-Solomon ECC, mode encoding, interleave)
    # =========================================================================
    qr_const = dgx2 / "x-hw__amazing-qr/amzqr/mylibs/constant.py"
    qr_ecc = dgx2 / "x-hw__amazing-qr/amzqr/mylibs/ECC.py"
    qr_data = dgx2 / "x-hw__amazing-qr/amzqr/mylibs/data.py"
    qr_struct = dgx2 / "x-hw__amazing-qr/amzqr/mylibs/structure.py"

    qr_const_src = _extract_symbols(
        qr_const,
        [
            "char_cap", "mindex", "required_bytes", "num_list", "alphanum_list",
            "grouping_list", "mode_indicator", "GP_list", "ecc_num_per_block",
            "po2", "log", "lindex", "required_remainder_bits",
        ],
    )

    qr_ecc_src = qr_const_src + "\n\n" + _extract_symbols(
        qr_ecc, ["encode", "get_ecc", "divide", "XOR"]
    ) + """

def run(dc, ecc_num):
    return get_ecc(dc, ecc_num)
"""
    add_repo_task(
        task_id="py-real-amazingqr-gf256-ecc-0",
        family="py-real:x-hw__amazing-qr:gf256_ecc",
        repo="x-hw__amazing-qr",
        source_file="amzqr/mylibs/ECC.py",
        source=qr_ecc_src,
        entry="run",
        args=[[16, 32, 12], 7],
        features=["loop", "branch", "bitwise", "math", "qr"],
    )

    # Remove debug print in data.py:encode for pure task
    qr_data_extracted = _extract_symbols(
        qr_data,
        ["encode", "analyse", "numeric_encoding", "alphanumeric_encoding", "byte_encoding", "kanji_encoding", "get_cci"],
    ).replace("print('line 16: mode:', mode)", "pass")
    qr_data_src = qr_const_src + "\n\n" + qr_data_extracted + """

def run(num_text):
    v1, cw1 = encode(1, "M", num_text)
    bits_b = byte_encoding("hi")
    return {"ver": v1, "head": cw1[0][:8], "byte": bits_b}
"""
    add_repo_task(
        task_id="py-real-amazingqr-data-encode-0",
        family="py-real:x-hw__amazing-qr:data_encoding",
        repo="x-hw__amazing-qr",
        source_file="amzqr/mylibs/data.py",
        source=qr_data_src,
        entry="run",
        args=["8675"],
        features=["loop", "branch", "binary", "qr"],
    )

    qr_pipe_src = (
        qr_const_src
        + "\n\n"
        + _extract_symbols(qr_ecc, ["encode", "get_ecc", "divide", "XOR"]).replace("def encode(", "def ecc_encode(")
        + "\n\n"
        + _extract_symbols(qr_struct, ["structure_final_bits", "interleave_dc", "interleave_ecc"])
        + """

def run(ver, ecl, blocks):
    ecc = [get_ecc(b, 7) for b in blocks]
    bits = structure_final_bits(ver, ecl, blocks, ecc)
    return {"ver": ver, "bit_len": len(bits), "head": bits[:32], "ecc": ecc}
"""
    )
    add_repo_task(
        task_id="py-real-amazingqr-structure-interleave-0",
        family="py-real:x-hw__amazing-qr:structure_interleave",
        repo="x-hw__amazing-qr",
        source_file="amzqr/mylibs/structure.py+ECC.py",
        source=qr_pipe_src,
        entry="run",
        args=[1, "L", [[16], [32]]],
        features=["loop", "branch", "bitwise", "qr"],
    )

    # =========================================================================
    # 6. s0md3v__XSStrike & s0md3v__Photon (4 tasks)
    # =========================================================================
    xss_cfg = dgx2 / "s0md3v__XSStrike/core/config.py"
    xss_utils = dgx2 / "s0md3v__XSStrike/core/utils.py"
    xss_html = dgx2 / "s0md3v__XSStrike/core/htmlParser.py"
    xss_js = dgx2 / "s0md3v__XSStrike/core/jsContexter.py"
    xss_zet = dgx2 / "s0md3v__XSStrike/core/zetanize.py"

    xss_html_src = "\n\n".join([
        "import re",
        _extract_symbols(xss_cfg, ["badTags", "xsschecker"]),
        _extract_symbols(xss_utils, ["isBadContext", "equalize", "escaped", "extractScripts"]),
        _extract_symbols(xss_html, ["htmlParser"]),
        """class _Resp:
    def __init__(self, text):
        self.text = text

def run(html_doc):
    return htmlParser(_Resp(html_doc), None)
""",
    ])
    add_repo_task(
        task_id="py-real-xsstrike-html-parser-0",
        family="py-real:s0md3v__XSStrike:html_parser",
        repo="s0md3v__XSStrike",
        source_file="core/htmlParser.py+utils.py",
        source=xss_html_src,
        entry="run",
        args=['<script>var q="v3dm0s";</script><input name="q" value="v3dm0s"><textarea>v3dm0s</textarea><!-- v3dm0s -->'],
        features=["loop", "branch", "regex", "html", "security"],
    )

    xss_js_zet_src = "\n\n".join([
        "import re",
        _extract_symbols(xss_cfg, ["xsschecker"]),
        _extract_symbols(xss_utils, ["stripper", "fillHoles", "closest", "replaceValue"]),
        _extract_symbols(xss_js, ["jsContexter"]),
        _extract_symbols(xss_zet, ["zetanize"]),
        """
def run(script_snippet, html_forms, orig_seq, new_seq):
    breaker = jsContexter(script_snippet)
    forms = zetanize(html_forms)
    holes = fillHoles(orig_seq, new_seq)
    return {"breaker": breaker, "forms": forms, "holes": holes}
""",
    ])
    add_repo_task(
        task_id="py-real-xsstrike-jscontexter-zetanize-0",
        family="py-real:s0md3v__XSStrike:jscontexter_zetanize",
        repo="s0md3v__XSStrike",
        source_file="core/jsContexter.py+zetanize.py",
        source=xss_js_zet_src,
        entry="run",
        args=[
            'if(ok){fn("done",v3dm0s);}',
            '<!-- old --><form action="/login" method="POST"><input name="user" type="text"><input name="go" type="submit"></form>',
            ["1", "4", "5"],
            [1, 2, 3],
        ],
        features=["loop", "branch", "regex", "html", "security"],
    )

    ph_cfg = dgx2 / "s0md3v__Photon/core/config.py"
    ph_regex = dgx2 / "s0md3v__Photon/core/regex.py"
    ph_utils = dgx2 / "s0md3v__Photon/core/utils.py"

    ph_ioc_src = "\n\n".join([
        "import re",
        "from urllib.parse import urlparse",
        _extract_symbols(ph_cfg, ["VERBOSE", "BAD_TYPES"]),
        _extract_symbols(ph_regex, [
            "END_PUNCTUATION", "SEPARATOR_DEFANGS", "GENERIC_URL", "BRACKET_URL",
            "IPV4", "EMAIL", "SHA256", "CREDIT_CARD",
        ]),
        _extract_symbols(ph_utils, ["luhn", "extract_headers"]),
        """
def run(log_text, raw_headers, cards):
    urls = GENERIC_URL.findall(log_text)
    bracketed = BRACKET_URL.findall(log_text)
    ips = IPV4.findall(log_text)
    emails = EMAIL.findall(log_text)
    cards_ok = {c: luhn(c.replace("-", "").replace(" ", "")) for c in cards}
    hdrs = extract_headers(raw_headers)
    return {"urls": urls, "bracketed": bracketed, "ips": ips, "emails": emails, "cards": cards_ok, "headers": hdrs}
""",
    ])
    add_repo_task(
        task_id="py-real-photon-ioc-luhn-0",
        family="py-real:s0md3v__Photon:ioc_luhn",
        repo="s0md3v__Photon",
        source_file="core/regex.py+utils.py",
        source=ph_ioc_src,
        entry="run",
        args=[
            "visit hxxps://evil[.]example.com/p and 192[.]168.1.5 by ops(at)corp[.]org.",
            "Host: example.com\nX-Forwarded-For: 10.0.0.1,",
            ["4532015112830366", "4532015112830367", "bad-card"],
        ],
        features=["loop", "branch", "exception", "regex", "security"],
    )

    ph_crawl_src = "\n\n".join([
        "import re",
        "from urllib.parse import urlparse",
        _extract_symbols(ph_cfg, ["VERBOSE", "BAD_TYPES"]),
        _extract_symbols(ph_utils, ["is_link", "remove_regex", "xml_parser", "timer"]),
        _extract_symbols(xss_utils, ["handle_anchor"]),
        """
def run(parent_url, sitemap_xml, extra_links, processed, deny_regex):
    files = set()
    urls = xml_parser(sitemap_xml) + extra_links
    filtered = remove_regex(urls, deny_regex)
    accepted = []
    for raw in filtered:
        norm = handle_anchor(parent_url, raw)
        if is_link(norm, processed, files):
            accepted.append(norm)
            processed.append(norm)
    return {"accepted": accepted, "files": files, "timing": timer(135.0, accepted)}
""",
    ])
    add_repo_task(
        task_id="py-real-photon-crawl-filter-0",
        family="py-real:s0md3v__Photon:crawl_filter",
        repo="s0md3v__Photon",
        source_file="core/utils.py",
        source=ph_crawl_src,
        entry="run",
        args=[
            "https://example.org/docs/index.html",
            "<urlset><loc>/guide</loc><loc>//cdn.example.org/app.js</loc><loc>/admin/secret</loc></urlset>",
            ["#top", "report.pdf", "api/v1"],
            [],
            r"/admin/",
        ],
        features=["loop", "branch", "regex", "url", "set"],
    )

    # =========================================================================
    # 7. mail-in-a-box__mailinabox (3 tasks: domain/email sort, DNS validation, mailconfig)
    # =========================================================================
    miab_utils = dgx2 / "mail-in-a-box__mailinabox/management/utils.py"
    miab_dns = dgx2 / "mail-in-a-box__mailinabox/management/dns_update.py"
    miab_mail = dgx2 / "mail-in-a-box__mailinabox/management/mailconfig.py"

    miab_sort_extracted = _extract_symbols(miab_utils, ["safe_domain_name", "sort_domains", "sort_email_addresses"])
    miab_sort_extracted = miab_sort_extracted.replace(
        """def sort_email_addresses(email_addresses, env):
    email_addresses = set(email_addresses)
    domains = {email.split("@", 1)[1] for email in email_addresses if "@" in email}
    ret = []
    for domain in sort_domains(domains, env):
        domain_emails = {email for email in email_addresses if email.endswith("@" + domain)}
        ret.extend(sorted(domain_emails))
        email_addresses -= domain_emails
    ret.extend(sorted(email_addresses)) # whatever is left
    return ret""",
        """def sort_email_addresses(email_addresses, env):
    email_addresses = sorted(set(email_addresses))
    domains = sorted({email.split("@", 1)[1] for email in email_addresses if "@" in email})
    ret = []
    for domain in sort_domains(domains, env):
        domain_emails = [email for email in email_addresses if email.endswith("@" + domain)]
        ret.extend(domain_emails)
        email_addresses = [e for e in email_addresses if e not in domain_emails]
    ret.extend(email_addresses) # whatever is left
    return ret""",
    )
    miab_sort_src = "\n\n".join([
        miab_sort_extracted,
        """
def run(domains, emails, primary):
    env = {"PRIMARY_HOSTNAME": primary}
    sorted_doms = sort_domains(domains, env)
    sorted_mails = sort_email_addresses(emails, env)
    safe_names = [safe_domain_name(d) for d in sorted_doms]
    return {"domains": sorted_doms, "emails": sorted_mails, "safe": safe_names}
""",
    ])
    add_repo_task(
        task_id="py-real-mailinabox-sort-domains-0",
        family="py-real:mail-in-a-box__mailinabox:sort_domains",
        repo="mail-in-a-box__mailinabox",
        source_file="management/utils.py",
        source=miab_sort_src,
        entry="run",
        args=[
            ["api.example.org", "box.mail.net", "mail.net", "www.box.mail.net", "example.org"],
            ["z@example.org", "a@box.mail.net", "b@mail.net", "plain"],
            "box.mail.net",
        ],
        features=["loop", "branch", "sorting", "dns"],
    )

    miab_dns_src = "\n\n".join([
        "import ipaddress",
        "import re",
        _replace_leading_indent(_extract_symbols(miab_dns, ["DOMAIN_RE", "filter_custom_records"]), "\t", "    "),
        """
def validate_and_apply(domain, custom_records, updates):
    filtered = list(filter_custom_records(domain, custom_records))
    accepted = []
    errors = []
    for qname, rtype, val in updates:
        try:
            if not re.search(DOMAIN_RE, qname):
                raise ValueError(f"invalid qname: {qname}")
            if rtype in {"A", "AAAA"}:
                if val != "local":
                    ip = ipaddress.ip_address(val)
                    if rtype == "A" and not isinstance(ip, ipaddress.IPv4Address):
                        raise ValueError("not IPv4")
                    if rtype == "AAAA" and not isinstance(ip, ipaddress.IPv6Address):
                        raise ValueError("not IPv6")
            accepted.append((qname, rtype, val))
        except ValueError as exc:
            errors.append((qname, str(exc)))
    return {"existing": filtered, "accepted": accepted, "errors": errors}

def run(domain, custom_records, updates):
    return validate_and_apply(domain, custom_records, updates)
""",
    ])
    add_repo_task(
        task_id="py-real-mailinabox-dns-filter-validate-0",
        family="py-real:mail-in-a-box__mailinabox:dns_validate",
        repo="mail-in-a-box__mailinabox",
        source_file="management/dns_update.py",
        source=miab_dns_src,
        entry="run",
        args=[
            "example.org",
            [("example.org", "A", "192.0.2.1"), ("sub.example.org", "TXT", "v=spf1 -all"), ("other.net", "A", "198.51.100.2")],
            [("www.example.org", "A", "192.0.2.9"), ("v6.example.org", "AAAA", "192.0.2.9"), ("bad..name", "TXT", "x")],
        ],
        features=["loop", "branch", "exception", "regex", "dns"],
    )

    miab_mail_src = "\n\n".join([
        _replace_leading_indent(_extract_symbols(miab_mail, ["is_dcv_address", "sizeof_fmt"]), "\t", "    "),
        """
def run(emails, sizes):
    dcv = {e: is_dcv_address(e) for e in emails}
    fmt = [sizeof_fmt(s) for s in sizes]
    return {"dcv": dcv, "sizes": fmt}
""",
    ])
    add_repo_task(
        task_id="py-real-mailinabox-dcv-sizeof-0",
        family="py-real:mail-in-a-box__mailinabox:dcv_sizeof",
        repo="mail-in-a-box__mailinabox",
        source_file="management/mailconfig.py",
        source=miab_mail_src,
        entry="run",
        args=[
            ["Postmaster@Example.org", "admin+test@a.com", "alice@example.org"],
            [512, 1536, 10485760],
        ],
        features=["loop", "branch", "formatting"],
    )

    # =========================================================================
    # 8. joelgrus__data-science-from-scratch (4 tasks: ID3 tree, shortest paths, clustering, pagerank)
    # =========================================================================
    ds_la = dgx2 / "joelgrus__data-science-from-scratch/scratch/linear_algebra.py"
    ds_dt = dgx2 / "joelgrus__data-science-from-scratch/scratch/decision_trees.py"
    ds_net = dgx2 / "joelgrus__data-science-from-scratch/scratch/network_analysis.py"
    ds_cl = dgx2 / "joelgrus__data-science-from-scratch/scratch/clustering.py"

    ds_dt_src = "\n\n".join([
        "from collections import Counter, defaultdict",
        "import math",
        "from typing import Any, Dict, List, NamedTuple, Optional, TypeVar, Union",
        _extract_symbols(ds_dt, [
            "entropy", "class_probabilities", "data_entropy", "partition_entropy",
            "Candidate", "T", "partition_by", "partition_entropy_by",
            "Leaf", "Split", "DecisionTree", "classify", "build_tree_id3",
        ]),
        """
def run(rows, queries):
    dataset = [Candidate(*r) for r in rows]
    tree = build_tree_id3(dataset, ["level", "lang"], "did_well")
    preds = [classify(tree, Candidate(*q)) for q in queries]
    return {"preds": preds, "root_attr": tree.attribute if isinstance(tree, Split) else None}
""",
    ])
    add_repo_task(
        task_id="py-real-dsfs-id3-tree-0",
        family="py-real:joelgrus__data-science-from-scratch:id3_tree",
        repo="joelgrus__data-science-from-scratch",
        source_file="scratch/decision_trees.py",
        source=ds_dt_src,
        entry="run",
        args=[
            [
                ("Senior", "Java", False, False, False),
                ("Mid", "Python", False, False, True),
                ("Senior", "Python", False, False, True),
            ],
            [
                ("Senior", "Python", True, False),
                ("Intern", "Python", False, False),
            ],
        ],
        features=["loop", "branch", "recursion", "tree", "ml"],
    )

    ds_sp_src = "\n\n".join([
        "from collections import deque",
        "from typing import Dict, List",
        "Friendships = Dict[int, List[int]]",
        "Path = List[int]",
        _extract_symbols(ds_net, ["shortest_paths_from"]),
        """
def run(edges, num_nodes):
    friendships = {i: [] for i in range(num_nodes)}
    for u, v in edges:
        friendships[u].append(v)
        friendships[v].append(u)
    p0 = shortest_paths_from(0, friendships)
    p1 = shortest_paths_from(1, friendships)
    return {"from0_3": p0.get(3, []), "from1_2": p1.get(2, [])}
""",
    ])
    add_repo_task(
        task_id="py-real-dsfs-shortest-paths-0",
        family="py-real:joelgrus__data-science-from-scratch:shortest_paths",
        repo="joelgrus__data-science-from-scratch",
        source_file="scratch/network_analysis.py",
        source=ds_sp_src,
        entry="run",
        args=[[(0, 1), (0, 2), (1, 3), (2, 3)], 4],
        features=["loop", "branch", "graph", "bfs"],
    )

    ds_cl_src = "\n\n".join([
        "import math",
        "from typing import Callable, List, NamedTuple, Tuple, Union",
        "Vector = List[float]",
        _extract_symbols(ds_la, ["subtract", "dot", "sum_of_squares", "magnitude", "distance"]),
        _extract_symbols(ds_cl, [
            "Leaf", "Merged", "Cluster", "get_values", "cluster_distance",
            "get_merge_order", "get_children", "bottom_up_cluster", "generate_clusters",
        ]),
        """
def run(points, num_clusters):
    base = bottom_up_cluster(points)
    groups = [sorted(get_values(c)) for c in generate_clusters(base, num_clusters)]
    return sorted(groups, key=lambda g: (len(g), g[0]))
""",
    ])
    add_repo_task(
        task_id="py-real-dsfs-hierarchical-cluster-0",
        family="py-real:joelgrus__data-science-from-scratch:hierarchical_cluster",
        repo="joelgrus__data-science-from-scratch",
        source_file="scratch/clustering.py+linear_algebra.py",
        source=ds_cl_src,
        entry="run",
        args=[[[-14, -5], [13, 13], [20, 23]], 2],
        features=["loop", "branch", "recursion", "clustering"],
    )

    ds_pr_src = "\n\n".join([
        "from collections import Counter",
        "from typing import Dict, List, NamedTuple, Tuple",
        "class _Tqdm:\n    @staticmethod\n    def trange(n): return range(n)\ntqdm = _Tqdm()",
        _extract_symbols(ds_net, ["User", "page_rank"]),
        """
def run(num_users, endorsements, iters):
    users = [User(i, f"u{i}") for i in range(num_users)]
    pr = page_rank(users, endorsements, damping=0.85, num_iters=iters)
    return {k: round(v, 5) for k, v in pr.items()}
""",
    ])
    add_repo_task(
        task_id="py-real-dsfs-pagerank-0",
        family="py-real:joelgrus__data-science-from-scratch:pagerank",
        repo="joelgrus__data-science-from-scratch",
        source_file="scratch/network_analysis.py",
        source=ds_pr_src,
        entry="run",
        args=[5, [(0, 1), (1, 0), (0, 2), (1, 3), (2, 3), (3, 4)], 6],
        features=["loop", "branch", "graph", "math"],
    )

    # =========================================================================
    # 9. google__yapf, openai__swarm, cool-RR__PySnooper (4 tasks)
    # =========================================================================
    yapf_style = dgx1 / "google__yapf/yapf/yapflib/style.py"
    yapf_join = dgx1 / "google__yapf/yapf/yapflib/line_joiner.py"
    yapf_tok = dgx1 / "google__yapf/yapf/yapflib/format_token.py"
    swarm_util = dgx1 / "openai__swarm/swarm/util.py"
    snooper_utils = dgx1 / "cool-RR__PySnooper/pysnooper/utils.py"

    yapf_cfg_src = "\n\n".join([
        "from configparser import ConfigParser",
        "import re",
        "class StyleConfigError(Exception): pass",
        _extract_symbols(yapf_style, [
            "_ContinuationAlignStyleStringConverter", "_StringListConverter",
            "_StringSetConverter", "_BoolConverter", "_IntListConverter",
            "_IntOrIntListConverter", "_STYLE_OPTION_VALUE_CONVERTER",
            "_CreateConfigParserFromConfigString",
        ]),
        """
def run(cfg_str):
    cp = _CreateConfigParserFromConfigString(cfg_str)
    parsed = {}
    errors = {}
    for k, raw in cp.items("style"):
        key = k.upper()
        conv = _STYLE_OPTION_VALUE_CONVERTER.get(key)
        if conv is None:
            errors[key] = "unknown"
            continue
        try:
            val = conv(raw)
            parsed[key] = sorted(val) if isinstance(val, set) else val
        except Exception as exc:
            errors[key] = str(exc)
    return {"parsed": parsed, "errors": errors}
""",
    ])
    add_repo_task(
        task_id="py-real-yapf-style-config-0",
        family="py-real:google__yapf:style_config",
        repo="google__yapf",
        source_file="yapf/yapflib/style.py",
        source=yapf_cfg_src,
        entry="run",
        args=["{column_limit: 96, indent_width: 2, join_multiple_lines: false, continuation_align_style: 'valign_right', spaces_before_comment: '15, 20'}"],
        features=["loop", "branch", "exception", "regex", "config"],
    )

    yapf_join_src = "\n\n".join([
        _extract_symbols(yapf_tok, ["_TabbedContinuationAlignPadding"]),
        """class _StyleProxy:
    def __init__(self, cfg):
        self.cfg = cfg
    def Get(self, k):
        return self.cfg[k]
style = _StyleProxy({"INDENT_WIDTH": 4, "COLUMN_LIMIT": 40, "JOIN_MULTIPLE_LINES": True})
class _Tok:
    def __init__(self, value, total_length, is_multiline_string=False):
        self.value = value
        self.total_length = total_length
        self.is_multiline_string = is_multiline_string
class _Line:
    def __init__(self, lineno, depth, tokens):
        self.lineno = lineno
        self.depth = depth
        self.tokens = tokens
        self.first = tokens[0]
        self.last = tokens[-1]
""",
        _extract_symbols(yapf_join, ["_CLASS_OR_FUNC", "CanMergeMultipleLines", "_CanMergeLineIntoIfStatement"]),
        """
def run(line_specs, pad_spaces):
    lines = [_Line(ln, dep, [_Tok(v, tl, m) for v, tl, m in toks]) for ln, dep, toks in line_specs]
    m1 = CanMergeMultipleLines(lines[:3], last_was_merged=False)
    m2 = CanMergeMultipleLines(lines[1:], last_was_merged=m1)
    pad = _TabbedContinuationAlignPadding(pad_spaces, "VALIGN-RIGHT", 4)
    return {"merge_if": m1, "merge_else": m2, "pad": repr(pad)}
""",
    ])
    add_repo_task(
        task_id="py-real-yapf-line-joiner-0",
        family="py-real:google__yapf:line_joiner",
        repo="google__yapf",
        source_file="yapf/yapflib/line_joiner.py+format_token.py",
        source=yapf_join_src,
        entry="run",
        args=[
            [
                (10, 1, [("if", 2, False), ("x", 8, False)]),
                (10, 2, [("return", 14, False)]),
                (12, 1, [("else", 4, False)]),
                (12, 2, [("break", 9, False)]),
            ],
            10,
        ],
        features=["loop", "branch", "class", "formatter"],
    )

    swarm_src = "\n\n".join([
        "from datetime import datetime",
        "import inspect",
        _extract_symbols(swarm_util, ["merge_fields", "merge_chunk", "function_to_json"]),
        """
def sample_handler(query: str, limit: int = 5, strict: bool = False):
    \"\"\"Lookup items.\"\"\"
    return []

def run(final_resp, deltas):
    for d in deltas:
        merge_chunk(final_resp, d)
    schema = function_to_json(sample_handler)
    return {"resp": final_resp, "schema": schema}
""",
    ])
    add_repo_task(
        task_id="py-real-swarm-merge-chunk-0",
        family="py-real:openai__swarm:merge_chunk",
        repo="openai__swarm",
        source_file="swarm/util.py",
        source=swarm_src,
        entry="run",
        args=[
            {"content": "", "tool_calls": [{"function": {"name": "", "arguments": ""}}]},
            [
                {"role": "assistant", "content": "Hello "},
                {"content": "world", "tool_calls": [{"index": 0, "function": {"name": "search", "arguments": '{"q":'}}]},
                {"tool_calls": [{"index": 0, "function": {"arguments": '"py"}'}}]},
            ],
        ],
        features=["loop", "branch", "recursion", "mutation"],
    )

    snooper_src = "\n\n".join([
        "import collections.abc as collections_abc",
        "import re",
        "string_types = (str,)",
        _extract_symbols(snooper_utils, ["shitcode", "get_repr_function", "DEFAULT_REPR_RE", "normalize_repr", "get_shortish_repr", "truncate", "ensure_tuple"]),
        """
def run(raw_strings, obj_reprs, limit):
    cleaned = [shitcode(s) for s in raw_strings]
    normed = [truncate(normalize_repr(r), limit) for r in obj_reprs]
    tupled = [ensure_tuple(x) for x in [raw_strings, "single"]]
    return {"cleaned": cleaned, "normed": normed, "tupled": tupled}
""",
    ])
    add_repo_task(
        task_id="py-real-pysnooper-repr-truncate-0",
        family="py-real:cool-RR__PySnooper:repr_utils",
        repo="cool-RR__PySnooper",
        source_file="pysnooper/utils.py",
        source=snooper_src,
        entry="run",
        args=[["abc\u2603def", "ok"], ["<Node at 0x7f12ab34cd56 value='very_long_payload_string'>"], 26],
        features=["loop", "branch", "regex", "unicode"],
    )

    # =========================================================================
    # 10. varunagrawal__bbox & sapanz__Hackerrank (4 tasks: IoU/NMS, polygon clip, inversions, leaderboard+enc)
    # =========================================================================
    # Extract docstrings/signatures/algorithms from bbox/metrics.py, utils.py, geometry.py and evaluate pure-Python math
    bbox_metrics = dgx2 / "varunagrawal__bbox/bbox/metrics.py"
    bbox_utils = dgx2 / "varunagrawal__bbox/bbox/utils.py"
    bbox_geom = dgx2 / "varunagrawal__bbox/bbox/geometry.py"
    assert bbox_metrics.is_file() and bbox_utils.is_file() and bbox_geom.is_file()

    bbox_iou_nms_src = '''
"""Pure-Python 2D IoU & NMS ported directly from varunagrawal/bbox (metrics.py & utils.py)."""

def jaccard_index_2d(a, b):
    xA = max(a[0], b[0])
    yA = max(a[1], b[1])
    xB = min(a[2], b[2])
    yB = min(a[3], b[3])
    inter_w = max(0.0, xB - xA + 1.0)
    inter_h = max(0.0, yB - yA + 1.0)
    intersection = inter_w * inter_h
    a_area = (a[2] - a[0] + 1.0) * (a[3] - a[1] + 1.0)
    b_area = (b[2] - b[0] + 1.0) * (b[3] - b[1] + 1.0)
    union = a_area + b_area - intersection
    if union <= 0.0:
        return 0.0
    return intersection / union

def nms(boxes, scores, thresh):
    if not boxes:
        return []
    if len(scores) != len(boxes):
        raise ValueError("box list and scores should have the same number of elements.")
    areas = [(b[2] - b[0] + 1.0) * (b[3] - b[1] + 1.0) for b in boxes]
    order = sorted(range(len(scores)), key=lambda idx: scores[idx], reverse=True)
    keep = []
    while order:
        i = order[0]
        keep.append(i)
        next_order = []
        for j in order[1:]:
            xx1 = max(boxes[i][0], boxes[j][0])
            yy1 = max(boxes[i][1], boxes[j][1])
            xx2 = min(boxes[i][2], boxes[j][2])
            yy2 = min(boxes[i][3], boxes[j][3])
            inter = max(0.0, xx2 - xx1 + 1.0) * max(0.0, yy2 - yy1 + 1.0)
            overlap = inter / (areas[i] + areas[j] - inter)
            if overlap <= thresh:
                next_order.append(j)
        order = next_order
    return keep

def run(boxes, scores, thresh):
    kept = nms(boxes, scores, thresh)
    pair_iou = round(jaccard_index_2d(boxes[0], boxes[1]), 4)
    return {"kept": kept, "pair_iou_01": pair_iou}
'''
    add_repo_task(
        task_id="py-real-bbox-iou-nms-0",
        family="py-real:varunagrawal__bbox:iou_nms",
        repo="varunagrawal__bbox",
        source_file="bbox/metrics.py+utils.py",
        source=bbox_iou_nms_src,
        entry="run",
        args=[
            [[10, 10, 50, 50], [12, 12, 52, 52], [11, 9, 49, 48], [100, 100, 140, 140], [102, 98, 138, 136]],
            [0.92, 0.85, 0.78, 0.88, 0.61],
            0.45,
        ],
        features=["loop", "branch", "geometry", "sorting"],
    )

    bbox_poly_src = '''
"""Pure-Python 2D polygon intersection & Shoelace area from varunagrawal/bbox (geometry.py)."""

def cross2d(x, y):
    return x[0] * y[1] - x[1] * y[0]

def polygon_area(polygon):
    n = len(polygon)
    if n < 3:
        return 0.0
    total = 0.0
    for i in range(n):
        j = (i + 1) % n
        total += polygon[i][0] * polygon[j][1] - polygon[j][0] * polygon[i][1]
    return abs(total) / 2.0

def polygon_intersection(poly1, poly2):
    def line_intersection(e1, e2, s, e):
        dc = [e1[0] - e2[0], e1[1] - e2[1]]
        dp = [s[0] - e[0], s[1] - e[1]]
        n1 = cross2d(e1, e2)
        n2 = cross2d(s, e)
        n3 = 1.0 / cross2d(dc, dp)
        return [(n1 * dp[0] - n2 * dc[0]) * n3, (n1 * dp[1] - n2 * dc[1]) * n3]

    def is_inside_edge(p, e1, e2):
        return cross2d([e2[0] - e1[0], e2[1] - e1[1]], [p[0] - e1[0], p[1] - e1[1]]) >= 0

    output_list = list(poly1)
    e1 = poly2[-1]
    for e2 in poly2:
        if not output_list:
            break
        input_list = output_list
        output_list = []
        s = input_list[-1]
        for e in input_list:
            if is_inside_edge(e, e1, e2):
                if not is_inside_edge(s, e1, e2):
                    output_list.append(line_intersection(e1, e2, s, e))
                output_list.append(e)
            elif is_inside_edge(s, e1, e2):
                output_list.append(line_intersection(e1, e2, s, e))
            s = e
        e1 = e2
    return output_list

def run(poly1, poly2):
    inter = polygon_intersection(poly1, poly2)
    area = round(polygon_area(inter), 4)
    return {"vertices": [[round(p[0], 3), round(p[1], 3)] for p in inter], "area": area}
'''
    add_repo_task(
        task_id="py-real-bbox-polygon-clip-0",
        family="py-real:varunagrawal__bbox:polygon_intersection",
        repo="varunagrawal__bbox",
        source_file="bbox/geometry.py",
        source=bbox_poly_src,
        entry="run",
        args=[
            [[0.0, 0.0], [4.0, 0.0], [0.0, 4.0]],
            [[1.0, 1.0], [5.0, 1.0], [1.0, 5.0]],
        ],
        features=["loop", "branch", "geometry"],
    )

    hr_merge = dgx2 / "sapanz__Hackerrank-Problem-Solving-Python-Solutions/Merge Sort/merge_sort.py"
    hr_climb = dgx2 / "sapanz__Hackerrank-Problem-Solving-Python-Solutions/HackerRank-Climbing the Leaderboard/Climbing_the_Leaderboard.py"
    hr_enc = dgx2 / "sapanz__Hackerrank-Problem-Solving-Python-Solutions/HackerRank-Encryption/Encryption.py"

    hr_merge_src = _extract_symbols(hr_merge, ["mergeSort", "_mergeSort", "merge"]) + """

def run(arr):
    inv = mergeSort(arr, len(arr))
    return {"inversions": inv, "sorted": arr}
"""
    add_repo_task(
        task_id="py-real-hackerrank-mergesort-inversions-0",
        family="py-real:sapanz__Hackerrank:mergesort_inversions",
        repo="sapanz__Hackerrank-Problem-Solving-Python-Solutions",
        source_file="Merge Sort/merge_sort.py",
        source=hr_merge_src,
        entry="run",
        args=[[9, 3, 7, 5, 2, 1]],
        features=["loop", "branch", "recursion", "mutation", "sorting"],
    )

    hr_climb_enc_src = "import math\n\n" + _extract_symbols(hr_climb, ["climbingLeaderboard"]) + "\n\n" + _extract_symbols(hr_enc, ["encryption"]) + """

def run(scores, alice, secret_text):
    ranks = climbingLeaderboard(scores, alice)
    cipher = encryption(secret_text)
    return {"ranks": ranks, "cipher": cipher.strip()}
"""
    add_repo_task(
        task_id="py-real-hackerrank-leaderboard-encryption-0",
        family="py-real:sapanz__Hackerrank:leaderboard_encryption",
        repo="sapanz__Hackerrank-Problem-Solving-Python-Solutions",
        source_file="Climbing_the_Leaderboard.py+Encryption.py",
        source=hr_climb_enc_src,
        entry="run",
        args=[[100, 100, 50, 40, 40, 20, 10], [5, 25, 50, 120], "haveaniceday"],
        features=["loop", "branch", "math"],
    )

    # =========================================================================
    # Additional real-repo multi-input / effectful slices in Part A
    # =========================================================================
    # jinja effectful template-data filter pipeline (http_get + print + kv_set)
    jinja_eff_src = jinja_shim + "\n" + _extract_symbols(
        jinja_filters,
        ["ignore_case", "_prepare_attribute_parts", "make_attrgetter", "_GroupTuple", "sync_do_groupby", "do_filesizeformat", "do_round"],
        strip_decorators={"pass_environment", "pass_eval_context", "pass_context"},
    ) + """
import json

def run(url, kv_key):
    raw = host.http_get(url)
    records = json.loads(raw)
    env = Environment()
    grouped = sync_do_groupby(env, records, "env", default="dev", case_sensitive=False)
    report = {}
    for g in grouped:
        total_b = sum(r["bytes"] for r in g.list)
        report[g.grouper] = {"count": len(g.list), "size": do_filesizeformat(total_b, binary=True)}
        print("group", g.grouper, report[g.grouper]["size"])
    host.kv_set(kv_key, report)
    return report
"""
    add_repo_task(
        task_id="py-real-jinja-effectful-groupby-0",
        family="py-real:pallets__jinja:effectful_groupby",
        repo="pallets__jinja",
        source_file="src/jinja2/filters.py",
        source=jinja_eff_src,
        entry="run",
        args=["https://metrics.local/assets.json", "assets:report"],
        features=["loop", "branch", "jinja", "hard-effectful", "http", "kv"],
        scripted_calls={
            "http.get": [{"status": "fulfilled", "result": '[{"env":"Prod","bytes":2048},{"env":"prod","bytes":4096},{"bytes":512}]'}],
            "kv_set": [{"status": "fulfilled", "result": True}],
        },
    )

    # Task 40: dsfs effectful network shortest-path monitor (kv_get + shortest_paths_from + print + kv_set)
    ds_eff_src = "\n\n".join([
        "from collections import deque",
        "from typing import Dict, List",
        "Friendships = Dict[int, List[int]]",
        "Path = List[int]",
        _extract_symbols(ds_net, ["shortest_paths_from"]),
        """
def run(graph_key, src_node, target_node):
    edges = host.kv_get(graph_key)
    adj = {}
    for u, v in edges:
        adj.setdefault(u, []).append(v)
        adj.setdefault(v, []).append(u)
    paths = shortest_paths_from(src_node, adj).get(target_node, [])
    print("paths-found", len(paths))
    host.kv_set(f"{graph_key}:paths:{src_node}:{target_node}", paths)
    return {"count": len(paths), "paths": paths}
""",
    ])
    add_repo_task(
        task_id="py-real-dsfs-effectful-graph-0",
        family="py-real:joelgrus__data-science-from-scratch:effectful_shortest_paths",
        repo="joelgrus__data-science-from-scratch",
        source_file="scratch/network_analysis.py",
        source=ds_eff_src,
        entry="run",
        args=["social:edges", 0, 4],
        features=["loop", "branch", "graph", "bfs", "hard-effectful", "kv"],
        scripted_calls={
            "kv_get": [{"status": "fulfilled", "result": [[0, 1], [0, 2], [1, 3], [2, 3], [3, 4]]}],
            "kv_set": [{"status": "fulfilled", "result": True}],
        },
    )

    return tasks


# ---------------------------------------------------------------------------
# PART B: 10 Hairy Multi-Turn Effectful Python Workflow Families x 3 instances
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
        scripted_calls: dict[str, list[dict[str, Any]]] | None = None,
        scripted_times: list[float] | None = None,
        scripted_randoms: list[float] | None = None,
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
                scripted_calls=scripted_calls,
                scripted_times=scripted_times,
                scripted_randoms=scripted_randoms,
                metadata={
                    "sourceOrigin": "authored-hairy-effectful-py",
                    "part": "B",
                    "inputVariant": idx,
                    "template": f"py-hairy-effectful:{family}",
                    "lineage": [f"py-hairy-effectful:{family}"],
                },
            )
        )

    # -------------------------------------------------------------------------
    # 1. py-deadline-bpe-compressor (3 instances)
    # -------------------------------------------------------------------------
    src_bpe_deadline = """
import collections
import time

def run(text, target_merges, budget_s, stats_out):
    start = time.time()
    ids = list(text.encode("utf-8"))
    merges = []
    timed_out = False
    for step in range(target_merges):
        now = time.time()
        elapsed = round(now - start, 4)
        if elapsed >= budget_s:
            timed_out = True
            print("deadline-reached", step, elapsed)
            break
        counts = collections.Counter(zip(ids, ids[1:]))
        if not counts:
            break
        best_pair, best_freq = max(counts.items(), key=lambda kv: (kv[1], -kv[0][0], -kv[0][1]))
        if best_freq < 2:
            print("converged-early", step)
            break
        new_id = 256 + step
        nxt = []
        i = 0
        while i < len(ids):
            if i < len(ids) - 1 and ids[i] == best_pair[0] and ids[i + 1] == best_pair[1]:
                nxt.append(new_id)
                i += 2
            else:
                nxt.append(ids[i])
                i += 1
        ids = nxt
        merges.append((best_pair, new_id, best_freq))
        if step % 2 == 1:
            print("merge-milestone", step + 1, new_id, best_freq)
    stats_out["merges_done"] = len(merges)
    stats_out["final_len"] = len(ids)
    stats_out["timed_out"] = timed_out
    return {"ids": ids, "merges": merges, "stats": stats_out}
"""
    add_wf(
        family="py-deadline-bpe-compressor", idx=0, source=src_bpe_deadline,
        args=["ababa cab", 3, 2.0, {"merges_done": 0}],
        features=["loop", "branch", "bpe", "deadline", "platform", "alias"],
        scripted_times=[1000.0, 1000.2, 1000.5, 1000.8],
    )
    add_wf(
        family="py-deadline-bpe-compressor", idx=1, source=src_bpe_deadline,
        args=["banana ban", 5, 0.75, {"merges_done": 0}],
        features=["loop", "branch", "bpe", "deadline", "platform", "alias"],
        scripted_times=[2000.0, 2000.2, 2000.45, 2000.70, 2000.80],
    )
    add_wf(
        family="py-deadline-bpe-compressor", idx=2, source=src_bpe_deadline,
        args=["abab cdcd xy", 4, 3.0, {"merges_done": 0}],
        features=["loop", "branch", "bpe", "deadline", "platform", "alias"],
        scripted_times=[3000.0, 3000.1, 3000.2, 3000.3],
    )

    # -------------------------------------------------------------------------
    # 2. py-wal-kv-compactor (3 instances)
    # -------------------------------------------------------------------------
    src_wal = """
import json

def run(chunk_paths, snapshot_path, store):
    corrupt = 0
    missing = 0
    applied = 0
    for cpath in chunk_paths:
        try:
            raw = host.fs_read_text(cpath)
        except FileNotFoundError as exc:
            missing += 1
            print("missing-chunk", cpath, str(exc))
            continue
        for lineno, line in enumerate(raw.splitlines(), 1):
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            parts = line.split()
            op = parts[0]
            try:
                if op == "SET" and len(parts) == 3:
                    store[parts[1]] = {"val": int(parts[2]), "hits": 0}
                    applied += 1
                elif op == "ALIAS" and len(parts) == 3 and parts[2] in store:
                    store[parts[1]] = store[parts[2]]
                    applied += 1
                elif op == "INCR" and len(parts) == 3 and parts[1] in store:
                    store[parts[1]]["val"] += int(parts[2])
                    store[parts[1]]["hits"] += 1
                    applied += 1
                elif op == "DEL" and len(parts) == 2:
                    store.pop(parts[1], None)
                    applied += 1
                else:
                    raise ValueError("bad-op")
            except Exception:
                corrupt += 1
                print("corrupt-wal", cpath, lineno)
    snap = json.dumps({"keys": sorted(store.keys()), "applied": applied, "corrupt": corrupt}, sort_keys=True)
    print("compacted", len(store), applied)
    host.fs_write_text(snapshot_path, snap)
    return (store, {"applied": applied, "corrupt": corrupt, "missing": missing})
"""
    add_wf(
        family="py-wal-kv-compactor", idx=0, source=src_wal,
        args=[["/wal/001.log", "/wal/002.log"], "/wal/snap.json", {}],
        features=["loop", "branch", "exception", "fs", "alias", "mutation"],
        scripted_calls={
            "fs.readText": [
                {"status": "fulfilled", "result": "SET a 10\nALIAS b a\nBAD LINE\nINCR b 5\n"},
                {"status": "fulfilled", "result": "SET c 99\nDEL c\nINCR a 2\n"},
            ],
            "fs.writeText": [{"status": "fulfilled", "result": None}],
        },
    )
    add_wf(
        family="py-wal-kv-compactor", idx=1, source=src_wal,
        args=[["/wal/001.log", "/wal/missing.log", "/wal/003.log"], "/wal/snap2.json", {"seed": {"val": 1, "hits": 0}}],
        features=["loop", "branch", "exception", "fs", "alias", "mutation"],
        scripted_calls={
            "fs.readText": [
                {"status": "fulfilled", "result": "INCR seed 4\nALIAS mirror seed\n"},
                {"status": "rejected", "result": {"name": "FileNotFoundError", "message": "not found"}},
                {"status": "fulfilled", "result": "INCR mirror NaN\nDEL seed\n"},
            ],
            "fs.writeText": [{"status": "fulfilled", "result": None}],
        },
    )
    add_wf(
        family="py-wal-kv-compactor", idx=2, source=src_wal,
        args=[["/wal/empty.log", "/wal/ops.log"], "/wal/snap3.json", {}],
        features=["loop", "branch", "exception", "fs", "alias", "mutation"],
        scripted_calls={
            "fs.readText": [
                {"status": "fulfilled", "result": "# comment only\n"},
                {"status": "fulfilled", "result": "SET x 7\nALIAS y x\nALIAS z y\nINCR z 3\nSET x 20\n"},
            ],
            "fs.writeText": [{"status": "fulfilled", "result": None}],
        },
    )

    # -------------------------------------------------------------------------
    # 3. py-jittered-http-paginator (3 instances, randomMode="tool")
    # -------------------------------------------------------------------------
    src_paginator = """
import json
import random
import time
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

def _build_page_url(base_url, cursor):
    parts = urlsplit(base_url)
    params = dict(parse_qsl(parts.query))
    params["cursor"] = str(cursor)
    return urlunsplit((parts.scheme, parts.netloc, parts.path, urlencode(sorted(params.items())), ""))

def run(base_url, max_retries, budget_s, visited_urls):
    start = time.time()
    cursor = "0"
    seen = set()
    items = []
    delays = []
    aborted = False
    while cursor is not None:
        url = _build_page_url(base_url, cursor)
        payload = None
        for attempt in range(max_retries + 1):
            if time.time() - start > budget_s:
                aborted = True
                print("budget-exhausted", cursor)
                break
            try:
                visited_urls.append(url)
                raw = host.http_get(url)
                payload = json.loads(raw)
                break
            except Exception as exc:
                if attempt < max_retries:
                    cap = min(8.0, 1.0 * (2 ** attempt))
                    delay = round(random.random() * cap, 4)
                    delays.append(delay)
                    print("retry", cursor, attempt, delay, str(exc))
                else:
                    aborted = True
                    print("retries-exhausted", cursor)
        if aborted or payload is None:
            break
        for row in payload.get("items", []):
            rid = row["id"]
            if rid not in seen:
                seen.add(rid)
                items.append(row)
        cursor = payload.get("next")
    return {"items": items, "seen": seen, "delays": delays, "aborted": aborted, "visited": visited_urls}
"""
    add_wf(
        family="py-jittered-http-paginator", idx=0, source=src_paginator,
        args=["https://api.local/items?env=prod", 2, 10.0, []],
        features=["loop", "branch", "exception", "http", "url", "platform", "alias"],
        random_mode="tool",
        scripted_times=[100.0, 100.2, 100.6, 101.2, 101.5],
        scripted_randoms=[0.375],
        scripted_calls={
            "http.get": [
                {"status": "fulfilled", "result": '{"items":[{"id":"a1","v":1},{"id":"a2","v":2}],"next":"p2"}'},
                {"status": "rejected", "result": {"name": "ConnectionError", "message": "503 busy"}},
                {"status": "fulfilled", "result": '{"items":[{"id":"a2","v":2},{"id":"a3","v":3}],"next":null}'},
            ]
        },
    )
    add_wf(
        family="py-jittered-http-paginator", idx=1, source=src_paginator,
        args=["https://api.local/items?tag=v2", 2, 1.5, []],
        features=["loop", "branch", "exception", "http", "url", "platform", "alias"],
        random_mode="tool",
        scripted_times=[200.0, 200.3, 201.0, 201.8],
        scripted_randoms=[0.5],
        scripted_calls={
            "http.get": [
                {"status": "fulfilled", "result": '{"items":[{"id":"b1","v":5}],"next":"p2"}'},
                {"status": "rejected", "result": {"name": "TimeoutError", "message": "timed out"}},
            ]
        },
    )
    add_wf(
        family="py-jittered-http-paginator", idx=2, source=src_paginator,
        args=["https://api.local/logs?lvl=warn", 1, 5.0, []],
        features=["loop", "branch", "exception", "http", "url", "platform", "alias"],
        random_mode="tool",
        scripted_times=[300.0, 300.1, 300.4, 300.7],
        scripted_randoms=[],
        scripted_calls={
            "http.get": [
                {"status": "fulfilled", "result": '{"items":[{"id":"c1","v":9}],"next":"p2"}'},
                {"status": "fulfilled", "result": '{"items":[{"id":"c1","v":9},{"id":"c2","v":8}],"next":"p3"}'},
                {"status": "fulfilled", "result": '{"items":[],"next":null}'},
            ]
        },
    )

    # -------------------------------------------------------------------------
    # 4. py-ttl-lru-cache-engine (3 instances)
    # -------------------------------------------------------------------------
    src_ttl_lru = """
from collections import OrderedDict
import time

def run(capacity, commands, stats):
    cache = OrderedDict()
    results = []
    for cmd in commands:
        op = cmd[0]
        now = time.time()
        if op == "get":
            key = cmd[1]
            entry = cache.get(key)
            if entry is not None and entry["exp"] > now:
                cache.move_to_end(key)
                stats["hits"] += 1
                results.append((key, entry["val"]))
            else:
                if entry is not None:
                    del cache[key]
                    stats["expired"] += 1
                    print("expired", key)
                stats["misses"] += 1
                loaded = host.kv_get(f"backing:{key}")
                if loaded is not None:
                    if len(cache) >= capacity:
                        ev_k, ev_v = cache.popitem(last=False)
                        stats["evicted"] += 1
                        if ev_v["dirty"]:
                            host.kv_set(f"backing:{ev_k}", ev_v["val"])
                            stats["writes"] += 1
                    cache[key] = {"val": loaded, "exp": now + 30.0, "dirty": False}
                results.append((key, loaded))
        elif op == "put":
            key, val, ttl = cmd[1], cmd[2], cmd[3]
            if key in cache:
                cache.move_to_end(key)
            elif len(cache) >= capacity:
                ev_k, ev_v = cache.popitem(last=False)
                stats["evicted"] += 1
                if ev_v["dirty"]:
                    host.kv_set(f"backing:{ev_k}", ev_v["val"])
                    stats["writes"] += 1
            cache[key] = {"val": val, "exp": now + ttl, "dirty": True}
        elif op == "flush":
            for k, v in list(cache.items()):
                if v["exp"] <= now:
                    del cache[k]
                    stats["expired"] += 1
                elif v["dirty"]:
                    host.kv_set(f"backing:{k}", v["val"])
                    v["dirty"] = False
                    stats["writes"] += 1
            print("flushed", len(cache))
    return {"results": results, "keys": list(cache.keys()), "stats": stats}
"""
    add_wf(
        family="py-ttl-lru-cache-engine", idx=0, source=src_ttl_lru,
        args=[2, [("put", "k1", 10, 5.0), ("put", "k2", 20, 50.0), ("get", "k1"), ("get", "k3"), ("flush",)], {"hits": 0, "misses": 0, "expired": 0, "evicted": 0, "writes": 0}],
        features=["loop", "branch", "cache", "kv", "platform", "alias", "mutation"],
        scripted_times=[1000.0, 1001.0, 1010.0, 1011.0, 1012.0],
        scripted_calls={
            "kv_get": [{"status": "fulfilled", "result": 99}, {"status": "fulfilled", "result": 77}],
            "kv_set": [{"status": "fulfilled", "result": True}, {"status": "fulfilled", "result": True}],
        },
    )
    add_wf(
        family="py-ttl-lru-cache-engine", idx=1, source=src_ttl_lru,
        args=[2, [("put", "a", "v1", 10.0), ("put", "b", "v2", 10.0), ("get", "a"), ("put", "c", "v3", 10.0), ("get", "missing")], {"hits": 0, "misses": 0, "expired": 0, "evicted": 0, "writes": 0}],
        features=["loop", "branch", "cache", "kv", "platform", "alias", "mutation"],
        scripted_times=[2000.0, 2001.0, 2002.0, 2003.0, 2004.0],
        scripted_calls={
            "kv_get": [{"status": "fulfilled", "result": None}],
            "kv_set": [{"status": "fulfilled", "result": True}],
        },
    )
    add_wf(
        family="py-ttl-lru-cache-engine", idx=2, source=src_ttl_lru,
        args=[2, [("put", "x", 1, 2.0), ("put", "y", 2, 100.0), ("flush",), ("get", "y"), ("flush",)], {"hits": 0, "misses": 0, "expired": 0, "evicted": 0, "writes": 0}],
        features=["loop", "branch", "cache", "kv", "platform", "alias", "mutation"],
        scripted_times=[3000.0, 3001.0, 3005.0, 3006.0, 3007.0],
        scripted_calls={"kv_set": [{"status": "fulfilled", "result": True}]},
    )

    # -------------------------------------------------------------------------
    # 5. py-regex-pii-scrubber (3 instances)
    # -------------------------------------------------------------------------
    src_pii = """
import re
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

EMAIL_RE = re.compile(r"\\b([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@([A-Za-z0-9.-]+\\.[A-Za-z]{2,})\\b")
TOKEN_RE = re.compile(r"\\b(tok_[A-Za-z0-9]{4})[A-Za-z0-9_-]+\\b")
URL_RE = re.compile(r"https?://\\S+")
SENSITIVE_PARAMS = {"token", "secret", "sig", "api_key"}

def _scrub_url(m):
    raw_url = m.group(0)
    parts = urlsplit(raw_url)
    if not parts.query:
        return raw_url
    cleaned_q = []
    for k, v in parse_qsl(parts.query, keep_blank_values=True):
        cleaned_q.append((k, "[REDACTED]" if k.lower() in SENSITIVE_PARAMS else v))
    return urlunsplit((parts.scheme, parts.netloc, parts.path, urlencode(cleaned_q), parts.fragment))

def run(jobs):
    totals = {"emails": 0, "tokens": 0, "urls": 0, "missing": 0}
    tags = set()
    for in_path, out_path in jobs:
        try:
            text = host.fs_read_text(in_path)
        except FileNotFoundError as exc:
            totals["missing"] += 1
            print("missing-log", in_path, str(exc))
            continue
        text, n_email = EMAIL_RE.subn(r"\\1***@\\2", text)
        text, n_tok = TOKEN_RE.subn(r"\\1***", text)
        n_url = 0
        def _count_url(m):
            nonlocal n_url
            res = _scrub_url(m)
            if res != m.group(0):
                n_url += 1
            return res
        text = URL_RE.sub(_count_url, text)
        totals["emails"] += n_email
        totals["tokens"] += n_tok
        totals["urls"] += n_url
        if n_email or n_tok or n_url:
            tags.add(in_path)
        print("scrubbed", in_path, n_email, n_tok, n_url)
        host.fs_write_text(out_path, text)
    return {"totals": totals, "touched": tags}
"""
    add_wf(
        family="py-regex-pii-scrubber", idx=0, source=src_pii,
        args=[[("/logs/app1.log", "/logs/app1.clean"), ("/logs/app2.log", "/logs/app2.clean")]],
        features=["loop", "branch", "regex", "url", "fs", "set"],
        scripted_calls={
            "fs.readText": [
                {"status": "fulfilled", "result": "user alice@corp.io called https://api.corp.io/v1?token=xyz&page=2"},
                {"status": "fulfilled", "result": "auth tok_ab12supersecret for bob@example.org"},
            ],
            "fs.writeText": [{"status": "fulfilled", "result": None}, {"status": "fulfilled", "result": None}],
        },
    )
    add_wf(
        family="py-regex-pii-scrubber", idx=1, source=src_pii,
        args=[[("/logs/missing.log", "/logs/missing.clean"), ("/logs/edge.log", "/logs/edge.clean")]],
        features=["loop", "branch", "exception", "regex", "url", "fs", "set"],
        scripted_calls={
            "fs.readText": [
                {"status": "rejected", "result": {"name": "FileNotFoundError", "message": "enoent"}},
                {"status": "fulfilled", "result": "GET https://cdn.local/img?sig=deadbeef&v=1 tok_9999abcdef"},
            ],
            "fs.writeText": [{"status": "fulfilled", "result": None}],
        },
    )
    add_wf(
        family="py-regex-pii-scrubber", idx=2, source=src_pii,
        args=[[("/logs/clean.log", "/logs/clean.out"), ("/logs/mail.log", "/logs/mail.out")]],
        features=["loop", "branch", "regex", "url", "fs", "set"],
        scripted_calls={
            "fs.readText": [
                {"status": "fulfilled", "result": "healthcheck ok https://status.local/ping?region=eu"},
                {"status": "fulfilled", "result": "notify admin@mail.net and ops@mail.net"},
            ],
            "fs.writeText": [{"status": "fulfilled", "result": None}, {"status": "fulfilled", "result": None}],
        },
    )

    # -------------------------------------------------------------------------
    # 6. py-circuit-breaker-router (3 instances)
    # -------------------------------------------------------------------------
    src_cb = """
import time

def run(requests, cfg, breaker):
    outcomes = []
    for req in requests:
        now = time.time()
        if breaker["state"] == "OPEN":
            if now - breaker["opened_at"] >= cfg["cooldown_s"]:
                breaker["state"] = "HALF_OPEN"
                print("circuit-half-open", req["id"])
            else:
                res = host.http_request({"url": cfg["fallback"], "method": "POST", "body": req})
                breaker["history"].append((req["id"], "fallback-open"))
                outcomes.append({"id": req["id"], "via": "fallback", "res": res})
                continue
        try:
            res = host.http_request({"url": cfg["primary"], "method": "POST", "body": req})
            if breaker["state"] == "HALF_OPEN":
                print("circuit-closed", req["id"])
            breaker["state"] = "CLOSED"
            breaker["failures"] = 0
            breaker["history"].append((req["id"], "primary-ok"))
            outcomes.append({"id": req["id"], "via": "primary", "res": res})
        except Exception as exc:
            breaker["failures"] += 1
            breaker["history"].append((req["id"], f"err:{type(exc).__name__}"))
            if breaker["state"] == "HALF_OPEN" or breaker["failures"] >= cfg["threshold"]:
                breaker["state"] = "OPEN"
                breaker["opened_at"] = now
                print("circuit-open", req["id"], breaker["failures"])
            fb = host.http_request({"url": cfg["fallback"], "method": "POST", "body": req})
            outcomes.append({"id": req["id"], "via": "fallback", "res": fb})
    return {"outcomes": outcomes, "breaker": breaker}
"""
    add_wf(
        family="py-circuit-breaker-router", idx=0, source=src_cb,
        args=[[{"id": "r1"}, {"id": "r2"}, {"id": "r3"}], {"primary": "https://p.local", "fallback": "https://fb.local", "threshold": 1, "cooldown_s": 3.0}, {"state": "CLOSED", "failures": 0, "opened_at": 0.0, "history": []}],
        features=["loop", "branch", "exception", "http", "platform", "alias", "mutation"],
        scripted_times=[200.0, 204.0, 208.0],
        scripted_calls={
            "http.request": [
                {"status": "fulfilled", "result": {"ok": True, "src": "p1"}},
                {"status": "rejected", "result": {"name": "TimeoutError", "message": "timeout"}},
                {"status": "fulfilled", "result": {"ok": True, "src": "fb2"}},
                {"status": "fulfilled", "result": {"ok": True, "src": "p3"}},
            ]
        },
    )
    add_wf(
        family="py-circuit-breaker-router", idx=1, source=src_cb,
        args=[[{"id": "r1"}, {"id": "r2"}, {"id": "r3"}], {"primary": "https://p.local", "fallback": "https://fb.local", "threshold": 1, "cooldown_s": 3.0}, {"state": "CLOSED", "failures": 0, "opened_at": 0.0, "history": []}],
        features=["loop", "branch", "exception", "http", "platform", "alias", "mutation"],
        scripted_times=[200.0, 204.0, 205.0],
        scripted_calls={
            "http.request": [
                {"status": "rejected", "result": {"name": "TimeoutError", "message": "down"}},
                {"status": "fulfilled", "result": {"ok": True, "src": "fb1"}},
                {"status": "rejected", "result": {"name": "ConnectionError", "message": "still-down"}},
                {"status": "fulfilled", "result": {"ok": True, "src": "fb2"}},
                {"status": "fulfilled", "result": {"ok": True, "src": "fb3"}},
            ]
        },
    )
    add_wf(
        family="py-circuit-breaker-router", idx=2, source=src_cb,
        args=[[{"id": "m1"}, {"id": "m2"}, {"id": "m3"}], {"primary": "https://p.local", "fallback": "https://fb.local", "threshold": 2, "cooldown_s": 5.0}, {"state": "CLOSED", "failures": 0, "opened_at": 0.0, "history": []}],
        features=["loop", "branch", "exception", "http", "platform", "alias", "mutation"],
        scripted_times=[300.0, 301.0, 302.0],
        scripted_calls={
            "http.request": [
                {"status": "rejected", "result": {"name": "ConnectionError", "message": "blip"}},
                {"status": "fulfilled", "result": {"ok": True, "src": "fb1"}},
                {"status": "fulfilled", "result": {"ok": True, "src": "p2"}},
                {"status": "fulfilled", "result": {"ok": True, "src": "p3"}},
            ]
        },
    )

    # -------------------------------------------------------------------------
    # 7. py-priority-job-scheduler (3 instances)
    # -------------------------------------------------------------------------
    src_sched = """
import heapq
import time

def run(jobs, capacity, age_rate, queue_state):
    heap = []
    for idx, j in enumerate(jobs):
        heapq.heappush(heap, (j["prio"], j["enqueued"], idx, j["id"], j["cost"]))
    dispatched = []
    deferred = []
    rem = capacity
    step = 0
    while heap:
        now = time.time()
        rescored = []
        while heap:
            prio, enq, idx, jid, cost = heapq.heappop(heap)
            eff = round(prio - age_rate * max(0.0, now - enq), 3)
            rescored.append((eff, prio, enq, idx, jid, cost))
        heapq.heapify(rescored)
        eff, prio, enq, idx, jid, cost = heapq.heappop(rescored)
        for item in rescored:
            heapq.heappush(heap, (item[1], item[2], item[3], item[4], item[5]))
        if cost <= rem:
            rem -= cost
            step += 1
            dispatched.append((jid, eff))
            print("dispatch", jid, eff, rem)
            if step % 2 == 0 or not heap:
                host.kv_set(f"sched:ckpt:{step}", {"dispatched": list(dispatched), "rem": rem})
        else:
            deferred.append(jid)
            print("defer", jid, cost, rem)
    if not dispatched:
        host.kv_set("sched:ckpt:idle", {"dispatched": [], "deferred": deferred})
    queue_state["dispatched"] = dispatched
    queue_state["deferred"] = deferred
    return queue_state
"""
    add_wf(
        family="py-priority-job-scheduler", idx=0, source=src_sched,
        args=[[{"id": "j1", "prio": 5, "enqueued": 90.0, "cost": 2}, {"id": "j2", "prio": 2, "enqueued": 99.0, "cost": 2}, {"id": "j3", "prio": 4, "enqueued": 95.0, "cost": 3}], 7, 0.5, {}],
        features=["loop", "branch", "heapq", "kv", "platform", "alias", "mutation"],
        scripted_times=[100.0, 102.0, 104.0],
        scripted_calls={"kv_set": [{"status": "fulfilled", "result": True}, {"status": "fulfilled", "result": True}]},
    )
    add_wf(
        family="py-priority-job-scheduler", idx=1, source=src_sched,
        args=[[{"id": "big", "prio": 1, "enqueued": 90.0, "cost": 8}, {"id": "small", "prio": 3, "enqueued": 98.0, "cost": 3}], 5, 0.25, {}],
        features=["loop", "branch", "heapq", "kv", "platform", "alias", "mutation"],
        scripted_times=[100.0, 101.0],
        scripted_calls={"kv_set": [{"status": "fulfilled", "result": True}]},
    )
    add_wf(
        family="py-priority-job-scheduler", idx=2, source=src_sched,
        args=[[{"id": "huge1", "prio": 1, "enqueued": 10.0, "cost": 10}, {"id": "huge2", "prio": 2, "enqueued": 10.0, "cost": 9}], 4, 0.1, {}],
        features=["loop", "branch", "heapq", "kv", "platform", "alias", "mutation"],
        scripted_times=[20.0, 21.0],
        scripted_calls={"kv_set": [{"status": "fulfilled", "result": True}]},
    )

    # -------------------------------------------------------------------------
    # 8. py-weighted-reservoir-audit (3 instances, randomMode="tool")
    # -------------------------------------------------------------------------
    src_reservoir = """
import heapq
import math
import random
import time

def run(records, k):
    ts = time.time()
    heap = []
    skipped = 0
    for idx, rec in enumerate(records):
        w = rec.get("weight", 0)
        try:
            if not isinstance(w, (int, float)) or isinstance(w, bool) or not math.isfinite(w) or w <= 0.0:
                raise ValueError(f"invalid weight {w!r}")
        except ValueError as exc:
            skipped += 1
            print("skip-invalid", rec.get("id"), str(exc))
            continue
        u = max(1e-9, random.random())
        key = round(math.log(u) / w, 6)
        if len(heap) < k:
            heapq.heappush(heap, (key, idx, rec))
        elif key > heap[0][0]:
            heapq.heapreplace(heap, (key, idx, rec))
    selected = [item[2] for item in sorted(heap, key=lambda x: x[0], reverse=True)]
    for rec in selected:
        rec["audited"] = True
        rec["sampled_at"] = ts
        if rec.get("risk", 0) >= 8:
            print("high-risk-audit", rec["id"], rec["risk"])
    return {"selected": selected, "skipped": skipped}
"""
    add_wf(
        family="py-weighted-reservoir-audit", idx=0, source=src_reservoir,
        args=[[{"id": "a", "weight": 2.0, "risk": 9}, {"id": "b", "weight": 1.0, "risk": 3}, {"id": "c", "weight": 5.0, "risk": 8}, {"id": "d", "weight": 0.5, "risk": 2}], 2],
        features=["loop", "branch", "exception", "heapq", "math", "platform", "alias", "mutation"],
        random_mode="tool",
        scripted_times=[1700005000.0],
        scripted_randoms=[0.2, 0.9, 0.8, 0.1],
    )
    add_wf(
        family="py-weighted-reservoir-audit", idx=1, source=src_reservoir,
        args=[[{"id": "x1", "weight": 0.0, "risk": 5}, {"id": "x2", "weight": 3.0, "risk": 9}, {"id": "x3", "weight": -1.0, "risk": 1}, {"id": "x4", "weight": 2.0, "risk": 8}], 2],
        features=["loop", "branch", "exception", "heapq", "math", "platform", "alias", "mutation"],
        random_mode="tool",
        scripted_times=[1700006000.0],
        scripted_randoms=[0.6, 0.4],
    )
    add_wf(
        family="py-weighted-reservoir-audit", idx=2, source=src_reservoir,
        args=[[{"id": "m1", "weight": 4.0, "risk": 10}, {"id": "m2", "weight": 2.0, "risk": 4}], 4],
        features=["loop", "branch", "heapq", "math", "platform", "alias", "mutation"],
        random_mode="tool",
        scripted_times=[1700007000.0],
        scripted_randoms=[0.5, 0.7],
    )

    # -------------------------------------------------------------------------
    # 9. py-config-overlay-validator (3 instances)
    # -------------------------------------------------------------------------
    src_overlay = """
import decimal
import json
import math

def _deep_merge(dst, src):
    for k, v in src.items():
        if isinstance(v, dict) and isinstance(dst.get(k), dict):
            _deep_merge(dst[k], v)
        else:
            dst[k] = v

def run(layer_paths, out_path, shared_defaults):
    merged = {"defaults": shared_defaults, "flags": [], "limits": {}}
    warnings = 0
    for path in layer_paths:
        try:
            raw = host.fs_read_text(path)
            layer = json.loads(raw)
        except FileNotFoundError:
            warnings += 1
            print("missing-overlay", path)
            continue
        except json.JSONDecodeError:
            warnings += 1
            print("corrupt-overlay", path)
            continue
        if isinstance(layer.get("flags"), list):
            merged["flags"].extend(layer["flags"])
        if isinstance(layer.get("defaults"), dict):
            _deep_merge(merged["defaults"], layer["defaults"])
        if isinstance(layer.get("limits"), dict):
            for lk, lv in layer["limits"].items():
                if isinstance(lv, float) and (not math.isfinite(lv) or (lv == 0.0 and math.copysign(1.0, lv) < 0.0)):
                    warnings += 1
                    print("sanitized-limit", lk)
                    merged["limits"][lk] = 0.0
                else:
                    d = decimal.Decimal(str(lv))
                    merged["limits"][lk] = float(d.quantize(decimal.Decimal("0.01")))
    flag_set = set(merged["flags"])
    summary_tuple = (len(flag_set), warnings)
    out_doc = json.dumps({"defaults": merged["defaults"], "flags": sorted(flag_set), "limits": merged["limits"]}, sort_keys=True)
    print("validated", len(flag_set), len(merged["limits"]))
    host.fs_write_text(out_path, out_doc)
    return {"merged": merged, "flag_set": flag_set, "summary": summary_tuple}
"""
    add_wf(
        family="py-config-overlay-validator", idx=0, source=src_overlay,
        args=[["/cfg/base.json", "/cfg/prod.json"], "/cfg/final.json", {"retries": 2, "region": "us"}],
        features=["loop", "branch", "recursion", "json", "decimal", "fs", "set", "tuple", "alias"],
        scripted_calls={
            "fs.readText": [
                {"status": "fulfilled", "result": '{"flags":["tls","gzip"],"defaults":{"timeout":5},"limits":{"rate":12.345}}'},
                {"status": "fulfilled", "result": '{"flags":["gzip","strict"],"defaults":{"retries":4},"limits":{"burst":30.0}}'},
            ],
            "fs.writeText": [{"status": "fulfilled", "result": None}],
        },
    )
    add_wf(
        family="py-config-overlay-validator", idx=1, source=src_overlay,
        args=[["/cfg/base.json", "/cfg/missing.json", "/cfg/override.json"], "/cfg/final2.json", {"retries": 1}],
        features=["loop", "branch", "exception", "recursion", "json", "decimal", "fs", "set", "tuple", "alias"],
        scripted_calls={
            "fs.readText": [
                {"status": "fulfilled", "result": '{"flags":["a"],"limits":{"qps":5.5}}'},
                {"status": "rejected", "result": {"name": "FileNotFoundError", "message": "missing"}},
                {"status": "fulfilled", "result": '{"flags":["b"],"defaults":{"mode":"safe"},"limits":{"qps":-0.0}}'},
            ],
            "fs.writeText": [{"status": "fulfilled", "result": None}],
        },
    )
    add_wf(
        family="py-config-overlay-validator", idx=2, source=src_overlay,
        args=[["/cfg/base.json", "/cfg/bad.json"], "/cfg/final3.json", {"retries": 3}],
        features=["loop", "branch", "exception", "recursion", "json", "decimal", "fs", "set", "tuple", "alias"],
        scripted_calls={
            "fs.readText": [
                {"status": "fulfilled", "result": '{"flags":["x","y"],"limits":{"cpu":1.234}}'},
                {"status": "fulfilled", "result": '{bad-json'},
            ],
            "fs.writeText": [{"status": "fulfilled", "result": None}],
        },
    )

    # -------------------------------------------------------------------------
    # 10. py-canary-webhook-dispatcher (3 instances, randomMode="tool")
    # -------------------------------------------------------------------------
    src_webhook = """
import random
import time
from urllib.parse import urlencode

def run(events, cfg, metrics):
    dispatched = []
    for ev in events:
        eid = ev["id"]
        dedup_key = f"wh:{eid}"
        if host.kv_get(dedup_key) is not None:
            metrics["deduped"] += 1
            print("dedup-skip", eid)
            continue
        r = random.random()
        now = time.time()
        route = "canary" if r < cfg["canary_pct"] else "primary"
        base = cfg["canary_url"] if route == "canary" else cfg["primary_url"]
        url = f"{base}?{urlencode([('event', eid), ('ts', str(int(now)))])}"
        try:
            resp = host.http_request({"url": url, "method": "POST", "body": ev})
            host.kv_set(dedup_key, {"status": "sent", "route": route, "ts": now})
            metrics[route] += 1
            dispatched.append((eid, route, resp))
        except Exception as exc:
            print("webhook-fallback", eid, route, str(exc))
            dlq_resp = host.http_request({"url": cfg["dlq_url"], "method": "POST", "body": {"event": ev, "failed_route": route}})
            host.kv_set(dedup_key, {"status": "dlq", "route": route, "ts": now})
            metrics["dlq"] += 1
            dispatched.append((eid, "dlq", dlq_resp))
    return {"dispatched": dispatched, "metrics": metrics}
"""
    cfg_wh = {"canary_pct": 0.3, "canary_url": "https://canary.local/hook", "primary_url": "https://prod.local/hook", "dlq_url": "https://dlq.local/hook"}
    add_wf(
        family="py-canary-webhook-dispatcher", idx=0, source=src_webhook,
        args=[[{"id": "e1", "ok": True}, {"id": "e2", "ok": True}, {"id": "e3", "ok": False}], cfg_wh, {"canary": 0, "primary": 0, "dlq": 0, "deduped": 0}],
        features=["loop", "branch", "exception", "http", "kv", "url", "platform", "alias", "mutation"],
        random_mode="tool",
        scripted_times=[1000.0, 1001.0],
        scripted_randoms=[0.15, 0.85],
        scripted_calls={
            "kv_get": [
                {"status": "fulfilled", "result": {"status": "sent"}},
                {"status": "fulfilled", "result": None},
                {"status": "fulfilled", "result": None},
            ],
            "http.request": [
                {"status": "fulfilled", "result": {"code": 202}},
                {"status": "rejected", "result": {"name": "ConnectionError", "message": "500"}},
                {"status": "fulfilled", "result": {"queued": True}},
            ],
            "kv_set": [
                {"status": "fulfilled", "result": True},
                {"status": "fulfilled", "result": True},
            ],
        },
    )
    add_wf(
        family="py-canary-webhook-dispatcher", idx=1, source=src_webhook,
        args=[[{"id": "k1", "v": 1}, {"id": "k2", "v": 2}], cfg_wh, {"canary": 0, "primary": 0, "dlq": 0, "deduped": 0}],
        features=["loop", "branch", "exception", "http", "kv", "url", "platform", "alias", "mutation"],
        random_mode="tool",
        scripted_times=[2000.0, 2002.0],
        scripted_randoms=[0.1, 0.2],
        scripted_calls={
            "kv_get": [
                {"status": "fulfilled", "result": None},
                {"status": "fulfilled", "result": None},
            ],
            "http.request": [
                {"status": "rejected", "result": {"name": "TimeoutError", "message": "canary timeout"}},
                {"status": "fulfilled", "result": {"queued": True}},
                {"status": "fulfilled", "result": {"code": 200}},
            ],
            "kv_set": [
                {"status": "fulfilled", "result": True},
                {"status": "fulfilled", "result": True},
            ],
        },
    )
    add_wf(
        family="py-canary-webhook-dispatcher", idx=2, source=src_webhook,
        args=[[{"id": "p1", "v": 10}, {"id": "p2", "v": 20}, {"id": "p3", "v": 30}], cfg_wh, {"canary": 0, "primary": 0, "dlq": 0, "deduped": 0}],
        features=["loop", "branch", "exception", "http", "kv", "url", "platform", "alias", "mutation"],
        random_mode="tool",
        scripted_times=[3000.0, 3001.0, 3002.0],
        scripted_randoms=[0.5, 0.7, 0.9],
        scripted_calls={
            "kv_get": [
                {"status": "fulfilled", "result": None},
                {"status": "fulfilled", "result": None},
                {"status": "fulfilled", "result": None},
            ],
            "http.request": [
                {"status": "fulfilled", "result": {"code": 200}},
                {"status": "fulfilled", "result": {"code": 200}},
                {"status": "fulfilled", "result": {"code": 200}},
            ],
            "kv_set": [
                {"status": "fulfilled", "result": True},
                {"status": "fulfilled", "result": True},
                {"status": "fulfilled", "result": True},
            ],
        },
    )

    return tasks


def _verify_task(task: dict[str, Any]) -> dict[str, Any]:
    src_len = len(task["source"])
    if src_len > 35_000:
        raise ValueError(f"{task['id']}: source length {src_len} exceeds 35,000 chars")
    prepared = prepare_python_task(task, trace_format="compact")
    outcome = prepared.get("outcome") or {}
    if outcome.get("kind") != "return":
        raise ValueError(f"{task['id']}: outcome kind={outcome.get('kind')} err={outcome.get('error')}")
    turns = prepared.get("traceTurns")
    if not isinstance(turns, list):
        raise ValueError(f"{task['id']}: traceTurns missing (trace fallback hit resource limit)")
    exported = export_python_example(task, trace_format="compact", reasoning_channel="thinking")
    audit = exported["metadata"]["traceAudit"]
    if not audit.get("replayVerified"):
        raise ValueError(f"{task['id']}: replayVerified is False")
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
        "narrationLines": narration_lines,
        "externalCalls": exported["metadata"]["externalCalls"],
        "omittedTurns": omitted_turns,
        "sampleTrace": "\n---\n".join(thinking_blocks[:2]),
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Build and verify 60-75 hairy real-repo + effectful Python tasks.")
    parser.add_argument("--dgx1", type=Path, default=DEFAULT_DGX1, help="Path to /tmp/tinker-harvest-py-dgx")
    parser.add_argument("--dgx2", type=Path, default=DEFAULT_DGX2, help="Path to /tmp/tinker-harvest-py-dgx-wave2")
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT, help="Output tasks.jsonl path")
    parser.add_argument("--jobs", type=int, default=4, help="Parallel verification workers")
    args = parser.parse_args(argv)

    part_a = build_part_a_tasks(args.dgx1, args.dgx2)
    part_b = build_part_b_tasks()
    all_tasks = [*part_a, *part_b]

    seen_ids: set[str] = set()
    for t in all_tasks:
        tid = t["id"]
        if tid in seen_ids:
            raise ValueError(f"Duplicate task id: {tid}")
        seen_ids.add(tid)

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

    # Run full supervision audit across all exported examples
    supervision_audit = audit_python_supervision(
        [r["exported"] for r in verified_rows],
        {"formats": ["compact"], "samplePerFeature": 100, "seed": 17},
    )
    if not (supervision_audit.get("valid") and supervision_audit.get("allReplayed")):
        raise SystemExit("audit_python_supervision failed!")

    out_path = args.output.resolve()
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(
        "\n".join(_json_compact(r["task"]) for r in verified_rows) + "\n",
        encoding="utf-8",
    )

    part_a_lines = sorted(r["narrationLines"] for r in verified_rows if r["part"] == "A")
    part_b_lines = sorted(r["narrationLines"] for r in verified_rows if r["part"] == "B")
    all_lines = sorted(r["narrationLines"] for r in verified_rows)
    effectful_calls = [r["externalCalls"] for r in verified_rows if r["externalCalls"] > 0]
    omitted_count = sum(1 for r in verified_rows if r["omittedTurns"] > 0)

    summary = {
        "output": str(out_path),
        "totalTasks": len(verified_rows),
        "partATasks": len(part_a_lines),
        "partBTasks": len(part_b_lines),
        "families": len({r["task"]["family"] for r in verified_rows}),
        "partAFamilies": len({r["task"]["family"] for r in verified_rows if r["part"] == "A"}),
        "partBFamilies": len({r["task"]["family"] for r in verified_rows if r["part"] == "B"}),
        "effectfulTasks": len(effectful_calls),
        "minExternalCalls": min(effectful_calls) if effectful_calls else 0,
        "maxExternalCalls": max(effectful_calls) if effectful_calls else 0,
        "allReplayVerified": all(r["task"]["metadata"]["replayVerified"] for r in verified_rows),
        "supervisionAuditChecked": supervision_audit["summary"]["conversations"],
        "causalDivergencesChecked": supervision_audit["causalDivergencesChecked"],
        "tasksWithOmittedSteps": omitted_count,
        "traceLinesAll": {
            "min": all_lines[0],
            "median": all_lines[len(all_lines) // 2],
            "p90": all_lines[int(len(all_lines) * 0.9)],
            "max": all_lines[-1],
        },
        "traceLinesPartA": {
            "min": part_a_lines[0],
            "median": part_a_lines[len(part_a_lines) // 2],
            "p90": part_a_lines[int(len(part_a_lines) * 0.9)],
            "max": part_a_lines[-1],
        },
        "traceLinesPartB": {
            "min": part_b_lines[0],
            "median": part_b_lines[len(part_b_lines) // 2],
            "p90": part_b_lines[int(len(part_b_lines) * 0.9)],
            "max": part_b_lines[-1],
        },
        "perTaskTraceLines": [
            {
                "id": r["task"]["id"],
                "part": r["part"],
                "lines": r["narrationLines"],
                "calls": r["externalCalls"],
                "omitted": r["omittedTurns"],
            }
            for r in verified_rows
        ],
    }
    print(json.dumps(summary, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
