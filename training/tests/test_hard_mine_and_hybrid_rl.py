"""Comprehensive tests for hard-set mining (Category 2), concise exploration & OPSD norm (Category 3),
hybrid multi-turn RL (Category 4a), and stratified multi-axis evaluation buckets/manifests (Category 4b).
"""
from __future__ import annotations

import contextlib
import copy
import importlib.util
import io
import json
import math
from pathlib import Path
import random
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from test_adapter import Future, ModelInput, fake_adapter
from test_runner import ControlledBridge

from tinker_js.adapter import ContextOverflow, TinkerAdapter
from tinker_js.learning import likelihood_advantages
from tinker_js.metrics import summarize_records, task_eval_bucket
from tinker_js.runner import (
    config_fingerprint,
    evaluate,
    evaluation_selection,
    load_config,
    make_report,
    read_jsonl,
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


mine_hard = _load_tool_module("tinker-mine-hard.py", "tinker_mine_hard")
build_manifest = _load_tool_module("tinker-build-eval-manifest.py", "tinker_build_eval_manifest")


def _dataset_row(
    task_id: str,
    *,
    split: str = "train",
    features: list[str] | None = None,
    external_calls: int = 0,
    language: str = "js",
    family: str | None = None,
    tier: int = 3,
    messages: list[dict] | None = None,
    with_messages: bool = True,
) -> dict:
    feats = list(features or [])
    fam = family or f"fam-{task_id}"
    meta = {
        "tier": tier,
        "features": feats,
        "externalCalls": external_calls,
    }
    task = {
        "id": task_id,
        "family": fam,
        "language": language,
        "source": f"/* {task_id} */ function run() {{ return 1; }}",
        "entry": "run",
        "args": [],
        "fixture": {"calls": []},
        "metadata": copy.deepcopy(meta),
        "split": split,
    }
    row = {
        "id": task_id,
        "family": fam,
        "sourceHash": f"src-{task_id}",
        "language": language,
        "task": task,
        "metadata": copy.deepcopy(meta),
        "split": split,
    }
    if with_messages:
        row["messages"] = messages if messages is not None else [
            {"role": "user", "content": task_id},
            {"role": "assistant", "content": [{"type": "thinking", "thinking": "step"}, {"type": "text", "text": "done"}]},
        ]
    return row


class HardMinerTests(unittest.TestCase):
    def _make_fake_tinker_logprob_adapter(self, ll_by_marker: dict[int, float]):
        """Real TinkerAdapter with mocked runtime + compute_logprobs returning target LLs keyed by marker token."""

        class _LogprobClient:
            def __init__(self):
                self.calls: list[tuple[list[int], int | None]] = []

            def compute_logprobs(self, model_input, prompt_logprobs_last_n=None):
                ids = model_input.to_ints()
                self.calls.append((ids, prompt_logprobs_last_n))
                marker = ids[-1]
                target_sum = ll_by_marker.get(marker, -0.05)
                assert prompt_logprobs_last_n is not None and prompt_logprobs_last_n > 0
                per_tok = target_sum / prompt_logprobs_last_n
                prefix_len = len(ids) - prompt_logprobs_last_n
                return Future([0.0] * prefix_len + [per_tok] * prompt_logprobs_last_n)

        client = _LogprobClient()
        runtime = SimpleNamespace(
            types=SimpleNamespace(ModelInput=ModelInput, SamplingParams=SimpleNamespace),
            renderer=None,
            renderer_name="fake",
            tokenizer=None,
            service_factory=lambda: SimpleNamespace(create_sampling_client=lambda **kw: Future(client)),
        )
        adapter = TinkerAdapter({"effort": 0.5, "max_context_tokens": 4096}, runtime=runtime)
        adapter._thinking_ids = (10, 11, 99)
        adapter.sampling_client = client
        adapter.sampling_revision = "tinker://fake/ckpt"
        return adapter, client

    def test_logprob_mode_uses_compute_logprobs_keeps_hard_priority_and_20pct_easy_replay(self):
        # Assign unique marker tokens per task so fake compute_logprobs distinguishes hard vs easy,
        # including a multi-turn task (3 turns, max 2 sampled) where one turn is hard.
        ll_by_marker: dict[int, float] = {}
        rows: list[dict] = []

        # 2 hard train tasks (ll < -0.3)
        for idx, tok in enumerate((101, 102)):
            ll_by_marker[tok] = -0.85
            r = _dataset_row(f"hard-{idx}", split="train", features=["native-v8"])
            r["marker_turns"] = [(tok, False)]
            rows.append(r)

        # 1 multi-turn task with 3 turns: turn 0 easy (-0.02), turn 1 hard (-1.2), turn 2 hard (-0.9)
        # Sampling any 2 of 3 turns MUST hit at least one hard turn, so min_ll < -0.3 -> hard.
        ll_by_marker[150] = -0.02
        ll_by_marker[151] = -1.20
        ll_by_marker[152] = -0.90
        mt = _dataset_row("multi-turn-hard", split="train", features=["native-v8"])
        mt["marker_turns"] = [(150, False), (151, True), (152, False)]
        rows.append(mt)

        # Always-keep tasks even though their LL is trivially easy (-0.01 >= -0.3):
        always_specs = [
            ("keep-hairy", {"features": ["hairy-real"]}, 201),
            ("keep-effectful", {"features": ["hard-effectful"]}, 202),
            ("keep-unittest", {"features": ["unit-test-input"]}, 203),
            ("keep-py-feat", {"features": ["python"]}, 204),
            ("py-raw-lang", {"features": [], "language": "py"}, 205),
            ("keep-extcalls", {"features": ["native-v8"], "external_calls": 2}, 206),
        ]
        for tid, spec, tok in always_specs:
            ll_by_marker[tok] = -0.01
            r = _dataset_row(tid, split="train", **spec)
            r["marker_turns"] = [(tok, False)]
            rows.append(r)

        # 10 easy train tasks (ll = -0.05 >= -0.3) -> 20% replay should keep exactly 2!
        for i in range(10):
            tok = 300 + i
            ll_by_marker[tok] = -0.05
            r = _dataset_row(f"easy-{i:02d}", split="train", features=["native-v8"])
            r["marker_turns"] = [(tok, False)]
            rows.append(r)

        # Held-out validation & test rows that look "easy" -> MUST always be 100% preserved untouched!
        for sp in ("validation", "test"):
            for i in range(3):
                tok = 400 + i
                ll_by_marker[tok] = -0.01
                r = _dataset_row(f"{sp}-{i}", split=sp, features=["native-v8"])
                r["marker_turns"] = [(tok, False)]
                rows.append(r)

        adapter, client = self._make_fake_tinker_logprob_adapter(ll_by_marker)
        by_user_prompt = {r["id"]: r["marker_turns"] for r in rows}

        def fake_extract_turns(messages):
            tid = messages[0]["content"]
            return [
                {
                    "turn_index": ti,
                    "prefix_tokens": [1, 2, ti + 1],
                    "thinking_prompt_tokens": [1, 2, ti + 1, 10, 11],
                    "target_action_tokens": [10, 20, tok],
                    "is_tool_call": is_tc,
                    "operation": "op" if is_tc else "complete",
                }
                for ti, (tok, is_tc) in enumerate(by_user_prompt[tid])
            ]

        adapter.extract_turn_targets = fake_extract_turns

        out_rows, diags, summary = mine_hard.mine_dataset(
            rows,
            adapter=adapter,
            mode="logprob",
            concurrency=8,
            hard_ll_threshold=-0.3,
            easy_replay_fraction=0.2,
            seed=42,
        )

        # Verify compute_logprobs was called with zero-thinking prefix [..., 10, 11, 99] and prompt_logprobs_last_n=len(y_t)=3!
        self.assertTrue(len(client.calls) >= 19)
        for ids, last_n in client.calls:
            self.assertEqual(last_n, 3)
            self.assertEqual(ids[-6:-3], [10, 11, 99])

        kept_ids = {r["id"] for r in out_rows}
        # All 6 held-out rows preserved untouched!
        for sp in ("validation", "test"):
            for i in range(3):
                self.assertIn(f"{sp}-{i}", kept_ids)
        # All 3 hard train rows kept!
        for tid in ("hard-0", "hard-1", "multi-turn-hard"):
            self.assertIn(tid, kept_ids)
        # All 6 always-keep / externalCalls rows kept!
        for tid, _, _ in always_specs:
            self.assertIn(tid, kept_ids)
        # Exactly 2 of 10 easy train rows kept (20% replay)!
        easy_kept = [r["id"] for r in out_rows if r["id"].startswith("easy-")]
        self.assertEqual(len(easy_kept), 2)

        # Multi-turn task scored at most 2 turns!
        mt_diag = next(d for d in diags if d["id"] == "multi-turn-hard")
        self.assertEqual(mt_diag["total_turns"], 3)
        self.assertEqual(mt_diag["turns_scored"], 2)
        self.assertLess(mt_diag["min_ll"], -0.3)
        self.assertTrue(mt_diag["is_hard"])

        # Summary stats match exact counts
        self.assertEqual(summary["heldout_preserved"], {"validation": 3, "test": 3, "total": 6})
        self.assertEqual(summary["train_scored"], 19)
        self.assertEqual(summary["train_hard"], 3)
        self.assertEqual(summary["train_always_keep_easy"], 6)
        self.assertEqual(summary["train_easy_total"], 10)
        self.assertEqual(summary["train_easy_replay"], 2)
        self.assertEqual(summary["train_dropped_easy"], 8)
        self.assertEqual(summary["output_rows"], 17)

        # Deterministic replay with same seed, and identical under concurrency=1!
        out_rows_seq, diags_seq, _ = mine_hard.mine_dataset(
            rows,
            adapter=adapter,
            mode="logprob",
            concurrency=1,
            hard_ll_threshold=-0.3,
            easy_replay_fraction=0.2,
            seed=42,
        )
        self.assertEqual([r["id"] for r in out_rows], [r["id"] for r in out_rows_seq])
        self.assertEqual(diags, diags_seq)

    def test_sample_mode_flags_unterminated_low_ll_and_long_thoughts_and_exports_raw(self):
        # Include raw tasks without `messages` to verify lazy Bridge export + CLI `--scores-out`.
        rows = [
            _dataset_row("s-unterminated", split="train", with_messages=False),
            _dataset_row("s-low-ll", split="train", with_messages=True),
            _dataset_row("s-long-1800", split="train", with_messages=True),
            *[_dataset_row(f"s-easy-{i}", split="train", with_messages=True) for i in range(5)],
            _dataset_row("s-val", split="validation", with_messages=False),
            _dataset_row("s-test", split="test", with_messages=True),
        ]

        class _FakeBridge:
            def __init__(self):
                self.exported_ids = []

            def request(self, op, **payload):
                assert op == "export"
                tid = payload["task"]["id"]
                self.exported_ids.append(tid)
                return {
                    "messages": [
                        {"role": "user", "content": tid},
                        {"role": "assistant", "content": "ok"},
                    ],
                    "metadata": payload["task"].get("metadata", {}),
                }

        class _FakeSampleAdapter:
            def __init__(self):
                self.sample_calls = []

            def extract_turn_targets(self, messages):
                tid = messages[0]["content"]
                return [{"turn_index": 0, "task_id": tid, "prefix_tokens": [1],
                         "thinking_prompt_tokens": [1, 10, 11], "target_action_tokens": [10, 20]}]

            def sample_thinking_and_score_target(self, turn_target, *, seed, max_tokens=None):
                tid = turn_target["task_id"]
                self.sample_calls.append((tid, seed, max_tokens))
                if tid == "s-unterminated":
                    return {"terminated": False, "target_logprob_sum": None, "generated_tokens": 4096}
                if tid == "s-low-ll":
                    return {"terminated": True, "target_logprob_sum": -0.55, "generated_tokens": 300}
                if tid == "s-long-1800":
                    return {"terminated": True, "target_logprob_sum": -0.05, "generated_tokens": 1800}
                return {"terminated": True, "target_logprob_sum": -0.05, "generated_tokens": 250}

        bridge = _FakeBridge()
        adapter = _FakeSampleAdapter()
        out_rows, diags, summary = mine_hard.mine_dataset(
            rows,
            adapter=adapter,
            bridge=bridge,
            mode="sample",
            concurrency=4,
            hard_ll_threshold=-0.3,
            easy_replay_fraction=0.2,
            seed=42,
        )

        # Only the train row missing `messages` was exported; validation row untouched without export.
        self.assertEqual(bridge.exported_ids, ["s-unterminated"])
        self.assertTrue(all(max_tok == 4096 for _, _, max_tok in adapter.sample_calls))
        diag_map = {d["id"]: d for d in diags}
        self.assertTrue(diag_map["s-unterminated"]["is_hard"])
        self.assertTrue(diag_map["s-low-ll"]["is_hard"])
        self.assertTrue(diag_map["s-long-1800"]["is_hard"])
        for i in range(5):
            self.assertFalse(diag_map[f"s-easy-{i}"]["is_hard"])
        # 3 hard + 1 easy replay (20% of 5) + 2 held-out = 6 rows!
        self.assertEqual(summary["train_hard"], 3)
        self.assertEqual(summary["train_easy_replay"], 1)
        self.assertEqual(summary["output_rows"], 6)
        kept_ids = {r["id"] for r in out_rows}
        self.assertIn("s-val", kept_ids)
        self.assertIn("s-test", kept_ids)
        # Preserved raw train row stays untouched without mutating original schema.
        kept_unterm = next(r for r in out_rows if r["id"] == "s-unterminated")
        self.assertNotIn("messages", kept_unterm)

    def test_max_tasks_preserves_all_heldout_and_cli_writes_scores_out(self):
        rows = [
            *[_dataset_row(f"train-{i}", split="train") for i in range(6)],
            *[_dataset_row(f"val-{i}", split="validation") for i in range(4)],
            *[_dataset_row(f"test-{i}", split="test") for i in range(4)],
        ]
        adapter, _ = self._make_fake_tinker_logprob_adapter({77: -0.05})
        adapter.extract_turn_targets = lambda msgs: [{
            "turn_index": 0, "prefix_tokens": [1], "thinking_prompt_tokens": [1, 10, 11],
            "target_action_tokens": [10, 20, 77], "is_tool_call": False, "operation": "complete",
        }]
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            ds_path = root / "in.jsonl"
            out_path = root / "out.jsonl"
            scores_path = root / "scores.jsonl"
            write_jsonl(ds_path, rows)
            stdout_buf = io.StringIO()
            with patch.object(mine_hard, "TinkerAdapter", return_value=adapter), \
                    contextlib.redirect_stdout(stdout_buf):
                rc = mine_hard.main([
                    "--dataset", str(ds_path),
                    "--output", str(out_path),
                    "--scores-out", str(scores_path),
                    "--max-tasks", "2",
                    "--easy-replay-fraction", "0.5",
                    "--mode", "logprob",
                ])
            self.assertEqual(rc, 0)
            cli_summary = json.loads(stdout_buf.getvalue())
            self.assertEqual(cli_summary["train_scored"], 2)
            self.assertEqual(cli_summary["heldout_preserved"], {"validation": 4, "test": 4, "total": 8})
            written_out = read_jsonl(out_path)
            written_scores = read_jsonl(scores_path)
            self.assertEqual(len(written_scores), 2)
            # 8 held-out + 1 easy replay (50% of 2) = 9
            self.assertEqual(len(written_out), 9)
            self.assertEqual(sum(1 for r in written_out if r["split"] in ("validation", "test")), 8)

    def test_context_overflow_in_miner_flags_hard_rather_than_crashing(self):
        rows = [_dataset_row("too-long", split="train")]

        class _OverflowAdapter:
            def extract_turn_targets(self, messages):
                return [{"turn_index": 0, "prefix_tokens": [1], "thinking_prompt_tokens": [1, 10, 11],
                         "target_action_tokens": [10, 20]}]

            def score_target_without_thinking(self, turn_target):
                raise ContextOverflow("too long")

        out_rows, diags, summary = mine_hard.mine_dataset(rows, adapter=_OverflowAdapter(), mode="logprob")
        self.assertEqual(len(out_rows), 1)
        self.assertTrue(diags[0]["is_hard"])
        self.assertEqual(diags[0]["error"], "context_overflow")
        self.assertEqual(summary["train_hard"], 1)

    def test_logprob_mode_duck_typed_compute_logprobs_fallback(self):
        rows = [
            _dataset_row("duck-hard", split="train", features=[]),
            _dataset_row("duck-easy", split="train", features=[]),
        ]

        class _DuckAdapter:
            effort = 0.0

            def __init__(self):
                self.calls = []

            def extract_turn_targets(self, messages):
                tid = messages[0]["content"]
                marker = 111 if tid == "duck-hard" else 222
                return [{"turn_index": 0, "prefix_tokens": [1, 2], "target_action_tokens": [marker, 99]}]

            def compute_logprobs(self, ids, prompt_logprobs_last_n=None):
                self.calls.append((list(ids), prompt_logprobs_last_n))
                val = -0.9 if ids[-2] == 111 else -0.05
                return [0.0, 0.0, val / 2.0, val / 2.0]

        adapter = _DuckAdapter()
        out_rows, diags, summary = mine_hard.mine_dataset(
            rows, adapter=adapter, mode="logprob", concurrency=1, easy_replay_fraction=0.0,
        )
        self.assertEqual(len(adapter.calls), 2)
        self.assertTrue(all(last_n == 2 for _, last_n in adapter.calls))
        self.assertEqual([r["id"] for r in out_rows], ["duck-hard"])
        self.assertEqual(summary["train_hard"], 1)
        self.assertEqual(summary["train_dropped_easy"], 1)


class ConciseExplorationAndOPSDNormTests(unittest.TestCase):
    def test_category3_config_defaults_and_validation(self):
        cfg = load_config()
        self.assertEqual(cfg["rl_group_temperature_spread"], 0.0)
        self.assertEqual(cfg["confident_length_std_floor"], 64.0)
        self.assertEqual(cfg["opsd_norm_mode"], "trajectory")
        self.assertEqual(cfg["multiturn_rollout_fraction"], 0.0)

        for bad in (
            {"rl_group_temperature_spread": -0.1},
            {"rl_group_temperature_spread": 1.1},
            {"rl_group_temperature_spread": True},
            {"confident_length_std_floor": 0.0},
            {"confident_length_std_floor": -16.0},
            {"confident_length_std_floor": True},
            {"opsd_norm_mode": "invalid"},
            {"multiturn_rollout_fraction": -0.05},
            {"multiturn_rollout_fraction": 1.2},
            {"multiturn_rollout_fraction": True},
        ):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                load_config(overrides=bad)

    def test_confident_length_std_floor_controls_length_contrast_strength(self):
        records = [
            {"terminated": True, "target_logprob_sum": -0.01, "generated_tokens": 100},
            {"terminated": True, "target_logprob_sum": -0.01, "generated_tokens": 132},
        ]
        # mean = 116, tok_dev = 16 -> floor 64 gives ±16/64 = ±0.25; floor 32 gives ±16/32 = ±0.50.
        base_cfg = {"length_penalty": 0.5, "length_scale_tokens": 2048, "advantage_mode": "decoupled"}
        sig_64 = likelihood_advantages(records, {**base_cfg, "confident_length_std_floor": 64.0}, coefficient=0.5)
        sig_32 = likelihood_advantages(records, {**base_cfg, "confident_length_std_floor": 32.0}, coefficient=0.5)
        self.assertAlmostEqual(sig_64["length_advantages"][0], 0.25, places=6)
        self.assertAlmostEqual(sig_32["length_advantages"][0], 0.50, places=6)
        self.assertAlmostEqual(sig_32["advantages"][0], 2.0 * sig_64["advantages"][0], places=6)

    def test_rl_group_temperature_spread_varies_temperatures_in_likelihood_and_rollout(self):
        # 1. Likelihood mode: verify exact [1.0, 1.0833..., 1.1666..., 1.25]
        seen_temps: list[float] = []

        class _TempLikelihoodAdapter:
            backend_name = "fixture"
            sampling_revision = "tinker://sampler/0"

            def create_training_client(self, checkpoint=None): pass
            def create_sampling_client(self, checkpoint=None): self.sampling_revision = checkpoint or "base"
            def refresh_sampler(self): self.sampling_revision = "ephemeral-1"
            def checkpoint(self, name, **kwargs):
                return {"training_path": f"tinker://t/{name}", "sampler_path": f"tinker://s/{name}"}

            def extract_turn_targets(self, messages):
                return [{"turn_index": 0, "prefix_tokens": [1], "thinking_prompt_tokens": [1, 10, 11],
                         "target_action_tokens": [10, 20], "is_tool_call": False, "operation": "complete"}]

            def sample_thinking_and_score_target(self, turn_target, *, seed, max_tokens=None, temperature=None):
                seen_temps.append(float(temperature))
                ll = -0.1 if len(seen_temps) % 2 else -1.5
                return {
                    "prompt_tokens": [1, 10, 11], "token_ids": [50, 99], "logprobs": [-0.2, -0.1],
                    "target_tokens": [10, 20], "target_logprobs": [ll / 2, ll / 2],
                    "target_logprob_sum": ll, "target_logprob_mean": ll / 2,
                    "terminated": True, "truncated": False, "provenance_error": None,
                    "generated_tokens": 2, "sampler_revision": self.sampling_revision,
                    "operation": "complete", "is_tool_call": False, "turn_index": 0,
                    "token_categories": {"reasoning": 2, "trace": 0, "protocol": 0, "other": 0, "unclassified": 0},
                }

            def rl_train(self, trajectories, **options):
                return {"step": 1}

        cfg = load_config(overrides={
            "rl_steps": 1, "group_size": 4, "temperature": 1.0, "rl_group_temperature_spread": 0.25,
            "validation_every": 0, "checkpoint_every": 1,
        })
        rows = [_dataset_row("t1", split="train")]
        state = {"phase": "sft_done", "rl_steps_completed": 0, "training_path": None,
                 "sampler_path": "tinker://sampler/0", "evaluations": []}
        with tempfile.TemporaryDirectory() as d:
            train_rl(None, _TempLikelihoodAdapter(), rows, cfg, Path(d), state, random.Random(17))
        for got, exp in zip(seen_temps, [1.0, 1.0 + 0.25 / 3, 1.0 + 0.5 / 3, 1.25]):
            self.assertAlmostEqual(got, exp, places=6)

        # 2. Execution rollout mode with real TinkerAdapter.sample forwarding temperature!
        adapter, service, _ = fake_adapter({"temperature": 1.0, "max_tokens": 32})
        adapter.sampling_revision = "tinker://sampler/0"
        cfg_exec = load_config(overrides={
            "rl_objective": "compression", "rl_steps": 1, "group_size": 4,
            "temperature": 1.0, "rl_group_temperature_spread": 0.25,
            "validation_every": 0, "checkpoint_every": 1, "max_turns": 2,
        })
        # Override renderer.message text so ControlledBridge accepts "complete"
        adapter._sdk().renderer.message = {"role": "assistant", "content": [{"type": "text", "text": "complete"}]}
        state_exec = {"phase": "sft_done", "rl_steps_completed": 0, "training_path": "tinker://t/0",
                      "sampler_path": "tinker://s/0", "evaluations": []}
        with tempfile.TemporaryDirectory() as d:
            # Patch create_sampling_client to retain our sampler_revision matching state_exec
            orig_create = adapter.create_sampling_client
            def fake_create(checkpoint=None):
                res = orig_create(checkpoint=checkpoint)
                adapter.sampling_revision = checkpoint or "base"
                return res
            adapter.create_sampling_client = fake_create
            train_rl(ControlledBridge(), adapter, rows, cfg_exec, Path(d), state_exec, random.Random(17))
        rollout_temps = [call["sampling_params"].temperature for call in service.sampler.calls]
        self.assertEqual(len(rollout_temps), 4)
        for got, exp in zip(rollout_temps, [1.0, 1.0 + 0.25 / 3, 1.0 + 0.5 / 3, 1.25]):
            self.assertAlmostEqual(got, exp, places=6)

    def test_opsd_norm_mode_preserves_localized_spike_under_trajectory_normalization(self):
        # Short rollout: 10 tokens; Long rollout: 40 tokens -> mean_traj_len = 25.0.
        # scale_short = 25/10 = 2.5, scale_long = 25/40 = 0.625.
        short_len, long_len = 10, 40
        # Give long rollout one sharp 2-token OPSD error spike (teacher - student = +4.0) and neutral elsewhere.
        long_s_lps = [-0.5] * long_len
        long_t_lps = [-0.5] * long_len
        long_t_lps[3] = 3.5   # diff = +4.0
        long_t_lps[4] = 3.5   # diff = +4.0
        records = [
            {
                "terminated": True, "target_logprob_sum": -0.2, "generated_tokens": short_len,
                "samples": [{
                    "prompt_tokens": [1, 2],
                    "token_ids": list(range(20, 20 + short_len)),
                    "logprobs": [-0.5] * short_len,
                    "teacher_logprobs": [-0.5] * short_len,
                }],
            },
            {
                "terminated": True, "target_logprob_sum": -1.5, "generated_tokens": long_len,
                "samples": [{
                    "prompt_tokens": [1, 2],
                    "token_ids": list(range(30, 30 + long_len)),
                    "logprobs": long_s_lps,
                    "teacher_logprobs": long_t_lps,
                }],
            },
        ]
        base_cfg = {
            "length_penalty": 0.25, "length_scale_tokens": 2048, "advantage_mode": "decoupled",
            "target_anchor_weight": 0.0, "likelihood_std_floor": 0.5,
            "opsd_coef": 0.5, "opsd_clip": 5.0, "opsd_ll_threshold": -0.5,
        }
        sig = likelihood_advantages(records, base_cfg, coefficient=0.25)
        self.assertIsNone(sig["opsd_token_deltas"][0])
        self.assertIsNotNone(sig["opsd_token_deltas"][1])
        # Unscaled OPSD spike at index 3 is 0.5 * 4.0 = 2.0.
        self.assertAlmostEqual(sig["opsd_token_deltas"][1][3], 2.0, places=6)
        self.assertAlmostEqual(sig["opsd_token_deltas"][1][0], 0.0, places=6)
        base_long = sig["advantages"][1]
        self.assertAlmostEqual(sig["token_advantages"][1][3], base_long + 2.0, places=6)

        traj_short = {"samples": [copy.deepcopy(records[0]["samples"][0])], "advantage": sig["advantages"][0]}
        traj_long = {
            "samples": [{
                **copy.deepcopy(records[1]["samples"][0]),
                "token_advantages": sig["token_advantages"][1],
                "opsd_token_deltas": sig["opsd_token_deltas"][1],
            }],
            "advantage": base_long,
        }
        scale_long = 25.0 / 40.0

        for mode, expected_opsd_scale in (
            ("trajectory", scale_long),
            ("sqrt", math.sqrt(scale_long)),
            ("none", 1.0),
        ):
            with self.subTest(opsd_norm_mode=mode):
                adapter, service, _ = fake_adapter({
                    "rl_token_normalization": "trajectory",
                    "opsd_norm_mode": mode,
                })
                adapter.rl_train([copy.deepcopy(traj_short), copy.deepcopy(traj_long)])
                datums = service.trainer.calls[0][1]
                long_advs = datums[1].loss_fn_inputs["advantages"]
                # Prompt token index 0 is masked (len(prompt_tokens)-1 == 1)
                self.assertEqual(long_advs[0], 0.0)
                # Non-spike token index 1+0 receives base_long * scale_long
                self.assertAlmostEqual(long_advs[1], base_long * scale_long, places=6)
                # Spike token index 1+3 receives base_long * scale_long + 2.0 * expected_opsd_scale
                self.assertAlmostEqual(long_advs[4], base_long * scale_long + 2.0 * expected_opsd_scale, places=6)

        # Verify 'sqrt' and 'none' keep spike magnitude strictly stronger than 'trajectory' on long rollouts.
        adapter_traj, svc_traj, _ = fake_adapter({"rl_token_normalization": "trajectory", "opsd_norm_mode": "trajectory"})
        adapter_sqrt, svc_sqrt, _ = fake_adapter({"rl_token_normalization": "trajectory", "opsd_norm_mode": "sqrt"})
        adapter_none, svc_none, _ = fake_adapter({"rl_token_normalization": "trajectory", "opsd_norm_mode": "none"})
        for ad in (adapter_traj, adapter_sqrt, adapter_none):
            ad.rl_train([copy.deepcopy(traj_short), copy.deepcopy(traj_long)])
        spike_traj = svc_traj.trainer.calls[0][1][1].loss_fn_inputs["advantages"][4] - svc_traj.trainer.calls[0][1][1].loss_fn_inputs["advantages"][1]
        spike_sqrt = svc_sqrt.trainer.calls[0][1][1].loss_fn_inputs["advantages"][4] - svc_sqrt.trainer.calls[0][1][1].loss_fn_inputs["advantages"][1]
        spike_none = svc_none.trainer.calls[0][1][1].loss_fn_inputs["advantages"][4] - svc_none.trainer.calls[0][1][1].loss_fn_inputs["advantages"][1]
        self.assertGreater(spike_none, spike_sqrt)
        self.assertGreater(spike_sqrt, spike_traj)

        # When rl_token_normalization == "none", opsd_norm_mode has no scaling effect (all 1.0).
        adapter_unnorm, svc_unnorm, _ = fake_adapter({"rl_token_normalization": "none", "opsd_norm_mode": "sqrt"})
        adapter_unnorm.rl_train([copy.deepcopy(traj_short), copy.deepcopy(traj_long)])
        spike_unnorm = svc_unnorm.trainer.calls[0][1][1].loss_fn_inputs["advantages"][4] - svc_unnorm.trainer.calls[0][1][1].loss_fn_inputs["advantages"][1]
        self.assertAlmostEqual(spike_unnorm, 2.0, places=6)


class HybridMultiturnRLTests(unittest.TestCase):
    def test_hybrid_multiturn_rollout_mixes_with_likelihood_opsd_in_same_step(self):
        # Mix 1 effectful row (externalCalls=2, always picked for multiturn rollout since fraction=1.0)
        # with 1 pure row (externalCalls=0, always runs likelihood + OPSD), using real TinkerAdapter.rl_train!
        effectful_row = _dataset_row("eff-1", split="train", external_calls=2, features=["hard-effectful"])
        pure_row = _dataset_row("pure-1", split="train", external_calls=0, features=["native-v8"])

        adapter, service, renderer = fake_adapter({
            "rl_token_normalization": "trajectory",
            "opsd_norm_mode": "sqrt",
            "max_tokens": 64,
        })
        adapter._thinking_ids = (10, 11, 99)
        adapter.sampling_client = service.sampler
        adapter.sampling_revision = "tinker://sampler/sft"

        # Script multi-turn responses for rollout(): first rollout succeeds in 2 turns ("read", "complete"),
        # second rollout fails immediately ("wrong") -> mixed_success -> non-zero execution advantages!
        rollout_script = [
            ({"role": "assistant", "content": [{"type": "text", "text": "read"}]}, [41, 42, 99], [-0.2, -0.3, -0.1]),
            ({"role": "assistant", "content": [{"type": "text", "text": "complete"}]}, [43, 44, 99], [-0.1, -0.2, -0.1]),
            ({"role": "assistant", "content": [{"type": "text", "text": "wrong"}]}, [45, 99], [-0.4, -0.2]),
        ]
        # Avoid touching adapter.create_sampling_client revision in test
        adapter.create_sampling_client = lambda checkpoint=None: setattr(adapter, "sampling_revision", checkpoint or "base")
        adapter.checkpoint = lambda name, **kw: {
            "training_path": f"tinker://train/{name}",
            "sampler_path": f"tinker://sampler/{name}",
            "step": 1,
        }

        def scripted_sample(messages, max_tokens=None, seed=None, temperature=None):
            msg, toks, lps = rollout_script.pop(0)
            renderer.message = msg
            service.sampler.sequence = SimpleNamespace(tokens=toks, logprobs=lps, stop_reason="stop")
            return TinkerAdapter.sample(adapter, messages, max_tokens=max_tokens, seed=seed, temperature=temperature)

        adapter.sample = scripted_sample
        adapter.extract_turn_targets = lambda msgs: [{
            "turn_index": 0,
            "prefix_tokens": [1, 2],
            "thinking_prompt_tokens": [1, 2, 10, 11],
            "teacher_thinking_prompt_tokens": [1, 2, 3, 10, 11],
            "target_action_tokens": [10, 20, 99],
            "is_tool_call": False,
            "operation": "complete",
        }]
        ll_scores = iter([-0.2, -2.5])
        adapter.sample_thinking_and_score_target = lambda tt, *, seed, max_tokens=None, temperature=None, score_teacher=False, teacher_scorer=None, teacher_ll_threshold=None: (
            lambda ll: {
                "prompt_tokens": list(tt["thinking_prompt_tokens"]),
                "token_ids": [60, 61, 99],
                "logprobs": [-1.5, -0.5, -0.2],
                "teacher_logprobs": [-0.2, -0.5, -0.2] if (score_teacher and ll < -0.5) else None,
                "target_tokens": list(tt["target_action_tokens"]),
                "target_logprobs": [ll / 3.0] * 3,
                "target_logprob_sum": ll,
                "target_logprob_mean": ll / 3.0,
                "terminated": True,
                "truncated": False,
                "provenance_error": None,
                "generated_tokens": 3,
                "sampler_revision": adapter.sampling_revision,
                "operation": "complete",
                "is_tool_call": False,
                "turn_index": 0,
                "token_categories": {"reasoning": 3, "trace": 0, "protocol": 0, "other": 0, "unclassified": 0},
            }
        )(next(ll_scores))

        # Force deterministic alternating pick: first effectful_row, then pure_row
        picks = iter([
            (effectful_row, {"enabled": False, "active_tier": 3, "rehearsal": False}),
            (pure_row, {"enabled": False, "active_tier": 3, "rehearsal": False}),
        ])
        cfg = load_config(overrides={
            "rl_objective": "likelihood",
            "rl_steps": 1,
            "rl_prompts_per_step": 2,
            "group_size": 2,
            "multiturn_rollout_fraction": 1.0,
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
        with tempfile.TemporaryDirectory() as d, \
                patch("tinker_js.runner.curriculum_pick", side_effect=lambda *a, **kw: next(picks)), \
                contextlib.redirect_stderr(stderr_buf):
            train_rl(ControlledBridge(), adapter, [effectful_row, pure_row], cfg, Path(d), state, random.Random(17), training_ready=True)
            metrics_rows = [json.loads(line) for line in (Path(d) / "metrics.jsonl").read_text().splitlines()]
            rl_metric = next(m for m in metrics_rows if m.get("stage") == "rl")
            rollouts = read_jsonl(Path(d) / "rollouts/rl-000001.jsonl")

        # Verify single combined optimizer update ran with both multi-turn rollout (2+1=3 samples) and likelihood+OPSD (2 samples) -> 5 datums!
        self.assertEqual(state["rl_optimizer_updates"], 1)
        fb_calls = [c for c in service.trainer.calls if c[0] == "forward_backward"]
        self.assertEqual(len(fb_calls), 1)
        datums = fb_calls[0][1]
        self.assertEqual(len(datums), 5)

        # Rollout record 0 had 2 turns ("read", "complete"), rollout record 1 had 1 turn ("wrong") -> execution_advantages gave +1/-1
        self.assertEqual(len(rollouts[0]["samples"]), 2)
        self.assertTrue(rollouts[0]["grade"]["success"])
        self.assertGreater(rollouts[0]["advantage"], 0.0)
        self.assertFalse(rollouts[1]["grade"]["success"])
        self.assertLess(rollouts[1]["advantage"], 0.0)

        # Pure group ran likelihood + OPSD (record 3 had ll=-2.5 < -0.5 -> OPSD active)
        self.assertIsNotNone(rollouts[3]["samples"][0].get("opsd_token_deltas"))
        self.assertTrue(rollouts[3].get("has_token_advantages"))

        # Check metrics.jsonl & stderr logging for hybrid multiturn fields
        self.assertEqual(rl_metric["multiturn_rollout_groups"], 1)
        self.assertAlmostEqual(rl_metric["multiturn_rollout_acc"], 0.5, places=6)
        self.assertIn("multiturn=1/2(50.0%)", stderr_buf.getvalue())

    def test_hybrid_multiturn_fraction_never_triggers_rollout_for_pure_tasks(self):
        pure_row = _dataset_row("pure-only", split="train", external_calls=0, features=["native-v8"])

        class _PureAdapter:
            backend_name = "fixture"
            sampling_revision = "tinker://s/0"

            def create_training_client(self, checkpoint=None): pass
            def create_sampling_client(self, checkpoint=None): self.sampling_revision = checkpoint or "base"
            def refresh_sampler(self): pass
            def checkpoint(self, name, **kw):
                return {"training_path": f"tinker://t/{name}", "sampler_path": f"tinker://s/{name}"}
            def sample(self, *args, **kwargs):
                raise AssertionError("rollout() must not be called when externalCalls == 0")
            def extract_turn_targets(self, msgs):
                return [{"turn_index": 0, "prefix_tokens": [1], "thinking_prompt_tokens": [1, 10, 11],
                         "target_action_tokens": [10, 20], "is_tool_call": False, "operation": "complete"}]
            def sample_thinking_and_score_target(self, tt, *, seed, max_tokens=None, temperature=None):
                ll = -0.2 if seed % 2 == 0 else -1.5
                return {
                    "prompt_tokens": [1, 10, 11], "token_ids": [50, 99], "logprobs": [-0.2, -0.1],
                    "target_tokens": [10, 20], "target_logprobs": [ll / 2, ll / 2],
                    "target_logprob_sum": ll, "target_logprob_mean": ll / 2,
                    "terminated": True, "truncated": False, "provenance_error": None,
                    "generated_tokens": 2, "sampler_revision": self.sampling_revision,
                    "operation": "complete", "is_tool_call": False, "turn_index": 0,
                    "token_categories": {"reasoning": 2, "trace": 0, "protocol": 0, "other": 0, "unclassified": 0},
                }
            def rl_train(self, trajectories, **options):
                return {"step": 1}

        cfg = load_config(overrides={
            "rl_objective": "likelihood", "rl_steps": 1, "group_size": 2,
            "multiturn_rollout_fraction": 1.0, "validation_every": 0, "checkpoint_every": 1,
        })
        state = {"phase": "sft_done", "rl_steps_completed": 0, "training_path": "tinker://t/0",
                 "sampler_path": "tinker://s/0", "evaluations": []}
        with tempfile.TemporaryDirectory() as d:
            train_rl(None, _PureAdapter(), [pure_row], cfg, Path(d), state, random.Random(17))
            rl_metric = json.loads((Path(d) / "metrics.jsonl").read_text().splitlines()[0])
            self.assertEqual(rl_metric["multiturn_rollout_groups"], 0)
            self.assertIsNone(rl_metric["multiturn_rollout_acc"])


class StratifiedBucketAndManifestTests(unittest.TestCase):
    def test_task_eval_bucket_classification_and_precedence(self):
        self.assertEqual(task_eval_bucket({"id": "py-foo-0", "language": "py", "features": ["unit-test-input", "hairy-real"]}), "python")
        self.assertEqual(task_eval_bucket({"task_id": "custom-py", "language": "py"}), "python")
        self.assertEqual(task_eval_bucket({"id": "x-1", "metadata": {"features": ["python"]}}), "python")
        self.assertEqual(task_eval_bucket({"id": "oss-1", "metadata": {"features": ["hairy-real", "unit-test-input"]}}), "hairy-real")
        self.assertEqual(task_eval_bucket({"id": "hard-1", "metadata": {"features": ["hard-effectful", "unit-test-input"]}}), "hard-effectful")
        self.assertEqual(task_eval_bucket({"id": "oss-2", "metadata": {"features": ["unit-test-input"]}}), "oss-unit-test")
        self.assertEqual(task_eval_bucket({"id": "generated-algo-0", "metadata": {"features": ["native-v8"]}}), "hard-js-owned")
        self.assertEqual(task_eval_bucket({"id": "oss-probe-0", "metadata": {"features": ["native-v8", "real-oss"]}}), "oss-probe")

    def test_summarize_records_and_report_include_by_bucket(self):
        cfg = load_config(overrides={"evaluation_samples": 1, "final_test": False})
        rows = [
            _dataset_row("py-a", split="validation", language="py", features=["python"]),
            _dataset_row("hr-a", split="validation", features=["hairy-real"]),
            _dataset_row("he-a", split="validation", features=["hard-effectful"]),
            _dataset_row("ut-a", split="validation", features=["unit-test-input"]),
            _dataset_row("generated-a", split="validation", features=["native-v8"]),
            _dataset_row("oss-a", split="validation", features=["real-oss"]),
        ]

        class _BucketEvalAdapter:
            backend_name = "tinker"

            def __init__(self):
                self.calls = 0

            def sample(self, messages, max_tokens=None, seed=None):
                self.calls += 1
                # Succeed on sorted odd positions (generated-a, hr-a, py-a), fail on even positions (he-a, oss-a, ut-a).
                text = "complete" if self.calls % 2 == 1 else "wrong"
                toks = 10 if text == "complete" else 20
                return {
                    "message": {"role": "assistant", "content": [{"type": "text", "text": text}]},
                    "text": text,
                    "prompt_tokens": [1, 2],
                    "token_ids": list(range(toks)),
                    "logprobs": [-0.1] * toks,
                    "stop_reason": "stop",
                    "complete": True,
                }

        with tempfile.TemporaryDirectory() as d:
            out = Path(d)
            summary = evaluate(ControlledBridge(), _BucketEvalAdapter(), rows, cfg, out, "baseline", split="validation")
            self.assertEqual(
                set(summary["by_bucket"].keys()),
                {"python", "hairy-real", "hard-effectful", "oss-unit-test", "hard-js-owned", "oss-probe"},
            )
            self.assertEqual(summary["by_bucket"]["python"]["complete_execution_accuracy"], 1.0)
            self.assertEqual(summary["by_bucket"]["python"]["tokens_per_verified_success"], 10.0)
            self.assertEqual(summary["by_bucket"]["hairy-real"]["complete_execution_accuracy"], 1.0)
            self.assertEqual(summary["by_bucket"]["hard-effectful"]["complete_execution_accuracy"], 0.0)
            self.assertIsNone(summary["by_bucket"]["hard-effectful"]["tokens_per_verified_success"])
            self.assertEqual(summary["by_bucket"]["hard-effectful"]["failure_categories"], {"other_execution_failure": 1})

            report = make_report(out, cfg)
            self.assertIn("by_bucket", report["validation_stages"]["baseline"])
            self.assertEqual(report["validation_stages"]["baseline"]["by_bucket"], summary["by_bucket"])

    def test_build_eval_manifest_quotas_shortfall_and_runner_integration(self):
        # Create validation split with surplus in all 6 buckets (hitting exact default quotas 40/40/25/50/30/15 = 200)
        # AND test split missing hairy-real & short on python (only 10), verifying proportional shortfall fill to 200!
        rows: list[dict] = []
        val_specs = [
            ("py-val", "python", {"language": "py", "features": ["python"]}, 60),
            ("hr-val", "hairy-real", {"features": ["hairy-real"]}, 60),
            ("he-val", "hard-effectful", {"features": ["hard-effectful"]}, 40),
            ("ut-val", "oss-unit-test", {"features": ["unit-test-input"]}, 70),
            ("oss-val", "oss-probe", {"features": ["real-oss"]}, 50),
            ("generated-val", "hard-js-owned", {"features": ["native-v8"]}, 30),
        ]
        for prefix, _b, kw, count in val_specs:
            for i in range(count):
                rows.append(_dataset_row(f"{prefix}-{i:03d}", split="validation", family=f"fam-{prefix}-{i % 20}", **kw))

        test_specs = [
            ("py-test", {"language": "py", "features": ["python"]}, 10),         # short by 30
            # hairy-real: 0 (short by 40)
            ("he-test", {"features": ["hard-effectful"]}, 15),                   # short by 10
            ("ut-test", {"features": ["unit-test-input"]}, 120),
            ("oss-test", {"features": ["real-oss"]}, 120),
            ("generated-test", {"features": ["native-v8"]}, 60),
        ]
        for prefix, kw, count in test_specs:
            for i in range(count):
                rows.append(_dataset_row(f"{prefix}-{i:03d}", split="test", family=f"fam-{prefix}-{i % 30}", **kw))

        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            ds_path = root / "dataset.jsonl"
            manifest_path = root / "eval-manifest.json"
            write_jsonl(ds_path, rows)

            stdout_buf = io.StringIO()
            with contextlib.redirect_stdout(stdout_buf):
                rc = build_manifest.main([
                    "--dataset", str(ds_path),
                    "--output", str(manifest_path),
                    "--max-tasks", "200",
                    "--seed", "17",
                ])
            self.assertEqual(rc, 0)
            manifest = json.loads(manifest_path.read_text())

            # Validation hit exact default quotas: 40, 40, 25, 50, 30, 15 = 200
            self.assertEqual(manifest["totals"]["validation"], 200)
            self.assertEqual(manifest["bucket_counts"]["validation"], {
                "python": 40,
                "hairy-real": 40,
                "hard-effectful": 25,
                "oss-unit-test": 50,
                "oss-probe": 30,
                "hard-js-owned": 15,
            })

            # Test hit all available scarce buckets (10 python, 15 hard-effectful) and filled remaining 175 proportionally to 200!
            self.assertEqual(manifest["totals"]["test"], 200)
            self.assertEqual(manifest["bucket_counts"]["test"]["python"], 10)
            self.assertEqual(manifest["bucket_counts"]["test"]["hard-effectful"], 15)
            self.assertNotIn("hairy-real", manifest["bucket_counts"]["test"])
            self.assertGreater(manifest["bucket_counts"]["test"]["oss-unit-test"], 50)
            self.assertGreater(manifest["bucket_counts"]["test"]["oss-probe"], 30)
            self.assertGreater(manifest["bucket_counts"]["test"]["hard-js-owned"], 15)

            # Verify exact compatibility with runner.py's config["evaluation_manifest"] & evaluation_selection()!
            cfg = load_config(overrides={"evaluation_manifest": str(manifest_path)})
            val_selected, val_meta = evaluation_selection(rows, cfg, root / "run", "validation")
            test_selected, test_meta = evaluation_selection(rows, cfg, root / "run", "test")
            self.assertEqual(val_meta["method"], "explicit_manifest")
            self.assertEqual(test_meta["method"], "explicit_manifest")
            self.assertEqual([r["id"] for r in val_selected], manifest["splits"]["validation"])
            self.assertEqual([r["id"] for r in test_selected], manifest["splits"]["test"])

    def test_build_eval_manifest_custom_quotas_and_unsplit_default_split(self):
        unsplit_rows = [
            _dataset_row(f"py-{i}", split=None, language="py", features=["python"]) for i in range(5)
        ] + [
            _dataset_row(f"hr-{i}", split=None, features=["hairy-real"]) for i in range(5)
        ] + [
            _dataset_row(f"oss-{i}", split=None, features=["real-oss"]) for i in range(10)
        ]
        for r in unsplit_rows:
            r.pop("split", None)
            r["task"].pop("split", None)
        with self.assertRaisesRegex(ValueError, "no split annotations"):
            build_manifest.build_eval_manifest(unsplit_rows, max_tasks=10)
        manifest = build_manifest.build_eval_manifest(
            unsplit_rows,
            max_tasks=10,
            quotas=build_manifest.parse_quotas("python=3,hairy-real=3"),
            quotas_explicit=True,
            splits=("validation",),
            default_split="validation",
            seed=7,
        )
        self.assertEqual(list(manifest["splits"].keys()), ["validation"])
        self.assertEqual(manifest["totals"]["validation"], 10)
        self.assertGreaterEqual(manifest["bucket_counts"]["validation"]["python"], 3)
        self.assertGreaterEqual(manifest["bucket_counts"]["validation"]["hairy-real"], 3)


if __name__ == "__main__":
    unittest.main()
