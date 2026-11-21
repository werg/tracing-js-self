# V8 source event ownership and publication

The Promise executor, Promise join and ordinary detailed source components now
share one teacher projection with Number conversion, ordinary Proxy traps and
binary memory. A source program can nest these operations inside an executor,
then join and await the resulting Promise. The direct protocol adapters emit
on the same invocation controller through the shared ownership coordinator;
they do not compile a second trace or replace the episode. The separate direct
source projector still serves other protocol families, using the same ownership
coordinator and complete event staging. General protocol-family composition
remains a gate.

## Ownership before execution

`source-claim-coordinator-v8.js` sorts component identities and resolves one
owner for every reserved slot before calling any preparation function. There
is no priority, last match or default owner after an extension declines.
Claims must return a boolean. Missing owners, multiple owners, unprepared
claims and a selected handler that declines are source refusals.

| Slot | Reservation and owner |
| --- | --- |
| Value | Supported tagged values in the current owned prefix, current event and completion facts, plus the language's default `undefined` value. Ordinary values belong to the base component; resolving-function identities belong to the executor component. |
| Allocation | Newly introduced heap/Promise identities and initial or deferred closures that can become visible at the current boundary. The join owns its result arrays; the executor owns its explicitly described closures; binary and Proxy components own their event-created storage; the base owns ordinary data and Promise creation. |
| Main event | One component owns the current event. Join registration/dispatch, executor entry/resolver/helper calls, Number conversion, Proxy access and binary operations have explicit domains. |
| Completion | Each exiting frame receives its own slot. One owned throw can finish a Proxy trap, Number callback, helper, executor and ordinary caller without one component consuming the other exits. |

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
codec and shared value checks. Its generator, construction, iterator, cleanup,
enumeration and array-map domains have not yet moved to the shared effectful
source engine.

## Protocol operations inside the shared Promise source engine

`protocol-source-bridge-v8.js` adapts individual source events from the existing
Number, Proxy and binary components. Discovery uses static source syntax, and
their event/allocation/completion claims reuse the direct compiler's declarative
domains. The ordinary component explicitly excludes those selected domains.
The executor helper domain also excludes those declared protocol events, so a
builtin conversion or implicit Proxy trap cannot claim executor ownership.
Other helper-call restrictions remain unchanged.
Missing and overlapping owners still fail before any preparation or prelude.

Each bridged handler uses the common engine's authoritative controller, public
identity mapping, lexical cells and frame ownership. Private adapter snapshots
live in the common component-state transaction. A handler temporarily restores
its snapshot, runs, saves its new snapshot and restores the adapter object; it
cannot leave closure-local state behind if staging fails. The original family
heap/frame checks run after every event, and all pre/post observers retain the
same deterministic publication boundary. Declared state profiles allow only
the corresponding Proxy storage or pending Number conversion through the
effectful profile guard; construction, property-key conversion and other
undeclared metadata remain refused.

The recurring interoperability case `promise-number-proxy-memory-join` executes
Promise executor → Number callback → Proxy trap → typed-memory write/read, then
Promise join and await. It raises the declared recurring interoperability
population from 30 to **31 cases**, while preserving the existing wire golden
manifest. Independent source execution checks its operation,
completion, descriptor, backing-memory, Proxy and conversion observations. A
fresh source recheck reproduces its public contexts. A checkpoint taken after
the nested memory write preserves the simultaneously active executor, Number
conversion and Proxy trap, and replay reaches the same terminal shared state.
Another source control throws through all three callback/executor completion
owners. Fault controls reject a Proxy handler after call emission and a binary
postcondition after backing mutation, proving the complete live public/private
prefix is unchanged. Reversing the registry produces identical output.

These cases retain the existing public wire operations. The new composed source
profile does not admit async Number/Proxy caller continuations, general cleanup
inside those pending callbacks, Symbol-valued effectful bindings, or rich host
input identity remapping. The host source gate still needs the corresponding
independent rich-state observers before these families can be promoted in
retained host callbacks. Native admission and tokenizer measurements must be
regenerated for the exact producer/consumer pair; passing source controls alone
does not grant training eligibility.

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
