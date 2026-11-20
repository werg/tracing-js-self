#!/usr/bin/env python3
"""Independently bind dataset candidates to complete qualification reports."""
import argparse
import hashlib
import json
from pathlib import Path


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def read(path):
    return json.loads(path.read_bytes())


def require(condition, message):
    if not condition:
        raise ValueError(message)


parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("run", type=Path)
parser.add_argument("--qualification", action="append", type=Path, required=True)
parser.add_argument("--producer-revision", required=True)
parser.add_argument("--consumer-revision", required=True)
args = parser.parse_args()
inputs = read(args.run / "inputs.json")
candidates = [json.loads(line) for line in (args.run / "candidates.jsonl").read_bytes().splitlines() if line.strip()]
require(inputs["schema"] == "v8-dataset-qualification-inputs/1", "Input schema")
require(inputs["producerRevision"] == args.producer_revision, "Exact producer pin")
require(inputs["inputCandidates"] == len(candidates), "Candidate denominator")
require(len({row["id"] for row in candidates}) == len(candidates), "Unique candidate identities")
expected_candidates = []
source_bindings = []
source_artifacts = []
for directory in args.qualification:
    raw = (directory / "report.json").read_bytes()
    report = json.loads(raw)
    require(report["schema"] == "semantic-v8-qualification/1", "Qualification schema")
    require(report["producerRevision"] == args.producer_revision, "Qualification producer")
    require(report["nativePolicy"]["consumerRevision"] == args.consumer_revision, "Qualification consumer")
    require(report["declared"] == len(report["rows"]) == report["sourceQualified"] == report["nativeAdmitted"],
            "Complete source/native qualification")
    source_bindings.append({"population": report["population"], "declared": report["declared"],
                            "reportSha256": sha(raw), "populationDigest": report["populationDigest"]})
    for row in report["rows"]:
        require(row["source"] == row["native"] == "passed", "Qualified row " + row["id"])
        name = row["sourceArtifact"]
        require(Path(name).name == name, "Source artifact path")
        artifact_raw = (directory / name).read_bytes()
        require(sha(artifact_raw) == report["artifacts"][name], "Exact source artifact bytes")
        receipt_name = row["id"] + ".native.json"
        receipt_raw = (directory / receipt_name).read_bytes()
        require(sha(receipt_raw) == report["artifacts"][receipt_name], "Exact native receipt bytes")
        receipt = json.loads(receipt_raw)
        require(receipt == row["nativeReceipt"], "Qualified row receipt")
        require(receipt["admitted"] and receipt["consumerRevision"] == args.consumer_revision,
                "Native admission and pin")
        require(receipt["sourceVerification"]["producerRevision"] == args.producer_revision,
                "Source authority pin")
        expected_candidates.append({"id": report["population"] + ":" + row["id"],
                                    "status": "locally_verified", "exported": json.loads(artifact_raw)})
        source_artifacts.append({"population": report["population"], "id": row["id"],
                                 "artifact": name, "sha256": sha(artifact_raw)})
require(source_bindings == inputs["sources"], "Exact qualification report/population bindings")
require(candidates == expected_candidates, "Every candidate exactly equals its qualified source artifact")
print(json.dumps({"schema": "v8-dataset-qualification-input-check/1", "passed": True,
                  "producerRevision": args.producer_revision, "consumerRevision": args.consumer_revision,
                  "inputCandidates": len(candidates), "qualificationReportsChecked": len(source_bindings),
                  "sourceArtifactsChecked": len(source_artifacts), "sources": source_bindings,
                  "sourceArtifacts": source_artifacts, "exactCandidateEquality": True,
                  "freshNativeExecution": False, "optimizerSteps": 0, "learningClaim": None}, indent=2))
