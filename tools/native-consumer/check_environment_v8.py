#!/usr/bin/env python3
"""Check the actual direct V8 release runtime without importing a legacy route."""
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


def require(condition, message):
    if not condition:
        raise ValueError(message)


def read_json(path):
    require(path.stat().st_size <= 128 * 1024**2, "Environment JSON exceeds its bound")

    def pairs(items):
        result = {}
        for name, value in items:
            require(name not in result, "Repeated environment JSON key")
            result[name] = value
        return result

    def invalid(value):
        raise ValueError("Nonfinite environment JSON number: " + value)

    return json.loads(path.read_bytes(), object_pairs_hook=pairs, parse_constant=invalid)


def verify(consumer, tokenizer, policy_path):
    root = Path(__file__).resolve().parents[2]
    lock_path = root / "tools/native-consumer/requirements.lock"
    runtime_path = root / "profiles/release-environment-v8.lock.json"
    lock, qualification = read_json(runtime_path), read_json(policy_path)
    policy = qualification["nativePolicy"]
    require(qualification.get("schema") == "semantic-v8-qualification/1" and
            policy.get("schema") == "semantic-native-policy/8", "Expected direct V8 qualification policy")
    expected = dict(re.findall(r"^([A-Za-z0-9_.-]+)==([^\s\\]+)", lock_path.read_text(), re.MULTILINE))
    require(expected, "Native dependency lock is empty")
    installed = {name: importlib.metadata.version(name) for name in expected}
    require(installed == expected, "Installed package versions differ from the exact native lock")
    require(platform.python_version() == lock["python"], "Python differs from the V8 release runtime lock")
    node = json.loads(subprocess.check_output([
        "node", "-e", ("process.stdout.write(JSON.stringify({node:process.versions.node,v8:process.versions.v8,"
        "platform:process.platform,arch:process.arch,timezone:Intl.DateTimeFormat().resolvedOptions().timeZone}))")
    ], cwd=root, text=True, timeout=30))
    require(all(node[name] == lock[name] for name in ("node", "v8", "platform", "arch", "timezone")),
            "Node, V8, architecture, platform or timezone differs from the V8 runtime lock")
    npm = subprocess.check_output(["npm", "--version"], cwd=root, text=True, timeout=30).strip()
    require(npm == lock["npm"] and os.environ.get("LC_ALL", os.environ.get("LANG")) == lock["locale"],
            "npm or locale differs from the V8 runtime lock")
    consumer = consumer.resolve()
    git_env = {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}

    def git(*args):
        return subprocess.check_output(["git", *args], cwd=consumer, env=git_env, text=True, timeout=30).strip()

    require(git("rev-parse", "HEAD") == policy["consumerRevision"] and
            not git("status", "--porcelain", "--untracked-files=all"),
            "Native runtime is not the exact clean qualification revision")
    import megatoken
    import torch
    from megatoken.generation.codec import ByteCodec

    require(Path(megatoken.__file__).resolve().is_relative_to(consumer / "src"),
            "Native imports do not belong to the declared checkout")
    sha = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()
    require(sha(tokenizer) == policy["tokenizerSha256"], "Tokenizer bytes differ from qualification")
    codec = ByteCodec.from_tokenizer_json(tokenizer, expected_sha256=policy["tokenizerSha256"])
    require(codec.fingerprint == policy["tokenizerIdentity"], "Tokenizer identity differs from qualification")
    return {"schema": "semantic-v8-release-environment/1", "status": "verified",
            "consumerRevision": policy["consumerRevision"], "consumerTree": git("rev-parse", "HEAD^{tree}"),
            "nativePolicy": policy, "requirementsLockSha256": sha(lock_path),
            "runtimeLockSha256": sha(runtime_path), "producerLockSha256": sha(root / "npm-shrinkwrap.json"),
            "node": node, "npm": npm, "python": sys.version, "packages": installed,
            "torch": str(torch.__version__), "cudaAvailable": torch.cuda.is_available(),
            "platform": platform.platform(), "machine": platform.machine(), "libc": list(platform.libc_ver()),
            "locale": os.environ.get("LC_ALL", os.environ.get("LANG")),
            "runnerImage": {key: os.environ.get(key) for key in ("ImageOS", "ImageVersion", "CONTAINER_IMAGE_DIGEST")},
            "tokenizerSha256": sha(tokenizer), "tokenizerIdentity": codec.fingerprint,
            "portableContainerQualification": False, "optimizerUpdates": 0, "learnedSuccess": None}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--megatoken", type=Path, required=True)
    parser.add_argument("--tokenizer", type=Path, required=True)
    parser.add_argument("--policy", type=Path, required=True,
                        help="Exact qualification report containing its V8 nativePolicy")
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    require(not args.out.exists(), "Environment output already exists")
    result = verify(args.megatoken, args.tokenizer, args.policy)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    with args.out.open("x") as handle:
        json.dump(result, handle, indent=2, sort_keys=True, allow_nan=False)
        handle.write("\n")
    print(json.dumps({"status": "verified", "packages": len(result["packages"]),
                      "consumerRevision": result["consumerRevision"]}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
