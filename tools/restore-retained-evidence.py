#!/usr/bin/env python3
"""Verify a split retained-evidence archive and optionally restore all its files."""

import argparse
import hashlib
import json
import shutil
import tarfile
import tempfile
from pathlib import Path, PurePosixPath


def safe_relative(value):
    path = PurePosixPath(value)
    if not value or path.is_absolute() or any(part in ("", ".", "..") for part in path.parts):
        raise ValueError("Archive member must be an ordinary relative file path")
    return path


def digest_stream(stream, output=None):
    digest, length = hashlib.sha256(), 0
    for block in iter(lambda: stream.read(1 << 20), b""):
        digest.update(block)
        length += len(block)
        if output is not None:
            output.write(block)
    return length, digest.hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--inventory", type=Path, required=True)
    parser.add_argument("--out", type=Path)
    args = parser.parse_args()
    root = args.inventory.resolve().parent
    inventory = json.loads(args.inventory.read_text())
    expected = inventory["archive"]
    if args.out is not None and args.out.exists():
        raise ValueError("Restore output must be a new directory")
    files = inventory["files"]
    names = [entry["path"] for entry in files]
    if len(names) != len(set(names)):
        raise ValueError("Inventory repeats a file")
    for name in names:
        safe_relative(name)
    with tempfile.TemporaryFile(dir=root) as joined:
        for part in expected["parts"]:
            name = safe_relative(part["file"])
            with (root / name).open("rb") as source:
                actual = digest_stream(source, joined)
            if actual != (part["bytes"], part["sha256"]):
                raise ValueError("Archive part differs: " + str(name))
        joined.seek(0)
        if digest_stream(joined) != (expected["bytes"], expected["sha256"]):
            raise ValueError("Combined archive differs from the retained identity")
        joined.seek(0)
        with tarfile.open(fileobj=joined, mode="r:gz") as archive:
            members = archive.getmembers()
            if len(members) != len(names) or {member.name for member in members} != set(names):
                raise ValueError("Archive membership differs from the complete inventory")
            for member in members:
                if not (member.isfile() or member.islnk()):
                    raise ValueError("Unexpected archive member type")
                if member.islnk() and member.linkname not in names:
                    raise ValueError("Archive hard link leaves the inventoried files")
            for entry in files:
                member = archive.getmember(entry["path"])
                with archive.extractfile(member) as source:
                    actual = digest_stream(source)
                if actual != (entry["bytes"], entry["sha256"]):
                    raise ValueError("Retained file differs: " + entry["path"])
            if args.out is not None:
                args.out.mkdir(parents=True, exist_ok=False)
                for entry in files:
                    destination = args.out / safe_relative(entry["path"])
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    with archive.extractfile(entry["path"]) as source, destination.open("xb") as target:
                        shutil.copyfileobj(source, target, length=1 << 20)
    print(json.dumps({"verifiedFiles": len(files), "uncompressedBytes": sum(row["bytes"] for row in files),
                      "archiveSha256": expected["sha256"],
                      "restoredTo": str(args.out.resolve()) if args.out is not None else None}))


if __name__ == "__main__":
    main()
