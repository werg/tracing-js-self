"""Comprehensive tests for native Python execution, sys.settrace compact tracing,
mixed-language Bridge dispatch, and the Python OSS/unit-test harvester.
"""

from __future__ import annotations

import copy
from dataclasses import dataclass
import json
import math
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

from tinker_js.runner import Bridge, implementation_identity
from tinker_py.codec import (
    decode_readable,
    describe_graph,
    encode_exception,
    encode_readable,
    realize_graph,
)
from tinker_py.execution import (
    TINKER_PY_EXECUTION_SCHEMA,
    assistant_thinking_text,
    assistant_visible_text,
    audit_python_conversation,
    audit_python_supervision,
    create_python_session,
    export_python_example,
    initial_messages,
    prepare_python_task,
)
from tinker_py.tracer import create_python_tracer

REPO = Path(__file__).resolve().parents[2]


@dataclass
class _SamplePoint:
    x: int
    y: int
    label: str


class _HostileObject:
    def __repr__(self) -> str:
        raise AssertionError("__repr__ must never be called by tracer")

    def __str__(self) -> str:
        raise AssertionError("__str__ must never be called by tracer")

    def __eq__(self, other: object) -> bool:
        raise AssertionError("__eq__ must never be called by tracer")


class CodecTests(unittest.TestCase):
    def test_primitives_and_special_floats_roundtrip(self):
        values = [
            None,
            True,
            False,
            0,
            -42,
            10**25,
            3.5,
            float("nan"),
            float("inf"),
            float("-inf"),
            -0.0,
            "hello 🌍",
            b"\x00\xffabc",
        ]
        encoded = encode_readable(values)
        self.assertEqual(encoded[7], {"$py": "NaN"})
        self.assertEqual(encoded[8], {"$py": "Infinity"})
        self.assertEqual(encoded[9], {"$py": "-Infinity"})
        self.assertEqual(encoded[10], {"$py": "-0"})
        self.assertEqual(encoded[12]["$py"], "bytes")

        decoded = decode_readable(encoded)
        self.assertIsNone(decoded[0])
        self.assertIs(decoded[1], True)
        self.assertIs(decoded[2], False)
        self.assertEqual(decoded[3], 0)
        self.assertEqual(decoded[5], 10**25)
        self.assertTrue(math.isnan(decoded[7]))
        self.assertTrue(math.isinf(decoded[8]) and decoded[8] > 0)
        self.assertTrue(math.isinf(decoded[9]) and decoded[9] < 0)
        self.assertEqual(decoded[10], 0.0)
        self.assertLess(math.copysign(1.0, decoded[10]), 0.0)
        self.assertEqual(decoded[11], "hello 🌍")
        self.assertEqual(decoded[12], b"\x00\xffabc")
        self.assertEqual(describe_graph(values), describe_graph(decoded))

    def test_containers_tuples_sets_non_string_and_escaped_dicts(self):
        value = {
            "tup": (1, "two", (3, b"x")),
            "set": {3, 1, "b", "a", None, (1, 2)},
            "non_str_dict": {1: "one", (2, 3): [4, 5], True: "yes"},
            "escaped_dict": {"$py": "literal", "other": 9},
        }
        encoded = encode_readable(value)
        self.assertEqual(encoded["tup"]["$py"], "tuple")
        self.assertEqual(encoded["set"]["$py"], "set")
        self.assertEqual(encoded["non_str_dict"]["$py"], "dict")
        self.assertEqual(encoded["escaped_dict"]["$py"], "dict")

        decoded = decode_readable(encoded)
        self.assertEqual(decoded["tup"], value["tup"])
        self.assertEqual(decoded["set"], value["set"])
        self.assertEqual(decoded["non_str_dict"], value["non_str_dict"])
        self.assertEqual(decoded["escaped_dict"], value["escaped_dict"])
        self.assertEqual(describe_graph([value]), describe_graph([decoded]))

    def test_aliasing_and_cycles_across_lists_dicts_sets_and_tuples(self):
        shared_list: list = [1, 2]
        shared_dict: dict = {"k": shared_list}
        shared_list.append(shared_dict)  # cycle list -> dict -> list
        cyclic_tuple = (shared_list,)
        shared_list.append(cyclic_tuple)  # list -> tuple -> list
        shared_set = {10, 20}
        root = {
            "arguments": [shared_list, shared_dict, shared_set],
            "value": shared_list,
        }
        encoded = encode_readable(root)
        self.assertEqual(encoded["value"], {"$py": "ref", "path": "/arguments/0"})
        self.assertEqual(encoded["arguments"][1], {"$py": "ref", "path": "/arguments/0/2"})

        decoded = decode_readable(encoded)
        self.assertIs(decoded["value"], decoded["arguments"][0])
        self.assertIs(decoded["arguments"][0][2], decoded["arguments"][1])
        self.assertIs(decoded["arguments"][1]["k"], decoded["arguments"][0])
        self.assertIsInstance(decoded["arguments"][0][3], tuple)
        self.assertIs(decoded["arguments"][0][3][0], decoded["arguments"][0])
        self.assertEqual(decoded["arguments"][2], {10, 20})

        graph = describe_graph([root["arguments"], root["value"]])
        realized = realize_graph(graph)
        self.assertIs(realized[1], realized[0][0])
        self.assertEqual(graph, describe_graph(realized))

    def test_type_distinction_and_boundary_rejections(self):
        # bool vs int vs float must not collide in describe_graph
        self.assertNotEqual(describe_graph([True]), describe_graph([1]))
        self.assertNotEqual(describe_graph([1]), describe_graph([1.0]))
        self.assertNotEqual(describe_graph([0.0]), describe_graph([-0.0]))

        # Plain dataclass & exception at boundary
        pt = _SamplePoint(3, 4, "p")
        self.assertEqual(encode_readable(pt), {"x": 3, "y": 4, "label": "p"})
        self.assertEqual(
            encode_readable(ValueError("bad input"), allow_exceptions=True),
            {"name": "ValueError", "message": "bad input"},
        )
        self.assertEqual(encode_exception(KeyError("missing")), {"name": "KeyError", "message": "'missing'"})

        # Unrepresentable objects must be rejected
        for bad in (lambda x: x, math, _HostileObject(), (x for x in range(3))):
            with self.assertRaises(TypeError):
                encode_readable(bad)
            with self.assertRaises(TypeError):
                describe_graph([bad])

        # Depth budget guard
        deep: list = []
        cur = deep
        for _ in range(70):
            nxt: list = []
            cur.append(nxt)
            cur = nxt
        with self.assertRaises(TypeError):
            encode_readable(deep)


class PurePythonExecutionTests(unittest.TestCase):
    def test_pure_messy_python_compact_trace_matches_uninstrumented(self):
        source = """\
import collections
import json
import re

def run(payload, records):
    parsed = json.loads(payload)
    counts = collections.Counter()
    for item in parsed["items"]:
        tokens = re.findall(r"[a-z]+", item.lower())
        for tok in tokens:
            if len(tok) >= 3:
                counts[tok] += 1
    top = sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))
    records.append({"total": sum(counts.values()), "unique": len(counts)})
    return (records, top[:3])
"""
        task = {
            "id": "py-pure-messy-1",
            "family": "py-pure-messy",
            "language": "py",
            "source": source,
            "entry": "run",
            "args": ['{"items":["Alpha beta alpha","Gamma alpha delta!"]}', []],
            "fixture": {"calls": []},
        }
        compact = export_python_example(task, trace_format="compact", reasoning_channel="thinking")
        actions_only = export_python_example(task, trace_format="actions-only", reasoning_channel="thinking")

        self.assertEqual(compact["schema"], TINKER_PY_EXECUTION_SCHEMA)
        self.assertTrue(compact["metadata"]["traceAudit"]["replayVerified"])
        self.assertGreater(compact["metadata"]["traceAudit"]["narrationLines"], 0)
        self.assertEqual(actions_only["metadata"]["traceAudit"]["narrationLines"], 0)

        # Compact trace thinking block should contain local/branch/return lines
        thinking = assistant_thinking_text(compact["messages"][-1])
        self.assertIn("branch", thinking)
        self.assertIn("return", thinking)

        # Final completion JSON must match uninstrumented actions-only byte-for-byte
        self.assertEqual(
            assistant_visible_text(compact["messages"][-1]),
            assistant_visible_text(actions_only["messages"][-1]),
        )
        # Verify mutation + alias in completion JSON
        vis = assistant_visible_text(compact["messages"][-1])
        json_str = vis.split("```json\n", 1)[1].split("\n```", 1)[0]
        comp = json.loads(json_str)
        self.assertEqual(comp["kind"], "return")
        self.assertEqual(comp["arguments"][1], [{"total": 6, "unique": 4}])
        # First tuple element aliases arguments[1]
        self.assertEqual(comp["value"]["$py"], "tuple")
        self.assertEqual(comp["value"]["items"][0], {"$py": "ref", "path": "/arguments/1"})

    def test_exception_and_hostile_object_never_triggers_dunders(self):
        source = """\
class Weird:
    def __repr__(self):
        raise RuntimeError("boom repr")
    def __str__(self):
        raise RuntimeError("boom str")
    def __eq__(self, other):
        raise RuntimeError("boom eq")

def run(x):
    w = Weird()
    if x < 0:
        raise ValueError("negative value")
    return x * 2
"""
        ok_task = {
            "id": "py-weird-ok",
            "family": "py-weird",
            "language": "py",
            "source": source,
            "entry": "run",
            "args": [5],
            "fixture": {"calls": []},
        }
        exported_ok = export_python_example(ok_task, trace_format="compact")
        thinking = assistant_thinking_text(exported_ok["messages"][-1])
        self.assertIn("w -> Weird", thinking)
        self.assertIn("return 10", thinking)

        throw_task = {
            **ok_task,
            "id": "py-weird-throw",
            "args": [-3],
        }
        exported_err = export_python_example(throw_task, trace_format="compact")
        self.assertTrue(exported_err["metadata"]["traceAudit"]["replayVerified"])
        err_thinking = assistant_thinking_text(exported_err["messages"][-1])
        self.assertIn("raise ValueError: negative value", err_thinking)
        vis = assistant_visible_text(exported_err["messages"][-1])
        comp = json.loads(vis.split("```json\n", 1)[1].split("\n```", 1)[0])
        self.assertEqual(comp["kind"], "throw")
        self.assertEqual(comp["value"], {"name": "ValueError", "message": "negative value"})

    def test_tracer_compaction_inserts_omission_marker(self):
        source = """\
def run(n):
    total = 0
    for i in range(n):
        total += i
    return total
"""
        tracer = create_python_tracer(source, entry_name="run", max_lines_per_turn=20, max_total_lines=20)
        code = compile(source, "<guest>", "exec")
        ns: dict = {}
        exec(code, ns)
        sys.settrace(tracer.trace_dispatch)
        try:
            res = ns["run"](100)
        finally:
            sys.settrace(None)
        self.assertEqual(res, 4950)
        turns = tracer.finalize()
        self.assertEqual(len(turns), 1)
        self.assertLessEqual(len(turns[0]), 20)
        self.assertTrue(any("steps omitted" in line for line in turns[0]))


class EffectfulPythonAndGradingTests(unittest.TestCase):
    def _workflow_task(self, task_id: str, kv_val: int, rand_val: float, ts: float) -> dict:
        source = """\
import random
import time

def run(state, key):
    base = host.kv_get(key)
    now = time.time()
    r = random.random()
    score = base + int(r * 10)
    print("score", score)
    if score >= 15:
        host.kv_set(key, score)
        state["updated"] = True
    else:
        state["updated"] = False
    state["ts"] = now
    return state
"""
        score = kv_val + int(rand_val * 10)
        calls = [
            {"operation": "kv_get", "arguments": ["alpha"], "result": kv_val},
            {"operation": "platform.time", "arguments": [], "result": ts},
            {"operation": "platform.random", "arguments": [], "result": rand_val},
            {"operation": "platform.print", "arguments": ["score", score], "result": None},
        ]
        if score >= 15:
            calls.append({"operation": "kv_set", "arguments": ["alpha", score], "result": True})
        return {
            "id": task_id,
            "family": "py-workflow",
            "language": "py",
            "source": source,
            "entry": "run",
            "args": [{"updated": None}, "alpha"],
            "randomMode": "tool",
            "fixture": {"calls": calls},
            "features": ["external", "branch"],
        }

    def test_multiturn_causal_trace_turns_and_zero_future_leakage(self):
        task_a = self._workflow_task("py-wf-high", kv_val=12, rand_val=0.5, ts=1700000001.0)
        task_b = self._workflow_task("py-wf-low", kv_val=4, rand_val=0.2, ts=1700000009.0)

        exp_a = export_python_example(task_a, trace_format="compact", reasoning_channel="thinking")
        exp_b = export_python_example(task_b, trace_format="compact", reasoning_channel="thinking")

        # Verify tool_declare comes strictly from public source and includes all 5 ops
        tool_decl = json.loads(exp_a["messages"][1]["content"])
        declared_names = sorted(t["function"]["name"] for t in tool_decl)
        self.assertEqual(
            declared_names,
            ["kv_get", "kv_set", "platform.print", "platform.random", "platform.time"],
        )

        # Verify zero future leakage: prefix up to first diverging tool observation (kv_get) must be IDENTICAL!
        audit = audit_python_supervision([exp_a, exp_b], {"formats": ["compact"], "samplePerFeature": 4})
        self.assertTrue(audit["valid"])
        self.assertTrue(audit["allReplayed"])
        self.assertGreaterEqual(audit["causalDivergencesChecked"], 1)

        # Explicitly verify turn-0 thinking contains no future values (12, 17, 1700000001)
        first_assistant = exp_a["messages"][3]
        self.assertEqual(first_assistant["role"], "assistant")
        first_thinking = assistant_thinking_text(first_assistant)
        self.assertNotIn("1700000001", first_thinking)
        self.assertNotIn("score = 17", first_thinking)

        # Verify prepared traceTurns length == dispatches + 1
        prep = prepare_python_task(task_a, trace_format="compact")
        self.assertEqual(len(prep["traceTurns"]), 6)  # 5 dispatches + 1 final

    def test_exact_failure_categories(self):
        task = self._workflow_task("py-wf-grade", kv_val=12, rand_val=0.5, ts=1700000001.0)
        prepared = prepare_python_task(task, trace_format="compact")

        # 1. malformed-action
        s = create_python_session(prepared)
        r = s.step("not valid json at all", 5)
        self.assertTrue(r["done"])
        self.assertFalse(r["grade"]["success"])
        self.assertEqual(r["grade"]["failureCategory"], "malformed-action")

        # 2. missing-external-effects (completing before calls)
        s = create_python_session(prepared)
        r = s.step(
            json.dumps({
                "type": "complete",
                "kind": "return",
                "arguments": [{"updated": True, "ts": 1700000001.0}, "alpha"],
                "value": {"$py": "ref", "path": "/arguments/0"},
            }),
            5,
        )
        self.assertTrue(r["done"])
        self.assertEqual(r["grade"]["failureCategory"], "missing-external-effects")

        # 3. incorrect-external-request (wrong args, must not leak observation)
        s = create_python_session(prepared)
        r = s.step(
            {"role": "assistant", "content": "", "tool_calls": [
                {"id": "c1", "type": "function", "function": {"name": "kv_get", "arguments": json.dumps({"arguments": ["wrong"]})}}
            ]},
            4,
        )
        self.assertTrue(r["done"])
        self.assertEqual(r["messages"], [])
        self.assertEqual(r["grade"]["failureCategory"], "incorrect-external-request")

        def run_all_calls(session):
            call_seq = [
                ("kv_get", ["alpha"]),
                ("platform.time", []),
                ("platform.random", []),
                ("platform.print", ["score", 17]),
                ("kv_set", ["alpha", 17]),
            ]
            tok = 0
            for idx, (op, cargs) in enumerate(call_seq, 1):
                tok += 5
                res = session.step(
                    {"role": "assistant", "content": "", "tool_calls": [
                        {"id": f"call_{idx}", "type": "function", "function": {"name": op, "arguments": json.dumps({"arguments": cargs})}}
                    ]},
                    tok,
                )
                self.assertFalse(res["done"])
            return tok

        # 4. mutation-mismatch
        s = create_python_session(prepared)
        tok = run_all_calls(s)
        r = s.step(
            json.dumps({
                "type": "complete",
                "kind": "return",
                "arguments": [{"updated": False, "ts": 1700000001.0}, "alpha"],
                "value": {"$py": "ref", "path": "/arguments/0"},
            }),
            tok + 5,
        )
        self.assertFalse(r["grade"]["success"])
        self.assertEqual(r["grade"]["failureCategory"], "mutation-mismatch")

        # 5. alias-mismatch (right values, but return value is a copy instead of ref to /arguments/0)
        s = create_python_session(prepared)
        tok = run_all_calls(s)
        r = s.step(
            json.dumps({
                "type": "complete",
                "kind": "return",
                "arguments": [{"updated": True, "ts": 1700000001.0}, "alpha"],
                "value": {"updated": True, "ts": 1700000001.0},
            }),
            tok + 5,
        )
        self.assertFalse(r["grade"]["success"])
        self.assertEqual(r["grade"]["failureCategory"], "alias-mismatch")

        # 6. wrong-return
        s = create_python_session(prepared)
        tok = run_all_calls(s)
        r = s.step(
            json.dumps({
                "type": "complete",
                "kind": "return",
                "arguments": [{"updated": True, "ts": 1700000001.0}, "alpha"],
                "value": 999,
            }),
            tok + 5,
        )
        self.assertFalse(r["grade"]["success"])
        self.assertEqual(r["grade"]["failureCategory"], "wrong-return")

        # 7. wrong-completion-kind
        s = create_python_session(prepared)
        tok = run_all_calls(s)
        r = s.step(
            json.dumps({
                "type": "complete",
                "kind": "throw",
                "arguments": [{"updated": True, "ts": 1700000001.0}, "alpha"],
                "value": {"name": "RuntimeError", "message": "oops"},
            }),
            tok + 5,
        )
        self.assertFalse(r["grade"]["success"])
        self.assertEqual(r["grade"]["failureCategory"], "wrong-completion-kind")

        # 8. exact success
        s = create_python_session(prepared)
        tok = run_all_calls(s)
        r = s.step(
            json.dumps({
                "type": "complete",
                "kind": "return",
                "arguments": [{"updated": True, "ts": 1700000001.0}, "alpha"],
                "value": {"$py": "ref", "path": "/arguments/0"},
            }),
            tok + 5,
        )
        self.assertTrue(r["grade"]["success"])
        self.assertIsNone(r["grade"]["failureCategory"])


@unittest.skipUnless(shutil.which("node"), "Node is required for mixed JS+Python Bridge tests")
class MixedLanguageBridgeTests(unittest.TestCase):
    def test_lazy_python_spawn_and_mixed_js_python_lifecycle(self):
        js_task = {
            "id": "mix-js-1",
            "family": "mix-js",
            "language": "js",
            "source": "function run(obj){obj.n+=1;return obj;}",
            "entry": "run",
            "args": [{"n": 4}],
            "fixture": {"calls": []},
        }
        py_task = {
            "id": "mix-py-1",
            "family": "mix-py",
            "language": "py",
            "source": "def run(items, k):\n    v = host.kv_get(k)\n    items.append(v)\n    return items\n",
            "entry": "run",
            "args": [[1, 2], "num"],
            "fixture": {"calls": [{"operation": "kv_get", "arguments": ["num"], "result": 99}]},
        }

        with Bridge(REPO, timeout=60) as bridge:
            # Before any py task, _py_worker must NOT be spawned (zero JS overhead).
            self.assertIsNone(bridge._py_worker)
            js_exp = bridge.request("export", task=js_task, traceFormat="compact", reasoningChannel="thinking")
            self.assertEqual(js_exp["schema"], "readable-js-execution/1")
            self.assertIsNone(bridge._py_worker)

            # First py task lazily spawns Python bridge.
            py_exp = bridge.request("export", task=py_task, traceFormat="compact", reasoningChannel="thinking")
            self.assertIsNotNone(bridge._py_worker)
            self.assertEqual(py_exp["schema"], TINKER_PY_EXECUTION_SCHEMA)
            self.assertTrue(py_exp["metadata"]["traceAudit"]["replayVerified"])

            # Interleaved live sessions for JS and Python simultaneously!
            js_start = bridge.request("start", task=js_task)
            py_start = bridge.request("start", task=py_task)
            js_sid = js_start["sessionId"]
            py_sid = py_start["sessionId"]

            # Step Python tool call
            py_step1 = bridge.request(
                "step",
                sessionId=py_sid,
                action={
                    "role": "assistant",
                    "content": "",
                    "tool_calls": [{
                        "id": "call_1",
                        "type": "function",
                        "function": {"name": "kv_get", "arguments": json.dumps({"arguments": ["num"]})},
                    }],
                },
                generatedTokens=10,
            )
            self.assertFalse(py_step1["done"])
            self.assertEqual(json.loads(py_step1["messages"][0]["content"]), {"status": "fulfilled", "value": 99})

            # Complete JS session
            js_step = bridge.request(
                "step",
                sessionId=js_sid,
                action=json.dumps({
                    "type": "complete",
                    "kind": "return",
                    "arguments": [{"n": 5}],
                    "value": {"$js": "ref", "path": "/arguments/0"},
                }),
                generatedTokens=12,
            )
            self.assertTrue(js_step["done"])
            self.assertTrue(js_step["grade"]["success"])
            js_grade = bridge.request("grade", sessionId=js_sid, totalGeneratedTokens=12)
            self.assertTrue(js_grade["success"])

            # Complete Python session
            py_step2 = bridge.request(
                "step",
                sessionId=py_sid,
                action=json.dumps({
                    "type": "complete",
                    "kind": "return",
                    "arguments": [[1, 2, 99], "num"],
                    "value": {"$py": "ref", "path": "/arguments/0"},
                }),
                generatedTokens=22,
            )
            self.assertTrue(py_step2["done"])
            self.assertTrue(py_step2["grade"]["success"])
            py_grade = bridge.request("grade", sessionId=py_sid, totalGeneratedTokens=22)
            self.assertTrue(py_grade["success"])

            # Close both sessions cleanly
            self.assertEqual(bridge.request("close", sessionId=js_sid), {"closed": True})
            self.assertEqual(bridge.request("close", sessionId=py_sid), {"closed": True})

        self.assertIsNone(bridge._py_worker)

    def test_implementation_identity_tracks_python_execution_files(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            (root / "training/tinker_py").mkdir(parents=True)
            (root / "tools").mkdir(parents=True)
            codec_file = root / "training/tinker_py/codec.py"
            worker_file = root / "tools/python-reference-worker.py"
            bridge_file = root / "tools/tinker-execution-py.py"
            codec_file.write_text("# v1\n")
            worker_file.write_text("# v1\n")
            bridge_file.write_text("# v1\n")

            id1 = implementation_identity(root)
            codec_file.write_text("# v2\n")
            id2 = implementation_identity(root)
            worker_file.write_text("# v2\n")
            id3 = implementation_identity(root)
            bridge_file.write_text("# v2\n")
            id4 = implementation_identity(root)

            self.assertEqual(len({id1["hash"], id2["hash"], id3["hash"], id4["hash"]}), 4)


class PythonHarvesterTests(unittest.TestCase):
    def test_harvest_local_multifile_repo_with_unit_tests_and_effects(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            repos_dir = root / "repos"
            repo = repos_dir / "sample_algo_lib"
            (repo / "pkg").mkdir(parents=True)
            (repo / "tests").mkdir(parents=True)
            out_dir = root / "out"

            (repo / "pkg" / "__init__.py").write_text("", encoding="utf-8")
            (repo / "pkg" / "helpers.py").write_text(
                """\
SCALE = 2

def normalize_token(word):
    cleaned = word.strip().lower()
    if not cleaned:
        return ""
    return cleaned * SCALE if len(cleaned) == 1 else cleaned
""",
                encoding="utf-8",
            )
            (repo / "pkg" / "algo.py").write_text(
                """\
import random
import time
from .helpers import normalize_token
import nonexistent_third_party_pkg

def count_normalized_words(words, min_len):
    \"\"\"Count normalized tokens with length >= min_len.\"\"\"
    counts = {}
    for raw in words:
        tok = normalize_token(raw)
        if len(tok) >= min_len:
            counts[tok] = counts.get(tok, 0) + 1
    ordered = sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))
    return ordered

def sample_audit_score(label, base):
    \"\"\"Compute a timestamped randomized audit score and log it.\"\"\"
    ts = time.time()
    jitter = int(random.random() * 100)
    total = base + jitter
    print(label, total)
    return {"label": label, "total": total, "ts": ts}

def uses_missing_pkg(x):
    return nonexistent_third_party_pkg.transform(x)
""",
                encoding="utf-8",
            )
            (repo / "tests" / "test_algo.py").write_text(
                """\
from pkg.algo import count_normalized_words, sample_audit_score

SAMPLE_WORDS = ["Apple", " banana ", "apple", "x", "BANANA", "apple"]

def test_count_normalized_words():
    res = count_normalized_words(SAMPLE_WORDS, 3)
    assert res[0] == ("apple", 3)
    res2 = count_normalized_words(["Red", "Blue", "red"], 2)
    assert len(res2) == 2

def test_sample_audit_score():
    entry = sample_audit_score("nightly-check", 50)
    assert entry["label"] == "nightly-check"
""",
                encoding="utf-8",
            )

            proc = subprocess.run(
                [
                    sys.executable,
                    str(REPO / "tools/tinker-harvest-py.py"),
                    "--local-repos",
                    str(repos_dir),
                    "--output-dir",
                    str(out_dir),
                    "--jobs",
                    "2",
                    "--max-per-repo",
                    "20",
                    "--max-per-fn",
                    "3",
                    "--min-source-chars",
                    "100",
                    "--max-source-chars",
                    "35000",
                ],
                capture_output=True,
                text=True,
                timeout=60,
                check=False,
            )
            self.assertEqual(proc.returncode, 0, msg=f"stderr={proc.stderr}\nstdout={proc.stdout}")

            harvested_path = out_dir / "harvested.jsonl"
            census_path = out_dir / "census.json"
            self.assertTrue(harvested_path.is_file())
            self.assertTrue(census_path.is_file())

            rows = [json.loads(line) for line in harvested_path.read_text(encoding="utf-8").splitlines() if line.strip()]
            census = json.loads(census_path.read_text(encoding="utf-8"))

            self.assertGreaterEqual(len(rows), 3)
            self.assertEqual(census["admittedUnique"], len(rows))
            self.assertGreaterEqual(census["unitTestInputAdmitted"], 3)
            self.assertGreaterEqual(census["effectfulAdmitted"], 1)

            entries = {r["entry"] for r in rows}
            self.assertIn("count_normalized_words", entries)
            self.assertIn("sample_audit_score", entries)
            self.assertNotIn("uses_missing_pkg", entries)

            # Check real unit-test-input tagging & local helper inlining
            word_tasks = [r for r in rows if r["entry"] == "count_normalized_words"]
            self.assertTrue(any("unit-test-input" in r["features"] for r in word_tasks))
            self.assertTrue(any("SAMPLE_WORDS" not in r["source"] and r["args"][1] == 3 for r in word_tasks))

            # Check print/time/random auto-recording + compact trace export audit
            audit_tasks = [r for r in rows if r["entry"] == "sample_audit_score" and "unit-test-input" in r["features"]]
            self.assertGreaterEqual(len(audit_tasks), 1)
            atask = audit_tasks[0]
            self.assertEqual(atask["randomMode"], "tool")
            ops = [c["operation"] for c in atask["fixture"]["calls"]]
            self.assertEqual(ops, ["platform.time", "platform.random", "platform.print"])

            # Re-verify through export_python_example with compact trace
            re_exported = export_python_example(atask, trace_format="compact", reasoning_channel="thinking")
            self.assertTrue(re_exported["metadata"]["traceAudit"]["replayVerified"])
            self.assertGreater(re_exported["metadata"]["traceAudit"]["narrationLines"], 0)


if __name__ == "__main__":
    unittest.main()
