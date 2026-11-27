"""RealExecBench v1: frozen zero-leakage benchmark builder, multi-model evaluator, and scoreboard comparator."""

from __future__ import annotations

from collections import Counter, defaultdict
import concurrent.futures
import copy
import hashlib
import inspect
import json
import math
from pathlib import Path
import random
import statistics
import sys
import threading
import time
from typing import Any

from tinker_py.codec import encode_readable
from tinker_py.execution import export_python_example

from .adapter import ContextOverflow, TinkerAdapter
from .external_benchmarks import (
    DEFAULT_CACHE_DIR,
    build_zero_shot_messages,
    grade_zero_shot_response,
    import_external_benchmarks,
)
from .metrics import failure_category as metrics_failure_category
from .metrics import paired_statistics, quantile, task_eval_bucket
from .runner import (
    Bridge,
    RolloutError,
    append_jsonl,
    atomic_json,
    digest,
    json_preserve_order,
    prompt_messages,
    read_jsonl,
    visible_text,
    write_jsonl,
)

REALEXECBENCH_VERSION = "realexecbench-v1"
REALEXECBENCH_TRACKS: tuple[str, ...] = (
    "external-anchor",
    "hairy-semantics",
    "effectful-io-pairs",
    "whole-codebase-65k",
    "frontend-browser",
)


def _sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def _canonical_args_key(row: dict[str, Any]) -> str:
    task = row.get("task") if isinstance(row.get("task"), dict) else row
    return json.dumps(task.get("args", []), ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _canonical_fixture_key(row: dict[str, Any]) -> str:
    task = row.get("task") if isinstance(row.get("task"), dict) else row
    return json.dumps(task.get("fixture", {}), ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _row_features(row: dict[str, Any]) -> set[str]:
    meta = row.get("metadata") if isinstance(row.get("metadata"), dict) else {}
    task = row.get("task") if isinstance(row.get("task"), dict) else {}
    task_meta = task.get("metadata") if isinstance(task.get("metadata"), dict) else {}
    out: set[str] = set()
    for src in (row.get("features"), meta.get("features"), task_meta.get("features")):
        if isinstance(src, (list, tuple, set)):
            out.update(f for f in src if isinstance(f, str))
    return out


def _row_language(row: dict[str, Any]) -> str:
    task = row.get("task") if isinstance(row.get("task"), dict) else {}
    meta = row.get("metadata") if isinstance(row.get("metadata"), dict) else {}
    lang = row.get("language") or task.get("language") or meta.get("language")
    if isinstance(lang, str) and lang:
        return lang
    if "typescript" in _row_features(row):
        return "ts"
    return "js"


def _row_external_ops(row: dict[str, Any]) -> list[str]:
    ops: set[str] = set()
    for msg in row.get("messages") or []:
        for tc in msg.get("tool_calls") or []:
            fn = (tc.get("function") or {}).get("name") or tc.get("name")
            if isinstance(fn, str) and fn and fn != "code.load":
                ops.add(fn)
    task = row.get("task") if isinstance(row.get("task"), dict) else {}
    fixture = task.get("fixture") if isinstance(task.get("fixture"), dict) else {}
    for call in fixture.get("calls") or []:
        op = call.get("operation")
        if isinstance(op, str) and op and op != "code.load":
            ops.add(op)
    return sorted(ops)


# =============================================================================
# Zero-leakage auditing
# =============================================================================


def collect_forbidden_identities(reference_rows: list[dict[str, Any]]) -> dict[str, set[str]]:
    """Collect all IDs, families, sourceHashes, and split_components from train/validation rows."""
    ids: set[str] = set()
    families: set[str] = set()
    source_hashes: set[str] = set()
    split_components: set[str] = set()

    for row in reference_rows:
        sp = row.get("split")
        if sp is None and isinstance(row.get("task"), dict):
            sp = row["task"].get("split")
        if sp not in ("train", "validation"):
            continue
        rid = row.get("id")
        if isinstance(rid, str) and rid:
            ids.add(rid)
        fam = row.get("family")
        if isinstance(fam, str) and fam:
            families.add(fam)
        sh = row.get("sourceHash") or row.get("source_hash")
        if isinstance(sh, str) and sh:
            source_hashes.add(sh)
        for extra_sh in row.get("sourceHashes") or []:
            if isinstance(extra_sh, str) and extra_sh:
                source_hashes.add(extra_sh)
        sc = row.get("split_component")
        if isinstance(sc, str) and sc:
            split_components.add(sc)

    return {
        "ids": ids,
        "families": families,
        "sourceHashes": source_hashes,
        "split_components": split_components,
    }


def audit_zero_leakage(
    benchmark_rows: list[dict[str, Any]],
    forbidden: dict[str, set[str]],
    *,
    raise_on_leak: bool = True,
) -> dict[str, Any]:
    """Verify 0 overlap across id, family, sourceHash, and split_component against train/validation."""
    leaks: dict[str, list[dict[str, str]]] = {
        "id": [],
        "family": [],
        "sourceHash": [],
        "split_component": [],
    }
    for row in benchmark_rows:
        rid = str(row.get("id") or "")
        fam = str(row.get("family") or "")
        sh = str(row.get("sourceHash") or row.get("source_hash") or "")
        sc = str(row.get("split_component") or "")
        if rid and rid in forbidden["ids"]:
            leaks["id"].append({"task_id": rid, "value": rid})
        if fam and fam in forbidden["families"]:
            leaks["family"].append({"task_id": rid, "value": fam})
        if sh and sh in forbidden["sourceHashes"]:
            leaks["sourceHash"].append({"task_id": rid, "value": sh})
        for extra_sh in row.get("sourceHashes") or []:
            if isinstance(extra_sh, str) and extra_sh in forbidden["sourceHashes"]:
                leaks["sourceHash"].append({"task_id": rid, "value": extra_sh})
        if sc and sc in forbidden["split_components"]:
            leaks["split_component"].append({"task_id": rid, "value": sc})

    overlap_counts = {k: len(v) for k, v in leaks.items()}
    total_overlaps = sum(overlap_counts.values())
    result = {
        "passed": total_overlaps == 0,
        "checked_benchmark_tasks": len(benchmark_rows),
        "forbidden_reference_counts": {k: len(v) for k, v in forbidden.items()},
        "overlap_counts": overlap_counts,
        "overlaps": leaks,
    }
    if raise_on_leak and total_overlaps > 0:
        summary = ", ".join(f"{k}={v}" for k, v in overlap_counts.items() if v > 0)
        raise ValueError(f"Zero-leakage audit FAILED against train/validation ({summary})")
    return result


# =============================================================================
# Unseen counterfactual I/O pairs (4 Python pairs + 4 JS pairs = 16 tasks)
# =============================================================================


def unseen_counterfactual_io_pair_specs() -> list[dict[str, Any]]:
    """Return 8 brand-new unseen counterfactual I/O pairs (4 Python + 4 JS).

    Every pair has identical (source, args) across its two branches and
    counterfactual fixture observations that flip control flow and outcomes.
    """
    specs: list[dict[str, Any]] = []

    # -------------------------------------------------------------------------
    # Python Pair 1: fs.exists + fs.readText + fs.writeText (config bootstrap)
    # -------------------------------------------------------------------------
    py_cfg_src = """\
import json
import os


def run(cfg_path, defaults):
    if os.path.exists(cfg_path):
        with open(cfg_path, "r") as fh:
            raw = fh.read()
        loaded = json.loads(raw)
        merged = {**defaults, **loaded}
        return {"source": "disk", "config": merged, "wrote": False}
    payload = json.dumps(defaults, sort_keys=True)
    with open(cfg_path, "w") as fh:
        fh.write(payload)
    return {"source": "defaults", "config": dict(defaults), "wrote": True}
"""
    specs.append({
        "pair_id": "cf-io-pair:py-config-bootstrap",
        "language": "py",
        "family": "realexecbench-cf-io:py-config-bootstrap",
        "source": py_cfg_src,
        "entry": "run",
        "args": ["/srv/app/config.json", {"retries": 3, "timeout": 15}],
        "features": ["external", "effectful", "hard-effectful", "causal-pair", "fs", "fs.exists", "fs.readText", "fs.writeText", "python"],
        "branches": [
            (
                "disk-hit",
                [
                    {"operation": "fs.exists", "arguments": ["/srv/app/config.json"], "status": "fulfilled", "result": True},
                    {"operation": "fs.readText", "arguments": ["/srv/app/config.json"], "status": "fulfilled", "result": '{"timeout": 45, "region": "eu"}'},
                ],
            ),
            (
                "default-seed",
                [
                    {"operation": "fs.exists", "arguments": ["/srv/app/config.json"], "status": "fulfilled", "result": False},
                    {"operation": "fs.writeText", "arguments": ["/srv/app/config.json", '{"retries": 3, "timeout": 15}'], "status": "fulfilled", "result": None},
                ],
            ),
        ],
    })

    # -------------------------------------------------------------------------
    # Python Pair 2: env.get + platform.log (release gate policy)
    # -------------------------------------------------------------------------
    py_env_src = """\
import logging
import os


def run(release_id, error_rate):
    stage = os.getenv("DEPLOY_STAGE") or "dev"
    override = os.getenv("ALLOW_HOTFIX")
    threshold = 0.01 if stage == "prod" else 0.05
    if error_rate > threshold:
        if override == "yes" and stage != "prod":
            logging.warning("hotfix override %s stage=%s", release_id, stage)
            return {"approved": True, "stage": stage, "reason": "override", "threshold": threshold}
        logging.error("blocked %s rate=%.3f", release_id, error_rate)
        return {"approved": False, "stage": stage, "reason": "error-rate", "threshold": threshold}
    logging.info("approved %s stage=%s", release_id, stage)
    return {"approved": True, "stage": stage, "reason": "clean", "threshold": threshold}
"""
    specs.append({
        "pair_id": "cf-io-pair:py-release-gate",
        "language": "py",
        "family": "realexecbench-cf-io:py-release-gate",
        "source": py_env_src,
        "entry": "run",
        "args": ["rel-42", 0.03],
        "features": ["external", "effectful", "hard-effectful", "causal-pair", "env", "env.get", "logging", "platform.log", "python"],
        "branches": [
            (
                "prod-block",
                [
                    {"operation": "env.get", "arguments": ["DEPLOY_STAGE"], "status": "fulfilled", "result": "prod"},
                    {"operation": "env.get", "arguments": ["ALLOW_HOTFIX"], "status": "fulfilled", "result": "yes"},
                    {"operation": "platform.log", "arguments": ["ERROR", "blocked rel-42 rate=0.030"], "status": "fulfilled", "result": None},
                ],
            ),
            (
                "staging-pass",
                [
                    {"operation": "env.get", "arguments": ["DEPLOY_STAGE"], "status": "fulfilled", "result": "staging"},
                    {"operation": "env.get", "arguments": ["ALLOW_HOTFIX"], "status": "fulfilled", "result": None},
                    {"operation": "platform.log", "arguments": ["INFO", "approved rel-42 stage=staging"], "status": "fulfilled", "result": None},
                ],
            ),
        ],
    })

    # -------------------------------------------------------------------------
    # Python Pair 3: http.request + platform.time (webhook retry & latency SLA)
    # -------------------------------------------------------------------------
    py_http_src = """\
import json
import time
import urllib.error
import urllib.request


def run(endpoint, payload):
    t0 = time.time()
    body = json.dumps(payload, sort_keys=True).encode("utf-8")
    attempts = 0
    last_err = None
    while attempts < 2:
        attempts += 1
        req = urllib.request.Request(endpoint, data=body, method="POST", headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req) as resp:
                data = json.loads(resp.read().decode("utf-8"))
                elapsed = round(time.time() - t0, 3)
                return {"delivered": True, "attempts": attempts, "receipt": data.get("id"), "elapsed": elapsed}
        except urllib.error.HTTPError as exc:
            last_err = exc.code
            if exc.code < 500:
                break
    elapsed = round(time.time() - t0, 3)
    return {"delivered": False, "attempts": attempts, "status": last_err, "elapsed": elapsed}
"""
    specs.append({
        "pair_id": "cf-io-pair:py-webhook-retry",
        "language": "py",
        "family": "realexecbench-cf-io:py-webhook-retry",
        "source": py_http_src,
        "entry": "run",
        "args": ["https://hooks.realexec.test/events", {"event": "invoice.paid", "seq": 7}],
        "features": ["external", "effectful", "hard-effectful", "causal-pair", "http", "http.request", "platform.time", "exception", "python"],
        "branches": [
            (
                "retry-then-ok",
                [
                    {"operation": "platform.time", "arguments": [], "status": "fulfilled", "result": 1700001000.0},
                    {
                        "operation": "http.request",
                        "arguments": [{
                            "method": "POST",
                            "url": "https://hooks.realexec.test/events",
                            "headers": {"Content-type": "application/json"},
                            "body": '{"event": "invoice.paid", "seq": 7}',
                        }],
                        "status": "fulfilled",
                        "result": {
                            "status": 503,
                            "url": "https://hooks.realexec.test/events",
                            "headers": {"Content-Type": "text/plain"},
                            "body": "unavailable",
                        },
                    },
                    {
                        "operation": "http.request",
                        "arguments": [{
                            "method": "POST",
                            "url": "https://hooks.realexec.test/events",
                            "headers": {"Content-type": "application/json"},
                            "body": '{"event": "invoice.paid", "seq": 7}',
                        }],
                        "status": "fulfilled",
                        "result": {
                            "status": 200,
                            "url": "https://hooks.realexec.test/events",
                            "headers": {"Content-Type": "application/json"},
                            "body": '{"id": "rcpt-99"}',
                        },
                    },
                    {"operation": "platform.time", "arguments": [], "status": "fulfilled", "result": 1700001000.45},
                ],
            ),
            (
                "client-400-stop",
                [
                    {"operation": "platform.time", "arguments": [], "status": "fulfilled", "result": 1700001000.0},
                    {
                        "operation": "http.request",
                        "arguments": [{
                            "method": "POST",
                            "url": "https://hooks.realexec.test/events",
                            "headers": {"Content-type": "application/json"},
                            "body": '{"event": "invoice.paid", "seq": 7}',
                        }],
                        "status": "fulfilled",
                        "result": {
                            "status": 400,
                            "url": "https://hooks.realexec.test/events",
                            "headers": {"Content-Type": "text/plain"},
                            "body": "bad schema",
                        },
                    },
                    {"operation": "platform.time", "arguments": [], "status": "fulfilled", "result": 1700001000.12},
                ],
            ),
        ],
    })

    # -------------------------------------------------------------------------
    # Python Pair 4: fs.listdir + shell.exec (artifact checksum gate)
    # -------------------------------------------------------------------------
    py_shell_src = """\
import os
import subprocess


def run(dist_dir):
    entries = sorted(name for name in os.listdir(dist_dir) if name.endswith(".whl"))
    if not entries:
        return {"ok": False, "wheels": [], "reason": "no-wheels"}
    target = dist_dir + "/" + entries[0]
    proc = subprocess.run(["sha256sum", target], capture_output=True, text=True)
    if proc.returncode != 0:
        return {"ok": False, "wheels": entries, "reason": "hash-failed", "stderr": proc.stderr.strip()}
    digest_hex = proc.stdout.strip().split()[0]
    return {"ok": True, "wheels": entries, "primary_sha": digest_hex[:12]}
"""
    specs.append({
        "pair_id": "cf-io-pair:py-artifact-verify",
        "language": "py",
        "family": "realexecbench-cf-io:py-artifact-verify",
        "source": py_shell_src,
        "entry": "run",
        "args": ["/build/dist"],
        "features": ["external", "effectful", "hard-effectful", "causal-pair", "fs", "fs.listdir", "shell", "shell.exec", "python"],
        "branches": [
            (
                "hash-ok",
                [
                    {"operation": "fs.listdir", "arguments": ["/build/dist"], "status": "fulfilled", "result": ["README.md", "pkg-1.0.whl", "pkg-0.9.whl"]},
                    {
                        "operation": "shell.exec",
                        "arguments": [{"args": ["sha256sum", "/build/dist/pkg-0.9.whl"], "shell": False}],
                        "status": "fulfilled",
                        "result": {"returncode": 0, "stdout": "abcdef1234567890  /build/dist/pkg-0.9.whl\n", "stderr": ""},
                    },
                ],
            ),
            (
                "hash-fail",
                [
                    {"operation": "fs.listdir", "arguments": ["/build/dist"], "status": "fulfilled", "result": ["pkg-1.0.whl"]},
                    {
                        "operation": "shell.exec",
                        "arguments": [{"args": ["sha256sum", "/build/dist/pkg-1.0.whl"], "shell": False}],
                        "status": "fulfilled",
                        "result": {"returncode": 1, "stdout": "", "stderr": "permission denied\n"},
                    },
                ],
            ),
        ],
    })

    # -------------------------------------------------------------------------
    # JS Pair 5: fs.readText + fs.writeText (schema migration checkpoint)
    # -------------------------------------------------------------------------
    js_mig_src = """\
async function run(statePath, targetVersion) {
  const raw = await host.readText(statePath);
  const state = JSON.parse(raw);
  if (state.version >= targetVersion) {
    return {migrated: false, version: state.version, steps: []};
  }
  const steps = [];
  while (state.version < targetVersion) {
    state.version += 1;
    steps.push('v' + state.version);
  }
  await host.writeText(statePath, JSON.stringify(state));
  return {migrated: true, version: state.version, steps};
}"""
    specs.append({
        "pair_id": "cf-io-pair:js-schema-migration",
        "language": "js",
        "family": "realexecbench-cf-io:js-schema-migration",
        "source": js_mig_src,
        "entry": "run",
        "args": ["/var/lib/db/schema.json", 4],
        "features": ["native-v8", "external", "effectful", "hard-effectful", "causal-pair", "fs", "fs.readText", "fs.writeText", "json"],
        "branches": [
            (
                "already-current",
                [
                    {"operation": "fs.readText", "arguments": ["/var/lib/db/schema.json"], "status": "fulfilled", "result": '{"version":4}'},
                ],
            ),
            (
                "upgrade-two-steps",
                [
                    {"operation": "fs.readText", "arguments": ["/var/lib/db/schema.json"], "status": "fulfilled", "result": '{"version":2}'},
                    {"operation": "fs.writeText", "arguments": ["/var/lib/db/schema.json", '{"version":4}'], "status": "fulfilled", "result": {"$js": "undefined"}},
                ],
            ),
        ],
    })

    # -------------------------------------------------------------------------
    # JS Pair 6: http.get + platform.dateNow + console.warn (stale-while-error)
    # -------------------------------------------------------------------------
    js_cache_src = """\
async function run(url, fallback) {
  const started = Date.now();
  try {
    const body = await host.httpGet(url);
    const parsed = JSON.parse(body);
    const latency = Date.now() - started;
    return {fresh: true, policy: parsed.policy, latency};
  } catch (err) {
    console.warn('policy-fallback:' + String(err));
    const latency = Date.now() - started;
    return {fresh: false, policy: fallback.policy, latency};
  }
}"""
    specs.append({
        "pair_id": "cf-io-pair:js-policy-fallback",
        "language": "js",
        "family": "realexecbench-cf-io:js-policy-fallback",
        "source": js_cache_src,
        "entry": "run",
        "args": ["https://cfg.realexec.test/policy", {"policy": "deny-by-default"}],
        "features": ["native-v8", "external", "effectful", "hard-effectful", "causal-pair", "http", "platform", "exception", "json"],
        "branches": [
            (
                "remote-ok",
                [
                    {"operation": "platform.dateNow", "arguments": [], "status": "fulfilled", "result": 5000},
                    {"operation": "http.get", "arguments": ["https://cfg.realexec.test/policy"], "status": "fulfilled", "result": '{"policy":"allow-verified"}'},
                    {"operation": "platform.dateNow", "arguments": [], "status": "fulfilled", "result": 5027},
                ],
            ),
            (
                "remote-rejected",
                [
                    {"operation": "platform.dateNow", "arguments": [], "status": "fulfilled", "result": 5000},
                    {"operation": "http.get", "arguments": ["https://cfg.realexec.test/policy"], "status": "rejected", "result": "504-timeout"},
                    {"operation": "platform.console.warn", "arguments": ["policy-fallback:504-timeout"], "status": "fulfilled", "result": {"$js": "undefined"}},
                    {"operation": "platform.dateNow", "arguments": [], "status": "fulfilled", "result": 5091},
                ],
            ),
        ],
    })

    # -------------------------------------------------------------------------
    # JS Pair 7: kv_get + kv_set + console.warn (idempotency lock & quota)
    # -------------------------------------------------------------------------
    js_kv_src = """\
async function run(tenant, amount, limit) {
  const key = 'spend:' + tenant;
  const prev = await kv_get(key);
  const used = prev === null ? 0 : prev.used;
  if (used + amount > limit) {
    console.warn('quota-exceeded:' + tenant + ':' + (used + amount));
    return {allowed: false, used, remaining: limit - used};
  }
  const nextUsed = used + amount;
  await kv_set(key, {used: nextUsed});
  return {allowed: true, used: nextUsed, remaining: limit - nextUsed};
}"""
    specs.append({
        "pair_id": "cf-io-pair:js-kv-quota-guard",
        "language": "js",
        "family": "realexecbench-cf-io:js-kv-quota-guard",
        "source": js_kv_src,
        "entry": "run",
        "args": ["acme", 40, 100],
        "nativeBindings": [
            {"name": "kv_get", "kind": "promise", "description": "Read tenant spend record {used} or null."},
            {"name": "kv_set", "kind": "promise", "description": "Write tenant spend record {used}."},
        ],
        "features": ["native-v8", "external", "effectful", "hard-effectful", "causal-pair", "native-bindings", "platform"],
        "branches": [
            (
                "under-limit",
                [
                    {"operation": "natlang.call", "arguments": ["kv_get", {"$js": "undefined"}, ["spend:acme"]], "status": "fulfilled", "result": {"used": 35}},
                    {"operation": "natlang.call", "arguments": ["kv_set", {"$js": "undefined"}, ["spend:acme", {"used": 75}]], "status": "fulfilled", "result": True},
                ],
            ),
            (
                "over-limit",
                [
                    {"operation": "natlang.call", "arguments": ["kv_get", {"$js": "undefined"}, ["spend:acme"]], "status": "fulfilled", "result": {"used": 80}},
                    {"operation": "platform.console.warn", "arguments": ["quota-exceeded:acme:120"], "status": "fulfilled", "result": {"$js": "undefined"}},
                ],
            ),
        ],
    })

    # -------------------------------------------------------------------------
    # JS Pair 8: Math.random() (tool mode) + http.request (canary traffic split)
    # -------------------------------------------------------------------------
    js_canary_src = """\
async function run(reqId, canaryWeight) {
  const roll = Math.random();
  const lane = roll < canaryWeight ? 'canary' : 'stable';
  const url = 'https://' + lane + '.realexec.test/dispatch/' + reqId;
  const reply = await host.httpRequest(url, 'POST', '{"x-lane":"' + lane + '"}', '{"id":"' + reqId + '"}');
  return {lane, roll, reply};
}"""
    specs.append({
        "pair_id": "cf-io-pair:js-canary-router",
        "language": "js",
        "family": "realexecbench-cf-io:js-canary-router",
        "source": js_canary_src,
        "entry": "run",
        "args": ["req-88", 0.25],
        "randomMode": "tool",
        "features": ["native-v8", "external", "effectful", "hard-effectful", "causal-pair", "http", "http.request", "platform", "random"],
        "branches": [
            (
                "lane-canary",
                [
                    {"operation": "platform.random", "arguments": [], "status": "fulfilled", "result": 0.12},
                    {
                        "operation": "http.request",
                        "arguments": ["https://canary.realexec.test/dispatch/req-88", "POST", '{"x-lane":"canary"}', '{"id":"req-88"}'],
                        "status": "fulfilled",
                        "result": "canary-ok",
                    },
                ],
            ),
            (
                "lane-stable",
                [
                    {"operation": "platform.random", "arguments": [], "status": "fulfilled", "result": 0.78},
                    {
                        "operation": "http.request",
                        "arguments": ["https://stable.realexec.test/dispatch/req-88", "POST", '{"x-lane":"stable"}', '{"id":"req-88"}'],
                        "status": "fulfilled",
                        "result": "stable-ok",
                    },
                ],
            ),
        ],
    })

    return specs


def export_unseen_counterfactual_io_pairs(
    repo: Path,
    *,
    trace_format: str = "compact",
    reasoning_channel: str = "thinking",
    bridge: Bridge | None = None,
) -> list[dict[str, Any]]:
    """Export and replay-verify all 8 unseen counterfactual I/O pairs (16 tasks)."""
    specs = unseen_counterfactual_io_pair_specs()
    rows: list[dict[str, Any]] = []
    owns_bridge = bridge is None
    active_bridge = bridge

    try:
        for spec in specs:
            lang = spec["language"]
            pair_id = spec["pair_id"]
            family = spec["family"]
            for branch_name, calls in spec["branches"]:
                task_id = f"realexec-cf-{pair_id.split(':', 1)[1]}-{branch_name}"
                if lang == "py":
                    raw_task: dict[str, Any] = {
                        "id": task_id,
                        "family": family,
                        "language": "py",
                        "source": spec["source"],
                        "entry": spec["entry"],
                        "args": encode_readable(spec["args"]),
                        "fixture": {"calls": calls},
                        "randomSeed": 17,
                        "maxSteps": 100000,
                        "timeoutMs": 10000,
                        "metadata": {
                            "sourceOrigin": "realexecbench-v1-unseen-cf-io",
                            "tier": 5,
                            "features": sorted(set(spec["features"])),
                            "evaluationRole": "counterfactual-io",
                            "pair_id": pair_id,
                            "pair_branch": branch_name,
                        },
                    }
                    exported = export_python_example(
                        raw_task,
                        trace_format=trace_format,
                        reasoning_channel=reasoning_channel,
                    )
                else:
                    if active_bridge is None:
                        active_bridge = Bridge(repo, timeout=60)
                    raw_task = {
                        "id": task_id,
                        "family": family,
                        "source": spec["source"],
                        "entry": spec["entry"],
                        "args": spec["args"],
                        "executionMode": "native",
                        "fixture": {"calls": calls},
                        "randomSeed": 17,
                        "maxSteps": 100000,
                        "timeoutMs": 10000,
                        "metadata": {
                            "sourceOrigin": "realexecbench-v1-unseen-cf-io",
                            "executionMode": "native",
                            "tier": 5,
                            "features": sorted(set(spec["features"])),
                            "evaluationRole": "counterfactual-io",
                            "pair_id": pair_id,
                            "pair_branch": branch_name,
                        },
                    }
                    if spec.get("randomMode"):
                        raw_task["randomMode"] = spec["randomMode"]
                    if spec.get("nativeBindings"):
                        raw_task["nativeBindings"] = copy.deepcopy(spec["nativeBindings"])
                    exported = active_bridge.request(
                        "export",
                        task=raw_task,
                        traceFormat=trace_format,
                        reasoningChannel=reasoning_channel,
                    )
                    exported["metadata"] = {**raw_task["metadata"], **(exported.get("metadata") or {})}
                    if not (exported.get("metadata", {}).get("traceAudit") or {}).get("replayVerified"):
                        raise RuntimeError(f"JS counterfactual pair replay failed for {task_id}")

                exported["split"] = "test"
                exported["split_component"] = digest(f"{family}:{exported['sourceHash']}")
                exported["pair_id"] = pair_id
                exported["metadata"]["pair_id"] = pair_id
                exported["metadata"]["pair_branch"] = branch_name
                rows.append(exported)
    finally:
        if owns_bridge and active_bridge is not None:
            active_bridge.close()

    return rows


# =============================================================================
# 5-Track RealExecBench v1 assembly
# =============================================================================


def _tag_causal_pairs(rows: list[dict[str, Any]], *, prefix: str) -> int:
    """Auto-tag counterfactual causal pairs sharing sourceHash (or causal-pair family) with distinct fixtures."""
    # First preserve any explicit pair_id already set
    by_src_args: dict[tuple[str, str], list[dict[str, Any]]] = defaultdict(list)
    by_src: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        if row.get("pair_id"):
            continue
        sh = str(row.get("sourceHash") or "")
        if not sh:
            continue
        by_src_args[(sh, _canonical_args_key(row))].append(row)
        by_src[sh].append(row)

    # Pass 1: strict counterfactual pairs (identical sourceHash AND identical args, distinct fixtures)
    for (sh, _args_k), grp in sorted(by_src_args.items()):
        if len(grp) < 2:
            continue
        fixtures = {_canonical_fixture_key(r) for r in grp}
        if len(fixtures) < 2:
            continue
        # If subset is explicitly tagged causal-pair, tag that subset if >=2; otherwise tag the group
        cp_sub = [r for r in grp if "causal-pair" in _row_features(r)]
        target = cp_sub if len(cp_sub) >= 2 else grp
        fam = str(target[0].get("family") or sh[:10])
        pid = f"{prefix}:{fam}:{sh[:8]}"
        for r in target:
            r["pair_id"] = pid
            r.setdefault("metadata", {})["pair_id"] = pid

    # Pass 2: same sourceHash + causal-pair/causal-branch feature + distinct fixtures
    for sh, grp in sorted(by_src.items()):
        untagged = [r for r in grp if not r.get("pair_id")]
        if len(untagged) < 2:
            continue
        fixtures = {_canonical_fixture_key(r) for r in untagged}
        if len(fixtures) < 2:
            continue
        has_causal = any(
            ("causal-pair" in _row_features(r) or "causal-branch" in _row_features(r))
            for r in untagged
        )
        if not has_causal:
            continue
        fam = str(untagged[0].get("family") or sh[:10])
        pid = f"{prefix}:{fam}:{sh[:8]}"
        for r in untagged:
            r["pair_id"] = pid
            r.setdefault("metadata", {})["pair_id"] = pid

    pair_counts = Counter(r["pair_id"] for r in rows if r.get("pair_id"))
    return sum(1 for c in pair_counts.values() if c >= 2)


def _select_hairy_semantics(
    test_rows: list[dict[str, Any]],
    *,
    count: int = 40,
    seed: int = 17,
    exclude_ids: set[str],
) -> list[dict[str, Any]]:
    """Select strictly test-split hairy semantics tasks balanced across JS and Python."""
    rng = random.Random(seed + 211)
    hairy_tags = {
        "hairy-real",
        "exception",
        "finally",
        "mutation",
        "alias",
        "null-prototype",
        "closure",
        "regex",
        "parsing",
        "ast",
        "templating",
        "class",
        "recursion",
    }

    js_pool: list[tuple[int, str, dict[str, Any]]] = []
    py_pool: list[tuple[int, str, dict[str, Any]]] = []

    for row in test_rows:
        if row["id"] in exclude_ids:
            continue
        bucket = task_eval_bucket(row)
        if bucket in ("frontend", "multifile"):
            continue
        feats = _row_features(row)
        ops = _row_external_ops(row)
        # Prefer pure or semantics-heavy tasks (don't swallow the few rich IO tasks needed for effectful track)
        score = 0
        if "hairy-real" in feats:
            score += 10
        score += 2 * len(feats & hairy_tags)
        if not ops:
            score += 3
        if "real-oss" in feats:
            score += 1
        if score < 4:
            continue
        lang = _row_language(row)
        tie = digest([seed, row["id"]])
        entry = (score, tie, row)
        if lang == "py":
            py_pool.append(entry)
        else:
            js_pool.append(entry)

    def _pick_diverse(pool: list[tuple[int, str, dict[str, Any]]], target: int) -> list[dict[str, Any]]:
        pool.sort(key=lambda x: (-x[0], x[1]))
        chosen: list[dict[str, Any]] = []
        fam_counts: Counter = Counter()
        seen_src: set[str] = set()
        # Pass 1: unique sourceHash, max 1 per family
        for _score, _tie, row in pool:
            if len(chosen) >= target:
                break
            sh = row.get("sourceHash") or row["id"]
            fam = row.get("family") or row["id"]
            if sh in seen_src or fam_counts[fam] >= 1:
                continue
            chosen.append(row)
            seen_src.add(sh)
            fam_counts[fam] += 1
        # Pass 2: allow up to 2 per family if needed
        for _score, _tie, row in pool:
            if len(chosen) >= target:
                break
            if any(c["id"] == row["id"] for c in chosen):
                continue
            fam = row.get("family") or row["id"]
            if fam_counts[fam] >= 2:
                continue
            chosen.append(row)
            fam_counts[fam] += 1
        return chosen

    half = count // 2
    js_sel = _pick_diverse(js_pool, half)
    py_sel = _pick_diverse(py_pool, count - len(js_sel))
    selected = js_sel + py_sel
    if len(selected) < count:
        used = {r["id"] for r in selected}
        rem = [e for e in (js_pool + py_pool) if e[2]["id"] not in used]
        selected.extend(_pick_diverse(rem, count - len(selected)))
    rng.shuffle(selected)
    return selected[:count]


def _select_effectful_io_pairs(
    test_rows: list[dict[str, Any]],
    *,
    repo: Path,
    target_total: int = 36,
    min_causal_pairs: int = 8,
    seed: int = 17,
    exclude_ids: set[str],
    forbidden: dict[str, set[str]],
    bridge: Bridge | None = None,
) -> tuple[list[dict[str, Any]], int]:
    """Select strictly test-split effectful I/O tasks + unseen counterfactual pairs if < min_causal_pairs."""
    candidates: list[dict[str, Any]] = []
    for row in test_rows:
        if row["id"] in exclude_ids:
            continue
        bucket = task_eval_bucket(row)
        if bucket in ("frontend", "multifile"):
            continue
        ops = _row_external_ops(row)
        if not ops:
            continue
        candidates.append(row)

    # Check how many true counterfactual (same sourceHash + same args, diff fixture) pairs exist in test
    by_src_args: dict[tuple[str, str], list[dict[str, Any]]] = defaultdict(list)
    for row in candidates:
        by_src_args[(row.get("sourceHash") or "", _canonical_args_key(row))].append(row)
    existing_cf_groups = [
        grp for grp in by_src_args.values()
        if len(grp) >= 2 and len({_canonical_fixture_key(r) for r in grp}) >= 2
    ]

    selected: list[dict[str, Any]] = []
    used_ids: set[str] = set()

    # Add existing strict counterfactual pairs first (if any)
    for grp in existing_cf_groups:
        for r in grp[:2]:
            if r["id"] not in used_ids:
                selected.append(copy.deepcopy(r))
                used_ids.add(r["id"])

    # If fewer than min_causal_pairs exist in test, generate brand-new unseen counterfactual I/O pairs
    unseen_added = 0
    if len(existing_cf_groups) < min_causal_pairs:
        unseen_rows = export_unseen_counterfactual_io_pairs(repo, bridge=bridge)
        # Ensure zero leakage on generated pairs immediately
        audit_zero_leakage(unseen_rows, forbidden, raise_on_leak=True)
        for r in unseen_rows:
            if r["id"] not in used_ids:
                selected.append(r)
                used_ids.add(r["id"])
                unseen_added += 1

    # Prioritize diverse I/O operations across fs.*, env.get, http.request, shell.exec, platform.*, kv_*
    priority_ops = (
        "shell.exec",
        "env.get",
        "fs.readText",
        "fs.writeText",
        "fs.exists",
        "fs.listdir",
        "http.request",
        "http.get",
        "natlang.call",
        "platform.log",
        "platform.time",
        "platform.dateNow",
        "platform.random",
        "platform.print",
    )

    def _op_score(row: dict[str, Any]) -> tuple[int, int, str]:
        ops = set(_row_external_ops(row))
        feats = _row_features(row)
        rich_ops = len(ops - {"platform.print", "platform.random"})
        hard = int("hard-effectful" in feats or "effectful" in feats)
        return (rich_ops + hard * 2, len(ops), digest([seed, row["id"]]))

    # Prefer picking pairs sharing sourceHash with distinct fixtures from stage8 test split
    by_src: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in candidates:
        if row["id"] not in used_ids:
            by_src[row.get("sourceHash") or row["id"]].append(row)

    # First ensure every available priority op gets represented (round-robin across ops & languages)
    remaining_slots = max(0, target_total - len(selected))
    picked_fams: Counter = Counter(r.get("family") or r["id"] for r in selected)

    def _take_pair_or_single(group: list[dict[str, Any]], max_take: int) -> None:
        nonlocal remaining_slots
        if remaining_slots <= 0:
            return
        ordered = sorted(group, key=lambda r: digest([seed, r["id"]]))
        # Prefer 2 rows with distinct fixtures if available and room allows
        if max_take >= 2 and remaining_slots >= 2 and len(ordered) >= 2:
            first = ordered[0]
            f0 = _canonical_fixture_key(first)
            partner = next((r for r in ordered[1:] if _canonical_fixture_key(r) != f0), None)
            if partner is not None:
                for item in (first, partner):
                    cp = copy.deepcopy(item)
                    fam = str(cp.get("family") or cp.get("sourceHash", "")[:8])
                    pid = f"io-src-pair:{fam}:{str(cp.get('sourceHash', ''))[:8]}"
                    cp["pair_id"] = pid
                    cp.setdefault("metadata", {})["pair_id"] = pid
                    selected.append(cp)
                    used_ids.add(cp["id"])
                    picked_fams[fam] += 1
                    remaining_slots -= 1
                return
        item = copy.deepcopy(ordered[0])
        selected.append(item)
        used_ids.add(item["id"])
        picked_fams[str(item.get("family") or item["id"])] += 1
        remaining_slots -= 1

    # Round 1: cover each priority op across both Python and JS where present
    for op in priority_ops:
        if remaining_slots <= 0:
            break
        for want_lang in ("py", "js"):
            if remaining_slots <= 0:
                break
            matching_groups = [
                grp for sh, grp in by_src.items()
                if any(
                    r["id"] not in used_ids
                    and op in _row_external_ops(r)
                    and (_row_language(r) == "py") == (want_lang == "py")
                    for r in grp
                )
            ]
            if not matching_groups:
                continue
            matching_groups.sort(key=lambda g: (picked_fams[str(g[0].get("family") or "")], -_op_score(g[0])[0], _op_score(g[0])[2]))
            best_grp = [r for r in matching_groups[0] if r["id"] not in used_ids]
            _take_pair_or_single(best_grp, max_take=2)

    # Round 2: fill remaining slots with highest-scoring diverse effectful tasks
    rest_groups = [
        [r for r in grp if r["id"] not in used_ids]
        for grp in by_src.values()
    ]
    rest_groups = [g for g in rest_groups if g]
    rest_groups.sort(key=lambda g: (picked_fams[str(g[0].get("family") or "")], -_op_score(g[0])[0], -_op_score(g[0])[1], _op_score(g[0])[2]))
    for grp in rest_groups:
        if remaining_slots <= 0:
            break
        _take_pair_or_single(grp, max_take=2)

    _tag_causal_pairs(selected, prefix="effectful-pair")
    return selected[:target_total], unseen_added


def _select_whole_codebase_65k(
    test_rows: list[dict[str, Any]],
    *,
    count: int = 40,
    seed: int = 17,
    exclude_ids: set[str],
) -> list[dict[str, Any]]:
    """Select ALL available test-split non-frontend long-context-65k tasks + unseen test multi-file repos."""
    mf_pool = [
        r for r in test_rows
        if r["id"] not in exclude_ids and task_eval_bucket(r) == "multifile"
    ]
    lc65k = [
        r for r in mf_pool
        if "long-context-65k" in _row_features(r) or "lc65k" in str(r.get("id", ""))
    ]
    other_mf = [r for r in mf_pool if r not in lc65k]

    lc65k.sort(key=lambda r: r["id"])
    selected = [copy.deepcopy(r) for r in lc65k]
    used_ids = {r["id"] for r in selected}

    # Fill remaining slots up to `count` from other multi-file test repos, balancing JS/TS and Python across families
    need = max(0, count - len(selected))
    if need > 0 and other_mf:
        by_fam: dict[str, list[dict[str, Any]]] = defaultdict(list)
        for r in other_mf:
            if r["id"] not in used_ids:
                by_fam[str(r.get("family") or r["id"])].append(r)
        rng = random.Random(seed + 307)
        js_fams = sorted(f for f, grp in by_fam.items() if _row_language(grp[0]) != "py")
        py_fams = sorted(f for f, grp in by_fam.items() if _row_language(grp[0]) == "py")
        rng.shuffle(js_fams)
        rng.shuffle(py_fams)
        for grp in by_fam.values():
            grp.sort(key=lambda r: r["id"])
            rng.shuffle(grp)
        interleaved: list[str] = []
        for idx in range(max(len(js_fams), len(py_fams))):
            if idx < len(js_fams):
                interleaved.append(js_fams[idx])
            if idx < len(py_fams):
                interleaved.append(py_fams[idx])
        while len(selected) < count and any(by_fam[f] for f in interleaved):
            for fam in interleaved:
                if len(selected) >= count:
                    break
                if by_fam[fam]:
                    selected.append(copy.deepcopy(by_fam[fam].pop(0)))

    _tag_causal_pairs(selected, prefix="wc65k-pair")
    return selected[: max(count, len(lc65k))]


def _select_frontend_browser(
    test_rows: list[dict[str, Any]],
    *,
    count: int = 20,
    exclude_ids: set[str],
) -> list[dict[str, Any]]:
    """Select ALL strictly test-split frontend/browser tasks and tag counterfactual pairs."""
    fe = [
        copy.deepcopy(r)
        for r in test_rows
        if r["id"] not in exclude_ids and task_eval_bucket(r) == "frontend"
    ]
    fe.sort(key=lambda r: r["id"])
    _tag_causal_pairs(fe, prefix="fe-pair")
    return fe[: max(count, len(fe))]


def _finalize_track_rows(rows: list[dict[str, Any]], track: str) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for row in rows:
        item = copy.deepcopy(row)
        item["track"] = track
        item["split"] = "test"
        pair_id = item.get("pair_id") or (item.get("metadata") or {}).get("pair_id")
        item["pair_id"] = pair_id
        meta = item.setdefault("metadata", {})
        meta["track"] = track
        meta["pair_id"] = pair_id
        if not item.get("split_component"):
            item["split_component"] = digest(f"{item.get('family')}:{item.get('sourceHash')}")
        out.append(item)
    return out


def build_realexecbench_v1(
    *,
    reference_dataset: Path,
    output_dir: Path,
    repo: Path,
    cruxeval_count: int = 60,
    lcb_count: int = 60,
    hairy_count: int = 40,
    effectful_count: int = 36,
    whole_codebase_count: int = 40,
    frontend_count: int = 20,
    seed: int = 17,
    cache_dir: Path | str | None = DEFAULT_CACHE_DIR,
    refresh_external: bool = False,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Assemble and freeze RealExecBench v1 with strict zero-leakage verification."""
    ref_path = Path(reference_dataset).resolve()
    out_dir = Path(output_dir).resolve()
    ref_rows = read_jsonl(ref_path)
    forbidden = collect_forbidden_identities(ref_rows)
    test_rows = [r for r in ref_rows if r.get("split") == "test"]
    if not test_rows:
        raise ValueError(f"No split=='test' rows found in {ref_path}")

    used_ids: set[str] = set()

    # 1. Frontend-browser (all 20 test frontend tasks: single-file + lc65k-fe-*)
    fe_rows = _finalize_track_rows(
        _select_frontend_browser(test_rows, count=frontend_count, exclude_ids=used_ids),
        "frontend-browser",
    )
    used_ids.update(r["id"] for r in fe_rows)

    # 2. Whole-codebase-65k (all 32 non-frontend lc65k + 8 unseen test multi-file repos = 40)
    wc_rows = _finalize_track_rows(
        _select_whole_codebase_65k(test_rows, count=whole_codebase_count, seed=seed, exclude_ids=used_ids),
        "whole-codebase-65k",
    )
    used_ids.update(r["id"] for r in wc_rows)

    # 3. Effectful I/O pairs (unseen counterfactual pairs + diverse stage8 test effectful tasks)
    eff_raw, unseen_cf_count = _select_effectful_io_pairs(
        test_rows,
        repo=repo,
        target_total=effectful_count,
        min_causal_pairs=8,
        seed=seed,
        exclude_ids=used_ids,
        forbidden=forbidden,
    )
    eff_rows = _finalize_track_rows(eff_raw, "effectful-io-pairs")
    used_ids.update(r["id"] for r in eff_rows)

    # 4. Hairy semantics (40 strictly test-split hairy JS & Python tasks)
    hairy_rows = _finalize_track_rows(
        _select_hairy_semantics(test_rows, count=hairy_count, seed=seed, exclude_ids=used_ids),
        "hairy-semantics",
    )
    used_ids.update(r["id"] for r in hairy_rows)

    # 5. External anchor (60 CRUXEval-O + 60 LiveCodeBench-Exec = 120 verified tasks)
    ext_raw, ext_report = import_external_benchmarks(
        cruxeval_count=cruxeval_count,
        lcb_count=lcb_count,
        seed=seed,
        cache_dir=cache_dir,
        refresh=refresh_external,
        forbidden_hashes=forbidden["sourceHashes"] | {r["sourceHash"] for r in (fe_rows + wc_rows + eff_rows + hairy_rows)},
    )
    ext_rows = _finalize_track_rows(ext_raw, "external-anchor")

    all_rows = ext_rows + hairy_rows + eff_rows + wc_rows + fe_rows

    # Uniqueness check
    all_ids = [r["id"] for r in all_rows]
    if len(set(all_ids)) != len(all_ids):
        raise ValueError("Duplicate task IDs detected in assembled RealExecBench v1")

    # Strict Zero-Leakage Audit against ALL train & validation rows
    leakage_audit = audit_zero_leakage(all_rows, forbidden, raise_on_leak=True)

    # Write frozen artifacts
    benchmark_path = out_dir / "benchmark.jsonl"
    manifest_path = out_dir / "manifest.json"
    write_jsonl(benchmark_path, all_rows)

    track_stats: dict[str, Any] = {}
    for track in REALEXECBENCH_TRACKS:
        t_rows = [r for r in all_rows if r["track"] == track]
        lang_counts = dict(sorted(Counter(_row_language(r) for r in t_rows).items()))
        pair_groups = Counter(r["pair_id"] for r in t_rows if r.get("pair_id"))
        valid_pairs = {pid: cnt for pid, cnt in pair_groups.items() if cnt >= 2}
        ext_sub = Counter(
            (r.get("metadata") or {}).get("sourceBenchmark")
            for r in t_rows
            if (r.get("metadata") or {}).get("sourceBenchmark")
        )
        t_stat: dict[str, Any] = {
            "count": len(t_rows),
            "languages": lang_counts,
            "unique_families": len({r["family"] for r in t_rows}),
            "unique_source_hashes": len({r["sourceHash"] for r in t_rows}),
            "causal_pair_groups": len(valid_pairs),
            "causal_pair_tasks": sum(valid_pairs.values()),
            "pair_ids": sorted(valid_pairs.keys()),
        }
        if ext_sub:
            t_stat["sub_benchmarks"] = dict(sorted(ext_sub.items()))
        if track == "effectful-io-pairs":
            t_stat["unseen_counterfactual_tasks"] = unseen_cf_count
        track_stats[track] = t_stat

    manifest = {
        "schema": "realexecbench-manifest/1",
        "version": REALEXECBENCH_VERSION,
        "seed": seed,
        "total_tasks": len(all_rows),
        "benchmark_path": str(benchmark_path),
        "benchmark_sha256": _sha256_file(benchmark_path),
        "reference_dataset": str(ref_path),
        "reference_dataset_sha256": _sha256_file(ref_path),
        "tracks": track_stats,
        "external_import_report": ext_report,
        "zero_leakage_audit": leakage_audit,
        "task_ids_by_track": {
            track: [r["id"] for r in all_rows if r["track"] == track]
            for track in REALEXECBENCH_TRACKS
        },
    }
    atomic_json(manifest_path, manifest)
    return all_rows, manifest


# =============================================================================
# Multi-Model Evaluation, Summarization, Scoreboard & Paired Comparison
# =============================================================================


def _accepts_kwarg(fn: Any, name: str) -> bool:
    try:
        sig = inspect.signature(fn)
    except (TypeError, ValueError):
        return False
    return name in sig.parameters or any(
        p.kind == inspect.Parameter.VAR_KEYWORD for p in sig.parameters.values()
    )


def _extract_code_load_stats(grade: dict[str, Any], messages: list[dict[str, Any]]) -> tuple[int, int]:
    calls = grade.get("codeLoadCalls", grade.get("code_load_calls"))
    nbytes = grade.get("codeLoadBytes", grade.get("code_load_bytes"))
    msg_calls = 0
    msg_bytes = 0
    for msg in messages:
        if msg.get("role") == "tool" and msg.get("name") == "code.load":
            msg_calls += 1
            content = msg.get("content", "")
            if isinstance(content, str):
                msg_bytes += len(content.encode("utf-8"))
    final_calls = int(calls) if isinstance(calls, (int, float)) and not isinstance(calls, bool) and calls >= 0 else msg_calls
    final_bytes = int(nbytes) if isinstance(nbytes, (int, float)) and not isinstance(nbytes, bool) and nbytes >= 0 else msg_bytes
    if final_calls == 0 and msg_calls > 0:
        final_calls = msg_calls
    if final_bytes == 0 and msg_bytes > 0:
        final_bytes = msg_bytes
    return final_calls, final_bytes


def _execute_one_execution_mode(
    bridge: Any,
    adapter: Any,
    row: dict[str, Any],
    *,
    max_tokens: int,
    max_generated_tokens: int,
    max_turns: int,
    temperature: float,
    seed: int,
) -> dict[str, Any]:
    task = row["task"]
    t0 = time.monotonic()
    started = bridge.request("start", task=task)
    session_id = started["sessionId"]
    messages = copy.deepcopy(started["messages"])
    samples: list[dict[str, Any]] = []
    total_tokens = 0
    done = False
    forced_failure: str | None = None
    grade: dict[str, Any] = {}
    turns = 0

    try:
        for turn in range(max_turns):
            remaining = max_generated_tokens - total_tokens
            if remaining <= 0:
                forced_failure = "generated_token_budget_exhausted"
                break
            sample_kwargs: dict[str, Any] = {
                "max_tokens": min(max_tokens, remaining),
                "seed": (seed + turn) % 2147483647,
            }
            if _accepts_kwarg(adapter.sample, "temperature"):
                sample_kwargs["temperature"] = temperature
            if _accepts_kwarg(adapter.sample, "clamp_to_context"):
                sample_kwargs["clamp_to_context"] = True
            try:
                sample = adapter.sample(copy.deepcopy(messages), **sample_kwargs)
            except ContextOverflow:
                forced_failure = "context_budget_exhausted"
                break
            turns += 1
            token_ids = sample.get("token_ids")
            if not isinstance(token_ids, list):
                raise ValueError("adapter.sample must return integer token_ids list")
            samples.append(copy.deepcopy(sample))
            total_tokens += len(token_ids)
            if total_tokens > max_generated_tokens:
                forced_failure = "generated_token_budget_exceeded"
                break
            message = sample.get("message")
            if isinstance(message, dict) and message.get("role") == "assistant":
                messages.append(copy.deepcopy(message))
            if not sample.get("complete", True) or sample.get("stop_reason") in ("length", "max_tokens", "max_length"):
                is_trunc = sample.get("stop_reason") in ("length", "max_tokens", "max_length")
                forced_failure = (
                    sample.get("failure_reason")
                    or ("sampling_provenance_error" if sample.get("provenance_error") else None)
                    or ("truncated_sample" if is_trunc else None)
                    or ("sample_parse_error" if (sample.get("parse_error") or not sample.get("complete", True)) else None)
                    or "truncated_sample"
                )
                break
            if not isinstance(message, dict) or message.get("role") != "assistant":
                raise ValueError("adapter.sample must return an assistant message")
            text = sample.get("text")
            if text is None:
                text = visible_text(message)
            action = message if message.get("tool_calls") else text
            response = bridge.request("step", sessionId=session_id, action=action, generatedTokens=total_tokens)
            observations = response.get("messages") or []
            messages.extend(copy.deepcopy(observations))
            done = bool(response.get("done"))
            if done:
                grade = response.get("grade") or bridge.request(
                    "grade", sessionId=session_id, totalGeneratedTokens=total_tokens
                )
                break
        if not done and forced_failure is None:
            forced_failure = "turn_budget_exhausted"
        if not grade:
            grade = bridge.request("grade", sessionId=session_id, totalGeneratedTokens=total_tokens)
        grade = copy.deepcopy(grade)
        if forced_failure:
            grade.pop("failureCategory", None)
            grade.update(success=False, reason=forced_failure)
        grade["success"] = bool(done and grade.get("success") and not forced_failure)
        grade["generatedTokens"] = total_tokens
        code_load_calls, code_load_bytes = _extract_code_load_stats(grade, messages)
        wall = time.monotonic() - t0
        rec = {
            "task_id": row["id"],
            "family": row["family"],
            "source_hash": row["sourceHash"],
            "task_hash": digest(row["task"]),
            "split_component": row.get("split_component") or row["family"],
            "seed": seed,
            "repeat": 0,
            "track": row.get("track") or (row.get("metadata") or {}).get("track") or "unknown",
            "pair_id": row.get("pair_id") or (row.get("metadata") or {}).get("pair_id"),
            "language": _row_language(row),
            "source_benchmark": (row.get("metadata") or {}).get("sourceBenchmark"),
            "prompt_mode": "execution",
            "success": bool(grade["success"]),
            "complete": bool(done and not forced_failure and grade.get("complete", True)),
            "generated_tokens": total_tokens,
            "turns": turns,
            "code_load_calls": code_load_calls,
            "code_load_bytes": code_load_bytes,
            "external_calls": int(grade.get("externalCalls") or 0),
            "wall_clock_seconds": round(wall, 4),
            "grade": grade,
        }
        rec["failure_category"] = metrics_failure_category(rec)
        return rec
    except Exception as exc:
        wall = time.monotonic() - t0
        partial = {
            "task_id": row["id"],
            "family": row["family"],
            "source_hash": row["sourceHash"],
            "task_hash": digest(row["task"]),
            "split_component": row.get("split_component") or row["family"],
            "seed": seed,
            "repeat": 0,
            "track": row.get("track") or (row.get("metadata") or {}).get("track") or "unknown",
            "pair_id": row.get("pair_id") or (row.get("metadata") or {}).get("pair_id"),
            "language": _row_language(row),
            "source_benchmark": (row.get("metadata") or {}).get("sourceBenchmark"),
            "prompt_mode": "execution",
            "success": False,
            "complete": False,
            "generated_tokens": total_tokens,
            "turns": turns,
            "code_load_calls": 0,
            "code_load_bytes": 0,
            "external_calls": 0,
            "wall_clock_seconds": round(wall, 4),
            "grade": None,
            "infrastructure_error": {"type": type(exc).__name__, "message": str(exc)},
        }
        raise RolloutError(f"execution rollout failed on {row['id']}: {exc}", partial) from exc
    finally:
        try:
            bridge.request("close", sessionId=session_id)
        except Exception:
            pass


def _execute_one_zero_shot_mode(
    adapter: Any,
    row: dict[str, Any],
    *,
    max_tokens: int,
    temperature: float,
    seed: int,
) -> dict[str, Any]:
    meta = row.get("metadata") or {}
    ext = meta.get("external_benchmark") or ((row.get("task") or {}).get("metadata") or {}).get("external_benchmark")
    if not isinstance(ext, dict) or not isinstance(ext.get("expected_output"), str):
        raise ValueError(f"Task {row['id']} has no external_benchmark.expected_output for zero-shot mode")

    messages = build_zero_shot_messages(row)
    t0 = time.monotonic()
    sample_kwargs: dict[str, Any] = {
        "max_tokens": max_tokens,
        "seed": seed,
    }
    if _accepts_kwarg(adapter.sample, "temperature"):
        sample_kwargs["temperature"] = temperature
    if _accepts_kwarg(adapter.sample, "clamp_to_context"):
        sample_kwargs["clamp_to_context"] = True

    try:
        sample = adapter.sample(copy.deepcopy(messages), **sample_kwargs)
    except ContextOverflow:
        wall = time.monotonic() - t0
        grade = {
            "success": False,
            "reward": 0.0,
            "reason": "context_budget_exhausted",
            "failureCategory": "truncation",
            "generatedTokens": 0,
            "complete": False,
        }
        rec = {
            "task_id": row["id"],
            "family": row["family"],
            "source_hash": row["sourceHash"],
            "task_hash": digest(row["task"]),
            "split_component": row.get("split_component") or row["family"],
            "seed": seed,
            "repeat": 0,
            "track": row.get("track") or meta.get("track") or "external-anchor",
            "pair_id": row.get("pair_id") or meta.get("pair_id"),
            "language": _row_language(row),
            "source_benchmark": meta.get("sourceBenchmark") or ext.get("benchmark"),
            "prompt_mode": "zero-shot",
            "success": False,
            "complete": False,
            "generated_tokens": 0,
            "turns": 0,
            "code_load_calls": 0,
            "code_load_bytes": 0,
            "external_calls": 0,
            "wall_clock_seconds": round(wall, 4),
            "grade": grade,
            "failure_category": "truncation",
        }
        return rec
    except Exception as exc:
        wall = time.monotonic() - t0
        partial = {
            "task_id": row["id"],
            "family": row["family"],
            "source_hash": row["sourceHash"],
            "task_hash": digest(row["task"]),
            "split_component": row.get("split_component") or row["family"],
            "seed": seed,
            "repeat": 0,
            "track": row.get("track") or meta.get("track") or "external-anchor",
            "pair_id": row.get("pair_id") or meta.get("pair_id"),
            "language": _row_language(row),
            "source_benchmark": meta.get("sourceBenchmark") or ext.get("benchmark"),
            "prompt_mode": "zero-shot",
            "success": False,
            "complete": False,
            "generated_tokens": 0,
            "turns": 0,
            "code_load_calls": 0,
            "code_load_bytes": 0,
            "external_calls": 0,
            "wall_clock_seconds": round(wall, 4),
            "grade": None,
            "infrastructure_error": {"type": type(exc).__name__, "message": str(exc)},
        }
        raise RolloutError(f"zero-shot rollout failed on {row['id']}: {exc}", partial) from exc

    wall = time.monotonic() - t0
    token_ids = sample.get("token_ids") or []
    total_tokens = len(token_ids)
    message = sample.get("message") or {}
    text = sample.get("text")
    if text is None and isinstance(message, dict):
        text = visible_text(message)
    text = text or ""

    is_trunc = sample.get("stop_reason") in ("length", "max_tokens", "max_length") or not sample.get("complete", True)
    if is_trunc and not text.strip():
        grade = {
            "success": False,
            "reward": 0.0,
            "reason": "truncated_sample",
            "failureCategory": "truncation",
            "generatedTokens": total_tokens,
            "complete": False,
        }
    else:
        zs_grade = grade_zero_shot_response(text, ext["expected_output"])
        grade = {
            "success": bool(zs_grade["success"]),
            "reward": 1.0 if zs_grade["success"] else 0.0,
            "reason": zs_grade["reason"],
            "failureCategory": zs_grade["failureCategory"],
            "extracted": zs_grade["extracted"],
            "parsed_ok": zs_grade["parsed_ok"],
            "generatedTokens": total_tokens,
            "complete": not is_trunc,
        }

    rec = {
        "task_id": row["id"],
        "family": row["family"],
        "source_hash": row["sourceHash"],
        "task_hash": digest(row["task"]),
        "split_component": row.get("split_component") or row["family"],
        "seed": seed,
        "repeat": 0,
        "track": row.get("track") or meta.get("track") or "external-anchor",
        "pair_id": row.get("pair_id") or meta.get("pair_id"),
        "language": _row_language(row),
        "source_benchmark": meta.get("sourceBenchmark") or ext.get("benchmark"),
        "prompt_mode": "zero-shot",
        "success": bool(grade["success"]),
        "complete": bool(grade.get("complete", True)),
        "generated_tokens": total_tokens,
        "turns": 1,
        "code_load_calls": 0,
        "code_load_bytes": 0,
        "external_calls": 0,
        "wall_clock_seconds": round(wall, 4),
        "grade": grade,
    }
    rec["failure_category"] = metrics_failure_category(rec)
    return rec


def _summarize_slice(records: list[dict[str, Any]]) -> dict[str, Any]:
    n = len(records)
    successes = [r for r in records if bool(r.get("success"))]
    tokens = [int(r.get("generated_tokens") or 0) for r in records]
    turns = [int(r.get("turns") or 0) for r in records]
    cl_calls = [int(r.get("code_load_calls") or 0) for r in records]
    cl_bytes = [int(r.get("code_load_bytes") or 0) for r in records]
    walls = [float(r.get("wall_clock_seconds") or 0.0) for r in records]
    total_tokens = sum(tokens)

    # Strict causal pair accuracy: every task sharing a pair_id (with >=2 tasks) must pass.
    pair_groups: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for r in records:
        pid = r.get("pair_id")
        if isinstance(pid, str) and pid:
            pair_groups[pid].append(r)
    valid_pairs = {pid: grp for pid, grp in pair_groups.items() if len(grp) >= 2}
    pairs_passed = sum(1 for grp in valid_pairs.values() if all(bool(r.get("success")) for r in grp))
    pairs_total = len(valid_pairs)

    failures = Counter(
        str(r.get("failure_category") or metrics_failure_category(r))
        for r in records
        if not bool(r.get("success"))
    )

    return {
        "executions": n,
        "successes": len(successes),
        "task_accuracy": (len(successes) / n) if n else None,
        "causal_pairs_total": pairs_total,
        "causal_pairs_passed": pairs_passed,
        "causal_pair_accuracy": (pairs_passed / pairs_total) if pairs_total else None,
        "total_generated_tokens": total_tokens,
        "mean_generated_tokens": statistics.fmean(tokens) if tokens else None,
        "median_generated_tokens": statistics.median(tokens) if tokens else None,
        "p95_generated_tokens": quantile([float(t) for t in tokens], 0.95) if tokens else None,
        "tokens_per_verified_success": (total_tokens / len(successes)) if successes else None,
        "mean_turns": statistics.fmean(turns) if turns else None,
        "mean_code_load_calls": statistics.fmean(cl_calls) if cl_calls else None,
        "mean_code_load_bytes": statistics.fmean(cl_bytes) if cl_bytes else None,
        "mean_wall_clock_seconds": statistics.fmean(walls) if walls else None,
        "failure_categories": dict(sorted(failures.items())),
        "independent_components": len({r.get("split_component") or r.get("family") or r.get("task_id") for r in records}),
    }


def summarize_realexecbench_records(
    records: list[dict[str, Any]],
    *,
    meta: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Compute overall, per-track, and per-external-sub-benchmark RealExecBench metrics."""
    overall = _summarize_slice(records)
    by_track_raw: dict[str, list[dict[str, Any]]] = defaultdict(list)
    by_sub_raw: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for r in records:
        by_track_raw[str(r.get("track") or "unknown")].append(r)
        sb = r.get("source_benchmark")
        if isinstance(sb, str) and sb:
            by_sub_raw[sb].append(r)

    ordered_tracks = [t for t in REALEXECBENCH_TRACKS if t in by_track_raw] + sorted(
        t for t in by_track_raw if t not in REALEXECBENCH_TRACKS
    )
    by_track = {t: _summarize_slice(by_track_raw[t]) for t in ordered_tracks}
    by_sub = {sb: _summarize_slice(by_sub_raw[sb]) for sb in sorted(by_sub_raw)}

    return {
        "schema": "realexecbench-summary/1",
        "meta": copy.deepcopy(meta or {}),
        "overall": overall,
        "by_track": by_track,
        "by_external_benchmark": by_sub,
    }


def _fmt_pct(val: float | None) -> str:
    return f"{val * 100:.1f}%" if val is not None else "—"


def _fmt_num(val: float | None, decimals: int = 0) -> str:
    if val is None:
        return "—"
    return f"{val:,.{decimals}f}"


def render_scoreboard_markdown(summary: dict[str, Any]) -> str:
    """Render a crisp single-run Markdown scoreboard from a RealExecBench summary."""
    meta = summary.get("meta") or {}
    overall = summary["overall"]
    lines: list[str] = []
    title = meta.get("label") or meta.get("model") or "RealExecBench v1 Evaluation"
    lines.append(f"# RealExecBench v1 Scoreboard — {title}")
    lines.append("")
    if meta:
        lines.append(f"- **Model**: `{meta.get('model', 'unknown')}`")
        if meta.get("checkpoint"):
            lines.append(f"- **Checkpoint**: `{meta['checkpoint']}`")
        lines.append(f"- **Prompt Mode**: `{meta.get('prompt_mode', 'execution')}`")
        if meta.get("effort") is not None:
            lines.append(f"- **Effort**: `{meta['effort']}` | **Temperature**: `{meta.get('temperature', 1.0)}`")
        if meta.get("benchmark"):
            lines.append(f"- **Benchmark**: `{meta['benchmark']}`")
        lines.append("")

    lines.append("## Per-Track & Overall Metrics")
    lines.append("")
    lines.append(
        "| Track | Tasks | Task Acc | Causal Pair Acc | Mean Tok | Median Tok | Tok / Success | Mean Turns | Mean `code.load` | Mean Latency (s) |"
    )
    lines.append("|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|")

    def _row(name: str, s: dict[str, Any]) -> str:
        pair_str = (
            f"{_fmt_pct(s['causal_pair_accuracy'])} ({s['causal_pairs_passed']}/{s['causal_pairs_total']})"
            if s["causal_pairs_total"] > 0
            else "—"
        )
        return (
            f"| {name} | {s['successes']}/{s['executions']} | {_fmt_pct(s['task_accuracy'])} | "
            f"{pair_str} | {_fmt_num(s['mean_generated_tokens'])} | {_fmt_num(s['median_generated_tokens'])} | "
            f"{_fmt_num(s['tokens_per_verified_success'])} | {_fmt_num(s['mean_turns'], 2)} | "
            f"{_fmt_num(s['mean_code_load_calls'], 2)} | {_fmt_num(s['mean_wall_clock_seconds'], 2)} |"
        )

    for track, stats in (summary.get("by_track") or {}).items():
        lines.append(_row(f"`{track}`", stats))
    lines.append(_row("**OVERALL**", overall))
    lines.append("")

    by_sub = summary.get("by_external_benchmark") or {}
    if by_sub:
        lines.append("## External Anchor Breakdown")
        lines.append("")
        lines.append("| External Benchmark | Tasks | Task Acc | Mean Tok | Median Tok | Tok / Success | Mean Latency (s) |")
        lines.append("|---|---:|---:|---:|---:|---:|---:|")
        for name, stats in by_sub.items():
            lines.append(
                f"| `{name}` | {stats['successes']}/{stats['executions']} | {_fmt_pct(stats['task_accuracy'])} | "
                f"{_fmt_num(stats['mean_generated_tokens'])} | {_fmt_num(stats['median_generated_tokens'])} | "
                f"{_fmt_num(stats['tokens_per_verified_success'])} | {_fmt_num(stats['mean_wall_clock_seconds'], 2)} |"
            )
        lines.append("")

    lines.append("## Failure Category Breakdown (Overall)")
    lines.append("")
    fails = overall.get("failure_categories") or {}
    if fails:
        lines.append("| Failure Category | Count |")
        lines.append("|---|---:|")
        for cat, cnt in sorted(fails.items(), key=lambda kv: (-kv[1], kv[0])):
            lines.append(f"| `{cat}` | {cnt} |")
    else:
        lines.append("_No failures recorded._")
    lines.append("")
    return "\n".join(lines)


def evaluate_realexecbench(
    *,
    benchmark_path: Path,
    output_dir: Path,
    model: str,
    adapter: Any | None = None,
    bridge: Any | None = None,
    repo: Path | None = None,
    checkpoint: str | None = None,
    tracks: list[str] | None = None,
    prompt_mode: str = "execution",
    concurrency: int = 16,
    max_tokens: int = 20480,
    max_generated_tokens: int = 49152,
    max_turns: int = 48,
    max_context_tokens: int = 65536,
    effort: float = 0.5,
    temperature: float = 1.0,
    seed: int = 17,
    bridge_timeout_seconds: float = 120.0,
    resume: bool = False,
    limit: int | None = None,
    label: str | None = None,
) -> dict[str, Any]:
    """Run RealExecBench v1 evaluation with fault tolerance and incremental JSONL resume."""
    if prompt_mode not in ("execution", "zero-shot"):
        raise ValueError("prompt_mode must be 'execution' or 'zero-shot'")

    bench_path = Path(benchmark_path).resolve()
    out_dir = Path(output_dir).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    repo_root = Path(repo).resolve() if repo is not None else Path(__file__).resolve().parents[2]

    all_rows = read_jsonl(bench_path)
    if tracks:
        track_set = set(tracks)
        selected = [r for r in all_rows if (r.get("track") or (r.get("metadata") or {}).get("track")) in track_set]
    else:
        selected = list(all_rows)

    if prompt_mode == "zero-shot":
        zs_capable = [
            r for r in selected
            if isinstance((r.get("metadata") or {}).get("external_benchmark"), dict)
            or isinstance(((r.get("task") or {}).get("metadata") or {}).get("external_benchmark"), dict)
        ]
        if not zs_capable:
            raise ValueError("No external-anchor tasks with zero-shot ground truth matched the selected tracks")
        if len(zs_capable) < len(selected):
            print(
                f"info: zero-shot mode filtering {len(selected)} -> {len(zs_capable)} external-anchor tasks",
                file=sys.stderr,
                flush=True,
            )
        selected = zs_capable

    if limit is not None and limit > 0:
        selected = selected[:limit]

    if not selected:
        raise ValueError("No benchmark tasks selected for evaluation")

    bench_sha = _sha256_file(bench_path)
    run_identity = {
        "model": model,
        "checkpoint": checkpoint,
        "prompt_mode": prompt_mode,
        "benchmark_sha256": bench_sha,
        "tracks": sorted({str(r.get("track") or "unknown") for r in selected}),
        "seed": seed,
    }
    config_path = out_dir / "run_config.json"
    results_path = out_dir / "results.jsonl"
    infra_err_path = out_dir / "infrastructure-errors.jsonl"

    records: list[dict[str, Any]] = []
    completed_ids: set[str] = set()
    if resume and results_path.exists():
        if config_path.exists():
            saved_cfg = json.loads(config_path.read_text(encoding="utf-8"))
            for key in ("model", "checkpoint", "prompt_mode", "benchmark_sha256"):
                if saved_cfg.get(key) != run_identity.get(key):
                    raise ValueError(
                        f"Cannot --resume in {out_dir}: saved {key}={saved_cfg.get(key)!r} != {run_identity.get(key)!r}"
                    )
        expected_ids = {r["id"] for r in selected}
        for rec in read_jsonl(results_path):
            tid = rec.get("task_id")
            if tid in expected_ids and tid not in completed_ids:
                records.append(rec)
                completed_ids.add(tid)
        print(f"resume: loaded {len(records)}/{len(selected)} completed results from {results_path}", file=sys.stderr, flush=True)
    elif results_path.exists() and not resume:
        # Fresh run overwrites previous results cleanly
        results_path.unlink()

    run_meta = {
        **run_identity,
        "label": label or (f"{model} @ {checkpoint}" if checkpoint else model),
        "benchmark": str(bench_path),
        "effort": effort,
        "temperature": temperature,
        "max_tokens": max_tokens,
        "max_generated_tokens": max_generated_tokens,
        "max_turns": max_turns,
        "max_context_tokens": max_context_tokens,
        "concurrency": concurrency,
        "total_selected": len(selected),
    }
    atomic_json(config_path, run_meta)

    pending = [r for r in selected if r["id"] not in completed_ids]

    owns_bridge = False
    active_bridge = bridge
    active_adapter = adapter
    if active_adapter is None and pending:
        active_adapter = TinkerAdapter({
            "model": model,
            "effort": effort,
            "max_context_tokens": max_context_tokens,
            "max_tokens": max_tokens,
            "temperature": temperature,
            "seed": seed,
        })
        active_adapter.create_sampling_client(checkpoint=checkpoint)

    if prompt_mode == "execution" and active_bridge is None and pending:
        active_bridge = Bridge(repo_root, timeout=bridge_timeout_seconds)
        owns_bridge = True

    write_lock = threading.Lock()
    done_count = len(records)
    ok_count = sum(1 for r in records if r.get("success"))
    tok_sum = sum(int(r.get("generated_tokens") or 0) for r in records)
    started_at = time.monotonic()

    def _make_infra_record(row: dict[str, Any], err: Exception, partial: dict[str, Any] | None = None) -> dict[str, Any]:
        base = copy.deepcopy(partial) if isinstance(partial, dict) else {}
        gen_toks = int(base.get("generated_tokens") or 0)
        base.update({
            "task_id": row["id"],
            "family": row["family"],
            "source_hash": row["sourceHash"],
            "task_hash": digest(row["task"]),
            "split_component": row.get("split_component") or row["family"],
            "seed": int(digest([seed, row["id"], 0])[:8], 16) % 2147483647,
            "repeat": 0,
            "track": row.get("track") or (row.get("metadata") or {}).get("track") or "unknown",
            "pair_id": row.get("pair_id") or (row.get("metadata") or {}).get("pair_id"),
            "language": _row_language(row),
            "source_benchmark": (row.get("metadata") or {}).get("sourceBenchmark"),
            "prompt_mode": prompt_mode,
            "model": model,
            "checkpoint": checkpoint,
            "success": False,
            "complete": False,
            "generated_tokens": gen_toks,
            "turns": int(base.get("turns") or 0),
            "code_load_calls": int(base.get("code_load_calls") or 0),
            "code_load_bytes": int(base.get("code_load_bytes") or 0),
            "external_calls": int(base.get("external_calls") or 0),
            "wall_clock_seconds": float(base.get("wall_clock_seconds") or 0.0),
            "failure_category": "infrastructure_error",
            "infrastructure_error": {"type": type(err).__name__, "message": str(err)},
            "grade": {
                "success": False,
                "reward": 0.0,
                "reason": "infrastructure_error",
                "failureCategory": "infrastructure_error",
                "generatedTokens": gen_toks,
                "complete": False,
            },
        })
        return base

    def _run_one(row: dict[str, Any]) -> dict[str, Any]:
        task_seed = int(digest([seed, row["id"], 0])[:8], 16) % 2147483647
        try:
            if prompt_mode == "zero-shot":
                rec = _execute_one_zero_shot_mode(
                    active_adapter,
                    row,
                    max_tokens=max_tokens,
                    temperature=temperature,
                    seed=task_seed,
                )
            else:
                rec = _execute_one_execution_mode(
                    active_bridge,
                    active_adapter,
                    row,
                    max_tokens=max_tokens,
                    max_generated_tokens=max_generated_tokens,
                    max_turns=max_turns,
                    temperature=temperature,
                    seed=task_seed,
                )
            rec["model"] = model
            rec["checkpoint"] = checkpoint
            return rec
        except RolloutError as err:
            rec = _make_infra_record(row, err, err.record)
            with write_lock:
                append_jsonl(infra_err_path, {
                    "task_id": row["id"],
                    "model": model,
                    "checkpoint": checkpoint,
                    "prompt_mode": prompt_mode,
                    "error": str(err),
                    "partial": err.record,
                })
            return rec
        except Exception as err:
            rec = _make_infra_record(row, err)
            with write_lock:
                append_jsonl(infra_err_path, {
                    "task_id": row["id"],
                    "model": model,
                    "checkpoint": checkpoint,
                    "prompt_mode": prompt_mode,
                    "error": f"{type(err).__name__}: {err}",
                })
            return rec

    def _commit(rec: dict[str, Any]) -> None:
        nonlocal done_count, ok_count, tok_sum
        with write_lock:
            records.append(rec)
            append_jsonl(results_path, rec)
            done_count += 1
            ok_count += int(bool(rec.get("success")))
            tok_sum += int(rec.get("generated_tokens") or 0)
            print(
                f"[{done_count}/{len(selected)}] {rec['track']}/{rec['task_id']}: "
                f"ok={rec['success']} tok={rec['generated_tokens']} turns={rec['turns']} "
                f"t={rec['wall_clock_seconds']:.1f}s (acc={ok_count / done_count:.1%}, mean_tok={tok_sum / done_count:.0f})",
                file=sys.stderr,
                flush=True,
            )

    try:
        workers = max(1, int(concurrency))
        if workers == 1 or len(pending) <= 1:
            for row in pending:
                _commit(_run_one(row))
        else:
            with concurrent.futures.ThreadPoolExecutor(max_workers=min(workers, len(pending))) as pool:
                futs = [pool.submit(_run_one, row) for row in pending]
                for fut in concurrent.futures.as_completed(futs):
                    _commit(fut.result())
    finally:
        if owns_bridge and active_bridge is not None:
            active_bridge.close()

    # Order results deterministically to match benchmark order
    order_idx = {r["id"]: idx for idx, r in enumerate(selected)}
    records.sort(key=lambda rec: order_idx.get(rec["task_id"], 10**9))
    write_jsonl(results_path, records)

    run_meta["elapsed_wall_clock_seconds"] = round(time.monotonic() - started_at, 3)
    summary = summarize_realexecbench_records(records, meta=run_meta)
    atomic_json(out_dir / "summary.json", summary)
    scoreboard_md = render_scoreboard_markdown(summary)
    (out_dir / "scoreboard.md").write_text(scoreboard_md, encoding="utf-8")
    return summary


def _paired_slice(
    base_records: list[dict[str, Any]],
    cand_records: list[dict[str, Any]],
    *,
    bootstrap_samples: int = 1000,
    seed: int = 17,
) -> dict[str, Any] | None:
    base_by_id = {r["task_id"]: r for r in base_records}
    cand_by_id = {r["task_id"]: r for r in cand_records}
    common = sorted(set(base_by_id) & set(cand_by_id))
    if not common:
        return None
    before_list: list[dict[str, Any]] = []
    after_list: list[dict[str, Any]] = []
    seed_mismatch = False
    for tid in common:
        b = copy.deepcopy(base_by_id[tid])
        c = copy.deepcopy(cand_by_id[tid])
        if b.get("seed") != c.get("seed"):
            seed_mismatch = True
            c["seed"] = b.get("seed")
        # Ensure grade dict exists for paired_statistics
        if not isinstance(b.get("grade"), dict):
            b["grade"] = {"success": bool(b.get("success"))}
        if not isinstance(c.get("grade"), dict):
            c["grade"] = {"success": bool(c.get("success"))}
        before_list.append(b)
        after_list.append(c)

    stats = paired_statistics(
        before_list,
        after_list,
        {"seed": seed, "bootstrap_samples": bootstrap_samples, "confidence_level": 0.95},
    )
    intervals = (stats.get("uncertainty") or {}).get("intervals") or {}
    return {
        "matched_tasks": stats["matched_executions"],
        "independent_components": (stats.get("uncertainty") or {}).get("independent_components", 0),
        "seed_mismatch_normalized": seed_mismatch,
        "accuracy_change": stats["accuracy_change"],
        "accuracy_change_ci95": intervals.get("accuracy_change"),
        "tokens_per_verified_success_saving": stats["tokens_per_verified_success_saving"],
        "tokens_per_verified_success_saving_ci95": intervals.get("tokens_per_verified_success_saving"),
        "mean_token_change": stats["mean_token_change"],
        "token_saving_fraction": stats["token_saving_fraction"],
    }


def compare_realexecbench_runs(
    run_dirs: list[Path | str],
    *,
    baseline_index: int = 0,
    bootstrap_samples: int = 1000,
    seed: int = 17,
) -> tuple[dict[str, Any], str]:
    """Compare multiple RealExecBench run directories with paired bootstrap 95% CIs vs baseline."""
    if len(run_dirs) < 2:
        raise ValueError("compare requires at least 2 run directories")

    runs: list[dict[str, Any]] = []
    for raw_dir in run_dirs:
        d = Path(raw_dir).resolve()
        sum_path = d / "summary.json"
        res_path = d / "results.jsonl"
        if not res_path.is_file():
            raise FileNotFoundError(f"Missing results.jsonl in {d}")
        records = read_jsonl(res_path)
        if sum_path.is_file():
            summary = json.loads(sum_path.read_text(encoding="utf-8"))
        else:
            summary = summarize_realexecbench_records(records, meta={"label": d.name})
        meta = summary.get("meta") or {}
        label = str(meta.get("label") or meta.get("model") or d.name)
        runs.append({"dir": str(d), "name": d.name, "label": label, "summary": summary, "records": records})

    if not 0 <= baseline_index < len(runs):
        raise ValueError(f"baseline_index {baseline_index} out of range for {len(runs)} runs")
    baseline = runs[baseline_index]

    paired_vs_baseline: dict[str, dict[str, Any]] = {}
    for idx, run in enumerate(runs):
        if idx == baseline_index:
            continue
        overall_paired = _paired_slice(
            baseline["records"], run["records"], bootstrap_samples=bootstrap_samples, seed=seed
        )
        per_track_paired: dict[str, Any] = {}
        for track in REALEXECBENCH_TRACKS:
            b_sub = [r for r in baseline["records"] if r.get("track") == track]
            c_sub = [r for r in run["records"] if r.get("track") == track]
            if b_sub and c_sub:
                ps = _paired_slice(b_sub, c_sub, bootstrap_samples=bootstrap_samples, seed=seed)
                if ps is not None:
                    per_track_paired[track] = ps
        paired_vs_baseline[run["label"]] = {
            "overall": overall_paired,
            "by_track": per_track_paired,
        }

    # Render crisp side-by-side Markdown leaderboard
    lines: list[str] = []
    lines.append("# RealExecBench v1 Multi-Model Leaderboard")
    lines.append("")
    lines.append(f"- **Baseline**: `{baseline['label']}` (`{baseline['name']}`)")
    lines.append(f"- **Bootstrap**: 95% family-clustered paired percentile CI ({bootstrap_samples} resamples)")
    lines.append("")

    lines.append("## Overall Comparison")
    lines.append("")
    lines.append(
        "| Run | Mode | Tasks | Task Acc | Causal Pair Acc | Mean Tok | Median Tok | Tok / Success | Mean Turns | Mean `code.load` | Latency (s) |"
    )
    lines.append("|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|")
    for run in runs:
        ov = run["summary"]["overall"]
        mode = (run["summary"].get("meta") or {}).get("prompt_mode", "execution")
        pair_str = (
            f"{_fmt_pct(ov['causal_pair_accuracy'])} ({ov['causal_pairs_passed']}/{ov['causal_pairs_total']})"
            if ov.get("causal_pairs_total", 0) > 0
            else "—"
        )
        lines.append(
            f"| **{run['label']}** | `{mode}` | {ov['successes']}/{ov['executions']} | "
            f"{_fmt_pct(ov['task_accuracy'])} | {pair_str} | "
            f"{_fmt_num(ov['mean_generated_tokens'])} | {_fmt_num(ov['median_generated_tokens'])} | "
            f"{_fmt_num(ov['tokens_per_verified_success'])} | {_fmt_num(ov['mean_turns'], 2)} | "
            f"{_fmt_num(ov['mean_code_load_calls'], 2)} | {_fmt_num(ov['mean_wall_clock_seconds'], 2)} |"
        )
    lines.append("")

    # Per-track side-by-side accuracy matrix
    present_tracks = [
        t for t in REALEXECBENCH_TRACKS
        if any(t in (r["summary"].get("by_track") or {}) for r in runs)
    ]
    if present_tracks:
        lines.append("## Per-Track Task Accuracy & Tokens/Success")
        lines.append("")
        header = "| Track | " + " | ".join(r["label"] for r in runs) + " |"
        sep = "|---|" + "|".join("---:" for _ in runs) + "|"
        lines.append(header)
        lines.append(sep)
        for track in present_tracks:
            cells: list[str] = []
            for r in runs:
                st = (r["summary"].get("by_track") or {}).get(track)
                if not st:
                    cells.append("—")
                else:
                    cells.append(f"{_fmt_pct(st['task_accuracy'])} ({_fmt_num(st['tokens_per_verified_success'])} tok/ok)")
            lines.append(f"| `{track}` | " + " | ".join(cells) + " |")
        lines.append("")

    # Paired bootstrap deltas vs baseline
    lines.append(f"## Paired Bootstrap 95% CIs vs `{baseline['label']}`")
    lines.append("")
    lines.append("| Candidate Run | Scope | Matched (Families) | Acc Delta (95% CI) | Tok/Success Saving (95% CI) |")
    lines.append("|---|---|---:|---:|---:|")

    def _fmt_delta_pp(val: float | None, ci: dict[str, Any] | None) -> str:
        if val is None:
            return "—"
        base = f"{val * 100:+.1f} pp"
        if ci and ci.get("low") is not None and ci.get("high") is not None:
            return f"{base} [{ci['low'] * 100:+.1f}, {ci['high'] * 100:+.1f}]"
        return base

    def _fmt_saving(val: float | None, ci: dict[str, Any] | None) -> str:
        if val is None:
            return "—"
        base = f"{val * 100:+.1f}%"
        if ci and ci.get("low") is not None and ci.get("high") is not None:
            return f"{base} [{ci['low'] * 100:+.1f}%, {ci['high'] * 100:+.1f}%]"
        return base

    for cand_label, pdata in paired_vs_baseline.items():
        ov = pdata.get("overall")
        if ov:
            lines.append(
                f"| **{cand_label}** | **OVERALL** | {ov['matched_tasks']} ({ov['independent_components']}) | "
                f"{_fmt_delta_pp(ov['accuracy_change'], ov['accuracy_change_ci95'])} | "
                f"{_fmt_saving(ov['tokens_per_verified_success_saving'], ov['tokens_per_verified_success_saving_ci95'])} |"
            )
        for track, pst in (pdata.get("by_track") or {}).items():
            lines.append(
                f"| {cand_label} | `{track}` | {pst['matched_tasks']} ({pst['independent_components']}) | "
                f"{_fmt_delta_pp(pst['accuracy_change'], pst['accuracy_change_ci95'])} | "
                f"{_fmt_saving(pst['tokens_per_verified_success_saving'], pst['tokens_per_verified_success_saving_ci95'])} |"
            )
    lines.append("")

    report = {
        "schema": "realexecbench-compare/1",
        "baseline": baseline["label"],
        "runs": [
            {"label": r["label"], "dir": r["dir"], "summary": r["summary"]}
            for r in runs
        ],
        "paired_vs_baseline": paired_vs_baseline,
    }
    return report, "\n".join(lines)
