"""Comprehensive tests for native Python execution, sys.settrace compact tracing,
mixed-language Bridge dispatch, and the Python OSS/unit-test harvester.
"""

from __future__ import annotations

import copy
from dataclasses import dataclass
import datetime
from decimal import Decimal
import enum
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import io
import json
import math
import os
from pathlib import Path, PurePosixPath
import shutil
import subprocess
import sys
import tempfile
import threading
from types import SimpleNamespace
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
    _scan_public_source_tools,
    assistant_thinking_text,
    assistant_visible_text,
    audit_python_conversation,
    audit_python_supervision,
    create_python_session,
    export_python_example,
    initial_messages,
    prepare_python_task,
)
from tinker_py.tracer import _format_value, create_python_tracer

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


class _SlotOnlyObject:
    __slots__ = ("x",)

    def __init__(self, x: int = 1) -> None:
        self.x = x


class _SampleColor(enum.Enum):
    RED = 1
    BLUE = 2


class _SampleIntEnum(enum.IntEnum):
    FAST = 10


class _SampleNode:
    def __init__(self, val: Any) -> None:
        self.val = val
        self.next: Any = None


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
        for bad in (lambda x: x, math, (x for x in range(3)), io.StringIO("x"), object(), _SlotOnlyObject()):
            with self.assertRaises(TypeError):
                encode_readable(bad)
            with self.assertRaises(TypeError):
                describe_graph([bad])

        # Plain custom class instances (including hostile dunders!) encode cleanly without calling __repr__/__str__/__eq__
        h_empty = _HostileObject()
        self.assertEqual(encode_readable(h_empty), {"$py": "object", "class": "_HostileObject", "attrs": {}})
        h_data = _HostileObject()
        h_data.x = 42
        h_data.tag = "ok"
        enc_h = encode_readable(h_data)
        self.assertEqual(enc_h, {"$py": "object", "class": "_HostileObject", "attrs": {"x": 42, "tag": "ok"}})
        dec_h = decode_readable(enc_h)
        self.assertEqual((dec_h.x, dec_h.tag), (42, "ok"))
        self.assertEqual(describe_graph([h_data]), describe_graph([dec_h]))

        # Depth budget guard
        deep: list = []
        cur = deep
        for _ in range(70):
            nxt: list = []
            cur.append(nxt)
            cur = nxt
        with self.assertRaises(TypeError):
            encode_readable(deep)

    def test_rich_python_boundary_types_roundtrip_and_graph_equivalence(self):
        dt_naive = datetime.datetime(2026, 11, 26, 15, 30, 45, 123456)
        dt_utc = datetime.datetime(2026, 11, 26, 15, 30, 45, tzinfo=datetime.timezone.utc)
        d_only = datetime.date(2026, 11, 26)
        td_pos = datetime.timedelta(days=3, seconds=42, microseconds=99)
        td_neg = datetime.timedelta(seconds=-5, microseconds=12)
        dec_scale = Decimal("12.3400")
        dec_neg_zero = Decimal("-0")
        dec_inf = Decimal("Infinity")
        dec_nan = Decimal("NaN")
        p_obj = Path("sub/dir/file.txt")
        pure_p = PurePosixPath("sub/dir/file.txt")
        fs = frozenset({1, (2, 3), _SampleColor.RED, d_only, p_obj})
        c_val = complex(3.5, -2.25)
        c_special = complex(-0.0, float("nan"))

        node_a = _SampleNode("head")
        node_a.next = node_a  # cyclic plain custom object
        ns_obj = SimpleNamespace(flag=True, items=[node_a])
        escaped_obj = SimpleNamespace()
        setattr(escaped_obj, "$py", "literal")

        payload = {
            "dt_naive": dt_naive,
            "dt_utc": dt_utc,
            "d_only": d_only,
            "td_pos": td_pos,
            "td_neg": td_neg,
            "dec_scale": dec_scale,
            "dec_neg_zero": dec_neg_zero,
            "dec_inf": dec_inf,
            "dec_nan": dec_nan,
            "path": p_obj,
            "pure_path": pure_p,
            "frozenset": fs,
            "complex": c_val,
            "complex_special": c_special,
            "enum": _SampleColor.BLUE,
            "int_enum": _SampleIntEnum.FAST,
            "node_alias": node_a,
            "ns": ns_obj,
            "escaped_obj": escaped_obj,
        }

        encoded = encode_readable(payload)
        self.assertEqual(encoded["dt_naive"], {"$py": "datetime", "iso": dt_naive.isoformat()})
        self.assertEqual(encoded["dt_utc"], {"$py": "datetime", "iso": dt_utc.isoformat()})
        self.assertEqual(encoded["d_only"], {"$py": "date", "iso": "2026-11-26"})
        self.assertEqual(encoded["td_pos"], {"$py": "timedelta", "days": 3, "seconds": 42, "microseconds": 99})
        self.assertEqual(encoded["dec_scale"], {"$py": "decimal", "value": "12.3400"})
        self.assertEqual(encoded["path"], {"$py": "path", "value": "sub/dir/file.txt"})
        self.assertEqual(encoded["frozenset"]["$py"], "frozenset")
        self.assertEqual(encoded["complex"], {"$py": "complex", "real": 3.5, "imag": -2.25})
        self.assertEqual(encoded["complex_special"], {"$py": "complex", "real": {"$py": "-0"}, "imag": {"$py": "NaN"}})
        self.assertEqual(encoded["enum"], {"$py": "enum", "class": "_SampleColor", "name": "BLUE", "value": 2})
        self.assertEqual(encoded["int_enum"], {"$py": "enum", "class": "_SampleIntEnum", "name": "FAST", "value": 10})
        self.assertEqual(encoded["node_alias"]["$py"], "object")
        self.assertEqual(encoded["node_alias"]["attrs"]["next"], {"$py": "ref", "path": "/node_alias"})
        self.assertEqual(encoded["ns"]["attrs"]["items"][0], {"$py": "ref", "path": "/node_alias"})

        decoded = decode_readable(encoded)
        self.assertEqual(decoded["dt_naive"], dt_naive)
        self.assertEqual(decoded["dt_utc"], dt_utc)
        self.assertEqual(decoded["d_only"], d_only)
        self.assertEqual(decoded["td_pos"], td_pos)
        self.assertEqual(decoded["td_neg"], td_neg)
        self.assertEqual(str(decoded["dec_scale"]), "12.3400")
        self.assertEqual(str(decoded["dec_neg_zero"]), "-0")
        self.assertTrue(decoded["dec_inf"].is_infinite())
        self.assertTrue(decoded["dec_nan"].is_nan())
        self.assertEqual(decoded["path"], Path("sub/dir/file.txt"))
        self.assertIsInstance(decoded["frozenset"], frozenset)
        self.assertEqual(decoded["complex"], c_val)
        self.assertLess(math.copysign(1.0, decoded["complex_special"].real), 0.0)
        self.assertTrue(math.isnan(decoded["complex_special"].imag))
        self.assertIsInstance(decoded["enum"], enum.Enum)
        self.assertEqual((decoded["enum"].name, decoded["enum"].value), ("BLUE", 2))
        self.assertIs(decoded["node_alias"].next, decoded["node_alias"])
        self.assertIs(decoded["ns"].items[0], decoded["node_alias"])
        self.assertEqual(getattr(decoded["escaped_obj"], "$py"), "literal")

        graph = describe_graph([payload])
        self.assertEqual(graph, describe_graph([decoded]))
        realized = realize_graph(graph)
        self.assertEqual(graph, describe_graph(realized))
        self.assertIs(realized[0]["node_alias"].next, realized[0]["node_alias"])
        self.assertIs(realized[0]["ns"].items[0], realized[0]["node_alias"])

        # Type distinctions across new types
        self.assertNotEqual(describe_graph([dt_naive]), describe_graph([dt_utc]))
        self.assertNotEqual(describe_graph([dt_naive]), describe_graph([dt_naive.isoformat()]))
        self.assertNotEqual(describe_graph([d_only]), describe_graph([datetime.datetime(2026, 11, 26, 0, 0)]))
        self.assertNotEqual(describe_graph([Decimal("1.2")]), describe_graph([Decimal("1.20")]))
        self.assertNotEqual(describe_graph([Decimal("1.2")]), describe_graph([1.2]))
        self.assertNotEqual(describe_graph([frozenset({1, 2})]), describe_graph([{1, 2}]))
        self.assertNotEqual(describe_graph([SimpleNamespace(x=1)]), describe_graph([{"x": 1}]))


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

    def test_get_stats_rich_container_trace_and_audit(self):
        source = """\
def get_stats(ids):
    counts = {}
    for pair in zip(ids, ids[1:]):
        counts[pair] = counts.get(pair, 0) + 1
    return counts
"""
        task = {
            "id": "py-get-stats-1",
            "family": "py-bpe-stats",
            "language": "py",
            "source": source,
            "entry": "get_stats",
            "args": [[1, 2, 3, 1, 2]],
            "fixture": {"calls": []},
        }
        prepared = prepare_python_task(task, trace_format="compact")
        exported = export_python_example(task, trace_format="compact", reasoning_channel="thinking")
        audit = audit_python_conversation(
            prepared,
            exported["messages"],
            trace_format="compact",
            reasoning_channel="thinking",
        )
        self.assertTrue(audit["replayVerified"])
        self.assertTrue(audit["canonicalCausalNarration"])

        thinking = assistant_thinking_text(exported["messages"][-1])
        lines = thinking.splitlines()
        self.assertIn("counts = {}", lines)
        self.assertIn("pair = (1, 2)", lines)
        self.assertIn("counts = {(1, 2): 1}", lines)
        self.assertIn("counts = {(1, 2): 1, (2, 3): 1}", lines)
        self.assertIn("counts = {(1, 2): 1, (2, 3): 1, (3, 1): 1}", lines)
        self.assertIn("counts = {(1, 2): 2, (2, 3): 1, (3, 1): 1}", lines)
        self.assertIn("return {(1, 2): 2, (2, 3): 1, (3, 1): 1}", lines)

    def test_poison_objects_and_container_subclasses_never_invoke_dunders(self):
        source = """\
class PoisonObj:
    def __repr__(self):
        raise AssertionError("boom __repr__")
    def __str__(self):
        raise AssertionError("boom __str__")
    def __eq__(self, other):
        raise AssertionError("boom __eq__")

class PoisonList(list):
    def __iter__(self):
        raise AssertionError("boom PoisonList.__iter__")
    def __getitem__(self, idx):
        raise AssertionError("boom PoisonList.__getitem__")
    def __repr__(self):
        raise AssertionError("boom PoisonList.__repr__")

class PoisonDict(dict):
    def __iter__(self):
        raise AssertionError("boom PoisonDict.__iter__")
    def items(self):
        raise AssertionError("boom PoisonDict.items")
    def __getitem__(self, key):
        raise AssertionError("boom PoisonDict.__getitem__")
    def __repr__(self):
        raise AssertionError("boom PoisonDict.__repr__")

def run(x):
    p = PoisonObj()
    pl = PoisonList([1, 2, 3])
    pd = PoisonDict({"k": 9})
    box = [p, pl, pd, x]
    box.append(x + 1)
    return len(box)
"""
        task = {
            "id": "py-poison-subclasses",
            "family": "py-poison",
            "language": "py",
            "source": source,
            "entry": "run",
            "args": [7],
            "fixture": {"calls": []},
        }
        exported = export_python_example(task, trace_format="compact", reasoning_channel="thinking")
        self.assertTrue(exported["metadata"]["traceAudit"]["replayVerified"])
        thinking = assistant_thinking_text(exported["messages"][-1])
        self.assertIn("p -> PoisonObj", thinking)
        self.assertIn("pl -> PoisonList", thinking)
        self.assertIn("pd -> PoisonDict", thinking)
        self.assertIn("box = [<PoisonObj>, <PoisonList>, <PoisonDict>, 7]", thinking)
        self.assertIn("box = [<PoisonObj>, <PoisonList>, <PoisonDict>, 7, 8]", thinking)
        self.assertIn("return 5", thinking)

    def test_cyclic_containers_and_format_value_bounds(self):
        source = """\
def run():
    a = []
    a.append(a)
    d = {}
    d["self"] = d
    return (a, d)
"""
        tracer = create_python_tracer(source, entry_name="run")
        code = compile(source, "<guest>", "exec")
        ns: dict = {}
        exec(code, ns)
        sys.settrace(tracer.trace_dispatch)
        try:
            res = ns["run"]()
        finally:
            sys.settrace(None)
        self.assertIs(res[0][0], res[0])
        self.assertIs(res[1]["self"], res[1])
        turns = tracer.finalize()
        self.assertEqual(len(turns), 1)
        joined = "\n".join(turns[0])
        self.assertIn("a = [<...>]", joined)
        self.assertIn("d = {'self': <...>}", joined)
        self.assertIn("return ([<...>], {'self': <...>})", joined)

        # Direct _format_value bounds & edge cases
        self.assertEqual(_format_value((42,)), "(42,)")
        self.assertEqual(_format_value(b"\xde\xad\xbe\xef"), "bytes(4:deadbeef)")
        self.assertEqual(_format_value({3, 1, 2}), "{1, 2, 3}")
        self.assertEqual(_format_value(frozenset({"b", "a"})), "frozenset({'a', 'b'})")
        self.assertTrue(_format_value(list(range(20))).endswith(", ...]"))
        self.assertLessEqual(len(_format_value(["x" * 60] * 10)), 120)
        self.assertTrue(_format_value("a" * 200).endswith("...'"))
        # Inside container, string truncated at 80 chars
        inner_str = _format_value(["b" * 120], max_chars=200)
        self.assertIn("...", inner_str)
        self.assertLess(len(inner_str), 100)

    def test_unicode_line_separators_and_isolated_cwd(self):
        source = """\
def run(text):
    sep = "\\u2028\\u2029"
    with open("should_stay_in_tmpdir.txt", "w", encoding="utf-8") as fh:
        fh.write("ok")
    return text + sep
"""
        task = {
            "id": "py-u2028-1",
            "family": "py-u2028",
            "language": "py",
            "source": source,
            "entry": "run",
            "args": ["lineA\u2028lineB"],
            "fixture": {
                "calls": [
                    {
                        "operation": "fs.writeText",
                        "arguments": ["should_stay_in_tmpdir.txt", "ok"],
                        "status": "fulfilled",
                        "result": None,
                    }
                ]
            },
        }
        leaked = Path.cwd() / "should_stay_in_tmpdir.txt"
        self.assertFalse(leaked.exists())
        exported = export_python_example(task, trace_format="compact", reasoning_channel="thinking")
        self.assertFalse(leaked.exists())
        self.assertTrue(exported["metadata"]["traceAudit"]["replayVerified"])
        vis = assistant_visible_text(exported["messages"][-1])
        comp = json.loads(vis.split("```json\n", 1)[1].split("\n```", 1)[0])
        self.assertEqual(comp["kind"], "return")
        self.assertEqual(comp["value"], "lineA\u2028lineB\u2028\u2029")


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

        # Verify tool_declare comes strictly from public source and includes all 5 ops,
        # and every tool (including 0-arg platform.time / platform.random) requires ["arguments"].
        tool_decl = json.loads(exp_a["messages"][1]["content"])
        declared_names = sorted(t["function"]["name"] for t in tool_decl)
        self.assertEqual(
            declared_names,
            ["kv_get", "kv_set", "platform.print", "platform.random", "platform.time"],
        )
        for decl in tool_decl:
            self.assertEqual(decl["function"]["parameters"]["required"], ["arguments"])

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

    def test_scan_public_source_tools_detects_datetime_today_and_requires_arguments(self):
        # 1. Exact waditu__tushare last_tddate pattern (datetime.datetime.today())
        tushare_src = (
            "import datetime\n\n"
            "def day_last_week(days=-7):\n"
            "    lasty = datetime.datetime.today().date() + datetime.timedelta(days)\n"
            "    return str(lasty)\n\n"
            "def last_tddate():\n"
            "    today = datetime.datetime.today().date()\n"
            "    today = int(today.strftime('%w'))\n"
            "    if today == 0:\n"
            "        return day_last_week(-2)\n"
            "    return day_last_week(-1)\n"
        )
        ops, uses_rand = _scan_public_source_tools(tushare_src, "seeded", [])
        self.assertEqual(ops, ["platform.time"])
        self.assertFalse(uses_rand)

        task = {
            "id": "py-datetime-today-test",
            "family": "py-datetime-today",
            "language": "py",
            "source": tushare_src,
            "entry": "last_tddate",
            "args": [],
            "fixture": {
                "calls": [
                    {"operation": "platform.time", "arguments": [], "status": "fulfilled", "result": 1700000000.0},
                    {"operation": "platform.time", "arguments": [], "status": "fulfilled", "result": 1700000000.25},
                ]
            },
        }
        exported = export_python_example(task, trace_format="compact")
        self.assertTrue(exported["metadata"]["traceAudit"]["replayVerified"])
        tool_decl = json.loads(exported["messages"][1]["content"])
        self.assertEqual([d["function"]["name"] for d in tool_decl], ["platform.time"])
        self.assertEqual(tool_decl[0]["function"]["parameters"]["required"], ["arguments"])

        # 2. Aliases and direct from-imports for datetime.today() / date.today()
        for src in (
            "import datetime as dt\ndef run(): return dt.date.today().isoformat()\n",
            "from datetime import datetime\ndef run(): return datetime.today().year\n",
            "from datetime import date as d\ndef run(): return d.today().day\n",
        ):
            detected, _ = _scan_public_source_tools(src, "seeded", [])
            self.assertEqual(detected, ["platform.time"], src)

        # 3. datetime.now() and datetime.utcnow() ARE intercepted and declare platform.time,
        #    while pure datetime.datetime(2026, 1, 1) constructor does NOT declare platform.time.
        now_src = "import datetime\ndef run(): return datetime.datetime.now().year\n"
        now_ops, _ = _scan_public_source_tools(now_src, "seeded", [])
        self.assertEqual(now_ops, ["platform.time"])
        pure_dt_src = "import datetime\ndef run(): return datetime.datetime(2026, 1, 1).year\n"
        pure_dt_ops, _ = _scan_public_source_tools(pure_dt_src, "seeded", [])
        self.assertEqual(pure_dt_ops, [])

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

    def test_harvester_v2_filters_parametrize_aliases_and_priority(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            repos_dir = root / "repos"
            repo = repos_dir / "v2_quality_lib"
            (repo / "pkg").mkdir(parents=True)
            (repo / "tests").mkdir(parents=True)

            (repo / "pkg" / "__init__.py").write_text("", encoding="utf-8")
            # Alphabetically first module: synthetic-probe-only functions, including a
            # trivial 1-line constant return and a function whose first line hits TypeError
            # (caught) on mismatched synthetic probe args.
            (repo / "pkg" / "a_probes.py").write_text(
                """\
def trivial_constant(x):
    \"\"\"Trivial single-line return that should be dropped by --min-trace-lines 4.\"\"\"
    return 42

def caught_first_line_type_error(x):
    \"\"\"Raises TypeError on first line when passed an int/list/str/dict probe and catches it.\"\"\"
    try:
        return x() + 1
    except TypeError:
        acc = 0
        for i in range(4):
            acc += i
        return acc

def probe_only_loop(nums):
    \"\"\"Multi-step function with no unit tests (only synthetic probes).\"\"\"
    total = 0
    for val in nums:
        if isinstance(val, int):
            total += val * 2
    return total
""",
                encoding="utf-8",
            )
            # Alphabetically later module: real unit-tested functions using aliases,
            # @pytest.mark.parametrize, self.assertEqual, and pytest.raises(TypeError, ...).
            (repo / "pkg" / "z_tested.py").write_text(
                """\
def pair_score(items, scale):
    \"\"\"Accumulate adjacent pair sums scaled by a factor.\"\"\"
    out = []
    for a, b in zip(items, items[1:]):
        out.append((a + b) * scale)
    return out

def strict_positive_sum(nums):
    \"\"\"Sum positive integers; raises TypeError on non-list or non-int element.\"\"\"
    if not isinstance(nums, list):
        raise TypeError("nums must be a list")
    total = 0
    for v in nums:
        if not isinstance(v, int):
            raise TypeError("element must be int")
        if v > 0:
            total += v
    return total
""",
                encoding="utf-8",
            )
            (repo / "tests" / "test_z_tested.py").write_text(
                """\
import unittest
import pytest
from pkg.z_tested import pair_score as ps, strict_positive_sum as sps

@pytest.mark.parametrize("seq,factor,expected", [
    ([1, 2, 3, 4], 2, [6, 10, 14]),
    ([5, 1, 2], 3, [18, 9]),
])
def test_pair_score_parametrized(seq, factor, expected):
    assert ps(seq, factor) == expected

class StrictTests(unittest.TestCase):
    def test_strict_positive_and_type_error(self):
        self.assertEqual(sps([1, -2, 3, 4]), 8)
        pytest.raises(TypeError, sps, [1, "bad", 3])
        pytest.raises(TypeError, sps, "not-a-list")
""",
                encoding="utf-8",
            )

            # 1. Default run with --min-trace-lines 4 and --drop-probe-type-errors (default True)
            #    and --max-per-repo 4 to verify py-unit-test priority over a_probes.py!
            out_default = root / "out_default"
            proc = subprocess.run(
                [
                    sys.executable,
                    str(REPO / "tools/tinker-harvest-py.py"),
                    "--local-repos",
                    str(repos_dir),
                    "--output-dir",
                    str(out_default),
                    "--jobs",
                    "2",
                    "--max-per-repo",
                    "4",
                    "--max-per-fn",
                    "3",
                    "--min-source-chars",
                    "50",
                    "--min-trace-lines",
                    "4",
                ],
                capture_output=True,
                text=True,
                timeout=60,
                check=False,
            )
            self.assertEqual(proc.returncode, 0, msg=f"stderr={proc.stderr}\nstdout={proc.stdout}")
            rows = [
                json.loads(line)
                for line in (out_default / "harvested.jsonl").read_text(encoding="utf-8").splitlines()
                if line.strip()
            ]
            census = json.loads((out_default / "census.json").read_text(encoding="utf-8"))

            # All 4 slots should be filled by the 4 real py-unit-test inputs from z_tested.py
            # with >= 4 trace lines (2 parametrized pair_score + 1 valid strict_positive_sum
            # + 1 pytest.raises TypeError on [1, "bad", 3]), beating synthetic probes from
            # alphabetically earlier a_probes.py!
            self.assertEqual(len(rows), 4)
            self.assertEqual(census["unitTestInputAdmitted"], 4)
            entries = [r["entry"] for r in rows]
            self.assertEqual(entries.count("pair_score"), 2)
            self.assertEqual(entries.count("strict_positive_sum"), 2)
            self.assertNotIn("trivial_constant", entries)
            self.assertNotIn("caught_first_line_type_error", entries)

            # Verify the genuine unit-test TypeError case from pytest.raises was kept!
            sps_args = [r["args"] for r in rows if r["entry"] == "strict_positive_sum"]
            self.assertIn([[1, "bad", 3]], sps_args)
            self.assertIn([[1, -2, 3, 4]], sps_args)

            # Verify --min-trace-lines 4 was enforced on every admitted task
            for r in rows:
                self.assertGreaterEqual(r["metadata"]["narrationLines"], 4)

            # 2. Run with higher --max-per-repo so synthetic probes are also evaluated,
            #    verifying trivial_constant (too few trace lines) and caught_first_line_type_error
            #    (first trace line is raise TypeError on synthetic probe) are both rejected.
            out_wide = root / "out_wide"
            proc_wide = subprocess.run(
                [
                    sys.executable,
                    str(REPO / "tools/tinker-harvest-py.py"),
                    "--local-repos",
                    str(repos_dir),
                    "--output-dir",
                    str(out_wide),
                    "--jobs",
                    "2",
                    "--max-per-repo",
                    "20",
                    "--max-per-fn",
                    "3",
                    "--min-source-chars",
                    "50",
                    "--min-trace-lines",
                    "4",
                    "--drop-probe-type-errors",
                ],
                capture_output=True,
                text=True,
                timeout=60,
                check=False,
            )
            self.assertEqual(proc_wide.returncode, 0, msg=f"stderr={proc_wide.stderr}\nstdout={proc_wide.stdout}")
            wide_rows = [
                json.loads(line)
                for line in (out_wide / "harvested.jsonl").read_text(encoding="utf-8").splitlines()
                if line.strip()
            ]
            wide_entries = {r["entry"] for r in wide_rows}
            self.assertIn("probe_only_loop", wide_entries)
            self.assertNotIn("trivial_constant", wide_entries)
            self.assertNotIn("caught_first_line_type_error", wide_entries)

            # 2b. With --min-trace-lines 0 and --drop-probe-type-errors, the short genuine
            #     unit-test TypeError ("not-a-list") IS kept while synthetic probe TypeErrors
            #     (caught_first_line_type_error) remain dropped!
            out_short_ut = root / "out_short_ut"
            proc_short_ut = subprocess.run(
                [
                    sys.executable,
                    str(REPO / "tools/tinker-harvest-py.py"),
                    "--local-repos",
                    str(repos_dir),
                    "--output-dir",
                    str(out_short_ut),
                    "--jobs",
                    "2",
                    "--max-per-repo",
                    "20",
                    "--max-per-fn",
                    "3",
                    "--min-source-chars",
                    "50",
                    "--min-trace-lines",
                    "0",
                    "--drop-probe-type-errors",
                ],
                capture_output=True,
                text=True,
                timeout=60,
                check=False,
            )
            self.assertEqual(proc_short_ut.returncode, 0, msg=f"stderr={proc_short_ut.stderr}\nstdout={proc_short_ut.stdout}")
            short_ut_rows = [
                json.loads(line)
                for line in (out_short_ut / "harvested.jsonl").read_text(encoding="utf-8").splitlines()
                if line.strip()
            ]
            short_sps_args = [r["args"] for r in short_ut_rows if r["entry"] == "strict_positive_sum"]
            self.assertIn(["not-a-list"], short_sps_args)
            self.assertNotIn("caught_first_line_type_error", {r["entry"] for r in short_ut_rows})

            # 3. Verify --keep-probe-type-errors allows caught_first_line_type_error through.
            out_keep = root / "out_keep"
            proc_keep = subprocess.run(
                [
                    sys.executable,
                    str(REPO / "tools/tinker-harvest-py.py"),
                    "--local-repos",
                    str(repos_dir),
                    "--output-dir",
                    str(out_keep),
                    "--jobs",
                    "2",
                    "--max-per-repo",
                    "20",
                    "--max-per-fn",
                    "3",
                    "--min-source-chars",
                    "50",
                    "--min-trace-lines",
                    "4",
                    "--keep-probe-type-errors",
                ],
                capture_output=True,
                text=True,
                timeout=60,
                check=False,
            )
            self.assertEqual(proc_keep.returncode, 0, msg=f"stderr={proc_keep.stderr}\nstdout={proc_keep.stdout}")
            keep_rows = [
                json.loads(line)
                for line in (out_keep / "harvested.jsonl").read_text(encoding="utf-8").splitlines()
                if line.strip()
            ]
            self.assertIn("caught_first_line_type_error", {r["entry"] for r in keep_rows})


class HttpInterceptionTests(unittest.TestCase):
    def test_urllib_urlopen_get_post_headers_bytes_and_errors(self):
        source = """\
import json
import urllib.error
import urllib.request

def run(base_url):
    with urllib.request.urlopen(base_url + "/meta") as r1:
        status1 = r1.getcode()
        url1 = r1.geturl()
        ctype = r1.info().get("Content-Type")
        first_line = r1.readline().decode("utf-8").strip()
        rest_lines = [ln.decode("utf-8").strip() for ln in r1.readlines()]

    req = urllib.request.Request(
        base_url + "/submit",
        data=json.dumps({"n": 3}).encode("utf-8"),
        headers={"X-Token": "tok-1"},
        method="POST",
    )
    r2 = urllib.request.urlopen(req)
    body2 = r2.read().decode("utf-8")
    r2.close()

    try:
        urllib.request.urlopen(base_url + "/down")
        err_kind = "none"
    except urllib.error.URLError as exc:
        err_kind = f"{type(exc).__name__}:{isinstance(exc, urllib.error.URLError)}"

    try:
        urllib.request.urlopen(base_url + "/missing")
        http_err = "none"
    except urllib.error.HTTPError as exc:
        http_err = f"{exc.code}:{exc.read().decode('utf-8')}"

    return {
        "status1": status1,
        "url1": url1,
        "ctype": ctype,
        "lines": [first_line, *rest_lines],
        "body2": json.loads(body2),
        "err_kind": err_kind,
        "http_err": http_err,
    }
"""
        task = {
            "id": "py-http-urllib-1",
            "family": "py-http-urllib",
            "language": "py",
            "source": source,
            "entry": "run",
            "args": ["https://api.example.test"],
            "fixture": {
                "calls": [
                    {
                        "operation": "http.request",
                        "arguments": [{"method": "GET", "url": "https://api.example.test/meta"}],
                        "status": "fulfilled",
                        "result": {
                            "status": 200,
                            "url": "https://api.example.test/meta",
                            "headers": {"Content-Type": "text/plain; charset=utf-8"},
                            "body": "alpha\nbeta\ngamma\n",
                        },
                    },
                    {
                        "operation": "http.request",
                        "arguments": [{
                            "method": "POST",
                            "url": "https://api.example.test/submit",
                            "headers": {"X-token": "tok-1"},
                            "body": '{"n": 3}',
                        }],
                        "status": "fulfilled",
                        "result": {
                            "status": 201,
                            "url": "https://api.example.test/submit",
                            "headers": {"Content-Type": "application/json"},
                            "body": '{"saved": true, "n": 3}',
                        },
                    },
                    {
                        "operation": "http.request",
                        "arguments": [{"method": "GET", "url": "https://api.example.test/down"}],
                        "status": "rejected",
                        "result": {"name": "URLError", "message": "<urlopen error connection refused>"},
                    },
                    {
                        "operation": "http.request",
                        "arguments": [{"method": "GET", "url": "https://api.example.test/missing"}],
                        "status": "fulfilled",
                        "result": {
                            "status": 404,
                            "url": "https://api.example.test/missing",
                            "headers": {"Content-Type": "text/plain"},
                            "body": "not found",
                        },
                    },
                ]
            },
        }
        exported = export_python_example(task, trace_format="compact", reasoning_channel="thinking")
        self.assertTrue(exported["metadata"]["traceAudit"]["replayVerified"])

        tool_decl = json.loads(exported["messages"][1]["content"])
        self.assertEqual([t["function"]["name"] for t in tool_decl], ["http.request"])

        comp_vis = assistant_visible_text(exported["messages"][-1])
        comp = json.loads(comp_vis.split("```json\n", 1)[1].split("\n```", 1)[0])
        self.assertEqual(comp["kind"], "return")
        self.assertEqual(
            comp["value"],
            {
                "status1": 200,
                "url1": "https://api.example.test/meta",
                "ctype": "text/plain; charset=utf-8",
                "lines": ["alpha", "beta", "gamma"],
                "body2": {"saved": True, "n": 3},
                "err_kind": "URLError:True",
                "http_err": "404:not found",
            },
        )

        # Replay via PythonExecutionSession
        prep = prepare_python_task(task, trace_format="compact")
        sess = create_python_session(prep)
        for msg in exported["messages"][2:]:
            if msg["role"] == "assistant":
                step_res = sess.step(msg, 10)
        self.assertTrue(sess.grade()["success"])

        # Pure urllib.parse must NOT declare http.request!
        pure_msgs = initial_messages({
            "source": "import urllib.parse\ndef run(s):\n    return urllib.parse.quote(s)\n",
            "entry": "run",
            "args": ["a b"],
            "randomMode": "seeded",
            "randomSeed": 17,
            "nativeBindings": [],
        })
        self.assertFalse(any(m["role"] == "tool_declare" for m in pure_msgs))

    def test_urllib_rejected_httperror_and_binary_body(self):
        source = """\
import urllib.error
import urllib.request

def run(url_bin, url_err):
    with urllib.request.urlopen(url_bin) as r:
        raw = r.read()
    try:
        urllib.request.urlopen(url_err)
        code = 0
    except urllib.error.HTTPError as e:
        code = e.code
    return (raw, code)
"""
        task = {
            "id": "py-http-urllib-bin-err",
            "family": "py-http-urllib",
            "language": "py",
            "source": source,
            "entry": "run",
            "args": ["https://cdn.test/blob", "https://cdn.test/404"],
            "fixture": {
                "calls": [
                    {
                        "operation": "http.request",
                        "arguments": [{"method": "GET", "url": "https://cdn.test/blob"}],
                        "status": "fulfilled",
                        "result": {
                            "status": 200,
                            "url": "https://cdn.test/blob",
                            "headers": {"Content-Type": "application/octet-stream"},
                            "body": encode_readable(b"\x00\xff\x10ok"),
                        },
                    },
                    {
                        "operation": "http.request",
                        "arguments": [{"method": "GET", "url": "https://cdn.test/404"}],
                        "status": "rejected",
                        "result": {"name": "HTTPError", "message": "HTTP Error 404: Not Found"},
                    },
                ]
            },
        }
        exported = export_python_example(task, trace_format="compact")
        self.assertTrue(exported["metadata"]["traceAudit"]["replayVerified"])
        comp = json.loads(assistant_visible_text(exported["messages"][-1]).split("```json\n", 1)[1].split("\n```", 1)[0])
        self.assertEqual(decode_readable(comp["value"]), (b"\x00\xff\x10ok", 404))

    def test_requests_get_post_session_and_exceptions(self):
        source = """\
import requests

def run(base):
    r1 = requests.get(base + "/items", params={"q": "py", "limit": 2})
    items = r1.json()["items"]

    with requests.post(base + "/items", json={"name": "widget"}, headers={"X-Mode": "fast"}) as r2:
        r2.raise_for_status()
        created = r2.text

    with requests.Session() as sess:
        sess.headers.update({"Authorization": "Bearer secret"})
        r3 = sess.get(base + "/forbidden")
        ok3 = r3.ok
        status3 = r3.status_code
        reason3 = r3.reason
        try:
            r3.raise_for_status()
            raised_http = False
        except requests.HTTPError:
            raised_http = True

        try:
            sess.get(base + "/timeout")
            caught = "none"
        except requests.RequestException as exc:
            caught = f"{type(exc).__name__}:{isinstance(exc, requests.RequestException)}"

    return {
        "items": items,
        "created": created,
        "r1_ctype": r1.headers.get("content-type"),
        "r1_bytes_len": len(r1.content),
        "ok3": ok3,
        "status3": status3,
        "reason3": reason3,
        "raised_http": raised_http,
        "caught": caught,
    }
"""
        task = {
            "id": "py-http-requests-1",
            "family": "py-http-requests",
            "language": "py",
            "source": source,
            "entry": "run",
            "args": ["https://svc.test"],
            "fixture": {
                "calls": [
                    {
                        "operation": "http.request",
                        "arguments": [{"method": "GET", "url": "https://svc.test/items?q=py&limit=2"}],
                        "status": "fulfilled",
                        "result": {
                            "status": 200,
                            "url": "https://svc.test/items?q=py&limit=2",
                            "headers": {"Content-Type": "application/json"},
                            "body": '{"items":[1,2]}',
                        },
                    },
                    {
                        "operation": "http.request",
                        "arguments": [{
                            "method": "POST",
                            "url": "https://svc.test/items",
                            "headers": {"X-Mode": "fast", "Content-Type": "application/json"},
                            "body": '{"name": "widget"}',
                        }],
                        "status": "fulfilled",
                        "result": {
                            "status": 201,
                            "url": "https://svc.test/items",
                            "headers": {},
                            "body": "created:widget",
                        },
                    },
                    {
                        "operation": "http.request",
                        "arguments": [{
                            "method": "GET",
                            "url": "https://svc.test/forbidden",
                            "headers": {"Authorization": "Bearer secret"},
                        }],
                        "status": "fulfilled",
                        "result": {
                            "status": 403,
                            "url": "https://svc.test/forbidden",
                            "headers": {},
                            "body": "denied",
                        },
                    },
                    {
                        "operation": "http.request",
                        "arguments": [{
                            "method": "GET",
                            "url": "https://svc.test/timeout",
                            "headers": {"Authorization": "Bearer secret"},
                        }],
                        "status": "rejected",
                        "result": {"name": "TimeoutError", "message": "read timed out"},
                    },
                ]
            },
        }
        exported = export_python_example(task, trace_format="compact")
        self.assertTrue(exported["metadata"]["traceAudit"]["replayVerified"])
        tool_decl = json.loads(exported["messages"][1]["content"])
        self.assertEqual([t["function"]["name"] for t in tool_decl], ["http.request"])

        comp = json.loads(assistant_visible_text(exported["messages"][-1]).split("```json\n", 1)[1].split("\n```", 1)[0])
        self.assertEqual(
            comp["value"],
            {
                "items": [1, 2],
                "created": "created:widget",
                "r1_ctype": "application/json",
                "r1_bytes_len": 15,
                "ok3": False,
                "status3": 403,
                "reason3": "Forbidden",
                "raised_http": True,
                "caught": "TimeoutError:True",
            },
        )

    def test_fallback_requests_module_when_requests_unavailable(self):
        script = """
import json, sys
for k in list(sys.modules):
    if k == "requests" or k.startswith("requests."):
        del sys.modules[k]
from tinker_py.http_tools import install_replay_http_hooks

expected = [
    {"status": 200, "url": "https://fb.test/v1?a=1", "headers": {"Content-Type": "application/json"}, "body": '{"ok":true}'},
    {"name": "ConnectionError", "message": "lost link"},
]
recorded = []
def invoke(op, args, exc_builder=None):
    recorded.append((op, args))
    item = expected.pop(0)
    if "name" in item:
        raise exc_builder(item)
    return item

install_replay_http_hooks(invoke, enable_urllib=False, enable_requests=True, force_fallback_requests=True)
import requests
from requests import Session, RequestException
r = requests.get("https://fb.test/v1", params={"a": 1})
assert r.status_code == 200 and r.ok and r.json() == {"ok": True}
assert r.headers.get("content-type") == "application/json"
with Session() as s:
    try:
        s.post("https://fb.test/fail", json={"k": 1})
        raise AssertionError("should have raised")
    except RequestException as exc:
        assert type(exc).__name__ == "ConnectionError"
print(json.dumps(recorded))
"""
        proc = subprocess.run(
            [sys.executable, "-c", script],
            env={"PYTHONPATH": str(REPO / "training"), "PATH": ""},
            capture_output=True,
            text=True,
            timeout=15,
            check=False,
        )
        self.assertEqual(proc.returncode, 0, msg=f"stderr={proc.stderr}\nstdout={proc.stdout}")
        recorded = json.loads(proc.stdout.strip())
        self.assertEqual(
            recorded,
            [
                ["http.request", [{"method": "GET", "url": "https://fb.test/v1?a=1"}]],
                ["http.request", [{"method": "POST", "url": "https://fb.test/fail", "headers": {"Content-Type": "application/json"}, "body": '{"k": 1}'}]],
            ],
        )

    def test_http_causal_zero_future_leakage(self):
        source = """\
import json
import urllib.request
import requests

def run(url):
    prefix = "req:" + url.rsplit("/", 1)[-1]
    with urllib.request.urlopen(url) as resp:
        cfg = json.loads(resp.read().decode("utf-8"))
    if cfg["route"] == "fast":
        res = requests.post(url + "/fast", json={"mode": prefix})
    else:
        res = requests.post(url + "/slow", json={"mode": prefix})
    return {"route": cfg["route"], "reply": res.json()}
"""
        def make_task(tid: str, route: str, secret_val: str) -> dict:
            return {
                "id": tid,
                "family": "py-http-causal",
                "language": "py",
                "source": source,
                "entry": "run",
                "args": ["https://cfg.test/service"],
                "features": ["external", "http", "branch"],
                "fixture": {
                    "calls": [
                        {
                            "operation": "http.request",
                            "arguments": [{"method": "GET", "url": "https://cfg.test/service"}],
                            "status": "fulfilled",
                            "result": {
                                "status": 200,
                                "url": "https://cfg.test/service",
                                "headers": {"Content-Type": "application/json"},
                                "body": json.dumps({"route": route, "secret": secret_val}),
                            },
                        },
                        {
                            "operation": "http.request",
                            "arguments": [{
                                "method": "POST",
                                "url": f"https://cfg.test/service/{route}",
                                "headers": {"Content-Type": "application/json"},
                                "body": '{"mode": "req:service"}',
                            }],
                            "status": "fulfilled",
                            "result": {
                                "status": 200,
                                "url": f"https://cfg.test/service/{route}",
                                "headers": {"Content-Type": "application/json"},
                                "body": json.dumps({"accepted": route}),
                            },
                        },
                    ]
                },
            }

        exp_a = export_python_example(make_task("http-causal-a", "fast", "SECRET_ALPHA_111"), trace_format="compact")
        exp_b = export_python_example(make_task("http-causal-b", "slow", "SECRET_BETA_222"), trace_format="compact")
        audit = audit_python_supervision([exp_a, exp_b], {"formats": ["compact", "full", "actions-only"], "samplePerFeature": 4})
        self.assertTrue(audit["valid"])
        self.assertTrue(audit["allReplayed"])
        self.assertGreaterEqual(audit["causalDivergencesChecked"], 1)

        # Turn 0 assistant message before first http.request must be identical and leak no secrets
        self.assertEqual(exp_a["messages"][3], exp_b["messages"][3])
        turn0_think = assistant_thinking_text(exp_a["messages"][3])
        self.assertIn("prefix = 'req:service'", turn0_think)
        self.assertNotIn("SECRET_ALPHA_111", turn0_think)
        self.assertNotIn("fast", turn0_think)

    def test_live_capture_harvest_http_end_to_end_and_offline_replay(self):
        class _Handler(BaseHTTPRequestHandler):
            def log_message(self, format: str, *args: object) -> None:  # noqa: A002
                return None

            def do_GET(self) -> None:
                if self.path.startswith("/items"):
                    payload = json.dumps({"items": [10, 20, 30], "path": self.path}).encode("utf-8")
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("X-Server", "local-test")
                    self.end_headers()
                    self.wfile.write(payload)
                elif self.path == "/missing":
                    payload = b'{"error":"not-here"}'
                    self.send_response(404)
                    self.send_header("Content-Type", "application/json")
                    self.end_headers()
                    self.wfile.write(payload)
                else:
                    self.send_response(404)
                    self.end_headers()

            def do_POST(self) -> None:
                length = int(self.headers.get("Content-Length", "0") or 0)
                raw = self.rfile.read(length)
                req_json = json.loads(raw.decode("utf-8"))
                resp = json.dumps({"ok": True, "received": req_json, "hdr": self.headers.get("X-App")}).encode("utf-8")
                self.send_response(201)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(resp)

        server = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
        port = server.server_address[1]
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        base_url = f"http://127.0.0.1:{port}"
        leaked_cwd_file = Path.cwd() / "harvest_probe_artifact.txt"
        if leaked_cwd_file.exists():
            leaked_cwd_file.unlink()

        try:
            with tempfile.TemporaryDirectory() as tmpdir:
                root = Path(tmpdir)
                repos_dir = root / "repos"
                repo = repos_dir / "live_http_lib"
                (repo / "pkg").mkdir(parents=True)
                (repo / "tests").mkdir(parents=True)
                out_dir = root / "out"

                (repo / "pkg" / "__init__.py").write_text("", encoding="utf-8")
                (repo / "pkg" / "client.py").write_text(
                    """\
import ctypes
import json
import urllib.error
import urllib.request
import requests

def fetch_with_urllib(url, missing_url):
    \"\"\"Fetch JSON via urllib and capture 404 HTTPError cleanly.\"\"\"
    with open("harvest_probe_artifact.txt", "w", encoding="utf-8") as fh:
        fh.write("isolated")
    with urllib.request.urlopen(url) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    err_code = None
    try:
        urllib.request.urlopen(missing_url)
    except urllib.error.HTTPError as exc:
        err_code = exc.code
    return {"total": sum(data["items"]), "err_code": err_code, "srv": resp.headers.get("X-Server")}

def sync_via_requests(base_url, payload):
    \"\"\"Query items and POST score via requests.\"\"\"
    r1 = requests.get(base_url + "/items", params={"tag": "alpha"})
    r1.raise_for_status()
    items = r1.json()["items"]
    with requests.Session() as sess:
        sess.headers.update({"X-App": "harvester"})
        r2 = sess.post(base_url + "/score", json={"sum": sum(items), "tag": payload["tag"]})
        r2.raise_for_status()
    return r2.json()

def blocked_ctypes(val):
    return ctypes.c_int(val).value
""",
                    encoding="utf-8",
                )
                (repo / "tests" / "test_client.py").write_text(
                    f"""\
from pkg.client import fetch_with_urllib, sync_via_requests

BASE = {base_url!r}

def test_http_clients():
    fetch_with_urllib(BASE + "/items?tag=u", f"{{BASE}}/missing")
    sync_via_requests(BASE, {{"tag": "prod"}})
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
                        "10",
                        "--max-per-fn",
                        "3",
                        "--min-source-chars",
                        "80",
                        "--max-source-chars",
                        "35000",
                    ],
                    capture_output=True,
                    text=True,
                    timeout=60,
                    check=False,
                )
                self.assertEqual(proc.returncode, 0, msg=f"stderr={proc.stderr}\nstdout={proc.stdout}")

                # Shut down server completely BEFORE verifying offline replay!
                server.shutdown()
                server.server_close()

                self.assertFalse(leaked_cwd_file.exists(), "probe leaked file into repo cwd")
                rows = [
                    json.loads(line)
                    for line in (out_dir / "harvested.jsonl").read_text(encoding="utf-8").splitlines()
                    if line.strip()
                ]
                entries = {r["entry"] for r in rows}
                self.assertIn("fetch_with_urllib", entries)
                self.assertIn("sync_via_requests", entries)
                self.assertNotIn("blocked_ctypes", entries)

                for entry_name in ("fetch_with_urllib", "sync_via_requests"):
                    task_row = next(r for r in rows if r["entry"] == entry_name and "unit-test-input" in r["features"])
                    self.assertIn("http", task_row["features"])
                    self.assertIn("http.request", task_row["features"])
                    ops = [c["operation"] for c in task_row["fixture"]["calls"]]
                    if entry_name == "fetch_with_urllib":
                        self.assertEqual(ops, ["fs.writeText", "http.request", "http.request"])
                    else:
                        self.assertEqual(ops, ["http.request", "http.request"])

                    # Replay completely offline with server dead!
                    exported = export_python_example(task_row, trace_format="compact", reasoning_channel="thinking")
                    self.assertTrue(exported["metadata"]["traceAudit"]["replayVerified"])
                    tool_decl = json.loads(exported["messages"][1]["content"])
                    expected_decls = ["fs.writeText", "http.request"] if entry_name == "fetch_with_urllib" else ["http.request"]
                    self.assertEqual(sorted(t["function"]["name"] for t in tool_decl), expected_decls)

                    prepared = prepare_python_task(task_row, trace_format="compact")
                    session = create_python_session(prepared)
                    for msg in exported["messages"][2:]:
                        if msg["role"] == "assistant":
                            session.step(msg, 25)
                    self.assertTrue(session.grade()["success"])

                    comp = json.loads(assistant_visible_text(exported["messages"][-1]).split("```json\n", 1)[1].split("\n```", 1)[0])
                    self.assertEqual(comp["kind"], "return")
                    if entry_name == "fetch_with_urllib":
                        self.assertEqual(comp["value"], {"total": 60, "err_code": 404, "srv": "local-test"})
                    else:
                        self.assertEqual(comp["value"], {"ok": True, "received": {"sum": 60, "tag": "prod"}, "hdr": "harvester"})
        finally:
            try:
                server.shutdown()
                server.server_close()
            except Exception:
                pass
            if leaked_cwd_file.exists():
                leaked_cwd_file.unlink()


class StdlibAndIOInterceptionTests(unittest.TestCase):
    def test_open_pathlib_os_fs_and_env_replay(self):
        source = """\
import os
from pathlib import Path

def run(cfg_dir, out_name):
    mode = os.getenv("APP_MODE", "dev")
    has_secret = "API_TOKEN" in os.environ
    token = os.environ["API_TOKEN"] if has_secret else os.environ.get("FALLBACK_TOKEN", "none")

    joined = os.path.join(cfg_dir, "settings.txt")
    if os.path.exists(joined) and os.path.isfile(joined):
        with open(joined, "r", encoding="utf-8") as fh:
            first = fh.readline().strip()
            rest = [ln.strip() for ln in fh]
    else:
        first = "missing"
        rest = []

    p = Path(cfg_dir)
    entries = sorted(x.name for x in p.iterdir()) if os.path.isdir(cfg_dir) else []
    listed = os.listdir(cfg_dir)

    out_path = Path(cfg_dir) / out_name
    out_path.write_text(f"{mode}:{token}:{first}", encoding="utf-8")
    written_back = out_path.read_text(encoding="utf-8")

    bin_path = Path(cfg_dir) / "blob.bin"
    with open(bin_path, "wb") as bfh:
        bfh.write(b"\\x00\\xff")
    raw_bytes = bin_path.read_bytes()

    try:
        Path(cfg_dir, "absent.txt").read_text()
        absent_err = "none"
    except FileNotFoundError:
        absent_err = "missing"

    return {
        "mode": mode,
        "first": first,
        "rest": rest,
        "entries": entries,
        "listed": listed,
        "written_back": written_back,
        "raw_bytes": raw_bytes,
        "absent_err": absent_err,
        "out_path": out_path,
    }
"""
        task = {
            "id": "py-io-fs-env-1",
            "family": "py-io-fs-env",
            "language": "py",
            "source": source,
            "entry": "run",
            "args": ["/etc/myapp", "summary.txt"],
            "fixture": {
                "calls": [
                    {"operation": "env.get", "arguments": ["APP_MODE"], "status": "fulfilled", "result": "prod"},
                    {"operation": "env.get", "arguments": ["API_TOKEN"], "status": "fulfilled", "result": "tok-9"},
                    {"operation": "env.get", "arguments": ["API_TOKEN"], "status": "fulfilled", "result": "tok-9"},
                    {"operation": "fs.exists", "arguments": ["/etc/myapp/settings.txt"], "status": "fulfilled", "result": True},
                    {"operation": "fs.isFile", "arguments": ["/etc/myapp/settings.txt"], "status": "fulfilled", "result": True},
                    {"operation": "fs.readText", "arguments": ["/etc/myapp/settings.txt"], "status": "fulfilled", "result": "alpha\nbeta\ngamma\n"},
                    {"operation": "fs.isDir", "arguments": ["/etc/myapp"], "status": "fulfilled", "result": True},
                    {"operation": "fs.listdir", "arguments": ["/etc/myapp"], "status": "fulfilled", "result": ["b.cfg", "a.cfg"]},
                    {"operation": "fs.listdir", "arguments": ["/etc/myapp"], "status": "fulfilled", "result": ["b.cfg", "a.cfg"]},
                    {"operation": "fs.writeText", "arguments": ["/etc/myapp/summary.txt", "prod:tok-9:alpha"], "status": "fulfilled", "result": None},
                    {"operation": "fs.readText", "arguments": ["/etc/myapp/summary.txt"], "status": "fulfilled", "result": "prod:tok-9:alpha"},
                    {"operation": "fs.writeBytes", "arguments": ["/etc/myapp/blob.bin", encode_readable(b"\x00\xff")], "status": "fulfilled", "result": None},
                    {"operation": "fs.readBytes", "arguments": ["/etc/myapp/blob.bin"], "status": "fulfilled", "result": encode_readable(b"\x00\xff")},
                    {"operation": "fs.readText", "arguments": ["/etc/myapp/absent.txt"], "status": "rejected", "result": {"name": "FileNotFoundError", "message": "not found"}},
                ]
            },
        }
        exported = export_python_example(task, trace_format="compact", reasoning_channel="thinking")
        self.assertTrue(exported["metadata"]["traceAudit"]["replayVerified"])

        tool_decl = json.loads(exported["messages"][1]["content"])
        declared = sorted(t["function"]["name"] for t in tool_decl)
        self.assertEqual(
            declared,
            ["env.get", "fs.exists", "fs.isDir", "fs.isFile", "fs.listdir", "fs.readBytes", "fs.readText", "fs.writeBytes", "fs.writeText"],
        )
        for decl in tool_decl:
            self.assertEqual(decl["function"]["parameters"]["required"], ["arguments"])

        comp = json.loads(assistant_visible_text(exported["messages"][-1]).split("```json\n", 1)[1].split("\n```", 1)[0])
        val = decode_readable(comp["value"])
        self.assertEqual(val["mode"], "prod")
        self.assertEqual(val["first"], "alpha")
        self.assertEqual(val["rest"], ["beta", "gamma"])
        self.assertEqual(val["entries"], ["a.cfg", "b.cfg"])
        self.assertEqual(val["raw_bytes"], b"\x00\xff")
        self.assertEqual(val["absent_err"], "missing")
        self.assertEqual(val["out_path"], Path("/etc/myapp/summary.txt"))

        prepared = prepare_python_task(task, trace_format="compact")
        sess = create_python_session(prepared)
        for msg in exported["messages"][2:]:
            if msg["role"] == "assistant":
                sess.step(msg, 10)
        self.assertTrue(sess.grade()["success"])

    def test_logging_subprocess_datetime_uuid_secrets_replay(self):
        source = """\
import datetime
import logging
import secrets
import subprocess
import uuid

def run(cmd):
    logger = logging.getLogger("svc")
    logging.info("starting %s", cmd[0])
    logger.warning("attempt=%d", 2)

    now_utc = datetime.datetime.now(datetime.timezone.utc)
    today_d = datetime.date.today()
    uid = uuid.uuid4()
    tok_hex = secrets.token_hex(4)
    tok_url = secrets.token_urlsafe(6)
    tok_bytes = secrets.token_bytes(3)
    picked = secrets.randbelow(10)

    cp = subprocess.run(cmd, capture_output=True, text=True, check=False)
    out2 = subprocess.check_output(["uname"], text=True)

    try:
        subprocess.run(["false"], check=True)
        failed_rc = 0
    except subprocess.CalledProcessError as exc:
        failed_rc = exc.returncode

    return {
        "now": now_utc,
        "today": today_d,
        "uid": str(uid),
        "tok_hex": tok_hex,
        "tok_url": tok_url,
        "tok_bytes": tok_bytes,
        "picked": picked,
        "cp_rc": cp.returncode,
        "cp_out": cp.stdout.strip(),
        "out2": out2.strip(),
        "failed_rc": failed_rc,
    }
"""
        task = {
            "id": "py-io-platform-shell-1",
            "family": "py-io-platform-shell",
            "language": "py",
            "source": source,
            "entry": "run",
            "args": [["echo", "hi"]],
            "fixture": {
                "calls": [
                    {"operation": "platform.log", "arguments": ["INFO", "starting echo"], "status": "fulfilled", "result": None},
                    {"operation": "platform.log", "arguments": ["WARNING", "attempt=2"], "status": "fulfilled", "result": None},
                    {"operation": "platform.time", "arguments": [], "status": "fulfilled", "result": 1700000000.0},
                    {"operation": "platform.time", "arguments": [], "status": "fulfilled", "result": 1700000001.0},
                    {"operation": "platform.uuid", "arguments": [], "status": "fulfilled", "result": "12345678-1234-4123-8123-123456789abc"},
                    {"operation": "platform.secrets", "arguments": ["token_hex", 4], "status": "fulfilled", "result": "deadbeef"},
                    {"operation": "platform.secrets", "arguments": ["token_urlsafe", 6], "status": "fulfilled", "result": "abc_DEF0"},
                    {"operation": "platform.secrets", "arguments": ["token_bytes", 3], "status": "fulfilled", "result": encode_readable(b"\x01\x02\x03")},
                    {"operation": "platform.secrets", "arguments": ["randbelow", 10], "status": "fulfilled", "result": 7},
                    {
                        "operation": "shell.exec",
                        "arguments": [{"args": ["echo", "hi"], "shell": False}],
                        "status": "fulfilled",
                        "result": {"returncode": 0, "stdout": "hi\n", "stderr": ""},
                    },
                    {
                        "operation": "shell.exec",
                        "arguments": [{"args": ["uname"], "shell": False}],
                        "status": "fulfilled",
                        "result": {"returncode": 0, "stdout": "Linux\n", "stderr": ""},
                    },
                    {
                        "operation": "shell.exec",
                        "arguments": [{"args": ["false"], "shell": False}],
                        "status": "rejected",
                        "result": {"name": "CalledProcessError", "message": "Command '['false']' returned non-zero exit status 1."},
                    },
                ]
            },
        }
        exported = export_python_example(task, trace_format="compact", reasoning_channel="thinking")
        self.assertTrue(exported["metadata"]["traceAudit"]["replayVerified"])
        tool_decl = json.loads(exported["messages"][1]["content"])
        self.assertEqual(
            sorted(t["function"]["name"] for t in tool_decl),
            ["platform.log", "platform.secrets", "platform.time", "platform.uuid", "shell.exec"],
        )

        comp = json.loads(assistant_visible_text(exported["messages"][-1]).split("```json\n", 1)[1].split("\n```", 1)[0])
        decoded = decode_readable(comp["value"])
        self.assertEqual(decoded["now"], datetime.datetime(2023, 11, 14, 22, 13, 20, tzinfo=datetime.timezone.utc))
        self.assertEqual(decoded["today"], datetime.date.fromtimestamp(1700000001.0))
        self.assertEqual(decoded["uid"], "12345678-1234-4123-8123-123456789abc")
        self.assertEqual(decoded["tok_hex"], "deadbeef")
        self.assertEqual(decoded["tok_bytes"], b"\x01\x02\x03")
        self.assertEqual(decoded["picked"], 7)
        self.assertEqual(decoded["cp_out"], "hi")
        self.assertEqual(decoded["out2"], "Linux")
        self.assertEqual(decoded["failed_rc"], 1)

    def test_asyncio_and_sqlite_in_memory_with_io_and_settrace(self):
        source = """\
import asyncio
import datetime
import logging
import os
import sqlite3

async def _compute(x):
    await asyncio.sleep(0)
    return x * 10

async def run(items):
    prefix = os.getenv("ROW_PREFIX", "v")
    now = datetime.datetime.now(datetime.timezone.utc)
    conn = sqlite3.connect(":memory:")
    conn.execute("CREATE TABLE scores (label TEXT, val INTEGER)")
    vals = await asyncio.gather(*(_compute(i) for i in items))
    for i, v in enumerate(vals):
        conn.execute("INSERT INTO scores VALUES (?, ?)", (f"{prefix}{i}", v))
    total = conn.execute("SELECT SUM(val) FROM scores").fetchone()[0]
    conn.close()
    logging.info("total=%d", total)
    try:
        sqlite3.connect("forbidden.db")
        disk_blocked = False
    except PermissionError:
        disk_blocked = True
    return {"total": total, "now": now, "disk_blocked": disk_blocked}
"""
        task = {
            "id": "py-async-sqlite-1",
            "family": "py-async-sqlite",
            "language": "py",
            "source": source,
            "entry": "run",
            "args": [[2, 3, 4]],
            "fixture": {
                "calls": [
                    {"operation": "env.get", "arguments": ["ROW_PREFIX"], "status": "fulfilled", "result": "p"},
                    {"operation": "platform.time", "arguments": [], "status": "fulfilled", "result": 1700000000.0},
                    {"operation": "platform.log", "arguments": ["INFO", "total=90"], "status": "fulfilled", "result": None},
                ]
            },
        }
        exported = export_python_example(task, trace_format="compact", reasoning_channel="thinking")
        self.assertTrue(exported["metadata"]["traceAudit"]["replayVerified"])
        tool_decl = json.loads(exported["messages"][1]["content"])
        self.assertEqual(sorted(t["function"]["name"] for t in tool_decl), ["env.get", "platform.log", "platform.time"])

        comp = json.loads(assistant_visible_text(exported["messages"][-1]).split("```json\n", 1)[1].split("\n```", 1)[0])
        val = decode_readable(comp["value"])
        self.assertEqual(val["total"], 90)
        self.assertTrue(val["disk_blocked"])
        self.assertEqual(val["now"], datetime.datetime(2023, 11, 14, 22, 13, 20, tzinfo=datetime.timezone.utc))

    def test_scan_public_source_tools_covers_all_new_io_apis_and_ignores_pure_or_dummy(self):
        cases = [
            ("def run(p): return open(p).read()\n", ["fs.readText"]),
            ("def run(p, txt):\n    with open(p, 'w') as f: f.write(txt)\n", ["fs.writeText"]),
            ("def run(p): return open(p, 'rb').read()\n", ["fs.readBytes"]),
            ("def run(p, b):\n    with open(p, 'wb') as f: f.write(b)\n", ["fs.writeBytes"]),
            ("from pathlib import Path\ndef run(p): return Path(p).exists(), Path(p).iterdir()\n", ["fs.exists", "fs.listdir"]),
            ("import os\ndef run(p): return os.path.join(p, 'a')\n", []),
            ("import os\ndef run(k, p): return os.environ[k], os.listdir(p), os.path.exists(p)\n", ["env.get", "fs.exists", "fs.listdir"]),
            ("import logging\ndef run(x): logging.getLogger('a').info('x=%s', x)\n", ["platform.log"]),
            ("class _NoopLog:\n    def info(self, *a): pass\nlogging = _NoopLog()\ndef run(x): logging.info(x)\n", []),
            ("import subprocess\ndef run(c): return subprocess.run(c).returncode\n", ["shell.exec"]),
            ("import uuid\ndef run(): return str(uuid.uuid4())\n", ["platform.uuid"]),
            ("import uuid\ndef run(s): return str(uuid.UUID(s))\n", []),
            ("import secrets\ndef run(): return secrets.token_hex(8)\n", ["platform.secrets"]),
            ("import secrets\ndef run(a, b): return secrets.compare_digest(a, b)\n", []),
        ]
        for src, expected_ops in cases:
            with self.subTest(src=src):
                ops, _ = _scan_public_source_tools(src, "seeded", [])
                self.assertEqual(ops, expected_ops)

    def test_io_causal_zero_future_leakage(self):
        source = """\
import os
import subprocess
import uuid

def run(cfg_path, env_key):
    tag = "cfg:" + os.path.basename(cfg_path)
    raw = open(cfg_path, "r").read()
    mode = os.getenv(env_key, "dev")
    uid = str(uuid.uuid4())
    if mode == "fast":
        cp = subprocess.run(["echo", "fast:" + uid], capture_output=True, text=True)
    else:
        cp = subprocess.run(["echo", "slow:" + uid], capture_output=True, text=True)
    return {"tag": tag, "raw": raw, "mode": mode, "uid": uid, "out": cp.stdout.strip()}
"""
        def make_task(tid: str, raw: str, mode: str, uid: str, out: str) -> dict:
            return {
                "id": tid,
                "family": "py-io-causal",
                "language": "py",
                "source": source,
                "entry": "run",
                "args": ["/app/cfg.txt", "APP_MODE"],
                "features": ["external", "fs", "env", "shell", "branch"],
                "fixture": {
                    "calls": [
                        {"operation": "fs.readText", "arguments": ["/app/cfg.txt"], "status": "fulfilled", "result": raw},
                        {"operation": "env.get", "arguments": ["APP_MODE"], "status": "fulfilled", "result": mode},
                        {"operation": "platform.uuid", "arguments": [], "status": "fulfilled", "result": uid},
                        {
                            "operation": "shell.exec",
                            "arguments": [{"args": ["echo", f"{mode}:{uid}"], "shell": False}],
                            "status": "fulfilled",
                            "result": {"returncode": 0, "stdout": out + "\n", "stderr": ""},
                        },
                    ]
                },
            }

        exp_a = export_python_example(
            make_task("io-causal-a", "SECRET_RAW_1", "fast", "11111111-1111-4111-8111-111111111111", "ok-a"),
            trace_format="compact",
        )
        exp_b = export_python_example(
            make_task("io-causal-b", "SECRET_RAW_2", "slow", "22222222-2222-4222-8222-222222222222", "ok-b"),
            trace_format="compact",
        )
        audit = audit_python_supervision([exp_a, exp_b], {"formats": ["compact", "full", "actions-only"], "samplePerFeature": 4})
        self.assertTrue(audit["valid"])
        self.assertTrue(audit["allReplayed"])
        self.assertGreaterEqual(audit["causalDivergencesChecked"], 1)
        self.assertEqual(exp_a["messages"][3], exp_b["messages"][3])
        turn0_think = assistant_thinking_text(exp_a["messages"][3])
        self.assertIn("tag = 'cfg:cfg.txt'", turn0_think)
        self.assertNotIn("SECRET_RAW_1", turn0_think)
        self.assertNotIn("fast", turn0_think)

    def test_live_capture_harvest_stdlib_io_async_sqlite_end_to_end_and_offline_replay(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            repos_dir = root / "repos"
            repo = repos_dir / "live_io_lib"
            (repo / "pkg").mkdir(parents=True)
            (repo / "tests").mkdir(parents=True)
            out_dir = root / "out"
            live_input_file = root / "live_config.txt"
            live_input_file.write_text("line1\nline2\n", encoding="utf-8")

            (repo / "pkg" / "__init__.py").write_text("", encoding="utf-8")
            (repo / "pkg" / "pipeline.py").write_text(
                """\
import asyncio
import datetime
from decimal import Decimal
import enum
import logging
import os
from pathlib import Path
import secrets
import shutil
import sqlite3
import subprocess
import uuid

class Status(enum.Enum):
    OK = "ok"

def run_io_pipeline(cfg_path, env_key, out_name):
    \"\"\"Exercise open/Path/env/logging/subprocess/datetime/uuid/secrets/sqlite3.\"\"\"
    env_val = os.getenv(env_key, "fallback")
    with open(cfg_path, "r", encoding="utf-8") as fh:
        lines = [ln.strip() for ln in fh if ln.strip()]
    out_path = Path(out_name)
    out_path.write_text("|".join(lines), encoding="utf-8")
    copied = out_path.read_text(encoding="utf-8")
    has_out = out_path.exists()
    logging.info("processed %s lines=%d", env_val, len(lines))
    cp = subprocess.run(["echo", "hi"], capture_output=True, text=True, check=True)
    now_dt = datetime.datetime.now(datetime.timezone.utc)
    uid_str = str(uuid.uuid4())
    tok = secrets.token_hex(4)

    conn = sqlite3.connect(":memory:")
    conn.execute("CREATE TABLE items (n INTEGER)")
    conn.execute("INSERT INTO items VALUES (?)", (len(lines),))
    db_count = conn.execute("SELECT SUM(n) FROM items").fetchone()[0]
    conn.close()

    return {
        "env_val": env_val,
        "copied": copied,
        "has_out": has_out,
        "echo": cp.stdout.strip(),
        "now_dt": now_dt,
        "uid_len": len(uid_str),
        "tok_len": len(tok),
        "db_count": db_count,
        "cost": Decimal("3.50"),
        "out_path": out_path,
        "status": Status.OK,
    }

async def async_sqlite_pipeline(env_key, vals):
    \"\"\"Async pipeline combining asyncio, sqlite3 :memory:, logging, and env lookup.\"\"\"
    tag = os.environ.get(env_key, "none")
    await asyncio.sleep(0)
    conn = sqlite3.connect(":memory:")
    conn.execute("CREATE TABLE nums (v INTEGER)")
    for v in vals:
        conn.execute("INSERT INTO nums VALUES (?)", (v,))
    total = conn.execute("SELECT SUM(v) FROM nums").fetchone()[0]
    conn.close()
    logging.warning("async tag=%s total=%d", tag, total)
    return {"tag": tag, "total": total}

def blocked_shutil(src, dst):
    return shutil.copyfile(src, dst)
""",
                encoding="utf-8",
            )
            (repo / "tests" / "test_pipeline.py").write_text(
                f"""\
from pkg.pipeline import run_io_pipeline, async_sqlite_pipeline

CFG = {str(live_input_file)!r}

def test_pipelines():
    res = run_io_pipeline(CFG, "HARVEST_LIVE_ENV", "copied_out.txt")
    assert res["echo"] == "hi"
    async_sqlite_pipeline("HARVEST_LIVE_ENV", [4, 5, 6])
""",
                encoding="utf-8",
            )

            proc_env = dict(os.environ)
            proc_env["HARVEST_LIVE_ENV"] = "live-secret-42"
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
                    "10",
                    "--max-per-fn",
                    "3",
                    "--min-source-chars",
                    "80",
                    "--max-source-chars",
                    "35000",
                ],
                env=proc_env,
                capture_output=True,
                text=True,
                timeout=60,
                check=False,
            )
            self.assertEqual(proc.returncode, 0, msg=f"stderr={proc.stderr}\nstdout={proc.stdout}")

            # Delete live temp file & make sure HARVEST_LIVE_ENV is unset in parent BEFORE offline replay!
            live_input_file.unlink()
            self.assertFalse(live_input_file.exists())
            self.assertNotIn("HARVEST_LIVE_ENV", os.environ)

            rows = [
                json.loads(line)
                for line in (out_dir / "harvested.jsonl").read_text(encoding="utf-8").splitlines()
                if line.strip()
            ]
            entries = {r["entry"] for r in rows}
            self.assertIn("run_io_pipeline", entries)
            self.assertIn("async_sqlite_pipeline", entries)
            self.assertNotIn("blocked_shutil", entries)

            io_task = next(r for r in rows if r["entry"] == "run_io_pipeline" and "unit-test-input" in r["features"])
            io_ops = [c["operation"] for c in io_task["fixture"]["calls"]]
            self.assertEqual(
                io_ops,
                [
                    "env.get",
                    "fs.readText",
                    "fs.writeText",
                    "fs.readText",
                    "fs.exists",
                    "platform.log",
                    "shell.exec",
                    "platform.time",
                    "platform.uuid",
                    "platform.secrets",
                ],
            )
            # Replay 100% offline with temp file deleted and env var unset!
            exp_io = export_python_example(io_task, trace_format="compact", reasoning_channel="thinking")
            self.assertTrue(exp_io["metadata"]["traceAudit"]["replayVerified"])
            prep_io = prepare_python_task(io_task, trace_format="compact")
            sess_io = create_python_session(prep_io)
            for msg in exp_io["messages"][2:]:
                if msg["role"] == "assistant":
                    sess_io.step(msg, 20)
            self.assertTrue(sess_io.grade()["success"])
            comp_io = json.loads(assistant_visible_text(exp_io["messages"][-1]).split("```json\n", 1)[1].split("\n```", 1)[0])
            dec_io = decode_readable(comp_io["value"])
            self.assertEqual(dec_io["env_val"], "live-secret-42")
            self.assertEqual(dec_io["copied"], "line1|line2")
            self.assertEqual(dec_io["echo"], "hi")
            self.assertEqual(dec_io["db_count"], 2)
            self.assertEqual(dec_io["cost"], Decimal("3.50"))
            self.assertEqual(dec_io["out_path"], Path("copied_out.txt"))
            self.assertEqual((dec_io["status"].name, dec_io["status"].value), ("OK", "ok"))

            async_task = next(r for r in rows if r["entry"] == "async_sqlite_pipeline" and "unit-test-input" in r["features"])
            self.assertIn("async", async_task["features"])
            self.assertEqual([c["operation"] for c in async_task["fixture"]["calls"]], ["env.get", "platform.log"])
            exp_async = export_python_example(async_task, trace_format="compact", reasoning_channel="thinking")
            self.assertTrue(exp_async["metadata"]["traceAudit"]["replayVerified"])
            comp_async = json.loads(assistant_visible_text(exp_async["messages"][-1]).split("```json\n", 1)[1].split("\n```", 1)[0])
            self.assertEqual(comp_async["value"], {"tag": "live-secret-42", "total": 15})


if __name__ == "__main__":
    unittest.main()
