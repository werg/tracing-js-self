#!/usr/bin/env python3
"""Recheck original recovery artifact bytes, source pins and JUnit populations."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import xml.etree.ElementTree as ET
import zipfile


def audit(directory: Path, expected_failures: int) -> dict:
    metadata = json.loads((directory / "metadata.json").read_text())
    producer = metadata["run"]["head_sha"]
    native = "15844c00c095849755ca6f0e1d207f7db79a9264"
    expected = {
        "structural": 123,
        "transport": 33,
        "commit-history": 9,
        "bootstrap-history": 12,
        "terminal-history": 16,
    }
    assert metadata["run"]["status"] == "completed", "the run is incomplete"
    assert metadata["run"]["conclusion"] == ("failure" if expected_failures else "success")
    jobs = metadata["jobs"]
    assert {job["name"] for job in jobs} == {f"paired-recovery ({lane}, {count})" for lane, count in expected.items()}
    assert all(job["status"] == "completed" for job in jobs), "a required lane is incomplete"
    if not expected_failures:
        assert all(job["conclusion"] == "success" for job in jobs), "a required lane did not pass"
    artifacts = {item["name"]: item for item in metadata["artifacts"]}
    assert set(artifacts) == {"composed-recovery-" + name for name in expected}
    result = {"run": metadata["run"]["id"], "producer": producer, "native": native, "groups": {}}
    producer_failures = 0
    for lane, count in expected.items():
        artifact = artifacts["composed-recovery-" + lane]
        path = directory / (artifact["name"] + ".zip")
        raw = path.read_bytes()
        assert len(raw) == artifact["size_in_bytes"], str(path) + ": size differs"
        assert "sha256:" + hashlib.sha256(raw).hexdigest() == artifact["digest"], str(path) + ": digest differs"
        with zipfile.ZipFile(path) as archive:
            assert archive.read("producer-revision.txt").decode().strip() == producer
            assert archive.read("native-revision.txt").decode().strip() == native
            runtime = archive.read("runtime.txt").decode()
            for required in ("v24.22.3", "Python 3.12.14", "torch==2.10.0+cpu", "pytest==8.4.2", "time:["):
                assert required in runtime, f"{lane}: runtime is missing {required}"
            documents = [("complete-history.xml", count)]
            if lane == "structural":
                documents.append(("native-recovery.xml", 165))
            for name, required_count in documents:
                cases = list(ET.fromstring(archive.read(name)).iter("testcase"))
                assert len(cases) == required_count, f"{lane}/{name}: population differs"
                counts = {kind: sum(case.find(kind) is not None for case in cases)
                          for kind in ("failure", "error", "skipped")}
                assert counts["error"] == counts["skipped"] == 0, f"{lane}/{name}: errors or skips"
                if name == "native-recovery.xml":
                    assert counts["failure"] == 0, "native failures"
                else:
                    producer_failures += counts["failure"]
                result["groups"][lane + "/" + name] = {
                    "cases": len(cases), "passes": len(cases) - sum(counts.values()), **counts,
                    "failedNames": [case.get("name") for case in cases if case.find("failure") is not None],
                }
    assert producer_failures == expected_failures, "producer failure count differs"
    result["producerCases"] = sum(expected.values())
    result["producerFailures"] = producer_failures
    result["nativeCases"] = 165
    result["completeGatePassed"] = producer_failures == 0
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path)
    parser.add_argument("--expect-producer-failures", type=int, default=0)
    arguments = parser.parse_args()
    print(json.dumps(audit(arguments.directory, arguments.expect_producer_failures), indent=2))
