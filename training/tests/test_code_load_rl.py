"""Tests for RL latency-vs-tokens cost (`code_load_latency_tokens`),
`mean_code_load_calls` metric, and `multiturn_opsd_on_failure` compatibility
with flexible `code.load` rollouts.
"""
from __future__ import annotations

import copy
import json
from pathlib import Path
import random
import tempfile
from types import SimpleNamespace
import unittest

from test_adapter import fake_adapter

from tinker_js.adapter import TinkerAdapter
from tinker_js.learning import execution_advantages
from tinker_js.metrics import summarize_records
from tinker_js.runner import DEFAULTS, load_config, train_rl


def _rollout_record(success: bool, generated_tokens: int, *, code_load_calls: int | None = None, snake_key: bool = False) -> dict:
    grade: dict = {"success": success, "reward": 1.0 if success else 0.0, "reason": "ok" if success else "mismatch"}
    if code_load_calls is not None:
        grade["code_load_calls" if snake_key else "codeLoadCalls"] = code_load_calls
    return {
        "task_id": "mf-1",
        "family": "mf-fam",
        "grade": grade,
        "generated_tokens": generated_tokens,
        "complete": success,
        "samples": [],
    }


class CodeLoadRLConfigAndRewardTests(unittest.TestCase):
    def test_config_default_and_validation(self):
        self.assertEqual(DEFAULTS["code_load_latency_tokens"], 0.0)
        cfg = load_config(overrides={"code_load_latency_tokens": 200.0})
        self.assertEqual(cfg["code_load_latency_tokens"], 200.0)
        for bad in (-1.0, float("nan"), float("inf"), True, "200"):
            with self.assertRaises(ValueError):
                load_config(overrides={"code_load_latency_tokens": bad})

    def test_latency_tokens_zero_preserves_exact_existing_advantages(self):
        records = [
            _rollout_record(True, 300, code_load_calls=1),
            _rollout_record(True, 250, code_load_calls=4),
            _rollout_record(False, 50, code_load_calls=0),
        ]
        cfg_zero = {"length_penalty": 0.25, "length_scale_tokens": 2000, "code_load_latency_tokens": 0.0}
        cfg_omitted = {"length_penalty": 0.25, "length_scale_tokens": 2000}
        sig_zero = execution_advantages(records, cfg_zero)
        sig_omitted = execution_advantages(records, cfg_omitted)
        self.assertEqual(sig_zero, sig_omitted)
        # With latency=0, fewer raw tokens (250) beats more raw tokens (300)
        self.assertGreater(sig_zero["advantages"][1], sig_zero["advantages"][0])
        # Failure gets zero length advantage and loses to all successes
        self.assertEqual(sig_zero["length_advantages"][2], 0.0)
        self.assertLess(sig_zero["advantages"][2], sig_zero["advantages"][0])

    def test_latency_tokens_positive_rewards_whole_file_batching_and_symbol_efficiency(self):
        cfg = {"length_penalty": 0.25, "length_scale_tokens": 2000, "code_load_latency_tokens": 200.0}
        # Scenario 1 (small file): whole-file/batched (300 tok, 1 call => eff 500)
        # beats fragmented symbol calls (250 tok, 3 calls => eff 850)!
        small_records = [
            _rollout_record(True, 300, code_load_calls=1),
            _rollout_record(True, 250, code_load_calls=3, snake_key=True),
            _rollout_record(False, 100, code_load_calls=0),
        ]
        sig_small = execution_advantages(small_records, cfg)
        self.assertGreater(sig_small["length_advantages"][0], 0.0)
        self.assertLess(sig_small["length_advantages"][1], 0.0)
        self.assertEqual(sig_small["length_advantages"][2], 0.0)
        self.assertAlmostEqual(sum(sig_small["length_advantages"]), 0.0, places=9)
        self.assertGreater(sig_small["advantages"][0], sig_small["advantages"][1])
        # Exact expected values: cost0 = 500/2000 = 0.25, cost1 = 850/2000 = 0.425, mean = 0.3375
        self.assertAlmostEqual(sig_small["length_advantages"][0], 0.3375 - 0.25, places=9)
        self.assertAlmostEqual(sig_small["length_advantages"][1], 0.3375 - 0.425, places=9)

        # Scenario 2 (large file): targeted symbol load (400 tok, 1 call => eff 600)
        # beats bloated whole-file load (1200 tok, 1 call => eff 1400)!
        big_records = [
            _rollout_record(True, 400, code_load_calls=1),
            _rollout_record(True, 1200, code_load_calls=1),
        ]
        sig_big = execution_advantages(big_records, cfg)
        self.assertGreater(sig_big["advantages"][0], sig_big["advantages"][1])
        self.assertEqual(sig_big["group_kind"], "all_success")
        self.assertTrue(sig_big["length_signal"])

    def test_summarize_records_reports_mean_code_load_calls(self):
        plain = [_rollout_record(True, 100), _rollout_record(False, 200)]
        self.assertEqual(summarize_records(plain)["mean_code_load_calls"], 0.0)
        self.assertEqual(summarize_records([])["mean_code_load_calls"], 0.0)

        mixed = [
            _rollout_record(True, 100, code_load_calls=1),
            _rollout_record(True, 150, code_load_calls=3, snake_key=True),
            _rollout_record(False, 80, code_load_calls=2),
        ]
        self.assertAlmostEqual(summarize_records(mixed)["mean_code_load_calls"], 2.0, places=9)


class _MultiFileCodeLoadBridge:
    """Bridge simulating a multi-file task where different rollouts use different
    code.load granularities before failing on completion."""

    def __init__(self, initial_messages: list[dict], obs_by_call_arg: dict[str, str]):
        self._initial = initial_messages
        self._obs_by_call_arg = obs_by_call_arg
        self._sessions: dict[str, int] = {}
        self._counter = 0

    def start(self, task: dict) -> dict:
        self._counter += 1
        sid = f"mf-session-{self._counter}"
        self._sessions[sid] = 0
        return {"sessionId": sid, "messages": copy.deepcopy(self._initial)}

    def step(self, session_id: str, action, generated_tokens: int) -> dict:
        if isinstance(action, dict) and action.get("tool_calls"):
            tc = action["tool_calls"][0]
            fn = tc["function"]
            raw_args = fn["arguments"]
            content = self._obs_by_call_arg.get(raw_args, json.dumps({"status": "fulfilled", "value": []}))
            self._sessions[session_id] += 1
            return {
                "done": False,
                "messages": [{"role": "tool", "tool_call_id": tc.get("id", "c1"), "name": fn["name"], "content": content}],
            }
        return {
            "done": True,
            "messages": [],
            "grade": {
                "success": False,
                "reward": 0.0,
                "reason": "outcome-mismatch",
                "failureCategory": "wrong-return",
                "generatedTokens": generated_tokens,
                "externalCalls": 0,
                "codeLoadCalls": self._sessions[session_id],
                "complete": True,
            },
        }

    def grade(self, session_id: str, total_generated_tokens: int) -> dict:
        return {
            "success": False,
            "reward": 0.0,
            "reason": "incomplete",
            "generatedTokens": total_generated_tokens,
            "externalCalls": 0,
            "codeLoadCalls": self._sessions.get(session_id, 0),
            "complete": False,
        }

    def close(self, session_id: str) -> None:
        self._sessions.pop(session_id, None)

    def request(self, op: str, **kwargs):
        if op == "start":
            return self.start(kwargs["task"])
        if op == "step":
            return self.step(kwargs["sessionId"], kwargs["action"], kwargs["generatedTokens"])
        if op == "grade":
            return self.grade(kwargs["sessionId"], kwargs["totalGeneratedTokens"])
        if op == "close":
            self.close(kwargs["sessionId"])
            return {"closed": True}
        raise ValueError(f"Unknown bridge op: {op}")


class MultiTurnOPSDCodeLoadSafetyTests(unittest.TestCase):
    def _build_teacher_row(self) -> tuple[dict, dict[str, str]]:
        init = [
            {"role": "system", "content": "Execute multi-file JS."},
            {"role": "tool_declare", "content": json.dumps([{"type": "function", "function": {"name": "code.load", "parameters": {"type": "object", "properties": {"arguments": {"type": "array"}}, "required": ["arguments"]}}}])},
            {"role": "user", "content": "Manifest + src/index.js"},
        ]
        arg_sym1 = json.dumps({"arguments": [{"path": "src/big.js", "symbol": "f1"}]})
        arg_sym2 = json.dumps({"arguments": [{"path": "src/big.js", "symbol": "f2"}]})
        arg_whole = json.dumps({"arguments": [{"path": "src/big.js"}]})

        obs_sym1 = json.dumps({"status": "fulfilled", "value": [{"path": "src/big.js", "mode": "symbol", "symbol": "f1", "content": "function f1(){}"}]})
        obs_sym2 = json.dumps({"status": "fulfilled", "value": [{"path": "src/big.js", "mode": "symbol", "symbol": "f2", "content": "function f2(){}"}]})
        obs_whole = json.dumps({"status": "fulfilled", "value": [{"path": "src/big.js", "mode": "file", "content": "function f1(){}\nfunction f2(){}"}]})

        teacher_messages = [
            *init,
            {"role": "assistant", "content": [{"type": "thinking", "thinking": "need f1"}], "tool_calls": [{"type": "function", "id": "call_1", "function": {"name": "code.load", "arguments": arg_sym1}}]},
            {"role": "tool", "tool_call_id": "call_1", "name": "code.load", "content": obs_sym1},
            {"role": "assistant", "content": [{"type": "thinking", "thinking": "need f2"}], "tool_calls": [{"type": "function", "id": "call_2", "function": {"name": "code.load", "arguments": arg_sym2}}]},
            {"role": "tool", "tool_call_id": "call_2", "name": "code.load", "content": obs_sym2},
            {"role": "assistant", "content": [{"type": "thinking", "thinking": "done"}], "tool_calls": []},
        ]
        # Replace final assistant message with standard completion text (no tool_calls key)
        teacher_messages[-1] = {
            "role": "assistant",
            "content": [{"type": "thinking", "thinking": "done"}, {"type": "text", "text": '```json\n{"type":"complete","kind":"return","arguments":[],"value":42}\n```'}],
        }
        row = {
            "id": "mf-opsd-1",
            "family": "mf-opsd",
            "sourceHash": "abc123",
            "split": "train",
            "task": {
                "id": "mf-opsd-1",
                "family": "mf-opsd",
                "executionMode": "native",
                "files": {"src/index.js": "export function run(){return 42;}", "src/big.js": "export function f1(){} export function f2(){}"},
                "entryFile": "src/index.js",
                "entry": "run",
                "args": [],
                "fixture": {"calls": []},
            },
            "messages": teacher_messages,
            "metadata": {"tier": 4, "features": ["multi-file", "code-load"], "externalCalls": 0, "codeLoadCalls": 2},
        }
        return row, {arg_sym1: obs_sym1, arg_sym2: obs_sym2, arg_whole: obs_whole}

    def test_multiturn_opsd_skips_diverged_code_load_prefix_and_matches_aligned_prefix(self):
        row, obs_map = self._build_teacher_row()
        init = row["messages"][:3]
        arg_sym1 = json.dumps({"arguments": [{"path": "src/big.js", "symbol": "f1"}]})
        arg_sym2 = json.dumps({"arguments": [{"path": "src/big.js", "symbol": "f2"}]})
        arg_whole = json.dumps({"arguments": [{"path": "src/big.js"}]})

        # Rollout 0: student loads whole file (1 code.load instead of teacher's 2 symbol loads), then fails completion!
        # Rollout 1: student matches teacher's exact 2 symbol code.load calls, then fails completion!
        actions_seq = [
            # Rollout 0 (diverged granularity):
            {"role": "assistant", "content": "", "tool_calls": [{"type": "function", "id": "s0_1", "function": {"name": "code.load", "arguments": arg_whole}}]},
            {"role": "assistant", "content": '```json\n{"type":"complete","kind":"return","arguments":[],"value":999}\n```'},
            # Rollout 1 (aligned prefix):
            {"role": "assistant", "content": "", "tool_calls": [{"type": "function", "id": "s1_1", "function": {"name": "code.load", "arguments": arg_sym1}}]},
            {"role": "assistant", "content": "", "tool_calls": [{"type": "function", "id": "s1_2", "function": {"name": "code.load", "arguments": arg_sym2}}]},
            {"role": "assistant", "content": '```json\n{"type":"complete","kind":"return","arguments":[],"value":999}\n```'},
        ]

        scored_targets: list[int] = []
        adapter, service, renderer = fake_adapter({"max_tokens": 64})
        adapter._thinking_ids = (10, 11, 99)
        adapter.sampling_client = service.sampler
        adapter.sampling_revision = "tinker://init/sample"
        adapter.create_sampling_client = lambda checkpoint=None: setattr(adapter, "sampling_revision", checkpoint or "base")
        adapter.checkpoint = lambda name, **kw: {
            "training_path": f"tinker://train/{name}",
            "sampler_path": f"tinker://sampler/{name}",
            "step": 1,
        }

        queue = list(actions_seq)

        def scripted_sample(messages, max_tokens=None, seed=None, temperature=None):
            msg = queue.pop(0)
            renderer.message = msg
            service.sampler.sequence = SimpleNamespace(tokens=[41, 42, 99], logprobs=[-0.2, -0.3, -0.1], stop_reason="stop")
            return TinkerAdapter.sample(adapter, messages, max_tokens=max_tokens, seed=seed, temperature=temperature)

        adapter.sample = scripted_sample

        def extract_turn_targets(messages: list[dict]) -> list[dict]:
            targets = []
            for idx, msg in enumerate(messages):
                if msg.get("role") == "assistant":
                    targets.append({
                        "turn_index": len(targets),
                        "message_index": idx,
                        "is_tool_call": bool(msg.get("tool_calls")),
                        "operation": msg["tool_calls"][0]["function"]["name"] if msg.get("tool_calls") else "complete",
                    })
            return targets

        def score_rollout_turn_failure(fail_sample, prefix_messages, turn_target, **kwargs):
            scored_targets.append(turn_target["turn_index"])
            return {
                "opsd_token_deltas": [0.1] * len(fail_sample["token_ids"]),
                "opsd_tokens_scored": len(fail_sample["token_ids"]),
                "opsd_mean_log_ratio": 0.2,
                "anchor_sample": None,
            }

        adapter.extract_turn_targets = extract_turn_targets
        adapter.score_rollout_turn_failure = score_rollout_turn_failure

        bridge = _MultiFileCodeLoadBridge(init, obs_map)
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp)
            config = load_config(overrides={
                "output_dir": str(out),
                "rl_objective": "likelihood",
                "rl_steps": 1,
                "group_size": 2,
                "max_turns": 6,
                "multiturn_rollout_fraction": 1.0,
                "multiturn_opsd_on_failure": True,
                "opsd_coef": 0.5,
                "code_load_latency_tokens": 200.0,
                "validation_every": 0,
                "checkpoint_every": 1,
                "checkpoint_every_update": False,
                "final_test": False,
            })
            state = {
                "phase": "rl",
                "rl_steps_completed": 0,
                "training_path": "tinker://init/train",
                "sampler_path": "tinker://init/sample",
            }
            train_rl(bridge, adapter, [row], config, out, state, random.Random(17))

        # Rollout 0 (diverged code.load granularity) MUST NOT be misaligned against teacher turn 1 (code.load f2)!
        # Rollout 1 (exact aligned prefix) MUST match teacher turn 2 (final completion)!
        self.assertEqual(scored_targets, [2])


if __name__ == "__main__":
    unittest.main()
