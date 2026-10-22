# Bounded guest completions and promise rejection

This milestone extends the serializable `bounded-js-subset/2` completion path.
It is **not** complete ECMAScript exception handling, host integration or
training corpus admission.

## Implemented

- `try/catch/finally`, optional catch bindings, nested handlers, primitive and
  object throws, rethrows, return/finally override and cross-frame unwinding.
- Unlabeled `break` and `continue` in `while`, including execution of
  enclosing finalizers, environment restoration and operand-depth restoration.
- Owned arithmetic TypeError/RangeError completions, ordinary object
  conversion-method throws, selected implicit guest ReferenceError/TypeError
  faults (unbound/TDZ/const, bad call, null/undefined property access) and
  RangeError for invalid array length, all routed to guest handlers.
- Synchronous mock-host abrupt delivery becomes catchable at **delivery**,
  not at private input arrival.
- Async functions that throw reject their returned *guest* promise rather than
  terminate the agent. `Promise.reject`, rejected-promise adoption, immediate
  or delayed `await` rejection, and asynchronously rejected host effects
  produce owned delivery/settlement/job events. A rejected `await` resumes
  into its own `catch` and `finally`, preserving the original reason token.
- Exception and promise state is entirely in serializable frame, handler,
  promise, queue and operation records. Archive reconstruction, typed
  operation validation and adapter-free exact replay cover these paths.

A synthetic guest Error created for a classified exception has own `name`
and `message` data properties, without modeled Error inheritance, stack,
constructor identity, `instanceof` or exotic behavior. Guest `throw`
values and rejected-promise reasons preserve their tagged value/identity.

## Ownership and provenance

Handlers retain the catch/finally/after program counters, entry scope,
stack and loop depths, phase and pending completion. Operation records keep
the `OrdinaryToPrimitive` method call continuation; a conversion method's
throw is first parked on the parent frame, then completed and delivered from
the owned spec phase. Promise fulfillment/rejection wakes serializable waiter
jobs; input arrival never executes a guest job or reveals a private payload.

The validator independently checks classified throw metadata, exceptional
settlements, awaited rejection reasons and conversion method linkage.
Same-interpreter replay proves deterministic consistency only—not ECMA-262
conformance or equivalence with V8.

## Still unsupported

- Arbitrary interpreter/host/native faults are **not** relabeled as guest
  exceptions. Only enumerated semantics have classified owned fault paths.
- Promise thenable resolution and reaction chains, `.then/.catch/.finally`,
  `new Promise`, full unhandled-rejection reporting and all scheduling modes.
  An unobserved rejected promise does not currently crash a completed agent.
- Full Error constructors, Error stacks/prototypes, proxies/getters,
  generators, modules, top-level await, `for`/`switch`/labeled completions,
  and `training-js/1` admission of exception-bearing function entries.
- Complete differential Test262 execution and independent intermediate-step
  conformance remain future requirements.

See [status](STATUS.md), [owned arithmetic and coercion](OWNED_ARITHMETIC.md)
and [integration blockers](NATLANG_INTEGRATION.md).
