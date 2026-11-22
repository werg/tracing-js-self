"""Refuse diluted populations, wrong weights and first-record quality claims."""
import importlib.util
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("evaluate348", Path(__file__).with_name("evaluate-v8-original348-pure.py"))
evaluation = importlib.util.module_from_spec(spec)
spec.loader.exec_module(evaluation)


class Original348EvaluationTests(unittest.TestCase):
    def artifacts(self):
        result = {}
        for index in range(16):
            split = "train" if index < 12 else "validation" if index < 15 else "test"
            for variant in ("pure", "callbacks-recovery", "repeated-2calls", "child-teacher"):
                result[f"family-{index:02d}-{variant}"] = {
                    "public": {"schema": "semantic-execution/8", "timeline": [
                        {"mode": "observed", "kind": "program"}, {"mode": "observed", "kind": "invocation"},
                        {"mode": "generated", "kind": "region"}, {"mode": "generated", "kind": "end"}]},
                    "sidecar": {"referenceStatus": "agreed", "familyRegistryDigest": evaluation.REGISTRY,
                        "split": split, "sourceFamily": f"family-{index:02d}",
                        "sourceArtifact": {"sidecar": {"referenceInput": {"fixture": {"calls": [], "settlementOrder": None}}}}}}
        return result

    def export(self):
        manifest = {"model_version": 348, "checkpoint_sha256": evaluation.STATE_SHA,
            "codec_fingerprint": evaluation.TOKENIZER, "tokenizer_sha256": evaluation.TOKENIZER_SHA,
            "training_heads": False, "model_sha256": "a" * 64, "semantic_v8_lineage_digest": "b" * 64}
        lineage = {"modelVersion": 348, "modelIdentity": manifest["model_sha256"], "digest": "b" * 64,
            "trainingCheckpointSha256": evaluation.STATE_SHA,
            "training": {"digest": evaluation.TRAINING_LINEAGE, "policy": {"schema": "semantic-training-policy/8",
                "producerRevision": evaluation.PRODUCER, "consumerRevision": evaluation.NATIVE,
                "registryDigest": evaluation.REGISTRY}}}
        return manifest, lineage

    def observation(self):
        identities = evaluation.validate_export(*self.export())
        study = {"digest": "c" * 64, "declared": 3, "cases": [{"id": name} for name in ("a", "b", "c")]}
        result = {**identities, "origin": "model", "seed": evaluation.SEED, "optimizerSteps": 0,
            "generationSettings": evaluation.SETTINGS,
            "inferenceIdentity": {**identities, "seed": evaluation.SEED, "generationSettings": evaluation.SETTINGS},
            "attempts": [{"provenanceValidated": True}], "sourceValidated": True, "completedExecution": True,
            "publicCompleted": True, "publicAccepted": True, "sourceStatus": "passed-exact-projection",
            "sourceEvidence": {"sourceValidated": True, "exactPublicProjection": True}, "costs": {}}
        report = {**identities, "schema": "semantic-execution-study-results/8", "studyDigest": study["digest"],
            "origin": "model", "declared": 3, "settings": evaluation.SETTINGS,
            "qualification": {"optimizerSteps": 0}, "rows": [
                {"caseId": "a", "seed": evaluation.SEED, "status": "completed", "completedExecution": True,
                 "sourceValidated": True, "result": result},
                *[{"caseId": name, "seed": evaluation.SEED, "status": "untested", "result": None} for name in ("b", "c")]]}
        return report, study, identities

    def test_all_sixteen_pure_families_and_original_split_are_preserved(self):
        selected, remaining = evaluation.select_inventory(self.artifacts())
        self.assertEqual(len(selected), 16)
        self.assertEqual(len(remaining), 48)
        self.assertEqual({split: sum(row["split"] == split for row in selected) for split in evaluation.SPLITS}, evaluation.SPLITS)

    def test_missing_original_case_refuses(self):
        cases = self.artifacts()
        cases.pop(next(iter(cases)))
        with self.assertRaisesRegex(ValueError, "64-source"):
            evaluation.select_inventory(cases)

    def test_missing_pure_profile_refuses(self):
        cases = self.artifacts()
        cases["family-00-unrequested"] = cases.pop("family-00-pure")
        with self.assertRaisesRegex(ValueError, "pure family"):
            evaluation.select_inventory(cases)

    def test_changed_split_refuses(self):
        cases = self.artifacts()
        cases["family-00-pure"]["sidecar"]["split"] = "test"
        with self.assertRaisesRegex(ValueError, "split changed"):
            evaluation.select_inventory(cases)

    def test_duplicate_pure_family_refuses(self):
        cases = self.artifacts()
        cases["family-00-pure"]["sidecar"]["sourceFamily"] = "family-01"
        with self.assertRaisesRegex(ValueError, "pure family"):
            evaluation.select_inventory(cases)

    def test_private_future_host_answer_refuses(self):
        cases = self.artifacts()
        cases["family-00-pure"]["sidecar"]["sourceArtifact"]["sidecar"]["referenceInput"]["fixture"]["calls"].append({"result": 42})
        with self.assertRaisesRegex(ValueError, "future host answers"):
            evaluation.select_inventory(cases)

    def test_second_root_invocation_refuses_pure_profile(self):
        cases = self.artifacts()
        cases["family-00-pure"]["public"]["timeline"].append({"mode": "observed", "kind": "invocation"})
        with self.assertRaisesRegex(ValueError, "single-entry"):
            evaluation.select_inventory(cases)

    def test_export_runtime_identity_uses_served_model_not_training_state_hash(self):
        identity = evaluation.validate_export(*self.export())
        self.assertEqual(identity["checkpointIdentity"], "a" * 64)
        self.assertNotEqual(identity["checkpointIdentity"], evaluation.STATE_SHA)

    def test_two_update_bundle_cannot_substitute(self):
        manifest, lineage = self.export()
        manifest["model_version"] = 2
        with self.assertRaisesRegex(ValueError, "actual frozen step-348"):
            evaluation.validate_export(manifest, lineage)

    def test_other_348_checkpoint_cannot_substitute(self):
        manifest, lineage = self.export()
        manifest["checkpoint_sha256"] = "d" * 64
        with self.assertRaisesRegex(ValueError, "actual frozen step-348"):
            evaluation.validate_export(manifest, lineage)

    def test_other_native_source_cannot_substitute(self):
        manifest, lineage = self.export()
        lineage["training"]["policy"]["consumerRevision"] = "0" * 40
        with self.assertRaisesRegex(ValueError, "lineage differs"):
            evaluation.validate_export(manifest, lineage)

    def test_full_source_certified_observation_counts(self):
        report, study, identity = self.observation()
        row = evaluation.observed_case(report, study, "a", identity)
        self.assertTrue(row["actualModelMeasured"])
        self.assertTrue(row["completedExecution"])

    def test_first_record_or_equal_final_value_is_not_complete_execution(self):
        report, study, identity = self.observation()
        report["rows"][0]["result"]["sourceEvidence"]["exactPublicProjection"] = False
        with self.assertRaisesRegex(ValueError, "First-record/public-only"):
            evaluation.observed_case(report, study, "a", identity)

    def test_synthetic_selection_cannot_supply_model_success(self):
        report, study, identity = self.observation()
        report["rows"][0]["result"]["attempts"][0]["provenanceValidated"] = False
        with self.assertRaisesRegex(ValueError, "First-record/public-only"):
            evaluation.observed_case(report, study, "a", identity)

    def test_omitted_population_row_refuses(self):
        report, study, identity = self.observation()
        report["rows"].pop()
        with self.assertRaisesRegex(ValueError, "omitted or duplicated"):
            evaluation.observed_case(report, study, "a", identity)

    def test_runtime_attestation_mismatch_refuses(self):
        report, study, identity = self.observation()
        report["rows"][0]["result"]["inferenceIdentity"]["trainingIdentity"] = "d" * 64
        with self.assertRaisesRegex(ValueError, "runtime attestation"):
            evaluation.observed_case(report, study, "a", identity)

    def test_one_case_process_cannot_change_other_cases(self):
        report, study, identity = self.observation()
        report["rows"][1]["status"] = "failed"
        with self.assertRaisesRegex(ValueError, "different population"):
            evaluation.observed_case(report, study, "a", identity)


if __name__ == "__main__":
    unittest.main()
