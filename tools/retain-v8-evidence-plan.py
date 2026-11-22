#!/usr/bin/env python3
"""Retain exact completed V8 archives and every original job log as draft assets.

Plans contain explicit observed byte identities. Archive contents are never
extracted or executed. A failed source run remains failed after durable custody.
"""
from __future__ import annotations

import argparse
import contextlib
import hashlib
import importlib.util
import json
import os
import re
import sys
from datetime import datetime
from pathlib import Path

HELPER_SHA256 = "3d14450be68d245c381857f3083ac871944d7fda85adab354839b07dc82ad122"
HELPER = Path(__file__).with_name("retain-workflow-artifact.py")
_source = HELPER.read_bytes()
if len(_source) > 128 * 1024 or hashlib.sha256(_source).hexdigest() != HELPER_SHA256:
    raise ValueError("Pinned archive custody implementation differs")
_spec = importlib.util.spec_from_file_location("v8_custody_helper", HELPER)
custody = importlib.util.module_from_spec(_spec)
exec(compile(_source, str(HELPER), "exec", dont_inherit=True), custody.__dict__)

REPOSITORY = custody.REPOSITORY
BRANCH = "refs/heads/codex/v8-release-evidence-custody-20261122"
PREFIX = "/repos/" + REPOSITORY
MAX_PLAN_BYTES = 128 * 1024
MAX_LOG_BYTES = 64 * 1024**2
CONCLUSIONS = {"success", "failure", "cancelled", "timed_out", "action_required", "neutral", "skipped", "stale", "startup_failure"}
require = custody.require


def canonical(value):
    return (json.dumps(value, sort_keys=True, indent=2, allow_nan=False) + "\n").encode()


def strict_json(data):
    def pairs(items):
        result = {}
        for key, value in items:
            require(key not in result, "Duplicate custody authority key: " + key)
            result[key] = value
        return result

    def invalid(_value):
        raise ValueError("Nonfinite custody JSON number")

    return json.loads(data, object_pairs_hook=pairs, parse_constant=invalid)


def positive(value):
    return type(value) is int and 0 < value < 10**20


def validate_plan(plan):
    require(type(plan) is dict and set(plan) == {"schema", "repository", "entries"} and
            plan["schema"] == "v8-evidence-custody-plan/1" and plan["repository"] == REPOSITORY,
            "Custody plan schema or repository differs")
    entries = plan["entries"]
    require(type(entries) is list and 1 <= len(entries) <= 8, "Custody plan needs one to eight explicit archives")
    labels, artifacts, attempts, jobs = set(), set(), set(), set()
    archive_bytes, log_bytes = 0, 0
    for entry in entries:
        require(type(entry) is dict and set(entry) == {
            "label", "scope", "runId", "runAttempt", "sourceRevision", "conclusion", "workflowPath",
            "artifactId", "artifactName", "archiveBytes", "archiveSha256", "jobs",
        }, "Custody entry fields differ")
        require(isinstance(entry["label"], str) and re.fullmatch(r"[a-z0-9][a-z0-9-]{0,79}", entry["label"]) and
                isinstance(entry["scope"], str) and 0 < len(entry["scope"]) <= 4096,
                "Custody label or historical scope is missing")
        require(all(positive(entry[key]) for key in ("runId", "runAttempt", "artifactId", "archiveBytes")) and
                entry["archiveBytes"] <= 2 * 1024**3 and isinstance(entry["conclusion"], str) and entry["conclusion"] in CONCLUSIONS,
                "Custody run, artifact, byte bound or expected conclusion is invalid")
        require(isinstance(entry["sourceRevision"], str) and re.fullmatch(r"[a-f0-9]{40}", entry["sourceRevision"]) and
                isinstance(entry["archiveSha256"], str) and re.fullmatch(r"[a-f0-9]{64}", entry["archiveSha256"]) and
                isinstance(entry["artifactName"], str) and re.fullmatch(r"[A-Za-z0-9_-]{1,128}", entry["artifactName"]) and
                isinstance(entry["workflowPath"], str) and re.fullmatch(r"\.github/workflows/[a-z0-9-]+\.yml", entry["workflowPath"]),
                "Custody source, archive or workflow pin is malformed")
        attempt = (entry["runId"], entry["runAttempt"])
        require(entry["label"] not in labels and entry["artifactId"] not in artifacts and attempt not in attempts,
                "Custody plan repeats an archive, label or source attempt")
        labels.add(entry["label"]); artifacts.add(entry["artifactId"]); attempts.add(attempt)
        require(type(entry["jobs"]) is list and 1 <= len(entry["jobs"]) <= 32,
                "Custody entry needs its complete bounded original job inventory")
        archive_bytes += entry["archiveBytes"]
        for job in entry["jobs"]:
            require(type(job) is dict and set(job) == {"id", "name", "conclusion", "bytes", "sha256"} and
                    positive(job["id"]) and job["id"] not in jobs and positive(job["bytes"]) and
                    job["bytes"] <= MAX_LOG_BYTES and isinstance(job["conclusion"], str) and job["conclusion"] in CONCLUSIONS and
                    isinstance(job["name"], str) and 0 < len(job["name"]) <= 256 and
                    isinstance(job["sha256"], str) and re.fullmatch(r"[a-f0-9]{64}", job["sha256"]),
                    "Custody original job or exact log identity is invalid")
            jobs.add(job["id"]); log_bytes += job["bytes"]
    require(archive_bytes <= 4 * 1024**3 and log_bytes <= 512 * 1024**2,
            "Custody plan exceeds its total retained byte bound")
    return plan


def validate_metadata(entry, run, artifact, job_inventory):
    custody.validate_attempt_artifact(run, artifact, run_id=entry["runId"], attempt=entry["runAttempt"],
                                     artifact_id=entry["artifactId"], source_sha=entry["sourceRevision"])
    require(run.get("conclusion") == entry["conclusion"] and run.get("path") == entry["workflowPath"],
            "Original conclusion or workflow path differs from the explicit custody plan")
    require(artifact.get("name") == entry["artifactName"] and type(artifact.get("size_in_bytes")) is int and
            artifact["size_in_bytes"] == entry["archiveBytes"] and artifact.get("digest") == "sha256:" + entry["archiveSha256"],
            "Original Actions artifact byte identity or name differs")
    require(type(job_inventory) is dict and type(job_inventory.get("jobs")) is list and
            type(job_inventory.get("total_count")) is int and
            job_inventory["total_count"] == len(job_inventory["jobs"]) == len(entry["jobs"]),
            "Complete original attempt job inventory is missing or truncated")
    expected = {job["id"]: job for job in entry["jobs"]}
    actual = job_inventory["jobs"]
    require(all(type(job) is dict and type(job.get("id")) is int for job in actual) and
            len({job["id"] for job in actual}) == len(actual) and {job["id"] for job in actual} == set(expected),
            "Original attempt job membership differs")
    start, end = datetime.fromisoformat(run["run_started_at"]), datetime.fromisoformat(run["updated_at"])
    for job in actual:
        pin = expected[job["id"]]
        require(type(job.get("run_id")) is int and job["run_id"] == entry["runId"] and
                type(job.get("run_attempt")) is int and job["run_attempt"] == entry["runAttempt"] and
                job.get("head_sha") == entry["sourceRevision"] and job.get("status") == "completed" and
                job.get("name") == pin["name"] and job.get("conclusion") == pin["conclusion"],
                "Original job differs from the exact run, attempt, source or conclusion")
        require(start <= datetime.fromisoformat(job["started_at"]) <=
                datetime.fromisoformat(job["completed_at"]) <= end,
                "Original job falls outside its frozen workflow attempt")
    return {"run": run, "artifact": artifact, "jobs": job_inventory}


def checked_draft(api, receipt, entry):
    release = api.json("GET", PREFIX + f"/releases/{receipt['release']['id']}")
    require(type(release.get("id")) is int and release["id"] == receipt["release"]["id"] and
            release.get("draft") is True and release.get("target_commitish") == entry["sourceRevision"] and
            release.get("tag_name") == receipt["release"]["tag"] and
            api.tag_commit(release["tag_name"], entry["sourceRevision"]) == receipt["release"]["tagBinding"],
            "Evidence draft or source tag changed before retaining complete logs")
    return release


def retain_file(api, release, path, destination, content_type, *, expected_size, expected_sha):
    name, size = path.name, path.stat().st_size
    require(path.is_file() and not path.is_symlink() and size == expected_size,
            "Original retained input changed type or size before upload")
    checksum, counted = hashlib.sha256(), 0
    with path.open("rb") as stream:
        while block := stream.read(min(custody.CHUNK, expected_size - counted + 1)):
            counted += len(block)
            require(counted <= expected_size, "Original retained input grew before upload")
            checksum.update(block)
    digest = checksum.hexdigest()
    require(counted == expected_size and digest == expected_sha,
            "Original retained input changed its independently pinned bytes before upload")
    assets = api.json("GET", PREFIX + f"/releases/{release['id']}/assets?per_page=100")
    require(type(assets) is list and len(assets) < 100, "Evidence asset inventory exceeds its bound")
    matching = [asset for asset in assets if asset.get("name") == name]
    require(len(matching) <= 1, "Ambiguous existing complete-log asset")
    asset = matching[0] if matching else api.upload(release["id"], path, name, content_type)
    require(type(asset.get("id")) is int and asset.get("name") == name and asset.get("state") == "uploaded" and
            type(asset.get("size")) is int and asset["size"] == size,
            "Retained complete-log asset has the wrong identity, state or size")
    reread = api.download(PREFIX + f"/releases/assets/{asset['id']}", destination, size, digest,
                          accept="application/octet-stream")
    require(reread == {"bytes": size, "sha256": digest}, "Retained complete-log bytes differ")
    return {"id": asset["id"], "name": name, **reread, "independentlyReread": True}


def retain_archive(entry, output):
    arguments = [str(HELPER), "--run-id", str(entry["runId"]), "--run-attempt", str(entry["runAttempt"]),
                 "--artifact-id", str(entry["artifactId"]), "--source-sha", entry["sourceRevision"],
                 "--archive-sha256", entry["archiveSha256"], "--archive-bytes", str(entry["archiveBytes"]),
                 "--out", str(output)]
    previous = sys.argv
    try:
        sys.argv = arguments
        with (output.parent / "archive-driver.log").open("x") as log, contextlib.redirect_stdout(log):
            require(custody.main() == 0, "Pinned archive custody driver did not complete")
    finally:
        sys.argv = previous
    return strict_json((output / "custody.json").read_bytes())


def retain_entry(api, entry, output):
    output.mkdir(mode=0o700)
    run = api.json("GET", PREFIX + f"/actions/runs/{entry['runId']}/attempts/{entry['runAttempt']}")
    artifact = api.json("GET", PREFIX + f"/actions/artifacts/{entry['artifactId']}")
    jobs = api.json("GET", PREFIX + f"/actions/runs/{entry['runId']}/attempts/{entry['runAttempt']}/jobs?per_page=100")
    metadata = validate_metadata(entry, run, artifact, jobs)
    (output / "metadata.json").write_bytes(canonical(metadata))
    logs = []
    # Verify every complete original log before any draft mutation. These pins
    # came from separately observed original API bytes, not this download.
    for job in entry["jobs"]:
        path = output / f"complete-job-{job['id']}.log"
        api.download(PREFIX + f"/actions/jobs/{job['id']}/logs", path, job["bytes"], job["sha256"])
        logs.append((job, path))
    archive = retain_archive(entry, output / "archive-custody")
    source_run = archive.get("sourceRun", {})
    require(archive.get("schema") == "workflow-artifact-custody/1" and archive.get("status") == "verified" and
            type(source_run.get("id")) is int and source_run["id"] == entry["runId"] and
            type(source_run.get("attempt")) is int and source_run["attempt"] == entry["runAttempt"] and
            source_run.get("headSha") == entry["sourceRevision"] and
            archive.get("sourceRun", {}).get("conclusion") == entry["conclusion"] and
            archive.get("archive", {}).get("bytes") == entry["archiveBytes"] and
            archive.get("archive", {}).get("sha256") == entry["archiveSha256"] and
            archive.get("retainedBytesIndependentlyReread") is True,
            "Pinned archive custody receipt differs from the explicit plan")
    release = checked_draft(api, archive, entry)
    retained_logs = []
    for job, path in logs:
        asset = retain_file(api, release, path, output / (path.name + ".reread"), "text/plain; charset=utf-8",
                            expected_size=job["bytes"], expected_sha=job["sha256"])
        retained_logs.append({"originalJob": job, "retainedAsset": asset})
    checked_draft(api, archive, entry)
    identity = hashlib.sha256(canonical(entry)).hexdigest()
    receipt = {"schema": "v8-evidence-complete-log-custody/1", "status": "verified", "repository": REPOSITORY,
               "entryIdentity": identity, "original": entry, "sourceRun": archive["sourceRun"],
               "archive": archive["archive"], "archiveAsset": {
                   "id": archive["retainedAsset"]["id"], "name": archive["retainedAsset"]["name"],
                   "bytes": archive["retainedAsset"]["size"], "sha256": entry["archiveSha256"]},
               "archiveReceiptAsset": archive["retainedReceiptAsset"], "release": archive["release"],
               "completeJobLogs": retained_logs, "allAttemptJobsRetained": True,
               "archiveExtracted": False, "archiveExecuted": False, "optimizerUpdates": 0,
               "learnedSuccess": None, "productionPromotion": False}
    path = output / f"complete-custody-{entry['artifactId']}-{identity[:16]}.json"
    receipt_bytes = canonical(receipt)
    path.write_bytes(receipt_bytes)
    receipt_asset = retain_file(api, release, path, output / "complete-custody.reread.json", "application/json",
                                expected_size=len(receipt_bytes), expected_sha=hashlib.sha256(receipt_bytes).hexdigest())
    checked_draft(api, archive, entry)
    return {"label": entry["label"], "sourceConclusion": entry["conclusion"], "entryIdentity": identity,
            "release": archive["release"], "archive": archive["archive"], "completeJobLogs": retained_logs,
            "completeReceiptAsset": receipt_asset, "status": "verified"}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--plan", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    require(args.plan.is_file() and not args.plan.is_symlink() and args.plan.stat().st_size <= MAX_PLAN_BYTES,
            "Custody plan is absent, linked or exceeds its byte bound")
    raw = args.plan.read_bytes()
    plan = validate_plan(strict_json(raw))
    require(os.environ.get("GITHUB_REPOSITORY") == REPOSITORY and
            os.environ.get("GITHUB_REF") == BRANCH and os.environ.get("GITHUB_EVENT_NAME") in {"push", "workflow_dispatch"},
            "Only the explicitly selected repository custody branch may retain evidence")
    require(not args.out.exists(), "Custody output must be a new directory")
    args.out.mkdir(parents=True, mode=0o700)
    api = custody.Repository(os.environ.get("GITHUB_TOKEN"))
    result = {"schema": "v8-evidence-custody-plan-result/1", "status": "running",
              "planSha256": hashlib.sha256(raw).hexdigest(), "workflowRevision": os.environ.get("GITHUB_SHA"),
              "entries": [], "archiveExtracted": False, "optimizerUpdates": 0, "productionPromotion": False}
    try:
        for entry in plan["entries"]:
            result["entries"].append(retain_entry(api, entry, args.out / entry["label"]))
            (args.out / "progress.json").write_bytes(canonical(result))
        result["status"] = "verified"
    except BaseException as error:
        result.update(status="failed", failure={"type": type(error).__name__, "reason": str(error)})
        raise
    finally:
        (args.out / "summary.json").write_bytes(canonical(result))
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
