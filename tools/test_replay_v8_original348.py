"""Bounded refusal controls for the separately sourced original348 follow-up."""
import copy
import importlib.util
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("followup348", Path(__file__).with_name("replay-v8-original348-rejected-fragments.py"))
driver = importlib.util.module_from_spec(spec)
spec.loader.exec_module(driver)


class FollowupControls(unittest.TestCase):
    def population(self):
        special = {"absolute-distance": "validation", "squared-distance": "validation", "unit-conversion": "validation", "flag-intersection": "test"}
        return {"declared": 16, "cases": [{"id": "se-support-" + name + "-pure", "family": "semantic-recipe:" + name,
                "split": special.get(name, "train")} for name in sorted(driver.PURE_NAMES)],
                "settings": copy.deepcopy(driver.original348.SETTINGS), "limits": copy.deepcopy(driver.original348.LIMITS), "seed": 17,
                "unmeasuredProfileCases": [{} for _ in range(48)], "initializedBaseline": "unmeasured"}

    def test_exact_three_file_old_parent_patch_is_accepted(self):
        driver.validate_runtime_change(driver.original348.NATIVE, list(driver.PATCH_FILES), dict(driver.PATCH_FILES))

    def test_current_contract_or_other_parent_is_refused(self):
        with self.assertRaisesRegex(ValueError, "directly based"):
            driver.validate_runtime_change("cdd01ac0dcd65d92e948cec39f7b5c156800206e", list(driver.PATCH_FILES), dict(driver.PATCH_FILES))

    def test_extra_lineage_or_contract_edit_is_refused(self):
        for extra in ("src/megatoken/semantic_lineage_v8.py", "src/megatoken/data/semantic_contract_v8.py"):
            with self.subTest(extra=extra), self.assertRaisesRegex(ValueError, "outside"):
                driver.validate_runtime_change(driver.original348.NATIVE, [*driver.PATCH_FILES, extra], dict(driver.PATCH_FILES))

    def test_same_paths_with_changed_patch_bytes_are_refused(self):
        hashes = dict(driver.PATCH_FILES)
        hashes["src/megatoken/semantic_model_v8.py"] = "0" * 64
        with self.assertRaisesRegex(ValueError, "source bytes"):
            driver.validate_runtime_change(driver.original348.NATIVE, list(driver.PATCH_FILES), hashes)

    def test_complete_original_population_is_accepted(self):
        self.assertEqual(len(driver.validate_population(self.population())), 16)

    def test_missing_duplicate_and_changed_split_are_refused(self):
        for alteration in ("missing", "duplicate", "split"):
            profile = self.population()
            if alteration == "missing":
                profile["cases"].pop()
            elif alteration == "duplicate":
                profile["cases"][-1] = copy.deepcopy(profile["cases"][0])
            else:
                first = next(row for row in profile["cases"] if row["split"] == "train")
                second = next(row for row in profile["cases"] if row["split"] == "test")
                first["split"], second["split"] = second["split"], first["split"]
            with self.subTest(alteration=alteration), self.assertRaises(ValueError):
                driver.validate_population(profile)

    def test_changed_generation_budget_is_refused(self):
        for key in ("seed", "settings", "limits"):
            profile = self.population()
            if key == "seed":
                profile[key] = 18
            elif key == "settings":
                profile[key]["maxTokens"] = 129
            else:
                profile[key]["maxStaleRetries"] = 1
            with self.subTest(key=key), self.assertRaisesRegex(ValueError, "settings"):
                driver.validate_population(profile)

    def test_unmeasured_profiles_and_baseline_cannot_be_silently_dropped(self):
        for key in ("unmeasuredProfileCases", "initializedBaseline"):
            profile = self.population()
            if key == "unmeasuredProfileCases":
                profile[key].pop()
            else:
                profile[key] = "measured"
            with self.subTest(key=key), self.assertRaisesRegex(ValueError, "unmeasured scope"):
                driver.validate_population(profile)


if __name__ == "__main__":
    unittest.main()
