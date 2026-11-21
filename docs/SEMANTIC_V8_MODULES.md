# Source-qualified module regions

`verifyRegionModuleTrainingCase` connects the existing bounded evaluated-module
linker to v8 source admission. It supports the linker's live lexical cells,
synchronous cycles, acyclic top-level await, named/default exports, and bounded
ordered export calls in one owned episode. The profile is
`evaluated-module-regions/1`; it does not claim a complete ECMAScript Module
Record implementation.

```js
import {verifyRegionModuleTrainingCase,recheckRegionEvidence}
  from 'tracing-js-self/semantic';

const checked=await verifyRegionModuleTrainingCase({
  id:'live-counter',family:'live-counter',entryModule:'main.js',exportName:'run',
  modules:{
    'state.js':'export let count=1;export function bump(){count++;}',
    'main.js':'import {count,bump} from "./state.js";export function run(){bump();return count;}'
  },args:[],fixture:{calls:[]}
});
if(checked.exported)await recheckRegionEvidence(checked.exported);
```

## Independent authorities

The adapter first links and validates the actual generated JavaScript through
the strict owned frontend. A separate Node process executes the original
dependency graph as native ESM with `SourceTextModule`. That reference has no
filesystem loader, package imports, timers, or native service capabilities;
only relative dependencies in the declared in-memory graph resolve.
Process, synchronous VM, asynchronous completion, input, and output bounds are
explicit. Native ESM is a reference authority, never the producer's execution
path.

The producer runs its generated JavaScript through owned execution, archive
validation, exact replay, independent outcome and intermediate-source checks,
and v8 compact/detailed projection. The adapter additionally compares the native
module outcome with that source-qualified outcome as rooted graphs. Immutable
input anchors preserve mutations, aliases, holes, property order, and returned
identities. Caller objects are imported into fresh realms; the reference does
not mutate the caller's inputs.

The original sources, dependency links, initialization spans, exact generated
source digest, source maps, and native reference receipt are private evidence
inside the source artifact's existing provenance. They are covered by its
source-artifact digest. Production rechecking regenerates the link and reruns
the native module reference before native v8 admission. Altering original
module sources or their input graph cannot silently preserve admission.
Private outcomes and source maps never enter public model contexts or target
loss.

## TypeScript

TypeScript 5.9.3 lowers each file to ES2022 before both ESM reference execution
and owned linking. Original source and V3 source maps remain available as
provenance. Erased types and runtime-emitting constructs are tested separately:
the release tests include a typed object parameter and a function-local enum.
The evidence certifies the JavaScript actually executed. It does not claim that
successful transpilation proves ownership or that source-map anchors prove all
TypeScript semantics.

## Boundaries

The owned linker supports bounded async dependency cycles through retained
DFS/SCC scheduling. That scheduler, including parallel top-level await, remains
explicitly refused by this public/native module-source adapter. Owned execution
and original-ESM differential tests are distinct from source/data admission.
The linker still refuses dynamic imports, escaping module namespace objects,
namespace method receivers, import writes, and other unowned syntax. The reference data boundary
accepts ordinary returned graphs and primitive completions; custom prototypes,
accessors, Symbols, and other exotic return values remain separate profiles.
Ambient/native services are not supplied by this source-graph reference.
Nondeterministic programs cannot pass by assuming a shared native clock or RNG.

This adapter starts one fresh owned module episode. It does not reuse the
historical replay-backed module-session facade as a resumable model checkpoint.
V8 continuation, exact native-consumer admission, tokenizer measurement, and
model execution are independent gates. A successful module-source comparison
does not mark those later gates passed.
