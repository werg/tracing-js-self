#!/usr/bin/env python3
"""Rejection-Sampled Fine-Tuning (RFT) collector CLI.

Samples K rollouts per task from a Tinker checkpoint, verifies every rollout
using the exact JS/Python execution harness (runner.rollout + Bridge), and
writes strictly verified passing trajectories (`success == True` and
`complete == True`) as pre-exported SFT rows compatible with `tinker_js run`'s
`_is_preexported_row` pass-through.
"""

from __future__ import annotations

import argparse
from collections import Counter, defaultdict
import concurrent.futures
import copy
import hashlib
import json
import math
import os
from pathlib import Path
import re
import sys
import threading
import time
from typing import Any, Sequence

_REPO_ROOT = Path(__file__).resolve().parents[1]
_TRAINING_DIR = str(_REPO_ROOT / "training")
if _TRAINING_DIR not in sys.path:
    sys.path.insert(0, _TRAINING_DIR)

from tinker_js.adapter import DEFAULT_MODEL, TinkerAdapter  # noqa: E402
from tinker_js.learning import task_metadata  # noqa: E402
from tinker_js.runner import (  # noqa: E402
    Bridge,
    DEFAULTS,
    RolloutError,
    atomic_json,
    json_preserve_order,
    read_jsonl,
    rollout,
    write_jsonl,
)


def parse_filter_features(raw: str | Sequence[str] | None) -> frozenset[str]:
    if raw is None:
        return frozenset()
    if isinstance(raw, str):
        return frozenset(item.strip() for item in raw.split(",") if item.strip())
    return frozenset(str(item).strip() for item in raw if str(item).strip())


def _row_split(row: dict[str, Any]) -> str | None:
    split = row.get("split")
    if split is None and isinstance(row.get("task"), dict):
        split = row["task"].get("split")
    return str(split) if split is not None else None


def _row_id(row: dict[str, Any], fallback_index: int = 0) -> str:
    task = row.get("task") if isinstance(row.get("task"), dict) else {}
    value = row.get("id") or task.get("id") or f"row-{fallback_index}"
    return str(value)


def _row_task(row: dict[str, Any]) -> dict[str, Any]:
    task = row.get("task")
    return task if isinstance(task, dict) else row


def _row_language(row: dict[str, Any]) -> str:
    task = _row_task(row)
    meta = row.get("metadata") if isinstance(row.get("metadata"), dict) else {}
    task_meta = task.get("metadata") if isinstance(task.get("metadata"), dict) else {}
    lang = row.get("language") or task.get("language") or meta.get("language") or task_meta.get("language")
    if isinstance(lang, str) and lang:
        return lang
    entry_file = str(task.get("entryFile") or "")
    if re.search(r"\.(?:ts|tsx|mts|cts)$", entry_file, re.IGNORECASE):
        return "ts"
    return "js"


def _row_external_calls_count(row: dict[str, Any]) -> int:
    task = _row_task(row)
    fixture = task.get("fixture") if isinstance(task.get("fixture"), dict) else {}
    calls = fixture.get("calls")
    if isinstance(calls, list) and calls:
        return len(calls)
    for container in (row.get("metadata"), task.get("metadata")):
        if isinstance(container, dict):
            raw = container.get("externalCalls")
            if isinstance(raw, int) and not isinstance(raw, bool) and raw > 0:
                return raw
    return 0


def effective_row_features(row: dict[str, Any]) -> set[str]:
    """Return explicit features plus canonical capability aliases for filtering."""
    task = _row_task(row)
    meta = row.get("metadata") if isinstance(row.get("metadata"), dict) else {}
    task_meta = task.get("metadata") if isinstance(task.get("metadata"), dict) else {}
    features: set[str] = set()
    for src in (row.get("features"), meta.get("features"), task_meta.get("features")):
        if isinstance(src, (list, tuple, set)):
            features.update(str(item) for item in src if isinstance(item, str) and item)

    tid = _row_id(row)
    lang = _row_language(row)
    if lang == "py" or tid.startswith("py-"):
        features.add("python")
    if lang == "ts" or tid.startswith("ts-"):
        features.add("typescript")
    entry_file = str(task.get("entryFile") or "")
    if re.search(r"\.(?:ts|tsx|mts|cts)$", entry_file, re.IGNORECASE):
        features.add("typescript")
    if _row_external_calls_count(row) > 0:
        features.add("external")
    env = row.get("environment") or task.get("environment") or meta.get("environment") or task_meta.get("environment")
    if env == "browser" or "frontend" in features or "browser-dom" in features:
        features.add("browser-dom")
        features.add("frontend")
    if isinstance(task.get("files"), dict) and task["files"]:
        features.add("multifile")
        features.add("code-load")
    if "lc65k" in tid:
        features.add("long-context-65k")
    return features


def load_hard_score_ids(path: Path) -> tuple[set[str], dict[str, dict[str, Any]]]:
    """Load hard/imperfect (<1.0 pass rate) task IDs from a scores or eval JSONL file.

    Supports both:
    - `tinker-mine-hard.py` scores.jsonl (`is_hard`, `terminated`, `min_ll`)
    - Eval / rollout pass-rate JSONL (`pass_rate` or per-attempt `success` / `grade.success`)
    """
    rows = read_jsonl(path)
    attempt_counts: dict[str, list[bool]] = defaultdict(list)
    explicit_pass_rate: dict[str, float] = {}
    hard_flags: dict[str, bool] = {}
    score_info: dict[str, dict[str, Any]] = {}

    for rec in rows:
        tid = rec.get("id") or rec.get("task_id")
        if not isinstance(tid, str) or not tid:
            continue
        score_info[tid] = rec
        if "pass_rate" in rec and isinstance(rec["pass_rate"], (int, float)) and not isinstance(rec["pass_rate"], bool):
            explicit_pass_rate[tid] = float(rec["pass_rate"])
        elif "success" in rec and isinstance(rec["success"], bool):
            attempt_counts[tid].append(rec["success"])
        elif isinstance(rec.get("grade"), dict) and isinstance(rec["grade"].get("success"), bool):
            attempt_counts[tid].append(bool(rec["grade"]["success"]))
        elif "is_hard" in rec:
            is_hard = bool(rec.get("is_hard"))
            terminated = rec.get("terminated")
            if terminated is False:
                is_hard = True
            hard_flags[tid] = hard_flags.get(tid, False) or is_hard

    hard_ids: set[str] = set()
    for tid, rate in explicit_pass_rate.items():
        if rate < 1.0:
            hard_ids.add(tid)
    for tid, outcomes in attempt_counts.items():
        if tid in explicit_pass_rate:
            continue
        if outcomes and (sum(outcomes) / len(outcomes)) < 1.0:
            hard_ids.add(tid)
    for tid, flag in hard_flags.items():
        if tid in explicit_pass_rate or tid in attempt_counts:
            continue
        if flag:
            hard_ids.add(tid)
    return hard_ids, score_info


def _sample_seed(base_seed: int, task_id: str, sample_index: int) -> int:
    digest_hex = hashlib.sha256(f"rft:{base_seed}:{task_id}:{sample_index}".encode("utf-8")).hexdigest()
    return int(digest_hex[:8], 16) % 2147483647


def _normalize_assistant_turns(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    turns: list[dict[str, Any]] = []
    for msg in messages:
        if msg.get("role") != "assistant":
            continue
        entry: dict[str, Any] = {"content": msg.get("content")}
        if msg.get("tool_calls"):
            # Normalize tool_call_id away when hashing trajectory equivalence so
            # two rollouts making identical calls/thoughts deduplicate cleanly.
            norm_tcs = []
            for tc in msg["tool_calls"]:
                fn = tc.get("function") if isinstance(tc, dict) else {}
                norm_tcs.append({
                    "name": (fn or {}).get("name"),
                    "arguments": (fn or {}).get("arguments"),
                })
            entry["tool_calls"] = norm_tcs
        turns.append(entry)
    return turns


def trajectory_hash(messages: list[dict[str, Any]]) -> str:
    payload = json.dumps(_normalize_assistant_turns(messages), ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _trajectory_signature(messages: list[dict[str, Any]]) -> tuple[tuple[str, ...], set[str]]:
    """Extract (tool-call plan sequence, text token bag) for diversity selection."""
    tool_plan: list[str] = []
    words: set[str] = set()
    for msg in messages:
        if msg.get("role") != "assistant":
            continue
        content = msg.get("content")
        chunks: list[str] = []
        if isinstance(content, str):
            chunks.append(content)
        elif isinstance(content, list):
            for part in content:
                if isinstance(part, dict):
                    if part.get("type") == "thinking":
                        chunks.append(str(part.get("thinking") or ""))
                    elif part.get("type") in ("text", "output_text"):
                        chunks.append(str(part.get("text") or ""))
        for chunk in chunks:
            words.update(re.findall(r"[A-Za-z0-9_$.]+", chunk))
        for tc in msg.get("tool_calls") or []:
            fn = tc.get("function") if isinstance(tc, dict) else {}
            tool_plan.append(f"{(fn or {}).get('name')}:{(fn or {}).get('arguments')}")
    return tuple(tool_plan), words


def _trajectory_distance(
    sig_a: tuple[tuple[str, ...], set[str]],
    sig_b: tuple[tuple[str, ...], set[str]],
) -> float:
    plan_a, words_a = sig_a
    plan_b, words_b = sig_b
    plan_bonus = 1.0 if plan_a != plan_b else 0.0
    union = len(words_a | words_b)
    jaccard_dist = (1.0 - len(words_a & words_b) / union) if union > 0 else 0.0
    return plan_bonus + jaccard_dist


def _is_verified_pass(record: dict[str, Any]) -> bool:
    if record.get("infrastructure_error"):
        return False
    grade = record.get("grade")
    if not isinstance(grade, dict):
        return False
    if not (bool(grade.get("success")) and bool(record.get("complete"))):
        return False
    msgs = record.get("messages")
    if not isinstance(msgs, list) or not any(m.get("role") == "assistant" for m in msgs):
        return False
    samples = record.get("samples") or []
    if any(isinstance(s, dict) and s.get("provenance_error") for s in samples):
        return False
    return True


def select_passing_rollouts(
    passing: list[tuple[int, dict[str, Any]]],
    *,
    max_per_task: int = 1,
) -> list[tuple[int, dict[str, Any], str]]:
    """Deduplicate verified passing rollouts and pick shortest (+ diverse extras up to max_per_task)."""
    if max_per_task <= 0 or not passing:
        return []

    # Sort deterministically by (generated_tokens, sample_index) so shortest wins on duplicates.
    ordered = sorted(
        passing,
        key=lambda item: (int(item[1].get("generated_tokens", 0)), int(item[0])),
    )
    unique: list[tuple[int, dict[str, Any], str]] = []
    seen_hashes: set[str] = set()
    for sample_idx, rec in ordered:
        th = trajectory_hash(rec["messages"])
        if th in seen_hashes:
            continue
        seen_hashes.add(th)
        unique.append((sample_idx, rec, th))

    if len(unique) <= 1 or max_per_task == 1:
        return unique[:max_per_task]

    # Always pick shortest verified passing trajectory first.
    chosen = [unique[0]]
    chosen_sigs = [_trajectory_signature(unique[0][1]["messages"])]
    remaining = unique[1:]
    sigs = {th: _trajectory_signature(rec["messages"]) for _, rec, th in remaining}

    while len(chosen) < max_per_task and remaining:
        best_idx = 0
        best_key: tuple[float, int, int] | None = None
        for idx, (sample_idx, rec, th) in enumerate(remaining):
            sig = sigs[th]
            min_dist = min(_trajectory_distance(sig, c_sig) for c_sig in chosen_sigs)
            # Maximize diversity distance, tie-break by shorter generated_tokens then sample_index.
            key = (-round(min_dist, 6), int(rec.get("generated_tokens", 0)), int(sample_idx))
            if best_key is None or key < best_key:
                best_key = key
                best_idx = idx
        picked = remaining.pop(best_idx)
        chosen.append(picked)
        chosen_sigs.append(sigs[picked[2]])
    return chosen


def _fallback_source_hash(task: dict[str, Any]) -> str:
    payload = {
        "source": task.get("source"),
        "files": task.get("files"),
        "entryFile": task.get("entryFile"),
        "entry": task.get("entry"),
    }
    return hashlib.sha256(
        json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()


def build_rft_sft_row(
    source_row: dict[str, Any],
    record: dict[str, Any],
    *,
    sample_index: int,
    selection_rank: int,
    traj_hash: str,
    samples_passed: int,
    samples_attempted: int,
    sampler_path: str | None,
    model: str,
    resolved_source_hash: str,
    resolved_task: dict[str, Any],
) -> dict[str, Any]:
    """Construct a pre-exported SFT row directly compatible with runner._is_preexported_row."""
    orig_id = _row_id(source_row)
    row_id = orig_id if selection_rank == 0 else f"{orig_id}__rft{selection_rank}"
    family = str(source_row.get("family") or resolved_task.get("family") or orig_id)
    lang = _row_language(source_row)
    schema = source_row.get("schema") or (
        "readable-py-execution/1" if lang == "py" else "readable-js-execution/1"
    )
    base_meta = task_metadata(source_row)
    grade = record["grade"]
    meta = {
        **base_meta,
        "sourceVerified": True,
        "rftCollected": True,
        "externalCalls": int(grade.get("expectedExternalCalls", grade.get("externalCalls", 0)) or 0),
    }
    if "codeLoadCalls" in grade:
        meta["codeLoadCalls"] = int(grade["codeLoadCalls"])

    split = _row_split(source_row) or "train"
    task_copy = copy.deepcopy(resolved_task)
    if "split" in task_copy:
        task_copy["split"] = split

    out: dict[str, Any] = {
        "schema": schema,
        "id": row_id,
        "family": family,
        "sourceHash": resolved_source_hash,
        "split": split,
        "task": task_copy,
        "messages": copy.deepcopy(record["messages"]),
        "metadata": meta,
        "rft_metadata": {
            "original_task_id": orig_id,
            "sampler_path": sampler_path,
            "model": model,
            "seed": int(record.get("seed", 0)),
            "sample_index": int(sample_index),
            "selection_rank": int(selection_rank),
            "generated_tokens": int(record.get("generated_tokens", 0)),
            "turns": len(record.get("samples") or []),
            "external_calls": int(grade.get("externalCalls", 0) or 0),
            "expected_external_calls": int(grade.get("expectedExternalCalls", 0) or 0),
            "code_load_calls": int(grade.get("codeLoadCalls", 0) or 0),
            "pass_rate": samples_passed / samples_attempted if samples_attempted else 0.0,
            "samples_passed": int(samples_passed),
            "samples_attempted": int(samples_attempted),
            "trajectory_hash": traj_hash,
        },
    }
    if lang:
        out["language"] = lang
    if isinstance(source_row.get("split_component"), str) and source_row["split_component"]:
        out["split_component"] = source_row["split_component"]
    if isinstance(source_row.get("ancestors"), list):
        out["ancestors"] = copy.deepcopy(source_row["ancestors"])
    if isinstance(source_row.get("sourceHashes"), list):
        out["sourceHashes"] = copy.deepcopy(source_row["sourceHashes"])
    return out


def _append_progress_durable(path: Path, entry: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as fh:
        fh.write(json_preserve_order(entry) + "\n")
        fh.flush()
        os.fsync(fh.fileno())


def _load_resume_progress(path: Path) -> dict[str, dict[str, Any]]:
    completed: dict[str, dict[str, Any]] = {}
    if not path.is_file():
        return completed
    raw_lines = path.read_text(encoding="utf-8").splitlines()
    for idx, line in enumerate(raw_lines):
        if not line.strip():
            continue
        try:
            rec = json.loads(line)
        except ValueError:
            if idx == len(raw_lines) - 1:
                print(
                    f"rft-collect: ignoring truncated trailing line in {path}",
                    file=sys.stderr,
                    flush=True,
                )
                break
            raise
        if isinstance(rec, dict) and isinstance(rec.get("task_id"), str) and rec.get("status") == "completed":
            completed[rec["task_id"]] = rec
    return completed


def filter_candidate_rows(
    rows: list[dict[str, Any]],
    *,
    split: str = "train",
    filter_features: str | Sequence[str] | frozenset[str] | None = None,
    hard_score_ids: set[str] | None = None,
    max_tasks: int | None = None,
) -> list[dict[str, Any]]:
    """Filter dataset rows by split, features, hard-mining scores, and max_tasks."""
    feature_set = parse_filter_features(filter_features)
    selected: list[dict[str, Any]] = []
    seen_ids: set[str] = set()
    for idx, row in enumerate(rows):
        tid = _row_id(row, idx)
        if tid in seen_ids:
            continue
        row_sp = _row_split(row) or "train"
        if split != "all" and row_sp != split:
            continue
        if hard_score_ids is not None and tid not in hard_score_ids:
            continue
        if feature_set and not (effective_row_features(row) & feature_set):
            continue
        seen_ids.add(tid)
        selected.append(row)
        if max_tasks is not None and len(selected) >= max_tasks:
            break
    return selected


def collect_rft(
    rows: list[dict[str, Any]],
    *,
    adapter: Any,
    bridge: Any = None,
    repo: Path | None = None,
    sampler_path: str | None = None,
    model: str = DEFAULT_MODEL,
    samples: int = 8,
    temperature: float = 1.0,
    effort: float = 0.5,
    max_context_tokens: int = 65472,
    max_tokens: int = 20480,
    max_generated_tokens: int = 49152,
    max_turns: int = 48,
    concurrency: int = 16,
    seed: int = 17,
    split: str = "train",
    filter_features: str | Sequence[str] | frozenset[str] | None = None,
    hard_scores_path: Path | None = None,
    max_tasks: int | None = None,
    max_per_task: int = 1,
    resume: bool = False,
    progress_path: Path | None = None,
    bridge_timeout_seconds: float = 60.0,
    dry_run: bool = False,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Run rejection-sampled fine-tuning collection with exact harness verification and durable resume."""
    if isinstance(samples, bool) or not isinstance(samples, int) or samples <= 0:
        raise ValueError("samples must be a positive integer")
    if isinstance(max_per_task, bool) or not isinstance(max_per_task, int) or max_per_task <= 0:
        raise ValueError("max_per_task must be a positive integer")
    if isinstance(concurrency, bool) or not isinstance(concurrency, int) or concurrency <= 0:
        raise ValueError("concurrency must be a positive integer")
    if max_tasks is not None and (isinstance(max_tasks, bool) or not isinstance(max_tasks, int) or max_tasks <= 0):
        raise ValueError("max_tasks must be a positive integer or None")
    if isinstance(temperature, bool) or not isinstance(temperature, (int, float)) or not math.isfinite(temperature) or temperature < 0:
        raise ValueError("temperature must be finite and nonnegative")

    started_at = time.monotonic()
    hard_ids: set[str] | None = None
    if hard_scores_path is not None:
        hard_ids, _ = load_hard_score_ids(hard_scores_path)

    candidates = filter_candidate_rows(
        rows,
        split=split,
        filter_features=filter_features,
        hard_score_ids=hard_ids,
        max_tasks=max_tasks,
    )

    completed_map: dict[str, dict[str, Any]] = {}
    if resume and progress_path is not None:
        completed_map = _load_resume_progress(progress_path)

    pending_rows = [row for row in candidates if _row_id(row) not in completed_map]
    resumed_count = len(candidates) - len(pending_rows)

    if dry_run:
        feature_counts = Counter(
            feat for row in candidates for feat in sorted(effective_row_features(row))
        )
        summary = {
            "dry_run": True,
            "model": model,
            "sampler_path": sampler_path,
            "input_rows": len(rows),
            "selected_tasks": len(candidates),
            "already_completed_on_resume": resumed_count,
            "pending_tasks": len(pending_rows),
            "samples_per_task": samples,
            "planned_rollouts": len(pending_rows) * samples,
            "max_per_task": max_per_task,
            "split": split,
            "filter_features": sorted(parse_filter_features(filter_features)),
            "hard_scores_count": len(hard_ids) if hard_ids is not None else None,
            "selected_feature_counts": dict(sorted(feature_counts.items())),
            "elapsed_seconds": round(time.monotonic() - started_at, 3),
        }
        return [], summary

    rollout_config = copy.deepcopy(DEFAULTS)
    rollout_config.update({
        "model": model,
        "seed": seed,
        "temperature": float(temperature),
        "effort": float(effort),
        "max_context_tokens": int(max_context_tokens),
        "max_tokens": int(max_tokens),
        "max_generated_tokens": int(max_generated_tokens),
        "max_turns": int(max_turns),
        "tolerate_rollout_errors": True,
        "prompt_style": "standard",
    })

    owned_bridge: Bridge | None = None
    active_bridge = bridge
    if active_bridge is None and pending_rows:
        owned_bridge = Bridge(repo or _REPO_ROOT, timeout=bridge_timeout_seconds)
        active_bridge = owned_bridge

    progress_lock = threading.Lock()
    task_results_by_id: dict[str, dict[str, Any]] = dict(completed_map)

    try:
        if (pending_rows
                and adapter is not None
                and callable(getattr(adapter, "create_sampling_client", None))
                and hasattr(adapter, "sampling_client")
                and adapter.sampling_client is None):
            adapter.create_sampling_client(checkpoint=sampler_path)

        # Resolve sourceHash + canonical task for any raw input row once per pending task.
        resolved_meta: dict[str, tuple[str, dict[str, Any]]] = {}
        for row in pending_rows:
            tid = _row_id(row)
            task_obj = _row_task(row)
            sh = row.get("sourceHash")
            if isinstance(sh, str) and sh:
                resolved_meta[tid] = (sh, task_obj)
            else:
                try:
                    exported = active_bridge.request("export", task=task_obj, traceFormat="actions-only")
                    resolved_meta[tid] = (
                        str(exported.get("sourceHash") or _fallback_source_hash(task_obj)),
                        exported.get("task") if isinstance(exported.get("task"), dict) else task_obj,
                    )
                except Exception:
                    resolved_meta[tid] = (_fallback_source_hash(task_obj), task_obj)

        if pending_rows:
            total_tasks = len(candidates)
            done_tasks = resumed_count
            per_task_passing: dict[str, list[tuple[int, dict[str, Any]]]] = defaultdict(list)
            per_task_remaining: dict[str, int] = {_row_id(r): samples for r in pending_rows}
            per_task_errors: dict[str, int] = defaultdict(int)
            per_task_failures: dict[str, Counter] = defaultdict(Counter)
            row_by_id = {_row_id(r): r for r in pending_rows}

            def _run_one_sample(row: dict[str, Any], sample_idx: int) -> tuple[str, int, dict[str, Any] | None, str | None]:
                tid = _row_id(row)
                _, task_obj = resolved_meta[tid]
                sample_seed = _sample_seed(seed, tid, sample_idx)
                try:
                    rec = rollout(
                        active_bridge,
                        adapter,
                        task_obj,
                        rollout_config,
                        sample_seed,
                        temperature=float(temperature),
                    )
                    return tid, sample_idx, rec, None
                except (RolloutError, Exception) as exc:
                    return tid, sample_idx, None, f"{type(exc).__name__}: {exc}"

            def _finalize_task(tid: str) -> None:
                nonlocal done_tasks
                row = row_by_id[tid]
                sh, task_obj = resolved_meta[tid]
                passing = per_task_passing.get(tid, [])
                chosen = select_passing_rollouts(passing, max_per_task=max_per_task)
                sft_rows = [
                    build_rft_sft_row(
                        row,
                        rec,
                        sample_index=s_idx,
                        selection_rank=rank,
                        traj_hash=th,
                        samples_passed=len(passing),
                        samples_attempted=samples,
                        sampler_path=sampler_path,
                        model=model,
                        resolved_source_hash=sh,
                        resolved_task=task_obj,
                    )
                    for rank, (s_idx, rec, th) in enumerate(chosen)
                ]
                entry = {
                    "task_id": tid,
                    "status": "completed",
                    "samples_attempted": samples,
                    "samples_passed": len(passing),
                    "pass_rate": len(passing) / samples,
                    "selected_count": len(sft_rows),
                    "infra_errors": int(per_task_errors.get(tid, 0)),
                    "failure_reasons": dict(sorted(per_task_failures.get(tid, Counter()).items())),
                    "selected_rows": sft_rows,
                }
                task_results_by_id[tid] = entry
                if progress_path is not None:
                    with progress_lock:
                        _append_progress_durable(progress_path, entry)
                done_tasks += 1
                print(
                    f"rft [{done_tasks}/{total_tasks}] {tid}: passed={len(passing)}/{samples} "
                    f"kept={len(sft_rows)} errors={entry['infra_errors']}",
                    file=sys.stderr,
                    flush=True,
                )

            jobs = [(row, s_idx) for row in pending_rows for s_idx in range(samples)]
            workers = min(concurrency, len(jobs))
            if workers <= 1:
                for row, s_idx in jobs:
                    tid, sample_idx, rec, err = _run_one_sample(row, s_idx)
                    if err is not None:
                        per_task_errors[tid] += 1
                        per_task_failures[tid]["infrastructure_error"] += 1
                        print(f"warning: rft rollout error on {tid} sample {sample_idx}: {err}", file=sys.stderr, flush=True)
                    elif rec is not None and _is_verified_pass(rec):
                        per_task_passing[tid].append((sample_idx, rec))
                    else:
                        reason = str((rec or {}).get("grade", {}).get("failureCategory")
                                     or (rec or {}).get("grade", {}).get("reason") or "failed")
                        per_task_failures[tid][reason] += 1
                    per_task_remaining[tid] -= 1
                    if per_task_remaining[tid] == 0:
                        _finalize_task(tid)
            else:
                with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
                    futures = [pool.submit(_run_one_sample, row, s_idx) for row, s_idx in jobs]
                    for fut in concurrent.futures.as_completed(futures):
                        tid, sample_idx, rec, err = fut.result()
                        if err is not None:
                            per_task_errors[tid] += 1
                            per_task_failures[tid]["infrastructure_error"] += 1
                            print(f"warning: rft rollout error on {tid} sample {sample_idx}: {err}", file=sys.stderr, flush=True)
                        elif rec is not None and _is_verified_pass(rec):
                            per_task_passing[tid].append((sample_idx, rec))
                        else:
                            reason = str((rec or {}).get("grade", {}).get("failureCategory")
                                         or (rec or {}).get("grade", {}).get("reason") or "failed")
                            per_task_failures[tid][reason] += 1
                        per_task_remaining[tid] -= 1
                        if per_task_remaining[tid] == 0:
                            _finalize_task(tid)
    finally:
        if owned_bridge is not None:
            owned_bridge.close()

    collected_rows: list[dict[str, Any]] = []
    seen_out_ids: set[str] = set()
    tasks_with_pass = 0
    total_attempted = 0
    total_passed = 0
    total_infra_errors = 0
    failure_counter: Counter = Counter()

    for row in candidates:
        tid = _row_id(row)
        entry = task_results_by_id.get(tid)
        if not entry:
            continue
        total_attempted += int(entry.get("samples_attempted", 0))
        passed = int(entry.get("samples_passed", 0))
        total_passed += passed
        if passed > 0:
            tasks_with_pass += 1
        total_infra_errors += int(entry.get("infra_errors", 0))
        for k, v in (entry.get("failure_reasons") or {}).items():
            failure_counter[k] += int(v)
        for out_row in entry.get("selected_rows") or []:
            oid = out_row.get("id")
            if isinstance(oid, str) and oid not in seen_out_ids:
                seen_out_ids.add(oid)
                collected_rows.append(out_row)

    summary = {
        "dry_run": False,
        "model": model,
        "sampler_path": sampler_path,
        "input_rows": len(rows),
        "selected_tasks": len(candidates),
        "resumed_tasks": resumed_count,
        "newly_processed_tasks": len(pending_rows),
        "tasks_with_verified_pass": tasks_with_pass,
        "pass_at_k_rate": (tasks_with_pass / len(candidates)) if candidates else 0.0,
        "samples_per_task": samples,
        "total_rollouts_attempted": total_attempted,
        "total_rollouts_passed": total_passed,
        "total_infra_errors": total_infra_errors,
        "collected_sft_rows": len(collected_rows),
        "max_per_task": max_per_task,
        "split": split,
        "filter_features": sorted(parse_filter_features(filter_features)),
        "failure_reasons": dict(sorted(failure_counter.items())),
        "elapsed_seconds": round(time.monotonic() - started_at, 3),
    }
    return collected_rows, summary


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset", type=Path, required=True, help="Input JSONL dataset (pre-exported or raw tasks)")
    parser.add_argument("--output", type=Path, required=True, help="Output JSONL of verified passing pre-exported SFT rows")
    parser.add_argument("--sampler-path", "--checkpoint", dest="sampler_path", default=None,
                        help="Tinker sampler checkpoint path (optional; base model if omitted)")
    parser.add_argument("--model", default=DEFAULT_MODEL, help=f"Model ID (default: {DEFAULT_MODEL})")
    parser.add_argument("--samples", type=int, default=8, help="Rollouts sampled per task (default: 8)")
    parser.add_argument("--temperature", type=float, default=1.0, help="Sampling temperature (default: 1.0)")
    parser.add_argument("--effort", type=float, default=0.5, help="Reasoning effort (default: 0.5)")
    parser.add_argument("--max-context-tokens", type=int, default=65472, help="Max context tokens (default: 65472)")
    parser.add_argument("--max-tokens", type=int, default=20480, help="Max tokens per turn (default: 20480)")
    parser.add_argument("--max-generated-tokens", type=int, default=49152, help="Max total generated tokens per rollout (default: 49152)")
    parser.add_argument("--max-turns", type=int, default=48, help="Max turns per rollout (default: 48)")
    parser.add_argument("--concurrency", type=int, default=16, help="Parallel rollout worker threads (default: 16)")
    parser.add_argument("--seed", type=int, default=17, help="Deterministic base seed (default: 17)")
    parser.add_argument("--split", choices=("train", "all", "validation", "test"), default="train",
                        help="Input split to sample from (default: train)")
    parser.add_argument("--filter-features", default=None,
                        help="Comma-separated features to include (e.g., long-context-65k,browser-dom,external,python,typescript)")
    parser.add_argument("--hard-scores", type=Path, default=None,
                        help="Optional scores.jsonl from hard mining or eval to focus on tasks with < 1.0 pass rate")
    parser.add_argument("--max-tasks", type=int, default=None, help="Maximum number of tasks to process")
    parser.add_argument("--max-per-task", type=int, default=1,
                        help="Max verified passing rollouts to keep per task (default: 1, shortest pass; >1 picks diverse passes)")
    parser.add_argument("--resume", action="store_true", help="Resume from per-task progress JSONL")
    parser.add_argument("--progress-path", type=Path, default=None,
                        help="Path for durable per-task progress JSONL (default: <output>.progress.jsonl)")
    parser.add_argument("--summary-out", type=Path, default=None, help="Optional JSON summary output path")
    parser.add_argument("--bridge-timeout", type=float, default=60.0, help="Execution bridge timeout in seconds (default: 60)")
    parser.add_argument("--repo", type=Path, default=_REPO_ROOT, help="Repository root for execution Bridge")
    parser.add_argument("--dry-run", action="store_true", help="Inspect selected tasks and rollout plan without calling Tinker")
    args = parser.parse_args(argv)

    rows = read_jsonl(args.dataset)
    progress_path = args.progress_path or args.output.with_suffix(".progress.jsonl")
    adapter: Any = None
    if not args.dry_run:
        adapter = TinkerAdapter({
            "model": args.model,
            "effort": args.effort,
            "max_context_tokens": args.max_context_tokens,
            "max_tokens": args.max_tokens,
            "temperature": args.temperature,
            "seed": args.seed,
        })
        adapter.create_sampling_client(checkpoint=args.sampler_path)

    collected_rows, summary = collect_rft(
        rows,
        adapter=adapter,
        repo=args.repo,
        sampler_path=args.sampler_path,
        model=args.model,
        samples=args.samples,
        temperature=args.temperature,
        effort=args.effort,
        max_context_tokens=args.max_context_tokens,
        max_tokens=args.max_tokens,
        max_generated_tokens=args.max_generated_tokens,
        max_turns=args.max_turns,
        concurrency=args.concurrency,
        seed=args.seed,
        split=args.split,
        filter_features=args.filter_features,
        hard_scores_path=args.hard_scores,
        max_tasks=args.max_tasks,
        max_per_task=args.max_per_task,
        resume=args.resume,
        progress_path=progress_path,
        bridge_timeout_seconds=args.bridge_timeout,
        dry_run=args.dry_run,
    )
    if not args.dry_run:
        write_jsonl(args.output, collected_rows)
        summary["output"] = str(args.output)
        summary["progress_path"] = str(progress_path)
    if args.summary_out is not None:
        atomic_json(args.summary_out, summary)
        summary["summary_out"] = str(args.summary_out)
    print(json.dumps(summary, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
