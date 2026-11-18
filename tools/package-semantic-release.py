#!/usr/bin/env python3
"""Prepare, recheck and package a complete private v5 dataset without publishing it."""
from __future__ import annotations

import argparse
import fcntl
import gzip
import hashlib
import io
import json
import os
import re
import stat
import subprocess
import sys
import tarfile
from contextlib import contextmanager
from pathlib import Path, PurePosixPath

CHUNK_BYTES = 1024 * 1024
MAX_MANIFEST_BYTES = 64 * 1024 * 1024
MAX_OBJECT_BYTES = 256 * 1024 * 1024
SHA256 = re.compile(r"^[a-f0-9]{64}$")


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def canonical(value) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode()


def archive_name(name: str) -> str:
    if (not isinstance(name, str) or not name or name == "." or "\\" in name or "\x00" in name
            or PurePosixPath(name).is_absolute() or ".." in PurePosixPath(name).parts
            or PurePosixPath(name).as_posix() != name):
        raise ValueError("Release paths must be canonical relative descendants")
    return name


def inside(root: Path, name: str) -> Path:
    archive_name(name)
    path = root / name
    cursor = root
    for part in PurePosixPath(name).parts:
        cursor = cursor / part
        if cursor.is_symlink():
            raise ValueError("Release path escapes its source directory or uses a symbolic link")
    if not path.resolve().is_relative_to(root.resolve()):
        raise ValueError("Release path escapes its source directory")
    return path


def hash_stream(stream) -> dict:
    checksum, size = hashlib.sha256(), 0
    while block := stream.read(CHUNK_BYTES):
        size += len(block)
        checksum.update(block)
    return {"bytes": size, "sha256": checksum.hexdigest()}


def file_identity(metadata) -> tuple:
    return (metadata.st_dev, metadata.st_ino, metadata.st_size, metadata.st_mtime_ns, metadata.st_ctime_ns)


def file_receipt(path: Path) -> dict:
    with path.open("rb") as stream:
        before = os.fstat(stream.fileno())
        if not stat.S_ISREG(before.st_mode) or path.is_symlink():
            raise ValueError("Release inputs must be regular files without symbolic links")
        receipt = hash_stream(stream)
        after = os.fstat(stream.fileno())
        if file_identity(before) != file_identity(after) or receipt["bytes"] != after.st_size:
            raise ValueError("Release input changed while hashing: " + str(path))
        return receipt


class HashingReader:
    """Hash exactly the bytes handed to tarfile, keeping reads bounded."""

    def __init__(self, stream):
        self.stream, self.checksum, self.size = stream, hashlib.sha256(), 0

    def read(self, size):
        if size < 0 or size > CHUNK_BYTES:
            raise ValueError("Unbounded archive read requested")
        block = self.stream.read(size)
        self.checksum.update(block)
        self.size += len(block)
        return block


def validate_inventory(rows) -> dict:
    if not isinstance(rows, list):
        raise ValueError("Release inventory must be an array")
    expected = {}
    for row in rows:
        if not isinstance(row, dict):
            raise ValueError("Malformed release inventory row")
        name = archive_name(row.get("path"))
        if name == "release-manifest.json" or name in expected:
            raise ValueError("Repeated or reserved release inventory path")
        if (type(row.get("bytes")) is not int or row["bytes"] < 0 or not isinstance(row.get("sha256"), str)
                or not SHA256.fullmatch(row["sha256"])):
            raise ValueError("Malformed release file size or checksum")
        expected[name] = row
    return expected


def inventory(roots: dict[str, Path]) -> tuple[list[dict], dict[str, Path]]:
    rows, sources = [], {}
    for prefix, root in sorted(roots.items()):
        archive_name(prefix)
        if not root.exists() or root.is_symlink():
            raise ValueError("Release inputs must exist without symbolic links")
        paths = [root] if root.is_file() else sorted(root.rglob("*"))
        for path in paths:
            if path.is_symlink():
                raise ValueError("Release inputs must not contain symbolic links")
            if path.is_dir():
                continue
            if not path.is_file():
                raise ValueError("Release inputs contain a special file")
            relative = path.name if root.is_file() else path.relative_to(root).as_posix()
            name = prefix if root.is_file() else prefix + "/" + relative
            if name in sources:
                raise ValueError("Repeated release archive path")
            rows.append({"path": archive_name(name), **file_receipt(path)})
            sources[name] = path
    return sorted(rows, key=lambda row: row["path"]), sources


def write_archive(destination: Path, payload: dict, sources: dict[str, Path]) -> dict:
    """Normalize tar/gzip metadata and detect changed bytes after inventory."""
    expected = validate_inventory(payload["files"])
    if set(expected) != set(sources):
        raise ValueError("Release source paths differ from the inventory")
    manifest = {**payload, "identityDigest": digest(canonical(payload))}
    manifest_bytes = json.dumps(manifest, indent=2, sort_keys=True, allow_nan=False).encode() + b"\n"
    if len(manifest_bytes) > MAX_MANIFEST_BYTES:
        raise ValueError("Release manifest exceeds its bounded metadata limit")
    temporary = destination.with_suffix(destination.suffix + ".partial")
    try:
        with temporary.open("xb") as raw, gzip.GzipFile(fileobj=raw, mode="wb", filename="", mtime=0) as compressed:
            with tarfile.open(fileobj=compressed, mode="w|", format=tarfile.PAX_FORMAT) as archive:
                for row in payload["files"]:
                    path = sources[row["path"]]
                    with path.open("rb") as stream:
                        before = os.fstat(stream.fileno())
                        if not stat.S_ISREG(before.st_mode) or path.is_symlink() or before.st_size != row["bytes"]:
                            raise ValueError("Release input changed after inventory: " + row["path"])
                        reader = HashingReader(stream)
                        info = tarfile.TarInfo(row["path"])
                        info.size, info.mode, info.mtime = row["bytes"], 0o644, 0
                        archive.addfile(info, reader)
                        after = os.fstat(stream.fileno())
                        if (reader.size != row["bytes"] or reader.checksum.hexdigest() != row["sha256"]
                                or stream.read(1) or file_identity(before) != file_identity(after)):
                            raise ValueError("Release input changed after inventory: " + row["path"])
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
    observed, seen, manifest = {}, set(), None
    before = path.stat()
    with tarfile.open(path, "r|gz") as archive:
        for member in archive:
            name = archive_name(member.name)
            if name in seen or not member.isfile() or member.issparse():
                raise ValueError("Unexpected duplicate, link or special archive member")
            seen.add(name)
            stream = archive.extractfile(member)
            if name == "release-manifest.json":
                if member.size > MAX_MANIFEST_BYTES:
                    raise ValueError("Release manifest exceeds its bounded metadata limit")
                data = bytearray()
                while block := stream.read(CHUNK_BYTES):
                    data.extend(block)
                    if len(data) > MAX_MANIFEST_BYTES:
                        raise ValueError("Release manifest exceeds its bounded metadata limit")
                manifest = json.loads(data)
            else:
                observed[name] = hash_stream(stream)
    if manifest is None:
        raise ValueError("Archive has no release manifest")
    identity = manifest.pop("identityDigest", None)
    if identity != digest(canonical(manifest)):
        raise ValueError("Release identity digest changed")
    expected = validate_inventory(manifest["files"])
    if set(observed) != set(expected):
        raise ValueError("Release inventory differs from archive contents")
    for name, row in expected.items():
        if observed[name] != {"bytes": row["bytes"], "sha256": row["sha256"]}:
            raise ValueError("Release member checksum changed: " + name)
    archive_receipt = file_receipt(path)
    if file_identity(before) != file_identity(path.stat()):
        raise ValueError("Archive changed during verification")
    return {"schema": "semantic-release-verification/1", "status": "verified", "files": len(expected),
            "identityDigest": identity, "archiveSha256": archive_receipt["sha256"]}


def read_bounded(stream, maximum: int) -> bytes:
    data = bytearray()
    while block := stream.read(min(CHUNK_BYTES, maximum - len(data) + 1)):
        data.extend(block)
        if len(data) > maximum:
            raise ValueError("Release JSON exceeds its bounded object limit")
    return bytes(data)


def read_json(path: Path, maximum: int = MAX_MANIFEST_BYTES):
    with path.open("rb") as stream:
        return json.loads(read_bounded(stream, maximum))


def write_json(path: Path, value):
    with path.open("x") as stream:
        json.dump(value, stream, indent=2, sort_keys=True, allow_nan=False)
        stream.write("\n")


@contextmanager
def locked_campaign(corpus: Path):
    """Keep the producer's shared OS lock throughout rechecking and archiving."""
    with inside(corpus, ".campaign.lock").open("rb") as lock:
        try:
            fcntl.flock(lock.fileno(), fcntl.LOCK_SH | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise ValueError("Campaign is still open by a writer; finish collection before packaging") from error
        try:
            yield
        finally:
            fcntl.flock(lock.fileno(), fcntl.LOCK_UN)


def verify_campaign(corpus: Path, destination: Path) -> dict:
    verifier = Path(__file__).with_name("verify-release-campaign.mjs")
    with destination.open("x") as stream:
        result = subprocess.run(["node", str(verifier), str(corpus)], stdout=stream, stderr=subprocess.PIPE,
                                text=True, timeout=3600, check=False)
    if result.returncode:
        raise ValueError("Complete campaign verification failed: " + result.stderr[-4000:])
    receipt = read_json(destination)
    if receipt.get("status") != "verified" or receipt.get("schema") != "semantic-release-campaign-receipt/1":
        raise ValueError("Malformed campaign verification receipt")
    return receipt


def check_environment_receipt(environment: dict, policy: dict, tracer: Path):
    if (environment.get("schema") != "semantic-native-environment-receipt/1"
            or environment.get("status") != "verified"
            or any(environment.get(key) != value for key, value in policy.items())):
        raise ValueError("Native environment receipt differs from the release policy")
    if environment.get("requirementsLockSha256") != file_receipt(tracer / "tools/native-consumer/requirements.lock")["sha256"]:
        raise ValueError("Native environment receipt uses a different dependency lock")
    if environment.get("nativePolicySha256") != file_receipt(tracer / "contracts/native-admission-policy-v5.json")["sha256"]:
        raise ValueError("Native environment receipt uses different policy bytes")


def recheck_environment(tracer: Path, consumer: Path, tokenizer: Path, supplied: Path,
                        destination: Path, policy: dict) -> dict:
    previous = read_json(supplied)
    check_environment_receipt(previous, policy, tracer)
    # Use the original producing checkout's checker, not this packager's current
    # policy. A supplied receipt is evidence to compare, never an execution gate.
    checker = tracer / "tools/native-consumer/check_environment.py"
    result = subprocess.run([sys.executable, str(checker), "--megatoken", str(consumer),
                             "--tokenizer", str(tokenizer), "--out", str(destination)],
                            capture_output=True, text=True, timeout=600, check=False)
    if result.returncode:
        raise ValueError("Fresh native environment verification failed: " + result.stderr[-4000:])
    actual = read_json(destination)
    check_environment_receipt(actual, policy, tracer)
    if actual != previous:
        raise ValueError("Supplied native environment receipt is stale; actual fresh receipt was retained")
    return actual


def read_campaign_object(corpus: Path, reference: dict):
    path = inside(corpus, reference["path"])
    if (type(reference.get("uncompressedBytes")) is not int or reference["uncompressedBytes"] < 0
            or reference["uncompressedBytes"] > MAX_OBJECT_BYTES
            or reference.get("bytes", MAX_OBJECT_BYTES + 1) > MAX_OBJECT_BYTES
            or reference.get("encoding") not in {"json", "gzip"}):
        raise ValueError("Campaign object exceeds its bounded size or uses an unknown encoding")
    if file_receipt(path) != {"bytes": reference["bytes"], "sha256": reference["sha256"]}:
        raise ValueError("Campaign object bytes changed after verification")
    opener = gzip.open if reference["encoding"] == "gzip" else Path.open
    with opener(path, "rb") as stream:
        raw = read_bounded(stream, reference["uncompressedBytes"])
    if len(raw) != reference["uncompressedBytes"] or digest(raw) != reference["contentSha256"]:
        raise ValueError("Campaign object content changed after verification")
    return json.loads(raw)


def load_document(corpus: Path, row: dict) -> dict:
    # Compact collections need no large compatibility export. The campaign
    # verifier binds these exact references to the complete committed attempt.
    return {"public": read_campaign_object(corpus, row["publicShard"]),
            "sidecar": read_campaign_object(corpus, row["privateEvidence"])}


def check_document_identity(row: dict, document: dict, producer_revision: str, public_digest) -> dict:
    side = document["sidecar"]
    if (side.get("producerRevision") != producer_revision or side.get("identityDigest") != row.get("identityDigest")
            or side.get("sourceFamily") != row.get("family") or side.get("split") != row.get("split")
            or side.get("admission") != "admitted" or public_digest(document) != row.get("episodeDigest")):
        raise ValueError("Candidate identity or actual public digest differs from the campaign manifest: " + row["id"])
    return {"id": row["id"], "family": side["sourceFamily"], "split": side["split"],
            "identityDigest": side["identityDigest"], "episodeDigest": row["episodeDigest"]}


def package_release(args) -> dict:
    corpus, tracer, consumer, output = (path.resolve() for path in
                                      (args.corpus, args.tracer_root, args.megatoken, args.out))
    manifest = read_json(inside(corpus, "manifest.json"))
    policy = read_json(tracer / "contracts/native-admission-policy-v5.json")
    git = lambda path, *argv: subprocess.check_output(["git", "-C", str(path), *argv], text=True).strip()
    if git(tracer, "rev-parse", "HEAD") != manifest["producerRevision"]:
        raise ValueError("Use the exact producing checkout to recheck and release this corpus")
    if git(tracer, "status", "--porcelain", "--untracked-files=no"):
        raise ValueError("Producing checkout has modified tracked files")
    if git(consumer, "rev-parse", "HEAD") != policy["consumerRevision"]:
        raise ValueError("Consumer differs from the producer release policy")
    output.mkdir(parents=True)
    campaign_path = output / "campaign-verification.json"
    campaign = verify_campaign(corpus, campaign_path)
    if campaign["manifestSha256"] != file_receipt(corpus / "manifest.json")["sha256"]:
        raise ValueError("Campaign manifest changed during verification")
    actual_environment = output / "native-environment.json"
    recheck_environment(tracer, consumer, args.tokenizer.resolve(), args.environment_receipt.resolve(),
                        actual_environment, policy)
    from megatoken.data.semantic_corpus import prepare_semantic_corpus, public_digest, source_verifier_for_checkout
    from megatoken.generation.codec import ByteCodec
    codec = ByteCodec.from_tokenizer_json(args.tokenizer, expected_sha256=policy["tokenizerSha256"])
    if codec.fingerprint != policy["tokenizerIdentity"]:
        raise ValueError("Actual native tokenizer identity changed")
    admitted = [row for row in manifest["cases"] if row["status"] == "admitted"]
    if not admitted:
        raise ValueError("A release needs actual admitted examples")
    identities, source_notices = [], {}

    def documents():
        for row in admitted:
            document = load_document(corpus, row)
            identities.append(check_document_identity(row, document, manifest["producerRevision"], public_digest))
            side = document["sidecar"]
            notice = {"family": side["sourceFamily"], "license": side["license"], "provenance": side["sourceProvenance"]}
            key = digest(canonical(notice))
            source_notices.setdefault(key, {**notice, "candidateIds": []})["candidateIds"].append(row["id"])
            yield document

    prepared, report = prepare_semantic_corpus(documents(), output / "prepared", codec=codec,
        producer_revision=manifest["producerRevision"], consumer_revision=policy["consumerRevision"],
        source_verifier=source_verifier_for_checkout(tracer, manifest["producerRevision"]))
    if report["counts"].get("admitted") != len(admitted) or report["refusals"]:
        raise ValueError("Production rechecking rejected release rows; refusal evidence was retained")
    notices = output / "source-notices.json"
    write_json(notices, {"schema": "semantic-source-notices/1", "notices": list(source_notices.values())})
    roots = {"corpus": corpus, "prepared": output / "prepared", "source-notices.json": notices,
             "campaign-verification.json": campaign_path, "native-environment.json": actual_environment,
             "supplied-native-environment.json": args.environment_receipt.resolve(),
             "locks/environment.json": tracer / "profiles/release-environment.lock.json",
             "locks/native-policy.json": tracer / "contracts/native-admission-policy-v5.json",
             "locks/requirements.lock": tracer / "tools/native-consumer/requirements.lock",
             "locks/producer-package-lock.json": tracer / "package-lock.json",
             "locks/oracle-package-lock.json": tracer / "tools/spec-oracle/package-lock.json"}
    files, sources = inventory(roots)
    # The shared lock excludes generator resumes. Match the archived metadata
    # again so changes made outside that lock cannot silently rebind the release.
    by_path = {row["path"]: row for row in files}
    for name, key in (("manifest.json", "manifestSha256"), ("campaign.json", "headerSha256"), ("campaign.jsonl", "logSha256")):
        if by_path["corpus/" + name]["sha256"] != campaign[key]:
            raise ValueError("Campaign metadata changed after qualification")
    for reference in [*campaign["objects"], *campaign["compatibilityExports"]]:
        archived = by_path.get("corpus/" + reference["path"], {})
        if any(archived.get(key) != reference[key] for key in ("bytes", "sha256")):
            raise ValueError("Qualified campaign bytes changed before archiving: " + reference["path"])
    payload = {"schema": "semantic-private-release/1", "distribution": "private-audit-only",
        "producerRevision": manifest["producerRevision"], "consumerRevision": policy["consumerRevision"],
        "tokenizer": policy, "campaignManifestSha256": campaign["manifestSha256"],
        "campaignVerificationSha256": by_path["campaign-verification.json"]["sha256"],
        "nativeEnvironmentSha256": by_path["native-environment.json"]["sha256"],
        "counts": campaign["counts"], "attempted": campaign["attempted"], "nativePrepared": report["accepted"],
        "preparedFingerprint": prepared["fingerprint"], "identities": identities,
        "publicRedistributionApproved": False,
        "licensePolicy": "Retain exact upstream notices; repository-fixture is provenance, not an SPDX license. Owner approval is needed for public corpus distribution.",
        "optimizerSteps": 0, "learnedSuccess": None, "files": files}
    archive = output / "semantic-v5-release.tar.gz"
    write_archive(archive, payload, sources)
    verified = verify_archive(archive)
    write_json(output / "archive-receipt.json", verified)
    return {**verified, "archive": str(archive), "counts": campaign["counts"], "nativePrepared": report["accepted"]}


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
    corpus, output = args.corpus.resolve(), args.out.resolve()
    if output.exists():
        raise ValueError("Release directories are immutable; choose a new destination")
    if output.is_relative_to(corpus):
        raise ValueError("Release destination must be outside its input corpus")
    with locked_campaign(corpus):
        print(json.dumps(package_release(args)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
