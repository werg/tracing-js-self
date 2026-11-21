"""Bounded archive restoration; no native model or fresh-host claim."""
import importlib.util
import io
import json
import subprocess
import tarfile
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

spec = importlib.util.spec_from_file_location("release_restore", Path(__file__).parents[1] / "restore-semantic-release.py")
restore = importlib.util.module_from_spec(spec)
spec.loader.exec_module(restore)
release = restore.release


class ReleaseRestoreTests(unittest.TestCase):
    def archive(self, root, value=b'{"preserved":true}\n', name="release.tar.gz"):
        source = root / (name + ".source")
        source.mkdir()
        (source / "episode.json").write_bytes(value)
        rows, sources = release.inventory({"corpus": source})
        archive = root / name
        release.write_archive(archive, {"schema": "semantic-private-release/1", "producerRevision": "a" * 40,
                                       "files": rows}, sources)
        return archive

    def raw_archive(self, path, members):
        with tarfile.open(path, "w:gz") as archive:
            for name, data, kind in members:
                info = tarfile.TarInfo(name)
                info.type = kind
                info.size = len(data) if kind == tarfile.REGTYPE else 0
                info.linkname = "../outside"
                archive.addfile(info, io.BytesIO(data) if kind == tarfile.REGTYPE else None)

    def verified(self, archive, limits=None):
        return restore.verify_before_restore(archive, release.file_receipt(archive)["sha256"],
                                             limits or restore.DEFAULT_LIMITS)

    def test_roundtrip_preserves_all_bytes_and_rejects_reuse(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            archive = self.archive(root)
            verified = self.verified(archive)
            destination = root / "new"
            result = restore.extract_verified(archive, destination, verified)
            self.assertEqual(result["status"], "verified")
            self.assertEqual(result["files"], 1)
            self.assertEqual((destination / "corpus/episode.json").read_bytes(), b'{"preserved":true}\n')
            self.assertEqual((destination / "corpus/episode.json").stat().st_mode & 0o777, 0o600)
            with self.assertRaisesRegex(ValueError, "new directory"):
                restore.extract_verified(archive, destination, verified)
            (destination / "corpus/episode.json").write_text("changed")
            with self.assertRaisesRegex(ValueError, "bytes changed"):
                restore.verify_restored_files(destination, verified)

    def test_traversal_links_duplicates_and_special_members_are_rejected(self):
        cases = [("../outside", tarfile.REGTYPE), ("/absolute", tarfile.REGTYPE),
                 ("a//b", tarfile.REGTYPE), ("a\\b", tarfile.REGTYPE),
                 ("link", tarfile.SYMTYPE), ("hard", tarfile.LNKTYPE), ("fifo", tarfile.FIFOTYPE)]
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for index, (name, kind) in enumerate(cases):
                with self.subTest(name=name):
                    archive = root / (str(index) + ".tar.gz")
                    self.raw_archive(archive, [(name, b"bad", kind)])
                    with self.assertRaises(ValueError):
                        self.verified(archive)
            duplicate = root / "duplicate.tar.gz"
            self.raw_archive(duplicate, [("a", b"one", tarfile.REGTYPE), ("a", b"two", tarfile.REGTYPE)])
            with self.assertRaisesRegex(ValueError, "duplicate"):
                self.verified(duplicate)
            self.assertFalse((root.parent / "outside").exists())

    def test_corrupted_inventory_fails_before_any_original_producer_execution(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            archive = self.archive(root)
            manifest = (root / "release-manifest.json").read_bytes()
            self.raw_archive(archive, [("corpus/episode.json", b'{"preserved":false}\n', tarfile.REGTYPE),
                                       ("release-manifest.json", manifest, tarfile.REGTYPE)])
            args = SimpleNamespace(archive=archive, out=root / "restore", tracer_root=root,
                archive_sha256=release.file_receipt(archive)["sha256"], limits=restore.DEFAULT_LIMITS)
            with mock.patch.object(restore, "producer_identity") as producer, mock.patch.object(restore, "run_logged") as execute:
                with self.assertRaisesRegex(ValueError, "checksum changed"):
                    restore.restore_release(args)
                producer.assert_not_called()
                execute.assert_not_called()
            self.assertFalse(args.out.exists())

    def test_wrong_archive_pin_and_change_after_verification_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            archive = self.archive(root)
            with self.assertRaisesRegex(ValueError, "expected SHA-256"):
                restore.verify_before_restore(archive, "0" * 64)
            verified = self.verified(archive)
            changed = self.archive(root, value=b"changed", name="changed.tar.gz")
            archive.write_bytes(changed.read_bytes())
            with self.assertRaisesRegex(ValueError, "changed after verification"):
                restore.extract_verified(archive, root / "new", verified)
            self.assertFalse((root / "new").exists())

    def test_each_expansion_limit_is_enforced(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            archive = self.archive(root)
            for key in restore.DEFAULT_LIMITS:
                with self.subTest(key=key):
                    with self.assertRaisesRegex(ValueError, "bound"):
                        self.verified(archive, {**restore.DEFAULT_LIMITS, key: 1})

    def test_compressed_extension_metadata_is_bounded_before_tar_parsing(self):
        with tempfile.TemporaryDirectory() as directory:
            archive = Path(directory) / "large-pax.tar.gz"
            with tarfile.open(archive, "w:gz") as stream:
                info = tarfile.TarInfo("extended")
                info.type, info.size = tarfile.XHDTYPE, 65537
                stream.addfile(info, io.BytesIO(b"x" * info.size))
            with self.assertRaisesRegex(ValueError, "extension metadata"):
                self.verified(archive)

    def test_symlink_destination_or_parent_cannot_redirect_extraction(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            archive = self.archive(root)
            verified = self.verified(archive)
            outside = root / "outside"
            outside.mkdir()
            (root / "alias").symlink_to(outside, target_is_directory=True)
            for destination in [root / "alias", root / "alias/new"]:
                with self.assertRaisesRegex(ValueError, "symbolic links"):
                    restore.extract_verified(archive, destination, verified)
            self.assertEqual(list(outside.iterdir()), [])

    def test_exact_clean_original_producer_and_locked_bytes_are_required(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            subprocess.run(["git", "init", "-q", str(root)], check=True)
            (root / "tracked").write_text("original")
            subprocess.run(["git", "-C", str(root), "add", "tracked"], check=True)
            subprocess.run(["git", "-C", str(root), "-c", "user.name=Restore Test", "-c", "user.email=restore@example.invalid",
                            "commit", "-qm", "fixture"], check=True)
            revision = subprocess.check_output(["git", "-C", str(root), "rev-parse", "HEAD"], text=True).strip()
            self.assertTrue(restore.producer_identity(root, revision)["trackedWorktreeClean"])
            with self.assertRaisesRegex(ValueError, "exact original producer"):
                restore.producer_identity(root, "b" * 40)
            (root / "tracked").write_text("changed")
            with self.assertRaisesRegex(ValueError, "exact original producer"):
                restore.producer_identity(root, revision)
            restored, producer = root / "restored", root / "producer"
            for archived, original in restore.LOCKS.items():
                for path in [restored / archived, producer / original]:
                    path.parent.mkdir(parents=True, exist_ok=True)
                    path.write_text("same lock")
            self.assertEqual(len(restore.verify_locks(restored, producer)), len(restore.LOCKS))
            (producer / "npm-shrinkwrap.json").write_text("changed dependency")
            with self.assertRaisesRegex(ValueError, "lock differs"):
                restore.verify_locks(restored, producer)

    def test_runtime_mismatch_retains_exact_expected_and_actual_before_replay(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            producer = root / "producer"
            expected = {"node": "24.22.3", "v8": "13.6.233.17-node.63", "npm": "11.9.0",
                        "platform": "linux", "arch": "x64", "timezone": "UTC", "locale": "C.UTF-8"}
            for archived, original in restore.LOCKS.items():
                path = producer / original
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(json.dumps(expected) if archived == "locks/environment.json" else "original lock")
            rows, sources = release.inventory({archived: producer / original for archived, original in restore.LOCKS.items()})
            archive = root / "release.tar.gz"
            release.write_archive(archive, {"schema": "semantic-private-release/1", "producerRevision": "a" * 40,
                                            "files": rows}, sources)
            archive_sha = release.file_receipt(archive)["sha256"]
            for field, changed in [("node", "22.0.0"), ("v8", "12.4.0"), ("npm", "11.19.1")]:
                with self.subTest(field=field):
                    actual = {key: expected[key] for key in ("node", "v8", "npm", "platform", "arch")}
                    actual[field] = changed
                    args = SimpleNamespace(archive=archive, out=root / ("restore-" + field), tracer_root=producer,
                        archive_sha256=archive_sha, limits=restore.DEFAULT_LIMITS)
                    with mock.patch.object(restore, "producer_identity", return_value={"revision": "a" * 40}), \
                            mock.patch.object(restore.platform, "platform", return_value="isolated-runtime-test"), \
                            mock.patch.object(restore.subprocess, "check_output", side_effect=[
                                json.dumps({key: value for key, value in actual.items() if key != "npm"}), actual["npm"] + "\n"]), \
                            mock.patch.object(restore, "run_logged") as execute:
                        with self.assertRaisesRegex(ValueError, field + ": expected " + expected[field]):
                            restore.restore_release(args)
                        execute.assert_not_called()
                    receipt = json.loads((args.out / "restore.json").read_text())
                    self.assertEqual(receipt["status"], "failed")
                    self.assertEqual(receipt["phase"], "producer-environment")
                    self.assertEqual(receipt["expectedExecutionEnvironment"], expected)
                    self.assertEqual(receipt["executionEnvironment"], {**actual, "timezone": "UTC", "locale": "C.UTF-8"})
                    self.assertEqual(receipt["executionEnvironmentMismatches"],
                                     {field: {"expected": expected[field], "actual": changed}})
                    self.assertNotIn("replay", receipt)
                    self.assertEqual(release.file_receipt(archive)["sha256"], archive_sha)


if __name__ == "__main__":
    unittest.main()
