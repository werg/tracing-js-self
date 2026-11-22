#!/usr/bin/env python3
"""Independently audit the immutable failed actual348 evaluation; no inference.

Read the original 64-case ZIP, original348 checkpoint and complete evaluation
ZIP. Recheck all original source projections, compare every served tensor to
the real checkpoint, and audit every rejected fragment without repairing it.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import json
import os
import platform
import re
import stat
import subprocess
import sys
import zipfile
from collections import Counter
from pathlib import Path, PurePosixPath

PRODUCER = "9cf091e6ccc5add960ef0897576d0c391b199a65"
NATIVE = "1a69d9da3254b7568c831d12866a629c206cf4fe"
ZIP_SHA = "2d575cbec0b543e329e68e9bb1289e3a7f33988866a145a9fb3c641a41ff91ad"
ORIGINAL_SHA = "6dc909ecc1c1ed7401fa5ceb1cba7006c07641d530a1550f16a7870af3e483af"
STATE_SHA = "854c37716597b0cb13cece65805ad646ffe837d2ca64bc6de99331bf1bce703a"
MODEL_SHA = "88c4b86fdfcdc0032a3813b59317fdc0a240dbf434b06e63362b495fccf3940e"
TOKENIZER_SHA = "40fb9d7d7795b8bd305aeff39ce9963f3f450915b9553f2938e009be9a1fed60"
TOKENIZER = "7f52faca2fe82273a889023defd2f1a6fd6080a21096ec77e97f4798a0a370b2"
LINEAGE = "74bb51e8757fc3f6a6119e52a5a2ace1b9a484533350dd81fc0f0b085de14d92"
SPLITS = {"train": 12, "validation": 3, "test": 1}


def require(value, message):
    if not value:
        raise ValueError(message)


def read(data):
    def unique(items):
        out = {}
        for key, value in items:
            require(key not in out, "Duplicate JSON field: " + key)
            out[key] = value
        return out
    return json.loads(data, object_pairs_hook=unique,
                      parse_constant=lambda value: (_ for _ in ()).throw(ValueError(value)))


def sha(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def saved(path, value):
    with path.open("x") as stream:
        json.dump(value, stream, sort_keys=True, indent=2, allow_nan=False)
        stream.write("\n")


def git(path, *args):
    env = {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}
    return subprocess.check_output(["git", "-C", str(path), *args], env=env, text=True).strip()


def sources(producer, native):
    for path, expected in ((producer, PRODUCER), (native, NATIVE)):
        require(git(path, "rev-parse", "HEAD") == expected, "Original source revision changed")
        require(not git(path, "status", "--porcelain", "--untracked-files=all"), "Original source dirty")


def same_tree(left, right):
    import torch
    if isinstance(left, torch.Tensor):
        return isinstance(right, torch.Tensor) and left.dtype == right.dtype and torch.equal(left, right)
    if type(left) is not type(right):
        return False
    if isinstance(left, dict):
        return left.keys() == right.keys() and all(same_tree(left[key], right[key]) for key in left)
    if isinstance(left, (list, tuple)):
        return len(left) == len(right) and all(same_tree(a, b) for a, b in zip(left, right, strict=True))
    return left == right


def execute(args):
    sources(args.producer, args.native)
    require(platform.python_version() == "3.12.14", "Original Python required")
    packages = {name: importlib.metadata.version(name) for name in ("torch", "numpy", "safetensors", "tokenizers")}
    require(packages == {"torch": "2.10.0+cpu", "numpy": "2.5.5", "safetensors": "0.8.0", "tokenizers": "0.23.3"}, "Original packages required")
    node = subprocess.check_output(["node", "--version"], text=True).strip()
    require(node == "v24.22.3", "Original Node required")
    require(args.archive.stat().st_size == 16427247 and sha(args.archive) == ZIP_SHA, "Evaluation ZIP differs")
    require(args.original.stat().st_size == 175381869 and sha(args.original) == ORIGINAL_SHA, "Original 64-case ZIP differs")
    require(sha(args.checkpoint / "state.pt") == STATE_SHA, "Actual348 checkpoint differs")
    require(not args.out.exists(), "Audit output must be new")
    args.out.mkdir(parents=True)
    for source in (args.producer, args.native, args.checkpoint):
        require(not args.out.is_relative_to(source) and not source.is_relative_to(args.out), "Audit output overlaps frozen input")
    evidence = args.out / "materialized"
    evidence.mkdir()
    members = {}
    with zipfile.ZipFile(args.archive) as archive:
        for item in archive.infolist():
            name = item.filename
            path = PurePosixPath(name)
            require(name and not path.is_absolute() and "\\" not in name and all(part not in ("", ".", "..") for part in name.split("/")), "Unsafe member")
            require(name not in members and not item.is_dir() and stat.S_IFMT(item.external_attr >> 16) in (0, stat.S_IFREG), "Duplicate/nonregular member")
            data = archive.read(item)
            members[name] = {"bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}
            target = evidence / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
    require(len(members) == 114, "Original member population differs")
    root = evidence / "original348-pure-evaluation"
    profile = read((root / "predeclared-profile.json").read_bytes())
    aggregate = read((root / "report.json").read_bytes())
    identities = read((root / "export-identities.json").read_bytes())
    original = {}
    with zipfile.ZipFile(args.original) as archive:
        for item in archive.infolist():
            if item.filename.startswith("v8-admitted/") and item.filename.endswith(".admitted.json"):
                name = Path(item.filename).name.removesuffix(".admitted.json")
                require(name not in original, "Duplicate original source")
                original[name] = archive.read(item)
    require(len(original) == 64, "Original complete source population differs")
    all_rows = [{"id": key, "split": read(value)["sidecar"]["split"],
                 "family": read(value)["sidecar"]["sourceFamily"]} for key, value in sorted(original.items())]
    require(Counter(row["split"] for row in all_rows) == {"train": 48, "validation": 12, "test": 4}, "Original splits differ")
    pure = [row for row in all_rows if row["id"].endswith("-pure")]
    other = [row for row in all_rows if not row["id"].endswith("-pure")]
    require(len(pure) == len({row["family"] for row in pure}) == 16 and Counter(row["split"] for row in pure) == SPLITS, "Pure-case denominator differs")
    require([{key: row[key] for key in ("id", "split", "family")} for row in profile["cases"]] == pure, "Predeclared case selection differs")
    require(profile["unmeasuredProfileCases"] == aggregate["unmeasuredProfileCases"] == other, "Other48 cases omitted or measured")
    for row in profile["cases"]:
        data = (root / "source-cases" / (row["id"] + ".json")).read_bytes()
        require(data == original[row["id"]] and len(data) == row["artifactBytes"] and hashlib.sha256(data).hexdigest() == row["artifactSha256"], "Original source artifact bytes differ")
    freeze = read((root / "all-studies-frozen-before-inference.json").read_bytes())
    require(freeze["declared"] == 16 and freeze["splitCounts"] == SPLITS and freeze["modelCallsPerformed"] == freeze["optimizerUpdatesPerformed"] == 0, "Prefreeze authority differs")
    require(len(freeze["studies"]) == 6 and all(sha(root / name) == expected for name, expected in freeze["studies"].items()), "Study or private source changed after freeze")
    commands = read((root / "commands.json").read_bytes())
    expected_stages = ["export-actual348", "freeze-train", "freeze-validation", "freeze-test", *["measure-" + row["id"] for row in pure]]
    require([row["stage"] for row in commands] == expected_stages, "Inference occurred before full freeze or case population changed")
    for command in commands:
        require(command["exitCode"] == 0 and command["error"] is None and command["timedOut"] is False, "Original process incomplete")
        require(read((root / (command["stage"] + ".receipt.json")).read_bytes()) == command, "Command receipt differs")
    require(aggregate["status"] == "measurement-incomplete" and aggregate["declared"] == 16
            and aggregate["initializedBaseline"] == "unmeasured" and aggregate["optimizerUpdatesPerformed"] == 0
            and aggregate["defaultPromotion"] is False and aggregate["full64ProfileQualityMeasured"] is False,
            "Original failed measurement was altered")

    sys.path.insert(0, str(args.native / "src"))
    import torch
    from safetensors.torch import load_file
    from megatoken.loading import load_trained
    from megatoken.semantic_lineage_v8 import validate_served_lineage_v8
    torch.set_num_threads(1)
    served = root / "served"
    manifest = read((served / "manifest.json").read_bytes())
    lineage = read((served / "semantic-v8-lineage.json").read_bytes())
    require(manifest["model_sha256"] == MODEL_SHA and manifest["checkpoint_sha256"] == STATE_SHA
            and manifest["model_version"] == 348 and manifest["codec_fingerprint"] == TOKENIZER
            and manifest["tokenizer_sha256"] == TOKENIZER_SHA and manifest["semantic_v8_lineage_digest"] == LINEAGE
            and manifest["training_heads"] is False, "Export is not actual348")
    validate_served_lineage_v8(lineage, manifest)
    for name, field in (("model.safetensors", "model_sha256"), ("tokenizer.json", "tokenizer_sha256"), ("model_config.json", "config_sha256"),
                        ("transducer.pt", "transducer_sha256"), ("semantic-v8-lineage.json", "semantic_v8_lineage_sha256")):
        require(sha(served / name) == manifest[field], "Served file hash differs")
    require(identities["bundleFiles"] == {path.name: sha(path) for path in served.iterdir()}, "Complete export file inventory differs")
    trained = load_trained(args.checkpoint, codec_path=served / "tokenizer.json")
    state = trained.model.served_state_dict()
    actual = load_file(str(served / "model.safetensors"))
    require(state.keys() == actual.keys() and all(state[key].dtype == actual[key].dtype and torch.equal(state[key], actual[key]) for key in state), "At least one served tensor differs from original348 checkpoint")
    bank = torch.load(served / "transducer.pt", map_location="cpu", weights_only=True)
    require(same_tree(trained.model.transducer.bank.state_snapshot(), bank["bank"]), "Served transducer differs from original348 checkpoint")
    require(trained.payload["global_step"] == 348 and trained.metadata["state_sha256"] == STATE_SHA, "Loaded checkpoint step differs")
    model_proof = {"tensorCount": len(state), "tensorElements": sum(value.numel() for value in state.values()),
                   "allServedTensorsExactlyEqual": True, "transducerSnapshotExactlyEqual": True,
                   "modelSha256": MODEL_SHA, "trainingStateSha256": STATE_SHA, "modelVersion": 348,
                   "tokenizerIdentity": trained.codec.fingerprint, "servingLineageDigest": LINEAGE}
    fragments, cases = [], []
    for item in pure:
        report = read((root / "case-results" / item["id"] / "report.json").read_bytes())
        row = next(row for row in report["rows"] if row["caseId"] == item["id"])
        result = row["result"]
        require(len(result["attempts"]) == 1, "Unexpected original attempt population")
        selection = result["failure"]["evidence"]["selection"]
        payloads = []
        for index, fragment in enumerate(selection["fragments"]):
            ids = fragment["emittedTokenIds"]
            require(fragment["tokenIds"] == ids and ids and all(type(value) is int and 0 <= value < trained.codec.vocab_size for value in ids), "Original lexical token IDs differ")
            payload = bytes.fromhex(fragment["payloadHex"])
            require(trained.codec.decode(ids) == payload, "Original tokenizer does not reproduce retained fragment bytes")
            error = None
            try:
                payload.decode("utf-8", errors="strict")
            except UnicodeDecodeError as failure:
                error = {"start": failure.start, "end": failure.end, "reason": failure.reason,
                         "bytesHex": payload[failure.start:failure.end].hex()}
            fragments.append({"caseId": item["id"], "index": index, "bytes": len(payload), "tokens": len(ids),
                              "payloadSha256": hashlib.sha256(payload).hexdigest(), "exactOriginalTokenDecoding": True,
                              "utf8Valid": error is None, "utf8Error": error, "terminal": fragment["terminal"]})
            payloads.append(payload)
        total = b"".join(payloads)
        represented = bytes.fromhex(selection["payloadHex"] or "")
        count = sum(len(fragment["emittedTokenIds"]) for fragment in selection["fragments"])
        require(selection["generatedTokens"] == count, "Native original token count differs")
        validated = result["attempts"][0].get("provenanceValidated") is True
        require(validated == (selection["payloadHex"] is not None and represented == total), "Unexpected provenance flag")
        cases.append({**item, "fragmentCount": len(payloads), "nativeClaimedTokens": count,
                      "allRetainedFragmentBytes": len(total), "aggregatePayloadBytes": len(represented),
                      "aggregatePayloadNull": selection["payloadHex"] is None,
                      "aggregateOmitsRejectedFinalFragment": not validated and represented == b"".join(payloads[:-1]),
                      "invalidUtf8Fragments": sum(not row["utf8Valid"] for row in fragments if row["caseId"] == item["id"]),
                      "provenanceValidated": validated, "completeSourceProgram": False,
                      "sourceScoringComplete": result["sourceEvidence"]["sourceValidated"] is True,
                      "acceptedSelections": result["costs"]["accepted"], "unknownGenerationCostAttempts": result["costs"]["unknownGenerationCostAttempts"],
                      "retainedVerifiedTokenCost": result["costs"]["generatedTokens"],
                      "originalFailure": result["failure"]["message"]})
    saved(args.out / "fragment-audit.json", {"schema": "semantic-v8-original348-fragment-audit/1", "cases": cases, "fragments": fragments,
        "qualification": "Offline byte/token reproduction does not retroactively validate the original incomplete selection envelope or repair output"})
    del actual, state, trained
    command = ["node", "--experimental-vm-modules", str(Path(__file__).with_name("audit-source.mjs")), str(args.producer), str(root)]
    source_environment = {**os.environ, "TZ": "UTC", "TRACING_REFERENCE_ISOLATION": "trusted-process"}
    process = subprocess.run(command, env=source_environment, capture_output=True, text=True, timeout=300, check=False)
    (args.out / "source-audit.stdout").write_text(process.stdout)
    (args.out / "source-audit.stderr").write_text(process.stderr)
    saved(args.out / "source-audit-command.json", {"command": command, "environment": {"TZ": "UTC", "TRACING_REFERENCE_ISOLATION": "trusted-process"},
        "exitCode": process.returncode, "modelCallsPerformed": 0, "optimizerUpdatesPerformed": 0})
    require(process.returncode == 0, "Independent source replay audit failed; inspect original stdout/stderr")
    source_audit = read(process.stdout)
    require(source_audit["sourceScoringComplete"] == 16 and source_audit["selectionProvenanceValidated"] == 8
            and source_audit["completePrograms"] == 0, "Independent source/provenance result differs")
    require(sha(args.archive) == ZIP_SHA and sha(args.original) == ORIGINAL_SHA and sha(args.checkpoint / "state.pt") == STATE_SHA,
            "Original evidence changed during audit")
    require(all(sha(evidence / name) == row["sha256"] for name, row in members.items()), "Original materialized evidence changed")
    sources(args.producer, args.native)
    summary = {"schema": "semantic-v8-original348-independent-audit/1", "auditStatus": "passed",
        "originalRun": 45046754653, "originalDriver": "f4bcf1e0bfde2dee398df3df692246b3e93dadef", "originalRunConclusion": "failure",
        "originalMeasurementStatus": "measurement-incomplete", "declared": 16, "processesCompleted": 16, "sourceScoringComplete": 16,
        "selectionProvenanceValidated": 8, "selectionProvenanceUnvalidated": 8, "completeSourcePrograms": 0,
        "splits": {split: {"declared": count, "sourceScoringComplete": sum(row["sourceScoringComplete"] for row in cases if row["split"] == split),
            "selectionProvenanceValidated": sum(row["provenanceValidated"] for row in cases if row["split"] == split), "completeSourcePrograms": 0} for split, count in SPLITS.items()},
        "exportProof": model_proof, "originalArchive": {"bytes": args.archive.stat().st_size, "sha256": ZIP_SHA, "members": members},
        "sourceRevisions": {"producer": PRODUCER, "native": NATIVE}, "runtime": {"python": platform.python_version(), "node": node, "packages": packages, "platform": platform.platform()},
        "fragmentTotals": {"fragments": len(fragments), "invalidUtf8": sum(not row["utf8Valid"] for row in fragments),
            "originalTokensDecodedExactly": sum(row["tokens"] for row in fragments), "rawRejectedBytesRetained": sum(row["bytes"] for row in fragments)},
        "invalidFragmentAccounting": "Native retains the invalid fragment and token IDs before validation, but updates aggregate payload only after validation; producer correctly refuses incomplete aggregate binding",
        "otherProfileCasesUnmeasured": 48, "initializedReferenceBaseline": "unmeasured", "defaultPromotion": False,
        "modelCallsPerformedByAudit": 0, "optimizerUpdatesPerformedByAudit": 0, "originalEvidenceChanged": False}
    saved(args.out / "independent-audit.json", summary)
    print(json.dumps({key: value for key, value in summary.items() if key not in ("originalArchive",)}, sort_keys=True))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for key in ("archive", "original", "checkpoint", "producer", "native", "out"):
        parser.add_argument("--" + key, type=lambda value: Path(value).resolve(), required=True)
    execute(parser.parse_args())


if __name__ == "__main__":
    main()
