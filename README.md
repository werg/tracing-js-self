# tracing-js-self

An **experimental, owned-machine JavaScript semantic tracing runtime**, bootstrapped from the *Complete JavaScript Semantic Tracing Runtime* revision 2 implementation plan.

This is a working **bounded prototype**, **not** a complete JavaScript interpreter or complete Node/browser runtime. Unsupported language features fail explicitly rather than running guest JavaScript outside the tracer. See [implementation status and gaps](docs/STATUS.md) and [coverage ledger](coverage/required.json).

Version 0.2.0 adds the first serializable spec-operation path for primitive
arithmetic, typed operation commands, a pinned upstream source inventory, and a
small executed Test262 slice. It preserves the strict synchronous training
foundation and its source-anchored trace format. See
[owned arithmetic and evidence](docs/OWNED_ARITHMETIC.md).

## Model-facing semantic execution traces

Production uses **`semantic-execution/4`, `semantic-trace/4`,
`semantic-context/4`**, and `selected-harness/2`.
The strict machine archive and its exact replay remain private certification
evidence. The older version-three, group-shaped corpus is an **offline
diagnostic archive**; its formats are not accepted by the production harness.

The training target is **an execution explanation**, not a bijection with
interpreter instructions. Source-grounded, independently checked expressions
pair a term with the actual value computed at that moment. A source binding
uses its original name (`current`, `next`, `seen`); shadowed bindings
receive a disambiguating suffix. Anonymous pure subexpressions get no synthetic
temporary identities. For instance:

```text
bind current = 7
next = (current + 1) -> 8
request demo.store("counter", 8)
observe fulfilled undefined
return 8
```

The external request, ordered response, state mutations, event/callback
activations, Promise transitions and completion remain explicit and must agree
with the independently executed source. Checked reasoning claims are evaluated
against **prior committed public state**, never private future results.
Calls, getters, proxies, updates and other effectful terms cannot be silently
flattened into pure arithmetic; unsupported projections fail closed.
See [reasoning trace design](docs/SEMANTIC_REASONING_TRACE.md) and
[production v4 implementation](docs/SEMANTIC_HARNESS_V4_IMPLEMENTATION.md).

From an installed checkout:

```sh
npm ci
npm test
node tools/inspect-semantic-reasoning.mjs
npm run training:generate -- --out /tmp/semantic-v4 --representation compact
```

The inspection tool executes real pinned counter, choice, compound
arithmetic, callback and rejection/finally fixtures and independently verifies
each before printing its actual model-visible trace. The source verifier,
selected-state controller and external reference compare **observable
completion and effects** separately from witness consistency and exact
reference trace bytes. Local verification is not final training admission:
that also requires the pinned native Megatoken consumer, tokenizer and
visibility/loss checks. Model learning gains are not established by a
shorter trace alone.

## Executable external effects

`compileExternalEffectsJS(bundle)` returns a JavaScript **function body** for
the external operations actually dispatched by a validated owned run. This is
for deliberate effect replay in an independent JS engine, **not** for rebuilding
the whole guest program, its results, or async scheduling. It does not perform
any external effects until you execute the returned string.

```js
import {compileExternalEffectsJS} from 'tracing-js-self';

const javascript = compileExternalEffectsJS(bundle);
const effects = {'demo.store': (key, value) => save(key, value)};
new Function('effects','bridge',javascript)(effects); // bridge needed only for registered callbacks
```

For an **active** external effect, the live entry point also returns code
that routes both synchronous exceptions and native Promise settlements into
the journalled owned input path:

```js
import {compilePendingEffectJS,createOwnedEffectBridge} from 'tracing-js-self';
const effect = Object.values(runtime.state.effects).find(e => e.dispatch === 'dispatched' && e.external === 'pending');
const js = compilePendingEffectJS(runtime,effect.id);
new Function('effects','bridge',js)(effects,createOwnedEffectBridge(runtime));
// After the service settles, drive the owned runtime at the next legal point.
```

The live bridge invokes `recordInputArrival` and `deliverInput` for
both normal and rejected native Promise settlements. For a **declared callback
slot**, `bridge.callback(effectId, callbackId)` constructs a native callable
which queues `external.callback.enqueue` and runs the *original guest closure*
through the owned VM's FIFO scheduler; it never runs guest source natively.
The currently implemented example is `host.withCallback(key, fn)`, exposed as
the versioned `demo.withCallback/1` capability. The native service receives
`{args:[key,callback], effectId, request, signal,...}`, and callback arguments
must be primitives. The host's synchronous callback return value is always
`undefined`; callbacks needing a synchronous guest return are unsupported.

```js
const result=await executeWithNativeServices({
  text:`async function run(){
    let total=0;
    await host.withCallback('value', function(n){total+=n;});
    host.store('total',total);
  } run();`,
  services:{
    'demo.withCallback':({args})=>{
      args[1](7); // queue the owned guest closure, not native guest execution
      return Promise.resolve();
    },
    'demo.store':({args})=>console.log(args)
  }
});
replayExact(result.bundle); // does NOT repeat native calls
```

Declared subscription callbacks also survive registration settlement and the
original call's completion. `demo.listen`/`demo.unlisten` retain and close the
owned handler; queued and late events have explicit dispositions. The selected
browser adapter supplies scoped passive event notifications and timers, and the
Natlang adapter supplies registered graph-valued asynchronous callback returns.
These are separate declared operation profiles. General DOM Event objects and
native-dependent synchronous guest return/propagation control remain outside
the passive profile. See [the v4 capability and lifetime contract](docs/SEMANTIC_HARNESS_V4_IMPLEMENTATION.md).

The emitted JavaScript calls `effects["operation"](...materializedArgs)` in
recorded dispatch order. The argument values are copied directly from the
verified immutable request payload (including the snapshot of a later-mutated
object). All required handlers are checked before the first call. Handler
results do not resume the source program, and asynchronous completions are not
reconstructed. Running the generated string **executes effects again**;
use only trusted archives and deliberately supplied handlers.

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

Low-level runtime adapters publish arrivals using `recordInputArrival` and `deliverInput` at a legal service point. The production selected harness provides the higher-level Promise/callback bridge, source and capability checks, owned resource lifetimes, durable intent journal, and checkpoint/reconciliation interface. See [the v4 runtime contract](docs/SELECTED_HARNESS_V4.md).

The package root also exports `Runtime`, `encode`/`decode`, `reconstruct`,
`causalPrefix`, and the trace validation/replay error classes. The package is an
embedded Node.js ESM API. The opt-in `tracing-js-self/natlang-selected` adapter
supports asynchronous fresh and retained Natlang evaluation, including module
loading and registered native resources. The [implementation guide](docs/SEMANTIC_HARNESS_V4_IMPLEMENTATION.md)
describes the supported profile, independent checks, and paired repository pins.
The [engineering completion ledger](docs/SEMANTIC_HARNESS_V4_COMPLETION.md)
records all M0–M8 results, admitted source/native data, controlled evaluation and
the separate inputs still needed for later training.

For programmatic fixture verification and training export, use the separate
`tracing-js-self/training` entry point:

```js
import { verifyEffectfulTrainingCase } from 'tracing-js-self/training';
const checked = await verifyEffectfulTrainingCase({
  source: '"use strict"; function run(x) { return x * 2 + 1; }',
  entry: 'run', args: [7], fixture: { calls: [] }, family: 'example-arithmetic'
});
if (checked.status !== 'locally_verified') throw new Error(checked.status);
const candidate = checked.exported; // public targets plus a private audit sidecar
```

The production entry point also exports `SelectedExecutionHarness`,
`SelectedModelDriver`, `SelectedIntentJournal`, `verifyEffectfulSession`,
`recheckEffectfulAdmission`, and the Megatoken process selectors. Code publication
precedes explicit invocation; requests carry evaluated arguments and exact source
provenance; external results remain observations. The teacher compiler supports
async effects, reactions, callbacks, cleanup, graph feedback and checkpoint/source
rereads. Fully admitted data additionally requires the real production tokenizer,
native consumer, visibility and loss gates. A locally verified result is not
automatically admitted data or learned model success.

The former group-shaped bounded-pure corpus APIs now live exclusively under
`tracing-js-self/training/diagnostic` and `npm run diagnostic:*`. They remain useful
for independent source analysis and historical comparisons. Production training
and serving accept `semantic-execution/4` with `selected-harness/2` only.

`drive()` reports `terminated`, `waiting`, `runtime.failure`, or `unsupported`.
Owned catch/finally, Promise rejection, continuation and callback semantics are
covered by the declared profile and independent fixtures. New archives and supported readers use `semantic-tracing-run/2`; older `/1`
archives require an explicit offline migration and are not silently accepted. The language profiles remain separate:
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

**Evidence boundary:** exact replay checks the interpreter against its recorded
journal. Independent source execution, source-operation certificates, native
consumer validation and selected-model evaluation provide separate authorities.
Replay requires a complete sealed run and uses external values at their recorded
arrival boundaries; it calls no native adapter. The v4 engineering gate covers
the declared execution and capability profile. `completeSemanticTrace: false`
still applies to the broader complete-JavaScript target, and this package does
not claim arbitrary JavaScript compatibility, a hostile-code sandbox or learned
execution quality. The [v4 implementation guide](docs/SEMANTIC_HARNESS_V4_IMPLEMENTATION.md)
records the current supported profile and evidence.
The [completion receipt](contracts/semantic-engineering-completion.json) pins the
three compatible implementations; it does not certify learned model quality.


