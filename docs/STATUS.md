# Implementation status (0.1.0)

This repository implements a **bounded, executable prototype** for the architecture in the attached *Complete JavaScript Semantic Tracing Runtime, revision 2 (22 October 2026)*. It does **not** implement the complete plan or claim a complete ECMAScript/Node/browser profile. In particular, a passing prototype test is not a Test262, WPT, Node-API, or learning-evaluation result.

## What runs

- Explicit bytecode evaluator; its guest continuation, operand stack, environments, closure bindings, heap objects, promise states, suspension and job queue are serializable records. No `eval`, `vm`, `Function` constructor, or native `require` executes guest code.
- A purposely restricted JavaScript grammar: script goal, numeric/string/boolean/null/undefined/BigInt literals, `let`/`const`/`var` (restricted semantics), blocks, `if`, `while`, function declarations, returns, ordinary calls, `async function`, `await`, primitive arithmetic/comparison/logical operators, direct property reads/writes, and basic dense array/object literals. No ASI. Parser/compiler refuse unsupported syntax.
- A mock host bridge for `host.readAsync`, `host.readNumber` and `host.store`, with recorded dispatch intent before adapter invocation; independent nonblocking promise return and later completion; explicit host input **arrival** vs **delivery**; synchronous calls wait for their actual outcome even when its result is unused. Native transport promises are forbidden as guest continuations.
- One ordered authoritative journal of instruction-level semantic events with source sites, producer links, read observations and typed entity-replacement patches with version preconditions; records can be reconstructed without invoking the evaluator.
- Accumulation of effects and permitted internal microtask resumption into a chunk, without token-budget cuts. A reference demo produces three chunks with A/B dispatch, B completion first, A second, and a single store of `35`.
- Read-only structural validator, state reconstruction, and a **limited** causal interleaved projection that hides host arrival payloads and full archival state until delivery. Private input perturbation regression included.
- Deterministic **bounded-interpreter** replay: recompile archived sources (never trust archived bytecode for execution), inject only recorded external inputs, and compare every regenerated semantic event, patch, checkpoint, chunk boundary and termination category. Replay installs no host adapters; corruption tests cover semantic results, provenance and source changes.
- Separately pinned **engine262 reference oracle** and 14-file SHA-verified Test262 **syntax-only** baseline (plus 12 pure scalar differential probes). These do not execute Test262 tests through the tracer, count as full conformance or change the authoritative trace engine. See [adoption audit](ENGINE262_ADOPTION.md).

## Not implemented (must not be inferred)

- Full ECMAScript language, completion records, spec coercions and object internal methods, reflection/prototypes/Proxy, callable `this`, exceptions with catch/finally, generators, dynamic source, ECMAScript modules, or built-ins beyond the named subset.
- All of ECMA-402, source maps/TypeScript, Node built-ins, browser/Web IDL/native hooks, typed native handoffs, true native activation ownership, buffer/agent/GC semantics, native resource restoration or real host scheduling.
- Full Section 29 normative catalog schemas: `catalog/operations.json` is a narrow indexed vocabulary only, not conformance evidence.
- Independent/specification-level semantic replay, native side-effect/resource replay, guest-visible exception delivery, closed canonical reference fixtures, full transitive model-visibility proofs, release locks, accepted budgets, or learning improvements. The structural validator proves **state reconstruction and structural invariants**. Optional bounded replay proves that this same interpreter can reproduce the journal under recorded inputs; neither check proves ECMAScript correctness.
- Journal durability/crash recovery, streaming storage/backpressure, globally consistent checkpoints, and real native integrations.
- No spec-backed **owned-machine** integration yet: engine262 is an untraced, opt-in external oracle. The complete clause/intrinsic inventory and official Test262 runtime harness remain open.

The VM currently copies small machine-state tables on each transaction, and each mutation is recorded as a typed **entity replacement**. This provides a simple, independently reconstructible baseline but is neither a production storage scheme nor the plan's finished fine-grained typed mutation algebra.

## Next integration sequence

1. **Candidate pinned:** engine262 and a fixed Test262 slice now provide a reproducible reference baseline. **Still open:** complete clause/intrinsic inventory; replace the bounded parser and handlers with spec-backed **owned** phases, preserving the state and trace contracts (the oracle is not that replacement).
2. Replace entity-replacement diffs with typed mutation commands, durable journal/checkpoints, stronger provenance and catalog schema validation.
3. Complete the guest promise scheduler, exception/completion/reentry lifecycle, and independent semantic replay. Extend the current bounded interpreter's deterministic replay to the eventual spec-backed engine and typed native handoff events.
4. Implement versioned native binding ownership, activation retention, real Node/browser services and the complete host-entry inventories, with reference fixtures.
5. Expand the independent visibility validator and train/evaluate representations only once authoritative traces pass the runtime acceptance gate.

All missing requirements remain open in `coverage/required.json`; the demonstrator's profile is intentionally different from the plan's completed target.
