# Same-owner service terminal recovery: exact qualified implementation

The executable candidate is producer `5e8b987f13b43aff6b7084828646e2a3c258185b` with independent native consumer `e9817ad637f57ba82e370770420f6f3ef877c7b3`. The main PR adopts the exact 15 implementation/documentation blobs listed in [index.json](index.json); the main focused workflow additionally runs the coordinator and fence-journal controls. The probe-only workflows are not promoted.

## Complete retained gates

| Gate | Run / job | Actual result |
| --- | --- | --- |
| Focused continuation, service ownership and readback | [44998048177 / 137133253803](https://github.com/werg/tracing-js-self/actions/runs/44998048177/job/137133253803) | 141 individual JUnit cases, zero skips |
| Actual Python/shared-runtime paired transport | [44998048118 / 137134426981](https://github.com/werg/tracing-js-self/actions/runs/44998048118/job/137134426981) | 79 individual cases, zero skips |

The complete logs are retained in this directory, including the prior 140/141 focused and 78/79 Python failures. Node's focused summary includes five suite-container entries; the quoted 141 is the count of individual JUnit testcase elements. No local tests were run in this session because the local execution filesystem was full. These are hosted execution results, not syntax-only checks.

## Qualified behavior

The driver persists and independently acknowledges exact terminal intent before service fencing or native close. It binds the immutable-by-copy owner snapshot, exact reason, service receipts, selected coordinator record, all completed host invocations, and actual native checkpoint. Every service must independently acknowledge the same-owner terminal fence before native restoration.

The actual cancellation test retains every original decoder fragment, including the selected `track_cancel` record. It compares original and recovered decoder traces exactly. A requested terminal intent restores one terminal native session solely to close it, with zero host dispatches and no new model selections. Restoring the final acknowledged closed-session tombstone restores zero active sessions, again with zero host dispatches. The completion path and existing no-service path remain covered.

Read-only active and terminal listings retain each admitted action, action digest, owner, fence-claim receipt and independent outcome readback. The code rechecks exact owner/head/action snapshots around inspection. Missing outcomes remain explicitly unknown. A listing is a point-in-time observation; it is not a lease or permission to retry or take over work.

## Failures and lessons retained

The penultimate focused failure was an overly narrow expected error regex: the tampered admission chain was correctly rejected as noncontiguous, substituted or foreign. The assertion now requires that actual refusal. The penultimate Python failure omitted the final selected cancellation record from the expected decoder trace; the final test instead changes the expected final record from completion to cancellation and compares the full trace and fragments.

An earlier injected directory-sync failure happened after a terminal fence file was published. A fresh reader may observe and synchronize that exact file, even though the writer received no acknowledgement. Readback does not retroactively create the lost writer ACK. Native restore stays blocked until every service fence is positively verified. This distinction is reflected in the tests and API documentation.

## Remaining boundary

Unsettled or failed children, unknown service outcomes, ambiguous action acknowledgements, successor ownership, concurrent supervisor takeover and distributed ownership remain unqualified. The active-owner listing alone cannot authorize pending-child replay. Model-selected transport tests use a controlled lexical decoder and do not measure learned program quality. Source validation/default promotion remain false, learned success is unmeasured, and all 17 broad acceptance packages remain open.
