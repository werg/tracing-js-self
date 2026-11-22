# Full 843-variant module campaign at producer 35be3b7

This package preserves the campaign with its exact producer and Test262 pins, full report and triage, exact comparison to the prior 28261b campaign, all selected original inputs, run logs, and a separate import-defer scope annotation report.

| Input | Exact identity |
| --- | --- |
| Producer | `werg/tracing-js-self` at `35be3b75d7eff768274afd034ff8b4215ddba77c` |
| Test262 | `tc39/test262` at `d53ebc8b1931d9f1541e43d59650776e4b766248` |
| Catalog | `8097ba540d19cd643a401825f94baeff867ffd2cbcd2bbec44b980e53dc740de` (102,994 variants) |
| Selected module variants / attempts | 843 / 2,231 |
| Node / V8 reference | `v24.22.3` / `13.6.233.17-node.63` |

## Outcomes

Parse: **750 passed, 93 failed**. Owned execution: **278 passed, 14 failed, 211 unsupported, 42 environment unavailable**, 205 not run after parse and 93 blocked by earlier parse failures. Independent reference: **664 passed, 102 failed, 77 environment unavailable**. No resource-limited or infrastructure-error dispositions occurred. The full denominator and attempt history remain in `campaign/report.json`; no failures or unsupported rows were removed.

The exact same-catalog/profile/policy comparison to producer `28261b81ee1d35ff0efbd4dd14515ddd7520ef1b` has three owned-execution status changes: two namespace-reexport cases moved from failed to passed and one namespace-unambiguous case moved from unsupported to passed. Parse and independent-reference statuses did not change. See `comparison/exact-28261b-to-35be3b7.json` for identities and counts. These are owned-runner outcomes, not public or native conformance claims.

## Separate scope annotations

`scope/annotations.json.xz` was produced by helper code at `3bdc1fb4a396f73cfd1b4a98dc7e2ddd6da9667c`, bound to the pinned catalog and specification production bytes. It annotates all 102,994 catalog rows, preserves all 93 parse-failure rows and all 388 import-defer feature-tag rows, and records 93 parse failures as outside the pinned grammar evidence. It does not alter original failure labels, feature tags, or campaign stage results. Rows without evidence remain unclassified. The exact compressed-file and report digests are recorded in `metadata/run.json`.

## Original source inputs and restore

The package includes 843 selected variants and 1,054 unique Test262 source, harness, and module-dependency files. `inputs/selected-module-manifest.json` binds each selected ID and consumed path to source hashes and metadata. `inventory.json` checksums each archive member and each 2 MiB compressed part.

Verify or restore with:

```sh
python3 tools/restore-retained-evidence.py --inventory docs/evidence/module-campaign-35be3b7/inventory.json
python3 tools/restore-retained-evidence.py --inventory docs/evidence/module-campaign-35be3b7/inventory.json --out /absolute/path/to/new-directory
```
