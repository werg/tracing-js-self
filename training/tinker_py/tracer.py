"""Compact causal sys.settrace tracer for native Python execution.

Hooks ONLY guest code (co_filename == "<guest>"), compares locals without ever
calling custom __eq__/__repr__/__str__, infers branch outcomes purely from
AST line ranges + control-flow transitions, and splits turns causally on every
intercepted external call via next_turn().
"""

from __future__ import annotations

import ast
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


def _is_exact_scalar(t: type) -> bool:
    return (
        t is type(None)
        or t is bool
        or t is int
        or t is float
        or t is str
        or t is bytes
    )


def _is_exact_container(t: type) -> bool:
    return (
        t is tuple
        or t is list
        or t is dict
        or t is set
        or t is frozenset
    )


def _format_value_inner(
    v: Any,
    depth: int,
    max_depth: int,
    max_items: int,
    max_chars: int,
    seen: set[int],
    standalone_str_max: int,
) -> str:
    t = type(v)
    if t is type(None):
        return "None"
    if t is bool:
        return "True" if v else "False"
    if t is int:
        if v.bit_length() > 1000:
            return f"<int bits={v.bit_length()}>"
        text = str(v)
        limit = standalone_str_max if depth == 0 else 80
        if len(text) > limit:
            return text[: max(0, limit - 3)] + "..."
        return text
    if t is float:
        if math.isnan(v):
            return "NaN"
        if math.isinf(v):
            return "Infinity" if v > 0 else "-Infinity"
        if v == 0.0 and math.copysign(1.0, v) < 0.0:
            return "-0.0"
        return repr(v)
    if t is str:
        str_limit = standalone_str_max if depth == 0 else 80
        if len(v) > str_limit:
            text = repr(v[: max(0, str_limit - 3)] + "...")
        else:
            text = repr(v)
        if len(text) > str_limit + 16:
            return text[: str_limit + 13] + "..."
        return text
    if t is bytes:
        n = len(v)
        if n == 0:
            return "b''"
        preview = v[:16].hex()
        suffix = "..." if n > 16 else ""
        return f"bytes({n}:{preview}{suffix})"

    if _is_exact_container(t):
        n = len(v)
        if n == 0:
            if t is tuple:
                return "()"
            if t is list:
                return "[]"
            if t is dict:
                return "{}"
            if t is set:
                return "set()"
            return "frozenset()"

        vid = id(v)
        if vid in seen:
            return "<...>"
        if depth >= max_depth:
            if t is tuple:
                return "(...)"
            if t is list:
                return "[...]"
            if t is dict:
                return "{...}"
            if t is set:
                return "{...}"
            return "frozenset(...)"

        seen.add(vid)
        try:
            if t is list or t is tuple:
                count = min(n, max_items)
                parts: list[str] = []
                approx_len = 2
                truncated = n > max_items
                for i in range(count):
                    item_str = _format_value_inner(
                        v[i], depth + 1, max_depth, max_items, max_chars, seen, standalone_str_max
                    )
                    parts.append(item_str)
                    approx_len += len(item_str) + 2
                    if approx_len > max_chars + 16 and i + 1 < n:
                        truncated = True
                        break
                if truncated:
                    parts.append("...")
                if t is tuple:
                    rendered = f"({parts[0]},)" if (n == 1 and not truncated) else "(" + ", ".join(parts) + ")"
                else:
                    rendered = "[" + ", ".join(parts) + "]"
            elif t is dict:
                parts = []
                approx_len = 2
                truncated = n > max_items
                for i, (k, val) in enumerate(dict.items(v)):
                    if i >= max_items:
                        break
                    ks = _format_value_inner(
                        k, depth + 1, max_depth, max_items, max_chars, seen, standalone_str_max
                    )
                    vs = _format_value_inner(
                        val, depth + 1, max_depth, max_items, max_chars, seen, standalone_str_max
                    )
                    piece = f"{ks}: {vs}"
                    parts.append(piece)
                    approx_len += len(piece) + 2
                    if approx_len > max_chars + 16 and i + 1 < n:
                        truncated = True
                        break
                if truncated:
                    parts.append("...")
                rendered = "{" + ", ".join(parts) + "}"
            else:
                # Exact set or frozenset: sort formatted items for small sets so output is
                # deterministic across subprocess PYTHONHASHSEED values without calling guest __lt__.
                if n <= 32:
                    all_parts = [
                        _format_value_inner(
                            item, depth + 1, max_depth, max_items, max_chars, seen, standalone_str_max
                        )
                        for item in v
                    ]
                    all_parts.sort()
                    parts = all_parts[:max_items]
                    if n > max_items:
                        parts.append("...")
                    body = ", ".join(parts)
                    rendered = "{" + body + "}" if t is set else "frozenset({" + body + "})"
                else:
                    rendered = f"set(len={n})" if t is set else f"frozenset(len={n})"
        finally:
            seen.discard(vid)

        if len(rendered) > max_chars:
            return rendered[: max(0, max_chars - 3)] + "..."
        return rendered

    return f"<{t.__name__}>"


def _format_value(
    v: Any,
    depth: int = 0,
    max_depth: int = 3,
    max_items: int = 8,
    max_chars: int = 120,
    *,
    standalone_str_max: int = 160,
) -> str:
    """Strictly side-effect-free formatter for exact built-in primitives and containers.

    Checks exact types via `type(v) is ...` (never `isinstance()`), guards against
    cycles via active-ancestor `seen` IDs, and renders all non-builtin objects or
    subclasses as `<TypeName>` without invoking `__repr__`, `__str__`, `__eq__`,
    `__iter__`, `__getitem__`, or `__len__`.
    """
    try:
        return _format_value_inner(
            v,
            depth,
            max_depth,
            max_items,
            max_chars,
            set(),
            standalone_str_max,
        )
    except Exception:
        return f"<{type(v).__name__}>"


def _local_fingerprint(
    value: Any,
    *,
    max_string_length: int = 160,
    max_container_chars: int = 120,
) -> tuple:
    """Side-effect-free value snapshot: NEVER calls __eq__, __repr__, __str__, or subclass dunders."""
    t = type(value)
    if t is type(None):
        return ("builtin", id(t), None, None)
    if t is bool:
        return ("builtin", id(t), value, None)
    if t is int:
        return ("builtin", id(t), value, None)
    if t is float:
        if math.isnan(value):
            return ("builtin", id(t), "nan", None)
        if value == 0.0 and math.copysign(1.0, value) < 0.0:
            return ("builtin", id(t), "-0.0", None)
        return ("builtin", id(t), value, None)
    if t is str:
        n = len(value)
        preview = value if n <= max_string_length else value[:max_string_length]
        return ("builtin", id(t), preview, n)
    if t is bytes:
        return ("builtin", id(t), value[:16], len(value))
    if _is_exact_container(t):
        preview = _format_value(
            value,
            depth=0,
            max_chars=max_container_chars,
            standalone_str_max=max_string_length,
        )
        return ("builtin", id(t), preview, len(value))
    return ("obj", id(t), id(value))


def _safe_exception_message(exc: BaseException, max_len: int = 160) -> str:
    """Safely extract exception message without triggering custom __str__ side effects."""
    try:
        if type(exc).__str__ is BaseException.__str__:
            text = str(exc)
        elif hasattr(exc, "args") and type(exc.args) is tuple:
            parts = [
                _format_value(a, max_chars=max_len, standalone_str_max=max_len)
                for a in exc.args
            ]
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
            snap[name] = _local_fingerprint(val, max_string_length=self.max_string_length)
        return snap

    def _emit_local_diffs(self, frame: Any, state: _FrameState) -> None:
        prev = state.prev_locals
        current: dict[str, tuple] = {}
        for name, val in frame.f_locals.items():
            if not name or name.startswith("__") or name.startswith("."):
                continue
            fp = _local_fingerprint(val, max_string_length=self.max_string_length)
            current[name] = fp
            if prev.get(name) != fp:
                t = type(val)
                if _is_exact_container(t):
                    self._emit(f"{name} = {fp[2]}")
                elif _is_exact_scalar(t):
                    rendered = _format_value(val, standalone_str_max=self.max_string_length)
                    self._emit(f"{name} = {rendered}")
                else:
                    self._emit(f"{name} -> {t.__name__}")
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
                t_arg = type(arg)
                if _is_exact_scalar(t_arg) or _is_exact_container(t_arg):
                    rendered = _format_value(arg, standalone_str_max=self.max_string_length)
                    self._emit(f"return{scope} {rendered}")
                else:
                    self._emit(f"return{scope} -> {t_arg.__name__}")
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
