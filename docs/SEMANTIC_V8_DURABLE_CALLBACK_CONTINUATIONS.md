# Durable return-value callback continuations in V8

## Implemented boundary

`SelectedExecutionLifecycleV8.enqueueClosure` creates a selected callback child
and returns a process-local Promise to the native adapter. The child invocation
and its selected controller state are included in a lifecycle checkpoint. The
Promise waiter is deliberately not restored: after a process restart there is no
live adapter stack to receive its settlement. `callbackOutcome(invocationId)`
exposes a completed child's exact tagged completion for an adapter that owns a
separate durable continuation. A guest throw is returned as `rejected` with the
same tagged completion; it is not converted to a normal result.

When a `DurableHostIngressBroker` owns the V8 harness, native
`meta.invokeClosure(closureId, args, receiver)` now passes through the same
write-ahead journal as registered event arrivals. The distinct
`semantic-callback-return-arrival/8` record binds the external parent effect and
owned closure, captures the receiver and arguments together, and is appended and
read back before the callback enters the private queue. A queued callback can be
checkpointed only when the live broker holds its matching arrival. On recovery
the independently retained journal reconstructs that queue; the pending-event
snapshot remains responsible for registered event queues.

Without a durable broker, `enqueueClosure` continues to be an in-process API.
Unjournaled queued callbacks still refuse a mixed V8 checkpoint. A plain
checkpoint integrity hash cannot authorize host inputs.

The parent native intent also remains uncertain after a crash once dispatch
began. `dispatch` does not retry an uncertain intent. The embedding must use
`reconcile` with independent external evidence before that parent can continue.
An adapter's Promise continuation is never serialized or reconstructed by the
runtime.

## Intake and recovery contract

The typed arrival contains the session and exact public prefix; the parent
invocation, effect payload/witness digest and immutable source digest; the
closure code and captured-cell identities; the retained heap identities at
intake; and the child's identity, graph, receiver and global arrival sequence.
Recovery replays that exact original prefix to verify the binding. It also
checks that the closure was actually supplied to the committed callback-capable
host request. A closure merely existing in the same realm is insufficient.

Raw host receiver and argument values are captured in one graph before any
asynchronous storage work. Cycles, cross-root aliases, sparse properties and
special scalar values remain intact. An embedding's `prepareCallbackInput` may
explicitly refer to retained owned objects; it cannot overwrite them or invent
an unknown receiver. Newly introduced local IDs may move if intervening guest
work allocates them before admission. The move preserves aliases and leaves
external retained references unchanged.

`broker.receiveCallback({ownerInvocationId, parentEffectId, closureId,
invocationId, args, receiver, deliver})` exposes an intake acknowledgement with
the child ID and durable receipt. Its separate `completion` Promise belongs to
the live adapter. The lower-level API accepts a stable caller-supplied child ID
for exact retries. Pending and accepted retries must match the owner, effect,
closure and entire receiver/argument topology; conflicting retries refuse
without writing. A duplicate acknowledgement does not fabricate a new native
completion waiter. `enqueueClosure` uses the broker automatically and retains
its existing Promise-returning host API.

The complete linked journal is validated before any restored queue changes.
Queued inputs absent from the public history are staged once. Already admitted
children must match their public invocation's owner, graph, receiver and policy.
Active and completed children use the selected state checked against that public
history. Owner cancellation accounts for discarded queued work. Registered
events and durable return callbacks share arrival order within their retained
realm. Independent realms remain independently runnable. Recovery itself does
not activate a child, publish its private inputs or invoke any native adapter.

The child is resumed from its saved selected state or admitted once from its
durable arrival. Its completion remains separately queryable with
`callbackOutcome`. The parent intent stays uncertain until the adapter's own
continuation recovery produces an externally evidenced result and calls
`reconcile`; the runtime does not infer that result from the guest callback
alone. This preserves throw/return ordering without duplicating external work.

## Executed controls and remaining gates

`test/semantic-durable-return-callback-v8.test.js` executes eleven controls:

- A gated journal write keeps callback inputs outside both the live queue and
  public context; caller mutation after capture cannot change the stored graph.
- A new Node process restores a later callback arrival, admits the same child
  once, observes preserved receiver aliases and refuses parent redispatch.
- Queued, active and completed child checkpoints preserve exact return and throw
  values. Active restoration consumes only the remaining completion record.
- Prepared callback inputs and results preserve retained owned-object identity.
- Registered events and return callbacks retain their shared FIFO order through
  journal plus private snapshot recovery.
- The whole saved callback queue must match the journal. Extra, duplicate and
  reversed rows refuse atomically; an earlier journal-only arrival is merged
  ahead of an already saved later callback.
- Changed parent effect, closure, retained-ID authority, prefix, order and
  receiver refuse before any recovered child is staged. A changed delivered
  graph also refuses when compared with the public child invocation.
- Native `meta.invokeClosure` takes the durable path without a separate adapter
  call, and guest completion alone does not settle the parent intent.
- Reentrant child → host → grandchild work restores, returns an owned object,
  and requires separate external reconciliation for both interrupted parents.
- A lost acknowledgement requires read-only inspection followed by exact-byte
  append retry before recovering the child; no dead adapter waiter is recreated.
- Failed writes, conflicting duplicates and owner cancellation retain explicit
  refusal/discard behavior with no duplicate child execution.

These are controlled producer lifecycle tests, including fresh-process recovery.
They do not claim independent original-source/native admission or actual-model
selection. General adapter-owned continuation protocols, operational broker
authentication, distributed intake ownership, log rotation, recovery when later
public history is missing, and deployment/rollback qualification remain open.
The journal's existing bounded single-writer storage and independently retained
receipt assumptions continue to apply. The runtime deliberately never infers
whether or how the external parent should settle from a guest callback result.

## Original-runtime transport

`executeWithNativeServices` now supports the declared Promise-returning callback
bridge on asynchronous `natlang.call` requests. It snapshots one receiver and
argument graph before yielding and journals a typed `external.callback.enqueue`
job with a unique return identity. The job imports its graph atomically when
entering the original owned closure. A native Promise waits for that frame's
exact return, throw or returned owned Promise settlement. A callback throw does
not fail the unrelated root invocation; the native service decides how to use
or propagate it. A callback may itself await another host request and callback.

Read-only archive validation checks the closure against the immutable dispatched
request, the imported input graph, receiver and parameter aliases, and the
return identity. Exact replay executes the same original owned frames using
recorded arrivals, without restarting any native service. Seven focused controls
in `test/native-return-callback.test.js` cover sync/async closure returns and
throws, captured receiver/argument cycles, concurrent FIFO return waiters,
reentrant child host work, atomic authority refusals and tampered archives.

`natlang.callSync` return callbacks fail closed: the
synchronous owner is blocked inside its guest job and cannot yield for this
asynchronous re-entry protocol. Notification callbacks retain their existing
primitive, void-return contract. Cross-boundary graphs are snapshots; native
identity across separately captured host calls is not an implicit retained-cell
capability.

## Source-derived continuation evidence

The ordinary source pipeline now carries return callbacks end to end. A fixture
may identify a callback anywhere in its declared argument graph with `path`,
capture the receiver and arguments in one `inputGraph`, and set
`resultFromCallback` to derive the parent fixture result from that callback's
actual completion. The fixture records both arrival and completion. It cannot
replace an incorrect callback answer with a predetermined parent answer.
Repeated occurrences of one owned callback also share one native trampoline.

The projector admits the child at the original runtime's `job.enter` event,
after checking the dispatched parent and original callback-arrival identity.
It maps the imported input graph into the retained selected realm, preserves
the exact receiver and captured lexical cells, and attaches both arrival and
activation events to its private source certificate. The public representation
uses the ordinary callback invocation and child continuation records.

`fixtures/semantic-regions/return-callbacks.js` supplies four reusable source
cases: receiver/argument cycles and captured state across two callbacks, a
thrown callback, an async callback, and a child that awaits another host request
and callback. All pass the ordinary source certification path, four independent
native source executions (original, operations, branches and completions),
mixed public replay and source evidence rechecking. A detailed fallback for a
case without a supported compact local region is recorded honestly.

`test/semantic-source-return-callback-v8.test.js` additionally restores a later
durable arrival from an earlier source-produced checkpoint, restores the active
child again, and consumes only the remaining source-produced selections. Its
public timeline exactly matches uninterrupted source execution, including the
second callback and captured-cell update. A fresh Node process separately
restores the source-derived throwing child. A further fresh-process control
checkpoints the first callback while it waits for its own host request, then
recovers the later grandchild arrival from the journal. It admits that grandchild
once and resumes both child and root using only the remaining source selections
and independently retained external result receipts. Both parent intents stay
uncertain until their respective receipt is imported; neither native waiter is
recreated and neither external operation is dispatched again. The final public
timeline matches the independently checked uninterrupted source run exactly.

These source and durable-recovery controls still do not establish actual-model
selection, callback-capable deployment qualification, or an adapter-owned
external continuation protocol. Native consumer admission is a separate gate;
the source-only tests explicitly report it as untested.
