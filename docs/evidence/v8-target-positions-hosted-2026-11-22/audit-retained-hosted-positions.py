"""Independently reread an unchanged hosted support artifact, without training.

The original training configuration (including its original path identities)
remains intact. Only the explicit physical data reader and tokenizer load use
local artifact paths; no objective identity or receipt is rewritten.
"""

from __future__ import annotations

import argparse
import hashlib
import inspect
import json
import platform
import subprocess
import sys
from pathlib import Path


def read(path):
    return json.loads(path.read_bytes())


def file_identity(path):
    data = path.read_bytes()
    return {"bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--artifact-root", type=Path, required=True)
    parser.add_argument("--native-root", type=Path, required=True)
    parser.add_argument("--tokenizer", type=Path, required=True)
    parser.add_argument("--producer-revision", required=True)
    parser.add_argument("--optimizer-native-revision", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    native = args.native_root.resolve()
    if subprocess.check_output(
        ["git", "-C", str(native), "status", "--porcelain", "--untracked-files=no"],
        text=True,
    ):
        raise ValueError("Audit reader source has tracked changes")
    sys.path.insert(0, str(native / "src"))
    import torch
    from megatoken.data import PreparedCorpus
    from megatoken.data.semantic_json import stable_algorithm_hash
    from megatoken.generation.codec import LING_TOKENIZER_SHA256, ByteCodec
    from megatoken.loading import build_model, load_model_config
    from megatoken.training.checkpoint import load_checkpoint
    from megatoken.training.config import TrainConfig
    from megatoken.training.positions_v8 import (
        advance_position_exposure,
        compare_position_inventory,
        empty_position_exposure,
        independent_position_inventory,
        installed_modality_ids,
        position_exposure_report,
        qualify_position_history,
        restore_position_exposure,
    )
    from megatoken.training.semantic_v8 import validate_semantic_v8_target_exposure

    source = native / "src/megatoken/training/positions_v8.py"
    assert Path(inspect.getfile(independent_position_inventory)).resolve() == source
    artifact = args.artifact_root.resolve()
    prepared = artifact / "v8-support-prepared"
    lifecycle = artifact / "v8-support-lifecycle"
    command = read(lifecycle / "command-report.json")
    coverage = read(lifecycle / "target-coverage-evidence.json")
    supplied_inventory = read(lifecycle / "target-inventory.json")
    qualification = read(lifecycle / "qualification/summary.json")
    manifest = read(prepared / "manifest.json")
    registry = read(prepared / "semantic-v8-families.json")
    train_ids = sorted(
        identity
        for component in registry["components"]
        if component["split"] == "train"
        for identity in component["sourceIds"]
    )
    assert len(train_ids) == len(set(train_ids)) == 48
    assert command["status"] == "passed"
    assert command["producerRevision"] == args.producer_revision
    assert command["consumerRevision"] == args.optimizer_native_revision
    assert command["optimizerUpdateCounts"] == {
        "lifecycle": 2,
        "coverage": 348,
        "total": 350,
    }
    assert command["optimizerUpdates"] == 2
    assert command["targetCoverage"] == coverage
    assert (
        stable_algorithm_hash({k: v for k, v in coverage.items() if k != "digest"})
        == coverage["digest"]
    )
    assert coverage["inventory"]["digest"] == supplied_inventory["digest"]
    assert coverage["consumerRevision"] == args.optimizer_native_revision
    assert coverage["learnedSuccess"] is None

    def checkpoint(path):
        payload, metadata = load_checkpoint(path, map_location="cpu")
        assert file_identity(path / "state.pt")["sha256"] == metadata["state_sha256"]
        assert payload["global_step"] == metadata["global_step"]
        policy = payload["train_config"]["semantic_v8_policy"]
        assert policy["producerRevision"] == args.producer_revision
        assert policy["consumerRevision"] == args.optimizer_native_revision
        assert policy["registryDigest"] == registry["digest"]
        return payload, metadata

    latest = read(lifecycle / "fit-coverage/checkpoints/latest.json")
    full, full_metadata = checkpoint(
        lifecycle / "fit-coverage/checkpoints" / latest["checkpoint"]
    )
    first, first_metadata = checkpoint(lifecycle / "first-checkpoint")
    resumed, resumed_metadata = checkpoint(
        lifecycle / "fit/checkpoints/SE-000000002-periodic"
    )
    assert full["global_step"] == coverage["globalStep"] == 348
    assert first["global_step"] == 1 and resumed["global_step"] == 2
    assert full_metadata["state_sha256"] == coverage["checkpointStateSha256"]
    config = TrainConfig.from_dict(full["train_config"])
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
    # Construction checks the installed public modality support; no forward
    # pass, optimizer, model output or learned behavior is evaluated.
    model = build_model(
        model_config,
        codec,
        device="cpu",
        precision=config.precision,
        packs=config.packs,
    )
    modalities = installed_modality_ids(model)
    del model
    with PreparedCorpus([str(prepared)], split="train") as corpus:
        inventory = independent_position_inventory(
            (corpus.fetch(index)[0] for index in range(len(corpus))),
            codec=codec,
            config=config,
            model_config=model_config,
            modalities=modalities,
            prepared_manifest_fingerprint=manifest["fingerprint"],
            expected_source_ids=train_ids,
        )
    assert inventory == coverage["independentPreparedPositionInventory"]
    for payload, metadata in (
        (first, first_metadata),
        (resumed, resumed_metadata),
        (full, full_metadata),
    ):
        state = restore_position_exposure(
            payload,
            registry_digest=registry["digest"],
            objective=inventory["objective"],
            global_step=payload["global_step"],
            checkpoint_metadata=metadata,
        )
        assert state == payload["semantic_v8_position_exposure"]
    presence = validate_semantic_v8_target_exposure(
        full["semantic_v8_target_exposure"], registry_digest=registry["digest"]
    )
    comparison = compare_position_inventory(
        inventory,
        full["semantic_v8_position_exposure"],
        target_exposure=presence,
        global_step=348,
    )
    assert comparison == coverage["positionComparison"]
    assert comparison["exactOnePassPreparedTextPositions"] is True
    assert comparison["positiveWeightPositionCountsMatch"] is True
    assert (
        full["semantic_v8_position_exposure"] == coverage["optimizerPositionExposure"]
    )
    summary = position_exposure_report(full["semantic_v8_position_exposure"])
    assert summary == coverage["optimizerPositionSummary"]
    bounded = qualify_position_history(
        first,
        resumed,
        inventory=inventory,
        first_metadata=first_metadata,
        resumed_metadata=resumed_metadata,
    )
    assert (
        bounded == qualification["optimizerResumeExport"]["optimizerPositionExposure"]
    )
    assert bounded == command["optimizerPositionExposure"]
    assert bounded["fullPopulationQualified"] is False

    # Only the later frozen campaign captured these recorder-scoped counters.
    # Replaying their actual logged increments grants no text or optimizer credit.
    router_updates = 0
    if "routerInternalPositionCounts" in full["semantic_v8_position_exposure"]:
        for fit, expected_steps in (("fit", 2), ("fit-coverage", 348)):
            shadow = empty_position_exposure(
                registry_digest=registry["digest"], objective=inventory["objective"]
            )
            rows = [
                row
                for row in map(
                    json.loads,
                    (lifecycle / fit / "metrics.jsonl").read_text().splitlines(),
                )
                if row.get("event") == "train"
            ]
            assert [row["global_step"] for row in rows] == list(
                range(1, expected_steps + 1)
            )
            for row in rows:
                recorded = row["semantic_v8_position_exposure"]
                positions = recorded["routerInternalPositionCounts"]
                assignments = recorded["routerInternalAssignmentCounts"]
                shadow = advance_position_exposure(
                    shadow,
                    [],
                    registry_digest=registry["digest"],
                    objective=inventory["objective"],
                    optimizer_step=row["global_step"],
                    router_internal_positions={
                        key: value - shadow["routerInternalPositionCounts"].get(key, 0)
                        for key, value in positions.items()
                    },
                    router_internal_assignments={
                        key: value
                        - shadow["routerInternalAssignmentCounts"].get(key, 0)
                        for key, value in assignments.items()
                    },
                )
                assert shadow["routerInternalPositionCounts"] == positions
                assert shadow["routerInternalAssignmentCounts"] == assignments
                assert (
                    shadow["routerInternalPositionAuditUpdates"]
                    == recorded["routerInternalPositionAuditUpdates"]
                )
                router_updates += 1
        assert router_updates == 350
    report = {
        "schema": "semantic-v8-retained-hosted-position-revalidation/1",
        "status": "passed",
        "optimizerProducerRevision": args.producer_revision,
        "optimizerNativeRevision": args.optimizer_native_revision,
        "readerNativeLocalRevision": subprocess.check_output(
            ["git", "-C", str(native), "rev-parse", "HEAD"], text=True
        ).strip(),
        "readerNativeTree": subprocess.check_output(
            ["git", "-C", str(native), "rev-parse", "HEAD^{tree}"], text=True
        ).strip(),
        "readerPositionSource": file_identity(source),
        "auditScript": file_identity(Path(__file__)),
        "auditRuntime": {
            "python": platform.python_version(),
            "torch": str(torch.__version__),
        },
        "originalConfigurationAndReceiptBytesUnchanged": True,
        "optimizerUpdatesPerformedByAudit": 0,
        "decoderForwardPassesPerformedByAudit": 0,
        "retainedActualOptimizerUpdates": {
            "lifecycle": 2,
            "coverage": 348,
            "total": 350,
        },
        "independentPhysicalPreparedInventoryEqual": True,
        "fullPositionComparisonUnchanged": True,
        "boundedResumeComparisonUnchanged": True,
        "checkpointMetadataBindingsChecked": 3,
        "actualRouterUpdateDeltasValidated": router_updates,
        "completePositionSummary": summary,
        "boundedResumePositionSummary": bounded,
        "tokenOrMaskPositionCoverage": "complete-for-prepared-text",
        "routerInternalPositionCoverage": "unmeasured",
        "learnedSuccess": None,
        "scope": "Read-only independent prepared-data and recorded-position revalidation; original hosted optimizer/runtime identities remain distinct. Router counts, where present, cover only balance-recorder eligible routes.",
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2, allow_nan=False) + "\n")
    print(
        json.dumps(
            {
                key: report[key]
                for key in (
                    "status",
                    "optimizerNativeRevision",
                    "optimizerUpdatesPerformedByAudit",
                    "actualRouterUpdateDeltasValidated",
                )
            }
        )
    )


if __name__ == "__main__":
    main()
