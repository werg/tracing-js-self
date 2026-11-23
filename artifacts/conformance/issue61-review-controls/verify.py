#!/usr/bin/env python3
"""Verify retained review receipts using only the Python standard library."""

import argparse
import gzip
import hashlib
import json
from pathlib import Path
import re
import xml.etree.ElementTree as ET


def require(condition, message):
    if not condition:
        raise ValueError(message)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def empty_counts():
    return dict(total=0, passed=0, failed=0, skipped=0)


def add_counts(target, counts):
    for key in target:
        target[key] += counts[key]


def junit_counts(data):
    root = ET.fromstring(data)
    counts, by_file, skips = empty_counts(), {}, []
    for case in root.iter("testcase"):
        filename = case.get("file", "")
        require("/test/" in filename, "JUnit leaf lacks its test file")
        filename = "test/" + filename.split("/test/", 1)[1]
        failed = case.find("failure") is not None or case.find("error") is not None
        skipped = case.find("skipped") is not None
        require(not (failed and skipped), "JUnit leaf is both failed and skipped")
        outcome = "failed" if failed else "skipped" if skipped else "passed"
        row = by_file.setdefault(filename, empty_counts())
        row["total"] += 1
        row[outcome] += 1
        if skipped:
            skips.append(dict(file=filename, name=case.get("name")))
    for row in by_file.values():
        add_counts(counts, row)
    return dict(counts=counts, byTestFile=by_file, skippedLeaves=skips,
                parentTestSuites=len(list(root.iter("testsuite"))))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-root", type=Path,
                        help="Optional workspace root containing original issue61-evidence files")
    args = parser.parse_args()
    base = Path(__file__).resolve().parent
    manifest_bytes = (base / "manifest.json").read_bytes()
    manifest = json.loads(manifest_bytes)
    require(manifest["schema"] == "issue61-review-retention-manifest/1", "Unknown manifest")
    decoded, originals = {}, 0
    for entry in manifest["files"]:
        name = entry["path"]
        require(Path(name).name == name and name not in decoded, "Invalid receipt path")
        retained = (base / name).read_bytes()
        require(len(retained) == entry["retainedBytes"], f"Retained byte mismatch: {name}")
        require(digest(retained) == entry["retainedSha256"], f"Retained hash mismatch: {name}")
        if entry["encoding"] == "gzip":
            require(retained[:4] == b"\x1f\x8b\x08\x00" and retained[4:8] == b"\x00" * 4,
                    f"Non-deterministic gzip header: {name}")
            data = gzip.decompress(retained)
            require(len(data) == entry["sourceBytes"], f"Decoded byte mismatch: {name}")
            require(digest(data) == entry["sourceSha256"], f"Decoded hash mismatch: {name}")
            if args.source_root:
                source = Path(entry["sourcePath"])
                require(not source.is_absolute() and ".." not in source.parts, "Invalid source path")
                require((args.source_root / source).read_bytes() == data,
                        f"Original source mismatch: {name}")
                originals += 1
        else:
            require(entry["encoding"] == "identity", f"Unknown encoding: {name}")
            data = retained
        decoded[name] = data

    runs, aggregate = {}, empty_counts()
    for run in manifest["runs"]:
        actual = junit_counts(decoded[run["junit"]])
        require(actual == run["junitSummary"], f"JUnit summary mismatch: {run['id']}")
        spec = decoded[run["spec"]].decode("utf-8")
        for field, key in (("tests", "total"), ("pass", "passed"),
                           ("fail", "failed"), ("skipped", "skipped")):
            values = re.findall(rf"^ℹ {field} (\d+)$", spec, re.MULTILINE)
            require(values == [str(actual["counts"][key])],
                    f"Spec/JUnit count mismatch: {run['id']} {field}")
        require(actual["parentTestSuites"] == 0, "Unexpected parent tests require separate accounting")
        runs[run["id"]] = actual
        add_counts(aggregate, actual["counts"])
    require(aggregate == manifest["aggregateLeafExecutions"], "Aggregate count mismatch")
    subset = manifest["sharedIntrinsicSubset"]
    require(runs[subset["run"]]["byTestFile"][subset["testFile"]] == subset["counts"],
            "Shared-intrinsic subset mismatch")
    public = empty_counts()
    for run_id in manifest["publicRunIds"]:
        add_counts(public, runs[run_id]["counts"])
    require(public == manifest["publicLeafExecutions"], "Public count mismatch")
    require(all(value is False for value in manifest["admissionClaims"].values()),
            "Unexpected admission claim")
    print(json.dumps(dict(
        schema="issue61-review-retention-verification/1", valid=True,
        manifestSha256=digest(manifest_bytes), verifiedFiles=list(decoded),
        originalFilesCompared=originals, junitRuns=runs,
        sharedIntrinsicSubset=subset, publicLeafExecutions=public,
        aggregateLeafExecutions=aggregate,
        admissionClaims=manifest["admissionClaims"],
    ), indent=2) + "\n", end="")


if __name__ == "__main__":
    main()
