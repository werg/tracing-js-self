# Implementation status (0.2.0)

## Bounded array-pair `for...of` bindings (October 23, 2026)

- Strict owned execution now accepts `for (const/let [a,b] of rows)` for bounded arrays of ordinary array items, with separately initialized per-iteration lexical cells and captured closure identities. It retains the prior dense-array-only for-of profile; nested/default/rest/elision patterns, `var` array bindings, shadowed Array and arbitrary iterables remain unsupported. Native V8 differential tests and exact archive replay cover the accepted slice, not general iterator/destructuring semantics.

## Durable replay-backed module session checkpoints (October 23, 2026)

- The opt-in Node/POSIX storage package now writes content-addressed immutable checkpoints of **committed** bounded evaluated-module-session histories, with structural snapshot validation, full interpreter re-execution before publication and on restore, SHA-256 integrity checking, fsync and atomic no-replace hard-link publication. Restores build new module cells and host output identities. It does **not** checkpoint a suspended VM, native callbacks, open handles or natlang's production callable-folder Module Record; it cannot establish a production-compatible persistent realm by itself.

## Bounded owned TypeScript array bindings (October 23, 2026)

- Strict-profile `let`/`const` array destructuring of 1–32 simple identifier slots now accepts standard owned arrays. The initializer executes once; owned indexed reads and lexical initializations are individually traced. Nested/default/rest/elision targets, `var` patterns, string iteration and other non-array iterables remain unsupported. It does **not** implement the complete ES iterator protocol or general TypeScript execution compatibility.

## Native effect archive-completeness and service-registration guard (October 23, 2026)

- The bounded opt-in native driver rejects proxy/getter-based service registries before guest execution and prevents queued native dispatch from starting after the driver has exited. A completed driver result may not publish an archive with outstanding native effects; successful results must account for effect arrivals and pass existing exact replay checks. This guards a narrow asynchronous host boundary, **not** Node/browser API completeness, cancellation of already-started effects, or guest timer semantics.

## Bounded owned TypeScript object bindings (October 23, 2026)

- One-initializer `const`/`let` object-pattern declarations now lower through
  explicit owned property reads and lexical initializations, retaining
  source-order reads, alias identity, replay and independently checked V8
  observable results. Only simple identifier targets with static keys
  (at most 32) are accepted; destructuring defaults, nested/computed/rest
  patterns and `var` object bindings fail closed. This does not establish
  general TypeScript execution compatibility.

## Native-service deadline boundary (October 23, 2026)

- The opt-in natlang `executeAsync` native-service route now accepts a
  bounded host-owned `timeoutMs` deadline (1–300000 ms). Its composed
  AbortSignal reaches registered native services, releases deadline timers
  and abort forwarding on every exit, and emits no successful trace after a
  deadline abort. This does not preempt synchronous guest CPU, roll back
  an already-started native side effect, reproduce wall-clock time in guest
  code, or implement general Node/browser timers and scheduling.

## Bounded owned optional chains (October 23, 2026)

- Pinned TypeScript lowering preserves ES2022 optional chains for strict
  owned execution. The Acorn-to-bytecode frontend now supports nullish
  short-circuit across ordinary/computed property accesses, ordinary method
  invocation after an optional receiver, and optional calls to direct guest
  function values. Guest execution skips unreachable property keys, arguments
  and entire suffixes, with independent Node V8 differential/replay tests.
- Receiver-aware optional member invocation (`object.method?.()`) now tests
  the callable payload of the owned method token and preserves its `this`
  receiver. This slice is **not** full JS/TS conformance, a persistent
  natlang callable-folder module realm, general Node/browser host support,
  nor independently admitted megatoken training data.


## TypeScript nullable-access and host abort hardening (October 23, 2026)

- Host-side pinned TypeScript 5.9.3 lowering now conditionally expands optional property/computed access to ES2019 temporaries and branches before strict owned compilation. New V8 graph-differential and exact replay regressions cover present/absent receivers and short-circuited computed keys. Emitted constructs outside the strict profile, including many optional method calls, still fail closed: **not general TypeScript execution compatibility**.
- The journaled native driver now refuses to start a queued service after its AbortSignal has fired and ignores cancelled arrivals; services already started still own their effects. This is **not full Node/browser host semantics**.
- The production natlang callable-folder module realm and native module-helper/callback boundary remain unsupported. This update does **not** implement a durable live VM, full persistent Module Record, language conformance or production drop-in replacement. Release eligibility remains false.

This repository implements a **bounded, executable prototype** for the architecture in the attached *Complete JavaScript Semantic Tracing Runtime, revision 2 (22 October 2026)*. It does **not** implement the complete plan or claim a complete ECMAScript/Node/browser profile. In particular, a passing prototype test is not a Test262, WPT, Node-API, or learning-evaluation result.

## Retained-session replay-authority and commit hardening (October 23, 2026)

- The bounded replay-backed evaluated-module session now keeps its committed
  invocation history, host output identities and serialization queue private.
  The public history is a detached data view; module source configuration and
  step budget cannot be replaced after construction. An out-of-range step
  budget fails before any guest evaluation.
- Output reconciliation rejects a non-writable host array length during the
  preflight stage, before committing changes to other returned host data
  objects. Dedicated regressions cover attempted history rewriting, replay
  configuration mutation, a multi-object partial-commit hazard and closing.
  This strengthens **observational** replay integrity, not durable VM
  continuations, general modules, arbitrary JS/TS execution or native hosts.

## Bounded sealed-archive persistence (October 23, 2026)

- The opt-in Node/POSIX package entry [durable storage](DURABLE_STORAGE.md)
  persists **sealed** JSON semantic-tracing-run/2 bundles by their SHA-256
  content ID. Publication uses a file fsync, atomic no-replace hard link and
  directory fsync. Independent structural validation and same-interpreter
  exact replay are mandatory both before publication and on reads.
  Concurrent identical writers converge on one object; corruption, symlinks
  at the final path and unverified bundles fail closed. This facility does
  **not** durably checkpoint a running interpreter, recover a live module
  realm, stream journal entries, own browser/Node APIs or prove language
  conformance. It leaves model-data admission unchanged.

## Cross-repository semantic Episode contract repair (October 23, 2026)

- The diagnostic `semantic-execution/2` consumer in `werg/megatoken` had
  an out-of-date effective-record field allowlist, causing the current tracer
  emitter to fail the pinned native-import GitHub Actions step despite passing
  local replay and reference audits. The consumer now recognizes the emitted
  bounded `randomSeed`, `staticRegExps`, `rest`, multi-binding `copies`,
  call `allocations`, and return `writes` fields, with malformed-extension
  rejection and byte-preservation tests. The tracer's consumer workflow pins
  the corresponding megatoken revision `986b9fce23f3343a8808c82b8ed330f644e07469`.
- This is **schema compatibility for locally verified diagnostic Episodes**,
  not independent corpus admission, native runtime replacement or model
  training proof. The producer's generated corpus still reports `admitted=0`.
  The cross-repository workflow must succeed on the new pin before relying on
  this integration as passing evidence.

## Bounded October 23 additions (not a universal runtime)

- Strict Acorn guest entries can execute owned async function declarations and
  `await` on owned promise jobs, while record/replay rebuilds the root promise
  state rather than adopting a native host Promise. Optional explicitly
  registered `demo.*` services are dispatched through the separate native
  driver, with effect intent, arrival, delivery and no replay re-invocation.
  The strict host binding is absent without this explicit grant.
- Natlang's adapter now supports **data-only** mutable `__live` scopes and an
  explicitly bounded `retained` module data shape (`module.exports` /
  `exports`). After a validated and exactly replayed guest evaluation, the
  adapter reconciles ordinary mutable host data graphs with their owned
  counterparts, retaining existing object aliases. Native host objects,
  functions, package imports, callable-folder module caching/closures and
  callback reentry remain unowned and rejected. The regular natlang
  `setModuleRealm` production seam is **not yet integrated**.
- Bounded `Object.values`, `Object.entries` and `Array.prototype.at`
  now join the existing ordinary-data built-ins, with local Node V8
  differential assertions and archive replay. Exotic cases continue to
  fail closed; these methods are not evidence of complete ECMA-262 built-ins.
- Bounded [ordinary-data built-ins](BOUNDED_BUILTINS.md) now include
  `Object.assign` on owned ordinary targets/sources and the dense-array
  `reverse`, `fill`, `copyWithin`, `toReversed` and `with` methods.
  Existing array/string, callback and object-internal-method slices remain
  explicitly bounded. Completed runs are covered by V8 differential probes
  and exact archive replay; unsupported coercions/exotics fail closed. These
  extensions do not satisfy the complete ECMAScript intrinsic inventory.
- The original `tracing-js-self/modules` linker remains function-only,
  but the separate [bounded evaluated ESM graph](EVALUATED_MODULES.md)
  (`tracing-js-self/evaluated-modules`, `evaluated-module/1`) now instantiates
  an explicit acyclic in-memory graph and executes supported top-level
  initializers once per episode. Named imports and re-exports alias the
  originating mutable owned lexical cell, including `let` writes observed
  after imported guest calls. Owned top-level `await` and optionally journaled
  native-service completions participate in exact replay. An optional
  ordered `calls` array now invokes multiple exports in one owned episode,
  preserving mutable module cells and guest heap aliases until it completes.
  State is **not retained across separate API calls**. Synchronous cyclic
  evaluation now follows dependency DFS ordering and has independent native
  ESM differential/replay probes; cycles containing top-level await remain
  unsupported. Namespace-style statically named import reads are rewritten to
  live export cells, but actual module namespace exotic objects, namespace
  method receivers and reflection remain unimplemented. Arbitrary package
  imports and physical suspended/serialized module realms remain unimplemented.
  The separate replay-backed `evaluated-module-session` API now maintains
  **observational** per-session module state and stable returned ordinary
  data-object identities across up to 32 deterministic primitive-argument
  invocations by replaying the complete history without native effects. It is
  neither a durable VM continuation nor a general persistent ESM Module Record.
  The data-only natlang retained adapter is a different, limited interface.
  A JSON-portable snapshot/restore API now reconstructs committed bounded
  module invocation histories in a new process with tagged primitive arguments
  and replay verification. It recreates observational state and fresh host
  identities; it does not persist or restore a suspended owned VM, general
  native host handles or natlang's real retained Module Record seam.
- The `werg/natlang` Node runtime now has an explicit opt-in
  `installOwnedTracingEnvironment(factory)` installer, wiring **both** its
  per-task and retained module-evaluator factories with a fail-closed
  `owned-*` authority check. This is actual host-side wiring, **not**
  application compatibility: callable-folder compiled modules still pass
  native `require`, package helpers, `nl`, callbacks and service objects not
  executable by the bounded tracer. Production drop-in compatibility remains
  unproven and is not enabled as the default.
- Verification is finite, not a language-completeness, Test262, WPT, native
  host capability or megatoken model-training result. Check the most recent
  `main` GitHub Actions run before treating the extension as a green release.

## What runs

- Explicit bytecode evaluator; its guest continuation, operand stack, environments, closure bindings, heap objects, promise states, suspension and job queue are serializable records. No native `eval`, `vm`, `Function` constructor, or `require` executes guest code **inside the owned tracer**. The independent bounded training reference intentionally executes fixture code in Node `vm`, outside the traced authority.
- **Owned arithmetic and bounded ordinary object coercion:** `+`, `-`, `*`, `/`, `%`, `**` execute through serializable `ApplyStringOrNumericBinaryOperator` phases, recording conversions, numeric-type checks, scalar leaves and completions. A new `OrdinaryToPrimitive` sub-continuation handles owned ordinary-object/array references, own-data `valueOf`/`toString` methods, modeled Object default methods and primitive dense-array stringification. Guest conversion functions execute as owned invocation frames with the correct `this` receiver; method lookup, call, return and abrupt completion have typed, versioned operation commands and independent structural validation. Inherited ordinary data conversion methods are now owned and validated. Accessor-returned conversion functions, proxy-based coercion, symbols and complex array join still fail closed. See [owned arithmetic](OWNED_ARITHMETIC.md).
- The original `bounded-js-subset/2` script path has a purposely restricted JavaScript grammar: numeric/string/boolean/null/undefined/BigInt literals, `let`/`const`/`var` (restricted semantics), blocks, `if`, `while`, function declarations, returns, ordinary calls, `async function`, `await`, primitive arithmetic/comparison/logical operators, direct property reads/writes, and basic dense array/object literals. This parser has no ASI; the separate strict Acorn training frontend is described below. Unsupported syntax is refused.
- A mock host bridge for `host.readAsync`, `host.readNumber` and `host.store`, with recorded dispatch intent before adapter invocation; independent nonblocking promise return and later completion; explicit host input **arrival** vs **delivery**; synchronous calls wait for their actual outcome even when its result is unused. Native transport promises are forbidden as guest continuations. An opt-in [Node native-service driver](NATIVE_HOST.md) now invokes real asynchronous services through this declared three-operation boundary, commits arrival separately from guest delivery, and validates/replays the archive without invoking those services again; native resource ownership remains outside the tracer.
- One ordered authoritative journal of instruction and spec-phase events with source sites, producer links, read observations, typed operation commands and entity-replacement patches with version preconditions; records can be reconstructed without invoking the evaluator.
- Accumulation of effects and permitted internal microtask resumption into a chunk, without token-budget cuts. A reference demo produces three chunks with A/B dispatch, B completion first, A second, and a single store of `35`.
- Read-only structural validator, state reconstruction, and a **limited** causal interleaved projection that hides host arrival payloads and full archival state until delivery. The validator cross-checks start/end host tables, chunk indexes and pending summaries, plus the bounded host effect/input creation–dispatch–arrival–delivery lifecycle; the runtime rejects second arrivals for single-outcome effects. Private input perturbation and hostile-archive corruption regressions included.
- Deterministic **bounded-interpreter** replay: recompile archived sources (never trust archived bytecode for execution), inject only recorded external inputs, and compare every regenerated semantic event, patch, checkpoint, chunk boundary and termination category. Replay installs no host adapters; corruption tests cover semantic results, provenance and source changes.
- **Bounded prototype/accessor/Proxy internal methods:** `Object.create`, `Object.getPrototypeOf`, `Object.setPrototypeOf` and ordinary prototype-chain data reads preserve owned identities and inherited method receivers. `Object.defineProperty` handles accessors through owned getter/setter callback frames. The bounded script parser understands `new Proxy(target,handler)`; owned `get`/`set` trap callbacks and transparent forwarding work for ordinary data objects. These are **not** general `[[Get]]`/`[[Set]]`/`[[DefineOwnProperty]]` or Proxy invariants. Differential V8 and replay regressions cover the named slice. See [owned object internals](OWNED_OBJECT_INTERNALS.md).
- **Owned Promise reaction jobs (bounded callbacks):** `then`, `catch`, and `finally` enqueue serializable callbacks (including guest async frames), missing-handler propagation, settled/pending adoption, cycle rejection, and cleanup that waits for returned owned promises. `await` and reactions share FIFO registration order; replay reconstructs queued work. Not complete ECMAScript Promise behavior. See [reaction coverage](PROMISE_REACTIONS.md).
- **Bounded guest completion and rejection propagation:** `try/catch/finally`, cross-function throws, `return` and `while` `break/continue` through finally, plus arithmetic TypeError/RangeError, selected reference/TDZ/const/call/null-property/array-length faults, synchronous external failures, and conversion-method throws. Async function abrupt completions reject owned promises; `Promise.reject`, settled rejection adoption, rejected host-promise delivery and `await` catch/finally paths preserve guest identity and rejection provenance. Archive reconstruction and exact adapter-free replay cover these paths. Synthetic Error instances are bounded data objects with `name`/`message`, not complete ECMAScript Error exotics. Unexpected/unclassified interpreter faults remain native diagnostics. See [completion control](COMPLETION_CONTROL.md).
- Separately pinned **engine262 reference oracle** and 14-file SHA-verified Test262 **syntax-only** baseline (plus 12 pure scalar differential probes). These do not execute Test262 tests through the tracer, count as full conformance or change the authoritative trace engine. See [adoption audit](ENGINE262_ADOPTION.md).
- **1,958 owned-arithmetic differential cases** against the pinned engine262 oracle: 1,433 normal and 525 abrupt results, each reconstructed and replayed after JSON serialization. The finite corpus is not exhaustive semantic proof.
- The existing **11-file selected Test262 sloppy-script execution** ledger retains explicit passes, known failures and skips. Selected implicit runtime faults now yield replay-verified owned completion evidence; unclassified interpreter failures still remain diagnostics, not fabricated conformance.
- A separate **eight-file pinned Test262 execution slice** now executes unchanged official bodies through a small guest-written scalar assertion harness: six non-strict variants pass with 16 assertions; two unsupported variants and eight omitted strict variants remain explicit. This is not the complete official harness or a full Test262 conformance result. See [execution evidence](TEST262_RUNTIME_SLICE.md).
- A reproducible, full **declared textual scan of the pinned engine262 source tree**: 377 files, 2,028 named function-declaration candidates, 1,845 literal spec references and 157 intrinsic-name literals. Five declarations and 17 references map to the partial arithmetic path. New/changed/unclassified entries fail audit. This is not a full normative clause/intrinsic installation inventory. See [inventory](ENGINE262_INVENTORY.md).
- **Opt-in natlang evaluator shape for the strict training profile:** `tracing-js-self/natlang` exports `createBoundedNatlangEnvironment`, which accepts natlang's actual `EvalFailure` class, lowers TS syntax through pinned TypeScript 5.9.3 to ES2022, requires the emitted JS to pass the owned `training-js/1` frontend, supports portable `self` graph input, independently validates and exactly replays the resulting archive, and exposes generated-JS/source-map provenance through a separate `onTrace` argument. `execute`, `executeAsync`, `fork`, and `close` work for completed synchronous cases without a host execution fallback. This is **not** natlang's general TS evaluator or module realm: full TS emitted-JS coverage, type checking, live bindings, native timeouts, async guest code and module helpers remain unsupported. See [natlang integration](NATLANG_INTEGRATION.md).
- **Static ESM/TypeScript function graph (`static-module/1`):** `tracing-js-self/modules` compiles supplied TS/ES2022 sources and links named/default function exports, aliased imports, named/star re-exports with function-identity ambiguity checks, and function-only cycles into one owned strict training entry. Module-relative source graph resolution is deterministic; object shorthand keys remain stable across linked function renaming. Unprovided native packages, executable top-level initialization, mutable exports, namespace objects and dynamic imports fail closed. Inert side-effect-only imports and TypeScript-elided runtime dependency edges are explicitly visited and validated, but they do not enable module side-effect evaluation. All guest function calls run through the owned VM, with independent V8 differential, archive reconstruction and replay checks. Module/source-map linkage metadata is kept separate from the replay authority. This is **not** full ECMAScript module evaluation or natlang's retained module realm. See [static modules](STATIC_MODULES.md).
- **Named deterministic built-ins:** bounded `Math` scalar numeric leaves, `Number.is*` predicates, proxy-aware `Array.isArray`, `Object.is` SameValue identity and signed-zero behavior, ordinary `Object.hasOwn`/`Object.keys`, and dense `Array.prototype.push`/`pop`/`includes` with bounded SameValueZero and fromIndex semantics, versioned heap writes and V8 differential probes. Accessors, Proxies, coercion side effects, sparse arrays and other exotic cases remain unsupported where required.
- Package-root JavaScript ESM exports with embedded execution/host-delivery/replay tests. The pinned [natlang/megatoken integration audit](NATLANG_INTEGRATION.md) identifies both natlang evaluation seams and preserves the distinction between semantic chunks, physical parts and causal visibility.

## Strict synchronous training foundation (additional bounded profile)

The `training-js/1` profile provides integrity-locked Acorn 8.15.0 ES2022 strict
parsing with a syntax/operation allowlist, exact function entry, stable argument
graphs, reference identity/array semantics, journal normalization,
`semantic-trace/2` serialization, deterministic serial model groups and a local
differential Node V8 `vm` comparison. Its runtime shares the bounded owned arithmetic and ordinary-data coercion
phase paths. The training profile accepts only synchronous, effect-free,
non-throwing entries; committed terminal guest throws in the common runtime do
not enable an exception-training category.

The strict frontend now parses explicit throw/try/catch/finally and runs them through existing owned completion-handler bytecode. A caught guest throw can be reconstructed/replayed in the opt-in natlang evaluator, but the model-serving controller still lacks resumable caught-throw semantics, so these episodes do not pass training-data admission. This is not full Error/exception conformance.

The strict frontend additionally supports multi-declarator let/const, object-literal shorthand, sequence expressions and expanded scalar compound assignments, with retained owned evaluation order and independent source-expression V8 receipts. It does not implement destructuring, general spreads or native bindings.

Opt-in natlang regression coverage now independently runs pinned-TypeScript-emitted JS against V8 and compares complete reachable output/input graphs with the serialized owned trace across selected scalar, lexical, control, closure, template and caught-throw cases. This evidence checks generated-JS semantics of the named subset only; it is not an application-level drop-in acceptance test.

Opt-in natlang `onTrace` metadata now includes mapped original-TS source anchors for generated owned code sites and explicitly unanchored sites. This separately checks TypeScript's V3 source-map source bytes and does not upgrade generated-JS provenance to proved original-TS semantic mapping.

The opt-in synchronous training frontend additionally compiles simple arrow and anonymous function expressions to owned serializable closure objects and call frames, with independent V8 observable-graph checks. Lexical `this` values are retained on arrow closures; the training syntax still excludes `this` reads, rest/default/destructured parameters, and async arrows. These are incremental TS/natlang improvements, not drop-in coverage.

The strict frontend also supports owned primitive-substitution JavaScript template literals (with V8 checked interpolation order and final intermediate result), including TS-lowered template syntax in the opt-in natlang adapter. Object-valued template coercion and tagged templates still fail closed.

The strict training frontend also accepts scalar bitwise/shift operators, unary `~` and `void`, and `typeof unresolvableName` as `undefined` while preserving TDZ faults for existing uninitialized bindings. Differential V8 scalar-expression receipts and exact replay cover this bounded slice; broad object coercion and unrestricted JS/TS remain unsupported.

The strict training frontend also supports common bounded control flow:
ternary selection, `for` (one initialized `let` binding or expression init),
`do…while`, loop `break`/`continue`, and prefix/postfix `++`/`--`
on lexical identifiers. Updates execute a scalar ToNumeric conversion and
record one versioned read/write step, including the expression's returned
old/new numeric value. Node V8 independently observes the executed update
expression at the source site; replay and serialization independently check
the owned path. `for (let ...)` creates fresh serializable per-iteration
environments for captured closures, including `continue` into the update
clause. Computed member `++`/`--` and `+=`/`-=` evaluate the member
reference once; scalar member updates preserve the prior numeric value for
postfix expressions, record versioned reads and writes, and undergo source-
instrumented V8 result comparisons. Object-valued update coercions,
accessor/Proxy update continuations, full object descriptors and unusual
receiver semantics still fail closed. This is a bounded profile extension,
not whole-language conformance or training-data admission.

A separate source-instrumented V8 run now compares **executed scalar unary/binary/compound-assignment values at each source occurrence**, including overwritten intermediates, with the owned journal's source sites. The uninstrumented and instrumented final observable graphs must agree. Other semantic families and spec phase internals are explicitly unverified; this is neither full intermediate-state proof nor model-data admission.

An independent V8 **control-decision audit** checks executed if, loop, ternary and &&/||/?? short-circuit branch decisions in source order. Mismatched, missing or excess decisions fail closed before candidate training verification; this does not establish whole-language semantics or training admission.

The bounded mock host bridge now dispatches only **versioned, immutable `canonical-json/1` request payloads**, materialized from the committed graph before the adapter sees them. Its journal independently checks the exact JSON bytes, operation signature, and historical graph versions. Adapters receive frozen plain JSON data; original guest tags remain only in the private journal. Fulfilled/pending guest-promise adoption regressions also exist. The deterministic fixture generator emits candidate
`semantic-execution/2` episodes with a private audit sidecar and reports
**locally verified**, with **admitted=0**. A separate post-serialization V8 evidence recheck now recomputes the reference graph, scalar operation receipts and executed control decisions from the archived source/initial graph; it does not confer production admission. These are not accepted megatoken training
examples. Causal source bundling, liveness-based compaction, automatic corpus segmentation, and actual trained-model rollout evaluation remain open. A bounded selected-trace controller and a cross-repository megatoken adapter are implemented, with diagnostic rather than production admission. Serving-side selected-event commits now roll back on rejection, and an unterminated model-selected rollout is marked invalid. A public-only causal-order audit now checks observed source/input publication and graph-reference closure, explicit event dependencies, chronological producer identities, synchronous call/entry/return ownership and root completion, same-lane and same-mode fragments, and terminal ordering independently of private journal/replay. This audit is not a full transitive information-flow or ECMAScript correctness proof. See [TRAINING_IMPLEMENTATION.md](TRAINING_IMPLEMENTATION.md) for the
implemented interfaces and admission gates.

## Not implemented (must not be inferred)

- Full ECMAScript language and all abrupt completion sources (including arbitrary implicit/native errors), full object internal methods/ToPrimitive (including symbols, accessor-based coercion, most Proxy traps/invariants, data descriptors and exotic object semantics), sloppy global `this`, full Error objects, generators, dynamic source, general ECMAScript module evaluation beyond the function-only `static-module/1` linker, and built-ins beyond the named subset. Arithmetic plus bounded ordinary object coercion have owned spec phases; completion routing is still a bounded bytecode mechanism, not independent full-language spec evidence.
- All of ECMA-402, full TypeScript semantic/type-checker/source-map correctness or general TS emitted-JS execution beyond the pinned syntax-lowering slice, Node built-ins, browser/Web IDL/native hooks, typed native handoffs, true native activation ownership, buffer/agent/GC semantics, native resource restoration or real host scheduling.
- Full Section 29 normative catalog schemas: `catalog/operations.json` is a narrow indexed vocabulary only, not conformance evidence.
- Independent/specification-level semantic replay, native side-effect/resource replay, *general* guest-visible exception delivery, closed canonical reference fixtures, full transitive model-visibility proofs, release locks, accepted budgets, or learning improvements. The structural validator proves **state reconstruction and structural invariants**. Optional bounded replay proves that this same interpreter can reproduce the journal under recorded inputs; neither check proves ECMAScript correctness.
- Incremental execution-journal durability/live-VM crash recovery, streaming storage/backpressure, globally consistent runtime checkpoints, and broad native integrations beyond the declared bounded Node service transport. Sealed-bundle archive persistence is separately implemented but does not address these gaps.
- No general engine262 replacement: engine262 remains an untraced, opt-in external oracle; the bounded arithmetic and ordinary coercion phases are an in-repository owned implementation following its pinned algorithm structure. The complete normative clause/intrinsic inventory and official Test262 runtime harness remain open.
- An opt-in strict-profile `EvalEnvironment` facade with pinned TypeScript transpilation/source-map **metadata** exists, but there is no general natlang evaluator/module-realm replacement, persistent callable-folder module realm, native callback ownership or proven original-TS semantic site mapping. Data-only live natlang bindings and bounded mutable ESM aliases do not satisfy those broader contracts. The candidate training exporter now has a separately tested megatoken-native Episode adapter and explicit teacher-conditioned training path, but there is still no independently admitted corpus or measured trained-model correctness. Package-root imports do not imply application compatibility.

The VM still copies machine-state tables on each transaction. The operation continuation table (including coercion method continuations) uses typed commands; existing tables still use **entity replacement**. This is neither a production storage scheme nor the finished fine-grained mutation algebra. String-to-number conversion, Number formatting and typed scalar arithmetic remain declared host primitive leaves.

New archives use `semantic-tracing-run/2` and exact replay `/2`; the language
profile is `bounded-js-subset/2` or `training-js/1` according to the entry path.
The structural validator retains `/1` reconstruction; exact replay explicitly
requires `/2`. `releaseEligibility` and all complete-language/host flags remain
false.

## Next implementation sequence

The [semantic execution training-data plan](TRAINING_DATA_PLAN.md) sets the immediate priority: a verified bounded training generator with one compact semantic target and a causal megatoken exporter. The first bounded synchronous foundation is partially implemented (see above); subsequent megatoken, continuation, async and engine-coverage milestones remain planned work.

1. Close the synchronous profile's admission gates with independent completion/observable-graph checks and intermediate semantic coverage. Preserve strict parsing, exact function entry and identity; fix or reject known semantic divergences. The owned arithmetic phases and their differential probes strengthen this foundation, but replay alone remains insufficient.
2. Complete the compact semantic target and preservation checks over invocation, source-site, control, value, read/write and completion records. Preserve result and producer links across the new spec-phase events; add static conservative liveness/def-use compaction without selecting targets from future answers.
3. Implement causal source bundles, helper inlining, bounded reusable tracks, model chunk boundaries, and exact continuation packets. Keep model cuts separate from guest scheduling and host service points.
4. Connect the candidate exporter to megatoken's actual Episode/schema and training interfaces, teacher-conditioned supervision and generated-state rollout verification; then admit the first synchronous corpus. Preserve logical event identities across physical splits and independently check causal visibility. A bounded profile must pass its semantic and visibility gates; full Node/browser coverage is not a prerequisite.
5. Extend the now-implemented bounded JSON mock-host request dispatch to formally admitted external episodes; expand thenable assimilation, Promise constructors/combinators and native scheduling beyond the owned reactions/await slice, and expand synchronous catch/finally to general guest abrupt completions under separately validated profile extensions. Implement both natlang evaluation seams against actual generated scope/module code before claiming application compatibility.
6. Scale journal/export storage and broaden spec-backed owned execution to bindings, complete property descriptors, accessor/proxy conversion continuations, internal-method invariants and observable coercion beyond the newly owned ordinary-data path. Extend typed commands beyond the operation table, preserve versioned replay/causal contracts, and upgrade the textual inventory to full normative clause/intrinsic coverage. Native activation ownership, durable recovery, real Node/browser services, independent specification-level replay and the full strict/module/async/negative Test262 harness remain broader-target requirements in [engine262 adoption](ENGINE262_ADOPTION.md).

The unresolved required families remain explicit in `coverage/required.json`;  the demonstrator's profile is intentionally different from the plan's completed target.


The model-facing format is [effective semantic-trace/2](EFFECTIVE_TRACE.md); it captures actual computation without reconstructing hidden prototype/accessor internals. No legacy format adapter is supported.
