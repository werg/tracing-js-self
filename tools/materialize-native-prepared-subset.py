#!/usr/bin/env python3
"""Export an authenticated capped subset through the pinned native storage APIs.

This derives a native dataset from already admitted native Episodes. It does
not regenerate source witnesses, grant new admissions, or edit a SQLite index.
Every output Episode and encoded target mask must match its checked parent.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import resource
import subprocess
import time
from collections import Counter, defaultdict
from pathlib import Path

import native_prepared_sampler as S


def require(condition, message):
    if not condition:
        raise ValueError(message)


def read(path):
    return json.loads(Path(path).read_text())


def sha(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def write(path, value):
    path = Path(path)
    temporary = path.with_suffix(path.suffix + ".partial")
    temporary.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n")
    temporary.replace(path)


def pinned_checkout(path, revision):
    actual = subprocess.check_output(["git", "-C", str(path), "rev-parse", "HEAD"], text=True).strip()
    dirty = subprocess.check_output(
        ["git", "-C", str(path), "status", "--porcelain", "--untracked-files=no"], text=True)
    require(actual == revision and not dirty, "Native checkout differs from its immutable policy")


def verify_native_lineage(episode, expected, joins):
    if joins is not None:
        authenticated = joins[episode.episode_id]
        require(all(expected.get(key) == value for key, value in authenticated.items()),
                "Sampler candidate/native task identities differ from the authenticated audit join")
        task_id = authenticated["nativeTaskId"]
    else:
        # Frozen historical samplers predate separate task identities. Preserve
        # their stricter task==candidate check; they cannot authorize aliases.
        require("nativeTaskId" not in expected and "nativeAuditSupervisionSha256" not in expected,
                "Separate native task identity lacks its authenticated source join")
        task_id = expected["id"]
    require(episode.lineage.task_id == task_id and episode.lineage.family_id == expected["family"],
            "Native lineage differs from authenticated original source")
    return task_id


def materialize(args):
    started = time.monotonic()
    parent = args.parent.resolve()
    output = args.out.resolve()
    staging = output.with_name(output.name + ".building")
    require(not output.exists() and not staging.exists(), "Use a new native subset output directory")
    bound = {}
    bind = lambda path: S.bind_file(bound, path)
    sampler = read(bind(args.sampler))
    require(sampler.get("schema") == "semantic-native-prepared-training-sampler/1", "Unsupported sampler")
    policy = sampler["nativePolicy"]
    pinned_checkout(args.megatoken.resolve(), policy["consumerRevision"])
    require(sha(bind(args.tokenizer)) == policy["tokenizerSha256"], "Tokenizer bytes changed")
    require(sha(bind(parent / "manifest.json")) == sampler["nativePreparedManifestSha256"], "Parent manifest changed")
    require(sha(bind(parent / "semantic-dedup.sqlite")) == sampler["nativeDedupDatabaseSha256"], "Parent dedup database changed")
    require(sha(bind(parent / "semantic-report.json")) == sampler["nativeReportSha256"], "Parent native report changed")
    require(sha(bind(args.audit_campaign / "manifest.json")) == sampler["sourceManifestSha256"], "Original campaign changed")
    original = read(args.audit_campaign / "manifest.json")
    require(original["campaign"]["identityDigest"] == sampler["sourceCampaignDigest"], "Campaign identity changed")
    require(original["sourceRegistry"]["digest"] == sampler["sourceRegistryDigest"], "Registry identity changed")
    require(original["producerRevision"] == sampler["producerRevision"], "Producer identity changed")
    originals = S.unique(original["cases"], "id", "original candidate")
    joins = None
    if sampler.get("sourceJoinSchema") is not None or any("nativeTaskId" in row or
            "nativeAuditSupervisionSha256" in row for row in sampler["acceptedDecisions"]):
        audit_path = bind(parent / "semantic-audit.json")
        require(sha(audit_path) == sampler.get("nativeAuditSha256"), "Parent native audit changed or is unbound")
        database_rows = S.read_database(parent / "semantic-dedup.sqlite", "SELECT * FROM episodes ORDER BY ordinal")
        audit = S.read_audit_proofs(audit_path, len(database_rows))
        joins = S.sampler_source_joins(sampler, original, database_rows, audit)
        S.check_bindings(bound.values())

    from megatoken.data import storage
    from megatoken.data.dedup import DedupConfig, DedupStore
    from megatoken.data.schema import canonical_json, encode_episode
    from megatoken.data.storage import PreparedDataset, export_prepared
    from megatoken.generation.codec import ByteCodec
    from megatoken.io import content_hash

    require(Path(storage.__file__).resolve().is_relative_to(args.megatoken.resolve()),
            "Python imported a different native checkout")
    codec = ByteCodec.from_tokenizer_json(args.tokenizer, expected_sha256=policy["tokenizerSha256"])
    require(codec.fingerprint == policy["tokenizerIdentity"], "Native codec identity changed")
    metadata = {row["episodeId"]: row for row in sampler["acceptedDecisions"]}
    require(len(metadata) == len(sampler["acceptedDecisions"]), "Repeated parent episode identity")
    wanted = set(sampler["includedEpisodeIds"])
    require(len(wanted) == len(sampler["includedEpisodeIds"]) and wanted, "Empty or repeated subset identity")
    require(wanted == {key for key, row in metadata.items() if row["decision"] == "included"},
            "Subset IDs disagree with authenticated decisions")
    require({metadata[key]["id"] for key in wanted} == set(sampler["includedCandidateIds"]),
            "Subset candidate membership changed")

    def encoded_identity(encoded):
        values = [[row.record.record_id, row.token_ids, row.free_mask, row.codec_fingerprint,
                   row.transcript_tokens] for row in encoded]
        return hashlib.sha256(canonical_json(values).encode()).hexdigest()

    source = {
        "schema": "semantic-native-prepared-subset-source/1",
        "scope": "Unchanged native Episodes selected from an authenticated admitted parent; no new source admission or optimizer run.",
        "samplerSha256": sha(args.sampler), "parentManifestSha256": sha(parent / "manifest.json"),
        "parentPreparedFingerprint": sampler["nativePreparedFingerprint"],
        "parentIndexSha256": sampler["nativePreparedIndexSha256"],
        "parentDedupDatabaseSha256": sampler["nativeDedupDatabaseSha256"],
        "parentNativeReportSha256": sampler["nativeReportSha256"],
        "sourceCampaignDigest": sampler["sourceCampaignDigest"],
        "sourceManifestSha256": sampler["sourceManifestSha256"],
        "sourceRegistryDigest": sampler["sourceRegistryDigest"],
        "sourceJoinSchema": sampler.get("sourceJoinSchema"),
        "parentNativeAuditSha256": sampler.get("nativeAuditSha256"),
        "sourceAttemptedCandidates": len(original["cases"]),
        "producerRevision": sampler["producerRevision"], "nativePolicy": policy,
        "policy": sampler["policy"], "includedEpisodeIds": sorted(wanted),
        "optimizerSteps": 0, "learnedSuccess": None,
    }
    provenance, native_family_changes, splits = {}, [], Counter()
    with PreparedDataset(parent, split=None, verify_checksums=True) as corpus:
        require(corpus.manifest["fingerprint"] == sampler["nativePreparedFingerprint"], "Parent fingerprint changed")
        require(corpus.manifest["index"]["sha256"] == sampler["nativePreparedIndexSha256"], "Parent index changed")
        require(corpus.manifest["codec_fingerprint"] == codec.fingerprint, "Parent codec changed")
        require(len(corpus) == len(metadata) == sampler["before"]["episodes"], "Parent inventory differs from sampler")
        all_rows = [corpus.index_entry(index) for index in range(len(corpus))]
        require({row["episode_id"] for row in all_rows} == set(metadata), "Parent membership changed")
        require({row["episode_id"] for row in all_rows if row["split"] != "train"} <= wanted,
                "Subset removed native-accepted evaluation data")
        chosen = [row for row in all_rows if row["episode_id"] in wanted]
        require({row["entry_id"] for row in chosen} == set(sampler["includedPreparedEntryIds"]),
                "Subset parent entry IDs changed")
        staging.mkdir(parents=True)
        with DedupStore(staging / "semantic-dedup.sqlite", DedupConfig(**corpus.manifest["dedup"])) as store:
            for row in chosen:
                expected = metadata[row["episode_id"]]
                original_row = originals[expected["id"]]
                require(original_row["status"] == "admitted", "Subset refers to an original non-admission")
                for key, original_key in (("family", "family"), ("split", "split"),
                                          ("frozenSourceComponent", "sourceCluster"),
                                          ("identityDigest", "identityDigest"), ("episodeDigest", "episodeDigest")):
                    require(expected[key] == original_row[original_key], "Sampler differs from original identity: " + key)
                episode = corpus[row["entry_id"]]
                require(episode.episode_id == row["episode_id"], "Parent position differs from entry identity")
                native_task_id = verify_native_lineage(episode, expected, joins)
                require(episode.lineage.frozen_split == row["split"] == expected["split"], "Frozen split changed")
                require(row["family_id"] == expected["nativeResolvedFamily"], "Parent resolved family changed")
                exact = canonical_json(episode.to_dict()).encode() + b"\n"
                require(hashlib.sha256(exact).hexdigest() == row["sha256"], "Parent Episode canonical bytes changed")
                encoded = encode_episode(episode, codec)
                tokens = sum(record.tokens for record in encoded)
                targets = sum(record.P for record in encoded)
                generated = sum(record.tokens for record in encoded
                                if record.record.role == "assistant" and record.record.policy_mask)
                require(tokens == row["tokens"] == expected["wholeTranscriptTokens"], "Parent token accounting changed")
                require(targets == generated == row["scored_positions"] == expected["generatedTokens"],
                        "Parent target mask or native generated tokens changed")
                require(store.add(episode, codec, encoded=encoded) == "accepted_candidate",
                        "Normal native ingestion did not preserve subset membership")
                provenance[episode.episode_id] = {
                    "candidateId": expected["id"], "nativeTaskId": native_task_id,
                    "parentEntryId": row["entry_id"], "episodeId": episode.episode_id,
                    "episodeJsonLineSha256": row["sha256"], "encodedTokensAndMasksSha256": encoded_identity(encoded),
                    "split": row["split"], "parentResolvedFamily": row["family_id"],
                    "budgetComponent": expected["budgetComponent"], "wholeTranscriptTokens": tokens,
                    "generatedTokens": generated, "scoredPositions": targets,
                }
                splits[row["split"]] += 1
            store.freeze()
            native_groups = defaultdict(set)
            budgets = Counter()
            retained = set()
            for row in store.accepted_rows():
                expected = provenance[row["episode_id"]]
                require(row["split"] == expected["split"], "Native subset freeze changed an inherited split")
                native_groups[row["resolved_family"]].add(expected["budgetComponent"])
                if row["split"] == "train":
                    budgets[expected["budgetComponent"]] += row["scored_positions"]
                if row["resolved_family"] != expected["parentResolvedFamily"]:
                    native_family_changes.append({"episodeId": row["episode_id"],
                        "parentResolvedFamily": expected["parentResolvedFamily"],
                        "subsetResolvedFamily": row["resolved_family"]})
                retained.add(row["episode_id"])
            require(retained == wanted, "Native subset deduplication removed a requested parent example")
            require(all(len(groups) == 1 for groups in native_groups.values()), "Native subset merged unrelated budget components")
            total_training = sum(budgets.values())
            require(total_training <= sampler["policy"].get("maxTrainingTokens", total_training),
                    "Final native subset exceeds declared total training token budget")
            require(all(value <= sampler["policy"]["maxFamilyTokens"] and
                        value <= total_training * sampler["policy"]["maxFamilyShare"] + 1e-9
                        for value in budgets.values()), "Final native subset exceeds declared training caps")
            manifest = export_prepared(store, staging, codec=codec,
                source_receipts=[*corpus.manifest["sources"], source],
                pipeline_fingerprint=content_hash(source), sidecars={"selection-source.json": source})
            require(manifest["census"]["accepted_episodes"] == len(wanted), "Native export lost subset members")

    checked = []
    with PreparedDataset(staging, split=None, verify_checksums=True) as subset:
        for index in range(len(subset)):
            row = subset.index_entry(index)
            episode = subset[index]
            expected = provenance[row["episode_id"]]
            require(row["sha256"] == expected["episodeJsonLineSha256"], "Native output changed full Episode bytes")
            require(episode.lineage.task_id == expected["nativeTaskId"], "Native output changed the original task identity")
            require(row["split"] == expected["split"] == episode.lineage.frozen_split, "Native output changed frozen split")
            require(row["tokens"] == expected["wholeTranscriptTokens"] and
                    row["scored_positions"] == expected["scoredPositions"], "Native output changed token counts")
            require(encoded_identity(encode_episode(episode, codec)) == expected["encodedTokensAndMasksSha256"],
                    "Native output changed token IDs or free masks")
            checked.append({**expected, "subsetEntryId": row["entry_id"], "subsetResolvedFamily": row["family_id"]})
        require({row["episodeId"] for row in checked} == wanted, "Output native inventory changed")

    require(sha(parent / "manifest.json") == source["parentManifestSha256"] and
            sha(parent / "semantic-dedup.sqlite") == source["parentDedupDatabaseSha256"] and
            sha(args.audit_campaign / "manifest.json") == source["sourceManifestSha256"],
            "A parent or original campaign changed during subset export")
    S.check_bindings(bound.values())
    receipt = {
        "schema": "semantic-native-prepared-subset-verification/1", "status": "verified",
        "source": source, "preparedFingerprint": manifest["fingerprint"],
        "preparedManifestSha256": sha(staging / "manifest.json"),
        "nativeAccepted": len(checked), "splits": dict(splits),
        "wholeTranscriptTokens": sum(row["wholeTranscriptTokens"] for row in checked),
        "generatedTokens": sum(row["generatedTokens"] for row in checked),
        "scoredPositions": sum(row["scoredPositions"] for row in checked),
        "nativeDuplicates": manifest["census"]["duplicates"], "nativeQuarantined": manifest["census"]["quarantined"],
        "nativeResolvedFamilyChanges": native_family_changes,
        "nativeFamilyScope": "Native union labels may be recomputed by normal subset ingestion; original Episode identities, full lineage and conservative parent budget groups are preserved.",
        "trainingBudgetComponents": len(budgets),
        "maximumTrainingComponentTokens": max(budgets.values(), default=0),
        "maximumTrainingComponentShare": max(budgets.values(), default=0) / total_training if total_training else 0,
        "unchangedEpisodeChecks": checked, "optimizerSteps": 0, "learnedSuccess": None,
        "elapsedMs": (time.monotonic() - started) * 1000,
        "peakPythonProcessRssBytes": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss * 1024,
        "rssScope": "The materializer Python process only, not a process-tree memory quota.",
    }
    write(staging / "subset-verification.json", receipt)
    staging.replace(output)
    return receipt


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("parent", "sampler", "audit-campaign", "megatoken", "tokenizer", "out"):
        parser.add_argument("--" + name, type=Path, required=True)
    args = parser.parse_args()
    receipt = materialize(args)
    print(json.dumps({key: receipt[key] for key in ("status", "nativeAccepted", "splits", "generatedTokens",
        "scoredPositions", "preparedFingerprint", "maximumTrainingComponentShare", "elapsedMs", "peakPythonProcessRssBytes")}, sort_keys=True))


if __name__ == "__main__":
    main()
