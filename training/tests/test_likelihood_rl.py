"""Tests for likelihood-reward latent-reasoning RL (default rl_objective='likelihood')."""
from __future__ import annotations

import math
import unittest
from types import SimpleNamespace

from tinker_js.adapter import TinkerAdapter, rl_token_arrays
from tinker_js.learning import (curriculum_pick, difficulty_pick, difficulty_weight, likelihood_advantages,
                                pick_turn_target, update_task_difficulty)
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

    def test_likelihood_std_floor_prevents_noise_from_drowning_compression(self):
        cfg = {"length_penalty": 0.65, "length_scale_tokens": 2048, "advantage_mode": "decoupled",
               "target_anchor_weight": 0.25, "likelihood_std_floor": 0.5}
        # All 4 thoughts are already >99% confident, but lengths vary 3x (300 vs 900).
        records = [
            {"terminated": True, "target_logprob_sum": -0.009, "generated_tokens": 300},
            {"terminated": True, "target_logprob_sum": -0.001, "generated_tokens": 900},
            {"terminated": True, "target_logprob_sum": -0.002, "generated_tokens": 700},
            {"terminated": True, "target_logprob_sum": -0.003, "generated_tokens": 500},
        ]
        sig = likelihood_advantages(records, cfg, coefficient=0.65)
        # Shorter confident thought (300 tok, -0.009) MUST beat verbose thought (900 tok, -0.001).
        self.assertGreater(sig["advantages"][0], sig["advantages"][1])
        self.assertGreater(sig["advantages"][0], 0.5)
        self.assertLess(sig["advantages"][1], -0.5)

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

    def test_extract_turn_targets_opsd_teacher_prompt_no_leakage(self):
        adapter = TinkerAdapter({"effort": 0.5})
        tok = adapter._sdk().tokenizer
        msgs = [
            {"role": "system", "content": "Execute JS."},
            {"role": "tool_declare", "content": '[{"type":"function","function":{"name":"platform.random","description":"rand","parameters":{"type":"object","properties":{"arguments":{"type":"array"}}}}}]'},
            {"role": "user", "content": "Run run()"},
            {"role": "assistant", "content": [{"type": "thinking", "thinking": "x = 7\nbranch x > 0 => true (then)"}],
             "tool_calls": [{"type": "function", "id": "call_1", "function": {"name": "platform.random", "arguments": '{"arguments":[]}'}}]},
            {"role": "tool", "tool_call_id": "call_1", "name": "platform.random", "content": '{"status":"fulfilled","value":0.425}'},
            {"role": "assistant", "content": [{"type": "thinking", "thinking": "roll = 0.425\nreturn 0.425"},
             {"type": "text", "text": '```json\n{"type":"complete","kind":"return","arguments":[],"value":0.425}\n```'}]},
        ]
        turns = adapter.extract_turn_targets(msgs)
        self.assertEqual(len(turns), 2)
        self.assertEqual(turns[0]["trace_text"], "x = 7\nbranch x > 0 => true (then)")
        self.assertEqual(turns[1]["trace_text"], "roll = 0.425\nreturn 0.425")

        msg_model_id, thinking_id, _end_id = adapter.thinking_token_ids()
        for idx, t in enumerate(turns):
            student_text = tok.decode(t["thinking_prompt_tokens"])
            teacher_tokens = t["teacher_thinking_prompt_tokens"]
            self.assertIsNotNone(teacher_tokens)
            self.assertEqual(teacher_tokens[-2:], [msg_model_id, thinking_id])
            teacher_text = tok.decode(teacher_tokens)
            # Student prompt must NEVER contain trace lines.
            self.assertNotIn("branch x > 0", student_text)
            self.assertNotIn("roll = 0.425", student_text)
            # Teacher prompt MUST contain full-episode computational trace front-loaded before user task,
            # NEVER target completion JSON or tool observations not yet received.
            self.assertIn("<mechanistic_trace>", teacher_text)
            self.assertIn(t["trace_text"], teacher_text)
            self.assertIn("branch x > 0", teacher_text)
            self.assertIn("roll = 0.425", teacher_text)
            self.assertLess(teacher_text.index("<mechanistic_trace>"), teacher_text.index("Run run()"))
            self.assertNotIn('"type":"complete"', teacher_text)
            if idx == 0:
                self.assertNotIn('"status":"fulfilled"', teacher_text)

        # Empty thinking leaves teacher prompt as None.
        no_trace_msgs = [
            {"role": "user", "content": "Run run()"},
            {"role": "assistant", "content": '```json\n{"type":"complete","kind":"return","arguments":[],"value":1}\n```'},
        ]
        no_trace_turns = adapter.extract_turn_targets(no_trace_msgs)
        self.assertEqual(no_trace_turns[0]["trace_text"], "")
        self.assertIsNone(no_trace_turns[0]["teacher_thinking_prompt_tokens"])

        # Tight context limit gracefully sets teacher prompt to None rather than raising ContextOverflow.
        tiny_adapter = TinkerAdapter({"effort": 0.5, "max_context_tokens": 300})
        tiny_turns = tiny_adapter.extract_turn_targets(msgs)
        self.assertIsNone(tiny_turns[0]["teacher_thinking_prompt_tokens"])

    def test_sample_thinking_and_score_target_with_score_teacher(self):
        class _Future:
            def __init__(self, val): self._val = val
            def result(self, timeout=None): return self._val

        class _ModelInput:
            def __init__(self, ids): self._ids = list(ids)
            def to_ints(self): return list(self._ids)
            @classmethod
            def from_ints(cls, ids): return cls(ids)

        class _FakeClient:
            def __init__(self, z_tokens, z_lps):
                self.z_tokens = z_tokens
                self.z_lps = z_lps
                self.scored_calls = []
            def sample(self, model_input, num_samples, sampling_params):
                return _Future(SimpleNamespace(sequences=[SimpleNamespace(tokens=list(self.z_tokens), logprobs=list(self.z_lps))]))
            def compute_logprobs(self, model_input, prompt_logprobs_last_n=None):
                ids = model_input.to_ints()
                self.scored_calls.append((ids, prompt_logprobs_last_n))
                return _Future([-0.15] * len(ids))

        fake_runtime = SimpleNamespace(
            types=SimpleNamespace(ModelInput=_ModelInput, SamplingParams=lambda **kw: SimpleNamespace(**kw)),
            renderer=None,
            renderer_name="fake",
            tokenizer=None,
        )
        adapter = TinkerAdapter({"effort": 0.5, "max_context_tokens": 1024}, runtime=fake_runtime)
        adapter._thinking_ids = (10, 11, 99)
        turn_target = {
            "turn_index": 0,
            "thinking_prompt_tokens": [1, 2, 10, 11],
            "teacher_thinking_prompt_tokens": [1, 2, 3, 4, 5, 10, 11],
            "target_action_tokens": [10, 20, 99],
            "is_tool_call": False,
            "operation": "complete",
        }
        # Terminated sample with score_teacher=True scores BOTH target action and teacher trace logprobs.
        client = _FakeClient([50, 51, 99], [-0.8, -0.7, -0.2])
        adapter.sampling_client = client
        adapter.sampling_revision = "rev-1"
        sample = adapter.sample_thinking_and_score_target(turn_target, seed=7, score_teacher=True)
        self.assertTrue(sample["terminated"])
        self.assertEqual(sample["teacher_logprobs"], [-0.15, -0.15, -0.15])
        self.assertEqual(len(client.scored_calls), 2)
        self.assertEqual(client.scored_calls[1][0], [1, 2, 3, 4, 5, 10, 11, 50, 51, 99])
        self.assertEqual(client.scored_calls[1][1], 3)

        # Truncated sample with score_teacher=True skips target scoring but STILL scores teacher_logprobs.
        trunc_client = _FakeClient([50, 51, 52], [-0.9, -0.8, -0.7])
        adapter.sampling_client = trunc_client
        trunc_sample = adapter.sample_thinking_and_score_target(turn_target, seed=8, score_teacher=True)
        self.assertFalse(trunc_sample["terminated"])
        self.assertIsNone(trunc_sample["target_logprobs"])
        self.assertEqual(trunc_sample["teacher_logprobs"], [-0.15, -0.15, -0.15])
        self.assertEqual(len(trunc_client.scored_calls), 1)

        # score_teacher=True with teacher_ll_threshold skips teacher scoring when confident (sum=-0.45 >= -0.5).
        skip_client = _FakeClient([50, 51, 99], [-0.8, -0.7, -0.2])
        adapter.sampling_client = skip_client
        skip_sample = adapter.sample_thinking_and_score_target(
            turn_target, seed=10, score_teacher=True, teacher_ll_threshold=-0.5,
        )
        self.assertTrue(skip_sample["terminated"])
        self.assertIsNone(skip_sample["teacher_logprobs"])
        self.assertEqual(len(skip_client.scored_calls), 1)

        # score_teacher=False leaves teacher_logprobs as None.
        no_teacher_client = _FakeClient([50, 51, 99], [-0.8, -0.7, -0.2])
        adapter.sampling_client = no_teacher_client
        plain_sample = adapter.sample_thinking_and_score_target(turn_target, seed=9, score_teacher=False)
        self.assertIsNone(plain_sample["teacher_logprobs"])
        self.assertEqual(len(no_teacher_client.scored_calls), 1)

    def test_likelihood_advantages_opsd_gating_clipping_and_token_arrays(self):
        cfg = {
            "length_penalty": 0.65,
            "length_scale_tokens": 2048,
            "advantage_mode": "decoupled",
            "target_anchor_weight": 0.25,
            "likelihood_std_floor": 0.5,
            "opsd_coef": 0.35,
            "opsd_clip": 5.0,
            "opsd_ll_threshold": -0.5,
        }
        records = [
            # Confident short (ll >= -0.5 -> gated OUT of OPSD, stays purely under length compression)
            {"terminated": True, "target_logprob_sum": -0.05, "generated_tokens": 200,
             "samples": [{"logprobs": [-0.2, -0.3], "teacher_logprobs": [-0.1, -0.1]}]},
            # Confident long (ll >= -0.5 -> gated OUT of OPSD)
            {"terminated": True, "target_logprob_sum": -0.02, "generated_tokens": 600,
             "samples": [{"logprobs": [-0.2, -0.3], "teacher_logprobs": [-0.1, -0.1]}]},
            # Uncertain (ll < -0.5 -> OPSD active; test both positive & negative clip at +-5.0)
            {"terminated": True, "target_logprob_sum": -3.0, "generated_tokens": 400,
             "samples": [{"logprobs": [-13.0, -0.1, -1.0], "teacher_logprobs": [-1.0, -9.1, -0.5]}]},
            # Truncated -> OPSD active
            {"terminated": False, "target_logprob_sum": None, "generated_tokens": 1000,
             "samples": [{"logprobs": [-2.0, -2.0], "teacher_logprobs": [-0.5, -0.5]}]},
        ]
        sig = likelihood_advantages(records, cfg, coefficient=0.65)
        self.assertEqual(sig["opsd_scored_rollouts"], 4)
        self.assertEqual(sig["opsd_active_rollouts"], 2)
        self.assertIsNone(sig["token_advantages"][0])
        self.assertIsNone(sig["token_advantages"][1])
        self.assertGreater(sig["advantages"][0], sig["advantages"][1])
        # Check exact clipping on record 2: diffs are [+12.0 -> +5.0, -9.0 -> -5.0, +0.5 -> +0.5]
        base2 = sig["advantages"][2]
        self.assertAlmostEqual(sig["token_advantages"][2][0], base2 + 0.35 * 5.0, places=6)
        self.assertAlmostEqual(sig["token_advantages"][2][1], base2 - 0.35 * 5.0, places=6)
        self.assertAlmostEqual(sig["token_advantages"][2][2], base2 + 0.35 * 0.5, places=6)
        # Check record 3 (truncated) got OPSD signal
        base3 = sig["advantages"][3]
        self.assertAlmostEqual(sig["token_advantages"][3][0], base3 + 0.35 * 1.5, places=6)

        # Feed per-token advantages cleanly through rl_token_arrays.
        sample = {
            "prompt_tokens": [10, 11],
            "token_ids": [20, 21, 99],
            "logprobs": [-13.0, -0.1, -1.0],
            "token_advantages": sig["token_advantages"][2],
            "target_tokens": [30, 31],
            "target_logprobs": [-0.2, -0.3],
            "target_advantage": 0.4,
        }
        arrays = rl_token_arrays(sample, base2)
        self.assertEqual(arrays["advantages"][0], 0.0)
        for got, exp in zip(arrays["advantages"][1:4], sig["token_advantages"][2]):
            self.assertAlmostEqual(got, exp, places=6)
        self.assertEqual(arrays["advantages"][4:], [0.4, 0.4])

        # All-truncated hard group still gets dense non-zero OPSD signal!
        hard_records = [
            {"terminated": False, "target_logprob_sum": None, "generated_tokens": 500,
             "samples": [{"logprobs": [-2.0, -1.0], "teacher_logprobs": [-0.5, -0.5]}]},
            {"terminated": False, "target_logprob_sum": None, "generated_tokens": 500,
             "samples": [{"logprobs": [-1.5, -1.5], "teacher_logprobs": [-0.5, -2.5]}]},
        ]
        hard_sig = likelihood_advantages(hard_records, cfg, coefficient=0.65)
        self.assertFalse(hard_sig["zero_advantage_group"])
        self.assertEqual(hard_sig["opsd_active_rollouts"], 2)
        self.assertAlmostEqual(hard_sig["token_advantages"][0][0], 0.35 * 1.5, places=6)

    def test_opsd_config_and_train_rl_integration(self):
        import json, random, tempfile
        from pathlib import Path
        from tinker_js.runner import train_rl

        repo_root = Path(__file__).resolve().parents[2]
        cfg_file = repo_root / "training/configs/inkling-messy-rl-opsd.json"
        loaded = load_config(cfg_file)
        self.assertEqual(loaded["trace_format"], "compact")
        self.assertEqual(loaded["opsd_coef"], 0.35)
        self.assertEqual(loaded["opsd_clip"], 5.0)
        self.assertEqual(loaded["opsd_ll_threshold"], -0.5)
        self.assertEqual(loaded["sft_epochs"], 0)
        self.assertEqual(loaded["rl_learning_rate"], 1.5e-5)

        class FakeOPSDAdapter:
            backend_name = "fixture"
            def __init__(self):
                self.trained = []
                self.score_teacher_flags = []
                self.sampling_revision = "tinker://sampler/0"
            def create_training_client(self, checkpoint=None): return None
            def create_sampling_client(self, checkpoint=None): self.sampling_revision = checkpoint or "base"
            def refresh_sampler(self): self.sampling_revision = "ephemeral-1"
            def checkpoint(self, name, **kwargs):
                return {"training_path": f"tinker://train/{name}", "sampler_path": f"tinker://sampler/{name}", "step": 1}
            def extract_turn_targets(self, messages):
                return [{"turn_index": 0, "prefix_tokens": [1, 2], "thinking_prompt_tokens": [1, 2, 10, 11],
                         "teacher_thinking_prompt_tokens": [1, 2, 3, 10, 11], "trace_text": "x = 1",
                         "target_action_tokens": [10, 20, 30], "is_tool_call": False, "operation": "complete"}]
            def sample_thinking_and_score_target(self, turn_target, *, seed, max_tokens=None, temperature=None,
                                                 score_teacher=False, teacher_scorer=None, teacher_ll_threshold=None):
                self.score_teacher_flags.append(score_teacher)
                # All-truncated group: scalar advantages are 0, only OPSD token_advantages drive the update!
                return {
                    "prompt_tokens": list(turn_target["thinking_prompt_tokens"]),
                    "token_ids": [50, 51, 52],
                    "logprobs": [-2.0, -1.5, -1.0],
                    "teacher_logprobs": [-0.5, -1.5, -2.0] if score_teacher else None,
                    "target_tokens": list(turn_target["target_action_tokens"]),
                    "target_logprobs": None,
                    "target_logprob_sum": None,
                    "target_logprob_mean": None,
                    "terminated": False,
                    "truncated": True,
                    "provenance_error": None,
                    "generated_tokens": 3,
                    "sampler_revision": self.sampling_revision,
                    "operation": "complete",
                    "is_tool_call": False,
                    "turn_index": 0,
                    "token_categories": {"reasoning": 3, "trace": 0, "protocol": 0, "other": 0, "unclassified": 0},
                }
            def rl_train(self, trajectories, **options):
                self.trained.append((trajectories, options))
                return {"step": 1, "examples": len(trajectories), "metrics": {"loss:sum": 0.1}}

        cfg = load_config(overrides={"rl_steps": 1, "group_size": 2, "validation_every": 0,
                                     "checkpoint_every": 1, "opsd_coef": 0.35})
        rows = [{"id": "t1", "family": "f1", "sourceHash": "h1", "split": "train",
                 "task": {"id": "t1", "family": "f1", "source": "function run(){return 1;}", "args": []},
                 "messages": [{"role": "assistant", "content": "x"}],
                 "metadata": {"tier": 5, "features": ["native-v8"]}}]
        state = {"phase": "sft_done", "rl_steps_completed": 0, "training_path": None, "sampler_path": None,
                 "compression_gate_open": True, "evaluations": []}
        adapter = FakeOPSDAdapter()
        with tempfile.TemporaryDirectory() as directory:
            train_rl(None, adapter, rows, cfg, Path(directory), state, random.Random(17))
            self.assertTrue(all(adapter.score_teacher_flags))
            self.assertEqual(state["rl_optimizer_updates"], 1)
            self.assertEqual(len(adapter.trained), 1)
            trajs = adapter.trained[0][0]
            self.assertEqual(len(trajs), 2)
            self.assertTrue(all("token_advantages" in t["samples"][0] for t in trajs))
            metrics_lines = [json.loads(line) for line in (Path(directory) / "metrics.jsonl").read_text().splitlines()]
            rl_metric = next(m for m in metrics_lines if m.get("stage") == "rl")
            self.assertEqual(rl_metric["opsd_active_rollouts"], 2)
            self.assertEqual(rl_metric["opsd_scored_rollouts"], 2)
            self.assertIsNotNone(rl_metric["opsd_mean_log_ratio"])

    def test_difficulty_sampling_config_defaults_and_validation(self):
        cfg = load_config(None, {"rl_steps": 2})
        ds = cfg["difficulty_sampling"]
        self.assertFalse(ds["enabled"])
        self.assertEqual(ds["effectful_boost"], 2.0)
        self.assertEqual(ds["unit_test_boost"], 1.6)
        self.assertEqual(ds["tier5_boost"], 1.5)
        self.assertEqual(ds["long_boost"], 1.4)
        self.assertEqual(ds["hard_weight"], 3.5)
        self.assertEqual(ds["easy_weight"], 0.3)
        self.assertEqual(ds["hard_ll_threshold"], -0.5)
        self.assertEqual(ds["easy_ll_threshold"], -0.05)
        self.assertEqual(ds["easy_token_threshold"], 900)
        self.assertEqual(ds["tool_turn_boost"], 1.8)

        with self.assertRaises(ValueError):
            load_config(None, {"difficulty_sampling": {"enabled": "yes"}})
        with self.assertRaises(ValueError):
            load_config(None, {"difficulty_sampling": {"enabled": True, "hard_weight": 0}})
        with self.assertRaises(ValueError):
            load_config(None, {"difficulty_sampling": {"enabled": True, "hard_ll_threshold": -0.01, "easy_ll_threshold": -0.5}})
        with self.assertRaises(ValueError):
            load_config(None, {"difficulty_sampling": {"enabled": True, "bogus_key": 1.0}})

    def test_difficulty_sampling_prior_and_online_weights(self):
        import random
        cfg = load_config(None, {"difficulty_sampling": {"enabled": True}})
        plain = {"id": "plain", "family": "f0", "sourceHash": "h0",
                 "metadata": {"tier": 3, "features": ["native-v8"], "externalCalls": 0}}
        rich = {"id": "rich", "family": "f1", "sourceHash": "h1",
                "metadata": {"tier": 5, "features": ["native-v8", "unit-test-input", "longer-execution"], "externalCalls": 4}}
        state: dict = {}

        # Base prior multiplies all four boosts cleanly.
        self.assertAlmostEqual(difficulty_weight(plain, cfg, state), 1.0)
        self.assertAlmostEqual(difficulty_weight(rich, cfg, state), 2.0 * 1.6 * 1.5 * 1.4, places=6)

        # Sampling proportional to prior heavily favors the rich task.
        rng = random.Random(42)
        picks = [curriculum_pick([plain, rich], cfg, state, rng)[0]["id"] for _ in range(400)]
        self.assertGreater(picks.count("rich"), 300)

        # Online feedback: failing/truncated task gets hard_weight boost.
        update_task_difficulty(
            cfg, state, "plain",
            [{"terminated": False, "generated_tokens": 800}, {"terminated": True, "generated_tokens": 500}],
            {"best_target_ll": -2.0},
        )
        self.assertAlmostEqual(difficulty_weight(plain, cfg, state), 3.5, places=6)
        self.assertEqual(state["task_difficulty"]["plain"]["visits"], 1)
        self.assertAlmostEqual(state["task_difficulty"]["plain"]["last_term_rate"], 0.5)

        # Online feedback: mastered concise task is downweighted to easy_weight (strictly > 0).
        update_task_difficulty(
            cfg, state, "plain",
            [{"terminated": True, "generated_tokens": 400}, {"terminated": True, "generated_tokens": 500}],
            {"best_target_ll": -0.01},
        )
        self.assertAlmostEqual(difficulty_weight(plain, cfg, state), 0.3, places=6)
        self.assertGreater(difficulty_weight(plain, cfg, state), 0.0)
        self.assertEqual(state["task_difficulty"]["plain"]["visits"], 2)

        # Mastered but verbose task (> easy_token_threshold) stays at 1.0 so compression still replays it.
        update_task_difficulty(
            cfg, state, "plain",
            [{"terminated": True, "generated_tokens": 1200}, {"terminated": True, "generated_tokens": 1400}],
            {"best_target_ll": -0.01},
        )
        self.assertAlmostEqual(difficulty_weight(plain, cfg, state), 1.0, places=6)

        # Deterministic replay from the same RNG seed.
        a = [difficulty_pick([plain, rich], cfg, state, random.Random(99))[0]["id"] for _ in range(20)]
        b = [difficulty_pick([plain, rich], cfg, state, random.Random(99))[0]["id"] for _ in range(20)]
        self.assertEqual(a, b)

    def test_pick_turn_target_oversamples_tool_calls(self):
        import random
        turns = [
            {"turn_index": 0, "is_tool_call": True, "operation": "platform.dateNow"},
            {"turn_index": 1, "is_tool_call": False, "operation": "complete"},
        ]
        cfg_on = load_config(None, {"difficulty_sampling": {"enabled": True, "tool_turn_boost": 3.0}})
        rng = random.Random(7)
        draws = [pick_turn_target(turns, cfg_on, rng)["is_tool_call"] for _ in range(1000)]
        tool_frac = sum(draws) / len(draws)
        # Expected 3 / (3 + 1) = 0.75.
        self.assertGreater(tool_frac, 0.68)
        self.assertLess(tool_frac, 0.82)

        # Disabled config matches uniform randrange exactly.
        cfg_off = load_config(None, {"difficulty_sampling": {"enabled": False, "tool_turn_boost": 3.0}})
        rng_a = random.Random(123)
        rng_b = random.Random(123)
        for _ in range(30):
            self.assertEqual(pick_turn_target(turns, cfg_off, rng_a), turns[rng_b.randrange(len(turns))])

    def test_difficulty_sampling_train_rl_persistence_and_backward_compat(self):
        import json, random, tempfile
        from pathlib import Path
        from tinker_js.runner import train_rl

        class FakeTwoTaskAdapter:
            backend_name = "fixture"
            def __init__(self):
                self.sampling_revision = "tinker://sampler/0"
                self.picked_ops = []
            def create_training_client(self, checkpoint=None): return None
            def create_sampling_client(self, checkpoint=None): self.sampling_revision = checkpoint or "base"
            def refresh_sampler(self): self.sampling_revision = "ephemeral-1"
            def checkpoint(self, name, **kwargs):
                return {"training_path": f"tinker://train/{name}", "sampler_path": f"tinker://sampler/{name}", "step": 1}
            def extract_turn_targets(self, messages):
                return [
                    {"turn_index": 0, "prefix_tokens": [1], "thinking_prompt_tokens": [1, 10, 11],
                     "target_action_tokens": [10, 20, 30], "is_tool_call": True, "operation": "platform.dateNow"},
                    {"turn_index": 1, "prefix_tokens": [1, 2], "thinking_prompt_tokens": [1, 2, 10, 11],
                     "target_action_tokens": [10, 21, 31], "is_tool_call": False, "operation": "complete"},
                ]
            def sample_thinking_and_score_target(self, turn_target, *, seed, max_tokens=None, temperature=None):
                self.picked_ops.append(turn_target["operation"])
                is_hard = turn_target["operation"] == "platform.dateNow"
                ll = -2.5 if is_hard else -0.01
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
                    "is_tool_call": turn_target["is_tool_call"],
                    "turn_index": turn_target["turn_index"],
                    "token_categories": {"reasoning": 3, "trace": 0, "protocol": 0, "other": 0, "unclassified": 0},
                }
            def rl_train(self, trajectories, **options):
                return {"step": 1, "examples": len(trajectories), "metrics": {"loss:sum": 0.1}}

        rows = [
            {"id": "easy-1", "family": "f1", "sourceHash": "h1", "split": "train",
             "task": {"id": "easy-1", "family": "f1", "source": "function run(){return 1;}", "args": []},
             "messages": [{"role": "assistant", "content": "x"}],
             "metadata": {"tier": 2, "features": ["native-v8"], "externalCalls": 0}},
            {"id": "hard-1", "family": "f2", "sourceHash": "h2", "split": "train",
             "task": {"id": "hard-1", "family": "f2", "source": "function run(){return Date.now();}", "args": []},
             "messages": [{"role": "assistant", "content": "x"}],
             "metadata": {"tier": 5, "features": ["native-v8", "unit-test-input"], "externalCalls": 3}},
        ]

        # Enabled: task_difficulty persists in state.json across steps.
        cfg_on = load_config(overrides={"rl_steps": 3, "group_size": 2, "validation_every": 0,
                                        "checkpoint_every": 3, "difficulty_sampling": {"enabled": True}})
        state_on = {"phase": "sft_done", "rl_steps_completed": 0, "training_path": None, "sampler_path": None,
                    "compression_gate_open": True, "evaluations": []}
        with tempfile.TemporaryDirectory() as directory:
            train_rl(None, FakeTwoTaskAdapter(), rows, cfg_on, Path(directory), state_on, random.Random(17))
            saved = json.loads((Path(directory) / "state.json").read_text())
            self.assertIn("task_difficulty", saved)
            total_visits = sum(entry["visits"] for entry in saved["task_difficulty"].values())
            self.assertEqual(total_visits, 3)

        # Disabled: state has no task_difficulty entry (backward compatible).
        cfg_off = load_config(overrides={"rl_steps": 2, "group_size": 2, "validation_every": 0, "checkpoint_every": 2})
        state_off = {"phase": "sft_done", "rl_steps_completed": 0, "training_path": None, "sampler_path": None,
                     "compression_gate_open": True, "evaluations": []}
        with tempfile.TemporaryDirectory() as directory:
            train_rl(None, FakeTwoTaskAdapter(), rows, cfg_off, Path(directory), state_off, random.Random(17))
            saved_off = json.loads((Path(directory) / "state.json").read_text())
            self.assertNotIn("task_difficulty", saved_off)


if __name__ == "__main__":
    unittest.main()
