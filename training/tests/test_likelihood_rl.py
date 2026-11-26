"""Tests for likelihood-reward latent-reasoning RL (default rl_objective='likelihood')."""
from __future__ import annotations

import math
import unittest
from types import SimpleNamespace

from tinker_js.adapter import TinkerAdapter, rl_token_arrays
from tinker_js.learning import likelihood_advantages
from tinker_js.runner import DEFAULTS, load_config


class LikelihoodRLTests(unittest.TestCase):
    def test_likelihood_is_default_objective(self):
        self.assertEqual(DEFAULTS["rl_objective"], "likelihood")
        cfg = load_config(None, {"rl_steps": 2})
        self.assertEqual(cfg["rl_objective"], "likelihood")
        self.assertEqual(cfg["target_anchor_weight"], 0.25)

    def test_likelihood_advantages_rank_thoughts_and_anchor_target(self):
        cfg = {"length_penalty": 0.25, "length_scale_tokens": 1000, "advantage_mode": "decoupled", "target_anchor_weight": 0.25}
        records = [
            {"terminated": True, "target_logprob_sum": -1.0, "generated_tokens": 100},
            {"terminated": True, "target_logprob_sum": -4.0, "generated_tokens": 100},
            {"terminated": True, "target_logprob_sum": -1.0, "generated_tokens": 400},
            {"terminated": False, "target_logprob_sum": None, "generated_tokens": 1000},
        ]
        sig = likelihood_advantages(records, cfg, coefficient=0.25)
        self.assertFalse(sig["zero_advantage_group"])
        # Same high logprob (-1.0) with shorter thought (100 vs 400) wins strictly.
        self.assertGreater(sig["advantages"][0], sig["advantages"][2])
        # Higher logprob (-1.0 vs -4.0) beats lower logprob at same length.
        self.assertGreater(sig["advantages"][0], sig["advantages"][1])
        # Truncated thought gets worst advantage and zero target anchor.
        self.assertLess(sig["advantages"][3], sig["advantages"][1])
        self.assertEqual(sig["target_advantages"][3], 0.0)
        # Posterior-weighted target anchor sums to anchor_weight * len(valid).
        self.assertAlmostEqual(sum(sig["target_advantages"]), 0.25 * 3, places=6)
        self.assertGreater(sig["target_advantages"][0], sig["target_advantages"][1])

    def test_rl_token_arrays_appends_target_action_anchor(self):
        sample = {
            "prompt_tokens": [10, 11],
            "token_ids": [20, 21, 99],
            "logprobs": [-0.5, -0.4, -0.1],
            "target_tokens": [30, 31],
            "target_logprobs": [-0.2, -0.3],
            "target_advantage": 0.5,
        }
        arrays = rl_token_arrays(sample, 1.25)
        self.assertEqual(arrays["input_tokens"], [10, 11, 20, 21, 99, 30])
        self.assertEqual(arrays["target_tokens"], [11, 20, 21, 99, 30, 31])
        self.assertEqual(arrays["logprobs"], [0.0, -0.5, -0.4, -0.1, -0.2, -0.3])
        self.assertEqual(arrays["advantages"], [0.0, 1.25, 1.25, 1.25, 0.5, 0.5])

    def test_real_tml_v0_extract_turn_targets_multi_turn(self):
        adapter = TinkerAdapter({"effort": 0.5})
        msgs = [
            {"role": "system", "content": "Execute JS."},
            {"role": "tool_declare", "content": '[{"type":"function","function":{"name":"platform.random","description":"rand","parameters":{"type":"object","properties":{"arguments":{"type":"array"}}}}}]'},
            {"role": "user", "content": "Run run()"},
            {"role": "assistant", "content": [{"type": "thinking", "thinking": "call rand"}],
             "tool_calls": [{"type": "function", "id": "call_1", "function": {"name": "platform.random", "arguments": '{"arguments":[]}'}}]},
            {"role": "tool", "tool_call_id": "call_1", "name": "platform.random", "content": '{"status":"fulfilled","value":0.5}'},
            {"role": "assistant", "content": [{"type": "thinking", "thinking": "return 0.5"},
             {"type": "text", "text": '```json\n{"type":"complete","kind":"return","arguments":[],"value":0.5}\n```'}]},
        ]
        turns = adapter.extract_turn_targets(msgs)
        self.assertEqual(len(turns), 2)
        self.assertTrue(turns[0]["is_tool_call"])
        self.assertEqual(turns[0]["operation"], "platform.random")
        self.assertFalse(turns[1]["is_tool_call"])
        self.assertEqual(turns[1]["operation"], "complete")
        msg_model_id, thinking_id, end_id = adapter.thinking_token_ids()
        for t in turns:
            self.assertEqual(t["thinking_prompt_tokens"][-2:], [msg_model_id, thinking_id])
            self.assertEqual(t["target_action_tokens"][0], msg_model_id)
            self.assertIn(end_id, t["target_action_tokens"])

    def test_train_rl_default_likelihood_mode_runs_end_to_end(self):
        import random, tempfile
        from pathlib import Path
        from tinker_js.runner import train_rl

        class FakeLikelihoodAdapter:
            backend_name = "fixture"
            def __init__(self):
                self.trained = []
                self.sampling_revision = "tinker://sampler/0"
            def create_training_client(self, checkpoint=None): return None
            def create_sampling_client(self, checkpoint=None): self.sampling_revision = checkpoint or "base"
            def refresh_sampler(self): self.sampling_revision = "ephemeral-1"
            def checkpoint(self, name, **kwargs):
                return {"training_path": f"tinker://train/{name}", "sampler_path": f"tinker://sampler/{name}", "step": 1}
            def extract_turn_targets(self, messages):
                return [{"turn_index": 0, "prefix_tokens": [1, 2], "thinking_prompt_tokens": [1, 2, 10, 11],
                         "target_action_tokens": [10, 20, 30], "is_tool_call": True, "operation": "platform.random"}]
            def sample_thinking_and_score_target(self, turn_target, *, seed, max_tokens=None, temperature=None):
                ll = -1.0 if seed % 2 == 0 else -4.0
                return {
                    "prompt_tokens": list(turn_target["thinking_prompt_tokens"]),
                    "token_ids": [50, 51, 99],
                    "logprobs": [-0.3, -0.2, -0.1],
                    "target_tokens": list(turn_target["target_action_tokens"]),
                    "target_logprobs": [ll / 3.0] * 3,
                    "target_logprob_sum": ll,
                    "target_logprob_mean": ll / 3.0,
                    "terminated": True,
                    "truncated": False,
                    "provenance_error": None,
                    "generated_tokens": 3,
                    "sampler_revision": self.sampling_revision,
                    "operation": turn_target["operation"],
                    "is_tool_call": True,
                    "turn_index": 0,
                    "token_categories": {"reasoning": 3, "trace": 0, "protocol": 0, "other": 0, "unclassified": 0},
                }
            def rl_train(self, trajectories, **options):
                self.trained.append((trajectories, options))
                return {"step": 1, "examples": len(trajectories), "metrics": {"loss:sum": 0.1}}

        cfg = load_config(overrides={"rl_steps": 1, "group_size": 2, "validation_every": 0, "checkpoint_every": 1})
        self.assertEqual(cfg["rl_objective"], "likelihood")
        rows = [{"id": "t1", "family": "f1", "sourceHash": "h1", "split": "train",
                 "task": {"id": "t1", "family": "f1", "source": "function run(){return 1;}", "args": []},
                 "messages": [{"role": "assistant", "content": "x"}],
                 "metadata": {"tier": 5, "features": ["native-v8"]}}]
        state = {"phase": "sft_done", "rl_steps_completed": 0, "training_path": None, "sampler_path": None,
                 "compression_gate_open": True, "evaluations": []}
        adapter = FakeLikelihoodAdapter()
        with tempfile.TemporaryDirectory() as directory:
            train_rl(None, adapter, rows, cfg, Path(directory), state, random.Random(17))
            self.assertEqual(state["rl_optimizer_updates"], 1)
            self.assertEqual(len(adapter.trained), 1)
            trajs = adapter.trained[0][0]
            self.assertEqual(len(trajs), 2)
            # Both trajectories carry posterior-weighted target_advantage on their sample.
            self.assertTrue(all(t["samples"][0]["target_advantage"] > 0 for t in trajs))


if __name__ == "__main__":
    unittest.main()
