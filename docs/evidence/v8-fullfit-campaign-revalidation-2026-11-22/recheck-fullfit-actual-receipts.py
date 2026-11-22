"""Read-only revalidation of a retained exact64 full-fit artifact.

This checks a completed artifact with a stricter native position reader. It
loads existing checkpoints and prepared inputs but performs no optimizer
updates, source admission, tokenizer download, or service execution. Input paths
are relocated in memory; original path-bearing config bytes and their objective
identity remain unchanged.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import platform
import subprocess
import sys
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


def training_config_digest(raw, TrainConfig, asdict, stable_algorithm_hash):
    identity = asdict(TrainConfig.from_dict(raw))
    for key in (
        "output",
        "max_steps",
        "checkpoint_every",
        "keep_checkpoints",
        "log_every",
        "device",
    ):
        identity.pop(key, None)
    return stable_algorithm_hash(identity)


def position_history(metrics_path, expected_updates, final_position_report, final_target_report):
    rows = [
        json.loads(line)
        for line in metrics_path.read_text().splitlines()
        if line.strip()
    ]
    training = [row for row in rows if row.get("event") == "train"]
    require(len(training) == expected_updates, "optimizer metrics omit or add an update")
    previous_position = None
    router_updates = 0
    previous_target_totals = {
        "sourceCount": 0,
        "logicalTargetCount": 0,
        "physicalTargetRecordCount": 0,
        "scoredOccurrences": 0,
        "lossDenominators": {},
    }
    for expected_step, row in enumerate(training, 1):
        require(row.get("global_step") == expected_step, "optimizer metrics have a step gap")
        position = row.get("semantic_v8_position_exposure")
        require(isinstance(position, dict), "optimizer metrics omit position exposure summaries")
        cumulative_fields = (
            "sourceCount",
            "logicalTargetCount",
            "physicalTargetRecordCount",
            "verifiedPhysicalTargets",
            "unmeasuredPhysicalTargets",
            "scoredOccurrences",
        )
        require(all(type(position.get(field)) is int and position[field] >= 0
                    for field in cumulative_fields),
                "position summary contains invalid cumulative target counts")
        require(position.get("lastGlobalStep") == expected_step and
                position.get("optimizerUpdates") == expected_step and
                position.get("startingGlobalStep") == 0 and
                position.get("previousStageDigest") is None,
                "position summary step differs from the fresh full-fit trajectory")
        digest = position.get("digest")
        require(isinstance(digest, str) and len(digest) == 64 and
                all(character in "0123456789abcdef" for character in digest),
                "position summary digest is malformed")
        router_positions = position.get("routerInternalPositionCounts")
        router_assignments = position.get("routerInternalAssignmentCounts")
        require(position.get("routerInternalPositionAccounting") == "complete-per-update" and
                position.get("routerInternalPositionCoverage") == "unmeasured" and
                position.get("routerInternalPositionAuditUpdates") == expected_step and
                isinstance(router_positions, dict) and isinstance(router_assignments, dict) and
                set(router_positions) == set(router_assignments) and
                all(type(count) is int and count >= 0 for count in router_positions.values()) and
                all(type(count) is int and count >= 0 for count in router_assignments.values()) and
                sum(router_positions.values()) == position.get("routerInternalPositionCount") and
                sum(router_assignments.values()) == position.get("routerInternalAssignmentCount"),
                "actual router position or assignment summary is incomplete or malformed")
        require(position.get("positiveWeightPositionCounts") and
                all(type(count) is int and count >= 0
                    for count in position["positiveWeightPositionCounts"].values()),
                "position summary lacks nonnegative positive-weight counts")
        unmeasured_counts = position.get("unmeasuredObjectiveCounts")
        require(isinstance(unmeasured_counts, dict) and
                all(isinstance(name, str) and type(count) is int and count >= 0
                    for name, count in unmeasured_counts.items()),
                "position summary has malformed unmeasured objective counts")
        if previous_position is not None:
            require(position["digest"] != previous_position["digest"],
                    "position summary digest did not change after an optimizer update")
            for field in cumulative_fields:
                require(position[field] >= previous_position[field],
                        "position summary cumulative target counts decreased")
            for field in ("positiveWeightPositionCounts", "routerInternalPositionCounts",
                          "routerInternalAssignmentCounts"):
                old_counts = previous_position[field]
                new_counts = position[field]
                require(set(new_counts) == set(old_counts) and
                        all(new_counts[name] >= value for name, value in old_counts.items()),
                        "position summary cumulative count map dropped a selector or objective")
            require(all(position["unmeasuredObjectiveCounts"].get(name, 0) >= value
                        for name, value in previous_position["unmeasuredObjectiveCounts"].items()),
                    "unmeasured objective counts decreased")
            for name, count in previous_position["routerInternalPositionCounts"].items():
                position_delta = router_positions[name] - count
                assignment_delta = router_assignments[name] - previous_position[
                    "routerInternalAssignmentCounts"
                ][name]
                require(position_delta >= 0 and assignment_delta >= position_delta and
                        (position_delta > 0 or assignment_delta == 0),
                        "router summaries contain an impossible per-update count delta")
        # The native trainer logs target step summaries and cumulative totals,
        # not a full target receipt at every step. Validate the actual wire
        # fields: unique-target totals are monotone, while occurrence and loss
        # denominators advance by the current step's additive summary.
        step_targets = row.get("semantic_v8_target_exposure_step")
        target_totals = row.get("semantic_v8_target_exposure_totals")
        require(isinstance(step_targets, dict) and isinstance(target_totals, dict),
                "optimizer metrics omit target step or cumulative summaries")
        summary_fields = (
            "sourceCount",
            "logicalTargetCount",
            "physicalTargetRecordCount",
            "scoredOccurrences",
        )
        require(all(type(step_targets.get(key)) is int and step_targets[key] >= 0
                    for key in summary_fields) and
                all(type(target_totals.get(key)) is int and target_totals[key] >= 0
                    for key in summary_fields),
                "optimizer target summaries contain invalid counts")
        require(all(target_totals[key] >= previous_target_totals[key] for key in summary_fields),
                "optimizer target cumulative totals decreased")
        require(step_targets["sourceCount"] <= target_totals["sourceCount"] and
                step_targets["logicalTargetCount"] <= target_totals["logicalTargetCount"] and
                step_targets["physicalTargetRecordCount"] <= target_totals["physicalTargetRecordCount"],
                "per-update target summary exceeds cumulative target coverage")
        step_denominators = step_targets.get("lossDenominators")
        total_denominators = target_totals.get("lossDenominators")
        require(isinstance(step_denominators, dict) and isinstance(total_denominators, dict) and
                all(isinstance(name, str) and type(count) is int and count >= 0
                    for name, count in step_denominators.items()) and
                all(isinstance(name, str) and type(count) is int and count >= 0
                    for name, count in total_denominators.items()),
                "optimizer target summaries contain invalid loss denominators")
        require(target_totals["scoredOccurrences"] - previous_target_totals["scoredOccurrences"] ==
                step_targets["scoredOccurrences"],
                "per-update target occurrence summary differs from cumulative totals")
        denominator_names = set(previous_target_totals["lossDenominators"]) | set(step_denominators) | set(total_denominators)
        require(all(total_denominators.get(name, 0) -
                    previous_target_totals["lossDenominators"].get(name, 0) ==
                    step_denominators.get(name, 0) for name in denominator_names),
                "per-update target denominator summary differs from cumulative totals")
        previous_target_totals = {
            **{key: target_totals[key] for key in summary_fields},
            "lossDenominators": dict(total_denominators),
        }
        previous_position = position
        router_updates += position["routerInternalPositionAuditUpdates"] > 0
    require(previous_position is not None, "optimizer metrics contain no position summaries")
    require(router_updates == expected_updates,
            "router counts were not audited for every optimizer update")
    require(previous_position == final_position_report,
            "per-update position summaries do not end at the unchanged final checkpoint report")
    require(previous_target_totals == final_target_report,
            "per-update cumulative target summaries do not match final checkpoint receipts")
    return previous_position, {"optimizerMetricRows": len(training),
                               "routerPositionAuditsObserved": router_updates,
                               "targetSummaryRows": len(training)}


def revalidate(args):
    consumer = args.consumer_root.resolve(strict=True)
    sys.path.insert(0, str(consumer / "scripts"))
    sys.path.insert(1, str(consumer / "src"))

    from megatoken.data import PreparedCorpus
    from megatoken.data.semantic_json import stable_algorithm_hash
    from megatoken.loading import build_model, load_model_config
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
    from megatoken.training.semantic_v8 import (
        load_semantic_v8_codec,
        semantic_v8_target_exposure_report,
        validate_semantic_v8_target_exposure,
    )
    from megatoken.training.target_inventory_v8 import compare_target_inventory
    from qualify_semantic_v8_target_inventory import target_inventory

    root = args.artifact_root.resolve(strict=True)
    lifecycle = root / "v8-support-lifecycle"
    prepared = root / "v8-support-prepared"
    tokenizer = lifecycle / "served" / "tokenizer.json"
    source_inventory_path = root / "v8-support-source-ids.json"
    supplied_inventory_path = lifecycle / "target-inventory.json"
    supplied_coverage_path = lifecycle / "target-coverage-evidence.json"
    require(prepared.is_dir() and tokenizer.is_file(), "artifact lacks prepared corpus or tokenizer")
    require(source_inventory_path.is_file(), "artifact lacks the exact 64-source inventory")
    require(supplied_inventory_path.is_file() and supplied_coverage_path.is_file(),
            "artifact lacks the target inventory or actual target coverage receipt")

    coverage = read(supplied_coverage_path)
    supplied_inventory = read(supplied_inventory_path)
    source_population = read(source_inventory_path)
    command = read(lifecycle / "command-report.json")
    summary = read(lifecycle / "qualification" / "summary.json")
    require(command.get("status") == "passed" and command.get("fullTargetCoverageQualified") is True,
            "original ordinary lifecycle did not complete full target coverage")
    require(command.get("fullTargetCoverageRequested") is True and command.get("targetCoverageStatus") == "passed",
            "original artifact did not retain its explicit full-target request")
    update_counts = command.get("optimizerUpdateCounts", {})
    require(update_counts.get("lifecycle") == 2 and
            update_counts.get("coverage") == supplied_inventory.get("optimizerWindowCount") and
            update_counts.get("total") == 2 + supplied_inventory.get("optimizerWindowCount"),
            "ordinary two-update and separate full-fit denominators were combined or changed")
    require(coverage.get("learnedSuccess") is None and command.get("learnedSuccess") is None,
            "target coverage evidence made a learned-quality claim")

    latest = read(lifecycle / "fit-coverage" / "checkpoints" / "latest.json")
    coverage_checkpoint_path = lifecycle / "fit-coverage" / "checkpoints" / latest["checkpoint"]
    coverage_payload, coverage_metadata = load_checkpoint(coverage_checkpoint_path, map_location="cpu")
    raw_config = coverage_payload["train_config"]
    config = TrainConfig.from_dict(raw_config)
    policy = config.semantic_v8_policy
    require(policy is not None, "coverage checkpoint has no explicit V8 policy")
    producer_revision = policy["producerRevision"]
    optimizer_revision = policy["consumerRevision"]
    require(producer_revision == args.producer_revision, "producer runtime identity differs from campaign pin")
    require(optimizer_revision == args.optimizer_revision, "native optimizer runtime identity differs from campaign pin")
    require(command.get("producerRevision") == producer_revision and
            command.get("consumerRevision") == optimizer_revision,
            "command report changed the original optimizer runtime identities")
    registry_digest = policy["registryDigest"]

    manifest = read(prepared / "manifest.json")
    registry = read(prepared / "semantic-v8-families.json")
    source_ids = source_population.get("sourceIds")
    require(source_population.get("schema") == "semantic-v8-source-population/1" and
            source_population.get("registryDigest") == registry_digest and
            isinstance(source_ids, list) and len(source_ids) == 64 and len(set(source_ids)) == 64,
            "support population differs from its frozen 64-source registry")
    require(registry.get("digest") == registry_digest,
            "prepared registry differs from original policy")
    components = registry.get("components", [])
    split_ids = {
        split: sorted({source_id for component in components if component.get("split") == split
                       for source_id in component.get("sourceIds", [])})
        for split in ("train", "validation", "test")
    }
    registry_ids = [row["id"] for row in registry.get("sources", [])]
    require(len(registry_ids) == 64 and len(set(registry_ids)) == 64 and set(registry_ids) == set(source_ids),
            "prepared family registry changed the exact 64-source population")
    require({split: len(ids) for split, ids in split_ids.items()} ==
            {"train": 48, "validation": 12, "test": 4} and
            set().union(*map(set, split_ids.values())) == set(source_ids),
            "prepared registry changed the original 48/12/4 split")
    train_ids = split_ids["train"]
    require(len(train_ids) == 48 and set(train_ids).issubset(source_ids),
            "frozen support split does not retain its exact 48-source training population")
    require(supplied_inventory.get("sourceIds") == train_ids and
            supplied_inventory.get("scoredSourceIds") == train_ids,
            "target inventory source population differs from the exact training split")

    model_config = load_model_config(
        config.model,
        **{
            **config.model_overrides,
            "expert_backend": config.expert_backend,
            "checkpoint_stages": config.gradient_checkpointing,
        },
    )
    codec = load_semantic_v8_codec(str(tokenizer), vocab_size=model_config.vocab_size)
    require(codec.fingerprint == supplied_inventory.get("codecFingerprint"),
            "retained tokenizer differs from the original prepared target inventory")
    model = build_model(model_config, codec, device="cpu", precision=config.precision, packs=config.packs)
    modalities = installed_modality_ids(model)

    # Re-derive the target planner census from the relocated prepared corpus.
    # Only input paths are changed in this in-memory copy. Restore the original
    # path-bearing identity digest before comparing with the unchanged receipt.
    relocated_config = copy.deepcopy(raw_config)
    relocated_config["datasets"] = [str(prepared)]
    relocated_config["codec"] = str(tokenizer)
    derived_inventory = target_inventory(relocated_config, source_inventory_path)
    original_config_digest = training_config_digest(raw_config, TrainConfig, __import__("dataclasses").asdict,
                                                    stable_algorithm_hash)
    require(supplied_inventory.get("trainingConfigDigest") == original_config_digest,
            "saved target inventory changed its original path-bearing training identity")
    normalized_inventory = dict(derived_inventory)
    normalized_inventory.pop("digest", None)
    normalized_inventory["trainingConfigDigest"] = original_config_digest
    normalized_inventory["digest"] = stable_algorithm_hash(normalized_inventory)
    require(normalized_inventory == supplied_inventory,
            "strict reader re-derived a target inventory different from the retained original")

    with PreparedCorpus([str(prepared)], split="train") as corpus:
        require(corpus.codec_fingerprint == codec.fingerprint,
                "prepared corpus tokenizer differs from exact retained tokenizer")
        position_inventory = independent_position_inventory(
            (corpus.fetch(index)[0] for index in range(len(corpus))),
            codec=codec,
            config=config,
            model_config=model_config,
            modalities=modalities,
            prepared_manifest_fingerprint=manifest["fingerprint"],
            expected_source_ids=train_ids,
        )
    require(position_inventory == coverage.get("independentPreparedPositionInventory"),
            "strict reader independently reconstructed different prepared positions or masks")
    exposure = coverage_payload.get("semantic_v8_position_exposure")
    objective = position_inventory["objective"]
    restored = restore_position_exposure(
        coverage_payload,
        registry_digest=registry_digest,
        objective=objective,
        global_step=coverage_payload["global_step"],
        checkpoint_metadata=coverage_metadata,
    )
    require(restored == exposure and coverage_metadata.get("semantic_v8_position_digest") == exposure["digest"],
            "final checkpoint metadata does not retain the exact original position history")
    target = validate_semantic_v8_target_exposure(
        coverage_payload.get("semantic_v8_target_exposure"), registry_digest=registry_digest
    )
    target_comparison = compare_target_inventory(
        supplied_inventory,
        target["sources"],
        rederived_inventory=normalized_inventory,
        registry_digest=registry_digest,
        prepared_manifest_fingerprint=manifest["fingerprint"],
        codec_fingerprint=codec.fingerprint,
        training_config_digest=original_config_digest,
        model_config_digest=normalized_inventory["modelConfigDigest"],
    )
    require(target_comparison == coverage.get("comparison") and
            target_comparison.get("exactOnePassCensus") is True,
            "strict reader re-derived target receipts different from the original one-pass census")
    position_comparison = compare_position_inventory(
        position_inventory,
        restored,
        target_exposure=target,
        global_step=coverage_payload["global_step"],
    )
    require(position_comparison == coverage.get("positionComparison") and
            position_comparison.get("exactOnePassPreparedTextPositions") is True and
            position_comparison.get("positiveWeightPositionCountsMatch") is True,
            "strict reader re-derived different final target positions, labels or masks")

    coverage_updates = supplied_inventory["optimizerWindowCount"]
    require(coverage_payload["global_step"] == coverage_updates == coverage.get("globalStep"),
            "coverage checkpoint does not match the original separate optimizer-window count")
    final_target_report = semantic_v8_target_exposure_report(target)
    metric_state, metric_report = position_history(
        lifecycle / "fit-coverage" / "metrics.jsonl",
        coverage_updates,
        position_exposure_report(restored),
        {
            key: final_target_report[key]
            for key in (
                "sourceCount",
                "logicalTargetCount",
                "physicalTargetRecordCount",
                "scoredOccurrences",
                "lossDenominators",
            )
        },
    )
    require(metric_state == position_exposure_report(restored),
            "per-update position summaries do not end at the unchanged coverage checkpoint")

    # Revalidate the separate two-update resume trajectory, without combining
    # it with the fresh full-fit trajectory.
    first_payload, first_metadata = load_checkpoint(lifecycle / "first-checkpoint", map_location="cpu")
    resume_path = lifecycle / "fit" / "checkpoints" / "SE-000000002-periodic"
    resumed_payload, resumed_metadata = load_checkpoint(resume_path, map_location="cpu")
    require(first_payload["global_step"] == 1 and resumed_payload["global_step"] == 2,
            "ordinary resume artifacts do not retain their original 1-to-2 update boundary")
    require(first_metadata.get("semantic_v8_position_digest") ==
            first_payload["semantic_v8_position_exposure"]["digest"] and
            resumed_metadata.get("semantic_v8_position_digest") ==
            resumed_payload["semantic_v8_position_exposure"]["digest"],
            "ordinary lifecycle checkpoint metadata does not bind both position receipts")
    resume_history = qualify_position_history(
        first_payload,
        resumed_payload,
        inventory=position_inventory,
        first_metadata=first_metadata,
        resumed_metadata=resumed_metadata,
    )
    lifecycle_summary = summary["optimizerResumeExport"]["optimizerPositionExposure"]
    require(lifecycle_summary.get("historyContinued") is True and
            lifecycle_summary.get("firstCheckpointCounts", {}).get("lastGlobalStep") == 1 and
            lifecycle_summary.get("resumedCounts", {}).get("lastGlobalStep") == 2 and
            lifecycle_summary.get("fullPopulationQualified") is False and
            lifecycle_summary.get("routerInternalPositionCoverage") == "unmeasured",
            "ordinary two-update lifecycle report changed its partial position scope")

    current_reader = subprocess.check_output(
        ["git", "-C", str(consumer), "rev-parse", "HEAD"], text=True
    ).strip()
    reader_parent = subprocess.check_output(
        ["git", "-C", str(consumer), "rev-parse", "HEAD^"], text=True
    ).strip()
    require(current_reader == args.strict_reader_revision and reader_parent == args.strict_reader_parent,
            "strict reader runtime does not match the separately recorded current source pair")
    source_map = {}
    for relative in (
        "scripts/qualify_semantic_v8_target_coverage.py",
        "scripts/qualify_semantic_v8_target_inventory.py",
        "src/megatoken/training/positions_v8.py",
        "src/megatoken/training/target_inventory_v8.py",
    ):
        source_map[relative] = sha256(consumer / relative)
    output = {
        "schema": "semantic-v8-stricter-reader-fullfit-revalidation/1",
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
        "reader": {
            "revision": current_reader,
            "parentRevision": reader_parent,
            "sourceMap": source_map,
            "python": platform.python_version(),
            "torch": str(torch.__version__),
        },
        "optimizerUpdatesPerformedByAudit": 0,
        "sourcePopulation": {
            "allSources": source_ids,
            "allSourceCount": len(source_ids),
            "splitSourceIds": split_ids,
            "trainingSources": train_ids,
            "trainingSourceCount": len(train_ids),
            "sourcePopulationDigest": stable_algorithm_hash(source_population),
        },
        "independentTrajectories": {
            "ordinaryLifecycle": {"optimizerUpdates": 2, "firstGlobalStep": 1, "resumedGlobalStep": 2,
                                  "fullPopulationQualified": False},
            "separateFullCoverage": {"optimizerUpdates": coverage_updates,
                                     "startingGlobalStep": restored["startingGlobalStep"],
                                     "lastGlobalStep": restored["lastGlobalStep"]},
            "combinedUpdateCountIsOneTrajectory": False,
        },
        "targetInventory": {
            "digest": supplied_inventory["digest"],
            "physicalTargetRecordCount": supplied_inventory["positiveWeight"]["physicalTargetRecordCount"],
            "logicalTargetCount": supplied_inventory["positiveWeight"]["logicalTargetCount"],
            "lossDenominators": supplied_inventory["positiveWeight"]["lossDenominators"],
            "trainingConfigPathRelocationOnly": True,
        },
        "preparedTextPositionAudit": {
            "independentPositionInventoryDigest": position_inventory["digest"],
            "positionComparisonDigest": stable_algorithm_hash(coverage["positionComparison"]),
            "exactOnePassPreparedTextPositions": position_comparison["exactOnePassPreparedTextPositions"],
            "positiveWeightPositionCounts": position_exposure_report(restored)["positiveWeightPositionCounts"],
            "perUpdatePositionSummariesRevalidated": metric_report["optimizerMetricRows"],
            "perUpdateFullReceiptsAvailableInMetrics": False,
        },
        "routerCounts": {
            "accounting": position_exposure_report(restored)["routerInternalPositionAccounting"],
            "auditedUpdates": position_exposure_report(restored)["routerInternalPositionAuditUpdates"],
            "positions": position_exposure_report(restored)["routerInternalPositionCounts"],
            "assignments": position_exposure_report(restored)["routerInternalAssignmentCounts"],
            "coverage": "unmeasured",
        },
        "resumeReceipts": {
            "firstPositionDigest": first_payload["semantic_v8_position_exposure"]["digest"],
            "resumedPositionDigest": resumed_payload["semantic_v8_position_exposure"]["digest"],
            "strictHistoryComparison": resume_history,
            "summaryPositionReportUnchanged": True,
        },
        "originalHashes": {
            str(path.relative_to(root)): sha256(path)
            for path in (
                supplied_inventory_path,
                supplied_coverage_path,
                lifecycle / "command-report.json",
                lifecycle / "coverage-training-config.json",
                lifecycle / "training-config.json",
                lifecycle / "qualification" / "summary.json",
                lifecycle / "fit-coverage" / "metrics.jsonl",
                lifecycle / "fit" / "metrics.jsonl",
                root / "v8-support-source-ids.json",
                coverage_checkpoint_path / "metadata.json",
                coverage_checkpoint_path / "state.pt",
                lifecycle / "first-checkpoint" / "metadata.json",
                lifecycle / "first-checkpoint" / "state.pt",
                lifecycle / "fit" / "checkpoints" / "SE-000000002-periodic" / "metadata.json",
                lifecycle / "fit" / "checkpoints" / "SE-000000002-periodic" / "state.pt",
                prepared / "manifest.json",
                tokenizer,
            )
        },
        "scope": "Read-only stricter-reader revalidation of unchanged hosted full-fit and resume receipts. Router rows retain complete-per-update accounting and explicitly unmeasured coverage. No learned-success claim.",
        "learnedSuccess": None,
    }
    output["reader"]["revalidationScriptSha256"] = sha256(Path(__file__).resolve())
    return output


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--artifact-root", type=Path, required=True)
    parser.add_argument("--consumer-root", type=Path, required=True)
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
