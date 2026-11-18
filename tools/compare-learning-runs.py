#!/usr/bin/env python3
"""Freeze, register and compare real matched native v5 learning experiments.

Run in the pinned Megatoken Python environment. All operations are read-only on
models, checkpoints, native reports and corpora; only a fresh output is written.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import subprocess
import sys

from learning_comparison import (
    base_artifact_identity, bind_training_artifacts, compare_validated_runs,
    component_map_from_registry, digest, freeze_declaration, normalized_training_config,
    prepared_component_inventory, read_json, register_launch, training_template, verify_declaration,
)


def revision(directory):
    if subprocess.check_output(["git", "status", "--porcelain", "--untracked-files=no"], cwd=directory, text=True).strip():
        raise ValueError("Comparison requires the pinned, unchanged native consumer checkout")
    return subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=directory, text=True).strip()


def verified_registry(document):
    repository = Path(__file__).resolve().parent.parent
    script = """import {verifySourceRegistry} from './src/corpus/source-registry.mjs';
let input='';for await(const part of process.stdin)input+=part;
console.log(JSON.stringify(verifySourceRegistry(JSON.parse(input))));"""
    result = subprocess.run(["node", "--input-type=module", "-e", script], cwd=repository,
        input=json.dumps(document), text=True, capture_output=True, check=False, timeout=120)
    if result.returncode:
        raise ValueError("Frozen source registry failed independent source/clone/ancestry reconstruction: " + result.stderr[-1000:])
    return json.loads(result.stdout)


def registry_from_declaration(declaration, cohort):
    evidence = declaration["componentEvidence"]
    if evidence.get("kind") != "reconstructed-source-registry":
        raise ValueError("The CLI requires an actual globally frozen source registry")
    registry = evidence["registry"]
    if verified_registry(registry)["digest"] != evidence["registryDigest"] or component_map_from_registry(cohort, registry) != declaration["componentByFamily"]:
        raise ValueError("Frozen source component identity changed")
    return registry


def codec_for(base, path, directory):
    from megatoken.generation.codec import ByteCodec
    vocabulary = read_json(directory / "model_config.json")["vocab_size"]
    return ByteCodec.from_tokenizer_json(path, expected_sha256=base["tokenizerSha256"], expected_vocab_size=vocabulary)


def write_new(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("x") as handle:
        json.dump(value, handle, indent=2, ensure_ascii=False, allow_nan=False)
        handle.write("\n")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    modes = parser.add_subparsers(dest="command", required=True)
    for name in ("freeze", "register", "compare"):
        mode = modes.add_parser(name)
        mode.add_argument("--consumer-root", type=Path, required=True)
        mode.add_argument("--cohort", type=Path, required=True)
        mode.add_argument("--base-served", type=Path, required=True)
        mode.add_argument("--base-checkpoint", type=Path, required=True)
        mode.add_argument("--tokenizer-json", type=Path, required=True)
        mode.add_argument("--output", type=Path, required=True)
        if name == "freeze":
            mode.add_argument("--design", type=Path, required=True)
            mode.add_argument("--source-registry", type=Path, required=True)
        else:
            mode.add_argument("--declaration", type=Path, required=True)
        if name in {"freeze", "register"}:
            mode.add_argument("--training-config", type=Path, required=True)
            if name == "register":
                mode.add_argument("--native-launch-qualification", type=Path,
                    help="Required passed semantic-launch-qualification/1 for production or confirmatory runs")
        else:
            mode.add_argument("--runs", type=Path, required=True)
            mode.add_argument("--require-acceptance", action="store_true")
    options = parser.parse_args(argv)
    if options.output.exists():
        raise FileExistsError("Declarations, launch receipts and comparisons are immutable; choose a fresh output")
    consumer = revision(options.consumer_root)
    sys.path.insert(0, str(options.consumer_root.resolve() / "src"))
    from megatoken.training.semantic_evaluation import verify_cohort
    from megatoken.training.semantic_budget import SemanticExperimentConfig
    cohort = read_json(options.cohort)
    verify_cohort(cohort)
    base = base_artifact_identity(options.base_served, options.base_checkpoint, options.tokenizer_json)
    codec = codec_for(base, options.tokenizer_json, options.base_served)
    if options.command == "freeze":
        config = normalized_training_config(read_json(options.training_config))
        experiment = SemanticExperimentConfig(**config["semantic_experiment"])
        if experiment.preflight(phase=config["phase"]) != cohort["digest"]:
            raise ValueError("Training configuration and comparison use different frozen test cohorts")
        registry = read_json(options.source_registry)
        receipt = verified_registry(registry)
        inventory = prepared_component_inventory(config, registry, codec)
        if inventory["nativeSupply"].get("consumerRevision") != consumer:
            raise ValueError("Prepared training supply pins a different native consumer")
        design = {**read_json(options.design), "consumerRevision": consumer,
            "componentByFamily": component_map_from_registry(cohort, registry),
            "trainingComponents": inventory["components"],
            "componentEvidence": {"kind": "reconstructed-source-registry", "registry": registry, "registryDigest": receipt["digest"]},
            "trainingDesign": {"templateDigest": digest(training_template(config)), "supply": inventory,
                "phase": config["phase"], "budget": {"regime": experiment.regime, "limit": experiment.limit,
                    "maxTokenOvershoot": experiment.max_token_overshoot, "representation": experiment.representation}}}
        result = freeze_declaration(cohort, design, base)
    else:
        declaration = read_json(options.declaration)
        verify_declaration(declaration, cohort)
        if declaration["consumerRevision"] != consumer or declaration["base"] != base:
            raise ValueError("Actual native consumer or base checkpoint changed after freezing")
        registry = registry_from_declaration(declaration, cohort)
        if options.command == "register":
            config = normalized_training_config(read_json(options.training_config))
            inventory = prepared_component_inventory(config, registry, codec)
            result = register_launch(declaration, cohort, config, base, inventory,
                qualification=read_json(options.native_launch_qualification) if options.native_launch_qualification else None)
        else:
            index = read_json(options.runs)
            if index.get("schema") != "semantic-learning-runs/1" or not isinstance(index.get("pairs"), list):
                raise ValueError("A matched semantic-learning-runs/1 artifact inventory is required")
            resolve = lambda value: (options.runs.parent / value).resolve()
            pairs, inputs = [], []
            from megatoken.training.checkpoint import load_checkpoint
            for pair in index["pairs"]:
                paths = {key: resolve(pair[key]) for key in ("baseReport", "trainedReport", "trainedServed", "trainedCheckpoint", "launchReceipt")}
                payload, _ = load_checkpoint(paths["trainedCheckpoint"])
                inventory = prepared_component_inventory(payload["train_config"], registry, codec)
                if inventory != declaration["trainingDesign"]["supply"]:
                    raise ValueError("Actual prepared training data changed since registration")
                binding = bind_training_artifacts(declaration, cohort, read_json(paths["launchReceipt"]),
                    paths["trainedServed"], paths["trainedCheckpoint"], options.tokenizer_json)
                pairs.append({"seed": pair["seed"], "base": read_json(paths["baseReport"]),
                    "trained": read_json(paths["trainedReport"]), "artifactBinding": binding})
                inputs.append({"seed": pair["seed"], **{key: str(path) for key, path in paths.items()}})
            result = compare_validated_runs(declaration, cohort, pairs)
            result.update(consumerRevision=consumer, comparedAt=datetime.now(timezone.utc).isoformat(), inputs=inputs,
                          actualArtifactsVerified=True)
    write_new(options.output, result)
    print(json.dumps({key: result[key] for key in ("schema", "digest", "accepted", "evidenceScope", "gates") if key in result}))
    return 2 if options.command == "compare" and options.require_acceptance and not result["accepted"] else 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (ValueError, KeyError, TypeError, OSError, subprocess.SubprocessError) as error:
        print(f"Learning comparison refused: {error}", file=sys.stderr)
        raise SystemExit(1)
