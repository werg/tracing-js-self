import importlib.util
import json
import subprocess
import tempfile
import unittest
from unittest import mock
from pathlib import Path

spec = importlib.util.spec_from_file_location("release", Path(__file__).parents[1] / "package-semantic-release.py")
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


class ReleaseArchiveTests(unittest.TestCase):
    def test_archive_streams_large_members_and_checksums_without_read_bytes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source, archive = root / "semantic-audit.json", root / "release.tar.gz"
            with source.open("wb") as handle:
                for _ in range(16):
                    handle.write(b"bounded-private-evidence" * 32768)
            with mock.patch.object(Path, "read_bytes", side_effect=AssertionError("whole-file read")):
                files, paths = release.inventory({"prepared/semantic-audit.json": source})
                release.write_archive(archive, {"schema": "test", "files": files}, paths)
                receipt = release.verify_archive(archive)
            self.assertEqual(receipt["files"], 1)
            self.assertEqual(files[0]["bytes"], source.stat().st_size)

    def test_admitted_document_loading_is_lazy_and_keeps_only_release_metadata(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            side = {"producerRevision": "a" * 40, "identityDigest": "identity", "sourceFamily": "family",
                    "split": "train", "license": "MIT", "sourceProvenance": {"pinned": True}}
            (root / "first.json").write_text(json.dumps({"public": {}, "sidecar": side}))
            (root / "second.json").write_text("invalid JSON that must not be read eagerly")
            manifest = {"producerRevision": "a" * 40, "cases": [
                {"id": name, "status": "admitted", "path": name + ".json",
                 "identityDigest": "identity", "episodeDigest": "public"} for name in ("first", "second")]}
            identities, notices = [], {}
            rows = release.iter_admitted_documents(manifest, root, identities, notices)
            self.assertFalse(identities)
            self.assertEqual(next(rows)["sidecar"], side)
            self.assertEqual(len(identities), 1)
            self.assertEqual(notices, {"family": {"license": "MIT", "provenance": {"pinned": True}}})
            with self.assertRaises(json.JSONDecodeError):
                next(rows)

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

    def test_compact_cas_staging_keeps_original_bytes_and_archive_audit(self):
        # This is a storage fixture, not a native admission receipt. The full
        # package entry point separately requires production re-admission.
        tracer = Path(__file__).resolve().parents[2]
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            corpus, output = root / "corpus", root / "release"
            output.mkdir()
            program = """
import {CampaignStore,atomicWrite} from './src/corpus/campaign-store.mjs';
import {join} from 'node:path';
const directory=process.argv[1],registry={schema:'semantic-source-registry/1',sources:[],components:[]};
const store=new CampaignStore(directory,{producer:'storage-test'});
const entry=store.record('one',{source:'function run(){return 1;}'},{status:'admitted',
  exported:{public:{timeline:[]},sidecar:{splitIdentity:{registry},identity:{registry}}}});
const refusal=store.record('refused',{source:'unsupported source'},{status:'unsupported',failure:{original:'retained'}});
atomicWrite(join(directory,'manifest.json'),JSON.stringify({producerRevision:'a'.repeat(40),
  campaign:{identityDigest:store.identityDigest,compatibilityExports:false},recipe:{},
  cases:[entry,refusal].map(row=>({id:row.id,candidateDigest:row.candidateDigest,status:row.status})),
  counts:{attempted:2,admitted:1,unsupported:1}})+'\\n');
"""
            subprocess.run(["node", "--input-type=module", "-e", program, str(corpus)], cwd=tracer, check=True)
            original = {path.relative_to(corpus).as_posix(): path.read_bytes() for path in corpus.rglob("*") if path.is_file()}
            manifest = json.loads((corpus / "manifest.json").read_text())
            storage = release.verify_campaign_storage(corpus, tracer)
            self.assertEqual(storage["attempts"], 2)
            self.assertEqual(storage["manifestRows"], 2)
            hydrated, document_root, receipt = release.stage_compact_campaign(corpus, tracer, output, manifest)
            self.assertEqual(receipt["materializedAdmitted"], 1)
            self.assertEqual(hydrated["cases"][1]["status"], "unsupported")
            document = json.loads((document_root / "one.json").read_text())
            self.assertEqual(document["sidecar"]["splitIdentity"]["registry"], document["sidecar"]["identity"]["registry"])
            self.assertFalse((output / "materialization-input").exists())
            self.assertEqual(original, {path.relative_to(corpus).as_posix(): path.read_bytes() for path in corpus.rglob("*") if path.is_file()})
            files, paths = release.inventory({"corpus": corpus, "materialized": document_root})
            archive = output / "compact-test.tar.gz"
            release.write_archive(archive, {"schema": "storage-test", "files": files}, paths)
            self.assertEqual(release.verify_archive(archive)["files"], len(files))
            self.assertEqual(sum(row["path"].startswith("corpus/objects/registries/") for row in files), 1)

    def test_selection_needs_exact_original_campaign_for_audit(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            original = b'{"counts":{"attempted":2,"admitted":1,"unsupported":1},"cases":[{},{}]}\n'
            (root / "manifest.json").write_bytes(original)
            (root / "campaign.json").write_text('{"identityDigest":"source-digest"}')
            manifest = {"selection": {"originalCampaignRequiredForAudit": True,
                         "sourceCampaignDigest": "source-digest", "sourceManifestSha256": release.digest(original)}}
            with self.assertRaisesRegex(ValueError, "audit-campaign"):
                release.required_audit_campaign(manifest, None)
            _, receipt = release.required_audit_campaign(manifest, root)
            self.assertEqual(receipt["attempted"], 2)
            self.assertEqual(receipt["counts"]["unsupported"], 1)
            (root / "manifest.json").write_bytes(original + b" ")
            with self.assertRaisesRegex(ValueError, "differs"):
                release.required_audit_campaign(manifest, root)


if __name__ == "__main__":
    unittest.main()
