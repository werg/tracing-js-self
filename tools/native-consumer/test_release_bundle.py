import importlib.util
import gzip
import io
import json
import subprocess
import tarfile
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
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


class ReleaseQualificationTests(unittest.TestCase):
    def environment_fixture(self, root):
        tracer = root / "original-producing-checkout"
        (tracer / "contracts").mkdir(parents=True)
        (tracer / "tools/native-consumer").mkdir(parents=True)
        policy = {"consumerRevision": "a" * 40, "tokenizerIdentity": "b" * 64, "tokenizerSha256": "c" * 64}
        (tracer / "contracts/native-admission-policy-v5.json").write_text(json.dumps(policy))
        (tracer / "tools/native-consumer/requirements.lock").write_text("actual-dependency==1.0\n")
        receipt = {"schema": "semantic-native-environment-receipt/1", "status": "verified", **policy,
                   "requirementsLockSha256": release.file_receipt(tracer / "tools/native-consumer/requirements.lock")["sha256"],
                   "nativePolicySha256": release.file_receipt(tracer / "contracts/native-admission-policy-v5.json")["sha256"],
                   "packages": {"actual-dependency": "1.0"}}
        supplied = root / "supplied.json"
        supplied.write_text(json.dumps(receipt))
        return tracer, policy, receipt, supplied

    def test_environment_gate_executes_the_exact_producer_checker_and_retains_actual_receipt(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            tracer, policy, receipt, supplied = self.environment_fixture(root)
            actual = root / "actual.json"

            def check(argv, **kwargs):
                self.assertEqual(argv[:2], [release.sys.executable, str(tracer / "tools/native-consumer/check_environment.py")])
                self.assertEqual(argv[-2:], ["--out", str(actual)])
                actual.write_text(json.dumps(receipt))
                return SimpleNamespace(returncode=0, stderr="")

            with mock.patch.object(release.subprocess, "run", side_effect=check) as runner:
                self.assertEqual(release.recheck_environment(tracer, root / "consumer", root / "tokenizer",
                                 supplied, actual, policy), receipt)
            runner.assert_called_once()
            self.assertEqual(release.read_json(actual), receipt)

    def test_stale_dependency_receipt_is_rejected_even_when_policy_pins_match(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            tracer, policy, receipt, supplied = self.environment_fixture(root)
            stale = {**receipt, "packages": {"actual-dependency": "stale"}}
            supplied.write_text(json.dumps(stale))
            actual = root / "actual.json"

            def check(argv, **kwargs):
                actual.write_text(json.dumps(receipt))
                return SimpleNamespace(returncode=0, stderr="")

            with mock.patch.object(release.subprocess, "run", side_effect=check):
                with self.assertRaisesRegex(ValueError, "stale"):
                    release.recheck_environment(tracer, root / "consumer", root / "tokenizer", supplied, actual, policy)
            self.assertEqual(release.read_json(actual), receipt)

    def test_fresh_checker_failure_cannot_be_bypassed_by_a_previous_verified_receipt(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            tracer, policy, _, supplied = self.environment_fixture(root)
            with mock.patch.object(release.subprocess, "run", return_value=SimpleNamespace(returncode=1, stderr="dirty consumer")):
                with self.assertRaisesRegex(ValueError, "Fresh native environment verification failed: dirty consumer"):
                    release.recheck_environment(tracer, root / "consumer", root / "tokenizer", supplied, root / "actual.json", policy)

    def test_actual_public_digest_is_checked_independently_of_sidecar_identity(self):
        row = {"id": "candidate", "family": "family", "split": "train", "identityDigest": "unchanged", "episodeDigest": "stale"}
        document = {"public": {"changed": True}, "sidecar": {"sourceFamily": "family", "split": "train",
                    "identityDigest": "unchanged", "producerRevision": "producer", "admission": "admitted"}}
        with self.assertRaisesRegex(ValueError, "actual public digest"):
            release.check_document_identity(row, document, "producer", lambda _: "actual")
        row["episodeDigest"] = "actual"
        self.assertEqual(release.check_document_identity(row, document, "producer", lambda _: "actual")["id"], "candidate")

    def test_compact_documents_are_read_from_checksummed_bounded_objects(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            raw = b'{"public":"data"}\n'
            path = root / "object.json.gz"
            path.write_bytes(gzip.compress(raw, mtime=0))
            reference = {"path": path.name, "encoding": "gzip", "uncompressedBytes": len(raw),
                         "contentSha256": release.digest(raw), **release.file_receipt(path)}
            self.assertEqual(release.read_campaign_object(root, reference), {"public": "data"})
            too_small = {**reference, "uncompressedBytes": 2}
            with self.assertRaisesRegex(ValueError, "bounded object"):
                release.read_campaign_object(root, too_small)
            path.write_bytes(gzip.compress(b'{"public":"changed"}\n', mtime=0))
            with self.assertRaisesRegex(ValueError, "bytes changed"):
                release.read_campaign_object(root, reference)

    def test_package_lock_excludes_resumed_generation_until_the_bundle_is_complete(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / ".campaign.lock"
            path.touch()
            with release.locked_campaign(root), path.open("rb") as writer:
                with self.assertRaises(BlockingIOError):
                    release.fcntl.flock(writer.fileno(), release.fcntl.LOCK_EX | release.fcntl.LOCK_NB)
                with release.locked_campaign(root):
                    pass
            with path.open("rb") as writer:
                release.fcntl.flock(writer.fileno(), release.fcntl.LOCK_EX | release.fcntl.LOCK_NB)
                with self.assertRaisesRegex(ValueError, "still open by a writer"):
                    with release.locked_campaign(root):
                        self.fail("Writer exclusion was bypassed")


class ReleaseTrainingSelectionTests(unittest.TestCase):
    def candidate(self, identity="one", tokens=50, split="train", cluster=None):
        return {"id": identity, "status": "admitted", "family": cluster or identity,
                "sourceCluster": cluster or identity, "generatedTokens": tokens, "split": split,
                "splitPolicy": "source-components/1", "registryDigest": "a" * 64, "episodeId": "native:" + identity}

    def native_database(self, root, rows, excluded=()):
        with release.sqlite3.connect(root / "semantic-dedup.sqlite") as database:
            database.execute("CREATE TABLE episodes(ordinal INTEGER PRIMARY KEY,episode_id TEXT,split TEXT,"
                             "resolved_family TEXT,assistant_tokens INTEGER,duplicate_of TEXT,quarantine_reason TEXT)")
            for index, row in enumerate(rows):
                database.execute("INSERT INTO episodes VALUES(?,?,?,?,?,?,?)", (index, row["episodeId"], row["split"],
                    row["sourceCluster"], row["generatedTokens"], "other" if row["id"] in excluded else None, None))

    def test_native_qualification_measures_tokens_and_binds_cached_source_receipts_to_full_evidence(self):
        document = {"public": {"value": 1}, "sidecar": {"producerRevision": "producer", "identityDigest": "identity",
                    "sourceFamily": "family", "split": "train", "admission": "admitted", "license": "MIT",
                    "sourceProvenance": {"license": "MIT"}, "splitIdentity": {"componentId": "component",
                    "policy": "source-components/1", "registryDigest": "a" * 64}}}
        row = {"id": "one", "family": "family", "split": "train", "identityDigest": "identity", "episodeDigest": "public",
               "metrics": {"generatedTokens": 99999}}
        native_gate = mock.Mock(return_value={"generatedTokens": 7})
        verify_gate = mock.Mock(return_value=True)
        with tempfile.TemporaryDirectory() as directory, mock.patch.object(release, "load_document", return_value=document):
            receipt_path = Path(directory) / "native.jsonl"
            qualified, sources, identities, notices = release.qualify_candidates(Path(directory), [row], receipt_path,
                codec="actual-codec", producer_revision="producer", consumer_revision="consumer",
                source_verifier=lambda _: {"sourceValidated": True}, native_admission=native_gate,
                verify_admission=verify_gate, adapt_selected=lambda *args, **kwargs: (SimpleNamespace(episode_id="native:one"), None),
                public_digest=lambda _: "public")
            self.assertEqual(qualified[0]["generatedTokens"], 7)
            self.assertEqual(qualified[0]["episodeId"], "native:one")
            native_gate.assert_called_once_with(document, codec="actual-codec", consumer_revision="consumer")
            verify_gate.assert_called_once()
            self.assertEqual(json.loads(receipt_path.read_text())["native"]["generatedTokens"], 7)
            cached = release.cached_source_verifier(sources)
            self.assertTrue(cached(document)["sourceValidated"])
            document["sidecar"]["sourceProvenance"]["license"] = "changed"
            with self.assertRaisesRegex(ValueError, "changed after fresh source"):
                cached(document)
            self.assertEqual(identities[0]["id"], "one")
            self.assertEqual(notices[0]["candidateIds"], ["one"])

    def test_impossible_training_caps_keep_an_explicit_selection_receipt_and_fail(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            rows = [self.candidate(), self.candidate("held", 10000, "test")]
            with self.assertRaisesRegex(ValueError, "excluded every training candidate"):
                release.select_training(rows, root, max_family_share=.2)
            receipt = release.read_json(root / "training-selection.json")
            self.assertEqual(receipt["status"], "empty-training-selection")
            self.assertEqual(receipt["heldOutIds"], ["held"])
            self.assertEqual(receipt["preparedCandidateIds"], ["held"])

    def test_prepared_shares_use_the_final_native_denominator_and_never_include_held_out_tokens(self):
        rows = [self.candidate("a"), self.candidate("b"), self.candidate("held", 10000, "validation")]
        for excluded in ([], ["b"]):
            with self.subTest(excluded=excluded), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                selection = release.select_training(rows, root, max_family_tokens=100, max_family_share=.5)
                self.native_database(root, rows, excluded)
                receipt = release.check_prepared_selection(root, rows, selection)
                self.assertEqual(receipt["heldOutInputIds"], ["held"])
                self.assertEqual(receipt["generatedTrainTokens"], 50 if excluded else 100)
                self.assertEqual(receipt["status"], "violated" if excluded else "verified")
                if excluded:
                    self.assertIn("token share", receipt["violations"][0])
                    self.assertEqual(receipt["components"][0]["tokenShare"], 1)
                else:
                    self.assertTrue(all(component["tokenShare"] == .5 for component in receipt["components"]))

    def test_prepared_data_cannot_add_candidates_move_splits_or_change_measured_tokens(self):
        changes = [
            ("UPDATE episodes SET assistant_tokens=51", "token count"),
            ("UPDATE episodes SET split='test'", "frozen split"),
            ("UPDATE episodes SET episode_id='unexpected'", "unselected episode"),
        ]
        for query, error in changes:
            with self.subTest(query=query), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                rows = [self.candidate()]
                selection = release.select_training(rows, root)
                self.native_database(root, rows)
                with release.sqlite3.connect(root / "semantic-dedup.sqlite") as database:
                    database.execute(query)
                with self.assertRaisesRegex(ValueError, error):
                    release.check_prepared_selection(root, rows, selection)

    def test_new_native_ancestry_joins_require_a_rebuilt_global_registry_before_a_capped_release(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            rows = [self.candidate("a"), self.candidate("b")]
            selection = release.select_training(rows, root, max_family_share=.5)
            self.native_database(root, rows)
            with release.sqlite3.connect(root / "semantic-dedup.sqlite") as database:
                database.execute("UPDATE episodes SET resolved_family='same-native-ancestor'")
            receipt = release.check_prepared_selection(root, rows, selection)
            self.assertEqual(receipt["status"], "violated")
            self.assertIn("rebuild the global source registry", receipt["violations"][0])



class ReleaseCompactCampaignTests(unittest.TestCase):
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
  cases:[entry,refusal].map(row=>({id:row.id,candidateDigest:row.candidateDigest,status:row.status,
    ...(row.status==='admitted'?{split:'train'}:{})})),
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
            verified = release.verify_materialized_documents(corpus, hydrated, document_root, manifest)
            self.assertEqual(verified["selectedIds"], ["one"])
            materialized_path = document_root / "one.json"
            exact = materialized_path.read_bytes()
            document["sidecar"]["identityDigest"] = "changed"
            materialized_path.write_text(json.dumps(document))
            with self.assertRaisesRegex(ValueError, "differs from audited campaign"):
                release.verify_materialized_documents(corpus, hydrated, document_root, manifest)
            materialized_path.write_bytes(exact)
            self.assertFalse((output / "materialization-input").exists())
            self.assertEqual(original, {path.relative_to(corpus).as_posix(): path.read_bytes() for path in corpus.rglob("*") if path.is_file()})
            files, paths = release.inventory({"corpus": corpus, "materialized": document_root})
            archive = output / "compact-test.tar.gz"
            release.write_archive(archive, {"schema": "storage-test", "files": files}, paths)
            self.assertEqual(release.verify_archive(archive)["files"], len(files))
            self.assertEqual(sum(row["path"].startswith("corpus/objects/registries/") for row in files), 1)


    def test_selected_release_preserves_all_heldout_ids_and_candidate_identity(self):
        held = {"id": "held", "status": "admitted", "split": "test", "identityDigest": "original"}
        source = {"producerRevision": "producer", "cases": [held], "counts": {"attempted": 1, "admitted": 1}}
        empty = {"producerRevision": "producer", "cases": [], "counts": {"attempted": 0, "admitted": 0}}
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with self.assertRaisesRegex(ValueError, "omits original held-out"):
                release.verify_materialized_documents(root, empty, root, source)
            changed = {**source, "cases": [{**held, "path": "held.json", "identityDigest": "changed"}]}
            with self.assertRaisesRegex(ValueError, "changed a candidate disposition or identity"):
                release.verify_materialized_documents(root, changed, root, source)


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
