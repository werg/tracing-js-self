# Semantic execution harness: code, invocations, tools, and dynamic tracks

**Status:** implementation roadmap; proposed contracts below are not claims of working or trained functionality.

**Reviewed:** 2026-10-25.

**Repositories:** [tracing-js-self](https://github.com/werg/tracing-js-self), [Megatoken](https://github.com/werg/megatoken), [Natlang](https://github.com/werg/natlang).

**Prototype baseline:** [tracing-js-self PR #30](https://github.com/werg/tracing-js-self/pull/30) is merged. Exact inspected revisions and remaining gaps are in [section 1](#1-reviewed-baseline).

## 0. The product and implementation mandate

The product is an LLM that executes supported JavaScript/TypeScript by producing a readable semantic trace. Each execution receives **the code first, then an explicit invocation, then generates the execution**. When execution reaches an external operation, the model emits a tool call with already evaluated arguments. The harness performs the operation and supplies the tool result. The model continues the same invocation from that observation.

Outside callers and events can also start execution. In Megatoken, a selected lifecycle tool call can create a child execution track. That child receives its own code context and invocation, executes through the same tool/result protocol, and returns a correlated completion to its parent.

The execution trace should make the program's behavior easy to follow: values computed, branches taken, calls made, state changed, external interactions, and reasons for suspension and resumption. It is a structured account of executed semantics, not free-form reasoning prose.

### Mandatory instructions to the implementer

**Complete the entire implementation scope in one continuous, coordinated effort across tracing-js-self, Megatoken, and Natlang. Finish all required implementation and integration work in all three repositories before starting or requiring any training.** The milestones in this document specify dependency order and verification checkpoints. They are not stopping points, optional follow-up projects, or requests for the user to authorize each next stage. Use multiple commits, branches, or coordinated PRs as useful, and continue through the full engineering completion gate in section 7.

The required delivery includes the protocol and schemas, readable trace, controller, effect broker and adapters, dynamic tracks, invocation/event ingress, callbacks and Promises, retained state and recovery, actual Natlang integration, and all training-data, model-inference, training, evaluation, migration, CI, and documentation infrastructure. Implement these comprehensively; do not leave an in-scope component as a stub, deferred TODO, or work to be filled in after training. Explicit refusals for semantics outside the declared scope remain valid; they must not be used to silently defer an in-scope feature.

**Training infrastructure is implementation work; running training is a later activity.** Complete the teacher/compiler and corpus-admission pipelines, production tokenizer/consumer, loss and visibility handling, model adapter, training configuration, checkpoint/restart support, evaluation tools, and reporting during this effort. Validate them using deterministic fixtures and non-optimizing tests. Do not insert a small training, fine-tuning, overfitting, optimizer-driven smoke run, or learned-success threshold as a prerequisite for continuing to another repository or finishing another component.

If a real access or infrastructure blocker prevents a component, record the exact blocker and complete all unaffected work. A missing trained checkpoint, low model quality, or unavailable training compute is not a reason to stop implementation. The handoff is a comprehensive, tested cross-repository implementation ready for training, with empirical learned quality explicitly left for the subsequent training stage.

### Decisions to build around

| Decision | Contract |
| --- | --- |
| Code precedes execution | Publish immutable source/module context before the invocation that uses it. Code loading, module initialization, and calling an entry point are separate operations. |
| Invocations are explicit | Entry or closure, receiver, arguments, realm, trigger, and dynamic invocation identity are supplied as observed context. |
| One semantic language | Extend the existing canonical witness and derive the readable view from it. Keep transport metadata and private teacher evidence out of the normal reading view. |
| Tool calls are real actions | One committed semantic request deterministically becomes one native tool action. Do not ask the model to independently describe the same call twice. |
| Results are observed | Only the harness supplies external results, arrivals, event payloads, allocated track addresses, and dispatch receipts. These are not prediction targets. |
| Events have their own identity | A tool result answers a call; a subscription event identifies a subscription; a new outside invocation identifies its trigger. Do not invent a preceding call for an unsolicited event. |
| Tracks describe continuing work | Reuse Megatoken's dynamic lifecycle and result routing. A track is not automatically a new JavaScript realm, thread, function call, or Promise. |
| Training and serving agree | The teacher and the learned executor use the same public interaction contract, effect broker, codecs, and scheduling rules. Their authority to produce semantic steps differs. |
| Correctness is observable | Check returned values, shared-state changes, ordered effects, callback order, cleanup, and completion. A correct final scalar alone is insufficient. |

**First internal integration checkpoint:** exercise one small program, two outside invocations, an asynchronous read/compute/write interaction, a readable trace, and an independently checked teacher episode through the production selected-execution interfaces using controlled test selections. Continue directly through child tracks, external handlers, recovery, Natlang integration, and all required capability families. This checkpoint neither reduces the delivery scope nor requires training.

**Reading guide:** [section 2](#2-what-a-good-trace-looks-like) shows the experience; [sections 3–5](#3-one-public-interaction-contract) define the protocol; [section 6](#6-training-the-same-interaction-the-model-will-serve) defines training; [section 7](#7-delivery-order-and-exit-gates) gives the implementation order.

## 1. Reviewed baseline

These are findings from source inspection, not new test-run receipts. Recheck the pins before implementing a cross-repository change.

| Repository / inspected commit | Implemented foundation | Gap this roadmap must close |
| --- | --- | --- |
| tracing-js-self [`e31ae33`](https://github.com/werg/tracing-js-self/commit/e31ae33d3ce4a7258d64393c7982445d40c0b297) | Public `semantic-execution/3`, `semantic-trace/3`, `semantic-context/3`; selected-state controller, renderer, private journal/replay; merged native effect/Promise/callback prototype. | Controller requires exactly `code` then `input`, creates an implicit root invocation, and accepts only `t0`. The selected effect path consumes authorized fixtures. General invocation ingress, dynamic tracks, persistent callbacks, live model dispatch, and effectful teacher admission are incomplete. |
| Megatoken [`644cf7d`](https://github.com/werg/megatoken/commit/644cf7d3c7f7f83b7e48883b1df8a6cd1189d674) | Dynamic track creation/assignment/waiting/completion, committed lifecycle tools, ready queues, result routing, and track context management. | Its semantic importer still fixes lanes to `t0`–`t7`, constructs eight tracks, expects `code`/`input` on `t0`, and permits only a narrow observation/result pattern. It does not bind this semantic execution protocol to the dynamic runtime. |
| Natlang [`38f1062`](https://github.com/werg/natlang/commit/38f10624bcddd2d7eae7ed86310da1fe8d0ebac3) | Fresh/retained evaluator seams and opt-in bounded owned wiring; stream/event interface decisions. | Real model execution needs asynchronous entry/module integration, broader live-resource semantics, and representative task tests. Synchronous `execute` and `evaluateModule` cannot generally be implemented by an asynchronous model loop without caller changes. |

### Immediate compatibility blockers

1. **Request grammar:** the tracer requires `effect`, `operation`, `arguments`, `invocation`, `site`, and `payload`. The pinned Megatoken witness parser does not allow `site` or `payload`, and its request materializer has a smaller operation catalog and scalar-only boundary. A diagnostic importer pass is not proof that these real effectful requests interoperate.
2. **Invocation and track assumptions:** change the tracer's single-lane controller and scheduler together with Megatoken's fixed-lane importer, initial prefix rules, completion policy, and observation validation. Merely adding `track_id` to a message will not integrate them.
3. **Selected callbacks:** the native prototype supports declared callback slots, primitive callback arguments, and fire-and-forget callbacks only while the originating effect is pending. The selected controller does not yet provide the corresponding callback materialization/lifecycle. Registration that survives call completion is additional work.
4. **Training:** the teacher compiler still refuses important request/observe/await/settlement paths. Wire support, interpreter demonstrations, and a green parser are distinct from admitted training data or learned execution.
5. **Tool decoding:** Megatoken's generic tool decoder accepts structured tool JSON, not a `request ...` witness line. A deterministic bridge into its committed-action boundary is required.

Source anchors: [tracer grammar][tracer-format], [controller][tracer-controller], [compiler refusals][tracer-compact], [Megatoken witness parser][mega-witness], [semantic importer][mega-importer], [native tool decoder][mega-tools], and [Natlang evaluator][natlang-evaluator].

Use [Megatoken's current implementation status][mega-status], [lifecycle source][mega-lifecycle], and [track-context contract][mega-context] for current behavior. The dynamic-tracks design plan describes a reviewed starting point; older generation documentation is not authoritative for today's track topology. Existing lifecycle code does not establish trained delegation or semantic-execution quality.

## 2. What a good trace looks like

### 2.1 Code, invocation, tool result, continuation

This is a **target readable rendering**, not literal v3 wire syntax. `host.read` and `host.write` below are proposed fixture bindings with declared Promise-returning signatures; they are not claims about today's registered API catalog. Full canonical fixtures are a deliverable of M1.

First provide the code and its capability signatures:

```js
async function increment(key) {
  const current = await host.read(key);
  const next = current + 1;
  await host.write(key, next);
  return next;
}
```

Then provide `increment("counter")` as a separate invocation with completion mode `await-returned-promise`. The outside task requests the eventual value; the JavaScript call itself still returns an owned Promise. A delayed fixture response produces this reading view:

| Order | Author / kind | Track `worker`, invocation `i1` |
| --- | --- | --- |
| 1 | Observed code | Program `counter@hash`; source above, imports, sites, capability signatures. |
| 2 | Observed invocation | Enter `increment("counter")`, receiver `undefined`, realm `r1`, outside trigger `trigger1`. |
| 3 | Generated tool call | `c1: kv.read("counter")`; bind the declared asynchronous return to owned Promise `p1`. |
| 4 | Generated suspension | Await `p1`; this continuation is waiting and the async call returns its owned result Promise `p0` to its caller. |
| 5 | Observed tool result | `c1` fulfilled with `7`; settle `p1` and make its continuation eligible. |
| 6 | Generated continuation | Resume; bind `current = 7`. |
| 7 | Generated computation | `next = current + 1 = 8`. |
| 8 | Generated tool call | `c2: kv.write("counter", 8)`; bind owned Promise `p2`. |
| 9 | Generated suspension | Await `p2`. |
| 10 | Observed tool result | `c2` fulfilled with `undefined`. |
| 11 | Generated completion | Resume; the body returns `8`, fulfilling `p0`; the outside invocation completes with `8` under its declared completion mode. |

The two tool calls have source-call spans and immutable evaluated argument snapshots. The renderer may combine adjacent display lines, but the canonical records still retain every required transition and dependency. Harness acceptance/dispatch receipts remain inspectable without crowding this default view.

A later invocation `i2` reuses the program identity and supplies new arguments. It does not resend the source as a new program or reinitialize a retained module. If source bytes have left the track's usable context, a checked source read/handoff must restore them before execution resumes.

### 2.2 Several pending operations must remain possible

```js
async function total() {
  const a = host.read("a");
  const b = host.read("b");
  return (await a) + (await b);
}
```

The trace must issue both calls before waiting for `a`. If `b` settles first, record that result and its Promise state; resume the source continuation when `a` becomes available. Awaiting already-fulfilled `b` still follows the owned Promise-reaction/microtask rules. **Issuing a Promise-returning tool call does not imply awaiting it.** Transport acceptance, guest synchronous return, eventual settlement, and owned continuation are separate facts.

### 2.3 Readability acceptance

Extend the existing [public renderer][tracer-render], which already consumes committed records without consulting a teacher future. Its default view must let a reader answer:

- Which code and invocation is executing, and what triggered it?
- Which expression produced this value, which branch was taken, and which object/cell changed?
- What external call was made with which evaluated arguments, and which result belongs to it?
- Why did execution wait, and which observation made it runnable?
- Which parent, child, callback, or event caused the next activation?
- Did the invocation return, fail, remain waiting, or finish while a retained subscription stayed alive?

Use source names/snippets alongside stable identities; indent guest calls; distinguish generated work, provided inputs, tool results, and events. Show mutations as selected-state changes, preserving aliases. Provide chronological and per-track views with links between calls/results and triggers/activations. A causally grouped display must not imply a different actual delivery order.

Keep VM stack bookkeeping, private journal IDs, byte fragments, and redundant whole-heap dumps out of the default view. Expand bounded pure computations when useful, but never compact across an external call, observation, behavior-changing branch, relevant mutation, callback boundary, or cleanup that changes completion. Preserve the current bounded-expression discipline (currently eight operators / 32 nodes) until measured evidence supports a change.

Keep golden examples for pure computation, aliasing, a caught error/finally, one tool round trip, out-of-order results, repeated events, and parent/child execution. Review readability and semantic fidelity together; report generated tokens, observed tokens, and transport overhead separately.

## 3. One public interaction contract

### 3.1 Version and authority

Adopt one coordinated successor to the current public contracts: **target `semantic-execution/4`, `semantic-trace/4`, and `semantic-context/4`**, plus a correspondingly versioned selected-state continuation. These names reserve the proposed migration; no v4 implementation is claimed here. Invocation/event authority, dynamic track ownership, and completion semantics are breaking changes and must not be silently added to v3.

Publish one typed harness envelope alongside that witness. It carries routing, identities, lifecycle and delivery receipts; it is not another language for generating guest computations. Generate the JS/Python schema fixtures from the same declared contract, retain independent validation, and pin schema, capability catalog, producer/consumer SHAs, tokenizer identity, and fixture digests. Reject incompatible artifacts; regenerate data and recollect affected model actions. Historical readers remain offline migration/analysis tools.

Three execution modes share this contract:

| Mode | Who supplies semantic work? | Who supplies external observations? |
| --- | --- | --- |
| Teacher collection | Owned interpreter and certified projection | The fixture/live harness, with independently captured receipts. |
| Exact replay | Recorded committed operations | Recorded observations; **zero native effect execution**. |
| Model serving | Actual selected Megatoken outputs and selected-state validation | The same broker and environment adapters used during collection. |

The model cannot manufacture an observation, use a private final heap, or receive a teacher correction as an unexplained continuation. Validation may reject a selection or report inconsistency; it never replaces the model's answer with a reference answer. Keep invalid selected output auditable while preventing it from committing an unauthorized semantic transition or external action.

### 3.2 Program context and explicit invocation

Separate the reusable program from the dynamic activation:

| Object | Required information |
| --- | --- |
| Program context | Immutable program/module ID and digest, source bytes or available source reference, resolved dependency identities, entry/closure inventory, static sites, source maps, language profile, and capability signatures. |
| Realm state | Fresh or retained policy; authoritative selected-state/checkpoint identity and version; module initialization status; captured cells, owned graphs, and authorized resource references. |
| Invocation input | Invocation ID; program/closure and entry; receiver; evaluated argument graph; target realm and track binding; trigger/cause; completion mode (`call-return`, `await-returned-promise`, or declared required quiescence); requested deadline and bounds. |
| Trigger | Direct caller, subscription/event ID, selected parent action, or continuation dependency. Include a stable ingress/delivery key for duplicate detection and a task revision for stale-work rejection. |
| Authority | Runtime-established grants and ownership. A caller's or model's requested capabilities can only be narrowed by the host policy, not self-authorized by a payload. |

The model-visible sequence is **program context, invocation/state inputs, generated execution**. An invocation may carry a reference to an earlier visible program, but a hash alone is not sufficient context for executing unseen source. Persist exact code identity through checkpointing and handoff.

Loading source is inert. Module initialization, when needed, is a separate owned activation with its own trace and effects, completed before dependent entry execution. Retained calls reuse initialized state and live cells. Restoring a checkpoint must not rerun initialization and repeat its effects. A code change creates a new program revision with an explicit state migration or fresh realm; do not silently apply old captures to new code.

### 3.3 Message families and model loss

The names here describe the target contract; M1 freezes their exact canonical fields and physical encoding.

| Family | Authority and loss | Meaning |
| --- | --- | --- |
| `code` / input-state context | Harness-observed; no generation loss | Exact available program and initial/retained inputs. |
| `invoke` | Harness-observed; no generation loss | An admitted outside/child/callback activation. Internal synchronous guest calls still use generated `call`. |
| Existing semantic operations | Generated; semantic loss | Computation, choice, bind, allocation, read/write, call, completion transfer, return/throw. |
| `request` / tool call | Generated; action loss once | A typed external action with committed arguments and provenance. Its native tool envelope is a deterministic projection. |
| Acceptance / tool result / `observe` | Harness-observed; no generation loss | Dispatch disposition, synchronous return/throw, eventual Promise settlement, or declared stream part. Correlated to the initiating action. |
| `event` | Harness-observed; no generation loss | A distinct notification or external trigger with origin, payload, ordering and routing identity. |
| Scheduling and lifecycle receipts | Harness-observed; no generation loss | Actual readiness, delivery, allocated addresses, task revisions, cancellation or resource disposition. |
| Owned job / await / resume work | Generated; semantic loss | The executor's legal reaction to an eligible observation. The scheduler constrains eligibility and ordering. |
| Selected lifecycle tool action | Generated when model-selected; action loss once | Create/assign/wait/complete/cancel work through Megatoken's existing lifecycle contract. Host-triggered lifecycle changes are observed instead. |

An external arrival, delivery, and callback activation are not the same event. Record arrival privately when it happens; expose only the declared delivery at a legal boundary. Observed fields may describe a callback's arguments and eligible activation, but the callback body and its semantic transitions remain generated execution.

### 3.4 Identity and causal links

Keep **session, task/revision, JS agent, realm, track, invocation, semantic record, action/effect, guest Promise, callback, subscription, event, delivery, and transport attempt** distinct. A runtime may store a checked one-to-one alias between an effect and native action; it must not derive unrelated identities from a string prefix.

At the harness boundary retain: schema/version; owning identities; per-owner sequence; cause/dependency references; source callsite where applicable; action and attempt keys; immutable payload digest; public availability/delivery point; and capability/resource ownership. Global receipt order is useful for replay but does not grant visibility across tracks. The scheduling profile determines which eligible event is delivered next.

Carry these links across physical fragments, meridians, track retirement/resumption, checkpoint restore, and Natlang retained calls. Source offsets alone do not distinguish repeated dynamic calls. A late result must retain its original owner even after labels change or a new task begins.

### 3.5 The committed-action bridge

For a source-grounded external call:

1. The model selects a complete canonical `request` using evaluated values from committed selected state, with active invocation and exact source-call provenance.
2. The semantic controller validates the complete record, argument/handle/callback materialization, capability, source relationship, ownership, and budgets. Incomplete fragments, rejected records, and discarded speculative selections dispatch nothing.
3. A deterministic adapter maps that single selection into Megatoken's committed tool-action boundary. Extend that boundary to accept a validated derived action bound to the original committed group/event and immutable witness bytes. Today's `dispatch_tools` parses tool JSON before calling its selected-payload adapter; do not rewrite a selected group or fabricate tape bytes to bypass that parser. Reuse its authority, dispatch, and result-routing machinery without a second generated argument list.
4. Persist the dispatch intent and stable action key, then invoke the registered adapter. Generate external JS only from the validated descriptor and arguments, with an equivalent direct adapter for CSP-restricted environments.
5. The broker correlates native returns, throws, acceptance, settlements and callbacks. Deliver an observed result on the requesting work track, preserving the action identity and chunk/terminal status.
6. The selected executor performs the corresponding owned return, Promise reaction, callback body, or continuation. Native trampolines never execute guest source.

Lifecycle actions from a coordinator have explicit orchestration provenance and policy; they need not invent a JavaScript source span. A guest program requesting lifecycle work must still have a supported, source-grounded capability call. Ordinary guest function calls do not gain permission to spawn tracks.

The readable trace shows the selected call once and the observed result once. The tool envelope, semantic record, and broker receipt are linked views/evidence of that interaction, not three independent model predictions.

## 4. Megatoken tracks and outside execution triggers

### 4.1 Reuse the dynamic lifecycle

Megatoken already provides `track_create`, `track_assign`, `track_output`, `track_progress`, `track_wait`, `track_continue`, `track_complete`, `track_cancel`, and `track_resume`. Its runtime allocates addresses, applies task revisions and budgets, schedules ready work, and routes tool results. Integrate those facilities instead of adding a semantic-only track scheduler.

**Add a versioned typed execution binding to that lifecycle:** immutable program, invocation inputs, fresh/retained realm policy, input/state references, granted capability subset, causal parent, and completion destination. Bind it when creating an execution track or assigning a new activation to an eligible idle track. The current `purpose`/`completion` strings are descriptive metadata; they are not an executable invocation payload. This binding is a proposed schema change, not a field already accepted by today's `track_create` or `track_assign`.

Creation plus bootstrap is one idempotent activation transaction: reserve an address, validate the binding, publish its result, provide code/state/invocation context, and mark the child ready only once the prerequisites are visible. On a failed bootstrap, record failure and release the reservation; never leave a runnable child without its invocation. A transport retry must not create a second child.

### 4.2 Tool-created child: required walkthrough

| Step | Parent work track | Child execution track |
| --- | --- | --- |
| 1 | Select a `track_create` lifecycle tool action with the proposed typed execution binding and a capability subset. | Not runnable yet. |
| 2 | Observe creation success with runtime-allocated address and invocation binding, or a creation error. | Address exists; bootstrap is pending. |
| 3 | May continue independent work or wait on the declared child-completion dependency. | Observe exact program context, current allowed state, then invocation. |
| 4 | Waiting releases active execution capacity; it does not erase parent state. | Generate semantic work; issue tools and observe their results on this child track. |
| 5 | No child result is visible prematurely. | Generate return/throw; validate required work and publish a scoped completion receipt. |
| 6 | Observe correlated child completion; continue from that result. | Complete or remain retained according to the declared lifecycle policy. |

The creation tool result acknowledges creation. The later child result completes the invocation; it is a separate correlated completion observation, not a second terminal result for the creation call. For an async entry, distinguish its immediate owned Promise return, later settlement, and the completion mode requested by the parent. A waiting parent uses a runtime-established completion dependency. If a public API chooses an explicit join call, its result represents that completion; it must not create another competing completion authority.

Specify parent cancellation, child failure, deadlines, detached work, and resource ownership. Initial policy: children belong to their parent task and cancellation propagates; detachment needs an explicit grant and a durable owner. A cancelled parent cannot silently leave an unowned child writing to the world.

Results of creation, child execution, context reads, or external effects are unavailable to the model selection that caused them. In particular, no child can use a newly allocated address or future result inside the same prediction group. Start with serial semantic groups; introduce grouped work only for records whose prerequisites are already committed and whose state accesses are independent.

### 4.3 Outside invocations and events

Implement one host ingress operation that admits an invocation/event, records its identity and ownership, then creates or wakes the appropriate work through the same lifecycle registry. It does not require a model to be already running to receive an execution trigger.

Implement the wake transition explicitly: after the matching dependency is complete and its input is delivered, admit active capacity, continue the waiting track, and queue its legal next output request. Current waiting status does not become active merely because a prerequisite completes, and creation/assignment alone does not start guest execution. Use runtime-issued typed dependency references; callers must not guess completion-key strings. Closed/cancelled work needs an explicit lifecycle decision rather than automatic resurrection.

| Incoming item | Required route |
| --- | --- |
| Direct call / job submission | Validate program and entry; allocate or reuse an eligible execution track; deliver code before invocation; publish completion to the caller. |
| Result for pending tool call | Route to its existing requesting track and invocation/Promise dependency. Usually resume that work; do not create a new track merely because a result arrived. |
| Subscription notification | Validate subscription lifetime and event identity; enqueue the bound owned callback. Use the existing execution track or the explicitly configured handler-track policy. |
| Independent external event | Resolve a registered handler/program and an authorized fresh/retained invocation policy. Create an observed invocation without fabricating a model request. |
| Retained stream item | Queue under the stream's ordering/cursor policy; invoke the next handler when eligible. Empty, closed, failed, and cancelled are distinct states. |

A handler-track policy is established at registration; each event does not need another model-generated `track_create` decision unless the program actually calls for one. Host-created lifecycle receipts are observed; train the model on the handler execution and any explicit scheduling decisions it really owns.

Align the first Natlang event path with [its stream contract][natlang-interfaces]: Fold completes the current step before consuming the next item; independent Map work is bounded and retains input-order result identity. Do not add arbitrary in-episode interruption as an accidental consequence of event ingestion. Waiting is host-managed; do not train repeated polling calls when no input is available.

### 4.4 Two scheduling responsibilities

Megatoken schedules model work across tracks. The owned semantic scheduler preserves JavaScript execution order. A physical fragment, model yield, new meridian, or ready neighboring track is not automatically a legal guest callback boundary.

Initial policy: **one active guest turn per JS agent/shared state domain**, including realms that can access the same mutable state. Independent realms with no shared state can progress concurrently. Within a retained realm, all tracks refer to one authoritative selected heap and captured-cell set; they do not clone closures by copying their current values.

Release the active turn only at a legal empty-stack/job boundary, while retaining pending continuations. Suspending an inner async frame does not release a still-running caller's turn. Do not hold an invocation-wide lock across an await that would prevent its child/callback from making progress. Promise jobs and callbacks run at the declared legal checkpoints. This follows the [ECMAScript job constraints][ecma-jobs]; browser adapters additionally follow the [HTML task/microtask model][html-events]. Node-specific task sources require their own declared and tested profile.

Synchronous reentrant native callbacks are a separate supported profile. If the API requires immediate callback execution, return values, event propagation control, or `preventDefault` during native dispatch, asynchronous later delivery is not equivalent. Either implement and prove the required handshake/timing semantics or explicitly refuse that API. An asynchronous event notification adapter must describe its narrower semantics honestly.

### 4.5 Context and continuation

Megatoken's [local/foreign context windows][mega-context] mean shared session membership does not guarantee source availability. Each new or resumed execution must have a checked available code prefix, explicit handoff/reread, or supported retained source reference before generation. Retrieval is a new observed event with original provenance; it cannot inject future state.

At complete semantic boundaries, checkpoint source identities, selected frames, heap/cell topology, module state, pending Promises/reactions/jobs, subscriptions, event cursors, action ledger, realm/track ownership, and model continuation references. Preserve exact selected state; do not reconstruct it from the teacher's completed execution. Resource handles require explicit reattachment/reconciliation rules. A non-restorable native handle causes a declared failure, not fabricated resource continuity.

Semantic-state restoration and model-cache/recurrence restoration are separate obligations. Test both with production tokenizer/history limits. If exact model-state restoration is unavailable, declare a new observed checkpoint bootstrap and its supported equivalence; do not claim bit-identical inference replay. Unrepresentable state refuses instead of silently truncating required context.

## 5. External effects, callbacks, and reliable delivery

### 5.1 Preserve each operation's JavaScript behavior

| Operation class | What happens at the call boundary | What happens later |
| --- | --- | --- |
| Synchronous external call | Current call waits for observed return/throw; no guest continuation uses a missing value. | Continue or throw in the same activation. |
| Promise-returning call | Bind an owned Promise identity according to the declared adapter contract; independent guest work can continue. | One observed settlement updates that Promise and enqueues eligible reactions. |
| Listener registration | Complete registration and return its declared token/handle; capture a registered owned callback identity. | Independently identified events can arrive after registration completes, until revocation. |
| Stream operation | Establish a handle or declared stream result. | Ordered parts plus explicit close/error/cancel, with bounded buffering and backpressure. |
| Lifecycle creation | Return an allocated track/binding receipt. | Separate child-invocation completion or failure. |

Do not confuse transport acceptance with fulfillment. Before application-level acceptance, a rejection must map to the declared sync/async error behavior. Once accepted, apply the declared settlement and delivery rules exactly. Guest Promise identities are owned semantic state; native Promises are transport vehicles.

### 5.2 One broker and capability registry

Use one registered operation descriptor for teacher collection, selected inference, native JS emission, and archive inspection. Each descriptor declares version, argument/result codecs, sync/async class, callback slots and return rules, authority, resource scope, replay policy, cancellation, lifetime, and limits.

Materialize arguments from current committed state. Preserve canonical scalar tags, aliases, holes, receiver identity, captures, and declared graph references. Use opaque capability handles for DOM nodes, sockets, files, subscriptions, and other native resources. Handle ownership, origin, aliasing, expiry, release, and checkpoint policy are explicit. Serialization must not invoke getters, proxies, `toJSON`, or coercions as a hidden effect.

The broker may emit executable external JS from the validated descriptor, as the existing prototype does. The model supplies typed actions, not arbitrary unrestricted code for evaluation. Direct adapters and emitted code must have matching payload/behavior fixtures. Archive effect re-execution is explicitly distinct from replay and may repeat real effects.

Authorization uses the embedding's existing grants and approval policy. Keep credentials in the harness, exclude secrets from public/training observations, and treat external text as data. Model output cannot expand permissions. Teacher/reference execution uses appropriate isolated processes or browser fixtures for the task; Node `vm` alone is not a security boundary for hostile programs.

### 5.3 Independent lifecycle state machines

Do not flatten dispatch, streaming, callback lifetime, and model readiness into one status field.

| Object | Required lifecycle distinctions |
| --- | --- |
| Action | Proposed; validated/rejected; intent persisted; dispatched; accepted/pending; terminal outcome or uncertain external outcome. Attempts retain one logical action key. |
| Delivery | Arrived; validated; buffered; eligible; delivered/acknowledged; duplicate or quarantined. |
| Invocation | Admitted; runnable; running; suspended; returned/thrown; cancelled/failed. |
| Track | Created; bootstrapping; active/waiting; completed/cancelled; explicitly resumed/reassigned under a new revision. |
| Subscription | Registered; active/paused; closing; revoked/closed. Events have independent IDs and delivery dispositions. |
| Resource | Owned; released/closed; lost or awaiting reconciliation. |

A return finishes one invocation. It does not automatically close a retained realm, all child tracks, or a live event source. Define completion policies for root return, required quiescence, stream closure, and explicitly retained resources. Pending required work blocks terminal success; permitted retained resources keep a named owner.

### 5.4 Callbacks and scheduling

Register the actual owned closure and its lexical cells, realm, receiver/`this` behavior, callback slot, and lifetime. A native trampoline submits typed arguments to that registry. The selected executor performs the body, mutations, nested calls, return/throw, and subsequent effects.

Persistent subscriptions outlive the registration call. Test two or more later events, callback-caused effects, unsubscribe, already queued events, after-close arrivals, and callback throws. Event order follows the declared source/host profile; receipt sequence is not a universal event-loop ordering rule. Apply owned Promise adoption, settled-Promise reactions, await, `queueMicrotask`, catch/finally and completion transfer for every claimed supported case.

Declare queue bounds, backpressure and fair service policy. Overflow, refusal, or any source-permitted coalescing/drop must have a recorded disposition; semantic events never disappear silently. A source that cannot be paused needs an explicit overflow outcome.

### 5.5 Failure, retries, and replay

- Malformed/unauthorized actions and stale/cross-realm handles fail before dispatch. Unknown/duplicated/revoked deliveries cannot resurrect an invocation.
- Preserve the provenance of adapter sync throws, Promise rejections, guest callback throws, transport failures, and unsupported semantics. They are not all normal string results.
- Persist intent before dispatch and retain an idempotency/reconciliation key. Suppress repeated local execution of the same selected action. **Do not claim globally exactly-once side effects without support from the external service.**
- Crash or timeout after possible dispatch can leave an uncertain outcome. Do not automatically retry a non-idempotent write or report that cancellation undid it. Reconcile or expose the unresolved disposition.
- Cancellation stops/aborts what the adapter can actually stop, propagates to children/resources, and records receipts. Late completion remains attributable even if its recipient is cancelled.
- Replay injects recorded results, event order, and lifecycle receipts with native adapters disabled. Deliberate new execution uses new attempts under explicit policy.

## 6. Training the same interaction the model will serve

Implement all infrastructure and test fixtures specified in this section during M0–M8. The curriculum and learning experiments describe subsequent use of the completed system; execute training only after the full cross-repository engineering completion gate passes.

### 6.1 Episode layout and teacher pipeline

An episode is a causal graph of tracks and observations, with a recorded legal delivery order. Its linearized training form contains:

1. Observed code/module context and required state.
2. Observed invocation or trigger.
3. Generated semantic work and selected tool/lifecycle actions.
4. Observed results/events when available to their recipient.
5. Generated continuation, child/handler work, and scoped completion.

Repeated invocations, descendants, subscriptions, and resumed fragments retain their relationships. They must not be packed as unrelated examples that lose pending effects or pretend later values were opening inputs.

The owned teacher executes supported source against the same broker protocol, records its authoritative private journal, and projects a canonical public episode. Extend the effectful/async compiler and source certificates before admitting these examples. Capture all effective external calls, evaluated arguments, callback/Promise work, relevant mutations, and cleanup; compact only certified pure work.

Check that episode independently with controlled Node/browser reference execution, then replay its public selected-state transitions and import the exact bytes through Megatoken's production consumer. A shared execution path is not an independent oracle. Preserve separate checks for journal integrity, exact replay, source/witness consistency, observable correctness, and consumer acceptance.

The private audit sidecar and dataset manifest retain source provenance, license/trust tier, capability profile, source/fixture digests, dispatch evidence, reference results, certificates, lineage, and admission status. They never become prediction context. Unsupported, over-budget, failed, projection-refused, locally verified, and fully admitted candidates remain separately counted.

### 6.2 Loss and causal visibility

Train on semantic transitions and tool/lifecycle decisions that the model owns at serving time, using teacher-generated labels during collection. Host-created lifecycle changes remain observed. Mask source, invocation arguments, externally supplied state, tool results, events, runtime allocation receipts, and harness scheduling receipts from generation loss. Selecting an already observed track address or handle as a later action argument is a learned reference choice and retains its appropriate action/binding loss. Preserve action ownership through physical splitting and native recurrence; do not score a projected tool envelope a second time.

Masking loss alone does not prevent leakage. The attention/dependency graph must also keep later results invisible to earlier selections, including peers in a prediction group and neighboring tracks. A semantic action cannot depend on its own future acceptance/result. A chunked tool result is usable only according to its declared incremental or complete-value contract.

Keep logical semantics separate from physical fragments and meridians. Fragmentation must neither dispatch a partial request nor introduce a guest scheduling boundary. Use real tokenizer counts and production model-history limits. A byte-codec smoke test is diagnostic, not a token-budget or learning-quality result.

### 6.3 Curriculum and held-out evidence

| Stage | Required examples |
| --- | --- |
| Code and invocation | Pure execution; same code with varied inputs; repeated fresh calls; retained captures and initialization once. |
| Tool feedback | One read/compute/write round trip; changed tool answer changes later branch/result; sync throw and async rejection. |
| Async execution | Two outstanding requests, reversed settlements, nested awaits, caught rejection/finally, callback-induced tool call. |
| Tracks | Selected create/bind; child code before invocation; child return/throw; parent join/resume; bounded active work across more than eight lifetime tracks. |
| External triggers | Direct outside invocation, multiple events after registration completes, ordered retained handlers, unsubscribe and late-event disposition. |
| Long sessions | Source eviction and checked reread; checkpoint with pending effect/subscription; timeout, cancellation, uncertain-outcome recovery. |

Build counterfactual pairs with identical visible prefixes and different later tool outcomes or event schedules. The prefix must remain unchanged before delivery; the correct continuation should change afterward. A different selected request must receive its own validated response or a request-mismatch error, never the teacher's answer for another request.

Split by source/task/fixture ancestry before expansion. Keep every child, continuation, retry, input variant, schedule variant, and counterfactual world from the same family in one split. Hold out source families and task compositions, not just random records. Follow Natlang's [source-first, causally decisive data requirements][natlang-data].

Complete the data, training, serving, and evaluation implementations during M0–M8 using deterministic teacher/reference fixtures, controlled selected-output fixtures, tokenizer/visibility/loss checks, and non-optimizing integration tests. Training, fine-tuning, optimizer-driven smoke runs, and learned-success thresholds are not prerequisites for continuing implementation. Controlled trajectories test engineering behavior and must be labeled as such; they do not demonstrate learned execution.

After M8 passes, run the learning experiments in M9. Preserve seeds **17, 29, 43**, the frozen common-support cohort, and the historical baseline in [SEMANTIC_V3_MODEL_EXPERIMENTS.md](SEMANTIC_V3_MODEL_EXPERIMENTS.md). Add a separately reported effectful/track/event cohort. Compare readable explicit and bounded compact traces with outcome-only controls under fixed-example, fixed-token, and measured compute budgets. Teacher-forced loss and actual free-running task success are different measurements. Implement the experiment configurations, evaluators, and reporting before this training stage.

## 7. Delivery order and exit gates

**Execute M0–M8 as one comprehensive implementation effort across all three repositories, then begin M9 training.** Start with a narrow interaction to verify the architecture and continue through all remaining implementation scope. Each engineering checkpoint needs pinned code, fixtures, scope/refusal counts, and receipts. Checkpoints organize the work; they do not create phase-by-phase handoffs or training dependencies. Engineering acceptance and empirical learned quality have separate gates.

| Milestone | Deliverable and main owners | Exit gate |
| --- | --- | --- |
| **M0 — baseline and examples** | Tracer + Megatoken + Natlang: freeze inspected pins, full implementation scope, supported profile, readable transcripts, and operation inventory. | Identify current schema/lane/callback limitations and async Natlang seams; record exact first examples and expected state/effects without narrowing the remaining required scope. |
| **M1 — paired protocol** | Tracer + Megatoken: versioned code/invoke/result/event/lifecycle binding; dynamic identities; single selected-action bridge; JS/Python schemas and renderer. | Both validators agree on positive/negative fixtures; old artifacts reject; code-before-invocation and no-future-visibility checks pass. |
| **M2 — one complete tool episode** | Tracer + harness + Megatoken: one fixture-backed async read/compute/write, teacher projection/admission, selected live adapter, production consumer and inference plumbing. | Two outside invocations execute through the production interfaces using controlled selections; exact arguments and one logical dispatch per action; recorded replay calls no adapters. Verify actual inference-adapter boundaries without optimizing weights or requiring successful learned execution. |
| **M3 — tool-created execution track** | Megatoken + tracer: typed create/assign binding, source handoff, child execution, parent completion dependency. | Selected lifecycle call creates one child; code precedes invocation; child result/throw reaches parent; duplicate create, failed bootstrap, cancellation, capacity and more-than-eight-lifetime-track tests pass. |
| **M4 — events and async ownership** | Tracer + harness + Megatoken: persistent subscriptions, outside triggers, owned jobs/Promises, retained state, event routing. | Register once, handle two later events, mutate a captured cell, call a tool, unsubscribe; two effects settle in reverse order; legal checkpoints and shared-state exclusion are preserved. |
| **M5 — continuity and recovery** | Harness + Megatoken + tracer: bounded queues, source reread, selected-state/model continuation, dispatch reconciliation. | Restore pending tool, child, and subscription without duplicate effects; handle evicted code, late/duplicate results, lost resource, cancellation, and uncertain writes. |
| **M6 — real Natlang path** | Natlang + tracer + Megatoken: async entry/module caller migration; fresh/retained execution; actual compiler output and live-resource contracts. | Representative tasks compare result, ordered effects, events/logs, module/cache/capture state, and failure classes through the production selected-execution route with controlled action fixtures. No training requirement. |
| **M7 — complete capabilities and data infrastructure** | All three: all in-scope HTTP/DOM/Node/resource adapters, corpus preparation/admission, representative admitted data, and reproducible production data recipes. | Every required supported family has functioning code and passes independent native fixtures, codec/lifetime tests, admission and whole-family split checks. Out-of-profile refusals remain explicit; missing in-scope adapters do not pass. |
| **M8 — implementation completion and consolidation** | All three: complete training/inference/evaluation infrastructure and configurations, checkpoint/restart, cross-repo CI, migration, recovery documentation, and removal of superseded paths. | The engineering completion gate below passes at pinned compatible revisions across all target repos. No required code remains deferred, and no training run or learned-quality threshold is needed to establish engineering completion. |
| **M9 — post-implementation training and learned acceptance** | All three: run the completed training recipes, held-out model evaluations and equal-budget comparisons; assess deployment quality. | Only starts after M0–M8 are complete. Reproducible trained checkpoints and actual selected rollouts meet declared task/effect/trace targets; empirical costs and failures are reported separately from engineering completion. |

M1 blocks new-format admission. M2 connects the teacher and production selected-execution interfaces early, and the implementer then continues through the full scope. M3 and M4 may develop in parallel after the shared contract is stable. M5 is required before durable/long-running claims. Begin Natlang async-interface design in M0 and complete it in M6. Adapter prototypes may proceed earlier, but all required implementations must pass M7. **M0–M8 are mandatory work in the same effort; no intermediate milestone may demand training resources, a newly trained checkpoint, or successful learning as a condition for finishing subsequent code.**

### Engineering completion gate — required before any training

All of the following must be complete before M9:

- All required protocol, renderer, controller, broker, lifecycle, invocation/event, callback/Promise, retained-state, and recovery paths are implemented across the target repositories, including their real production entry points.
- Required HTTP, DOM/browser, Node, and Natlang resource adapters and actual fresh/retained Natlang integration are implemented and verified within the declared scope. No in-scope feature is replaced by a stub or silently reclassified as future work.
- Teacher projection, independent reference checks, corpus generation/admission, native import, tokenizer/fragmentation, loss/visibility handling, training configuration, checkpoint/restart, inference recurrence, evaluation, and reporting tools are implemented and exercised with non-optimizing checks.
- Cross-repository contract fixtures, real Node/browser adapter fixtures, deterministic end-to-end execution, negative cases, cancellation/recovery, and all relevant engineering regression checks pass at pinned compatible revisions. Required test and evaluation code is already present; it is not postponed until after training.
- Consumer migrations, version/lockfile updates, obsolete-path removal, CI wiring, reproducible commands, implementation ledgers, and operational/recovery documentation are complete across all three repositories.

Use controlled selected-action drivers through the same parsing, commitment, dispatch, observation, and continuation interfaces used by serving. Exercise the real inference adapter separately with initialized or existing fixed weights where needed; this validates plumbing and failure handling without demanding learned task success. Do not optimize weights during these checks. Mark test-injected actions honestly and keep them out of learned-success reports. Passing this gate establishes **implementation complete and ready to train**; M9 establishes learned behavior.

### Minimal executable acceptance suite

| Fixture | Required assertion |
| --- | --- |
| Code once, invoke twice | Correct different inputs; intentional fresh/retained state; no repeated initialization effects. |
| Tool round trip | Generated call, observed result, correct continuation and ordered external writes. |
| Incomplete/invalid selection | No dispatch before complete validated commit; rejected output remains auditable. |
| Two pending calls | A and B both dispatch before settlement; B-before-A does not reorder source semantics. |
| Outside trigger | An admitted event/call starts or wakes execution without a fictitious request. |
| Persistent listener | Events after registration completion run the correct closure; unsubscribe/late-event behavior is explicit. |
| Child track | Creation receipt differs from child completion; parent resumes with correct result/error; no duplicate child. |
| Same realm, several tracks | Captures and aliases remain shared under one legal commit order; no concurrent guest-turn mutation. |
| Visibility and context | No same-group future read; source eviction forces checked reread; future fixture perturbation leaves earlier prefix unchanged. |
| Restore and retry | No repeated live initialization/effect; duplicate delivery is harmless; uncertain write remains unresolved until reconciled. |
| End-to-end engineering | Teacher admission, native import, production commitment/dispatch, observed feedback, and correct effects/outcome pass with controlled selections; actual inference-adapter plumbing is verified without training. |

Actual free-running learned execution is evaluated in M9, after this implementation suite and the full engineering completion gate pass.

Also retain adversarial fixtures for special scalars, sparse arrays, aliases/cycles, receiver/callsite forgery, stale argument snapshots, callback/handle ownership, malformed payloads, quotas, Promise adoption, cleanup overriding completion, cross-origin resources, and stream overflow. Add each supported API's specific failure and lifecycle cases rather than claiming generic coverage from a single demo.

## 8. Natlang and external capability expansion

### 8.1 Resolve asynchronous execution at the real seams

Natlang currently exposes synchronous `execute` and `evaluateModule` alongside asynchronous `executeAsync`; [module loading][natlang-modules] uses the synchronous module seam. Specify and implement an asynchronous entry/module contract and migrate callers that select the model executor. Until then, those synchronous paths are explicitly unsupported for model execution. `executeAsync` alone does not solve retained module initialization; running guest code in V8 to fill the gap would invalidate the selected-model claim.

Install the selected executor at both the per-task fresh factory and retained callable-module realm, with compatible scope, path/source maps, events/logs, limits, fork/close, and the actual shared `EvalFailure` class. Test real Natlang-generated ES/TS, imports/exports, callable-folder functions, module caching, shared live capture cells, nested model calls, and supported native services.

Changing the module realm already closes the old realm and invalidates the shared instance cache, but active task-local caches and handed-out references are not magically migrated. Make cutover explicit and test it. Preserve early opt-in and label any ordinary native/hybrid route accurately; its outputs cannot silently substitute for a selected semantic continuation or enter owned training data.

### 8.2 Grow the registered capability surface

Every in-scope capability family below is part of the comprehensive implementation required before M8 completes. The waves specify internal development order, not optional follow-up projects or opportunities to pause for training.

| Wave | Scope | Required evidence before claiming support |
| --- | --- | --- |
| First complete slice | Deterministic key/value fixture, clock/console where needed, one async service. | Evaluated arguments, result/error semantics, independent effects/outcome, replay with no services. |
| Callback/event slice | One owned callback and a persistent fixture event source. | Correct captures, repeated events, scheduling, registration/teardown, late-event rejection. |
| HTTP | Request/response/status/error/abort; later streaming bodies. | URL/origin authority, response identity, consumption/backpressure and no hidden refetch. |
| DOM/browser | Explicit selection and mutation handles, declared event/timer profiles. | Real browser changes, event identity/order, supported propagation behavior, CSP-compatible dispatch, navigation/close cleanup. |
| Node | Scoped filesystem, streams/sockets, explicit package/service operations. | Resource/path authority, precise errors, identity, backpressure and durable close. |
| Natlang resources | Callable modules, live cells, linked services and retained sessions. | Real task fidelity across imports, caching, state ownership, fork/close, and model/native boundaries. |

Inventory actual operations exercised by representative Natlang tasks. Mark every operation supported, refused, or planned. Do not use an untyped generic proxy to hide missing semantics. Support for a DOM mutation does not imply all DOM event semantics; one primitive callback does not imply synchronous/reentrant callback compatibility.

## 9. Evidence, metrics, and completion

### 9.1 Keep independent authorities; consolidate duplicate paths

Maintain one canonical public witness, one selected semantic controller per authoritative state domain, one broker/operation registry, one callback/event ABI, and Megatoken's existing lifecycle machinery. Consolidate archive/live emitters and primitive/callback materialization only after parity fixtures pass. Remove obsolete production writers/importers after all consumers move to the pinned successor; keep historical tooling explicitly offline.

Preserve separate private journal reconstruction, exact replay, source-independent Node/browser reference checks, public witness validation, and selected-model outcome evaluation. These checks provide different evidence and must not become one shared oracle.

Every integration PR records: supported profile; schema/pin changes; public versus private fields; one readable and canonical transcript; selected/teacher/native fixture receipts; counterexamples/refusals; tokenizer and lineage fingerprints; and migration/recovery behavior. Implementation ledgers record exact compatible commits across repositories, not simply that one PR merged.

### 9.2 Report what matters

| Area | Measures |
| --- | --- |
| Execution | Whole-task success, returned/raised completion, reachable state, ordered effects, callback order, and cleanup. |
| Trace quality | First semantic inconsistency, source/callsite fidelity, reader-visible causality, generated tokens per correct task, observation and transport cost. |
| Tools and triggers | Argument accuracy, dispatch count, result correlation, event/invocation routing, child creation/completion, duplicates and uncertain outcomes. |
| Learning | Free-running selected-model success, teacher-forced loss separately, held-out family results, no teacher repair, equal-budget controls and seeds. |
| Coverage | Attempted/supported/refused/admitted counts by source family, effect class, event type, track pattern and resource limit. |
| Operations | Latency, queue depth, fairness, active/waiting tracks, leaked resources, checkpoint recoverability, and measured memory/compute per correct task. |

Zero future-observation leakage, unauthorized/hidden native effects, untracked native fallback, false admission, and native effects during exact replay are hard gates. The performance threshold for a capability/task cohort must be declared before the held-out run; do not convert a successful toy demo into a production claim.

### Engineering completion checklist — before training

Evaluate these implementation checks with the production interfaces, controlled selected trajectories, independent reference fixtures, and non-optimizing inference-boundary tests described in section 7. They do not depend on a trained model achieving task success.

- [ ] A reader can follow code, invocation, semantic work, tool calls/results, events, and parent/child relationships in one deterministic trace view.
- [ ] Code and initialization are separate from repeated invocations; retained state and source availability are explicit.
- [ ] Tracer and Megatoken share one versioned contract with dynamic track bindings and independently checked fixtures.
- [ ] The production selected-request interface reaches the real broker; results enter as observed input and resume owned execution without teacher repair.
- [ ] Selected lifecycle tools create execution tracks with code before invocation and correctly correlated child completion.
- [ ] Outside invocations and subscription events start/wake the right execution without fabricated tool-call history.
- [ ] Sync calls, Promise-returning calls, persistent listeners and streams preserve their declared semantics and scheduling.
- [ ] Shared realms, callbacks, checkpoints, retries, cancellation and resource lifetime preserve identity and causality.
- [ ] Effectful teacher episodes pass independent reference, replay, witness, native-consumer, loss-mask and visibility gates.
- [ ] Natlang's async entry/module integration and fresh/retained application behavior pass on the selected-model path.
- [ ] All required training-data, loss/visibility, training-configuration, checkpoint/restart, inference, evaluation, and reporting implementations are complete and tested without a training prerequisite.
- [ ] Every required capability family and cross-repository implementation milestone M0–M8 is complete, with no in-scope code deferred until after training.
- [ ] Superseded active routes are removed; pinned integration, migration and recovery receipts are documented.

### Post-implementation empirical acceptance — M9

- [ ] Training starts only after the full engineering completion gate passes across all three repositories.
- [ ] Trained Megatoken runs held-out tasks through the completed interaction protocol; outcomes, side effects, trace correctness, costs, baselines, seeds and failure categories are reported.
- [ ] Learned-quality thresholds and deployment acceptance are assessed from real free-running selected-model trajectories, separately from deterministic implementation tests.

Report engineering completion and empirical learned quality separately. Before M8 passes, continue implementation through the remaining required work. Once it passes, the complete cross-repository implementation is ready for training; learned-capability claims await M9 evidence.

## 10. References and maintenance

Local detailed plans and ledgers:

- [Effective public witness contract](EFFECTIVE_TRACE.md)
- [Implemented and refused training paths](TRAINING_IMPLEMENTATION.md)
- [Semantic trace redesign](SEMANTIC_TRACE_REDESIGN_PLAN.md)
- [Model experiment requirements](SEMANTIC_V3_MODEL_EXPERIMENTS.md)
- [Native effect/callback prototype](NATIVE_HOST.md)
- [Redundancy and provenance audit](REDUNDANCY_AND_EFFECT_PROVENANCE_AUDIT.md)
- [Natlang integration details](NATLANG_INTEGRATION.md)

Pinned sources for the reviewed baseline follow. New deliveries update the implementation ledger and compatible commit pins; they do not retroactively turn proposed contracts in this roadmap into implemented features.

[tracer-format]: https://github.com/werg/tracing-js-self/blob/e31ae33d3ce4a7258d64393c7982445d40c0b297/src/training/format.js
[tracer-controller]: https://github.com/werg/tracing-js-self/blob/e31ae33d3ce4a7258d64393c7982445d40c0b297/src/training/controller.js
[tracer-compact]: https://github.com/werg/tracing-js-self/blob/e31ae33d3ce4a7258d64393c7982445d40c0b297/src/training/compact.js
[tracer-render]: https://github.com/werg/tracing-js-self/blob/e31ae33d3ce4a7258d64393c7982445d40c0b297/src/training/render.js
[mega-status]: https://github.com/werg/megatoken/blob/644cf7d3c7f7f83b7e48883b1df8a6cd1189d674/docs/multi-track-implementation.md
[mega-lifecycle]: https://github.com/werg/megatoken/blob/644cf7d3c7f7f83b7e48883b1df8a6cd1189d674/src/megatoken/lifecycle.py
[mega-context]: https://github.com/werg/megatoken/blob/644cf7d3c7f7f83b7e48883b1df8a6cd1189d674/docs/track-context.md
[mega-witness]: https://github.com/werg/megatoken/blob/644cf7d3c7f7f83b7e48883b1df8a6cd1189d674/src/megatoken/data/witness_v3.py
[mega-importer]: https://github.com/werg/megatoken/blob/644cf7d3c7f7f83b7e48883b1df8a6cd1189d674/src/megatoken/data/semantic_execution.py
[mega-tools]: https://github.com/werg/megatoken/blob/644cf7d3c7f7f83b7e48883b1df8a6cd1189d674/src/megatoken/tool_schema.py
[natlang-evaluator]: https://github.com/werg/natlang/blob/38f10624bcddd2d7eae7ed86310da1fe8d0ebac3/ts-host/src/native/evaluator.ts
[natlang-modules]: https://github.com/werg/natlang/blob/38f10624bcddd2d7eae7ed86310da1fe8d0ebac3/ts-host/src/runtime/modules.ts
[natlang-interfaces]: https://github.com/werg/natlang/blob/38f10624bcddd2d7eae7ed86310da1fe8d0ebac3/plans/EXECUTION_INTERFACES.md
[natlang-data]: https://github.com/werg/natlang/blob/38f10624bcddd2d7eae7ed86310da1fe8d0ebac3/docs/INLINE_NATLANG_TRAINING_DATA_PLAN.md
[ecma-jobs]: https://tc39.es/ecma262/multipage/executable-code-and-execution-contexts.html#sec-jobs
[html-events]: https://html.spec.whatwg.org/multipage/webappapis.html#event-loops
