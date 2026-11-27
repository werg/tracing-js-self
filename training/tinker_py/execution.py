"""Python execution task preparation, causal conversation export, audit, and live grading session.

Mirrors src/training/tinker-execution.js and src/training/tinker-supervision.js
for native Python execution with sys.settrace compact traces.
"""

from __future__ import annotations

import ast
import copy
import hashlib
import json
from pathlib import Path
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

PY_HOST_OPERATIONS: dict[str, dict[str, Any]] = {
    "platform.print": {"arity": None, "description": "Invoke Python print(*args) external operation."},
    "platform.time": {
        "arity": 0,
        "description": "Invoke Python time.time()/time.monotonic()/datetime.now()/today() external clock operation (0 arguments).",
    },
    "platform.random": {"arity": 0, "description": "Invoke Python random.random() external operation (0 arguments)."},
    "platform.log": {
        "arity": 2,
        "description": "Invoke Python logging operation (2 arguments: [level_name, formatted_message]). Returns None.",
    },
    "platform.uuid": {
        "arity": 0,
        "description": "Invoke Python uuid.uuid4() external operation (0 arguments). Returns canonical UUID string.",
    },
    "platform.secrets": {
        "arity": 2,
        "description": 'Invoke Python secrets external operation (2 arguments: [method_name, int_arg], e.g. ["token_hex", 16] or ["randbelow", 100]).',
    },
    "fs.readText": {"arity": 1, "description": "Invoke Python external operation fs.readText (1 argument: [path])."},
    "fs.readBytes": {"arity": 1, "description": "Read binary file contents from path (1 argument: [path]). Returns bytes."},
    "fs.writeText": {"arity": 2, "description": "Invoke Python external operation fs.writeText (2 arguments: [path, text])."},
    "fs.writeBytes": {"arity": 2, "description": "Write binary bytes to path (2 arguments: [path, data]). Returns None."},
    "fs.exists": {"arity": 1, "description": "Check whether filesystem path exists (1 argument: [path]). Returns bool."},
    "fs.isFile": {"arity": 1, "description": "Check whether filesystem path is a regular file (1 argument: [path]). Returns bool."},
    "fs.isDir": {"arity": 1, "description": "Check whether filesystem path is a directory (1 argument: [path]). Returns bool."},
    "fs.listdir": {"arity": 1, "description": "List entry names in directory path (1 argument: [path]). Returns sorted list of strings."},
    "env.get": {"arity": 1, "description": "Read environment variable (1 argument: [key]). Returns string value or None."},
    "shell.exec": {
        "arity": 1,
        "description": (
            'Execute subprocess command (1 argument: {"args": str | list[str], "shell": bool}). '
            'Returns {"returncode": int, "stdout": str | bytes, "stderr": str | bytes}.'
        ),
    },
    "http.get": {"arity": 1, "description": "Invoke Python external operation http.get (1 argument)."},
    "http.request": {
        "arity": 1,
        "description": (
            'Invoke Python external HTTP request (1 argument: canonical dict {"method":"GET"|"POST"|...,"url":str,'
            '"headers"?:dict[str,str],"body"?:str|bytes}; omit "headers" if empty and "body" if None). '
            'Returns {"status":int,"url":str,"headers":dict[str,str],"body":str|bytes}.'
        ),
    },
    "kv_get": {"arity": 1, "description": "Invoke Python external operation kv_get (1 argument)."},
    "kv_set": {"arity": 2, "description": "Invoke Python external operation kv_set (2 arguments)."},
}

SYSTEM_PROMPT = """Execute the supplied Python program accurately.
- For every external read, write, env lookup, log, subprocess, clock, print, random, uuid, secrets, HTTP, or host call, invoke the declared tool with {"arguments":[...]} in exact execution order; never invent observations.
- Filesystem calls (open/Path/os.listdir/os.path) map to fs.readText, fs.readBytes, fs.writeText, fs.writeBytes, fs.exists, fs.isFile, fs.isDir, fs.listdir; env (os.getenv/os.environ) maps to env.get; logging maps to platform.log; subprocess.run/check_output maps to shell.exec; datetime.now/utcnow/today maps to platform.time; uuid.uuid4 maps to platform.uuid; secrets maps to platform.secrets.
- HTTP calls (urllib.request.urlopen, requests.get/post/request/Session) invoke http.request with {"arguments":[{"method":"GET"|...,"url":str,"headers"?:{...},"body"?:str|bytes}]} (omit empty "headers" and None "body").
- When execution finishes, end with one JSON completion in a ```json code fence (or bare JSON):
  {"type":"complete","kind":"return"|"throw","arguments":[final input args],"value":resultOrError}
- Final "arguments" must reflect all input mutations and aliases. Standard exceptions use {"name":"ValueError","message":"..."}.
- Special Python values: {"$py":"NaN"|"-0"|"Infinity"|"-Infinity"}, {"$py":"tuple","items":[...]}, {"$py":"set","items":[...]}, {"$py":"frozenset","items":[...]}, {"$py":"bytes","b64":"..."}, {"$py":"complex","real":...,"imag":...}, {"$py":"decimal","value":"..."}, {"$py":"datetime","iso":"..."}, {"$py":"date","iso":"..."}, {"$py":"timedelta","days":...,"seconds":...,"microseconds":...}, {"$py":"path","value":"..."}, {"$py":"enum","class":"...","name":"...","value":...}, {"$py":"object","class":"...","attrs":{...}}, {"$py":"dict","entries":[[k,v],...]} for non-string or $py-keyed dicts, {"$py":"ref","path":"/arguments/0"} (paths rooted at {arguments,value} for completions or at the arguments array for tool calls)."""

MULTIFILE_SYSTEM_PROMPT = (
    SYSTEM_PROMPT
    + '\n- Multi-file repository mode: only the entry file is shown initially. Call code.load with {"arguments":[{"path":"..."}]} '
    '(whole file for small files) or {"arguments":[{"path":"...","symbol":"..."}]} (symbol snippet for large files) '
    'or {"arguments":[{"path":"...","start_line":N,"end_line":M}]} whenever you need code from another file; you may batch multiple requests.'
)


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


def _scan_public_source_tools(source: str, random_mode: str, native_bindings: list[dict[str, Any]]) -> tuple[list[str], bool]:
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
    spec = PY_HOST_OPERATIONS.get(operation)
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


def initial_messages(prepared: dict[str, Any]) -> list[dict[str, Any]]:
    """Build initial public messages (system, optional tool_declare, user)."""
    if is_multifile_task(prepared):
        files = prepared["files"]
        entry_file = prepared["entryFile"]
        loaded_files = prepared.get("initialLoadedFiles") or [entry_file]
        op_set: set[str] = {CODE_LOAD_OPERATION}
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
            "Execute this multi-file Python repository:",
            manifest,
            f"Loaded entry file ({entry_file}):",
            "```python\n" + files[entry_file] + "\n```",
        ]
        for extra_path in loaded_files:
            if extra_path != entry_file and extra_path in files:
                parts.append(f"Loaded file ({extra_path}):")
                parts.append("```python\n" + files[extra_path] + "\n```")
        parts.append(
            "Entry: "
            + prepared["entry"]
            + " in "
            + entry_file
            + " with arguments "
            + _json_compact(encode_readable(prepared["args"]))
        )
        system_prompt = MULTIFILE_SYSTEM_PROMPT
    else:
        operations, uses_random = _scan_public_source_tools(
            prepared["source"],
            prepared["randomMode"],
            prepared["nativeBindings"],
        )
        parts = [
            "Execute this Python program:",
            "```python\n" + prepared["source"] + "\n```",
            "Entry: " + prepared["entry"] + " with arguments " + _json_compact(encode_readable(prepared["args"])),
        ]
        system_prompt = SYSTEM_PROMPT

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


def normalize_python_task(input_task: dict[str, Any]) -> dict[str, Any]:
    _demand(isinstance(input_task, dict), "Task must be a dict")
    task_id = input_task.get("id")
    family = input_task.get("family")
    _demand(isinstance(task_id, str) and 0 < len(task_id) <= 256, "Task id required")
    _demand(isinstance(family, str) and len(family) > 0, "Source family required")

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

    entry = input_task.get("entry", "run")
    _demand(isinstance(entry, str) and entry.isidentifier(), "Entry must be a valid Python identifier")

    language = input_task.get("language", "py")
    _demand(language == "py", "Language must be py")

    args = decode_readable(input_task.get("args", []))
    _demand(isinstance(args, list) and len(args) <= 32, "At most 32 input arguments are supported")

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
        source_hash = normalized_py_source_hash(source)

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
        "randomMode": random_mode,
        "randomSeed": random_seed,
        "maxSteps": max_steps,
        "timeoutMs": timeout_ms,
        "task": canonical_task,
    }
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


def prepare_python_task(input_task: dict[str, Any], *, trace_format: str = "compact") -> dict[str, Any]:
    """Execute Python task in isolated worker with optional sys.settrace compact tracing."""
    fmt = _validate_trace_format(trace_format)
    prepared = normalize_python_task(input_task)
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

    roots = realize_graph(prepared["outcome"]["graph"])
    value = roots.pop()
    completion = encode_readable({"arguments": roots, "value": value})
    final_turn = turns[len(dispatches)] if turns is not None and len(dispatches) < len(turns) else []
    messages.append(
        _assistant_message(
            {
                "type": "complete",
                "kind": prepared["outcome"]["kind"],
                "arguments": completion["arguments"],
                "value": completion["value"],
            },
            final_turn,
            channel,
        )
    )
    return messages


def _validate_action_object(action: Any) -> dict[str, Any]:
    _demand(isinstance(action, dict), "Expected a JSON action object")
    action_type = action.get("type")
    if action_type == "call":
        fields = ",".join(sorted(action.keys()))
        _demand(fields == "arguments,operation,type" and isinstance(action.get("operation"), str), "Invalid external call action")
        return action
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
            if isinstance(parsed, dict) and isinstance(parsed.get("type"), str):
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


def _external_effects_only(effects: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Filter out read-only `code.load` effects and renumber remaining external effect IDs."""
    id_map: dict[int, int] = {}
    out: list[dict[str, Any]] = []
    for eff in effects:
        if eff.get("operation") == CODE_LOAD_OPERATION:
            continue
        orig_id = eff["call"]
        if orig_id not in id_map:
            id_map[orig_id] = len(id_map)
        out.append({**eff, "call": id_map[orig_id]})
    return out


class PythonExecutionSession:
    """Stateful live grading session for Python execution tasks."""

    def __init__(self, prepared: dict[str, Any]) -> None:
        self._prepared = prepared
        self.messages = initial_messages(prepared)
        self._done = False
        self._completed = False
        self._success = False
        self._reason = "incomplete"
        self._failure_category: str | None = "incomplete"
        self._generated_tokens = 0
        self._calls = 0
        self._total_tool_calls = 0
        self._code_load_calls = 0
        self._code_load_bytes = 0
        self._turns = 0
        self._recorded_effects: list[dict[str, Any]] = []
        max_turns = prepared["task"].get("maxTurns", 256)
        _demand(
            isinstance(max_turns, int) and not isinstance(max_turns, bool) and 0 < max_turns <= 4096,
            "Invalid rollout turn limit",
        )
        self._max_turns = max_turns

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
        return {
            "success": ok,
            "reward": (1.0 / (1.0 + self._generated_tokens / 1000.0)) if ok else 0.0,
            "reason": self._reason,
            "failureCategory": self._failure_category,
            "generatedTokens": self._generated_tokens,
            "externalCalls": self._calls,
            "codeLoadCalls": self._code_load_calls,
            "codeLoadBytes": self._code_load_bytes,
            "complete": self._completed,
        }

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

        fixture_calls = self._prepared["fixture"]["calls"]

        if action["type"] == "complete":
            try:
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
                if self._calls != len(fixture_calls):
                    return self._reject("incomplete-or-invalid-completion", "missing-external-effects")

                expected_outcome = self._prepared["outcome"]
                expected_outcome_cmp = {
                    "kind": expected_outcome["kind"],
                    "graph": expected_outcome["graph"],
                }
                self._completed = True
                self._done = True
                self._success = (
                    actual == expected_outcome_cmp
                    and self._recorded_effects == _external_effects_only(self._prepared["effects"])
                )
                self._reason = "verified-complete-execution" if self._success else "outcome-mismatch"
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
                    else:
                        self._failure_category = "effect-mismatch"
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
                if self._calls >= len(fixture_calls):
                    raise TypeError("Unexpected extra external call")
                expected = fixture_calls[self._calls]
                actual_arg_graph = describe_graph(args)
                _demand(
                    expected["operation"] == item["operation"] and actual_arg_graph == expected["argumentGraph"],
                    "External request mismatch",
                )
                cid = self._calls
                status = expected["status"]
                value = expected["result"]
                self._recorded_effects.append({
                    "kind": "dispatch",
                    "call": cid,
                    "operation": item["operation"],
                    "arguments": actual_arg_graph,
                })
                self._recorded_effects.append({
                    "kind": "settlement",
                    "call": cid,
                    "operation": item["operation"],
                    "status": status,
                    "result": describe_graph([value], allow_exceptions=True),
                })
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
