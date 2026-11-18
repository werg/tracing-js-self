#!/usr/bin/env python3
"""Verify actual paired runtime, dependency, repository and tokenizer identities."""
from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import json
import os
import platform
import re
import subprocess
import sys
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--megatoken", type=Path, required=True)
    parser.add_argument("--tokenizer", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[2]
    policy_path = root / "contracts/native-admission-policy-v6.json"
    policy = json.loads(policy_path.read_text())
    environment = json.loads((root / "profiles/release-environment.lock.json").read_text())
    lock_path = Path(__file__).with_name("requirements.lock")
    sha = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()
    expected = dict(re.findall(r"^([A-Za-z0-9_.-]+)==([^\s\\]+)", lock_path.read_text(), re.M))
    if not expected:
        raise ValueError("Native environment lock is empty")
    installed = {name: importlib.metadata.version(name) for name in expected}
    mismatches = {name: {"expected": version, "actual": installed[name]}
                  for name, version in expected.items() if installed[name] != version}
    if mismatches:
        raise ValueError("Native dependency lock differs: " + json.dumps(mismatches))
    if platform.python_version() != environment["python"]:
        raise ValueError("Python runtime differs from the release environment lock")
    consumer = args.megatoken.resolve()
    git = lambda *argv: subprocess.check_output(["git", "-C", str(consumer), *argv], text=True).strip()
    revision = git("rev-parse", "HEAD")
    if revision != policy["consumerRevision"] or git("status", "--porcelain", "--untracked-files=no"):
        raise ValueError("Native consumer must be the clean, exact policy revision")
    untracked = [path for path in git("ls-files", "--others", "-z", "--", "src", "scripts").split("\0")
                 if path and Path(path).suffix in {".py", ".pyc", ".pyo", ".so", ".pyd"}
                 and not ("__pycache__" in Path(path).parts and Path(path).suffix == ".pyc")]
    if untracked:
        raise ValueError("Native consumer contains untracked importable code: " + ", ".join(untracked))
    import megatoken
    import torch
    from megatoken.generation.codec import ByteCodec
    if not Path(megatoken.__file__).resolve().is_relative_to(consumer):
        raise ValueError("Installed native consumer does not refer to the verified checkout")
    tokenizer = args.tokenizer.resolve()
    if sha(tokenizer) != policy["tokenizerSha256"]:
        raise ValueError("Tokenizer bytes differ from the release policy")
    codec = ByteCodec.from_tokenizer_json(tokenizer, expected_sha256=policy["tokenizerSha256"])
    if codec.fingerprint != policy["tokenizerIdentity"]:
        raise ValueError("Actual tokenizer identity differs from the release policy")
    report = {
        "schema": "semantic-native-environment-receipt/1", "status": "verified",
        "consumerRevision": revision, "consumerTree": git("rev-parse", "HEAD^{tree}"),
        "requirementsLockSha256": sha(lock_path), "nativePolicySha256": sha(policy_path),
        "python": sys.version, "platform": platform.platform(), "machine": platform.machine(),
        "libc": list(platform.libc_ver()), "timezone": os.environ.get("TZ"),
        "locale": os.environ.get("LC_ALL", os.environ.get("LANG")),
        "runnerImage": {key: os.environ.get(key) for key in ("ImageOS", "ImageVersion", "CONTAINER_IMAGE_DIGEST")},
        "packages": installed, "torch": torch.__version__, "cudaAvailable": torch.cuda.is_available(),
        "tokenizerSha256": sha(tokenizer), "tokenizerIdentity": codec.fingerprint,
        "optimizerSteps": 0, "learnedSuccess": None,
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    with args.out.open("x") as handle:
        json.dump(report, handle, indent=2, sort_keys=True)
        handle.write("\n")
    print(json.dumps({"status": "verified", "receipt": str(args.out), "packages": len(installed),
                      "consumerRevision": revision, "cudaAvailable": report["cudaAvailable"]}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
