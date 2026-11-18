#!/usr/bin/env python3
"""Prepare, recheck and package a complete private v5 dataset without publishing it."""
from __future__ import annotations

import argparse
import gzip
import hashlib
import io
import json
import os
import shutil
import subprocess
import tarfile
from collections import Counter
from pathlib import Path


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def stream_fingerprint(handle) -> tuple[int, str]:
    checksum, size = hashlib.sha256(), 0
    for block in iter(lambda: handle.read(1 << 20), b""):
        size += len(block)
        checksum.update(block)
    return size, checksum.hexdigest()


def file_fingerprint(path: Path) -> tuple[int, str]:
    with path.open("rb") as handle:
        return stream_fingerprint(handle)


class DigestingReader:
    def __init__(self, handle):
        self.handle, self.checksum, self.size = handle, hashlib.sha256(), 0

    def read(self, size):
        if size < 0:
            raise ValueError("Archive reads must be bounded")
        block = self.handle.read(size)
        self.size += len(block)
        self.checksum.update(block)
        return block


def canonical(value) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode()


def inside(root: Path, name: str) -> Path:
    path = root / name
    if not isinstance(name, str) or not name or Path(name).is_absolute() or ".." in Path(name).parts:
        raise ValueError("Release paths must be relative descendants")
    if path.is_symlink() or not path.resolve().is_relative_to(root.resolve()):
        raise ValueError("Release path escapes its source directory")
    return path


def inventory(roots: dict[str, Path]) -> tuple[list[dict], dict[str, Path]]:
    rows, sources = [], {}
    for prefix, root in sorted(roots.items()):
        paths = [root] if root.is_file() else sorted(root.rglob("*"))
        for path in paths:
            if path.is_symlink():
                raise ValueError("Release inputs must not contain symbolic links")
            if not path.is_file():
                continue
            relative = path.name if root.is_file() else path.relative_to(root).as_posix()
            name = prefix if root.is_file() else prefix + "/" + relative
            if name in sources:
                raise ValueError("Repeated release archive path")
            size, checksum = file_fingerprint(path)
            rows.append({"path": name, "bytes": size, "sha256": checksum})
            sources[name] = path
    return sorted(rows, key=lambda row: row["path"]), sources


def write_archive(destination: Path, payload: dict, sources: dict[str, Path]) -> dict:
    """Normalize tar/gzip metadata and detect changed bytes after inventory."""
    manifest = {**payload, "identityDigest": digest(canonical(payload))}
    manifest_bytes = json.dumps(manifest, indent=2, sort_keys=True, allow_nan=False).encode() + b"\n"
    temporary = destination.with_suffix(destination.suffix + ".partial")
    try:
        with temporary.open("xb") as raw, gzip.GzipFile(fileobj=raw, mode="wb", filename="", mtime=0) as compressed:
            with tarfile.open(fileobj=compressed, mode="w|", format=tarfile.PAX_FORMAT) as archive:
                for row in payload["files"]:
                    source = sources[row["path"]]
                    if source.stat().st_size != row["bytes"]:
                        raise ValueError("Release input changed after inventory: " + row["path"])
                    info = tarfile.TarInfo(row["path"])
                    info.size, info.mode, info.mtime = row["bytes"], 0o644, 0
                    with source.open("rb") as handle:
                        checked = DigestingReader(handle)
                        archive.addfile(info, checked)
                        if checked.size != row["bytes"] or checked.checksum.hexdigest() != row["sha256"] or \
                                source.stat().st_size != row["bytes"]:
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


def verify_archive(path: Path) -> dict:
    """Read and hash every archive member without extracting any paths."""
    with tarfile.open(path, "r:gz") as archive:
        members = archive.getmembers()
        names = [member.name for member in members]
        if len(names) != len(set(names)) or any(not member.isfile() for member in members):
            raise ValueError("Unexpected duplicate, link or special archive member")
        for name in names:
            if name.startswith("/") or ".." in Path(name).parts:
                raise ValueError("Unsafe archive path")
        manifest = json.load(archive.extractfile("release-manifest.json"))
        identity = manifest.pop("identityDigest")
        if identity != digest(canonical(manifest)):
            raise ValueError("Release identity digest changed")
        expected = {row["path"]: row for row in manifest["files"]}
        if len(expected) != len(manifest["files"]):
            raise ValueError("Repeated release inventory path")
        if set(names) != set(expected) | {"release-manifest.json"}:
            raise ValueError("Release inventory differs from archive contents")
        for name, row in expected.items():
            with archive.extractfile(name) as handle:
                size, checksum = stream_fingerprint(handle)
            if size != row["bytes"] or checksum != row["sha256"]:
                raise ValueError("Release member checksum changed: " + name)
        return {"schema": "semantic-release-verification/1", "status": "verified", "files": len(expected),
                "identityDigest": identity, "archiveSha256": file_fingerprint(path)[1]}


def stage_compact_campaign(corpus: Path, tracer: Path, output: Path, manifest: dict) -> tuple[dict, Path, dict | None]:
    """Rehydrate through the exact producer, including producers predating --out.

    Only immutable CAS files may be hard linked into staging; logs/manifests are
    copied because historical materializers can recover a torn log in place.
    The original complete campaign is always the archived audit authority.
    """
    if all(row.get("path") for row in manifest["cases"] if row["status"] == "admitted"):
        return manifest, corpus, None
    source_manifest = (corpus / "manifest.json").read_bytes()
    staging, destination = output / "materialization-input", output / "materialized"
    if any(path.is_symlink() for path in corpus.rglob("*")):
        raise ValueError("Compact campaign must not contain symbolic links")

    def copy_input(source, target):
        relative = Path(source).relative_to(corpus)
        if relative.parts[0] == "objects":
            try:
                os.link(source, target)
                return target
            except OSError:
                pass
        return shutil.copy2(source, target)

    try:
        shutil.copytree(corpus, staging, copy_function=copy_input)
        completed = subprocess.run(["node", str(tracer / "tools/materialize-campaign.mjs"), str(staging)],
                                   cwd=tracer, check=True, text=True, capture_output=True, timeout=600)
        hydrated = json.loads((staging / "manifest.json").read_text())
        before = [(row["id"], row["candidateDigest"], row["status"]) for row in manifest["cases"]]
        after = [(row["id"], row["candidateDigest"], row["status"]) for row in hydrated["cases"]]
        if before != after or manifest["producerRevision"] != hydrated["producerRevision"]:
            raise ValueError("Materialization changed a candidate identity or admission disposition")
        destination.mkdir(parents=True)
        paths = []
        for row in hydrated["cases"]:
            if row["status"] != "admitted":
                continue
            source, target = inside(staging, row["path"]), inside(destination, row["path"])
            target.parent.mkdir(parents=True, exist_ok=True)
            source.replace(target)
            paths.append(row["path"])
        receipt = {"schema": "semantic-release-materialization/1", "producerRevision": manifest["producerRevision"],
                   "sourceCampaignDigest": manifest["campaign"]["identityDigest"],
                   "sourceManifestSha256": digest(source_manifest), "materializedAdmitted": len(paths),
                   "paths": paths, "producerToolReceipt": json.loads(completed.stdout),
                   "originalCampaignArchived": True, "admissionUnchanged": True}
        (destination / "materialization-receipt.json").write_text(json.dumps(receipt, indent=2, sort_keys=True) + "\n")
        if source_manifest != (corpus / "manifest.json").read_bytes():
            raise ValueError("Original campaign changed during materialization")
        return hydrated, destination, receipt
    finally:
        shutil.rmtree(staging, ignore_errors=True)


def required_audit_campaign(manifest: dict, directory: Path | None) -> tuple[Path | None, dict | None]:
    declaration = manifest.get("selection") or manifest.get("materialization") or {}
    required = declaration.get("originalCampaignRequiredForAudit") or declaration.get("sourceCampaignRequiredForAudit")
    if required and directory is None:
        raise ValueError("Selected/materialized subsets require --audit-campaign with the complete original CAS and refusals")
    if directory is None:
        return None, None
    root = directory.resolve()
    original = (root / "manifest.json").read_bytes()
    header = json.loads((root / "campaign.json").read_text())
    if not required or digest(original) != declaration.get("sourceManifestSha256") or \
            header["identityDigest"] != declaration.get("sourceCampaignDigest"):
        raise ValueError("Audit campaign differs from the immutable selection/materialization source")
    source = json.loads(original)
    return root, {"sourceCampaignDigest": header["identityDigest"], "manifestSha256": digest(original),
                  "counts": source["counts"], "attempted": len(source["cases"])}


def verify_campaign_storage(corpus: Path, tracer: Path) -> dict | None:
    if not (corpus / "campaign.json").exists():
        return None
    # The producer's own decoder knows its historical or registry-CAS format.
    # Check a complete log first so older decoders cannot recover it in place.
    script = """
import {readFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
const [moduleFile,directory]=process.argv.slice(1);
const {CampaignStore}=await import(pathToFileURL(moduleFile));
const header=JSON.parse(readFileSync(join(directory,'campaign.json'),'utf8'));
const log=join(directory,'campaign.jsonl');
if(existsSync(log)){const bytes=readFileSync(log);if(bytes.length&&bytes.at(-1)!==10)
  throw new Error('Incomplete campaign log; resume collection before release');}
const store=new CampaignStore(directory,header.identity,{resume:true,recoverTornLog:false,
  maxObjectBytes:header.identity.bounds?.maxOutputBytes??268435456});
for(const entry of store.entries){const candidate=store.readObject(entry.candidate);
  for(const input of candidate.inputs??[])for(const key of ['source','input','fixture'])store.readObject(input[key]);}
const manifest=JSON.parse(readFileSync(join(directory,'manifest.json'),'utf8')),seen=new Set();
for(const row of manifest.cases){const entry=store.latest.get(row.id);
  if(!entry||seen.has(row.id)||entry.status!==row.status||entry.candidateDigest!==row.candidateDigest)
    throw new Error('Manifest differs from immutable campaign');seen.add(row.id);}
console.log(JSON.stringify({schema:'semantic-release-campaign-storage-check/1',status:'verified',
  identityDigest:store.identityDigest,attempts:store.entries.length,latestRows:store.latest.size,
  manifestRows:manifest.cases.length}));
"""
    checked = subprocess.run(["node", "--input-type=module", "-e", script,
                              str(tracer / "src/corpus/campaign-store.mjs"), str(corpus)],
                             cwd=tracer, check=True, text=True, capture_output=True, timeout=600)
    return json.loads(checked.stdout)


def iter_admitted_documents(manifest: dict, root: Path, identities: list, source_notices: dict):
    """Read one complete row at a time; retain only small release metadata."""
    for row in manifest["cases"]:
        if row["status"] != "admitted":
            continue
        document = json.loads(inside(root, row["path"]).read_text())
        side = document["sidecar"]
        if side["producerRevision"] != manifest["producerRevision"] or side.get("identityDigest") != row.get("identityDigest"):
            raise ValueError("Candidate identity differs from the campaign manifest")
        identities.append({"id": row["id"], "family": side["sourceFamily"], "split": side["split"],
                           "identityDigest": side["identityDigest"], "episodeDigest": row["episodeDigest"]})
        source_notices[side["sourceFamily"]] = {"license": side["license"], "provenance": side["sourceProvenance"]}
        yield document


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--verify", type=Path)
    parser.add_argument("--corpus", type=Path)
    parser.add_argument("--audit-campaign", type=Path)
    parser.add_argument("--tracer-root", type=Path)
    parser.add_argument("--megatoken", type=Path)
    parser.add_argument("--tokenizer", type=Path)
    parser.add_argument("--environment-receipt", type=Path)
    parser.add_argument("--out", type=Path)
    args = parser.parse_args()
    if args.verify:
        print(json.dumps(verify_archive(args.verify), sort_keys=True))
        return 0
    if any(getattr(args, field) is None for field in
           ("corpus", "tracer_root", "megatoken", "tokenizer", "environment_receipt", "out")):
        parser.error("Packaging requires --corpus --tracer-root --megatoken --tokenizer --environment-receipt --out")
    corpus, tracer, consumer, output = (path.resolve() for path in
                                      (args.corpus, args.tracer_root, args.megatoken, args.out))
    if output.exists():
        raise ValueError("Release directories are immutable; choose a new destination")
    if output.is_relative_to(corpus):
        raise ValueError("Release destination must be outside its input corpus")
    manifest = json.loads((corpus / "manifest.json").read_text())
    audit, audit_summary = required_audit_campaign(manifest, args.audit_campaign)
    if audit and output.is_relative_to(audit):
        raise ValueError("Release destination must be outside its audit campaign")
    policy = json.loads((tracer / "contracts/native-admission-policy-v5.json").read_text())
    environment = json.loads(args.environment_receipt.read_text())
    git = lambda path, *argv: subprocess.check_output(["git", "-C", str(path), *argv], text=True).strip()
    if git(tracer, "rev-parse", "HEAD") != manifest["producerRevision"]:
        raise ValueError("Use the exact producing checkout to recheck and release this corpus")
    if git(tracer, "status", "--porcelain", "--untracked-files=no"):
        raise ValueError("Producing checkout has modified tracked files")
    if git(consumer, "rev-parse", "HEAD") != policy["consumerRevision"]:
        raise ValueError("Consumer differs from the producer release policy")
    if git(consumer, "status", "--porcelain", "--untracked-files=no"):
        raise ValueError("Native consumer has modified tracked files")
    if environment["status"] != "verified" or any(environment[key] != policy[key] for key in policy):
        raise ValueError("Native environment receipt differs from the release policy")
    if environment["requirementsLockSha256"] != digest((tracer / "tools/native-consumer/requirements.lock").read_bytes()):
        raise ValueError("Native environment receipt uses a different dependency lock")
    counts = Counter(row["status"] for row in manifest["cases"])
    if manifest["counts"]["attempted"] != len(manifest["cases"]) or any(manifest["counts"].get(key) != value for key, value in counts.items()):
        raise ValueError("Candidate dispositions do not reconcile with the manifest")
    if not counts["admitted"]:
        raise ValueError("A release needs actual admitted examples")
    campaign_checks = {name: receipt for name, source in (("corpus", corpus), ("audit-campaign", audit))
                       if source is not None and (receipt := verify_campaign_storage(source, tracer)) is not None}
    output.mkdir(parents=True)
    document_manifest, document_root, materialization = stage_compact_campaign(corpus, tracer, output, manifest)
    identities, source_notices = [], {}
    documents = iter_admitted_documents(document_manifest, document_root, identities, source_notices)
    import megatoken
    if not Path(megatoken.__file__).resolve().is_relative_to(consumer):
        raise ValueError("Installed native consumer package is outside the requested checkout")
    from megatoken.data.semantic_corpus import prepare_semantic_corpus, source_verifier_for_checkout
    from megatoken.generation.codec import ByteCodec
    codec = ByteCodec.from_tokenizer_json(args.tokenizer, expected_sha256=policy["tokenizerSha256"])
    if codec.fingerprint != policy["tokenizerIdentity"]:
        raise ValueError("Actual native tokenizer identity changed")
    prepared, report = prepare_semantic_corpus(documents, output / "prepared", codec=codec,
        producer_revision=manifest["producerRevision"], consumer_revision=policy["consumerRevision"],
        source_verifier=source_verifier_for_checkout(tracer, manifest["producerRevision"]))
    if report["counts"].get("admitted") != counts["admitted"] or \
            len(identities) != counts["admitted"] or report["refusals"]:
        raise ValueError("Production rechecking rejected release rows; refusal evidence was retained")
    if git(consumer, "rev-parse", "HEAD") != policy["consumerRevision"] or \
            git(consumer, "status", "--porcelain", "--untracked-files=no"):
        raise ValueError("Native consumer changed during preparation")
    notices = output / "source-notices.json"
    notices.write_text(json.dumps(source_notices, indent=2, sort_keys=True) + "\n")
    roots = {"corpus": corpus, "prepared": output / "prepared", "source-notices.json": notices,
             "native-environment.json": args.environment_receipt.resolve(),
             "locks/environment.json": tracer / "profiles/release-environment.lock.json",
             "locks/native-policy.json": tracer / "contracts/native-admission-policy-v5.json",
             "locks/requirements.lock": tracer / "tools/native-consumer/requirements.lock",
             "locks/producer-package-lock.json": tracer / "package-lock.json",
             "locks/oracle-package-lock.json": tracer / "tools/spec-oracle/package-lock.json"}
    if materialization:
        roots["materialized"] = document_root
    if audit:
        roots["audit-campaign"] = audit
    files, sources = inventory(roots)
    payload = {"schema": "semantic-private-release/1", "distribution": "private-audit-only",
        "producerRevision": manifest["producerRevision"], "consumerRevision": policy["consumerRevision"],
        "tokenizer": policy, "campaignManifestSha256": digest((corpus / "manifest.json").read_bytes()),
        "counts": dict(counts), "attempted": len(manifest["cases"]), "nativePrepared": report["accepted"],
        "preparedFingerprint": prepared["fingerprint"], "identities": identities,
        "materialization": materialization, "auditCampaign": audit_summary, "campaignStorageChecks": campaign_checks,
        "publicRedistributionApproved": False,
        "licensePolicy": "Retain exact upstream notices; repository-fixture is provenance, not an SPDX license. Owner approval is needed for public corpus distribution.",
        "optimizerSteps": 0, "learnedSuccess": None, "files": files}
    archive = output / "semantic-v5-release.tar.gz"
    write_archive(archive, payload, sources)
    verified = verify_archive(archive)
    (output / "archive-receipt.json").write_text(json.dumps(verified, indent=2, sort_keys=True) + "\n")
    print(json.dumps({**verified, "archive": str(archive), "counts": dict(counts), "nativePrepared": report["accepted"]}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
