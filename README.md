# tracing-js-self

An **experimental, owned-machine JavaScript semantic tracing runtime**, bootstrapped from the *Complete JavaScript Semantic Tracing Runtime* revision 2 implementation plan.

This is a working **bounded prototype**, **not** a complete JavaScript interpreter or complete Node/browser runtime. Unsupported language features fail explicitly rather than running guest JavaScript outside the tracer. See [implementation status and gaps](docs/STATUS.md) and [coverage ledger](coverage/required.json).

## Quick start

Requires Node.js 20 or later; no third-party dependencies.

```sh
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
import { createRuntime } from './src/runtime.js';
import { validateBundle } from './src/validation.js';
import { replayExact } from './src/replay.js';
const runtime = createRuntime({ adapters: {
  'demo.store': () => ({ kind: 'normal', value: undefined })
}});
runtime.start('let x = 2; x += 3; host.store("x", x);');
const progress = runtime.drive();
const bundle = runtime.exportRun();
validateBundle(bundle);
replayExact(bundle); // independently recompile source and reproduce recorded steps
```

Async adapters **do not** return native promises: after the machine emits `effect.dispatch`, they call `recordInputArrival({effectId,kind:'completion',value})` and `deliverInput(inputId)` at the chosen legal service point. Synchronous mock calls use `kind:'immediate'`. In a future production native integration these service permissions, typed native handoffs, caller retention and transport durability must be enforced by a versioned adapter/runner.

## Pinned spec-reference baseline (Node.js 24 only)

The **optional** engine262 oracle compares pure scalar outcomes while retaining the existing runtime as the only trace authority. A SHA-verified, fourteen-file official Test262 script-*parser* slice records both passing syntax cases and known gaps. This is **not** Test262 execution conformance. The normal \`npm test\` and traced runtime have no added dependencies.

\`\`\`sh
VERSION="$(node -p "require('./profiles/targets.lock.json').referenceEngine.npmVersion")"
npm install --no-save --package-lock=false --ignore-scripts --no-audit --no-fund "@engine262/engine262@$VERSION"
node scripts/run-spec-probes.mjs
node scripts/run-conformance.mjs --output /tmp/test262-baseline.json
\`\`\`

The reference engine and suite commits, fixture blob hashes, ownership-blocking design gaps and acceptance gates are documented in [engine262 adoption](docs/ENGINE262_ADOPTION.md). CI publishes the JSON gap report.

## Main modules

`src/frontend.js` implements the bounded lexer/parser and source-mapped bytecode compiler. `src/runtime.js` contains the explicit machine, committed state versions, jobs, effects and chunk accumulator. `src/values.js` implements exact scalar tagging (including signed zero, NaN, BigInt and lone UTF-16 surrogates). `src/validation.js` independently reconstructs state and checks structural invariants. `src/replay.js` recompiles the saved source and re-executes the bounded interpreter using recorded host inputs, comparing each event, source site, mutation, checkpoint, and chunk without invoking host adapters. `src/causal.js` materializes a restricted, input-interleaved model view without private arrival payloads.

**Evidence boundary:** exact replay is an interpreter self-consistency check against its recorded journal, **not** an independent semantic oracle, real native-effect replay, proof of standards compliance, or safe execution of arbitrary full JavaScript. It requires a complete sealed run and uses the recorded external values only at their arrival events. The prototype's tests establish only the behaviors they exercise. They do not pass the completion criteria from the full plan. In particular, `completeSemanticTrace: false` applies to the declared complete JavaScript target; the supported subset is instrumented at the interpreter's declared bytecode vocabulary.
