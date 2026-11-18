import importlib.util
import io
import json
import tarfile
import tempfile
import unittest
from pathlib import Path
from unittest import mock

spec = importlib.util.spec_from_file_location("release", Path(__file__).parents[1] / "package-semantic-release.py")
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


class ReleaseArchiveTests(unittest.TestCase):
    def write_test_archive(self, destination, members, inventory):
        payload = {"files": inventory}
        manifest = {**payload, "identityDigest": release.digest(release.canonical(payload))}
        with tarfile.open(destination, "w:gz") as archive:
            for name, content, kind in [*members, ("release-manifest.json", json.dumps(manifest).encode(), tarfile.REGTYPE)]:
                member = tarfile.TarInfo(name)
                member.type, member.size = kind, len(content)
                archive.addfile(member, io.BytesIO(content))

    def test_deterministic_complete_archive_and_checksum_verification(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "corpus"
            source.mkdir()
            (source / "a.json").write_text('{"outcome":"throw"}\n')
            (source / "private.gz").write_bytes(b"\x00\xffprivate-evidence")
            files, paths = release.inventory({"corpus": source})
            payload = {"schema": "test", "files": files}
            first, second = root / "first.tar.gz", root / "second.tar.gz"
            release.write_archive(first, payload, paths)
            release.write_archive(second, payload, paths)
            self.assertEqual(first.read_bytes(), second.read_bytes())
            self.assertEqual(release.verify_archive(first)["files"], 2)

    def test_mutated_input_does_not_leave_a_release(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "row.json"
            source.write_text("original")
            files, paths = release.inventory({"row.json": source})
            source.write_text("changed!")  # Same size: metadata alone cannot detect the change.
            destination = root / "release.tar.gz"
            with self.assertRaisesRegex(ValueError, "changed after inventory"):
                release.write_archive(destination, {"files": files}, paths)
            self.assertFalse(destination.exists())
            self.assertFalse(destination.with_suffix(".gz.partial").exists())

    def test_path_escape_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            for path in ("../outside.json", "/absolute", "./alias", "a//alias", "a/../alias", "a\\alias", ".", ""):
                with self.subTest(path=path), self.assertRaisesRegex(ValueError, "relative descendants"):
                    release.inside(Path(directory), path)

    def test_large_members_are_hashed_archived_and_verified_without_whole_file_reads(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "large-private.bin"
            with source.open("wb") as stream:
                for _ in range(4):
                    stream.write(b"private-evidence" * 100_000)
            with mock.patch.object(Path, "read_bytes", side_effect=AssertionError("whole-file read")):
                files, paths = release.inventory({"corpus/private.bin": source})
                archive = root / "release.tar.gz"
                release.write_archive(archive, {"files": files}, paths)
                self.assertEqual(release.verify_archive(archive)["status"], "verified")
                self.assertEqual(files[0]["bytes"], source.stat().st_size)

    def test_symbolic_link_inputs_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            actual = root / "actual"
            actual.write_text("private")
            link = root / "link"
            link.symlink_to(actual)
            with self.assertRaisesRegex(ValueError, "symbolic links"):
                release.inventory({"corpus": root})
            with self.assertRaisesRegex(ValueError, "symbolic link"):
                release.inside(root, "link")

    def test_duplicate_inventory_cannot_hide_a_candidate(self):
        row = {"path": "corpus/row", "bytes": 1, "sha256": release.digest(b"x")}
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory) / "release.tar.gz"
            with self.assertRaisesRegex(ValueError, "Repeated"):
                release.write_archive(destination, {"files": [row, row]}, {})
            self.assertFalse(destination.exists())

    def test_archive_rejects_uninventoried_duplicate_and_link_members(self):
        row = {"path": "corpus/row", "bytes": 1, "sha256": release.digest(b"x")}
        cases = [
            ([("corpus/row", b"x", tarfile.REGTYPE), ("extra", b"y", tarfile.REGTYPE)], "differs"),
            ([("corpus/row", b"x", tarfile.REGTYPE)] * 2, "duplicate"),
            ([("corpus/row", b"", tarfile.SYMTYPE)], "link"),
            ([("corpus/row", b"y", tarfile.REGTYPE)], "checksum"),
            ([("./corpus/row", b"x", tarfile.REGTYPE)], "relative descendants"),
        ]
        with tempfile.TemporaryDirectory() as directory:
            archive = Path(directory) / "release.tar.gz"
            for members, error in cases:
                with self.subTest(error=error):
                    self.write_test_archive(archive, members, [row])
                    with self.assertRaisesRegex(ValueError, error):
                        release.verify_archive(archive)

    def test_manifest_metadata_is_bounded_on_write_and_verify(self):
        with tempfile.TemporaryDirectory() as directory:
            archive = Path(directory) / "release.tar.gz"
            self.write_test_archive(archive, [], [])
            with mock.patch.object(release, "MAX_MANIFEST_BYTES", 16):
                with self.assertRaisesRegex(ValueError, "bounded metadata"):
                    release.verify_archive(archive)
                with self.assertRaisesRegex(ValueError, "bounded metadata"):
                    release.write_archive(Path(directory) / "large.tar.gz", {"files": []}, {})


if __name__ == "__main__":
    unittest.main()
