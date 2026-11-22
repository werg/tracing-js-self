# Durable registered host arrivals in V8

Registered event inputs can now be saved individually before they enter a live
queue or become visible to a model. This extends the existing private queue
snapshot: an independently retained journal head can recover arrivals that were
received after a saved execution/model checkpoint, provided their acknowledged
public boundary is present in that checkpoint.

This is a bounded registered-event recovery mechanism. It does not implement
arbitrary callback return continuations, distributed leader election, external
resource authentication, or automatic reconciliation of unknown host writes.

## Connect an intake owner

The Node storage entrypoint exports `DurableHostIngressJournal` and
`DurableHostIngressBroker`, alongside the existing `DurableHostIngressStore`.
The journal directory must be private to the embedding and support POSIX hard
links and directory fsync.

```js
import {
  DurableHostIngressStore,
  DurableHostIngressJournal,
  DurableHostIngressBroker,
} from 'tracing-js-self/storage/node';

const ingressStore = new DurableHostIngressStore({directory});
const ingressJournal = new DurableHostIngressJournal({
  directory,
  streamId: 'application-session-inputs',
  maxEntries: 4096,
  maxBytes: 16 * 1024 * 1024,
});
const intake = new DurableHostIngressBroker({
  harness: driver.bridge,
  journal: ingressJournal,
});

const acknowledgement = await driver.bridge.postEvent({
  subscriptionId: 'listener',
  eventId: 'outside-event-1',
  args: [payload],
  deliver: false,
});
```

The application registers the source-owned listener through the existing host
lifecycle before posting its input. One intake owner is attached to a live
harness. Its receipt is private application evidence; it is not a model input.
Explicit `postEvent` and `intake.receive` calls return an acknowledgement promise.
Existing notification callbacks passed to native adapters keep their `undefined`
return value. Their asynchronous storage failures are retained by the intake
owner, and `flush` and checkpoint creation refuse until recovery resolves them.

Each event's arguments are captured before the first asynchronous operation.
Objects shared by arguments, cycles, sparse arrays, null prototypes, `-0`, NaN
and BigInt use the existing graph encoding. Getters and proxies are refused by
that encoding. Mutating the caller's original object after posting does not
change the saved graph. A repeated ID must have the same graph and completion
policy, including after restoration.

Writes are serialized in arrival order. A queue entry is created only after its
immutable log entry is written, fsynced, linked without overwrite, and read back
against its receipt. A competing write from the same predecessor is accepted
only when its complete canonical bytes are identical. Registered native
notifications reserve IDs before awaiting disk, so consecutive synchronous
callbacks cannot accidentally share an ID.

Closing a handler, cancelling an invocation, or closing a realm refuses before
mutation while affected intake remains pending. The embedding can await
`intake.flush()` and then retire the resource. Automatic callback retirement can
mark an owner closing, but waits for its already received arrivals before
publishing final closure. A closure records which accepted pending events it
discarded.

## Save the model and host boundary

The application retains the acknowledgement receipt outside the checkpoint's
own hash domain. A receipt proves the selected stored bytes and ordering; it is
not a signature or a substitute for broker authorization.

```js
const ingressLogReceipt = await intake.flush();
const checkpoint = await driver.checkpoint({ingressStore});
```

The application durably saves these values using its existing checkpoint and
external acknowledgement storage. It should quiesce input while choosing that
boundary. Checkpoint creation rejects any unresolved or failed arrival write;
if input races the snapshot write, the existing exact-boundary comparison still
refuses the stale snapshot. A checkpoint made after an acknowledged journal
write includes an `ingressLog` receipt, even if all those inputs have already
been delivered. That prevents an older external journal head from silently
replacing the saved acknowledgement.

The queue snapshot and the journal have different jobs. The snapshot binds
pending private queues to one exact public boundary. The journal independently
retains every accepted arrival after intake was enabled and can supply an
additional tail beyond a saved checkpoint. The first logged sequence may be
greater than one when intake is attached after earlier ordinary arrivals;
subsequent logged sequences must be contiguous.

## Restore before opening the model

```js
const restored = await RegionSelectedModelDriver.restore(checkpoint, {
  select: freshNativeSelector,
  policy: expectedPolicy,
  harnessOptions: {
    ingressStore,
    ingressReceipt: checkpoint.bridge.ingress ?? null,
    ingressJournal,
    ingressLogReceipt,
    services,
  },
});
```

The expected journal head can be equal to or later than the checkpoint's saved
head. Recovery validates the whole selected chain, each entry's exact source
owner and public-prefix digest, argument graph, completion policy and global
arrival sequence. It reconciles inputs already delivered or explicitly
discarded, verifies pending snapshot entries, and stages missing arrivals.
Every row is checked before any queue changes. Source and host validation finish
before the native model restore call.

Newly recovered inputs stay private until normal callback delivery. Recovery
does not call adapters, re-register listeners, deliver a queued input, or move
the model's public history forward. Existing subscriptions remain lost until
the embedding explicitly reattaches the same external resource. A saved durable
input can be delivered while the handle is lost; it cannot authorize new live
input. Reattachment must still carry the existing host evidence.

An arrival captured after public execution advanced beyond the available
checkpoint is refused. The journal cannot invent the missing model history,
rewind external effects, or make a later input appear to have arrived earlier.
Use a sufficiently recent acknowledged checkpoint or explicit application
reconciliation. The bounded journal does not yet compact or rotate itself;
exhausting the configured total byte or entry budget refuses more input.

## Recover a lost write acknowledgement

A process can lose the response after a file was written. No queue input is
accepted on that failed path, and the writer remains failed until replaced.
The store exposes read-only inspection of the next position:

```js
const candidate = await ingressJournal.inspectNext({previous: expectedHead});
```

Inspection validates canonical bytes, the stream, the exact predecessor and
position, and the arrival graph. It does not accept or deliver that candidate.
The embedding compares it with its original event and selected public boundary.
An exact `append(candidate.entry.arrival, {previous: expectedHead})` retry is
idempotent and completes the durability barriers; a conflicting event refuses
without overwriting the existing entry. Retain the resulting receipt explicitly
and then recover a fresh harness with that selected head. No directory scan or
unacknowledged tail is silently treated as host authority.

## Evidence and remaining work

The focused tests cover write-before-queue ordering, immutable graphs,
concurrent notification IDs, conflicting duplicates, global listener order,
new-process recovery of later arrivals, delivered and snapshot reconciliation,
older/forged receipts, missing chain rows, stale public history, storage failures,
lost acknowledgements, ownership retirement, byte/entry bounds and no-follow
reads. Coordinated driver controls verify that a bad journal refuses before
model restoration and that later inputs resume using the already consumed
selection budget. Their model records use an explicitly supplied decoder;
they are host/driver engineering controls, not learned-model success.

Return-value callbacks, arrivals before a registration is source-owned,
distributed ownership and production deployment/rollback qualification remain
separate open gates. The complete work-package tally is maintained in
`LANGUAGE_COVERAGE_V8_CUTOVER_STATUS.md` and producer PR 47.
