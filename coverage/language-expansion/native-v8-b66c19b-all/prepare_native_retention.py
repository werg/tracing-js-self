"""Retain completed final v8 evidence without changing either source checkout.

The explicit completion flag prevents this preparation helper from being used
as a partial-run report. Full pinned reports and metering must already exist.
"""

from datetime import datetime, timezone
from pathlib import Path
import argparse
import json
import shutil
import subprocess
import sys
import time

from build_native_readme import CONSUMER, POPULATIONS, PRODUCER, load_evidence, read, render, require, sha


def verify_history(directory):
    require(directory.is_dir(), "Missing verified superseded history")
    for line in (directory / "SHA256SUMS").read_text().splitlines():
        digest, name = line.split(maxsplit=1)
        name = name.lstrip("*")
        path = directory / name
        require(path.resolve().is_relative_to(directory.resolve()), "Unsafe historical checksum path")
        require(sha(path) == digest, f"Superseded history digest: {name}")
    verification = read(directory / "verification.json")
    require(verification["status"] == "superseded-not-final-evidence", "Historical scope")
    require(verification["freshNativeExecution"] is False, "Historical verification scope")
    return {p.relative_to(directory).as_posix(): sha(p) for p in sorted(directory.rglob("*")) if p.is_file()}


def write_json(path, value):
    path.write_text(json.dumps(value, indent=2) + "\n")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--confirm-complete", action="store_true", required=True)
    for name in ["evidence-root", "producer-root", "consumer-validation", "producer-validation", "history", "output"]:
        parser.add_argument("--" + name, type=Path, required=True)
    parser.add_argument("--comparison", type=Path)
    parser.add_argument("--max-archive-bytes", type=int, default=8_000_000)
    args = parser.parse_args()
    require(not args.output.exists(), "The retained output directory must not exist")
    started = datetime.now(timezone.utc).isoformat()
    bundle = load_evidence(args.evidence_root, args.producer_root, args.consumer_validation, args.producer_validation, args.comparison)
    historical_files = verify_history(args.history)
    helper_root = Path(__file__).resolve().parent
    generic_root = helper_root if (helper_root / "retain-evidence.py").exists() else args.producer_root / "coverage/language-expansion/native-v8-8d1f7b5-all"
    commands = []

    def run(command):
        begin = time.monotonic()
        completed = subprocess.run([str(v) for v in command], text=True, capture_output=True)
        row = {"command": [str(v) for v in command], "exitCode": completed.returncode,
               "durationSeconds": time.monotonic() - begin,
               "stdout": completed.stdout, "stderr": completed.stderr}
        commands.append(row)
        require(completed.returncode == 0, f"Retention command failed: {command}\n{completed.stderr}")
        print(json.dumps({"completed": str(command[1]), "exitCode": 0, "durationSeconds": row["durationSeconds"]}), flush=True)

    for ident in POPULATIONS:
        run(["node", generic_root / "retain-native-inputs.mjs", args.evidence_root / f"native-{ident}"])
    command = [sys.executable, generic_root / "retain-evidence.py", "--output", args.output]
    for ident in POPULATIONS:
        command.extend(["--population", f"{ident}:{args.evidence_root / ('native-' + ident)}:{args.evidence_root / ('costs-' + ident)}"])
    command.extend(["--comparison", bundle["comparisonPath"], "--comparison-inputs", args.evidence_root / "comparison-inputs.json",
                    "--reference", args.evidence_root / "reference", "--policy", args.producer_root / "contracts/semantic-native-policy-v8.json",
                    "--validation", args.consumer_validation, "--max-archive-bytes", str(args.max_archive_bytes)])
    run(command)
    for name in ["retain-native-inputs.mjs", "retain-evidence.py"]:
        shutil.copyfile(generic_root / name, args.output / name)
        require(sha(generic_root / name) == sha(args.output / name), f"Copied generic helper: {name}")
    for name in ["build_native_readme.py", "prepare_native_retention.py", "README.template.md"]:
        shutil.copyfile(helper_root / name, args.output / name)
    shutil.copyfile(args.evidence_root / "comparison-inputs.json", args.output / "comparison-inputs.json")
    shutil.copyfile(args.consumer_validation / "summary.json", args.output / "consumer-validation.json")
    shutil.copyfile(args.producer_validation / "summary.json", args.output / "producer-validation-summary.json")
    history_out = args.output / "history/ea4ccff-superseded"
    shutil.copytree(args.history, history_out)
    require(verify_history(history_out) == historical_files, "Copied history bytes differ")
    require(verify_history(args.history) == historical_files, "Source history changed during retention")
    # The original reports must remain byte-identical throughout retention.
    for path, digest in bundle["bindings"].items():
        require(sha(path) == digest, f"Input changed during retention: {path}")
    write_json(args.output / "retention-inputs.json", {
        "schema": "semantic-v8-retention-inputs/1", "producerRevision": PRODUCER,
        "consumerRevision": CONSUMER, "reports": bundle["bindings"],
        "sourceReportsChanged": False, "freshNativeExecution": False,
        "history": {"destination": "history/ea4ccff-superseded", "scope": "superseded-not-final-evidence", "files": historical_files},
    })
    write_json(args.output / "retention-run.json", {
        "schema": "semantic-v8-retention-run/1", "startedAt": started,
        "finishedAt": datetime.now(timezone.utc).isoformat(), "commands": commands,
        "scope": "Integrity verification, exact input reconstruction and retention; no new source/native/model execution.",
    })
    (args.output / "README.md").write_text(render(bundle, args.output))
    inventory = [{"path": p.relative_to(args.output).as_posix(), "bytes": p.stat().st_size, "sha256": sha(p)}
                 for p in sorted(args.output.rglob("*")) if p.is_file()]
    write_json(args.output / "package-manifest.json", {
        "schema": "semantic-v8-evidence-package/1", "producerRevision": PRODUCER,
        "consumerRevision": CONSUMER, "digestEncoding": "sha256 of exact file bytes",
        "scope": "Current evidence plus separately labelled unchanged historical retention.",
        "files": inventory,
        "exclusions": ["package-manifest.json (this manifest)", "SHA256SUMS (binds the manifest and all other package files)"],
    })
    checksum_paths = sorted(p for p in args.output.rglob("*") if p.is_file())
    (args.output / "SHA256SUMS").write_text("".join(f"{sha(p)}  {p.relative_to(args.output).as_posix()}\n" for p in checksum_paths))
    archive = read(args.output / "archive.json")
    print(json.dumps({"output": str(args.output), "files": len(inventory) + 2,
                      "archives": len(archive["archives"]),
                      "packageManifestSha256": sha(args.output / "package-manifest.json"),
                      "sha256sumsSha256": sha(args.output / "SHA256SUMS")}), flush=True)


if __name__ == "__main__":
    main()
