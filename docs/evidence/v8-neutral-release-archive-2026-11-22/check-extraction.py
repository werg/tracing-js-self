"""Compare frozen pre-extraction source with the executed neutral archive core."""

from __future__ import annotations

import argparse
import ast
import copy
import hashlib
import importlib.util
import inspect
import json
import platform
import subprocess
import sys
import tempfile
from pathlib import Path

PACKAGE_NAMES = (
    "digest",
    "canonical",
    "archive_name",
    "inside",
    "hash_stream",
    "file_identity",
    "file_receipt",
    "HashingReader",
    "validate_inventory",
    "inventory",
    "write_archive",
    "verify_archive",
    "read_bounded",
    "read_json",
    "write_json",
)
RESTORE_NAMES = (
    "no_symlinks",
    "bounded_tar",
    "bounded_inventory",
    "verify_restored_files",
    "extract_verified",
)
SOURCE_PATHS = (
    "tools/release_archive.py",
    "tools/package-semantic-release.py",
    "tools/restore-semantic-release.py",
    "tools/package-audit-supplement.py",
    "tools/native-consumer/test_release_archive.py",
)


def read_git(root, revision, path):
    return subprocess.check_output(["git", "show", revision + ":" + path], cwd=root)


def identity(raw):
    return {"bytes": len(raw), "sha256": hashlib.sha256(raw).hexdigest()}


def definitions(raw):
    return {
        node.name: node
        for node in ast.parse(raw).body
        if isinstance(node, (ast.FunctionDef, ast.ClassDef))
    }


class Namespace(ast.NodeTransformer):
    def visit_Attribute(self, node):
        node = self.generic_visit(node)
        if isinstance(node.value, ast.Name) and node.value.id == "release":
            return ast.Name(id=node.attr, ctx=node.ctx)
        return node


class OriginalManifestLimit(ast.NodeTransformer):
    def visit_Name(self, node):
        if node.id == "max_manifest_bytes":
            node.id = "MAX_MANIFEST_BYTES"
        return node


class ReceiptAdditions(ast.NodeTransformer):
    def visit_Expr(self, node):
        if isinstance(node.value, ast.Call):
            function = node.value.func
            if (
                isinstance(function, ast.Name)
                and function.id == "archive_implementation_receipts"
            ):
                return None
            if (
                isinstance(function, ast.Attribute)
                and function.attr == "archive_implementation_receipts"
            ):
                return None
        return self.generic_visit(node)

    def visit_List(self, node):
        node = self.generic_visit(node)
        node.elts = [
            item
            for item in node.elts
            if not isinstance(item, ast.Constant)
            or item.value not in {"release_archive.py", "tools/release_archive.py"}
        ]
        return node

    visit_Tuple = visit_List


def canonical_node(node):
    return ast.dump(node, include_attributes=False)


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline-root", type=Path, required=True)
    parser.add_argument("--current-root", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    baseline = "28dcdbaba8c59ececba4c62de98baeb6cce551b3"
    current = "56841b15dc8440dc015495d8e681c851774696c3"
    root, original_root = args.current_root.resolve(), args.baseline_root.resolve()
    assert (
        subprocess.check_output(
            ["git", "rev-parse", "HEAD"], cwd=original_root, text=True
        ).strip()
        == baseline
    )
    source_map = {}
    for path in SOURCE_PATHS:
        actual = (root / path).read_bytes()
        assert actual == read_git(root, current, path), path
        source_map[path] = identity(actual)
    original_package = definitions(
        read_git(root, baseline, "tools/package-semantic-release.py")
    )
    original_restore = definitions(
        read_git(root, baseline, "tools/restore-semantic-release.py")
    )
    helper = definitions((root / "tools/release_archive.py").read_bytes())
    moved = []
    for names, original, namespace in (
        (PACKAGE_NAMES, original_package, False),
        (RESTORE_NAMES, original_restore, True),
    ):
        for name in names:
            before, after = copy.deepcopy(original[name]), copy.deepcopy(helper[name])
            if namespace:
                before = Namespace().visit(before)
            if name in {"write_archive", "verify_archive"}:
                assert after.args.kwonlyargs[-1].arg == "max_manifest_bytes"
                assert (
                    isinstance(after.args.kw_defaults[-1], ast.Constant)
                    and after.args.kw_defaults[-1].value is None
                )
                after.args.kwonlyargs.pop()
                after.args.kw_defaults.pop()
                initializer = after.body.pop(1)
                assert isinstance(initializer, ast.If)
                assert (
                    ast.unparse(initializer)
                    == "if max_manifest_bytes is None:\n    max_manifest_bytes = MAX_MANIFEST_BYTES"
                )
                after = OriginalManifestLimit().visit(after)
            assert canonical_node(before) == canonical_node(after), name
            moved.append(
                {
                    "name": name,
                    "originalNamespaceRemoved": namespace,
                    "explicitManifestLimitParameterAdded": name
                    in {"write_archive", "verify_archive"},
                    "coreAstEqual": True,
                }
            )
    unchanged = []
    for path, original, excluded in (
        ("tools/package-semantic-release.py", original_package, set(PACKAGE_NAMES)),
        ("tools/restore-semantic-release.py", original_restore, set(RESTORE_NAMES)),
    ):
        actual = definitions((root / path).read_bytes())
        for name in original.keys() - excluded:
            before, after = copy.deepcopy(original[name]), copy.deepcopy(actual[name])
            if name in {"package_release", "restore_release"}:
                after = ReceiptAdditions().visit(after)
            assert canonical_node(before) == canonical_node(after), path + ":" + name
            unchanged.append(
                {
                    "path": path,
                    "name": name,
                    "semanticAstUnchangedExceptHelperProvenance": True,
                }
            )
    imports = []
    for node in ast.walk(ast.parse((root / "tools/release_archive.py").read_bytes())):
        if isinstance(node, ast.Import):
            imports.extend(alias.name.split(".")[0] for alias in node.names)
        elif isinstance(node, ast.ImportFrom):
            imports.append(node.module.split(".")[0])
        elif isinstance(node, ast.Call) and isinstance(node.func, ast.Name):
            assert node.func.id not in {"exec", "eval", "__import__"}
    assert set(imports) <= sys.stdlib_module_names
    old_package = load(
        "old_archive_package", original_root / "tools/package-semantic-release.py"
    )
    new_package = load(
        "new_archive_package", root / "tools/package-semantic-release.py"
    )
    old_restore = load(
        "old_archive_restore", original_root / "tools/restore-semantic-release.py"
    )
    new_restore = load(
        "new_archive_restore", root / "tools/restore-semantic-release.py"
    )
    signatures = []
    for names, old, new in (
        (PACKAGE_NAMES, old_package, new_package),
        (RESTORE_NAMES, old_restore, new_restore),
    ):
        for name in names:
            assert inspect.signature(getattr(old, name)) == inspect.signature(
                getattr(new, name)
            ), name
            signatures.append(
                {"name": name, "signature": str(inspect.signature(getattr(new, name)))}
            )
    cli = []
    for filename in ("package-semantic-release.py", "restore-semantic-release.py"):
        commands = [
            [sys.executable, "-B", str(directory / "tools" / filename), "--help"]
            for directory in (original_root, root)
        ]
        outputs = [
            subprocess.run(command, capture_output=True, timeout=30, check=True).stdout
            for command in commands
        ]
        assert outputs[0] == outputs[1], filename
        cli.append(
            {
                "path": "tools/" + filename,
                "helpBytesIdentical": True,
                **identity(outputs[0]),
            }
        )
    with tempfile.TemporaryDirectory(
        prefix="neutral-archive-equivalence-"
    ) as temporary:
        directory = Path(temporary)
        inputs = directory / "inputs"
        inputs.mkdir()
        (inputs / "row.json").write_text('{"original":"\u03bb","outcome":"throw"}\n')
        (inputs / "private.bin").write_bytes(b"\x00\xffretained\x00")
        old_inventory, old_sources = old_package.inventory({"inputs": inputs})
        new_inventory, new_sources = new_package.inventory({"inputs": inputs})
        assert old_inventory == new_inventory
        payload = {
            "schema": "semantic-private-release/1",
            "producerRevision": "a" * 40,
            "files": old_inventory,
        }
        old_archive, new_archive = directory / "old.tar.gz", directory / "new.tar.gz"
        assert old_package.write_archive(
            old_archive, payload, old_sources
        ) == new_package.write_archive(new_archive, payload, new_sources)
        assert old_archive.read_bytes() == new_archive.read_bytes()
        sha = old_package.file_receipt(old_archive)["sha256"]
        old_verified = old_restore.verify_before_restore(old_archive, sha)
        new_verified = new_restore.verify_before_restore(new_archive, sha)
        assert old_verified == new_verified
        old_target, new_target = directory / "restored-old", directory / "restored-new"
        assert old_restore.extract_verified(
            old_archive, old_target, old_verified
        ) == new_restore.extract_verified(new_archive, new_target, new_verified)
        for path in old_target.rglob("*"):
            counterpart = new_target / path.relative_to(old_target)
            assert path.stat().st_mode & 0o777 == counterpart.stat().st_mode & 0o777
            if path.is_file():
                assert path.read_bytes() == counterpart.read_bytes()
        equivalence = {
            "deterministicArchiveBytes": identity(old_archive.read_bytes()),
            "inventoryAndVerificationEqual": True,
            "extractedBytesAndModesEqual": True,
        }
        (directory / "result.json").write_text('{"status":"complete"}\n')
        rows, _ = old_package.inventory({"result.json": directory / "result.json"})
        selection = {
            "schema": "semantic-audit-supplement-selection/1",
            "qualifications": [
                {
                    "name": "historical-control",
                    "status": "complete",
                    "completionReceipt": "result.json",
                }
            ],
            "currentQualification": "historical-control",
            "packagerSha256": old_package.file_receipt(
                original_root / "tools/package-semantic-release.py"
            )["sha256"],
            "files": [{**row, "group": "control"} for row in rows],
            "alreadyDeliveredReferences": [],
            "exclusions": [],
        }
        selection_path, notes = directory / "selection.json", directory / "README.md"
        selection_path.write_text(json.dumps(selection))
        notes.write_text("Controlled historical standalone packager fixture.\n")
        process = subprocess.run(
            [
                sys.executable,
                "-B",
                str(root / "tools/package-audit-supplement.py"),
                "--workspace",
                str(directory),
                "--selection",
                str(selection_path),
                "--notes",
                str(notes),
                "--packager",
                str(original_root / "tools/package-semantic-release.py"),
                "--out",
                str(directory / "audit"),
            ],
            capture_output=True,
            text=True,
            timeout=30,
            check=True,
        )
        old_audit = json.loads(process.stdout)
        assert (
            old_audit["status"] == "verified"
            and old_audit["packagerImplementationFiles"] == {}
        )
    report = {
        "schema": "neutral-release-archive-extraction-review/1",
        "baselineRevision": baseline,
        "executedLocalRevision": current,
        "publishedEquivalentRevision": "99472fc4461fa0d37cea75fc62b40ae593b788a6",
        "executedTree": subprocess.check_output(
            ["git", "rev-parse", current + "^{tree}"], cwd=root, text=True
        ).strip(),
        "runtime": {"python": platform.python_version()},
        "movedFunctions": moved,
        "semanticWrapperFunctions": sorted(
            unchanged, key=lambda row: (row["path"], row["name"])
        ),
        "preservedPublicSignatures": signatures,
        "stdlibOnlyHelperImports": sorted(set(imports)),
        "cli": cli,
        "behaviorEquivalence": equivalence,
        "actualHistoricalStandaloneAuditReceipt": old_audit,
        "sourceMap": source_map,
        "probe": identity(Path(__file__).read_bytes()),
        "semanticAdmissionPerformed": False,
        "optimizerUpdates": 0,
        "learnedSuccess": None,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2, allow_nan=False) + "\n")
    print(
        json.dumps(
            {
                "status": "passed",
                "movedFunctions": len(moved),
                "semanticWrapperFunctions": len(unchanged),
                "publicSignatures": len(signatures),
                "optimizerUpdates": 0,
            }
        )
    )


if __name__ == "__main__":
    main()
