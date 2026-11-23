# Issue #61: first clean runtime implementation campaign

This records the first complete original-source rerun after shared Promise
storage and constructor lookup were implemented. It is attributed to executed
producer `47cd67bc48921b55135f5cde02c49b06e2ab4bd8`; later source projection,
native-consumer changes and runtime regression fixes are not part of this run.
Subsequent campaigns must retain their own exact revision and results.

## Complete unchanged selection

The Test262 source is still `2a1ade303f72d3de80565c921d685222405c32ce`, with
acquired catalog digest
`67799da9e7d4dd08333fe38a75b7d738d9fd14ffc40a2e17d4d00254781a47de`.
The 20 paths and all 40 required strict/sloppy variants are byte-identical to
the baseline selection. Original test/harness identities appear in
`selected-catalog.json`; no source or harness was edited or omitted.

| Stage | Passed | Unsupported | Failed | Resource limited | Infrastructure error |
| --- | ---: | ---: | ---: | ---: | ---: |
| Parse/static | 40 | 0 | 0 | 0 | 0 |
| Owned execution | 40 | 0 | 0 | 0 | 0 |
| Independent Node/V8 reference | 40 | 0 | 0 | 0 | 0 |

All 120 selected stage attempts are retained. All 103,320 variants outside this
selection remain explicitly `not_selected`. The ten previously blocked variants
now complete their original assertions, including constructor getter throws,
Promise tick/lookup order, and the original asyncHelpers reflection path.
`unsupported-diagnostics.json` has an empty diagnostic list: this run exposed no
new first barrier in the selected variants.

## Executed policy and integrity

The run used Node `v24.22.3` / V8 `13.6.233.17-node.63`, two workers, a 60,000 ms
worker wall budget, 384 MiB worker heap, 20,000 owned steps, 1,048,576 source
bytes, and a 300 ms reference VM timeout. Producer and Test262 worktrees were
clean. The implementation import-closure fingerprint was checked before and
throughout execution; `selected-report.json` retains every file hash and the
actual worker environment and commands.

The compact projection retains every selected row and all report metadata.
`verification.json` records complete-report validation, completed-resume byte
identity, and exact reconstruction of the full report from this projection and
the independently acquired full catalog. `reproduce.sh` runs from the recorded
producer with `TEST262_SUITE_ROOT` and `TEST262_OUTPUT_ROOT` set to the exact suite
checkout and an output directory outside producer source.

## Evidence boundaries and next work

This is owned/reference original-script evidence. Source correspondence and
independent megatoken trace replay are separate checks; they remain unrun or
blocked in this campaign ledger and are not inferred from the 40 owned passes.
No model training, serving or learned-usefulness claim is made.

Passing this initial selection does not establish broad Promise conformance.
Adversarial regression controls and the producer/consumer integration may expose
additional work, and a final campaign must name the exact later code it executes.
The preceding clean 30-pass/10-unsupported baseline remains in `../issue61-baseline`
with its own revision and evidence; earlier PR #60 receipts remain historical.
