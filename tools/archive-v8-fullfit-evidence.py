#!/usr/bin/env python3
"""Preserve one unchanged, audited diagnostic fit as an unpublished GitHub draft.

This archives evidence only. It never trains, publishes a release, selects a
production model, overwrites an existing asset, or executes archive contents.
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import io
import json
import os
import stat
import subprocess
import tarfile
import zipfile
from pathlib import Path, PurePosixPath

REPOSITORY = "werg/tracing-js-self"
RUN_ID = 45025994295
ARTIFACT_ID = 14758849422
JOB_ID = 137219026731
PRODUCER = "b4157952ed0fc28c5ae1eb8893cd9035ce25bbdb"
NATIVE = "2f3e6cf04aad60473e8ecc67e846e81e5b9dec83"
READER = "622c37c23f93c4cc58ff226eb4805c766fee3166"
ARCHIVE_SHA256 = "4e4d26f10173d85182af3d189ba0d69a6327c90cdaba7ebd2adc5abc8758087e"
ARCHIVE_BYTES = 178270704
INVENTORY_SHA256 = "4970057a7f93606b1139c3d53459fca7a91fd1e1f3e4f9d70629f698aee8f47f"
AUDIT_MANIFEST_SHA256 = (
    "7b4a4bd13a813f526d5640635d1e326eeba1f1458399eb16f5b5bd0b20223d5e"
)
EVIDENCE = "docs/evidence/v8-fullfit-campaign-revalidation-2026-11-22"
TAG = "evidence-v8-fullfit-45025994295"
TITLE = "Diagnostic V8 training evidence — run 45025994295 (unpublished)"
NOTES = f"""Evidence archive for the completed controlled CPU training run {RUN_ID}.

This draft preserves the exact original GitHub Actions ZIP and its independently
verified inventory, source map, read-only audit and original complete job log.
It is unpublished and is not
a production model release or learned-quality qualification.

Original producer: {PRODUCER}
Original native optimizer: {NATIVE}
Independent strict reader: {READER}
Original ZIP: {ARCHIVE_BYTES} bytes; SHA-256 {ARCHIVE_SHA256}

The separate one-to-two-update lifecycle and fresh 348-update fit remain distinct
trajectories. The fit exposes 696 logical targets / 720 physical records from the
48 training sources in a 64-source 48/12/4 split. The audit performs zero optimizer
updates. Exact prepared positions/masks are checked; balance-recorder accounting
is scoped, independent internal-router coverage is unmeasured, and learned
success is unclaimed. See the attached audit for all counts and limitations.

Assets are content-verified before upload and read back after upload. Repeating
this archive operation may reuse exact matching draft assets but never replaces
them, changes an existing release, or publishes this draft.
"""


def sha256(path: Path) -> str:
    with path.open("rb") as handle:
        return hashlib.file_digest(handle, "sha256").hexdigest()


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def checked_audit(root: Path) -> dict:
    folder = root / EVIDENCE
    manifest = folder / "SHA256SUMS"
    require(sha256(manifest) == AUDIT_MANIFEST_SHA256, "Audit manifest differs")
    expected = {"SHA256SUMS"}
    for line in manifest.read_text().splitlines():
        digest, relative, size = line.split("  ")
        path = folder / relative
        require(path.resolve().is_relative_to(folder.resolve()), "Unsafe audit path")
        require(
            path.is_file() and not path.is_symlink(), "Missing or linked audit file"
        )
        require(
            path.stat().st_size == int(size.removesuffix(" bytes")),
            "Audit size differs",
        )
        require(sha256(path) == digest, "Audit content differs: " + relative)
        expected.add(relative)
    actual = {
        str(path.relative_to(folder)) for path in folder.rglob("*") if path.is_file()
    }
    require(actual == expected, "Audit member set differs")
    inventory = folder / "artifact-inventory.json"
    require(sha256(inventory) == INVENTORY_SHA256, "Original inventory differs")
    return json.loads(inventory.read_text())


def verify_archive(path: Path, inventory: dict) -> dict:
    require(path.stat().st_size == ARCHIVE_BYTES, "Original archive size differs")
    require(sha256(path) == ARCHIVE_SHA256, "Original archive digest differs")
    expected = {row["path"]: row for row in inventory["members"]}
    require(
        len(expected) == len(inventory["members"]) == 593,
        "Inventory has duplicate/missing members",
    )
    expanded = 0
    seen: set[str] = set()
    with zipfile.ZipFile(path) as archive:
        for entry in archive.infolist():
            name = entry.filename
            pure = PurePosixPath(name)
            require(
                not pure.is_absolute() and ".." not in pure.parts and "\\" not in name,
                "Unsafe archive member",
            )
            require(
                str(pure) == name and not entry.is_dir(), "Noncanonical archive member"
            )
            mode = entry.external_attr >> 16
            require(stat.S_IFMT(mode) in (0, stat.S_IFREG), "Nonregular archive member")
            require(
                name not in seen and name in expected,
                "Duplicate or unexpected archive member",
            )
            seen.add(name)
            row = expected[name]
            require(
                entry.file_size == row["bytes"], "Archive member size differs: " + name
            )
            with archive.open(entry) as handle:
                digest = hashlib.file_digest(handle, "sha256").hexdigest()
            require(digest == row["sha256"], "Archive member content differs: " + name)
            expanded += entry.file_size
    require(seen == set(expected), "Missing archive members")
    require(
        expanded == inventory["archive"]["expandedBytes"] == 517660755,
        "Expanded archive size differs",
    )
    return {
        "archiveSha256": ARCHIVE_SHA256,
        "archiveBytes": ARCHIVE_BYTES,
        "members": len(seen),
        "expandedBytes": expanded,
        "optimizerUpdates": 0,
    }


def gh_json(endpoint: str, *, data: dict | None = None, pages: bool = False):
    command = ["gh", "api", endpoint, "-H", "X-GitHub-Api-Version: 2022-11-28"]
    if pages:
        command.extend(["--paginate", "--slurp"])
    if data is not None:
        command.extend(["--method", "POST", "--input", "-"])
    result = subprocess.run(
        command,
        input=None if data is None else json.dumps(data),
        check=True,
        capture_output=True,
        text=True,
    )
    return json.loads(result.stdout)


def download(endpoint: str, path: Path, *, release_asset: bool = False) -> None:
    with path.open("xb") as output:
        subprocess.run(
            [
                "gh",
                "api",
                endpoint,
                "--allow-escape-sequences",
                "-H",
                "Accept: application/octet-stream"
                if release_asset
                else "Accept: application/json",
            ],
            check=True,
            stdout=output,
        )


def make_audit_archive(root: Path, target: Path) -> None:
    folder = root / EVIDENCE
    with (
        target.open("xb") as raw,
        gzip.GzipFile(fileobj=raw, mode="wb", mtime=0, filename="") as compressed,
        tarfile.open(fileobj=compressed, mode="w|") as archive,
    ):
        for path in sorted(folder.rglob("*")):
            if not path.is_file():
                continue
            data = path.read_bytes()
            info = tarfile.TarInfo(str(path.relative_to(folder)))
            info.size, info.mode, info.mtime = len(data), 0o644, 0
            archive.addfile(info, io.BytesIO(data))


def preserve_draft(root: Path, work: Path) -> dict:
    require(
        os.environ.get("GITHUB_REPOSITORY") == REPOSITORY, "Wrong archive repository"
    )
    require(
        os.environ.get("GITHUB_EVENT_NAME") == "push",
        "Only the explicit archive branch may write",
    )
    require(
        os.environ.get("GITHUB_REF")
        == "refs/heads/codex/v8-fullfit-evidence-archive-20261122",
        "Wrong archive branch",
    )
    inventory = checked_audit(root)
    base = "repos/" + REPOSITORY
    run = gh_json(f"{base}/actions/runs/{RUN_ID}")
    require(
        run["head_sha"] == PRODUCER
        and run["conclusion"] == "success"
        and run["run_attempt"] == 1,
        "Original successful run identity differs",
    )
    metadata = gh_json(f"{base}/actions/artifacts/{ARTIFACT_ID}")
    require(
        metadata["workflow_run"]["id"] == RUN_ID
        and metadata["workflow_run"]["head_sha"] == PRODUCER,
        "Artifact source differs",
    )
    require(
        metadata["name"] == "semantic-v8-target-inventory-support"
        and not metadata["expired"],
        "Artifact name/availability differs",
    )
    require(
        metadata["size_in_bytes"] == ARCHIVE_BYTES
        and metadata["digest"] == "sha256:" + ARCHIVE_SHA256,
        "Artifact identity differs",
    )
    original = work / inventory["archive"]["fileName"]
    download(f"{base}/actions/artifacts/{ARTIFACT_ID}/zip", original)
    receipt = verify_archive(original, inventory)
    audit = work / "fullfit-45025994295-independent-audit.tar.gz"
    make_audit_archive(root, audit)
    job = gh_json(f"{base}/actions/jobs/{JOB_ID}")
    require(
        job["run_id"] == RUN_ID and job["conclusion"] == "success",
        "Original job identity differs",
    )
    job_log = work / f"complete-job-{JOB_ID}.txt"
    download(f"{base}/actions/jobs/{JOB_ID}/logs", job_log)
    require(job_log.stat().st_size > 0, "Original job log is empty")
    sums = work / "SHA256SUMS"
    sums.write_text(
        "".join(f"{sha256(path)}  {path.name}\n" for path in (original, audit, job_log))
    )
    assets = (original, audit, job_log, sums)
    releases = [
        release
        for page in gh_json(base + "/releases?per_page=100", pages=True)
        for release in page
        if release["tag_name"] == TAG
    ]
    require(len(releases) <= 1, "Ambiguous evidence release")
    release = (
        releases[0]
        if releases
        else gh_json(
            base + "/releases",
            data={
                "tag_name": TAG,
                "target_commitish": PRODUCER,
                "name": TITLE,
                "body": NOTES,
                "draft": True,
                "prerelease": True,
                "make_latest": "false",
            },
        )
    )
    require(
        release["draft"] is True
        and release["prerelease"] is True
        and release["target_commitish"] == PRODUCER
        and release["name"] == TITLE
        and release["body"] == NOTES,
        "Existing draft metadata differs",
    )
    release_id = release["id"]
    existing = {asset["name"]: asset for asset in release["assets"]}
    require(
        set(existing).issubset({path.name for path in assets}),
        "Unexpected existing draft asset",
    )
    checked = []
    for path in assets:
        if path.name not in existing:
            subprocess.run(
                ["gh", "release", "upload", TAG, str(path), "--repo", REPOSITORY],
                check=True,
            )
        current = gh_json(f"{base}/releases/{release_id}")
        require(current["draft"] is True, "Evidence draft was published concurrently")
        matches = [asset for asset in current["assets"] if asset["name"] == path.name]
        require(len(matches) == 1, "Uploaded asset identity is ambiguous")
        asset = matches[0]
        require(
            asset["state"] == "uploaded" and asset["size"] == path.stat().st_size,
            "Uploaded asset size/state differs",
        )
        require(
            asset["digest"] == "sha256:" + sha256(path), "Uploaded asset digest differs"
        )
        readback = work / (path.name + ".readback")
        download(f"{base}/releases/assets/{asset['id']}", readback, release_asset=True)
        require(
            sha256(readback) == sha256(path)
            and readback.stat().st_size == path.stat().st_size,
            "Independent asset readback differs",
        )
        checked.append(
            {
                "id": asset["id"],
                "name": path.name,
                "bytes": path.stat().st_size,
                "sha256": sha256(path),
                "readbackVerified": True,
            }
        )
        readback.unlink()
    final = gh_json(f"{base}/releases/{release_id}")
    require(
        final["draft"] is True
        and final["prerelease"] is True
        and final["body"] == NOTES
        and final["target_commitish"] == PRODUCER
        and len(final["assets"]) == len(assets),
        "Final evidence draft metadata differs",
    )
    return {
        **receipt,
        "schema": "semantic-v8-diagnostic-evidence-draft/1",
        "runId": RUN_ID,
        "originalProducer": PRODUCER,
        "originalNative": NATIVE,
        "reader": READER,
        "archiveWorkflowRevision": os.environ["GITHUB_SHA"],
        "draft": True,
        "published": False,
        "learnedSuccess": None,
        "releaseId": release_id,
        "releaseUrl": final["html_url"],
        "assets": checked,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--archive",
        type=Path,
        help="Verify this local original ZIP without network or writes",
    )
    parser.add_argument(
        "--publish-draft",
        action="store_true",
        help="Preserve verified assets as an unpublished draft",
    )
    parser.add_argument("--work", type=Path, default=Path("archive-work"))
    args = parser.parse_args()
    require(
        bool(args.archive) != args.publish_draft,
        "Choose local verification or explicit draft preservation",
    )
    root = Path(__file__).resolve().parents[1]
    if args.archive:
        print(json.dumps(verify_archive(args.archive, checked_audit(root)), indent=2))
    else:
        args.work.mkdir(parents=True, exist_ok=False)
        receipt = preserve_draft(root, args.work)
        (args.work / "archive-receipt.json").write_text(
            json.dumps(receipt, indent=2) + "\n"
        )
        print(json.dumps(receipt, indent=2))


if __name__ == "__main__":
    main()
