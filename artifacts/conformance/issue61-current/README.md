# Issue #61: current clean runtime verification

This records the unchanged original Test262 selection executed from clean
producer `7336d7bacdb7e53025cd8e66ed0d844b19c6ab19`. That revision includes the
shared Promise object implementation and the constructor/species/finally
runtime fixes through `3b048b539d9606288f3410eee61df0ee1bc578b8`. Later source
projection, native protocol and generated-fixture changes are not attributed to
this campaign. Their independent integration receipts remain separate.

## Complete unchanged selection

The Test262 source is `2a1ade303f72d3de80565c921d685222405c32ce`, with acquired
catalog digest
`67799da9e7d4dd08333fe38a75b7d738d9fd14ffc40a2e17d4d00254781a47de`.
The 20 paths and all 40 required strict/sloppy variants are unchanged from both
the baseline and first implementation campaigns. `selected-catalog.json`
retains every original test/harness identity; no source or harness was edited,
replaced or omitted.

| Stage | Passed | Unsupported | Failed | Resource limited | Infrastructure error |
| --- | ---: | ---: | ---: | ---: | ---: |
| Parse/static | 40 | 0 | 0 | 0 | 0 |
| Owned execution | 40 | 0 | 0 | 0 | 0 |
| Independent Node/V8 reference | 40 | 0 | 0 | 0 | 0 |

All 120 selected attempts are retained. All 103,320 variants outside this
selection remain explicitly `not_selected`. The ten baseline unsupported
variants complete their original assertions, including constructor getter
throws, Promise tick/lookup order and original asyncHelpers reflection.
`unsupported-diagnostics.json` contains no diagnostics because this execution
exposed no new first barrier in the selected variants.

## Executed policy and integrity

The run used Node `v24.22.3` / V8 `13.6.233.17-node.63`, two workers, a 60,000 ms
worker wall budget, 384 MiB worker heap, 20,000 owned steps, 1,048,576 source
bytes and a 300 ms reference VM timeout. Both the producer and exact Test262
worktrees were clean. The implementation import-closure fingerprint was checked
before and throughout execution; `selected-report.json` retains every file
hash and actual worker environment and command.

`verification.json` records complete-report validation, completed-resume byte
identity and exact reconstruction of the full report from the compact selected
projection and independently acquired full catalog. `reproduce.sh` runs from
the recorded producer with `TEST262_SUITE_ROOT` and `TEST262_OUTPUT_ROOT` set to
the exact suite checkout and an output directory outside producer source.

## Evidence boundaries

This is original-script owned/reference evidence. Source correspondence was
not run; public replay and native replay remain blocked by that unrun stage in
this campaign ledger. No native admission, model training, serving or learned
usefulness result is inferred from these passes.

Independent consumer `de8b17a7241290539be0924bf8e63eb176e791ae` identifies the
paired implementation available during this work. It is contextual only: this
campaign did not invoke that consumer. The separately executed source/native
controls must identify their own exact inputs and executed revisions.

The preceding clean 30-pass/10-unsupported baseline remains in
`../issue61-baseline`. The first clean 40-pass runtime rerun at `47cd67bc` remains
in `../issue61-runtime`. Neither historical receipt is relabeled as evidence
for a later revision, and passing this selected population does not establish
broad Promise conformance.
