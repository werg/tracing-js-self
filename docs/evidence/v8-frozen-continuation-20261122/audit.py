#!/usr/bin/env python3
"""Read-only audit of the original 314→348 continuation and its retained bytes.

Run with the original native reader and locked Python runtime. This performs no
optimizer updates. The hosted native planner already independently rebuilt the
target census; this audit binds that report to actual saved tensors/history and
independently re-reads the prepared text positions again.
"""
from __future__ import annotations

import argparse
import copy
import hashlib
import io
import importlib.metadata
import json
import platform
import stat
import subprocess
import sys
import tarfile
import zipfile
from collections import Counter
from pathlib import Path, PurePosixPath

RUN = 45043236761
DRIVER = "2dd1d31d717e89c2121d0cd8c2de9915464b4e45"
PRODUCER = "9cf091e6ccc5add960ef0897576d0c391b199a65"
NATIVE = "1a69d9da3254b7568c831d12866a629c206cf4fe"
ORIGINAL_SHA = "6dc909ecc1c1ed7401fa5ceb1cba7006c07641d530a1550f16a7870af3e483af"
STATE314_SHA = "93828a840122cc2e209e1c448396324595adef476d610770384291847fdc8499"
REGISTRY = "306a20791e1a76fa53872f6b1b856bba66f1308c1428a3a745171d28322b3e6c"
FIT = "v8-support-lifecycle/fit-coverage"
PARTIAL = FIT + "/checkpoints/SE-000000314-interrupted"


def require(condition, message):
    if not condition:
        raise ValueError(message)


def parse(data):
    def unique(pairs):
        result = {}
        for key, value in pairs:
            require(key not in result, "Duplicate JSON key: " + key)
            result[key] = value
        return result
    return json.loads(data, object_pairs_hook=unique,
                      parse_constant=lambda value: (_ for _ in ()).throw(ValueError(value)))


def digest(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def safe_name(name):
    pure = PurePosixPath(name)
    require(name and not pure.is_absolute() and "\\" not in name
            and all(part not in ("", ".", "..") for part in name.split("/")), "Unsafe archive member")
    return name


def write_same(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        require(path.is_file() and not path.is_symlink() and path.read_bytes() == data,
                "Existing audit copy differs: " + str(path))
    else:
        with path.open("xb") as stream:
            stream.write(data)


def metrics(data):
    return [parse(line) for line in data.splitlines() if line.strip()]


def checkpoint_audit(args, files, original, captured):
    native = args.native.resolve(strict=True)
    require(subprocess.check_output(["git", "-C", str(native), "rev-parse", "HEAD"], text=True).strip() == NATIVE,
            "Audit reader must be the exact original native revision")
    require(not subprocess.check_output(["git", "-C", str(native), "status", "--porcelain", "--untracked-files=all"], text=True),
            "Frozen audit source is not clean")
    expected_packages = {"torch": "2.10.0+cpu", "numpy": "2.5.5", "safetensors": "0.8.0", "tokenizers": "0.23.3"}
    actual_packages = {name: importlib.metadata.version(name) for name in expected_packages}
    require(platform.python_version() == "3.12.14" and actual_packages == expected_packages,
            "Independent checkpoint reader runtime differs from the original")
    sys.path.insert(0, str(native / "src"))
    from megatoken.data import PreparedCorpus
    from megatoken.data.semantic_json import stable_algorithm_hash
    from megatoken.loading import build_model, load_model_config
    from megatoken.semantic_lineage_v8 import checkpoint_lineage_v8
    from megatoken.training.checkpoint import load_checkpoint
    from megatoken.training.config import TrainConfig
    from megatoken.training.engine import _resume_compatible
    from megatoken.training.positions_v8 import (
        _flat_position_rows, compare_position_inventory, independent_position_inventory,
        installed_modality_ids, position_exposure_report, validate_position_exposure,
    )
    from megatoken.training.semantic_v8 import load_semantic_v8_codec, validate_semantic_v8_target_exposure
    from megatoken.training.target_inventory_v8 import compare_target_inventory
    import torch

    root = args.work
    before, before_meta = load_checkpoint(root / PARTIAL, map_location="cpu")
    after, after_meta = load_checkpoint(root / FIT / "checkpoints", map_location="cpu")
    require(before["global_step"] == before_meta["global_step"] == 314
            and before_meta["state_sha256"] == STATE314_SHA, "Original checkpoint identity differs")
    require(after["global_step"] == after_meta["global_step"] == 348, "Final checkpoint is not step348")
    require(after_meta["state_sha256"] != STATE314_SHA, "Final state is the original partial state")
    require(checkpoint_lineage_v8(before, before_meta) == checkpoint_lineage_v8(after, after_meta),
            "Source/data lineage changed")
    normalized = copy.deepcopy(after["train_config"])
    require(normalized["max_steps"] == 34, "Resumed invocation cap is not 34")
    normalized["max_steps"] = 348
    require(normalized == before["train_config"], "An objective/configuration field changed")
    _resume_compatible(copy.deepcopy(before["train_config"]), TrainConfig.from_dict(after["train_config"]), False)
    old_masters, new_masters = before["optimizer"]["master_weights"], after["optimizer"]["master_weights"]
    require(old_masters.keys() == new_masters.keys(), "Optimizer parameter ownership changed")
    changed_masters = sum(not torch.equal(value, new_masters[name]) for name, value in old_masters.items())
    require(changed_masters > 0, "No optimizer master weight changed")
    old_moments, new_moments = before["optimizer"]["moments"], after["optimizer"]["moments"]
    require(old_moments.keys() <= new_moments.keys(), "Retained optimizer moments disappeared")
    step_deltas = Counter(float(new_moments[name]["step"]) - float(moment["step"])
                          for name, moment in old_moments.items() if "step" in moment)
    require(all(delta.is_integer() and 0 <= delta <= 34 for delta in step_deltas)
            and 34 in step_deltas, "Optimizer moment counters do not bind the 34-update continuation")

    old_targets = validate_semantic_v8_target_exposure(before["semantic_v8_target_exposure"], registry_digest=REGISTRY)
    targets = validate_semantic_v8_target_exposure(after["semantic_v8_target_exposure"], registry_digest=REGISTRY)
    old_positions = validate_position_exposure(before["semantic_v8_position_exposure"], registry_digest=REGISTRY,
                                              objective=before["semantic_v8_position_exposure"]["objective"])
    positions = validate_position_exposure(after["semantic_v8_position_exposure"], registry_digest=REGISTRY,
                                          objective=old_positions["objective"])
    for old, new in ((old_targets, targets), (old_positions, positions)):
        require(old["startingGlobalStep"] == new["startingGlobalStep"] == 0
                and old["optimizerUpdates"] == old["lastGlobalStep"] == 314
                and new["optimizerUpdates"] == new["lastGlobalStep"] == 348, "Optimizer history is discontinuous")
        previous, current = _flat_position_rows(old["sources"]), _flat_position_rows(new["sources"])
        require(len(previous) == 650 and len(current) == 720, "Physical target population differs")
        require(all(current.get(key) == value for key, value in previous.items()), "Prior physical history changed/repeated")

    coverage = parse(captured["v8-primary-continuation/target-position-coverage.json"])
    result = parse(captured["v8-primary-continuation/result.json"])
    require(coverage["digest"] == stable_algorithm_hash({k: v for k, v in coverage.items() if k != "digest"}),
            "Hosted coverage report digest is invalid")
    require(coverage["checkpointStateSha256"] == after_meta["state_sha256"] == result["finalCheckpointStateSha256"],
            "Coverage/result do not bind the final checkpoint bytes")
    require(coverage["consumerRevision"] == result["consumerRevision"] == NATIVE
            and result["producerRevision"] == PRODUCER and result["originalRun"] == 45023684906
            and result["originalArchiveSha256"] == ORIGINAL_SHA and result["originalCheckpointStateSha256"] == STATE314_SHA
            and result["coverageDigest"] == coverage["digest"]
            and coverage["trainingLineage"] == checkpoint_lineage_v8(after, after_meta), "Coverage/result source binding differs")
    require(coverage["optimizerTargetExposure"]["sources"] == targets["sources"]
            and coverage["optimizerTargetExposure"]["digest"] == targets["digest"]
            and coverage["optimizerPositionExposure"] == positions, "Hosted report differs from saved history")
    require(after_meta["semantic_v8_position_digest"] == positions["digest"], "Metadata position binding differs")
    inventory = parse(original["v8-support-lifecycle/target-inventory.json"])
    comparison = compare_target_inventory(inventory, targets["sources"], rederived_inventory=inventory,
        registry_digest=REGISTRY, prepared_manifest_fingerprint=inventory["preparedManifestFingerprint"],
        codec_fingerprint=inventory["codecFingerprint"], training_config_digest=inventory["trainingConfigDigest"],
        model_config_digest=inventory["modelConfigDigest"])
    require(comparison == coverage["comparison"] and comparison["exactOnePassCensus"] is True
            and comparison["allPositiveWeightTargetsExposed"] is True, "Saved target census differs from original inventory")
    require(inventory["positiveWeight"] == coverage["inventory"]["positiveWeight"] == result["targetPopulation"],
            "Complete target population was altered")

    config = TrainConfig.from_dict(after["train_config"])
    model_config = load_model_config(config.model, **{**config.model_overrides,
        "expert_backend": config.expert_backend, "checkpoint_stages": config.gradient_checkpointing})
    codec = load_semantic_v8_codec(str(root / "v8-support-lifecycle/served/tokenizer.json"), vocab_size=model_config.vocab_size)
    model = build_model(model_config, codec, device="cpu", precision=config.precision, packs=config.packs)
    with PreparedCorpus([str(root / "v8-support-prepared")], split="train") as corpus:
        require(corpus.codec_fingerprint == codec.fingerprint == inventory["codecFingerprint"], "Prepared codec differs")
        independent = independent_position_inventory((corpus.fetch(i)[0] for i in range(len(corpus))),
            codec=codec, config=config, model_config=model_config, modalities=installed_modality_ids(model),
            prepared_manifest_fingerprint=inventory["preparedManifestFingerprint"], expected_source_ids=inventory["sourceIds"])
    require(independent == coverage["independentPreparedPositionInventory"], "Fresh prepared position oracle differs")
    position_comparison = compare_position_inventory(independent, positions, target_exposure=targets, global_step=348)
    require(position_comparison == coverage["positionComparison"]
            and position_comparison["exactOnePassPreparedTextPositions"] is True, "Saved prepared positions are incomplete")
    summary = position_exposure_report(positions)
    require(summary == coverage["optimizerPositionSummary"] == result["positionSummary"], "Position summary differs")
    require(result["status"] == "passed" and result["startingStep"] == 314 and result["finalStep"] == 348
            and result["optimizerUpdatesThisInvocation"] == 34 and result["trajectoryOptimizerUpdates"] == 348
            and result["separateLifecycleOptimizerUpdates"] == 2, "Final update accounting differs")
    require(result["learnedSuccess"] is coverage["learnedSuccess"] is None
            and result["routerInternalPositionCoverage"] == coverage["routerInternalPositionCoverage"] == "unmeasured"
            and result["served348Weights"] is False and result["defaultPromotion"] is False, "Evidence scope changed")
    return {"originalStateSha256": STATE314_SHA, "finalStateSha256": after_meta["state_sha256"],
            "retainedPhysicalTargets": 650, "additionalPhysicalTargets": 70, "finalPhysicalTargets": 720,
            "targetPopulation": inventory["positiveWeight"], "positionSummary": summary,
            "targetComparison": comparison, "positionComparison": position_comparison,
            "coverageDigest": coverage["digest"], "auditOptimizerUpdates": 0,
            "auditRuntime": {"python": platform.python_version(), "packages": actual_packages, "platform": platform.platform()},
            "optimizerMasterWeights": len(old_masters), "changedOptimizerMasterWeights": changed_masters,
            "retainedOptimizerMomentOwners": len(old_moments), "newOptimizerMomentOwners": len(new_moments) - len(old_moments),
            "optimizerMomentStepDeltaCounts": {str(int(delta)): count for delta, count in sorted(step_deltas.items())}}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--artifact", type=Path, required=True)
    parser.add_argument("--metadata", type=Path, required=True)
    parser.add_argument("--original", type=Path, required=True)
    parser.add_argument("--native", type=Path, required=True)
    parser.add_argument("--work", type=Path, required=True)
    args = parser.parse_args()
    meta = parse(args.metadata.read_bytes())
    require(meta["run"]["id"] == RUN and meta["run"]["head_sha"] == DRIVER
            and meta["run"]["head_branch"] == "codex/v8-primary-fit-resume-20261122"
            and meta["run"]["run_attempt"] == 1 and meta["run"]["status"] == "completed"
            and meta["run"]["conclusion"] == "success", "Hosted run did not pass")
    require(len(meta["jobs"]) == 1 and all(job["status"] == "completed" and job["conclusion"] == "success"
            and job["id"] == 137272106443 and job["run_id"] == RUN for job in meta["jobs"]), "Hosted continuation job did not pass")
    require(len(meta["artifacts"]) == 1, "Unexpected hosted artifact population")
    artifact = meta["artifacts"][0]
    require(artifact["name"] == "v8-primary-continuation-original-evidence"
            and artifact["workflow_run"]["id"] == RUN and artifact["workflow_run"]["head_sha"] == DRIVER,
            "Hosted artifact source identity differs")
    require(args.artifact.stat().st_size == artifact["size_in_bytes"]
            and "sha256:" + digest(args.artifact) == artifact["digest"], "Original hosted ZIP identity differs")
    require(args.original.stat().st_size == 175381869 and digest(args.original) == ORIGINAL_SHA,
            "Original failed campaign ZIP identity differs")
    original, original_hashes = {}, {}
    with zipfile.ZipFile(args.original) as archive:
        for item in archive.infolist():
            name = safe_name(item.filename)
            require(name not in original_hashes and not item.is_dir()
                    and stat.S_IFMT(item.external_attr >> 16) in (0, stat.S_IFREG), "Nonregular/duplicate original ZIP member")
            with archive.open(item) as source:
                original_hashes[name] = {"bytes": item.file_size, "sha256": hashlib.file_digest(source, "sha256").hexdigest()}
            if name in (FIT + "/metrics.jsonl", "v8-support-lifecycle/command-report.json",
                        "v8-support-lifecycle/target-inventory.json", "v8-support-lifecycle/coverage-training-config.json"):
                original[name] = archive.read(item)
    files, captured = {}, {}
    with zipfile.ZipFile(args.artifact) as outer:
        names = [safe_name(info.filename) for info in outer.infolist()]
        require(len(set(names)) == len(names), "Duplicate outer ZIP members")
        packed = [name for name in names if name.endswith("-original-evidence.tar.gz")]
        require(len(packed) == 1, "Continuation transport archive missing/ambiguous")
        transport = parse(outer.read("v8-primary-continuation-transport.json"))
        require(transport["driverRevision"] == DRIVER and transport["producerRevision"] == PRODUCER
                and transport["consumerRevision"] == NATIVE, "Transport source identity differs")
        with outer.open(packed[0]) as stream:
            require(hashlib.file_digest(stream, "sha256").hexdigest() == transport["sha256"]
                    and outer.getinfo(packed[0]).file_size == transport["bytes"], "Inner archive identity differs")
        with outer.open(packed[0]) as stream, tarfile.open(fileobj=stream, mode="r|gz") as archive:
            for item in archive:
                name = safe_name(item.name)
                if item.isdir():
                    continue
                require(item.isfile() and name not in files, "Duplicate or nonregular inner archive member")
                source = archive.extractfile(item)
                h = hashlib.sha256()
                materialize = (name.startswith("v8-support-prepared/") or name.startswith(FIT + "/checkpoints/")
                               or name == "v8-support-lifecycle/served/tokenizer.json")
                collect = name.startswith("v8-primary-continuation/") or name == FIT + "/metrics.jsonl"
                target = args.work / name
                data = io.BytesIO() if materialize or collect else None
                while block := source.read(1024 * 1024):
                    h.update(block)
                    if data is not None:
                        data.write(block)
                files[name] = {"bytes": item.size, "sha256": h.hexdigest()}
                if materialize:
                    write_same(target, data.getvalue())
                if collect:
                    captured[name] = data.getvalue()
                if name in original_hashes and (name.startswith("v8-support-prepared/") or name.startswith(PARTIAL + "/")
                    or name in ("v8-support-lifecycle/command-report.json", "v8-support-lifecycle/target-inventory.json",
                                "v8-support-lifecycle/coverage-training-config.json", "v8-support-lifecycle/served/tokenizer.json")):
                    require(files[name] == original_hashes[name], "Original retained member changed: " + name)
        require(files["v8-primary-original.zip"] == {"bytes": 175381869, "sha256": ORIGINAL_SHA},
                "Embedded original failed ZIP changed")
        prepared = {k: v for k, v in files.items() if k.startswith("v8-support-prepared/")}
        require(prepared == {k: v for k, v in original_hashes.items() if k.startswith("v8-support-prepared/")},
                "Prepared input set/bytes changed")
        preserved = {"v8-support-lifecycle/command-report.json", "v8-support-lifecycle/target-inventory.json",
                     "v8-support-lifecycle/coverage-training-config.json", "v8-support-lifecycle/served/tokenizer.json"}
        preserved.update(name for name in original_hashes if name.startswith(PARTIAL + "/"))
        require(all(files.get(name) == original_hashes[name] for name in preserved), "Original runtime evidence was lost or changed")
        for name in names:
            if name.startswith("v8-primary-continuation/"):
                require(outer.read(name) == captured[name], "Top-level report differs from retained inner archive")
    old_metrics = original[FIT + "/metrics.jsonl"]
    failed_report = parse(original["v8-support-lifecycle/command-report.json"])
    require(failed_report["status"] == "failed" and failed_report["optimizerUpdates"] == 2,
            "Original failed command and separate lifecycle accounting changed")
    new_metrics = captured[FIT + "/metrics.jsonl"]
    require(new_metrics.startswith(old_metrics), "Original metric prefix changed")
    before, added = metrics(old_metrics), metrics(new_metrics[len(old_metrics):])
    require([row["global_step"] for row in before if row.get("event") == "train"] == list(range(1, 315)),
            "Original314 train steps changed")
    require([row["global_step"] for row in added if row.get("event") == "train"] == list(range(315, 349)),
            "Continuation did not perform exactly34 ordered updates")
    require(added[-1]["event"] == "finished" and added[-1]["global_step"] == 348, "Continuation terminal metric missing")
    for stage in ("resume-34-updates", "independent-complete-coverage"):
        receipt = parse(captured["v8-primary-continuation/" + stage + ".receipt.json"])
        require(receipt["exitCode"] == 0 and receipt["timedOut"] is False
                and not receipt["error"] and not receipt["streamErrors"], "Hosted stage did not complete: " + stage)
    result = checkpoint_audit(args, files, original, captured)
    result.update({"schema": "frozen-v8-continuation-independent-audit/1", "status": "passed",
        "run": RUN, "driverRevision": DRIVER, "producerRevision": PRODUCER, "consumerRevision": NATIVE,
        "originalUpdates": 314, "continuationUpdates": 34, "finalTrajectoryUpdates": 348,
        "separateLifecycleUpdates": 2, "originalFailedReportUnchanged": True, "originalMetricsPrefixUnchanged": True,
        "preparedFiles": len(prepared), "transport": transport, "artifact": artifact,
        "learnedSuccess": None, "routerInternalPositionCoverage": "unmeasured", "served348Weights": False,
        "defaultPromotion": False, "hostedIndependentPlannerRebuilt": True,
        "localIndependentPreparedPositionsRebuilt": True, "members": files})
    print(json.dumps(result, indent=2, sort_keys=True, allow_nan=False))


if __name__ == "__main__":
    main()
