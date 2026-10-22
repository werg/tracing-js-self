# Bounded synchronous completion control

This milestone adds **owned, serializable** completion handling to the original
`bounded-js-subset/2` frontend, not a claim of full ECMAScript completion
semantics or a new full-language profile.

## Implemented

- `try { ... } catch (e) { ... }`, optional catch binding, `finally`,
  including nested handlers, thrown primitive/object identities and rethrows.
- `return` through `finally`, including return/throw override inside the
  finalizer. An explicit throw inside a synchronous guest function unwinds into
  its caller's handler without host exception propagation.
- Unlabeled `break`/`continue` for `while` (also through `finally`).
  Exits restore the lexical environment and operand depth at the loop boundary.
- Owned arithmetic's already-journaled TypeError/RangeError can be caught.
  Its synthetic guest error is a data object with own `name` and `message`
  fields. The arithmetic spec-operation completion remains its source event.
- Synchronous mock-host abrupt delivery routes into a guest catch only **at
  delivery**, not at private input arrival. Events and frame/handler mutations
  reconstruct and deterministically replay without executing adapters.

The bytecode stores handler entries with catch/finally/after program counters,
entry lexical environment, operand stack depth, loop depth, a phase and an
optional pending completion. Loop entries store their own exit/continue targets
and enclosing handler depth. All are plain records in the versioned frame
table. No native `throw`, generator, or `finally` executes guest control flow.

## Deliberate limits / admission

- Only explicit guest `throw`, synchronous host abrupt delivery, and the
  existing **owned primitive arithmetic** TypeError/RangeError take this
  route. Other interpreter failures are still fail-closed native errors, not
  fabricated JavaScript catchable exceptions.
- An uncaught throw from an `async function` is still terminal; Promise
  rejection settlement, adoption of rejected promises and `await` rejection
  delivery are not enabled. No exception adapters are claimed for natlang.
- Error prototype/constructor identity, `instanceof`, `stack`, and Error
  exotic behavior are not implemented. Object-to-primitive coercion remains
  unsupported, even inside `try`.
- `for`, `do/while`, switch, labels, generator `yield`, async module
  evaluation, broad early errors, and general completion propagation are
  not enabled by these opcodes. The strict synchronous `training-js/1` profile
  deliberately continues to reject throw/try/break/continue until its separate
  semantic verification and admission gates are extended.
- Full conformance needs external Test262 runtime evidence and independent
  semantic checks; structural validation and same-interpreter replay are not
  proof of ECMAScript correctness.

See [status](STATUS.md) and [integration blockers](NATLANG_INTEGRATION.md).
