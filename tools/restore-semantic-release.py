#!/usr/bin/env python3
"""Restore a private release into a new directory and recheck its exact producer."""
from __future__ import annotations

import argparse
import gzip
import importlib.util
import json
import os
import platform
import re
import signal
import stat
import subprocess
import sys
import tarfile
from contextlib import contextmanager
from pathlib import Path

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("release_packager", Path(__file__).with_name("package-semantic-release.py"))
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)

DEFAULT_LIMITS = {"archiveBytes": 2 * 1024**3, "unpackedBytes": 8 * 1024**3,
                  "memberBytes": 512 * 1024**2, "files": 100000}
LOCKS = {"locks/environment.json": "profiles/release-environment.lock.json",
         "locks/native-policy.json": "contracts/native-admission-policy-v6.json",
         "locks/requirements.lock": "tools/native-consumer/requirements.lock",
         "locks/producer-package-lock.json": "package-lock.json",
         "locks/oracle-package-lock.json": "tools/spec-oracle/package-lock.json"}


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
        with gzip.open(path, "rb") as expanded:
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
            name = release.archive_name(member.name)
            if name in names or not member.isfile() or member.issparse():
                raise ValueError("Unexpected duplicate, link or special archive member")
            names.add(name)
            total += member.size
            if len(names) > limits["files"] or member.size > limits["memberBytes"] or total > limits["unpackedBytes"]:
                raise ValueError("Release archive exceeds bounded extraction limits")
            if name == "release-manifest.json":
                data = release.read_bounded(archive.extractfile(member), release.MAX_MANIFEST_BYTES)
                manifest, manifest_sha = json.loads(data), release.digest(data)
    if manifest is None:
        raise ValueError("Archive has no release manifest")
    if release.file_identity(metadata) != release.file_identity(path.stat()):
        raise ValueError("Archive changed during bounded inspection")
    return manifest, manifest_sha


def verify_before_restore(path: Path, expected_sha256: str, limits: dict = DEFAULT_LIMITS) -> dict:
    if not release.SHA256.fullmatch(expected_sha256):
        raise ValueError("An independently retained archive SHA-256 is required")
    manifest, manifest_sha = bounded_inventory(path, limits)
    receipt = release.verify_archive(path, opener=lambda source: bounded_tar(source, limits))
    if receipt["archiveSha256"] != expected_sha256:
        raise ValueError("Archive differs from the expected SHA-256")
    if manifest.get("schema") != "semantic-private-release/1" or not re.fullmatch(r"[a-f0-9]{40}", manifest.get("producerRevision", "")):
        raise ValueError("Unsupported release schema or missing exact producer revision")
    return {"manifest": manifest, "manifestSha256": manifest_sha, "verification": receipt, "limits": dict(limits)}


def verify_restored_files(directory: Path, verified: dict) -> dict:
    manifest = verified["manifest"]
    expected = release.validate_inventory(manifest["files"])
    actual = {}
    for path in directory.rglob("*"):
        if path.is_symlink() or not path.is_dir() and not path.is_file():
            raise ValueError("Restored tree contains a link or special file")
        if path.is_file():
            actual[path.relative_to(directory).as_posix()] = release.file_receipt(path)
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
    if release.file_receipt(path)["sha256"] != verified["verification"]["archiveSha256"]:
        raise ValueError("Archive changed after verification")
    destination.mkdir(mode=0o700)
    expected = release.validate_inventory(verified["manifest"]["files"])
    seen = set()
    with bounded_tar(path, verified["limits"]) as archive:
        for member in archive:
            name = release.archive_name(member.name)
            if name in seen or not member.isfile() or member.issparse() or name not in expected and name != "release-manifest.json":
                raise ValueError("Archive members changed after verification")
            seen.add(name)
            if name in expected and member.size != expected[name]["bytes"]:
                raise ValueError("Archive member size changed after verification")
            if name == "release-manifest.json" and member.size > release.MAX_MANIFEST_BYTES:
                raise ValueError("Release manifest exceeds its bounded metadata limit")
            target = release.inside(destination, name)
            target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            with os.fdopen(descriptor, "wb") as output, archive.extractfile(member) as source:
                while block := source.read(release.CHUNK_BYTES):
                    output.write(block)
    if seen != {*expected, "release-manifest.json"} or release.file_receipt(path)["sha256"] != verified["verification"]["archiveSha256"]:
        raise ValueError("Archive changed during extraction")
    return verify_restored_files(destination, verified)


def producer_identity(root: Path, revision: str) -> dict:
    git = lambda *args: subprocess.check_output(["git", "-C", str(root), *args], text=True).strip()
    actual = git("rev-parse", "HEAD")
    if actual != revision or git("status", "--porcelain", "--untracked-files=no"):
        raise ValueError("Restore requires the clean exact original producer checkout")
    return {"revision": actual, "tree": git("rev-parse", "HEAD^{tree}"), "trackedWorktreeClean": True}


def verify_locks(restored: Path, producer: Path) -> dict:
    receipts = {}
    for archived, original in LOCKS.items():
        expected = release.file_receipt(release.inside(restored, archived))
        actual = release.file_receipt(release.inside(producer, original))
        if actual != expected:
            raise ValueError("Original producer dependency or policy lock differs: " + original)
        receipts[archived] = actual
    return receipts


def run_logged(command: list[str], directory: Path, name: str, *, cwd: Path, env: dict, timeout: int):
    with (directory / (name + ".stdout.log")).open("x") as stdout, (directory / (name + ".stderr.log")).open("x") as stderr:
        process = subprocess.Popen(command, cwd=cwd, env=env, stdout=stdout, stderr=stderr, start_new_session=True)
        try:
            status = process.wait(timeout=timeout)
        except BaseException:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()
            raise
    if status:
        raise ValueError(name + " failed with exit " + str(status) + "; retained stdout/stderr identify the failure")


def restore_release(args) -> dict:
    archive, output, producer = no_symlinks(args.archive), no_symlinks(args.out), no_symlinks(args.tracer_root)
    if output.exists() or not output.parent.is_dir():
        raise ValueError("Restore destination must be new with an existing parent directory")
    verified = verify_before_restore(archive, args.archive_sha256, args.limits)
    revision = verified["manifest"]["producerRevision"]
    original = producer_identity(producer, revision)
    output.mkdir(mode=0o700)
    restored, checks = output / "release", output / "checks"
    checks.mkdir(mode=0o700)
    temporary = checks / "tmp"
    temporary.mkdir(mode=0o700)
    receipt = {"schema": "semantic-release-restore-drill/1", "status": "running", "phase": "extraction",
               "archive": verified["verification"], "producer": original, "limits": args.limits,
               "restorerFiles": {name: release.file_receipt(Path(__file__).with_name(name)) for name in
                   ["restore-semantic-release.py", "restore-release-campaign.mjs", "package-semantic-release.py"]},
               "host": {"platform": platform.platform(), "python": sys.version},
               "hostScope": "current-host-restore; fresh-host provenance is not established by this tool",
               "freshMachineQualification": False, "originalArtifactsModified": False,
               "nativeRequalification": "untested", "preparedData": "inventory-only",
               "optimizerSteps": 0, "learnedSuccess": None}
    try:
        receipt["extraction"] = extract_verified(archive, restored, verified)
        receipt["phase"] = "producer-environment"
        receipt["locks"] = verify_locks(restored, producer)
        environment = release.read_json(restored / "locks/environment.json")
        env = {**os.environ, "TZ": environment["timezone"], "LANG": environment["locale"],
               "LC_ALL": environment["locale"], "TMPDIR": str(temporary), "OMP_NUM_THREADS": "1", "MKL_NUM_THREADS": "1"}
        # This runtime query executes no archived code. Original rechecks below
        # also authenticate their detailed parser/dependency/runtime receipts.
        actual = json.loads(subprocess.check_output(["node", "-p", "JSON.stringify({node:process.versions.node,v8:process.versions.v8,platform:process.platform,arch:process.arch})"], env=env, text=True))
        actual["npm"] = subprocess.check_output(["npm", "--version"], env=env, text=True).strip()
        receipt["executionEnvironment"] = {**actual, "timezone": env["TZ"], "locale": env["LC_ALL"]}
        receipt["expectedExecutionEnvironment"] = {key: environment[key] for key in receipt["executionEnvironment"]}
        mismatches = {key: {"expected": environment[key], "actual": actual[key]}
                      for key in actual if actual[key] != environment[key]}
        receipt["executionEnvironmentMismatches"] = mismatches
        if mismatches:
            details = "; ".join(key + ": expected " + str(value["expected"]) + ", actual " + str(value["actual"])
                                for key, value in mismatches.items())
            raise ValueError("Original producer runtime environment differs: " + details)
        native = []
        if args.megatoken:
            receipt["phase"] = "native-environment"
            policy = release.read_json(restored / "locks/native-policy.json")
            # Reuse the existing exact-environment checker with the interpreter
            # chosen to launch this drill. It rejects stale supplied receipts.
            previous_env = os.environ.copy()
            try:
                os.environ.update(env)
                release.recheck_environment(producer, args.megatoken.resolve(), args.tokenizer.resolve(),
                    restored / "native-environment.json", checks / "native-environment.json", policy)
            finally:
                os.environ.clear()
                os.environ.update(previous_env)
            native = ["--megatoken", str(args.megatoken.resolve()), "--tokenizer", str(args.tokenizer.resolve()), "--python", sys.executable]
        receipt["phase"] = "original-source-replay"
        command = ["node", "--max-old-space-size=1536", str(Path(__file__).with_name("restore-release-campaign.mjs")),
                   "--tracer-root", str(producer), "--release", str(restored), "--producer-revision", revision,
                   "--out", str(checks / "replay"), "--reference-timeout-ms", str(args.reference_timeout_ms), *native]
        run_logged(command, checks, "original-source-replay", cwd=producer, env=env, timeout=args.timeout_seconds)
        receipt["replay"] = release.read_json(checks / "replay/report.json")
        if receipt["replay"].get("status") != "verified":
            raise ValueError("Original source replay did not verify every positive attempt")
        receipt["nativeRequalification"] = receipt["replay"]["nativeRequalification"]
        receipt["phase"] = "post-verification"
        verify_restored_files(restored, verified)
        if producer_identity(producer, revision) != original:
            raise ValueError("Original producer changed during the restore drill")
        receipt["status"], receipt["phase"] = "verified", "complete"
    except BaseException as error:
        receipt["status"], receipt["error"] = "failed", str(error)
        replay = checks / "replay/report.json"
        if replay.exists():
            receipt["replay"] = release.read_json(replay)
        release.write_json(output / "restore.json", receipt)
        raise
    release.write_json(output / "restore.json", receipt)
    return receipt


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", type=Path, required=True)
    parser.add_argument("--archive-sha256", required=True)
    parser.add_argument("--tracer-root", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--megatoken", type=Path)
    parser.add_argument("--tokenizer", type=Path)
    parser.add_argument("--reference-timeout-ms", type=int, default=10000)
    parser.add_argument("--timeout-seconds", type=int, default=3600)
    for option, key in [("archive-bytes", "archiveBytes"), ("unpacked-bytes", "unpackedBytes"), ("member-bytes", "memberBytes"), ("files", "files")]:
        parser.add_argument("--max-" + option, dest=key, type=int, default=DEFAULT_LIMITS[key])
    args = parser.parse_args()
    if bool(args.megatoken) != bool(args.tokenizer):
        parser.error("Native requalification requires both --megatoken and --tokenizer")
    if not 1000 <= args.reference_timeout_ms <= 120000 or not 1 <= args.timeout_seconds <= 86400:
        parser.error("Reference timeout must be 1000..120000 ms; drill timeout 1..86400 seconds")
    args.limits = {key: getattr(args, key) for key in DEFAULT_LIMITS}
    receipt = restore_release(args)
    print(json.dumps({"status": receipt["status"], "receipt": str(args.out / "restore.json"),
                      "producerRevision": receipt["producer"]["revision"], "freshMachineQualification": False}))


if __name__ == "__main__":
    main()
