# LLM semantic execution with real external tools: end-to-end delivery roadmap

**Status:** implementation plan, not a claim of completed functionality.  
**Prepared:** 2026-10-25.  
**Primary repositories:** [tracing-js-self](https://github.com/werg/tracing-js-self), [megatoken](https://github.com/werg/megatoken), [natlang](https://github.com/werg/natlang).  
**Immediate integration branch:** [tracing-js-self PR #30](https://github.com/werg/tracing-js-self/pull/30).

## 0. The intended product and non-negotiable boundary

The intended product is an **LLM that learns to simulate the semantics of executing a JavaScript/TypeScript program**, from readable, compact semantic execution demonstrations. At inference, that model must execute ordinary guest computations and control flow by committing semantic records. When the program calls into the outside world, the model must request a tool action with already-evaluated arguments. A trusted harness executes the real side effect in an authorized Node or browser environment and returns the result, Promise settlement, callback, or event as a causally observed input. The model then continues the *same* guest execution.

This is aimed at **actual Natlang tasks**, with Megatoken as the learned semantic executor. It is not a tracing viewer, an ordinary code-generation agent, or a system that secretly falls back to running the guest program in V8 during inference.

The desired loop is:

1. Natlang supplies source, resolved imports, entry arguments, persistent context, capabilities, and task identity.
2. Megatoken observes that immutable starting context and committed history.
3. Megatoken emits a bounded **generated** semantic operation: computation, branch, allocation, call, mutation, suspension, or a request for a real external effect.
4. A deterministic selected-state controller validates and commits the operation **without reading the teacher's future execution**.
5. On an effect request, the harness validates authority, code provenance, arguments, identity/lifetime and budget; it converts the *structured request* to executable external JavaScript or a native adapter call.
6. Node/browser executes the actual effect once. The harness independently records dispatch, asynchronous arrival, callback events, cancellations, and delivery with stable IDs.
7. Observations and callback activations enter the model-visible continuation at a legal service boundary; their contents have **no model-generation loss**. Guest callback bodies, Promise reactions, and await continuations remain the semantic executor's responsibility.
8. Megatoken continues until a justified terminal completion or explicit waiting, error, unsupported-feature, cancellation, or resource-limit state.
9. For training data, an owned interpreter acts as teacher and produces auditable records. For serving, **the model's selected records** advance state; an interpreter never repairs or supplies the model's hidden steps.

**Authority invariants**

- **Guest semantics:** teacher-owned interpreter when producing labels; Megatoken plus a public selected-state controller when serving. Never covertly substitute host V8 computation for a selected model step.
- **External reality:** capability-controlled harness only. The LLM cannot fabricate observed tool responses or mark a pending external operation complete.
- **Tool execution:** the model proposes a typed request; the harness constructs executable code from the validated operation contract and committed arguments. **The LLM must not supply unchecked arbitrary JavaScript for unrestricted evaluation.**
- **Provenance and transport:** one authoritative raw journal for the teacher, one public v3 semantic witness language, and one versioned tool/event protocol integrated with that language. Do not create parallel public witness formats.
- **Replay:** exact interpreter replay injects recorded external arrivals and callbacks but does **not** rerun real native effects. Deliberate re-execution of emitted external JS is explicitly distinct and may repeat side effects.
- **Causality:** no teacher future, final-state heap, unobserved input, private certificate or retrospective correct answer may enter model context before its legal availability.
- **Honest scope:** unsupported ES semantics or host APIs refuse; they are not quietly executed by an untraced compatibility route and then labelled owned or admitted.

## 1. Baseline, confirmed gaps, and dependencies

### 1.1 Current foundation in tracing-js-self

The active public training contracts are **semantic-execution/3**, **semantic-trace/3**, and **semantic-context/3**; private supervision is **semantic-supervision/2**. A selected-state controller, compiler, witness checker, fragmentation/scheduling, and private journal replay exist. See [EFFECTIVE_TRACE.md](EFFECTIVE_TRACE.md), [TRAINING_IMPLEMENTATION.md](TRAINING_IMPLEMENTATION.md), and [SEMANTIC_TRACE_REDESIGN_PLAN.md](SEMANTIC_TRACE_REDESIGN_PLAN.md).

PR #30 introduces executable external-effect JavaScript generation, more explicit source-call and argument binding, a native settlement bridge, and a bounded example of a callback returning into an owned guest closure. This is **foundational prototype scope**:

- Supported external operations are still explicitly registered, predominantly demo and console/clock operations. It is **not** a real network, DOM, filesystem, or generic Node/browser capability layer.
- Callback transport is demonstrated for a declared argument slot on a pending operation, with primitive callback arguments and fire-and-forget return behavior. It is **not** a general listener, Event object, synchronous callback return, reentrant native call, or durable subscription implementation.
- A live native-driver demonstration is **not** model-selected execution. The owned interpreter is still performing program semantics.
- The effectful semantic-witness compiler, admission gate, controller and native Megatoken model loop are **not** integrated end-to-end. Existing teacher export still refuses substantial effectful/async paths.
- The semantic record language alone does not prove that a model can use tools, resume after a callback, or obtain a correct result.

### 1.2 Verified cross-repository blocker: Megatoken schema skew

At the checked public revisions, tracing-js-self's PR branch requires a generated v3 request to carry **effect, operation, arguments, invocation, site, payload**. The paired [Megatoken witness parser](https://github.com/werg/megatoken/blob/main/src/megatoken/data/witness_v3.py) still lists only **effect, operation, arguments, invocation** as allowed request fields and does not require the new grounding fields. Its [semantic execution adapter](https://github.com/werg/megatoken/blob/main/src/megatoken/data/semantic_execution.py) independently recognizes a smaller, partly differently named operation catalog and a scalar-only materializer. It has no general callback-capability protocol.

Therefore a green diagnostic native-import workflow **does not establish that real effectful records from PR #30 can pass both validators**. This is a P0 stop-ship condition: update the paired grammar, request/callback materialization, operation catalog and complete negative/positive parity fixtures *together*. Pin exact compatible Git commits in CI. Do not add a second permissive legacy decoder or silently drop unrecognized fields.

### 1.3 Natlang is a separately incomplete integration

Natlang has fresh and retained evaluator seams, and [opt-in owned evaluator wiring](https://github.com/werg/natlang/blob/main/ts-host/OWNED_TRACING_INTEGRATION.md) already installs both. Its ordinary TypeScript/native and [hybrid route](https://github.com/werg/natlang/blob/main/ts-host/HYBRID_TRACING.md) must **not** be mistaken for an owned trace. Actual Natlang compiler output, callable-folder modules, live capture identities, imported packages, browser/Node resources, and tool-use lifetimes cover much more than the current bounded interpreter.

The current EvalEnvironment shape includes fresh/retained mode, execute/executeAsync, evaluateModule, fork/close, scope, path, timeout, live bindings, events and compatible EvalFailure. Consult [NATLANG_INTEGRATION.md](NATLANG_INTEGRATION.md) and the current [Natlang evaluator contract](https://github.com/werg/natlang/blob/main/ts-host/src/native/evaluator.ts). Both runtime seams must pass real integration tests before production claims.

### 1.4 Preserve the existing independent evidence boundaries

Keep the original interpreter's private journal, structural validator, exact replay, source-independent reference observation, public controller and model-selected evaluation as **different authorities**, even if they duplicate some checks. Deduplicate competing *representations and execution paths*, not independent correctness checks. See [REDUNDANCY_AND_EFFECT_PROVENANCE_AUDIT.md](REDUNDANCY_AND_EFFECT_PROVENANCE_AUDIT.md).

## 2. Target contract: semantic operations, tool requests, and environment events

**Design decision:** keep **semantic-trace/3** (or one explicitly migrated successor, if unavoidable) as the only model-generated semantic language. Define a **typed external-harness protocol** for request/ack/observed event delivery. That protocol is a transport/state-machine companion to the public witness, not a second witness grammar. The same validated tool request must feed Node, browser, teacher collection and selected inference.

### 2.1 Logical record and runtime identity requirements

Every externally relevant record needs these concepts:

| Field / concept | Required semantics |
| --- | --- |
| Session / task / realm / track | Exact Natlang task and fresh-or-retained execution owner; prevent cross-task callback delivery. |
| Execution / invocation / source | Stable dynamic activation ID and source span/source-map revision when available; distinguish repeated calls at one static site. |
| Effect ID and operation | Fresh per invocation; registered capability name and versioned signature, not an arbitrary global function. |
| Fully evaluated arguments | Canonical scalar tags and identity-bearing graph/handle/callback references from **committed selected state**, not source text re-evaluation. |
| Materialized call | Operation-specific typed codec, immutable payload snapshot, byte count, effective version/identity evidence and signature. |
| Dispatch ID and idempotency key | Distinct request submission, native start and completion; retries do not silently repeat non-idempotent effects. |
| Callback / subscription ID | Stable owned closure + environment/receiver/realm identity, capture lifetime, callback slot, authorization and explicit revocation. |
| Async outcome | One of fulfillment, rejection, callback, subscription event, cancellation/abort or resource failure; exact original effect linkage. |
| Scheduling | Monotonic arrival sequence, authoritative receipt ordering, service-point eligibility and owned job FIFO / microtask semantics. |
| Observation boundary | Environment-created observation may enter the model only after the harness says it is available; loss mask is observed-only. |
| Continuation | Selected-state checkpoint references pending promises, event buffers, active callback handles, live cells, and authorized resources. |

An **effect ID is not a callback ID, an invocation ID, a promise ID, or a transport delivery ID**. Explicitly type each; never infer one from a string prefix or a final heap lookup. IDs must survive fragmenting, tracking, checkpoint restore, process handoff and Natlang retained-mode calls, subject to their declared lifetimes.

### 2.2 Request and observation lifecycle

Specify and enforce a transition table, approximately:

    proposed -> validated -> authorized -> journaled -> dispatched
       -> pending -> (fulfilled | rejected | streaming | cancelled)
       -> input-arrived -> input-delivered -> owned continuation

Callback/subscription traffic is a parallel sequence of **environment event arrival -> validated callback routing -> owned job enqueue -> owned invocation -> completion**, and may repeat while registered. A service may settle before or after a callback; record actual order and apply declared JavaScript scheduling rules. A listener can outlive one Promise settlement only when the capability and retained realm explicitly permit it.

Important distinct moments:

- A model-predicted **request** is generated; its external result is never generated by the model.
- Validation and authorization must occur **before** any native execution; persist intent and dispatch identity before execution.
- The environment may report arrival while the guest is not ready to receive it. Record arrival privately, then expose a separately committed delivery.
- Callback registration does not execute a guest callback. Native JS receives a trampoline; invoking it routes an event to the harness. The selected semantic executor activates the owned closure only when scheduled.
- The host may create a native Promise as a **transport vehicle**; that Promise is not a guest activation. Its settlement becomes one checked observation that drives the guest's owned Promise state and reactions.
- A terminal guest return does not mean the session is complete when required effects, callbacks, jobs, timers, or subscriptions remain. Declare explicit quiescence, detached-resource and task-close rules.

### 2.3 Executable JavaScript must be an output of the broker, not a new model language

The LLM should predict a typed external action with evaluated arguments. The harness should deterministically generate a **JS string for the actual external invocation**, using an allowlisted descriptor. The same contract must have an equivalent safe adapter in environments where dynamic function construction is forbidden (for example browser CSP). An emitted string must not acquire authority simply because it parses as JS.

Use a single effect compiler/broker for:

- **Live execution:** generate one call from an already validated pending effect, run once, capture sync return/throw or native Promise fulfillment/rejection, and deliver the observation to the owned-model loop.
- **Archive inspection:** generate ordered external calls for display/test only, with a prominent warning that executing them again repeats effects and cannot replay guest semantics.
- **Training teacher:** use the exact same registered operation descriptor and serialization/callback ABI, but require independent teacher evidence before admission.
- **Model-selected inference:** never consult the teacher's private effect table to compile a model action; compile solely from committed selected state and the model's request.

Retire/route around any separate native-only dispatch implementation and separate primitive-only controller request materializer **after** parity is demonstrated. Never use general-purpose eval on unrestricted model-generated text or infer a request by substring searching the source.

### 2.4 Error, timeout and retry semantics

Specify, test and version:

- Missing capability, malformed arguments, graph/identity violation and unauthorized source/realm: **reject without dispatch**.
- Adapter synchronous throw, Promise rejection and guest callback throw: distinct provenance and guest-visible rules; never silently convert all to the same normal string response.
- Timeout, abort and native resource cancellation: a cancellation request is not proof a started side effect was undone. Emit a terminal policy result or an explicitly unresolved disposition.
- Process failure between journaling dispatch and observing result: durable idempotency/reconciliation or **uncertain-outcome** state; never automatically retry a non-idempotent write.
- Duplicated, late, unknown, revoked or cross-realm callback/event: refuse or quarantine with measured diagnostics, not implicit callback resurrection.
- Callback returning a value required synchronously by a browser/Node API: either provide a proven synchronous model/harness handshake with latency contract, or reject that API. Do **not** fabricate undefined if the API depends on the return value.

## 3. External capability families to implement

Do not advertise generic DOM/network/Node support through an untyped open proxy. Build an explicit, versioned capability registry with: operations; effect class (sync, async, stream, listener); argument/result codecs; callback positions and return semantics; resource authority; origin and permission policy; replay policy; cancellation and lifetime; quota; and reference fixtures.

Deliver in controlled increments:

| Wave | Families | Required proof |
| --- | --- | --- |
| A — deterministic substrate | Clock/console, key-value store, simple Promise-returning service, one-shot owned callback | One dispatch, immutable args, ordered observations, exact replay without adapters. |
| B — HTTP/network | fetch-like request, headers/body, status, errors/abort, response body/stream handles | No hidden re-fetch, URL/origin policy, body consumption and cancellation receipts. |
| C — DOM | Query/selection handle, text/attribute/style/property mutation, append/remove, input value and event handler registration | Correct native DOM side effects; stable element identity and mutation order; DOM Event codec. |
| D — browser lifecycle | add/removeEventListener, event objects, timers, animation/task turns, history/storage as granted | Listener lifetime, multiple callbacks, teardown, browser task/microtask ordering. |
| E — Node | Scoped filesystem, process-safe services, stream/network sockets, package/native-module calls as explicitly granted | Resource and path authority, stream backpressure, exact errors and durable close. |
| F — Natlang resources | Module/service objects, callable-folder exports, live capture cells, linked handles and persistent sessions | End-to-end module/cache/identity and cross-call event ownership tests. |

Where a native API exposes stateful objects or methods, use **opaque capability handles** with explicit operations and release rules. Avoid serializing DOM nodes, sockets, file handles, browser Events or function objects as ordinary JSON trees. Preserve aliasing, identity, provenance and ownership across calls.

A complete claim for the intended Natlang task scope requires an audited inventory of external operations actually exercised by representative Natlang programs. Every observed operation must be classified as supported, explicitly refused, or not yet implemented; no silent fallback.

## 4. Fully general callback and event reentry

PR #30's bounded callback slot is a proof of concept. Replace the pending-effect-only assumption with a true callback lifecycle.

**Work required**

1. Register callback capabilities at the actual guest function value and capture current invocation, receiver/this semantics, lexical cells, module realm and identity.
2. Define callback argument/result codecs independently of ordinary effect argument JSON; support primitives first, then descriptor-only graphs and typed Event/Node/resource handles. Reject getters/proxies and cross-origin/realm references unless explicitly authorized.
3. Support subscription ID, callback ID, removal token, event type, ordering index, active/paused/revoked state, one-shot vs persistent policy, and retained-session restoration.
4. Distinguish callback enqueue, activation, nested/recursive call, completion, and return/throw. Preserve the precise callback's captured closure and its real selected-state mutations.
5. Handle callbacks arriving during the current guest turn, while suspended, after cancellation, or after the enclosing effect settled. State whether they buffer, await service point, or are invalid.
6. Support events from DOM listeners, Node EventEmitter-like services, timers, streams, and promise handlers; use **one callback ABI and scheduler** rather than API-specific backdoor invocation.
7. Handle native APIs requiring synchronous return values as a separate, explicit supported subset. Generic remote asynchronous model inference cannot synchronously satisfy an arbitrary browser event callback.
8. Prove that no V8 callback trampoline directly evaluates guest function source. Callback bodies are generated/selected semantic work, not native host code executed outside the model.
9. Add unsubscribe, session close, resource cleanup and late-event quarantine tests. A callback can never be delivered to a new task merely because a string ID was reused.

**Acceptance:** A model-selected execution can register a DOM listener, receive multiple typed events from a real browser fixture, mutate its captured state through the same owned invocation semantics, initiate another external effect, unsubscribe, and terminate with correct event order. Rejections, stale events, identity aliasing and retained-session close must behave deterministically.

## 5. Promise, job, suspension and continuation semantics

Bring the owned runtime's bounded async semantics all the way through the teacher projection, witness compiler, serving controller, Megatoken recurrence and external harness. Merely recording native Promise resolution into a teacher-owned VM is insufficient.

- Model-visible operations must cover guest Promise creation, resolution/rejection, adoption/thenables, reaction registration, await suspend/resume, queueMicrotask, try/catch/finally and completion propagation where supported.
- Distinguish host task arrival, microtask/reaction readiness and the model's semantic next-step choice. External arrival cannot arbitrarily preempt guest execution.
- Preserve microtask FIFO, callback execution order, settled-promise reactions, cleanup/finally substitution, detached effects and required quiescence.
- Add explicit buffered-delivery and fair scheduling policies for independent streams/tracks, without granting an episode access to future observations.
- Make every continuation serializable from **only model-selected committed state**: live frames, captured cells, heap topology, pending handlers, promises, jobs, effect requests, callback subscriptions, event queues, source identity and capability registry snapshot.
- Checkpoint at complete semantic boundaries, never at arbitrary Megatoken physical byte fragments. Restore and compare byte/identity equivalence; if limits are exceeded refuse rather than dropping required state.
- Cancellation and timeouts must propagate to harness resources and owned continuations with explicit receipts; no phantom resolution.

**Acceptance fixture set:** two concurrent HTTP effects settle B-before-A; Promise.all and finally are correct; callback C arrives between Promise settlements; callback causes a second effect; out-of-order and duplicate arrivals are rejected/queued appropriately; rollover and crash recovery preserve pending work; replay invokes zero real services.

## 6. One Megatoken-native training and serving protocol

### 6.1 Cross-repo schema migration is the first blocking delivery

Update [megatoken witness_v3.py](https://github.com/werg/megatoken/blob/main/src/megatoken/data/witness_v3.py), [semantic_execution.py](https://github.com/werg/megatoken/blob/main/src/megatoken/data/semantic_execution.py), its tests, the tracer format/controller and the pinned CI workflow as a **single versioned contract**:

- Agree on required request fields, operation signatures, callback-capability tokens, canonical byte encoding, graph handles and legal observation fields.
- Include source span validation, call ownership, resource limits, effect ordering, no hidden result, and capability-bound delivery checks. Each language implementation must independently reject the same adversarial fixtures.
- Either amend v3 in a proven compatible migration or issue one **new canonical version** for both repositories. Do not maintain two active production writers/readers or quietly accept old malformed requests.
- Map physical record metadata to generation vs observation authority, action dependencies, ownership, effects, track, source and task lineage without exposing the private teacher sidecar.
- Pin SHA, tokenizer fingerprint, schema/catalog versions and producer/consumer fixture digests; fail CI if exact bytes or field meanings diverge.
- Verify actual effectful plus callback-bearing examples through the production tokenizer/consumer, not a scalar-only or diagnostic byte-codec smoke test.

### 6.2 Real selected Megatoken recurrence

Implement a model-facing runner with the following transaction:

1. Render the initial source/static context, input graph, capabilities and prior selected state.
2. Ask Megatoken for the next bounded logical semantic record/group using its **actual** production inference adapter, not teacher text replay.
3. Parse canonical bytes and validate record schema, current dependencies and available identities.
4. Commit atomically with the sole selected-state controller. On inconsistency record the error; **never replace the record with the teacher answer**.
5. If it is a tool request, enqueue it in the harness; do not sample the next guest step until the required observation/scheduling condition is met.
6. Integrate harness observations as observed records with correct loss mask and causal order.
7. Resume the exact Megatoken session with same track/meridian identity, model recurrence and committed context. Repeat until terminal outcome/quiescence.
8. Persist reproducible selected trajectory, exact bytes, tokenizer counts, tool and callback receipts, continuation hashes, and classification of each failure.

Keep logical semantic records distinct from physical Megatoken fragments, meridians and generation groups. A meridian cannot contain a future external observation visible to the request that caused it. Physical splitting does not create a JS scheduling boundary. Keep strict real-token, model-history, latent-state and continuation budgets. The source of truth for byte codecs and model limits is the pinned consumer, **not** a hand-written mock.

### 6.3 Training supervision

- Generated semantic computations, choices, state transitions and tool requests receive the declared model loss.
- Source, initially observed inputs, tool results, callbacks and environmental events are **observed**, not prediction targets.
- Record all mandatory receipt fields so the learner can condition on and react to actual event arrivals, including negative outcomes.
- Support continuation after multiple tool calls and intermittent host events in **one causal episode**; no teacher-completion leakage through prepacked future meridians.
- Train explicit waiting, request/observe alternation, notification handling, subscription cleanup and repeated tool-use decisions rather than only single-call static traces.
- Prevent shortcut learning from answer-bearing fixtures, final-state hashes or post-hoc proof artifacts shown as input.

## 7. Teacher generation, independent reference and corpus admission

Implement a real effectful **teacher** pipeline while retaining strict separation from inference.

### 7.1 Capture and certification

- Execute supported source in the owned interpreter and collect one complete authoritative journal, source/static inventory, effective invocations, exact evaluated arguments, every external dispatch, private arrival, legal delivery, callbacks/jobs, completion and reachable final state.
- Use the same capability registry and harness request/observation protocol as inference. Reference fixtures and recorded native responses are evidence, not input to the future model.
- Extend normalization, compaction, source-guided rewrite and private certificates to **all effective external effects and supported async control**. Do not elide a side effect, callback-triggered mutation, or cleanup simply to shorten a witness.
- Certify source-level argument computations, callback/closure identity and invocation provenance; record conservative unverified/refused categories for inaccessible or ambiguous source behavior.
- Validate against independent JS execution (Node V8 and real browser where applicable) with an **independently controlled external fixture schedule**. Owned exact replay is necessary but insufficient for independent semantic correctness.
- Produce a complete selected public replay through the v3 controller before admission. Verify observations, ordered effects, callback/event sequence, outcome, graphs and termination.
- Preserve raw journal, source hashes, tool fixture receipts and private proof objects in an access-controlled audit sidecar, never in public prediction context.

### 7.2 Deterministic fixture environments

Build capability-specific emulators for CI and training:

- Network fixture with HTTP statuses, failure/retry, streaming chunks, redirect/abort and deliberately out-of-order replies.
- Browser fixture with DOM snapshots, scripted clicks/inputs, event phases, listener subscriptions, timers and mutation assertions.
- Node fixture with isolated/scoped filesystem, clock, timers, streams and explicit environmental faults.
- Resource-handle fixture for identity, aliasing, disposal, cancellation and stale callback tests.

The independent reference must not borrow model-selected values to decide future fixtures. If a selected request differs from the authorized fixture, report **request mismatch**, not the correct answer to some other request. Use hermetic, disposable targets; do not perform uncontrolled real network or user-visible DOM writes while scoring experiments.

### 7.3 Admission and lineage

Define explicit source provenance, license, trust tier, runtime capability profile, fixture digest, producer SHA, reference SHA, proof status, split family, tokenizer SHA, public transcript hash, callback/event counts, outcome, and reason for refusal. Distinguish:

- Source parsed / executed by owned teacher.
- Exact owned replay and structural journal validity.
- Independent JS/reference effect and outcome agreement.
- Source-level witness certificate validity.
- Public selected-controller acceptance.
- Megatoken-native format and causal visibility acceptance.
- **Admitted** training example (all required gates), versus locally verified diagnostic only.

Deduplicate by source family/task/fixture ancestry **before** train-validation-test split. Keep continuations and all variants of a program or fixture in one split. Keep unsupported, failed and over-budget candidates in a reported denominator. Do not relabel old versions or invent admission receipts.

## 8. Natlang integration: actual execution paths and task fidelity

### 8.1 Bind the model-selected executor to both evaluator seams

Implement an explicit semantic-execution environment satisfying Natlang's real EvalEnvironment contract, including:

- fresh and retained realm creation, closure/capture identity, source paths and TypeScript source maps;
- execute and executeAsync, compatible result/events/logs and **the actual shared EvalFailure class**;
- module evaluation, imports, exports, package capabilities, module caching and callable-folder persistent realm;
- fork/close, abort/timeouts, live object and resource authority, cancellation and after-close late-event disposal;
- the observable Natlang scope and compiler outputs used by real tasks, not only handcrafted minimal JS examples.

Install the selected-model environment at **both** Natlang per-task factory and retained module realm. Preserve explicit opt-in in early milestones; production cutover requires running the same task suite through the model execution contract. An ordinary native TypeScript fallback may remain an explicitly labelled compatibility option for users, but its outputs are **native-untraced**, are not trained as model-owned semantic execution, and may not be silently used as a correct-looking model continuation.

### 8.2 TypeScript and module semantics

Handle actual Natlang-generated ES2022/TS, named imports, callable folder exports, persistent lexical cells, mutable bindings, async function entries, callback references, Node/browser native packages and source mapping. Share source lowering and module graph helpers rather than proliferating a static-module linker, evaluated-module linker and Natlang-specific executor with incompatible behavior. Preserve the different supported profiles until tests justify converging them; explicitly refuse unsupported grammar.

### 8.3 Natlang application result contract

Every task must return either a valid declared result with ordered effects and completion receipts, or an honest unsupported/failure/timeout/cancelled outcome. Tests must compare the task-visible result, live state mutations, emitted Natlang host events/logs, module state, persisted resources and all external effects; a correct scalar return with wrong DOM/network behavior is **incorrect**.

### 8.4 Browser-specific delivery

Implement an explicit browser adapter (worker/session transport where needed), DOM capability registry and signed/opaque handles; avoid unguarded eval/Function in CSP-constrained contexts. The emitted JS string should remain **inspectable** and executable in an authorized engine, with a policy-approved equivalent dispatch path in restricted contexts. Route browser Events and Promise settlements into the same protocol as Node. Preserve page/context origin boundaries, permissions, listener teardown, navigation/session reset and worker disconnection.

## 9. Durability, security and real-world operations

This architecture operates on real external systems and must be secure by design:

1. **Capability authorization:** explicit operation allowlist, host/origin/path/realm scoping, grant expiry, quotas and per-task permission decisions. The model may not reach arbitrary globals, packages or network destinations through a generated JS string.
2. **Value and handle codecs:** typed and depth/budget-limited. No getters/toJSON/coercion executed merely to serialize data. Real native resources remain opaque; preserve origin and lifetime.
3. **Secret isolation:** authentication stays in trusted harness state. Training/public observations are scrubbed of secrets and credentials. Do not publish raw native handles or private journal state.
4. **Idempotency and crash consistency:** durable dispatch IDs, ordered event log, atomic intent/receipt persistence and explicit unknown-outcome reconciliation. Exactly-once externally observable effects are not claimed unless the underlying service provides an idempotency guarantee.
5. **Cancellation:** abort starts and guest continuation, unsubscribe listeners and release resources; late events are quarantined. No unowned background work changes a sealed training record.
6. **Scheduling/backpressure:** bounded queues, fairness between independent tracks, streaming flow control, time budgets and controlled service points; disclose drops/overflows, do not hide them.
7. **Prompt/tool injection:** external text and DOM content are untrusted **data**, not instructions that grant new capabilities or modify the public trace grammar.
8. **Isolation:** Node vm is not a sandbox for arbitrary hostile JS. Real teacher/reference execution uses isolated workers/processes or browser contexts with restricted capabilities and disposable fixtures.
9. **Auditability:** retain immutable code/operation digests, source snapshots, versions, graph identities, authorization, dispatch and external-event receipts. Observations remain visible to the model only when delivered.
10. **Human-approved high-impact operations:** define policy/confirmation gates for destructive filesystem changes, irreversible messages/transactions, credentials and external writes; fail closed on missing approval.

## 10. Remove parallel paths by migration, not by renaming

Maintain **one canonical public witness**, **one selected controller**, **one effect broker/code emitter**, **one native callback/event ABI**, and **one training/inference interaction contract**. Work against these candidates:

| Candidate | Migration | Removal condition |
| --- | --- | --- |
| Separate archive-only external-call emitter vs live request compiler | Share registered operation descriptor, argument codec and JS generator; archive replay is an explicit inspection mode. | Same output/payload/identity tests across modes, no native dispatch bypass. |
| Primitive-only external request match vs identity-aware materializer | Use one canonical request materializer over committed selected graph; keep separate independent validator as adversarial authority. | All reference, callback and graph fixtures pass; no forbidden coercion. |
| Demo callback branch vs browser/Node callbacks | Move to shared callback registry, subscription lifecycle, scheduler and codecs; demo becomes fixture adapter. | EventEmitter/DOM/timer/stream parity and late-event refusal. |
| Public causal prefix vs training v3 projection | Migrate active consumers to one public semantic projection; keep raw prefix as offline diagnostic only until consumers are accounted for. | Proven causal/visibility parity and recorded consumer migrations. |
| Separate training exporter/controller/evaluator variants | Migrate all producers and Megatoken importer to the canonical v3/successor contract; remove format selection/fallback. | Cross-repo byte and behavior compatibility suite is green. |
| Static ESM, evaluated ESM and Natlang module linking | Consolidate shared resolution, source lowering and identity rules without erasing distinct semantics; unify where a tested superset exists. | Actual Natlang module suite plus evaluated/static conformance parity. |
| Ad hoc native service driver vs Natlang tool handling | Use one broker with Node/browser adapters and one authoritative event log. | No untraced tool-call path on the selected-model route. |
| Old archive/legacy training formats | Offline migration with pinned historical reader only; production refuses old formats. | No active producer, importer or serving dependency. |

**Intentionally keep separate:** independent host-request validation, journal structural reconstruction, exact replay, independent V8/browser reference oracle, public witness consistency checker, and final model-selected outcome comparison. Sharing execution authority between these would erase correctness evidence.

## 11. Work packages, deliverables and blocking gates

Do **not** turn this into a feature checklist where all rows are marked complete after one demo. Each milestone requires merged code, real tests, CI receipts, scope/refusal accounting and pinned cross-repository versions.

| Order | Deliverable | Primary repo(s) | Stop/go evidence |
| --- | --- | --- | --- |
| **M0** | Freeze capability/profile inventory; baseline PR #30 status; document exact API, grammar and known skips | tracer / Natlang / Megatoken | Checked current revisions, executable corpus and refusal matrix. |
| **M1 — P0** | Resolve request/event/callback schema skew and migrate both validators, operation catalogs and physical import | tracer + Megatoken | Shared positive/negative effectful fixtures accepted/rejected identically; pinned compatible SHAs. |
| **M2 — P0** | One typed selected tool-call broker, authorization, generated JS emitter, real result/event ingestion | tracer + harness | Model-selected request invokes exactly one authorized native effect; no interpreter fallback. |
| **M3 — P0** | Persistent callback and event lifecycle, identity, cancellation, event codecs and async scheduling | tracer + Node/browser | Multi-event listener and out-of-order Promise fixtures; after-close and duplicate rejection. |
| **M4** | Network, DOM, timers, Node and Natlang resource capability adapters | harness + Natlang | Real external fixtures, bounded all-family parity, side effect/accounting audit. |
| **M5 — P0 for training** | Effectful/async teacher compiler, source certificates, independent V8/browser schedule oracle and strict admission | tracer | Every admitted trace has ordered effect/outcome and certificate receipts; all refusals counted. |
| **M6 — P0 for serving** | Native free-running Megatoken semantic-step loop, observation injection, selected continuation and checkpointing | Megatoken + tracer | Real model-selected trajectory through multiple tools and callbacks, without teacher repair. |
| **M7** | Full Natlang fresh/retained evaluator wiring, TS/module/live graph and lifecycle correctness | Natlang + tracer | Representative Natlang applications pass result/effects/event identity checks. |
| **M8** | Production-quality episode preparation, tokenizer/physical grouping, train/eval splits and lineage | Megatoken + tracer + Natlang | Independently admitted corpus and no causal leakage with realistic event histories. |
| **M9** | Model training, held-out benchmarks, ablations and production acceptance | all three | Reproducible checkpoint, inference logs, metrics, and no untracked external executions. |
| **M10** | Remove deprecated parallel routes and align docs, consumer pins, deployment policy | all three | Repository-wide searches and consumer migration receipts; no ghost compatibility route. |

**Required ordering:** M1 before admitting effectful data; M2 and M3 before claiming browser/Node callback support; M5 before effectful supervision; M6 before claiming an LLM has learned execution; M7–M9 before Natlang production claims. Independent M4 adapter development and negative tests may proceed earlier, but unsupported effects stay refused.

### Per-PR evidence template

Every integration PR should include: exact capability scope; schema/version changes; public vs private field additions; side-effect and callback lifecycle table; example generated JS; source/teacher and selected-model tests; controlled native reference tests; counterexamples/refusals; artifact fingerprints; cross-repo compatibility pin; CI receipt links; rollback/migration procedure; and updated docs. For an unmerged upstream PR, state **not yet integrated** rather than implying main-branch readiness.

## 12. Required adversarial and end-to-end test matrix

Establish an executable matrix covering each axis, with both allowed and rejected samples. At minimum:

**Value/call provenance:** string vs number, signed zero/NaN, arrays/objects, aliases, cycles, sparse holes, null prototype, nested and computed call forms, evaluated getters/coercions, stale mutation snapshots, forged site/receiver/invocation, forged callback ID, ungranted operation, reordered/extra arguments.

**Scheduling:** synchronous return and throw, Promise fulfillment/rejection/thenable adoption, two competing promises settling out of order, nested awaits, finally cleanup, queueMicrotask, multiple callbacks, callbacks before/after settlement, callback-induced nested effect, clock/timer task turns, callback throw, stream chunks/backpressure, cancellation, duplicate/late arrivals and detached effects.

**DOM and Node:** real DOM mutation, event capture/bubble ordering, listener install/remove, multiple event dispatches, navigation/frame reset, native HTTP response and rejected fetch, network abort, filesystem open/write/close, stream resource cleanup and output audit.

**Natlang:** fresh eval, retained modules, two module importers of the same mutable cell, callable-folder function, TS source mapping, live capture mutation, nested Natlang/model call, fork/close, timeout, scope capabilities, browser worker/Node difference and accurate EvalFailure events/logs.

**Training/inference parity:** teacher episode -> independently verified public v3 -> exact native Megatoken import -> actual selected free-running recurrence -> tool dispatch -> observation injection -> same selected state after rollover. Perturb a hidden future fixture and prove the earlier visible prefix is unchanged. Independently vary the selected request and prove the harness does not return the teacher's answer for the wrong request.

**Security and resilience:** malicious model-supplied operation names, payload injection, oversized data, hostile callback args, proxy/getter descriptors, cross-task/cross-origin handle, service crash, ambiguous request timeout, idempotency replay, crash between dispatch/receipt, revoked subscription, lost worker and incomplete checkpoint.

### Metrics and failure taxonomy

Report at least:

- Task correctness: completion, reachable graph/state, ordered real external effects, callback/event order and resource cleanup.
- Semantic correctness: first invalid/inconsistent witness, callsite/argument divergence, unsupported opcode, selected-controller rejection and completeness.
- Tool correctness: authorization error, dispatch count, argument/payload mismatch, duplicate/late response, callback identity failure, promise and native error disposition.
- Learning quality: actual model-selected success rate, no teacher repair, generated vs observed tokens, physical records, prediction groups, required tool turns, time to completion, peak memory, and measured compute per correct task.
- Coverage: attempted, supported, unsupported, projection-refused, resource-limited, admitted and test-split counts by source family and external capability.
- Operations: effect retries, outstanding/uncertain outcomes, cancelled resources, leaked listeners, callback queue depth and recoverable checkpoints.

Zero hidden host side-effect executions, zero future-observation leakage, zero untracked native fallback, zero false-admitted examples, and zero side effects during exact replay are **hard correctness gates**, not average-performance metrics.

## 13. Learning experiments and final acceptance

Follow [SEMANTIC_V3_MODEL_EXPERIMENTS.md](SEMANTIC_V3_MODEL_EXPERIMENTS.md) for pinned model/split/codec receipts and the existing seeds **17, 29, 43**. Preserve the frozen common-support cohort and explicit historical baseline, and add a separate **effectful, callback, async and Natlang task** cohort. Compare:

1. Conservative explicit semantic steps vs source-guided compact witnesses and different bounded expression budgets.
2. Same external actions/observations with outcome-only or no-intermediate-witness control.
3. Teacher-forced loss vs **actual free-running model-selected execution**.
4. Pure-JS semantic accuracy separately from external action selection, effect argument exactness, callbacks and final task correctness.
5. Fixed-example, fixed-token and (where measurable) fixed-compute budgets; report actual costs, not byte counts as token proxies.
6. Held-out source families, unfamiliar APIs within a registered capability family, longer tasks, larger legal graphs, deeper callbacks and multiple outstanding resources.

Run the **actual production Megatoken inference path** with checkpoint and tokenizer receipts. A correct interpreter demonstration, mocked controller trajectory, green importer, or selected teacher trace is **not a trained-model outcome**.

### Completion definition

Only declare this roadmap complete when all boxes are true:

- [ ] One canonical public semantic witness and synchronized tracer/Megatoken validators are in production.
- [ ] A real model-selected semantic request becomes a vetted external JS/native call with exact committed arguments, without raw model eval.
- [ ] Every admitted external side effect and its response/event is causally recorded, capability-authorized and delivered only when available.
- [ ] Real browser/Node callback events reenter the selected model's **owned** closures with durable identity, listener lifecycle and correct scheduling.
- [ ] Promise fulfillment, rejection, await, reactions, cleanup and required quiescence work across live inference and teacher generation.
- [ ] Automatic continuation preserves pending tool calls, captured closures, callback subscriptions, real resource handles and legal queues without future knowledge.
- [ ] Natlang's fresh and retained execution seams, real TS/module programs and task outcome contracts are validated on the selected-model path.
- [ ] Independent JS/browser reference outcomes and actual ordered side effects are checked for every admitted supported family.
- [ ] Native Megatoken episodes have correct observed/generated loss, causal dependencies and real tokenizer/physical boundaries.
- [ ] A real trained Megatoken model completes held-out Natlang tasks with external calls and callback/Promise feedback; all baselines, costs and failure categories are reported.
- [ ] Unsupported families and permission failures are explicit and counted, never silently routed to native evaluation.
- [ ] No redundant active witness, broker, callback or untraced serving path remains; independent correctness authorities are preserved.
- [ ] CI includes the full regression and cross-repo compatibility matrix, pinned SHAs, signed/fingerprinted artifacts and reproducible reports.
- [ ] Security, cancellation, idempotency, teardown and incident/rollback procedures are documented and exercised.

**Until then, describe the system precisely:** executable external-effect code and callback/Promise transport may be implemented for a bounded profile, but that is not yet a Megatoken model learning to execute arbitrary real Natlang tasks.

## 14. Related documents and source-of-truth hierarchy

Use this document as the **cross-repository integration and delivery checklist**. It extends rather than silently replacing the existing detailed implementation plans:

- [Semantic trace redesign and training contracts](SEMANTIC_TRACE_REDESIGN_PLAN.md)
- [Active implemented/refused training paths](TRAINING_IMPLEMENTATION.md)
- [Effective public witness contract](EFFECTIVE_TRACE.md)
- [Native side effects and callback prototype](NATIVE_HOST.md)
- [Current redundancy/migration inventory](REDUNDANCY_AND_EFFECT_PROVENANCE_AUDIT.md)
- [Natlang integration blockers](NATLANG_INTEGRATION.md)
- [Megatoken semantic execution importer](https://github.com/werg/megatoken/blob/main/docs/semantic_execution.md)
- [Megatoken generation/recurrence](https://github.com/werg/megatoken/blob/main/docs/generation.md)
- [Megatoken dynamic tracks and real tool-use training](https://github.com/werg/megatoken/blob/main/docs/dynamic-tracks-and-concordant-training-plan.md)
- [Natlang owned evaluator wiring](https://github.com/werg/natlang/blob/main/ts-host/OWNED_TRACING_INTEGRATION.md)
- [Natlang hybrid native/non-owned distinction](https://github.com/werg/natlang/blob/main/ts-host/HYBRID_TRACING.md)
- [Natlang evaluator execution interfaces](https://github.com/werg/natlang/blob/main/plans/EXECUTION_INTERFACES.md)
- [Natlang inline training-data ambitions](https://github.com/werg/natlang/blob/main/docs/INLINE_NATLANG_TRAINING_DATA_PLAN.md)

**Maintenance rule:** when a work package merges, record its exact tracer, Megatoken and Natlang commit SHAs and test receipts in a follow-up implementation ledger. Change this roadmap's status only for completed, independently validated gates. A change in one repository does not establish integration until the pinned counterparts accept the same contract.
