# Recover an exact coordinator acknowledgement into durable application history

This candidate connects the independently durable native commit primitive to the
latest externally acknowledged composite application checkpoint. It supports
`track_join` and `track_progress`: both can preserve the complete host bridge,
child contexts, settled results and child-attempt ledger while accounting for
exactly one original coordinator selection. Creation/bootstrap, terminal service
close and unknown child or external effects retain their separate refusal paths.

## Capture the original authority before selection

Configure automatic history with the original guarded native selector, its
durable request journal/kernel execution lease, an independent head acknowledger
and a live clock created by `createSelectedOrchestrationExecutionClock()`.

```js
driver.startAutomaticHistory({
  journal: historyJournal,
  acknowledge,
  executionClock: createSelectedOrchestrationExecutionClock(),
});
```

Before selecting, the driver publishes and acknowledges the complete safe cut
plus a pending marker. That marker binds the next native request ordinal,
session, stream and generation as well as the same-boot/time-namespace monotonic
clock receipt. An equal model output in another execution is not authority to
resolve this marker. The selection, storage waits and process downtime all use
the same remaining deadline. Clock-bound checkpoints retain that authority;
pausing or restoring them does not stop or reset this deadline. Missing Linux
clock identity, changed boot/namespace, backwards time or expiration refuses.

## Recover without dispatching host work

Obtain a fresh exclusive execution lease and guarded native process. Pass the
independently retained producer request receipt (or its validated journal
inspection) and the separately acknowledged selected-history receipt:

```js
const restored = await RegionSelectedOrchestrationDriver.restoreLatest(packet, {
  initialPublic,
  select: freshGuardedSelector,
  policy,
  historyJournal,
  historyReceipt,
  acknowledge,
  executionClock: createSelectedOrchestrationExecutionClock(),
  commitRecovery: {receipt: nativeRequestReceipt},
});
// The new safe history head is already independently acknowledged, and
// automatic history remains enabled for every subsequent dispatch boundary.
const result = await restored.run();
```

The latest complete history is verified before native reexecution. The native
side must independently own the exact completed request and whole postcommit
state; a producer-only intent or later native mutation refuses. The new host
cut is reconstructed from the original selected bytes and receipt, checked by
the ordinary complete checkpoint verifier and all cross-cut invariants, then
published and independently acknowledged. No host or child work executes during
reconciliation. Any failure after native recovery closes that process. A lost
new-head acknowledgement leaves the older external head fenced; the implementation
does not guess which journal position the application acknowledged.

Another process loss after the reconciled head was acknowledged may recover the
same exact sealed cut. The retained native poststate and attempts must equal the
independently recovered commit, and the original reply must match the latest host
decision. The native transport adopts that exact checkpoint's existing cost
accounting before adding the new recovery costs. Repeated recovery cannot refund
earlier reexecution, erase consumed selections or reset elapsed time.

## Evidence and remaining boundaries

The reconstruction controls use a deterministic protocol peer and explicitly do
not certify native reexecution. A separate mandatory paired gate uses the actual
Python native adapter and journal, fault injection before native admission and
after durable commit, fresh kernel leases/processes and an original-byte decoder
fixture. The fixture controls final lexical bytes; it is not learned-quality or
production model evidence. The gate must run all positive and refusal controls
with zero skips. Local runtimes that hide `/proc/self/ns/time` cannot qualify the
positive clock path; no fallback weakens the production identity check.

This is trusted local Linux process/filesystem exclusion with independently
owned history-head acknowledgement. It does not implement a distributed lease,
an atomic remote service/history transaction, unknown-outcome retry, recovery of
a child-dispatch fence, or source/model quality qualification. The primitive
native recovery result continues to report `hostRecoveryAuthorized: false`;
only the complete verified and acknowledged application-history procedure can
return a runnable driver.
