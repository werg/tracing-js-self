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
  yielded: integer,
  handlers: [],
  delegation: null,
  prototype: ['ref', prototypeId] | 'Generator.prototype',
  properties: Map
}
```

Common descriptor metadata (`descriptors`, `keyOrder`, `extensible`) can be
present on the same node. There is no second generator heap or top-level
generator state table. The initial component requires empty handlers and null
delegation; general cleanup and delegated continuations require their explicit
follow-on transitions before source admission. Unknown state fields fail
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
for normal sent values, return before body execution, and thrown resumption.
These are explicitly component fixtures, not source/native admission receipts.

The public machine is bounded to 4,096 generator allocations, yields and
arguments, with the enclosing protocol's call-depth and record-count limits.
Async generators, general handler/delegation state, builtin function values,
exotic prototype getters and host transport require separately qualified
profiles. Existing v6/v7 value and continuation contracts remain unchanged.

Semantic reference: [ECMAScript 2026 Generator Objects](https://tc39.es/ecma262/2026/multipage/control-abstraction-objects.html#sec-generator-objects).
