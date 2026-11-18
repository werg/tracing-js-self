#!/usr/bin/env python3
"""Package a frozen selection of verification evidence as an audit-only bundle.

Uses the existing release packager's inventory, atomic archive writer, and
complete member verification. This does not produce a prepared training set.
"""
from __future__ import annotations

import argparse
import importlib.util
import json
from collections import defaultdict
from pathlib import Path


def require(condition, message):
    if not condition:
        raise ValueError(message)


def allowed_path(workspace, value):
    path = Path(value)
    require(isinstance(value, str) and value and not path.is_absolute() and ".." not in path.parts,
            "Audit inputs must be relative workspace descendants")
    denied = {"node_modules", "site-packages", ".git", "__pycache__", ".venv"}
    require(not any(part in denied or part.lower().startswith(("library-transfer", "library-upload"))
                    for part in path.parts), "Dependencies or private transfer artifacts cannot enter an audit bundle")
    require(not value.endswith((".tar", ".tar.gz", ".tgz", ".zip")), "Completed archives must not be nested")
    candidate = workspace / path
    require(candidate.is_file() and not candidate.is_symlink() and candidate.resolve().is_relative_to(workspace),
            "Audit input is missing or escapes the workspace")
    return candidate


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workspace", type=Path, required=True)
    parser.add_argument("--selection", type=Path, required=True)
    parser.add_argument("--notes", type=Path, required=True)
    parser.add_argument("--packager", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--max-archive-bytes", type=int, default=512 << 20)
    args = parser.parse_args()
    workspace = args.workspace.resolve()
    selection = json.loads(args.selection.read_text())
    require(selection.get("schema") == "semantic-audit-supplement-selection/1", "Unsupported audit selection")
    qualifications = selection.get("qualifications", [])
    require(qualifications and all(row.get("status") == "complete" for row in qualifications),
            "Wait for explicit completion of every declared qualification before finalizing the supplement")
    require(selection.get("currentQualification") in {row["name"] for row in qualifications},
            "The current qualification must have an explicit completion receipt")
    require(args.max_archive_bytes > 0, "Archive size budget must be positive")
    output = args.out.resolve()
    require(not output.exists(), "Use a new audit archive output directory")

    spec = importlib.util.spec_from_file_location("audit_release_helpers", args.packager.resolve())
    helpers = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(helpers)
    def file_sha256(path):
        # Newer helpers include regular-file and concurrent-change checks in
        # file_receipt; frozen releases used the equivalent tuple interface.
        if hasattr(helpers, "file_receipt"):
            return helpers.file_receipt(path)["sha256"]
        return helpers.file_fingerprint(path)[1]

    require(file_sha256(args.packager) == selection["packagerSha256"],
            "Pinned archive implementation changed")
    expected, groups, roots = {}, {}, {}
    for row in selection["files"]:
        name = row["path"]
        require(name not in expected, "Duplicate selected audit path")
        roots[name] = allowed_path(workspace, name)
        expected[name] = {key: row[key] for key in ("path", "bytes", "sha256")}
        groups[name] = row["group"]
    actual, sources = helpers.inventory(roots)
    require({row["path"]: row for row in actual} == expected,
            "Selected evidence changed after its source inventory was frozen")
    for qualification in qualifications:
        require(qualification["completionReceipt"] in expected,
                "Every qualification completion receipt must be included in the source inventory")
    extras, extra_sources = helpers.inventory({
        "audit/selection.json": args.selection.resolve(),
        "audit/README.md": args.notes.resolve(),
        "audit/package-audit-supplement.py": Path(__file__).resolve(),
    })
    require(not (set(sources) & set(extra_sources)), "Audit metadata path collision")
    sources.update(extra_sources)
    files = sorted(actual + extras, key=lambda row: row["path"])
    summary = defaultdict(lambda: {"files": 0, "bytes": 0})
    for row in actual:
        category = summary[groups[row["path"]]]
        category["files"] += 1
        category["bytes"] += row["bytes"]
    payload = {
        "schema": "semantic-verification-audit-bundle/1",
        "scope": "Historical failures, recovery proofs, focused regressions and completed fresh qualification evidence. This bundle is not a prepared training dataset and does not grant training admission.",
        "isPreparedTrainingDataset": False,
        "selectionSha256": file_sha256(args.selection),
        "packagerSha256": selection["packagerSha256"],
        "qualifications": qualifications,
        "currentQualification": selection["currentQualification"],
        "groups": dict(sorted(summary.items())),
        "includedSourceFiles": len(actual), "includedSourceBytes": sum(row["bytes"] for row in actual),
        "alreadyDeliveredReferences": selection["alreadyDeliveredReferences"],
        "exclusions": selection["exclusions"],
        "files": files,
    }
    output.mkdir(parents=True)
    archive = output / "semantic-audit-supplement.tar.gz"
    helpers.write_archive(archive, payload, sources)
    verified = helpers.verify_archive(archive)
    require(archive.stat().st_size <= args.max_archive_bytes,
            "Verified audit archive exceeds the declared size budget; retain it and split the selection explicitly")
    receipt = {**verified, "schema": "semantic-audit-supplement-verification/1",
        "isPreparedTrainingDataset": False, "archiveBytes": archive.stat().st_size,
        "includedSourceFiles": len(actual), "includedSourceBytes": payload["includedSourceBytes"],
        "selectionSha256": payload["selectionSha256"], "groups": payload["groups"],
        "qualifications": qualifications, "currentQualification": selection["currentQualification"]}
    (output / "audit-receipt.json").write_text(json.dumps(receipt, indent=2, sort_keys=True) + "\n")
    print(json.dumps(receipt, sort_keys=True))


if __name__ == "__main__":
    main()
