# Shared V8 primitive conversion

## Status and authority

This document fixes the producer/consumer contract for a shared conversion
machine. Implementation and paired qualification are in progress. It does not
promote the currently refused property-key source forms merely because owned
execution succeeds.

At producer `9d85e301e6674b97a1ac960d5efb87e572e4137e`, 16 original-source controls
reproduce the boundary. Twelve agree between owned execution and Node 24.22.3
but cannot be exported through the existing source gate. An ordinary Number
method control is already locally verified. Three computed compound, logical
assignment and update controls disagree with Node; their differences remain
evidence, not admissions. See the bounded fixture definitions in
`fixtures/semantic-regions/primitive-conversion.js`.

The normative input is the retained, SHA-256-checked annual ECMA-262 17th edition
HTML in `artifacts/conformance/ecma262-17.0-index.html.xz`, described by
`artifacts/conformance/ecma262-17.0.json`. Relevant clauses are 6.2.5.5 GetValue,
6.2.5.6 PutValue, 7.1.1 ToPrimitive, 7.1.1.1 OrdinaryToPrimitive and 7.1.19
ToPropertyKey. The owned runtime and its independent archive validators already
implement the bounded retained conversion described in
[OWNED_PROPERTY_KEY_CONVERSION.md](OWNED_PROPERTY_KEY_CONVERSION.md).

## One public machine

The profile is `primitive-conversion/1`. Both goals use `conversion.*` records
and the same `primitiveConversions` state. The current Number-only public
mechanism will be replaced directly; old measurements retain their original
producer, consumer and contract pins.

| Goal | Derived hint | Ordinary method order | Scalar finish |
| --- | --- | --- | --- |
| `Number` | `number` | `valueOf`, then `toString` | Explicit Number conversion; BigInt is accepted, Symbol causes TypeError. |
| `PropertyKey` | `string` | `toString`, then `valueOf` | Preserve Symbol identity; stringify every other primitive. |

Both goals first get `@@toPrimitive`. Null or undefined selects ordinary
conversion. A noncallable exotic hook is a guest fault. An exotic method returning
an object is a guest fault. Ordinary conversion skips noncallable values, tries
the second method only after the first cannot produce a primitive, and faults
after exhaustion. Method lookup uses the live shared heap each time; fallback
cannot reuse an earlier descriptor snapshot.

Getter lookup and method invocation are distinct steps. A getter is called with
the original conversion input as receiver. Its actual returned value becomes
the captured method without looking up the property again. Method calls also
use that original receiver, subject to the closure's already-declared lexical
receiver behavior. Only the exotic method receives the one-element hint argument;
getters and ordinary methods receive no arguments.

### Exact records

Every record has the `kind` and the listed fields, with no extra fields.

| Kind | Other fields |
| --- | --- |
| `conversion.begin` | `id`, `goal`, `value` |
| `conversion.lookup` | `id`, `key`, `descriptor`, `value`, `builtin` |
| `conversion.getter.call` | `id`, `child` |
| `conversion.getter.return` | `id`, `value` |
| `conversion.call` | `id`, `child` |
| `conversion.return` | `id`, `value` |
| `conversion.builtin` | `id`, `result` |
| `conversion.throw` | `id`, `value` |
| `conversion.fault` | `id`, `error` |
| `conversion.finish` | `id`, `result` |

`lookup.key` is independently derived from the current ordinal. `descriptor` is
`missing`, `data`, `accessor` or `builtin`. The lookup's value is the exact live
data value or getter; missing and builtin selections use an undefined sentinel.
The builtin identity is null except for an explicitly selected intrinsic.
The machine independently walks descriptors and prototypes before accepting the
record. A getter-returned builtin/host/opaque callable has no invented public
closure identity and remains unsupported.

The accepted builtin leaves are `Object.valueOf`, `Object.toString` and
`Array.toString` within the owned data profile. A `@@toStringTag` getter,
overridden or accessor Array `join`, sparse/inherited array elements, nested
objects, Symbol elements, and exotic prototype walks remain explicit boundaries.
No guest callback is evaluated as a host scalar leaf.

### Retained state and sequencing

The state is `{schema:'semantic-primitive-conversion-state/1',operations:[...]}`.
Each operation has exactly these 13 fields:

`id`, `parent`, `goal`, `input`, `index`, `phase`, `lookupKind`, `method`,
`builtin`, `child`, `candidate`, `result`, `fault`.

`index` is -1 for the exotic hook, then 0 or 1 for the goal-specific ordinary
order. `phase` is `lookup`, `getter-call`, `getter-waiting`, `call`, `waiting`,
`builtin`, `finish`, `fault`, `complete` or `abrupt`. The hint is derived from
the goal and cannot be changed independently in a checkpoint.

Only a live parent may own unfinished work. The innermost unfinished conversion
owns the next transition, except for records belonging to its live child body
and the existing narrowly checked cleanup-scope transfer. Every callback uses
a fresh child identity. A return or throw must consume the designated completed
child exactly once. Getter return clears that child before entering the captured
method. Nested Number/key conversions retain distinct parent and child owners.

A consumed ordinary method return also clears its child. Moving to the next
lookup clears the prior lookup kind, method, builtin, child, candidate and fault.
An original callback throw instead retains the inactive child and captured
method, with no candidate or derived fault. A derived fault retains its candidate
and cause with no child. These canonical shapes are part of the checkpoint
contract, not optional serialization choices.

`candidate` retains the primitive awaiting scalar finish, or an offending
nonprimitive used to derive a fault. `result` is present only after completion
or abrupt termination. Normal finish independently recomputes the scalar result.
There are at most 4,096 retained operations; scalar string/BigInt input text is
bounded at 10,000 characters. Existing shared heap and record bounds also apply.

Snapshot validation checks exact fields, phase-dependent nullability, method,
child, owner, goal and result consistency. Coordinated restore additionally
rebuilds state from the acknowledged public prefix; a new checksum does not
authorize changed private conversion state.

### Abrupt completion

`conversion.throw` preserves the original value thrown by the designated getter
or method, including an existing object identity. It never creates a replacement
exception. Cleanup and catch/finally remain separate owned completion work.

`conversion.fault.error` names a fresh ordinary public object allocated atomically
by the conversion machine. Its own `name` is `TypeError`; its message is derived
from one of four causes. A record cannot supply arbitrary message text.
`fault:null` is the no-fault sentinel, not a fifth cause. A null conversion input
remains an ordinary primitive and converts to `0` or the property key `"null"`.

| Retained fault cause | Derived message |
| --- | --- |
| `symbol-to-number` | `Cannot convert a Symbol value to a number` |
| `exotic-not-callable` | `Symbol.toPrimitive is not callable` |
| `exotic-nonprimitive` | `Symbol.toPrimitive must return a primitive` |
| `ordinary-exhausted` | `Cannot convert object to primitive value` |

These public fault semantics do not qualify arbitrary native Error metadata.
The owned declared-error object and Node Error prototypes, descriptors, stacks
and messages are different authorities. Until an explicit independent error
observation boundary exists, intrinsic-fault source examples remain refused;
an agreeing final `error.name` scalar alone is insufficient.

## Source and independent observation ownership

The source profile is `primitive-conversion-source/1`; the independent observation
profile is `primitive-conversion-observations/1`. No owned event format changes
are required. The source adapter consumes the current Number call/resume events,
`property.key.convert`, `property.key.resume`, and retained callback fields.
It verifies the suspended reference, input and exact callback identity against
the independently validated owned archive before emitting public records.

Conversion events own their unique source event claim even when the suspended
instruction is `PROPERTY_KEY`. Construction continues to own the later ordinary
primitive `PROPERTY_KEY` instruction. Conversion callback completion and any
future declared-error allocation must each have one explicit owner; competing
construction/completion adapters cannot consume them by ordering accident.

The independent native observer uses the original source operation's timing. It
does not pre-convert a computed key, replace the base or receiver, evaluate a
getter twice, or normalize an engine discrepancy into an owned result. It
observes the actual getter and captured method, original receiver, hint, return,
throw and finish in a separate Node process.

### Node 24 reference disagreement

The selected edition mutates a Reference Record's `[[ReferencedName]]` only
while it is not already a property key. The same compound/logical/update
reference therefore retains the result for its later write. Node 24.22.3 repeats
the object-key conversion for those writes. The bounded original controls use a
hook returning `x` first and `y` second:

| Operation | Owned `[calls,x,y]` | Node 24.22.3 `[calls,x,y]` |
| --- | --- | --- |
| `object[key] += 3`, initial `{x:1,y:2}` | `[1,4,2]` | `[2,1,4]` |
| `object[key] ||= 3`, initial `{x:0,y:2}` | `[1,3,2]` | `[2,0,3]` |
| `object[key]++`, initial `{x:1,y:2}` | `[1,2,2]` | `[2,1,2]` |

These source forms cannot inherit original-Node qualification from the new
conversion machine. Their discrepancies stay visible. Delete already has an
independent frontend refusal and is not promoted by this work. Modules and
namespace semantics are outside this increment.
