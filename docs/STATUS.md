# Implementation status (0.1.0)

This repository implements a **bounded, executable prototype** for the architecture in the attached *Complete JavaScript Semantic Tracing Runtime, revision 2 (22 October 2026)*. It does **not** implement the complete plan or claim a complete ECMAScript/Node/browser profile. In particular, a passing prototype test is not a Test262, WPT, Node-API, or learning-evaluation result.

## What runs

- Explicit bytecode evaluator; its guest continuation, operand stack, environments, closure bindings, heap objects, promise states, suspension and job queue are serializable records. No native `eval`, `vm`, `Function` constructor, or `require` executes guest code **inside the owned tracer**. The independent bounded training reference intentionally executes fixture code in Node `vm`, outside the traced authority.
- A purposely restricted JavaScript grammar: script goal, numeric/string/boolean/null/undefined/BigInt literals, `let`/`const`/`var` (restricted semantics), blocks, `if`, `while`, function declarations, returns, ordinary calls, `async function`, `await`, primitive arithmetic/comparison/logical operators, direct property reads/writes, and basic dense array/object literals. No ASI. Parser/compiler refuse unsupported syntax.
- A mock host bridge for `host.readAsync`, `host.readNumber` and `host.store`, with recorded dispatch intent before adapter invocation; independent nonblocking promise return and later completion; explicit host input **arrival** vs **delivery**; synchronous calls wait for their actual outcome even when its result is unused. Native transport promises are forbidden as guest continuations.
- One ordered authoritative journal of instruction-level semantic events with source sites, producer links, read observations and typed entity-replacement patches with version preconditions; records can be reconstructed without invoking the evaluator.
- Accumulation of effects and permitted internal microtask resumption into a chunk, without token-budget cuts. A reference demo produces three chunks with A/B dispatch, B completion first, A second, and a single store of `35`.
- Read-only structural validator, state reconstruction, and a **limited** causal interleaved projection that hides host arrival payloads and full archival state until delivery. The validator cross-checks start/end host tables, chunk indexes and pending summaries, plus the bounded host effect/input creation–dispatch–arrival–delivery lifecycle; the runtime rejects second arrivals for single-outcome effects. Private input perturbation and hostile-archive corruption regressions included.
- Deterministic **bounded-interpreter** replay: recompile archived sources (never trust archived bytecode for execution), inject only recorded external inputs, and compare every regenerated semantic event, patch, checkpoint, chunk boundary and termination category. Replay installs no host adapters; corruption tests cover semantic results, provenance and source changes.
- Separately pinned **engine262 reference oracle**, 14-file SHA-verified Test262 **syntax-only** slice, and 11-file SHA-verified selected Test262 sloppy-script **execution smoke** ledger (with explicit passes, known failures and skips), plus 12 pure scalar differential probes. Neither selected suite proves full Test262 conformance; the owned VM remains the trace authority. See [adoption audit](ENGINE262_ADOPTION.md).

## Strict synchronous training foundation (additional bounded profile)

The `training-js/1` profile now provides Acorn ES2022 strict parsing with a syntax/operation allowlist, exact function entry, stable argument graphs, reference identity/array semantics fixes, committed explicit guest throw, journal normalization, semantic-trace/1 serialization, deterministic serial model groups and a local differential Node-vm comparison. An optional canonical-json/1 graph materializer (not yet connected to dispatch) and bounded guest-promise adoption correctness regressions have also landed. A deterministic fixture generator exports **locally verified** episodes with a private audit sidecar, not admitted megatoken training examples. See [TRAINING_IMPLEMENTATION.md](TRAINING_IMPLEMENTATION.md) for implemented interfaces and remaining correctness/visibility gates.

## Not implemented (must not be inferred)

- Full ECMAScript language, completion records, spec coercions and object internal methods, reflection/prototypes/Proxy, callable `this`, exceptions with catch/finally, generators, dynamic source, ECMAScript modules, or built-ins beyond the named subset.
- All of ECMA-402, source maps/TypeScript, Node built-ins, browser/Web IDL/native hooks, typed native handoffs, true native activation ownership, buffer/agent/GC semantics, native resource restoration or real host scheduling.
- Full Section 29 normative catalog schemas: `catalog/operations.json` is a narrow indexed vocabulary only, not conformance evidence.
- Independent/specification-level semantic replay, native side-effect/resource replay, guest-visible exception delivery, closed canonical reference fixtures, full transitive model-visibility proofs, release locks, accepted budgets, or learning improvements. The structural validator proves **state reconstruction and structural invariants**. Optional bounded replay proves that this same interpreter can reproduce the journal under recorded inputs; neither check proves ECMAScript correctness.
- Journal durability/crash recovery, streaming storage/backpressure, globally consistent checkpoints, and real native integrations.
- No spec-backed **owned-machine** integration yet: engine262 is an untraced, opt-in external oracle. The complete clause/intrinsic inventory and **full Test262 harness** (strict/sloppy variants, modules, async, includes and host intrinsics) remain open.

The VM currently copies small machine-state tables on each transaction, and each mutation is recorded as a typed **entity replacement**. This provides a simple, independently reconstructible baseline but is neither a production storage scheme nor the plan's finished fine-grained typed mutation algebra.

## Next implementation sequence

The [semantic execution training-data plan](TRAINING_DATA_PLAN.md) sets the immediate priority: a verified bounded training generator with one compact semantic target and a causal megatoken exporter. The first bounded synchronous foundation is partially implemented (see above); subsequent megatoken, continuation, async and engine-coverage milestones remain planned work.

1. Establish an independently checked synchronous training profile, including correct parsing, admitted value/object semantics, owned completion records, direct function entry, and identity-preserving input/state comparison. Known accepted semantic divergences must be fixed or rejected before admission; replay alone is insufficient.
2. Normalize the journal into explicit invocation, source-site, control, value, read/write, and completion records; implement the compact semantic trace and its preservation checks.
3. Implement causal source bundles, helper inlining, bounded reusable tracks, model chunk boundaries, and exact continuation packets. Keep model cuts separate from guest scheduling and host service points.
4. Add the megatoken exporter, teacher-conditioned supervised episodes, generated-state rollout verification, and the first admitted synchronous corpus. A bounded profile must pass its semantic and visibility gates; full Node/browser coverage is not a prerequisite.
5. Add fully materialized external calls, owned promise adoption/rejection and async scheduling, and catch/finally under separately validated profile extensions.
6. Scale journal/export storage and broaden spec-backed owned execution. Complete clause/intrinsic inventories, native binding ownership, durable recovery, real Node/browser services, and the full conformance harness remain requirements for the broader target described in [engine262 adoption](ENGINE262_ADOPTION.md).

All missing requirements remain open in `coverage/required.json`; the demonstrator's profile is intentionally different from the plan's completed target.
