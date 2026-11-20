# Owned binary-memory profile

Ordinary `ArrayBuffer`, ten typed-array element types, and `DataView` use one
serializable backing byte array per buffer. Each view retains its backing object
identity, element type, offset, and fixed or tracking length. A `subarray` shares
the original backing identity; `ArrayBuffer.prototype.slice` copies its selected
bytes to a fresh identity. Ordinary and shared buffers have distinct kinds and
capabilities.

The ordinary profile supports fixed buffers up to 1,024 bytes, typed-array
construction from a buffer or scalar length, indexed reads and writes,
`subarray`, DataView getters/setters with explicit byte order, buffer/view size
and offset properties, `ArrayBuffer.isView`, and fixed-buffer `slice`.
Conversions implement scalar `ToIndex`, Number, and BigInt rules, including
negative fractional lengths, signed zero, failed integer indices, and conversion
before DataView write bounds checks. The typed-array byte order is little-endian,
as declared by the existing owned memory profile; DataView byte order is explicit.

Read-only archive validation checks exact fields, byte ranges, backing identities,
view alignment and bounds, and immutable buffer/view capabilities at every
transition. JSON checkpoints retain aliases without holding native buffer objects.
Tests compare the resulting computation, primitive operations, and branches with
independent V8, and preserve existing single-agent shared-memory behavior.

Resizable/detached/transferred ordinary buffers, object conversion hooks in binary
operations, iterable/array-like typed-array constructors, custom properties or
species, non-shared Atomics, and cross-agent memory are outside this profile.
These boundaries refuse source qualification; they must not masquerade as guest
exceptions. Invalid supported arguments remain catchable guest errors.

Runtime and archive tests alone do not qualify the public trace or native training
consumer. The new binary protocol must independently validate public operations,
contexts, checkpoints, source metadata and native packing before admission.

The `owned-binary-memory/1` public component declares four operation families:
`memory.construct` names a new buffer or view and its input arguments;
`memory.get` checks a size, backing identity, or indexed read;
`memory.set` applies an indexed conversion and write; and `memory.call` checks a
bounded DataView, subarray, slice, growth, or single-agent atomic operation.
Buffers and views inhabit the same controller heap as ordinary objects. Fresh
backing identities are explicit, false results are rejected transactionally,
and public restoration rejects invalid bytes, aliases, bounds, and extra metadata.
The direct source adapter now qualifies the frozen `typed-views-shared-backing`
interaction and conversion, alias/copy, BigInt, floating-point, shared-growth and
single-agent atomic cases. The independent V8 observer reads actual backing bytes,
view aliases and builtin prototype identities without invoking guest getters. Its
metadata receipts catch byte changes that leave the returned scalar unchanged.
The source-qualified interaction is retained as an interoperability golden;
compact regions before and after memory operations and exact checkpoint resumption
are covered as well. Typed-array assignment completion preserves the original RHS
even when storage conversion changes it (for example, storing 257 into a Uint8 view).

Native training admission remains a separate gate tied to the exact expanded
contract, source fixture and consumer revision. Public component tests and source
qualification do not by themselves satisfy that gate. The public source profile
currently represents successful memory operations; abrupt binary operations and
the capabilities excluded above remain explicit refusals until their public
completion records are qualified.

The conversion and indexed-access rules follow the pinned
[ECMAScript 2026 conversion operations](https://tc39.es/ecma262/2026/multipage/abstract-operations.html#sec-toindex),
[typed-array exotic objects](https://tc39.es/ecma262/2026/multipage/ordinary-and-exotic-objects-behaviours.html#sec-typedarray-exotic-objects),
and [structured data algorithms](https://tc39.es/ecma262/2026/multipage/structured-data.html).
