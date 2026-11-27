#!/usr/bin/env python3
"""Multi-model evaluation and paired leaderboard CLI for RealExecBench v1."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys

_REPO_ROOT = Path(__file__).resolve().parents[1]
_TRAINING_DIR = str(_REPO_ROOT / "training")
if _TRAINING_DIR not in sys.path:
    sys.path.insert(0, _TRAINING_DIR)

from tinker_js.realexecbench import (  # noqa: E402
    REALEXECBENCH_TRACKS,
    compare_realexecbench_runs,
    evaluate_realexecbench,
)
from tinker_js.runner import atomic_json  # noqa: E402


def _parse_tracks(raw: str) -> list[str] | None:
    text = raw.strip()
    if not text or text.lower() == "all":
        return None
    parts = [p.strip() for p in text.split(",") if p.strip()]
    unknown = [p for p in parts if p not in REALEXECBENCH_TRACKS]
    if unknown:
        raise ValueError(f"Unknown tracks {unknown}; valid tracks: {list(REALEXECBENCH_TRACKS)}")
    return parts


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    run_p = sub.add_parser("run", help="Evaluate one model/checkpoint on RealExecBench v1")
    run_p.add_argument("--model", required=True, help="Tinker model ID (e.g. thinkingmachines/Inkling-2-Mini:peft:65536:free)")
    run_p.add_argument("--checkpoint", default=None, help="Optional Tinker sampler checkpoint URI (tinker://...)")
    run_p.add_argument(
        "--benchmark",
        type=Path,
        default=_REPO_ROOT / "runs" / "realexecbench-v1" / "benchmark.jsonl",
        help="Path to frozen RealExecBench benchmark.jsonl",
    )
    run_p.add_argument("--tracks", default="all", help="Comma-separated track names or 'all'")
    run_p.add_argument("--prompt-mode", choices=("execution", "zero-shot"), default="execution")
    run_p.add_argument("--output-dir", type=Path, required=True, help="Directory for results.jsonl, summary.json, scoreboard.md")
    run_p.add_argument("--label", default=None, help="Optional display label for scoreboard & compare tables")
    run_p.add_argument("--concurrency", type=int, default=16)
    run_p.add_argument("--max-tokens", type=int, default=20480)
    run_p.add_argument("--max-generated-tokens", type=int, default=49152)
    run_p.add_argument("--max-turns", type=int, default=48)
    run_p.add_argument("--max-context-tokens", type=int, default=65536)
    run_p.add_argument("--effort", type=float, default=0.5)
    run_p.add_argument("--temperature", type=float, default=1.0)
    run_p.add_argument("--seed", type=int, default=17)
    run_p.add_argument("--bridge-timeout-seconds", type=float, default=120.0)
    run_p.add_argument("--limit", type=int, default=None, help="Optional task cap for quick smoke tests")
    run_p.add_argument("--resume", action="store_true", help="Resume an interrupted evaluation run incrementally")

    cmp_p = sub.add_parser("compare", help="Compare multiple evaluated RealExecBench run directories")
    cmp_p.add_argument("dirs", nargs="+", type=Path, help="Run directories containing results.jsonl / summary.json")
    cmp_p.add_argument("--baseline-index", type=int, default=0, help="0-based index of baseline run (default: 0)")
    cmp_p.add_argument("--bootstrap-samples", type=int, default=1000)
    cmp_p.add_argument("--seed", type=int, default=17)
    cmp_p.add_argument("--output", type=Path, default=None, help="Optional Markdown leaderboard output path")
    cmp_p.add_argument("--json-output", type=Path, default=None, help="Optional JSON comparison output path")
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    if args.command == "run":
        tracks = _parse_tracks(args.tracks)
        summary = evaluate_realexecbench(
            benchmark_path=args.benchmark,
            output_dir=args.output_dir,
            model=args.model,
            checkpoint=args.checkpoint,
            tracks=tracks,
            prompt_mode=args.prompt_mode,
            concurrency=args.concurrency,
            max_tokens=args.max_tokens,
            max_generated_tokens=args.max_generated_tokens,
            max_turns=args.max_turns,
            max_context_tokens=args.max_context_tokens,
            effort=args.effort,
            temperature=args.temperature,
            seed=args.seed,
            bridge_timeout_seconds=args.bridge_timeout_seconds,
            resume=args.resume,
            limit=args.limit,
            label=args.label,
        )
        print(json.dumps({
            "output_dir": str(args.output_dir),
            "overall": summary["overall"],
            "tracks": {k: {"task_accuracy": v["task_accuracy"], "causal_pair_accuracy": v["causal_pair_accuracy"]}
                       for k, v in summary["by_track"].items()},
        }, indent=2))
        return 0

    if args.command == "compare":
        report, markdown = compare_realexecbench_runs(
            args.dirs,
            baseline_index=args.baseline_index,
            bootstrap_samples=args.bootstrap_samples,
            seed=args.seed,
        )
        if args.output is not None:
            args.output.parent.mkdir(parents=True, exist_ok=True)
            args.output.write_text(markdown, encoding="utf-8")
        if args.json_output is not None:
            atomic_json(args.json_output, report)
        print(markdown)
        return 0

    raise ValueError(f"Unsupported command {args.command!r}")


if __name__ == "__main__":
    raise SystemExit(main())
