#!/usr/bin/env python3
"""Emit bounded, exact CI diagnostic files for durable review through run logs."""
import argparse
import base64
import gzip
import hashlib
import json
import os
from pathlib import Path

FILES = (
    "native-environment.json",
    "native-input-parity.json",
    "native-corpus/counter-0.json",
    "native-conditionals/report.json",
    "native-conditionals/initialization-config.json",
    "native-conditionals/loss-masks.json",
    "native-conditionals/comparison.json",
    "native-conditionals/recurrent-comparison.json",
    "native-conditionals/training-conditional.json",
    "native-conditionals/serving-conditional.json",
    "native-conditionals/training-supervision-audit.json",
    "native-decoder-fit/report.json",
    "native-decoder-fit/trainer-boundary.json",
    "native-decoder-fit/boundary-comparison.json",
    "native-decoder-fit/fit-progress.json",
    "native-decoder-fit/fit-failure.json",
    "native-two-boundaries/report.json",
    "native-two-boundaries/training-boundary-1.json",
    "native-two-boundaries/training-boundary-2.json",
    "native-two-boundaries/serving-boundary-1.json",
    "native-two-boundaries/serving-boundary-2.json",
    "native-fitted-audit/report.json",
    "native-fitted-audit/training-supervision-audit.json",
    "current-v6-capabilities.json",
)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", required=True, type=Path)
    args = parser.parse_args()
    root = args.root.resolve(strict=True)
    evidence = {
        "schema": "native-ci-evidence-files/1",
        "runId": os.environ.get("GITHUB_RUN_ID"),
        "runAttempt": os.environ.get("GITHUB_RUN_ATTEMPT"),
        "workflowCommit": os.environ.get("GITHUB_SHA"),
        "files": {},
    }
    for relative in FILES:
        path = root / relative
        if not path.is_file():
            continue
        raw = path.read_bytes()
        if len(raw) > 16 * 1024 * 1024:
            raise ValueError("Diagnostic evidence file exceeds its declared bound: " + relative)
        text = raw.decode("utf-8")
        json.loads(text)
        row = {"sourcePath": relative, "sourceSha256": hashlib.sha256(raw).hexdigest(),
               "sourceBytes": len(raw)}
        if relative.endswith("serving-conditional.json"):
            compressed = gzip.compress(raw, mtime=0)
            row.update(encoding="base64", artifactPath=relative + ".gz",
                       artifactSha256=hashlib.sha256(compressed).hexdigest(),
                       content=base64.b64encode(compressed).decode("ascii"))
        else:
            row.update(encoding="utf-8", artifactPath=relative,
                       artifactSha256=row["sourceSha256"], content=text)
        evidence["files"][relative] = row
    serialized = json.dumps(evidence, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
    print("NATIVE_EVIDENCE_BEGIN")
    for offset in range(0, len(serialized), 12000):
        print("NATIVE_EVIDENCE_CHUNK:" + serialized[offset:offset + 12000])
    print("NATIVE_EVIDENCE_END")


if __name__ == "__main__":
    main()
