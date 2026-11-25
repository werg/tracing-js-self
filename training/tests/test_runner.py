import copy
import json
from pathlib import Path
import random
import tempfile
import unittest

from tinker_js.runner import (
    BridgeError, RolloutError, UpdateRecoveryError, compression_reward, config_fingerprint, digest, evaluate, export_dataset,
    group_advantages, load_config, load_state, make_report, rollout,
    save_state, scheduled_learning_rate, split_examples, summarize_records, train_rl, train_sft, write_jsonl,
)


def row(name, family=None, source=None, split=None):
    value = {"id": name, "family": family or name, "sourceHash": source or name,
             "task": {"id": name, "family": family or name}, "messages": []}
    if split is not None:
        value["split"] = split
    return value


def sample(text, tokens=3, complete=True):
    return {"message": {"role": "assistant", "content": [
                {"type": "thinking", "thinking": "Private student reasoning remains in history."},
                {"type": "text", "text": text}]},
            "text": text, "prompt_tokens": [1, 2], "token_ids": list(range(tokens)),
            "logprobs": [-0.2] * tokens, "complete": complete,
            "stop_reason": "stop" if complete else "length"}


class ScriptedAdapter:
    backend_name = "fixture"

    def __init__(self, samples):
        self.samples = list(samples)
        self.histories = []
        self.trained = []

    def sample(self, messages, **kwargs):
        self.histories.append(copy.deepcopy(messages))
        return copy.deepcopy(self.samples.pop(0))

    def create_training_client(self, checkpoint=None):
        pass

    def create_sampling_client(self, checkpoint=None):
        self.sampling_checkpoint = checkpoint

    def refresh_sampler(self):
        pass

    def rl_train(self, trajectories, **kwargs):
        self.trained.append(copy.deepcopy(trajectories))
        return {"trained": len(trajectories)}

    def checkpoint(self, name):
        return {"training_path": "tinker://fixture/state/" + name,
                "sampler_path": "tinker://fixture/sampler/" + name}


class ControlledBridge:
    def __init__(self):
        self.requests = []
        self.step_count = 0
        self.done = False
        self.closed = False

    def request(self, operation, **kwargs):
        self.requests.append((operation, copy.deepcopy(kwargs)))
        if operation == "start":
            self.step_count = 0
            self.done = False
            return {"sessionId": "private-session-handle", "messages": [
                {"role": "user", "content": "Execute the program using read()."}]}
        if operation == "step":
            self.step_count += 1
            if kwargs["action"] == "read":
                return {"messages": [{"role": "user", "content": "Observed value: secret-result-42"}],
                        "done": False}
            self.done = True
            return {"messages": [], "done": True,
                    "grade": {"success": kwargs["action"] == "complete", "reward": 1, "reason": "graded"}}
        if operation == "grade":
            return {"success": self.done, "reward": 1, "reason": "incomplete"}
        if operation == "close":
            self.closed = True
            return {}
        raise AssertionError(operation)


class DatasetTests(unittest.TestCase):
    def test_implementation_change_invalidates_frozen_corpus_but_documentation_does_not(self):
        class ExportBridge:
            def request(self, op, **payload):
                return row(payload["task"]["id"])

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "src").mkdir()
            runtime = root / "src/runtime.js"
            runtime.write_text("export const value = 1;\n")
            source = root / "tasks.jsonl"
            write_jsonl(source, [{"id": str(i)} for i in range(6)])
            config = load_config(overrides={"dataset": str(source)})
            _, original = export_dataset(root, config, root / "run", ExportBridge())
            (root / "README.md").write_text("Changed documentation only.\n")
            _, unchanged = export_dataset(root, config, root / "run", ExportBridge())
            self.assertEqual(original["implementation_hash"], unchanged["implementation_hash"])
            runtime.write_text("export const value = 2;\n")
            with self.assertRaisesRegex(ValueError, "implementation changed"):
                export_dataset(root, config, root / "run", ExportBridge())
            _, refreshed = export_dataset(root, config, root / "run", ExportBridge(), refresh=True)
            self.assertNotEqual(original["implementation_hash"], refreshed["implementation_hash"])
            state, rng = load_state(root / "run", config, refreshed, False)
            save_state(root / "run", state, rng)
            runtime.write_text("export const value = 3;\n")
            with self.assertRaisesRegex(ValueError, "implementation changed since the checkpoint"):
                export_dataset(root, config, root / "run", ExportBridge(), refresh=True)

    def test_frozen_export_preserves_fresh_observations_and_rejects_corruption(self):
        class FreshBridge:
            def __init__(self):
                self.calls = 0

            def request(self, op, **payload):
                self.assert_export = op
                self.calls += 1
                task = payload["task"]
                return dict(row(task["id"]), task=dict(task, fresh_observation=self.calls))

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "tasks.jsonl"
            write_jsonl(source, [{"id": str(i)} for i in range(6)])
            config = load_config(overrides={"dataset": str(source)})
            bridge = FreshBridge()
            first, manifest = export_dataset(root, config, root / "run", bridge)
            second, frozen = export_dataset(root, config, root / "run", bridge)
            self.assertEqual(first, second)
            self.assertEqual(manifest, frozen)
            self.assertEqual(bridge.calls, 6)
            export_dataset(root, config, root / "run", bridge, refresh=True)
            self.assertEqual(bridge.calls, 12)
            corrupted = copy.deepcopy(first)
            corrupted[0]["task"]["fresh_observation"] = "changed"
            write_jsonl(root / "run/dataset.jsonl", corrupted)
            with self.assertRaisesRegex(ValueError, "checksum failed"):
                export_dataset(root, config, root / "run", bridge)

    def test_family_and_source_connected_components_never_leak(self):
        rows = [row("a", "family-a", "source-a"), row("b", "family-a", "source-b"),
                row("c", "family-b", "source-b"), row("d", "family-b", "source-c")]
        rows += [row(str(i)) for i in range(10)]
        output, manifest = split_examples(rows, 17, .2, .2)
        self.assertEqual(len({item["split"] for item in output[:4]}), 1)
        self.assertEqual({item["split"] for item in output}, {"train", "validation", "test"})
        self.assertEqual((output, manifest), split_examples(rows, 17, .2, .2))
        self.assertNotIn("split", rows[0])

    def test_conflicting_explicit_split_of_source_copy_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "contradictory"):
            split_examples([row("a", "a", "same", "train"), row("b", "b", "same", "test"),
                            row("c"), row("d"), row("e")], 0, .2, .2)

    def test_every_program_in_an_agent_trajectory_participates_in_split(self):
        first = dict(row("agent-a", source="main-a"), sourceHashes=["main-a", "extra-program"])
        second = row("executor-b", source="extra-program")
        rows = [first, second] + [row(str(i)) for i in range(6)]
        output, manifest = split_examples(rows, 17, .2, .2)
        self.assertEqual(output[0]["split"], output[1]["split"])
        group = next(group for group in manifest["components"] if "agent-a" in group["ids"])
        self.assertEqual(group["source_hashes"], ["extra-program", "main-a"])
        with self.assertRaisesRegex(ValueError, "sourceHashes"):
            split_examples([dict(first, sourceHashes=[""]), *rows[1:]], 17, .2, .2)

    def test_ancestor_names_connect_transitively_to_actual_families(self):
        child = row("child", family="child-family")
        child["task"]["ancestors"] = ["parent-family"]
        parent = row("parent", family="parent-family")
        parent["task"]["ancestors"] = ["grandparent-family"]
        grandparent = row("grandparent", family="grandparent-family")
        cousin = dict(row("cousin", family="cousin-family"), ancestors=["child-family"])
        rows = [child, parent, grandparent, cousin] + [row(str(i)) for i in range(6)]
        output, manifest = split_examples(rows, 17, .2, .2)
        self.assertEqual(len({entry["split"] for entry in output[:4]}), 1)
        group = next(group for group in manifest["components"] if "child" in group["ids"])
        self.assertEqual(group["ids"], ["child", "cousin", "grandparent", "parent"])
        self.assertEqual(group["ancestor_families"], ["child-family", "grandparent-family", "parent-family"])

    def test_conflicting_explicit_splits_connected_by_ancestors_are_rejected(self):
        descendant = row("descendant", family="derived", split="train")
        descendant["task"]["ancestors"] = ["intermediate"]
        intermediate = dict(row("middle", family="intermediate"), ancestors=["canonical-root"])
        ancestor = row("root", family="canonical-root", split="test")
        with self.assertRaisesRegex(ValueError, "contradictory explicit splits"):
            split_examples([descendant, intermediate, ancestor, row("x"), row("y")], 17, .2, .2)

    def test_ancestor_metadata_is_bounded_and_validated(self):
        invalid = ["not-an-array", [""], ["   "], [123], ["x" * 1025], [str(i) for i in range(257)]]
        for ancestors in invalid:
            with self.subTest(ancestors_type=type(ancestors).__name__), self.assertRaisesRegex(ValueError, "ancestors"):
                split_examples([dict(row("a"), ancestors=ancestors), row("b"), row("c")], 17, .2, .2)

    def test_tiny_dataset_cannot_fake_a_holdout(self):
        with self.assertRaisesRegex(ValueError, "not enough"):
            split_examples([row("only")], 0, .2, .2)

    def test_duplicate_ids_rejected(self):
        with self.assertRaisesRegex(ValueError, "unique"):
            split_examples([row("a"), row("a"), row("b")], 0, .2, .2)

    def test_dataset_and_configuration_resume_guards(self):
        config = load_config()
        manifest = {"dataset_hash": "original", "split_manifest": {"hash": "split"}}
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            state, rng = load_state(path, config, manifest, False)
            rng.random()
            save_state(path, state, rng)
            expected = rng.random()
            restored, restored_rng = load_state(path, config, manifest, True)
            self.assertEqual(restored_rng.random(), expected)
            self.assertEqual(restored["dataset_hash"], "original")
            with self.assertRaisesRegex(ValueError, "--resume"):
                load_state(path, config, manifest, False)
            with self.assertRaisesRegex(ValueError, "config differs"):
                load_state(path, dict(config, effort=.3), manifest, True)
            with self.assertRaisesRegex(ValueError, "dataset differs"):
                load_state(path, config, dict(manifest, dataset_hash="changed"), True)


class RolloutTests(unittest.TestCase):
    def setUp(self):
        self.config = load_config(overrides={"max_tokens": 50, "max_generated_tokens": 100, "max_turns": 3})

    def test_only_arrived_observations_enter_student_history(self):
        bridge = ControlledBridge()
        adapter = ScriptedAdapter([sample("read", 7), sample("complete", 11)])
        task = {"id": "task", "privateTeacher": "secret-result-42", "family": "demo"}
        result = rollout(bridge, adapter, task, self.config, 2)
        self.assertNotIn("secret-result-42", json.dumps(adapter.histories[0]))
        self.assertIn("secret-result-42", json.dumps(adapter.histories[1]))
        self.assertNotIn("private-session-handle", json.dumps(adapter.histories))
        self.assertEqual(adapter.histories[1][1], result["samples"][0]["message"])
        self.assertEqual(result["samples"][0]["logprobs"], [-.2] * 7)
        self.assertEqual(result["generated_tokens"], 18)
        self.assertEqual(result["backend"], "fixture")
        self.assertTrue(result["grade"]["success"])
        self.assertTrue(bridge.closed)
        self.assertEqual([payload["generatedTokens"] for op, payload in bridge.requests if op == "step"], [7, 18])

    def test_truncation_cannot_claim_success_even_if_text_looks_complete(self):
        bridge = ControlledBridge()
        result = rollout(bridge, ScriptedAdapter([sample("complete", 8, complete=False)]),
                         {"id": "task"}, self.config, 1)
        self.assertFalse(result["grade"]["success"])
        self.assertEqual(result["grade"]["reward"], 0)
        self.assertEqual(result["grade"]["reason"], "truncated_sample")
        self.assertEqual(bridge.step_count, 0)
        self.assertEqual(result["generated_tokens"], 8)

    def test_turn_budget_gives_incomplete_no_success_reward(self):
        config = dict(self.config, max_turns=1)
        result = rollout(ControlledBridge(), ScriptedAdapter([sample("read")]), {"id": "a"}, config, 1)
        self.assertFalse(result["complete"])
        self.assertEqual(result["grade"]["reason"], "turn_budget_exhausted")
        self.assertEqual(result["grade"]["reward"], 0)

    def test_teacher_corrections_are_rejected_and_session_closed(self):
        bridge = ControlledBridge()
        original = bridge.request

        def request(op, **kwargs):
            result = original(op, **kwargs)
            if op == "step":
                result["messages"] = [{"role": "assistant", "content": "Teacher correction"}]
            return result

        bridge.request = request
        with self.assertRaisesRegex(BridgeError, "teacher assistant"):
            rollout(bridge, ScriptedAdapter([sample("read")]), {"id": "a"}, self.config, 1)
        self.assertTrue(bridge.closed)

    def test_shorter_successes_win_but_failures_never_receive_length_credit(self):
        self.assertGreater(compression_reward(True, 10, self.config), compression_reward(True, 90, self.config))
        self.assertGreater(compression_reward(True, 100, self.config), 0)
        self.assertEqual(compression_reward(False, 0, self.config), 0)
        advantages = group_advantages([0, .75, 1])
        self.assertLess(advantages[0], 0)
        self.assertLess(advantages[1], advantages[2])
        self.assertAlmostEqual(sum(advantages), 0)
        self.assertEqual(group_advantages([0, 0, 0]), [0, 0, 0])

    def test_failed_groups_skip_optimizer_instead_of_training_on_teacher(self):
        config = dict(self.config, rl_steps=1, group_size=2)
        adapter = ScriptedAdapter([sample("wrong"), sample("wrong")])
        state = {"phase": "created", "rl_steps_completed": 0, "training_path": None}
        with tempfile.TemporaryDirectory() as directory:
            train_rl(ControlledBridge(), adapter, [row("a", split="train")], config,
                     Path(directory), state, random.Random(1))
            self.assertEqual(adapter.trained, [])
            self.assertEqual(state["rl_steps_completed"], 1)
            self.assertEqual(state["phase"], "rl_done")
            records = [json.loads(line) for line in (Path(directory) / "rollouts/rl-000001.jsonl").read_text().splitlines()]
            self.assertEqual([record["advantage"] for record in records], [0, 0])

    def test_bad_provenance_is_saved_then_aborts_the_whole_update(self):
        invalid = sample("", 12, complete=False)
        invalid.update(message={}, provenance_error="missing logprobs", logprobs=[])
        config = dict(self.config, rl_steps=1, group_size=2)
        adapter = ScriptedAdapter([invalid, sample("complete")])
        state = {"phase": "created", "rl_steps_completed": 0, "training_path": None}
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(RuntimeError, "entire update"):
                train_rl(ControlledBridge(), adapter, [row("a", split="train")], config,
                         Path(directory), state, random.Random(1))
            records = [json.loads(line) for line in (Path(directory) / "rollouts/rl-000001.jsonl").read_text().splitlines()]
            self.assertEqual(adapter.trained, [])
            self.assertEqual(records[0]["generated_tokens"], 12)
            self.assertEqual(records[0]["grade"]["reward"], 0)
            self.assertEqual(records[0]["grade"]["reason"], "sampling_provenance_error")
            self.assertEqual(records[1]["grade"]["success"], True)
            self.assertEqual(state["rl_steps_completed"], 0)


class RecoveryTests(unittest.TestCase):
    def test_interrupted_rl_group_keeps_prior_samples_and_restores_seed_sequence(self):
        config = load_config(overrides={"rl_steps": 1, "group_size": 2})
        manifest = {"dataset_hash": "fixed", "split_manifest": {"hash": "fixed-split"}}
        rows = [row("a", split="train")]
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            state, rng = load_state(output, config, manifest, False)
            save_state(output, state, rng)
            first = ScriptedAdapter([sample("complete", 7)])
            with self.assertRaises(RolloutError):
                train_rl(ControlledBridge(), first, rows, config, output, state, rng)
            partial = output / "rollouts/rl-000001.partial.jsonl"
            saved = json.loads(partial.read_text())
            self.assertEqual(saved["generated_tokens"], 7)
            state, rng = load_state(output, config, manifest, True)
            second = ScriptedAdapter([sample("wrong", 2)])
            train_rl(ControlledBridge(), second, rows, config, output, state, rng)
            self.assertEqual(len(second.histories), 1)
            self.assertEqual(len(second.trained), 1)
            self.assertEqual(second.trained[0][0]["samples"][0]["token_ids"], list(range(7)))
            self.assertFalse(partial.exists())
            self.assertEqual(state["rl_optimizer_updates"], 1)

    def test_interrupted_sft_checkpoint_refuses_to_repeat_confirmed_update(self):
        class TrainingAdapter(ScriptedAdapter):
            def __init__(self, fail_checkpoint=None):
                super().__init__([])
                self.batch_ids = []
                self.restored = None
                self.fail_checkpoint = fail_checkpoint
                self.saved = []

            def create_training_client(self, checkpoint=None):
                self.restored = checkpoint

            def sft_train(self, examples, **kwargs):
                self.batch_ids.append(examples[0]["messages"][0]["content"])
                return {}

            def checkpoint(self, name):
                if name == self.fail_checkpoint:
                    raise RuntimeError("simulated interrupted checkpoint")
                self.saved.append(name)
                return super().checkpoint(name)

        config = load_config(overrides={"batch_size": 1, "checkpoint_every": 1})
        manifest = {"dataset_hash": "fixed", "split_manifest": {"hash": "fixed-split"}}
        rows = [dict(row(name, split="train"), messages=[{"role": "assistant", "content": name}])
                for name in ("a", "b", "c")]
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            state, rng = load_state(output, config, manifest, False)
            first = TrainingAdapter(fail_checkpoint="sft-000002")
            with self.assertRaisesRegex(RuntimeError, "interrupted checkpoint"):
                train_sft(None, first, rows, config, output, state, rng)
            self.assertEqual(len(first.batch_ids), 2)
            on_disk = json.loads((output / "state.json").read_text())
            self.assertEqual(on_disk["sft_batches_completed"], 1)
            self.assertEqual(on_disk["training_path"], "tinker://fixture/state/sft-000001")
            pending = json.loads((output / "pending-update.json").read_text())
            self.assertEqual(pending["attempt_id"], "sft-000002")
            self.assertFalse((output / "updates/sft-000002.recovery.json").exists())
            ledger = [json.loads(line) for line in (output / "update-ledger.jsonl").read_text().splitlines()]
            self.assertEqual(sum(event["event"] == "optimizer_confirmed" for event in ledger), 2)
            self.assertEqual(sum(event["event"] == "checkpoint_persisted" for event in ledger), 1)
            with self.assertRaisesRegex(UpdateRecoveryError, "confirmed but missing a durable recovery checkpoint"):
                load_state(output, config, manifest, True)
            second = TrainingAdapter()
            with self.assertRaisesRegex(UpdateRecoveryError, "unfinished optimizer attempt"):
                train_sft(None, second, rows, config, output, on_disk, rng)
            self.assertEqual(second.batch_ids, [])
            self.assertEqual(second.saved, [])
            self.assertIsNone(second.restored)
            self.assertEqual(json.loads((output / "state.json").read_text()), on_disk)

    def test_interrupted_evaluation_resumes_without_resampling_completed_tasks(self):
        config = load_config()
        rows = [row("a", split="test"), row("b", split="test")]
        first = ScriptedAdapter([sample("complete")])
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            with self.assertRaises(RolloutError):
                evaluate(ControlledBridge(), first, rows, config, output, "baseline")
            partial = output / "evaluations/baseline-test.partial.jsonl"
            self.assertEqual(len(partial.read_text().splitlines()), 1)
            second = ScriptedAdapter([sample("complete")])
            summary = evaluate(ControlledBridge(), second, rows, config, output, "baseline", resume=True)
            self.assertEqual(summary["executions"], 2)
            self.assertEqual(len(second.histories), 1)
            self.assertFalse(partial.exists())
            third = ScriptedAdapter([])
            evaluate(ControlledBridge(), third, rows, config, output, "baseline", resume=True)
            self.assertEqual(third.histories, [])
            with self.assertRaisesRegex(ValueError, "config, task, or checkpoint"):
                evaluate(ControlledBridge(), third, rows, config, output, "baseline", resume=True,
                         checkpoint="tinker://different/sampler")

    def test_mid_trajectory_transport_failure_keeps_received_tokens_in_separate_audit(self):
        config = load_config()
        adapter = ScriptedAdapter([sample("read", 13)])
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            with self.assertRaises(RolloutError):
                evaluate(ControlledBridge(), adapter, [row("a", split="test")], config, output, "baseline")
            audit = json.loads((output / "infrastructure-errors.jsonl").read_text())
            self.assertEqual(audit["generated_tokens"], 13)
            self.assertEqual(audit["samples"][0]["token_ids"], list(range(13)))
            self.assertEqual(audit["samples"][0]["logprobs"], [-.2] * 13)
            self.assertIsNone(audit["grade"])
            self.assertEqual(audit["phase"], "evaluation")
            self.assertFalse((output / "evaluations/baseline-test.jsonl").exists())


class ReportTests(unittest.TestCase):
    def test_totals_include_failures_and_reasoning_tokens(self):
        records = [{"generated_tokens": 10, "complete": True, "grade": {"success": True, "reward": 1}},
                   {"generated_tokens": 90, "complete": False, "grade": {"success": False, "reward": 0}}]
        summary = summarize_records(records)
        self.assertEqual(summary["complete_execution_accuracy"], .5)
        self.assertEqual(summary["mean_generated_tokens"], 50)
        self.assertEqual(summary["mean_successful_tokens"], 10)
        self.assertEqual(summary["all_generated_tokens"], 100)

    def test_report_requires_live_provenance_and_pairs_identical_tasks(self):
        config = load_config()
        baseline = {"task_id": "a", "repeat": 0, "seed": 17, "source_hash": "source-a",
                    "backend": "tinker", "configuration_hash": config_fingerprint(config),
                    "generated_tokens": 50, "complete": True, "grade": {"success": True, "reward": 1}}
        after = dict(baseline, generated_tokens=25)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            write_jsonl(path / "evaluations/baseline-test.jsonl", [baseline])
            write_jsonl(path / "evaluations/sft-test.jsonl", [after])
            result = make_report(path, config)
            self.assertEqual(result["paired"]["sft"]["matched_executions"], 1)
            self.assertEqual(result["paired"]["sft"]["mean_token_change_when_both_correct"], -25)
            write_jsonl(path / "evaluations/sft-test.jsonl", [dict(after, backend="fixture")])
            with self.assertRaisesRegex(ValueError, "fixture/mock"):
                make_report(path, config)
            write_jsonl(path / "evaluations/sft-test.jsonl", [dict(after, source_hash="changed")])
            with self.assertRaisesRegex(ValueError, "identical sources"):
                make_report(path, config)


class ConcurrencyAndScheduleTests(unittest.TestCase):
    def test_scheduled_learning_rate_constant_linear_and_cosine_with_warmup(self):
        cfg_const = load_config(overrides={"lr_schedule": "constant"})
        self.assertEqual(scheduled_learning_rate(1e-4, 5, 10, cfg_const), 1e-4)

        cfg_cos = load_config(overrides={"lr_schedule": "cosine", "lr_warmup_fraction": 0.2, "lr_min_ratio": 0.1})
        self.assertAlmostEqual(scheduled_learning_rate(1e-4, 0, 10, cfg_cos), 5.5e-5, places=10)
        self.assertAlmostEqual(scheduled_learning_rate(1e-4, 1, 10, cfg_cos), 1e-4, places=10)
        self.assertAlmostEqual(scheduled_learning_rate(1e-4, 2, 10, cfg_cos), 1e-4, places=10)
        self.assertAlmostEqual(scheduled_learning_rate(1e-4, 9, 10, cfg_cos), 1e-5, places=10)

        cfg_lin = load_config(overrides={"lr_schedule": "linear", "lr_warmup_fraction": 0.0, "lr_min_ratio": 0.2})
        self.assertAlmostEqual(scheduled_learning_rate(1e-4, 0, 5, cfg_lin), 1e-4, places=10)
        self.assertAlmostEqual(scheduled_learning_rate(1e-4, 2, 5, cfg_lin), 6e-5, places=10)
        self.assertAlmostEqual(scheduled_learning_rate(1e-4, 4, 5, cfg_lin), 2e-5, places=10)

    def test_thinking_without_text_is_tagged_as_distinct_failure_category(self):
        class ThinkingOnlyAdapter:
            backend_name = "tinker"
            def sample(self, messages, max_tokens=None, seed=None):
                return {
                    "message": {"role": "assistant", "content": [{"type": "thinking", "thinking": "{\"type\":\"complete\"}"}]},
                    "text": "",
                    "prompt_tokens": [1, 2],
                    "token_ids": [10, 11, 12],
                    "logprobs": [-0.1, -0.1, -0.1],
                    "stop_reason": "stop",
                    "complete": True,
                }

        config = load_config()
        record = rollout(ControlledBridge(), ThinkingOnlyAdapter(), row("a")["task"], config, seed=17)
        self.assertFalse(record["grade"]["success"])
        self.assertEqual(record["grade"]["failureCategory"], "thinking_without_text")
        summary = summarize_records([record])
        self.assertEqual(summary["failure_categories"], {"thinking_without_text": 1})

    def test_concurrent_evaluate_preserves_deterministic_order(self):
        import threading
        import time

        class ThreadSafeBridge(ControlledBridge):
            def __init__(self):
                super().__init__()
                self._lock = threading.Lock()
            def request(self, op, **payload):
                with self._lock:
                    return super().request(op, **payload)

        class DelayAdapter:
            backend_name = "tinker"
            def sample(self, messages, max_tokens=None, seed=None):
                # Delay inversely by seed so tasks finish out of order.
                time.sleep(0.01 * (seed % 5))
                return sample("complete", 4)

        config = load_config(overrides={"rollout_concurrency": 4})
        rows = [row(f"task-{i}", split="test") for i in range(6)]
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            summary = evaluate(ThreadSafeBridge(), DelayAdapter(), rows, config, output, "baseline", split="test")
            self.assertEqual(summary["executions"], 6)
            self.assertEqual(summary["successes"], 6)
            saved = [json.loads(line) for line in (output / "evaluations/baseline-test.jsonl").read_text().splitlines()]
            self.assertEqual([r["task_id"] for r in saved], [f"task-{i}" for i in range(6)])


if __name__ == "__main__":
    unittest.main()
