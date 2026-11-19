# Refactoring tracing-js-self toward compact algorithmic traces

**Review date:** 19 November 2026  
**Repository:** [werg/tracing-js-self](https://github.com/werg/tracing-js-self)  
**Reviewed revision:** [`8d11f38619b8443c988f79b177908649338b3897`](https://github.com/werg/tracing-js-self/commit/8d11f38619b8443c988f79b177908649338b3897) on `main`  
**Deliverable:** a proposed refactoring plan, based on source, tests, documentation, and checked-in evidence. The review did not rerun the unit suite, native consumer, or training experiments. All proposed syntax and module names below are design sketches.

## Recommendation

Introduce a small, typed **algorithm representation** between the JavaScript execution evidence and the public trace. Make that representation describe computations, relevant state changes, and external interactions. Normalize a deliberately bounded set of equivalent implementations into the same representation, then generate compact text and a natural-language reading from it.

The central design principle should be:

> Preserve the algorithmic relationships needed to explain and check the result or effects. Retain JavaScript-specific details only when they change those relationships, observable behavior, or the ability to continue execution.

This is a many-to-one projection. Different variable names, temporary bindings, helper boundaries, loop spellings, and private allocations can disappear when their differences are irrelevant under a declared semantic contract. Exact source recovery is not a success criterion.

The repository already has much of the verification infrastructure needed for this direction. V6 explicitly describes its targets as execution explanations and rejects an instruction-level bijection. It has private exact replay, independently checked public claims, bounded region summaries, and causal separation between predictions and external observations. The next refactor should build on those assets. [S1][S2]

The first complete demonstration should be **ordered numeric summation expressed in several source forms**. The second should be the existing asynchronous counter expressed as **read, observe, increment, store**, with only the ordering and identities that matter to that interaction.

---

## 1. What the current project establishes

### 1.1 Foundations to retain

The current architecture already separates several authorities:

- The owned runtime and journal record detailed execution.
- Exact replay checks the archived execution.
- Independent source, operation, branch, and completion checks qualify the teacher.
- The selected controller checks claims against previously committed public state.
- External responses arrive as observations, outside the model's authority.
- Native admission checks the actual consumer, tokenizer, visibility, and supervision behavior.

These are useful independent checks. A more abstract trace should still have detailed evidence behind it, even when that evidence contributes no public tokens. [S1][S5][S6]

### 1.2 The remaining source and runtime dependence

| Current behavior | Evidence in this revision | Refactoring consequence |
| --- | --- | --- |
| `normalizeJournal()` produces a source-anchored projection of runtime events, including identities, writes, and dependencies. | `src/semantic/normalize.js`. | Keep it as execution evidence; introduce a separate algorithm representation. |
| A dense sum summary recognizes a very specific counted `for` loop, including a zero accumulator, postfix increment, and `total += xs[i]`. | `inspectSemanticRegion()` in `semantic-regions.js`. | Several source recognizers should lower to one ordered-fold operation. |
| A pure named temporary can force an additional public computation. | The projection test requires two computations for `const previous=a+b; return previous*2`. | Make temporary elimination depend on purity, liveness, and escape, rather than source binding structure. |
| Source names are public identities; repeated callback parameters become names such as `n` and `n_1`. | `semantic-source.js` and its tests. | Separate semantic identity from optional readable source labels. |
| A request repeats evaluated arguments as a payload and includes exact source offsets and invocation routing. | `trace-text.js`, `format.js`, `controller.js`. | Derive transport details and carry authorization provenance through a trusted mapping. |
| Whole-region summaries apply only at untouched invocation entry. | `SemanticController.commit()`. | Eventually support certified regions between effect or observation boundaries. |
| Some very short summaries say only `evaluate run(...) => value`. | The current target gallery. | Preserve an explicit computational relation in the abstract trace. |

Sources: [S3][S4][S5][S7][S8][S9].

The compiler's existing expression fusion is intentionally conservative: it checks source-child relationships and recorded operand producers, rather than joining unrelated computations because their values happen to match. Keep that causal discipline while widening the supported transformations. [S4]

### 1.3 Compactness is already measurable, but the objective needs widening

The paired eleven-fixture gallery reports a reduction from **3,784 to 1,307 target tokens** between archived v5 and v6. That measurement uses the same pinned tokenizer and excludes observed context, framing, and recurrent context. It is a strong wire-format baseline, with a clearly limited scope. [S9]

The native counter audit reports **142 generated tokens and 1,567 observed tokens**. Its first scored record is `promise create @p1`. This makes two opportunities concrete: reduce runtime bookkeeping in predictions, and reduce repeated model-visible context. Moving information from generated records into observations does not, by itself, reduce total context cost. [S10]

Some shortest traces have also lost useful explanatory content. For `(a+b)*(c+d)+1`, the gallery contains:

~~~text
evaluate run(1, 2, 3, 4) => 22
end return
~~~

The result is checked, but the trace does not expose the pairwise additions and multiplication. Treat explicit algorithmic content as a constraint on compression. [S9]

---

## 2. Define the semantic contract before changing the format

### 2.1 Separate three questions

**Behavioral correctness:** Does the trace produce the required completion, visible state, and effects for this input and this external interaction?

**Normalization:** Do implementations related by a supported, sound transformation produce the same semantic core?

**Explanatory adequacy:** Does the trace retain a useful account of the computation, rather than an opaque function-name-to-answer assertion?

These questions need separate checks. Matching one recorded answer does not establish an algorithmic equivalence. Conversely, two valid explanations may differ in granularity while preserving the same algorithm and behavior.

### 2.2 Declare what is observable

Create a versioned observation contract with at least:

1. **Completion:** return, throw, or a live suspended state. Keep unsupported execution and internal runtime failure distinct from guest completion.
2. **Externally visible state:** changes to input objects, returned objects, retained resources, and captured state that may affect later work.
3. **Effects:** operation, evaluated arguments, dispatch order, multiplicity, and required correlation.
4. **Observations:** delivered results, rejection information, callbacks, and external event order.
5. **Continuations:** the semantic state and dependencies necessary to resume correctly.
6. **Relevant identity:** aliasing and ownership relationships where they can affect behavior.

Comparisons across runs should preserve rooted object relationships and input identity, while allowing fresh internal IDs to differ. Comparing raw allocation labels is not an adequate behavioral test.

For an admitted source program `P`, input `I`, external interaction `E`, and semantic lowering `A`, require:

~~~text
observable(source_execution(P, I, E))
    = observable(semantic_execution(A, I, E))
~~~

Use this as the correctness contract. A passing fixture is evidence for that execution; a general normalization rule additionally needs explicit applicability conditions and validation across its declared domain.

### 2.3 Choose bounded equivalence classes

Initially normalize only known relationships:

- Capture-avoiding lexical renaming.
- Introduction or removal of a pure private temporary.
- Expansion or extraction of a bounded pure helper.
- Equivalent traversal syntax for the same ordered fold.
- Replacement of fresh, private ordinary-object state with scalar state.
- Equivalent pure selection structures whose predicates and effects match.

Do not promise a universal equivalence procedure. Different algorithms that happen to compute the same function may retain different algorithmic traces. An iterative sum and a closed-form formula, for example, need not collapse into one explanation.

For interactive programs, equality on one observed schedule is a narrower claim than equivalence under every future response. Record that distinction. Generalized equivalence requires compatible observable behavior and resumable state at each relevant boundary, over the permitted responses.

### 2.4 Preserve necessary language semantics without repeating machinery

A language-neutral operation still needs precise semantics. A numeric profile can specify binary64 addition and left-to-right accumulation once. Individual lines then use familiar words such as “add” or “sum.”

Keep a distinction whenever it affects results or effects: number versus string addition, absent property versus `undefined`, object identity, signed zero, exceptional completion, or observable scheduling. Hide the mechanics used to implement those distinctions.

---

## 3. Introduce a semantic core and keep evidence separate

### 3.1 A small typed representation

Start with ordinary JavaScript data structures and a validator. The first version needs expression terms, ordered steps, and explicit dependencies; it does not require a general optimization framework.

| Core concept | Meaning | Initial examples |
| --- | --- | --- |
| Value or reference | A scalar, immutable value, or identity that remains observable. | Number, string, record, array, retained resource. |
| Transformation | A typed computation over named inputs. | Add, multiply, compare, project a data field. |
| Selection | A predicate and the selected value or continuation. | Choose a fallback; take a branch that controls an effect. |
| Ordered fold | Traverse a collection in specified order with an explicit initial state and step. | Sum a dense numeric array starting at zero. |
| Visible state change | Update to state that can be observed or used later. | Change an input field or retained counter. |
| Effect request | An authorized external operation with evaluated arguments. | Read a key; store a value. |
| Observation | An external fact received at a causal boundary. | A read returned 7; a request was rejected. |
| Completion or suspension | Return, throw, wait, or resume with the required live state. | Return a scalar; await a request result. |

Add mapping, filtering, search, and richer collection operations only after the first fold and effectful examples are working. An operation should enter the vocabulary because it has a useful meaning, precise semantics, and several justified source implementations.

### 3.2 Separate public meaning, trusted routing, and private evidence

**Semantic core:** operations, value dependencies, relevant state, effects, and completion.

**Trusted execution envelope:** program and region identity, capability authorization, active execution scope, observation delivery, and dispatch correlation. Some of this remains public context, but it should not all become predicted text.

**Private evidence:** source spans, source digests, runtime event IDs, detailed state versions, normalization receipts, independent reference results, and exact journal replay.

A transformation receipt should identify the rule and version, input and output semantic fragments, source/evidence correspondence, domain preconditions, live inputs/outputs, and preserved effect boundaries. It should support inspection and rechecking without making the public trace encode its own proof.

A compact dependency structure is:

~~~mermaid
flowchart TD
    A["Source and declared input domain"] --> B["JavaScript lowering"]
    B --> C["Typed algorithm representation"]
    C --> D["Checked normalization"]
    D --> E["Compact trace and language view"]
    C --> F["Semantic claim checker"]
    D --> F
    G["Owned journal and independent reference"] --> H["Private certificates"]
    B --> H
    D --> H
    H --> I["Admission checks"]
    F --> I
~~~

The checker should evaluate the emitted semantic operations against committed public state. Independent source/reference checks establish that the lowering is faithful to the actual source. These are separate obligations.

### 3.3 Keep labels distinct from identity

Use stable semantic identities determined by scope and dependencies. Canonical comparison must ignore capture-avoiding source renaming and source offsets.

Readable names can come from declared domain roles, stable operation roles, or optional source hints. Preserve actual data keys and capability names: a storage key called `"counter"` is part of behavior, not an alpha-renamable local.

Define two explicit products:

- A canonical core and serialization with deterministic names.
- An annotated reading that may show original source names.

Do not require annotated readings to have identical bytes across renamed implementations. Require canonical cores to agree. This resolves the tension between recognizable source names and implementation-independent equivalence.

---

## 4. Target examples

The following forms are illustrative. Settle exact punctuation only after measuring alternatives with the production tokenizer.

### 4.1 Retain the computation inside pure summaries

For the gallery's arithmetic expression:

~~~text
answer = add(multiply(add(a, b), add(c, d)), 1) => 22
return answer
~~~

A natural-language rendering can say:

> Add the first pair and the second pair, multiply those results, then add one. The result is 22.

The nested term retains evaluation structure. It does not assert algebraic reassociation. An implementation that introduces temporary variables for the two sums should lower to the same term when their bindings do not escape or participate in other observations.

For an increment helper:

~~~text
answer = add(input, 1) => 5
return answer
~~~

The source function name and call frame remain available in provenance. A function name alone should not be the semantic description of the operation.

### 4.2 Normalize sum implementations to an ordered fold

The indexed `for` loop, a matching `while` loop, and an eligible `for...of` loop should share:

~~~text
total = fold_left(numbers, 0, add) => 9
return total
~~~

Reading:

> Starting at zero, add each number in order. Return 9.

Bind `add` to the declared numeric semantics. Preserve the original accumulation order; do not convert the fold into an associative mathematical sum.

Each source recognizer must establish compatible traversal, initial value, input ownership, numeric domain, and absence of observable hooks or mutation. Admit `reduce` only when the owned runtime supports the exact form and the built-in and callback behavior are certified. Sparse arrays, overwritten methods, custom iterators, or callbacks with effects cannot inherit the dense ordinary-array rule.

### 4.3 Eliminate private object machinery

The gallery's `object-alias` example creates a fresh object, aliases it locally, increments its field, and returns only the scalar. It currently takes ten target records and 81 tokens. [S9]

After escape and effect analysis, its semantic trace can describe adding one to two. The object identity is unnecessary for that admitted case.

A close variant must retain state and identity if the object is returned, passed to a host operation, captured by an escaping callback, retained for another invocation, or observed through a hook. This positive/negative pair is a useful test of whether abstraction follows meaning.

### 4.4 Express an asynchronous counter through its interaction

A possible reading of the existing counter is:

~~~text
request r1: read("counter")
observe r1 as current: 7
next = add(current, 1) => 8
request r2: store("counter", next)
observe r2: completed
return next
~~~

`observe` records are supplied by the environment and receive no prediction loss. The schema distinguishes normal completion from an actual `undefined` value where that distinction matters.

The execution adapter can maintain the required promise, continuation, job, and dispatch records privately. It may hide them only when doing so preserves effect order, error handling, callback behavior, and resumability.

This example does not authorize treating `await` and `.then` as interchangeable. Their equivalence needs a separately checked scheduling profile. Initially retain all external dispatch and delivery order, including cases where responses arrive in a different order from requests.

---

## 5. Normalize with small, explicit rules

Apply passes in a fixed order until stable, or within a documented pass budget. Require determinism and idempotence: normalizing an already normalized core should not change it.

| Pass | Required reasoning | What may disappear |
| --- | --- | --- |
| Normalize names and scopes | Resolve lexical binding and capture correctly. | Source spelling and incidental numbering. |
| Propagate private values | Preserve dependencies; do not substitute merely equal runtime values. | Copies and one-use immutable temporaries. |
| Inline bounded pure helpers | Check arguments, evaluation order, recursion bounds, receiver use, and effects. | Incidental helper frames and parameter copies. |
| Compose pure expressions | Preserve numeric/coercion semantics, throwing behavior, and evaluation order. | Separate records for anonymous intermediate values. |
| Remove dead private work | Establish no effects, observable failures, needed RNG consumption, or nontermination. | Computation unused by visible behavior or continued execution. |
| Replace private object state | Prove freshness, ordinary data access, local aliases, and nonescape. | Allocation, field access, and writes used only as private scratch state. |
| Recognize ordered folds | Prove traversal and step semantics under explicit domain guards. | Index updates, loop tests, and accumulator bookkeeping. |
| Coalesce private state transitions | Prove no observer or later continuation can distinguish intermediates. | Overwritten private bindings and construction steps. |
| Simplify effect transport | Derive payload and scope from trusted state and authorization. | Repeated payload encodings and predicted source coordinates. |

Three restrictions should be visible in each rule's implementation:

**No equivalence from value coincidence.** Two expressions producing `5` on the recorded input do not acquire the same meaning. Use def-use relationships and a certified transformation.

**No unsafe algebraic rewrites.** Do not reassociate floating-point addition or replace number operations with mathematical integer operations. Even familiar identities require attention to coercion, NaN, infinity, and signed zero.

**No future-dependent public compression.** Offline access to a sealed archive must not determine an earlier public trace from a later response. Live-state analysis must conservatively retain what any permitted continuation may need until that continuation is resolved.

Initially treat unknown calls, hooks, exceptions, external interactions, and shared mutations as region boundaries. Unsupported normalization should retain a faithful detailed representation with an explicit disposition. Do not silently reinterpret an unsupported operation as pure.

---

## 6. Preserve verification while changing what gets represented

### 6.1 Keep exactness in the places where it is useful

The current strict parse/re-encode equality gives one spelling to a structured claim. The compiler's `verifyEffectfulProjection()` additionally regenerates and compares teacher artifacts. These are serialization and artifact-integrity guarantees, respectively. They do not require one trace per source program. Keep them. [S2][S4][S7]

Add a distinct semantic validation interface for alternative valid traces. It should check declared behavior and emitted claims rather than require the canonical teacher's exact bytes. Canonical targets remain valuable for deterministic dataset generation.

### 6.2 Separate omitted claims from false claims

If a normalized region omits a private temporary, it makes no assertion about that temporary. If it emits an intermediate value, that value must be correct.

Likewise, a proven irrelevant source branch may disappear, while a stated predicate or branch choice must remain truthful. The current rule requiring every source decision in a control summary should become a source-evidence requirement plus a narrower public requirement for meaningful selection. [S2][S3]

Retain the existing detection and admission rejection of false intermediate claims even when the final result is correct. The controller can retain an incorrect prediction for diagnosis while preventing it from authorizing a strict external request. Also keep independent source checks capable of detecting runtime errors that an abstract public account might otherwise conceal.

### 6.3 Generalize regions using explicit interfaces

For a region inside an invocation, record:

- Its committed live inputs and relevant state snapshot.
- Its semantic operation or bounded term.
- Its claimed outputs and visible state delta.
- Its completion behavior.
- Its continuation and effect boundary.

Validate the claim against the live public prefix. A region may not absorb an unseen external result or skip a pending effect. This extends today's entry-only summary mechanism without making the controller a second general JavaScript interpreter. [S5]

### 6.4 Replace source-site authorization before removing source spans

Today, request spans and invocation IDs are checked against the source callsite and enclosing function. The controller also regenerates a payload from committed arguments and checks equality. [S5][S7]

For the new request:

1. Bind an immutable semantic effect boundary to its source/capability authorization.
2. Validate that the selected boundary is legal in the current semantic continuation.
3. Check operation, arguments, ownership, and prior claim consistency.
4. Derive the canonical payload once using the existing host codec.
5. Preserve its dispatch-time snapshot and external correlation.

Where several otherwise identical effect boundaries are possible, retain a small semantic boundary identifier. Do not guess which source callsite was intended. Source digests, offsets, and exact request evidence remain in the trusted envelope or private receipt.

---

## 7. Refactor as reviewable changes

### Phase 0 — Freeze the contract and baseline

**Changes**

- Add `docs/SEMANTIC_ALGORITHM_CONTRACT.md` defining observables, supported equivalences, meaningful explanation, numeric profiles, and causal boundaries.
- Clarify the README's direction using the existing v6 baseline.
- Save a paired baseline for the eleven current gallery fixtures plus the new equivalence families.
- Inventory assumptions encoded in tests: source spelling, bound temporaries, branch lists, request spans, and promise/job structure.
- Mark historical v4/v5 documents as historical where their wording or links are confusing; preserve their original evidence.

**Acceptance**

Every proposed omission has an explicit rule saying why it is irrelevant. Baseline reports separate target tokens, observed tokens, framing, and cumulative serving context. Missing native measurements are reported as unavailable.

### Phase 1 — Introduce the core in a shadow pipeline

**Proposed modules**

- `src/semantic/ir.js` — typed structures, validation, stable identities.
- `src/semantic/operations.js` — operation meanings and bounded checking.
- `src/semantic/observables.js` — observation contract and comparisons.
- `src/semantic/lower-js.js` — JavaScript-specific lowering.
- `src/semantic/provenance.js` — source/journal correspondence and receipts.
- `src/semantic/normalize-algorithm.js` — normalization pipeline.

Keep `normalizeJournal()` as the existing journal projection. Refactor `semantic-source.js` and `semantic-regions.js` to expose their useful source recognition separately from operation checking.

Begin with lexical renaming, pure private temporaries, and bounded helper expansion. Produce the new core alongside the existing v6 artifact during development. The shadow path should not be admitted as production data under the v6 label.

**Acceptance**

Equivalent expression variants share a canonical core. Normalization is deterministic and idempotent. Incorrect expressions, changed effects, capture errors, and unproved operations are refused or retained faithfully. Private replay and current source checks continue to pass.

### Phase 2 — Complete the ordered-sum slice

Implement recognizers for the existing indexed `for` form, a matching `while` form, and simple temporary/helper variations. Add `for...of` when its supported input and iterator profile is established; add `reduce` separately.

Lower all admitted forms to the same `fold_left` term. Use one semantic evaluator and one natural-language template for the term. Preserve separate source certificates.

**Acceptance**

The declared source family converges to the same core and canonical text on the same inputs. Empty arrays, singleton arrays, signed zeros, large finite values, and rounding-sensitive sequences are covered. Changed order, holes, coercions, mutation, hooks, and unsupported iteration are distinguished or refused.

A reader can identify “ordered accumulation from zero” without reading the JavaScript. Any additional tokens relative to an opaque v6 summary are reported explicitly and assessed against that explanatory improvement.

### Phase 3 — Add liveness and private-state simplification

Start with the current `object-alias` fixture and pure temporary cases. Add def-use and escape analysis sufficient for a bounded region; avoid attempting whole-program JavaScript analysis.

Retain observable input mutations, returned aliases, captured cells, retained resources, and state needed across suspension. Keep full internal events in the private journal.

Revise tests that require temporary or source-cell distinctions in the public trace. Keep their underlying alias, capture, intermediate-truth, and source-evidence protections.

**Acceptance**

The private-object example and its scalar counterpart share a semantic core. Returned, captured, effect-exposed, and retained-object variants do not collapse incorrectly. A false emitted intermediate claim still fails even when the final answer matches.

### Phase 4 — Complete one effectful slice

Refactor the counter path across `effectful-compiler.js`, `controller.js`, and the selected harness:

- Apply certified pure regions before and after an observation.
- Predict arguments once and derive payloads.
- Replace predicted source spans with certified semantic-boundary routing.
- Make active scope implicit when unambiguous.
- Hide only redundant promise/continuation mechanics under a narrow, documented async profile.

Use the existing intent journal and host lifecycle protections for dispatch, rejection, and recovery. The abstract trace must not introduce duplicate effects on resume.

**Acceptance**

The new counter preserves read/store arguments, order, multiplicity, observed responses, and completion. Future-response perturbation leaves earlier public prefixes unchanged. Rejection, finally cleanup, out-of-order responses, callbacks, and checkpoint/resume variants either pass their declared profile or retain detailed boundaries.

### Phase 5 — Stabilize the text, language view, and versioned consumers

Propose `semantic-trace/7` only once its semantic changes are defined. The version number is provisional until the implementation is scheduled.

Update together:

- `format.js` and `trace-text.js` for the typed records and compact spelling.
- `trace-gbnf.js` and the decoder fixture corpus.
- `render.js` and inspection tools for a controlled natural-language view.
- `controller.js` and `harness-v4.js` for semantic state and trusted routing.
- Context, execution, continuation, admission identity, and contract-generation code.
- The independent native consumer and its tokenizer/supervision checks.

Use one operation registry to keep the checker, structured record, short text, and language templates aligned. Avoid unchecked prose as an execution format.

Add a concrete context-compaction pass: publish immutable program/operation definitions once, reference already committed definitions, and carry the live semantic state needed at each boundary. Keep any source context required by the selected task. An identifier must never stand in for a definition the consumer cannot actually access, and retrieval or cache costs must appear in the measurements. Keep operation definitions, normalization rules, and admitted input assumptions available without repeating their full text on every step.

**Acceptance**

JavaScript and native consumers agree on typed meanings and malformed-record rejection. Continuation snapshots preserve the required live state. Generated and observed roles remain separate at every prediction boundary. No hidden checker correction appears as a model prediction.

The current v6 codec rejects previous formats; maintain equally explicit version boundaries for this migration. Preserve historical artifacts under their original identities. Regenerate and re-admit new traces instead of relabeling old bytes. [S2][S11]

### Phase 6 — Measure, qualify, and switch the default

Extend the current gallery, baseline, selected evaluation, and causal-LM tooling. Compare the frozen v6 baseline with the new representation on exactly paired source/input/effect cases. [S12]

Make the normalized representation the default after semantic, causal, compatibility, and full-cost gates pass. Preserve a detailed verification path and explicit fallback inside the declared new contract. Model-learning claims require a separate controlled experiment; engineering qualification alone does not establish them.

**Acceptance**

Publish family-level coverage, normalization successes, refusals, failures, token costs, comprehension results, and native qualification. If a family becomes shorter but harder to understand or execute, revise its representation before promotion.

### File-level implementation map

| Existing area | Intended role after refactoring |
| --- | --- |
| `src/runtime.js`, replay, validation, spec operations | Detailed execution and certification authority. |
| `src/semantic/normalize.js` | Journal-derived evidence adapter. |
| `semantic-program.js`, `semantic-source.js`, `semantic-regions.js` | Source analysis and certified lowering into common operations. |
| `effectful-compiler.js` | Orchestrate evidence, lowering, normalization, and export through smaller modules. |
| `witness-check.js` | Bounded semantic operation checking against committed public state. |
| `controller.js` | Apply semantic claims and preserve causal state; delegate trusted source/effect routing. |
| `source-check.js`, `effectful-admit.js` | Independent source truth, transformation evidence, and admission. |
| `format.js`, `trace-text.js`, `trace-gbnf.js` | Strict versioned encoding and decoding of the common representation. |
| `render.js`, gallery and diagnostics | Faithful human reading and paired cost/meaning inspection. |
| `model-driver.js`, `harness-v4.js`, continuation and contract code | Context, visibility, execution boundaries, and cross-consumer compatibility. |

The repository already has separate source, public-claim, and native-admission authorities. Avoid folding those into a single checker during the refactor. [S6]

---

## 8. Evaluation that makes the direction falsifiable

### 8.1 Build equivalence families with explicit domains

Add versioned fixtures, for example under `fixtures/semantic-equivalence/`, and a runner such as `tools/compare-semantic-representations.mjs`.

Each family should contain:

- The source variants and transformation relationship.
- Its input domain and effect contract.
- Expected common semantic structure.
- Positive cases, counterexamples, and unsupported cases.
- Distinct source provenance and one family identity.

Use exhaustive small bounded inputs where feasible, generated edge cases, and an independent runtime reference. Differential testing supports the rules; it does not substitute for stating their preconditions.

Keep semantic relatives together when splitting datasets, alongside existing project/source holdouts. A held-out rename of a training algorithm is not evidence of generalization to a new algorithm. Keep syntax-split stress testing separate from executed behavioral-equivalence testing.

### 8.2 Require negative pairs

| Tempting merge | Counterexample that must remain visible |
| --- | --- |
| Same final scalar | One program issues an extra store or different cleanup. |
| Same values in different order | Floating-point fold gives a different rounded result. |
| Addition | A string operand changes it to concatenation. |
| Same apparent field value | Getter or proxy performs work or throws. |
| Same object contents | One program mutates an input alias; another returns a copy. |
| Same terminal object state | An intermediate value is observed by a callback or effect. |
| Same eventual request results | Dispatch order, duplicate dispatch, or callback order differs. |
| Same successful path | Rejection/finally behavior or required continuation differs. |
| Same output on one input | A different predicate or algorithm diverges elsewhere. |
| Omitted private work | Removed work consumes relevant randomness, throws, or does not terminate. |

Also mutate certificates, region boundaries, claimed fold order, and observed/generated roles. Wrongly accepted normalization is a separate failure category from failure to recognize an equivalent source form.

### 8.3 Measure meaning and total cost together

| Metric | Required reporting |
| --- | --- |
| Behavioral fidelity | Completion, visible graph/state, ordered effects, callback behavior, and continuation agreement. |
| Normalization convergence | Agreement within each declared equivalence family; supported-domain denominator shown. |
| False merges | Negative pairs incorrectly merged or accepted. |
| Algorithm coverage | Which traces state a computation or transformation, and which still use opaque summaries or detailed fallbacks. |
| Generated tokens | Actual pinned-tokenizer counts, by family and whole episode. |
| Observed tokens | Source, input, declarations, routing, and external data counted separately. |
| Framing and serving context | Actual consumer cost per boundary, peak prefix, and cumulative repeated context exposure. |
| Runtime overhead | Lowering, checking, normalization, dispatch, and continuation costs. |
| Comprehension | Accuracy and time for result, data-flow, condition, effect-order, and counterfactual questions. |
| Learned execution | Valid next actions, successful effects, completed rollouts, and held-out task success. |

Report paired distributions, median and p95, as well as totals. Include failures, refusals, and fallbacks. Do not reward a representation for silently excluding its expensive cases.

### 8.4 Test natural-language alignment directly

Start with a controlled renderer from the semantic core. Then evaluate whether readers or a fixed, separately scored evaluator can:

1. Identify the algorithm without seeing the source.
2. Explain which inputs determine an output.
3. Identify the next effect and the condition that enables it.
4. Distinguish mutation from copying and order-sensitive from order-insensitive work.
5. Detect a wrong paraphrase that changes a value, condition, alias, or effect order.

Add several independently written paraphrases per operation or algorithm family. Test trace-to-description and description-to-semantic-operation understanding. Judge the resulting meaning, not recovery of the original source or exact wording.

Keep domain-sensitive qualifiers when needed: “sum in order starting at zero” is more precise than “sum” for the fold profile. A short familiar vocabulary is useful only if it remains unambiguous.

### 8.5 Set release gates without inventing performance gains

Before promotion:

- All declared positive and negative regression fixtures pass.
- Every emitted claim is checkable under its declared profile.
- Existing independent source, alias, exception, cleanup, and causal-isolation protections remain effective.
- The native and JavaScript consumers agree.
- Full-cost measurements are available for the unchanged baseline corpus.
- Comprehension does not materially regress on a predeclared task set.
- Unsupported cases have explicit, faithful dispositions.

Use zero observed false merges on the release suite as a gate, while making clear that a finite suite is not a universal proof.

Choose numerical compression and learning targets after the first paired measurements. Some algorithm-revealing traces may be longer than `evaluate run(...)`. Evaluate their usefulness per token and full-task performance rather than requiring every trace to shrink.

For learning experiments, hold sources, splits, tokenizer, model, and training procedure fixed where possible. Report both matched-example and matched-token/compute comparisons; different trace lengths make those different experiments. Predeclare success and non-regression thresholds, then evaluate held-out algorithm families and longer inputs.

---

## 9. Priority and definition of success

The first implementation milestone should include only:

1. The semantic/observation contract.
2. A typed core with source/evidence sidecars.
3. Alpha normalization and pure temporary/helper normalization.
4. One shared ordered-fold meaning with several source recognizers.
5. A faithful compact and natural-language rendering.
6. Positive and negative equivalence tests with paired token accounting.

Follow with private-object simplification and the asynchronous counter. Defer broad JavaScript coverage, arbitrary loop discovery, general effect reordering, and unrestricted prose parsing.

The resulting system should be able to demonstrate:

> Several implementations of the same admitted algorithm produce the same semantic core. The trace states the meaningful computation and relevant interactions. A checker can validate it, a reader can explain it, and source-specific machinery remains available as evidence without dominating the representation.

That is the refactoring objective to use when deciding whether a new record, normalization rule, or language feature belongs in the project.

---

## Source references

All links below are pinned to the reviewed revision. Repository measurements are reported as checked-in evidence, not as experiments rerun for this review.

- **[S1]** [README: current v6 model-facing traces and verification boundaries](https://github.com/werg/tracing-js-self/blob/8d11f38619b8443c988f79b177908649338b3897/README.md).
- **[S2]** [Production semantic traces v6: grammar, authority, region profiles, and compatibility](https://github.com/werg/tracing-js-self/blob/8d11f38619b8443c988f79b177908649338b3897/docs/PRODUCTION_TRACE_V6.md).
- **[S3]** [Semantic region recognition and evaluation](https://github.com/werg/tracing-js-self/blob/8d11f38619b8443c988f79b177908649338b3897/src/training/semantic-regions.js); [journal-derived normalization](https://github.com/werg/tracing-js-self/blob/8d11f38619b8443c988f79b177908649338b3897/src/semantic/normalize.js).
- **[S4]** [Effectful compiler, expression fusion, certificates, and exact reprojection](https://github.com/werg/tracing-js-self/blob/8d11f38619b8443c988f79b177908649338b3897/src/training/effectful-compiler.js).
- **[S5]** [Selected semantic controller, request authorization, observations, and continuations](https://github.com/werg/tracing-js-self/blob/8d11f38619b8443c988f79b177908649338b3897/src/training/controller.js).
- **[S6]** [Semantic authority matrix](https://github.com/werg/tracing-js-self/blob/8d11f38619b8443c988f79b177908649338b3897/docs/SEMANTIC_AUTHORITY_MATRIX.md); [effectful admission and counterfactual-prefix checks](https://github.com/werg/tracing-js-self/blob/8d11f38619b8443c988f79b177908649338b3897/src/training/effectful-admit.js).
- **[S7]** [Typed format](https://github.com/werg/tracing-js-self/blob/8d11f38619b8443c988f79b177908649338b3897/src/training/format.js); [production trace text](https://github.com/werg/tracing-js-self/blob/8d11f38619b8443c988f79b177908649338b3897/src/training/trace-text.js).
- **[S8]** [Projection tests: bound temporaries and effect barriers](https://github.com/werg/tracing-js-self/blob/8d11f38619b8443c988f79b177908649338b3897/test/training-semantic-projection.test.js); [source-name, property, capture, and prefix tests](https://github.com/werg/tracing-js-self/blob/8d11f38619b8443c988f79b177908649338b3897/test/training-semantic-source.test.js); [source-linked claims](https://github.com/werg/tracing-js-self/blob/8d11f38619b8443c988f79b177908649338b3897/src/training/semantic-source.js).
- **[S9]** [Current target gallery and paired v5/v6 costs](https://github.com/werg/tracing-js-self/blob/8d11f38619b8443c988f79b177908649338b3897/docs/evidence/semantic-target-gallery-v2/gallery.md); [abstraction experiments and promotion history](https://github.com/werg/tracing-js-self/blob/8d11f38619b8443c988f79b177908649338b3897/docs/SEMANTIC_TRACE_ABSTRACTION.md).
- **[S10]** [Native token and supervision audit, including its learning-evidence limits](https://github.com/werg/tracing-js-self/blob/8d11f38619b8443c988f79b177908649338b3897/docs/evidence/native-v6-qualification-20261118/TOKEN_AUDIT.md).
- **[S11]** [V6 codec and cross-consumer fixture tests](https://github.com/werg/tracing-js-self/blob/8d11f38619b8443c988f79b177908649338b3897/test/training-trace-v6.test.js); [contract generator](https://github.com/werg/tracing-js-self/blob/8d11f38619b8443c988f79b177908649338b3897/tools/generate-semantic-contract.mjs).
- **[S12]** [Current baseline runner](https://github.com/werg/tracing-js-self/blob/8d11f38619b8443c988f79b177908649338b3897/tools/current-v6-baseline.mjs); [selected evaluation](https://github.com/werg/tracing-js-self/blob/8d11f38619b8443c988f79b177908649338b3897/src/training/selected-evaluation.js); [causal-LM bridge](https://github.com/werg/tracing-js-self/blob/8d11f38619b8443c988f79b177908649338b3897/src/training/causal-lm-bridge.js).

[S1]: https://github.com/werg/tracing-js-self/blob/8d11f38619b8443c988f79b177908649338b3897/README.md
[S2]: https://github.com/werg/tracing-js-self/blob/8d11f38619b8443c988f79b177908649338b3897/docs/PRODUCTION_TRACE_V6.md
[S3]: https://github.com/werg/tracing-js-self/blob/8d11f38619b8443c988f79b177908649338b3897/src/training/semantic-regions.js
[S4]: https://github.com/werg/tracing-js-self/blob/8d11f38619b8443c988f79b177908649338b3897/src/training/effectful-compiler.js
[S5]: https://github.com/werg/tracing-js-self/blob/8d11f38619b8443c988f79b177908649338b3897/src/training/controller.js
[S6]: https://github.com/werg/tracing-js-self/blob/8d11f38619b8443c988f79b177908649338b3897/docs/SEMANTIC_AUTHORITY_MATRIX.md
[S7]: https://github.com/werg/tracing-js-self/blob/8d11f38619b8443c988f79b177908649338b3897/src/training/format.js
[S8]: https://github.com/werg/tracing-js-self/blob/8d11f38619b8443c988f79b177908649338b3897/test/training-semantic-projection.test.js
[S9]: https://github.com/werg/tracing-js-self/blob/8d11f38619b8443c988f79b177908649338b3897/docs/evidence/semantic-target-gallery-v2/gallery.md
[S10]: https://github.com/werg/tracing-js-self/blob/8d11f38619b8443c988f79b177908649338b3897/docs/evidence/native-v6-qualification-20261118/TOKEN_AUDIT.md
[S11]: https://github.com/werg/tracing-js-self/blob/8d11f38619b8443c988f79b177908649338b3897/test/training-trace-v6.test.js
[S12]: https://github.com/werg/tracing-js-self/blob/8d11f38619b8443c988f79b177908649338b3897/tools/current-v6-baseline.mjs

