# Issue #61 review control receipts

This packet retains four separately executed producer test runs after the PR
review fixes. The original reports are preserved byte for byte after
decompression. The earlier `issue61-controls` packet remains unchanged.

| Retained run | Passed leaves | Failed leaves | Skipped leaves | Total leaves |
| --- | ---: | ---: | ---: | ---: |
| Runtime Promise object controls | 17 | 0 | 0 | 17 |
| Existing Promise runtime regressions | 51 | 0 | 0 | 51 |
| Public shared-intrinsic boundaries and related controls | 83 | 0 | 1 | 84 |
| Public Number source controls | 7 | 0 | 0 | 7 |
| **Retained executions** | **158** | **0** | **1** | **159** |

These are actual JUnit `testcase` leaves. None of these reports contains parent
test suites. The public population is **91 leaves: 90 passed and one skipped**.
Its 84-leaf run includes all **11 passing new shared-intrinsic controls** from
`test/semantic-shared-intrinsic-boundaries-v8.test.js`; those 11 are already
counted above. The earlier standalone 11-control execution was visible only in
tool output, with no saved spec or JUnit report. No separate receipt is
fabricated for it.

The skipped test is `independent native transitions reproduce all Promise
object cases and reject altered records` in
`test/semantic-promise-object-v8.test.js`. It is the optional consumer check,
guarded by `MEGATOKEN_ROOT`. This packet preserves the skip and does not replace
it with independently reported native results.

## What these controls cover

The runtime controls exercise the ordering of `.finally()` constructor/species
lookups and live `then` selection, explicit refusal of unsupported replacement
methods, direct species getters reached through data-valued constructors,
receiver identity, reentry, thrown values, cleanup, adoption, checkpoint
restoration, and tampered source authority. Their original-source native
comparisons, owned bundle validation and exact replay are distinct checks.

The public controls cover callable intrinsic identities, live shared Object
prototype state during conversion and Promise resolution, original receivers,
method replacement, fallback order, and explicit unsupported boundaries. The
retained related regressions include source correspondence and Number
conversion controls. `manifest.json` lists the actual per-file JUnit counts.

## Execution provenance and limits

Both runtime runs executed on the producer working tree **before** checkpoint
`783cf78fb039d1ca97261fc41b086096e343f06b`, with the runtime review fixes still
uncommitted. Both public runs executed on the producer working tree **before**
checkpoint `d25c2734da6136b1cda204bfe4d4ea2b2bf7f117`, with the public fixes
uncommitted. The runtime agent's edits also appeared during the public run.

These checkpoint IDs identify later commits containing the relevant changes;
they are **not execution revisions**. No starting input fingerprint or complete
environment manifest was captured for these runs. Their working-tree/log-only
provenance remains explicit, and a clean-revision result is not inferred.

The 159 leaves describe four separate executions, not one all-green broad run
or a replacement tally for the earlier regression packet. They do not claim a
passing combined gate, full native admission, a fresh original-40 Test262
campaign, or training admission. Those qualifications have separate receipts.

## Retention and verification

All eight original spec/JUnit files use deterministic gzip: compression level
9, zero timestamp, and no stored filename. The manifest records the original
and retained byte lengths and SHA-256 digests, alongside the actual counts and
working-tree provenance. It also hashes this README and the verifier.

Run the self-contained verifier from any directory with Python 3:

```sh
python3 artifacts/conformance/issue61-review-controls/verify.py
```

It verifies retained hashes, decompressed hashes, actual JUnit leaves, per-file
counts, matching spec summaries, the 11-control subset, and the aggregate
without requiring the original checkout or consumer. To additionally compare
the original files while they remain available, pass `--source-root` pointing
to the workspace directory containing `issue61-evidence`.

`retention-verification.json` preserves the successful verification performed
at retention time, including comparison with all eight original files. This
checks the retained evidence; it does not rerun the implementation tests.
