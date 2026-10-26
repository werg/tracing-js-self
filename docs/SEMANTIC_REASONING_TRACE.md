# Source-grounded semantic reasoning traces

**Authoritative production contracts:** `semantic-execution/4`,
`semantic-trace/4`, `semantic-context/4`, `semantic-continuation/4`
and `selected-harness/2`.

The model's task is to **execute the supplied program**, not reproduce a
particular compiler's instruction list. The independently checked observable
contract is terminal completion, returned/reachable data graph, ordered effects,
delivered events, external results and required pending work. The witness is
an optional explanatory derivation that the model may express differently.

## One simple convention: expression -> value

A pure, anonymous computation should **not** allocate a synthetic temporary:

```text
((a + b) * (c + d)) -> 21
```

An actual source binding can attach directly to the computation:

```text
next = (current + 1) -> 8
```

The right side is the ground value **at that execution point**, not a promise
to re-evaluate the expression later. If `a[0]` is observed as `4` and a later
write changes it to `7`, the two grounded observations are both valid when
placed on the correct sides of that write. The witness checker always uses
previously **committed** state, never a future private snapshot.

A source name means a source lexical cell. It is not an invented explanation
or an identity for the computed value. The compiler retains unambiguous source
spellings (`key`, `current`, `next`, `seen`, `n`). Distinct shadowed
or independent lexical cells get minimal suffixes. References to shared
objects, closures, promises, jobs and continuations still need persistent
identities to preserve aliases, live captures and scheduling.

## Observed facts versus generated reasoning

* **Observed**: program/source, input graphs, external arrivals/results,
  callback/event activation and public continuation state refresh.
* **Generated**: checked arithmetic/choices, ordinary data mutations,
  actual external requests and their exact evaluated arguments, calls,
  Promise/job/await transitions and completion.

An effectful source expression cannot simply become a pure fact. Getter,
proxy, coercion and callback behavior is represented by its executed
subcomputations and concrete effects when supported, otherwise refused.
The source AST only **suggests** an explanation. Emission requires a
matching visible lexical cell or already-present ordinary own data slot,
an independently verified claim, and exact source/operand dependencies for
combining computations. No implicit future value or same-number coincidence
is enough.

Pure nested expressions are combined up to the existing eight-operator and
32-node budget. A source calculation may directly bind its result to its
source cell if the observed initializer consumes the actual producer.
A choice may replace its preceding pure test only when source, decision,
producer, and lack of intervening effects are established. All private
provenance stays on the non-model-visible certificate sidecar.

## Actual independently checked execution examples

These are condensed **real output** from
`node tools/inspect-semantic-reasoning.mjs` on pinned source/fixture inputs.
They are not invented desired traces. All cases also pass source reference,
selected controller replay and effect checks.

### Async read, calculation and write

Source:
```js
async function run(key) {
  const current = await host.readAsync(key);
  const next = current + 1;
  host.store(key, next);
  return next;
}
```

Model-facing sequence, omitting only the outer source publication and
coordinator bookkeeping:

```text
bind key = "counter"
request e1 demo.readAsync("counter") -> Promise &p2
await Promise &p2
observe e1 fulfilled 7
resume with fulfilled 7
bind current = 7
next = (current + 1) -> 8
request e2 demo.store("counter", 8)
observe e2 fulfilled undefined
resolve Promise &p1 8
return &p1
end return
```

The exact source-certified selected trace has 11 semantic records, one
`compute` with its attached binding, two external requests, and two
independently delivered observations. The previous step-by-step rendering
had separate `compute` and `bind` records for `next`.

### Source-checked branch

```text
observe e1 fulfilled 8
bind n = 8
choose (n > 3) = true -> then
request e2 demo.store("chosen", 8)
observe e2 fulfilled undefined
```

The branch is an independently checked predicate using committed `n`;
the model need not separately emit `8 > 3 -> true` followed by `choose
true`. A side-effectful branch predicate is never dropped.

### Live captured state and events

```text
bind seen = 0
event teacherevent1 -> event1
bind n = 3
seen = (seen + n) -> 3
request e2 demo.store("callback", 3)
event teacherevent2 -> event2
bind n_1 = 4
seen = (seen + n_1) -> 7
request e3 demo.store("callback", 7)
request e4 demo.store("result", 7)
```

Each callback mutates the **same** captured `seen` cell while its own `n`
parameter is a different source cell. The two writes and the last result
are exact observable boundaries. The extra parameter suffix is necessary
for distinct live invocation cells, not for an anonymous arithmetic result.

### Rejection and cleanup

```text
observe e1 rejected "missing"
resume with rejected "missing"
bind error = "missing"
request e2 demo.store("error", "missing")
transfer return 11 via finally
request e3 demo.store("cleanup", 1)
observe e3 fulfilled undefined
resolve Promise &p1 11
```

The cleanup write is not a reasoning detail; it is mandatory observable
behavior. Catch/finally control transfer is explicit.

### Own-property choices and named helpers

The `property-helper` inspection case starts with the ordinary input
`{count: 4}`, tests `box.count > 3`, writes `box.count = 2`, tests the
same property again, and calls the declared `helper` function. Its actual
selected sequence includes:

```text
bind box = &o3
read &o3["count"] -> 4
choose (&o3["count"] > 3) = true -> then
write &o3["count"] = 2
read &o3["count"] -> 2
choose (&o3["count"] > 3) = false -> else
call helper(2) -> guest1
compute (2 + 1) -> 3
```

The property operand refers to the already-published input graph and prior
committed writes. Both choices remain valid at their respective execution
points; inspecting the final heap cannot justify the first one. The source
rewriter reads only certified ordinary own data slots. Missing or inherited
slots, getters, proxies and dynamic property expressions are not guessed;
supported effectful reads retain their executed effects. A statically known
literal property key can be checked under the same own-data rule.

The helper label comes from its source declaration. Persistent invocation,
closure and object identities still distinguish separate activations and
aliases, and private certificates retain the actual dynamic call evidence.
These readability conventions do not broaden source admission.

### Deterministic randomness

A seeded fixture publishes its unsigned 32-bit `randomSeed` on the observed
program before the first selection. Every actual `Math.random()` call emits
a standalone checked `random` computation, including discarded samples and
calls made inside helpers. The `seeded-random` inspection case starts at zero
and emits `0.23606797284446657`, `0.278566908556968` and
`0.8195337599609047` in that order. The stream follows
`state = (1664525 * state + 1013904223) mod 2^32`, with each result equal to
`state / 2^32`.

Retained invocations and callbacks use the realm's continuing stream;
checkpoint restoration verifies it against public replay. A different seed
therefore changes the observed context, and an incorrect random result is
diagnosed without replacing the model's selected bytes. Random transitions
cannot be folded into pure compound expressions. Unseeded fixture randomness
is refused.

## How to reproduce and test

```sh
npm ci
node --test test/training-semantic-source.test.js test/training-semantic-projection.test.js test/training-generator.test.js
node tools/inspect-semantic-reasoning.mjs
npm run training:generate -- --out /tmp/semantic-v4
```

The inspection command refuses to print a case that fails independent local
source verification. It emits a compact per-family accounting of generated
records, bindings, choices, effects, observations, callback events and fused
source calculations. CI runs the same fixture collection on PRs.

## Correctness and training claims

1. **Observable outcome/effects** are the primary evaluation metric. Equivalent
   correct derivations need not agree in text or intermediate cell identities.
2. **Witness consistency** checks every explicit claim, with no oracle
   substitution or repairs.
3. **Artifact integrity** checks source execution, exact private replay,
   transformation receipts, serialization, admission gates and the native
   consumer. A local source-validated example is not automatically admitted.
4. **Model quality** must be established by actual held-out, fixed-budget
   training/serving comparisons. Fewer records are evidence about compactness,
   not evidence of learning improvement.

The only supported public execution witness is semantic-trace/4. Previous v2/v3 group formats, explicit/compact selection switches and outcome-only generation have been removed. The private journal, selected replay and independent V8 reference are correctness evidence, not alternative model targets.
