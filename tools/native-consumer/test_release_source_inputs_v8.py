"""Original task/input correspondence controls; no execution qualification."""
from __future__ import annotations

import copy
import tempfile
import unittest
from pathlib import Path

from test_release_v8 import make_source_campaign, release


class OriginalReleaseSourceTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="release-original-source-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.snapshot, self.documents, self.save = make_source_campaign(self.root)
        self.task = self.documents["population.json"]["tasks"][0]
        self.fixture = self.task["fixture"]
        self.side = self.documents["selected.source.json"]["sidecar"]
        self.original = self.side["sourceArtifact"]["sidecar"]

    def check(self):
        self.save()
        return release.original_source_members(self.snapshot, self.root)

    def test_case_label_preserves_a_distinct_physical_source_id(self):
        self.assertEqual(self.check(), [{"caseId": "selected", "sourceId": "selected-physical-0123456789ab",
                                        "path": "source-qualification/selected.source.json"}])

    def test_changed_original_source_is_not_the_selected_task(self):
        self.original["referenceInput"]["source"] = "function run(value){return 2;}"
        with self.assertRaisesRegex(ValueError, "reference differs"):
            self.check()

    def test_changed_original_entry_is_not_the_selected_task(self):
        self.original["referenceInput"]["entry"] = "other"
        with self.assertRaisesRegex(ValueError, "reference differs"):
            self.check()

    def test_changed_arguments_are_not_the_selected_task(self):
        self.original["referenceInput"]["inputGraph"]["roots"][0] = ["num", 2]
        with self.assertRaisesRegex(ValueError, "argument graph"):
            self.check()

    def test_changed_host_fixture_is_not_the_selected_task(self):
        self.original["referenceInput"]["fixture"]["calls"].append({"operation": "extra"})
        with self.assertRaisesRegex(ValueError, "host fixture"):
            self.check()

    def test_changed_settlement_order_is_not_the_selected_task(self):
        self.original["referenceInput"]["fixture"]["settlementOrder"] = [1, 0]
        with self.assertRaisesRegex(ValueError, "host fixture"):
            self.check()

    def test_changed_original_family_is_not_the_selected_task(self):
        self.original["sourceFamily"] = "other-family"
        with self.assertRaisesRegex(ValueError, "family or ancestry"):
            self.check()

    def test_changed_original_ancestry_is_not_the_selected_task(self):
        self.original["ancestorIds"] = ["other-template"]
        with self.assertRaisesRegex(ValueError, "family or ancestry"):
            self.check()

    def test_ancestry_uses_existing_normalized_set_identity(self):
        self.original["ancestorIds"] += ["controlled-source", "controlled-template"]
        self.assertEqual(len(self.check()), 1)

    def test_original_producer_and_task_identities_are_bound(self):
        for field, value in (("producerRevision", "c" * 40), ("taskId", "unselected")):
            with self.subTest(field=field):
                before = self.original[field]
                self.original[field] = value
                with self.assertRaisesRegex(ValueError, "producer or task"):
                    self.check()
                self.original[field] = before

    def test_expected_physical_source_id_cannot_be_replaced_by_another_artifact(self):
        self.side["datasetBinding"]["sourceId"] = "other-physical-source"
        with self.assertRaisesRegex(ValueError, "physical source"):
            self.check()

    def test_expected_split_cannot_be_changed(self):
        self.side["datasetBinding"]["split"] = "test"
        with self.assertRaisesRegex(ValueError, "physical source, registry or split"):
            self.check()

    def test_original_rng_seed_uses_the_frozen_nullish_fallback(self):
        self.fixture["randomSeed"] = None
        self.fixture["seeds"] = {"guestRng": 19}
        self.original["referenceInput"]["randomSeed"] = 19
        self.assertEqual(len(self.check()), 1)
        self.original["referenceInput"]["randomSeed"] = 20
        with self.assertRaisesRegex(ValueError, "RNG seed"):
            self.check()

    def test_module_tasks_require_a_declared_correspondence_profile(self):
        self.task["kind"] = "module"
        with self.assertRaisesRegex(ValueError, "module-task correspondence"):
            self.check()

    def test_orchestration_teacher_presence_is_bound_to_the_original_task(self):
        self.side["orchestrationTranscript"] = {"controlled": True}
        with self.assertRaisesRegex(ValueError, "orchestration teacher"):
            self.check()
        self.fixture["orchestrationTeacher"] = True
        self.assertEqual(len(self.check()), 1)

    def test_repeated_invocations_preserve_count_order_and_each_input(self):
        first = copy.deepcopy(self.fixture)
        second = copy.deepcopy(first)
        second["argsGraph"]["roots"][0] = ["num", 2]
        self.fixture["sessionCases"] = [first, second]
        reference = self.original["referenceInput"]
        calls = [copy.deepcopy(reference), copy.deepcopy(reference)]
        calls[1]["inputGraph"]["roots"][0] = ["num", 2]
        self.original["referenceInput"] = {"source": reference["source"], "entry": reference["entry"], "invocations": calls}
        self.assertEqual(len(self.check()), 1)
        calls.reverse()
        with self.assertRaisesRegex(ValueError, "argument graph"):
            self.check()
        calls.reverse()
        calls.pop()
        with self.assertRaisesRegex(ValueError, "invocation count"):
            self.check()

    def test_direct_protocol_reference_can_omit_only_an_empty_host_plan(self):
        self.side.update(self.original)
        self.side["schema"] = "semantic-protocol-host-region-evidence/1"
        del self.side["sourceArtifact"]
        del self.side["referenceInput"]["fixture"]
        self.assertEqual(len(self.check()), 1)
        self.fixture["fixture"]["calls"].append({"operation": "required"})
        with self.assertRaisesRegex(ValueError, "host fixture"):
            self.check()

    def test_source_input_bytes_still_require_the_complete_journal_inventory(self):
        with (self.root / "selected.source.json").open("a") as stream:
            stream.write(" ")
        with self.assertRaisesRegex(ValueError, "complete campaign inventory"):
            release.original_source_members(self.snapshot, self.root)


if __name__ == "__main__":
    unittest.main()
