# V8 source event ownership and publication

The Promise executor, Promise join and ordinary detailed source components now
share one teacher projection. They no longer choose a single whole-episode
compiler or install one another as an incidental dependency. This is a bounded
composition increment. The direct source projector for the other protocol
families now uses the same ownership coordinator and stages every event and
its private adapter state. The two source compiler paths still have separate
admission profiles; arbitrary Promise/protocol-family mixtures remain a gate.

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
The coordinator snapshots registered identities and claim functions. Caller
mutation cannot replace the policy after registration. Transparent Proxies,
accessors and non-data slot inventories are refused before their traps or
getters execute.

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

## Direct protocol families: ownership and atomic publication

The direct protocol source compiler also stages complete owned events. Number
conversion, Proxy traps, synchronous generators, construction, iterator cursors,
ordinary cleanup, enumeration, binary memory and array-map expansion share one
detached public controller during an event. The source-prefix state, emitted
claims, lexical and frame identities, pending accessors, publication sets, and
private adapter state move together only after all event checks pass.

`protocol-source-claims-v8.js` declares current-event domains for those families.
The compiler reserves every unpublished allocation in the current prefix and
event, one main-event slot and one slot for each exiting frame. It resolves
the complete inventory before any preparation, precondition observer, allocation
handler or event handler runs. Claims see frozen source syntax, the current
instruction, owned prefix and private component data; they receive no mutable
public controller or archive reader. The ordinary component has an explicit
operation/builtin domain. An extension cannot decline after emission and fall
back to ordinary projection.

Generator delegation and builtin iteration have disjoint synthetic guard/call
domains. Ordinary construction, binary constructors and Proxy creation have
separate domains. A callback completion belongs to the retained operation that
registered that frame; overlapping callback owners are refused. All allocation
and completion handlers must explicitly succeed. Static syntax capabilities may
overlap and are all checked; function-definition declarations must be unique.
Reversing the registry gives the same records, certificates and profile list,
including code in branches that are not executed.

Stateful adapters declare capture and restore operations. The snapshot preserves
aliases between their retained records, including an array-map plan shared by
the parent and callback indexes. An explicitly stateless adapter can omit them;
an imperative adapter with undeclared state is refused. All precondition and
postcondition observers run in stable identity order, including after another
observer rejects. Rejection discards the entire event, its emitted claims and
its reserved identities. Earlier committed source events remain intact.

The source-array mutation guard now runs as an unconditional event precondition.
It can no longer be skipped because another protocol adapter handles the event.
Lazy ordinary-constructor prototype publication also runs as a staged prelude,
including a prototype write whose main event belongs to ordinary properties.
The combined qualification source nests a Proxy trap and typed-memory write
inside Number conversion, then invokes builtin iterators from map callbacks.
Original-source checks, public replay and terminal checkpoint restoration agree.
Fault controls reject Number entry and map callback completion after staged
records were emitted, then compare the complete previous public/private prefix.

The frozen-view controls exposed inherited `valueOf`, `toString` and `constructor`
properties being mistaken for numeric version counters by semantic normalization.
Normalization now reads only owned property/version entries. It cannot retain
a host prototype function as private source data when a guest first writes a
same-named property.

This compiler's ordinary scalar/reference/Symbol values still use its direct
codec and shared value checks. It does not yet combine its domains with the
Promise source compiler, generalize the supported language profiles, or qualify
new producer/consumer revisions for ordinary training.

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
