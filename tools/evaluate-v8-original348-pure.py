#!/usr/bin/env python3
"""Measure all 16 original pure programs using the actual frozen step-348 weights.

No training, synthetic selector, answer repair, or current-runtime mutation occurs.
All split studies are frozen before the first model call. Each case uses a fresh
native process so one timeout cannot poison the remaining declared population.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import json
import os
import platform
import re
import shutil
import signal
import stat
import subprocess
import sys
import tarfile
import time
import zipfile
from collections import Counter
from pathlib import Path, PurePosixPath

PRODUCER = "9cf091e6ccc5add960ef0897576d0c391b199a65"
NATIVE = "1a69d9da3254b7568c831d12866a629c206cf4fe"
ARCHIVE_SHA = "c89b297625afe95bff6b378d4338d31e8f45c766ad86ee28350d08822bf22f1c"
ARCHIVE_BYTES = 374757456
ORIGINAL_SHA = "6dc909ecc1c1ed7401fa5ceb1cba7006c07641d530a1550f16a7870af3e483af"
STATE_SHA = "854c37716597b0cb13cece65805ad646ffe837d2ca64bc6de99331bf1bce703a"
TOKENIZER_SHA = "40fb9d7d7795b8bd305aeff39ce9963f3f450915b9553f2938e009be9a1fed60"
TOKENIZER = "7f52faca2fe82273a889023defd2f1a6fd6080a21096ec77e97f4798a0a370b2"
REGISTRY = "306a20791e1a76fa53872f6b1b856bba66f1308c1428a3a745171d28322b3e6c"
TRAINING_LINEAGE = "8d7a1c8252bb239e4e18dd62902aa9265b2ceb992c71cf48b1a7c2afbc12545e"
CHECKPOINT = "v8-support-lifecycle/fit-coverage/checkpoints/SE-000000348-periodic"
SETTINGS = {"device": "cpu", "maxTokens": 128, "maxFragments": 8, "effort": 1}
EMPTY_FIXTURE = {"calls": [], "settlementOrder": None}
LIMITS = {"maxPredictions": 32, "maxGenerated": 128, "maxOutstanding": 16,
          "maxStaleRetries": 0, "timeoutMs": 300000}
SPLITS = {"train": 12, "validation": 3, "test": 1}
SEED = 17
HASH = re.compile(r"[0-9a-f]{64}\Z")


def require(value, message):
    if not value:
        raise ValueError(message)


def read_json(data):
    def unique(items):
        result = {}
        for key, value in items:
            require(key not in result, "Duplicate JSON key: " + key)
            result[key] = value
        return result
    return json.loads(data, object_pairs_hook=unique,
                      parse_constant=lambda value: (_ for _ in ()).throw(ValueError(value)))


def sha(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def write(path, value, *, replace=False):
    path.parent.mkdir(parents=True, exist_ok=True)
    target = path.with_suffix(path.suffix + ".next") if replace else path
    with target.open("x") as stream:
        json.dump(value, stream, sort_keys=True, indent=2, allow_nan=False)
        stream.write("\n")
    if replace:
        target.replace(path)


def safe_name(name):
    path = PurePosixPath(name)
    require(name and not path.is_absolute() and "\\" not in name
            and all(part not in ("", ".", "..") for part in name.split("/")), "Unsafe archive member")
    return name


def git(root, *arguments):
    env = {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}
    return subprocess.check_output(["git", "-C", str(root), *arguments], env=env, text=True).strip()


def frozen_sources(producer, native):
    for path, revision in ((producer, PRODUCER), (native, NATIVE)):
        require(git(path, "rev-parse", "HEAD") == revision
                and not git(path, "status", "--porcelain", "--untracked-files=all"), "Frozen source changed")


def select_inventory(artifacts):
    """Select a predeclared profile, never examples chosen from model outcomes."""
    require(len(artifacts) == 64, "Complete original 64-source inventory required")
    rows = []
    for case_id, artifact in sorted(artifacts.items()):
        require(re.fullmatch(r"[a-z0-9-]+", case_id), "Unsafe case identifier")
        sidecar = artifact["sidecar"]
        require(sidecar["referenceStatus"] == "agreed" and sidecar["familyRegistryDigest"] == REGISTRY,
                "Original source qualification or family registry differs")
        rows.append({"id": case_id, "split": sidecar["split"], "family": sidecar["sourceFamily"]})
    require(Counter(row["split"] for row in rows) == {"train": 48, "validation": 12, "test": 4},
            "Original source split changed")
    pure = [row for row in rows if row["id"].endswith("-pure")]
    require(len(pure) == len({row["family"] for row in pure}) == 16
            and Counter(row["split"] for row in pure) == SPLITS, "Complete pure family population changed")
    for row in pure:
        artifact = artifacts[row["id"]]
        timeline = artifact["public"]["timeline"]
        require(artifact["public"]["schema"] == "semantic-execution/8"
                and len(timeline) == 4
                and [(item["mode"], item["kind"]) for item in timeline[:2]] == [("observed", "program"), ("observed", "invocation")]
                and all(item["mode"] == "generated" for item in timeline[2:]), "Pure case is not the complete single-entry profile")
        fixture = artifact["sidecar"]["sourceArtifact"]["sidecar"]["referenceInput"]["fixture"]
        require(fixture == EMPTY_FIXTURE, "Pure evaluation cannot contain future host answers")
    return pure, [row for row in rows if not row["id"].endswith("-pure")]


def extract_inputs(archive_path, work, output):
    require(archive_path.stat().st_size == ARCHIVE_BYTES and sha(archive_path) == ARCHIVE_SHA,
            "The original successful continuation ZIP changed")
    selected = {"v8-primary-original.zip", "v8-support-lifecycle/served/tokenizer.json",
                *(CHECKPOINT + "/" + name for name in ("state.pt", "metadata.json", "transducer.pt"))}
    seen, inventory = set(), {}
    with zipfile.ZipFile(archive_path) as outer:
        names = [safe_name(info.filename) for info in outer.infolist()]
        require(len(set(names)) == len(names), "Duplicate outer ZIP members")
        with outer.open("v8-primary-continuation-original-evidence.tar.gz") as stream, tarfile.open(fileobj=stream, mode="r|gz") as archive:
            for item in archive:
                name = safe_name(item.name)
                require(name not in seen and (item.isdir() or item.isfile()), "Duplicate or nonregular inner archive member")
                seen.add(name)
                if name not in selected:
                    continue
                require(item.isfile(), "Required source is not a regular file")
                path = work / name
                path.parent.mkdir(parents=True, exist_ok=True)
                with archive.extractfile(item) as source, path.open("xb") as target:
                    shutil.copyfileobj(source, target)
                inventory[name] = {"bytes": path.stat().st_size, "sha256": sha(path)}
    require(set(inventory) == selected, "Missing original checkpoint, tokenizer or source archive")
    original = work / "v8-primary-original.zip"
    require(original.stat().st_size == 175381869 and sha(original) == ORIGINAL_SHA, "Original failed campaign archive changed")
    checkpoint = work / CHECKPOINT
    metadata = read_json((checkpoint / "metadata.json").read_bytes())
    require(metadata["global_step"] == 348 and metadata["state_sha256"] == STATE_SHA
            and sha(checkpoint / "state.pt") == STATE_SHA
            and metadata["semantic_v8_lineage_digest"] == TRAINING_LINEAGE, "Final checkpoint identity differs")
    require(sha(work / "v8-support-lifecycle/served/tokenizer.json") == TOKENIZER_SHA, "Original tokenizer bytes changed")
    artifacts, raw_sources = {}, {}
    with zipfile.ZipFile(original) as archive:
        for item in archive.infolist():
            name = safe_name(item.filename)
            if name.startswith("v8-admitted/") and name.endswith(".admitted.json"):
                require(not item.is_dir() and stat.S_IFMT(item.external_attr >> 16) in (0, stat.S_IFREG), "Nonregular source artifact")
                case_id = Path(name).name.removesuffix(".admitted.json")
                require(case_id not in artifacts, "Duplicate original source ID")
                raw_sources[case_id] = archive.read(item)
                artifacts[case_id] = read_json(raw_sources[case_id])
    pure, unmeasured = select_inventory(artifacts)
    for row in pure:
        data = raw_sources[row["id"]]
        source = output / "source-cases" / (row["id"] + ".json")
        source.parent.mkdir(parents=True, exist_ok=True)
        source.write_bytes(data)
        row["artifactSha256"] = hashlib.sha256(data).hexdigest()
        row["artifactBytes"] = len(data)
    shutil.copyfile(checkpoint / "metadata.json", output / "source-checkpoint-metadata.json")
    return pure, unmeasured, inventory, checkpoint


def validate_export(manifest, lineage):
    require(type(manifest["model_version"]) is int and manifest["model_version"] == 348
            and manifest["checkpoint_sha256"] == STATE_SHA and manifest["codec_fingerprint"] == TOKENIZER
            and manifest["tokenizer_sha256"] == TOKENIZER_SHA and manifest["training_heads"] is False,
            "Export is not the actual frozen step-348 serving bundle")
    require(HASH.fullmatch(manifest["model_sha256"]) and HASH.fullmatch(manifest["semantic_v8_lineage_digest"]),
            "Actual model and serving-lineage identities required")
    require(lineage["training"]["digest"] == TRAINING_LINEAGE and lineage["modelVersion"] == 348
            and lineage["trainingCheckpointSha256"] == STATE_SHA
            and lineage["modelIdentity"] == manifest["model_sha256"]
            and lineage["digest"] == manifest["semantic_v8_lineage_digest"]
            and lineage["training"]["policy"] == {"schema": "semantic-training-policy/8", "producerRevision": PRODUCER,
                "consumerRevision": NATIVE, "registryDigest": REGISTRY}, "Exported lineage differs from the original trajectory")
    return {"checkpointIdentity": manifest["model_sha256"], "tokenizerIdentity": manifest["codec_fingerprint"],
            "trainingIdentity": manifest["semantic_v8_lineage_digest"]}


def observed_case(report, study, case_id, identities):
    require(report["schema"] == "semantic-execution-study-results/8" and report["studyDigest"] == study["digest"]
            and report["origin"] == "model" and report["declared"] == study["declared"]
            and report["settings"] == SETTINGS and report["qualification"]["optimizerSteps"] == 0
            and all(report[key] == value for key, value in identities.items()), "Per-case report changed frozen authority")
    expected_ids = {row["id"] for row in study["cases"]}
    rows = report["rows"]
    require(len(rows) == len(expected_ids) and {(row["caseId"], row["seed"]) for row in rows} == {(name, SEED) for name in expected_ids},
            "Report omitted or duplicated a declared case")
    require(all(row["status"] == "untested" for row in rows if row["caseId"] != case_id), "One-case process measured a different population")
    row = next(row for row in rows if row["caseId"] == case_id)
    result = row.get("result")
    if result is None:
        return {"caseId": case_id, "seed": SEED, "status": row["status"], "actualModelMeasured": False,
                "sourceScoringComplete": False, "completedExecution": False, "sourceValidated": False,
                "failure": row.get("failure"), "costs": None}
    require(result["origin"] == "model" and result["seed"] == SEED and result["optimizerSteps"] == 0
            and result["generationSettings"] == SETTINGS and all(result[key] == value for key, value in identities.items()),
            "Rollout identity or actual-model origin differs")
    attestation = result.get("inferenceIdentity")
    actual = any(item.get("provenanceValidated") is True for item in result["attempts"])
    if actual:
        require(attestation and all(attestation[key] == value for key, value in identities.items())
                and attestation["seed"] == SEED and attestation["generationSettings"] == SETTINGS,
                "Model attempt lacks the frozen runtime attestation")
    require(len(result["attempts"]) <= LIMITS["maxPredictions"], "Prediction budget exceeded")
    complete = row["completedExecution"] is True
    if complete:
        require(actual and row["sourceValidated"] is True and result["sourceValidated"] is True
                and result["completedExecution"] is True and result["publicCompleted"] is True
                and result["publicAccepted"] is True and result["sourceStatus"] == "passed-exact-projection"
                and result["sourceEvidence"]["sourceValidated"] is True
                and result["sourceEvidence"]["exactPublicProjection"] is True,
                "First-record/public-only success cannot stand in for a source-certified full execution")
    return {"caseId": case_id, "seed": SEED, "status": row["status"], "actualModelMeasured": actual,
            "sourceScoringComplete": result.get("sourceEvidence", {}).get("sourceValidated") is True,
            "sourceValidated": row["sourceValidated"] is True, "completedExecution": complete,
            "publicCompleted": result["publicCompleted"] is True, "sourceStatus": result["sourceStatus"],
            "failure": result.get("failure"), "privateScoringFailure": row.get("failure"), "cleanupFailure": result.get("cleanupFailure"),
            "costs": result["costs"], "nextStep": result.get("nextStep"),
            "nativeMetricsBefore": result.get("nativeMetricsBefore"), "nativeMetricsAfter": result.get("nativeMetricsAfter")}


def execute(args):
    producer, native = args.producer.resolve(strict=True), args.native.resolve(strict=True)
    frozen_sources(producer, native)
    require(platform.python_version() == "3.12.14", "Original Python version required")
    packages = {name: importlib.metadata.version(name) for name in ("torch", "numpy", "safetensors", "tokenizers")}
    require(packages == {"torch": "2.10.0+cpu", "numpy": "2.5.5", "safetensors": "0.8.0", "tokenizers": "0.23.3"},
            "Original locked packages required")
    require(subprocess.check_output(["node", "--version"], text=True).strip() == "v24.22.3", "Original Node version required")
    require(Path("/proc/self/ns/time").is_symlink(), "Genuine Linux time namespace required")
    output, work = args.out.resolve(), args.work.resolve()
    require(not output.exists() and not work.exists(), "Evaluation directories must be new")
    for path in (output, work):
        require(not any(path.is_relative_to(root) or root.is_relative_to(path) for root in (producer, native)), "Output overlaps frozen source")
    require(not (output.is_relative_to(work) or work.is_relative_to(output)), "Input work and retained output must be separate")
    output.mkdir(parents=True)
    work.mkdir(parents=True)
    env = {**os.environ, "PYTHONPATH": str(native / "src"), "PYTHONDONTWRITEBYTECODE": "1",
           "OMP_NUM_THREADS": "1", "MKL_NUM_THREADS": "1", "PYTHONUNBUFFERED": "1"}
    receipts = []

    def run(stage, command, timeout, *, required=True):
        print(json.dumps({"stage": stage, "status": "started", "timeoutSeconds": timeout}), flush=True)
        start = time.monotonic()
        error = None
        timed_out = False
        process = None
        with (output / (stage + ".log")).open("xb") as log:
            try:
                process = subprocess.Popen(command, cwd=producer, env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
                process.wait(timeout=timeout)
            except Exception as failure:
                error = str(failure)
                timed_out = isinstance(failure, subprocess.TimeoutExpired)
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
        receipt = {"stage": stage, "command": command, "exitCode": None if process is None else process.returncode,
                   "seconds": time.monotonic() - start, "error": error, "timedOut": timed_out, "timeoutSeconds": timeout}
        write(output / (stage + ".receipt.json"), receipt)
        receipts.append(receipt)
        print(json.dumps(receipt), flush=True)
        if required:
            require(error is None and receipt["exitCode"] == 0, "Evaluation stage failed: " + stage)
        return receipt

    pure, unmeasured, input_inventory, checkpoint = extract_inputs(args.archive.resolve(strict=True), work, output)
    write(output / "predeclared-profile.json", {"schema": "semantic-v8-original348-pure-profile/1",
        "continuationRun": 45043236761, "continuationArtifact": 14763057413, "archiveSha256": ARCHIVE_SHA,
        "producerRevision": PRODUCER, "consumerRevision": NATIVE, "trainingCheckpointSha256": STATE_SHA,
        "modelVersion": 348, "seed": SEED, "settings": SETTINGS, "limits": LIMITS,
        "declared": 16, "splitCounts": SPLITS, "cases": pure, "unmeasuredProfileCases": unmeasured,
        "unmeasuredProfileReason": "Other48 profiles need explicit multi-root/session or cache/recovery scheduling; no quality claim is made for them",
        "inputMembers": input_inventory, "runtime": {"python": platform.python_version(), "packages": packages, "platform": platform.platform()},
        "optimizerUpdatesPerformed": 0, "initializedBaseline": "unmeasured", "defaultPromotion": False})
    served = output / "served"
    run("export-actual348", [sys.executable, "-m", "megatoken", "export", "--checkpoint", str(checkpoint),
        "--output", str(served), "--codec", str(work / "v8-support-lifecycle/served/tokenizer.json")], 600)
    manifest = read_json((served / "manifest.json").read_bytes())
    lineage = read_json((served / "semantic-v8-lineage.json").read_bytes())
    identities = validate_export(manifest, lineage)
    sys.path.insert(0, str(native / "src"))
    from megatoken.semantic_lineage_v8 import validate_served_lineage_v8
    validate_served_lineage_v8(lineage, manifest)
    for file, field in (("model.safetensors", "model_sha256"), ("tokenizer.json", "tokenizer_sha256"),
                        ("model_config.json", "config_sha256"), ("transducer.pt", "transducer_sha256"),
                        ("semantic-v8-lineage.json", "semantic_v8_lineage_sha256")):
        require(sha(served / file) == manifest[field], "Actual serving bundle file changed: " + file)
    bundle_hashes = {file.name: sha(file) for file in served.iterdir() if file.is_file()}
    write(output / "export-identities.json", {**identities, "modelVersion": 348, "trainingCheckpointSha256": STATE_SHA,
        "producerRevision": PRODUCER, "consumerRevision": NATIVE, "bundleFiles": bundle_hashes,
        "optimizerUpdatesPerformed": 0})
    write(output / "settings.json", SETTINGS)
    tool = str(producer / "tools/run-semantic-v8-experiment.mjs")
    studies, frozen_hashes = {}, {}
    for split, count in SPLITS.items():
        selected = [row for row in pure if row["split"] == split]
        write(output / "inputs" / (split + ".json"), [{"id": row["id"], "artifactPath": "../source-cases/" + row["id"] + ".json"} for row in selected])
        study_dir = output / "studies" / split
        study_dir.parent.mkdir(parents=True, exist_ok=True)
        command = ["node", "--experimental-vm-modules", tool, "freeze", "--input", str(output / "inputs" / (split + ".json")),
            "--out", str(study_dir), "--model-id", "original-v8-support-step348", "--model-revision", STATE_SHA,
            "--settings", str(output / "settings.json"), "--checkpoint", identities["checkpointIdentity"],
            "--tokenizer", identities["tokenizerIdentity"], "--training-identity", identities["trainingIdentity"],
            "--origin", "model", "--seed", str(SEED), "--max-predictions", str(LIMITS["maxPredictions"]),
            "--max-generated", str(LIMITS["maxGenerated"]), "--max-outstanding", str(LIMITS["maxOutstanding"]),
            "--max-stale-retries", str(LIMITS["maxStaleRetries"]), "--timeout-ms", str(LIMITS["timeoutMs"])]
        run("freeze-" + split, command, 120)
        study = read_json((study_dir / "study.json").read_bytes())
        require(study["declared"] == count and study["seeds"] == [SEED] and study["origin"] == "model"
                and study["settings"] == SETTINGS and study["limits"] == LIMITS
                and {row["id"] for row in study["cases"]} == {row["id"] for row in selected}
                and all(study[key] == value for key, value in identities.items()), "Frozen study authority differs")
        require(all(row["request"]["fixture"] == EMPTY_FIXTURE
                    and all(item["mode"] == "observed" for item in row["request"]["initialPublic"]["timeline"])
                    and "expectedArtifact" not in row for row in study["cases"]), "Private answers leaked into frozen live inputs")
        studies[split] = study
        for name in ("study.json", "private-cases.json"):
            frozen_hashes[str((study_dir / name).relative_to(output))] = sha(study_dir / name)
    write(output / "all-studies-frozen-before-inference.json", {"identities": identities, "studies": frozen_hashes,
        "declared": 16, "splitCounts": SPLITS, "modelCallsPerformed": 0, "optimizerUpdatesPerformed": 0})

    observations = []
    def report(status):
        summaries = {}
        for split, count in SPLITS.items():
            rows = [row for row in observations if row["split"] == split]
            successful = sum(row["completedExecution"] for row in rows)
            summaries[split] = {"declared": count, "reportsCollected": len(rows),
                "actualModelMeasured": sum(row["actualModelMeasured"] for row in rows),
                "sourceScoringComplete": sum(row["sourceScoringComplete"] for row in rows),
                "completedExecution": successful, "completedExecutionRate": successful / count,
                "rateDenominator": count, "unmeasuredOrUntested": count - sum(row["actualModelMeasured"] for row in rows)}
        return {"schema": "semantic-v8-original348-pure-evaluation/1", "status": status,
            "producerRevision": PRODUCER, "consumerRevision": NATIVE, "trainingCheckpointSha256": STATE_SHA,
            "modelVersion": 348, "identities": identities, "settings": SETTINGS, "limits": LIMITS, "seed": SEED,
            "declared": 16, "splits": summaries, "rows": observations, "unmeasuredProfileCases": unmeasured,
            "full64ProfileQualityMeasured": False, "initializedBaseline": "unmeasured",
            "qualityScope": "Exact source-certified whole pure programs; first-record correctness is secondary and never a success substitute",
            "optimizerUpdatesPerformed": 0, "defaultPromotion": False}

    write(output / "report.json", report("running"))
    for item in pure:
        split, case_id = item["split"], item["id"]
        study_dir = output / "studies" / split
        case_dir = output / "case-results" / case_id
        case_dir.parent.mkdir(parents=True, exist_ok=True)
        command = ["node", "--experimental-vm-modules", tool, "run", "--study", str(study_dir / "study.json"),
            "--cases", str(study_dir / "private-cases.json"), "--out", str(case_dir), "--megatoken", str(native),
            "--served", str(served), "--python", sys.executable, "--case", case_id]
        receipt = run("measure-" + case_id, command, 330, required=False)
        try:
            measured = read_json((case_dir / "report.json").read_bytes())
            row = observed_case(measured, studies[split], case_id, identities)
        except Exception as error:
            row = {"caseId": case_id, "seed": SEED, "status": "unmeasured", "actualModelMeasured": False,
                   "sourceScoringComplete": False,
                   "completedExecution": False, "sourceValidated": False, "auditFailure": str(error), "costs": None}
        row.update({"split": split, "family": item["family"], "processExitCode": receipt["exitCode"],
                    "processError": receipt["error"], "report": str((case_dir / "report.json").relative_to(output))})
        observations.append(row)
        write(output / "report.json", report("running"), replace=True)
    require(all(sha(output / name) == value for name, value in frozen_hashes.items()), "Frozen study changed during inference")
    require(bundle_hashes == {file.name: sha(file) for file in served.iterdir() if file.is_file()}, "Served weights changed during inference")
    require(sha(checkpoint / "state.pt") == STATE_SHA and sha(args.archive) == ARCHIVE_SHA, "Source checkpoint/archive changed")
    frozen_sources(producer, native)
    measured_all = len(observations) == 16 and all(row["actualModelMeasured"] and row["sourceScoringComplete"] and row["processExitCode"] == 0
                                                   and not row["processError"] for row in observations)
    result = report("measurement-complete" if measured_all else "measurement-incomplete")
    write(output / "report.json", result, replace=True)
    write(output / "commands.json", receipts)
    print(json.dumps({"status": result["status"], "splits": result["splits"], "optimizerUpdatesPerformed": 0}), flush=True)
    require(measured_all, "Actual model measurement is incomplete; preserve every failure and unmeasured case")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", type=Path, required=True)
    parser.add_argument("--producer", type=Path, required=True)
    parser.add_argument("--native", type=Path, required=True)
    parser.add_argument("--work", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    output_existed = args.out.exists()
    try:
        execute(args)
    except Exception as error:
        if not output_existed and args.out.is_dir() and not (args.out / "driver-failure.json").exists():
            write(args.out / "driver-failure.json", {"status": "failed", "type": type(error).__name__,
                "error": str(error), "optimizerUpdatesPerformed": 0})
        raise


if __name__ == "__main__":
    main()
