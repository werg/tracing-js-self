"""Recheck campaign 45023684906 using its original pre-router-audit schema.

This preserves the original checkpoint and independently reconstructs its
prepared text positions. The native 1a69 runtime predates router count fields;
the strict 622c reader rejection is recorded separately and no router counts
are inferred or inserted into the old receipt.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import os
import platform
import subprocess
import sys
import tempfile
from pathlib import Path

import torch


def read(path: Path):
    return json.loads(path.read_bytes())


def sha256(path: Path):
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def require(value, message):
    if not value:
        raise ValueError(message)


def position_summaries(metrics_path, expected_updates, final_report, final_target_report):
    rows = [json.loads(line) for line in metrics_path.read_text().splitlines() if line.strip()]
    training = [row for row in rows if row.get("event") == "train"]
    require(len(training) == expected_updates, "optimizer metrics omit or add an update")
    previous = None
    target_totals_before = {
        "sourceCount": 0,
        "logicalTargetCount": 0,
        "physicalTargetRecordCount": 0,
        "scoredOccurrences": 0,
        "lossDenominators": {},
    }
    for step, row in enumerate(training, 1):
        require(row.get("global_step") == step, "optimizer metrics have a step gap")
        summary = row.get("semantic_v8_position_exposure")
        require(isinstance(summary, dict) and summary.get("lastGlobalStep") == step and
                summary.get("optimizerUpdates") == step and summary.get("startingGlobalStep") == 0 and
                summary.get("previousStageDigest") is None and
                summary.get("routerInternalPositionCoverage") == "unmeasured",
                "legacy position summary differs from the fresh full-fit step")
        digest = summary.get("digest")
        require(isinstance(digest, str) and len(digest) == 64 and
                all(character in "0123456789abcdef" for character in digest),
                "legacy position summary digest is malformed")
        for name in ("sourceCount", "logicalTargetCount", "physicalTargetRecordCount",
                     "verifiedPhysicalTargets", "unmeasuredPhysicalTargets", "scoredOccurrences"):
            require(type(summary.get(name)) is int and summary[name] >= 0,
                    "legacy position summary contains an invalid cumulative count")
        positions = summary.get("positiveWeightPositionCounts")
        require(isinstance(positions, dict) and positions and
                all(isinstance(name, str) and type(value) is int and value >= 0
                    for name, value in positions.items()),
                "legacy position summary has invalid positive-weight counts")
        unmeasured = summary.get("unmeasuredObjectiveCounts")
        require(isinstance(unmeasured, dict) and
                all(isinstance(name, str) and type(value) is int and value >= 0
                    for name, value in unmeasured.items()),
                "legacy position summary has invalid unmeasured objective counts")
        require("routerInternalPositionCounts" not in summary and
                "routerInternalAssignmentCounts" not in summary and
                "routerInternalPositionAuditUpdates" not in summary,
                "legacy runtime unexpectedly emitted router audit fields")
        if previous is not None:
            require(summary["digest"] != previous["digest"],
                    "legacy position summary digest did not advance")
            for name in ("sourceCount", "logicalTargetCount", "physicalTargetRecordCount",
                         "verifiedPhysicalTargets", "unmeasuredPhysicalTargets", "scoredOccurrences"):
                require(summary[name] >= previous[name], "legacy position totals decreased")
            for name in positions:
                require(name in previous["positiveWeightPositionCounts"] and
                        positions[name] >= previous["positiveWeightPositionCounts"][name],
                        "legacy position objective count decreased")
            require(all(unmeasured.get(name, 0) >= count
                        for name, count in previous["unmeasuredObjectiveCounts"].items()),
                    "legacy unmeasured objective count decreased")

        step_target = row.get("semantic_v8_target_exposure_step")
        target_totals = row.get("semantic_v8_target_exposure_totals")
        require(isinstance(step_target, dict) and isinstance(target_totals, dict),
                "optimizer metrics omit target summary fields")
        integer_fields = ("sourceCount", "logicalTargetCount", "physicalTargetRecordCount", "scoredOccurrences")
        require(all(type(step_target.get(name)) is int and step_target[name] >= 0
                    for name in integer_fields) and
                all(type(target_totals.get(name)) is int and target_totals[name] >= 0
                    for name in integer_fields),
                "target summary contains an invalid count")
        require(all(target_totals[name] >= target_totals_before[name] for name in integer_fields),
                "cumulative target summary decreased")
        require(target_totals["scoredOccurrences"] - target_totals_before["scoredOccurrences"] ==
                step_target["scoredOccurrences"],
                "per-update target occurrences differ from cumulative totals")
        step_denominators = step_target.get("lossDenominators")
        total_denominators = target_totals.get("lossDenominators")
        require(isinstance(step_denominators, dict) and isinstance(total_denominators, dict) and
                all(isinstance(name, str) and type(value) is int and value >= 0
                    for name, value in step_denominators.items()) and
                all(isinstance(name, str) and type(value) is int and value >= 0
                    for name, value in total_denominators.items()),
                "target summary loss denominators are malformed")
        names = set(target_totals_before["lossDenominators"]) | set(step_denominators) | set(total_denominators)
        require(all(total_denominators.get(name, 0) -
                    target_totals_before["lossDenominators"].get(name, 0) ==
                    step_denominators.get(name, 0) for name in names),
                "per-update target denominators differ from cumulative totals")
        target_totals_before = {
            **{name: target_totals[name] for name in integer_fields},
            "lossDenominators": dict(total_denominators),
        }
        previous = summary
    require(previous == final_report, "legacy metric summaries do not end at the unchanged final state")
    require(target_totals_before == final_target_report,
            "per-update target summaries do not match final target receipts")
    return {"optimizerMetricRows": len(training), "targetSummaryRows": len(training),
            "fullReceiptsAvailableInMetrics": False}


def strict_reader_rejection(strict_root, checkpoint_path, registry_digest, objective, step):
    script = r'''
import json, sys
from pathlib import Path
sys.path.insert(0, sys.argv[1] + "/src")
from megatoken.training.checkpoint import load_checkpoint
from megatoken.training.positions_v8 import validate_position_exposure
payload, metadata = load_checkpoint(Path(sys.argv[2]), map_location="cpu")
objective = json.loads(Path(sys.argv[3]).read_text())
registry_digest = sys.argv[4]
step = int(sys.argv[5])
try:
    validate_position_exposure(payload["semantic_v8_position_exposure"],
                               registry_digest=registry_digest, objective=objective)
except ValueError as error:
    print(json.dumps({"status":"rejected-legacy-schema", "reason":str(error)}))
else:
    print(json.dumps({"status":"accepted"}))
'''
    with tempfile.TemporaryDirectory(prefix="v8-legacy-reader-") as temporary:
        objective_path = Path(temporary) / "objective.json"
        objective_path.write_text(json.dumps(objective))
        environment = dict(os.environ)
        environment["PYTHONPATH"] = str(strict_root / "src")
        result = subprocess.run(
            [sys.executable, "-c", script, str(strict_root), str(checkpoint_path),
             str(objective_path), registry_digest, str(step)],
            check=True,
            capture_output=True,
            text=True,
            env=environment,
        )
        return json.loads(result.stdout)


def revalidate(args):
    original = args.original_consumer_root.resolve(strict=True)
    strict = args.strict_reader_root.resolve(strict=True)
    sys.path.insert(0, str(original / "scripts"))
    sys.path.insert(1, str(original / "src"))

    from megatoken.data.semantic_json import stable_algorithm_hash
    from megatoken.loading import load_model_config
    from megatoken.training.checkpoint import load_checkpoint
    from megatoken.training.config import TrainConfig
    from megatoken.training.positions_v8 import (
        compare_position_inventory,
        position_exposure_report,
        qualify_position_history,
        restore_position_exposure,
    )
    from megatoken.training.semantic_v8 import (
        load_semantic_v8_codec,
        semantic_v8_target_exposure_report,
        validate_semantic_v8_target_exposure,
    )
    from megatoken.training.target_inventory_v8 import compare_target_inventory
    from qualify_semantic_v8_target_coverage import prepared_position_inventory
    from qualify_semantic_v8_target_inventory import target_inventory

    root = args.artifact_root.resolve(strict=True)
    lifecycle = root / "v8-support-lifecycle"
    prepared = root / "v8-support-prepared"
    tokenizer = lifecycle / "served" / "tokenizer.json"
    source_inventory_path = root / "v8-support-source-ids.json"
    supplied_inventory_path = lifecycle / "target-inventory.json"
    supplied_coverage_path = lifecycle / "target-coverage-evidence.json"
    coverage = read(supplied_coverage_path)
    supplied = read(supplied_inventory_path)
    source_population = read(source_inventory_path)
    command = read(lifecycle / "command-report.json")
    summary = read(lifecycle / "qualification" / "summary.json")
    require(command.get("status") == "passed" and
            command.get("fullTargetCoverageQualified") is True and
            command.get("targetCoverageStatus") == "passed",
            "original ordinary lifecycle did not complete its full target pass")
    require(command.get("learnedSuccess") is None and coverage.get("learnedSuccess") is None,
            "target coverage evidence made a learned-quality claim")

    latest = read(lifecycle / "fit-coverage" / "checkpoints" / "latest.json")
    coverage_checkpoint_path = lifecycle / "fit-coverage" / "checkpoints" / latest["checkpoint"]
    coverage_payload, coverage_metadata = load_checkpoint(coverage_checkpoint_path, map_location="cpu")
    raw_config = coverage_payload["train_config"]
    config = TrainConfig.from_dict(raw_config)
    policy = config.semantic_v8_policy
    require(policy is not None, "coverage checkpoint has no V8 policy")
    producer_revision = policy["producerRevision"]
    optimizer_revision = policy["consumerRevision"]
    require(producer_revision == args.producer_revision and optimizer_revision == args.optimizer_revision,
            "original training identities differ from frozen campaign revisions")
    require(command.get("producerRevision") == producer_revision and
            command.get("consumerRevision") == optimizer_revision,
            "command report changed original producer or native identities")
    registry_digest = policy["registryDigest"]
    manifest = read(prepared / "manifest.json")
    registry = read(prepared / "semantic-v8-families.json")
    source_ids = source_population.get("sourceIds")
    require(source_population.get("schema") == "semantic-v8-source-population/1" and
            source_population.get("registryDigest") == registry_digest and
            isinstance(source_ids, list) and len(source_ids) == 64 and len(set(source_ids)) == 64 and
            registry.get("digest") == registry_digest,
            "exact frozen 64-source population or registry changed")
    split_ids = {
        split: sorted({source_id for component in registry.get("components", [])
                       if component.get("split") == split for source_id in component.get("sourceIds", [])})
        for split in ("train", "validation", "test")
    }
    registry_ids = [source["id"] for source in registry.get("sources", [])]
    require(len(registry_ids) == 64 and len(set(registry_ids)) == 64 and
            set(registry_ids) == set(source_ids) and
            {split: len(ids) for split, ids in split_ids.items()} ==
            {"train": 48, "validation": 12, "test": 4} and
            set().union(*map(set, split_ids.values())) == set(source_ids),
            "frozen source split is not exactly 48/12/4")
    train_ids = split_ids["train"]
    require(supplied.get("sourceIds") == train_ids and supplied.get("scoredSourceIds") == train_ids,
            "target inventory differs from the exact 48-source training split")

    model_config = load_model_config(
        config.model,
        **{
            **config.model_overrides,
            "expert_backend": config.expert_backend,
            "checkpoint_stages": config.gradient_checkpointing,
        },
    )
    codec = load_semantic_v8_codec(str(tokenizer), vocab_size=model_config.vocab_size)
    require(codec.fingerprint == supplied.get("codecFingerprint"),
            "retained tokenizer differs from original target inventory")
    relocated = copy.deepcopy(raw_config)
    relocated["datasets"] = [str(prepared)]
    relocated["codec"] = str(tokenizer)
    derived = target_inventory(relocated, source_inventory_path)
    original_identity = {**__import__("dataclasses").asdict(config)}
    for name in ("output", "max_steps", "checkpoint_every", "keep_checkpoints", "log_every", "device"):
        original_identity.pop(name, None)
    original_config_digest = stable_algorithm_hash(original_identity)
    require(supplied.get("trainingConfigDigest") == original_config_digest,
            "original path-bearing config digest changed")
    normalized = dict(derived)
    normalized.pop("digest", None)
    normalized["trainingConfigDigest"] = original_config_digest
    normalized["digest"] = stable_algorithm_hash(normalized)
    require(normalized == supplied, "original target inventory failed independent re-derivation")

    position_inventory = prepared_position_inventory(
        {**raw_config, "datasets": [str(prepared)], "codec": str(tokenizer)},
        source_ids=train_ids,
        prepared_manifest_fingerprint=manifest["fingerprint"],
    )
    require(position_inventory == coverage.get("independentPreparedPositionInventory"),
            "independent prepared text position, labels or masks changed")
    state = restore_position_exposure(
        coverage_payload,
        registry_digest=registry_digest,
        objective=position_inventory["objective"],
        global_step=coverage_payload["global_step"],
    )
    require(coverage_metadata.get("semantic_v8_position_digest") == state["digest"],
            "original checkpoint metadata does not bind the position history")
    target_state = validate_semantic_v8_target_exposure(
        coverage_payload.get("semantic_v8_target_exposure"), registry_digest=registry_digest
    )
    target_comparison = compare_target_inventory(
        supplied,
        target_state["sources"],
        rederived_inventory=normalized,
        registry_digest=registry_digest,
        prepared_manifest_fingerprint=manifest["fingerprint"],
        codec_fingerprint=codec.fingerprint,
        training_config_digest=original_config_digest,
        model_config_digest=normalized["modelConfigDigest"],
    )
    require(target_comparison == coverage.get("comparison") and
            target_comparison.get("exactOnePassCensus") is True,
            "original exact one-pass target comparison changed")
    position_comparison = compare_position_inventory(
        position_inventory,
        state,
        target_exposure=target_state,
        global_step=coverage_payload["global_step"],
    )
    require(position_comparison == coverage.get("positionComparison") and
            position_comparison.get("exactOnePassPreparedTextPositions") is True and
            position_comparison.get("positiveWeightPositionCountsMatch") is True,
            "original exact prepared text position/mask comparison changed")
    updates = supplied["optimizerWindowCount"]
    require(coverage_payload["global_step"] == updates == coverage.get("globalStep"),
            "original coverage checkpoint differs from the exact one-pass update count")
    require(not any(key.startswith("routerInternal") for key in state) and
            position_comparison.get("routerInternalPositionCoverage") == "unmeasured",
            "legacy position state fabricated router count evidence")

    first_payload, first_metadata = load_checkpoint(lifecycle / "first-checkpoint", map_location="cpu")
    resume_path = lifecycle / "fit" / "checkpoints" / "SE-000000002-periodic"
    resumed_payload, resumed_metadata = load_checkpoint(resume_path, map_location="cpu")
    require(first_payload["global_step"] == 1 and resumed_payload["global_step"] == 2,
            "ordinary lifecycle did not retain its separate 1-to-2 resume boundary")
    resume_history = qualify_position_history(
        first_payload,
        resumed_payload,
        inventory=position_inventory,
        first_metadata=first_metadata,
        resumed_metadata=resumed_metadata,
    )
    resume_summary = summary["optimizerResumeExport"]["optimizerPositionExposure"]
    require(resume_summary.get("historyContinued") is True and
            resume_summary.get("fullPopulationQualified") is False and
            resume_summary.get("routerInternalPositionCoverage") == "unmeasured",
            "two-update lifecycle summary changed its partial evidence scope")

    strict_revision = subprocess.check_output(
        ["git", "-C", str(strict), "rev-parse", "HEAD"], text=True
    ).strip()
    strict_parent = subprocess.check_output(
        ["git", "-C", str(strict), "rev-parse", "HEAD^"], text=True
    ).strip()
    original_revision = subprocess.check_output(
        ["git", "-C", str(original), "rev-parse", "HEAD"], text=True
    ).strip()
    original_parent = subprocess.check_output(
        ["git", "-C", str(original), "rev-parse", "HEAD^"], text=True
    ).strip()
    require(original_revision == args.optimizer_revision,
            "original source tree differs from the campaign optimizer revision")
    require(strict_revision == args.strict_reader_revision and strict_parent == args.strict_reader_parent,
            "strict reader source pair differs from the separately recorded revision")
    strict_rejection = strict_reader_rejection(
        strict,
        coverage_checkpoint_path,
        registry_digest,
        position_inventory["objective"],
        coverage_payload["global_step"],
    )
    require(strict_rejection.get("status") == "rejected-legacy-schema",
            "strict reader unexpectedly accepted the legacy checkpoint schema")

    report = {
        "schema": "semantic-v8-legacy-router-schema-fullfit-revalidation/1",
        "status": "passed",
        "campaign": {
            "runId": args.run_id,
            "jobId": args.job_id,
            "artifactId": args.artifact_id,
            "artifactName": args.artifact_name,
            "artifactZipBytes": args.artifact_bytes,
            "artifactZipSha256": args.artifact_sha256,
            "originalProducerRevision": producer_revision,
            "originalNativeOptimizerRevision": optimizer_revision,
        },
        "originalReader": {"revision": original_revision, "parentRevision": original_parent,
                           "python": platform.python_version(), "torch": str(torch.__version__),
                           "sourceMap": {
                               relative: sha256(original / relative)
                               for relative in ("scripts/qualify_semantic_v8_target_coverage.py",
                                                "scripts/qualify_semantic_v8_target_inventory.py",
                                                "src/megatoken/training/positions_v8.py",
                                                "src/megatoken/training/target_inventory_v8.py")
                           }},
        "strictReader": {"revision": strict_revision, "parentRevision": strict_parent,
                         "assessment": strict_rejection},
        "optimizerUpdatesPerformedByAudit": 0,
        "sourcePopulation": {"allSourceCount": len(source_ids), "trainingSourceCount": len(train_ids),
                             "splitSourceIds": split_ids,
                             "sourcePopulationDigest": stable_algorithm_hash(source_population)},
        "independentTrajectories": {
            "ordinaryLifecycle": {"optimizerUpdates": 2, "firstGlobalStep": 1, "resumedGlobalStep": 2,
                                  "fullPopulationQualified": False},
            "separateFullCoverage": {"optimizerUpdates": updates,
                                     "startingGlobalStep": state["startingGlobalStep"],
                                     "lastGlobalStep": state["lastGlobalStep"]},
            "combinedUpdateCountIsOneTrajectory": False,
        },
        "targetInventory": {"digest": supplied["digest"],
                            "physicalTargetRecordCount": supplied["positiveWeight"]["physicalTargetRecordCount"],
                            "logicalTargetCount": supplied["positiveWeight"]["logicalTargetCount"],
                            "lossDenominators": supplied["positiveWeight"]["lossDenominators"],
                            "trainingConfigPathRelocationOnly": True},
        "preparedTextPositionAudit": {
            "independentPositionInventoryDigest": position_inventory["digest"],
            "positionComparisonDigest": stable_algorithm_hash(coverage["positionComparison"]),
            "exactOnePassPreparedTextPositions": position_comparison["exactOnePassPreparedTextPositions"],
            "positiveWeightPositionCounts": position_exposure_report(state)["positiveWeightPositionCounts"],
            "perUpdatePositionSummariesRevalidated": position_summaries(
                lifecycle / "fit-coverage" / "metrics.jsonl", updates,
                position_exposure_report(state),
                {key: semantic_v8_target_exposure_report(target_state)[key] for key in (
                    "sourceCount", "logicalTargetCount", "physicalTargetRecordCount",
                    "scoredOccurrences", "lossDenominators")},
            ),
            "perUpdateFullReceiptsAvailableInMetrics": False,
            "routerPositionCoverage": "unmeasured",
            "routerCountAuditAvailableInOriginalSchema": False,
        },
        "resumeReceipts": {"firstPositionDigest": first_payload["semantic_v8_position_exposure"]["digest"],
                           "resumedPositionDigest": resumed_payload["semantic_v8_position_exposure"]["digest"],
                           "strictHistoryComparison": resume_history,
                           "summaryPositionReportUnchanged": True},
        "originalHashes": {
            str(path.relative_to(root)): sha256(path)
            for path in (
                supplied_inventory_path, supplied_coverage_path, lifecycle / "command-report.json",
                lifecycle / "coverage-training-config.json", lifecycle / "training-config.json",
                lifecycle / "qualification" / "summary.json", lifecycle / "fit-coverage" / "metrics.jsonl",
                lifecycle / "fit" / "metrics.jsonl", source_inventory_path,
                coverage_checkpoint_path / "metadata.json", coverage_checkpoint_path / "state.pt",
                lifecycle / "first-checkpoint" / "metadata.json", lifecycle / "first-checkpoint" / "state.pt",
                resume_path / "metadata.json", resume_path / "state.pt", prepared / "manifest.json", tokenizer,
            )
        },
        "learnedSuccess": None,
        "scope": "Original pre-router-audit checkpoint schema revalidated for exact target census, prepared text positions, labels and masks. Router counters were absent in the original runtime and remain unavailable. Current strict-reader rejection is recorded without adding fields to saved state.",
    }
    report["strictReader"]["sourceMap"] = {
        relative: sha256(strict / relative)
        for relative in ("scripts/qualify_semantic_v8_target_coverage.py",
                         "src/megatoken/training/positions_v8.py",
                         "src/megatoken/training/target_inventory_v8.py")
    }
    report["auditScriptSha256"] = sha256(Path(__file__).resolve())
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--artifact-root", type=Path, required=True)
    parser.add_argument("--original-consumer-root", type=Path, required=True)
    parser.add_argument("--strict-reader-root", type=Path, required=True)
    parser.add_argument("--producer-revision", required=True)
    parser.add_argument("--optimizer-revision", required=True)
    parser.add_argument("--strict-reader-revision", required=True)
    parser.add_argument("--strict-reader-parent", required=True)
    parser.add_argument("--run-id", type=int, required=True)
    parser.add_argument("--job-id", type=int, required=True)
    parser.add_argument("--artifact-id", type=int, required=True)
    parser.add_argument("--artifact-name", required=True)
    parser.add_argument("--artifact-bytes", type=int, required=True)
    parser.add_argument("--artifact-sha256", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    result = revalidate(args)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2, sort_keys=True) + "\n")
    print(json.dumps(result, sort_keys=True))


if __name__ == "__main__":
    main()
