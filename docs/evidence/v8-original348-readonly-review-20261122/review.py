#!/usr/bin/env python3
"""Audit retained original348 bytes without importing a model or running inference.

The three original serving binaries and the training state are deliberately not
materialized. Their earlier tensor audit remains separately attributed evidence.
"""
from __future__ import annotations

import argparse
import base64
from collections import Counter
import gzip
import hashlib
import json
from pathlib import Path
import subprocess
import tarfile
import xml.etree.ElementTree as ET

PRODUCER = "02add9d951aa05f46d040f55cd53b05ec7b91279"
NATIVE = "33031866fc7e2d20156a454064aeafd4ef79ccf3"
ORIGINAL_PRODUCER = "9cf091e6ccc5add960ef0897576d0c391b199a65"
ORIGINAL_NATIVE = "1a69d9da3254b7568c831d12866a629c206cf4fe"
STATE = "854c37716597b0cb13cece65805ad646ffe837d2ca64bc6de99331bf1bce703a"
MODEL = "88c4b86fdfcdc0032a3813b59317fdc0a240dbf434b06e63362b495fccf3940e"
TOKENIZER = "40fb9d7d7795b8bd305aeff39ce9963f3f450915b9553f2938e009be9a1fed60"
CODEC = "7f52faca2fe82273a889023defd2f1a6fd6080a21096ec77e97f4798a0a370b2"
LINEAGE = "74bb51e8757fc3f6a6119e52a5a2ace1b9a484533350dd81fc0f0b085de14d92"
TRAINING_LINEAGE = "8d7a1c8252bb239e4e18dd62902aa9265b2ceb992c71cf48b1a7c2afbc12545e"
EVIDENCE = "docs/evidence/v8-original348-pure-evaluation-20261122"
PREFIX = "original348-pure-evaluation/"


def require(condition, message):
    if not condition:
        raise ValueError(message)


def read_json(data):
    def unique(pairs):
        result = {}
        for key, value in pairs:
            require(key not in result, "duplicate JSON key: " + key)
            result[key] = value
        return result
    return json.loads(data, object_pairs_hook=unique,
                      parse_constant=lambda value: (_ for _ in ()).throw(ValueError(value)))


def sha(data):
    return hashlib.sha256(data).hexdigest()


def git_bytes(root, revision, path):
    return subprocess.check_output(["git", "-C", str(root), "show", revision + ":" + path])


def git_blob(data):
    return hashlib.sha1(b"blob " + str(len(data)).encode() + b"\0" + data).hexdigest()


def main(args):
    evidence = args.producer / EVIDENCE
    read_files = {}

    def observed(path):
        data = path.read_bytes()
        require(path not in read_files or read_files[path] == sha(data), "read file changed")
        read_files[path] = sha(data)
        return data

    custody = read_json(observed(evidence / "original-archive.json"))
    require(custody["runId"] == 45046754653 and custody["runConclusion"] == "failure",
            "original failed run identity changed")
    members = {}
    archive = observed(evidence / "original-text-evidence.tar.gz")
    with tarfile.open(evidence / "original-text-evidence.tar.gz") as tar:
        for item in tar:
            require(item.isfile() and item.name not in members, "duplicate or nonregular member")
            data = tar.extractfile(item).read()
            require(custody["completeOriginalMembers"][item.name] ==
                    {"bytes": len(data), "sha256": sha(data)}, "original member differs")
            members[item.name] = data
    omitted = set(custody["completeOriginalMembers"]) - members.keys()
    require(len(members) == 111 and omitted == {
        PREFIX + "served/model.safetensors", PREFIX + "served/tokenizer.json",
        PREFIX + "served/transducer.pt"}, "original retained/omitted population changed")

    def document(name):
        return read_json(members[PREFIX + name])

    aggregate = document("report.json")
    require(gzip.decompress(observed(evidence / "original-report.json.gz")) ==
            members[PREFIX + "report.json"], "duplicate report differs")
    prior = read_json(observed(evidence / "independent-audit.json"))
    prior_source = read_json(gzip.decompress(observed(evidence / "source-audit.json.gz")))
    source_by_id = {row["caseId"]: row for row in prior_source["rows"]}
    require(len(source_by_id) == 16 and prior_source["sourceScoringComplete"] == 16,
            "retained source audit population changed")
    require(aggregate["status"] == "measurement-incomplete" and aggregate["declared"] == 16
            and not aggregate["defaultPromotion"] and not aggregate["full64ProfileQualityMeasured"],
            "historical outcome changed")

    # Read all 64 local original source artifacts; select the original pure
    # profile by its name and split, before examining any model output.
    originals = {}
    for path in sorted(args.original_admitted.glob("*.admitted.json")):
        originals[path.name.removesuffix(".admitted.json")] = observed(path)
    require(len(originals) == 64, "complete original source inventory required")
    inventory = [{"id": name, "split": read_json(data)["sidecar"]["split"],
                  "family": read_json(data)["sidecar"]["sourceFamily"]}
                 for name, data in originals.items()]
    require(Counter(row["split"] for row in inventory) == {"train": 48, "validation": 12, "test": 4},
            "original source splits changed")
    pure = [row for row in inventory if row["id"].endswith("-pure")]
    profile = document("predeclared-profile.json")
    require([{key: row[key] for key in ("id", "split", "family")} for row in profile["cases"]]
            == pure and len(pure) == 16, "predeclared pure population differs")
    require(profile["unmeasuredProfileCases"] == [row for row in inventory if not row["id"].endswith("-pure")],
            "other48 population differs")

    # Reproduce original emitted IDs directly from the pinned ByteLevel BPE
    # lexical mapping, without decoding through UTF-8 or normalizing bytes.
    tokenizer_raw = observed(args.tokenizer)
    require(sha(tokenizer_raw) == TOKENIZER, "original tokenizer bytes differ")
    token_document = read_json(tokenizer_raw)
    require(token_document["model"]["type"] == "BPE" and token_document["decoder"]["type"] == "ByteLevel",
            "unexpected tokenizer kind")
    literal = list(range(33, 127)) + list(range(161, 173)) + list(range(174, 256))
    extra = [byte for byte in range(256) if byte not in literal]
    alphabet = {chr(byte): byte for byte in literal}
    alphabet.update({chr(256 + index): byte for index, byte in enumerate(extra)})
    pieces = {index: bytes(alphabet[char] for char in spelling)
              for spelling, index in token_document["model"]["vocab"].items()}
    for token in token_document["added_tokens"]:
        if token.get("special", False):
            pieces.pop(token["id"], None)
    require(sha(("raw-byte-bpe-v2;binary=single-byte-v1;special-merges=masked;asset=" +
                 TOKENIZER + ";rows=157184").encode()) == CODEC, "codec fingerprint differs")

    manifest, lineage = document("served/manifest.json"), document("served/semantic-v8-lineage.json")
    metadata, export = document("source-checkpoint-metadata.json"), document("export-identities.json")
    identities = {"checkpointIdentity": MODEL, "tokenizerIdentity": CODEC, "trainingIdentity": LINEAGE}
    require(metadata["state_sha256"] == manifest["checkpoint_sha256"] ==
            lineage["trainingCheckpointSha256"] == export["trainingCheckpointSha256"] ==
            aggregate["trainingCheckpointSha256"] == STATE, "training-state identity differs")
    require(metadata["global_step"] == manifest["model_version"] == lineage["modelVersion"] == 348,
            "loaded/exported model step differs")
    require(metadata["semantic_v8_lineage_digest"] == lineage["training"]["digest"] == TRAINING_LINEAGE,
            "training lineage differs")
    require(manifest["model_sha256"] == lineage["modelIdentity"] == MODEL and
            manifest["semantic_v8_lineage_digest"] == lineage["digest"] == LINEAGE,
            "served identity differs")
    require(lineage["training"]["policy"]["producerRevision"] == ORIGINAL_PRODUCER and
            lineage["training"]["policy"]["consumerRevision"] == ORIGINAL_NATIVE,
            "frozen training source pair differs")
    for name, expected in export["bundleFiles"].items():
        require(custody["completeOriginalMembers"][PREFIX + "served/" + name]["sha256"] == expected,
                "complete served inventory hash differs")
    for key, expected in identities.items():
        require(export[key] == aggregate["identities"][key] == expected, "aggregate identity differs")
    require(prior["exportProof"]["trainingStateSha256"] == STATE and
            prior["exportProof"]["modelSha256"] == MODEL and prior["exportProof"]["tensorCount"] == 407
            and prior["exportProof"]["allServedTensorsExactlyEqual"] is True,
            "retained prior binary comparison differs")

    commands = document("commands.json")
    expected_stages = ["export-actual348", "freeze-train", "freeze-validation", "freeze-test"]
    expected_stages += ["measure-" + row["id"] for row in pure]
    require([row["stage"] for row in commands] == expected_stages, "command order or population changed")
    for command in commands:
        require(command["exitCode"] == 0 and command["error"] is None and command["timedOut"] is False,
                "original command failed or timed out")
        require(document(command["stage"] + ".receipt.json") == command, "command receipt changed")
    frozen = document("all-studies-frozen-before-inference.json")
    require(frozen["declared"] == 16 and frozen["modelCallsPerformed"] == 0,
            "pre-inference freeze changed")
    for name, expected in frozen["studies"].items():
        require(sha(members[PREFIX + name]) == expected, "frozen study/private oracle changed")

    rows, fragments, invalid_originals = [], [], {}
    for item in profile["cases"]:
        case_id = item["id"]
        source_data = members[PREFIX + "source-cases/" + case_id + ".json"]
        require(source_data == originals[case_id] and sha(source_data) == item["artifactSha256"],
                "evaluation source differs from the original admitted artifact")
        source = read_json(source_data)
        study = document("studies/" + item["split"] + "/study.json")
        public_case = next(row for row in study["cases"] if row["id"] == case_id)
        require("expectedArtifact" not in public_case and public_case["request"]["fixture"] ==
                {"calls": [], "settlementOrder": None}, "private answer present in public input")
        require(public_case["request"]["initialPublic"]["timeline"] == source["public"]["timeline"][:2],
                "initial observed public prefix differs")
        expected_lines = [row["fields"]["line"] for row in source["public"]["timeline"][2:]]
        require(len(expected_lines) == 2 and expected_lines[0].startswith("algorithm ") and
                expected_lines[1] == 'detail {"fields":{"kind":"return"},"kind":"end"}',
                "pure target shape changed")
        report = document("case-results/" + case_id + "/report.json")
        reported = next(row for row in report["rows"] if row["caseId"] == case_id)
        result = reported["result"]
        require(reported.get("failure") is None and result["sourceEvidence"]["sourceValidated"] is True,
                "original private source scoring failed")
        require(source_by_id[case_id]["sourceRecheck"] is True and
                source_by_id[case_id]["resultDigest"] == result["digest"], "prior source replay receipt differs")
        require(len(result["attempts"]) == 1 and result["costs"]["accepted"] == 0 and
                result["costs"]["hostDispatches"] == 0 and result["optimizerSteps"] == 0,
                "unexpected model/host/update population")
        require(result["sourceValidated"] is False and result["completedExecution"] is False and
                result["publicCompleted"] is False, "failed generated program was promoted")
        attempt = result["attempts"][0]
        selection = attempt.get("selection") or attempt["evidence"]["selection"]
        require(selection["origin"] == "actual-model-selected" and selection["modelSelected"] is True,
                "original raw model attempt missing")
        for key, expected in identities.items():
            require(all(value[key] == expected for value in [study, report, result,
                    result["inferenceIdentity"], selection]), "per-case loaded model identity differs")
        for value in [result, result["inferenceIdentity"]]:
            require(value["seed"] == 17 and value["generationSettings"] == aggregate["settings"],
                    "per-case settings changed")
        payloads, invalid = [], []
        for index, fragment in enumerate(selection["fragments"]):
            ids = fragment["emittedTokenIds"]
            require(ids == fragment["tokenIds"] and ids and all(type(i) is int and i in pieces for i in ids),
                    "nonlexical original model token")
            payload = bytes.fromhex(fragment["payloadHex"])
            require(b"".join(pieces[i] for i in ids) == payload, "original token-to-byte mismatch")
            try:
                payload.decode("utf-8", errors="strict")
            except UnicodeDecodeError as error:
                invalid.append({"fragment": index, "start": error.start, "end": error.end,
                                "reason": error.reason, "bytesHex": payload[error.start:error.end].hex()})
            payloads.append(payload)
            fragments.append({"caseId": case_id, "index": index, "tokens": len(ids),
                              "bytes": len(payload), "sha256": sha(payload), "terminal": fragment["terminal"]})
        complete_bytes = b"".join(payloads)
        validated = attempt.get("provenanceValidated") is True
        require(validated == (selection["payloadHex"] == complete_bytes.hex()),
                "original provenance does not match complete aggregate")
        require(selection["generatedTokens"] == sum(len(f["tokenIds"]) for f in selection["fragments"]),
                "original native token count differs")
        if validated:
            require(not invalid and attempt["record"].encode() == complete_bytes and
                    not complete_bytes.startswith((b"algorithm ", b"region ", b"detail ", b"protocol ")),
                    "malformed grammar classification differs")
            require(result["failure"]["message"] == "Causal LM v8: unknown generated record or observation in loss",
                    "unexpected canonical grammar failure")
            classification = "authenticated bytes; invalid record grammar"
        else:
            require(len(invalid) == 1 and invalid[0]["fragment"] == len(payloads) - 1 and
                    bytes.fromhex(selection["payloadHex"] or "") == b"".join(payloads[:-1]),
                    "invalid-fragment aggregate failure differs")
            invalid_originals[case_id] = selection
            classification = "invalid UTF-8; original aggregate provenance incomplete"
        costs = result["costs"]
        require(costs["unknownGenerationCostAttempts"] == (0 if validated else 1) and
                costs["generatedTokens"] == (selection["generatedTokens"] if validated else 0),
                "original verified/unknown token accounting changed")
        cleanup = result["public"]["timeline"][2:]
        require(len(cleanup) == 1 and cleanup[0]["mode"] == "observed" and cleanup[0]["kind"] == "cancel",
                "failed rollout contains generated or unrelated cleanup work")
        aggregate_row = next(row for row in aggregate["rows"] if row["caseId"] == case_id)
        require(aggregate_row["actualModelMeasured"] is validated and aggregate_row["processExitCode"] == 0,
                "historical aggregate classification differs")
        rows.append({"caseId": case_id, "split": item["split"], "classification": classification,
                     "originalFailure": result["failure"]["message"], "provenanceValidated": validated,
                     "sourceOracleCompleted": True, "privateScoringFailure": None,
                     "completeProgram": False, "acceptedRecords": 0, "attempts": 1,
                     "fragments": len(payloads), "nativeClaimedTokens": selection["generatedTokens"],
                     "verifiedTokens": costs["generatedTokens"], "rawBytes": len(complete_bytes),
                     "originalAggregateBytes": None if selection["payloadHex"] is None else len(bytes.fromhex(selection["payloadHex"])),
                     "unknownGenerationCostAttempts": costs["unknownGenerationCostAttempts"],
                     "elapsedMs": costs["elapsedMs"], "invalidUtf8": invalid,
                     "firstExpectedTargetSha256": sha(expected_lines[0].encode()),
                     "originalReportSha256": sha(members[PREFIX + "case-results/" + case_id + "/report.json"]),
                     "originalResultDigest": result["digest"]})

    fixture_path = "tests/fixtures/semantic-v8-original348-invalid-fragments.json.gz.b64"
    fixture = read_json(gzip.decompress(base64.b64decode(git_bytes(args.native, NATIVE, fixture_path))))
    require({row["caseId"] for row in fixture["cases"]} == invalid_originals.keys(),
            "new native fixture does not retain all original invalid cases")
    for row in fixture["cases"]:
        original = invalid_originals[row["caseId"]]
        require(row["originalProvenanceValidated"] is False and
                row["originalAggregatePayloadHex"] == original["payloadHex"], "fixture original status changed")
        for new, old in zip(row["fragments"], original["fragments"], strict=True):
            for key in ["payloadHex", "emittedTokenIds", "terminal"]:
                require(new[key] == old[key], "new control substituted original rejected fragment")
    native_proof_dir = "docs/evidence/v8-rejected-fragments-20261122/"
    native_proof = read_json(git_bytes(args.native, NATIVE, native_proof_dir + "proof.json"))
    for path, digest in native_proof["sourceFiles"].items():
        require(sha(git_bytes(args.native, NATIVE, path)) == digest, "new native code differs from recorded proof")
    controls = {}
    for filename, expected in [("native-controls.xml", 17), ("frozen-producer-controls.xml", 2)]:
        root = ET.fromstring(git_bytes(args.native, NATIVE, native_proof_dir + filename))
        cases = root.findall(".//testcase")
        require(len(cases) == expected and all(not any(case.find(tag) is not None
                for tag in ["failure", "error", "skipped"]) for case in cases), "retained controls differ")
        controls[filename] = {"cases": len(cases), "failures": 0, "errors": 0, "skips": 0}

    require(len(rows) == 16 and sum(row["provenanceValidated"] for row in rows) == 8 and
            len(invalid_originals) == 8, "original failure categories changed")
    require(max(row["fragments"] for row in rows) < aggregate["settings"]["maxFragments"] and
            max(row["tokens"] for row in fragments) < aggregate["settings"]["maxTokens"] and
            max(row["elapsedMs"] for row in rows) < aggregate["limits"]["timeoutMs"],
            "a budget failure requires separate classification")
    source_paths = {
        "producer": ["tools/evaluate-v8-original348-pure.py", ".github/workflows/v8-original348-pure-evaluation.yml",
                     "src/semantic/causal-lm-v8.js", EVIDENCE + "/audit.py", EVIDENCE + "/audit-source.mjs"],
        "native": ["src/megatoken/semantic_model_v8.py", "src/megatoken/generation/codec.py",
                   "scripts/fit_semantic_v8.py", "tests/test_semantic_model_v8.py", fixture_path],
    }
    source_map = {}
    for label, paths in source_paths.items():
        root, revision = (args.producer, PRODUCER) if label == "producer" else (args.native, NATIVE)
        source_map[label] = {path: {"gitBlob": git_blob(data), "sha256": sha(data)}
                             for path in paths for data in [git_bytes(root, revision, path)]}
    require(git_bytes(args.producer, ORIGINAL_PRODUCER, "src/semantic/causal-lm-v8.js") ==
            git_bytes(args.producer, PRODUCER, "src/semantic/causal-lm-v8.js"), "reviewed grammar differs from original")
    for path, expected in read_files.items():
        require(sha(path.read_bytes()) == expected, "original input changed during read-only audit")

    output = {
        "schema": "semantic-v8-original348-readonly-review/1", "reviewPassed": True,
        "reviewedProducer": PRODUCER, "reviewedNative": NATIVE,
        "originalRun": 45046754653, "originalRunConclusion": "failure",
        "originalMeasurementStatus": "measurement-incomplete", "completePrograms": 0, "declared": 16,
        "sourceOraclesCompletedInRetainedReports": 16, "sourceOraclesReexecutedByThisReview": 0,
        "authenticatedMalformedGrammar": 8, "invalidUtf8WithIncompleteOriginalProvenance": 8,
        "modelCallsPerformed": 0, "optimizerUpdatesPerformed": 0, "newModelQualityClaim": False,
        "originalEvidenceUnchanged": True, "readFilesRehashedUnchanged": len(read_files),
        "retainedArchive": {"sha256": sha(archive), "bytes": len(archive), "membersVerified": 111,
                            "memberBytes": sum(map(len, members.values())), "omitted": sorted(omitted)},
        "sourcePopulation": {"originalArtifactsRead": 64, "pureArtifactsByteEqual": 16,
                             "splitCounts": dict(Counter(row["split"] for row in rows)), "otherProfilesUnmeasured": 48},
        "checkpointChain": {"trainingStateSha256": STATE, "servedModelSha256": MODEL,
                            "tokenizerSha256": TOKENIZER, "codecIdentity": CODEC, "servingLineage": LINEAGE,
                            "loadedAttestationsChecked": 16, "modelVersion": 348,
                            "trainingPhaseConsumed": metadata["phase_consumed"],
                            "directTensorComparisonRerun": False, "retainedPriorTensorComparison": prior["exportProof"]},
        "emissionBytes": {"fragments": len(fragments), "tokenIdsDecodedExactly": sum(row["tokens"] for row in fragments),
                          "bytes": sum(row["bytes"] for row in fragments), "invalidUtf8FinalFragments": 8,
                          "decoder": "independent pinned ByteLevel lexical mapping; no normalization or re-encoding"},
        "budgets": {"limits": aggregate["limits"], "settings": aggregate["settings"],
                    "maxAttempts": 1, "maxFragments": max(row["fragments"] for row in rows),
                    "maxTokensPerFragment": max(row["tokens"] for row in fragments),
                    "minElapsedMs": min(row["elapsedMs"] for row in rows),
                    "maxElapsedMs": max(row["elapsedMs"] for row in rows),
                    "processTimeouts": 0, "processFailures": 0},
        "laterNativeCorrection": {"revision": NATIVE, "originalCasesRetainedExactly": 8,
                                  "retainedControls": controls, "controlsRerunByThisReview": 0,
                                  "qualification": "Fake-runtime raw-byte regression and frozen producer boundary controls; no new learned inference"},
        "originalDriver": {"revision": "f4bcf1e0bfde2dee398df3df692246b3e93dadef",
                           "path": "tools/evaluate-v8-original348-pure.py",
                           "githubBlob": "3e2dfd008f0e5c02af3b66a56aefd406270f3bc8",
                           "sha256": "91bc6c596787bfd2ccc68c775f9215f3f918ad9ff50ffca9b06684ff5e467779",
                           "inspection": "Fetched exact source through GitHub; current driver additionally gates sourceScoringComplete"},
        "sourceMap": source_map, "rows": rows,
    }
    args.out.write_text(json.dumps(output, sort_keys=True, indent=2, allow_nan=False) + "\n")
    print(json.dumps({key: output[key] for key in ["reviewPassed", "declared", "completePrograms",
          "authenticatedMalformedGrammar", "invalidUtf8WithIncompleteOriginalProvenance", "emissionBytes",
          "modelCallsPerformed", "optimizerUpdatesPerformed", "originalEvidenceUnchanged"]}, sort_keys=True))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--producer", type=Path, required=True)
    parser.add_argument("--native", type=Path, required=True)
    parser.add_argument("--original-admitted", type=Path, required=True)
    parser.add_argument("--tokenizer", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    main(parser.parse_args())
