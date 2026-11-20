# Final-contract source checks and timing follow-up

The instrumented targeted run at exact producer
`012c9fe49a082319bf98ac0c571596da925741a4` **did not pass**: its six selected
test files recorded **42 passes, one failure and one cancellation**, with no
skips, out of 44 tests. All **five generated-contract checks passed** at the
same clean, unchanged source identity. The original failed receipt and logs are
retained unchanged under [original-012c9fe](original-012c9fe/summary.json).

The subsequent deadline-harness follow-up passed **24/24 tests**, with zero
failures, cancellations or skips, in 43.957 seconds.
Its identity is **coordinator-reported**, not an instrumented clean-commit run:
the primary checkout contained the two-file patch later published as
`c0524b444e8ab8db2a3c1d6b06e5f64327bf77ca`. [deadline-followup.json](deadline-followup.json) retains that
distinction, the exact command and the original log hash.

## Original scope and failures

The six selected files cover causal serialization, native process transport,
ordinary completion source behavior, custom iterator source behavior, flat
iterable-binding source behavior and selected execution. The original runner's
scope string says all fixture consumers; the actual retained six-file inventory
is authoritative and is **not exhaustive fixture-consumer coverage**.

The malformed-UTF-8/deadline transport test failed while its fake server was
still initializing under contention. The selected-execution callback test was
cancelled by its outer test timeout during preparation. Their original failure
messages and stack traces remain in `unit.stdout.log`; no candidate semantic
pass is inferred from either failed check.

The later patch makes the request deadline deterministic after real server
initialization by advancing a mocked monotonic clock, and gives the callback
test a 30-second outer preparation budget while retaining its one-second
execution deadline. It changes only the two test files listed in the follow-up
receipt. Production execution and deadline behavior are unchanged by that patch.

## Separately executed follow-up

```sh
node --test --test-concurrency=2 test/semantic-native-process-v8.test.js test/semantic-selected-execution-v8.test.js
```

[deadline-followup.log](deadline-followup.log) contains the original 24 passing
results. Those tests overlap the earlier six-file selection, so their counts
must not be added to create a combined test denominator. The passing follow-up
does not turn the original 44-test run into 44 passes, and neither is presented
as the complete producer regression. The [complete 9d regression](../producer-regression-9d4f6b3/README.md)
and later hosted current-tree CI retain their own exact scopes.

The final-contract 665/26/11 source/native populations and 244-test native
component suite are independent gates. This package retains source tests and
contract generation, not native admission or model execution.

## Integrity

`SHA256SUMS` covers every copied original file, the separate follow-up log and
receipt, and the packaging helper. The helper checked all original command-log
hashes, code/test inventory hashes, unchanged identities, exact numeric results
and the two-file patch inventory. These integrity checks do not rerun tests.
