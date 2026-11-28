"""Unit tests for Environment Un-Limits #2 (CLI Mode), #3 (Live Stateful Virtual World),
and #5 (Cross-Language Tool & Argument Canonicalization) in Python execution & grading.
"""

from __future__ import annotations

import json
import unittest
from typing import Any

from tinker_py import (
    BUILTIN_OPERATIONS,
    PythonExecutionSession,
    StatefulVirtualWorld,
    canonicalize_http_request_args,
    canonicalize_operation_name,
    create_cli_session,
    create_python_session,
    is_commutative_read_call,
    is_stateful_world_operation,
    parse_student_action,
    prepare_python_task,
)


def _tc(op: str, cargs: list[Any], cid: str) -> dict[str, Any]:
    return {
        "role": "assistant",
        "content": "",
        "tool_calls": [
            {
                "id": cid,
                "type": "function",
                "function": {"name": op, "arguments": json.dumps({"arguments": cargs})},
            }
        ],
    }


class CrossLanguageCanonicalizationTests(unittest.TestCase):
    def test_operation_name_aliases_and_fs_mutation_barriers(self) -> None:
        expected_pairs = [
            ("fs_read_text", "fs.readText"),
            ("fs_write_text", "fs.writeText"),
            ("fs_exists", "fs.exists"),
            ("fs_listdir", "fs.readdir"),
            ("fs.listdir", "fs.readdir"),
            ("fs_stat", "fs.stat"),
            ("fs_read_bytes", "fs.readBytes"),
            ("fs_write_bytes", "fs.writeBytes"),
            ("fs_mkdir", "fs.mkdir"),
            ("fs_unlink", "fs.unlink"),
            ("fs.remove", "fs.unlink"),
            ("fs_rename", "fs.rename"),
            ("http_request", "http.request"),
            ("http_get", "http.get"),
            ("kv_get", "kv.get"),
            ("kv_set", "kv.set"),
            ("kv_del", "kv.delete"),
            ("kv_has", "kv.has"),
            ("env_get", "env.get"),
        ]
        for alias, canonical in expected_pairs:
            self.assertEqual(canonicalize_operation_name(alias), canonical)
            self.assertEqual(canonicalize_operation_name(canonical), canonical)

        # New FS mutation specs registered in BUILTIN_OPERATIONS as strict barriers (NOT commutative reads)
        for op in ("fs.mkdir", "fs.unlink", "fs.rename", "fs.appendText", "fs.copyFile"):
            self.assertIn(op, BUILTIN_OPERATIONS)
            self.assertFalse(BUILTIN_OPERATIONS[op]["commutativeRead"])
            self.assertFalse(is_commutative_read_call(op, ["/tmp/a", "/tmp/b"]))

        # Read aliases ARE commutative reads; write aliases are strict barriers
        for op, cargs in (
            ("fs_read_text", ["a.txt"]),
            ("fs_exists", ["a.txt"]),
            ("fs_listdir", ["."]),
            ("fs_stat", ["a.txt"]),
            ("kv_get", ["k"]),
            ("kv_has", ["k"]),
            ("env_get", ["HOME"]),
            ("http_get", ["https://example.test"]),
            ("http_request", ["https://example.test", "get", {}, None]),
        ):
            self.assertTrue(is_commutative_read_call(op, cargs), f"expected read: {op}")

        for op, cargs in (
            ("fs_write_text", ["a.txt", "x"]),
            ("fs_mkdir", ["d"]),
            ("fs_unlink", ["a.txt"]),
            ("fs.remove", ["a.txt"]),
            ("fs_rename", ["a", "b"]),
            ("kv_set", ["k", 1]),
            ("kv_del", ["k"]),
            ("http_request", ["https://example.test", "POST", {}, "x"]),
        ):
            self.assertFalse(is_commutative_read_call(op, cargs), f"expected barrier: {op}")

    def test_http_request_dict_and_4_positional_canonicalization(self) -> None:
        self.assertEqual(
            canonicalize_http_request_args(["https://api.test/x", "get", "{}", None]),
            canonicalize_http_request_args([{"url": "https://api.test/x"}]),
        )
        self.assertEqual(
            canonicalize_http_request_args(["https://api.test/x", "post", '{"X-A":"1"}', "body"]),
            canonicalize_http_request_args([{"method": "POST", "url": "https://api.test/x", "headers": {"X-A": "1"}, "body": "body"}]),
        )
        self.assertEqual(
            canonicalize_http_request_args(["https://api.test/x", "DELETE", "", None]),
            canonicalize_http_request_args([{"method": "delete", "url": "https://api.test/x", "headers": {}, "body": ""}]),
        )
        # Unknown extra dict fields must NOT silently match
        self.assertIsNone(canonicalize_http_request_args([{"url": "https://api.test/x", "extra": 1}]))

        # Strict grading: match both directions (dict expected vs 4-pos student; 4-pos expected vs dict student)
        task_4pos = {
            "id": "py-http-4pos",
            "family": "py-http-canon",
            "language": "py",
            "executionKind": "cli",
            "source": "print('ok')",
            "argv": ["python", "app.py"],
            "expectedCli": {"exitCode": 0, "stdout": "ok\n", "stderr": ""},
            "fixture": {
                "calls": [
                    {
                        "operation": "http.request",
                        "arguments": ["https://api.test/data", "GET", '{"Accept":"application/json"}', None],
                        "status": "fulfilled",
                        "result": {"status": 200, "body": "[]"},
                    }
                ]
            },
        }
        s_ok = create_cli_session(task_4pos)
        obs = s_ok.step(
            _tc("http.request", [{"url": "https://api.test/data", "method": "get", "headers": {"Accept": "application/json"}, "body": ""}], "h1"),
            5,
        )
        self.assertFalse(obs["done"])
        fin = s_ok.step(json.dumps({"kind": "cli", "exitCode": 0, "stdout": "ok\n", "stderr": ""}), 15)
        self.assertTrue(fin["grade"]["success"])

        # Wrong URL, wrong method, wrong header, wrong non-empty body must all fail strictly
        bad_calls = [
            [{"url": "https://api.test/other", "method": "GET", "headers": {"Accept": "application/json"}}],
            [{"url": "https://api.test/data", "method": "POST", "headers": {"Accept": "application/json"}}],
            [{"url": "https://api.test/data", "method": "GET", "headers": {"Accept": "text/plain"}}],
            [{"url": "https://api.test/data", "method": "GET", "headers": {"Accept": "application/json"}, "body": "nonempty"}],
        ]
        for idx, bad_args in enumerate(bad_calls):
            s_bad = create_cli_session(task_4pos)
            res = s_bad.step(_tc("http.request", bad_args, f"bad_{idx}"), 5)
            self.assertTrue(res["done"])
            self.assertFalse(res["grade"]["success"])
            self.assertEqual(res["grade"]["failureCategory"], "incorrect-external-request")


class StatefulVirtualWorldTests(unittest.TestCase):
    def test_virtual_world_direct_operations(self) -> None:
        world = StatefulVirtualWorld({
            "fs": {"/work/a.txt": "hello", "/work/sub/b.txt": "world"},
            "kv": {"k1": [1, 2]},
            "env": {"MODE": "test"},
        })
        self.assertTrue(is_stateful_world_operation("fs_read_text"))
        self.assertTrue(is_stateful_world_operation("fs.remove"))
        self.assertTrue(is_stateful_world_operation("kv_del"))
        self.assertFalse(is_stateful_world_operation("http.request"))
        self.assertFalse(is_stateful_world_operation("shell.exec"))

        self.assertEqual(world.execute("fs.exists", ["/work/a.txt"]), ("fulfilled", True))
        self.assertEqual(world.execute("fs.isFile", ["/work/a.txt"]), ("fulfilled", True))
        self.assertEqual(world.execute("fs.isDir", ["/work/sub"]), ("fulfilled", True))
        self.assertEqual(world.execute("fs.stat", ["/work/a.txt"]), ("fulfilled", {"isFile": True, "isDirectory": False, "size": 5}))
        self.assertEqual(world.execute("fs.listdir", ["/work"]), ("fulfilled", ["a.txt", "sub"]))
        self.assertEqual(world.execute("fs.appendText", ["/work/a.txt", "!"]), ("fulfilled", None))
        self.assertEqual(world.execute("fs.readText", ["/work/a.txt"]), ("fulfilled", "hello!"))
        self.assertEqual(world.execute("fs.copyFile", ["/work/a.txt", "/work/c.txt"]), ("fulfilled", None))
        self.assertEqual(world.execute("fs.rename", ["/work/c.txt", "/work/d.txt"]), ("fulfilled", None))
        self.assertEqual(world.execute("fs.remove", ["/work/sub/b.txt"]), ("fulfilled", None))
        self.assertEqual(world.execute("fs.readText", ["/work/sub/b.txt"])[0], "rejected")
        self.assertEqual(world.execute("fs.mkdir", ["/work/newdir"]), ("fulfilled", None))
        self.assertEqual(world.execute("fs.isDir", ["/work/newdir"]), ("fulfilled", True))

        self.assertEqual(world.execute("kv.has", ["k1"]), ("fulfilled", True))
        self.assertEqual(world.execute("kv_get", ["k1"]), ("fulfilled", [1, 2]))
        self.assertEqual(world.execute("kv_set", ["k2", {"ok": True}]), ("fulfilled", None))
        self.assertEqual(world.execute("kv.keys", []), ("fulfilled", ["k1", "k2"]))
        self.assertEqual(world.execute("kv_del", ["k1"]), ("fulfilled", True))
        self.assertEqual(world.execute("kv.get", ["k1"]), ("fulfilled", None))

        self.assertEqual(world.execute("env.get", ["MODE"]), ("fulfilled", "test"))
        self.assertEqual(world.execute("env.has", ["MODE"]), ("fulfilled", True))
        self.assertEqual(world.execute("env.keys", []), ("fulfilled", ["MODE"]))

    def test_stateful_world_session_with_dynamic_io_and_strict_http(self) -> None:
        task = {
            "id": "py-stateful-world-1",
            "family": "py-stateful-world",
            "language": "py",
            "worldMode": "stateful",
            "source": "def run():\n    return 'done'\n",
            "entry": "run",
            "args": [],
            "initialWorld": {
                "fs": {"/tmp/in1.txt": "foo", "/tmp/in2.txt": "bar", "/tmp/temp.txt": "remove-me"},
                "kv": {"version": 1, "obsolete": "yes"},
                "env": {"ENDPOINT": "https://api.example.test/upload"},
            },
            "expectedFinalWorld": {
                "fs": {
                    "/tmp/in1.txt": "foo",
                    "/tmp/in2.txt": "bar",
                    "/tmp/out/result.txt": "foo+bar->200",
                },
                "kv": {"version": 2, "uploaded": True},
            },
            "expectedOutcome": {"kind": "return", "value": "foo+bar->200"},
            "fixture": {
                "calls": [
                    {
                        "operation": "http.request",
                        "arguments": [{"method": "POST", "url": "https://api.example.test/upload", "body": "foo+bar"}],
                        "status": "fulfilled",
                        "result": {"status": 200, "url": "https://api.example.test/upload", "headers": {}, "body": "200"},
                    }
                ]
            },
        }
        prepared = prepare_python_task(task, trace_format="actions-only")
        sess = create_python_session(prepared)

        # Tool declarations include stateful world tools automatically
        tool_decl = json.loads(sess.messages[1]["content"])
        decl_names = {t["function"]["name"] for t in tool_decl}
        self.assertTrue({"fs.readText", "fs.writeText", "fs.rename", "fs.unlink", "kv.get", "kv.set", "env.get"} <= decl_names)

        # Student skips redundant fs.exists, reads in2 before in1, writes temp file, reads it back,
        # renames it, deletes /tmp/temp.txt, mutates KV, calls strict HTTP request
        r_env = sess.step(_tc("env.get", ["ENDPOINT"], "s1"), 5)
        self.assertEqual(json.loads(r_env["messages"][0]["content"])["value"], "https://api.example.test/upload")
        r_f2 = sess.step(_tc("fs.readText", ["/tmp/in2.txt"], "s2"), 10)
        self.assertEqual(json.loads(r_f2["messages"][0]["content"])["value"], "bar")
        r_f1 = sess.step(_tc("fs_read_text", ["/tmp/in1.txt"], "s3"), 15)
        self.assertEqual(json.loads(r_f1["messages"][0]["content"])["value"], "foo")
        # Non-existent file read returns rejected observation without ending rollout
        r_miss = sess.step(_tc("fs.readText", ["/tmp/does_not_exist.txt"], "s4"), 20)
        self.assertFalse(r_miss["done"])
        self.assertEqual(json.loads(r_miss["messages"][0]["content"])["status"], "rejected")

        # Strict external HTTP call (using 4-positional canonicalized form!)
        r_http = sess.step(_tc("http.request", ["https://api.example.test/upload", "POST", {}, "foo+bar"], "h1"), 25)
        self.assertFalse(r_http["done"])
        self.assertEqual(json.loads(r_http["messages"][0]["content"])["value"]["body"], "200")

        # Dynamic write -> read back -> rename -> unlink -> KV updates
        sess.step(_tc("fs.writeText", ["/tmp/out/draft.txt", "foo+bar"], "s5"), 30)
        sess.step(_tc("fs.appendText", ["/tmp/out/draft.txt", "->200"], "s6"), 35)
        r_back = sess.step(_tc("fs.readText", ["/tmp/out/draft.txt"], "s7"), 40)
        self.assertEqual(json.loads(r_back["messages"][0]["content"])["value"], "foo+bar->200")
        sess.step(_tc("fs.rename", ["/tmp/out/draft.txt", "/tmp/out/result.txt"], "s8"), 45)
        sess.step(_tc("fs.remove", ["/tmp/temp.txt"], "s9"), 50)
        sess.step(_tc("kv_set", ["version", 2], "s10"), 55)
        sess.step(_tc("kv_del", ["obsolete"], "s11"), 60)
        sess.step(_tc("kv.set", ["uploaded", True], "s12"), 65)

        fin = sess.step(json.dumps({"type": "complete", "kind": "return", "arguments": [], "value": "foo+bar->200"}), 75)
        self.assertTrue(fin["done"])
        self.assertTrue(fin["grade"]["success"])
        self.assertEqual(fin["grade"]["matchedExternalCalls"], 1)
        self.assertEqual(fin["grade"]["expectedExternalCalls"], 1)
        self.assertEqual(fin["grade"]["worldCalls"], 12)
        self.assertEqual(fin["grade"]["finalWorld"]["fs"]["/tmp/out/result.txt"], "foo+bar->200")

        # Wrong file content fails with world-state-mismatch
        s_bad_fs = create_python_session(prepared)
        s_bad_fs.step(_tc("http.request", [{"method": "POST", "url": "https://api.example.test/upload", "body": "foo+bar"}], "bh1"), 5)
        s_bad_fs.step(_tc("fs.writeText", ["/tmp/out/result.txt", "WRONG"], "bf1"), 10)
        s_bad_fs.step(_tc("fs.unlink", ["/tmp/temp.txt"], "bf2"), 15)
        s_bad_fs.step(_tc("kv.set", ["version", 2], "bk1"), 20)
        s_bad_fs.step(_tc("kv.delete", ["obsolete"], "bk2"), 25)
        s_bad_fs.step(_tc("kv.set", ["uploaded", True], "bk3"), 30)
        bad_fs_fin = s_bad_fs.step(json.dumps({"type": "complete", "kind": "return", "arguments": [], "value": "foo+bar->200"}), 40)
        self.assertTrue(bad_fs_fin["done"])
        self.assertFalse(bad_fs_fin["grade"]["success"])
        self.assertEqual(bad_fs_fin["grade"]["failureCategory"], "world-state-mismatch")

        # Wrong KV state fails with world-state-mismatch
        s_bad_kv = create_python_session(prepared)
        s_bad_kv.step(_tc("http.request", [{"method": "POST", "url": "https://api.example.test/upload", "body": "foo+bar"}], "kh1"), 5)
        s_bad_kv.step(_tc("fs.writeText", ["/tmp/out/result.txt", "foo+bar->200"], "kf1"), 10)
        s_bad_kv.step(_tc("fs.unlink", ["/tmp/temp.txt"], "kf2"), 15)
        s_bad_kv.step(_tc("kv.set", ["version", 999], "kk1"), 20)
        s_bad_kv.step(_tc("kv.delete", ["obsolete"], "kk2"), 25)
        s_bad_kv.step(_tc("kv.set", ["uploaded", True], "kk3"), 30)
        bad_kv_fin = s_bad_kv.step(json.dumps({"type": "complete", "kind": "return", "arguments": [], "value": "foo+bar->200"}), 40)
        self.assertTrue(bad_kv_fin["done"])
        self.assertFalse(bad_kv_fin["grade"]["success"])
        self.assertEqual(bad_kv_fin["grade"]["failureCategory"], "world-state-mismatch")

        # Skipping the strict non-world HTTP call still fails with missing-external-effects
        s_skip_http = create_python_session(prepared)
        s_skip_http.step(_tc("fs.writeText", ["/tmp/out/result.txt", "foo+bar->200"], "mf1"), 10)
        s_skip_http.step(_tc("fs.unlink", ["/tmp/temp.txt"], "mf2"), 15)
        s_skip_http.step(_tc("kv.set", ["version", 2], "mk1"), 20)
        s_skip_http.step(_tc("kv.delete", ["obsolete"], "mk2"), 25)
        s_skip_http.step(_tc("kv.set", ["uploaded", True], "mk3"), 30)
        skip_fin = s_skip_http.step(json.dumps({"type": "complete", "kind": "return", "arguments": [], "value": "foo+bar->200"}), 40)
        self.assertTrue(skip_fin["done"])
        self.assertFalse(skip_fin["grade"]["success"])
        self.assertEqual(skip_fin["grade"]["failureCategory"], "missing-external-effects")


class CliExecutionModeTests(unittest.TestCase):
    def test_cli_action_parser_accepts_both_cli_forms(self) -> None:
        a1 = parse_student_action('```json\n{"kind":"cli","exitCode":0,"stdout":"ok\\n","stderr":""}\n```')
        self.assertEqual(a1, {"type": "complete", "kind": "cli", "exitCode": 0, "stdout": "ok\n", "stderr": ""})
        a2 = parse_student_action('{"type":"complete","kind":"cli","exitCode":2,"stdout":"","stderr":"err\\n"}')
        self.assertEqual(a2, {"type": "complete", "kind": "cli", "exitCode": 2, "stdout": "", "stderr": "err\n"})
        with self.assertRaises(TypeError):
            parse_student_action('{"kind":"cli","exitCode":true,"stdout":"","stderr":""}')
        with self.assertRaises(TypeError):
            parse_student_action('{"kind":"cli","exitCode":0,"stdout":123,"stderr":""}')

    def test_cli_mode_with_pytest_style_multifile_and_stateful_fs(self) -> None:
        cli_task = {
            "id": "py-cli-pytest-1",
            "family": "py-cli-pytest",
            "language": "py",
            "executionKind": "cli",
            "worldMode": "stateful",
            "files": {
                "tests/test_cli.py": "def test_sum():\n    assert 1 + 1 == 2\n",
                "app.py": "import sys\nprint(sum(int(x) for x in sys.stdin.read().split()))\n",
            },
            "entryFile": "app.py",
            "argv": ["python", "app.py", "--write", "/tmp/sum.txt"],
            "stdin": "10 20 12\n",
            "initialWorld": {"fs": {"/tmp/prefix.txt": "SUM="}},
            "expectedFinalWorld": {"fs": {"/tmp/prefix.txt": "SUM=", "/tmp/sum.txt": "SUM=42"}},
            "expectedCli": {"exitCode": 0, "stdout": "42\n", "stderr": ""},
        }

        prepared = prepare_python_task(cli_task, trace_format="actions-only")
        self.assertEqual(prepared["outcome"]["kind"], "cli")
        sess = PythonExecutionSession(prepared)
        self.assertIn('"kind":"cli"', sess.messages[0]["content"])
        user_msg = sess.messages[-1]["content"]
        self.assertIn('Command argv: ["python","app.py","--write","/tmp/sum.txt"]', user_msg)
        self.assertIn('Stdin: "10 20 12\\n"', user_msg)

        # Student reads prefix, writes /tmp/sum.txt, completes with {"kind":"cli",...}
        p_obs = sess.step(_tc("fs.readText", ["/tmp/prefix.txt"], "p1"), 5)
        self.assertEqual(json.loads(p_obs["messages"][0]["content"])["value"], "SUM=")
        sess.step(_tc("fs.writeText", ["/tmp/sum.txt", "SUM=42"], "p2"), 10)
        fin = sess.step('```json\n{"kind":"cli","exitCode":0,"stdout":"42\\n","stderr":""}\n```', 20)
        self.assertTrue(fin["done"])
        self.assertTrue(fin["grade"]["success"])
        self.assertIsNone(fin["grade"]["failureCategory"])

        # Strict failure categories
        failure_cases = [
            ({"kind": "cli", "exitCode": 1, "stdout": "42\n", "stderr": ""}, True, "wrong-exit-code"),
            ({"kind": "cli", "exitCode": 0, "stdout": "41\n", "stderr": ""}, True, "wrong-stdout"),
            ({"kind": "cli", "exitCode": 0, "stdout": "42\n", "stderr": "oops"}, True, "wrong-stderr"),
            ({"kind": "cli", "exitCode": 0, "stdout": "42\n", "stderr": ""}, False, "world-state-mismatch"),
            ({"type": "complete", "kind": "return", "arguments": [], "value": 42}, True, "wrong-completion-kind"),
        ]
        for payload, do_write, expected_cat in failure_cases:
            s = create_cli_session(cli_task)
            if do_write:
                s.step(_tc("fs.writeText", ["/tmp/sum.txt", "SUM=42"], "w1"), 5)
            r = s.step(json.dumps(payload), 15)
            self.assertTrue(r["done"])
            self.assertFalse(r["grade"]["success"])
            self.assertEqual(r["grade"]["failureCategory"], expected_cat, f"expected {expected_cat}")


if __name__ == "__main__":
    unittest.main()
