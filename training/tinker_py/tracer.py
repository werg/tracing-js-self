"""Compact causal sys.settrace tracer for native Python execution.

Hooks ONLY guest code (co_filename == "<guest>"), compares locals without ever
calling custom __eq__/__repr__/__str__, infers branch outcomes purely from
AST line ranges + control-flow transitions, and splits turns causally on every
intercepted external call via next_turn().
"""

from __future__ import annotations

import ast
import json
import math
import re
from dataclasses import dataclass
from typing import Any


class TraceLimitError(BaseException):
    """Raised when tracing exceeds its safety event budget (inherits BaseException
    so guest `except Exception:` blocks cannot catch it)."""


@dataclass(frozen=True)
class _BranchMeta:
    lineno: int
    kind: str  # "if" | "while" | "for"
    cond_text: str
    body_lines: frozenset[int]
    same_line_body: bool


def _compact_ws(text: str, max_len: int = 200) -> str:
    collapsed = re.sub(r"\s+", " ", text).strip()
    if len(collapsed) > max_len:
        return collapsed[: max_len - 3] + "..."
    return collapsed


def _collect_line_range(nodes: list[ast.stmt]) -> frozenset[int]:
    lines: set[int] = set()
    for stmt in nodes:
        start = getattr(stmt, "lineno", None)
        end = getattr(stmt, "end_lineno", start)
        if isinstance(start, int):
            stop = end if isinstance(end, int) and end >= start else start
            lines.update(range(start, stop + 1))
    return frozenset(lines)


def _extract_branch_map(source: str) -> dict[int, _BranchMeta]:
    """Pre-parse guest source with stdlib ast to map line numbers to branch metadata."""
    try:
        tree = ast.parse(source)
    except SyntaxError:
        return {}

    branches: dict[int, _BranchMeta] = {}

    def segment(node: ast.AST) -> str:
        raw = ast.get_source_segment(source, node)
        if raw:
            return _compact_ws(raw)
        try:
            return _compact_ws(ast.unparse(node))
        except Exception:
            return "<cond>"

    for node in ast.walk(tree):
        if isinstance(node, (ast.If, ast.While)):
            lineno = node.lineno
            body_lines = _collect_line_range(node.body)
            same_line_body = lineno in body_lines
            cond_text = segment(node.test)
            # Keep the outermost/first branch metadata if multiple share a line.
            if lineno not in branches:
                branches[lineno] = _BranchMeta(
                    lineno=lineno,
                    kind="if" if isinstance(node, ast.If) else "while",
                    cond_text=cond_text,
                    body_lines=body_lines,
                    same_line_body=same_line_body,
                )
        elif isinstance(node, ast.For):
            lineno = node.lineno
            body_lines = _collect_line_range(node.body)
            same_line_body = lineno in body_lines
            target_text = segment(node.target)
            iter_text = segment(node.iter)
            cond_text = _compact_ws(f"{target_text} in {iter_text}")
            if lineno not in branches:
                branches[lineno] = _BranchMeta(
                    lineno=lineno,
                    kind="for",
                    cond_text=cond_text,
                    body_lines=body_lines,
                    same_line_body=same_line_body,
                )
        elif isinstance(node, ast.IfExp):
            # Tracked in AST metadata; single-line ternaries have no line transition
            # to infer truth value without re-evaluating, so we only record if no
            # statement branch already occupies the line.
            pass

    return branches


def _local_fingerprint(value: Any) -> tuple:
    """Side-effect-free value fingerprint: NEVER calls __eq__, __repr__, or __str__."""
    if value is None:
        return ("none",)
    t = type(value)
    if t is bool:
        return ("bool", value)
    if t is int:
        return ("int", value)
    if t is float:
        if math.isnan(value):
            return ("float_nan",)
        if value == 0.0 and math.copysign(1.0, value) < 0.0:
            return ("float_neg0",)
        return ("float", value)
    if t is str:
        return ("str", value)
    if t is bytes:
        return ("bytes", value)
    return ("obj", id(value), t.__name__)


def _format_scalar(value: Any, max_string_length: int = 160) -> str | None:
    """Format built-in scalars safely; return None for non-scalar objects."""
    if value is None:
        return "None"
    t = type(value)
    if t is bool:
        return "True" if value else "False"
    if t is int:
        text = str(value)
        if len(text) > max_string_length:
            return text[: max_string_length - 3] + "..."
        return text
    if t is float:
        if math.isnan(value):
            return "NaN"
        if math.isinf(value):
            return "Infinity" if value > 0 else "-Infinity"
        if value == 0.0 and math.copysign(1.0, value) < 0.0:
            return "-0.0"
        return repr(value)
    if t is str:
        clipped = value[: max(0, max_string_length - 3)] + "..." if len(value) > max_string_length else value
        return json.dumps(clipped, ensure_ascii=False)
    if t is bytes:
        text = repr(value)
        if len(text) > max_string_length:
            return text[: max_string_length - 3] + "..."
        return text
    return None


def _safe_exception_message(exc: BaseException, max_len: int = 160) -> str:
    """Safely extract exception message without triggering custom __str__ side effects."""
    try:
        if type(exc).__str__ is BaseException.__str__:
            text = str(exc)
        elif hasattr(exc, "args") and isinstance(exc.args, tuple):
            parts = []
            for a in exc.args:
                s = _format_scalar(a, max_len)
                parts.append(s if s is not None else type(a).__name__)
            text = ", ".join(parts)
        else:
            text = ""
    except Exception:
        text = ""
    text = re.sub(r"\s+", " ", text).strip()
    if len(text) > max_len:
        return text[: max_len - 3] + "..."
    return text


def _compact_head_tail(lines: list[str], max_lines: int) -> list[str]:
    if len(lines) <= max_lines:
        return list(lines)
    if max_lines <= 1:
        return lines[:max_lines]
    if max_lines == 2:
        return [lines[0], lines[-1]]
    head_count = (max_lines - 1) // 2
    tail_count = max_lines - 1 - head_count
    omitted = len(lines) - head_count - tail_count
    plural = "" if omitted == 1 else "s"
    return [*lines[:head_count], f"... ({omitted} step{plural} omitted) ...", *lines[-tail_count:]]


class _TurnBucket:
    __slots__ = ("head", "tail", "tail_pos", "omitted", "last_line")

    def __init__(self) -> None:
        self.head: list[str] = []
        self.tail: list[str] | None = None
        self.tail_pos: int = 0
        self.omitted: int = 0
        self.last_line: str | None = None


class _FrameState:
    __slots__ = ("fn_name", "prev_locals", "pending_branch", "had_exception")

    def __init__(self, fn_name: str, prev_locals: dict[str, tuple]) -> None:
        self.fn_name = fn_name
        self.prev_locals = prev_locals
        self.pending_branch: _BranchMeta | None = None
        self.had_exception: bool = False


class CompactPythonTracer:
    """Streaming sys.settrace compact causal collector with per-turn buckets."""

    def __init__(
        self,
        source: str,
        *,
        entry_name: str = "run",
        filename: str = "<guest>",
        max_lines_per_turn: int = 300,
        max_total_lines: int = 1500,
        max_string_length: int = 160,
        max_events: int = 500_000,
    ) -> None:
        self.entry_name = entry_name
        self.filename = filename
        self.max_lines_per_turn = max(3, int(max_lines_per_turn))
        self.max_total_lines = max(3, int(max_total_lines))
        self.max_string_length = max(16, int(max_string_length))
        self.max_events = max(1000, int(max_events))

        self._head_cap = max(1, (self.max_lines_per_turn - 1) // 2)
        self._tail_cap = max(1, self.max_lines_per_turn - 1 - self._head_cap)
        self._branches = _extract_branch_map(source)
        self._buckets: list[_TurnBucket] = [_TurnBucket()]
        self._frames: dict[int, _FrameState] = {}
        self._event_count = 0
        self._last_raised_id: int | None = None

    def _emit(self, line: str) -> None:
        bucket = self._buckets[-1]
        if bucket.last_line == line:
            return
        bucket.last_line = line
        if bucket.tail is None:
            if len(bucket.head) < self.max_lines_per_turn:
                bucket.head.append(line)
                return
            prev = bucket.head
            bucket.head = prev[: self._head_cap]
            retained = prev[len(prev) - (self._tail_cap - 1) :] if self._tail_cap > 1 else []
            bucket.tail = [*retained, line]
            bucket.tail_pos = 0
            bucket.omitted = len(prev) - self._head_cap - len(retained)
            return
        bucket.tail[bucket.tail_pos] = line
        bucket.tail_pos = (bucket.tail_pos + 1) % self._tail_cap
        bucket.omitted += 1

    def next_turn(self) -> None:
        """Start a fresh trace bucket right at an intercepted external call."""
        self._buckets.append(_TurnBucket())

    def _snapshot_locals(self, frame: Any) -> dict[str, tuple]:
        snap: dict[str, tuple] = {}
        for name, val in frame.f_locals.items():
            if not name or name.startswith("__") or name.startswith("."):
                continue
            snap[name] = _local_fingerprint(val)
        return snap

    def _emit_local_diffs(self, frame: Any, state: _FrameState) -> None:
        prev = state.prev_locals
        current: dict[str, tuple] = {}
        for name, val in frame.f_locals.items():
            if not name or name.startswith("__") or name.startswith("."):
                continue
            fp = _local_fingerprint(val)
            current[name] = fp
            if prev.get(name) != fp:
                scalar = _format_scalar(val, self.max_string_length)
                if scalar is not None:
                    self._emit(f"{name} = {scalar}")
                else:
                    self._emit(f"{name} -> {type(val).__name__}")
        state.prev_locals = current

    def _resolve_pending_branch(self, state: _FrameState, next_lineno: int, event: str) -> None:
        branch = state.pending_branch
        if branch is None:
            return
        state.pending_branch = None
        if event == "return":
            if branch.same_line_body and next_lineno == branch.lineno:
                taken = True
            else:
                taken = next_lineno in branch.body_lines and next_lineno != branch.lineno
        else:
            taken = next_lineno in branch.body_lines and next_lineno != branch.lineno
        self._emit(f"branch {branch.cond_text} => {'True' if taken else 'False'}")

    def trace_dispatch(self, frame: Any, event: str, arg: Any) -> Any:
        if frame.f_code.co_filename != self.filename:
            return None

        self._event_count += 1
        if self._event_count > self.max_events:
            raise TraceLimitError(f"Python trace event limit ({self.max_events}) exceeded")

        fid = id(frame)

        if event == "call":
            fn_name = frame.f_code.co_name
            self._frames[fid] = _FrameState(fn_name, self._snapshot_locals(frame))
            return self.trace_dispatch

        state = self._frames.get(fid)
        if state is None:
            state = _FrameState(frame.f_code.co_name, self._snapshot_locals(frame))
            self._frames[fid] = state

        if event == "line":
            state.had_exception = False
            lineno = frame.f_lineno
            self._resolve_pending_branch(state, lineno, event)
            self._emit_local_diffs(frame, state)
            branch = self._branches.get(lineno)
            if branch is not None:
                state.pending_branch = branch
            return self.trace_dispatch

        if event == "return":
            lineno = frame.f_lineno
            if not state.had_exception:
                self._resolve_pending_branch(state, lineno, event)
                self._emit_local_diffs(frame, state)
                fn_name = state.fn_name
                scope = "" if fn_name in (self.entry_name, "<module>") else f" ({fn_name})"
                scalar = _format_scalar(arg, self.max_string_length)
                if scalar is not None:
                    self._emit(f"return{scope} {scalar}")
                else:
                    self._emit(f"return{scope} -> {type(arg).__name__}")
            self._frames.pop(fid, None)
            return None

        if event == "exception":
            state.pending_branch = None
            state.had_exception = True
            exc_type, exc_val, _ = arg
            if isinstance(exc_val, BaseException) and not isinstance(exc_val, TraceLimitError):
                exc_id = id(exc_val)
                if exc_id != self._last_raised_id:
                    self._last_raised_id = exc_id
                    fn_name = state.fn_name
                    scope = "" if fn_name in (self.entry_name, "<module>") else f" ({fn_name})"
                    msg = _safe_exception_message(exc_val, self.max_string_length)
                    self._emit(f"raise{scope} {exc_type.__name__}: {msg}" if msg else f"raise{scope} {exc_type.__name__}")
            return self.trace_dispatch

        return self.trace_dispatch

    def _materialize(self, bucket: _TurnBucket) -> list[str]:
        if bucket.tail is None:
            return list(bucket.head)
        if bucket.tail_pos == 0:
            ordered_tail = list(bucket.tail)
        else:
            ordered_tail = [*bucket.tail[bucket.tail_pos :], *bucket.tail[: bucket.tail_pos]]
        plural = "" if bucket.omitted == 1 else "s"
        marker = f"... ({bucket.omitted} step{plural} omitted) ..."
        return [*bucket.head, marker, *ordered_tail]

    def finalize(self) -> list[list[str]]:
        turns = [self._materialize(b) for b in self._buckets]
        total = sum(len(t) for t in turns)
        if total > self.max_total_lines:
            non_empty = sum(1 for t in turns if t) or 1
            per_turn_cap = max(3, self.max_total_lines // non_empty)
            turns = [_compact_head_tail(t, per_turn_cap) for t in turns]
            total = sum(len(t) for t in turns)
            if total > self.max_total_lines:
                remaining = self.max_total_lines
                trimmed: list[list[str]] = []
                for t in turns:
                    if remaining <= 0:
                        trimmed.append([])
                    else:
                        kept = _compact_head_tail(t, remaining)
                        remaining -= len(kept)
                        trimmed.append(kept)
                turns = trimmed
        return turns


def create_python_tracer(
    source: str,
    *,
    entry_name: str = "run",
    max_lines_per_turn: int = 300,
    max_total_lines: int = 1500,
    max_string_length: int = 160,
    max_events: int = 500_000,
) -> CompactPythonTracer:
    return CompactPythonTracer(
        source,
        entry_name=entry_name,
        max_lines_per_turn=max_lines_per_turn,
        max_total_lines=max_total_lines,
        max_string_length=max_string_length,
        max_events=max_events,
    )
