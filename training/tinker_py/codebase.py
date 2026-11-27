"""Virtual multi-file Python codebase index, AST slicer, in-memory importer, and causal code.load tracer.

Supports on-demand multi-file codebase loading (`code.load`) where only the
entry file (and optional `initialLoadedFiles`) + a compact repository manifest
are shown initially, and additional files/symbols/line ranges are loaded on demand.
"""

from __future__ import annotations

import ast
from dataclasses import dataclass
import hashlib
import importlib.abc
import importlib.machinery
import json
import re
import sys
import types
from typing import Any, Callable

from .tracer import (
    CompactPythonTracer,
    TraceLimitError,
    _BranchMeta,
    _FrameState,
    _extract_branch_map,
    _format_value,
    _is_exact_container,
    _is_exact_scalar,
    _safe_exception_message,
)

CODE_LOAD_OPERATION = "code.load"
WHOLE_FILE_THRESHOLD_BYTES = 3072
MAX_CODE_LOAD_RESPONSE_BYTES = 48_000
MAX_CODEBASE_FILES = 256
MAX_CODEBASE_TOTAL_BYTES = 2_000_000
GUEST_FILENAME_PREFIX = "<guest:"

CODE_LOAD_TOOL_DESCRIPTION = (
    "Load Python source code from repository files on demand. "
    'Pass {"arguments": [req1, ...]} where each request is '
    '{"path": "pkg/utils.py"} (whole file; prefer for small files <= 3 KB to save round-trips), '
    '{"path": "pkg/parser.py", "symbol": "parse_expr"} (AST symbol snippet with imports & constants; prefer for large files), '
    'or {"path": "pkg/parser.py", "start_line": 40, "end_line": 95} (bounded 1-based line range). '
    "Multiple requests may be batched in one call."
)

_CONST_NAME_RE = re.compile(r"^_?[A-Z][A-Z0-9_]*$")


def _demand(condition: bool, message: str) -> None:
    if not condition:
        raise TypeError(message)


def _json_compact(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def normalize_rel_path(path: str) -> str:
    """Normalize a repository-relative POSIX path and reject traversal or invalid paths."""
    _demand(isinstance(path, str), "Repository path must be a string")
    raw = path.strip().replace("\\", "/")
    _demand(len(raw) > 0 and "\x00" not in raw, "Invalid repository path")
    while raw.startswith("./"):
        raw = raw[2:]
    raw = raw.lstrip("/")
    raw = re.sub(r"/+", "/", raw)
    parts = raw.split("/")
    _demand(
        len(parts) > 0 and all(p not in ("", ".", "..") for p in parts),
        f"Invalid repository path: {path!r}",
    )
    return "/".join(parts)


def guest_filename_for(rel_path: str) -> str:
    return f"{GUEST_FILENAME_PREFIX}{rel_path}>"


def rel_path_from_guest_filename(filename: str) -> str | None:
    if isinstance(filename, str) and filename.startswith(GUEST_FILENAME_PREFIX) and filename.endswith(">"):
        return filename[len(GUEST_FILENAME_PREFIX) : -1]
    return None


def is_multifile_task(obj: dict[str, Any]) -> bool:
    files = obj.get("files")
    return isinstance(files, dict) and len(files) > 0


def normalize_codebase_files(
    files: dict[str, str],
    entry_file: str,
    initial_loaded_files: list[str] | None = None,
) -> tuple[dict[str, str], str, list[str]]:
    """Validate and deterministically normalize multi-file task files, entryFile, and initialLoadedFiles."""
    _demand(
        isinstance(files, dict) and 0 < len(files) <= MAX_CODEBASE_FILES,
        f"files must be a dict with 1..{MAX_CODEBASE_FILES} entries",
    )
    norm_entries: list[tuple[str, str]] = []
    seen_paths: set[str] = set()
    total_bytes = 0
    for raw_path, content in files.items():
        norm_path = normalize_rel_path(raw_path)
        _demand(norm_path not in seen_paths, f"Duplicate normalized path: {norm_path!r}")
        _demand(isinstance(content, str), f"File content for {norm_path!r} must be a string")
        seen_paths.add(norm_path)
        total_bytes += len(content.encode("utf-8"))
        _demand(total_bytes <= MAX_CODEBASE_TOTAL_BYTES, "Total codebase size exceeds limit")
        norm_entries.append((norm_path, content))

    norm_entries.sort(key=lambda pair: pair[0])
    norm_files = dict(norm_entries)

    norm_entry = normalize_rel_path(entry_file)
    _demand(norm_entry in norm_files, f"entryFile {norm_entry!r} not found in files")

    if initial_loaded_files is None:
        norm_initial = [norm_entry]
    else:
        _demand(isinstance(initial_loaded_files, list), "initialLoadedFiles must be a list")
        norm_initial = []
        seen_init: set[str] = set()
        for raw_p in initial_loaded_files:
            np = normalize_rel_path(raw_p)
            _demand(np in norm_files, f"initialLoadedFiles entry {np!r} not found in files")
            if np not in seen_init:
                seen_init.add(np)
                norm_initial.append(np)
        if norm_entry not in seen_init:
            norm_initial.insert(0, norm_entry)

    return norm_files, norm_entry, norm_initial


def normalized_multifile_source_hash(files: dict[str, str], entry_file: str) -> str:
    """AST-normalized SHA-256 hash across all repository files + entryFile."""
    parts: list[list[str]] = []
    for rel_path in sorted(files.keys()):
        src = files[rel_path]
        try:
            digest_input = ast.dump(ast.parse(src), include_attributes=False)
        except SyntaxError:
            digest_input = src
        parts.append([rel_path, hashlib.sha256(digest_input.encode("utf-8")).hexdigest()])
    payload = _json_compact({"entryFile": entry_file, "files": parts})
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


@dataclass(frozen=True)
class SymbolEntry:
    name: str
    kind: str  # "function" | "async_function" | "class" | "constant" | "assign"
    start_line: int
    end_line: int
    methods: tuple[tuple[str, int, int], ...] = ()


@dataclass(frozen=True)
class FileIndex:
    path: str
    bytes: int
    lines: int
    symbols: tuple[SymbolEntry, ...]
    import_ranges: tuple[tuple[int, int], ...]
    constant_ranges: tuple[tuple[int, int, str], ...]


def _decorator_start_line(node: ast.FunctionDef | ast.AsyncFunctionDef | ast.ClassDef) -> int:
    starts = [node.lineno]
    for dec in node.decorator_list:
        d_line = getattr(dec, "lineno", None)
        if isinstance(d_line, int):
            starts.append(d_line)
    return min(starts)


def _is_simple_constant_expr(node: ast.AST | None, depth: int = 0) -> bool:
    if node is None or depth > 4:
        return False
    if isinstance(node, ast.Constant):
        return True
    if isinstance(node, ast.Name):
        return True
    if isinstance(node, ast.UnaryOp):
        return _is_simple_constant_expr(node.operand, depth + 1)
    if isinstance(node, ast.BinOp):
        return _is_simple_constant_expr(node.left, depth + 1) and _is_simple_constant_expr(node.right, depth + 1)
    if isinstance(node, (ast.Tuple, ast.List, ast.Set)):
        return len(node.elts) <= 16 and all(_is_simple_constant_expr(e, depth + 1) for e in node.elts)
    if isinstance(node, ast.Dict):
        return (
            len(node.keys) <= 16
            and all(k is not None and _is_simple_constant_expr(k, depth + 1) for k in node.keys)
            and all(_is_simple_constant_expr(v, depth + 1) for v in node.values)
        )
    if isinstance(node, ast.Call) and isinstance(node.func, (ast.Name, ast.Attribute)):
        # Allow simple constructors like re.compile(...), frozenset(...), tuple(...), namedtuple(...)
        return len(node.args) <= 4 and len(node.keywords) <= 4 and all(
            _is_simple_constant_expr(a, depth + 1) for a in node.args
        )
    return False


def index_file_symbols(source: str, path: str = "") -> FileIndex:
    """AST-index top-level functions, classes, constants, and imports for a Python file."""
    src_bytes = len(source.encode("utf-8"))
    src_lines = source.splitlines()
    line_count = len(src_lines)
    try:
        tree = ast.parse(source)
    except SyntaxError:
        return FileIndex(
            path=path,
            bytes=src_bytes,
            lines=line_count,
            symbols=(),
            import_ranges=(),
            constant_ranges=(),
        )

    symbols: list[SymbolEntry] = []
    import_ranges: list[tuple[int, int]] = []
    constant_ranges: list[tuple[int, int, str]] = []
    seen_sym_names: set[str] = set()

    for node in tree.body:
        if isinstance(node, (ast.Import, ast.ImportFrom)):
            end = node.end_lineno or node.lineno
            import_ranges.append((node.lineno, end))
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            start = _decorator_start_line(node)
            end = node.end_lineno or node.lineno
            kind = "async_function" if isinstance(node, ast.AsyncFunctionDef) else "function"
            if node.name not in seen_sym_names:
                seen_sym_names.add(node.name)
                symbols.append(SymbolEntry(name=node.name, kind=kind, start_line=start, end_line=end))
        elif isinstance(node, ast.ClassDef):
            start = _decorator_start_line(node)
            end = node.end_lineno or node.lineno
            methods: list[tuple[str, int, int]] = []
            for item in node.body:
                if isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    m_start = _decorator_start_line(item)
                    m_end = item.end_lineno or item.lineno
                    methods.append((item.name, m_start, m_end))
            if node.name not in seen_sym_names:
                seen_sym_names.add(node.name)
                symbols.append(
                    SymbolEntry(
                        name=node.name,
                        kind="class",
                        start_line=start,
                        end_line=end,
                        methods=tuple(methods),
                    )
                )
        elif isinstance(node, ast.Assign):
            start = node.lineno
            end = node.end_lineno or node.lineno
            span_lines = end - start + 1
            simple_val = _is_simple_constant_expr(node.value)
            for tgt in node.targets:
                if isinstance(tgt, ast.Name):
                    name = tgt.id
                    is_const = bool(_CONST_NAME_RE.match(name)) or (simple_val and not name.startswith("__"))
                    kind = "constant" if is_const else "assign"
                    if name not in seen_sym_names:
                        seen_sym_names.add(name)
                        symbols.append(SymbolEntry(name=name, kind=kind, start_line=start, end_line=end))
                    if is_const and span_lines <= 6 and name != "__all__":
                        constant_ranges.append((start, end, name))
        elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
            start = node.lineno
            end = node.end_lineno or node.lineno
            span_lines = end - start + 1
            name = node.target.id
            simple_val = _is_simple_constant_expr(node.value)
            is_const = bool(_CONST_NAME_RE.match(name)) or (simple_val and not name.startswith("__"))
            kind = "constant" if is_const else "assign"
            if name not in seen_sym_names:
                seen_sym_names.add(name)
                symbols.append(SymbolEntry(name=name, kind=kind, start_line=start, end_line=end))
            if is_const and span_lines <= 6 and node.value is not None and name != "__all__":
                constant_ranges.append((start, end, name))

    return FileIndex(
        path=path,
        bytes=src_bytes,
        lines=line_count,
        symbols=tuple(symbols),
        import_ranges=tuple(import_ranges),
        constant_ranges=tuple(constant_ranges),
    )


def resolve_enclosing_top_level_symbol(index: FileIndex, lineno: int) -> str | None:
    """Resolve the enclosing top-level function or class name for a 1-based line number."""
    for sym in index.symbols:
        if sym.kind in ("function", "async_function", "class") and sym.start_line <= lineno <= sym.end_line:
            return sym.name
    return None


def render_repo_manifest(
    files: dict[str, str],
    entry_file: str,
    initial_loaded_files: list[str] | None = None,
    *,
    max_symbols_per_file: int = 12,
) -> str:
    """Render a deterministic compact repository manifest for the initial user prompt."""
    norm_entry = normalize_rel_path(entry_file)
    loaded_set = set(initial_loaded_files) if initial_loaded_files is not None else {norm_entry}
    ordered_paths = [norm_entry] + sorted(p for p in files.keys() if p != norm_entry)

    lines = [
        "Repository files (call `code.load` on demand; load small files whole to save round-trips, "
        "or specific symbols from large files to save tokens):"
    ]
    for path in ordered_paths:
        src = files[path]
        idx = index_file_symbols(src, path)
        size_kb = idx.bytes / 1024.0
        loaded_tag = " [loaded]" if path in loaded_set else ""
        # Prioritize functions/classes/constants; hide dunder-only assigns like __all__.
        display_syms = [
            s.name
            for s in idx.symbols
            if s.kind in ("function", "async_function", "class", "constant") and not s.name.startswith("__")
        ]
        if not display_syms:
            display_syms = [s.name for s in idx.symbols if not s.name.startswith("__")]
        if len(display_syms) > max_symbols_per_file:
            shown = [*display_syms[:max_symbols_per_file], "..."]
        else:
            shown = display_syms
        if shown:
            lines.append(f"- {path} ({size_kb:.1f} KB, {idx.lines} lines){loaded_tag}: {', '.join(shown)}")
        else:
            lines.append(f"- {path} ({size_kb:.1f} KB, {idx.lines} lines){loaded_tag}")
    return "\n".join(lines)


def _merge_line_ranges(ranges: list[tuple[int, int]]) -> list[tuple[int, int]]:
    if not ranges:
        return []
    ordered = sorted(ranges)
    merged: list[tuple[int, int]] = [ordered[0]]
    for start, end in ordered[1:]:
        prev_s, prev_e = merged[-1]
        if start <= prev_e + 1:
            merged[-1] = (prev_s, max(prev_e, end))
        else:
            merged.append((start, end))
    return merged


def _build_symbol_snippet(
    src_lines: list[str],
    index: FileIndex,
    target_start: int,
    target_end: int,
    *,
    max_const_lines: int = 15,
    max_const_bytes: int = 1200,
) -> str:
    """Assemble module imports + bounded simple top-level constants + target symbol snippet."""
    selected: list[tuple[int, int]] = []
    for s, e in index.import_ranges:
        if e < target_start or s > target_end:
            selected.append((s, e))

    const_lines_used = 0
    const_bytes_used = 0
    for s, e, _name in index.constant_ranges:
        if not (e < target_start or s > target_end):
            continue
        span = e - s + 1
        chunk = "\n".join(src_lines[s - 1 : e])
        chunk_bytes = len(chunk.encode("utf-8"))
        if const_lines_used + span > max_const_lines or const_bytes_used + chunk_bytes > max_const_bytes:
            continue
        const_lines_used += span
        const_bytes_used += chunk_bytes
        selected.append((s, e))

    selected.append((target_start, target_end))
    merged = _merge_line_ranges(selected)

    blocks: list[str] = []
    prev_end: int | None = None
    for s, e in merged:
        if prev_end is not None and s > prev_end + 1:
            blocks.append(f"# ... (lines {prev_end + 1}-{s - 1} omitted)")
        blocks.append("\n".join(src_lines[s - 1 : e]))
        prev_end = e
    return "\n".join(blocks)


def _normalize_code_load_requests(requests: Any) -> list[Any]:
    if isinstance(requests, dict):
        return [requests]
    if isinstance(requests, (list, tuple)):
        items = list(requests)
        # Gracefully unwrap a single nested list of request dicts, e.g. {"arguments": [[req1, req2]]}.
        if len(items) == 1 and isinstance(items[0], (list, tuple)):
            return list(items[0])
        return items
    return [requests]


def serve_code_load(
    files: dict[str, str],
    requests: Any,
    *,
    max_response_bytes: int = MAX_CODE_LOAD_RESPONSE_BYTES,
) -> list[dict[str, Any]]:
    """Serve flexible, batchable `code.load` requests against an in-memory `files` dict.

    Supports:
    - Whole file: {"path": "pkg/utils.py"}
    - Symbol snippet: {"path": "pkg/parser.py", "symbol": "parse_expr"} (or "ClassName.method")
    - Line range: {"path": "pkg/parser.py", "start_line": 40, "end_line": 95}

    Missing files/symbols return clean structured error dicts without raising.
    Deduplicates identical requests in a batch and caps cumulative response size.
    """
    req_list = _normalize_code_load_requests(requests)
    if not req_list:
        return [{"error": "empty code.load request list"}]

    index_cache: dict[str, FileIndex] = {}

    def _get_index(path: str) -> FileIndex:
        idx = index_cache.get(path)
        if idx is None:
            idx = index_file_symbols(files[path], path)
            index_cache[path] = idx
        return idx

    results: list[dict[str, Any]] = []
    seen_keys: set[str] = set()
    used_bytes = 0

    for raw_req in req_list:
        if not isinstance(raw_req, dict):
            results.append({"error": "invalid request: expected object with 'path'"})
            continue

        raw_path = raw_req.get("path")
        if not isinstance(raw_path, str) or not raw_path.strip():
            results.append({"error": "missing or invalid 'path'", "available_files": sorted(files.keys())[:32]})
            continue

        try:
            norm_path = normalize_rel_path(raw_path)
        except TypeError:
            results.append({"path": raw_path, "error": "file not found", "available_files": sorted(files.keys())[:32]})
            continue

        if norm_path not in files:
            results.append({"path": norm_path, "error": "file not found", "available_files": sorted(files.keys())[:32]})
            continue

        has_symbol = "symbol" in raw_req and raw_req["symbol"] is not None
        has_range = ("start_line" in raw_req and raw_req["start_line"] is not None) or (
            "end_line" in raw_req and raw_req["end_line"] is not None
        )

        # Deduplicate normalized requests within the same batch.
        if has_symbol:
            dedup_key = _json_compact(["symbol", norm_path, str(raw_req["symbol"]).strip()])
        elif has_range:
            dedup_key = _json_compact(["range", norm_path, raw_req.get("start_line"), raw_req.get("end_line")])
        else:
            dedup_key = _json_compact(["file", norm_path])
        if dedup_key in seen_keys:
            continue
        seen_keys.add(dedup_key)

        src = files[norm_path]
        src_lines = src.splitlines()
        total_lines = len(src_lines)

        item: dict[str, Any]
        if has_symbol:
            sym_name = str(raw_req["symbol"]).strip()
            idx = _get_index(norm_path)
            target_start: int | None = None
            target_end: int | None = None

            if "." in sym_name:
                cls_name, meth_name = sym_name.split(".", 1)
                for s in idx.symbols:
                    if s.kind == "class" and s.name == cls_name:
                        for m_name, m_start, m_end in s.methods:
                            if m_name == meth_name:
                                target_start, target_end = m_start, m_end
                                break
                        break
            else:
                for s in idx.symbols:
                    if s.name == sym_name:
                        target_start, target_end = s.start_line, s.end_line
                        break

            if target_start is None or target_end is None:
                results.append({
                    "path": norm_path,
                    "symbol": sym_name,
                    "error": "symbol not found",
                    "available_symbols": [s.name for s in idx.symbols],
                })
                continue

            snippet = _build_symbol_snippet(src_lines, idx, target_start, target_end)
            item = {
                "path": norm_path,
                "mode": "symbol",
                "symbol": sym_name,
                "start_line": target_start,
                "end_line": target_end,
                "lines": target_end - target_start + 1,
                "bytes": len(snippet.encode("utf-8")),
                "content": snippet,
            }
        elif has_range:
            raw_start = raw_req.get("start_line", 1)
            raw_end = raw_req.get("end_line")
            if isinstance(raw_start, bool) or not isinstance(raw_start, int):
                results.append({"path": norm_path, "error": "invalid start_line"})
                continue
            if raw_end is not None and (isinstance(raw_end, bool) or not isinstance(raw_end, int)):
                results.append({"path": norm_path, "error": "invalid end_line"})
                continue
            if total_lines == 0:
                start_line = 1
                end_line = 0
                sliced = ""
            else:
                start_line = max(1, min(raw_start, total_lines))
                default_end = min(total_lines, start_line + 199)
                end_line = default_end if raw_end is None else max(start_line, min(raw_end, total_lines))
                sliced = "\n".join(src_lines[start_line - 1 : end_line])
            item = {
                "path": norm_path,
                "mode": "range",
                "start_line": start_line,
                "end_line": end_line,
                "total_lines": total_lines,
                "lines": max(0, end_line - start_line + 1),
                "bytes": len(sliced.encode("utf-8")),
                "content": sliced,
            }
        else:
            item = {
                "path": norm_path,
                "mode": "file",
                "lines": total_lines,
                "bytes": len(src.encode("utf-8")),
                "content": src,
            }

        # Enforce cumulative response size cap cleanly without crashing.
        content_text = item.get("content", "")
        content_bytes = content_text.encode("utf-8")
        remaining = max_response_bytes - used_bytes
        if remaining <= 0:
            results.append({
                "path": norm_path,
                "mode": item["mode"],
                "error": "response size cap reached; request remaining files in a separate code.load call",
            })
            continue
        if len(content_bytes) > remaining:
            truncated_text = content_bytes[: max(0, remaining - 48)].decode("utf-8", errors="ignore")
            truncated_text += "\n# ... (truncated due to response size cap)"
            item["content"] = truncated_text
            item["bytes"] = len(truncated_text.encode("utf-8"))
            item["truncated"] = True
        used_bytes += item["bytes"]
        results.append(item)

    return results


# ---------------------------------------------------------------------------
# In-memory multi-file Python importer (sys.meta_path)
# ---------------------------------------------------------------------------


def module_name_and_package_for(rel_path: str) -> tuple[str, str]:
    """Compute (module_name, package_name) for a normalized repository-relative .py path."""
    if rel_path == "__init__.py":
        return "__guest__", ""
    if rel_path.endswith("/__init__.py"):
        mod = rel_path[: -len("/__init__.py")].replace("/", ".")
        return mod, mod
    if rel_path.endswith(".py"):
        mod = rel_path[:-3].replace("/", ".")
    else:
        mod = rel_path.replace("/", ".")
    pkg = mod.rsplit(".", 1)[0] if "." in mod else ""
    return mod, pkg


class _NamespacePackageLoader(importlib.abc.Loader):
    def create_module(self, spec: importlib.machinery.ModuleSpec) -> types.ModuleType | None:
        return None

    def exec_module(self, module: types.ModuleType) -> None:
        return None


class VirtualCodebaseLoader(importlib.abc.Loader):
    """Compiles and executes a virtual repo module with `<guest:rel_path>` filename."""

    def __init__(
        self,
        rel_path: str,
        source: str,
        guest_builtins: dict[str, Any],
        extra_globals: dict[str, Any],
    ) -> None:
        self._rel_path = rel_path
        self._source = source
        self._guest_builtins = guest_builtins
        self._extra_globals = extra_globals

    def create_module(self, spec: importlib.machinery.ModuleSpec) -> types.ModuleType | None:
        return None

    def exec_module(self, module: types.ModuleType) -> None:
        module.__dict__["__builtins__"] = self._guest_builtins
        module.__dict__["__file__"] = guest_filename_for(self._rel_path)
        for k, v in self._extra_globals.items():
            module.__dict__.setdefault(k, v)
        code = compile(self._source, guest_filename_for(self._rel_path), "exec")
        exec(code, module.__dict__)


class VirtualCodebaseFinder(importlib.abc.MetaPathFinder):
    """In-memory MetaPathFinder backed exclusively by a task's `files` mapping."""

    def __init__(
        self,
        files: dict[str, str],
        guest_builtins: dict[str, Any],
        extra_globals: dict[str, Any],
    ) -> None:
        self._files = files
        self._guest_builtins = guest_builtins
        self._extra_globals = extra_globals
        self._modules: dict[str, tuple[str, bool]] = {}
        self._namespace_pkgs: set[str] = set()

        for rel_path in sorted(files.keys()):
            if not rel_path.endswith(".py") or rel_path == "__init__.py":
                continue
            if rel_path.endswith("/__init__.py"):
                mod_name = rel_path[: -len("/__init__.py")].replace("/", ".")
                is_pkg = True
            else:
                mod_name = rel_path[:-3].replace("/", ".")
                is_pkg = False
            self._modules[mod_name] = (rel_path, is_pkg)
            # Register implicit parent namespace packages if missing an explicit __init__.py.
            parts = mod_name.split(".")
            for i in range(1, len(parts)):
                parent = ".".join(parts[:i])
                self._namespace_pkgs.add(parent)

        self._namespace_pkgs -= set(self._modules.keys())

    def find_spec(
        self,
        fullname: str,
        path: Any = None,
        target: Any = None,
    ) -> importlib.machinery.ModuleSpec | None:
        if fullname in self._modules:
            rel_path, is_pkg = self._modules[fullname]
            loader = VirtualCodebaseLoader(
                rel_path,
                self._files[rel_path],
                self._guest_builtins,
                self._extra_globals,
            )
            spec = importlib.machinery.ModuleSpec(
                fullname,
                loader,
                origin=guest_filename_for(rel_path),
                is_package=is_pkg,
            )
            if is_pkg:
                spec.submodule_search_locations = [f"<virtual:{fullname}>"]
            return spec

        if fullname in self._namespace_pkgs:
            spec = importlib.machinery.ModuleSpec(
                fullname,
                _NamespacePackageLoader(),
                origin=f"<virtual-ns:{fullname}>",
                is_package=True,
            )
            spec.submodule_search_locations = [f"<virtual:{fullname}>"]
            return spec

        return None

    def managed_module_names(self) -> set[str]:
        return set(self._modules.keys()) | set(self._namespace_pkgs)


def load_virtual_entry_module(
    files: dict[str, str],
    entry_file: str,
    guest_builtins: dict[str, Any],
    extra_globals: dict[str, Any],
) -> tuple[types.ModuleType, VirtualCodebaseFinder]:
    """Install in-memory finder, load parent packages, and execute `entry_file`."""
    finder = VirtualCodebaseFinder(files, guest_builtins, extra_globals)
    sys.meta_path.insert(0, finder)

    # Ensure parent packages of entry_file are initialized in sys.modules so relative imports work.
    entry_mod_name, entry_pkg = module_name_and_package_for(entry_file)
    if entry_pkg:
        pkg_parts = entry_pkg.split(".")
        for i in range(1, len(pkg_parts) + 1):
            sub_pkg = ".".join(pkg_parts[:i])
            if sub_pkg == entry_mod_name:
                break
            if sub_pkg not in sys.modules:
                importlib.import_module(sub_pkg)

    entry_mod = types.ModuleType(entry_mod_name)
    entry_mod.__dict__["__builtins__"] = guest_builtins
    entry_mod.__dict__["__name__"] = entry_mod_name
    entry_mod.__dict__["__package__"] = entry_pkg
    entry_mod.__dict__["__file__"] = guest_filename_for(entry_file)
    if entry_file.endswith("/__init__.py"):
        entry_mod.__dict__["__path__"] = [f"<virtual:{entry_mod_name}>"]
    for k, v in extra_globals.items():
        entry_mod.__dict__.setdefault(k, v)

    sys.modules[entry_mod_name] = entry_mod
    if entry_pkg and entry_pkg != entry_mod_name and entry_pkg in sys.modules:
        setattr(sys.modules[entry_pkg], entry_mod_name.rsplit(".", 1)[-1], entry_mod)

    code = compile(files[entry_file], guest_filename_for(entry_file), "exec")
    exec(code, entry_mod.__dict__)
    return entry_mod, finder


# ---------------------------------------------------------------------------
# Multi-file causal tracer & code.load teacher synthesizer
# ---------------------------------------------------------------------------


class MultiFilePythonTracer(CompactPythonTracer):
    """Multi-file sys.settrace tracer that emits causal `code.load` events on first cross-file call.

    When `record_trace=False`, only tracks `call` events to synthesize causal `code.load`
    events without per-line trace overhead (used for `actions-only` mode).
    """

    def __init__(
        self,
        files: dict[str, str],
        entry_file: str,
        *,
        initial_loaded_files: list[str] | None = None,
        on_code_load: Callable[[dict[str, Any]], None],
        entry_name: str = "run",
        record_trace: bool = True,
        whole_file_threshold_bytes: int = WHOLE_FILE_THRESHOLD_BYTES,
        max_lines_per_turn: int = 300,
        max_total_lines: int = 1500,
        max_string_length: int = 160,
        max_events: int = 500_000,
    ) -> None:
        super().__init__(
            files[entry_file],
            entry_name=entry_name,
            filename=guest_filename_for(entry_file),
            max_lines_per_turn=max_lines_per_turn,
            max_total_lines=max_total_lines,
            max_string_length=max_string_length,
            max_events=max_events,
        )
        self._files = files
        self._entry_file = entry_file
        self._record_trace = record_trace
        self._whole_file_threshold = whole_file_threshold_bytes
        self._on_code_load = on_code_load
        self._in_code_load = False

        self._file_bytes: dict[str, int] = {p: len(src.encode("utf-8")) for p, src in files.items()}
        self._file_indices: dict[str, FileIndex] = {p: index_file_symbols(src, p) for p, src in files.items()}
        self._guest_to_rel: dict[str, str] = {guest_filename_for(p): p for p in files}
        self._branches_by_file: dict[str, dict[int, _BranchMeta]] = (
            {guest_filename_for(p): _extract_branch_map(src) for p, src in files.items()} if record_trace else {}
        )
        self._loaded_files: set[str] = set(initial_loaded_files or [entry_file])
        self._loaded_symbols: set[tuple[str, str]] = set()

    def _maybe_emit_code_load(self, rel_path: str, firstlineno: int) -> None:
        if rel_path in self._loaded_files or self._in_code_load:
            return
        idx = self._file_indices[rel_path]
        top_sym = resolve_enclosing_top_level_symbol(idx, firstlineno)

        if top_sym is None or self._file_bytes[rel_path] <= self._whole_file_threshold:
            self._loaded_files.add(rel_path)
            req: dict[str, Any] = {"path": rel_path}
        else:
            key = (rel_path, top_sym)
            if key in self._loaded_symbols:
                return
            self._loaded_symbols.add(key)
            req = {"path": rel_path, "symbol": top_sym}

        self._in_code_load = True
        try:
            self._on_code_load(req)
        finally:
            self._in_code_load = False

    def trace_dispatch(self, frame: Any, event: str, arg: Any) -> Any:
        co_filename = frame.f_code.co_filename
        rel_path = self._guest_to_rel.get(co_filename)
        if rel_path is None:
            return None

        self._event_count += 1
        if self._event_count > self.max_events:
            raise TraceLimitError(f"Python trace event limit ({self.max_events}) exceeded")

        if event == "call":
            # Emit causal code.load BEFORE recording any trace inside the newly entered frame.
            self._maybe_emit_code_load(rel_path, frame.f_code.co_firstlineno)
            if not self._record_trace:
                return None
            fid = id(frame)
            fn_name = frame.f_code.co_name
            self._frames[fid] = _FrameState(fn_name, self._snapshot_locals(frame))
            return self.trace_dispatch

        if not self._record_trace:
            return None

        fid = id(frame)
        state = self._frames.get(fid)
        if state is None:
            state = _FrameState(frame.f_code.co_name, self._snapshot_locals(frame))
            self._frames[fid] = state

        if event == "line":
            state.had_exception = False
            lineno = frame.f_lineno
            self._resolve_pending_branch(state, lineno, event)
            self._emit_local_diffs(frame, state)
            branch = self._branches_by_file[co_filename].get(lineno)
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
