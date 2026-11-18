"""Derive a token-capped sampler only from final native accepted inventory."""
from __future__ import annotations

import hashlib
import argparse
import base64
import json
import sqlite3
import subprocess
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--workspace', type=Path, required=True)
ROOT = parser.parse_args().workspace.resolve()
PREPARED = ROOT / "deliverables/release-D-real-source/package/prepared"
SELECTED = ROOT / "deliverables/release-D-real-source/selected-v2"
POLICY = {"maxFamilyTokens": 10000, "maxFamilyShare": 0.20}


def sha(path: Path) -> str:
    value = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            value.update(block)
    return value.hexdigest()


def read(path: Path):
    return json.loads(path.read_text())


prepared = read(PREPARED / "manifest.json")
native = read(PREPARED / "semantic-report.json")
representatives = read(SELECTED / "manifest.json")
source = read(ROOT / "release-evidence-D/real-source/manifest.json")
policy = read(ROOT / "tracing-release-D/contracts/native-admission-policy-v5.json")
assert prepared["complete"] is True
assert not native["refusals"] and native["counts"]["admitted"] == 965
assert prepared["codec_fingerprint"] == policy["tokenizerIdentity"]
assert native["consumerRevision"] == policy["consumerRevision"]
assert native["producerRevision"] == representatives["producerRevision"] == source["producerRevision"]
index_path = PREPARED / prepared["index"]["path"]
assert sha(index_path) == prepared["index"]["sha256"]
metadata = {row["id"]: row for row in representatives["cases"]}
assert len(metadata) == 965


def native_logical_digest(episode):
    """Match the pinned adapter's pre-fragmentation record digest exactly.

    Native episode IDs hash newline-delimited logical record payloads. They
    deliberately differ from the producer's whole-public-JSON episode digest.
    Physical context announcements are transport additions, not logical input.
    """
    groups = []
    seen = set()
    for record in episode["records"]:
        assert record["codec_fingerprint"] == policy["tokenizerIdentity"]
        logical_id = record.get("logical_id") or record["record_id"]
        if logical_id.startswith("semantic:context:"):
            assert record["role"] == "system" and record["policy_mask"] is False
            continue
        payload = base64.b64decode(record["payload"], validate=True)
        if not groups or groups[-1][0] != logical_id:
            assert logical_id not in seen and record["part_index"] == 0
            seen.add(logical_id)
            groups.append([logical_id, bytearray(), 0, record["part_count"]])
        group = groups[-1]
        assert record["part_index"] == group[2] and record["part_count"] == group[3]
        group[1].extend(payload)
        group[2] += 1
    assert all(group[2] == group[3] for group in groups)
    return hashlib.sha256(b"\n".join(bytes(group[1]) for group in groups)).hexdigest()

with sqlite3.connect(f"file:{index_path}?mode=ro&immutable=1", uri=True) as index:
    index.row_factory = sqlite3.Row
    indexed = {row["episode_id"]: dict(row) for row in index.execute("SELECT * FROM episodes")}

parents: dict[str, str] = {}


def find(value: str) -> str:
    parents.setdefault(value, value)
    if parents[value] != value:
        parents[value] = find(parents[value])
    return parents[value]


def union(left: str, right: str) -> None:
    roots = sorted({find(left), find(right)})
    for item in roots[1:]:
        parents[item] = roots[0]


accepted, removed, all_ids = [], [], set()
database = PREPARED / "semantic-dedup.sqlite"
with sqlite3.connect(f"file:{database}?mode=ro&immutable=1", uri=True) as connection:
    connection.row_factory = sqlite3.Row
    for row in connection.execute("SELECT * FROM episodes ORDER BY ordinal"):
        episode = json.loads(row["episode_json"])
        case_id = episode["lineage"]["task_id"]
        assert case_id in metadata and case_id not in all_ids
        all_ids.add(case_id)
        case = metadata[case_id]
        assert case["status"] == "admitted"
        logical_digest = native_logical_digest(episode)
        assert row["episode_id"] == episode["episode_id"] == "semantic:harness:" + logical_digest
        assert episode["lineage"]["revision"] == logical_digest
        assert episode["lineage"]["family_id"] == case["family"]
        assert episode["lineage"]["frozen_split"] == case["split"]
        record = {
            "id": case_id, "episodeId": row["episode_id"], "split": case["split"],
            "nativeSplit": row["split"],
            "family": case["family"], "frozenSourceComponent": case["sourceCluster"],
            "nativeResolvedFamily": row["resolved_family"],
            "generatedTokens": row["assistant_tokens"], "scoredPositions": row["scored_positions"],
            "wholeTranscriptTokens": row["token_count"],
            "observedTokens": row["token_count"] - row["assistant_tokens"],
            "identityDigest": case["identityDigest"], "episodeDigest": case["episodeDigest"],
            "nativeLogicalRecordDigest": logical_digest,
        }
        # This equality is checked for the strict v5 profile, not assumed for
        # arbitrary native corpora with partial record-level free-span masks.
        assert record["generatedTokens"] == record["scoredPositions"] == case["metrics"]["generatedTokens"]
        assert record["observedTokens"] == case["metrics"]["observedTokens"]
        if row["duplicate_of"] is not None or row["quarantine_reason"] is not None:
            removed.append({**record, "decision": "native-excluded",
                "duplicateOfEpisodeId": row["duplicate_of"], "quarantineReason": row["quarantine_reason"]})
            assert row["episode_id"] not in indexed
            continue
        assert row["split"] == record["split"], "Native accepted row changed its frozen split"
        indexed_row = indexed[row["episode_id"]]
        assert indexed_row["family_id"] == row["resolved_family"]
        assert indexed_row["split"] == record["split"]
        assert indexed_row["tokens"] == record["wholeTranscriptTokens"]
        assert indexed_row["scored_positions"] == record["scoredPositions"]
        record["preparedEntryId"] = indexed_row["entry_id"]
        accepted.append(record)
        union("frozen:" + record["frozenSourceComponent"], "native:" + record["nativeResolvedFamily"])

assert len(all_ids) == 965
assert len(accepted) == len(indexed) == native["accepted"] == prepared["census"]["accepted_episodes"]
members = {}
for node in sorted(parents):
    members.setdefault(find(node), []).append(node)
group_ids = {key: "prepared-budget:" + hashlib.sha256(
    json.dumps(value, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()
    for key, value in members.items()}
group_splits = {}
for row in accepted:
    row["budgetComponent"] = group_ids[find("frozen:" + row["frozenSourceComponent"])]
    group_splits.setdefault(row["budgetComponent"], set()).add(row["split"])
assert all(len(splits) == 1 for splits in group_splits.values()), "Merged native/source group crosses frozen splits"
training = [row for row in accepted if row["split"] == "train"]
evaluation = [row for row in accepted if row["split"] != "train"]
script = """
import {readFileSync} from 'node:fs';import {pathToFileURL} from 'node:url';
const {balanceFamilyTokens}=await import(pathToFileURL(process.argv[1]));
const input=JSON.parse(readFileSync(0,'utf8'));
const result=balanceFamilyTokens(input.rows,input.policy);
console.log(JSON.stringify({ids:result.selected.map(row=>row.id),refused:result.refused}));
"""
balanced = json.loads(subprocess.run(
    ["node", "--input-type=module", "-e", script, str(ROOT / "tracing-release-D/src/corpus/source-registry.mjs")],
    input=json.dumps({"policy": POLICY, "rows": [{"id": row["id"], "status": "admitted",
        "sourceCluster": row["budgetComponent"], "generatedTokens": row["generatedTokens"]} for row in training]}),
    text=True, capture_output=True, check=True).stdout)
included_ids = set(balanced["ids"]) | {row["id"] for row in evaluation}
reasons = {row["id"]: row["reason"] for row in balanced["refused"]}
included = [row for row in accepted if row["id"] in included_ids]
assert len(included) + len(reasons) == len(accepted)
assert {row["id"] for row in included if row["split"] != "train"} == {row["id"] for row in evaluation}


def summary(rows):
    return {"episodes": len(rows), "declaredFamilies": len({row["family"] for row in rows}),
        "frozenSourceComponents": len({row["frozenSourceComponent"] for row in rows}),
        "nativeResolvedFamilies": len({row["nativeResolvedFamily"] for row in rows}),
        "budgetComponents": len({row["budgetComponent"] for row in rows}),
        "nativeGeneratedTokens": sum(row["generatedTokens"] for row in rows),
        "scoredPositions": sum(row["scoredPositions"] for row in rows),
        "nativeObservedTokens": sum(row["observedTokens"] for row in rows)}


def distribution(rows):
    total = sum(row["generatedTokens"] for row in rows)
    groups = {}
    for row in rows:
        groups.setdefault(row["budgetComponent"], []).append(row)
    return sorted([{"budgetComponent": key, **summary(values),
        "share": sum(row["generatedTokens"] for row in values) / total if total else 0,
        "frozenComponents": sorted({row["frozenSourceComponent"] for row in values}),
        "nativeFamilies": sorted({row["nativeResolvedFamily"] for row in values})}
        for key, values in groups.items()], key=lambda row: (-row["nativeGeneratedTokens"], row["budgetComponent"]))


def census(rows):
    train = [row for row in rows if row["split"] == "train"]
    groups = distribution(train)
    return {**summary(rows), "splits": {split: summary([row for row in rows if row["split"] == split])
        for split in ("train", "validation", "test")}, "trainingComponents": groups,
        "maximumTrainingComponentShare": max((row["share"] for row in groups), default=0)}


after = census(included)
for group in after["trainingComponents"]:
    assert group["nativeGeneratedTokens"] <= POLICY["maxFamilyTokens"]
    assert group["share"] <= POLICY["maxFamilyShare"] + 1e-15
report = {
    "schema": "semantic-native-prepared-training-sampler/1", "policy": {**POLICY,
        "grouping": "transitive-union-of-frozen-source-components-and-native-resolved-families/1",
        "evaluationRows": "retain-all-native-accepted-validation-and-test"},
    "scope": "Read-only sampler membership over final native accepted/deduplicated data; no new native dataset or model training run.",
    "producerRevision": source["producerRevision"], "nativePolicy": policy,
    "sourceRegistryDigest": source["sourceRegistry"]["digest"],
    "sourceCampaignDigest": source["campaign"]["identityDigest"],
    "sourceManifestSha256": sha(ROOT / "release-evidence-D/real-source/manifest.json"),
    "representativeManifestSha256": sha(SELECTED / "manifest.json"),
    "nativePreparedManifestSha256": sha(PREPARED / "manifest.json"),
    "nativePreparedFingerprint": prepared["fingerprint"],
    "nativePreparedIndexSha256": sha(index_path), "nativeDedupDatabaseSha256": sha(database),
    "nativeReportSha256": sha(PREPARED / "semantic-report.json"),
    "upstreamDispositions": {"originalAttempted": 1171, "originalNativeAdmitted": 987,
        "originalNonAdmissions": 184, "exactPublicAliases": 22, "nativeRepresentatives": 965,
        "nativePreparedAccepted": len(accepted), "nativeExcluded": len(removed)},
    "accounting": "Every native episode maps to the original candidate by lineage.task_id. Native episode IDs were recomputed from reassembled logical record payloads under the pinned codec; this digest is distinct from the producer's whole-public-JSON episode digest. Generated tokens equal native assistant_tokens and scored_positions for every row and match the original admission token receipt. Accepted index membership, split, resolved family, transcript tokens and scored positions were cross-checked. Observed tokens are total minus generated, not only tool/environment-role tokens.",
    "before": census(accepted), "after": after,
    "includedCandidateIds": sorted(included_ids),
    "includedEpisodeIds": sorted(row["episodeId"] for row in included),
    "includedPreparedEntryIds": sorted(row["preparedEntryId"] for row in included),
    "excludedAcceptedCandidateIds": sorted(reasons),
    "acceptedDecisions": [{**row, "decision": "included" if row["id"] in included_ids else "excluded",
        "reason": "evaluation-retained" if row["split"] != "train" else reasons.get(row["id"], "within-training-component-budgets")}
        for row in accepted],
    "nativeExclusions": removed, "optimizerSteps": 0, "learnedSuccess": None,
    "limitations": ["Shares describe one pass over included native generated-token inventory; no optimizer or model sampler was executed, and later sampling weights or repetition can alter training-time exposure.",
        "Conservative grouping may merge distinct algorithms. Family, frozen-component, native-family and budget-component counts remain separate.",
        "Every native-accepted evaluation row is retained; original evaluation aliases/duplicates remain in the full archived census.",
        "The complete prepared dataset and original 1171-attempt campaign are unchanged."]}
output = ROOT / "release-evidence-D/real-source-native-prepared-sampler.json"
output.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")
print(json.dumps({"path": str(output), "sha256": sha(output), "before": report["before"]["splits"],
    "after": report["after"]["splits"], "included": len(included), "excludedAccepted": len(reasons),
    "nativeExcluded": len(removed), "maxShare": after["maximumTrainingComponentShare"]}, sort_keys=True))
