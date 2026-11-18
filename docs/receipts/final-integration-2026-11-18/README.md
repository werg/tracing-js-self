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
