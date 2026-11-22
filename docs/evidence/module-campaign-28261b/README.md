# Complete 843-variant Test262 module campaign

This package records the full module-only campaign at one exact producer and Test262 snapshot. It retains every row in the 102,994-variant catalog, even though only the 843 module variants were selected for parse, owned execution, and independent Node/V8 reference stages.

| Input | Exact identity |
| --- | --- |
| Producer repository | `werg/tracing-js-self` at `28261b81ee1d35ff0efbd4dd14515ddd7520ef1b` |
| Test262 repository | `tc39/test262` at `d53ebc8b1931d9f1541e43d59650776e4b766248` |
| Runner profile | `owned-test262-original/1` |
| Bound catalog digest | `8097ba540d19cd643a401825f94baeff867ffd2cbcd2bbec44b980e53dc740de` |
| Node and V8 | Node `v24.22.3`; V8 `13.6.233.17-node.63` |

## Resource policy and result

The limits were fixed before execution: 2 concurrent jobs, 384 MiB worker heap, 10-second worker wall-time limit, 300 ms reference timeout, 20,000 owned steps per case, and 1 MiB maximum source size. The campaign completed all **843 selected variants** and retained **2,231 attempts**. No worker timeout, resource-limited, or infrastructure-error disposition occurred.

| Stage | Passed | Failed | Unsupported | Environment unavailable | Not run or blocked |
| --- | ---: | ---: | ---: | ---: | ---: |
| Static parse | 750 | 93 | 0 | 0 | 0 |
| Owned execution | 275 | 16 | 212 | 42 | 298 |
| Independent Node/V8 reference | 664 | 102 | 0 | 77 | 0 |

The owned-execution total includes 205 selected cases not run after parsing, 93 blocked by earlier parse failures, and the 16 failures. The complete per-case and per-attempt dispositions are in `campaign/report.json`; no selected or unselected catalog rows were omitted.

All 93 static parse failures are `import defer` variants. Owned execution also recorded 14 dependency parse failures and two unresolved static-request graphs. Independent V8 failures consist of 93 import-defer parse errors, four module-linking errors, and five Test262Error runtime outcomes. The case IDs, paths, phases, and reasons are in `campaign/triage.json`.

Five owned cases explicitly remain unsupported because ordinary function prototype or call reflection is not modeled in this profile: the anonymous and named default-expression function name checks, the hoisted anonymous and named default-function binding checks, and an async-function constructor identity check. These are unsupported outcomes, not passing behavior.

This campaign is an engineering diagnostic for the selected modules. It does not establish full ECMAScript conformance, producer source correspondence, public semantic replay, native admission, dataset eligibility, training, serving, or learned usefulness. The Node/V8 reference stage is kept separate from owned execution; a pass in one stage does not imply a pass in the other.

## Exact source inputs

The package includes the compressed frozen catalog used by the runner and the **1,054 unique original Test262 source, harness, and module-dependency files** consumed by the 843 selected variants (1,208,374 bytes before archive compression). `inputs/selected-module-manifest.json` binds each selected ID to its original mode, path, metadata, harness, static dependencies, source digests, and the consumed-file SHA-256 and Git blob identities. The repository-wide frozen catalog carries the full snapshot inventory; the upstream checkout used for the run was detached at its pinned commit and its complete `test/` and `harness/` Git tree was verified before execution.

The campaign runner's first launch failed during implementation-fingerprint verification, before input acquisition or case execution, because the detached worktree did not have its own `node_modules/acorn` path. The initial stdout and stderr are retained unchanged under `logs/initial-dependency-resolution.*.log`. The successful retry used the same producer commit and run limits, with an ignored, worktree-local Acorn link to the already installed dependency. Its logs are under `logs/campaign.*.log`.

## Bundle integrity and restore

`inventory.json` checks every archive member and each 2 MiB compressed part. The archive is 16,922,526 bytes, SHA-256 `8430d077fdb2ec5a821ce2f2aa8b18feddf3bccc88113a148d012961f286608a`; it contains 1,064 files totaling 91,281,384 uncompressed bytes in nine parts. The package includes the complete report, triage, frozen catalog, selected original input bytes, run metadata, all run logs, and setup-failure logs.

Verify the parts and every archived member without extracting:

```sh
python3 tools/restore-retained-evidence.py \
  --inventory docs/evidence/module-campaign-28261b/inventory.json
```

To verify and restore all members into a new directory:

```sh
python3 tools/restore-retained-evidence.py \
  --inventory docs/evidence/module-campaign-28261b/inventory.json \
  --out /absolute/path/to/new-directory
```

`metadata/run.json` records the exact producer/Test262 pins, catalog and runner identities, predeclared resource bounds, and command template. This package makes no result comparison against the earlier `4c1a4a4` campaign: its raw report is not included here, and comparable applicability cannot be established from the retained evidence available with this run.
