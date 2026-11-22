"""Bounded, deterministic archive integrity and extraction using only the standard library.

This module verifies container membership and bytes. It does not grant semantic,
source, native, training or release admission; callers enforce those policies.
"""
from __future__ import annotations

import gzip
import hashlib
import io
import json
import os
import re
import stat
import tarfile
from contextlib import contextmanager
from pathlib import Path, PurePosixPath

CHUNK_BYTES = 1024 * 1024
MAX_MANIFEST_BYTES = 64 * 1024 * 1024
MAX_OBJECT_BYTES = 256 * 1024 * 1024
SHA256 = re.compile(r"^[a-f0-9]{64}$")
DEFAULT_LIMITS = {"archiveBytes": 2 * 1024**3, "unpackedBytes": 8 * 1024**3,
                  "memberBytes": 512 * 1024**2, "files": 100000}


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
        raise ValueError("Release inventory must be an array")  # noqa: TRY004 - preserve the archive API
    expected = {}
    for row in rows:
        if not isinstance(row, dict):
            raise ValueError("Malformed release inventory row")  # noqa: TRY004 - preserve the archive API
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


def write_archive(destination: Path, payload: dict, sources: dict[str, Path], *, max_manifest_bytes=None) -> dict:
    """Normalize tar/gzip metadata and detect changed bytes after inventory."""
    if max_manifest_bytes is None:
        max_manifest_bytes = MAX_MANIFEST_BYTES
    expected = validate_inventory(payload["files"])
    if set(expected) != set(sources):
        raise ValueError("Release source paths differ from the inventory")
    manifest = {**payload, "identityDigest": digest(canonical(payload))}
    manifest_bytes = json.dumps(manifest, indent=2, sort_keys=True, allow_nan=False).encode() + b"\n"
    if len(manifest_bytes) > max_manifest_bytes:
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


def verify_archive(path: Path, *, opener=None, max_manifest_bytes=None) -> dict:
    """Read and hash every archive member without extracting any paths."""
    if max_manifest_bytes is None:
        max_manifest_bytes = MAX_MANIFEST_BYTES
    observed, seen, manifest = {}, set(), None
    before = path.stat()
    with (opener(path) if opener else tarfile.open(path, "r|gz")) as archive:
        for member in archive:
            name = archive_name(member.name)
            if name in seen or not member.isfile() or member.issparse():
                raise ValueError("Unexpected duplicate, link or special archive member")
            seen.add(name)
            stream = archive.extractfile(member)
            if name == "release-manifest.json":
                if member.size > max_manifest_bytes:
                    raise ValueError("Release manifest exceeds its bounded metadata limit")
                data = bytearray()
                while block := stream.read(CHUNK_BYTES):
                    data.extend(block)
                    if len(data) > max_manifest_bytes:
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


def no_symlinks(path: Path) -> Path:
    path = path.absolute()
    for parent in [*reversed(path.parents), path]:
        if parent.is_symlink():
            raise ValueError("Restore paths must not contain symbolic links")
    return path


@contextmanager
def bounded_tar(path: Path, limits: dict):
    """Bound expanded bytes and extension headers before tarfile interprets them."""
    headers = 0

    class BoundExceeded(Exception):
        pass

    class BoundedInfo(tarfile.TarInfo):
        def _proc_member(self, archive):
            nonlocal headers
            headers += 1
            if headers > 2 * limits["files"] + 2 or not 0 <= self.size <= limits["memberBytes"]:
                raise BoundExceeded("Release tar headers exceed extraction bounds")
            if self.type in {tarfile.XHDTYPE, tarfile.XGLTYPE, tarfile.SOLARIS_XHDTYPE,
                             tarfile.GNUTYPE_LONGNAME, tarfile.GNUTYPE_LONGLINK} and self.size > 65536:
                raise BoundExceeded("Release extension metadata exceeds its bounded limit")
            if self.type == tarfile.GNUTYPE_SPARSE:
                raise BoundExceeded("Sparse release members are unsupported")
            return super()._proc_member(archive)

    class ExpandedReader:
        def __init__(self, stream):
            self.stream, self.bytes = stream, 0

        def read(self, size):
            if size < 0:
                raise ValueError("Unbounded expanded archive read")
            data = self.stream.read(min(size, limits["unpackedBytes"] - self.bytes + 1))
            self.bytes += len(data)
            if self.bytes > limits["unpackedBytes"]:
                raise BoundExceeded("Expanded archive bytes exceed the bounded limit")
            return data

    try:
        with gzip.open(path, "rb") as expanded:  # noqa: SIM117 - preserve the extracted context-manager structure
            with tarfile.open(fileobj=ExpandedReader(expanded), mode="r|", tarinfo=BoundedInfo) as archive:
                yield archive
    except BoundExceeded as error:
        raise ValueError(str(error)) from error


def bounded_inventory(path: Path, limits: dict) -> tuple[dict, str]:
    """Bound tar expansion before the existing full inventory/hash verifier runs."""
    if set(limits) != set(DEFAULT_LIMITS) or any(type(n) is not int or n < 1 or n > 2**53 - 1 for n in limits.values()):
        raise ValueError("Restore limits must be positive safe integers")
    if limits["files"] > 1000000:
        raise ValueError("Restore file limit exceeds the supported bound")
    path = no_symlinks(path)
    metadata = path.stat()
    if not stat.S_ISREG(metadata.st_mode) or metadata.st_size > limits["archiveBytes"]:
        raise ValueError("Release archive exceeds its byte bound or is not a regular file")
    names, total, manifest, manifest_sha = set(), 0, None, None
    with bounded_tar(path, limits) as archive:
        for member in archive:
            name = archive_name(member.name)
            if name in names or not member.isfile() or member.issparse():
                raise ValueError("Unexpected duplicate, link or special archive member")
            names.add(name)
            total += member.size
            if len(names) > limits["files"] or member.size > limits["memberBytes"] or total > limits["unpackedBytes"]:
                raise ValueError("Release archive exceeds bounded extraction limits")
            if name == "release-manifest.json":
                data = read_bounded(archive.extractfile(member), MAX_MANIFEST_BYTES)
                manifest, manifest_sha = json.loads(data), digest(data)
    if manifest is None:
        raise ValueError("Archive has no release manifest")
    if file_identity(metadata) != file_identity(path.stat()):
        raise ValueError("Archive changed during bounded inspection")
    return manifest, manifest_sha


def verify_restored_files(directory: Path, verified: dict) -> dict:
    manifest = verified["manifest"]
    expected = validate_inventory(manifest["files"])
    actual = {}
    for path in directory.rglob("*"):
        if path.is_symlink() or not path.is_dir() and not path.is_file():
            raise ValueError("Restored tree contains a link or special file")
        if path.is_file():
            actual[path.relative_to(directory).as_posix()] = file_receipt(path)
    expected_receipts = {name: {"bytes": row["bytes"], "sha256": row["sha256"]} for name, row in expected.items()}
    restored_manifest = actual.pop("release-manifest.json", None)
    if not restored_manifest or restored_manifest["sha256"] != verified["manifestSha256"] or actual != expected_receipts:
        raise ValueError("Restored inventory or bytes changed")
    return {"status": "verified", "files": len(actual), "bytes": sum(row["bytes"] for row in actual.values())}


def extract_verified(path: Path, destination: Path, verified: dict) -> dict:
    """Copy regular members only; never apply archived modes or call extractall."""
    destination = no_symlinks(destination)
    if destination.exists():
        raise ValueError("Restore destination must be a new directory")
    if file_receipt(path)["sha256"] != verified["verification"]["archiveSha256"]:
        raise ValueError("Archive changed after verification")
    destination.mkdir(mode=0o700)
    expected = validate_inventory(verified["manifest"]["files"])
    seen = set()
    with bounded_tar(path, verified["limits"]) as archive:
        for member in archive:
            name = archive_name(member.name)
            if name in seen or not member.isfile() or member.issparse() or name not in expected and name != "release-manifest.json":
                raise ValueError("Archive members changed after verification")
            seen.add(name)
            if name in expected and member.size != expected[name]["bytes"]:
                raise ValueError("Archive member size changed after verification")
            if name == "release-manifest.json" and member.size > MAX_MANIFEST_BYTES:
                raise ValueError("Release manifest exceeds its bounded metadata limit")
            target = inside(destination, name)
            target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            with os.fdopen(descriptor, "wb") as output, archive.extractfile(member) as source:
                while block := source.read(CHUNK_BYTES):
                    output.write(block)
    if seen != {*expected, "release-manifest.json"} or file_receipt(path)["sha256"] != verified["verification"]["archiveSha256"]:
        raise ValueError("Archive changed during extraction")
    return verify_restored_files(destination, verified)
