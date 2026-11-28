#!/usr/bin/env python3
"""Build, 2x independently verify, audit, and pre-export Stage 10 Python tasks.

Produces >= 295 brand-new, deterministic, pre-exported Python execution tasks
across two scale-bottleneck buckets (strictly zero-overlap with RealExecBench v1):

  Bucket A — 12K-56K Multi-File Python Codebases (~132 tasks, 44 unique repo families):
    - Part A1: 20 pure-Python OSS multi-file repo families (60 tasks) harvested
      from local `.venv-tinker` pure-Python packages NOT in RealExecBench v1
      (packaging, mdurl, markdown_it, dateutil, h11, hpack, hyperframe, h2,
      click, attr, urllib3, rich, pygments, networkx, mpmath, tqdm, requests).
    - Part A2: 24 brand-new 55-145 file synthetic multi-file Python repos (72 tasks,
      3 variants each including causal diverging pairs and exception/throw paths),
      combining on-demand `code.load` (whole-file + AST symbol-level) with
      `env.get`, `fs.*`, `http.request`, `shell.exec`, `sqlite3`, `platform.*`.

  Bucket C — Hairy & Real-World Single-File Python (~172 tasks, 86 unique families):
    - Part C1: 56 hairy Python semantics, stdlib, algorithm, and effectful causal-pair
      families (112 tasks).
    - Part C2: 30 pure-Python OSS single-file AST-extracted function probe families
      (60 tasks) strictly disjoint from RealExecBench v1.

Verification & Export:
  1. Pass 1: `export_python_example(..., trace_format="compact", reasoning_channel="thinking")`
     + live session replay via `create_python_session(prepare_python_task(...))`.
  2. Pass 2: Independent export via `tools/tinker-execution-py.py` JSONL bridge,
     asserting 100% byte-for-byte identical `messages` and `sourceHash`.
  3. Token bounds: total context <= 58,000 tokens (well inside 65,472) and
     every exported assistant turn <= 18,000 tokens (inside max_tokens <= 20,000).
  4. Causal supervision audit via `audit_python_supervision(...)`.
  5. Zero-leakage check against RealExecBench v1 (`id`, `family`, `sourceHash`, `split_component`).
"""

from __future__ import annotations

import argparse
import ast
import concurrent.futures
import hashlib
import json
import math
import os
from pathlib import Path
import queue
import subprocess
import sys
import threading
from typing import Any

_REPO_ROOT = Path(__file__).resolve().parents[1]
_TRAINING_DIR = str(_REPO_ROOT / "training")
if _TRAINING_DIR not in sys.path:
    sys.path.insert(0, _TRAINING_DIR)

from tinker_py.codebase import CODE_LOAD_OPERATION  # noqa: E402
from tinker_py.codec import encode_readable  # noqa: E402
from tinker_py.execution import (  # noqa: E402
    assistant_thinking_text,
    assistant_visible_text,
    audit_python_supervision,
    create_python_session,
    export_python_example,
    prepare_python_task,
)

try:
    import tiktoken as _tiktoken  # type: ignore[import-not-found]
    _TIKTOKEN_ENC = _tiktoken.get_encoding("cl100k_base")
except Exception:
    _TIKTOKEN_ENC = None

DEFAULT_REALEXEC_BENCHMARK = Path("/home/werg/tracing-js-self/runs/realexecbench-v1/benchmark.jsonl")
DEFAULT_REALEXEC_MANIFEST = Path("/home/werg/tracing-js-self/runs/realexecbench-v1/manifest.json")
DEFAULT_SITE_PACKAGES = Path("/home/werg/tracing-js-self/.venv-tinker/lib")
DEFAULT_OUTPUT = _REPO_ROOT / "runs/stage10-py-ts-65k/py-tasks.jsonl"
DEFAULT_REPORT = _REPO_ROOT / "runs/stage10-py-ts-65k/py-report.json"

MAX_TOTAL_EST_TOKENS = 58_000
MAX_TURN_TOKENS = 18_000


def _json_compact(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def _sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _find_site_packages(base: Path = DEFAULT_SITE_PACKAGES) -> Path:
    if (base / "packaging").is_dir():
        return base
    for cand in sorted(base.glob("python*/site-packages")):
        if cand.is_dir():
            return cand
    for p in sys.path:
        pp = Path(p)
        if pp.name == "site-packages" and (pp / "packaging").is_dir():
            return pp
    raise FileNotFoundError(f"Could not locate site-packages under {base}")


def _count_tokens(text: str) -> int:
    if _TIKTOKEN_ENC is not None:
        return len(_TIKTOKEN_ENC.encode(text, disallowed_special=()))
    return int(math.ceil(len(text) / 3.5))


def _estimate_tokens_32(text: str) -> int:
    return int(math.ceil(len(text) / 3.2))


def _load_realexec_forbidden(
    benchmark_path: Path = DEFAULT_REALEXEC_BENCHMARK,
    manifest_path: Path = DEFAULT_REALEXEC_MANIFEST,
) -> dict[str, set[str]]:
    ids: set[str] = set()
    families: set[str] = set()
    source_hashes: set[str] = set()
    split_components: set[str] = set()
    if benchmark_path.is_file():
        for line in benchmark_path.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            row = json.loads(line)
            if row.get("id"):
                ids.add(str(row["id"]))
            if row.get("family"):
                families.add(str(row["family"]))
            if row.get("sourceHash"):
                source_hashes.add(str(row["sourceHash"]))
            if row.get("split_component"):
                split_components.add(str(row["split_component"]))
    if manifest_path.is_file():
        man = json.loads(manifest_path.read_text(encoding="utf-8"))
        for _track, id_list in (man.get("task_ids_by_track") or {}).items():
            for tid in id_list:
                ids.add(str(tid))
    return {
        "ids": ids,
        "families": families,
        "sourceHashes": source_hashes,
        "split_components": split_components,
    }


# ---------------------------------------------------------------------------
# Subprocess fixture recorder using the exact canonical replay hooks
# ---------------------------------------------------------------------------

_FIXTURE_RECORDER_SCRIPT = r"""
import asyncio, builtins, inspect, io, json, random, sys, time
sys.path.insert(0, sys.argv[1])
from tinker_py.codebase import load_virtual_entry_module, normalize_codebase_files
from tinker_py.codec import decode_readable, encode_readable
from tinker_py.http_tools import install_replay_http_hooks
from tinker_py.io_tools import install_replay_io_hooks

req = json.loads(sys.stdin.read())
scripted = {k: list(v) for k, v in (req.get("scripted") or {}).items()}
time_q = list(req.get("times") or [])
uuid_q = list(req.get("uuids") or [])
secret_q = list(req.get("secrets") or [])
allow_throw = bool(req.get("allowThrow", False))
random_seed = int(req.get("randomSeed", 17))
time_idx = [0]
uuid_idx = [0]
sec_idx = [0]
recorded = []

def _make_exc(val):
    if isinstance(val, dict) and isinstance(val.get("name"), str):
        cls = getattr(builtins, val["name"], None)
        if isinstance(cls, type) and issubclass(cls, Exception):
            return cls(str(val.get("message", "")))
        return RuntimeError(f"{val['name']}: {val.get('message', '')}")
    return RuntimeError(str(val))

def invoke(op, call_args, exc_builder=None):
    enc_args = encode_readable(call_args)
    status = "fulfilled"
    if op == "platform.print" or op == "platform.log" or op == "fs.writeText" or op == "fs.writeBytes":
        q = scripted.get(op)
        if q:
            item = q.pop(0)
            status = item.get("status", "fulfilled")
            res = item.get("result", None)
        else:
            res = None
    elif op == "platform.time":
        if time_q:
            res = time_q.pop(0)
        else:
            res = 1795800000.0 + time_idx[0] * 2.0
            time_idx[0] += 1
    elif op == "platform.uuid":
        if uuid_q:
            res = uuid_q.pop(0)
        else:
            uuid_idx[0] += 1
            res = f"22222222-3333-4444-8555-{uuid_idx[0]:012d}"
    elif op == "platform.secrets":
        if secret_q:
            res = secret_q.pop(0)
        else:
            sec_idx[0] += 1
            res = f"sec_{sec_idx[0]:08x}"
    elif op == "env.get" and req.get("defaultEnvNone"):
        q = scripted.get(op)
        if q:
            item = q.pop(0)
            status = item.get("status", "fulfilled")
            res = item.get("result")
        else:
            res = None
    else:
        q = scripted.get(op)
        if not q:
            raise RuntimeError(f"Unscripted call {op}({enc_args!r})")
        item = q.pop(0)
        status = item.get("status", "fulfilled")
        res = item.get("result")

    recorded.append({
        "operation": op,
        "arguments": enc_args,
        "status": status,
        "result": encode_readable(res, allow_exceptions=True) if status == "fulfilled" else res,
    })
    if status == "rejected":
        if exc_builder is not None:
            raise exc_builder(res)
        raise _make_exc(res)
    return decode_readable(encode_readable(res))

class _HostProxy:
    def fs_read_text(self, path): return invoke("fs.readText", [path])
    def fs_write_text(self, path, text): return invoke("fs.writeText", [path, text])
    def http_get(self, url): return invoke("http.get", [url])
    def http_request(self, r): return invoke("http.request", [r])
    def kv_get(self, key): return invoke("kv_get", [key])
    def kv_set(self, key, val): return invoke("kv_set", [key, val])

io_depth = [0]
guest_builtins = dict(vars(builtins))
guest_builtins["print"] = lambda *a, **_kw: invoke("platform.print", list(a))
time.time = lambda: invoke("platform.time", [])
time.monotonic = lambda: invoke("platform.time", [])
random.seed(random_seed)

flush_io = install_replay_io_hooks(invoke, io_depth=io_depth, guest_builtins=guest_builtins)
install_replay_http_hooks(invoke, enable_urllib=True, enable_requests=True)

real_stdout = sys.stdout
sys.stdout = io.StringIO()
try:
    args = decode_readable(req["args"])
    if req.get("files"):
        files, entry_file, _ = normalize_codebase_files(req["files"], req["entryFile"])
        mod, _finder = load_virtual_entry_module(files, entry_file, guest_builtins, {"host": _HostProxy()})
        fn = getattr(mod, req["entry"])
    else:
        ns = {"__builtins__": guest_builtins, "__name__": "__guest__", "host": _HostProxy()}
        exec(compile(req["source"], "<guest>", "exec"), ns)
        fn = ns[req["entry"]]
    try:
        if inspect.iscoroutinefunction(fn):
            asyncio.run(fn(*args))
        else:
            out = fn(*args)
            if inspect.isawaitable(out):
                asyncio.run(out)
    except Exception:
        if not allow_throw:
            raise
    finally:
        flush_io()
finally:
    sys.stdout = real_stdout

real_stdout.write(json.dumps({"ok": True, "calls": recorded}, ensure_ascii=False, separators=(",", ":")) + "\n")
"""


def _record_fixture(
    *,
    entry: str,
    args: list[Any],
    files: dict[str, str] | None = None,
    entry_file: str | None = None,
    source: str | None = None,
    scripted: dict[str, list[dict[str, Any]]] | None = None,
    times: list[float] | None = None,
    uuids: list[str] | None = None,
    secrets: list[str] | None = None,
    allow_throw: bool = False,
    random_seed: int = 17,
    default_env_none: bool = False,
) -> list[dict[str, Any]]:
    payload = {
        "entry": entry,
        "args": encode_readable(args),
        "files": files,
        "entryFile": entry_file,
        "source": source,
        "scripted": scripted or {},
        "times": times or [],
        "uuids": uuids or [],
        "secrets": secrets or [],
        "allowThrow": allow_throw,
        "randomSeed": random_seed,
        "defaultEnvNone": default_env_none,
    }
    proc = subprocess.run(
        [sys.executable, "-c", _FIXTURE_RECORDER_SCRIPT, _TRAINING_DIR],
        input=_json_compact(payload),
        text=True,
        capture_output=True,
        timeout=25,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"Fixture recorder failed: {proc.stderr.strip() or proc.stdout.strip()}")
    data = json.loads(proc.stdout.strip().splitlines()[-1])
    return data["calls"]


# ---------------------------------------------------------------------------
# Distractor & symbol-padding builders for 65K multi-file Python repos
# ---------------------------------------------------------------------------

def _make_distractor_py(pkg: str, subpkg: str, mod: str, fields: list[str]) -> str:
    cls_rec = "".join(p.capitalize() for p in mod.split("_")) + "Item"
    cls_svc = "".join(p.capitalize() for p in mod.split("_")) + "Handler"
    upper = mod.upper()
    return f'''"""Sibling module `{pkg}.{subpkg}.{mod}`."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

{upper}_SCHEMA = "{pkg}.{subpkg}.{mod}.v1"
{upper}_KEYS = {tuple(fields)!r}
{upper}_LIMIT = 200


@dataclass
class {cls_rec}:
    item_id: str
    domain: str = "{pkg}"
    group: str = "{subpkg}"
    weight: float = 1.0
    meta: dict[str, Any] = field(default_factory=dict)

    def digest(self) -> str:
        return f"{{self.domain}}/{{self.group}}/{{self.item_id}}:{{len(self.meta)}}"

    def weighted_value(self, factor: float = 1.0) -> float:
        return round(float(self.meta.get("value", 0.0)) * self.weight * factor, 4)


class {cls_svc}:
    """Domain handler for `{pkg}.{subpkg}.{mod}` operations."""

    def __init__(self, tag: str = "{mod}", strict: bool = True) -> None:
        self.tag = tag
        self.strict = strict
        self._items: dict[str, {cls_rec}] = {{}}

    def put(self, item: {cls_rec}) -> str:
        key = f"{{self.tag}}:{{item.item_id}}"
        if self.strict and key in self._items:
            raise ValueError(f"duplicate item {{key}}")
        self._items[key] = item
        return key

    def snapshot(self) -> list[dict[str, Any]]:
        return [
            {{"key": k, "digest": self._items[k].digest(), "val": self._items[k].weighted_value()}}
            for k in sorted(self._items)
        ]


def normalize_{mod}(row: dict[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {{}}
    for k in {upper}_KEYS:
        v = row.get(k)
        out[k] = v.strip() if isinstance(v, str) else v
    return out


def validate_{mod}(row: dict[str, Any]) -> list[str]:
    errs: list[str] = []
    for req in {upper}_KEYS[:2]:
        if req not in row or row[req] is None:
            errs.append(f"missing:{{req}}")
    return errs
'''


_EXTRA_SUBPACKAGES: list[tuple[str, list[str]]] = [
    ("adapters", ["grpc_wire", "kafka_ingest", "redis_pool", "s3_mirror", "http_keepalive", "ndjson_codec", "csv_sink", "arrow_bridge", "otel_span", "prom_gauge"]),
    ("validators", ["schema_v1", "schema_v2", "idempotency_key", "quota_guard", "hmac_check", "tenant_bounds", "size_limit", "utf8_check", "skew_guard", "crc_verify"]),
    ("migrations", ["m001_base", "m002_idx", "m003_audit", "m004_shards", "m005_ttl", "m006_backfill", "m007_tags", "m008_views", "m009_hooks", "m010_prune"]),
    ("cli_cmds", ["inspect_cmd", "replay_cmd", "bench_cmd", "doctor_cmd", "dump_cmd", "verify_cmd", "gc_cmd", "diff_cmd", "seed_cmd", "watch_cmd"]),
    ("compat", ["v1_wire", "v2_wire", "field_map", "legacy_hooks", "xml_shim", "ini_reader", "toml_bridge", "env_alias", "path_canon", "tz_map"]),
    ("analytics", ["cohort_agg", "funnel_step", "latency_hist", "err_matrix", "cost_split", "slo_burn", "drift_score", "zscore_cut", "rollup_job", "trend_fit"]),
    ("compliance", ["pii_mask", "gdpr_erase", "soc2_log", "ttl_sweep", "access_log", "key_rotate", "consent_db", "bundle_zip", "hold_lock", "policy_chk"]),
    ("ops_util", ["liveness", "readiness", "drain_hook", "leader_lock", "shard_map", "breaker_cfg", "bulkhead", "retry_cap", "hedge_req", "backpress"]),
    ("integrations", ["jira_sync", "slack_card", "pager_v2", "dd_events", "gh_status", "linear_api", "og_alert", "email_mime", "hook_sign", "teams_post"]),
    ("testing_aux", ["seed_gen", "clock_fake", "http_tape", "snap_cmp", "fuzz_pool", "fault_inj", "load_gen", "contract", "golden", "broker_sim"]),
]


def _populate_distractors(
    files: dict[str, str],
    pkg: str,
    domain_subpkgs: list[tuple[str, list[str], list[str]]],
    extra_subpkg_count: int = 6,
    mods_per_extra: int = 8,
) -> None:
    for sub, mods, fields in domain_subpkgs:
        init_p = f"{pkg}/{sub}/__init__.py"
        files.setdefault(init_p, f'"""Subpackage `{pkg}.{sub}`."""\n')
        for m in mods:
            p = f"{pkg}/{sub}/{m}.py"
            if p not in files:
                files[p] = _make_distractor_py(pkg, sub, m, fields)
    for sub, mods in _EXTRA_SUBPACKAGES[:extra_subpkg_count]:
        init_p = f"{pkg}/{sub}/__init__.py"
        files.setdefault(init_p, f'"""Subpackage `{pkg}.{sub}`."""\n')
        for m in mods[:mods_per_extra]:
            p = f"{pkg}/{sub}/{m}.py"
            if p not in files:
                files[p] = _make_distractor_py(pkg, sub, m, ["id", "tenant", "payload", "status"])


def _class_padding(tag: str, count: int = 4) -> str:
    blocks = []
    for i in range(1, count + 1):
        blocks.append(f'''
    def _audit_{tag.lower()}_invariant_{i}(self, data: dict[str, Any]) -> tuple[bool, list[str]]:
        """Diagnostic invariant #{i} for {tag}."""
        notes: list[str] = []
        if not isinstance(data, dict):
            return False, ["{tag.lower()}:not-dict"]
        if len(data) > {48 * i}:
            notes.append("{tag.lower()}:size-cap")
        for k, v in sorted(data.items()):
            if isinstance(k, str) and k.startswith("__"):
                notes.append(f"{tag.lower()}:reserved:{{k}}")
            if isinstance(v, str) and len(v) > {2048 * i}:
                notes.append(f"{tag.lower()}:oversize:{{k}}")
        return len(notes) == 0, notes
''')
    return "\n".join(blocks)


def _sibling_unused_padding(tag: str, count: int = 4) -> str:
    """Pad a module past 3.5 KB with realistic sibling helpers to trigger AST symbol code.load."""
    blocks = []
    for i in range(1, count + 1):
        blocks.append(f'''

class {tag}BatchExporter{i}:
    """Offline batch exporter #{i} for {tag} diagnostics."""

    LIMIT = {80 * i}
    TAG = "{tag.lower()}_b{i}"

    def __init__(self, shard: str, ttl_days: int = {14 * i}) -> None:
        self.shard = shard
        self.ttl_days = ttl_days
        self.history: list[dict[str, Any]] = []

    def stage(self, rows: list[dict[str, Any]]) -> dict[str, Any]:
        kept = [r for r in rows[: self.LIMIT] if r.get("id") is not None]
        rec = {{"shard": self.shard, "count": len(kept), "tag": self.TAG}}
        self.history.append(rec)
        return rec


def summarize_{tag.lower()}_window_{i}(rows: list[dict[str, Any]], cutoff: float = {0.2 * i:.2f}) -> dict[str, Any]:
    hi = [r for r in rows if float(r.get("score", 0.0)) >= cutoff]
    return {{"tag": "{tag.lower()}_{i}", "total": len(rows), "above": len(hi)}}
''')
    return "\n".join(blocks)


# ===========================================================================
# BUCKET A — PART A1: 20 Pure-Python OSS Multi-File Repo Families (60 tasks)
# ===========================================================================

def _collect_pkg_files(
    site_packages: Path,
    pkg_name: str,
    *,
    include_prefixes: tuple[str, ...] | None = None,
    exclude_substrings: tuple[str, ...] = ("test", "tests", "__pycache__"),
    max_files: int = 120,
    max_file_bytes: int = 250_000,
) -> dict[str, str]:
    root = site_packages / pkg_name
    if not root.is_dir():
        raise FileNotFoundError(f"Package {pkg_name} missing in {site_packages}")
    files: dict[str, str] = {}
    all_py = sorted(root.rglob("*.py"))
    for p in all_py:
        rel_sub = str(p.relative_to(root)).replace("\\", "/")
        rel = f"{pkg_name}/{rel_sub}"
        parts_lower = [part.lower() for part in p.relative_to(root).parts]
        if any(ex in parts_lower for ex in exclude_substrings):
            continue
        if include_prefixes is not None:
            if not (rel_sub == "__init__.py" or any(rel_sub.startswith(pref) for pref in include_prefixes)):
                continue
        if p.stat().st_size > max_file_bytes:
            continue
        text = p.read_text(encoding="utf-8", errors="replace")
        if "\x00" in text:
            continue
        files[rel] = text
        if len(files) >= max_files:
            break
    # Ensure parent __init__.py exist for every selected nested file
    for rel in list(files.keys()):
        parts = rel.split("/")
        for depth in range(1, len(parts) - 1):
            init_rel = "/".join(parts[:depth]) + "/__init__.py"
            if init_rel not in files:
                disk = site_packages / init_rel
                if disk.is_file() and disk.stat().st_size <= max_file_bytes:
                    files[init_rel] = disk.read_text(encoding="utf-8", errors="replace")
    return files


def build_bucket_a1_oss_multifile(site_packages: Path) -> list[dict[str, Any]]:
    """Build 60 tasks across 20 pure-Python OSS multi-file packages (100% disjoint from RealExecBench)."""
    specs: list[dict[str, Any]] = [
        # 1. packaging — version & specifier matching
        {
            "fam": "stage10-py-oss:packaging:version_spec",
            "pkgs": [("packaging", None, 40)],
            "extra_distractors": ("pkg_ops", 6, 6),
            "entry_file": "pkg_ops/version_probe.py",
            "entry_src": '''"""Multi-file probe exercising `packaging` version, specifier, and requirement resolution."""
from packaging.version import Version, InvalidVersion
from packaging.specifiers import SpecifierSet
from packaging.requirements import Requirement

def run(req_text: str, candidates: list[str]) -> dict:
    req = Requirement(req_text)
    valid = []
    invalid = []
    for raw in candidates:
        try:
            valid.append(Version(raw))
        except InvalidVersion:
            invalid.append(raw)
    ordered = sorted(valid)
    matched = [str(v) for v in ordered if v in req.specifier]
    return {
        "name": req.name,
        "extras": sorted(req.extras),
        "matched": matched,
        "latest": matched[-1] if matched else None,
        "invalid": invalid,
    }
''',
            "variants": [
                ("basic", ["alpha-lib[fast,io]>=1.2,<2.0", ["1.1.9", "1.2.0", "1.4.2", "2.0.0", "bad!!"]]),
                ("prerelease", ["core-sdk>=2.0.0a1,!=2.1.0,<3.0", ["1.9.9", "2.0.0a2", "2.1.0", "2.3.1"]]),
                ("compatible", ["web-kit~=1.4.2", ["1.4.1", "1.4.2", "1.4.9", "1.5.0"]]),
            ],
        },
        # 2. packaging — markers & sdist parsing (100% deterministic, no frozenset hash order)
        {
            "fam": "stage10-py-oss:packaging:markers_sdist",
            "pkgs": [("packaging", None, 40)],
            "extra_distractors": ("wheel_ops", 7, 7),
            "entry_file": "wheel_ops/marker_probe.py",
            "entry_src": '''"""Multi-file probe exercising `packaging.markers` and `packaging.utils`."""
from packaging.markers import Marker
from packaging.utils import canonicalize_name, canonicalize_version, parse_sdist_filename

def run(marker_expr: str, env: dict, sdist_names: list[str]) -> dict:
    m = Marker(marker_expr)
    env_ok = m.evaluate(env)
    parsed = []
    for sd in sdist_names:
        name, ver = parse_sdist_filename(sd)
        parsed.append({"name": canonicalize_name(name), "ver": canonicalize_version(ver)})
    return {"marker_ok": env_ok, "sdists": parsed}
''',
            "variants": [
                ("linux", ['python_version >= "3.10" and sys_platform == "linux"', {"python_version": "3.12", "sys_platform": "linux"}, ["Demo_Pkg-1.2.0.tar.gz"]]),
                ("darwin", ['os_name == "posix" and platform_machine == "arm64"', {"os_name": "posix", "platform_machine": "x86_64"}, ["Fast_Tool-2.0.1.zip"]]),
                ("multi", ['extra == "dev" or python_version < "3.11"', {"extra": "dev", "python_version": "3.13"}, ["Alpha_One-0.9.0.tar.gz", "Beta_Two-3.1.0.tar.gz"]]),
            ],
        },
        # 3. mdurl — RFC 3986 parse/encode/decode/format
        {
            "fam": "stage10-py-oss:mdurl:rfc3986_codec",
            "pkgs": [("mdurl", None, 20)],
            "extra_distractors": ("link_svc", 9, 8),
            "entry_file": "link_svc/url_probe.py",
            "entry_src": '''"""Multi-file probe exercising `mdurl` URL parsing, percent-encoding, and reformatting."""
import mdurl

def run(urls: list[str], extra_path: str) -> dict:
    out = []
    for raw in urls:
        enc = mdurl.encode(raw)
        parsed = mdurl.parse(enc)
        dec = mdurl.decode(enc)
        rebuilt = mdurl.format(parsed)
        out.append({
            "protocol": parsed.protocol,
            "hostname": parsed.hostname,
            "port": parsed.port,
            "pathname": parsed.pathname,
            "rebuilt": rebuilt,
            "decoded": dec,
        })
    return {"count": len(out), "extra_encoded": mdurl.encode(extra_path), "items": out}
''',
            "variants": [
                ("spaces", [["https://example.org:8443/docs/my guide?q=a b#sec 1"], "/files/report 2026.pdf"]),
                ("unicode", [["http://api.local/v1/café?tag=x+y", "mailto:ops@example.net"], "/search/naïve"]),
                ("relative", [["/a/b/../c?k=1&k=2#top", "https://sub.domain.io/p%20q"], "/img/a%25b.png"]),
            ],
        },
        # 4. markdown_it — HTML rendering across 66 real files (bounded zero+rules preset for <56K tok)
        {
            "fam": "stage10-py-oss:markdown_it:html_render",
            "pkgs": [("markdown_it", None, 80), ("mdurl", None, 10)],
            "extra_distractors": ("doc_svc", 2, 5),
            "entry_file": "doc_svc/md_render.py",
            "entry_src": '''"""Multi-file probe rendering Markdown documents via `markdown_it`."""
from markdown_it import MarkdownIt

def run(doc: str, rules: list[str]) -> dict:
    md = MarkdownIt("zero").enable(rules)
    html = md.render(doc)
    lines = [ln for ln in html.splitlines() if ln.strip()]
    return {"rules": rules, "line_count": len(lines), "html": html}
''',
            "variants": [
                ("heading_emph", ["# Title\n\nHello *world* and **bold**.\n", ["heading", "emphasis"]]),
                ("backticks", ["Run `build` with *flags*.\n\nSecond line.\n", ["emphasis", "backticks"]]),
                ("list_quote", ["## Notes\n\n- alpha\n- beta\n", ["heading", "list"]]),
            ],
        },
        # 5. markdown_it — AST token inspection (bounded zero+rules preset, no triple backticks)
        {
            "fam": "stage10-py-oss:markdown_it:token_stream",
            "pkgs": [("markdown_it", None, 80), ("mdurl", None, 10)],
            "extra_distractors": ("ast_svc", 2, 5),
            "entry_file": "ast_svc/md_tokens.py",
            "entry_src": '''"""Multi-file probe extracting structured headings and paragraphs from `markdown_it` tokens."""
from markdown_it import MarkdownIt

def run(doc: str) -> dict:
    md = MarkdownIt("zero").enable(["heading", "emphasis", "blockquote"])
    tokens = md.parse(doc)
    types = [t.type for t in tokens]
    headings = []
    for i, t in enumerate(tokens):
        if t.type == "heading_open" and i + 1 < len(tokens):
            headings.append({"tag": t.tag, "text": tokens[i + 1].content})
    return {"token_count": len(tokens), "types": types[:16], "headings": headings}
''',
            "variants": [
                ("intro", ["# Intro\n\nHello *world*.\n\n## End\n"]),
                ("quote", ["### Spec\n\n> Quoted **text** here\n"]),
                ("multi_head", ["# H1\n\nPara.\n\n## H2\n\nMore *info*.\n"]),
            ],
        },
        # 6. dateutil — rrule recurrence & relativedelta
        {
            "fam": "stage10-py-oss:dateutil:rrule_calendar",
            "pkgs": [("dateutil", None, 30)],
            "extra_distractors": ("cal_svc", 8, 7),
            "entry_file": "cal_svc/schedule_probe.py",
            "entry_src": '''"""Multi-file probe computing recurring calendar dates via `dateutil.rrule` and `relativedelta`."""
from datetime import datetime
from dateutil.rrule import rrule, WEEKLY, MONTHLY, MO, WE, FR
from dateutil.relativedelta import relativedelta

def run(start_iso: str, mode: str, count: int) -> dict:
    dt = datetime.fromisoformat(start_iso)
    if mode == "mwf":
        rule = rrule(WEEKLY, count=count, byweekday=(MO, WE, FR), dtstart=dt)
    else:
        rule = rrule(MONTHLY, count=count, bymonthday=-1, dtstart=dt)
    dates = [d.strftime("%Y-%m-%d") for d in rule]
    shifted = (dt + relativedelta(months=2, days=10)).strftime("%Y-%m-%d")
    return {"mode": mode, "dates": dates, "shifted": shifted}
''',
            "variants": [
                ("mwf", ["2026-01-05T09:00:00", "mwf", 5]),
                ("month_end", ["2026-01-31T00:00:00", "month_end", 4]),
                ("leap_year", ["2024-01-31T12:00:00", "month_end", 4]),
            ],
        },
        # 7. dateutil — parser & easter (explicit default datetime => 0 platform.time calls)
        {
            "fam": "stage10-py-oss:dateutil:parser_easter",
            "pkgs": [("dateutil", None, 30)],
            "extra_distractors": ("time_svc", 8, 7),
            "entry_file": "time_svc/parse_probe.py",
            "entry_src": '''"""Multi-file probe parsing flexible timestamps and Easter dates via `dateutil`."""
from datetime import datetime
from dateutil import parser, easter

def run(samples: list[str], years: list[int]) -> dict:
    base = datetime(2026, 1, 1, 0, 0, 0)
    parsed = []
    for s in samples:
        dt = parser.parse(s, default=base)
        parsed.append({"iso": dt.isoformat(), "weekday": dt.weekday()})
    easters = {str(y): easter.easter(y).isoformat() for y in years}
    return {"parsed": parsed, "easters": easters}
''',
            "variants": [
                ("rfc_iso", [["2026-07-04T15:30:00Z", "Nov 27, 2026 08:15"], [2025, 2026]]),
                ("slash_dayfirst", [["2026/03/19 10:00", "14 Feb 2027"], [2024, 2027]]),
                ("compact", [["20261128T060000Z", "March 1 2028 23:45"], [2028, 2030]]),
            ],
        },
        # 8. h11 — HTTP/1.1 protocol state machine
        {
            "fam": "stage10-py-oss:h11:http11_fsm",
            "pkgs": [("h11", None, 20)],
            "extra_distractors": ("wire_svc", 9, 8),
            "entry_file": "wire_svc/http11_probe.py",
            "entry_src": '''"""Multi-file probe driving `h11` client and server HTTP/1.1 framing state machines."""
import h11

def run(method: str, target: str, body_text: str) -> dict:
    client = h11.Connection(h11.CLIENT)
    server = h11.Connection(h11.SERVER)
    body = body_text.encode("utf-8")
    wire = client.send(h11.Request(
        method=method,
        target=target,
        headers=[("Host", "api.local"), ("Content-Length", str(len(body)))],
    ))
    if body:
        wire += client.send(h11.Data(data=body))
    wire += client.send(h11.EndOfMessage())
    server.receive_data(wire)
    events = []
    while True:
        ev = server.next_event()
        if ev is h11.NEED_DATA or ev is h11.PAUSED:
            break
        if isinstance(ev, h11.Request):
            events.append({"type": "Request", "method": ev.method.decode(), "target": ev.target.decode()})
        elif isinstance(ev, h11.Data):
            events.append({"type": "Data", "body": bytes(ev.data).decode()})
        elif isinstance(ev, h11.EndOfMessage):
            events.append({"type": "EndOfMessage"})
            break
    return {"wire_len": len(wire), "events": events, "server_state": str(server.our_state)}
''',
            "variants": [
                ("get_empty", ["GET", "/v1/health", ""]),
                ("post_json", ["POST", "/v1/items", '{"id":7,"ok":true}']),
                ("put_body", ["PUT", "/v2/cfg?dry=1", "mode=strict"]),
            ],
        },
        # 9. hpack — HTTP/2 header table & Huffman compression
        {
            "fam": "stage10-py-oss:hpack:header_codec",
            "pkgs": [("hpack", None, 20)],
            "extra_distractors": ("h2_hdr", 9, 8),
            "entry_file": "h2_hdr/hpack_probe.py",
            "entry_src": '''"""Multi-file probe exercising `hpack` dynamic table indexing and Huffman codec."""
from hpack import Encoder, Decoder

def run(requests: list[list[list[str]]], use_huffman: bool) -> dict:
    enc = Encoder()
    dec = Decoder()
    sizes = []
    decoded_all = []
    for hdrs in requests:
        pairs = [(k, v) for k, v in hdrs]
        raw = enc.encode(pairs, huffman=use_huffman)
        sizes.append(len(raw))
        decoded = [[k, v] for k, v in dec.decode(raw)]
        decoded_all.append(decoded)
    return {"encoded_sizes": sizes, "decoded": decoded_all}
''',
            "variants": [
                ("huffman_reuse", [[[[":method", "GET"], [":path", "/api/v1"], ["x-tenant", "acme"]], [[":method", "GET"], [":path", "/api/v1"], ["x-tenant", "acme"]]], True]),
                ("plain_headers", [[[[":method", "POST"], [":path", "/submit"], ["content-type", "application/json"]]], False]),
                ("dynamic_update", [[[[":method", "GET"], [":path", "/a"], ["x-trace", "t1"]], [[":method", "GET"], [":path", "/b"], ["x-trace", "t1"]]], True]),
            ],
        },
        # 10. hyperframe — HTTP/2 binary frame serialization & parsing
        {
            "fam": "stage10-py-oss:hyperframe:http2_frames",
            "pkgs": [("hyperframe", None, 20)],
            "extra_distractors": ("frame_svc", 9, 8),
            "entry_file": "frame_svc/frame_probe.py",
            "entry_src": '''"""Multi-file probe serializing and parsing HTTP/2 binary frames via `hyperframe`."""
from hyperframe.frame import DataFrame, SettingsFrame, WindowUpdateFrame, PingFrame, Frame

def run(stream_id: int, payload: str, win_inc: int) -> dict:
    frames = [
        SettingsFrame(0, settings={SettingsFrame.MAX_CONCURRENT_STREAMS: 64}),
        DataFrame(stream_id, data=payload.encode("utf-8"), flags={"END_STREAM"}),
        WindowUpdateFrame(stream_id, window_increment=win_inc),
        PingFrame(0, opaque_data=b"12345678"),
    ]
    parsed = []
    for f in frames:
        raw = f.serialize()
        obj, body_len = Frame.parse_frame_header(raw[:9])
        obj.parse_body(memoryview(raw[9 : 9 + body_len]))
        parsed.append({
            "type": type(obj).__name__,
            "stream_id": obj.stream_id,
            "flags": sorted(obj.flags),
            "bytes": len(raw),
        })
    return {"frames": parsed}
''',
            "variants": [
                ("stream1", [1, "hello-h2", 4096]),
                ("stream3", [3, '{"ok":1}', 65535]),
                ("stream5", [5, "abc", 1024]),
            ],
        },
        # 11. h2 — HTTP/2 flow-control WindowManager, Settings & Config (h2 + hyperframe, <50K tok)
        {
            "fam": "stage10-py-oss:h2:conn_fsm",
            "pkgs": [("h2", None, 25), ("hyperframe", None, 10)],
            "extra_distractors": ("h2_svc", 6, 7),
            "entry_file": "h2_svc/conn_probe.py",
            "entry_src": '''"""Multi-file probe exercising `h2.settings`, `h2.config`, `h2.windows`, and `hyperframe`."""
from h2.config import H2Configuration
from h2.settings import Settings, SettingCodes
from h2.windows import WindowManager
from hyperframe.frame import WindowUpdateFrame

def run(max_win: int, recv_chunks: list[int], max_streams: int) -> dict:
    cfg = H2Configuration(client_side=True)
    st = Settings(client=cfg.client_side, initial_values={SettingCodes.MAX_CONCURRENT_STREAMS: max_streams})
    wm = WindowManager(max_window_size=max_win)
    updates = []
    for sz in recv_chunks:
        wm.window_opened(sz)
        inc = wm.process_bytes(sz)
        if inc:
            f = WindowUpdateFrame(stream_id=1, window_increment=inc)
            updates.append({"inc": inc, "frame_bytes": len(f.serialize())})
    return {
        "client_side": cfg.client_side,
        "max_streams": st.max_concurrent_streams,
        "current_win": wm.current_window_size,
        "updates": updates,
    }
''',
            "variants": [
                ("flow1", [65535, [16384, 16384, 8192], 128]),
                ("flow2", [32768, [10000, 10000, 5000], 64]),
                ("flow3", [16384, [4096, 4096, 4096], 256]),
            ],
        },
        # 12. click — multi-file ParamType validation & HelpFormatter across `click/` (<48K tok)
        {
            "fam": "stage10-py-oss:click:cli_group_parse",
            "pkgs": [("click", None, 30)],
            "extra_distractors": ("cli_app", 6, 7),
            "entry_file": "cli_app/click_probe.py",
            "entry_src": '''"""Multi-file probe exercising `click.types` and `click.formatting`."""
from click.formatting import HelpFormatter, join_options
from click.types import Choice, IntRange

def run(raw_port: str, raw_mode: str, rows: list[list[str]]) -> dict:
    port_t = IntRange(1, 65535)
    mode_t = Choice(["dev", "staging", "prod"], case_sensitive=False)
    port = port_t.convert(raw_port, None, None)
    mode = mode_t.convert(raw_mode, None, None)
    fmt = HelpFormatter(indent_increment=2, width=56)
    fmt.write_usage("svcctl", "[OPTIONS] CMD")
    with fmt.section("Options"):
        fmt.write_dl([(r[0], r[1]) for r in rows])
    joined, slash = join_options(["-v", "--verbose"])
    return {"port": port, "mode": mode, "joined": joined, "slash": slash, "help": fmt.getvalue()}
''',
            "variants": [
                ("prod_ok", ["8080", "PROD", [["-p, --port", "Listen port."], ["-m, --mode", "Run mode."]]]),
                ("dev_ok", ["3000", "dev", [["-v, --verbose", "Enable debug logs."]]]),
                ("staging_ok", ["443", "Staging", [["-c, --config", "Path to json."], ["-n, --dry-run", "Preview only."]]]),
            ],
        },
        # 13. attr — attrs class generation, validators, converters, asdict
        {
            "fam": "stage10-py-oss:attr:validators_converters",
            "pkgs": [("attr", None, 25), ("attrs", None, 10)],
            "extra_distractors": ("model_svc", 8, 7),
            "entry_file": "model_svc/attrs_probe.py",
            "entry_src": '''"""Multi-file probe exercising `attr` dataclasses, converters, validators, and evolve."""
import attr

@attr.s(auto_attribs=True, frozen=True)
class JobSpec:
    name: str = attr.ib(converter=lambda s: s.strip().lower())
    retries: int = attr.ib(default=2, validator=[attr.validators.instance_of(int), attr.validators.ge(0)])
    tags: tuple[str, ...] = attr.ib(factory=tuple, converter=tuple)

def run(name: str, retries: int, tags: list[str], bump: int) -> dict:
    try:
        job = JobSpec(name=name, retries=retries, tags=tags)
        job2 = attr.evolve(job, retries=job.retries + bump)
        return {"ok": True, "orig": attr.asdict(job), "evolved": attr.asdict(job2)}
    except (ValueError, TypeError) as exc:
        return {"ok": False, "error": type(exc).__name__, "msg": str(exc)}
''',
            "variants": [
                ("valid", ["  Build_API ", 2, ["ci", "fast"], 3]),
                ("zero_retry", ["Deploy", 0, ["prod"], 1]),
                ("neg_invalid", ["BadJob", -1, [], 1]),
            ],
        },
        # 14. httpx — URL & QueryParams parsing/manipulation across httpx package
        {
            "fam": "stage10-py-oss:httpx:urls_queryparams",
            "pkgs": [("httpx", None, 40)],
            "extra_distractors": ("net_svc", 6, 7),
            "entry_file": "net_svc/httpx_url_probe.py",
            "entry_src": '''"""Multi-file probe exercising `httpx._urls.URL` and `QueryParams`."""
from httpx._urls import URL

def run(base_url: str, rel_path: str, page: int) -> dict:
    u = URL(base_url).copy_set_param("page", str(page))
    joined = u.join(rel_path)
    return {
        "scheme": joined.scheme,
        "host": joined.host,
        "port": joined.port,
        "path": joined.path,
        "params": [list(p) for p in joined.params.multi_items()],
        "str": str(joined),
    }
''',
            "variants": [
                ("api_join", ["https://API.Example.com:443/v1/items?tag=core", "/v2/search?q=py", 2]),
                ("rel_path", ["http://svc.internal:8080/a/b/c?x=1", "../d?y=2", 5]),
                ("keep_port", ["https://edge.io:8443/jobs?env=prod", "/jobs/42?verbose=1", 1]),
            ],
        },
        # 15. rich — Box borders, Measurement clamping, ColorTriplet, and filesize formatting (<48K tok)
        {
            "fam": "stage10-py-oss:rich:markup_text_wrap",
            "pkgs": [("rich", None, 95)],
            "extra_distractors": ("tui_svc", 0, 0),
            "entry_file": "tui_svc/rich_probe.py",
            "entry_src": '''"""Multi-file probe exercising `rich.box`, `rich.measure`, `rich.color_triplet`, and `rich.filesize`."""
from rich.box import ROUNDED, SQUARE
from rich.color_triplet import ColorTriplet
from rich.filesize import decimal
from rich.measure import Measurement

def run(widths: list[int], rgb: list[int], byte_sizes: list[int], use_rounded: bool) -> dict:
    box = ROUNDED if use_rounded else SQUARE
    trip = ColorTriplet(rgb[0], rgb[1], rgb[2])
    meas = Measurement(min(widths), sum(widths)).clamp(min_width=4, max_width=24)
    return {
        "top": box.get_top(widths),
        "bot": box.get_bottom(widths),
        "hex": trip.hex,
        "clamped": [meas.minimum, meas.maximum],
        "sizes": [decimal(b) for b in byte_sizes],
    }
''',
            "variants": [
                ("rounded", [[4, 6, 3], [255, 128, 0], [512, 2400, 1_500_000], True]),
                ("square", [[8, 10], [16, 64, 192], [1000, 9_500_000], False]),
                ("compact", [[3, 3, 3], [32, 200, 96], [250, 48_000], True]),
            ],
        },
        # 16. pygments — lexical tokenization across pygments core + python/json lexers
        {
            "fam": "stage10-py-oss:pygments:lexer_tokenize",
            "pkgs": [("pygments", ("token.py", "lexer.py", "util.py", "filter.py", "filters/__init__.py", "modeline.py", "plugin.py", "regexopt.py", "unistring.py", "lexers/__init__.py", "lexers/_mapping.py", "lexers/python.py", "lexers/data.py"), 60)],
            "extra_distractors": ("syn_svc", 7, 7),
            "entry_file": "syn_svc/lex_probe.py",
            "entry_src": '''"""Multi-file probe tokenizing source snippets with Pygments Python and JSON lexers."""
from pygments.lexers.python import PythonLexer
from pygments.lexers.data import JsonLexer

def run(lang: str, code: str) -> dict:
    lexer = PythonLexer() if lang == "python" else JsonLexer()
    toks = [[str(t), v] for t, v in lexer.get_tokens(code) if v.strip()]
    return {"lang": lang, "count": len(toks), "tokens": toks[:12]}
''',
            "variants": [
                ("python_fn", ["python", "def add(a, b):\n    return a + b * 2\n"]),
                ("json_obj", ["json", '{"id": 42, "ok": true, "tags": ["a", "b"]}']),
                ("python_cls", ["python", "class Box:\n    val = 3.14\n"]),
            ],
        },
        # 17. httpcore — Request/Response/URL protocol model construction
        {
            "fam": "stage10-py-oss:httpcore:request_models",
            "pkgs": [("httpcore", None, 40)],
            "extra_distractors": ("wire_core", 7, 7),
            "entry_file": "wire_core/httpcore_probe.py",
            "entry_src": '''"""Multi-file probe exercising `httpcore._models` URL, Request, and Response."""
from httpcore._models import Request, Response

def run(method: str, url: str, headers: list[list[str]], status: int) -> dict:
    req = Request(method, url, headers=[(k, v) for k, v in headers])
    resp = Response(status=status, headers=[(b"content-type", b"application/json")], content=b'{"ok":true}')
    return {
        "method": req.method.decode("ascii"),
        "scheme": req.url.scheme.decode("ascii"),
        "host": req.url.host.decode("ascii"),
        "port": req.url.port,
        "target": req.url.target.decode("ascii"),
        "resp_status": resp.status,
        "resp_len": len(resp.read()),
    }
''',
            "variants": [
                ("get_api", ["GET", "https://api.example.io:8443/v1/items?k=1", [["X-Env", "prod"]], 200]),
                ("post_svc", ["POST", "http://svc.local/jobs", [["Accept", "application/json"]], 201]),
                ("del_item", ["DELETE", "https://edge.io/cache/99", [["X-Req", "r1"]], 204]),
            ],
        },
        # 18. chz — typed config dataclass construction & Blueprint resolution
        {
            "fam": "stage10-py-oss:chz:typed_config",
            "pkgs": [("chz", None, 30)],
            "extra_distractors": ("cfg_svc", 8, 7),
            "entry_file": "cfg_svc/chz_probe.py",
            "entry_src": '''"""Multi-file probe exercising `chz` typed configuration objects and field metadata."""
import chz

@chz.chz
class TrainConfig:
    lr: float = 0.001
    batch_size: int = 32
    tag: str = "base"

def run(lr: float, batch_size: int, tag: str) -> dict:
    cfg = TrainConfig(lr=lr, batch_size=batch_size, tag=tag)
    fields = sorted(TrainConfig.__chz_fields__.keys())
    return {"lr": cfg.lr, "batch_size": cfg.batch_size, "tag": cfg.tag, "fields": fields}
''',
            "variants": [
                ("p1", [0.0005, 64, "stage10"]),
                ("p2", [0.002, 16, "ablation"]),
                ("p3", [0.001, 128, "prod"]),
            ],
        },
        # 19. tqdm — progress meter formatting & human-readable units
        {
            "fam": "stage10-py-oss:tqdm:meter_format",
            "pkgs": [("tqdm", None, 35)],
            "extra_distractors": ("prog_svc", 7, 7),
            "entry_file": "prog_svc/tqdm_probe.py",
            "entry_src": '''"""Multi-file probe formatting progress bars and SI rates via `tqdm.std.tqdm`."""
from tqdm.std import tqdm

def run(n: int, total: int, elapsed: float, unit_scale: bool) -> dict:
    meter = tqdm.format_meter(n=n, total=total, elapsed=elapsed, ncols=60, ascii=True, unit="B", unit_scale=unit_scale)
    sizeof = tqdm.format_sizeof(n)
    interval = tqdm.format_interval(elapsed)
    return {"meter": meter, "sizeof": sizeof, "interval": interval}
''',
            "variants": [
                ("half", [5120, 10240, 12.5, True]),
                ("done", [100, 100, 4.0, False]),
                ("large", [2_500_000, 5_000_000, 125.0, True]),
            ],
        },
        # 20. httpx — Headers & Deflate/LineDecoder streaming pipeline
        {
            "fam": "stage10-py-oss:httpx:headers_decoders",
            "pkgs": [("httpx", None, 40)],
            "extra_distractors": ("http_svc", 7, 7),
            "entry_file": "http_svc/httpx_dec_probe.py",
            "entry_src": '''"""Multi-file probe exercising `httpx._models.Headers` and `httpx._decoders`."""
import zlib
from httpx._models import Headers
from httpx._decoders import DeflateDecoder, LineDecoder

def run(headers_in: list[list[str]], payload: str, chunks: list[str]) -> dict:
    hdrs = Headers([(k, v) for k, v in headers_in])
    dec = DeflateDecoder()
    unpacked = (dec.decode(zlib.compress(payload.encode("utf-8"))) + dec.flush()).decode("utf-8")
    ld = LineDecoder()
    lines = []
    for c in chunks:
        lines.extend(ld.decode(c))
    lines.extend(ld.flush())
    return {
        "content_type": hdrs.get("content-type"),
        "tags": hdrs.get_list("x-tag"),
        "unpacked": unpacked,
        "lines": lines,
    }
''',
            "variants": [
                ("utf8", [[["Content-Type", "application/json"], ["X-Tag", "v1"], ["x-tag", "fast"]], "alpha-beta-gamma", ["l1\r", "\nl2\nl3"]]),
                ("plain", [[["content-type", "text/plain"], ["X-Tag", "ops"]], "hello-httpx-stream", ["a\nb", "\nc\r\nd"]]),
                ("multi", [[["CONTENT-TYPE", "text/html"], ["x-tag", "a"], ["X-Tag", "b"]], "compressed-body-42", ["first\n", "second"]]),
            ],
        },
    ]

    tasks: list[dict[str, Any]] = []
    for spec in specs:
        files: dict[str, str] = {}
        for pkg_name, inc_pref, max_f in spec["pkgs"]:
            pkg_files = _collect_pkg_files(
                site_packages,
                pkg_name,
                include_prefixes=inc_pref,
                max_files=max_f,
            )
            files.update(pkg_files)
        ep = spec["entry_file"]
        ep_pkg = ep.split("/")[0]
        files[f"{ep_pkg}/__init__.py"] = f'"""Probe package `{ep_pkg}`."""\n'
        files[ep] = spec["entry_src"]
        d_pkg, d_sub_cnt, d_mods = spec["extra_distractors"]
        _populate_distractors(files, d_pkg, [], extra_subpkg_count=d_sub_cnt, mods_per_extra=d_mods)

        for v_name, v_args in spec["variants"]:
            tid = f"{spec['fam'].replace(':', '-').replace('_', '-')}-{v_name}"
            calls = _record_fixture(
                entry="run",
                args=v_args,
                files=files,
                entry_file=ep,
                default_env_none=True,
            )
            tasks.append({
                "id": tid,
                "family": spec["fam"],
                "language": "py",
                "files": files,
                "entryFile": ep,
                "entry": "run",
                "args": encode_readable(v_args),
                "fixture": {"calls": calls},
                "tier": 5,
                "features": ["long-context-65k", "multifile-codebase", "code-load", "oss-real", "python"] + (["effectful"] if calls else []),
                "metadata": {
                    "bucket": "bucket_a_oss_65k",
                    "sourceOrigin": "stage10-py-oss-multifile",
                },
            })
    return tasks


# ===========================================================================
# BUCKET A — PART A2: 24 Brand-New 55-145 File Synthetic Multi-File Repos (72 tasks)
# ===========================================================================

def _build_synthetic_repo_spec(
    *,
    pkg: str,
    title: str,
    env_var: str,
    cfg_default: str,
    http_url: str,
    fallback_path: str,
    report_dir: str,
    shell_cmd: list[str] | None,
    engine_cls: str,
    engine_body: str,
    policy_cls: str,
    policy_body: str,
    fallback_body: str,
    domain_subpkgs: list[tuple[str, list[str], list[str]]],
    extra_subpkg_count: int,
    mods_per_extra: int,
    cfg_payload: dict[str, Any],
    run_args: list[Any],
    live_http_body: dict[str, Any],
    fallback_file_body: dict[str, Any],
    throw_http_body: dict[str, Any],
    shell_stdout: str = "verified-ok\n",
) -> list[dict[str, Any]]:
    """Generate a full 55-145 file multi-file Python repository + 3 verified variants (2 causal pair + 1 throw)."""
    files: dict[str, str] = {
        f"{pkg}/__init__.py": f'"""{title}."""\nVERSION = "1.0.0"\n',
        f"{pkg}/api/__init__.py": "",
        f"{pkg}/config/__init__.py": "",
        f"{pkg}/client/__init__.py": "",
        f"{pkg}/core/__init__.py": "",
        f"{pkg}/policy/__init__.py": "",
        f"{pkg}/storage/__init__.py": "",
        f"{pkg}/audit/__init__.py": "",
    }

    shell_import = f"from {pkg}.client.shell_verify import run_shell_check\n" if shell_cmd else ""
    shell_call = (
        f"    shell_out = run_shell_check(cfg['shell_cmd'], batch_id)\n"
        f"    summary['shell_check'] = shell_out\n"
        if shell_cmd
        else ""
    )

    files[f"{pkg}/api/pipeline.py"] = f'''"""Primary entrypoint for {title}."""

from __future__ import annotations

from {pkg}.audit.logger import emit_event
from {pkg}.client.remote_feed import fetch_reference_data
from {pkg}.config.settings import load_settings
from {pkg}.core.engine import {engine_cls}
from {pkg}.policy.gate import {policy_cls}
from {pkg}.storage.sqlite_repo import StateStore
from {pkg}.storage.writer import write_artifact
{shell_import}

def run(batch_id: str, items: list[dict]) -> dict:
    """Execute end-to-end {pkg} pipeline with causal fallback and policy gating."""
    cfg = load_settings()
    emit_event("INFO", f"{pkg} start batch={{batch_id}} env={{cfg['env']}}")

    feed = fetch_reference_data(cfg["endpoint"], batch_id, cfg["fallback_path"])
    engine = {engine_cls}(cfg=cfg, ref_data=feed["data"])
    processed = engine.process_batch(items)
    summary = engine.summarize(processed)

    gate = {policy_cls}(cfg=cfg)
    verdict = gate.evaluate(summary, processed, source=feed["source"])

    store = StateStore()
    store.setup()
    store.insert_rows(batch_id, processed)
    db_agg = store.aggregate(batch_id)
    store.close()

    if not verdict["approved"]:
        emit_event("ERROR", f"{pkg} rejected batch={{batch_id}} reason={{verdict['reason']}}")
        raise ValueError(f"{pkg} gate rejected: {{verdict['reason']}}")

{shell_call}    artifact = {{
        "batch_id": batch_id,
        "env": cfg["env"],
        "source": feed["source"],
        "summary": summary,
        "verdict": verdict,
        "db_agg": db_agg,
    }}
    out_path = write_artifact(cfg["report_dir"], batch_id, artifact)
    emit_event("INFO", f"{pkg} committed batch={{batch_id}} path={{out_path}}")
    return {{
        "status": "ok",
        "batch_id": batch_id,
        "source": feed["source"],
        "report_path": out_path,
        "summary": summary,
        "db_agg": db_agg,
        "flags": verdict["flags"],
    }}
'''

    files[f"{pkg}/config/settings.py"] = f'''"""Environment & JSON settings loader for {pkg}."""

from __future__ import annotations

import json
import os


def load_settings() -> dict:
    env_name = os.getenv("{env_var}_ENV") or "prod"
    cfg_path = os.getenv("{env_var}_CONFIG") or "{cfg_default}"
    cfg = {{
        "endpoint": "{http_url}",
        "fallback_path": "{fallback_path}",
        "report_dir": "{report_dir}",
        "shell_cmd": {shell_cmd!r},
    }}
    if os.path.exists(cfg_path):
        with open(cfg_path, "r", encoding="utf-8") as fh:
            cfg.update(json.loads(fh.read()))
    cfg["env"] = env_name
    return cfg
'''

    files[f"{pkg}/client/remote_feed.py"] = f'''"""HTTP feed fetcher with causal fallback module import on error."""

from __future__ import annotations

import json
import urllib.request

from {pkg}.audit.logger import emit_event


def fetch_reference_data(endpoint: str, batch_id: str, fallback_path: str) -> dict:
    url = f"{{endpoint}}?batch={{batch_id}}"
    try:
        with urllib.request.urlopen(url) as resp:
            status = resp.status
            body = resp.read().decode("utf-8")
        if status != 200:
            raise RuntimeError(f"HTTP {{status}}")
        return {{"source": "live-http", "data": json.loads(body)}}
    except Exception as exc:
        emit_event("WARNING", f"{pkg} live feed failed ({{exc}}); using fallback")
        from {pkg}.client.fallback_loader import load_fallback_data

        return load_fallback_data(fallback_path, batch_id)
'''

    files[f"{pkg}/client/fallback_loader.py"] = fallback_body

    if shell_cmd:
        files[f"{pkg}/client/shell_verify.py"] = f'''"""Subprocess verification step for {pkg}."""

from __future__ import annotations

import subprocess


def run_shell_check(cmd: list[str], batch_id: str) -> dict:
    full_cmd = [*cmd, "--batch", batch_id]
    proc = subprocess.run(full_cmd, capture_output=True, text=True, check=False)
    return {{"rc": proc.returncode, "stdout": proc.stdout.strip()}}
'''

    files[f"{pkg}/core/engine.py"] = (
        engine_body.rstrip()
        + "\n"
        + _class_padding(engine_cls, 4)
        + _sibling_unused_padding(engine_cls, 4)
    )
    files[f"{pkg}/policy/gate.py"] = (
        policy_body.rstrip()
        + "\n"
        + _class_padding(policy_cls, 4)
        + _sibling_unused_padding(policy_cls, 4)
    )

    files[f"{pkg}/storage/sqlite_repo.py"] = f'''"""In-memory SQLite state repository for {pkg}."""

from __future__ import annotations

import sqlite3
from typing import Any


class StateStore:
    def __init__(self) -> None:
        self._conn = sqlite3.connect(":memory:")

    def setup(self) -> None:
        self._conn.execute(
            "CREATE TABLE records (batch_id TEXT, item_id TEXT, bucket TEXT, metric REAL)"
        )

    def insert_rows(self, batch_id: str, rows: list[dict[str, Any]]) -> None:
        self._conn.executemany(
            "INSERT INTO records VALUES (?, ?, ?, ?)",
            [(batch_id, str(r["id"]), str(r["bucket"]), float(r["metric"])) for r in rows],
        )
        self._conn.commit()

    def aggregate(self, batch_id: str) -> dict[str, dict[str, float | int]]:
        cur = self._conn.execute(
            "SELECT bucket, COUNT(*), ROUND(SUM(metric), 4) FROM records "
            "WHERE batch_id = ? GROUP BY bucket ORDER BY bucket",
            (batch_id,),
        )
        return {{str(b): {{"count": int(c), "total": float(s)}} for b, c, s in cur.fetchall()}}

    def close(self) -> None:
        self._conn.close()
'''

    files[f"{pkg}/storage/writer.py"] = f'''"""Artifact JSON writer for {pkg}."""

from __future__ import annotations

import json


def write_artifact(report_dir: str, batch_id: str, artifact: dict) -> str:
    path = f"{{report_dir}}/{{batch_id}}.json"
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(json.dumps(artifact, sort_keys=True))
    return path
'''

    files[f"{pkg}/audit/logger.py"] = f'''"""Deterministic structured logger for {pkg}."""

from __future__ import annotations

import datetime
import logging
import uuid


def emit_event(level: str, msg: str) -> str:
    ts = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    eid = str(uuid.uuid4())[:8]
    line = f"[{{ts}}][{{eid}}] {{msg}}"
    if level == "ERROR":
        logging.error(line)
    elif level == "WARNING":
        logging.warning(line)
    else:
        logging.info(line)
    return eid
'''

    _populate_distractors(
        files,
        pkg,
        domain_subpkgs,
        extra_subpkg_count=extra_subpkg_count,
        mods_per_extra=mods_per_extra,
    )

    entry_file = f"{pkg}/api/pipeline.py"
    cfg_json = json.dumps(cfg_payload)
    batch_id = run_args[0]
    url_full = f"{http_url}?batch={batch_id}"

    # Shared prefix scripted calls for causal pair (identical args + identical initial calls!)
    base_env = [
        {"status": "fulfilled", "result": "prod"},
        {"status": "fulfilled", "result": cfg_default},
    ]
    base_exists = [{"status": "fulfilled", "result": True}]
    base_times = [1795810000.0, 1795810002.0, 1795810004.0, 1795810006.0]
    base_uuids = [
        "33330001-aaaa-4bbb-8ccc-000000000001",
        "33330002-aaaa-4bbb-8ccc-000000000002",
        "33330003-aaaa-4bbb-8ccc-000000000003",
    ]
    shell_script = (
        [{"status": "fulfilled", "result": {"returncode": 0, "stdout": shell_stdout, "stderr": ""}}]
        if shell_cmd
        else []
    )

    fam = f"stage10-py-repo:{pkg}"
    tasks: list[dict[str, Any]] = []

    # Variant 1: Live HTTP happy path (Causal pair A)
    s1 = {
        "env.get": list(base_env),
        "fs.exists": list(base_exists),
        "fs.readText": [{"status": "fulfilled", "result": cfg_json}],
        "http.request": [{
            "status": "fulfilled",
            "result": {"status": 200, "url": url_full, "headers": {"content-type": "application/json"}, "body": json.dumps(live_http_body)},
        }],
        "shell.exec": list(shell_script),
    }
    c1 = _record_fixture(entry="run", args=run_args, files=files, entry_file=entry_file, scripted=s1, times=base_times, uuids=base_uuids)
    tasks.append({
        "id": f"stage10-py-{pkg.replace('_', '-')}-live-ok",
        "family": fam,
        "language": "py",
        "files": files,
        "entryFile": entry_file,
        "entry": "run",
        "args": encode_readable(run_args),
        "fixture": {"calls": c1},
        "tier": 5,
        "features": ["long-context-65k", "multifile-codebase", "code-load", "effectful", "causal-branch", "sqlite3", "http", "fs", "env", "logging", "python"] + (["shell"] if shell_cmd else []),
        "metadata": {"bucket": "bucket_a_synth_65k", "sourceOrigin": "stage10-py-synth-65k", "variant": "live-ok"},
    })

    # Variant 2: Live HTTP rejected -> dynamic fallback_loader.py (Causal pair B — IDENTICAL prompt & args!)
    s2 = {
        "env.get": list(base_env),
        "fs.exists": list(base_exists),
        "fs.readText": [
            {"status": "fulfilled", "result": cfg_json},
            {"status": "fulfilled", "result": json.dumps(fallback_file_body)},
        ],
        "http.request": [{
            "status": "rejected",
            "result": {"name": "URLError", "message": "upstream 503 unavailable"},
        }],
        "shell.exec": list(shell_script),
    }
    c2 = _record_fixture(entry="run", args=run_args, files=files, entry_file=entry_file, scripted=s2, times=base_times, uuids=base_uuids)
    tasks.append({
        "id": f"stage10-py-{pkg.replace('_', '-')}-fallback-ok",
        "family": fam,
        "language": "py",
        "files": files,
        "entryFile": entry_file,
        "entry": "run",
        "args": encode_readable(run_args),
        "fixture": {"calls": c2},
        "tier": 5,
        "features": ["long-context-65k", "multifile-codebase", "code-load", "effectful", "causal-branch", "sqlite3", "http", "fs", "env", "logging", "python"] + (["shell"] if shell_cmd else []),
        "metadata": {"bucket": "bucket_a_synth_65k", "sourceOrigin": "stage10-py-synth-65k", "variant": "fallback-ok"},
    })

    # Variant 3: Gate rejection -> logs ERROR and throws ValueError!
    s3 = {
        "env.get": list(base_env),
        "fs.exists": list(base_exists),
        "fs.readText": [{"status": "fulfilled", "result": cfg_json}],
        "http.request": [{
            "status": "fulfilled",
            "result": {"status": 200, "url": url_full, "headers": {"content-type": "application/json"}, "body": json.dumps(throw_http_body)},
        }],
    }
    c3 = _record_fixture(entry="run", args=run_args, files=files, entry_file=entry_file, scripted=s3, times=base_times, uuids=base_uuids, allow_throw=True)
    tasks.append({
        "id": f"stage10-py-{pkg.replace('_', '-')}-gate-throw",
        "family": fam,
        "language": "py",
        "files": files,
        "entryFile": entry_file,
        "entry": "run",
        "args": encode_readable(run_args),
        "fixture": {"calls": c3},
        "tier": 5,
        "features": ["long-context-65k", "multifile-codebase", "code-load", "effectful", "causal-branch", "exception", "sqlite3", "http", "fs", "env", "logging", "python"],
        "metadata": {"bucket": "bucket_a_synth_65k", "sourceOrigin": "stage10-py-synth-65k", "variant": "gate-throw"},
    })
    return tasks


def _make_default_fallback(pkg: str, extra_key: str, default_val: Any) -> str:
    return f'''"""Fallback cache loader for {pkg} (imported only when live HTTP fails)."""

from __future__ import annotations

import json


def load_fallback_data(fallback_path: str, batch_id: str) -> dict:
    with open(fallback_path, "r", encoding="utf-8") as fh:
        raw = json.loads(fh.read())
    raw.setdefault("{extra_key}", {default_val!r})
    raw["fallback_for"] = batch_id
    return {{"source": "fallback-cache", "data": raw}}
'''


def build_bucket_a2_synthetic_65k() -> list[dict[str, Any]]:
    """Build 72 verified tasks across 24 brand-new 55-145 file synthetic Python repos."""
    domains: list[dict[str, Any]] = [
        # 1. query_planner — relational cost-based scan/join optimizer
        {
            "pkg": "query_planner", "title": "Cost-Based Relational Query Planner", "env_var": "QPLAN",
            "cfg_default": "/etc/qplan/planner.json", "http_url": "https://catalog.internal/v1/stats",
            "fallback_path": "/var/cache/qplan/stats.json", "report_dir": "/var/out/qplan",
            "shell_cmd": None, "engine_cls": "CostOptimizer", "policy_cls": "PlanBudgetGate",
            "engine_body": '''"""Cost-based join and scan optimizer."""
from __future__ import annotations
from typing import Any

SEQ_PAGE_COST = 1.0
IDX_PAGE_COST = 0.35

class CostOptimizer:
    def __init__(self, cfg: dict[str, Any], ref_data: dict[str, Any]) -> None:
        self.cfg = cfg
        self.stats = ref_data.get("tables", {})

    def process_batch(self, items: list[dict[str, Any]]) -> list[dict[str, Any]]:
        out = []
        for q in items:
            tbl = self.stats.get(q["table"], {"rows": 1000, "indexed": False})
            sel = float(q.get("selectivity", 0.5))
            rows = int(tbl["rows"])
            if tbl.get("indexed") and sel <= 0.25:
                plan = "index_scan"
                cost = round(rows * sel * IDX_PAGE_COST + 4.0, 2)
            else:
                plan = "seq_scan"
                cost = round(rows * SEQ_PAGE_COST * 0.1, 2)
            out.append({"id": q["id"], "bucket": plan, "metric": cost, "est_rows": int(rows * sel)})
        return out

    def summarize(self, rows: list[dict[str, Any]]) -> dict[str, Any]:
        total = round(sum(r["metric"] for r in rows), 2)
        return {"queries": len(rows), "total_cost": total, "max_cost": max((r["metric"] for r in rows), default=0.0)}
''',
            "policy_body": '''"""Query plan cost budget gate."""
from __future__ import annotations
from typing import Any

class PlanBudgetGate:
    def __init__(self, cfg: dict[str, Any]) -> None:
        self.max_cost = float(cfg.get("max_cost", 500.0))

    def evaluate(self, summary: dict[str, Any], rows: list[dict[str, Any]], *, source: str) -> dict[str, Any]:
        limit = self.max_cost * (0.9 if source == "fallback-cache" else 1.0)
        flags = [r["id"] for r in rows if r["bucket"] == "seq_scan"]
        if summary["total_cost"] > limit:
            return {"approved": False, "reason": f"cost {summary['total_cost']} > {limit}", "flags": flags}
        return {"approved": True, "reason": "within-budget", "flags": flags}
''',
            "domain_subpkgs": [("parser", ["sql_lex", "ast_nodes", "binder"], ["table", "col"]), ("exec", ["hash_join", "merge_join", "agg_node"], ["op", "rows"])],
            "extra_subpkg_count": 6, "mods_per_extra": 8,
            "cfg_payload": {"max_cost": 400.0},
            "run_args": ["QP-01", [{"id": "q1", "table": "orders", "selectivity": 0.1}, {"id": "q2", "table": "users", "selectivity": 0.5}]],
            "live_http_body": {"tables": {"orders": {"rows": 2000, "indexed": True}, "users": {"rows": 800, "indexed": True}}},
            "fallback_file_body": {"tables": {"orders": {"rows": 1800, "indexed": True}, "users": {"rows": 700, "indexed": False}}},
            "throw_http_body": {"tables": {"orders": {"rows": 9000, "indexed": False}, "users": {"rows": 5000, "indexed": False}}},
        },
        # 2. ci_runner — DAG build runner with shell verification
        {
            "pkg": "ci_runner", "title": "CI DAG Build & Artifact Runner", "env_var": "CIRUN",
            "cfg_default": "/etc/cirun/ci.json", "http_url": "https://cache.internal/v1/hashes",
            "fallback_path": "/var/cache/cirun/hashes.json", "report_dir": "/var/out/cirun",
            "shell_cmd": ["ci-verify", "--strict"], "engine_cls": "DagScheduler", "policy_cls": "BuildGate",
            "engine_body": '''"""Topological build stage scheduler with cache hit calculation."""
from __future__ import annotations
from typing import Any

class DagScheduler:
    def __init__(self, cfg: dict[str, Any], ref_data: dict[str, Any]) -> None:
        self.cfg = cfg
        self.cached = set(ref_data.get("cached_keys", []))

    def process_batch(self, items: list[dict[str, Any]]) -> list[dict[str, Any]]:
        out = []
        for step in items:
            hit = step["hash"] in self.cached
            secs = 1.5 if hit else float(step["duration_s"])
            out.append({"id": step["id"], "bucket": "cache_hit" if hit else "executed", "metric": secs, "critical": bool(step.get("critical", False))})
        return out

    def summarize(self, rows: list[dict[str, Any]]) -> dict[str, Any]:
        return {
            "steps": len(rows),
            "total_seconds": round(sum(r["metric"] for r in rows), 2),
            "cache_hits": sum(1 for r in rows if r["bucket"] == "cache_hit"),
        }
''',
            "policy_body": '''"""CI timeout budget gate."""
from __future__ import annotations
from typing import Any

class BuildGate:
    def __init__(self, cfg: dict[str, Any]) -> None:
        self.max_seconds = float(cfg.get("max_seconds", 120.0))

    def evaluate(self, summary: dict[str, Any], rows: list[dict[str, Any]], *, source: str) -> dict[str, Any]:
        flags = [r["id"] for r in rows if r["bucket"] == "executed"]
        if summary["total_seconds"] > self.max_seconds:
            return {"approved": False, "reason": f"duration {summary['total_seconds']}s exceeds {self.max_seconds}s", "flags": flags}
        return {"approved": True, "reason": "green", "flags": flags}
''',
            "domain_subpkgs": [("runners", ["docker_exec", "k8s_job", "sandbox"], ["job", "image"]), ("artifacts", ["tar_pack", "hash_idx", "upload"], ["key", "sha"])],
            "extra_subpkg_count": 7, "mods_per_extra": 8,
            "cfg_payload": {"max_seconds": 90.0},
            "run_args": ["CI-88", [{"id": "lint", "hash": "h1", "duration_s": 20}, {"id": "unit", "hash": "h2", "duration_s": 45}, {"id": "pkg", "hash": "h3", "duration_s": 30}]],
            "live_http_body": {"cached_keys": ["h1", "h3"]},
            "fallback_file_body": {"cached_keys": ["h1"]},
            "throw_http_body": {"cached_keys": []},
        },
        # 3. telemetry_pipe — Span sampling & PII scrubber
        {
            "pkg": "telemetry_pipe", "title": "Telemetry Span Sampler & PII Scrubber", "env_var": "TPIPE",
            "cfg_default": "/etc/tpipe/pipe.json", "http_url": "https://sampler.internal/v1/rules",
            "fallback_path": "/var/cache/tpipe/rules.json", "report_dir": "/var/out/tpipe",
            "shell_cmd": None, "engine_cls": "SpanProcessor", "policy_cls": "SloAnomalyGate",
            "engine_body": '''"""Span latency classifier and PII scrubber."""
from __future__ import annotations
import re
from typing import Any

EMAIL_RE = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}")

class SpanProcessor:
    def __init__(self, cfg: dict[str, Any], ref_data: dict[str, Any]) -> None:
        self.slow_ms = float(ref_data.get("slow_ms", 200.0))

    def process_batch(self, items: list[dict[str, Any]]) -> list[dict[str, Any]]:
        out = []
        for sp in items:
            lat = float(sp["latency_ms"])
            cleaned = EMAIL_RE.sub("[REDACTED]", str(sp.get("msg", "")))
            bucket = "slow" if lat >= self.slow_ms else "normal"
            out.append({"id": sp["id"], "bucket": bucket, "metric": lat, "redacted": cleaned != sp.get("msg", "")})
        return out

    def summarize(self, rows: list[dict[str, Any]]) -> dict[str, Any]:
        slow = sum(1 for r in rows if r["bucket"] == "slow")
        red = sum(1 for r in rows if r["redacted"])
        return {"spans": len(rows), "slow_count": slow, "redacted_count": red, "max_ms": max((r["metric"] for r in rows), default=0.0)}
''',
            "policy_body": '''"""SLO slow-span ratio gate."""
from __future__ import annotations
from typing import Any

class SloAnomalyGate:
    def __init__(self, cfg: dict[str, Any]) -> None:
        self.max_slow = int(cfg.get("max_slow", 1))

    def evaluate(self, summary: dict[str, Any], rows: list[dict[str, Any]], *, source: str) -> dict[str, Any]:
        flags = [r["id"] for r in rows if r["redacted"]]
        if summary["slow_count"] > self.max_slow:
            return {"approved": False, "reason": f"slow spans {summary['slow_count']} > {self.max_slow}", "flags": flags}
        return {"approved": True, "reason": "slo-ok", "flags": flags}
''',
            "domain_subpkgs": [("ingest", ["otlp_grpc", "jaeger_thrift", "zipkin_v2"], ["trace_id", "span_id"]), ("sinks", ["clickhouse", "tempo", "s3_parquet"], ["batch", "bytes"])],
            "extra_subpkg_count": 7, "mods_per_extra": 9,
            "cfg_payload": {"max_slow": 1},
            "run_args": ["TP-12", [{"id": "s1", "latency_ms": 42, "msg": "user bob@acme.io login"}, {"id": "s2", "latency_ms": 240, "msg": "db query"}, {"id": "s3", "latency_ms": 95, "msg": "render"}]],
            "live_http_body": {"slow_ms": 200.0},
            "fallback_file_body": {"slow_ms": 180.0},
            "throw_http_body": {"slow_ms": 80.0},
        },
        # 4. perm_eval — ABAC/RBAC policy evaluator with deny overrides
        {
            "pkg": "perm_eval", "title": "RBAC & ABAC Permission Policy Evaluator", "env_var": "PERMEVAL",
            "cfg_default": "/etc/perm/policy.json", "http_url": "https://iam.internal/v1/grants",
            "fallback_path": "/var/cache/perm/grants.json", "report_dir": "/var/out/perm",
            "shell_cmd": None, "engine_cls": "AccessEvaluator", "policy_cls": "ZeroDenyGate",
            "engine_body": '''"""Hierarchical role + explicit-deny ABAC evaluator."""
from __future__ import annotations
from typing import Any

class AccessEvaluator:
    def __init__(self, cfg: dict[str, Any], ref_data: dict[str, Any]) -> None:
        self.roles = ref_data.get("roles", {})
        self.denies = set(ref_data.get("explicit_deny", []))

    def process_batch(self, items: list[dict[str, Any]]) -> list[dict[str, Any]]:
        out = []
        for req in items:
            key = f"{req['role']}:{req['action']}"
            allowed_acts = set(self.roles.get(req["role"], []))
            if key in self.denies:
                decision, score = "deny", 0.0
            elif req["action"] in allowed_acts or "*" in allowed_acts:
                decision, score = "allow", 1.0
            else:
                decision, score = "deny", 0.0
            out.append({"id": req["id"], "bucket": decision, "metric": score, "key": key})
        return out

    def summarize(self, rows: list[dict[str, Any]]) -> dict[str, Any]:
        allowed = sum(1 for r in rows if r["bucket"] == "allow")
        return {"total": len(rows), "allowed": allowed, "denied": len(rows) - allowed}
''',
            "policy_body": '''"""Permission evaluation threshold gate."""
from __future__ import annotations
from typing import Any

class ZeroDenyGate:
    def __init__(self, cfg: dict[str, Any]) -> None:
        self.max_denied = int(cfg.get("max_denied", 1))

    def evaluate(self, summary: dict[str, Any], rows: list[dict[str, Any]], *, source: str) -> dict[str, Any]:
        flags = [r["id"] for r in rows if r["bucket"] == "deny"]
        if summary["denied"] > self.max_denied:
            return {"approved": False, "reason": f"denied {summary['denied']} > {self.max_denied}", "flags": flags}
        return {"approved": True, "reason": "policy-pass", "flags": flags}
''',
            "domain_subpkgs": [("principals", ["oidc_map", "ldap_sync", "svc_acct"], ["sub", "role"]), ("scopes", ["wildcard", "tenant_iso", "audit_trail"], ["scope", "effect"])],
            "extra_subpkg_count": 6, "mods_per_extra": 8,
            "cfg_payload": {"max_denied": 1},
            "run_args": ["PM-04", [{"id": "r1", "role": "editor", "action": "read"}, {"id": "r2", "role": "editor", "action": "write"}, {"id": "r3", "role": "viewer", "action": "delete"}]],
            "live_http_body": {"roles": {"editor": ["read", "write"], "viewer": ["read"]}, "explicit_deny": []},
            "fallback_file_body": {"roles": {"editor": ["read", "write"], "viewer": ["read"]}, "explicit_deny": ["viewer:delete"]},
            "throw_http_body": {"roles": {"editor": ["read"], "viewer": ["read"]}, "explicit_deny": ["editor:write"]},
        },
        # 5. ast_linter — Python AST static complexity & rule linter
        {
            "pkg": "ast_linter", "title": "Python AST Static Rule & Complexity Linter", "env_var": "ASTLINT",
            "cfg_default": "/etc/astlint/rules.json", "http_url": "https://lint.internal/v1/profile",
            "fallback_path": "/var/cache/astlint/profile.json", "report_dir": "/var/out/astlint",
            "shell_cmd": None, "engine_cls": "AstRuleAnalyzer", "policy_cls": "LintSeverityGate",
            "engine_body": '''"""Python AST cyclomatic complexity and bare-except detector."""
from __future__ import annotations
import ast
from typing import Any

BRANCH_NODES = (ast.If, ast.For, ast.While, ast.ExceptHandler, ast.With, ast.Try)

class AstRuleAnalyzer:
    def __init__(self, cfg: dict[str, Any], ref_data: dict[str, Any]) -> None:
        self.max_cc = int(ref_data.get("max_complexity", 5))

    def process_batch(self, items: list[dict[str, Any]]) -> list[dict[str, Any]]:
        out = []
        for mod in items:
            tree = ast.parse(mod["code"])
            cc = 1 + sum(1 for n in ast.walk(tree) if isinstance(n, BRANCH_NODES))
            bare = sum(1 for n in ast.walk(tree) if isinstance(n, ast.ExceptHandler) and n.type is None)
            bucket = "violation" if (cc > self.max_cc or bare > 0) else "clean"
            out.append({"id": mod["id"], "bucket": bucket, "metric": float(cc + bare * 3), "bare": bare})
        return out

    def summarize(self, rows: list[dict[str, Any]]) -> dict[str, Any]:
        viol = sum(1 for r in rows if r["bucket"] == "violation")
        return {"files": len(rows), "violations": viol, "max_score": max((r["metric"] for r in rows), default=0.0)}
''',
            "policy_body": '''"""Static lint violation threshold gate."""
from __future__ import annotations
from typing import Any

class LintSeverityGate:
    def __init__(self, cfg: dict[str, Any]) -> None:
        self.max_violations = int(cfg.get("max_violations", 0))

    def evaluate(self, summary: dict[str, Any], rows: list[dict[str, Any]], *, source: str) -> dict[str, Any]:
        flags = [r["id"] for r in rows if r["bucket"] == "violation"]
        if summary["violations"] > self.max_violations:
            return {"approved": False, "reason": f"lint violations {summary['violations']} > {self.max_violations}", "flags": flags}
        return {"approved": True, "reason": "clean", "flags": flags}
''',
            "domain_subpkgs": [("rules", ["imports_chk", "naming_chk", "typing_chk"], ["rule_id", "sev"]), ("fixers", ["sort_imp", "fmt_str", "dead_code"], ["file", "edits"])],
            "extra_subpkg_count": 8, "mods_per_extra": 8,
            "cfg_payload": {"max_violations": 0},
            "run_args": ["LN-09", [{"id": "a.py", "code": "def f(x):\n    if x > 0:\n        return x\n    return 0\n"}, {"id": "b.py", "code": "def g(xs):\n    s = 0\n    for x in xs:\n        if x > 1:\n            s += x\n    return s\n"}]],
            "live_http_body": {"max_complexity": 5},
            "fallback_file_body": {"max_complexity": 4},
            "throw_http_body": {"max_complexity": 2},
        },
        # 6. tpl_engine — Safe template renderer with filters & HTML escaping
        {
            "pkg": "tpl_engine", "title": "Safe HTML Template Compiler & Filter Pipeline", "env_var": "TPLENG",
            "cfg_default": "/etc/tpl/engine.json", "http_url": "https://tpl.internal/v1/partials",
            "fallback_path": "/var/cache/tpl/partials.json", "report_dir": "/var/out/tpl",
            "shell_cmd": None, "engine_cls": "TemplateRenderer", "policy_cls": "OutputSafetyGate",
            "engine_body": '''"""Mustache-style template renderer with filter chains and HTML escaping."""
from __future__ import annotations
import html
import re
from typing import Any

TOKEN_RE = re.compile(r"\\{\\{\\s*([a-zA-Z0-9_]+)(?:\\|([a-z]+))?\\s*\\}\\}")

class TemplateRenderer:
    def __init__(self, cfg: dict[str, Any], ref_data: dict[str, Any]) -> None:
        self.globals = ref_data.get("globals", {})
        self.strict = bool(ref_data.get("strict_missing", True))

    def _render_one(self, tpl: str, ctx: dict[str, Any]) -> tuple[str, int]:
        missing = 0
        merged = {**self.globals, **ctx}
        def repl(m: re.Match[str]) -> str:
            nonlocal missing
            key, flt = m.group(1), m.group(2)
            if key not in merged:
                missing += 1
                return ""
            val = str(merged[key])
            if flt == "upper":
                val = val.upper()
            elif flt == "trim":
                val = val.strip()
            return html.escape(val, quote=True)
        return TOKEN_RE.sub(repl, tpl), missing

    def process_batch(self, items: list[dict[str, Any]]) -> list[dict[str, Any]]:
        out = []
        for it in items:
            rendered, miss = self._render_one(it["tpl"], it["ctx"])
            bucket = "missing_var" if (miss > 0 and self.strict) else "rendered"
            out.append({"id": it["id"], "bucket": bucket, "metric": float(len(rendered)), "rendered": rendered, "missing": miss})
        return out

    def summarize(self, rows: list[dict[str, Any]]) -> dict[str, Any]:
        return {"templates": len(rows), "missing_total": sum(r["missing"] for r in rows), "chars": int(sum(r["metric"] for r in rows))}
''',
            "policy_body": '''"""Template missing-variable safety gate."""
from __future__ import annotations
from typing import Any

class OutputSafetyGate:
    def __init__(self, cfg: dict[str, Any]) -> None:
        self.allow_missing = int(cfg.get("allow_missing", 0))

    def evaluate(self, summary: dict[str, Any], rows: list[dict[str, Any]], *, source: str) -> dict[str, Any]:
        flags = [r["id"] for r in rows if r["missing"] > 0]
        if summary["missing_total"] > self.allow_missing:
            return {"approved": False, "reason": f"missing vars {summary['missing_total']} > {self.allow_missing}", "flags": flags}
        return {"approved": True, "reason": "rendered-clean", "flags": flags}
''',
            "domain_subpkgs": [("filters", ["currency_fmt", "date_fmt", "markdown_flt"], ["name", "args"]), ("loaders", ["fs_loader", "zip_loader", "cache_lru"], ["path", "mtime"])],
            "extra_subpkg_count": 6, "mods_per_extra": 9,
            "cfg_payload": {"allow_missing": 0},
            "run_args": ["TP-77", [{"id": "welcome", "tpl": "Hi {{ name|upper }} from {{ brand }}!", "ctx": {"name": "Ada <dev>"}}, {"id": "footer", "tpl": "(c) {{ year }} {{ brand|trim }}", "ctx": {"year": 2026}}]],
            "live_http_body": {"globals": {"brand": " Acme "}, "strict_missing": True},
            "fallback_file_body": {"globals": {"brand": "Acme-Fallback"}, "strict_missing": True},
            "throw_http_body": {"globals": {}, "strict_missing": True},
        },
        # 7. job_sched — Priority cron & dependency job scheduler
        {
            "pkg": "job_sched", "title": "Priority Job Scheduler & Lease Manager", "env_var": "JOBSCH",
            "cfg_default": "/etc/jobsch/sched.json", "http_url": "https://sched.internal/v1/capacity",
            "fallback_path": "/var/cache/jobsch/capacity.json", "report_dir": "/var/out/jobsch",
            "shell_cmd": None, "engine_cls": "PriorityPlanner", "policy_cls": "CapacityGate",
            "engine_body": '''"""Priority-ordered job admission and slot allocator."""
from __future__ import annotations
from typing import Any

class PriorityPlanner:
    def __init__(self, cfg: dict[str, Any], ref_data: dict[str, Any]) -> None:
        self.slots = int(ref_data.get("free_slots", 4))

    def process_batch(self, items: list[dict[str, Any]]) -> list[dict[str, Any]]:
        ordered = sorted(items, key=lambda x: (-int(x["priority"]), x["id"]))
        rem = self.slots
        out = []
        for job in ordered:
            need = int(job["slots"])
            if need <= rem:
                rem -= need
                bucket = "scheduled"
            else:
                bucket = "deferred"
            out.append({"id": job["id"], "bucket": bucket, "metric": float(need), "priority": int(job["priority"])})
        return out

    def summarize(self, rows: list[dict[str, Any]]) -> dict[str, Any]:
        sched = sum(1 for r in rows if r["bucket"] == "scheduled")
        return {"total": len(rows), "scheduled": sched, "deferred": len(rows) - sched}
''',
            "policy_body": '''"""Scheduler deferred-job SLA gate."""
from __future__ import annotations
from typing import Any

class CapacityGate:
    def __init__(self, cfg: dict[str, Any]) -> None:
        self.max_deferred = int(cfg.get("max_deferred", 1))

    def evaluate(self, summary: dict[str, Any], rows: list[dict[str, Any]], *, source: str) -> dict[str, Any]:
        flags = [r["id"] for r in rows if r["bucket"] == "deferred"]
        if summary["deferred"] > self.max_deferred:
            return {"approved": False, "reason": f"deferred {summary['deferred']} > {self.max_deferred}", "flags": flags}
        return {"approved": True, "reason": "capacity-ok", "flags": flags}
''',
            "domain_subpkgs": [("queues", ["dlq_mgr", "cron_expr", "lease_hb"], ["job_id", "lease"]), ("workers", ["pool_ctl", "autoscaler", "reaper"], ["worker", "slots"])],
            "extra_subpkg_count": 8, "mods_per_extra": 9,
            "cfg_payload": {"max_deferred": 1},
            "run_args": ["JS-21", [{"id": "j1", "priority": 10, "slots": 3}, {"id": "j2", "priority": 5, "slots": 2}, {"id": "j3", "priority": 1, "slots": 3}]],
            "live_http_body": {"free_slots": 6},
            "fallback_file_body": {"free_slots": 5},
            "throw_http_body": {"free_slots": 2},
        },
        # 8. treasury_sweep — Multi-bank liquidity pooling & reserve floor
        {
            "pkg": "treasury_sweep", "title": "Multi-Bank Treasury Liquidity Sweeper", "env_var": "TSWEEP",
            "cfg_default": "/etc/tsweep/policy.json", "http_url": "https://bank.internal/v1/reserves",
            "fallback_path": "/var/cache/tsweep/reserves.json", "report_dir": "/var/out/tsweep",
            "shell_cmd": None, "engine_cls": "LiquiditySweeper", "policy_cls": "ReserveFloorGate",
            "engine_body": '''"""Computes sweepable excess liquidity above per-account reserve floors."""
from __future__ import annotations
from typing import Any

class LiquiditySweeper:
    def __init__(self, cfg: dict[str, Any], ref_data: dict[str, Any]) -> None:
        self.floors = ref_data.get("floors", {})

    def process_batch(self, items: list[dict[str, Any]]) -> list[dict[str, Any]]:
        out = []
        for acct in items:
            bal = float(acct["balance"])
            floor = float(self.floors.get(acct["bank"], 1000.0))
            delta = round(bal - floor, 2)
            bucket = "sweep_out" if delta > 0 else ("top_up" if delta < 0 else "hold")
            out.append({"id": acct["id"], "bucket": bucket, "metric": delta})
        return out

    def summarize(self, rows: list[dict[str, Any]]) -> dict[str, Any]:
        net = round(sum(r["metric"] for r in rows), 2)
        deficits = sum(1 for r in rows if r["bucket"] == "top_up")
        return {"accounts": len(rows), "net_liquidity": net, "deficits": deficits}
''',
            "policy_body": '''"""Net liquidity & reserve shortfall gate."""
from __future__ import annotations
from typing import Any

class ReserveFloorGate:
    def __init__(self, cfg: dict[str, Any]) -> None:
        self.min_net = float(cfg.get("min_net", 0.0))

    def evaluate(self, summary: dict[str, Any], rows: list[dict[str, Any]], *, source: str) -> dict[str, Any]:
        flags = [r["id"] for r in rows if r["bucket"] == "top_up"]
        if summary["net_liquidity"] < self.min_net:
            return {"approved": False, "reason": f"net liquidity {summary['net_liquidity']} < {self.min_net}", "flags": flags}
        return {"approved": True, "reason": "solvent", "flags": flags}
''',
            "domain_subpkgs": [("rails", ["ach_batch", "fedwire", "sepa_xml"], ["acct", "amt"]), ("fx", ["spot_book", "hedge_calc", "nostro"], ["ccy", "rate"])],
            "extra_subpkg_count": 7, "mods_per_extra": 8,
            "cfg_payload": {"min_net": 500.0},
            "run_args": ["TS-30", [{"id": "a1", "bank": "chase", "balance": 5000.0}, {"id": "a2", "bank": "citi", "balance": 1200.0}]],
            "live_http_body": {"floors": {"chase": 2000.0, "citi": 1500.0}},
            "fallback_file_body": {"floors": {"chase": 2200.0, "citi": 1500.0}},
            "throw_http_body": {"floors": {"chase": 4800.0, "citi": 2000.0}},
        },
        # 9. order_router — Smart liquidity venue order router
        {
            "pkg": "order_router", "title": "Smart Multi-Venue Order Execution Router", "env_var": "OROUTE",
            "cfg_default": "/etc/oroute/venues.json", "http_url": "https://mkt.internal/v1/quotes",
            "fallback_path": "/var/cache/oroute/quotes.json", "report_dir": "/var/out/oroute",
            "shell_cmd": None, "engine_cls": "VenueRouter", "policy_cls": "SlippageGate",
            "engine_body": '''"""Routes orders to lowest effective cost venue (price + bps fee)."""
from __future__ import annotations
from typing import Any

class VenueRouter:
    def __init__(self, cfg: dict[str, Any], ref_data: dict[str, Any]) -> None:
        self.quotes = ref_data.get("venues", {})

    def process_batch(self, items: list[dict[str, Any]]) -> list[dict[str, Any]]:
        out = []
        for ord_row in items:
            sym = ord_row["symbol"]
            cands = self.quotes.get(sym, [])
            best = min(cands, key=lambda v: v["ask"] * (1.0 + v["fee_bps"] / 10000.0))
            eff = round(best["ask"] * (1.0 + best["fee_bps"] / 10000.0), 4)
            slip_bps = round(((eff - ord_row["ref_px"]) / ord_row["ref_px"]) * 10000.0, 2)
            out.append({"id": ord_row["id"], "bucket": best["venue"], "metric": slip_bps, "eff_px": eff})
        return out

    def summarize(self, rows: list[dict[str, Any]]) -> dict[str, Any]:
        return {"orders": len(rows), "max_slip_bps": max((r["metric"] for r in rows), default=0.0)}
''',
            "policy_body": '''"""Maximum execution slippage gate."""
from __future__ import annotations
from typing import Any

class SlippageGate:
    def __init__(self, cfg: dict[str, Any]) -> None:
        self.max_bps = float(cfg.get("max_slip_bps", 25.0))

    def evaluate(self, summary: dict[str, Any], rows: list[dict[str, Any]], *, source: str) -> dict[str, Any]:
        flags = [r["id"] for r in rows if r["metric"] > 10.0]
        if summary["max_slip_bps"] > self.max_bps:
            return {"approved": False, "reason": f"slippage {summary['max_slip_bps']}bps > {self.max_bps}bps", "flags": flags}
        return {"approved": True, "reason": "best-exec", "flags": flags}
''',
            "domain_subpkgs": [("venues", ["nasdaq_fix", "bats_itch", "iex_top"], ["sym", "px"]), ("risk", ["fat_finger", "notional_cap", "kill_sw"], ["order_id", "limit"])],
            "extra_subpkg_count": 7, "mods_per_extra": 8,
            "cfg_payload": {"max_slip_bps": 25.0},
            "run_args": ["OR-19", [{"id": "o1", "symbol": "ACME", "ref_px": 100.0}, {"id": "o2", "symbol": "BETA", "ref_px": 50.0}]],
            "live_http_body": {"venues": {"ACME": [{"venue": "vA", "ask": 100.1, "fee_bps": 2}, {"venue": "vB", "ask": 100.05, "fee_bps": 3}], "BETA": [{"venue": "vA", "ask": 50.02, "fee_bps": 2}]}},
            "fallback_file_body": {"venues": {"ACME": [{"venue": "vA", "ask": 100.15, "fee_bps": 2}], "BETA": [{"venue": "vB", "ask": 50.04, "fee_bps": 1}]}},
            "throw_http_body": {"venues": {"ACME": [{"venue": "vA", "ask": 100.6, "fee_bps": 5}], "BETA": [{"venue": "vA", "ask": 50.02, "fee_bps": 2}]}},
        },
        # 10. schema_reg — Schema compatibility & evolution checker
        {
            "pkg": "schema_reg", "title": "Schema Registry Compatibility Validator", "env_var": "SCHREG",
            "cfg_default": "/etc/schreg/reg.json", "http_url": "https://schema.internal/v1/latest",
            "fallback_path": "/var/cache/schreg/latest.json", "report_dir": "/var/out/schreg",
            "shell_cmd": None, "engine_cls": "CompatAnalyzer", "policy_cls": "EvolutionGate",
            "engine_body": '''"""Checks backward compatibility of proposed schema field evolutions."""
from __future__ import annotations
from typing import Any

WIDEN = {("int", "float"), ("int", "str"), ("float", "str")}

class CompatAnalyzer:
    def __init__(self, cfg: dict[str, Any], ref_data: dict[str, Any]) -> None:
        self.baseline = ref_data.get("fields", {})

    def process_batch(self, items: list[dict[str, Any]]) -> list[dict[str, Any]]:
        out = []
        for chg in items:
            name = chg["field"]
            old_t = self.baseline.get(name)
            new_t = chg["type"]
            if old_t is None:
                bucket, score = ("compatible" if chg.get("optional", False) else "breaking"), (0.0 if chg.get("optional", False) else 1.0)
            elif old_t == new_t or (old_t, new_t) in WIDEN:
                bucket, score = "compatible", 0.0
            else:
                bucket, score = "breaking", 1.0
            out.append({"id": name, "bucket": bucket, "metric": score})
        return out

    def summarize(self, rows: list[dict[str, Any]]) -> dict[str, Any]:
        brk = sum(1 for r in rows if r["bucket"] == "breaking")
        return {"checked": len(rows), "breaking": brk}
''',
            "policy_body": '''"""Zero breaking-change schema gate."""
from __future__ import annotations
from typing import Any

class EvolutionGate:
    def __init__(self, cfg: dict[str, Any]) -> None:
        self.allow_breaking = int(cfg.get("allow_breaking", 0))

    def evaluate(self, summary: dict[str, Any], rows: list[dict[str, Any]], *, source: str) -> dict[str, Any]:
        flags = [r["id"] for r in rows if r["bucket"] == "breaking"]
        if summary["breaking"] > self.allow_breaking:
            return {"approved": False, "reason": f"breaking changes: {flags}", "flags": flags}
        return {"approved": True, "reason": "backward-compatible", "flags": flags}
''',
            "domain_subpkgs": [("formats", ["avro_ast", "proto_ast", "json_draft"], ["subject", "ver"]), ("registry", ["fingerprints", "subjects", "locks"], ["id", "hash"])],
            "extra_subpkg_count": 6, "mods_per_extra": 9,
            "cfg_payload": {"allow_breaking": 0},
            "run_args": ["SR-07", [{"field": "amount", "type": "float"}, {"field": "note", "type": "str", "optional": True}]],
            "live_http_body": {"fields": {"amount": "int", "user_id": "str"}},
            "fallback_file_body": {"fields": {"amount": "float", "user_id": "str"}},
            "throw_http_body": {"fields": {"amount": "bool", "user_id": "str"}},
        },
        # 11. cdc_bridge — Change-data-capture WAL watermark deduplicator
        {
            "pkg": "cdc_bridge", "title": "CDC WAL Stream Transformer & DLQ Router", "env_var": "CDCBR",
            "cfg_default": "/etc/cdc/bridge.json", "http_url": "https://cdc.internal/v1/watermark",
            "fallback_path": "/var/cache/cdc/watermark.json", "report_dir": "/var/out/cdc",
            "shell_cmd": None, "engine_cls": "WalTransformer", "policy_cls": "DlqRatioGate",
            "engine_body": '''"""Filters duplicate LSN records and routes malformed events to DLQ."""
from __future__ import annotations
from typing import Any

class WalTransformer:
    def __init__(self, cfg: dict[str, Any], ref_data: dict[str, Any]) -> None:
        self.watermark = int(ref_data.get("lsn", 0))

    def process_batch(self, items: list[dict[str, Any]]) -> list[dict[str, Any]]:
        out = []
        for ev in items:
            lsn = int(ev["lsn"])
            if lsn <= self.watermark:
                bucket, metric = "dedup_skip", 0.0
            elif ev.get("op") not in ("INSERT", "UPDATE", "DELETE"):
                bucket, metric = "dlq", 1.0
            else:
                bucket, metric = "applied", float(lsn - self.watermark)
            out.append({"id": f"lsn-{lsn}", "bucket": bucket, "metric": metric})
        return out

    def summarize(self, rows: list[dict[str, Any]]) -> dict[str, Any]:
        return {
            "events": len(rows),
            "applied": sum(1 for r in rows if r["bucket"] == "applied"),
            "dlq": sum(1 for r in rows if r["bucket"] == "dlq"),
        }
''',
            "policy_body": '''"""CDC dead-letter queue gate."""
from __future__ import annotations
from typing import Any

class DlqRatioGate:
    def __init__(self, cfg: dict[str, Any]) -> None:
        self.max_dlq = int(cfg.get("max_dlq", 0))

    def evaluate(self, summary: dict[str, Any], rows: list[dict[str, Any]], *, source: str) -> dict[str, Any]:
        flags = [r["id"] for r in rows if r["bucket"] == "dlq"]
        if summary["dlq"] > self.max_dlq:
            return {"approved": False, "reason": f"dlq count {summary['dlq']} > {self.max_dlq}", "flags": flags}
        return {"approved": True, "reason": "stream-healthy", "flags": flags}
''',
            "domain_subpkgs": [("sources", ["pg_logical", "mysql_binlog", "mongo_oplog"], ["lsn", "tbl"]), ("offsets", ["ckpt_store", "lag_meter", "rebalance"], ["part", "lsn"])],
            "extra_subpkg_count": 7, "mods_per_extra": 8,
            "cfg_payload": {"max_dlq": 0},
            "run_args": ["CDC-14", [{"lsn": 95, "op": "CORRUPT"}, {"lsn": 105, "op": "INSERT"}, {"lsn": 112, "op": "UPDATE"}]],
            "live_http_body": {"lsn": 100},
            "fallback_file_body": {"lsn": 98},
            "throw_http_body": {"lsn": 50},
        },
        # 12. rate_mesh — Sliding-window distributed quota mesh
        {
            "pkg": "rate_mesh", "title": "Distributed Sliding-Window Rate Mesh", "env_var": "RMESH",
            "cfg_default": "/etc/rmesh/quotas.json", "http_url": "https://quota.internal/v1/usage",
            "fallback_path": "/var/cache/rmesh/usage.json", "report_dir": "/var/out/rmesh",
            "shell_cmd": None, "engine_cls": "QuotaEvaluator", "policy_cls": "ThrottleGate",
            "engine_body": '''"""Evaluates per-tenant burst + sustained sliding-window quotas."""
from __future__ import annotations
from typing import Any

class QuotaEvaluator:
    def __init__(self, cfg: dict[str, Any], ref_data: dict[str, Any]) -> None:
        self.used = ref_data.get("current_usage", {})
        self.limit = int(cfg.get("tenant_limit", 100))

    def process_batch(self, items: list[dict[str, Any]]) -> list[dict[str, Any]]:
        out = []
        for req in items:
            prior = int(self.used.get(req["tenant"], 0))
            after = prior + int(req["tokens"])
            bucket = "throttled" if after > self.limit else "admitted"
            out.append({"id": req["id"], "bucket": bucket, "metric": float(after)})
        return out

    def summarize(self, rows: list[dict[str, Any]]) -> dict[str, Any]:
        return {"checked": len(rows), "throttled": sum(1 for r in rows if r["bucket"] == "throttled")}
''',
            "policy_body": '''"""Mesh throttling alarm gate."""
from __future__ import annotations
from typing import Any

class ThrottleGate:
    def __init__(self, cfg: dict[str, Any]) -> None:
        self.max_throttled = int(cfg.get("max_throttled", 1))

    def evaluate(self, summary: dict[str, Any], rows: list[dict[str, Any]], *, source: str) -> dict[str, Any]:
        flags = [r["id"] for r in rows if r["bucket"] == "throttled"]
        if summary["throttled"] > self.max_throttled:
            return {"approved": False, "reason": f"throttled {summary['throttled']} > {self.max_throttled}", "flags": flags}
        return {"approved": True, "reason": "within-quota", "flags": flags}
''',
            "domain_subpkgs": [("windows", ["token_bkt", "leaky_bkt", "gcra_cell"], ["tenant", "rate"]), ("sync", ["gossip_ring", "redis_lua", "local_est"], ["node", "cnt"])],
            "extra_subpkg_count": 8, "mods_per_extra": 8,
            "cfg_payload": {"tenant_limit": 100, "max_throttled": 1},
            "run_args": ["RM-55", [{"id": "req1", "tenant": "t1", "tokens": 20}, {"id": "req2", "tenant": "t2", "tokens": 35}]],
            "live_http_body": {"current_usage": {"t1": 50, "t2": 40}},
            "fallback_file_body": {"current_usage": {"t1": 60, "t2": 70}},
            "throw_http_body": {"current_usage": {"t1": 90, "t2": 80}},
        },
        # 13. cert_rotator — TLS X.509 certificate expiry & rotation manager
        {
            "pkg": "cert_rotator", "title": "TLS X.509 Certificate Lifecycle Rotator", "env_var": "CERTROT",
            "cfg_default": "/etc/certrot/rotator.json", "http_url": "https://acme.internal/v1/status",
            "fallback_path": "/var/cache/certrot/status.json", "report_dir": "/var/out/certrot",
            "shell_cmd": ["openssl-check", "--verify"], "engine_cls": "CertScanner", "policy_cls": "ExpiryGate",
            "engine_body": '''"""Scans certificate expiry horizons and plans ACME renewals."""
from __future__ import annotations
from typing import Any

class CertScanner:
    def __init__(self, cfg: dict[str, Any], ref_data: dict[str, Any]) -> None:
        self.renew_days = int(ref_data.get("renew_window_days", 30))
        self.revoked = set(ref_data.get("revoked_serials", []))

    def process_batch(self, items: list[dict[str, Any]]) -> list[dict[str, Any]]:
        out = []
        for cert in items:
            days = int(cert["days_left"])
            if cert["serial"] in self.revoked or days <= 0:
                bucket = "expired_or_revoked"
            elif days <= self.renew_days:
                bucket = "renew"
            else:
                bucket = "valid"
            out.append({"id": cert["cn"], "bucket": bucket, "metric": float(days)})
        return out

    def summarize(self, rows: list[dict[str, Any]]) -> dict[str, Any]:
        return {
            "certs": len(rows),
            "renewals": sum(1 for r in rows if r["bucket"] == "renew"),
            "critical": sum(1 for r in rows if r["bucket"] == "expired_or_revoked"),
        }
''',
            "policy_body": '''"""Certificate critical expiry/revocation gate."""
from __future__ import annotations
from typing import Any

class ExpiryGate:
    def __init__(self, cfg: dict[str, Any]) -> None:
        self.max_critical = int(cfg.get("max_critical", 0))

    def evaluate(self, summary: dict[str, Any], rows: list[dict[str, Any]], *, source: str) -> dict[str, Any]:
        flags = [r["id"] for r in rows if r["bucket"] != "valid"]
        if summary["critical"] > self.max_critical:
            return {"approved": False, "reason": f"critical certs {summary['critical']} > {self.max_critical}", "flags": flags}
        return {"approved": True, "reason": "certs-healthy", "flags": flags}
''',
            "domain_subpkgs": [("acme", ["dns01", "http01", "eab_sign"], ["domain", "token"]), ("stores", ["k8s_secret", "vault_pki", "envoy_sds"], ["serial", "exp"])],
            "extra_subpkg_count": 6, "mods_per_extra": 8,
            "cfg_payload": {"max_critical": 0},
            "run_args": ["CR-03", [{"cn": "api.acme.io", "serial": "s100", "days_left": 18}, {"cn": "cdn.acme.io", "serial": "s101", "days_left": 75}]],
            "live_http_body": {"renew_window_days": 30, "revoked_serials": []},
            "fallback_file_body": {"renew_window_days": 20, "revoked_serials": []},
            "throw_http_body": {"renew_window_days": 30, "revoked_serials": ["s100"]},
        },
        # 14. feature_store — Online/offline ML feature freshness joiner
        {
            "pkg": "feature_store", "title": "ML Feature Store Materializer & Freshness Guard", "env_var": "FSTORE",
            "cfg_default": "/etc/fstore/store.json", "http_url": "https://fs.internal/v1/online",
            "fallback_path": "/var/cache/fstore/online.json", "report_dir": "/var/out/fstore",
            "shell_cmd": None, "engine_cls": "FeatureJoiner", "policy_cls": "FreshnessGate",
            "engine_body": '''"""Point-in-time feature joiner with staleness detection and imputation."""
from __future__ import annotations
from typing import Any

class FeatureJoiner:
    def __init__(self, cfg: dict[str, Any], ref_data: dict[str, Any]) -> None:
        self.online = ref_data.get("features", {})
        self.max_age = int(cfg.get("max_age_sec", 300))

    def process_batch(self, items: list[dict[str, Any]]) -> list[dict[str, Any]]:
        out = []
        for ent in items:
            rec = self.online.get(ent["entity"])
            if rec is None:
                bucket, val = "imputed", 0.0
            elif int(rec["age_sec"]) > self.max_age:
                bucket, val = "stale", float(rec["val"])
            else:
                bucket, val = "fresh", float(rec["val"])
            out.append({"id": ent["entity"], "bucket": bucket, "metric": val})
        return out

    def summarize(self, rows: list[dict[str, Any]]) -> dict[str, Any]:
        return {
            "entities": len(rows),
            "fresh": sum(1 for r in rows if r["bucket"] == "fresh"),
            "stale": sum(1 for r in rows if r["bucket"] == "stale"),
        }
''',
            "policy_body": '''"""Feature freshness SLA gate."""
from __future__ import annotations
from typing import Any

class FreshnessGate:
    def __init__(self, cfg: dict[str, Any]) -> None:
        self.max_stale = int(cfg.get("max_stale", 0))

    def evaluate(self, summary: dict[str, Any], rows: list[dict[str, Any]], *, source: str) -> dict[str, Any]:
        flags = [r["id"] for r in rows if r["bucket"] != "fresh"]
        if summary["stale"] > self.max_stale:
            return {"approved": False, "reason": f"stale features {summary['stale']} > {self.max_stale}", "flags": flags}
        return {"approved": True, "reason": "features-fresh", "flags": flags}
''',
            "domain_subpkgs": [("registry", ["entity_def", "view_spec", "lineage"], ["entity", "ver"]), ("materializers", ["spark_job", "flink_op", "duckdb_sync"], ["view", "rows"])],
            "extra_subpkg_count": 7, "mods_per_extra": 9,
            "cfg_payload": {"max_age_sec": 300, "max_stale": 0},
            "run_args": ["FS-44", [{"entity": "u1"}, {"entity": "u2"}, {"entity": "u3"}]],
            "live_http_body": {"features": {"u1": {"val": 0.85, "age_sec": 40}, "u2": {"val": 0.62, "age_sec": 120}}},
            "fallback_file_body": {"features": {"u1": {"val": 0.80, "age_sec": 250}, "u2": {"val": 0.60, "age_sec": 290}}},
            "throw_http_body": {"features": {"u1": {"val": 0.85, "age_sec": 900}, "u2": {"val": 0.62, "age_sec": 50}}},
        },
        # 15. search_ranker — Hybrid BM25 + recency + boost reranker
        {
            "pkg": "search_ranker", "title": "Hybrid BM25 & Boost Search Reranker", "env_var": "SRANK",
            "cfg_default": "/etc/srank/ranker.json", "http_url": "https://rank.internal/v1/weights",
            "fallback_path": "/var/cache/srank/weights.json", "report_dir": "/var/out/srank",
            "shell_cmd": None, "engine_cls": "HybridReranker", "policy_cls": "RelevanceGate",
            "engine_body": '''"""Combines BM25, semantic score, and recency boost with tier bucketing."""
from __future__ import annotations
from typing import Any

class HybridReranker:
    def __init__(self, cfg: dict[str, Any], ref_data: dict[str, Any]) -> None:
        self.w_bm25 = float(ref_data.get("w_bm25", 0.5))
        self.w_vec = float(ref_data.get("w_vec", 0.5))

    def process_batch(self, items: list[dict[str, Any]]) -> list[dict[str, Any]]:
        out = []
        for doc in items:
            score = round(self.w_bm25 * float(doc["bm25"]) + self.w_vec * float(doc["vec"]) + float(doc.get("boost", 0.0)), 4)
            bucket = "top" if score >= 0.7 else ("mid" if score >= 0.4 else "low")
            out.append({"id": doc["id"], "bucket": bucket, "metric": score})
        out.sort(key=lambda r: (-r["metric"], r["id"]))
        return out

    def summarize(self, rows: list[dict[str, Any]]) -> dict[str, Any]:
        return {"docs": len(rows), "top_score": rows[0]["metric"] if rows else 0.0, "top_id": rows[0]["id"] if rows else None}
''',
            "policy_body": '''"""Minimum top-result relevance confidence gate."""
from __future__ import annotations
from typing import Any

class RelevanceGate:
    def __init__(self, cfg: dict[str, Any]) -> None:
        self.min_top = float(cfg.get("min_top_score", 0.6))

    def evaluate(self, summary: dict[str, Any], rows: list[dict[str, Any]], *, source: str) -> dict[str, Any]:
        flags = [r["id"] for r in rows if r["bucket"] == "top"]
        if summary["top_score"] < self.min_top:
            return {"approved": False, "reason": f"top_score {summary['top_score']} < {self.min_top}", "flags": flags}
        return {"approved": True, "reason": "relevant", "flags": flags}
''',
            "domain_subpkgs": [("index", ["inv_postings", "hnsw_ann", "facet_agg"], ["doc_id", "term"]), ("query", ["synonym_exp", "spell_fix", "intent_cls"], ["q", "lang"])],
            "extra_subpkg_count": 8, "mods_per_extra": 8,
            "cfg_payload": {"min_top_score": 0.6},
            "run_args": ["SRK-11", [{"id": "d1", "bm25": 0.8, "vec": 0.6, "boost": 0.1}, {"id": "d2", "bm25": 0.4, "vec": 0.9, "boost": 0.0}]],
            "live_http_body": {"w_bm25": 0.6, "w_vec": 0.4},
            "fallback_file_body": {"w_bm25": 0.5, "w_vec": 0.5},
            "throw_http_body": {"w_bm25": 0.1, "w_vec": 0.1},
        },
        # 16. webhook_hub — Signed HMAC webhook delivery & circuit breaker
        {
            "pkg": "webhook_hub", "title": "Signed HMAC Webhook Delivery Hub", "env_var": "WHHUB",
            "cfg_default": "/etc/whhub/hub.json", "http_url": "https://hooks.internal/v1/endpoints",
            "fallback_path": "/var/cache/whhub/endpoints.json", "report_dir": "/var/out/whhub",
            "shell_cmd": None, "engine_cls": "WebhookSigner", "policy_cls": "DeliveryHealthGate",
            "engine_body": '''"""Computes deterministic HMAC-SHA256 webhook signatures and checks endpoint circuit states."""
from __future__ import annotations
import hashlib
import hmac
from typing import Any

class WebhookSigner:
    def __init__(self, cfg: dict[str, Any], ref_data: dict[str, Any]) -> None:
        self.endpoints = ref_data.get("endpoints", {})

    def process_batch(self, items: list[dict[str, Any]]) -> list[dict[str, Any]]:
        out = []
        for ev in items:
            ep = self.endpoints.get(ev["target"], {"secret": "k", "circuit": "open"})
            sig = hmac.new(ep["secret"].encode("utf-8"), ev["body"].encode("utf-8"), hashlib.sha256).hexdigest()[:12]
            bucket = "queued" if ep.get("circuit") == "closed" else "circuit_open"
            out.append({"id": ev["id"], "bucket": bucket, "metric": float(len(ev["body"])), "sig": sig})
        return out

    def summarize(self, rows: list[dict[str, Any]]) -> dict[str, Any]:
        return {"events": len(rows), "open_circuits": sum(1 for r in rows if r["bucket"] == "circuit_open")}
''',
            "policy_body": '''"""Webhook circuit-breaker failure gate."""
from __future__ import annotations
from typing import Any

class DeliveryHealthGate:
    def __init__(self, cfg: dict[str, Any]) -> None:
        self.max_open = int(cfg.get("max_open_circuits", 0))

    def evaluate(self, summary: dict[str, Any], rows: list[dict[str, Any]], *, source: str) -> dict[str, Any]:
        flags = [r["id"] for r in rows if r["bucket"] == "circuit_open"]
        if summary["open_circuits"] > self.max_open:
            return {"approved": False, "reason": f"open circuits {summary['open_circuits']} > {self.max_open}", "flags": flags}
        return {"approved": True, "reason": "deliverable", "flags": flags}
''',
            "domain_subpkgs": [("delivery", ["retry_sched", "backoff_exp", "tls_pin"], ["ep", "status"]), ("signing", ["key_ring", "replay_win", "headers"], ["sig", "ts"])],
            "extra_subpkg_count": 7, "mods_per_extra": 8,
            "cfg_payload": {"max_open_circuits": 0},
            "run_args": ["WH-05", [{"id": "e1", "target": "billing", "body": '{"paid":true}'}, {"id": "e2", "target": "crm", "body": '{"tier":"pro"}'}]],
            "live_http_body": {"endpoints": {"billing": {"secret": "s1", "circuit": "closed"}, "crm": {"secret": "s2", "circuit": "closed"}}},
            "fallback_file_body": {"endpoints": {"billing": {"secret": "s1-old", "circuit": "closed"}, "crm": {"secret": "s2-old", "circuit": "closed"}}},
            "throw_http_body": {"endpoints": {"billing": {"secret": "s1", "circuit": "open"}, "crm": {"secret": "s2", "circuit": "closed"}}},
        },
        # 17. cost_finops — Cloud spend allocator & RI discount engine
        {
            "pkg": "cost_finops", "title": "Cloud FinOps Cost Allocator & RI Matcher", "env_var": "FINOPS",
            "cfg_default": "/etc/finops/budget.json", "http_url": "https://cloud.internal/v1/discounts",
            "fallback_path": "/var/cache/finops/discounts.json", "report_dir": "/var/out/finops",
            "shell_cmd": None, "engine_cls": "SpendAllocator", "policy_cls": "AnomalyBudgetGate",
            "engine_body": '''"""Applies reserved-instance discounts and allocates spend by team."""
from __future__ import annotations
from typing import Any

class SpendAllocator:
    def __init__(self, cfg: dict[str, Any], ref_data: dict[str, Any]) -> None:
        self.discounts = ref_data.get("ri_discounts", {})

    def process_batch(self, items: list[dict[str, Any]]) -> list[dict[str, Any]]:
        out = []
        for row in items:
            disc = float(self.discounts.get(row["sku"], 0.0))
            net = round(float(row["hours"]) * float(row["rate"]) * (1.0 - disc), 2)
            out.append({"id": row["id"], "bucket": row["team"], "metric": net})
        return out

    def summarize(self, rows: list[dict[str, Any]]) -> dict[str, Any]:
        return {"lines": len(rows), "total_usd": round(sum(r["metric"] for r in rows), 2)}
''',
            "policy_body": '''"""Daily cloud spend ceiling gate."""
from __future__ import annotations
from typing import Any

class AnomalyBudgetGate:
    def __init__(self, cfg: dict[str, Any]) -> None:
        self.cap_usd = float(cfg.get("cap_usd", 1000.0))

    def evaluate(self, summary: dict[str, Any], rows: list[dict[str, Any]], *, source: str) -> dict[str, Any]:
        flags = [r["id"] for r in rows if r["metric"] >= 400.0]
        if summary["total_usd"] > self.cap_usd:
            return {"approved": False, "reason": f"spend {summary['total_usd']} > {self.cap_usd}", "flags": flags}
        return {"approved": True, "reason": "within-budget", "flags": flags}
''',
            "domain_subpkgs": [("cur", ["aws_cur", "gcp_bq", "azure_ea"], ["sku", "usd"]), ("tags", ["owner_map", "env_split", "untagged"], ["team", "env"])],
            "extra_subpkg_count": 7, "mods_per_extra": 9,
            "cfg_payload": {"cap_usd": 800.0},
            "run_args": ["FN-90", [{"id": "l1", "team": "ml", "sku": "gpu.a100", "hours": 100, "rate": 6.0}, {"id": "l2", "team": "core", "sku": "cpu.m6", "hours": 200, "rate": 1.0}]],
            "live_http_body": {"ri_discounts": {"gpu.a100": 0.35, "cpu.m6": 0.20}},
            "fallback_file_body": {"ri_discounts": {"gpu.a100": 0.30, "cpu.m6": 0.10}},
            "throw_http_body": {"ri_discounts": {"gpu.a100": 0.0, "cpu.m6": 0.0}},
        },
        # 18. backup_vault — Incremental snapshot planner & GFS retention pruner
        {
            "pkg": "backup_vault", "title": "Incremental Snapshot & Retention Vault", "env_var": "BVAULT",
            "cfg_default": "/etc/bvault/vault.json", "http_url": "https://vault.internal/v1/manifest",
            "fallback_path": "/var/cache/bvault/manifest.json", "report_dir": "/var/out/bvault",
            "shell_cmd": ["vault-verify", "--sha256"], "engine_cls": "SnapshotPlanner", "policy_cls": "RetentionGate",
            "engine_body": '''"""Computes incremental block delta sizes and GFS keep/prune actions."""
from __future__ import annotations
from typing import Any

class SnapshotPlanner:
    def __init__(self, cfg: dict[str, Any], ref_data: dict[str, Any]) -> None:
        self.existing = set(ref_data.get("stored_blocks", []))
        self.keep_days = int(ref_data.get("keep_days", 14))

    def process_batch(self, items: list[dict[str, Any]]) -> list[dict[str, Any]]:
        out = []
        for snap in items:
            new_blocks = [b for b in snap["blocks"] if b not in self.existing]
            bucket = "prune" if int(snap["age_days"]) > self.keep_days else "retain"
            out.append({"id": snap["id"], "bucket": bucket, "metric": float(len(new_blocks))})
        return out

    def summarize(self, rows: list[dict[str, Any]]) -> dict[str, Any]:
        return {
            "snapshots": len(rows),
            "retained": sum(1 for r in rows if r["bucket"] == "retain"),
            "new_blocks": int(sum(r["metric"] for r in rows)),
        }
''',
            "policy_body": '''"""Minimum retained snapshot safety gate."""
from __future__ import annotations
from typing import Any

class RetentionGate:
    def __init__(self, cfg: dict[str, Any]) -> None:
        self.min_retained = int(cfg.get("min_retained", 1))

    def evaluate(self, summary: dict[str, Any], rows: list[dict[str, Any]], *, source: str) -> dict[str, Any]:
        flags = [r["id"] for r in rows if r["bucket"] == "prune"]
        if summary["retained"] < self.min_retained:
            return {"approved": False, "reason": f"retained {summary['retained']} < {self.min_retained}", "flags": flags}
        return {"approved": True, "reason": "retention-safe", "flags": flags}
''',
            "domain_subpkgs": [("chunks", ["cdc_split", "zstd_pack", "merkle_chk"], ["blk", "sha"]), ("tiers", ["hot_ssd", "glacier_arc", "restore_op"], ["snap", "tier"])],
            "extra_subpkg_count": 6, "mods_per_extra": 9,
            "cfg_payload": {"min_retained": 1},
            "run_args": ["BV-18", [{"id": "s1", "age_days": 5, "blocks": ["b1", "b2", "b3"]}, {"id": "s2", "age_days": 20, "blocks": ["b1", "b4"]}]],
            "live_http_body": {"stored_blocks": ["b1", "b2"], "keep_days": 14},
            "fallback_file_body": {"stored_blocks": ["b1"], "keep_days": 14},
            "throw_http_body": {"stored_blocks": ["b1"], "keep_days": 2},
        },
        # 19. dns_control — Geo-weighted DNS zone compiler & failover
        {
            "pkg": "dns_control", "title": "Geo-Weighted DNS Zone Compiler & Failover", "env_var": "DNSCTL",
            "cfg_default": "/etc/dnsctl/zone.json", "http_url": "https://health.internal/v1/pops",
            "fallback_path": "/var/cache/dnsctl/pops.json", "report_dir": "/var/out/dnsctl",
            "shell_cmd": None, "engine_cls": "ZoneCompiler", "policy_cls": "QuorumPopGate",
            "engine_body": '''"""Compiles weighted A/AAAA records excluding unhealthy edge PoPs."""
from __future__ import annotations
from typing import Any

class ZoneCompiler:
    def __init__(self, cfg: dict[str, Any], ref_data: dict[str, Any]) -> None:
        self.healthy = set(ref_data.get("healthy_pops", []))

    def process_batch(self, items: list[dict[str, Any]]) -> list[dict[str, Any]]:
        out = []
        for rec in items:
            ok = rec["pop"] in self.healthy
            out.append({"id": rec["pop"], "bucket": "active" if ok else "drained", "metric": float(rec["weight"] if ok else 0)})
        return out

    def summarize(self, rows: list[dict[str, Any]]) -> dict[str, Any]:
        active = sum(1 for r in rows if r["bucket"] == "active")
        return {"pops": len(rows), "active_pops": active, "total_weight": int(sum(r["metric"] for r in rows))}
''',
            "policy_body": '''"""Minimum healthy DNS PoP quorum gate."""
from __future__ import annotations
from typing import Any

class QuorumPopGate:
    def __init__(self, cfg: dict[str, Any]) -> None:
        self.min_pops = int(cfg.get("min_active_pops", 2))

    def evaluate(self, summary: dict[str, Any], rows: list[dict[str, Any]], *, source: str) -> dict[str, Any]:
        flags = [r["id"] for r in rows if r["bucket"] == "drained"]
        if summary["active_pops"] < self.min_pops:
            return {"approved": False, "reason": f"active pops {summary['active_pops']} < {self.min_pops}", "flags": flags}
        return {"approved": True, "reason": "quorum-ok", "flags": flags}
''',
            "domain_subpkgs": [("zones", ["soa_bump", "rrset_fmt", "dnssec_sign"], ["zone", "ttl"]), ("geo", ["edns_map", "latency_tbl", "anycast"], ["region", "pop"])],
            "extra_subpkg_count": 8, "mods_per_extra": 8,
            "cfg_payload": {"min_active_pops": 2},
            "run_args": ["DNS-02", [{"pop": "us-east", "weight": 50}, {"pop": "eu-west", "weight": 30}, {"pop": "ap-south", "weight": 20}]],
            "live_http_body": {"healthy_pops": ["us-east", "eu-west", "ap-south"]},
            "fallback_file_body": {"healthy_pops": ["us-east", "eu-west"]},
            "throw_http_body": {"healthy_pops": ["us-east"]},
        },
        # 20. migration_ctl — Zero-downtime DB DDL lock analyzer
        {
            "pkg": "migration_ctl", "title": "Zero-Downtime DB DDL Lock Risk Analyzer", "env_var": "MIGCTL",
            "cfg_default": "/etc/migctl/ddl.json", "http_url": "https://dbmeta.internal/v1/tables",
            "fallback_path": "/var/cache/migctl/tables.json", "report_dir": "/var/out/migctl",
            "shell_cmd": None, "engine_cls": "DdlLockAnalyzer", "policy_cls": "LockSafetyGate",
            "engine_body": '''"""Scores SQL DDL migration statements for ACCESS EXCLUSIVE table lock risk."""
from __future__ import annotations
from typing import Any

class DdlLockAnalyzer:
    def __init__(self, cfg: dict[str, Any], ref_data: dict[str, Any]) -> None:
        self.row_counts = ref_data.get("table_rows", {})

    def process_batch(self, items: list[dict[str, Any]]) -> list[dict[str, Any]]:
        out = []
        for stmt in items:
            sql_u = stmt["sql"].upper()
            rows = int(self.row_counts.get(stmt["table"], 1000))
            blocking = ("ALTER TABLE" in sql_u and "NOT NULL" in sql_u) or ("CREATE INDEX" in sql_u and "CONCURRENTLY" not in sql_u)
            risk = round((rows / 10000.0) * (3.0 if blocking else 0.5), 2)
            bucket = "blocking_lock" if (blocking and rows >= 50000) else "safe"
            out.append({"id": stmt["id"], "bucket": bucket, "metric": risk})
        return out

    def summarize(self, rows: list[dict[str, Any]]) -> dict[str, Any]:
        return {"migrations": len(rows), "blocking": sum(1 for r in rows if r["bucket"] == "blocking_lock")}
''',
            "policy_body": '''"""Zero blocking-DDL production lock gate."""
from __future__ import annotations
from typing import Any

class LockSafetyGate:
    def __init__(self, cfg: dict[str, Any]) -> None:
        self.max_blocking = int(cfg.get("max_blocking", 0))

    def evaluate(self, summary: dict[str, Any], rows: list[dict[str, Any]], *, source: str) -> dict[str, Any]:
        flags = [r["id"] for r in rows if r["bucket"] == "blocking_lock"]
        if summary["blocking"] > self.max_blocking:
            return {"approved": False, "reason": f"blocking DDL {flags}", "flags": flags}
        return {"approved": True, "reason": "online-safe", "flags": flags}
''',
            "domain_subpkgs": [("sql", ["pg_dialect", "mysql_ddl", "lock_graph"], ["rev", "tbl"]), ("apply", ["tx_runner", "shadow_tbl", "rollback_op"], ["rev", "ms"])],
            "extra_subpkg_count": 7, "mods_per_extra": 8,
            "cfg_payload": {"max_blocking": 0},
            "run_args": ["MG-41", [{"id": "001", "table": "events", "sql": "CREATE INDEX CONCURRENTLY idx_ev_ts ON events(ts)"}, {"id": "002", "table": "configs", "sql": "ALTER TABLE configs ALTER COLUMN k SET NOT NULL"}]],
            "live_http_body": {"table_rows": {"events": 500000, "configs": 2000}},
            "fallback_file_body": {"table_rows": {"events": 450000, "configs": 3000}},
            "throw_http_body": {"table_rows": {"events": 500000, "configs": 120000}},
        },
        # 21. ml_eval_hub — Model benchmark harness & regression gate
        {
            "pkg": "ml_eval_hub", "title": "ML Model Eval Aggregator & Regression Gate", "env_var": "MLEVAL",
            "cfg_default": "/etc/mleval/bench.json", "http_url": "https://eval.internal/v1/baseline",
            "fallback_path": "/var/cache/mleval/baseline.json", "report_dir": "/var/out/mleval",
            "shell_cmd": None, "engine_cls": "MetricAggregator", "policy_cls": "RegressionGate",
            "engine_body": '''"""Computes candidate vs baseline benchmark deltas across task suites."""
from __future__ import annotations
from typing import Any

class MetricAggregator:
    def __init__(self, cfg: dict[str, Any], ref_data: dict[str, Any]) -> None:
        self.baseline = ref_data.get("scores", {})

    def process_batch(self, items: list[dict[str, Any]]) -> list[dict[str, Any]]:
        out = []
        for s in items:
            base = float(self.baseline.get(s["suite"], 0.5))
            delta = round(float(s["score"]) - base, 4)
            bucket = "regressed" if delta < -0.02 else ("improved" if delta > 0.02 else "neutral")
            out.append({"id": s["suite"], "bucket": bucket, "metric": delta})
        return out

    def summarize(self, rows: list[dict[str, Any]]) -> dict[str, Any]:
        return {
            "suites": len(rows),
            "regressed": sum(1 for r in rows if r["bucket"] == "regressed"),
            "mean_delta": round(sum(r["metric"] for r in rows) / max(1, len(rows)), 4),
        }
''',
            "policy_body": '''"""Zero benchmark regression promotion gate."""
from __future__ import annotations
from typing import Any

class RegressionGate:
    def __init__(self, cfg: dict[str, Any]) -> None:
        self.max_reg = int(cfg.get("max_regressions", 0))

    def evaluate(self, summary: dict[str, Any], rows: list[dict[str, Any]], *, source: str) -> dict[str, Any]:
        flags = [r["id"] for r in rows if r["bucket"] == "regressed"]
        if summary["regressed"] > self.max_reg:
            return {"approved": False, "reason": f"regressions on {flags}", "flags": flags}
        return {"approved": True, "reason": "promote", "flags": flags}
''',
            "domain_subpkgs": [("metrics", ["exact_match", "pass_at_k", "bootstrap_ci"], ["suite", "val"]), ("reports", ["md_table", "json_diff", "leaderboard"], ["run", "delta"])],
            "extra_subpkg_count": 8, "mods_per_extra": 9,
            "cfg_payload": {"max_regressions": 0},
            "run_args": ["EV-66", [{"suite": "code_py", "score": 0.84}, {"suite": "code_ts", "score": 0.78}, {"suite": "long_65k", "score": 0.72}]],
            "live_http_body": {"scores": {"code_py": 0.80, "code_ts": 0.76, "long_65k": 0.68}},
            "fallback_file_body": {"scores": {"code_py": 0.81, "code_ts": 0.77, "long_65k": 0.70}},
            "throw_http_body": {"scores": {"code_py": 0.90, "code_ts": 0.76, "long_65k": 0.68}},
        },
        # 22. supply_chain — SBOM dependency CVE & license policy gate
        {
            "pkg": "supply_chain", "title": "SBOM Dependency CVE & License Policy Gate", "env_var": "SBOMCTL",
            "cfg_default": "/etc/sbom/policy.json", "http_url": "https://vuln.internal/v1/advisories",
            "fallback_path": "/var/cache/sbom/advisories.json", "report_dir": "/var/out/sbom",
            "shell_cmd": ["sbom-attest", "--check"], "engine_cls": "SbomAuditor", "policy_cls": "ComplianceGate",
            "engine_body": '''"""Matches SBOM components against CVE advisories and disallowed licenses."""
from __future__ import annotations
from typing import Any

class SbomAuditor:
    def __init__(self, cfg: dict[str, Any], ref_data: dict[str, Any]) -> None:
        self.cves = ref_data.get("cves", {})
        self.banned_lic = set(cfg.get("banned_licenses", ["AGPL-3.0"]))

    def process_batch(self, items: list[dict[str, Any]]) -> list[dict[str, Any]]:
        out = []
        for comp in items:
            pkg_key = f"{comp['name']}@{comp['version']}"
            cvss = float(self.cves.get(pkg_key, 0.0))
            bad_lic = comp["license"] in self.banned_lic
            bucket = "blocked" if (cvss >= 7.0 or bad_lic) else ("warn" if cvss > 0 else "clean")
            out.append({"id": pkg_key, "bucket": bucket, "metric": cvss})
        return out

    def summarize(self, rows: list[dict[str, Any]]) -> dict[str, Any]:
        return {"packages": len(rows), "blocked": sum(1 for r in rows if r["bucket"] == "blocked")}
''',
            "policy_body": '''"""SBOM security and license compliance gate."""
from __future__ import annotations
from typing import Any

class ComplianceGate:
    def __init__(self, cfg: dict[str, Any]) -> None:
        self.max_blocked = int(cfg.get("max_blocked", 0))

    def evaluate(self, summary: dict[str, Any], rows: list[dict[str, Any]], *, source: str) -> dict[str, Any]:
        flags = [r["id"] for r in rows if r["bucket"] == "blocked"]
        if summary["blocked"] > self.max_blocked:
            return {"approved": False, "reason": f"blocked packages {flags}", "flags": flags}
        return {"approved": True, "reason": "sbom-clean", "flags": flags}
''',
            "domain_subpkgs": [("sbom", ["cyclonedx", "spdx_io", "purl_parse"], ["purl", "lic"]), ("vuln", ["osv_feed", "nvd_cvss", "vex_filter"], ["cve", "cvss"])],
            "extra_subpkg_count": 7, "mods_per_extra": 8,
            "cfg_payload": {"banned_licenses": ["AGPL-3.0"], "max_blocked": 0},
            "run_args": ["SB-15", [{"name": "httpx", "version": "0.27.0", "license": "BSD-3"}, {"name": "click", "version": "8.1.7", "license": "BSD-3"}]],
            "live_http_body": {"cves": {"httpx@0.27.0": 4.2}},
            "fallback_file_body": {"cves": {"click@8.1.7": 3.1}},
            "throw_http_body": {"cves": {"httpx@0.27.0": 8.8}},
        },
        # 23. chat_mod — Real-time message moderation & escalation scorer
        {
            "pkg": "chat_mod", "title": "Real-Time Message Moderation & Escalation Pipeline", "env_var": "CHATMOD",
            "cfg_default": "/etc/chatmod/mod.json", "http_url": "https://trust.internal/v1/blocklist",
            "fallback_path": "/var/cache/chatmod/blocklist.json", "report_dir": "/var/out/chatmod",
            "shell_cmd": None, "engine_cls": "MessageScorer", "policy_cls": "EscalationGate",
            "engine_body": '''"""Scores chat messages using blocklist tokens, caps ratio, and sender trust."""
from __future__ import annotations
from typing import Any

class MessageScorer:
    def __init__(self, cfg: dict[str, Any], ref_data: dict[str, Any]) -> None:
        self.banned = [w.lower() for w in ref_data.get("banned_terms", [])]

    def process_batch(self, items: list[dict[str, Any]]) -> list[dict[str, Any]]:
        out = []
        for m in items:
            txt = m["text"]
            hits = sum(1 for b in self.banned if b in txt.lower())
            trust_pen = max(0.0, 1.0 - float(m.get("trust", 1.0)))
            score = round(hits * 0.6 + trust_pen * 0.4, 3)
            bucket = "quarantine" if score >= 0.8 else ("review" if score >= 0.35 else "allow")
            out.append({"id": m["id"], "bucket": bucket, "metric": score})
        return out

    def summarize(self, rows: list[dict[str, Any]]) -> dict[str, Any]:
        return {"messages": len(rows), "quarantined": sum(1 for r in rows if r["bucket"] == "quarantine")}
''',
            "policy_body": '''"""Moderation quarantine spike gate."""
from __future__ import annotations
from typing import Any

class EscalationGate:
    def __init__(self, cfg: dict[str, Any]) -> None:
        self.max_quarantine = int(cfg.get("max_quarantine", 0))

    def evaluate(self, summary: dict[str, Any], rows: list[dict[str, Any]], *, source: str) -> dict[str, Any]:
        flags = [r["id"] for r in rows if r["bucket"] != "allow"]
        if summary["quarantined"] > self.max_quarantine:
            return {"approved": False, "reason": f"quarantined {summary['quarantined']} > {self.max_quarantine}", "flags": flags}
        return {"approved": True, "reason": "channel-safe", "flags": flags}
''',
            "domain_subpkgs": [("signals", ["spam_vel", "link_rep", "unicode_norm"], ["user", "score"]), ("actions", ["shadow_ban", "mute_win", "appeal_q"], ["msg_id", "act"])],
            "extra_subpkg_count": 8, "mods_per_extra": 8,
            "cfg_payload": {"max_quarantine": 0},
            "run_args": ["CM-23", [{"id": "m1", "text": "hello team great work", "trust": 0.9}, {"id": "m2", "text": "check promo link", "trust": 0.6}]],
            "live_http_body": {"banned_terms": ["phish", "scam"]},
            "fallback_file_body": {"banned_terms": ["phish", "promo"]},
            "throw_http_body": {"banned_terms": ["promo", "link"]},
        },
        # 24. fleet_ota — IoT edge firmware OTA rollout ring controller
        {
            "pkg": "fleet_ota", "title": "Edge Fleet Firmware OTA Rollout Controller", "env_var": "FLOTA",
            "cfg_default": "/etc/flota/ota.json", "http_url": "https://fleet.internal/v1/telemetry",
            "fallback_path": "/var/cache/flota/telemetry.json", "report_dir": "/var/out/flota",
            "shell_cmd": None, "engine_cls": "CohortPlanner", "policy_cls": "RolloutHaltGate",
            "engine_body": '''"""Evaluates device cohort battery/crash telemetry for OTA ring eligibility."""
from __future__ import annotations
from typing import Any

class CohortPlanner:
    def __init__(self, cfg: dict[str, Any], ref_data: dict[str, Any]) -> None:
        self.crashes = ref_data.get("crash_rate", {})
        self.min_batt = int(cfg.get("min_battery_pct", 40))

    def process_batch(self, items: list[dict[str, Any]]) -> list[dict[str, Any]]:
        out = []
        for dev in items:
            cr = float(self.crashes.get(dev["ring"], 0.0))
            if cr >= 0.05:
                bucket = "halted"
            elif int(dev["battery"]) < self.min_batt:
                bucket = "deferred_low_batt"
            else:
                bucket = "eligible"
            out.append({"id": dev["id"], "bucket": bucket, "metric": round(cr * 100.0, 2)})
        return out

    def summarize(self, rows: list[dict[str, Any]]) -> dict[str, Any]:
        return {
            "devices": len(rows),
            "eligible": sum(1 for r in rows if r["bucket"] == "eligible"),
            "halted": sum(1 for r in rows if r["bucket"] == "halted"),
        }
''',
            "policy_body": '''"""OTA crash-rate halt switch gate."""
from __future__ import annotations
from typing import Any

class RolloutHaltGate:
    def __init__(self, cfg: dict[str, Any]) -> None:
        self.max_halted = int(cfg.get("max_halted", 0))

    def evaluate(self, summary: dict[str, Any], rows: list[dict[str, Any]], *, source: str) -> dict[str, Any]:
        flags = [r["id"] for r in rows if r["bucket"] != "eligible"]
        if summary["halted"] > self.max_halted:
            return {"approved": False, "reason": f"halted rings on {flags}", "flags": flags}
        return {"approved": True, "reason": "ring-healthy", "flags": flags}
''',
            "domain_subpkgs": [("firmware", ["delta_patch", "ed25519_sig", "ab_slot"], ["fw", "sha"]), ("cohorts", ["canary_1p", "beta_10p", "ga_100p"], ["ring", "devs"])],
            "extra_subpkg_count": 9, "mods_per_extra": 9,
            "cfg_payload": {"min_battery_pct": 40, "max_halted": 0},
            "run_args": ["OTA-09", [{"id": "d1", "ring": "canary", "battery": 85}, {"id": "d2", "ring": "canary", "battery": 30}, {"id": "d3", "ring": "beta", "battery": 75}]],
            "live_http_body": {"crash_rate": {"canary": 0.01, "beta": 0.005}},
            "fallback_file_body": {"crash_rate": {"canary": 0.02, "beta": 0.01}},
            "throw_http_body": {"crash_rate": {"canary": 0.08, "beta": 0.01}},
        },
    ]

    all_tasks: list[dict[str, Any]] = []
    for d in domains:
        fb = _make_default_fallback(d["pkg"], "source_mode", "fallback")
        all_tasks.extend(_build_synthetic_repo_spec(**d, fallback_body=fb))
    return all_tasks


# ===========================================================================
# BUCKET C — PART C1: 56 Hairy Python Semantics, Stdlib & Effectful Families (112 tasks)
# ===========================================================================

def _single_task(
    task_id: str,
    family: str,
    source: str,
    args: list[Any],
    features: list[str],
    *,
    entry: str = "run",
    scripted: dict[str, list[dict[str, Any]]] | None = None,
    times: list[float] | None = None,
    allow_throw: bool = False,
    bucket: str = "bucket_c_hairy_py",
) -> dict[str, Any]:
    calls = (
        _record_fixture(
            entry=entry,
            args=args,
            source=source,
            scripted=scripted,
            times=times,
            allow_throw=allow_throw,
        )
        if (scripted is not None or times is not None)
        else []
    )
    feats = sorted(set(features) | {"python", "hairy-semantics"} | ({"effectful", "causal-branch"} if calls else set()) | ({"exception"} if allow_throw else set()))
    return {
        "id": task_id,
        "family": family,
        "language": "py",
        "source": source.strip() + "\n",
        "entry": entry,
        "args": encode_readable(args),
        "fixture": {"calls": calls},
        "tier": 5 if calls or allow_throw else 4,
        "features": feats,
        "metadata": {"bucket": bucket, "sourceOrigin": "stage10-hairy-py"},
    }


def build_bucket_c1_hairy_py() -> list[dict[str, Any]]:
    """56 brand-new hairy Python single-file families x 2 variants = 112 tasks."""
    specs: list[tuple[str, str, list[str], list[tuple[str, list[Any], bool]]]] = [
        # 1. Closures & late-binding loop pitfalls
        ("closure_late_binding", '''
def run(nums):
    late = []
    early = []
    acc = 0
    for n in nums:
        late.append(lambda x: x + n)
        early.append(lambda x, n=n: x + n)
        def bump(d):
            nonlocal acc
            acc += d
            return acc
        bump(n)
    return {
        "late": [f(10) for f in late],
        "early": [f(10) for f in early],
        "acc": acc,
    }
''', ["closure", "nonlocal"], [("a", [[1, 3, 5]], False), ("b", [[2, -1, 4, 7]], False)]),

        # 2. Generators: yield from, send, StopIteration.value
        ("generator_yield_from_send", '''
def sub_accum(limit):
    total = 0
    while total < limit:
        val = yield total
        if val is None:
            break
        total += val
    return ("done", total)

def driver(limit):
    res = yield from sub_accum(limit)
    yield ("summary", res)

def run(limit, inputs):
    g = driver(limit)
    out = [next(g)]
    for x in inputs:
        try:
            out.append(g.send(x))
        except StopIteration:
            break
    return out
''', ["generator", "yield-from", "send"], [("hit", [10, [4, 3, 5, 2]], False), ("none", [20, [5, None]], False)]),

        # 3. Stacked parameterized decorators with wraps & call order
        ("decorator_stack_wraps", '''
from functools import wraps

def run(xs, scale):
    log = []
    def tag(name):
        def deco(fn):
            @wraps(fn)
            def wrapper(*args):
                log.append(f"enter:{name}")
                res = fn(*args)
                log.append(f"exit:{name}:{res}")
                return res
            return wrapper
        return deco

    def multiply(k):
        def deco(fn):
            @wraps(fn)
            def wrapper(*args):
                return fn(*args) * k
            return wrapper
        return deco

    @tag("outer")
    @multiply(scale)
    @tag("inner")
    def total(vals):
        return sum(vals)

    val = total(xs)
    return {"name": total.__name__, "val": val, "log": log}
''', ["decorator", "wraps", "closure"], [("a", [[1, 2, 3], 4], False), ("b", [[5, -2, 7], 3], False)]),

        # 4. Data vs non-data descriptor precedence & __set_name__
        ("descriptor_precedence", '''
class Clamped:
    def __init__(self, lo, hi):
        self.lo, self.hi = lo, hi
    def __set_name__(self, owner, name):
        self.key = "_" + name
    def __get__(self, obj, objtype=None):
        if obj is None:
            return self
        return getattr(obj, self.key, self.lo)
    def __set__(self, obj, val):
        setattr(obj, self.key, max(self.lo, min(self.hi, val)))

class LazyRead:
    def __init__(self, default):
        self.default = default
    def __get__(self, obj, objtype=None):
        return self.default

class Box:
    level = Clamped(0, 10)
    tag = LazyRead("default-tag")

def run(v1, v2, shadow_tag):
    b = Box()
    b.level = v1
    b.__dict__["level"] = 999  # data descriptor still wins!
    before_tag = b.tag
    if shadow_tag:
        b.__dict__["tag"] = shadow_tag  # non-data descriptor shadowed!
    b.level = v2
    return {"level": b.level, "before_tag": before_tag, "after_tag": b.tag, "raw": b.__dict__["level"]}
''', ["descriptor", "class"], [("clamp_hi", [15, -3, "custom"], False), ("no_shadow", [4, 7, ""], False)]),

        # 5. __slots__, __getattr__, __getattribute__
        ("slots_getattr_protocol", '''
class ProxyNode:
    __slots__ = ("_data", "hits")
    def __init__(self, data):
        object.__setattr__(self, "_data", dict(data))
        object.__setattr__(self, "hits", [])
    def __getattribute__(self, name):
        if not name.startswith("_") and name != "hits":
            object.__getattribute__(self, "hits").append(name)
        return object.__getattribute__(self, name)
    def __getattr__(self, name):
        data = object.__getattribute__(self, "_data")
        if name in data:
            return data[name]
        raise AttributeError(f"missing:{name}")

def run(data, attrs):
    p = ProxyNode(data)
    vals = {}
    for a in attrs:
        vals[a] = getattr(p, a)
    return {"vals": vals, "hits": p.hits}
''', ["slots", "getattr", "class"], [("ok", [{"x": 10, "y": 20}, ["x", "y", "x"]], False), ("missing", [{"x": 1}, ["x", "z"]], True)]),

        # 6. Diamond MRO & cooperative super()
        ("mro_cooperative_super", '''
class Base:
    def __init__(self, trace, **kw):
        trace.append("Base")

class Left(Base):
    def __init__(self, trace, x=0, **kw):
        trace.append(f"Left:{x}")
        super().__init__(trace, **kw)

class Right(Base):
    def __init__(self, trace, y=0, **kw):
        trace.append(f"Right:{y}")
        super().__init__(trace, **kw)

class Diamond(Left, Right):
    def __init__(self, trace, **kw):
        trace.append("Diamond")
        super().__init__(trace, **kw)

def run(x, y):
    trace = []
    Diamond(trace, x=x, y=y)
    mro = [c.__name__ for c in Diamond.__mro__ if c is not object]
    return {"mro": mro, "trace": trace}
''', ["mro", "super", "class"], [("a", [3, 7], False), ("b", [-1, 9], False)]),

        # 7. __init_subclass__ plugin registry + __new__ interning
        ("init_subclass_new_intern", '''
class Token:
    _registry = {}
    _pool = {}
    def __init_subclass__(cls, kind=None, **kw):
        super().__init_subclass__(**kw)
        if kind:
            Token._registry[kind] = cls
    def __new__(cls, val):
        key = (cls.__name__, val)
        if key not in cls._pool:
            inst = super().__new__(cls)
            inst.val = val
            cls._pool[key] = inst
        return cls._pool[key]

class NumTok(Token, kind="num"):
    def eval(self): return int(self.val) * 2

class StrTok(Token, kind="str"):
    def eval(self): return self.val.upper()

def run(pairs):
    objs = [Token._registry[k](v) for k, v in pairs]
    same = len(objs) >= 2 and (objs[0] is objs[-1])
    return {"kinds": sorted(Token._registry), "evals": [o.eval() for o in objs], "interned_same": same}
''', ["metaclass-hooks", "new", "class"], [("same", [[["num", "5"], ["str", "hi"], ["num", "5"]]], False), ("diff", [[["str", "a"], ["str", "b"]]], False)]),

        # 8. try/except/else/finally & exception chaining
        ("try_except_else_finally", '''
def run(mode, override_return):
    log = []
    def inner():
        try:
            log.append("try")
            if mode == "val":
                raise ValueError("bad-val")
            if mode == "chain":
                try:
                    raise KeyError("k")
                except KeyError as e:
                    raise RuntimeError("wrapped") from e
        except ValueError as e:
            log.append(f"caught:{e}")
            return "from-except"
        else:
            log.append("else")
            return "from-else"
        finally:
            log.append("finally")
            if override_return:
                return "from-finally"
    out = inner()
    return {"out": out, "log": log}
''', ["exception", "finally", "chaining"], [("else_override", ["ok", True], False), ("chain_throw", ["chain", False], True)]),

        # 9. Custom context manager __enter__/__exit__ exception suppression
        ("contextmanager_suppress", '''
class Guard:
    def __init__(self, suppress_types, log):
        self.suppress_types = suppress_types
        self.log = log
    def __enter__(self):
        self.log.append("enter")
        return self
    def __exit__(self, exc_type, exc_val, tb):
        if exc_type is None:
            self.log.append("exit:clean")
            return False
        sup = issubclass(exc_type, self.suppress_types)
        self.log.append(f"exit:{exc_type.__name__}:sup={sup}")
        return sup

def run(raise_kind):
    log = []
    with Guard((ValueError,), log):
        if raise_kind == "value":
            raise ValueError("v")
        if raise_kind == "key":
            raise KeyError("k")
        log.append("body-ok")
    log.append("after")
    return log
''', ["contextmanager", "exception"], [("suppressed", ["value"], False), ("propagated", ["key"], True)]),

        # 10. Extended slice & negative-step slice mutations
        ("slice_step_mutation", '''
def run(xs, rep):
    a = list(xs)
    a[1:len(a):2] = rep[:len(a[1:len(a):2])]
    rev = a[::-2]
    del a[::3]
    return {"after": a, "rev_step2": rev}
''', ["slicing", "mutation"], [("a", [[0, 1, 2, 3, 4, 5, 6], [90, 91, 92]], False), ("b", [[10, 20, 30, 40, 50], [7, 8]], False)]),

        # 11. Mutable aliasing, shallow vs deep copy, list * n trap
        ("aliasing_shallow_deep_copy", '''
import copy

def run(n, val):
    grid_bad = [[0] * 2] * n
    grid_bad[0][1] = val
    orig = {"a": [1, 2], "b": [3]}
    sh = copy.copy(orig)
    dp = copy.deepcopy(orig)
    sh["a"].append(val)
    dp["b"].append(99)
    return {
        "grid_bad": grid_bad,
        "orig": orig,
        "shallow_same_a": sh["a"] is orig["a"],
        "deep_same_a": dp["a"] is orig["a"],
        "deep_b": dp["b"],
    }
''', ["aliasing", "copy", "mutation"], [("a", [3, 7], False), ("b", [2, -5], False)]),

        # 12. Walrus := leaking scope in comprehensions
        ("walrus_comprehension_scope", '''
def run(nums):
    last = -1
    kept = [y for x in nums if (y := x * x - 3) > 0]
    acc = 0
    running = [acc := acc + v for v in kept]
    return {"kept": kept, "running": running, "leaked_y": y if kept else None, "final_acc": acc}
''', ["walrus", "comprehension"], [("a", [[1, 2, 3, 4]], False), ("b", [[-3, 0, 2, 5]], False)]),

        # 13. itertools: groupby, tee, accumulate, zip_longest
        ("itertools_groupby_tee", '''
import itertools

def run(pairs):
    raw_groups = [(k, [v for _, v in g]) for k, g in itertools.groupby(pairs, key=lambda p: p[0])]
    t1, t2 = itertools.tee((v for _, v in pairs), 2)
    acc = list(itertools.accumulate(t1))
    zipped = list(itertools.zip_longest(t2, acc[1:], fillvalue=0))
    return {"groups": raw_groups, "acc": acc, "zipped": [list(z) for z in zipped]}
''', ["itertools", "iterator"], [("a", [[["a", 1], ["a", 2], ["b", 3], ["a", 4]]], False), ("b", [[["x", 5], ["y", 2], ["y", 8]]], False)]),

        # 14. functools: singledispatch, lru_cache, cmp_to_key
        ("functools_singledispatch_lru", '''
from functools import singledispatch, lru_cache, cmp_to_key

def run(items, n):
    @singledispatch
    def norm(x): return f"other:{x}"
    @norm.register(int)
    def _(x): return f"int:{x * 2}"
    @norm.register(str)
    def _(x): return f"str:{x.strip().upper()}"
    @norm.register(list)
    def _(x): return f"list:{len(x)}"

    @lru_cache(maxsize=32)
    def fib(k):
        return k if k <= 1 else fib(k - 1) + fib(k - 2)

    fval = fib(n)
    info = fib.cache_info()
    nums = sorted([3, 30, 34, 5, 9], key=cmp_to_key(lambda a, b: -1 if f"{a}{b}" > f"{b}{a}" else (1 if f"{a}{b}" < f"{b}{a}" else 0)))
    return {"normed": [norm(x) for x in items], "fib": fval, "hits": info.hits, "largest_concat": "".join(map(str, nums))}
''', ["functools", "singledispatch", "lru_cache"], [("a", [[1, " hi ", [1, 2], 3.5], 8], False), ("b", [["ok", 7, []], 10], False)]),

        # 15. collections: ChainMap & Counter arithmetic
        ("collections_chainmap_counter", '''
from collections import ChainMap, Counter

def run(base, overlay, words_a, words_b):
    cm = ChainMap(dict(overlay), dict(base))
    child = cm.new_child({"mode": "strict"})
    child["x"] = child.get("x", 0) + 10
    ca, cb = Counter(words_a), Counter(words_b)
    return {
        "child": dict(child),
        "parents_x": child.parents["x"],
        "union": dict(sorted((ca | cb).items())),
        "inter": dict(sorted((ca & cb).items())),
        "diff": dict(sorted((ca - cb).items())),
    }
''', ["collections", "ChainMap", "Counter"], [("a", [{"x": 1, "y": 2}, {"y": 9}, ["a", "a", "b"], ["a", "b", "b", "c"]], False), ("b", [{"x": 5}, {"x": 3, "z": 1}, ["k", "k", "m"], ["k"]], False)]),

        # 16. deque sliding window max & OrderedDict LRU
        ("deque_ordereddict_lru", '''
from collections import deque, OrderedDict

def run(nums, k, ops, cap):
    dq = deque()
    win_max = []
    for i, v in enumerate(nums):
        while dq and nums[dq[-1]] <= v:
            dq.pop()
        dq.append(i)
        if dq[0] <= i - k:
            dq.popleft()
        if i >= k - 1:
            win_max.append(nums[dq[0]])
    lru = OrderedDict()
    evicted = []
    for op, key, val in ops:
        if op == "put":
            if key in lru:
                lru.move_to_end(key)
            lru[key] = val
            if len(lru) > cap:
                evicted.append(lru.popitem(last=False)[0])
        elif op == "get" and key in lru:
            lru.move_to_end(key)
    return {"win_max": win_max, "lru_keys": list(lru.keys()), "evicted": evicted}
''', ["collections", "deque", "OrderedDict"], [("a", [[1, 3, -1, -3, 5, 3, 6, 7], 3, [["put", "a", 1], ["put", "b", 2], ["get", "a", 0], ["put", "c", 3]], 2], False), ("b", [[4, 2, 12, 3, 8], 2, [["put", "x", 1], ["put", "y", 2], ["put", "z", 3]], 2], False)]),

        # 17. heapq k-way merge & lazy deletion priority queue
        ("heapq_merge_lazy_del", '''
import heapq

def run(streams, cancels):
    merged = list(heapq.merge(*streams))
    pq = []
    cancelled = set(cancels)
    for idx, val in enumerate(merged):
        heapq.heappush(pq, (val, idx))
    popped = []
    while pq:
        val, idx = heapq.heappop(pq)
        if val in cancelled:
            cancelled.remove(val)
            continue
        popped.append(val)
    return {"merged": merged, "active": popped}
''', ["heapq", "algorithm"], [("a", [[[1, 4, 9], [2, 4, 7], [0, 5]], [4, 7]], False), ("b", [[[3, 8], [1, 3, 6]], [3]], False)]),

        # 18. bisect interval lookup & insort
        ("bisect_interval_map", '''
import bisect

def run(intervals, queries):
    merged = []
    for s, e in sorted(intervals):
        if merged and s <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], e)
        else:
            merged.append([s, e])
    starts = [iv[0] for iv in merged]
    hits = []
    for q in queries:
        idx = bisect.bisect_right(starts, q) - 1
        hits.append(idx >= 0 and merged[idx][0] <= q <= merged[idx][1])
    return {"merged": merged, "hits": hits}
''', ["bisect", "algorithm"], [("a", [[[1, 4], [2, 6], [8, 10], [10, 12]], [0, 3, 7, 10, 13]], False), ("b", [[[5, 9], [1, 3], [2, 6]], [1, 4, 9, 10]], False)]),

        # 19. re named groups, lookahead/lookbehind, callback sub
        ("regex_sub_backref", '''
import re

def run(text):
    dup = re.findall(r"\\b(?P<w>[a-z]+)\\s+(?P=w)\\b", text, flags=re.I)
    count = [0]
    def repl(m):
        count[0] += 1
        return f"<{m.group('k').upper()}={int(m.group('v')) + count[0]}>"
    subbed = re.sub(r"(?P<k>[a-z]+)=(?P<v>\\d+)(?!px)", repl, text)
    return {"dups": dup, "subbed": subbed, "replaced": count[0]}
''', ["regex", "closure"], [("a", ["go go a=10 b=20px c=3"], False), ("b", ["hi hi x=5 y=12 z=9px"], False)]),

        # 20. json custom object_hook & default encoder
        ("json_hooks_custom_codec", '''
import json

def run(raw):
    def hook(d):
        if "__pair__" in d:
            return tuple(d["__pair__"])
        if "__sum__" in d:
            return sum(d["__sum__"])
        return d
    parsed = json.loads(raw, object_hook=hook)
    def enc(obj):
        if isinstance(obj, tuple):
            return {"t": list(obj)}
        raise TypeError(type(obj).__name__)
    out = json.dumps(parsed, default=enc, sort_keys=True)
    return {"out": out}
''', ["json", "codec"], [("a", ['{"a":{"__pair__":[1,2]},"b":{"__sum__":[3,4,5]}}'], False), ("b", ['{"x":[{"__sum__":[10,-3]},{"__pair__":[7,8]}]}'], False)]),

        # 21. decimal localcontext & banker's rounding
        ("decimal_rounding_context", '''
from decimal import Decimal, localcontext, ROUND_HALF_EVEN, ROUND_HALF_UP

def run(vals):
    even_res, up_res = [], []
    with localcontext() as ctx:
        ctx.rounding = ROUND_HALF_EVEN
        for s in vals:
            even_res.append(str(Decimal(s).quantize(Decimal("0.01"))))
    with localcontext() as ctx:
        ctx.rounding = ROUND_HALF_UP
        for s in vals:
            up_res.append(str(Decimal(s).quantize(Decimal("0.01"))))
    return {"half_even": even_res, "half_up": up_res}
''', ["decimal", "numeric"], [("a", [["1.005", "1.015", "2.025", "2.035"]], False), ("b", [["0.125", "0.135", "-0.125"]], False)]),

        # 22. fractions exact rational arithmetic & continued fraction
        ("fractions_continued_cf", '''
from fractions import Fraction

def run(num, den, max_den):
    f = Fraction(num, den)
    cf = []
    rem = f
    while True:
        q = rem.numerator // rem.denominator
        cf.append(q)
        rem = rem - q
        if rem == 0:
            break
        rem = Fraction(1, 1) / rem
    approx = f.limit_denominator(max_den)
    return {"exact": str(f), "cf": cf, "approx": str(approx)}
''', ["fractions", "numeric"], [("a", [355, 113, 20], False), ("b", [415, 93, 10], False)]),

        # 23. dataclasses frozen, order, __post_init__, replace (via make_dataclass)
        ("dataclasses_post_init_frozen", '''
from dataclasses import make_dataclass, field, replace, asdict

def _post_init(self):
    object.__setattr__(self, "slug", self.name.strip().lower().replace(" ", "-"))

TaskItem = make_dataclass(
    "TaskItem",
    [
        ("priority", int),
        ("name", str, field(compare=False)),
        ("slug", str, field(init=False, compare=False)),
    ],
    namespace={"__post_init__": _post_init},
    frozen=True,
    order=True,
)

def run(rows):
    items = sorted(TaskItem(priority=r[0], name=r[1]) for r in rows)
    bumped = replace(items[0], priority=items[0].priority + 5)
    return {"ordered": [asdict(i) for i in items], "bumped": asdict(bumped)}
''', ["dataclasses", "class"], [("a", [[[3, "Build App"], [1, "Init DB"], [2, "Run Tests"]]], False), ("b", [[[5, "Deploy"], [2, "Lint Code"]]], False)]),

        # 24. enum IntFlag bitwise permissions & alias deduplication
        ("enum_intflag_permissions", '''
from enum import IntFlag, auto

class Perm(IntFlag):
    READ = auto()
    WRITE = auto()
    EXEC = auto()
    RW = READ | WRITE

def run(mask_a, mask_b):
    a, b = Perm(mask_a), Perm(mask_b)
    comb = a | b
    dropped = comb & ~Perm.WRITE
    return {
        "comb": int(comb),
        "has_rw": Perm.RW in comb,
        "dropped": int(dropped),
        "names": [p.name for p in Perm if p in comb and p != Perm.RW],
    }
''', ["enum", "bitwise"], [("a", [1, 2], False), ("b", [3, 4], False)]),

        # 25. operator itemgetter/attrgetter multi-key stable sort
        ("operator_attr_item_getters", '''
from operator import itemgetter

def run(rows):
    by_name = sorted(rows, key=itemgetter("name"))
    by_dept_score = sorted(by_name, key=itemgetter("dept", "score"))
    top = list(map(itemgetter("name", "score"), by_dept_score))
    return {"sorted": [list(t) for t in top]}
''', ["operator", "sorting"], [("a", [[{"name": "b", "dept": 1, "score": 5}, {"name": "a", "dept": 1, "score": 5}, {"name": "c", "dept": 0, "score": 9}]], False), ("b", [[{"name": "z", "dept": 2, "score": 1}, {"name": "m", "dept": 2, "score": 1}, {"name": "a", "dept": 1, "score": 3}]], False)]),

        # 26. struct TLV binary encoder/decoder + zlib crc32
        ("struct_binary_tlv", '''
import struct, zlib

def run(records):
    buf = bytearray()
    for tag, val in records:
        raw = val.encode("utf-8")
        buf.extend(struct.pack(">BH", tag, len(raw)))
        buf.extend(raw)
    crc = zlib.crc32(buf) & 0xFFFFFFFF
    pos = 0
    decoded = []
    while pos < len(buf):
        tag, length = struct.unpack_from(">BH", buf, pos)
        pos += 3
        decoded.append([tag, buf[pos : pos + length].decode("utf-8")])
        pos += length
    return {"bytes": len(buf), "crc": hex(crc), "decoded": decoded}
''', ["struct", "bytes", "binary"], [("a", [[[1, "alpha"], [2, "beta"]]], False), ("b", [[[7, "ok"], [9, "hello-world"]]], False)]),

        # 27. hashlib/hmac Merkle root & verification
        ("hashlib_hmac_merkle", '''
import hashlib, hmac

def _h(data):
    return hashlib.sha256(data.encode("utf-8")).hexdigest()[:16]

def run(leaves, secret):
    layer = [_h(x) for x in leaves]
    while len(layer) > 1:
        if len(layer) % 2 == 1:
            layer.append(layer[-1])
        layer = [_h(layer[i] + ":" + layer[i + 1]) for i in range(0, len(layer), 2)]
    root = layer[0] if layer else ""
    mac = hmac.new(secret.encode(), root.encode(), hashlib.sha256).hexdigest()[:16]
    return {"root": root, "mac": mac, "verified": hmac.compare_digest(mac, mac)}
''', ["hashlib", "hmac", "algorithm"], [("a", [["tx1", "tx2", "tx3"], "k9"], False), ("b", [["a", "b", "c", "d"], "sec"], False)]),

        # 28. ipaddress CIDR subnetting & longest-prefix routing
        ("ipaddress_cidr_planner", '''
import ipaddress

def run(cidrs, ips):
    nets = list(ipaddress.collapse_addresses([ipaddress.ip_network(c) for c in cidrs]))
    routes = []
    for ip_s in ips:
        addr = ipaddress.ip_address(ip_s)
        matches = [n for n in nets if addr in n]
        best = max(matches, key=lambda n: n.prefixlen) if matches else None
        routes.append(str(best) if best else None)
    return {"collapsed": [str(n) for n in nets], "routes": routes}
''', ["ipaddress", "networking"], [("a", [["10.0.0.0/25", "10.0.0.128/25", "10.0.1.0/24"], ["10.0.0.5", "10.0.2.1"]], False), ("b", [["192.168.1.0/24", "192.168.1.128/25"], ["192.168.1.200", "192.168.1.10"]], False)]),

        # 29. urllib.parse canonical URL + sorted multi-query
        ("urllib_query_canonical", '''
from urllib.parse import urljoin, urlsplit, urlunsplit, parse_qsl, urlencode

def run(base, rel):
    joined = urljoin(base, rel)
    sp = urlsplit(joined)
    params = sorted(parse_qsl(sp.query, keep_blank_values=True))
    canon = urlunsplit((sp.scheme.lower(), sp.netloc.lower(), sp.path or "/", urlencode(params), ""))
    return {"canon": canon, "params": [list(p) for p in params]}
''', ["urllib", "url"], [("a", ["https://API.Example.com/v1/users/list", "../items?b=2&a=1&b=0#frag"], False), ("b", ["http://Host.Local:8080/a/b/", "c?z=&a=hi+there"], False)]),

        # 30. csv DictReader/DictWriter with embedded commas & quotes
        ("csv_dialect_quoting", '''
import csv, io

def run(raw_csv):
    rows = list(csv.DictReader(io.StringIO(raw_csv)))
    totals = {}
    for r in rows:
        dept = r["dept"].strip()
        totals[dept] = totals.get(dept, 0) + int(r["qty"])
    out = io.StringIO()
    w = csv.writer(out, lineterminator="\\n")
    for k in sorted(totals):
        w.writerow([k, totals[k]])
    return {"count": len(rows), "totals": totals, "csv": out.getvalue().strip()}
''', ["csv", "io"], [("a", ['dept,note,qty\neng,"a, b",3\nops,"say ""hi""",5\neng,ok,4\n'], False), ("b", ['dept,note,qty\nsales,"x,y",10\nsales,z,2\n'], False)]),

        # 31. difflib SequenceMatcher opcodes & hunk ratio
        ("difflib_unified_patch", '''
import difflib

def run(a, b):
    sm = difflib.SequenceMatcher(None, a, b)
    ops = [[tag, i1, i2, j1, j2] for tag, i1, i2, j1, j2 in sm.get_opcodes()]
    return {"ratio": round(sm.ratio(), 4), "ops": ops}
''', ["difflib", "algorithm"], [("a", [["a", "b", "c", "d"], ["a", "x", "c", "d", "e"]], False), ("b", [["k", "m", "n"], ["m", "p"]], False)]),

        # 32. graphlib TopologicalSorter & CycleError
        ("graphlib_toposorter", '''
from graphlib import TopologicalSorter

def run(graph):
    ts = TopologicalSorter(graph)
    ts.prepare()
    waves = []
    while ts.is_active():
        ready = sorted(ts.get_ready())
        waves.append(ready)
        ts.done(*ready)
    return {"waves": waves}
''', ["graphlib", "graph"], [("dag", [{"d": ["b", "c"], "b": ["a"], "c": ["a"], "a": []}], False), ("cycle", [{"a": ["b"], "b": ["a"]}], True)]),

        # 33. datetime timezone arithmetic & ISO week boundaries
        ("datetime_tz_windows", '''
from datetime import datetime, timedelta, timezone

def run(iso_str, offset_hours, steps):
    tz = timezone(timedelta(hours=offset_hours))
    dt = datetime.fromisoformat(iso_str).astimezone(tz)
    slots = []
    for i in range(steps):
        cur = dt + timedelta(hours=6 * i)
        iso_cal = cur.isocalendar()
        slots.append({"ts": cur.isoformat(), "week": iso_cal.week, "dow": iso_cal.weekday})
    return slots
''', ["datetime", "timezone"], [("a", ["2026-12-31T20:00:00+00:00", 2, 3], False), ("b", ["2026-06-15T10:30:00+00:00", -5, 3], False)]),

        # 34. statistics quantiles & outlier z-scores
        ("statistics_quantiles_zscore", '''
import statistics

def run(vals):
    mu = statistics.mean(vals)
    sd = statistics.pstdev(vals)
    qs = [round(q, 3) for q in statistics.quantiles(vals, n=4)]
    outliers = [v for v in vals if sd > 0 and abs((v - mu) / sd) >= 1.5]
    return {"mean": round(mu, 3), "pstdev": round(sd, 3), "quartiles": qs, "outliers": outliers}
''', ["statistics", "numeric"], [("a", [[10, 12, 11, 13, 12, 40]], False), ("b", [[2, 4, 4, 4, 5, 5, 7, 9]], False)]),

        # 35. ast safe arithmetic/boolean expression evaluator
        ("ast_expr_evaluator", '''
import ast, operator

OPS = {ast.Add: operator.add, ast.Sub: operator.sub, ast.Mult: operator.mul, ast.FloorDiv: operator.floordiv, ast.Mod: operator.mod}

def eval_node(node, env):
    if isinstance(node, ast.Constant):
        return node.value
    if isinstance(node, ast.Name):
        return env[node.id]
    if isinstance(node, ast.UnaryOp) and isinstance(node.op, ast.USub):
        return -eval_node(node.operand, env)
    if isinstance(node, ast.BinOp) and type(node.op) in OPS:
        return OPS[type(node.op)](eval_node(node.left, env), eval_node(node.right, env))
    raise ValueError(f"unsupported:{type(node).__name__}")

def run(expr, env):
    tree = ast.parse(expr, mode="eval")
    return eval_node(tree.body, env)
''', ["ast", "recursion", "evaluator"], [("ok", ["(x * 3 + y) // 2 - (-z)", {"x": 5, "y": 4, "z": 2}], False), ("bad", ["__import__('os')", {}], True)]),

        # 36. Dunder numeric protocols (__add__, __radd__, __iadd__, __bool__, __hash__)
        ("dunder_numeric_protocols", '''
class Vec:
    def __init__(self, x, y):
        self.x, self.y = x, y
    def __add__(self, other):
        if isinstance(other, Vec): return Vec(self.x + other.x, self.y + other.y)
        return NotImplemented
    def __radd__(self, other):
        if other == 0: return Vec(self.x, self.y)
        if isinstance(other, int): return Vec(self.x + other, self.y + other)
        return NotImplemented
    def __iadd__(self, other):
        self.x += other.x; self.y += other.y
        return self
    def __bool__(self):
        return self.x != 0 or self.y != 0

def run(pairs):
    vecs = [Vec(a, b) for a, b in pairs]
    total = sum(vecs)  # exercises __radd__ with 0!
    v0 = vecs[0]
    alias = v0
    v0 += Vec(1, -1)
    return {"sum": [total.x, total.y], "alias": [alias.x, alias.y], "nonzero": bool(total)}
''', ["dunder", "class", "aliasing"], [("a", [[[1, 2], [3, 4], [-4, -6]]], False), ("b", [[[2, 5], [1, -3]]], False)]),

        # 37. Dunder container sequence (__getitem__ tuple/slice, __contains__)
        ("dunder_container_sequence", '''
class SparseGrid:
    def __init__(self):
        self._cells = {}
    def __setitem__(self, key, val):
        if val == 0:
            self._cells.pop(key, None)
        else:
            self._cells[key] = val
    def __getitem__(self, key):
        if isinstance(key, tuple) and len(key) == 2:
            return self._cells.get(key, 0)
        raise KeyError(key)
    def __contains__(self, key):
        return key in self._cells
    def __len__(self):
        return len(self._cells)

def run(ops):
    g = SparseGrid()
    for r, c, v in ops:
        g[r, c] = v
    return {"len": len(g), "has_0_0": (0, 0) in g, "val_1_2": g[1, 2], "val_9_9": g[9, 9]}
''', ["dunder", "container", "class"], [("a", [[[0, 0, 5], [1, 2, 8], [0, 0, 0]]], False), ("b", [[[0, 0, 3], [1, 2, -4]]], False)]),

        # 38. Structural pattern matching (match/case with guards)
        ("match_case_structural", '''
def run(commands):
    state = {"x": 0, "y": 0, "tags": []}
    for cmd in commands:
        match cmd:
            case ["move", dx, dy] if dx != 0 or dy != 0:
                state["x"] += dx
                state["y"] += dy
            case {"op": "tag", "items": [first, *rest]}:
                state["tags"].append(first)
                state["tags"].extend(rest)
            case ["reset"]:
                state["x"] = state["y"] = 0
            case _:
                state["tags"].append("ignored")
    return state
''', ["match-case", "pattern-matching"], [("a", [[["move", 2, -1], {"op": "tag", "items": ["a", "b"]}, ["move", 0, 0]]], False), ("b", [[["move", 5, 5], ["reset"], ["move", 1, 2]]], False)]),

        # 39. asyncio gather & Queue producer-consumer ordering
        ("async_task_gather_order", '''
import asyncio

async def run(items):
    q = asyncio.Queue()
    out = []
    async def producer():
        for i, v in enumerate(items):
            await q.put((i, v * 2))
            await asyncio.sleep(0)
        await q.put(None)
    async def consumer():
        while True:
            item = await q.get()
            if item is None:
                break
            out.append(list(item))
    await asyncio.gather(producer(), consumer())
    return out
''', ["async", "asyncio"], [("a", [[3, 1, 4]], False), ("b", [[10, -2, 7, 0]], False)]),

        # 40. bytearray slicing, bytes.translate, base64 urlsafe
        ("bytes_bytearray_base64", '''
import base64

def run(text, shift):
    table = bytes.maketrans(b"aeiou", b"AEIOU")
    ba = bytearray(text.encode("utf-8").translate(table))
    for i in range(0, len(ba), 2):
        ba[i] = ((ba[i] + shift) % 94) + 33
    b64 = base64.urlsafe_b64encode(bytes(ba)).decode("ascii")
    roundtrip = base64.urlsafe_b64decode(b64).hex()
    return {"b64": b64, "hex": roundtrip}
''', ["bytes", "bytearray", "base64"], [("a", ["hello world", 1], False), ("b", ["python3", 3], False)]),

        # 41. string.Formatter & custom __format__ mini-language
        ("string_format_mini_lang", '''
class Money:
    def __init__(self, cents, ccy):
        self.cents, self.ccy = cents, ccy
    def __format__(self, spec):
        amt = self.cents / 100.0
        if spec == "short":
            return f"{self.ccy}{amt:.0f}"
        return f"{self.ccy} {amt:,.2f}"

def run(cents, ccy):
    m = Money(cents, ccy)
    return {"full": f"{m}", "short": f"{m:short}", "aligned": f"{cents:0>+8d}"}
''', ["formatting", "dunder"], [("a", [123456, "USD"], False), ("b", [-5050, "EUR"], False)]),

        # 42. Trie autocomplete + Levenshtein edit distance ranker
        ("trie_autocomplete_editdist", '''
def edit_dist(a, b):
    dp = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        prev = dp[0]
        dp[0] = i
        for j, cb in enumerate(b, 1):
            cur = dp[j]
            dp[j] = prev if ca == cb else 1 + min(prev, dp[j], dp[j - 1])
            prev = cur
    return dp[-1]

def run(words, prefix, target):
    trie = {}
    for w in words:
        node = trie
        for ch in w:
            node = node.setdefault(ch, {})
        node["$"] = w
    cur = trie
    for ch in prefix:
        cur = cur.get(ch)
        if cur is None:
            return {"matches": [], "ranked": []}
    matches = []
    def dfs(n):
        if "$" in n:
            matches.append(n["$"])
        for k in sorted(k for k in n if k != "$"):
            dfs(n[k])
    dfs(cur)
    ranked = sorted(matches, key=lambda w: (edit_dist(w, target), w))
    return {"matches": matches, "ranked": ranked}
''', ["trie", "dp", "algorithm"], [("a", [["parse", "parser", "part", "path", "patch"], "pa", "parset"], False), ("b", [["cache", "call", "calm", "camp"], "ca", "calp"], False)]),

        # 43. Union-Find + Kruskal MST
        ("union_find_kruskal_mst", '''
def run(n, edges):
    parent = list(range(n))
    rank = [0] * n
    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x
    def union(a, b):
        ra, rb = find(a), find(b)
        if ra == rb:
            return False
        if rank[ra] < rank[rb]:
            ra, rb = rb, ra
        parent[rb] = ra
        if rank[ra] == rank[rb]:
            rank[ra] += 1
        return True
    chosen = []
    total = 0
    for w, u, v in sorted(edges):
        if union(u, v):
            chosen.append([u, v, w])
            total += w
    return {"weight": total, "edges": chosen, "components": len({find(i) for i in range(n)})}
''', ["graph", "union-find", "algorithm"], [("a", [4, [[1, 0, 1], [4, 0, 2], [2, 1, 2], [3, 2, 3], [5, 1, 3]]], False), ("b", [5, [[2, 0, 1], [1, 2, 3], [3, 3, 4], [4, 2, 4]]], False)]),

        # 44. Tarjan SCC
        ("tarjan_scc_dag", '''
def run(n, edges):
    adj = [[] for _ in range(n)]
    for u, v in edges:
        adj[u].append(v)
    index = [0]
    indices = [-1] * n
    low = [0] * n
    stack = []
    on_stack = [False] * n
    sccs = []
    def strong(v):
        indices[v] = low[v] = index[0]
        index[0] += 1
        stack.append(v)
        on_stack[v] = True
        for w in adj[v]:
            if indices[w] == -1:
                strong(w)
                low[v] = min(low[v], low[w])
            elif on_stack[w]:
                low[v] = min(low[v], indices[w])
        if low[v] == indices[v]:
            comp = []
            while True:
                w = stack.pop()
                on_stack[w] = False
                comp.append(w)
                if w == v:
                    break
            sccs.append(sorted(comp))
    for v in range(n):
        if indices[v] == -1:
            strong(v)
    return sorted(sccs)
''', ["graph", "tarjan", "recursion"], [("a", [5, [[0, 1], [1, 2], [2, 0], [1, 3], [3, 4], [4, 3]]], False), ("b", [4, [[0, 1], [1, 2], [2, 3]]], False)]),

        # 45. Shunting-yard RPN parser & evaluator (right-assoc ^)
        ("shunting_yard_rpn", '''
def run(tokens):
    prec = {"+": 1, "-": 1, "*": 2, "/": 2, "^": 3}
    right = {"^"}
    out, ops = [], []
    for tok in tokens:
        if tok.lstrip("-").isdigit():
            out.append(int(tok))
        elif tok == "(":
            ops.append(tok)
        elif tok == ")":
            while ops[-1] != "(":
                out.append(ops.pop())
            ops.pop()
        else:
            while ops and ops[-1] != "(" and (prec[ops[-1]] > prec[tok] or (prec[ops[-1]] == prec[tok] and tok not in right)):
                out.append(ops.pop())
            ops.append(tok)
    while ops:
        out.append(ops.pop())
    st = []
    for item in out:
        if isinstance(item, int):
            st.append(item)
        else:
            b, a = st.pop(), st.pop()
            st.append(a + b if item == "+" else a - b if item == "-" else a * b if item == "*" else a // b if item == "/" else a ** b)
    return {"rpn": out, "value": st[0]}
''', ["parser", "stack", "algorithm"], [("a", [["2", "^", "3", "^", "2", "+", "(", "10", "-", "4", ")", "*", "3"]], False), ("b", [["(", "8", "+", "2", ")", "*", "3", "^", "2", "-", "5"]], False)]),

        # 46. Mini NFA regex matcher (., *, +)
        ("regex_nfa_matcher", '''
def run(pattern, text):
    memo = {}
    def dp(i, j):
        if (i, j) in memo:
            return memo[i, j]
        if j == len(pattern):
            res = (i == len(text))
        else:
            first = i < len(text) and pattern[j] in (text[i], ".")
            if j + 1 < len(pattern) and pattern[j + 1] == "*":
                res = dp(i, j + 2) or (first and dp(i + 1, j))
            elif j + 1 < len(pattern) and pattern[j + 1] == "+":
                res = first and (dp(i + 1, j + 2) or dp(i + 1, j))
            else:
                res = first and dp(i + 1, j + 1)
        memo[i, j] = res
        return res
    return {"matched": dp(0, 0), "states": len(memo)}
''', ["dp", "recursion", "regex"], [("a", ["a+b*c.d", "aaabbcxd"], False), ("b", ["a+b*c", "bbc"], False)]),

        # 47. O(1) LFU cache
        ("lfu_cache_o1", '''
from collections import defaultdict, OrderedDict

def run(cap, ops):
    vals = {}
    freqs = {}
    buckets = defaultdict(OrderedDict)
    min_f = [0]
    evicted = []
    reads = []
    def touch(k):
        f = freqs[k]
        del buckets[f][k]
        if not buckets[f] and min_f[0] == f:
            min_f[0] += 1
        freqs[k] = f + 1
        buckets[f + 1][k] = None
    for op in ops:
        if op[0] == "get":
            k = op[1]
            if k not in vals:
                reads.append(None)
            else:
                touch(k)
                reads.append(vals[k])
        else:
            _, k, v = op
            if k in vals:
                vals[k] = v
                touch(k)
            else:
                if len(vals) == cap:
                    ek, _ = buckets[min_f[0]].popitem(last=False)
                    del vals[ek]; del freqs[ek]
                    evicted.append(ek)
                vals[k] = v; freqs[k] = 1; buckets[1][k] = None; min_f[0] = 1
    return {"reads": reads, "evicted": evicted, "remaining": sorted(vals.items())}
''', ["data-structure", "lfu", "OrderedDict"], [("a", [2, [["put", "a", 1], ["put", "b", 2], ["get", "a"], ["put", "c", 3], ["get", "b"], ["get", "c"]]], False), ("b", [2, [["put", "x", 10], ["put", "y", 20], ["get", "x"], ["get", "y"], ["put", "z", 30]]], False)]),

        # 48. Order-3 B-tree insertion & range scan
        ("btree_split_search", '''
def run(keys, lo, hi):
    def insert(node, k):
        if node["leaf"]:
            node["keys"].append(k)
            node["keys"].sort()
            if len(node["keys"]) <= 2:
                return None
            mid = node["keys"][1]
            left = {"leaf": True, "keys": [node["keys"][0]], "ch": []}
            right = {"leaf": True, "keys": [node["keys"][2]], "ch": []}
            return (mid, left, right)
        idx = 0
        while idx < len(node["keys"]) and k > node["keys"][idx]:
            idx += 1
        split = insert(node["ch"][idx], k)
        if split is None:
            return None
        mid, l, r = split
        node["keys"].insert(idx, mid)
        node["ch"][idx : idx + 1] = [l, r]
        if len(node["keys"]) <= 2:
            return None
        up = node["keys"][1]
        nl = {"leaf": False, "keys": [node["keys"][0]], "ch": node["ch"][:2]}
        nr = {"leaf": False, "keys": [node["keys"][2]], "ch": node["ch"][2:]}
        return (up, nl, nr)

    root = {"leaf": True, "keys": [], "ch": []}
    for k in keys:
        sp = insert(root, k)
        if sp:
            root = {"leaf": False, "keys": [sp[0]], "ch": [sp[1], sp[2]]}

    found = []
    def scan(n):
        for i, k in enumerate(n["keys"]):
            if not n["leaf"]:
                scan(n["ch"][i])
            if lo <= k <= hi:
                found.append(k)
        if not n["leaf"]:
            scan(n["ch"][-1])
    scan(root)
    return {"root_keys": root["keys"], "range": found}
''', ["btree", "recursion", "data-structure"], [("a", [[10, 20, 5, 6, 12, 30, 7, 17], 6, 18], False), ("b", [[3, 1, 4, 15, 9, 2, 6], 2, 10], False)]),

        # 49. Sweep-line interval max concurrency & gaps
        ("interval_sweep_skyline", '''
def run(intervals):
    events = []
    for s, e in intervals:
        events.append((s, 1))
        events.append((e, -1))
    events.sort()
    cur = peak = 0
    gaps = []
    prev_end = None
    for t, d in events:
        if cur == 0 and prev_end is not None and t > prev_end:
            gaps.append([prev_end, t])
        cur += d
        if cur > peak:
            peak = cur
        if cur == 0:
            prev_end = t
    return {"peak": peak, "gaps": gaps}
''', ["sweep-line", "algorithm"], [("a", [[[1, 4], [2, 5], [7, 9], [8, 12], [15, 16]]], False), ("b", [[[0, 3], [3, 6], [8, 10]]], False)]),

        # 50. 0/1 Knapsack DP with exact item reconstruction
        ("knapsack_dp_reconstruct", '''
def run(items, cap):
    n = len(items)
    dp = [[0] * (cap + 1) for _ in range(n + 1)]
    for i in range(1, n + 1):
        name, w, v = items[i - 1]
        for c in range(cap + 1):
            dp[i][c] = dp[i - 1][c]
            if w <= c and dp[i - 1][c - w] + v > dp[i][c]:
                dp[i][c] = dp[i - 1][c - w] + v
    chosen = []
    c = cap
    for i in range(n, 0, -1):
        if dp[i][c] != dp[i - 1][c]:
            chosen.append(items[i - 1][0])
            c -= items[i - 1][1]
    chosen.reverse()
    return {"best_val": dp[n][cap], "chosen": chosen}
''', ["dp", "algorithm"], [("a", [[["a", 2, 3], ["b", 3, 4], ["c", 4, 5], ["d", 5, 8]], 7], False), ("b", [[["x", 1, 2], ["y", 3, 7], ["z", 2, 4]], 4], False)]),
    ]

    tasks: list[dict[str, Any]] = []
    for name, src, feats, variants in specs:
        fam = f"stage10-py-hairy:{name}"
        for v_tag, v_args, is_throw in variants:
            tid = f"stage10-py-hairy-{name.replace('_', '-')}-{v_tag}"
            tasks.append(_single_task(tid, fam, src, v_args, feats, allow_throw=is_throw))

    # 51-56: 6 Effectful single-file causal-pair families (12 tasks)
    eff_specs: list[tuple[str, str, list[Any], list[str], dict[str, list[dict[str, Any]]], dict[str, list[dict[str, Any]]], bool]] = [
        # 51. Circuit breaker
        (
            "effect_circuit_breaker",
            '''
import time

def run(svc, url):
    now = time.time()
    state = host.kv_get(f"cb:{svc}")
    if state and state.get("open_until", 0) > now:
        print("circuit-open", svc)
        return {"source": "circuit-open", "ok": False}
    try:
        resp = host.http_get(url)
        host.kv_set(f"cb:{svc}", {"failures": 0, "open_until": 0})
        return {"source": "live", "ok": True, "data": resp}
    except Exception as exc:
        fails = (state.get("failures", 0) if state else 0) + 1
        host.kv_set(f"cb:{svc}", {"failures": fails, "open_until": now + 60})
        print("circuit-tripped", svc, fails)
        return {"source": "tripped", "ok": False, "error": str(exc)}
''',
            ["payments", "https://pay.internal/charge"],
            ["kv", "http", "time", "print"],
            {"kv_get": [{"status": "fulfilled", "result": {"failures": 0, "open_until": 0}}], "http.get": [{"status": "fulfilled", "result": {"id": "tx-1"}}], "kv_set": [{"status": "fulfilled", "result": True}]},
            {"kv_get": [{"status": "fulfilled", "result": {"failures": 1, "open_until": 0}}], "http.get": [{"status": "rejected", "result": {"name": "TimeoutError", "message": "upstream timeout"}}], "kv_set": [{"status": "fulfilled", "result": True}]},
            False,
        ),
        # 52. Write-through cache with stale fallback
        (
            "effect_write_through_cache",
            '''
def run(key, url):
    cached = host.kv_get(key)
    if cached and cached.get("fresh"):
        return {"source": "cache-hit", "value": cached["val"]}
    try:
        live = host.http_get(url)
        host.kv_set(key, {"fresh": True, "val": live["val"]})
        return {"source": "origin", "value": live["val"]}
    except Exception:
        if cached:
            print("serving-stale", key)
            return {"source": "stale-fallback", "value": cached["val"]}
        raise
''',
            ["profile:42", "https://users.internal/42"],
            ["kv", "http", "print"],
            {"kv_get": [{"status": "fulfilled", "result": {"fresh": False, "val": "old-ada"}}], "http.get": [{"status": "fulfilled", "result": {"val": "new-ada"}}], "kv_set": [{"status": "fulfilled", "result": True}]},
            {"kv_get": [{"status": "fulfilled", "result": {"fresh": False, "val": "old-ada"}}], "http.get": [{"status": "rejected", "result": {"name": "ConnectionError", "message": "502 bad gateway"}}]},
            False,
        ),
        # 53. Layered fs config overlay & writeback
        (
            "effect_config_merge_fs",
            '''
import json

def run(base_path, env_path, out_path):
    base = json.loads(host.fs_read_text(base_path))
    try:
        ov = json.loads(host.fs_read_text(env_path))
        merged = {**base, **ov, "overlay": True}
    except Exception:
        merged = {**base, "overlay": False}
    host.fs_write_text(out_path, json.dumps(merged, sort_keys=True))
    return merged
''',
            ["/etc/app/base.json", "/etc/app/prod.json", "/var/run/effective.json"],
            ["fs", "json"],
            {"fs.readText": [{"status": "fulfilled", "result": '{"port":8080,"debug":true}'}, {"status": "fulfilled", "result": '{"debug":false,"workers":4}'}]},
            {"fs.readText": [{"status": "fulfilled", "result": '{"port":8080,"debug":true}'}, {"status": "rejected", "result": {"name": "FileNotFoundError", "message": "no prod.json"}}]},
            False,
        ),
        # 54. Idempotent webhook processor
        (
            "effect_idempotent_worker",
            '''
def run(idem_key, payload):
    prior = host.kv_get(idem_key)
    if prior is not None:
        print("duplicate-skip", idem_key)
        return {"duplicate": True, "receipt": prior}
    resp = host.http_request({"method": "POST", "url": "https://ledger.internal/post", "body": payload})
    host.kv_set(idem_key, resp["receipt"])
    return {"duplicate": False, "receipt": resp["receipt"]}
''',
            ["idem-991", '{"amt":500}'],
            ["kv", "http", "print"],
            {"kv_get": [{"status": "fulfilled", "result": None}], "http.request": [{"status": "fulfilled", "result": {"receipt": "rcpt-77"}}], "kv_set": [{"status": "fulfilled", "result": True}]},
            {"kv_get": [{"status": "fulfilled", "result": "rcpt-77"}]},
            False,
        ),
        # 55. Retry backoff with error classification
        (
            "effect_retry_backoff",
            '''
def run(url, max_attempts):
    errors = []
    for attempt in range(1, max_attempts + 1):
        try:
            data = host.http_get(url)
            return {"ok": True, "attempts": attempt, "data": data, "errors": errors}
        except Exception as exc:
            errors.append(str(exc))
            print("attempt-failed", attempt)
    raise RuntimeError(f"exhausted:{len(errors)}")
''',
            ["https://api.internal/sync", 3],
            ["http", "print", "exception"],
            {"http.get": [{"status": "rejected", "result": {"name": "TimeoutError", "message": "t1"}}, {"status": "fulfilled", "result": {"synced": 12}}]},
            {"http.get": [{"status": "rejected", "result": {"name": "TimeoutError", "message": "t1"}}, {"status": "rejected", "result": {"name": "TimeoutError", "message": "t2"}}, {"status": "rejected", "result": {"name": "TimeoutError", "message": "t3"}}]},
            True,
        ),
        # 56. Two-step saga with compensating rollback
        (
            "effect_saga_compensate",
            '''
def run(order_id, amount):
    res_id = host.http_request({"method": "POST", "url": "https://inv.internal/reserve", "body": order_id})["id"]
    try:
        pay = host.http_request({"method": "POST", "url": "https://pay.internal/debit", "body": str(amount)})
        return {"status": "committed", "reservation": res_id, "tx": pay["tx"]}
    except Exception as exc:
        host.http_request({"method": "POST", "url": "https://inv.internal/release", "body": res_id})
        print("saga-compensated", res_id)
        return {"status": "rolled_back", "reservation": res_id, "reason": str(exc)}
''',
            ["ORD-7", 250],
            ["http", "print"],
            {"http.request": [{"status": "fulfilled", "result": {"id": "res-1"}}, {"status": "fulfilled", "result": {"tx": "tx-9"}}]},
            {"http.request": [{"status": "fulfilled", "result": {"id": "res-1"}}, {"status": "rejected", "result": {"name": "ValueError", "message": "card declined"}}, {"status": "fulfilled", "result": {"released": True}}]},
            False,
        ),
    ]
    for name, src, args, feats, s_a, s_b, b_throws in eff_specs:
        fam = f"stage10-py-hairy:{name}"
        tasks.append(_single_task(f"stage10-py-hairy-{name.replace('_', '-')}-a", fam, src, args, feats, scripted=s_a, times=[1795800100.0]))
        tasks.append(_single_task(f"stage10-py-hairy-{name.replace('_', '-')}-b", fam, src, args, feats, scripted=s_b, times=[1795800100.0], allow_throw=b_throws))

    return tasks


# ===========================================================================
# BUCKET C — PART C2: 30 Clean Pure-Python OSS Function Probes (60 tasks)
# ===========================================================================

def _extract_symbols(path: Path, names: list[str]) -> str:
    text = path.read_text(encoding="utf-8", errors="replace")
    tree = ast.parse(text)
    lines = text.splitlines()
    by_name: dict[str, tuple[int, ast.stmt]] = {}
    for idx, stmt in enumerate(tree.body):
        if isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            by_name[stmt.name] = (idx, stmt)
        elif isinstance(stmt, ast.Assign):
            for t in stmt.targets:
                if isinstance(t, ast.Name):
                    by_name[t.id] = (idx, stmt)
        elif isinstance(stmt, ast.AnnAssign) and isinstance(stmt.target, ast.Name):
            by_name[stmt.target.id] = (idx, stmt)
    seen: set[int] = set()
    blocks: list[str] = []
    for nm in names:
        if nm not in by_name:
            raise KeyError(f"Symbol {nm!r} not found in {path}")
        idx, stmt = by_name[nm]
        if idx in seen:
            continue
        seen.add(idx)
        start = stmt.lineno - 1
        if isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and stmt.decorator_list:
            start = min(d.lineno for d in stmt.decorator_list) - 1
        end = getattr(stmt, "end_lineno", stmt.lineno) or stmt.lineno
        blocks.append("\n".join(lines[start:end]))
    return "\n\n".join(blocks)


def build_bucket_c2_oss_probes(site_packages: Path) -> list[dict[str, Any]]:
    """30 brand-new single-file OSS function probes x 2 variants = 60 tasks (disjoint from RealExecBench)."""
    probes: list[tuple[str, str, str, list[tuple[str, list[Any], bool]]]] = [
        # 1. packaging.utils canonicalize_name / is_normalized_name
        ("packaging_canonicalize",
         "from __future__ import annotations\nimport re\nfrom typing import NewType, cast\nNormalizedName = NewType('NormalizedName', str)\n" +
         _extract_symbols(site_packages / "packaging/utils.py", ["InvalidName", "_validate_regex", "_normalized_regex", "canonicalize_name", "is_normalized_name"]) +
         "\ndef run(names):\n    return [{'canon': canonicalize_name(n), 'already': is_normalized_name(n)} for n in names]\n",
         "packaging/utils.py",
         [("a", [["My_Cool--Pkg.Name", "fast-api"]], False), ("b", [["A.B_C-D", "simple"]], False)]),

        # 2. packaging.tags Tag (100% deterministic construction & comparison)
        ("packaging_tag_obj",
         "from __future__ import annotations\nfrom typing import FrozenSet\n" +
         _extract_symbols(site_packages / "packaging/tags.py", ["Tag"]) +
         "\ndef run(specs):\n    tags = [Tag(i, a, p) for i, a, p in specs]\n    return {'strs': [str(t) for t in tags], 'eq01': tags[0] == tags[1], 'interp': [t.interpreter for t in tags]}\n",
         "packaging/tags.py",
         [("a", [[["PY3", "NONE", "ANY"], ["py3", "none", "any"]]], False), ("b", [[["cp312", "abi3", "linux_x86_64"], ["cp311", "abi3", "linux_x86_64"]]], False)]),

        # 3. mdurl._encode encode
        ("mdurl_encode",
         "from __future__ import annotations\nfrom string import ascii_letters, digits\nfrom typing import Dict, List\nfrom urllib.parse import quote\n" +
         _extract_symbols(site_packages / "mdurl/_encode.py", ["ASCII_LETTERS_AND_DIGITS", "ENCODE_DEFAULT_CHARS", "ENCODE_COMPONENT_CHARS", "encode_cache", "get_encode_cache", "encode"]) +
         "\ndef run(s, keep_escapes):\n    return encode(s, keep_escapes=keep_escapes)\n",
         "mdurl/_encode.py",
         [("a", ["https://ex.io/a b%20c?x=1", True], False), ("b", ["hello world%25!", False], False)]),

        # 4. mdurl._decode decode
        ("mdurl_decode",
         "from __future__ import annotations\nimport functools\nimport re\nfrom typing import Dict, Sequence\n" +
         _extract_symbols(site_packages / "mdurl/_decode.py", ["DECODE_DEFAULT_CHARS", "DECODE_COMPONENT_CHARS", "decode_cache", "get_decode_cache", "repl_func_with_cache", "decode"]) +
         "\ndef run(s):\n    return decode(s)\n",
         "mdurl/_decode.py",
         [("a", ["https://ex.io/hello%20world%21%2Fpath"], False), ("b", ["caf%C3%A9%3Fa%3D1"], False)]),

        # 5. rich.filesize decimal / pick_unit_and_suffix
        ("rich_filesize",
         "from __future__ import annotations\nfrom typing import Iterable, List, Optional, Tuple\n" +
         _extract_symbols(site_packages / "rich/filesize.py", ["_to_str", "pick_unit_and_suffix", "decimal"]) +
         "\ndef run(sizes):\n    return [decimal(s) for s in sizes]\n",
         "rich/filesize.py",
         [("a", [[512, 1500, 2_450_000, 9_100_000_000]], False), ("b", [[0, 999, 1000, 5_500_000]], False)]),

        # 6. rich.color_triplet ColorTriplet
        ("rich_color_triplet",
         "from __future__ import annotations\nfrom typing import NamedTuple, Tuple\n" +
         _extract_symbols(site_packages / "rich/color_triplet.py", ["ColorTriplet"]) +
         "\ndef run(r, g, b):\n    c = ColorTriplet(r, g, b)\n    return {'hex': c.hex, 'rgb': c.rgb, 'norm': [round(x, 3) for x in c.normalized]}\n",
         "rich/color_triplet.py",
         [("a", [255, 128, 0], False), ("b", [16, 64, 192], False)]),

        # 7. rich.measure Measurement
        ("rich_measurement",
         "from __future__ import annotations\nfrom typing import NamedTuple, Optional\n" +
         _extract_symbols(site_packages / "rich/measure.py", ["Measurement"]) +
         "\ndef run(mn, mx, cap):\n    m = Measurement(mn, mx).normalize().clamp(min_width=4, max_width=cap)\n    return {'min': m.minimum, 'max': m.maximum, 'span': m.span}\n",
         "rich/measure.py",
         [("a", [12, 8, 10], False), ("b", [2, 30, 15], False)]),

        # 8. rich._ratio ratio_distribute
        ("rich_ratio_distribute",
         "from __future__ import annotations\nfrom fractions import Fraction\nfrom math import ceil\nfrom typing import List, Optional, Sequence\n" +
         _extract_symbols(site_packages / "rich/_ratio.py", ["ratio_distribute"]) +
         "\ndef run(total, ratios, mins):\n    return ratio_distribute(total, ratios, minimums=mins)\n",
         "rich/_ratio.py",
         [("a", [100, [1, 2, 3], [10, 10, 10]], False), ("b", [50, [2, 1, 1], [5, 15, 5]], False)]),

        # 9. rich._pick pick_bool
        ("rich_pick_bool",
         "from __future__ import annotations\nfrom typing import Optional\n" +
         _extract_symbols(site_packages / "rich/_pick.py", ["pick_bool"]) +
         "\ndef run(vals):\n    return pick_bool(*vals)\n",
         "rich/_pick.py",
         [("a", [[None, None, True, False]], False), ("b", [[None, False, True]], False)]),

        # 10. dateutil.easter easter
        ("dateutil_easter",
         "from __future__ import annotations\nimport datetime\n" +
         _extract_symbols(site_packages / "dateutil/easter.py", ["EASTER_JULIAN", "EASTER_ORTHODOX", "EASTER_WESTERN", "easter"]) +
         "\ndef run(years, method):\n    return [easter(y, method).isoformat() for y in years]\n",
         "dateutil/easter.py",
         [("a", [[2024, 2025, 2026], 3], False), ("b", [[2025, 2027], 2], False)]),

        # 11. hyperframe.flags Flags
        ("hyperframe_flags",
         "from __future__ import annotations\nfrom collections.abc import MutableSet\nfrom typing import NamedTuple\n" +
         _extract_symbols(site_packages / "hyperframe/flags.py", ["Flag", "Flags"]) +
         "\ndef run(to_add, to_discard):\n    f = Flags([Flag('END_STREAM', 0x1), Flag('ACK', 0x1), Flag('PADDED', 0x8)])\n    for x in to_add: f.add(x)\n    for x in to_discard: f.discard(x)\n    return sorted(f)\n",
         "hyperframe/flags.py",
         [("a", [["END_STREAM", "PADDED"], ["PADDED"]], False), ("b", [["ACK", "PADDED"], []], False)]),

        # 12. hpack.huffman HuffmanEncoder
        ("hpack_huffman_encode",
         "from __future__ import annotations\n" +
         _extract_symbols(site_packages / "hpack/huffman_constants.py", ["REQUEST_CODES", "REQUEST_CODES_LENGTH"]) + "\n" +
         _extract_symbols(site_packages / "hpack/huffman.py", ["HuffmanEncoder"]) +
         "\ndef run(s):\n    enc = HuffmanEncoder(REQUEST_CODES, REQUEST_CODES_LENGTH)\n    out = enc.encode(s.encode('ascii'))\n    return {'in_len': len(s), 'out_len': len(out), 'hex': out.hex()}\n",
         "hpack/huffman.py",
         [("a", ["www.example.com"], False), ("b", ["application/json"], False)]),

        # 13. hpack.table HeaderTable
        ("hpack_header_table",
         "from __future__ import annotations\nfrom collections import deque\nclass _NullLog:\n    def debug(self, *a, **k): pass\nlog = _NullLog()\nclass InvalidTableIndex(Exception): pass\n" +
         _extract_symbols(site_packages / "hpack/table.py", ["table_entry_size", "_build_static_table_mapping", "HeaderTable"]) +
         "\ndef run(entries, max_sz):\n    tbl = HeaderTable()\n    tbl.maxsize = max_sz\n    for k, v in entries:\n        tbl.add(k.encode(), v.encode())\n    return {'size': tbl._current_size, 'len': len(tbl.dynamic_entries), 'search': list(tbl.search(b':method', b'GET'))}\n",
         "hpack/table.py",
         [("a", [[["x-a", "1"], ["x-b", "2222"]], 128], False), ("b", [[["x-long", "abcdefghij"], ["x-short", "ok"]], 80], False)]),

        # 14. requests.structures CaseInsensitiveDict
        ("requests_ci_dict",
         "from __future__ import annotations\nfrom collections import OrderedDict\nfrom collections.abc import Mapping, MutableMapping\nfrom typing import Generic, TypeVar, overload\n_VT = TypeVar('_VT')\n_D = TypeVar('_D')\n" +
         _extract_symbols(site_packages / "requests/structures.py", ["CaseInsensitiveDict", "LookupDict"]) +
         "\ndef run(pairs, queries):\n    d = CaseInsensitiveDict(pairs)\n    return {'vals': [d.get(q) for q in queries], 'lower': dict(d.lower_items())}\n",
         "requests/structures.py",
         [("a", [[["Content-Type", "text/html"], ["X-Token", "abc"]], ["content-type", "X-TOKEN", "missing"]], False), ("b", [[["Accept", "*/*"], ["accept", "json"]], ["ACCEPT"]], False)]),

        # 15. pygments.token _TokenType
        ("pygments_token_hierarchy",
         "from __future__ import annotations\n" +
         _extract_symbols(site_packages / "pygments/token.py", ["_TokenType", "Token", "is_token_subtype", "string_to_tokentype"]) +
         "\ndef run(names):\n    toks = [string_to_tokentype(n) for n in names]\n    return {'strs': [str(t) for t in toks], 'sub': is_token_subtype(toks[0], toks[1])}\n",
         "pygments/token.py",
         [("a", [["Keyword.Constant", "Keyword"]], False), ("b", [["Name.Function", "Literal.String"]], False)]),

        # 16. pygments.util get_bool_opt / get_int_opt / get_list_opt / split_path_re
        ("pygments_util_opts",
         "from __future__ import annotations\nimport re\n" +
         _extract_symbols(site_packages / "pygments/util.py", ["OptionError", "get_choice_opt", "get_bool_opt", "get_int_opt", "get_list_opt"]) +
         "\ndef run(opts):\n    return {'b': get_bool_opt(opts, 'flag', False), 'i': get_int_opt(opts, 'n', 1), 'l': get_list_opt(opts, 'tags', []), 'c': get_choice_opt(opts, 'mode', ['fast', 'safe'], 'safe')}\n",
         "pygments/util.py",
         [("a", [{"flag": "yes", "n": "42", "tags": "a b c", "mode": "FAST"}], False), ("b", [{"flag": "0", "n": 7, "tags": ["x", "y"], "mode": "safe"}], False)]),

        # 17. pygments.regexopt regex_opt
        ("pygments_regex_opt",
         "from __future__ import annotations\nimport re\nfrom re import escape\nfrom itertools import groupby\nfrom operator import itemgetter\n" +
         _extract_symbols(site_packages / "pygments/regexopt.py", ["CS_ESCAPE", "FIRST_ELEMENT", "commonprefix", "make_charset", "regex_opt_inner", "regex_opt"]) +
         "\ndef run(words, test_str):\n    pat = regex_opt(words, prefix=r'\\b', suffix=r'\\b')\n    return {'pat': pat, 'matches': re.findall(pat, test_str)}\n",
         "pygments/regexopt.py",
         [("a", [["for", "from", "format", "if", "in", "import"], "for x in from_mod import format"], False), ("b", [["cat", "car", "cart", "dog"], "car cart dog cat"], False)]),

        # 18. urllib3.util.util to_bytes / to_str
        ("urllib3_util_bytes",
         "from __future__ import annotations\nimport typing\n" +
         _extract_symbols(site_packages / "urllib3/util/util.py", ["to_bytes", "to_str"]) +
         "\ndef run(text, encoding):\n    b = to_bytes(text, encoding)\n    s = to_str(b, encoding)\n    return {'hex': b.hex(), 'back': s}\n",
         "urllib3/util/util.py",
         [("a", ["café-2026", "utf-8"], False), ("b", ["hello-world", "ascii"], False)]),

        # 19. urllib3.fields format_header_param_rfc2231 / format_header_param_html5
        ("urllib3_fields_header",
         "from __future__ import annotations\nimport email.utils\nimport mimetypes\nimport typing\n" +
         _extract_symbols(site_packages / "urllib3/fields.py", ["format_header_param_rfc2231", "format_header_param_html5"]) +
         "\ndef run(name, val):\n    return {'rfc2231': format_header_param_rfc2231(name, val), 'html5': format_header_param_html5(name, val)}\n",
         "urllib3/fields.py",
         [("a", ["filename", "report 2026.txt"], False), ("b", ["filename", 'a"b\\c.csv'], False)]),

        # 20. urllib3.util.timeout Timeout
        ("urllib3_timeout_obj",
         "from __future__ import annotations\nimport time\nimport typing\nfrom enum import Enum\nclass _TYPE_DEFAULT(Enum):\n    token = -1\n_DEFAULT_TIMEOUT = _TYPE_DEFAULT.token\n" +
         _extract_symbols(site_packages / "urllib3/util/timeout.py", ["Timeout"]) +
         "\ndef run(connect, read, total):\n    t = Timeout(connect=connect, read=read, total=total)\n    return {'connect': t.connect_timeout, 'read': t.read_timeout, 'total': t.total}\n",
         "urllib3/util/timeout.py",
         [("a", [2.5, 10.0, 15.0], False), ("b", [5.0, 5.0, None], False)]),

        # 21. tqdm.utils _is_ascii / disp_len / disp_trim
        ("tqdm_disp_trim",
         "from __future__ import annotations\nimport re\n" +
         _extract_symbols(site_packages / "tqdm/utils.py", ["RE_ANSI", "_is_ascii", "disp_len", "disp_trim"]) +
         "\ndef run(s, limit):\n    return {'ascii': _is_ascii(s), 'len': disp_len(s), 'trim': disp_trim(s, limit)}\n",
         "tqdm/utils.py",
         [("a", ["\x1b[32mhello world\x1b[0m", 7], False), ("b", ["plain-text-123", 5], False)]),

        # 22. termcolor.termcolor colored
        ("termcolor_colored",
         "from __future__ import annotations\nfrom functools import cache\nimport os\nfrom typing import Any, Iterable\n" +
         _extract_symbols(site_packages / "termcolor/termcolor.py", ["ATTRIBUTES", "HIGHLIGHTS", "COLORS", "RESET", "can_colorize", "colored"]) +
         "\ndef run(txt, color, attrs):\n    return colored(txt, color, attrs=attrs, force_color=True)\n",
         "termcolor/termcolor.py",
         [("a", ["PASS", "green", ["bold"]], False), ("b", ["FAIL", "red", ["underline", "bold"]], False)]),

        # 23. markdown_it.common.utils escapeHtml / escapeRE / mdTrim / isSpace
        ("markdown_it_utils",
         "from __future__ import annotations\nimport html\nimport re\n" +
         _extract_symbols(site_packages / "markdown_it/common/utils.py", ["escapeHtml", "REGEXP_ESCAPE_RE", "escapeRE", "isSpace", "MD_WHITESPACE", "isWhiteSpace", "MD_TRIM_CHARS", "MD_TRIM_RE", "mdTrim"]) +
         "\ndef run(raw, ref):\n    return {'esc': escapeHtml(raw), 'trim': mdTrim(ref), 're': escapeRE('a.b+c?'), 'sp': [isSpace(ord(c)) for c in ' \\ta']}\n",
         "markdown_it/common/utils.py",
         [("a", ['<a href="x&y">', "  Foo   Bar  "], False), ("b", ["1 < 2 && 3 > 2", "\tHello World\t"], False)]),

        # 24. markdown_it.helpers.parse_link_destination parseLinkDestination
        ("markdown_it_parse_link_dest",
         "from __future__ import annotations\nimport re\n" +
         _extract_symbols(site_packages / "markdown_it/common/utils.py", ["charCodeAt", "ESCAPABLE", "ESCAPE_CHAR", "stripEscape", "UNESCAPE_ALL_RE", "DIGITAL_ENTITY_BASE10_RE", "DIGITAL_ENTITY_BASE16_RE", "isValidEntityCode", "fromCodePoint", "replaceEntityPattern", "unescapeAll"]) + "\n" +
         _extract_symbols(site_packages / "markdown_it/helpers/parse_link_destination.py", ["_Result", "parseLinkDestination"]) +
         "\ndef run(text, pos):\n    r = parseLinkDestination(text, pos, len(text))\n    return {'ok': r.ok, 'pos': r.pos, 'lines': r.lines, 'str': r.str}\n",
         "markdown_it/helpers/parse_link_destination.py",
         [("a", ["(https://example.com/a(b)c) rest", 1], False), ("b", ["(<https://ex.io/path> title)", 1], False)]),

        # 25. rich.box Box table border rendering
        ("rich_box_borders",
         "from __future__ import annotations\nfrom typing import Iterable, List\n" +
         _extract_symbols(site_packages / "rich/box.py", ["Box", "ASCII", "SQUARE", "ROUNDED"]) +
         "\ndef run(style, widths):\n    b = ROUNDED if style == 'rounded' else (SQUARE if style == 'square' else ASCII)\n    return {'top': b.get_top(widths), 'mid': b.get_row(widths, 'row'), 'bot': b.get_bottom(widths)}\n",
         "rich/box.py",
         [("a", ["rounded", [4, 6, 3]], False), ("b", ["ascii", [5, 5]], False)]),

        # 26. h2.windows WindowManager flow-control state machine
        ("h2_window_manager",
         "from __future__ import annotations\n" +
         _extract_symbols(site_packages / "h2/windows.py", ["WindowManager"]) +
         "\ndef run(max_win, events):\n    wm = WindowManager(max_window_size=max_win)\n    out = []\n    for op, val in events:\n        if op == 'open': wm.window_opened(val)\n        elif op == 'proc': out.append(wm.process_bytes(val))\n    return {'win': wm.current_window_size, 'incs': out}\n",
         "h2/windows.py",
         [("a", [65535, [["open", 16384], ["proc", 16384], ["open", 16384], ["proc", 16384]]], False), ("b", [16384, [["open", 4096], ["proc", 4096], ["open", 6000], ["proc", 6000]]], False)]),

        # 27. urllib3.util.request make_headers
        ("urllib3_make_headers",
         "from __future__ import annotations\nfrom base64 import b64encode\nimport typing\nACCEPT_ENCODING = 'gzip,deflate'\n" +
         _extract_symbols(site_packages / "urllib3/util/request.py", ["make_headers"]) +
         "\ndef run(keep_alive, accept_enc, ua, basic):\n    return make_headers(keep_alive=keep_alive, accept_encoding=accept_enc, user_agent=ua, basic_auth=basic)\n",
         "urllib3/util/request.py",
         [("a", [True, True, "stage10/1.0", "alice:s3cr3t"], False), ("b", [False, ["br", "gzip"], "bot/2.0", None], False)]),

        # 28. h11._util bytesify / validate
        ("h11_util_validate",
         "from __future__ import annotations\nimport re\nfrom typing import Any, Dict, Pattern, Tuple, Type, Union\n" +
         _extract_symbols(site_packages / "h11/_util.py", ["ProtocolError", "LocalProtocolError", "validate", "bytesify"]) +
         "\ndef run(raw_line):\n    pat = re.compile(rb'^(?P<method>[A-Z]+) (?P<target>/\\S*) HTTP/(?P<ver>\\d\\.\\d)$')\n    m = validate(pat, bytesify(raw_line))\n    return {k: v.decode('ascii') for k, v in m.items()}\n",
         "h11/_util.py",
         [("a", ["GET /v1/status HTTP/1.1"], False), ("b", ["BAD LINE"], True)]),

        # 29. dateutil.relativedelta weekday
        ("dateutil_weekday_obj",
         "from __future__ import annotations\n" +
         _extract_symbols(site_packages / "dateutil/_common.py", ["weekday"]) +
         "\ndef run(day_idx, n):\n    w = weekday(day_idx)(n)\n    return {'weekday': w.weekday, 'n': w.n, 'repr': repr(w)}\n",
         "dateutil/_common.py",
         [("a", [0, 2], False), ("b", [4, -1], False)]),

        # 30. rich.segment Segment helpers
        ("rich_region_obj",
         "from __future__ import annotations\nfrom typing import NamedTuple\n" +
         _extract_symbols(site_packages / "rich/region.py", ["Region"]) +
         "\ndef run(rects):\n    out = []\n    for x, y, w, h in rects:\n        r = Region(x, y, w, h)\n        out.append({'area': r.width * r.height, 'x2': r.x + r.width, 'y2': r.y + r.height})\n    return out\n",
         "rich/region.py",
         [("a", [[[0, 0, 10, 5], [3, 4, 8, 6]]], False), ("b", [[[2, 1, 7, 3], [5, 5, 4, 4]]], False)]),
    ]

    tasks: list[dict[str, Any]] = []
    for name, src, src_file, variants in probes:
        fam = f"stage10-py-oss-probe:{name}"
        for v_tag, v_args, is_throw in variants:
            tid = f"stage10-py-oss-probe-{name.replace('_', '-')}-{v_tag}"
            t = _single_task(
                tid,
                fam,
                src,
                v_args,
                ["oss-real", "python"],
                allow_throw=is_throw,
                bucket="bucket_c_oss_probe_py",
            )
            t["metadata"]["sourceFile"] = src_file
            t["metadata"]["sourceOrigin"] = "stage10-py-oss-probe"
            tasks.append(t)
    return tasks


# ===========================================================================
# 2x Independent Verification Harness (Direct + Real JSONL Bridge Process)
# ===========================================================================

class _PyWorkerClient:
    """Thread-safe persistent client for `tools/tinker-execution-py.py`."""

    def __init__(self) -> None:
        self._proc = subprocess.Popen(
            [sys.executable, str(_REPO_ROOT / "tools/tinker-execution-py.py")],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
            env={**os.environ, "PYTHONPATH": _TRAINING_DIR},
        )
        self._lock = threading.Lock()
        self._seq = 0

    def request(self, op: str, **kwargs: Any) -> Any:
        with self._lock:
            self._seq += 1
            req_id = f"req-{self._seq}"
            payload = {"id": req_id, "op": op, **kwargs}
            assert self._proc.stdin and self._proc.stdout
            self._proc.stdin.write(_json_compact(payload) + "\n")
            self._proc.stdin.flush()
            line = self._proc.stdout.readline()
            if not line:
                err = self._proc.stderr.read() if self._proc.stderr else ""
                raise RuntimeError(f"Worker EOF on {op}: {err}")
            resp = json.loads(line)
            if not resp.get("ok"):
                raise RuntimeError(f"Worker error on {op}: {resp.get('error')}")
            return resp["result"]

    def close(self) -> None:
        try:
            if self._proc.stdin:
                self._proc.stdin.close()
            self._proc.wait(timeout=5)
        except Exception:
            self._proc.kill()


def _verify_and_preexport_one(
    task: dict[str, Any],
    worker_pool: queue.Queue[_PyWorkerClient],
    forbidden: dict[str, set[str]],
) -> dict[str, Any]:
    # Pass 1: Direct export_python_example + live session replay
    pass1 = export_python_example(task, trace_format="compact", reasoning_channel="thinking")
    audit1 = pass1["metadata"]["traceAudit"]
    if not audit1.get("replayVerified"):
        raise AssertionError(f"{task['id']}: pass1 replayVerified is False")

    prepared = prepare_python_task(task, trace_format="compact")
    session = create_python_session(prepared)
    msgs = pass1["messages"]
    start_idx = next(i for i, m in enumerate(msgs) if m.get("role") == "user") + 1
    idx = start_idx
    while idx < len(msgs):
        m = msgs[idx]
        idx += 1
        assert m.get("role") == "assistant", f"{task['id']}: expected assistant at {idx-1}"
        step_res = session.step(m, 0)
        for obs in step_res["messages"]:
            assert idx < len(msgs) and msgs[idx] == obs, f"{task['id']}: observation mismatch at {idx}"
            idx += 1
    grade = session.grade()
    if not grade["success"]:
        raise AssertionError(f"{task['id']}: live session grade failed: {grade}")

    # Pass 2: Independent export through real JSONL bridge `tools/tinker-execution-py.py`
    worker = worker_pool.get()
    try:
        pass2 = worker.request(
            "export",
            task=task,
            traceFormat="compact",
            reasoningChannel="thinking",
        )
    finally:
        worker_pool.put(worker)

    if pass1["sourceHash"] != pass2["sourceHash"]:
        raise AssertionError(f"{task['id']}: non-deterministic sourceHash across 2x passes")
    if pass1["messages"] != pass2["messages"]:
        raise AssertionError(f"{task['id']}: non-deterministic messages across 2x passes")

    # Token budget checks (total context <= 58K, every assistant turn <= 18K)
    serialized = _json_compact(msgs)
    total_tiktoken = _count_tokens(serialized)
    total_est32 = _estimate_tokens_32(serialized)
    if total_tiktoken > MAX_TOTAL_EST_TOKENS or total_est32 > 62_000:
        raise AssertionError(
            f"{task['id']}: context too large (tiktoken={total_tiktoken}, est32={total_est32})"
        )

    max_turn_toks = 0
    for m in msgs:
        if m.get("role") == "assistant":
            turn_text = assistant_thinking_text(m) + "\n" + assistant_visible_text(m)
            if isinstance(m.get("tool_calls"), list):
                turn_text += "\n" + _json_compact(m["tool_calls"])
            t_toks = _count_tokens(turn_text)
            if t_toks > max_turn_toks:
                max_turn_toks = t_toks
    if max_turn_toks > MAX_TURN_TOKENS:
        raise AssertionError(f"{task['id']}: assistant turn too large ({max_turn_toks} > {MAX_TURN_TOKENS})")

    # Bucket A multi-file code.load + long-context checks
    bucket = (task.get("metadata") or {}).get("bucket", "")
    is_mf = isinstance(task.get("files"), dict) and len(task["files"]) > 1
    code_load_calls = int(pass1["metadata"].get("codeLoadCalls", 0))
    if is_mf and code_load_calls < 1:
        raise AssertionError(f"{task['id']}: multi-file task has 0 code.load calls")

    split_component = _sha256_text(f"{pass1['family']}:{pass1['sourceHash']}")
    # Zero-leakage check against RealExecBench v1
    if pass1["id"] in forbidden["ids"]:
        raise AssertionError(f"LEAKAGE id={pass1['id']}")
    if pass1["family"] in forbidden["families"]:
        raise AssertionError(f"LEAKAGE family={pass1['family']}")
    if pass1["sourceHash"] in forbidden["sourceHashes"]:
        raise AssertionError(f"LEAKAGE sourceHash={pass1['sourceHash']}")
    if split_component in forbidden["split_components"]:
        raise AssertionError(f"LEAKAGE split_component={split_component}")

    loaded_paths: set[str] = set()
    if is_mf:
        loaded_paths.add(task["entryFile"])
        for m in msgs:
            if m.get("role") == "assistant" and isinstance(m.get("tool_calls"), list):
                for tc in m["tool_calls"]:
                    fn = tc.get("function") or {}
                    if fn.get("name") == CODE_LOAD_OPERATION:
                        raw_a = json.loads(fn.get("arguments") or "{}")
                        for req in raw_a.get("arguments") or []:
                            if isinstance(req, dict) and isinstance(req.get("path"), str):
                                loaded_paths.add(req["path"])

    row = dict(pass1)
    row["split_component"] = split_component
    row["metadata"] = {
        **(task.get("metadata") or {}),
        **pass1["metadata"],
        "bucket": bucket,
        "conversationChars": len(serialized),
        "tiktokenTokens": total_tiktoken,
        "estimatedTokens32": total_est32,
        "maxTurnTokens": max_turn_toks,
        "fileCount": len(task["files"]) if is_mf else 1,
        "loadedFileCount": len(loaded_paths) if is_mf else 1,
        "codeLoadCalls": code_load_calls,
        "deterministic2xVerified": True,
        "liveReplayVerified": True,
    }
    return row


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Build & 2x-verify Stage 10 Python 65K & Hairy tasks.")
    parser.add_argument("--output", default=str(DEFAULT_OUTPUT))
    parser.add_argument("--report", default=str(DEFAULT_REPORT))
    parser.add_argument("--jobs", type=int, default=6)
    parser.add_argument("--site-packages", default=str(DEFAULT_SITE_PACKAGES))
    parser.add_argument("--realexec-benchmark", default=str(DEFAULT_REALEXEC_BENCHMARK))
    parser.add_argument("--realexec-manifest", default=str(DEFAULT_REALEXEC_MANIFEST))
    args = parser.parse_args(argv)

    site_packages = _find_site_packages(Path(args.site_packages))
    forbidden = _load_realexec_forbidden(Path(args.realexec_benchmark), Path(args.realexec_manifest))

    print("Building candidate Python tasks...", file=sys.stderr, flush=True)
    a1 = build_bucket_a1_oss_multifile(site_packages)
    print(f"  Bucket A1 (OSS multi-file 65K): {len(a1)} tasks across {len({t['family'] for t in a1})} families", file=sys.stderr, flush=True)
    a2 = build_bucket_a2_synthetic_65k()
    print(f"  Bucket A2 (Synth 55-145f 65K):  {len(a2)} tasks across {len({t['family'] for t in a2})} families", file=sys.stderr, flush=True)
    c1 = build_bucket_c1_hairy_py()
    print(f"  Bucket C1 (Hairy single-file):  {len(c1)} tasks across {len({t['family'] for t in c1})} families", file=sys.stderr, flush=True)
    c2 = build_bucket_c2_oss_probes(site_packages)
    print(f"  Bucket C2 (OSS single probes):  {len(c2)} tasks across {len({t['family'] for t in c2})} families", file=sys.stderr, flush=True)

    all_candidates = [*a1, *a2, *c1, *c2]
    jobs = max(1, min(10, args.jobs))
    worker_pool: queue.Queue[_PyWorkerClient] = queue.Queue()
    workers = [_PyWorkerClient() for _ in range(jobs)]
    for w in workers:
        health = w.request("health")
        assert health.get("schema"), f"Bad worker health: {health}"
        worker_pool.put(w)

    verified: list[dict[str, Any]] = []
    failures: list[dict[str, str]] = []
    try:
        with concurrent.futures.ThreadPoolExecutor(max_workers=jobs) as pool:
            fut_map = {pool.submit(_verify_and_preexport_one, t, worker_pool, forbidden): t for t in all_candidates}
            done = 0
            for fut in concurrent.futures.as_completed(fut_map):
                t = fut_map[fut]
                done += 1
                try:
                    verified.append(fut.result())
                except Exception as exc:
                    failures.append({"id": t["id"], "family": t["family"], "error": f"{type(exc).__name__}: {exc}"})
                    print(f"FAIL {t['id']}: {exc}", file=sys.stderr, flush=True)
                if done % 40 == 0 or done == len(all_candidates):
                    print(f"  verified {done}/{len(all_candidates)} (ok={len(verified)}, fail={len(failures)})", file=sys.stderr, flush=True)
    finally:
        for w in workers:
            w.close()

    if failures:
        print(json.dumps({"failures": failures[:20], "totalFailures": len(failures)}, indent=2), file=sys.stderr)
        return 1

    # Preserve deterministic order by candidate id
    order = {t["id"]: i for i, t in enumerate(all_candidates)}
    verified.sort(key=lambda r: order[r["id"]])

    # Verify unique IDs
    ids = [r["id"] for r in verified]
    assert len(ids) == len(set(ids)), "Duplicate task IDs detected"

    # Run causal supervision audit on all effectful/multi-file causal tasks
    causal_tasks = [r["task"] for r in verified if "causal-branch" in (r["task"].get("features") or [])]
    sup_audit = audit_python_supervision(
        causal_tasks,
        {"formats": ["compact", "actions-only"], "samplePerFeature": 100},
    )
    if not (sup_audit["valid"] and sup_audit["allReplayed"]):
        raise AssertionError(f"Supervision audit failed: {sup_audit}")

    out_path = Path(args.output).resolve()
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text("\n".join(_json_compact(r) for r in verified) + "\n", encoding="utf-8")

    by_bucket: dict[str, dict[str, Any]] = {}
    for b in ("bucket_a_oss_65k", "bucket_a_synth_65k", "bucket_c_hairy_py", "bucket_c_oss_probe_py"):
        sub = [r for r in verified if r["metadata"].get("bucket") == b]
        toks = sorted(r["metadata"]["tiktokenTokens"] for r in sub)
        est = sorted(r["metadata"]["estimatedTokens32"] for r in sub)
        by_bucket[b] = {
            "count": len(sub),
            "families": len({r["family"] for r in sub}),
            "tiktoken": {"min": toks[0], "p50": toks[len(toks) // 2], "max": toks[-1]} if toks else None,
            "est32": {"min": est[0], "p50": est[len(est) // 2], "max": est[-1]} if est else None,
        }

    report = {
        "totalTasks": len(verified),
        "uniqueFamilies": len({r["family"] for r in verified}),
        "buckets": by_bucket,
        "maxTurnTokens": max(r["metadata"]["maxTurnTokens"] for r in verified),
        "maxTotalTiktoken": max(r["metadata"]["tiktokenTokens"] for r in verified),
        "causalAudit": {
            "valid": sup_audit["valid"],
            "allReplayed": sup_audit["allReplayed"],
            "causalDivergencesChecked": sup_audit["causalDivergencesChecked"],
        },
        "zeroLeakageChecked": True,
        "output": str(out_path),
    }
    rep_path = Path(args.report).resolve()
    rep_path.parent.mkdir(parents=True, exist_ok=True)
    rep_path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
