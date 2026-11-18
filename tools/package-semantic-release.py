#!/usr/bin/env python3
"""Prepare, recheck and package a complete private v5 dataset without publishing it."""
from __future__ import annotations

import argparse
import gzip
import hashlib
import io
import json
import os
import subprocess
import tarfile
from collections import Counter
from pathlib import Path


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def canonical(value) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode()


def inside(root: Path, name: str) -> Path:
    path = root / name
    if not isinstance(name, str) or not name or Path(name).is_absolute() or ".." in Path(name).parts:
        raise ValueError("Release paths must be relative descendants")
    if path.is_symlink() or not path.resolve().is_relative_to(root.resolve()):
        raise ValueError("Release path escapes its source directory")
    return path


def inventory(roots: dict[str, Path]) -> tuple[list[dict], dict[str, Path]]:
    rows, sources = [], {}
    for prefix, root in sorted(roots.items()):
        paths = [root] if root.is_file() else sorted(root.rglob("*"))
        for path in paths:
            if path.is_symlink():
                raise ValueError("Release inputs must not contain symbolic links")
            if not path.is_file():
                continue
            relative = path.name if root.is_file() else path.relative_to(root).as_posix()
            name = prefix if root.is_file() else prefix + "/" + relative
            if name in sources:
                raise ValueError("Repeated release archive path")
            data = path.read_bytes()
            rows.append({"path": name, "bytes": len(data), "sha256": digest(data)})
            sources[name] = path
    return sorted(rows, key=lambda row: row["path"]), sources


def write_archive(destination: Path, payload: dict, sources: dict[str, Path]) -> dict:
    """Normalize tar/gzip metadata and detect changed bytes after inventory."""
    manifest = {**payload, "identityDigest": digest(canonical(payload))}
    manifest_bytes = json.dumps(manifest, indent=2, sort_keys=True, allow_nan=False).encode() + b"\n"
    temporary = destination.with_suffix(destination.suffix + ".partial")
    try:
        with temporary.open("xb") as raw, gzip.GzipFile(fileobj=raw, mode="wb", filename="", mtime=0) as compressed:
            with tarfile.open(fileobj=compressed, mode="w|", format=tarfile.PAX_FORMAT) as archive:
                for row in payload["files"]:
                    data = sources[row["path"]].read_bytes()
                    if len(data) != row["bytes"] or digest(data) != row["sha256"]:
                        raise ValueError("Release input changed after inventory: " + row["path"])
                    info = tarfile.TarInfo(row["path"])
                    info.size, info.mode, info.mtime = len(data), 0o644, 0
                    archive.addfile(info, io.BytesIO(data))
                info = tarfile.TarInfo("release-manifest.json")
                info.size, info.mode, info.mtime = len(manifest_bytes), 0o644, 0
                archive.addfile(info, io.BytesIO(manifest_bytes))
            compressed.close()
            raw.flush()
            os.fsync(raw.fileno())
        temporary.replace(destination)
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise
    destination.with_name("release-manifest.json").write_bytes(manifest_bytes)
    return manifest


def verify_archive(path: Path) -> dict:
    """Read and hash every archive member without extracting any paths."""
    with tarfile.open(path, "r:gz") as archive:
        members = archive.getmembers()
        names = [member.name for member in members]
        if len(names) != len(set(names)) or any(not member.isfile() for member in members):
            raise ValueError("Unexpected duplicate, link or special archive member")
        for name in names:
            if name.startswith("/") or ".." in Path(name).parts:
                raise ValueError("Unsafe archive path")
        manifest = json.load(archive.extractfile("release-manifest.json"))
        identity = manifest.pop("identityDigest")
        if identity != digest(canonical(manifest)):
            raise ValueError("Release identity digest changed")
        expected = {row["path"]: row for row in manifest["files"]}
        if len(expected) != len(manifest["files"]):
            raise ValueError("Repeated release inventory path")
        if set(names) != set(expected) | {"release-manifest.json"}:
            raise ValueError("Release inventory differs from archive contents")
        for name, row in expected.items():
            data = archive.extractfile(name).read()
            if len(data) != row["bytes"] or digest(data) != row["sha256"]:
                raise ValueError("Release member checksum changed: " + name)
        return {"schema": "semantic-release-verification/1", "status": "verified", "files": len(expected),
                "identityDigest": identity, "archiveSha256": digest(path.read_bytes())}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--verify", type=Path)
    parser.add_argument("--corpus", type=Path)
    parser.add_argument("--tracer-root", type=Path)
    parser.add_argument("--megatoken", type=Path)
    parser.add_argument("--tokenizer", type=Path)
    parser.add_argument("--environment-receipt", type=Path)
    parser.add_argument("--out", type=Path)
    args = parser.parse_args()
    if args.verify:
        print(json.dumps(verify_archive(args.verify), sort_keys=True))
        return 0
    if any(getattr(args, field) is None for field in
           ("corpus", "tracer_root", "megatoken", "tokenizer", "environment_receipt", "out")):
        parser.error("Packaging requires --corpus --tracer-root --megatoken --tokenizer --environment-receipt --out")
    corpus, tracer, consumer, output = (path.resolve() for path in
                                      (args.corpus, args.tracer_root, args.megatoken, args.out))
    if output.exists():
        raise ValueError("Release directories are immutable; choose a new destination")
    if output.is_relative_to(corpus):
        raise ValueError("Release destination must be outside its input corpus")
    manifest = json.loads((corpus / "manifest.json").read_text())
    policy = json.loads((tracer / "contracts/native-admission-policy-v5.json").read_text())
    environment = json.loads(args.environment_receipt.read_text())
    git = lambda path, *argv: subprocess.check_output(["git", "-C", str(path), *argv], text=True).strip()
    if git(tracer, "rev-parse", "HEAD") != manifest["producerRevision"]:
        raise ValueError("Use the exact producing checkout to recheck and release this corpus")
    if git(tracer, "status", "--porcelain", "--untracked-files=no"):
        raise ValueError("Producing checkout has modified tracked files")
    if git(consumer, "rev-parse", "HEAD") != policy["consumerRevision"]:
        raise ValueError("Consumer differs from the producer release policy")
    if environment["status"] != "verified" or any(environment[key] != policy[key] for key in policy):
        raise ValueError("Native environment receipt differs from the release policy")
    if environment["requirementsLockSha256"] != digest((tracer / "tools/native-consumer/requirements.lock").read_bytes()):
        raise ValueError("Native environment receipt uses a different dependency lock")
    counts = Counter(row["status"] for row in manifest["cases"])
    if manifest["counts"]["attempted"] != len(manifest["cases"]) or any(manifest["counts"].get(key) != value for key, value in counts.items()):
        raise ValueError("Candidate dispositions do not reconcile with the manifest")
    documents, identities, source_notices = [], [], {}
    for row in manifest["cases"]:
        if row["status"] != "admitted":
            continue
        document = json.loads(inside(corpus, row["path"]).read_text())
        side = document["sidecar"]
        if side["producerRevision"] != manifest["producerRevision"] or side.get("identityDigest") != row.get("identityDigest"):
            raise ValueError("Candidate identity differs from the campaign manifest")
        documents.append(document)
        identities.append({"id": row["id"], "family": side["sourceFamily"], "split": side["split"],
                           "identityDigest": side["identityDigest"], "episodeDigest": row["episodeDigest"]})
        source_notices[side["sourceFamily"]] = {"license": side["license"], "provenance": side["sourceProvenance"]}
    if not documents:
        raise ValueError("A release needs actual admitted examples")
    from megatoken.data.semantic_corpus import prepare_semantic_corpus, source_verifier_for_checkout
    from megatoken.generation.codec import ByteCodec
    codec = ByteCodec.from_tokenizer_json(args.tokenizer, expected_sha256=policy["tokenizerSha256"])
    if codec.fingerprint != policy["tokenizerIdentity"]:
        raise ValueError("Actual native tokenizer identity changed")
    output.mkdir(parents=True)
    prepared, report = prepare_semantic_corpus(documents, output / "prepared", codec=codec,
        producer_revision=manifest["producerRevision"], consumer_revision=policy["consumerRevision"],
        source_verifier=source_verifier_for_checkout(tracer, manifest["producerRevision"]))
    if report["counts"].get("admitted") != len(documents) or report["refusals"]:
        raise ValueError("Production rechecking rejected release rows; refusal evidence was retained")
    notices = output / "source-notices.json"
    notices.write_text(json.dumps(source_notices, indent=2, sort_keys=True) + "\n")
    roots = {"corpus": corpus, "prepared": output / "prepared", "source-notices.json": notices,
             "native-environment.json": args.environment_receipt.resolve(),
             "locks/environment.json": tracer / "profiles/release-environment.lock.json",
             "locks/native-policy.json": tracer / "contracts/native-admission-policy-v5.json",
             "locks/requirements.lock": tracer / "tools/native-consumer/requirements.lock",
             "locks/producer-package-lock.json": tracer / "package-lock.json",
             "locks/oracle-package-lock.json": tracer / "tools/spec-oracle/package-lock.json"}
    files, sources = inventory(roots)
    payload = {"schema": "semantic-private-release/1", "distribution": "private-audit-only",
        "producerRevision": manifest["producerRevision"], "consumerRevision": policy["consumerRevision"],
        "tokenizer": policy, "campaignManifestSha256": digest((corpus / "manifest.json").read_bytes()),
        "counts": dict(counts), "attempted": len(manifest["cases"]), "nativePrepared": report["accepted"],
        "preparedFingerprint": prepared["fingerprint"], "identities": identities,
        "publicRedistributionApproved": False,
        "licensePolicy": "Retain exact upstream notices; repository-fixture is provenance, not an SPDX license. Owner approval is needed for public corpus distribution.",
        "optimizerSteps": 0, "learnedSuccess": None, "files": files}
    archive = output / "semantic-v5-release.tar.gz"
    write_archive(archive, payload, sources)
    verified = verify_archive(archive)
    (output / "archive-receipt.json").write_text(json.dumps(verified, indent=2, sort_keys=True) + "\n")
    print(json.dumps({**verified, "archive": str(archive), "counts": dict(counts), "nativePrepared": report["accepted"]}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
