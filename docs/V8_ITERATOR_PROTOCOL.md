# Shared iterator protocols

The first iterator component defines profile `builtin-iterator/1`. It operates
on the same public heap as compact expressions, detailed records, Symbols,
properties and construction. It does not install a second execution heap or
serialize an owned VM frame. Source and native admission are separate gates;
the component alone does not imply either has passed.

## Exact records

All records use the existing canonical `protocol ` line prefix.

| Kind | Fields after `kind` | Meaning |
| --- | --- | --- |
| `iterator.lookup` | `receiver, key, method` | Check the exact selected builtin method without calling it. |
| `iterator.create` | `name, iterated, iterationKind` | Allocate an array or primitive-string iterator. |
| `iterator.next` | `object, name, entry, result, done` | Advance, check the yielded value/completion, allocate the result object and optional entry pair. |
| `iterator.identity` | `object, result` | Check the iterator's inherited identity method result. |
| `iterator.read` | `object, key, result` | Read the declared iterator tag or an absent ordinary property. |
| `iterator.arrayGuard` | `iterated, result` | Check whether standard array iteration is selected. |

`receiver`, `iterated`, and yielded `result` use ordinary protocol value tags.
`key` is a tagged string/Symbol key. `done` and guard `result` are booleans.
`name` is the fresh result-object identity in `iterator.next`; `entry` is a fresh
pair-array identity for a nonterminal entries step, otherwise `null`.
`method` is one of `Array.prototype.values`, `.keys`, `.entries`,
`String.prototype.iterator`, `Iterator.next`, or `Iterator.identity` (the array
names include the full `Array.prototype.` prefix). Builtin callable identities
are not smuggled into ordinary reference values.

## Shared state

There is no additional top-level protocol field. An iterator heap node has
exactly these fields:

```js
{
  kind: 'iterator',
  iterated: ['ref', arrayId], // or ['str', primitiveString]
  iterationKind: 'values', // values | keys | entries | string
  nextIndex: 0,
  done: false,
  properties: new Map()
}
```

The ordinary property map must remain empty. Array length is read on each
advance until exhaustion; later growth does not reactivate an exhausted
iterator. Holes yield `undefined`, and keys do not read element values. Entry
pairs and result objects are distinct fresh identities; element references
retain their aliases. String positions count UTF-16 code units, advancing by
two only for a valid surrogate pair. Lone surrogates are retained unchanged.
The bounded profile admits at most 4096 array elements/string code units.

Array index reads follow explicit ordinary prototype links. A nonempty getter
requires a separate scoped continuation and is refused by this first component.
Builtin method lookup rejects overridden properties and custom array prototypes
rather than guessing the selected method. Custom iterator functions use the
ordinary call/property model in the separate bounded source profile below.

Restoration verifies exact fields, source identity, cursor bounds, empty own
properties and valid string code-point boundaries. Public application stages
the entire controller before evaluation, so an incorrect yielded value or
identity claim cannot leave an advanced cursor or partial allocation behind.

The component exports `ITERATOR_RECORD_FIELDS`, `validateIteratorRecordV8`,
`applyIteratorRecordV8`, `restoreIteratorStateV8`, and `hasIteratorStateV8` for
static registration. Its raw component API is `PROTOCOL_MACHINE_API_V8`.

`test/fixtures/semantic-iterator-v8.json` supplies three complete canonical
record sequences with initial and expected shared states. These are explicitly
controller-contract fixtures, not source qualifications. Regenerate them with
`node tools/generate-protocol-iterator-fixtures.mjs` after changing the registered
protocol state schema, and recheck them in the independent native consumer.

## Independent source observations

`createIteratorObservationAdapterV8` is an independent V8 observer. It imports
no owned runtime, public iterator evaluator, or source projector. Before guest
execution it captures the actual realm's iterator method and prototype
identities. It also recognizes outer-realm array inputs decoded by the worker.

Completion instrumentation wraps explicit iterator method calls with a curried
lookup helper: the receiver and computed key are evaluated once, the original
property lookup happens before arguments, and the selected function is applied
once with the original receiver. Primitive boxing uses a function captured from
the guest realm. Private references, `super` references and optional chains are
left intact. The observer never calls `next` merely to inspect an iterator.

The observer retains a private cursor receipt only for actual calls to the
captured builtin factories and methods. Metadata snapshots compare its source
alias, iteration kind, UTF-16 position and exhaustion flag against the owned
observer, using the existing independent reference identity mapping. A native
iterator obtained through an unobserved path is refused rather than described
as an ordinary empty object. Ordinary result objects and entry pairs still pass
through the descriptor/value observer.

The source tests include a teacher cursor mutation that leaves ordinary source
completion observations unchanged. Independent iterator metadata rejects it.
The registered source adapter now checks explicit values/keys/entries/string
iteration, helper-returned iterators, ordinary input arrays, and the existing
standard-array `for…of` path. It compares the complete selected cursor after
each owned change and refuses hidden properties or unexplained allocations.
The normal source gate runs the original and independently instrumented source,
compares operation/branch/completion/metadata receipts, reconstructs every public
context, and replays checkpoints. Fresh rechecking repeats all these steps.

`test/fixtures/semantic-iterator-region-v8.json` is the complete source-qualified
mixed fixture, with scalar arithmetic before and after iterator work. Regenerate
it with `node tools/generate-protocol-iterator-source-fixtures.mjs`; `--check`
requires exact stored bytes. Its local evidence is distinct from production
native admission, which still requires the separately pinned native consumer.

Within `builtin-iterator/1`, captured builtin callable values, iterator objects
escaping the ordinary data boundary, optional iterator calls and builtin index
getters remain outside the source profile. Custom method execution and cleanup
belong to the distinct source profile below; builtin component support does not
by itself qualify those callbacks.

## Bounded custom iterator source profile

`custom-iterator-source/1` adds checked ordinary synchronous `for…of` and flat
iterable variable declarations through the existing property/call machine.
Acquisition preserves the original receiver, `next` is read once and called
through its cached identity, `done` is read before `value`, and early cleanup
looks up and calls `return` at its actual boundary. Pending ordinary completions
retain their frame-owned targets and the precedence of original throws over
close failures. Exhaustion and failed `next`, `done` or `value` operations do not
invent an iterator-close call. The source observer checks these events against
independent execution of the original JavaScript; a matching final scalar alone
is insufficient. The custom method cache rejects asynchronous and generator
frames.

The flat-binding source recognizer accepts initialized `VariableDeclarator`
`ArrayPattern` nodes containing holes, identifiers, defaults whose left side is
an identifier, or rest whose argument is an identifier. The checked cases cover
empty-pattern close without a `next` call, elision without a value read, cached
`next`, identifier defaults and rest, permanent exhaustion, active Array growth,
own Array iterator overrides, throwing defaults and Number callback throws.
The [source suite](../test/semantic-protocol-iterable-binding-source-v8.test.js)
declares those cases explicitly.

The [final-contract flat-binding supplement](../coverage/language-expansion/iterable-binding-012c9fe/README.md)
freshly measured all **14 positive source/native/token cases** and **three
explicit source refusals** at producer `012c9fe` and consumer `39c4036`.
Every positive passes native replay, published-context restoration, checkpoint
continuation, masks, source binding and production-tokenizer checks. The report
retains the actual transport bytes, native packing and flat serialization costs;
it is a separate 17-case population, not growth of the frozen expansion corpus.

The separate [current custom-for-of supplement](../coverage/language-expansion/custom-iterator-012c9fe/README.md)
freshly measured all **16 positive source/native/token cases** and **four
explicit source refusals** at the same pair. Nested labeled break and outer-loop
continue preserve their exact frame-owned pending targets; continuing the outer
loop closes only the inner iterator. Original throws take precedence over close
failures, while a close failure can replace a normal break. The completed run
retains its explicit 300-second native admission bound with no retries or
timeouts. The earlier 120-second timeout remains historical evidence in the
[superseded qualification archive](../coverage/language-expansion/native-v8-3a1992b-interrupted/README.md).

Nested bindings, assignment destructuring and captured String builtin bindings
remain the three measured flat-binding refusals. Object/parameter patterns and
other source positions are not admitted by this flat declaration recognizer.
The custom `for…of` [source suite](../test/semantic-protocol-custom-iterator-source-v8.test.js)
separately declares its 16 positives and four refusals: malformed step/close
results, noncallable close methods, and cleanup inside generators remain outside
the bounded source path. Async iteration, arbitrary intrinsic guest TypeErrors
and unrestricted iterator behavior are not qualified by either profile.
