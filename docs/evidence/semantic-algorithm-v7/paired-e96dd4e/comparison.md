# Paired semantic representation comparison

Producer: `e96dd4e51d7977554f05dc1794272d5145c69663`. Tracked working-tree changes: **false**.

Engineering checks: **passed**. Promotion: **not qualified**. Native consumer, native serving/token costs, and comprehension remain separate gates.

## Unchanged gallery

| Case | Disposition | Detailed target bytes | Current target bytes | Delta | Frozen targets |
| --- | --- | ---: | ---: | ---: | --- |
| compound-pure | normalized | 40 | 66 | 26 | identical |
| branch-1 | fallback | 406 | 406 | 0 | identical |
| object-alias | normalized | 179 | 27 | -152 | identical |
| pure-helper | normalized | 30 | 29 | -1 | identical |
| dense-loop | normalized | 56 | 40 | -16 | identical |
| throw-finally | fallback | 209 | 209 | 0 | identical |
| counter-0 | normalized | 437 | 108 | -329 | identical |
| rejection-finally | fallback | 524 | 524 | 0 | identical |
| callback-captured-write | fallback | 802 | 802 | 0 | identical |
| persistent-external-trigger | fallback | 1130 | 1130 | 0 | identical |
| redundant-cell-write | normalized | 48 | 8 | -40 | identical |

## Equivalence families

| Family | Variants | Input cases | Verified executions / declared | Converged groups / declared |
| --- | ---: | ---: | --- | --- |
| pairwise-arithmetic/1 | 4 | 5 | 20 / 20 | 5 / 5 |
| ordered-numeric-sum/1 | 6 | 8 | 48 / 48 | 8 / 8 |
| private-object-increment/1 | 4 | 1 | 4 / 4 | 1 / 1 |
| pure-selection/1 | 3 | 5 | 15 / 15 | 5 / 5 |

## Negative cases

Passed 28 / 28. False merges: 0. Unsafe profile admissions: 0.

| Case | Stage | Result | Reason |
| --- | --- | --- | --- |
| different-tree-same-sample | independently-checked-execution | passed | Expected distinction/refusal preserved |
| floating-point-reassociation | independently-checked-execution | passed | Expected distinction/refusal preserved |
| reverse-traversal | source-recognition | passed | No certified algorithm profile: Algorithm lowering: input property access, hooks, or unsupported traversal require a detailed boundary; Algorithm effect lowering: a simple asynchronous entry is required |
| loop-input-mutation | source-recognition | passed | No certified algorithm profile: Algorithm lowering: input or escaping object mutation requires a visible state change; Algorithm effect lowering: a simple asynchronous entry is required |
| loop-extra-index-update | source-recognition | passed | No certified algorithm profile: Algorithm lowering: loop index may change only at the certified update; Algorithm effect lowering: a simple asynchronous entry is required |
| loop-reset-accumulator | source-recognition | passed | No certified algorithm profile: Algorithm lowering: fold step must add the current element after the accumulator exactly once; Algorithm effect lowering: a simple asynchronous entry is required |
| loop-wrong-accumulator | source-recognition | passed | No certified algorithm profile: Algorithm lowering: fold step must add the current element after the accumulator exactly once; Algorithm effect lowering: a simple asynchronous entry is required |
| reduce-not-certified | source-recognition | passed | No certified algorithm profile: Algorithm lowering: observable or unsupported expression CallExpression; Algorithm effect lowering: a simple asynchronous entry is required |
| returned-private-object | source-recognition | passed | No certified algorithm profile: Algorithm lowering: observable or unsupported object identity; Algorithm effect lowering: a simple asynchronous entry is required |
| input-object-write | source-recognition | passed | No certified algorithm profile: Algorithm lowering: input or escaping object mutation requires a visible state change; Algorithm effect lowering: a simple asynchronous entry is required |
| effect-exposed-object | source-recognition | passed | No certified algorithm profile: Algorithm lowering: observable or unsupported expression CallExpression; Algorithm effect lowering: a simple asynchronous entry is required |
| captured-private-object | source-recognition | passed | No certified algorithm profile: Algorithm lowering: observable or unsupported expression ArrowFunctionExpression; Algorithm effect lowering: a simple asynchronous entry is required |
| getter-hook | source-recognition | passed | No certified algorithm profile: Algorithm lowering: private objects require ordinary static data properties; Algorithm effect lowering: a simple asynchronous entry is required |
| inherited-property | source-recognition | passed | No certified algorithm profile: Algorithm lowering: private reads require an existing own data property; Algorithm effect lowering: a simple asynchronous entry is required |
| throwing-dead-work | source-recognition | passed | No certified algorithm profile: Algorithm lowering: BigInt arithmetic requires a detailed boundary; Algorithm effect lowering: a simple asynchronous entry is required |
| rng-dead-work | source-recognition | passed | No certified algorithm profile: Algorithm lowering: observable or unsupported expression CallExpression; Algorithm effect lowering: a simple asynchronous entry is required |
| recursive-dead-work | source-recognition | passed | No certified algorithm profile: Algorithm lowering: recursive or excessive helper expansion; Algorithm effect lowering: a simple asynchronous entry is required |
| shadowed-helper | source-recognition | passed | No certified algorithm profile: Algorithm lowering: unknown, shadowed, or effectful call requires a boundary; Algorithm effect lowering: a simple asynchronous entry is required |
| helper-capture | source-recognition | passed | No certified algorithm profile: Algorithm lowering: ambient, uninitialized, or captured binding captured; Algorithm effect lowering: a simple asynchronous entry is required |
| lexical-temporal-dead-zone | source-recognition | passed | No certified algorithm profile: Algorithm lowering: ambient, uninitialized, or captured binding x; Algorithm effect lowering: a simple asynchronous entry is required |
| helper-temporal-dead-zone | source-recognition | passed | No certified algorithm profile: Algorithm lowering: unknown, shadowed, or effectful call requires a boundary; Algorithm effect lowering: a simple asynchronous entry is required |
| block-temporal-dead-zone | source-recognition | passed | No certified algorithm profile: Algorithm lowering: ambient, uninitialized, or captured binding x; Algorithm effect lowering: a simple asynchronous entry is required |
| unreachable-lexical-shadow | source-recognition | passed | No certified algorithm profile: Algorithm lowering: ambient, uninitialized, or captured binding x; Algorithm effect lowering: a simple asynchronous entry is required |
| lazy-private-write | source-recognition | passed | No certified algorithm profile: Algorithm lowering: lazy alternatives cannot mutate private state without a join proof; Algorithm effect lowering: a simple asynchronous entry is required |
| short-circuit-private-write | source-recognition | passed | No certified algorithm profile: Algorithm lowering: short-circuit mutation requires a state join proof; Algorithm effect lowering: a simple asynchronous entry is required |
| selection-state-join | source-recognition | passed | No certified algorithm profile: Algorithm lowering: selection mutations require a state join proof; Algorithm effect lowering: a simple asynchronous entry is required |
| changed-effect | source-recognition | passed | No certified algorithm profile: Algorithm lowering: observable or unsupported expression CallExpression; Algorithm effect lowering: a simple asynchronous entry is required |
| finally-cleanup | source-recognition | passed | No certified algorithm profile: Algorithm lowering: unsupported statement TryStatement; Algorithm effect lowering: a simple asynchronous entry is required |

## Measurement boundaries

The JSON report retains every case, source/input identity, exact target, refusal/failure, byte category, distribution, and actual supplied JS context snapshot costs. JSONL envelope accounting is not native model framing. Token fields remain null without an executed qualified tokenizer. Historical token counts stay separate.

- Family source refusals are recognition checks, not executed behavioral proofs.
- Reported JSONL framing and JS snapshot costs are not native model transport measurements.
- Finite zero-false-merge results do not prove universal equivalence.
- Private source evidence and source-specific context are excluded from canonical core identity, not from measured public context.
