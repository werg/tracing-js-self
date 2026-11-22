"""Revalidate the exact retained 314-update timeout without granting full coverage."""

import argparse
import hashlib
import inspect
import json
import platform
import subprocess
import sys
from pathlib import Path

PRODUCER = "9cf091e6ccc5add960ef0897576d0c391b199a65"
NATIVE = "1a69d9da3254b7568c831d12866a629c206cf4fe"


def read(path):
    return json.loads(path.read_bytes())


def identity(path):
    data = path.read_bytes()
    return {"bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--artifact-root", type=Path, required=True)
    parser.add_argument("--native-root", type=Path, required=True)
    parser.add_argument("--tokenizer", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    native = args.native_root.resolve()
    assert (
        subprocess.check_output(
            ["git", "-C", str(native), "rev-parse", "HEAD"], text=True
        ).strip()
        == NATIVE
    )
    assert not subprocess.check_output(
        ["git", "-C", str(native), "status", "--porcelain", "--untracked-files=no"],
        text=True,
    ).strip()
    sys.path.insert(0, str(native / "src"))
    import torch
    from megatoken.data import PreparedCorpus
    from megatoken.generation.codec import LING_TOKENIZER_SHA256, ByteCodec
    from megatoken.loading import build_model, load_model_config
    from megatoken.semantic_lineage_v8 import checkpoint_lineage_v8
    from megatoken.training.checkpoint import load_checkpoint
    from megatoken.training.config import TrainConfig
    from megatoken.training.positions_v8 import (
        compare_position_inventory,
        independent_position_inventory,
        installed_modality_ids,
        position_exposure_report,
        qualify_position_history,
        restore_position_exposure,
    )
    from megatoken.training.semantic_v8 import validate_semantic_v8_target_exposure

    position_source = native / "src/megatoken/training/positions_v8.py"
    assert (
        Path(inspect.getfile(independent_position_inventory)).resolve()
        == position_source
    )
    root = args.artifact_root.resolve()
    lifecycle, prepared = root / "v8-support-lifecycle", root / "v8-support-prepared"
    command = read(lifecycle / "command-report.json")
    assert (
        command["producerRevision"] == PRODUCER
        and command["consumerRevision"] == NATIVE
    )
    assert command["status"] == command["targetCoverageStatus"] == "failed"
    assert command["fullTargetCoverageRequested"] is True
    assert command["fullTargetCoverageQualified"] is False
    failed = command["stages"][-1]
    assert failed["stage"] == "train-full-target-window-pass"
    assert failed["error"] == "spawnSync python ETIMEDOUT"
    assert failed["durationMs"] >= 7_200_000
    assert not (lifecycle / "target-coverage-evidence.json").exists()
    registry = read(prepared / "semantic-v8-families.json")
    manifest = read(prepared / "manifest.json")
    source_ids = sorted(
        source_id
        for component in registry["components"]
        if component["split"] == "train"
        for source_id in component["sourceIds"]
    )
    assert len(source_ids) == len(set(source_ids)) == 48

    def checkpoint(path):
        payload, metadata = load_checkpoint(path, map_location="cpu")
        assert payload["global_step"] == metadata["global_step"]
        assert identity(path / "state.pt")["sha256"] == metadata["state_sha256"]
        policy = payload["train_config"]["semantic_v8_policy"]
        assert (
            policy["producerRevision"] == PRODUCER
            and policy["consumerRevision"] == NATIVE
        )
        assert policy["registryDigest"] == registry["digest"]
        lineage = checkpoint_lineage_v8(payload, metadata)
        assert lineage["preparedManifestFingerprints"] == [manifest["fingerprint"]]
        return payload, metadata

    latest = read(lifecycle / "fit-coverage/checkpoints/latest.json")
    assert latest["checkpoint"] == "SE-000000314-interrupted"
    partial, partial_meta = checkpoint(
        lifecycle / "fit-coverage/checkpoints" / latest["checkpoint"]
    )
    first, first_meta = checkpoint(lifecycle / "first-checkpoint")
    resumed, resumed_meta = checkpoint(
        lifecycle / "fit/checkpoints/SE-000000002-periodic"
    )
    assert [p["global_step"] for p in (first, resumed, partial)] == [1, 2, 314]
    config = TrainConfig.from_dict(partial["train_config"])
    model_config = load_model_config(
        config.model,
        **{
            **config.model_overrides,
            "expert_backend": config.expert_backend,
            "checkpoint_stages": config.gradient_checkpointing,
        },
    )
    codec = ByteCodec.from_tokenizer_json(
        args.tokenizer, expected_sha256=LING_TOKENIZER_SHA256
    )
    assert codec.fingerprint == manifest["codec_fingerprint"]
    model = build_model(
        model_config, codec, device="cpu", precision=config.precision, packs=None
    )
    modalities = installed_modality_ids(model)
    del model
    with PreparedCorpus([str(prepared)], split="train") as corpus:
        inventory = independent_position_inventory(
            corpus.iter_episodes(),
            codec=codec,
            config=config,
            model_config=model_config,
            modalities=modalities,
            prepared_manifest_fingerprint=manifest["fingerprint"],
            expected_source_ids=source_ids,
        )
    assert inventory["logicalTargetCount"] == 696
    assert inventory["physicalTargetRecordCount"] == 720
    for payload, metadata in (
        (first, first_meta),
        (resumed, resumed_meta),
        (partial, partial_meta),
    ):
        state = restore_position_exposure(
            payload,
            registry_digest=registry["digest"],
            objective=inventory["objective"],
            global_step=payload["global_step"],
        )
        assert state == payload["semantic_v8_position_exposure"]
        # Exact 1a reader predates the later checkpoint_metadata argument.
        # Verify the actual committed metadata binding explicitly, unchanged.
        assert metadata["semantic_v8_position_digest"] == state["digest"]
    target = validate_semantic_v8_target_exposure(
        partial["semantic_v8_target_exposure"], registry_digest=registry["digest"]
    )
    comparison = compare_position_inventory(
        inventory,
        partial["semantic_v8_position_exposure"],
        target_exposure=target,
        global_step=314,
    )
    assert comparison["exactOnePassPreparedTextPositions"] is False
    assert comparison["positiveWeightPositionCountsMatch"] is False
    assert len(comparison["missingPhysicalTargets"]) == 70
    for name in (
        "unexpectedPhysicalTargets",
        "preparedOracleMismatches",
        "independentOccurrenceMismatches",
        "targetCensusWindowOrOccurrenceMismatches",
        "targetCensusWithoutPositionReceipt",
        "unmeasuredPhysicalTargets",
    ):
        assert comparison[name] == [], name
    summary = position_exposure_report(partial["semantic_v8_position_exposure"])
    assert (
        summary["sourceCount"],
        summary["logicalTargetCount"],
        summary["physicalTargetRecordCount"],
    ) == (44, 628, 650)
    rows = list(
        map(
            json.loads,
            (lifecycle / "fit-coverage/metrics.jsonl").read_text().splitlines(),
        )
    )
    updates = [row for row in rows if row.get("event") == "train"]
    assert [row["global_step"] for row in updates] == list(range(1, 315))
    assert rows[-1]["event"] == "finished" and rows[-1]["termination"] == "requested"
    assert rows[-1]["global_step"] == 314
    assert rows[-1]["semantic_v8_position_exposure"] == summary
    bounded = qualify_position_history(
        first,
        resumed,
        inventory=inventory,
        first_metadata=first_meta,
        resumed_metadata=resumed_meta,
    )
    qualification = read(lifecycle / "qualification/summary.json")
    assert (
        bounded == qualification["optimizerResumeExport"]["optimizerPositionExposure"]
    )
    assert bounded == command["optimizerPositionExposure"]
    assert bounded["fullPopulationQualified"] is False
    result = {
        "schema": "semantic-v8-interrupted-position-revalidation/1",
        "status": "partial-consistency-passed-full-coverage-failed",
        "campaignStatus": "failed-finite-training-timeout",
        "optimizerProducerRevision": PRODUCER,
        "optimizerNativeRevision": NATIVE,
        "readerNativeRevision": NATIVE,
        "readerPositionSource": identity(position_source),
        "auditScript": identity(Path(__file__)),
        "auditRuntime": {
            "python": platform.python_version(),
            "torch": str(torch.__version__),
        },
        "checkpointStateSha256": partial_meta["state_sha256"],
        "observedOptimizerUpdates": {
            "lifecycle": 2,
            "interruptedCoverage": 314,
            "total": 316,
        },
        "requiredCoverageUpdates": 348,
        "remainingCoverageUpdates": 34,
        "commandReportUpdateCountsUnchanged": command["optimizerUpdateCounts"],
        "checkpointMetadataBindingsChecked": 3,
        "independentPreparedInventoryDigest": inventory["digest"],
        "independentPreparedExpectedPositionCounts": inventory[
            "positiveWeightPositionCounts"
        ],
        "positionSummary": summary,
        "positionComparison": comparison,
        "boundedResumePositionSummary": bounded,
        "fullTargetCoverageQualified": False,
        "tokenOrMaskPositionCoverage": "partial-only",
        "routerInternalPositionCoverage": "unmeasured",
        "learnedSuccess": None,
        "optimizerUpdatesPerformedByAudit": 0,
        "decoderForwardPassesPerformedByAudit": 0,
        "originalConfigurationAndReceiptBytesUnchanged": True,
        "scope": "Original finite failed attempt retained. Its actual314-update checkpoint is internally consistent with independently reconstructed prepared positions but is70physical targets and34required updates short; separate2-update lifecycle passed. No replacement run, source change or completed full-pass credit.",
    }
    args.output.write_text(json.dumps(result, indent=2, allow_nan=False) + "\n")
    print(
        json.dumps(
            {
                "status": result["status"],
                "coverageUpdates": 314,
                "missingPhysicalTargets": 70,
            }
        )
    )


if __name__ == "__main__":
    main()
