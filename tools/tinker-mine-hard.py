#!/usr/bin/env python3
"""Fast hard-set miner for filtering already-mastered tasks while preserving hard/diverse coverage.

Supports:
- `--mode logprob` (default): scores exact zero-thinking target action log-likelihood
  `log P(y_t | prefix_no_thinking)` in parallel without expensive generation.
- `--mode sample`: samples 1 thinking block (`max_tokens=4096`) via
  `sample_thinking_and_score_target()` and flags hard/truncated/long-thought tasks.

Always preserves all `validation` and `test` rows untouched. On `train` rows,
keeps 100% of hard tasks, always-keep features, and `externalCalls > 0`, plus a
deterministic `--easy-replay-fraction` sample of the remaining easy tasks.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import json
import math
from pathlib import Path
import random
import statistics
import sys
import time
from typing import Any, Sequence

_REPO_ROOT = Path(__file__).resolve().parents[1]
_TRAINING_DIR = str(_REPO_ROOT / "training")
if _TRAINING_DIR not in sys.path:
    sys.path.insert(0, _TRAINING_DIR)

from tinker_js.adapter import ContextOverflow, DEFAULT_MODEL, TinkerAdapter, model_context_limit  # noqa: E402
from tinker_js.runner import Bridge, read_jsonl, write_jsonl  # noqa: E402


DEFAULT_ALWAYS_KEEP_FEATURES = ("hairy-real", "hard-effectful", "unit-test-input", "python")


def parse_always_keep_features(raw: str | Sequence[str] | None) -> frozenset[str]:
    if raw is None:
        return frozenset(DEFAULT_ALWAYS_KEEP_FEATURES)
    if isinstance(raw, str):
        return frozenset(item.strip() for item in raw.split(",") if item.strip())
    return frozenset(str(item).strip() for item in raw if str(item).strip())


def _row_split(row: dict) -> str | None:
    split = row.get("split")
    if split is None and isinstance(row.get("task"), dict):
        split = row["task"].get("split")
    return str(split) if split is not None else None


def _row_id(row: dict, fallback_index: int) -> str:
    task = row.get("task") if isinstance(row.get("task"), dict) else {}
    value = row.get("id") or task.get("id") or f"row-{fallback_index}"
    return str(value)


def _merged_metadata(row: dict, exported: dict | None = None) -> dict[str, Any]:
    task = row.get("task") if isinstance(row.get("task"), dict) else {}
    task_meta = task.get("metadata") if isinstance(task.get("metadata"), dict) else {}
    row_meta = row.get("metadata") if isinstance(row.get("metadata"), dict) else {}
    exp_meta = (exported.get("metadata") if isinstance(exported, dict) and isinstance(exported.get("metadata"), dict) else {})
    return {**task_meta, **row_meta, **exp_meta}


def _row_language(row: dict, meta: dict[str, Any]) -> str | None:
    task = row.get("task") if isinstance(row.get("task"), dict) else {}
    lang = row.get("language") or task.get("language") or meta.get("language")
    return str(lang) if lang is not None else None


def _effective_features(row: dict, meta: dict[str, Any], task_id: str, language: str | None) -> set[str]:
    raw = meta.get("features") or []
    features = {str(item) for item in raw if isinstance(item, str) and item}
    if language == "py" or task_id.startswith("py-"):
        features.add("python")
    return features


def _external_calls(meta: dict[str, Any]) -> int:
    value = meta.get("externalCalls", 0)
    if isinstance(value, (int, float)) and not isinstance(value, bool) and value > 0:
        return int(value)
    return 0


def _task_seed(seed: int, task_id: str) -> int:
    digest_hex = hashlib.sha256(f"{seed}:{task_id}".encode("utf-8")).hexdigest()
    return int(digest_hex[:8], 16) % (2**31 - 1)


def _score_turn_zero_thinking(adapter: Any, turn_target: dict) -> float:
    """Compute log P(y_t | prefix_no_thinking) using TinkerAdapter or a compatible fake adapter."""
    if hasattr(adapter, "score_target_without_thinking"):
        scored = adapter.score_target_without_thinking(turn_target)
        return float(scored["target_logprob_sum"])

    target_tokens = list(turn_target["target_action_tokens"])
    if not target_tokens:
        raise ValueError("turn_target requires nonempty target_action_tokens")
    effort = getattr(adapter, "effort", 0.5)
    if effort == 0.0 or not turn_target.get("thinking_prompt_tokens"):
        prefix_no_thinking = list(turn_target["prefix_tokens"])
    elif hasattr(adapter, "thinking_token_ids"):
        _m, _c, end_id = adapter.thinking_token_ids()
        prefix_no_thinking = list(turn_target["thinking_prompt_tokens"]) + [end_id]
    else:
        prefix_no_thinking = list(turn_target["prefix_tokens"])
    full_ids = prefix_no_thinking + target_tokens
    client = getattr(adapter, "sampling_client", None) or adapter
    if hasattr(adapter, "_sdk") and callable(adapter._sdk):
        model_input = adapter._sdk().types.ModelInput.from_ints(full_ids)
    else:
        model_input = full_ids
    result = client.compute_logprobs(model_input, prompt_logprobs_last_n=len(target_tokens))
    if hasattr(result, "result") and callable(result.result):
        result = result.result()
    if len(result) != len(full_ids):
        raise ValueError("compute_logprobs output length mismatch")
    return float(sum(float(v) for v in result[-len(target_tokens):]))


def _score_train_task(
    row: dict,
    row_idx: int,
    *,
    adapter: Any,
    bridge: Any,
    mode: str,
    hard_ll_threshold: float,
    always_keep_set: frozenset[str],
    seed: int,
    sample_max_tokens: int,
    long_thought_tokens: int,
) -> dict[str, Any]:
    task_id = _row_id(row, row_idx)
    exported: dict | None = None
    messages = row.get("messages")
    if not isinstance(messages, list) or not messages:
        if bridge is None:
            raise ValueError(f"Task {task_id} is missing 'messages' and no Bridge was provided for export")
        task_obj = row.get("task") if isinstance(row.get("task"), dict) else row
        exported = bridge.request("export", task=task_obj, traceFormat="compact", reasoningChannel="thinking")
        messages = exported.get("messages") or []

    meta = _merged_metadata(row, exported)
    language = _row_language(row, meta)
    features = _effective_features(row, meta, task_id, language)
    ext_calls = _external_calls(meta)
    is_always_keep = bool(features & always_keep_set) or ext_calls > 0

    min_ll: float | None = None
    turn_lls: list[float] = []
    turns_scored = 0
    total_turns = 0
    terminated: bool | None = None
    generated_tokens: int | None = None
    error: str | None = None
    is_hard = False

    try:
        turns = adapter.extract_turn_targets(messages)
        total_turns = len(turns)
        if not turns:
            is_hard = True
            error = "no_turns"
        elif mode == "logprob":
            if len(turns) <= 2:
                selected_turns = list(turns)
            else:
                turn_rng = random.Random(_task_seed(seed, task_id))
                selected_turns = sorted(
                    turn_rng.sample(list(turns), 2),
                    key=lambda item: item.get("turn_index", 0),
                )
            for turn in selected_turns:
                ll = _score_turn_zero_thinking(adapter, turn)
                turn_lls.append(ll)
            turns_scored = len(turn_lls)
            min_ll = min(turn_lls) if turn_lls else None
            is_hard = (min_ll is None) or (not math.isfinite(min_ll)) or (min_ll < hard_ll_threshold)
        else:
            task_seed = _task_seed(seed, task_id)
            turn = turns[0] if len(turns) == 1 else turns[random.Random(task_seed).randrange(len(turns))]
            sample = adapter.sample_thinking_and_score_target(
                turn,
                seed=task_seed,
                max_tokens=sample_max_tokens,
            )
            terminated = bool(sample.get("terminated"))
            generated_tokens = int(sample.get("generated_tokens", 0))
            raw_ll = sample.get("target_logprob_sum")
            if raw_ll is not None and math.isfinite(float(raw_ll)):
                min_ll = float(raw_ll)
                turn_lls = [min_ll]
            turns_scored = 1
            is_hard = (
                (not terminated)
                or (min_ll is None)
                or (min_ll < hard_ll_threshold)
                or (generated_tokens >= long_thought_tokens)
            )
    except ContextOverflow:
        is_hard = True
        error = "context_overflow"

    return {
        "id": task_id,
        "split": _row_split(row) or "train",
        "mode": mode,
        "is_hard": is_hard,
        "is_always_keep": is_always_keep,
        "min_ll": min_ll,
        "turn_lls": turn_lls,
        "turns_scored": turns_scored,
        "total_turns": total_turns,
        "terminated": terminated,
        "generated_tokens": generated_tokens,
        "features": sorted(features),
        "externalCalls": ext_calls,
        "language": language,
        "error": error,
    }


def mine_dataset(
    rows: list[dict],
    *,
    adapter: Any,
    bridge: Any = None,
    repo: Path | None = None,
    mode: str = "logprob",
    concurrency: int = 16,
    max_tasks: int | None = None,
    hard_ll_threshold: float = -0.3,
    easy_replay_fraction: float = 0.2,
    always_keep_features: str | Sequence[str] | frozenset[str] = DEFAULT_ALWAYS_KEEP_FEATURES,
    seed: int = 42,
    sample_max_tokens: int = 4096,
    long_thought_tokens: int = 1800,
    bridge_timeout_seconds: float = 60.0,
) -> tuple[list[dict], list[dict], dict[str, Any]]:
    """Filter mastered easy train tasks while preserving all held-out splits and hard/priority tasks."""
    if mode not in {"logprob", "sample"}:
        raise ValueError("mode must be 'logprob' or 'sample'")
    if isinstance(concurrency, bool) or not isinstance(concurrency, int) or concurrency <= 0:
        raise ValueError("concurrency must be a positive integer")
    if max_tasks is not None and (isinstance(max_tasks, bool) or not isinstance(max_tasks, int) or max_tasks <= 0):
        raise ValueError("max_tasks must be a positive integer or None")
    if isinstance(hard_ll_threshold, bool) or not isinstance(hard_ll_threshold, (int, float)) or not math.isfinite(hard_ll_threshold):
        raise ValueError("hard_ll_threshold must be finite")
    if (isinstance(easy_replay_fraction, bool) or not isinstance(easy_replay_fraction, (int, float))
            or not math.isfinite(easy_replay_fraction) or not 0.0 <= float(easy_replay_fraction) <= 1.0):
        raise ValueError("easy_replay_fraction must be finite in [0.0, 1.0]")

    started_at = time.monotonic()
    always_keep_set = parse_always_keep_features(always_keep_features)

    heldout_indices: list[int] = []
    train_indices: list[int] = []
    for idx, row in enumerate(rows):
        split = _row_split(row)
        if split in ("validation", "test"):
            heldout_indices.append(idx)
        else:
            train_indices.append(idx)

    if max_tasks is not None:
        train_indices = train_indices[:max_tasks]

    needs_bridge = bridge is None and any(
        not isinstance(rows[idx].get("messages"), list) or not rows[idx].get("messages")
        for idx in train_indices
    )
    owned_bridge: Bridge | None = None
    active_bridge = bridge
    if needs_bridge:
        owned_bridge = Bridge(repo or _REPO_ROOT, timeout=bridge_timeout_seconds)
        active_bridge = owned_bridge

    try:
        if (callable(getattr(adapter, "create_sampling_client", None))
                and hasattr(adapter, "sampling_client")
                and adapter.sampling_client is None):
            adapter.create_sampling_client()

        diagnostics: list[dict[str, Any]] = []
        if train_indices:
            workers = min(concurrency, len(train_indices))
            if workers <= 1:
                for pos, orig_idx in enumerate(train_indices):
                    diag = _score_train_task(
                        rows[orig_idx],
                        orig_idx,
                        adapter=adapter,
                        bridge=active_bridge,
                        mode=mode,
                        hard_ll_threshold=float(hard_ll_threshold),
                        always_keep_set=always_keep_set,
                        seed=seed,
                        sample_max_tokens=sample_max_tokens,
                        long_thought_tokens=long_thought_tokens,
                    )
                    diagnostics.append(diag)
                    if len(train_indices) >= 100 and (pos + 1) % 100 == 0:
                        print(f"mine-hard ({mode}): {pos + 1}/{len(train_indices)}", file=sys.stderr, flush=True)
            else:
                ordered: list[dict[str, Any] | None] = [None] * len(train_indices)
                done_count = 0
                with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
                    futures = {
                        pool.submit(
                            _score_train_task,
                            rows[orig_idx],
                            orig_idx,
                            adapter=adapter,
                            bridge=active_bridge,
                            mode=mode,
                            hard_ll_threshold=float(hard_ll_threshold),
                            always_keep_set=always_keep_set,
                            seed=seed,
                            sample_max_tokens=sample_max_tokens,
                            long_thought_tokens=long_thought_tokens,
                        ): pos
                        for pos, orig_idx in enumerate(train_indices)
                    }
                    try:
                        for fut in concurrent.futures.as_completed(futures):
                            pos = futures[fut]
                            ordered[pos] = fut.result()
                            done_count += 1
                            if len(train_indices) >= 100 and (done_count % 100 == 0 or done_count == len(train_indices)):
                                print(f"mine-hard ({mode}): {done_count}/{len(train_indices)}", file=sys.stderr, flush=True)
                    except Exception:
                        for fut in futures:
                            fut.cancel()
                        raise
                diagnostics = [item for item in ordered if item is not None]
    finally:
        if owned_bridge is not None:
            owned_bridge.close()

    easy_positions = [
        pos for pos, diag in enumerate(diagnostics)
        if not diag["is_hard"] and not diag["is_always_keep"]
    ]
    replay_count = min(len(easy_positions), max(0, round(len(easy_positions) * float(easy_replay_fraction))))
    replay_positions = set(random.Random(seed).sample(easy_positions, replay_count)) if replay_count > 0 else set()

    kept_train_original_indices: set[int] = set()
    hard_count = 0
    always_keep_only_count = 0
    easy_replay_count = 0
    dropped_easy_count = 0

    for pos, diag in enumerate(diagnostics):
        orig_idx = train_indices[pos]
        if diag["is_hard"]:
            diag["kept"] = True
            diag["keep_reason"] = "hard"
            kept_train_original_indices.add(orig_idx)
            hard_count += 1
        elif diag["is_always_keep"]:
            diag["kept"] = True
            diag["keep_reason"] = "always_keep"
            kept_train_original_indices.add(orig_idx)
            always_keep_only_count += 1
        elif pos in replay_positions:
            diag["kept"] = True
            diag["keep_reason"] = "easy_replay"
            kept_train_original_indices.add(orig_idx)
            easy_replay_count += 1
        else:
            diag["kept"] = False
            diag["keep_reason"] = "dropped_easy"
            dropped_easy_count += 1

    kept_indices = set(heldout_indices) | kept_train_original_indices
    output_rows = [rows[idx] for idx in range(len(rows)) if idx in kept_indices]

    finite_lls = [diag["min_ll"] for diag in diagnostics if diag["min_ll"] is not None]
    val_count = sum(1 for idx in heldout_indices if _row_split(rows[idx]) == "validation")
    test_count = sum(1 for idx in heldout_indices if _row_split(rows[idx]) == "test")

    summary = {
        "mode": mode,
        "hard_ll_threshold": float(hard_ll_threshold),
        "easy_replay_fraction": float(easy_replay_fraction),
        "always_keep_features": sorted(always_keep_set),
        "seed": seed,
        "input_rows": len(rows),
        "heldout_preserved": {"validation": val_count, "test": test_count, "total": len(heldout_indices)},
        "train_scored": len(diagnostics),
        "train_hard": hard_count,
        "train_always_keep_easy": always_keep_only_count,
        "train_easy_total": len(easy_positions),
        "train_easy_replay": easy_replay_count,
        "train_dropped_easy": dropped_easy_count,
        "train_kept": len(kept_train_original_indices),
        "output_rows": len(output_rows),
        "ll_stats": {
            "count": len(finite_lls),
            "mean": statistics.fmean(finite_lls) if finite_lls else None,
            "median": statistics.median(finite_lls) if finite_lls else None,
            "min": min(finite_lls) if finite_lls else None,
            "max": max(finite_lls) if finite_lls else None,
        },
        "elapsed_seconds": round(time.monotonic() - started_at, 3),
    }
    return output_rows, diagnostics, summary


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset", type=Path, required=True, help="Input JSONL dataset (exported rows or raw tasks)")
    parser.add_argument("--output", type=Path, required=True, help="Output filtered JSONL dataset")
    parser.add_argument("--checkpoint", default=None, help="Tinker sampler checkpoint path (optional; base model if omitted)")
    parser.add_argument("--model", default=DEFAULT_MODEL, help=f"Model ID (default: {DEFAULT_MODEL})")
    parser.add_argument("--mode", choices=("logprob", "sample"), default="logprob", help="Mining mode (default: logprob)")
    parser.add_argument("--concurrency", type=int, default=16, help="Parallel worker threads (default: 16)")
    parser.add_argument("--max-tasks", type=int, default=None, help="Max train tasks to screen (held-out splits always preserved)")
    parser.add_argument("--hard-ll-threshold", type=float, default=-0.3, help="Log-likelihood threshold below which tasks are hard")
    parser.add_argument("--easy-replay-fraction", type=float, default=0.2, help="Fraction of mastered easy train rows to retain")
    parser.add_argument("--always-keep-features", default=",".join(DEFAULT_ALWAYS_KEEP_FEATURES),
                        help="Comma-separated features to always keep on train split")
    parser.add_argument("--seed", type=int, default=42, help="Deterministic random seed (default: 42)")
    parser.add_argument("--scores-out", type=Path, default=None, help="Optional JSONL path for per-task difficulty diagnostics")
    parser.add_argument("--effort", type=float, default=0.5, help="Reasoning effort matching training config (default: 0.5)")
    parser.add_argument("--max-tokens", type=int, default=4096, help="Max thinking tokens in --mode sample (default: 4096)")
    parser.add_argument("--bridge-timeout", type=float, default=60.0, help="Bridge export timeout in seconds (default: 60)")
    parser.add_argument("--repo", type=Path, default=_REPO_ROOT, help="Repository root for Bridge export")
    args = parser.parse_args(argv)

    rows = read_jsonl(args.dataset)
    adapter = TinkerAdapter({
        "model": args.model,
        "effort": args.effort,
        "max_context_tokens": model_context_limit(args.model),
        "max_tokens": args.max_tokens,
    })
    adapter.create_sampling_client(checkpoint=args.checkpoint)

    output_rows, diagnostics, summary = mine_dataset(
        rows,
        adapter=adapter,
        repo=args.repo,
        mode=args.mode,
        concurrency=args.concurrency,
        max_tasks=args.max_tasks,
        hard_ll_threshold=args.hard_ll_threshold,
        easy_replay_fraction=args.easy_replay_fraction,
        always_keep_features=args.always_keep_features,
        seed=args.seed,
        sample_max_tokens=args.max_tokens,
        bridge_timeout_seconds=args.bridge_timeout,
    )
    write_jsonl(args.output, output_rows)
    if args.scores_out is not None:
        write_jsonl(args.scores_out, diagnostics)
    summary["output"] = str(args.output)
    if args.scores_out is not None:
        summary["scores_out"] = str(args.scores_out)
    print(json.dumps(summary, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
