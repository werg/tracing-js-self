"""Tests for Python on-demand multi-file codebase loading (`code.load`),
causal teacher synthesis, flexible live grading, and multi-file repo harvesting.
"""

from __future__ import annotations

import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from tinker_py.codebase import (
    CODE_LOAD_OPERATION,
    WHOLE_FILE_THRESHOLD_BYTES,
    index_file_symbols,
    render_repo_manifest,
    serve_code_load,
)
from tinker_py.execution import (
    audit_python_conversation,
    audit_python_supervision,
    create_python_session,
    export_python_example,
    initial_messages,
    prepare_python_task,
    readable_messages_from_python,
)

REPO_ROOT = Path(__file__).resolve().parents[2]
HARVESTER_SCRIPT = REPO_ROOT / "tools" / "tinker-harvest-multifile-py.py"


def _make_large_parser_file() -> str:
    """Create a > 3 KB Python file with imports, constants, a class, and functions."""
    padding = "\n".join(f"    # padding comment line {i:03d} to ensure file exceeds 3072 bytes" for i in range(60))
    return f'''import math

BASE_WEIGHT = 10
SCALE_FACTOR = 2


class Parser:
    """Stateful toy parser with multiple methods."""

    def __init__(self, bias):
        self.bias = bias + BASE_WEIGHT

    def parse(self, value):
        return (value * SCALE_FACTOR) + self.bias


def parse_expr(x, y):
    total = x + y + BASE_WEIGHT
    if total > 20:
        return total * SCALE_FACTOR
    return total


def unused_giant_helper(items):
    acc = 0
{padding}
    for item in items:
        acc += item
    return acc
'''


def _extract_tool_calls(messages: list[dict]) -> list[tuple[str, list]]:
    calls = []
    for msg in messages:
        if msg.get("role") == "assistant" and isinstance(msg.get("tool_calls"), list):
            for tc in msg["tool_calls"]:
                fn = tc["function"]
                raw = json.loads(fn["arguments"])
                calls.append((fn["name"], raw.get("arguments", [])))
    return calls


class CodebaseIndexAndServerTests(unittest.TestCase):
    def test_render_repo_manifest_and_symbol_index(self) -> None:
        files = {
            "pkg/main.py": "from .utils import clamp\n\ndef run(x):\n    return clamp(x, 0, 10)\n",
            "pkg/utils.py": "MAX_VAL = 100\n\ndef clamp(x, lo, hi):\n    return max(lo, min(hi, x))\n\ndef slugify(s):\n    return s.lower()\n",
            "pkg/parser.py": _make_large_parser_file(),
        }
        manifest = render_repo_manifest(files, "pkg/main.py")
        lines = manifest.splitlines()
        self.assertIn("code.load", lines[0])
        # Entry file appears first and is marked [loaded].
        self.assertTrue(lines[1].startswith("- pkg/main.py "))
        self.assertIn("[loaded]", lines[1])
        self.assertIn(": run", lines[1])
        # Remaining files sorted deterministically and not marked [loaded].
        self.assertTrue(lines[2].startswith("- pkg/parser.py "))
        self.assertNotIn("[loaded]", lines[2])
        self.assertIn("BASE_WEIGHT", lines[2])
        self.assertIn("Parser", lines[2])
        self.assertIn("parse_expr", lines[2])
        self.assertTrue(lines[3].startswith("- pkg/utils.py "))
        self.assertIn("MAX_VAL", lines[3])
        self.assertIn("clamp", lines[3])
        self.assertIn("slugify", lines[3])

        idx = index_file_symbols(files["pkg/parser.py"], "pkg/parser.py")
        self.assertGreater(idx.bytes, WHOLE_FILE_THRESHOLD_BYTES)
        sym_names = [s.name for s in idx.symbols]
        self.assertIn("Parser", sym_names)
        self.assertIn("parse_expr", sym_names)

    def test_serve_code_load_modes_batching_and_errors(self) -> None:
        files = {
            "pkg/utils.py": "FACTOR = 3\n\ndef triple(x):\n    return x * FACTOR\n",
            "pkg/parser.py": _make_large_parser_file(),
        }

        # Whole file + symbol snippet + line range + duplicate request in one batch.
        res = serve_code_load(
            files,
            [
                {"path": "pkg/utils.py"},
                {"path": "pkg/utils.py"},  # duplicate should be deduplicated
                {"path": "pkg/parser.py", "symbol": "parse_expr"},
                {"path": "pkg/parser.py", "symbol": "Parser.parse"},
                {"path": "pkg/parser.py", "start_line": 1, "end_line": 6},
            ],
        )
        self.assertEqual(len(res), 4)
        self.assertEqual(res[0]["mode"], "file")
        self.assertEqual(res[0]["path"], "pkg/utils.py")
        self.assertEqual(res[0]["content"], files["pkg/utils.py"])

        self.assertEqual(res[1]["mode"], "symbol")
        self.assertEqual(res[1]["symbol"], "parse_expr")
        self.assertIn("import math", res[1]["content"])
        self.assertIn("BASE_WEIGHT = 10", res[1]["content"])
        self.assertIn("def parse_expr(x, y):", res[1]["content"])
        self.assertNotIn("unused_giant_helper", res[1]["content"])
        self.assertGreater(res[1]["start_line"], 1)
        self.assertGreaterEqual(res[1]["end_line"], res[1]["start_line"])

        self.assertEqual(res[2]["mode"], "symbol")
        self.assertEqual(res[2]["symbol"], "Parser.parse")
        self.assertIn("def parse(self, value):", res[2]["content"])

        self.assertEqual(res[3]["mode"], "range")
        self.assertEqual(res[3]["start_line"], 1)
        self.assertEqual(res[3]["end_line"], 6)
        self.assertIn("BASE_WEIGHT = 10", res[3]["content"])

        # Single dict accepted without list wrapper.
        single = serve_code_load(files, {"path": "pkg/utils.py"})
        self.assertEqual(len(single), 1)
        self.assertEqual(single[0]["path"], "pkg/utils.py")

        # Missing file, path traversal, and missing symbol return structured errors without raising.
        errs = serve_code_load(
            files,
            [
                {"path": "pkg/missing.py"},
                {"path": "../etc/passwd"},
                {"path": "pkg/parser.py", "symbol": "no_such_fn"},
            ],
        )
        self.assertEqual(errs[0]["error"], "file not found")
        self.assertIn("available_files", errs[0])
        self.assertEqual(errs[1]["error"], "file not found")
        self.assertEqual(errs[2]["error"], "symbol not found")
        self.assertIn("parse_expr", errs[2]["available_symbols"])

        # Response cap cleanly truncates oversized responses without crashing.
        capped = serve_code_load(files, [{"path": "pkg/parser.py"}], max_response_bytes=300)
        self.assertEqual(len(capped), 1)
        self.assertTrue(capped[0].get("truncated"))
        self.assertLessEqual(capped[0]["bytes"], 360)


class MultiFileExecutionAndCausalSynthesisTests(unittest.TestCase):
    def test_relative_and_package_imports_whole_file_load_and_dead_branch_skip(self) -> None:
        task = {
            "id": "mf-small-imports",
            "family": "test:mf:small",
            "language": "py",
            "files": {
                "pkg/__init__.py": "PKG_TAG = 'v1'\n",
                "pkg/main.py": (
                    "from .utils import clamp\n"
                    "from pkg.sub.helper import boost\n"
                    "from pkg.unused_distractor import explode\n\n"
                    "def run(x, use_boost):\n"
                    "    c = clamp(x, 0, 10)\n"
                    "    if use_boost:\n"
                    "        return boost(c)\n"
                    "    if x < -999:\n"
                    "        return explode(x)\n"
                    "    return c\n"
                ),
                "pkg/utils.py": (
                    "def clamp(v, lo, hi):\n"
                    "    if v < lo:\n"
                    "        return lo\n"
                    "    if v > hi:\n"
                    "        return hi\n"
                    "    return v\n"
                ),
                "pkg/sub/__init__.py": "",
                "pkg/sub/helper.py": "def boost(v):\n    return v * 2 + 1\n",
                "pkg/unused_distractor.py": "def explode(v):\n    raise RuntimeError('should never load')\n",
            },
            "entryFile": "pkg/main.py",
            "entry": "run",
            "args": [7, True],
            "fixture": {"calls": []},
        }

        exported = export_python_example(task, trace_format="compact")
        self.assertTrue(exported["metadata"]["traceAudit"]["replayVerified"])
        self.assertTrue(exported["metadata"]["multifile"])
        self.assertEqual(exported["metadata"]["fileCount"], 6)
        self.assertEqual(exported["metadata"]["codeLoadCalls"], 2)

        messages = exported["messages"]
        # Verify tool_declare contains code.load with required: ["arguments"].
        tool_decl_msg = next(m for m in messages if m["role"] == "tool_declare")
        tools = json.loads(tool_decl_msg["content"])
        code_load_decl = next(t for t in tools if t["function"]["name"] == CODE_LOAD_OPERATION)
        self.assertEqual(code_load_decl["function"]["parameters"]["required"], ["arguments"])

        # Initial user prompt has manifest + entryFile source, NOT non-entry file bodies.
        user_prompt = next(m["content"] for m in messages if m["role"] == "user")
        self.assertIn("Repository files", user_prompt)
        self.assertIn("pkg/main.py", user_prompt)
        self.assertIn("def run(x, use_boost):", user_prompt)
        self.assertNotIn("def boost(v):", user_prompt)
        self.assertNotIn("should never load", user_prompt)

        # Canonical teacher emitted whole-file loads for small files (<= 3 KB) and NEVER loaded distractor!
        tc_list = _extract_tool_calls(messages)
        self.assertEqual(
            tc_list,
            [
                ("code.load", [{"path": "pkg/utils.py"}]),
                ("code.load", [{"path": "pkg/sub/helper.py"}]),
            ],
        )

        # Verify actions-only format also emits identical code.load calls and passes audit!
        exported_ao = export_python_example(task, trace_format="actions-only")
        self.assertTrue(exported_ao["metadata"]["traceAudit"]["replayVerified"])
        self.assertEqual(_extract_tool_calls(exported_ao["messages"]), tc_list)

    def test_large_file_symbol_level_synthesis_and_class_dedup(self) -> None:
        task = {
            "id": "mf-large-symbol",
            "family": "test:mf:large",
            "language": "py",
            "files": {
                "pkg/__init__.py": "",
                "pkg/main.py": (
                    "from pkg.parser import Parser, parse_expr\n\n"
                    "def run(a, b):\n"
                    "    p = Parser(a)\n"
                    "    first = p.parse(b)\n"
                    "    second = parse_expr(a, b)\n"
                    "    return first + second\n"
                ),
                "pkg/parser.py": _make_large_parser_file(),
            },
            "entryFile": "pkg/main.py",
            "entry": "run",
            "args": [5, 7],
            "fixture": {"calls": []},
        }

        exported = export_python_example(task, trace_format="compact")
        self.assertTrue(exported["metadata"]["traceAudit"]["replayVerified"])
        tc_list = _extract_tool_calls(exported["messages"])
        # Parser.__init__ triggers symbol load for Parser; Parser.parse does NOT reload Parser;
        # parse_expr triggers symbol load for parse_expr; unused_giant_helper is NEVER loaded.
        self.assertEqual(
            tc_list,
            [
                ("code.load", [{"path": "pkg/parser.py", "symbol": "Parser"}]),
                ("code.load", [{"path": "pkg/parser.py", "symbol": "parse_expr"}]),
            ],
        )
        # Verify returned snippet included constants and excluded unused_giant_helper.
        tool_obs = [m["content"] for m in exported["messages"] if m["role"] == "tool"]
        self.assertEqual(len(tool_obs), 2)
        self.assertIn("BASE_WEIGHT = 10", tool_obs[0])
        self.assertIn("class Parser:", tool_obs[0])
        self.assertNotIn("unused_giant_helper", tool_obs[0])
        self.assertIn("def parse_expr(x, y):", tool_obs[1])
        self.assertNotIn("unused_giant_helper", tool_obs[1])

    def test_interleaved_code_load_and_external_effects(self) -> None:
        task = {
            "id": "mf-interleaved-effects",
            "family": "test:mf:effects",
            "language": "py",
            "files": {
                "app/__init__.py": "",
                "app/main.py": (
                    "from .worker import fetch_and_stamp\n"
                    "from .fmt import render_result\n\n"
                    "def run(key):\n"
                    "    print('start', key)\n"
                    "    val = fetch_and_stamp(key)\n"
                    "    out = render_result(val)\n"
                    "    return out\n"
                ),
                "app/worker.py": (
                    "import time\n\n"
                    "def fetch_and_stamp(key):\n"
                    "    raw = host.kv_get(key)\n"
                    "    ts = time.time()\n"
                    "    return {'raw': raw, 'ts': ts}\n"
                ),
                "app/fmt.py": (
                    "def render_result(obj):\n"
                    "    msg = f\"{obj['raw']}@{int(obj['ts'])}\"\n"
                    "    print('done', msg)\n"
                    "    return msg\n"
                ),
            },
            "entryFile": "app/main.py",
            "entry": "run",
            "args": ["user:1"],
            "fixture": {
                "calls": [
                    {"operation": "platform.print", "arguments": ["start", "user:1"], "status": "fulfilled", "result": None},
                    {"operation": "kv_get", "arguments": ["user:1"], "status": "fulfilled", "result": "alice"},
                    {"operation": "platform.time", "arguments": [], "status": "fulfilled", "result": 1700000123.0},
                    {"operation": "platform.print", "arguments": ["done", "alice@1700000123"], "status": "fulfilled", "result": None},
                ]
            },
        }

        exported = export_python_example(task, trace_format="compact")
        self.assertTrue(exported["metadata"]["traceAudit"]["replayVerified"])
        self.assertEqual(exported["metadata"]["externalCalls"], 4)
        self.assertEqual(exported["metadata"]["codeLoadCalls"], 2)

        tc_ops = [op for op, _ in _extract_tool_calls(exported["messages"])]
        self.assertEqual(
            tc_ops,
            [
                "platform.print",
                "code.load",
                "kv_get",
                "platform.time",
                "code.load",
                "platform.print",
            ],
        )

    def test_flexible_live_grading_allows_different_code_load_strategies(self) -> None:
        task = {
            "id": "mf-flex-grading",
            "family": "test:mf:flex",
            "language": "py",
            "files": {
                "pkg/__init__.py": "",
                "pkg/main.py": (
                    "from pkg.parser import Parser, parse_expr\n\n"
                    "def run(key):\n"
                    "    base = host.kv_get(key)\n"
                    "    p = Parser(base)\n"
                    "    return p.parse(3) + parse_expr(base, 4)\n"
                ),
                "pkg/parser.py": _make_large_parser_file(),
            },
            "entryFile": "pkg/main.py",
            "entry": "run",
            "args": ["seed"],
            "fixture": {
                "calls": [
                    {"operation": "kv_get", "arguments": ["seed"], "status": "fulfilled", "result": 5},
                ]
            },
        }
        prepared = prepare_python_task(task, trace_format="compact")
        # Compute expected return: base=5; Parser(5).bias=15; parse(3)=6+15=21; parse_expr(5,4)=19; sum=40.
        completion_action = {
            "role": "assistant",
            "content": '```json\n{"type":"complete","kind":"return","arguments":["seed"],"value":40}\n```',
        }
        kv_call = {
            "role": "assistant",
            "content": "",
            "tool_calls": [
                {
                    "type": "function",
                    "id": "tc_kv",
                    "function": {"name": "kv_get", "arguments": '{"arguments":["seed"]}'},
                }
            ],
        }

        # Strategy A: Student loads WHOLE file upfront (instead of 2 symbol loads after kv_get).
        sess_a = create_python_session(prepared)
        step1 = sess_a.step(
            {
                "role": "assistant",
                "content": "",
                "tool_calls": [
                    {
                        "type": "function",
                        "id": "tc_load_whole",
                        "function": {"name": "code.load", "arguments": '{"arguments":[{"path":"pkg/parser.py"}]}'},
                    }
                ],
            },
            10,
        )
        self.assertFalse(step1["done"])
        self.assertEqual(step1["messages"][0]["name"], "code.load")
        step2 = sess_a.step(kv_call, 20)
        self.assertFalse(step2["done"])
        step3 = sess_a.step(completion_action, 30)
        self.assertTrue(step3["done"])
        self.assertTrue(step3["grade"]["success"])
        self.assertEqual(step3["grade"]["codeLoadCalls"], 1)
        self.assertGreater(step3["grade"]["codeLoadBytes"], 3000)
        self.assertEqual(step3["grade"]["externalCalls"], 1)

        # Strategy B: Student batches 2 symbol loads in a single code.load call!
        sess_b = create_python_session(prepared)
        sess_b.step(kv_call, 10)
        batch_load = sess_b.step(
            {
                "role": "assistant",
                "content": "",
                "tool_calls": [
                    {
                        "type": "function",
                        "id": "tc_batch",
                        "function": {
                            "name": "code.load",
                            "arguments": json.dumps({
                                "arguments": [
                                    {"path": "pkg/parser.py", "symbol": "parse_expr"},
                                    {"path": "pkg/parser.py", "symbol": "Parser"},
                                ]
                            }),
                        },
                    }
                ],
            },
            20,
        )
        self.assertFalse(batch_load["done"])
        obs_payload = json.loads(batch_load["messages"][0]["content"])
        self.assertEqual(obs_payload["status"], "fulfilled")
        self.assertEqual(len(obs_payload["value"]), 2)
        end_b = sess_b.step(completion_action, 30)
        self.assertTrue(end_b["grade"]["success"])
        self.assertEqual(end_b["grade"]["codeLoadCalls"], 1)
        self.assertLess(end_b["grade"]["codeLoadBytes"], step3["grade"]["codeLoadBytes"])

        # Strategy C: Student asks for a missing symbol first (graceful error!), then recovers with single-dict arg!
        sess_c = create_python_session(prepared)
        err_step = sess_c.step(
            {
                "role": "assistant",
                "content": "",
                "tool_calls": [
                    {
                        "type": "function",
                        "id": "tc_bad_sym",
                        "function": {
                            "name": "code.load",
                            "arguments": '{"arguments":{"path":"pkg/parser.py","symbol":"missing_sym"}}',
                        },
                    }
                ],
            },
            5,
        )
        self.assertFalse(err_step["done"])
        err_obs = json.loads(err_step["messages"][0]["content"])
        self.assertEqual(err_obs["value"][0]["error"], "symbol not found")
        sess_c.step(kv_call, 15)
        end_c = sess_c.step(completion_action, 25)
        self.assertTrue(end_c["grade"]["success"])
        self.assertEqual(end_c["grade"]["codeLoadCalls"], 1)

        # Strategy D: Student skips required external kv_get -> MUST FAIL!
        sess_d = create_python_session(prepared)
        sess_d.step(
            {
                "role": "assistant",
                "content": "",
                "tool_calls": [
                    {
                        "type": "function",
                        "id": "tc_only_load",
                        "function": {"name": "code.load", "arguments": '{"arguments":[{"path":"pkg/parser.py"}]}'},
                    }
                ],
            },
            10,
        )
        fail_d = sess_d.step(completion_action, 20)
        self.assertTrue(fail_d["done"])
        self.assertFalse(fail_d["grade"]["success"])
        self.assertEqual(fail_d["grade"]["failureCategory"], "missing-external-effects")

    def test_causal_zero_future_leakage_across_diverging_branches(self) -> None:
        # Pair 1: External observation diverges -> loads different modules (pkg/left.py vs pkg/right.py).
        shared_files = {
            "pkg/__init__.py": "",
            "pkg/main.py": (
                "from .left import run_left\n"
                "from .right import run_right\n\n"
                "def run(x):\n"
                "    mode = host.kv_get('mode')\n"
                "    if mode == 'left':\n"
                "        return run_left(x)\n"
                "    return run_right(x)\n"
            ),
            "pkg/left.py": "def run_left(x):\n    return x * 10\n",
            "pkg/right.py": "def run_right(x):\n    return x + 10\n",
        }
        task_left = {
            "id": "mf-causal-left",
            "family": "test:mf:causal-branch",
            "language": "py",
            "files": shared_files,
            "entryFile": "pkg/main.py",
            "entry": "run",
            "args": [4],
            "fixture": {"calls": [{"operation": "kv_get", "arguments": ["mode"], "status": "fulfilled", "result": "left"}]},
            "features": ["causal-branch"],
        }
        task_right = {
            "id": "mf-causal-right",
            "family": "test:mf:causal-branch",
            "language": "py",
            "files": shared_files,
            "entryFile": "pkg/main.py",
            "entry": "run",
            "args": [4],
            "fixture": {"calls": [{"operation": "kv_get", "arguments": ["mode"], "status": "fulfilled", "result": "right"}]},
            "features": ["causal-branch"],
        }

        # Pair 2: Identical entryFile & manifest, diverging code.load observation content!
        task_calc_a = {
            "id": "mf-causal-codeload-a",
            "family": "test:mf:causal-codeload",
            "language": "py",
            "files": {
                "pkg/__init__.py": "",
                "pkg/main.py": "from .calc import compute\n\ndef run(x):\n    y = x + 1\n    return compute(y)\n",
                "pkg/calc.py": "def compute(n):\n    return n + 1\n",
            },
            "entryFile": "pkg/main.py",
            "entry": "run",
            "args": [7],
            "fixture": {"calls": []},
            "features": ["causal-codeload"],
        }
        task_calc_b = {
            "id": "mf-causal-codeload-b",
            "family": "test:mf:causal-codeload",
            "language": "py",
            "files": {
                "pkg/__init__.py": "",
                "pkg/main.py": "from .calc import compute\n\ndef run(x):\n    y = x + 1\n    return compute(y)\n",
                "pkg/calc.py": "def compute(n):\n    return n + 9\n",
            },
            "entryFile": "pkg/main.py",
            "entry": "run",
            "args": [7],
            "fixture": {"calls": []},
            "features": ["causal-codeload"],
        }

        # Verify Pair 2 has identical initial prompts before code.load observation diverges.
        prep_a = prepare_python_task(task_calc_a)
        prep_b = prepare_python_task(task_calc_b)
        self.assertEqual(initial_messages(prep_a), initial_messages(prep_b))

        audit = audit_python_supervision(
            [task_left, task_right, task_calc_a, task_calc_b],
            {"formats": ["compact", "actions-only"], "samplePerFeature": 4},
        )
        self.assertTrue(audit["valid"])
        self.assertTrue(audit["allReplayed"])
        # Both pairs diverge across both formats => 4 checked causal divergences!
        self.assertGreaterEqual(audit["causalDivergencesChecked"], 4)


class MultiFileHarvesterTests(unittest.TestCase):
    def test_multifile_harvester_end_to_end_on_mini_repo(self) -> None:
        with tempfile.TemporaryDirectory(prefix="mf-harvest-test-") as tmp:
            root = Path(tmp)
            repos_dir = root / "repos"
            repo = repos_dir / "sample_repo"
            pkg = repo / "mini_pkg"
            tests_dir = repo / "tests"
            pkg.mkdir(parents=True)
            tests_dir.mkdir(parents=True)

            (pkg / "__init__.py").write_text("VERSION = '1.0'\n", encoding="utf-8")
            (pkg / "math_ops.py").write_text(
                "def weighted_sum(nums, scale):\n"
                "    total = 0\n"
                "    for i, n in enumerate(nums):\n"
                "        total += (i + 1) * n\n"
                "    return total * scale\n",
                encoding="utf-8",
            )
            (pkg / "text_ops.py").write_text(
                "def format_score(label, score):\n"
                "    clean = label.strip().upper()\n"
                "    return f'{clean}:{score}'\n",
                encoding="utf-8",
            )
            (pkg / "pipeline.py").write_text(
                "from .math_ops import weighted_sum\n"
                "from .text_ops import format_score\n\n"
                "def evaluate_record(label, nums):\n"
                "    if not nums:\n"
                "        return format_score(label, 0)\n"
                "    score = weighted_sum(nums, 2)\n"
                "    return format_score(label, score)\n",
                encoding="utf-8",
            )
            (pkg / "unused_extra.py").write_text(
                "def dead_distractor(x):\n"
                "    return x * x * x\n",
                encoding="utf-8",
            )
            (tests_dir / "test_pipeline.py").write_text(
                "from mini_pkg.pipeline import evaluate_record\n\n"
                "def test_basic():\n"
                "    assert evaluate_record('alpha', [2, 3, 5]) == 'ALPHA:46'\n"
                "    assert evaluate_record('beta', [1, 4]) == 'BETA:18'\n",
                encoding="utf-8",
            )

            out_dir = root / "out"
            proc = subprocess.run(
                [
                    sys.executable,
                    str(HARVESTER_SCRIPT),
                    "--local-repos",
                    str(repos_dir),
                    "--output-dir",
                    str(out_dir),
                    "--jobs",
                    "1",
                ],
                capture_output=True,
                text=True,
                timeout=60,
                check=False,
            )
            self.assertEqual(proc.returncode, 0, f"Harvester failed: {proc.stderr}\n{proc.stdout}")

            census = json.loads((out_dir / "census.json").read_text(encoding="utf-8"))
            self.assertGreaterEqual(census["admittedUnique"], 2)
            self.assertGreaterEqual(census["unitTestInputAdmitted"], 2)
            self.assertGreaterEqual(census["withDistractorsAdmitted"], 2)

            rows = [
                json.loads(line)
                for line in (out_dir / "harvested.jsonl").read_text(encoding="utf-8").splitlines()
                if line.strip()
            ]
            self.assertEqual(len(rows), census["admittedUnique"])
            for row in rows:
                self.assertIn("files", row)
                self.assertIn("entryFile", row)
                self.assertGreaterEqual(len(row["files"]), 3)
                self.assertIn("mini_pkg/unused_extra.py", row["files"])
                self.assertIn("mini_pkg/unused_extra.py", row["metadata"]["distractorFiles"])
                self.assertGreaterEqual(row["metadata"]["codeLoadCalls"], 1)
                self.assertTrue(row["metadata"]["replayVerified"])
                # Re-verify exported conversation independently.
                re_exp = export_python_example(row, trace_format="compact")
                self.assertTrue(re_exp["metadata"]["traceAudit"]["replayVerified"])


if __name__ == "__main__":
    unittest.main()
