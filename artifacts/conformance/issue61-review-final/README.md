# Issue #61: clean verification after review fixes

This is a fresh execution of the unchanged original Test262 selection from
clean producer `783cf78fb039d1ca97261fc41b086096e343f06b`. It includes the final
runtime review corrections for finally lookup order and direct species
continuation validation. Its evidence is separate from the earlier baseline,
first implementation and `7336d7ba` runtime campaigns.

## Original population and results

The exact Test262 revision is `2a1ade303f72d3de80565c921d685222405c32ce`.
A newly acquired complete catalog has the same digest as the earlier campaigns:
`67799da9e7d4dd08333fe38a75b7d738d9fd14ffc40a2e17d4d00254781a47de`.
The same 20 paths and all 40 strict/sloppy variants were selected. Every original
test and harness file retains its pinned Git and SHA-256 identity.

| Executed stage | Passed | Unsupported | Failed | Resource limited | Infrastructure error |
| --- | ---: | ---: | ---: | ---: | ---: |
| Parse/static | 40 | 0 | 0 | 0 | 0 |
| Owned execution | 40 | 0 | 0 | 0 | 0 |
| Independent Node/V8 reference | 40 | 0 | 0 | 0 | 0 |

All 120 selected attempts are retained, including their evidence and worker
commands. The remaining 103,320 acquired variants retain explicit `not_selected`
ledger entries when the full report is reconstructed. No selected original
source, harness, assertion or execution variant was replaced or omitted.
The empty diagnostic list records that this run exposed no new first barrier.

## Executed policy and integrity

The policy is unchanged: Node `v24.22.3`, V8 `13.6.233.17-node.63`, two workers,
60,000 ms worker wall timeout, 384 MiB worker heap, 20,000 owned steps,
1,048,576 source bytes and a 300 ms reference VM timeout. The producer used a
separate detached worktree with its own physical dependency files. The producer
and Test262 checkouts were clean, and the runner checked the implementation
import-closure fingerprint throughout execution.

`verification.json` records the full report validation, byte-identical completed
resume, reconstruction of the identical full JSON and gzip report, and original
input integrity checks. The latter compare all 25 test/harness files to pinned
Git bytes, compare the selected identities to the baseline, and check all 40
owned traces against the exact harness and prepared strict/sloppy source digests.
Reconstruction and integrity checks perform no guest execution.

`execution-inputs.json` records the actual clean revisions, paths, selection and
commands captured before execution. `campaign.log` and `resume.log` are the
original execution receipts. `selected-report.json` retains the full report's
byte identities; the deterministic unselected ledger and complete catalog are
omitted from this compact projection and reconstructed using the existing
restoration tool.

Run `reproduce.sh` from a clean checkout of the recorded producer revision with
`TEST262_SUITE_ROOT` pointing to the exact clean suite and `TEST262_OUTPUT_ROOT`
pointing outside producer source. The retained `verify-original-inputs.mjs` can
also independently check the original bytes and selected evidence from that
producer checkout with `--suite-root`.

## Evidence boundaries

This campaign executes original-script parsing, owned execution and independent
Node/V8 reference only. Source correspondence was not executed. Public replay,
independent consumer replay and downstream admission/training stages therefore
remain blocked in the ledger. These passes do not establish native admission,
training, serving, learned usefulness or broad Promise conformance.

The consumer HEAD recorded as context at campaign start was
`fb82c671276a1b68404ad14b8fcafc3b390b4c69`. The campaign did not execute that
consumer, and this context does not certify its checkout or imply a native
receipt. Later consumer corrections and final source/native qualification must
be identified by their own executed revisions and inputs.

The historical receipts in `../issue61-baseline`, `../issue61-runtime` and
`../issue61-current` remain unchanged and continue to describe only their own
recorded revisions.
