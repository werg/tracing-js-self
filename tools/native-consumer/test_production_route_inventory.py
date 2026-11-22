"""The inventory must expose omissions and refuse unknown registration forms."""
import copy
import importlib.util
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    "route_audit", Path(__file__).resolve().parents[1] / "audit-production-routes-v8.py"
)
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)


class RegistrationInventoryTests(unittest.TestCase):
    def test_package_conditions_types_and_fallbacks_all_remain_visible(self):
        rows = audit.package_registrations({
            "exports": {".": {"browser": "./browser.js", "default": ["./node.js", None]},
                        "./native": {"types": "./native.d.ts", "default": "./native.js"}},
            "bin": {"run": "./bin/run.js"}, "scripts": {"train": "node tools/train.mjs"},
            "imports": {"#platform": {"node": "./node.js"}},
        })
        self.assertEqual(len(rows), 7)
        self.assertEqual(len({row["id"] for row in rows}), 7)
        self.assertIn("producer:package:/exports/.~1native/types", {row["id"] for row in rows})

    def test_nested_cli_and_literal_registration_loops_are_complete(self):
        source = '''
def parser():
    root = argparse.ArgumentParser()
    commands = root.add_subparsers()
    group = commands.add_parser("chunks")
    children = group.add_subparsers()
    for name in ("list", "replay"):
        child = children.add_parser(name)
        child.set_defaults(func=handle)
    for name, value in (("limit", 10),):
        child.add_argument("--" + name, default=value)
    return root
'''
        rows = audit.cli_registrations({"src/megatoken/cli.py": source})
        self.assertEqual([row["command"] for row in rows], [
            ["megatoken", "chunks"], ["megatoken", "chunks", "list"],
            ["megatoken", "chunks", "replay"],
        ])
        self.assertEqual([row["handler"] for row in rows], [None, "handle", "handle"])

    def test_dynamic_names_aliases_and_hidden_helpers_require_review(self):
        template = '''
def parser():
    root = argparse.ArgumentParser()
    commands = root.add_subparsers()
    BODY
    return root
'''
        for body in ("item = commands.add_parser(runtime_name)",
                     "item = commands.add_parser('train', aliases=['fit'])",
                     "register_more(commands)"):
            with self.subTest(body=body), self.assertRaises(ValueError):
                audit.cli_registrations({"src/megatoken/cli.py": template.replace("BODY", body)})

    def test_new_removed_changed_and_relabelled_registration_fail_verification(self):
        original = {"schema": audit.SCHEMA, "sources": {}, "fileCatalogs": {},
                    "registrations": [{"id": "producer:npm:train", "command": "node old.mjs"}],
                    "digest": "retained"}
        changes = [
            lambda value: value["registrations"].append({"id": "producer:npm:serve"}),
            lambda value: value["registrations"].clear(),
            lambda value: value["registrations"][0].update(command="node new.mjs"),
            lambda value: value.update(digest="relabelled"),
            lambda value: value["fileCatalogs"].update(native=[{"path": "scripts/new.py"}]),
        ]
        for change in changes:
            mutated = copy.deepcopy(original)
            change(mutated)
            with self.subTest(mutated=mutated), self.assertRaises(ValueError):
                audit.verify(original, mutated)

    def test_unchanged_inventory_never_claims_semantic_parity(self):
        value = {"schema": audit.SCHEMA, "sources": {}, "fileCatalogs": {"producer": []},
                 "registrations": [], "digest": "same"}
        result = audit.verify(value, copy.deepcopy(value))
        self.assertIs(result["semanticParityQualified"], False)
        self.assertIs(result["defaultCutoverQualified"], False)

    def test_review_requires_each_exact_registration_once_without_qualification_claims(self):
        inventory = {"digest": "source-bound", "registrations": [{"id": "first"}, {"id": "second"}]}
        review = {"schema": "semantic-production-route-review/1", "inventoryDigest": "source-bound",
                  "semanticParityQualified": False, "defaultCutoverQualified": False,
                  "groups": [{"id": "shared", "disposition": "shared-retain", "purpose": "shared APIs",
                              "remainingGate": "installed parity", "semanticParityQualified": False,
                              "registrationIds": ["first", "second"]}]}
        self.assertEqual(audit.verify_review(review, inventory)["classifiedRegistrations"], 2)
        for mutate in (
            lambda row: row["groups"][0]["registrationIds"].pop(),
            lambda row: row["groups"][0]["registrationIds"].append("first"),
            lambda row: row["groups"][0]["registrationIds"].append("invented"),
            lambda row: row.update(inventoryDigest="other"),
            lambda row: row.update(semanticParityQualified=True),
        ):
            changed = copy.deepcopy(review)
            mutate(changed)
            with self.subTest(changed=changed), self.assertRaises(ValueError):
                audit.verify_review(changed, inventory)


if __name__ == "__main__":
    unittest.main()
