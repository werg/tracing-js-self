"""External Python execution benchmark adapters (CRUXEval-O and LiveCodeBench-Exec).

Fetches public benchmark splits, converts them into verified ``tinker_py``
execution tasks, checks 100% ground-truth agreement against real CPython via
``prepare_python_task`` / ``export_python_example``, and provides clean
zero-shot output-prediction prompts and AST-literal equivalence grading.
"""

from __future__ import annotations

import ast
import builtins
import copy
import hashlib
import json
import math
from pathlib import Path
import random
import re
import tempfile
from typing import Any
import urllib.error
import urllib.request

from tinker_py.codec import encode_readable, realize_graph
from tinker_py.execution import export_python_example, prepare_python_task

CRUXEVAL_GITHUB_URL = "https://raw.githubusercontent.com/facebookresearch/cruxeval/main/data/cruxeval.jsonl"
CRUXEVAL_HF_PARQUET_URL = (
    "https://huggingface.co/datasets/cruxeval-org/cruxeval/resolve/main/data/test-00000-of-00001.parquet"
)
CRUXEVAL_HF_ROWS_URL = (
    "https://datasets-server.huggingface.co/rows?dataset=cruxeval-org/cruxeval&config=default&split=test"
)

LCB_EXEC_HF_PARQUET_URL = (
    "https://huggingface.co/datasets/livecodebench/execution-v2/resolve/main/data/test-00000-of-00001.parquet"
)
LCB_EXEC_HF_ROWS_URL = (
    "https://datasets-server.huggingface.co/rows?dataset=livecodebench/execution-v2&config=default&split=test"
)

DEFAULT_CACHE_DIR = Path(__file__).resolve().parents[2] / ".cache" / "external-benchmarks"

_USER_AGENT = "RealExecBench/1.0"

# Standard LeetCode / LiveCodeBench implicit imports injected ONLY when a name
# is referenced freely in the function source without being locally defined.
_LCB_IMPLICIT_IMPORTS: dict[str, tuple[str, str]] = {
    # typing
    "List": ("typing", "List"),
    "Dict": ("typing", "Dict"),
    "Set": ("typing", "Set"),
    "Tuple": ("typing", "Tuple"),
    "Optional": ("typing", "Optional"),
    "Any": ("typing", "Any"),
    "Union": ("typing", "Union"),
    "Callable": ("typing", "Callable"),
    "Iterable": ("typing", "Iterable"),
    "Iterator": ("typing", "Iterator"),
    "Sequence": ("typing", "Sequence"),
    "Mapping": ("typing", "Mapping"),
    # collections
    "Counter": ("collections", "Counter"),
    "defaultdict": ("collections", "defaultdict"),
    "deque": ("collections", "deque"),
    "OrderedDict": ("collections", "OrderedDict"),
    "namedtuple": ("collections", "namedtuple"),
    # math
    "inf": ("math", "inf"),
    "nan": ("math", "nan"),
    "gcd": ("math", "gcd"),
    "lcm": ("math", "lcm"),
    "sqrt": ("math", "sqrt"),
    "isqrt": ("math", "isqrt"),
    "ceil": ("math", "ceil"),
    "floor": ("math", "floor"),
    "comb": ("math", "comb"),
    "perm": ("math", "perm"),
    "factorial": ("math", "factorial"),
    "log": ("math", "log"),
    "log2": ("math", "log2"),
    "log10": ("math", "log10"),
    "prod": ("math", "prod"),
    # bisect
    "bisect": ("bisect", "bisect"),
    "bisect_left": ("bisect", "bisect_left"),
    "bisect_right": ("bisect", "bisect_right"),
    "insort": ("bisect", "insort"),
    "insort_left": ("bisect", "insort_left"),
    "insort_right": ("bisect", "insort_right"),
    # heapq
    "heappush": ("heapq", "heappush"),
    "heappop": ("heapq", "heappop"),
    "heapify": ("heapq", "heapify"),
    "heapreplace": ("heapq", "heapreplace"),
    "heappushpop": ("heapq", "heappushpop"),
    "nlargest": ("heapq", "nlargest"),
    "nsmallest": ("heapq", "nsmallest"),
    # itertools
    "accumulate": ("itertools", "accumulate"),
    "combinations": ("itertools", "combinations"),
    "combinations_with_replacement": ("itertools", "combinations_with_replacement"),
    "permutations": ("itertools", "permutations"),
    "product": ("itertools", "product"),
    "groupby": ("itertools", "groupby"),
    "chain": ("itertools", "chain"),
    "pairwise": ("itertools", "pairwise"),
    "zip_longest": ("itertools", "zip_longest"),
    # functools
    "cache": ("functools", "cache"),
    "lru_cache": ("functools", "lru_cache"),
    "reduce": ("functools", "reduce"),
    "cmp_to_key": ("functools", "cmp_to_key"),
    # string
    "ascii_lowercase": ("string", "ascii_lowercase"),
    "ascii_uppercase": ("string", "ascii_uppercase"),
    "ascii_letters": ("string", "ascii_letters"),
    "digits": ("string", "digits"),
    # operator
    "itemgetter": ("operator", "itemgetter"),
}

_LCB_IMPLICIT_MODULES: frozenset[str] = frozenset({
    "math",
    "collections",
    "itertools",
    "functools",
    "heapq",
    "bisect",
    "re",
    "string",
    "operator",
    "sys",
    "copy",
    "fractions",
    "decimal",
    "typing",
    "statistics",
})

_BUILTIN_NAMES: frozenset[str] = frozenset(dir(builtins))


def _sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _download_bytes(url: str, *, timeout: float = 30.0) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": _USER_AGENT})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read()


def _read_parquet_bytes(data: bytes) -> list[dict[str, Any]]:
    import pyarrow.parquet as pq  # local import to keep startup light

    with tempfile.NamedTemporaryFile(suffix=".parquet") as tmp:
        tmp.write(data)
        tmp.flush()
        table = pq.read_table(tmp.name)
        return table.to_pylist()


def _fetch_hf_datasets_server_rows(base_url: str, *, page_size: int = 100, timeout: float = 30.0) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    offset = 0
    while True:
        url = f"{base_url}&offset={offset}&length={page_size}"
        payload = json.loads(_download_bytes(url, timeout=timeout).decode("utf-8"))
        batch = payload.get("rows") or []
        if not batch:
            break
        for item in batch:
            row = item.get("row")
            if isinstance(row, dict):
                rows.append(row)
        total = payload.get("num_rows_total")
        offset += len(batch)
        if total is not None and offset >= int(total):
            break
        if len(batch) < page_size:
            break
    return rows


def _write_jsonl(path: Path, rows: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    with tmp.open("w", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row, ensure_ascii=False) + "\n")
    tmp.replace(path)


def _read_jsonl(path: Path) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    with path.open("r", encoding="utf-8") as handle:
        for line in handle:
            s = line.strip()
            if s:
                out.append(json.loads(s))
    return out


def fetch_cruxeval_raw(
    *,
    cache_dir: Path | str | None = None,
    refresh: bool = False,
    timeout: float = 30.0,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Fetch and cache public CRUXEval-O dataset rows."""
    cdir = Path(cache_dir) if cache_dir is not None else DEFAULT_CACHE_DIR
    cache_path = cdir / "cruxeval.jsonl"
    if cache_path.is_file() and not refresh:
        rows = _read_jsonl(cache_path)
        return rows, {"source": "cache", "cache_path": str(cache_path), "rows": len(rows)}

    errors: list[str] = []
    # 1. GitHub raw JSONL
    try:
        raw_text = _download_bytes(CRUXEVAL_GITHUB_URL, timeout=timeout).decode("utf-8")
        rows = [json.loads(line) for line in raw_text.splitlines() if line.strip()]
        if rows:
            _write_jsonl(cache_path, rows)
            return rows, {"source": CRUXEVAL_GITHUB_URL, "cache_path": str(cache_path), "rows": len(rows)}
    except Exception as exc:
        errors.append(f"github: {type(exc).__name__}: {exc}")

    # 2. HuggingFace parquet
    try:
        data = _download_bytes(CRUXEVAL_HF_PARQUET_URL, timeout=timeout)
        rows = _read_parquet_bytes(data)
        if rows:
            _write_jsonl(cache_path, rows)
            return rows, {"source": CRUXEVAL_HF_PARQUET_URL, "cache_path": str(cache_path), "rows": len(rows)}
    except Exception as exc:
        errors.append(f"hf_parquet: {type(exc).__name__}: {exc}")

    # 3. HuggingFace datasets-server rows API
    try:
        rows = _fetch_hf_datasets_server_rows(CRUXEVAL_HF_ROWS_URL, timeout=timeout)
        if rows:
            _write_jsonl(cache_path, rows)
            return rows, {"source": CRUXEVAL_HF_ROWS_URL, "cache_path": str(cache_path), "rows": len(rows)}
    except Exception as exc:
        errors.append(f"hf_rows: {type(exc).__name__}: {exc}")

    raise RuntimeError("Failed to fetch CRUXEval-O from all public sources: " + "; ".join(errors))


def fetch_livecodebench_exec_raw(
    *,
    cache_dir: Path | str | None = None,
    refresh: bool = False,
    timeout: float = 30.0,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Fetch and cache public LiveCodeBench Code Execution (execution-v2) rows."""
    cdir = Path(cache_dir) if cache_dir is not None else DEFAULT_CACHE_DIR
    cache_path = cdir / "livecodebench-exec-v2.jsonl"
    if cache_path.is_file() and not refresh:
        rows = _read_jsonl(cache_path)
        return rows, {"source": "cache", "cache_path": str(cache_path), "rows": len(rows)}

    errors: list[str] = []
    # 1. HuggingFace parquet
    try:
        data = _download_bytes(LCB_EXEC_HF_PARQUET_URL, timeout=timeout)
        rows = _read_parquet_bytes(data)
        if rows:
            _write_jsonl(cache_path, rows)
            return rows, {"source": LCB_EXEC_HF_PARQUET_URL, "cache_path": str(cache_path), "rows": len(rows)}
    except Exception as exc:
        errors.append(f"hf_parquet: {type(exc).__name__}: {exc}")

    # 2. HuggingFace datasets-server rows API
    try:
        rows = _fetch_hf_datasets_server_rows(LCB_EXEC_HF_ROWS_URL, timeout=timeout)
        if rows:
            _write_jsonl(cache_path, rows)
            return rows, {"source": LCB_EXEC_HF_ROWS_URL, "cache_path": str(cache_path), "rows": len(rows)}
    except Exception as exc:
        errors.append(f"hf_rows: {type(exc).__name__}: {exc}")

    raise RuntimeError("Failed to fetch LiveCodeBench-Exec from all public sources: " + "; ".join(errors))


def _eval_ast_node(node: ast.AST) -> Any:
    """Safely evaluate a Python literal/constructor AST node without calling eval()."""
    if isinstance(node, ast.Constant):
        return node.value
    if isinstance(node, ast.Name):
        if node.id == "True":
            return True
        if node.id == "False":
            return False
        if node.id == "None":
            return None
        if node.id == "inf":
            return float("inf")
        if node.id == "nan":
            return float("nan")
        raise ValueError(f"Unsupported name in literal expression: {node.id!r}")
    if isinstance(node, ast.UnaryOp):
        operand = _eval_ast_node(node.operand)
        if isinstance(node.op, ast.UAdd) and isinstance(operand, (int, float, complex)) and not isinstance(operand, bool):
            return +operand
        if isinstance(node.op, ast.USub) and isinstance(operand, (int, float, complex)) and not isinstance(operand, bool):
            return -operand
        raise ValueError(f"Unsupported unary op: {type(node.op).__name__}")
    if isinstance(node, ast.BinOp):
        left = _eval_ast_node(node.left)
        right = _eval_ast_node(node.right)
        if (
            isinstance(left, (int, float, complex))
            and isinstance(right, (int, float, complex))
            and not isinstance(left, bool)
            and not isinstance(right, bool)
        ):
            if isinstance(node.op, ast.Add):
                return left + right
            if isinstance(node.op, ast.Sub):
                return left - right
        raise ValueError(f"Unsupported binary op: {type(node.op).__name__}")
    if isinstance(node, ast.List):
        return [_eval_ast_node(e) for e in node.elts]
    if isinstance(node, ast.Tuple):
        return tuple(_eval_ast_node(e) for e in node.elts)
    if isinstance(node, ast.Set):
        return {_eval_ast_node(e) for e in node.elts}
    if isinstance(node, ast.Dict):
        out: dict[Any, Any] = {}
        for k, v in zip(node.keys, node.values):
            if k is None:
                raise ValueError("Dict unpacking is not supported in literal expressions")
            out[_eval_ast_node(k)] = _eval_ast_node(v)
        return out
    if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and not node.keywords:
        fn = node.func.id
        args = [_eval_ast_node(a) for a in node.args]
        if fn == "set" and len(args) <= 1:
            return set(args[0]) if args else set()
        if fn == "frozenset" and len(args) <= 1:
            return frozenset(args[0]) if args else frozenset()
        if fn == "tuple" and len(args) <= 1:
            return tuple(args[0]) if args else ()
        if fn == "list" and len(args) <= 1:
            return list(args[0]) if args else []
        if fn == "dict" and len(args) <= 1:
            return dict(args[0]) if args else {}
        if fn == "float" and len(args) == 1 and isinstance(args[0], (str, int, float)):
            return float(args[0])
        if fn == "int" and len(args) == 1 and isinstance(args[0], (str, int, float)):
            return int(args[0])
        if fn == "complex" and 1 <= len(args) <= 2:
            return complex(*args)
        if fn == "bytes" and len(args) <= 2:
            return bytes(*args)
        if fn == "bool" and len(args) <= 1:
            return bool(args[0]) if args else False
        if fn == "str" and len(args) <= 1:
            return str(args[0]) if args else ""
    raise ValueError(f"Unsupported AST node in literal expression: {type(node).__name__}")


def safe_eval_python_literal(text: str) -> Any:
    """Safely parse and evaluate a Python literal / container expression."""
    if not isinstance(text, str):
        raise ValueError("Expected string for Python literal")
    stripped = text.strip()
    if not stripped:
        raise ValueError("Empty literal string")
    tree = ast.parse(stripped, mode="eval")
    return _eval_ast_node(tree.body)


def python_values_equal(
    actual: Any,
    expected: Any,
    *,
    float_rtol: float = 1e-9,
    float_atol: float = 1e-12,
) -> bool:
    """Strict type-aware Python value equivalence for output grading."""
    if actual is None or expected is None:
        return actual is None and expected is None
    if isinstance(actual, bool) or isinstance(expected, bool):
        return isinstance(actual, bool) and isinstance(expected, bool) and actual is expected
    if isinstance(actual, (int, float)) and isinstance(expected, (int, float)):
        if isinstance(actual, float) and isinstance(expected, float):
            if math.isnan(actual) and math.isnan(expected):
                return True
            if math.isinf(actual) or math.isinf(expected):
                return actual == expected
            return math.isclose(actual, expected, rel_tol=float_rtol, abs_tol=float_atol)
        if isinstance(actual, int) and isinstance(expected, int):
            return actual == expected
        # int vs float: require exact numeric match (e.g., 1.0 == 1 in Python) only if not nan/inf
        if math.isnan(float(actual)) or math.isnan(float(expected)):
            return False
        return math.isclose(float(actual), float(expected), rel_tol=float_rtol, abs_tol=float_atol)
    if isinstance(actual, complex) and isinstance(expected, complex):
        return python_values_equal(actual.real, expected.real, float_rtol=float_rtol, float_atol=float_atol) and (
            python_values_equal(actual.imag, expected.imag, float_rtol=float_rtol, float_atol=float_atol)
        )
    if type(actual) is not type(expected):
        return False
    if isinstance(actual, (str, bytes)):
        return actual == expected
    if isinstance(actual, (list, tuple)):
        return len(actual) == len(expected) and all(
            python_values_equal(a, b, float_rtol=float_rtol, float_atol=float_atol)
            for a, b in zip(actual, expected)
        )
    if isinstance(actual, (set, frozenset)):
        if len(actual) != len(expected):
            return False
        # Exact match fast path; fall back to O(n^2) float/nested check if needed.
        if actual == expected:
            return True
        remaining = list(expected)
        for item in actual:
            idx = next(
                (i for i, cand in enumerate(remaining) if python_values_equal(item, cand, float_rtol=float_rtol, float_atol=float_atol)),
                None,
            )
            if idx is None:
                return False
            remaining.pop(idx)
        return True
    if isinstance(actual, dict):
        if len(actual) != len(expected):
            return False
        for k, v in actual.items():
            # Match key strictly (bool vs int distinction!)
            matched_key = None
            for ek in expected.keys():
                if python_values_equal(k, ek, float_rtol=float_rtol, float_atol=float_atol):
                    matched_key = ek
                    break
            if matched_key is None:
                return False
            if not python_values_equal(v, expected[matched_key], float_rtol=float_rtol, float_atol=float_atol):
                return False
        return True
    return actual == expected


_ANSWER_TAG_RE = re.compile(r"\[ANSWER\]([\s\S]*?)\[/ANSWER\]", re.IGNORECASE)
_FENCE_RE = re.compile(r"```(?:python|py|json|text)?[ \t]*\r?\n?([\s\S]*?)```", re.IGNORECASE)
_ASSERT_EQ_RE = re.compile(r"assert\s+[^\n]+?==\s*(.+)$", re.MULTILINE)


def extract_zero_shot_answer(text: str) -> str:
    """Extract the predicted Python output expression from a zero-shot model response."""
    if not isinstance(text, str):
        return ""
    stripped = text.strip()
    if not stripped:
        return ""

    # 1. Explicit [ANSWER]...[/ANSWER] block (prefer last)
    tag_matches = list(_ANSWER_TAG_RE.finditer(stripped))
    if tag_matches:
        inner = tag_matches[-1].group(1).strip()
        assert_m = list(_ASSERT_EQ_RE.finditer(inner))
        if assert_m:
            return assert_m[-1].group(1).strip()
        return inner

    # 2. Fenced code block (prefer last)
    fences = list(_FENCE_RE.finditer(stripped))
    if fences:
        inner = fences[-1].group(1).strip()
        assert_m = list(_ASSERT_EQ_RE.finditer(inner))
        if assert_m:
            return assert_m[-1].group(1).strip()
        # If it is a JSON execution completion, return raw JSON for the grader's JSON handler.
        return inner

    # 3. Inline assert f(...) == <rhs>
    assert_m = list(_ASSERT_EQ_RE.finditer(stripped))
    if assert_m:
        return assert_m[-1].group(1).strip()

    # 4. Last non-empty line, stripping common label prefixes
    lines = [line.strip() for line in stripped.splitlines() if line.strip()]
    last = lines[-1] if lines else stripped
    last = re.sub(r"^(?:output|answer|result|returns?)\s*[:=]\s*", "", last, flags=re.IGNORECASE).strip()
    return last


def grade_zero_shot_response(response_text: str, expected_output: str) -> dict[str, Any]:
    """Grade a zero-shot output prediction using safe AST literal / value equivalence."""
    extracted = extract_zero_shot_answer(response_text)
    if not extracted:
        return {
            "success": False,
            "reason": "empty-response",
            "failureCategory": "malformed_action",
            "extracted": "",
            "parsed_ok": False,
        }

    try:
        expected_val = safe_eval_python_literal(expected_output)
        expected_parsed = True
    except Exception:
        expected_val = None
        expected_parsed = False

    # Support execution-format JSON completion if a trained model emits it even in zero-shot mode.
    actual_val: Any = None
    actual_parsed = False
    if extracted.startswith("{") and extracted.endswith("}"):
        try:
            obj = json.loads(extracted)
            if isinstance(obj, dict) and obj.get("type") == "complete" and obj.get("kind") == "return" and "value" in obj:
                from tinker_py.codec import decode_readable

                actual_val = decode_readable(obj["value"])
                actual_parsed = True
        except Exception:
            pass

    if not actual_parsed:
        try:
            actual_val = safe_eval_python_literal(extracted)
            actual_parsed = True
        except Exception:
            actual_parsed = False

    if actual_parsed and expected_parsed:
        ok = python_values_equal(actual_val, expected_val)
        return {
            "success": ok,
            "reason": "verified-zero-shot-output" if ok else "output-mismatch",
            "failureCategory": None if ok else "incorrect_completion",
            "extracted": extracted,
            "parsed_ok": True,
        }

    # Fallback: normalized string comparison when literal parsing failed
    norm_actual = re.sub(r"\s+", "", extracted)
    norm_expected = re.sub(r"\s+", "", expected_output.strip())
    ok = bool(norm_actual) and norm_actual == norm_expected
    return {
        "success": ok,
        "reason": "verified-zero-shot-string" if ok else ("unparseable-output" if not actual_parsed else "output-mismatch"),
        "failureCategory": None if ok else ("malformed_action" if not actual_parsed else "incorrect_completion"),
        "extracted": extracted,
        "parsed_ok": actual_parsed,
    }


def _collect_free_names(source: str) -> set[str]:
    """Return identifiers referenced in ``source`` that are not bound or imported."""
    tree = ast.parse(source)
    bound: set[str] = set()
    used: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            bound.add(node.name)
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                all_args = (
                    list(node.args.posonlyargs)
                    + list(node.args.args)
                    + list(node.args.kwonlyargs)
                )
                if node.args.vararg:
                    all_args.append(node.args.vararg)
                if node.args.kwarg:
                    all_args.append(node.args.kwarg)
                for a in all_args:
                    bound.add(a.arg)
        elif isinstance(node, ast.Import):
            for alias in node.names:
                bound.add(alias.asname or alias.name.split(".")[0])
        elif isinstance(node, ast.ImportFrom):
            for alias in node.names:
                if alias.name != "*":
                    bound.add(alias.asname or alias.name)
        elif isinstance(node, ast.Name):
            if isinstance(node.ctx, (ast.Store, ast.Del)):
                bound.add(node.id)
            elif isinstance(node.ctx, ast.Load):
                used.add(node.id)
        elif isinstance(node, ast.ExceptHandler) and node.name:
            bound.add(node.name)
    return used - bound - _BUILTIN_NAMES


def _inject_lcb_imports(code: str) -> str:
    """Prepend only the minimal stdlib/typing imports referenced freely in LCB code."""
    free = _collect_free_names(code)
    if not free:
        return code
    mod_imports: list[str] = []
    from_imports: dict[str, list[str]] = {}
    for name in sorted(free):
        if name in _LCB_IMPLICIT_IMPORTS:
            mod, sym = _LCB_IMPLICIT_IMPORTS[name]
            from_imports.setdefault(mod, []).append(sym)
        elif name in _LCB_IMPLICIT_MODULES:
            mod_imports.append(name)
    lines: list[str] = []
    for mod in sorted(mod_imports):
        lines.append(f"import {mod}")
    for mod in sorted(from_imports):
        syms = ", ".join(sorted(set(from_imports[mod])))
        lines.append(f"from {mod} import {syms}")
    if not lines:
        return code
    return "\n".join(lines) + "\n\n" + code


def _find_top_level_function(source: str, func_name: str) -> ast.FunctionDef:
    tree = ast.parse(source)
    for node in tree.body:
        if isinstance(node, ast.FunctionDef) and node.name == func_name:
            return node
    raise ValueError(f"Top-level function {func_name!r} not found in source")


def _bind_call_args_to_positional(func_def: ast.FunctionDef, call_node: ast.Call) -> list[Any]:
    """Bind a literal AST Call node to positional argument values matching ``func_def``."""
    if func_def.args.kwonlyargs or func_def.args.kwarg:
        raise ValueError("Keyword-only or **kwargs signatures are not supported for positional binding")
    pos_params = [a.arg for a in list(func_def.args.posonlyargs) + list(func_def.args.args)]
    has_vararg = func_def.args.vararg is not None

    pos_vals: list[Any] = []
    for arg in call_node.args:
        if isinstance(arg, ast.Starred):
            val = _eval_ast_node(arg.value)
            if not isinstance(val, (list, tuple)):
                raise ValueError("Starred argument must evaluate to list/tuple")
            pos_vals.extend(val)
        else:
            pos_vals.append(_eval_ast_node(arg))

    kw_vals: dict[str, Any] = {}
    for kw in call_node.keywords:
        if kw.arg is None:
            raise ValueError("**kwargs call unpacking not supported")
        kw_vals[kw.arg] = _eval_ast_node(kw.value)

    if not kw_vals:
        if has_vararg or len(pos_vals) == len(pos_params):
            return pos_vals
        # Fill trailing defaults if fewer args supplied
        num_defaults = len(func_def.args.defaults)
        first_default_idx = len(pos_params) - num_defaults
        if len(pos_vals) < first_default_idx or len(pos_vals) > len(pos_params):
            raise ValueError(f"Arity mismatch: got {len(pos_vals)} args for {len(pos_params)} params")
        out = list(pos_vals)
        for idx in range(len(pos_vals), len(pos_params)):
            out.append(_eval_ast_node(func_def.args.defaults[idx - first_default_idx]))
        return out

    if has_vararg:
        raise ValueError("Cannot mix keyword arguments with *args in positional binding")
    if len(pos_vals) > len(pos_params):
        raise ValueError("Too many positional arguments")

    bound: dict[str, Any] = {}
    for pname, val in zip(pos_params, pos_vals):
        bound[pname] = val
    for k, v in kw_vals.items():
        if k not in pos_params:
            raise ValueError(f"Unknown keyword argument {k!r}")
        if k in bound:
            raise ValueError(f"Duplicate argument {k!r}")
        bound[k] = v

    num_defaults = len(func_def.args.defaults)
    first_default_idx = len(pos_params) - num_defaults
    defaults_map = {
        pos_params[first_default_idx + i]: func_def.args.defaults[i]
        for i in range(num_defaults)
    }
    ordered: list[Any] = []
    for pname in pos_params:
        if pname in bound:
            ordered.append(bound[pname])
        elif pname in defaults_map:
            ordered.append(_eval_ast_node(defaults_map[pname]))
        else:
            raise ValueError(f"Missing required argument {pname!r}")
    return ordered


def build_zero_shot_prompt(code: str, call_expr: str) -> str:
    """Build a standard clean CRUXEval-O / LiveCodeBench-Exec output prediction prompt."""
    return (
        "You are given a Python function and a specific function call.\n"
        "Determine the exact Python return value of the function call without executing external tools.\n"
        "Put ONLY the final Python literal return value inside [ANSWER] and [/ANSWER] tags.\n\n"
        f"```python\n{code.strip()}\n\nassert {call_expr.strip()} == ??\n```\n\n"
        "What should replace `??` so that the assertion passes? Wrap ONLY the exact Python value in [ANSWER]...[/ANSWER]."
    )


def build_zero_shot_messages(row_or_task: dict[str, Any]) -> list[dict[str, str]]:
    """Build chat messages for ``--prompt-mode zero-shot`` from an external anchor benchmark row."""
    meta = row_or_task.get("metadata") if isinstance(row_or_task.get("metadata"), dict) else {}
    task = row_or_task.get("task") if isinstance(row_or_task.get("task"), dict) else {}
    task_meta = task.get("metadata") if isinstance(task.get("metadata"), dict) else {}
    ext = meta.get("external_benchmark") or task_meta.get("external_benchmark")
    if isinstance(ext, dict) and isinstance(ext.get("zero_shot_prompt"), str) and ext["zero_shot_prompt"].strip():
        user_content = ext["zero_shot_prompt"]
    else:
        source = str(task.get("source") or row_or_task.get("source") or "")
        entry = str(task.get("entry") or row_or_task.get("entry") or "f")
        raw_args = task.get("args") if "args" in task else row_or_task.get("args", [])
        from tinker_py.codec import decode_readable

        decoded = decode_readable(raw_args)
        arg_repr = ", ".join(repr(a) for a in decoded)
        user_content = build_zero_shot_prompt(source, f"{entry}({arg_repr})")
    return [
        {
            "role": "system",
            "content": (
                "Predict the exact Python return value of the supplied function call. "
                "Do not invoke any tools. End with the exact Python literal inside [ANSWER]...[/ANSWER]."
            ),
        },
        {"role": "user", "content": user_content},
    ]


def convert_cruxeval_row(raw: dict[str, Any]) -> dict[str, Any]:
    """Convert one raw CRUXEval-O row into a ``tinker_py`` execution task."""
    code = str(raw["code"]).strip()
    raw_input = str(raw["input"]).strip()
    raw_output = str(raw["output"]).strip()
    orig_id = str(raw["id"]).strip()

    func_def = _find_top_level_function(code, "f")
    call_expr = f"f({raw_input})"
    call_ast = ast.parse(call_expr, mode="eval").body
    if not isinstance(call_ast, ast.Call):
        raise ValueError(f"Could not parse CRUXEval input as call: {raw_input!r}")
    pos_args = _bind_call_args_to_positional(func_def, call_ast)
    encoded_args = encode_readable(pos_args)

    zero_shot_prompt = build_zero_shot_prompt(code, call_expr)
    task_id = f"cruxeval-o-{orig_id}"
    family = f"cruxeval-o:{orig_id}"
    return {
        "id": task_id,
        "family": family,
        "language": "py",
        "source": code,
        "entry": "f",
        "args": encoded_args,
        "fixture": {"calls": []},
        "randomSeed": 17,
        "maxSteps": 100000,
        "timeoutMs": 10000,
        "metadata": {
            "sourceOrigin": "cruxeval-o",
            "sourceBenchmark": "cruxeval-o",
            "tier": 3,
            "features": ["external-anchor", "cruxeval-o", "python"],
            "evaluationRole": "external-anchor",
            "external_benchmark": {
                "benchmark": "cruxeval-o",
                "original_id": orig_id,
                "function_name": "f",
                "raw_code": code,
                "raw_input": raw_input,
                "call_expr": call_expr,
                "expected_output": raw_output,
                "zero_shot_prompt": zero_shot_prompt,
            },
        },
    }


def convert_lcb_row(raw: dict[str, Any]) -> dict[str, Any]:
    """Convert one raw LiveCodeBench-Exec row into a ``tinker_py`` execution task."""
    raw_code = str(raw["code"]).strip()
    raw_input = str(raw["input"]).strip()
    raw_output = str(raw["output"]).strip()
    orig_id = str(raw["id"]).strip()
    func_name = str(raw["function_name"]).strip()
    question_id = raw.get("question_id")
    difficulty = str(raw.get("difficulty") or "unknown").lower()

    source = _inject_lcb_imports(raw_code)
    func_def = _find_top_level_function(source, func_name)
    call_ast = ast.parse(raw_input, mode="eval").body
    if not isinstance(call_ast, ast.Call):
        raise ValueError(f"Could not parse LiveCodeBench input as call: {raw_input!r}")
    pos_args = _bind_call_args_to_positional(func_def, call_ast)
    encoded_args = encode_readable(pos_args)

    zero_shot_prompt = build_zero_shot_prompt(source, raw_input)
    q_tag = f"q{question_id}" if question_id is not None else orig_id
    task_id = f"lcb-exec-{orig_id}-{q_tag}"
    family = f"lcb-exec:{q_tag}"
    tier_map = {"easy": 3, "medium": 4, "hard": 5}
    return {
        "id": task_id,
        "family": family,
        "language": "py",
        "source": source,
        "entry": func_name,
        "args": encoded_args,
        "fixture": {"calls": []},
        "randomSeed": 17,
        "maxSteps": 250000,
        "timeoutMs": 10000,
        "metadata": {
            "sourceOrigin": "livecodebench-exec",
            "sourceBenchmark": "livecodebench-exec",
            "tier": tier_map.get(difficulty, 4),
            "features": ["external-anchor", "livecodebench-exec", f"lcb-{difficulty}", "python"],
            "evaluationRole": "external-anchor",
            "external_benchmark": {
                "benchmark": "livecodebench-exec",
                "original_id": orig_id,
                "question_id": question_id,
                "function_name": func_name,
                "difficulty": difficulty,
                "contest_id": raw.get("contest_id"),
                "contest_date": raw.get("contest_date"),
                "numsteps": raw.get("numsteps"),
                "raw_code": raw_code,
                "raw_input": raw_input,
                "call_expr": raw_input,
                "expected_output": raw_output,
                "zero_shot_prompt": zero_shot_prompt,
            },
        },
    }


def verify_and_export_external_task(
    task: dict[str, Any],
    *,
    trace_format: str = "compact",
    reasoning_channel: str = "thinking",
) -> dict[str, Any]:
    """Execute ``task`` in real CPython and assert 100% ground-truth agreement."""
    ext = (task.get("metadata") or {}).get("external_benchmark")
    if not isinstance(ext, dict) or not isinstance(ext.get("expected_output"), str):
        raise ValueError("External task missing metadata.external_benchmark.expected_output")

    expected_val = safe_eval_python_literal(ext["expected_output"])
    prepared = prepare_python_task(task, trace_format=trace_format)
    outcome = prepared["outcome"]
    if outcome.get("kind") != "return":
        raise ValueError(f"Expected normal return, got outcome kind {outcome.get('kind')!r}")
    roots = realize_graph(outcome["graph"])
    actual_val = roots[-1]
    if not python_values_equal(actual_val, expected_val):
        raise ValueError(
            f"CPython ground-truth mismatch on {task.get('id')}: actual={actual_val!r} != expected={expected_val!r}"
        )

    exported = export_python_example(
        task,
        trace_format=trace_format,
        reasoning_channel=reasoning_channel,
    )
    if not (exported.get("metadata", {}).get("traceAudit") or {}).get("replayVerified"):
        raise ValueError(f"Replay audit failed for {task.get('id')}")
    exported["split"] = "test"
    exported["split_component"] = _sha256_text(f"{exported['family']}:{exported['sourceHash']}")
    exported["metadata"]["cpythonGroundTruthVerified"] = True
    return exported


def _select_verified_cruxeval(
    raw_rows: list[dict[str, Any]],
    *,
    count: int,
    seed: int,
    forbidden_hashes: set[str],
    trace_format: str = "compact",
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    rng = random.Random(seed)
    candidates = list(raw_rows)
    candidates.sort(key=lambda r: str(r.get("id", "")))
    rng.shuffle(candidates)

    verified: list[dict[str, Any]] = []
    seen_hashes: set[str] = set()
    skipped: dict[str, int] = {}
    attempted = 0

    for raw in candidates:
        if len(verified) >= count:
            break
        attempted += 1
        try:
            task = convert_cruxeval_row(raw)
        except Exception as exc:
            key = f"convert:{type(exc).__name__}"
            skipped[key] = skipped.get(key, 0) + 1
            continue
        try:
            exported = verify_and_export_external_task(task, trace_format=trace_format)
        except Exception as exc:
            key = f"verify:{type(exc).__name__}"
            skipped[key] = skipped.get(key, 0) + 1
            continue
        sh = exported["sourceHash"]
        if sh in forbidden_hashes or sh in seen_hashes:
            skipped["duplicate_or_forbidden_source_hash"] = skipped.get("duplicate_or_forbidden_source_hash", 0) + 1
            continue
        seen_hashes.add(sh)
        verified.append(exported)

    stats = {
        "benchmark": "cruxeval-o",
        "raw_available": len(raw_rows),
        "requested": count,
        "attempted": attempted,
        "verified": len(verified),
        "skipped": skipped,
    }
    return verified, stats


def _select_verified_lcb(
    raw_rows: list[dict[str, Any]],
    *,
    count: int,
    seed: int,
    forbidden_hashes: set[str],
    trace_format: str = "compact",
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    # Group by question_id so we maximize unique algorithmic problems, stratified by difficulty.
    by_q: dict[str, list[dict[str, Any]]] = {}
    q_diff: dict[str, str] = {}
    for row in raw_rows:
        qid = str(row.get("question_id", row.get("id")))
        by_q.setdefault(qid, []).append(row)
        q_diff[qid] = str(row.get("difficulty") or "unknown").lower()

    rng = random.Random(seed + 101)
    diff_buckets: dict[str, list[str]] = {"hard": [], "medium": [], "easy": [], "unknown": []}
    for qid in sorted(by_q):
        diff = q_diff[qid]
        diff_buckets.setdefault(diff, []).append(qid)
        by_q[qid].sort(key=lambda r: (int(r.get("numsteps") or 0), str(r.get("id", ""))))
        rng.shuffle(by_q[qid])
    for qids in diff_buckets.values():
        rng.shuffle(qids)

    # Order question_ids: all hard questions first, then interleave medium and easy.
    ordered_qids: list[str] = []
    ordered_qids.extend(diff_buckets.get("hard", []))
    med = list(diff_buckets.get("medium", []))
    easy = list(diff_buckets.get("easy", []))
    i = 0
    while i < max(len(med), len(easy)):
        if i < len(med):
            ordered_qids.append(med[i])
        if i < len(easy):
            ordered_qids.append(easy[i])
        i += 1
    ordered_qids.extend(diff_buckets.get("unknown", []))

    verified: list[dict[str, Any]] = []
    seen_hashes: set[str] = set()
    used_qids: set[str] = set()
    skipped: dict[str, int] = {}
    difficulty_counts: dict[str, int] = {}
    attempted = 0

    # Pass 1: at most 1 verified task per unique question_id
    for qid in ordered_qids:
        if len(verified) >= count:
            break
        for raw in by_q[qid]:
            attempted += 1
            try:
                task = convert_lcb_row(raw)
            except Exception as exc:
                key = f"convert:{type(exc).__name__}"
                skipped[key] = skipped.get(key, 0) + 1
                continue
            try:
                exported = verify_and_export_external_task(task, trace_format=trace_format)
            except Exception as exc:
                key = f"verify:{type(exc).__name__}"
                skipped[key] = skipped.get(key, 0) + 1
                continue
            sh = exported["sourceHash"]
            if sh in forbidden_hashes or sh in seen_hashes:
                skipped["duplicate_or_forbidden_source_hash"] = skipped.get("duplicate_or_forbidden_source_hash", 0) + 1
                continue
            seen_hashes.add(sh)
            used_qids.add(qid)
            diff = q_diff[qid]
            difficulty_counts[diff] = difficulty_counts.get(diff, 0) + 1
            verified.append(exported)
            break

    stats = {
        "benchmark": "livecodebench-exec",
        "raw_available": len(raw_rows),
        "unique_questions_available": len(by_q),
        "unique_questions_selected": len(used_qids),
        "difficulty_counts": dict(sorted(difficulty_counts.items())),
        "requested": count,
        "attempted": attempted,
        "verified": len(verified),
        "skipped": skipped,
    }
    return verified, stats


def import_external_benchmarks(
    *,
    cruxeval_count: int = 60,
    lcb_count: int = 60,
    seed: int = 17,
    cache_dir: Path | str | None = None,
    refresh: bool = False,
    forbidden_hashes: set[str] | None = None,
    trace_format: str = "compact",
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Fetch, convert, and CPython-verify CRUXEval-O and LiveCodeBench-Exec anchor tasks."""
    forbidden = set(forbidden_hashes or ())
    tasks: list[dict[str, Any]] = []
    report: dict[str, Any] = {"sources": {}, "errors": {}}

    crux_rows: list[dict[str, Any]] | None = None
    lcb_rows: list[dict[str, Any]] | None = None

    if cruxeval_count > 0:
        try:
            crux_rows, crux_fetch = fetch_cruxeval_raw(cache_dir=cache_dir, refresh=refresh)
            report["sources"]["cruxeval-o"] = crux_fetch
        except Exception as exc:
            report["errors"]["cruxeval-o"] = str(exc)

    if lcb_count > 0:
        try:
            lcb_rows, lcb_fetch = fetch_livecodebench_exec_raw(cache_dir=cache_dir, refresh=refresh)
            report["sources"]["livecodebench-exec"] = lcb_fetch
        except Exception as exc:
            report["errors"]["livecodebench-exec"] = str(exc)

    target_crux = cruxeval_count
    target_lcb = lcb_count
    if crux_rows is None and lcb_rows is not None:
        target_lcb = cruxeval_count + lcb_count
        target_crux = 0
    elif lcb_rows is None and crux_rows is not None:
        target_crux = cruxeval_count + lcb_count
        target_lcb = 0
    elif crux_rows is None and lcb_rows is None:
        raise RuntimeError(f"No external benchmark source was reachable: {report['errors']}")

    if crux_rows is not None and target_crux > 0:
        crux_verified, crux_stats = _select_verified_cruxeval(
            crux_rows,
            count=target_crux,
            seed=seed,
            forbidden_hashes=forbidden,
            trace_format=trace_format,
        )
        tasks.extend(crux_verified)
        forbidden.update(r["sourceHash"] for r in crux_verified)
        report["cruxeval-o"] = crux_stats

    if lcb_rows is not None and target_lcb > 0:
        lcb_verified, lcb_stats = _select_verified_lcb(
            lcb_rows,
            count=target_lcb,
            seed=seed,
            forbidden_hashes=forbidden,
            trace_format=trace_format,
        )
        tasks.extend(lcb_verified)
        report["livecodebench-exec"] = lcb_stats

    report["total_verified"] = len(tasks)
    return tasks, report
