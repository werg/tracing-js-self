# Known join/progress recovery with the expanded module contract

The exact producer `2896ccaccbe4166597e4dd80bafef844b472ae1a` and native
`10d1f5fd611fbe4fbc3f19b6463f597d90946f7c` pair passed
[run 45021618083 / job 137205582404](https://github.com/werg/tracing-js-self/actions/runs/45021618083/job/137205582404).
All **62 leaf cases passed, zero failures/errors/skips**. Node's aggregate
reports 63 because it includes one parent entry. The gate validates the actual
expanded `a9523855…` contract on both sides before executing the controls.

This composes the already qualified known `track_join` and `track_progress`
recovery with the source-bound module ledger, neutral hashing dependency and
existing target accounting. Real native subprocesses, immutable request
journals, exclusive execution leases and same-boot/time-namespace clocks prove
lost-reply reconciliation, a second process loss at the newly acknowledged
cut, original selection preservation, cumulative costs and continued completion.
Refusal controls retain the stale-head, unknown-outcome, owner, clock and
malformed-state boundaries. No host or child work is dispatched by recovery.

`complete-success.log.gz` retains the original complete job bytes;
`controls.xml` retains the timestamp-stripped JUnit result.
`qualification.json` contains exact revisions, tree, log digest, case counts
and the scoped file map. The earlier 170baa2/0066888 qualification and its
failed fixture attempts remain separately retained in the neighboring known
commit history evidence directory.

Creation/bootstrap, terminal close, unknown external outcomes and distributed
ownership remain open. This controlled lexical-fixture gate does not qualify
learned execution, a production model, a larger source population or the
default cutover. Later training or bootstrap revisions keep separate source
identities and qualification results.
