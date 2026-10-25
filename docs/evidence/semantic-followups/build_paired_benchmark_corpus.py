#!/usr/bin/env python3
"""Reproduce the explicit/compact paired corpus directory used by the freezer."""
from __future__ import annotations

import argparse
import copy
import json
import shutil
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--explicit", type=Path, required=True)
    parser.add_argument("--compact", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    merged = None
    recipe_identity = None
    cases = []
    counts = {}
    for representation, root in (("explicit", args.explicit), ("compact", args.compact)):
        manifest = json.loads((root / "manifest.json").read_text())
        if merged is None:
            merged = manifest
            recipe_identity = copy.deepcopy(manifest["recipe"])
            for child in recipe_identity["lifecycleInputs"]:
                if child.get("representation") not in {"explicit", "compact"}:
                    raise ValueError("Lifecycle child has an unknown representation")
                child.pop("representation")
        else:
            candidate_recipe = copy.deepcopy(manifest["recipe"])
            for child in candidate_recipe["lifecycleInputs"]:
                if child.get("representation") not in {"explicit", "compact"}:
                    raise ValueError("Lifecycle child has an unknown representation")
                child.pop("representation")
            if candidate_recipe != recipe_identity:
                raise ValueError("Paired corpora differ in recipe algorithms, ancestry, splits, or lifecycle identity")
        for key, value in manifest["counts"].items():
            counts[key] = counts.get(key, 0) + value
        target = args.output / representation
        target.mkdir(parents=True, exist_ok=True)
        for case in manifest["cases"]:
            if not case.get("path"):
                raise ValueError(f"Case has no source file: {case.get('id')}")
            relative = f"{representation}/{case['path']}"
            shutil.copy2(root / case["path"], args.output / relative)
            paired = dict(case)
            paired["path"] = relative
            cases.append(paired)
    assert merged is not None
    merged["representation"] = "mixed"
    merged["counts"] = counts
    merged["cases"] = cases
    (args.output / "manifest.json").write_text(json.dumps(merged, indent=2) + "\n")
    print(json.dumps({"cases": len(cases), "counts": counts,
                      "families": len({case["family"] for case in cases})}))


if __name__ == "__main__":
    main()
