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
budget. `checkpoint()` and `restore()` refuse engineering selectors that lack
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
