# Coordinated V8 model and host recovery

`RegionSelectedModelDriver` can checkpoint one public execution session together
with its dedicated native model transport. The packet binds the acknowledged
model history, host lifecycle, original prediction evidence, and consumed
prediction/retry budgets. Native restoration reexecutes the acknowledged model
continuation; host restoration never dispatches external work.

## API and expected policy

Initialize a dedicated native selector, retain its complete attested identity,
and pass that identity to the driver. It includes the model and tokenizer
identities, seed, device and generation settings.

```js
const nativeIdentity = await select.initialize({
  checkpointIdentity, tokenizerIdentity, seed
});
const policy = {
  checkpointIdentity, tokenizerIdentity, nativeIdentity,
  hostLimits: {maxGenerated: 4096, maxOutstanding: 64},
  automaticDelivery: true,
  maxSelections: 4096, maxOutstanding: 64, maxStaleRetries: 8
};
const driver = new RegionSelectedModelDriver({select, harness, ...policy});

// Persist the complete JSON packet atomically at the application boundary.
const checkpoint = await driver.checkpoint();

// After process loss, create a fresh selector for the same model bundle.
const restored = await RegionSelectedModelDriver.restore(checkpoint, {
  select: freshSelect,
  policy, // Obtained from the application configuration, not the saved packet.
  harnessOptions: {services},
  signal
});
```

The application owns durable storage and the expected policy. Rehashing a packet
does not authorize a different model identity, seed, generation setting or
budget. `hostLimits` and `automaticDelivery` must also match the harness's
configured generated-record limit, outstanding-effect limit and callback delivery
policy. `checkpoint()` and `restore()` refuse engineering selectors that lack
the native acknowledgment and recovery interfaces. Deterministic supplied
decoders remain useful explicit orchestration controls, not evidence of learned
execution.

## What is verified

The `semantic-selected-driver-checkpoint/8` envelope contains `policy`, `bridge`,
`contexts`, `attempts`, `staleRetries`, the complete `native` transport checkpoint,
and a canonical digest. Checkpointing acquires the same serialization lock as
prediction and native acknowledgment. A selected record cannot be saved between
its local commit and native acknowledgment.

Every accepted attempt must agree with the transport and native attempt journals
on its original bytes, fragment tokens, invocation, causal identity and outcome.
Stale attempts remain in all three journals and consume both their original
prediction and stale-retry allowances. Accepted attempts correspond one for one
to the saved contexts and generated public rows.

The producer independently replays the entire public timeline and reconstructs
the context before every accepted record. Saved contexts cannot replace those
derived boundaries. The native acknowledged public prefix must be exactly a
prefix of the host history. Additional observed host rows are allowed: a host
result can arrive while the native snapshot is being collected. Additional
generated rows are refused.

Host checkpoint validation finishes before native restoration starts. The native
transport must attest the exact restored transport digest and zero host
dispatches. Its independent model restoration retains the random state and
reconstructs model cache, retrieval and track state from the original selections.
The reconstructed driver resumes with the retained contexts and attempt counts.

## External work after a crash

A dispatched request whose final outcome was not journaled restores as
`uncertain`. Calling `dispatch()` on it fails. The application must obtain an
external receipt and explicitly reconcile the intent, for example:

```js
restored.bridge.reconcile(invocationId, effectId, {
  disposition: 'fulfilled', value, evidenceId: durableServiceReceipt
});
await restored.runInvocation(invocationId);
```

Retained subscriptions restore as lost host handles. Reattach the existing
subscription through `restored.bridge.inner.reattachSubscription(...)`, then call
`restored.bridge.sync()`. Reattachment admits future callbacks into the restored
shared realm; it does not repeat the original registration request. Callback
predictions consume the same retained global budget as the initial invocation.

## Queued callback inputs at the checkpoint boundary

Registered event callbacks can now be saved before the realm is ready to deliver
them. Use `DurableHostIngressStore` from `tracing-js-self/storage/node` with a
private POSIX directory. Its immutable snapshots use canonical graph bytes,
content digests, atomic publication and file/directory synchronization.

```js
const ingressStore = new DurableHostIngressStore({directory: privateDirectory});
const checkpoint = await driver.checkpoint({ingressStore});
// Retain this expected receipt with the application's trusted checkpoint handle.
// Do not derive the expected value from a packet presented for restoration.
const ingressReceipt = checkpoint.bridge.ingress ?? null;

const restored = await RegionSelectedModelDriver.restore(checkpoint, {
  select: freshSelect, policy,
  harnessOptions: {services, ingressStore, ingressReceipt}
});
restored.bridge.deliverReadyEvents(subscriptionId);
```

The standalone harness has corresponding `checkpointDurable({ingressStore})` and
`RegionExecutionHarness.restoreDurable(packet, {ingressStore, ingressReceipt})`
methods. The receipt is private host recovery evidence; it is never a model
observation. Restoration checks its externally expected identity, reads the
immutable snapshot again, and binds every queue to the exact session, public
prefix, source-owned handler and queue limit before changing any queue. Removing
or substituting the receipt in a rehashed checkpoint is refused when checked
against the externally retained receipt. A changed public boundary, already
delivered event, mismatched owner, corrupt object or oversized graph is refused.

Queued values and their identities remain absent from model context until actual
delivery. Graph encoding preserves aliases, cycles, BigInts, signed zero and
other special numbers. A saved event can be delivered once while its native
listener handle remains lost; admitting future arrivals still requires explicit
reattachment. Restored transport uncertainty and lost handles remain private
host restrictions. Model obligations come from the acknowledged public history,
so a process loss alone cannot change the native model's causal input.

Saving refuses a stale snapshot if another arrival or public transition occurs
during the storage write. Neither write failure nor stale-snapshot refusal drops
queued input. Callers may retry at a stable boundary. This saves the arrivals at
the acknowledged checkpoint boundary; it is not a per-arrival durable broker
log and does not acknowledge arrivals received after that snapshot. Pending
unregistered callbacks and callbacks whose return value is awaited by native
code still require a separate durable continuation and are explicitly refused.

`test/semantic-durable-ingress-v8.test.js` covers fresh-process reconstruction,
private-input isolation, graph preservation, receipt/source tampering, failed
and concurrent writes, mixed Promise state and storage bounds. The coordinated
driver control also verifies host validation before model restoration and the
same consumed global prediction budget after callback delivery. These controls
use explicit engineering records, not learned model selections.

## Current boundary and evidence

This API requires one driver and a dedicated native transport for its session.
It refuses a transport containing unrelated sessions, in-flight selections,
failed acknowledgments or fatal attempts. Take durable checkpoints at successful
acknowledged boundaries. Multi-driver atomic snapshots, application storage
transactions, arbitrary external handle recovery and deployment rollback remain
separate work. The underlying host/protocol continuation must itself be admitted
by `RegionExecutionHarness.restore()`.

`test/semantic-selected-recovery-v8.test.js` uses an explicitly supplied decoder
to check uncertain effects without redispatch, retained callback reattachment,
causal and identity tampering, and prediction/retry budgets across recovery.
Transport controls live in `test/semantic-native-process-v8.test.js`; the paired
consumer's `tests/test_semantic_v8_serving_restore.py` independently checks actual
CPU model reconstruction. These populations do not qualify a trained model's
language quality or a production deployment.
