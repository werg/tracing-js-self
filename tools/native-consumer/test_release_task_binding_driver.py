"""Pure driver controls for joining task labels to physical source identities."""
from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("qualify_v8_release_under_test", ROOT / "tools/qualify-v8-release.py")
qualifier = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(qualifier)


class TaskBindingDriverTests(unittest.TestCase):
    def setUp(self):
        self.case_id = "source-case-label"
        self.physical_id = "source-case-label:" + "a" * 40
        self.registry = {
            "digest": "d" * 64,
            "sources": [{"id": self.physical_id, "split": "train"}],
            "components": [{"id": "component-1", "sourceIds": [self.physical_id], "split": "train"}],
        }
        self.rows = [{"id": self.case_id, "sourceId": self.physical_id, "split": "train"}]
        self.snapshot = {
            "status": "verified",
            "cases": [{
                "id": self.case_id,
                "taskArtifactBinding": {
                    "caseId": self.case_id,
                    "membership": {
                        "sourceId": self.physical_id,
                        "split": "train",
                        "registryDigest": self.registry["digest"],
                    },
                },
            }],
        }

    def test_joins_distinct_case_label_to_exact_physical_registry_member(self):
        membership = self.snapshot["cases"][0]["taskArtifactBinding"]["membership"]
        self.assertNotEqual(self.case_id, self.physical_id)
        # This reproduces the old assertion: it rejected the valid physical ID.
        self.assertFalse(membership["sourceId"] == self.case_id)
        qualifier.verify_task_binding_snapshot(self.rows, self.registry, self.snapshot)

    def test_refuses_wrong_physical_id(self):
        self.snapshot["cases"][0]["taskArtifactBinding"]["membership"]["sourceId"] = "other:" + "b" * 40
        with self.assertRaisesRegex(ValueError, "exact case and physical source identity"):
            qualifier.verify_task_binding_snapshot(self.rows, self.registry, self.snapshot)

    def test_refuses_wrong_case_label(self):
        self.snapshot["cases"][0]["id"] = "other-case-label"
        with self.assertRaisesRegex(ValueError, "case membership differs"):
            qualifier.verify_task_binding_snapshot(self.rows, self.registry, self.snapshot)

    def test_refuses_missing_binding(self):
        self.snapshot["cases"][0].pop("taskArtifactBinding")
        with self.assertRaisesRegex(ValueError, "exact case and physical source identity"):
            qualifier.verify_task_binding_snapshot(self.rows, self.registry, self.snapshot)

    def test_refuses_duplicate_snapshot_case(self):
        self.snapshot["cases"].append(dict(self.snapshot["cases"][0]))
        with self.assertRaisesRegex(ValueError, "exact qualification population"):
            qualifier.verify_task_binding_snapshot(self.rows, self.registry, self.snapshot)

    def test_refuses_duplicate_physical_source_across_distinct_case_labels(self):
        second_case = {
            "id": "different-case-label",
            "taskArtifactBinding": {
                "caseId": "different-case-label",
                "membership": {
                    "sourceId": self.physical_id,
                    "split": "train",
                    "registryDigest": self.registry["digest"],
                },
            },
        }
        self.rows.append({"id": second_case["id"], "sourceId": self.physical_id, "split": "train"})
        self.snapshot["cases"].append(second_case)
        with self.assertRaisesRegex(ValueError, "every physical source exactly once"):
            qualifier.verify_task_binding_snapshot(self.rows, self.registry, self.snapshot)


if __name__ == "__main__":
    unittest.main()
