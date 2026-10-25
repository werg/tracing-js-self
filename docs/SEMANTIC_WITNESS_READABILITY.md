# Source-guided semantic reasoning witnesses

The learner's contract is the observable outcome (completion, reachable input/result
data graph, and ordered external effects). A model's intermediate witness is a
reasoning account, not a bijection to interpreter steps or AST sites.

This document describes the bounded, source-guided compaction in
`src/training/rewrite.js`. It does **not** certify broader JavaScript language
support or change the `semantic-trace/3` wire grammar.

## A trace, inspected

Run `npm run training:generate -- --seed 42 --count 16`, then
`node tools/inspect-training.mjs training-local.jsonl` to regenerate
examples with independently checked source outcomes. The following are from the
local-evidence GitHub Action (seed 42, count 16), omitting the unchanged source,
input-graph and final `end` envelopes for readability.

### Nested arithmetic: `run(x) { return x * 2 + 1; }`, x = 5

```text
bind arg0 = 5
compute ((arg0 * 2) + 1) -> 11
return 11
```

The original granular witness exposed both multiplication and addition with
literal operands. Source nesting plus the recorded scalar results justify
combining them. `arg0` is an explicit local binding from the observed
immutable argument; it uses the already-supported `bind` and `local`
language, not a new tokenizer or expression opcode.

### A local: `let y=x+1; return y*2;`, x = -10

```text
bind arg0 = -10
y1 = (arg0 + 1) -> -9
compute (y1 * 2) -> -18
return -18
```

The number on `y1` distinguishes a semantic cell; its human-readable prefix
comes from the original source identifier. Computation and the immediately
attached binding are one step.

### A small loop: `for (let i=0;i<3;i++) s+=x+i`, x = 4

```text
bind arg0 = 4
bind s1 = 0
bind i2 = 0
choose (i2 < 3) = true -> then
s1 = (s1 + (arg0 + i2)) -> 4
bind i3 = 1
choose (i3 < 3) = true -> then
s1 = (s1 + (arg0 + i3)) -> 9
bind i4 = 2
choose (i4 < 3) = true -> then
s1 = (s1 + (arg0 + i4)) -> 15
bind i5 = 3
choose (i5 < 3) = false -> else
return 15
```

The loop-carried iteration cell names remain distinct: closures can observe
different captures. Mechanical reads and jumps need not appear. A source-guided
branch expression is admitted only if the independent primitive checker agrees
with the committed decision. Side-effecting or uncheckable tests remain an
explicit known-value choice.

## What the rewriter may do

* Replace a witnessed literal arithmetic operand with an immutable argument
  alias or an existing committed local **only when its value agrees**.
* Combine adjacent nested source expressions up to four primitive operators,
  preserving the observed result. Unrelated expressions with equal values
  are not fused.
* Attach an immediately adjacent scalar binding to its calculation.
* Reconstruct simple scalar comparisons for branch explanations if source
  operands are safe and the independent checker validates the decision.

The rewriter cannot move an expression across a write, callback, allocation,
transfer, request, or observation. No hidden archive ids, AST sites or future
result bytes are exposed to the model. The exact journal, source-span
certificates and independently rechecked V8 outcome remain private evidence.

## Boundaries and checks

The public source context includes original JavaScript but not an additional
AST/source-site inventory. The compiler retains its private static site map
for provenance; the public code record's v3 `sites` field is the empty list
for downstream wire compatibility.

`npm test` includes `test/training-semantic-rewrite.test.js`, including
anti-fusion cases. CI additionally generates a seed-pinned set of candidates,
checks private replay and independent Node/V8 reference outcomes, tests
canonical transport and the pinned megatoken importer, and audits real-source
coverage. Local verification is **not** corpus admission and no model learning,
tokenizer-token savings, or generalization improvement is claimed.

## Further simplification experiments

Measure a common held-out source cohort, with identical observed input/effect
contexts, at multiple expression budgets and an outcome-only reasoning ablation.
Compare final observable correctness and effect ordering separately from
witness-claim consistency and model compute. Possible next primitives include
explicit property-read expressions (careful about getters), semantic collection
updates (careful about callback ordering), and single-invocation summaries
only for independently certified pure helpers. Do not erase guest side effects
to make a trace shorter. The paired learning protocol is documented in
`docs/SEMANTIC_V3_MODEL_EXPERIMENTS.md`.

## Source-linked decisions as single semantic steps

A branch should ordinarily explain **why** it chose a path, rather than
present a duplicated calculation followed by an opaque literal choice. The
bounded rewriter now admits identifier tests, safe unary expressions and
nested pure binary expressions; each is reconstructed from *previously
committed* public locals or immutable input aliases, within the existing
operator/node budget, and independently checked against the recorded choice.
The source and actual observed decision are not replaced by a guessed result.

For example, a conditional using an input `x=4` may read:

```text
bind arg0 = 4
choose (arg0 > 0) = true -> then
compute (arg0 + 3) -> 7
return 7
```

Instead of emitting a separate `compute (4 > 0) -> true` followed by
`choose true = true -> then`. Multiple adjacent *unbound, pure* test
computations can be represented by that one checked choice. Their private
journal receipts stay attached to the resulting `fold-choice/1` certificate.
This is **not** a claim that the model must reproduce every execution step:
the source-explained choice is a shorter, checked reasoning witness.

Direct tests (`if(x)`), negation (`if(!x)`) and nested tests
(`if(x + 1 >= 3)`) similarly use source-linked expressions when checked
against prior public values. The `!` operator accepts a reference as
truthy without running coercion; generic arithmetic or `typeof` on
opaque references remain uncheckable.

**Safety boundaries:** the rewrite never infers hidden inputs, attempts an
accessor/property read, executes source expressions, or reduces short-circuit,
assignment, update, call or other effectful tests to a pure expression.
`if(o.n++ < 3)` remains a separate mutation and a known-value choice.
Missing/stale inputs, failed primitive checks or over-budget expressions
fall back to the original witness. The observable result, ordered effects,
independent V8 checks and private execution archive remain authoritative.

To inspect actual source-run traces, not fabricated examples:

```sh
node tools/inspect-semantic-choices.mjs
node --test test/training-choice-readability.test.js
```

This script records cases that pass the existing local runtime/replay,
independent V8 outcome, source-operation and branch audits, and selected
witness controller checks. The GitHub `Semantic trace v3 local evidence`
job also archives its human-readable output. It does not measure a
transformer model's accuracy or assert corpus admission.

## Owned input-property choices and named helpers

For ordinary input data objects, an expression such as `if(o.n > 2)` can
refer to the already-present `o.n` data slot using the existing pure
`read` witness operand. The rewriter maintains a *forward-only* copy of
input-graph own data slots and applies previously published writes and
deletions in order. The bounded independent evaluator then checks the
source-linked choice against this public state. Nothing is read from the
teacher's final heap or from a host object.

```text
bind arg0 = &o1
choose (&o1["n"] > 2) = true -> then
return 3
```

The `arg0` alias provides the root input reference; the value of the
property comes from the observed graph (or earlier public writes). Missing
slots, array exotic behavior, accessors/proxies and computed-property
expressions are not speculatively interpreted. Impure `o.n++` still emits
a property write and a known-value choice, retaining its chronology.

Named guest helper invocations also use the source-declared function name
(e.g. `call inc(4) -> i2`) instead of an opaque compiler coordinate
(e.g. `src1:code2`) when the compiler can resolve a `DEF_FN` declaration.
Anonymous or otherwise unidentified calls retain their existing fallback.
The callee identity and private dynamic call evidence are not discarded.

These improvements change *reasoning readability*, not the required
observable contract or the range of JavaScript accepted into training.
