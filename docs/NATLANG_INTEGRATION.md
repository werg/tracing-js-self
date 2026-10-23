# JavaScript embedding and natlang integration

The package entry point exposes the existing tracing runtime to Node.js ES
modules. It is **not yet a drop-in natlang evaluator**, a complete TypeScript
language runtime, or a complete JavaScript/Node/browser runtime. Supported execution remains the
profile in [STATUS.md](STATUS.md). No untraced fallback is installed.

```js
import {
  createRuntime, validateBundle, reconstruct, replayExact, causalPrefix
} from 'tracing-js-self';

const runtime = createRuntime().start('let answer = 2 + 3 * 4;');
const progress = runtime.drive();
const bundle = runtime.exportRun();
validateBundle(bundle);
const state = reconstruct(bundle);
replayExact(bundle); // same-interpreter consistency, without host adapters
const modelView = causalPrefix(bundle);
```

The entry point also exports `Runtime`, the primitive `encode`/`decode` codec,
`TraceValidationError`, and `TraceReplayError`. `drive()` distinguishes waiting
from termination. Host adapters use the current declared mock operations;
asynchronous completion arrives through `recordInputArrival` and is made guest
visible separately through `deliverInput`. A native transport promise is not a
guest continuation. `test/public-api.test.js` exercises package-name imports,
embedded execution, both host wait paths, causal hiding, and effect-free replay.

The separate `tracing-js-self/training` entry point exports `verifyTrainingCase`,
`exportTraining`, and `validateTrainingExport` for the strict synchronous
`training-js/1` profile. It shares the owned arithmetic phases and can compare
completed function results and observable argument graphs with an independent
Node V8 reference. These checks produce locally verified candidate episodes;
they do not supply natlang's evaluator contract or megatoken admission.

## Opt-in bounded EvalEnvironment bridge

`tracing-js-self/natlang` now exports `createBoundedNatlangEnvironment`.
It implements the **shape** of natlang's per-evaluation `EvalEnvironment` for
self-contained, bounded `training-js/1` programs, now including
owned asynchronous guest entries and explicitly declared native services. This is *not* a
drop-in runtime replacement for typical natlang-generated code.

```js
import {createBoundedNatlangEnvironment} from 'tracing-js-self/natlang';
// Obtain EvalFailure from the SAME natlang installation used by the caller.
const env=createBoundedNatlangEnvironment({
  EvalFailure, // natlang's actual class; required for instanceof compatibility
  onTrace(bundle,request,lowering) {
    // The archive is executed ES2022, not an opaque TS or V8 result.
    // Persist the original text + TypeScript source map alongside the archive.
    recordCandidate(bundle,request.path,lowering);
  }
});
const result=env.execute({
  code:'self.x + 3',scope:{x:4},body:false,path:'natlang://probe'
});
// result.result === 7; owned trace delivered to onTrace, never host-evaluated.
env.close();
```

The bridge wraps the supplied TypeScript expression/body as one explicitly
strict entry function, lowers it using pinned TypeScript 5.9.3 into ES2022,
passes the emitted JavaScript through the strict Acorn allowlist, imports plain
portable `self` data through the bounded graph codec, runs the owned
bytecode machine, validates the archive and exact replay, then returns a
decoded value and natlang-shaped `typescript.eval` host event. The optional
third `onTrace` argument contains `originalText`, `javascript`, `compiler`
and a TypeScript V3 `sourceMap`; guest trace source positions still refer
to the executed generated JS, not proven reanchored original TS locations. It accepts ordinary mutable **data-only** live bindings through `__live`;
non-data captures, executable callbacks, ambient packages/network and native
timeouts still fail closed. Invalid TypeScript,
unsupported emitted JavaScript, unfinished runs and unsafe scope graphs throw
natlang's real `EvalFailure`; the `onTrace` success hook is not called on failure.
The TS frontend strips supported type syntax; it is not a type checker and
does not authorize any unsupported runtime semantics or emit native code.

The strict profile now accepts source-level conditional expressions, numeric
local-identifier updates and ordinary bounded for/do-while loops. This does
now includes captured `for (let...)` closures and bounded scalar member
updates/compound assignments. This still does not imply support for arrows,
destructuring, arbitrary object methods, live helper services or all constructs
emitted by typical natlang scopes. No fallback executes unsupported constructs.

Only the explicitly registered native-service `executeAsync` path accepts
a bounded host-owned `timeoutMs` (1–300000 ms). The deadline aborts the
native adapter's signal and refuses successful trace publication; it is not a
guest timer, not deterministic journaled wall-clock time, and cannot undo a
started native side effect. Ordinary synchronous `execute` and no-service
`executeAsync` still refuse native deadlines.

`executeAsync` runs an owned async guest entry, including `await` on guest
promises and optionally asynchronous versioned native service effects.
`evaluateModule` is available in `retained` mode only for mutable, portable,
data-only CommonJS-shaped `exports`/`module.exports` bindings; natlang's
callable-folder loader still cannot be installed as a drop-in.
`fork` and `close` are owned lifecycle methods. There is no untraced fallback.

Independent Node V8 regression tests now execute the actual pinned-TypeScript-emitted JS from the opt-in natlang facade, reconstruct the identical owned initial argument graph in a separate VM realm, and compare the full reachable returned/input graph including mutations and alias identity. The bounded matrix covers scalar, TS lexical declarations, loop/closure, template, bitwise, and caught-exception samples; it also verifies replay and generated-source site anchors. This is independent generated-JS differential evidence, **not** proof of general natlang application compatibility or of original-TS semantic site correctness.

Supported ES2022 optional chains now execute through owned short-circuit
bytecode, including skipped computed keys/arguments and method receivers.
The TypeScript host-side emitter preserves these chains for tracing. Calls of
the form `object.method?.()` remain refused because the owned method-token
nullish check needs receiver-aware semantics; there is no V8 fallback.

Opt-in natlang onTrace sidecar now also exposes SourceMap-derived generated-site origin anchors, with recorded unmapped sites. The mapper verifies its embedded source bytes and annotates sites; these are **not** proof of original TypeScript source-level semantic correspondence, transformed implicit operations, or general transpilation correctness. The public/authoritative journal remains generated-JS based.

Opt-in strict-profile TS lowering now includes try/catch/finally completion syntax (with a scalar/plain guest throw and identifier catch binding), plus simple synchronous arrow and anonymous function expressions. Their guest calls and captures run through owned frames, with no native fallback. It does not cover the broader scope compiler's rest/destructuring/spread, callable-folder modules, non-data live captures, or arbitrary asynchronous host functions.

Production integration still must check actual scope-compiler output, wire
and prove the separate `setModuleRealm` seam, implement non-data capture
semantics and helper callback reentry, and prove TS source mapping.
These are mandatory requirements before advertising application compatibility.
`test/natlang-bridge.test.js` supplies contract-shape and replay smoke tests,
not acceptance of the broad natlang runtime.

### Bounded retained/live and native async extensions (23 October 2026)

The adapter has a **narrow opt-in retained mode** and explicit native-service
transport, both with owned guest execution (no Node `vm` fallback):

```js
const env = createBoundedNatlangEnvironment({
  EvalFailure,
  mode: 'retained',
  services: {
    'demo.readAsync': async ({args,signal}) => await readNumber(args[0], signal)
  },
  onTrace(bundle, request, lowering) {
    // Structural validation and exact replay precede this callback.
    saveCandidate(bundle, request.path, lowering.sourceMap);
  }
});
const cell = {count: 1};
const asyncResult = await env.executeAsync({
  code: "const n = await host.readAsync('offset'); __live.cell.count += n; return __live.cell;",
  body: true, scope: {}, live: {cell}, path: 'app://example.ts'
});
// With a service result of 3, asyncResult.result === cell and cell.count === 4.
const exports = {count: 1};
const module = {exports};
env.evaluateModule('exports.count += 1;', {exports, module});
env.close();
```

Retained module execution is a data graph transformed by a single guest
evaluation; it is **not** a persistent heap of guest functions, not a standard
ESM module loader, and does not implement `require`, package imports, module
cache, getters, or callable-folder functions. Live `__live` data can be changed
by owned execution and written back after a valid, exactly replayed archive;
existing plain-object/array identities and aliases are preserved on the host.
Non-data objects, proxies, functions and unmodeled descriptors fail closed.
Host writes are committed after success, rather than on a partially executed
guest trace. Data passed as frozen `self` does not thereby become a live
capture.

With `services`, `executeAsync` uses `tracing-js-self/native` to commit a
native effect intent and later its separately journaled arrival and delivery.
Only the registered `demo.readAsync`, `demo.readNumber` and `demo.store`
operation contracts are supported; return values must be primitive. These
externally executed services are **not** guest activations, cannot reenter with
arbitrary callback objects and cannot be rolled back. Input delivery order is
retained for replay, which never invokes the service a second time. Pending
external services without completion may require caller-owned cancellation;
a `timeoutMs` value still fails closed.

These paths have dedicated tests:
`test/natlang-retained-async.test.js`,
`test/natlang-native-services.test.js` and
`test/owned-enumeration-indexing.test.js`. They are bounded smoke/differential
coverage, **not** a general natlang production compatibility claim.

## Bounded static ESM/TypeScript functions

Separately, `tracing-js-self/modules` exposes `linkStaticModules` and
`executeStaticModule` for a completely supplied graph of TS/JS module source
files. The first profile handles named/default function declarations and
import aliases (including pure function-only cycles), with deterministic
renaming into the same strict owned `training-js/1` trace engine:

```js
import {executeStaticModule} from 'tracing-js-self/modules';
const run=executeStaticModule({
  modules:{
    'math.ts':'export function add(a: number, b: number) { return a+b; }',
    'main.ts':`import {add} from './math.ts';
      export function main(x: number) { return add(x,3); }`
  },
  entryModule:'main.ts',exportName:'main',args:[4]
});
// run.result === 7; validateBundle(run.bundle); replayExact(run.bundle)
```

It is not natlang's `evaluateModule` contract or a general module loader:
no retained module objects, mutable live exports, native imports, top-level
side effects or callable-folder `.nl` dependencies. See
[static module contract](STATIC_MODULES.md) for the precise limited profile.

## Pinned natlang contract

Audited against
[`werg/natlang@9738f30fc976d72318adcc789e3051d6cab0f18b`](https://github.com/werg/natlang/tree/9738f30fc976d72318adcc789e3051d6cab0f18b).
Its [evaluator interface](https://github.com/werg/natlang/blob/9738f30fc976d72318adcc789e3051d6cab0f18b/ts-host/src/native/evaluator.ts)
requires:

| Member | Contract |
| --- | --- |
| `authority`, `mode` | Evaluator identity and `fresh` or `retained` realm behavior. |
| `scopeCapabilities` | Whether modules and network are available. |
| `execute(request)` | Synchronous `{ result, events, logs? }`; refuses asynchronous results. |
| `executeAsync(request)` | Promise of the same result shape. |
| `evaluateModule(code, bindings)` | Executes a module body with live bindings and returns its completion. |
| `declarationOf?(name)` | Optional importable-package declaration lookup. |
| `fork()`, `close()` | Fresh environment creation and lifecycle cleanup. |

An evaluation request is `{ code, scope, body, path, timeoutMs?, live? }`.
Portable scope data becomes a frozen snapshot (`self`); live objects, functions,
services, capture cells, and output sinks arrive by reference (`__live`). The
[current environment](https://github.com/werg/natlang/blob/9738f30fc976d72318adcc789e3051d6cab0f18b/ts-host/src/environment.ts)
transpiles TypeScript to ES2022, maps raw `undefined` completion to `null`,
collects console output and host events, and cancels its pending timers on close.
Failures carry observed events and optional stack/log evidence in `EvalFailure`;
natlang uses `instanceof`, so a separately defined lookalike error is insufficient.

There are **two execution seams** to integrate:

1. [`createNatlangRuntime({ environment: () => evaluator })`](https://github.com/werg/natlang/blob/9738f30fc976d72318adcc789e3051d6cab0f18b/ts-host/src/runtime/runtime.ts)
   supplies per-call evaluation environments.
2. [`setModuleRealm(factory)`](https://github.com/werg/natlang/blob/9738f30fc976d72318adcc789e3051d6cab0f18b/ts-host/src/runtime/modules.ts)
   supplies the separate retained realm for callable-folder modules. That loader
   calls `evaluateModule` with `exports`, `module`, `require`, and natlang helper
   bindings. Changing only the per-call factory leaves module JavaScript outside
   the tracer. The [Node wiring](https://github.com/werg/natlang/blob/9738f30fc976d72318adcc789e3051d6cab0f18b/ts-host/src/runtime/node.ts)
   currently installs both independently.

### Open blockers and acceptance gates

The [scope compiler](https://github.com/werg/natlang/blob/9738f30fc976d72318adcc789e3051d6cab0f18b/ts-host/src/scope-compiler.ts)
already emits arrows, closures, destructuring, spread, object methods, standard
built-ins, and `Promise.all`, beyond this runtime's supported grammar. Broader
syntax alone also does not supply owned coercions, object internal methods,
completion propagation, callbacks, modules, or host identity/activation handling.
Those remain language and host implementation work, not an adapter wrapper.

Before claiming natlang compatibility, exercise actual scope-compiler output
through both seams and establish all of the following:

- Scalar and async evaluations, persistent scope helpers, and live capture
  mutation preserve results and identity; unsupported behavior fails explicitly.
- Concurrent typed services complete in either order, with recorded guest-visible
  delivery, callback reentry, and no repeated effects during reconstruction/replay.
- Callable-folder modules import sibling modules and `.nl` functions with correct
  caching and exports. Imported native packages have explicit tracing boundaries.
- Throw/rejection paths preserve earlier effects and compatible failure evidence;
  fork/close behavior and outstanding work ownership match the interface.
- TypeScript lowering retains original source identities and **proved**
  source mappings (not just a V3 source-map sidecar);
  spec/reference tests establish the required JavaScript behavior independently
  of this interpreter's replay.

These are open integration gates. The bounded opt-in adapter above does not
satisfy them; no production natlang runtime wiring changes are included here.

## Megatoken: semantic chunks versus physical records

Audited against
[`werg/megatoken@285672c2e08ebad2e126022f9cb859b47999f1ae`](https://github.com/werg/megatoken/tree/285672c2e08ebad2e126022f9cb859b47999f1ae).
Its [schema version 3](https://github.com/werg/megatoken/blob/285672c2e08ebad2e126022f9cb859b47999f1ae/src/megatoken/data/schema.py)
has ordered `Episode.records`, source `Lineage`, logical action identities,
writer-to-reader dependencies, and optional tracks and causal groups.

A runtime semantic chunk is an execution boundary. Megatoken physical records
are pieces of an original logical event for model processing. Its
[current preparation defaults](https://github.com/werg/megatoken/blob/285672c2e08ebad2e126022f9cb859b47999f1ae/src/megatoken/data/parsing/config.py)
target 512 tokens, with soft/hard maxima of 768/1,024 tokens and a 16,384-byte
limit. These limits must not create guest yields or change external delivery
order. Keep semantic identities while splitting a rendered logical event into
byte-exact, contiguous physical parts, with original source spans and codec
identity. Cached token IDs are separate from IDs observed during generation.

Dependencies must point from an earlier writer to a later reader. Events in one
`Meridian` causal group can attend to each other, so a pre-delivery state and its
future host result must not share that group. Only assistant/document records
can carry policy loss; role, loss mask, executed provenance, action/execution
identity, and source-family split ancestry require deliberate adapter mapping.

The [native episode adapter](https://github.com/werg/megatoken/blob/285672c2e08ebad2e126022f9cb859b47999f1ae/src/megatoken/data/adapters.py)
can consume that schema, but this package does not yet export it. An exporter
must validate real episodes, preserve logical payloads across physical splits,
and prove by perturbation tests that unavailable inputs cannot change an earlier
model-visible prefix. Archive checkpoints, private arrivals, and future outcomes
must stay outside model-visible evidence. The current causal projection is a
limited prototype, not a full visibility proof or evidence of learning quality.
