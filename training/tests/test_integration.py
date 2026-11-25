"""Real Node worker + scripted samples: infrastructure tests, never model scores."""
import copy
import json
from pathlib import Path
import random
import shutil
import tempfile
import unittest

from tinker_js.runner import (
    Bridge, compression_reward, load_config, load_state, make_report, rollout,
    summarize_records, train_rl, train_sft, validate_fixtures,
)

REPO = Path(__file__).resolve().parents[2]


def action(value, length=11, complete=True):
    text = "Student reasoning stays in the conversation.\n" + chr(96) * 3 + "json\n" + json.dumps(value) + "\n" + chr(96) * 3
    return {"message": {"role": "assistant", "content": [
        {"type": "thinking", "thinking": "Student's original reasoning."},
        {"type": "text", "text": text},
    ]}, "text": text, "prompt_tokens": [4, 8, 15], "token_ids": list(range(100, 100 + length)),
        "logprobs": [-0.25] * length, "generated_tokens": length,
        "complete": complete, "stop_reason": "stop" if complete else "length"}


class ScriptedModel:
    backend_name = "fixture"

    def __init__(self, samples):
        self.samples = list(samples)
        self.histories = []
        self.sft_batches = []
        self.rl_batches = []
        self.training_steps = 0
        self.sampling_revision = "fixture-base"

    def sample(self, messages, **_):
        self.histories.append(copy.deepcopy(messages))
        return copy.deepcopy(self.samples.pop(0))

    def create_training_client(self, checkpoint=None):
        return self

    def create_sampling_client(self, checkpoint=None):
        return self

    def refresh_sampler(self):
        self.sampling_revision = f"fixture-step-{self.training_steps}"

    def sft_train(self, examples, **kwargs):
        self.sft_batches.append(copy.deepcopy(examples))
        self.training_steps += 1
        return {"step": self.training_steps}

    def rl_train(self, trajectories, **kwargs):
        self.rl_batches.append(copy.deepcopy(trajectories))
        self.training_steps += 1
        return {"step": self.training_steps}

    def checkpoint(self, name):
        return {"training_path": "fixture://optimizer/" + name,
                "sampler_path": "fixture://sampler/" + name, "step": self.training_steps}


@unittest.skipUnless(shutil.which("node"), "Node is required for real CPU harness integration")
class WorkerIntegrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.bridge = Bridge(REPO, timeout=60)
        cls.bridge.request("health")

    @classmethod
    def tearDownClass(cls):
        cls.bridge.close()

    def setUp(self):
        self.config = load_config(overrides={
            "max_tokens": 128, "max_generated_tokens": 512, "max_turns": 6,
            "batch_size": 1, "group_size": 2, "sft_epochs": 1, "rl_steps": 1,
        })

    def counter_task(self):
        return {"id": "integration-counter", "family": "integration-effects",
                "source": 'function run(key){const n=host.readNumber(key);host.store(key,n+1);return n+1;}',
                "entry": "run", "args": ["counter"], "fixture": {"calls": [
                    {"operation": "demo.readNumber", "arguments": ["counter"], "result": 41321},
                    {"operation": "demo.store", "arguments": ["counter", 41322], "result": "write-ack-secret"},
                ]}}

    def test_real_observations_arrive_only_after_student_calls_and_history_is_preserved(self):
        model = ScriptedModel([
            action({"type": "call", "operation": "demo.readNumber", "arguments": ["counter"]}, 8),
            action({"type": "call", "operation": "demo.store", "arguments": ["counter", 41322]}, 13),
            action({"type": "complete", "kind": "return", "arguments": ["counter"], "value": 41322}, 21),
        ])
        result = rollout(self.bridge, model, self.counter_task(), self.config, 17)
        self.assertTrue(result["grade"]["success"])
        self.assertEqual(result["backend"], "fixture")
        self.assertEqual(result["generated_tokens"], 42)
        self.assertEqual(result["grade"]["reward"], compression_reward(True, 42, self.config))
        self.assertNotIn("41321", json.dumps(model.histories[0]))
        self.assertNotIn("write-ack-secret", json.dumps(model.histories[1]))
        self.assertIn("41321", json.dumps(model.histories[1]))
        self.assertIn("write-ack-secret", json.dumps(model.histories[2]))
        self.assertEqual(model.histories[1][2], result["samples"][0]["message"])
        self.assertNotIn("sessionId", json.dumps(model.histories))
        self.assertEqual(result["samples"][1]["logprobs"], [-0.25] * 13)

    def test_wrong_external_request_cannot_extract_a_teacher_observation(self):
        model = ScriptedModel([action(
            {"type": "call", "operation": "demo.readNumber", "arguments": ["wrong"]}, 9)])
        result = rollout(self.bridge, model, self.counter_task(), self.config, 17)
        self.assertFalse(result["grade"]["success"])
        self.assertEqual(result["grade"]["reward"], 0)
        self.assertEqual(result["generated_tokens"], 9)
        self.assertNotIn("41321", json.dumps(result["messages"]))
        self.assertEqual(result["grade"]["reason"], "external-request-mismatch")

    def test_correct_return_with_missing_write_is_not_success(self):
        model = ScriptedModel([action(
            {"type": "complete", "kind": "return", "arguments": ["counter"], "value": 41322}, 5)])
        result = rollout(self.bridge, model, self.counter_task(), self.config, 17)
        self.assertFalse(result["grade"]["success"])
        self.assertEqual(result["grade"]["reward"], 0)

    def test_input_mutation_and_return_alias_are_part_of_behavior(self):
        task = {"id": "integration-alias", "family": "integration-alias",
                "source": "function run(state){state.count=state.count+1;return state;}",
                "entry": "run", "args": [{"count": 4}], "fixture": {"calls": []}}
        good = action({"type": "complete", "kind": "return",
                       "arguments": [{"count": 5}], "value": {"$js": "ref", "path": "/arguments/0"}})
        bad = action({"type": "complete", "kind": "return",
                      "arguments": [{"count": 5}], "value": {"count": 5}})
        accepted = rollout(self.bridge, ScriptedModel([good]), task, self.config, 1)
        rejected = rollout(self.bridge, ScriptedModel([bad]), task, self.config, 1)
        self.assertTrue(accepted["grade"]["success"])
        self.assertFalse(rejected["grade"]["success"])

    def test_truncated_output_is_charged_and_shorter_verified_completion_wins(self):
        task = {"id": "integration-length", "family": "integration-length",
                "source": "function run(x){return x+1;}", "entry": "run",
                "args": [3], "fixture": {"calls": []}}
        final = {"type": "complete", "kind": "return", "arguments": [3], "value": 4}
        short = rollout(self.bridge, ScriptedModel([action(final, 5)]), task, self.config, 1)
        long = rollout(self.bridge, ScriptedModel([action(final, 55)]), task, self.config, 1)
        truncated = rollout(self.bridge, ScriptedModel([action(final, 24, False)]), task, self.config, 1)
        self.assertGreater(short["grade"]["reward"], long["grade"]["reward"])
        self.assertEqual(truncated["grade"]["reward"], 0)
        self.assertEqual(truncated["generated_tokens"], 24)
        summary = summarize_records([short, long, truncated])
        self.assertEqual(summary["complete_execution_accuracy"], 2 / 3)
        self.assertEqual(summary["all_generated_tokens"], 84)
        self.assertEqual(summary["incomplete"], 1)

    def test_agent_import_preflight_checks_attached_executor_without_claiming_agent_success(self):
        task = {"id": "integration-agent", "family": "integration-agent",
                "source": "function run(x){return x+1;}", "entry": "run",
                "args": [4], "fixture": {"calls": []},
                "agentTrajectory": {"messages": [
                    {"role": "user", "content": "Add one to four."},
                    {"role": "assistant", "content": "", "tool_calls": [
                        {"id": "routing-only", "type": "function", "function": {
                            "name": "javascript", "arguments": json.dumps({"code": "4 + 1"})}}]},
                    {"role": "tool", "tool_call_id": "routing-only", "content": "5"},
                    {"role": "assistant", "content": "The result is 5."},
                ]}}
        exported = self.bridge.request("export", task=task)
        self.assertEqual(exported["metadata"]["sourceVerificationScope"], "attached-executor-task-only")
        self.assertFalse(exported["metadata"]["agentTaskSuccessVerified"])
        self.assertIn(exported["sourceHash"], exported["sourceHashes"])
        self.assertNotIn("routing-only", json.dumps(exported["messages"]))
        checked = validate_fixtures(self.bridge, [exported])
        self.assertEqual(checked["valid"], 1)
        self.assertFalse(checked["agentObjectiveVerified"])

    def test_sft_then_rl_uses_real_grades_and_saves_exact_sampled_sequences(self):
        task = {"id": "integration-train", "family": "integration-train",
                "source": "function run(x){return x+1;}", "entry": "run",
                "args": [3], "fixture": {"calls": []}}
        exported = self.bridge.request("export", task=task)
        exported["split"] = "train"
        bad = action({"type": "complete", "kind": "return", "arguments": [3], "value": 5}, 7)
        good = action({"type": "complete", "kind": "return", "arguments": [3], "value": 4}, 19)
        model = ScriptedModel([bad, good])
        manifest = {"dataset_hash": "fixture-dataset", "split_manifest": {"hash": "fixture-split"}}
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            state, rng = load_state(output, self.config, manifest, False)
            train_sft(self.bridge, model, [exported], self.config, output, state, rng)
            train_rl(self.bridge, model, [exported], self.config, output, state, rng, training_ready=True)
            self.assertEqual(len(model.sft_batches), 1)
            self.assertEqual(len(model.rl_batches), 1)
            trajectories = model.rl_batches[0]
            self.assertLess(trajectories[0]["advantage"], 0)
            self.assertGreater(trajectories[1]["advantage"], 0)
            self.assertEqual(trajectories[0]["samples"][0]["token_ids"], bad["token_ids"])
            self.assertEqual(trajectories[1]["samples"][0]["logprobs"], good["logprobs"])
            saved = json.loads((output / "state.json").read_text())
            self.assertEqual(saved["phase"], "rl_done")
            self.assertIn("optimizer", saved["training_path"])
            rollouts = [json.loads(line) for line in (output / "rollouts/rl-000001.jsonl").read_text().splitlines()]
            self.assertEqual([r["grade"]["success"] for r in rollouts], [False, True])
            self.assertTrue(all(r["backend"] == "fixture" for r in rollouts))


if __name__ == "__main__":
    unittest.main()
