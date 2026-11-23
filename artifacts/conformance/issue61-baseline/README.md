# Issue #61: clean baseline of the original async selection

This is a new execution at clean producer
`3d72b27cf626b87d78eb0b883f54ea9e9c5380e8`, before the Promise storage changes.
It reproduces the first barriers recorded during PR #60 without attributing
PR #60's older executions to the current code.

## Exact inputs and budgets

- Test262 commit: `2a1ade303f72d3de80565c921d685222405c32ce`.
- Acquired Test262 tree: `70ab70455f270f26e92d097d863a0b08ad020b94`.
- Acquired catalog digest:
  `67799da9e7d4dd08333fe38a75b7d738d9fd14ffc40a2e17d4d00254781a47de`.
- Runtime: Node `v24.22.3`, V8 `13.6.233.17-node.63`.
- Exactly the 20 original files listed in `selected-paths.txt`, with every
  required strict/sloppy variant: 40 variants, 120 stage attempts.
- Original test and harness bytes were authenticated against the acquired Git
  tree. Strict variants use the runner's declared strict directive insertion.
- Two workers, 60,000 ms worker wall budget, 384 MiB worker heap, 20,000 owned
  steps, 1,048,576 source bytes, 300 ms reference VM timeout.

The complete acquired inventory has 103,360 required variants. All 103,320
unselected variants remain `not_selected`; this selection is not a corpus ceiling.

## Executed results

| Stage | Passed | Unsupported | Failed | Resource limited | Infrastructure error |
| --- | ---: | ---: | ---: | ---: | ---: |
| Parse/static | 40 | 0 | 0 | 0 | 0 |
| Owned execution | 30 | 10 | 0 | 0 | 0 |
| Independent Node/V8 reference | 40 | 0 | 0 | 0 | 0 |

Each source below reproduces its barrier in both strict and sloppy variants.
`unsupported-diagnostics.json` retains the source/harness location, refused
instruction, receiver stack, guest throws and relevant observable state for all
ten diagnostic replays.

| Source under `test/language/statements/for-await-of/` | First barrier |
| --- | --- |
| `async-from-sync-iterator-continuation-abrupt-completion-get-constructor.js` | `Object.defineProperty` on a Promise instance requires owned ordinary storage. |
| `iterator-close-non-throw-get-method-is-null.js` | Original `asyncHelpers.js` cannot read `Object.prototype.hasOwnProperty`. |
| `ticks-with-async-iter-resolved-promise-and-constructor-lookup-two.js` | Reading `Promise.prototype` while installing the constructor getter. |
| `ticks-with-async-iter-resolved-promise-and-constructor-lookup.js` | Reading `Promise.prototype` while installing the constructor getter. |
| `ticks-with-sync-iter-resolved-promise-and-constructor-lookup.js` | Reading `Promise.prototype` while installing the constructor getter. |

The refused Promise property definition is a host implementation refusal, not a
guest TypeError, and does not qualify as a negative-test success. The reflection
barrier occurs before either `iterationCount` or `returnGets` advances. These
observations localize missing operations; they do not establish a defect in the
subsequent iteration algorithm.

## Retention and limits

`selected-report.json` retains every selected ledger row and attempt, all report
metadata, and the full report's compressed and JSON identities. The corresponding
`selected-catalog.json` retains every selected test/harness identity. They use
the existing selection-projection schemas and are explicitly not full reports.
`observation.json` records the new execution identity, environment, counts and
budgets. `verification.json` records report validation, completed-resume byte
identity and exact reconstruction from the compact selection.

Source correspondence and independent megatoken native trace validation were not
executed by this baseline campaign. Their ledger stages remain unrun or blocked;
the corresponding qualification claims remain false. Node/V8 reference execution
is a separate diagnostic authority and is not independent native trace replay.
No model training, serving or learned-quality result is claimed.

Run `reproduce.sh` from a clean checkout of the recorded producer, with
`TEST262_SUITE_ROOT` pointing to the exact Test262 checkout and
`TEST262_OUTPUT_ROOT` pointing outside the producer source. The script may remain
in the PR checkout. New executions record their own actual worker paths and
environment, so their report bytes may differ from this retained observation.
The existing `../test262-current-pr60/restore-report.mjs` reconstructs this new
report too: it uses the identities in the supplied selection, not PR #60's run.

The baseline was produced in an isolated clean worktree while implementation
continued elsewhere. The runner's import-closure fingerprint authenticated the
actual source and installed dependencies before and throughout execution.
