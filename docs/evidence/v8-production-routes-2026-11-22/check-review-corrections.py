#!/usr/bin/env python3
"""Recheck the reproduced discovery gaps with the frozen real dispatch table."""
import argparse
import ast
import importlib.util
import itertools
import json
import subprocess
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--producer", type=Path, required=True)
parser.add_argument("--native", type=Path, required=True)
args = parser.parse_args()
directory = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("corrected_route_audit", args.producer / "tools/audit-production-routes-v8.py")
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)
source = subprocess.check_output([
    "git", "-C", str(args.native), "show",
    "6ef4794048a4d2ab0e732ccfd61c5cc3e7c3c822:scripts/serve_semantic_v8.py"
], text=True)
node = next(row for row in ast.parse(source).body if isinstance(row, ast.FunctionDef) and row.name == "_dispatch")
namespace = {}
exec(compile(ast.fix_missing_locations(ast.Module(body=[node], type_ignores=[])), "<frozen-dispatch-only>", "exec"), namespace)


class FakeAdapter:
    def __getattr__(self, name):
        return lambda **arguments: name


inventory = json.loads((directory / "registered-surfaces-corrected.json").read_text())
rows = [row for row in inventory["registrations"] if row.get("registration") == "scripts/serve_semantic_v8.py"]
aliases = {}
for row in rows:
    name = row["operation"]
    if "_" not in name:
        continue
    for spelling in row["acceptedSpellings"]:
        result = namespace["_dispatch"](FakeAdapter(), {"id": "inventory-check", "op": spelling})
        if result != name:
            raise ValueError("Frozen dispatcher maps a spelling to another method")
        if spelling != name:
            aliases[spelling] = result
red = json.loads((directory / "independent-review-red.json").read_text())
if aliases != red["acceptedUnenumeratedWireSpellings"]:
    raise ValueError("The previously omitted spelling set differs")
template = """
def parser():
    root = argparse.ArgumentParser()
    commands = root.add_subparsers()
    first = commands.add_parser('train')
    BODY
    return root
"""
cases = {
    "conditional-helper": "if flag:\n        register_more(commands)",
    "loop-helper": "for value in ('extra',):\n        register_more(commands)",
    "try-registration": "try:\n        second = commands.add_parser('second')\n    except RuntimeError:\n        pass",
}
refused = []
for name, body in cases.items():
    try:
        audit.cli_registrations({"src/megatoken/cli.py": template.replace("BODY", body)})
    except ValueError:
        refused.append(name)
    else:
        raise ValueError("Previously missed nested registration was accepted: " + name)
print(json.dumps({"schema": "production-route-review-corrections/1", "inventoryDigest": inventory["digest"],
                  "acceptedSpellingsNowEnumerated": aliases, "unknownRegistrationFormsRefused": refused,
                  "nativeModelsLoaded": 0, "commandHandlersDispatched": 0, "hostDispatches": 0,
                  "semanticParityQualified": False}, indent=2, sort_keys=True))
