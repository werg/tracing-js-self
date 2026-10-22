# First owned spec-operation path

The `0.2.0` bounded prototype executes `ApplyStringOrNumericBinaryOperator`
as explicit, serializable phases, extended from primitives to a **limited owned
OrdinaryToPrimitive** path. This is not an engine262 replacement or complete
ECMAScript object internal-method implementation.

## Reference and supported domain

The implementation follows the algorithm structure in the pinned engine262
revision `2d7d8d988c77e94473ba0377122cdfccdfe243ba`:

- [`ApplyStringOrNumericBinaryOperator`](https://github.com/engine262/engine262/blob/2d7d8d988c77e94473ba0377122cdfccdfe243ba/src/runtime-semantics/ApplyStringOrNumericBinaryOperator.mts).
- [`ToPrimitive`, `ToNumeric`, `ToNumber`, `ToString`](https://github.com/engine262/engine262/blob/2d7d8d988c77e94473ba0377122cdfccdfe243ba/src/abstract-ops/type-conversion.mts).
- The corresponding ECMA-262 clause anchors and exact engine revision appear on
  every phase event. These anchors identify algorithms; the pinned upstream
  source, rather than the moving specification website, identifies the reference
  revision used for the implementation audit.

The operators are `+`, `-`, `*`, `/`, `%`, and `**`. Operands may be Undefined,
Null, Boolean, String, Number, BigInt and bounded ordinary object/array guest identities. Addition performs left and right
`ToPrimitive`, selects string concatenation when appropriate, and otherwise
performs left and right `ToNumeric` and a same-type check before the numeric leaf.
The other five operators take the numeric path directly. Each `ToNumeric`
includes a separately recorded primitive conversion and BigInt/Number branch.

### New owned ordinary-object coercion path

When a binary arithmetic operand is an owned ordinary object or array,
the parent operation enters serialized `coercion-get`, `coercion-call`,
and (for guest functions) `coercion-return` phases. The conversion record
keeps receiver identity, method-lookup order, lookup token, target register,
subframe and continuation. `OrdinaryToPrimitive` with number/default hint
tries `valueOf` before `toString`; noncallable entries and object-returning
methods fall through in order. Only a primitive result may complete the
conversion; two exhausted methods produce owned TypeError.

`[[Get]]` checks the guest's own **data** properties and then a specifically
modeled default Object/Array method; no host prototype method executes on
guest objects. User-defined ordinary guest functions are invoked via the
owned VM with the receiver bound as `this`, including observable side
effects and abrupt completions. Defaults include `Object.valueOf`,
`Object.toString` and primitive dense-array `Array.toString`; the latter
fails closed for holes, inherited/overridden joins or nested objects.

**Limits:** No getters/setters, Proxy, Symbol/@@toPrimitive, boxed primitives,
user-defined prototypes, inherited property descriptors, exotic `[[Get]]`,
full Array::join semantics or sloppy global `this`. Unhandled object categories
retain explicit `unsupported`, rather than allowing opaque native coercion.
Comparison, equality and unary operations still follow their separately
bounded handlers.

## What is owned, and what is still a host leaf

`state.operations` holds ordinary JSON-compatible records with an owning frame,
operator, source identity, phase, input tokens, conversion registers, ordinary
coercion continuation and completion.
`frame.operationId` is the continuation link. Every call to `Runtime.step()`
advances one bytecode instruction or one spec phase. No suspended JavaScript
generator, closure, native promise or engine262 activation holds this continuation.

The scalar leaves deliberately remain explicit:

- StringNumericLiteral conversion uses `Number(string)` on an already verified
  host string.
- Number formatting uses `String(number)` on an already verified host number.
- Number and BigInt arithmetic uses the corresponding host primitive operator
  after recorded conversion and numeric-type checks.

These leaves cannot invoke a guest conversion method. They are not independent
implementations of decimal parsing, floating-point rounding or arbitrary-precision
arithmetic. Host build pins, interruption of expensive leaves and resource budgets
remain open. The driver limit now counts spec phases as well as bytecode steps;
it is not a wall-clock or memory limit.

## Journal and independent structural validation

The new operation table uses commands instead of entity replacement:

| Command | Preconditions and change |
| --- | --- |
| `operation.create` | The identity is absent; install a version-1 record owned by the active frame. |
| `operation.advance` | Match record version and phase; perform single-assignment register writes, permitted transition and versioned `coercionBefore/After` updates. |
| `operation.complete` | Match the final completion and version; return to the owner or record its terminal failure. |

`src/spec-validation.js` interprets these commands independently of the executor
and writer. It checks phase transitions, required registers, token provenance,
source ownership, result types, completion metadata and version preconditions.
All other machine tables still use the earlier entity-replacement mutations.

The structural validator independently checks owned method lookup against the
recorded heap, shape/property versions, subframe linkage, source and operand
provenance, but does not independently calculate arithmetic answers.
A coherently forged numeric answer can still reconstruct; deterministic replay
rejects it by executing the source again. The external engine262 differential
checks add independent scalar observations. Neither is a complete semantic proof.

## Completions and visibility

Mixed Number/BigInt operands produce owned TypeError, while BigInt
division/remainder by zero and negative exponents produce RangeError.
OrdinaryToPrimitive exhaustion also produces TypeError. A conversion
method's guest throw is carried by the parent coercion operation and
reaches an enclosing handler without native exception propagation.

The bounded runtime now handles synchronous catch/finally and selected
implicit exceptions, rejects owned async-function promises on guest throws,
adopts rejected promises and delivers await/host rejections through
serialized job entries. Uncaught synchronous failures still stop the
driver before queued guest work. Promise reasons and external failure
payloads remain private until the modeled delivery point. Full promise
reactions, thenables and host scheduling are not implemented.

Structural validation, JSON archive round trips and same-interpreter
replay cover both old scalar phases and new coercion continuations.
The 1,958 engine262 oracle cases remain **primitive-only**; additional
ordinary-object tests compare final primitive outputs with Node V8 and
test method call order, identity and adversarial archive forgery. This
finite differential evidence is not complete ECMA-262 conformance.

## Versioning and embedding

New runs use `semantic-tracing-run/2` and `bounded-deterministic-reexecution/2`.
The original script language profile is `bounded-js-subset/2`; strict direct
function entry retains the separately versioned `training-js/1` profile and uses
the same owned arithmetic phases. The structural reader still reconstructs
legacy `/1` bundles. Exact replay requires `/2`; it refuses legacy journals rather
than claiming event-for-event compatibility after the execution model changed.
Replay also verifies the recorded profile manifest against the executing runtime.

The package root exports the embedded ESM API. `runtime.drive()` may return
`terminated`, `waiting`, `runtime.failure`, or `unsupported`; callers must inspect
that result before treating a trace as a successful program execution.

```js
import { createRuntime, validateBundle, replayExact } from 'tracing-js-self';

const runtime = createRuntime();
runtime.start('let result = 9007199254740993n + 2n;');
const progress = runtime.drive();
if (progress.kind !== 'terminated') throw new Error(progress.kind);
const bundle = JSON.parse(JSON.stringify(runtime.exportRun()));
validateBundle(bundle);
replayExact(bundle);
```

## Reproducible evidence

After `npm ci` installs the locked Acorn parser, the unit suite includes phase
ordering, conversions, negative
controls, malformed commands, source/provenance checks, terminal-job suppression,
canonical external inputs and JSON round trips at every phase. The latter rebuild
compiled code from source and restore only test snapshots; they do not introduce
a public durable-checkpoint restoration API. These tests do not require the
optional engine262 reference package.

With the pinned optional engine262 dependency installed:

```sh
npm run test:arithmetic
node scripts/run-runtime-conformance.mjs --oracle
```

The arithmetic runner checks all six operators over a declared 18-by-18 primitive
corpus plus 14 additional edge cases: **1,958 cases**, including **1,433 normal**
and **525 abrupt** outcomes. Every case compares with the external oracle,
round-trips its archive through JSON, reconstructs its state and replays its trace
without adapters. This finite corpus is not an exhaustive numeric or language
proof. The separate [Test262 execution slice](TEST262_RUNTIME_SLICE.md) keeps its
own file/variant denominator and unsupported cases.

Next work must expand the bounded own-data lookup to full descriptors, exotic
internal methods, symbols, prototypes and normative ToPrimitive edge cases;
move typed commands into bindings and other heap mutations; establish broader
Test262 evidence and expose a validated [natlang adapter](NATLANG_INTEGRATION.md).
