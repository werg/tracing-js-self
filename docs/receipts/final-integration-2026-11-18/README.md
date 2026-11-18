# Final integrated local qualification — 18 November 2026

All six recorded checks passed against the clean immutable producer
`aa7b8432761df110df53fc95664b7d767b2eeba0`, tree
`ef8a36f0da31bd2b20032a27c3fb4cfded6f6a02`, with consumer
`6b4382b9af3bef120ca3a95ae24d35154d4cd66b`. Producer and consumer identities and
clean tracked state were checked before and after qualification.

| Check | Actual result |
| --- | --- |
| Full Node24 suite | 902 tests: **897 passed, zero failed, five explicitly skipped**, zero cancelled/todo |
| Merged Python regressions | **108 passed** |
| Deterministic reference fixture | Passed |
| Host contract generation check | Passed |
| Semantic contract generation check | Passed |
| Source-grounded semantic inspection | Passed |

The complete [qualification receipt](local-qualification.json) records the
expanded argument lists, exact working directories, environment, runtime
versions, return codes, log sizes and SHA-256 digests. The Node suite used
Node24.22.3 / V8 13.6.233.17-node.63 with two test workers; the Python tests used
Python3.12.14 and the explicitly selected current consumer. UTC, C.UTF-8,
one-thread BLAS/OpenMP settings and the workspace temporary directory are
retained as measured. The receipt records the actual elapsed times rather than
assuming the earlier baseline's duration.

The Python command covers optimization measurement, learning evaluation, pure
output, release packaging, learning artifacts, learning comparison and
optimization selection. These are implementation regressions. They do not
perform a new optimizer experiment or establish learned success.

## Current-code local isolation check

A separate exact clean `1e2e6a0de8952c4349edbeef46ab70c4a06f8157` checkout
passed **3/3 isolation tests with zero skips**. The [receipt](isolation-1e2e6a0.json)
binds the full command, Node version, environment, before/after tree state and
[unchanged original log](isolation-1e2e6a0.log). It verifies environment
sanitization, kernel confinement against direct filesystem/network/process
APIs, and isolated original/instrumented source admission with its policy bound.

This is separate from the hosted unit workflow for head `1e2e6a0`, whose Node24
job tested synthetic merge `3497ee3454ea75715db1bc50c3e7cfc35ecc0fc2` and reported
909 tests, 902 passes, seven skips and zero failures. Two hosted skips reflect
that runner's UID-map `EPERM`; the other five require native orchestration
configuration and ran in the separate engineering native lane. These separate
executions are not added together to rewrite either unit-suite denominator.

## Preserved integration failure

The first full Node24 attempt at `5769938824db6654c7a0254228a8a45af9c32581`
reported 896 passes, one failure and five skips. Its original log and exit code
are retained under [earlier-attempt-5769938](earlier-attempt-5769938). The only
failure was an obsolete expected helper-coverage count: the test expected
19 of 23 helpers, while fresh independent verification now covered all 23.

Commit `aa7b8432761df110df53fc95664b7d767b2eeba0` updates that exact expectation
and checks the newly supported helper names. It also runs the previously
unwired merged learning-artifact/comparison tests in the engineering CI lane.
No semantic/native gate was relaxed. The complete successful rerun above is a
new measurement; it does not overwrite or relabel the first attempt.

## Separate hosted native failure

The hosted native matrix for PR head `aa7b843` later failed in all five registry-bound
recipe lanes, despite successful environment checks and 17 capability probes.
The [complete original job logs and diagnosis](native-aa7b-failure/README.md)
record the shared metadata alias/JSON identity defect and the sibling-worker
shutdown race. Those jobs checked out synthetic merge `3850539e1038f3cd19c19c446403444b96281797`;
the triggering head and actual checkout are distinct from this exact local run. Local tests and selected native probes did not cover that full
registry persistence path. The passing local results above do not replace the
failed hosted result.

## Completed exact-head hosted successor

All five lanes of [native run 44321402524](https://github.com/werg/tracing-js-self/actions/runs/44321402524)
subsequently passed at actual producer `1e2e6a0` and consumer `6b4382b`.
The [separate successor receipt](native-successor/README.md) retains all five
complete successful logs, exact identity records, the Node24 integration log,
and the distinct Exercism diagnostic. It records 477 attempts, 457 native
admissions and fresh qualifications, and a sum of 364 within-release distinct
prepared rows; a cross-recipe deduplicated union was not measured. This is a
new successful run after the storage/shutdown repairs and does not relabel the
original local `aa7b843` checks or the failed hosted attempt.

## Integrity and scope

[index.json](index.json) binds every unchanged original file copied here. The
final check logs were verified against their hashes in the original
qualification receipt before copying. The empty host-contract log is expected:
its command exited zero and emitted no text.

This receipt applies to its named revisions, not to an arbitrary later commit
that contains it. [Current native qualification](../reconciled-native-2026-11-18/README.md)
separately records 17 capability probes and 18 active repaired/boundary source
cases at producer `f4ce1b96` / consumer `6b4382b`. Hosted workflow results and
the unchanged original `5753de1` baseline are separately identified in the
[handover](../../RESUMPTION_HANDOVER_2026-11-18.md).
