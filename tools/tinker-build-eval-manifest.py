#!/usr/bin/env python3
"""Build a stratified multi-axis evaluation manifest compatible with runner.py."""

from __future__ import annotations

import argparse
from collections import Counter, defaultdict
import json
import math
from pathlib import Path
import random
import sys
from typing import Any

_REPO_ROOT = Path(__file__).resolve().parents[1]
_TRAINING_DIR = str(_REPO_ROOT / "training")
if _TRAINING_DIR not in sys.path:
    sys.path.insert(0, _TRAINING_DIR)

from tinker_js.metrics import task_eval_bucket  # noqa: E402
from tinker_js.runner import atomic_json, read_jsonl  # noqa: E402


DEFAULT_BUCKET_QUOTAS: dict[str, int] = {
    "python": 40,
    "hairy-real": 40,
    "hard-effectful": 25,
    "oss-unit-test": 50,
    "oss-probe": 30,
    "hard-js-owned": 15,
}


def parse_quotas(raw: str | dict[str, int] | None) -> dict[str, int]:
    """Parse bucket quotas from a JSON string, file path, or key=value/key:value pairs."""
    if raw is None:
        return dict(DEFAULT_BUCKET_QUOTAS)
    if isinstance(raw, dict):
        parsed: Any = raw
    else:
        text = str(raw).strip()
        if not text:
            raise ValueError("quotas cannot be empty")
        maybe_path = Path(text)
        if not text.startswith("{") and maybe_path.is_file():
            parsed = json.loads(maybe_path.read_text(encoding="utf-8"))
        elif text.startswith("{"):
            parsed = json.loads(text)
        else:
            parsed = {}
            for chunk in text.split(","):
                item = chunk.strip()
                if not item:
                    continue
                sep = "=" if "=" in item else ":"
                if sep not in item:
                    raise ValueError(f"invalid quota entry {item!r}; expected bucket=count or bucket:count")
                key, val = item.split(sep, 1)
                key = key.strip()
                if not key:
                    raise ValueError(f"empty bucket name in quota entry {item!r}")
                parsed[key] = int(val.strip())
    if not isinstance(parsed, dict) or not parsed:
        raise ValueError("quotas must be a nonempty mapping of bucket -> integer count")
    result: dict[str, int] = {}
    for key, val in parsed.items():
        if not isinstance(key, str) or not key.strip():
            raise ValueError("quota bucket names must be nonempty strings")
        if isinstance(val, bool) or not isinstance(val, int) or val < 0:
            raise ValueError(f"quota for {key!r} must be a nonnegative integer")
        result[key.strip()] = val
    return result


def _apportion_counts(total: int, weights: dict[str, float]) -> dict[str, int]:
    """Largest-remainder apportionment of `total` across keys proportional to `weights`."""
    if total <= 0:
        return {k: 0 for k in weights}
    positive = {k: float(w) for k, w in weights.items() if w > 0}
    total_w = sum(positive.values())
    if total_w <= 0:
        return {k: 0 for k in weights}
    raw = {k: total * w / total_w for k, w in positive.items()}
    alloc = {k: int(math.floor(val)) for k, val in raw.items()}
    remainder = total - sum(alloc.values())
    if remainder > 0:
        order = list(positive.keys())
        ranked = sorted(order, key=lambda k: (-(raw[k] - alloc[k]), order.index(k)))
        for k in ranked[:remainder]:
            alloc[k] += 1
    return {k: alloc.get(k, 0) for k in weights}


def _family_round_robin_queue(rows: list[dict], seed: int) -> list[dict]:
    """Order rows within one bucket by seeded round-robin across family/split components."""
    groups: dict[str, list[dict]] = defaultdict(list)
    for row in sorted(rows, key=lambda r: r["id"]):
        comp = row.get("split_component") or row.get("family") or row["id"]
        groups[str(comp)].append(row)
    rng = random.Random(seed)
    names = sorted(groups)
    rng.shuffle(names)
    for name in names:
        rng.shuffle(groups[name])
    queue: list[dict] = []
    while any(groups.values()):
        for name in names:
            if groups[name]:
                queue.append(groups[name].pop())
    return queue


def select_stratified_split(
    rows: list[dict],
    *,
    max_tasks: int = 200,
    quotas: dict[str, int] | None = None,
    seed: int = 17,
    quotas_explicit: bool = False,
) -> tuple[list[str], dict[str, int], dict[str, int]]:
    """Select up to `max_tasks` stratified IDs across evaluation buckets.

    Returns `(selected_ids, selected_bucket_counts, target_quotas)`.
    """
    if isinstance(max_tasks, bool) or not isinstance(max_tasks, int) or max_tasks <= 0:
        raise ValueError("max_tasks must be a positive integer")
    if not rows:
        return [], {}, {}

    base_quotas = dict(DEFAULT_BUCKET_QUOTAS if quotas is None else quotas)
    target_total = min(max_tasks, len(rows))

    by_bucket: dict[str, list[dict]] = defaultdict(list)
    for row in rows:
        by_bucket[task_eval_bucket(row)].append(row)

    bucket_order = list(base_quotas.keys())
    for bucket in sorted(by_bucket):
        if bucket not in base_quotas:
            bucket_order.append(bucket)

    quota_sum = sum(base_quotas.values())
    if (not quotas_explicit and target_total != quota_sum) or quota_sum > target_total:
        target_quotas = _apportion_counts(target_total, {k: float(base_quotas.get(k, 0)) for k in bucket_order})
    else:
        target_quotas = {k: int(base_quotas.get(k, 0)) for k in bucket_order}

    queues = {
        bucket: _family_round_robin_queue(by_bucket.get(bucket, []), seed + idx * 101)
        for idx, bucket in enumerate(bucket_order)
    }

    selected_by_bucket: dict[str, list[dict]] = {bucket: [] for bucket in bucket_order}
    for bucket in bucket_order:
        want = min(target_quotas.get(bucket, 0), len(queues[bucket]))
        if want > 0:
            selected_by_bucket[bucket].extend(queues[bucket][:want])
            queues[bucket] = queues[bucket][want:]

    shortfall = target_total - sum(len(items) for items in selected_by_bucket.values())
    while shortfall > 0:
        remaining_counts = {bucket: len(q) for bucket, q in queues.items() if q}
        if not remaining_counts:
            break
        extra = _apportion_counts(shortfall, {b: float(c) for b, c in remaining_counts.items()})
        took = 0
        for bucket in bucket_order:
            n = min(extra.get(bucket, 0), len(queues[bucket]))
            if n > 0:
                selected_by_bucket[bucket].extend(queues[bucket][:n])
                queues[bucket] = queues[bucket][n:]
                took += n
        if took == 0:
            # Fallback if all remaining weights rounded to zero (cannot happen for positive counts).
            for bucket in bucket_order:
                if queues[bucket] and shortfall > 0:
                    selected_by_bucket[bucket].append(queues[bucket].pop(0))
                    took += 1
                    shortfall -= 1
        else:
            shortfall -= took

    rank = {bucket: idx for idx, bucket in enumerate(bucket_order)}
    chosen_rows = [row for bucket in bucket_order for row in selected_by_bucket[bucket]]
    chosen_rows.sort(key=lambda r: (rank[task_eval_bucket(r)], r["id"]))
    selected_ids = [row["id"] for row in chosen_rows]
    if len(set(selected_ids)) != len(selected_ids):
        raise ValueError("dataset contains duplicate task IDs")
    bucket_counts = dict(Counter(task_eval_bucket(r) for r in chosen_rows))
    return selected_ids, {b: bucket_counts.get(b, 0) for b in bucket_order if bucket_counts.get(b, 0) > 0}, target_quotas


def build_eval_manifest(
    rows: list[dict],
    *,
    max_tasks: int = 200,
    quotas: dict[str, int] | None = None,
    quotas_explicit: bool = False,
    splits: tuple[str, ...] = ("validation", "test"),
    default_split: str | None = None,
    seed: int = 17,
) -> dict[str, Any]:
    """Build a stratified evaluation manifest mapping split names to selected IDs."""
    if not rows:
        raise ValueError("dataset is empty")
    grouped: dict[str, list[dict]] = defaultdict(list)
    unsplit_count = 0
    for row in rows:
        sp = row.get("split")
        if sp is None and isinstance(row.get("task"), dict):
            sp = row["task"].get("split")
        if sp is None:
            unsplit_count += 1
            if default_split is None:
                continue
            sp = default_split
        grouped[str(sp)].append(row)

    if unsplit_count == len(rows) and default_split is None:
        raise ValueError("input dataset has no split annotations; pass --default-split or split-annotated JSONL")

    splits_out: dict[str, list[str]] = {}
    bucket_counts_out: dict[str, dict[str, int]] = {}
    available_counts: dict[str, dict[str, int]] = {}
    quotas_used: dict[str, dict[str, int]] = {}
    for idx, split_name in enumerate(splits):
        pool = grouped.get(split_name, [])
        if not pool:
            continue
        ids, counts, effective_quotas = select_stratified_split(
            pool,
            max_tasks=max_tasks,
            quotas=quotas,
            seed=seed + idx * 1009,
            quotas_explicit=quotas_explicit,
        )
        splits_out[split_name] = ids
        bucket_counts_out[split_name] = counts
        quotas_used[split_name] = effective_quotas
        avail = Counter(task_eval_bucket(r) for r in pool)
        available_counts[split_name] = {k: avail[k] for k in sorted(avail)}

    if not splits_out:
        raise ValueError(f"no rows found for requested splits {list(splits)}")

    return {
        "splits": splits_out,
        "max_tasks": max_tasks,
        "seed": seed,
        "quotas": dict(DEFAULT_BUCKET_QUOTAS if quotas is None else quotas),
        "effective_quotas": quotas_used,
        "bucket_counts": bucket_counts_out,
        "available_counts": available_counts,
        "totals": {sp: len(ids) for sp, ids in splits_out.items()},
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset", type=Path, required=True, help="Input dataset JSONL (dataset.jsonl, validation.jsonl, or test.jsonl)")
    parser.add_argument("--output", type=Path, required=True, help="Output evaluation manifest JSON path")
    parser.add_argument("--max-tasks", type=int, default=200, help="Target max tasks per split (default: 200)")
    parser.add_argument("--quotas", default=None, help="Bucket quotas as JSON string, JSON file, or bucket=count,...")
    parser.add_argument("--splits", default="validation,test", help="Comma-separated splits to include (default: validation,test)")
    parser.add_argument("--default-split", choices=("train", "validation", "test"), default=None,
                        help="Split name if input JSONL rows have no split field")
    parser.add_argument("--seed", type=int, default=17, help="Deterministic seed (default: 17)")
    args = parser.parse_args(argv)

    rows = read_jsonl(args.dataset)
    quotas_explicit = args.quotas is not None
    quotas = parse_quotas(args.quotas)
    splits = tuple(s.strip() for s in args.splits.split(",") if s.strip())
    if not splits:
        raise ValueError("--splits must list at least one split")
    manifest = build_eval_manifest(
        rows,
        max_tasks=args.max_tasks,
        quotas=quotas,
        quotas_explicit=quotas_explicit,
        splits=splits,
        default_split=args.default_split,
        seed=args.seed,
    )
    atomic_json(args.output, manifest)
    print(json.dumps({
        "output": str(args.output),
        "totals": manifest["totals"],
        "bucket_counts": manifest["bucket_counts"],
        "available_counts": manifest["available_counts"],
    }, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
