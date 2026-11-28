#!/usr/bin/env python3
"""Scalable, fault-tolerant Real-World OSS Multi-File Python Repo Harvester (v2).

Shallow-clones a curated catalog of ~105 permissively-licensed, pure-Python
multi-file GitHub repositories (100% disjoint from RealExecBench v1 and
existing Stage 10 OSS packages), builds realistic 5-220 file virtual codebases
preserving authentic distractor `.py` modules, and harvests verified, 2x
deterministic, pre-exported multi-file `code.load` execution tasks across three
complementary modes:

  Mode A (`oss-unit-test`):
    AST-extracts concrete literal call-sites from each repo's own `tests/` /
    `test/` suite (including `@pytest.mark.parametrize`, loop unrolling,
    module/class constants, positional and keyword calls, and class/method
    invocations).

  Mode B (`oss-api-probe`):
    Exercises public cross-file package APIs (both automatic AST-discovered
    cross-module functions and curated domain-diverse API entry probes) across
    multiple internal `.py` modules.

  Mode C (`oss-mutation-pair`):
    For verified Mode A/B tasks, traces executed lines in internal non-entry
    `.py` modules, applies a clean, syntax-valid 1-line AST behavioral mutation
    (prioritizing same-byte-length edits so initial prompts stay identical and
    divergence happens causally upon `code.load`!), and verifies that the exact
    same entrypoint + arguments produces a genuinely different verified outcome.

Every admitted task is verified 2x independently with TWO DIFFERENT
`PYTHONHASHSEED` values (`101` via direct `export_python_example` + live
`create_python_session` replay, and `202` via `tools/tinker-execution-py.py`
JSONL bridge), enforcing byte-for-byte identical `sourceHash` & `messages`,
strict token/turn budgets (`<= 56,000` tiktoken tokens, `<= 18,000` max turn
tokens), valid `_is_preexported_row` schema, and 0-leakage against
RealExecBench v1 + deduplication against Stage 10.
"""

from __future__ import annotations

import argparse
import ast
import builtins
import concurrent.futures
import copy
from datetime import datetime, timezone
import hashlib
import json
import math
import os
from pathlib import Path
import queue
import re
import subprocess
import sys
import tempfile
import threading
from typing import Any
import warnings

try:
    import tiktoken as _tiktoken  # type: ignore[import-not-found]
    _TIKTOKEN_ENC = _tiktoken.get_encoding("cl100k_base")
except Exception:
    _TIKTOKEN_ENC = None

warnings.filterwarnings("ignore", category=SyntaxWarning)

_REPO_ROOT = Path(__file__).resolve().parents[1]
_TRAINING_DIR = str(_REPO_ROOT / "training")
if _TRAINING_DIR not in sys.path:
    sys.path.insert(0, _TRAINING_DIR)

from tinker_py.codebase import (  # noqa: E402
    CODE_LOAD_OPERATION,
    MAX_CODEBASE_FILES,
    MAX_CODEBASE_TOTAL_BYTES,
    module_name_and_package_for,
)
from tinker_py.codec import encode_readable  # noqa: E402
from tinker_py.execution import (  # noqa: E402
    assistant_thinking_text,
    assistant_visible_text,
    audit_python_supervision,
    create_python_session,
    export_python_example,
    prepare_python_task,
)

DEFAULT_REALEXEC_BENCHMARK = Path("/home/werg/tracing-js-self/runs/realexecbench-v1/benchmark.jsonl")
DEFAULT_REALEXEC_MANIFEST = Path("/home/werg/tracing-js-self/runs/realexecbench-v1/manifest.json")
DEFAULT_STAGE10_MERGED = Path("/home/werg/tracing-js-self/runs/messy-v8-stage10/stage10-merged.jsonl")
DEFAULT_CACHE_DIR = Path("/tmp/oss-py-scale-cache")
DEFAULT_OUTPUT_DIR = _REPO_ROOT / "runs/oss-multifile-py-scale"

HASH_SEED_PASS1 = "101"
HASH_SEED_PASS2 = "202"

SKIP_DIRS = frozenset({
    ".git",
    "__pycache__",
    "venv",
    ".venv",
    "env",
    "node_modules",
    "build",
    "dist",
    "migrations",
    "docs",
    "doc",
    "examples",
    "example",
    "benchmarks",
    "scripts",
    ".tox",
    ".mypy_cache",
    ".pytest_cache",
    "site-packages",
    ".github",
})

BLOCKED_STDLIB_MODULES = frozenset({
    "socket",
    "ctypes",
    "multiprocessing",
    "signal",
    "shutil",
    "ftplib",
    "smtplib",
    "imaplib",
    "poplib",
    "webbrowser",
    "venv",
    "ensurepip",
    "pip",
    "pty",
    "tty",
    "termios",
    "fcntl",
    "mmap",
    "ssl",
    "getpass",
    "curses",
    "readline",
    "rlcompleter",
    "tkinter",
    "turtle",
    "xmlrpc",
    "wsgiref",
    "socketserver",
})

STDLIB_MODULES = frozenset(getattr(sys, "stdlib_module_names", ())) | frozenset({
    "abc", "array", "ast", "base64", "binascii", "bisect", "builtins", "calendar",
    "cmath", "codecs", "collections", "contextlib", "copy", "csv", "dataclasses",
    "datetime", "decimal", "difflib", "email", "enum", "errno", "fnmatch",
    "fractions", "functools", "gzip", "hashlib", "heapq", "hmac", "html", "http",
    "importlib", "inspect", "io", "ipaddress", "itertools", "json", "keyword",
    "locale", "logging", "math", "mimetypes", "numbers", "operator", "os",
    "pathlib", "pickle", "platform", "posixpath", "pprint", "quopri", "random",
    "re", "secrets", "sqlite3", "statistics", "string", "struct", "sys",
    "textwrap", "time", "token", "tokenize", "traceback", "types", "typing",
    "unicodedata", "urllib", "uuid", "warnings", "weakref", "xml", "zipfile",
    "zlib", "__future__",
})

IGNORED_TEST_CALLEES = frozenset(dir(builtins)) | frozenset({
    "assertEqual", "assertNotEqual", "assertTrue", "assertFalse", "assertIs",
    "assertIsNot", "assertIsNone", "assertIsNotNone", "assertIn", "assertNotIn",
    "assertRaises", "assertRaisesRegex", "assertAlmostEqual", "assertCountEqual",
    "assertDictEqual", "assertListEqual", "assertSetEqual", "assertTupleEqual",
    "raises", "approx", "parametrize", "skip", "xfail", "fail", "main",
    "fixture", "mark", "warns", "deprecated_call", "subTest", "patch", "Mock",
    "MagicMock", "call", "ANY", "NamedTuple", "dataclass",
})

FALLBACK_PROBES_BY_ARITY: dict[int, list[list[Any]]] = {
    0: [[]],
    1: [
        ["hello world, python 42!"],
        [[3, 1, 4, 1, 5, 9, 2]],
        [{"a": 1, "b": 2, "c": 3}],
        [12],
        ["https://example.com/path?x=1&y=2"],
        ["foo_bar_baz"],
        [[1, 2, 3, 4, 5]],
    ],
    2: [
        ["abracadabra", "abra"],
        [[3, 1, 4, 1, 5], 2],
        [18, 12],
        [{"a": 1, "b": 2}, {"b": 3, "c": 4}],
        ["hello world", "world"],
    ],
    3: [
        ["hello world", "world", "python"],
        [[1, 2, 3, 4, 5], 1, 4],
        [2, 5, 13],
    ],
}

# Explicit static blocklist of RealExecBench v1 & Stage 10 OSS repos/packages
# (augmented dynamically at runtime by reading benchmark.jsonl + stage10-merged.jsonl).
STATIC_FORBIDDEN_PACKAGES = frozenset({
    # RealExecBench v1
    "idna", "mistune", "dirsearch", "you_get", "you-get", "pysnooper", "yapf",
    "xsstrike", "hackerrank", "jinja", "jinja2", "simplejson", "mailinabox",
    "microk8s", "billing_engine", "doc_indexer", "flag_service",
    # Stage 10 already harvested
    "packaging", "mdurl", "markdown_it", "markdown", "dateutil", "h11", "hpack",
    "hyperframe", "h2", "click", "attr", "attrs", "urllib3", "rich", "pygments",
    "networkx", "mpmath", "tqdm", "requests", "charset_normalizer", "chz",
    "colorama", "dns", "dnspython", "fuzzywuzzy", "thefuzz", "httpcore", "httpx",
    "jmespath", "pyflakes", "yaml", "pyyaml", "sqlparse", "tomlkit", "termcolor",
    "schedule", "icecream", "watchdog", "uvicorn", "paramiko", "tiktoken",
    "minbpe", "mingpt", "lazy_loader", "docx2python", "termtosvg", "httpbin",
    "webpy", "pgcli", "sshuttle", "yah3c",
})

# ===========================================================================
# Curated Catalog of 105 Permissively-Licensed Pure-Python Multi-File OSS Repos
# ===========================================================================

REPO_CATALOG: list[dict[str, Any]] = [
    # --- Parsers / Lexers / Grammars ---
    {
        "repo": "lark-parser/lark",
        "license": "MIT",
        "domain": "parser-grammar",
        "package": "lark",
        "api_probes": [
            {
                "name": "earley_calc",
                "code": '''"""Cross-file probe exercising `lark` grammar parsing and tree transformation."""
from lark import Lark, Transformer

GRAMMAR = r"""
start: expr
?expr: term
     | expr "+" term -> add
     | expr "-" term -> sub
?term: NUMBER -> num
     | "(" expr ")"
NUMBER: /\\d+/
WS: /[ \\t\\r\\n]+/
%ignore WS
"""

class Calc(Transformer):
    def num(self, items):
        return int(items[0])
    def add(self, items):
        return items[0] + items[1]
    def sub(self, items):
        return items[0] - items[1]
    def start(self, items):
        return items[0]

def run(expr_text: str) -> dict:
    parser = Lark(GRAMMAR, parser="earley")
    tree = parser.parse(expr_text)
    val = Calc().transform(tree)
    return {"value": val, "tree": tree.pretty().strip()}
''',
                "cases": [
                    ("arith1", ["12 + (7 - 3) + 5"]),
                    ("arith2", ["100 - (25 + 15) - 8"]),
                ],
            },
        ],
    },
    {
        "repo": "pyparsing/pyparsing",
        "license": "MIT",
        "domain": "parser-grammar",
        "package": "pyparsing",
        "api_probes": [
            {
                "name": "kv_expr",
                "code": '''"""Cross-file probe exercising `pyparsing` combinators and infix notation."""
import pyparsing as pp

def run(records: list[str]) -> list[dict]:
    key = pp.Word(pp.alphas + "_", pp.alphanums + "_")("key")
    num = pp.pyparsing_common.signed_integer("num")
    word = pp.Word(pp.alphanums + "._-/")("word")
    pair = pp.Group(key + pp.Suppress("=") + (num | word))
    stmt = pp.DelimitedList(pair)
    out = []
    for line in records:
        parsed = stmt.parse_string(line, parse_all=True)
        out.append({item[0]: item[1] for item in parsed})
    return out
''',
                "cases": [
                    ("cfg", [["host=api.local, port=8080, retries=3", "env=prod, timeout=-1"]]),
                    ("metrics", [["cpu=42, mem=1024, node=worker_1"]]),
                ],
            },
        ],
    },
    {
        "repo": "erikrose/parsimonious",
        "license": "MIT",
        "domain": "parser-grammar",
        "package": "parsimonious",
        "api_probes": [
            {
                "name": "peg_ini",
                "code": '''"""Cross-file probe exercising `parsimonious` PEG grammar compilation and NodeVisitor."""
from parsimonious.grammar import Grammar
from parsimonious.nodes import NodeVisitor

class EntryVisitor(NodeVisitor):
    def visit_entry(self, node, visited):
        k, _, v = visited
        return (k, v)
    def visit_key(self, node, _):
        return node.text.strip()
    def visit_val(self, node, _):
        return node.text.strip()
    def visit_doc(self, node, visited):
        return dict(visited)
    def generic_visit(self, node, visited):
        return visited or node.text

def run(text: str) -> dict:
    g = Grammar(r"""
        doc = entry+
        entry = key "=" val
        key = ~"[a-z_]+"
        val = ~"[a-z0-9_.-]+" ~"\\s*"
    """)
    tree = g.parse(text)
    return EntryVisitor().visit(tree)
''',
                "cases": [
                    ("kv1", ["mode=fast\nretries=4\nregion=us-east\n"]),
                    ("kv2", ["name=alpha\nversion=1.2.3\n"]),
                ],
            },
        ],
    },
    {
        "repo": "dabeaz/ply",
        "license": "BSD-3-Clause",
        "domain": "parser-grammar",
        "package": "ply",
        "api_probes": [
            {
                "name": "lex_tokens",
                "code": '''"""Cross-file probe exercising `ply.lex` tokenization."""
import ply.lex as lex

tokens = ("IDENT", "NUMBER", "PLUS", "MINUS", "TIMES", "LPAREN", "RPAREN")
t_PLUS = r"\\+"
t_MINUS = r"-"
t_TIMES = r"\\*"
t_LPAREN = r"\\("
t_RPAREN = r"\\)"
t_ignore = " \\t\\n"

def t_IDENT(t):
    r"[a-zA-Z_][a-zA-Z0-9_]*"
    return t

def t_NUMBER(t):
    r"\\d+"
    t.value = int(t.value)
    return t

def t_error(t):
    t.lexer.skip(1)

def run(src: str) -> list[dict]:
    lexer = lex.lex(module=globals())
    lexer.input(src)
    out = []
    for tok in lexer:
        out.append({"type": tok.type, "value": tok.value, "pos": tok.lexpos})
    return out
''',
                "cases": [
                    ("expr1", ["alpha + 42 * (beta - 7)"]),
                    ("expr2", ["x1 * 10 + y2 - 3"]),
                ],
            },
        ],
    },
    {
        "repo": "textX/Arpeggio",
        "license": "MIT",
        "domain": "parser-grammar",
        "package": "arpeggio",
        "api_probes": [
            {
                "name": "peg_parse",
                "code": '''"""Cross-file probe exercising `arpeggio` PEG parser and PTNodeVisitor."""
from arpeggio import Optional, ZeroOrMore, EOF, ParserPython, PTNodeVisitor, visit_parse_tree
from arpeggio import RegExMatch as _

def number(): return _(r"\\d+")
def factor(): return Optional(["+", "-"]), number
def term(): return factor, ZeroOrMore(["*", "/"], factor)
def expr(): return term, ZeroOrMore(["+", "-"], term)
def calc(): return expr, EOF

class EvalVisitor(PTNodeVisitor):
    def visit_number(self, node, children):
        return int(node.value)
    def visit_factor(self, node, children):
        return -children[1] if len(children) == 2 and children[0] == "-" else children[-1]
    def visit_term(self, node, children):
        acc = children[0]
        for i in range(1, len(children), 2):
            acc = acc * children[i + 1] if children[i] == "*" else acc // children[i + 1]
        return acc
    def visit_expr(self, node, children):
        acc = children[0]
        for i in range(1, len(children), 2):
            acc = acc + children[i + 1] if children[i] == "+" else acc - children[i + 1]
        return acc
    def visit_calc(self, node, children):
        return children[0]

def run(text: str) -> int:
    parser = ParserPython(calc)
    tree = parser.parse(text)
    return visit_parse_tree(tree, EvalVisitor())
''',
                "cases": [
                    ("calc1", ["3 + 4 * 5 - 6 / 2"]),
                    ("calc2", ["-10 + 8 * 3 - 4"]),
                ],
            },
        ],
    },
    {
        "repo": "eliben/pycparser",
        "license": "BSD-3-Clause",
        "domain": "parser-grammar",
        "package": "pycparser",
        "api_probes": [
            {
                "name": "c99_ast",
                "code": '''"""Cross-file probe exercising `pycparser` C99 lexer, parser, and AST generator."""
from pycparser import c_parser, c_generator, c_ast

def run(c_src: str) -> dict:
    parser = c_parser.CParser(lex_optimize=False, yacc_optimize=False)
    ast = parser.parse(c_src)
    funcs = [ext.decl.name for ext in ast.ext if isinstance(ext, c_ast.FuncDef)]
    regen = c_generator.CGenerator().visit(ast).strip()
    return {"funcs": funcs, "regen": regen}
''',
                "cases": [
                    ("add_fn", ["int add(int a, int b) { int s = a + b; return s; }"]),
                    ("clamp_fn", ["int clamp(int x, int lo, int hi) { if (x < lo) return lo; if (x > hi) return hi; return x; }"]),
                ],
            },
        ],
    },

    # --- SQL ---
    {
        "repo": "tobymao/sqlglot",
        "license": "MIT",
        "domain": "sql",
        "package": "sqlglot",
        "api_probes": [
            {
                "name": "transpile_ast",
                "code": '''"""Cross-file probe exercising `sqlglot` SQL parsing, AST traversal, and transpilation."""
import sqlglot
from sqlglot import exp

def run(sql: str, read_dialect: str, write_dialect: str) -> dict:
    tree = sqlglot.parse_one(sql, read=read_dialect)
    tables = sorted({t.name for t in tree.find_all(exp.Table)})
    cols = sorted({c.name for c in tree.find_all(exp.Column)})
    out_sql = tree.sql(dialect=write_dialect)
    return {"tables": tables, "columns": cols, "sql": out_sql}
''',
                "cases": [
                    ("pg_to_sqlite", ["SELECT u.id, COALESCE(u.name, 'anon') AS nm FROM users u JOIN orders o ON u.id = o.user_id WHERE o.total > 50", "postgres", "sqlite"]),
                    ("mysql_to_pg", ["SELECT `acct_id`, COUNT(*) AS n FROM `events` WHERE `kind` = 'click' GROUP BY `acct_id` LIMIT 10", "mysql", "postgres"]),
                ],
            },
        ],
    },
    {
        "repo": "kayak/pypika",
        "license": "Apache-2.0",
        "domain": "sql",
        "package": "pypika",
        "api_probes": [
            {
                "name": "query_builder",
                "code": '''"""Cross-file probe exercising `pypika` multi-table SQL query construction."""
from pypika import Query, Table, Order, Case, functions as fn

def run(min_amount: int, hi_amount: int, limit_n: int) -> str:
    orders = Table("orders")
    customers = Table("customers")
    tier = Case().when(orders.amount >= hi_amount, "high").else_("std").as_("tier")
    q = (
        Query.from_(orders)
        .join(customers)
        .on(orders.customer_id == customers.id)
        .select(customers.region, tier, fn.Count(orders.id).as_("cnt"), fn.Sum(orders.amount).as_("rev"))
        .where((orders.amount >= min_amount) & (orders.status == "paid"))
        .groupby(customers.region)
        .orderby(fn.Sum(orders.amount), order=Order.desc)
        .limit(limit_n)
    )
    return q.get_sql()
''',
                "cases": [
                    ("paid", [100, 500, 5]),
                    ("enterprise", [250, 2000, 10]),
                ],
            },
        ],
    },

    # --- TOML / INI / JSON5 / HJSON / JSONPatch / JSONPath / Config ---
    {
        "repo": "hukkin/tomli",
        "license": "MIT",
        "domain": "toml-config",
        "package": "tomli",
    },
    {
        "repo": "uiri/toml",
        "license": "MIT",
        "domain": "toml-config",
        "package": "toml",
        "api_probes": [
            {
                "name": "roundtrip",
                "code": '''"""Cross-file probe exercising `toml` load/dump round-trip."""
import toml

def run(doc: str) -> dict:
    parsed = toml.loads(doc)
    dumped = toml.dumps(parsed)
    reparsed = toml.loads(dumped)
    return {"parsed": parsed, "same": parsed == reparsed, "lines": len(dumped.splitlines())}
''',
                "cases": [
                    ("project", ['[package]\nname = "demo"\nversion = "1.4.2"\n[deps]\ncore = true\nretries = 3\n']),
                    ("nested", ['title = "cfg"\n[[servers]]\nhost = "a.local"\nport = 8080\n[[servers]]\nhost = "b.local"\nport = 8443\n']),
                ],
            },
        ],
    },
    {
        "repo": "DiffSK/configobj",
        "license": "BSD-3-Clause",
        "domain": "toml-config",
        "package": "configobj",
        "api_probes": [
            {
                "name": "ini_sections",
                "code": '''"""Cross-file probe exercising `configobj` nested INI parsing & interpolation."""
from configobj import ConfigObj

def run(lines: list[str]) -> dict:
    cfg = ConfigObj(lines)
    return cfg.dict()
''',
                "cases": [
                    ("nested", [["[server]", "host = localhost", "port = 8080", "[[tls]]", "enabled = true", "cert = /etc/tls.pem"]]),
                    ("list_vals", [["[pipeline]", "stages = extract, transform, load", "batch = 64"]]),
                ],
            },
        ],
    },
    {
        "repo": "dpranke/pyjson5",
        "license": "Apache-2.0",
        "domain": "json-config",
        "package": "json5",
        "api_probes": [
            {
                "name": "parse_dump",
                "code": '''"""Cross-file probe exercising `json5` parsing with comments, trailing commas, and unquoted keys."""
import json5

def run(text: str) -> dict:
    obj = json5.loads(text)
    dumped = json5.dumps(obj, sort_keys=True)
    return {"obj": obj, "dumped": dumped}
''',
                "cases": [
                    ("comments", ["{ // service config\n  name: 'edge-gw', retries: 3, hex: 0x10, tags: ['a', 'b',], }"]),
                    ("multiline", ["{/* block */ enabled: true, ratio: .5, items: [1, +2, -3,] }"]),
                ],
            },
        ],
    },
    {
        "repo": "hjson/hjson-py",
        "license": "MIT",
        "domain": "json-config",
        "package": "hjson",
        "api_probes": [
            {
                "name": "hjson_codec",
                "code": '''"""Cross-file probe exercising `hjson` human-JSON parser and encoder."""
import hjson

def run(text: str) -> dict:
    parsed = dict(hjson.loads(text))
    encoded = hjson.dumpsJSON(parsed, sort_keys=True)
    return {"parsed": parsed, "json": encoded}
''',
                "cases": [
                    ("unquoted", ["# comment\n{\n  host: api.internal\n  port: 9000\n  tags: [\n    fast\n    safe\n  ]\n}"]),
                    ("nested", ["{\n  service: billing\n  limits: {\n    rpm: 600\n    burst: 40\n  }\n}"]),
                ],
            },
        ],
    },
    {
        "repo": "stefankoegl/python-json-patch",
        "license": "BSD-3-Clause",
        "domain": "json-config",
        "package": "jsonpatch",
    },
    {
        "repo": "jg-rp/python-jsonpath",
        "license": "MIT",
        "domain": "json-config",
        "package": "jsonpath",
        "api_probes": [
            {
                "name": "rfc9535_query",
                "code": '''"""Cross-file probe exercising `jsonpath` RFC 9535 query compilation and evaluation."""
import jsonpath

def run(query: str, data: dict) -> dict:
    nodes = jsonpath.findall(query, data)
    paths = [m.path for m in jsonpath.finditer(query, data)]
    return {"values": nodes, "paths": paths}
''',
                "cases": [
                    ("filter", ["$.items[?@.price < 20].name", {"items": [{"name": "pen", "price": 5}, {"name": "bag", "price": 45}, {"name": "pad", "price": 12}]}]),
                    ("slice", ["$.scores[1:4]", {"scores": [10, 20, 30, 40, 50]}]),
                ],
            },
        ],
    },
    {"repo": "wbolster/jsonlines", "license": "BSD-3-Clause", "domain": "json-config", "package": "jsonlines"},
    {"repo": "pytest-dev/iniconfig", "license": "MIT", "domain": "toml-config", "package": "iniconfig"},

    # --- Markdown / HTML / CSS / XML / RSS ---
    {
        "repo": "miyuchina/mistletoe",
        "license": "MIT",
        "domain": "markdown-markup",
        "package": "mistletoe",
        "api_probes": [
            {
                "name": "render_html",
                "code": '''"""Cross-file probe exercising `mistletoe` Markdown AST parsing and HTML rendering."""
import mistletoe

def run(md_text: str) -> dict:
    html = mistletoe.markdown(md_text)
    return {"html": html.strip(), "lines": len(html.strip().splitlines())}
''',
                "cases": [
                    ("heading_list", ["# Release Notes\n\n- Fixed **parser** bug\n- Added `cache` layer\n"]),
                    ("quote_link", ["## Guide\n\n> See [docs](https://example.com) for *details*.\n"]),
                ],
            },
        ],
    },
    {
        "repo": "frostming/marko",
        "license": "MIT",
        "domain": "markdown-markup",
        "package": "marko",
        "api_probes": [
            {
                "name": "commonmark_render",
                "code": '''"""Cross-file probe exercising `marko` CommonMark parsing and HTML rendering."""
import marko

def run(md_text: str) -> dict:
    html = marko.convert(md_text)
    return {"html": html.strip(), "length": len(html)}
''',
                "cases": [
                    ("doc1", ["# Intro\n\nHello *world* and **marko**!\n\n- one\n- two\n"]),
                    ("doc2", ["## Spec\n\nUse `code` inside [links](https://ex.io).\n"]),
                ],
            },
        ],
    },
    {
        "repo": "html5lib/html5lib-python",
        "license": "MIT",
        "domain": "html-css",
        "package": "html5lib",
        "api_probes": [
            {
                "name": "parse_serialize",
                "code": '''"""Cross-file probe exercising `html5lib` HTML5 treebuilder and serializer."""
import html5lib

def run(raw_html: str) -> dict:
    doc = html5lib.parse(raw_html)
    tags = [el.tag.split("}")[-1] for el in doc.iter()]
    serialized = html5lib.serialize(doc)
    return {"tags": tags, "serialized": serialized}
''',
                "cases": [
                    ("unclosed", ["<div><p>Hello <b>world</div>"]),
                    ("table", ["<table><tr><td>A<td>B<tr><td>1<td>2</table>"]),
                ],
            },
        ],
    },
    {
        "repo": "Kozea/tinycss2",
        "license": "BSD-3-Clause",
        "domain": "html-css",
        "package": "tinycss2",
        "api_probes": [
            {
                "name": "parse_stylesheet",
                "code": '''"""Cross-file probe exercising `tinycss2` CSS tokenization, stylesheet parsing, and color parsing."""
import tinycss2
from tinycss2 import color3

def run(css_text: str, color_str: str) -> dict:
    rules = tinycss2.parse_stylesheet(css_text, skip_comments=True, skip_whitespace=True)
    summary = []
    for r in rules:
        if r.type == "qualified-rule":
            sel = tinycss2.serialize(r.prelude).strip()
            decls = tinycss2.parse_declaration_list(r.content, skip_comments=True, skip_whitespace=True)
            props = {d.lower_name: tinycss2.serialize(d.value).strip() for d in decls if d.type == "declaration"}
            summary.append({"selector": sel, "props": props})
    rgba = color3.parse_color(color_str)
    return {"rules": summary, "color": list(rgba) if rgba else None}
''',
                "cases": [
                    ("card", [".card { color: #ff8800; padding: 8px 12px; } h1 { margin: 0; }", "rgba(255, 128, 0, 0.5)"]),
                    ("nav", ["nav > a:hover { background: #112233; display: block; }", "hsl(120, 100%, 25%)"]),
                ],
            },
        ],
    },
    {
        "repo": "scrapy/cssselect",
        "license": "BSD-3-Clause",
        "domain": "html-css",
        "package": "cssselect",
        "api_probes": [
            {
                "name": "css_to_xpath",
                "code": '''"""Cross-file probe exercising `cssselect` CSS selector parsing and XPath translation."""
from cssselect import GenericTranslator

def run(selectors: list[str]) -> list[dict]:
    tr = GenericTranslator()
    return [{"css": s, "xpath": tr.css_to_xpath(s)} for s in selectors]
''',
                "cases": [
                    ("basic", [["div.card > p.lead", "ul li:first-child a[href^='https']"]]),
                    ("pseudo", [["table tr:nth-child(2n+1) td", "input[type='text']:not(.hidden)"]]),
                ],
            },
        ],
    },
    {
        "repo": "scrapy/w3lib",
        "license": "BSD-3-Clause",
        "domain": "html-css",
        "package": "w3lib",
        "api_probes": [
            {
                "name": "url_html_clean",
                "code": '''"""Cross-file probe exercising `w3lib` URL canonicalization and HTML stripping."""
from w3lib.url import canonicalize_url, add_or_replace_parameter
from w3lib.html import remove_tags, replace_entities

def run(url: str, html_snippet: str) -> dict:
    canon = canonicalize_url(url)
    updated = add_or_replace_parameter(canon, "page", "2")
    text = replace_entities(remove_tags(html_snippet)).strip()
    return {"canonical": canon, "updated": updated, "text": text}
''',
                "cases": [
                    ("basic", ["https://Example.COM/items?b=2&a=1#frag", "<div><h1>Hello &amp; Welcome</h1><p>Price: &pound;9</p></div>"]),
                    ("spaces", ["http://ex.io/a b/c?page=1&z=9", "<article><span>Alpha &lt; Beta</span></article>"]),
                ],
            },
        ],
    },
    {
        "repo": "kurtmckee/feedparser",
        "license": "BSD-2-Clause",
        "domain": "html-css",
        "package": "feedparser",
        "api_probes": [
            {
                "name": "parse_atom_rss",
                "code": '''"""Cross-file probe exercising `feedparser` RSS/Atom parsing."""
import feedparser

def run(xml_doc: str) -> dict:
    d = feedparser.parse(xml_doc)
    return {
        "version": d.version,
        "title": d.feed.get("title"),
        "entries": [{"title": e.get("title"), "link": e.get("link")} for e in d.entries],
    }
''',
                "cases": [
                    ("rss2", ['<?xml version="1.0"?><rss version="2.0"><channel><title>Dev Feed</title><item><title>Post 1</title><link>https://ex.io/1</link></item><item><title>Post 2</title><link>https://ex.io/2</link></item></channel></rss>']),
                    ("atom", ['<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Releases</title><entry><title>v2.0</title><link href="https://ex.io/v2"/></entry></feed>']),
                ],
            },
        ],
    },
    {
        "repo": "tiran/defusedxml",
        "license": "PSF",
        "domain": "html-css",
        "package": "defusedxml",
        "api_probes": [
            {
                "name": "safe_xml_parse",
                "code": '''"""Cross-file probe exercising `defusedxml.ElementTree` safe XML parsing."""
from defusedxml import ElementTree as DET

def run(xml_str: str) -> dict:
    root = DET.fromstring(xml_str)
    items = [{"tag": el.tag, "attrib": dict(sorted(el.attrib.items())), "text": (el.text or "").strip()} for el in root]
    return {"root": root.tag, "count": len(items), "items": items}
''',
                "cases": [
                    ("catalog", ['<catalog><item id="1" kind="book">Python</item><item id="2" kind="tool">Parser</item></catalog>']),
                    ("config", ['<config><server host="a.local" port="8080">primary</server><server host="b.local" port="8443">backup</server></config>']),
                ],
            },
        ],
    },

    # --- Template Engines ---
    {
        "repo": "jg-rp/liquid",
        "license": "MIT",
        "domain": "template",
        "package": "liquid",
        "api_probes": [
            {
                "name": "render_tpl",
                "code": '''"""Cross-file probe exercising `liquid` template lexer, parser, filters, and renderer."""
from liquid import Environment

def run(source: str, ctx: dict) -> str:
    env = Environment()
    tpl = env.from_string(source)
    return tpl.render(**ctx).strip()
''',
                "cases": [
                    ("loop_filter", ["Hi {{ user | upcase }}: {% for x in items %}{{ x }}{% unless forloop.last %}, {% endunless %}{% endfor %}", {"user": "ada", "items": ["a", "b", "c"]}]),
                    ("cond_math", ["{% assign total = price | plus: tax %}{% if total > 100 %}VIP:{{ total }}{% else %}STD:{{ total }}{% endif %}", {"price": 90, "tax": 18}]),
                ],
            },
        ],
    },
    {
        "repo": "noahmorrison/chevron",
        "license": "MIT",
        "domain": "template",
        "package": "chevron",
        "api_probes": [
            {
                "name": "mustache_render",
                "code": '''"""Cross-file probe exercising `chevron` Mustache tokenizer and renderer."""
import chevron

def run(tpl: str, data: dict) -> str:
    return chevron.render(tpl, data)
''',
                "cases": [
                    ("sections", ["Hello {{name}}! {{#items}}[{{k}}={{v}}]{{/items}}{{^items}}empty{{/items}}", {"name": "Ops", "items": [{"k": "a", "v": 1}, {"k": "b", "v": 2}]}]),
                    ("inverted", ["User: {{user}} {{^active}}(inactive){{/active}}{{#active}}(ok){{/active}}", {"user": "bob", "active": False}]),
                ],
            },
        ],
    },
    {
        "repo": "defunkt/pystache",
        "license": "MIT",
        "domain": "template",
        "package": "pystache",
        "api_probes": [
            {
                "name": "render_mustache",
                "code": '''"""Cross-file probe exercising `pystache` Mustache renderer."""
import pystache

def run(template: str, context: dict) -> str:
    return pystache.render(template, context)
''',
                "cases": [
                    ("list", ["{{#rows}}{{id}}:{{val}};{{/rows}}", {"rows": [{"id": 1, "val": "x"}, {"id": 2, "val": "y"}]}]),
                    ("escape", ["Title={{title}}, Raw={{{raw}}}", {"title": "<A&B>", "raw": "<b>ok</b>"}]),
                ],
            },
        ],
    },
    {
        "repo": "sqlalchemy/mako",
        "license": "MIT",
        "domain": "template",
        "package": "mako",
        "api_probes": [
            {
                "name": "compile_render",
                "code": '''"""Cross-file probe exercising `mako` template lexer, codegen, and rendering."""
from mako.template import Template

def run(src: str, data: dict) -> str:
    t = Template(src)
    return t.render(**data).strip()
''',
                "cases": [
                    ("for_loop", ["% for k, v in sorted(pairs.items()):\n${k}=${v * 2}\n% endfor", {"pairs": {"a": 3, "b": 7}}]),
                    ("cond", ["% if score >= 80:\nPASS(${name})\n% else:\nRETRY(${name})\n% endif", {"name": "svc", "score": 85}]),
                ],
            },
        ],
    },
    {"repo": "mahmoud/ashes", "license": "BSD-3-Clause", "domain": "template", "package": "ashes"},

    # --- URL / HTTP / WebSocket / Headers / Cookies / ASGI ---
    {
        "repo": "python-hyper/rfc3986",
        "license": "Apache-2.0",
        "domain": "url-http",
        "package": "rfc3986",
        "api_probes": [
            {
                "name": "uri_normalize",
                "code": '''"""Cross-file probe exercising `rfc3986` URI parsing, normalization, and reference resolution."""
import rfc3986

def run(base_uri: str, rel_ref: str) -> dict:
    base = rfc3986.uri_reference(base_uri).normalize()
    resolved = base.resolve_with(rel_ref).normalize()
    return {
        "base": base.unsplit(),
        "resolved": resolved.unsplit(),
        "scheme": resolved.scheme,
        "host": resolved.host,
        "port": resolved.port,
        "valid": resolved.is_valid(require_scheme=True, require_authority=True),
    }
''',
                "cases": [
                    ("resolve", ["HTTP://Example.COM:80/a/b/c?x=1", "../d/e?y=2#sec"]),
                    ("https_port", ["https://API.LOCAL:443/v1/users/", "./42/profile?full=1"]),
                ],
            },
        ],
    },
    {
        "repo": "python-hyper/wsproto",
        "license": "MIT",
        "domain": "protocol",
        "package": "wsproto",
        "api_probes": [
            {
                "name": "frame_exchange",
                "code": '''"""Cross-file probe exercising `wsproto` WebSocket frame protocol encoding and decoding."""
from wsproto.frame_protocol import FrameProtocol, Opcode

def run(messages: list[str]) -> list[dict]:
    client_fp = FrameProtocol(client=True, extensions=[])
    server_fp = FrameProtocol(client=False, extensions=[])
    out = []
    for msg in messages:
        wire = client_fp.send_data(msg.encode("utf-8"), fin=True)
        server_fp.receive_bytes(wire)
        for frame in server_fp.received_frames():
            out.append({
                "opcode": frame.opcode.name,
                "fin": frame.frame_finished,
                "payload": bytes(frame.payload).decode("utf-8"),
            })
    return out
''',
                "cases": [
                    ("two_msgs", [["hello ws", "frame #2"]]),
                    ("json_msg", [['{"event":"ping","seq":7}']]),
                ],
            },
        ],
    },
    {
        "repo": "python-hyper/priority",
        "license": "MIT",
        "domain": "protocol",
        "package": "priority",
        "api_probes": [
            {
                "name": "h2_priority_tree",
                "code": '''"""Cross-file probe exercising `priority` HTTP/2 stream dependency priority scheduler."""
import priority

def run(streams: list[list[int]], steps: int) -> list[int]:
    p = priority.PriorityTree()
    for sid, weight, dep in streams:
        p.insert_stream(stream_id=sid, weight=weight, depends_on=dep)
    order = []
    for _ in range(steps):
        order.append(next(p))
    return order
''',
                "cases": [
                    ("weights", [[[1, 16, 0], [3, 32, 0], [5, 16, 0]], 6]),
                    ("dep_chain", [[[1, 20, 0], [3, 10, 1], [5, 40, 0]], 5]),
                ],
            },
        ],
    },
    {
        "repo": "python-websockets/websockets",
        "license": "BSD-3-Clause",
        "domain": "protocol",
        "package": "websockets",
        "api_probes": [
            {
                "name": "headers_uri",
                "code": '''"""Cross-file probe exercising `websockets` URI parsing, headers, and frame serialization."""
from websockets.uri import parse_uri
from websockets.datastructures import Headers
from websockets.frames import Frame, Opcode

def run(uri: str, hdr_pairs: list[list[str]], payload: str) -> dict:
    parsed = parse_uri(uri)
    h = Headers(hdr_pairs)
    frame = Frame(Opcode.TEXT, payload.encode("utf-8"))
    wire = frame.serialize(mask=False)
    return {
        "secure": parsed.secure,
        "host": parsed.host,
        "port": parsed.port,
        "path": parsed.resource_name,
        "upgrade": h.get("upgrade"),
        "wire_len": len(wire),
    }
''',
                "cases": [
                    ("wss", ["wss://stream.example.io:8443/v1/feed?room=alpha", [["Upgrade", "websocket"], ["Connection", "Upgrade"]], "hello-socket"]),
                    ("ws", ["ws://localhost:9001/events", [["Host", "localhost:9001"], ["Upgrade", "websocket"]], "tick=42"]),
                ],
            },
        ],
    },
    {
        "repo": "jawah/kiss-headers",
        "license": "MIT",
        "domain": "url-http",
        "package": "kiss_headers",
        "api_probes": [
            {
                "name": "parse_http_headers",
                "code": '''"""Cross-file probe exercising `kiss_headers` structured HTTP header parsing."""
from kiss_headers import parse_it

def run(raw_headers: str) -> dict:
    hdrs = parse_it(raw_headers)
    ct = hdrs.content_type
    return {
        "count": len(hdrs),
        "content_type": str(ct.content) if ct else None,
        "charset": ct.charset if ct and hasattr(ct, "charset") else None,
        "keys": [h.name for h in hdrs],
    }
''',
                "cases": [
                    ("json", ["Content-Type: application/json; charset=utf-8\r\nCache-Control: max-age=60, public\r\nX-Trace: abc123\r\n"]),
                    ("html", ["Content-Type: text/html; charset=iso-8859-1\r\nSet-Cookie: sid=xyz; Path=/; HttpOnly\r\n"]),
                ],
            },
        ],
    },
    {
        "repo": "Pylons/webob",
        "license": "MIT",
        "domain": "url-http",
        "package": "webob",
        "api_probes": [
            {
                "name": "req_resp",
                "code": '''"""Cross-file probe exercising `webob` Request/Response/Headers/Cookies/Accept."""
from webob import Request, Response

def run(path_qs: str, accept_hdr: str, cookie_hdr: str) -> dict:
    req = Request.blank(path_qs, headers={"Accept": accept_hdr, "Cookie": cookie_hdr})
    best = req.accept.best_match(["application/json", "text/html", "text/plain"])
    resp = Response(body=f"best={best}", content_type=best or "text/plain")
    resp.set_cookie("seen", "1", path="/")
    return {
        "path": req.path,
        "params": dict(req.GET),
        "cookies": dict(req.cookies),
        "best_match": best,
        "status": resp.status,
    }
''',
                "cases": [
                    ("json_pref", ["/api/search?q=python&limit=5", "text/html;q=0.5, application/json;q=0.9", "session=s42; theme=dark"]),
                    ("html_pref", ["/docs?lang=en", "text/html, */*;q=0.1", "uid=99"]),
                ],
            },
        ],
    },
    {
        "repo": "pallets/werkzeug",
        "license": "BSD-3-Clause",
        "domain": "url-http",
        "package": "werkzeug",
        "api_probes": [
            {
                "name": "http_headers",
                "code": '''"""Cross-file probe exercising `werkzeug.http` HTTP header, cache-control, and cookie parsing."""
from werkzeug.http import parse_cache_control_header, parse_options_header, parse_cookie, dump_cookie

def run(cache_hdr: str, ct_hdr: str, cookie_hdr: str) -> dict:
    cc = parse_cache_control_header(cache_hdr)
    mime, opts = parse_options_header(ct_hdr)
    cookies = dict(sorted(parse_cookie(cookie_hdr).items()))
    dumped = dump_cookie("sid", "tok42", max_age=300, httponly=True, path="/")
    return {
        "max_age": cc.max_age,
        "no_cache": cc.no_cache,
        "mime": mime,
        "opts": opts,
        "cookies": cookies,
        "dumped": dumped,
    }
''',
                "cases": [
                    ("hdr1", ["public, max-age=300", "application/json; charset=utf-8", "theme=dark; lang=en"]),
                    ("hdr2", ["no-cache, max-age=0", "text/plain; version=2", "uid=99; role=ops"]),
                ],
            },
        ],
    },
    {
        "repo": "encode/starlette",
        "license": "BSD-3-Clause",
        "domain": "url-http",
        "package": "starlette",
        "api_probes": [
            {
                "name": "url_datastructures",
                "code": '''"""Cross-file probe exercising `starlette.datastructures` URL, QueryParams, and Headers."""
from starlette.datastructures import URL, Headers, QueryParams

def run(raw_url: str, extra_q: dict, raw_hdrs: list[list[str]]) -> dict:
    u = URL(raw_url).include_query_params(**extra_q)
    qp = QueryParams(u.query)
    h = Headers(headers={k: v for k, v in raw_hdrs})
    return {
        "url": str(u),
        "scheme": u.scheme,
        "netloc": u.netloc,
        "query": dict(qp),
        "auth": h.get("authorization"),
    }
''',
                "cases": [
                    ("api", ["https://api.service.io:8443/v2/items?sort=asc", {"page": "3"}, [["Authorization", "Bearer tok1"], ["X-Env", "prod"]]]),
                    ("local", ["http://localhost:8000/search?q=test", {"limit": "20"}, [["Host", "localhost"]]]),
                ],
            },
        ],
    },
    {
        "repo": "falconry/falcon",
        "license": "Apache-2.0",
        "domain": "url-http",
        "package": "falcon",
        "api_probes": [
            {
                "name": "uri_router",
                "code": '''"""Cross-file probe exercising `falcon` URI helpers and compiled router."""
from falcon.uri import parse_query_string, encode_value
from falcon.routing import CompiledRouter

def run(route_pat: str, path: str, qs: str) -> dict:
    router = CompiledRouter()
    router.add_route(route_pat, {"handler": "item_res"})
    found = router.find(path)
    params = found[2] if found else None
    parsed_qs = parse_query_string(qs)
    return {"matched": found is not None, "params": params, "query": parsed_qs, "enc": encode_value("a b/c")}
''',
                "cases": [
                    ("match", ["/v1/orgs/{org}/repos/{repo}", "/v1/orgs/acme/repos/core", "state=open&tag=a&tag=b"]),
                    ("miss", ["/v1/users/{uid:int}", "/v1/users/123", "verbose=true"]),
                ],
            },
        ],
    },
    {"repo": "gruns/furl", "license": "Unlicense", "domain": "url-http", "package": "furl"},
    {"repo": "gruns/orderedmultidict", "license": "Unlicense", "domain": "data-structures", "package": "orderedmultidict"},
    {"repo": "oauthlib/oauthlib", "license": "BSD-3-Clause", "domain": "url-http", "package": "oauthlib"},

    # --- Network / Packets ---
    {
        "repo": "drkjam/netaddr",
        "license": "BSD-3-Clause",
        "domain": "network",
        "package": "netaddr",
        "api_probes": [
            {
                "name": "cidr_subnetting",
                "code": '''"""Cross-file probe exercising `netaddr` IPNetwork, IPSet CIDR merging, and EUI MAC formatting."""
from netaddr import IPNetwork, IPSet, EUI, mac_unix_expanded

def run(cidrs: list[str], target_ip: str, mac_str: str) -> dict:
    ipset = IPSet(cidrs)
    merged = [str(c) for c in ipset.iter_cidrs()]
    net = IPNetwork(cidrs[0])
    mac = EUI(mac_str, dialect=mac_unix_expanded)
    return {
        "merged_cidrs": merged,
        "total_ips": len(ipset),
        "contains": target_ip in ipset,
        "broadcast": str(net.broadcast),
        "mac": str(mac),
    }
''',
                "cases": [
                    ("merge", [["192.168.0.0/24", "192.168.1.0/24"], "192.168.1.42", "00-1B-77-49-54-FD"]),
                    ("subnet", [["10.0.0.0/26", "10.0.0.64/26", "10.0.1.0/28"], "10.0.0.100", "aa:bb:cc:11:22:33"]),
                ],
            },
        ],
    },
    {
        "repo": "kbandla/dpkt",
        "license": "BSD-3-Clause",
        "domain": "network",
        "package": "dpkt",
        "api_probes": [
            {
                "name": "packet_roundtrip",
                "code": '''"""Cross-file probe exercising `dpkt` Ethernet + IP + UDP + DNS binary packet pack/unpack."""
import dpkt

def run(src_ip: list[int], dst_ip: list[int], qname: str) -> dict:
    dns = dpkt.dns.DNS(id=0x1234, qd=[dpkt.dns.DNS.Q(name=qname, type=dpkt.dns.DNS_A)])
    udp = dpkt.udp.UDP(sport=53000, dport=53, data=bytes(dns))
    udp.ulen = len(udp)
    ip = dpkt.ip.IP(src=bytes(src_ip), dst=bytes(dst_ip), p=dpkt.ip.IP_PROTO_UDP, data=udp)
    ip.len = len(ip)
    raw = bytes(ip)
    parsed_ip = dpkt.ip.IP(raw)
    parsed_dns = dpkt.dns.DNS(parsed_ip.data.data)
    return {
        "bytes": len(raw),
        "proto": parsed_ip.p,
        "dport": parsed_ip.data.dport,
        "dns_id": parsed_dns.id,
        "qname": parsed_dns.qd[0].name,
    }
''',
                "cases": [
                    ("dns1", [[10, 0, 0, 2], [8, 8, 8, 8], "api.example.org"]),
                    ("dns2", [[192, 168, 1, 5], [1, 1, 1, 1], "service.internal"]),
                ],
            },
        ],
    },

    # --- Validators / Schemas / Serializers ---
    {
        "repo": "pyeve/cerberus",
        "license": "ISC",
        "domain": "validation",
        "package": "cerberus",
        "api_probes": [
            {
                "name": "schema_validate",
                "code": '''"""Cross-file probe exercising `cerberus` schema validation, defaults, and normalization."""
from cerberus import Validator

def run(schema: dict, document: dict) -> dict:
    v = Validator(schema)
    ok = v.validate(document)
    return {"valid": ok, "normalized": v.normalized(document), "errors": v.errors}
''',
                "cases": [
                    ("ok", [{"name": {"type": "string", "minlength": 2}, "age": {"type": "integer", "min": 0}, "role": {"type": "string", "default": "user"}}, {"name": "Ada", "age": 36}]),
                    ("err", [{"name": {"type": "string", "required": True}, "score": {"type": "integer", "max": 100}}, {"name": "Bob", "score": 150}]),
                ],
            },
        ],
    },
    {
        "repo": "alecthomas/voluptuous",
        "license": "BSD-3-Clause",
        "domain": "validation",
        "package": "voluptuous",
        "api_probes": [
            {
                "name": "coerce_validate",
                "code": '''"""Cross-file probe exercising `voluptuous` schema validation, coercion, and error reporting."""
from voluptuous import Schema, Required, Optional, All, Range, Coerce, MultipleInvalid

def run(payload: dict) -> dict:
    s = Schema({
        Required("host"): str,
        Required("port"): All(Coerce(int), Range(min=1, max=65535)),
        Optional("retries", default=3): All(int, Range(min=0, max=10)),
    })
    try:
        cleaned = s(payload)
        return {"ok": True, "data": cleaned}
    except MultipleInvalid as exc:
        return {"ok": False, "errors": [str(e) for e in exc.errors]}
''',
                "cases": [
                    ("valid", [{"host": "db.internal", "port": "5432"}]),
                    ("invalid", [{"host": "db.internal", "port": "99999", "retries": 20}]),
                ],
            },
        ],
    },
    {
        "repo": "marshmallow-code/marshmallow",
        "license": "MIT",
        "domain": "validation",
        "package": "marshmallow",
        "api_probes": [
            {
                "name": "load_dump",
                "code": '''"""Cross-file probe exercising `marshmallow` nested schema loading, validation, and dumping."""
from marshmallow import Schema, fields, validate, ValidationError

class ItemSchema(Schema):
    sku = fields.Str(required=True)
    qty = fields.Int(required=True, validate=validate.Range(min=1))
    price = fields.Float(required=True)

class OrderSchema(Schema):
    order_id = fields.Str(required=True)
    items = fields.List(fields.Nested(ItemSchema), required=True)

def run(raw: dict) -> dict:
    schema = OrderSchema()
    try:
        loaded = schema.load(raw)
        total = round(sum(i["qty"] * i["price"] for i in loaded["items"]), 2)
        return {"ok": True, "dumped": schema.dump(loaded), "total": total}
    except ValidationError as err:
        return {"ok": False, "messages": err.messages}
''',
                "cases": [
                    ("valid", [{"order_id": "ORD-9", "items": [{"sku": "A1", "qty": 2, "price": 12.5}, {"sku": "B2", "qty": 1, "price": 8.0}]}]),
                    ("bad_qty", [{"order_id": "ORD-10", "items": [{"sku": "A1", "qty": 0, "price": 5.0}]}]),
                ],
            },
        ],
    },
    {
        "repo": "konradhalas/dacite",
        "license": "MIT",
        "domain": "validation",
        "package": "dacite",
        "api_probes": [
            {
                "name": "from_dict_nested",
                "code": '''"""Cross-file probe exercising `dacite` typed dataclass hydration."""
from dataclasses import dataclass, asdict
from typing import Optional
from dacite import from_dict, Config

@dataclass
class Endpoint:
    host: str
    port: int
    tls: bool = True

@dataclass
class ServiceCfg:
    name: str
    endpoints: list[Endpoint]
    tag: Optional[str] = None

def run(raw: dict) -> dict:
    cfg = from_dict(data_class=ServiceCfg, data=raw, config=Config(cast=[int]))
    return asdict(cfg)
''',
                "cases": [
                    ("cfg1", [{"name": "auth", "endpoints": [{"host": "a.local", "port": "443"}, {"host": "b.local", "port": 8443, "tls": False}], "tag": "v2"}]),
                    ("cfg2", [{"name": "edge", "endpoints": [{"host": "e1", "port": 80, "tls": False}]}]),
                ],
            },
        ],
    },
    {
        "repo": "python-validators/validators",
        "license": "MIT",
        "domain": "validation",
        "package": "validators",
        "api_probes": [
            {
                "name": "multi_validate",
                "code": '''"""Cross-file probe exercising `validators` domain, email, IPv4, URL, and UUID validators."""
import validators

def run(email: str, domain: str, ip: str, uid: str) -> dict:
    return {
        "email": bool(validators.email(email)),
        "domain": bool(validators.domain(domain)),
        "ipv4": bool(validators.ipv4(ip)),
        "uuid": bool(validators.uuid(uid)),
    }
''',
                "cases": [
                    ("good", ["ops@example.com", "sub.example.org", "192.168.10.1", "12345678-1234-5678-1234-567812345678"]),
                    ("mixed", ["bad@@mail", "not_a_domain", "999.1.2.3", "not-a-uuid"]),
                ],
            },
        ],
    },
    {
        "repo": "encode/typesystem",
        "license": "BSD-3-Clause",
        "domain": "validation",
        "package": "typesystem",
        "api_probes": [
            {
                "name": "schema_tokens",
                "code": '''"""Cross-file probe exercising `typesystem` JSON tokenization and Schema validation."""
import typesystem

class Job(typesystem.Schema):
    name = typesystem.String(max_length=32)
    priority = typesystem.Integer(minimum=1, maximum=10)
    enabled = typesystem.Boolean(default=True)

def run(json_str: str) -> dict:
    val, err = typesystem.validate_json(json_str, validator=Job)
    if err is not None:
        return {"ok": False, "errors": dict(err)}
    return {"ok": True, "job": dict(val)}
''',
                "cases": [
                    ("ok", ['{"name": "nightly-sync", "priority": 5}']),
                    ("err", ['{"name": "bad", "priority": 99}']),
                ],
            },
        ],
    },
    {"repo": "pallets-eco/wtforms", "license": "BSD-3-Clause", "domain": "validation", "package": "wtforms"},
    {
        "repo": "marshmallow-code/apispec",
        "license": "MIT",
        "domain": "validation",
        "package": "apispec",
        "api_probes": [
            {
                "name": "openapi_spec",
                "code": '''"""Cross-file probe exercising `apispec` OpenAPI 3.0 spec builder."""
from apispec import APISpec

def run(title: str, version: str, route: str, summary: str) -> dict:
    spec = APISpec(title=title, version=version, openapi_version="3.0.2")
    spec.components.schema("Item", {"type": "object", "properties": {"id": {"type": "integer"}, "name": {"type": "string"}}})
    spec.path(path=route, operations={"get": {"summary": summary, "responses": {"200": {"description": "OK"}}}})
    return spec.to_dict()
''',
                "cases": [
                    ("pet", ["Inventory API", "1.2.0", "/items/{id}", "Fetch item"]),
                    ("usr", ["Auth API", "2.0.1", "/users", "List users"]),
                ],
            },
        ],
    },
    {
        "repo": "python-jsonschema/referencing",
        "license": "MIT",
        "domain": "validation",
        "package": "referencing",
        "api_probes": [
            {
                "name": "schema_registry",
                "code": '''"""Cross-file probe exercising `referencing` JSON Schema URI Registry and $ref resolution."""
from referencing import Registry, Resource

def run(base_uri: str, ref: str, schema: dict) -> dict:
    res = Resource.from_contents(schema)
    reg = Registry().with_resource(uri=base_uri, resource=res)
    resolved = reg.resolver(base_uri).lookup(ref)
    return {"contents": resolved.contents}
''',
                "cases": [
                    ("defs", ["urn:example:root", "#/$defs/port", {"$schema": "https://json-schema.org/draft/2020-12/schema", "$defs": {"port": {"type": "integer", "minimum": 1, "maximum": 65535}}}]),
                    ("nested", ["urn:example:cfg", "#/$defs/host", {"$schema": "https://json-schema.org/draft/2020-12/schema", "$defs": {"host": {"type": "string", "minLength": 1}}}]),
                ],
            },
        ],
    },

    # --- Data Structures / Trees / Tries / Persistent / Caches / Functional ---
    {
        "repo": "grantjenks/python-sortedcontainers",
        "license": "Apache-2.0",
        "domain": "data-structures",
        "package": "sortedcontainers",
        "api_probes": [
            {
                "name": "sorted_ops",
                "code": '''"""Cross-file probe exercising `sortedcontainers` SortedList, SortedDict, and SortedSet."""
from sortedcontainers import SortedList, SortedDict, SortedSet

def run(nums: list[int], pairs: list[list], lo: int, hi: int) -> dict:
    sl = SortedList(nums)
    sl.add(lo)
    sl.discard(hi)
    sd = SortedDict({k: v for k, v in pairs})
    ss = SortedSet(nums)
    return {
        "slice": list(sl.irange(lo, hi)),
        "bisect_left": sl.bisect_left(lo),
        "keys": list(sd.keys()),
        "vals": list(sd.values()),
        "unique_count": len(ss),
    }
''',
                "cases": [
                    ("ints", [[9, 2, 7, 4, 2, 11, 6], [["z", 1], ["a", 9], ["m", 5]], 3, 9]),
                    ("neg", [[15, -3, 0, 8, 8, 4], [["k2", 20], ["k1", 10]], 0, 10]),
                ],
            },
        ],
    },
    {
        "repo": "tkem/cachetools",
        "license": "MIT",
        "domain": "data-structures",
        "package": "cachetools",
        "api_probes": [
            {
                "name": "lru_lfu",
                "code": '''"""Cross-file probe exercising `cachetools` LRUCache and LFUCache eviction policies."""
from cachetools import LRUCache, LFUCache

def run(capacity: int, ops: list[list]) -> dict:
    lru = LRUCache(maxsize=capacity)
    lfu = LFUCache(maxsize=capacity)
    lru_hits = 0
    lfu_hits = 0
    for op, k, v in ops:
        if op == "set":
            lru[k] = v
            lfu[k] = v
        elif op == "get":
            if k in lru:
                _ = lru[k]
                lru_hits += 1
            if k in lfu:
                _ = lfu[k]
                lfu_hits += 1
    return {
        "lru_keys": list(lru.keys()),
        "lfu_keys": sorted(lfu.keys()),
        "lru_hits": lru_hits,
        "lfu_hits": lfu_hits,
    }
''',
                "cases": [
                    ("cap3", [3, [["set", "a", 1], ["set", "b", 2], ["get", "a", 0], ["get", "a", 0], ["set", "c", 3], ["set", "d", 4], ["get", "b", 0], ["get", "a", 0]]]),
                    ("cap2", [2, [["set", "x", 10], ["set", "y", 20], ["get", "x", 0], ["set", "z", 30], ["get", "y", 0], ["get", "z", 0]]]),
                ],
            },
        ],
    },
    {
        "repo": "c0fec0de/anytree",
        "license": "Apache-2.0",
        "domain": "data-structures",
        "package": "anytree",
        "api_probes": [
            {
                "name": "tree_walk_render",
                "code": '''"""Cross-file probe exercising `anytree` tree construction, Resolver, Walker, and RenderTree."""
from anytree import Node, RenderTree, Resolver, Walker

def run(edges: list[list[str]], src: str, dst: str) -> dict:
    nodes = {}
    root = None
    for parent_name, child_name in edges:
        if parent_name not in nodes:
            nodes[parent_name] = Node(parent_name)
            if root is None:
                root = nodes[parent_name]
        nodes[child_name] = Node(child_name, parent=nodes[parent_name])
    r = Resolver("name")
    w = Walker()
    up, common, down = w.walk(nodes[src], nodes[dst])
    rendered = [f"{pre}{node.name}" for pre, _, node in RenderTree(root)]
    return {
        "up": [n.name for n in up],
        "common": common.name,
        "down": [n.name for n in down],
        "resolved": r.get(root, "/".join(n.name for n in nodes[dst].path[1:])).name,
        "lines": rendered,
    }
''',
                "cases": [
                    ("org", [[["root", "eng"], ["root", "ops"], ["eng", "backend"], ["eng", "ml"], ["ops", "sre"]], "ml", "sre"]),
                    ("fs", [[["/", "etc"], ["/", "var"], ["var", "log"], ["var", "cache"]], "log", "etc"]),
                ],
            },
        ],
    },
    {
        "repo": "caesar0301/treelib",
        "license": "Apache-2.0",
        "domain": "data-structures",
        "package": "treelib",
        "api_probes": [
            {
                "name": "tree_ops",
                "code": '''"""Cross-file probe exercising `treelib` Tree creation, traversal, and subtree extraction."""
from treelib import Tree

def run(nodes: list[list], sub_id: str) -> dict:
    t = Tree()
    for tag, nid, parent in nodes:
        t.create_node(tag, nid, parent=parent)
    leaves = sorted(n.identifier for n in t.leaves())
    sub = t.subtree(sub_id)
    return {
        "depth": t.depth(),
        "size": t.size(),
        "leaves": leaves,
        "subtree_nodes": sorted(sub.nodes.keys()),
    }
''',
                "cases": [
                    ("hier", [[["Root", "r", None], ["A", "a", "r"], ["B", "b", "r"], ["A1", "a1", "a"], ["A2", "a2", "a"]], "a"]),
                    ("deep", [[["Top", "t", None], ["M1", "m1", "t"], ["M2", "m2", "m1"], ["L1", "l1", "m2"]], "m1"]),
                ],
            },
        ],
    },
    {
        "repo": "google/pygtrie",
        "license": "Apache-2.0",
        "domain": "data-structures",
        "package": "pygtrie",
        "api_probes": [
            {
                "name": "string_trie",
                "code": '''"""Cross-file probe exercising `pygtrie` StringTrie prefix routing."""
import pygtrie

def run(routes: list[list], queries: list[str]) -> dict:
    t = pygtrie.StringTrie(separator="/")
    for path, handler in routes:
        t[path] = handler
    matches = []
    for q in queries:
        step = t.longest_prefix(q)
        matches.append({"query": q, "prefix": step.key, "handler": step.value})
    return {"matches": matches, "api_keys": sorted(t.keys(prefix="api"))}
''',
                "cases": [
                    ("routes", [[["api", "root"], ["api/v1/users", "users_v1"], ["api/v2/users", "users_v2"]], ["api/v1/users/42", "api/v3/other"]]),
                    ("files", [[["etc", "cfg"], ["etc/nginx/sites", "nginx"], ["var/log", "logs"]], ["etc/nginx/sites/default", "var/log/app.log"]]),
                ],
            },
        ],
    },
    {
        "repo": "vi3k6i5/flashtext",
        "license": "MIT",
        "domain": "text-nlp",
        "package": "flashtext",
        "api_probes": [
            {
                "name": "keyword_proc",
                "code": '''"""Cross-file probe exercising `flashtext` KeywordProcessor trie extraction and replacement."""
from flashtext import KeywordProcessor

def run(mapping: dict[str, list[str]], text: str) -> dict:
    kp = KeywordProcessor(case_sensitive=False)
    kp.add_keywords_from_dict(mapping)
    found = kp.extract_keywords(text, span_info=True)
    replaced = kp.replace_keywords(text)
    return {"found": [list(x) for x in found], "replaced": replaced}
''',
                "cases": [
                    ("tech", [{"Python": ["py", "python3"], "JavaScript": ["js", "ecmascript"]}, "We migrated from JS and py to python3!"]),
                    ("cities", [{"New York": ["NYC", "Big Apple"], "San Francisco": ["SF"]}, "Flight from NYC to SF via Big Apple."]),
                ],
            },
        ],
    },
    {
        "repo": "tobgu/pyrsistent",
        "license": "MIT",
        "domain": "data-structures",
        "package": "pyrsistent",
        "api_probes": [
            {
                "name": "immutable_structures",
                "code": '''"""Cross-file probe exercising `pyrsistent` persistent PMap, PVector, and transform."""
from pyrsistent import freeze, thaw

def run(initial: dict, bump: int) -> dict:
    p1 = freeze(initial)
    p2 = p1.transform(["stats", "count"], lambda x: x + bump)
    p3 = p2.transform(["tags"], lambda v: v.append("verified"))
    return {"orig": thaw(p1), "updated": thaw(p3), "same_orig": p1["stats"]["count"] == initial["stats"]["count"]}
''',
                "cases": [
                    ("tr1", [{"name": "job1", "stats": {"count": 10}, "tags": ["a", "b"]}, 5]),
                    ("tr2", [{"name": "job2", "stats": {"count": 0}, "tags": []}, 12]),
                ],
            },
        ],
    },
    {
        "repo": "mahmoud/boltons",
        "license": "BSD-3-Clause",
        "domain": "data-structures",
        "package": "boltons",
        "api_probes": [
            {
                "name": "iter_dict_str",
                "code": '''"""Cross-file probe exercising `boltons` iterutils, dictutils, strutils, and setutils."""
from boltons import iterutils, dictutils, strutils

def run(nested: dict, items: list[int], title: str) -> dict:
    omd = dictutils.OrderedMultiDict([("a", 1), ("b", 2), ("a", 3)])
    chunks = iterutils.chunked(items, 3)
    remapped = iterutils.remap(nested, visit=lambda p, k, v: (k, v * 2 if isinstance(v, int) else v))
    return {
        "a_all": omd.getlist("a"),
        "chunks": chunks,
        "remapped": remapped,
        "slug": strutils.slugify(title),
        "camel": strutils.under2camel("parse_http_header"),
    }
''',
                "cases": [
                    ("demo1", [{"x": 2, "inner": {"y": 5, "s": "ok"}}, [1, 2, 3, 4, 5, 6, 7], "Hello, World 2026!"]),
                    ("demo2", [{"k": [1, 3, 5]}, [10, 20, 30, 40], "Fast & Clean API"]),
                ],
            },
        ],
    },
    {
        "repo": "mahmoud/glom",
        "license": "BSD-3-Clause",
        "domain": "data-structures",
        "package": "glom",
        "api_probes": [
            {
                "name": "nested_transform",
                "code": '''"""Cross-file probe exercising `glom` declarative nested data extraction and transformation."""
from glom import glom, Coalesce, T

def run(payload: dict) -> dict:
    spec = {
        "org": "meta.org",
        "names": ("members", ["name"]),
        "total_score": ("members", ["score"], sum),
        "region": Coalesce("meta.region", default="global"),
    }
    return glom(payload, spec)
''',
                "cases": [
                    ("team1", [{"meta": {"org": "acme", "region": "eu"}, "members": [{"name": "a", "score": 10}, {"name": "b", "score": 25}]}]),
                    ("team2", [{"meta": {"org": "beta"}, "members": [{"name": "x", "score": 4}, {"name": "y", "score": 9}, {"name": "z", "score": 7}]}]),
                ],
            },
        ],
    },
    {
        "repo": "pytoolz/toolz",
        "license": "BSD-3-Clause",
        "domain": "functional",
        "package": "toolz",
        "api_probes": [
            {
                "name": "pipelines",
                "code": '''"""Cross-file probe exercising `toolz` itertoolz, dicttoolz, and functoolz pipelines."""
import toolz

def run(records: list[dict], window: int) -> dict:
    grouped = toolz.groupby("dept", records)
    totals = toolz.valmap(lambda rows: sum(r["val"] for r in rows), grouped)
    vals = [r["val"] for r in records]
    wins = [list(w) for w in toolz.sliding_window(window, vals)]
    freqs = dict(sorted(toolz.frequencies(r["dept"] for r in records).items()))
    return {"totals": dict(sorted(totals.items())), "windows": wins, "freqs": freqs}
''',
                "cases": [
                    ("dept", [[{"dept": "eng", "val": 10}, {"dept": "ops", "val": 5}, {"dept": "eng", "val": 15}, {"dept": "ops", "val": 8}], 2]),
                    ("win3", [[{"dept": "a", "val": 1}, {"dept": "b", "val": 2}, {"dept": "a", "val": 3}, {"dept": "c", "val": 4}, {"dept": "b", "val": 5}], 3]),
                ],
            },
        ],
    },
    {
        "repo": "Suor/funcy",
        "license": "BSD-3-Clause",
        "domain": "functional",
        "package": "funcy",
        "api_probes": [
            {
                "name": "colls_seqs",
                "code": '''"""Cross-file probe exercising `funcy` sequence, collection, and tree helpers."""
import funcy

def run(nums: list[int], nested: list, cfg_a: dict, cfg_b: dict) -> dict:
    evens, odds = funcy.lsplit(lambda x: x % 2 == 0, nums)
    flat = list(funcy.flatten(nested))
    merged = funcy.join_with(sum, cfg_a, cfg_b)
    return {
        "evens": evens,
        "odds": odds,
        "flat": flat,
        "merged": dict(sorted(merged.items())),
        "chunks": list(funcy.chunks(2, nums)),
    }
''',
                "cases": [
                    ("c1", [[1, 2, 3, 4, 5, 6], [1, [2, [3, 4]], 5], {"a": 10, "b": 2}, {"b": 8, "c": 5}]),
                    ("c2", [[7, 8, 9, 10], [[10, 20], [30]], {"x": 1}, {"x": 4, "y": 2}]),
                ],
            },
        ],
    },
    {
        "repo": "more-itertools/more-itertools",
        "license": "MIT",
        "domain": "functional",
        "package": "more_itertools",
        "api_probes": [
            {
                "name": "recipes_more",
                "code": '''"""Cross-file probe exercising `more_itertools` windowing, grouping, and run-length helpers."""
import more_itertools as mit

def run(seq: list[int], text: str) -> dict:
    rle = [[k, v] for k, v in mit.run_length.encode(text)]
    b = mit.bucket(seq, key=lambda x: "even" if x % 2 == 0 else "odd")
    return {
        "rle": rle,
        "even": list(b["even"]),
        "odd": list(b["odd"]),
        "windowed": [list(w) for w in mit.windowed(seq, 3)],
        "distinct": list(mit.unique_everseen(seq)),
    }
''',
                "cases": [
                    ("seq1", [[3, 1, 4, 1, 5, 9, 2], "aaabbcdddd"]),
                    ("seq2", [[10, 20, 10, 31, 42, 31], "xxxyyyz"]),
                ],
            },
        ],
    },
    {"repo": "cdgriffith/Box", "license": "MIT", "domain": "data-structures", "package": "box"},
    {"repo": "pallets/blinker", "license": "MIT", "domain": "data-structures", "package": "blinker"},
    {
        "repo": "pallets/cachelib",
        "license": "BSD-3-Clause",
        "domain": "data-structures",
        "package": "cachelib",
        "api_probes": [
            {
                "name": "simple_cache",
                "code": '''"""Cross-file probe exercising `cachelib.simple` SimpleCache operations."""
from cachelib.simple import SimpleCache

def run(threshold: int, ops: list[list]) -> dict:
    c = SimpleCache(threshold=threshold, default_timeout=0)
    out = []
    for op, k, v in ops:
        if op == "set":
            out.append(c.set(k, v))
        elif op == "get":
            out.append(c.get(k))
        elif op == "inc":
            out.append(c.inc(k, v))
        elif op == "has":
            out.append(c.has(k))
        elif op == "del":
            out.append(c.delete(k))
    return {"results": out, "remaining": sorted(c._cache.keys())}
''',
                "cases": [
                    ("ops1", [10, [["set", "hits", 1], ["inc", "hits", 4], ["get", "hits", 0], ["set", "mode", "fast"], ["has", "mode", 0], ["del", "mode", 0]]]),
                    ("ops2", [5, [["set", "a", 10], ["set", "b", 20], ["inc", "a", 5], ["get", "a", 0], ["get", "missing", 0]]]),
                ],
            },
        ],
    },

    # --- Diff / Fuzzy / Text / Humanize / Inflect / Slugify ---
    {
        "repo": "seperman/deepdiff",
        "license": "MIT",
        "domain": "diff-text",
        "package": "deepdiff",
        "api_probes": [
            {
                "name": "diff_dicts",
                "code": '''"""Cross-file probe exercising `deepdiff` DeepDiff structural comparison."""
from deepdiff import DeepDiff

def run(before: dict, after: dict) -> dict:
    diff = DeepDiff(before, after, ignore_order=False)
    out = {}
    for k, v in diff.items():
        if isinstance(v, dict):
            out[k] = {str(dk): dv for dk, dv in sorted(v.items())}
        else:
            out[k] = sorted(str(x) for x in v)
    return out
''',
                "cases": [
                    ("cfg_diff", [{"port": 8080, "tags": ["a", "b"], "db": {"pool": 5}}, {"port": 9090, "tags": ["a", "c"], "db": {"pool": 10, "ssl": True}}]),
                    ("rem_add", [{"a": 1, "b": 2}, {"a": 1, "c": 3}]),
                ],
            },
        ],
    },
    {
        "repo": "life4/textdistance",
        "license": "MIT",
        "domain": "diff-text",
        "package": "textdistance",
        "api_probes": [
            {
                "name": "edit_token_metrics",
                "code": '''"""Cross-file probe exercising `textdistance` edit, token, and sequence distance algorithms."""
import textdistance

def run(a: str, b: str) -> dict:
    return {
        "levenshtein": textdistance.levenshtein.distance(a, b),
        "damerau": textdistance.damerau_levenshtein.distance(a, b),
        "jaro_winkler": round(textdistance.jaro_winkler.similarity(a, b), 4),
        "jaccard": round(textdistance.jaccard.similarity(a.split(), b.split()), 4),
        "lcsstr": textdistance.lcsstr(a, b),
    }
''',
                "cases": [
                    ("words", ["kitten sitting", "kitchen setting"]),
                    ("transp", ["algorithm design", "algortihm design"]),
                ],
            },
        ],
    },
    {
        "repo": "python-humanize/humanize",
        "license": "MIT",
        "domain": "diff-text",
        "package": "humanize",
        "api_probes": [
            {
                "name": "humanize_all",
                "code": '''"""Cross-file probe exercising `humanize` number, filesize, and duration formatters."""
import datetime as dt
import humanize

def run(nbytes: int, seconds: int, count: int) -> dict:
    return {
        "size_bin": humanize.naturalsize(nbytes, binary=True),
        "size_dec": humanize.naturalsize(nbytes, binary=False),
        "delta": humanize.precisedelta(dt.timedelta(seconds=seconds)),
        "intword": humanize.intword(count),
        "ordinal": humanize.ordinal(count % 100),
    }
''',
                "cases": [
                    ("med", [15_728_640, 9015, 2_500_000]),
                    ("small", [2048, 3661, 42]),
                ],
            },
        ],
    },
    {
        "repo": "jaraco/inflect",
        "license": "MIT",
        "domain": "diff-text",
        "package": "inflect",
        "api_probes": [
            {
                "name": "english_inflect",
                "code": '''"""Cross-file probe exercising `inflect` English pluralization, ordinals, and number-to-words."""
import inflect

def run(nouns: list[str], number: int) -> dict:
    e = inflect.engine()
    return {
        "plurals": [e.plural(n) for n in nouns],
        "articles": [e.a(n) for n in nouns],
        "words": e.number_to_words(number),
        "ordinal": e.ordinal(number),
        "joined": e.join(nouns),
    }
''',
                "cases": [
                    ("n1", [["child", "octopus", "index", "box"], 42]),
                    ("n2", [["knife", "hero", "analysis"], 103]),
                ],
            },
        ],
    },
    {"repo": "un33k/python-slugify", "license": "MIT", "domain": "diff-text", "package": "slugify"},
    {"repo": "scrapinghub/price-parser", "license": "BSD-3-Clause", "domain": "diff-text", "package": "price_parser"},
    {"repo": "scrapinghub/number-parser", "license": "BSD-3-Clause", "domain": "diff-text", "package": "number_parser"},
    {"repo": "jquast/wcwidth", "license": "MIT", "domain": "diff-text", "package": "wcwidth"},

    # --- Date / Time / Cron / Calendar ---
    {
        "repo": "kiorky/croniter",
        "license": "MIT",
        "domain": "date-time",
        "package": "croniter",
        "api_probes": [
            {
                "name": "cron_schedule",
                "code": '''"""Cross-file probe exercising `croniter` cron schedule iteration."""
from datetime import datetime
from croniter import croniter

def run(expr: str, start_iso: str, n: int) -> list[str]:
    base = datetime.fromisoformat(start_iso)
    it = croniter(expr, base)
    return [it.get_next(datetime).isoformat() for _ in range(n)]
''',
                "cases": [
                    ("quarter_hour", ["*/15 9-11 * * 1-5", "2026-06-01T08:50:00", 5]),
                    ("monthly", ["30 6 1,15 * *", "2026-01-01T00:00:00", 4]),
                ],
            },
        ],
    },
    {
        "repo": "gweis/isodate",
        "license": "BSD-3-Clause",
        "domain": "date-time",
        "package": "isodate",
        "api_probes": [
            {
                "name": "iso8601_codec",
                "code": '''"""Cross-file probe exercising `isodate` ISO 8601 date, datetime, and duration parsing."""
import isodate

def run(dt_str: str, dur_str: str) -> dict:
    dt_val = isodate.parse_datetime(dt_str)
    dur = isodate.parse_duration(dur_str)
    shifted = dt_val + dur
    return {
        "parsed": isodate.datetime_isoformat(dt_val),
        "shifted": isodate.datetime_isoformat(shifted),
        "dur_iso": isodate.duration_isoformat(dur),
    }
''',
                "cases": [
                    ("dur1", ["2026-03-10T08:30:00Z", "P2DT4H15M"]),
                    ("dur2", ["2026-11-01T12:00:00+00:00", "P1W3DT2H"]),
                ],
            },
        ],
    },
    {
        "repo": "arrow-py/arrow",
        "license": "Apache-2.0",
        "domain": "date-time",
        "package": "arrow",
        "api_probes": [
            {
                "name": "parse_shift",
                "code": '''"""Cross-file probe exercising `arrow` timestamp parsing, shifting, and formatting."""
import arrow

def run(raw: str, fmt: str, days: int, hours: int) -> dict:
    a = arrow.get(raw, fmt)
    b = a.shift(days=days, hours=hours)
    return {
        "orig": a.format("YYYY-MM-DD HH:mm"),
        "shifted": b.format("YYYY-MM-DD HH:mm"),
        "span_start": b.floor("day").format("YYYY-MM-DD HH:mm"),
        "weekday": b.weekday(),
    }
''',
                "cases": [
                    ("s1", ["2026-05-14 09:30", "YYYY-MM-DD HH:mm", 10, 6]),
                    ("s2", ["2024-02-27 22:00", "YYYY-MM-DD HH:mm", 3, 5]),
                ],
            },
        ],
    },
    {
        "repo": "collective/icalendar",
        "license": "BSD-2-Clause",
        "domain": "date-time",
        "package": "icalendar",
        "api_probes": [
            {
                "name": "ical_roundtrip",
                "code": '''"""Cross-file probe exercising `icalendar` RFC 5545 VCALENDAR/VEVENT construction and parsing."""
from datetime import datetime, timezone
from icalendar import Calendar, Event

def run(summary: str, start_ymd: list[int], end_ymd: list[int]) -> dict:
    cal = Calendar()
    cal.add("prodid", "-//Demo//EN")
    cal.add("version", "2.0")
    ev = Event()
    ev.add("summary", summary)
    ev.add("dtstart", datetime(*start_ymd, tzinfo=timezone.utc))
    ev.add("dtend", datetime(*end_ymd, tzinfo=timezone.utc))
    cal.add_component(ev)
    raw = cal.to_ical()
    parsed = Calendar.from_ical(raw)
    events = [c for c in parsed.walk() if c.name == "VEVENT"]
    return {
        "summary": str(events[0].get("summary")),
        "start": events[0].decoded("dtstart").isoformat(),
        "end": events[0].decoded("dtend").isoformat(),
    }
''',
                "cases": [
                    ("standup", ["Team Sync", [2026, 6, 15, 14, 0], [2026, 6, 15, 14, 30]]),
                    ("launch", ["v2 Release", [2026, 9, 1, 9, 0], [2026, 9, 1, 11, 0]]),
                ],
            },
        ],
    },

    # --- Semver / Glob / Path / Packaging / Deps ---
    {
        "repo": "python-semver/python-semver",
        "license": "BSD-3-Clause",
        "domain": "semver-glob",
        "package": "semver",
        "api_probes": [
            {
                "name": "version_ops",
                "code": '''"""Cross-file probe exercising `semver` Version parsing, bumping, and matching."""
import semver

def run(versions: list[str], constraint: str) -> dict:
    parsed = sorted(semver.Version.parse(v) for v in versions)
    matched = [str(v) for v in parsed if v.match(constraint)]
    bumped = str(parsed[-1].bump_minor()) if parsed else None
    return {"sorted": [str(v) for v in parsed], "matched": matched, "next_minor": bumped}
''',
                "cases": [
                    ("v1", [["1.10.0", "1.2.3-alpha.1", "1.2.3", "2.0.0"], ">=1.2.3"]),
                    ("v2", [["0.9.1", "1.0.0", "1.5.2+build.7"], "<1.5.0"]),
                ],
            },
        ],
    },
    {
        "repo": "rbarrois/python-semanticversion",
        "license": "BSD-2-Clause",
        "domain": "semver-glob",
        "package": "semantic_version",
        "api_probes": [
            {
                "name": "npm_spec",
                "code": '''"""Cross-file probe exercising `semantic_version` NpmSpec and Version selection."""
import semantic_version as sv

def run(spec_expr: str, raw_versions: list[str]) -> dict:
    spec = sv.NpmSpec(spec_expr)
    vers = [sv.Version(v) for v in raw_versions]
    selected = sorted(spec.filter(vers))
    return {"matched": [str(v) for v in selected], "best": str(spec.select(vers)) if selected else None}
''',
                "cases": [
                    ("caret", ["^1.2.0", ["1.1.9", "1.2.0", "1.8.4", "2.0.0"]]),
                    ("tilde", ["~2.3.1 || >=3.0.0 <3.2.0", ["2.3.0", "2.3.5", "2.4.0", "3.1.2", "3.2.0"]]),
                ],
            },
        ],
    },
    {
        "repo": "cpburnz/python-pathspec",
        "license": "MPL-2.0",
        "domain": "semver-glob",
        "package": "pathspec",
        "api_probes": [
            {
                "name": "gitignore_match",
                "code": '''"""Cross-file probe exercising `pathspec` gitwildmatch pattern compilation and path filtering."""
import pathspec

def run(patterns: list[str], paths: list[str]) -> dict:
    spec = pathspec.PathSpec.from_lines("gitwildmatch", patterns)
    matched = sorted(spec.match_files(paths))
    kept = sorted(p for p in paths if not spec.match_file(p))
    return {"ignored": matched, "kept": kept}
''',
                "cases": [
                    ("py_ign", [["*.pyc", "__pycache__/", "build/", "!build/keep.txt"], ["src/app.py", "src/app.pyc", "build/out.bin", "build/keep.txt", "pkg/__pycache__/x.py"]]),
                    ("docs", [["docs/**/*.tmp", "*.log", "!important.log"], ["docs/a/b.tmp", "app.log", "important.log", "docs/index.md"]]),
                ],
            },
        ],
    },
    {
        "repo": "facelessuser/wcmatch",
        "license": "MIT",
        "domain": "semver-glob",
        "package": "wcmatch",
        "api_probes": [
            {
                "name": "fnmatch_ext",
                "code": '''"""Cross-file probe exercising `wcmatch.fnmatch` extended glob/brace/negation matching."""
from wcmatch import fnmatch

def run(patterns: list[str], candidates: list[str]) -> dict:
    flags = fnmatch.EXTMATCH | fnmatch.BRACE | fnmatch.NEGATE | fnmatch.GLOBSTAR
    matched = [c for c in candidates if fnmatch.fnmatch(c, patterns, flags=flags)]
    return {"matched": matched, "count": len(matched)}
''',
                "cases": [
                    ("brace", [["src/**/*.{py,ts}", "!**/test_*.py"], ["src/core/app.py", "src/core/test_app.py", "src/ui/view.ts", "README.md"]]),
                    ("ext", [["@(foo|bar)_*.json"], ["foo_1.json", "bar_cfg.json", "baz_2.json"]]),
                ],
            },
        ],
    },
    {
        "repo": "facelessuser/bracex",
        "license": "MIT",
        "domain": "semver-glob",
        "package": "bracex",
        "api_probes": [
            {
                "name": "expand_braces",
                "code": '''"""Cross-file probe exercising `bracex` Bash-style brace expansion."""
import bracex

def run(patterns: list[str]) -> list[list[str]]:
    return [list(bracex.iexpand(p)) for p in patterns]
''',
                "cases": [
                    ("seq", [["node-{01..04}.{east,west}", "img_{a..c}.png"]]),
                    ("nested", [["pkg/{core,util}/{a,b}.py", "v{1..5..2}"]]),
                ],
            },
        ],
    },
    {
        "repo": "sarugaku/resolvelib",
        "license": "ISC",
        "domain": "packaging-deps",
        "package": "resolvelib",
        "api_probes": [
            {
                "name": "dep_resolve",
                "code": '''"""Cross-file probe exercising `resolvelib` backtracking dependency resolution."""
from resolvelib import AbstractProvider, BaseReporter, Resolver

class SimpleProvider(AbstractProvider):
    def __init__(self, index):
        self.index = index
    def identify(self, requirement_or_candidate):
        return requirement_or_candidate[0]
    def get_preference(self, identifier, resolutions, candidates, information, backtrack_causes):
        return sum(1 for _ in candidates[identifier])
    def find_matches(self, identifier, requirements, incompatibilities):
        bad = set(incompatibilities[identifier])
        reqs = list(requirements[identifier])
        out = []
        for ver, _deps in sorted(self.index[identifier].items(), reverse=True):
            cand = (identifier, ver)
            if cand in bad:
                continue
            if all(lo <= ver <= hi for _, lo, hi in reqs):
                out.append(cand)
        return out
    def is_satisfied_by(self, requirement, candidate):
        _, lo, hi = requirement
        return lo <= candidate[1] <= hi
    def get_dependencies(self, candidate):
        name, ver = candidate
        return [tuple(r) for r in self.index[name][ver]]

def run(index: dict, root_reqs: list[list]) -> dict:
    # Convert string version keys to ints
    idx = {pkg: {int(v): deps for v, deps in vers.items()} for pkg, vers in index.items()}
    res = Resolver(SimpleProvider(idx), BaseReporter()).resolve([tuple(r) for r in root_reqs])
    return {k: v[1] for k, v in sorted(res.mapping.items())}
''',
                "cases": [
                    ("backtrack", [{"app": {"2": [["lib", 2, 2]], "1": [["lib", 1, 2]]}, "lib": {"2": [["core", 2, 2]], "1": [["core", 1, 1]]}, "core": {"1": []}}, [["app", 1, 2]]]),
                    ("diamond", [{"a": {"2": [["b", 1, 2], ["c", 1, 2]]}, "b": {"2": [["d", 2, 3]], "1": [["d", 1, 2]]}, "c": {"2": [["d", 1, 2]]}, "d": {"3": [], "2": [], "1": []}}, [["a", 1, 2]]]),
                ],
            },
        ],
    },
    {
        "repo": "pypa/distlib",
        "license": "PSF",
        "domain": "packaging-deps",
        "package": "distlib",
        "api_probes": [
            {
                "name": "version_markers",
                "code": '''"""Cross-file probe exercising `distlib` PEP 440 version matchers and environment markers."""
from distlib.version import NormalizedMatcher, NormalizedVersion
from distlib.markers import interpret

def run(matcher_spec: str, versions: list[str], marker: str, env: dict) -> dict:
    m = NormalizedMatcher(matcher_spec)
    matched = [v for v in versions if m.match(NormalizedVersion(v))]
    marker_ok = interpret(marker, env)
    return {"matched": matched, "marker_ok": marker_ok}
''',
                "cases": [
                    ("pep440", ["foo (>=1.2, <2.0)", ["1.1", "1.2", "1.9.1", "2.0"], 'python_version >= "3.10" and os_name == "posix"', {"python_version": "3.12", "os_name": "posix"}]),
                    ("compat", ["bar (~=2.1.0)", ["2.0.9", "2.1.0", "2.1.4", "2.2.0"], 'sys_platform == "linux" or extra == "dev"', {"sys_platform": "darwin", "extra": "dev"}]),
                ],
            },
        ],
    },
    {"repo": "python-poetry/poetry-core", "license": "MIT", "domain": "packaging-deps", "package": "poetry"},
    {"repo": "pytest-dev/pluggy", "license": "MIT", "domain": "packaging-deps", "package": "pluggy"},

    # --- FSM / Retry / Rate-Limits / Logging ---
    {
        "repo": "pytransitions/transitions",
        "license": "MIT",
        "domain": "fsm-retry",
        "package": "transitions",
        "api_probes": [
            {
                "name": "order_fsm",
                "code": '''"""Cross-file probe exercising `transitions` finite state machine with guards & callbacks."""
from transitions import Machine

class OrderModel:
    def __init__(self, paid: bool):
        self.paid = paid
        self.log = []
    def is_paid(self):
        return self.paid
    def on_enter_shipped(self):
        self.log.append("notified-carrier")

def run(paid: bool, triggers: list[str]) -> dict:
    m = OrderModel(paid)
    transitions = [
        {"trigger": "validate", "source": "new", "dest": "validated"},
        {"trigger": "ship", "source": "validated", "dest": "shipped", "conditions": "is_paid"},
        {"trigger": "deliver", "source": "shipped", "dest": "delivered"},
        {"trigger": "cancel", "source": ["new", "validated"], "dest": "cancelled"},
    ]
    Machine(model=m, states=["new", "validated", "shipped", "delivered", "cancelled"], transitions=transitions, initial="new")
    results = []
    for trig in triggers:
        ok = getattr(m, trig)()
        results.append({"trigger": trig, "ok": ok, "state": m.state})
    return {"final": m.state, "results": results, "log": m.log}
''',
                "cases": [
                    ("paid_ok", [True, ["validate", "ship", "deliver"]]),
                    ("unpaid_cancel", [False, ["validate", "ship", "cancel"]]),
                ],
            },
        ],
    },
    {
        "repo": "alisaifee/limits",
        "license": "MIT",
        "domain": "fsm-retry",
        "package": "limits",
        "api_probes": [
            {
                "name": "rate_limit_parse",
                "code": '''"""Cross-file probe exercising `limits` rate limit item parsing and comparison."""
from limits import parse_many

def run(spec: str) -> list[dict]:
    items = parse_many(spec)
    return [
        {"amount": it.amount, "multiples": it.multiples, "granularity": it.GRANULARITY.name, "seconds": it.get_expiry()}
        for it in items
    ]
''',
                "cases": [
                    ("multi", ["10/second; 100 per 5 minutes; 5000/day"]),
                    ("burst", ["3 per 2 seconds, 60/hour"]),
                ],
            },
        ],
    },
    {"repo": "jd/tenacity", "license": "Apache-2.0", "domain": "fsm-retry", "package": "tenacity"},
    {"repo": "hynek/structlog", "license": "MIT", "domain": "fsm-retry", "package": "structlog"},

    # --- Binary Codecs / ASN.1 / CBOR / Structs / Barcode / QR ---
    {
        "repo": "construct/construct",
        "license": "MIT",
        "domain": "binary-codec",
        "package": "construct",
        "api_probes": [
            {
                "name": "binary_header",
                "code": '''"""Cross-file probe exercising `construct` declarative binary struct build and parse."""
from construct import Struct, Const, Int8ub, Int16ub, Bytes, this

FRAME = Struct(
    "magic" / Const(b"PK"),
    "version" / Int8ub,
    "flags" / Int8ub,
    "length" / Int16ub,
    "payload" / Bytes(this.length),
)

def run(version: int, flags: int, text: str) -> dict:
    payload = text.encode("utf-8")
    raw = FRAME.build({"version": version, "flags": flags, "length": len(payload), "payload": payload})
    parsed = FRAME.parse(raw)
    return {
        "hex": raw.hex(),
        "version": parsed.version,
        "flags": parsed.flags,
        "length": parsed.length,
        "text": parsed.payload.decode("utf-8"),
    }
''',
                "cases": [
                    ("f1", [2, 5, "hello-bin"]),
                    ("f2", [1, 128, "seq=42"]),
                ],
            },
        ],
    },
    {
        "repo": "scott-griffiths/bitstring",
        "license": "MIT",
        "domain": "binary-codec",
        "package": "bitstring",
        "api_probes": [
            {
                "name": "bit_pack_unpack",
                "code": '''"""Cross-file probe exercising `bitstring` bit-level packing, slicing, and unpacking."""
import bitstring

def run(ver: int, kind: int, length: int, crc: int) -> dict:
    bs = bitstring.pack("uint:4, uint:4, uint:12, uint:12", ver, kind, length, crc)
    u_ver, u_kind, u_len, u_crc = bs.unpack("uint:4, uint:4, uint:12, uint:12")
    return {
        "hex": bs.hex,
        "bin": bs.bin,
        "unpacked": [u_ver, u_kind, u_len, u_crc],
        "ones": bs.count(1),
    }
''',
                "cases": [
                    ("pkt1", [4, 9, 256, 0x3A5]),
                    ("pkt2", [6, 2, 1024, 0xFFF]),
                ],
            },
        ],
    },
    {
        "repo": "agronholm/cbor2",
        "license": "MIT",
        "domain": "binary-codec",
        "package": "cbor2",
        "api_probes": [
            {
                "name": "cbor_codec",
                "code": '''"""Cross-file probe exercising `cbor2` pure-Python CBOR binary encoding and decoding."""
from cbor2 import _encoder, _decoder

def run(payload: dict) -> dict:
    raw = _encoder.dumps(payload, canonical=True)
    decoded = _decoder.loads(raw)
    return {"hex": raw.hex(), "bytes": len(raw), "decoded": decoded, "equal": decoded == payload}
''',
                "cases": [
                    ("obj1", [{"id": 42, "tags": ["a", "b"], "ok": True, "score": -7}]),
                    ("obj2", [{"nested": {"k": [1, 2, 3]}, "empty": None}]),
                ],
            },
        ],
    },
    {
        "repo": "pyasn1/pyasn1",
        "license": "BSD-2-Clause",
        "domain": "binary-codec",
        "package": "pyasn1",
        "api_probes": [
            {
                "name": "asn1_der",
                "code": '''"""Cross-file probe exercising `pyasn1` ASN.1 schema definition and DER encode/decode."""
from pyasn1.type import univ, namedtype
from pyasn1.codec.der import encoder, decoder

class Record(univ.Sequence):
    componentType = namedtype.NamedTypes(
        namedtype.NamedType("id", univ.Integer()),
        namedtype.NamedType("name", univ.OctetString()),
        namedtype.NamedType("active", univ.Boolean()),
    )

def run(rec_id: int, name: str, active: bool) -> dict:
    r = Record()
    r["id"] = rec_id
    r["name"] = name.encode("utf-8")
    r["active"] = active
    der = encoder.encode(r)
    dec, rest = decoder.decode(der, asn1Spec=Record())
    return {
        "hex": der.hex(),
        "rest_len": len(rest),
        "id": int(dec["id"]),
        "name": bytes(dec["name"]).decode("utf-8"),
        "active": bool(dec["active"]),
    }
''',
                "cases": [
                    ("r1", [1001, "alpha-cert", True]),
                    ("r2", [7, "beta", False]),
                ],
            },
        ],
    },
    {
        "repo": "wbond/asn1crypto",
        "license": "MIT",
        "domain": "binary-codec",
        "package": "asn1crypto",
        "api_probes": [
            {
                "name": "asn1_core",
                "code": '''"""Cross-file probe exercising `asn1crypto.core` ASN.1 DER dump/load."""
from asn1crypto import core

class Msg(core.Sequence):
    _fields = [
        ("seq", core.Integer),
        ("label", core.UTF8String),
        ("flag", core.Boolean),
    ]

def run(seq: int, label: str, flag: bool) -> dict:
    m = Msg({"seq": seq, "label": label, "flag": flag})
    raw = m.dump()
    parsed = Msg.load(raw)
    return {"hex": raw.hex(), "native": parsed.native}
''',
                "cases": [
                    ("m1", [42, "hello-asn1", True]),
                    ("m2", [999, "node-07", False]),
                ],
            },
        ],
    },
    {
        "repo": "lincolnloop/python-qrcode",
        "license": "BSD-3-Clause",
        "domain": "barcode-qr",
        "package": "qrcode",
        "api_probes": [
            {
                "name": "qr_matrix",
                "code": '''"""Cross-file probe exercising `qrcode` Reed-Solomon encoding and QR matrix generation."""
import qrcode

def run(data: str, ec_level: str) -> dict:
    levels = {"L": qrcode.constants.ERROR_CORRECT_L, "M": qrcode.constants.ERROR_CORRECT_M, "Q": qrcode.constants.ERROR_CORRECT_Q}
    qr = qrcode.QRCode(version=1, error_correction=levels[ec_level], border=1)
    qr.add_data(data)
    qr.make(fit=True)
    mat = qr.get_matrix()
    dark = sum(1 for row in mat for cell in row if cell)
    return {"version": qr.version, "size": len(mat), "dark_modules": dark}
''',
                "cases": [
                    ("short", ["HELLO", "L"]),
                    ("url", ["EX.IO/1", "M"]),
                ],
            },
        ],
    },
    {
        "repo": "heuer/segno",
        "license": "BSD-3-Clause",
        "domain": "barcode-qr",
        "package": "segno",
        "api_probes": [
            {
                "name": "segno_qr",
                "code": '''"""Cross-file probe exercising `segno` QR code encoding and symbol metadata."""
import segno

def run(content: str, error: str) -> dict:
    qr = segno.make(content, error=error)
    rows = len(qr.matrix)
    ones = sum(sum(r) for r in qr.matrix)
    return {"version": qr.version, "error": qr.error, "mask": qr.mask, "size": rows, "dark": ones}
''',
                "cases": [
                    ("num", ["12345678", "L"]),
                    ("alnum", ["AB-42", "M"]),
                ],
            },
        ],
    },
    {
        "repo": "WhyNotHugo/python-barcode",
        "license": "MIT",
        "domain": "barcode-qr",
        "package": "barcode",
        "api_probes": [
            {
                "name": "ean_code128",
                "code": '''"""Cross-file probe exercising `barcode` EAN13 checksum and Code128 bit pattern generation."""
import barcode

def run(ean12: str, c128: str) -> dict:
    ean = barcode.get("ean13", ean12)
    code = barcode.get("code128", c128)
    return {
        "ean13_full": ean.get_fullcode(),
        "ean_bits_len": len(ean.build()[0]),
        "c128_bits_len": len(code.build()[0]),
    }
''',
                "cases": [
                    ("b1", ["590123412345", "AB-123"]),
                    ("b2", ["400638133393", "ITEM99"]),
                ],
            },
        ],
    },

    # --- Pure-Python Crypto / JWT / Signing / OTP ---
    {
        "repo": "pallets/itsdangerous",
        "license": "BSD-3-Clause",
        "domain": "crypto-auth",
        "package": "itsdangerous",
        "api_probes": [
            {
                "name": "sign_verify",
                "code": '''"""Cross-file probe exercising `itsdangerous` URLSafeSerializer HMAC signing & verification."""
from itsdangerous import URLSafeSerializer, BadSignature

def run(secret: str, salt: str, payload: dict, tamper: bool) -> dict:
    s = URLSafeSerializer(secret, salt=salt)
    token = s.dumps(payload)
    if tamper:
        token = token[:-1] + ("A" if token[-1] != "A" else "B")
    try:
        loaded = s.loads(token)
        return {"ok": True, "token_len": len(token), "loaded": loaded}
    except BadSignature:
        return {"ok": False, "token_len": len(token)}
''',
                "cases": [
                    ("valid", ["k-secret-1", "auth-v1", {"uid": 42, "role": "admin"}, False]),
                    ("tampered", ["k-secret-1", "auth-v1", {"uid": 42, "role": "admin"}, True]),
                ],
            },
        ],
    },
    {
        "repo": "jpadilla/pyjwt",
        "license": "MIT",
        "domain": "crypto-auth",
        "package": "jwt",
        "api_probes": [
            {
                "name": "hs256_jwt",
                "code": '''"""Cross-file probe exercising `jwt` HS256 token encoding, header inspection, and decoding."""
import jwt

def run(claims: dict, secret: str, alg: str) -> dict:
    tok = jwt.encode(claims, secret, algorithm=alg)
    hdr = jwt.get_unverified_header(tok)
    dec = jwt.decode(tok, secret, algorithms=[alg], options={"verify_exp": False})
    return {"header": hdr, "decoded": dec, "parts": len(tok.split("."))}
''',
                "cases": [
                    ("hs256", [{"sub": "u-100", "scope": "read"}, "super-secret-key-32bytes-long!!", "HS256"]),
                    ("hs384", [{"sub": "svc-2", "admin": True}, "another-long-hmac-secret-key-48bytes!!", "HS384"]),
                ],
            },
        ],
    },
    {
        "repo": "pyauth/pyotp",
        "license": "MIT",
        "domain": "crypto-auth",
        "package": "pyotp",
        "api_probes": [
            {
                "name": "totp_hotp",
                "code": '''"""Cross-file probe exercising `pyotp` deterministic TOTP/HOTP generation and URI building."""
import pyotp

def run(secret: str, timestamp: int, counter: int) -> dict:
    totp = pyotp.TOTP(secret)
    hotp = pyotp.HOTP(secret)
    t_code = totp.at(timestamp)
    h_code = hotp.at(counter)
    return {
        "totp": t_code,
        "totp_ok": totp.verify(t_code, for_time=timestamp),
        "hotp": h_code,
        "hotp_ok": hotp.verify(h_code, counter),
        "uri": totp.provisioning_uri(name="ada@ex.io", issuer_name="Demo"),
    }
''',
                "cases": [
                    ("c1", ["JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP", 1700000000, 5]),
                    ("c2", ["GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", 1750000123, 12]),
                ],
            },
        ],
    },
    {
        "repo": "sybrenstuvel/python-rsa",
        "license": "Apache-2.0",
        "domain": "crypto-auth",
        "package": "rsa",
        "api_probes": [
            {
                "name": "rsa_core_transform",
                "code": '''"""Cross-file probe exercising `rsa` pure-Python modular exponentiation, transform, and key math."""
from rsa import core, transform, key, common

def run(p: int, q: int, msg_text: str) -> dict:
    n = p * q
    phi = (p - 1) * (q - 1)
    e = 65537
    d = common.inverse(e, phi)
    pub = key.PublicKey(n, e)
    priv = key.PrivateKey(n, e, d, p, q)
    m_int = transform.bytes2int(msg_text.encode("utf-8"))
    cipher = core.encrypt_int(m_int, pub.e, pub.n)
    plain = core.decrypt_int(cipher, priv.d, priv.n)
    back = transform.int2bytes(plain).decode("utf-8")
    return {"bits": common.bit_size(n), "cipher_hex": hex(cipher), "roundtrip": back, "ok": back == msg_text}
''',
                "cases": [
                    ("k1", [1000000007, 1000000009, "hi"]),
                    ("k2", [1000000033, 1000000087, "rsa"]),
                ],
            },
        ],
    },
    {
        "repo": "warner/python-ecdsa",
        "license": "MIT",
        "domain": "crypto-auth",
        "package": "ecdsa",
        "api_probes": [
            {
                "name": "ecdsa_sign_verify",
                "code": '''"""Cross-file probe exercising `ecdsa` deterministic RFC 6979 NIST256p signing and verification."""
import hashlib
from ecdsa import SigningKey, NIST256p

def run(secret_exp: int, message: str) -> dict:
    sk = SigningKey.from_secret_exponent(secret_exp, curve=NIST256p, hashfunc=hashlib.sha256)
    vk = sk.get_verifying_key()
    sig = sk.sign_deterministic(message.encode("utf-8"), hashfunc=hashlib.sha256)
    ok = vk.verify(sig, message.encode("utf-8"), hashfunc=hashlib.sha256)
    return {"sig_len": len(sig), "sig_prefix": sig.hex()[:24], "verified": ok}
''',
                "cases": [
                    ("s1", [123456789, "authorize transfer #42"]),
                    ("s2", [987654321, "release v3.1.0"]),
                ],
            },
        ],
    },

    # --- Color / Table / Spreadsheets / PDF ---
    {
        "repo": "facelessuser/coloraide",
        "license": "MIT",
        "domain": "color",
        "package": "coloraide",
        "api_probes": [
            {
                "name": "color_convert_mix",
                "code": '''"""Cross-file probe exercising `coloraide` color space conversion, contrast, and mixing."""
from coloraide import Color

def run(c1_str: str, c2_str: str, mix_pct: float) -> dict:
    c1 = Color(c1_str)
    c2 = Color(c2_str)
    mixed = c1.mix(c2, mix_pct, space="oklab").convert("srgb")
    hsl = c1.convert("hsl")
    return {
        "c1_hex": c1.convert("srgb").to_string(hex=True),
        "mixed_hex": mixed.to_string(hex=True),
        "contrast": round(c1.contrast(c2), 3),
        "hsl": [round(x, 2) for x in hsl.coords()],
    }
''',
                "cases": [
                    ("mix1", ["#1e40af", "#f59e0b", 0.5]),
                    ("mix2", ["rgb(220 38 38)", "rgb(255 255 255)", 0.25]),
                ],
            },
        ],
    },
    {
        "repo": "jazzband/prettytable",
        "license": "BSD-3-Clause",
        "domain": "table-doc",
        "package": "prettytable",
        "api_probes": [
            {
                "name": "render_table",
                "code": '''"""Cross-file probe exercising `prettytable` ASCII/CSV/JSON table formatting & sorting."""
from prettytable import PrettyTable

def run(headers: list[str], rows: list[list], sortby: str) -> dict:
    t = PrettyTable(headers)
    for r in rows:
        t.add_row(r)
    t.sortby = sortby
    return {
        "ascii": t.get_string(),
        "csv": t.get_csv_string().strip(),
    }
''',
                "cases": [
                    ("scores", [["Name", "Score", "Tier"], [["bob", 88, "B"], ["ada", 97, "A"], ["cy", 91, "A"]], "Score"]),
                    ("nodes", [["Node", "CPU"], [["n2", 45], ["n1", 12], ["n3", 78]], "Node"]),
                ],
            },
        ],
    },
    {
        "repo": "jazzband/tablib",
        "license": "MIT",
        "domain": "table-doc",
        "package": "tablib",
        "api_probes": [
            {
                "name": "tabular_export",
                "code": '''"""Cross-file probe exercising `tablib` Dataset manipulation and CSV/JSON/HTML export."""
import tablib

def run(headers: list[str], rows: list[list]) -> dict:
    ds = tablib.Dataset(*rows, headers=headers)
    ds.append_col([i + 1 for i in range(len(rows))], header="rank")
    return {
        "height": ds.height,
        "width": ds.width,
        "csv": ds.export("csv").strip(),
        "json": ds.export("json"),
    }
''',
                "cases": [
                    ("t1", [["item", "qty"], [["pen", 10], ["book", 4]]]),
                    ("t2", [["svc", "ms"], [["auth", 12], ["edge", 5], ["db", 29]]]),
                ],
            },
        ],
    },
    {"repo": "gtaylor/python-colormath", "license": "BSD-3-Clause", "domain": "color", "package": "colormath"},
    {"repo": "jmcnamara/XlsxWriter", "license": "BSD-2-Clause", "domain": "table-doc", "package": "xlsxwriter"},
    {"repo": "py-pdf/pypdf", "license": "BSD-3-Clause", "domain": "table-doc", "package": "pypdf"},

    # --- Math / Geo / Units / Algorithms / AST / Linting / CLI ---
    {
        "repo": "geopy/geopy",
        "license": "MIT",
        "domain": "math-geo",
        "package": "geopy",
        "api_probes": [
            {
                "name": "geo_distance",
                "code": '''"""Cross-file probe exercising `geopy` Point parsing, DMS formatting, and great-circle distances."""
from geopy.point import Point
from geopy.distance import great_circle

def run(p1_coords: list[float], p2_coords: list[float]) -> dict:
    a = Point(p1_coords[0], p1_coords[1])
    b = Point(p2_coords[0], p2_coords[1])
    dist = great_circle(a, b)
    return {
        "km": round(dist.km, 3),
        "miles": round(dist.miles, 3),
        "a_dms": a.format(),
        "b_dms": b.format(),
    }
''',
                "cases": [
                    ("sf_nyc", [[37.7749, -122.4194], [40.7128, -74.0060]]),
                    ("lon_par", [[51.5074, -0.1278], [48.8566, 2.3522]]),
                ],
            },
        ],
    },
    {
        "repo": "lmfit/uncertainties",
        "license": "BSD-3-Clause",
        "domain": "math-geo",
        "package": "uncertainties",
        "api_probes": [
            {
                "name": "error_prop",
                "code": '''"""Cross-file probe exercising `uncertainties` automatic linear error propagation."""
from uncertainties import ufloat
from uncertainties import umath

def run(x_val: float, x_err: float, y_val: float, y_err: float) -> dict:
    x = ufloat(x_val, x_err)
    y = ufloat(y_val, y_err)
    z = umath.sqrt(x**2 + y**2)
    ratio = x / y
    return {
        "z_nom": round(z.n, 5),
        "z_std": round(z.s, 5),
        "ratio_nom": round(ratio.n, 5),
        "ratio_std": round(ratio.s, 5),
    }
''',
                "cases": [
                    ("m1", [3.0, 0.1, 4.0, 0.2]),
                    ("m2", [10.0, 0.5, 2.5, 0.05]),
                ],
            },
        ],
    },
    {
        "repo": "keon/algorithms",
        "license": "MIT",
        "domain": "algorithms",
        "package": "algorithms",
        "api_probes": [
            {
                "name": "graph_sort_dp",
                "code": '''"""Cross-file probe exercising `algorithms` sorting, DP, and string modules."""
from algorithms.sort.merge_sort import merge_sort
from algorithms.dp.coin_change import count as coin_count
from algorithms.strings.is_palindrome import is_palindrome

def run(arr: list[int], coins: list[int], amount: int, word: str) -> dict:
    return {
        "sorted": merge_sort(list(arr)),
        "coin_ways": coin_count(coins, amount),
        "palindrome": is_palindrome(word),
    }
''',
                "cases": [
                    ("a1", [[9, 3, 7, 1, 5, 2], [1, 2, 5], 7, "racecar"]),
                    ("a2", [[12, -4, 8, 0, 3], [1, 3, 4], 6, "python"]),
                ],
            },
        ],
    },
    {
        "repo": "PyCQA/isort",
        "license": "MIT",
        "domain": "ast-lint",
        "package": "isort",
        "api_probes": [
            {
                "name": "sort_imports",
                "code": '''"""Cross-file probe exercising `isort` Python import classification and sorting."""
import isort

def run(src: str) -> str:
    return isort.code(src)
''',
                "cases": [
                    ("imp1", ["import sys\nimport json\nfrom collections import defaultdict\nimport os\nfrom mypkg.sub import beta, alpha\n"]),
                    ("imp2", ["from .local import z, a\nimport re\nimport math\nfrom pathlib import Path\n"]),
                ],
            },
        ],
    },
    {
        "repo": "rubik/radon",
        "license": "MIT",
        "domain": "ast-lint",
        "package": "radon",
        "api_probes": [
            {
                "name": "complexity_metrics",
                "code": '''"""Cross-file probe exercising `radon` AST cyclomatic complexity, raw, and Halstead metrics."""
from radon.complexity import cc_visit, cc_rank
from radon.raw import analyze
from radon.metrics import h_visit

def run(code_src: str) -> dict:
    blocks = cc_visit(code_src)
    raw = analyze(code_src)
    hal = h_visit(code_src)
    return {
        "blocks": [{"name": b.name, "cc": b.complexity, "rank": cc_rank(b.complexity)} for b in blocks],
        "loc": raw.loc,
        "sloc": raw.sloc,
        "halstead_vol": round(hal.total.volume, 2),
    }
''',
                "cases": [
                    ("fn1", ["def classify(x, y):\n    if x < 0:\n        return 'neg'\n    elif x == 0:\n        return 'zero' if y == 0 else 'axis'\n    for i in range(x):\n        if i % 2 == 0 and y > i:\n            return 'hit'\n    return 'pos'\n"]),
                    ("fn2", ["def score(items):\n    total = 0\n    for it in items:\n        if it > 10:\n            total += it * 2\n        elif it > 0:\n            total += it\n    return total\n"]),
                ],
            },
        ],
    },
    {
        "repo": "jendrikseipp/vulture",
        "license": "MIT",
        "domain": "ast-lint",
        "package": "vulture",
        "api_probes": [
            {
                "name": "dead_code_scan",
                "code": '''"""Cross-file probe exercising `vulture` AST dead-code analysis."""
from vulture.core import Vulture

def run(src: str) -> list[dict]:
    v = Vulture()
    v.scan(src, filename="sample.py")
    return [
        {"name": item.name, "typ": item.typ, "lineno": item.first_lineno, "conf": item.confidence}
        for item in v.get_unused_code()
    ]
''',
                "cases": [
                    ("dead1", ["def used(x):\n    return x + 1\ndef unused_helper(a):\n    return a * 2\nval = used(5)\n"]),
                    ("dead2", ["import math\nclass Ghost:\n    pass\nX_UNUSED = 99\ndef main():\n    return 1\nmain()\n"]),
                ],
            },
        ],
    },
    {"repo": "PyCQA/bandit", "license": "Apache-2.0", "domain": "ast-lint", "package": "bandit"},
    {"repo": "google/python-fire", "license": "Apache-2.0", "domain": "cli-config", "package": "fire"},
    {
        "repo": "pyinvoke/invoke",
        "license": "BSD-2-Clause",
        "domain": "cli-config",
        "package": "invoke",
        "api_probes": [
            {
                "name": "cli_parser",
                "code": '''"""Cross-file probe exercising `invoke.parser` CLI context & flag parsing."""
from invoke.parser import Parser, ParserContext, Argument

def run(argv: list[str]) -> dict:
    build_ctx = ParserContext(name="build", args=[
        Argument(names=("env", "e"), default="dev"),
        Argument(names=("clean", "c"), kind=bool, default=False),
        Argument(names=("jobs", "j"), kind=int, default=4),
    ])
    parser = Parser(contexts=[build_ctx])
    res = parser.parse_argv(argv)
    return {ctx.name: {k: v.value for k, v in sorted(ctx.args.items())} for ctx in res}
''',
                "cases": [
                    ("flags1", [["build", "-e", "prod", "--clean", "-j", "8"]]),
                    ("flags2", [["build", "--env=staging", "--jobs", "2"]]),
                ],
            },
        ],
    },
    {"repo": "mahmoud/face", "license": "BSD-3-Clause", "domain": "cli-config", "package": "face"},
    {"repo": "python-poetry/cleo", "license": "MIT", "domain": "cli-config", "package": "cleo"},
    {"repo": "Kozea/cssselect2", "license": "BSD-3-Clause", "domain": "html-css", "package": "cssselect2"},
    {"repo": "mozilla/bleach", "license": "Apache-2.0", "domain": "html-css", "package": "bleach"},
    {"repo": "JoshData/python-email-validator", "license": "Unlicense", "domain": "validation", "package": "email_validator"},
    {"repo": "hukkin/tomli-w", "license": "MIT", "domain": "toml-config", "package": "tomli_w"},
    {"repo": "dry-python/returns", "license": "BSD-2-Clause", "domain": "functional", "package": "returns"},

    # --- Additional high-yield pure-Python OSS multi-file libraries (bringing catalog > 95!) ---
    {
        "repo": "mido/mido",
        "license": "MIT",
        "domain": "binary-codec",
        "package": "mido",
        "api_probes": [
            {
                "name": "midi_msg",
                "code": '''"""Cross-file probe exercising `mido` MIDI message encoding, decoding, and hex parsing."""
import mido

def run(notes: list[list[int]]) -> list[dict]:
    out = []
    for ch, note, vel in notes:
        m = mido.Message("note_on", channel=ch, note=note, velocity=vel)
        raw = m.bytes()
        reparsed = mido.Message.from_bytes(raw)
        out.append({"hex": m.hex(), "note": reparsed.note, "vel": reparsed.velocity, "ch": reparsed.channel})
    return out
''',
                "cases": [
                    ("chord", [[[0, 60, 100], [0, 64, 90], [1, 67, 80]]]),
                    ("scale", [[[2, 72, 127], [2, 74, 64]]]),
                ],
            },
        ],
    },
    {
        "repo": "python-trio/outcome",
        "license": "MIT",
        "domain": "functional",
        "package": "outcome",
    },
    {
        "repo": "jmespath/jmespath.py",  # Will be automatically skipped by Stage 10 filter — DO NOT ADD!
        "_skip_placeholder": True,
    },
    {
        "repo": "marshmallow-code/environs",
        "license": "MIT",
        "domain": "cli-config",
        "package": "environs",
    },
    {
        "repo": "barseghyanartur/tld",
        "license": "MPL-2.0",
        "domain": "url-http",
        "package": "tld",
    },
    {
        "repo": "zytedata/url-matcher",
        "license": "BSD-3-Clause",
        "domain": "url-http",
        "package": "url_matcher",
        "api_probes": [
            {
                "name": "url_patterns",
                "code": '''"""Cross-file probe exercising `url_matcher` URL rule compilation and matching."""
from url_matcher import URLMatcher, Patterns

def run(rules: list[list], urls: list[str]) -> list[dict]:
    m = URLMatcher()
    for ident, inc, exc in rules:
        m.add_or_update(ident, Patterns(include=inc, exclude=exc))
    return [{"url": u, "match": m.match(u)} for u in urls]
''',
                "cases": [
                    ("shop", [[["product", ["shop.example.com/item/*"], ["shop.example.com/item/draft*"]], ["blog", ["shop.example.com/blog/*"], []]], ["https://shop.example.com/item/42", "https://shop.example.com/item/draft-1", "https://shop.example.com/blog/news"]]),
                ],
            },
        ],
    },
    {
        "repo": "koxudaxi/datamodel-code-generator",
        "license": "MIT",
        "domain": "ast-lint",
        "package": "datamodel_code_generator",
    },
    {
        "repo": "mahmoud/lithoxyl",
        "license": "BSD-3-Clause",
        "domain": "fsm-retry",
        "package": "lithoxyl",
    },
    {
        "repo": "timofurrer/colorful",
        "license": "MIT",
        "domain": "color",
        "package": "colorful",
    },
    {
        "repo": "sdispater/crashtest",
        "license": "MIT",
        "domain": "cli-config",
        "package": "crashtest",
        "api_probes": [
            {
                "name": "inspect_exc",
                "code": '''"""Cross-file probe exercising `crashtest` exception Inspector and frame collection."""
from crashtest.inspector import Inspector

def _inner(x: int) -> int:
    if x < 0:
        raise ValueError(f"negative input {x}")
    return x * 2

def run(val: int) -> dict:
    try:
        return {"ok": True, "val": _inner(val)}
    except Exception as exc:
        insp = Inspector(exc)
        return {
            "ok": False,
            "name": insp.exception_name,
            "message": insp.exception_message,
            "has_prev": insp.has_previous_exception(),
            "frames": len(insp.frames),
        }
''',
                "cases": [
                    ("neg", [-5]),
                    ("neg2", [-42]),
                ],
            },
        ],
    },
    {
        "repo": "pallets/quart",
        "license": "MIT",
        "domain": "url-http",
        "package": "quart",
    },
    {
        "repo": "aio-libs/aiojobs",
        "license": "Apache-2.0",
        "domain": "fsm-retry",
        "package": "aiojobs",
    },
    {
        "repo": "django/asgiref",
        "license": "BSD-3-Clause",
        "domain": "protocol",
        "package": "asgiref",
    },
    {
        "repo": "agronholm/typeguard",
        "license": "MIT",
        "domain": "validation",
        "package": "typeguard",
    },
    {
        "repo": "pypa/wheel",
        "license": "MIT",
        "domain": "packaging-deps",
        "package": "wheel",
    },
    {
        "repo": "pypa/build",
        "license": "MIT",
        "domain": "packaging-deps",
        "package": "build",
    },
    {
        "repo": "pypa/flit",
        "license": "BSD-3-Clause",
        "domain": "packaging-deps",
        "package": "flit_core",
    },
    {
        "repo": "niklasf/python-chess",
        "license": "GPL-3.0",  # Skip non-permissive!
        "_skip_placeholder": True,
    },
    {
        "repo": "brentyi/tyro",
        "license": "MIT",
        "domain": "cli-config",
        "package": "tyro",
    },
    {
        "repo": "schematics/schematics",
        "license": "BSD-3-Clause",
        "domain": "validation",
        "package": "schematics",
    },
    {
        "repo": "inducer/pymbolic",
        "license": "MIT",
        "domain": "math-geo",
        "package": "pymbolic",
        "api_probes": [
            {
                "name": "symbolic_diff_eval",
                "code": '''"""Cross-file probe exercising `pymbolic` symbolic expression parsing, differentiation, and evaluation."""
import pymbolic as pmbl

def run(expr_str: str, var_name: str, bindings: dict[str, int]) -> dict:
    expr = pmbl.parse(expr_str)
    deriv = pmbl.differentiate(expr, var_name)
    val = pmbl.evaluate(expr, bindings)
    dval = pmbl.evaluate(deriv, bindings)
    return {"expr": str(expr), "deriv": str(deriv), "val": val, "dval": dval}
''',
                "cases": [
                    ("poly1", ["3*x**2 + 2*x + 5", "x", {"x": 4}]),
                    ("poly2", ["x**3 - 4*x*y + y**2", "x", {"x": 3, "y": 2}]),
                ],
            },
        ],
    },
    {
        "repo": "jquast/blessed",
        "license": "MIT",
        "domain": "cli-config",
        "package": "blessed",
    },
    {
        "repo": "jaraco/jaraco.text",
        "license": "MIT",
        "domain": "diff-text",
        "package": "jaraco",
    },
    {
        "repo": "jaraco/jaraco.collections",
        "license": "MIT",
        "domain": "data-structures",
        "package": "jaraco",
    },
    {
        "repo": "mwilliamson/python-mammoth",
        "license": "BSD-2-Clause",
        "domain": "table-doc",
        "package": "mammoth",
    },
    {
        "repo": "lepture/authlib",
        "license": "BSD-3-Clause",
        "domain": "crypto-auth",
        "package": "authlib",
    },
    {
        "repo": "mpdavis/python-jose",
        "license": "MIT",
        "domain": "crypto-auth",
        "package": "jose",
        "api_probes": [
            {
                "name": "jose_jwt",
                "code": '''"""Cross-file probe exercising `jose` pure-Python JWS/JWT HS256 signing and verification."""
from jose import jwt

def run(claims: dict, secret: str) -> dict:
    tok = jwt.encode(claims, secret, algorithm="HS256")
    dec = jwt.decode(tok, secret, algorithms=["HS256"])
    hdr = jwt.get_unverified_header(tok)
    return {"header": hdr, "claims": dec, "len": len(tok)}
''',
                "cases": [
                    ("t1", [{"sub": "alice", "role": "editor"}, "jose-secret-key-123"]),
                    ("t2", [{"sub": "bob", "tier": 3}, "another-secret-456"]),
                ],
            },
        ],
    },
    {
        "repo": "py-pdf/fpdf2",
        "license": "LGPL-3.0",  # Skip non-permissive
        "_skip_placeholder": True,
    },
    {
        "repo": "facelessuser/soupsieve",
        "license": "MIT",
        "domain": "html-css",
        "package": "soupsieve",
        "api_probes": [
            {
                "name": "css_compile",
                "code": '''"""Cross-file probe exercising `soupsieve` CSS4 selector parser & compiler."""
import soupsieve

def run(selectors: list[str]) -> list[dict]:
    out = []
    for s in selectors:
        c = soupsieve.compile(s)
        out.append({"pattern": c.pattern, "selectors": len(c.selectors)})
    return out
''',
                "cases": [
                    ("s1", [["div.card > p.lead:first-child", "ul li:nth-child(2n+1) a[href^='https']"]]),
                    ("s2", [["article:is(section, main) > h2 + p:not(.muted)", "input[type='email']:required"]]),
                ],
            },
        ],
    },
    {
        "repo": "scrapinghub/dateparser",
        "license": "BSD-3-Clause",
        "domain": "date-time",
        "package": "dateparser",
    },
    {
        "repo": "tomerfiliba/plumbum",
        "license": "MIT",
        "domain": "cli-config",
        "package": "plumbum",
    },
    {
        "repo": "python-babel/babel",
        "license": "BSD-3-Clause",
        "domain": "diff-text",
        "package": "babel",
    },
    {
        "repo": "nedbat/scriv",
        "license": "Apache-2.0",
        "domain": "cli-config",
        "package": "scriv",
    },
    {
        "repo": "drj11/pypng",
        "license": "MIT",
        "domain": "binary-codec",
        "package": "png",
    },
    {
        "repo": "sdispater/pendulum",
        "license": "MIT",
        "domain": "date-time",
        "package": "pendulum",
    },
    {
        "repo": "aio-libs/aiosqlite",
        "license": "MIT",
        "domain": "sql",
        "package": "aiosqlite",
    },
    {
        "repo": "psf/black",
        "license": "MIT",
        "domain": "ast-lint",
        "package": "blib2to3",
    },
    {
        "repo": "beartype/beartype",
        "license": "MIT",
        "domain": "validation",
        "package": "beartype",
    },
    {
        "repo": "Tinche/cattrs",
        "license": "MIT",
        "domain": "validation",
        "package": "cattrs",
    },
    {
        "repo": "hukkin/mdformat",
        "license": "MIT",
        "domain": "markdown-markup",
        "package": "mdformat",
    },
    {
        "repo": "python-cmd2/cmd2",
        "license": "MIT",
        "domain": "cli-config",
        "package": "cmd2",
    },
    {
        "repo": "sloria/TextBlob",
        "license": "MIT",
        "domain": "text-nlp",
        "package": "textblob",
    },
    {
        "repo": "pdfminer/pdfminer.six",
        "license": "MIT",
        "domain": "table-doc",
        "package": "pdfminer",
    },
    {
        "repo": "eventable/vobject",
        "license": "Apache-2.0",
        "domain": "date-time",
        "package": "vobject",
    },
    {
        "repo": "coleifer/peewee",
        "license": "MIT",
        "domain": "sql",
        "package": "peewee",
    },
    {
        "repo": "jab/bidict",
        "license": "MPL-2.0",
        "domain": "data-structures",
        "package": "bidict",
        "api_probes": [
            {
                "name": "bijective_map",
                "code": '''"""Cross-file probe exercising `bidict` bidirectional dictionary, inverse lookup, and conflict policies."""
from bidict import bidict, frozenbidict, OnDup, DROP_OLD

def run(pairs: list[list], updates: list[list]) -> dict:
    b = bidict(pairs)
    for k, v in updates:
        b.put(k, v, on_dup=OnDup(key=DROP_OLD, val=DROP_OLD))
    fb = frozenbidict(b)
    return {
        "forward": dict(sorted(b.items())),
        "inverse": dict(sorted(b.inverse.items())),
        "len": len(fb),
    }
''',
                "cases": [
                    ("codes", [[["US", 1], ["UK", 44], ["DE", 49]], [["GB", 44], ["FR", 33]]]),
                    ("ports", [[["http", 80], ["https", 443]], [["web", 80], ["ssh", 22]]]),
                ],
            },
        ],
    },
    {
        "repo": "facelessuser/backrefs",
        "license": "MIT",
        "domain": "parser-grammar",
        "package": "backrefs",
        "api_probes": [
            {
                "name": "bre_expand",
                "code": '''"""Cross-file probe exercising `backrefs.bre` extended regex and case-transform backreferences."""
from backrefs import bre

def run(pattern: str, repl: str, text: str) -> dict:
    compiled = bre.compile_search(pattern)
    subbed = compiled.sub(repl, text)
    found = compiled.findall(text)
    return {"subbed": subbed, "matches": [list(m) if isinstance(m, tuple) else m for m in found]}
''',
                "cases": [
                    ("case_sub", [r"([a-z]+)_([a-z]+)", r"\u\1\U\2\E", "foo_bar baz_qux"]),
                    ("hex_sub", [r"\b(\w+)\b", r"\u\1", "alpha beta gamma"]),
                ],
            },
        ],
    },
    {
        "repo": "dabeaz/sly",
        "license": "BSD-3-Clause",
        "domain": "parser-grammar",
        "package": "sly",
        "api_probes": [
            {
                "name": "sly_calc",
                "code": '''"""Cross-file probe exercising `sly` Lexer and LALR(1) Parser."""
from sly import Lexer, Parser

class CalcLexer(Lexer):
    tokens = {NUMBER, PLUS, MINUS, TIMES, LPAREN, RPAREN}
    ignore = " \\t"
    NUMBER = r"\\d+"
    PLUS = r"\\+"
    MINUS = r"-"
    TIMES = r"\\*"
    LPAREN = r"\\("
    RPAREN = r"\\)"
    def NUMBER(self, t):
        t.value = int(t.value)
        return t

class CalcParser(Parser):
    tokens = CalcLexer.tokens
    precedence = (("left", PLUS, MINUS), ("left", TIMES))
    @_("expr PLUS expr")
    def expr(self, p): return p.expr0 + p.expr1
    @_("expr MINUS expr")
    def expr(self, p): return p.expr0 - p.expr1
    @_("expr TIMES expr")
    def expr(self, p): return p.expr0 * p.expr1
    @_("LPAREN expr RPAREN")
    def expr(self, p): return p.expr
    @_("NUMBER")
    def expr(self, p): return p.NUMBER

def run(src: str) -> dict:
    lexer = CalcLexer()
    parser = CalcParser()
    toks = [(t.type, t.value) for t in lexer.tokenize(src)]
    val = parser.parse(lexer.tokenize(src))
    return {"value": val, "token_count": len(toks)}
''',
                "cases": [
                    ("e1", ["3 + 4 * (10 - 2)"]),
                    ("e2", ["(7 + 5) * 6 - 11"]),
                ],
            },
        ],
    },
    {
        "repo": "sdispater/pastel",
        "license": "MIT",
        "domain": "color",
        "package": "pastel",
        "api_probes": [
            {
                "name": "ansi_markup",
                "code": '''"""Cross-file probe exercising `pastel` ANSI markup parsing and styling."""
import pastel

def run(markup: str) -> dict:
    p = pastel.Pastel(with_colors=True)
    colored = p.colorize(markup)
    plain = pastel.Pastel(with_colors=False).colorize(markup)
    return {"colored": colored, "plain": plain, "len_diff": len(colored) - len(plain)}
''',
                "cases": [
                    ("ok", ["<info>PASS</info> <comment>42 tests</comment> <error>0 failed</error>"]),
                    ("bold", ["<options=bold;fg=green>DEPLOYED</> v2.1.0"]),
                ],
            },
        ],
    },
    {
        "repo": "daviddrysdale/python-phonenumbers",
        "license": "Apache-2.0",
        "domain": "validation",
        "package": "phonenumbers",
        "api_probes": [
            {
                "name": "parse_format",
                "code": '''"""Cross-file probe exercising `phonenumbers` international phone parsing, validation, and formatting."""
import phonenumbers
from phonenumbers import PhoneNumberFormat

def run(raw_num: str, region: str) -> dict:
    num = phonenumbers.parse(raw_num, region)
    return {
        "valid": phonenumbers.is_valid_number(num),
        "possible": phonenumbers.is_possible_number(num),
        "country_code": num.country_code,
        "e164": phonenumbers.format_number(num, PhoneNumberFormat.E164),
        "intl": phonenumbers.format_number(num, PhoneNumberFormat.INTERNATIONAL),
    }
''',
                "cases": [
                    ("us", ["(650) 253-0000", "US"]),
                    ("gb", ["020 7946 0958", "GB"]),
                ],
            },
        ],
    },
    {
        "repo": "eliben/pyelftools",
        "license": "Unlicense",
        "domain": "binary-codec",
        "package": "elftools",
        "api_probes": [
            {
                "name": "leb128_decode",
                "code": '''"""Cross-file probe exercising `elftools` ULEB128/SLEB128 DWARF binary decoders."""
import io
from elftools.common.utils import parse_stream
from elftools.common.construct_utils import ULEB128, SLEB128

def run(uleb_hex: list[str], sleb_hex: list[str]) -> dict:
    u_vals = [parse_stream(ULEB128("u"), io.BytesIO(bytes.fromhex(h))) for h in uleb_hex]
    s_vals = [parse_stream(SLEB128("s"), io.BytesIO(bytes.fromhex(h))) for h in sleb_hex]
    return {"uleb": u_vals, "sleb": s_vals}
''',
                "cases": [
                    ("v1", [["e58e26", "8001", "7f"], ["c0bb78", "7f", "9b9101"]]),
                    ("v2", [["00", "ff01", "808001"], ["00", "817f", "ff00"]]),
                ],
            },
        ],
    },
    {"repo": "john-kurkowski/tldextract", "license": "BSD-3-Clause", "domain": "url-http", "package": "tldextract"},
    {"repo": "hgrecco/pint", "license": "BSD-3-Clause", "domain": "math-geo", "package": "pint"},
    {
        "repo": "google/abseil-py",
        "license": "Apache-2.0",
        "domain": "cli-config",
        "package": "absl",
        "api_probes": [
            {
                "name": "absl_flags",
                "code": '''"""Cross-file probe exercising `absl.flags` FlagValues definition, parsing, and validation."""
from absl import flags

def run(argv: list[str]) -> dict:
    fv = flags.FlagValues()
    flags.DEFINE_string("env", "dev", "Environment", flag_values=fv)
    flags.DEFINE_integer("workers", 4, "Worker count", lower_bound=1, upper_bound=64, flag_values=fv)
    flags.DEFINE_boolean("dry_run", False, "Dry run", flag_values=fv)
    flags.DEFINE_list("tags", [], "Tags", flag_values=fv)
    rest = fv(["prog", *argv])
    return {"env": fv.env, "workers": fv.workers, "dry_run": fv.dry_run, "tags": fv.tags, "rest": rest[1:]}
''',
                "cases": [
                    ("f1", [["--env=prod", "--workers=16", "--dry_run", "--tags=a,b,c", "target1"]]),
                    ("f2", [["--env", "staging", "--nodry_run", "--workers", "8", "--tags=x,y"]]),
                ],
            },
        ],
    },
    {"repo": "prompt-toolkit/python-prompt-toolkit", "license": "BSD-3-Clause", "domain": "cli-config", "package": "prompt_toolkit"},
    {"repo": "cherrypy/cheroot", "license": "BSD-3-Clause", "domain": "url-http", "package": "cheroot"},
    {"repo": "dabeaz/curio", "license": "BSD-3-Clause", "domain": "fsm-retry", "package": "curio"},
    {"repo": "benoitc/gunicorn", "license": "MIT", "domain": "url-http", "package": "gunicorn"},
    {"repo": "frostming/unearth", "license": "MIT", "domain": "packaging-deps", "package": "unearth"},
]

# Filter out placeholder skip entries so REPO_CATALOG is 100% clean permissive OSS.
REPO_CATALOG = [r for r in REPO_CATALOG if not r.get("_skip_placeholder")]


# ===========================================================================
# Subprocess Probe Script (tracks touched non-entry files AND executed lines)
# ===========================================================================

_MULTIFILE_PROBE_SCRIPT = r"""
import asyncio
import builtins
import inspect
import io
import json
import random
import signal
import sys
import time

sys.path.insert(0, sys.argv[1])
from tinker_py.codebase import (
    guest_filename_for,
    load_virtual_entry_module,
    normalize_codebase_files,
)
from tinker_py.codec import decode_readable, encode_exception, encode_readable
from tinker_py.http_tools import DEFAULT_HTTP_TIMEOUT_S, MAX_HTTP_BODY_BYTES, install_live_http_hooks
from tinker_py.io_tools import (
    DEFAULT_SUBPROCESS_TIMEOUT_S,
    MAX_IO_BYTES,
    MAX_LIVE_CALLS,
    install_live_io_hooks,
    is_guest_caller,
)

def _timeout(_sig, _frame):
    raise TimeoutError("multifile probe timeout")

if hasattr(signal, "SIGALRM"):
    signal.signal(signal.SIGALRM, _timeout)
    signal.setitimer(signal.ITIMER_REAL, 10.0)

real_stdout = sys.stdout
try:
    req = json.loads(sys.stdin.read())
    files, entry_file, _init = normalize_codebase_files(req["files"], req["entryFile"])
    entry = req["entry"]
    args = decode_readable(req["args"])
    collect_lines = bool(req.get("collectLines", False))

    recorded = []
    rng = random.Random(17)
    time_counter = [0]
    io_depth = [0]
    real_time = time.time
    real_monotonic = time.monotonic
    real_random = random.random

    def _next_det_time():
        val = 1700000000.0 + time_counter[0] * 0.25
        time_counter[0] += 1
        return val

    def _rec_print(*p_args, **_kwargs):
        if io_depth[0] > 0:
            return
        if len(recorded) >= MAX_LIVE_CALLS:
            raise RuntimeError("too many recorded calls")
        recorded.append({
            "operation": "platform.print",
            "arguments": encode_readable(list(p_args)),
            "status": "fulfilled",
            "result": None,
        })

    def _rec_time():
        if not is_guest_caller(io_depth):
            return real_time()
        if len(recorded) >= MAX_LIVE_CALLS:
            raise RuntimeError("too many recorded calls")
        val = _next_det_time()
        recorded.append({
            "operation": "platform.time",
            "arguments": [],
            "status": "fulfilled",
            "result": val,
        })
        return val

    def _rec_monotonic():
        if not is_guest_caller(io_depth):
            return real_monotonic()
        if len(recorded) >= MAX_LIVE_CALLS:
            raise RuntimeError("too many recorded calls")
        val = _next_det_time()
        recorded.append({
            "operation": "platform.time",
            "arguments": [],
            "status": "fulfilled",
            "result": val,
        })
        return val

    def _rec_random():
        if not is_guest_caller(io_depth):
            return real_random()
        if len(recorded) >= MAX_LIVE_CALLS:
            raise RuntimeError("too many recorded calls")
        val = rng.random()
        recorded.append({
            "operation": "platform.random",
            "arguments": [],
            "status": "fulfilled",
            "result": val,
        })
        return val

    all_src = "\n".join(files.values())
    enable_urllib = ("urllib" in all_src) or ("urlopen" in all_src)
    enable_requests = "requests" in all_src
    if enable_urllib or enable_requests:
        install_live_http_hooks(
            recorded,
            max_body_bytes=MAX_HTTP_BODY_BYTES,
            default_timeout=DEFAULT_HTTP_TIMEOUT_S,
            enable_urllib=enable_urllib,
            enable_requests=enable_requests,
            io_depth=io_depth,
        )

    time.time = _rec_time
    time.monotonic = _rec_monotonic
    random.random = _rec_random

    guest_builtins = dict(vars(builtins))
    guest_builtins["print"] = _rec_print
    flush_io = install_live_io_hooks(
        recorded,
        io_depth=io_depth,
        guest_builtins=guest_builtins,
        max_io_bytes=MAX_IO_BYTES,
        max_recorded_calls=MAX_LIVE_CALLS,
        default_subprocess_timeout=DEFAULT_SUBPROCESS_TIMEOUT_S,
        next_time_fn=_next_det_time,
    )

    guest_to_rel = {guest_filename_for(p): p for p in files}
    touched_non_entry = set()
    executed_lines = {}
    events = [0]

    def _line_trace(frame, event, _arg):
        rel = guest_to_rel.get(frame.f_code.co_filename)
        if rel is None:
            return None
        events[0] += 1
        if events[0] > 90000:
            raise RuntimeError("trace event budget exceeded")
        if rel != entry_file:
            touched_non_entry.add(rel)
            if event == "line":
                s = executed_lines.setdefault(rel, set())
                if len(s) < 400:
                    s.add(frame.f_lineno)
        return _line_trace

    def _call_trace(frame, event, _arg):
        if event != "call":
            return None
        rel = guest_to_rel.get(frame.f_code.co_filename)
        if rel is None:
            return None
        events[0] += 1
        if events[0] > 80000:
            raise RuntimeError("call event budget exceeded")
        if rel != entry_file:
            touched_non_entry.add(rel)
        return None

    sys.stdout = io.StringIO()
    kind = "return"
    try:
        entry_mod, _finder = load_virtual_entry_module(files, entry_file, guest_builtins, {})
        fn = getattr(entry_mod, entry, None)
        if not callable(fn):
            raise TypeError(f"Entry {entry!r} not callable")
        sys.settrace(_line_trace if collect_lines else _call_trace)
        try:
            if inspect.iscoroutinefunction(fn):
                result = asyncio.run(fn(*args))
            else:
                raw_result = fn(*args)
                if inspect.isawaitable(raw_result):
                    result = asyncio.run(raw_result)
                else:
                    result = raw_result
        except Exception as exc:
            kind = "throw"
            result = encode_exception(exc)
        finally:
            sys.settrace(None)
            flush_io()
    finally:
        sys.stdout = real_stdout
        if hasattr(signal, "SIGALRM"):
            signal.setitimer(signal.ITIMER_REAL, 0.0)

    enc_out = encode_readable({"arguments": args, "value": result})
    out_obj = {
        "ok": True,
        "kind": kind,
        "result": enc_out,
        "recordedCalls": recorded,
        "touchedFiles": sorted(touched_non_entry),
    }
    if collect_lines:
        out_obj["executedLines"] = {k: sorted(v) for k, v in sorted(executed_lines.items())}
    real_stdout.write(json.dumps(out_obj, ensure_ascii=True, separators=(",", ":"), allow_nan=False) + "\n")
except Exception as exc:
    sys.stdout = real_stdout
    if hasattr(signal, "SIGALRM"):
        signal.setitimer(signal.ITIMER_REAL, 0.0)
    real_stdout.write(json.dumps({
        "ok": False,
        "error": f"{type(exc).__name__}: {exc}",
    }, ensure_ascii=False, separators=(",", ":"), allow_nan=False) + "\n")
"""


# ===========================================================================
# Utility Helpers
# ===========================================================================

def _json_compact(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def _sha256(value: Any) -> str:
    text = value if isinstance(value, str) else _json_compact(value)
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _slug(text: str) -> str:
    return re.sub(r"[^A-Za-z0-9_.-]+", "_", text).strip("_")[:64] or "mod"


def _count_tokens(text: str) -> int:
    if _TIKTOKEN_ENC is not None:
        return len(_TIKTOKEN_ENC.encode(text, disallowed_special=()))
    return int(math.ceil(len(text) / 3.5))


def _estimate_tokens_32(text: str) -> int:
    return int(math.ceil(len(text) / 3.2))


def _is_preexported_row(item: dict[str, Any]) -> bool:
    return (
        isinstance(item.get("messages"), list)
        and bool(item["messages"])
        and isinstance(item.get("sourceHash"), str)
        and isinstance(item.get("task"), dict)
    )


def _stats(vals: list[int]) -> dict[str, int] | None:
    if not vals:
        return None
    s = sorted(vals)
    return {
        "min": s[0],
        "p25": s[len(s) // 4],
        "median": s[len(s) // 2],
        "p75": s[(3 * len(s)) // 4],
        "p90": s[min(len(s) - 1, int(len(s) * 0.9))],
        "max": s[-1],
    }


def _load_forbidden_sets(
    reb_benchmark: Path,
    reb_manifest: Path,
    stage10_merged: Path,
) -> dict[str, set[str]]:
    reb_ids: set[str] = set()
    reb_families: set[str] = set()
    reb_hashes: set[str] = set()
    reb_splits: set[str] = set()
    reb_pkgs: set[str] = set()
    stage10_ids: set[str] = set()
    stage10_hashes: set[str] = set()
    stage10_pkgs: set[str] = set(STATIC_FORBIDDEN_PACKAGES)

    if reb_benchmark.is_file():
        for line in reb_benchmark.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            row = json.loads(line)
            t = row.get("task") if isinstance(row.get("task"), dict) else row
            for key_set, val in (
                (reb_ids, row.get("id") or t.get("id")),
                (reb_families, row.get("family") or t.get("family")),
                (reb_hashes, row.get("sourceHash") or t.get("sourceHash")),
                (reb_splits, row.get("split_component") or t.get("split_component")),
            ):
                if val:
                    key_set.add(str(val))
            for fp in (t.get("files") or {}):
                reb_pkgs.add(fp.split("/")[0].lower())

    if reb_manifest.is_file():
        man = json.loads(reb_manifest.read_text(encoding="utf-8"))
        for _track, id_list in (man.get("task_ids_by_track") or {}).items():
            for tid in id_list:
                reb_ids.add(str(tid))

    if stage10_merged.is_file():
        with stage10_merged.open("r", encoding="utf-8") as fh:
            for line in fh:
                if not line.strip():
                    continue
                row = json.loads(line)
                t = row.get("task") if isinstance(row.get("task"), dict) else row
                tid = row.get("id") or t.get("id")
                sh = row.get("sourceHash") or t.get("sourceHash")
                if tid:
                    stage10_ids.add(str(tid))
                if sh:
                    stage10_hashes.add(str(sh))
                if (t.get("language") or row.get("language")) == "py":
                    for fp in (t.get("files") or {}):
                        stage10_pkgs.add(fp.split("/")[0].lower())

    return {
        "reb_ids": reb_ids,
        "reb_families": reb_families,
        "reb_hashes": reb_hashes,
        "reb_splits": reb_splits,
        "reb_pkgs": reb_pkgs,
        "stage10_ids": stage10_ids,
        "stage10_hashes": stage10_hashes,
        "stage10_pkgs": stage10_pkgs,
    }


# ===========================================================================
# Git Shallow Clone Cache (100% Fault-Tolerant)
# ===========================================================================

def _clone_repo(repo_slug: str, cache_dir: Path, timeout_s: int = 120) -> tuple[Path | None, str | None]:
    cache_dir.mkdir(parents=True, exist_ok=True)
    local_name = repo_slug.replace("/", "__")
    dest = cache_dir / local_name
    if (dest / ".git").exists() and any(p.name != ".git" for p in dest.iterdir()):
        return dest, None
    # Clean partial directory if previous clone died mid-way.
    if dest.exists():
        try:
            subprocess.run(["rm", "-rf", str(dest)], check=False, timeout=15)
        except Exception:
            pass
    url = f"https://github.com/{repo_slug}.git"
    env = {**os.environ, "GIT_TERMINAL_PROMPT": "0", "GIT_ASKPASS": "true"}
    try:
        proc = subprocess.run(
            ["git", "clone", "--depth", "1", "--single-branch", "--no-tags", "--filter=blob:limit=256k", url, str(dest)],
            capture_output=True,
            text=True,
            timeout=timeout_s,
            env=env,
            check=False,
        )
        if proc.returncode != 0 or not (dest / ".git").exists():
            # Fallback without --filter in case server rejects filter.
            subprocess.run(["rm", "-rf", str(dest)], check=False, timeout=15)
            proc = subprocess.run(
                ["git", "clone", "--depth", "1", "--single-branch", "--no-tags", url, str(dest)],
                capture_output=True,
                text=True,
                timeout=timeout_s,
                env=env,
                check=False,
            )
            if proc.returncode != 0 or not (dest / ".git").exists():
                err = (proc.stderr or proc.stdout or "git clone failed").strip()[-300:]
                return None, err
        return dest, None
    except Exception as exc:
        try:
            subprocess.run(["rm", "-rf", str(dest)], check=False, timeout=15)
        except Exception:
            pass
        return None, f"{type(exc).__name__}: {exc}"


# ===========================================================================
# Package Discovery & AST Unit-Test Extraction
# ===========================================================================

def _is_test_file(rel_path: Path) -> bool:
    parts = {p.lower() for p in rel_path.parts[:-1]}
    if parts & {"tests", "test", "testing", "test_suite"}:
        return True
    name = rel_path.name.lower()
    return name.startswith("test_") or name.endswith("_test.py") or name == "conftest.py"


def _walk_py_files(repo_dir: Path) -> tuple[list[Path], list[Path]]:
    source_files: list[Path] = []
    test_files: list[Path] = []
    for root, dirs, files in os.walk(repo_dir):
        dirs[:] = sorted(d for d in dirs if d not in SKIP_DIRS and not d.endswith(".egg-info"))
        root_path = Path(root)
        for fname in sorted(files):
            if not fname.endswith(".py"):
                continue
            full = root_path / fname
            rel = full.relative_to(repo_dir)
            if _is_test_file(rel):
                test_files.append(full)
            else:
                source_files.append(full)
    return source_files, test_files


def _resolve_internal_imports(
    rel_path: str,
    tree: ast.Module,
    mod_to_rel: dict[str, str],
) -> tuple[set[str], set[str]]:
    cur_mod, cur_pkg = module_name_and_package_for(rel_path)
    internal: set[str] = set()
    external_top: set[str] = set()

    def _add_if_internal(mod_name: str) -> bool:
        if mod_name in mod_to_rel:
            target = mod_to_rel[mod_name]
            if target != rel_path:
                internal.add(target)
            return True
        return False

    top_level_nodes = {id(n) for n in tree.body if isinstance(n, (ast.Import, ast.ImportFrom))}
    for node in ast.walk(tree):
        is_uncond = id(node) in top_level_nodes
        if isinstance(node, ast.Import):
            for alias in node.names:
                if not _add_if_internal(alias.name):
                    top = alias.name.split(".", 1)[0]
                    if not any(m == top or m.startswith(top + ".") for m in mod_to_rel):
                        if is_uncond:
                            external_top.add(top)
        elif isinstance(node, ast.ImportFrom):
            level = node.level or 0
            if level > 0:
                pkg_parts = cur_pkg.split(".") if cur_pkg else []
                up = level - 1
                base_parts = pkg_parts[: len(pkg_parts) - up] if up <= len(pkg_parts) else []
                base_mod = ".".join([*base_parts, *(node.module.split(".") if node.module else [])])
                if base_mod:
                    _add_if_internal(base_mod)
                for alias in node.names:
                    if alias.name != "*":
                        _add_if_internal(f"{base_mod}.{alias.name}" if base_mod else alias.name)
            elif node.module:
                matched = _add_if_internal(node.module)
                for alias in node.names:
                    if alias.name != "*" and _add_if_internal(f"{node.module}.{alias.name}"):
                        matched = True
                if not matched:
                    top = node.module.split(".", 1)[0]
                    if not any(m == top or m.startswith(top + ".") for m in mod_to_rel):
                        if is_uncond:
                            external_top.add(top)
    return internal, external_top


def _discover_package_bundle(
    repo_dir: Path,
    preferred_pkg: str | None,
    *,
    min_files: int,
    max_single_file_bytes: int = 400_000,
) -> dict[str, Any] | None:
    """Discover the primary multi-file pure-Python package inside a cloned repo."""
    source_files, _ = _walk_py_files(repo_dir)
    if len(source_files) < min_files:
        return None

    # Find candidate outermost packages (dirs with __init__.py whose parent has no __init__.py,
    # skipping generic container dirs like `src/` or `lib/` when a real package lives inside them).
    pkg_roots: list[tuple[Path, Path]] = []
    seen_dirs: set[Path] = set()
    for sf in source_files:
        if sf.name == "__init__.py":
            cur = sf.parent
            while (
                cur != repo_dir
                and cur.parent != repo_dir
                and (cur.parent / "__init__.py").exists()
                and cur.parent.name.lower() not in ("src", "lib", "python")
            ):
                cur = cur.parent
            if cur != repo_dir and cur.name.lower() not in ("src", "lib", "python") and cur not in seen_dirs:
                seen_dirs.add(cur)
                pkg_roots.append((cur.parent, cur))

    # Prefer preferred_pkg if present, else the largest package.
    candidates: list[dict[str, Any]] = []
    for import_root, pkg_dir in pkg_roots:
        files_map: dict[str, str] = {}
        trees_map: dict[str, ast.Module] = {}
        for sf in source_files:
            try:
                sf.relative_to(pkg_dir)
            except ValueError:
                continue
            if sf.name == "setup.py":
                continue
            try:
                raw = sf.read_bytes()
            except OSError:
                continue
            if not raw or len(raw) > max_single_file_bytes or b"\x00" in raw:
                continue
            text = raw.decode("utf-8", errors="ignore")
            try:
                tree = ast.parse(text)
            except SyntaxError:
                continue
            rel = sf.relative_to(import_root).as_posix()
            files_map[rel] = text
            trees_map[rel] = tree
        if len(files_map) < min_files:
            continue
        mod_to_rel = {module_name_and_package_for(p)[0]: p for p in files_map}
        edges: dict[str, set[str]] = {}
        ext_imports: dict[str, set[str]] = {}
        for rel, tree in trees_map.items():
            internal, ext = _resolve_internal_imports(rel, tree, mod_to_rel)
            edges[rel] = internal
            ext_imports[rel] = ext
        candidates.append({
            "pkgName": pkg_dir.name,
            "importRoot": import_root,
            "files": files_map,
            "trees": trees_map,
            "edges": edges,
            "extImports": ext_imports,
            "modToRel": mod_to_rel,
        })

    if not candidates:
        return None
    candidates.sort(
        key=lambda b: (
            0 if (preferred_pkg and b["pkgName"].lower() == preferred_pkg.lower()) else 1,
            -len(b["files"]),
            b["pkgName"],
        )
    )
    return candidates[0]


def _build_bounded_file_set(
    bundle: dict[str, Any],
    *,
    entry_rel: str,
    extra_files: dict[str, str] | None = None,
    min_files: int = 5,
    max_files: int = 220,
    max_package_bytes: int = 3_600_000,
    require_static_closure: bool = True,
) -> dict[str, str] | None:
    """Build a bounded [min_files..max_files] file dict preserving real distractors."""
    all_files: dict[str, str] = dict(bundle["files"])
    if extra_files:
        all_files.update(extra_files)
    edges: dict[str, set[str]] = bundle["edges"]
    ext_imports: dict[str, set[str]] = bundle["extImports"]
    mod_to_rel: dict[str, str] = dict(bundle["modToRel"])
    if extra_files:
        for p in extra_files:
            mod_to_rel[module_name_and_package_for(p)[0]] = p

    # Compute closure starting from entry_rel (and any extra_files imports).
    closure: set[str] = {entry_rel}
    q = [entry_rel]
    if extra_files and entry_rel in extra_files:
        try:
            tree = ast.parse(extra_files[entry_rel])
            init_deps, _ = _resolve_internal_imports(entry_rel, tree, mod_to_rel)
            for d in sorted(init_deps):
                if d not in closure:
                    closure.add(d)
                    q.append(d)
        except SyntaxError:
            pass
    while q:
        cur = q.pop(0)
        parts = cur.split("/")
        for i in range(1, len(parts)):
            init_rel = "/".join(parts[:i]) + "/__init__.py"
            if init_rel in all_files and init_rel not in closure:
                closure.add(init_rel)
                q.append(init_rel)
        for dep in sorted(edges.get(cur, ())):
            if dep not in closure:
                closure.add(dep)
                q.append(dep)

    if require_static_closure and len(closure) < 2:
        return None

    # Check if full package fits comfortably inside max_files & max_package_bytes!
    total_bytes = sum(len(s.encode("utf-8")) for s in all_files.values())
    if min_files <= len(all_files) <= max_files and total_bytes <= max_package_bytes:
        # Check unconditional external imports only on closure (not unused optional-dep modules).
        if require_static_closure:
            for rel in closure:
                for ext_mod in ext_imports.get(rel, ()):
                    if ext_mod in BLOCKED_STDLIB_MODULES or ext_mod not in STDLIB_MODULES:
                        return None
        return dict(sorted(all_files.items()))

    # Large repo (> max_files or > max_package_bytes): keep full closure + real sibling distractors!
    if len(closure) > max_files:
        return None
    if require_static_closure:
        for rel in closure:
            for ext_mod in ext_imports.get(rel, ()):
                if ext_mod in BLOCKED_STDLIB_MODULES or ext_mod not in STDLIB_MODULES:
                    return None

    selected: dict[str, str] = {p: all_files[p] for p in sorted(closure) if p in all_files}
    used_bytes = sum(len(s.encode("utf-8")) for s in selected.values())
    if used_bytes > max_package_bytes:
        return None

    # Also prioritize package __init__.py and direct submodules of closure packages.
    closure_dirs = {p.rsplit("/", 1)[0] if "/" in p else "" for p in closure}
    others = [p for p in sorted(all_files.keys()) if p not in selected]
    others.sort(
        key=lambda p: (
            0 if p.endswith("/__init__.py") else 1,
            0 if (p.rsplit("/", 1)[0] if "/" in p else "") in closure_dirs else 1,
            len(all_files[p]),
            p,
        )
    )
    for p in others:
        if len(selected) >= max_files:
            break
        b = len(all_files[p].encode("utf-8"))
        if used_bytes + b > max_package_bytes:
            continue
        selected[p] = all_files[p]
        used_bytes += b

    if len(selected) < min_files:
        return None
    return dict(sorted(selected.items()))


# ---------------------------------------------------------------------------
# AST Unit-Test Extractor (Mode A)
# ---------------------------------------------------------------------------

def _eval_const_expr(node: ast.AST, env: dict[str, Any], depth: int = 0) -> tuple[bool, Any]:
    if depth > 14:
        return False, None
    if isinstance(node, ast.Constant):
        if isinstance(node.value, (type(None), bool, int, float, str, bytes)):
            return True, node.value
        return False, None
    if isinstance(node, ast.Name):
        if node.id in env:
            return True, env[node.id]
        return False, None
    if isinstance(node, ast.UnaryOp) and isinstance(node.op, (ast.UAdd, ast.USub)):
        ok, val = _eval_const_expr(node.operand, env, depth + 1)
        if ok and isinstance(val, (int, float)) and not isinstance(val, bool):
            return True, (-val if isinstance(node.op, ast.USub) else +val)
        return False, None
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
        ok_l, left = _eval_const_expr(node.left, env, depth + 1)
        ok_r, right = _eval_const_expr(node.right, env, depth + 1)
        if ok_l and ok_r:
            if type(left) is type(right) and isinstance(left, (str, bytes, list, tuple)):
                return True, left + right
            if isinstance(left, (int, float)) and not isinstance(left, bool) and isinstance(right, (int, float)) and not isinstance(right, bool):
                return True, left + right
        return False, None
    if isinstance(node, ast.List):
        items = []
        for elt in node.elts:
            ok, v = _eval_const_expr(elt, env, depth + 1)
            if not ok:
                return False, None
            items.append(v)
        return True, items
    if isinstance(node, ast.Tuple):
        items = []
        for elt in node.elts:
            ok, v = _eval_const_expr(elt, env, depth + 1)
            if not ok:
                return False, None
            items.append(v)
        return True, tuple(items)
    if isinstance(node, ast.Dict):
        out: dict[Any, Any] = {}
        for kn, vn in zip(node.keys, node.values):
            if kn is None:
                return False, None
            ok_k, kv = _eval_const_expr(kn, env, depth + 1)
            ok_v, vv = _eval_const_expr(vn, env, depth + 1)
            if not (ok_k and ok_v):
                return False, None
            try:
                out[kv] = vv
            except TypeError:
                return False, None
        return True, out
    if isinstance(node, ast.Call) and isinstance(node.func, ast.Name):
        if node.func.id == "dict" and not node.args and not node.keywords:
            return True, {}
        if node.func.id == "list" and not node.args and not node.keywords:
            return True, []
        if node.func.id == "tuple" and not node.args and not node.keywords:
            return True, ()
    return False, None


def _resolve_callee(node: ast.AST, aliases: dict[str, str]) -> str | None:
    if isinstance(node, ast.Name):
        return aliases.get(node.id, node.id)
    if isinstance(node, ast.Attribute):
        owner = node.value
        if isinstance(owner, ast.Name) and owner.id in ("self", "cls", "pytest", "unittest", "assert", "mock"):
            return None
        return node.attr
    return None


def _bind_loop_target(target: ast.AST, value: Any, env: dict[str, Any]) -> bool:
    if isinstance(target, ast.Name):
        env[target.id] = value
        return True
    if isinstance(target, (ast.Tuple, ast.List)):
        if not isinstance(value, (tuple, list)) or len(value) != len(target.elts):
            return False
        for st, sv in zip(target.elts, value):
            if not _bind_loop_target(st, sv, env):
                return False
        return True
    return False


def _extract_parametrize_envs(decorators: list[ast.expr], env: dict[str, Any]) -> list[dict[str, Any]]:
    envs: list[dict[str, Any]] = [{}]
    for dec in decorators:
        if not isinstance(dec, ast.Call):
            continue
        is_paramz = (
            (isinstance(dec.func, ast.Attribute) and dec.func.attr == "parametrize")
            or (isinstance(dec.func, ast.Name) and dec.func.id == "parametrize")
        )
        if not is_paramz:
            continue
        argnames_node = dec.args[0] if len(dec.args) >= 1 else None
        argvalues_node = dec.args[1] if len(dec.args) >= 2 else None
        for kw in dec.keywords:
            if kw.arg == "argnames" and argnames_node is None:
                argnames_node = kw.value
            elif kw.arg == "argvalues" and argvalues_node is None:
                argvalues_node = kw.value
        if argnames_node is None or argvalues_node is None:
            continue
        ok_n, raw_n = _eval_const_expr(argnames_node, env)
        if not ok_n:
            continue
        if isinstance(raw_n, str):
            names = [p.strip() for p in raw_n.split(",") if p.strip()]
        elif isinstance(raw_n, (list, tuple)) and all(isinstance(x, str) for x in raw_n):
            names = [x.strip() for x in raw_n if x.strip()]
        else:
            continue
        ok_r, rows = _eval_const_expr(argvalues_node, env)
        if not ok_r or not isinstance(rows, (list, tuple)) or not names:
            continue
        row_dicts: list[dict[str, Any]] = []
        if len(names) == 1:
            for r in rows[:24]:
                row_dicts.append({names[0]: r})
        else:
            for r in rows[:24]:
                if isinstance(r, (tuple, list)) and len(r) == len(names):
                    row_dicts.append(dict(zip(names, r)))
        if not row_dicts:
            continue
        combined: list[dict[str, Any]] = []
        for base in envs:
            for rd in row_dicts:
                combined.append({**base, **rd})
                if len(combined) >= 48:
                    break
            if len(combined) >= 48:
                break
        envs = combined
    return envs


def extract_unit_test_inputs(repo_dir: Path, test_files: list[Path]) -> dict[str, list[dict[str, Any]]]:
    """Extract real unit-test call inputs (positional + keyword calls) via AST."""
    by_fn: dict[str, list[dict[str, Any]]] = {}
    seen_per_fn: dict[str, set[str]] = {}

    def record_call(fn_name: str, args: list[Any], kwargs: dict[str, Any], rel_file: str) -> None:
        if fn_name.startswith("_") or fn_name in IGNORED_TEST_CALLEES:
            return
        try:
            enc_args = encode_readable(args)
            enc_kwargs = encode_readable(kwargs) if kwargs else {}
            sig = _json_compact([enc_args, enc_kwargs])
        except Exception:
            return
        if len(sig) > 5000:
            return
        seen = seen_per_fn.setdefault(fn_name, set())
        if sig in seen or len(seen) >= 24:
            return
        seen.add(sig)
        by_fn.setdefault(fn_name, []).append({
            "args": enc_args,
            "kwargs": enc_kwargs,
            "file": rel_file,
        })

    def scan_expr(node: ast.AST, env: dict[str, Any], aliases: dict[str, str], rel_file: str) -> None:
        for sub in ast.walk(node):
            if isinstance(sub, ast.Call):
                if any(isinstance(a, ast.Starred) for a in sub.args):
                    continue
                if any(kw.arg is None for kw in sub.keywords):
                    continue
                callee = _resolve_callee(sub.func, aliases)
                if not callee or callee.startswith("_") or callee in IGNORED_TEST_CALLEES:
                    continue
                vals: list[Any] = []
                ok_all = True
                for a in sub.args:
                    ok, v = _eval_const_expr(a, env)
                    if not ok:
                        ok_all = False
                        break
                    vals.append(v)
                if not ok_all:
                    continue
                kw_vals: dict[str, Any] = {}
                for kw in sub.keywords:
                    assert kw.arg is not None
                    ok, v = _eval_const_expr(kw.value, env)
                    if not ok:
                        ok_all = False
                        break
                    kw_vals[kw.arg] = v
                if ok_all:
                    record_call(callee, vals, kw_vals, rel_file)

    def walk_body(stmts: list[ast.stmt], env: dict[str, Any], aliases: dict[str, str], rel_file: str) -> None:
        local_env = dict(env)
        for stmt in stmts:
            if isinstance(stmt, ast.Assign):
                scan_expr(stmt.value, local_env, aliases, rel_file)
                ok, val = _eval_const_expr(stmt.value, local_env)
                if ok:
                    for tgt in stmt.targets:
                        if isinstance(tgt, ast.Name):
                            local_env[tgt.id] = val
            elif isinstance(stmt, ast.For):
                ok, seq = _eval_const_expr(stmt.iter, local_env)
                if ok and isinstance(seq, (list, tuple)):
                    for item in list(seq)[:24]:
                        iter_env = dict(local_env)
                        if _bind_loop_target(stmt.target, item, iter_env):
                            walk_body(stmt.body, iter_env, aliases, rel_file)
                else:
                    walk_body(stmt.body, local_env, aliases, rel_file)
            elif isinstance(stmt, (ast.If, ast.With)):
                scan_expr(stmt, local_env, aliases, rel_file)
                walk_body(stmt.body, local_env, aliases, rel_file)
                if isinstance(stmt, ast.If):
                    walk_body(stmt.orelse, local_env, aliases, rel_file)
            else:
                scan_expr(stmt, local_env, aliases, rel_file)

    for tf in test_files[:80]:
        try:
            text = tf.read_text(encoding="utf-8", errors="ignore")
            tree = ast.parse(text)
        except Exception:
            continue
        rel_file = str(tf.relative_to(repo_dir))
        aliases: dict[str, str] = {}
        mod_env: dict[str, Any] = {}
        for stmt in tree.body:
            if isinstance(stmt, ast.ImportFrom):
                for a in stmt.names:
                    if a.asname:
                        aliases[a.asname] = a.name
            elif isinstance(stmt, ast.Assign):
                ok, val = _eval_const_expr(stmt.value, mod_env)
                if ok:
                    for tgt in stmt.targets:
                        if isinstance(tgt, ast.Name):
                            mod_env[tgt.id] = val
            elif isinstance(stmt, ast.FunctionDef):
                for p_env in _extract_parametrize_envs(stmt.decorator_list, mod_env):
                    walk_body(stmt.body, {**mod_env, **p_env}, aliases, rel_file)
            elif isinstance(stmt, ast.ClassDef):
                cls_env = dict(mod_env)
                for item in stmt.body:
                    if isinstance(item, ast.Assign):
                        ok, val = _eval_const_expr(item.value, cls_env)
                        if ok:
                            for tgt in item.targets:
                                if isinstance(tgt, ast.Name):
                                    cls_env[tgt.id] = val
                    elif isinstance(item, ast.FunctionDef):
                        for p_env in _extract_parametrize_envs(item.decorator_list, cls_env):
                            walk_body(item.body, {**cls_env, **p_env}, aliases, rel_file)
    return by_fn


def _fn_arity_bounds(fn_node: ast.FunctionDef | ast.AsyncFunctionDef) -> tuple[int, int | None]:
    args = fn_node.args
    pos_count = len(args.posonlyargs) + len(args.args)
    default_count = len(args.defaults)
    min_arity = max(0, pos_count - default_count)
    for kw, kw_def in zip(args.kwonlyargs, args.kw_defaults):
        if kw_def is None:
            return (99, 99)
    max_arity = None if args.vararg is not None else pos_count
    return min_arity, max_arity


def _smart_probes_for_fn(fn_node: ast.FunctionDef | ast.AsyncFunctionDef, min_arity: int, max_arity: int | None) -> list[list[Any]]:
    arg_names = [a.arg.lower() for a in [*fn_node.args.posonlyargs, *fn_node.args.args]]
    probes: list[list[Any]] = []

    def _guess(name: str) -> list[Any]:
        if any(k in name for k in ("url", "uri", "link", "href")):
            return ["https://example.com:8443/api/v2/items?sort=asc&tag=py#top"]
        if any(k in name for k in ("sql", "query")):
            return ["SELECT u.id, u.name FROM users u WHERE u.active = 1"]
        if any(k in name for k in ("html", "xml", "markup", "doc")):
            return ["<div class='card'><h1>Hello</h1><p>World &amp; <b>Python</b></p></div>"]
        if any(k in name for k in ("md", "markdown")):
            return ["# Title\n\n- item **one**\n- item `two`\n"]
        if any(k in name for k in ("toml",)):
            return ['[project]\nname = "demo"\nversion = "1.2.3"\n']
        if any(k in name for k in ("json",)):
            return ['{"service":"api","retries":3,"flags":[true,false]}']
        if any(k in name for k in ("expr", "path", "pattern", "spec", "ver", "version", "req", "marker")):
            return ["foo.bar[0].baz", ">=1.2.3,<2.0.0", "1.4.2"]
        if any(k in name for k in ("date", "time", "dt", "ts", "stamp", "cron")):
            return ["2026-05-14T09:30:00Z", "*/15 9-17 * * 1-5"]
        if any(k in name for k in ("text", "str", "msg", "line", "word", "name", "title", "slug", "code", "src", "s")):
            return ["hello world 123", "foo_bar-baz"]
        if any(k in name for k in ("dict", "map", "cfg", "config", "obj", "data", "mapping", "schema")):
            return [{"a": 1, "b": {"nested": [2, 3]}, "c": "ok"}]
        if any(k in name for k in ("items", "vals", "values", "nums", "list", "seq", "arr", "tokens", "xs", "rows")):
            return [[3, 1, 4, 1, 5], ["alpha", "beta", "gamma"]]
        if any(k in name for k in ("num", "count", "size", "limit", "index", "idx", "n", "x", "y", "k")):
            return [12, 5]
        return []

    if min_arity == 1 and arg_names:
        for val in _guess(arg_names[0]):
            probes.append([val])
    elif min_arity == 2 and len(arg_names) >= 2:
        g0, g1 = _guess(arg_names[0]), _guess(arg_names[1])
        if g0 and g1:
            probes.append([g0[0], g1[0]])
    fallback_arity = min_arity if min_arity in FALLBACK_PROBES_BY_ARITY else (
        max_arity if max_arity in FALLBACK_PROBES_BY_ARITY else None
    )
    if fallback_arity is not None:
        probes.extend(FALLBACK_PROBES_BY_ARITY[fallback_arity])
    return probes


# ===========================================================================
# Subprocess Probe Runner
# ===========================================================================

def _probe_multifile(
    files: dict[str, str],
    entry_file: str,
    entry: str,
    encoded_args: list[Any],
    *,
    collect_lines: bool = False,
    hash_seed: str = HASH_SEED_PASS1,
) -> dict[str, Any]:
    payload = _json_compact({
        "files": files,
        "entryFile": entry_file,
        "entry": entry,
        "args": encoded_args,
        "collectLines": collect_lines,
    })
    try:
        with tempfile.TemporaryDirectory(prefix="py-oss-probe-") as tmpdir:
            proc = subprocess.run(
                [sys.executable, "-c", _MULTIFILE_PROBE_SCRIPT, _TRAINING_DIR],
                input=payload,
                capture_output=True,
                text=True,
                cwd=tmpdir,
                timeout=11.0,
                env={**os.environ, "PYTHONHASHSEED": hash_seed},
                check=False,
            )
        out = proc.stdout.strip()
        if not out:
            return {"ok": False, "error": proc.stderr.strip()[-200:] or "empty probe output"}
        return json.loads(out.splitlines()[-1])
    except Exception as exc:
        return {"ok": False, "error": f"{type(exc).__name__}: {exc}"}


# ===========================================================================
# Mode C: Clean 1-Line AST Behavioral Mutation Engine
# ===========================================================================

_SAME_LEN_CMP_SWAPS: dict[type[ast.cmpop], tuple[str, str]] = {
    ast.Eq: ("==", "!="),
    ast.NotEq: ("!=", "=="),
    ast.Lt: ("<", ">"),
    ast.Gt: (">", "<"),
    ast.LtE: ("<=", ">="),
    ast.GtE: (">=", "<="),
}

_BOUNDARY_CMP_SWAPS: dict[type[ast.cmpop], tuple[str, str]] = {
    ast.Lt: ("<", "<="),
    ast.LtE: ("<=", "<"),
    ast.Gt: (">", ">="),
    ast.GtE: (">=", ">"),
    ast.In: (" in ", " not in "),
    ast.NotIn: (" not in ", " in "),
}


def _enumerate_1line_ast_mutations(
    src: str,
    executed_lines: set[int],
    *,
    max_candidates: int = 24,
) -> list[dict[str, Any]]:
    """Enumerate syntax-valid 1-line AST behavioral mutations on executed lines.

    Prioritizes same-byte-length edits first so the repo manifest size `(X.X KB, N lines)`
    stays byte-for-byte identical, creating pure causal `code.load` divergence pairs!
    """
    try:
        tree = ast.parse(src)
    except SyntaxError:
        return []

    lines = src.splitlines(keepends=True)
    tier1: list[dict[str, Any]] = []  # Exact same byte length (preserves manifest!)
    tier2: list[dict[str, Any]] = []  # ±1..6 bytes (still clean 1-line behavioral diff)
    seen_edits: set[tuple[int, str]] = set()

    def _try_add(lineno: int, new_line: str, kind: str, before_tok: str, after_tok: str, same_len: bool) -> None:
        if not (1 <= lineno <= len(lines)):
            return
        orig_line = lines[lineno - 1]
        if new_line == orig_line:
            return
        key = (lineno, new_line)
        if key in seen_edits:
            return
        seen_edits.add(key)
        candidate_lines = list(lines)
        candidate_lines[lineno - 1] = new_line
        mutated_src = "".join(candidate_lines)
        try:
            ast.parse(mutated_src)
        except SyntaxError:
            return
        rec = {
            "lineno": lineno,
            "kind": kind,
            "before": orig_line.rstrip("\r\n"),
            "after": new_line.rstrip("\r\n"),
            "beforeToken": before_tok,
            "afterToken": after_tok,
            "sameByteLength": len(new_line.encode("utf-8")) == len(orig_line.encode("utf-8")),
            "source": mutated_src,
        }
        if same_len and rec["sameByteLength"]:
            tier1.append(rec)
        else:
            tier2.append(rec)

    def _slice_span(node: ast.AST) -> tuple[int, int, int] | None:
        ln = getattr(node, "lineno", None)
        end_ln = getattr(node, "end_lineno", None)
        col = getattr(node, "col_offset", None)
        end_col = getattr(node, "end_col_offset", None)
        if ln is None or end_ln is None or col is None or end_col is None:
            return None
        if ln != end_ln or ln not in executed_lines:
            return None
        if not (1 <= ln <= len(lines)):
            return None
        return ln, col, end_col

    # Avoid mutating constants directly inside range(...) to prevent runaway loops.
    range_arg_ids: set[int] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == "range":
            for a in node.args:
                for sub in ast.walk(a):
                    range_arg_ids.add(id(sub))

    for node in ast.walk(tree):
        if len(tier1) + len(tier2) >= max_candidates * 3:
            break

        if isinstance(node, ast.Compare) and len(node.ops) == 1 and len(node.comparators) == 1:
            span = _slice_span(node)
            if span is None:
                continue
            ln, col, end_col = span
            orig_line = lines[ln - 1]
            left_end = getattr(node.left, "end_col_offset", None)
            right_start = getattr(node.comparators[0], "col_offset", None)
            if left_end is None or right_start is None or left_end > right_start:
                continue
            op_region = orig_line[left_end:right_start]
            op_type = type(node.ops[0])
            if op_type in _SAME_LEN_CMP_SWAPS:
                old_op, new_op = _SAME_LEN_CMP_SWAPS[op_type]
                if old_op in op_region:
                    new_region = op_region.replace(old_op, new_op, 1)
                    new_line = orig_line[:left_end] + new_region + orig_line[right_start:]
                    _try_add(ln, new_line, f"cmp:{old_op}->{new_op}", old_op, new_op, same_len=True)
            if op_type in _BOUNDARY_CMP_SWAPS:
                old_op, new_op = _BOUNDARY_CMP_SWAPS[op_type]
                if old_op in op_region:
                    new_region = op_region.replace(old_op, new_op, 1)
                    new_line = orig_line[:left_end] + new_region + orig_line[right_start:]
                    _try_add(ln, new_line, f"cmp:{old_op.strip()}->{new_op.strip()}", old_op.strip(), new_op.strip(), same_len=False)

        elif isinstance(node, ast.BinOp) and isinstance(node.op, (ast.Add, ast.Sub)):
            span = _slice_span(node)
            if span is None:
                continue
            ln, col, end_col = span
            orig_line = lines[ln - 1]
            left_end = getattr(node.left, "end_col_offset", None)
            right_start = getattr(node.right, "col_offset", None)
            if left_end is None or right_start is None or left_end > right_start:
                continue
            op_region = orig_line[left_end:right_start]
            old_op, new_op = ("+", "-") if isinstance(node.op, ast.Add) else ("-", "+")
            if old_op in op_region:
                new_region = op_region.replace(old_op, new_op, 1)
                new_line = orig_line[:left_end] + new_region + orig_line[right_start:]
                _try_add(ln, new_line, f"binop:{old_op}->{new_op}", old_op, new_op, same_len=True)

        elif isinstance(node, ast.Constant):
            if id(node) in range_arg_ids:
                continue
            span = _slice_span(node)
            if span is None:
                continue
            ln, col, end_col = span
            orig_line = lines[ln - 1]
            seg = orig_line[col:end_col]
            if isinstance(node.value, bool):
                if seg in ("True", "False"):
                    repl = "False" if seg == "True" else "True"
                    new_line = orig_line[:col] + repl + orig_line[end_col:]
                    _try_add(ln, new_line, f"bool:{seg}->{repl}", seg, repl, same_len=False)
            elif isinstance(node.value, int) and seg.isdigit() and len(seg) == 1:
                v = node.value
                repl = str(v + 1 if v < 9 else v - 1)
                new_line = orig_line[:col] + repl + orig_line[end_col:]
                _try_add(ln, new_line, f"int:{seg}->{repl}", seg, repl, same_len=True)

        elif isinstance(node, ast.If):
            test = node.test
            span = _slice_span(test)
            if span is None:
                continue
            ln, col, end_col = span
            orig_line = lines[ln - 1]
            seg = orig_line[col:end_col]
            if seg and not seg.startswith("not "):
                new_line = orig_line[:col] + f"not ({seg})" + orig_line[end_col:]
                _try_add(ln, new_line, "if:negate", seg[:40], f"not ({seg[:34]})", same_len=False)

    # Return tier1 (same byte length!) first, then tier2.
    return (tier1 + tier2)[:max_candidates]


# ===========================================================================
# 2x Deterministic Verification Harness (PYTHONHASHSEED=101 vs 202 + Live Replay)
# ===========================================================================

class _PyWorkerClient:
    """Thread-safe persistent client for `tools/tinker-execution-py.py` with explicit PYTHONHASHSEED."""

    def __init__(self, hash_seed: str = HASH_SEED_PASS2) -> None:
        self._hash_seed = hash_seed
        self._lock = threading.Lock()
        self._seq = 0
        self._proc: subprocess.Popen[str] | None = None
        self._start()

    def _start(self) -> None:
        self._proc = subprocess.Popen(
            [sys.executable, str(_REPO_ROOT / "tools/tinker-execution-py.py")],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
            env={**os.environ, "PYTHONPATH": _TRAINING_DIR, "PYTHONHASHSEED": self._hash_seed},
        )
        health = self._raw_request("health")
        if not health.get("schema"):
            raise RuntimeError(f"Unhealthy worker: {health}")

    def _raw_request(self, op: str, **kwargs: Any) -> Any:
        assert self._proc is not None and self._proc.stdin and self._proc.stdout
        self._seq += 1
        req_id = f"req-{self._seq}"
        payload = {"id": req_id, "op": op, **kwargs}
        self._proc.stdin.write(_json_compact(payload) + "\n")
        self._proc.stdin.flush()
        line = self._proc.stdout.readline()
        if not line:
            err = self._proc.stderr.read() if self._proc.stderr else ""
            raise RuntimeError(f"Worker EOF on {op}: {err[-300:]}")
        resp = json.loads(line)
        if not resp.get("ok"):
            raise RuntimeError(f"Worker error on {op}: {resp.get('error')}")
        return resp["result"]

    def request(self, op: str, **kwargs: Any) -> Any:
        with self._lock:
            try:
                return self._raw_request(op, **kwargs)
            except Exception:
                # Auto-restart crashed worker once so a single bad task never poisons the pool.
                self.close_unlocked()
                self._start()
                raise

    def close_unlocked(self) -> None:
        if self._proc is not None:
            try:
                if self._proc.stdin:
                    self._proc.stdin.close()
                self._proc.wait(timeout=3)
            except Exception:
                try:
                    self._proc.kill()
                except Exception:
                    pass
            self._proc = None

    def close(self) -> None:
        with self._lock:
            self.close_unlocked()


def _verify_and_preexport_task(
    task: dict[str, Any],
    worker_pool: queue.Queue[_PyWorkerClient],
    forbidden: dict[str, set[str]],
    *,
    min_tokens: int,
    max_tokens: int,
    max_turn_tokens: int,
    min_files: int,
    max_files: int,
) -> tuple[dict[str, Any] | None, str | None]:
    """2x verify task (Pass 1 direct + live replay w/ seed 101; Pass 2 bridge w/ seed 202)."""
    files = task.get("files") or {}
    if not (min_files <= len(files) <= max_files):
        return None, f"file-count-out-of-bounds:{len(files)}"

    try:
        # Pass 1: Direct export_python_example (inherits parent PYTHONHASHSEED=101)
        pass1 = export_python_example(task, trace_format="compact", reasoning_channel="thinking")
        audit1 = pass1["metadata"]["traceAudit"]
        if not audit1.get("replayVerified"):
            return None, "pass1-replay-not-verified"
        if int(pass1["metadata"].get("codeLoadCalls", 0)) < 1:
            return None, "zero-code-load-calls"
        narration_lines = int(audit1.get("narrationLines", 0))
        if narration_lines < 2:
            return None, f"trace-too-short:{narration_lines}"

        msgs = pass1["messages"]
        serialized = _json_compact(msgs)
        total_tiktoken = _count_tokens(serialized)
        total_est32 = _estimate_tokens_32(serialized)
        if total_tiktoken < min_tokens:
            return None, f"tokens-below-min:{total_tiktoken}"
        if total_tiktoken > max_tokens or total_est32 > 62_500:
            return None, f"tokens-above-max:{total_tiktoken}/{total_est32}"

        max_turn_toks = 0
        for m in msgs:
            if m.get("role") == "assistant":
                t_text = assistant_thinking_text(m) + "\n" + assistant_visible_text(m)
                if isinstance(m.get("tool_calls"), list):
                    t_text += "\n" + _json_compact(m["tool_calls"])
                t_toks = _count_tokens(t_text)
                if t_toks > max_turn_toks:
                    max_turn_toks = t_toks
        if max_turn_toks > max_turn_tokens:
            return None, f"turn-too-large:{max_turn_toks}"

        # Live create_python_session step-by-step replay verification
        prepared = prepare_python_task(task, trace_format="compact")
        session = create_python_session(prepared)
        try:
            start_idx = next(i for i, m in enumerate(msgs) if m.get("role") == "user") + 1
            idx = start_idx
            while idx < len(msgs):
                m = msgs[idx]
                idx += 1
                if m.get("role") != "assistant":
                    return None, f"expected-assistant-at-{idx - 1}"
                step_res = session.step(m, 0)
                for obs in step_res["messages"]:
                    if idx >= len(msgs) or msgs[idx] != obs:
                        return None, f"live-observation-mismatch-at-{idx}"
                    idx += 1
            grade = session.grade()
            if not grade["success"]:
                return None, f"live-session-grade-failed:{grade.get('reason')}"
        finally:
            session.close()

        # Pass 2: Independent export through real JSONL bridge with DIFFERENT PYTHONHASHSEED=202!
        worker = worker_pool.get()
        try:
            pass2 = worker.request(
                "export",
                task=task,
                traceFormat="compact",
                reasoningChannel="thinking",
            )
        finally:
            worker_pool.put(worker)

        if pass1["sourceHash"] != pass2["sourceHash"]:
            return None, "nondeterministic-sourceHash"
        if pass1["messages"] != pass2["messages"]:
            return None, "nondeterministic-messages-across-hashseed"

        # Zero-leakage & Stage 10 dedup checks
        split_component = _sha256(f"{pass1['family']}:{pass1['sourceHash']}")
        if pass1["id"] in forbidden["reb_ids"]:
            return None, f"leakage-reb-id:{pass1['id']}"
        if pass1["family"] in forbidden["reb_families"]:
            return None, f"leakage-reb-family:{pass1['family']}"
        if pass1["sourceHash"] in forbidden["reb_hashes"]:
            return None, f"leakage-reb-sourceHash:{pass1['sourceHash']}"
        if split_component in forbidden["reb_splits"]:
            return None, f"leakage-reb-split:{split_component}"
        if pass1["id"] in forbidden["stage10_ids"]:
            return None, f"dup-stage10-id:{pass1['id']}"
        if pass1["sourceHash"] in forbidden["stage10_hashes"]:
            return None, f"dup-stage10-sourceHash:{pass1['sourceHash']}"

        # Collect actual loaded paths from code.load calls
        loaded_paths: set[str] = {task["entryFile"]}
        for m in msgs:
            if m.get("role") == "assistant" and isinstance(m.get("tool_calls"), list):
                for tc in m["tool_calls"]:
                    fn = tc.get("function") or {}
                    if fn.get("name") == CODE_LOAD_OPERATION:
                        raw_a = json.loads(fn.get("arguments") or "{}")
                        for req in raw_a.get("arguments") or []:
                            if isinstance(req, dict) and isinstance(req.get("path"), str):
                                loaded_paths.add(req["path"])

        if len(loaded_paths) < 2:
            return None, "insufficient-loaded-files"

        distractors = sorted(p for p in pass1["task"]["files"] if p not in loaded_paths)
        row = dict(pass1)
        row["split_component"] = split_component
        row["metadata"] = {
            **(task.get("metadata") or {}),
            **pass1["metadata"],
            "conversationChars": len(serialized),
            "tiktokenTokens": total_tiktoken,
            "estimatedTokens32": total_est32,
            "maxTurnTokens": max_turn_toks,
            "fileCount": len(pass1["task"]["files"]),
            "loadedFileCount": len(loaded_paths),
            "loadedFiles": sorted(loaded_paths),
            "distractorCount": len(distractors),
            "codeLoadCalls": int(pass1["metadata"].get("codeLoadCalls", 0)),
            "codeLoadBytes": int(pass1["metadata"].get("codeLoadBytes", 0)),
            "narrationLines": narration_lines,
            "deterministic2xVerified": True,
            "pythonHashSeeds": [HASH_SEED_PASS1, HASH_SEED_PASS2],
            "liveReplayVerified": True,
        }
        if not _is_preexported_row(row):
            return None, "invalid-preexported-row-schema"
        return row, None
    except Exception as exc:
        return None, f"verify-exc:{type(exc).__name__}:{str(exc)[:180]}"


# ===========================================================================
# Per-Repo Harvester (Modes A + B + C, Checkpointable & Fault-Tolerant)
# ===========================================================================

def _extract_final_completion(messages: list[dict[str, Any]]) -> dict[str, Any]:
    vis = assistant_visible_text(messages[-1])
    m = re.search(r"```json\s*([\s\S]*?)```", vis)
    if not m:
        return {}
    try:
        return json.loads(m.group(1))
    except Exception:
        return {}


def _harvest_one_repo(
    spec: dict[str, Any],
    *,
    cache_dir: Path,
    worker_pool: queue.Queue[_PyWorkerClient],
    forbidden: dict[str, set[str]],
    min_files: int,
    max_files: int,
    max_base_per_repo: int,
    max_mutations_per_repo: int,
    min_tokens: int,
    max_tokens: int,
    max_turn_tokens: int,
) -> dict[str, Any]:
    repo_slug = spec["repo"]
    repo_id = _slug(repo_slug.replace("/", "__"))
    pkg_hint = spec.get("package")
    domain = spec.get("domain", "general")
    lic = spec.get("license", "UNKNOWN")
    errors: list[dict[str, Any]] = []

    # Check repo/package against forbidden sets BEFORE cloning.
    for token in filter(None, [pkg_hint, repo_slug.split("/")[-1]]):
        tl = token.lower()
        if tl in forbidden["reb_pkgs"] or tl in forbidden["stage10_pkgs"]:
            return {
                "repo": repo_slug,
                "status": "skipped-forbidden",
                "rows": [],
                "errors": [{"repo": repo_slug, "stage": "filter", "error": f"forbidden package {tl}"}],
            }

    repo_dir, clone_err = _clone_repo(repo_slug, cache_dir)
    if repo_dir is None:
        return {
            "repo": repo_slug,
            "status": "clone-failed",
            "rows": [],
            "errors": [{"repo": repo_slug, "stage": "clone", "error": clone_err}],
        }

    bundle = _discover_package_bundle(repo_dir, pkg_hint, min_files=min_files)
    if bundle is None:
        return {
            "repo": repo_slug,
            "status": "no-valid-package",
            "rows": [],
            "errors": [{"repo": repo_slug, "stage": "discover", "error": f"no pure-py package with >={min_files} files"}],
        }

    pkg_name = bundle["pkgName"]
    if pkg_name.lower() in forbidden["reb_pkgs"] or pkg_name.lower() in forbidden["stage10_pkgs"]:
        return {
            "repo": repo_slug,
            "status": "skipped-forbidden-pkg",
            "rows": [],
            "errors": [{"repo": repo_slug, "stage": "filter", "error": f"discovered forbidden package {pkg_name}"}],
        }

    _, test_files = _walk_py_files(repo_dir)
    unit_inputs = extract_unit_test_inputs(repo_dir, test_files)

    candidates: list[dict[str, Any]] = []
    seen_probe_sigs: set[str] = set()
    probe_budget = 140
    probes_used = 0

    # -----------------------------------------------------------------------
    # Mode A: Real Unit-Test Call-Site Extraction
    # -----------------------------------------------------------------------
    ordered_entries = sorted(
        bundle["files"].keys(),
        key=lambda rel: (
            0 if any(
                isinstance(s, (ast.FunctionDef, ast.AsyncFunctionDef)) and s.name in unit_inputs
                for s in bundle["trees"][rel].body
            ) else 1,
            -len(bundle["edges"].get(rel, ())),
            rel,
        ),
    )

    mode_a_cands = 0
    for entry_rel in ordered_entries[:30]:
        if mode_a_cands >= max_base_per_repo * 3 or probes_used >= probe_budget // 2:
            break
        selected_files = _build_bounded_file_set(
            bundle, entry_rel=entry_rel, min_files=min_files, max_files=max_files
        )
        if selected_files is None:
            continue
        tree = bundle["trees"][entry_rel]
        mod_slug = _slug(entry_rel[:-3] if entry_rel.endswith(".py") else entry_rel)
        fn_nodes = [
            s for s in tree.body
            if isinstance(s, (ast.FunctionDef, ast.AsyncFunctionDef)) and not s.name.startswith("_") and s.name in unit_inputs
        ]
        for stmt in fn_nodes[:12]:
            if mode_a_cands >= max_base_per_repo * 3 or probes_used >= probe_budget // 2:
                break
            min_a, max_a = _fn_arity_bounds(stmt)
            kept_fn = 0
            for u_entry in unit_inputs.get(stmt.name, [])[:8]:
                if kept_fn >= 3 or probes_used >= probe_budget // 2:
                    break
                enc_args = u_entry["args"]
                enc_kwargs = u_entry.get("kwargs") or {}
                if not enc_kwargs:
                    if not (len(enc_args) >= min_a and (max_a is None or len(enc_args) <= max_a)):
                        continue
                    call_files = selected_files
                    call_entry_file = entry_rel
                    call_entry_name = stmt.name
                    call_args = enc_args
                else:
                    # Clean 6-line test-call adapter for real keyword-arg unit test calls!
                    mod_dot, _ = module_name_and_package_for(entry_rel)
                    adapter_rel = f"_oss_test_call/{mod_slug}_{stmt.name}.py"
                    adapter_src = (
                        f'"""Unit-test call-site adapter from `{u_entry["file"]}`."""\n'
                        f"from {mod_dot} import {stmt.name} as _target_fn\n\n"
                        f"def run(pos_args, kw_args):\n"
                        f"    return _target_fn(*pos_args, **kw_args)\n"
                    )
                    call_files = _build_bounded_file_set(
                        bundle,
                        entry_rel=adapter_rel,
                        extra_files={adapter_rel: adapter_src},
                        min_files=min_files,
                        max_files=max_files,
                        require_static_closure=False,
                    )
                    if call_files is None:
                        continue
                    call_entry_file = adapter_rel
                    call_entry_name = "run"
                    call_args = [enc_args, enc_kwargs]

                sig = _sha256([call_entry_file, call_entry_name, call_args])
                if sig in seen_probe_sigs:
                    continue
                seen_probe_sigs.add(sig)
                probes_used += 1
                probe = _probe_multifile(call_files, call_entry_file, call_entry_name, call_args)
                if not probe.get("ok"):
                    continue
                touched = probe.get("touchedFiles") or []
                if not touched:
                    continue
                # Skip trivial probe TypeErrors/AttributeErrors if kwarg adapter mismatched
                if probe.get("kind") == "throw":
                    val = (probe.get("result") or {}).get("value")
                    if isinstance(val, dict) and val.get("name") in ("TypeError", "AttributeError", "ImportError", "ModuleNotFoundError"):
                        continue
                recorded = probe.get("recordedCalls") or []
                uses_rand = any(c["operation"] == "platform.random" for c in recorded)
                tid = f"oss2-{repo_id}-ut-{mod_slug}-{stmt.name}-{kept_fn}"[:180]
                task = {
                    "id": tid,
                    "family": f"oss2-py:{repo_id}:ut:{mod_slug}:{stmt.name}",
                    "language": "py",
                    "files": call_files,
                    "entryFile": call_entry_file,
                    "entry": call_entry_name,
                    "args": call_args,
                    "randomMode": "tool" if uses_rand else "seeded",
                    "randomSeed": 17,
                    "fixture": {"calls": recorded},
                    "features": ["multifile-codebase", "code-load", "oss-real-repo", "oss-unit-test", "distractor-files"]
                    + (["effectful"] if recorded else []),
                    "metadata": {
                        "repo": repo_slug,
                        "repoUrl": f"https://github.com/{repo_slug}",
                        "license": lic,
                        "domain": domain,
                        "package": pkg_name,
                        "mode": "mode_a_unit_test",
                        "sourceOrigin": "oss-unit-test",
                        "testFile": u_entry["file"],
                    },
                }
                candidates.append(task)
                kept_fn += 1
                mode_a_cands += 1

    # -----------------------------------------------------------------------
    # Mode B1: Curated Cross-File Public API Probes (on real untouched repo files)
    # -----------------------------------------------------------------------
    for pspec in spec.get("api_probes") or []:
        probe_name = _slug(pspec["name"])
        entry_rel = f"_oss_probe/{probe_name}.py"
        probe_files = _build_bounded_file_set(
            bundle,
            entry_rel=entry_rel,
            extra_files={entry_rel: pspec["code"]},
            min_files=min_files,
            max_files=max_files,
            require_static_closure=False,
        )
        if probe_files is None:
            errors.append({"repo": repo_slug, "stage": "mode_b_curated", "error": f"{probe_name}: file set build failed"})
            continue
        for case_tag, raw_args in pspec.get("cases") or []:
            enc_args = encode_readable(raw_args)
            probes_used += 1
            probe = _probe_multifile(probe_files, entry_rel, "run", enc_args)
            if not probe.get("ok"):
                errors.append({"repo": repo_slug, "stage": "mode_b_curated", "error": f"{probe_name}/{case_tag}: {probe.get('error')}"})
                continue
            if probe.get("kind") == "throw":
                val = (probe.get("result") or {}).get("value")
                errors.append({"repo": repo_slug, "stage": "mode_b_curated", "error": f"{probe_name}/{case_tag}: threw {val}"})
                continue
            touched = probe.get("touchedFiles") or []
            if not touched:
                errors.append({"repo": repo_slug, "stage": "mode_b_curated", "error": f"{probe_name}/{case_tag}: 0 touched non-entry files"})
                continue
            recorded = probe.get("recordedCalls") or []
            uses_rand = any(c["operation"] == "platform.random" for c in recorded)
            tid = f"oss2-{repo_id}-api-{probe_name}-{_slug(case_tag)}"[:180]
            task = {
                "id": tid,
                "family": f"oss2-py:{repo_id}:api:{probe_name}",
                "language": "py",
                "files": probe_files,
                "entryFile": entry_rel,
                "entry": "run",
                "args": enc_args,
                "randomMode": "tool" if uses_rand else "seeded",
                "randomSeed": 17,
                "fixture": {"calls": recorded},
                "features": ["multifile-codebase", "code-load", "oss-real-repo", "oss-api-probe", "distractor-files"]
                + (["effectful"] if recorded else []),
                "metadata": {
                    "repo": repo_slug,
                    "repoUrl": f"https://github.com/{repo_slug}",
                    "license": lic,
                    "domain": domain,
                    "package": pkg_name,
                    "mode": "mode_b_api_probe",
                    "sourceOrigin": "oss-api-probe-curated",
                },
            }
            candidates.append(task)

    # -----------------------------------------------------------------------
    # Mode B2: Automatic Public Cross-File Function Probes
    # -----------------------------------------------------------------------
    if len(candidates) < max_base_per_repo * 2:
        for entry_rel in ordered_entries[:20]:
            if len(candidates) >= max_base_per_repo * 3 or probes_used >= probe_budget:
                break
            selected_files = _build_bounded_file_set(
                bundle, entry_rel=entry_rel, min_files=min_files, max_files=max_files
            )
            if selected_files is None:
                continue
            tree = bundle["trees"][entry_rel]
            mod_slug = _slug(entry_rel[:-3] if entry_rel.endswith(".py") else entry_rel)
            fn_nodes = [
                s for s in tree.body
                if isinstance(s, (ast.FunctionDef, ast.AsyncFunctionDef)) and not s.name.startswith("_")
            ]
            for stmt in fn_nodes[:10]:
                if len(candidates) >= max_base_per_repo * 3 or probes_used >= probe_budget:
                    break
                min_a, max_a = _fn_arity_bounds(stmt)
                if min_a > 3:
                    continue
                kept_fn = 0
                for raw_args in _smart_probes_for_fn(stmt, min_a, max_a)[:5]:
                    if kept_fn >= 2 or probes_used >= probe_budget:
                        break
                    enc_args = encode_readable(raw_args)
                    sig = _sha256([entry_rel, stmt.name, enc_args])
                    if sig in seen_probe_sigs:
                        continue
                    seen_probe_sigs.add(sig)
                    probes_used += 1
                    probe = _probe_multifile(selected_files, entry_rel, stmt.name, enc_args)
                    if not probe.get("ok"):
                        continue
                    if not (probe.get("touchedFiles") or []):
                        continue
                    if probe.get("kind") == "throw":
                        val = (probe.get("result") or {}).get("value")
                        if isinstance(val, dict) and val.get("name") in ("TypeError", "AttributeError", "ImportError", "ModuleNotFoundError"):
                            continue
                    recorded = probe.get("recordedCalls") or []
                    uses_rand = any(c["operation"] == "platform.random" for c in recorded)
                    tid = f"oss2-{repo_id}-auto-{mod_slug}-{stmt.name}-{kept_fn}"[:180]
                    task = {
                        "id": tid,
                        "family": f"oss2-py:{repo_id}:auto:{mod_slug}:{stmt.name}",
                        "language": "py",
                        "files": selected_files,
                        "entryFile": entry_rel,
                        "entry": stmt.name,
                        "args": enc_args,
                        "randomMode": "tool" if uses_rand else "seeded",
                        "randomSeed": 17,
                        "fixture": {"calls": recorded},
                        "features": ["multifile-codebase", "code-load", "oss-real-repo", "oss-api-probe", "distractor-files"]
                        + (["effectful"] if recorded else []),
                        "metadata": {
                            "repo": repo_slug,
                            "repoUrl": f"https://github.com/{repo_slug}",
                            "license": lic,
                            "domain": domain,
                            "package": pkg_name,
                            "mode": "mode_b_api_probe",
                            "sourceOrigin": "oss-api-probe-auto",
                        },
                    }
                    candidates.append(task)
                    kept_fn += 1

    # -----------------------------------------------------------------------
    # Verify Mode A & Mode B candidates (2x deterministic + live replay)
    # -----------------------------------------------------------------------
    # Prioritize Mode A (unit-test) and curated Mode B ahead of auto Mode B
    def _cand_priority(t: dict[str, Any]) -> tuple[int, str]:
        orig = (t.get("metadata") or {}).get("sourceOrigin", "")
        if orig == "oss-unit-test":
            return (0, t["id"])
        if orig == "oss-api-probe-curated":
            return (1, t["id"])
        return (2, t["id"])

    candidates.sort(key=_cand_priority)
    verified_base: list[dict[str, Any]] = []
    fn_counts: dict[str, int] = {}
    seen_dedup: set[tuple[str, str]] = set()

    for cand in candidates:
        if len(verified_base) >= max_base_per_repo:
            break
        fam = cand["family"]
        if fn_counts.get(fam, 0) >= 3:
            continue
        row, err = _verify_and_preexport_task(
            cand,
            worker_pool,
            forbidden,
            min_tokens=min_tokens,
            max_tokens=max_tokens,
            max_turn_tokens=max_turn_tokens,
            min_files=min_files,
            max_files=max_files,
        )
        if row is None:
            errors.append({"repo": repo_slug, "id": cand["id"], "stage": "verify", "error": err})
            continue
        input_sig = _sha256([cand["entryFile"], cand["entry"], cand["args"], cand["fixture"]])
        dkey = (row["sourceHash"], input_sig)
        if dkey in seen_dedup:
            continue
        seen_dedup.add(dkey)
        fn_counts[fam] = fn_counts.get(fam, 0) + 1
        verified_base.append(row)

    # Prefer higher-token (8K-56K) tasks if we want to rank base tasks for Mode C mutation.
    verified_base_for_mut = sorted(
        verified_base,
        key=lambda r: (
            0 if r["metadata"]["tiktokenTokens"] >= 8000 else 1,
            -r["metadata"]["loadedFileCount"],
            -r["metadata"]["tiktokenTokens"],
        ),
    )

    # -----------------------------------------------------------------------
    # Mode C: Real-World 1-Line AST-Mutation Counterfactual Pairs
    # -----------------------------------------------------------------------
    verified_mutations: list[dict[str, Any]] = []
    for base_row in verified_base_for_mut:
        if len(verified_mutations) >= max_mutations_per_repo:
            break
        base_task = base_row["task"]
        base_files = base_task["files"]
        entry_file = base_task["entryFile"]

        # Trace executed lines in non-entry files for this verified base task.
        line_probe = _probe_multifile(
            base_files,
            entry_file,
            base_task["entry"],
            base_task["args"],
            collect_lines=True,
        )
        if not line_probe.get("ok"):
            continue
        exec_lines_map: dict[str, list[int]] = line_probe.get("executedLines") or {}
        if not exec_lines_map:
            continue

        orig_comp = _extract_final_completion(base_row["messages"])
        orig_outcome_sig = _json_compact([orig_comp.get("kind"), orig_comp.get("value")])

        # Prefer internal non-__init__.py modules with rich executed lines!
        target_files = sorted(
            exec_lines_map.keys(),
            key=lambda p: (
                1 if p.endswith("/__init__.py") else 0,
                -len(exec_lines_map[p]),
                p,
            ),
        )

        mutated_found = False
        attempts = 0
        for target_rel in target_files[:6]:
            if mutated_found or attempts >= 18:
                break
            src = base_files.get(target_rel)
            if not src:
                continue
            mut_cands = _enumerate_1line_ast_mutations(src, set(exec_lines_map[target_rel]), max_candidates=12)
            for mc in mut_cands:
                if mutated_found or attempts >= 18:
                    break
                attempts += 1
                mut_files = dict(base_files)
                mut_files[target_rel] = mc["source"]

                # Quick probe with exact same entryFile + entry + args!
                mprobe = _probe_multifile(mut_files, entry_file, base_task["entry"], base_task["args"])
                if not mprobe.get("ok"):
                    continue
                mtouched = mprobe.get("touchedFiles") or []
                if target_rel not in mtouched:
                    continue
                if mprobe.get("kind") == "throw":
                    val = (mprobe.get("result") or {}).get("value")
                    if isinstance(val, dict) and val.get("name") in ("SyntaxError", "IndentationError", "ImportError", "ModuleNotFoundError", "TimeoutError"):
                        continue
                mut_probe_sig = _json_compact([mprobe.get("kind"), (mprobe.get("result") or {}).get("value")])
                if mut_probe_sig == orig_outcome_sig:
                    continue

                m_recorded = mprobe.get("recordedCalls") or []
                m_uses_rand = any(c["operation"] == "platform.random" for c in m_recorded)
                pair_id = f"oss2-mut-pair:{repo_id}:{_sha256([base_row['id'], target_rel, mc['lineno'], mc['kind']])[:10]}"
                mut_tid = f"{base_row['id']}--mut-L{mc['lineno']}"[:200]
                mut_task = {
                    "id": mut_tid,
                    "family": f"{base_row['family']}:mut",
                    "language": "py",
                    "files": mut_files,
                    "entryFile": entry_file,
                    "entry": base_task["entry"],
                    "args": base_task["args"],
                    "randomMode": "tool" if m_uses_rand else "seeded",
                    "randomSeed": 17,
                    "fixture": {"calls": m_recorded},
                    "features": sorted(set([
                        *(base_task.get("features") or []),
                        "causal-pair",
                        "oss-mutation-pair",
                    ])),
                    "metadata": {
                        "repo": repo_slug,
                        "repoUrl": f"https://github.com/{repo_slug}",
                        "license": lic,
                        "domain": domain,
                        "package": pkg_name,
                        "mode": "mode_c_mutation_pair",
                        "sourceOrigin": "oss-mutation-pair",
                        "pairId": pair_id,
                        "pairedBaseTaskId": base_row["id"],
                        "mutationFile": target_rel,
                        "mutationLine": mc["lineno"],
                        "mutationKind": mc["kind"],
                        "mutationBefore": mc["before"][:240],
                        "mutationAfter": mc["after"][:240],
                        "mutationSameByteLength": mc["sameByteLength"],
                    },
                }
                mut_row, merr = _verify_and_preexport_task(
                    mut_task,
                    worker_pool,
                    forbidden,
                    min_tokens=min_tokens,
                    max_tokens=max_tokens,
                    max_turn_tokens=max_turn_tokens,
                    min_files=min_files,
                    max_files=max_files,
                )
                if mut_row is None:
                    errors.append({"repo": repo_slug, "id": mut_tid, "stage": "verify_mut", "error": merr})
                    continue

                # Confirm verified completions genuinely differ!
                mut_comp = _extract_final_completion(mut_row["messages"])
                if _json_compact([mut_comp.get("kind"), mut_comp.get("value")]) == orig_outcome_sig:
                    continue
                if mut_row["sourceHash"] == base_row["sourceHash"]:
                    continue

                # Check whether initial prompts are 100% byte-for-byte identical (causal code.load pair!)
                b_pref = next(i for i, m in enumerate(base_row["messages"]) if m.get("role") == "user") + 1
                m_pref = next(i for i, m in enumerate(mut_row["messages"]) if m.get("role") == "user") + 1
                identical_prompt = (b_pref == m_pref) and (base_row["messages"][:b_pref] == mut_row["messages"][:m_pref])
                mut_row["metadata"]["identicalInitialPrompt"] = identical_prompt

                # Link base_row back to pair_id as well!
                base_row["metadata"]["pairId"] = pair_id
                base_row["metadata"]["pairedMutTaskId"] = mut_row["id"]
                base_row["metadata"]["identicalInitialPrompt"] = identical_prompt
                if "causal-pair" not in (base_row["task"].get("features") or []):
                    base_row["task"]["features"] = sorted(set([*(base_row["task"].get("features") or []), "causal-pair", "oss-mutation-pair-base"]))
                    base_row["metadata"]["features"] = list(base_row["task"]["features"])

                verified_mutations.append(mut_row)
                mutated_found = True

    all_rows = [*verified_base, *verified_mutations]
    return {
        "repo": repo_slug,
        "package": pkg_name,
        "domain": domain,
        "license": lic,
        "status": "ok" if all_rows else "no-verified-tasks",
        "rows": all_rows,
        "counts": {
            "mode_a": sum(1 for r in all_rows if r["metadata"].get("mode") == "mode_a_unit_test"),
            "mode_b": sum(1 for r in all_rows if r["metadata"].get("mode") == "mode_b_api_probe"),
            "mode_c": len(verified_mutations),
        },
        "errors": errors,
    }


# ===========================================================================
# Main Orchestrator & Final Zero-Leakage / Causal Audit
# ===========================================================================

def main(argv: list[str] | None = None) -> int:
    # Set deterministic Pass 1 hash seed in parent process so Pass 1 subprocesses use 101
    # while Pass 2 worker bridge uses 202.
    os.environ["PYTHONHASHSEED"] = HASH_SEED_PASS1

    parser = argparse.ArgumentParser(
        description="Scalable, fault-tolerant Real-World OSS Multi-File Python Repo Harvester (v2)."
    )
    parser.add_argument("--output-dir", default=str(DEFAULT_OUTPUT_DIR))
    parser.add_argument("--cache-dir", default=str(DEFAULT_CACHE_DIR))
    parser.add_argument("--jobs", type=int, default=10)
    parser.add_argument("--max-repos", type=int, default=0, help="Limit catalog repos (0 = all).")
    parser.add_argument("--repos", default="", help="Optional comma-separated subset of owner/repo slugs.")
    parser.add_argument("--max-base-per-repo", type=int, default=7)
    parser.add_argument("--max-mutations-per-repo", type=int, default=2)
    parser.add_argument("--min-files", type=int, default=5)
    parser.add_argument("--max-files", type=int, default=220)
    parser.add_argument("--min-tokens", type=int, default=2000)
    parser.add_argument("--max-tokens", type=int, default=56000)
    parser.add_argument("--max-turn-tokens", type=int, default=18000)
    parser.add_argument("--resume", dest="resume", action="store_true", default=True)
    parser.add_argument("--no-resume", dest="resume", action="store_false")
    parser.add_argument("--realexec-benchmark", default=str(DEFAULT_REALEXEC_BENCHMARK))
    parser.add_argument("--realexec-manifest", default=str(DEFAULT_REALEXEC_MANIFEST))
    parser.add_argument("--stage10-merged", default=str(DEFAULT_STAGE10_MERGED))
    args = parser.parse_args(argv)

    started = datetime.now(timezone.utc).isoformat()
    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    repo_cache_dir = output_dir / "repo_cache"
    repo_cache_dir.mkdir(parents=True, exist_ok=True)
    cache_dir = Path(args.cache_dir).resolve()

    forbidden = _load_forbidden_sets(
        Path(args.realexec_benchmark),
        Path(args.realexec_manifest),
        Path(args.stage10_merged),
    )

    catalog = list(REPO_CATALOG)
    if args.repos.strip():
        wanted = {r.strip().lower() for r in args.repos.split(",") if r.strip()}
        catalog = [s for s in catalog if s["repo"].lower() in wanted]
    if args.max_repos and args.max_repos > 0:
        catalog = catalog[: args.max_repos]

    print(
        f"[oss-py-scale] catalog={len(catalog)} repos | jobs={args.jobs} | "
        f"forbidden reb_ids={len(forbidden['reb_ids'])}, stage10_hashes={len(forbidden['stage10_hashes'])}",
        file=sys.stderr,
        flush=True,
    )

    # Separate cached vs pending repos for fast resume.
    repo_results: dict[str, dict[str, Any]] = {}
    pending_specs: list[dict[str, Any]] = []
    for spec in catalog:
        ckpt = repo_cache_dir / f"{_slug(spec['repo'].replace('/', '__'))}.json"
        if args.resume and ckpt.is_file():
            try:
                repo_results[spec["repo"]] = json.loads(ckpt.read_text(encoding="utf-8"))
                continue
            except Exception:
                pass
        pending_specs.append(spec)

    if repo_results:
        print(f"[oss-py-scale] resumed {len(repo_results)} cached repos; {len(pending_specs)} pending", file=sys.stderr, flush=True)

    jobs = max(1, min(12, args.jobs))
    errors_path = output_dir / "errors.jsonl"
    errors_lock = threading.Lock()

    def _log_errors(err_list: list[dict[str, Any]]) -> None:
        if not err_list:
            return
        with errors_lock:
            with errors_path.open("a", encoding="utf-8") as fh:
                for e in err_list:
                    fh.write(_json_compact(e) + "\n")

    if pending_specs:
        worker_pool: queue.Queue[_PyWorkerClient] = queue.Queue()
        workers = [_PyWorkerClient(hash_seed=HASH_SEED_PASS2) for _ in range(jobs)]
        for w in workers:
            worker_pool.put(w)

        def _run_spec(spec: dict[str, Any]) -> dict[str, Any]:
            try:
                res = _harvest_one_repo(
                    spec,
                    cache_dir=cache_dir,
                    worker_pool=worker_pool,
                    forbidden=forbidden,
                    min_files=args.min_files,
                    max_files=args.max_files,
                    max_base_per_repo=args.max_base_per_repo,
                    max_mutations_per_repo=args.max_mutations_per_repo,
                    min_tokens=args.min_tokens,
                    max_tokens=args.max_tokens,
                    max_turn_tokens=args.max_turn_tokens,
                )
            except Exception as exc:
                res = {
                    "repo": spec["repo"],
                    "status": "crash",
                    "rows": [],
                    "errors": [{"repo": spec["repo"], "stage": "unhandled", "error": f"{type(exc).__name__}: {exc}"}],
                }
            ckpt = repo_cache_dir / f"{_slug(spec['repo'].replace('/', '__'))}.json"
            try:
                ckpt.write_text(_json_compact(res), encoding="utf-8")
            except Exception:
                pass
            _log_errors(res.get("errors") or [])
            return res

        try:
            with concurrent.futures.ThreadPoolExecutor(max_workers=jobs) as pool:
                fut_map = {pool.submit(_run_spec, sp): sp for sp in pending_specs}
                done = 0
                ok_repos = sum(1 for r in repo_results.values() if r.get("rows"))
                total_rows_so_far = sum(len(r.get("rows") or []) for r in repo_results.values())
                for fut in concurrent.futures.as_completed(fut_map):
                    sp = fut_map[fut]
                    res = fut.result()
                    repo_results[sp["repo"]] = res
                    done += 1
                    n_rows = len(res.get("rows") or [])
                    if n_rows > 0:
                        ok_repos += 1
                        total_rows_so_far += n_rows
                    if done % 5 == 0 or done == len(pending_specs) or n_rows > 0:
                        c = res.get("counts") or {}
                        print(
                            f"  [{done}/{len(pending_specs)}] {sp['repo']}: status={res.get('status')} "
                            f"rows={n_rows} (A={c.get('mode_a',0)}, B={c.get('mode_b',0)}, C={c.get('mode_c',0)}) "
                            f"| cumulative repos={ok_repos}, tasks={total_rows_so_far}",
                            file=sys.stderr,
                            flush=True,
                        )
        finally:
            for w in workers:
                w.close()

    # -----------------------------------------------------------------------
    # Global Deterministic Merge, Deduplication, Zero-Leakage & Causal Audit
    # -----------------------------------------------------------------------
    final_rows: list[dict[str, Any]] = []
    seen_ids: set[str] = set()
    seen_source_input: set[tuple[str, str]] = set()
    for spec in catalog:
        res = repo_results.get(spec["repo"])
        if not res:
            continue
        for row in res.get("rows") or []:
            if not _is_preexported_row(row):
                continue
            tid = row["id"]
            if tid in seen_ids:
                continue
            t = row["task"]
            input_sig = _sha256([t["entryFile"], t["entry"], t["args"], t["fixture"]])
            dkey = (row["sourceHash"], input_sig)
            if dkey in seen_source_input:
                continue
            # Re-verify zero-leakage & Stage 10 dedup globally
            sc = row.get("split_component") or _sha256(f"{row['family']}:{row['sourceHash']}")
            row["split_component"] = sc
            if (
                tid in forbidden["reb_ids"]
                or row["family"] in forbidden["reb_families"]
                or row["sourceHash"] in forbidden["reb_hashes"]
                or sc in forbidden["reb_splits"]
                or tid in forbidden["stage10_ids"]
                or row["sourceHash"] in forbidden["stage10_hashes"]
            ):
                continue
            seen_ids.add(tid)
            seen_source_input.add(dkey)
            final_rows.append(row)

    # Zero-leakage explicit audit summary
    reb_overlap = {
        "id": sum(1 for r in final_rows if r["id"] in forbidden["reb_ids"]),
        "family": sum(1 for r in final_rows if r["family"] in forbidden["reb_families"]),
        "sourceHash": sum(1 for r in final_rows if r["sourceHash"] in forbidden["reb_hashes"]),
        "split_component": sum(1 for r in final_rows if r["split_component"] in forbidden["reb_splits"]),
        "package": sum(
            1 for r in final_rows
            if str(r["metadata"].get("package", "")).lower() in forbidden["reb_pkgs"]
        ),
    }
    stage10_overlap = {
        "id": sum(1 for r in final_rows if r["id"] in forbidden["stage10_ids"]),
        "sourceHash": sum(1 for r in final_rows if r["sourceHash"] in forbidden["stage10_hashes"]),
        "package": sum(
            1 for r in final_rows
            if str(r["metadata"].get("package", "")).lower() in forbidden["stage10_pkgs"]
        ),
    }
    assert all(v == 0 for v in reb_overlap.values()), f"RealExecBench leakage detected: {reb_overlap}"
    assert all(v == 0 for v in stage10_overlap.values()), f"Stage 10 overlap detected: {stage10_overlap}"
    assert all(_is_preexported_row(r) for r in final_rows), "Invalid pre-exported row!"

    # Run causal supervision audit on a sample of identical-prompt Mode C counterfactual pairs!
    identical_pair_ids = {
        r["metadata"]["pairId"]
        for r in final_rows
        if r["metadata"].get("mode") == "mode_c_mutation_pair" and r["metadata"].get("identicalInitialPrompt")
    }
    causal_sample_rows = [
        r for r in final_rows
        if r["metadata"].get("pairId") in sorted(identical_pair_ids)[:10]
    ]
    causal_audit_summary: dict[str, Any] = {"checkedPairs": 0, "valid": True}
    if causal_sample_rows:
        sup = audit_python_supervision(
            causal_sample_rows,
            {"formats": ["compact"], "samplePerFeature": 30},
        )
        causal_audit_summary = {
            "valid": bool(sup["valid"]),
            "allReplayed": bool(sup["allReplayed"]),
            "checkedTasks": len(causal_sample_rows),
            "causalPairsChecked": int(sup["summary"]["causalPairs"]),
            "causalDivergencesChecked": int(sup["summary"]["causalDivergencesChecked"]),
        }
        assert sup["valid"] and sup["allReplayed"], f"Causal supervision audit failed: {sup}"

    tasks_path = output_dir / "tasks.jsonl"
    tasks_path.write_text(
        "\n".join(_json_compact(r) for r in final_rows) + ("\n" if final_rows else ""),
        encoding="utf-8",
    )

    by_mode: dict[str, int] = {}
    by_origin: dict[str, int] = {}
    by_domain: dict[str, int] = {}
    by_repo: dict[str, dict[str, int]] = {}
    pair_ids_all: set[str] = set()
    mut_repos: set[str] = set()

    for r in final_rows:
        m = r["metadata"]
        mode = m.get("mode", "unknown")
        origin = m.get("sourceOrigin", "unknown")
        dom = m.get("domain", "unknown")
        repo = m.get("repo", "unknown")
        by_mode[mode] = by_mode.get(mode, 0) + 1
        by_origin[origin] = by_origin.get(origin, 0) + 1
        by_domain[dom] = by_domain.get(dom, 0) + 1
        rc = by_repo.setdefault(repo, {"total": 0, "mode_a": 0, "mode_b": 0, "mode_c": 0})
        rc["total"] += 1
        if mode == "mode_a_unit_test":
            rc["mode_a"] += 1
        elif mode == "mode_b_api_probe":
            rc["mode_b"] += 1
        elif mode == "mode_c_mutation_pair":
            rc["mode_c"] += 1
            mut_repos.add(repo)
        if m.get("pairId"):
            pair_ids_all.add(m["pairId"])

    tiktokens = [int(r["metadata"]["tiktokenTokens"]) for r in final_rows]
    est32s = [int(r["metadata"]["estimatedTokens32"]) for r in final_rows]
    turn_toks = [int(r["metadata"]["maxTurnTokens"]) for r in final_rows]
    file_counts = [int(r["metadata"]["fileCount"]) for r in final_rows]
    loaded_counts = [int(r["metadata"]["loadedFileCount"]) for r in final_rows]
    code_loads = [int(r["metadata"]["codeLoadCalls"]) for r in final_rows]
    narration_lines = [int(r["metadata"]["narrationLines"]) for r in final_rows]

    audit_report = {
        "schema": "oss-multifile-py-scale-audit/2",
        "started": started,
        "finished": datetime.now(timezone.utc).isoformat(),
        "catalogRepos": len(catalog),
        "distinctReposYielded": len(by_repo),
        "totalTasks": len(final_rows),
        "uniqueFamilies": len({r["family"] for r in final_rows}),
        "uniqueSourceHashes": len({r["sourceHash"] for r in final_rows}),
        "byMode": by_mode,
        "bySourceOrigin": by_origin,
        "byDomain": dict(sorted(by_domain.items(), key=lambda kv: (-kv[1], kv[0]))),
        "mutationCounterfactualPairs": {
            "totalPairs": len(pair_ids_all),
            "identicalInitialPromptPairs": len(identical_pair_ids),
            "distinctReposWithMutations": len(mut_repos),
            "causalSupervisionAudit": causal_audit_summary,
        },
        "distributions": {
            "tiktokenTokens": _stats(tiktokens),
            "estimatedTokens32": _stats(est32s),
            "maxTurnTokens": _stats(turn_toks),
            "fileCount": _stats(file_counts),
            "loadedFileCount": _stats(loaded_counts),
            "codeLoadCalls": _stats(code_loads),
            "narrationLines": _stats(narration_lines),
            "tasksIn8kTo56kTokens": sum(1 for t in tiktokens if 8000 <= t <= 56000),
        },
        "verification": {
            "deterministic2xAllPassed": all(r["metadata"].get("deterministic2xVerified") for r in final_rows),
            "liveReplayAllPassed": all(r["metadata"].get("liveReplayVerified") for r in final_rows),
            "preexportedSchemaAllPassed": all(_is_preexported_row(r) for r in final_rows),
            "pythonHashSeeds": [HASH_SEED_PASS1, HASH_SEED_PASS2],
            "maxTiktokenLimit": args.max_tokens,
            "maxTurnTokenLimit": args.max_turn_tokens,
        },
        "zeroLeakageAudit": {
            "passed": True,
            "realexecbenchOverlap": reb_overlap,
            "stage10Overlap": stage10_overlap,
        },
        "repos": dict(sorted(by_repo.items(), key=lambda kv: (-kv[1]["total"], kv[0]))),
        "tasksPath": str(tasks_path),
    }

    audit_path = output_dir / "audit.json"
    audit_path.write_text(json.dumps(audit_report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({
        "distinctReposYielded": audit_report["distinctReposYielded"],
        "totalTasks": audit_report["totalTasks"],
        "byMode": audit_report["byMode"],
        "mutationCounterfactualPairs": audit_report["mutationCounterfactualPairs"],
        "distributions": audit_report["distributions"],
        "zeroLeakageAudit": audit_report["zeroLeakageAudit"],
        "tasksPath": str(tasks_path),
        "auditPath": str(audit_path),
    }, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
