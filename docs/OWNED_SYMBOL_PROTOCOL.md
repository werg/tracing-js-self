# Owned symbols and protocol identity

This is the first Symbol prerequisite slice of the language coverage plan.
`profiles/language-frontier.json` records its qualification independently from
the old detailed and native trace formats.

## Implemented runtime domain

The runtime allocates a unique `['symbol', id]` value for each `Symbol()` call.
Descriptions are metadata, never identity. The per-runtime registry preserves
`Symbol.for` / `Symbol.keyFor` identity. Well-known identities are stable named
values, including `iterator`, `asyncIterator` and `toPrimitive`; exposing these
names does not claim that every corresponding consumer protocol is implemented.

Scalar descriptions, `description`, `toString`, `valueOf`, equality, truthiness,
and `typeof` are supported. Numeric and implicit string conversion of a Symbol
produce guest TypeErrors through the owned completion machinery. Symbol values
and keys remain in checkpoint state and journal operands without host Symbols.

Ordinary own/inherited reads and writes, accessors, literal computed keys,
spread/rest, `Object.hasOwn`, `Object.getOwnPropertySymbols`,
`Object.getOwnPropertyNames` and `Reflect.ownKeys` preserve Symbol identity.
Own-key order is numeric string indices, other strings in creation order, then
symbols in creation order. `Object.keys`/`values`/`entries` exclude symbols.
Existing accessor-value-enumeration and exotic-object limits remain explicit.

## Lossless storage and transport boundary

`src/property-keys.js` provides the private storage codec. A symbol key contains
its identity, and strings beginning with NUL are escaped. This keeps arbitrary
guest strings disjoint from the symbol namespace. Every key entering from a
data graph passes through the string encoder, and every string key leaving a
data graph passes through the decoder. Symbols cannot cross either existing
host codec, as values or as property names; the operation is refused before
dispatch. Symbol-bearing completion data is also outside the existing ordinary
data graph observation boundary. Tests compare scalar observations of symbols
and independently check their owned archive identity graph.

## Separate public interface

`src/semantic/protocol-values.js` exports and validates
`semantic-protocol-values/1`. It is a standalone interface for later consumers,
not an extension or relabeling of `semantic-trace/6` or `/7`.

An envelope contains `schema` and an ordered `symbols` list. A record is one of:

| Kind | Required fields | Identity rule |
| --- | --- | --- |
| `unique` | `id`, `kind`, `description` | Fresh `oN`; description is `['undefined']` or `['str', text]`. |
| `registry` | `id`, `kind`, `description`, `key` | One identity for each registry key; description equals the key. |
| `well-known` | `id`, `kind`, `name` | Identity is exactly `well-known:` followed by the supported name. |

The value is `['symbol', id]`. Public property keys for a consumer that adopts
this interface must be a tagged union of `['str', text]` and `['symbol', id]`.
An interface must declare every referenced identity before its first use;
duplicates, dangling identities and duplicate registry keys are invalid. A
future native consumer must validate these rules, retain identity through
checkpoint/restore, and implement operations from owned state. Rendering a
description or decoding a host Symbol is insufficient.

Current detailed/native consumers **do not implement this interface**. Symbol
programs therefore retain an explicit projection refusal. Required future
consumer fixtures include equal descriptions with unequal identities, symbol
versus string keys, inherited symbol getters, copy/rest exclusion identity,
registry reuse, conversion TypeErrors, forged/dangling identities, and restore
before and after allocation or property mutation.

## Evidence and references

`test/training-symbols.test.js` exercises the strict frontend, owned execution,
independent original/instrumented V8 outcomes, operation/branch observations,
typed mutation validation, JSON roundtrip, deterministic replay, identity
tampering, host refusal and detailed-format refusal. Related ordinary object,
arithmetic and host-codec tests protect the shared paths.

The semantic checklist uses the pinned ECMAScript 2026 edition:

- [Symbol constructor, registry and prototype methods](https://tc39.es/ecma262/2026/multipage/fundamental-objects.html#sec-symbol-objects).
- [Ordinary own-property key order](https://tc39.es/ecma262/2026/multipage/ordinary-and-exotic-objects-behaviours.html#sec-ordinaryownpropertykeys).
- [ToPrimitive, ToNumber and ToString](https://tc39.es/ecma262/2026/multipage/abstract-operations.html#sec-type-conversion).

General boxed Symbol objects, cross-realm registries, host Symbol transport,
and protocol consumers not separately qualified remain outside this slice.
