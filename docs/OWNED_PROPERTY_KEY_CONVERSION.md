# Retained Number and property-key conversion

The owned runtime shares one resumable `ToPrimitive` kernel between
`Number(object)` and `ToPropertyKey(object)`. This document describes owned
execution. The separately registered public/source/native conversion slice and
its remaining refusals are described in
[SEMANTIC_PRIMITIVE_CONVERSION_V8.md](SEMANTIC_PRIMITIVE_CONVERSION_V8.md).
Owned support alone does not qualify training admission.

## Specification and reference lifetime

The normative input is the ECMAScript 2026 tag of `tc39/ecma262`, peeled commit
`d89c03f2db8a597bc915b363a6518d0cc8acdbc0`:

- [GetValue and PutValue](https://github.com/tc39/ecma262/blob/d89c03f2db8a597bc915b363a6518d0cc8acdbc0/spec.html#L4451-L4500)
  first apply `ToObject` to a property reference's base. They set the reference's
  `[[ReferencedName]]` to `ToPropertyKey` only when it is not already a property
  key. A subsequent write through the same reference uses that stored key.
- [ToPrimitive and OrdinaryToPrimitive](https://github.com/tc39/ecma262/blob/d89c03f2db8a597bc915b363a6518d0cc8acdbc0/spec.html#L5006-L5060)
  get the exotic hook first, pass the appropriate hint, and then get ordinary
  conversion methods lazily in hint order. Every method is called with the
  original object as receiver. A getter's result is the selected method;
  resumption must not look up that property again.
- [ToPropertyKey](https://github.com/tc39/ecma262/blob/d89c03f2db8a597bc915b363a6518d0cc8acdbc0/spec.html#L5697-L5706)
  uses the string hint, preserves a returned Symbol, and stringifies other
  primitives. Symbol descriptions never stand in for Symbol identity.

`Number` uses the number hint and tries `valueOf` before `toString`.
`PropertyKey` uses the string hint and tries `toString` before `valueOf`.
Both retain the actual result of `@@toPrimitive`, property getters and method
calls. A nonprimitive exotic result produces an owned TypeError. Ordinary
conversion skips noncallable properties and advances to the second method only
after the first method returns a nonprimitive.

The frontend/runtime boundary observes these ordering rules:

| Source form | Conversion point and retained state |
| --- | --- |
| `base[key]`, `base[key](args)` | Convert after evaluating base/key, before the property getter and before call arguments. |
| `base[key] = rhs` | Evaluate base/key and RHS, then convert the original key before the write. RHS can change the key object's methods. |
| `base[key] += rhs` and other compound assignments | Convert once before duplicating the reference for its read. Preserve that primitive key across the getter, RHS and write. |
| `base[key] &&= rhs`, `||=`, `??=` | Convert for the read, update the inaccessible key cell, and reuse it if the branch writes. A skipped RHS does not run. |
| `base[key]++`, `--base[key]` | Convert once for the retained read/write reference. The existing update value profile remains scalar. |
| `{[key]: value}` and computed class keys | Convert the key before evaluating its value or initializer. |
| `{[key]: value, ...rest}` binding/assignment | Convert before reading and before retaining the rest exclusion key. |

A null/undefined base fails before invoking conversion hooks. In a simple
assignment this failure still follows RHS evaluation. The other forms fail at
the first read and do not evaluate their RHS or arguments.

Ordinary scalar member operations do not gain a conversion event. Computed
object-literal and destructuring keys now have an explicit `PROPERTY_KEY`
instruction at their specified evaluation point; existing artifacts for sources
containing those forms must be regenerated. This is a direct compiler fix, not
a compatibility path.

## Serializable boundaries

`owned-primitive-conversion.js` retains the existing eight Number fields:

| Field | Meaning |
| --- | --- |
| `operation` | `Number` or `PropertyKey`; fixes hint order and the final scalar operation. |
| `input` | Original owned object/array identity. |
| `siteId` | Source operation owning the continuation. |
| `index` | `-1` for `@@toPrimitive`, `0`/`1` for the hint-specific ordinary methods. |
| `method` | Exact getter or conversion function selected before entering a child frame. |
| `phase` | `getter-waiting`, `getter-returned`, `waiting`, or `returned` at retained boundaries. `select` is internal to an atomic step. |
| `waitingFrameId` | Fresh owned callback invocation. |
| `result` | The actual returned tagged value; null while waiting. |

The original Number callback state and ordinary resume events are unchanged.
New getter phases distinguish a getter that selects a function from that
function's own invocation. Nested conversions have separate owning frames.

`pendingPropertyKeyConversion` adds a reference envelope around this record:
the source pc/opcode, the complete suspended operand stack, its key slot and an
optional logical-assignment cache binding (environment, name, token, version).
The pc and operand stack do not advance while conversion is outstanding.
`property.key.convert` begins conversion; `property.key.resume` consumes a
retained return. On successful completion the key slot, and only its private
cache binding when present, receive the primitive key. The original instruction
then executes normally. The base, already evaluated RHS and stack prefix keep
their original tokens.

Callback throws unwind through the existing completion router. No replacement
exception is manufactured for a guest-thrown value. Partial getter/method effects
remain committed, and catch/finally work remains owned. Synchronous host calls
inside a callback can block with both conversion records and the effect state
retained. JSON restoration does not repeat a method lookup, conversion call,
RHS evaluation, or dispatched host request.

## Independent checks and evidence

`primitive-conversion-validation.js` independently walks archived property and
prototype records. It does not import the mutation kernel, evaluator, or
`ordinaryGet`. It checks the selected getter/method, fallback ordinal, fresh
child invocation, receiver/lexical receiver, argument hint/rest parameters,
source return or retained finally return, and scalar result/fault.

`property-key-conversion-validation.js` separately checks reference ownership:
pc, instruction, operand/key identity, source site, original stack, inaccessible
logical binding and its version. It rejects replacing the stored reference,
advancing an instruction while conversion is pending, changing the key result,
or modifying unrelated lexical bindings. Normal archive reconstruction and
exact replay remain additional required checks.

The focused tests are `test/owned-primitive-conversion.test.js`,
`test/owned-property-key-conversion.test.js` and the existing
`test/training-number-object-conversion.test.js`. They cover live method mutation,
inherited getters, Symbol keys, fallback/throw identity, nested Number/key
conversions, host blocking, every getter/method return boundary, cached compound
and logical references, and malformed state/events.

Node 24.22.3 differs from the pinned ES2026 cached-reference text: it invokes an
object key again for the write in compound assignments, taken logical
assignments and prefix/postfix updates. A hook returning different keys can
therefore write a different property in Node. Those tests use explicit expected
values derived from the pinned Reference Record rules; Node results are reported
as oracle discrepancies and are never substituted for the normative expectation.
Other supported cases use independent original-source Node execution alongside
reconstruction, operation/branch observations and exact replay.

## Explicit remaining scope

This slice accepts ordinary object/array keys and owned synchronous guest
getters/methods, including inherited methods and private class state used by a
method. It rejects callable/other Proxy key objects, async/generator conversion
callbacks, function/exotic key objects, opaque intrinsic/host callback methods,
and builtin stringification outside the existing bounded data leaves. In
particular, a getter for `@@toStringTag`, overridden/custom Array `join`, sparse
or nested-array stringification still needs separate owned builtin work.

General `super` reference coercion, object-valued update operands, target-accessor
updates, reflective builtin key coercion, and arithmetic's separate spec-command
conversion machine are not promoted by this change. Arithmetic retains its
existing refusal for method-selection getters.

The source projection gate explicitly refuses `property.key.convert` and
`property.key.resume`, including conversions completed by a builtin without a
callback. The existing Number protocol adapter refuses the new getter phases.
Public/native support requires paired records, semantic validation, malformed
controls and restore/source evidence before this owned behavior can be admitted.
