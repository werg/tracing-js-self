"""Unit tests for RealExecBench v1, external benchmark adapters, evaluator, and comparator.

Strictly offline: zero network or Tinker remote API calls.
"""

from __future__ import annotations

import copy
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from tinker_js.external_benchmarks import (
    build_zero_shot_messages,
    convert_cruxeval_row,
    convert_lcb_row,
    extract_zero_shot_answer,
    grade_zero_shot_response,
    python_values_equal,
    safe_eval_python_literal,
    verify_and_export_external_task,
)
from tinker_js.realexecbench import (
    audit_zero_leakage,
    collect_forbidden_identities,
    compare_realexecbench_runs,
    evaluate_realexecbench,
    export_unseen_counterfactual_io_pairs,
    render_scoreboard_markdown,
    summarize_realexecbench_records,
)
from tinker_js.runner import digest, write_jsonl

_REPO_ROOT = Path(__file__).resolve().parents[2]


class _FakeAdapter:
    """Offline deterministic fake adapter for execution and zero-shot eval tests."""

    backend_name = "fake-local"

    def __init__(self, responder, *, fail_on_substring: str | None = None):
        self._responder = responder
        self._fail_on_substring = fail_on_substring
        self.calls: list[dict] = []

    def sample(self, messages, max_tokens=2048, seed=0, temperature=1.0, clamp_to_context=False):
        self.calls.append({
            "messages": copy.deepcopy(messages),
            "max_tokens": max_tokens,
            "seed": seed,
            "temperature": temperature,
            "clamp_to_context": clamp_to_context,
        })
        user_blob = "\n".join(str(m.get("content", "")) for m in messages)
        if self._fail_on_substring and self._fail_on_substring in user_blob:
            raise RuntimeError("simulated transient sampler failure")
        return self._responder(messages, len(self.calls))


class ExternalBenchmarkAdapterTests(unittest.TestCase):
    def test_cruxeval_conversion_and_cpython_verification(self):
        raw = {
            "id": "sample_0",
            "code": (
                "def f(nums):\n"
                "    output = []\n"
                "    for n in nums:\n"
                "        output.append((nums.count(n), n))\n"
                "    output.sort(reverse=True)\n"
                "    return output"
            ),
            "input": "[1, 1, 3, 1, 3, 1]",
            "output": "[(4, 1), (4, 1), (4, 1), (4, 1), (2, 3), (2, 3)]",
        }
        task = convert_cruxeval_row(raw)
        self.assertEqual(task["id"], "cruxeval-o-sample_0")
        self.assertEqual(task["entry"], "f")
        self.assertEqual(task["language"], "py")
        self.assertEqual(task["args"], [[1, 1, 3, 1, 3, 1]])

        exported = verify_and_export_external_task(task, trace_format="compact")
        self.assertEqual(exported["split"], "test")
        self.assertTrue(exported["metadata"]["cpythonGroundTruthVerified"])
        self.assertTrue(exported["metadata"]["traceAudit"]["replayVerified"])

        # Zero-shot prompt preserves raw code & call
        zs_msgs = build_zero_shot_messages(exported)
        self.assertEqual(len(zs_msgs), 2)
        self.assertIn("def f(nums):", zs_msgs[1]["content"])
        self.assertIn("assert f([1, 1, 3, 1, 3, 1]) == ??", zs_msgs[1]["content"])

    def test_lcb_conversion_implicit_imports_kwargs_and_verification(self):
        raw = {
            "question_id": 2777,
            "id": "sample_1",
            "function_name": "distinctDifferenceArray",
            "code": (
                "def distinctDifferenceArray(nums: List[int]) -> List[int]:\n"
                "    r = Counter(nums)\n"
                "    l = set()\n"
                "    ans = []\n"
                "    for x in nums:\n"
                "        r[x] -= 1\n"
                "        if not r[x]:\n"
                "            del r[x]\n"
                "        l.add(x)\n"
                "        ans.append(len(l) - len(r))\n"
                "    return ans"
            ),
            "input": "distinctDifferenceArray(nums = [1, 2, 3, 4, 5])",
            "output": "[-3, -1, 1, 3, 5]",
            "difficulty": "easy",
            "contest_id": "weekly-contest-344",
            "contest_date": "2023-05-07T00:00:00",
            "numsteps": 869,
        }
        task = convert_lcb_row(raw)
        self.assertEqual(task["id"], "lcb-exec-sample_1-q2777")
        self.assertEqual(task["family"], "lcb-exec:q2777")
        self.assertIn("from typing import List", task["source"])
        self.assertIn("from collections import Counter", task["source"])
        self.assertEqual(task["args"], [[1, 2, 3, 4, 5]])

        exported = verify_and_export_external_task(task, trace_format="compact")
        self.assertTrue(exported["metadata"]["cpythonGroundTruthVerified"])
        self.assertTrue(exported["metadata"]["traceAudit"]["replayVerified"])

        # Tampered ground-truth output MUST be rejected by CPython verification
        bad_raw = {**raw, "output": "[0, 0, 0, 0, 0]"}
        bad_task = convert_lcb_row(bad_raw)
        with self.assertRaisesRegex(ValueError, "ground-truth mismatch"):
            verify_and_export_external_task(bad_task, trace_format="compact")

    def test_zero_shot_literal_parser_and_strict_equivalence_grading(self):
        # Safe AST literal evaluation
        self.assertEqual(safe_eval_python_literal("[(1, 'a'), (2, 'b')]"), [(1, "a"), (2, "b")])
        self.assertEqual(safe_eval_python_literal("set()"), set())
        self.assertEqual(safe_eval_python_literal("{1, 2, 3}"), {1, 2, 3})
        self.assertTrue(python_values_equal(float("nan"), float("nan")))

        # Strict type checks: bool != int, tuple != list
        self.assertFalse(python_values_equal(True, 1))
        self.assertFalse(python_values_equal(False, 0))
        self.assertFalse(python_values_equal([1, 2], (1, 2)))
        self.assertTrue(python_values_equal({1: (2, 3)}, {1: (2, 3)}))
        self.assertFalse(python_values_equal({True: 1}, {1: 1}))

        # Answer extraction variants
        self.assertEqual(extract_zero_shot_answer("Thinking...\n[ANSWER](1, 2)[/ANSWER]"), "(1, 2)")
        self.assertEqual(extract_zero_shot_answer("```python\nassert f(3) == [1, 4, 9]\n```"), "[1, 4, 9]")
        self.assertEqual(extract_zero_shot_answer("Answer: {'a': 1}"), "{'a': 1}")

        # Full grading
        g_ok = grade_zero_shot_response("Let's trace...\n[ANSWER][(4, 1), (2, 3)][/ANSWER]", "[(4, 1), (2, 3)]")
        self.assertTrue(g_ok["success"])

        g_wrong_type = grade_zero_shot_response("[ANSWER][[4, 1], [2, 3]][/ANSWER]", "[(4, 1), (2, 3)]")
        self.assertFalse(g_wrong_type["success"])

        g_bool_int = grade_zero_shot_response("[ANSWER]1[/ANSWER]", "True")
        self.assertFalse(g_bool_int["success"])

        # Execution JSON completion fallback in zero-shot grader
        g_json = grade_zero_shot_response(
            '```json\n{"type":"complete","kind":"return","arguments":[],"value":{"$py":"tuple","items":[1,2]}}\n```',
            "(1, 2)",
        )
        self.assertTrue(g_json["success"])

        # Malformed unparseable output
        g_bad = grade_zero_shot_response("[ANSWER]not valid python((([/ANSWER]", "42")
        self.assertFalse(g_bad["success"])
        self.assertEqual(g_bad["failureCategory"], "malformed_action")


class ZeroLeakageAndMetricsTests(unittest.TestCase):
    def test_zero_leakage_catches_all_four_overlap_dimensions(self):
        ref_rows = [
            {"id": "tr-1", "family": "fam-train", "sourceHash": "hash-train", "split": "train", "split_component": "comp-train"},
            {"id": "va-1", "family": "fam-val", "sourceHash": "hash-val", "split": "validation", "split_component": "comp-val"},
            {"id": "te-1", "family": "fam-test", "sourceHash": "hash-test", "split": "test", "split_component": "comp-test"},
        ]
        forbidden = collect_forbidden_identities(ref_rows)
        self.assertEqual(forbidden["ids"], {"tr-1", "va-1"})
        self.assertEqual(forbidden["families"], {"fam-train", "fam-val"})
        self.assertEqual(forbidden["sourceHashes"], {"hash-train", "hash-val"})
        self.assertEqual(forbidden["split_components"], {"comp-train", "comp-val"})

        # Clean benchmark row passes
        clean = [{"id": "te-1", "family": "fam-test", "sourceHash": "hash-test", "split_component": "comp-test"}]
        audit_ok = audit_zero_leakage(clean, forbidden, raise_on_leak=True)
        self.assertTrue(audit_ok["passed"])
        self.assertEqual(sum(audit_ok["overlap_counts"].values()), 0)

        # Each overlap dimension triggers failure
        for bad_row, dim in [
            ({"id": "tr-1", "family": "ok", "sourceHash": "ok", "split_component": "ok"}, "id"),
            ({"id": "ok", "family": "fam-val", "sourceHash": "ok", "split_component": "ok"}, "family"),
            ({"id": "ok", "family": "ok", "sourceHash": "hash-train", "split_component": "ok"}, "sourceHash"),
            ({"id": "ok", "family": "ok", "sourceHash": "ok", "split_component": "comp-val"}, "split_component"),
        ]:
            report = audit_zero_leakage([bad_row], forbidden, raise_on_leak=False)
            self.assertFalse(report["passed"])
            self.assertEqual(report["overlap_counts"][dim], 1)
            with self.assertRaisesRegex(ValueError, "Zero-leakage audit FAILED"):
                audit_zero_leakage([bad_row], forbidden, raise_on_leak=True)

    def test_causal_pair_accuracy_and_per_track_summary(self):
        records = [
            # Pair A: both pass -> counts as 1 passed pair
            {
                "task_id": "t1", "family": "f1", "track": "effectful-io-pairs", "pair_id": "pair-a",
                "success": True, "generated_tokens": 100, "turns": 2, "code_load_calls": 0, "code_load_bytes": 0,
                "wall_clock_seconds": 1.0, "failure_category": "success", "grade": {"success": True},
            },
            {
                "task_id": "t2", "family": "f1", "track": "effectful-io-pairs", "pair_id": "pair-a",
                "success": True, "generated_tokens": 140, "turns": 3, "code_load_calls": 0, "code_load_bytes": 0,
                "wall_clock_seconds": 2.0, "failure_category": "success", "grade": {"success": True},
            },
            # Pair B: one passes, one fails -> strict causal pair accuracy = 0 for pair-b
            {
                "task_id": "t3", "family": "f2", "track": "effectful-io-pairs", "pair_id": "pair-b",
                "success": True, "generated_tokens": 200, "turns": 2, "code_load_calls": 0, "code_load_bytes": 0,
                "wall_clock_seconds": 1.5, "failure_category": "success", "grade": {"success": True},
            },
            {
                "task_id": "t4", "family": "f2", "track": "effectful-io-pairs", "pair_id": "pair-b",
                "success": False, "generated_tokens": 360, "turns": 4, "code_load_calls": 0, "code_load_bytes": 0,
                "wall_clock_seconds": 2.5, "failure_category": "incorrect_completion", "grade": {"success": False},
            },
            # Separate track with code.load
            {
                "task_id": "t5", "family": "f3", "track": "whole-codebase-65k", "pair_id": None,
                "success": True, "generated_tokens": 500, "turns": 5, "code_load_calls": 3, "code_load_bytes": 4096,
                "wall_clock_seconds": 4.0, "failure_category": "success", "grade": {"success": True},
            },
        ]
        summary = summarize_realexecbench_records(records, meta={"model": "test-model", "prompt_mode": "execution"})
        ov = summary["overall"]
        self.assertEqual(ov["executions"], 5)
        self.assertEqual(ov["successes"], 4)
        self.assertAlmostEqual(ov["task_accuracy"], 0.8)
        self.assertEqual(ov["causal_pairs_total"], 2)
        self.assertEqual(ov["causal_pairs_passed"], 1)
        self.assertAlmostEqual(ov["causal_pair_accuracy"], 0.5)
        self.assertEqual(ov["total_generated_tokens"], 1300)
        self.assertAlmostEqual(ov["tokens_per_verified_success"], 1300 / 4)
        self.assertAlmostEqual(ov["mean_generated_tokens"], 260.0)
        self.assertAlmostEqual(ov["median_generated_tokens"], 200.0)
        self.assertEqual(ov["failure_categories"], {"incorrect_completion": 1})

        eff = summary["by_track"]["effectful-io-pairs"]
        self.assertAlmostEqual(eff["task_accuracy"], 0.75)
        self.assertAlmostEqual(eff["causal_pair_accuracy"], 0.5)

        wc = summary["by_track"]["whole-codebase-65k"]
        self.assertAlmostEqual(wc["mean_code_load_calls"], 3.0)
        self.assertAlmostEqual(wc["mean_code_load_bytes"], 4096.0)

        md = render_scoreboard_markdown(summary)
        self.assertIn("RealExecBench v1 Scoreboard", md)
        self.assertIn("`effectful-io-pairs`", md)
        self.assertIn("50.0% (1/2)", md)

    def test_unseen_counterfactual_pairs_python_export_and_divergence(self):
        # Verify the 4 Python unseen counterfactual pairs (8 tasks) offline without requiring Node
        from tinker_js.realexecbench import unseen_counterfactual_io_pair_specs
        from tinker_py.execution import export_python_example

        py_specs = [s for s in unseen_counterfactual_io_pair_specs() if s["language"] == "py"]
        self.assertEqual(len(py_specs), 4)
        for spec in py_specs:
            outputs = []
            for branch_name, calls in spec["branches"]:
                task = {
                    "id": f"test-{spec['pair_id']}-{branch_name}",
                    "family": spec["family"],
                    "language": "py",
                    "source": spec["source"],
                    "entry": spec["entry"],
                    "args": spec["args"],
                    "fixture": {"calls": calls},
                    "randomSeed": 17,
                }
                exported = export_python_example(task, trace_format="compact", reasoning_channel="thinking")
                self.assertTrue(exported["metadata"]["traceAudit"]["replayVerified"])
                outputs.append(exported["messages"][-1]["content"])
            # Counterfactual branches must produce distinct final outputs!
            self.assertNotEqual(outputs[0], outputs[1])


class EvalAndCompareWorkflowTests(unittest.TestCase):
    def _build_mini_benchmark(self, tmp: Path) -> Path:
        raws = [
            {
                "id": "m0",
                "code": "def f(x):\n    return x * 2 + 1",
                "input": "5",
                "output": "11",
            },
            {
                "id": "m1",
                "code": "def f(s):\n    return s[::-1]",
                "input": "'abc'",
                "output": "'cba'",
            },
            {
                "id": "m2",
                "code": "def f(a, b):\n    return (a + b, a - b)",
                "input": "10, 3",
                "output": "(13, 7)",
            },
        ]
        rows = []
        for idx, raw in enumerate(raws):
            exp = verify_and_export_external_task(convert_cruxeval_row(raw), trace_format="compact")
            exp["track"] = "external-anchor"
            exp["pair_id"] = "mini-pair" if idx < 2 else None
            exp["metadata"]["track"] = "external-anchor"
            exp["metadata"]["pair_id"] = exp["pair_id"]
            rows.append(exp)
        bench_path = tmp / "mini-bench.jsonl"
        write_jsonl(bench_path, rows)
        return bench_path

    def test_zero_shot_eval_fault_tolerance_resume_and_compare(self):
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            bench_path = self._build_mini_benchmark(tmp)

            # Run 1 (baseline): gets m0 right, fails m1 with simulated infra error, gets m2 wrong
            def base_responder(messages, _call_idx):
                u = messages[-1]["content"]
                if "x * 2 + 1" in u:
                    ans = "[ANSWER]11[/ANSWER]"
                    toks = [1] * 120
                else:
                    ans = "[ANSWER](0, 0)[/ANSWER]"
                    toks = [1] * 200
                return {
                    "message": {"role": "assistant", "content": ans},
                    "text": ans,
                    "token_ids": toks,
                    "complete": True,
                    "stop_reason": "stop",
                }

            base_dir = tmp / "run-base"
            base_adapter = _FakeAdapter(base_responder, fail_on_substring="s[::-1]")
            base_summary = evaluate_realexecbench(
                benchmark_path=bench_path,
                output_dir=base_dir,
                model="fake/base-model",
                adapter=base_adapter,
                prompt_mode="zero-shot",
                concurrency=2,
                seed=17,
                label="Base-Model",
            )
            # Fault tolerance: 1 task threw RuntimeError, run still finished all 3 tasks cleanly!
            self.assertEqual(base_summary["overall"]["executions"], 3)
            self.assertEqual(base_summary["overall"]["successes"], 1)
            self.assertEqual(base_summary["overall"]["causal_pairs_total"], 1)
            self.assertEqual(base_summary["overall"]["causal_pairs_passed"], 0)
            self.assertTrue((base_dir / "infrastructure-errors.jsonl").is_file())
            self.assertTrue((base_dir / "scoreboard.md").is_file())
            self.assertTrue((base_dir / "summary.json").is_file())
            # Verify clamp_to_context=True was passed to adapter.sample
            self.assertTrue(all(c["clamp_to_context"] for c in base_adapter.calls))

            # Run 2 (candidate): gets ALL 3 right with fewer tokens, tested via partial run + --resume
            def cand_responder(messages, _call_idx):
                u = messages[-1]["content"]
                if "x * 2 + 1" in u:
                    ans = "[ANSWER]11[/ANSWER]"
                elif "s[::-1]" in u:
                    ans = "[ANSWER]'cba'[/ANSWER]"
                else:
                    ans = "[ANSWER](13, 7)[/ANSWER]"
                return {
                    "message": {"role": "assistant", "content": ans},
                    "text": ans,
                    "token_ids": [1] * 50,
                    "complete": True,
                    "stop_reason": "stop",
                }

            cand_dir = tmp / "run-cand"
            # Step A: run first 1 task only (simulate interrupted run)
            cand_adapter_1 = _FakeAdapter(cand_responder)
            evaluate_realexecbench(
                benchmark_path=bench_path,
                output_dir=cand_dir,
                model="fake/cand-model",
                adapter=cand_adapter_1,
                prompt_mode="zero-shot",
                concurrency=1,
                seed=17,
                limit=1,
                label="Teacher-S8",
            )
            self.assertEqual(len(cand_adapter_1.calls), 1)

            # Step B: resume full benchmark -> should ONLY execute the remaining 2 tasks!
            cand_adapter_2 = _FakeAdapter(cand_responder)
            cand_summary = evaluate_realexecbench(
                benchmark_path=bench_path,
                output_dir=cand_dir,
                model="fake/cand-model",
                adapter=cand_adapter_2,
                prompt_mode="zero-shot",
                concurrency=2,
                seed=17,
                resume=True,
                label="Teacher-S8",
            )
            self.assertEqual(len(cand_adapter_2.calls), 2)
            self.assertEqual(cand_summary["overall"]["executions"], 3)
            self.assertEqual(cand_summary["overall"]["successes"], 3)
            self.assertAlmostEqual(cand_summary["overall"]["causal_pair_accuracy"], 1.0)

            # Resume mismatch guard: different model in same output dir raises ValueError
            with self.assertRaisesRegex(ValueError, "Cannot --resume"):
                evaluate_realexecbench(
                    benchmark_path=bench_path,
                    output_dir=cand_dir,
                    model="fake/different-model",
                    adapter=_FakeAdapter(cand_responder),
                    prompt_mode="zero-shot",
                    resume=True,
                )

            # Compare runs via library AND CLI subcommand
            report, leaderboard_md = compare_realexecbench_runs(
                [base_dir, cand_dir],
                baseline_index=0,
                bootstrap_samples=200,
                seed=17,
            )
            self.assertIn("RealExecBench v1 Multi-Model Leaderboard", leaderboard_md)
            self.assertIn("Base-Model", leaderboard_md)
            self.assertIn("Teacher-S8", leaderboard_md)
            paired = report["paired_vs_baseline"]["Teacher-S8"]["overall"]
            self.assertEqual(paired["matched_tasks"], 3)
            self.assertAlmostEqual(paired["accuracy_change"], 2 / 3)
            self.assertGreater(paired["tokens_per_verified_success_saving"], 0.5)
            self.assertIsNotNone(paired["accuracy_change_ci95"])

            # CLI compare smoke check
            cli_md = tmp / "leaderboard.md"
            proc = subprocess.run(
                [
                    sys.executable,
                    str(_REPO_ROOT / "tools" / "eval-realexecbench.py"),
                    "compare",
                    str(base_dir),
                    str(cand_dir),
                    "--bootstrap-samples",
                    "100",
                    "--output",
                    str(cli_md),
                ],
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(proc.returncode, 0, proc.stderr)
            self.assertTrue(cli_md.is_file())
            self.assertIn("Teacher-S8", cli_md.read_text(encoding="utf-8"))

    def test_execution_mode_with_fake_bridge_and_adapter(self):
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            bench_path = self._build_mini_benchmark(tmp)

            # Use a lightweight in-process PythonExecutionSession bridge (no Node required)
            from tinker_py.execution import create_python_session, prepare_python_task

            class _LocalPyBridge:
                def __init__(self):
                    self._sessions = {}
                    self._seq = 0

                def request(self, op, **payload):
                    if op == "start":
                        self._seq += 1
                        sid = f"s{self._seq}"
                        prep = prepare_python_task(payload["task"], trace_format="actions-only")
                        sess = create_python_session(prep)
                        self._sessions[sid] = sess
                        return {"sessionId": sid, "messages": sess.messages}
                    if op == "step":
                        return self._sessions[payload["sessionId"]].step(payload["action"], payload.get("generatedTokens", 0))
                    if op == "grade":
                        return self._sessions[payload["sessionId"]].grade(payload.get("totalGeneratedTokens", 0))
                    if op == "close":
                        sess = self._sessions.pop(payload["sessionId"], None)
                        if sess:
                            sess.close()
                        return {"closed": True}
                    raise ValueError(op)

            def exec_responder(messages, _call_idx):
                u = messages[-1]["content"]
                if "x * 2 + 1" in u:
                    action = {"type": "complete", "kind": "return", "arguments": [5], "value": 11}
                elif "s[::-1]" in u:
                    action = {"type": "complete", "kind": "return", "arguments": ["abc"], "value": "cba"}
                else:
                    action = {"type": "complete", "kind": "return", "arguments": [10, 3], "value": {"$py": "tuple", "items": [13, 7]}}
                text = "```json\n" + json.dumps(action) + "\n```"
                return {
                    "message": {"role": "assistant", "content": text},
                    "text": text,
                    "token_ids": [7] * 40,
                    "complete": True,
                    "stop_reason": "stop",
                }

            out_dir = tmp / "run-exec"
            summary = evaluate_realexecbench(
                benchmark_path=bench_path,
                output_dir=out_dir,
                model="fake/exec-model",
                adapter=_FakeAdapter(exec_responder),
                bridge=_LocalPyBridge(),
                prompt_mode="execution",
                concurrency=1,
                seed=17,
            )
            self.assertEqual(summary["overall"]["executions"], 3)
            self.assertEqual(summary["overall"]["successes"], 3)
            self.assertAlmostEqual(summary["overall"]["task_accuracy"], 1.0)
            self.assertAlmostEqual(summary["overall"]["causal_pair_accuracy"], 1.0)
            self.assertAlmostEqual(summary["overall"]["mean_turns"], 1.0)


if __name__ == "__main__":
    unittest.main()
