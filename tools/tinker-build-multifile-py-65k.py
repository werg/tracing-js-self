#!/usr/bin/env python3
"""Build and strictly verify 30 rich 16K-52K token multi-file Python execution tasks.

Generates 10 distinct production-style multi-file Python repositories (26-40 files each)
with realistic architecture, AST symbol-loaded large modules (> 3 KB), whole-file small
modules, 18-30 realistic sibling distractor modules, causal branching pairs, and full
external I/O (`fs.*`, `env.get`, `http.request`, `shell.exec`, `platform.log`,
`platform.time`, `platform.uuid`, `platform.secrets`, `sqlite3 :memory:`, `async`).

Every task is verified via:
  1. `export_python_example(..., trace_format="compact", reasoning_channel="thinking")`
  2. Live replay through `create_python_session(prepare_python_task(...))`
  3. `audit_python_supervision(...)` confirming causal zero-future-leakage
  4. Strict context budget check: `ceil(conversation_chars / 3.2) <= 60_000`
"""

from __future__ import annotations

import argparse
import concurrent.futures
import json
import math
from pathlib import Path
import sys
from typing import Any

_REPO_ROOT = Path(__file__).resolve().parents[1]
_TRAINING_DIR = str(_REPO_ROOT / "training")
if _TRAINING_DIR not in sys.path:
    sys.path.insert(0, _TRAINING_DIR)

from tinker_py.codebase import CODE_LOAD_OPERATION  # noqa: E402
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


def _json_compact(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def _make_distractor_module(domain: str, subpkg: str, mod_name: str, entities: list[str]) -> str:
    """Generate a realistic, syntactically valid sibling distractor module for a repo."""
    cls_primary = "".join(p.capitalize() for p in mod_name.split("_")) + "Service"
    cls_record = "".join(p.capitalize() for p in mod_name.split("_")) + "Record"
    const_prefix = mod_name.upper()
    fn_a = f"normalize_{mod_name}"
    fn_b = f"summarize_{mod_name}"
    fn_c = f"validate_{mod_name}_payload"
    ent_repr = repr(tuple(entities))
    return f'''"""Domain module `{domain}.{subpkg}.{mod_name}`."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

{const_prefix}_VERSION = "2.4"
{const_prefix}_FIELDS = {ent_repr}
{const_prefix}_MAX_BATCH = 250


@dataclass
class {cls_record}:
    record_id: str
    namespace: str = "{domain}"
    category: str = "{subpkg}"
    weight: float = 1.0
    attributes: dict[str, Any] = field(default_factory=dict)

    def fingerprint(self) -> str:
        keys = ",".join(sorted(self.attributes.keys()))
        return f"{{self.namespace}}:{{self.category}}:{{self.record_id}}:{{keys}}"

    def scaled_score(self, multiplier: float = 1.0) -> float:
        base = float(self.attributes.get("score", 0.0))
        return round(base * self.weight * multiplier, 4)


class {cls_primary}:
    """Stateful handler for {domain} {subpkg}/{mod_name} workflows."""

    def __init__(self, prefix: str = "{mod_name}", strict: bool = True) -> None:
        self.prefix = prefix
        self.strict = strict
        self._cache: dict[str, {cls_record}] = {{}}

    def register(self, record: {cls_record}) -> str:
        key = f"{{self.prefix}}::{{record.record_id}}"
        if self.strict and key in self._cache:
            raise ValueError(f"Duplicate key {{key}}")
        self._cache[key] = record
        return key

    def lookup(self, record_id: str) -> {cls_record} | None:
        return self._cache.get(f"{{self.prefix}}::{{record_id}}")

    def export_rows(self) -> list[dict[str, Any]]:
        rows: list[dict[str, Any]] = []
        for key in sorted(self._cache):
            rec = self._cache[key]
            rows.append({{
                "key": key,
                "fingerprint": rec.fingerprint(),
                "score": rec.scaled_score(),
            }})
        return rows


def {fn_a}(raw: dict[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {{}}
    for name in {const_prefix}_FIELDS:
        val = raw.get(name)
        if isinstance(val, str):
            out[name] = val.strip()
        elif val is not None:
            out[name] = val
    return out


def {fn_b}(records: list[{cls_record}]) -> dict[str, Any]:
    total = sum(r.scaled_score() for r in records)
    return {{
        "module": "{domain}.{subpkg}.{mod_name}",
        "count": len(records),
        "total_score": round(total, 4),
    }}


def {fn_c}(payload: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    if not isinstance(payload, dict):
        return ["payload must be a mapping"]
    for req in {const_prefix}_FIELDS[:2]:
        if req not in payload:
            errors.append(f"missing required field: {{req}}")
    return errors
'''


def _add_distractors(
    files: dict[str, str],
    pkg: str,
    specs: list[tuple[str, list[str], list[str]]],
    *,
    extra_subpackages: int = 0,
    mods_per_extra: int = 8,
) -> None:
    """Populate realistic distractor subpackages and modules."""
    for subpkg, mods, entities in specs:
        init_path = f"{pkg}/{subpkg}/__init__.py"
        if init_path not in files:
            files[init_path] = f'"""Subpackage `{pkg}.{subpkg}`."""\n'
        for m in mods:
            p = f"{pkg}/{subpkg}/{m}.py"
            if p not in files:
                files[p] = _make_distractor_module(pkg, subpkg, m, entities)

    extra_domains = [
        ("adapters", ["grpc_transport", "amqp_consumer", "redis_cache", "s3_archive", "http_pool", "jsonl_stream", "csv_export", "parquet_writer", "otel_exporter", "statsd_sink"]),
        ("validators", ["schema_v1", "schema_v2", "idempotency", "rate_guard", "signature_check", "tenant_quota", "payload_bounds", "charset_check", "clock_skew", "checksum_verify"]),
        ("migrations", ["rev_001_base", "rev_002_indices", "rev_003_audit", "rev_004_shards", "rev_005_retention", "rev_006_backfill", "rev_007_tags", "rev_008_views", "rev_009_triggers", "rev_010_cleanup"]),
        ("cli_tools", ["inspect_cmd", "replay_cmd", "bench_cmd", "doctor_cmd", "export_cmd", "verify_cmd", "prune_cmd", "diff_cmd", "seed_cmd", "tail_cmd"]),
        ("compat", ["legacy_v1_codec", "legacy_v2_codec", "field_aliases", "deprecated_hooks", "xml_bridge", "ini_loader", "yaml_shim", "env_aliases", "path_norm", "tz_aliases"]),
        ("analytics", ["cohort_rollup", "funnel_calc", "latency_bins", "error_matrix", "cost_alloc", "sla_window", "drift_detect", "outlier_filter", "digest_summary", "trend_slope"]),
        ("compliance", ["gdpr_redact", "pii_scrubber", "soc2_evidence", "retention_sweep", "access_ledger", "key_rotation", "consent_store", "export_bundle", "legal_hold", "policy_audit"]),
        ("testing_util", ["fixture_factory", "clock_stub", "http_recorder", "snapshot_cmp", "fuzz_seeds", "chaos_injector", "load_profile", "contract_check", "golden_diff", "mock_broker"]),
        ("integrations", ["jira_bridge", "slack_digest", "pagerduty_v2", "datadog_events", "github_checks", "linear_sync", "opsgenie_hook", "teams_card", "email_smtp", "webhook_hmac"]),
        ("ops", ["health_probe", "readiness_gate", "graceful_drain", "leader_elect", "shard_router", "circuit_breaker", "bulkhead_pool", "retry_budget", "hedged_call", "backpressure"]),
    ]
    for subpkg, mods in extra_domains[:extra_subpackages]:
        init_path = f"{pkg}/{subpkg}/__init__.py"
        if init_path not in files:
            files[init_path] = f'"""Subpackage `{pkg}.{subpkg}`."""\n'
        for m in mods[:mods_per_extra]:
            p = f"{pkg}/{subpkg}/{m}.py"
            if p not in files:
                files[p] = _make_distractor_module(pkg, subpkg, m, ["id", "namespace", "payload", "status"])


def _class_domain_methods(tag: str, count: int = 4) -> str:
    """Realistic rich helper methods inside an executed class (loaded via AST symbol code.load)."""
    blocks: list[str] = []
    for i in range(1, count + 1):
        blocks.append(f'''
    def _validate_{tag.lower()}_rule_{i}(self, payload: dict[str, Any]) -> tuple[bool, list[str]]:
        """Validate domain invariant #{i} for {tag} processing."""
        issues: list[str] = []
        if not isinstance(payload, dict):
            return False, ["{tag.lower()}:expected-mapping"]
        if len(payload) > {64 * i}:
            issues.append("{tag.lower()}:field-limit-exceeded")
        for key, val in sorted(payload.items()):
            if isinstance(key, str) and key.startswith("__"):
                issues.append(f"{tag.lower()}:reserved-key:{{key}}")
            if isinstance(val, str) and len(val) > {4096 * i}:
                issues.append(f"{tag.lower()}:value-too-large:{{key}}")
        return len(issues) == 0, issues

    def describe_{tag.lower()}_profile_{i}(self, label: str = "{tag.lower()}") -> dict[str, Any]:
        """Return diagnostic configuration snapshot #{i} for telemetry & audit trails."""
        return {{
            "component": "{tag}",
            "profile": f"{{label}}_p{i}",
            "max_fields": {64 * i},
            "max_value_bytes": {4096 * i},
            "strict_mode": {bool(i % 2 == 1)},
        }}''')
    return "\n".join(blocks)


def _large_unused_block(tag: str, count: int = 4) -> str:
    """Append realistic unused sibling helpers/classes so a module exceeds 3.5 KB and triggers symbol-level code.load."""
    chunks: list[str] = []
    for i in range(1, count + 1):
        chunks.append(f'''

class {tag}ArchiveAdapter{i}:
    """Offline archive adapter #{i} for batch migrations and replay inspection."""

    BATCH_LIMIT = {100 * i}
    SCHEMA_TAG = "{tag.lower()}_v{i}"

    def __init__(self, shard: str, retention_days: int = {30 * i}) -> None:
        self.shard = shard
        self.retention_days = retention_days
        self.checkpoints: list[dict[str, Any]] = []

    def stage_batch(self, rows: list[dict[str, Any]]) -> dict[str, Any]:
        accepted = [r for r in rows[: self.BATCH_LIMIT] if r.get("id") is not None]
        digest = sum(len(str(r)) for r in accepted)
        cp = {{"shard": self.shard, "count": len(accepted), "digest": digest, "tag": self.SCHEMA_TAG}}
        self.checkpoints.append(cp)
        return cp

    def compact_history(self) -> dict[str, Any]:
        total = sum(c["count"] for c in self.checkpoints)
        return {{"shard": self.shard, "batches": len(self.checkpoints), "total_rows": total}}


def diagnostic_{tag.lower()}_snapshot_{i}(items: list[dict[str, Any]], threshold: float = {0.25 * i:.2f}) -> dict[str, Any]:
    above = [it for it in items if float(it.get("metric", 0.0)) >= threshold]
    below = [it for it in items if float(it.get("metric", 0.0)) < threshold]
    return {{
        "tag": "{tag.lower()}_{i}",
        "threshold": threshold,
        "above_count": len(above),
        "below_count": len(below),
        "ratio": round(len(above) / max(1, len(items)), 4),
    }}
''')
    return "\n".join(chunks)


# ===========================================================================
# Repo 1: ledger_svc — FinTech Double-Entry Ledger & Reconciliation Backend
# ===========================================================================

def _build_ledger_svc() -> list[dict[str, Any]]:
    files: dict[str, str] = {
        "ledger_svc/__init__.py": '"""Double-entry multi-currency ledger reconciliation backend."""\nVERSION = "3.1.0"\n',
        "ledger_svc/api/__init__.py": "",
        "ledger_svc/config/__init__.py": "",
        "ledger_svc/db/__init__.py": "",
        "ledger_svc/fx/__init__.py": "",
        "ledger_svc/domain/__init__.py": "",
        "ledger_svc/audit/__init__.py": "",
        "ledger_svc/reporting/__init__.py": "",
        "ledger_svc/api/reconcile.py": '''"""Entry point for multi-currency ledger reconciliation."""

from __future__ import annotations

from ledger_svc.audit.logger import emit_audit_event
from ledger_svc.config.env_loader import load_reconcile_settings
from ledger_svc.db.sqlite_store import LedgerSQLiteStore
from ledger_svc.domain.journal import JournalEngine
from ledger_svc.domain.rules import ReconciliationPolicy
from ledger_svc.fx.rate_client import fetch_fx_rates
from ledger_svc.reporting.exporter import write_reconciliation_report


def run(batch_id: str, postings: list[dict]) -> dict:
    """Reconcile a batch of multi-currency postings against SQLite balances and FX feeds."""
    cfg = load_reconcile_settings()
    emit_audit_event("INFO", f"starting reconciliation batch={batch_id} env={cfg['env']}")

    currencies = sorted({p["currency"] for p in postings} | {cfg["base_currency"]})
    fx_result = fetch_fx_rates(cfg["fx_endpoint"], cfg["base_currency"], currencies, cfg["fx_cache_path"])

    engine = JournalEngine(base_currency=cfg["base_currency"], rates=fx_result["rates"])
    normalized = engine.normalize_postings(postings)
    summary = engine.compute_trial_balance(normalized)

    policy = ReconciliationPolicy(
        max_imbalance_cents=cfg["max_imbalance_cents"],
        high_value_cents=cfg["high_value_cents"],
    )
    verdict = policy.evaluate(summary, normalized, fx_source=fx_result["source"])

    store = LedgerSQLiteStore()
    store.init_schema()
    store.record_entries(batch_id, normalized)
    db_totals = store.query_account_totals(batch_id)
    store.close()

    if not verdict["approved"]:
        emit_audit_event("ERROR", f"reconciliation rejected batch={batch_id} reason={verdict['reason']}")
        raise ValueError(f"Reconciliation failed: {verdict['reason']}")

    report = {
        "batch_id": batch_id,
        "env": cfg["env"],
        "fx_source": fx_result["source"],
        "base_currency": cfg["base_currency"],
        "net_imbalance_cents": summary["net_imbalance_cents"],
        "flagged_count": len(verdict["flagged_ids"]),
        "flagged_ids": verdict["flagged_ids"],
        "account_totals": db_totals,
    }
    report_path = write_reconciliation_report(cfg["report_dir"], batch_id, report)
    emit_audit_event("INFO", f"reconciliation committed batch={batch_id} path={report_path}")
    return {
        "status": "committed",
        "report_path": report_path,
        "fx_source": fx_result["source"],
        "account_totals": db_totals,
        "flagged_ids": verdict["flagged_ids"],
        "net_imbalance_cents": summary["net_imbalance_cents"],
    }
''',
        "ledger_svc/config/env_loader.py": '''"""Configuration loader combining environment variables and JSON config files."""

from __future__ import annotations

import json
import os


def load_reconcile_settings() -> dict:
    env_name = os.getenv("LEDGER_ENV") or "prod"
    cfg_path = os.getenv("LEDGER_CONFIG_PATH") or "/etc/ledger/reconcile.json"
    base_cfg = {
        "base_currency": "USD",
        "fx_endpoint": "https://fx.internal/v2/rates",
        "fx_cache_path": "/var/cache/ledger/fx_rates.json",
        "report_dir": "/var/reports/ledger",
        "max_imbalance_cents": 50,
        "high_value_cents": 500000,
    }
    if os.path.exists(cfg_path):
        with open(cfg_path, "r", encoding="utf-8") as fh:
            loaded = json.loads(fh.read())
        base_cfg.update(loaded)
    base_cfg["env"] = env_name
    return base_cfg
''',
        "ledger_svc/fx/rate_client.py": '''"""HTTP FX rate client with causal fallback to local rate cache."""

from __future__ import annotations

import json
import urllib.request

from ledger_svc.audit.logger import emit_audit_event


def fetch_fx_rates(endpoint: str, base_currency: str, currencies: list[str], cache_path: str) -> dict:
    query = ",".join(currencies)
    url = f"{endpoint}?base={base_currency}&symbols={query}"
    try:
        with urllib.request.urlopen(url) as resp:
            status = resp.status
            body = resp.read().decode("utf-8")
        if status != 200:
            raise RuntimeError(f"Unexpected FX HTTP status {status}")
        payload = json.loads(body)
        return {"source": "live-http", "rates": payload["rates"]}
    except Exception as exc:
        emit_audit_event("WARNING", f"live FX fetch failed ({exc}); loading fallback cache")
        from ledger_svc.fx.fallback_cache import load_cached_fx_rates

        return load_cached_fx_rates(cache_path, base_currency, currencies)
''',
        "ledger_svc/fx/fallback_cache.py": '''"""Local FX rate cache used only when live FX API fails."""

from __future__ import annotations

import json


def load_cached_fx_rates(cache_path: str, base_currency: str, currencies: list[str]) -> dict:
    with open(cache_path, "r", encoding="utf-8") as fh:
        data = json.loads(fh.read())
    rates = {base_currency: 1.0}
    for cur in currencies:
        if cur in data.get("rates", {}):
            rates[cur] = float(data["rates"][cur])
    return {"source": "fallback-cache", "rates": rates}
''',
        "ledger_svc/domain/journal.py": '''"""Core double-entry journal normalization and trial balance engine."""

from __future__ import annotations

from typing import Any

DEFAULT_PRECISION = 2
SUPPORTED_SIDES = ("debit", "credit")


class JournalEngine:
    """Converts multi-currency postings to integer base-currency cents and computes trial balances."""

    def __init__(self, base_currency: str, rates: dict[str, float]) -> None:
        self.base_currency = base_currency
        self.rates = dict(rates)
        self.rates.setdefault(base_currency, 1.0)

    def _to_base_cents(self, amount_cents: int, currency: str) -> int:
        if currency not in self.rates:
            raise KeyError(f"Missing FX rate for {currency}")
        rate = self.rates[currency]
        return int(round(amount_cents * rate))

    def normalize_postings(self, postings: list[dict[str, Any]]) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        for idx, raw in enumerate(postings):
            side = raw["side"]
            if side not in SUPPORTED_SIDES:
                raise ValueError(f"Invalid side {side!r}")
            base_cents = self._to_base_cents(int(raw["amount_cents"]), raw["currency"])
            signed = base_cents if side == "debit" else -base_cents
            out.append({
                "seq": idx + 1,
                "entry_id": raw["id"],
                "account": raw["account"],
                "side": side,
                "currency": raw["currency"],
                "orig_cents": int(raw["amount_cents"]),
                "base_cents": base_cents,
                "signed_cents": signed,
            })
        return out

    def compute_trial_balance(self, entries: list[dict[str, Any]]) -> dict[str, Any]:
        total_debits = 0
        total_credits = 0
        per_account: dict[str, int] = {}
        for row in entries:
            if row["side"] == "debit":
                total_debits += row["base_cents"]
            else:
                total_credits += row["base_cents"]
            acct = row["account"]
            per_account[acct] = per_account.get(acct, 0) + row["signed_cents"]
        return {
            "total_debits": total_debits,
            "total_credits": total_credits,
            "net_imbalance_cents": abs(total_debits - total_credits),
            "per_account": per_account,
        }
''' + _class_domain_methods("JournalEngine", 5) + _large_unused_block("Journal", 4),
        "ledger_svc/domain/rules.py": '''"""Reconciliation approval rules and high-value anomaly flagging."""

from __future__ import annotations

from typing import Any

FALLBACK_TOLERANCE_PENALTY = 10


class ReconciliationPolicy:
    """Evaluates trial balance tolerances and high-value posting review thresholds."""

    def __init__(self, max_imbalance_cents: int, high_value_cents: int) -> None:
        self.max_imbalance_cents = max_imbalance_cents
        self.high_value_cents = high_value_cents

    def evaluate(
        self,
        summary: dict[str, Any],
        entries: list[dict[str, Any]],
        *,
        fx_source: str,
    ) -> dict[str, Any]:
        effective_limit = self.max_imbalance_cents
        if fx_source == "fallback-cache":
            effective_limit = max(0, effective_limit - FALLBACK_TOLERANCE_PENALTY)

        flagged = [e["entry_id"] for e in entries if e["base_cents"] >= self.high_value_cents]
        imbalance = int(summary["net_imbalance_cents"])
        if imbalance > effective_limit:
            return {
                "approved": False,
                "reason": f"imbalance {imbalance} exceeds limit {effective_limit}",
                "flagged_ids": flagged,
            }
        return {
            "approved": True,
            "reason": "within-tolerance",
            "flagged_ids": flagged,
        }
''' + _class_domain_methods("ReconciliationPolicy", 5) + _large_unused_block("Policy", 4),
        "ledger_svc/db/sqlite_store.py": '''"""In-memory SQLite ledger storage and aggregation queries."""

from __future__ import annotations

import sqlite3
from typing import Any


class LedgerSQLiteStore:
    def __init__(self) -> None:
        self._conn = sqlite3.connect(":memory:")

    def init_schema(self) -> None:
        self._conn.execute(
            "CREATE TABLE ledger_entries ("
            "batch_id TEXT, entry_id TEXT, account TEXT, side TEXT, "
            "base_cents INTEGER, signed_cents INTEGER)"
        )

    def record_entries(self, batch_id: str, entries: list[dict[str, Any]]) -> None:
        rows = [
            (batch_id, e["entry_id"], e["account"], e["side"], e["base_cents"], e["signed_cents"])
            for e in entries
        ]
        self._conn.executemany(
            "INSERT INTO ledger_entries VALUES (?, ?, ?, ?, ?, ?)",
            rows,
        )
        self._conn.commit()

    def query_account_totals(self, batch_id: str) -> dict[str, int]:
        cur = self._conn.execute(
            "SELECT account, SUM(signed_cents) FROM ledger_entries "
            "WHERE batch_id = ? GROUP BY account ORDER BY account",
            (batch_id,),
        )
        return {str(acct): int(total) for acct, total in cur.fetchall()}

    def close(self) -> None:
        self._conn.close()
''',
        "ledger_svc/audit/logger.py": '''"""Structured audit logger with deterministic timestamp and correlation UUID."""

from __future__ import annotations

import datetime
import logging
import uuid


def emit_audit_event(level: str, message: str) -> str:
    ts = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    event_id = str(uuid.uuid4())[:8]
    formatted = f"[{ts}][{event_id}] {message}"
    if level == "ERROR":
        logging.error(formatted)
    elif level == "WARNING":
        logging.warning(formatted)
    else:
        logging.info(formatted)
    return event_id
''',
        "ledger_svc/reporting/exporter.py": '''"""JSON reconciliation report exporter."""

from __future__ import annotations

import json


def write_reconciliation_report(report_dir: str, batch_id: str, report: dict) -> str:
    path = f"{report_dir}/{batch_id}.json"
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(json.dumps(report, sort_keys=True))
    return path
''',
    }
    _add_distractors(
        files,
        "ledger_svc",
        [
            ("billing", ["invoice_sync", "payout_queue", "chargeback_map", "fee_schedule"], ["account", "amount", "currency"]),
            ("tax", ["vat_engine", "withholding", "jurisdiction", "nexus_rules"], ["country", "rate", "basis"]),
            ("cli", ["admin_cmd", "replay_tool", "diff_viewer", "backfill_cli"], ["batch_id", "cursor", "mode"]),
            ("migrations", ["v001_init", "v002_indexes", "v003_fx_tables", "v004_audit"], ["table", "revision", "checksum"]),
        ],
        extra_subpackages=4,
        mods_per_extra=8,
    )

    cfg_json = json.dumps({
        "base_currency": "USD",
        "fx_endpoint": "https://fx.internal/v2/rates",
        "fx_cache_path": "/var/cache/ledger/fx_rates.json",
        "report_dir": "/var/reports/ledger",
        "max_imbalance_cents": 25,
        "high_value_cents": 200000,
    })
    postings_balanced = [
        {"id": "p-101", "account": "cash_usd", "side": "debit", "currency": "USD", "amount_cents": 250000},
        {"id": "p-102", "account": "cash_eur", "side": "debit", "currency": "EUR", "amount_cents": 100000},
        {"id": "p-103", "account": "rev_subs", "side": "credit", "currency": "USD", "amount_cents": 360000},
    ]
    fx_live_body = json.dumps({"base": "USD", "rates": {"EUR": 1.10, "USD": 1.0}})
    fx_cache_body = json.dumps({"as_of": "2026-11-26", "rates": {"EUR": 1.09, "USD": 1.0}})

    # Variant 1: Live HTTP FX succeeds (causal pair A)
    rep1 = json.dumps({
        "account_totals": {"cash_eur": 110000, "cash_usd": 250000, "rev_subs": -360000},
        "base_currency": "USD",
        "batch_id": "B-2026-11",
        "env": "prod",
        "flagged_count": 2,
        "flagged_ids": ["p-101", "p-103"],
        "fx_source": "live-http",
        "net_imbalance_cents": 0,
    }, sort_keys=True)
    t1 = {
        "id": "lc65k-py-ledger-svc-live-ok",
        "family": "lc65k-py-repo:ledger_svc",
        "language": "py",
        "files": files,
        "entryFile": "ledger_svc/api/reconcile.py",
        "entry": "run",
        "args": ["B-2026-11", postings_balanced],
        "fixture": {
            "calls": [
                {"operation": "env.get", "arguments": ["LEDGER_ENV"], "status": "fulfilled", "result": "prod"},
                {"operation": "env.get", "arguments": ["LEDGER_CONFIG_PATH"], "status": "fulfilled", "result": "/etc/ledger/reconcile.json"},
                {"operation": "fs.exists", "arguments": ["/etc/ledger/reconcile.json"], "status": "fulfilled", "result": True},
                {"operation": "fs.readText", "arguments": ["/etc/ledger/reconcile.json"], "status": "fulfilled", "result": cfg_json},
                {"operation": "platform.time", "arguments": [], "status": "fulfilled", "result": 1795766400.0},
                {"operation": "platform.uuid", "arguments": [], "status": "fulfilled", "result": "11111111-2222-4333-8444-555555555501"},
                {"operation": "platform.log", "arguments": ["INFO", "[2026-11-27T08:00:00Z][11111111] starting reconciliation batch=B-2026-11 env=prod"], "status": "fulfilled", "result": None},
                {"operation": "http.request", "arguments": [{"method": "GET", "url": "https://fx.internal/v2/rates?base=USD&symbols=EUR,USD"}], "status": "fulfilled", "result": {"status": 200, "url": "https://fx.internal/v2/rates?base=USD&symbols=EUR,USD", "headers": {"content-type": "application/json"}, "body": fx_live_body}},
                {"operation": "fs.writeText", "arguments": ["/var/reports/ledger/B-2026-11.json", rep1], "status": "fulfilled", "result": None},
                {"operation": "platform.time", "arguments": [], "status": "fulfilled", "result": 1795766402.0},
                {"operation": "platform.uuid", "arguments": [], "status": "fulfilled", "result": "11111111-2222-4333-8444-555555555502"},
                {"operation": "platform.log", "arguments": ["INFO", "[2026-11-27T08:00:02Z][11111111] reconciliation committed batch=B-2026-11 path=/var/reports/ledger/B-2026-11.json"], "status": "fulfilled", "result": None},
            ]
        },
        "features": ["multifile-codebase", "code-load", "effectful", "causal-branch", "sqlite3", "http", "fs", "env", "logging"],
    }

    # Variant 2: Live HTTP FX returns 503 -> causal branch loads fallback_cache.py and succeeds with cached rates (causal pair B — IDENTICAL prompt & args!)
    # Note: with EUR=1.09, cash_eur=109000, cash_usd=250000, rev_subs=360000 -> imbalance=1000 > 15 -> let's use EUR=1.0999 so cash_eur=109990, imbalance=10 <= (25-10)=15!
    fx_cache_close = json.dumps({"as_of": "2026-11-26", "rates": {"EUR": 1.0999, "USD": 1.0}})
    rep2 = json.dumps({
        "account_totals": {"cash_eur": 109990, "cash_usd": 250000, "rev_subs": -360000},
        "base_currency": "USD",
        "batch_id": "B-2026-11",
        "env": "prod",
        "flagged_count": 2,
        "flagged_ids": ["p-101", "p-103"],
        "fx_source": "fallback-cache",
        "net_imbalance_cents": 10,
    }, sort_keys=True)
    t2 = {
        "id": "lc65k-py-ledger-svc-fx-fallback",
        "family": "lc65k-py-repo:ledger_svc",
        "language": "py",
        "files": files,
        "entryFile": "ledger_svc/api/reconcile.py",
        "entry": "run",
        "args": ["B-2026-11", postings_balanced],
        "fixture": {
            "calls": [
                {"operation": "env.get", "arguments": ["LEDGER_ENV"], "status": "fulfilled", "result": "prod"},
                {"operation": "env.get", "arguments": ["LEDGER_CONFIG_PATH"], "status": "fulfilled", "result": "/etc/ledger/reconcile.json"},
                {"operation": "fs.exists", "arguments": ["/etc/ledger/reconcile.json"], "status": "fulfilled", "result": True},
                {"operation": "fs.readText", "arguments": ["/etc/ledger/reconcile.json"], "status": "fulfilled", "result": cfg_json},
                {"operation": "platform.time", "arguments": [], "status": "fulfilled", "result": 1795766400.0},
                {"operation": "platform.uuid", "arguments": [], "status": "fulfilled", "result": "11111111-2222-4333-8444-555555555501"},
                {"operation": "platform.log", "arguments": ["INFO", "[2026-11-27T08:00:00Z][11111111] starting reconciliation batch=B-2026-11 env=prod"], "status": "fulfilled", "result": None},
                {"operation": "http.request", "arguments": [{"method": "GET", "url": "https://fx.internal/v2/rates?base=USD&symbols=EUR,USD"}], "status": "rejected", "result": {"name": "URLError", "message": "upstream 503 unavailable"}},
                {"operation": "platform.time", "arguments": [], "status": "fulfilled", "result": 1795766401.0},
                {"operation": "platform.uuid", "arguments": [], "status": "fulfilled", "result": "11111111-2222-4333-8444-555555555509"},
                {"operation": "platform.log", "arguments": ["WARNING", "[2026-11-27T08:00:01Z][11111111] live FX fetch failed (<urlopen error upstream 503 unavailable>); loading fallback cache"], "status": "fulfilled", "result": None},
                {"operation": "fs.readText", "arguments": ["/var/cache/ledger/fx_rates.json"], "status": "fulfilled", "result": fx_cache_close},
                {"operation": "fs.writeText", "arguments": ["/var/reports/ledger/B-2026-11.json", rep2], "status": "fulfilled", "result": None},
                {"operation": "platform.time", "arguments": [], "status": "fulfilled", "result": 1795766402.0},
                {"operation": "platform.uuid", "arguments": [], "status": "fulfilled", "result": "11111111-2222-4333-8444-555555555502"},
                {"operation": "platform.log", "arguments": ["INFO", "[2026-11-27T08:00:02Z][11111111] reconciliation committed batch=B-2026-11 path=/var/reports/ledger/B-2026-11.json"], "status": "fulfilled", "result": None},
            ]
        },
        "features": ["multifile-codebase", "code-load", "effectful", "causal-branch", "sqlite3", "http", "fs", "env", "logging"],
    }

    # Variant 3: Imbalance exceeds threshold -> logs ERROR and throws ValueError!
    t3 = {
        "id": "lc65k-py-ledger-svc-imbalance-throw",
        "family": "lc65k-py-repo:ledger_svc",
        "language": "py",
        "files": files,
        "entryFile": "ledger_svc/api/reconcile.py",
        "entry": "run",
        "args": ["B-2026-11", postings_balanced],
        "fixture": {
            "calls": [
                {"operation": "env.get", "arguments": ["LEDGER_ENV"], "status": "fulfilled", "result": "prod"},
                {"operation": "env.get", "arguments": ["LEDGER_CONFIG_PATH"], "status": "fulfilled", "result": "/etc/ledger/reconcile.json"},
                {"operation": "fs.exists", "arguments": ["/etc/ledger/reconcile.json"], "status": "fulfilled", "result": True},
                {"operation": "fs.readText", "arguments": ["/etc/ledger/reconcile.json"], "status": "fulfilled", "result": cfg_json},
                {"operation": "platform.time", "arguments": [], "status": "fulfilled", "result": 1795766400.0},
                {"operation": "platform.uuid", "arguments": [], "status": "fulfilled", "result": "11111111-2222-4333-8444-555555555501"},
                {"operation": "platform.log", "arguments": ["INFO", "[2026-11-27T08:00:00Z][11111111] starting reconciliation batch=B-2026-11 env=prod"], "status": "fulfilled", "result": None},
                {"operation": "http.request", "arguments": [{"method": "GET", "url": "https://fx.internal/v2/rates?base=USD&symbols=EUR,USD"}], "status": "fulfilled", "result": {"status": 200, "url": "https://fx.internal/v2/rates?base=USD&symbols=EUR,USD", "headers": {"content-type": "application/json"}, "body": fx_cache_body}},
                {"operation": "platform.time", "arguments": [], "status": "fulfilled", "result": 1795766403.0},
                {"operation": "platform.uuid", "arguments": [], "status": "fulfilled", "result": "11111111-2222-4333-8444-555555555503"},
                {"operation": "platform.log", "arguments": ["ERROR", "[2026-11-27T08:00:03Z][11111111] reconciliation rejected batch=B-2026-11 reason=imbalance 1000 exceeds limit 25"], "status": "fulfilled", "result": None},
            ]
        },
        "features": ["multifile-codebase", "code-load", "effectful", "causal-branch", "exception", "sqlite3", "http", "fs", "env", "logging"],
    }
    return [t1, t2, t3]


# ===========================================================================
# Repo 2: deploy_ctl — Release Orchestration & Canary Rollout CLI
# ===========================================================================

def _build_deploy_ctl() -> list[dict[str, Any]]:
    files: dict[str, str] = {
        "deploy_ctl/__init__.py": '"""Release orchestration and canary deployment controller."""\n',
        "deploy_ctl/cli/__init__.py": "",
        "deploy_ctl/config/__init__.py": "",
        "deploy_ctl/vcs/__init__.py": "",
        "deploy_ctl/health/__init__.py": "",
        "deploy_ctl/policy/__init__.py": "",
        "deploy_ctl/strategy/__init__.py": "",
        "deploy_ctl/telemetry/__init__.py": "",
        "deploy_ctl/state/__init__.py": "",
        "deploy_ctl/cli/rollout.py": '''"""Primary CLI rollout entrypoint."""

from __future__ import annotations

from deploy_ctl.config.manifest import load_release_manifest
from deploy_ctl.health.probe_client import query_canary_metrics
from deploy_ctl.policy.evaluator import CanaryPolicyEvaluator
from deploy_ctl.state.checkpoint import save_rollout_checkpoint
from deploy_ctl.telemetry.audit_log import record_rollout_event
from deploy_ctl.vcs.git_probe import inspect_git_state


def run(service: str, version: str) -> dict:
    """Execute preflight, canary health probe, and promote/rollback strategy."""
    manifest = load_release_manifest(service)
    git_info = inspect_git_state(manifest["repo_dir"])
    if not git_info["clean"]:
        record_rollout_event("WARNING", f"dirty tree blocked rollout for {service}@{version}")
        return {
            "service": service,
            "version": version,
            "action": "blocked-dirty-tree",
            "commit": git_info["sha"],
        }

    metrics = query_canary_metrics(manifest["metrics_url"], service, version)
    evaluator = CanaryPolicyEvaluator(
        max_error_rate=manifest["max_error_rate"],
        max_p99_ms=manifest["max_p99_ms"],
    )
    decision = evaluator.evaluate(metrics)

    if decision["healthy"]:
        from deploy_ctl.strategy.canary import execute_promotion

        outcome = execute_promotion(service, version, manifest["stages"], git_info["sha"])
    else:
        from deploy_ctl.strategy.rollback import execute_rollback

        outcome = execute_rollback(service, version, manifest["previous_version"], decision["reasons"])

    cp_path = save_rollout_checkpoint(manifest["checkpoint_dir"], service, outcome)
    token = record_rollout_event("INFO", f"completed {outcome['action']} for {service}@{version}")
    return {
        "service": service,
        "version": version,
        "action": outcome["action"],
        "commit": git_info["sha"],
        "checkpoint": cp_path,
        "audit_token": token,
        "details": outcome,
    }
''',
        "deploy_ctl/config/manifest.py": '''"""Release manifest loader."""

from __future__ import annotations

import json
import os


def load_release_manifest(service: str) -> dict:
    root = os.getenv("DEPLOY_MANIFEST_DIR") or "/etc/deploy"
    path = f"{root}/{service}.json"
    if not os.path.exists(path):
        raise FileNotFoundError(f"Missing manifest: {path}")
    with open(path, "r", encoding="utf-8") as fh:
        return json.loads(fh.read())
''',
        "deploy_ctl/vcs/git_probe.py": '''"""Inspect git repository cleanliness and HEAD SHA via subprocess."""

from __future__ import annotations

import subprocess


def inspect_git_state(repo_dir: str) -> dict:
    status_proc = subprocess.run(
        ["git", "-C", repo_dir, "status", "--porcelain"],
        capture_output=True,
        text=True,
        check=False,
    )
    sha_proc = subprocess.run(
        ["git", "-C", repo_dir, "rev-parse", "--short", "HEAD"],
        capture_output=True,
        text=True,
        check=False,
    )
    return {
        "clean": status_proc.returncode == 0 and status_proc.stdout.strip() == "",
        "sha": sha_proc.stdout.strip() or "unknown",
    }
''',
        "deploy_ctl/health/probe_client.py": '''"""HTTP telemetry probe for canary service metrics."""

from __future__ import annotations

import json
import urllib.request


def query_canary_metrics(metrics_url: str, service: str, version: str) -> dict:
    url = f"{metrics_url}?service={service}&version={version}"
    with urllib.request.urlopen(url) as resp:
        return json.loads(resp.read().decode("utf-8"))
''',
        "deploy_ctl/policy/evaluator.py": '''"""Canary SLO policy evaluation engine."""

from __future__ import annotations

from typing import Any

MIN_SAMPLE_COUNT = 100


class CanaryPolicyEvaluator:
    """Evaluates error rate, latency, and sample sufficiency gates."""

    def __init__(self, max_error_rate: float, max_p99_ms: float) -> None:
        self.max_error_rate = max_error_rate
        self.max_p99_ms = max_p99_ms

    def evaluate(self, metrics: dict[str, Any]) -> dict[str, Any]:
        reasons: list[str] = []
        samples = int(metrics.get("requests", 0))
        err_rate = float(metrics.get("error_rate", 1.0))
        p99 = float(metrics.get("p99_ms", 9999.0))
        if samples < MIN_SAMPLE_COUNT:
            reasons.append(f"insufficient-samples:{samples}")
        if err_rate > self.max_error_rate:
            reasons.append(f"error-rate:{err_rate}>{self.max_error_rate}")
        if p99 > self.max_p99_ms:
            reasons.append(f"p99-latency:{p99}>{self.max_p99_ms}")
        return {"healthy": len(reasons) == 0, "reasons": reasons}
''' + _class_domain_methods("CanaryPolicyEvaluator", 6) + _large_unused_block("CanaryPolicy", 4),
        "deploy_ctl/strategy/canary.py": '''"""Progressive canary promotion strategy."""

from __future__ import annotations

import subprocess
from typing import Any


def execute_promotion(service: str, version: str, stages: list[int], sha: str) -> dict[str, Any]:
    applied: list[int] = []
    for pct in stages:
        cp = subprocess.run(
            ["kubectl", "set", "weight", service, f"{version}={pct}"],
            capture_output=True,
            text=True,
            check=False,
        )
        if cp.returncode != 0:
            raise RuntimeError(f"Failed setting weight {pct}: {cp.stderr}")
        applied.append(pct)
    return {"action": "promoted", "stages_applied": applied, "version": version, "sha": sha}
''' + _large_unused_block("Promotion", 3),
        "deploy_ctl/strategy/rollback.py": '''"""Automated rollback strategy when canary gates fail."""

from __future__ import annotations

import subprocess
from typing import Any


def execute_rollback(service: str, bad_version: str, prev_version: str, reasons: list[str]) -> dict[str, Any]:
    cp = subprocess.run(
        ["kubectl", "rollout", "undo", service, f"--to={prev_version}"],
        capture_output=True,
        text=True,
        check=False,
    )
    return {
        "action": "rolled-back",
        "from_version": bad_version,
        "to_version": prev_version,
        "reasons": reasons,
        "undo_rc": cp.returncode,
    }
''' + _large_unused_block("Rollback", 3),
        "deploy_ctl/telemetry/audit_log.py": '''"""Rollout audit logger with timestamp and cryptographic receipt token."""

from __future__ import annotations

import logging
import secrets
import time


def record_rollout_event(level: str, msg: str) -> str:
    ts = int(time.time())
    tok = secrets.token_hex(4)
    line = f"ts={ts} tok={tok} {msg}"
    if level == "WARNING":
        logging.warning(line)
    else:
        logging.info(line)
    return tok
''',
        "deploy_ctl/state/checkpoint.py": '''"""Persist rollout checkpoints to disk."""

from __future__ import annotations

import json


def save_rollout_checkpoint(checkpoint_dir: str, service: str, outcome: dict) -> str:
    path = f"{checkpoint_dir}/{service}-latest.json"
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(json.dumps(outcome, sort_keys=True))
    return path
''',
    }
    _add_distractors(
        files,
        "deploy_ctl",
        [
            ("clouds", ["aws_eks", "gcp_gke", "azure_aks", "nomad_driver", "baremetal"], ["cluster", "region", "node"]),
            ("notify", ["slack_hook", "pagerduty", "email_digest", "webhook_sink"], ["channel", "severity", "body"]),
            ("plugins", ["helm_chart", "terraform_plan", "vault_inject", "istio_mesh", "envoy_sds"], ["plugin", "target", "version"]),
            ("schemas", ["release_v1", "release_v2", "slo_spec", "cluster_map"], ["name", "version", "spec"]),
        ],
        extra_subpackages=5,
        mods_per_extra=8,
    )

    manifest_json = json.dumps({
        "repo_dir": "/srv/repos/payments",
        "metrics_url": "https://metrics.internal/canary",
        "max_error_rate": 0.02,
        "max_p99_ms": 250.0,
        "stages": [25, 100],
        "previous_version": "v4.1.9",
        "checkpoint_dir": "/var/state/deploy",
    })

    out_promote = json.dumps({"action": "promoted", "sha": "a1b2c3d", "stages_applied": [25, 100], "version": "v4.2.0"}, sort_keys=True)
    t1 = {
        "id": "lc65k-py-deploy-ctl-promote",
        "family": "lc65k-py-repo:deploy_ctl",
        "language": "py",
        "files": files,
        "entryFile": "deploy_ctl/cli/rollout.py",
        "entry": "run",
        "args": ["payments", "v4.2.0"],
        "fixture": {
            "calls": [
                {"operation": "env.get", "arguments": ["DEPLOY_MANIFEST_DIR"], "status": "fulfilled", "result": "/etc/deploy"},
                {"operation": "fs.exists", "arguments": ["/etc/deploy/payments.json"], "status": "fulfilled", "result": True},
                {"operation": "fs.readText", "arguments": ["/etc/deploy/payments.json"], "status": "fulfilled", "result": manifest_json},
                {"operation": "shell.exec", "arguments": [{"args": ["git", "-C", "/srv/repos/payments", "status", "--porcelain"], "shell": False}], "status": "fulfilled", "result": {"returncode": 0, "stdout": "", "stderr": ""}},
                {"operation": "shell.exec", "arguments": [{"args": ["git", "-C", "/srv/repos/payments", "rev-parse", "--short", "HEAD"], "shell": False}], "status": "fulfilled", "result": {"returncode": 0, "stdout": "a1b2c3d\n", "stderr": ""}},
                {"operation": "http.request", "arguments": [{"method": "GET", "url": "https://metrics.internal/canary?service=payments&version=v4.2.0"}], "status": "fulfilled", "result": {"status": 200, "url": "https://metrics.internal/canary?service=payments&version=v4.2.0", "headers": {"content-type": "application/json"}, "body": json.dumps({"requests": 840, "error_rate": 0.004, "p99_ms": 142.5})}},
                {"operation": "shell.exec", "arguments": [{"args": ["kubectl", "set", "weight", "payments", "v4.2.0=25"], "shell": False}], "status": "fulfilled", "result": {"returncode": 0, "stdout": "ok\n", "stderr": ""}},
                {"operation": "shell.exec", "arguments": [{"args": ["kubectl", "set", "weight", "payments", "v4.2.0=100"], "shell": False}], "status": "fulfilled", "result": {"returncode": 0, "stdout": "ok\n", "stderr": ""}},
                {"operation": "fs.writeText", "arguments": ["/var/state/deploy/payments-latest.json", out_promote], "status": "fulfilled", "result": None},
                {"operation": "platform.time", "arguments": [], "status": "fulfilled", "result": 1795681000.0},
                {"operation": "platform.secrets", "arguments": ["token_hex", 4], "status": "fulfilled", "result": "9f0a1b2c"},
                {"operation": "platform.log", "arguments": ["INFO", "ts=1795681000 tok=9f0a1b2c completed promoted for payments@v4.2.0"], "status": "fulfilled", "result": None},
            ]
        },
        "features": ["multifile-codebase", "code-load", "effectful", "causal-branch", "shell", "http", "fs", "env", "secrets", "logging"],
    }

    out_rb = json.dumps({"action": "rolled-back", "from_version": "v4.2.0", "reasons": ["error-rate:0.085>0.02", "p99-latency:410.0>250.0"], "to_version": "v4.1.9", "undo_rc": 0}, sort_keys=True)
    t2 = {
        "id": "lc65k-py-deploy-ctl-rollback",
        "family": "lc65k-py-repo:deploy_ctl",
        "language": "py",
        "files": files,
        "entryFile": "deploy_ctl/cli/rollout.py",
        "entry": "run",
        "args": ["payments", "v4.2.0"],
        "fixture": {
            "calls": [
                {"operation": "env.get", "arguments": ["DEPLOY_MANIFEST_DIR"], "status": "fulfilled", "result": "/etc/deploy"},
                {"operation": "fs.exists", "arguments": ["/etc/deploy/payments.json"], "status": "fulfilled", "result": True},
                {"operation": "fs.readText", "arguments": ["/etc/deploy/payments.json"], "status": "fulfilled", "result": manifest_json},
                {"operation": "shell.exec", "arguments": [{"args": ["git", "-C", "/srv/repos/payments", "status", "--porcelain"], "shell": False}], "status": "fulfilled", "result": {"returncode": 0, "stdout": "", "stderr": ""}},
                {"operation": "shell.exec", "arguments": [{"args": ["git", "-C", "/srv/repos/payments", "rev-parse", "--short", "HEAD"], "shell": False}], "status": "fulfilled", "result": {"returncode": 0, "stdout": "a1b2c3d\n", "stderr": ""}},
                {"operation": "http.request", "arguments": [{"method": "GET", "url": "https://metrics.internal/canary?service=payments&version=v4.2.0"}], "status": "fulfilled", "result": {"status": 200, "url": "https://metrics.internal/canary?service=payments&version=v4.2.0", "headers": {"content-type": "application/json"}, "body": json.dumps({"requests": 520, "error_rate": 0.085, "p99_ms": 410.0})}},
                {"operation": "shell.exec", "arguments": [{"args": ["kubectl", "rollout", "undo", "payments", "--to=v4.1.9"], "shell": False}], "status": "fulfilled", "result": {"returncode": 0, "stdout": "rolled back\n", "stderr": ""}},
                {"operation": "fs.writeText", "arguments": ["/var/state/deploy/payments-latest.json", out_rb], "status": "fulfilled", "result": None},
                {"operation": "platform.time", "arguments": [], "status": "fulfilled", "result": 1795681005.0},
                {"operation": "platform.secrets", "arguments": ["token_hex", 4], "status": "fulfilled", "result": "deadbeef"},
                {"operation": "platform.log", "arguments": ["INFO", "ts=1795681005 tok=deadbeef completed rolled-back for payments@v4.2.0"], "status": "fulfilled", "result": None},
            ]
        },
        "features": ["multifile-codebase", "code-load", "effectful", "causal-branch", "shell", "http", "fs", "env", "secrets", "logging"],
    }

    t3 = {
        "id": "lc65k-py-deploy-ctl-dirty-block",
        "family": "lc65k-py-repo:deploy_ctl",
        "language": "py",
        "files": files,
        "entryFile": "deploy_ctl/cli/rollout.py",
        "entry": "run",
        "args": ["payments", "v4.2.0"],
        "fixture": {
            "calls": [
                {"operation": "env.get", "arguments": ["DEPLOY_MANIFEST_DIR"], "status": "fulfilled", "result": "/etc/deploy"},
                {"operation": "fs.exists", "arguments": ["/etc/deploy/payments.json"], "status": "fulfilled", "result": True},
                {"operation": "fs.readText", "arguments": ["/etc/deploy/payments.json"], "status": "fulfilled", "result": manifest_json},
                {"operation": "shell.exec", "arguments": [{"args": ["git", "-C", "/srv/repos/payments", "status", "--porcelain"], "shell": False}], "status": "fulfilled", "result": {"returncode": 0, "stdout": " M config.yaml\n", "stderr": ""}},
                {"operation": "shell.exec", "arguments": [{"args": ["git", "-C", "/srv/repos/payments", "rev-parse", "--short", "HEAD"], "shell": False}], "status": "fulfilled", "result": {"returncode": 0, "stdout": "a1b2c3d\n", "stderr": ""}},
                {"operation": "platform.time", "arguments": [], "status": "fulfilled", "result": 1795681010.0},
                {"operation": "platform.secrets", "arguments": ["token_hex", 4], "status": "fulfilled", "result": "cafe0001"},
                {"operation": "platform.log", "arguments": ["WARNING", "ts=1795681010 tok=cafe0001 dirty tree blocked rollout for payments@v4.2.0"], "status": "fulfilled", "result": None},
            ]
        },
        "features": ["multifile-codebase", "code-load", "effectful", "causal-branch", "shell", "fs", "env", "secrets", "logging"],
    }
    return [t1, t2, t3]


# ===========================================================================
# Repo 3: etl_lake — Data Warehouse Ingestion & SQLite Analytics Pipeline
# ===========================================================================

def _build_etl_lake() -> list[dict[str, Any]]:
    files: dict[str, str] = {
        "etl_lake/__init__.py": '"""Batch ETL lakehouse ingestion and SQLite analytical rollup pipeline."""\n',
        "etl_lake/pipelines/__init__.py": "",
        "etl_lake/io/__init__.py": "",
        "etl_lake/schema/__init__.py": "",
        "etl_lake/transform/__init__.py": "",
        "etl_lake/warehouse/__init__.py": "",
        "etl_lake/quality/__init__.py": "",
        "etl_lake/catalog/__init__.py": "",
        "etl_lake/pipelines/ingest.py": '''"""Primary ETL ingestion entrypoint."""

from __future__ import annotations

from etl_lake.catalog.registry import fetch_table_contract
from etl_lake.io.scanner import scan_landing_files
from etl_lake.io.sink import write_rollup_artifact
from etl_lake.schema.validator import SchemaValidator
from etl_lake.transform.normalizer import RecordNormalizer
from etl_lake.warehouse.sqlite_mart import SQLiteAnalyticsMart


def run(landing_dir: str, dataset_name: str) -> dict:
    """Discover landing files, validate against remote schema, load SQLite mart, and export rollups."""
    contract = fetch_table_contract(dataset_name)
    raw_batches = scan_landing_files(landing_dir)
    if not raw_batches:
        return {"dataset": dataset_name, "status": "empty", "loaded": 0, "quarantined": 0, "rollups": []}

    validator = SchemaValidator(required_fields=contract["required"], allowed_regions=contract["regions"])
    valid_rows, bad_rows = validator.partition(raw_batches)

    quarantine_path = None
    if bad_rows:
        if contract["mode"] == "strict":
            raise ValueError(f"Strict schema mode rejected {len(bad_rows)} invalid rows")
        from etl_lake.quality.quarantine import dump_quarantine_rows

        quarantine_path = dump_quarantine_rows(landing_dir, dataset_name, bad_rows)

    normalizer = RecordNormalizer(scale=contract.get("amount_scale", 1.0))
    clean_rows = normalizer.normalize_many(valid_rows)

    mart = SQLiteAnalyticsMart()
    mart.load_events(clean_rows)
    rollups = mart.region_rollups()
    mart.close()

    artifact = {
        "dataset": dataset_name,
        "mode": contract["mode"],
        "loaded": len(clean_rows),
        "quarantined": len(bad_rows),
        "rollups": rollups,
    }
    out_path = write_rollup_artifact(landing_dir, dataset_name, artifact)
    return {
        "dataset": dataset_name,
        "status": "ingested",
        "loaded": len(clean_rows),
        "quarantined": len(bad_rows),
        "quarantine_path": quarantine_path,
        "output_path": out_path,
        "rollups": rollups,
    }
''',
        "etl_lake/catalog/registry.py": '''"""Remote schema catalog client."""

from __future__ import annotations

import json
import logging
import os
import urllib.request


def fetch_table_contract(dataset_name: str) -> dict:
    base = os.getenv("ETL_CATALOG_URL") or "https://catalog.internal/schemas"
    url = f"{base}/{dataset_name}"
    logging.info(f"fetching schema contract {url}")
    with urllib.request.urlopen(url) as resp:
        return json.loads(resp.read().decode("utf-8"))
''',
        "etl_lake/io/scanner.py": '''"""Directory scanner reading JSONL landing shards."""

from __future__ import annotations

import json
import os


def scan_landing_files(landing_dir: str) -> list[dict]:
    if not os.path.isdir(landing_dir):
        raise FileNotFoundError(f"Landing dir missing: {landing_dir}")
    rows: list[dict] = []
    for name in sorted(os.listdir(landing_dir)):
        if not name.endswith(".jsonl"):
            continue
        full = f"{landing_dir}/{name}"
        with open(full, "r", encoding="utf-8") as fh:
            for line in fh.read().splitlines():
                if line.strip():
                    rows.append(json.loads(line))
    return rows
''',
        "etl_lake/schema/validator.py": '''"""Row-level schema validator partitioning valid and malformed rows."""

from __future__ import annotations

from typing import Any


class SchemaValidator:
    def __init__(self, required_fields: list[str], allowed_regions: list[str]) -> None:
        self.required_fields = list(required_fields)
        self.allowed_regions = set(allowed_regions)

    def validate_one(self, row: dict[str, Any]) -> list[str]:
        errs: list[str] = []
        for field in self.required_fields:
            if field not in row or row[field] is None:
                errs.append(f"missing:{field}")
        region = row.get("region")
        if region is not None and region not in self.allowed_regions:
            errs.append(f"bad_region:{region}")
        amt = row.get("amount")
        if amt is not None and (not isinstance(amt, (int, float)) or amt < 0):
            errs.append("bad_amount")
        return errs

    def partition(self, rows: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
        good: list[dict[str, Any]] = []
        bad: list[dict[str, Any]] = []
        for row in rows:
            errs = self.validate_one(row)
            if errs:
                bad.append({"row": row, "errors": errs})
            else:
                good.append(row)
        return good, bad
''' + _class_domain_methods("SchemaValidator", 6) + _large_unused_block("Schema", 4),
        "etl_lake/transform/normalizer.py": '''"""Data cleaning and currency/category normalization."""

from __future__ import annotations

from typing import Any


class RecordNormalizer:
    def __init__(self, scale: float = 1.0) -> None:
        self.scale = float(scale)

    def normalize_one(self, row: dict[str, Any]) -> dict[str, Any]:
        return {
            "event_id": str(row["id"]).strip(),
            "region": str(row["region"]).upper(),
            "category": str(row.get("category", "general")).strip().lower(),
            "amount": round(float(row["amount"]) * self.scale, 2),
        }

    def normalize_many(self, rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
        return [self.normalize_one(r) for r in rows]
''' + _class_domain_methods("RecordNormalizer", 6) + _large_unused_block("Normalizer", 4),
        "etl_lake/warehouse/sqlite_mart.py": '''"""In-memory SQLite analytical mart for region & category rollups."""

from __future__ import annotations

import sqlite3
from typing import Any


class SQLiteAnalyticsMart:
    def __init__(self) -> None:
        self._conn = sqlite3.connect(":memory:")
        self._conn.execute(
            "CREATE TABLE events (event_id TEXT, region TEXT, category TEXT, amount REAL)"
        )

    def load_events(self, rows: list[dict[str, Any]]) -> None:
        self._conn.executemany(
            "INSERT INTO events VALUES (?, ?, ?, ?)",
            [(r["event_id"], r["region"], r["category"], r["amount"]) for r in rows],
        )
        self._conn.commit()

    def region_rollups(self) -> list[dict[str, Any]]:
        cur = self._conn.execute(
            "SELECT region, COUNT(*), ROUND(SUM(amount), 2), ROUND(AVG(amount), 2) "
            "FROM events GROUP BY region ORDER BY region"
        )
        return [
            {"region": r, "count": int(c), "sum": float(s), "avg": float(a)}
            for r, c, s, a in cur.fetchall()
        ]

    def close(self) -> None:
        self._conn.close()
''',
        "etl_lake/quality/quarantine.py": '''"""Quarantine sink for malformed rows in lenient ingestion mode."""

from __future__ import annotations

import json
import logging


def dump_quarantine_rows(landing_dir: str, dataset_name: str, bad_rows: list[dict]) -> str:
    path = f"{landing_dir}/{dataset_name}.quarantine.json"
    logging.warning(f"quarantining {len(bad_rows)} rows to {path}")
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(json.dumps(bad_rows, sort_keys=True))
    return path
''' + _large_unused_block("Quarantine", 3),
        "etl_lake/io/sink.py": '''"""Rollup artifact writer."""

from __future__ import annotations

import json


def write_rollup_artifact(landing_dir: str, dataset_name: str, artifact: dict) -> str:
    path = f"{landing_dir}/{dataset_name}.rollup.json"
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(json.dumps(artifact, sort_keys=True))
    return path
''',
    }
    _add_distractors(
        files,
        "etl_lake",
        [
            ("connectors", ["s3_reader", "gcs_reader", "kafka_bridge", "postgres_cdc", "snowflake_sink"], ["uri", "bucket", "cursor"]),
            ("formats", ["parquet_codec", "avro_codec", "csv_sniffer", "orc_bridge"], ["schema", "compression", "rows"]),
            ("schedulers", ["cron_dag", "backfill_runner", "sla_monitor", "watermark"], ["dag_id", "window", "state"]),
            ("lineage", ["openlineage_emit", "column_graph", "impact_calc"], ["dataset", "upstream", "downstream"]),
        ],
        extra_subpackages=5,
        mods_per_extra=8,
    )

    shard1 = "\n".join([
        json.dumps({"id": "e1", "region": "us", "category": "compute", "amount": 120.5}),
        json.dumps({"id": "e2", "region": "eu", "category": "storage", "amount": 80.0}),
    ])
    shard2 = "\n".join([
        json.dumps({"id": "e3", "region": "us", "category": "storage", "amount": 49.5}),
        json.dumps({"id": "e4", "region": "ap", "category": "compute", "amount": 200.0}),
    ])
    shard2_bad = "\n".join([
        json.dumps({"id": "e3", "region": "us", "category": "storage", "amount": 49.5}),
        json.dumps({"id": "e4", "region": "mars", "category": "compute", "amount": -5.0}),
    ])

    contract_strict = json.dumps({"mode": "strict", "required": ["id", "region", "amount"], "regions": ["us", "eu", "ap"], "amount_scale": 1.0})
    contract_lenient = json.dumps({"mode": "lenient", "required": ["id", "region", "amount"], "regions": ["us", "eu", "ap"], "amount_scale": 1.0})

    art1 = json.dumps({
        "dataset": "usage_v2",
        "loaded": 4,
        "mode": "strict",
        "quarantined": 0,
        "rollups": [
            {"avg": 200.0, "count": 1, "region": "AP", "sum": 200.0},
            {"avg": 80.0, "count": 1, "region": "EU", "sum": 80.0},
            {"avg": 85.0, "count": 2, "region": "US", "sum": 170.0},
        ],
    }, sort_keys=True)
    t1 = {
        "id": "lc65k-py-etl-lake-strict-agg",
        "family": "lc65k-py-repo:etl_lake",
        "language": "py",
        "files": files,
        "entryFile": "etl_lake/pipelines/ingest.py",
        "entry": "run",
        "args": ["/data/landing", "usage_v2"],
        "fixture": {
            "calls": [
                {"operation": "env.get", "arguments": ["ETL_CATALOG_URL"], "status": "fulfilled", "result": "https://catalog.internal/schemas"},
                {"operation": "platform.log", "arguments": ["INFO", "fetching schema contract https://catalog.internal/schemas/usage_v2"], "status": "fulfilled", "result": None},
                {"operation": "http.request", "arguments": [{"method": "GET", "url": "https://catalog.internal/schemas/usage_v2"}], "status": "fulfilled", "result": {"status": 200, "url": "https://catalog.internal/schemas/usage_v2", "headers": {}, "body": contract_strict}},
                {"operation": "fs.isDir", "arguments": ["/data/landing"], "status": "fulfilled", "result": True},
                {"operation": "fs.listdir", "arguments": ["/data/landing"], "status": "fulfilled", "result": ["part-01.jsonl", "part-02.jsonl", "README.txt"]},
                {"operation": "fs.readText", "arguments": ["/data/landing/part-01.jsonl"], "status": "fulfilled", "result": shard1},
                {"operation": "fs.readText", "arguments": ["/data/landing/part-02.jsonl"], "status": "fulfilled", "result": shard2},
                {"operation": "fs.writeText", "arguments": ["/data/landing/usage_v2.rollup.json", art1], "status": "fulfilled", "result": None},
            ]
        },
        "features": ["multifile-codebase", "code-load", "effectful", "causal-branch", "sqlite3", "http", "fs", "env", "logging"],
    }

    bad_dump = json.dumps([{"errors": ["bad_region:mars", "bad_amount"], "row": {"amount": -5.0, "category": "compute", "id": "e4", "region": "mars"}}], sort_keys=True)
    art2 = json.dumps({
        "dataset": "usage_v2",
        "loaded": 3,
        "mode": "lenient",
        "quarantined": 1,
        "rollups": [
            {"avg": 80.0, "count": 1, "region": "EU", "sum": 80.0},
            {"avg": 85.0, "count": 2, "region": "US", "sum": 170.0},
        ],
    }, sort_keys=True)
    t2 = {
        "id": "lc65k-py-etl-lake-lenient-quarantine",
        "family": "lc65k-py-repo:etl_lake",
        "language": "py",
        "files": files,
        "entryFile": "etl_lake/pipelines/ingest.py",
        "entry": "run",
        "args": ["/data/landing", "usage_v2"],
        "fixture": {
            "calls": [
                {"operation": "env.get", "arguments": ["ETL_CATALOG_URL"], "status": "fulfilled", "result": "https://catalog.internal/schemas"},
                {"operation": "platform.log", "arguments": ["INFO", "fetching schema contract https://catalog.internal/schemas/usage_v2"], "status": "fulfilled", "result": None},
                {"operation": "http.request", "arguments": [{"method": "GET", "url": "https://catalog.internal/schemas/usage_v2"}], "status": "fulfilled", "result": {"status": 200, "url": "https://catalog.internal/schemas/usage_v2", "headers": {}, "body": contract_lenient}},
                {"operation": "fs.isDir", "arguments": ["/data/landing"], "status": "fulfilled", "result": True},
                {"operation": "fs.listdir", "arguments": ["/data/landing"], "status": "fulfilled", "result": ["part-01.jsonl", "part-02.jsonl"]},
                {"operation": "fs.readText", "arguments": ["/data/landing/part-01.jsonl"], "status": "fulfilled", "result": shard1},
                {"operation": "fs.readText", "arguments": ["/data/landing/part-02.jsonl"], "status": "fulfilled", "result": shard2_bad},
                {"operation": "platform.log", "arguments": ["WARNING", "quarantining 1 rows to /data/landing/usage_v2.quarantine.json"], "status": "fulfilled", "result": None},
                {"operation": "fs.writeText", "arguments": ["/data/landing/usage_v2.quarantine.json", bad_dump], "status": "fulfilled", "result": None},
                {"operation": "fs.writeText", "arguments": ["/data/landing/usage_v2.rollup.json", art2], "status": "fulfilled", "result": None},
            ]
        },
        "features": ["multifile-codebase", "code-load", "effectful", "causal-branch", "sqlite3", "http", "fs", "env", "logging"],
    }

    t3 = {
        "id": "lc65k-py-etl-lake-strict-reject",
        "family": "lc65k-py-repo:etl_lake",
        "language": "py",
        "files": files,
        "entryFile": "etl_lake/pipelines/ingest.py",
        "entry": "run",
        "args": ["/data/landing", "usage_v2"],
        "fixture": {
            "calls": [
                {"operation": "env.get", "arguments": ["ETL_CATALOG_URL"], "status": "fulfilled", "result": "https://catalog.internal/schemas"},
                {"operation": "platform.log", "arguments": ["INFO", "fetching schema contract https://catalog.internal/schemas/usage_v2"], "status": "fulfilled", "result": None},
                {"operation": "http.request", "arguments": [{"method": "GET", "url": "https://catalog.internal/schemas/usage_v2"}], "status": "fulfilled", "result": {"status": 200, "url": "https://catalog.internal/schemas/usage_v2", "headers": {}, "body": contract_strict}},
                {"operation": "fs.isDir", "arguments": ["/data/landing"], "status": "fulfilled", "result": True},
                {"operation": "fs.listdir", "arguments": ["/data/landing"], "status": "fulfilled", "result": ["part-01.jsonl", "part-02.jsonl"]},
                {"operation": "fs.readText", "arguments": ["/data/landing/part-01.jsonl"], "status": "fulfilled", "result": shard1},
                {"operation": "fs.readText", "arguments": ["/data/landing/part-02.jsonl"], "status": "fulfilled", "result": shard2_bad},
            ]
        },
        "features": ["multifile-codebase", "code-load", "effectful", "causal-branch", "exception", "http", "fs", "env", "logging"],
    }
    return [t1, t2, t3]


# ===========================================================================
# Repo 4: sec_scanner — Supply-Chain Dependency & SBOM Vulnerability Auditor
# ===========================================================================

def _build_sec_scanner() -> list[dict[str, Any]]:
    files: dict[str, str] = {
        "sec_scanner/__init__.py": '"""Supply-chain lockfile resolver, OSV vulnerability auditor, and SBOM emitter."""\n',
        "sec_scanner/engine/__init__.py": "",
        "sec_scanner/parsers/__init__.py": "",
        "sec_scanner/advisory/__init__.py": "",
        "sec_scanner/graph/__init__.py": "",
        "sec_scanner/scoring/__init__.py": "",
        "sec_scanner/policy/__init__.py": "",
        "sec_scanner/sbom/__init__.py": "",
        "sec_scanner/engine/audit.py": '''"""Main security audit pipeline."""

from __future__ import annotations

from sec_scanner.advisory.osv_client import query_osv_advisories
from sec_scanner.graph.resolver import DependencyGraph
from sec_scanner.parsers.lockfile import LockfileParser
from sec_scanner.policy.gate import evaluate_security_gate
from sec_scanner.sbom.writer import write_sbom_document
from sec_scanner.scoring.cvss import CVSSScorer


def run(project_dir: str, max_cvss: float) -> dict:
    """Parse lockfile, build dependency DAG, fetch advisories, score CVSS, evaluate waivers, emit SBOM."""
    parser = LockfileParser()
    packages = parser.parse_file(f"{project_dir}/deps.lock.json")

    graph = DependencyGraph(packages)
    topo = graph.topological_order()
    direct_roots = graph.root_packages()

    advisories = query_osv_advisories([{"name": p["name"], "version": p["version"]} for p in packages])
    scorer = CVSSScorer()
    findings = scorer.score_all(advisories, graph)

    gate = evaluate_security_gate(project_dir, findings, max_cvss)
    sbom_path = write_sbom_document(project_dir, topo, findings, gate)
    return {
        "passed": gate["passed"],
        "roots": direct_roots,
        "topo_order": topo,
        "finding_count": len(findings),
        "blocked_ids": gate["blocked_ids"],
        "waived_ids": gate["waived_ids"],
        "sbom_path": sbom_path,
    }
''',
        "sec_scanner/parsers/lockfile.py": '''"""Lockfile JSON parser with integrity validation."""

from __future__ import annotations

import json
from typing import Any


class LockfileParser:
    SUPPORTED_VERSION = 2

    def parse_file(self, path: str) -> list[dict[str, Any]]:
        with open(path, "r", encoding="utf-8") as fh:
            doc = json.loads(fh.read())
        if int(doc.get("lockfileVersion", 0)) != self.SUPPORTED_VERSION:
            raise ValueError("Unsupported lockfileVersion")
        out: list[dict[str, Any]] = []
        for pkg in doc.get("packages", []):
            out.append({
                "name": str(pkg["name"]),
                "version": str(pkg["version"]),
                "deps": list(pkg.get("deps", [])),
                "direct": bool(pkg.get("direct", False)),
            })
        return out
''' + _class_domain_methods("LockfileParser", 6) + _large_unused_block("Lockfile", 4),
        "sec_scanner/graph/resolver.py": '''"""Dependency DAG resolver computing topological order and blast radius."""

from __future__ import annotations

from typing import Any


class DependencyGraph:
    def __init__(self, packages: list[dict[str, Any]]) -> None:
        self._by_name = {p["name"]: p for p in packages}

    def root_packages(self) -> list[str]:
        return sorted(p["name"] for p in self._by_name.values() if p.get("direct"))

    def topological_order(self) -> list[str]:
        indeg: dict[str, int] = {n: 0 for n in self._by_name}
        rev: dict[str, list[str]] = {n: [] for n in self._by_name}
        for name, pkg in self._by_name.items():
            for dep in pkg.get("deps", []):
                if dep in self._by_name:
                    indeg[name] += 1
                    rev[dep].append(name)
        ready = sorted(n for n, d in indeg.items() if d == 0)
        order: list[str] = []
        while ready:
            cur = ready.pop(0)
            order.append(cur)
            for parent in sorted(rev[cur]):
                indeg[parent] -= 1
                if indeg[parent] == 0:
                    ready.append(parent)
                    ready.sort()
        return order

    def is_direct(self, pkg_name: str) -> bool:
        return bool(self._by_name.get(pkg_name, {}).get("direct", False))
''' + _class_domain_methods("DependencyGraph", 7) + _large_unused_block("DepGraph", 4),
        "sec_scanner/advisory/osv_client.py": '''"""OSV batch advisory HTTP client."""

from __future__ import annotations

import json
import os
import urllib.request


def query_osv_advisories(queries: list[dict]) -> list[dict]:
    url = os.getenv("OSV_API_URL") or "https://api.osv.internal/v1/querybatch"
    body = json.dumps({"queries": queries}, sort_keys=True).encode("utf-8")
    req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    return list(data.get("advisories", []))
''',
        "sec_scanner/scoring/cvss.py": '''"""CVSS severity scorer with direct-dependency exposure adjustment."""

from __future__ import annotations

from typing import Any

DIRECT_BOOST = 0.5


class CVSSScorer:
    def score_all(self, advisories: list[dict[str, Any]], graph: Any) -> list[dict[str, Any]]:
        findings: list[dict[str, Any]] = []
        for adv in advisories:
            base = float(adv["cvss"])
            direct = graph.is_direct(adv["package"])
            eff = min(10.0, round(base + (DIRECT_BOOST if direct else 0.0), 1))
            sev = "CRITICAL" if eff >= 9.0 else ("HIGH" if eff >= 7.0 else "MEDIUM")
            findings.append({
                "id": adv["id"],
                "package": adv["package"],
                "effective_cvss": eff,
                "severity": sev,
                "direct": direct,
            })
        findings.sort(key=lambda f: (-f["effective_cvss"], f["id"]))
        return findings
''' + _class_domain_methods("CVSSScorer", 7) + _large_unused_block("CVSS", 4),
        "sec_scanner/policy/gate.py": '''"""Security policy gate with optional causal waiver evaluation."""

from __future__ import annotations

import logging
from typing import Any


def evaluate_security_gate(project_dir: str, findings: list[dict[str, Any]], max_cvss: float) -> dict[str, Any]:
    over = [f for f in findings if f["effective_cvss"] > max_cvss]
    if not over:
        return {"passed": True, "blocked_ids": [], "waived_ids": []}

    from sec_scanner.policy.waiver import filter_waived_findings

    blocked, waived = filter_waived_findings(project_dir, over)
    if waived:
        logging.warning(f"applied security waivers: {','.join(waived)}")
    return {"passed": len(blocked) == 0, "blocked_ids": blocked, "waived_ids": waived}
''',
        "sec_scanner/policy/waiver.py": '''"""Waiver file parser checking expiration against current UTC date."""

from __future__ import annotations

import datetime
import json
import os
from typing import Any


def filter_waived_findings(project_dir: str, over_findings: list[dict[str, Any]]) -> tuple[list[str], list[str]]:
    waiver_path = f"{project_dir}/security-waivers.json"
    if not os.path.exists(waiver_path):
        return [f["id"] for f in over_findings], []
    with open(waiver_path, "r", encoding="utf-8") as fh:
        waivers = json.loads(fh.read())
    today = datetime.date.today().isoformat()
    blocked: list[str] = []
    waived: list[str] = []
    for f in over_findings:
        fid = f["id"]
        exp = waivers.get(fid)
        if isinstance(exp, str) and exp >= today:
            waived.append(fid)
        else:
            blocked.append(fid)
    return blocked, waived
''' + _large_unused_block("Waiver", 3),
        "sec_scanner/sbom/writer.py": '''"""CycloneDX-style JSON SBOM writer."""

from __future__ import annotations

import json
import uuid


def write_sbom_document(project_dir: str, components: list[str], findings: list[dict], gate: dict) -> str:
    serial = f"urn:uuid:{uuid.uuid4()}"
    doc = {
        "serial": serial,
        "components": components,
        "findings": findings,
        "passed": gate["passed"],
    }
    path = f"{project_dir}/sbom.json"
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(json.dumps(doc, sort_keys=True))
    return path
''',
    }
    _add_distractors(
        files,
        "sec_scanner",
        [
            ("ecosystems", ["pypi_meta", "npm_lock", "cargo_lock", "go_mod", "maven_pom"], ["pkg", "version", "digest"]),
            ("remediation", ["pr_planner", "upgrade_solver", "pin_advisor", "patch_diff"], ["pkg", "from_v", "to_v"]),
            ("reporters", ["sarif_out", "junit_out", "markdown_summary", "slack_alert"], ["finding_id", "severity", "path"]),
            ("licenses", ["spdx_table", "copyleft_check", "notice_gen"], ["license", "pkg", "allowed"]),
        ],
        extra_subpackages=6,
        mods_per_extra=8,
    )

    lock_json = json.dumps({
        "lockfileVersion": 2,
        "packages": [
            {"name": "app-web", "version": "1.0.0", "deps": ["http-kit", "tmpl-core"], "direct": True},
            {"name": "http-kit", "version": "2.3.1", "deps": ["codec-mini"], "direct": True},
            {"name": "tmpl-core", "version": "1.8.0", "deps": ["codec-mini"], "direct": False},
            {"name": "codec-mini", "version": "0.9.4", "deps": [], "direct": False},
        ],
    })
    osv_req_body = json.dumps({
        "queries": [
            {"name": "app-web", "version": "1.0.0"},
            {"name": "http-kit", "version": "2.3.1"},
            {"name": "tmpl-core", "version": "1.8.0"},
            {"name": "codec-mini", "version": "0.9.4"},
        ]
    }, sort_keys=True)
    topo_expected = ["codec-mini", "http-kit", "tmpl-core", "app-web"]

    # Variant 1: Low/Medium advisories -> passes without loading waiver.py!
    adv1 = [{"id": "CVE-2026-1001", "package": "tmpl-core", "cvss": 5.4}]
    findings1 = [{"direct": False, "effective_cvss": 5.4, "id": "CVE-2026-1001", "package": "tmpl-core", "severity": "MEDIUM"}]
    sbom1 = json.dumps({"components": topo_expected, "findings": findings1, "passed": True, "serial": "urn:uuid:aaaa1111-bbbb-4ccc-8ddd-eeeeeeee0001"}, sort_keys=True)
    t1 = {
        "id": "lc65k-py-sec-scanner-pass-low",
        "family": "lc65k-py-repo:sec_scanner",
        "language": "py",
        "files": files,
        "entryFile": "sec_scanner/engine/audit.py",
        "entry": "run",
        "args": ["/work/app", 7.0],
        "fixture": {
            "calls": [
                {"operation": "fs.readText", "arguments": ["/work/app/deps.lock.json"], "status": "fulfilled", "result": lock_json},
                {"operation": "env.get", "arguments": ["OSV_API_URL"], "status": "fulfilled", "result": "https://api.osv.internal/v1/querybatch"},
                {"operation": "http.request", "arguments": [{"method": "POST", "url": "https://api.osv.internal/v1/querybatch", "headers": {"Content-type": "application/json"}, "body": osv_req_body}], "status": "fulfilled", "result": {"status": 200, "url": "https://api.osv.internal/v1/querybatch", "headers": {}, "body": json.dumps({"advisories": adv1})}},
                {"operation": "platform.uuid", "arguments": [], "status": "fulfilled", "result": "aaaa1111-bbbb-4ccc-8ddd-eeeeeeee0001"},
                {"operation": "fs.writeText", "arguments": ["/work/app/sbom.json", sbom1], "status": "fulfilled", "result": None},
            ]
        },
        "features": ["multifile-codebase", "code-load", "effectful", "causal-branch", "http", "fs", "env", "uuid"],
    }

    # Variant 2: Critical CVE + expired waiver -> loads waiver.py, blocks build (causal pair B!)
    adv2 = [{"id": "CVE-2026-9901", "package": "http-kit", "cvss": 8.8}]
    findings2 = [{"direct": True, "effective_cvss": 9.3, "id": "CVE-2026-9901", "package": "http-kit", "severity": "CRITICAL"}]
    sbom2 = json.dumps({"components": topo_expected, "findings": findings2, "passed": False, "serial": "urn:uuid:aaaa1111-bbbb-4ccc-8ddd-eeeeeeee0002"}, sort_keys=True)
    t2 = {
        "id": "lc65k-py-sec-scanner-block-critical",
        "family": "lc65k-py-repo:sec_scanner",
        "language": "py",
        "files": files,
        "entryFile": "sec_scanner/engine/audit.py",
        "entry": "run",
        "args": ["/work/app", 7.0],
        "fixture": {
            "calls": [
                {"operation": "fs.readText", "arguments": ["/work/app/deps.lock.json"], "status": "fulfilled", "result": lock_json},
                {"operation": "env.get", "arguments": ["OSV_API_URL"], "status": "fulfilled", "result": "https://api.osv.internal/v1/querybatch"},
                {"operation": "http.request", "arguments": [{"method": "POST", "url": "https://api.osv.internal/v1/querybatch", "headers": {"Content-type": "application/json"}, "body": osv_req_body}], "status": "fulfilled", "result": {"status": 200, "url": "https://api.osv.internal/v1/querybatch", "headers": {}, "body": json.dumps({"advisories": adv2})}},
                {"operation": "fs.exists", "arguments": ["/work/app/security-waivers.json"], "status": "fulfilled", "result": True},
                {"operation": "fs.readText", "arguments": ["/work/app/security-waivers.json"], "status": "fulfilled", "result": json.dumps({"CVE-2026-9901": "2026-10-01"})},
                {"operation": "platform.time", "arguments": [], "status": "fulfilled", "result": 1795766400.0},
                {"operation": "platform.uuid", "arguments": [], "status": "fulfilled", "result": "aaaa1111-bbbb-4ccc-8ddd-eeeeeeee0002"},
                {"operation": "fs.writeText", "arguments": ["/work/app/sbom.json", sbom2], "status": "fulfilled", "result": None},
            ]
        },
        "features": ["multifile-codebase", "code-load", "effectful", "causal-branch", "http", "fs", "env", "uuid", "time"],
    }

    # Variant 3: Critical CVE + valid unexpired waiver -> passes with warning log!
    sbom3 = json.dumps({"components": topo_expected, "findings": findings2, "passed": True, "serial": "urn:uuid:aaaa1111-bbbb-4ccc-8ddd-eeeeeeee0003"}, sort_keys=True)
    t3 = {
        "id": "lc65k-py-sec-scanner-waived-pass",
        "family": "lc65k-py-repo:sec_scanner",
        "language": "py",
        "files": files,
        "entryFile": "sec_scanner/engine/audit.py",
        "entry": "run",
        "args": ["/work/app", 7.0],
        "fixture": {
            "calls": [
                {"operation": "fs.readText", "arguments": ["/work/app/deps.lock.json"], "status": "fulfilled", "result": lock_json},
                {"operation": "env.get", "arguments": ["OSV_API_URL"], "status": "fulfilled", "result": "https://api.osv.internal/v1/querybatch"},
                {"operation": "http.request", "arguments": [{"method": "POST", "url": "https://api.osv.internal/v1/querybatch", "headers": {"Content-type": "application/json"}, "body": osv_req_body}], "status": "fulfilled", "result": {"status": 200, "url": "https://api.osv.internal/v1/querybatch", "headers": {}, "body": json.dumps({"advisories": adv2})}},
                {"operation": "fs.exists", "arguments": ["/work/app/security-waivers.json"], "status": "fulfilled", "result": True},
                {"operation": "fs.readText", "arguments": ["/work/app/security-waivers.json"], "status": "fulfilled", "result": json.dumps({"CVE-2026-9901": "2026-12-31"})},
                {"operation": "platform.time", "arguments": [], "status": "fulfilled", "result": 1795766400.0},
                {"operation": "platform.log", "arguments": ["WARNING", "applied security waivers: CVE-2026-9901"], "status": "fulfilled", "result": None},
                {"operation": "platform.uuid", "arguments": [], "status": "fulfilled", "result": "aaaa1111-bbbb-4ccc-8ddd-eeeeeeee0003"},
                {"operation": "fs.writeText", "arguments": ["/work/app/sbom.json", sbom3], "status": "fulfilled", "result": None},
            ]
        },
        "features": ["multifile-codebase", "code-load", "effectful", "causal-branch", "http", "fs", "env", "uuid", "time", "logging"],
    }
    return [t1, t2, t3]


# ===========================================================================
# Repo 5: async_crawler — Async Webhook Dispatcher & Rate-Limited Poller
# ===========================================================================

def _build_async_crawler() -> list[dict[str, Any]]:
    files: dict[str, str] = {
        "async_crawler/__init__.py": '"""Async polling, extraction, SQLite job queue, and webhook delivery engine."""\n',
        "async_crawler/runtime/__init__.py": "",
        "async_crawler/config/__init__.py": "",
        "async_crawler/queue/__init__.py": "",
        "async_crawler/http/__init__.py": "",
        "async_crawler/parser/__init__.py": "",
        "async_crawler/ratelimit/__init__.py": "",
        "async_crawler/retry/__init__.py": "",
        "async_crawler/delivery/__init__.py": "",
        "async_crawler/runtime/orchestrator.py": '''"""Async crawl-and-dispatch orchestrator."""

from __future__ import annotations

import asyncio

from async_crawler.config.settings import load_crawler_settings
from async_crawler.delivery.webhook import dispatch_webhook_summary
from async_crawler.http.fetcher import fetch_endpoint
from async_crawler.parser.extractor import FeedExtractor
from async_crawler.queue.memory_db import JobQueueDB
from async_crawler.ratelimit.bucket import TokenBucket


async def run(targets: list[str]) -> dict:
    """Async entrypoint: enqueue targets, rate-limit fetch, extract items, and deliver webhook."""
    cfg = load_crawler_settings()
    db = JobQueueDB()
    for idx, url in enumerate(targets):
        db.enqueue(f"job-{idx + 1}", url)

    bucket = TokenBucket(capacity=cfg["burst"], refill_rate=cfg["rps"])
    extractor = FeedExtractor(min_priority=cfg["min_priority"])

    delivered_items: list[dict] = []
    deadletters: list[str] = []

    while True:
        job = db.next_pending()
        if job is None:
            break
        await asyncio.sleep(0)
        bucket.consume(1.0)
        res = fetch_endpoint(job["url"])
        if not res["ok"]:
            from async_crawler.retry.backoff import retry_with_backoff

            res = retry_with_backoff(job["url"], max_retries=cfg["max_retries"])

        if res["ok"]:
            items = extractor.extract(res["body"], source=job["url"])
            delivered_items.extend(items)
            db.mark_done(job["id"], len(items))
        else:
            db.mark_deadletter(job["id"], res["error"])
            deadletters.append(job["id"])

    stats = db.summary()
    db.close()

    webhook_status = dispatch_webhook_summary(cfg["webhook_url"], delivered_items, deadletters)
    return {
        "queue_stats": stats,
        "item_count": len(delivered_items),
        "items": delivered_items,
        "deadletters": deadletters,
        "webhook_status": webhook_status,
    }
''',
        "async_crawler/config/settings.py": '''"""Environment settings for async crawler."""

from __future__ import annotations

import os


def load_crawler_settings() -> dict:
    return {
        "webhook_url": os.getenv("CRAWLER_WEBHOOK_URL") or "https://hooks.internal/ingest",
        "max_retries": int(os.getenv("CRAWLER_MAX_RETRIES") or "1"),
        "min_priority": int(os.getenv("CRAWLER_MIN_PRIORITY") or "2"),
        "burst": 4.0,
        "rps": 2.0,
    }
''',
        "async_crawler/queue/memory_db.py": '''"""In-memory SQLite job queue with status transitions."""

from __future__ import annotations

import sqlite3
from typing import Any


class JobQueueDB:
    def __init__(self) -> None:
        self._conn = sqlite3.connect(":memory:")
        self._conn.execute(
            "CREATE TABLE jobs (id TEXT PRIMARY KEY, url TEXT, status TEXT, items INTEGER, error TEXT)"
        )

    def enqueue(self, job_id: str, url: str) -> None:
        self._conn.execute("INSERT INTO jobs VALUES (?, ?, 'pending', 0, '')", (job_id, url))
        self._conn.commit()

    def next_pending(self) -> dict[str, Any] | None:
        cur = self._conn.execute(
            "SELECT id, url FROM jobs WHERE status = 'pending' ORDER BY id LIMIT 1"
        )
        row = cur.fetchone()
        if row is None:
            return None
        return {"id": str(row[0]), "url": str(row[1])}

    def mark_done(self, job_id: str, item_count: int) -> None:
        self._conn.execute("UPDATE jobs SET status = 'done', items = ? WHERE id = ?", (item_count, job_id))
        self._conn.commit()

    def mark_deadletter(self, job_id: str, error: str) -> None:
        self._conn.execute("UPDATE jobs SET status = 'deadletter', error = ? WHERE id = ?", (error, job_id))
        self._conn.commit()

    def summary(self) -> dict[str, int]:
        cur = self._conn.execute("SELECT status, COUNT(*) FROM jobs GROUP BY status ORDER BY status")
        return {str(st): int(cnt) for st, cnt in cur.fetchall()}

    def close(self) -> None:
        self._conn.close()
''',
        "async_crawler/ratelimit/bucket.py": '''"""Monotonic-clock token bucket rate limiter."""

from __future__ import annotations

import time


class TokenBucket:
    def __init__(self, capacity: float, refill_rate: float) -> None:
        self.capacity = capacity
        self.refill_rate = refill_rate
        self.tokens = capacity
        self.last_ts = time.monotonic()

    def consume(self, amount: float) -> float:
        now = time.monotonic()
        elapsed = max(0.0, now - self.last_ts)
        self.tokens = min(self.capacity, self.tokens + elapsed * self.refill_rate)
        self.last_ts = now
        self.tokens = max(0.0, self.tokens - amount)
        return round(self.tokens, 3)
''',
        "async_crawler/http/fetcher.py": '''"""HTTP feed fetcher."""

from __future__ import annotations

import urllib.request


def fetch_endpoint(url: str) -> dict:
    try:
        with urllib.request.urlopen(url) as resp:
            body = resp.read().decode("utf-8")
            if resp.status >= 400:
                return {"ok": False, "error": f"http-{resp.status}"}
            return {"ok": True, "body": body}
    except Exception as exc:
        return {"ok": False, "error": str(exc)}
''',
        "async_crawler/retry/backoff.py": '''"""Retry helper invoked only when initial fetch fails."""

from __future__ import annotations

import logging

from async_crawler.http.fetcher import fetch_endpoint


def retry_with_backoff(url: str, max_retries: int) -> dict:
    last_err = "unknown"
    for attempt in range(1, max_retries + 1):
        logging.warning(f"retrying {url} attempt={attempt}")
        res = fetch_endpoint(url)
        if res["ok"]:
            return res
        last_err = res["error"]
    return {"ok": False, "error": last_err}
''' + _large_unused_block("Retry", 3),
        "async_crawler/parser/extractor.py": '''"""Structured JSON feed extractor with priority filtering and deduplication."""

from __future__ import annotations

import json
from typing import Any


class FeedExtractor:
    def __init__(self, min_priority: int = 1) -> None:
        self.min_priority = min_priority
        self._seen: set[str] = set()

    def extract(self, body: str, *, source: str) -> list[dict[str, Any]]:
        data = json.loads(body)
        results: list[dict[str, Any]] = []
        for entry in data.get("entries", []):
            eid = str(entry["id"])
            prio = int(entry.get("priority", 0))
            if prio < self.min_priority or eid in self._seen:
                continue
            self._seen.add(eid)
            results.append({
                "id": eid,
                "title": str(entry["title"]).strip(),
                "priority": prio,
                "source": source,
            })
        return results
''' + _class_domain_methods("FeedExtractor", 10) + _large_unused_block("Extractor", 4),
        "async_crawler/delivery/webhook.py": '''"""Signed webhook delivery client."""

from __future__ import annotations

import hashlib
import json
import logging
import secrets
import urllib.request


def dispatch_webhook_summary(webhook_url: str, items: list[dict], deadletters: list[str]) -> int:
    nonce = secrets.token_hex(4)
    payload_str = json.dumps({"nonce": nonce, "count": len(items), "deadletters": deadletters}, sort_keys=True)
    sig = hashlib.sha256(payload_str.encode("utf-8")).hexdigest()[:16]
    req = urllib.request.Request(
        webhook_url,
        data=payload_str.encode("utf-8"),
        headers={"Content-Type": "application/json", "X-Signature": sig},
        method="POST",
    )
    logging.info(f"dispatching webhook count={len(items)} deadletters={len(deadletters)}")
    with urllib.request.urlopen(req) as resp:
        return int(resp.status)
''',
    }
    _add_distractors(
        files,
        "async_crawler",
        [
            ("sinks", ["kafka_sink", "pubsub_sink", "file_sink", "redis_stream"], ["topic", "partition", "offset"]),
            ("robots", ["txt_parser", "crawl_delay", "sitemap_walk"], ["host", "agent", "allow"]),
            ("metrics", ["prom_export", "latency_hist", "health_server", "trace_span"], ["metric", "labels", "value"]),
            ("storage", ["etag_cache", "dns_cache", "cookie_jar"], ["key", "etag", "expires"]),
        ],
        extra_subpackages=7,
        mods_per_extra=8,
    )

    feed_a = json.dumps({"entries": [{"id": "n1", "title": "  Core Patch ", "priority": 3}, {"id": "n2", "title": "Low Noise", "priority": 1}]})
    feed_b = json.dumps({"entries": [{"id": "n1", "title": "Core Patch Dup", "priority": 3}, {"id": "n3", "title": "Release Cut", "priority": 4}]})

    def _wh_req(nonce: str, count: int, deadletters: list[str]) -> dict[str, Any]:
        import hashlib
        ps = json.dumps({"nonce": nonce, "count": count, "deadletters": deadletters}, sort_keys=True)
        sig = hashlib.sha256(ps.encode("utf-8")).hexdigest()[:16]
        return {"method": "POST", "url": "https://hooks.internal/ingest", "headers": {"Content-type": "application/json", "X-signature": sig}, "body": ps}

    t1 = {
        "id": "lc65k-py-async-crawler-happy",
        "family": "lc65k-py-repo:async_crawler",
        "language": "py",
        "files": files,
        "entryFile": "async_crawler/runtime/orchestrator.py",
        "entry": "run",
        "args": [["https://feeds.internal/a.json", "https://feeds.internal/b.json"]],
        "fixture": {
            "calls": [
                {"operation": "env.get", "arguments": ["CRAWLER_WEBHOOK_URL"], "status": "fulfilled", "result": "https://hooks.internal/ingest"},
                {"operation": "env.get", "arguments": ["CRAWLER_MAX_RETRIES"], "status": "fulfilled", "result": "1"},
                {"operation": "env.get", "arguments": ["CRAWLER_MIN_PRIORITY"], "status": "fulfilled", "result": "2"},
                {"operation": "platform.time", "arguments": [], "status": "fulfilled", "result": 100.0},
                {"operation": "platform.time", "arguments": [], "status": "fulfilled", "result": 100.5},
                {"operation": "http.request", "arguments": [{"method": "GET", "url": "https://feeds.internal/a.json"}], "status": "fulfilled", "result": {"status": 200, "url": "https://feeds.internal/a.json", "headers": {}, "body": feed_a}},
                {"operation": "platform.time", "arguments": [], "status": "fulfilled", "result": 101.0},
                {"operation": "http.request", "arguments": [{"method": "GET", "url": "https://feeds.internal/b.json"}], "status": "fulfilled", "result": {"status": 200, "url": "https://feeds.internal/b.json", "headers": {}, "body": feed_b}},
                {"operation": "platform.secrets", "arguments": ["token_hex", 4], "status": "fulfilled", "result": "1234abcd"},
                {"operation": "platform.log", "arguments": ["INFO", "dispatching webhook count=2 deadletters=0"], "status": "fulfilled", "result": None},
                {"operation": "http.request", "arguments": [_wh_req("1234abcd", 2, [])], "status": "fulfilled", "result": {"status": 202, "url": "https://hooks.internal/ingest", "headers": {}, "body": "accepted"}},
            ]
        },
        "features": ["multifile-codebase", "code-load", "effectful", "causal-branch", "async", "sqlite3", "http", "env", "secrets", "logging"],
    }

    # Variant 2: First feed returns 503 -> causal branch loads retry/backoff.py and recovers on retry!
    t2 = {
        "id": "lc65k-py-async-crawler-retry-recover",
        "family": "lc65k-py-repo:async_crawler",
        "language": "py",
        "files": files,
        "entryFile": "async_crawler/runtime/orchestrator.py",
        "entry": "run",
        "args": [["https://feeds.internal/a.json", "https://feeds.internal/b.json"]],
        "fixture": {
            "calls": [
                {"operation": "env.get", "arguments": ["CRAWLER_WEBHOOK_URL"], "status": "fulfilled", "result": "https://hooks.internal/ingest"},
                {"operation": "env.get", "arguments": ["CRAWLER_MAX_RETRIES"], "status": "fulfilled", "result": "1"},
                {"operation": "env.get", "arguments": ["CRAWLER_MIN_PRIORITY"], "status": "fulfilled", "result": "2"},
                {"operation": "platform.time", "arguments": [], "status": "fulfilled", "result": 100.0},
                {"operation": "platform.time", "arguments": [], "status": "fulfilled", "result": 100.5},
                {"operation": "http.request", "arguments": [{"method": "GET", "url": "https://feeds.internal/a.json"}], "status": "fulfilled", "result": {"status": 503, "url": "https://feeds.internal/a.json", "headers": {}, "body": "busy"}},
                {"operation": "platform.log", "arguments": ["WARNING", "retrying https://feeds.internal/a.json attempt=1"], "status": "fulfilled", "result": None},
                {"operation": "http.request", "arguments": [{"method": "GET", "url": "https://feeds.internal/a.json"}], "status": "fulfilled", "result": {"status": 200, "url": "https://feeds.internal/a.json", "headers": {}, "body": feed_a}},
                {"operation": "platform.time", "arguments": [], "status": "fulfilled", "result": 101.5},
                {"operation": "http.request", "arguments": [{"method": "GET", "url": "https://feeds.internal/b.json"}], "status": "fulfilled", "result": {"status": 200, "url": "https://feeds.internal/b.json", "headers": {}, "body": feed_b}},
                {"operation": "platform.secrets", "arguments": ["token_hex", 4], "status": "fulfilled", "result": "5678ef01"},
                {"operation": "platform.log", "arguments": ["INFO", "dispatching webhook count=2 deadletters=0"], "status": "fulfilled", "result": None},
                {"operation": "http.request", "arguments": [_wh_req("5678ef01", 2, [])], "status": "fulfilled", "result": {"status": 202, "url": "https://hooks.internal/ingest", "headers": {}, "body": "accepted"}},
            ]
        },
        "features": ["multifile-codebase", "code-load", "effectful", "causal-branch", "async", "sqlite3", "http", "env", "secrets", "logging"],
    }

    # Variant 3: First feed fails permanently -> deadletter recorded in SQLite & webhook!
    t3 = {
        "id": "lc65k-py-async-crawler-deadletter",
        "family": "lc65k-py-repo:async_crawler",
        "language": "py",
        "files": files,
        "entryFile": "async_crawler/runtime/orchestrator.py",
        "entry": "run",
        "args": [["https://feeds.internal/a.json", "https://feeds.internal/b.json"]],
        "fixture": {
            "calls": [
                {"operation": "env.get", "arguments": ["CRAWLER_WEBHOOK_URL"], "status": "fulfilled", "result": "https://hooks.internal/ingest"},
                {"operation": "env.get", "arguments": ["CRAWLER_MAX_RETRIES"], "status": "fulfilled", "result": "1"},
                {"operation": "env.get", "arguments": ["CRAWLER_MIN_PRIORITY"], "status": "fulfilled", "result": "2"},
                {"operation": "platform.time", "arguments": [], "status": "fulfilled", "result": 100.0},
                {"operation": "platform.time", "arguments": [], "status": "fulfilled", "result": 100.5},
                {"operation": "http.request", "arguments": [{"method": "GET", "url": "https://feeds.internal/a.json"}], "status": "fulfilled", "result": {"status": 500, "url": "https://feeds.internal/a.json", "headers": {}, "body": "err"}},
                {"operation": "platform.log", "arguments": ["WARNING", "retrying https://feeds.internal/a.json attempt=1"], "status": "fulfilled", "result": None},
                {"operation": "http.request", "arguments": [{"method": "GET", "url": "https://feeds.internal/a.json"}], "status": "fulfilled", "result": {"status": 500, "url": "https://feeds.internal/a.json", "headers": {}, "body": "err"}},
                {"operation": "platform.time", "arguments": [], "status": "fulfilled", "result": 101.5},
                {"operation": "http.request", "arguments": [{"method": "GET", "url": "https://feeds.internal/b.json"}], "status": "fulfilled", "result": {"status": 200, "url": "https://feeds.internal/b.json", "headers": {}, "body": feed_b}},
                {"operation": "platform.secrets", "arguments": ["token_hex", 4], "status": "fulfilled", "result": "aa11bb22"},
                {"operation": "platform.log", "arguments": ["INFO", "dispatching webhook count=2 deadletters=1"], "status": "fulfilled", "result": None},
                {"operation": "http.request", "arguments": [_wh_req("aa11bb22", 2, ["job-1"])], "status": "fulfilled", "result": {"status": 202, "url": "https://hooks.internal/ingest", "headers": {}, "body": "accepted"}},
            ]
        },
        "features": ["multifile-codebase", "code-load", "effectful", "causal-branch", "async", "sqlite3", "http", "env", "secrets", "logging"],
    }
    return [t1, t2, t3]


# ===========================================================================
# Repo 6: billing_engine — Usage-Based SaaS Metering, Rating & Invoice Compiler
# ===========================================================================

def _build_billing_engine() -> list[dict[str, Any]]:
    files: dict[str, str] = {
        "billing_engine/__init__.py": '"""Usage-based SaaS metering, tiered rating, tax, and invoice compiler."""\n',
        "billing_engine/jobs/__init__.py": "",
        "billing_engine/catalog/__init__.py": "",
        "billing_engine/metering/__init__.py": "",
        "billing_engine/discounts/__init__.py": "",
        "billing_engine/tax/__init__.py": "",
        "billing_engine/invoicing/__init__.py": "",
        "billing_engine/storage/__init__.py": "",
        "billing_engine/jobs/close_cycle.py": '''"""Billing cycle close orchestrator."""

from __future__ import annotations

from billing_engine.catalog.plans import TieredPlanRater
from billing_engine.discounts.coupons import CouponEngine
from billing_engine.invoicing.renderer import InvoiceRenderer
from billing_engine.metering.aggregator import UsageMeteringDB
from billing_engine.storage.archive import archive_invoice
from billing_engine.tax.calculator import fetch_tax_rate


def run(account_id: str, plan_name: str, events: list[dict], coupon_code: str | None) -> dict:
    """Aggregate usage in SQLite, rate tiers, apply coupons & tax, render and archive invoice."""
    meter = UsageMeteringDB()
    meter.ingest_events(events)
    totals = meter.summarize_by_metric()
    meter.close()

    rater = TieredPlanRater()
    line_items = rater.rate_usage(plan_name, totals)
    subtotal_cents = sum(item["amount_cents"] for item in line_items)

    coupons = CouponEngine()
    discount_cents = coupons.compute_discount(coupon_code, subtotal_cents)
    net_cents = subtotal_cents - discount_cents

    tax_info = fetch_tax_rate(account_id)
    tax_cents = int(round(max(0, net_cents) * tax_info["rate"]))
    grand_total_cents = net_cents + tax_cents

    if grand_total_cents < 0:
        from billing_engine.invoicing.credit_memo import build_credit_memo

        doc = build_credit_memo(account_id, plan_name, grand_total_cents)
    else:
        renderer = InvoiceRenderer()
        doc = renderer.build_invoice(
            account_id=account_id,
            plan_name=plan_name,
            line_items=line_items,
            discount_cents=discount_cents,
            tax_cents=tax_cents,
            grand_total_cents=grand_total_cents,
            jurisdiction=tax_info["jurisdiction"],
        )

    archive_path = archive_invoice(account_id, doc)
    return {
        "doc_type": doc["type"],
        "account_id": account_id,
        "subtotal_cents": subtotal_cents,
        "discount_cents": discount_cents,
        "tax_cents": tax_cents,
        "grand_total_cents": grand_total_cents,
        "archive_path": archive_path,
    }
''',
        "billing_engine/metering/aggregator.py": '''"""In-memory SQLite usage metering bucket aggregator."""

from __future__ import annotations

import sqlite3


class UsageMeteringDB:
    def __init__(self) -> None:
        self._conn = sqlite3.connect(":memory:")
        self._conn.execute("CREATE TABLE usage_events (metric TEXT, units INTEGER)")

    def ingest_events(self, events: list[dict]) -> None:
        self._conn.executemany(
            "INSERT INTO usage_events VALUES (?, ?)",
            [(e["metric"], int(e["units"])) for e in events],
        )
        self._conn.commit()

    def summarize_by_metric(self) -> dict[str, int]:
        cur = self._conn.execute(
            "SELECT metric, SUM(units) FROM usage_events GROUP BY metric ORDER BY metric"
        )
        return {str(m): int(u) for m, u in cur.fetchall()}

    def close(self) -> None:
        self._conn.close()
''',
        "billing_engine/catalog/plans.py": '''"""Tiered SaaS pricing plans and overage rating engine."""

from __future__ import annotations

from typing import Any

PLAN_TIERS: dict[str, dict[str, Any]] = {
    "starter": {"base_cents": 2900, "api_calls": (1000, 2), "storage_gb": (20, 50)},
    "enterprise": {"base_cents": 19900, "api_calls": (10000, 1), "storage_gb": (200, 30)},
}


class TieredPlanRater:
    def rate_usage(self, plan_name: str, usage: dict[str, int]) -> list[dict[str, Any]]:
        if plan_name not in PLAN_TIERS:
            raise KeyError(f"Unknown plan {plan_name}")
        plan = PLAN_TIERS[plan_name]
        items = [{"code": f"base:{plan_name}", "units": 1, "amount_cents": plan["base_cents"]}]
        for metric in sorted(usage):
            if metric not in plan:
                continue
            included, unit_price = plan[metric]
            overage = max(0, int(usage[metric]) - included)
            items.append({
                "code": f"overage:{metric}",
                "units": overage,
                "amount_cents": overage * unit_price,
            })
        return items
''' + _class_domain_methods("TieredPlanRater", 9) + _large_unused_block("PlanCatalog", 4),
        "billing_engine/discounts/coupons.py": '''"""Coupon validation and discount computation."""

from __future__ import annotations

from typing import Any

COUPONS: dict[str, dict[str, Any]] = {
    "LAUNCH20": {"kind": "percent", "value": 20},
    "CREDIT500": {"kind": "fixed_cents", "value": 50000},
}


class CouponEngine:
    def compute_discount(self, code: str | None, subtotal_cents: int) -> int:
        if not code:
            return 0
        spec = COUPONS.get(code)
        if spec is None:
            raise ValueError(f"Unknown coupon {code}")
        if spec["kind"] == "percent":
            return int(round(subtotal_cents * spec["value"] / 100.0))
        return int(spec["value"])
''' + _class_domain_methods("CouponEngine", 9) + _large_unused_block("Coupon", 4),
        "billing_engine/tax/calculator.py": '''"""Remote tax rate lookup with strict/fallback env control."""

from __future__ import annotations

import json
import logging
import os
import urllib.request


def fetch_tax_rate(account_id: str) -> dict:
    strict = os.getenv("BILLING_STRICT_TAX") == "1"
    url = f"https://tax.internal/v1/rate?account={account_id}"
    try:
        with urllib.request.urlopen(url) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except Exception as exc:
        if strict:
            logging.error(f"strict tax lookup failed for {account_id}: {exc}")
            raise RuntimeError(f"Tax service unavailable: {exc}") from exc
        logging.warning(f"tax lookup failed for {account_id}; defaulting to 0%")
        return {"jurisdiction": "FALLBACK", "rate": 0.0}
''',
        "billing_engine/invoicing/renderer.py": '''"""Structured invoice compiler."""

from __future__ import annotations

from typing import Any


class InvoiceRenderer:
    def build_invoice(
        self,
        *,
        account_id: str,
        plan_name: str,
        line_items: list[dict[str, Any]],
        discount_cents: int,
        tax_cents: int,
        grand_total_cents: int,
        jurisdiction: str,
    ) -> dict[str, Any]:
        return {
            "type": "invoice",
            "account_id": account_id,
            "plan": plan_name,
            "line_items": line_items,
            "discount_cents": discount_cents,
            "tax_cents": tax_cents,
            "grand_total_cents": grand_total_cents,
            "jurisdiction": jurisdiction,
        }
''' + _class_domain_methods("InvoiceRenderer", 9) + _large_unused_block("Invoice", 4),
        "billing_engine/invoicing/credit_memo.py": '''"""Credit memo builder used when discounts exceed subtotal."""

from __future__ import annotations


def build_credit_memo(account_id: str, plan_name: str, net_cents: int) -> dict:
    return {
        "type": "credit_memo",
        "account_id": account_id,
        "plan": plan_name,
        "credit_cents": abs(net_cents),
    }
''' + _large_unused_block("CreditMemo", 3),
        "billing_engine/storage/archive.py": '''"""Invoice archival writer with timestamped directory layout."""

from __future__ import annotations

import datetime
import json
import logging


def archive_invoice(account_id: str, doc: dict) -> str:
    day = datetime.date.today().isoformat()
    path = f"/var/billing/{day}/{account_id}-{doc['type']}.json"
    logging.info(f"archiving {doc['type']} to {path}")
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(json.dumps(doc, sort_keys=True))
    return path
''',
    }
    _add_distractors(
        files,
        "billing_engine",
        [
            ("gateways", ["stripe_client", "adyen_client", "ach_debit", "sepa_wire", "webhook_verify"], ["customer", "charge_id", "status"]),
            ("dunning", ["retry_schedule", "grace_period", "suspension", "reminder_mail"], ["account", "attempt", "days"]),
            ("exports", ["netsuite_csv", "xero_sync", "revrec_asc606", "pdf_stub"], ["invoice_id", "gl_code", "amount"]),
            ("proration", ["midcycle_upgrade", "seat_delta", "annual_prep"], ["plan", "days", "ratio"]),
        ],
        extra_subpackages=8,
        mods_per_extra=8,
    )

    events_ent = [
        {"metric": "api_calls", "units": 7000},
        {"metric": "api_calls", "units": 5500},
        {"metric": "storage_gb", "units": 240},
    ]
    # Enterprise: base 19900 + api_calls overage (12500-10000)*1=2500 + storage (240-200)*30=1200 => subtotal=23600
    # LAUNCH20 => discount=4720 => net=18880; tax 10% => 1888; grand=20768
    inv1 = json.dumps({
        "account_id": "acct-900",
        "discount_cents": 4720,
        "grand_total_cents": 20768,
        "jurisdiction": "US-CA",
        "line_items": [
            {"amount_cents": 19900, "code": "base:enterprise", "units": 1},
            {"amount_cents": 2500, "code": "overage:api_calls", "units": 2500},
            {"amount_cents": 1200, "code": "overage:storage_gb", "units": 40},
        ],
        "plan": "enterprise",
        "tax_cents": 1888,
        "type": "invoice",
    }, sort_keys=True)
    t1 = {
        "id": "lc65k-py-billing-enterprise-ok",
        "family": "lc65k-py-repo:billing_engine",
        "language": "py",
        "files": files,
        "entryFile": "billing_engine/jobs/close_cycle.py",
        "entry": "run",
        "args": ["acct-900", "enterprise", events_ent, "LAUNCH20"],
        "fixture": {
            "calls": [
                {"operation": "env.get", "arguments": ["BILLING_STRICT_TAX"], "status": "fulfilled", "result": "1"},
                {"operation": "http.request", "arguments": [{"method": "GET", "url": "https://tax.internal/v1/rate?account=acct-900"}], "status": "fulfilled", "result": {"status": 200, "url": "https://tax.internal/v1/rate?account=acct-900", "headers": {}, "body": json.dumps({"jurisdiction": "US-CA", "rate": 0.10})}},
                {"operation": "platform.time", "arguments": [], "status": "fulfilled", "result": 1795766400.0},
                {"operation": "platform.log", "arguments": ["INFO", "archiving invoice to /var/billing/2026-11-27/acct-900-invoice.json"], "status": "fulfilled", "result": None},
                {"operation": "fs.writeText", "arguments": ["/var/billing/2026-11-27/acct-900-invoice.json", inv1], "status": "fulfilled", "result": None},
            ]
        },
        "features": ["multifile-codebase", "code-load", "effectful", "causal-branch", "sqlite3", "http", "fs", "env", "logging"],
    }

    # Variant 2: Tax service offline with strict=1 -> throws RuntimeError (causal pair B!)
    t2 = {
        "id": "lc65k-py-billing-strict-tax-throw",
        "family": "lc65k-py-repo:billing_engine",
        "language": "py",
        "files": files,
        "entryFile": "billing_engine/jobs/close_cycle.py",
        "entry": "run",
        "args": ["acct-900", "enterprise", events_ent, "LAUNCH20"],
        "fixture": {
            "calls": [
                {"operation": "env.get", "arguments": ["BILLING_STRICT_TAX"], "status": "fulfilled", "result": "1"},
                {"operation": "http.request", "arguments": [{"method": "GET", "url": "https://tax.internal/v1/rate?account=acct-900"}], "status": "rejected", "result": {"name": "URLError", "message": "tax api timeout"}},
                {"operation": "platform.log", "arguments": ["ERROR", "strict tax lookup failed for acct-900: <urlopen error tax api timeout>"], "status": "fulfilled", "result": None},
            ]
        },
        "features": ["multifile-codebase", "code-load", "effectful", "causal-branch", "exception", "sqlite3", "http", "env", "logging"],
    }

    # Variant 3: CREDIT500 exceeds subtotal -> causal branch loads credit_memo.py!
    cm3 = json.dumps({"account_id": "acct-900", "credit_cents": 26400, "plan": "enterprise", "type": "credit_memo"}, sort_keys=True)
    t3 = {
        "id": "lc65k-py-billing-credit-memo",
        "family": "lc65k-py-repo:billing_engine",
        "language": "py",
        "files": files,
        "entryFile": "billing_engine/jobs/close_cycle.py",
        "entry": "run",
        "args": ["acct-900", "enterprise", events_ent, "CREDIT500"],
        "fixture": {
            "calls": [
                {"operation": "env.get", "arguments": ["BILLING_STRICT_TAX"], "status": "fulfilled", "result": "0"},
                {"operation": "http.request", "arguments": [{"method": "GET", "url": "https://tax.internal/v1/rate?account=acct-900"}], "status": "rejected", "result": {"name": "URLError", "message": "offline"}},
                {"operation": "platform.log", "arguments": ["WARNING", "tax lookup failed for acct-900; defaulting to 0%"], "status": "fulfilled", "result": None},
                {"operation": "platform.time", "arguments": [], "status": "fulfilled", "result": 1795766400.0},
                {"operation": "platform.log", "arguments": ["INFO", "archiving credit_memo to /var/billing/2026-11-27/acct-900-credit_memo.json"], "status": "fulfilled", "result": None},
                {"operation": "fs.writeText", "arguments": ["/var/billing/2026-11-27/acct-900-credit_memo.json", cm3], "status": "fulfilled", "result": None},
            ]
        },
        "features": ["multifile-codebase", "code-load", "effectful", "causal-branch", "sqlite3", "http", "fs", "env", "logging"],
    }
    return [t1, t2, t3]


# ===========================================================================
# Repo 7: doc_indexer — Full-Text Search Indexer & Boolean Query Planner
# ===========================================================================

def _build_doc_indexer() -> list[dict[str, Any]]:
    files: dict[str, str] = {
        "doc_indexer/__init__.py": '"""Local markdown/text full-text search indexer with BM25 and boolean AST queries."""\n',
        "doc_indexer/cli/__init__.py": "",
        "doc_indexer/fs/__init__.py": "",
        "doc_indexer/text/__init__.py": "",
        "doc_indexer/index/__init__.py": "",
        "doc_indexer/query/__init__.py": "",
        "doc_indexer/cache/__init__.py": "",
        "doc_indexer/output/__init__.py": "",
        "doc_indexer/cli/search.py": '''"""Search CLI entrypoint."""

from __future__ import annotations

import os

from doc_indexer.cache.sqlite_idx import IndexMetadataDB
from doc_indexer.fs.crawler import read_corpus_dir
from doc_indexer.index.inverted import BM25InvertedIndex
from doc_indexer.output.formatter import write_search_report
from doc_indexer.query.parser import BooleanQueryParser
from doc_indexer.text.tokenizer import DocumentTokenizer


def run(docs_dir: str, query_str: str, top_k: int) -> dict:
    """Crawl documents, tokenize, build BM25 inverted index, parse boolean query, rank, and emit report."""
    title_boost = float(os.getenv("INDEX_TITLE_BOOST") or "1.5")
    docs = read_corpus_dir(docs_dir)

    tokenizer = DocumentTokenizer()
    index = BM25InvertedIndex(title_boost=title_boost)
    db = IndexMetadataDB()
    for doc in docs:
        tokens = tokenizer.tokenize(doc["body"])
        title_tokens = tokenizer.tokenize(doc["title"])
        index.add_document(doc["doc_id"], title_tokens, tokens)
        db.record_doc(doc["doc_id"], doc["title"], len(tokens))

    parser = BooleanQueryParser(tokenizer)
    plan = parser.parse(query_str)
    ranked = index.execute_plan(plan, top_k=top_k)

    snippets: dict[str, str] = {}
    if os.getenv("INDEX_HIGHLIGHT") == "1":
        from doc_indexer.output.highlighter import extract_snippet

        by_id = {d["doc_id"]: d["body"] for d in docs}
        for hit in ranked:
            snippets[hit["doc_id"]] = extract_snippet(by_id[hit["doc_id"]], plan["include"])

    stats = db.corpus_stats()
    db.close()

    report = {"query": query_str, "plan": plan, "stats": stats, "hits": ranked, "snippets": snippets}
    out_path = write_search_report(docs_dir, report)
    return {"hits": ranked, "snippets": snippets, "stats": stats, "report_path": out_path}
''',
        "doc_indexer/fs/crawler.py": r'''"""Filesystem document corpus loader."""

from __future__ import annotations

import os


def read_corpus_dir(docs_dir: str) -> list[dict]:
    docs: list[dict] = []
    for name in sorted(os.listdir(docs_dir)):
        full = f"{docs_dir}/{name}"
        if not name.endswith(".md") or not os.path.isfile(full):
            continue
        with open(full, "r", encoding="utf-8") as fh:
            text = fh.read()
        lines = text.splitlines()
        title = lines[0].lstrip("# ").strip() if lines else name
        body = "\n".join(lines[1:]) if len(lines) > 1 else text
        docs.append({"doc_id": name, "title": title, "body": body})
    return docs
''',
        "doc_indexer/text/tokenizer.py": '''"""Case-folding, stopword-filtering, and light-stemming tokenizer."""

from __future__ import annotations

import re
from typing import Any

STOPWORDS = frozenset({"the", "and", "for", "with", "that", "this", "from", "into", "are", "was"})
TOKEN_RE = re.compile(r"[A-Za-z0-9_]+")


class DocumentTokenizer:
    def stem(self, word: str) -> str:
        w = word.lower()
        for suf in ("ing", "ed", "es", "s"):
            if len(w) > len(suf) + 2 and w.endswith(suf):
                return w[: -len(suf)]
        return w

    def tokenize(self, text: str) -> list[str]:
        out: list[str] = []
        for raw in TOKEN_RE.findall(text):
            low = raw.lower()
            if len(low) < 2 or low in STOPWORDS:
                continue
            out.append(self.stem(low))
        return out
''' + _class_domain_methods("DocumentTokenizer", 18) + _large_unused_block("Tokenizer", 4),
        "doc_indexer/index/inverted.py": '''"""In-memory BM25 inverted index supporting include/exclude boolean plans."""

from __future__ import annotations

import math
from typing import Any


class BM25InvertedIndex:
    def __init__(self, k1: float = 1.5, b: float = 0.75, title_boost: float = 1.5) -> None:
        self.k1 = k1
        self.b = b
        self.title_boost = title_boost
        self.doc_tf: dict[str, dict[str, float]] = {}
        self.doc_len: dict[str, int] = {}
        self.postings: dict[str, set[str]] = {}

    def add_document(self, doc_id: str, title_tokens: list[str], body_tokens: list[str]) -> None:
        tf: dict[str, float] = {}
        for t in body_tokens:
            tf[t] = tf.get(t, 0.0) + 1.0
        for t in title_tokens:
            tf[t] = tf.get(t, 0.0) + self.title_boost
        self.doc_tf[doc_id] = tf
        self.doc_len[doc_id] = max(1, len(body_tokens) + len(title_tokens))
        for term in tf:
            self.postings.setdefault(term, set()).add(doc_id)

    def execute_plan(self, plan: dict[str, Any], *, top_k: int) -> list[dict[str, Any]]:
        n_docs = max(1, len(self.doc_tf))
        avg_dl = sum(self.doc_len.values()) / n_docs
        excluded: set[str] = set()
        for term in plan["exclude"]:
            excluded |= self.postings.get(term, set())

        candidates: set[str] = set()
        for term in plan["include"]:
            candidates |= self.postings.get(term, set())
        if plan["require_all"] and plan["include"]:
            for term in plan["include"]:
                candidates &= self.postings.get(term, set())
        candidates -= excluded

        scored: list[dict[str, Any]] = []
        for doc_id in sorted(candidates):
            score = 0.0
            dl = self.doc_len[doc_id]
            for term in plan["include"]:
                f = self.doc_tf[doc_id].get(term, 0.0)
                if f <= 0:
                    continue
                df = len(self.postings.get(term, ()))
                idf = math.log(1.0 + (n_docs - df + 0.5) / (df + 0.5))
                denom = f + self.k1 * (1.0 - self.b + self.b * (dl / avg_dl))
                score += idf * (f * (self.k1 + 1.0)) / denom
            scored.append({"doc_id": doc_id, "score": round(score, 4)})
        scored.sort(key=lambda r: (-r["score"], r["doc_id"]))
        return scored[:top_k]
''' + _class_domain_methods("BM25InvertedIndex", 18) + _large_unused_block("InvertedIdx", 4),
        "doc_indexer/query/parser.py": '''"""Boolean query parser supporting AND/OR and `-term` negation."""

from __future__ import annotations

from typing import Any


class BooleanQueryParser:
    def __init__(self, tokenizer: Any) -> None:
        self.tokenizer = tokenizer

    def parse(self, query_str: str) -> dict[str, Any]:
        parts = query_str.split()
        require_all = "AND" in parts
        include: list[str] = []
        exclude: list[str] = []
        for tok in parts:
            if tok in ("AND", "OR"):
                continue
            if tok.startswith("-") and len(tok) > 1:
                exclude.extend(self.tokenizer.tokenize(tok[1:]))
            else:
                include.extend(self.tokenizer.tokenize(tok))
        return {"include": include, "exclude": exclude, "require_all": require_all}
''' + _class_domain_methods("BooleanQueryParser", 16) + _large_unused_block("QueryParser", 3),
        "doc_indexer/cache/sqlite_idx.py": '''"""In-memory SQLite corpus metadata store."""

from __future__ import annotations

import sqlite3


class IndexMetadataDB:
    def __init__(self) -> None:
        self._conn = sqlite3.connect(":memory:")
        self._conn.execute("CREATE TABLE docs (doc_id TEXT PRIMARY KEY, title TEXT, tokens INTEGER)")

    def record_doc(self, doc_id: str, title: str, token_count: int) -> None:
        self._conn.execute("INSERT INTO docs VALUES (?, ?, ?)", (doc_id, title, token_count))
        self._conn.commit()

    def corpus_stats(self) -> dict:
        cur = self._conn.execute("SELECT COUNT(*), COALESCE(SUM(tokens), 0) FROM docs")
        cnt, tot = cur.fetchone()
        return {"doc_count": int(cnt), "total_tokens": int(tot)}

    def close(self) -> None:
        self._conn.close()
''',
        "doc_indexer/output/highlighter.py": r'''"""Snippet highlighter loaded only when INDEX_HIGHLIGHT=1."""

from __future__ import annotations


def extract_snippet(body: str, terms: list[str]) -> str:
    lower = body.lower()
    for term in terms:
        pos = lower.find(term)
        if pos >= 0:
            start = max(0, pos - 20)
            end = min(len(body), pos + 45)
            return body[start:end].replace("\n", " ").strip()
    return body[:60].replace("\n", " ").strip()
''' + _large_unused_block("Highlight", 3),
        "doc_indexer/output/formatter.py": '''"""Search report writer."""

from __future__ import annotations

import json
import logging


def write_search_report(docs_dir: str, report: dict) -> str:
    path = f"{docs_dir}/search-report.json"
    logging.info(f"writing search report hits={len(report['hits'])}")
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(json.dumps(report, sort_keys=True))
    return path
''',
    }
    _add_distractors(
        files,
        "doc_indexer",
        [
            ("analyzers", ["ngram_gen", "synonym_map", "lang_detect", "ascii_fold"], ["term", "lang", "weight"]),
            ("storage", ["mmap_stub", "segment_merge", "compactor", "wal_sync"], ["segment", "offset", "crc"]),
            ("api", ["rest_router", "grpc_stub", "facet_agg", "suggest_trie"], ["query", "facet", "limit"]),
            ("eval", ["ndcg_calc", "mrr_bench", "judgement_io"], ["qid", "doc_id", "rel"]),
        ],
        extra_subpackages=8,
        mods_per_extra=8,
    )

    doc_a = "# Python Async Cache\nFast caching engines in Python optimize latency and memory usage."
    doc_b = "# SQLite Query Tuning\nIndexed SQLite tables accelerate search queries and caching layers."
    doc_c = "# Legacy XML Parser\nDeprecated XML parsers are slow and excluded from modern pipelines."

    # We'll compute exact written report JSON dynamically by running helper or letting build harness verify;
    # Better yet, let's compute exact BM25 in Python via our own code? Wait — we can run a quick dry-run OR compute deterministically!
    # Actually, let's build a small helper `_record_exact_fs_writes`? NO — fixtures must be strictly deterministic and verified by export_python_example!
    # Wait: for `doc_indexer`, let's compute the exact BM25 report cleanly in Python or write a small pure helper in this builder!
    def _expected_doc_report(title_boost: float, query: str, top_k: int, highlight: bool) -> str:
        import math, re
        sw = {"the", "and", "for", "with", "that", "this", "from", "into", "are", "was"}
        def stem(w: str) -> str:
            w = w.lower()
            for suf in ("ing", "ed", "es", "s"):
                if len(w) > len(suf) + 2 and w.endswith(suf):
                    return w[:-len(suf)]
            return w
        def tok(t: str) -> list[str]:
            return [stem(x) for x in re.findall(r"[A-Za-z0-9_]+", t) if len(x) >= 2 and x.lower() not in sw]
        raw_docs = [("a.md", doc_a), ("b.md", doc_b), ("c.md", doc_c)]
        doc_tf, doc_len, postings = {}, {}, {}
        total_toks = 0
        bodies = {}
        for did, text in raw_docs:
            lines = text.splitlines()
            title = lines[0].lstrip("# ").strip()
            body = "\n".join(lines[1:])
            bodies[did] = body
            tt, bt = tok(title), tok(body)
            total_toks += len(bt)
            tf: dict[str, float] = {}
            for x in bt: tf[x] = tf.get(x, 0.0) + 1.0
            for x in tt: tf[x] = tf.get(x, 0.0) + title_boost
            doc_tf[did] = tf
            doc_len[did] = max(1, len(bt) + len(tt))
            for x in tf: postings.setdefault(x, set()).add(did)
        parts = query.split()
        req_all = "AND" in parts
        inc, exc = [], []
        for p in parts:
            if p in ("AND", "OR"): continue
            if p.startswith("-") and len(p) > 1: exc.extend(tok(p[1:]))
            else: inc.extend(tok(p))
        plan = {"include": inc, "exclude": exc, "require_all": req_all}
        excl_s = set()
        for t in exc: excl_s |= postings.get(t, set())
        cand = set()
        for t in inc: cand |= postings.get(t, set())
        if req_all and inc:
            for t in inc: cand &= postings.get(t, set())
        cand -= excl_s
        avg_dl = sum(doc_len.values()) / len(doc_tf)
        scored = []
        for did in sorted(cand):
            sc = 0.0
            dl = doc_len[did]
            for t in inc:
                f = doc_tf[did].get(t, 0.0)
                if f <= 0: continue
                df = len(postings.get(t, ()))
                idf = math.log(1.0 + (len(doc_tf) - df + 0.5) / (df + 0.5))
                sc += idf * (f * 2.5) / (f + 1.5 * (0.25 + 0.75 * (dl / avg_dl)))
            scored.append({"doc_id": did, "score": round(sc, 4)})
        scored.sort(key=lambda r: (-r["score"], r["doc_id"]))
        hits = scored[:top_k]
        snips = {}
        if highlight:
            for h in hits:
                body = bodies[h["doc_id"]]
                low = body.lower()
                sn = body[:60].replace("\n", " ").strip()
                for t in inc:
                    pos = low.find(t)
                    if pos >= 0:
                        sn = body[max(0, pos - 20): min(len(body), pos + 45)].replace("\n", " ").strip()
                        break
                snips[h["doc_id"]] = sn
        rep = {"hits": hits, "plan": plan, "query": query, "snippets": snips, "stats": {"doc_count": 3, "total_tokens": total_toks}}
        return json.dumps(rep, sort_keys=True), len(hits)

    rep1, h1 = _expected_doc_report(1.5, "cache OR sqlite -xml", 2, False)
    rep2, h2 = _expected_doc_report(1.5, "cache OR sqlite -xml", 2, True)
    rep3, h3 = _expected_doc_report(3.0, "cache AND sqlite", 3, True)

    t1 = {
        "id": "lc65k-py-doc-indexer-bm25-no-hl",
        "family": "lc65k-py-repo:doc_indexer",
        "language": "py",
        "files": files,
        "entryFile": "doc_indexer/cli/search.py",
        "entry": "run",
        "args": ["/docs", "cache OR sqlite -xml", 2],
        "fixture": {
            "calls": [
                {"operation": "env.get", "arguments": ["INDEX_TITLE_BOOST"], "status": "fulfilled", "result": "1.5"},
                {"operation": "fs.listdir", "arguments": ["/docs"], "status": "fulfilled", "result": ["a.md", "b.md", "c.md", "notes.txt"]},
                {"operation": "fs.isFile", "arguments": ["/docs/a.md"], "status": "fulfilled", "result": True},
                {"operation": "fs.readText", "arguments": ["/docs/a.md"], "status": "fulfilled", "result": doc_a},
                {"operation": "fs.isFile", "arguments": ["/docs/b.md"], "status": "fulfilled", "result": True},
                {"operation": "fs.readText", "arguments": ["/docs/b.md"], "status": "fulfilled", "result": doc_b},
                {"operation": "fs.isFile", "arguments": ["/docs/c.md"], "status": "fulfilled", "result": True},
                {"operation": "fs.readText", "arguments": ["/docs/c.md"], "status": "fulfilled", "result": doc_c},
                {"operation": "env.get", "arguments": ["INDEX_HIGHLIGHT"], "status": "fulfilled", "result": "0"},
                {"operation": "platform.log", "arguments": ["INFO", f"writing search report hits={h1}"], "status": "fulfilled", "result": None},
                {"operation": "fs.writeText", "arguments": ["/docs/search-report.json", rep1], "status": "fulfilled", "result": None},
            ]
        },
        "features": ["multifile-codebase", "code-load", "effectful", "causal-branch", "sqlite3", "fs", "env", "logging"],
    }

    t2 = {
        "id": "lc65k-py-doc-indexer-bm25-highlight",
        "family": "lc65k-py-repo:doc_indexer",
        "language": "py",
        "files": files,
        "entryFile": "doc_indexer/cli/search.py",
        "entry": "run",
        "args": ["/docs", "cache OR sqlite -xml", 2],
        "fixture": {
            "calls": [
                {"operation": "env.get", "arguments": ["INDEX_TITLE_BOOST"], "status": "fulfilled", "result": "1.5"},
                {"operation": "fs.listdir", "arguments": ["/docs"], "status": "fulfilled", "result": ["a.md", "b.md", "c.md", "notes.txt"]},
                {"operation": "fs.isFile", "arguments": ["/docs/a.md"], "status": "fulfilled", "result": True},
                {"operation": "fs.readText", "arguments": ["/docs/a.md"], "status": "fulfilled", "result": doc_a},
                {"operation": "fs.isFile", "arguments": ["/docs/b.md"], "status": "fulfilled", "result": True},
                {"operation": "fs.readText", "arguments": ["/docs/b.md"], "status": "fulfilled", "result": doc_b},
                {"operation": "fs.isFile", "arguments": ["/docs/c.md"], "status": "fulfilled", "result": True},
                {"operation": "fs.readText", "arguments": ["/docs/c.md"], "status": "fulfilled", "result": doc_c},
                {"operation": "env.get", "arguments": ["INDEX_HIGHLIGHT"], "status": "fulfilled", "result": "1"},
                {"operation": "platform.log", "arguments": ["INFO", f"writing search report hits={h2}"], "status": "fulfilled", "result": None},
                {"operation": "fs.writeText", "arguments": ["/docs/search-report.json", rep2], "status": "fulfilled", "result": None},
            ]
        },
        "features": ["multifile-codebase", "code-load", "effectful", "causal-branch", "sqlite3", "fs", "env", "logging"],
    }

    t3 = {
        "id": "lc65k-py-doc-indexer-and-boost",
        "family": "lc65k-py-repo:doc_indexer",
        "language": "py",
        "files": files,
        "entryFile": "doc_indexer/cli/search.py",
        "entry": "run",
        "args": ["/docs", "cache AND sqlite", 3],
        "fixture": {
            "calls": [
                {"operation": "env.get", "arguments": ["INDEX_TITLE_BOOST"], "status": "fulfilled", "result": "3.0"},
                {"operation": "fs.listdir", "arguments": ["/docs"], "status": "fulfilled", "result": ["a.md", "b.md", "c.md"]},
                {"operation": "fs.isFile", "arguments": ["/docs/a.md"], "status": "fulfilled", "result": True},
                {"operation": "fs.readText", "arguments": ["/docs/a.md"], "status": "fulfilled", "result": doc_a},
                {"operation": "fs.isFile", "arguments": ["/docs/b.md"], "status": "fulfilled", "result": True},
                {"operation": "fs.readText", "arguments": ["/docs/b.md"], "status": "fulfilled", "result": doc_b},
                {"operation": "fs.isFile", "arguments": ["/docs/c.md"], "status": "fulfilled", "result": True},
                {"operation": "fs.readText", "arguments": ["/docs/c.md"], "status": "fulfilled", "result": doc_c},
                {"operation": "env.get", "arguments": ["INDEX_HIGHLIGHT"], "status": "fulfilled", "result": "1"},
                {"operation": "platform.log", "arguments": ["INFO", f"writing search report hits={h3}"], "status": "fulfilled", "result": None},
                {"operation": "fs.writeText", "arguments": ["/docs/search-report.json", rep3], "status": "fulfilled", "result": None},
            ]
        },
        "features": ["multifile-codebase", "code-load", "effectful", "sqlite3", "fs", "env", "logging"],
    }
    return [t1, t2, t3]


# ===========================================================================
# Repo 8: flag_service — Feature Flag Evaluator, Rollout Bucketing & Telemetry
# ===========================================================================

def _build_flag_service() -> list[dict[str, Any]]:
    files: dict[str, str] = {
        "flag_service/__init__.py": '"""Feature flag targeting DSL, percentage bucketing, and experiment telemetry."""\n',
        "flag_service/eval/__init__.py": "",
        "flag_service/store/__init__.py": "",
        "flag_service/targeting/__init__.py": "",
        "flag_service/bucketing/__init__.py": "",
        "flag_service/experiments/__init__.py": "",
        "flag_service/telemetry/__init__.py": "",
        "flag_service/audit/__init__.py": "",
        "flag_service/eval/router.py": '''"""Feature flag batch evaluation router."""

from __future__ import annotations

from flag_service.audit.recorder import ExposureAuditDB
from flag_service.experiments.assigner import ExperimentAssigner
from flag_service.store.bundle_loader import load_flag_bundle
from flag_service.targeting.dsl import SegmentRuleEvaluator
from flag_service.telemetry.sink import fetch_kill_switches, publish_exposures


def run(flag_key: str, users: list[dict]) -> dict:
    """Load bundle, check kill switches, evaluate targeting + bucketing, record SQLite audit, post telemetry."""
    bundle = load_flag_bundle()
    killed = fetch_kill_switches()

    if flag_key in killed:
        from flag_service.eval.fallback import build_killed_decisions

        decisions = build_killed_decisions(flag_key, users, bundle["flags"][flag_key]["default"])
    else:
        flag_spec = bundle["flags"][flag_key]
        seg_eval = SegmentRuleEvaluator()
        assigner = ExperimentAssigner(flag_spec)
        decisions = []
        for user in users:
            matched = seg_eval.matches_any(user, flag_spec["rules"])
            decisions.append(assigner.assign(user, matched))

    db = ExposureAuditDB()
    db.record_many(flag_key, decisions)
    counts = db.variant_counts(flag_key)
    db.close()

    receipt = publish_exposures(flag_key, counts)
    return {
        "flag_key": flag_key,
        "killed": flag_key in killed,
        "counts": counts,
        "decisions": decisions,
        "receipt_id": receipt,
    }
''',
        "flag_service/store/bundle_loader.py": '''"""Load feature flag JSON bundle from disk."""

from __future__ import annotations

import json
import os


def load_flag_bundle() -> dict:
    path = os.getenv("FLAG_BUNDLE_PATH") or "/etc/flags/bundle.json"
    with open(path, "r", encoding="utf-8") as fh:
        return json.loads(fh.read())
''',
        "flag_service/targeting/dsl.py": '''"""Segment rule evaluator supporting eq, in, and gte predicates."""

from __future__ import annotations

from typing import Any


class SegmentRuleEvaluator:
    def _eval_clause(self, user: dict[str, Any], clause: dict[str, Any]) -> bool:
        val = user.get(clause["attr"])
        op = clause["op"]
        target = clause["value"]
        if op == "eq":
            return val == target
        if op == "in":
            return val in target
        if op == "gte":
            return isinstance(val, (int, float)) and val >= target
        raise ValueError(f"Unsupported op {op}")

    def matches_any(self, user: dict[str, Any], rules: list[list[dict[str, Any]]]) -> bool:
        if not rules:
            return True
        for rule in rules:
            if all(self._eval_clause(user, c) for c in rule):
                return True
        return False
''' + _class_domain_methods("SegmentRuleEvaluator", 10) + _large_unused_block("Targeting", 4),
        "flag_service/bucketing/hasher.py": '''"""Deterministic SHA256-based 0..99 percentage bucketing."""

from __future__ import annotations

import hashlib


def bucket_percent(salt: str, user_id: str) -> int:
    digest = hashlib.sha256(f"{salt}:{user_id}".encode("utf-8")).digest()
    val = int.from_bytes(digest[:4], "big")
    return val % 100
''',
        "flag_service/experiments/assigner.py": '''"""Experiment variant assigner using deterministic percentage rollouts."""

from __future__ import annotations

from typing import Any

from flag_service.bucketing.hasher import bucket_percent


class ExperimentAssigner:
    def __init__(self, flag_spec: dict[str, Any]) -> None:
        self.flag_spec = flag_spec

    def assign(self, user: dict[str, Any], matched: bool) -> dict[str, Any]:
        uid = str(user["id"])
        if not matched:
            return {"user_id": uid, "variant": self.flag_spec["default"], "reason": "segment-miss"}
        pct = bucket_percent(self.flag_spec["salt"], uid)
        if pct < int(self.flag_spec["rollout_pct"]):
            return {"user_id": uid, "variant": self.flag_spec["treatment"], "reason": f"bucket:{pct}"}
        return {"user_id": uid, "variant": self.flag_spec["default"], "reason": f"holdout:{pct}"}
''' + _class_domain_methods("ExperimentAssigner", 10) + _large_unused_block("Assigner", 4),
        "flag_service/eval/fallback.py": '''"""Safe kill-switch fallback decision builder."""

from __future__ import annotations

import logging


def build_killed_decisions(flag_key: str, users: list[dict], default_variant: str) -> list[dict]:
    logging.warning(f"kill-switch active for {flag_key}; forcing {default_variant}")
    return [{"user_id": str(u["id"]), "variant": default_variant, "reason": "kill-switch"} for u in users]
''' + _large_unused_block("KillSwitch", 3),
        "flag_service/audit/recorder.py": '''"""In-memory SQLite exposure recorder."""

from __future__ import annotations

import sqlite3


class ExposureAuditDB:
    def __init__(self) -> None:
        self._conn = sqlite3.connect(":memory:")
        self._conn.execute("CREATE TABLE exposures (flag_key TEXT, user_id TEXT, variant TEXT)")

    def record_many(self, flag_key: str, decisions: list[dict]) -> None:
        self._conn.executemany(
            "INSERT INTO exposures VALUES (?, ?, ?)",
            [(flag_key, d["user_id"], d["variant"]) for d in decisions],
        )
        self._conn.commit()

    def variant_counts(self, flag_key: str) -> dict[str, int]:
        cur = self._conn.execute(
            "SELECT variant, COUNT(*) FROM exposures WHERE flag_key = ? GROUP BY variant ORDER BY variant",
            (flag_key,),
        )
        return {str(v): int(c) for v, c in cur.fetchall()}

    def close(self) -> None:
        self._conn.close()
''',
        "flag_service/telemetry/sink.py": '''"""Remote kill-switch client and exposure telemetry publisher."""

from __future__ import annotations

import json
import logging
import time
import urllib.request
import uuid


def fetch_kill_switches() -> set[str]:
    with urllib.request.urlopen("https://flags.internal/v1/kill-switches") as resp:
        data = json.loads(resp.read().decode("utf-8"))
    return set(data.get("disabled", []))


def publish_exposures(flag_key: str, counts: dict[str, int]) -> str:
    receipt_id = str(uuid.uuid4())
    ts = int(time.time())
    body = json.dumps({"receipt_id": receipt_id, "ts": ts, "flag_key": flag_key, "counts": counts}, sort_keys=True)
    req = urllib.request.Request(
        "https://telemetry.internal/v1/exposures",
        data=body.encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    logging.info(f"publishing exposures flag={flag_key} receipt={receipt_id[:8]}")
    with urllib.request.urlopen(req) as resp:
        _ = resp.read()
    return receipt_id
''',
    }
    _add_distractors(
        files,
        "flag_service",
        [
            ("sdks", ["python_sdk", "js_bridge", "go_bridge", "edge_worker"], ["sdk", "key", "ttl"]),
            ("stats", ["chi_square", "srm_check", "cuped_adj", "power_calc"], ["control", "treatment", "pvalue"]),
            ("sync", ["sse_stream", "poll_daemon", "s3_mirror", "etag_sync"], ["url", "etag", "interval"]),
            ("admin", ["flag_crud", "approval_flow", "diff_audit"], ["flag", "actor", "change"]),
        ],
        extra_subpackages=8,
        mods_per_extra=9,
    )

    bundle_json = json.dumps({
        "flags": {
            "checkout_v3": {
                "salt": "s2026",
                "default": "control",
                "treatment": "express",
                "rollout_pct": 60,
                "rules": [[{"attr": "tier", "op": "in", "value": ["pro", "enterprise"]}, {"attr": "age_days", "op": "gte", "value": 14}]],
            }
        }
    })
    users = [
        {"id": "u-10", "tier": "pro", "age_days": 30},
        {"id": "u-20", "tier": "free", "age_days": 90},
        {"id": "u-30", "tier": "enterprise", "age_days": 45},
        {"id": "u-40", "tier": "pro", "age_days": 5},
    ]

    # Compute exact deterministic counts for checkout_v3 on u-10 and u-30
    import hashlib
    def _bkt(uid: str) -> int:
        return int.from_bytes(hashlib.sha256(f"s2026:{uid}".encode("utf-8")).digest()[:4], "big") % 100
    c1: dict[str, int] = {}
    for u in users:
        matched = (u["tier"] in ("pro", "enterprise")) and (u["age_days"] >= 14)
        v = "express" if (matched and _bkt(u["id"]) < 60) else "control"
        c1[v] = c1.get(v, 0) + 1
    c1 = dict(sorted(c1.items()))

    body1 = json.dumps({"counts": c1, "flag_key": "checkout_v3", "receipt_id": "22222222-1111-4000-8000-000000000001", "ts": 1795682000}, sort_keys=True)
    t1 = {
        "id": "lc65k-py-flag-service-rollout",
        "family": "lc65k-py-repo:flag_service",
        "language": "py",
        "files": files,
        "entryFile": "flag_service/eval/router.py",
        "entry": "run",
        "args": ["checkout_v3", users],
        "fixture": {
            "calls": [
                {"operation": "env.get", "arguments": ["FLAG_BUNDLE_PATH"], "status": "fulfilled", "result": "/etc/flags/bundle.json"},
                {"operation": "fs.readText", "arguments": ["/etc/flags/bundle.json"], "status": "fulfilled", "result": bundle_json},
                {"operation": "http.request", "arguments": [{"method": "GET", "url": "https://flags.internal/v1/kill-switches"}], "status": "fulfilled", "result": {"status": 200, "url": "https://flags.internal/v1/kill-switches", "headers": {}, "body": json.dumps({"disabled": []})}},
                {"operation": "platform.uuid", "arguments": [], "status": "fulfilled", "result": "22222222-1111-4000-8000-000000000001"},
                {"operation": "platform.time", "arguments": [], "status": "fulfilled", "result": 1795682000.0},
                {"operation": "platform.log", "arguments": ["INFO", "publishing exposures flag=checkout_v3 receipt=22222222"], "status": "fulfilled", "result": None},
                {"operation": "http.request", "arguments": [{"method": "POST", "url": "https://telemetry.internal/v1/exposures", "headers": {"Content-type": "application/json"}, "body": body1}], "status": "fulfilled", "result": {"status": 200, "url": "https://telemetry.internal/v1/exposures", "headers": {}, "body": "ok"}},
            ]
        },
        "features": ["multifile-codebase", "code-load", "effectful", "causal-branch", "sqlite3", "http", "fs", "env", "uuid", "logging"],
    }

    # Variant 2: Kill switch enabled -> causal branch loads eval/fallback.py, skips targeting/experiments!
    body2 = json.dumps({"counts": {"control": 4}, "flag_key": "checkout_v3", "receipt_id": "22222222-1111-4000-8000-000000000002", "ts": 1795682010}, sort_keys=True)
    t2 = {
        "id": "lc65k-py-flag-service-killswitch",
        "family": "lc65k-py-repo:flag_service",
        "language": "py",
        "files": files,
        "entryFile": "flag_service/eval/router.py",
        "entry": "run",
        "args": ["checkout_v3", users],
        "fixture": {
            "calls": [
                {"operation": "env.get", "arguments": ["FLAG_BUNDLE_PATH"], "status": "fulfilled", "result": "/etc/flags/bundle.json"},
                {"operation": "fs.readText", "arguments": ["/etc/flags/bundle.json"], "status": "fulfilled", "result": bundle_json},
                {"operation": "http.request", "arguments": [{"method": "GET", "url": "https://flags.internal/v1/kill-switches"}], "status": "fulfilled", "result": {"status": 200, "url": "https://flags.internal/v1/kill-switches", "headers": {}, "body": json.dumps({"disabled": ["checkout_v3"]})}},
                {"operation": "platform.log", "arguments": ["WARNING", "kill-switch active for checkout_v3; forcing control"], "status": "fulfilled", "result": None},
                {"operation": "platform.uuid", "arguments": [], "status": "fulfilled", "result": "22222222-1111-4000-8000-000000000002"},
                {"operation": "platform.time", "arguments": [], "status": "fulfilled", "result": 1795682010.0},
                {"operation": "platform.log", "arguments": ["INFO", "publishing exposures flag=checkout_v3 receipt=22222222"], "status": "fulfilled", "result": None},
                {"operation": "http.request", "arguments": [{"method": "POST", "url": "https://telemetry.internal/v1/exposures", "headers": {"Content-type": "application/json"}, "body": body2}], "status": "fulfilled", "result": {"status": 200, "url": "https://telemetry.internal/v1/exposures", "headers": {}, "body": "ok"}},
            ]
        },
        "features": ["multifile-codebase", "code-load", "effectful", "causal-branch", "sqlite3", "http", "fs", "env", "uuid", "logging"],
    }

    # Variant 3: 100% rollout bundle for enterprise users
    bundle_100 = json.dumps({
        "flags": {
            "checkout_v3": {
                "salt": "s2026",
                "default": "control",
                "treatment": "express",
                "rollout_pct": 100,
                "rules": [[{"attr": "tier", "op": "eq", "value": "enterprise"}]],
            }
        }
    })
    body3 = json.dumps({"counts": {"control": 3, "express": 1}, "flag_key": "checkout_v3", "receipt_id": "22222222-1111-4000-8000-000000000003", "ts": 1795682020}, sort_keys=True)
    t3 = {
        "id": "lc65k-py-flag-service-ent-full",
        "family": "lc65k-py-repo:flag_service",
        "language": "py",
        "files": files,
        "entryFile": "flag_service/eval/router.py",
        "entry": "run",
        "args": ["checkout_v3", users],
        "fixture": {
            "calls": [
                {"operation": "env.get", "arguments": ["FLAG_BUNDLE_PATH"], "status": "fulfilled", "result": "/etc/flags/bundle-ent.json"},
                {"operation": "fs.readText", "arguments": ["/etc/flags/bundle-ent.json"], "status": "fulfilled", "result": bundle_100},
                {"operation": "http.request", "arguments": [{"method": "GET", "url": "https://flags.internal/v1/kill-switches"}], "status": "fulfilled", "result": {"status": 200, "url": "https://flags.internal/v1/kill-switches", "headers": {}, "body": json.dumps({"disabled": []})}},
                {"operation": "platform.uuid", "arguments": [], "status": "fulfilled", "result": "22222222-1111-4000-8000-000000000003"},
                {"operation": "platform.time", "arguments": [], "status": "fulfilled", "result": 1795682020.0},
                {"operation": "platform.log", "arguments": ["INFO", "publishing exposures flag=checkout_v3 receipt=22222222"], "status": "fulfilled", "result": None},
                {"operation": "http.request", "arguments": [{"method": "POST", "url": "https://telemetry.internal/v1/exposures", "headers": {"Content-type": "application/json"}, "body": body3}], "status": "fulfilled", "result": {"status": 200, "url": "https://telemetry.internal/v1/exposures", "headers": {}, "body": "ok"}},
            ]
        },
        "features": ["multifile-codebase", "code-load", "effectful", "causal-branch", "sqlite3", "http", "fs", "env", "uuid", "logging"],
    }
    return [t1, t2, t3]


# ===========================================================================
# Repo 9: incident_bot — Alert Correlator, Runbook Executor & Postmortem Builder
# ===========================================================================

def _build_incident_bot() -> list[dict[str, Any]]:
    files: dict[str, str] = {
        "incident_bot/__init__.py": '"""SRE alert correlation, runbook diagnostics, escalation, and postmortem engine."""\n',
        "incident_bot/triage/__init__.py": "",
        "incident_bot/ingest/__init__.py": "",
        "incident_bot/correlate/__init__.py": "",
        "incident_bot/runbooks/__init__.py": "",
        "incident_bot/pager/__init__.py": "",
        "incident_bot/store/__init__.py": "",
        "incident_bot/reports/__init__.py": "",
        "incident_bot/triage/handler.py": '''"""Primary SRE alert triage entrypoint."""

from __future__ import annotations

from incident_bot.correlate.graph import TopologyCorrelator
from incident_bot.ingest.normalizer import AlertNormalizer
from incident_bot.reports.postmortem import write_postmortem
from incident_bot.runbooks.executor import run_diagnostic_check
from incident_bot.runbooks.matcher import load_runbook_for_service
from incident_bot.store.timeline_db import IncidentTimelineDB


def run(incident_id: str, raw_alerts: list[dict], topology: dict[str, list[str]]) -> dict:
    """Normalize alerts, localize root service via topology graph, run runbook, and remediate or escalate."""
    normalizer = AlertNormalizer()
    alerts = normalizer.normalize_batch(raw_alerts)

    correlator = TopologyCorrelator(topology)
    root_service, affected = correlator.find_root_cause(alerts)

    runbook = load_runbook_for_service(root_service)
    diag = run_diagnostic_check(runbook["check_cmd"])

    db = IncidentTimelineDB()
    db.add_event(incident_id, "correlated", f"root={root_service} alerts={len(alerts)}")
    db.add_event(incident_id, "diagnostic", f"rc={diag['returncode']} out={diag['stdout']}")

    if diag["returncode"] == 0 and "OK" in diag["stdout"]:
        action = "auto-remediated"
        escalated = False
        db.add_event(incident_id, "remediated", runbook["remediation_note"])
    else:
        from incident_bot.pager.escalator import page_oncall_team

        action = "escalated-sev1"
        escalated = True
        page_res = page_oncall_team(incident_id, root_service, runbook["oncall_team"], diag["stdout"])
        db.add_event(incident_id, "paged", f"ticket={page_res['ticket']}")

    timeline = db.list_events(incident_id)
    db.close()

    pm_path = write_postmortem(incident_id, root_service, affected, action, timeline)
    return {
        "incident_id": incident_id,
        "root_service": root_service,
        "affected_services": affected,
        "action": action,
        "escalated": escalated,
        "timeline_count": len(timeline),
        "postmortem_path": pm_path,
    }
''',
        "incident_bot/ingest/normalizer.py": '''"""Alert deduplication and severity ranking."""

from __future__ import annotations

from typing import Any

SEV_WEIGHT = {"sev1": 3, "sev2": 2, "sev3": 1}


class AlertNormalizer:
    def normalize_batch(self, raw_alerts: list[dict[str, Any]]) -> list[dict[str, Any]]:
        seen: set[tuple[str, str]] = set()
        out: list[dict[str, Any]] = []
        for a in raw_alerts:
            svc = str(a["service"]).strip().lower()
            code = str(a["code"]).strip().upper()
            if (svc, code) in seen:
                continue
            seen.add((svc, code))
            sev = str(a.get("severity", "sev3")).lower()
            out.append({"service": svc, "code": code, "severity": sev, "weight": SEV_WEIGHT.get(sev, 1)})
        out.sort(key=lambda x: (-x["weight"], x["service"], x["code"]))
        return out
''' + _class_domain_methods("AlertNormalizer", 26) + _large_unused_block("AlertNorm", 4),
        "incident_bot/correlate/graph.py": '''"""Service dependency topology root-cause correlator."""

from __future__ import annotations

from typing import Any


class TopologyCorrelator:
    def __init__(self, deps_map: dict[str, list[str]]) -> None:
        self.deps_map = deps_map

    def find_root_cause(self, alerts: list[dict[str, Any]]) -> tuple[str, list[str]]:
        affected = sorted({a["service"] for a in alerts})
        affected_set = set(affected)
        # A service whose dependencies are NOT also alerting is the deepest root cause candidate.
        roots = [
            svc for svc in affected
            if not any(dep in affected_set for dep in self.deps_map.get(svc, []))
        ]
        if roots:
            return roots[0], affected
        return affected[0], affected
''' + _class_domain_methods("TopologyCorrelator", 26) + _large_unused_block("Topology", 4),
        "incident_bot/runbooks/matcher.py": '''"""Load service runbook JSON from configured directory."""

from __future__ import annotations

import json
import os


def load_runbook_for_service(service: str) -> dict:
    rb_dir = os.getenv("RUNBOOK_DIR") or "/etc/runbooks"
    path = f"{rb_dir}/{service}.json"
    with open(path, "r", encoding="utf-8") as fh:
        return json.loads(fh.read())
''',
        "incident_bot/runbooks/executor.py": '''"""Execute diagnostic runbook command via subprocess."""

from __future__ import annotations

import logging
import subprocess


def run_diagnostic_check(cmd: list[str]) -> dict:
    logging.info(f"running diagnostic: {' '.join(cmd)}")
    cp = subprocess.run(cmd, capture_output=True, text=True, check=False)
    return {"returncode": cp.returncode, "stdout": cp.stdout.strip(), "stderr": cp.stderr.strip()}
''',
        "incident_bot/pager/escalator.py": '''"""SEV1 on-call escalation HTTP client."""

from __future__ import annotations

import json
import logging
import urllib.request


def page_oncall_team(incident_id: str, service: str, team: str, detail: str) -> dict:
    logging.error(f"escalating {incident_id} service={service} team={team}")
    payload = json.dumps({"incident_id": incident_id, "service": service, "team": team, "detail": detail}, sort_keys=True)
    req = urllib.request.Request(
        "https://pager.internal/v1/trigger",
        data=payload.encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req) as resp:
        return json.loads(resp.read().decode("utf-8"))
''' + _large_unused_block("Escalator", 3),
        "incident_bot/store/timeline_db.py": '''"""In-memory SQLite incident timeline store."""

from __future__ import annotations

import datetime
import sqlite3


class IncidentTimelineDB:
    def __init__(self) -> None:
        self._conn = sqlite3.connect(":memory:")
        self._conn.execute("CREATE TABLE timeline (incident_id TEXT, ts TEXT, phase TEXT, detail TEXT)")

    def add_event(self, incident_id: str, phase: str, detail: str) -> None:
        ts = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        self._conn.execute("INSERT INTO timeline VALUES (?, ?, ?, ?)", (incident_id, ts, phase, detail))
        self._conn.commit()

    def list_events(self, incident_id: str) -> list[dict]:
        cur = self._conn.execute(
            "SELECT ts, phase, detail FROM timeline WHERE incident_id = ? ORDER BY rowid",
            (incident_id,),
        )
        return [{"ts": r[0], "phase": r[1], "detail": r[2]} for r in cur.fetchall()]

    def close(self) -> None:
        self._conn.close()
''',
        "incident_bot/reports/postmortem.py": '''"""Postmortem JSON artifact writer."""

from __future__ import annotations

import json


def write_postmortem(incident_id: str, root: str, affected: list[str], action: str, timeline: list[dict]) -> str:
    path = f"/var/incidents/{incident_id}.postmortem.json"
    doc = {"incident_id": incident_id, "root": root, "affected": affected, "action": action, "timeline": timeline}
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(json.dumps(doc, sort_keys=True))
    return path
''',
    }
    _add_distractors(
        files,
        "incident_bot",
        [
            ("connectors", ["prometheus_hook", "datadog_hook", "cloudwatch_poll", "sentry_hook"], ["alert", "source", "host"]),
            ("chatops", ["slack_thread", "zoom_bridge", "statuspage_pub", "jira_sync"], ["channel", "incident", "url"]),
            ("slo", ["burn_rate", "error_budget", "mttr_calc", "mtbf_calc"], ["service", "window", "budget"]),
            ("ml", ["anomaly_zscore", "change_point", "cluster_alerts"], ["series", "score", "window"]),
        ],
        extra_subpackages=9,
        mods_per_extra=10,
    )

    topo = {"frontend": ["api-gw"], "api-gw": ["orders-db"], "orders-db": []}
    alerts_storm = [
        {"service": "frontend", "code": "HTTP_502", "severity": "sev2"},
        {"service": "api-gw", "code": "DB_TIMEOUT", "severity": "sev1"},
        {"service": "orders-db", "code": "REPL_LAG", "severity": "sev1"},
        {"service": "orders-db", "code": "REPL_LAG", "severity": "sev1"},
    ]
    rb_json = json.dumps({
        "check_cmd": ["dbctl", "health", "--node", "orders-db"],
        "oncall_team": "storage-sre",
        "remediation_note": "restarted-read-replica",
    })

    pm1 = json.dumps({
        "action": "auto-remediated",
        "affected": ["api-gw", "frontend", "orders-db"],
        "incident_id": "INC-701",
        "root": "orders-db",
        "timeline": [
            {"detail": "root=orders-db alerts=3", "phase": "correlated", "ts": "2026-11-27T08:00:00Z"},
            {"detail": "rc=0 out=OK replica-synced", "phase": "diagnostic", "ts": "2026-11-27T08:00:01Z"},
            {"detail": "restarted-read-replica", "phase": "remediated", "ts": "2026-11-27T08:00:02Z"},
        ],
    }, sort_keys=True)
    t1 = {
        "id": "lc65k-py-incident-bot-auto-remediate",
        "family": "lc65k-py-repo:incident_bot",
        "language": "py",
        "files": files,
        "entryFile": "incident_bot/triage/handler.py",
        "entry": "run",
        "args": ["INC-701", alerts_storm, topo],
        "fixture": {
            "calls": [
                {"operation": "env.get", "arguments": ["RUNBOOK_DIR"], "status": "fulfilled", "result": "/etc/runbooks"},
                {"operation": "fs.readText", "arguments": ["/etc/runbooks/orders-db.json"], "status": "fulfilled", "result": rb_json},
                {"operation": "platform.log", "arguments": ["INFO", "running diagnostic: dbctl health --node orders-db"], "status": "fulfilled", "result": None},
                {"operation": "shell.exec", "arguments": [{"args": ["dbctl", "health", "--node", "orders-db"], "shell": False}], "status": "fulfilled", "result": {"returncode": 0, "stdout": "OK replica-synced\n", "stderr": ""}},
                {"operation": "platform.time", "arguments": [], "status": "fulfilled", "result": 1795766400.0},
                {"operation": "platform.time", "arguments": [], "status": "fulfilled", "result": 1795766401.0},
                {"operation": "platform.time", "arguments": [], "status": "fulfilled", "result": 1795766402.0},
                {"operation": "fs.writeText", "arguments": ["/var/incidents/INC-701.postmortem.json", pm1], "status": "fulfilled", "result": None},
            ]
        },
        "features": ["multifile-codebase", "code-load", "effectful", "causal-branch", "sqlite3", "shell", "fs", "env", "logging"],
    }

    page_req_body = json.dumps({"detail": "DISK_FULL 99%", "incident_id": "INC-701", "service": "orders-db", "team": "storage-sre"}, sort_keys=True)
    pm2 = json.dumps({
        "action": "escalated-sev1",
        "affected": ["api-gw", "frontend", "orders-db"],
        "incident_id": "INC-701",
        "root": "orders-db",
        "timeline": [
            {"detail": "root=orders-db alerts=3", "phase": "correlated", "ts": "2026-11-27T08:00:00Z"},
            {"detail": "rc=2 out=DISK_FULL 99%", "phase": "diagnostic", "ts": "2026-11-27T08:00:01Z"},
            {"detail": "ticket=PD-8841", "phase": "paged", "ts": "2026-11-27T08:00:02Z"},
        ],
    }, sort_keys=True)
    t2 = {
        "id": "lc65k-py-incident-bot-escalate-sev1",
        "family": "lc65k-py-repo:incident_bot",
        "language": "py",
        "files": files,
        "entryFile": "incident_bot/triage/handler.py",
        "entry": "run",
        "args": ["INC-701", alerts_storm, topo],
        "fixture": {
            "calls": [
                {"operation": "env.get", "arguments": ["RUNBOOK_DIR"], "status": "fulfilled", "result": "/etc/runbooks"},
                {"operation": "fs.readText", "arguments": ["/etc/runbooks/orders-db.json"], "status": "fulfilled", "result": rb_json},
                {"operation": "platform.log", "arguments": ["INFO", "running diagnostic: dbctl health --node orders-db"], "status": "fulfilled", "result": None},
                {"operation": "shell.exec", "arguments": [{"args": ["dbctl", "health", "--node", "orders-db"], "shell": False}], "status": "fulfilled", "result": {"returncode": 2, "stdout": "DISK_FULL 99%\n", "stderr": ""}},
                {"operation": "platform.time", "arguments": [], "status": "fulfilled", "result": 1795766400.0},
                {"operation": "platform.time", "arguments": [], "status": "fulfilled", "result": 1795766401.0},
                {"operation": "platform.log", "arguments": ["ERROR", "escalating INC-701 service=orders-db team=storage-sre"], "status": "fulfilled", "result": None},
                {"operation": "http.request", "arguments": [{"method": "POST", "url": "https://pager.internal/v1/trigger", "headers": {"Content-type": "application/json"}, "body": page_req_body}], "status": "fulfilled", "result": {"status": 201, "url": "https://pager.internal/v1/trigger", "headers": {}, "body": json.dumps({"ticket": "PD-8841"})}},
                {"operation": "platform.time", "arguments": [], "status": "fulfilled", "result": 1795766402.0},
                {"operation": "fs.writeText", "arguments": ["/var/incidents/INC-701.postmortem.json", pm2], "status": "fulfilled", "result": None},
            ]
        },
        "features": ["multifile-codebase", "code-load", "effectful", "causal-branch", "sqlite3", "shell", "http", "fs", "env", "logging"],
    }

    # Variant 3: Frontend-only alert storm (different root service)
    rb_fe = json.dumps({
        "check_cmd": ["cdnctl", "purge-check", "frontend"],
        "oncall_team": "edge-sre",
        "remediation_note": "flushed-edge-cache",
    })
    pm3 = json.dumps({
        "action": "auto-remediated",
        "affected": ["frontend"],
        "incident_id": "INC-702",
        "root": "frontend",
        "timeline": [
            {"detail": "root=frontend alerts=1", "phase": "correlated", "ts": "2026-11-27T08:05:00Z"},
            {"detail": "rc=0 out=OK edge-healthy", "phase": "diagnostic", "ts": "2026-11-27T08:05:01Z"},
            {"detail": "flushed-edge-cache", "phase": "remediated", "ts": "2026-11-27T08:05:02Z"},
        ],
    }, sort_keys=True)
    t3 = {
        "id": "lc65k-py-incident-bot-edge-dedup",
        "family": "lc65k-py-repo:incident_bot",
        "language": "py",
        "files": files,
        "entryFile": "incident_bot/triage/handler.py",
        "entry": "run",
        "args": ["INC-702", [{"service": "frontend", "code": "CDN_MISS", "severity": "sev2"}, {"service": "FRONTEND", "code": "cdn_miss", "severity": "sev2"}], topo],
        "fixture": {
            "calls": [
                {"operation": "env.get", "arguments": ["RUNBOOK_DIR"], "status": "fulfilled", "result": "/etc/runbooks"},
                {"operation": "fs.readText", "arguments": ["/etc/runbooks/frontend.json"], "status": "fulfilled", "result": rb_fe},
                {"operation": "platform.log", "arguments": ["INFO", "running diagnostic: cdnctl purge-check frontend"], "status": "fulfilled", "result": None},
                {"operation": "shell.exec", "arguments": [{"args": ["cdnctl", "purge-check", "frontend"], "shell": False}], "status": "fulfilled", "result": {"returncode": 0, "stdout": "OK edge-healthy\n", "stderr": ""}},
                {"operation": "platform.time", "arguments": [], "status": "fulfilled", "result": 1795766700.0},
                {"operation": "platform.time", "arguments": [], "status": "fulfilled", "result": 1795766701.0},
                {"operation": "platform.time", "arguments": [], "status": "fulfilled", "result": 1795766702.0},
                {"operation": "fs.writeText", "arguments": ["/var/incidents/INC-702.postmortem.json", pm3], "status": "fulfilled", "result": None},
            ]
        },
        "features": ["multifile-codebase", "code-load", "effectful", "sqlite3", "shell", "fs", "env", "logging"],
    }
    return [t1, t2, t3]


# ===========================================================================
# Repo 10: pkg_builder — Artifact Build Graph, Checksummer & Cache Publisher
# ===========================================================================

def _build_pkg_builder() -> list[dict[str, Any]]:
    files: dict[str, str] = {
        "pkg_builder/__init__.py": '"""DAG build system with SHA256 fingerprinting, remote build cache, and SQLite build log."""\n',
        "pkg_builder/cmd/__init__.py": "",
        "pkg_builder/graph/__init__.py": "",
        "pkg_builder/hash/__init__.py": "",
        "pkg_builder/cache/__init__.py": "",
        "pkg_builder/compiler/__init__.py": "",
        "pkg_builder/manifest/__init__.py": "",
        "pkg_builder/db/__init__.py": "",
        "pkg_builder/publish/__init__.py": "",
        "pkg_builder/cmd/build.py": '''"""Build orchestrator entrypoint."""

from __future__ import annotations

from pkg_builder.cache.remote import check_remote_cache
from pkg_builder.db.build_log import BuildHistoryDB
from pkg_builder.graph.dag import BuildGraph
from pkg_builder.hash.fingerprinter import compute_target_fingerprint
from pkg_builder.manifest.lock import LockManifestBuilder
from pkg_builder.publish.uploader import write_lock_manifest


def run(workspace: str, targets_spec: dict[str, list[str]]) -> dict:
    """Resolve build DAG, fingerprint inputs, probe remote cache, compile misses, and emit lock manifest."""
    graph = BuildGraph(targets_spec)
    order = graph.build_order()

    db = BuildHistoryDB()
    results: dict[str, dict] = {}
    for target in order:
        dep_hashes = {d: results[d]["digest"] for d in targets_spec.get(target, [])}
        fp = compute_target_fingerprint(workspace, target, dep_hashes)
        cache_hit = check_remote_cache(target, fp)
        if cache_hit["hit"]:
            from pkg_builder.cache.restore import restore_cached_artifact

            art = restore_cached_artifact(target, fp, cache_hit["artifact_url"])
        else:
            from pkg_builder.compiler.runner import compile_target

            art = compile_target(workspace, target, fp)
        results[target] = art
        db.record_step(target, art["source"], art["digest"])

    summary = db.step_counts()
    db.close()

    lock_builder = LockManifestBuilder()
    lock_doc = lock_builder.assemble(order, results)
    lock_path = write_lock_manifest(workspace, lock_doc)
    return {
        "order": order,
        "summary": summary,
        "lock_path": lock_path,
        "digests": {t: results[t]["digest"] for t in order},
    }
''',
        "pkg_builder/graph/dag.py": '''"""Topological build graph planner with cycle validation."""

from __future__ import annotations

from typing import Any


class BuildGraph:
    def __init__(self, deps: dict[str, list[str]]) -> None:
        self.deps = deps

    def build_order(self) -> list[str]:
        indeg: dict[str, int] = {t: 0 for t in self.deps}
        rev: dict[str, list[str]] = {t: [] for t in self.deps}
        for target, reqs in self.deps.items():
            for r in reqs:
                if r not in self.deps:
                    raise KeyError(f"Unknown build target dependency: {r}")
                indeg[target] += 1
                rev[r].append(target)
        ready = sorted(t for t, d in indeg.items() if d == 0)
        order: list[str] = []
        while ready:
            cur = ready.pop(0)
            order.append(cur)
            for nxt in sorted(rev[cur]):
                indeg[nxt] -= 1
                if indeg[nxt] == 0:
                    ready.append(nxt)
                    ready.sort()
        if len(order) != len(self.deps):
            raise ValueError("Cycle detected in build graph")
        return order
''' + _class_domain_methods("BuildGraph", 26) + _large_unused_block("BuildDAG", 4),
        "pkg_builder/hash/fingerprinter.py": '''"""Deterministic input fingerprinter reading source bytes from workspace."""

from __future__ import annotations

import hashlib
import os


def compute_target_fingerprint(workspace: str, target: str, dep_hashes: dict[str, str]) -> str:
    h = hashlib.sha256()
    tdir = f"{workspace}/{target}"
    for fname in sorted(os.listdir(tdir)):
        with open(f"{tdir}/{fname}", "rb") as fh:
            data = fh.read()
        h.update(fname.encode("utf-8"))
        h.update(b":")
        h.update(data)
    for dep in sorted(dep_hashes):
        h.update(f"|{dep}={dep_hashes[dep]}".encode("utf-8"))
    return h.hexdigest()[:16]
''',
        "pkg_builder/cache/remote.py": '''"""Remote build cache probe over HTTP."""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request


def check_remote_cache(target: str, fingerprint: str) -> dict:
    base = os.getenv("BUILD_CACHE_URL") or "https://cache.internal/artifacts"
    url = f"{base}/{target}/{fingerprint}"
    try:
        with urllib.request.urlopen(url) as resp:
            if resp.status == 200:
                data = json.loads(resp.read().decode("utf-8"))
                return {"hit": True, "artifact_url": data["url"]}
            return {"hit": False, "artifact_url": None}
    except urllib.error.HTTPError:
        return {"hit": False, "artifact_url": None}
''',
        "pkg_builder/cache/restore.py": '''"""Restore prebuilt artifact from remote cache."""

from __future__ import annotations

import logging


def restore_cached_artifact(target: str, fingerprint: str, artifact_url: str) -> dict:
    logging.info(f"cache hit target={target} fp={fingerprint}")
    return {"target": target, "source": "cache", "digest": fingerprint, "url": artifact_url}
''' + _large_unused_block("CacheRestore", 3),
        "pkg_builder/compiler/runner.py": '''"""Invoke compiler toolchain via subprocess on cache miss."""

from __future__ import annotations

import logging
import subprocess


def compile_target(workspace: str, target: str, fingerprint: str) -> dict:
    logging.info(f"compiling target={target} fp={fingerprint}")
    cp = subprocess.run(
        ["pybuild", "compile", f"{workspace}/{target}", "--fp", fingerprint],
        capture_output=True,
        text=True,
        check=False,
    )
    if cp.returncode != 0:
        logging.error(f"compile failed target={target} rc={cp.returncode}")
        raise RuntimeError(f"Compilation failed for {target}: {cp.stderr.strip()}")
    return {"target": target, "source": "compiled", "digest": cp.stdout.strip() or fingerprint}
''' + _large_unused_block("Compiler", 3),
        "pkg_builder/manifest/lock.py": '''"""Lock manifest assembler."""

from __future__ import annotations

from typing import Any


class LockManifestBuilder:
    def assemble(self, order: list[str], results: dict[str, dict[str, Any]]) -> dict[str, Any]:
        entries = [
            {"target": t, "source": results[t]["source"], "digest": results[t]["digest"]}
            for t in order
        ]
        return {"version": 1, "targets": entries}
''' + _class_domain_methods("LockManifestBuilder", 26) + _large_unused_block("LockManifest", 4),
        "pkg_builder/db/build_log.py": '''"""In-memory SQLite build history ledger."""

from __future__ import annotations

import secrets
import sqlite3
import time


class BuildHistoryDB:
    def __init__(self) -> None:
        self._conn = sqlite3.connect(":memory:")
        self._conn.execute("CREATE TABLE steps (run_id TEXT, ts REAL, target TEXT, source TEXT, digest TEXT)")
        self._run_id = secrets.token_hex(4)

    def record_step(self, target: str, source: str, digest: str) -> None:
        self._conn.execute("INSERT INTO steps VALUES (?, ?, ?, ?, ?)", (self._run_id, time.time(), target, source, digest))
        self._conn.commit()

    def step_counts(self) -> dict[str, int]:
        cur = self._conn.execute("SELECT source, COUNT(*) FROM steps GROUP BY source ORDER BY source")
        return {str(s): int(c) for s, c in cur.fetchall()}

    def close(self) -> None:
        self._conn.close()
''',
        "pkg_builder/publish/uploader.py": '''"""Lock manifest writer."""

from __future__ import annotations

import json


def write_lock_manifest(workspace: str, lock_doc: dict) -> str:
    path = f"{workspace}/build.lock.json"
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(json.dumps(lock_doc, sort_keys=True))
    return path
''',
    }
    _add_distractors(
        files,
        "pkg_builder",
        [
            ("toolchains", ["clang_cc", "rustc_wrap", "wheel_pack", "docker_oci", "wasm_opt"], ["target", "triple", "flags"]),
            ("sandbox", ["ns_mount", "seccomp_prof", "env_scrub", "hermetic_fs"], ["root", "readonly", "uid"]),
            ("registry", ["pypi_upload", "oci_push", "sigstore_sign", "mirror_sync"], ["artifact", "sha256", "tag"]),
            ("ui", ["progress_bar", "trace_chrome", "dot_export"], ["node", "elapsed", "status"]),
        ],
        extra_subpackages=9,
        mods_per_extra=10,
    )

    import hashlib
    core_src = b"def add(a, b): return a + b\n"
    app_src = b"from core import add\nOUT = add(2, 3)\n"
    fp_core = hashlib.sha256(b"lib.py:" + core_src).hexdigest()[:16]
    fp_app_compiled = hashlib.sha256(b"main.py:" + app_src + f"|core=art-{fp_core}".encode("utf-8")).hexdigest()[:16]
    fp_app_cached = hashlib.sha256(b"main.py:" + app_src + f"|core={fp_core}".encode("utf-8")).hexdigest()[:16]

    targets_spec = {"app": ["core"], "core": []}

    # Variant 1: Cache miss -> compiles both targets
    lock1 = json.dumps({
        "targets": [
            {"digest": f"art-{fp_core}", "source": "compiled", "target": "core"},
            {"digest": f"art-{fp_app_compiled}", "source": "compiled", "target": "app"},
        ],
        "version": 1,
    }, sort_keys=True)
    t1 = {
        "id": "lc65k-py-pkg-builder-cache-miss",
        "family": "lc65k-py-repo:pkg_builder",
        "language": "py",
        "files": files,
        "entryFile": "pkg_builder/cmd/build.py",
        "entry": "run",
        "args": ["/ws", targets_spec],
        "fixture": {
            "calls": [
                {"operation": "platform.secrets", "arguments": ["token_hex", 4], "status": "fulfilled", "result": "b001b002"},
                {"operation": "fs.listdir", "arguments": ["/ws/core"], "status": "fulfilled", "result": ["lib.py"]},
                {"operation": "fs.readBytes", "arguments": ["/ws/core/lib.py"], "status": "fulfilled", "result": {"$py": "bytes", "b64": __import__("base64").b64encode(core_src).decode("ascii")}},
                {"operation": "env.get", "arguments": ["BUILD_CACHE_URL"], "status": "fulfilled", "result": "https://cache.internal/artifacts"},
                {"operation": "http.request", "arguments": [{"method": "GET", "url": f"https://cache.internal/artifacts/core/{fp_core}"}], "status": "fulfilled", "result": {"status": 404, "url": f"https://cache.internal/artifacts/core/{fp_core}", "headers": {}, "body": "miss"}},
                {"operation": "platform.log", "arguments": ["INFO", f"compiling target=core fp={fp_core}"], "status": "fulfilled", "result": None},
                {"operation": "shell.exec", "arguments": [{"args": ["pybuild", "compile", "/ws/core", "--fp", fp_core], "shell": False}], "status": "fulfilled", "result": {"returncode": 0, "stdout": f"art-{fp_core}\n", "stderr": ""}},
                {"operation": "platform.time", "arguments": [], "status": "fulfilled", "result": 1795683001.0},
                {"operation": "fs.listdir", "arguments": ["/ws/app"], "status": "fulfilled", "result": ["main.py"]},
                {"operation": "fs.readBytes", "arguments": ["/ws/app/main.py"], "status": "fulfilled", "result": {"$py": "bytes", "b64": __import__("base64").b64encode(app_src).decode("ascii")}},
                {"operation": "env.get", "arguments": ["BUILD_CACHE_URL"], "status": "fulfilled", "result": "https://cache.internal/artifacts"},
                {"operation": "http.request", "arguments": [{"method": "GET", "url": f"https://cache.internal/artifacts/app/{fp_app_compiled}"}], "status": "fulfilled", "result": {"status": 404, "url": f"https://cache.internal/artifacts/app/{fp_app_compiled}", "headers": {}, "body": "miss"}},
                {"operation": "platform.log", "arguments": ["INFO", f"compiling target=app fp={fp_app_compiled}"], "status": "fulfilled", "result": None},
                {"operation": "shell.exec", "arguments": [{"args": ["pybuild", "compile", "/ws/app", "--fp", fp_app_compiled], "shell": False}], "status": "fulfilled", "result": {"returncode": 0, "stdout": f"art-{fp_app_compiled}\n", "stderr": ""}},
                {"operation": "platform.time", "arguments": [], "status": "fulfilled", "result": 1795683002.0},
                {"operation": "fs.writeText", "arguments": ["/ws/build.lock.json", lock1], "status": "fulfilled", "result": None},
            ]
        },
        "features": ["multifile-codebase", "code-load", "effectful", "causal-branch", "sqlite3", "shell", "http", "fs", "bytes", "env", "secrets", "logging"],
    }

    # Variant 2: Cache hit on core & app -> causal branch loads cache/restore.py, skips compiler!
    lock2 = json.dumps({
        "targets": [
            {"digest": fp_core, "source": "cache", "target": "core"},
            {"digest": fp_app_cached, "source": "cache", "target": "app"},
        ],
        "version": 1,
    }, sort_keys=True)
    t2 = {
        "id": "lc65k-py-pkg-builder-cache-hit",
        "family": "lc65k-py-repo:pkg_builder",
        "language": "py",
        "files": files,
        "entryFile": "pkg_builder/cmd/build.py",
        "entry": "run",
        "args": ["/ws", targets_spec],
        "fixture": {
            "calls": [
                {"operation": "platform.secrets", "arguments": ["token_hex", 4], "status": "fulfilled", "result": "b001b002"},
                {"operation": "fs.listdir", "arguments": ["/ws/core"], "status": "fulfilled", "result": ["lib.py"]},
                {"operation": "fs.readBytes", "arguments": ["/ws/core/lib.py"], "status": "fulfilled", "result": {"$py": "bytes", "b64": __import__("base64").b64encode(core_src).decode("ascii")}},
                {"operation": "env.get", "arguments": ["BUILD_CACHE_URL"], "status": "fulfilled", "result": "https://cache.internal/artifacts"},
                {"operation": "http.request", "arguments": [{"method": "GET", "url": f"https://cache.internal/artifacts/core/{fp_core}"}], "status": "fulfilled", "result": {"status": 200, "url": f"https://cache.internal/artifacts/core/{fp_core}", "headers": {}, "body": json.dumps({"url": f"https://cdn.internal/core/{fp_core}.tar.zst"})}},
                {"operation": "platform.log", "arguments": ["INFO", f"cache hit target=core fp={fp_core}"], "status": "fulfilled", "result": None},
                {"operation": "platform.time", "arguments": [], "status": "fulfilled", "result": 1795683001.0},
                {"operation": "fs.listdir", "arguments": ["/ws/app"], "status": "fulfilled", "result": ["main.py"]},
                {"operation": "fs.readBytes", "arguments": ["/ws/app/main.py"], "status": "fulfilled", "result": {"$py": "bytes", "b64": __import__("base64").b64encode(app_src).decode("ascii")}},
                {"operation": "env.get", "arguments": ["BUILD_CACHE_URL"], "status": "fulfilled", "result": "https://cache.internal/artifacts"},
                {"operation": "http.request", "arguments": [{"method": "GET", "url": f"https://cache.internal/artifacts/app/{fp_app_cached}"}], "status": "fulfilled", "result": {"status": 200, "url": f"https://cache.internal/artifacts/app/{fp_app_cached}", "headers": {}, "body": json.dumps({"url": f"https://cdn.internal/app/{fp_app_cached}.tar.zst"})}},
                {"operation": "platform.log", "arguments": ["INFO", f"cache hit target=app fp={fp_app_cached}"], "status": "fulfilled", "result": None},
                {"operation": "platform.time", "arguments": [], "status": "fulfilled", "result": 1795683002.0},
                {"operation": "fs.writeText", "arguments": ["/ws/build.lock.json", lock2], "status": "fulfilled", "result": None},
            ]
        },
        "features": ["multifile-codebase", "code-load", "effectful", "causal-branch", "sqlite3", "http", "fs", "bytes", "env", "secrets", "logging"],
    }

    # Variant 3: Core hits cache, app misses and fails compilation -> throws RuntimeError!
    t3 = {
        "id": "lc65k-py-pkg-builder-compile-fail",
        "family": "lc65k-py-repo:pkg_builder",
        "language": "py",
        "files": files,
        "entryFile": "pkg_builder/cmd/build.py",
        "entry": "run",
        "args": ["/ws", targets_spec],
        "fixture": {
            "calls": [
                {"operation": "platform.secrets", "arguments": ["token_hex", 4], "status": "fulfilled", "result": "b001b002"},
                {"operation": "fs.listdir", "arguments": ["/ws/core"], "status": "fulfilled", "result": ["lib.py"]},
                {"operation": "fs.readBytes", "arguments": ["/ws/core/lib.py"], "status": "fulfilled", "result": {"$py": "bytes", "b64": __import__("base64").b64encode(core_src).decode("ascii")}},
                {"operation": "env.get", "arguments": ["BUILD_CACHE_URL"], "status": "fulfilled", "result": "https://cache.internal/artifacts"},
                {"operation": "http.request", "arguments": [{"method": "GET", "url": f"https://cache.internal/artifacts/core/{fp_core}"}], "status": "fulfilled", "result": {"status": 200, "url": f"https://cache.internal/artifacts/core/{fp_core}", "headers": {}, "body": json.dumps({"url": f"https://cdn.internal/core/{fp_core}.tar.zst"})}},
                {"operation": "platform.log", "arguments": ["INFO", f"cache hit target=core fp={fp_core}"], "status": "fulfilled", "result": None},
                {"operation": "platform.time", "arguments": [], "status": "fulfilled", "result": 1795683001.0},
                {"operation": "fs.listdir", "arguments": ["/ws/app"], "status": "fulfilled", "result": ["main.py"]},
                {"operation": "fs.readBytes", "arguments": ["/ws/app/main.py"], "status": "fulfilled", "result": {"$py": "bytes", "b64": __import__("base64").b64encode(app_src).decode("ascii")}},
                {"operation": "env.get", "arguments": ["BUILD_CACHE_URL"], "status": "fulfilled", "result": "https://cache.internal/artifacts"},
                {"operation": "http.request", "arguments": [{"method": "GET", "url": f"https://cache.internal/artifacts/app/{fp_app_cached}"}], "status": "fulfilled", "result": {"status": 404, "url": f"https://cache.internal/artifacts/app/{fp_app_cached}", "headers": {}, "body": "miss"}},
                {"operation": "platform.log", "arguments": ["INFO", f"compiling target=app fp={fp_app_cached}"], "status": "fulfilled", "result": None},
                {"operation": "shell.exec", "arguments": [{"args": ["pybuild", "compile", "/ws/app", "--fp", fp_app_cached], "shell": False}], "status": "fulfilled", "result": {"returncode": 1, "stdout": "", "stderr": "syntax error in main.py"}},
                {"operation": "platform.log", "arguments": ["ERROR", "compile failed target=app rc=1"], "status": "fulfilled", "result": None},
            ]
        },
        "features": ["multifile-codebase", "code-load", "effectful", "causal-branch", "exception", "sqlite3", "shell", "http", "fs", "bytes", "env", "secrets", "logging"],
    }
    return [t1, t2, t3]


# ===========================================================================
# Repo 11 (Extra Large 60-file repo!): workflow_orch — 60-file DAG Workflow Engine
# ===========================================================================

def _build_workflow_orch() -> list[dict[str, Any]]:
    """Extra-large 60-file repo exercising large manifest + deep 7-file execution + external I/O."""
    files: dict[str, str] = {
        "workflow_orch/__init__.py": '"""Large-scale multi-service workflow orchestrator."""\n',
        "workflow_orch/engine/__init__.py": "",
        "workflow_orch/spec/__init__.py": "",
        "workflow_orch/state/__init__.py": "",
        "workflow_orch/executors/__init__.py": "",
        "workflow_orch/policy/__init__.py": "",
        "workflow_orch/audit/__init__.py": "",
        "workflow_orch/engine/runner.py": '''"""DAG workflow runner entrypoint."""

from __future__ import annotations

from workflow_orch.audit.journal import emit_workflow_receipt
from workflow_orch.executors.http_step import execute_http_step
from workflow_orch.executors.shell_step import execute_shell_step
from workflow_orch.policy.guard import WorkflowBudgetGuard
from workflow_orch.spec.loader import load_workflow_spec
from workflow_orch.state.sqlite_state import WorkflowStateStore


def run(workflow_name: str, context: dict) -> dict:
    """Load workflow spec, enforce budget guard, execute DAG steps (http/shell/transform), persist SQLite state."""
    spec = load_workflow_spec(workflow_name)
    guard = WorkflowBudgetGuard(max_steps=spec["max_steps"], max_cost=spec["max_cost"])
    store = WorkflowStateStore()

    outputs: dict[str, dict] = {}
    total_cost = 0
    for step in spec["steps"]:
        guard.check_before_step(step["id"], total_cost + step["cost"])
        kind = step["kind"]
        if kind == "http":
            res = execute_http_step(step, context, outputs)
        elif kind == "shell":
            res = execute_shell_step(step, context, outputs)
        else:
            from workflow_orch.executors.transform_step import execute_transform_step

            res = execute_transform_step(step, context, outputs)
        outputs[step["id"]] = res
        total_cost += int(step["cost"])
        store.record_step(workflow_name, step["id"], kind, res["status"], int(step["cost"]))
        if res["status"] != "ok":
            break

    summary = store.summarize(workflow_name)
    store.close()
    receipt = emit_workflow_receipt(workflow_name, summary, outputs)
    return {
        "workflow": workflow_name,
        "summary": summary,
        "outputs": outputs,
        "receipt_path": receipt,
    }
''',
        "workflow_orch/spec/loader.py": '''"""Load workflow JSON spec from disk using env-configured directory."""

from __future__ import annotations

import json
import os


def load_workflow_spec(workflow_name: str) -> dict:
    root = os.getenv("WORKFLOW_SPEC_DIR") or "/etc/workflows"
    path = f"{root}/{workflow_name}.json"
    with open(path, "r", encoding="utf-8") as fh:
        return json.loads(fh.read())
''',
        "workflow_orch/policy/guard.py": '''"""Budget and step-count safety guard."""

from __future__ import annotations

from typing import Any


class WorkflowBudgetGuard:
    def __init__(self, max_steps: int, max_cost: int) -> None:
        self.max_steps = max_steps
        self.max_cost = max_cost
        self.executed = 0

    def check_before_step(self, step_id: str, projected_cost: int) -> None:
        if self.executed >= self.max_steps:
            raise RuntimeError(f"Step budget exceeded before {step_id}")
        if projected_cost > self.max_cost:
            raise ValueError(f"Cost budget exceeded at {step_id}: {projected_cost} > {self.max_cost}")
        self.executed += 1
''' + _class_domain_methods("WorkflowBudgetGuard", 16) + _large_unused_block("BudgetGuard", 5),
        "workflow_orch/executors/http_step.py": '''"""HTTP step executor."""

from __future__ import annotations

import json
import urllib.error
import urllib.request
from typing import Any


def execute_http_step(step: dict[str, Any], context: dict[str, Any], outputs: dict[str, Any]) -> dict[str, Any]:
    url = step["url"].format(**context)
    try:
        with urllib.request.urlopen(url) as resp:
            body = resp.read().decode("utf-8")
            if resp.status >= 400:
                return {"status": "failed", "http_status": resp.status, "data": body}
            return {"status": "ok", "http_status": resp.status, "data": json.loads(body)}
    except urllib.error.HTTPError as err:
        return {"status": "failed", "http_status": int(err.code), "data": err.read().decode("utf-8")}
''' + _large_unused_block("HttpStep", 4),
        "workflow_orch/executors/shell_step.py": '''"""Subprocess step executor."""

from __future__ import annotations

import subprocess
from typing import Any


def execute_shell_step(step: dict[str, Any], context: dict[str, Any], outputs: dict[str, Any]) -> dict[str, Any]:
    cmd = [part.format(**context) for part in step["cmd"]]
    cp = subprocess.run(cmd, capture_output=True, text=True, check=False)
    return {
        "status": "ok" if cp.returncode == 0 else "failed",
        "rc": cp.returncode,
        "stdout": cp.stdout.strip(),
    }
''' + _large_unused_block("ShellStep", 4),
        "workflow_orch/executors/transform_step.py": '''"""In-process data aggregation transform step."""

from __future__ import annotations

from typing import Any


def execute_transform_step(step: dict[str, Any], context: dict[str, Any], outputs: dict[str, Any]) -> dict[str, Any]:
    src = outputs[step["input_step"]]["data"]
    vals = [int(x) for x in src.get("values", [])]
    factor = int(step.get("factor", 1))
    return {"status": "ok", "total": sum(vals) * factor, "count": len(vals)}
''' + _large_unused_block("TransformStep", 4),
        "workflow_orch/state/sqlite_state.py": '''"""In-memory SQLite workflow execution state ledger."""

from __future__ import annotations

import sqlite3


class WorkflowStateStore:
    def __init__(self) -> None:
        self._conn = sqlite3.connect(":memory:")
        self._conn.execute("CREATE TABLE step_runs (wf TEXT, step_id TEXT, kind TEXT, status TEXT, cost INTEGER)")

    def record_step(self, wf: str, step_id: str, kind: str, status: str, cost: int) -> None:
        self._conn.execute("INSERT INTO step_runs VALUES (?, ?, ?, ?, ?)", (wf, step_id, kind, status, cost))
        self._conn.commit()

    def summarize(self, wf: str) -> dict:
        cur = self._conn.execute(
            "SELECT COUNT(*), COALESCE(SUM(cost), 0), SUM(CASE WHEN status='ok' THEN 1 ELSE 0 END) "
            "FROM step_runs WHERE wf = ?",
            (wf,),
        )
        total, cost, ok_cnt = cur.fetchone()
        return {"steps": int(total), "total_cost": int(cost), "ok_steps": int(ok_cnt or 0)}

    def close(self) -> None:
        self._conn.close()
''',
        "workflow_orch/audit/journal.py": '''"""Workflow receipt exporter."""

from __future__ import annotations

import json
import logging
import uuid


def emit_workflow_receipt(workflow_name: str, summary: dict, outputs: dict) -> str:
    rid = str(uuid.uuid4())[:8]
    path = f"/var/workflows/{workflow_name}-{rid}.json"
    logging.info(f"emitting workflow receipt {path} ok={summary['ok_steps']}/{summary['steps']}")
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(json.dumps({"workflow": workflow_name, "receipt": rid, "summary": summary, "outputs": outputs}, sort_keys=True))
    return path
''',
    }
    _add_distractors(
        files,
        "workflow_orch",
        [
            ("triggers", ["cron_trigger", "webhook_trigger", "kafka_trigger", "s3_trigger", "manual_trigger", "github_trigger"], ["trigger_id", "schedule", "filter"]),
            ("workers", ["pool_mgr", "k8s_pod", "lambda_inv", "ray_actor", "celery_bridge", "local_proc"], ["worker_id", "queue", "slots"]),
            ("connectors", ["snowflake_op", "bigquery_op", "postgres_op", "redis_op", "slack_op", "email_op"], ["conn_id", "host", "timeout"]),
            ("observability", ["otel_trace", "prom_metrics", "log_shipper", "slo_tracker", "cost_meter", "lineage_emit"], ["span_id", "service", "duration"]),
            ("security", ["rbac_check", "secret_vault", "kms_envelope", "jwt_verify", "audit_signer", "ip_allowlist"], ["principal", "role", "scope"]),
            ("ui", ["dag_render", "gantt_chart", "log_tail", "diff_view", "search_bar", "alert_banner"], ["view", "filter", "page"]),
        ],
        extra_subpackages=10,
        mods_per_extra=10,
    )

    spec_ok = json.dumps({
        "max_steps": 5,
        "max_cost": 50,
        "steps": [
            {"id": "fetch", "kind": "http", "url": "https://api.internal/metrics/{tenant}", "cost": 10},
            {"id": "agg", "kind": "transform", "input_step": "fetch", "factor": 3, "cost": 5},
            {"id": "verify", "kind": "shell", "cmd": ["verify-cli", "--tenant", "{tenant}"], "cost": 15},
        ],
    })
    rec1 = json.dumps({
        "outputs": {
            "agg": {"count": 3, "status": "ok", "total": 45},
            "fetch": {"data": {"values": [4, 5, 6]}, "http_status": 200, "status": "ok"},
            "verify": {"rc": 0, "status": "ok", "stdout": "verified"},
        },
        "receipt": "99990001",
        "summary": {"ok_steps": 3, "steps": 3, "total_cost": 30},
        "workflow": "nightly-sync",
    }, sort_keys=True)
    t1 = {
        "id": "lc65k-py-workflow-orch-60f-ok",
        "family": "lc65k-py-repo:workflow_orch",
        "language": "py",
        "files": files,
        "entryFile": "workflow_orch/engine/runner.py",
        "entry": "run",
        "args": ["nightly-sync", {"tenant": "acme"}],
        "fixture": {
            "calls": [
                {"operation": "env.get", "arguments": ["WORKFLOW_SPEC_DIR"], "status": "fulfilled", "result": "/etc/workflows"},
                {"operation": "fs.readText", "arguments": ["/etc/workflows/nightly-sync.json"], "status": "fulfilled", "result": spec_ok},
                {"operation": "http.request", "arguments": [{"method": "GET", "url": "https://api.internal/metrics/acme"}], "status": "fulfilled", "result": {"status": 200, "url": "https://api.internal/metrics/acme", "headers": {}, "body": json.dumps({"values": [4, 5, 6]})}},
                {"operation": "shell.exec", "arguments": [{"args": ["verify-cli", "--tenant", "acme"], "shell": False}], "status": "fulfilled", "result": {"returncode": 0, "stdout": "verified\n", "stderr": ""}},
                {"operation": "platform.uuid", "arguments": [], "status": "fulfilled", "result": "99990001-aaaa-4bbb-8ccc-dddddddd0001"},
                {"operation": "platform.log", "arguments": ["INFO", "emitting workflow receipt /var/workflows/nightly-sync-99990001.json ok=3/3"], "status": "fulfilled", "result": None},
                {"operation": "fs.writeText", "arguments": ["/var/workflows/nightly-sync-99990001.json", rec1], "status": "fulfilled", "result": None},
            ]
        },
        "features": ["multifile-codebase", "code-load", "effectful", "causal-branch", "large-repo", "sqlite3", "http", "shell", "fs", "env", "uuid", "logging"],
    }

    # Variant 2: HTTP step fails -> short-circuits before transform_step.py and shell_step.py!
    rec2 = json.dumps({
        "outputs": {
            "fetch": {"data": "upstream down", "http_status": 502, "status": "failed"},
        },
        "receipt": "99990002",
        "summary": {"ok_steps": 0, "steps": 1, "total_cost": 10},
        "workflow": "nightly-sync",
    }, sort_keys=True)
    t2 = {
        "id": "lc65k-py-workflow-orch-60f-shortcircuit",
        "family": "lc65k-py-repo:workflow_orch",
        "language": "py",
        "files": files,
        "entryFile": "workflow_orch/engine/runner.py",
        "entry": "run",
        "args": ["nightly-sync", {"tenant": "acme"}],
        "fixture": {
            "calls": [
                {"operation": "env.get", "arguments": ["WORKFLOW_SPEC_DIR"], "status": "fulfilled", "result": "/etc/workflows"},
                {"operation": "fs.readText", "arguments": ["/etc/workflows/nightly-sync.json"], "status": "fulfilled", "result": spec_ok},
                {"operation": "http.request", "arguments": [{"method": "GET", "url": "https://api.internal/metrics/acme"}], "status": "fulfilled", "result": {"status": 502, "url": "https://api.internal/metrics/acme", "headers": {}, "body": "upstream down"}},
                {"operation": "platform.uuid", "arguments": [], "status": "fulfilled", "result": "99990002-aaaa-4bbb-8ccc-dddddddd0002"},
                {"operation": "platform.log", "arguments": ["INFO", "emitting workflow receipt /var/workflows/nightly-sync-99990002.json ok=0/1"], "status": "fulfilled", "result": None},
                {"operation": "fs.writeText", "arguments": ["/var/workflows/nightly-sync-99990002.json", rec2], "status": "fulfilled", "result": None},
            ]
        },
        "features": ["multifile-codebase", "code-load", "effectful", "causal-branch", "large-repo", "sqlite3", "http", "fs", "env", "uuid", "logging"],
    }

    # Variant 3: Cost budget exceeded -> throws ValueError!
    spec_over = json.dumps({
        "max_steps": 5,
        "max_cost": 20,
        "steps": [
            {"id": "fetch", "kind": "http", "url": "https://api.internal/metrics/{tenant}", "cost": 10},
            {"id": "agg", "kind": "transform", "input_step": "fetch", "factor": 2, "cost": 5},
            {"id": "verify", "kind": "shell", "cmd": ["verify-cli", "--tenant", "{tenant}"], "cost": 15},
        ],
    })
    t3 = {
        "id": "lc65k-py-workflow-orch-60f-budget-throw",
        "family": "lc65k-py-repo:workflow_orch",
        "language": "py",
        "files": files,
        "entryFile": "workflow_orch/engine/runner.py",
        "entry": "run",
        "args": ["nightly-sync", {"tenant": "acme"}],
        "fixture": {
            "calls": [
                {"operation": "env.get", "arguments": ["WORKFLOW_SPEC_DIR"], "status": "fulfilled", "result": "/etc/workflows"},
                {"operation": "fs.readText", "arguments": ["/etc/workflows/nightly-sync.json"], "status": "fulfilled", "result": spec_over},
                {"operation": "http.request", "arguments": [{"method": "GET", "url": "https://api.internal/metrics/acme"}], "status": "fulfilled", "result": {"status": 200, "url": "https://api.internal/metrics/acme", "headers": {}, "body": json.dumps({"values": [2, 3]})}},
            ]
        },
        "features": ["multifile-codebase", "code-load", "effectful", "causal-branch", "exception", "large-repo", "sqlite3", "http", "fs", "env"],
    }
    return [t1, t2, t3]


def build_all_tasks() -> list[dict[str, Any]]:
    builders = [
        _build_ledger_svc,
        _build_deploy_ctl,
        _build_etl_lake,
        _build_sec_scanner,
        _build_async_crawler,
        _build_billing_engine,
        _build_doc_indexer,
        _build_flag_service,
        _build_incident_bot,
        _build_pkg_builder,
        _build_workflow_orch,
    ]
    tasks: list[dict[str, Any]] = []
    for fn in builders:
        tasks.extend(fn())
    return tasks


def _verify_one(task: dict[str, Any], max_est_tokens: int) -> dict[str, Any]:
    exported = export_python_example(task, trace_format="compact", reasoning_channel="thinking")
    audit = exported["metadata"]["traceAudit"]
    if not audit.get("replayVerified"):
        raise AssertionError(f"{task['id']}: replayVerified is False")

    # Independent live session replay check.
    prepared = prepare_python_task(task, trace_format="compact")
    session = create_python_session(prepared)
    msgs = exported["messages"]
    start_idx = next(i for i, m in enumerate(msgs) if m.get("role") == "user") + 1
    idx = start_idx
    while idx < len(msgs):
        m = msgs[idx]
        idx += 1
        assert m.get("role") == "assistant"
        step_res = session.step(m, 0)
        for obs in step_res["messages"]:
            assert idx < len(msgs) and msgs[idx] == obs
            idx += 1
    grade = session.grade()
    if not grade["success"]:
        raise AssertionError(f"{task['id']}: live session grade failed: {grade}")

    serialized = _json_compact(msgs)
    conv_chars = len(serialized)
    est_tokens = int(math.ceil(conv_chars / 3.2))
    if est_tokens > max_est_tokens:
        raise AssertionError(f"{task['id']}: est_tokens {est_tokens} > {max_est_tokens}")

    tt_tokens = len(_TIKTOKEN_ENC.encode(serialized, disallowed_special=())) if _TIKTOKEN_ENC is not None else None
    loaded_paths = {task["entryFile"]}
    for m in msgs:
        if m.get("role") == "assistant" and isinstance(m.get("tool_calls"), list):
            for tc in m["tool_calls"]:
                fn = tc.get("function") or {}
                if fn.get("name") == CODE_LOAD_OPERATION:
                    raw_a = json.loads(fn.get("arguments") or "{}")
                    for req in raw_a.get("arguments") or []:
                        if isinstance(req, dict) and isinstance(req.get("path"), str):
                            loaded_paths.add(req["path"])

    distractors = sorted(p for p in exported["task"]["files"] if p not in loaded_paths)
    trace_chars = sum(
        len(assistant_thinking_text(m)) + len(assistant_visible_text(m))
        for m in msgs
        if m.get("role") == "assistant"
    )
    meta: dict[str, Any] = {
        **(task.get("metadata") or {}),
        "sourceOrigin": "py-multifile-65k-builder",
        "sourceHash": exported["sourceHash"],
        "fileCount": len(exported["task"]["files"]),
        "loadedFileCount": len(loaded_paths),
        "loadedFiles": sorted(loaded_paths),
        "distractorFiles": distractors,
        "distractorCount": len(distractors),
        "codeLoadCalls": int(exported["metadata"].get("codeLoadCalls", 0)),
        "codeLoadBytes": int(exported["metadata"].get("codeLoadBytes", 0)),
        "externalCalls": len(exported["task"]["fixture"]["calls"]),
        "traceChars": trace_chars,
        "conversationChars": conv_chars,
        "estimatedTokens": est_tokens,
        "narrationLines": int(audit["narrationLines"]),
        "replayVerified": True,
    }
    if tt_tokens is not None:
        meta["tiktokenTokens"] = tt_tokens
    return {**exported["task"], "metadata": meta}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Build and verify 33 rich multi-file Python 65K-context tasks.")
    parser.add_argument(
        "--output",
        default="/tmp/lc65k-builder/tasks.jsonl",
        help="Output JSONL path.",
    )
    parser.add_argument("--jobs", type=int, default=6, help="Parallel verification workers.")
    parser.add_argument("--max-estimated-tokens", type=int, default=60_000)
    args = parser.parse_args(argv)

    tasks = build_all_tasks()
    with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, min(12, args.jobs))) as pool:
        futs = [pool.submit(_verify_one, t, args.max_estimated_tokens) for t in tasks]
        verified = [f.result() for f in futs]

    # Run causal supervision audit across all generated tasks!
    sup_audit = audit_python_supervision(
        verified,
        {"formats": ["compact", "actions-only"], "samplePerFeature": 100},
    )
    if not (sup_audit["valid"] and sup_audit["allReplayed"]):
        raise AssertionError(f"Supervision audit failed: {sup_audit}")

    out_path = Path(args.output).resolve()
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(
        "\n".join(_json_compact(t) for t in verified) + "\n",
        encoding="utf-8",
    )

    ests = sorted(t["metadata"]["estimatedTokens"] for t in verified)
    loaded = sorted(t["metadata"]["loadedFileCount"] for t in verified)
    fcounts = sorted(t["metadata"]["fileCount"] for t in verified)
    summary = {
        "totalTasks": len(verified),
        "families": len({t["family"] for t in verified}),
        "effectfulCount": sum(1 for t in verified if t["metadata"]["externalCalls"] > 0),
        "causalDivergencesChecked": sup_audit["causalDivergencesChecked"],
        "estimatedTokens": {"min": ests[0], "p50": ests[len(ests) // 2], "p90": ests[int(len(ests) * 0.9)], "max": ests[-1]},
        "loadedFileCount": {"min": loaded[0], "p50": loaded[len(loaded) // 2], "max": loaded[-1]},
        "fileCount": {"min": fcounts[0], "p50": fcounts[len(fcounts) // 2], "max": fcounts[-1]},
        "output": str(out_path),
    }
    print(json.dumps(summary, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
