#!/usr/bin/env python3
"""Enumerate registered production surfaces without importing either runtime.

This is an omission and source-identity check, not semantic or migration proof.
The companion review maps these exact registrations to replacement gates.
"""
from __future__ import annotations

import argparse
import ast
import hashlib
import json
import itertools
import re
import subprocess
import tomllib
from pathlib import Path, PurePosixPath


SCHEMA = "semantic-production-route-inventory/1"


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()


class Repository:
    def __init__(self, path, revision):
        self.path = Path(path).resolve()
        self.revision = self.git("rev-parse", "--verify", revision + "^{commit}").strip()
        self.tree = self.git("rev-parse", self.revision + "^{tree}").strip()
        self.files = {}
        for row in self.git("ls-tree", "-r", "--full-tree", self.revision).splitlines():
            metadata, name = row.split("\t", 1)
            mode, kind, blob = metadata.split()
            if kind == "blob":
                self.files[name] = (mode, blob)
        self._bytes = {}

    def git(self, *args):
        return subprocess.check_output(["git", "-C", str(self.path), *args], text=True)

    def read(self, path):
        if path not in self.files or self.files[path][0] not in {"100644", "100755"}:
            raise ValueError("Not a regular tracked source: " + path)
        if path not in self._bytes:
            self._bytes[path] = subprocess.check_output(
                ["git", "-C", str(self.path), "cat-file", "blob", self.files[path][1]]
            )
        return self._bytes[path]

    def bind(self, path):
        data = self.read(path)
        return {"path": path, "gitBlob": self.files[path][1], "bytes": len(data),
                "sha256": hashlib.sha256(data).hexdigest()}

    def identity(self):
        return {"revision": self.revision, "tree": self.tree}


def package_registrations(package):
    rows = []

    def visit(value, pointer):
        if isinstance(value, str):
            rows.append({"id": "producer:package:" + pointer, "kind": "package-target",
                         "registration": "package.json", "pointer": pointer, "target": value})
        elif isinstance(value, dict):
            for key, child in value.items():
                visit(child, pointer + "/" + key.replace("~", "~0").replace("/", "~1"))
        elif isinstance(value, list):
            for index, child in enumerate(value):
                visit(child, pointer + "/" + str(index))
        elif value is not None:
            raise ValueError("Unmodeled package target at " + pointer)

    for name in ("main", "exports", "bin", "imports"):
        if name in package:
            visit(package[name], "/" + name)
    for name, command in package.get("scripts", {}).items():
        if not isinstance(command, str):
            raise ValueError("Non-string package script")
        rows.append({"id": "producer:npm:" + name, "kind": "npm-command",
                     "registration": "package.json", "name": name, "command": command})
    return rows


def cli_registrations(sources):
    """Interpret only argparse registration statements, never command bodies.

    Unknown dynamic parser names or registration helpers refuse. Literal loops
    in the actual data CLI are expanded; no subprocess or model can run here.
    """
    functions = {}
    for path, source in sources.items():
        for node in ast.parse(source, filename=path).body:
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                functions[(path, node.name)] = node
    helpers = {
        "add_data_commands": "src/megatoken/data/cli.py",
        "add_collection_commands": "src/megatoken/retrieval/cli.py",
    }
    rows = {}

    def value(node, constants):
        if isinstance(node, ast.Name) and node.id in constants:
            return constants[node.id]
        try:
            return ast.literal_eval(node)
        except (ValueError, TypeError) as error:
            raise ValueError("Unmodeled dynamic argparse registration") from error

    def registration_sensitive(statement, scopes):
        for node in ast.walk(statement):
            if isinstance(node, ast.Assign) and isinstance(node.value, ast.Name) \
                    and node.value.id in scopes:
                return True
            if not isinstance(node, ast.Call):
                continue
            if isinstance(node.func, ast.Attribute) and node.func.attr in {
                "add_parser", "add_subparsers", "set_defaults"
            }:
                return True
            if isinstance(node.func, ast.Attribute) and node.func.attr in {
                "add_argument", "add_mutually_exclusive_group", "add_argument_group"
            }:
                continue
            if any(isinstance(child, ast.Name) and child.id in scopes
                   for argument in [*node.args, *(item.value for item in node.keywords)]
                   for child in ast.walk(argument)):
                return True
            if isinstance(node.func, ast.Name) and node.func.id in helpers:
                return True
        return False

    def walk(statements, path, scopes, constants):
        for statement in statements:
            if isinstance(statement, ast.For):
                if not registration_sensitive(statement, scopes):
                    continue
                if not isinstance(statement.target, ast.Name):
                    raise ValueError("Unmodeled argparse loop binding")
                for item in value(statement.iter, constants):
                    walk(statement.body, path, scopes, {**constants, statement.target.id: item})
                if statement.orelse:
                    raise ValueError("Unmodeled argparse loop else")
                continue
            call = statement.value if isinstance(statement, (ast.Assign, ast.Expr)) else None
            if isinstance(statement, ast.Assign) and isinstance(statement.value, ast.Name) \
                    and statement.value.id in scopes:
                raise ValueError("Parser aliases require explicit inventory support")
            if isinstance(call, ast.Call) and isinstance(call.func, ast.Name):
                name = call.func.id
                if name in helpers:
                    if len(call.args) != 1 or not isinstance(call.args[0], ast.Name):
                        raise ValueError("Unmodeled parser helper arguments")
                    helper_path = helpers[name]
                    function = functions[(helper_path, name)]
                    walk(function.body, helper_path,
                         {function.args.args[0].arg: scopes[call.args[0].id]}, constants)
                elif name.startswith("add_") and name.endswith("commands"):
                    raise ValueError("Unreviewed parser registration helper: " + name)
                elif registration_sensitive(statement, scopes):
                    helper = functions.get((path, name))
                    if helper is None or any(
                        isinstance(child, ast.Call) and isinstance(child.func, ast.Attribute)
                        and child.func.attr in {"add_parser", "add_subparsers", "set_defaults"}
                        for child in ast.walk(helper)
                    ):
                        raise ValueError("Unreviewed parser helper: " + name)
            if not (isinstance(call, ast.Call) and isinstance(call.func, ast.Attribute)):
                if not isinstance(statement, (ast.Assign, ast.Expr)) \
                        and registration_sensitive(statement, scopes):
                    raise ValueError("Nested command registration needs explicit review")
                if isinstance(call, ast.Call) and not isinstance(call.func, ast.Name) \
                        and registration_sensitive(statement, scopes):
                    raise ValueError("Dynamic parser call needs explicit review")
                continue
            action = call.func.attr
            receiver = call.func.value
            if not isinstance(receiver, ast.Name):
                if action in {"add_parser", "add_subparsers", "set_defaults"}:
                    raise ValueError("Unmodeled argparse receiver")
                continue
            result = None
            if action == "ArgumentParser":
                result = ["megatoken"]
            elif action == "add_subparsers":
                result = scopes[receiver.id]
            elif action == "add_parser":
                if any(keyword.arg == "aliases" for keyword in call.keywords):
                    raise ValueError("CLI aliases require explicit inventory support")
                name = value(call.args[0], constants)
                if not isinstance(name, str) or not name:
                    raise ValueError("Invalid parser name")
                result = [*scopes[receiver.id], name]
                identity = "native:cli:" + " ".join(result)
                if identity in rows:
                    raise ValueError("Duplicate CLI registration: " + identity)
                rows[identity] = {"id": identity, "kind": "native-cli", "registration": path,
                                  "command": result, "handler": None}
            elif action == "set_defaults" and receiver.id in scopes:
                for keyword in call.keywords:
                    if keyword.arg == "func":
                        if not isinstance(keyword.value, ast.Name):
                            raise ValueError("Unmodeled CLI handler")
                        identity = "native:cli:" + " ".join(scopes[receiver.id])
                        rows[identity]["handler"] = keyword.value.id
            elif action not in {"add_argument", "add_mutually_exclusive_group", "add_argument_group"} \
                    and (receiver.id in scopes or registration_sensitive(statement, scopes)):
                raise ValueError("Unreviewed parser method or helper: " + action)
            if result is not None:
                if not isinstance(statement, ast.Assign) or len(statement.targets) != 1 \
                        or not isinstance(statement.targets[0], ast.Name):
                    raise ValueError("Unmodeled parser assignment")
                scopes[statement.targets[0].id] = result

    path = "src/megatoken/cli.py"
    walk(functions[(path, "parser")].body, path, {}, {})
    return list(rows.values())


def rpc_registrations(source, path):
    operations, methods = set(), set()
    tree = ast.parse(source, filename=path)
    normalized = any(isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
                     and isinstance(node.func.value, ast.Name) and node.func.value.id == "operation"
                     and node.func.attr == "replace" and len(node.args) == 2
                     and all(isinstance(arg, ast.Constant) for arg in node.args)
                     and [arg.value for arg in node.args] == ["-", "_"] for node in ast.walk(tree))
    for node in ast.walk(tree):
        if isinstance(node, ast.Compare) and isinstance(node.left, ast.Name) \
                and node.left.id in {"op", "operation"}:
            for comparator in node.comparators:
                if isinstance(comparator, ast.Constant) and isinstance(comparator.value, str):
                    operations.add(comparator.value)
                elif isinstance(comparator, (ast.Set, ast.Tuple, ast.List)):
                    for item in comparator.elts:
                        if not isinstance(item, ast.Constant) or not isinstance(item.value, str):
                            raise ValueError("Dynamic RPC operation requires explicit review")
                        operations.add(item.value)
        if isinstance(node, ast.DictComp):
            for generator in node.generators:
                if isinstance(generator.target, ast.Name) and generator.target.id == "name" \
                        and isinstance(generator.iter, (ast.Tuple, ast.List)):
                    registered = ast.literal_eval(generator.iter)
                    operations.update(registered)
                    methods.update(registered)
    if not operations or any(not isinstance(name, str) for name in operations):
        raise ValueError("No exact static RPC operations found")
    rows = []
    for name in sorted(operations):
        spellings = {name}
        if normalized and name in methods:
            parts = name.split("_")
            for separators in itertools.product(("-", "_"), repeat=len(parts) - 1):
                spellings.add(parts[0] + "".join(separator + part for separator, part in zip(separators, parts[1:])))
        rows.append({"id": "native:rpc:" + path + ":" + name, "kind": "native-jsonl-operation",
                     "registration": path, "operation": name, "acceptedSpellings": sorted(spellings)})
    return rows


def collect(producer, native):
    package = json.loads(producer.read("package.json"))
    rows = package_registrations(package)
    for row in rows:
        if row["kind"] == "package-target":
            target = row["target"]
            if not target.startswith("./") or ".." in PurePosixPath(target).parts:
                raise ValueError("Package target requires explicit local-file review")
            row["targetSource"] = producer.bind(target[2:])
    for command in re.findall(r"command\s*===\s*['\"]([^'\"]+)['\"]", producer.read("bin/tracing.js").decode()):
        rows.append({"id": "producer:cli:" + command, "kind": "owned-runtime-cli",
                     "registration": "bin/tracing.js", "command": command})
    project = tomllib.loads(native.read("pyproject.toml").decode())
    for name, target in project["project"].get("scripts", {}).items():
        module, function = target.split(":")
        rows.append({"id": "native:console:" + name, "kind": "python-console",
                     "registration": "pyproject.toml", "target": target,
                     "targetSource": native.bind("src/" + module.replace(".", "/") + ".py")})
    cli_paths = ["src/megatoken/cli.py", "src/megatoken/data/cli.py", "src/megatoken/retrieval/cli.py"]
    rows.extend(cli_registrations({path: native.read(path).decode() for path in cli_paths}))
    for path in sorted(native.files):
        if not path.startswith("src/megatoken/") or not path.endswith(".py"):
            continue
        source = native.read(path)
        if b"__main__" not in source:
            continue
        tree = ast.parse(source, filename=path)
        if any(isinstance(node, ast.If) and isinstance(node.test, ast.Compare)
               and isinstance(node.test.left, ast.Name) and node.test.left.id == "__name__"
               and len(node.test.ops) == 1 and isinstance(node.test.ops[0], ast.Eq)
               and len(node.test.comparators) == 1
               and isinstance(node.test.comparators[0], ast.Constant)
               and node.test.comparators[0].value == "__main__" for node in tree.body):
            module = path[4:-3].replace("/", ".")
            rows.append({"id": "native:module:" + module, "kind": "python-module-entry",
                         "registration": path, "module": module})
    for path in ("scripts/serve_selected_semantic.py", "scripts/serve_semantic_v8.py"):
        rows.extend(rpc_registrations(native.read(path).decode(), path))
    recipe_path = "src/megatoken/data/recipes.py"
    for node in ast.parse(native.read(recipe_path)).body:
        if isinstance(node, ast.Assign) and len(node.targets) == 1 \
                and isinstance(node.targets[0], ast.Name):
            name = node.targets[0].id
            if name not in {"STREAM_PRODUCERS", "SEMANTIC_STREAM_PRODUCERS"}:
                continue
            registry = ast.literal_eval(node.value)
            versions = {"default": registry} if name == "STREAM_PRODUCERS" else registry
            for version, producers in versions.items():
                for stream, target in producers.items():
                    rows.append({"id": f"native:stream:{version}:{stream}", "kind": "stream-producer",
                                 "registration": recipe_path, "version": version, "stream": stream,
                                 "target": target})
    stage_path = "src/megatoken/data/stages.json"
    stages = json.loads(native.read(stage_path))
    for name, stage in stages["phases"].items():
        rows.append({"id": "native:stage:" + name, "kind": "training-stage",
                     "registration": stage_path, "name": name, "definition": stage})
    for row in rows:
        owner = producer if row["id"].startswith("producer:") else native
        row["registrationSource"] = owner.bind(row["registration"])
    ids = [row["id"] for row in rows]
    if len(set(ids)) != len(ids):
        raise ValueError("Duplicate discovered route identity")
    catalogs = {}
    for label, repo, roots in (
        ("producer", producer, ("bin/", "scripts/", "tools/", ".github/workflows/")),
        ("native", native, ("scripts/", "configs/", ".github/workflows/")),
    ):
        catalogs[label] = [repo.bind(path) for path in sorted(repo.files)
                           if path.startswith(roots) and path.endswith((".py", ".js", ".mjs", ".sh", ".yml", ".yaml", ".json"))
                           and "/node_modules/" not in path and not path.startswith("tools/spec-oracle/")]
    data = {"schema": SCHEMA, "sources": {"producer": producer.identity(), "native": native.identity()},
            "scope": {"registrations": ["all package export conditions, imports, bins and npm scripts",
                      "owned-runtime CLI, Python console/module entries, complete registered native argparse hierarchy",
                      "both semantic JSONL operation tables, all stream producers and training stages"],
                      "catalogs": "All tracked executable/configuration/workflow candidates in the declared roots",
                      "excluded": ["individual public symbols behind a package entry", "arbitrary embedding callers",
                                   "external deployment configuration", "vendor spec-oracle tree"],
                      "semanticParityQualified": False, "defaultCutoverQualified": False},
            "registrations": sorted(rows, key=lambda row: row["id"]), "fileCatalogs": catalogs,
            "sharedTrainingDefaults": stages["training_defaults"],
            "supplementalInputs": {
                "producer": [producer.bind(path) for path in (
                    "npm-shrinkwrap.json", "profiles/release-environment.lock.json",
                    "profiles/targets.lock.json", "tools/native-consumer/requirements.lock",
                    "tools/native-consumer/requirements.in", "contracts/semantic-integration-lock.json",
                    "contracts/native-admission-policy-v6.json", "contracts/semantic-native-policy-v7.json",
                    "contracts/semantic-native-policy-v8.json")],
                "native": [native.bind("Dockerfile"), native.bind("pyproject.toml")],
            }}
    data["digest"] = hashlib.sha256(canonical(data)).hexdigest()
    return data


def verify(expected, actual):
    if expected != actual:
        old = {row["id"]: row for row in expected.get("registrations", [])}
        new = {row["id"]: row for row in actual.get("registrations", [])}
        detail = {"added": sorted(new.keys() - old.keys()), "removed": sorted(old.keys() - new.keys()),
                  "changed": sorted(key for key in old.keys() & new.keys() if old[key] != new[key]),
                  "sourceOrCatalogChanged": expected.get("sources") != actual.get("sources")
                     or expected.get("fileCatalogs") != actual.get("fileCatalogs")
                     or expected.get("supplementalInputs") != actual.get("supplementalInputs")
                     or expected.get("sharedTrainingDefaults") != actual.get("sharedTrainingDefaults")}
        raise ValueError("Source-bound route inventory differs: " + json.dumps(detail, sort_keys=True))
    return {"schema": "semantic-production-route-audit/1", "inventoryDigest": actual["digest"],
            "registrations": len(actual["registrations"]),
            "catalogFiles": {key: len(value) for key, value in actual["fileCatalogs"].items()},
            "additionalRpcSpellings": sum(len(row.get("acceptedSpellings", [])) - 1
                 for row in actual["registrations"] if row["kind"] == "native-jsonl-operation"),
            "supplementalInputs": {key: len(value) for key, value in actual.get("supplementalInputs", {}).items()},
            "missingOrUnexpectedRegistrations": 0, "semanticParityQualified": False,
            "defaultCutoverQualified": False}


def verify_review(review, inventory):
    if review.get("schema") != "semantic-production-route-review/1" \
            or review.get("inventoryDigest") != inventory["digest"] \
            or review.get("semanticParityQualified") is not False \
            or review.get("defaultCutoverQualified") is not False:
        raise ValueError("Route review does not bind this exact unqualified inventory")
    seen, groups = set(), set()
    allowed = {"shared-retain", "legacy-active", "mixed-active", "v8-opt-in"}
    for group in review.get("groups", []):
        if not isinstance(group.get("id"), str) or group["id"] in groups \
                or group.get("disposition") not in allowed \
                or not isinstance(group.get("purpose"), str) or not group["purpose"] \
                or not isinstance(group.get("remainingGate"), str) or not group["remainingGate"] \
                or group.get("semanticParityQualified") is not False:
            raise ValueError("Invalid, duplicate or overclaiming reviewed route group")
        groups.add(group["id"])
        ids = group.get("registrationIds")
        if not isinstance(ids, list) or not ids or any(not isinstance(key, str) for key in ids) \
                or len(ids) != len(set(ids)) or seen.intersection(ids):
            raise ValueError("Missing or duplicate registration ownership")
        seen.update(ids)
    if seen != {row["id"] for row in inventory["registrations"]}:
        raise ValueError("Review omitted or invented a discovered registration")
    return {"reviewedGroups": len(groups), "classifiedRegistrations": len(seen),
            "semanticParityQualified": False, "defaultCutoverQualified": False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--producer", type=Path, required=True)
    parser.add_argument("--native", type=Path, required=True)
    parser.add_argument("--producer-revision", required=True)
    parser.add_argument("--native-revision", required=True)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--write", type=Path)
    mode.add_argument("--verify", type=Path)
    parser.add_argument("--review", type=Path, help="Check complete reviewed ownership of the exact inventory")
    args = parser.parse_args()
    data = collect(Repository(args.producer, args.producer_revision), Repository(args.native, args.native_revision))
    if args.write:
        args.write.parent.mkdir(parents=True, exist_ok=True)
        args.write.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n")
        report = verify(data, data)
    else:
        report = verify(json.loads(args.verify.read_text()), data)
    if args.review:
        report.update(verify_review(json.loads(args.review.read_text()), data))
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
