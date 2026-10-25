# Selected semantic execution v4

The production selected interface uses `semantic-execution/4`,
`semantic-trace/4`, `semantic-context/4`, `semantic-continuation/4`, and
`selected-harness/2`. Old envelopes and continuation versions fail closed.
The grammar remains readable semantic work; routing, delivery, source access,
and native dispatch receipts are separate observed envelope records.

## Contract and independent consumers

`src/training/format.js` declares witness fields, required fields, envelope
families, authority, completion modes, identities, and expression bounds.
`tools/generate-semantic-contract.mjs` generates
`contracts/semantic-harness-v4.json`, including positive and negative witness
and envelope fixtures. `--check` detects drift. The Python consumer uses the
same declared fixture bytes and retains independent grammar, scheduling,
visibility, action-materialization, and loss validation.

Program publication is inert. Each admitted invocation supplies its actual
dynamic identity, track, realm, trigger/ingress key, task revision, receiver,
argument graph, completion policy, activation kind, and optional closure,
parent, deadline, and named bindings. The program record includes exact source
bytes and digest, static sites/functions, declared capabilities, dependencies,
source map, language profile, and source metadata. Program capabilities are
established by the embedding and can be restricted further with host `grants`.

Repeated delivery of the same invocation is harmless. Reusing its identity or
ingress key with different arguments, ownership, or policy is rejected. New
input graph identities cannot overwrite retained objects. Retained reference
inputs must name objects already owned by that realm. Receiver and argument
aliases, sparse arrays, cycles, and special scalars survive the boundary.

## Selected state, async calls, and shared realms

Every retained realm has one authoritative heap, cell map, and scheduling
domain. Controllers for distinct invocations refer to those same maps. New
parameter cells are distinct from prior invocations; source names and captured
binding names resolve to explicit cell identities. A failed selected transition
rolls back in place so another controller cannot be left holding stale maps.

Only one guest stack can run in a shared realm. `await` suspends the active
frame. A still-running caller retains its guest turn; an empty stack releases
the turn so callbacks and other admitted work can progress. Promise jobs use a
shared readiness order across controllers. Physical fragments, model calls,
and transport yields do not release guest turns.

Promise-returning broker requests declare the owned Promise they return. For
the published source `function run(){return host.readAsync("key");}` and
invocation `outside:1`, the canonical request is:

```text
request {"effect":"read","operation":"demo.readAsync","invocation":"outside:1","site":{"start":22,"end":43},"arguments":[["str","key"]],"payload":"[\"key\"]","promise":"p1"}
```

Generate complete executable transcripts using the commands below. The controller
checks source function ownership, evaluated argument codecs, capabilities,
Promise identity, and immutable payload bytes before committing a request.

`promise` records create, settle, adopt, and register reactions. `then` can
declare both fulfillment and rejection closures without choosing a future
outcome during registration. Reactions and `queueMicrotask` jobs activate real
owned closure frames and live captures. Callback return/throw is separate from
root completion. Promise adoption preserves pending/settled identity; an
impossible adoption cycle or model settlement of a broker-owned Promise is
rejected. `finally` waits for its cleanup Promise and propagates cleanup
failure. Uncaught microtask failures are recorded in `jobErrors`; required
quiescence must acknowledge them as a thrown completion.

The driver continues selecting `job.complete` after a job closure has returned.
An eligible `end` is bookkeeping and can be committed while another admitted
invocation owns the realm's guest turn. This prevents a completed callback from
blocking the suspended parent whose readiness caused that callback to yield.

`await.returnPromise` records the immediate JavaScript call return separately
from eventual task completion. `call-return` can return this owned handle from
`SelectedModelDriver.run` with `pending: true` and a `taskCompletion` Promise
while the selected loop continues under its owner. `await-returned-promise`
waits for the returned owned Promise. `owned-quiescence` additionally accounts
for required jobs and errors. `end` is the final owned-execution boundary;
pending required effects, continuations, or jobs cannot be hidden behind it.

## One selected request, one native action

`SelectedModelDriver` validates each complete witness in `SemanticController`.
For actual Megatoken selections, it then requires `select.commitRequest` with
the original selected event/group provenance, exact witness bytes, source
digest, and current selected graph. Python commits the derived action through
its existing native dispatcher and returns `semantic-native-action/4`.
The JS broker checks that receipt against the original invocation, effect,
operation, payload, owner track, and record digest before touching a service.
Controlled test suppliers are kept distinct from actual model selections.

The broker persists intent through the optional durable journal before
dispatch. Adapters receive only registered, decoded, source-validated
arguments, an idempotency key, cancellation signal, and explicitly declared
callback interfaces. Native services cannot execute a selected guest closure
as ordinary JavaScript. `invokeClosure` queues a selected activation and
returns its correlated completion. The driver wakes callbacks across retained
realms, including callbacks invoked after registration has returned.

Synchronous operations block their current guest frame until an observed
return or throw is committed. Promise-returning calls may remain outstanding
in parallel. Native throws, native rejections, and owned callback throws keep
distinct `errorOrigin` evidence. Rich ordinary result graphs are observed
inputs under the operation's declared `resultCodec`, never generated facts.
The native teacher records the immutable outside graph at private arrival and
allocates new owned identities only at delivery. Its independent journal
validator checks every allocation, property, alias, cycle, origin and counter.
Teacher projection uses the same public identity allocator as serving, and
renames subsequent reads, writes and graph request payloads consistently.
Checkpoints retain tagged graph snapshots rather than native cyclic objects.
Equal result redelivery is harmless; conflicting
redelivery is rejected. Native callbacks requiring an immediate synchronous
guest return are outside this asynchronous callback ABI and must use an
explicitly supported handshake or be refused.

## Events, lifetime, and cancellation

Callback registrations retain the actual closure identity and captured cells.
Persistent listeners remain active after their registration action settles.
Arrivals, delivery, and activation have separate identities. `postEvent` checks
ownership, lifetime, duplicate identity, representable graph, and queue bounds.
`deliver: false` records a private buffered arrival without adding a public
event; `deliverReadyEvents` publishes it at the legal delivery checkpoint.
Teacher projection can select `automaticDelivery: false` to follow its
independently verified journal checkpoints through the same state controller.

Closing registrations can drain already accepted call-lifetime notifications.
The final completed callback closes a drained call-lifetime registration.
Explicit unsubscribe records discarded queued events and revokes subsequent
arrivals. Overflow and duplicates retain private dispositions. Subscription
close aborts native ownership when an adapter honors the signal. Invocation
cancellation propagates to descendants, callback waiters, registered resources,
and adapter cancellation signals. A late outcome remains attributed to its
original action; cancellation does not assert that an external write was undone.

## Source availability and recovery

`evictSource` removes a track's source availability. Further selection is
rejected until `restoreSource` checks the immutable digest and publishes a new
observed source receipt. Actual model-context rereads retain original and new
observation provenance. The model receives committed state, not a private
teacher heap or undispatched fixture future.

`checkpoint()` produces JSON-safe maps and graphs, source identities,
initialization status, shared cells, frame ownership, Promise/adoption state,
jobs/continuations, subscriptions, event cursors, ingress keys, action ledger,
and selected history. Restoration verifies its digest and independently
replays public selected history before accepting the saved heap, cells,
source, and controller state. It reconnects controllers to one realm state.
Initialization is not rerun.

`SelectedIntentJournal` writes intent and checkpoints to a private local
directory using fsync and atomic publication without replacing existing files.
A new process can read those records without running any native service.
Dispatched or dispatching actions restore as uncertain. `reconcile` requires
external evidence before accepting a terminal outcome or authorizing a retry
that is known not to have dispatched. Service-supported idempotency is still
needed for guarantees beyond this local ledger; the system makes no global
exactly-once claim.

Native subscriptions restore as lost. `reattachSubscription` requires a host
adapter and evidence that it reattached the existing registration; it cannot
rerun guest initialization or manufacture native continuity. Other opaque
resource handles follow their adapter's explicit reattachment or failure rule.
Semantic-state recovery is separate from Megatoken model recurrence recovery.

## Verification and review artifacts

```sh
node tools/generate-semantic-contract.mjs --check
node tools/generate-selected-continuity-v4.mjs artifacts/selected-continuity-v4
node --test test/training-harness-v4.test.js test/training-harness-v4-continuity.test.js test/training-model-driver.test.js test/training-selected-intent-journal.test.js
```

The continuity generator writes canonical JSON and readable chronological
traces for reversed async settlements, Promise-finally cleanup failure,
persistent captured callbacks with external writes, and checkpoint/source
reread/reconciliation. Each episode executes its declared native fixture and
passes adapter-free public replay. The Megatoken consumer independently
imports these same bytes with its production tokenizer. Token costs are
measured there; UTF-8 byte sizes are not presented as model-token counts.

| Requirement | Primary regression evidence |
| --- | --- |
| Code once, dynamic invocation identities, graph aliases | `training-harness-v4.test.js`, `training-harness-v4-continuity.test.js` |
| Shared retained cells, legal suspension, global ready order | `training-harness-v4-continuity.test.js` |
| Owned reactions, both then handlers, finally cleanup, microtasks | `training-harness-v4-continuity.test.js` |
| Persistent callbacks, private arrivals, late-event rejection | Both harness suites and `natlang-selected-executor.test.js` |
| Actual native commitment before effects, sync blocking | `training-model-driver.test.js`, continuity suite, model process tests |
| Durable intents, uncertainty, JSON restoration, no repeat effect | `training-selected-intent-journal.test.js`, continuity suite |
| Strict source/graph/capture validation and rollback | Controller contract suite, graph codec suite, continuity suite |
| Native result graphs, independent allocation validation, later graph writes | `native-result-graph.test.js`, effectful source admission suite |
| No native effect during replay | Every canonical continuity fixture and harness suite |

These are deterministic engineering receipts. Learned rollout quality remains
a separate post-implementation measurement; none of these checks optimize
model weights or use teacher output to repair a selected trajectory.
