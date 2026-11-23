#!/usr/bin/env python3
"""Verify retained second-review evidence without third-party dependencies."""
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


def sha(data):
    return hashlib.sha256(data).hexdigest()


def junit_summary(data, kind):
    root = ET.fromstring(data)
    counts = dict(total=0, passed=0, failed=0, skipped=0)
    by_file, failed, skipped, seen = {}, [], [], set()
    for case in root.iter("testcase"):
        if kind == "producer":
            source = "test/" + Path(case.get("file", "")).name
            require(source.endswith(".test.js"), "Missing producer test file")
        elif kind == "policy":
            parts = case.get("classname", "").split(".")
            require(len(parts) >= 3 and parts[:2] == ["tools", "native-consumer"],
                    "Missing policy test module")
            source = "tools/native-consumer/" + parts[2] + ".py"
        else:
            parts = case.get("classname", "").split(".")
            require(len(parts) >= 2 and parts[0] == "tests", "Missing native test module")
            source = "tests/" + parts[1] + ".py"
        key = (source, case.get("classname"), case.get("name"))
        require(key[2] and key not in seen, "Duplicate or unnamed testcase")
        seen.add(key)
        failure = case.find("failure")
        if failure is None:
            failure = case.find("error")
        is_skipped = case.find("skipped") is not None
        require(not (failure is not None and is_skipped), "Failed and skipped testcase")
        outcome = "failed" if failure is not None else "skipped" if is_skipped else "passed"
        row = by_file.setdefault(source, dict(total=0, passed=0, failed=0, skipped=0))
        for target in (row, counts):
            target["total"] += 1
            target[outcome] += 1
        if failure is not None:
            failed.append(dict(file=source, name=case.get("name"), message=failure.get("message", "")))
        if is_skipped:
            skipped.append(dict(file=source, name=case.get("name")))
    require(counts["total"] > 0, "No executed testcases")
    return dict(counts=counts, byTestFile=by_file, failedLeaves=failed, skippedLeaves=skipped)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-root", type=Path,
                        help="Workspace root containing the original issue61-evidence directory")
    args = parser.parse_args()
    base = Path(__file__).resolve().parent
    manifest_bytes = (base / "manifest.json").read_bytes()
    manifest = json.loads(manifest_bytes)
    require(manifest["schema"] == "issue61-second-review-retention/1", "Unknown manifest schema")
    decoded, originals = {}, 0
    for entry in manifest["files"]:
        name = entry["path"]
        require(Path(name).name == name and name not in decoded, "Invalid retained filename")
        retained = (base / name).read_bytes()
        require(len(retained) == entry["retainedBytes"] and sha(retained) == entry["retainedSha256"],
                "Retained bytes differ: " + name)
        require(entry["encoding"] == "gzip", "Unexpected receipt encoding")
        require(retained[:4] == b"\x1f\x8b\x08\x00" and retained[4:8] == b"\0" * 4,
                "Non-deterministic gzip header: " + name)
        data = gzip.decompress(retained)
        require(len(data) == entry["sourceBytes"] and sha(data) == entry["sourceSha256"],
                "Decoded bytes differ: " + name)
        if args.source_root:
            source = Path(entry["sourcePath"])
            require(not source.is_absolute() and ".." not in source.parts, "Invalid source path")
            require((args.source_root / source).read_bytes() == data, "Original bytes differ: " + name)
            originals += 1
        decoded[name] = data

    runs = {}
    for run in manifest["runs"]:
        actual = junit_summary(decoded[run["junit"]], run["kind"])
        require(actual == run["junitSummary"], "JUnit summary differs: " + run["id"])
        if run["kind"] == "producer":
            log = decoded[run["log"]].decode()
            for field, key in (("tests", "total"), ("pass", "passed"), ("fail", "failed"), ("skipped", "skipped")):
                values = re.findall(rf"^ℹ {field} (\d+)$", log, re.MULTILINE)
                require(values == [str(actual["counts"][key])], "Log count differs: " + run["id"])
        runs[run["id"]] = actual
    for row in manifest["finalReviewFiles"]:
        require(runs[row["run"]]["byTestFile"][row["testFile"]] == row["counts"],
                "Final review subset differs: " + row["testFile"])
    require(manifest["runAuthority"] == "working-tree-executions-not-clean-pair-attestations",
            "Historical run authority changed")
    require(all(value is False for value in manifest["admissionClaims"].values()), "Unexpected admission claim")
    print(json.dumps(dict(schema="issue61-second-review-verification/1", valid=True,
                         manifestSha256=sha(manifest_bytes), verifiedFiles=len(decoded),
                         originalFilesCompared=originals,
                         runs={key: value["counts"] for key, value in runs.items()},
                         finalReviewFiles=manifest["finalReviewFiles"],
                         runAuthority=manifest["runAuthority"],
                         admissionClaims=manifest["admissionClaims"]), indent=2))


if __name__ == "__main__":
    main()
