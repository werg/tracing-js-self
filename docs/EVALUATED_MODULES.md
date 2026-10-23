# Bounded evaluated ES modules (`evaluated-module/1`)

The `tracing-js-self/evaluated-modules` API executes a **bounded subset**
of TypeScript/JavaScript ES module initialization and imported binding
references inside the owned bytecode interpreter. This is separate from
the function-only static linker at `tracing-js-self/modules`.

This implementation is **not** a complete ECMA-262 Module Record implementation,
a Node module loader, a browser loader, a persistent module namespace realm,
or a drop-in natlang callable-folder loader.

## Using the evaluated source graph

```js
import {executeEvaluatedModules} from 'tracing-js-self/evaluated-modules';
import {validateBundle,replayExact} from 'tracing-js-self';

const run=await executeEvaluatedModules({
  modules:{
    'state.ts':`export let count: number = 1;
      export function bump(){count+=1;}`,
    'main.ts':`import {count,bump} from './state.ts';
      export function run(){bump();return count;}`
  },
  entryModule:'main.ts',
  exportName:'run'
});
console.log(run.result); // 2
validateBundle(run.bundle);
replayExact(run.bundle);
```

The `modules` parameter is an explicit **in-memory, plain data object** of
canonical POSIX-relative filenames to source text. The graph is bounded to
64 files, 65,536 characters per file and 262,144 generated characters.
No on-disk lookup, `require`, external package resolution, automatic extension
resolution or native `import()` executes guest source. Host accessor/proxy
module records are rejected without invoking their traps.

The source is lowered with pinned TypeScript 5.9.3 to ES2022, parsed as modules
with Acorn, and rewritten into one strict async guest function. The resulting
function is itself parsed through the owned `training-js/1` frontend **before
execution**, which rejects unsupported grammar and ambient identifiers.
There is no fallback that runs the source in the Node `vm`, native
`Function`, native loader or browser interpreter. The sidecar maps module
files, generated spans, import links and TypeScript V3 source-map metadata; the
authoritative trace uses **executed generated JS** sites, not proven original
TS semantic sites.

## Initialization, mutable bindings and asynchronous results

Module instantiation rewrites each local function declaration to a unique
owned function binding. Each relative imported name refers directly to the
**same renamed lexical cell** as the source export. Thus a function that
mutates an exported `let` is visible through importing code after that call;
the importer never receives a value snapshot. Writes to an imported binding
are rejected before execution. Explicit re-exports and unambiguous `export *`
resolve by the same original binding identity. Direct/indirect export
resolution is checked at link time, including unused imports and re-exports.

Dependencies are evaluated once per graph in depth-first dependency order,
and their bounded module-side effects occur before dependent module bodies.
The linker currently **rejects cycles with effects rather than emulating
full cyclic ECMAScript module instantiation**. Each call to
`executeEvaluatedModules` starts a **fresh** owned realm; state does *not*
persist across calls to this API. Function-only cycles are handled by the
separate, older `static-module/1` linker.

A module may `await` an internally owned Promise during initialization;
the entry also awaits an exported function result. Errors and rejections
remain owned guest completions. If a promise is still pending at quiescence,
the evaluation refuses to publish a completed result. The trace records
all executed operations, owned promise jobs, chunk exits and source sites;
the structural validator and exact replay compare the complete archive.

### Explicit native effects

To opt in to versioned **native services** (not arbitrary Node APIs),
provide the `services` record:

```js
const run=await executeEvaluatedModules({
  modules:{
    'data.js':"export const n=await host.readAsync('sample');",
    'main.js':"import {n} from './data.js';export function run(){return n*2;}"
  },
  entryModule:'main.js',exportName:'run',
  services:{'demo.readAsync':async ({args,signal})=>readSample(args[0],signal)}
});
```

Only the declared `demo.readAsync`, `demo.readNumber` and `demo.store`
contracts are owned at this transport seam. Service effects are journaled
before dispatch. Native service completion is separately recorded as **arrival**
and then **delivery**, so completion order can differ from the guest await
order. Replay reconstructs recorded external inputs and **does not call a
native service a second time**. Host functions, object handles, callbacks,
streaming and arbitrary exceptions are not guest values; transport outcomes
remain the declared primitive codec. An AbortSignal can end a run, but cannot
roll back an already executed external effect.

## Known limits and evidence

- **Not general ESM:** module namespace exotic objects, dynamic `import()`,
  generators, classes, decorators, `import.meta`, CommonJS and package imports
  fail closed. Namespace and cyclic Module Record semantics, ordered accessors,
  complete descriptors and all built-ins remain open.
- **Not a persistent realm:** module initialization and exported function
  invocation share a single owned episode. New `executeEvaluatedModules` calls
  do not share binding cells, heap objects or module caches. The data-only
  retained natlang adapter is a different, limited API.
- **Not full async or native integration:** Promise constructors, thenables,
  arbitrary host callbacks, cancellation of native resources and complete
  Node/browser scheduling are not provided.
- **Not conformance proof:** `test/evaluated-modules.test.js` checks the
  named bounded cases against Node's independent ESM evaluation where
  feasible, verifies deep trace validation and exact replay, and tests
  out-of-order external completions plus unsupported-path rejection. These
  finite regressions do not substitute for Test262 module variants, native
  browser/Node coverage or an admitted megatoken training dataset.

This endpoint is appropriate for explicit experiments and candidate
traces only. Keep `coverage/required.json` and `docs/STATUS.md`
as the release gate source of truth.
