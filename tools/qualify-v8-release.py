#!/usr/bin/env python3
"""Qualify direct V8 package/restore from a fresh complete support campaign.

This gate performs the ordinary two-update lifecycle, then packages and
restores its exact checkpoint and served export. It does not run a full fit,
measure learned success, restore accepted live history, or change defaults.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import threading
import time
from pathlib import Path


def require(condition, message):
    if not condition:
        raise ValueError(message)


def read(path):
    def unique(items):
        value = {}
        for key, item in items:
            require(key not in value, "Repeated qualification JSON key")
            value[key] = item
        return value

    return json.loads(path.read_bytes(), object_pairs_hook=unique,
                      parse_constant=lambda value: (_ for _ in ()).throw(ValueError(value)))


def write(path, value):
    with path.open("x") as stream:
        json.dump(value, stream, indent=2, sort_keys=True, allow_nan=False)
        stream.write("\n")


def git(root, *args):
    environment = {name: value for name, value in os.environ.items() if not name.startswith("GIT_")}
    return subprocess.check_output(["git", *args], cwd=root, env=environment, text=True).strip()


def qualify(args):
    producer = Path(__file__).resolve().parents[1]
    native = args.megatoken.resolve(strict=True)
    output = args.out.absolute()
    tokenizer = args.tokenizer.resolve(strict=True)
    policy_path = (args.native_policy or producer / "contracts/semantic-native-policy-v8.json").resolve(strict=True)
    policy = read(policy_path)
    producer_revision, native_revision = git(producer, "rev-parse", "HEAD"), git(native, "rev-parse", "HEAD")
    require(native_revision == policy["consumerRevision"], "Qualification consumer differs from its exact pin")
    require(not git(producer, "status", "--porcelain", "--untracked-files=all") and
            not git(native, "status", "--porcelain", "--untracked-files=all"),
            "Qualification requires clean committed source checkouts")
    require(not output.exists() and output.parent.is_dir(), "Qualification output must be new")
    require(all(not output.is_relative_to(root) and not root.is_relative_to(output)
                for root in (producer, native, tokenizer, policy_path)),
            "Qualification output must be disjoint from source and supplied assets")
    output.mkdir(mode=0o700)
    inputs, logs = output / "original-inputs", output / "logs"
    inputs.mkdir(mode=0o700)
    logs.mkdir(mode=0o700)
    local_tokenizer = inputs / "tokenizer.json"
    shutil.copyfile(tokenizer, local_tokenizer)
    require(hashlib.sha256(local_tokenizer.read_bytes()).hexdigest() == policy["tokenizerSha256"],
            "Production tokenizer differs from the native policy")
    environment = {**os.environ, "PYTHONPATH": str(native / "src"), "PYTHONDONTWRITEBYTECODE": "1",
                   "TRACING_JS_SELF_ROOT": str(producer), "MEGATOKEN_NATIVE_SOURCE_PRODUCER": str(producer),
                   "MEGATOKEN_ROOT": str(native), "MEGATOKEN_PYTHON": args.python,
                   "MEGATOKEN_TOKENIZER_JSON": str(local_tokenizer),
                   "SEMANTIC_V8_NATIVE_POLICY": str(policy_path)}
    stages = []

    def run(name, command, *, timeout=3600, expected_success=True):
        stage = {"name": name, "command": [str(part) for part in command], "status": "running"}
        stages.append(stage)
        print(json.dumps(stage), flush=True)
        started = time.monotonic()
        try:
            with (logs / (name + ".stdout.log")).open("xb") as stdout, \
                    (logs / (name + ".stderr.log")).open("xb") as stderr:
                process = subprocess.Popen(stage["command"], cwd=producer, env=environment,
                                           stdout=subprocess.PIPE, stderr=subprocess.PIPE)

                def forward(source, retained, live):
                    while block := source.read1(65536):
                        retained.write(block)
                        retained.flush()
                        live.write(block)
                        live.flush()

                readers = [threading.Thread(target=forward, args=(source, retained, live))
                           for source, retained, live in ((process.stdout, stdout, sys.stdout.buffer),
                                                         (process.stderr, stderr, sys.stderr.buffer))]
                for reader in readers:
                    reader.start()
                try:
                    process.wait(timeout=timeout)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
                    raise
                finally:
                    for reader in readers:
                        reader.join()
            stage["exitCode"] = process.returncode
            require((process.returncode == 0) is expected_success,
                    "Release qualification stage has an unexpected outcome: " + name)
            stage["status"] = "passed" if expected_success else "refused-as-required"
        except Exception as error:
            stage.update(status="failed", error=str(error))
            raise
        finally:
            stage["seconds"] = time.monotonic() - started
            print(json.dumps(stage), flush=True)
            with (output / "stages.json").open("w") as stream:
                json.dump(stages, stream, indent=2)
                stream.write("\n")

    qualification = inputs / "qualification"
    run("qualify-64", ["node", producer / "tools/qualify-semantic-v8.mjs", "--population", "se-support",
                       "--inputs", "all", "--workers", "2", "--out", qualification,
                       "--megatoken", native, "--python", args.python, "--tokenizer", local_tokenizer,
                       "--native-policy", policy_path])
    report = read(qualification / "report.json")
    registry = read(qualification / "family-registry.json")
    rows, ids = report["rows"], [row["id"] for row in registry["sources"]]
    split_by_id = {source: component["split"] for component in registry["components"]
                   for source in component["sourceIds"]}
    require(report["population"] == "se-support" and report["declared"] == 64 and
            report["sourceQualified"] == report["nativeAdmitted"] == 64 and not report["preparationOnly"] and
            len(rows) == len(set(ids)) == len(ids) == len(split_by_id) == 64 and
            set(report["selectedCaseIds"]) == {row["id"] for row in rows} and
            {row["sourceId"] for row in rows} == set(ids) == set(split_by_id) and
            all(row["source"] == row["native"] == "passed" for row in rows) and
            {split: list(split_by_id.values()).count(split) for split in ("train", "validation", "test")}
            == {"train": 48, "validation": 12, "test": 4}, "Complete frozen 64-source admission did not pass")
    task_binding = inputs / "task-binding-snapshot.json"
    run("bind-original-64-source-tasks", ["node", producer / "tools/verify-v8-release-campaign.mjs",
                                         qualification, "--output", task_binding])
    binding_snapshot = read(task_binding)
    require(binding_snapshot["status"] == "verified" and
            binding_snapshot["taskArtifactBindings"]["checkedAttempts"] == 64 and
            binding_snapshot["taskArtifactBindings"]["checkedCurrentSources"] == 64 and
            all(row["taskArtifactBinding"]["membership"]["sourceId"] == row["id"]
                for row in binding_snapshot["cases"]),
            "Original task to artifact binding did not cover the complete frozen campaign")
    source_inventory = inputs / "source-ids.json"
    write(source_inventory, {"schema": "semantic-v8-source-population/1",
                             "registryDigest": registry["digest"], "sourceIds": ids})
    prepared = inputs / "prepared"
    command = [args.python, native / "scripts/prepare_semantic_v8.py"]
    for row in sorted(rows, key=lambda item: item["sourceId"]):
        source = (qualification / row["sourceArtifact"]).resolve(strict=True)
        require(source.is_relative_to(qualification) and source.is_file(), "Source escaped qualification")
        command.extend(["--input", source])
    command.extend(["--output", prepared, "--producer-root", producer, "--producer-revision", producer_revision,
                    "--consumer-revision", native_revision, "--tokenizer-json", local_tokenizer,
                    "--max-positions", "128", "--max-history", "128"])
    run("prepare-64", command)
    samples = sorted((row for row in rows if split_by_id[row["sourceId"]] == "train" and
                      row["id"].endswith("-child-teacher")), key=lambda row: row["id"])
    require(samples, "The complete support population lacks its training child-teacher sample")
    lifecycle = inputs / "lifecycle"
    run("ordinary-two-update-lifecycle", ["node", producer / "tools/qualify-ordinary-v8-lifecycle.mjs",
          "--prepared-root", prepared, "--source-inventory", source_inventory,
          "--sample-source", qualification / samples[0]["sourceArtifact"], "--out", lifecycle,
          "--megatoken", native, "--python", args.python, "--tokenizer", local_tokenizer,
          "--native-policy", policy_path])
    lifecycle_report = read(lifecycle / "command-report.json")
    require(lifecycle_report["status"] == "passed" and lifecycle_report["populationCount"] == 64 and
            lifecycle_report["optimizerUpdateCounts"] == {"lifecycle": 2, "coverage": 0, "total": 2} and
            lifecycle_report["fullTargetCoverageQualified"] is False and lifecycle_report["learnedSuccess"] is None,
            "Release gate requires exactly the separate ordinary two-update lifecycle")
    checkpoint = lifecycle / "fit/checkpoints/SE-000000002-periodic"
    require(read(checkpoint / "metadata.json")["global_step"] == 2, "Wrong release checkpoint step")
    package = output / "package"
    run("package", [args.python, producer / "tools/package-semantic-release-v8.py",
          "--producer-root", producer, "--megatoken", native, "--python", args.python,
          "--qualification", qualification, "--prepared", prepared, "--tokenizer", local_tokenizer,
          "--checkpoint", checkpoint, "--served", lifecycle / "served",
          "--recipe", lifecycle / "training-config.json", "--out", package])
    package_result = read(package / "package-result.json")
    require(package_result["status"] == "verified", "Direct V8 package verification did not complete")
    archive = package / package_result["archive"]["path"]
    checksum = package_result["archive"]["sha256"]
    # Preserve original bytes while making every original runtime asset locator
    # absent. Restore receives only the archive, its external checksum and exact
    # trusted source checkouts. The package's temporary payload also disappears.
    retained = output / "retained-originals"
    inputs.rename(retained)
    (package / "payload").rename(retained / "packaged-payload")
    require(not inputs.exists() and not (package / "payload").exists(), "Original asset locators remain")
    restored, restore_evidence = output / "restored", output / "restored-verification"
    base = [args.python, producer / "tools/restore-semantic-release-v8.py", "--producer-root", producer,
            "--megatoken", native, "--python", args.python, "--archive", archive]
    wrong_checksum = ("0" if checksum[0] != "0" else "1") + checksum[1:]
    run("refuse-wrong-external-checksum", [*base, "--expected-archive-sha256", wrong_checksum,
          "--out", output / "wrong-checksum-restore", "--evidence-out", output / "wrong-checksum-evidence"],
        expected_success=False)
    require(not (output / "wrong-checksum-restore").exists() and not (output / "wrong-checksum-evidence").exists(),
            "Wrong checksum refusal created a restoration destination")
    run("restore-with-original-locators-absent", [*base, "--expected-archive-sha256", checksum,
          "--out", restored, "--evidence-out", restore_evidence])
    restored_result = read(restore_evidence / "restore-result.json")
    require(restored_result["status"] == "verified" and
            restored_result["freshSourceNativePreparation"] is True and
            restored_result["actualCheckpointAndServedStateCompared"] is True and
            restored_result["acceptedHistoryRecovery"] == "unmeasured" and
            restored_result["optimizerUpdatesPerformed"] == restored_result["decoderForwardPassesPerformed"] == 0 and
            restored_result["learnedSuccess"] is None and restored_result["defaultPromotion"] is False,
            "Restoration did not prove the exact bounded release claims")
    result = {"schema": "semantic-v8-release-qualification/1", "status": "passed",
              "producerRevision": producer_revision, "consumerRevision": native_revision,
              "declaredSources": 64, "sourceQualified": 64, "nativeAdmitted": 64,
              "splitCounts": {"train": 48, "validation": 12, "test": 4},
              "registryDigest": registry["digest"], "archiveSha256": checksum,
              "archiveBytes": package_result["archive"]["bytes"],
              "manifestIdentity": package_result["manifestIdentity"],
              "ordinaryLifecycleOptimizerUpdates": 2, "packageOptimizerUpdates": 0,
              "restoreOptimizerUpdates": 0, "releaseDecoderForwardPasses": 0,
              "freshSourceNativePreparationAtPackageAndRestore": True,
              "originalTaskArtifactBindingsVerified": True,
              "originalRuntimeAssetLocatorsAbsentAtRestore": True,
              "wrongExternalChecksumRefusedBeforeExtraction": True,
              "fullTargetCoverageQualified": False, "acceptedHistoryRecovery": "unmeasured",
              "learnedSuccess": None, "defaultPromotion": False}
    write(output / "qualification-result.json", result)
    print(json.dumps(result, sort_keys=True), flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--megatoken", type=Path, required=True)
    parser.add_argument("--tokenizer", type=Path, required=True)
    parser.add_argument("--native-policy", type=Path)
    parser.add_argument("--python", default=sys.executable)
    parser.add_argument("--out", type=Path, required=True)
    qualify(parser.parse_args())
