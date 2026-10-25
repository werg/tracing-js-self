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

## How to reproduce and test

```sh
npm ci
node --test test/training-semantic-source.test.js test/training-effectful-compact.test.js
node tools/inspect-semantic-reasoning.mjs
npm run training:generate -- --out /tmp/semantic-v4 --representation compact
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

Historical v3/group-shaped tooling is not a production wire format. The
`explicit` v4 representation is retained as an ablation baseline for
controlled comparisons; the deployed source-grounded representation is
`compact`. Deleting those baselines before paired Megatoken evaluations
would destroy comparability, but neither should be described as the preferred
model-learning target.
