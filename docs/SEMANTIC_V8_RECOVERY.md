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

Checkpoint integrity uses canonical JSON object-key order at both the Region
and embedded lifecycle layers. Reordering object keys during durable storage
does not change the acknowledged checkpoint; array and execution order remain
part of its identity. This pre-release definition replaces the lifecycle's
earlier insertion-order checksum. Historical checkpoints with that earlier
checksum require regeneration from a current validated execution; there is no
compatibility decoder or automatic resigning of supplied state.

Invocation delivery fingerprints also use canonical object-key order. The
`bindings` field is a host metadata map from binding names to argument indexes,
so its JSON key order does not assign lexical cell identities. Source-declared
parameters keep their declaration order; an explicit override keeps that
parameter's position. Additional names append in ECMAScript UTF-16 code-unit
lexical order. This applies to both the V6 and V8 lifecycle boundaries and is
independent of guest object property order. The graph's root, object, and property
arrays retain their existing order and identity. Historical checkpoints with
insertion-order delivery fingerprints or differently allocated extra binding
cells require regeneration rather than private-state resigning.

`node tools/generate-semantic-binding-fixtures.mjs --check` freshly rechecks the
original source detail for three binding-order interoperability controls and
verifies the adapted public contexts, replay, and canonical checkpoint recovery.
Its adaptation is deliberately limited to redundant positional mappings and
extra names absent from the original source. These controls do not admit
arbitrary changes to source bindings or establish native or learned execution.

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
observation. Its content digest detects changes against the expected receipt;
it is not broker authentication. The embedding must retain that expected receipt
through a trusted checkpoint handle independent of a packet presented for
restoration. A caller able to rewrite both the snapshot and that trust anchor is
outside this check's boundary. Restoration reads the
immutable snapshot again, and binds every queue to the exact session, public
prefix, source-owned handler and queue limit before changing any queue. Removing
or substituting the receipt in a rehashed checkpoint is refused when checked
against the externally retained receipt. A changed public boundary, already
delivered event, mismatched owner, corrupt object or oversized graph is refused.

Queued values and their identities remain absent from model context until actual
delivery. Graph encoding preserves aliases, cycles, BigInts, signed zero and
other special numbers. Each accepted event has a private arrival sequence.
Events queued for one retained realm are delivered in that order even when
listeners were registered in a different order, and an explicit delivery request
cannot bypass an earlier eligible listener. Different realms remain independent;
closing a listener discards its pending events and allows the next eligible event
in the realm to proceed. The sequence and its next-value cursor are saved with
pending ingress and in generic lifecycle checkpoints, never in model context. A
saved event can be delivered once while its native
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

### Explicit durable checkpoint history

`DurableSelectedHistoryJournal` from `tracing-js-self/storage/node` stores complete
driver checkpoints at boundaries explicitly chosen by the application. Each
immutable position includes the exact previous receipt and the complete native
transport checkpoint returned by `select.checkpoint()`. The writer synchronizes
the file and its directory before returning, refuses to replace an existing
position with different bytes, and bounds the complete chain by bytes and entry
count. Defaults are 64 MiB and 1,024 cuts. The producer never fabricates native
model state from public rows or private counters.

```js
import {RegionSelectedModelDriver} from 'tracing-js-self/semantic';
import {DurableSelectedHistoryJournal} from 'tracing-js-self/storage/node';

const historyJournal = new DurableSelectedHistoryJournal({
  directory: privateDirectory, streamId: 'execution-history'
});
const first = await driver.checkpointDurableHistory({
  journal: historyJournal, ingressStore
});
// Retain first.receipt through the application's trusted durable handle.
// After further successfully acknowledged execution, save another explicit cut.
const later = await driver.checkpointDurableHistory({
  journal: historyJournal, previous: first.receipt, ingressStore
});
// Retain later.receipt independently before treating this newer cut as durable.

// A stale local packet can now advance to the separately acknowledged head.
const restored = await RegionSelectedModelDriver.restoreLatest(first.checkpoint, {
  select: freshSelect, policy,
  historyJournal,
  historyReceipt: later.receipt, // The application's independently retained head.
  harnessOptions: {services, ingressStore, ingressJournal}
});
```

The supplied older checkpoint must exactly match a recorded cut. The selected
head must include that cut; a shortened, reordered, substituted or different
branch cannot authorize restoration. Before opening native model state, the
producer checks every recorded checkpoint's public replay, host continuation,
causal contexts, policy, identities and budgets. Public rows and contexts must
extend their earlier values exactly. **All** consumed driver, transport and native
attempts must remain exact prefixes, including rejected stale candidates and
their original evidence. Runtime cost totals, native session/reconstruction
history, completion acknowledgements and ingress sequence counters cannot roll
back. Every recorded ingress head must extend the earlier recorded ingress chain;
an increased position alone is insufficient.

Private ingress snapshots and arrival journals are independently read at their
recorded receipts before native restoration. The externally retained history
receipt anchors those recorded ingress references. Supply their stores when any
cut uses them. A separately retained newer `harnessOptions.ingressLogReceipt`
can additionally recover arrivals beyond the latest cut, using the existing
owner and public-prefix checks. Dispatched effects still restore as `uncertain`,
and live subscriptions still restore as lost handles. Recovery itself makes no
host call or new model selection. The ordinary native restore verifies and
reexecutes the latest saved model continuation; it does not synthesize results
or reissue effects.

These are distinct validation boundaries: every cut receives host/public
authority checks and cross-cut attempt-prefix checks; the native service
independently reexecutes the latest complete native checkpoint. Earlier private
native RNG/cache state is retained as journaled data and is not individually
reexecuted before that final native restore. A content hash alone does not
authenticate private model state.

This is an **explicit checkpoint-cut journal**. It does not automatically save
every selection, stale rejection, host result, event delivery, completion or
cancellation. If a durable arrival references a later public boundary absent
from the latest recorded cut, recovery still refuses it. Checkpointing also
requires acknowledged selection and dispatch boundaries and idle durable
ingress. No automatic checkpoint hook holds the selection or
ingress lock while waiting for its own work. The application chooses stable
cuts and owns retention of their receipts; files beyond the supplied head are
never adopted automatically. Rewriting or rolling back that independently
trusted head is outside the receipt's integrity guarantee.

Cancellation tombstones, distributed ownership, journal rotation/compaction,
atomic coordination with application transactions, and durability of unsaved
transitions remain separate work. Complete snapshots repeat earlier evidence,
so their storage cost grows faster than an incremental event log and is bounded
explicitly. Earlier insertion-order lifecycle checkpoints must be regenerated
before using this canonical journal.

`test/semantic-selected-history-storage-v8.test.js` exercises actual fsynced
files, fresh-process reads, immutable writer conflicts, missing/reordered data,
corruption and resource limits. `test/semantic-selected-history-v8.test.js` checks
old-cut recovery across later accepted/stale attempts and dispatched work,
fresh-process recovery without redispatch, every intermediate host cut, native
and transport evidence mutation, policy/branch/ingress rollback, and the retained
unsaved-public-tail refusal. Its decoder and model-shaped test snapshots are
explicitly supplied orchestration controls, not learned execution evidence.

### Actual model qualification command

`tools/qualify-v8-checkpoint-history.mjs` measures this explicit-cut API with an
existing actual serving bundle and an original-source artifact. It freezes
clean producer and consumer revisions, verifies model/tokenizer bytes against
the serving manifest, and retains the model's existing training identity.
It performs no training. Only the initial observed public prefix and causal
context enter the unmodified native service; source correspondence is checked
after model execution.

```sh
node tools/qualify-v8-checkpoint-history.mjs \
  --megatoken /absolute/path/to/clean/megatoken \
  --python /absolute/path/to/qualified/python \
  --served /absolute/path/to/actual/served-bundle \
  --source /absolute/path/to/original-source-artifact.json \
  --out /absolute/path/to/new-evidence-directory \
  --seed 17 --max-tokens 128 --max-fragments 1
```

The command saves a cut before selection, acknowledges one actual model record
through the normal driver methods, and saves a later cut. A fresh native
service restores the older packet through the independently retained later
receipt. Complete native/host checkpoint state, consumed attempts, and the next
actual output are compared; only measured timing fields are excluded from
deterministic evidence equality. A provenance-checked malformed model output
is retained and compared as a refusal, with its original bytes and metadata;
the report distinguishes it from a valid next selection. Timeouts and unbound
infrastructure failures cannot qualify that comparison. Both next-output probes
remain unacknowledged. The
report separates retained driver accounting from both native service lifetimes,
including reconstruction and probes, without counting copied historical costs
twice. Original outputs, checkpoints, profiles, source inputs and failed native
evidence remain in the new output directory. A passing result establishes this
bounded recovery case, not complete source execution, automatic durability,
ordinary training quality or held-out generalization.

### Remaining general boundary

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
