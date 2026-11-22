# Explicit native pairing in ordinary tests — 22 November 2026

## Original failed matrix retained

[Ordinary test run 45039060636](https://github.com/werg/tracing-js-self/actions/runs/45039060636)
on producer `69ff5edd4dc23c1d0f62a393b39269018e61a003` failed on each of its
Node 20, 22 and 24 lanes. Each lane reported 2,813 tests: 2,772 passes, nine
failures and 32 explicit skips. These are three observations of the same
population, not three disjoint test sets. The counts are the ordinary Node
reporter's totals, not an independently enumerated language qualification.

All nine failures came from `semantic-known-commit-history-v8.test.js` and had
the same error: `Actual paired native recovery fixture is required`. The ordinary
workflow intentionally checks out only the producer and does not set
`MEGATOKEN_ROOT`. The test's old admission check considered only the presence of
a Linux time namespace, so Linux CI started actual-native tests without the
native repository or its runtime. The complete three job logs are preserved
losslessly in `node-*.job.log.gz`; `log-inventory.json` binds both compressed and
decoded bytes, original job IDs and reported counts. The original job/step
metadata is also retained. No failed result has been replaced.

## Correction and validation

Local commit `3b140115a5bf14e373a126b1429ef28e3052cbad` changes only the
test-environment guard. Optional actual-native tests require an explicitly
configured native root and its real fixture before attempting execution.
An absent or unconfigured native runtime is reported as a skip with a reason.
The mandatory `REQUIRE_KNOWN_COMMIT_RECOVERY=1` gate still asserts genuine clock
authority and the exact configured native peer before registering tests.

On local Node 24.22.3:

- With native configuration absent, the module reports **nine explicit skipped
  cases, zero failures/errors**, and exits successfully. This is optional-lane
  behavior, not a native recovery pass.
- With the mandatory flag set and native configuration absent, the process
  **exits 1**, reporting one startup failure and zero skips. The restricted local
  workspace also lacks genuine clock authority; neither authority was fabricated.

The two original JUnit documents are retained. Syntax and whitespace checks pass.
The exact same guard was already present in the independent combined recovery
candidate. Its required 165-native/193-producer hosted gate still requires every
case to execute with zero failures, errors or skips. No test body, native
behavior, timeout, accepted population or mandatory criterion changed here.

The complete ordinary matrix on the published correction must be observed
separately before claiming that full CI passed. The nine deliberately optional
skips do not establish native correctness; the separate pinned hosted gate does.
