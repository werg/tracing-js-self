"""Actual archive/lock/refusal controls; no source or model qualification credit."""
from __future__ import annotations

import fcntl
import importlib.util
import io
import json
import os
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("release_v8_under_test", ROOT / "tools/semantic_release_v8.py")
release = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(release)


class DirectV8ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="direct-v8-release-test-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)

    def snapshot(self):
        return {"producerRevision": "a" * 40, "nativePolicy": {"consumerRevision": "b" * 40},
                "contractDigest": "1" * 64, "fixtureDigest": "2" * 64, "interoperabilityDigest": "3" * 64,
                "selectedCaseIds": ["selected"], "cases": [
                    {"id": "selected", "selected": True, "status": "admitted", "source": "passed", "native": "passed",
                     "admittedArtifact": "selected.admitted.json"},
                    {"id": "untested", "selected": False, "status": "untested", "source": "untested", "native": "untested"},
                ]}

    def recipe(self):
        return {"codec": "/original/tokenizer.json", "datasets": ["/original/prepared"],
                "output": "/original/checkpoints", "seed": 41, "gradient_checkpointing": False,
                "semantic_v8_policy": {"schema": "controlled-fixture"}}

    def make_archive(self):
        payload = self.root / "payload"
        payload.mkdir()
        for name in (release.DESCRIPTOR, release.CAMPAIGN, release.NATIVE, release.ENVIRONMENT,
                     release.ORIGINAL_RECIPE, release.NORMALIZATION, release.ROLES["recipe"]):
            path = payload / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps({"controlledFixture": name}) + "\n")
        hidden = payload / "source-qualification/progress/.campaign.lock"
        hidden.parent.mkdir(parents=True)
        hidden.write_bytes(b"")
        rows, sources = release.bundle_inventory(payload)
        by_name = {row["path"]: row for row in rows}
        producer = {"revision": "a" * 40, "tree": "b" * 40, "clean": True}
        manifest = {
            "schema": release.SCHEMA, "profile": release.PROFILE, "producer": producer, "consumer": producer,
            "descriptor": release.DESCRIPTOR, "descriptorSha256": by_name[release.DESCRIPTOR]["sha256"],
            "qualification": {"controlledFixture": True},
            "nativeVerification": {"path": release.NATIVE, **release.archive.file_receipt(payload / release.NATIVE),
                                   "summary": {"controlledFixture": True}},
            "environment": {"path": release.ENVIRONMENT, **release.archive.file_receipt(payload / release.ENVIRONMENT)},
            "implementations": {}, "files": rows, "limits": release.archive.DEFAULT_LIMITS,
            "scope": "Controlled archive fixture; source/native/model qualification is absent",
            "optimizerUpdatesPerformed": 0, "decoderForwardPassesPerformed": 0,
            "learnedSuccess": None, "defaultPromotion": False,
        }
        path = self.root / "release.tar.gz"
        result = release.archive.write_archive(path, manifest, sources)
        return path, result, payload

    def test_exact_archive_bytes_and_hidden_lock_restore_without_legacy_code(self):
        path, manifest, payload = self.make_archive()
        digest = release.archive.file_receipt(path)["sha256"]
        verified = release.verified_archive(path, digest)
        destination = self.root / "restored"
        receipt = release.archive.extract_verified(path, destination, verified)
        self.assertEqual(receipt["files"], len(manifest["files"]))
        self.assertEqual(release.archive.verify_restored_files(destination, verified), receipt)
        for row in manifest["files"]:
            self.assertEqual((destination / row["path"]).read_bytes(), (payload / row["path"]).read_bytes())
        self.assertTrue((destination / "source-qualification/progress/.campaign.lock").is_file())

    def test_external_archive_pin_is_checked_before_manifest_or_extraction(self):
        path, _, _ = self.make_archive()
        with (patch.object(release.archive, "bounded_inventory", side_effect=AssertionError("must not read")),
              self.assertRaisesRegex(ValueError, "external SHA-256")):
            release.verified_archive(path, "0" * 64)

    def test_archive_cannot_qualify_a_legacy_manifest(self):
        _, manifest, _ = self.make_archive()
        manifest["schema"] = "semantic-release/1"
        with self.assertRaisesRegex(ValueError, "direct V8"):
            release.validate_manifest(manifest)

    def test_changed_extracted_member_bytes_are_detected_without_repair(self):
        path, _, _ = self.make_archive()
        verified = release.verified_archive(path, release.archive.file_receipt(path)["sha256"])
        destination = self.root / "restored"
        release.archive.extract_verified(path, destination, verified)
        changed = destination / release.NATIVE
        changed.write_bytes(changed.read_bytes() + b"changed")
        before = changed.read_bytes()
        with self.assertRaisesRegex(ValueError, "inventory or bytes changed"):
            release.archive.verify_restored_files(destination, verified)
        self.assertEqual(changed.read_bytes(), before)

    def test_link_member_and_traversal_refuse_even_with_matching_outer_checksum(self):
        for name, link in (("../escaped", False), ("link", True)):
            with self.subTest(name=name):
                path = self.root / ("link.tar.gz" if link else "traversal.tar.gz")
                with tarfile.open(path, "w:gz") as archive:
                    member = tarfile.TarInfo(name)
                    if link:
                        member.type, member.linkname = tarfile.SYMTYPE, "/outside"
                    else:
                        member.size = 1
                    archive.addfile(member, None if link else io.BytesIO(b"x"))
                with self.assertRaises(ValueError):
                    release.verified_archive(path, release.archive.file_receipt(path)["sha256"])
        self.assertFalse((self.root.parent / "escaped").exists())

    def test_original_and_copied_inputs_are_byte_exact_and_substitution_refuses(self):
        original = self.root / "original.bin"
        original.write_bytes(b"committed checkpoint\x00")
        rows, sources = release.inventory({"training/checkpoint/state.pt": original})
        destination = self.root / "copy"
        destination.mkdir()
        release.copy_inputs(rows, sources, destination)
        self.assertEqual((destination / rows[0]["path"]).read_bytes(), original.read_bytes())
        original.write_bytes(b"substitute payload!\x00\x00")
        second = self.root / "second"
        second.mkdir()
        with self.assertRaisesRegex(ValueError, "differs from the initial inventory|changed type or size"):
            release.copy_inputs(rows, sources, second)

    def test_resealed_manifest_duplicate_authority_refuses(self):
        path, _, _ = self.make_archive()
        replacement = self.root / "duplicate.tar.gz"
        with tarfile.open(path, "r:gz") as original, tarfile.open(replacement, "w:gz") as changed:
            for member in original:
                data = original.extractfile(member).read()
                if member.name == "release-manifest.json":
                    data = data.replace(b'{\n', b'{\n  "schema": "earlier-false-authority",\n', 1)
                    member.size = len(data)
                changed.addfile(member, io.BytesIO(data))
        with self.assertRaisesRegex(ValueError, "Repeated release JSON key"):
            release.verified_archive(replacement, release.archive.file_receipt(replacement)["sha256"])

    def test_boolean_optimizer_count_cannot_replace_integer_zero(self):
        _, manifest, _ = self.make_archive()
        manifest["optimizerUpdatesPerformed"] = False
        with self.assertRaisesRegex(ValueError, "fixed profile"):
            release.validate_manifest(manifest)

    def test_symbolic_link_ancestor_and_fifo_refuse_before_copy(self):
        real = self.root / "real"
        real.mkdir()
        (real / "asset").write_bytes(b"x")
        (self.root / "alias").symlink_to(real, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, "symbolic links"):
            release.existing(self.root / "alias/asset", directory=False)
        os.mkfifo(real / "pipe")
        with self.assertRaisesRegex(ValueError, "link or special"):
            release.inventory({"role": real})

    def test_caller_cannot_hide_multiple_prepared_roots_by_relocating_recipe(self):
        raw = self.recipe()
        raw["datasets"].append("/other/empty-root")
        with self.assertRaisesRegex(ValueError, "exactly one"):
            release.portable_recipe(raw)

    def test_recipe_preserves_every_nonlocator_field_and_original_bytes(self):
        raw = self.recipe()
        recipe, receipt = release.portable_recipe(raw)
        self.assertEqual(raw["codec"], "/original/tokenizer.json")
        self.assertEqual(recipe["seed"], 41)
        self.assertIs(recipe["gradient_checkpointing"], False)
        for name, value in ((release.ORIGINAL_RECIPE, raw), (release.ROLES["recipe"], recipe), (release.NORMALIZATION, receipt)):
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            release.archive.write_json(path, value)
        before = (self.root / release.ORIGINAL_RECIPE).read_bytes()
        release.verify_recipe(self.root)
        recipe["gradient_checkpointing"] = 0
        (self.root / release.ROLES["recipe"]).write_text(json.dumps(recipe))
        with self.assertRaisesRegex(ValueError, "beyond its three"):
            release.verify_recipe(self.root)
        self.assertEqual((self.root / release.ORIGINAL_RECIPE).read_bytes(), before)

    def test_unqualified_selected_source_cannot_be_dropped_from_release_membership(self):
        snapshot = self.snapshot()
        snapshot["cases"][0]["native"] = "untested"
        with self.assertRaisesRegex(ValueError, "Every selected"):
            release.descriptor_from_campaign(snapshot, {"revision": "a" * 40}, {"revision": "b" * 40})

    def test_complete_selection_and_source_pair_authorize_only_the_selected_artifacts(self):
        snapshot = self.snapshot()
        descriptor = release.descriptor_from_campaign(snapshot, {"revision": "a" * 40}, {"revision": "b" * 40})
        self.assertEqual(descriptor["roles"]["prepared"][0]["sourceArtifacts"], [
            {"caseId": "selected", "path": "source-qualification/selected.admitted.json"}])
        with self.assertRaisesRegex(ValueError, "another source pair"):
            release.descriptor_from_campaign(snapshot, {"revision": "c" * 40}, {"revision": "b" * 40})

    def test_active_writer_and_missing_lock_refuse_without_creating_lock(self):
        qualification = self.root / "campaign"
        (qualification / "progress").mkdir(parents=True)
        lock = qualification / "progress/.campaign.lock"
        with self.assertRaisesRegex(ValueError, "lock is missing"), release.locked_campaign(qualification):
            self.fail("missing original lock was accepted")
        self.assertFalse(lock.exists())
        lock.write_bytes(b"")
        with lock.open("rb") as writer:
            fcntl.flock(writer, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaisesRegex(ValueError, "active writer"), release.locked_campaign(qualification):
                self.fail("writer lock was ignored")
        with release.locked_campaign(qualification):
            self.assertEqual(lock.read_bytes(), b"")

    def test_strict_json_refuses_duplicate_authority_and_nonfinite_values(self):
        for raw in ('{"status":"failed","status":"passed"}', '{"x":NaN}', '{"x":Infinity}'):
            with self.subTest(raw=raw), self.assertRaises(ValueError):
                release.strict_json(raw)
        self.assertFalse(release.same_json({"x": False}, {"x": 0}))

    def test_new_output_and_restore_destinations_never_replace_existing_paths(self):
        occupied = self.root / "existing"
        occupied.mkdir()
        marker = occupied / "must-remain"
        marker.write_bytes(b"owned")
        with self.assertRaisesRegex(ValueError, "new directory"):
            release.new_directory(occupied)
        self.assertEqual(marker.read_bytes(), b"owned")
        with self.assertRaisesRegex(ValueError, "disjoint"):
            release.new_directory(occupied / "nested", excluded=[occupied])

    def test_wrappers_import_in_fresh_process_without_any_legacy_file(self):
        isolated = self.root / "isolated/tools"
        isolated.mkdir(parents=True)
        for name in ("package-semantic-release-v8.py", "restore-semantic-release-v8.py",
                     "semantic_release_v8.py", "release_archive.py"):
            shutil.copyfile(ROOT / "tools" / name, isolated / name)
        for mode in ("package", "restore"):
            result = subprocess.run([sys.executable, str(isolated / (mode + "-semantic-release-v8.py")), "--help"],
                                    capture_output=True, text=True, check=False, timeout=30)
            self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse((isolated / "package-semantic-release.py").exists())
        with (isolated / "release_archive.py").open("a") as handle:
            handle.write('\nraise RuntimeError("unchecked helper executed")\n')
        result = subprocess.run([sys.executable, str(isolated / "restore-semantic-release-v8.py"), "--help"],
                                capture_output=True, text=True, check=False, timeout=30)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Pinned neutral", result.stderr)
        self.assertNotIn("RuntimeError: unchecked", result.stderr)


if __name__ == "__main__":
    unittest.main()
