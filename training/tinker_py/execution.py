"""Python execution task preparation, causal conversation export, audit, and live grading session.

Mirrors src/training/tinker-execution.js and src/training/tinker-supervision.js
for native Python execution with sys.settrace compact traces.
"""

from __future__ import annotations

import ast
import copy
from functools import lru_cache
import hashlib
import json
from pathlib import Path
import posixpath
import re
import subprocess
import sys
import tempfile
from typing import Any

from .codebase import (
    CODE_LOAD_OPERATION,
    CODE_LOAD_TOOL_DESCRIPTION,
    is_multifile_task,
    normalize_codebase_files,
    normalized_multifile_source_hash,
    render_repo_manifest,
    serve_code_load,
)
from .codec import decode_readable, describe_graph, encode_readable, realize_graph

TINKER_PY_EXECUTION_SCHEMA = "readable-py-execution/1"
TINKER_TRACE_FORMATS = ("full", "compact", "actions-only")
TINKER_REASONING_CHANNELS = ("thinking", "text")

PY_HOST_METHODS: dict[str, str] = {
    "fs_read_text": "fs.readText",
    "fs_write_text": "fs.writeText",
    "http_get": "http.get",
    "http_request": "http.request",
    "kv_get": "kv_get",
    "kv_set": "kv_set",
}

OPERATION_ALIASES: dict[str, str] = {
    "fs_read_text": "fs.readText",
    "fs_write_text": "fs.writeText",
    "fs_exists": "fs.exists",
    "fs_listdir": "fs.readdir",
    "fs.listdir": "fs.readdir",
    "fs_stat": "fs.stat",
    "fs_read_bytes": "fs.readBytes",
    "fs_write_bytes": "fs.writeBytes",
    "fs_mkdir": "fs.mkdir",
    "fs_unlink": "fs.unlink",
    "fs.remove": "fs.unlink",
    "fs_remove": "fs.unlink",
    "fs_rename": "fs.rename",
    "fs_append_text": "fs.appendText",
    "fs_copy_file": "fs.copyFile",
    "fs_is_file": "fs.isFile",
    "fs_is_dir": "fs.isDir",
    "http_request": "http.request",
    "http_get": "http.get",
    "kv_get": "kv.get",
    "kv_set": "kv.set",
    "kv_del": "kv.delete",
    "kv_delete": "kv.delete",
    "kv_has": "kv.has",
    "kv_keys": "kv.keys",
    "env_get": "env.get",
    "env_has": "env.has",
    "env_keys": "env.keys",
}


def canonicalize_operation_name(op: Any) -> Any:
    if not isinstance(op, str):
        return op
    return OPERATION_ALIASES.get(op, op)


PY_HOST_OPERATIONS: dict[str, dict[str, Any]] = {
    "platform.print": {"arity": None, "commutativeRead": False, "description": "Invoke Python print(*args) external operation."},
    "platform.time": {
        "arity": 0,
        "commutativeRead": False,
        "description": "Invoke Python time.time()/time.monotonic()/datetime.now()/today() external clock operation (0 arguments).",
    },
    "platform.random": {"arity": 0, "commutativeRead": False, "description": "Invoke Python random.random() external operation (0 arguments)."},
    "platform.log": {
        "arity": 2,
        "commutativeRead": False,
        "description": "Invoke Python logging operation (2 arguments: [level_name, formatted_message]). Returns None.",
    },
    "platform.uuid": {
        "arity": 0,
        "commutativeRead": False,
        "description": "Invoke Python uuid.uuid4() external operation (0 arguments). Returns canonical UUID string.",
    },
    "platform.secrets": {
        "arity": 2,
        "commutativeRead": False,
        "description": 'Invoke Python secrets external operation (2 arguments: [method_name, int_arg], e.g. ["token_hex", 16] or ["randbelow", 100]).',
    },
    "fs.readText": {"arity": 1, "commutativeRead": True, "description": "Invoke Python external operation fs.readText (1 argument: [path])."},
    "fs.readBytes": {"arity": 1, "commutativeRead": True, "description": "Read binary file contents from path (1 argument: [path]). Returns bytes."},
    "fs.writeText": {"arity": 2, "commutativeRead": False, "description": "Invoke Python external operation fs.writeText (2 arguments: [path, text])."},
    "fs.writeBytes": {"arity": 2, "commutativeRead": False, "description": "Write binary bytes to path (2 arguments: [path, data]). Returns None."},
    "fs.appendText": {"arity": 2, "commutativeRead": False, "description": "Append UTF-8 text to file at path (2 arguments: [path, text]). Returns None."},
    "fs.exists": {"arity": 1, "commutativeRead": True, "description": "Check whether filesystem path exists (1 argument: [path]). Returns bool."},
    "fs.isFile": {"arity": 1, "commutativeRead": True, "description": "Check whether filesystem path is a regular file (1 argument: [path]). Returns bool."},
    "fs.isDir": {"arity": 1, "commutativeRead": True, "description": "Check whether filesystem path is a directory (1 argument: [path]). Returns bool."},
    "fs.stat": {"arity": 1, "commutativeRead": True, "description": "Stat filesystem path (1 argument: [path]). Returns {\"isFile\": bool, \"isDirectory\": bool, \"size\": int}."},
    "fs.listdir": {"arity": 1, "commutativeRead": True, "description": "List entry names in directory path (1 argument: [path]). Returns sorted list of strings."},
    "fs.readdir": {"arity": 1, "commutativeRead": True, "description": "List entry names in directory path (1 argument: [path]). Returns sorted list of strings."},
    "fs.mkdir": {"arity": 1, "commutativeRead": False, "description": "Create directory at path (1-2 arguments: [path, options?]). Returns None."},
    "fs.unlink": {"arity": 1, "commutativeRead": False, "description": "Delete file at path (1 argument: [path]). Returns None."},
    "fs.remove": {"arity": 1, "commutativeRead": False, "description": "Delete file at path (1 argument: [path]). Returns None."},
    "fs.rename": {"arity": 2, "commutativeRead": False, "description": "Rename/move path from old_path to new_path (2 arguments: [old_path, new_path]). Returns None."},
    "fs.copyFile": {"arity": 2, "commutativeRead": False, "description": "Copy file from src to dest (2 arguments: [src, dest]). Returns None."},
    "env.get": {"arity": 1, "commutativeRead": True, "description": "Read environment variable (1 argument: [key]). Returns string value or None."},
    "env.has": {"arity": 1, "commutativeRead": True, "description": "Check whether environment variable is set (1 argument: [key]). Returns bool."},
    "env.keys": {"arity": 0, "commutativeRead": True, "description": "List sorted environment variable names (0 arguments: [])."},
    "shell.exec": {
        "arity": 1,
        "commutativeRead": False,
        "description": (
            'Execute subprocess command (1 argument: {"args": str | list[str], "shell": bool}). '
            'Returns {"returncode": int, "stdout": str | bytes, "stderr": str | bytes}.'
        ),
    },
    "http.get": {"arity": 1, "commutativeRead": True, "description": "Invoke Python external operation http.get (1 argument)."},
    "http.request": {
        "arity": 1,
        "commutativeRead": False,
        "description": (
            'Invoke Python external HTTP request (1 argument: canonical dict {"method":"GET"|"POST"|...,"url":str,'
            '"headers"?:dict[str,str],"body"?:str|bytes}; omit "headers" if empty and "body" if None). '
            'Returns {"status":int,"url":str,"headers":dict[str,str],"body":str|bytes}.'
        ),
    },
    "kv_get": {"arity": 1, "commutativeRead": True, "description": "Invoke Python external operation kv_get (1 argument)."},
    "kv_set": {"arity": 2, "commutativeRead": False, "description": "Invoke Python external operation kv_set (2 arguments)."},
    "kv_del": {"arity": 1, "commutativeRead": False, "description": "Delete key from virtual KV store (1 argument: [key]). Returns bool."},
    "kv_has": {"arity": 1, "commutativeRead": True, "description": "Check whether key exists in virtual KV store (1 argument: [key]). Returns bool."},
    "kv.get": {"arity": 1, "commutativeRead": True, "description": "Read value for key from virtual KV store (1 argument: [key])."},
    "kv.set": {"arity": 2, "commutativeRead": False, "description": "Set value for key in virtual KV store (2 arguments: [key, value])."},
    "kv.delete": {"arity": 1, "commutativeRead": False, "description": "Delete key from virtual KV store (1 argument: [key]). Returns bool."},
    "kv.has": {"arity": 1, "commutativeRead": True, "description": "Check whether key exists in virtual KV store (1 argument: [key]). Returns bool."},
    "kv.keys": {"arity": 0, "commutativeRead": True, "description": "List sorted keys in virtual KV store (0 arguments: [])."},
}

BUILTIN_OPERATIONS: dict[str, dict[str, Any]] = PY_HOST_OPERATIONS

STATEFUL_WORLD_OPERATIONS: frozenset[str] = frozenset({
    "fs.exists",
    "fs.isFile",
    "fs.isDir",
    "fs.stat",
    "fs.readdir",
    "fs.readText",
    "fs.readBytes",
    "fs.writeText",
    "fs.writeBytes",
    "fs.appendText",
    "fs.mkdir",
    "fs.unlink",
    "fs.rename",
    "fs.copyFile",
    "kv.get",
    "kv.set",
    "kv.delete",
    "kv.has",
    "kv.keys",
    "env.get",
    "env.has",
    "env.keys",
})


def is_stateful_world_operation(op: Any) -> bool:
    return isinstance(op, str) and canonicalize_operation_name(op) in STATEFUL_WORLD_OPERATIONS


def _normalize_virtual_path(raw_path: Any) -> str:
    _demand(isinstance(raw_path, str) and len(raw_path) > 0, "Virtual path must be a non-empty string")
    norm = posixpath.normpath(raw_path)
    if len(norm) > 1 and norm.endswith("/"):
        norm = norm[:-1]
    if norm.startswith("./"):
        norm = norm[2:]
    return norm or "."


def _virtual_parent_dirs(norm_path: str) -> list[str]:
    parents: list[str] = []
    cur = norm_path
    while True:
        parent = posixpath.dirname(cur)
        if not parent or parent == cur:
            break
        parents.append(parent)
        cur = parent
        if parent in ("/", "."):
            break
    return parents


class StatefulVirtualWorld:
    """Live in-memory mutable virtual world (fs, kv, env) for stateful rollout grading."""

    def __init__(self, initial_world: dict[str, Any] | None = None) -> None:
        init = initial_world if isinstance(initial_world, dict) else {}
        self._files: dict[str, str | bytes] = {}
        self._dirs: set[str] = {"/", "."}
        self._kv: dict[str, Any] = {}
        self._env: dict[str, str] = {}

        fs_init = init.get("fs")
        if isinstance(fs_init, dict):
            for raw_path, content in fs_init.items():
                p = _normalize_virtual_path(raw_path)
                self._files[p] = content if isinstance(content, (str, bytes)) else copy.deepcopy(content)
                self._record_ancestors(p)

        kv_init = init.get("kv")
        if isinstance(kv_init, dict):
            for k, v in kv_init.items():
                self._kv[str(k)] = copy.deepcopy(v)

        env_init = init.get("env")
        if isinstance(env_init, dict):
            for k, v in env_init.items():
                if v is not None:
                    self._env[str(k)] = str(v)

    def _record_ancestors(self, norm_path: str) -> None:
        for parent in _virtual_parent_dirs(norm_path):
            self._dirs.add(parent)

    def _is_dir(self, p: str) -> bool:
        if p in self._files:
            return False
        if p in ("/", ".") or p in self._dirs:
            return True
        prefix = "/" if p == "/" else ("" if p == "." else p + "/")
        for key in self._files:
            if p == "/":
                if key.startswith("/"):
                    return True
            elif p == ".":
                if not key.startswith("/"):
                    return True
            elif key.startswith(prefix):
                return True
        if p not in ("/", "."):
            for d in self._dirs:
                if d.startswith(prefix):
                    return True
        return False

    def execute(self, operation: str, args: list[Any]) -> tuple[str, Any]:
        _demand(isinstance(args, list), "World call arguments must be a list")
        op = canonicalize_operation_name(operation)

        if op == "fs.exists":
            _demand(len(args) == 1 and isinstance(args[0], str), "fs.exists expects [path]")
            p = _normalize_virtual_path(args[0])
            return ("fulfilled", p in self._files or self._is_dir(p))

        if op == "fs.isFile":
            _demand(len(args) == 1 and isinstance(args[0], str), "fs.isFile expects [path]")
            return ("fulfilled", _normalize_virtual_path(args[0]) in self._files)

        if op == "fs.isDir":
            _demand(len(args) == 1 and isinstance(args[0], str), "fs.isDir expects [path]")
            return ("fulfilled", self._is_dir(_normalize_virtual_path(args[0])))

        if op == "fs.stat":
            _demand(len(args) == 1 and isinstance(args[0], str), "fs.stat expects [path]")
            p = _normalize_virtual_path(args[0])
            if p in self._files:
                val = self._files[p]
                size = len(val.encode("utf-8")) if isinstance(val, str) else len(val)
                return ("fulfilled", {"isFile": True, "isDirectory": False, "size": size})
            if self._is_dir(p):
                return ("fulfilled", {"isFile": False, "isDirectory": True, "size": 0})
            return ("rejected", {"name": "FileNotFoundError", "message": f"ENOENT: no such file or directory: '{args[0]}'"})

        if op == "fs.readdir":
            _demand(len(args) == 1 and isinstance(args[0], str), "fs.readdir expects [path]")
            p = _normalize_virtual_path(args[0])
            if p in self._files:
                return ("rejected", {"name": "NotADirectoryError", "message": f"ENOTDIR: not a directory: '{args[0]}'"})
            if not self._is_dir(p):
                return ("rejected", {"name": "FileNotFoundError", "message": f"ENOENT: no such file or directory: '{args[0]}'"})
            entries: set[str] = set()

            def _collect(key: str) -> None:
                if p == "/":
                    if key.startswith("/") and len(key) > 1:
                        entries.add(key[1:].split("/", 1)[0])
                elif p == ".":
                    if not key.startswith("/") and key != ".":
                        entries.add(key.split("/", 1)[0])
                elif key.startswith(p + "/"):
                    entries.add(key[len(p) + 1 :].split("/", 1)[0])

            for k in self._files:
                _collect(k)
            for d in self._dirs:
                _collect(d)
            return ("fulfilled", sorted(entries))

        if op == "fs.readText":
            _demand(len(args) == 1 and isinstance(args[0], str), "fs.readText expects [path]")
            p = _normalize_virtual_path(args[0])
            if p not in self._files:
                return ("rejected", {"name": "FileNotFoundError", "message": f"ENOENT: no such file or directory: '{args[0]}'"})
            val = self._files[p]
            return ("fulfilled", val if isinstance(val, str) else val.decode("utf-8"))

        if op == "fs.readBytes":
            _demand(len(args) == 1 and isinstance(args[0], str), "fs.readBytes expects [path]")
            p = _normalize_virtual_path(args[0])
            if p not in self._files:
                return ("rejected", {"name": "FileNotFoundError", "message": f"ENOENT: no such file or directory: '{args[0]}'"})
            val = self._files[p]
            return ("fulfilled", val if isinstance(val, bytes) else val.encode("utf-8"))

        if op == "fs.writeText":
            _demand(len(args) == 2 and isinstance(args[0], str) and isinstance(args[1], str), "fs.writeText expects [path, text]")
            p = _normalize_virtual_path(args[0])
            self._files[p] = args[1]
            self._record_ancestors(p)
            return ("fulfilled", None)

        if op == "fs.writeBytes":
            _demand(len(args) == 2 and isinstance(args[0], str) and isinstance(args[1], (bytes, bytearray, str)), "fs.writeBytes expects [path, bytes]")
            p = _normalize_virtual_path(args[0])
            data = bytes(args[1]) if isinstance(args[1], (bytes, bytearray)) else args[1].encode("utf-8")
            self._files[p] = data
            self._record_ancestors(p)
            return ("fulfilled", None)

        if op == "fs.appendText":
            _demand(len(args) == 2 and isinstance(args[0], str) and isinstance(args[1], str), "fs.appendText expects [path, text]")
            p = _normalize_virtual_path(args[0])
            prev_val = self._files.get(p, "")
            prev_str = prev_val if isinstance(prev_val, str) else prev_val.decode("utf-8")
            self._files[p] = prev_str + args[1]
            self._record_ancestors(p)
            return ("fulfilled", None)

        if op == "fs.mkdir":
            _demand(len(args) in (1, 2) and isinstance(args[0], str), "fs.mkdir expects [path, options?]")
            p = _normalize_virtual_path(args[0])
            if p in self._files:
                return ("rejected", {"name": "FileExistsError", "message": f"EEXIST: file exists: '{args[0]}'"})
            opts = args[1] if len(args) == 2 and isinstance(args[1], dict) else {}
            if opts.get("recursive") is False:
                parent = posixpath.dirname(p)
                if parent and parent != p and not self._is_dir(parent):
                    return ("rejected", {"name": "FileNotFoundError", "message": f"ENOENT: no such file or directory: '{args[0]}'"})
            self._dirs.add(p)
            self._record_ancestors(p)
            return ("fulfilled", None)

        if op == "fs.unlink":
            _demand(len(args) == 1 and isinstance(args[0], str), "fs.unlink expects [path]")
            p = _normalize_virtual_path(args[0])
            if p not in self._files:
                return ("rejected", {"name": "FileNotFoundError", "message": f"ENOENT: no such file or directory: '{args[0]}'"})
            del self._files[p]
            return ("fulfilled", None)

        if op == "fs.rename":
            _demand(len(args) == 2 and isinstance(args[0], str) and isinstance(args[1], str), "fs.rename expects [old_path, new_path]")
            src = _normalize_virtual_path(args[0])
            dst = _normalize_virtual_path(args[1])
            if src in self._files:
                self._files[dst] = self._files.pop(src)
                self._record_ancestors(dst)
                return ("fulfilled", None)
            if self._is_dir(src) and src not in ("/", "."):
                prefix = src + "/"
                moved_files = [(k, v) for k, v in self._files.items() if k.startswith(prefix)]
                for k, v in moved_files:
                    del self._files[k]
                    nk = dst + k[len(src) :]
                    self._files[nk] = v
                    self._record_ancestors(nk)
                moved_dirs = [d for d in self._dirs if d == src or d.startswith(prefix)]
                for d in moved_dirs:
                    self._dirs.discard(d)
                for d in moved_dirs:
                    nd = dst + d[len(src) :]
                    self._dirs.add(nd)
                    self._record_ancestors(nd)
                self._dirs.add(dst)
                self._record_ancestors(dst)
                return ("fulfilled", None)
            return ("rejected", {"name": "FileNotFoundError", "message": f"ENOENT: no such file or directory: '{args[0]}'"})

        if op == "fs.copyFile":
            _demand(len(args) == 2 and isinstance(args[0], str) and isinstance(args[1], str), "fs.copyFile expects [src, dest]")
            src = _normalize_virtual_path(args[0])
            dst = _normalize_virtual_path(args[1])
            if src not in self._files:
                return ("rejected", {"name": "FileNotFoundError", "message": f"ENOENT: no such file or directory: '{args[0]}'"})
            self._files[dst] = copy.deepcopy(self._files[src])
            self._record_ancestors(dst)
            return ("fulfilled", None)

        if op == "kv.get":
            _demand(len(args) == 1 and isinstance(args[0], str), "kv.get expects [key]")
            return ("fulfilled", copy.deepcopy(self._kv[args[0]]) if args[0] in self._kv else None)

        if op == "kv.set":
            _demand(len(args) == 2 and isinstance(args[0], str), "kv.set expects [key, value]")
            self._kv[args[0]] = copy.deepcopy(args[1])
            return ("fulfilled", None)

        if op == "kv.delete":
            _demand(len(args) == 1 and isinstance(args[0], str), "kv.delete expects [key]")
            existed = args[0] in self._kv
            self._kv.pop(args[0], None)
            return ("fulfilled", existed)

        if op == "kv.has":
            _demand(len(args) == 1 and isinstance(args[0], str), "kv.has expects [key]")
            return ("fulfilled", args[0] in self._kv)

        if op == "kv.keys":
            _demand(len(args) == 0, "kv.keys expects []")
            return ("fulfilled", sorted(self._kv.keys()))

        if op == "env.get":
            _demand(len(args) == 1 and isinstance(args[0], str), "env.get expects [key]")
            return ("fulfilled", self._env.get(args[0]))

        if op == "env.has":
            _demand(len(args) == 1 and isinstance(args[0], str), "env.has expects [key]")
            return ("fulfilled", args[0] in self._env)

        if op == "env.keys":
            _demand(len(args) == 0, "env.keys expects []")
            return ("fulfilled", sorted(self._env.keys()))

        raise TypeError(f"Unsupported stateful world operation {operation}")

    def snapshot(self) -> dict[str, dict[str, Any]]:
        return {
            "fs": {k: copy.deepcopy(self._files[k]) for k in sorted(self._files)},
            "kv": {k: copy.deepcopy(self._kv[k]) for k in sorted(self._kv)},
            "env": {k: self._env[k] for k in sorted(self._env)},
        }

    def matches_expected_final_world(self, expected_final_world: dict[str, Any] | None) -> bool:
        if expected_final_world is None:
            return True
        if "fs" in expected_final_world and expected_final_world["fs"] is not None:
            exp_fs_raw = expected_final_world["fs"]
            if not isinstance(exp_fs_raw, dict):
                return False
            exp_fs = {_normalize_virtual_path(k): v for k, v in exp_fs_raw.items()}
            if set(self._files.keys()) != set(exp_fs.keys()):
                return False
            for k, exp_v in exp_fs.items():
                if type(self._files[k]) is not type(exp_v) or self._files[k] != exp_v:
                    return False
        if "kv" in expected_final_world and expected_final_world["kv"] is not None:
            exp_kv = expected_final_world["kv"]
            if not isinstance(exp_kv, dict):
                return False
            if set(self._kv.keys()) != set(exp_kv.keys()):
                return False
            for k, exp_v in exp_kv.items():
                if describe_graph([self._kv[k]]) != describe_graph([exp_v]):
                    return False
        return True


SYSTEM_PROMPT = """Execute the supplied Python program directly and accurately.
- Never invoke undeclared tools or attempt to run the program via an external shell or interpreter.
- When execution finishes, end with one JSON completion in a ```json code fence (or bare JSON):
  {"type":"complete","kind":"return"|"throw","arguments":[final input args],"value":resultOrError}
- Final "arguments" must reflect all input mutations and aliases. Standard exceptions use {"name":"ValueError","message":"..."}.
- Special Python values: {"$py":"NaN"|"-0"|"Infinity"|"-Infinity"}, {"$py":"tuple","items":[...]}, {"$py":"set","items":[...]}, {"$py":"frozenset","items":[...]}, {"$py":"bytes","b64":"..."}, {"$py":"complex","real":...,"imag":...}, {"$py":"decimal","value":"..."}, {"$py":"datetime","iso":"..."}, {"$py":"date","iso":"..."}, {"$py":"timedelta","days":...,"seconds":...,"microseconds":...}, {"$py":"path","value":"..."}, {"$py":"enum","class":"...","name":"...","value":...}, {"$py":"object","class":"...","attrs":{...}}, {"$py":"dict","entries":[[k,v],...]} for non-string or $py-keyed dicts, {"$py":"ref","path":"/arguments/0"} (paths rooted at {arguments,value} for completions or at the arguments array for tool calls)."""

CLI_SYSTEM_PROMPT = """Execute the supplied Python CLI command directly and accurately.
- Never invoke undeclared tools or attempt to run the program via an external shell or interpreter.
- When execution finishes, end with one JSON completion in a ```json code fence (or bare JSON):
  {"kind":"cli","exitCode":0,"stdout":"...","stderr":"..."}
  ({"type":"complete","kind":"cli","exitCode":0,"stdout":"...","stderr":"..."} is also accepted.)
- Report the exact integer exitCode, exact stdout string, and exact stderr string produced by running the command with the given argv and stdin."""


def _build_system_prompt(
    operations: list[str],
    *,
    multifile: bool = False,
    execution_kind: str = "function",
    world_mode: str = "scripted",
) -> str:
    base_prompt = CLI_SYSTEM_PROMPT if execution_kind == "cli" else SYSTEM_PROMPT
    extra: list[str] = []
    if operations:
        extra.append(
            '- Only invoke tools explicitly declared in tool_declare with {"arguments":[...]} in exact execution order '
            "for external calls made by the program; never invent observations."
        )
    if world_mode == "stateful":
        extra.append(
            "- Stateful virtual world mode: fs.*, kv.*, and env.* operations execute live against the mutable virtual world and reflect prior mutations."
        )
    io_hints: list[str] = []
    if any(op.startswith("fs.") for op in operations):
        io_hints.append(
            "filesystem calls (open/Path/os.listdir/os.path) map to "
            "fs.readText/fs.readBytes/fs.writeText/fs.writeBytes/fs.exists/fs.isFile/fs.isDir/fs.listdir"
        )
    if "env.get" in operations:
        io_hints.append("env (os.getenv/os.environ) maps to env.get")
    if "platform.log" in operations:
        io_hints.append("logging maps to platform.log")
    if "shell.exec" in operations:
        io_hints.append("subprocess.run/check_output maps to shell.exec")
    if "platform.time" in operations:
        io_hints.append("datetime.now/utcnow/today maps to platform.time")
    if "platform.uuid" in operations:
        io_hints.append("uuid.uuid4 maps to platform.uuid")
    if "platform.secrets" in operations:
        io_hints.append("secrets maps to platform.secrets")
    if io_hints:
        extra.append("- Declared I/O mappings: " + "; ".join(io_hints) + ".")
    if "http.request" in operations:
        extra.append(
            '- HTTP calls (urllib.request.urlopen, requests.get/post/request/Session) invoke http.request with '
            '{"arguments":[{"method":"GET"|...,"url":str,"headers"?:{...},"body"?:str|bytes}]} '
            '(omit empty "headers" and None "body").'
        )
    if multifile or CODE_LOAD_OPERATION in operations:
        extra.append(
            '- Multi-file repository mode: only the entry file is shown initially. Call code.load with '
            '{"arguments":[{"path":"..."}]} (whole file for small files) or '
            '{"arguments":[{"path":"...","symbol":"..."}]} (symbol snippet for large files) or '
            '{"arguments":[{"path":"...","start_line":N,"end_line":M}]} whenever you need code from another file; '
            "you may batch multiple requests."
        )
    return base_prompt + ("\n" + "\n".join(extra) if extra else "")


MULTIFILE_SYSTEM_PROMPT = _build_system_prompt([CODE_LOAD_OPERATION], multifile=True)


def _demand(condition: bool, message: str) -> None:
    if not condition:
        raise TypeError(message)


def _json_compact(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def _sha256(value: Any) -> str:
    text = value if isinstance(value, str) else _json_compact(value)
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _worker_path() -> Path:
    return Path(__file__).resolve().parents[2] / "tools" / "python-reference-worker.py"


def normalized_py_source_hash(source: str) -> str:
    """AST-normalized SHA-256 hash of Python source (ignoring formatting/comments/line numbers)."""
    tree = ast.parse(source)
    return _sha256(ast.dump(tree, include_attributes=False))


def _validate_trace_format(trace_format: str) -> str:
    _demand(trace_format in TINKER_TRACE_FORMATS, "traceFormat must be full, compact, or actions-only")
    return trace_format


def _validate_reasoning_channel(channel: str) -> str:
    _demand(channel in TINKER_REASONING_CHANNELS, "reasoningChannel must be thinking or text")
    return channel


def assistant_visible_text(message: Any) -> str:
    if isinstance(message, str):
        return message
    content = message.get("content", "") if isinstance(message, dict) else ""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(
            part.get("text", "")
            for part in content
            if isinstance(part, dict) and part.get("type") in ("text", "output_text")
        )
    return ""


def assistant_thinking_text(message: Any) -> str:
    if not isinstance(message, dict):
        return ""
    content = message.get("content")
    if not isinstance(content, list):
        return ""
    return "\n".join(
        part.get("thinking", "")
        for part in content
        if isinstance(part, dict) and part.get("type") == "thinking"
    )


_HTTP_REQUESTS_MEMBERS = frozenset({
    "get",
    "post",
    "put",
    "delete",
    "patch",
    "head",
    "options",
    "request",
    "Session",
    "session",
    "api",
})


_LOG_METHODS = frozenset({"debug", "info", "warning", "warn", "error", "critical", "fatal", "exception", "log"})
_SECRETS_METHODS = frozenset({"token_hex", "token_urlsafe", "token_bytes", "randbelow", "randbits", "choice"})
_SUBPROCESS_FUNCS = frozenset({"run", "check_output"})
_PATH_IO_DIRECT_METHODS = frozenset({"read_text", "write_text", "read_bytes", "write_bytes", "iterdir"})
_PATH_FS_METHODS = _PATH_IO_DIRECT_METHODS | frozenset({"exists", "is_file", "is_dir", "open"})


@lru_cache(maxsize=4096)
def _scan_public_source_tools_cached(source: str, random_mode: str) -> tuple[tuple[str, ...], bool]:
    names, uses_random = _scan_public_source_tools_uncached(source, random_mode, ())
    return tuple(names), uses_random


def _scan_public_source_tools(source: str, random_mode: str, native_bindings: list[dict[str, Any]]) -> tuple[list[str], bool]:
    """Derive available tool names STRICTLY from public source and bindings (NEVER fixture)."""
    base_names, uses_random = _scan_public_source_tools_cached(source, random_mode)
    if not native_bindings:
        return list(base_names), uses_random
    merged = set(base_names)
    merged.update(b["name"] for b in native_bindings)
    return sorted(merged), uses_random


def _scan_public_source_tools_uncached(
    source: str,
    random_mode: str,
    native_bindings: tuple[dict[str, Any], ...] | list[dict[str, Any]],
) -> tuple[list[str], bool]:
    """Derive available tool names STRICTLY from public source and bindings (NEVER fixture)."""
    names: set[str] = {b["name"] for b in native_bindings}
    uses_random = False
    tree = ast.parse(source)

    time_aliases: set[str] = set()
    time_direct: set[str] = set()
    datetime_aliases: set[str] = set()
    datetime_cls_aliases: set[str] = set()
    date_cls_aliases: set[str] = set()
    random_aliases: set[str] = set()
    random_direct: set[str] = set()
    urllib_root_aliases: set[str] = set()
    urllib_req_aliases: set[str] = set()
    urlopen_direct: set[str] = set()
    requests_aliases: set[str] = set()
    requests_direct: set[str] = set()
    os_aliases: set[str] = set()
    os_path_aliases: set[str] = set()
    os_getenv_direct: set[str] = set()
    os_environ_direct: set[str] = set()
    os_listdir_direct: set[str] = set()
    os_exists_direct: set[str] = set()
    os_isfile_direct: set[str] = set()
    os_isdir_direct: set[str] = set()
    io_aliases: set[str] = set()
    io_open_direct: set[str] = set()
    uses_pathlib = False
    logging_aliases: set[str] = set()
    logging_direct: set[str] = set()
    logging_imported = False
    subprocess_aliases: set[str] = set()
    subprocess_direct: set[str] = set()
    uuid_aliases: set[str] = set()
    uuid4_direct: set[str] = set()
    secrets_aliases: set[str] = set()
    secrets_direct: set[str] = set()

    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                if alias.name == "time":
                    time_aliases.add(alias.asname or "time")
                elif alias.name == "datetime":
                    datetime_aliases.add(alias.asname or "datetime")
                elif alias.name == "random":
                    random_aliases.add(alias.asname or "random")
                elif alias.name == "urllib":
                    urllib_root_aliases.add(alias.asname or "urllib")
                elif alias.name == "urllib.request":
                    if alias.asname:
                        urllib_req_aliases.add(alias.asname)
                    else:
                        urllib_root_aliases.add("urllib")
                elif alias.name.startswith("urllib.") and not alias.asname:
                    urllib_root_aliases.add("urllib")
                elif alias.name == "requests" or alias.name.startswith("requests."):
                    requests_aliases.add(alias.asname or "requests")
                elif alias.name == "os":
                    os_aliases.add(alias.asname or "os")
                elif alias.name == "os.path":
                    if alias.asname:
                        os_path_aliases.add(alias.asname)
                    else:
                        os_aliases.add("os")
                elif alias.name == "io":
                    io_aliases.add(alias.asname or "io")
                elif alias.name == "pathlib":
                    uses_pathlib = True
                elif alias.name == "logging" or alias.name.startswith("logging."):
                    logging_imported = True
                    logging_aliases.add(alias.asname or "logging")
                elif alias.name == "subprocess":
                    subprocess_aliases.add(alias.asname or "subprocess")
                elif alias.name == "uuid":
                    uuid_aliases.add(alias.asname or "uuid")
                elif alias.name == "secrets":
                    secrets_aliases.add(alias.asname or "secrets")
        elif isinstance(node, ast.ImportFrom):
            if node.module == "time":
                for alias in node.names:
                    if alias.name == "*":
                        time_direct.update(("time", "monotonic"))
                    elif alias.name in ("time", "monotonic"):
                        time_direct.add(alias.asname or alias.name)
            elif node.module == "datetime":
                for alias in node.names:
                    if alias.name == "*":
                        datetime_cls_aliases.add("datetime")
                        date_cls_aliases.add("date")
                    elif alias.name == "datetime":
                        datetime_cls_aliases.add(alias.asname or "datetime")
                    elif alias.name == "date":
                        date_cls_aliases.add(alias.asname or "date")
            elif node.module == "random":
                for alias in node.names:
                    if alias.name == "*":
                        uses_random = True
                        random_direct.add("random")
                    elif alias.name in ("random", "randint", "randrange", "choice", "uniform", "shuffle", "sample"):
                        uses_random = True
                        if alias.name == "random":
                            random_direct.add(alias.asname or "random")
            elif node.module == "urllib":
                for alias in node.names:
                    if alias.name == "request":
                        urllib_req_aliases.add(alias.asname or "request")
            elif node.module == "urllib.request":
                for alias in node.names:
                    if alias.name == "urlopen":
                        urlopen_direct.add(alias.asname or "urlopen")
                    elif alias.name == "*":
                        urlopen_direct.add("urlopen")
            elif node.module in ("requests", "requests.api", "requests.sessions"):
                for alias in node.names:
                    if alias.name in _HTTP_REQUESTS_MEMBERS:
                        requests_direct.add(alias.asname or alias.name)
                    elif alias.name == "*":
                        requests_direct.update(_HTTP_REQUESTS_MEMBERS)
            elif node.module == "os":
                for alias in node.names:
                    if alias.name == "*":
                        os_getenv_direct.add("getenv")
                        os_environ_direct.add("environ")
                        os_listdir_direct.add("listdir")
                        os_path_aliases.add("path")
                    elif alias.name == "getenv":
                        os_getenv_direct.add(alias.asname or "getenv")
                    elif alias.name == "environ":
                        os_environ_direct.add(alias.asname or "environ")
                    elif alias.name == "listdir":
                        os_listdir_direct.add(alias.asname or "listdir")
                    elif alias.name == "path":
                        os_path_aliases.add(alias.asname or "path")
            elif node.module == "os.path":
                for alias in node.names:
                    if alias.name == "*":
                        os_exists_direct.add("exists")
                        os_isfile_direct.add("isfile")
                        os_isdir_direct.add("isdir")
                    elif alias.name == "exists":
                        os_exists_direct.add(alias.asname or "exists")
                    elif alias.name == "isfile":
                        os_isfile_direct.add(alias.asname or "isfile")
                    elif alias.name == "isdir":
                        os_isdir_direct.add(alias.asname or "isdir")
            elif node.module == "io":
                for alias in node.names:
                    if alias.name == "open":
                        io_open_direct.add(alias.asname or "open")
            elif node.module == "pathlib":
                uses_pathlib = True
            elif node.module == "logging":
                logging_imported = True
                for alias in node.names:
                    if alias.name == "*":
                        logging_direct.update(_LOG_METHODS)
                    elif alias.name in _LOG_METHODS:
                        logging_direct.add(alias.asname or alias.name)
            elif node.module == "subprocess":
                for alias in node.names:
                    if alias.name == "*":
                        subprocess_direct.update(_SUBPROCESS_FUNCS)
                    elif alias.name in _SUBPROCESS_FUNCS:
                        subprocess_direct.add(alias.asname or alias.name)
            elif node.module == "uuid":
                for alias in node.names:
                    if alias.name in ("uuid4", "*"):
                        uuid4_direct.add(alias.asname or "uuid4" if alias.name != "*" else "uuid4")
            elif node.module == "secrets":
                for alias in node.names:
                    if alias.name == "*":
                        secrets_direct.update(_SECRETS_METHODS)
                    elif alias.name in _SECRETS_METHODS:
                        secrets_direct.add(alias.asname or alias.name)

    def _add_open_mode_ops(call_node: ast.Call, mode_pos_idx: int) -> None:
        mode_node: ast.AST | None = None
        for kw in call_node.keywords:
            if kw.arg == "mode":
                mode_node = kw.value
                break
        if mode_node is None and len(call_node.args) > mode_pos_idx:
            mode_node = call_node.args[mode_pos_idx]
        if mode_node is None:
            names.add("fs.readText")
            return
        if isinstance(mode_node, ast.Constant) and isinstance(mode_node.value, str):
            m = mode_node.value
            is_bin = "b" in m
            is_write = any(c in m for c in ("w", "a", "x", "+"))
            is_read = ("r" in m) or ("+" in m) or not is_write
            if is_read:
                names.add("fs.readBytes" if is_bin else "fs.readText")
            if is_write:
                names.add("fs.writeBytes" if is_bin else "fs.writeText")
            return
        names.update(("fs.readText", "fs.writeText", "fs.readBytes", "fs.writeBytes"))

    pathlib_likely = uses_pathlib or any(
        isinstance(node, ast.Attribute) and node.attr in _PATH_IO_DIRECT_METHODS
        for node in ast.walk(tree)
    )

    def _record_attr(attr_node: ast.Attribute, *, in_call: ast.Call | None = None) -> None:
        nonlocal uses_random
        attr = attr_node.attr
        if isinstance(attr_node.value, ast.Name):
            owner = attr_node.value.id
            if owner == "host":
                op = PY_HOST_METHODS.get(attr, "demo." + attr)
                if op in PY_HOST_OPERATIONS or op.startswith("demo."):
                    names.add(op)
            elif owner in time_aliases and attr in ("time", "monotonic"):
                names.add("platform.time")
            elif owner in datetime_cls_aliases and attr in ("now", "utcnow", "today"):
                names.add("platform.time")
            elif owner in date_cls_aliases and attr == "today":
                names.add("platform.time")
            elif owner in random_aliases:
                if attr in ("random", "randint", "randrange", "choice", "uniform", "shuffle", "sample"):
                    uses_random = True
                if attr == "random" and random_mode == "tool":
                    names.add("platform.random")
            elif owner in urllib_req_aliases and attr == "urlopen":
                names.add("http.request")
            elif owner in requests_aliases and attr in _HTTP_REQUESTS_MEMBERS:
                names.add("http.request")
            elif owner in os_aliases:
                if attr in ("getenv", "environ"):
                    names.add("env.get")
                elif attr == "listdir":
                    names.add("fs.listdir")
            elif owner in os_path_aliases:
                if attr == "exists":
                    names.add("fs.exists")
                elif attr == "isfile":
                    names.add("fs.isFile")
                elif attr == "isdir":
                    names.add("fs.isDir")
            elif owner in io_aliases and attr == "open":
                if in_call is not None:
                    _add_open_mode_ops(in_call, 1)
                else:
                    names.add("fs.readText")
            elif owner in logging_aliases and attr in _LOG_METHODS:
                names.add("platform.log")
            elif owner in subprocess_aliases and attr in _SUBPROCESS_FUNCS:
                names.add("shell.exec")
            elif owner in uuid_aliases and attr == "uuid4":
                names.add("platform.uuid")
            elif owner in secrets_aliases and attr in _SECRETS_METHODS:
                names.add("platform.secrets")
        elif isinstance(attr_node.value, ast.Attribute) and isinstance(attr_node.value.value, ast.Name):
            root_name = attr_node.value.value.id
            inner_attr = attr_node.value.attr
            if root_name in datetime_aliases:
                if inner_attr == "datetime" and attr in ("now", "utcnow", "today"):
                    names.add("platform.time")
                elif inner_attr == "date" and attr == "today":
                    names.add("platform.time")
            elif root_name in urllib_root_aliases and inner_attr == "request" and attr == "urlopen":
                names.add("http.request")
            elif root_name in requests_aliases and inner_attr == "api" and attr in _HTTP_REQUESTS_MEMBERS:
                names.add("http.request")
            elif root_name in os_aliases and inner_attr == "path":
                if attr == "exists":
                    names.add("fs.exists")
                elif attr == "isfile":
                    names.add("fs.isFile")
                elif attr == "isdir":
                    names.add("fs.isDir")
            elif root_name in os_aliases and inner_attr == "environ":
                names.add("env.get")

        # Handle Path methods and logger instance methods cleanly.
        if attr == "read_text":
            names.add("fs.readText")
        elif attr == "write_text":
            names.add("fs.writeText")
        elif attr == "read_bytes":
            names.add("fs.readBytes")
        elif attr == "write_bytes":
            names.add("fs.writeBytes")
        elif attr == "iterdir":
            names.add("fs.listdir")
        elif pathlib_likely:
            if attr == "exists":
                names.add("fs.exists")
            elif attr == "is_file":
                names.add("fs.isFile")
            elif attr == "is_dir":
                names.add("fs.isDir")
            elif attr == "open" and in_call is not None:
                skip_open = isinstance(attr_node.value, ast.Name) and (
                    attr_node.value.id in io_aliases
                    or attr_node.value.id in urllib_req_aliases
                )
                if not skip_open:
                    _add_open_mode_ops(in_call, 0)

        if logging_imported and attr in _LOG_METHODS:
            names.add("platform.log")

    call_func_ids: set[int] = {
        id(node.func) for node in ast.walk(tree) if isinstance(node, ast.Call)
    }
    for node in ast.walk(tree):
        if isinstance(node, ast.Call):
            fn = node.func
            if isinstance(fn, ast.Name):
                if fn.id == "print":
                    names.add("platform.print")
                elif fn.id == "open" or fn.id in io_open_direct:
                    _add_open_mode_ops(node, 1)
                elif fn.id in time_direct:
                    names.add("platform.time")
                elif fn.id in random_direct:
                    uses_random = True
                    if random_mode == "tool":
                        names.add("platform.random")
                elif fn.id in urlopen_direct or fn.id in requests_direct:
                    names.add("http.request")
                elif fn.id in os_getenv_direct:
                    names.add("env.get")
                elif fn.id in os_listdir_direct:
                    names.add("fs.listdir")
                elif fn.id in os_exists_direct:
                    names.add("fs.exists")
                elif fn.id in os_isfile_direct:
                    names.add("fs.isFile")
                elif fn.id in os_isdir_direct:
                    names.add("fs.isDir")
                elif fn.id in logging_direct:
                    names.add("platform.log")
                elif fn.id in subprocess_direct:
                    names.add("shell.exec")
                elif fn.id in uuid4_direct:
                    names.add("platform.uuid")
                elif fn.id in secrets_direct:
                    names.add("platform.secrets")
            elif isinstance(fn, ast.Attribute):
                _record_attr(fn, in_call=node)
        elif isinstance(node, ast.Attribute) and id(node) not in call_func_ids:
            _record_attr(node)
        elif isinstance(node, ast.Name) and isinstance(node.ctx, ast.Load) and id(node) not in call_func_ids:
            if node.id in urlopen_direct or node.id in requests_direct:
                names.add("http.request")
            elif node.id in os_environ_direct:
                names.add("env.get")
            elif node.id in io_open_direct:
                names.add("fs.readText")
            elif node.id == "open":
                names.add("fs.readText")

    if uses_random and random_mode == "tool":
        names.add("platform.random")

    return sorted(names), uses_random


def _tool_declaration(operation: str, native_bindings: list[dict[str, Any]]) -> dict[str, Any]:
    if operation == CODE_LOAD_OPERATION:
        return {
            "type": "function",
            "function": {
                "name": CODE_LOAD_OPERATION,
                "description": CODE_LOAD_TOOL_DESCRIPTION,
                "parameters": {
                    "type": "object",
                    "properties": {
                        "arguments": {
                            "type": "array",
                            "description": "One or more code.load request objects ({path, symbol?, start_line?, end_line?}).",
                        }
                    },
                    "required": ["arguments"],
                },
            },
        }
    binding = next((b for b in native_bindings if b["name"] == operation), None)
    spec = PY_HOST_OPERATIONS.get(operation) or PY_HOST_OPERATIONS.get(canonicalize_operation_name(operation))
    description = (
        binding.get("description")
        if binding and binding.get("description")
        else (spec["description"] if spec else f"Invoke Python external operation {operation}.")
    )
    return {
        "type": "function",
        "function": {
            "name": operation,
            "description": description,
            "parameters": {
                "type": "object",
                "properties": {
                    "arguments": {
                        "type": "array",
                        "description": f"Ordered Python arguments passed to {operation}.",
                    }
                },
                "required": ["arguments"],
            },
        },
    }


def _stateful_world_tools(prepared: dict[str, Any]) -> set[str]:
    tools: set[str] = set()
    world_mode = prepared.get("worldMode") or (prepared.get("task") or {}).get("worldMode") or "scripted"
    if world_mode == "stateful":
        iw = prepared.get("initialWorld") or (prepared.get("task") or {}).get("initialWorld") or {}
        ew = prepared.get("expectedFinalWorld") or (prepared.get("task") or {}).get("expectedFinalWorld") or {}
        if "fs" in iw or "fs" in ew:
            tools.update((
                "fs.exists",
                "fs.isFile",
                "fs.isDir",
                "fs.stat",
                "fs.readdir",
                "fs.readText",
                "fs.writeText",
                "fs.appendText",
                "fs.mkdir",
                "fs.unlink",
                "fs.rename",
                "fs.copyFile",
            ))
        if "kv" in iw or "kv" in ew:
            tools.update(("kv.get", "kv.set", "kv.delete", "kv.has", "kv.keys"))
        if "env" in iw:
            tools.update(("env.get", "env.has", "env.keys"))
    declared = prepared.get("declaredTools")
    if isinstance(declared, list):
        tools.update(t for t in declared if isinstance(t, str) and t)
    return tools


def initial_messages(prepared: dict[str, Any]) -> list[dict[str, Any]]:
    """Build initial public messages (system, optional tool_declare, user)."""
    execution_kind = prepared.get("executionKind") or (prepared.get("task") or {}).get("executionKind") or "function"
    world_mode = prepared.get("worldMode") or (prepared.get("task") or {}).get("worldMode") or "scripted"
    extra_tools = _stateful_world_tools(prepared)

    if is_multifile_task(prepared):
        files = prepared["files"]
        entry_file = prepared["entryFile"]
        loaded_files = prepared.get("initialLoadedFiles") or [entry_file]
        op_set: set[str] = {CODE_LOAD_OPERATION} | extra_tools
        uses_random = False
        for src in files.values():
            try:
                file_ops, file_uses_random = _scan_public_source_tools(
                    src,
                    prepared["randomMode"],
                    prepared["nativeBindings"],
                )
            except SyntaxError:
                file_ops, file_uses_random = [], False
            op_set.update(file_ops)
            uses_random = uses_random or file_uses_random
        operations = sorted(op_set)
        manifest = render_repo_manifest(files, entry_file, loaded_files)
        parts = [
            "Execute this multi-file Python CLI repository:" if execution_kind == "cli" else "Execute this multi-file Python repository:",
            manifest,
            f"Loaded entry file ({entry_file}):",
            "```python\n" + files[entry_file] + "\n```",
        ]
        for extra_path in loaded_files:
            if extra_path != entry_file and extra_path in files:
                parts.append(f"Loaded file ({extra_path}):")
                parts.append("```python\n" + files[extra_path] + "\n```")
        if execution_kind == "cli":
            parts.append("Command argv: " + _json_compact(prepared.get("argv") or []))
            parts.append("Stdin: " + _json_compact(prepared.get("stdin") or ""))
        else:
            parts.append(
                "Entry: "
                + prepared["entry"]
                + " in "
                + entry_file
                + " with arguments "
                + _json_compact(encode_readable(prepared["args"]))
            )
        system_prompt = _build_system_prompt(
            operations,
            multifile=True,
            execution_kind=execution_kind,
            world_mode=world_mode,
        )
    else:
        try:
            scanned_ops, uses_random = _scan_public_source_tools(
                prepared["source"],
                prepared["randomMode"],
                prepared["nativeBindings"],
            )
        except SyntaxError:
            scanned_ops, uses_random = [b["name"] for b in prepared["nativeBindings"]], False
        operations = sorted(set(scanned_ops) | extra_tools)
        if execution_kind == "cli":
            parts = [
                "Execute this Python CLI program:",
                "```python\n" + prepared["source"] + "\n```",
                "Command argv: " + _json_compact(prepared.get("argv") or []),
                "Stdin: " + _json_compact(prepared.get("stdin") or ""),
            ]
        else:
            parts = [
                "Execute this Python program:",
                "```python\n" + prepared["source"] + "\n```",
                "Entry: " + prepared["entry"] + " with arguments " + _json_compact(encode_readable(prepared["args"])),
            ]
        system_prompt = _build_system_prompt(
            operations,
            multifile=False,
            execution_kind=execution_kind,
            world_mode=world_mode,
        )

    if uses_random:
        if prepared["randomMode"] == "tool":
            parts.append(
                'random.random() is non-deterministic: invoke the platform.random tool with {"arguments":[]} for each random.random() call.'
            )
        else:
            parts.append(f"random is seeded deterministically with random.seed({prepared['randomSeed']}).")

    messages: list[dict[str, Any]] = [{"role": "system", "content": system_prompt}]
    if operations:
        tools = [_tool_declaration(op, prepared["nativeBindings"]) for op in operations]
        messages.append({"role": "tool_declare", "content": _json_compact(tools)})
    messages.append({"role": "user", "content": "\n".join(parts)})
    return messages


def _normalize_world_spec(raw: Any, *, allow_env: bool = True) -> dict[str, Any] | None:
    if raw is None:
        return None
    _demand(isinstance(raw, dict), "World spec must be a dict")
    out: dict[str, Any] = {}
    if "fs" in raw and raw["fs"] is not None:
        _demand(isinstance(raw["fs"], dict), "World fs must be a dict")
        out["fs"] = {
            _normalize_virtual_path(k): (v if isinstance(v, (str, bytes)) else decode_readable(v))
            for k, v in raw["fs"].items()
        }
    if "kv" in raw and raw["kv"] is not None:
        _demand(isinstance(raw["kv"], dict), "World kv must be a dict")
        out["kv"] = {str(k): decode_readable(v) for k, v in raw["kv"].items()}
    if allow_env and "env" in raw and raw["env"] is not None:
        _demand(isinstance(raw["env"], dict), "World env must be a dict")
        out["env"] = {str(k): str(v) for k, v in raw["env"].items() if v is not None}
    return out


def _encode_world_spec(world: dict[str, Any] | None) -> dict[str, Any] | None:
    if world is None:
        return None
    out: dict[str, Any] = {}
    if "fs" in world:
        out["fs"] = {k: encode_readable(v) for k, v in world["fs"].items()}
    if "kv" in world:
        out["kv"] = {k: encode_readable(v) for k, v in world["kv"].items()}
    if "env" in world:
        out["env"] = dict(world["env"])
    return out


def normalize_python_task(input_task: dict[str, Any]) -> dict[str, Any]:
    _demand(isinstance(input_task, dict), "Task must be a dict")
    task_id = input_task.get("id")
    family = input_task.get("family")
    _demand(isinstance(task_id, str) and 0 < len(task_id) <= 256, "Task id required")
    _demand(isinstance(family, str) and len(family) > 0, "Source family required")

    execution_kind = input_task.get("executionKind", "function")
    _demand(execution_kind in ("function", "cli"), "executionKind must be function or cli")
    world_mode = input_task.get("worldMode", "scripted")
    _demand(world_mode in ("scripted", "stateful"), "worldMode must be scripted or stateful")

    initial_world = _normalize_world_spec(input_task.get("initialWorld"), allow_env=True)
    expected_final_world = _normalize_world_spec(input_task.get("expectedFinalWorld"), allow_env=False)
    declared_tools_raw = input_task.get("declaredTools")
    declared_tools: list[str] | None = None
    if declared_tools_raw is not None:
        _demand(
            isinstance(declared_tools_raw, list) and all(isinstance(t, str) and len(t) > 0 for t in declared_tools_raw),
            "declaredTools must be a list of non-empty strings",
        )
        declared_tools = list(declared_tools_raw)

    argv: list[str] | None = None
    stdin: str = ""
    expected_cli: dict[str, Any] | None = None
    if execution_kind == "cli":
        argv_raw = input_task.get("argv", [])
        _demand(
            isinstance(argv_raw, list) and len(argv_raw) <= 256 and all(isinstance(a, str) for a in argv_raw),
            "CLI argv must be a list of strings",
        )
        argv = list(argv_raw)
        stdin = input_task.get("stdin", "")
        _demand(isinstance(stdin, str), "CLI stdin must be a string")
        exp_cli_raw = input_task.get("expectedCli")
        if exp_cli_raw is not None:
            _demand(isinstance(exp_cli_raw, dict), "expectedCli must be a dict")
            exit_code = exp_cli_raw.get("exitCode", 0)
            stdout_str = exp_cli_raw.get("stdout", "")
            stderr_str = exp_cli_raw.get("stderr", "")
            _demand(isinstance(exit_code, int) and not isinstance(exit_code, bool), "expectedCli.exitCode must be an int")
            _demand(isinstance(stdout_str, str), "expectedCli.stdout must be a str")
            _demand(isinstance(stderr_str, str), "expectedCli.stderr must be a str")
            expected_cli = {"exitCode": exit_code, "stdout": stdout_str, "stderr": stderr_str}
        else:
            expected_cli = {"exitCode": 0, "stdout": "", "stderr": ""}

    multifile = is_multifile_task(input_task)
    norm_files: dict[str, str] | None = None
    norm_entry_file: str | None = None
    norm_initial_loaded: list[str] | None = None
    if multifile:
        entry_file_raw = input_task.get("entryFile")
        _demand(isinstance(entry_file_raw, str) and len(entry_file_raw) > 0, "entryFile required for multi-file task")
        norm_files, norm_entry_file, norm_initial_loaded = normalize_codebase_files(
            input_task["files"],
            entry_file_raw,
            input_task.get("initialLoadedFiles"),
        )
        source = norm_files[norm_entry_file]
        _demand(isinstance(source, str) and 0 < len(source) <= 262144, "Bounded entryFile source required")
    else:
        source = input_task.get("source")
        _demand(isinstance(source, str) and 0 < len(source) <= 262144, "Bounded source required")

    entry = input_task.get("entry", "main" if execution_kind == "cli" else "run")
    _demand(isinstance(entry, str) and entry.isidentifier(), "Entry must be a valid Python identifier")

    language = input_task.get("language", "py")
    _demand(language == "py", "Language must be py")

    args = decode_readable(input_task.get("args", []))
    _demand(isinstance(args, list) and len(args) <= 32, "At most 32 input arguments are supported")

    expected_outcome: dict[str, Any] | None = None
    if input_task.get("expectedOutcome") is not None:
        eo = input_task["expectedOutcome"]
        _demand(isinstance(eo, dict) and eo.get("kind") in ("return", "throw"), "Invalid expectedOutcome")
        eo_args = decode_readable(eo["arguments"]) if "arguments" in eo else copy.deepcopy(args)
        _demand(isinstance(eo_args, list) and len(eo_args) == len(args), "expectedOutcome.arguments arity mismatch")
        eo_val = decode_readable(eo.get("value"))
        expected_outcome = {"kind": eo["kind"], "graph": describe_graph([*eo_args, eo_val])}

    random_mode = input_task.get("randomMode", "seeded")
    _demand(random_mode in ("seeded", "tool"), "randomMode must be seeded or tool")
    random_seed = input_task.get("randomSeed", 17)
    _demand(
        isinstance(random_seed, int) and not isinstance(random_seed, bool) and 0 <= random_seed <= 0xFFFFFFFF,
        "randomSeed must be uint32",
    )

    native_bindings = copy.deepcopy(input_task.get("nativeBindings") or [])
    _demand(isinstance(native_bindings, list) and len(native_bindings) <= 32, "Invalid native binding list")
    seen_names: set[str] = set()
    for binding in native_bindings:
        _demand(
            isinstance(binding, dict)
            and isinstance(binding.get("name"), str)
            and binding["name"].isidentifier()
            and binding["name"] not in seen_names,
            "Invalid native binding",
        )
        seen_names.add(binding["name"])
        binding.setdefault("kind", "synchronous")

    fixture_raw = input_task.get("fixture") or {}
    _demand(isinstance(fixture_raw, dict), "Fixture must be a dict")
    calls_raw = copy.deepcopy(fixture_raw.get("calls") or [])
    _demand(isinstance(calls_raw, list) and len(calls_raw) <= 1024, "Bounded fixture calls required")

    decoded_calls: list[dict[str, Any]] = []
    for call in calls_raw:
        _demand(isinstance(call, dict), "Fixture call must be a dict")
        op = call.get("operation")
        _demand(isinstance(op, str) and len(op) > 0, "Fixture call operation required")
        c_args = decode_readable(call.get("arguments", []))
        _demand(isinstance(c_args, list), "External arguments must be a list")
        c_status = call.get("status", "fulfilled")
        _demand(c_status in ("fulfilled", "rejected"), "Fixture status must be fulfilled or rejected")
        c_result = decode_readable(call.get("result"))
        decoded_calls.append({
            "operation": op,
            "arguments": c_args,
            "argumentGraph": describe_graph(c_args),
            "status": c_status,
            "result": c_result,
        })

    max_steps = input_task.get("maxSteps", 100000)
    timeout_ms = input_task.get("timeoutMs", 10000)
    _demand(
        isinstance(max_steps, int) and not isinstance(max_steps, bool) and 0 < max_steps <= 1_000_000,
        "Invalid teacher step limit",
    )
    _demand(
        isinstance(timeout_ms, int) and not isinstance(timeout_ms, bool) and 0 < timeout_ms <= 60_000,
        "Invalid teacher timeout",
    )

    if multifile:
        assert norm_files is not None and norm_entry_file is not None and norm_initial_loaded is not None
        source_hash = normalized_multifile_source_hash(norm_files, norm_entry_file)
    else:
        try:
            source_hash = normalized_py_source_hash(source)
        except SyntaxError:
            if execution_kind == "cli":
                source_hash = _sha256(source)
            else:
                raise

    normalized_fixture_calls = [
        {
            "operation": c["operation"],
            "arguments": encode_readable(c["arguments"]),
            "status": c["status"],
            "result": encode_readable(c["result"], allow_exceptions=True),
        }
        for c in decoded_calls
    ]

    canonical_task = {
        **copy.deepcopy(input_task),
        "id": task_id,
        "family": family,
        "source": source,
        "entry": entry,
        "language": "py",
        "randomSeed": random_seed,
        "nativeBindings": native_bindings,
        "args": encode_readable(args),
        "fixture": {"calls": normalized_fixture_calls},
        "maxSteps": max_steps,
        "timeoutMs": timeout_ms,
    }
    if execution_kind != "function":
        canonical_task["executionKind"] = execution_kind
        canonical_task["argv"] = argv
        canonical_task["stdin"] = stdin
        canonical_task["expectedCli"] = expected_cli
    if world_mode != "scripted":
        canonical_task["worldMode"] = world_mode
    if initial_world is not None:
        canonical_task["initialWorld"] = _encode_world_spec(initial_world)
    if expected_final_world is not None:
        canonical_task["expectedFinalWorld"] = _encode_world_spec(expected_final_world)
    if declared_tools is not None:
        canonical_task["declaredTools"] = declared_tools
    if random_mode != "seeded":
        canonical_task["randomMode"] = random_mode
    if multifile:
        assert norm_files is not None and norm_entry_file is not None and norm_initial_loaded is not None
        canonical_task["files"] = norm_files
        canonical_task["entryFile"] = norm_entry_file
        if "initialLoadedFiles" in input_task or norm_initial_loaded != [norm_entry_file]:
            canonical_task["initialLoadedFiles"] = norm_initial_loaded

    normalized_result: dict[str, Any] = {
        "id": task_id,
        "family": family,
        "sourceHash": source_hash,
        "source": source,
        "entry": entry,
        "args": args,
        "fixture": {"calls": decoded_calls},
        "nativeBindings": native_bindings,
        "executionKind": execution_kind,
        "worldMode": world_mode,
        "randomMode": random_mode,
        "randomSeed": random_seed,
        "maxSteps": max_steps,
        "timeoutMs": timeout_ms,
        "task": canonical_task,
    }
    if execution_kind == "cli":
        normalized_result["argv"] = argv
        normalized_result["stdin"] = stdin
        normalized_result["expectedCli"] = expected_cli
    if initial_world is not None:
        normalized_result["initialWorld"] = initial_world
    if expected_final_world is not None:
        normalized_result["expectedFinalWorld"] = expected_final_world
    if declared_tools is not None:
        normalized_result["declaredTools"] = declared_tools
    if expected_outcome is not None:
        normalized_result["expectedOutcome"] = expected_outcome
    if multifile:
        assert norm_files is not None and norm_entry_file is not None and norm_initial_loaded is not None
        normalized_result["files"] = norm_files
        normalized_result["entryFile"] = norm_entry_file
        normalized_result["initialLoadedFiles"] = norm_initial_loaded
    return normalized_result


def _invoke_reference_worker(prepared: dict[str, Any], *, trace: bool) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "source": prepared["source"],
        "entry": prepared["entry"],
        "args": prepared["task"]["args"],
        "fixture": prepared["task"]["fixture"],
        "nativeBindings": prepared["nativeBindings"],
        "randomMode": prepared["randomMode"],
        "randomSeed": prepared["randomSeed"],
        "trace": trace,
        "maxSteps": prepared["maxSteps"],
        "timeoutMs": prepared["timeoutMs"],
    }
    if is_multifile_task(prepared):
        payload["files"] = prepared["files"]
        payload["entryFile"] = prepared["entryFile"]
        payload["initialLoadedFiles"] = prepared.get("initialLoadedFiles")
    timeout_s = max(2.0, prepared["timeoutMs"] / 1000.0 + 3.0)
    with tempfile.TemporaryDirectory(prefix="py-ref-") as tmpdir:
        proc = subprocess.run(
            [sys.executable, str(_worker_path())],
            input=_json_compact(payload),
            capture_output=True,
            text=True,
            cwd=tmpdir,
            timeout=timeout_s,
            check=False,
        )
    stdout = proc.stdout.strip()
    if not stdout:
        detail = proc.stderr.strip()[-1000:]
        raise RuntimeError(f"Python reference worker exited with code {proc.returncode}: {detail}")
    try:
        result = json.loads(stdout.split("\n")[-1])
    except ValueError as exc:
        raise RuntimeError(f"Python reference worker emitted non-JSON output: {stdout[:500]}") from exc
    if proc.returncode != 0 or "error" in result:
        failure = result.get("failure") or {}
        err = RuntimeError(result.get("error") or f"Python reference worker failed ({proc.returncode})")
        err.category = failure.get("category", "reference_process_failure")  # type: ignore[attr-defined]
        raise err
    return result


def _synthetic_fixture_effects(fixture_calls: list[dict[str, Any]]) -> list[dict[str, Any]]:
    effects: list[dict[str, Any]] = []
    for idx, c in enumerate(fixture_calls):
        effects.append({
            "kind": "dispatch",
            "call": idx,
            "operation": c["operation"],
            "arguments": c["argumentGraph"],
        })
        effects.append({
            "kind": "settlement",
            "call": idx,
            "operation": c["operation"],
            "status": c["status"],
            "result": describe_graph([c["result"]], allow_exceptions=True),
        })
    return effects


def prepare_python_task(input_task: dict[str, Any], *, trace_format: str = "compact") -> dict[str, Any]:
    """Execute Python task in isolated worker with optional sys.settrace compact tracing."""
    fmt = _validate_trace_format(trace_format)
    prepared = normalize_python_task(input_task)
    if prepared.get("executionKind") == "cli":
        exp_cli = prepared["expectedCli"]
        result = {
            **prepared,
            "outcome": {
                "kind": "cli",
                "exitCode": exp_cli["exitCode"],
                "stdout": exp_cli["stdout"],
                "stderr": exp_cli["stderr"],
            },
            "effects": _synthetic_fixture_effects(prepared["fixture"]["calls"]),
            "traceTurns": None,
        }
        readable_messages_from_python(result, trace_format=fmt)
        return result
    if prepared.get("worldMode") == "stateful" and prepared.get("expectedOutcome") is not None:
        result = {
            **prepared,
            "outcome": prepared["expectedOutcome"],
            "effects": _synthetic_fixture_effects(prepared["fixture"]["calls"]),
            "traceTurns": None,
        }
        readable_messages_from_python(result, trace_format=fmt)
        return result
    want_trace = fmt != "actions-only"
    if want_trace:
        try:
            ref = _invoke_reference_worker(prepared, trace=True)
        except RuntimeError as exc:
            if getattr(exc, "category", None) != "reference_resource_limit":
                raise
            ref = _invoke_reference_worker(prepared, trace=False)
    else:
        ref = _invoke_reference_worker(prepared, trace=False)

    result = {
        **prepared,
        "outcome": ref["outcome"],
        "effects": ref["effects"],
        "traceTurns": ref.get("traceTurns"),
    }
    # Validate message generation before admitting task.
    readable_messages_from_python(result, trace_format=fmt)
    return result


def _assistant_message(action: dict[str, Any], trace: list[str], channel: str) -> dict[str, Any]:
    action_block = "```json\n" + _json_compact(action) + "\n```"
    if channel == "thinking":
        if not trace:
            return {"role": "assistant", "content": action_block}
        return {
            "role": "assistant",
            "content": [
                {"type": "thinking", "thinking": "\n".join(trace)},
                {"type": "text", "text": action_block},
            ],
        }
    prefix = ("\n".join(trace) + "\n") if trace else ""
    return {"role": "assistant", "content": prefix + action_block}


def _assistant_tool_call_message(
    operation: str,
    encoded_args: list[Any],
    trace: list[str],
    channel: str,
    call_id: str,
) -> dict[str, Any]:
    tool_calls = [
        {
            "type": "function",
            "id": call_id,
            "function": {
                "name": operation,
                "arguments": _json_compact({"arguments": encoded_args}),
            },
        }
    ]
    if channel == "thinking":
        if not trace:
            return {"role": "assistant", "content": "", "tool_calls": tool_calls}
        return {
            "role": "assistant",
            "content": [{"type": "thinking", "thinking": "\n".join(trace)}],
            "tool_calls": tool_calls,
        }
    return {"role": "assistant", "content": "\n".join(trace), "tool_calls": tool_calls}


def _observation(operation: str, status: str, value: Any, tool_call_id: str | None = None) -> dict[str, Any]:
    msg: dict[str, Any] = {
        "role": "tool",
        "name": operation,
        "content": _json_compact({"status": status, "value": encode_readable(value, allow_exceptions=True)}),
    }
    if tool_call_id:
        msg["tool_call_id"] = tool_call_id
    return msg


def readable_messages_from_python(
    prepared: dict[str, Any],
    *,
    trace_format: str = "compact",
    reasoning_channel: str = "thinking",
) -> list[dict[str, Any]]:
    """Build causal readable conversation messages from a prepared Python task."""
    fmt = _validate_trace_format(trace_format)
    channel = _validate_reasoning_channel(reasoning_channel)
    messages = initial_messages(prepared)
    dispatches = [e for e in prepared["effects"] if e["kind"] == "dispatch"]
    settlements = {e["call"]: e for e in prepared["effects"] if e["kind"] == "settlement"}
    turns = prepared.get("traceTurns") if fmt != "actions-only" and isinstance(prepared.get("traceTurns"), list) else None

    for index, receipt in enumerate(dispatches):
        call_args = realize_graph(receipt["arguments"])
        call_id = f"call_{index + 1}"
        turn_lines = turns[index] if turns is not None and index < len(turns) else []
        messages.append(
            _assistant_tool_call_message(
                receipt["operation"],
                encode_readable(call_args),
                turn_lines,
                channel,
                call_id,
            )
        )
        settlement = settlements.get(receipt["call"])
        _demand(settlement is not None, "Missing external settlement")
        assert settlement is not None
        settled_val = realize_graph(settlement["result"])[0]
        messages.append(_observation(receipt["operation"], settlement["status"], settled_val, call_id))

    final_turn = turns[len(dispatches)] if turns is not None and len(dispatches) < len(turns) else []
    if prepared["outcome"].get("kind") == "cli":
        completion_action: dict[str, Any] = {
            "type": "complete",
            "kind": "cli",
            "exitCode": prepared["outcome"]["exitCode"],
            "stdout": prepared["outcome"]["stdout"],
            "stderr": prepared["outcome"]["stderr"],
        }
    else:
        roots = realize_graph(prepared["outcome"]["graph"])
        value = roots.pop()
        completion = encode_readable({"arguments": roots, "value": value})
        completion_action = {
            "type": "complete",
            "kind": prepared["outcome"]["kind"],
            "arguments": completion["arguments"],
            "value": completion["value"],
        }
    messages.append(_assistant_message(completion_action, final_turn, channel))
    return messages


def _validate_action_object(action: Any) -> dict[str, Any]:
    _demand(isinstance(action, dict), "Expected a JSON action object")
    action_type = action.get("type")
    if action_type == "call":
        fields = ",".join(sorted(action.keys()))
        _demand(fields == "arguments,operation,type" and isinstance(action.get("operation"), str), "Invalid external call action")
        return action
    if (action_type == "complete" or "type" not in action) and action.get("kind") == "cli":
        keys = ",".join(sorted(action.keys()))
        allowed = keys in ("exitCode,kind,stderr,stdout,type", "exitCode,kind,stderr,stdout")
        exit_code = action.get("exitCode")
        _demand(
            allowed
            and isinstance(exit_code, int)
            and not isinstance(exit_code, bool)
            and isinstance(action.get("stdout"), str)
            and isinstance(action.get("stderr"), str),
            "Invalid CLI completion action",
        )
        return {
            "type": "complete",
            "kind": "cli",
            "exitCode": exit_code,
            "stdout": action["stdout"],
            "stderr": action["stderr"],
        }
    if action_type == "complete":
        keys = ",".join(sorted(action.keys()))
        allowed = keys in ("arguments,kind,type,value", "kind,type,value")
        _demand(allowed and action.get("kind") in ("return", "throw"), "Invalid completion action")
        if "arguments" not in action:
            return {**action, "arguments": []}
        return action
    raise TypeError("Unknown action type")


def _parse_tool_call(tc: Any) -> dict[str, Any]:
    _demand(isinstance(tc, dict), "Invalid tool call")
    fn = tc.get("function")
    _demand(isinstance(fn, dict) and isinstance(fn.get("name"), str) and len(fn["name"]) > 0, "Invalid tool call function")
    raw_args = fn.get("arguments")
    if isinstance(raw_args, str):
        trimmed = raw_args.strip()
        raw_args = json.loads(trimmed) if trimmed else {}
    if isinstance(raw_args, list):
        args = raw_args
    elif isinstance(raw_args, dict) and len(raw_args) == 1 and isinstance(raw_args.get("arguments"), list):
        args = raw_args["arguments"]
    elif (
        fn["name"] == CODE_LOAD_OPERATION
        and isinstance(raw_args, dict)
        and len(raw_args) == 1
        and isinstance(raw_args.get("arguments"), dict)
    ):
        args = [raw_args["arguments"]]
    elif fn["name"] == CODE_LOAD_OPERATION and isinstance(raw_args, dict) and "path" in raw_args:
        args = [raw_args]
    elif isinstance(raw_args, dict) and len(raw_args) == 0:
        args = []
    else:
        raise TypeError("Invalid tool call arguments")
    parsed: dict[str, Any] = {"type": "call", "operation": fn["name"], "arguments": args}
    tc_id = tc.get("id")
    if isinstance(tc_id, str) and len(tc_id) > 0:
        parsed["toolCallId"] = tc_id
    return parsed


_FENCE_RE = re.compile(r"```(?:json)?[ \t]*\r?\n?([\s\S]*?)```")


def parse_student_action(input_val: Any) -> dict[str, Any]:
    """Parse native tool_calls, fenced JSON action block, or bare JSON action."""
    if isinstance(input_val, dict) and isinstance(input_val.get("tool_calls"), list) and len(input_val["tool_calls"]) > 0:
        tcs = input_val["tool_calls"]
        if len(tcs) == 1:
            return _parse_tool_call(tcs[0])
        return {"type": "calls", "calls": [_parse_tool_call(tc) for tc in tcs]}

    text = input_val if isinstance(input_val, str) else assistant_visible_text(input_val)
    _demand(isinstance(text, str) and len(text) <= 1_048_576, "Invalid action text")
    trimmed = text.strip()
    fenced = list(_FENCE_RE.finditer(trimmed))
    action_fences: list[tuple[re.Match[str], dict[str, Any]]] = []
    for match in fenced:
        try:
            parsed = json.loads(match.group(1).strip())
            if isinstance(parsed, dict) and (isinstance(parsed.get("type"), str) or parsed.get("kind") == "cli"):
                action_fences.append((match, parsed))
        except Exception:
            pass

    if action_fences:
        _demand(len(action_fences) == 1, "Expected exactly one action fence")
        match, parsed = action_fences[0]
        trailing = trimmed[match.end() :].strip()
        _demand(len(trailing) == 0 or bool(re.fullmatch(r"[.!?]+", trailing)), "Action fence must end the turn")
        return _validate_action_object(parsed)

    if fenced:
        last = fenced[-1]
        trailing = trimmed[last.end() :].strip()
        _demand(len(trailing) == 0 or bool(re.fullmatch(r"[.!?]+", trailing)), "Action fence must end the turn")
        try:
            parsed = json.loads(last.group(1).strip())
        except Exception as exc:
            raise TypeError("Expected one JSON action") from exc
        return _validate_action_object(parsed)

    try:
        action = json.loads(trimmed)
    except Exception as exc:
        raise TypeError("Expected one JSON action") from exc
    return _validate_action_object(action)


_PURE_COMMUTATIVE_READ_OPS: frozenset[str] = frozenset({
    "env.get",
    "env.has",
    "env.list",
    "env.keys",
    "env.cwd",
    "fs.exists",
    "fs.stat",
    "fs.isFile",
    "fs.isDir",
    "fs.listdir",
    "fs.readdir",
    "fs.list",
    "fs.readText",
    "fs.readBytes",
    "kv_get",
    "kv.get",
    "kv.has",
    "kv.list",
    "kv.keys",
    "browser.storageGet",
    "browser.storage.getItem",
    "browser.storage.length",
    "browser.storage.key",
    "http.get",
})

_HTTP_METHOD_CHECKED_OPS: frozenset[str] = frozenset({"http.request", "browser.fetch"})
_READ_ONLY_HTTP_METHODS: frozenset[str] = frozenset({"GET", "HEAD"})


def _extract_http_request_method(args: Any) -> str | None:
    if not isinstance(args, list) or len(args) == 0:
        return None
    first = args[0]
    if isinstance(first, dict):
        method = first.get("method")
        if method is None:
            return "GET"
        if isinstance(method, str):
            norm = method.strip().upper()
            return norm if norm else None
        return None
    if isinstance(first, str):
        if len(args) == 1:
            return "GET"
        second = args[1]
        if second is None:
            return "GET"
        if isinstance(second, str):
            norm = second.strip().upper()
            return norm if norm else None
        if isinstance(second, dict):
            method = second.get("method")
            if method is None:
                return "GET"
            if isinstance(method, str):
                norm = method.strip().upper()
                return norm if norm else None
            return None
        return None
    return None


def _is_read_only_sqlite_select(args: Any) -> bool:
    if not isinstance(args, list) or len(args) == 0:
        return False
    first = args[0]
    sql: str | None = None
    if isinstance(first, str):
        sql = first
    elif isinstance(first, dict):
        cand = first.get("sql") if isinstance(first.get("sql"), str) else first.get("query")
        if isinstance(cand, str):
            sql = cand
    if not isinstance(sql, str):
        return False
    rest = sql
    while True:
        trimmed = rest.lstrip()
        if trimmed.startswith("--"):
            nl = trimmed.find("\n")
            rest = "" if nl < 0 else trimmed[nl + 1 :]
        elif trimmed.startswith("/*"):
            end = trimmed.find("*/", 2)
            if end < 0:
                return False
            rest = trimmed[end + 2 :]
        else:
            rest = trimmed
            break
    body = re.sub(r";+\s*$", "", rest)
    return bool(re.match(r"^SELECT\b", body, re.IGNORECASE)) and ";" not in body


def is_commutative_read_call(operation: Any, args: Any = None) -> bool:
    """Return True iff (operation, args) is a pure/commutative read allowed to reorder within its causal epoch.

    Unknown operations conservatively default to strict barriers (False).
    """
    if not isinstance(operation, str):
        return False
    canon = canonicalize_operation_name(operation)
    if canon in _PURE_COMMUTATIVE_READ_OPS:
        return True
    if canon in _HTTP_METHOD_CHECKED_OPS:
        method = _extract_http_request_method(args if args is not None else [])
        return method is not None and method in _READ_ONLY_HTTP_METHODS
    if canon == "sqlite3.query":
        return _is_read_only_sqlite_select(args if args is not None else [])
    return False


_ALLOWED_HTTP_REQUEST_KEYS: frozenset[str] = frozenset({"url", "method", "headers", "body"})


def _normalize_http_headers_arg(value: Any) -> dict[str, Any] | None:
    if value is None or value == "":
        return {}
    if isinstance(value, str):
        trimmed = value.strip()
        if not trimmed:
            return {}
        if trimmed.startswith("{") and trimmed.endswith("}"):
            try:
                parsed = json.loads(trimmed)
                if isinstance(parsed, dict):
                    return parsed
            except Exception:
                return None
        return None
    if isinstance(value, dict):
        return value
    return None


def _normalize_http_body_arg(value: Any) -> Any:
    return "" if value is None else value


def canonicalize_http_request_args(args: Any) -> dict[str, Any] | None:
    """Canonicalize http.request arguments across single-dict and 4-positional forms."""
    if not isinstance(args, list):
        return None
    if len(args) == 1 and isinstance(args[0], dict):
        req = args[0]
        if any(k not in _ALLOWED_HTTP_REQUEST_KEYS for k in req):
            return None
        url = req.get("url")
        if not isinstance(url, str):
            return None
        raw_method = req.get("method")
        if raw_method is None:
            method = "GET"
        elif isinstance(raw_method, str):
            method = raw_method.strip().upper()
            if not method:
                return None
        else:
            return None
        headers = _normalize_http_headers_arg(req.get("headers"))
        if headers is None:
            return None
        body = _normalize_http_body_arg(req.get("body"))
        return {"url": url, "method": method, "headers": headers, "body": body}
    if len(args) == 4 and isinstance(args[0], str):
        raw_method = args[1]
        if raw_method is None:
            method = "GET"
        elif isinstance(raw_method, str):
            method = raw_method.strip().upper()
            if not method:
                return None
        else:
            return None
        headers = _normalize_http_headers_arg(args[2])
        if headers is None:
            return None
        body = _normalize_http_body_arg(args[3])
        return {"url": args[0], "method": method, "headers": headers, "body": body}
    return None


def _expected_arguments_match(
    operation: str,
    call_args: list[Any],
    actual_arg_graph: dict[str, Any],
    candidate: dict[str, Any],
) -> bool:
    if actual_arg_graph == candidate["argumentGraph"]:
        return True
    canon_op = canonicalize_operation_name(operation)
    if canon_op in ("http.request", "browser.fetch"):
        expected_args = candidate["arguments"] if "arguments" in candidate else realize_graph(candidate["argumentGraph"])
        actual_canon = canonicalize_http_request_args(call_args)
        expected_canon = canonicalize_http_request_args(expected_args)
        if actual_canon is not None and expected_canon is not None:
            return describe_graph([actual_canon]) == describe_graph([expected_canon])
    return False


def _external_effects_only(effects: list[dict[str, Any]], *, exclude_world: bool = False) -> list[dict[str, Any]]:
    """Filter out read-only `code.load` (and optionally stateful world) effects and renumber call IDs."""
    skipped_call_ids: set[int] = set()
    for eff in effects:
        op = eff.get("operation")
        if op == CODE_LOAD_OPERATION or (exclude_world and is_stateful_world_operation(op)):
            skipped_call_ids.add(eff["call"])
    id_map: dict[int, int] = {}
    out: list[dict[str, Any]] = []
    for eff in effects:
        orig_id = eff["call"]
        if orig_id in skipped_call_ids:
            continue
        if orig_id not in id_map:
            id_map[orig_id] = len(id_map)
        out.append({**eff, "call": id_map[orig_id]})
    return out


class PythonExecutionSession:
    """Stateful live grading session for Python execution tasks.

    Independent pure reads within the current causal epoch (before the next barrier)
    may execute in any order, while barriers and cross-epoch ordering remain strict.
    Supports opt-in live stateful virtual world mode (`worldMode: "stateful"`)
    and first-class CLI execution mode (`executionKind: "cli"`).
    """

    def __init__(self, prepared: dict[str, Any]) -> None:
        self._prepared = prepared
        self._execution_kind: str = prepared.get("executionKind") or (prepared.get("task") or {}).get("executionKind") or "function"
        self._world_mode: str = prepared.get("worldMode") or (prepared.get("task") or {}).get("worldMode") or "scripted"
        self._is_stateful = self._world_mode == "stateful"
        self._world: StatefulVirtualWorld | None = (
            StatefulVirtualWorld(prepared.get("initialWorld") or (prepared.get("task") or {}).get("initialWorld") or {})
            if self._is_stateful
            else None
        )
        self._expected_final_world: dict[str, Any] | None = (
            prepared.get("expectedFinalWorld") or (prepared.get("task") or {}).get("expectedFinalWorld")
            if self._is_stateful
            else None
        )
        self.messages = initial_messages(prepared)
        self._done = False
        self._completed = False
        self._success = False
        self._reason = "incomplete"
        self._failure_category: str | None = "incomplete"
        self._generated_tokens = 0
        self._calls = 0
        self._world_calls = 0
        self._total_tool_calls = 0
        self._code_load_calls = 0
        self._code_load_bytes = 0
        self._turns = 0
        raw_fixture_calls = prepared["fixture"]["calls"]
        self._fixture_calls: list[dict[str, Any]] = (
            [c for c in raw_fixture_calls if not is_stateful_world_operation(c["operation"])]
            if self._is_stateful
            else list(raw_fixture_calls)
        )
        self._expected_is_read: list[bool] = [
            is_commutative_read_call(
                c["operation"],
                c["arguments"] if "arguments" in c else realize_graph(c["argumentGraph"]),
            )
            for c in self._fixture_calls
        ]
        self._consumed: list[bool] = [False] * len(self._fixture_calls)
        self._epoch_start = 0
        self._recorded_by_index: dict[int, tuple[dict[str, Any], dict[str, Any]]] = {}
        max_turns = prepared["task"].get("maxTurns", 256)
        _demand(
            isinstance(max_turns, int) and not isinstance(max_turns, bool) and 0 < max_turns <= 4096,
            "Invalid rollout turn limit",
        )
        self._max_turns = max_turns

    def _match_expected_call(
        self,
        operation: str,
        args: list[Any],
        actual_arg_graph: dict[str, Any],
    ) -> int:
        fixture_calls = self._fixture_calls
        total = len(fixture_calls)
        if self._epoch_start >= total:
            return -1
        canon_op = canonicalize_operation_name(operation)
        if self._expected_is_read[self._epoch_start]:
            # Unconsumed pure reads remain in the current epoch: barrier calls cannot bypass them.
            if not is_commutative_read_call(canon_op, args):
                return -1
            epoch_end = self._epoch_start
            while epoch_end < total and self._expected_is_read[epoch_end]:
                epoch_end += 1
            # Scan ascending so duplicate identical reads in the same epoch observe FIFO causal order.
            for idx in range(self._epoch_start, epoch_end):
                if self._consumed[idx]:
                    continue
                cand = fixture_calls[idx]
                if canonicalize_operation_name(cand["operation"]) == canon_op and _expected_arguments_match(
                    canon_op, args, actual_arg_graph, cand
                ):
                    return idx
            return -1
        barrier = fixture_calls[self._epoch_start]
        if canonicalize_operation_name(barrier["operation"]) == canon_op and _expected_arguments_match(
            canon_op, args, actual_arg_graph, barrier
        ):
            return self._epoch_start
        return -1

    def _count(self, total: int) -> None:
        _demand(
            isinstance(total, int) and not isinstance(total, bool) and total >= self._generated_tokens,
            "Generated token count must be cumulative and monotonic",
        )
        self._generated_tokens = total

    def grade(self, total: int | None = None) -> dict[str, Any]:
        if total is not None:
            self._count(total)
        ok = self._done and self._success
        expected_external_calls = len(self._fixture_calls)
        result: dict[str, Any] = {
            "success": ok,
            "reward": (1.0 / (1.0 + self._generated_tokens / 1000.0)) if ok else 0.0,
            "reason": self._reason,
            "failureCategory": self._failure_category,
            "generatedTokens": self._generated_tokens,
            "externalCalls": self._calls,
            "matchedExternalCalls": self._calls,
            "expectedExternalCalls": expected_external_calls,
            "matched_external_calls": self._calls,
            "expected_external_calls": expected_external_calls,
            "codeLoadCalls": self._code_load_calls,
            "codeLoadBytes": self._code_load_bytes,
            "complete": self._completed,
        }
        if self._is_stateful and self._world is not None:
            result["worldCalls"] = self._world_calls
            result["finalWorld"] = self._world.snapshot()
        return result

    def _reject(self, why: str, category: str | None = None) -> dict[str, Any]:
        self._done = True
        self._success = False
        self._reason = why
        self._failure_category = category if category is not None else why
        return {"messages": [], "done": self._done, "grade": self.grade()}

    def step(self, action_input: Any, total: int | None = None) -> dict[str, Any]:
        if total is not None:
            self._count(total)
        if self._done:
            return {"messages": [], "done": self._done, "grade": self.grade()}
        self._turns += 1
        if self._turns > self._max_turns:
            return self._reject("turn-limit")

        try:
            action = parse_student_action(action_input)
        except Exception:
            return self._reject("invalid-action", "malformed-action")

        fixture_calls = self._fixture_calls

        if action["type"] == "complete":
            try:
                if self._calls != len(fixture_calls) or self._epoch_start != len(fixture_calls):
                    return self._reject("incomplete-or-invalid-completion", "missing-external-effects")

                expected_ext_effects = _external_effects_only(
                    self._prepared.get("effects") or [],
                    exclude_world=self._is_stateful,
                )
                expected_dispatches = sorted(
                    (e for e in expected_ext_effects if e.get("kind") == "dispatch"),
                    key=lambda e: e["call"],
                )
                expected_settlements = sorted(
                    (e for e in expected_ext_effects if e.get("kind") == "settlement"),
                    key=lambda e: e["call"],
                )
                recorded_dispatches = [self._recorded_by_index[i][0] for i in range(len(fixture_calls))]
                recorded_settlements = [self._recorded_by_index[i][1] for i in range(len(fixture_calls))]
                effects_ok = (
                    len(expected_ext_effects) == 2 * len(fixture_calls)
                    and recorded_dispatches == expected_dispatches
                    and recorded_settlements == expected_settlements
                )
                world_state_ok = (
                    True
                    if not self._is_stateful or self._world is None
                    else self._world.matches_expected_final_world(self._expected_final_world)
                )

                if self._execution_kind == "cli":
                    self._completed = True
                    self._done = True
                    exp_cli = self._prepared.get("expectedCli") or self._prepared.get("outcome") or {
                        "exitCode": 0,
                        "stdout": "",
                        "stderr": "",
                    }
                    if action["kind"] != "cli":
                        self._success = False
                        self._reason = "outcome-mismatch"
                        self._failure_category = "wrong-completion-kind"
                    elif action["exitCode"] != exp_cli["exitCode"]:
                        self._success = False
                        self._reason = "outcome-mismatch"
                        self._failure_category = "wrong-exit-code"
                    elif action["stdout"] != exp_cli["stdout"]:
                        self._success = False
                        self._reason = "outcome-mismatch"
                        self._failure_category = "wrong-stdout"
                    elif action["stderr"] != exp_cli["stderr"]:
                        self._success = False
                        self._reason = "outcome-mismatch"
                        self._failure_category = "wrong-stderr"
                    elif not effects_ok:
                        self._success = False
                        self._reason = "outcome-mismatch"
                        self._failure_category = "effect-mismatch"
                    elif not world_state_ok:
                        self._success = False
                        self._reason = "world-state-mismatch"
                        self._failure_category = "world-state-mismatch"
                    else:
                        self._success = True
                        self._reason = "verified-complete-execution"
                        self._failure_category = None
                    return {"messages": [], "done": self._done, "grade": self.grade()}

                if action["kind"] == "cli":
                    self._completed = True
                    self._done = True
                    self._success = False
                    self._reason = "outcome-mismatch"
                    self._failure_category = "wrong-completion-kind"
                    return {"messages": [], "done": self._done, "grade": self.grade()}

                result = decode_readable({"arguments": action["arguments"], "value": action["value"]})
                _demand(
                    isinstance(result["arguments"], list)
                    and len(result["arguments"]) == len(self._prepared["args"]),
                    "Input argument arity changed",
                )
                actual = {
                    "kind": action["kind"],
                    "graph": describe_graph([*result["arguments"], result["value"]]),
                }
                expected_outcome = self._prepared["outcome"]
                expected_outcome_cmp = {
                    "kind": expected_outcome["kind"],
                    "graph": expected_outcome["graph"],
                }
                self._completed = True
                self._done = True
                outcome_ok = actual == expected_outcome_cmp
                self._success = outcome_ok and effects_ok and world_state_ok
                self._reason = (
                    "verified-complete-execution"
                    if self._success
                    else ("outcome-mismatch" if (not outcome_ok or not effects_ok) else "world-state-mismatch")
                )
                self._failure_category = None
                if not self._success:
                    expected_roots = realize_graph(expected_outcome["graph"])
                    expected_val = expected_roots.pop()
                    if actual["kind"] != expected_outcome["kind"]:
                        self._failure_category = "wrong-completion-kind"
                    elif describe_graph(result["arguments"]) != describe_graph(expected_roots):
                        per_arg_equal = all(
                            describe_graph([a]) == describe_graph([e])
                            for a, e in zip(result["arguments"], expected_roots)
                        )
                        self._failure_category = "alias-mismatch" if per_arg_equal else "mutation-mismatch"
                    elif describe_graph([result["value"]]) != describe_graph([expected_val]):
                        self._failure_category = (
                            "wrong-exception" if action["kind"] == "throw" else "wrong-return"
                        )
                    elif actual["graph"] != expected_outcome["graph"]:
                        self._failure_category = "alias-mismatch"
                    elif not effects_ok:
                        self._failure_category = "effect-mismatch"
                    else:
                        self._failure_category = "world-state-mismatch"
                return {"messages": [], "done": self._done, "grade": self.grade()}
            except Exception:
                return self._reject("incomplete-or-invalid-completion", "invalid-completion")

        try:
            batch = action["calls"] if action["type"] == "calls" else [action]
            observations: list[dict[str, Any]] = []
            for item in batch:
                args = decode_readable(item["arguments"])
                _demand(isinstance(args, list), "Call arguments must be a list")
                if item["operation"] == CODE_LOAD_OPERATION:
                    _demand(is_multifile_task(self._prepared), "code.load is only available on multi-file tasks")
                    result_items = serve_code_load(self._prepared["files"], args)
                    self._code_load_calls += 1
                    self._total_tool_calls += 1
                    tool_call_id = item.get("toolCallId") or f"call_{self._total_tool_calls}"
                    obs = _observation(CODE_LOAD_OPERATION, "fulfilled", result_items, tool_call_id)
                    self._code_load_bytes += len(obs["content"].encode("utf-8"))
                    observations.append(obs)
                    continue
                if self._is_stateful and self._world is not None and is_stateful_world_operation(item["operation"]):
                    status, value = self._world.execute(item["operation"], args)
                    self._world_calls += 1
                    self._total_tool_calls += 1
                    tool_call_id = item.get("toolCallId") or f"world_{self._world_calls}"
                    observations.append(_observation(item["operation"], status, value, tool_call_id))
                    continue
                actual_arg_graph = describe_graph(args)
                matched_idx = self._match_expected_call(item["operation"], args, actual_arg_graph)
                _demand(matched_idx >= 0, "External request mismatch")
                expected = fixture_calls[matched_idx]
                self._consumed[matched_idx] = True
                while self._epoch_start < len(fixture_calls) and self._consumed[self._epoch_start]:
                    self._epoch_start += 1
                status = expected["status"]
                value = expected["result"]
                self._recorded_by_index[matched_idx] = (
                    {
                        "kind": "dispatch",
                        "call": matched_idx,
                        "operation": expected["operation"],
                        "arguments": expected["argumentGraph"],
                    },
                    {
                        "kind": "settlement",
                        "call": matched_idx,
                        "operation": expected["operation"],
                        "status": status,
                        "result": describe_graph([value], allow_exceptions=True),
                    },
                )
                self._calls += 1
                self._total_tool_calls += 1
                tool_call_id = item.get("toolCallId") or f"call_{self._total_tool_calls}"
                observations.append(_observation(item["operation"], status, value, tool_call_id))
            return {"messages": observations, "done": False}
        except Exception:
            return self._reject("external-request-mismatch", "incorrect-external-request")

    def close(self) -> None:
        self._done = True


def create_python_session(prepared: dict[str, Any]) -> PythonExecutionSession:
    return PythonExecutionSession(prepared)


def create_cli_session(task_or_prepared: dict[str, Any]) -> PythonExecutionSession:
    """Create a live CLI grading session from either a raw CLI task or a prepared CLI task."""
    if (
        isinstance(task_or_prepared, dict)
        and isinstance(task_or_prepared.get("outcome"), dict)
        and task_or_prepared["outcome"].get("kind") == "cli"
        and "task" in task_or_prepared
    ):
        return PythonExecutionSession(task_or_prepared)
    prepared = prepare_python_task({**task_or_prepared, "executionKind": "cli"}, trace_format="actions-only")
    return PythonExecutionSession(prepared)


def audit_python_conversation(
    prepared: dict[str, Any],
    messages: list[dict[str, Any]],
    *,
    trace_format: str = "compact",
    reasoning_channel: str = "thinking",
) -> dict[str, Any]:
    """Replay teacher conversation through a fresh student session and verify exact match."""
    fmt = _validate_trace_format(trace_format)
    channel = _validate_reasoning_channel(reasoning_channel)
    _demand(isinstance(messages, list), "Teacher conversation must be a list")
    initial = initial_messages(prepared)
    _demand(messages[: len(initial)] == initial, "Teacher initial prompt differs from live prompt")
    expected_messages = readable_messages_from_python(
        prepared,
        trace_format=fmt,
        reasoning_channel=channel,
    )
    _demand(
        messages == expected_messages,
        "Teacher narration or observations differ from causal source events",
    )

    session = create_python_session(prepared)
    index = len(initial)
    calls = 0
    narration_lines = 0
    assistant_bytes = 0
    observation_bytes = 0
    try:
        while index < len(messages):
            message = messages[index]
            index += 1
            _demand(
                message.get("role") == "assistant"
                and isinstance(message.get("content"), (str, list)),
                "Expected a teacher action",
            )
            visible = assistant_visible_text(message)
            thinking = assistant_thinking_text(message)
            action = parse_student_action(message)
            fence = visible.find("```")
            if isinstance(message.get("tool_calls"), list) and message["tool_calls"]:
                prose = visible.strip()
            else:
                prose = "" if fence < 0 else visible[:fence].strip()
            narration = "\n".join(part for part in (thinking.strip(), prose) if part)
            if narration:
                narration_lines += len(narration.split("\n"))
            assistant_bytes += len(visible.encode("utf-8")) + len(thinking.encode("utf-8"))
            if message.get("tool_calls"):
                assistant_bytes += len(_json_compact(message["tool_calls"]).encode("utf-8"))
            step_res = session.step(message, 0)
            _demand(not step_res["done"] or step_res["grade"]["success"], "Teacher replay failed complete execution")
            if action["type"] == "call":
                calls += 1
            elif action["type"] == "calls":
                calls += len(action["calls"])
            for obs in step_res["messages"]:
                _demand(index < len(messages) and messages[index] == obs, "Teacher observation differs from actual environment")
                index += 1
                observation_bytes += len(obs["content"].encode("utf-8"))
            _demand(not step_res["done"] or index == len(messages), "Teacher conversation continues after completion")
        final_grade = session.grade()
        _demand(final_grade["success"], "Teacher conversation never completed")
        if fmt == "actions-only":
            _demand(narration_lines == 0, "Removed teacher narration remains in the input")
        return {
            "replayVerified": True,
            "canonicalCausalNarration": True,
            "observationsMatched": True,
            "traceFormat": fmt,
            "reasoningChannel": channel,
            "messages": len(messages),
            "calls": calls,
            "codeLoadCalls": final_grade["codeLoadCalls"],
            "codeLoadBytes": final_grade["codeLoadBytes"],
            "narrationLines": narration_lines,
            "assistantBytes": assistant_bytes,
            "observationBytes": observation_bytes,
        }
    finally:
        session.close()


def export_python_example(
    task: dict[str, Any],
    *,
    trace_format: str = "compact",
    reasoning_channel: str = "thinking",
) -> dict[str, Any]:
    """Run isolated Python worker, generate causal conversation, and verify via replay audit."""
    fmt = _validate_trace_format(trace_format)
    channel = _validate_reasoning_channel(reasoning_channel)
    prepared = prepare_python_task(task, trace_format=fmt)
    messages = readable_messages_from_python(
        prepared,
        trace_format=fmt,
        reasoning_channel=channel,
    )
    trace_audit = audit_python_conversation(
        prepared,
        messages,
        trace_format=fmt,
        reasoning_channel=channel,
    )
    meta: dict[str, Any] = copy.deepcopy(task.get("metadata") or {})
    if task.get("features") is not None:
        meta["features"] = copy.deepcopy(task["features"])
    if task.get("tier") is not None:
        meta["tier"] = task["tier"]
    meta.update({
        "sourceVerified": True,
        "teacher": "native-python-reference",
        "traceFormat": fmt,
        "reasoningChannel": channel,
        "traceAudit": trace_audit,
        "traceRenderer": "sys-settrace-causal-compact",
        "externalObservationsTrainable": False,
        "runtimeIdentifiersInTargets": False,
        "externalCalls": len(prepared["fixture"]["calls"]),
        "profile": "sequential-data-execution",
        "exceptionProfile": "declared-error/name-message/1",
        "optimizerSteps": 0,
    })
    if is_multifile_task(prepared):
        meta["multifile"] = True
        meta["fileCount"] = len(prepared["files"])
        meta["entryFile"] = prepared["entryFile"]
        meta["codeLoadCalls"] = trace_audit["codeLoadCalls"]
        meta["codeLoadBytes"] = trace_audit["codeLoadBytes"]
    return {
        "schema": TINKER_PY_EXECUTION_SCHEMA,
        "id": prepared["id"],
        "family": prepared["family"],
        "sourceHash": prepared["sourceHash"],
        "task": prepared["task"],
        "messages": messages,
        "metadata": meta,
    }


def _initial_prefix_length(messages: list[dict[str, Any]]) -> int:
    for idx, msg in enumerate(messages):
        if msg.get("role") == "user":
            return idx + 1
    return 2


def _observations_of(messages: list[dict[str, Any]]) -> list[tuple[int, dict[str, Any]]]:
    start = _initial_prefix_length(messages)
    return [
        (idx, msg)
        for idx, msg in enumerate(messages)
        if idx >= start and msg.get("role") in ("tool", "user")
    ]


def _audit_causal_prefix_pair(left: list[dict[str, Any]], right: list[dict[str, Any]]) -> dict[str, Any]:
    prefix_len = _initial_prefix_length(left)
    _demand(
        prefix_len == _initial_prefix_length(right) and left[:prefix_len] == right[:prefix_len],
        "Causal pair public prompts differ",
    )
    ao = _observations_of(left)
    bo = _observations_of(right)
    div = -1
    for i, (_, msg_a) in enumerate(ao):
        if i >= len(bo) or msg_a != bo[i][1]:
            div = i
            break
    if div < 0:
        _demand(len(ao) == len(bo) and left == right, "Identical observations changed the conversation")
        return {"passed": True, "testedDivergence": False, "identicalPrefixMessages": len(left)}
    _demand(div < len(bo), "Invalid divergence observation")
    ai = ao[div][0]
    bi = bo[div][0]
    _demand(ai == bi and left[:ai] == right[:bi], "Future observation changed an earlier model-visible prefix")
    return {"passed": True, "testedDivergence": True, "divergenceObservation": div, "identicalPrefixMessages": ai}


def audit_python_supervision(tasks: list[dict[str, Any]], options: dict[str, Any] | None = None) -> dict[str, Any]:
    """Deterministic feature-stratified supervision audit for Python tasks."""
    opts = options or {}
    formats = list(opts.get("formats", TINKER_TRACE_FORMATS))
    sample_per_feature = int(opts.get("samplePerFeature", 2))
    seed = int(opts.get("seed", 17))
    include_messages = bool(opts.get("includeMessages", False))

    _demand(isinstance(tasks, list) and len(tasks) > 0, "Audit requires a nonempty task list")
    _demand(sample_per_feature > 0, "samplePerFeature must be positive")
    _demand(
        len(formats) > 0 and len(set(formats)) == len(formats) and all(f in TINKER_TRACE_FORMATS for f in formats),
        "Invalid audit trace formats",
    )

    by_feature: dict[str, list[dict[str, Any]]] = {}
    selected: dict[str, dict[str, Any]] = {}
    supplied: dict[str, dict[str, Any]] = {}
    seen_ids: set[str] = set()

    for row in tasks:
        inp = row.get("task", row)
        if row.get("messages"):
            supplied[inp["id"]] = row
        _demand(isinstance(inp.get("id"), str) and inp["id"] not in seen_ids, "Audit task IDs must be unique")
        seen_ids.add(inp["id"])
        feats = (inp.get("metadata") or {}).get("features") or inp.get("features") or ["unclassified"]
        for feat in sorted(set(feats)):
            by_feature.setdefault(feat, []).append(inp)

    for group in by_feature.values():
        group.sort(key=lambda item: _sha256([seed, item["id"]]))
        for inp in group[:sample_per_feature]:
            selected[inp["id"]] = inp

    rows: list[dict[str, Any]] = []
    pairs: list[dict[str, Any]] = []
    conversations: dict[str, list[dict[str, Any]]] = {}
    format_totals: dict[str, dict[str, int]] = {}
    supplied_audits: list[dict[str, Any]] = []

    want_trace = any(f != "actions-only" for f in formats)
    for tid in sorted(selected.keys()):
        inp = selected[tid]
        prepared = prepare_python_task(inp, trace_format="compact" if want_trace else "actions-only")
        orig = supplied.get(tid)
        if orig:
            _demand(orig.get("sourceHash") == prepared["sourceHash"], "Exported source identity differs from task")
            meta = orig.get("metadata") or {}
            supplied_audits.append({
                "id": tid,
                **audit_python_conversation(
                    prepared,
                    orig["messages"],
                    trace_format=meta.get("traceFormat", "compact"),
                    reasoning_channel=meta.get("reasoningChannel", "thinking"),
                ),
            })
        for fmt in formats:
            msgs = readable_messages_from_python(prepared, trace_format=fmt)
            audit = audit_python_conversation(prepared, msgs, trace_format=fmt)
            row = {
                "id": prepared["id"],
                "family": prepared["family"],
                "sourceHash": prepared["sourceHash"],
                "taskDigest": _sha256(prepared["task"]),
                "traceFormat": fmt,
                **audit,
                **({"messages": msgs} if include_messages else {}),
            }
            rows.append(row)
            key = _sha256([fmt, msgs[: _initial_prefix_length(msgs)]])
            conversations.setdefault(key, []).append({"id": tid, "traceFormat": fmt, "messages": msgs})
            tot = format_totals.setdefault(
                fmt, {"conversations": 0, "narrationLines": 0, "assistantBytes": 0, "observationBytes": 0}
            )
            tot["conversations"] += 1
            tot["narrationLines"] += audit["narrationLines"]
            tot["assistantBytes"] += audit["assistantBytes"]
            tot["observationBytes"] += audit["observationBytes"]

    for group in conversations.values():
        for idx in range(1, len(group)):
            left = group[0]
            right = group[idx]
            pairs.append({
                "left": left["id"],
                "right": right["id"],
                "traceFormat": left["traceFormat"],
                **_audit_causal_prefix_pair(left["messages"], right["messages"]),
            })

    divergences = sum(1 for p in pairs if p.get("testedDivergence"))
    return {
        "schema": "tinker-supervision-audit/1",
        "evidenceKind": "local-teacher-data-audit",
        "modelPerformanceEvidence": False,
        "valid": True,
        "success": True,
        "failures": [],
        "summary": {
            "inputTasks": len(tasks),
            "sampleTasks": len(selected),
            "conversations": len(rows),
            "formats": formats,
            "causalPairs": len(pairs),
            "causalDivergencesChecked": divergences,
        },
        "seed": seed,
        "samplePerFeature": sample_per_feature,
        "inputTasks": len(tasks),
        "inputDigest": _sha256(tasks),
        "sampleTasks": len(selected),
        "formats": formats,
        "allReplayed": all(r["replayVerified"] for r in rows),
        "formatTotals": format_totals,
        "causalPairs": pairs,
        "causalDivergencesChecked": divergences,
        "suppliedConversationAudits": supplied_audits,
        "rows": rows,
    }
