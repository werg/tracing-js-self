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
