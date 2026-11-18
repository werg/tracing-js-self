"""Corrupt inventory fixtures exercise joins and gates, not native/model success.

The fixture tokens below are deliberately synthetic. The production CLI has
no fixture/bypass mode: it additionally uses the pinned actual native codec,
admission, reconstruction, PreparedDataset reader, and encoded free masks.
"""
import base64
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))
import native_prepared_sampler as S

SPEC = importlib.util.spec_from_file_location("sampler_cli", ROOT / "tools/derive-native-prepared-sampler.py")
CLI = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CLI)
MATERIALIZER_SPEC = importlib.util.spec_from_file_location("materializer_cli", ROOT / "tools/materialize-native-prepared-subset.py")
MATERIALIZER = importlib.util.module_from_spec(MATERIALIZER_SPEC)
MATERIALIZER_SPEC.loader.exec_module(MATERIALIZER)


def fixture():
    policy = {"consumerRevision": "b" * 40, "tokenizerIdentity": "c" * 64, "tokenizerSha256": "d" * 64}
    rows, indexed, cases, audit = [], [], [], []
    for ordinal, (name, split) in enumerate((("train-a", "train"), ("train-b", "train"),
                                            ("validation-v", "validation"), ("test-t", "test"),
                                            ("duplicate", "train"))):
        generated, observed = 4, 5
        record = {"record_id": "record:" + name, "logical_id": "", "part_index": 0, "part_count": 1,
            "codec_fingerprint": policy["tokenizerIdentity"], "role": "assistant", "policy_mask": True,
            "payload": base64.b64encode(name.encode()).decode()}
        logical = hashlib.sha256(name.encode()).hexdigest()
        episode = {"episode_id": "semantic:harness:" + logical, "records": [record],
            "lineage": {"task_id": name, "revision": logical, "family_id": "family:" + name, "frozen_split": split}}
        row = {"ordinal": ordinal, "episode_id": episode["episode_id"], "episode_json": S.canonical(episode),
            "split": split, "inherited_split": split, "resolved_family": "native:" + name,
            "assistant_tokens": generated, "scored_positions": generated, "token_count": generated + observed,
            "duplicate_of": rows[0]["episode_id"] if name == "duplicate" else None, "quarantine_reason": None}
        rows.append(row)
        if name != "duplicate":
            indexed.append({"entry_id": ordinal, "episode_id": episode["episode_id"], "split": split,
                "family_id": row["resolved_family"], "tokens": row["token_count"], "scored_positions": generated})
        cases.append({"id": name, "status": "admitted", "family": "family:" + name, "split": split,
            "sourceCluster": "frozen:" + name, "identityDigest": S.digest([name, "identity"]),
            "episodeDigest": S.digest([name, "public"]), "metrics": {"generatedTokens": generated, "observedTokens": observed},
            "difficulty": {"schema": "semantic-execution-difficulty/1", "activations": 1,
                "episodes": [{"executedOperations": ["primitive.binary"], "exceptionPath": {"outcome": "return", "throws": 0}}]}})
        audit.append(S.compact_audit_row({"episodeId": episode["episode_id"],
            "source": {"schema": "semantic-source-admission/4", "producerRevision": "a" * 40,
                "identityDigest": cases[-1]["identityDigest"], "episodeDigest": cases[-1]["episodeDigest"]},
            "native": {"schema": "semantic-native-admission/4", "admitted": True, **policy,
                "episodeDigest": cases[-1]["episodeDigest"]},
            "supervision": {"taskId": name, "identityDigest": cases[-1]["identityDigest"],
                "producerRevision": "a" * 40, "sourceFamily": cases[-1]["family"],
                "sourceLineage": cases[-1]["family"], "split": split}}))
    omitted = copy.deepcopy(cases[0])
    omitted["id"] = "upstream-budget-omission"
    omitted["identityDigest"] = S.digest([omitted["id"], "identity"])
    omitted["episodeDigest"] = S.digest([omitted["id"], "public"])
    cases.extend([omitted, {"id": "unsupported", "status": "unsupported", "family": "unsupported"}])
    source = {"schema": "semantic-corpus-manifest/4", "producerRevision": "a" * 40,
        "campaign": {"identityDigest": "e" * 64}, "sourceRegistry": {"digest": "f" * 64}, "cases": cases}
    prepared = {"complete": True, "codec_fingerprint": policy["tokenizerIdentity"], "fingerprint": "1" * 64,
        "census": {"accepted_episodes": 4, "duplicates": 1, "quarantined": 0},
        "counts": {"*": 4, "split:train": 2, "split:validation": 1, "split:test": 1}}
    native = {"schema": "semantic-preparation/4", "producerRevision": source["producerRevision"],
        "consumerRevision": policy["consumerRevision"], "tokenizerIdentity": policy["tokenizerIdentity"],
        "refusals": [], "counts": {"admitted": 5, "attempted": 5}, "accepted": 4}
    return source, prepared, native, policy, rows, indexed, audit


class InventoryTests(unittest.TestCase):
    def test_distinct_candidates_can_retain_the_same_native_task_identity(self):
        values = fixture()
        for index in (0, 1):
            episode = json.loads(values[4][index]["episode_json"])
            episode["lineage"]["task_id"] = "async-counter"
            values[4][index]["episode_json"] = S.canonical(episode)
            values[6][index]["supervision"]["taskId"] = "async-counter"
            values[6][index]["supervisionSha256"] = S.digest(values[6][index]["supervision"])
        accepted, excluded, omissions = S.joined_inventory(*values)
        self.assertEqual([(row["id"], row["nativeTaskId"]) for row in accepted[:2]],
                         [("train-a", "async-counter"), ("train-b", "async-counter")])
        self.assertEqual(len(accepted) + len(excluded), len(values[4]))
        self.assertEqual([row["id"] for row in omissions], ["upstream-budget-omission"])

    def test_audit_identity_joins_refuse_missing_ambiguous_repeated_or_tampered_evidence(self):
        def ambiguous(values):
            values[0]["cases"].append({**values[0]["cases"][0], "id": "ambiguous-candidate"})
        def repeated(values):
            other_id = values[6][1]["episodeId"]
            values[6][1] = {**copy.deepcopy(values[6][0]), "episodeId": other_id}
        attacks = [
            (lambda f: f[6].pop(), "omits or adds"),
            (lambda f: f[6].append(copy.deepcopy(f[6][0])), "Repeated native audit"),
            (lambda f: f[6][0].update(episodeId="foreign"), "omits or adds"),
            (lambda f: f[6][0]["source"].update(identityDigest="0" * 64), "missing or ambiguous"),
            (lambda f: f[6][0]["source"].update(episodeDigest="0" * 64), "missing or ambiguous"),
            (lambda f: f[6][0]["supervision"].update(identityDigest="0" * 64), "source/sidecar"),
            (lambda f: f[6][0]["supervision"].update(taskId="different-task"), "task identity"),
            (lambda f: f[6][0].update(supervisionSha256=None), "source/sidecar"),
            (lambda f: f[6][0]["native"].update(episodeDigest="0" * 64), "pinned source or consumer"),
            (lambda f: f[6][0]["native"].update(consumerRevision="0" * 40), "pinned source or consumer"),
            (lambda f: f[6][0]["native"].update(tokenizerIdentity="0" * 64), "pinned source or consumer"),
            (lambda f: f[6][0]["native"].update(admitted=False), "pinned source or consumer"),
            (ambiguous, "missing or ambiguous"), (repeated, "repeats an original candidate")]
        for change, error in attacks:
            with self.subTest(error=error):
                values = fixture()
                change(values)
                with self.assertRaisesRegex(ValueError, error):
                    S.joined_inventory(*values)

    def test_materializer_authenticates_separate_task_ids_and_preserves_legacy_gate(self):
        values = fixture()
        episode_value = json.loads(values[4][0]["episode_json"])
        episode_value["lineage"]["task_id"] = "async-counter"
        values[4][0]["episode_json"] = S.canonical(episode_value)
        values[6][0]["supervision"]["taskId"] = "async-counter"
        values[6][0]["supervisionSha256"] = S.digest(values[6][0]["supervision"])
        accepted, _, _ = S.joined_inventory(*values)
        sampler = {"sourceJoinSchema": S.SOURCE_JOIN_SCHEMA, "nativePolicy": values[3], "acceptedDecisions": accepted}
        joins = S.sampler_source_joins(sampler, values[0], values[4], values[6])
        episode = SimpleNamespace(episode_id=episode_value["episode_id"],
                                  lineage=SimpleNamespace(**episode_value["lineage"]))
        self.assertEqual(MATERIALIZER.verify_native_lineage(episode, accepted[0], joins), "async-counter")
        for key, value in (("id", "train-b"), ("nativeTaskId", "train-a"),
                           ("nativeAuditSupervisionSha256", "0" * 64)):
            with self.subTest(key=key):
                changed = copy.deepcopy(sampler)
                changed["acceptedDecisions"][0][key] = value
                with self.assertRaisesRegex(ValueError, "authenticated audit join"):
                    S.sampler_source_joins(changed, values[0], values[4], values[6])
                with self.assertRaisesRegex(ValueError, "authenticated audit join"):
                    MATERIALIZER.verify_native_lineage(episode, changed["acceptedDecisions"][0], joins)
        del sampler["sourceJoinSchema"]
        with self.assertRaisesRegex(ValueError, "declared source audit join"):
            S.sampler_source_joins(sampler, values[0], values[4], values[6])
        with self.assertRaisesRegex(ValueError, "lacks its authenticated source join"):
            MATERIALIZER.verify_native_lineage(episode, accepted[0], None)
        legacy = {key: value for key, value in accepted[0].items()
                  if key not in ("nativeTaskId", "nativeAuditSupervisionSha256")}
        with self.assertRaisesRegex(ValueError, "Native lineage"):
            MATERIALIZER.verify_native_lineage(episode, legacy, None)
        episode.lineage.task_id = legacy["id"]
        self.assertEqual(MATERIALIZER.verify_native_lineage(episode, legacy, None), legacy["id"])

    def test_complete_archived_sidecar_hash_is_checked_beyond_join_fields(self):
        values = fixture()
        public = {"original": "public source bytes"}
        original = {**values[0]["cases"][0], "episodeDigest": S.digest(public)}
        side = {**values[6][0]["supervision"], "taskId": "async-counter", "privateWitness": {"value": 7}}
        audit = {**values[6][0], "supervisionSha256": S.digest(side)}
        document = {"public": public, "sidecar": side}
        join = {"id": original["id"], "nativeTaskId": "async-counter"}
        public_digest = lambda value: S.digest(value["public"])
        CLI.verify_archived_document(document, original, values[0], audit, join, public_digest)
        side["privateWitness"]["value"] = 8
        with self.assertRaisesRegex(ValueError, "complete archived campaign"):
            CLI.verify_archived_document(document, original, values[0], audit, join, public_digest)
        side["privateWitness"]["value"] = 7
        side["taskId"] = original["id"]
        with self.assertRaisesRegex(ValueError, "original campaign identity"):
            CLI.verify_archived_document(document, original, values[0], audit, join, public_digest)

    def test_all_native_rows_partition_and_upstream_omissions_remain_separate(self):
        inputs = fixture()
        original = copy.deepcopy(inputs)
        accepted, excluded, omissions = S.joined_inventory(*inputs)
        self.assertEqual(len(accepted), 4)
        self.assertEqual(excluded[0]["id"], "duplicate")
        self.assertEqual(omissions[0]["id"], "upstream-budget-omission")
        self.assertEqual(inputs, original)
        sampler = S.make_sampler(inputs[0], inputs[1], inputs[3], {"maxFamilyTokens": 4, "maxFamilyShare": .5},
            accepted, excluded, omissions, {"sourceManifestSha256": S.digest(inputs[0])})
        self.assertEqual(sampler["before"]["episodes"], 4)
        self.assertEqual(sampler["after"]["episodes"], 4)
        self.assertEqual(sampler["upstreamDispositions"]["nativePreparedInputs"], 5)
        self.assertEqual(sampler["upstreamDispositions"]["originalNativeAdmitted"], 6)
        self.assertEqual(sampler["optimizerSteps"], 0)
        self.assertIsNone(sampler["learnedSuccess"])
        self.assertEqual({row["reason"] for row in sampler["acceptedDecisions"] if row["split"] != "train"}, {"evaluation-retained"})

    def test_missing_foreign_repeated_and_excluded_index_rows_refuse(self):
        attacks = [
            (lambda f: f[5].pop(), "missing from the prepared index"),
            (lambda f: f[5].append({**f[5][0], "entry_id": 90, "episode_id": "foreign"}), "population"),
            (lambda f: f[5].append(copy.deepcopy(f[5][0])), "Repeated prepared episode"),
            (lambda f: f[5][1].update(entry_id=f[5][0]["entry_id"]), "Repeated prepared entry"),
            (lambda f: f[5].append({**f[5][0], "entry_id": 91, "episode_id": f[4][-1]["episode_id"]}), "excluded row"),
            (lambda f: f[4].append(copy.deepcopy(f[4][0])), "Repeated dedup episode")]
        for change, error in attacks:
            with self.subTest(error=error):
                values = fixture()
                change(values)
                with self.assertRaisesRegex(ValueError, error):
                    S.joined_inventory(*values)

    def test_original_join_split_and_actual_count_claims_cannot_be_changed(self):
        def lineage(field, value):
            def change(f):
                episode = json.loads(f[4][0]["episode_json"])
                episode["lineage"][field] = value
                f[4][0]["episode_json"] = S.canonical(episode)
            return change
        attacks = [
            (lineage("task_id", "foreign-candidate"), "audit task identity"),
            (lineage("task_id", "train-b"), "audit task identity"),
            (lineage("family_id", "invented-family"), "family or frozen split"),
            (lineage("frozen_split", "test"), "family or frozen split"),
            (lambda f: f[4][0].update(split="test"), "moved its frozen"),
            (lambda f: f[0]["cases"][0].update(status="locally_verified"), "non-admission"),
            (lambda f: f[4][0].update(scored_positions=3), "token counts"),
            (lambda f: f[4][0].update(assistant_tokens=True), "token counts"),
            (lambda f: f[0]["cases"][0]["metrics"].update(observedTokens=6), "token counts"),
            (lambda f: f[5][0].update(tokens=99), "index disagrees")]
        for change, error in attacks:
            with self.subTest(error=error):
                values = fixture()
                change(values)
                with self.assertRaisesRegex(ValueError, error):
                    S.joined_inventory(*values)

    def test_pin_refusal_and_census_mismatches_refuse_instead_of_reducing_denominator(self):
        attacks = [
            (lambda f: f[2].update(consumerRevision="0" * 40), "pinned campaign"),
            (lambda f: f[2].update(refusals=[{"candidate": 5}]), "refused"),
            (lambda f: f[2]["counts"].update(admitted=4), "full dedup inventory"),
            (lambda f: f[2]["counts"].update(already_present=1), "explicit representative"),
            (lambda f: f[1]["counts"].update({"split:train": 1}), "split census"),
            (lambda f: f[1]["census"].update(duplicates=0), "duplicate/quarantine"),
            (lambda f: f[1].update(codec_fingerprint="0" * 64), "different tokenizer")]
        for change, error in attacks:
            with self.subTest(error=error):
                values = fixture()
                change(values)
                with self.assertRaisesRegex(ValueError, error):
                    S.joined_inventory(*values)

    def test_logical_digest_reassembles_fragments_and_rejects_lost_changed_or_scored_context(self):
        values = fixture()
        episode = json.loads(values[4][0]["episode_json"])
        original = episode["records"][0]
        episode["records"] = [{**original, "record_id": "physical:" + str(i), "logical_id": original["record_id"],
            "part_index": i, "part_count": 2, "payload": base64.b64encode(part).decode()} for i, part in enumerate((b"tra", b"in-a"))]
        self.assertEqual(S.native_logical_digest(episode, values[3]["tokenizerIdentity"]), episode["lineage"]["revision"])
        for change in [lambda e: e["records"].pop(), lambda e: e["records"][1].update(part_index=0),
                       lambda e: e["records"][1].update(policy_mask=False), lambda e: e["records"][0].update(payload="??")]:
            changed = copy.deepcopy(episode)
            change(changed)
            with self.assertRaises(ValueError):
                S.native_logical_digest(changed, values[3]["tokenizerIdentity"])
        context = {**original, "record_id": "semantic:context:1", "logical_id": "semantic:context:1", "role": "system", "policy_mask": False}
        episode["records"].insert(0, context)
        self.assertEqual(S.native_logical_digest(episode, values[3]["tokenizerIdentity"]), episode["lineage"]["revision"])
        context["policy_mask"] = True
        with self.assertRaisesRegex(ValueError, "Context transport"):
            S.native_logical_digest(episode, values[3]["tokenizerIdentity"])

    def test_source_native_component_union_refuses_a_cross_split_family(self):
        values = fixture()
        accepted, excluded, omissions = S.joined_inventory(*values)
        accepted[-1]["nativeResolvedFamily"] = accepted[0]["nativeResolvedFamily"]
        with self.assertRaisesRegex(ValueError, "crosses frozen splits"):
            S.make_sampler(values[0], values[1], values[3], {"maxFamilyTokens": 100, "maxFamilyShare": 1},
                           accepted, excluded, omissions, {})

    def test_derived_full_sampler_is_consumable_by_the_maintained_coverage_cli(self):
        values = fixture()
        accepted, excluded, omissions = S.joined_inventory(*values)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            S.write(root / "source.json", values[0])
            sampler = S.make_sampler(values[0], values[1], values[3], {"maxFamilyTokens": 4, "maxFamilyShare": .5},
                accepted, excluded, omissions, {"sourceManifestSha256": S.sha(root / "source.json")})
            S.write(root / "sampler.json", sampler)
            process = subprocess.run(["node", str(ROOT / "tools/select-native-prepared-coverage.mjs"),
                "--sampler", str(root / "sampler.json"), "--source-manifest", str(root / "source.json"),
                "--out", str(root / "coverage")], capture_output=True, text=True)
            self.assertEqual(process.returncode, 0, process.stderr)
            report = S.read(root / "coverage/coverage.json")
            self.assertEqual(report["evaluation"]["beforeEpisodeIds"], report["evaluation"]["afterEpisodeIds"])
            self.assertEqual(report["inventories"]["nativePrepared"]["episodes"], 4)
            self.assertEqual(report["inventories"]["consumed"]["status"], "unavailable")

    def test_sealed_sqlite_and_file_bindings_reject_missing_changed_or_active_inputs(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / "index.sqlite"
            with sqlite3.connect(path) as connection:
                connection.execute("CREATE TABLE episodes(episode_id TEXT PRIMARY KEY, entry_id INTEGER)")
                connection.execute("INSERT INTO episodes VALUES('actual-sqlite-row',0)")
            bound = S.file_binding(path)
            self.assertEqual(S.read_database(path, "SELECT * FROM episodes"), [{"episode_id": "actual-sqlite-row", "entry_id": 0}])
            S.check_bindings([bound])
            with sqlite3.connect(path) as connection:
                connection.execute("UPDATE episodes SET entry_id=1")
            with self.assertRaisesRegex(ValueError, "bytes changed"):
                S.check_bindings([bound])
            Path(str(path) + "-wal").write_bytes(b"unsealed")
            with self.assertRaisesRegex(ValueError, "unsealed journal"):
                S.read_database(path, "SELECT * FROM episodes")
            with self.assertRaisesRegex(ValueError, "Missing native"):
                S.read_database(root / "missing.sqlite", "SELECT * FROM episodes")
            for relative in ("../outside", "./index.sqlite", "/tmp/outside", "index.sqlite/../x"):
                with self.assertRaises(ValueError):
                    S.inside(root, relative)

    def test_early_manifest_binding_is_preserved_across_parsing_and_rebinding(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name in ("manifest.json", "semantic-report.json", "campaign.json"):
                path = root / name
                path.write_text('{"version":1}\n')
                bindings = {}
                parsed = S.read(S.bind_file(bindings, path))
                first = copy.deepcopy(bindings)
                self.assertEqual(parsed["version"], 1)
                path.write_text('{"version":2}\n')
                with self.assertRaisesRegex(ValueError, "bytes changed"):
                    S.bind_file(bindings, path)
                self.assertEqual(bindings, first, "A rebind cannot bless the later writer's bytes")
                with self.assertRaisesRegex(ValueError, "bytes changed"):
                    S.check_bindings(bindings.values())

    def test_document_export_uses_actual_campaign_store_and_refuses_a_missing_admission(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            campaign = root / "campaign"
            script = """
import {pathToFileURL} from 'node:url';
import {writeFileSync} from 'node:fs'; import {join} from 'node:path';
const {CampaignStore}=await import(pathToFileURL(process.argv[1]));
const {buildSourceRegistry,frozenSplitIdentity}=await import(pathToFileURL(process.argv[3]));
const registry=buildSourceRegistry([{id:'one',family:'family',source:'function run(a){return a+1;}'}]);
const splitIdentity=frozenSplitIdentity(registry,'family');
const store=new CampaignStore(process.argv[2],{producerRevision:'a'.repeat(40)});
store.record('one',{id:'one',family:'family'}, {status:'admitted',exported:{
 public:{original:'archived bytes'},sidecar:{admission:'admitted',taskId:'one',sourceFamily:'family',splitIdentity}}});
store.record('refused',{id:'refused',family:'family'}, {status:'unsupported',reason:'fixture refusal'});
store.close();
writeFileSync(join(process.argv[2],'manifest.json'),JSON.stringify({sourceRegistry:{digest:splitIdentity.registryDigest},
 cases:[{id:'one',split:splitIdentity.split,sourceCluster:splitIdentity.componentId}]}));
"""
            process = subprocess.run(["node", "--input-type=module", "-e", script,
                str(ROOT / "src/corpus/campaign-store.mjs"), str(campaign),
                str(ROOT / "src/corpus/source-registry.mjs")], capture_output=True, text=True)
            self.assertEqual(process.returncode, 0, process.stderr)
            output = root / "documents.jsonl"
            CLI.campaign_documents(campaign, ["one"], output)
            documents = [json.loads(line) for line in output.read_text().splitlines()]
            self.assertEqual(len(documents), 1)
            self.assertEqual(documents[0]["id"], "one")
            self.assertEqual(documents[0]["document"]["public"], {"original": "archived bytes"})
            self.assertEqual(documents[0]["document"]["sidecar"]["taskId"], "one")
            for identity in ("missing", "refused"):
                with self.assertRaisesRegex(ValueError, "Missing committed admitted document"):
                    CLI.campaign_documents(campaign, [identity], root / (identity + ".jsonl"))
            manifest = S.read(campaign / "manifest.json")
            manifest["sourceRegistry"]["digest"] = "0" * 64
            (campaign / "manifest.json").write_text(S.canonical(manifest))
            with self.assertRaisesRegex(ValueError, "Frozen registry/component identity"):
                CLI.campaign_documents(campaign, ["one"], root / "forged-registry.jsonl")


class StreamingAuditTests(unittest.TestCase):
    def test_streams_pretty_multibyte_rows_when_the_whole_file_exceeds_the_item_cap(self):
        rows = [{"name": "é🦊", "escaped": "\\\"}],[", "nested": [{"i": index}]} for index in range(50)]
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "audit.json"
            path.write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8")
            self.assertGreater(path.stat().st_size, 256)
            for chunk in (1, 7, 4096):
                self.assertEqual(list(S.iter_json_array(path, max_item_bytes=256, max_items=50, chunk_bytes=chunk)), rows)
            with self.assertRaisesRegex(ValueError, "declared row population"):
                list(S.iter_json_array(path, max_items=49))

    def test_byte_cap_and_invalid_structure_fail_without_a_partial_success(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "audit.json"
            row = {"unicode": "é" * 40}
            raw = S.canonical(row).encode()
            path.write_bytes(b"[" + raw + b"]")
            self.assertEqual(list(S.iter_json_array(path, max_item_bytes=len(raw), chunk_bytes=1)), [row])
            with self.assertRaisesRegex(ValueError, "item exceeds"):
                list(S.iter_json_array(path, max_item_bytes=len(raw) - 1, chunk_bytes=1))
            for raw in (b'{}', b'[{"a":1},]', b'[{"a":1}{"b":2}]', b'[{"a":1}]x', b'[{"a":1',
                        b'[{"a":1,"a":2}]', b'[{"a":NaN}]', b'[{"a":1e999}]', b'[0]', b'[{"a":"\xff"}]'):
                with self.subTest(raw=raw):
                    path.write_bytes(raw)
                    with self.assertRaises(ValueError):
                        list(S.iter_json_array(path, max_item_bytes=256, chunk_bytes=1))

    def test_compact_proofs_bind_all_supervision_without_retaining_witnesses(self):
        values = fixture()
        rows = [{key: copy.deepcopy(value) for key, value in proof.items() if key != "supervisionSha256"}
                for proof in values[6]]
        for row in rows:
            row["supervision"]["privateWitness"] = {"value": "original " * 20}
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            S.write(root / "audit.json", rows)
            proofs = S.read_audit_proofs(root / "audit.json", len(rows), root / "proofs.jsonl", max_item_bytes=4096)
            self.assertEqual(len(proofs), len(rows))
            self.assertEqual([json.loads(line) for line in (root / "proofs.jsonl").read_text().splitlines()], proofs)
            self.assertEqual(proofs[0]["supervisionSha256"], S.digest(rows[0]["supervision"]))
            self.assertNotIn("privateWitness", proofs[0]["supervision"])
            altered = copy.deepcopy(rows[0])
            altered["supervision"]["privateWitness"]["value"] = "changed"
            self.assertEqual(S.compact_audit_row(altered)["supervision"], proofs[0]["supervision"])
            self.assertNotEqual(S.compact_audit_row(altered)["supervisionSha256"], proofs[0]["supervisionSha256"])
            with self.assertRaisesRegex(ValueError, "population differs"):
                S.read_audit_proofs(root / "audit.json", len(rows) + 1)


if __name__ == "__main__":
    unittest.main()
