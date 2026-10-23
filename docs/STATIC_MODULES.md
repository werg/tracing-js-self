# Static ESM/TypeScript function graph (static-module/1)

This is an **opt-in, bounded source linker**, not complete ES module
instantiation/evaluation, arbitrary TypeScript execution or natlang's retained
CommonJS-like module realm. Module source is compiled using pinned TypeScript
5.9.3 to ES2022, parsed as ECMAScript modules by Acorn and lowered into
`training-js/1` source, then executed by the owned serializable bytecode VM.
The native Node loader, `vm`, `Function` constructor and `require` never
execute this guest source. The independent test oracle may run fixture code in
a separate V8 context.

```js
import {executeStaticModule} from 'tracing-js-self/modules';
import {validateBundle,replayExact} from 'tracing-js-self';

const run=executeStaticModule({
  modules:{
    'arith.ts':'export function twice(x: number) { return x * 2; }',
    'main.ts':`import {twice} from './arith.ts';
      export function compute(x: number) { return twice(x) + 1; }`
  },
  entryModule:'main.ts',exportName:'compute',args:[4]
});
console.log(run.result); // 9
validateBundle(run.bundle);
replayExact(run.bundle);
```

## Owned profile boundary

- Explicit relative imports must resolve to supplied in-memory module source
  paths. External packages, implicit extension resolution and filesystem access
  are rejected; unreachable modules never enter the executable source bundle.
- Each module may declare ordinary named functions; named/default function
  exports and named/default import aliases are permitted. Function-only cycles
  work through linked function bindings. Explicit named re-exports and
  `export * from` resolve through supplied graphs, including cycles and
  diamond forwarding. The same underlying function binding is not an ambiguous
  star export; distinct origins are ambiguous, and stars never forward default.
  The runtime still rejects async/generator functions, classes, general
  top-level statements, mutable exports, namespace imports/re-exports,
  general executable module side effects, dynamic imports and top-level initialization. Inert side-effect-only imports and empty-source re-exports are now permitted only when their entire reachable dependency graph is function-only; declared runtime dependencies erased by TypeScript import elision are still visited and validated.
- Linking uses conservative identifier substitution, preserving object-literal
  shorthand property names, and rejects shadowing or assignment of linked
  imported function names rather than silently changing ES module semantics. Ordinary calls, arithmetic, loops, captured closures
  and the strict profile's named built-ins execute via the owned VM.
- The resulting generated program has an explicit `"use strict"` directive,
  no guest module loader or implicit host calls. It has deterministic synthetic
  function names, lexical identities, static import links and source file
  metadata in the `metadata` sidecar.
- `metadata.modules[].sourceMap` contains the TypeScript V3 source map for
  each original module; `metadata.functions` retains function-to-generated-
  code spans. Exact original-TS instruction-to-site mapping is not proven,
  and source-map metadata is not part of the journal replay authority.

## Evidence and limits

`test/static-modules.test.js` compares a real Node ESM loader evaluation with
an owned function graph for one fixture, checks local independent V8 results,
reconstructs and exactly replays a TS linked trace, covers function-only cycles,
named forwarding, star diamonds, ambiguous exports and shorthand-key preservation,
rejects unsupported module forms and verifies that unused private module source
is excluded. These are finite differential probes, **not** a Test262 module
conformance result or training-data admission proof.

For natlang's actual `setModuleRealm` seam, live `exports`/`module`/`require`
objects, package services, callable-folder modules, module cache and async
completions still require separate owned semantics. This static linker must
not be substituted as a claimed drop-in.
