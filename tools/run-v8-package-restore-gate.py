#!/usr/bin/env python3
"""Run one bounded exact64 V8 package/restore qualification in CI.

This driver preserves all source qualification inputs, verifies the ordinary
two-update lifecycle, packages the exact checkpoint/export pair, proves a
changed served export is refused, removes the original inputs, and restores
from the archive alone. It does not qualify a complete training pass.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tarfile
from pathlib import Path


def require(condition, message):
    if not condition:
        raise ValueError(message)


def read_json(path):
    return json.loads(path.read_text())


def write_json(path, value):
    path.write_text(json.dumps(value, indent=2, sort_keys=True, allow_nan=False) + "\n")


def run(command, *, cwd, env, log):
    result = subprocess.run(command, cwd=cwd, env=env, text=True, capture_output=True, check=False)
    log.write_text(result.stdout + result.stderr)
    require(result.returncode == 0, f"Command failed ({result.returncode}); see {log}: {result.stderr[-4000:]}")
    return result.stdout


def inspect_qualification(directory, producer, consumer, tokenizer):
    report = read_json(directory / "report.json")
    registry = read_json(directory / "family-registry.json")
    rows = report.get("rows")
    require(report.get("population") == "se-support" and report.get("declared") == 64 and
            report.get("preparationOnly") is False and report.get("sourceQualified") == 64 and
            report.get("nativeAdmitted") == 64 and isinstance(rows, list) and len(rows) == 64,
            "Qualification must admit all 64 exact se-support sources")
    require(report.get("producerRevision") == producer and report.get("nativePolicy", {}).get("consumerRevision") == consumer,
            "Qualification source pair differs from this workflow run")
    ids = [row.get("sourceId") for row in rows]
    require(all(isinstance(value, str) and value for value in ids) and len(set(ids)) == 64,
            "Qualification must contain 64 unique source IDs")
    case_ids = [row.get("id") for row in rows]
    require(all(isinstance(value, str) and value for value in case_ids) and len(set(case_ids)) == 64,
            "Qualification must contain 64 unique case IDs")
    require(all(row.get("source") == row.get("native") == "passed" and
                isinstance(row.get("sourceArtifact"), str) and
                isinstance(row.get("admittedArtifact"), str) and
                isinstance(row.get("nativeReceipt"), dict) for row in rows),
            "Every source must retain original bytes, admitted evidence, and a native receipt")
    require(len({row["sourceArtifact"] for row in rows}) == 64,
            "Every selected source must have a distinct original source artifact")

    split_by_id = {}
    for component in registry.get("components", []):
        for source_id in component.get("sourceIds", []):
            require(source_id not in split_by_id, "Source occurs in multiple frozen split components")
            split_by_id[source_id] = component.get("split")
    require(registry.get("digest") == report.get("registryDigest") and set(split_by_id) == set(ids),
            "Frozen source registry differs from the qualification report")
    split_counts = {split: sum(value == split for value in split_by_id.values())
                    for split in ("train", "validation", "test")}
    require(split_counts == {"train": 48, "validation": 12, "test": 4},
            "Frozen source split must remain 48/12/4")
    inputs = []
    for row in sorted(rows, key=lambda item: item["sourceId"]):
        path = (directory / row["sourceArtifact"]).resolve(strict=True)
        require(path.is_relative_to(directory.resolve()) and path.is_file(),
                "Original selected source file escaped the retained qualification")
        inputs.append((row, path))
    require(len({row["sourceId"] for row, _ in inputs}) == 64, "Sorted original source set is not unique")
    return report, registry, rows, split_counts, inputs


def make_tampered_archive(source, destination, member_name):
    changed = False
    with tarfile.open(source, "r:gz") as original, tarfile.open(destination, "w:gz", format=tarfile.PAX_FORMAT) as output:
        for member in original:
            if member.name == member_name:
                stream = original.extractfile(member)
                require(stream is not None and member.isfile(), "Expected served export is missing from archive")
                payload = stream.read() + b"\x00"
                info = tarfile.TarInfo(member.name)
                info.mode, info.mtime, info.size = member.mode, member.mtime, len(payload)
                info.pax_headers = dict(member.pax_headers)
                output.addfile(info, __import__("io").BytesIO(payload))
                changed = True
            else:
                stream = original.extractfile(member) if member.isfile() else None
                output.addfile(member, stream)
    require(changed, "Could not construct the changed-export refusal control")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--producer-root", type=Path, required=True)
    parser.add_argument("--megatoken", type=Path, required=True)
    parser.add_argument("--python", required=True)
    parser.add_argument("--tokenizer", type=Path, required=True)
    parser.add_argument("--qualification", type=Path, required=True)
    parser.add_argument("--prepared", type=Path, required=True)
    parser.add_argument("--source-inventory", type=Path, required=True)
    parser.add_argument("--lifecycle", type=Path, required=True)
    parser.add_argument("--package", type=Path, required=True)
    parser.add_argument("--restore", type=Path, required=True)
    parser.add_argument("--restore-evidence", type=Path, required=True)
    parser.add_argument("--summary", type=Path, required=True)
    args = parser.parse_args()

    producer, consumer = args.producer_root.resolve(strict=True), args.megatoken.resolve(strict=True)
    out = args.summary.parent.resolve(strict=True)
    env = {**os.environ, "TZ": "UTC", "LC_ALL": "C.UTF-8", "OMP_NUM_THREADS": "1", "MKL_NUM_THREADS": "1",
           "PYTHONPATH": str(consumer / "src"), "PYTHONDONTWRITEBYTECODE": "1"}
    policy = read_json(producer / "contracts/semantic-native-policy-v8.json")
    producer_revision = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=producer, text=True).strip()
    consumer_revision = policy["consumerRevision"]
    require(consumer_revision != "2f3e6cf04aad60473e8ecc67e846e81e5b9dec83",
            "Refusing the stale pre-composition 2f3 native pin")
    require(subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=consumer, text=True).strip() == consumer_revision,
            "Native checkout must equal the exact consumer revision in producer policy")
    qualification = args.qualification.resolve(strict=True)
    report, registry, rows, splits, ordered_inputs = inspect_qualification(
        qualification, producer_revision, consumer_revision, args.tokenizer.resolve(strict=True))
    train_rows = [row for row, _ in ordered_inputs if any(
        row["sourceId"] in component.get("sourceIds", []) and component.get("split") == "train"
        for component in registry.get("components", []))]
    require(train_rows, "Ordinary lifecycle requires a prequalified training source")
    sample_row = min(train_rows, key=lambda row: row["sourceId"])
    sample = (qualification / sample_row["sourceArtifact"]).resolve(strict=True)
    inventory = {"schema": "semantic-v8-source-population/1", "registryDigest": registry["digest"],
                 "sourceIds": [row["sourceId"] for row, _ in ordered_inputs]}
    write_json(args.source_inventory, inventory)

    prepare = [args.python, str(consumer / "scripts/prepare_semantic_v8.py"), "--output", str(args.prepared),
               "--producer-root", str(producer), "--producer-revision", producer_revision,
               "--consumer-revision", consumer_revision, "--tokenizer-json", str(args.tokenizer.resolve(strict=True)),
               "--max-positions", "128", "--max-history", "128"]
    for _, path in ordered_inputs:
        prepare.extend(["--input", str(path)])
    run(prepare, cwd=consumer, env=env, log=out / "prepare-original-sources.log")

    supply = [args.python, str(consumer / "scripts/qualify_semantic_v8_supply.py"),
              "--prepared-root", str(args.prepared), "--expected-source-ids", str(args.source_inventory),
              "--producer-revision", producer_revision, "--consumer-revision", consumer_revision,
              "--registry-digest", registry["digest"], "--tokenizer-json", str(args.tokenizer.resolve(strict=True)),
              "--max-positions", "128", "--max-history", "128", "--output", str(out / "supply.json")]
    run(supply, cwd=consumer, env=env, log=out / "supply.log")
    supply_result = read_json(out / "supply.json")
    population = supply_result.get("population", {})
    require(supply_result.get("status") == "passed" and supply_result.get("sourceRegistryDigest") == registry["digest"] and
            population.get("count") == 64 and
            {key: len(value) for key, value in population.get("bySplit", {}).items()} == splits and
            supply_result.get("optimizerSteps") == 0 and supply_result.get("learnedSuccess") is None,
            "Native preparation supply differs from exact64 qualification")

    lifecycle_command = ["node", str(producer / "tools/qualify-ordinary-v8-lifecycle.mjs"),
                         "--prepared-root", str(args.prepared), "--source-inventory", str(args.source_inventory),
                         "--sample-source", str(sample), "--out", str(args.lifecycle),
                         "--producer-root", str(producer), "--megatoken", str(consumer), "--python", args.python,
                         "--tokenizer", str(args.tokenizer.resolve(strict=True)),
                         "--native-policy", str(producer / "contracts/semantic-native-policy-v8.json")]
    # Deliberately omit --full-target-coverage: this qualifies only resume/export plumbing.
    run(lifecycle_command, cwd=producer, env=env, log=out / "lifecycle.log")
    command_report = read_json(args.lifecycle / "command-report.json")
    lifecycle_summary = read_json(args.lifecycle / "qualification/summary.json")
    position = lifecycle_summary.get("optimizerResumeExport", {}).get("optimizerPositionExposure", {})
    require(command_report.get("status") == "passed" and command_report.get("populationCount") == 64 and
            command_report.get("optimizerUpdates") == 2 and command_report.get("optimizerUpdateCounts") ==
            {"lifecycle": 2, "coverage": 0, "total": 2} and
            command_report.get("fullTargetCoverageRequested") is False and
            command_report.get("fullTargetCoverageQualified") is False and
            command_report.get("targetCoverageStatus") == "not-requested" and
            command_report.get("learnedSuccess") is None and
            command_report.get("supportPopulation", {}).get("fullLaunchQualified") is False and
            position.get("fullPopulationQualified") is False and position.get("routerInternalPositionCoverage") == "unmeasured",
            "Ordinary route must pass exactly two updates without a full-pass/learned claim")
    recipe = args.lifecycle / "training-config.json"
    checkpoint = args.lifecycle / "fit/checkpoints/SE-000000002-periodic"
    served = args.lifecycle / "served"
    require(checkpoint.is_dir() and served.is_dir() and recipe.is_file(),
            "Lifecycle did not preserve the exact SE-000000002-periodic checkpoint/export/config")

    package_command = [args.python, str(producer / "tools/package-semantic-release-v8.py"),
                       "--producer-root", str(producer), "--megatoken", str(consumer), "--python", args.python,
                       "--qualification", str(qualification), "--prepared", str(args.prepared),
                       "--tokenizer", str(args.tokenizer.resolve(strict=True)), "--checkpoint", str(checkpoint),
                       "--served", str(served), "--recipe", str(recipe), "--out", str(args.package),
                       "--source-recheck-timeout-seconds", "30"]
    run(package_command, cwd=producer, env=env, log=out / "package.log")
    package_result = read_json(args.package / "package-result.json")
    archive = args.package / "semantic-v8-release.tar.gz"
    archive_sha = package_result.get("archive", {}).get("sha256")
    require(package_result.get("status") == "verified" and isinstance(archive_sha, str) and len(archive_sha) == 64 and
            package_result.get("optimizerUpdatesPerformed") == 0 and package_result.get("decoderForwardPassesPerformed") == 0 and
            package_result.get("learnedSuccess") is None and package_result.get("defaultPromotion") is False,
            "Package verifier did not pass its bounded no-training profile")
    manifest = read_json(args.package / "payload/release-manifest.json")
    native_summary = manifest.get("nativeVerification", {}).get("summary", {})
    inventory_paths = {row.get("path") for row in manifest.get("files", [])}
    require(manifest.get("qualification", {}).get("declared") == 64 and
            native_summary.get("sourceArtifacts") and len(native_summary["sourceArtifacts"]) == 64 and
            native_summary.get("checkpoint", {}).get("globalStep") == 2 and
            "source-qualification/progress/.campaign.lock" in inventory_paths,
            "Release manifest must bind 64 selected sources and the exact two-update checkpoint")

    # Rehash the outer archive after changing one exported model byte. The
    # restore verifier must still refuse against the sealed member inventory,
    # before creating restore destinations or running native preparation.
    tampered_archive = out / "tampered-served-export.tar.gz"
    make_tampered_archive(archive, tampered_archive, "serving/model.safetensors")
    tampered_sha = hashlib.sha256(tampered_archive.read_bytes()).hexdigest()
    bad_out, bad_evidence = out / "tampered-restore", out / "tampered-restore-evidence"
    negative = subprocess.run([args.python, str(producer / "tools/restore-semantic-release-v8.py"),
                               "--producer-root", str(producer), "--megatoken", str(consumer), "--python", args.python,
                               "--archive", str(tampered_archive), "--expected-archive-sha256", tampered_sha,
                               "--out", str(bad_out), "--evidence-out", str(bad_evidence)],
                              cwd=producer, env=env, text=True, capture_output=True, check=False)
    (out / "tampered-restore.log").write_text(negative.stdout + negative.stderr)
    require(negative.returncode != 0 and "Release member checksum changed: serving/model.safetensors" in negative.stderr and
            not bad_out.exists() and not bad_evidence.exists(),
            "A rehashed archive with a changed served export must refuse before native restoration")

    # Relocation proof: restore after removing original qualification, prepared,
    # tokenizer, lifecycle assets and the package staging tree. Only the sealed
    # archive and trusted source checkouts remain as inputs.
    original_paths = (qualification, args.prepared.resolve(), args.lifecycle.resolve(), args.package / "payload",
                      args.tokenizer.resolve(strict=True), args.source_inventory.resolve(strict=True))
    require(all(not path.is_relative_to(producer) and not path.is_relative_to(consumer) for path in original_paths),
            "Relocation cleanup paths must remain outside trusted source checkouts")
    for path in original_paths:
        require(path.exists(), f"Expected original asset path before relocation cleanup: {path}")
        if path.is_dir():
            shutil.rmtree(path)
        else:
            path.unlink()
        require(not path.exists(), f"Failed to remove original asset path: {path}")
    require(archive.is_file() and package_result == read_json(args.package / "package-result.json"),
            "Relocation must retain only the standalone sealed archive/result")
    restore_command = [args.python, str(producer / "tools/restore-semantic-release-v8.py"),
                       "--producer-root", str(producer), "--megatoken", str(consumer), "--python", args.python,
                       "--archive", str(archive), "--expected-archive-sha256", archive_sha,
                       "--out", str(args.restore), "--evidence-out", str(args.restore_evidence),
                       "--source-recheck-timeout-seconds", "30"]
    run(restore_command, cwd=producer, env=env, log=out / "restore.log")
    restored = read_json(args.restore_evidence / "restore-result.json")
    restored_native = read_json(args.restore_evidence / "native-verification.json")
    require(restored.get("schema") == "semantic-v8-release-restore-result/1" and restored.get("status") == "verified" and
            restored.get("archiveSha256") == archive_sha and restored.get("freshSourceNativePreparation") is True and
            restored.get("actualCheckpointAndServedStateCompared") is True and
            restored.get("optimizerUpdatesPerformed") == 0 and restored.get("decoderForwardPassesPerformed") == 0 and
            restored.get("learnedSuccess") is None and restored.get("defaultPromotion") is False,
            "Relocated release restore did not pass its exact source/data/checkpoint/export verification")
    require(restored_native.get("status") == "passed" and
            len(restored_native.get("sourceArtifacts", [])) == 64 and
            restored_native.get("preparedEquivalence", {}).get("sourceCount") == 64 and
            restored_native.get("checkpoint", {}).get("globalStep") == 2 and
            restored_native.get("optimizerUpdatesPerformed") == 0 and
            restored_native.get("learnedSuccess") is None,
            "Restored native report must independently retain 64 sources and the exact step-2 checkpoint")
    summary = {
        "schema": "semantic-v8-package-restore-gate/1", "status": "passed",
        "producerRevision": producer_revision, "consumerRevision": consumer_revision,
        "qualification": {"declared": 64, "sourceQualified": 64, "nativeAdmitted": 64,
                           "splitCounts": splits, "registryDigest": registry["digest"]},
        "ordinaryLifecycle": {"optimizerUpdates": 2, "checkpointGlobalStep": 2,
                              "fullTargetCoverageRequested": False, "fullTargetCoverageQualified": False,
                              "learnedSuccess": None},
        "packageVerification": {"archiveSha256": archive_sha, "optimizerUpdatesPerformed": 0,
                                 "sourceCount": 64, "globalStep": 2},
        "restoreVerification": {"status": "verified", "optimizerUpdatesPerformed": 0,
                                "restoredSourceCount": len(restored_native["sourceArtifacts"]),
                                "globalStep": 2},
        "changedExportNegative": "refused after outer rehash at sealed archive member inventory before native restore",
        "originalQualificationPreparedLifecycleAndPackageStagingRemovedBeforeRestore": True,
        "completeTrainingPassQualified": False, "learnedSuccess": None, "defaultPromotion": False,
    }
    write_json(args.summary, summary)
    print(json.dumps(summary, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
