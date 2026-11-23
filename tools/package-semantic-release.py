#!/usr/bin/env python3
"""Prepare, recheck and package a complete private v5 dataset without publishing it."""
from __future__ import annotations

import argparse
import fcntl
import gzip
import hashlib
import importlib.util
import json
import os
import shutil
import sqlite3
import subprocess
import sys
from contextlib import contextmanager
from pathlib import Path

# Resolve the adjacent implementation explicitly, including when this command
# is loaded by importlib rather than executed as a script.
ARCHIVE_IMPLEMENTATION_SHA256 = "d841fd8493f798870b21bc82bd8902c2f411e945fed6dd6de59dd176d46e465c"
_archive_path = Path(__file__).with_name("release_archive.py")
with _archive_path.open("rb") as _archive_stream:
    _archive_source = _archive_stream.read(1024 * 1024 + 1)
if len(_archive_source) > 1024 * 1024 or hashlib.sha256(_archive_source).hexdigest() != ARCHIVE_IMPLEMENTATION_SHA256:
    raise ValueError("Pinned release archive implementation changed")
_archive_spec = importlib.util.spec_from_file_location("release_archive", _archive_path)
_archive = importlib.util.module_from_spec(_archive_spec)
# Compile exactly the checked source, without a second read or cached bytecode.
exec(compile(_archive_source, str(_archive_path), "exec", dont_inherit=True), _archive.__dict__)  # noqa: S102 - exact source bytes were bounded and pinned above

CHUNK_BYTES = _archive.CHUNK_BYTES
MAX_MANIFEST_BYTES = _archive.MAX_MANIFEST_BYTES
MAX_OBJECT_BYTES = _archive.MAX_OBJECT_BYTES
SHA256 = _archive.SHA256
digest = _archive.digest
canonical = _archive.canonical
archive_name = _archive.archive_name
inside = _archive.inside
hash_stream = _archive.hash_stream
file_identity = _archive.file_identity
file_receipt = _archive.file_receipt
HashingReader = _archive.HashingReader
validate_inventory = _archive.validate_inventory
inventory = _archive.inventory
read_bounded = _archive.read_bounded
read_json = _archive.read_json
write_json = _archive.write_json


def archive_implementation_receipts() -> dict:
    """Retain the dependency bound by this wrapper's independently pinned bytes."""
    receipt = file_receipt(_archive_path)
    if receipt["sha256"] != ARCHIVE_IMPLEMENTATION_SHA256:
        raise ValueError("Pinned release archive implementation changed")
    return {_archive_path.name: receipt}


def write_archive(destination: Path, payload: dict, sources: dict[str, Path]) -> dict:
    """Preserve this command's bounded-manifest setting and archive interface."""
    return _archive.write_archive(destination, payload, sources, max_manifest_bytes=MAX_MANIFEST_BYTES)


def verify_archive(path: Path, *, opener=None) -> dict:
    """Preserve this command's bounded-manifest setting and verification interface."""
    return _archive.verify_archive(path, opener=opener, max_manifest_bytes=MAX_MANIFEST_BYTES)


@contextmanager
def locked_campaign(corpus: Path):
    """Keep the producer's shared OS lock throughout rechecking and archiving."""
    with inside(corpus, ".campaign.lock").open("rb") as lock:
        try:
            fcntl.flock(lock.fileno(), fcntl.LOCK_SH | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise ValueError("Campaign is still open by a writer; finish collection before packaging") from error
        try:
            yield
        finally:
            fcntl.flock(lock.fileno(), fcntl.LOCK_UN)


def verify_campaign(corpus: Path, destination: Path) -> dict:
    verifier = Path(__file__).with_name("verify-release-campaign.mjs")
    with destination.open("x") as stream:
        result = subprocess.run(["node", str(verifier), str(corpus)], stdout=stream, stderr=subprocess.PIPE,
                                text=True, timeout=3600, check=False)
    if result.returncode:
        raise ValueError("Complete campaign verification failed: " + result.stderr[-4000:])
    receipt = read_json(destination)
    if receipt.get("status") != "verified" or receipt.get("schema") != "semantic-release-campaign-receipt/1":
        raise ValueError("Malformed campaign verification receipt")
    return receipt


def check_environment_receipt(environment: dict, policy: dict, tracer: Path):
    if (environment.get("schema") != "semantic-native-environment-receipt/1"
            or environment.get("status") != "verified"
            or any(environment.get(key) != value for key, value in policy.items())):
        raise ValueError("Native environment receipt differs from the release policy")
    if environment.get("requirementsLockSha256") != file_receipt(tracer / "tools/native-consumer/requirements.lock")["sha256"]:
        raise ValueError("Native environment receipt uses a different dependency lock")
    if environment.get("nativePolicySha256") != file_receipt(tracer / "contracts/native-admission-policy-v6.json")["sha256"]:
        raise ValueError("Native environment receipt uses different policy bytes")


def recheck_environment(tracer: Path, consumer: Path, tokenizer: Path, supplied: Path,
                        destination: Path, policy: dict) -> dict:
    previous = read_json(supplied)
    check_environment_receipt(previous, policy, tracer)
    # Use the original producing checkout's checker, not this packager's current
    # policy. A supplied receipt is evidence to compare, never an execution gate.
    checker = tracer / "tools/native-consumer/check_environment.py"
    result = subprocess.run([sys.executable, str(checker), "--megatoken", str(consumer),
                             "--tokenizer", str(tokenizer), "--out", str(destination)],
                            capture_output=True, text=True, timeout=600, check=False)
    if result.returncode:
        raise ValueError("Fresh native environment verification failed: " + result.stderr[-4000:])
    actual = read_json(destination)
    check_environment_receipt(actual, policy, tracer)
    if actual != previous:
        raise ValueError("Supplied native environment receipt is stale; actual fresh receipt was retained")
    return actual


def read_campaign_object(corpus: Path, reference: dict):
    path = inside(corpus, reference["path"])
    if (type(reference.get("uncompressedBytes")) is not int or reference["uncompressedBytes"] < 0
            or reference["uncompressedBytes"] > MAX_OBJECT_BYTES
            or reference.get("bytes", MAX_OBJECT_BYTES + 1) > MAX_OBJECT_BYTES
            or reference.get("encoding") not in {"json", "gzip"}):
        raise ValueError("Campaign object exceeds its bounded size or uses an unknown encoding")
    if file_receipt(path) != {"bytes": reference["bytes"], "sha256": reference["sha256"]}:
        raise ValueError("Campaign object bytes changed after verification")
    opener = gzip.open if reference["encoding"] == "gzip" else Path.open
    with opener(path, "rb") as stream:
        raw = read_bounded(stream, reference["uncompressedBytes"])
    if len(raw) != reference["uncompressedBytes"] or digest(raw) != reference["contentSha256"]:
        raise ValueError("Campaign object content changed after verification")
    return json.loads(raw)


def load_document(corpus: Path, row: dict) -> dict:
    # Compact collections need no large compatibility export. The campaign
    # verifier binds these exact references to the complete committed attempt.
    if row.get("path"):
        return read_json(inside(corpus, row["path"]), 2 * MAX_OBJECT_BYTES)
    return {"public": read_campaign_object(corpus, row["publicShard"]),
            "sidecar": read_campaign_object(corpus, row["privateEvidence"])}


def check_document_identity(row: dict, document: dict, producer_revision: str, public_digest) -> dict:
    side = document["sidecar"]
    if (side.get("producerRevision") != producer_revision or side.get("identityDigest") != row.get("identityDigest")
            or side.get("sourceFamily") != row.get("family") or side.get("split") != row.get("split")
            or side.get("admission") != "admitted" or public_digest(document) != row.get("episodeDigest")):
        raise ValueError("Candidate identity or actual public digest differs from the campaign manifest: " + row["id"])
    return {"id": row["id"], "family": side["sourceFamily"], "split": side["split"],
            "identityDigest": side["identityDigest"], "episodeDigest": row["episodeDigest"]}


def document_digest(document: dict) -> str:
    """Bind cached source verification to every private/public byte semantically."""
    checksum = hashlib.sha256()
    for piece in json.JSONEncoder(sort_keys=True, separators=(",", ":"), ensure_ascii=False,
                                  allow_nan=False).iterencode(document):
        checksum.update(piece.encode())
    return checksum.hexdigest()


def qualify_candidates(corpus, admitted, receipt_path, *, codec, producer_revision, consumer_revision,
                       source_verifier, native_admission, verify_admission, adapt_selected, public_digest):
    qualified, sources, identities, notices = [], {}, [], {}
    with receipt_path.open("x") as evidence:
        for row in admitted:
            try:
                document = load_document(corpus, row)
                identity = check_document_identity(row, document, producer_revision, public_digest)
                exact = document_digest(document)
                source = source_verifier(document)
                native = native_admission(document, codec=codec, consumer_revision=consumer_revision)
                verify_admission(document, source, native, producer_revision=producer_revision,
                                 consumer_revision=consumer_revision, codec=codec)
                episode, _ = adapt_selected(document, codec=codec, max_positions=1024, max_history=1024,
                                            admission_verifier=lambda _: True)
                if document_digest(document) != exact:
                    raise ValueError("A qualification gate mutated candidate evidence")
                tokens = native.get("generatedTokens")
                if type(tokens) is not int or not 0 < tokens <= 2**53 - 1:
                    raise ValueError("Native admission did not measure a positive safe generated-token count")
                side = document["sidecar"]
                split_identity = side.get("splitIdentity", {})
                measured = {**identity, "status": "admitted", "episodeId": episode.episode_id,
                            "generatedTokens": tokens, "documentDigest": exact,
                            "sourceCluster": split_identity.get("componentId", side["sourceFamily"]),
                            "splitPolicy": split_identity.get("policy"), "registryDigest": split_identity.get("registryDigest")}
                qualified.append(measured)
                sources[exact] = source
                identities.append(identity)
                notice = {"family": side["sourceFamily"], "license": side["license"], "provenance": side["sourceProvenance"]}
                notices.setdefault(digest(canonical(notice)), {**notice, "candidateIds": []})["candidateIds"].append(row["id"])
                evidence.write(json.dumps({**measured, "source": source, "native": native}, sort_keys=True, allow_nan=False) + "\n")
            except Exception as error:
                evidence.write(json.dumps({"id": row["id"], "status": "qualification_rejected", "reason": str(error)}) + "\n")
                evidence.flush()
                os.fsync(evidence.fileno())
                raise ValueError("Fresh release qualification rejected " + row["id"] + "; evidence was retained") from error
            evidence.flush()
            os.fsync(evidence.fileno())
    return qualified, sources, identities, list(notices.values())


def select_training(qualified: list[dict], output: Path, *, max_family_tokens=None, max_family_share=None) -> dict:
    request = output / "training-selection-input.json"
    destination = output / "training-selection.json"
    write_json(request, {"rows": qualified, "maxFamilyTokens": max_family_tokens, "maxFamilyShare": max_family_share})
    selector = Path(__file__).with_name("select-release-training.mjs")
    result = subprocess.run(["node", str(selector), str(request), str(destination)],
                            capture_output=True, text=True, timeout=600, check=False)
    if result.returncode:
        raise ValueError("Training selection failed: " + result.stderr[-4000:])
    selection = read_json(destination)
    if selection.get("status") != "selected":
        raise ValueError("Training token caps excluded every training candidate; selection evidence was retained")
    return selection


def cached_source_verifier(receipts: dict):
    def verify(document):
        receipt = receipts.get(document_digest(document))
        if receipt is None:
            raise ValueError("Prepared candidate changed after fresh source qualification")
        return receipt
    return verify


def check_prepared_selection(prepared: Path, qualified: list[dict], selection: dict) -> dict:
    """Check actual native rows: dedup must not silently invalidate a token cap."""
    selected = set(selection["preparedCandidateIds"])
    by_episode = {}
    for row in qualified:
        if row["id"] in selected:
            by_episode.setdefault(row["episodeId"], []).append(row)
    accepted, dispositions, violations, components, native_families = [], [], [], {}, {}
    connection = sqlite3.connect((prepared / "semantic-dedup.sqlite").as_uri() + "?mode=ro", uri=True)
    connection.row_factory = sqlite3.Row
    try:
        observed = set()
        for native in connection.execute("SELECT episode_id,split,resolved_family,assistant_tokens,duplicate_of,quarantine_reason "
                                         "FROM episodes ORDER BY ordinal"):
            matches = by_episode.get(native["episode_id"])
            if not matches:
                raise ValueError("Native prepared data contains an unselected episode")
            row = matches[0]
            if any((match["sourceCluster"], match["split"], match["generatedTokens"]) !=
                   (row["sourceCluster"], row["split"], row["generatedTokens"]) for match in matches):
                raise ValueError("Repeated native episode ID has conflicting qualification identities")
            observed.update(match["id"] for match in matches)
            excluded = native["duplicate_of"] or native["quarantine_reason"]
            for index, match in enumerate(matches):
                dispositions.append({"id": match["id"], "episodeId": match["episodeId"],
                    "status": "native_excluded" if excluded else "native_same_episode" if index else "native_prepared",
                    "duplicateOf": native["duplicate_of"], "quarantineReason": native["quarantine_reason"]})
            if excluded:
                continue
            if native["split"] != row["split"]:
                raise ValueError("Native preparation moved a frozen split")
            if native["assistant_tokens"] != row["generatedTokens"]:
                raise ValueError("Native prepared token count differs from fresh qualification")
            accepted.append({"id": row["id"], "episodeId": row["episodeId"], "split": row["split"],
                             "sourceCluster": row["sourceCluster"], "generatedTokens": row["generatedTokens"]})
            if row["split"] == "train":
                components[row["sourceCluster"]] = components.get(row["sourceCluster"], 0) + row["generatedTokens"]
                native_families.setdefault(native["resolved_family"], set()).add(row["sourceCluster"])
    finally:
        connection.close()
    if observed != selected:
        raise ValueError("Native preparation omitted selected candidates")
    total = sum(components.values())
    policy = selection["policy"]
    if policy["enabled"]:
        if not total:
            violations.append("Native deduplication left no selected training tokens")
        if any(len(clusters) > 1 for clusters in native_families.values()):
            violations.append("Native deduplication joined distinct frozen components; rebuild the global source registry")
        for cluster, tokens in components.items():
            if policy["maxFamilyTokens"] is not None and tokens > policy["maxFamilyTokens"]:
                violations.append("Prepared component exceeds its token budget: " + cluster)
            if policy["maxFamilyShare"] is not None and tokens / total > policy["maxFamilyShare"] + 2**-52:
                violations.append("Native deduplication invalidated the component token share: " + cluster)
    return {"schema": "semantic-prepared-training-selection/1", "status": "violated" if violations else "verified",
            "policy": policy, "nativeAccepted": len(accepted), "generatedTrainTokens": total,
            "components": [{"sourceCluster": cluster, "generatedTokens": tokens, "tokenShare": tokens / total}
                           for cluster, tokens in sorted(components.items())],
            "accepted": accepted, "nativeDispositions": dispositions, "violations": violations,
            "heldOutInputIds": selection["heldOutIds"], "optimizerSteps": 0, "learnedSuccess": None}


def stage_compact_campaign(corpus: Path, tracer: Path, output: Path, manifest: dict) -> tuple[dict, Path, dict | None]:
    """Rehydrate through the exact producer, including producers predating --out.

    Only immutable CAS files may be hard linked into staging; logs/manifests are
    copied because historical materializers can recover a torn log in place.
    The original complete campaign is always the archived audit authority.
    """
    if all(row.get("path") for row in manifest["cases"] if row["status"] == "admitted"):
        return manifest, corpus, None
    source_manifest = file_receipt(inside(corpus, "manifest.json"))
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
        hydrated = read_json(inside(staging, "manifest.json"))
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
                   "sourceManifestSha256": source_manifest["sha256"], "materializedAdmitted": len(paths),
                   "paths": paths, "producerToolReceipt": json.loads(completed.stdout),
                   "originalCampaignArchived": True, "admissionUnchanged": True}
        (destination / "materialization-receipt.json").write_text(json.dumps(receipt, indent=2, sort_keys=True) + "\n")
        if source_manifest != file_receipt(inside(corpus, "manifest.json")):
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
    original = file_receipt(inside(root, "manifest.json"))
    header = read_json(inside(root, "campaign.json"))
    if not required or original["sha256"] != declaration.get("sourceManifestSha256") or \
            header["identityDigest"] != declaration.get("sourceCampaignDigest"):
        raise ValueError("Audit campaign differs from the immutable selection/materialization source")
    source = read_json(inside(root, "manifest.json"))
    return root, {"sourceCampaignDigest": header["identityDigest"], "manifestSha256": original["sha256"],
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
const store=new CampaignStore(directory,header.identity,{readOnly:true,recoverTornLog:false,
  maxObjectBytes:header.identity.bounds?.maxOutputBytes??268435456});
try{
for(const entry of store.entries){const candidate=store.readObject(entry.candidate);
  for(const input of candidate.inputs??[])for(const key of ['source','input','fixture'])store.readObject(input[key]);}
const manifest=JSON.parse(readFileSync(join(directory,'manifest.json'),'utf8')),seen=new Set();
for(const row of manifest.cases){const entry=store.latest.get(row.id);
  if(!entry||seen.has(row.id)||entry.status!==row.status||entry.candidateDigest!==row.candidateDigest)
    throw new Error('Manifest differs from immutable campaign');seen.add(row.id);}
if(seen.size!==store.latest.size)throw new Error('Manifest omits durable campaign cases');
console.log(JSON.stringify({schema:'semantic-release-campaign-storage-check/1',status:'verified',
  identityDigest:store.identityDigest,attempts:store.entries.length,latestRows:store.latest.size,
  manifestRows:manifest.cases.length}));
}finally{store.close();}
"""
    checked = subprocess.run(["node", "--input-type=module", "-e", script,
                              str(Path(__file__).resolve().parents[1] / "src/corpus/campaign-store.mjs"), str(corpus)],
                             cwd=tracer, check=True, text=True, capture_output=True, timeout=600)
    return json.loads(checked.stdout)


def iter_admitted_documents(manifest: dict, root: Path, identities: list, source_notices: dict):
    """Read one complete row at a time; retain only small release metadata."""
    for row in manifest["cases"]:
        if row["status"] != "admitted":
            continue
        document = read_json(inside(root, row["path"]), 2 * MAX_OBJECT_BYTES)
        side = document["sidecar"]
        if side["producerRevision"] != manifest["producerRevision"] or side.get("identityDigest") != row.get("identityDigest"):
            raise ValueError("Candidate identity differs from the campaign manifest")
        identities.append({"id": row["id"], "family": side["sourceFamily"], "split": side["split"],
                           "identityDigest": side["identityDigest"], "episodeDigest": row["episodeDigest"]})
        source_notices[side["sourceFamily"]] = {"license": side["license"], "provenance": side["sourceProvenance"]}
        yield document


def verify_materialized_documents(corpus: Path, manifest: dict, document_root: Path, source_manifest: dict) -> dict:
    """Bind a materialized selection to complete audited original campaign bytes."""
    original = {row["id"]: row for row in source_manifest["cases"]}
    seen, selected = set(), set()
    if manifest["producerRevision"] != source_manifest["producerRevision"]:
        raise ValueError("Materialized selection changed its producer revision")
    counts = {}
    for row in manifest["cases"]:
        identity = row.get("id")
        if identity in seen or identity not in original:
            raise ValueError("Unknown or repeated materialized candidate ID")
        seen.add(identity)
        if {key: value for key, value in row.items() if key != "path"} != {
                key: value for key, value in original[identity].items() if key != "path"}:
            raise ValueError("Materialized selection changed a candidate disposition or identity")
        counts[row["status"]] = counts.get(row["status"], 0) + 1
        if row["status"] == "admitted":
            inside(document_root, row["path"])
            selected.add(identity)
    declared = manifest["counts"]
    if (declared.get("attempted") != len(seen) or any(declared.get(key) != value for key, value in counts.items())
            or any(type(value) is not int or value < 0 or value != (len(seen) if key == "attempted" else counts.get(key, 0))
                   for key, value in declared.items())):
        raise ValueError("Materialized selection counts do not reconcile")
    held_out = {row["id"] for row in source_manifest["cases"]
                if row["status"] == "admitted" and row["split"] != "train"}
    if not held_out.issubset(selected):
        raise ValueError("Selected release omits original held-out candidates")
    script = """
import {readFileSync,statSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
const [moduleFile,directory,documentRoot]=process.argv.slice(1);
const {CampaignStore,sha256}=await import(pathToFileURL(moduleFile));
const header=JSON.parse(readFileSync(join(directory,'campaign.json'),'utf8'));
const store=new CampaignStore(directory,header.identity,{readOnly:true,maxObjectBytes:268435456});
try{
 const input=JSON.parse(readFileSync(0,'utf8')),files=[],paths=new Set(),physical=new Set();
 for(const row of input.cases){
  if(row.status!=='admitted')continue;
  const metadata=statSync(join(documentRoot,row.path)),key=metadata.dev+':'+metadata.ino;
  if(paths.has(row.path)||physical.has(key)||metadata.size>536870912)throw new Error('Duplicate or oversized materialized candidate');
  paths.add(row.path);physical.add(key);
  const bytes=readFileSync(join(documentRoot,row.path));
  if(!isDeepStrictEqual(JSON.parse(bytes.toString('utf8')),store.exported(store.latest.get(row.id))))
   throw new Error('Materialized candidate differs from audited campaign: '+row.id);
  files.push({path:row.path,bytes:bytes.length,sha256:sha256(bytes)});
 }
 console.log(JSON.stringify({schema:'semantic-release-materialized-check/1',status:'verified',files}));
}finally{store.close();}
"""
    result = subprocess.run(["node", "--input-type=module", "-e", script,
        str(Path(__file__).resolve().parents[1] / "src/corpus/campaign-store.mjs"), str(corpus), str(document_root)],
        input=json.dumps(manifest), capture_output=True, text=True, timeout=600, check=False)
    if result.returncode:
        raise ValueError("Materialized campaign verification failed: " + result.stderr[-4000:])
    return {**json.loads(result.stdout), "selectedIds": sorted(selected)}


def package_release(args) -> dict:
    corpus, tracer, consumer, output = (path.resolve() for path in
                                      (args.corpus, args.tracer_root, args.megatoken, args.out))
    input_corpus = corpus
    input_manifest = read_json(inside(input_corpus, "manifest.json"))
    input_manifest_receipt = file_receipt(inside(input_corpus, "manifest.json"))
    audit, audit_summary = required_audit_campaign(input_manifest, getattr(args, "audit_campaign", None))
    if audit is not None:
        corpus = audit
    manifest = read_json(inside(corpus, "manifest.json"))
    if input_manifest["producerRevision"] != manifest["producerRevision"]:
        raise ValueError("Selected input changed its producing revision")
    policy = read_json(tracer / "contracts/native-admission-policy-v6.json")
    git = lambda path, *argv: subprocess.check_output(["git", "-C", str(path), *argv], text=True).strip()
    if git(tracer, "rev-parse", "HEAD") != manifest["producerRevision"]:
        raise ValueError("Use the exact producing checkout to recheck and release this corpus")
    if git(tracer, "status", "--porcelain", "--untracked-files=no"):
        raise ValueError("Producing checkout has modified tracked files")
    if git(consumer, "rev-parse", "HEAD") != policy["consumerRevision"]:
        raise ValueError("Consumer differs from the producer release policy")
    packager_root = Path(__file__).resolve().parents[1]
    archive_implementation_receipts()
    packaging_tool = {"revision": git(packager_root, "rev-parse", "HEAD"),
        "trackedWorktreeClean": not bool(git(packager_root, "status", "--porcelain", "--untracked-files=no")),
        "files": [{"path": name, **file_receipt(packager_root / name)} for name in
                  ("tools/package-semantic-release.py", "tools/release_archive.py", "tools/verify-release-campaign.mjs",
                   "tools/select-release-training.mjs", "src/corpus/campaign-store.mjs", "src/corpus/source-registry.mjs")]}
    output.mkdir(parents=True)
    campaign_path = output / "campaign-verification.json"
    campaign = verify_campaign(corpus, campaign_path)
    if campaign["manifestSha256"] != file_receipt(corpus / "manifest.json")["sha256"]:
        raise ValueError("Campaign manifest changed during verification")
    input_check = None
    if audit is not None:
        input_check = verify_materialized_documents(corpus, input_manifest, input_corpus, manifest)
        input_check["manifestSha256"] = input_manifest_receipt["sha256"]
        write_json(output / "input-verification.json", input_check)
    document_manifest, document_root, materialization = stage_compact_campaign(corpus, tracer, output, manifest)
    materialized_check = None
    if materialization:
        materialized_check = verify_materialized_documents(corpus, document_manifest, document_root, manifest)
        write_json(output / "materialization-verification.json", materialized_check)
    actual_environment = output / "native-environment.json"
    recheck_environment(tracer, consumer, args.tokenizer.resolve(), args.environment_receipt.resolve(),
                        actual_environment, policy)
    from megatoken.data.semantic_admission import native_admission
    from megatoken.data.semantic_corpus import (
        prepare_semantic_corpus,
        public_digest,
        source_verifier_for_checkout,
        verify_admission,
    )
    from megatoken.data.semantic_harness_v6 import adapt_selected_harness_v6
    from megatoken.generation.codec import ByteCodec
    codec = ByteCodec.from_tokenizer_json(args.tokenizer, expected_sha256=policy["tokenizerSha256"])
    if codec.fingerprint != policy["tokenizerIdentity"]:
        raise ValueError("Actual native tokenizer identity changed")
    admitted = [row for row in document_manifest["cases"] if row["status"] == "admitted"]
    if not admitted:
        raise ValueError("A release needs actual admitted examples")
    qualification_path = output / "native-qualification.jsonl"
    qualified, source_receipts, identities, source_notices = qualify_candidates(document_root, admitted, qualification_path,
        codec=codec, producer_revision=manifest["producerRevision"], consumer_revision=policy["consumerRevision"],
        source_verifier=source_verifier_for_checkout(tracer, manifest["producerRevision"]),
        native_admission=native_admission, verify_admission=verify_admission,
        adapt_selected=adapt_selected_harness_v6, public_digest=public_digest)
    qualification_summary = output / "native-qualification-summary.json"
    write_json(qualification_summary, {"schema": "semantic-release-native-qualification/1", "status": "verified",
        "producerRevision": manifest["producerRevision"], "consumerRevision": policy["consumerRevision"],
        "tokenizerIdentity": codec.fingerprint, "admitted": len(qualified),
        "generatedTokens": sum(row["generatedTokens"] for row in qualified),
        "evidenceSha256": file_receipt(qualification_path)["sha256"], "optimizerSteps": 0, "learnedSuccess": None})
    eligible = qualified if input_check is None else [row for row in qualified if row["id"] in input_check["selectedIds"]]
    selection = select_training(eligible, output, max_family_tokens=args.max_family_tokens,
                                max_family_share=args.max_family_share)
    selected = set(selection["preparedCandidateIds"])

    def documents():
        for row in admitted:
            if row["id"] in selected:
                yield load_document(document_root, row)

    prepared, report = prepare_semantic_corpus(documents(), output / "prepared", codec=codec,
        producer_revision=manifest["producerRevision"], consumer_revision=policy["consumerRevision"],
        source_verifier=cached_source_verifier(source_receipts))
    if report["counts"].get("admitted") != len(selected) or report["refusals"]:
        raise ValueError("Production rechecking rejected release rows; refusal evidence was retained")
    if (git(consumer, "rev-parse", "HEAD") != policy["consumerRevision"]
            or git(consumer, "status", "--porcelain", "--untracked-files=no")):
        raise ValueError("Native consumer changed during preparation")
    prepared_selection = check_prepared_selection(output / "prepared", qualified, selection)
    write_json(output / "prepared-training-selection.json", prepared_selection)
    if prepared_selection["status"] != "verified":
        raise ValueError("Final native preparation violated training token caps; selection evidence was retained")
    notices = output / "source-notices.json"
    write_json(notices, {"schema": "semantic-source-notices/1", "notices": source_notices})
    roots = {"corpus": corpus, "prepared": output / "prepared", "source-notices.json": notices,
             "campaign-verification.json": campaign_path, "native-environment.json": actual_environment,
             "native-qualification.jsonl": qualification_path, "native-qualification-summary.json": qualification_summary,
             "training-selection-input.json": output / "training-selection-input.json",
             "training-selection.json": output / "training-selection.json",
             "prepared-training-selection.json": output / "prepared-training-selection.json",
             "supplied-native-environment.json": args.environment_receipt.resolve(),
             "locks/environment.json": tracer / "profiles/release-environment.lock.json",
             "locks/native-policy.json": tracer / "contracts/native-admission-policy-v6.json",
             "locks/requirements.lock": tracer / "tools/native-consumer/requirements.lock",
             "locks/producer-package-lock.json": tracer / "package-lock.json",
             "locks/oracle-package-lock.json": tracer / "tools/spec-oracle/package-lock.json"}
    if materialization:
        roots["materialized"] = document_root
        roots["materialization-verification.json"] = output / "materialization-verification.json"
    if input_check:
        roots["selection-input"] = input_corpus
        roots["input-verification.json"] = output / "input-verification.json"
    files, sources = inventory(roots)
    # The shared lock excludes generator resumes. Match the archived metadata
    # again so changes made outside that lock cannot silently rebind the release.
    by_path = {row["path"]: row for row in files}
    for name, key in (("manifest.json", "manifestSha256"), ("campaign.json", "headerSha256"), ("campaign.jsonl", "logSha256")):
        if by_path["corpus/" + name]["sha256"] != campaign[key]:
            raise ValueError("Campaign metadata changed after qualification")
    for reference in [*campaign["objects"], *campaign["compatibilityExports"]]:
        archived = by_path.get("corpus/" + reference["path"], {})
        if any(archived.get(key) != reference[key] for key in ("bytes", "sha256")):
            raise ValueError("Qualified campaign bytes changed before archiving: " + reference["path"])
    for prefix, verification in (("materialized", materialized_check), ("selection-input", input_check)):
        if verification:
            for expected in verification["files"]:
                actual = by_path.get(prefix + "/" + expected["path"], {})
                if any(actual.get(key) != expected[key] for key in ("bytes", "sha256")):
                    raise ValueError("Verified materialized candidate changed before archiving")
    if input_check and by_path["selection-input/manifest.json"]["sha256"] != input_check["manifestSha256"]:
        raise ValueError("Selection manifest changed after qualification")
    payload = {"schema": "semantic-private-release/1", "distribution": "private-audit-only",
        "packagingTool": packaging_tool, "materialization": materialization,
        "auditCampaign": audit_summary, "inputProjection": input_check,
        "qualificationScope": "all original audited admissions before training-only selection",
        "producerRevision": manifest["producerRevision"], "consumerRevision": policy["consumerRevision"],
        "tokenizer": policy, "campaignManifestSha256": campaign["manifestSha256"],
        "campaignVerificationSha256": by_path["campaign-verification.json"]["sha256"],
        "nativeEnvironmentSha256": by_path["native-environment.json"]["sha256"],
        "trainingSelectionSha256": by_path["training-selection.json"]["sha256"],
        "preparedTrainingSelectionSha256": by_path["prepared-training-selection.json"]["sha256"],
        "nativeQualified": len(qualified), "trainingSelected": len(selection["selectedTrainIds"]),
        "trainingExcluded": len(selection["excludedTrain"]), "heldOutSupplied": len(selection["heldOutIds"]),
        "counts": campaign["counts"], "attempted": campaign["attempted"], "nativePrepared": report["accepted"],
        "preparedFingerprint": prepared["fingerprint"], "identities": identities,
        "publicRedistributionApproved": False,
        "licensePolicy": "Retain exact upstream notices; repository-fixture is provenance, not an SPDX license. Owner approval is needed for public corpus distribution.",
        "optimizerSteps": 0, "learnedSuccess": None, "files": files}
    archive = output / "semantic-v6-release.tar.gz"
    write_archive(archive, payload, sources)
    verified = verify_archive(archive)
    write_json(output / "archive-receipt.json", verified)
    return {**verified, "archive": str(archive), "counts": campaign["counts"], "nativePrepared": report["accepted"],
            "nativeQualified": len(qualified), "trainingSelected": len(selection["selectedTrainIds"]),
            "trainingExcluded": len(selection["excludedTrain"]), "heldOutSupplied": len(selection["heldOutIds"])}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--verify", type=Path)
    parser.add_argument("--corpus", type=Path)
    parser.add_argument("--audit-campaign", type=Path)
    parser.add_argument("--tracer-root", type=Path)
    parser.add_argument("--megatoken", type=Path)
    parser.add_argument("--tokenizer", type=Path)
    parser.add_argument("--environment-receipt", type=Path)
    parser.add_argument("--max-family-tokens", type=int,
                        help="Maximum fresh native generated tokens per frozen source component in training")
    parser.add_argument("--max-family-share", type=float,
                        help="Maximum source-component share of selected training generated tokens, in (0, 1]")
    parser.add_argument("--out", type=Path)
    args = parser.parse_args()
    if args.max_family_tokens is not None and not 0 < args.max_family_tokens <= 2**53 - 1:
        parser.error("--max-family-tokens must be a positive safe integer")
    if args.max_family_share is not None and not 0 < args.max_family_share <= 1:
        parser.error("--max-family-share must be in (0, 1]")
    if args.verify:
        print(json.dumps(verify_archive(args.verify), sort_keys=True))
        return 0
    if any(getattr(args, field) is None for field in
           ("corpus", "tracer_root", "megatoken", "tokenizer", "environment_receipt", "out")):
        parser.error("Packaging requires --corpus --tracer-root --megatoken --tokenizer --environment-receipt --out")
    corpus, output = args.corpus.resolve(), args.out.resolve()
    if output.exists():
        raise ValueError("Release directories are immutable; choose a new destination")
    if output.is_relative_to(corpus):
        raise ValueError("Release destination must be outside its input corpus")
    manifest = read_json(inside(corpus, "manifest.json"))
    audit, _ = required_audit_campaign(manifest, args.audit_campaign)
    if audit is not None and output.is_relative_to(audit):
        raise ValueError("Release destination must be outside its audit campaign")
    with locked_campaign(audit or corpus):
        print(json.dumps(package_release(args)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
