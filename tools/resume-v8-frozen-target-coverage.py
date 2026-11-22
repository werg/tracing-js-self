#!/usr/bin/env python3
"""Continue the byte-preserved, interrupted 314/348 V8 diagnostic trajectory.

This driver changes only the per-invocation update cap. Training and independent
coverage validation execute the original producer/native revisions. The original
archive and failed command report are never rewritten or relabeled.
"""
from __future__ import annotations

import argparse
import copy
import hashlib
import importlib.metadata
import json
import os
import platform
import shutil
import stat
import subprocess
import sys
import threading
import time
import zipfile
from dataclasses import asdict
from pathlib import Path, PurePosixPath

PRODUCER = "9cf091e6ccc5add960ef0897576d0c391b199a65"
NATIVE = "1a69d9da3254b7568c831d12866a629c206cf4fe"
ARCHIVE_SHA = "6dc909ecc1c1ed7401fa5ceb1cba7006c07641d530a1550f16a7870af3e483af"
ARCHIVE_BYTES = 175381869
ARCHIVE_EXPANDED_BYTES = 472784236
STATE_SHA = "93828a840122cc2e209e1c448396324595adef476d610770384291847fdc8499"
METADATA_SHA = "e343936b490cbf09eb00064b73eb0baa5faabd2702523c4ce0e683948b8cbbfd"
REGISTRY = "306a20791e1a76fa53872f6b1b856bba66f1308c1428a3a745171d28322b3e6c"
START, END = 314, 348
LIFECYCLE = "v8-support-lifecycle"
FIT = LIFECYCLE + "/fit-coverage"
CHECKPOINT = FIT + "/checkpoints/SE-000000314-interrupted"


def require(value, message):
    if not value:
        raise ValueError(message)


def read_json(data):
    def unique(items):
        value = {}
        for key, item in items:
            require(key not in value, "Duplicate JSON key: " + key)
            value[key] = item
        return value
    return json.loads(data, object_pairs_hook=unique,
                      parse_constant=lambda value: (_ for _ in ()).throw(ValueError(value)))


def sha(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def write(path, value):
    with Path(path).open("x") as stream:
        json.dump(value, stream, indent=2, sort_keys=True, allow_nan=False)
        stream.write("\n")


def validate_member_names(infos):
    names = set()
    for info in infos:
        name = info.filename
        parts = PurePosixPath(name).parts
        require(name and "\\" not in name and not name.startswith("/")
                and all(part not in (".", "..", "") for part in name.rstrip("/").split("/"))
                and parts and name not in names and not info.is_dir()
                and not stat.S_ISLNK(info.external_attr >> 16),
                "Unsafe, duplicate or non-file archive member: " + name)
        names.add(name)
    return names


def continuation_recipe(original, metadata, inventory):
    require(type(metadata.get("global_step")) is int and metadata["global_step"] == START
            and metadata.get("state_sha256") == STATE_SHA and metadata.get("phase") == "SE",
            "The original committed checkpoint must be exactly step314")
    require(type(inventory.get("optimizerWindowCount")) is int
            and inventory["optimizerWindowCount"] == END
            and inventory.get("registryDigest") == REGISTRY,
            "The original complete 348-window inventory changed")
    require(type(original.get("max_steps")) is int and original["max_steps"] == END
            and original.get("semantic_v8_policy") == {
                "schema": "semantic-training-policy/8", "producerRevision": PRODUCER,
                "consumerRevision": NATIVE, "registryDigest": REGISTRY}
            and original.get("purpose") == "diagnostic" and original.get("phase") == "SE"
            and original.get("device") == "cpu" and original.get("precision") == "fp32",
            "The original frozen training recipe changed")
    result = copy.deepcopy(original)
    result["max_steps"] = END - START
    require({key for key in result if result[key] != original[key]} == {"max_steps"},
            "Only the invocation update cap may change")
    return result


def train_steps(data, expected):
    rows = [read_json(line) for line in data.splitlines() if line.strip()]
    steps = [row.get("global_step") for row in rows if row.get("event") == "train"]
    require(steps == list(expected), "Training metric steps are missing, duplicated or reordered")
    return rows


def archive_plan(archive):
    require(archive.stat().st_size == ARCHIVE_BYTES and sha(archive) == ARCHIVE_SHA,
            "The original interrupted archive differs from its externally pinned bytes")
    with zipfile.ZipFile(archive) as bundle:
        infos = bundle.infolist()
        validate_member_names(infos)
        require(len(infos) == 591 and sum(info.file_size for info in infos) == ARCHIVE_EXPANDED_BYTES,
                "The original archive membership or expanded size changed")
        original = read_json(bundle.read(LIFECYCLE + "/coverage-training-config.json"))
        metadata = read_json(bundle.read(CHECKPOINT + "/metadata.json"))
        inventory = read_json(bundle.read(LIFECYCLE + "/target-inventory.json"))
        require(hashlib.sha256(bundle.read(CHECKPOINT + "/metadata.json")).hexdigest() == METADATA_SHA,
                "The original checkpoint metadata changed")
        train_steps(bundle.read(FIT + "/metrics.jsonl"), range(1, START + 1))
        recipe = continuation_recipe(original, metadata, inventory)
        return {"schema": "semantic-v8-frozen-continuation-plan/1", "archiveSha256": ARCHIVE_SHA,
                "archiveBytes": ARCHIVE_BYTES, "originalRun": 45023684906,
                "producerRevision": PRODUCER, "consumerRevision": NATIVE,
                "startingStep": START, "endingStep": END, "additionalUpdates": END - START,
                "originalStateSha256": STATE_SHA, "originalMetadataSha256": METADATA_SHA,
                "recipe": recipe, "optimizerUpdatesPerformed": 0, "learnedSuccess": None}


def git(root, *args):
    env = {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}
    return subprocess.check_output(["git", "-C", str(root), *args], env=env, text=True).strip()


def execute(args, plan):
    producer, native = args.producer.resolve(strict=True), args.native.resolve(strict=True)
    working, output = args.work_root.resolve(strict=True), args.out.absolute()
    for root, revision in ((producer, PRODUCER), (native, NATIVE)):
        require(git(root, "rev-parse", "HEAD") == revision
                and not git(root, "status", "--porcelain", "--untracked-files=all"),
                "Training requires unchanged clean original source revisions")
    require(not output.exists() and output.parent.is_dir(), "Use a new evidence directory")
    recipe = plan["recipe"]
    require(recipe["datasets"] == [str(working / "v8-support-prepared")]
            and recipe["output"] == str(working / FIT)
            and recipe["codec"] == str(producer.parent / "semantic-v8-tokenizer.json"),
            "Frozen path-bound inputs require their exact original physical locators")
    targets = [working / "v8-support-prepared", working / LIFECYCLE,
               working / "v8-support-source-ids.json", Path(recipe["codec"])]
    require(all(not path.exists() and not path.is_symlink() for path in targets),
            "Refuse to replace any existing operational input or output")
    require(not any(output.is_relative_to(root) or root.is_relative_to(output)
                    for root in [producer, native, *targets]), "Evidence must be separate from runtime paths")
    output.mkdir(mode=0o700)
    write(output / "plan.json", plan)
    with zipfile.ZipFile(args.archive) as bundle:
        # Only the runtime copy is writable. The full pinned ZIP remains immutable.
        for info in bundle.infolist():
            name = info.filename
            if name.startswith(("v8-support-prepared/", LIFECYCLE + "/")) or name == "v8-support-source-ids.json":
                path = working / name
                path.parent.mkdir(parents=True, exist_ok=True)
                with path.open("xb") as destination, bundle.open(info) as source:
                    shutil.copyfileobj(source, destination)
        runtime = read_json(bundle.read(FIT + "/runtime.json"))
        original_metrics = bundle.read(FIT + "/metrics.jsonl")
        original_command_report = bundle.read(LIFECYCLE + "/command-report.json")
    shutil.copyfile(working / LIFECYCLE / "served/tokenizer.json", recipe["codec"])
    require(platform.python_version() == runtime["python"], "Original Python runtime is required")
    for package, version in runtime["packages"].items():
        if version is not None:
            require(importlib.metadata.version(package) == version, "Original runtime package changed: " + package)
    sys.path.insert(0, str(native / "src"))
    from megatoken.training.checkpoint import load_checkpoint
    from megatoken.training.config import TrainConfig
    from megatoken.training.engine import _resume_compatible
    from megatoken.training.positions_v8 import validate_position_exposure, _flat_position_rows
    from megatoken.training.semantic_v8 import validate_semantic_v8_target_exposure
    from megatoken.semantic_lineage_v8 import checkpoint_lineage_v8
    checkpoint = working / CHECKPOINT
    before, metadata = load_checkpoint(checkpoint, map_location="cpu")
    require(metadata["global_step"] == before["global_step"] == START and metadata["state_sha256"] == STATE_SHA,
            "Loaded checkpoint does not match the exact original trajectory")
    require(len(before["rank_state"]) == 1
            and {"cursor", "rng", "autoencode"} <= set(before["rank_state"][0])
            and before["optimizer"], "Original optimizer, sampler and RNG are required")
    config = TrainConfig.from_dict(recipe)
    saved_config = copy.deepcopy(before["train_config"])
    _resume_compatible(copy.deepcopy(saved_config), config, False)
    require({key for key in asdict(config) if asdict(config)[key] != saved_config[key]} == {"max_steps"},
            "Normalized configuration changed more than the invocation cap")
    lineage = checkpoint_lineage_v8(before, metadata)
    target = validate_semantic_v8_target_exposure(before["semantic_v8_target_exposure"], registry_digest=REGISTRY)
    position = validate_position_exposure(before["semantic_v8_position_exposure"], registry_digest=REGISTRY,
                                         objective=before["semantic_v8_position_exposure"]["objective"])
    require(target["startingGlobalStep"] == position["startingGlobalStep"] == 0
            and target["optimizerUpdates"] == position["optimizerUpdates"] == START
            and target["lastGlobalStep"] == position["lastGlobalStep"] == START
            and position["digest"] == metadata["semantic_v8_position_digest"],
            "Original committed target and position histories are incomplete")
    old_position_rows = copy.deepcopy(_flat_position_rows(position["sources"]))
    original_prepared = {p.relative_to(working / "v8-support-prepared").as_posix(): sha(p)
                         for p in (working / "v8-support-prepared").rglob("*") if p.is_file()}
    write(output / "preflight.json", {"status": "passed", "globalStep": START,
          "stateSha256": STATE_SHA, "lineage": lineage, "targetDigest": target["digest"],
          "positionDigest": position["digest"], "runtime": runtime,
          "actualPlatform": platform.platform(), "preparedFiles": original_prepared,
          "optimizerUpdatesPerformed": 0, "physicalLocatorsChanged": False})
    del before
    config_path = output / "continuation-training-config.json"
    write(config_path, recipe)
    env = {**os.environ, "PYTHONPATH": str(native / "src"), "OMP_NUM_THREADS": "1", "MKL_NUM_THREADS": "1",
           "TRACING_JS_SELF_ROOT": str(producer), "MEGATOKEN_NATIVE_SOURCE_PRODUCER": str(producer),
           "MEGATOKEN_TOKENIZER_JSON": recipe["codec"], "PYTHONUNBUFFERED": "1"}
    stages = []

    def run(name, command, timeout):
        start = time.monotonic()
        print(json.dumps({"stage": name, "command": command}), flush=True)
        failure = None
        stream_errors = []
        with (output / (name + ".log")).open("xb") as log:
            process = subprocess.Popen(command, cwd=native, env=env, stdout=subprocess.PIPE,
                                       stderr=subprocess.STDOUT)
            def forward():
                try:
                    while block := process.stdout.read1(65536):
                        log.write(block)
                        log.flush()
                        sys.stdout.buffer.write(block)
                        sys.stdout.buffer.flush()
                except Exception as error:
                    stream_errors.append(str(error))
            reader = threading.Thread(target=forward)
            reader.start()
            try:
                process.wait(timeout=timeout)
            except subprocess.TimeoutExpired as error:
                failure = str(error)
            finally:
                if process.poll() is None:
                    process.terminate()
                    try:
                        process.wait(timeout=30)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.wait()
                reader.join()
        stages.append({"stage": name, "command": command, "exitCode": process.returncode,
                       "seconds": time.monotonic() - start, "timedOut": failure is not None,
                       "error": failure, "streamErrors": stream_errors})
        write(output / (name + ".receipt.json"), stages[-1])
        print(json.dumps(stages[-1]), flush=True)
        require(failure is None and not stream_errors and process.returncode == 0,
                "Frozen continuation stage failed: " + name)

    run("resume-34-updates", [sys.executable, "-m", "megatoken", "train", "--config", str(config_path),
                            "--resume", str(checkpoint)], 3600)
    after, final_metadata = load_checkpoint(working / FIT / "checkpoints", map_location="cpu")
    require(after["global_step"] == final_metadata["global_step"] == END, "Continuation did not finish exactly step348")
    require(checkpoint_lineage_v8(after, final_metadata) == lineage, "Continuation changed source/data lineage")
    current_rows = _flat_position_rows(after["semantic_v8_position_exposure"]["sources"])
    for key, previous in old_position_rows.items():
        current = current_rows.get(key)
        # A one-pass continuation cannot revisit or alter any prior physical
        # target receipt; the final independent census also checks this globally.
        require(current == previous, "Continuation replaced or revisited a prior source position history")
    metrics = (working / FIT / "metrics.jsonl").read_bytes()
    require(metrics.startswith(original_metrics), "Original metrics prefix was rewritten")
    new_rows = train_steps(metrics[len(original_metrics):], range(START + 1, END + 1))
    require(new_rows and new_rows[-1].get("event") == "finished"
            and new_rows[-1].get("global_step") == END, "Resumed terminal metric is missing")
    require((working / LIFECYCLE / "command-report.json").read_bytes() == original_command_report,
            "Original failed command report was rewritten")
    require(sha(checkpoint / "state.pt") == STATE_SHA and sha(checkpoint / "metadata.json") == METADATA_SHA,
            "The original partial checkpoint changed")
    require(original_prepared == {p.relative_to(working / "v8-support-prepared").as_posix(): sha(p)
                                 for p in (working / "v8-support-prepared").rglob("*") if p.is_file()},
            "Prepared input bytes changed during continuation")
    coverage_path = output / "target-position-coverage.json"
    run("independent-complete-coverage", [sys.executable, str(native / "scripts/qualify_semantic_v8_target_coverage.py"),
        "--checkpoint", str(working / FIT / "checkpoints"), "--prepared", str(working / "v8-support-prepared"),
        "--expected-source-ids", str(working / "v8-support-source-ids.json"),
        "--inventory", str(working / LIFECYCLE / "target-inventory.json"), "--output", str(coverage_path)], 1800)
    coverage = read_json(coverage_path.read_bytes())
    require(coverage["globalStep"] == END and coverage["comparison"]["exactOnePassCensus"] is True
            and coverage["comparison"]["allPositiveWeightTargetsExposed"] is True
            and coverage["positionComparison"]["exactOnePassPreparedTextPositions"] is True
            and coverage["learnedSuccess"] is None and coverage["routerInternalPositionCoverage"] == "unmeasured",
            "Independent final target/position qualification did not pass")
    require(coverage["inventory"]["positiveWeight"]["logicalTargetCount"] == 696
            and coverage["inventory"]["positiveWeight"]["physicalTargetRecordCount"] == 720,
            "The original complete target population changed")
    require(sha(args.archive) == ARCHIVE_SHA, "The retained original ZIP changed")
    for root, revision in ((producer, PRODUCER), (native, NATIVE)):
        require(git(root, "rev-parse", "HEAD") == revision and
                not git(root, "status", "--porcelain", "--untracked-files=all"), "Frozen source changed")
    write(output / "result.json", {"schema": "semantic-v8-frozen-continuation/1", "status": "passed",
          "producerRevision": PRODUCER, "consumerRevision": NATIVE, "originalRun": 45023684906,
          "originalArchiveSha256": ARCHIVE_SHA, "originalCheckpointStateSha256": STATE_SHA,
          "finalCheckpointStateSha256": final_metadata["state_sha256"], "startingStep": START, "finalStep": END,
          "optimizerUpdatesThisInvocation": END - START, "trajectoryOptimizerUpdates": END,
          "separateLifecycleOptimizerUpdates": 2, "sameTrajectorySourceRuntimeInputs": True,
          "coverageDigest": coverage["digest"], "targetPopulation": coverage["inventory"]["positiveWeight"],
          "positionSummary": coverage["optimizerPositionSummary"], "originalFailedReportUnchanged": True,
          "originalMetricsPrefixUnchanged": True, "routerInternalPositionCoverage": "unmeasured",
          "served348Weights": False, "learnedSuccess": None, "defaultPromotion": False})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", type=Path, required=True)
    parser.add_argument("--producer", type=Path)
    parser.add_argument("--native", type=Path)
    parser.add_argument("--work-root", type=Path)
    parser.add_argument("--out", type=Path)
    parser.add_argument("--plan-only", action="store_true")
    args = parser.parse_args()
    plan = archive_plan(args.archive.resolve(strict=True))
    if args.plan_only:
        print(json.dumps(plan, indent=2, sort_keys=True))
        return
    require(all((args.producer, args.native, args.work_root, args.out)), "Execution requires both frozen checkouts and paths")
    execute(args, plan)


if __name__ == "__main__":
    main()
