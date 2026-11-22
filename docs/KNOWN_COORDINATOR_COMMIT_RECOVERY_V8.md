# Recover an exact coordinator acknowledgement into durable application history

This candidate connects the independently durable native commit primitive to the
latest externally acknowledged composite application checkpoint. It supports
`track_create`, `track_join` and `track_progress`, accounting for exactly one
original coordinator selection. A create restores a complete `bootstrap-ready`
application cut: the reservation is acknowledged, but initialization has not
been authorized by a known native outcome. The separate initialization request
has its own journal ordinal and `bootstrapRecovery: {receipt}` option. Terminal
close and unknown child or external effects retain separate boundaries.

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

For a lost child-initialization reply, supply `bootstrapRecovery: {receipt}`
instead of `commitRecovery`. The complete pending history must name exactly the
reserved child and the next request ordinal after its acknowledged create. A
known initialization restores the coordinator-ready cut without another model
selection or host dispatch. The create and initialization receipts cannot be
substituted for each other. An unknown native initialization remains fenced.

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

The exact producer `86b1ecc` / native `8cdec19` hosted gate passed 72 leaf cases,
zero failures/errors/skips, including create/startup and repeated process loss.
[Complete retained proof](evidence/v8-bootstrap-hosted-86b1-2026-11-22/README.md)
records the clean pair and actual clock authority. A further independent native
journal check linking startup to the immediately preceding durable create,
additional before-intent and startup-expiry controls, and terminal-close recovery
are subsequent work; this frozen pass does not qualify those later changes.

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
