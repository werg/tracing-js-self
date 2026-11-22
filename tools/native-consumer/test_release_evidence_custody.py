"""Bounded draft custody controls; no network, archive extraction or training."""
from __future__ import annotations

import copy
import hashlib
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("release_evidence_custody", ROOT / "tools/retain-v8-evidence-plan.py")
driver = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(driver)
LOG = b"complete original failure log\n"


def fixture():
    entry = {"label": "original-failure", "scope": "Original failure remains a failure; no quality claim.",
             "runId": 11, "runAttempt": 1, "sourceRevision": "a" * 40, "conclusion": "failure",
             "workflowPath": ".github/workflows/v8-release-qualification.yml", "artifactId": 22,
             "artifactName": "original-evidence", "archiveBytes": 5, "archiveSha256": "b" * 64,
             "jobs": [{"id": 33, "name": "original-job", "conclusion": "failure", "bytes": len(LOG),
                       "sha256": hashlib.sha256(LOG).hexdigest()}]}
    run = {"id": 11, "run_attempt": 1, "head_sha": "a" * 40, "status": "completed", "conclusion": "failure",
           "path": entry["workflowPath"], "run_started_at": "2026-11-22T00:00:00Z", "updated_at": "2026-11-22T00:10:00Z"}
    artifact = {"id": 22, "name": entry["artifactName"], "expired": False, "created_at": "2026-11-22T00:05:00Z",
                "size_in_bytes": 5, "digest": "sha256:" + "b" * 64,
                "workflow_run": {"id": 11, "head_sha": "a" * 40}}
    jobs = {"total_count": 1, "jobs": [{"id": 33, "name": "original-job", "run_id": 11, "run_attempt": 1,
            "head_sha": "a" * 40, "status": "completed", "conclusion": "failure",
            "started_at": "2026-11-22T00:01:00Z", "completed_at": "2026-11-22T00:09:00Z"}]}
    return entry, run, artifact, jobs


class FakeAPI:
    def __init__(self):
        self.entry, self.run, self.artifact, self.jobs = fixture()
        self.release = {"id": 44, "tag_name": "v8-evidence-run-11-attempt-1", "draft": True,
                        "target_commitish": "a" * 40, "html_url": "https://github.com/werg/tracing-js-self/releases/44"}
        self.assets, self.contents, self.uploads, self.downloads = [], {}, [], []
        self.log = LOG

    def json(self, _method, path):
        if "/actions/artifacts/" in path:
            return copy.deepcopy(self.artifact)
        if path.endswith("/jobs?per_page=100"):
            return copy.deepcopy(self.jobs)
        if "/actions/runs/" in path:
            return copy.deepcopy(self.run)
        if path.endswith("/assets?per_page=100"):
            return copy.deepcopy(self.assets)
        return copy.deepcopy(self.release)

    def tag_commit(self, _tag, _sha):
        return {"status": "absent"}

    def upload(self, _release_id, path, name, _content_type):
        data = path.read_bytes()
        asset = {"id": len(self.assets) + 100, "name": name, "size": len(data), "state": "uploaded"}
        self.assets.append(asset); self.contents[asset["id"]] = data; self.uploads.append(name)
        return copy.deepcopy(asset)

    def download(self, path, destination, size, sha, **_options):
        self.downloads.append(path)
        data = self.log if "/actions/jobs/" in path else self.contents[int(path.rsplit("/", 1)[1])]
        if len(data) != size or hashlib.sha256(data).hexdigest() != sha:
            raise ValueError("Archive differs from its independently retained byte count or SHA-256")
        with destination.open("xb") as stream:
            stream.write(data)
        return {"bytes": size, "sha256": sha}

    def archive_receipt(self, _entry, _output):
        return {"schema": "workflow-artifact-custody/1", "status": "verified",
                "sourceRun": {"id": 11, "attempt": 1, "headSha": "a" * 40, "conclusion": "failure", "url": "run/11"},
                "archive": {"name": "original.zip", "bytes": 5, "sha256": "b" * 64},
                "retainedBytesIndependentlyReread": True,
                "retainedAsset": {"id": 77, "name": "original.zip", "size": 5, "state": "uploaded",
                                  "download_count": len(self.downloads)},
                "retainedReceiptAsset": {"id": 88, "name": "custody-22.json", "bytes": 100, "bindingValidatedByRemoteRead": True},
                "release": {"id": 44, "tag": self.release["tag_name"], "tagBinding": {"status": "absent"},
                            "url": self.release["html_url"], "draft": True}}


class ReleaseEvidenceCustodyTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="release-evidence-custody-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)

    def test_exact_failed_attempt_is_eligible_for_custody_without_becoming_successful(self):
        entry, run, artifact, jobs = fixture()
        plan = {"schema": "v8-evidence-custody-plan/1", "repository": driver.REPOSITORY, "entries": [entry]}
        self.assertIs(driver.validate_plan(plan), plan)
        self.assertEqual(driver.validate_metadata(entry, run, artifact, jobs)["run"]["conclusion"], "failure")

    def test_plan_rejects_type_confusion_missing_logs_and_unbounded_inputs(self):
        for field, value in [("runAttempt", True), ("archiveBytes", 2 * 1024**3 + 1), ("jobs", []),
                             ("sourceRevision", "main"), ("label", "../outside"), ("conclusion", "completed"),
                             ("workflowPath", "../other.yml"), ("archiveSha256", "unknown")]:
            with self.subTest(field=field):
                entry, *_ = fixture(); entry[field] = value
                with self.assertRaises(ValueError):
                    driver.validate_plan({"schema": "v8-evidence-custody-plan/1", "repository": driver.REPOSITORY, "entries": [entry]})

    def test_duplicate_source_attempts_or_archive_identities_are_not_reclassified(self):
        entry, *_ = fixture(); other = copy.deepcopy(entry); other["label"] = "different-label"
        with self.assertRaisesRegex(ValueError, "repeats"):
            driver.validate_plan({"schema": "v8-evidence-custody-plan/1", "repository": driver.REPOSITORY, "entries": [entry, other]})

    def test_strict_plan_json_rejects_duplicate_keys_and_nonfinite_numbers(self):
        for raw in ['{"runId":11,"runId":12}', '{"bytes":NaN}', '{"bytes":Infinity}']:
            with self.subTest(raw=raw), self.assertRaises(ValueError):
                driver.strict_json(raw)

    def test_original_conclusion_source_workflow_and_archive_metadata_are_exact(self):
        for name in ["conclusion", "source", "workflow", "artifact-digest", "artifact-name", "expired"]:
            with self.subTest(name=name):
                entry, run, artifact, jobs = fixture()
                if name == "conclusion": run["conclusion"] = "success"
                elif name == "source": run["head_sha"] = "c" * 40
                elif name == "workflow": run["path"] = ".github/workflows/another.yml"
                elif name == "artifact-digest": artifact["digest"] = "sha256:" + "c" * 64
                elif name == "artifact-name": artifact["name"] = "different"
                else: artifact["expired"] = True
                with self.assertRaises(ValueError): driver.validate_metadata(entry, run, artifact, jobs)

    def test_all_original_attempt_jobs_must_be_present_once(self):
        for name in ["missing", "truncated", "duplicate", "different"]:
            with self.subTest(name=name):
                entry, run, artifact, jobs = fixture()
                if name == "missing": jobs.update(total_count=0, jobs=[])
                elif name == "truncated": jobs["total_count"] = 2
                elif name == "duplicate": jobs["jobs"].append(copy.deepcopy(jobs["jobs"][0])); jobs["total_count"] = 2
                else: jobs["jobs"][0]["id"] = 34
                with self.assertRaises(ValueError): driver.validate_metadata(entry, run, artifact, jobs)

    def test_job_source_attempt_status_conclusion_and_time_are_bound(self):
        for key, value in [("head_sha", "c" * 40), ("run_attempt", 2), ("run_id", 12),
                           ("status", "in_progress"), ("conclusion", "success"),
                           ("completed_at", "2026-11-22T00:11:00Z")]:
            with self.subTest(key=key):
                entry, run, artifact, jobs = fixture(); jobs["jobs"][0][key] = value
                with self.assertRaises(ValueError): driver.validate_metadata(entry, run, artifact, jobs)

    def test_bad_metadata_refuses_before_log_download_or_draft_mutation(self):
        api = FakeAPI(); api.run["conclusion"] = "success"
        with patch.object(driver, "retain_archive") as archive, self.assertRaises(ValueError):
            driver.retain_entry(api, api.entry, self.root / "attempt")
        archive.assert_not_called(); self.assertEqual(api.downloads, []); self.assertEqual(api.uploads, [])

    def test_log_byte_substitution_refuses_before_any_archive_or_draft_mutation(self):
        api = FakeAPI(); api.log = b"different original log\n"
        with patch.object(driver, "retain_archive") as archive, self.assertRaisesRegex(ValueError, "independently retained"):
            driver.retain_entry(api, api.entry, self.root / "attempt")
        archive.assert_not_called(); self.assertEqual(api.uploads, [])

    def test_published_or_retargeted_release_refuses_before_uploading_logs(self):
        for change in [{"draft": False}, {"target_commitish": "c" * 40}]:
            with self.subTest(change=change):
                api = FakeAPI(); receipt = api.archive_receipt(None, None); api.release.update(change)
                with self.assertRaisesRegex(ValueError, "draft or source tag"):
                    driver.checked_draft(api, receipt, api.entry)
                self.assertEqual(api.uploads, [])

    def test_complete_logs_and_receipt_are_reread_and_safe_reuse_never_overwrites(self):
        api = FakeAPI()
        with patch.object(driver, "retain_archive", side_effect=api.archive_receipt):
            first = driver.retain_entry(api, api.entry, self.root / "first")
            uploaded = list(api.uploads)
            second = driver.retain_entry(api, api.entry, self.root / "second")
        self.assertEqual(first, second)
        self.assertEqual(len(uploaded), 2); self.assertEqual(api.uploads, uploaded)
        self.assertEqual(first["sourceConclusion"], "failure")
        self.assertTrue(first["completeJobLogs"][0]["retainedAsset"]["independentlyReread"])
        receipt = json.loads(api.contents[first["completeReceiptAsset"]["id"]])
        self.assertTrue(receipt["allAttemptJobsRetained"]); self.assertFalse(receipt["archiveExecuted"])
        self.assertFalse(receipt["productionPromotion"]); self.assertIsNone(receipt["learnedSuccess"])

    def test_existing_log_asset_with_changed_bytes_is_refused_without_overwrite(self):
        api = FakeAPI()
        with patch.object(driver, "retain_archive", side_effect=api.archive_receipt):
            first = driver.retain_entry(api, api.entry, self.root / "first")
            asset_id = first["completeJobLogs"][0]["retainedAsset"]["id"]
            api.contents[asset_id] = b"x" * len(LOG)
            uploaded = list(api.uploads)
            with self.assertRaisesRegex(ValueError, "independently retained"):
                driver.retain_entry(api, api.entry, self.root / "changed")
        self.assertEqual(api.uploads, uploaded)

    def test_log_changed_after_original_download_cannot_be_rebound_as_new_authority(self):
        api = FakeAPI()
        def changed_local_log(entry, output):
            (output.parent / "complete-job-33.log").write_bytes(b"x" * len(LOG))
            return api.archive_receipt(entry, output)
        with patch.object(driver, "retain_archive", side_effect=changed_local_log):
            with self.assertRaisesRegex(ValueError, "independently pinned bytes"):
                driver.retain_entry(api, api.entry, self.root / "changed-local")
        self.assertEqual(api.uploads, [])


if __name__ == "__main__":
    unittest.main()
