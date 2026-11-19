# Number conversion protocol component

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
Source projection, owned continuation integration and independent native
consumer admission are separate gates; component tests alone do not establish
those qualifications.

Pinned algorithms: [ECMAScript 2026 Number](https://tc39.es/ecma262/2026/multipage/numbers-and-dates.html#sec-number-constructor-number-value),
[ToNumeric](https://tc39.es/ecma262/2026/multipage/abstract-operations.html#sec-tonumeric),
and [ToPrimitive](https://tc39.es/ecma262/2026/multipage/abstract-operations.html#sec-toprimitive).
