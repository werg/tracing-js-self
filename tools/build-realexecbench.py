#!/usr/bin/env python3
"""Build the frozen 5-track zero-leakage RealExecBench v1 suite."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys

_REPO_ROOT = Path(__file__).resolve().parents[1]
_TRAINING_DIR = str(_REPO_ROOT / "training")
if _TRAINING_DIR not in sys.path:
    sys.path.insert(0, _TRAINING_DIR)

from tinker_js.external_benchmarks import DEFAULT_CACHE_DIR  # noqa: E402
from tinker_js.realexecbench import build_realexecbench_v1  # noqa: E402


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--reference-dataset",
        type=Path,
        default=Path("/home/werg/tracing-js-self/runs/messy-v6-stage8/stage8-exported.jsonl"),
        help="Read-only split-annotated stage8 exported JSONL used for test-split sampling & zero-leakage audit",
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=_REPO_ROOT / "runs" / "realexecbench-v1",
        help="Output directory for frozen benchmark.jsonl and manifest.json",
    )
    parser.add_argument("--cruxeval-count", type=int, default=60)
    parser.add_argument("--lcb-count", type=int, default=60)
    parser.add_argument("--hairy-count", type=int, default=40)
    parser.add_argument("--effectful-count", type=int, default=36)
    parser.add_argument("--whole-codebase-count", type=int, default=40)
    parser.add_argument("--frontend-count", type=int, default=20)
    parser.add_argument("--seed", type=int, default=17)
    parser.add_argument("--cache-dir", type=Path, default=DEFAULT_CACHE_DIR)
    parser.add_argument("--refresh-external", action="store_true")
    args = parser.parse_args(argv)

    _rows, manifest = build_realexecbench_v1(
        reference_dataset=args.reference_dataset,
        output_dir=args.output_dir,
        repo=_REPO_ROOT,
        cruxeval_count=args.cruxeval_count,
        lcb_count=args.lcb_count,
        hairy_count=args.hairy_count,
        effectful_count=args.effectful_count,
        whole_codebase_count=args.whole_codebase_count,
        frontend_count=args.frontend_count,
        seed=args.seed,
        cache_dir=args.cache_dir,
        refresh_external=args.refresh_external,
    )
    print(json.dumps({
        "version": manifest["version"],
        "benchmark_path": manifest["benchmark_path"],
        "benchmark_sha256": manifest["benchmark_sha256"],
        "total_tasks": manifest["total_tasks"],
        "tracks": {k: {fk: fv for fk, fv in v.items() if fk != "pair_ids"} for k, v in manifest["tracks"].items()},
        "zero_leakage_audit": {
            "passed": manifest["zero_leakage_audit"]["passed"],
            "overlap_counts": manifest["zero_leakage_audit"]["overlap_counts"],
            "forbidden_reference_counts": manifest["zero_leakage_audit"]["forbidden_reference_counts"],
        },
    }, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
