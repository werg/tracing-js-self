#!/usr/bin/env python3
"""Fetch, cache, convert, and CPython-verify CRUXEval-O and LiveCodeBench-Exec tasks."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys

_REPO_ROOT = Path(__file__).resolve().parents[1]
_TRAINING_DIR = str(_REPO_ROOT / "training")
if _TRAINING_DIR not in sys.path:
    sys.path.insert(0, _TRAINING_DIR)

from tinker_js.external_benchmarks import DEFAULT_CACHE_DIR, import_external_benchmarks  # noqa: E402
from tinker_js.runner import atomic_json, write_jsonl  # noqa: E402


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cruxeval-count", type=int, default=60, help="Verified CRUXEval-O tasks to import (default: 60)")
    parser.add_argument("--lcb-count", type=int, default=60, help="Verified LiveCodeBench-Exec tasks to import (default: 60)")
    parser.add_argument("--seed", type=int, default=17, help="Deterministic sampling seed (default: 17)")
    parser.add_argument("--cache-dir", type=Path, default=DEFAULT_CACHE_DIR, help="Local download cache directory")
    parser.add_argument("--refresh", action="store_true", help="Re-download raw datasets instead of reading cache")
    parser.add_argument("--output", type=Path, required=True, help="Output verified JSONL path")
    parser.add_argument("--report", type=Path, default=None, help="Optional JSON report path")
    parser.add_argument("--trace-format", choices=("full", "compact", "actions-only"), default="compact")
    args = parser.parse_args(argv)

    tasks, report = import_external_benchmarks(
        cruxeval_count=args.cruxeval_count,
        lcb_count=args.lcb_count,
        seed=args.seed,
        cache_dir=args.cache_dir,
        refresh=args.refresh,
        trace_format=args.trace_format,
    )
    write_jsonl(args.output, tasks)
    if args.report is not None:
        atomic_json(args.report, report)
    print(json.dumps({"output": str(args.output), **report}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
