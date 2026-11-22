"""Bounded diagnostic controls; random fixture weights are never actual348 evidence."""
import copy
from dataclasses import replace
import importlib.util
import json
from pathlib import Path
import random
import tempfile
import unittest

import numpy as np
import torch

spec = importlib.util.spec_from_file_location(
    "diagnose_original348", Path(__file__).with_name("diagnose-v8-original348-first-target.py")
)
diagnosis = importlib.util.module_from_spec(spec)
spec.loader.exec_module(diagnosis)


class FirstTargetDiagnosticTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from megatoken.data.chunking import ChunkingConfig
        from megatoken.data.storage import PreparedCorpus
        from megatoken.loading import build_model
        from megatoken.model import ModelConfig
        from megatoken.training.config import TrainConfig
        from tests.test_semantic_v8_training_policy import prepared_v8_fixture
        torch.set_num_threads(1)
        cls.temporary = tempfile.TemporaryDirectory()
        root = Path(cls.temporary.name)
        _, codec, policy, prepared = prepared_v8_fixture(root, max_positions=256, max_history=128)
        with PreparedCorpus([str(prepared)], split="train") as corpus:
            cls.episode = next(corpus.iter_episodes())
            cls.chunking = ChunkingConfig.from_identity(corpus.chunking, codec)
        cls.artifact = json.loads(cls.episode.supervision.annotations_json)["semantic_execution"]["publicArtifact"]
        torch.manual_seed(17)
        cls.model = build_model(ModelConfig.tiny(max_capacity=256, max_history_chunks=128), codec).eval()
        cls.config = TrainConfig(
            purpose="diagnostic", phase="SE", model="tiny", codec="injected-tokenizer",
            datasets=[str(prepared)], semantic_v8_policy=policy, device="cpu", precision="fp32",
            representation_mode="auto", effort=6, generated_capacity=256,
            max_window_records=128, max_history_tokens=16384, max_record_bytes=4096,
            scored_decisions=2, max_steps=1, gradient_checkpointing=False, expert_backend="torch",
        )
        cls.before = diagnosis.model_identity(cls.model)
        with diagnosis.readonly_native() as forbidden:
            random.seed(17); np.random.seed(17); torch.manual_seed(17)
            cls.training = diagnosis.capture_training_boundary(cls.model, cls.episode, cls.config, root)
            cls.binding = diagnosis.target_binding(cls.episode, cls.artifact, codec, cls.training[1]["plans"][0])
            cls.serving = {}
            cls.scores = {}
            for label, effort in diagnosis.CONDITIONS:
                captured = diagnosis.capture_serving_boundary(
                    cls.model, cls.artifact, cls.chunking, effort=effort, max_tokens=256,
                    model_hash="a" * 64, lineage_hash="b" * 64,
                )
                cls.serving[effort] = captured
                cls.scores[effort] = diagnosis.score_first_target(
                    cls.model, captured[0], cls.training[1], captured[1]
                )
        cls.forbidden = forbidden
        cls.after = diagnosis.model_identity(cls.model)

    @classmethod
    def tearDownClass(cls):
        cls.temporary.cleanup()

    def test_original_physical_target_and_masks_bind(self):
        # This controlled byte-fallback fixture spans two physical parts. The
        # exact original capped-budget target is independently bound as one.
        self.assertEqual(self.binding["physicalParts"], 2)
        self.assertEqual(self.binding["selectedPart"], 0)
        self.assertTrue(all(self.binding["freeMask"]))
        self.assertEqual(self.binding["role"], "assistant")

    def test_matched_effort_uses_complete_equal_native_state(self):
        result = diagnosis.differences(diagnosis.snapshot(self.training[0]), diagnosis.snapshot(self.serving[6][0]))
        self.assertTrue(result["exactEqual"], result["differences"])
        self.assertEqual(self.training[1]["control_payloads"], self.serving[6][1]["controls"])
        self.assertEqual(self.training[1]["effort"], 6)
        self.assertEqual(self.serving[1][1]["effort"], 1)
        self.assertEqual(self.serving[6][1]["effort"], 6)

    def test_both_teacher_objectives_preserve_weights_and_bank(self):
        self.assertEqual(self.before, self.after)
        self.assertEqual(self.forbidden, {"backward": 0, "optimizerStep": 0, "freeGeneration": 0})
        for score in self.scores.values():
            self.assertEqual([row["kind"] for row in score["objectives"]], ["prior", "reconstruction"])
            self.assertEqual(score["freeGeneratedRecords"], 0)
            self.assertEqual(score["committedRecords"], 0)
            for row in score["objectives"]:
                measured = row["lexical"]
                self.assertEqual(measured["firstTargetTokenId"], self.binding["originalTokenIds"][0])
                self.assertGreaterEqual(measured["firstTargetRank"], 1)
                self.assertGreater(measured["firstTargetProbability"], 0)
                self.assertLessEqual(measured["firstTargetProbability"], 1)
                self.assertEqual(row["objectives"]["lexical"]["positions"], len(self.binding["originalTokenIds"]))

    def test_changed_source_target_refuses(self):
        artifact = copy.deepcopy(self.artifact)
        next(row for row in artifact["public"]["timeline"] if row["mode"] == "generated")["fields"]["line"] += " "
        with self.assertRaisesRegex(ValueError, "physical target differs"):
            diagnosis.target_binding(self.episode, artifact, self.model.codec, self.training[1]["plans"][0])

    def test_changed_loss_mask_refuses(self):
        plan = self.training[1]["plans"][0]
        mask = list(plan.free_masks[0]); mask[0] = not mask[0]
        plan = replace(plan, free_masks=(tuple(mask),))
        with self.assertRaisesRegex(ValueError, "loss mask differs"):
            diagnosis.target_binding(self.episode, self.artifact, self.model.codec, plan)

    def test_changed_target_role_refuses(self):
        plan = replace(self.training[1]["plans"][0], roles=(0,))
        with self.assertRaisesRegex(ValueError, "target role changed"):
            diagnosis.target_binding(self.episode, self.artifact, self.model.codec, plan)

    def test_changed_serving_output_support_refuses(self):
        request = dict(self.serving[6][1])
        request["specs"] = (replace(request["specs"][0], max_tokens=128),)
        with self.assertRaisesRegex(ValueError, "output support differs"):
            diagnosis.score_first_target(self.model, self.serving[6][0], self.training[1], request)

    def test_changed_state_and_boolean_integer_are_distinct(self):
        state = diagnosis.snapshot(self.training[0])
        changed = copy.deepcopy(state)
        changed["fields"]["context_seen"] += 1
        self.assertFalse(diagnosis.differences(state, changed)["exactEqual"])
        self.assertFalse(diagnosis.differences({"x": True}, {"x": 1})["exactEqual"])

    def test_free_generation_guard_refuses(self):
        from megatoken.multitrack_runtime import MultiTrackRuntime
        with self.assertRaisesRegex(RuntimeError, "forbids freeGeneration"):
            with diagnosis.readonly_native():
                MultiTrackRuntime.generate(None, None)

    def test_optimizer_guard_refuses(self):
        from megatoken.training.optimizer import MasterAdamW
        with self.assertRaisesRegex(RuntimeError, "forbids optimizerStep"):
            with diagnosis.readonly_native():
                MasterAdamW.step(None)


if __name__ == "__main__":
    unittest.main()
