"""Recheck retained composed-module data; run no source producer or optimizer.

Run with PYTHONPATH pointing at exact native revision 1a69d9da and the pinned
production tokenizer. --artifact-root is the safely extracted Actions ZIP.
This reads the original scheduler0 directory; pytest's current alias is a
byte-identical duplicate, separately checked in artifact-member-inventory.json.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import time
import xml.etree.ElementTree as ET
from collections import Counter
from pathlib import Path

from megatoken.controls import canonical_semantic_observation
from megatoken.data import PreparedDataset, WindowConfig, iter_windows
from megatoken.data.protocol_v8 import decode_protocol_record
from megatoken.generation.codec import LING_TOKENIZER_SHA256, ByteCodec
from megatoken.training.positions_v8 import independent_text_target


def digest(data):
    return hashlib.sha256(data).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--artifact-root", type=Path, required=True)
    parser.add_argument("--tokenizer", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    started = time.monotonic()
    root = args.artifact_root
    evidence = json.loads((root / "module-artifact-packing-evidence.json").read_bytes())
    source_controls = json.loads(
        (root / "module-artifact-source-controls.json").read_bytes()
    )
    case = root / "module-artifact-packed-data/test_original_module_scheduler0"
    artifact_bytes = (case / "module-scheduler-source-artifact.json").read_bytes()
    artifact = json.loads(artifact_bytes)
    prepared = case / "prepared-module-scheduler"
    assert digest(artifact_bytes) == evidence["artifactSha256"]
    manifest_bytes = (prepared / "manifest.json").read_bytes()
    report_bytes = (prepared / "semantic-v8-report.json").read_bytes()
    assert manifest_bytes.decode() == evidence["preparedManifestRaw"]
    assert report_bytes.decode() == evidence["preparedReportRaw"]
    assert digest(manifest_bytes) == evidence["preparedManifestSha256"]
    assert digest(report_bytes) == evidence["preparedReportSha256"]
    manifest = json.loads(manifest_bytes)
    report = json.loads(report_bytes)
    for entry in [manifest["index"], *manifest["shards"]]:
        assert digest((prepared / entry["path"]).read_bytes()) == entry["sha256"]
    assert evidence["producerRevision"] == "9cf091e6ccc5add960ef0897576d0c391b199a65"
    assert evidence["consumerRevision"] == "1a69d9da3254b7568c831d12866a629c206cf4fe"
    assert (
        report["contractDigest"]
        == "a952385535b9b5e19d737206286f6f26c149f7301c51b4b106fe3b1cae5ab55a"
    )
    assert report["counts"] == {"admitted": 1, "attempted": 1}
    assert report["refusals"] == []
    assert report["maxPositions"] == 8192 and report["maxHistory"] == 1024
    assert report["optimizerSteps"] == evidence["optimizerUpdates"] == 0
    assert report["learningClaim"] is evidence["learnedSuccess"] is None
    assert evidence["productionPopulationChanged"] is False

    tests = {}
    for name, expected in (
        ("admission-controls", 45),
        ("source-controls", 9),
        ("packing", 1),
    ):
        raw = (root / f"module-artifact-{name}.xml").read_bytes()
        tree = ET.fromstring(raw)
        cases = list(tree.iter("testcase"))
        assert len(cases) == expected
        assert not any(
            case.find(tag) is not None
            for case in cases
            for tag in ("failure", "error", "skipped")
        )
        tests[name] = {
            "testCases": len(cases),
            "failures": 0,
            "errors": 0,
            "skipped": 0,
            "junitSha256": digest(raw),
            "seconds": sum(float(case.get("time", 0)) for case in cases),
        }
    assert source_controls["summary"] == {
        "schema": "bound-module-source-admission-controls/1",
        "sourceCases": 1,
        "contexts": 708,
        "sourceValidated": True,
        "projectionValidated": True,
        "replayValidated": True,
        "nativeAdmission": False,
        "productionPopulationChanged": False,
        "optimizerUpdates": 0,
    }
    generated = [
        row for row in artifact["public"]["timeline"] if row["mode"] == "generated"
    ]
    assert len(generated) == len(artifact["contexts"]) == 708
    source = artifact["sidecar"]["sourceArtifact"]["sidecar"]
    assert source["compiler"]["moduleSchedulerOwnership"]["ownedEventCount"] == 10
    assert (
        source["moduleSchedulerPlan"]["schema"]
        == "semantic-bound-module-scheduler-plan/1"
    )
    assert len(artifact["sidecar"]["splitIdentity"]["registry"]["sources"]) == 1
    assert artifact["sidecar"]["splitIdentity"]["split"] == "validation"
    codec = ByteCodec.from_tokenizer_json(
        args.tokenizer, expected_sha256=LING_TOKENIZER_SHA256
    )
    assert codec.fingerprint == manifest["codec_fingerprint"]
    with PreparedDataset(prepared, split=None) as dataset:
        assert len(dataset) == 1
        episode = dataset[0]
    semantic = json.loads(episode.supervision.annotations_json)["semantic_execution"]
    assert semantic["admission"] == "admitted"
    assert semantic["modelExecutionOutcome"] == "unmeasured"
    for key in (
        "sourceAdmission",
        "nativeAdmission",
        "nativeTrainingDigest",
        "tokenizerEvidence",
    ):
        assert semantic[key] == evidence[key]
    assert all(
        evidence["sourceAdmission"][key] is True
        for key in ("sourceValidated", "projectionValidated", "replayValidated")
    )
    assert all(
        evidence["nativeAdmission"]["checks"][key] == "passed"
        for key in (
            "replay",
            "contexts",
            "continuation",
            "masks",
            "sourceBinding",
            "tokenizer",
        )
    )
    assert evidence["nativeAdmission"]["tokenizer"]["sha256"] == LING_TOKENIZER_SHA256

    targets = {
        f"semantic:v8:target:{row['sequence']}": row["fields"]["line"].encode()
        for row in generated
    }
    contexts = {
        f"semantic:v8:context:{row['sequence']}": canonical_semantic_observation(
            context
        )
        for row, context in zip(generated, artifact["contexts"], strict=True)
    }
    groups = {parts[0].logical_id: parts for parts in episode.iter_logical_records()}
    context_parts = 0
    for identity, payload in contexts.items():
        parts = groups[identity]
        assert b"".join(row.payload for row in parts) == payload
        assert all(row.role == "system" and not row.policy_mask for row in parts)
        context_parts += len(parts)
    for identity, payload in targets.items():
        parts = groups[identity]
        assert b"".join(row.payload for row in parts) == payload
        assert all(row.role == "assistant" and row.policy_mask for row in parts)
        context = groups["semantic:v8:context:" + identity.rsplit(":", 1)[1]]
        assert any(
            edge.writer_id == context[-1].record_id
            and edge.reader_id == parts[0].record_id
            and edge.kind == "v8-public-context"
            for edge in episode.dependencies
        )
    windows = tuple(
        iter_windows(
            episode, codec, WindowConfig(max_window_tokens=8192, max_decisions=4)
        )
    )
    encoded = [row for window in windows for row in window.records]
    assert [row.record.record_id for row in encoded] == [
        row.record_id for row in episode.records
    ]
    assert len({row.record.record_id for row in encoded}) == len(encoded)
    assert all(window.D <= 8192 for window in windows)
    assert all(row.tokens <= 8192 for row in encoded)
    assert all(row.P == 0 for row in encoded if not row.record.policy_mask)
    selected = [row for row in encoded if row.record.policy_mask]
    assert {row.record.logical_id for row in selected} == set(targets)
    alphabet = bytearray(codec.vocab_size)
    for token in codec.valid_token_ids:
        alphabet[token] = 1
    alphabet_digest = digest(bytes(alphabet))
    for row in selected:
        oracle = independent_text_target(
            row.record,
            codec=codec,
            generated_capacity=8192,
            max_capacity=8192,
            _alphabet_sha256=alphabet_digest,
        )
        assert list(row.token_ids) == oracle["tokenIds"]
        assert list(row.free_mask) == oracle["freeMask"]
        assert row.P == sum(oracle["freeMask"]) > 0
    counts = Counter(
        decode_protocol_record(payload.decode())["kind"]
        for payload in targets.values()
        if payload.startswith(b"protocol ")
    )
    context_tokens = [len(codec.encode(payload)) for payload in contexts.values()]
    recomputed = {
        "logicalGeneratedTargets": len(targets),
        "physicalSelectedTargets": len(selected),
        "logicalContexts": len(contexts),
        "physicalContextParts": context_parts,
        "maxWholeContextTokens": max(context_tokens),
        "contextsOver8192Tokens": sum(n > 8192 for n in context_tokens),
        "criticalTargetCounts": dict(sorted(counts.items())),
        "packedWindows": len(windows),
        "maxPackedWindowTokens": max(window.D for window in windows),
        "totalScoredPositions": sum(row.P for row in selected),
    }
    for key, value in recomputed.items():
        assert value == evidence[key], key
    for key in (
        "allContextBytesReassembled",
        "allTargetBytesReassembled",
        "allContextDependenciesPreserved",
        "allPhysicalRecordsWithin8192Tokens",
    ):
        assert evidence[key] is True
    masks = [
        {
            "recordId": row.record.record_id,
            "tokenIds": list(row.token_ids),
            "freeMask": list(row.free_mask),
        }
        for row in selected
    ]
    mask_bytes = json.dumps(masks, sort_keys=True, separators=(",", ":")).encode()
    assert digest(mask_bytes) == evidence["selectedTokenAndMaskDigest"]
    args.output.mkdir(parents=True, exist_ok=True)
    (args.output / "selected-token-and-mask-receipt.json").write_bytes(mask_bytes)
    audit = {
        "schema": "semantic-v8-retained-composed-module-artifact-audit/1",
        "status": "passed",
        "executedRunId": 45023157562,
        "producerRevision": evidence["producerRevision"],
        "consumerRevision": evidence["consumerRevision"],
        "tests": tests,
        "recomputed": recomputed,
        "preparedPhysicalRecords": len(episode.records),
        "independentlyReconstructedPhysicalTargetMasks": len(selected),
        "observationRecordsWithZeroScoredPositions": len(encoded) - len(selected),
        "selectedTokenAndMaskDigest": digest(mask_bytes),
        "selectedTokenAndMaskBytes": len(mask_bytes),
        "artifactSha256": digest(artifact_bytes),
        "preparedManifestSha256": digest(manifest_bytes),
        "preparedReportSha256": digest(report_bytes),
        "preparedManifestFingerprint": manifest["fingerprint"],
        "tokenizerIdentity": codec.fingerprint,
        "tokenizerSha256": LING_TOKENIZER_SHA256,
        "optimizerUpdatesPerformedByAudit": 0,
        "optimizerUpdatesInHostedGate": 0,
        "sourceProducerRerunByAudit": False,
        "nativeAdmissionRerunByAudit": False,
        "productionPopulationChanged": False,
        "learnedSuccess": None,
        "scope": "Read-only recheck of exact hosted source/prepared bytes, canonical masks and native packing; original source execution/admission belongs to the retained hosted gate, and no model optimizer or decoder ran.",
        "elapsedSeconds": time.monotonic() - started,
    }
    (args.output / "retained-artifact-audit.json").write_text(
        json.dumps(audit, indent=2) + "\n"
    )
    print(json.dumps(audit, sort_keys=True))


if __name__ == "__main__":
    main()
