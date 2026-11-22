# Known coordinator commit recovery investigation

## Completed exact hosted qualification

Producer `170baa28b23f02b3971a1e7acfb7e2cf3d8d62ae`, native
`0066888f733c0d27d7ac7c0e92dc390231575f2e`, passed
[run 45019940127 / job 137200394049](https://github.com/werg/tracing-js-self/actions/runs/45019940127/job/137200394049).
All **62 leaf cases passed, zero failures/errors/skips**. Node's aggregate
counter includes one parent suite entry and reports 63; the leaf denominator
is independently checked from the JUnit XML.

The actual Python process fixtures prove lost-reply recovery for a known
committed `track_join` and `track_progress`, repeated process loss after the
new acknowledged full-history cut, unchanged original model-selection bytes,
whole host/child preservation and subsequent completion. Recovery costs remain
cumulative, and the original same-boot/time-namespace clock charges downtime,
storage, reexecution and acknowledgment. Negative controls cover stale heads,
unknown native outcomes, expired clocks and changed reconstruction authority.
No child/host dispatch occurs during reconciliation.

`complete-success.log.gz` preserves the original complete job-log bytes;
`known-commit-history-success.xml` is the timestamp-stripped original JUnit
payload. `qualification.json` binds the precise source tree, scoped source
map, consumer pin, counts and log SHA-256. The earlier failed attempts below
remain part of the record. This is controlled lexical-fixture execution, not
learned quality, full source qualification or production default promotion.
Creation/bootstrap, terminal close, unknown external effects, unresolved
child dispatch and distributed owner recovery remain open.

## First exact hosted attempt: retained failure

Producer `3ae10e3bc0c05d8b17419ce35d62c3fffe3f036c`, native `0066888f733c0d27d7ac7c0e92dc390231575f2e`: [run 45017718366 / job 137193533073](https://github.com/werg/tracing-js-self/actions/runs/45017718366/job/137193533073).

The mandatory Linux clock identity was available. All 62 leaf testcases ran with zero skips: 60 passed and two failed. Both real lost-join/progress reply cases passed, including a second process loss after the new history seal, cumulative accounting, original-prefix reexecution and full continuation. The two failures were test-observation races: the stale-head and expired-clock refusals returned before the replacement peer initialized its decoder log, and the test then tried to read a nonexistent file. The original `ENOENT` failures are retained unchanged; this attempt is not a passed qualification.

The strict workflow denominator is corrected from the earlier inferred 55 to the actual 62 leaf cases: the existing eight malformed-cost subtests replace their single parent in the XML count. Parents are not additional cases. This first attempt required the fresh complete zero-skip hosted pass now retained above.

`first-failure.log.gz` retains the entire original job log after decompression. `first-failure.xml` contains the unchanged JUnit payload extracted by removing the job-log timestamp prefixes.

## Follow-up log ownership correction

The first fixture correction tried to create an empty observation log in the parent before launch. That violates the native fixture's exclusive `open("x")` ownership of its log. The intermediate `5b81496` also addressed the wrong metrics nesting; `aff52ea` corrected the counter and added a direct recovery-entry observer but retained the log precreation. Its [run 45018710446 / job 137196614268](https://github.com/werg/tracing-js-self/actions/runs/45018710446/job/137196614268) ran 62 cases: 56 passed, all six newly added live recovery fixtures failed during initialization, zero skipped. The complete raw result is retained as `log-owner-failure.log.gz` and `log-owner-failure.xml`. A separate local invocation with a precreated log reproduced the fixture's `FileExistsError` without invoking recovery.

The final fixture leaves exclusive log creation with the peer. Refusals require zero recovery-method entries, zero native runtime replies and zero prediction attempts. Only with those independent zero-work checks may the observation log be absent (the process has not initialized) or empty. Positive recovery paths still require their real decoder logs and now also require exactly one recovery entry per replacement. No production recovery implementation, clock authority, timeout or refusal condition changed. The setup assertion also retains the driver's failure and transport diagnostics when no coordinator attempt was possible.
