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

## Namespace-style static reads (not exotic namespace objects)

A bounded `import * as ns from './module.js'` is supported only when every
runtime use of `ns` is a **statically named property read** (`ns.value` or
`ns['value']`). The frontend resolves that reference to the original exported
binding, so mutation through a **separately named-imported** function remains
visible. Direct `ns.fn()` is rejected because its `this` receiver is a module
namespace exotic, whereas a bare rewritten `fn()` would have `undefined`
as its strict receiver.
Assignments to `ns.value`, dynamic keys (`ns[key]`), escaping `ns` as a
value, arbitrary reflection, `Object.keys(ns)`, and namespace re-exports are
not implemented. They fail at linking instead of substituting an ordinary
mutable JavaScript object for the ECMAScript module namespace exotic.

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
Synchronous cyclic imports follow DFS dependency initialization, with
function declarations instantiated before module bodies and mutable lexical
reads referencing the original owned binding. A cyclic read before
initialization produces a guest abrupt completion. Cycles with top-level
`await` fail closed: the current machine has no complete ESM async-dependency
or deadlock scheduler. Each call to `executeEvaluatedModules` starts a
**fresh** owned realm; state does not persist across separate calls.

A module may `await` an internally owned Promise during initialization;
the entry also awaits an exported function result. Errors and rejections
remain owned guest completions. If a promise is still pending at quiescence,
the evaluation refuses to publish a completed result. The trace records
all executed operations, owned promise jobs, chunk exits and source sites;
the structural validator and exact replay compare the complete archive.

### Ordered calls in a single owned module episode

An optional `calls` array invokes multiple named/default exports **after
one module initialization**, in the same owned guest activation. Intermediate
calls may update exported `let` cells, guest heap objects and owned promises.
Later calls observe those mutations; the output is an array of their results.

```js
const run=await executeEvaluatedModules({
  modules:{
    'counter.js':`export let count=0;
      export function increment(){count+=1;return count;}
      export function read(){return count;}`
  },
  entryModule:'counter.js',
  calls:[
    {exportName:'increment',args:[]},
    {exportName:'increment',args:[]},
    {exportName:'read',args:[]}
  ]
});
console.log(run.result); // [1,2,2]
```

`calls` is a bounded dense array of 1–32 plain data records with a
`exportName` and up to 64 positional `args` per call. The ordinary
single-invocation `args` array is mutually exclusive with `calls`.
The adapter reads **own data descriptors**, refusing host getters, Proxy
traps and sparse arrays. The owned entry imports those arguments as data
graphs before any guest operation; it does not keep live host object handles.
The ordered export calls execute in one replayable trace, **not** as separate
native evaluator invocations. A second API call **reinstantiates** every
module; this feature is not a persistent cross-call module realm.

### Bounded replay-backed cross-invocation session

`tracing-js-self/evaluated-module-session` provides
`createBoundedRetainedModuleSession({modules,entryModule})`. Its calls are
serialized and **observationally retain** module `let` mutations and reachable
ordinary data-object identities across independent JavaScript API invocations:

```js
import {createBoundedRetainedModuleSession}
  from 'tracing-js-self/evaluated-module-session';

const session=createBoundedRetainedModuleSession({
  modules:{'main.js':`export const state={n:0};
    export function read(){return state;}
    export function bump(){state.n+=1;return state.n;}`},
  entryModule:'main.js'
});
const state=(await session.invoke('read')).result;
await session.invoke('bump'); // returns 1
console.log(state.n); // 1: same returned data-object identity
session.close();
```

This session intentionally runs a **fresh deterministic owned replay of the
entire committed call history** for each new invocation, rather than
suspending/restoring a VM checkpoint between calls. It normalizes heap
allocation identities independently of the growing argument graph and
reconciles previously returned ordinary data objects in place. It snapshots
its module sources, does not expose native guest handles, supports primitive
positional arguments only, and commits a history entry only after successful
validation and exact replay. This is capped at **32 calls**, is not durable
storage, and is unsuitable for unbounded or performance-critical workloads.

### JSON-portable retained-history restoration

A bounded replay-backed session can now export a JSON snapshot of its
**committed** module source graph and primitive invocation history. This allows
a later process to reconstruct observational module state by executing the
same owned calls again. Special scalar values such as -0, NaN, undefined
and BigInt use tagged JSON-safe values.

~~~js
import {
  createBoundedRetainedModuleSession,
  restoreBoundedRetainedModuleSession
} from 'tracing-js-self/evaluated-module-session';

const session=createBoundedRetainedModuleSession({
  modules:{'main.js':'export let n=0;export function add(x){n+=x;return n;}'},
  entryModule:'main.js'
});
await session.invoke('add',[3]);
const saved=JSON.stringify(session.snapshot()); // persist using trusted storage
session.close();

const recovered=await restoreBoundedRetainedModuleSession(JSON.parse(saved));
console.log((await recovered.invoke('add',[4])).result); // 7
recovered.close();
~~~

The restore API verifies own-data snapshot records and canonical scalar
tokens, then runs the same ordinary owned evaluation, validation and exact
replay checks for every committed call. It never restores original host
object identities or an actual paused ECMA-262 Module Record; identities
within the *new* session are stable only from that point forward. The
snapshot itself is not authenticated or encrypted: if untrusted storage
is used, the caller must supply an external trusted digest/signature and
confidentiality controls. It is not an accepted model-training Episode or
natlang's production setModuleRealm replacement.

Native services are **forbidden** in this replay-backed mode: replaying earlier
calls must never reissue irreversible host effects. General callable closures
crossing the host boundary, mutable input object references, module namespace
exotics, arbitrary asynchronous native callbacks and physical continuation
restoration are not supported. This is a limited *observational* persistence
facility, **not** the complete ECMA-262 retained Module Record realm required
for production natlang compatibility.

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

- **Not general ESM:** first-class module namespace exotic objects, dynamic `import()`,
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

The experimental `werg/natlang` Node platform exposes an explicit
`installOwnedTracingEnvironment(factory)` integration point for the two
evaluator seams. This does **not** make callable-folder modules, native helper
callbacks, complete source mapping, or arbitrary modules compatible.

This endpoint is appropriate for explicit experiments and candidate
traces only. Keep `coverage/required.json` and `docs/STATUS.md`
as the release gate source of truth.
