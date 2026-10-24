# tracing-js-self

An **experimental, owned-machine JavaScript semantic tracing runtime**, bootstrapped from the *Complete JavaScript Semantic Tracing Runtime* revision 2 implementation plan.

This is a working **bounded prototype**, **not** a complete JavaScript interpreter or complete Node/browser runtime. Unsupported language features fail explicitly rather than running guest JavaScript outside the tracer. See [implementation status and gaps](docs/STATUS.md) and [coverage ledger](coverage/required.json).

Version 0.2.0 adds the first serializable spec-operation path for primitive
arithmetic, typed operation commands, a pinned upstream source inventory, and a
small executed Test262 slice. It preserves the strict synchronous training
foundation and its source-anchored trace format. See
[owned arithmetic and evidence](docs/OWNED_ARITHMETIC.md).

## Training-data direction

The **only active public training format is
[semantic-execution/3 and semantic-trace/3](docs/EFFECTIVE_TRACE.md)**, with
`semantic-context/3` and private `semantic-supervision/2`. The language
profile is separately named `training-js/1`; the independently replayed raw
journal retains its own version. There is **no legacy exporter, formatter,
controller, native importer, or public format selector**.

Verified executions are compiled to small checkable source-level computations.
The public prefix contains source/static sites and initial graph; generated
records describe calculations, choices, live cells, allocations, mutations,
calls, transfers and completion. The independent serving controller checks the
*selected* records without substituting the expected trajectory. Private
journal evidence, reference outcomes and transformation certificates are never
predictor context.

From an installed checkout, generate and independently recheck local cases:

```sh
npm ci
npm test
npm run training:generate -- --seed 42 --count 16 \
  --output training-local.jsonl --manifest training-manifest.json
npm run training:recheck -- training-local.jsonl
npm run training:inspect -- training-local.jsonl training-inspection.json
```

The paired [megatoken](https://github.com/werg/megatoken) importer consumes
only the version-three schema, preserving physical bytes, native recurrence,
observed/generated boundaries and loss masks. `locally_verified` does **not**
mean `admitted`; a byte-fallback diagnostic codec is not the pinned production
tokenizer. External effects, complete async scheduling, automatic live
continuations, and actual model training comparisons still have independent
acceptance work. See the [implementation ledger](docs/TRAINING_IMPLEMENTATION.md)
and [complete redesign plan](docs/SEMANTIC_TRACE_REDESIGN_PLAN.md).

## Quick start

Requires Node.js 20 or later. Acorn 8.15.0 is the integrity-locked parser dependency
for `training-js/1`; engine262 is an optional, separately pinned reference oracle.

```sh
npm ci
npm test
npm run demo
node bin/tracing.js demo --output demo.trace.json
node bin/tracing.js validate demo.trace.json
node bin/tracing.js replay demo.trace.json
node bin/tracing.js causal demo.trace.json a0:e20
node bin/tracing.js run examples/async-demo.js --output waiting.trace.json
```

The demo issues two asynchronous mock operations, keeps an aggregate chunk open across an internally fulfilled `await`, then delivers B=20 before A=10. It computes `10 + 20 + 5` and records exactly one synchronous `host.store('sum', 35)`.

### Embedded API

```js
import { createRuntime, validateBundle, replayExact } from 'tracing-js-self';
const runtime = createRuntime({ adapters: {
  'demo.store': () => ({ kind: 'normal', value: undefined })
}});
runtime.start('let x = 2; x += 3; host.store("x", x);');
const progress = runtime.drive();
if (progress.kind !== 'terminated') throw new Error(progress.kind);
const bundle = runtime.exportRun();
validateBundle(bundle);
replayExact(bundle); // independently recompile source and reproduce recorded steps
```

Mock host adapters receive `{effectId, operation, args, request}`.
Here `args` is a deeply frozen plain JavaScript array parsed from the
`canonical-json/1` request, **not** guest reference tags. `request.payload` is
the immutable JSON argument array string with a versioned operation signature.
Object/property versions and all guest identities remain private in the journal:
the adapter's `request` object contains no `graphVersions` or guest handles.
Cycles, repeated object identities,
unsupported numeric encodings and unknown host methods fail closed before an
effect can be dispatched. The private archived `effect.args` retains the
original identity-bearing tuples solely for verification and replay.

Async adapters **do not** return native promises: after the machine emits `effect.dispatch`, they call `recordInputArrival({effectId,kind:'completion',value})` and `deliverInput(inputId)` at the chosen legal service point. Synchronous mock calls use `kind:'immediate'`. In a future production native integration these service permissions, typed native handoffs, caller retention and transport durability must be enforced by a versioned adapter/runner.

The package root also exports `Runtime`, `encode`/`decode`, `reconstruct`,
`causalPrefix`, and the trace validation/replay error classes. The package is an
embedded Node.js ESM API. It is not yet a natlang runtime replacement: the
[integration contract](docs/NATLANG_INTEGRATION.md) covers both per-call evaluation
and the separate module realm, together with megatoken's causal/physical chunk
requirements.

For programmatic fixture verification and training export, use the separate
`tracing-js-self/training` entry point:

```js
import { verifyTrainingCase } from 'tracing-js-self/training';
const checked = verifyTrainingCase({
  source: '"use strict"; function run(x) { return x * 2 + 1; }',
  entry: 'run', args: [7]
});
if (checked.status !== 'locally_verified') throw new Error(checked.status);
const candidate = checked.exported; // public targets plus a private audit sidecar
```

This entry point also exports `exportTraining`, `validateTrainingExport`, `SemanticController` and `evaluateSelectedTrajectory`. The serving controller commits model-selected semantic records without an interpreter fallback; selected-trace evaluation compares against reference outcomes only after the record has committed.
Direct export refuses incomplete, abrupt, asynchronous or effectful runs.
Successful arithmetic becomes a single semantic value at its completed phase,
with the original input dependencies; its full phase trace remains in the private
archive. Candidate targets still require the admission gates above.

`drive()` reports `terminated`, `waiting`, `runtime.failure`, or `unsupported`.
Recorded guest throws are terminal in the bounded script profile; catch/finally
and async rejection delivery remain open. The locally verified training profile
admits only synchronous, effect-free, non-throwing entries. New archives use
`semantic-tracing-run/2`; the structural reader supports old `/1` archives, while
exact replay requires `/2`. The language profiles remain separate:
`bounded-js-subset/2` for the original script path and `training-js/1` for strict
function entry.

## Pinned spec-reference baseline (Node.js 24 only)

The **optional** engine262 oracle compares pure scalar outcomes while retaining
the owned runtime as the only trace authority. The checks have separate evidence
boundaries:

- 12 existing scalar source probes and **1,958 owned-arithmetic comparisons**, each
  with independent oracle observations, state reconstruction and exact replay.
- A SHA-verified **14-file Test262 syntax-only** baseline.
- The existing **11-file selected execution** smoke ledger, with explicit passes,
  known failures and skips. Its diagnostic host-thrown errors remain separate
  from owned guest completions.
- An **eight-file Test262 execution** slice with a guest scalar assertion harness:
  six non-strict variants pass, two remain unsupported, and eight strict variants
  are explicitly omitted. This is not the full official harness or full conformance.
- A pinned engine262 source inventory with explicit partial/unowned classifications.

The normal `npm test` requires the locked Acorn dependency but does not require
engine262. The strict training path also uses an independent Node V8 `vm`
reference for fixture comparisons; that reference runs outside the owned tracer.

```sh
VERSION="$(node -p "require('./profiles/targets.lock.json').referenceEngine.npmVersion")"
npm install --no-save --package-lock=false --ignore-scripts --no-audit --no-fund "@engine262/engine262@$VERSION"
node scripts/run-spec-probes.mjs
node scripts/run-owned-arithmetic-probes.mjs
node scripts/run-conformance.mjs --output /tmp/test262-baseline.json
node tools/test262-baseline.mjs --output /tmp/test262-execution.json
node scripts/run-runtime-conformance.mjs --oracle --output /tmp/test262-runtime.json
node scripts/audit-engine262.mjs
```

The reference engine and suite commits, fixture blob hashes, remaining ownership
gaps and acceptance gates are documented in [engine262 adoption](docs/ENGINE262_ADOPTION.md),
[source inventory](docs/ENGINE262_INVENTORY.md), and [Test262 execution](docs/TEST262_RUNTIME_SLICE.md).
CI verifies the source inventory against exact upstream Git objects and publishes
the arithmetic, parser and execution reports.

## Bounded TypeScript and static ESM entry points

The opt-in `tracing-js-self/natlang` adapter now lowers TypeScript syntax
to ES2022 with pinned TypeScript 5.9.3, then executes only JavaScript supported
by the owned strict training profile. Validated archives include generated
source sites; the `onTrace` callback also receives the original TS and V3
source-map metadata. A bounded data-only `__live` synchronization path
and data-only retained `module.exports` adapter now exist; callable helpers,
full natlang module caching/closures and general native integrations still fail
closed. There is no host runtime fallback or complete TS/JS conformance claim.

`tracing-js-self/modules` additionally links a supplied graph of
function-only TypeScript/ESM modules into an owned replayable entry. It supports
named and default function exports, import aliases and cycles, while rejecting
top-level effects, mutable exports, native packages and dynamic imports.
See [integration boundaries](docs/NATLANG_INTEGRATION.md) and
[static module profile](docs/STATIC_MODULES.md).

For mutable ESM exports, import-cell aliasing, dependency initialization and
bounded top-level `await`, the separate opt-in
`tracing-js-self/evaluated-modules` entry point executes an explicit **acyclic**
in-memory source graph through the owned interpreter. Optional versioned native
services record guest input arrival and delivery; replay invokes no native
service. This is neither a persistent ESM realm nor a general module loader.
See [evaluated module profile](docs/EVALUATED_MODULES.md).


## Main modules

`src/frontend.js` implements the bounded lexer/parser and source-mapped bytecode
compiler; `src/training/profile.js` supplies the strict Acorn frontend.
`src/runtime.js` contains the explicit machine, direct function entry, state
versions, jobs, effects and chunk accumulator. `src/spec-operations.js` implements the owned
arithmetic phases; `src/spec-mutations.js` writes their typed commands and
`src/spec-validation.js` independently checks them. `src/values.js` implements
exact scalar tagging. `src/validation.js` reconstructs state and checks structural
invariants, including the lifecycle checks in `src/host-journal.js`.
`src/replay.js` recompiles source and reproduces events, state and chunks without
host adapters. `src/causal.js` provides the restricted model view without private
arrival payloads. `src/semantic/normalize.js` and `src/training/` provide the
bounded training projection, formatting, scheduling, visibility and local
verification path. `src/index.js` is the public package facade.

**Evidence boundary:** exact replay is an interpreter self-consistency check against its recorded journal, **not** an independent semantic oracle, real native-effect replay, proof of standards compliance, or safe execution of arbitrary full JavaScript. It requires a complete sealed run and uses the recorded external values only at their arrival events. The prototype's tests establish only the behaviors they exercise. They do not pass the completion criteria from the full plan. In particular, `completeSemanticTrace: false` applies to the declared complete JavaScript target; the supported subset is instrumented at the interpreter's declared bytecode vocabulary.


