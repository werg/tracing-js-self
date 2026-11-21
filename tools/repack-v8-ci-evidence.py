#!/usr/bin/env python3
"""Preserve a checked Actions ZIP as a deterministic, auditable XZ tar archive."""

import argparse
import hashlib
import io
import json
import lzma
import tarfile
import zipfile
from pathlib import Path, PurePosixPath


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("zip", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--expected-zip-sha256", required=True)
    parser.add_argument("--exclude-model-assets", action="store_true")
    args = parser.parse_args()
    digest = hashlib.file_digest(args.zip.open("rb"), "sha256").hexdigest()
    if digest != args.expected_zip_sha256:
        raise ValueError("Downloaded artifact differs from the recorded ZIP digest")
    if args.output.exists() or Path(str(args.output) + ".manifest.json").exists():
        raise ValueError("Evidence output must be new; preserve previous attempts")
    retained, omitted = [], []
    with zipfile.ZipFile(args.zip) as source, lzma.open(args.output, "wb", preset=6) as compressed:
        with tarfile.open(fileobj=compressed, mode="w|") as target:
            names = set()
            for member in sorted(source.infolist(), key=lambda item: item.filename):
                if member.is_dir():
                    continue
                path = PurePosixPath(member.filename)
                if path.is_absolute() or ".." in path.parts or member.filename in names:
                    raise ValueError("Unsafe or repeated artifact member")
                names.add(member.filename)
                data = source.read(member.filename)
                identity = {"path": member.filename, "bytes": len(data),
                            "sha256": hashlib.sha256(data).hexdigest()}
                if args.exclude_model_assets and (
                    member.filename.endswith((".pt", ".safetensors"))
                    or member.filename.endswith("/served/tokenizer.json")
                ):
                    omitted.append(identity)
                    continue
                retained.append(identity)
                info = tarfile.TarInfo(member.filename)
                info.size, info.mode = len(data), 0o644
                target.addfile(info, io.BytesIO(data))
    with args.output.open("rb") as handle:
        archive_digest = hashlib.file_digest(handle, "sha256").hexdigest()
    manifest = {"schema": "v8-ci-artifact-repack/1", "zipSha256": digest,
                "archiveSha256": archive_digest, "archiveBytes": args.output.stat().st_size,
                "retained": retained, "omittedModelAssets": omitted}
    Path(str(args.output) + ".manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(json.dumps({"archiveSha256": archive_digest, "retainedFiles": len(retained),
                      "omittedModelAssets": len(omitted)}))


if __name__ == "__main__":
    main()
