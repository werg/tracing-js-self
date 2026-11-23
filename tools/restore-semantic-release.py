#!/usr/bin/env python3
"""Restore a private release into a new directory and recheck its exact producer."""
from __future__ import annotations

import argparse
import importlib.util
import json
import os
import platform
import re
import signal
import subprocess
import sys
from pathlib import Path

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("release_packager", Path(__file__).with_name("package-semantic-release.py"))
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)

DEFAULT_LIMITS = release._archive.DEFAULT_LIMITS
LOCKS = {"locks/environment.json": "profiles/release-environment.lock.json",
         "locks/native-policy.json": "contracts/native-admission-policy-v6.json",
         "locks/requirements.lock": "tools/native-consumer/requirements.lock",
         "locks/producer-package-lock.json": "package-lock.json",
         "locks/oracle-package-lock.json": "tools/spec-oracle/package-lock.json"}


no_symlinks = release._archive.no_symlinks


bounded_tar = release._archive.bounded_tar


bounded_inventory = release._archive.bounded_inventory


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


verify_restored_files = release._archive.verify_restored_files


extract_verified = release._archive.extract_verified


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
    release.archive_implementation_receipts()
    receipt = {"schema": "semantic-release-restore-drill/1", "status": "running", "phase": "extraction",
               "archive": verified["verification"], "producer": original, "limits": args.limits,
               "restorerFiles": {name: release.file_receipt(Path(__file__).with_name(name)) for name in
                   ["restore-semantic-release.py", "restore-release-campaign.mjs", "package-semantic-release.py", "release_archive.py"]},
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
