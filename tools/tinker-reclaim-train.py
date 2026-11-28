#!/usr/bin/env python3
"""Zero-leakage validation/test reclamation & Stage 10 dataset merger CLI.

Merges one or more JSONL datasets, deduplicates by `task_id` (and optionally
identical task content / sourceHash+entry+args), strictly excludes ANY row
overlapping RealExecBench v1 on id/family/ancestors/sourceHash/split_component/
normalized-source-code SHA256, preserves an optional internal validation
manifest (`--keep-val-manifest`) with strict component-level train/val
isolation, and reclaims all remaining non-RealExecBench validation/test rows
into `train` while preserving pre-exported fields (`messages`, `sourceHash`,
`task`) intact for `_is_preexported_row` pass-through.
"""

from __future__ import annotations

import argparse
import ast
from collections import Counter
import copy
import hashlib
import json
from pathlib import Path
import re
import sys
from typing import Any, Sequence
import warnings

_REPO_ROOT = Path(__file__).resolve().parents[1]
_TRAINING_DIR = str(_REPO_ROOT / "training")
if _TRAINING_DIR not in sys.path:
    sys.path.insert(0, _TRAINING_DIR)

from tinker_js.metrics import task_eval_bucket  # noqa: E402
from tinker_js.runner import atomic_json, read_jsonl, write_jsonl  # noqa: E402

DEFAULT_REALEXECBENCH_MANIFEST = Path("/home/werg/tracing-js-self/runs/realexecbench-v1/manifest.json")
DEFAULT_REALEXECBENCH_BENCHMARK = Path("/home/werg/tracing-js-self/runs/realexecbench-v1/benchmark.jsonl")


def _sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


_JS_TOKEN_RE = re.compile(
    r'"(?:\\.|[^"\\])*"|\'(?:\\.|[^\'\\])*\'|`(?:\\.|[^`\\])*`|//[^\n]*|/\*[\s\S]*?\*/'
)


def _strip_js_comments(source: str) -> str:
    """Fast regex JS/TS comment stripper preserving string/template literals."""
    if "//" not in source and "/*" not in source:
        return source
    return _JS_TOKEN_RE.sub(lambda m: "" if m.group(0).startswith("/") else m.group(0), source)


def _normalize_ws(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def _py_ast_dump_quiet(source: str) -> str | None:
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", SyntaxWarning)
            tree = ast.parse(source)
        return ast.dump(tree, include_attributes=False)
    except SyntaxError:
        return None


def _row_task(row: dict[str, Any]) -> dict[str, Any]:
    task = row.get("task")
    return task if isinstance(task, dict) else row


def _row_id(row: dict[str, Any]) -> str:
    task = _row_task(row)
    return str(row.get("id") or task.get("id") or "")


def _row_split(row: dict[str, Any]) -> str | None:
    split = row.get("split")
    if split is None and isinstance(row.get("task"), dict):
        split = row["task"].get("split")
    return str(split) if split is not None else None


def _row_language(row: dict[str, Any]) -> str:
    task = _row_task(row)
    meta = row.get("metadata") if isinstance(row.get("metadata"), dict) else {}
    task_meta = task.get("metadata") if isinstance(task.get("metadata"), dict) else {}
    lang = row.get("language") or task.get("language") or meta.get("language") or task_meta.get("language")
    return str(lang) if isinstance(lang, str) and lang else "js"


def normalized_source_hashes(row: dict[str, Any]) -> set[str]:
    """Compute normalized source-code SHA256 fingerprints for single-file or multi-file tasks."""
    task = _row_task(row)
    hashes: set[str] = set()
    files = task.get("files")
    if isinstance(files, dict) and files:
        norm_entries: list[list[str]] = []
        for rel_path in sorted(files):
            content = files[rel_path]
            if not isinstance(content, str):
                continue
            if rel_path.endswith(".py"):
                dumped = _py_ast_dump_quiet(content)
                norm_content = dumped if dumped is not None else _normalize_ws(content)
            else:
                norm_content = _normalize_ws(_strip_js_comments(content))
            norm_entries.append([rel_path, norm_content])
        payload = json.dumps(
            {"entryFile": task.get("entryFile"), "files": norm_entries},
            ensure_ascii=False,
            separators=(",", ":"),
        )
        hashes.add("mf:" + _sha256_text(payload))
        return hashes

    source = task.get("source")
    if not isinstance(source, str) or not source.strip():
        return hashes

    lang = _row_language(row)
    ws_norm = _normalize_ws(source)
    if ws_norm:
        hashes.add("ws:" + _sha256_text(ws_norm))
    if lang == "py":
        dumped = _py_ast_dump_quiet(source)
        if dumped is not None:
            hashes.add("pyast:" + _sha256_text(dumped))
    else:
        stripped = _normalize_ws(_strip_js_comments(source))
        if stripped:
            hashes.add("js:" + _sha256_text(stripped))
    return hashes


def row_identities(row: dict[str, Any]) -> dict[str, set[str]]:
    """Extract all leakage / component identities for a row."""
    task = _row_task(row)
    meta = row.get("metadata") if isinstance(row.get("metadata"), dict) else {}
    task_meta = task.get("metadata") if isinstance(task.get("metadata"), dict) else {}

    ids: set[str] = set()
    for val in (row.get("id"), task.get("id")):
        if isinstance(val, str) and val:
            ids.add(val)

    families: set[str] = set()
    for val in (row.get("family"), task.get("family")):
        if isinstance(val, str) and val:
            families.add(val)
    for anc_list in (
        row.get("ancestors"),
        task.get("ancestors"),
        meta.get("lineage"),
        task_meta.get("lineage"),
    ):
        if isinstance(anc_list, list):
            for name in anc_list:
                if isinstance(name, str) and name.strip():
                    families.add(name)

    source_hashes: set[str] = set()
    for val in (row.get("sourceHash"), row.get("source_hash"), task.get("sourceHash"), task.get("source_hash")):
        if isinstance(val, str) and val:
            source_hashes.add(val)
    for extra_list in (row.get("sourceHashes"), task.get("sourceHashes")):
        if isinstance(extra_list, list):
            for sh in extra_list:
                if isinstance(sh, str) and sh:
                    source_hashes.add(sh)

    split_components: set[str] = set()
    for val in (row.get("split_component"), task.get("split_component")):
        if isinstance(val, str) and val:
            split_components.add(val)

    templates: set[str] = set()
    for val in (meta.get("template"), task_meta.get("template")):
        if isinstance(val, str) and val.strip():
            templates.add(val)

    return {
        "ids": ids,
        "families": families,
        "source_hashes": source_hashes,
        "split_components": split_components,
        "templates": templates,
        "norm_source_hashes": normalized_source_hashes(row),
    }


def collect_identity_index(
    rows: Sequence[dict[str, Any]],
    *,
    manifest: dict[str, Any] | None = None,
) -> dict[str, set[str]]:
    """Build complete identity sets across rows plus optional RealExecBench manifest."""
    index: dict[str, set[str]] = {
        "ids": set(),
        "families": set(),
        "source_hashes": set(),
        "split_components": set(),
        "templates": set(),
        "norm_source_hashes": set(),
    }
    for row in rows:
        ident = row_identities(row)
        for key in index:
            index[key].update(ident[key])
    if isinstance(manifest, dict):
        by_track = manifest.get("task_ids_by_track")
        if isinstance(by_track, dict):
            for task_ids in by_track.values():
                if isinstance(task_ids, list):
                    for tid in task_ids:
                        if isinstance(tid, str) and tid:
                            index["ids"].add(tid)
    return index


def find_overlap_reasons(
    ident: dict[str, set[str]],
    forbidden: dict[str, set[str]],
    *,
    include_templates: bool = False,
) -> list[str]:
    reasons: list[str] = []
    if ident["ids"] & forbidden["ids"]:
        reasons.append("task_id")
    if ident["families"] & forbidden["families"]:
        reasons.append("family")
    if ident["source_hashes"] & forbidden["source_hashes"]:
        reasons.append("source_hash")
    if ident["split_components"] & forbidden["split_components"]:
        reasons.append("split_component")
    if ident["norm_source_hashes"] & forbidden["norm_source_hashes"]:
        reasons.append("normalized_source_sha256")
    if include_templates and (ident["templates"] & forbidden["templates"]):
        reasons.append("template")
    return reasons


def _load_keep_val_ids(manifest_path: Path | None) -> set[str]:
    if manifest_path is None:
        return set()
    data = json.loads(manifest_path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError("keep-val-manifest must be a JSON object")
    splits = data.get("splits", data)
    if not isinstance(splits, dict) or "validation" not in splits:
        raise ValueError("keep-val-manifest must contain a 'validation' ID list")
    ids = splits["validation"]
    if not isinstance(ids, list) or any(not isinstance(item, str) or not item for item in ids):
        raise ValueError("keep-val-manifest validation IDs must be nonempty strings")
    return set(ids)


def _canonical_task_dedupe_key(row: dict[str, Any], *, include_fixture: bool) -> str:
    task = _row_task(row)
    sh = row.get("sourceHash") or row.get("source_hash") or ""
    payload: dict[str, Any] = {
        "sourceHash": sh,
        "entry": task.get("entry"),
        "args": task.get("args", []),
    }
    if include_fixture:
        payload["fixture"] = task.get("fixture", {})
    return _sha256_text(json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")))


def _set_row_split(row: dict[str, Any], split: str) -> dict[str, Any]:
    out = dict(row)
    out["split"] = split
    if isinstance(out.get("task"), dict) and "split" in out["task"]:
        out["task"] = {**out["task"], "split": split}
    return out


def _is_preexported_row(item: dict[str, Any]) -> bool:
    return (
        isinstance(item.get("messages"), list)
        and bool(item["messages"])
        and isinstance(item.get("sourceHash"), str)
        and bool(item["sourceHash"])
        and isinstance(item.get("task"), dict)
    )


def _component_keys(ident: dict[str, set[str]]) -> list[tuple[str, str]]:
    """Keys that connect rows into the same family/source/lineage component."""
    keys: list[tuple[str, str]] = []
    for fam in ident["families"]:
        keys.append(("family", fam))
    for sh in ident["source_hashes"]:
        keys.append(("source_hash", sh))
    for sc in ident["split_components"]:
        keys.append(("split_component", sc))
    for tmpl in ident["templates"]:
        keys.append(("template", tmpl))
    for nsh in ident["norm_source_hashes"]:
        keys.append(("norm_source_hash", nsh))
    return keys


def _verify_zero_overlap(
    rows: Sequence[dict[str, Any]],
    forbidden: dict[str, set[str]],
    *,
    include_templates: bool = False,
) -> dict[str, Any]:
    overlaps: dict[str, list[str]] = {
        "task_id": [],
        "family": [],
        "source_hash": [],
        "split_component": [],
        "normalized_source_sha256": [],
    }
    if include_templates:
        overlaps["template"] = []
    for row in rows:
        tid = _row_id(row)
        for reason in find_overlap_reasons(row_identities(row), forbidden, include_templates=include_templates):
            overlaps[reason].append(tid)
    counts = {k: len(v) for k, v in overlaps.items()}
    return {
        "passed": sum(counts.values()) == 0,
        "checked_rows": len(rows),
        "overlap_counts": counts,
        "sample_overlaps": {k: v[:10] for k, v in overlaps.items() if v},
    }


def reclaim_and_merge(
    input_rows: Sequence[dict[str, Any]],
    *,
    realexecbench_rows: Sequence[dict[str, Any]],
    realexecbench_manifest: dict[str, Any] | None = None,
    keep_val_ids: set[str] | None = None,
    dedupe_by_task_hash: bool = False,
    dedupe_by_source_entry_args: bool = False,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Deduplicate, enforce strict RealExecBench + kept-val zero-leakage, and reclaim val/test -> train."""
    reb_forbidden = collect_identity_index(realexecbench_rows, manifest=realexecbench_manifest)
    keep_val_set = set(keep_val_ids or set())

    # Step 1: Deduplicate inputs in order (first occurrence wins).
    deduped: list[dict[str, Any]] = []
    seen_ids: set[str] = set()
    seen_task_hashes: set[str] = set()
    seen_sea_keys: set[str] = set()
    dup_id_count = 0
    dup_task_hash_count = 0
    dup_sea_count = 0
    orig_split_counts: Counter = Counter()

    for row in input_rows:
        tid = _row_id(row)
        if not tid:
            raise ValueError("input row is missing nonempty task id")
        orig_split_counts[_row_split(row) or "unassigned"] += 1
        if tid in seen_ids:
            dup_id_count += 1
            continue
        if dedupe_by_task_hash:
            tk = _canonical_task_dedupe_key(row, include_fixture=True)
            if tk in seen_task_hashes:
                dup_task_hash_count += 1
                continue
            seen_task_hashes.add(tk)
        if dedupe_by_source_entry_args:
            sea = _canonical_task_dedupe_key(row, include_fixture=False)
            if sea in seen_sea_keys:
                dup_sea_count += 1
                continue
            seen_sea_keys.add(sea)
        seen_ids.add(tid)
        deduped.append(row)

    # Step 2: Strictly exclude ANY row overlapping RealExecBench v1 (and transitive siblings in same component).
    idents = [row_identities(row) for row in deduped]
    parents = list(range(len(deduped)))

    def find(i: int) -> int:
        while parents[i] != i:
            parents[i] = parents[parents[i]]
            i = parents[i]
        return i

    key_owner: dict[tuple[str, str], int] = {}
    for idx, ident in enumerate(idents):
        for key in _component_keys(ident):
            prev = key_owner.get(key)
            if prev is not None:
                parents[find(idx)] = find(prev)
            else:
                key_owner[key] = idx

    direct_reb_reasons: dict[int, list[str]] = {}
    reb_component_roots: set[int] = set()
    for idx, ident in enumerate(idents):
        reasons = find_overlap_reasons(ident, reb_forbidden, include_templates=False)
        if reasons:
            direct_reb_reasons[idx] = reasons
            reb_component_roots.add(find(idx))

    reb_excluded_by_reason: Counter = Counter()
    reb_excluded_total = 0
    reb_excluded_transitive = 0
    non_reb_indices: list[int] = []
    for idx in range(len(deduped)):
        if idx in direct_reb_reasons:
            reb_excluded_total += 1
            for r in direct_reb_reasons[idx]:
                reb_excluded_by_reason[r] += 1
        elif find(idx) in reb_component_roots:
            reb_excluded_total += 1
            reb_excluded_transitive += 1
            reb_excluded_by_reason["transitive_component"] += 1
        else:
            non_reb_indices.append(idx)

    # Step 3: Identify kept internal validation rows and their entire connected components.
    kept_val_indices = [idx for idx in non_reb_indices if _row_id(deduped[idx]) in keep_val_set]
    kept_val_roots = {find(idx) for idx in kept_val_indices}
    kept_val_index_set = set(kept_val_indices)

    output_train: list[dict[str, Any]] = []
    output_val: list[dict[str, Any]] = []

    kept_original_train = 0
    reclaimed_from_val_strict = 0
    reclaimed_from_test_strict = 0
    reclaimed_from_unassigned_strict = 0
    excluded_kept_val_siblings_non_train = 0
    excluded_kept_val_siblings_orig_train = 0
    reclaimed_from_val_if_only_reb = 0
    reclaimed_from_test_if_only_reb = 0
    reclaimed_from_unassigned_if_only_reb = 0

    for idx in non_reb_indices:
        row = deduped[idx]
        orig_split = _row_split(row)
        if idx in kept_val_index_set:
            output_val.append(_set_row_split(row, "validation"))
            continue

        # Track what reclamation count would be if only RealExecBench were excluded
        if orig_split == "validation":
            reclaimed_from_val_if_only_reb += 1
        elif orig_split == "test":
            reclaimed_from_test_if_only_reb += 1
        elif orig_split != "train":
            reclaimed_from_unassigned_if_only_reb += 1

        # Strictly isolate kept internal validation components from train
        if find(idx) in kept_val_roots:
            if orig_split == "train":
                excluded_kept_val_siblings_orig_train += 1
            else:
                excluded_kept_val_siblings_non_train += 1
            continue

        output_train.append(_set_row_split(row, "train"))
        if orig_split == "train":
            kept_original_train += 1
        elif orig_split == "validation":
            reclaimed_from_val_strict += 1
        elif orig_split == "test":
            reclaimed_from_test_strict += 1
        else:
            reclaimed_from_unassigned_strict += 1

    output_rows = output_train + output_val

    # Step 4: Final post-merge zero-leakage verification assertions!
    train_vs_reb = _verify_zero_overlap(output_train, reb_forbidden, include_templates=False)
    val_vs_reb = _verify_zero_overlap(output_val, reb_forbidden, include_templates=False)
    val_index = collect_identity_index(output_val)
    train_vs_val = _verify_zero_overlap(output_train, val_index, include_templates=True)

    if not train_vs_reb["passed"]:
        raise RuntimeError(f"Post-merge train vs RealExecBench leakage detected: {train_vs_reb}")
    if not val_vs_reb["passed"]:
        raise RuntimeError(f"Post-merge validation vs RealExecBench leakage detected: {val_vs_reb}")
    if not train_vs_val["passed"]:
        raise RuntimeError(f"Post-merge train vs validation leakage detected: {train_vs_val}")

    preexported_count = sum(1 for r in output_rows if _is_preexported_row(r))
    missing_keep_val_ids = sorted(keep_val_set - {_row_id(r) for r in output_val})

    reclaimed_strict_total = reclaimed_from_val_strict + reclaimed_from_test_strict + reclaimed_from_unassigned_strict
    reclaimed_if_only_reb_total = (
        reclaimed_from_val_if_only_reb + reclaimed_from_test_if_only_reb + reclaimed_from_unassigned_if_only_reb
    )

    audit = {
        "schema": "tinker-reclaim-train-audit/1",
        "passed": True,
        "inputs": {
            "total_input_rows": len(input_rows),
            "original_split_counts": dict(sorted(orig_split_counts.items())),
            "deduped_rows": len(deduped),
            "dropped_duplicate_task_id": dup_id_count,
            "dropped_duplicate_task_hash": dup_task_hash_count,
            "dropped_duplicate_source_entry_args": dup_sea_count,
        },
        "realexecbench_reference": {
            "benchmark_rows": len(realexecbench_rows),
            "forbidden_counts": {k: len(v) for k, v in reb_forbidden.items()},
        },
        "realexecbench_exclusions": {
            "total_excluded": reb_excluded_total,
            "transitive_component_excluded": reb_excluded_transitive,
            "by_reason": dict(sorted(reb_excluded_by_reason.items())),
        },
        "reclamation": {
            "isolation_policy": "strict_realexecbench_and_kept_val_components",
            "kept_original_train": kept_original_train,
            "reclaimed_strict_val_and_reb_isolated": reclaimed_strict_total,
            "reclaimed_strict_breakdown": {
                "from_validation": reclaimed_from_val_strict,
                "from_test": reclaimed_from_test_strict,
                "from_unassigned": reclaimed_from_unassigned_strict,
            },
            "reclaimed_if_only_reb_isolated": reclaimed_if_only_reb_total,
            "reclaimed_if_only_reb_breakdown": {
                "from_validation": reclaimed_from_val_if_only_reb,
                "from_test": reclaimed_from_test_if_only_reb,
                "from_unassigned": reclaimed_from_unassigned_if_only_reb,
            },
            "excluded_kept_val_component_siblings": excluded_kept_val_siblings_non_train + excluded_kept_val_siblings_orig_train,
            "excluded_kept_val_component_siblings_non_train": excluded_kept_val_siblings_non_train,
            "excluded_kept_val_component_siblings_orig_train": excluded_kept_val_siblings_orig_train,
        },
        "kept_validation_manifest": {
            "requested_ids": len(keep_val_set),
            "retained_in_validation": len(output_val),
            "missing_or_reb_excluded_ids_count": len(missing_keep_val_ids),
            "missing_or_reb_excluded_ids_sample": missing_keep_val_ids[:20],
        },
        "output": {
            "total_rows": len(output_rows),
            "train_rows": len(output_train),
            "validation_rows": len(output_val),
            "preexported_rows": preexported_count,
            "all_preexported": preexported_count == len(output_rows),
            "train_by_bucket": dict(sorted(Counter(task_eval_bucket(r) for r in output_train).items())),
            "validation_by_bucket": dict(sorted(Counter(task_eval_bucket(r) for r in output_val).items())),
        },
        "zero_leakage_verification": {
            "train_vs_realexecbench": train_vs_reb,
            "validation_vs_realexecbench": val_vs_reb,
            "train_vs_validation": train_vs_val,
        },
    }
    return output_rows, audit


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--inputs", nargs="+", type=Path, required=True, help="Input JSONL dataset files to merge")
    parser.add_argument("--realexecbench-manifest", type=Path, default=DEFAULT_REALEXECBENCH_MANIFEST,
                        help=f"RealExecBench v1 manifest.json (default: {DEFAULT_REALEXECBENCH_MANIFEST})")
    parser.add_argument("--realexecbench-benchmark", type=Path, default=DEFAULT_REALEXECBENCH_BENCHMARK,
                        help=f"RealExecBench v1 benchmark.jsonl (default: {DEFAULT_REALEXECBENCH_BENCHMARK})")
    parser.add_argument("--keep-val-manifest", type=Path, default=None,
                        help="Optional eval manifest JSON whose validation IDs stay in validation")
    parser.add_argument("--output", type=Path, required=True, help="Output merged JSONL dataset path")
    parser.add_argument("--audit-out", type=Path, default=None, help="Optional JSON audit report path")
    parser.add_argument("--dedupe-by-task-hash", action="store_true",
                        help="Also deduplicate rows with identical (sourceHash, entry, args, fixture)")
    parser.add_argument("--dedupe-by-source-entry-args", action="store_true",
                        help="Also deduplicate rows with identical (sourceHash, entry, args)")
    args = parser.parse_args(argv)

    all_input_rows: list[dict[str, Any]] = []
    input_file_counts: dict[str, int] = {}
    for inp in args.inputs:
        loaded = read_jsonl(inp)
        input_file_counts[str(inp)] = len(loaded)
        all_input_rows.extend(loaded)

    reb_manifest: dict[str, Any] | None = None
    if args.realexecbench_manifest is not None and args.realexecbench_manifest.is_file():
        reb_manifest = json.loads(args.realexecbench_manifest.read_text(encoding="utf-8"))

    reb_bench_path = args.realexecbench_benchmark
    if (reb_bench_path is None or not reb_bench_path.is_file()) and reb_manifest is not None:
        sibling = args.realexecbench_manifest.parent / "benchmark.jsonl"
        if sibling.is_file():
            reb_bench_path = sibling
        elif isinstance(reb_manifest.get("benchmark_path"), str) and Path(reb_manifest["benchmark_path"]).is_file():
            reb_bench_path = Path(reb_manifest["benchmark_path"])
    if reb_bench_path is None or not reb_bench_path.is_file():
        raise FileNotFoundError(
            f"RealExecBench benchmark JSONL not found: {reb_bench_path}; cannot guarantee zero leakage"
        )
    reb_rows = read_jsonl(reb_bench_path)

    keep_val_ids = _load_keep_val_ids(args.keep_val_manifest)
    output_rows, audit = reclaim_and_merge(
        all_input_rows,
        realexecbench_rows=reb_rows,
        realexecbench_manifest=reb_manifest,
        keep_val_ids=keep_val_ids,
        dedupe_by_task_hash=args.dedupe_by_task_hash,
        dedupe_by_source_entry_args=args.dedupe_by_source_entry_args,
    )
    audit["inputs"]["files"] = input_file_counts
    audit["output"]["path"] = str(args.output)
    write_jsonl(args.output, output_rows)
    if args.audit_out is not None:
        atomic_json(args.audit_out, audit)
        audit["audit_out"] = str(args.audit_out)
    print(json.dumps(audit, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
