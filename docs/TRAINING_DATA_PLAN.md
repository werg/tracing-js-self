# Semantic execution training-data plan

Date: 2026-10-22

Status: chosen design and implementation plan. The interfaces and guarantees below are work to implement; this document does not declare them already present. The current executable scope remains in [STATUS.md](STATUS.md).

## 1. Decision

Build a compiler from verified JavaScript executions to compact, causally ordered execution episodes for [megatoken](https://github.com/werg/megatoken). Keep the owned execution machine as the authority, retain its full journal for verification, and train on one deliberately designed semantic trace language.

The model receives the relevant source bundle, the entry invocation, an identity-preserving input graph, and observations available so far. It predicts control decisions, useful computed values, mutations, calls, scheduling transitions, and completion. Small helpers execute inline. Substantial calls use a bounded set of reusable model tracks. External calls receive fully materialized payloads under a declared codec.

The design separates three responsibilities:

- **Semantic events specify supervision:** what was computed, chosen, changed, called, or observed.
- **Model chunks allocate successive computation:** a dependent computation can cross chunks even when its printed trace is short.
- **Tracks assign execution contexts:** an invocation remains identifiable whether it is inline, suspended, or assigned to a separate track.

Use a conservative, explicit state protocol. Shared attention transports evidence about state; stable identities, versions, and causal order determine what that evidence means. Internal values remain an object graph with references, closures, and promises. They are not flattened into external JSON at function boundaries.

The first delivery is a working vertical path through a verified bounded language profile, one compact trace format, a deterministic scheduler, and a megatoken exporter. Broader language and host coverage follows this path. Representation choices below are implementation decisions, not an experiment matrix.

### Definition of success

For every admitted episode, an independent reference agrees with the declared observable outcome, the full journal reconstructs and replays, the training projection preserves its specified semantic facts, and no predictor input depends on unavailable future information. A generated execution is successful only if its completion, observable state, and effects are correct. Correct scalar output alone is insufficient for stateful work.

## 2. Grounding and constraints

This plan was checked against tracing-js-self [9eb4d0c](https://github.com/werg/tracing-js-self/tree/9eb4d0cb7587551d3cc15b6ca39ab21b529b5173) and megatoken [ad0e11c](https://github.com/werg/megatoken/tree/ad0e11c5e93f7b04354cad3c8ebcde328bfdabfe). The latest tracer change strengthens host-journal integrity and deterministic input allocation; preserve those checks throughout the work below.

The tracer already owns frames, environments, heap objects, promise state, a chronological journal, external input arrival/delivery, reconstruction, and bounded deterministic replay. Keep these contracts. Its current entity-replacement journal is an audit representation, not the training wire format. See [runtime](../src/runtime.js), [values](../src/values.js), [replay](../src/replay.js), and [causal projection](../src/causal.js).

The relevant megatoken constraints are:

| Current behavior | Required design consequence |
| --- | --- |
| Text positions are realized in parallel from a selected representation. | A long printed trace does not provide token-by-token recurrence. Use explicit causal chunk boundaries. |
| A meridian is one atomic group with at most one event per track. Predictions precede target encoding. | A produced value becomes available to a dependent consumer in a later committed group. |
| Observed and generated records cannot share a training meridian. | Source/input delivery and generated continuation occupy separate groups. |
| The default registry permits eight distinct user tracks over a session. | Use fixed lanes and separate invocation identities; do not allocate a permanent track name per call. |
| Shared history holds at most 1,024 event chunks by default. | Count source, state, and trace events together and segment long episodes explicitly. |
| Structured tool output has special training support; ordinary trace text does not automatically use it. | Add explicit trace integration. Do not describe an existing tool schema path as an implemented trace decoder. |

Sources: [parallel decoder](https://github.com/werg/megatoken/blob/ad0e11c5e93f7b04354cad3c8ebcde328bfdabfe/src/megatoken/generation/decoder.py), [grouped model](https://github.com/werg/megatoken/blob/ad0e11c5e93f7b04354cad3c8ebcde328bfdabfe/src/megatoken/model/multitrack.py), [configuration](https://github.com/werg/megatoken/blob/ad0e11c5e93f7b04354cad3c8ebcde328bfdabfe/src/megatoken/model/config.py), [training adapter](https://github.com/werg/megatoken/blob/ad0e11c5e93f7b04354cad3c8ebcde328bfdabfe/src/megatoken/training/meridians.py), and [chunking contract](https://github.com/werg/megatoken/blob/ad0e11c5e93f7b04354cad3c8ebcde328bfdabfe/docs/chunking.md).

### Known admission blockers

Focused probes at tracing-js-self [5b22c04](https://github.com/werg/tracing-js-self/tree/5b22c04fd892dd94dadd847f4d252eb888c00055) produced the following wrong results while both structural validation and same-interpreter replay passed. The host-journal changes in 9eb4d0c leave the affected parser, array, and promise handlers unchanged; they do not resolve these semantic gaps.

| Case | JavaScript result | Tracer result | Owner |
| --- | --- | --- | --- |
| String literal `"\x41"` | `"A"` | `"x41"` | Lexer |
| `function f(undefined){return undefined;} f(3)` | `3` | `undefined` | Identifier parsing |
| `a=[1,2]; a.length=1; a[1]` | `undefined` | `2` | Array internal semantics |
| `a=[]; a["01"]=4; a.length` | `0` | `2` | Array index recognition |
| Await an async return of `Promise.resolve(3)` | `3` | A promise reference | Promise resolution/adoption |

Fix or reject each case before the corresponding profile can generate admitted examples. Also implement reference identity/truthiness/typeof without routing them through primitive-only decoding, and commit owned throw/completion events instead of letting guest throws escape the transaction callback as host exceptions. These gaps are visible in [frontend](../src/frontend.js), [values](../src/values.js), and [runtime](../src/runtime.js).

The current host bridge copies guest reference tags into adapter arguments; it does not materialize object contents. The current causal projection omits invocation causes and read observations, and includes all registered sources without source-availability times. Both contracts must change before training export.

## 3. Architecture and ownership

Implement the following pipeline:

1. **Compile a program bundle.** Parse exact source, check the supported profile, assign source sites and binding identities, build control/def-use information, and select code bundles.
2. **Create the execution envelope.** Import arguments, receiver, captures, and reachable input graph with stable identities. Install declared deterministic host fixtures.
3. **Execute with the owned machine.** Record every relevant semantic transition, state update, and scheduler decision. The isolated reference engine never becomes an untraced execution fallback.
4. **Normalize the journal.** Convert implementation-specific instructions into source-level operations and explicit dependencies. This is the canonical semantic record.
5. **Compile the training episode.** Apply the fixed trace, bundle, inlining, lane, chunk, and visibility policies in this plan.
6. **Validate and admit.** Verify the reference outcome, journal, projection, causal context, and serialized episode. Only then place it in the training corpus.

The full journal and normalized semantic record are durable generation artifacts. The model payload contains compact records and permitted context, not checkpoints, archive hashes, private arrivals, or validation answers.

### Runtime roles

The training generator computes ground truth with the owned interpreter. The serving controller has a narrower role: manage lanes, identities, committed state, ready jobs, serialization, and external interactions. It applies model-predicted semantic updates and follows model-predicted control decisions. It must not compute missing arithmetic, silently select the correct branch, replace an incorrect heap with the reference heap, or invent a callee result.

For the first complete implementation, realize each compact trace chunk into the internal controller at commit. This makes state and scheduling exact and inspectable while megatoken retains its selected latent history. Full internal graph materialization into an external transport value occurs only at the external boundary. Realizing a compact internal trace does not require copying entire argument objects or serializing closures for each call.

Store the selected model representation together with its deterministic realized record and decoder identity. Continue from the selected/generated trajectory; never substitute the gold representation during a claimed free-running execution. Invalid output fails that execution or produces explicit validator feedback for a later repair action. No hidden correction is allowed.

## 4. Supported language and execution envelope

### Language policy

Introduce a versioned `training-js/1` profile. Use Acorn as the pinned standards parser, with a fixed ECMAScript edition, exact locations, and no error recovery. Start with ES2022 strict scripts containing function bundles; require an explicit strict directive in source rather than silently changing the semantics of arbitrary submitted code. Acorn supplies syntax/early-error handling and ESTree nodes; the owned compiler remains responsible for runtime semantics. Pin the package version and integrity in the dependency lock. [Acorn parser interface](https://github.com/acornjs/acorn/blob/master/acorn/README.md).

Accept only an explicit list of supported syntax and operations. A successful parse is not admission. The initial profile includes primitive values, let/const, named ordinary functions and closures, return, if/else, while, supported primitive operators, ordinary data objects, and controlled array operations. Reject var, implicit globals, dynamic source, modules, classes, Proxy, getters/setters, generators, and unimplemented intrinsics. Add a feature only when its owned semantics and reference checks land together.

Array index recognition, length updates/truncation, missing properties, and property-key conversion must have actual JavaScript behavior within the admitted operations. Inherited lookup, descriptor effects, coercion, or exotic internal methods outside the implemented profile cause an explicit unsupported result; they must not silently behave as ordinary missing data. Start with dense inputs, indexed reads, existing-element writes, appends, and length truncation. Sparse operations are a later versioned extension.

Add controlled mutation, async, and exceptions as named profile extensions through the milestones below. Syntax support does not enable those dataset categories automatically. Keep the engine262 adoption work as the route to broader owned semantics; this parser decision does not claim that parser substitution supplies a complete interpreter. See [adoption requirements](ENGINE262_ADOPTION.md).

### Envelope

Every execution has a manifest containing:

| Field | Contract |
| --- | --- |
| Program | Exact source bytes, source-site map, code bundle identities, parser/compiler versions, supported profile |
| Entry | Function/code identity, invocation identity, receiver, argument references, capture-cell references |
| Initial graph | Reachable objects/cells/functions, property order, special array state, values, and initial versions |
| Environment | Declared host operations, input codecs, deterministic fixture identity, available initial observations |
| Completion policy | Immediate completion or root-promise settlement, with explicitly retained pending work |
| Limits | Owned execution steps, recursion, graph size, trace size, and episode segment bounds |
| Provenance | Source revision, family/lineage, generation seed, reference identity, policy versions |

The default task ends at synchronous entry completion or settlement of the promise returned by an async entry. Work still pending at that boundary is recorded. Ordinary training examples must have no detached work left pending; intentionally partial executions are a separately labelled diagnostic category. Do not silently drain unrelated work to manufacture a final state.

Define the observable outcome as completion kind/value, reachable returned and input state, captured cells declared observable, ordered external requests/results, and pending work at the declared boundary. Preserve aliases, cycles, property absence, array length, and exact scalar distinctions when comparing graphs. Raw JSON equality is insufficient.

## 5. Canonical semantic record

Keep distinct identifiers for source, code definition, invocation, lexical cell, object, promise, job, effect, event, lane, and chunk. Archive identities may be long globally unique IDs. Model-visible identities are short, deterministic, episode-local ordinals assigned at first causal availability. No outcome-derived identifiers or hashes appear in predictor context.

Every semantic event contains:

```text
event identity and chronological ordinal
owning invocation and source site
operation and typed operands/results
value-producer dependencies
control dependency and chosen successor, when applicable
reads: location, observed version, supplying write/initial definition
writes: location, prior version, new version, new value
call/completion or scheduler/effect identity, when applicable
availability boundary and journal-event mapping
```

Use per-cell and per-property versions in the normalized record. Whole-entity versions may remain in the archive. Track object shape separately for property creation/deletion and array length effects. A read depends on the actual location and the shape/prototype observations needed by the supported operation, not every unrelated property write.

All event payloads are immutable. A historical reference identifies an object; a historical read records the value/version observed then. Later mutation cannot rewrite either event. A source site identifies the source operation rather than a compiler instruction ordinal, so several stack operations can normalize into one meaningful event.

Retain a total authoritative order for one JavaScript agent and explicit dependency edges for value flow, control, calls, state visibility, promise settlement, jobs, and external observations. This dependency graph permits conservative grouping; it does not replace JavaScript's scheduler with arbitrary parallel execution.

## 6. Chosen training representation: semantic-trace/2

Use a deterministic, source-anchored, line-oriented language. Keep the fixed vocabulary readable and small. The model payload carries semantic updates; full provenance, redundant operands, source offsets, and reconstructive state patches stay in the sidecar.

### Static prefix

Provide the exact relevant source, followed by compact maps for code, sites, bindings, captures, and input graph identities. Preserve meaningful source names in the code. Refer to them through small local IDs in recurring records. Do not repeat source expressions, function bodies, immutable literals, or complete local-variable dictionaries at every step.

### Dynamic records

| Record | Meaning and required content |
| --- | --- |
| `enter` | Invocation, code, receiver, argument and capture references |
| `value` | Source result or local update needed by a later semantic operation/boundary |
| `branch` | Source predicate/short-circuit site, outcome, selected successor |
| `loop` | Loop site, continuation/exit, changed loop-carried values |
| `alloc` | Stable identity, kind, initial properties/elements/captures |
| `read` | Shared location, observed version, resulting value when publication/aliasing matters |
| `write` / `delete` | Location, version transition, value or absence; coupled shape/length updates |
| `call` | Child invocation, dynamic callee, receiver, argument references, return destination |
| `return` / `throw` | Invocation, exact value/reference, completion destination |
| `await` / `resume` | Invocation, promise, suspension/resumption and supplying settlement |
| `settle` | Promise, fulfilled/rejected state, value, enabled reactions |
| `request` | Effect identity, operation, codec, complete materialized payload |
| `observe` | Supplied effect outcome and delivery identity; observed context only |
| `code` | Static source bundle and maps made available by a committed call; observed context only |
| `end` | Declared completion and pending-work summary |

The normalizer removes stack manipulation, redundant literal loads, and bookkeeping-only scope steps. It preserves every source control decision, dynamic call, observable mutation, exception transition, and scheduling/effect boundary. Small inlined calls retain enter/return identity even when their payload is folded into the surrounding chunk.

Emit computed values at named binding updates, call arguments/results, shared writes, and values live across chunk boundaries. Fuse pure expression temporaries inside a region; preserve a temporary when the computation is cut. Use static conservative liveness, not a backward slice selected from the eventual answer. Do not replace loops with closed-form summaries or suppress repeated branches based on their future outcome.

Local reads and known literal operands are implicit when source plus committed local state determines them. Shared reads remain explicit at the first access in a region and after any relevant write, call, suspension, or observation. An unchanged repeated read may be omitted only within an uninterrupted region where no supported operation can change the location. The canonical record retains all reads.

### Values and graphs

Retain exact tagged scalar semantics from the current value layer. The text codec uses round-tripping finite numeric spelling, explicit `-0`, `NaN`, infinities and `undefined`, a BigInt suffix, and escaped strings preserving UTF-16 code units. Never normalize Unicode. Escape lone surrogates so the transport remains valid UTF-8.

Objects, functions, captures, and promises are handles into a typed graph. Allocate each identity once and update its locations by deltas. Preserve cycles and aliases. Missing property and present-with-undefined are different states. Property ordering follows JavaScript's supported enumeration rules; archive canonicalization must not change it. Large strings/arrays use chunked value records with a declared type and identity, never an opaque hash as a replacement for semantic content.

### Example

```js
"use strict";
function advance(s, d) {
  if (d <= 0) return s.x;
  s.x = s.x + d;
  return s.x;
}
function pair(s, d) {
  const alias = s;
  const r = advance(alias, d);
  return [r, s.x];
}
```

The prefix declares `s=&0`, `&0={x:2}`, `d=3`, and source sites. A readable rendering of the compact records is:

```text
enter c0 pair(&0,3)
call c1 advance(&0,3) -> c0.r
branch c1.b1 false
read &0.x@0 = 2
write &0.x@0->1 = 5
return c1 5
read &0.x@1 = 5
alloc &1 array[5,5]
return c0 &1
end return &1
```

`alias` and `s` point to the same object. The caller reads version 1 after the child's write. An inline layout places the child records on the same lane; a split layout gives the child another lane and resumes the caller after the child's committed completion. This syntax illustrates the selected contract; it is not output from the current prototype.

## 7. Source bundles, calls, and bounded tracks

### Bundle selection

Construct bundles before execution from the static call graph and lexical dependencies. Use a target of 2,048 tokens under megatoken's pinned reference codec for each bundle, including its source maps. This is an engineering budget, not a measured optimal value. Include the entry and selected inline helpers; include mutually recursive definitions as a unit when they fit. A single larger function is kept intact and prefetched over multiple observed chunks rather than clipped or replaced by an oracle summary.

Freeze the full source registry at episode creation. Only the entry bundle is initially visible to the model. Other code becomes visible through a `code` record when a committed call resolves to its code identity. The loader publishes the exact static bundle and maps in a separate observed group, with no generation loss; a later generated group begins the callee. The availability boundary covers the source bytes as well as their identifiers. Code loading returns declared static source, never an executed result. Resolve closure environments from committed cell identities; loading code does not provide the eventual values of captures.

Select bundles without consulting the executed path, future trace length, return value, or private external input. The same source registry and causal call produce the same bundle. Repeated calls refer to a retained bundle rather than reprinting it. Segment rollover reloads needed source explicitly.

### Inlining rule

Inline a callee when all of these hold:

- It is synchronous and its call target is known at the committed call boundary.
- It contains at most 24 semantic computation/control sites and at most 512 reference-codec source tokens.
- It has no external operation, suspension, or recursion within the current inline chain.
- Its source fits the caller's bundle budget and the inline depth remains at most eight.

These thresholds are versioned defaults. Recursion and larger calls receive distinct scheduled activations. Inlining never discards invocation, capture, receiver, mutation, or completion semantics. A function can remain on one lane while spanning several chunks; inlining does not imply a single prediction step.

### Track assignment

Use the fixed lane names `t0` through `t7`, with `t0` initially carrying the root. The megatoken track field remains one of those eight names throughout a model session. Every activation has a separate monotonically allocated invocation ID and each lane assignment has a generation number in controller/assignment metadata. Never encode a generation as a fresh track name such as `t0:g1`. Reusing a lane cannot reuse an invocation, allocation identity, or reference namespace. Only an explicit new model session resets the track registry.

On a non-inline call, assign the lowest available lane. Keep the synchronous caller suspended until completion. If every lane is occupied, retain the child as a distinct activation on the caller's lane using an explicit stack; do not fail a valid program merely because a ninth invocation exists. Release an assignment on completion or after explicitly parking a suspended activation in an owned continuation record. Parking frees the lane assignment, not the activation: retain its invocation, pending continuations, and return destination, then rebind it with a new assignment generation when ready. Retire the activation itself only when its completion and pending continuations are accounted for.

Model-predicted calls contain the semantic callee and arguments. Lane selection, code retrieval, and administrative IDs are deterministic controller functions based on the committed prefix. The policy must be identical in generation, training, and serving. No planner may use oracle results to decide where a predicted call will execute.

### Grouping rule

Default to authoritative JavaScript order. Group multiple lanes only when their next regions are already ready and certified independent: no shared mutable reads/writes, no external operation, no possible throw, no settlement/resumption, and no data/control or mandated scheduling edge between them. Certify this only from conservative static effect/type summaries, currently committed alias identities, and already-known readiness. Actual future read/write sets or paths from the reference execution cannot certify a group. Inputs to such a group are immutable or disjoint and fully available. If this proof is absent, use successive groups.

Do not speculate across a call merely because its eventual trace proved pure. Do not allow a parent to consume a child's newly generated bytes in the same group. The dependency producer must commit in an earlier group. At most one chunk per lane belongs to a group, and all members are observed or all are generated.

## 8. Chunking and recurrence

Distinguish a **runtime turn**, which follows JavaScript scheduling and host service rules, from a **model chunk**, which allocates one model prediction. A model cut is not a guest yield, promise resumption, or permission to deliver a host result. One runtime turn can span many model chunks; a source function can span many turns.

Choose chunks with a causal online planner. Start at the committed continuation and end at the first of:

1. A branch or short-circuit decision, with the chosen successor emitted as output.
2. A loop backedge or loop exit, preserving loop-carried values.
3. A non-inline call, return to another lane, throw/unwind boundary, suspension, or resumption.
4. A shared write that another runnable activation may legally consume before this activation's next region.
5. An external request, or completion of a materialization needed by that request.
6. Eight value-producing semantic operations in a straight-line pure region.
7. The declared serialization capacity.

Inline helpers can share a region when these limits permit. When an expression exceeds the operation budget, name and carry its intermediate value at the exact source subexpression. All control decisions remain targets; the next group's starting point is derived from the committed decision rather than supplied in advance from the oracle.

Use 512 reference-codec tokens as the target payload budget and respect megatoken's configured hard output limit, currently 1,024 positions in production. Apply the actual pinned raw-byte codec, not characters or another tokenizer. Structural syntax and escaping count toward the limit. The eight-operation budget allocates recurrence even when the payload is much smaller than 512 tokens.

### Large values and target-dependent length

The generator may know the completed trace, but the predictor must not receive its future record count, exact final length, next branch, lane set, or stop reason as conditioning. Such choices are generated outputs or deterministic consequences of already committed state. Offline `part_count` and future terminal labels remain training metadata, never public controls.

If a single value exceeds one chunk, emit a typed value definition followed by consecutive bounded fragments and a generated end marker. The continuation context contains only the committed prefix, the open value's type/identity, and the fixed capacity. The dependent semantic update is not published until that value is complete. This rule takes precedence over ordinary call, return, write, and throw cut points: do not commit their value-bearing semantic event, resume a dependent caller, release/reuse its lane, start a dependent group, or dispatch a request before the final fragment. Fragment chunks commit model history but leave the semantic operation pending; no unrelated guest job or host delivery interleaves. Cut escaped strings or binary encodings only at valid transport boundaries. No external dispatch occurs with a partial payload.

The serializer can end a physical chunk before a record would exceed capacity. This remains a serialization continuation, not a new JavaScript scheduling point. All semantic events mapped to a chunk retain their authoritative order. Do not add host observations between pieces of an otherwise uninterrupted turn.

## 9. Mutation, closures, async, and exceptions

### Mutation and capture rules

Represent arguments by value for primitives and by identity for references. A call does not deep-copy an object. Represent mutable captures as cell handles. Track closure code identity independently from its capture environment so two closures with the same source can refer to different cells.

Every mutation carries its location, version precondition, next version, and new value/absence. The controller applies committed model-generated patches exactly once. Every subsequent read records the visible version it observes. Coupled array length/element changes are one semantic mutation group and cannot be partially published.

Maintain reference topology for returned objects and compare it during validation. Correct numeric fields do not excuse lost sharing. Retain immutable historical read values alongside current state in the journal; never serialize a mutable live object into an earlier event after the fact.

### Async rules

Implement owned promise adoption, fulfillment/rejection, reactions, queued jobs, and continuation frames before enabling the async profile. Returning a promise from an async function adopts its state; it does not produce a fulfilled promise whose value is that promise handle. Keep fulfillment/rejection distinct from the actual resumption of each waiter.

An async call executes its synchronous prefix before yielding according to JavaScript's semantics. Publish writes at the time they become observable. In particular, a caller may observe the child's writes made before the child's first await; do not defer all state publication until a final join.

Already-fulfilled awaits still preserve the required job scheduling transition. Internal jobs can be processed without a host round trip, but a real suspension/resumption remains a causal chunk boundary under this policy. A group cannot read a settlement generated by a peer in that same group.

The canonical journal records job enqueue/dequeue identities and reaction links explicitly. The compact `await`/`settle` records preserve the links needed to reconstruct the queue, and `resume` includes the dequeued job identity. The controller selects the next legal job mechanically from the committed queue; already-determined scheduler fields are unscored scaffolding. Neither the controller nor the model receives the reference execution's future queue as input.

Retain external arrival separately from delivery. Private arrivals do not enter model context, counters, IDs, hashes, or snapshots. At a legal delivery point, emit an observed record, then predict later continuation in a separate group. Artificial model cuts never authorize a new delivery. For the initial single-agent profile, preserve the recorded legal microtask/job order exactly.

### Completion rules

Introduce owned `normal`, `return`, `throw`, `break`, and `continue` completion records with values or targets. Catch/finally/unwind transitions consume and, where JavaScript requires, replace these records. A normal finally preserves a pending return/throw; an abrupt finally can replace it. Promise rejection remains a guest outcome rather than an interpreter crash.

Keep unsupported operations, resource limits, malformed model output, and runtime implementation failures outside normal guest completion categories. Such runs are diagnostics and cannot be admitted as successful execution targets. Exception examples enter the corpus only after their full completion path is journaled and independently checked.

## 10. External operations and realized values

Classify operations by their semantic boundary. Deterministic primitives and owned library operations remain internal regardless of implementation language. A builtin that invokes a callback must record the callback and its effects. Time, randomness, I/O, and other environment facts are explicit observations.

Add a versioned materializer between guest state and the adapter. It traverses the committed graph without invoking untraced getters or conversions. The initial external profile accepts plain data records, arrays, strings, booleans, null, and finite numbers under a canonical JSON codec. Reject unsupported values rather than silently dropping or coercing them: undefined, nonfinite numbers, BigInt, functions, pending promises, accessors, and cycles require an explicitly different registered codec before use. An operation whose identity semantics require alias preservation must register a graph codec rather than relying on ordinary JSON copies.

For an external call:

1. Evaluate arguments in JavaScript order inside the owned/model execution.
2. Finish any traced conversions required by the registered operation.
3. Materialize and validate against the operation's exact schema and codec.
4. Freeze immutable payload bytes and their internal graph-version provenance.
5. Commit a request with a stable effect identity before dispatch.
6. Deliver the matching success/error observation once at a legal point.
7. Continue the guest computation from that observation.

No guest handle, symbolic expression, closure, or unresolved promise is an external argument. The tool request can contain JavaScript code when the declared tool supports it, but every interpolated data argument must already satisfy the materialization contract. A tool response is supplied context with generation loss disabled; the model predicts the request and its consequences, not an unknowable response.

Generation uses deterministic adapters or recorded fixtures. Verification and replay do not repeat live effects. Serving records exact requests and outcomes and respects operation-specific idempotency. An effect ID prevents duplicate local dispatch; it is not a claim of universal exactly-once delivery across crashes or arbitrary services.

## 11. Context lifetime and segmentation

The episode store retains exact source, typed state, continuations, event lineage, and selected model records. Model attention has a finite budget. Do not assume an old code definition or object value remains accessible after its event is evicted.

Close a segment at a committed semantic boundary after 256 generated event chunks, or earlier before required code/state would leave the retained history budget. The 256-event default reserves substantial space for observations, code, and state within the current 1,024-event shared history; it is a conservative operating limit, not a performance result.

The next segment begins with a continuation packet containing current program counters, live activation/capture references, required source bundles, reachable live state, outstanding effects/promises, and legal ready-job order. Build it only by replaying committed records. During model rollout, it must describe the model's own generated state. It must not use the reference future, re-execute the program to correct state, or include private arrivals.

Allow multi-chunk prefix ingestion before new generated work. If the exact continuation packet and required source cannot fit the declared input/history budget, terminate with a profile-limit diagnostic. Do not truncate live state, silently retain inaccessible oracle memory, or label a partial segment as completed. Keep stable semantic identities across segments and use a new model session/lane registry when reinitializing context.

## 12. Megatoken integration and training contract

Add a dedicated Python adapter in megatoken and a versioned JavaScript export format here. Keep semantic policy in tracing-js-self; the Python adapter validates and translates it into the existing episode schema.

| Tracer concept | Megatoken mapping |
| --- | --- |
| Execution or continuation segment | Episode with source lineage and declared completion policy |
| Source, initial input, continuation packet | Observed records; no policy-generation loss |
| Fixed lane | Track declaration; receiving observations may use the same lane in a separate group |
| Semantic output chunk | Generated record and track event |
| Atomic ready group | Meridian |
| Producer/consumer constraint | Dependency plus strict earlier-group validation |
| External request | Logical action with exact execution/action identity |
| Delivered external result | Observed record matched to that action |
| Outcome/reference/validation metadata | Supervision sidecar, never predictor input |

The adapter must reject same-group dependencies that require the produced value, mixed observed/generated groups, duplicate lane events, unresolved references, and action/result mismatches. Existing general schema validation is necessary but does not prove these execution invariants.

Use the chosen compact grammar as the initial trace payload. Add a typed trace decoder after the grammar and exporter are implemented: fixed syntax and causally determined identities come from the schema/controller, while semantic choices and values remain model predictions. A generated branch or callee must not be fixed from a gold path under the guise of structural scaffolding.

Supervise generated branch outcomes, live values, allocations, reads/writes, calls, completion, and required stop/continuation decisions. Source/input records and delivered observations are context. Source tables, hashes, fixture answers, and offline future metadata never become generated semantic targets or prospective controls. Preserve exact codec output IDs for replay.

For supervised demonstrations, use a clearly labelled teacher-conditioned continuation mode: predict before exposing each target, score it, then commit the recorded target state for the next demonstration step. Add explicit support for this mode in the adapter/trainer; the current ordinary recurrent path can carry sampled selected state, so merely marking records as assistant text does not establish teacher conditioning.

Keep free-running rollout separate and mandatory for correctness reporting: commit the model's own selected representation and realized semantic updates at every step. A wrong request cannot receive the reference response for a different request, and a wrong mutation cannot inherit the next reference state. Deterministic mocks may execute the actual predicted request if it is valid. Record the first semantic divergence; if repair feedback is enabled, identify the subsequent repair steps and their cost explicitly.

## 13. Corpus generation and admission

Generate functions and small bundles specifically for the supported profile. Prefer pure functional style and immutable composition in generation prompts, while retaining a deliberate set of mutation, closure, async, and external-boundary tasks after those profiles are enabled. Libraries enter through validated bounded subsets and their tests; unsupported code is rejected before tracing where possible.

Use deterministic seeds and input constructors that cover branch boundaries, empty/singleton/longer collections, numeric/string edge cases, alias graphs, repeated calls, and reachable control paths. Record coverage as facts about the admitted profile. A generated function is never trusted just because its source looks simple or the VM terminates.

Admission requires all of:

1. Supported syntax and runtime-operation profile checks.
2. Independent reference agreement on completion, reachable observable state, and effects under the same declared environment/schedule.
3. Structural reconstruction and exact replay of the authoritative journal.
4. Normalized-event and projection checks against that journal.
5. Causal visibility checks for every predicted group and code/state packet.
6. Valid bounded serialization and a megatoken episode accepted by both schema and execution validators.

Final outcome agreement does not prove all intermediate values. Add source-boundary reference observations for the admitted constructs, with independently checked instrumentation semantics, and retain operation-level differential cases. Where an intermediate semantic family is not independently covered, mark it unverified and keep that family out of admitted data. Never advertise broad standards conformance from a narrow fixture suite.

Partition by source family/template lineage before generating inputs and trace variants. Keep related bundles, alpha-renamings, generated descendants, and continuation segments in the same split. Deduplicate normalized program structure as well as exact text. Preserve source licenses and provenance in the sidecar. Evaluation includes held-out code families, longer control flow, deeper calls, and larger permitted graphs; these are acceptance coverage, not competing architecture proposals.

Publish corpus manifests with counts for admitted, unsupported, reference mismatch, runtime failure, profile limit, projection failure, and visibility failure. Never bury rejected runs in a generic success count. Train only on admitted examples; retain rejected runs as diagnostics with their first failing boundary.

## 14. Required invariants and verification

The implementation is complete for a declared profile only when these invariants hold:

- **Prefix causality:** changing unavailable future inputs cannot change prior model-visible bytes, identities, controls, lane allocation, or code/state availability.
- **State fidelity:** each read sees a legal committed version; identity, aliasing, captured cells, and array effects survive every projection and segment boundary.
- **Control fidelity:** every source branch/loop/short-circuit decision and abrupt completion remains represented or deterministically reconstructed from emitted decisions and static source.
- **Invocation fidelity:** inline calls, recursion, lane reuse, and parking preserve distinct activations and correct return/exception destinations.
- **Scheduling fidelity:** model cuts do not create guest yields; jobs and host deliveries occur only at legal service points; a dependent consumer follows its producer's commit.
- **Boundary fidelity:** every external payload is complete, immutable, schema-valid, and derived from the committed argument graph before dispatch.
- **Trajectory fidelity:** a free-running continuation is based on generated state and actual observations, never a reference-state correction.
- **Budget fidelity:** all payloads fit the pinned codec and model limits; limits produce explicit incomplete diagnostics rather than fabricated completion.

Required verification cases include the known semantic regressions in section 2; nested/recursive calls; two closures over one cell; two equal-looking distinct objects; multiple aliases of one object; array truncation; write-before-await visibility; reverse external completion order; promise adoption/rejection; finally overriding a return; source availability; large fragmented values; and identical logical execution across lane reuse and segmentation. Enable each category only when its language profile exists.

Check projection equivalence on completion, selected control path, calls, observable state transitions, scheduling, and effects. A verifier that simply re-executes the entire source while ignoring the predicted trace does not establish trace correctness. It must identify the first inconsistent emitted semantic fact.

Report exact outcome/state/effect correctness, first-divergence category, invalid-trace rate, total source/input/trace codec size, model event/group counts, and actual serving compute/memory. Do not infer learned execution quality from replay success or smaller JSON. The architecture is chosen here; these measurements are operational acceptance and regression checks.

## 15. Implementation sequence and ownership

All paths below are proposed additions unless they already exist. Keep commits independently reviewable, and do not mark a milestone complete until its acceptance conditions pass.

### Milestone 1: trusted synchronous profile

Owner: frontend, values, runtime, reference harness.

- Introduce the pinned parser adapter and supported-node/operation checks; preserve exact source spans and strict semantics.
- Fix the admitted string, identifier, reference identity/truthiness, and array semantics; reject unsupported operations explicitly.
- Own and journal synchronous return and uncaught-throw completions, including guest operation errors, without escaping the transaction as a host failure. Keep throwing runs diagnostic until the exception profile is enabled; catch/finally and rejection propagation follow in Milestone 5.
- Add direct function-entry execution with graph/capture import and a declared completion boundary.
- Add independent outcome/state checks, targeted operation probes, and versioned profile admission.

Acceptance: admitted synchronous examples agree with the reference on completion and observable graph state, and their journals reconstruct/replay. No known accepted silent divergence is left in the enabled profile.

### Milestone 2: semantic record and compact target

Owner: new `src/semantic/normalize.js`, `src/semantic/graph.js`, `src/semantic/validate.js`, `src/training/format.js`, and schema files.

- Make invocation, source-site, read-from, and versioned-location information explicit.
- Implement the single semantic-trace/2 grammar, static maps, graph values, liveness rules, and immutable records.
- Retain journal mappings and verify every compact record against its source semantic events.

Acceptance: pure control flow, calls, closures, and enabled mutation produce the documented compact records with no lost identity or decision. The parser/serializer round-trip is exact.

### Milestone 3: causal bundling, lanes, chunks, and continuation

Owner: new `src/training/bundles.js`, `src/training/schedule.js`, `src/training/chunks.js`, and `src/training/visibility.js`.

- Implement the fixed source/inlining/lane/grouping policies and serialization continuations.
- Freeze source registration or journal code availability; rebuild causalPrefix on the explicit visibility contract.
- Add finite-context segmentation and exact continuation packets from committed history.
- Add the serving controller that applies predicted records without computing missing semantic results.

Acceptance: no future-conditioned planner inputs; producer/consumer order survives lane reuse, large values, and segment rollover; model cuts preserve guest scheduling.

### Milestone 4: exporter and first admitted corpus

Owner: new `src/training/export.js`, `src/training/admit.js`, `tools/generate-training.mjs`, and megatoken `src/megatoken/data/semantic_execution.py`.

- Emit versioned episodes with correct observed/generated records, lineage, losses, actions, and dependencies.
- Add explicit teacher-conditioned trace supervision and generated-state rollout handling in the megatoken adapter/trainer.
- Produce a reproducible admitted synchronous corpus and run end-to-end format, visibility, and rollout verification.

Acceptance: the public entry is code plus declared input/state; the full target fits the chosen schema; no oracle answers enter model context; exact trace/state/effect failures are reported at their first boundary.

### Milestone 5: external boundary and controlled async/completion

Owner: runtime scheduler/completions, new `src/host/materialize.js`, adapters, and profile/reference extensions.

- Implement materialization, immutable payloads, request/result identity, and observed delivery.
- Implement promise adoption, rejection, reactions, and owned async continuations; extend the synchronous completion records with rejection propagation, catch/finally, and supported break/continue unwinding.
- Admit these categories only after differential state/effect/scheduling checks and causal projection validation pass.

Acceptance: external arguments contain no unresolved internal values; shared writes are visible at the correct time; reverse completion order and exception/finally paths produce correct committed state and effects.

### Milestone 6: scale and broaden the owned engine

Owner: storage, profile expansion, engine262 integration, and typed trace realization.

- Replace whole-state copies and entity replacement with append-only semantic records, fine-grained patches, and periodic reconstructible checkpoints.
- Add streaming export, bounded worker execution, indexed provenance, and reproducible corpus manifests.
- Extend supported intrinsics/data structures and spec-backed owned operations under the same contracts.
- Add trace-specific structured realization so fixed syntax and already-determined identities need not consume free lexical predictions.

Acceptance: throughput improvements preserve the same semantic and visibility invariants; new language coverage is independently checked and versioned; compatibility claims remain limited to enabled profiles.

## 16. Delivery scope

This plan prioritizes an exact, compact, end-to-end training generator. It does not require full Node/browser integration, a complete ECMAScript engine, a new learned scheduler, latent-only hidden heap semantics, outcome reinforcement learning, or universal durable native-effect replay before the first admitted corpus.

Those broader capabilities can build on the same owned semantic contracts. The next implementation work is Milestone 1, followed by the compact semantic layer and causal exporter. The immediate architectural commitment is one source-grounded trace language whose control, state, call, and observation semantics remain stable across inlining, bounded tracks, model chunks, and external tools.
