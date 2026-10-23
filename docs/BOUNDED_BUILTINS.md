# Bounded owned intrinsic methods (October 23, 2026)

This is an **executable subset** of the ECMAScript intrinsic inventory,
not a complete ES2026 built-in runtime or Test262 pass claim. Every admitted
operation runs against serializable guest heap objects and typed guest values;
Node is used for scalar arithmetic/string formatting leaves and as an
independent differential test oracle, not as a native guest object executor.

## Ordinary own-data object methods

`Object.keys`, `Object.values`, and `Object.entries` enumerate selected
ordinary object/array own data properties; `Object.is` uses SameValue,
`Object.hasOwn` inspects owned properties, and `Array.isArray` checks
bounded Proxy target chains.

`Object.assign(target, ...sources)` now copies ordinary own data values
to an owned **ordinary object target** and returns the same owned target
reference. It supports ordinary object/array sources, ignores null/undefined
sources, skips nonenumerable dense-array `length`, preserves aliases, and
records every target mutation. It deliberately refuses native getters,
setters, proxies, first-class symbols, primitive coercion paths, a
`__proto__` source key, custom target prototype chains, array targets and
**a source identical to the target**. The last restriction avoids incorrectly
simulating source reads and target writes in self-aliasing cases in a single
atomic VM transaction.

The existing bounded `Object.create`, `Object.setPrototypeOf`,
`Object.getPrototypeOf`, `Object.defineProperty` and Proxy/ordinary
internal-method slices remain separately specified in
[owned object internals](OWNED_OBJECT_INTERNALS.md). Their support does not
supply full property descriptor or proxy invariant conformance.

## Dense own-data array methods

The bounded interpreter exposes `push`, `pop`, `includes`,
`indexOf`, `lastIndexOf`, `at`, `slice`, `concat`, `join`,
`splice`, `shift`, `unshift`, `reverse`, `fill`, `copyWithin`,
`toReversed` and `with`, and separately implements bounded guest-callback
`map`, `filter`, `reduce` and `sort` continuations. The newly added
`reverse`, `fill` and `copyWithin` mutate the owned receiver in place
while retaining its heap identity. `toReversed` and `with` allocate new
owned dense arrays, and `with` throws an owned guest RangeError for an
out-of-bounds index.

The input array must have its own, dense data slots, be within the configured
length limit, and not require inherited getters or proxy internal methods.
Index arguments accept the implemented **primitive** numeric conversion
leaves; object-driven `ToNumber`, inherited array slots, sparse array
mutations, exotic proxy targets and inaccessible property descriptors
must fail closed. Methods still missing from the normative Array builtin
inventory are not silently executed by Node.

## Evidence and remaining closure gates

- `test/owned-array-mutation-extensions.test.js` compares new array
  methods with V8, checks overlapping `copyWithin` regions, returned alias
  identities, in-place versus nonmutating operations, owned guest
  RangeError and fail-closed object-coercion refusal.
- `test/owned-object-assign.test.js` compares ordinary data copying
  with V8, includes nested alias equality and an independent
  `verifyTrainingCase` gate, plus an unsupported exotic-source negative.
- Both test groups validate JSON archives and use `replayExact`
  on completed runs. Exact replay proves **interpreter self-consistency**,
  not independent ECMAScript correctness or safe native API compatibility.

Complete scalar coercions, symbols, typed arrays, maps/sets, weak references,
iterators, generators, descriptors, module namespace invariants, full
RegExp/Date/Intl/Temporal, Promises/thenables, DOM and Node native APIs
remain beyond this profile. No full-conformance flag is set.
