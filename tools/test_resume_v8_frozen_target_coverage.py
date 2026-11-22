"""Refuse altered continuation authority before any optimizer work."""
import copy
import importlib.util
import json
import stat
import unittest
import zipfile
from pathlib import Path

spec = importlib.util.spec_from_file_location("frozen_resume", Path(__file__).with_name("resume-v8-frozen-target-coverage.py"))
resume = importlib.util.module_from_spec(spec)
spec.loader.exec_module(resume)


class FrozenContinuationTests(unittest.TestCase):
    def recipe(self):
        return {"max_steps": 348, "purpose": "diagnostic", "phase": "SE", "device": "cpu",
                "precision": "fp32", "seed": 17, "datasets": ["/original/data"],
                "codec": "/original/tokenizer", "semantic_v8_policy": {
                    "schema": "semantic-training-policy/8", "producerRevision": resume.PRODUCER,
                    "consumerRevision": resume.NATIVE, "registryDigest": resume.REGISTRY}}

    def metadata(self):
        return {"global_step": 314, "phase": "SE", "state_sha256": resume.STATE_SHA}

    def inventory(self):
        return {"optimizerWindowCount": 348, "registryDigest": resume.REGISTRY}

    def test_only_invocation_cap_changes_without_mutating_original(self):
        original = self.recipe()
        before = copy.deepcopy(original)
        changed = resume.continuation_recipe(original, self.metadata(), self.inventory())
        self.assertEqual(original, before)
        self.assertEqual(changed["max_steps"], 34)
        changed["max_steps"] = 348
        self.assertEqual(changed, original)

    def test_different_checkpoint_step_refuses(self):
        for step in [313, 315, True, "314"]:
            with self.subTest(step=step), self.assertRaises(ValueError):
                resume.continuation_recipe(self.recipe(), {**self.metadata(), "global_step": step}, self.inventory())

    def test_changed_checkpoint_state_refuses(self):
        with self.assertRaises(ValueError):
            resume.continuation_recipe(self.recipe(), {**self.metadata(), "state_sha256": "0" * 64}, self.inventory())

    def test_changed_inventory_refuses(self):
        for patch in [{"optimizerWindowCount": 347}, {"optimizerWindowCount": "348"}, {"registryDigest": "0" * 64}]:
            with self.subTest(patch=patch), self.assertRaises(ValueError):
                resume.continuation_recipe(self.recipe(), self.metadata(), {**self.inventory(), **patch})

    def test_different_native_source_refuses(self):
        recipe = self.recipe()
        recipe["semantic_v8_policy"]["consumerRevision"] = "0" * 40
        with self.assertRaises(ValueError):
            resume.continuation_recipe(recipe, self.metadata(), self.inventory())

    def test_different_training_profile_refuses(self):
        for patch in [{"purpose": "production"}, {"device": "cuda"}, {"max_steps": 349}, {"precision": "bf16"}]:
            with self.subTest(patch=patch), self.assertRaises(ValueError):
                resume.continuation_recipe({**self.recipe(), **patch}, self.metadata(), self.inventory())

    def test_safe_archive_names(self):
        self.assertEqual(resume.validate_member_names([zipfile.ZipInfo("fit/state.pt")]), {"fit/state.pt"})

    def test_unsafe_archive_names_refuse(self):
        for name in ["../state.pt", "/state.pt", "fit/../state.pt", "fit//state.pt", "fit\\state.pt", "fit/./state.pt", "fit/"]:
            with self.subTest(name=name), self.assertRaises(ValueError):
                resume.validate_member_names([zipfile.ZipInfo(name)])

    def test_duplicate_archive_members_refuse(self):
        with self.assertRaises(ValueError):
            resume.validate_member_names([zipfile.ZipInfo("state.pt"), zipfile.ZipInfo("state.pt")])

    def test_archive_symlink_refuses(self):
        item = zipfile.ZipInfo("state.pt")
        item.external_attr = (stat.S_IFLNK | 0o777) << 16
        with self.assertRaises(ValueError):
            resume.validate_member_names([item])

    def test_original_and_resumed_update_steps_remain_separate(self):
        data = b'\n'.join(json.dumps({"event": "train", "global_step": step}).encode() for step in range(315, 349))
        self.assertEqual(len(resume.train_steps(data, range(315, 349))), 34)

    def test_missing_duplicate_reordered_metric_steps_refuse(self):
        for steps in [[315, 317], [315, 316, 316], [316, 315]]:
            data = b'\n'.join(json.dumps({"event": "train", "global_step": step}).encode() for step in steps)
            with self.subTest(steps=steps), self.assertRaises(ValueError):
                resume.train_steps(data, [315, 316])

    def test_duplicate_json_keys_refuse(self):
        with self.assertRaises(ValueError):
            resume.read_json('{"max_steps":34,"max_steps":348}')

    def test_nonfinite_json_refuses(self):
        with self.assertRaises(ValueError):
            resume.read_json('{"max_steps":NaN}')


if __name__ == "__main__":
    unittest.main()
