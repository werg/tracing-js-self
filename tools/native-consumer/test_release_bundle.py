import importlib.util
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("release", Path(__file__).parents[1] / "package-semantic-release.py")
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


class ReleaseArchiveTests(unittest.TestCase):
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
            source.write_text("changed")
            destination = root / "release.tar.gz"
            with self.assertRaisesRegex(ValueError, "changed after inventory"):
                release.write_archive(destination, {"files": files}, paths)
            self.assertFalse(destination.exists())
            self.assertFalse(destination.with_suffix(".gz.partial").exists())

    def test_path_escape_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(ValueError, "relative descendants"):
                release.inside(Path(directory), "../outside.json")


if __name__ == "__main__":
    unittest.main()
