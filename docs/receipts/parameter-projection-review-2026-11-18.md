# Independent parameter-projection review

**Reviewed at 2026-11-18 14:32:57 UTC.** The reviewed implementation worktree was
`tracing-parameter-projection`, ending at
`218b43e24a5250478a5ce8d3d2e1838bfe726418`. This was a read-only source review plus
targeted local verification probes. The reviewer did not edit the implementation
worktree, frozen producer/consumer checkouts, or original evidence. No full suite,
native qualification, optimizer update or model evaluation was repeated.

## Findings

### TDZ propagation regression found and fixed

The initial TDZ commit, `1e0a732` (published as
`f75342885d838eb3027346a22a7d5a3570b6c553`), failed this bounded owned execution:

```js
"use strict";
function fail(a = b, b = 3) {}
function run() { return {valueOf: fail} + 1; }
```

The genuine parameter `GuestFault` was marked at its original read. The same
completion later propagated through the owned arithmetic continuation. Structural
validation incorrectly treated the propagated marker as a second original
parameter access and required a fresh allocation. The result was `teacher_failed`
with `Invalid committed parameter TDZ exception`. Catching the coercion error
reproduced the defect.

Implementation commit `64ad520bd79a43721d29aaa24ed7082d4041f0e0` fixes this by
authenticating the original completion and requiring an exact match against the
prior owned operation at `spec.operation.complete`. The reviewer independently
reran both uncaught and caught reproducers: both now pass owned validation/replay
and reach the existing explicit `projection_refused` boundary for unallocated
function identities installed as object coercion hooks. This is a repaired owned
execution/validation path, not new native object-coercion support.

### No internal-error promotion found

Fresh TDZ markers originate only from the private `GuestFault` class when reading,
testing, assigning or updating an uninitialized parameter cell. Validation checks
the actual prior frame instruction, nearest parameter environment, source site,
exception type/message, origin and exact newly allocated name/message data leaf.
The original object is reused by completion routing; it is not reconstructed
from a future heap.

Interpreter errors use different exception paths. Resource exhaustion occurs
outside this marker boundary. The review found no path promoting an ordinary
internal error, invalid opcode or resource failure to a positive guest exception.
This assessment concerns the bounded name/message profile, not native Error
prototype, descriptor, stack or constructor semantics.

Six additional TDZ completion probes locally verified: async helper rejection
caught by `await`, async `finally` return replacement, catch/rethrow, synchronous
`finally` throw replacement, a parameter error thrown from `finally`, and a
synchronous failing helper unwinding into an async root. These are local source
and replay checks, not native admissions.

### Forward closure deferral is conservatively bounded

The implementation defers one closure allocation and its initializing parameter
write only across a same-frame, exact-parameter-environment interval containing
default guards, literal materialization, jumps and parameter initialization.
Other operations, abrupt completions and heap/effect/input/promise/control
mutations refuse projection. An unresolved final state also refuses.

Capture environment/name/code identities are fixed at the original allocation.
Emission uses cells only after their actual initializing events commit, rejects
unpublished captured identities, and compares existing public cell values.
The private certificate records the original allocation, complete intervening
event chain, captured cells and actual initialization boundary. No public trace,
controller or native schema change was present in the reviewed diff.

Eight focused positive probes locally verified:

| Case | Checked result |
| --- | --- |
| Outer `b=99`, closure created before parameter `b=3` | Returns `3`, never the outer namesake |
| Provided object captured as `b`, later `b.x=5` | Preserves object identity and observes mutation |
| `return [a(), b=5, a()]` | Returns `[3,5,5]` through the shared parameter cell |
| Body `var b=5` | Returns body `5` and captured parameter `3` separately |
| Alias `c=a` created after `b` initializes | Returns `[true,5]` after parameter assignment |
| Async root with forward default closure | Returns `3` through root promise completion |
| Later parameter `b` has no default | Captures the genuinely initialized `undefined` |
| Closure references later `c=4` across intervening `b=3` | Returns `4` after all required captures commit |

The post-initialization alias case also passed
`recheckEffectfulAdmission(..., {requireAdmitted:false})`, including identity,
journal, source, replay and effects checks.

Nine valid negative probes refused the intended deferred region: early call,
early alias read, assignment escaping the closure to an outer binding, early
`typeof`, early parameter reassignment, a fresh object default, self-capture, a
properly fixtured host operation in a later default, and a later default calling
a throwing helper. Refusal occurs before any unsafe public allocation is emitted.

No blocking defect was found in the reviewed forward-deferral implementation.
Its restricted commutation rule should remain explicit; these results do not
justify general delayed allocation across arbitrary computations or effects.

## Remaining preexisting replay defect

The review also identified a separate startup failure without any TDZ:

```js
"use strict";
async function fail() { throw 7; }
function run() { return fail().catch(e => e); }
```

This returns `teacher_failed` / `Cannot compile/start archived source`.
`replayExact` derives `allowAsync` solely from the root frame's promise, while
`startEntry` rejects any async top-level declaration when that flag is false.
A synchronous root can legitimately call an async helper and return its promise.
This blocks that composition before the new parameter projection is reached.
It was reported to the implementation owner and parent; no repair is claimed in
this snapshot. A repair should preserve the original compilation capability
independently of root completion kind, while retaining source/program equality
checks and adding both successful and rejected async-helper cases.

## Source bindings for this review

| File | SHA-256 |
| --- | --- |
| `src/runtime.js` | `589ac56ed827989cc1f98d43635903873266617b13500001d2e2bdb62e7679cb` |
| `src/validation.js` | `39d295ae5c03e415423d4b6890935d67ab8813a66b79727cb1ed68c92cb1dfa8` |
| `src/replay.js` | `a1391b5d11c3f0f364b05460e194b22c8537139d526c6187e175ec10eb44dc53` |
| `src/semantic/normalize.js` | `52b340051a01ccb94b1fb871e6ea0856680bc01e5621cf6c72d95661de922160` |
| `src/training/completion-facts.js` | `b1ddf97aac8bc2db8fd4ae034787b6843afde06211270c108cdddf80796bd6b5` |
| `src/training/effectful-admit.js` | `256c7f9e4f01095f73107cf6b8731016e000cf567a4b7e57879c6ecf599e4cfc` |
| `src/training/effectful-compiler.js` | `a55f71f707666d5fab51f36c52e8fd322d0f719d6ca20dba1ebff0108bf3692b` |
