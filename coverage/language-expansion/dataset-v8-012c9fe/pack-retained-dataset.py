#!/usr/bin/env python3
"""Package a completed and independently checked v8 dataset deterministically."""
import argparse
import hashlib
import json
import shutil
import tarfile
from pathlib import Path


def digest(path):
    result = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            result.update(chunk)
    return result.hexdigest()


def read(path):
    return json.loads(path.read_bytes())


def require(condition, message):
    if not condition:
        raise ValueError(message)


parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--run", type=Path, required=True)
parser.add_argument("--output", type=Path, required=True)
parser.add_argument("--prefix", required=True)
parser.add_argument("--interoperability-report", type=Path, required=True)
parser.add_argument("--gallery-report", type=Path, required=True)
parser.add_argument("--verification", type=Path, required=True)
parser.add_argument("--input-check", type=Path, required=True)
parser.add_argument("--helpers", type=Path, required=True)
parser.add_argument("--producer-revision", required=True)
parser.add_argument("--consumer-revision", required=True)
args = parser.parse_args()
require(Path(args.prefix).name == args.prefix and args.prefix not in (".", ".."), "Archive prefix")
root, output = args.run, args.output
manifest = read(root / "dataset/manifest.json")
inputs = read(root / "inputs.json")
verification = read(args.verification)
input_check = read(args.input_check)
require(verification["passed"] and verification["physicalTokenIdsReencoded"] and verification["byteRoundTripsRechecked"],
        "Independent physical-token check must pass")
require(input_check["passed"] and input_check["exactCandidateEquality"], "Qualification input check must pass")
for receipt in (verification, input_check):
    require(receipt["producerRevision"] == args.producer_revision and receipt["consumerRevision"] == args.consumer_revision,
            "Exact evidence pins")
require(manifest["admitted"] and manifest["nativeRequired"] and not manifest["allowLocal"], "Production native admission")
require(manifest["optimizerSteps"] == 0 and manifest["learnedSuccess"] is None, "No learning claim")
require(manifest["nativePolicy"]["consumerRevision"] == args.consumer_revision, "Manifest consumer pin")
require(inputs["producerRevision"] == args.producer_revision, "Input producer pin")
reports = [("interoperability", args.interoperability_report), ("gallery", args.gallery_report)]
for population, path in reports:
    report = read(path)
    binding = next(item for item in inputs["sources"] if item["population"] == population)
    require(digest(path) == binding["reportSha256"] and report["populationDigest"] == binding["populationDigest"],
            "Prerequisite report binding")
    require(report["declared"] == report["sourceQualified"] == report["nativeAdmitted"] == binding["declared"],
            "Complete qualification population")
output.mkdir(exist_ok=False)
for population, path in reports:
    shutil.copyfile(path, output / ("qualification-" + population + "-report.json"))
copies = [(root / "inputs.json", "inputs.json"), (root / "dataset/manifest.json", "manifest.json"),
          (args.verification, "verification.json"), (args.input_check, "qualification-input-check.json"),
          (args.helpers / "verify.py", "verify.py"),
          (args.helpers / "verify-qualification-inputs.py", "verify-qualification-inputs.py"),
          (Path(__file__), "pack-retained-dataset.py")]
for source, name in copies:
    shutil.copyfile(source, output / name)

members = []
for path in sorted(root.rglob("*")):
    require(not path.is_symlink(), "Archive cannot contain symlinks")
    if not path.is_file():
        continue
    members.append({"name": args.prefix + "/" + path.relative_to(root).as_posix(),
                    "path": path, "bytes": path.stat().st_size, "sha256": digest(path)})


def build_archive(path):
    with tarfile.open(path, "w:xz", format=tarfile.USTAR_FORMAT, preset=9) as archive:
        for member in members:
            info = tarfile.TarInfo(member["name"])
            info.size, info.mode, info.mtime = member["bytes"], 0o644, 0
            info.uid = info.gid = 0
            info.uname = info.gname = ""
            with member["path"].open("rb") as stream:
                archive.addfile(info, stream)


archive_path = output / "run.tar.xz"
repeat_path = output / "repeat.tar.xz"
build_archive(archive_path)
build_archive(repeat_path)
archive_sha = digest(archive_path)
require(archive_sha == digest(repeat_path), "Independent deterministic archive builds differ")
repeat_path.unlink()
with tarfile.open(archive_path, "r:xz") as archive:
    require(archive.getnames() == [member["name"] for member in members], "Exact archive inventory")
    for member in members:
        entry = archive.getmember(member["name"])
        require(entry.isfile() and entry.size == member["bytes"] and entry.mode == 0o644 and
                entry.mtime == entry.uid == entry.gid == 0 and not entry.uname and not entry.gname,
                "Deterministic member metadata")
        checksum = hashlib.sha256()
        with archive.extractfile(entry) as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                checksum.update(chunk)
        require(checksum.hexdigest() == member["sha256"], "Exact archived member bytes")
index = {"schema": "v8-dataset-retained-archive/1", "producerRevision": args.producer_revision,
         "consumerRevision": args.consumer_revision,
         "archive": {"file": "run.tar.xz", "sha256": archive_sha, "compressedBytes": archive_path.stat().st_size},
         "format": "USTAR/XZ preset 9; sorted regular files; mode0644; zero mtime/uid/gid; empty owner names",
         "repeatBuildSha256": archive_sha, "repeatBuildIdentical": True, "memberHashesRechecked": True,
         "files": [{key: value for key, value in member.items() if key != "path"} for member in members]}
(output / "archive-index.json").write_text(json.dumps(index, indent=2) + "\n")
registry = read(root / "dataset/family-registry.json")
splits = ("train", "validation", "test")
episodes = sum(manifest["episodes"].values())
examples = sum(manifest["examples"].values())
tokens = sum(manifest["generatedTokens"].values())
rows = "\n".join(f"| {split.title()} | {manifest['episodes'][split]:,} | {manifest['examples'][split]:,} | {manifest['generatedTokens'][split]:,} |" for split in splits)
source_rows = "\n".join(f"| {item['population'].title()} | {item['declared']} | `{item['reportSha256']}` |" for item in inputs["sources"])
short = args.producer_revision[:7]
readme = f"""# Independently admitted v8 dataset at {short}

This export used exact producer `{args.producer_revision}` and independent
consumer `{args.consumer_revision}`. It combines the complete
{inputs['sources'][0]['declared']}-case interoperability and
{inputs['sources'][1]['declared']}-case original gallery qualifications at those
same revisions. All **{episodes} episodes** passed fresh source and native
admission after the global split registry was frozen. There were zero source
refusals, export refusals or duplicate candidates.

| Split | Episodes | Complete examples | Generated tokens, including EOS |
| --- | ---: | ---: | ---: |
{rows}
| Total | {episodes:,} | {examples:,} | {tokens:,} |

There is one EOS per complete generated record: {examples:,} EOS tokens in total.
The frozen registry has {len(registry['sources'])} source members and
{len(registry['components'])} family components assigned with seed 17, with no
component crossing splits. Prompt loss labels are `-100`; generated tokens and
EOS retain their token IDs as labels. The context limit was
{manifest['maxContextTokens']:,} tokens and the per-episode limit was 4,096
examples. The verifier confirmed every target in every admitted episode.
Optimizer steps are zero and learned success is untested.

This is evidence for these exact revisions and declared episodes. Earlier
exports and qualification failures remain historical evidence with their original
pins; no historical receipt was relabeled as this run. This export independently
readmits the complete {episodes}-episode inventory, including the new cleanup and
iterable-binding cases, after the producer and consumer changed. It does not establish unrestricted ECMAScript
coverage, external model comprehension, learned execution, native serving
latency, cache reuse or default promotion.

## Exact retained inputs and independent checks

`run.tar.xz` retains the complete export run: candidates, all source-bound
artifacts, examples and token masks, frozen registry, dispositions, manifest,
export logs, every exact native transport and receipt, their binding index, and
the actual preparation/capture helpers. `inputs.json` binds these prerequisite
qualification reports:

| Population | Episodes | Exact report SHA-256 |
| --- | ---: | --- |
{source_rows}

Unchanged copies of both reports, `inputs.json` and the manifest are available
beside the archive. `qualification-input-check.json` independently verifies
their hashes and population identities, all {episodes} qualified source artifact
hashes and native qualification receipts, and exact equality of each candidate
with its qualification artifact. The reusable checker is retained here as
`verify-qualification-inputs.py`.

`verification.json` records the independent dataset check: every manifest file,
native transport, receipt and source/public/context/dataset-binding digest;
component split isolation; every complete target; causal prompt bytes; EOS,
loss labels, attention masks and token accounting. All **{examples:,} prompts and
targets** were re-encoded and byte-round-tripped with the pinned actual tokenizer:

- Tokenizer identity `{manifest['tokenizerIdentity']}`.
- Tokenizer SHA-256 `{manifest['nativePolicy']['tokenizerSha256']}`.
- Codec source SHA-256 `{verification['codecSourceSha256']}`, from the exact
  consumer revision above.
- Python `{verification['pythonVersion']}` and `tokenizers`
  `{verification['tokenizersVersion']}`.

The integrity verifier did not rerun native admission; its
`freshNativeExecution: false` describes that subsequent check. The export itself
performed and retains fresh native admission after dataset binding.

The archive uses sorted regular files, USTAR, XZ preset 9, mode `0644`, zero
modification times and UID/GID, and empty owner names. Two independent builds
produced identical archive bytes, and every member was rechecked after
decompression. `archive-index.json` records each member's length and SHA-256;
`SHA256SUMS` covers the packaged files. The packaging helper is also retained.

## Unpack and verify

From this directory:

```sh
sha256sum -c SHA256SUMS
mkdir -p unpacked
tar -xJf run.tar.xz -C unpacked
python3 verify.py unpacked/{args.prefix} \\
  --producer-revision {args.producer_revision} \\
  --consumer-revision {args.consumer_revision}
```

To repeat the physical token check with the pinned tokenizer and matching
`tokenizers` version, extract the codec from the exact consumer and add both
arguments:

```sh
git -C /path/to/megatoken show \\
  {args.consumer_revision}:src/megatoken/generation/codec.py \\
  > unpacked/codec-{args.consumer_revision[:7]}.py
/path/to/python verify.py unpacked/{args.prefix} \\
  --producer-revision {args.producer_revision} \\
  --consumer-revision {args.consumer_revision} \\
  --codec-source unpacked/codec-{args.consumer_revision[:7]}.py \\
  --tokenizer-json /path/to/ling-tokenizer.json
```

The checker requires the original codec and tokenizer hashes before re-encoding.
The qualification-input checker takes the unpacked run, both original complete
qualification directories via repeated `--qualification` arguments, and those
same `--producer-revision` and `--consumer-revision` values. The exact
qualification artifacts are retained in the associated final native evidence.

## Reproduce a fresh export

Use clean producer and consumer checkouts at the full SHAs above with their
locked dependencies and actual pinned tokenizer. Set `TRACING_JS_SELF_ROOT`,
`MEGATOKEN_ROOT`, `MEGATOKEN_PYTHON`, `MEGATOKEN_TOKENIZER_JSON`,
`SEMANTIC_V8_NATIVE_POLICY`, and an existing `TMPDIR`. If the Python environment
has an editable install pointing elsewhere, set `PYTHONPATH` to the frozen
consumer's `src` directory. No source checkout files should be generated by the
run. For a fresh export from the exact retained candidates:

```sh
mkdir reproduced-native-inputs
export V8_DATASET_CAPTURE="$PWD/reproduced-native-inputs"
node "$TRACING_JS_SELF_ROOT/tools/export-semantic-v8.mjs" \\
  --input "$PWD/unpacked/{args.prefix}/candidates.jsonl" \\
  --tokenizer-module "$TRACING_JS_SELF_ROOT/tools/semantic-v8-tokenizer-adapter.mjs" \\
  --native-module "$PWD/unpacked/{args.prefix}/v8-native-capture.mjs" \\
  --max-context 1048576 --max-examples 4096 --seed 17 \\
  --out "$PWD/reproduced-dataset"
```

Both output directories must be new. The captured receipts belong to this new
execution; they do not alter the retained archive. The preparation helper can
regenerate candidates from fresh complete interoperability and gallery
qualifications at the same clean producer SHA. Production export freezes the
whole family registry before constructing split-bound artifacts and requesting
fresh native admission. `--allow-local` was not used.
"""
(output / "README.md").write_text(readme)
checksums = "".join(digest(path) + "  " + path.name + "\n" for path in sorted(output.iterdir()) if path.is_file())
(output / "SHA256SUMS").write_text(checksums)
print(json.dumps({"output": str(output), "episodes": episodes, "examples": examples,
                  "generatedTokensWithEOS": tokens, "archiveSha256": archive_sha,
                  "archiveBytes": archive_path.stat().st_size, "archiveMembers": len(members),
                  "repeatBuildIdentical": True, "allMemberHashesChecked": True}, indent=2))
