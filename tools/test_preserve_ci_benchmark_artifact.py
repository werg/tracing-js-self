import hashlib
import io
from pathlib import Path
import tempfile
import unittest
from unittest import mock

import preserve_ci_benchmark_artifact as preservation


class Response(io.BytesIO):
    def __init__(self, body=b"", *, status=200, headers=None):
        super().__init__(body)
        self.status = status
        self.headers = headers or {}


class FakeOpener:
    def __init__(self, responses):
        self.responses = list(responses)
        self.requests = []

    def open(self, request, timeout):
        self.requests.append(request)
        return self.responses.pop(0)


class PreservationTests(unittest.TestCase):
    def metadata(self):
        return {"id": preservation.ARTIFACT_ID, "name": preservation.ARTIFACT_NAME,
                "size_in_bytes": preservation.EXPECTED_BYTES,
                "digest": "sha256:" + preservation.EXPECTED_SHA256, "expired": False,
                "workflow_run": {"id": preservation.RUN_ID, "head_sha": preservation.SOURCE_REVISION}}

    def run_receipt(self):
        return {"id": preservation.RUN_ID, "head_sha": preservation.SOURCE_REVISION,
                "status": "completed", "conclusion": "success"}

    def test_frozen_source_identity_is_required(self):
        preservation.validate_metadata(self.metadata(), self.run_receipt())
        for key, value in [("id", 1), ("size_in_bytes", 1), ("digest", "sha256:wrong"),
                           ("name", "another-artifact"), ("expired", True)]:
            with self.subTest(key=key):
                altered = self.metadata()
                altered[key] = value
                with self.assertRaises(preservation.PreservationError):
                    preservation.validate_metadata(altered, self.run_receipt())
        altered = self.metadata()
        altered["workflow_run"]["head_sha"] = "different-producer"
        with self.assertRaises(preservation.PreservationError):
            preservation.validate_metadata(altered, self.run_receipt())
        altered_run = self.run_receipt()
        altered_run["conclusion"] = "failure"
        with self.assertRaises(preservation.PreservationError):
            preservation.validate_metadata(self.metadata(), altered_run)

    def test_token_is_never_forwarded_to_either_blob_redirect(self):
        data = b"original ZIP fixture bytes"
        blob = "https://productionresultssa1.blob.core.windows.net/a?sig=private"
        second = "https://productionresultssa2.blob.core.windows.net/b?sig=also-private"
        opener = FakeOpener([Response(status=302, headers={"Location": blob}),
                             Response(status=307, headers={"Location": second}), Response(data)])
        with tempfile.TemporaryDirectory() as directory, \
                mock.patch.object(preservation, "EXPECTED_BYTES", len(data)), \
                mock.patch.object(preservation, "EXPECTED_SHA256", hashlib.sha256(data).hexdigest()):
            output = Path(directory) / "original.zip"
            preservation.download_original(output, "secret-token", opener)
            self.assertEqual(output.read_bytes(), data)
        self.assertEqual(opener.requests[0].get_header("Authorization"), "Bearer secret-token")
        for request in opener.requests[1:]:
            self.assertIsNone(request.get_header("Authorization"))
            self.assertIsNone(request.get_header("Cookie"))
            self.assertNotIn("secret-token", str(request.header_items()))

    def test_untrusted_redirect_is_rejected_before_any_second_request(self):
        for location in ["http://productionresultssa1.blob.core.windows.net/a", "https://attacker.test/a",
                         "https://productionresultssa1.blob.core.windows.net.attacker.test/a",
                         "https://user:password@productionresultssa1.blob.core.windows.net/a",
                         "https://productionresultssa1.blob.core.windows.net:8080/a"]:
            opener = FakeOpener([Response(status=302, headers={"Location": location})])
            with tempfile.TemporaryDirectory() as directory, self.assertRaises(preservation.PreservationError):
                preservation.download_original(Path(directory) / "original.zip", "secret-token", opener)
            self.assertEqual(len(opener.requests), 1)

    def test_wrong_download_digest_never_becomes_original(self):
        data = b"wrong archive"
        opener = FakeOpener([Response(data)])
        with tempfile.TemporaryDirectory() as directory, mock.patch.object(preservation, "EXPECTED_BYTES", len(data)):
            target = Path(directory) / "original.zip"
            with self.assertRaises(preservation.PreservationError):
                preservation.download_original(target, "secret-token", opener)
            self.assertFalse(target.exists())

    def test_exact_parts_reconstruct_whole_bytes_and_offsets(self):
        data = bytes(range(251)) * 3
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "original.zip"
            source.write_bytes(data)
            result = preservation.split_and_verify(source, root, part_bytes=300,
                expected_bytes=len(data), expected_sha256=hashlib.sha256(data).hexdigest())
            self.assertEqual([p["bytes"] for p in result["parts"]], [300, 300, 153])
            self.assertEqual([p["offset"] for p in result["parts"]], [0, 300, 600])
            self.assertEqual(b"".join((root / p["file"]).read_bytes() for p in result["parts"]), data)
            for part in result["parts"]:
                self.assertEqual(part["sha256"], hashlib.sha256((root / part["file"]).read_bytes()).hexdigest())

    def test_modified_original_cannot_receive_reconstruction_receipt(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "original.zip"
            source.write_bytes(b"changed")
            with self.assertRaises(preservation.PreservationError):
                preservation.split_and_verify(source, root, part_bytes=3,
                    expected_bytes=7, expected_sha256=hashlib.sha256(b"genuine").hexdigest())


if __name__ == "__main__":
    unittest.main()
