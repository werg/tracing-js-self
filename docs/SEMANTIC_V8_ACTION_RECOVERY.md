# Durable selected-action recovery

The direct V8 lifecycle consults independently retained action intents before
calling a native adapter. A checkpoint saved before dispatch can be older than
the durable intent file. Restoring that checkpoint must not repeat the operation.

## Dispatch authority

`SelectedIntentJournal` exposes three distinct operations:

- `append(record)` durably retains exact bytes, accepting an identical retry.
- `readIntent(session, key, attempt)` independently reads and checks those bytes.
- `claim(record)` publishes the immutable file atomically and returns `claimed`.
  Only the writer that creates the file receives `claimed: true`. An identical
  competing claim receives `false`; different bytes for that identity refuse.

The lifecycle requires all three methods when a journal is supplied. An
append-only adapter cannot provide this recovery contract. The filesystem
implementation writes and synchronizes a private temporary file, links it to
the immutable identity without replacement, and synchronizes the directory
before acknowledging the claim. Adapter execution follows that acknowledgment.

Before committing model state or claiming an operation, dispatch reads the next
attempt's durable intent. An existing record must match the complete committed
request: session, key, attempt, invocation, effect, operation, payload and its
digest, task revision and exact selected witness. A retained native-action
receipt must also bind its owner track and selected-record digest.

If the record matches, the lifecycle records the missing dispatch boundary and
marks the effect uncertain. It calls neither the model-commit callback nor the
native adapter. A matching durable intent proves only that this attempt may
have crossed the external boundary. It cannot prove a result or reconstruct a
live native resource. A racing process that loses the atomic claim follows the
same conservative path.

## Reconciliation and attempts

An uncertain effect requires explicit host evidence. A fulfilled/rejected
reconciliation supplies its observed result; a lost result remains unresolved.
Only a truthful `not-dispatched` disposition permits another numbered attempt.
Evidence identifiers are opaque references supplied by the embedding: replay
checks their presence and causal binding, not the truth of the external claim.

An unsuccessful model commitment or journal write does not advance the public
attempt count. If a write reached disk but its acknowledgment was lost, a later
read finds the retained intent and makes the attempt uncertain. It is not
automatically repeated. This includes writes that failed before any adapter
could be invoked in the current process.

Checkpoint creation refuses while a dispatch claim or model acknowledgment is
unfinished. Wait for that boundary, or retain the previous acknowledged
checkpoint. A saved transient `dispatching` state is not a substitute for a
durable receipt. Cancellation while awaiting a claim prevents the current
adapter call and leaves the public attempt count unchanged.

## Executed controls and limits

Direct checkpoint restoration independently replays the complete public history
and checks exact map membership and metadata for invocations, realms, effects,
handlers and callback capabilities. Operation, payload, witness, attempts,
result, source revision, parent, track, deadlines, routing and counters cannot
be replaced by changing private fields and recomputing the checkpoint hash.
Only conservative process loss is allowed: dispatched effects may be uncertain
and active native handles may be lost. Closed or revoked capabilities stay
retired. The direct snapshot API refuses additional private queued work; the
Region durable-ingress API restores it against independently read original
bytes and receipts.

Admission fingerprints use resolved entries and canonical graph identities.
The same raw receiver/argument graph and its observed serialization therefore
identify the same delivery after JSON restoration. Invocation names, including
names that look like callback IDs, do not advance notification registration
counters. Returning callback invocation IDs avoid existing invocation and
pending queue identities without changing that public registration counter.

Callback results require the exact observed handler registration. A late result
cannot reopen a closed handler, revive a revoked callback, or reattach a lost
subscription. An explicitly authorized new dispatch after a not-dispatched
reconciliation may create a fresh native registration while retaining the
existing logical handler identity. Reconciliation of a result alone does not
grant that permission.

`test/semantic-durable-action-recovery-v8.test.js` exercises real synchronized
files and a fresh Node process restoring an older checkpoint. Its external
marker is written exactly once, and the restored process reconciles from that
retained service result. Additional controls race two independent restorations,
lose the acknowledgment after immutable publication, fail before publication,
alter the retained request, cancel a pending claim and reject append-only
storage. The integrated direct lifecycle and journal run passes 14 tests.
The expanded checkpoint, callback, action, driver and durable-ingress run passes
156 tests, including 97 checkpoint-authority controls and restored duplicate
delivery, missing-registration, late-result and allocator regressions. These
counts overlap the earlier focused runs.

These controls establish bounded claim exclusion for the same private journal
directory. They do not establish distributed resource ownership or general
recovery of every later public receipt. Handler registrations, callback arrivals
and selected child histories retain their own causal and durability contracts.
No service outcome is synthesized from the intent file, and no model-learning
or full language-coverage result is claimed by these recovery tests.
