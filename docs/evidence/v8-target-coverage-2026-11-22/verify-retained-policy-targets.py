"""Independently compare admitted prepared policy targets with retained V8 census.

This is supplemental evidence, not a new optimizer run or a replacement for the
original ordinary planner/checkpoint qualification. Original report/config bytes
are retained unchanged even when their input artifacts have been relocated.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from dataclasses import asdict
from pathlib import Path

import torch
from megatoken.data import PreparedCorpus
from megatoken.data.semantic_json import stable_algorithm_hash
from megatoken.loading import load_model_config
from megatoken.training.config import TrainConfig
from megatoken.training.semantic_v8 import (
    load_semantic_v8_codec,
    preflight_semantic_training_v8,
)
from megatoken.training.target_inventory_v8 import inventory_episode_source_id


def read(path):
    return json.loads(path.read_text())


def require(condition, message):
    if not condition:
        raise ValueError(message)


def check_digest(document):
    require(
        document.get("digest")
        == stable_algorithm_hash(
            {key: value for key, value in document.items() if key != "digest"}
        ),
        "Retained report digest differs from its complete bytes",
    )


def keys(sources):
    return {
        (source_id, logical_id, record_id)
        for source_id, source in sources.items()
        for logical_id, target in source["logicalTargets"].items()
        for record_id in target["records"]
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--prepared", type=Path, required=True)
    parser.add_argument("--inventory", type=Path, required=True)
    parser.add_argument("--coverage", type=Path, required=True)
    parser.add_argument("--training-config", type=Path, required=True)
    parser.add_argument("--tokenizer", type=Path, required=True)
    parser.add_argument("--guard-revision", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()

    inventory, coverage, raw_config = (
        read(args.inventory),
        read(args.coverage),
        read(args.training_config),
    )
    check_digest(inventory)
    check_digest(coverage)
    config = TrainConfig.from_dict(raw_config)
    original_objective = asdict(config)
    for key in (
        "output",
        "max_steps",
        "checkpoint_every",
        "keep_checkpoints",
        "log_every",
        "device",
    ):
        original_objective.pop(key, None)
    require(
        stable_algorithm_hash(original_objective) == inventory["trainingConfigDigest"],
        "Original configuration bytes differ from the inventoried objective",
    )
    model_config = load_model_config(
        config.model,
        **{
            **config.model_overrides,
            "expert_backend": config.expert_backend,
            "checkpoint_stages": config.gradient_checkpointing,
        },
    )
    codec = load_semantic_v8_codec(
        str(args.tokenizer), vocab_size=model_config.vocab_size
    )
    policy = config.semantic_v8_policy
    require(
        isinstance(policy, dict), "Retained training configuration lost its V8 policy"
    )
    manifest_path = args.prepared / "manifest.json"
    registry_path = args.prepared / "semantic-v8-families.json"
    manifest, registry = read(manifest_path), read(registry_path)
    supply = preflight_semantic_training_v8(
        [str(args.prepared)],
        codec=codec,
        policy=policy,
        max_history=model_config.max_history_chunks,
        max_positions=model_config.max_capacity,
    )
    require(
        supply["registryDigest"] == registry["digest"] == policy["registryDigest"],
        "Retained prepared registry differs from exact training policy",
    )
    split_by_id = {}
    for component in registry["components"]:
        for source_id in component["sourceIds"]:
            require(source_id not in split_by_id, "Frozen registry duplicates a source")
            split_by_id[source_id] = component["split"]
    require(
        len(registry["sources"]) == len(split_by_id) == 64
        and {source["id"] for source in registry["sources"]} == set(split_by_id)
        and {
            split: sum(value == split for value in split_by_id.values())
            for split in ("train", "validation", "test")
        }
        == {"train": 48, "validation": 12, "test": 4},
        "Supplemental check requires the complete frozen 64-source registry",
    )
    train_ids = {source for source, split in split_by_id.items() if split == "train"}
    prepared_targets, observed_sources = set(), set()
    with PreparedCorpus([str(args.prepared)], split="train") as corpus:
        require(
            len(corpus) == 48, "Prepared training population differs from frozen split"
        )
        for episode in corpus.iter_episodes():
            source = inventory_episode_source_id(
                episode, registry_digest=registry["digest"]
            )
            require(
                source not in observed_sources,
                "Prepared corpus duplicates a training source",
            )
            observed_sources.add(source)
            for record in episode.records:
                if record.policy_mask:
                    key = (source, record.logical_id, record.record_id)
                    require(
                        key not in prepared_targets,
                        "Prepared policy target is duplicated",
                    )
                    prepared_targets.add(key)
    require(
        observed_sources == train_ids,
        "Prepared corpus omitted a frozen training source",
    )
    require(
        coverage["consumerRevision"] == policy["consumerRevision"]
        and coverage["inventory"]["digest"] == inventory["digest"]
        and coverage["globalStep"] == inventory["optimizerWindowCount"]
        and set(inventory["sourceIds"]) == train_ids
        and set(inventory["scoredSourceIds"]) == train_ids
        and inventory["available"]["policyTargetRecordCount"] == len(prepared_targets),
        "Original optimizer report differs from exact prepared inventory binding",
    )
    planned_targets = keys(inventory["sources"])
    actual_sources = coverage["optimizerTargetExposure"]["sources"]
    actual_targets = keys(actual_sources)
    require(
        prepared_targets == planned_targets == actual_targets,
        "Prepared policy targets differ from retained planned or actual optimizer targets",
    )
    retained_actual_plan_fields = {
        source_id: {
            "split": source["split"],
            "logicalTargets": {
                logical_id: {
                    "records": {
                        record_id: {
                            field: record[field]
                            for field in (
                                "windowIndices",
                                "lossDenominators",
                                "scoredOccurrences",
                            )
                        }
                        for record_id, record in target["records"].items()
                    }
                }
                for logical_id, target in source["logicalTargets"].items()
            },
        }
        for source_id, source in actual_sources.items()
    }
    require(
        retained_actual_plan_fields == inventory["sources"]
        and set(actual_sources) == train_ids
        and coverage["comparison"]["allPositiveWeightTargetsExposed"] is True
        and coverage["comparison"]["exactOnePassCensus"] is True
        and inventory["registryDigest"] == registry["digest"]
        and inventory["preparedManifestFingerprint"] == manifest["fingerprint"]
        and inventory["codecFingerprint"] == codec.fingerprint
        and inventory["modelConfigDigest"]
        == stable_algorithm_hash(model_config.to_dict()),
        "Retained optimizer windows, occurrences or denominators differ from original report",
    )
    body = {
        "schema": "semantic-v8-independent-prepared-target-coverage-check/1",
        "guardExecutableRevision": args.guard_revision,
        "scriptSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        "runtime": {"torch": torch.__version__, "device": "cpu"},
        "originalTrainingPolicy": policy,
        "runtimeInputRelocations": {
            "originalPreparedRoots": config.datasets,
            "validationPreparedRoot": str(args.prepared.resolve()),
            "originalTokenizerPath": config.codec,
            "validationTokenizerPath": str(args.tokenizer.resolve()),
        },
        "originalOptimizerUpdates": coverage["globalStep"],
        "additionalOptimizerUpdates": 0,
        "preparedManifestFingerprint": manifest["fingerprint"],
        "registryDigest": registry["digest"],
        "tokenizerIdentity": codec.fingerprint,
        "tokenizerSha256": hashlib.sha256(args.tokenizer.read_bytes()).hexdigest(),
        "inventoryDigest": inventory["digest"],
        "originalCoverageDigest": coverage["digest"],
        "originalInputsSha256": {
            "inventory": hashlib.sha256(args.inventory.read_bytes()).hexdigest(),
            "coverage": hashlib.sha256(args.coverage.read_bytes()).hexdigest(),
            "trainingConfig": hashlib.sha256(
                args.training_config.read_bytes()
            ).hexdigest(),
            "preparedManifest": hashlib.sha256(manifest_path.read_bytes()).hexdigest(),
            "registry": hashlib.sha256(registry_path.read_bytes()).hexdigest(),
        },
        "preflight": supply,
        "trainSourceCount": len(observed_sources),
        "preparedPolicyTargetCount": len(prepared_targets),
        "plannedPositiveTargetCount": len(planned_targets),
        "actualPositiveTargetCount": len(actual_targets),
        "canonicalPolicyTargetIds": [list(row) for row in sorted(prepared_targets)],
        "retainedPlannerAndActualCensusRowsEqual": True,
        "originalComparison": coverage["comparison"],
        "scope": (
            "Complete native admission of retained prepared episodes, independent prepared "
            "policy-target identities, and unchanged original planner/census comparison. "
            "The planner and optimizer ran in the original campaign; this supplemental "
            "check does not rerun either, alter their pins, or rewrite their report/config bytes."
        ),
        "tokenOrMaskPositionCoverage": "unmeasured",
        "learnedSuccess": None,
    }
    body["digest"] = stable_algorithm_hash(body)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(body, indent=2, allow_nan=False) + "\n")
    print(
        json.dumps(
            {
                key: body[key]
                for key in (
                    "digest",
                    "originalOptimizerUpdates",
                    "additionalOptimizerUpdates",
                    "trainSourceCount",
                    "preparedPolicyTargetCount",
                    "plannedPositiveTargetCount",
                    "actualPositiveTargetCount",
                )
            },
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    main()
