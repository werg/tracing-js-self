# Implementation status (0.2.0)

This repository implements a **bounded, executable prototype** for the architecture in the attached *Complete JavaScript Semantic Tracing Runtime, revision 2 (22 October 2026)*. It does **not** implement the complete plan or claim a complete ECMAScript/Node/browser profile. In particular, a passing prototype test is not a Test262, WPT, Node-API, or learning-evaluation result.

## What runs

- Explicit bytecode evaluator; its guest continuation, operand stack, environments, closure bindings, heap objects, promise states, suspension and job queue are serializable records. No native `eval`, `vm`, `Function` constructor, or `require` executes guest code **inside the owned tracer**. The independent bounded training reference intentionally executes fixture code in Node `vm`, outside the traced authority.
- **First owned spec-operation path:** primitive `+`, `-`, `*`, `/`, `%`, `**` now execute through serializable `ApplyStringOrNumericBinaryOperator` phases, separately recording conversions, numeric-type checks, scalar leaves and completions. The new operation table uses typed create/advance/complete commands with version preconditions and independent structural validation. Other tables still use entity replacement. See [owned arithmetic](OWNED_ARITHMETIC.md) for host-leaf and domain limits.
- The original `bounded-js-subset/2` script path has a purposely restricted JavaScript grammar: numeric/string/boolean/null/undefined/BigInt literals, `let`/`const`/`var` (restricted semantics), blocks, `if`, `while`, function declarations, returns, ordinary calls, `async function`, `await`, primitive arithmetic/comparison/logical operators, direct property reads/writes, and basic dense array/object literals. This parser has no ASI; the separate strict Acorn training frontend is described below. Unsupported syntax is refused.
- A mock host bridge for `host.readAsync`, `host.readNumber` and `host.store`, with recorded dispatch intent before adapter invocation; independent nonblocking promise return and later completion; explicit host input **arrival** vs **delivery**; synchronous calls wait for their actual outcome even when its result is unused. Native transport promises are forbidden as guest continuations.
- One ordered authoritative journal of instruction and spec-phase events with source sites, producer links, read observations, typed operation commands and entity-replacement patches with version preconditions; records can be reconstructed without invoking the evaluator.
- Accumulation of effects and permitted internal microtask resumption into a chunk, without token-budget cuts. A reference demo produces three chunks with A/B dispatch, B completion first, A second, and a single store of `35`.
- Read-only structural validator, state reconstruction, and a **limited** causal interleaved projection that hides host arrival payloads and full archival state until delivery. The validator cross-checks start/end host tables, chunk indexes and pending summaries, plus the bounded host effect/input creation–dispatch–arrival–delivery lifecycle; the runtime rejects second arrivals for single-outcome effects. Private input perturbation and hostile-archive corruption regressions included.
- Deterministic **bounded-interpreter** replay: recompile archived sources (never trust archived bytecode for execution), inject only recorded external inputs, and compare every regenerated semantic event, patch, checkpoint, chunk boundary and termination category. Replay installs no host adapters; corruption tests cover semantic results, provenance and source changes.
- Recorded terminal guest throws and primitive arithmetic TypeError/RangeError outcomes; unsupported object coercion is a distinct terminal category. Terminal outcomes stop queued guest work. This is not catch/finally, unwinding or promise-rejection delivery.
- Separately pinned **engine262 reference oracle** and 14-file SHA-verified Test262 **syntax-only** baseline (plus 12 pure scalar differential probes). These do not execute Test262 tests through the tracer, count as full conformance or change the authoritative trace engine. See [adoption audit](ENGINE262_ADOPTION.md).
- **1,958 owned-arithmetic differential cases** against the pinned engine262 oracle: 1,433 normal and 525 abrupt results, each reconstructed and replayed after JSON serialization. The finite corpus is not exhaustive semantic proof.
- The existing **11-file selected Test262 sloppy-script execution** ledger is preserved with explicit passes, known failures and skips. Host-thrown interpreter errors in that older path remain diagnostic observations; they are not owned guest exception propagation.
- A separate **eight-file pinned Test262 execution slice** now executes unchanged official bodies through a small guest-written scalar assertion harness: six non-strict variants pass with 16 assertions; two unsupported variants and eight omitted strict variants remain explicit. This is not the complete official harness or a full Test262 conformance result. See [execution evidence](TEST262_RUNTIME_SLICE.md).
- A reproducible, full **declared textual scan of the pinned engine262 source tree**: 377 files, 2,028 named function-declaration candidates, 1,845 literal spec references and 157 intrinsic-name literals. Five declarations and 17 references map to the partial arithmetic path. New/changed/unclassified entries fail audit. This is not a full normative clause/intrinsic installation inventory. See [inventory](ENGINE262_INVENTORY.md).
- Package-root JavaScript ESM exports with embedded execution/host-delivery/replay tests. The pinned [natlang/megatoken integration audit](NATLANG_INTEGRATION.md) identifies both natlang evaluation seams and preserves the distinction between semantic chunks, physical parts and causal visibility.

## Strict synchronous training foundation (additional bounded profile)

The `training-js/1` profile provides integrity-locked Acorn 8.15.0 ES2022 strict
parsing with a syntax/operation allowlist, exact function entry, stable argument
graphs, reference identity/array semantics, journal normalization,
`semantic-trace/1` serialization, deterministic serial model groups and a local
differential Node V8 `vm` comparison. Its runtime shares the owned primitive
arithmetic phase path. The training profile accepts only synchronous, effect-free,
non-throwing entries; committed terminal guest throws in the common runtime do
not enable an exception-training category.

The bounded mock host bridge now dispatches only **versioned, immutable `canonical-json/1` request payloads**, materialized from the committed graph before the adapter sees them. Its journal independently checks the exact JSON bytes, operation signature, and historical graph versions. Adapters receive frozen plain JSON data; original guest tags remain only in the private journal. Fulfilled/pending guest-promise adoption regressions also exist. The deterministic fixture generator emits candidate
`semantic-execution/1` episodes with a private audit sidecar and reports
**locally verified**, with **admitted=0**. These are not accepted megatoken training
examples. Causal source bundling, liveness-based compaction, automatic corpus segmentation, and actual trained-model rollout evaluation remain open. A bounded selected-trace controller and a cross-repository megatoken adapter are implemented, with diagnostic rather than production admission. See [TRAINING_IMPLEMENTATION.md](TRAINING_IMPLEMENTATION.md) for the
implemented interfaces and admission gates.

## Not implemented (must not be inferred)

- Full ECMAScript language, general completion propagation, object coercions and internal methods, reflection/prototypes/Proxy, callable `this`, exceptions with catch/finally, generators, dynamic source, ECMAScript modules, or built-ins beyond the named subset. Only the stated primitive arithmetic slice has owned spec phases.
- All of ECMA-402, source maps/TypeScript, Node built-ins, browser/Web IDL/native hooks, typed native handoffs, true native activation ownership, buffer/agent/GC semantics, native resource restoration or real host scheduling.
- Full Section 29 normative catalog schemas: `catalog/operations.json` is a narrow indexed vocabulary only, not conformance evidence.
- Independent/specification-level semantic replay, native side-effect/resource replay, guest-visible exception delivery, closed canonical reference fixtures, full transitive model-visibility proofs, release locks, accepted budgets, or learning improvements. The structural validator proves **state reconstruction and structural invariants**. Optional bounded replay proves that this same interpreter can reproduce the journal under recorded inputs; neither check proves ECMAScript correctness.
- Journal durability/crash recovery, streaming storage/backpressure, globally consistent checkpoints, and real native integrations.
- No general engine262 replacement: engine262 remains an untraced, opt-in external oracle; the first primitive arithmetic phases are an in-repository owned implementation following its pinned algorithm structure. The complete normative clause/intrinsic inventory and official Test262 runtime harness remain open.
- No natlang `EvalEnvironment` or module-realm replacement or TypeScript lowering/source-map integration. The candidate training exporter now has a separately tested megatoken-native Episode adapter and explicit teacher-conditioned training path, but there is still no independently admitted corpus or measured trained-model correctness. Package-root imports do not imply application compatibility.

The VM still copies machine-state tables on each transaction. The operation continuation table now uses typed commands; existing tables still use **entity replacement**. This is neither a production storage scheme nor the finished fine-grained mutation algebra. String-to-number conversion, Number formatting and typed scalar arithmetic remain declared host primitive leaves.

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
5. Extend the now-implemented bounded JSON mock-host request dispatch to formally admitted external episodes; complete owned promise adoption/rejection and async scheduling, and add catch/finally under separately validated profile extensions. Implement both natlang evaluation seams against actual generated scope/module code before claiming application compatibility.
6. Scale journal/export storage and broaden spec-backed owned execution to bindings, object internal methods and observable coercion. Extend typed commands beyond the operation table, preserve versioned replay/causal contracts, and upgrade the textual inventory to full normative clause/intrinsic coverage. Native activation ownership, durable recovery, real Node/browser services, independent specification-level replay and the full strict/module/async/negative Test262 harness remain broader-target requirements in [engine262 adoption](ENGINE262_ADOPTION.md).

All missing requirements remain open in `coverage/required.json`; the demonstrator's profile is intentionally different from the plan's completed target.
