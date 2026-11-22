#!/usr/bin/env python3
"""Repeat all original348 pure cases with only rejected-fragment evidence fixed.

Training provenance remains original9cf/1a69. Inference uses original9cf and the
separately pinned three-file native patch. The original failed reports and
unmodified served bundle are inputs, never rewritten or relabelled.
"""
from __future__ import annotations

import argparse
import importlib.util
import importlib.metadata
import json
import os
import platform
import shutil
import signal
import stat
import subprocess
import sys
import time
import zipfile
from pathlib import Path

_spec = importlib.util.spec_from_file_location("original348", Path(__file__).with_name("evaluate-v8-original348-pure.py"))
original348 = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(original348)
require, read, sha, write = original348.require, original348.read_json, original348.sha, original348.write

INFERENCE_NATIVE = "99f018e045e760d802ff65f69bac1435985068aa"
ORIGINAL_RUN = 45046754653
ORIGINAL_ARTIFACT = 14763634179
ARCHIVE_SHA = "2d575cbec0b543e329e68e9bb1289e3a7f33988866a145a9fb3c641a41ff91ad"
ARCHIVE_BYTES = 16427247
PATCH_FILES = {
    "src/megatoken/semantic_model_v8.py": "9021ff40495cffabaeefa19d538fbdebcf8be2de6042a76421dd6e5134c3a09d",
    "tests/fixtures/semantic-v8-original348-invalid-fragments.json.gz.b64": "411e6335f73bb4bc61f4739ec0f8bd1d5c48df4de554542a7514fafbcd2e7c8b",
    "tests/test_semantic_model_v8.py": "723cf747d48da46a5a5d07249f847a55008cd87f2d4f60c4aa6747b4894f3858",
}
PURE_NAMES = {
    "absolute-distance", "capped-budget", "flag-intersection", "flag-union", "inventory-shortfall", "midpoint",
    "modular-clock", "overtime-rate", "parity-adjustment", "rectangle-perimeter", "rectangular-capacity", "relative-growth",
    "squared-distance", "triangular-series", "unit-conversion", "weighted-average",
}


def validate_runtime_change(parent, changed_paths, file_hashes):
    require(parent == original348.NATIVE, "Inference patch must be directly based on original native source")
    require(set(changed_paths) == set(PATCH_FILES) and len(changed_paths) == 3,
            "Inference candidate changes files outside the declared rejected-fragment correction")
    require(file_hashes == PATCH_FILES, "Inference correction source bytes differ")


def frozen_sources(producer, native):
    for path, expected in ((producer, original348.PRODUCER), (native, INFERENCE_NATIVE)):
        require(original348.git(path, "rev-parse", "HEAD") == expected
                and not original348.git(path, "status", "--porcelain", "--untracked-files=all"), "Frozen inference source changed")
    parent = original348.git(native, "rev-parse", "HEAD^")
    changed = original348.git(native, "diff", "--name-only", "HEAD^", "HEAD").splitlines()
    validate_runtime_change(parent, changed, {name: sha(native / name) for name in PATCH_FILES})


def validate_population(profile):
    from collections import Counter
    rows = profile["cases"]
    expected_ids = {"se-support-" + name + "-pure" for name in PURE_NAMES}
    require(profile["declared"] == 16 and len(rows) == 16 and {row["id"] for row in rows} == expected_ids
            and len({row["family"] for row in rows}) == 16
            and Counter(row["split"] for row in rows) == original348.SPLITS, "All original pure cases and splits required")
    expected_splits = {"se-support-absolute-distance-pure": "validation", "se-support-squared-distance-pure": "validation",
                       "se-support-unit-conversion-pure": "validation", "se-support-flag-intersection-pure": "test"}
    require(all(row["split"] == expected_splits.get(row["id"], "train") for row in rows), "Original split assignment changed")
    require(profile["settings"] == original348.SETTINGS and profile["limits"] == original348.LIMITS and profile["seed"] == original348.SEED,
            "Original bounded inference settings changed")
    require(len(profile["unmeasuredProfileCases"]) == 48 and profile["initializedBaseline"] == "unmeasured", "Original unmeasured scope changed")
    return rows


def execute(args):
    producer, native = args.producer.resolve(strict=True), args.native.resolve(strict=True)
    frozen_sources(producer, native)
    require(platform.python_version() == "3.12.14", "Original Python version required")
    packages = {name: importlib.metadata.version(name) for name in ("torch", "numpy", "safetensors", "tokenizers")}
    require(packages == {"torch": "2.10.0+cpu", "numpy": "2.5.5", "safetensors": "0.8.0", "tokenizers": "0.23.3"}, "Original locked packages required")
    require(subprocess.check_output(["node", "--version"], text=True).strip() == "v24.22.3", "Original Node required")
    require(Path("/proc/self/ns/time").is_symlink(), "Genuine Linux time namespace required")
    require(args.archive.stat().st_size == ARCHIVE_BYTES and sha(args.archive) == ARCHIVE_SHA, "Original failed evaluation ZIP differs")
    output, work = args.out.resolve(), args.work.resolve()
    require(not output.exists() and not work.exists(), "New independent output and work directories required")
    for path in (output, work):
        require(not any(path.is_relative_to(source) or source.is_relative_to(path) for source in (producer, native)), "Output overlaps source")
    require(not output.is_relative_to(work) and not work.is_relative_to(output), "Work and output overlap")
    output.mkdir(parents=True)
    work.mkdir(parents=True)
    inventory = {}
    with zipfile.ZipFile(args.archive) as archive:
        for item in archive.infolist():
            name = original348.safe_name(item.filename)
            require(name not in inventory and not item.is_dir() and stat.S_IFMT(item.external_attr >> 16) in (0, stat.S_IFREG), "Duplicate/nonregular original member")
            path = work / name
            path.parent.mkdir(parents=True, exist_ok=True)
            with archive.open(item) as source, path.open("xb") as target:
                shutil.copyfileobj(source, target)
            inventory[name] = {"bytes": path.stat().st_size, "sha256": sha(path)}
    require(len(inventory) == 114, "Original archive member population changed")
    original = work / "original348-pure-evaluation"
    profile = read((original / "predeclared-profile.json").read_bytes())
    cases = validate_population(profile)
    old_report = read((original / "report.json").read_bytes())
    require(old_report["status"] == "measurement-incomplete" and old_report["declared"] == 16,
            "Original failed outcome changed")
    for directory in ("served", "source-cases"):
        shutil.copytree(original / directory, output / directory)
    shutil.copyfile(original / "settings.json", output / "settings.json")
    shutil.copyfile(original / "report.json", output / "original-failed-report.json")
    shutil.copyfile(original / "predeclared-profile.json", output / "original-predeclared-profile.json")
    manifest = read((output / "served/manifest.json").read_bytes())
    lineage = read((output / "served/semantic-v8-lineage.json").read_bytes())
    # The original helper validates the immutable TRAINING pair, not the new
    # inference revision. Never replace consumerRevision in the old lineage.
    identities = original348.validate_export(manifest, lineage)
    original_export = read((original / "export-identities.json").read_bytes())
    bundle_hashes = {path.name: sha(path) for path in (output / "served").iterdir()}
    require(bundle_hashes == original_export["bundleFiles"], "Unmodified actual348 bundle required")
    sys.path.insert(0, str(native / "src"))
    from megatoken.served import ServedBundle
    bundle = ServedBundle(output / "served", device="cpu")
    require(bundle.manifest["model_sha256"] == identities["checkpointIdentity"], "Strict actual348 load differs")
    del bundle
    provenance = {"schema": "semantic-v8-original348-rejection-followup/1", "originalRun": ORIGINAL_RUN, "originalArtifact": ORIGINAL_ARTIFACT,
        "originalArchiveSha256": ARCHIVE_SHA, "trainingSources": {"producer": original348.PRODUCER, "native": original348.NATIVE},
        "inferenceSources": {"producer": original348.PRODUCER, "native": INFERENCE_NATIVE}, "nativePatchFiles": PATCH_FILES,
        "trainingCheckpointSha256": original348.STATE_SHA, "modelVersion": 348, "identities": identities, "bundleFiles": bundle_hashes,
        "settings": original348.SETTINGS, "limits": original348.LIMITS, "seed": original348.SEED,
        "declared": 16, "splitCounts": original348.SPLITS, "cases": cases, "unmeasuredProfileCases": profile["unmeasuredProfileCases"],
        "initializedBaseline": "unmeasured", "originalTrainingLineageModified": False, "optimizerUpdatesPerformed": 0, "defaultPromotion": False}
    provenance["runtime"] = {"python": platform.python_version(), "node": "v24.22.3", "packages": packages, "platform": platform.platform(), "timezone": "UTC"}
    write(output / "predeclared-followup.json", provenance)
    env = {**os.environ, "PYTHONPATH": str(native / "src"), "PYTHONDONTWRITEBYTECODE": "1", "OMP_NUM_THREADS": "1",
           "MKL_NUM_THREADS": "1", "TZ": "UTC", "TRACING_REFERENCE_ISOLATION": "trusted-process"}
    receipts = []

    def run(stage, command, timeout):
        print(json.dumps({"stage": stage, "status": "started"}), flush=True)
        start = time.monotonic()
        process, error, timed_out = None, None, False
        with (output / (stage + ".log")).open("xb") as log:
            try:
                process = subprocess.Popen(command, cwd=producer, env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
                process.wait(timeout=timeout)
            except Exception as failure:
                error, timed_out = str(failure), isinstance(failure, subprocess.TimeoutExpired)
                if process is not None and process.poll() is None:
                    try:
                        os.killpg(process.pid, signal.SIGTERM)
                    except ProcessLookupError:
                        pass
                    try:
                        process.wait(timeout=10)
                    except subprocess.TimeoutExpired:
                        try:
                            os.killpg(process.pid, signal.SIGKILL)
                        except ProcessLookupError:
                            pass
                        process.wait()
        receipt = {"stage": stage, "command": command, "seconds": time.monotonic() - start,
                   "exitCode": None if process is None else process.returncode, "error": error, "timedOut": timed_out, "timeoutSeconds": timeout}
        receipts.append(receipt)
        write(output / (stage + ".receipt.json"), receipt)
        write(output / "commands.json", receipts, replace=True)
        print(json.dumps(receipt), flush=True)
        return receipt

    tool = producer / "tools/run-semantic-v8-experiment.mjs"
    studies, frozen_hashes = {}, {}
    original_frozen = read((original / "all-studies-frozen-before-inference.json").read_bytes())
    for split, count in original348.SPLITS.items():
        selected = [row for row in cases if row["split"] == split]
        write(output / "inputs" / (split + ".json"), [{"id": row["id"], "artifactPath": "../source-cases/" + row["id"] + ".json"} for row in selected])
        study_dir = output / "studies" / split
        study_dir.parent.mkdir(parents=True, exist_ok=True)
        command = ["node", "--experimental-vm-modules", str(tool), "freeze", "--input", str(output / "inputs" / (split + ".json")), "--out", str(study_dir),
            "--model-id", "original-v8-support-step348", "--model-revision", original348.STATE_SHA, "--settings", str(output / "settings.json"),
            "--checkpoint", identities["checkpointIdentity"], "--tokenizer", identities["tokenizerIdentity"], "--training-identity", identities["trainingIdentity"],
            "--origin", "model", "--seed", str(original348.SEED), "--max-predictions", "32", "--max-generated", "128", "--max-outstanding", "16", "--max-stale-retries", "0", "--timeout-ms", "300000"]
        receipt = run("freeze-" + split, command, 120)
        require(receipt["exitCode"] == 0 and receipt["error"] is None, "Original study freeze failed")
        study = read((study_dir / "study.json").read_bytes())
        require(study["declared"] == count, "Frozen split denominator changed")
        for name in ("study.json", "private-cases.json"):
            key = str((study_dir / name).relative_to(output))
            frozen_hashes[key] = sha(study_dir / name)
            require(frozen_hashes[key] == original_frozen["studies"][key], "Follow-up study differs byte-for-byte from original frozen population")
        studies[split] = study
    write(output / "all-studies-frozen-before-inference.json", {**provenance, "studies": frozen_hashes, "modelCallsPerformed": 0})
    observations = []

    def report(status):
        summary = {}
        for split, count in original348.SPLITS.items():
            rows = [row for row in observations if row["split"] == split]
            summary[split] = {"declared": count, "reportsCollected": len(rows), "rateDenominator": count,
                "actualModelMeasured": sum(row["actualModelMeasured"] for row in rows),
                "sourceScoringComplete": sum(row["sourceScoringComplete"] for row in rows),
                "completedExecution": sum(row["completedExecution"] for row in rows),
                "completedExecutionRate": sum(row["completedExecution"] for row in rows) / count,
                "unmeasuredOrUntested": count - sum(row["actualModelMeasured"] for row in rows)}
        return {**provenance, "status": status, "splits": summary, "rows": observations,
                "originalResultRemains": "measurement-incomplete;8provenance-qualified;0complete-programs",
                "full64ProfileQualityMeasured": False}

    write(output / "report.json", report("running"))
    for item in cases:
        split, case_id = item["split"], item["id"]
        case_dir = output / "case-results" / case_id
        case_dir.parent.mkdir(parents=True, exist_ok=True)
        study_dir = output / "studies" / split
        receipt = run("measure-" + case_id, ["node", "--experimental-vm-modules", str(tool), "run", "--study", str(study_dir / "study.json"),
            "--cases", str(study_dir / "private-cases.json"), "--out", str(case_dir), "--megatoken", str(native), "--served", str(output / "served"),
            "--python", sys.executable, "--case", case_id], 330)
        try:
            row = original348.observed_case(read((case_dir / "report.json").read_bytes()), studies[split], case_id, identities)
        except Exception as failure:
            row = {"caseId": case_id, "seed": original348.SEED, "status": "unmeasured", "actualModelMeasured": False,
                   "sourceScoringComplete": False, "sourceValidated": False, "completedExecution": False, "auditFailure": str(failure)}
        row.update({"split": split, "family": item["family"], "processExitCode": receipt["exitCode"], "processError": receipt["error"],
                    "report": str((case_dir / "report.json").relative_to(output))})
        observations.append(row)
        write(output / "report.json", report("running"), replace=True)
    require(all(sha(output / name) == value for name, value in frozen_hashes.items()), "Frozen study changed during follow-up")
    require(bundle_hashes == {path.name: sha(path) for path in (output / "served").iterdir()}, "Original bundle changed during follow-up")
    require(sha(args.archive) == ARCHIVE_SHA and all(sha(work / name) == row["sha256"] for name, row in inventory.items()), "Original input evidence changed")
    frozen_sources(producer, native)
    complete = len(observations) == 16 and all(row["actualModelMeasured"] and row["sourceScoringComplete"] and row["processExitCode"] == 0
                                               and not row["processError"] for row in observations)
    result = report("measurement-complete" if complete else "measurement-incomplete")
    write(output / "report.json", result, replace=True)
    print(json.dumps({"status": result["status"], "splits": result["splits"], "optimizerUpdatesPerformed": 0}), flush=True)
    require(complete, "Follow-up measurement incomplete; retain every original and new failure")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for key in ("archive", "producer", "native", "work", "out"):
        parser.add_argument("--" + key, type=Path, required=True)
    args = parser.parse_args()
    output_existed = args.out.exists()
    try:
        execute(args)
    except Exception as error:
        if not output_existed and args.out.is_dir() and not (args.out / "driver-failure.json").exists():
            write(args.out / "driver-failure.json", {"status": "failed", "type": type(error).__name__, "error": str(error), "optimizerUpdatesPerformed": 0})
        raise


if __name__ == "__main__":
    main()
