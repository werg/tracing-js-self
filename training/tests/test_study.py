"""Study selection/sealing/provenance controls. All scores here are test fixtures."""
import copy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from tinker_js import experiments as study
from tinker_js import runner


class NoopBridge:
    def __init__(self, *_):
        pass
    def __enter__(self):
        return self
    def __exit__(self, *_):
        pass


class StudyTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.repo = Path(self.temp.name)
        self.root = self.repo / "study"
        self.rows = []
        for i in range(16):
            split = "train" if i < 12 else "validation" if i < 14 else "test"
            metadata = {"features": ["scalar"], "tier": 1, "externalCalls": int(i == 11)}
            task = {"id": f"task-{i:02d}", "family": f"family-{i}", "source": f"function run(){{return {i};}}",
                    "entry": "run", "args": [], "fixture": {"calls": []}, "metadata": metadata, "split": split}
            self.rows.append({"id": task["id"], "family": task["family"], "sourceHash": f"hash-{i}",
                              "task": task, "metadata": metadata, "split": split,
                              "messages": [{"role": "assistant", "content": "fixture only"}]})
        runner.write_jsonl(self.repo / "input.jsonl", [row["task"] for row in self.rows])
        self.config = runner.load_config(overrides={"dataset": "input.jsonl", "final_test": False})
        self.manifest = {"split_manifest": {"hash": "test-fixture-only"},
                         "counts": {"train": 12, "validation": 2, "test": 2}}

    def tearDown(self):
        self.temp.cleanup()

    def make_plan(self, **kwargs):
        def export(repo, config, output, bridge):
            if config.get("diagnostic_only"):
                tasks = runner.read_jsonl(Path(config["dataset"]))
                rows = [{"id": row["id"], "family": row["family"], "sourceHash": "fixture-hash",
                         "task": copy.deepcopy(row), "metadata": row["metadata"], "split": "test"} for row in tasks]
                for row in rows:
                    row["task"].pop("freshRandomCalls", None)
                    row["task"]["fixture"] = {"calls": [{"operation": "fixture.freeze", "result": 0.125}]}
                return rows, {"dataset_hash": "fixture-diagnostic-export",
                    "implementation_hash": runner.implementation_identity(repo)["hash"],
                    "input_sha256": study._sha(Path(config["dataset"]))}
            return copy.deepcopy(self.rows), {**self.manifest,
                "implementation_hash": runner.implementation_identity(repo)["hash"],
                "input_sha256": study._sha(self.repo / "input.jsonl")}
        with patch.object(runner, "Bridge", NoopBridge), \
                patch.object(runner, "export_dataset", side_effect=export), \
                patch.object(study, "TinkerAdapter", side_effect=AssertionError("Planning must not create a model adapter")):
            return study.create_plan(self.repo, self.config, self.root, **kwargs)

    def result(self, name, accuracy=.8, cost=100, **kwargs):
        return {"id": name, "backend": "tinker", "split": "validation",
                "summary": {"complete_execution_accuracy": accuracy, "tokens_per_verified_success": cost,
                            "successes": round(10 * accuracy), "all_generated_tokens": 800},
                "config": {**self.config, "effort": .2, "prompt_style": "concise", "trace_format": "compact"},
                "checkpoint": {"training_path": "tinker://fixture/weights/one",
                               "sampler_path": "tinker://fixture/sampler_weights/one"}, **kwargs}

    def selection(self, plan, stage, result):
        runner.atomic_json(self.root / "selections" / f"{stage}.json", study._signed({
            "stage": stage, "plan_hash": plan["hash"], "selected": result, "results": [result]}))

    def test_plan_freezes_explicit_population_and_separates_seeds_without_compute(self):
        plan = self.make_plan()
        frozen = runner.read_jsonl(Path(plan["dataset"]["path"]))
        self.assertEqual([row["split"] for row in frozen], [row["split"] for row in self.rows])
        self.assertEqual(plan["base_config"]["evaluation_seed"], 17)
        self.assertEqual(plan["base_config"]["split_seed"], 17)
        self.assertEqual(plan["training_seeds"], [17, 29, 47])
        self.assertFalse(plan["base_config"]["final_test"])
        self.assertIsNone(plan["base_config"]["max_eval_tasks"])
        self.assertEqual(study.read_plan(self.root / "plan.json", self.repo), plan)
        self.assertFalse(plan["claims"]["model_compute_performed"])
        with self.assertRaisesRegex(ValueError, "already exists"):
            self.make_plan()

    def test_plan_rejects_tampered_data_and_configuration(self):
        plan = self.make_plan()
        Path(plan["dataset"]["path"]).write_text("{}\n")
        with self.assertRaisesRegex(ValueError, "dataset changed"):
            study.read_plan(self.root / "plan.json", self.repo)
        saved = json.loads((self.root / "plan.json").read_text())
        saved["base_config"]["model"] = "different-model"
        runner.atomic_json(self.root / "plan.json", saved)
        with self.assertRaisesRegex(ValueError, "checksum"):
            study.read_plan(self.root / "plan.json", self.repo)

    def test_plan_freezes_configured_cap_without_removing_training_examples(self):
        self.config["max_eval_tasks"] = 1
        plan = self.make_plan()
        selected = plan["base_config"]["evaluation_manifest"]
        self.assertEqual(len(selected["train"]), 12)
        self.assertEqual(len(selected["validation"]), 1)
        self.assertEqual(len(selected["test"]), 1)
        self.assertEqual(len(runner.read_jsonl(Path(plan["dataset"]["path"]))), 16)
        self.assertEqual(plan["dataset"]["evaluation_population"]["validation"]["method"],
                         "seeded_tier_and_family_round_robin")
        self.assertIsNone(plan["base_config"]["max_eval_tasks"])

    def test_plan_resolves_relative_explicit_selection_and_keeps_its_order(self):
        declared = {"splits": {"validation": ["task-13", "task-12"], "test": ["task-15"]}}
        runner.atomic_json(self.repo / "selected.json", declared)
        self.config["evaluation_manifest"] = "selected.json"
        plan = self.make_plan()
        self.assertEqual(plan["base_config"]["evaluation_manifest"]["validation"], ["task-13", "task-12"])
        self.assertEqual(plan["base_config"]["evaluation_manifest"]["test"], ["task-15"])

    def test_plan_rejects_code_change_across_individually_verified_exports(self):
        with patch.object(runner, "implementation_identity", side_effect=[
                {"hash": "before"}, {"hash": "before"}, {"hash": "after"}]):
            with self.assertRaisesRegex(ValueError, "implementation changed"):
                self.make_plan()
        self.assertFalse((self.root / "plan.json").exists())

    def test_diagnostics_require_declared_scope_and_are_frozen_separately(self):
        diagnostic = copy.deepcopy(self.rows[0]["task"])
        diagnostic["split"] = "test"
        diagnostic["freshRandomCalls"] = ["fixture-only"]
        diagnostic["metadata"].update(diagnosticOnly=True, evaluationRole="familiar_inputs")
        runner.write_jsonl(self.repo / "diagnostic.jsonl", [diagnostic])
        plan = self.make_plan(diagnostic_datasets={"familiar_inputs": "diagnostic.jsonl"})
        self.assertEqual(len(plan["diagnostic_datasets"]), 1)
        self.assertEqual(plan["dataset"]["counts"]["train"], 12)
        self.assertNotEqual(plan["diagnostic_datasets"][0]["path"], plan["dataset"]["path"])
        frozen = runner.read_jsonl(Path(plan["diagnostic_datasets"][0]["path"]))[0]
        self.assertNotIn("freshRandomCalls", frozen)
        self.assertEqual(frozen["fixture"]["calls"][0]["result"], 0.125)

    def test_diagnostic_training_split_is_rejected_during_planning(self):
        diagnostic = copy.deepcopy(self.rows[0]["task"])
        diagnostic["metadata"].update(diagnosticOnly=True, evaluationRole="familiar_inputs")
        runner.write_jsonl(self.repo / "diagnostic.jsonl", [diagnostic])
        with self.assertRaisesRegex(ValueError, "split=test"):
            self.make_plan(diagnostic_datasets={"familiar_inputs": "diagnostic.jsonl"})

    def test_selection_uses_accuracy_constraint_and_counts_failure_cost(self):
        accurate = self.result("accurate", .9, 1111)
        brief_but_wrong = self.result("brief", .6, 1167)
        comparable = self.result("comparable", .89, 900)
        self.assertEqual(study.choose_job([accurate, brief_but_wrong, comparable], .02)["id"], "comparable")
        for change in ({"backend": "fixture"}, {"split": "test"}, {"split": "train"}):
            with self.assertRaisesRegex(ValueError, "live validation"):
                study.choose_job([{**accurate, **change}], .02)

    def test_baseline_grid_has_same_population_seed_and_no_training(self):
        plan = self.make_plan()
        jobs = study.stage_jobs(plan, self.root, "baseline")
        self.assertEqual(len(jobs), 8)
        self.assertTrue(all(job["kind"] == "evaluate" for job in jobs))
        self.assertEqual({job["config"]["evaluation_seed"] for job in jobs}, {17})
        self.assertEqual({job["config"]["dataset"] for job in jobs}, {plan["dataset"]["path"]})
        self.assertEqual({job["config"]["prompt_style"] for job in jobs}, {"standard", "concise"})
        import re
        self.assertTrue(all(re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}", job["id"]) for job in jobs))

    def test_dependent_stages_inherit_validation_choices_and_fixed_sft_anchor(self):
        self.config["rl_objective"] = "correctness"
        plan = self.make_plan()
        selected = self.result("selected")
        for stage in ("baseline", "learning-rate", "trace", "rl-learning-rate"):
            self.selection(plan, stage, selected)
        jobs = study.stage_jobs(plan, self.root, "objective")
        self.assertEqual([job["kind"] for job in jobs], ["reuse", "rl", "rl"])
        self.assertEqual(jobs[1]["config"]["length_penalty"], 0)
        self.assertGreater(jobs[2]["config"]["length_penalty"], 0)
        self.assertEqual(jobs[1]["config"]["rl_objective"], "correctness")
        self.assertEqual(jobs[2]["config"]["rl_objective"], "compression")
        self.assertTrue(all(job["config"]["rl_objective"] == "correctness"
                            for job in study.stage_jobs(plan, self.root, "rl-learning-rate")))
        for job in jobs[1:]:
            self.assertEqual(job["config"]["initial_sft_checkpoint"], selected["checkpoint"])
            self.assertEqual(job["config"]["trace_format"], "compact")
            self.assertFalse(job["config"]["final_test"])

    def test_rl_study_cannot_use_a_baseline_as_its_sft_optimizer_anchor(self):
        plan = self.make_plan()
        selected = self.result("selected")
        for stage in ("baseline", "learning-rate"):
            self.selection(plan, stage, selected)
        self.selection(plan, "trace", {**selected, "checkpoint": {"training_path": None, "sampler_path": None}})
        with self.assertRaisesRegex(ValueError, "trained SFT checkpoint"):
            study.stage_jobs(plan, self.root, "rl-learning-rate")

    def test_repeat_seeds_keep_split_and_evaluation_seeds_fixed(self):
        plan = self.make_plan()
        selected = self.result("selected")
        selected["config"]["rl_steps"] = 5
        for stage in ("baseline", "learning-rate", "trace", "rl-learning-rate", "objective"):
            self.selection(plan, stage, selected)
        jobs = study.stage_jobs(plan, self.root, "repeat")
        self.assertEqual([job["config"]["seed"] for job in jobs], [17, 29, 47])
        self.assertEqual({job["config"]["split_seed"] for job in jobs}, {17})
        self.assertEqual({job["config"]["evaluation_seed"] for job in jobs}, {17})
        self.assertTrue(all(job["config"]["initial_sft_checkpoint"] is None for job in jobs))

    def test_no_tuning_after_test_seal_and_no_training_without_learnability(self):
        self.make_plan()
        with self.assertRaisesRegex(ValueError, "learnability"):
            study.run_stage(self.repo, self.root / "plan.json", "learning-rate")
        runner.atomic_json(self.root / "test-seal.json", {"test": "fixture seal"})
        with self.assertRaisesRegex(ValueError, "Final test was opened"):
            study.run_stage(self.repo, self.root / "plan.json", "baseline")

    def test_tampered_validation_selection_cannot_materialize_jobs(self):
        plan = self.make_plan()
        self.selection(plan, "baseline", self.result("base"))
        path = self.root / "selections/baseline.json"
        value = json.loads(path.read_text())
        value["selected"]["config"]["effort"] = .9
        runner.atomic_json(path, value)
        with self.assertRaisesRegex(ValueError, "checksum"):
            study.stage_jobs(plan, self.root, "learning-rate")

    def test_tiny_learnability_set_includes_external_protocol_and_no_holdout(self):
        tiny = study.tiny_examples(self.rows, 8)
        self.assertEqual(len(tiny), 8)
        self.assertTrue(any(row["metadata"]["externalCalls"] for row in tiny))
        self.assertTrue(all(row["split"] == "train" for row in tiny))
        with self.assertRaises(ValueError):
            study.tiny_examples(self.rows, 17)

    def test_empty_or_invalid_sweep_is_rejected_before_export(self):
        for values in ([], [0.2, 0.2], [1.0], [-0.1], [True]):
            with self.subTest(values=values), self.assertRaises(ValueError):
                self.make_plan(efforts=values)

    def test_full_study_rejects_disabled_learning_or_compression(self):
        for key in ("sft_epochs", "rl_steps", "length_penalty"):
            original = self.config[key]
            self.config[key] = 0
            with self.subTest(key=key), self.assertRaisesRegex(ValueError, "full study requires"):
                self.make_plan()
            self.config[key] = original

    def test_cached_fixture_result_never_becomes_final_or_diagnostic_evidence(self):
        plan = self.make_plan()
        job = study.stage_jobs(plan, self.root, "baseline")[0]
        output = Path(job["config"]["output_dir"])
        forged = self.result(job["id"], backend="fixture", kind=job["kind"],
                             config=job["config"], plan_hash=plan["hash"], job_hash=runner.digest(job))
        runner.atomic_json(output / "job-result.json", forged)
        with self.assertRaisesRegex(ValueError, "real Tinker"):
            study.execute_job(self.repo, plan, self.root, job)
        with self.assertRaisesRegex(ValueError, "real Tinker"):
            study.validate_result_evidence({**forged, "backend": "tinker", "plan_hash": "wrong"}, plan)

    def test_cached_evidence_cannot_shrink_the_predeclared_population(self):
        plan = self.make_plan()
        job = study.stage_jobs(plan, self.root, "baseline")[0]
        output = Path(job["config"]["output_dir"])
        runner.write_jsonl(output / "dataset.jsonl", self.rows)
        runner.atomic_json(output / "dataset-manifest.json", {
            "dataset_hash": runner.digest(self.rows), "implementation_hash": plan["implementation_hash"],
            "input_sha256": plan["dataset"]["sha256"]})
        truncated_config = {**job["config"], "evaluation_manifest": {"validation": ["task-12"]}}
        runner.evaluation_selection(self.rows, truncated_config, output, "validation")
        result = self.result(job["id"], kind="evaluate", config=job["config"], plan_hash=plan["hash"])
        with self.assertRaisesRegex(ValueError, "population differs"):
            study.validate_result_evidence(result, plan)

    def test_manual_diagnostic_uses_plan_dataset_and_selected_baseline(self):
        plan = self.make_plan()
        baseline = self.result("base")
        self.selection(plan, "baseline", baseline)
        with patch.object(study, "live_diagnostic", return_value={"status": "prepared"}) as diagnostic:
            status = study.main(["learnability", "--repo", str(self.repo), "--plan", str(self.root / "plan.json"),
                                 "--config", str(self.repo / "unused-config.json")])
        self.assertEqual(status, 0)
        self.assertEqual(diagnostic.call_args.args[1]["dataset"], plan["dataset"]["path"])
        self.assertEqual(diagnostic.call_args.args[1]["effort"], .2)
        self.assertEqual(diagnostic.call_args.args[2], self.root / "diagnostics")

    def test_prepared_gate_is_eligible_for_live_all_stage_execution(self):
        plan = self.make_plan()
        self.selection(plan, "baseline", self.result("base"))
        runner.atomic_json(self.root / "diagnostics/learnability.json", {
            "status": "prepared", "optimizer_updates": 0, "update_pending": False})
        with patch.object(study, "run_stage"), patch.object(study, "study_report", return_value={}), \
                patch.object(study, "live_diagnostic", return_value={}) as diagnostic:
            status = study.main(["run", "--repo", str(self.repo), "--plan", str(self.root / "plan.json"), "--stage", "all"])
        self.assertEqual(status, 0)
        diagnostic.assert_called_once()
        self.assertTrue(diagnostic.call_args.kwargs["live"])
        self.assertTrue(diagnostic.call_args.kwargs["learnability"])

    def test_offline_preparation_cannot_erase_live_diagnostic_recovery_evidence(self):
        output = self.repo / "diagnostics"
        path = output / "learnability.json"
        for live in (False, True):
            for progress in ({"optimizer_updates": 1}, {"update_pending": True}, {"model_sampled": True}):
                previous = {"status": "blocked_or_failed", "backend": "tinker", **progress}
                runner.atomic_json(path, previous)
                before = path.read_bytes()
                with self.subTest(live=live, progress=progress), \
                        patch.object(runner, "Bridge", side_effect=AssertionError("Protected evidence must be checked first")), \
                        self.assertRaisesRegex(ValueError, "already sampled or submitted"):
                    study.live_diagnostic(self.repo, self.config, output, live=live, learnability=True)
                self.assertEqual(path.read_bytes(), before)


if __name__ == "__main__":
    unittest.main()
