# V8 source event ownership and publication

The Promise executor, Promise join and ordinary detailed source components now
share one teacher projection. They no longer choose a single whole-episode
compiler or install one another as an incidental dependency. This is a bounded
composition increment: the separate source projector for the other protocol
families still has its own admission and extension path. That path now stages
each source event and all private adapter state as described below; migrating
its remaining first-match dispatch to declarative ownership is a separate gate.

## Ownership before execution

`source-claim-coordinator-v8.js` sorts component identities and resolves one
owner for every reserved slot before calling any preparation function. There
is no priority, last match or default owner after an extension declines.
Claims must return a boolean. Missing owners, multiple owners, unprepared
claims and a selected handler that declines are source refusals.

| Slot | Reservation and owner |
| --- | --- |
| Value | Supported tagged values in the current owned prefix, current event and completion facts, plus the language's default `undefined` value. Ordinary values belong to the base component; resolving-function identities belong to the executor component. |
| Allocation | Newly introduced heap/Promise identities and initial or deferred closures that can become visible at the current boundary. The join component owns its result arrays; the executor component owns its explicitly described closures; the base component owns ordinary data and Promise creation. |
| Main event | One component owns the current event. Join registration/dispatch and executor entry/resolver/helper calls are distinguished from ordinary source projection. |
| Completion | Each exiting frame receives its own slot. One owned throw can finish a helper, an executor and an ordinary caller without one component consuming the other exits. |

The ordinary component explicitly declares its accepted value, allocation,
event and completion families. Selecting it invokes the existing detailed
projector. An extension's `false` result cannot fall back to that projector.

Claim and preparation inputs are frozen, acyclic plain data. They contain the
source text, current owned prefix, current event and its normalized facts,
and prior component state. They contain no controller, harness, emitter,
journal reader, later event or archive. Preparation results are also frozen
plain data. Component discovery inspects static source syntax; it does not
scan future owned execution to decide how an earlier closure is represented.

## A rejected event publishes nothing

The event wrapper detaches all state needed by the teacher before running the
selected transition:

- The public execution harness, retained realm state, contexts and receipts.
- Owned prefix state and the projection's capture, identity, frame, job and
  continuation maps.
- Certificates, pending calculations, deferred closures and sequence counters.
- Private state belonging to each source component.

Promise creation, reaction registration, lazy closure publication, deferred
capture writes and final completion therefore run in the same staged event as
the selected handler. All applicable component observers run in stable
identity order. If any observer rejects or throws, the wrapper discards the
entire current event. The already committed prefix and earlier effects remain
intact. It commits the staged harness only after the handler, ordinary
projection, completion work and observers all succeed.

This batching belongs only to source-evidence construction. The serving
harness still checks each selected public transition separately. A complete
guest operation is not made transactional, and a later guest exception cannot
undo earlier valid source events. Source staging refuses a harness with live
native transports, pending native dispatches or wake listeners; it never calls
or duplicates host services.

## Remaining protocol families: atomic event publication

The direct protocol source compiler also stages complete owned events. Number
conversion, Proxy traps, synchronous generators, construction, iterator cursors,
ordinary cleanup, enumeration, binary memory and array-map expansion share one
detached public controller during an event. The source-prefix state, emitted
claims, lexical and frame identities, pending accessors, publication sets, and
private adapter state move together only after all event checks pass.

Stateful adapters declare capture and restore operations. The snapshot preserves
aliases between their retained records, including an array-map plan shared by
the parent and callback indexes. An explicitly stateless adapter can omit them;
an imperative adapter with undeclared state is refused. All precondition and
postcondition observers run in stable identity order, including after another
observer rejects. Rejection discards the entire event, its emitted claims and
its reserved identities. Earlier committed source events remain intact.

The source-array mutation guard now runs as an unconditional event precondition.
It can no longer be skipped because another protocol adapter handles the event.
The combined qualification source nests a Proxy trap and typed-memory write
inside Number conversion, then invokes builtin iterators from map callbacks.
Original-source checks, public replay and terminal checkpoint restoration agree.
Fault controls reject Number entry and map callback completion after staged
records were emitted, then compare the complete previous public/private prefix.

This adds transactional publication to that compiler. Its allocation, event and
completion dispatch still uses the existing adapter routing. It does not claim
that all protocol families have joined the declarative ownership registry or
that Promise/protocol-family mixed source programs are admitted.

## Qualification and limits

The focused controls exercise real owned source programs with executor calls,
helper captures, join dispatch, ordinary arithmetic, nested throws, retained
callbacks and host observations. They compare reversed component registration
orders, public replay and checkpoint restore. Fault controls inspect the live
prefix after missing/ambiguous ownership, a handler that declines after its
staged Promise prelude, and a rejected postcondition. A separate control proves
that all applicable observers run even when one rejects the event.

This work does not qualify general Promise adoption, thenable assimilation,
callable `finally`, async executor callbacks, arbitrary protocol-family
composition, native training admission for a new producer revision, or learned
model accuracy. Those gates remain in the main implementation ledger. Public
records for the existing supported executor/join and mixed-host cases retain
their existing checked operations; no teacher ownership view becomes model
input.
