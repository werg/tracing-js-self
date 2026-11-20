# Owned prototype, accessor and Proxy slice

This is an **implemented, bounded subset**, not an assertion of full
ECMA-262 `[[Get]]`/`[[Set]]`/`[[DefineOwnProperty]]` semantics.

## Supported paths

- Ordinary data-property lookup walks explicit prototype links recorded in the
  guest heap. `Object.create`, `Object.getPrototypeOf`, and
  `Object.setPrototypeOf` preserve guest identities, null prototypes, own
  shadowing, inherited ordinary methods and cycle rejection. Inherited
  `valueOf`/`toString` coercion calls execute with the original receiver
  through the serialized spec continuation. Default `Object.prototype` and
  `Array.prototype` conversion leaves are still deliberately bounded.
- `Object.defineProperty(obj,key,{get,set,configurable,enumerable})` on owned
  ordinary targets creates **accessor descriptors**. Getter and setter
  callbacks execute in owned frames, with receiver identity and thrown
  completions preserved. Accessor-only properties are supported, not general
  data descriptors. Non-configurable accessor redefinition is catchable as
  guest `TypeError`. Assignment to an own or inherited accessor without a
  setter throws a guest `TypeError` in strict code and silently retains the
  property in sloppy code. Strictness follows the source directive prologue
  and lexical function nesting, including arrows; it is not inherited from
  the caller. No user getter runs during archive serialization.
- `new Proxy(target, handler)` allocates an owned proxy identity for ordinary
  targets and handlers. `get`/`set` handler data methods execute as guest
  frames with target, key, value (for set) and proxy receiver arguments. Without
  an applicable handler method, property gets/sets forward to the target in
  the supported ordinary-data slice. A method returned by a get trap is called
  with the proxy as `this`.
- The previously implemented Promise `then`/`catch`/`finally` reaction
  scheduler shares an ordered queue with `await`. Reaction frames and
  serialized promise identities are preserved through reconstruction/replay.

## Intentional failures and non-conformance

The implementation does **not** model `Proxy` traps beyond get/set,
revocation, callable/constructable Proxy targets, trap reentrancy through
accessor-backed handlers, symbols, `Reflect` internal method dispatch,
ownKeys/has/delete/define/getOwnPropertyDescriptor, species, exotic built-ins,
or a complete Proxy invariant checker. A trap targeting a non-configurable
accessor rejects the operation as unsupported before calling the trap. A
non-callable or asynchronous trap, several target shapes, and general
descriptor combinations likewise fail closed. Ordinary `[[Set]]` remains a
bounded data/accessor subset. Getter-only assignment failure is modeled in
strict and sloppy code, but general non-writable data descriptors, primitive
receivers and full strict Proxy invariants remain outside this claim.

Arithmetic's `OrdinaryToPrimitive` spec-command machine can call **data**
conversion methods reached through prototype links; method-selection accessors
remain unsupported there. `Number(object)` and ordinary computed property keys
now use a shared retained getter/method kernel. Its ordering, JSON boundaries,
independent checks and remaining profile limits are documented in
[OWNED_PROPERTY_KEY_CONVERSION.md](OWNED_PROPERTY_KEY_CONVERSION.md).

The compiler's `new Proxy` syntax exists only in `bounded-js-subset/2`.
It is not enabled in `training-js/1`, which accepts a separate strict
source/argument graph. Neither frontend accepts arbitrary JavaScript/TypeScript
syntax, so none of the above proves the natlang replacement.

## Evidence and remaining gates

`test/owned-prototypes.test.js` independently verifies reconstruction,
exact replay, forged inherited producer rejection, cycle rejection and
prototype-based conversion. `test/owned-exotics.test.js` compares supported
paths against a separate Node V8 `vm` reference and also checks exact replay.
`test/promise-reactions.test.js` covers reaction order, rejected callbacks,
async continuations, self-resolution and host-completion boundaries.
`test/strict-accessor-assignment.test.js` covers strict and sloppy getter-only
assignments, inherited properties, directive scope, setter completion and
finally overrides. Its training regressions inspect intermediate bindings,
so overwriting the final answer cannot conceal a failed assignment.

These tests are *local selected-case evidence*, not Test262/WPT compliance.
Any wider implementation must extend independent validation of descriptor
transitions and guest-accessor callbacks, adversarial proxy-invariant probes,
stable source spans, and differential engine tests before admitting new traces
as correct training records.
