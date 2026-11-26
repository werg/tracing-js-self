#!/usr/bin/env python3
"""Isolated Python reference execution process.

Reads a JSON task request from stdin, executes guest Python code in this
isolated process with intercepted external operations and optional sys.settrace
compact causal tracing, and writes one JSON response to stdout.
"""

from __future__ import annotations

import builtins
import io
import json
import os
from pathlib import Path
import random
import resource
import signal
import sys
import time
from typing import Any

# Ensure training/ package root is importable regardless of PYTHONPATH.
_REPO_ROOT = Path(__file__).resolve().parents[1]
_TRAINING_DIR = str(_REPO_ROOT / "training")
if _TRAINING_DIR not in sys.path:
    sys.path.insert(0, _TRAINING_DIR)

from tinker_py.codec import (  # noqa: E402
    decode_readable,
    describe_graph,
    encode_exception,
    encode_readable,
)
from tinker_py.http_tools import install_replay_http_hooks  # noqa: E402
from tinker_py.tracer import TraceLimitError, create_python_tracer  # noqa: E402

PY_HOST_METHODS: dict[str, str] = {
    "fs_read_text": "fs.readText",
    "fs_write_text": "fs.writeText",
    "http_get": "http.get",
    "http_request": "http.request",
    "kv_get": "kv_get",
    "kv_set": "kv_set",
}


class _BrokerError(BaseException):
    """Infrastructure/fixture error that guest `except Exception:` cannot swallow."""

    def __init__(self, message: str, category: str = "reference_process_failure") -> None:
        super().__init__(message)
        self.category = category


class _TimeoutError(BaseException):
    """Wall-clock timeout error."""


class _HostProxy:
    def __init__(self, invoke_fn: Any, extra_methods: dict[str, str]) -> None:
        self._invoke = invoke_fn
        self._methods = dict(PY_HOST_METHODS)
        self._methods.update(extra_methods)

    def __getattr__(self, name: str) -> Any:
        if name.startswith("_"):
            raise AttributeError(name)
        if name in self._methods:
            op = self._methods[name]
            return lambda *args: self._invoke(op, list(args))
        raise AttributeError(f"host has no method {name!r}")


def _build_guest_exception(value: Any) -> Exception:
    if isinstance(value, dict) and isinstance(value.get("name"), str):
        exc_cls = getattr(builtins, value["name"], None)
        if isinstance(exc_cls, type) and issubclass(exc_cls, Exception):
            return exc_cls(str(value.get("message", "")))
        return RuntimeError(f"{value['name']}: {value.get('message', '')}")
    return RuntimeError(str(value))


def _apply_resource_limits(timeout_ms: int) -> None:
    cpu_seconds = max(2, int((timeout_ms + 999) // 1000) + 2)
    try:
        soft, hard = resource.getrlimit(resource.RLIMIT_CPU)
        new_soft = min(cpu_seconds, hard) if hard != resource.RLIM_INFINITY else cpu_seconds
        resource.setrlimit(resource.RLIMIT_CPU, (new_soft, hard))
    except (OSError, ValueError):
        pass
    try:
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    except (OSError, ValueError):
        pass
    if hasattr(signal, "SIGALRM"):
        def _on_alarm(_signum: int, _frame: Any) -> None:
            raise _TimeoutError(f"Python reference execution exceeded {timeout_ms}ms")

        signal.signal(signal.SIGALRM, _on_alarm)
        signal.setitimer(signal.ITIMER_REAL, max(0.1, timeout_ms / 1000.0))


def _cancel_alarm() -> None:
    if hasattr(signal, "SIGALRM"):
        signal.setitimer(signal.ITIMER_REAL, 0.0)


def _json_dump(obj: Any) -> str:
    return json.dumps(obj, ensure_ascii=True, separators=(",", ":"), allow_nan=False)


def main() -> int:
    real_stdout = sys.stdout
    phase = "input"
    try:
        raw = sys.stdin.read()
        req = json.loads(raw)
        if not isinstance(req, dict):
            raise TypeError("Worker input must be a JSON object")

        source = req.get("source")
        entry = req.get("entry", "run")
        if not isinstance(source, str) or not source:
            raise TypeError("Nonempty source required")
        if not isinstance(entry, str) or not entry.isidentifier():
            raise TypeError("Valid entry identifier required")

        timeout_ms = int(req.get("timeoutMs", 10000))
        max_steps = int(req.get("maxSteps", 100000))
        trace_enabled = bool(req.get("trace", False))
        random_mode = req.get("randomMode", "seeded")
        random_seed = req.get("randomSeed", 17)
        native_bindings = req.get("nativeBindings") or []
        fixture_raw = req.get("fixture") or {"calls": []}
        fixture_calls_raw = fixture_raw.get("calls") or []

        args = decode_readable(req.get("args", []))
        if not isinstance(args, list):
            raise TypeError("Entry arguments must be a list")

        # Decode expected fixture calls upfront.
        expected_calls: list[dict[str, Any]] = []
        for idx, call in enumerate(fixture_calls_raw):
            op = call.get("operation")
            if not isinstance(op, str) or not op:
                raise TypeError(f"Fixture call {idx} missing operation")
            call_args = decode_readable(call.get("arguments", []))
            if not isinstance(call_args, list):
                raise TypeError(f"Fixture call {idx} arguments must be a list")
            call_status = call.get("status", "fulfilled")
            if call_status not in ("fulfilled", "rejected"):
                raise TypeError(f"Fixture call {idx} invalid status")
            call_result = decode_readable(call.get("result"))
            expected_calls.append({
                "operation": op,
                "arguments": call_args,
                "argumentGraph": describe_graph(call_args),
                "status": call_status,
                "result": call_result,
            })

        effects: list[dict[str, Any]] = []
        call_index = 0
        infrastructure_failures: list[tuple[str, str]] = []

        tracer = (
            create_python_tracer(
                source,
                entry_name=entry,
                max_events=max(50_000, min(max_steps * 5, 1_000_000)),
            )
            if trace_enabled
            else None
        )

        def invoke(
            operation: str,
            call_args: list[Any],
            exc_builder: Any = None,
        ) -> Any:
            nonlocal call_index
            if tracer is not None:
                tracer.next_turn()
            try:
                actual_graph = describe_graph(call_args)
            except Exception as exc:
                infrastructure_failures.append(
                    ("reference_instrumentation_unsupported", f"Unrepresentable call arguments for {operation}: {exc}")
                )
                raise _BrokerError(str(exc), "reference_instrumentation_unsupported") from exc

            if call_index >= len(expected_calls):
                msg = f"Unexpected external call #{call_index + 1}: {operation}"
                infrastructure_failures.append(("reference_process_failure", msg))
                raise _BrokerError(msg)

            expected = expected_calls[call_index]
            if expected["operation"] != operation or expected["argumentGraph"] != actual_graph:
                msg = f"External call #{call_index + 1} mismatch: got {operation}, expected {expected['operation']}"
                infrastructure_failures.append(("reference_process_failure", msg))
                raise _BrokerError(msg)

            cid = call_index
            call_index += 1
            result_val = expected["result"]
            status = expected["status"]
            effects.append({
                "kind": "dispatch",
                "call": cid,
                "operation": operation,
                "arguments": actual_graph,
            })
            effects.append({
                "kind": "settlement",
                "call": cid,
                "operation": operation,
                "status": status,
                "result": describe_graph([result_val], allow_exceptions=True),
            })
            if status == "rejected":
                if callable(exc_builder):
                    raise exc_builder(result_val)
                raise _build_guest_exception(result_val)
            # Return a fresh copy via encode/decode so guest mutations of returned
            # containers cannot corrupt fixture expectations.
            return decode_readable(encode_readable(result_val, allow_exceptions=True))

        # Patch external platform interfaces before compiling/executing guest code.
        has_http_fixture = any(c["operation"] == "http.request" for c in expected_calls)
        enable_urllib = has_http_fixture or ("urllib" in source) or ("urlopen" in source)
        enable_requests = has_http_fixture or ("requests" in source)
        if enable_urllib or enable_requests:
            install_replay_http_hooks(
                invoke,
                enable_urllib=enable_urllib,
                enable_requests=enable_requests,
            )
        def _platform_print(*print_args: Any, **_kwargs: Any) -> None:
            invoke("platform.print", list(print_args))

        def _platform_time() -> Any:
            return invoke("platform.time", [])

        time.time = _platform_time  # type: ignore[assignment]
        time.monotonic = _platform_time  # type: ignore[assignment]

        uses_tool_random = random_mode == "tool" or any(
            c["operation"] == "platform.random" for c in expected_calls
        )
        if uses_tool_random:
            random.random = lambda: invoke("platform.random", [])  # type: ignore[assignment]
        else:
            if not isinstance(random_seed, int) or isinstance(random_seed, bool) or not (0 <= random_seed <= 0xFFFFFFFF):
                raise TypeError("randomSeed must be uint32")
            random.seed(random_seed)

        extra_host: dict[str, str] = {}
        for c in expected_calls:
            op = c["operation"]
            if op.startswith("demo."):
                extra_host[op[5:]] = op
        host_obj = _HostProxy(invoke, extra_host)

        guest_builtins = dict(vars(builtins))
        guest_builtins["print"] = _platform_print

        guest_globals: dict[str, Any] = {
            "__builtins__": guest_builtins,
            "__name__": "__guest__",
            "host": host_obj,
        }
        for binding in native_bindings:
            bname = binding.get("name")
            if isinstance(bname, str) and bname.isidentifier():
                guest_globals[bname] = (lambda _op: (lambda *a: invoke(_op, list(a))))(bname)

        phase = "compile"
        code = compile(source, "<guest>", "exec")

        _apply_resource_limits(timeout_ms)
        phase = "execute"
        sys.stdout = io.StringIO()
        kind = "return"
        result_value: Any = None
        try:
            exec(code, guest_globals)
            entry_fn = guest_globals.get(entry)
            if not callable(entry_fn):
                raise TypeError(f"Entry function {entry!r} is not defined or not callable")
            if tracer is not None:
                sys.settrace(tracer.trace_dispatch)
            try:
                result_value = entry_fn(*args)
            except Exception as exc:
                kind = "throw"
                result_value = encode_exception(exc)
            finally:
                if tracer is not None:
                    sys.settrace(None)
        finally:
            sys.stdout = real_stdout
            _cancel_alarm()

        if infrastructure_failures:
            cat, msg = infrastructure_failures[0]
            raise _BrokerError(msg, cat)

        if call_index != len(expected_calls):
            raise _BrokerError(
                f"Expected {len(expected_calls)} external calls, but guest performed {call_index}",
                "reference_process_failure",
            )

        phase = "observe"
        outcome_graph = describe_graph([*args, result_value])
        outcome_readable = encode_readable({"arguments": args, "value": result_value})
        trace_turns = tracer.finalize() if tracer is not None else None
        if trace_turns is not None:
            dispatch_count = sum(1 for e in effects if e["kind"] == "dispatch")
            if len(trace_turns) != dispatch_count + 1:
                raise _BrokerError(
                    f"Trace turn count {len(trace_turns)} != dispatches + 1 ({dispatch_count + 1})",
                    "reference_process_failure",
                )

        response: dict[str, Any] = {
            "schema": "python-reference/1",
            "outcome": {
                "kind": kind,
                "graph": outcome_graph,
                "readable": outcome_readable,
            },
            "effects": effects,
            "traceTurns": trace_turns,
        }
        real_stdout.write(_json_dump(response) + "\n")
        real_stdout.flush()
        return 0

    except (TraceLimitError, _TimeoutError) as exc:
        sys.stdout = real_stdout
        _cancel_alarm()
        real_stdout.write(
            _json_dump({
                "schema": "python-reference/1",
                "error": str(exc),
                "failure": {
                    "category": "reference_resource_limit",
                    "message": str(exc),
                    "phase": phase,
                },
            })
            + "\n"
        )
        real_stdout.flush()
        return 1
    except _BrokerError as exc:
        sys.stdout = real_stdout
        _cancel_alarm()
        real_stdout.write(
            _json_dump({
                "schema": "python-reference/1",
                "error": str(exc),
                "failure": {
                    "category": exc.category,
                    "message": str(exc),
                    "phase": phase,
                },
            })
            + "\n"
        )
        real_stdout.flush()
        return 1
    except Exception as exc:
        sys.stdout = real_stdout
        _cancel_alarm()
        category = (
            "reference_instrumentation_unsupported"
            if phase in ("compile", "observe")
            else "reference_process_failure"
        )
        real_stdout.write(
            _json_dump({
                "schema": "python-reference/1",
                "error": str(exc),
                "failure": {
                    "category": category,
                    "message": str(exc),
                    "phase": phase,
                },
            })
            + "\n"
        )
        real_stdout.flush()
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
