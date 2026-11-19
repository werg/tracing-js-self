# V8 Symbol and property protocol

`semantic-protocol-record/1` is an explicit extension used by the v8 execution
contract. It does not widen `semantic-trace/6`, `semantic-trace/7`, or
`semantic-algorithm/2`. A canonical target line is `protocol ` followed by the
sorted-key JSON encoding of exactly one checked semantic operation. The codec
rejects alternate byte encodings, additional fields, observing JavaScript
objects, and expressions which conceal a property access or call.

The controller implementation is `src/semantic/protocol-state-v8.js`; the exact
record field table is exported as `PROTOCOL_RECORD_V8_FIELDS` from the codec.
The first profile is `symbols-ordinary-properties/1`.

## One heap and one call stack

The protocol uses the selected controller's existing `heap`, `locals`,
`captureAliases`, `receiver`, `stack`, `frameFunctions`, `pending`, `lastReturn`,
and `completion`. It does not keep a second object graph. Each operation stages
its mutations, checks every supplied result, and commits atomically. An incorrect
claim leaves the actual controller unchanged.

The additional field `controller.protocol` has schema
`semantic-protocol-state/1` and exactly these fields:

| Field | Meaning |
| --- | --- |
| `schema` | The exact protocol state schema |
| `symbols` | Well-known, unique, and registry Symbol declarations |
| `pendingCalls` | Accessor reads/writes awaiting a checked function completion |
| `callFrames` | Active protocol calls and the parent scope to restore |
| `sequence` | Number of committed protocol records |

All well-known Symbol declarations are present initially. Their identities are
`well-known:` plus the corresponding name in `WELL_KNOWN_SYMBOLS`. A fresh Symbol
has an `oN` identity and an explicit string or undefined description. Registry
Symbols have an explicit registry key; a second request for that key must reuse
its existing identity. Descriptions never substitute for identity. Object and
Symbol identities share one allocation namespace. The compact allocator must
reserve `protocolReservedIdentitiesV8(controller)`, including Symbols which are
not heap objects.

A public tagged value is an existing lossless scalar/reference or
`["symbol", identity]`. A public property key is exactly `["str", text]` or
`["symbol", identity]`. Inside the shared property Map, string keys stay strings
and Symbol keys stay tagged arrays. The machine compares these arrays
structurally, including after JSON restoration. Guest strings beginning with NUL
cannot collide with Symbol keys.

## Ordinary property state

Each ordinary object, array, or closure retains its existing property Map.
Additional state is represented on that same node:

| Field | Meaning |
| --- | --- |
| `descriptors` | Map of property keys to data flags or accessor references |
| `keyOrder` | Property creation order, with integer-key sorting at enumeration |
| `extensible` | Explicit extensibility when it has been changed or inspected |
| `prototype` | `ordinary`, `null`, or an owned reference |

A data descriptor stores its value only in `properties`; its descriptor entry
contains `kind`, `writable`, `enumerable`, and `configurable`. An accessor stores
`kind`, `get`, `set`, `enumerable`, and `configurable`, and has no property value.
Missing descriptors mean ordinary writable/enumerable/configurable data, except
array `length`, whose usual nonenumerable, nonconfigurable flags are explicit in
the machine. Public `property.define` records contain the complete resulting
descriptor, including the data value where applicable.

The machine checks descriptor compatibility, readonly assignment, deletion,
extensibility, prototype cycles, inherited data reads, receiver writes, and
ECMAScript own-key ordering. It checks all four enumeration modes: all own keys,
string keys, Symbol keys, and enumerable string keys. Enumeration allocates its
result array under a declared fresh identity. Enumeration never executes a
getter.

Intrinsic prototype methods, proxies, unusual array descriptor changes,
partial-failure array truncation, and observable key/coercion hooks require
further declared operations. They are refused by this profile. Missing intrinsic
properties must not be misreported as undefined. The public ordinary-data view
can validate only the values reachable from a supplied list of roots; scalar
arithmetic can therefore run beside rich heap nodes without inspecting them.

## Accessor completion and scope

`property.get.call` and `property.set.call` resolve the descriptor at the time of
the operation, verify the callable, and enter the same shared function-call
stack. A pending call records the operation, call identity, child and parent
invocations, object, tagged key, receiver, callee, and assignment value (null for
a getter). There is no future result in this state.

Each active call frame records `child`, `parent`, `priorReceiver`, `priorAliases`,
and `arguments`. Entering a call changes `receiver` and capture aliases. Argument
values are available in explicit cells named `child:argument:N`; the receiver is
also stored at `child:this`. Closure allocation explicitly distinguishes
`ordinary` functions from `arrow` functions, with the latter storing their
lexical receiver. Parameter and body binding records remain separately checked
source-derived transitions.

Returning or throwing restores the parent receiver and capture aliases. The
very next protocol operation after an accessor body returns must be
`property.finish`. A getter's normal value is its return value. A setter's normal
value is its original assignment value, regardless of what the setter returns.
An abrupt body completion takes precedence over either normal value. A false
finish claim cannot consume the pending call.

Ordinary detailed arithmetic may run between accessor entry and completion.
Detailed calls, returns, and throws cannot bypass the active protocol scope;
they must use matching scoped protocol records. Detailed property records cannot
bypass Symbol keys, descriptors, or a custom prototype.

## APIs and qualification

- `applyProtocolRecordV8(controller, record)` checks and commits one claim.
- `createProtocolStateV8()` creates the complete well-known Symbol table.
- `snapshotProtocolStateV8(controller)` returns the JSON-safe protocol portion.
- `restoreProtocolStateV8(controller, snapshot)` validates Symbol references,
  descriptors, call scope, creation order, and identity consistency against the
  already restored shared heap and cells.
- `assertProtocolDetailCompatible(controller, record)` guards older detailed
  operations against bypassing protocol semantics.
- `protocolOrdinaryHeapViewV8(controller, {roots})` inspects declared reachable
  ordinary data without running hooks and returns the same authoritative heap.

Shared-state serialization must encode `heap` Maps and nested descriptor Maps
as entry arrays. Symbol keys need no stringification. Reconstruction creates Maps
and then invokes the protocol restoration validator.

`RegionExecutionHarness.select()` now accepts canonical protocol lines and
commits them into the same controller used by compact and detailed records.
Every v8 shared state has `protocol: null` before the first protocol operation.
The harness serializes nested descriptors explicitly, stages the complete state
before enforcing the continuation byte bound, and updates the existing realm's
heap and cells only after validation. The causal serializer supervises protocol
target bytes exactly and counts these records in the remaining detailed share.

The first integrated lifecycle allows one fresh synchronous invocation. Host
work, asynchronous observations, and new invocations after a protocol operation
are explicit refusals. A protocol checkpoint uses
`semantic-protocol-continuation/1` inside the v8 envelope. Restoration replays the
complete public history, compares every stored shared-state field, and validates
the retained protocol scope; it never passes incomplete protocol history to the
old selected checkpoint parser. Existing host lifecycle checkpoints keep their
own checked path.

The contract also pins `interoperabilityDigest`, covering the exact valid public
executions/contexts and the independent protocol-machine fixture corpus. A native
receipt must match this digest in addition to the malformed-fixture digest. The
historical base admission receipt does not qualify this changed contract.

The bounded contract allows 4,096 Symbols, properties per record, and array
length, 64 active calls, and 32,768 protocol operations. The canonical line bound
is 65,536 UTF-8 bytes. Resource limits and unsupported operations are explicit
refusals rather than fabricated JavaScript exceptions.

`test/fixtures/semantic-protocol-v8.json` contains deterministic **controller
contract fixtures**, including mid-call checkpoints and Symbol descriptors
restored from JSON. These fixtures establish codec and transition agreement;
they are not independent source admission. Source admission requires a separate
versioned source-to-protocol evidence path, original independent execution,
operation/branch/completion audits, and replay of all emitted public records.
Native production admission remains a separate gate pinned to the exact producer
and independent consumer revisions.

## Direct source compiler and independent observations

The new compiler `protocol-source-compiler-v8.js` consumes the owned archive
without using the historical v6 projection. It publishes source-known closures,
initialized live capture cells, Symbol declarations, ordinary tagged-key reads
and writes, descriptors, reflective key enumeration, prototype changes, and
scoped accessor calls. After every published heap transition it compares the
complete descriptor/prototype/key-order view with the committed owned state.
Unknown heap metadata or an unprojected allocation refuses the case even if its
final scalar happens to agree.

Scalar computations and ordinary cells use detailed records, allowing existing
compact local arithmetic to compose with the protocol. Symbol computations and
rich property operations use the new record family. Source offsets and journal
certificates remain private evidence; they are absent from canonical targets.

`protocol-source-reference-v8.js` runs four separate independent V8 processes:
original source, executed operation observations, branch observations, and
completion observations. The last has its own
`source-protocol-completions/1` identity vocabulary. Distinct Symbols with equal
descriptions remain distinct, and rereading the same Symbol preserves its
observation identity. The historical public trace grammars still refuse Symbol values; the shared
source observation helpers do not grant public admission. Instrumented outcomes must equal the original
outcome, and the owned operation, decision, and completion receipts must match
independently observed receipts.

The first direct source profile requires strict synchronous functions and simple
parameters. It explicitly refuses asynchronous state, classes, constructors,
generators, completion handlers, unknown builtins, and rich values escaping the
ordinary observable graph boundary. This is the declared scope of this slice,
not a claim that those JavaScript features are interchangeable with ordinary
values. Their runtime implementations require later protocol operations before
this source path can qualify them.

`test/fixtures/semantic-protocol-source-v8.json` contains actual source-produced
canonical claims for a Symbol-keyed getter bracketed by arithmetic. Its
qualification is owned execution plus independent source checking. Full v8
context/continuation/native admission is represented by the outer region
artifact and remains independently required.

## Complete source-bound region artifacts

`verifyProtocolRegionTrainingCase(fixture)` now builds an outer v8 execution with
schema `semantic-protocol-region-evidence/1`. Its private `sourceArtifact` uses
`semantic-protocol-source-evidence/1`, distinct from older admission evidence.
The public program, input graph, generated protocol/detailed/compact records,
and one causal context per generated record replay through
`RegionExecutionHarness`. Source proof and owned archive data are never included
in generated target lines.

A local replacement is accepted only if replaying its original detailed records
and evaluating the candidate compact region produce equal complete shared
states, including descriptor Maps, Symbol identity, capture aliases, receiver,
completion obligations, and protocol sequence. Pure scalar regions can therefore
appear before and after a Symbol-keyed getter without forgetting its rich state.

`recheckProtocolRegionEvidence(artifact, options)` reconstructs the owned run from
the exact source and observed input graph, repeats all four independent source
runs, rebuilds the source projection and every context, and restores the public
checkpoint. Changes to source, a descriptor, a pending accessor, a capture cell,
or a context are rejected even if the attacker recomputes ordinary transport
hashes. The ordinary observable completion graph must agree with independent
execution. Native production remains unadmitted until the pinned independent
consumer validates its own exact receipt; `requireNative: true` cannot be
satisfied by an earlier bare `admitted` flag.

The first protocol row cannot inherit a nested legacy call scope. Once protocol
state exists, generic calls use protocol records; root-level detailed completion
is still valid after all scoped calls have ended, which permits an ordinary
compact return. Detailed allocations cannot reuse a Symbol identity. An explicit
null prototype remains null across lookup, description and JSON checkpointing.

## Independent metadata gate

Matching a scalar result is insufficient evidence for object descriptors or
prototypes. The completion-instrumented reference now also produces private
`source-protocol-metadata/1` receipts. At each observed initialization, mutation,
call, statement, return, throw, or cleanup boundary, the observer snapshots every
ordinary object or Symbol reached by the observed values so far. It reads own
property descriptors and prototype identities, without invoking accessor bodies.
Data values, accessor identities, flags, integer/string/Symbol key order,
extensibility, and Symbol descriptions/registry membership are compared with
metadata extracted at the same owned source boundaries. Intrinsic Object and
Array prototypes remain distinct. Proxies are rejected before reflection can
invoke any trap.

These snapshots are **private source evidence**, not target records, selected
state replacement, or model-visible futures. A metadata receipt uses its own
observation identities rather than trusting the teacher's object IDs. The full
source gate requires metadata agreement in addition to original outcomes,
operations, branches, and completion identity. Receipt growth is bounded to
8,192 snapshots and 4 MiB in total, with at most 1 MiB per snapshot; exceeding a
bound refuses the source case.

The regression suite injects consistent enumerable/prototype bugs into both the
teacher and its owned replay. Those faulty executions still return the same
scalar and produce self-consistent public property claims, but independent V8
metadata rejects them. Separate readonly, intrinsic-prototype and Symbol
metadata mutations preserve every scalar/reference completion receipt and also
fail the metadata comparison. Function own-state, private brands, generators,
and Proxies remain outside this metadata profile until their distinct observer
contracts are implemented.
