#!/usr/bin/env python3
"""Compare the independently constructed real parser, without dispatching it."""
import argparse
import inspect
import json
import subprocess
import sys
from pathlib import Path

options = argparse.ArgumentParser(description=__doc__)
options.add_argument("--native", type=Path, required=True)
args = options.parse_args()
root = args.native.resolve()
inventory = json.loads(Path(__file__).with_name("registered-surfaces.json").read_text())
revision = subprocess.check_output(["git", "-C", str(root), "rev-parse", "HEAD"], text=True).strip()
if revision != inventory["sources"]["native"]["revision"]:
    raise ValueError("Live parser must use the exact retained native revision")
if subprocess.check_output(["git", "-C", str(root), "status", "--porcelain", "--untracked-files=no"], text=True):
    raise ValueError("Live parser source must be clean")
sys.path.insert(0, str(root / "src"))
from megatoken.cli import parser

if Path(inspect.getfile(parser)).resolve() != root / "src/megatoken/cli.py":
    raise ValueError("Imported parser came from another checkout")
actual = {}


def walk(current, prefix):
    for action in current._actions:
        if isinstance(action, argparse._SubParsersAction):
            for name, child in action.choices.items():
                path = [*prefix, name]
                actual["native:cli:" + " ".join(path)] = {
                    "command": path, "handler": getattr(child.get_default("func"), "__name__", None)
                }
                walk(child, path)


walk(parser(), ["megatoken"])
expected = {row["id"]: {"command": row["command"], "handler": row["handler"]}
            for row in inventory["registrations"] if row["kind"] == "native-cli"}
if actual != expected:
    raise ValueError("Actual CLI registration or handler differs from static inventory")
print(json.dumps({"schema": "native-live-cli-registration-audit/1", "nativeRevision": revision,
                  "parserCommands": len(actual), "missing": 0, "unexpected": 0,
                  "handlerMismatches": 0, "dispatchedCommands": 0,
                  "semanticParityQualified": False}, indent=2))
