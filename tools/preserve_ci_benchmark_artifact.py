#!/usr/bin/env python3
"""Preserve one frozen native CI ZIP through connector-sized exact binary parts.

This transport does not generate, prepare, evaluate, or optimize a corpus.
Only the original artifact explicitly bound below can be downloaded.
"""

import argparse
import hashlib
import json
import os
from pathlib import Path
import sys
import urllib.error
import urllib.parse
import urllib.request


REPOSITORY = "werg/tracing-js-self"
RUN_ID = 44321402524
ARTIFACT_ID = 14435564274
ARTIFACT_NAME = "semantic-v5-benchmark-v1-admission-and-evaluation"
SOURCE_REVISION = "1e2e6a0de8952c4349edbeef46ab70c4a06f8157"
CONSUMER_REVISION = "6b4382b9af3bef120ca3a95ae24d35154d4cd66b"
EXPECTED_BYTES = 874061909
EXPECTED_SHA256 = "8aea8598302d2e675ac7be4003e3f185e87106f2c4010ed1c2ebde54056b8a7e"
PART_BYTES = 400 * 1024 * 1024
BLOCK_BYTES = 1024 * 1024
API_ROOT = f"https://api.github.com/repos/{REPOSITORY}"
METADATA_URL = f"{API_ROOT}/actions/artifacts/{ARTIFACT_ID}"
DOWNLOAD_URL = f"{METADATA_URL}/zip"
RUN_URL = f"{API_ROOT}/actions/runs/{RUN_ID}"
REDIRECT_CODES = {301, 302, 303, 307, 308}


class PreservationError(Exception):
    """A fixed, credential-free diagnostic suitable for a public CI log."""


def require(condition, reason):
    if not condition:
        raise PreservationError(reason)


class NoAutomaticRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, new_url):
        return None


def open_once(request, opener):
    try:
        return opener.open(request, timeout=60)
    except urllib.error.HTTPError as error:
        if error.code in REDIRECT_CODES:
            return error
        raise PreservationError(f"HTTP status {error.code}") from None


def api_response(url, token, opener):
    require(url in {METADATA_URL, DOWNLOAD_URL, RUN_URL}, "Unexpected authenticated API endpoint")
    require(bool(token), "GITHUB_TOKEN is required")
    return open_once(urllib.request.Request(url, headers={
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "frozen-native-artifact-preservation/1",
    }), opener)


def api_json(url, token, opener):
    with api_response(url, token, opener) as response:
        require(response.status == 200, "Unexpected metadata response or redirect")
        body = response.read(BLOCK_BYTES + 1)
        require(len(body) <= BLOCK_BYTES, "Metadata response exceeds limit")
    return json.loads(body)


def validate_metadata(metadata, run):
    require(metadata.get("id") == ARTIFACT_ID, "Artifact ID mismatch")
    require(metadata.get("name") == ARTIFACT_NAME, "Artifact name mismatch")
    require(metadata.get("size_in_bytes") == EXPECTED_BYTES, "Artifact byte count mismatch")
    require(metadata.get("digest") == f"sha256:{EXPECTED_SHA256}", "Artifact API digest mismatch")
    require(metadata.get("expired") is False, "Artifact is expired")
    identity = metadata.get("workflow_run", {})
    require(identity.get("id") == RUN_ID, "Artifact source run mismatch")
    require(identity.get("head_sha") == SOURCE_REVISION, "Artifact source revision mismatch")
    require(run.get("id") == RUN_ID and run.get("head_sha") == SOURCE_REVISION,
            "Workflow run identity mismatch")
    require(run.get("status") == "completed" and run.get("conclusion") == "success",
            "Source workflow is not successfully completed")


def validate_blob_location(location):
    require(isinstance(location, str), "Missing artifact redirect")
    parsed = urllib.parse.urlsplit(location)
    require(parsed.scheme == "https" and parsed.hostname is not None,
            "Artifact redirect must use HTTPS")
    require(parsed.username is None and parsed.password is None and parsed.port in {None, 443},
            "Unexpected redirect credentials or port")
    require(not parsed.fragment, "Unexpected artifact redirect fragment")
    host = parsed.hostname.lower()
    require(any(host.endswith(suffix) for suffix in (
        ".blob.core.windows.net", ".actions.githubusercontent.com", ".githubusercontent.com",
    )), "Unexpected artifact blob host")
    return location


def download_original(target, token, opener):
    response = api_response(DOWNLOAD_URL, token, opener)
    redirects = 0
    while response.status in REDIRECT_CODES:
        location = response.headers.get("Location")
        response.close()
        redirects += 1
        require(redirects <= 4, "Artifact redirect limit exceeded")
        # A fresh request carries no Authorization, cookies, or GitHub headers.
        location = validate_blob_location(location)
        response = open_once(urllib.request.Request(location, headers={
            "User-Agent": "frozen-native-artifact-preservation/1",
        }), opener)
    partial = target.with_suffix(target.suffix + ".partial")
    count = 0
    digest = hashlib.sha256()
    with response:
        require(response.status == 200, "Unexpected artifact download response")
        length = response.headers.get("Content-Length")
        require(length is None or int(length) == EXPECTED_BYTES, "Download length header mismatch")
        with partial.open("xb") as output:
            for block in iter(lambda: response.read(BLOCK_BYTES), b""):
                count += len(block)
                require(count <= EXPECTED_BYTES, "Download exceeds frozen byte count")
                digest.update(block)
                output.write(block)
            output.flush()
            os.fsync(output.fileno())
    require(count == EXPECTED_BYTES, "Incomplete original ZIP download")
    require(digest.hexdigest() == EXPECTED_SHA256, "Original ZIP SHA-256 mismatch")
    partial.rename(target)


def split_and_verify(source, directory, *, part_bytes=PART_BYTES,
                     expected_bytes=EXPECTED_BYTES, expected_sha256=EXPECTED_SHA256):
    require(source.stat().st_size == expected_bytes, "Original ZIP size changed before splitting")
    parts = []
    whole = hashlib.sha256()
    offset = 0
    with source.open("rb") as original:
        while offset < expected_bytes:
            length = min(part_bytes, expected_bytes - offset)
            name = f"benchmark-original.zip.part{len(parts) + 1:03d}"
            digest = hashlib.sha256()
            written = 0
            with (directory / name).open("xb") as output:
                while written < length:
                    block = original.read(min(BLOCK_BYTES, length - written))
                    require(bool(block), "Original ZIP ended while splitting")
                    output.write(block)
                    digest.update(block)
                    whole.update(block)
                    written += len(block)
                output.flush()
                os.fsync(output.fileno())
            parts.append({"file": name, "offset": offset, "bytes": written,
                          "sha256": digest.hexdigest()})
            offset += written
        require(original.read(1) == b"", "Original ZIP has unexpected trailing bytes")
    require(whole.hexdigest() == expected_sha256, "Original ZIP changed while splitting")
    reconstructed = hashlib.sha256()
    reconstructed_bytes = 0
    for part in parts:
        with (directory / part["file"]).open("rb") as stream:
            for block in iter(lambda: stream.read(BLOCK_BYTES), b""):
                reconstructed.update(block)
                reconstructed_bytes += len(block)
    require(reconstructed_bytes == expected_bytes and reconstructed.hexdigest() == expected_sha256,
            "Part reconstruction differs from the original ZIP")
    return {"schema": "exact-zip-parts/1", "wholeFile": source.name,
            "wholeBytes": expected_bytes, "wholeSha256": expected_sha256,
            "partSizeBytes": part_bytes, "parts": parts, "concatenateInListedOrder": True,
            "verifiedReconstructedSha256": reconstructed.hexdigest()}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()
    args.output_dir.mkdir(parents=True, exist_ok=True)
    token = os.environ.get("GITHUB_TOKEN", "")
    opener = urllib.request.build_opener(NoAutomaticRedirect())
    metadata = api_json(METADATA_URL, token, opener)
    run = api_json(RUN_URL, token, opener)
    validate_metadata(metadata, run)
    original = args.output_dir / f"{ARTIFACT_NAME}.zip"
    download_original(original, token, opener)
    index = split_and_verify(original, args.output_dir)
    require(len(index["parts"]) == 3, "Unexpected frozen artifact partition count")
    index.update({
        "sourceRepository": REPOSITORY, "sourceWorkflowRunId": RUN_ID,
        "sourceArtifactId": ARTIFACT_ID, "sourceArtifactName": ARTIFACT_NAME,
        "sourceProducerRevision": SOURCE_REVISION, "sourceConsumerRevision": CONSUMER_REVISION,
        "apiSizeAndDigestVerified": True,
        "sourceRunCompletedSuccessfully": True,
        "scope": "Byte-identical transport of one existing artifact; no native rerun or learned-success claim.",
    })
    (args.output_dir / "reconstruction.json").write_text(json.dumps(index, indent=2) + "\n")
    print(json.dumps({"status": "original-zip-preserved", "sourceRunId": RUN_ID,
                      "bytes": EXPECTED_BYTES, "sha256": EXPECTED_SHA256,
                      "parts": index["parts"]}))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        # urllib exceptions can contain SAS query strings; never print them or a traceback.
        reason = str(error) if isinstance(error, PreservationError) else type(error).__name__
        print(json.dumps({"status": "failed", "reason": reason}), file=sys.stderr)
        raise SystemExit(1)
