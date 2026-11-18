#!/usr/bin/env python3
"""Reconstruct exact release archives from ordered, independently hashed parts."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import tempfile

CHUNK_BYTES = 1024 * 1024

def basename(value):
    if not isinstance(value, str) or not value or Path(value).name != value or value in {".", ".."}:
        raise ValueError("archive and part names must be plain basenames")
    return value

def digest(value):
    if not isinstance(value, str) or re.fullmatch(r"[0-9a-f]{64}", value) is None:
        raise ValueError("invalid SHA-256")
    return value

def byte_count(value):
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        raise ValueError("invalid byte count")
    return value

def reconstruct(entry, directory, output_directory, verify_only=False):
    name = basename(entry["archive"])
    expected_digest = digest(entry["sha256"])
    expected_bytes = byte_count(entry["bytes"])
    parts = entry["parts"]
    if not isinstance(parts, list) or not parts:
        raise ValueError("archive has no parts")
    names = [basename(part["file"]) for part in parts]
    if len(set(names)) != len(names):
        raise ValueError("duplicate part")
    for part in parts:
        digest(part["sha256"])
        byte_count(part["bytes"])
    if sum(part["bytes"] for part in parts) != expected_bytes:
        raise ValueError("part sizes do not match archive size")
    target = output_directory / name
    temporary = None
    output = None
    if not verify_only:
        output_directory.mkdir(parents=True, exist_ok=True)
        if target.exists():
            raise FileExistsError(f"refusing to replace existing archive: {target}")
        output = tempfile.NamedTemporaryFile(prefix=".release-", suffix=".partial",
                                             dir=output_directory, delete=False)
        temporary = Path(output.name)
    total = 0
    combined = hashlib.sha256()
    try:
        for part in parts:
            part_digest = hashlib.sha256()
            count = 0
            with (directory / part["file"]).open("rb") as source:
                while block := source.read(CHUNK_BYTES):
                    count += len(block)
                    part_digest.update(block)
                    combined.update(block)
                    if output is not None:
                        output.write(block)
            if count != part["bytes"] or part_digest.hexdigest() != part["sha256"]:
                raise ValueError(f"part integrity check failed: {part['file']}")
            total += count
        if total != expected_bytes or combined.hexdigest() != expected_digest:
            raise ValueError(f"complete archive integrity check failed: {name}")
        if output is not None:
            output.flush()
            os.fsync(output.fileno())
            output.close()
            # Same-directory hard link publishes atomically without overwriting.
            os.link(temporary, target)
        return {"archive": name, "bytes": total, "sha256": combined.hexdigest(),
                "status": "verified" if verify_only else "reassembled",
                "path": None if verify_only else str(target.resolve())}
    finally:
        if output is not None and not output.closed:
            output.close()
        if temporary is not None:
            temporary.unlink(missing_ok=True)

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--directory", type=Path, required=True, help="directory containing downloaded parts")
    parser.add_argument("--output-directory", type=Path, default=Path("."))
    parser.add_argument("--archive", action="append", help="exact archive basename; repeat to select several")
    parser.add_argument("--verify-only", action="store_true")
    args = parser.parse_args()
    manifest = json.loads(args.manifest.read_text())
    if manifest.get("schema") != "semantic-release-archive-parts/1":
        parser.error("unsupported parts manifest schema")
    archives = manifest["archives"]
    by_name = {basename(entry["archive"]): entry for entry in archives}
    if len(by_name) != len(archives):
        parser.error("duplicate archive")
    selected = args.archive or list(by_name)
    if len(set(selected)) != len(selected) or any(name not in by_name for name in selected):
        parser.error("unknown or duplicate archive selection")
    try:
        for name in selected:
            print(json.dumps(reconstruct(by_name[name], args.directory, args.output_directory, args.verify_only)))
    except (OSError, ValueError, KeyError, TypeError) as error:
        parser.exit(1, f"archive reconstruction failed: {error}\n")

if __name__ == "__main__":
    main()

