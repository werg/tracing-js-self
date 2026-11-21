# Bounded owned module scheduling

`executeEvaluatedModules` evaluates guest source in the owned runtime. Native
ESM is used only by independent reference tests. This implementation does not
claim complete ESM, public source qualification for the new scheduler, or a
durable host module loader.

## Independent async branches

A dependency postorder is not an execution schedule when a module suspends at
top-level await. If the first dependency records `a`, awaits, then records `A`,
and an independent sibling records `b`, awaits, then records `B`, native ESM
records `abAB`. Executing concatenated module bodies instead records `aAbB`.
A synchronous sibling must also start before the first dependency resumes.

The linker chooses `metadata.evaluationStrategy =
"async-dependency-scheduler"` whenever a later module does not depend on an
earlier module with syntactic top-level await, or a reachable cyclic graph
contains top-level await. Such graphs use one retained
generator environment per module. All generators are instantiated and primed
before evaluation. Their initial yield publishes getters for lexical cells;
creating those getters does not read uninitialized `let` or `const` bindings.
Function declarations are already initialized. Imported reads and static
namespace reads call the getter for the original binding, preserving identity,
mutable values, closures, and temporal dead zones.

When a namespace identity or exotic operation escapes static lowering, the
linker builds its module-namespace object after all module environments are
primed and before any module body runs. Its getter functions therefore close
over the same retained live cells used by ordinary imports, including cycles.
Descriptor reads resume through a serialized caller continuation, so a cyclic
TDZ error remains the getter's abrupt completion across a JSON checkpoint.

Only awaits at module scope become parenthesized generator yields. Awaits in
nested async functions remain ordinary async-function syntax. An owned async
driver awaits each yielded operand and resumes the generator with either its
fulfilled value or its thrown rejection. That uses existing owned Promise and
generator continuations, including synchronous then-getter lookup, thenable
assimilation, and catch/finally unwinding.

Every module has an owned record containing its status, dependencies, async
parent indices, pending dependency count, async evaluation order, DFS and
ancestor indices, cycle root, started flag, generator, execution Promise, and
failure value. Completion of an async driver runs one
Promise reaction. That reaction gathers ready ancestors before executing them
in DFS async order. Synchronous ancestors run in that same reaction; each async
ancestor starts its own driver. There are no extra Promise jobs per dependency
edge. Shared dependencies execute once. An async rejection skips its dependent
ancestors while already-started independent siblings continue. A synchronous
throw during the initial DFS stops evaluation of later, unvisited siblings.

The dependency and completion rules follow ECMA-262 2026
[InnerModuleEvaluation, ExecuteAsyncModule, GatherAvailableAncestors, and
AsyncModuleExecutionFulfilled/Rejected](https://tc39.es/ecma262/2026/multipage/ecmascript-language-scripts-and-modules.html#sec-innermoduleevaluation),
checked against [specification source revision
`d89c03f2db8a597bc915b363a6518d0cc8acdbc0`](https://github.com/tc39/ecma262/blob/d89c03f2db8a597bc915b363a6518d0cc8acdbc0/spec.html).

## Cyclic async components

DFS keeps each module on its stack in `evaluating` state until its strongly
connected component closes. A synchronous body finishing during DFS does not
change that status prematurely. At component closure each member names the
same cycle root and becomes either `evaluated` or `evaluating-async`, depending
on whether it has asynchronous work remaining.

An import of a closed component depends on its root, including an import of a
member whose own synchronous body already ran. This prevents an outside module
from overtaking unfinished work elsewhere in that cycle. An active DFS
back-edge instead updates the ancestor index without inventing a dependency
on a module that has not yet been assigned async work.

Async completion gathers the entire available ancestor set before running any
member, checks errors on each ancestor's cycle root, and executes the set in
ascending async evaluation order. Rejections retain their original guest value
and propagate to async parents. Already-started unrelated work can still finish;
an unresolved await leaves evaluation pending rather than creating an artificial
cycle error. Every body has an explicit started flag to prevent a second start.

## Existing synchronous and single-chain graphs

All-synchronous graphs, and acyclic single-chain graphs whose evaluation does
not require concurrent branches, retain the
`dependency-concatenation` representation used by the already-qualified module
source fixtures. Syntactically async modules now have an explicit completion
job before dependent bodies execute. This boundary exists even when an await
appears only in an untaken branch. An export invocation follows completion of
graph evaluation. These boundaries prevent queued module work from being
overtaken by dependent initializers or the invocation.

Nested async functions do not make a module syntactically async. In particular,
their await expressions no longer cause an otherwise synchronous cycle to be
rejected as an async cycle.

## Minimal `import.meta` host

Each linked module receives one distinct, stable, extensible object with a null
prototype and no host-supplied properties. The linker creates it before module
evaluation, so closures and repeated `import.meta` reads share the same object;
guest property writes remain local to the owning module. The declared policy is
`empty-null-prototype`, matching Node's default `vm.SourceTextModule` import-meta
initialization when no `initializeImportMeta` hook is supplied. Original source
differentials cover identity, prototype, per-module separation, mutation across
calls, and JSON-history restoration of the bounded replay-backed session.

This profile does not provide `url`, `resolve`, host-added metadata, or a
general native loader. Session restoration replays committed calls and module
source; it is not restoration of a live native or guest module record. The
owned `evaluated-module/1` result names the policy, while public source/native
qualification for broader module behavior remains separate.

## Original JavaScript and TypeScript provenance

Original `.js`, `.mjs`, and `.cjs` text now passes through
`compileBoundedTypeScript` byte for byte, with the explicit compiler label
`identity-javascript/1` and an identity source map. The owned parser still
checks all source syntax before execution. The extension does not grant
CommonJS semantics; these entry points still accept the declared ESM profile.

This fixes an observed TypeScript 5.9.3 emitter defect in the previous path,
which unnecessarily transformed JavaScript. For example:

```js
import { add } from './state.js';
const value = await {
  get then() {
    return function (resolve) { resolve(7); };
  }
};
queueMicrotask(() => add('q'));
```

Passing this module through the pinned `transpileModule` emitted the final
`queueMicrotask` statement twice without a diagnostic. The independent original
ESM scheduler test found `agbtpB7qqm` in owned execution versus native
`agbtpB7qm`; exact JavaScript pass-through removes the duplicate. This is a
source transformation defect, not a Promise or scheduler allowance.

Typed TypeScript still uses the pinned TypeScript compiler. Its original text
and source maps are provenance, and generated JavaScript is the semantic input.
Historical TS-generated evidence is not relabeled as proof about original TS
semantics. The new JavaScript path does not establish general TS transformation
equivalence or fix the upstream emitter.

## Saved state and evidence

Scheduler records, module environments, pending awaits, Promise reactions, and
generator program counters are all ordinary owned state. Tests restore a JSON
copy at instantiation, await suspension, and queued completion boundaries and
require an identical final archive, independent validation, and exact replay.
A pending-host-input test restores two suspended sibling reads, delivers their
results in reverse order, and proves that neither initialization nor native
dispatch runs again.

Cyclic controls also restore during open DFS traversal, after a component has
closed, and between an async member's completion and its ancestor's start.
Two suspended host reads within one component resume in both arrival orders;
each continuation retains live cells, pending counts, job order, and the exact
final archive without dispatching the saved reads again. An unresolved cyclic
await retains a pending evaluation capability across restore, in agreement
with independently linked original ESM in a native VM.

These snapshots are internal serialized VM state. Generated scheduler field
assignments consist of individual bytecode steps, so a snapshot can retain a
partially completed scheduler action. Final archive validation and exact replay
check its execution history; this is not a public arbitrary-snapshot admission
API or an independent native module-state validator.

The native differentials execute the original ESM files with Node's loader.
They cover siblings, shared diamonds, DFS ancestor ordering, untaken awaits,
then getters and competing microtasks, nested awaits, caught rejection,
finally, live imports, namespace reads, lexical TDZ, hoisted functions,
initial/async throws, and continued independent work after failure.
The cyclic population additionally covers self-import, one and two async
members, an outside import of a completed non-root member, cyclic live cells
and TDZ, untaken awaits, root-error gating of waiting members, and synchronous
failure while an SCC is still on the DFS stack.

These are owned-runtime and original-source differential results. The new
scheduler is not promoted to the public/native source-qualified trace lane.
No test count here represents general Test262 or full ESM conformance.

## Remaining boundaries

- The SCC scheduler is owned execution only. Its public module transitions,
  independently implemented native semantics, and data admission remain
  unqualified; the module source adapter explicitly refuses promotion even if
  saved proof metadata claims a different evaluation strategy.
- The owned module-namespace slice covers identity, receiver calls, live reads,
  own-key ordering, selected reflection and Set/Define/Delete semantics. It has
  no qualified public/native heap projection; namespace-valued outputs,
  Object.getOwnPropertyDescriptors and Object.values/entries/assign getter
  continuations, namespace proxies,
  for-in/spread/destructuring and `Object.prototype.toString.call` remain
  outside the slice. Dynamic imports, top-level classes, general module
  declarations, import attributes, package resolution and a native host loader
  remain outside this bounded profile.
- Top-level `for await` needs an owned async-iterator continuation and is
  refused by the scheduler. Nested async generators remain outside the owned
  generator profile.
- Arbitrary intrinsic mutation, Promise species/subclasses, and host unhandled
  rejection policy remain separate Promise/runtime boundaries.
- The existing retained-module-session convenience API still replays its
  committed call history. The generator snapshots tested here retain actual
  VM state; they do not turn that convenience API into a durable host session.
