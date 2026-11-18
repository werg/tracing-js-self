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
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))
import native_prepared_sampler as S

SPEC = importlib.util.spec_from_file_location("sampler_cli", ROOT / "tools/derive-native-prepared-sampler.py")
CLI = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CLI)


def fixture():
    policy = {"consumerRevision": "b" * 40, "tokenizerIdentity": "c" * 64, "tokenizerSha256": "d" * 64}
    rows, indexed, cases = [], [], []
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
    omitted = copy.deepcopy(cases[0])
    omitted["id"] = "upstream-budget-omission"
    cases.extend([omitted, {"id": "unsupported", "status": "unsupported", "family": "unsupported"}])
    source = {"schema": "semantic-corpus-manifest/4", "producerRevision": "a" * 40,
        "campaign": {"identityDigest": "e" * 64}, "sourceRegistry": {"digest": "f" * 64}, "cases": cases}
    prepared = {"complete": True, "codec_fingerprint": policy["tokenizerIdentity"], "fingerprint": "1" * 64,
        "census": {"accepted_episodes": 4, "duplicates": 1, "quarantined": 0},
        "counts": {"*": 4, "split:train": 2, "split:validation": 1, "split:test": 1}}
    native = {"schema": "semantic-preparation/4", "producerRevision": source["producerRevision"],
        "consumerRevision": policy["consumerRevision"], "tokenizerIdentity": policy["tokenizerIdentity"],
        "refusals": [], "counts": {"admitted": 5, "attempted": 5}, "accepted": 4}
    return source, prepared, native, policy, rows, indexed


class InventoryTests(unittest.TestCase):
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
            (lineage("task_id", "foreign-candidate"), "candidate join"),
            (lineage("task_id", "train-b"), "family or frozen split"),
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


if __name__ == "__main__":
    unittest.main()
