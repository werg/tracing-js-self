# Expanding language coverage through compact algorithmic traces

**Project:** [werg/tracing-js-self](https://github.com/werg/tracing-js-self)  
**Review date:** 19 November 2026  
**Reviewed main revision:** [c165dad8e8226167ec1649cbe6d654cf8662aaf8](https://github.com/werg/tracing-js-self/commit/c165dad8e8226167ec1649cbe6d654cf8662aaf8)  
**Status:** Proposed implementation plan, grounded in source, tests, contracts, and retained measurement reports. The repository test suite and model experiments were not rerun for this review.

**Implementation update, 20 November 2026:** This document retains its original
review baseline and proposed work. See the [current bounded profile/status
matrix](SEMANTIC_REGIONS_V8.md#current-bounded-coverage-and-qualification) for the
implemented v8 paths, source qualification, explicit refusals and remaining
native/model promotion gates. The implementation does not mark every wave or
the production-default decision complete.

## Recommendation

Make the standard trace a **small, compositional language of algorithmic operations**, rendered with familiar code and mathematical notation plus short natural-language verbs where they clarify behavior. Expand its coverage first across features the owned runtime already executes, then extend the runtime and frontend together for missing features.

The next major architectural change should be **local abstraction within a program**. A getter, callback, or cleanup block should have its own checked boundary while surrounding arithmetic, selection, and traversal remain compact. Today the v7 compiler selects an algorithm or detailed representation for the whole episode; this makes the abstraction boundary unnecessarily coarse. [R2]

The recommended order is:

1. Establish a current, profile-specific coverage and cost baseline.
2. Make formal notation an explicit part of the trace-language design.
3. Introduce compositional regions and shared state/continuation interfaces.
4. Generalize selection, binding, traversal, property access, calls, and completion.
5. Use those concepts to cover iterators, generators, classes, coercion hooks, richer asynchronous behavior, and modules.
6. Promote each qualified slice using actual model comprehension, execution, and total-token measurements.

“Language coverage” here primarily means JavaScript and the JavaScript semantics reached through the existing TypeScript/module adapters. The semantic vocabulary should be reusable across other languages later, but adding unrelated language frontends would dilute this effort.

---

## 1. What the project already has, and where expansion is blocked

### 1.1 Preserve the useful v7 foundation

The reviewed main includes the v7 candidate and its detailed/native training paths, while the README still identifies v6 as the production language. This plan expands the candidate toward the standard format and keeps default promotion as an explicit delivery decision. [R7], [R9b]

The project already has a typed algorithm core, an operation registry, deterministic normalization, strict text encoding, controlled-English readings, independent source checks, causal execution, detailed fallback, and native/training integration. These are the foundation for the work below. [R1], [R2], [R3], [R4]

The following are independent examples of the current compact codec, each with its own inputs and identity scope:

```text
v0 = add($a0, $a1) => 7
v1 = fold_left($a0, 0, add) => 9
request r0 b0: demo.readAsync("counter")
observe r0 as v0: fulfilled 7
return 7
```

These are examples of the existing codec, not a newly proposed grammar. The English renderer is a separate reading of that meaning. Its longer sentences need not become the required model target. [R4]

The immediate objective is broader and more compositional meaning, with better surface choices where measurements justify them.

### 1.2 Treat coverage as a ladder

The following boundaries are materially different:

| Boundary | Current observation | Consequence for this plan |
| --- | --- | --- |
| Bounded script frontend and owned runtime | Many object, Promise, scheduling, and binary-data behaviors already exist. | Reuse the owned implementations and their tests. |
| Strict `training-js/1` frontend | Supports substantial JS, but exposes a different subset: for example, its constructor allowlist omits `Promise` and `Proxy`. | Some additions are frontend exposure plus qualification, rather than new runtime implementations. |
| Compact v7 lowering | Pure lowering is narrow; the fold is an ascending, positive-zero-initialized numeric sum over guarded dense arrays. `reduce` is not yet certified. | Generalize operations, control flow, and region interfaces. |
| Compact effectful lowering | `serial-scalar-effects/1` handles immediately awaited reads and synchronous stores with one outstanding request. | Add branch, completion, capture, callback, and concurrency meaning around existing effects. |
| Detailed v7 | Already exists inside the v7 contract. | Improve where detail is required; do not rebuild this path from scratch. |
| Native and model qualification | Native v7 integration is documented and pinned. Full serving-cost qualification and external comprehension remain separate. | Format acceptance must remain distinct from model usefulness. |

Sources: strict frontend and owned runtime [R5]; pure/effectful lowering [R3]; v7 integration and training contract [R7].

For example, optional chains, declaration destructuring, closures, array callbacks, exceptions, and many Promise operations already have bounded execution support. Their presence does not mean they receive compact algorithmic descriptions. Conversely, classes and generators are actual strict-frontend gaps. [R3], [R5]

### 1.3 The whole-episode choice is the largest structural bottleneck

`defineAlgorithmProgram()` tries pure lowering and then serial-effect lowering. If no compact profile applies, the compiler emits a detailed episode. A locally difficult operation can therefore prevent abstraction of otherwise simple work. [R2]

Change that unit of selection from the whole function/episode to a **certified region**, with an explicit interface to adjacent regions. This should produce immediate value before general generators, classes, or full ECMAScript coverage are available.

### 1.4 Rebaseline instead of extending historical claims

The retained v7 comparison at producer `e96dd4e…` reports:

| Population | Historical result | Interpretation |
| --- | --- | --- |
| Unchanged 11-case gallery | 6 compact cases, 5 detailed fallbacks; 1,307 → 1,154 generated tokens, −11.7% | Useful paired evidence over a small diverse gallery. |
| Gallery plus 87 equivalence-family executions | 13,660 → 3,200 generated tokens, −76.6% | Strong gains on a suite dominated by newly recognized loop variants. |
| Negative suite | 26 recognition refusals and 2 executed distinguishing pairs | Valuable engineering checks; executed semantic counterexamples should expand substantially. |
| Reader/model understanding | Unmeasured in that report | No comprehension or learning gain follows from token savings alone. |

Those measurements belong to their producing revision. The historical five fallbacks were v6 artifacts; current code additionally has detailed-v7 export and newer native integration. Do not treat the old report as a current-main qualification run. [R6], [R7]

The existing capability ledger also hardcodes v6 projection/contracts, and its checked-in receipt was produced at an earlier revision. Extend it so the main coverage report actually measures the new algorithm language. [R8]

**First documentation cleanup:** reconcile current code with stale passages in the implementation ledger, Promise documentation, and README. For example, evaluated-module documentation already includes synchronous cycles and live imported cells, while the README still describes an acyclic graph. Record which profile and revision each claim covers. [R1], [R5], [R9]

---

## 2. Define the target language by meaning, familiarity, and cost

### 2.1 A hybrid of pseudocode and terse language should be the default candidate

Use familiar expressions for operations that already have compact, recognizable notation:

```text
result = (a + b) * (c + d) + 1 => 22
limit = configured ?? 10 => 0
total = fold_left(xs, 0, (acc, x) => acc + x) => 9
```

Use short verbs for behavior that an expression alone leaves unclear:

```text
capture count by cell
invoke getter account.balance => 20
close iterator it after break
observe request r0 => fulfilled 7
```

**All examples from this section onward are proposed semantic sketches, not claims about currently accepted syntax.** Ordinary names are readable aliases; the canonical format must still resolve identities deterministically.

Do not impose an English-only criterion. Also do not assume infix, Unicode, or a very short operator name automatically saves tokens. Choose spellings with the actual tokenizer and comprehension experiment.

### 2.2 Separate two decisions

**Abstraction:** which computation should one trace step describe?

**Rendering:** how should that same computation be written?

A loop becoming an ordered fold is an abstraction change. Replacing `add(a,b)` with `a + b` is a rendering change. Test them independently, so improvements have an identifiable cause.

Keep one canonical serialization per released semantic contract. Alternative formal, hybrid, and prose renderings are experimental arms or derived views, not three independently evolving execution languages.

### 2.3 Canonicalize behavior, preserve distinctions

The normalization objective should be:

> Equivalent implementations, under the same declared semantic domain and observation contract, produce the same core operation structure.

This is stronger than recognizing a particular AST pattern and narrower than treating every occurrence of a familiar algorithm name as equivalent.

For example, indexed loops, matching `while`, eligible `for...of`, and `reduce` may share an ordered-fold representation when their traversal, initialization, callback behavior, and observable effects agree. A reverse traversal, a hole-skipping reduction, or an effectful callback can require a different profile or structure. The ECMAScript array algorithms make these distinctions observable. [S3]

Use shared families with meaningful parameters:

- `select`: predicate, laziness, selected branch.
- `fold`: traversal, initial state, step, termination.
- `read/write`: target identity, key, receiver, relevant access behavior.
- `call`: function, receiver, arguments, captured cells, completion.
- `suspend/resume`: continuation, awaited work, live state.
- `cleanup`: obligation and pending completion.

This gives related behaviors related expressions without forcing different behaviors into identical text.

### 2.4 Keep the computation visible

A compact step should expose enough structure to explain its result. `evaluate run(inputs) => answer` is not a useful standard summary for an otherwise representable algorithm.

Conversely, a single enormous expression is not automatically a good explanation. Bound term depth, repeated subexpression expansion, and semantic work per prediction. Keep a named intermediate when it is reused, establishes a meaningful decision, identifies shared state, or improves model success.

“Reasoning” in this format means the computation and decisions justified by execution. Do not invent programmer intent or an algorithm label from a coincidentally matching final result.

### 2.5 Publish semantic qualifications once where possible

A compact region can inherit a checked profile specifying, for example, ordered JavaScript Number arithmetic and an ordinary dense-array traversal. It need not repeat that prose on every line.

The profile must be available to the consumer before use and included in real context-cost measurements. If a distinction is essential to interpreting a line and is not supplied by its profile, put it in the line.

Keep Number, BigInt, concatenation, equality modes, and conversion operations distinguishable. Mathematical notation does not authorize real-number algebra or floating-point reassociation.

---

## 3. A shared vocabulary for common and exotic features

The following vocabulary is a design target, not a request to expose every specification operation as a public trace token. Most programs should use a small subset.

| Semantic family | Candidate compact expression | Concise natural-language reading | Features that can reuse it |
| --- | --- | --- | --- |
| Primitive transformation | `y = (x + 1) * 2 => 8` | Increment, then double. | Expressions, temporary variables, pure helpers. |
| Lazy selection | `y = p ? a : b` | Choose a if p, otherwise b. | Conditional expressions, eligible branches, guarded assignments. |
| Defaults | `y = default_undefined(x, 10)` | Use 10 only if x is undefined. | Parameter and destructuring defaults. |
| Nullish fallback | `y = x ?? 10` | Use 10 if x is null or undefined. | Nullish coalescing and eligible explicit checks. |
| Binding/projection | `bind {name, limit = 10} from options` | Read and bind the selected fields. | Declarations, parameters, assignment patterns once supported. |
| Ordered traversal | `ys = map(xs, f)` | Transform each item in order. | Array callbacks, equivalent explicit loops. |
| Accumulation | `s = fold_left(xs, init, step)` | Accumulate from init in order. | Sum, count, histogram, multiple accumulators. |
| Early-stop search | `x = find(xs, predicate)` | Stop at the first match. | `find`, eligible break/return loops, search helpers. |
| Visible state | `write object.key = value` | Update that object's data field. | Ordinary data-property assignment and alias-visible mutation. |
| Property assignment | `set(o, key, value, receiver=o)` | Assign using the object's property semantics. | Setters, inherited properties, proxy traps, strict assignment failures. |
| Shared capture | `write cell count: 2 -> 3` | Increment the shared captured count. | Closures, callbacks, retained state. |
| Invocation | `call f(this=o, args=[x])` | Call f with receiver o and argument x. | Methods, ordinary calls, getter/trap bodies. |
| Conversion | `v = to_primitive(o, hint=number)` | Convert o using its numeric preference. | Coercive operators and conversion functions. |
| Iterator progress | `next(it) => value 4` | Obtain the next value. | Custom iterables, spread, destructuring, generator consumers. |
| Iterator completion | `close(it, pending=break)` | Close the iterator before leaving. | Early loop exit, partial destructuring, abrupt iteration. |
| Suspension | `yield 4; suspend g` | Yield 4 and retain the continuation. | Generators; shared continuation infrastructure for async features. |
| Construction | `o = construct Counter(2)` | Create and initialize a Counter. | User constructors and classes, with visible initialization steps when needed. |
| Abrupt completion | `pending return 3; cleanup …` | Run cleanup before completing the return. | `try/finally`, iterator closing, resource disposal. |
| External work | `request r0: read("counter")` | Start the read. | Host calls, async wrappers, callback-backed services. |
| Observation | `observe r0 => fulfilled 7` | The environment supplied 7. | Externally supplied host results, settlements, and events. |
| Retained callback | `register listener h with capture count` | Retain h with access to the shared count. | Subscriptions, event handlers, repeated callbacks. |
| Module cell | `import count as live cell m.count` | Read the export's current binding. | Named imports, re-exports, supported module cycles. |

A general `set` can invoke a setter without changing the accessed property. Record the setter's actual state changes and completion; reserve `write` for a committed data-field change. Internally computed Promise settlement remains owned computation, not a new environmental observation.

Two rules keep this vocabulary economical:

1. A general operation can specialize to a cheaper form after a checked guard: an ordinary own-data read can become a projection; a generic traversal can become an ordered array fold.
2. Detail is shown when it changes the explanation. A pure local helper frame can disappear; a getter that increments a counter cannot.

---

## 4. Make abstraction compositional

### 4.1 Add one region interface shared by compact and detailed execution

Evolve the current IR and controller rather than building a second general JavaScript interpreter. A region should have:

| Interface part | Required meaning |
| --- | --- |
| Live inputs | Committed values and relevant object/cell identities available at entry. |
| Behavior | Typed operation or bounded structured body; evaluation order and laziness. |
| Effects | Read/write footprint, possible guest calls, throws, suspension, and identity escape. |
| Live outputs | Computed values and visible state changes needed by any permitted continuation. |
| Completion | Normal continuation, return, throw, break/continue, or suspension. |
| Obligations | Pending requests, callback lifetimes, cleanup and iterator-closing work. |
| Boundary | Next legal continuation/effect boundary and any required routing identity. |

Source spans, detailed journal events, correspondence maps, and normalization receipts remain private evidence. Any state or obligation the model must use must still be present in public context or a resolvable published definition.

### 4.2 Support compact–detailed–compact composition

A useful first integration fixture is:

1. A certified arithmetic or traversal region.
2. A property access that runs a getter, represented with existing checked detail.
3. Another certified computation using the getter's committed result.
4. A visible write or return.

All parts must share the same semantic identities and completion state. Define and check the mapping between detailed cells/objects and region inputs/outputs. Do not splice together independent traces merely because their final scalars agree.

Each entry binds an immutable source-derived region definition to the current causal cutoff, live values, and anchored object/cell identities. The controller checks that entry against committed state before accepting claims and applying their state changes. Compact and detailed regions use one state-transition and dispatch interface. Segment at guest calls and observable boundaries, so a later failure cannot roll back or repeat an already committed effect. Reject an entry made stale by an intervening callback or hook mutation.

A checkpoint records the active region/cursor, shared live values and reachable alias-preserving state, pending completion, cleanup/iterator obligations, request/handler lifetimes, and public cutoff. Restore through the same interface without rerunning completed regions or redispatching existing intents.

Fallback must be local and deterministic. If eligibility fails before the region runs, select its detailed path. If execution has already dispatched effects or committed state, resume from that state; never restart the source region and duplicate work.

### 4.3 Add minimal effect and alias analysis

Extend existing def-use/liveness/provenance information with:

- Pure versus potentially throwing computation.
- Reads and writes to known local, captured, and externally reachable state.
- Calls to guest code, accessors, conversion hooks, or proxy traps.
- Allocation and identity escape.
- Suspension, external requests, retained callbacks, and cleanup obligations.

“Pure” does not mean “total.” An unused computation that can throw cannot be erased as dead work. An apparently ordinary read can invoke a hook. Unknown behavior remains a boundary until a narrower rule is established.

Eligibility checks must themselves be non-observing: use owned metadata and checked provenance, not extra getter/trap calls or speculative iteration.

### 4.4 Normalize regions with explicit rules

Extend the current deterministic normalizer with bounded rules:

- Capture-aware alpha normalization and dependency-based naming.
- Private temporary propagation and controlled expression composition.
- Pure helper/immutable-capture expansion.
- Structured state joins after branches.
- Ordinary-data projection and private allocation elimination.
- Ordered traversal recognition.
- Coalescing of private transitions with no intervening observer.

Do not infer equivalence from output equality, rename data keys, commute effects, or change evaluation order. Select regions from source and the available prefix; later observations cannot justify earlier compression.

### 4.5 Version the contract coherently

Current v7 declares one representation per episode. Mixed regions change that contract, contexts, and continuation semantics. Implement them in an explicit next contract revision, updating the JavaScript producer and pinned native consumer together.

Reuse the existing detailed witness rules and native interfaces inside the new contract. Regenerate artifacts and admission receipts; preserve historical evidence with its original identity. The repository's implementation policy permits direct replacement while it is not in use, so avoid unnecessary compatibility adapters. [R1], [R2], [R7]

---

## 5. Expand coverage in dependency order

### Wave A — Broader descriptions of already executable code

This is the first major coverage delivery.

**Selections and bindings.** Extend compact lowering to mutable branches with checked joins, short-circuit operators, optional chains, logical assignments, defaults, and currently supported destructuring. Add missing pattern forms incrementally: rest, assignment patterns, parameter patterns, and catch patterns.

**Traversal and callbacks.** Generalize the hard-coded sum to ordered folds with a checked step body, then map/filter, search/quantifiers, counting, multiple accumulators, and scans. Connect explicit loops and builtin/callback idioms to the same operation where the domain permits.

**Visible state and closures.** Add ordinary input-object reads and writes, returned objects, explicit aliases, captured cells, and callbacks whose bodies can be summarized. Preserve a reference when identity escapes; retain a cell when later work can read it.

**Completion and cleanup.** Represent return/throw/break/continue and pending cleanup explicitly, so an otherwise compact function can contain `try/catch/finally`.

**Async control around existing operations.** Extend beyond the straight-line counter to branches after observations, calls to supported helpers, rejection handling, and state carried across awaits.

Start with conservative ordinary-data/pure-callback profiles, then widen each through explicit hook and mutation cases. These restrictions should be machine-readable coverage qualifiers, not permanent hidden limitations.

### Wave B — Close frontend/runtime mismatches

The strict frontend currently excludes behavior already partly owned elsewhere. [R5]

Prioritize:

1. `this` and method receiver semantics.
2. Named function expressions and their local binding scope.
3. Supported Promise construction/executors.
4. Sparse array literal syntax and richer ordinary object literals.
5. Additional destructuring/rest/spread forms.
6. Existing bounded proxy paths and view constructors when independently qualified.

Include general `switch`/fallthrough, labelled exits, and tagged templates in this incremental syntax backlog. Their lowerings should reuse selection, completion, and call concepts; tagged templates additionally preserve template-object identity and raw/cooked components.

For every exposure, test the strict frontend, source certificates, owned execution, semantic projection, and native consumer. Passing an older script-profile test does not by itself qualify the training path.

### Wave C — Reusable protocols for exotic features

| Feature group | First useful slice | Higher-level description | Expansion hazards and dependencies |
| --- | --- | --- | --- |
| Symbols and protocol dispatch | Symbol values/keys, then well-known iterator and conversion hooks | Look up a protocol method and invoke it with its receiver | Distinct symbol identities, lossless archive/trace representation, symbol-keyed storage; never treat a description as identity. |
| Property access, descriptors, prototypes | Ordinary data access, inherited reads, explicit getters/setters; `in`, `instanceof`, `delete`, enumeration | Read, write, define, delete, test membership, enumerate keys | Receiver identity, lookup order, enumerability, key order, strict assignment failure, descriptor changes. |
| Coercion | Typed primitive operations, then owned conversion hooks | Convert; concatenate; numeric operation | Hook order, guest calls, throwing conversions, mixed numeric types. |
| Iteration | Owned iterator acquisition/advance/close | Traverse; take; find; close | Custom behavior, lazy consumption, abrupt completion, completion precedence. |
| Generators | `yield`, `next(value)`, `return`, `throw`, then `yield*` | Yield and resume a retained computation | Suspended locals/captures, delegated iteration, cleanup. |
| Construction/classes | User constructors and receivers, then methods/fields/inheritance | Construct; initialize; call method | Initialization order, `super`, constructor completion, escaping identity. |
| Private fields/methods | Checked private slots and brand checks | Read/write private slot on a branded object | Private names are lexical identities, not ordinary string keys. |
| Promises and async | Multiple outstanding requests, joins, rejection/cleanup | Start work; wait; observe; continue | Settlement versus delivery, thenable assimilation, microtasks, pending obligations. |
| Callbacks/subscriptions | Shared capture plus registration/invocation/close | Retain handler; handle event; release | Lifetime after registration returns, repeated/late delivery, callback failures. |
| Proxy/Reflect | Widen bounded owned traps one at a time | Intercept access/call; forward or complete | Trap execution, receiver, invariants, revocation, callability. |
| Modules | Extend existing live-cell and synchronous-cycle support | Initialize dependency; share binding; await module | TDZ, namespace receivers, async dependency cycles, dynamic import identity. |
| Collections and binary data | Broader Map/Set, typed views, bounded buffer operations | Lookup/update entry; copy/read/write range | Equality policy, insertion order, view aliasing, conversion and bounds. |
| RegExp and strings | Broader owned matching profiles | Match/capture/replace; advance search | `lastIndex`, zero-length progress, Unicode, replacement callbacks. |

Use the ECMAScript specification as a semantic checklist, not as the public trace vocabulary. Relevant sources cover conversion/iteration [S1], object internals [S6], functions/classes [S7], async/generators [S4], and modules [S8].

Make Symbol support a named prerequisite for general protocol work: `Symbol.iterator`, `Symbol.asyncIterator`, and `Symbol.toPrimitive` first; later `Symbol.hasInstance` and species behavior. Extend owned values, property keys, archives, semantic text, and native decoding coherently. Keep unsupported host-boundary symbol transport explicit.

Distinguish `for...in` key enumeration from `for...of` value iteration. An enumeration profile must preserve own/inherited and enumerable distinctions and its specified key/order behavior. It cannot be represented by an ordinary array fold without the relevant guards.

Classes, generators, and async iteration should share existing call, property, completion, and continuation concepts. They should not each acquire an unrelated miniature trace dialect.

### Wave D — Broader combinations and later profiles

Once the shared protocols are stable, qualify combinations such as:

- Destructuring plus getters and computed keys.
- Iteration plus break/finally and generator delegation.
- Mutable captures plus asynchronous callbacks.
- Class methods plus private state and coercion.
- Live module bindings plus cycles and top-level await.
- Typed views plus shared backing storage.

Keep general `eval`/`Function`, arbitrary host/DOM behavior, weak-reference/GC observability, and full cross-agent shared-memory scheduling as separately scoped later work. Prioritize them only when actual corpus demand justifies their distinct semantic and observation costs.

For TypeScript, test erased constructs and runtime-emitting constructs separately. Preserve original-source provenance while validating the generated JS semantics actually executed. A successful transpilation is not evidence that the runtime owns the resulting behavior. [R9], [R20]

---

## 6. Worked trace designs and the distinctions they preserve

These examples describe the intended granularity. They are deliberately small enough to become paired fixtures.

### 6.1 One fold across several implementations

Target source family: indexed `for`, matching `while`, eligible `for...of`, a pure helper variant, and an explicitly initialized `reduce`.

```text
total = fold_left([2, 3, 4], 0, (acc, x) => acc + x) => 9
return total
```

Reading: “Starting at zero, add the numbers in order; return 9.”

The initial profile should certify dense ordinary numeric arrays, the original order, and a non-mutating, non-throwing step. Preserve binary64 rounding and overflow. Later profiles can describe sparse traversal or effectful steps without pretending they are the same fold.

A builtin name is insufficient evidence: overwritten methods, callbacks inspecting indices, and mutations during traversal need separate treatment. [R3], [S3]

### 6.2 Defaults, nullishness, and laziness

For `x = 0`:

```text
a = x ?? 10 => 0
b = x || 10 => 10
c = default_undefined(x, 10) => 0
```

For `x = null`, the last expression yields `null`, while `x ?? 10` yields `10`.

These share a selection family but keep different predicates. Defaults and fallback bodies remain lazy. For `obj?.method(expensive())`, preserve whether the call and its arguments run, and preserve the method receiver when the call does run. [S2], [S5], [S7]

### 6.3 An effectful property access inside compact work

For a getter whose body increments a shared counter and returns a price, with `quantity = 3`:

```text
read account.price as price:
  write cell reads: 0 -> 1
  complete access with 20
total = price * quantity => 60
return total
```

The access result binds `price`; the captured-cell update remains part of the same checked access region.

The ordinary-data version can be a one-line projection. The getter version retains its observable state change. A proxy uses the same access family with an explicit trap boundary. Never silently re-read the property to validate or render it. [R10], [S6]

### 6.4 Shared closure state

For this function body:

```js
let count = 0;
const inc = () => ++count;
inc();
return inc();
```

A useful description is:

```text
inc captures cell count
call inc: count 0 -> 1; result 1
value = call inc: count 1 -> 2; result 2
return value
```

The call result is explicit: `count++` and `++count` can have the same state change and different results. If the closure and cell remain private and no observer distinguishes the intermediate state, a checked region can collapse further. If the closure escapes or becomes a retained callback, preserve the cell identity and its lifetime. Equal current values do not make two captured cells interchangeable.

### 6.5 Cleanup can replace an earlier completion

For this function body:

```js
try {
  return 3;
} finally {
  throw "cleanup";
}
```

```text
pending return 3
cleanup throws "cleanup"
throw "cleanup"
```

This uses a shared completion concept that can also support iterator closing and future resource-disposal features. The completion rules remain operation-specific; do not assume every cleanup operation has identical precedence. [S1], [S5]

### 6.6 Generators are computations with retained state

For a generator that yields 1 and then returns 2:

```text
resume g with next(undefined) => yield 1
resume g with next(undefined) => done 2
```

The surrounding definition contains the generator body; its local computations can themselves be compact regions. A bare list `[1, 2]` would lose the distinction between a yielded item and a terminal return, as well as possible resumed input, exceptions, and cleanup. [S4]

### 6.7 Concurrent requests retain causal order

For two reads started before joining their results:

```text
request r0: read("a")
request r1: read("b")
wait all [r0, r1]

observe r1 => fulfilled 20
observe r0 => fulfilled 10

total = r0.value + r1.value => 30
return total
```

The observation lines are environmental context, with no prediction loss. The compact join preserves both requests and their correlation; it does not claim they completed in request order. A serial pair of awaits must remain distinguishable.

A callback registration similarly cannot be summarized as “call completed” when its handler remains live. Collapse Promise/job mechanics only under a profile that preserves all permitted continuation behavior. [R1], [R7], [S4]

---

## 7. Repository implementation map

Use existing components as the integration points. New filenames below are suggested only where a distinct component would help.

| Work | Main existing locations | Deliverable |
| --- | --- | --- |
| Current coverage inventory | `src/training/capability-ledger.js`, `tools/generate-capability-ledger.mjs`, `coverage/` | Profile- and revision-bound ledger through compact/detailed/native/model stages. |
| Operation vocabulary | `src/semantic/operations.js`, `ir.js` | Registry metadata for domains, order, laziness, effects, completion, renderings, and consumer support. |
| Region composition | `program.js`, `compiler.js`, `lower-js.js`, `lower-effects.js`, `detailed-v7.js` | Source partitioning and checked local fallback; optionally factor a `regions.js` module. |
| Analysis and normalization | `normalize-algorithm.js`, `provenance.js`, `observables.js` | Effect/alias/liveness information, state joins, compositional receipts. |
| Compact language | `trace-codec.js`, `render-algorithm.js`, operation registry | Canonical compact grammar, tokenizer comparison, faithful concise readings. |
| Execution and continuation | `controller.js`, `harness.js`, `src/training/intent-journal.js` | Shared state across region kinds; checkpoint/resume and exactly authorized dispatch. |
| Source/runtime additions | `src/training/profile.js`, `src/frontend.js`, `src/runtime.js`, `src/values.js`, spec operations/validation | Qualified source constructs, Symbol/key representations, and owned protocols. |
| Independent evidence | `src/training/operation-reference.js`, `branch-reference.js`, `completion-reference.js`, `source-check.js` | Coverage of new intermediate claims, hooks, completions, and distinguishing observations. |
| Modules and TypeScript | `src/typescript.js`, `src/evaluated-modules.js`, module/session adapters | Shared binding/initialization semantics and generated-source provenance. |
| Native contract | `contracts/semantic-*.json`, contract generators, pinned `werg/megatoken` consumer | Matching operations, codec, contexts, continuations, malformed cases, supervision masks. |
| Data and measurement | `evaluation.js`, `comprehension.js`, `tokenizer.js`, `family-registry.js`, `dataset-v7.js`, `causal-lm-v7.js` | Reproducible coverage, cost, understanding, and model-execution reports. |

Registry metadata should be shared where useful; the independent semantic checker must retain an independently implemented execution/validation path. Automatically sharing the same faulty evaluator across producer and consumer would weaken the evidence.

Do not implement a feature merely by adding a renderer phrase. It needs a source path, owned meaning, correspondence evidence, public operation, and consumer behavior.

---

## 8. Evaluation: establish that the language is efficient and familiar

### 8.1 Extend the existing capability ladder

For every feature and interaction, record:

1. Frontend acceptance under the named source profile.
2. Owned execution.
3. Independent observable outcome agreement.
4. Independently checked intermediate/order/identity/completion coverage.
5. Compact-region recognition and its exact domain.
6. Positive normalization convergence and negative separation.
7. Detailed fallback validity.
8. Native admission under exact producer/consumer/contract/tokenizer pins.
9. Model comprehension, next-step accuracy, and completed execution.

Keep `passed`, `failed`, `unsupported`, `resource_limited`, and `untested` separate. A detailed fallback is useful execution coverage, but it is not compact coverage.

Report both whole-episode and local-region coverage. Also report what proportion of public tokens is still spent on detail. Improving many tiny arithmetic regions while callbacks dominate almost all tokens is not enough.

### 8.2 Freeze a broader benchmark before optimizing it

A proposed initial expansion benchmark should contain:

- **At least 20 new semantic feature-family groups**, beyond the current four compact equivalence families.
- **At least three equivalent source idioms where the concept has multiple forms**, plus edge inputs for each profile.
- **At least two independently executed distinguishing pairs for each new normalization rule**, supplemented by mutation tests and explicit refusal cases.
- **At least 12 interaction groups**, including the combinations in Wave D.
- A frozen, stratified real-source evaluation slice drawn from the existing corpus infrastructure, including current refusals and detailed fallbacks.

These are proposed scope targets, not measured coverage percentages. Deduplicate by family and report the real-source denominator before drawing conclusions. Retain the original 11-case gallery unchanged as a regression population.

Prioritize subsequent work using actual refusal frequency, detailed-token contribution, reuse across language features, and implementation risk. Do not grow the score mainly by generating more spelling variants of an already recognized sum.

### 8.3 Test notation without confounding semantics

Run three renderings of the same certified operations and the same public information:

| Arm | Form | Question |
| --- | --- | --- |
| Formal | Familiar infix, indexing, assignments, folds, calls | Is ordinary code/math notation shortest and well understood? |
| Hybrid | Formal expressions plus short behavior verbs | Do brief words improve ambiguous operations at acceptable cost? |
| Prose | Controlled natural language | Where does wording help enough to justify its cost? |

Then vary granularity separately: detailed steps, moderate regions, and larger certified operations.

Start with at least 200 predeclared semantic tasks across at least 20 families as a proposed initial study. Use a separate pilot to determine the final sample size and accuracy margin; 200 tasks is not assumed sufficient for a tight noninferiority claim.

Freeze evaluators, model versions/settings, prompts, examples, scoring, and acceptable accuracy margins before collecting results. Counterbalance task/notation assignments and option order. A model should not see one task's answer in another rendering and then be credited with independent understanding.

Keep the current canonical functional notation as a baseline. Include ASCII/Unicode alternatives only as measured subexperiments; mathematical elegance and tokenizer efficiency need not coincide.

### 8.4 Measure useful understanding and execution

Extend the existing source-free comprehension fixtures with:

- Algorithm and dependency identification.
- Which branch, callback, getter, or default expression executes.
- Counterfactual outcomes after changing an input.
- Which object or captured cell changes.
- Why a plausible compressed trace is incorrect.
- The next legal action before or after an external observation.
- The completion that survives cleanup.
- Generation of the next trace step and full execution under a fixed budget.

Multiple-choice recognition is a useful inexpensive screen. Next-step generation and selected execution are stronger evidence for the intended use.

Treat “in distribution for a code-and-language model” as an empirical design goal. Current renderer snapshots and tokenizer counts do not establish it. The repository already has comprehension tasks and a scorer; add actual external responses and their provenance. [R11]

### 8.5 Count the entire model interaction

Measure the actual flat causal-LM and native serving paths separately:

- Generated target tokens.
- Observed/context tokens actually presented to the model.
- Definitions, source, immutable inputs, live state, and routing.
- Framing, EOS, physical fragmentation, and repeated context.
- Peak context and cumulative context across prediction boundaries.
- Prediction count, verification overhead, latency, failures, and retries.
- Total tokens and latency per successfully completed execution.

The existing flat causal-LM resolver expands program and input references into full definitions on every request. A short public reference is therefore not automatically a cheap prompt. Instrument after the actual serializer and tokenizer, not only at the public JSON snapshot. [R12]

Do not report token components as additive when the tokenizer merges across their boundaries. Retain exact serialized inputs and whole-sequence counts.

### 8.6 Preserve causal and dataset integrity

For every new abstraction:

- Perturb future responses and require earlier public contexts and generated prefixes to remain identical.
- Keep environmental observations outside the prediction loss.
- Ensure every model-visible reference resolves from already published information.
- Preserve live state for all permitted continuations, not only the continuation observed in one completed trace.
- Keep private source/journal evidence and future outcomes out of prompts.
- Split family/lineage/normalized-core components before exporting variants.

The current family registry and causal export checks already provide much of this infrastructure. Extend them to new transformations and transpiled aliases. A “known algorithm, unseen spelling” diagnostic is useful, but must be reported separately from holding out an entire semantic family. [R7], [R13]

---

## 9. Delivery sequence and acceptance gates

Each milestone should produce a small reviewable implementation slice and a retained report. Pure `reduce`/map/search and broader pure selection can ship under existing compact profiles in parallel with the mixed-region work. Only extensions that require shared-state handoff or interleaving depend on M2. The region contract is the main architectural investment, not a prerequisite for every coverage improvement.

| Milestone | Work and concrete output | Gate before proceeding/promoting |
| --- | --- | --- |
| **M0 — Current baseline** | Extend the ledger to v7; reconcile documentation; freeze source/profile/consumer/tokenizer identities; regenerate the gallery and real-source slice. | Every attempt has a disposition; historical results remain separate; compact coverage and full serving-cost gaps are visible. |
| **M1 — Vocabulary and notation** | Extend registry metadata; implement formal/hybrid/prose experiments over unchanged cores; define region/completion interfaces. | Renderings preserve meaning; canonical codec round-trips; baseline understanding/cost results collected or explicitly unavailable. |
| **M2 — Compositional regions** | Compact–detailed–compact execution with shared state, including one getter or cleanup fixture; coordinated next-contract native support. | Correct live-state/alias mapping; stale entries rejected; local fallback; no duplicate effects; checkpoint/resume and future-prefix tests pass. |
| **M3 — Broad common algorithms** | Lazy selections/bindings, structured joins, general ordered folds, map/filter/search, multiple accumulators. | Equivalent idioms converge; executed near-misses remain distinct; real-source compact coverage improves. |
| **M4 — State, calls, and completions** | Ordinary properties, visible mutation, capture cells, receiver calls, try/catch/finally; qualified strict-frontend parity slices. | Independent state/call/completion evidence covers emitted claims; known callback-abrupt gaps have explicit dispositions. |
| **M5 — Exotic protocols** | Iterators/generators; construction/classes/private state; richer Promise/callback profiles. Deliver independent substreams incrementally. | Every substream passes protocol, identity, completion, causal, and native-consumer fixtures before admission. |
| **M6 — Composition and breadth** | Module/TS integration, feature interactions, selected collection/binary/RegExp expansions chosen from corpus demand. | Interactions retain semantics; full denominator and long-tail costs reported; family splits remain intact. |
| **M7 — Standard-format promotion** | Compare real model execution and total cost; regenerate/admit data; change the default producer/controller/serializer together. | Qualified supported slices meet correctness, comprehension, and cost criteria; remaining detail is explicit and locally bounded. |

**Suggested first pull requests:**

1. Current coverage ledger, documentation reconciliation, and exact baseline.
2. Operation metadata and notation/comprehension experiment.
3. Shared region/completion contract and one end-to-end mixed-region slice.
4. Ordered reduction with certified pure `reduce` plus map/search families.
5. Lazy binding/selection and ordinary visible-state/capture slices.
6. Cleanup and async branches over the new region infrastructure.

The first two can proceed alongside preparation of the third; pure parts of the fourth and fifth can also land without waiting for mixed-region execution. The order of later exotic substreams should follow measured corpus demand and shared dependencies, not an alphabetical syntax list.

### A feature is complete only when all of these are supplied

- Its supported source/profile/domain is explicit.
- It executes in the owned runtime and has the required independent evidence.
- Its concise operation/reading is defined and checked.
- Equivalent idioms and semantically different near-misses are tested.
- Its fallback, exception, and resource-limit behavior is explicit.
- The native consumer, contexts, continuation, and training masks agree.
- Its real-source coverage and total-token costs are recorded.
- Its understanding/execution result is measured, or clearly marked untested.

This should be one standard feature checklist attached to each slice, using existing machinery. Avoid proliferating separate ad hoc qualification systems.

---

## 10. Success criteria and decisions to lock early

### 10.1 Correctness is a hard gate

Require zero observed violations in the declared release suite for:

- False merges of meaningfully different programs.
- Incorrect emitted intermediate claims.
- Lost alias/capture/receiver distinctions.
- Changed observable effect order or multiplicity.
- Incorrect exception/cleanup/iterator completion.
- Future-observation leakage.
- Duplicate dispatch or invalid resumed state.
- Native/parser/continuation disagreement.

Report finite domains and denominators. Zero failures on a suite does not prove universal equivalence.

Independent execution must challenge the teacher, not merely replay its mistakes. Expand the existing authority matrix and teacher-mutation campaign as hooks, captured state, and richer scheduling become public claims. [R14]

### 10.2 Coverage must grow in breadth and composition

The first expansion release should satisfy the proposed family/interaction scope in §8.2 and demonstrate improved compact coverage on the frozen real-source population. Track regions, episodes, and token contribution separately.

A large count of parser-supported constructs or renamed synthetic examples is insufficient evidence of the desired improvement.

### 10.3 Efficiency must be measured at fixed usefulness

Use paired cost and success comparisons, with uncertainty intervals and predeclared acceptable regressions. Select the best tradeoff among total tokens, completed execution accuracy, and latency.

Do not force every trace to be shorter. A slightly longer expression that exposes necessary computation can be preferable to an opaque answer claim. The historical gallery already contains such cases. [R6]

### 10.4 Default promotion should be coordinated

Once qualified slices pass the gates:

- Make the compact semantic language the standard public producer/controller/serializer.
- Keep unsupported subregions explicitly detailed within the same versioned execution contract.
- Regenerate and readmit current training artifacts.
- Update examples and capability documentation from the same receipts.
- Keep learning claims separate from engineering and data-admission claims.

If a model study or full native cost run is unavailable, ship the implemented candidate slice with that evidence gap recorded; do not invent a result or stop unrelated coverage work.

### Decisions to make at the start

1. Adopt hybrid code/math notation as the default candidate, with controlled English as a faithful view.
2. Choose region composition as the main architectural investment.
3. Use the existing operation registry and qualification machinery as the common implementation path.
4. Prioritize broad descriptions of already-owned behavior before spending most effort on entirely new syntax.
5. Treat shared semantic operations as the unit of normalization, with explicit profiles for JavaScript-specific distinctions.
6. Evaluate actual comprehension and selected execution alongside total token cost.

The intended result is a trace such as “select a fallback, traverse in order, update a captured cell, wait for these requests, then complete with cleanup” expressed in a few familiar, checked operations. The language should be compact because it captures the right concepts and boundaries.

---

## Sources and evidence notes

Repository links below are pinned to the reviewed main revision. Source/code observations are current to that snapshot. Retained reports retain their own producing revisions. The plan's proposed vocabulary, targets, and milestones are recommendations rather than existing behavior.

### Repository

- **R1:** [Semantic algorithm contract][R1] and [implementation ledger][R1b].
- **R2:** [Program/profile selection][R2] and [compiler/fallback construction][R2b].
- **R3:** [Pure lowering][R3] and [serial-effect lowering][R3b].
- **R4:** [Canonical codec][R4], [controlled readings][R4b], and [typed IR][R4c].
- **R5:** [Strict training frontend][R5], [bounded frontend][R5b], and [owned runtime][R5c].
- **R6:** [Historical paired v7 measurements at e96dd4e][R6].
- **R7:** [Current v7 native integration][R7] and [training/export contract][R7b].
- **R8:** [Capability-ledger implementation][R8] and [retained v6 receipt][R8b].
- **R9:** [Evaluated module profile][R9] and [README][R9b].
- **R10:** [Owned object/proxy boundaries][R10].
- **R11:** [Comprehension fixtures][R11] and [scoring machinery][R11b].
- **R12:** [Actual causal-LM prompt resolver and encoder][R12].
- **R13:** [Family registry][R13] and [dataset pipeline][R13b].
- **R14:** [Independent semantic authority matrix][R14].
- **R15:** [Operation registry][R15] and [normalizer][R15b].
- **R16:** [Detailed-v7 representation][R16].
- **R17:** [Bounded for-of tests][R17] and [object-binding tests][R17b].
- **R18:** [Promise executor tests][R18] and [thenable/combinator tests][R18b].
- **R19:** [Semantic evaluation and cost accounting][R19].
- **R20:** [TypeScript adapter][R20].

### Semantic reference

Use the pinned ECMAScript 2026 edition for the initial feature checklist, adding explicit version/profile changes when the implementation targets later behavior.

- **S1:** [Abstract operations: conversion and iteration][S1].
- **S2:** [Expressions: calls, optional chains, and assignments][S2].
- **S3:** [Indexed collections: traversal and callback methods][S3].
- **S4:** [Control abstractions: iterators, Promises, and generators][S4].
- **S5:** [Statements and declarations: bindings and completion][S5].
- **S6:** [Ordinary and exotic object behavior][S6].
- **S7:** [Functions and classes][S7].
- **S8:** [Scripts and modules][S8].

[R1]: https://github.com/werg/tracing-js-self/blob/c165dad8e8226167ec1649cbe6d654cf8662aaf8/docs/SEMANTIC_ALGORITHM_CONTRACT.md
[R1b]: https://github.com/werg/tracing-js-self/blob/c165dad8e8226167ec1649cbe6d654cf8662aaf8/docs/SEMANTIC_ALGORITHM_IMPLEMENTATION.md
[R2]: https://github.com/werg/tracing-js-self/blob/c165dad8e8226167ec1649cbe6d654cf8662aaf8/src/semantic/program.js
[R2b]: https://github.com/werg/tracing-js-self/blob/c165dad8e8226167ec1649cbe6d654cf8662aaf8/src/semantic/compiler.js
[R3]: https://github.com/werg/tracing-js-self/blob/c165dad8e8226167ec1649cbe6d654cf8662aaf8/src/semantic/lower-js.js
[R3b]: https://github.com/werg/tracing-js-self/blob/c165dad8e8226167ec1649cbe6d654cf8662aaf8/src/semantic/lower-effects.js
[R4]: https://github.com/werg/tracing-js-self/blob/c165dad8e8226167ec1649cbe6d654cf8662aaf8/src/semantic/trace-codec.js
[R4b]: https://github.com/werg/tracing-js-self/blob/c165dad8e8226167ec1649cbe6d654cf8662aaf8/src/semantic/render-algorithm.js
[R4c]: https://github.com/werg/tracing-js-self/blob/c165dad8e8226167ec1649cbe6d654cf8662aaf8/src/semantic/ir.js
[R5]: https://github.com/werg/tracing-js-self/blob/c165dad8e8226167ec1649cbe6d654cf8662aaf8/src/training/profile.js
[R5b]: https://github.com/werg/tracing-js-self/blob/c165dad8e8226167ec1649cbe6d654cf8662aaf8/src/frontend.js
[R5c]: https://github.com/werg/tracing-js-self/blob/c165dad8e8226167ec1649cbe6d654cf8662aaf8/src/runtime.js
[R6]: https://github.com/werg/tracing-js-self/blob/c165dad8e8226167ec1649cbe6d654cf8662aaf8/docs/evidence/semantic-algorithm-v7/paired-e96dd4e/MEASUREMENTS.md
[R7]: https://github.com/werg/tracing-js-self/blob/c165dad8e8226167ec1649cbe6d654cf8662aaf8/docs/SEMANTIC_V7_NATIVE_INTEGRATION.md
[R7b]: https://github.com/werg/tracing-js-self/blob/c165dad8e8226167ec1649cbe6d654cf8662aaf8/docs/SEMANTIC_V7_TRAINING.md
[R8]: https://github.com/werg/tracing-js-self/blob/c165dad8e8226167ec1649cbe6d654cf8662aaf8/src/training/capability-ledger.js
[R8b]: https://github.com/werg/tracing-js-self/blob/c165dad8e8226167ec1649cbe6d654cf8662aaf8/coverage/current-v6.json
[R9]: https://github.com/werg/tracing-js-self/blob/c165dad8e8226167ec1649cbe6d654cf8662aaf8/docs/EVALUATED_MODULES.md
[R9b]: https://github.com/werg/tracing-js-self/blob/c165dad8e8226167ec1649cbe6d654cf8662aaf8/README.md
[R10]: https://github.com/werg/tracing-js-self/blob/c165dad8e8226167ec1649cbe6d654cf8662aaf8/docs/OWNED_OBJECT_INTERNALS.md
[R11]: https://github.com/werg/tracing-js-self/blob/c165dad8e8226167ec1649cbe6d654cf8662aaf8/fixtures/semantic-equivalence/comprehension.js
[R11b]: https://github.com/werg/tracing-js-self/blob/c165dad8e8226167ec1649cbe6d654cf8662aaf8/src/semantic/comprehension.js
[R12]: https://github.com/werg/tracing-js-self/blob/c165dad8e8226167ec1649cbe6d654cf8662aaf8/src/semantic/causal-lm-v7.js
[R13]: https://github.com/werg/tracing-js-self/blob/c165dad8e8226167ec1649cbe6d654cf8662aaf8/src/semantic/family-registry.js
[R13b]: https://github.com/werg/tracing-js-self/blob/c165dad8e8226167ec1649cbe6d654cf8662aaf8/src/semantic/dataset-v7.js
[R14]: https://github.com/werg/tracing-js-self/blob/c165dad8e8226167ec1649cbe6d654cf8662aaf8/docs/SEMANTIC_AUTHORITY_MATRIX.md
[R15]: https://github.com/werg/tracing-js-self/blob/c165dad8e8226167ec1649cbe6d654cf8662aaf8/src/semantic/operations.js
[R15b]: https://github.com/werg/tracing-js-self/blob/c165dad8e8226167ec1649cbe6d654cf8662aaf8/src/semantic/normalize-algorithm.js
[R16]: https://github.com/werg/tracing-js-self/blob/c165dad8e8226167ec1649cbe6d654cf8662aaf8/src/semantic/detailed-v7.js
[R17]: https://github.com/werg/tracing-js-self/blob/c165dad8e8226167ec1649cbe6d654cf8662aaf8/test/training-bounded-for-of.test.js
[R17b]: https://github.com/werg/tracing-js-self/blob/c165dad8e8226167ec1649cbe6d654cf8662aaf8/test/training-object-bindings.test.js
[R18]: https://github.com/werg/tracing-js-self/blob/c165dad8e8226167ec1649cbe6d654cf8662aaf8/test/owned-promise-executors.test.js
[R18b]: https://github.com/werg/tracing-js-self/blob/c165dad8e8226167ec1649cbe6d654cf8662aaf8/test/owned-promise-thenables-combinators.test.js
[R19]: https://github.com/werg/tracing-js-self/blob/c165dad8e8226167ec1649cbe6d654cf8662aaf8/src/semantic/evaluation.js
[R20]: https://github.com/werg/tracing-js-self/blob/c165dad8e8226167ec1649cbe6d654cf8662aaf8/src/typescript.js
[S1]: https://tc39.es/ecma262/2026/multipage/abstract-operations.html
[S2]: https://tc39.es/ecma262/2026/multipage/ecmascript-language-expressions.html
[S3]: https://tc39.es/ecma262/2026/multipage/indexed-collections.html
[S4]: https://tc39.es/ecma262/2026/multipage/control-abstraction-objects.html
[S5]: https://tc39.es/ecma262/2026/multipage/ecmascript-language-statements-and-declarations.html
[S6]: https://tc39.es/ecma262/2026/multipage/ordinary-and-exotic-objects-behaviours.html
[S7]: https://tc39.es/ecma262/2026/multipage/ecmascript-language-functions-and-classes.html
[S8]: https://tc39.es/ecma262/2026/multipage/ecmascript-language-scripts-and-modules.html

