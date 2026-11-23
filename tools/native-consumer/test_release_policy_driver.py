"""Run-policy controls; no source, native admission, or model qualification credit."""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("release_policy_driver", ROOT / "tools/qualify-v8-release.py")
qualifier = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(qualifier)


class StopBeforeQualification(RuntimeError):
    pass


class ReleasePolicyDriverTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.path = self.root / "declared.json"
        self.revision = "a" * 40
        self.declared = {
            "schema": "semantic-native-policy/8",
            "consumerRepository": "werg/megatoken",
            "contractDigest": "b" * 64,
            "tokenizerIdentity": "fixture-tokenizer",
            "tokenizerSha256": hashlib.sha256(b"tokenizer").hexdigest(),
        }
        self.save()

    def save(self):
        self.path.write_text(json.dumps(self.declared, indent=3) + "\n")

    def test_unpinned_declaration_records_selected_checkout_and_exact_original_bytes(self):
        original = self.path.read_bytes()
        policy, declared, resolution = qualifier.resolve_native_policy(self.path, self.revision)
        self.assertEqual(declared, original)
        self.assertEqual(self.path.read_bytes(), original)
        self.assertEqual(policy, {**self.declared, "consumerRevision": self.revision})
        self.assertNotIn("consumerRevision", self.declared)
        self.assertEqual(resolution, {
            "schema": "semantic-native-resolution/1", "repository": "werg/megatoken",
            "requestedBranch": None, "ref": self.revision, "revision": self.revision,
            "kind": "selected-checkout", "declaredPolicySha256": hashlib.sha256(original).hexdigest(),
        })

    def test_explicit_recorded_policy_keeps_its_revision(self):
        self.declared["consumerRevision"] = self.revision
        self.save()
        policy, declared, resolution = qualifier.resolve_native_policy(self.path, self.revision)
        self.assertEqual(policy, self.declared)
        self.assertEqual(declared, self.path.read_bytes())
        self.assertEqual(resolution["kind"], "recorded-revision")

    def test_recorded_revision_cannot_be_relabelled_to_another_checkout(self):
        self.declared["consumerRevision"] = "c" * 40
        self.save()
        with self.assertRaisesRegex(ValueError, "differs from its exact recorded revision"):
            qualifier.resolve_native_policy(self.path, self.revision)

    def test_malformed_explicit_revision_is_not_treated_as_unpinned(self):
        for value in (None, "", "HEAD", "A" * 40, 123):
            with self.subTest(value=value):
                self.declared["consumerRevision"] = value
                self.save()
                with self.assertRaisesRegex(ValueError, "invalid recorded consumer revision"):
                    qualifier.resolve_native_policy(self.path, self.revision)

    def test_non_revision_checkout_identity_is_refused(self):
        for value in (None, "HEAD", "a" * 39):
            with self.subTest(value=value):
                with self.assertRaisesRegex(ValueError, "exact native checkout revision"):
                    qualifier.resolve_native_policy(self.path, value)

    def test_wrong_schema_or_repository_is_refused(self):
        for key, value in (("schema", "semantic-native-policy/6"), ("consumerRepository", "other/repository")):
            with self.subTest(key=key):
                original = self.declared[key]
                self.declared[key] = value
                self.save()
                with self.assertRaisesRegex(ValueError, "current independent native consumer policy"):
                    qualifier.resolve_native_policy(self.path, self.revision)
                self.declared[key] = original

    def test_duplicate_revision_keys_are_refused(self):
        self.path.write_text(json.dumps(self.declared)[:-1] +
                             ', "consumerRevision": "' + self.revision +
                             '", "consumerRevision": "' + "c" * 40 + '"}')
        with self.assertRaisesRegex(ValueError, "Repeated qualification JSON key"):
            qualifier.resolve_native_policy(self.path, self.revision)

    def repositories(self, qualification_script=None):
        producer, native = self.root / "producer", self.root / "native"
        for repo in (producer, native):
            repo.mkdir()
            subprocess.run(["git", "init", "--quiet", str(repo)], check=True)
        (producer / "contracts").mkdir()
        (producer / "contracts/semantic-native-policy-v8.json").write_bytes(self.path.read_bytes())
        if qualification_script is not None:
            (producer / "tools").mkdir()
            (producer / "tools/qualify-semantic-v8.mjs").write_text(qualification_script)
        (native / "implementation.py").write_text("# controlled checkout\n")
        for repo in (producer, native):
            subprocess.run(["git", "-C", str(repo), "add", "."], check=True)
            subprocess.run(["git", "-C", str(repo), "-c", "user.name=Fixture",
                            "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture"], check=True)
        tokenizer = self.root / "tokenizer.json"
        tokenizer.write_bytes(b"tokenizer")
        return producer, native, tokenizer

    def test_default_driver_snapshots_policy_and_passes_it_to_the_first_stage(self):
        producer, native, tokenizer = self.repositories()
        output = self.root / "qualification"
        args = argparse.Namespace(megatoken=native, tokenizer=tokenizer, out=output,
                                  native_policy=None, python="python3")
        real_popen, launched = subprocess.Popen, []

        def launch(command, **kwargs):
            if command[0] == "node":
                launched.append((command, kwargs))
                raise StopBeforeQualification
            return real_popen(command, **kwargs)

        with patch.object(qualifier, "__file__", str(producer / "tools/qualify-v8-release.py")), \
                patch.object(qualifier.subprocess, "Popen", side_effect=launch):
            # Mock only the expensive semantic subprocess, after the real git,
            # clean-source, output-boundary, tokenizer, and policy checks.
            with self.assertRaises(StopBeforeQualification):
                qualifier.qualify(args)
        policy_path = output / "semantic-native-policy-v8.json"
        policy = json.loads(policy_path.read_bytes())
        self.assertEqual(policy["consumerRevision"], qualifier.git(native, "rev-parse", "HEAD"))
        self.assertEqual((output / "declared-native-policy-v8.json").read_bytes(), self.path.read_bytes())
        self.assertTrue((output / "semantic-native-policy-v8.json.resolution.json").is_file())
        self.assertEqual(len(launched), 1)
        command, kwargs = launched[0]
        self.assertEqual(command[command.index("--native-policy") + 1], str(policy_path))
        self.assertEqual(kwargs["env"]["SEMANTIC_V8_NATIVE_POLICY"], str(policy_path))
        (output / "original-inputs").rename(output / "retained-originals")
        self.assertTrue(policy_path.is_file(), "Policy must survive original-input relocation")

    def test_driver_refuses_wrong_supplied_pin_before_creating_output(self):
        producer, native, tokenizer = self.repositories()
        self.declared["consumerRevision"] = "c" * 40
        self.save()
        output = self.root / "qualification"
        args = argparse.Namespace(megatoken=native, tokenizer=tokenizer, out=output,
                                  native_policy=self.path, python="python3")
        with patch.object(qualifier, "__file__", str(producer / "tools/qualify-v8-release.py")):
            with self.assertRaisesRegex(ValueError, "differs from its exact recorded revision"):
                qualifier.qualify(args)
        self.assertFalse(output.exists())

    def test_driver_preserves_supplied_pinned_policy_bytes_exactly(self):
        producer, native, tokenizer = self.repositories()
        self.declared["consumerRevision"] = qualifier.git(native, "rev-parse", "HEAD")
        self.save()
        original = self.path.read_bytes()
        output = self.root / "qualification"
        args = argparse.Namespace(megatoken=native, tokenizer=tokenizer, out=output,
                                  native_policy=self.path, python="python3")
        real_popen = subprocess.Popen

        def launch(command, **kwargs):
            if command[0] == "node":
                raise StopBeforeQualification
            return real_popen(command, **kwargs)

        with patch.object(qualifier, "__file__", str(producer / "tools/qualify-v8-release.py")), \
                patch.object(qualifier.subprocess, "Popen", side_effect=launch):
            with self.assertRaises(StopBeforeQualification):
                qualifier.qualify(args)
        self.assertEqual((output / "semantic-native-policy-v8.json").read_bytes(), original)
        self.assertEqual((output / "declared-native-policy-v8.json").read_bytes(), original)
        resolution = qualifier.read(output / "semantic-native-policy-v8.json.resolution.json")
        self.assertEqual(resolution["kind"], "recorded-revision")

    def test_driver_refuses_stage_mutation_or_deletion_of_every_policy_evidence_asset(self):
        producer, native, tokenizer = self.repositories("""
import {appendFileSync, unlinkSync} from 'node:fs';
import {dirname, join} from 'node:path';
const file = join(dirname(process.env.SEMANTIC_V8_NATIVE_POLICY), process.env.QUALIFICATION_TAMPER_FILE);
if (process.env.QUALIFICATION_TAMPER_DELETE === '1') unlinkSync(file);
else appendFileSync(file, '\\n');
""")
        for name in ("declared-native-policy-v8.json", "semantic-native-policy-v8.json",
                     "semantic-native-policy-v8.json.resolution.json"):
            for delete in (False, True):
                with self.subTest(name=name, delete=delete):
                    output = self.root / (name + ("-delete" if delete else "-mutate"))
                    args = argparse.Namespace(megatoken=native, tokenizer=tokenizer, out=output,
                                              native_policy=None, python="python3")
                    with patch.object(qualifier, "__file__", str(producer / "tools/qualify-v8-release.py")), \
                            patch.dict(os.environ, {"QUALIFICATION_TAMPER_FILE": name,
                                                    "QUALIFICATION_TAMPER_DELETE": "1" if delete else "0"}):
                        with self.assertRaisesRegex(ValueError, "Retained run policy evidence changed"):
                            qualifier.qualify(args)
                    stages = qualifier.read(output / "stages.json")
                    self.assertEqual(len(stages), 1)
                    self.assertEqual(stages[0]["exitCode"], 0)
                    self.assertEqual(stages[0]["status"], "failed")
                    self.assertFalse((output / "qualification-result.json").exists())


if __name__ == "__main__":
    unittest.main()
