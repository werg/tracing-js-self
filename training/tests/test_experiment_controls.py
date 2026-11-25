import copy
import json
from pathlib import Path
import random
import tempfile
import unittest

from tinker_js.learning import (choose_validation_checkpoint, compression_coefficient, curriculum_pick,
    execution_advantages, sft_epoch_rows, task_metadata, update_curriculum)
from tinker_js.metrics import paired_statistics, summarize_records
from tinker_js.runner import (BridgeError, RolloutError, compression_reward, evaluate, evaluation_selection,
    final_test, load_config, load_state, record_validation, rollout, save_state, split_examples,
    train_rl, train_sft, write_jsonl)
from test_runner import ControlledBridge, ScriptedAdapter, row, sample


def record(success, tokens, family="a", task="a", repeat=0):
    return {"task_id": task, "family": family, "split_component": family,
            "source_hash": family, "task_hash": task, "seed": 17 + repeat, "repeat": repeat,
            "generated_tokens": tokens, "complete": success,
            "grade": {"success": success, "reward": float(success), "reason": "outcome_mismatch"}}


def candidate(stage, accuracy, tokens, training=True):
    return {"stage": stage, "split": "validation", "summary": {
        "complete_execution_accuracy": accuracy, "tokens_per_verified_success": tokens,
        "mean_generated_tokens": tokens * accuracy},
        "training_path": "training/" + stage if training else None,
        "sampler_path": "sampling/" + stage if training else None}


class RecordingAdapter(ScriptedAdapter):
    def __init__(self, samples):
        super().__init__(samples)
        self.sampling_paths = []
        self.training_paths = []
        self.sft_calls = []
        self.rl_options = []
        self.reference = None

    def create_sampling_client(self, checkpoint=None):
        self.sampling_paths.append(checkpoint)

    def create_training_client(self, checkpoint=None):
        self.training_paths.append(checkpoint)

    def sft_train(self, examples, **options):
        self.sft_calls.append((copy.deepcopy(examples), options))
        return {"loss": 1.0}

    def rl_train(self, trajectories, **options):
        self.rl_options.append(options)
        return super().rl_train(trajectories, **options)

    def set_reference_checkpoint(self, checkpoint):
        self.reference = checkpoint


class RewardControlsTests(unittest.TestCase):
    def setUp(self):
        self.config = load_config(overrides={"length_scale_tokens": 100, "length_penalty": .4})

    def test_coefficient_linearly_controls_all_success_groups(self):
        rows = [record(True, 10), record(True, 50), record(True, 90)]
        full = execution_advantages(rows, self.config, .4)
        small = execution_advantages(rows, self.config, .04)
        self.assertEqual(full["correctness_advantages"], [0, 0, 0])
        for first, second in zip(full["advantages"], small["advantages"]):
            self.assertAlmostEqual(first, second * 10)
        self.assertGreater(full["advantages"][0], 0)
        self.assertLess(full["advantages"][-1], 0)
        self.assertAlmostEqual(sum(full["advantages"]), 0)
        self.assertEqual(execution_advantages(rows, self.config, 0)["advantages"], [0, 0, 0])

    def test_failed_executions_receive_no_length_credit(self):
        rows = [record(False, 0), record(True, 20), record(True, 80)]
        result = execution_advantages(rows, self.config)
        self.assertEqual(result["group_kind"], "mixed_success")
        self.assertEqual(result["length_contributions"][0], 0)
        self.assertLess(result["advantages"][0], min(result["advantages"][1:]))
        self.assertAlmostEqual(sum(result["advantages"]), 0)
        self.assertEqual(compression_reward(False, 0, self.config), 0)

    def test_single_success_has_only_correctness_signal(self):
        result = execution_advantages([record(False, 1), record(True, 70)], self.config)
        self.assertEqual(result["length_advantages"], [0, 0])
        self.assertEqual(result["advantages"], [-1, 1])

    def test_failure_and_equal_length_groups_are_zero(self):
        for rows in ([record(False, 1), record(False, 99)], [record(True, 50), record(True, 50)]):
            result = execution_advantages(rows, self.config)
            self.assertTrue(result["zero_advantage_group"])
            self.assertEqual(result["advantages"], [0, 0])

    def test_fixed_scale_clips_and_does_not_change_with_budget(self):
        rows = [record(True, 1), record(True, 100), record(True, 1000)]
        first = execution_advantages(rows, self.config)
        second = execution_advantages(rows, dict(self.config, max_generated_tokens=9000))
        self.assertEqual(first, second)
        self.assertEqual(first["length_advantages"][1], first["length_advantages"][2])
        self.assertGreater(compression_reward(True, 10000, self.config), 0)

    def test_mean_centered_mode_retains_binary_reward_scale(self):
        result = execution_advantages([record(False, 1), record(True, 1)],
                                      dict(self.config, advantage_mode="centered"))
        self.assertEqual(result["advantages"], [-.5, .5])

    def test_compression_schedule_requires_gate_and_respects_correctness_control(self):
        config = dict(self.config, compression_warmup_steps=2, compression_ramp_steps=4)
        self.assertEqual([compression_coefficient(config, step) for step in range(7)],
                         [0, 0, .1, .2, .30000000000000004, .4, .4])
        self.assertEqual(compression_coefficient(config, 100, gate_open=False), 0)
        self.assertEqual(compression_coefficient(dict(config, rl_objective="correctness"), 100), 0)

    def test_invalid_configuration_cannot_silently_change_objective(self):
        for override in ({"length_scale_tokens": 0}, {"reference_kl_coef": float("nan")},
                         {"rl_learning_rate": -1}, {"rl_loss_fn": "unrecognized"},
                         {"rl_loss_fn_config": {"clip_low_threshold": .8}},
                         {"rl_loss_fn": "ppo", "rl_loss_fn_config": {"clip_low_threshold": 1.1}},
                         {"max_eval_tasks": 0}, {"sft_weighting": "mystery"},
                         {"curriculum": {"minimum_groups": 100, "window_groups": 2}}):
            with self.subTest(override=override), self.assertRaises(ValueError):
                load_config(overrides=override)


class EvaluationDesignTests(unittest.TestCase):
    def test_full_split_is_default_and_capped_selection_covers_families(self):
        rows = [row(f"{family}-{index}", family=family, split="test")
                for family in ("a", "b", "c", "d") for index in range(5)]
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            full, manifest = evaluation_selection(rows, load_config(), path / "full", "test")
            self.assertEqual(len(full), 20)
            self.assertEqual(manifest["method"], "full_split")
            capped, manifest = evaluation_selection(rows, load_config(overrides={"max_eval_tasks": 4}), path / "cap", "test")
            self.assertEqual({item["family"] for item in capped}, {"a", "b", "c", "d"})
            self.assertEqual(manifest["method"], "seeded_tier_and_family_round_robin")

    def test_manifest_rejects_wrong_split_duplicates_and_population_change(self):
        rows = [row("a", split="test"), row("b", split="validation")]
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            for ids in (["b"], ["a", "a"]):
                with self.assertRaises(ValueError):
                    evaluation_selection(rows, load_config(overrides={"evaluation_manifest": {"test": ids}}), path, "test")
            selection, manifest = evaluation_selection(rows, load_config(overrides={"evaluation_manifest": {"test": ["a"]}}), path, "test")
            self.assertEqual([item["id"] for item in selection], ["a"])
            with self.assertRaisesRegex(ValueError, "frozen evaluation selection"):
                evaluation_selection(rows + [row("c", split="test")],
                    load_config(overrides={"evaluation_manifest": {"test": ["a"]}}), path, "test")

    def test_evaluation_seeds_are_independent_of_training_seed(self):
        rows = [row("a", split="test")]
        with tempfile.TemporaryDirectory() as directory:
            seeds = []
            for seed in (1, 2):
                path = Path(directory) / str(seed)
                config = load_config(overrides={"seed": seed})
                evaluate(ControlledBridge(), ScriptedAdapter([sample("complete")]), rows, config, path, "baseline")
                seeds.append(json.loads((path / "evaluations/baseline-test.jsonl").read_text())["seed"])
            self.assertEqual(*seeds)

    def test_templates_and_generator_lineage_are_split_identities(self):
        first = dict(row("a", family="a"), metadata={"template": "shared-template"})
        second = dict(row("b", family="b"), metadata={"template": "shared-template"})
        third = dict(row("c", family="c"), metadata={"lineage": ["b"]})
        rows = [first, second, third] + [row(str(index)) for index in range(8)]
        output, manifest = split_examples(rows, 17, .2, .2)
        self.assertEqual(len({item["split_component"] for item in output[:3]}), 1)
        conflict = copy.deepcopy(rows)
        conflict[0]["split"] = "train"
        conflict[2]["split"] = "test"
        with self.assertRaisesRegex(ValueError, "contradictory"):
            split_examples(conflict, 17, .2, .2)

    def test_diagnostics_allow_all_test_export_but_never_training_or_selection(self):
        diagnostic = dict(row("diagnostic", split="test"), metadata={"diagnosticOnly": True,
                          "evaluationRole": "familiar_inputs"})
        config = load_config(overrides={"diagnostic_only": True, "holdout_fraction": 0, "validation_fraction": 0})
        self.assertTrue(config["evaluation_only"])
        output, manifest = split_examples([diagnostic], 17, 0, 0, evaluation_only=True)
        self.assertEqual(output[0]["split"], "test")
        with self.assertRaisesRegex(ValueError, "no training"):
            split_examples([diagnostic], 17, 0, 0)
        with tempfile.TemporaryDirectory() as directory:
            args = (None, RecordingAdapter([]), [diagnostic], config, Path(directory), {}, random.Random(1))
            for trainer in (train_sft, train_rl):
                with self.assertRaisesRegex(ValueError, "prohibited"):
                    trainer(*args)
            with self.assertRaisesRegex(ValueError, "cannot drive validation"):
                record_validation(*args, "diagnostic", None, None)

    def test_initial_sft_checkpoint_initializes_a_fresh_rl_experiment(self):
        initial = {"training_path": "tinker://training/source", "sampler_path": "tinker://sampler/source"}
        config = load_config(overrides={"initial_sft_checkpoint": initial})
        with tempfile.TemporaryDirectory() as directory:
            state, rng = load_state(Path(directory), config,
                {"dataset_hash": "corpus", "split_manifest": {"hash": "splits"}}, False)
            self.assertEqual(state["phase"], "sft_done")
            self.assertEqual(state["training_path"], initial["training_path"])
            self.assertEqual(state["sft_sampler_path"], initial["sampler_path"])
            self.assertEqual(state["sft_batches_completed"], 0)


class CurriculumTests(unittest.TestCase):
    def setUp(self):
        self.rows = [dict(row(f"{tier}-{index}", split="train"), metadata={"tier": tier, "features": ["tier-" + str(tier)]})
                     for tier in (1, 2, 3) for index in range(8)]
        self.config = load_config(overrides={"curriculum": {"enabled": True, "groups_per_tier": 2,
            "window_groups": 2, "minimum_groups": 2, "advance_success_rate": .5, "retention_fraction": .25}})

    def test_sft_progresses_and_rehearses_without_dropping_any_task(self):
        ordered = sft_epoch_rows(self.rows, self.config, 0)
        self.assertEqual(ordered, sft_epoch_rows(self.rows, self.config, 0))
        self.assertEqual({item["id"] for item in ordered}, {item["id"] for item in self.rows})
        self.assertGreater(len(ordered), len(self.rows))
        self.assertTrue(all(task_metadata(item)["tier"] == 1 for item in ordered[:8]))
        self.assertGreater(sum(task_metadata(item)["tier"] == 1 for item in ordered), 8)

    def test_unsolved_tier_does_not_advance_and_successful_tier_does(self):
        state, rng = {}, random.Random(1)
        for _ in range(2):
            chosen, selection = curriculum_pick(self.rows, self.config, state, rng)
            self.assertEqual(task_metadata(chosen)["tier"], 1)
            result = update_curriculum(self.rows, self.config, state, selection, [record(False, 1)])
        self.assertTrue(result["needs_supervision"])
        self.assertEqual(state["curriculum"]["active_tier"], 1)
        for _ in range(2):
            chosen, selection = curriculum_pick(self.rows, self.config, state, rng)
            update_curriculum(self.rows, self.config, state, selection, [record(True, 10)])
        self.assertEqual(state["curriculum"]["active_tier"], 2)
        picked = [curriculum_pick(self.rows, self.config, state, rng)[0] for _ in range(100)]
        self.assertEqual({task_metadata(item)["tier"] for item in picked}, {1, 2})


class ValidationSelectionTests(unittest.TestCase):
    def test_accuracy_constraint_and_minimum_saving_both_apply(self):
        config = load_config(overrides={"accuracy_tolerance": .02, "min_token_saving": .2})
        base = candidate("baseline", .95, 100, False)
        too_inaccurate = candidate("short-wrong", .8, 10)
        too_small_saving = candidate("slightly-short", .94, 90)
        useful = candidate("compressed", .94, 70)
        self.assertEqual(choose_validation_checkpoint([base, too_inaccurate, too_small_saving], config)["stage"], "baseline")
        self.assertEqual(choose_validation_checkpoint([base, useful], config)["stage"], "compressed")
        fake_test = dict(candidate("test-cheat", 1, 1), split="test")
        self.assertEqual(choose_validation_checkpoint([base, fake_test], config)["stage"], "baseline")

    def test_interrupted_validation_resumes_same_checkpoint_and_population(self):
        config = load_config()
        rows = [row("a", split="validation"), row("b", split="validation")]
        state = {"phase": "sft", "evaluations": []}
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            with self.assertRaises(RolloutError):
                record_validation(ControlledBridge(), RecordingAdapter([sample("complete")]), rows, config,
                                  path, state, random.Random(1), "sft-1", "training/1", "sampling/1")
            self.assertEqual(state["pending_validation"]["sampler_path"], "sampling/1")
            adapter = RecordingAdapter([sample("complete")])
            record_validation(ControlledBridge(), adapter, rows, config, path, state,
                              random.Random(1), "sft-1", "training/1", "sampling/1")
            self.assertEqual(len(adapter.histories), 1)
            self.assertIsNone(state["pending_validation"])
            self.assertEqual(state["selected_checkpoint"]["stage"], "sft-1")

    def test_final_test_is_locked_after_validation_selection(self):
        config = load_config()
        rows = [row("a", split="validation"), row("b", split="test")]
        state = {"phase": "sft_done", "evaluations": [], "sft_sampler_path": "sampling/1"}
        adapter = RecordingAdapter([sample("complete")] * 4)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            record_validation(ControlledBridge(), adapter, rows, config, path, state,
                              random.Random(1), "sft-1", "training/1", "sampling/1")
            self.assertFalse((path / "evaluations/baseline-test.jsonl").exists())
            final_test(ControlledBridge(), adapter, rows, config, path, state, random.Random(1))
            self.assertEqual(state["evaluations"], ["baseline-test", "selected-test", "sft-test"])
            with self.assertRaisesRegex(ValueError, "sealed"):
                record_validation(ControlledBridge(), adapter, rows, config, path, state,
                                  random.Random(1), "another", "training/2", "sampling/2")
            state["selected_checkpoint"]["stage"] = "changed"
            with self.assertRaisesRegex(ValueError, "changed after final test"):
                final_test(ControlledBridge(), adapter, rows, config, path, state, random.Random(1))

    def test_accuracy_regression_rolls_back_optimizer_and_closes_compression_gate(self):
        config = load_config(overrides={"rl_steps": 1, "group_size": 2, "validation_every": 1,
                                       "compression_ramp_steps": 0})
        rows = [row("train", split="train"), row("val", split="validation")]
        sft = candidate("sft-final", 1, 10)
        state = {"phase": "sft_done", "rl_steps_completed": 0, "training_path": sft["training_path"],
                 "sampler_path": sft["sampler_path"], "sft_sampler_path": sft["sampler_path"],
                 "compression_gate_open": True, "validation_candidates": [sft], "evaluations": []}
        adapter = RecordingAdapter([sample("complete", 10), sample("wrong", 2),
                                    sample("wrong", 1), sample("complete", 10)])
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            train_rl(ControlledBridge(), adapter, rows, config, path, state, random.Random(1))
            self.assertEqual(len(state["rollback_events"]), 1)
            self.assertEqual(state["rollback_events"][0]["to"], sft["training_path"])
            self.assertIn(sft["training_path"], adapter.training_paths)
            self.assertEqual(adapter.rl_options[0]["learning_rate"], config["rl_learning_rate"])
            metrics = [json.loads(line) for line in (path / "metrics.jsonl").read_text().splitlines()]
            rejected = next(item for item in metrics if item.get("checkpoint_stage") == "rl-000001")
            self.assertFalse(rejected["compression_gate_open"])

    def test_separate_learning_rates_and_fixed_reference_are_forwarded(self):
        config = load_config(overrides={"sft_learning_rate": .001, "rl_learning_rate": .00001,
            "rl_steps": 1, "group_size": 2, "reference_kl_coef": .01, "validation_every": 0})
        rows = [dict(row("a", split="train"), messages=[{"role": "assistant", "content": "target"}])]
        state = {"phase": "created", "sft_batches_completed": 0, "rl_steps_completed": 0,
                 "training_path": None, "evaluations": []}
        adapter = RecordingAdapter([sample("complete"), sample("wrong")])
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            train_sft(None, adapter, rows, config, path, state, random.Random(1))
            self.assertEqual(adapter.sft_calls[0][1]["learning_rate"], .001)
            train_rl(ControlledBridge(), adapter, rows, config, path, state, random.Random(1))
            self.assertEqual(adapter.rl_options[0]["learning_rate"], .00001)
            self.assertEqual(adapter.reference, state["sft_sampler_path"])

    def test_zero_task_advantages_retain_explicit_reference_regularization(self):
        config = load_config(overrides={"rl_steps": 1, "group_size": 2, "reference_kl_coef": .01})
        state = {"phase": "sft_done", "rl_steps_completed": 0, "training_path": "training/sft",
                 "sft_sampler_path": "sampling/sft", "evaluations": []}
        adapter = RecordingAdapter([sample("wrong"), sample("wrong")])
        with tempfile.TemporaryDirectory() as directory:
            train_rl(ControlledBridge(), adapter, [row("a", split="train")], config,
                     Path(directory), state, random.Random(1))
            self.assertEqual(len(adapter.trained[0]), 2)
            self.assertEqual([item["advantage"] for item in adapter.trained[0]], [0, 0])
            self.assertEqual(state["rl_optimizer_updates"], 1)
            self.assertEqual(state["rl_regularization_only_updates"], 1)
            self.assertEqual(state["rl_group_counts"]["useful"], 0)

    def test_interrupted_validation_still_rolls_back_on_resume_without_recounting_update(self):
        config = load_config(overrides={"rl_steps": 1, "group_size": 2, "validation_every": 1})
        rows = [row("train", split="train"), row("val", split="validation")]
        manifest = {"dataset_hash": "corpus", "split_manifest": {"hash": "splits"}}
        sft = candidate("sft-final", 1, 10)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            state, rng = load_state(path, config, manifest, False)
            state.update(phase="sft_done", training_path=sft["training_path"], sampler_path=sft["sampler_path"],
                         sft_sampler_path=sft["sampler_path"], compression_gate_open=True, validation_candidates=[sft])
            save_state(path, state, rng)
            first = RecordingAdapter([sample("complete", 10), sample("wrong", 2)])
            with self.assertRaises(RolloutError):
                train_rl(ControlledBridge(), first, rows, config, path, state, rng)
            state, rng = load_state(path, config, manifest, True)
            self.assertEqual(state["rl_optimizer_updates"], 1)
            self.assertEqual(state["pending_validation"]["stage"], "rl-000001")
            second = RecordingAdapter([sample("wrong", 1), sample("complete", 10)])
            train_rl(ControlledBridge(), second, rows, config, path, state, rng)
            self.assertEqual(state["rl_optimizer_updates"], 1)
            self.assertEqual(second.trained, [])
            self.assertEqual(state["rollback_events"][0]["to"], sft["training_path"])
            self.assertEqual(state["rollback_events"][0]["validation_stage"], "rl-000001")


class DiagnosticsTests(unittest.TestCase):
    def test_failure_cost_features_tail_and_exact_token_categories(self):
        good = record(True, 10)
        good.update(features=["mutation"], tier=2, samples=[{"token_ids": list(range(10)),
                    "token_accounting": {"reasoning": 4, "protocol": 6}}])
        bad = record(False, 90, family="b", task="b")
        bad["grade"]["failureCategory"] = "alias-mismatch"
        summary = summarize_records([good, bad])
        self.assertEqual(summary["tokens_per_verified_success"], 100)
        self.assertEqual(summary["failed_execution_tokens"], 90)
        self.assertEqual(summary["p95_generated_tokens"], 86)
        self.assertEqual(summary["token_categories"], {"protocol": 6, "reasoning": 4, "unclassified": 90})
        self.assertEqual(summary["by_feature"]["mutation"]["complete_execution_accuracy"], 1)
        self.assertEqual(summary["failure_categories"], {"alias-mismatch": 1})
        bad["samples"] = [{"token_ids": [1], "token_accounting": {"reasoning": 2}}]
        with self.assertRaisesRegex(ValueError, "partition"):
            summarize_records([bad])

    def test_no_success_cost_is_undefined_and_infrastructure_is_separate(self):
        self.assertIsNone(summarize_records([record(False, 20)])["tokens_per_verified_success"])
        with self.assertRaisesRegex(ValueError, "infrastructure"):
            summarize_records([{**record(False, 20), "grade": None}])

    def test_paired_bootstrap_resamples_components_and_rejects_population_changes(self):
        before = [record(index % 3 != 0, 100, family=str(index // 2), task=str(index)) for index in range(12)]
        after = [{**item, "generated_tokens": 60, "grade": {"success": True, "reward": 1}} for item in before]
        config = load_config(overrides={"bootstrap_samples": 100, "minimum_evaluation_families": 3})
        result = paired_statistics(before, after, config)
        self.assertEqual(result["uncertainty"]["independent_components"], 6)
        self.assertEqual(result, paired_statistics(before, after, config))
        self.assertGreater(result["tokens_per_verified_success_saving"], .4)
        with self.assertRaisesRegex(ValueError, "same task/repeat"):
            paired_statistics(before, after[:-1], config)

    def test_perfect_tiny_fixture_cannot_claim_statistical_noninferiority(self):
        before = [record(True, 100)]
        after = [record(True, 50)]
        result = paired_statistics(before, after, load_config())
        self.assertTrue(result["acceptance"]["point_estimate_meets_criteria"])
        self.assertEqual(result["acceptance"]["status"], "inconclusive")


class ConversationTests(unittest.TestCase):
    def test_environment_cannot_insert_new_system_instructions(self):
        bridge = ControlledBridge()
        original = bridge.request
        def request(op, **payload):
            result = original(op, **payload)
            if op == "step":
                result["messages"] = [{"role": "system", "content": "hidden teacher correction"}]
            return result
        bridge.request = request
        adapter = ScriptedAdapter([sample("read")])
        with self.assertRaisesRegex(BridgeError, "non-observation role"):
            rollout(bridge, adapter, {"id": "a"}, load_config(), 17)
        self.assertNotIn("hidden teacher correction", json.dumps(adapter.histories))

    def test_future_observations_do_not_change_earlier_history_and_student_state_is_preserved(self):
        class MultiBridge(ControlledBridge):
            def __init__(self, future):
                super().__init__()
                self.future = future
            def request(self, op, **payload):
                if op == "step" and payload["action"].startswith("first"):
                    return {"done": False, "messages": [{"role": "user", "content": "arrived-one"}]}
                if op == "step" and payload["action"].startswith("second"):
                    return {"done": False, "messages": [{"role": "user", "content": self.future}]}
                return super().request(op, **payload)
        histories = []
        for future in ("FUTURE_A_9981", "FUTURE_B_9982"):
            adapter = ScriptedAdapter([sample("first; student thinks intermediate is 999"),
                sample("second; student keeps its own mistaken state"), sample("complete")])
            rollout(MultiBridge(future), adapter, {"id": "a", "privateTeacher": "TEACHER_SECRET_332"}, load_config(), 17)
            histories.append(adapter.histories)
            self.assertNotIn(future, json.dumps(adapter.histories[:2]))
            self.assertIn(future, json.dumps(adapter.histories[2]))
            self.assertIn("student thinks intermediate is 999", json.dumps(adapter.histories[2]))
            self.assertNotIn("TEACHER_SECRET_332", json.dumps(adapter.histories))
        self.assertEqual(histories[0][:2], histories[1][:2])


if __name__ == "__main__":
    unittest.main()
