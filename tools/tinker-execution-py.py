#!/usr/bin/env python3
"""Persistent line-delimited JSONL bridge for Python execution tasks.

Matches the exact wire protocol of tools/tinker-execution.mjs:
  ops: health, export, audit, start, step, grade, close
"""

from __future__ import annotations

from collections import OrderedDict
import hashlib
import json
from pathlib import Path
import platform
import sys
from typing import Any
import uuid

_REPO_ROOT = Path(__file__).resolve().parents[1]
_TRAINING_DIR = str(_REPO_ROOT / "training")
if _TRAINING_DIR not in sys.path:
    sys.path.insert(0, _TRAINING_DIR)

from tinker_py.execution import (  # noqa: E402
    TINKER_PY_EXECUTION_SCHEMA,
    audit_python_conversation,
    audit_python_supervision,
    create_python_session,
    prepare_python_task,
    readable_messages_from_python,
)

MAX_PREPARED_CACHE = 4096
MAX_LIVE_SESSIONS = 128
MAX_REQUEST_BYTES = 64 * 1024 * 1024

_sessions: dict[str, Any] = {}
_prepared_cache: OrderedDict[str, dict[str, Any]] = OrderedDict()


def _json_compact(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def _key_of(value: Any) -> str:
    return hashlib.sha256(_json_compact(value).encode("utf-8")).hexdigest()


def _cache_prepared(input_key: str, prepared: dict[str, Any]) -> dict[str, Any]:
    lightweight = {k: v for k, v in prepared.items() if k != "traceTurns"}
    _prepared_cache[input_key] = lightweight
    _prepared_cache[_key_of(prepared["task"])] = lightweight
    while len(_prepared_cache) > MAX_PREPARED_CACHE * 2:
        _prepared_cache.popitem(last=False)
    return lightweight


def _prepare_for_session(task: dict[str, Any]) -> dict[str, Any]:
    key = _key_of(task)
    cached = _prepared_cache.get(key)
    if cached is not None:
        return cached
    prepared = prepare_python_task(task, trace_format="actions-only")
    return _cache_prepared(key, prepared)


def _get_session(session_id: Any) -> Any:
    live = _sessions.get(session_id)
    if live is None:
        raise TypeError("Unknown execution session")
    return live


def dispatch(request: dict[str, Any]) -> Any:
    op = request.get("op")
    if op == "health":
        return {"schema": TINKER_PY_EXECUTION_SCHEMA, "python": platform.python_version()}

    if op == "export":
        trace_format = request.get("traceFormat") or "compact"
        reasoning_channel = request.get("reasoningChannel") or "thinking"
        task = request.get("task")
        key = _key_of(task)
        prepared = prepare_python_task(task, trace_format=trace_format)
        _cache_prepared(key, prepared)
        messages = readable_messages_from_python(
            prepared,
            trace_format=trace_format,
            reasoning_channel=reasoning_channel,
        )
        trace_audit = audit_python_conversation(
            prepared,
            messages,
            trace_format=trace_format,
            reasoning_channel=reasoning_channel,
        )
        meta: dict[str, Any] = dict(task.get("metadata") or {})
        if task.get("features") is not None:
            meta["features"] = list(task["features"])
        if task.get("tier") is not None:
            meta["tier"] = task["tier"]
        meta.update({
            "sourceVerified": True,
            "teacher": "native-python-reference",
            "traceFormat": trace_format,
            "reasoningChannel": reasoning_channel,
            "traceAudit": trace_audit,
            "traceRenderer": "sys-settrace-causal-compact",
            "externalObservationsTrainable": False,
            "runtimeIdentifiersInTargets": False,
            "externalCalls": len(prepared["fixture"]["calls"]),
            "profile": "sequential-data-execution",
            "exceptionProfile": "declared-error/name-message/1",
            "optimizerSteps": 0,
        })
        return {
            "schema": TINKER_PY_EXECUTION_SCHEMA,
            "id": prepared["id"],
            "family": prepared["family"],
            "sourceHash": prepared["sourceHash"],
            "task": prepared["task"],
            "messages": messages,
            "metadata": meta,
        }

    if op == "audit":
        return audit_python_supervision(request.get("tasks") or [], request.get("options") or {})

    if op == "start":
        if len(_sessions) >= MAX_LIVE_SESSIONS:
            raise RuntimeError("Too many live execution sessions")
        prepared = _prepare_for_session(request.get("task"))
        live = create_python_session(prepared)
        session_id = str(uuid.uuid4())
        _sessions[session_id] = live
        return {"sessionId": session_id, "messages": live.messages}

    if op == "step":
        return _get_session(request.get("sessionId")).step(
            request.get("action"),
            request.get("generatedTokens"),
        )

    if op == "grade":
        return _get_session(request.get("sessionId")).grade(request.get("totalGeneratedTokens"))

    if op == "close":
        session_id = request.get("sessionId")
        live = _sessions.pop(session_id, None)
        if live is not None:
            live.close()
        return {"closed": live is not None}

    raise TypeError("Unknown execution worker operation")


def main() -> int:
    for line in sys.stdin:
        if not line.strip():
            continue
        req: Any = None
        try:
            if len(line.encode("utf-8")) > MAX_REQUEST_BYTES:
                raise ValueError("Worker request exceeds size limit")
            req = json.loads(line)
            if not isinstance(req, dict):
                raise TypeError("Worker request must be an object")
            result = dispatch(req)
            sys.stdout.write(_json_compact({"id": req.get("id"), "ok": True, "result": result}) + "\n")
            sys.stdout.flush()
        except Exception as exc:
            req_id = req.get("id") if isinstance(req, dict) else None
            sys.stdout.write(
                _json_compact({
                    "id": req_id,
                    "ok": False,
                    "error": {"name": type(exc).__name__, "message": str(exc)},
                })
                + "\n"
            )
            sys.stdout.flush()

    for live in list(_sessions.values()):
        live.close()
    _sessions.clear()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
