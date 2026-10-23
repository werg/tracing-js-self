# Corpus failure classes after the owned-array and static-binding work

Snapshot: 2026-10-23, pull request #17. Exact 936-invocation native source corpus
and six independently verified owned-runtime partitions. These are locally
verified diagnostics, **not** examples admitted to an external model trainer.

## Verified coverage

| | Earlier merged main | This branch |
| --- | ---: | ---: |
| Real-source functions | 78 | 78 |
| Indexed invocations checked | 936 | 936 |
| Locally verified owned executions | 558 | **684** |
| Unverified | 378 | **252** |
| First two inputs verified | 93/156 | **114/156** |
| Native V8 outcome comparisons | 936/936 | 936/936 |

The CI aggregation retains the complete per-invocation ledger. Each verified
candidate passes owned execution, exact archive replay, separate V8 outcome,
executed source-operation/branch audits, public-controller rollout and a fresh
post-serialization evidence check.

## Outstanding classes

| Count | Failure class | Required work |
| ---: | --- | --- |
| **84** | Regular expression syntax and RegExp methods | Owned RegExp identity and mutable lastIndex, global/sticky iteration, capture groups, match/replace/split and callback effects. Do not substitute an opaque host regex evaluation for an independently checked effective trace. |
| **48** | Exact source bundle exceeds current budget | Source visibility and dependency segmentation for pinned, very large TypeScript CharCode enums; prove original-site mapping and reconstruction, not rewritten or truncated source. |
| **48** | Unsupported new expressions | Owned constructors for Error/TypeError and Set, including Set insertion/order/equality, method callbacks and observable mutation; prohibit unknown new targets. |
| **48** | Top-level program initializers outside the owned static subset | Data-initialized regexp constants, mutable module state and complete side-effectful initialization with owned, source-anchored initialization traces. Pure scalar aliases are now modeled. |
| **12** | Unmodeled property operation | Callback-based Array.prototype.sort in VS Code groupBy, including actual comparator invocation, stability, mutations and observable comparisons. |
| **12** | Rest parameter declaration and spread call | Owned argument-array construction, source-ordered expansion, aliases, limits and controller evidence for original concatArrays source. |
| **252** | **Total remaining** | **All retained as explicit failures** |

Each remaining class occurs more than three times. None is labelled fixed or
admitted in this PR.

## New supported owned behavior

- Calls of the intrinsic `Array(n)` produce owned arrays with genuine absent
  slots; model-visible allocations are checked rather than silently replacing
  holes with `undefined`.
- Array `filter`, `map` and `reduce` invoke synchronous guest callbacks
  through owned frames. A real invocation is published for each callback.
  Return-associated heap mutations are visible in the canonical trace and
  committed with version preconditions in the serving controller.
- Bounded array growth and writes past the current length preserve holes and
  independent V8-observable final state. Unsupported nondata/exotic methods
  remain rejected.
- Exact static global primitive declarations and allowlisted Math method
  aliases can be present in a source bundle; dynamic initializers and ambient
  effects still fail closed.

These changes extend source-level effective traces, not the model admission
contract. The 912-execution stateful V8 corpus is still separately diagnostic;
its intermediate events are not independently certified owned trajectories.

## Reproduce

```sh
npm ci
npm run corpus:generate -- --per-function 12 \
  --output corpus/out/traces.jsonl \
  --report corpus/out/report.json --review corpus/out/review.md
for start in 0 2 4 6 8 10; do
  npm run corpus:owned-coverage -- \
    --input corpus/out/traces.jsonl --per-function 12 \
    --index-start "$start" --index-end "$((start+2))" --require-complete \
    --output "corpus/out/owned-$start.json"
done
npm run corpus:owned-merge -- --require-complete --min-owned-verified 684 \
  --output corpus/out/owned-all.json --review corpus/out/owned-all.md \
  corpus/out/owned-{0,2,4,6,8,10}.json
```
