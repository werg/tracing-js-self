# V8 synchronous generator continuation protocol

`synchronous-generator/1` is an explicit component of the separately pinned
v8 protocol machine. It uses the canonical `protocol ` JSON line family and
the same authoritative heap, lexical cells, receiver, capture aliases and
scoped call frames as property access and ordinary functions. The component
does not execute JavaScript, restore an archived frame, or accept a program
counter, operand stack, journal patch or whole-state result as a target.

## State and records

A declared closure carries `generatorFunction:true`. `generator.function`
installs the exact name/length/prototype descriptors and allocates a fresh
ordinary prototype object. Its internal prototype is the named intrinsic
`Generator.prototype`; the closure's internal prototype is
`GeneratorFunction.prototype`. The registered ordinary prototype names also
include `Iterator.prototype`. Those names are metadata identities, not public
callable values or arbitrary strings accepted as prototypes.

An instance is a heap node with these exact fields:

```js
{
  kind: 'generator',
  callee: ['ref', functionId],
  invocation: invocationId,
  receiver: value,
  arguments: [value],
  phase: 'initializing' | 'suspendedStart' | 'executing' |
         'suspendedYield' | 'completed',
  resume: null | {
    kind: 'next' | 'return' | 'throw',
    from: 'suspendedStart' | 'suspendedYield',
    value
  },
  pending: null | {kind: 'return' | 'throw', value},
  yielded: integer,
  handlers: [{name, catch: boolean, finally: boolean,
    phase: 'try' | 'catch' | 'finally', caught: null | value,
    pending: null | {kind: 'normal' | 'return' | 'throw', value}}],
  delegation: null | {iterator: ['ref', iteratorId],
    next: 'Iterator.next' | 'Generator.next',
    request: {kind: 'next' | 'return' | 'throw', value},
    phase: 'ready' | 'calling' | 'result' | 'complete' | 'yielded',
    result: null | ['ref', resultId]},
  prototype: ['ref', prototypeId] | 'Generator.prototype',
  properties: Map
}
```

Common descriptor metadata (`descriptors`, `keyOrder`, `extensible`) can be
present on the same node. There is no second generator heap or top-level
generator state table. Handler records retain exact thrown values and pending
cleanup completions, including when a `finally` body yields. Delegation retains
the exact iterator, cached next method, sent completion and result identity.
Unknown state fields fail
restoration. The function's prototype property is read on each creation; a
primitive property value selects the intrinsic fallback, while an ordinary
reference preserves the actual identity.

| Record | Meaning |
| --- | --- |
| `generator.function` | Declare an existing ordinary closure as a nonconstructible generator and allocate its prototype. |
| `generator.create` | Allocate an instance and enter its parameter initialization using a fresh invocation. |
| `generator.start` | Suspend before body evaluation and return the instance identity. |
| `generator.resume` | Reactivate the same retained invocation with next, return or throw input. |
| `generator.receive` | Consume a normal sent value, optionally binding an existing public cell name; the initial next argument is ignored. |
| `generator.handler.enter` | Enter a distinct catch/finally obligation. |
| `generator.handler.route` | Select the catch or cleanup continuation for an exact normal, return or throw completion. |
| `generator.handler.catch` | Consume the selected thrown value, optionally binding its public catch cell. |
| `generator.handler.leave` | Finish cleanup and resume its retained completion, preserving outer obligations. |
| `generator.delegate.enter` | Capture a qualified iterator and its current next method once. |
| `generator.delegate.call` | Execute the selected checked iterator step or generator resume with the retained receiver and input. |
| `generator.delegate.result` | Consume the exact delegated result identity and check its completion state. |
| `generator.delegate.yield` | Suspend with the delegate's original result object, without allocating a replacement. |
| `generator.delegate.receive` | Retain the next caller input for delegation, including return and throw. |
| `generator.delegate.end` | Consume the completed delegate value and preserve return precedence. |
| `generator.delegate.absent` | Propagate a return input when the delegated return method is absent. |
| `generator.delegate.abrupt` | Route the exact thrown delegated completion through the outer handlers. |
| `generator.yield` | Allocate a fresh `{value,done:false}`, suspend, and restore the caller's receiver and capture aliases. |
| `generator.finish` | Complete the retained invocation with a fresh done result or exact thrown value. |
| `generator.completed` | Handle completed next/return/throw, including return/throw before the body starts. |
| `generator.lookup` | Check selection of a generator or shared iterator builtin through the actual prototype chain. |
| `generator.read` | Check non-callable property results without invoking accessors. |
| `generator.identity` | Preserve the generator's iterable identity. |

The exact ordered field lists are exported as `GENERATOR_RECORD_FIELDS`.
Arguments and outputs use the lossless v8 scalar, reference and Symbol value
grammar. A resumable invocation cannot be duplicated or simultaneously active.
A normal resume must consume its sent value before body work; an abrupt resume
cannot be converted to an unrelated result. A direct ordinary call or completion
cannot bypass generator creation, suspension or completion semantics.

## Shared component interface

The trusted machine API adds `complete(controller, {kind,value,invocation})`,
which restores exactly the same caller scope as ordinary return/throw. The
internal call option `{generator:true,resume:true}` permits reusing an inactive
invocation only when it still names the same source callable. Public records
cannot supply these options.

The static machine adapter declares `ordinaryHeapKinds:['generator']`,
`intrinsicPrototypes:GENERATOR_INTRINSICS_V8`, and the intrinsic resolver plus
call/transition guards. Common property operations, checkpoint restoration and
compact-data guards therefore share the same ordinary property state.
Intrinsic function identities remain outside generic property values and must
use their declared callable protocol.

## Evidence and limits

`test/semantic-protocol-generator-v8.test.js` compares lifecycle values with
native generators and checks receiver/capture restoration, initial next
argument suppression, early return/throw, permanent completion, prototype
replacement, reentry, transactional rejection, and malformed restoration.
`test/fixtures/semantic-generator-v8.json` freezes complete controller sequences
for normal sent values, return before body execution, thrown resumption,
cleanup suspension, and delegation through builtin iterators and generators.
These are explicitly component fixtures, not source/native admission receipts.

`synchronous-generator-source/1` now projects strict source generators with
simple parameters through that same machine. It checks exact callable,
prototype, retained invocation, original receiver/arguments, capture aliases,
sent values, yield-result identities, nested catch/finally obligations, terminal
return/throw and permanent completion. A cleanup body may yield repeatedly;
its pending completion remains checked until resumed or overridden by a new
explicit return/throw. Compact arithmetic can run before and after suspension. Public
contexts and JSON checkpoints replay the retained invocation without entering
the generator body again.

`yield*` admits standard array/string iterators and qualified synchronous
generators, including nested delegation, caught throws, permanent completion
and cleanup that yields during a forwarded return. Cached next selection is
preserved even when the generator prototype later changes. Return and throw
methods are selected when their corresponding input arrives. Each delegated
call contains one existing checked iterator-step or generator-resume record;
it cannot substitute a different receiver, input or result object.

Once a delegated result is yielded, the caller can mutate that ordinary result
object. Restoration retains its identity without rereading `done`: the generator
already consumed that value before suspension. The next delegated call consumes
its own fresh result and completion decision.

For normal delegation completion, the source projection includes a checked
ordinary read of the final result's `value` before `generator.delegate.end`.
The enclosing body can return that value, compute with it, or discard it and
return a different value. Component replay therefore does not force every outer
completion to equal the delegate's completion. Independent source rechecking
rebuilds the full body projection and rejects a changed outer completion even
when its self-reported public digest is updated. Public component replay remains
a separate gate from source correspondence.

The independent V8 observer intercepts only the calls selected by the source;
it neither advances a generator to inspect it nor substitutes an owned result.
It records actual creation, resume, suspension and completion state together
with callee/receiver/argument identity and own descriptors. Iterator and Number
call observers compose through one shared invocation dispatcher. Hidden
lifecycle mutants with unchanged scalar outcomes fail the metadata audit.
Independent creation and resume receipts also compare the actual invocation
arguments, including ignored first-next inputs and abrupt inputs later
overridden by cleanup. They remain private reference evidence and do not
replace any public continuation transition.
Native consumer qualification remains a separate exact-contract gate.

The source adapter explicitly refuses custom delegated callables/accessors,
the absent-throw TypeError continuation of builtin iterators, loop-target cleanup,
generator own-property mutation, parameter expressions and async generators.
Implicit exotic failures require their separately checked abrupt continuations.
Hoisted closures may retain declared capture cells before initialization. The
source projection publishes no placeholder or future value for those cells;
generator creation and resumption require their initializers to have committed.
An early call with an uninitialized capture remains an explicit source refusal.
Initialized lexical closures retain the same live cells across suspension.

The public machine is bounded to 4,096 generator allocations, yields and
arguments, with the enclosing protocol's call-depth and record-count limits.
Async generators, general custom iterator delegation, builtin function values,
exotic prototype getters and host transport require separately qualified
profiles. Existing v6/v7 value and continuation contracts remain unchanged.

Semantic reference: [ECMAScript 2026 Generator Objects](https://tc39.es/ecma262/2026/multipage/control-abstraction-objects.html#sec-generator-objects).
