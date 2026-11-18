#!/usr/bin/env python3
"""Derive a full authenticated sampler from a new native preparation and campaign.

This reads all accepted native rows and retains original exclusions separately.
It neither rewrites preparation/campaign inputs nor executes a neural model.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib
import json
from pathlib import Path
import subprocess
import sys
import traceback

import native_prepared_sampler as S


NATIVE_MODULES = ("megatoken.data.storage", "megatoken.data.schema", "megatoken.data.semantic_corpus",
    "megatoken.data.semantic_admission", "megatoken.data.semantic_harness_v5", "megatoken.generation.codec")
NATIVE_FILES = ("src/megatoken/controls.py", "src/megatoken/data/semantic_physical.py",
    "src/megatoken/data/semantic_context.py", "src/megatoken/data/semantic_contract.py",
    "src/megatoken/data/host_operations.py", "src/megatoken/data/dedup.py",
    "src/megatoken/data/chunking.py", "src/megatoken/data/token_offsets.py")
TOOL_FILES = ("tools/derive-native-prepared-sampler.py", "tools/native_prepared_sampler.py",
    "tools/verify-release-campaign.mjs", "src/corpus/campaign-store.mjs",
    "src/corpus/source-registry.mjs", "src/corpus/native-prepared-coverage.mjs")


def campaign_documents(campaign, identities, output):
    """Rehydrate the exact selected documents through the maintained CAS reader."""
    script = """
import {readFileSync,openSync,writeSync,closeSync} from 'node:fs';
import {join} from 'node:path'; import {pathToFileURL} from 'node:url';
const {CampaignStore}=await import(pathToFileURL(process.argv[1]));
const {verifyFrozenSplitIdentity}=await import(pathToFileURL(process.argv[4]));
const directory=process.argv[2],header=JSON.parse(readFileSync(join(directory,'campaign.json'),'utf8'));
const manifest=JSON.parse(readFileSync(join(directory,'manifest.json'),'utf8'));
const originals=new Map(manifest.cases.map(row=>[row.id,row]));
const store=new CampaignStore(directory,header.identity,{readOnly:true,maxObjectBytes:268435456});
const descriptor=openSync(process.argv[3],'wx',0o600);
try{for(const id of JSON.parse(readFileSync(0,'utf8'))){
 const entry=store.latest.get(id);
 if(!entry||entry.status!=='admitted')throw new Error('Missing committed admitted document: '+id);
 const document=store.exported(entry),original=originals.get(id);
 const frozen=verifyFrozenSplitIdentity(document.sidecar.splitIdentity,{family:document.sidecar.sourceFamily});
 if(frozen.registryDigest!==manifest.sourceRegistry.digest||frozen.sourceCluster!==original?.sourceCluster||
    frozen.split!==original?.split)throw new Error('Frozen registry/component identity differs from original manifest: '+id);
 writeSync(descriptor,JSON.stringify({id,document})+'\\n');
}}finally{closeSync(descriptor);store.close();}
"""
    process = subprocess.run(["node", "--input-type=module", "-e", script,
        str(S.ROOT / "src/corpus/campaign-store.mjs"), str(campaign), str(output),
        str(S.ROOT / "src/corpus/source-registry.mjs")],
        input=S.canonical(sorted(identities)), text=True, capture_output=True, timeout=600)
    S.require(process.returncode == 0, "Original campaign document export failed: " + process.stderr[-4000:])


def reconstruct_rows(prepared_root, database_rows, index_rows, source, native, audit, documents_path,
                     policy, codec, modules, destination):
    storage, schema, corpus_module, admission, adapter, _ = modules
    audit_by_id = S.unique(audit, "episodeId", "native audit")
    database = S.unique(database_rows, "episode_id", "native database")
    S.require(set(audit_by_id) == set(database), "Native audit omits or adds a prepared input episode")
    originals = S.unique(source["cases"], "id", "source")
    by_candidate = {json.loads(row["episode_json"])["lineage"]["task_id"]: row for row in database_rows}
    indexed = S.unique(index_rows, "episode_id", "index")
    proofs, seen = [], set()
    with storage.PreparedDataset(prepared_root, split=None, verify_checksums=True) as prepared:
        positions = {}
        for position in range(len(prepared)):
            entry = prepared.index_entry(position)
            S.require(entry == indexed.get(entry["episode_id"]), "Prepared scope positions differ from the full index")
            S.require(entry["episode_id"] not in positions, "Prepared scope repeats an episode")
            positions[entry["episode_id"]] = position
        S.require(set(positions) == set(indexed), "Prepared scope omits indexed episodes")
        with documents_path.open("r", encoding="utf-8") as documents, destination.open("x", encoding="utf-8") as receipt:
            for line in documents:
                item = json.loads(line)
                case_id, document = item["id"], item["document"]
                S.require(case_id in by_candidate and case_id not in seen, "Missing or repeated source document join")
                seen.add(case_id)
                row, original = by_candidate[case_id], originals[case_id]
                audit_row = audit_by_id[row["episode_id"]]
                side = document["sidecar"]
                S.require(side["taskId"] == case_id and side["identityDigest"] == original["identityDigest"] and
                    side["producerRevision"] == source["producerRevision"] and
                    side["sourceFamily"] == original["family"] and side["split"] == original["split"] and
                    corpus_module.public_digest(document) == original["episodeDigest"],
                    "Archived source document differs from its original campaign identity")
                S.require(S.canonical(audit_row["supervision"]) == S.canonical(side) and
                    audit_row["source"].get("identityDigest") == original["identityDigest"],
                    "Native audit source/sidecar differs from the complete archived campaign")
                fresh = admission.native_admission(document, codec=codec,
                    consumer_revision=policy["consumerRevision"], max_positions=native["maxPositions"],
                    max_history=native["maxHistory"])
                corpus_module.verify_admission(document, audit_row["source"], fresh,
                    producer_revision=source["producerRevision"], consumer_revision=policy["consumerRevision"], codec=codec)
                S.require(S.canonical(fresh) == S.canonical(audit_row["native"]),
                    "Recomputed native admission differs from the sealed preparation audit")
                regenerated, _ = adapter.adapt_selected_harness_v5(document, codec=codec,
                    max_positions=native["maxPositions"], max_history=native["maxHistory"],
                    admission_verifier=lambda _: True)  # The exact document was verified immediately above.
                stored_value = json.loads(row["episode_json"])
                episode = prepared[positions[row["episode_id"]]] if row["episode_id"] in positions else schema.Episode.from_dict(stored_value)
                exact = schema.canonical_json(episode.to_dict())
                S.require(exact == schema.canonical_json(stored_value) == schema.canonical_json(regenerated.to_dict()),
                    "Native prepared Episode differs from pinned reconstruction of the original source document")
                S.require(episode.content_sha256 == row["content_sha256"], "Native dedup content identity changed")
                encoded = schema.encode_episode(episode, codec)
                total = sum(record.tokens for record in encoded)
                generated = sum(record.tokens for record in encoded if record.record.role == "assistant" and record.record.policy_mask)
                scored = sum(record.P for record in encoded)
                S.require(total == row["token_count"] and generated == scored == row["assistant_tokens"] == row["scored_positions"],
                    "Actual native encoded tokens or generated-only masks differ from prepared counts")
                S.require(all(record.P == 0 for record in encoded if not record.record.policy_mask),
                    "Observed native records acquired generation loss")
                S.require(fresh["generatedTokens"] == generated and fresh["observedTokens"] == total - generated,
                    "Fresh native admission token inventory differs from actual prepared encoding")
                line_sha = hashlib.sha256((exact + "\n").encode()).hexdigest()
                if row["episode_id"] in indexed:
                    S.require(line_sha == indexed[row["episode_id"]]["sha256"], "Prepared canonical Episode bytes changed")
                proof = {"id": case_id, "episodeId": episode.episode_id, "episodeJsonLineSha256": line_sha,
                    "sourceDocumentSha256": S.digest(document), "sourceAdmissionSha256": S.digest(audit_row["source"]),
                    "nativeAdmissionSha256": S.digest(fresh), "pinnedNativeReconstructionIdentical": True,
                    "generatedTokens": generated, "scoredPositions": scored, "wholeTranscriptTokens": total,
                    "encodedTokensAndMasksSha256": S.digest([[record.record.record_id, record.token_ids,
                        record.free_mask, record.codec_fingerprint, record.transcript_tokens] for record in encoded])}
                receipt.write(S.canonical(proof) + "\n")
                receipt.flush()
                proofs.append(proof)
    S.require(seen == set(by_candidate), "Original source document stream is incomplete")
    return proofs


def derive(args, staging):
    prepared_root, campaign, consumer, producer = (path.resolve() for path in
        (args.prepared, args.audit_campaign, args.megatoken, args.producer_root))
    bound = {}
    bind = lambda path: S.bind_file(bound, path)
    # Bind metadata before parsing or invoking a reader. Rebinding checks the
    # first snapshot; it can never replace it with a later writer's bytes.
    source = S.read(bind(S.inside(campaign, "manifest.json")))
    for name in ("campaign.json", "campaign.jsonl"):
        bind(S.inside(campaign, name))
    producer_revision = S.checkout(producer, source["producerRevision"])
    tool_revision = S.checkout(S.ROOT)
    policy_path = bind(S.inside(producer, "contracts/native-admission-policy-v5.json"))
    policy = S.read(policy_path)
    S.checkout(consumer, policy["consumerRevision"])
    tokenizer_path = bind(args.tokenizer.resolve())
    S.require(S.sha(tokenizer_path) == policy["tokenizerSha256"], "Tokenizer bytes differ from the exact native policy")
    prepared = S.read(bind(S.inside(prepared_root, "manifest.json")))
    native = S.read(bind(S.inside(prepared_root, "semantic-report.json")))
    index_path = bind(S.inside(prepared_root, prepared["index"]["path"]))
    S.require(S.sha(index_path) == prepared["index"]["sha256"], "Prepared index checksum changed")
    for name in ("semantic-audit.json", "semantic-dedup.sqlite"):
        bind(S.inside(prepared_root, name))
    for shard in prepared["shards"]:
        path = bind(S.inside(prepared_root, shard["path"]))
        S.require(S.sha(path) == shard["sha256"] and path.stat().st_size == shard["bytes"], "Prepared shard checksum changed")
    for name in TOOL_FILES:
        bind(S.inside(S.ROOT, name))
    for name in (*NATIVE_FILES, *("src/" + name.replace(".", "/") + ".py" for name in NATIVE_MODULES)):
        bind(S.inside(consumer, name))
    campaign_process = subprocess.run(["node", str(S.ROOT / "tools/verify-release-campaign.mjs"), str(campaign)],
        capture_output=True, text=True, timeout=600)
    S.require(campaign_process.returncode == 0, "Complete campaign verification failed: " + campaign_process.stderr[-4000:])
    campaign_receipt = json.loads(campaign_process.stdout)
    S.require(campaign_receipt["manifestSha256"] == S.sha(campaign / "manifest.json"), "Campaign changed during verification")
    S.check_bindings(bound.values())
    S.write(staging / "campaign-verification.json", campaign_receipt)
    for row in [*campaign_receipt["objects"], *campaign_receipt["compatibilityExports"]]:
        path = bind(S.inside(campaign, row["path"]))
        S.require(S.sha(path) == row["sha256"] and path.stat().st_size == row["bytes"], "Campaign object changed after verification")
    sys.path.insert(0, str(consumer / "src"))
    modules = [importlib.import_module(name) for name in NATIVE_MODULES]
    for module in modules:
        path = Path(module.__file__).resolve()
        S.require(path.is_relative_to(consumer), "Imported a different native consumer checkout")
        bind(path)
    bindings = [bound[path] for path in sorted(bound)]
    codec = modules[-1].ByteCodec.from_tokenizer_json(args.tokenizer, expected_sha256=policy["tokenizerSha256"])
    S.require(codec.fingerprint == policy["tokenizerIdentity"], "Actual native tokenizer identity differs")
    database_rows = S.read_database(prepared_root / "semantic-dedup.sqlite", "SELECT * FROM episodes ORDER BY ordinal")
    index_rows = S.read_database(index_path, "SELECT * FROM episodes ORDER BY entry_id")
    accepted, excluded, omissions = S.joined_inventory(source, prepared, native, policy, database_rows, index_rows)
    audit = S.read(prepared_root / "semantic-audit.json", maximum=256 << 20)
    S.require(isinstance(audit, list) and len(audit) == len(database_rows), "Native audit population differs from preparation")
    S.check_bindings(bindings)
    documents = staging / "source-documents.jsonl"
    campaign_documents(campaign, [row["id"] for row in accepted + excluded], documents)
    proofs = reconstruct_rows(prepared_root, database_rows, index_rows, source, native, audit, documents,
        policy, codec, modules, staging / "native-row-verification.jsonl")
    proof_index = {row["id"]: row for row in proofs}
    for row in accepted + excluded:
        row["encodedTokensAndMasksSha256"] = proof_index[row["id"]]["encodedTokensAndMasksSha256"]
    sampler = S.make_sampler(source, prepared, policy,
        {"maxFamilyTokens": args.max_family_tokens, "maxFamilyShare": args.max_family_share},
        accepted, excluded, omissions, {
            "sourceManifestSha256": S.sha(campaign / "manifest.json"),
            "nativePreparedManifestSha256": S.sha(prepared_root / "manifest.json"),
            "nativePreparedIndexSha256": S.sha(index_path),
            "nativeDedupDatabaseSha256": S.sha(prepared_root / "semantic-dedup.sqlite"),
            "nativeReportSha256": S.sha(prepared_root / "semantic-report.json"),
            "nativeAuditSha256": S.sha(prepared_root / "semantic-audit.json"),
            "campaignVerificationSha256": S.sha(staging / "campaign-verification.json"),
            "nativeRowVerificationSha256": S.sha(staging / "native-row-verification.jsonl")})
    S.check_bindings(bindings)
    S.checkout(producer, producer_revision)
    S.checkout(consumer, policy["consumerRevision"])
    S.checkout(S.ROOT, tool_revision)
    S.write(staging / "sampler.json", sampler)
    result = {"schema": "semantic-native-prepared-sampler-verification/1", "status": "verified",
        "toolRevision": tool_revision, "producerRevision": producer_revision, "nativePolicy": policy,
        "nativePreparedFingerprint": prepared["fingerprint"], "fileBindings": bindings,
        "campaignVerificationSha256": S.sha(staging / "campaign-verification.json"),
        "sourceDocumentsSha256": S.sha(documents), "nativeRowVerificationSha256": sampler["nativeRowVerificationSha256"],
        "samplerSha256": S.sha(staging / "sampler.json"), "nativeRowsReconstructed": len(proofs),
        "acceptedRows": len(accepted), "nativeExclusions": len(excluded), "upstreamOmissions": len(omissions),
        "sourceAdmission": "archived-source-receipts-reconciled-to-complete-campaign",
        "nativeAdmission": "recomputed-under-exact-pinned-consumer-and-tokenizer",
        "evaluationMembershipUnchanged": True, "optimizerSteps": 0, "learnedSuccess": None}
    S.write(staging / "inventory-verification.json", result)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("prepared", "audit-campaign", "megatoken", "tokenizer", "out"):
        parser.add_argument("--" + name, type=Path, required=True)
    parser.add_argument("--producer-root", type=Path, default=S.ROOT)
    parser.add_argument("--max-family-tokens", type=int, default=10000)
    parser.add_argument("--max-family-share", type=float, default=0.20)
    args = parser.parse_args()
    output = args.out.resolve()
    staging = output.with_name(output.name + ".building")
    S.require(not output.exists() and not staging.exists(), "Use a new output directory; preserve earlier evidence")
    S.require(not any(output.is_relative_to(path.resolve()) for path in (args.prepared, args.audit_campaign)),
              "Sampler output must be outside the immutable preparation and campaign inputs")
    staging.mkdir(parents=True)
    try:
        result = derive(args, staging)
    except BaseException as error:
        S.write(staging / "failure.json", {"schema": "semantic-native-prepared-sampler-verification/1",
            "status": "failed", "completeSampler": False, "error": str(error), "traceback": traceback.format_exc(),
            "optimizerSteps": 0, "learnedSuccess": None})
        raise
    staging.rename(output)
    print(json.dumps({"status": result["status"], "sampler": str(output / "sampler.json"),
        "acceptedRows": result["acceptedRows"], "nativeExclusions": result["nativeExclusions"],
        "upstreamOmissions": result["upstreamOmissions"], "samplerSha256": result["samplerSha256"]}, sort_keys=True))


if __name__ == "__main__":
    main()
