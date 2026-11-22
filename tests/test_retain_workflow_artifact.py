import importlib.util
import json
import urllib.request
from pathlib import Path

import pytest

MODULE_PATH = Path(__file__).parents[1] / "tools" / "retain-workflow-artifact.py"
SPEC = importlib.util.spec_from_file_location("retain_workflow_artifact", MODULE_PATH)
retain = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(retain)
ApprovedStorageRedirectHandler = retain.ApprovedStorageRedirectHandler
Repository = retain.Repository
validate_receipt_bindings = retain.validate_receipt_bindings
validate_attempt_artifact = retain.validate_attempt_artifact
validate_storage_url = retain.validate_storage_url
retain_receipt_asset = retain.retain_receipt_asset


class Request:
    full_url = "https://artifact.api.github.com/actions/artifacts/1/zip"


def test_artifact_storage_redirects_validate_each_hop_and_bound_chain():
    handler = ApprovedStorageRedirectHandler()
    request = urllib.request.Request(Request.full_url)
    target = "https://signed.store.blob.core.windows.net/download?sig=x"
    assert handler.redirect_request(request, None, 302, "Found", {}, target).full_url == target
    for url in (
        "http://signed.store.blob.core.windows.net/download",
        "https://example.org/archive.zip",
        "https://user:pass@signed.store.blob.core.windows.net/download",
        "https://signed.store.blob.core.windows.net:444/download",
    ):
        with pytest.raises(ValueError, match="Unexpected artifact download destination"):
            handler.redirect_request(request, None, 302, "Found", {}, url)

    handler = ApprovedStorageRedirectHandler()
    for _ in range(5):
        handler.redirect_request(request, None, 302, "Found", {}, target)
    with pytest.raises(ValueError, match="redirect limit"):
        handler.redirect_request(request, None, 302, "Found", {}, target)


def test_final_artifact_download_url_is_revalidated(monkeypatch):
    class FakeResponse:
        closed = False

        def geturl(self):
            return "http://internal.example/redirected"

        def close(self):
            self.closed = True

    response = FakeResponse()

    class FakeOpener:
        def open(self, _location, timeout):
            assert timeout == 60
            return response

    monkeypatch.setattr(urllib.request, "build_opener", lambda _handler: FakeOpener())
    with pytest.raises(ValueError, match="Unexpected artifact download destination"):
        Repository.open_storage_url("https://signed.store.blob.core.windows.net/archive")
    assert response.closed


class FakeRepository(Repository):
    def __init__(self, reference, tags=None):
        self.reference = reference
        self.tags = tags or {}
        self.calls = []

    def json_or_404(self, method, path):
        self.calls.append((method, path))
        return self.reference

    def json(self, method, path, *, payload=None):
        self.calls.append((method, path))
        digest = path.rsplit("/", 1)[-1]
        return self.tags[digest]


def test_draft_tag_binding_allows_absence_and_peels_only_to_exact_source():
    source = "a" * 40
    assert FakeRepository(None).tag_commit("evidence", source) == {"status": "absent"}
    light = FakeRepository({"object": {"type": "commit", "sha": source}})
    assert light.tag_commit("evidence", source) == {
        "status": "present", "refObjectChain": [source],
        "commitSha": source, "peeledTagDepth": 0,
    }

    annotated_sha = "b" * 40
    annotated = FakeRepository(
        {"object": {"type": "tag", "sha": annotated_sha}},
        {annotated_sha: {"object": {"type": "commit", "sha": source}}},
    )
    assert annotated.tag_commit("evidence", source) == {
        "status": "present", "refObjectChain": [annotated_sha, source],
        "commitSha": source, "peeledTagDepth": 1,
    }
    assert len(annotated.calls) == 2

    wrong = FakeRepository({"object": {"type": "commit", "sha": "c" * 40}})
    with pytest.raises(ValueError, match="another source commit"):
        wrong.tag_commit("evidence", source)

    wrong_annotated = FakeRepository(
        {"object": {"type": "tag", "sha": annotated_sha}},
        {annotated_sha: {"object": {"type": "commit", "sha": "c" * 40}}},
    )
    with pytest.raises(ValueError, match="another source commit"):
        wrong_annotated.tag_commit("evidence", source)


def test_attempt_and_artifact_must_bind_run_source_attempt_and_time_interval():
    run = {
        "id": 11, "status": "completed", "run_attempt": 2, "head_sha": "a" * 40,
        "conclusion": "failure", "run_started_at": "2026-11-22T00:00:00Z",
        "updated_at": "2026-11-22T00:10:00Z",
    }
    artifact = {
        "id": 22, "expired": False, "created_at": "2026-11-22T00:05:00Z",
        "workflow_run": {"id": 11, "head_sha": "a" * 40, "run_attempt": 2},
    }
    assert validate_attempt_artifact(run, artifact, run_id=11, attempt=2,
                                     artifact_id=22, source_sha="a" * 40)
    for changed_run, changed_artifact in (
        ({**run, "run_attempt": 1}, artifact),
        ({**run, "head_sha": "b" * 40}, artifact),
        (run, {**artifact, "id": 23}),
        (run, {**artifact, "expired": True}),
        (run, {**artifact, "workflow_run": {"id": 11, "head_sha": "b" * 40, "run_attempt": 2}}),
        (run, {**artifact, "workflow_run": {"id": 11, "head_sha": "a" * 40, "run_attempt": 1}}),
        (run, {**artifact, "created_at": "2026-11-22T00:11:00Z"}),
    ):
        with pytest.raises(ValueError):
            validate_attempt_artifact(changed_run, changed_artifact, run_id=11, attempt=2,
                                      artifact_id=22, source_sha="a" * 40)


def receipt_fixture():
    return {
        "schema": "workflow-artifact-custody/1",
        "status": "verified",
        "repository": "werg/tracing-js-self",
        "sourceRun": {"id": 11, "attempt": 2, "headSha": "a" * 40,
                      "conclusion": "failure", "url": "https://example/run/11"},
        "originalArtifact": {"id": 22, "workflow_run": {"id": 11, "head_sha": "a" * 40}},
        "archive": {"name": "run.zip", "bytes": 123, "sha256": "b" * 64},
        "retainedAsset": {"id": 33, "name": "run.zip", "size": 123, "state": "uploaded"},
        "release": {"id": 44, "tag": "evidence", "tagBinding": {"status": "absent"},
                    "url": "https://example/release/44", "draft": True},
        "retainedBytesIndependentlyReread": True,
        "archiveExtracted": False,
        "optimizerUpdates": 0,
        "learnedSuccess": None,
        "productionPromotion": False,
        "workflowRevision": "d" * 40,
        "python": "3.12",
    }


def test_receipt_rerun_accepts_prior_workflow_revision_but_rejects_stale_bindings():
    expected = receipt_fixture()
    prior = json.loads(json.dumps(expected))
    prior["workflowRevision"] = "e" * 40
    assert validate_receipt_bindings(prior, expected, allow_workflow_revision_change=True)
    for path, value in (
        (("sourceRun", "attempt"), 1),
        (("originalArtifact", "id"), 99),
        (("archive", "sha256"), "f" * 64),
        (("retainedAsset", "size"), 122),
        (("release", "draft"), False),
        (("release", "tagBinding"), {"status": "present", "refObjectChain": ["a" * 40],
                                       "commitSha": "a" * 40, "peeledTagDepth": 0}),
    ):
        changed = json.loads(json.dumps(expected))
        changed[path[0]][path[1]] = value
        with pytest.raises(ValueError, match="differs|names another|overstates"):
            validate_receipt_bindings(changed, expected, allow_workflow_revision_change=True)
    malformed_revision = json.loads(json.dumps(expected))
    malformed_revision["workflowRevision"] = "not-a-sha"
    with pytest.raises(ValueError, match="workflow revision"):
        validate_receipt_bindings(malformed_revision, expected, allow_workflow_revision_change=True)


class FakeReceiptAPI:
    def __init__(self, remote):
        self.remote = remote
        self.uploads = []

    def upload(self, release_id, path, name, content_type):
        self.uploads.append((release_id, path, name, content_type))
        raw = json.dumps(self.remote).encode()
        return {"id": 55, "name": name, "state": "uploaded", "size": len(raw)}

    def download_json_asset(self, _path):
        raw = json.dumps(self.remote).encode()
        return self.remote, len(raw), "0" * 64


def test_existing_receipt_is_reread_without_overwrite_and_new_receipt_is_verified():
    expected = receipt_fixture()
    prior = json.loads(json.dumps(expected))
    prior["workflowRevision"] = "e" * 40
    existing = {"id": 55, "name": "custody-22.json", "state": "uploaded",
                "size": len(json.dumps(prior).encode())}
    api = FakeReceiptAPI(prior)
    result = retain_receipt_asset(api, "/repos/werg/tracing-js-self", 44, [existing],
                                  "custody-22.json", "candidate.json", expected)
    assert result == existing and api.uploads == []

    bad = json.loads(json.dumps(prior))
    bad["archive"]["sha256"] = "f" * 64
    api = FakeReceiptAPI(bad)
    with pytest.raises(ValueError, match="archive binding"):
        retain_receipt_asset(api, "/repos/werg/tracing-js-self", 44, [existing],
                             "custody-22.json", "candidate.json", expected)
    assert api.uploads == []

    api = FakeReceiptAPI(expected)
    uploaded = retain_receipt_asset(api, "/repos/werg/tracing-js-self", 44, [],
                                    "custody-22.json", "candidate.json", expected)
    assert uploaded["name"] == "custody-22.json"
    assert api.uploads == [(44, "candidate.json", "custody-22.json", "application/json")]
