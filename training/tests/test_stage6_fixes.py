"""Comprehensive Stage 6 tests for harness fixes, schema error diagnostics,
tool-turn anchoring, hard-group compression protection, multi-turn OPSD on failure,
and hard miner --mode sample incremental resume/overflow handling.
"""
from __future__ import annotations

import contextlib
import copy
import importlib.util
import io
import json
from pathlib import Path
import random
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from test_adapter import Future, ModelInput, Sampler, Trainer, fake_adapter
from test_runner import ControlledBridge

from tinker_js.adapter import ContextOverflow, TinkerAdapter, _tensor_values, rl_token_arrays
from tinker_js.learning import execution_advantages, likelihood_advantages
from tinker_js.metrics import summarize_records
from tinker_js.runner import (
    load_config,
    read_jsonl,
    rollout,
    train_rl,
    write_jsonl,
)

REPO_ROOT = Path(__file__).resolve().parents[2]


def _load_tool_module(filename: str, module_name: str):
    path = REPO_ROOT / "tools" / filename
    spec = importlib.util.spec_from_file_location(module_name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
    return module


mine_hard = _load_tool_module("tinker-mine-hard.py", "tinker_mine_hard_stage6")


class ToolCallSchemaDiagnosticsTests(unittest.TestCase):
    def test_real_tml_v0_tool_call_schema_slip_reports_tool_call_schema_error_not_truncation(self):
        adapter = TinkerAdapter({"effort": 0.5, "max_tokens": 256})
        sdk = adapter._sdk()
        tok = sdk.tokenizer
        messages = [
            {"role": "system", "content": "Execute JS."},
            {
                "role": "tool_declare",
                "content": json.dumps([{
                    "type": "function",
                    "function": {
                        "name": "platform.dateNow",
                        "description": "now",
                        "parameters": {
                            "type": "object",
                            "properties": {"arguments": {"type": "array"}},
                            "required": ["arguments"],
                        },
                    },
                }]),
            },
            {"role": "user", "content": "Run run()"},
        ]
        # Construct genuine tml_v0 tokens for a model emitting {"name":"platform.dateNow","args":[]}
        # with normal stop_reason="stop" (previously mislabeled truncated_sample).
        good_assistant = {
            "role": "assistant",
            "content": [{"type": "thinking", "thinking": "check clock"}],
            "tool_calls": [{
                "type": "function",
                "id": "call_1",
                "function": {"name": "platform.dateNow", "arguments": '{"arguments":[]}'},
            }],
        }
        prompt_ids = sdk.renderer.build_generation_prompt(messages, effort=0.5).to_ints()
        full_good = sdk.renderer.build_supervised_examples(messages + [good_assistant], effort=0.5)[0][0].to_ints()
        good_tokens = full_good[len(prompt_ids):]
        # Replace {"arguments":[]} (or {"arguments": []}) with [] inside the tool JSON, preserving special tokens.
        bad_tokens = []
        good_str_tokens = [tok.decode([tid]) for tid in good_tokens]
        # Build token sequence around the JSON payload cleanly using renderer's special tokens
        end_pos = good_str_tokens.index("<|content_invoke_tool_json|>") + 1
        tail_pos = len(good_tokens) - 2  # <|end_message|><|content_model_end_sampling|>
        bad_json_ids = tok.encode('{"name":"platform.dateNow","args":[]}', add_special_tokens=False)
        bad_tokens = list(good_tokens[:end_pos]) + list(bad_json_ids) + list(good_tokens[tail_pos:])

        sampler = Sampler()
        sampler.sequence = SimpleNamespace(
            tokens=bad_tokens,
            logprobs=[-0.1] * len(bad_tokens),
            stop_reason="stop",
        )
        adapter.sampling_client = sampler
        adapter.sampling_revision = "tinker://s/0"

        sample = adapter.sample(messages)
        self.assertFalse(sample["complete"])
        self.assertEqual(sample["stop_reason"], "stop")
        self.assertEqual(sample["parse_termination"], "malformed")
        self.assertEqual(sample["failure_reason"], "tool_call_schema_error")
        self.assertIn("parse_error", sample)

        # Verify rollout + summarize_records keep strict failure (success=False) and report tool_call_schema_error.
        class _SingleSampleAdapter:
            backend_name = "tinker"

            def sample(self, msgs, max_tokens=None, seed=None):
                return copy.deepcopy(sample)

        cfg = load_config(overrides={"max_tokens": 256, "max_generated_tokens": 1024, "max_turns": 2})
        rec = rollout(ControlledBridge(), _SingleSampleAdapter(), {"id": "t-schema", "family": "f"}, cfg, seed=17)
        self.assertFalse(rec["grade"]["success"])
        self.assertEqual(rec["grade"]["reward"], 0.0)
        self.assertEqual(rec["grade"]["reason"], "tool_call_schema_error")
        summary = summarize_records([rec])
        self.assertEqual(summary["failure_categories"], {"tool_call_schema_error": 1})

    def test_non_tool_malformed_stop_and_real_length_truncation_are_distinguished(self):
        # 1. stop_reason == "stop" without tool_invoke tag -> sample_parse_error (malformed_action)
        adapter, service, renderer = fake_adapter()
        renderer.termination = SimpleNamespace(value="malformed", is_clean=False)
        service.sampler.sequence = SimpleNamespace(tokens=[51, 52], logprobs=[-0.1, -0.2], stop_reason="stop")
        rec_parse = adapter.sample([{"role": "user", "content": "program"}])
        self.assertFalse(rec_parse["complete"])
        self.assertEqual(rec_parse["failure_reason"], "sample_parse_error")

        class _StaticAdapter:
            backend_name = "tinker"

            def __init__(self, s):
                self.s = s

            def sample(self, msgs, max_tokens=None, seed=None):
                return copy.deepcopy(self.s)

        cfg = load_config()
        r_parse = rollout(ControlledBridge(), _StaticAdapter(rec_parse), {"id": "t-parse", "family": "f"}, cfg, 1)
        self.assertEqual(r_parse["grade"]["reason"], "sample_parse_error")
        self.assertEqual(summarize_records([r_parse])["failure_categories"], {"malformed_action": 1})

        # 2. stop_reason == "length" -> still truncated_sample (truncation)
        service.sampler.sequence = SimpleNamespace(tokens=[51, 52], logprobs=[-0.1, -0.2], stop_reason="length")
        rec_len = adapter.sample([{"role": "user", "content": "program"}])
        self.assertFalse(rec_len["complete"])
        self.assertNotIn("failure_reason", rec_len)
        r_len = rollout(ControlledBridge(), _StaticAdapter(rec_len), {"id": "t-len", "family": "f"}, cfg, 1)
        self.assertEqual(r_len["grade"]["reason"], "truncated_sample")
        self.assertEqual(summarize_records([r_len])["failure_categories"], {"truncation": 1})


class ToolTurnAnchorAndCompressionProtectionTests(unittest.TestCase):
    def test_stage6_config_defaults_and_validation(self):
        cfg = load_config()
        self.assertIsNone(cfg["tool_turn_anchor_weight"])
        self.assertFalse(cfg["compress_only_accurate_groups"])
        self.assertIsNone(cfg["compression_ll_threshold"])
        self.assertFalse(cfg["multiturn_opsd_on_failure"])

        ok = load_config(overrides={
            "tool_turn_anchor_weight": 0.85,
            "compress_only_accurate_groups": True,
            "compression_ll_threshold": -0.25,
            "multiturn_opsd_on_failure": True,
        })
        self.assertEqual(ok["tool_turn_anchor_weight"], 0.85)
        self.assertTrue(ok["compress_only_accurate_groups"])
        self.assertEqual(ok["compression_ll_threshold"], -0.25)
        self.assertTrue(ok["multiturn_opsd_on_failure"])

        for bad in (
            {"tool_turn_anchor_weight": -0.1},
            {"tool_turn_anchor_weight": True},
            {"tool_turn_anchor_weight": float("nan")},
            {"compress_only_accurate_groups": "yes"},
            {"compression_ll_threshold": True},
            {"compression_ll_threshold": float("inf")},
            {"multiturn_opsd_on_failure": 1},
        ):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                load_config(overrides=bad)

    def test_tool_turn_anchor_weight_targets_tool_turns_and_preserves_completion_turns(self):
        base_cfg = {
            "length_penalty": 0.25,
            "length_scale_tokens": 2048,
            "advantage_mode": "decoupled",
            "target_anchor_weight": 0.25,
            "tool_turn_anchor_weight": 0.9,
        }
        tool_records = [
            {"terminated": True, "target_logprob_sum": -0.5, "generated_tokens": 100, "is_tool_call": True},
            {"terminated": True, "target_logprob_sum": -1.5, "generated_tokens": 150, "is_tool_call": True},
        ]
        comp_records = [
            {"terminated": True, "target_logprob_sum": -0.5, "generated_tokens": 100, "is_tool_call": False},
            {"terminated": True, "target_logprob_sum": -1.5, "generated_tokens": 150, "is_tool_call": False},
        ]
        sig_tool = likelihood_advantages(tool_records, base_cfg)
        sig_comp = likelihood_advantages(comp_records, base_cfg)
        self.assertAlmostEqual(sum(sig_tool["target_advantages"]), 0.9 * 2, places=6)
        self.assertAlmostEqual(sum(sig_comp["target_advantages"]), 0.25 * 2, places=6)

        # Backwards compatibility when tool_turn_anchor_weight is None.
        sig_default = likelihood_advantages(tool_records, {**base_cfg, "tool_turn_anchor_weight": None})
        self.assertAlmostEqual(sum(sig_default["target_advantages"]), 0.25 * 2, places=6)

    def test_compression_ll_threshold_and_compress_only_accurate_groups_protect_hard_groups(self):
        cfg = {
            "length_penalty": 0.5,
            "length_scale_tokens": 2048,
            "advantage_mode": "decoupled",
            "target_anchor_weight": 0.25,
            "confident_length_std_floor": 32.0,
            "compress_only_accurate_groups": True,
            "compression_ll_threshold": -0.25,
        }
        # 1. Hard group (mean LL = -0.85 < -0.25) -> length MUST be 0 everywhere!
        hard = [
            {"terminated": True, "target_logprob_sum": -0.20, "generated_tokens": 100},
            {"terminated": True, "target_logprob_sum": -1.50, "generated_tokens": 600},
        ]
        sig_hard = likelihood_advantages(hard, cfg, coefficient=0.5)
        self.assertEqual(sig_hard["length_advantages"], [0.0, 0.0])
        self.assertFalse(sig_hard["length_signal"])

        # 2. Group with a truncated rollout -> compress_only_accurate_groups=True zeroes length!
        with_trunc = [
            {"terminated": True, "target_logprob_sum": -0.02, "generated_tokens": 100},
            {"terminated": True, "target_logprob_sum": -0.02, "generated_tokens": 400},
            {"terminated": False, "target_logprob_sum": None, "generated_tokens": 1000},
        ]
        sig_trunc = likelihood_advantages(with_trunc, cfg, coefficient=0.5)
        self.assertEqual(sig_trunc["length_advantages"], [0.0, 0.0, 0.0])
        self.assertFalse(sig_trunc["length_signal"])

        # 3. Confident 100%-terminated group (all LL >= -0.25) -> compression applies cleanly!
        easy = [
            {"terminated": True, "target_logprob_sum": -0.02, "generated_tokens": 100},
            {"terminated": True, "target_logprob_sum": -0.03, "generated_tokens": 400},
        ]
        sig_easy = likelihood_advantages(easy, cfg, coefficient=0.5)
        self.assertTrue(sig_easy["length_signal"])
        self.assertGreater(sig_easy["length_advantages"][0], 0.0)
        self.assertLess(sig_easy["length_advantages"][1], 0.0)
        self.assertGreater(sig_easy["advantages"][0], sig_easy["advantages"][1])

    def test_execution_advantages_protects_mixed_and_failing_multiturn_groups(self):
        mixed = [
            {"generated_tokens": 50, "grade": {"success": False}},
            {"generated_tokens": 100, "grade": {"success": True}},
            {"generated_tokens": 500, "grade": {"success": True}},
        ]
        cfg_protected = {"length_penalty": 0.4, "length_scale_tokens": 1000,
                         "advantage_mode": "decoupled", "compress_only_accurate_groups": True}
        sig_mixed = execution_advantages(mixed, cfg_protected, coefficient=0.4)
        self.assertEqual(sig_mixed["group_kind"], "mixed_success")
        self.assertEqual(sig_mixed["length_advantages"], [0.0, 0.0, 0.0])
        self.assertFalse(sig_mixed["length_signal"])
        self.assertLess(sig_mixed["advantages"][0], min(sig_mixed["advantages"][1:]))

        all_ok = [
            {"generated_tokens": 100, "grade": {"success": True}},
            {"generated_tokens": 500, "grade": {"success": True}},
        ]
        sig_ok = execution_advantages(all_ok, cfg_protected, coefficient=0.4)
        self.assertTrue(sig_ok["length_signal"])
        self.assertGreater(sig_ok["advantages"][0], sig_ok["advantages"][1])


class MultiturnOPSDOnFailureTests(unittest.TestCase):
    def test_real_tml_v0_score_rollout_turn_failure_and_trajectory_norm_anchor_preservation(self):
        adapter = TinkerAdapter({
            "effort": 0.5,
            "max_tokens": 512,
            "rl_token_normalization": "trajectory",
            "opsd_norm_mode": "sqrt",
        })
        sdk = adapter._sdk()
        tok = sdk.tokenizer

        tool_decl_json = json.dumps([{
            "type": "function",
            "function": {
                "name": "platform.dateNow",
                "description": "clock",
                "parameters": {
                    "type": "object",
                    "properties": {"arguments": {"type": "array"}},
                    "required": ["arguments"],
                },
            },
        }])
        teacher_msgs = [
            {"role": "system", "content": "Execute JS."},
            {"role": "tool_declare", "content": tool_decl_json},
            {"role": "user", "content": "function run(){const a=Date.now();const b=Date.now();return a+b;}"},
            {
                "role": "assistant",
                "content": [{"type": "thinking", "thinking": "call first Date.now"}],
                "tool_calls": [{"type": "function", "id": "call_1", "function": {"name": "platform.dateNow", "arguments": '{"arguments":[]}'}}],
            },
            {"role": "tool", "tool_call_id": "call_1", "name": "platform.dateNow", "content": '{"status":"fulfilled","value":100}'},
            {
                "role": "assistant",
                "content": [{"type": "thinking", "thinking": "call second Date.now"}],
                "tool_calls": [{"type": "function", "id": "call_2", "function": {"name": "platform.dateNow", "arguments": '{"arguments":[]}'}}],
            },
            {"role": "tool", "tool_call_id": "call_2", "name": "platform.dateNow", "content": '{"status":"fulfilled","value":200}'},
            {
                "role": "assistant",
                "content": [
                    {"type": "thinking", "thinking": "return 300"},
                    {"type": "text", "text": '```json\n{"type":"complete","kind":"return","arguments":[],"value":300}\n```'},
                ],
            },
        ]
        turns = adapter.extract_turn_targets(teacher_msgs)
        self.assertEqual(len(turns), 3)

        # Student succeeded at turn 0 with its own thinking, got observation 100,
        # then failed at turn k=1 by emitting wrong reasoning and wrong action!
        prefix_messages = [
            teacher_msgs[0],
            teacher_msgs[1],
            teacher_msgs[2],
            {"role": "assistant", "content": [{"type": "thinking", "thinking": "student turn0"}],
             "tool_calls": teacher_msgs[3]["tool_calls"]},
            teacher_msgs[4],
        ]
        prompt_k1 = sdk.renderer.build_generation_prompt(prefix_messages, effort=0.5).to_ints()
        wrong_assistant = {
            "role": "assistant",
            "content": [
                {"type": "thinking", "thinking": "skip second clock"},
                {"type": "text", "text": '```json\n{"type":"complete","kind":"return","arguments":[],"value":100}\n```'},
            ],
        }
        full_k1 = sdk.renderer.build_supervised_examples(prefix_messages + [wrong_assistant], effort=0.5)[0][0].to_ints()
        wrong_tokens = list(full_k1[len(prompt_k1):])
        student_lps = [-2.0] * len(wrong_tokens)
        fail_sample = {
            "prompt_tokens": prompt_k1,
            "token_ids": wrong_tokens,
            "logprobs": student_lps,
            "message": wrong_assistant,
            "sampler_revision": "tinker://s/0",
        }

        scored_inputs: list[tuple[list[int], int | None]] = []

        class _FakeClient:
            def compute_logprobs(self, model_input, prompt_logprobs_last_n=None):
                ids = model_input.to_ints()
                scored_inputs.append((ids, prompt_logprobs_last_n))
                # Return -0.5 for teacher thinking logprobs, -0.3 for anchor action logprobs.
                val = -0.5 if len(scored_inputs) == 1 else -0.3
                return Future([val] * len(ids))

        class _FakeTrainer(Trainer):
            def forward_backward(self, datums, loss_fn, loss_fn_config=None):
                self.calls.append(("forward_backward", datums, loss_fn))
                return Future(SimpleNamespace(metrics={"loss:sum": 0.2}, loss_fn_outputs=[
                    {"logprobs": [-0.4] * len(_tensor_values(d.loss_fn_inputs["target_tokens"]))} for d in datums
                ]))

        client = _FakeClient()
        trainer = _FakeTrainer(client)
        adapter.sampling_client = client
        adapter.sampling_revision = "tinker://s/0"
        adapter.training_client = trainer

        credit = adapter.score_rollout_turn_failure(
            fail_sample,
            prefix_messages,
            turns[1],
            opsd_coef=0.4,
            opsd_clip=5.0,
            anchor_weight=0.8,
        )
        deltas = credit["opsd_token_deltas"]
        anchor = credit["anchor_sample"]
        self.assertIsNotNone(deltas)
        self.assertIsNotNone(anchor)
        self.assertEqual(len(deltas), len(wrong_tokens))

        # Verify ONLY thinking tokens [2 : end_idx] got OPSD deltas (0.4 * (-0.5 - (-2.0)) = +0.6),
        # while [0, 1] (<|message_model|><|content_thinking|>) and post-thinking tokens got 0.0!
        msg_model_id, thinking_id, end_id = adapter.thinking_token_ids()
        self.assertEqual(wrong_tokens[:2], [msg_model_id, thinking_id])
        think_end = 2 + wrong_tokens[2:].index(end_id) + 1
        self.assertEqual(credit["opsd_tokens_scored"], think_end - 2)
        self.assertEqual(deltas[:2], [0.0, 0.0])
        for d in deltas[2:think_end]:
            self.assertAlmostEqual(d, 0.6, places=6)
        self.assertTrue(all(d == 0.0 for d in deltas[think_end:]))

        # Verify teacher prompt had <mechanistic_trace> front-loaded AND preserved student turn 0!
        teacher_call_ids, teacher_last_n = scored_inputs[0]
        self.assertEqual(teacher_last_n, think_end - 2)
        teacher_prompt_text = tok.decode(teacher_call_ids[:-teacher_last_n])
        self.assertIn("<mechanistic_trace>", teacher_prompt_text)
        self.assertIn("student turn0", teacher_prompt_text)
        self.assertLess(teacher_prompt_text.index("<mechanistic_trace>"), teacher_prompt_text.index("function run()"))

        # Verify anchor sample conditions on causal prefix + zero-thinking, targets turns[1] action,
        # and keeps exact weight 0.8 even under trajectory normalization!
        self.assertEqual(anchor["prompt_tokens"], prompt_k1 + [msg_model_id, thinking_id, end_id])
        self.assertEqual(anchor["token_ids"], turns[1]["target_action_tokens"])
        self.assertEqual(anchor["token_advantages"], [0.8] * len(turns[1]["target_action_tokens"]))
        self.assertTrue(anchor["is_target_anchor"])

        # Now feed both the failing rollout trajectory and its anchor trajectory into adapter.rl_train
        # with rl_token_normalization="trajectory" and opsd_norm_mode="sqrt".
        fail_sample["opsd_token_deltas"] = deltas
        turn0_len = 100
        turn0_sample = {
            "prompt_tokens": [1, 2],
            "token_ids": list(range(10, 10 + turn0_len)),
            "logprobs": [-0.2] * turn0_len,
        }
        other_len = 20
        other_sample = {
            "prompt_tokens": [1, 2],
            "token_ids": list(range(20, 20 + other_len)),
            "logprobs": [-0.2] * other_len,
        }
        adapter.rl_train([
            {"samples": [turn0_sample, fail_sample], "advantage": -1.0},
            {"samples": [other_sample], "advantage": 1.0},
            {"samples": [anchor], "advantage": 0.0, "is_anchor": True},
        ])
        datums = trainer.calls[0][1]
        self.assertEqual(len(datums), 4)
        # Anchor datum (index 3) MUST retain exact 0.8 advantage (NOT distorted by trajectory norm)!
        anchor_advs = _tensor_values(datums[3].loss_fn_inputs["advantages"])
        anchor_prefix_len = len(anchor["prompt_tokens"]) - 1
        self.assertEqual(anchor_advs[:anchor_prefix_len], [0.0] * anchor_prefix_len)
        for got in anchor_advs[anchor_prefix_len:]:
            self.assertAlmostEqual(got, 0.8, places=5)

    def test_train_rl_multiturn_opsd_on_failure_trains_all_failure_groups_and_skips_turn_budget(self):
        adapter, service, renderer = fake_adapter({
            "rl_token_normalization": "trajectory",
            "opsd_norm_mode": "sqrt",
            "max_tokens": 64,
        })
        adapter._thinking_ids = (10, 11, 99)
        adapter.sampling_client = service.sampler
        adapter.sampling_revision = "tinker://sampler/sft"
        adapter.create_sampling_client = lambda checkpoint=None: setattr(adapter, "sampling_revision", checkpoint or "base")
        adapter.checkpoint = lambda name, **kw: {
            "training_path": f"tinker://train/{name}",
            "sampler_path": f"tinker://sampler/{name}",
            "step": 1,
        }

        # Two rollouts in an all-failure group:
        # Rollout 0: succeeds turn 0 ("read"), then fails turn 1 ("wrong") -> failed at k=1!
        # Rollout 1: fails immediately at turn 0 ("wrong") -> failed at k=0!
        rollout_script = [
            ({"role": "assistant", "content": [{"type": "thinking", "thinking": "t0"}, {"type": "text", "text": "read"}]},
             [10, 11, 41, 99, 42], [-0.2, -0.1, -1.5, -0.2, -0.3]),
            ({"role": "assistant", "content": [{"type": "thinking", "thinking": "t1"}, {"type": "text", "text": "wrong"}]},
             [10, 11, 43, 44, 99, 45], [-0.2, -0.1, -2.0, -2.0, -0.2, -0.3]),
            ({"role": "assistant", "content": [{"type": "thinking", "thinking": "t0_fail"}, {"type": "text", "text": "wrong"}]},
             [10, 11, 51, 99, 52], [-0.2, -0.1, -2.0, -0.2, -0.3]),
        ]

        def scripted_sample(messages, max_tokens=None, seed=None, temperature=None):
            msg, toks, lps = rollout_script.pop(0)
            renderer.message = msg
            service.sampler.sequence = SimpleNamespace(tokens=toks, logprobs=lps, stop_reason="stop")
            return TinkerAdapter.sample(adapter, messages, max_tokens=max_tokens, seed=seed, temperature=temperature)

        adapter.sample = scripted_sample
        adapter.extract_turn_targets = lambda msgs: [
            {
                "turn_index": 0, "message_index": 1, "prefix_tokens": [1, 2],
                "thinking_prompt_tokens": [1, 2, 10, 11],
                "teacher_thinking_prompt_tokens": [1, 2, 3, 10, 11],
                "target_action_tokens": [10, 20, 99],
                "is_tool_call": True, "operation": "demo.read",
            },
            {
                "turn_index": 1, "message_index": 3, "prefix_tokens": [1, 2, 3],
                "thinking_prompt_tokens": [1, 2, 3, 10, 11],
                "teacher_thinking_prompt_tokens": [1, 2, 3, 4, 10, 11],
                "target_action_tokens": [10, 30, 99],
                "is_tool_call": False, "operation": "complete",
            },
        ]

        row = {
            "id": "eff-all-fail",
            "family": "fam-eff",
            "sourceHash": "src-eff",
            "task": {"id": "eff-all-fail", "family": "fam-eff", "source": "function run(){return 1;}",
                     "entry": "run", "args": [], "fixture": {"calls": [{"operation": "demo.read", "arguments": []}]}},
            "metadata": {"tier": 5, "features": ["hard-effectful"], "externalCalls": 1},
            "split": "train",
            "messages": [
                {"role": "user", "content": "exec"},
                {"role": "assistant", "content": [{"type": "thinking", "thinking": "do read"}],
                 "tool_calls": [{"type": "function", "id": "c1", "function": {"name": "demo.read", "arguments": '{"arguments":[]}'}}]},
                {"role": "tool", "tool_call_id": "c1", "name": "demo.read", "content": '{"status":"fulfilled","value":1}'},
                {"role": "assistant", "content": [{"type": "thinking", "thinking": "done"}, {"type": "text", "text": "complete"}]},
            ],
        }
        cfg = load_config(overrides={
            "rl_objective": "likelihood",
            "rl_steps": 1,
            "rl_prompts_per_step": 1,
            "group_size": 2,
            "multiturn_rollout_fraction": 1.0,
            "multiturn_opsd_on_failure": True,
            "target_anchor_weight": 0.25,
            "tool_turn_anchor_weight": 0.8,
            "opsd_coef": 0.4,
            "opsd_norm_mode": "sqrt",
            "rl_token_normalization": "trajectory",
            "validation_every": 0,
            "checkpoint_every": 1,
        })
        state = {
            "phase": "sft_done", "rl_steps_completed": 0,
            "training_path": "tinker://train/sft", "sampler_path": "tinker://sampler/sft",
            "compression_gate_open": True, "evaluations": [],
        }
        stderr_buf = io.StringIO()
        with tempfile.TemporaryDirectory() as d, contextlib.redirect_stderr(stderr_buf):
            train_rl(ControlledBridge(), adapter, [row], cfg, Path(d), state, random.Random(17), training_ready=True)
            metrics_rows = [json.loads(line) for line in (Path(d) / "metrics.jsonl").read_text().splitlines()]
            rl_metric = next(m for m in metrics_rows if m.get("stage") == "rl")
            rollouts = read_jsonl(Path(d) / "rollouts/rl-000001.jsonl")

        # All-failure rollout group still trained (not skipped!) thanks to dense failure OPSD + anchor!
        self.assertEqual(state["rl_optimizer_updates"], 1)
        self.assertEqual(rl_metric["multiturn_rollout_groups"], 1)
        self.assertAlmostEqual(rl_metric["multiturn_rollout_acc"], 0.0, places=6)
        self.assertEqual(rl_metric["multiturn_opsd_turns"], 2)
        self.assertIn("opsd_turns=2", stderr_buf.getvalue())

        # Rollout 0 failed at turn k=1 (completion -> anchor weight 0.25); Rollout 1 failed at k=0 (tool -> weight 0.8).
        self.assertEqual(rollouts[0]["multiturn_failed_turn_index"], 1)
        self.assertEqual(rollouts[1]["multiturn_failed_turn_index"], 0)
        self.assertIsNone(rollouts[0]["samples"][0].get("opsd_token_deltas"))
        self.assertIsNotNone(rollouts[0]["samples"][1].get("opsd_token_deltas"))
        self.assertIsNotNone(rollouts[1]["samples"][0].get("opsd_token_deltas"))
        self.assertEqual(rollouts[0]["multiturn_anchor_sample"]["token_advantages"], [0.25] * 3)
        self.assertEqual(rollouts[1]["multiturn_anchor_sample"]["token_advantages"], [0.8] * 3)

        # Verify summarize_records works cleanly (anchor sample was not stuffed into record["samples"]).
        summary = summarize_records(rollouts)
        self.assertEqual(summary["executions"], 2)

        # Verify turn_budget_exhausted does NOT apply failure credit to a valid intermediate tool turn!
        rollout_script.extend([
            ({"role": "assistant", "content": [{"type": "thinking", "thinking": "t0"}, {"type": "text", "text": "read"}]},
             [10, 11, 41, 99, 42], [-0.2, -0.1, -1.5, -0.2, -0.3]),
            ({"role": "assistant", "content": [{"type": "thinking", "thinking": "t0b"}, {"type": "text", "text": "read"}]},
             [10, 11, 41, 99, 42], [-0.2, -0.1, -1.5, -0.2, -0.3]),
        ])
        cfg_budget = load_config(overrides={
            **{k: cfg[k] for k in (
                "rl_objective", "rl_steps", "rl_prompts_per_step", "group_size",
                "multiturn_rollout_fraction", "multiturn_opsd_on_failure",
                "target_anchor_weight", "tool_turn_anchor_weight", "opsd_coef",
            )},
            "max_turns": 1,
            "validation_every": 0,
            "checkpoint_every": 1,
        })
        state_budget = {
            "phase": "sft_done", "rl_steps_completed": 0,
            "training_path": "tinker://train/sft", "sampler_path": "tinker://sampler/sft",
            "compression_gate_open": True, "evaluations": [],
        }
        with tempfile.TemporaryDirectory() as d:
            train_rl(ControlledBridge(), adapter, [row], cfg_budget, Path(d), state_budget, random.Random(17), training_ready=True)
            m_budget = json.loads((Path(d) / "metrics.jsonl").read_text().splitlines()[-1])
            self.assertEqual(m_budget["multiturn_opsd_turns"], 0)
            self.assertEqual(state_budget.get("rl_optimizer_updates", 0), 0)


class HardMinerSampleModeResumeTests(unittest.TestCase):
    def test_sample_mode_incremental_flush_truncated_line_resume_and_context_overflow(self):
        rows = [
            {
                "id": "s-cached", "family": "f0", "sourceHash": "h0", "split": "train",
                "task": {"id": "s-cached", "family": "f0", "source": "function run(){return 1;}"},
                "metadata": {"tier": 3, "features": ["native-v8"], "externalCalls": 0},
                "messages": [{"role": "user", "content": "s-cached"}, {"role": "assistant", "content": "ok"}],
            },
            {
                "id": "s-overflow", "family": "f1", "sourceHash": "h1", "split": "train",
                "task": {"id": "s-overflow", "family": "f1", "source": "function run(){return 2;}"},
                "metadata": {"tier": 3, "features": ["native-v8"], "externalCalls": 0},
                "messages": [{"role": "user", "content": "s-overflow"}, {"role": "assistant", "content": "ok"}],
            },
            {
                "id": "s-hard", "family": "f2", "sourceHash": "h2", "split": "train",
                "task": {"id": "s-hard", "family": "f2", "source": "function run(){return 3;}"},
                "metadata": {"tier": 3, "features": ["native-v8"], "externalCalls": 0},
                "messages": [{"role": "user", "content": "s-hard"}, {"role": "assistant", "content": "ok"}],
            },
        ]

        class _SampleResumeAdapter:
            def __init__(self):
                self.sampled_ids = []

            def create_sampling_client(self, checkpoint=None):
                return None

            def extract_turn_targets(self, messages):
                tid = messages[0]["content"]
                return [{"turn_index": 0, "task_id": tid, "prefix_tokens": [1],
                         "thinking_prompt_tokens": [1, 10, 11], "target_action_tokens": [10, 20]}]

            def sample_thinking_and_score_target(self, turn_target, *, seed, max_tokens=None):
                tid = turn_target["task_id"]
                self.sampled_ids.append(tid)
                if tid == "s-overflow":
                    raise ContextOverflow("too long for context")
                return {"terminated": True, "target_logprob_sum": -0.9, "generated_tokens": 300}

        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            ds_path = root / "in.jsonl"
            out_path = root / "out.jsonl"
            scores_path = root / "scores.jsonl"
            write_jsonl(ds_path, rows)
            # Pre-populate scores.jsonl with one completed sample record + one simulated crash-truncated trailing line.
            cached_rec = {
                "id": "s-cached", "split": "train", "mode": "sample",
                "is_hard": False, "is_always_keep": False, "min_ll": -0.02,
                "turn_lls": [-0.02], "turns_scored": 1, "total_turns": 1,
                "terminated": True, "generated_tokens": 120,
                "features": ["native-v8"], "externalCalls": 0, "language": None, "error": None,
            }
            scores_path.write_text(json.dumps(cached_rec) + '\n{"id":"s-overflow","broken', encoding="utf-8")

            adapter = _SampleResumeAdapter()
            stdout_buf = io.StringIO()
            stderr_buf = io.StringIO()
            with patch.object(mine_hard, "TinkerAdapter", return_value=adapter), \
                    contextlib.redirect_stdout(stdout_buf), \
                    contextlib.redirect_stderr(stderr_buf):
                rc = mine_hard.main([
                    "--dataset", str(ds_path),
                    "--output", str(out_path),
                    "--scores-out", str(scores_path),
                    "--mode", "sample",
                    "--concurrency", "2",
                    "--easy-replay-fraction", "0.0",
                ])
            self.assertEqual(rc, 0)
            # s-cached was resumed from scores_path without resampling; s-overflow & s-hard ran cleanly.
            self.assertEqual(sorted(adapter.sampled_ids), ["s-hard", "s-overflow"])
            self.assertIn("ignoring truncated trailing line", stderr_buf.getvalue())
            summary = json.loads(stdout_buf.getvalue())
            self.assertEqual(summary["train_hard"], 2)
            self.assertEqual(summary["train_dropped_easy"], 1)
            scores_written = read_jsonl(scores_path)
            self.assertEqual([r["id"] for r in scores_written], ["s-cached", "s-overflow", "s-hard"])
            self.assertEqual(scores_written[1]["error"], "context_overflow")
            self.assertTrue(scores_written[1]["is_hard"])
            out_written = read_jsonl(out_path)
            self.assertEqual([r["id"] for r in out_written], ["s-overflow", "s-hard"])


if __name__ == "__main__":
    unittest.main()
