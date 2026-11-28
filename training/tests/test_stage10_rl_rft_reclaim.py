"""Comprehensive unit tests for Stage 10 upgrades:

1. External prefix-progress partial shaping (JS + Python grading, reward, decoupled/centered advantages, hybrid RL, config caps).
2. Rejection-Sampled Fine-Tuning (RFT) collector CLI (`tools/tinker-rft-collect.py`).
3. Zero-leakage validation/test reclamation & Stage 10 dataset merger CLI (`tools/tinker-reclaim-train.py`).
"""

from __future__ import annotations

import copy
import importlib.util
import json
from pathlib import Path
import random
import sys
import tempfile
import unittest

from tinker_js.adapter import TinkerAdapter
from tinker_js.learning import execution_advantages, external_prefix_shaping_reward
from tinker_js.runner import (
    Bridge,
    DEFAULTS,
    RolloutError,
    export_dataset,
    load_config,
    read_jsonl,
    rollout,
    split_examples,
    train_rl,
    validate_fixtures,
    write_jsonl,
)
from tinker_py.execution import create_python_session, prepare_python_task

REPO_ROOT = Path(__file__).resolve().parents[2]


def _load_tool_module(filename: str, module_name: str):
    path = REPO_ROOT / "tools" / filename
    spec = importlib.util.spec_from_file_location(module_name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
    return module


rft_collect = _load_tool_module("tinker-rft-collect.py", "tinker_rft_collect")
reclaim_train = _load_tool_module("tinker-reclaim-train.py", "tinker_reclaim_train")


def _js_external_task(task_id: str = "js-ext-3", *, split: str = "train") -> dict:
    return {
        "id": task_id,
        "family": f"fam-{task_id}",
        "executionMode": "native",
        "source": (
            "const fs = require('node:fs');\n"
            "function run(a, b) {\n"
            "  const x = fs.readFileSync(a, 'utf8');\n"
            "  const y = fs.readFileSync(b, 'utf8');\n"
            "  fs.writeFileSync('out.txt', x + '+' + y);\n"
            "  return x + '+' + y;\n"
            "}\n"
        ),
        "entry": "run",
        "args": ["f1.txt", "f2.txt"],
        "fixture": {
            "calls": [
                {"operation": "fs.readText", "arguments": ["f1.txt"], "status": "fulfilled", "result": "foo"},
                {"operation": "fs.readText", "arguments": ["f2.txt"], "status": "fulfilled", "result": "bar"},
                {"operation": "fs.writeText", "arguments": ["out.txt", "foo+bar"], "status": "fulfilled", "result": {"$js": "undefined"}},
            ]
        },
        "metadata": {"tier": 4, "features": ["external", "hard-effectful"], "externalCalls": 3},
        "split": split,
    }


def _py_multifile_external_task(task_id: str = "py-mf-ext") -> dict:
    return {
        "id": task_id,
        "family": f"fam-{task_id}",
        "language": "py",
        "files": {
            "main.py": (
                "import helper\n"
                "def run(p1, p2):\n"
                "    with open(p1, 'r') as f:\n"
                "        a = f.read()\n"
                "    with open(p2, 'r') as f:\n"
                "        b = f.read()\n"
                "    return helper.save(a, b)\n"
            ),
            "helper.py": (
                "def save(a, b):\n"
                "    out = f'{a}:{b}'\n"
                "    with open('out.txt', 'w') as f:\n"
                "        f.write(out)\n"
                "    return out\n"
            ),
        },
        "entryFile": "main.py",
        "entry": "run",
        "args": ["a.txt", "b.txt"],
        "fixture": {
            "calls": [
                {"operation": "fs.readText", "arguments": ["a.txt"], "status": "fulfilled", "result": "hi"},
                {"operation": "fs.readText", "arguments": ["b.txt"], "status": "fulfilled", "result": "py"},
                {"operation": "fs.writeText", "arguments": ["out.txt", "hi:py"], "status": "fulfilled", "result": None},
            ]
        },
        "metadata": {"tier": 5, "features": ["python", "multifile", "external"], "externalCalls": 3},
        "split": "train",
    }


def _py_pure_task(task_id: str = "py-pure-1") -> dict:
    return {
        "id": task_id,
        "family": f"fam-{task_id}",
        "language": "py",
        "source": "def run(x, y):\n    return x * y + 1\n",
        "entry": "run",
        "args": [6, 7],
        "fixture": {"calls": []},
        "metadata": {"tier": 2, "features": ["python"], "externalCalls": 0},
        "split": "train",
    }


# =============================================================================
# 1. External Prefix-Progress Partial Shaping Tests
# =============================================================================


class PrefixProgressShapingTests(unittest.TestCase):
    def test_python_session_tracks_matched_and_expected_external_calls_excluding_code_load(self):
        prepared = prepare_python_task(_py_multifile_external_task(), trace_format="actions-only")

        # Case A: code.load + 2 matched external calls + 1 mismatch -> matched=2, expected=3
        sess = create_python_session(prepared)
        try:
            r0 = sess.step({
                "role": "assistant",
                "content": "",
                "tool_calls": [{"id": "cl1", "type": "function", "function": {"name": "code.load", "arguments": json.dumps({"arguments": [{"path": "helper.py"}]})}}],
            }, 10)
            self.assertFalse(r0["done"])
            r1 = sess.step({
                "role": "assistant",
                "content": "",
                "tool_calls": [{"id": "c1", "type": "function", "function": {"name": "fs.readText", "arguments": '{"arguments":["a.txt"]}'}}],
            }, 20)
            self.assertFalse(r1["done"])
            r2 = sess.step({
                "role": "assistant",
                "content": "",
                "tool_calls": [{"id": "c2", "type": "function", "function": {"name": "fs.readText", "arguments": '{"arguments":["b.txt"]}'}}],
            }, 30)
            self.assertFalse(r2["done"])
            r3 = sess.step({
                "role": "assistant",
                "content": "",
                "tool_calls": [{"id": "c3", "type": "function", "function": {"name": "fs.writeText", "arguments": '{"arguments":["out.txt","BAD"]}'}}],
            }, 40)
            self.assertTrue(r3["done"])
            g = r3["grade"]
            self.assertFalse(g["success"])
            self.assertFalse(g["complete"])
            self.assertEqual(g["failureCategory"], "incorrect-external-request")
            self.assertEqual(g["codeLoadCalls"], 1)
            self.assertEqual(g["matchedExternalCalls"], 2)
            self.assertEqual(g["expectedExternalCalls"], 3)
            self.assertEqual(g["matched_external_calls"], 2)
            self.assertEqual(g["expected_external_calls"], 3)
        finally:
            sess.close()

        # Case B: 1 matched call then early completion -> missing-external-effects, matched=1, expected=3
        sess2 = create_python_session(prepared)
        try:
            sess2.step({
                "role": "assistant",
                "content": "",
                "tool_calls": [{"id": "c1", "type": "function", "function": {"name": "fs.readText", "arguments": '{"arguments":["a.txt"]}'}}],
            }, 10)
            early = sess2.step('```json\n{"type":"complete","kind":"return","arguments":["a.txt","b.txt"],"value":"hi:py"}\n```', 20)
            self.assertTrue(early["done"])
            g = early["grade"]
            self.assertFalse(g["success"])
            self.assertFalse(g["complete"])
            self.assertEqual(g["failureCategory"], "missing-external-effects")
            self.assertEqual(g["matchedExternalCalls"], 1)
            self.assertEqual(g["expectedExternalCalls"], 3)
        finally:
            sess2.close()

    def test_shaping_reward_formula_gating_and_cap(self):
        grade_mismatch = {
            "success": False,
            "complete": False,
            "failureCategory": "incorrect-external-request",
            "matchedExternalCalls": 4,
            "expectedExternalCalls": 5,
        }
        # Default weight 0.0 -> strictly 0.0
        self.assertEqual(DEFAULTS["external_prefix_shaping_weight"], 0.0)
        self.assertEqual(external_prefix_shaping_reward(grade_mismatch, {"external_prefix_shaping_weight": 0.0}), 0.0)
        self.assertEqual(external_prefix_shaping_reward(grade_mismatch, {}), 0.0)

        # Positive weight -> weight * (matched / expected)
        self.assertAlmostEqual(
            external_prefix_shaping_reward(grade_mismatch, {"external_prefix_shaping_weight": 0.4}),
            0.32,
            places=6,
        )
        # Strictly capped at 0.45 even when weight * ratio > 0.45
        self.assertAlmostEqual(
            external_prefix_shaping_reward(grade_mismatch, {"external_prefix_shaping_weight": 0.9}),
            0.45,
            places=6,
        )
        # Works for missing-external-effects too
        grade_missing = {
            "success": False,
            "failure_category": "missing-external-effects",
            "matched_external_calls": 2,
            "expected_external_calls": 4,
        }
        self.assertAlmostEqual(
            external_prefix_shaping_reward(grade_missing, {"external_prefix_shaping_weight": 0.4}),
            0.20,
            places=6,
        )
        # Non-shapable failure categories get 0.0
        for cat in ("wrong-return", "malformed-action", "turn-limit", None):
            g = {**grade_mismatch, "failureCategory": cat}
            self.assertEqual(external_prefix_shaping_reward(g, {"external_prefix_shaping_weight": 0.4}), 0.0)
        # Zero matched or zero expected -> 0.0
        self.assertEqual(
            external_prefix_shaping_reward({**grade_mismatch, "matchedExternalCalls": 0}, {"external_prefix_shaping_weight": 0.4}),
            0.0,
        )
        self.assertEqual(
            external_prefix_shaping_reward({**grade_mismatch, "expectedExternalCalls": 0}, {"external_prefix_shaping_weight": 0.4}),
            0.0,
        )
        # Success -> 0.0 shaping (exact 1.0 reward handled separately)
        self.assertEqual(
            external_prefix_shaping_reward({**grade_mismatch, "success": True}, {"external_prefix_shaping_weight": 0.4}),
            0.0,
        )

    def test_execution_advantages_all_failure_multiturn_group_produces_nonzero_signal(self):
        def _fail_rec(matched: int, expected: int, tokens: int, cat: str = "incorrect-external-request") -> dict:
            return {
                "generated_tokens": tokens,
                "grade": {
                    "success": False,
                    "complete": False,
                    "failureCategory": cat,
                    "matchedExternalCalls": matched,
                    "expectedExternalCalls": expected,
                },
            }

        records = [
            _fail_rec(4, 5, 400),
            _fail_rec(2, 5, 300),
            _fail_rec(0, 5, 200),
            _fail_rec(0, 5, 100),
        ]

        # Weight = 0.0 -> identical historical zero-advantage behavior
        cfg_off = {"length_penalty": 0.25, "length_scale_tokens": 2048, "advantage_mode": "decoupled", "external_prefix_shaping_weight": 0.0}
        sig_off = execution_advantages(records, cfg_off, coefficient=0.25)
        self.assertTrue(sig_off["zero_advantage_group"])
        self.assertEqual(sig_off["advantages"], [0.0, 0.0, 0.0, 0.0])
        self.assertEqual(sig_off["group_kind"], "all_failure")

        # Weight = 0.45 -> meaningful non-zero RL advantage separating 4/5 > 2/5 > 0/5!
        cfg_on = {**cfg_off, "external_prefix_shaping_weight": 0.45}
        sig_on = execution_advantages(records, cfg_on, coefficient=0.25)
        self.assertFalse(sig_on["zero_advantage_group"])
        self.assertTrue(sig_on["correctness_signal"])
        self.assertTrue(sig_on["prefix_shaping_signal"])
        self.assertFalse(sig_on["length_signal"])  # Failures NEVER receive length credit
        self.assertEqual(sig_on["group_kind"], "all_failure")  # Still honestly reported as all_failure
        self.assertAlmostEqual(sum(sig_on["advantages"]), 0.0, places=6)
        self.assertGreater(sig_on["advantages"][0], sig_on["advantages"][1])
        self.assertGreater(sig_on["advantages"][1], sig_on["advantages"][2])
        self.assertAlmostEqual(sig_on["advantages"][2], sig_on["advantages"][3], places=6)

        # Mixed group: exact pass (1.0) strictly dominates partial 4/5 (0.36) > 0/5 (0.0)
        mixed = [
            {"generated_tokens": 500, "grade": {"success": True, "complete": True, "matchedExternalCalls": 5, "expectedExternalCalls": 5}},
            _fail_rec(4, 5, 300),
            _fail_rec(0, 5, 200),
            _fail_rec(0, 5, 200),
        ]
        sig_mix = execution_advantages(mixed, cfg_on, coefficient=0.25)
        self.assertEqual(sig_mix["group_kind"], "mixed_success")
        self.assertGreater(sig_mix["advantages"][0], sig_mix["advantages"][1])
        self.assertGreater(sig_mix["advantages"][1], sig_mix["advantages"][2])

        # Centered mode works too
        sig_centered = execution_advantages(records, {**cfg_on, "advantage_mode": "centered"}, coefficient=0.25)
        self.assertFalse(sig_centered["zero_advantage_group"])
        self.assertGreater(sig_centered["advantages"][0], sig_centered["advantages"][1])

    def test_rollout_and_hybrid_rl_with_real_js_bridge_and_prefix_shaping(self):
        task = _js_external_task("js-prefix-rl")
        cfg = load_config(None, {
            "rl_objective": "likelihood",
            "advantage_mode": "decoupled",
            "multiturn_rollout_fraction": 1.0,
            "external_prefix_shaping_weight": 0.45,
            "rl_steps": 1,
            "group_size": 4,
            "sft_epochs": 0,
            "validation_every": 0,
            "final_test": False,
            "opsd_max_trace_chars": 48000,
            "rollout_concurrency": 24,
        })
        self.assertEqual(cfg["opsd_max_trace_chars"], 48000)
        self.assertEqual(cfg["rollout_concurrency"], 24)
        self.assertEqual(cfg["external_prefix_shaping_weight"], 0.45)

        # Confirm TinkerAdapter accepts opsd_max_trace_chars=48000 with no cap
        adapter_check = TinkerAdapter({"opsd_max_trace_chars": 48000})
        self.assertEqual(adapter_check.opsd_max_trace_chars, 48000)

        # Invalid shaping weights rejected
        for bad in (-0.1, 1.1, True, float("nan")):
            with self.assertRaises(ValueError):
                load_config(None, {"external_prefix_shaping_weight": bad})

        class _PartialPrefixAdapter:
            backend_name = "mock"

            def __init__(self):
                self.sampling_revision = "tinker://sampler/init"
                self.trained = []
                self._rollout_counter = 0
                self._plans = [
                    # Rollout 0: matches 2/3 external calls, fails on 3rd
                    [
                        {"role": "assistant", "content": "", "tool_calls": [{"id": "c1", "type": "function", "function": {"name": "fs.readText", "arguments": '{"arguments":["f1.txt"]}'}}]},
                        {"role": "assistant", "content": "", "tool_calls": [{"id": "c2", "type": "function", "function": {"name": "fs.readText", "arguments": '{"arguments":["f2.txt"]}'}}]},
                        {"role": "assistant", "content": "", "tool_calls": [{"id": "c3", "type": "function", "function": {"name": "fs.writeText", "arguments": '{"arguments":["out.txt","WRONG"]}'}}]},
                    ],
                    # Rollout 1: matches 1/3 external calls, fails on 2nd
                    [
                        {"role": "assistant", "content": "", "tool_calls": [{"id": "c1", "type": "function", "function": {"name": "fs.readText", "arguments": '{"arguments":["f1.txt"]}'}}]},
                        {"role": "assistant", "content": "", "tool_calls": [{"id": "c2", "type": "function", "function": {"name": "fs.readText", "arguments": '{"arguments":["wrong.txt"]}'}}]},
                    ],
                    # Rollout 2 & 3: fail on 1st call (0/3 matched)
                    [
                        {"role": "assistant", "content": "", "tool_calls": [{"id": "c1", "type": "function", "function": {"name": "fs.readText", "arguments": '{"arguments":["wrong.txt"]}'}}]},
                    ],
                    [
                        {"role": "assistant", "content": "", "tool_calls": [{"id": "c1", "type": "function", "function": {"name": "fs.readText", "arguments": '{"arguments":["wrong2.txt"]}'}}]},
                    ],
                ]
                self._active_plan_idx = -1

            def create_training_client(self, checkpoint=None):
                return None

            def create_sampling_client(self, checkpoint=None):
                self.sampling_revision = checkpoint or "base"

            def checkpoint(self, name, **kwargs):
                return {"training_path": f"tinker://train/{name}", "sampler_path": f"tinker://sampler/{name}", "step": 1}

            def sample(self, messages, *, max_tokens, seed, temperature=None, clamp_to_context=False):
                turn_idx = sum(1 for m in messages if m.get("role") == "assistant")
                if turn_idx == 0:
                    self._active_plan_idx = self._rollout_counter
                    self._rollout_counter += 1
                msg = self._plans[self._active_plan_idx][turn_idx]
                return {
                    "prompt_tokens": [1, 2, 3],
                    "token_ids": [10, 11, 12],
                    "logprobs": [-0.2, -0.2, -0.2],
                    "message": msg,
                    "complete": True,
                    "stop_reason": "stop",
                    "sampler_revision": self.sampling_revision,
                }

            def rl_train(self, trajectories, **options):
                self.trained.append(copy.deepcopy(trajectories))
                return {"loss": 0.1}

        with tempfile.TemporaryDirectory() as tmp:
            out_dir = Path(tmp)
            with Bridge(REPO_ROOT, timeout=30) as bridge:
                exported = bridge.request("export", task=task, traceFormat="compact", reasoningChannel="thinking")
                exported["split"] = "train"
                adapter = _PartialPrefixAdapter()

                # Direct rollout check first (concurrency=1 sequential for deterministic plan order)
                cfg_seq = {**cfg, "rollout_concurrency": 1}
                state = {
                    "phase": "sft_done",
                    "training_path": "tinker://train/sft",
                    "sampler_path": "tinker://sampler/sft",
                    "sft_training_path": "tinker://train/sft",
                    "sft_sampler_path": "tinker://sampler/sft",
                    "rl_steps_completed": 0,
                    "sft_batches_completed": 0,
                    "evaluations": [],
                    "validation_candidates": [],
                    "config_hash": "h",
                    "dataset_hash": "d",
                    "implementation_hash": "i",
                }
                (out_dir / "state.json").write_text(json.dumps(state))
                train_rl(bridge, adapter, [exported], cfg_seq, out_dir, state, random.Random(17))

            # Even with 0/4 exact passes, RL update MUST have fired due to prefix-progress shaping!
            self.assertEqual(len(adapter.trained), 1)
            trajs = adapter.trained[0]
            self.assertEqual(len(trajs), 4)
            advs = [t["advantage"] for t in trajs]
            self.assertGreater(advs[0], advs[1])
            self.assertGreater(advs[1], advs[2])
            self.assertAlmostEqual(advs[2], advs[3], places=6)

            saved_rollouts = read_jsonl(out_dir / "rollouts" / "rl-000001.jsonl")
            self.assertEqual(len(saved_rollouts), 4)
            for rec in saved_rollouts:
                self.assertFalse(rec["grade"]["success"])
                self.assertFalse(rec["complete"])
            self.assertEqual(saved_rollouts[0]["grade"]["matchedExternalCalls"], 2)
            self.assertEqual(saved_rollouts[0]["grade"]["expectedExternalCalls"], 3)
            self.assertAlmostEqual(saved_rollouts[0]["grade"]["reward"], 0.45 * (2 / 3), places=6)
            self.assertAlmostEqual(saved_rollouts[1]["grade"]["reward"], 0.45 * (1 / 3), places=6)
            self.assertEqual(saved_rollouts[2]["grade"]["reward"], 0.0)


# =============================================================================
# 2. RFT Collector CLI Tests (`tools/tinker-rft-collect.py`)
# =============================================================================


class RFTCollectorTests(unittest.TestCase):
    def test_end_to_end_rft_collection_shortest_dedupe_diverse_resume_and_preexported_compat(self):
        js_task = _js_external_task("rft-js-ext")
        py_task = _py_pure_task("rft-py-pure")

        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            with Bridge(REPO_ROOT, timeout=30) as bridge:
                js_row = bridge.request("export", task=js_task, traceFormat="compact", reasoningChannel="thinking")
                js_row["split"] = "train"
                py_row = bridge.request("export", task=py_task, traceFormat="compact", reasoningChannel="thinking")
                py_row["split"] = "train"
                # Add a validation row that must NOT be sampled when split="train"
                val_row = copy.deepcopy(py_row)
                val_row["id"] = "rft-val-excluded"
                val_row["task"]["id"] = "rft-val-excluded"
                val_row["split"] = "validation"
                val_row["task"]["split"] = "validation"

                dataset_rows = [js_row, py_row, val_row]

                # Build a mock adapter keyed by exact sample seed so concurrent execution is 100% deterministic
                seed_plan: dict[int, tuple[str, int]] = {}
                for s_idx, spec in enumerate([
                    ("fail_ext", 12),        # 0: incorrect-external-request
                    ("infra_err", 0),        # 1: raises RuntimeError -> tolerated!
                    ("pass_long", 50),       # 2: passing, long thinking (50 tokens/turn)
                    ("pass_short_dup1", 10), # 3: passing, short thinking (10 tokens/turn)
                    ("pass_short_dup2", 10), # 4: IDENTICAL trajectory to #3 -> deduplicated!
                    ("pass_alt_div", 20),    # 5: passing, distinct thinking text -> diverse 2nd!
                ]):
                    seed_plan[rft_collect._sample_seed(17, "rft-js-ext", s_idx)] = spec
                    seed_plan[rft_collect._sample_seed(17, "rft-py-pure", s_idx)] = spec

                class _MockRFTAdapter:
                    backend_name = "mock-rft"

                    def __init__(self):
                        self.call_count = 0

                    def sample(self, messages, *, max_tokens, seed, temperature=None, clamp_to_context=False):
                        self.call_count += 1
                        turn_idx = sum(1 for m in messages if m.get("role") == "assistant")
                        base_seed = (seed - turn_idx) % 2147483647
                        kind, tok_len = seed_plan[base_seed]
                        if kind == "infra_err":
                            raise RuntimeError("simulated transient network blip")
                        is_py = any("Execute this Python program" in str(m.get("content", "")) for m in messages if m.get("role") == "user")
                        if is_py:
                            if kind == "fail_ext":
                                msg = {"role": "assistant", "content": '```json\n{"type":"complete","kind":"return","arguments":[6,7],"value":999}\n```'}
                            else:
                                think = {
                                    "pass_long": "very detailed verbose multiplication trace alpha beta gamma",
                                    "pass_short_dup1": "quick 6*7+1=43",
                                    "pass_short_dup2": "quick 6*7+1=43",
                                    "pass_alt_div": "alternate method forty two plus one equals forty three",
                                }[kind]
                                msg = {
                                    "role": "assistant",
                                    "content": [
                                        {"type": "thinking", "thinking": think},
                                        {"type": "text", "text": '```json\n{"type":"complete","kind":"return","arguments":[6,7],"value":43}\n```'},
                                    ],
                                }
                            return {
                                "prompt_tokens": [1, 2],
                                "token_ids": list(range(10, 10 + max(1, tok_len))),
                                "logprobs": [-0.1] * max(1, tok_len),
                                "message": msg,
                                "complete": True,
                                "stop_reason": "stop",
                            }

                        # JS 3-call multi-turn external task
                        if kind == "fail_ext":
                            msg = {"role": "assistant", "content": "", "tool_calls": [{"id": "c1", "type": "function", "function": {"name": "fs.readText", "arguments": '{"arguments":["wrong.txt"]}'}}]}
                        elif turn_idx == 0:
                            think = "step1 " + ("dup" if kind.startswith("pass_short") else kind)
                            msg = {"role": "assistant", "content": [{"type": "thinking", "thinking": think}], "tool_calls": [{"id": f"c1_{kind}", "type": "function", "function": {"name": "fs.readText", "arguments": '{"arguments":["f1.txt"]}'}}]}
                        elif turn_idx == 1:
                            msg = {"role": "assistant", "content": "", "tool_calls": [{"id": f"c2_{kind}", "type": "function", "function": {"name": "fs.readText", "arguments": '{"arguments":["f2.txt"]}'}}]}
                        elif turn_idx == 2:
                            msg = {"role": "assistant", "content": "", "tool_calls": [{"id": f"c3_{kind}", "type": "function", "function": {"name": "fs.writeText", "arguments": '{"arguments":["out.txt","foo+bar"]}'}}]}
                        else:
                            think = {
                                "pass_long": "long exhaustive summary foo plus bar equals foo+bar",
                                "pass_short_dup1": "short foo+bar",
                                "pass_short_dup2": "short foo+bar",
                                "pass_alt_div": "diverse concise completion combining both file contents",
                            }[kind]
                            msg = {
                                "role": "assistant",
                                "content": [
                                    {"type": "thinking", "thinking": think},
                                    {"type": "text", "text": '```json\n{"type":"complete","kind":"return","arguments":["f1.txt","f2.txt"],"value":"foo+bar"}\n```'},
                                ],
                            }
                        return {
                            "prompt_tokens": [1, 2],
                            "token_ids": list(range(10, 10 + max(1, tok_len))),
                            "logprobs": [-0.1] * max(1, tok_len),
                            "message": msg,
                            "complete": True,
                            "stop_reason": "stop",
                        }

                # Test 1: max_per_task=1 picks shortest passing trajectory & tolerates infra error
                progress1 = tmp_path / "rft1.progress.jsonl"
                adapter1 = _MockRFTAdapter()
                rows1, summary1 = rft_collect.collect_rft(
                    dataset_rows,
                    adapter=adapter1,
                    bridge=bridge,
                    sampler_path="tinker://sampler/stage9",
                    samples=6,
                    concurrency=4,
                    seed=17,
                    max_per_task=1,
                    resume=False,
                    progress_path=progress1,
                )
                self.assertEqual(summary1["selected_tasks"], 2)  # validation row excluded
                self.assertEqual(summary1["tasks_with_verified_pass"], 2)
                self.assertEqual(summary1["total_infra_errors"], 2)  # 1 per task, tolerated!
                self.assertEqual(summary1["collected_sft_rows"], 2)
                self.assertEqual(len(rows1), 2)
                # Shortest passing trajectory chosen: JS had 4 turns * 10 = 40 tokens, Py had 1 turn * 10 = 10 tokens
                by_id1 = {r["id"]: r for r in rows1}
                self.assertEqual(by_id1["rft-js-ext"]["rft_metadata"]["generated_tokens"], 40)
                self.assertEqual(by_id1["rft-js-ext"]["rft_metadata"]["samples_passed"], 4)
                self.assertEqual(by_id1["rft-py-pure"]["rft_metadata"]["generated_tokens"], 10)
                # Verify exact multi-turn tool calls/responses preserved in JS RFT messages
                js_tool_msgs = [m for m in by_id1["rft-js-ext"]["messages"] if m.get("role") == "tool"]
                self.assertEqual(len(js_tool_msgs), 3)

                # Test 2: max_per_task=2 deduplicates identical passing trajectories and picks diverse 2nd
                progress2 = tmp_path / "rft2.progress.jsonl"
                adapter2 = _MockRFTAdapter()
                rows2, summary2 = rft_collect.collect_rft(
                    dataset_rows,
                    adapter=adapter2,
                    bridge=bridge,
                    sampler_path="tinker://sampler/stage9",
                    samples=6,
                    concurrency=4,
                    seed=17,
                    max_per_task=2,
                    resume=False,
                    progress_path=progress2,
                )
                self.assertEqual(len(rows2), 4)
                out_ids2 = [r["id"] for r in rows2]
                self.assertEqual(len(set(out_ids2)), 4)
                self.assertIn("rft-js-ext", out_ids2)
                self.assertIn("rft-js-ext__rft1", out_ids2)
                # The two kept trajectories for rft-js-ext MUST have distinct trajectory_hash!
                js_rfts = [r for r in rows2 if r["rft_metadata"]["original_task_id"] == "rft-js-ext"]
                self.assertEqual(len(js_rfts), 2)
                self.assertNotEqual(js_rfts[0]["rft_metadata"]["trajectory_hash"], js_rfts[1]["rft_metadata"]["trajectory_hash"])
                # First is shortest (40 tokens), second is distinct (either 80 or 200, NOT the duplicate 40)
                self.assertEqual(js_rfts[0]["rft_metadata"]["generated_tokens"], 40)
                self.assertGreater(js_rfts[1]["rft_metadata"]["generated_tokens"], 40)

                # Test 3: --resume skips already-completed tasks AND tolerates truncated trailing line!
                # Keep only the first completed task in progress file + append a corrupt trailing line
                prog_lines = progress1.read_text(encoding="utf-8").splitlines()
                self.assertEqual(len(prog_lines), 2)
                partial_prog = tmp_path / "resume.progress.jsonl"
                partial_prog.write_text(prog_lines[0] + "\n{\"task_id\": \"truncated", encoding="utf-8")
                adapter3 = _MockRFTAdapter()
                rows3, summary3 = rft_collect.collect_rft(
                    dataset_rows,
                    adapter=adapter3,
                    bridge=bridge,
                    sampler_path="tinker://sampler/stage9",
                    samples=6,
                    concurrency=2,
                    seed=17,
                    max_per_task=1,
                    resume=True,
                    progress_path=partial_prog,
                )
                self.assertEqual(summary3["resumed_tasks"], 1)
                self.assertEqual(summary3["newly_processed_tasks"], 1)
                self.assertEqual(len(rows3), 2)
                self.assertLess(adapter3.call_count, adapter1.call_count)

                # Test 4: Emitted RFT rows pass straight through runner.export_dataset `_is_preexported_row`
                # WITHOUT calling bridge.request("export") AND pass validate_fixtures!
                rft_jsonl = tmp_path / "rft_out.jsonl"
                write_jsonl(rft_jsonl, rows2)

                class _NoExportBridge:
                    def request(self, op, **payload):
                        if op == "export":
                            raise AssertionError("_is_preexported_row failed: runner attempted to re-export RFT row!")
                        return bridge.request(op, **payload)

                run_out = tmp_path / "run_check"
                exp_cfg = load_config(None, {
                    "dataset": str(rft_jsonl),
                    "output_dir": str(run_out),
                    "holdout_fraction": 0.0,
                    "validation_fraction": 0.0,
                })
                loaded_rows, _manifest = export_dataset(REPO_ROOT, exp_cfg, run_out, _NoExportBridge())
                self.assertEqual(len(loaded_rows), 4)
                fixture_check = validate_fixtures(bridge, loaded_rows)
                self.assertEqual(fixture_check["valid"], 4)
                self.assertEqual(fixture_check["failures"], [])

    def test_filter_features_hard_scores_and_dry_run(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            rows = [
                {
                    "id": "t-py-hard", "family": "f1", "sourceHash": "sh1", "language": "py", "split": "train",
                    "task": {"id": "t-py-hard", "family": "f1", "language": "py", "source": "def run(): return 1", "fixture": {"calls": []}},
                    "metadata": {"tier": 3, "features": ["python"]},
                },
                {
                    "id": "t-js-easy", "family": "f2", "sourceHash": "sh2", "language": "js", "split": "train",
                    "task": {"id": "t-js-easy", "family": "f2", "language": "js", "source": "function run(){return 1;}", "fixture": {"calls": []}},
                    "metadata": {"tier": 2, "features": ["native-v8"]},
                },
                {
                    "id": "t-dom-hard", "family": "f3", "sourceHash": "sh3", "language": "ts", "split": "train",
                    "task": {"id": "t-dom-hard", "family": "f3", "language": "ts", "environment": "browser", "source": "function run(){return 1;}", "fixture": {"calls": []}},
                    "metadata": {"tier": 5, "features": ["browser-dom", "typescript"]},
                },
                {
                    "id": "t-lc65k-ext", "family": "f4", "sourceHash": "sh4", "language": "js", "split": "train",
                    "task": {"id": "t-lc65k-ext", "family": "f4", "language": "js", "source": "function run(){return 1;}", "fixture": {"calls": [{"operation": "env.get", "arguments": ["K"], "result": "V"}]}},
                    "metadata": {"tier": 5, "features": ["long-context-65k"]},
                },
            ]
            # Hard scores supporting both mine-hard (`is_hard`) and eval pass-rate (`pass_rate`)
            scores_path = tmp_path / "scores.jsonl"
            write_jsonl(scores_path, [
                {"id": "t-py-hard", "is_hard": True, "min_ll": -2.5},
                {"id": "t-js-easy", "is_hard": False, "min_ll": -0.01, "terminated": True},
                {"id": "t-dom-hard", "pass_rate": 0.5},
                {"id": "t-lc65k-ext", "pass_rate": 1.0},
            ])
            dataset_path = tmp_path / "ds.jsonl"
            out_path = tmp_path / "rft.jsonl"
            summary_path = tmp_path / "summary.json"
            write_jsonl(dataset_path, rows)

            # CLI --dry-run with --filter-features and --hard-scores
            rc = rft_collect.main([
                "--dataset", str(dataset_path),
                "--output", str(out_path),
                "--hard-scores", str(scores_path),
                "--filter-features", "python,browser-dom",
                "--summary-out", str(summary_path),
                "--samples", "8",
                "--dry-run",
            ])
            self.assertEqual(rc, 0)
            self.assertFalse(out_path.exists())  # dry-run writes no output JSONL
            summary = json.loads(summary_path.read_text(encoding="utf-8"))
            self.assertTrue(summary["dry_run"])
            self.assertEqual(summary["selected_tasks"], 2)  # t-py-hard and t-dom-hard
            self.assertEqual(summary["planned_rollouts"], 16)


# =============================================================================
# 3. Zero-Leakage Reclamation & Merger CLI Tests (`tools/tinker-reclaim-train.py`)
# =============================================================================


class ReclaimTrainTests(unittest.TestCase):
    def _make_preexported_row(
        self,
        task_id: str,
        *,
        family: str,
        source_hash: str,
        source: str,
        split: str = "train",
        split_component: str | None = None,
        language: str = "js",
        args: list | None = None,
        fixture_calls: list | None = None,
        ancestors: list[str] | None = None,
        features: list[str] | None = None,
    ) -> dict:
        row: dict = {
            "schema": "readable-py-execution/1" if language == "py" else "readable-js-execution/1",
            "id": task_id,
            "family": family,
            "sourceHash": source_hash,
            "split": split,
            "language": language,
            "task": {
                "id": task_id,
                "family": family,
                "language": language,
                "source": source,
                "entry": "run",
                "args": args if args is not None else [1],
                "fixture": {"calls": fixture_calls if fixture_calls is not None else []},
                "split": split,
                "metadata": {"tier": 3, "features": features or ["native-v8"]},
            },
            "messages": [
                {"role": "system", "content": "Execute."},
                {"role": "user", "content": source},
                {"role": "assistant", "content": '```json\n{"type":"complete","kind":"return","arguments":[1],"value":1}\n```'},
            ],
            "metadata": {"tier": 3, "features": features or ["native-v8"]},
        }
        if split_component:
            row["split_component"] = split_component
        if ancestors:
            row["ancestors"] = ancestors
        return row

    def test_strict_realexecbench_exclusion_val_isolation_reclamation_and_dedupe(self):
        # Sacred RealExecBench v1 benchmark rows
        reb_rows = [
            self._make_preexported_row(
                "reb-id-1", family="reb-fam-1", source_hash="reb-sh-1",
                source="function run(x) { return x + 42; }",
                split="test", split_component="reb-comp-1",
            ),
            self._make_preexported_row(
                "reb-py-1", family="reb-py-fam", source_hash="reb-py-sh",
                source="def run(n):\n    return n * 3\n",
                split="test", split_component="reb-py-comp", language="py",
            ),
        ]
        reb_manifest = {"task_ids_by_track": {"external-anchor": ["reb-manifest-only-id"]}}

        # Input dataset rows covering every overlap and reclamation case
        inputs = [
            # 1. Clean original train row -> stays train
            self._make_preexported_row(
                "train-clean-1", family="fam-clean-train", source_hash="sh-clean-train",
                source="function run(x) { return x + 1; }", split="train", split_component="comp-clean-train",
            ),
            # 2. Duplicate task_id (should be dropped, first wins)
            self._make_preexported_row(
                "train-clean-1", family="fam-clean-train", source_hash="sh-clean-train",
                source="function run(x) { return x + 999; }", split="train", split_component="comp-clean-train",
            ),
            # 3-8. RealExecBench overlaps on EVERY criterion -> ALL MUST BE EXCLUDED
            self._make_preexported_row(
                "reb-id-1", family="diff-fam-a", source_hash="diff-sh-a",
                source="function run(x) { return x + 2; }", split="test", split_component="comp-a",
            ),
            self._make_preexported_row(
                "reb-manifest-only-id", family="diff-fam-m", source_hash="diff-sh-m",
                source="function run(x) { return x + 3; }", split="test", split_component="comp-m",
            ),
            self._make_preexported_row(
                "leak-family", family="reb-fam-1", source_hash="diff-sh-b",
                source="function run(x) { return x + 4; }", split="validation", split_component="comp-b",
            ),
            self._make_preexported_row(
                "leak-sourcehash", family="diff-fam-c", source_hash="reb-sh-1",
                source="function run(x) { return x + 5; }", split="validation", split_component="comp-c",
            ),
            self._make_preexported_row(
                "leak-component", family="diff-fam-d", source_hash="diff-sh-d",
                source="function run(x) { return x + 6; }", split="test", split_component="reb-comp-1",
            ),
            # Reformatted + comment-edited JS copy of reb-id-1 (different id/family/sourceHash/component!)
            self._make_preexported_row(
                "leak-norm-js", family="diff-fam-e", source_hash="diff-sh-e",
                source="// sneaky comment\nfunction   run(x) {\n  /* block */ return x + 42;\n}",
                split="test", split_component="comp-e",
            ),
            # Reformatted Python AST-equivalent copy of reb-py-1 (different id/family/sourceHash/component!)
            self._make_preexported_row(
                "leak-norm-py", family="diff-fam-f", source_hash="diff-sh-f",
                source="# comment\ndef run(n):\n    # another comment\n    return n * 3\n",
                split="validation", split_component="comp-f", language="py",
            ),
            # Transitive sibling of leak-family (shares comp-b, no direct REB match)
            self._make_preexported_row(
                "leak-transitive", family="diff-fam-trans", source_hash="diff-sh-trans",
                source="function run(x) { return x + 77; }", split="validation", split_component="comp-b",
            ),
            # 9. Kept internal validation row (in keep_val_ids) -> stays validation
            self._make_preexported_row(
                "val-keep-1", family="fam-val-keep", source_hash="sh-val-keep",
                source="function run(x) { return x * 10; }", split="validation", split_component="comp-val-keep",
            ),
            # 10. Non-manifest sibling in SAME family/component as val-keep-1 -> excluded from train!
            self._make_preexported_row(
                "val-keep-sibling", family="fam-val-keep", source_hash="sh-val-keep-2",
                source="function run(x) { return x * 11; }", split="validation", split_component="comp-val-keep",
            ),
            # 11. Reclaimable validation row (zero overlap with REB or kept val) -> reclaimed into train!
            self._make_preexported_row(
                "val-reclaim-1", family="fam-reclaim-val", source_hash="sh-reclaim-val",
                source="function run(x) { return x * 20; }", split="validation", split_component="comp-reclaim-val",
            ),
            # 12. Reclaimable test row (zero overlap with REB or kept val) -> reclaimed into train!
            self._make_preexported_row(
                "test-reclaim-1", family="fam-reclaim-test", source_hash="sh-reclaim-test",
                source="function run(x) { return x * 30; }", split="test", split_component="comp-reclaim-test",
            ),
        ]

        output_rows, audit = reclaim_train.reclaim_and_merge(
            inputs,
            realexecbench_rows=reb_rows,
            realexecbench_manifest=reb_manifest,
            keep_val_ids={"val-keep-1"},
        )

        self.assertTrue(audit["passed"])
        self.assertEqual(audit["inputs"]["dropped_duplicate_task_id"], 1)
        self.assertEqual(audit["realexecbench_exclusions"]["total_excluded"], 8)
        self.assertEqual(audit["realexecbench_exclusions"]["transitive_component_excluded"], 1)
        self.assertGreaterEqual(audit["realexecbench_exclusions"]["by_reason"]["normalized_source_sha256"], 2)

        by_id = {r["id"]: r for r in output_rows}
        # Exact expected surviving IDs
        self.assertEqual(set(by_id), {"train-clean-1", "val-keep-1", "val-reclaim-1", "test-reclaim-1"})
        # First occurrence won on duplicate train-clean-1
        self.assertIn("x + 1", by_id["train-clean-1"]["task"]["source"])
        # Splits assigned properly
        self.assertEqual(by_id["train-clean-1"]["split"], "train")
        self.assertEqual(by_id["val-reclaim-1"]["split"], "train")
        self.assertEqual(by_id["val-reclaim-1"]["task"]["split"], "train")
        self.assertEqual(by_id["test-reclaim-1"]["split"], "train")
        self.assertEqual(by_id["test-reclaim-1"]["task"]["split"], "train")
        self.assertEqual(by_id["val-keep-1"]["split"], "validation")
        self.assertEqual(by_id["val-keep-1"]["task"]["split"], "validation")

        # Audit reports BOTH strict reclaimed count (2) and reb-only reclaimed count (3, including val-keep-sibling)
        self.assertEqual(audit["reclamation"]["reclaimed_strict_val_and_reb_isolated"], 2)
        self.assertEqual(audit["reclamation"]["reclaimed_if_only_reb_isolated"], 3)
        self.assertEqual(audit["reclamation"]["excluded_kept_val_component_siblings"], 1)
        self.assertTrue(audit["output"]["all_preexported"])
        self.assertTrue(audit["zero_leakage_verification"]["train_vs_realexecbench"]["passed"])
        self.assertTrue(audit["zero_leakage_verification"]["validation_vs_realexecbench"]["passed"])
        self.assertTrue(audit["zero_leakage_verification"]["train_vs_validation"]["passed"])

        # Verify output passes runner.split_examples with holdout_fraction=0, validation_fraction=0!
        split_out, _split_manifest = split_examples(output_rows, seed=17, holdout_fraction=0.0, validation_fraction=0.0)
        self.assertEqual(sum(1 for r in split_out if r["split"] == "train"), 3)
        self.assertEqual(sum(1 for r in split_out if r["split"] == "validation"), 1)

    def test_cli_merge_multiple_inputs_and_optional_task_hash_dedupe(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            reb_bench = tmp_path / "benchmark.jsonl"
            reb_manifest = tmp_path / "manifest.json"
            keep_val = tmp_path / "keep-val.json"
            in1 = tmp_path / "in1.jsonl"
            in2 = tmp_path / "in2.jsonl"
            out_path = tmp_path / "merged.jsonl"
            audit_path = tmp_path / "audit.json"

            write_jsonl(reb_bench, [
                self._make_preexported_row(
                    "reb-x", family="reb-fam-x", source_hash="reb-sh-x",
                    source="function run() { return 7; }", split="test",
                )
            ])
            reb_manifest.write_text(json.dumps({"task_ids_by_track": {"hairy": ["reb-x"]}}))
            keep_val.write_text(json.dumps({"splits": {"validation": ["v-keep"]}}))

            # Counterfactual pair (same sourceHash+entry+args, DIFFERENT fixture) + exact duplicate task_hash
            r_cf1 = self._make_preexported_row(
                "cf-1", family="fam-cf", source_hash="sh-cf",
                source="function run(a){return a;}", split="train", args=[1],
                fixture_calls=[{"operation": "env.get", "arguments": ["X"], "result": "A"}],
            )
            r_cf2 = self._make_preexported_row(
                "cf-2", family="fam-cf", source_hash="sh-cf",
                source="function run(a){return a;}", split="train", args=[1],
                fixture_calls=[{"operation": "env.get", "arguments": ["X"], "result": "B"}],
            )
            r_exact_dup = self._make_preexported_row(
                "cf-1-copy", family="fam-cf", source_hash="sh-cf",
                source="function run(a){return a;}", split="train", args=[1],
                fixture_calls=[{"operation": "env.get", "arguments": ["X"], "result": "A"}],
            )
            r_val = self._make_preexported_row(
                "v-keep", family="fam-vkeep", source_hash="sh-vkeep",
                source="function run(a){return a+5;}", split="validation",
            )
            write_jsonl(in1, [r_cf1, r_val])
            write_jsonl(in2, [r_cf2, r_exact_dup])

            rc = reclaim_train.main([
                "--inputs", str(in1), str(in2),
                "--realexecbench-manifest", str(reb_manifest),
                "--realexecbench-benchmark", str(reb_bench),
                "--keep-val-manifest", str(keep_val),
                "--dedupe-by-task-hash",
                "--output", str(out_path),
                "--audit-out", str(audit_path),
            ])
            self.assertEqual(rc, 0)
            merged = read_jsonl(out_path)
            audit = json.loads(audit_path.read_text(encoding="utf-8"))
            # cf-1 and cf-2 BOTH preserved (distinct fixtures!), cf-1-copy dropped (exact task_hash dup!)
            self.assertEqual({r["id"] for r in merged}, {"cf-1", "cf-2", "v-keep"})
            self.assertEqual(audit["inputs"]["dropped_duplicate_task_hash"], 1)
            self.assertTrue(audit["passed"])
            # Pre-exported fields preserved intact
            for row in merged:
                self.assertIsInstance(row["messages"], list)
                self.assertIsInstance(row["sourceHash"], str)
                self.assertIsInstance(row["task"], dict)


if __name__ == "__main__":
    unittest.main()
