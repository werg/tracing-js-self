"""Controls for exact per-run policy custody in the combined qualification gate."""
from __future__ import annotations

import importlib.util
import copy
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("combined_v8_gate", ROOT / "tools/verify-combined-v8-gate.py")
gate = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(gate)


def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2) + "\n")


class RunPolicyTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.producer = self.root / "producer"
        self.native = self.root / "native"
        self.producer.mkdir()
        self.native.mkdir()
        self.declared_path = self.producer / "contracts/semantic-native-policy-v8.json"
        self.policy_path = self.root / "semantic-native-policy-v8.json"
        self.resolution_path = Path(str(self.policy_path) + ".resolution.json")
        self.revision = "b" * 40
        self.declared = {"schema": "semantic-native-policy/8", "consumerRepository": "werg/megatoken",
                         "contractDigest": gate.SPEC["contractDigest"],
                         "fixtureDigest": gate.SPEC["fixtureDigest"],
                         "interoperabilityDigest": gate.SPEC["interoperabilityDigest"],
                         "tokenizerSha256": "a" * 64}
        save(self.declared_path, self.declared)
        self.policy = {**self.declared, "consumerRevision": self.revision}
        save(self.policy_path, self.policy)
        self.resolution = {"schema": "semantic-native-resolution/1", "repository": "werg/megatoken",
                           "revision": self.revision, "kind": "matching-branch", "ref": "refs/heads/current",
                           "requestedBranch": "current", "declaredPolicySha256": gate.sha(self.declared_path)}
        save(self.resolution_path, self.resolution)

    def resolve(self, revision=None):
        return gate.run_policy(self.producer, self.policy_path, revision or self.revision)

    def test_actual_shared_resolver_output_is_accepted_without_mutating_the_declaration(self):
        self.policy_path.unlink()
        self.resolution_path.unlink()
        before = self.declared_path.read_bytes()
        environment = {key: value for key, value in os.environ.items()
                       if not key.startswith("GITHUB_") and key != "MEGATOKEN_REF"}
        environment["MEGATOKEN_REF"] = self.revision
        result = subprocess.run(["node", str(ROOT / "tools/resolve-native-consumer.mjs"),
                                 "--policy", str(self.declared_path), "--out", str(self.policy_path)],
                                env=environment, text=True, capture_output=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr)
        policy, bindings = self.resolve()
        self.assertEqual(policy, self.policy)
        self.assertEqual(bindings["policySha256"], gate.sha(self.policy_path))
        self.assertEqual(bindings["resolutionSha256"], gate.sha(self.resolution_path))
        self.assertEqual(bindings["declaredPolicySha256"], gate.sha(self.declared_path))
        self.assertEqual(self.declared_path.read_bytes(), before)

    def test_tracked_unresolved_policy_is_refused_without_a_key_error(self):
        save(self.policy_path, self.declared)
        with self.assertRaisesRegex(ValueError, "Run policy differs"):
            self.resolve()

    def test_chosen_revision_cannot_change_and_recorded_revision_cannot_be_overridden(self):
        with self.assertRaisesRegex(ValueError, "Run policy differs"):
            self.resolve("c" * 40)
        save(self.declared_path, {**self.declared, "consumerRevision": "c" * 40})
        with self.assertRaisesRegex(ValueError, "Recorded native revision cannot be overridden"):
            self.resolve()

    def test_non_revision_policy_fields_remain_bound_to_the_declaration(self):
        for key, value in (("consumerRepository", "other/repo"), ("contractDigest", "c" * 64),
                           ("tokenizerSha256", "d" * 64), ("extra", True)):
            with self.subTest(key=key):
                save(self.policy_path, {**self.policy, key: value})
                with self.assertRaisesRegex(ValueError, "Run policy differs"):
                    self.resolve()

    def test_resolution_authenticates_original_declaration_bytes(self):
        self.declared_path.write_text(json.dumps(self.declared) + "\n")
        with self.assertRaisesRegex(ValueError, "does not authenticate"):
            self.resolve()

    def test_resolution_changes_and_missing_resolution_are_refused(self):
        for key, value in (("schema", "other"), ("repository", "other/repo"), ("revision", "c" * 40),
                           ("declaredPolicySha256", "c" * 64), ("kind", "unknown"), ("ref", "HEAD")):
            with self.subTest(key=key):
                save(self.resolution_path, {**self.resolution, key: value})
                with self.assertRaisesRegex(ValueError, "authenticate|selection"):
                    self.resolve()
        self.resolution_path.unlink()
        with self.assertRaises(FileNotFoundError):
            self.resolve()

    def test_duplicate_keys_and_nonfinite_values_cannot_hide_in_resolution_evidence(self):
        original = self.resolution_path.read_text()
        for extra, message in ((f'"revision": "{self.revision}"', "Repeated gate JSON key"),
                               ('"extra": NaN', "Non-finite gate JSON number")):
            with self.subTest(extra=extra):
                self.resolution_path.write_text(original.rstrip()[:-1] + "," + extra + "}\n")
                with self.assertRaisesRegex(ValueError, message):
                    self.resolve()

    def test_each_lane_must_retain_exact_policy_and_resolution_bytes(self):
        lane = self.root / "lane"
        lane.mkdir()
        for suffix in ("", ".resolution.json"):
            shutil.copyfile(Path(str(self.policy_path) + suffix), lane / (self.policy_path.name + suffix))
        gate.retained_policy(lane, self.policy_path)
        for suffix in ("", ".resolution.json"):
            target = lane / (self.policy_path.name + suffix)
            original = target.read_bytes()
            target.write_bytes(original + b"\n")
            with self.assertRaisesRegex(ValueError, "Retained run policy or resolution bytes differ"):
                gate.retained_policy(lane, self.policy_path)
            target.write_bytes(original)

    def test_child_commands_use_the_attested_pair_despite_conflicting_caller_environment(self):
        args = SimpleNamespace(producer=self.producer, native=self.native, out=self.root / "lane",
                               native_policy=self.policy_path)
        foreign = {key: "/foreign" for key in ("RUNNER_TEMP", "SEMANTIC_V8_NATIVE_POLICY", "MEGATOKEN_ROOT",
                   "MEGATOKEN_PYTHON", "PYTHONPATH", "TRACING_JS_SELF_ROOT", "MEGATOKEN_NATIVE_SOURCE_PRODUCER",
                   "GIT_DIR", "GIT_WORK_TREE")}
        with patch.dict(os.environ, foreign):
            environment = gate.lane_environment(args)
        self.assertEqual(environment["RUNNER_TEMP"], str(args.out))
        self.assertEqual(environment["SEMANTIC_V8_NATIVE_POLICY"], str(self.policy_path))
        self.assertEqual(environment["MEGATOKEN_ROOT"], str(self.native))
        self.assertEqual(environment["MEGATOKEN_PYTHON"], gate.sys.executable)
        self.assertEqual(environment["PYTHONPATH"], str(self.native / "src"))
        self.assertEqual(environment["TRACING_JS_SELF_ROOT"], str(self.producer))
        self.assertEqual(environment["MEGATOKEN_NATIVE_SOURCE_PRODUCER"], str(self.producer))
        self.assertFalse(any(name.startswith("GIT_") for name in environment))

    def prepare_aggregate(self):
        producer_revision = "d" * 40
        policy, bindings = self.resolve()
        pair = {**bindings, "gateSpecSha256": gate.sha(gate.SPEC_PATH),
                "producer": {"revision": producer_revision, "tree": "e" * 40},
                "native": {"revision": self.revision, "tree": "f" * 40}}
        artifacts = self.root / "artifacts"
        for lane in ("one", "two"):
            root = artifacts / ("combined-v8-" + lane)
            root.mkdir(parents=True)
            for suffix in ("", ".resolution.json"):
                shutil.copyfile(Path(str(self.policy_path) + suffix), root / (self.policy_path.name + suffix))
            save(root / "pair-identity.json", {"installed": {"importMode": "isolated-installed-wheel"}})
            save(root / "lane-result.json", {"status": "passed", "lane": lane, "pair": pair,
                                             "files": [], "tests": {}, "controlledTraining": None})
        args = SimpleNamespace(producer=self.producer, producer_revision=producer_revision,
                               native_revision=self.revision, native_policy=self.policy_path,
                               artifacts=artifacts, out=self.root / "aggregate.json")

        def fake_git(_root, *arguments):
            return {("rev-parse", "HEAD"): producer_revision,
                    ("rev-parse", "HEAD^{tree}"): "e" * 40,
                    ("status", "--porcelain"): ""}[arguments]

        self.enterContext(patch.object(gate, "git", side_effect=fake_git))
        self.enterContext(patch.dict(gate.SPEC, {"lanes": {lane: {"producer": {}, "native": {}}
                                                        for lane in ("one", "two")}}))
        return args

    def test_aggregate_requires_the_same_external_policy_for_every_lane(self):
        args = self.prepare_aggregate()
        gate.aggregate(args)
        self.assertEqual(gate.read(args.out)["status"], "passed")
        args.out.unlink()
        changed = args.artifacts / "combined-v8-two/lane-result.json"
        report = gate.read(changed)
        report["pair"]["native"]["revision"] = "c" * 40
        save(changed, report)
        with self.assertRaisesRegex(ValueError, "another native policy"):
            gate.aggregate(args)

    def test_aggregate_rejects_a_rehashed_different_resolution(self):
        args = self.prepare_aggregate()
        lane = args.artifacts / "combined-v8-two"
        resolution = lane / (self.policy_path.name + ".resolution.json")
        save(resolution, {**self.resolution, "requestedBranch": "other", "ref": "refs/heads/other"})
        report_path = lane / "lane-result.json"
        report = gate.read(report_path)
        report["pair"]["resolutionSha256"] = gate.sha(resolution)
        save(report_path, report)
        with self.assertRaisesRegex(ValueError, "Lane policy or resolution bytes differ"):
            gate.aggregate(args)

    def test_compressed_source_payload_is_compared_to_decoded_native_payload(self):
        import base64
        import gzip

        raw = b'{"cases":[{"id":"retained-source"}]}\n'
        native_path = self.native / "fixture.gz.b64"
        native_path.write_bytes(base64.b64encode(gzip.compress(raw, mtime=0)))
        source_path = self.producer / "fixture.gz.b64"
        source_path.write_bytes(base64.b64encode(gzip.compress(raw, mtime=1)))
        rows = [{"source": source_path.name, "native": native_path.name,
                 "encoding": "gzip-base64", "sourceEncoding": "gzip-base64",
                 "nativeSha256": gate.sha(native_path)} for _ in range(7)]
        with patch.dict(gate.SPEC, {"payloads": rows}):
            self.assertEqual(len(gate.payload_parity(self.producer, self.native)), 7)
            source_path.write_bytes(base64.b64encode(gzip.compress(raw + b" ", mtime=1)))
            with self.assertRaisesRegex(ValueError, "Paired payload differs"):
                gate.payload_parity(self.producer, self.native)

    def test_review_packets_bind_successful_native_receipts_to_contexts_and_retained_owners(self):
        names = ["promise-object-review-source-evidence.json", "promise-object-review-protocol-evidence.json"]
        originals = []
        for name, counts, population, artifact_key in (
            (names[0], [21, 38, 23, 19, 23, 32, 20, 20], "sourceCases", "exported"),
            (names[1], [13, 17], "publicCases", "artifact"),
        ):
            cases, receipts = [], []
            for index, count in enumerate(counts):
                identity = "case-" + str(index)
                artifact = {"contexts": [{} for _ in range(count)], "public": {"timeline": [
                    {"kind": "invocation", "fields": {"invocationId": owner}} for owner in ["first", "second"]]}}
                cases.append({"name": identity, artifact_key: artifact, "states": [["first", {}], ["second", {}]]})
                receipts.append({"name": identity, "counts": {"contexts": count}, "admitted": False,
                                 "checks": {key: "passed" for key in ["replay", "contexts", "continuation"]},
                                 "checkedOwners": ["first", "second"]})
            packet = {population: len(counts), "actualNativeCases": len(counts), "cases": cases,
                      "nativeReceipts": receipts, "trainingAdmission": False, "moduleAdmission": False,
                      "optimizerUpdates": 0, "generatedContexts": sum(counts)}
            if population == "sourceCases":
                packet["checkpointCases"], packet["checkpointNativeReceipts"] = [], []
                for identity, count in [("promise-review-checkpoint-ordinary", 9),
                                        ("promise-review-checkpoint-constructor-getter", 28)]:
                    packet["checkpointCases"].append({"name": identity, "exported": {
                        "contexts": [{} for _ in range(count)],
                        "public": {"timeline": [{"mode": "generated"} for _ in range(count)]},
                        "sidecar": {"compiler": {"checkpoints": [
                            {"publicReplayValidated": True, "nativeRedispatches": 0}]}}}})
                    packet["checkpointNativeReceipts"].append({"name": identity, "admitted": False,
                        "counts": {"contexts": count},
                        "checks": {key: "passed" for key in ["replay", "contexts", "continuation"]}})
            originals.append(packet)
            save(self.root / name, packet)
        verified = gate.verify_review_promise_packets(self.root)
        self.assertEqual([row["contexts"] for row in verified], [196, 30])
        self.assertEqual(verified[0]["checkpoints"], {"cases": 2, "actualNativeCases": 2, "contexts": 37})
        for index, mutation, message in (
            (0, lambda p: p["nativeReceipts"][0]["checks"].update(replay="failed"), "did not pass"),
            (0, lambda p: p["nativeReceipts"][0].update(admitted=True), "did not pass"),
            (0, lambda p: p["nativeReceipts"][0].update(name="unrelated"), "identity differs"),
            (0, lambda p: p["nativeReceipts"].pop(), "identity differs"),
            (1, lambda p: p["nativeReceipts"][0]["counts"].update(contexts=17), "context population differs"),
            (1, lambda p: p["nativeReceipts"][0].update(checkedOwners=["first", "unrelated"]), "invocation identity differs"),
            (0, lambda p: p["checkpointNativeReceipts"][0].update(name="unrelated"), "checkpoint source/native identity differs"),
            (0, lambda p: p["checkpointNativeReceipts"].pop(), "checkpoint source/native identity differs"),
            (0, lambda p: p["checkpointNativeReceipts"][0]["counts"].update(contexts=28), "checkpoint native context population differs"),
            (0, lambda p: p["checkpointCases"][0]["exported"]["contexts"].pop(), "checkpoint native context population differs"),
            (0, lambda p: p["checkpointNativeReceipts"][0]["checks"].update(continuation="failed"), "checkpoint native replay, contexts or continuation did not pass"),
            (0, lambda p: p["checkpointNativeReceipts"][0].update(admitted=True), "checkpoint native replay, contexts or continuation did not pass"),
            (0, lambda p: p["checkpointCases"][0]["exported"]["sidecar"]["compiler"]["checkpoints"][0].update(nativeRedispatches=1), "first-await checkpoint boundary differs"),
        ):
            with self.subTest(packet=names[index], rejection=message):
                changed = copy.deepcopy(originals[index]);mutation(changed);save(self.root / names[index], changed)
                with self.assertRaisesRegex(ValueError, message):
                    gate.verify_review_promise_packets(self.root)
                save(self.root / names[index], originals[index])


if __name__ == "__main__":
    unittest.main()
