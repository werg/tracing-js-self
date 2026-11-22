#!/usr/bin/env python3
"""Preserve exact completed-run ZIP bytes as an unpublished repository asset.

The archive is never extracted or executed. A retained failure stays a failure;
custody of bytes grants no source, model, release or deployment qualification.
"""
from __future__ import annotations

import argparse
import hashlib
import http.client
import json
import os
import re
import sys
import urllib.parse
import urllib.request
from datetime import datetime
from pathlib import Path
from urllib.request import HTTPRedirectHandler

REPOSITORY = "werg/tracing-js-self"
MAX_JSON = 8 * 1024 * 1024
CHUNK = 1024 * 1024
MAX_REDIRECTS = 5
STORAGE_HOST_SUFFIXES = (".blob.core.windows.net", ".amazonaws.com", ".githubusercontent.com")


def require(condition, message):
    if not condition:
        raise ValueError(message)


def validate_storage_url(value):
    try:
        parsed = urllib.parse.urlsplit(value)
        port = parsed.port
    except (TypeError, ValueError) as error:
        raise ValueError("Malformed artifact storage redirect") from error
    host = (parsed.hostname or "").lower()
    require(parsed.scheme == "https" and host and
            (host.endswith(STORAGE_HOST_SUFFIXES) or host == "githubusercontent.com") and
            parsed.username is None and parsed.password is None and
            port in (None, 443) and not parsed.fragment,
            "Unexpected artifact download destination")


class ApprovedStorageRedirectHandler(HTTPRedirectHandler):
    """Bound and revalidate every redirect hop; never add the repository token."""

    def __init__(self):
        super().__init__()
        self.redirects = 0

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        self.redirects += 1
        require(self.redirects <= MAX_REDIRECTS, "Artifact storage redirect limit exceeded")
        validate_storage_url(urllib.parse.urljoin(req.full_url, newurl))
        return super().redirect_request(req, fp, code, msg, headers, newurl)


class Repository:
    def __init__(self, token):
        require(bool(token), "A repository-scoped workflow token is required")
        self.token = token

    def response(self, method, path, *, payload=None, accept="application/vnd.github+json"):
        require(path.startswith(f"/repos/{REPOSITORY}/"), "Unexpected repository API path")
        connection = http.client.HTTPSConnection("api.github.com", timeout=60)
        body = None if payload is None else json.dumps(payload).encode()
        headers = {"Authorization": "Bearer " + self.token, "Accept": accept,
                   "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "v8-artifact-custody"}
        if body is not None:
            headers["Content-Type"] = "application/json"
        connection.request(method, path, body=body, headers=headers)
        return connection, connection.getresponse()

    def json(self, method, path, *, payload=None):
        connection, response = self.response(method, path, payload=payload)
        try:
            require(200 <= response.status < 300,
                    f"GitHub metadata request failed with HTTP {response.status}: {method} {path}")
            data = response.read(MAX_JSON + 1)
            require(len(data) <= MAX_JSON, "GitHub metadata exceeded its byte bound")
            return json.loads(data)
        finally:
            connection.close()

    def json_or_404(self, method, path):
        connection, response = self.response(method, path)
        try:
            if response.status == 404:
                return None
            require(200 <= response.status < 300,
                    f"GitHub metadata request failed with HTTP {response.status}: {method} {path}")
            data = response.read(MAX_JSON + 1)
            require(len(data) <= MAX_JSON, "GitHub metadata exceeded its byte bound")
            return json.loads(data)
        finally:
            connection.close()

    @staticmethod
    def open_storage_url(location):
        validate_storage_url(location)
        opener = urllib.request.build_opener(ApprovedStorageRedirectHandler())
        response = opener.open(location, timeout=60)
        try:
            validate_storage_url(response.geturl())
        except BaseException:
            response.close()
            raise
        return response

    def download_json_asset(self, path):
        connection, response = self.response("GET", path, accept="application/octet-stream")
        remote = None
        try:
            if response.status in (301, 302, 303, 307, 308):
                remote = self.open_storage_url(response.getheader("Location") or "")
                stream = remote
            else:
                require(response.status == 200, f"Receipt download failed with HTTP {response.status}")
                stream = response
            data = stream.read(MAX_JSON + 1)
            require(len(data) <= MAX_JSON, "Retained custody receipt exceeded its byte bound")
            return json.loads(data), len(data), hashlib.sha256(data).hexdigest()
        finally:
            if remote is not None:
                remote.close()
            connection.close()

    def download(self, path, destination, expected_size, expected_sha, *, accept="application/vnd.github+json"):
        connection, response = self.response("GET", path, accept=accept)
        remote = None
        try:
            if response.status in (301, 302, 303, 307, 308):
                location = response.getheader("Location")
                # The signed URL gets no repository token or Authorization header;
                # the opener validates every later hop as well.
                remote = self.open_storage_url(location or "")
                stream = remote
            else:
                require(response.status == 200, f"Archive download failed with HTTP {response.status}")
                stream = response
            checksum, size = hashlib.sha256(), 0
            with destination.open("xb") as output:
                while block := stream.read(CHUNK):
                    size += len(block)
                    require(size <= expected_size, "Archive exceeds its independently retained size")
                    checksum.update(block)
                    output.write(block)
                output.flush()
                os.fsync(output.fileno())
            require(size == expected_size and checksum.hexdigest() == expected_sha,
                    "Archive differs from its independently retained byte count or SHA-256")
            return {"bytes": size, "sha256": checksum.hexdigest()}
        finally:
            if remote is not None:
                remote.close()
            connection.close()

    def upload(self, release_id, path, name, content_type):
        connection = http.client.HTTPSConnection("uploads.github.com", timeout=120)
        route = f"/repos/{REPOSITORY}/releases/{release_id}/assets?" + urllib.parse.urlencode({"name": name})
        try:
            with path.open("rb") as stream:
                headers = {"Authorization": "Bearer " + self.token, "Accept": "application/vnd.github+json",
                           "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "v8-artifact-custody",
                           "Content-Type": content_type, "Content-Length": str(path.stat().st_size)}
                connection.request("POST", route, body=stream, headers=headers)
                response = connection.getresponse()
                require(response.status == 201, f"Asset upload failed with HTTP {response.status}")
                data = response.read(MAX_JSON + 1)
                require(len(data) <= MAX_JSON, "Asset response exceeded its byte bound")
                return json.loads(data)
        finally:
            connection.close()

    def tag_commit(self, tag, source_sha):
        """Read an existing tag without creating one; a draft may remain untagged."""
        route = f"/repos/{REPOSITORY}/git/ref/tags/{urllib.parse.quote(tag, safe='')}"
        reference = self.json_or_404("GET", route)
        if reference is None:
            return {"status": "absent"}
        require(type(reference) is dict, "Evidence tag reference is malformed")
        seen = set()
        chain = []
        obj = reference.get("object")
        for _ in range(MAX_REDIRECTS):
            require(isinstance(obj, dict) and
                    isinstance(obj.get("sha"), str) and
                    re.fullmatch(r"[a-f0-9]{40}", obj["sha"]),
                    "Evidence tag has a malformed Git object")
            object_type, sha = obj.get("type"), obj["sha"]
            require(sha not in seen, "Evidence tag contains a cyclic annotated-tag chain")
            seen.add(sha)
            chain.append(sha)
            if object_type == "commit":
                require(sha == source_sha, "Evidence tag points to another source commit")
                return {"status": "present", "refObjectChain": chain,
                        "commitSha": sha, "peeledTagDepth": len(seen) - 1}
            require(object_type == "tag", "Evidence tag does not resolve to a commit")
            tagged = self.json("GET", f"/repos/{REPOSITORY}/git/tags/{sha}")
            obj = tagged.get("object")
        raise ValueError("Evidence annotated-tag chain exceeds its explicit depth bound")


def validate_receipt_bindings(actual, expected, *, allow_workflow_revision_change):
    require(type(actual) is dict and actual.get("schema") == "workflow-artifact-custody/1"
            and actual.get("status") == "verified", "Retained custody receipt schema/status differs")
    require(actual.get("repository") == expected["repository"],
            "Retained custody receipt repository differs")
    source_names = ("id", "attempt", "headSha", "conclusion", "url")
    require(type(actual.get("sourceRun")) is dict and
            all(type(actual["sourceRun"].get(name)) is type(expected["sourceRun"].get(name)) and
                actual["sourceRun"].get(name) == expected["sourceRun"].get(name)
                for name in source_names),
            "Retained custody receipt names another run or attempt")
    actual_artifact = actual.get("originalArtifact")
    require(type(actual_artifact) is dict, "Retained custody receipt artifact binding is malformed")
    actual_workflow = actual_artifact.get("workflow_run") or {}
    expected_workflow = expected["originalArtifact"].get("workflow_run") or {}
    require(type(actual_workflow) is dict and
            type(actual_artifact.get("id")) is type(expected["originalArtifact"].get("id")) and
            actual_artifact.get("id") == expected["originalArtifact"].get("id") and
            actual_workflow.get("id") == expected_workflow.get("id") and
            actual_workflow.get("head_sha") == expected_workflow.get("head_sha"),
            "Retained custody receipt names another source artifact")
    actual_artifact_attempt = actual_workflow.get("run_attempt")
    expected_artifact_attempt = expected_workflow.get("run_attempt")
    require(actual_artifact_attempt is None or
            type(actual_artifact_attempt) is int and
            actual_artifact_attempt == expected["sourceRun"]["attempt"],
            "Retained custody receipt artifact attempt differs")
    require(expected_artifact_attempt is None or
            type(expected_artifact_attempt) is int and
            expected_artifact_attempt == expected["sourceRun"]["attempt"],
            "Expected artifact attempt differs from the exact source run")
    for name in ("name", "bytes", "sha256"):
        actual_archive = actual.get("archive")
        require(type(actual_archive) is dict and
                type(actual_archive.get(name)) is type(expected["archive"].get(name)) and
                actual_archive.get(name) == expected["archive"].get(name),
                "Retained custody receipt archive binding differs")
    for name in ("id", "name", "size", "state"):
        actual_asset = actual.get("retainedAsset")
        require(type(actual_asset) is dict and
                type(actual_asset.get(name)) is type(expected["retainedAsset"].get(name)) and
                actual_asset.get(name) == expected["retainedAsset"].get(name),
                "Retained custody receipt archive asset differs")
    for name in ("id", "tag", "tagBinding", "url", "draft"):
        actual_release = actual.get("release")
        require(type(actual_release) is dict and
                type(actual_release.get(name)) is type(expected["release"].get(name)) and
                actual_release.get(name) == expected["release"].get(name),
                "Retained custody receipt draft release binding differs")
    require(actual.get("retainedBytesIndependentlyReread") is True and
            actual.get("archiveExtracted") is False and
            type(actual.get("optimizerUpdates")) is int and actual.get("optimizerUpdates") == 0 and
            actual.get("learnedSuccess") is None and
            actual.get("productionPromotion") is False,
            "Retained custody receipt overstates its evidence")
    if allow_workflow_revision_change:
        revision = actual.get("workflowRevision")
        require(revision is None or isinstance(revision, str) and
                re.fullmatch(r"[a-f0-9]{40}", revision),
                "Retained custody receipt workflow revision is malformed")
    else:
        require(actual.get("workflowRevision") == expected.get("workflowRevision"),
                "Retained custody receipt workflow revision differs")
    return True


def validate_attempt_artifact(run, artifact, *, run_id, attempt, artifact_id, source_sha):
    require(type(run) is dict and type(artifact) is dict,
            "Workflow attempt or artifact metadata is malformed")
    require(type(run.get("id")) is int and run["id"] == run_id and
            run.get("status") == "completed" and run.get("head_sha") == source_sha and
            type(run.get("run_attempt")) is int and run["run_attempt"] == attempt and
            isinstance(run.get("conclusion"), str) and bool(run["conclusion"]),
            "Workflow attempt is unfinished or differs from the exact source pin")
    workflow_run = artifact.get("workflow_run") or {}
    artifact_attempt = workflow_run.get("run_attempt", attempt) if type(workflow_run) is dict else None
    require(type(workflow_run) is dict and type(artifact.get("id")) is int and
            artifact["id"] == artifact_id and artifact.get("expired") is False and
            type(workflow_run.get("id")) is int and workflow_run.get("id") == run_id and
            workflow_run.get("head_sha") == source_sha and
            type(artifact_attempt) is int and artifact_attempt == attempt,
            "Artifact is expired or belongs to another run/source")
    date = lambda value: datetime.fromisoformat(value)
    require(date(run["run_started_at"]) <= date(artifact["created_at"]) <= date(run["updated_at"]),
            "Artifact creation falls outside the requested workflow attempt")
    return {"run": run, "artifact": artifact}


def retain_receipt_asset(api, prefix, release_id, assets, name, candidate_path, expected):
    matching = [item for item in assets if item.get("name") == name]
    require(len(matching) <= 1, "Ambiguous existing custody receipt asset")
    receipt_asset = matching[0] if matching else api.upload(
        release_id, candidate_path, name, "application/json"
    )
    require(type(receipt_asset.get("id")) is int and receipt_asset.get("name") == name and
            receipt_asset.get("state") == "uploaded" and
            type(receipt_asset.get("size")) is int and
            0 < receipt_asset["size"] <= MAX_JSON,
            "Custody receipt asset is incomplete or exceeds its byte bound")
    retained, byte_count, _digest = api.download_json_asset(
        prefix + f"/releases/assets/{receipt_asset['id']}"
    )
    require(byte_count == receipt_asset["size"],
            "Retained custody receipt byte count differs from its asset metadata")
    validate_receipt_bindings(retained, expected, allow_workflow_revision_change=True)
    return receipt_asset


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--run-attempt", required=True)
    parser.add_argument("--artifact-id", required=True)
    parser.add_argument("--source-sha", required=True)
    parser.add_argument("--archive-sha256", required=True)
    parser.add_argument("--archive-bytes", required=True, type=int)
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args()
    require(all(re.fullmatch(r"[1-9][0-9]{0,19}", value) for value in (args.run_id, args.run_attempt, args.artifact_id)),
            "Exact positive run, attempt and artifact IDs are required")
    require(re.fullmatch(r"[a-f0-9]{40}", args.source_sha) and
            re.fullmatch(r"[a-f0-9]{64}", args.archive_sha256), "Exact source and independently retained archive pins are required")
    require(0 < args.archive_bytes <= 2 * 1024**3, "Archive byte count must be within the explicit 2 GiB limit")
    require(os.environ.get("GITHUB_REPOSITORY") == REPOSITORY, "Run this custody task only in its declared repository")
    require(not args.out.exists(), "Custody output must be a new directory")
    args.out.mkdir(parents=True, mode=0o700)
    api = Repository(os.environ.get("GITHUB_TOKEN"))
    prefix = f"/repos/{REPOSITORY}"
    run = api.json("GET", prefix + "/actions/runs/" + args.run_id + "/attempts/" + args.run_attempt)
    artifact = api.json("GET", prefix + "/actions/artifacts/" + args.artifact_id)
    validate_attempt_artifact(
        run, artifact, run_id=int(args.run_id), attempt=int(args.run_attempt),
        artifact_id=int(args.artifact_id), source_sha=args.source_sha,
    )
    name = f"semantic-v8-run-{args.run_id}-artifact-{args.artifact_id}.zip"
    archive = args.out / name
    verified = api.download(prefix + "/actions/artifacts/" + args.artifact_id + "/zip",
                            archive, args.archive_bytes, args.archive_sha256)
    # No release is created until the independent byte count and digest match.
    tag = "v8-evidence-run-" + args.run_id + "-attempt-" + args.run_attempt
    releases = []
    for page in range(1, 101):
        batch = api.json("GET", prefix + f"/releases?per_page=100&page={page}")
        require(isinstance(batch, list), "Malformed release list")
        releases.extend(item for item in batch if item.get("tag_name") == tag)
        if len(batch) < 100:
            break
    else:
        raise ValueError("Release inventory exceeds the explicit review bound")
    require(len(releases) <= 1, "Ambiguous existing evidence release")
    tag_before_release = api.tag_commit(tag, args.source_sha)
    if releases:
        release = releases[0]
        require(type(release.get("id")) is int and release.get("tag_name") == tag and
                release.get("draft") is True and release.get("target_commitish") == args.source_sha,
                "Existing evidence release is published or names another source")
    else:
        release = api.json("POST", prefix + "/releases", payload={
            "tag_name": tag, "target_commitish": args.source_sha, "draft": True, "prerelease": True,
            "name": "Retained V8 evidence from run " + args.run_id,
            "body": "Unpublished custody copy of original Actions archive bytes.\n\n"
                    f"Original run: https://github.com/{REPOSITORY}/actions/runs/{args.run_id}\n"
                    f"Original conclusion: {run['conclusion']}\nExact source: `{args.source_sha}`\n"
                    f"Archive SHA-256: `{args.archive_sha256}`\nArchive bytes: {args.archive_bytes}\n\n"
                    "The ZIP is unchanged and has not been extracted or executed by this custody workflow. "
                    "Retaining it makes no new semantic, optimizer, learned-quality, production-release or default-promotion claim."
        })
    tag_binding = api.tag_commit(tag, args.source_sha)
    require(tag_before_release["status"] == "absent" or tag_binding == tag_before_release,
            "Existing evidence tag changed while checking the draft release")
    assets = api.json("GET", prefix + f"/releases/{release['id']}/assets?per_page=100")
    require(len(assets) < 100, "Evidence asset inventory exceeds its explicit bound")
    matching = [item for item in assets if item["name"] == name]
    require(len(matching) <= 1, "Ambiguous existing archive asset")
    asset = matching[0] if matching else api.upload(release["id"], archive, name, "application/zip")
    require(type(asset.get("id")) is int and asset.get("name") == name and
            asset.get("state") == "uploaded" and asset.get("size") == args.archive_bytes,
            "Retained asset is incomplete or has a different size")
    reread = api.download(prefix + f"/releases/assets/{asset['id']}", args.out / "verified-retained-copy.zip",
                          args.archive_bytes, args.archive_sha256, accept="application/octet-stream")
    require(verified == reread, "Retained asset reread differs")
    final_release = api.json("GET", prefix + f"/releases/{release['id']}")
    require(type(final_release.get("id")) is int and final_release["id"] == release["id"] and
            final_release.get("tag_name") == tag and final_release.get("draft") is True and
            final_release.get("target_commitish") == args.source_sha,
            "Evidence release changed during retention")
    final_tag_binding = api.tag_commit(tag, args.source_sha)
    require(final_tag_binding == tag_binding,
            "Evidence tag appeared or changed during retention")
    receipt = {"schema": "workflow-artifact-custody/1", "status": "verified", "repository": REPOSITORY,
               "sourceRun": {"id": run["id"], "attempt": run["run_attempt"], "headSha": run["head_sha"], "conclusion": run["conclusion"],
                             "url": run["html_url"]}, "originalArtifact": artifact,
               "archive": {"name": name, **verified}, "retainedAsset": asset,
               "release": {"id": release["id"], "tag": tag, "tagBinding": tag_binding,
                           "url": final_release["html_url"], "draft": True},
               "retainedBytesIndependentlyReread": True, "archiveExtracted": False,
               "optimizerUpdates": 0, "learnedSuccess": None, "productionPromotion": False,
               "workflowRevision": os.environ.get("GITHUB_SHA"), "python": sys.version}
    receipt_path = args.out / "custody.json"
    receipt_name = f"custody-{args.artifact_id}.json"
    receipt_candidate = args.out / "custody-upload.json"
    receipt_candidate.write_text(json.dumps(receipt, indent=2, sort_keys=True) + "\n")
    receipt_asset = retain_receipt_asset(
        api, prefix, release["id"], assets, receipt_name, receipt_candidate, receipt
    )
    receipt["retainedReceiptAsset"] = {
        "id": receipt_asset["id"], "name": receipt_asset["name"], "bytes": receipt_asset["size"],
        "bindingValidatedByRemoteRead": True,
    }
    receipt_path.write_text(json.dumps(receipt, indent=2, sort_keys=True) + "\n")
    print(json.dumps({"status": "verified", "release": receipt["release"], "assetId": asset["id"],
                      "archive": receipt["archive"], "receipt": str(receipt_path)}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
