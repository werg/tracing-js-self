# Composed module source admission and training position checks

This evidence describes the exact frozen producer `9cf091e6ccc5add960ef0897576d0c391b199a65`
and native `1a69d9da3254b7568c831d12866a629c206cf4fe` trees. The local tested commits
have different commit metadata but identical complete trees, as recorded with
every changed blob in [`qualification.json`](qualification.json). These are
integration controls, not a claim that the full 64-source campaign has finished.

## Results and denominators

| Population | Recorded result | Interpretation |
| --- | --- | --- |
| Initial native integration run | 189 passed, 3 skipped, 24 passed subtests; 116.20 seconds | 192 distinct test cases. Three live source-admission cases lacked the explicit producer environment variable. |
| Live native admission rerun | 45 passed, 31 passed subtests, no failures/errors/skips; 78.22 seconds | The entire overlapping admission cohort was rerun with the frozen producer and pinned tokenizer. All three initial skips passed. |
| Resolved native union | 192 distinct test cases and 31 required subtests resolved | This is the union of two retained runs, not a single zero-skip 192-case run. Repeated cases are not added. |
| Producer integration run | 31 leaf cases, no failures/errors/skips | Includes original module authority, receipt comparison and failure diagnostics. |
| Original module source output | One original graph, 708 contexts; source/projection/replay checks passed | This local output alone grants no native training admission and performs zero optimizer updates. |

The original logs and JUnit documents are retained without rewriting. Pytest's
suite totals include subtests, while its `<testcase>` elements provide the
distinct parent-case denominator; both are recorded explicitly.

The local environment was Python 3.12.14, Torch 2.14.1+cpu, pytest 9.2.0 and
Node 24.22.3. In particular, pytest differs from the repository's declared
`>=8.3,<9` range and Torch differs from the hosted 2.10 lock. Hosted gates use
the locked environment separately; these local results do not erase that
runtime distinction.

## Actual bounded optimizer and restart checks

The retained complete-fit proof runs three optimizer updates over nine windows
from one controlled prepared fixture. It accounts for both logical targets and
all four physical target records exactly once. Independent preparation and the
actual decoder's labels/masks agree on 413 lexical positions, 413 reconstruction
positions, 16 structure decisions, eight terminal decisions and four modality
decisions. Four router-loss events are recorded; their internal positions remain
unmeasured. Source and tokenizer admission are injected fixture boundaries.

A fourth update changes the training stage. The new stage starts at global
step three with zero credited exposure and archives the old stage's exact sealed
history; it cannot count that history toward the new stage's population.

A separate fit performs one update, saves a checkpoint and resumes in a fresh
process for its second update. Its checkpoint history continues exactly and
accounts for three of the fixture's four physical records. The independent
comparison correctly reports the fourth missing and refuses full-population
qualification. These two fits execute six updates in total but are **not one
six-update trajectory**. Neither is a learned-quality study.

The complete original position proofs and source output use XZ compression
followed by base64 encoding. Decode base64, then decompress XZ to obtain the
original bytes. [`manifest.json`](manifest.json) gives stored and uncompressed
byte counts and SHA-256 digests. No fields inside the proofs have been altered.

## Separate hosted work

The earlier neutral-contract module pair already passed 45 native controls,
nine source controls and one actual packing test with zero skips; see
[the exact `7663c11/3fa9272` evidence](../v8-modulesource7663-2026-11-22/README.md).
The composed frozen pair is checked again by
[run 45023157562](https://github.com/werg/tracing-js-self/actions/runs/45023157562).
That run was still packing the actual artifact when this evidence was written.

A fresh full support campaign is running at the frozen `9cf091e6/1a69d9d` pair:
[run 45023684906](https://github.com/werg/tracing-js-self/actions/runs/45023684906).
It must qualify the 64 original sources, prepare the 48/12/4 split, perform a
separate two-update lifecycle check and then a fresh 348-update coverage fit.
Its final checkpoint must match both the physical target inventory and the
independently reconstructed scored positions and masks. Actual campaign
optimizer and position totals are null here until that result exists.

The older completed 348-update fits retain their original code/contract and
target-record evidence; they did not measure exact decoder positions. No earlier
fit is retroactively upgraded. Hidden routing positions, structured/media loss
positions, held-out learned execution, production cost and the production default
cutover remain unqualified. No full acceptance package is closed.
