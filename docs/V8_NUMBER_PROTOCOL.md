# Number conversion protocol component

Production source projection now uses the shared Number/PropertyKey machine in
[SEMANTIC_PRIMITIVE_CONVERSION_V8.md](SEMANTIC_PRIMITIVE_CONVERSION_V8.md), including
getter selection and nested conversion. The `number.*` component documented
here remains available for its explicit public component programs and original
historical measurements; it is no longer the registered production source owner.

This public component models `Number(value)` through the shared heap and call
scope. Its scalar leaf converts only a tagged JavaScript primitive. Object
conversion reads the actual Symbol.toPrimitive property, calls the selected
owned function with the original receiver and `"number"` hint, then checks its
primitive return before scalar conversion. Ordinary fallback selects valueOf
before toString and skips noncallable ordinary methods.

## Exact records

| Record | Fields after `kind` | Meaning |
| --- | --- | --- |
| `number.begin` | `id`, `value` | Retain the argument and caller. |
| `number.select` | `id`, `key`, `method`, `builtin` | Verify the current conversion key and live data property or supported inherited intrinsic. |
| `number.call` | `id`, `child` | Enter the captured guest function with the correct receiver and arguments. |
| `number.builtin` | `id`, `result` | Check Object.valueOf or Object.toString fallback. |
| `number.return` | `id`, `value` | Check the actual completed callback value and select the next phase. |
| `number.finish` | `id`, `result` | Check scalar Number conversion, including BigInt-to-Number. |

`method` is a public value. `builtin` is null, `Object.valueOf`, or
`Object.toString`; a builtin selection carries an undefined method value. This
distinguishes intrinsic behavior from an invented guest function identity.
Object.toString checks an ordinary data Symbol.toStringTag property and its
actual object kind. Array stringification, accessor conversion methods, exotic
objects and guest abrupt conversion results remain refused by this initial
public component.

## Retained state and barriers

The protocol state field `numberConversions` is null before first use and then
contains `{schema:"semantic-number-conversion-state/1",operations:[...]}`.
Every operation has exactly `id`, `parent`, `input`, `index`, `method`, `builtin`,
`child`, `phase`, `primitive`, and `result`. The index is -1 for Symbol.toPrimitive,
0 for valueOf, and 1 for toString. Phases are select, call, builtin, waiting,
convert, and complete. Unselected values and absent child/result identities are
null. Completed operations remain available for checkpoint validation.

The shared machine must run `assertNumberNextV8` before every detailed or protocol
record. Method selection, callback entry, callback completion and final scalar
conversion cannot be skipped. Guest callback bodies may execute their ordinary
records and nested conversions. Callback entry uses the shared call helper, so
receiver restoration, captures and class-call restrictions remain authoritative.

The component tests compare real native conversion results and invocation
behavior, including number hints, receiver identity, noncallable fallback,
StringNumericLiteral parsing, signed zero and BigInt rounding. They reject false
method selections, result claims, phase order and malformed retained state.
Source projection and owned continuation integration now have the separately
checked source slice below. Independent native-consumer admission remains a
separate gate; component tests alone do not establish those qualifications.

## Owned runtime continuation

The owned runtime stores an explicit `pendingNumberConversion` on the calling
frame while a guest conversion callback runs. Its exact fields are `operation`,
`input`, `siteId`, `index`, `method`, `phase`, `waitingFrameId`, and `result`.
Committed phases are `waiting` and `returned`. A callback return retains the
actual returned value without pushing it as the result of Number. A subsequent
`intrinsic.number.resume` event converts that primitive or selects the live
ordinary fallback method. Archive validation checks the selected function,
receiver, child frame, return value and allowed transitions independently of the
mutation helper. JSON restoration resumes either phase without repeating guest
effects.

Owned conversion currently accepts ordinary objects and bounded arrays, data
conversion methods, synchronous owned callbacks, supported ordinary intrinsic
fallbacks and primitive results. It distinguishes actual guest TypeErrors and
callback throws from an unsupported accessor, exotic or asynchronous callback
profile. Existing projection formats explicitly refuse the added continuation
state; an identical final scalar does not establish those formats can preserve
the operation.

## Qualified source slice

`number-conversion-source/1` projects direct synchronous `Number(value)` calls
into the shared protocol state. It publishes each selected data method, enters
the real owned callback, checks its receiver and source identity, retains its
returned primitive, and completes scalar conversion before subsequent source
work. The public state checks the exact original caller and conversion cursor
after each owned frame change. Nested conversions and private class callbacks
share the existing heap, capture cells and completion state. `Number()` uses
its distinct zero-argument result; extra arguments are outside this initial
source slice.

The independent V8 worker also records
`number-conversion-observations/1`: conversion entry, data-method selection,
callback receiver and arguments, callback return, intrinsic fallback result,
and final Number result. These private receipts preserve input-rooted object
and function identities and compare the full dynamic order. They supplement
the existing independent operation, branch, completion and descriptor/private
state observations.

The native observer runs the actual V8 Number algorithm through a private
observation proxy. Its data lookups target the original object, and each
selected method is called with that original receiver. The observer never
stores the proxy in guest state, changes a guest property, or exposes a proxy
to a conversion callback. This preserves private brands, frozen data-method
descriptors, aliases and live fallback-method changes. Original uninstrumented
execution remains an independent outcome check. Source-visible Proxies and
accessors are refused before observation can invoke their traps or getters.

The source tests cover compact computation on both sides, repeated private
state updates, ordinary fallback and live method mutation, nested conversions,
BigInt rounding, signed zero, JSON checkpoints at pending callbacks, and
forged method-selection receipts. Checkpoint continuation produces exactly the
same public records without repeating a conversion callback. Abrupt conversion
results, accessor selection, array stringification and asynchronous/exotic
callbacks remain explicit unqualified profiles. No external native or model
admission follows from these source tests.

Pinned algorithms: [ECMAScript 2026 Number](https://tc39.es/ecma262/2026/multipage/numbers-and-dates.html#sec-number-constructor-number-value),
[ToNumeric](https://tc39.es/ecma262/2026/multipage/abstract-operations.html#sec-tonumeric),
and [ToPrimitive](https://tc39.es/ecma262/2026/multipage/abstract-operations.html#sec-toprimitive).
