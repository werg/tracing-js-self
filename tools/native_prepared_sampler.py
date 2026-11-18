"""Authenticated inventory joins for the current native prepared sampler CLI.

The pure joins are deliberately separate from native reconstruction: their
tests exercise corrupt inventories without pretending to execute a native
admission, tokenizer, or model. Production reconstruction happens in the CLI.
"""
from __future__ import annotations

import base64
import hashlib
import json
from pathlib import Path
import re
import sqlite3
import subprocess


SCHEMA = "semantic-native-prepared-training-sampler/1"
SPLITS = ("train", "validation", "test")
ROOT = Path(__file__).resolve().parents[1]


def require(condition, message):
    if not condition:
        raise ValueError(message)


def sha(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def digest(value):
    return hashlib.sha256(canonical(value).encode()).hexdigest()


def read(path, maximum=64 << 20):
    path = Path(path)
    require(path.stat().st_size <= maximum, "Metadata exceeds the declared bounded reader: " + str(path))
    with path.open("r", encoding="utf-8") as stream:
        return json.load(stream)


def write(path, value):
    with Path(path).open("x", encoding="utf-8") as stream:
        json.dump(value, stream, indent=2, sort_keys=True, ensure_ascii=False, allow_nan=False)
        stream.write("\n")


def inside(root, name):
    require(isinstance(name, str) and name and "\\" not in name and "\0" not in name,
            "Invalid prepared file path")
    relative = Path(name)
    require(not relative.is_absolute() and relative.as_posix() == name and
            all(part not in (".", "..") for part in relative.parts), "Noncanonical prepared file path")
    path = Path(root)
    for part in relative.parts:
        path /= part
        require(not path.is_symlink(), "Symbolic link in prepared input")
    require(path.is_file(), "Missing prepared input: " + str(path))
    return path


def file_binding(path):
    path = Path(path).resolve()
    return {"path": str(path), "bytes": path.stat().st_size, "sha256": sha(path)}


def bind_file(bindings, path):
    """Capture before use; a subsequent bind checks rather than replaces it."""
    current = file_binding(path)
    previous = bindings.setdefault(current["path"], current)
    require(current == previous, "Authenticated input bytes changed during derivation: " + current["path"])
    return Path(current["path"])


def check_bindings(bindings):
    for previous in bindings:
        require(file_binding(previous["path"]) == previous,
                "Authenticated input bytes changed during derivation: " + previous["path"])


def checkout(path, expected=None):
    path = Path(path).resolve()
    revision = subprocess.check_output(["git", "-C", str(path), "rev-parse", "HEAD"], text=True).strip()
    dirty = subprocess.check_output(["git", "-C", str(path), "status", "--porcelain", "--untracked-files=no"], text=True)
    require(not dirty and (expected is None or revision == expected),
            "Checkout must be tracked-clean at its exact declared revision: " + str(path))
    return revision


def read_database(path, query):
    path = Path(path).resolve()
    require(path.is_file(), "Missing native inventory database")
    for suffix in ("-wal", "-journal"):
        sidecar = Path(str(path) + suffix)
        require(not sidecar.exists() or sidecar.stat().st_size == 0,
                "Native database has an unsealed journal; close preparation first")
    with sqlite3.connect(path.as_uri() + "?mode=ro&immutable=1", uri=True) as connection:
        connection.row_factory = sqlite3.Row
        require(connection.execute("PRAGMA quick_check").fetchall()[0][0] == "ok",
                "Native database integrity check failed")
        return [dict(row) for row in connection.execute(query)]


def unique(rows, key, label):
    result = {}
    for row in rows:
        value = row[key]
        require(value not in result, "Repeated " + label + " identity")
        result[value] = row
    return result


def native_logical_digest(episode, tokenizer_identity):
    """Reassemble the pinned harness's exact pre-fragmentation record digest."""
    groups, seen, record_ids = [], set(), set()
    for record in episode["records"]:
        require(record["record_id"] not in record_ids, "Repeated native physical record")
        record_ids.add(record["record_id"])
        require(record["codec_fingerprint"] == tokenizer_identity, "Native record codec changed")
        require(type(record["policy_mask"]) is bool, "Native record action mask is not Boolean")
        logical_id = record.get("logical_id") or record["record_id"]
        require(isinstance(logical_id, str) and logical_id, "Missing native logical record identity")
        try:
            payload = base64.b64decode(record["payload"], validate=True)
        except (ValueError, TypeError) as error:
            raise ValueError("Invalid native record payload encoding") from error
        if logical_id.startswith("semantic:context:"):
            require(record["role"] == "system" and record["policy_mask"] is False and
                    record["part_index"] == 0 and record["part_count"] == 1,
                    "Context transport acquired a target mask or fragmentation")
            continue
        require(type(record["part_count"]) is int and record["part_count"] > 0 and
                type(record["part_index"]) is int, "Invalid native fragmentation metadata")
        if not groups or groups[-1][0] != logical_id:
            require(logical_id not in seen and record["part_index"] == 0,
                    "Native logical fragments are missing, repeated, or reordered")
            seen.add(logical_id)
            groups.append([logical_id, bytearray(), 0, record["part_count"],
                           record["role"], record["policy_mask"]])
        group = groups[-1]
        require(record["part_index"] == group[2] and record["part_count"] == group[3] and
                record["role"] == group[4] and record["policy_mask"] is group[5],
                "Native fragment sequence or action ownership changed")
        group[1].extend(payload)
        group[2] += 1
    require(groups and all(group[2] == group[3] for group in groups), "Incomplete native logical records")
    return hashlib.sha256(b"\n".join(bytes(group[1]) for group in groups)).hexdigest()


def joined_inventory(source, prepared, native, policy, database_rows, index_rows):
    """Join the entire sealed dedup/index population; never silently drop a row."""
    require(source.get("schema") == "semantic-corpus-manifest/4", "Complete original campaign manifest required")
    for value in (source.get("campaign", {}).get("identityDigest"), source.get("sourceRegistry", {}).get("digest")):
        require(isinstance(value, str) and re.fullmatch(r"[a-f0-9]{64}", value), "Missing frozen campaign or registry identity")
    require(prepared.get("complete") is True and prepared.get("codec_fingerprint") == policy["tokenizerIdentity"],
            "Prepared dataset is incomplete or uses a different tokenizer")
    require(native.get("schema") == "semantic-preparation/4" and not native.get("refusals") and
            native.get("producerRevision") == source["producerRevision"] and
            native.get("consumerRevision") == policy["consumerRevision"] and
            native.get("tokenizerIdentity") == policy["tokenizerIdentity"],
            "Native preparation report is stale, refused, or incompatible with the pinned campaign")
    originals = unique(source["cases"], "id", "original candidate")
    indexed = unique(index_rows, "episode_id", "prepared episode")
    unique(index_rows, "entry_id", "prepared entry")
    unique(database_rows, "episode_id", "dedup episode")
    require(native["counts"].get("admitted") == native["counts"].get("attempted") == len(database_rows),
            "Native admitted input population differs from the full dedup inventory")
    require(native["counts"].get("already_present", 0) == 0,
            "Repeated native input needs an explicit representative campaign before derivation")
    accepted, excluded, seen = [], [], set()
    for row in database_rows:
        episode = json.loads(row["episode_json"])
        lineage = episode["lineage"]
        case_id = lineage["task_id"]
        require(case_id in originals and case_id not in seen, "Native row has a missing or repeated original candidate join")
        seen.add(case_id)
        case = originals[case_id]
        require(case.get("status") == "admitted", "Native row joins an original non-admission")
        logical = native_logical_digest(episode, policy["tokenizerIdentity"])
        require(episode["episode_id"] == row["episode_id"] == "semantic:harness:" + logical and
                lineage["revision"] == logical, "Native logical digest or episode identity changed")
        require(lineage["family_id"] == case["family"] and lineage["frozen_split"] == case["split"] and
                row["inherited_split"] == case["split"] and case["split"] in SPLITS,
                "Native lineage changed the original family or frozen split")
        generated, scored, total = row["assistant_tokens"], row["scored_positions"], row["token_count"]
        require(all(type(value) is int for value in (generated, scored, total)) and
                0 < generated == scored <= total and generated == case["metrics"]["generatedTokens"] and
                total - generated == case["metrics"]["observedTokens"],
                "Native generated/scored/observed token counts differ from original admission")
        record = {"id": case_id, "episodeId": row["episode_id"], "split": case["split"],
            "nativeSplit": row["split"], "family": case["family"],
            "frozenSourceComponent": case["sourceCluster"], "nativeResolvedFamily": row["resolved_family"],
            "generatedTokens": generated, "scoredPositions": scored, "wholeTranscriptTokens": total,
            "observedTokens": total - generated, "identityDigest": case["identityDigest"],
            "episodeDigest": case["episodeDigest"], "nativeLogicalRecordDigest": logical}
        if row["duplicate_of"] is not None or row["quarantine_reason"] is not None:
            require(row["episode_id"] not in indexed, "Native excluded row appears in the accepted index")
            excluded.append({**record, "decision": "native-excluded",
                "duplicateOfEpisodeId": row["duplicate_of"], "quarantineReason": row["quarantine_reason"]})
            continue
        require(row["split"] == case["split"], "Native accepted row moved its frozen evaluation/training split")
        require(row["episode_id"] in indexed, "Native accepted row is missing from the prepared index")
        index = indexed[row["episode_id"]]
        require(index["family_id"] == row["resolved_family"] and index["split"] == case["split"] and
                index["tokens"] == total and index["scored_positions"] == scored,
                "Prepared index disagrees with accepted native lineage or token inventory")
        require(type(index["entry_id"]) is int and index["entry_id"] >= 0, "Invalid prepared entry identity")
        record["preparedEntryId"] = index["entry_id"]
        accepted.append(record)
    require(len(accepted) == len(indexed) == native["accepted"] == prepared["census"]["accepted_episodes"] ==
            prepared["counts"].get("*"), "Prepared accepted population is missing or contains foreign rows")
    require(accepted, "No native accepted rows; no training sampler can be derived")
    require(len(excluded) == len(database_rows) - len(indexed), "Native exclusions do not reconcile")
    for split in SPLITS:
        require(prepared["counts"].get("split:" + split, 0) == sum(row["split"] == split for row in accepted),
                "Prepared split census disagrees with exact accepted membership")
    require(prepared["census"]["duplicates"] == sum(row["duplicate_of"] is not None for row in database_rows) and
            prepared["census"]["quarantined"] == sum(row["quarantine_reason"] is not None for row in database_rows),
            "Native duplicate/quarantine census differs from retained exclusions")
    omissions = [{"id": row["id"], "split": row["split"], "family": row["family"],
                  "identityDigest": row["identityDigest"], "episodeDigest": row["episodeDigest"],
                  "disposition": "original-admission-not-present-in-native-preparation"}
                 for row in source["cases"] if row["status"] == "admitted" and row["id"] not in seen]
    return accepted, excluded, sorted(omissions, key=lambda row: row["id"])


def balance(accepted, policy):
    """Reuse maintained component validation and the historical control selector."""
    script = """
import {readFileSync} from 'node:fs'; import {pathToFileURL} from 'node:url';
const {preparedBudgetGroups}=await import(pathToFileURL(process.argv[1]));
const {balanceFamilyTokens}=await import(pathToFileURL(process.argv[2]));
const input=JSON.parse(readFileSync(0,'utf8')),groups=preparedBudgetGroups(input.rows);
const rows=input.rows.map(row=>({...row,budgetComponent:groups.get(row.id)}));
const result=balanceFamilyTokens(rows.filter(row=>row.split==='train').map(row=>
  ({...row,status:'admitted',sourceCluster:row.budgetComponent})),input.policy);
console.log(JSON.stringify({groups:Object.fromEntries(groups),ids:result.selected.map(row=>row.id),refused:result.refused}));
"""
    result = subprocess.run(["node", "--input-type=module", "-e", script,
        str(ROOT / "src/corpus/native-prepared-coverage.mjs"), str(ROOT / "src/corpus/source-registry.mjs")],
        input=canonical({"rows": accepted, "policy": policy}), text=True, capture_output=True, timeout=300)
    require(result.returncode == 0, "Conservative component/budget validation failed: " + result.stderr[-4000:])
    selected = json.loads(result.stdout)
    for row in accepted:
        row["budgetComponent"] = selected["groups"][row["id"]]
    included = set(selected["ids"]) | {row["id"] for row in accepted if row["split"] != "train"}
    reasons = {row["id"]: row["reason"] for row in selected["refused"]}
    require(len(included) + len(reasons) == len(accepted) and not included.intersection(reasons),
            "Training selection does not partition the complete native accepted population")
    decisions = [{**row, "decision": "included" if row["id"] in included else "excluded",
        "reason": "evaluation-retained" if row["split"] != "train" else
                  reasons.get(row["id"], "within-training-component-budgets")} for row in accepted]
    return decisions


def summary(rows):
    return {"episodes": len(rows), "declaredFamilies": len({row["family"] for row in rows}),
        "frozenSourceComponents": len({row["frozenSourceComponent"] for row in rows}),
        "nativeResolvedFamilies": len({row["nativeResolvedFamily"] for row in rows}),
        "budgetComponents": len({row["budgetComponent"] for row in rows}),
        "nativeGeneratedTokens": sum(row["generatedTokens"] for row in rows),
        "scoredPositions": sum(row["scoredPositions"] for row in rows),
        "nativeObservedTokens": sum(row["observedTokens"] for row in rows)}


def census(rows):
    train = [row for row in rows if row["split"] == "train"]
    total = sum(row["generatedTokens"] for row in train)
    groups = []
    for identity in sorted({row["budgetComponent"] for row in train}):
        members = [row for row in train if row["budgetComponent"] == identity]
        groups.append({"budgetComponent": identity, **summary(members),
            "share": sum(row["generatedTokens"] for row in members) / total if total else 0,
            "frozenComponents": sorted({row["frozenSourceComponent"] for row in members}),
            "nativeFamilies": sorted({row["nativeResolvedFamily"] for row in members})})
    groups.sort(key=lambda row: (-row["nativeGeneratedTokens"], row["budgetComponent"]))
    return {**summary(rows), "splits": {split: summary([row for row in rows if row["split"] == split]) for split in SPLITS},
        "trainingComponents": groups, "maximumTrainingComponentShare": max((row["share"] for row in groups), default=0)}


def make_sampler(source, prepared, policy, budget, accepted, excluded, omissions, bindings):
    decisions = balance(accepted, budget)
    included = [row for row in decisions if row["decision"] == "included"]
    before, after = census(decisions), census(included)
    require({row["episodeId"] for row in decisions if row["split"] != "train"} ==
            {row["episodeId"] for row in included if row["split"] != "train"}, "Selection removed accepted evaluation rows")
    for group in after["trainingComponents"]:
        require(group["nativeGeneratedTokens"] <= budget["maxFamilyTokens"] and
                group["share"] <= budget["maxFamilyShare"] + 1e-15, "Native selection exceeded hard training caps")
    return {"schema": SCHEMA, "status": "verified", "policy": {**budget,
        "grouping": "transitive-union-of-frozen-source-components-and-native-resolved-families/1",
        "evaluationRows": "retain-all-native-accepted-validation-and-test"},
        "scope": "Read-only sampler over the entire authenticated native accepted inventory; no new native dataset or optimization.",
        "producerRevision": source["producerRevision"], "nativePolicy": policy,
        "sourceRegistryDigest": source["sourceRegistry"]["digest"],
        "sourceCampaignDigest": source["campaign"]["identityDigest"],
        "nativePreparedFingerprint": prepared["fingerprint"], **bindings,
        "upstreamDispositions": {"originalAttempted": len(source["cases"]),
            "originalNativeAdmitted": sum(row["status"] == "admitted" for row in source["cases"]),
            "originalNonAdmissions": sum(row["status"] != "admitted" for row in source["cases"]),
            "nativePreparedInputs": len(accepted) + len(excluded), "nativePreparedAccepted": len(accepted),
            "nativeExcluded": len(excluded), "originalAdmissionsAbsentFromPreparation": len(omissions)},
        "before": before, "after": after,
        "includedCandidateIds": sorted(row["id"] for row in included),
        "includedEpisodeIds": sorted(row["episodeId"] for row in included),
        "includedPreparedEntryIds": sorted(row["preparedEntryId"] for row in included),
        "excludedAcceptedCandidateIds": sorted(row["id"] for row in decisions if row["decision"] == "excluded"),
        "acceptedDecisions": decisions, "nativeExclusions": excluded, "upstreamOmissions": omissions,
        "optimizerSteps": 0, "learnedSuccess": None,
        "limitations": ["Membership and static target counts are not actual optimizer exposure.",
            "Every native-accepted evaluation row is retained. Original admissions absent upstream remain explicit and are not reclassified as native exclusions.",
            "Archived source receipts are reconciled to the complete campaign; this inventory command does not rerun the independent source oracle.",
            "Native source reconstruction, token IDs and masks are rechecked under the pinned consumer; no model is executed."]}
