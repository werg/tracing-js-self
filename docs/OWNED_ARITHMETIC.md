# First owned spec-operation path

The `0.2.0` prototype executes the primitive portion of
`ApplyStringOrNumericBinaryOperator` as an explicit, serializable phase machine.
This is the first owned spec-operation integration, not an engine262 replacement
or a complete ECMAScript arithmetic implementation.

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
Null, Boolean, String, Number or BigInt. Addition performs left and right
`ToPrimitive`, selects string concatenation when appropriate, and otherwise
performs left and right `ToNumeric` and a same-type check before the numeric leaf.
The other five operators take the numeric path directly. Each `ToNumeric`
includes a separately recorded primitive conversion and BigInt/Number branch.

**Limits:** Symbol, object coercion, getters, `@@toPrimitive`, boxed primitives,
bitwise operators and the remaining language operations are not covered by this
path. Object coercion produces an explicit `unsupported` outcome before any guest
conversion method runs. Comparisons, equality, unary operations and existing
bindings remain on the original bounded handlers.

## What is owned, and what is still a host leaf

`state.operations` holds ordinary JSON-compatible records with an owning frame,
operator, source identity, phase, input tokens, conversion registers and completion.
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
| `operation.advance` | Match the record version and phase; perform the required single-assignment register writes and permitted phase transition. |
| `operation.complete` | Match the final completion and version; return to the owner or record its terminal failure. |

`src/spec-validation.js` interprets these commands independently of the executor
and writer. It checks phase transitions, required registers, token provenance,
source ownership, result types, completion metadata and version preconditions.
All other machine tables still use the earlier entity-replacement mutations.

The structural validator does not independently calculate arithmetic answers.
A coherently forged numeric answer can still reconstruct; deterministic replay
rejects it by executing the source again. The external engine262 differential
checks add independent scalar observations. Neither is a complete semantic proof.

## Completions and visibility

Mixed Number/BigInt operands produce a recorded TypeError completion. BigInt
division/remainder by zero and negative exponents produce recorded RangeError
completions. An explicit guest `throw` is also recorded. These are **terminal
bounded-profile failures**: catch/finally, stack unwinding, promise rejection
delivery and async exception semantics are not implemented. Unexpected host
resource failures are not relabeled as guest exceptions.

Terminal failures stop the driver before queued guest jobs or additional effects
can run. Synchronous host throws use the same terminal completion record. Their
abruptness, like their payload, stays hidden in the causal projection until input
delivery. Phase identities and producer links are visible; archival operation
registers and checkpoint state are not included in that projection.

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

Next work should carry the same ownership, mutation and evidence contracts into
bindings, object internal methods and guest completion propagation, before exposing
a [natlang environment adapter](NATLANG_INTEGRATION.md).
