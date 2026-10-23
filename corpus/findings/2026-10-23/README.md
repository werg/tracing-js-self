# Real-source JS/TS trace findings — 23 October 2026

The corpus includes 78 unchanged, pinned Lodash/VS Code utility functions and 12 deterministic invocations per function. These files preserve the **specific observation and owned-interpreter coverage evidence** from [the pinned CI run](https://github.com/werg/tracing-js-self/actions/runs/39934287261) (commit [`d02d27472736`](https://github.com/werg/tracing-js-self/commit/d02d27472736d3629ac06cc0087a05b509e1c3d7)). Source revisions and licenses are in [`../../cases.mjs`](../../cases.mjs) and [`../../upstream/`](../../upstream/).

## Quantitative findings

| Metric | Measured value |
| --- | ---: |
| Functions (VS Code / Lodash) | **78** (58 / 20) |
| Native V8 observation invocations | **936** |
| Matched independent uninstrumented final outcomes | **936/936** |
| Intermediate events independently verified | **Not established** |
| Trace events | **27,039** |
| Median / p90 events per trace | **22 / 58** |
| Median / p90 serialized event bytes | **2,479 / 5,728** |
| Observed changes to heap properties | **3,656** |
| Branch / read / call records | **4,795 / 2,896 / 3,278** |
| Train / validation / test invocations | **672 / 228 / 36** |
| Owned execution locally verified | **24/156 (12 functions)** |

The native observations are **diagnostic effective-observation/1** records. Independent V8 checks compare return/throw and the reachable argument/result graph, not a complete event-by-event oracle. In particular **936 successful native observations do not imply support for 936 owned JS runs**. Nothing in this snapshot is admitted to megatoken as a validated `semantic-execution/2` training episode.

The owned coverage probe sampled two invocations of each of the 78 functions: 24 passed local verification, 52 were rejected for unsupported syntax/profile, 36 failed in the owned runtime, 36 used callback fixtures not portable across its entry boundary, and 8 exceeded the 2,048-byte source bundle. The original per-function evidence is [`owned-coverage.json`](owned-coverage.json), indexed in [`by-function.md`](by-function.md).

### Runtime failures worth implementing first

Of 36 owned runtime failures:

- **18** — ordinary property access / exotic lookup unsupported (9 functions, including `coalesce`, `move`, `sum`, and array mutators).
- **16** — string primitive as property receiver unsupported (8 functions, including `ltrim`, `rtrim`, `count`, and `fuzzyContains`).
- **2** — array length expansion outside the owned training profile (`insertInto`).

The 36 nonportable callback/comparator fixture invocations represent **18 more functions**. The 52 unsupported invocations span `new`, RegExp, `for...of`, top-level data and function/declaration shapes.

Prioritize owned callbacks and comparators; ordinary string/array property semantics; and common syntax/declaration forms, adding independent V8 checks for each. Only then expand source bundling and effect/async modules to cover more application-like programs. An unsupported construct must fail explicitly, never be silently evaluated by a native runtime while masquerading as an owned trace.

## Quality, succinctness and necessary information

- **Pure computation:** VS Code `clamp` (5 records, 397 bytes) is readable; nested calls could be compacted while preserving intermediate `Math.max` and final `Math.min` values.
- **Mutation:** `coalesceInPlace` (49 records, 4,953 bytes) records six heap changes and the final array graph. Aliased objects, length truncation and writes must remain semantically visible. Do not delete an unchanged write merely because a final-state diff cannot detect it.
- **String loops:** `trim` (66 records, 6,073 bytes) repeats reads, conditions and `charCodeAt` calls; needs source-anchored loop reasoning instead of repeated low-level scaffolding.
- **Callbacks:** Lodash `arrayMap` (54 records, 5,653 bytes) shows callbacks' actual body computations, but call entry/result records are not paired cleanly for a reader.
- **Call-ordering:** **1,284** return→call adjacency candidates reflect that the native instrumenter records the *calling expression's result* after the inner call has executed. That is a source-level readability issue, **not** proof the program ran out of order.
- **Write metric warning:** the original quality report flags **4,039 `sameValueWriteCandidates`**. The actual condition is `write` with **no observed heap-property delta**; it includes ordinary lexical assignments and is *not* evidence of 4,039 redundant writes. The current audit uses clearer terminology. No `repeatedReadCandidates` were flagged by its **adjacent-only** check; this does not mean all other reads matter.
- **Source mapping:** zero out-of-range sites does not establish complete original TypeScript source-site correctness.
- **Hidden effects:** descriptor/proxy snapshots can omit internal effects, and native host/microtask behavior is not automatically captured. Keep the full trace of effective computation and effects, without attempting an interpreter-internal bijection.

For reviewable examples, see [`readable-examples.md`](readable-examples.md). For ranked, unedited original inspection excerpts, see [`quality-inspection.md`](quality-inspection.md). Both are derived from V8 diagnostics, **not** served owned traces.

## Inspect the original findings

- [`summary.json`](summary.json) — machine-readable counts and limitations.
- [`owned-coverage.json`](owned-coverage.json) — all 156 individual attempts with reasons.
- [`by-function.md`](by-function.md) — 78-family comparative matrix.
- [`readable-examples.md`](readable-examples.md) — original five representative executions.
- [`quality-inspection.md`](quality-inspection.md) — original ranked audit, including its historical field names.

The complete `traces.jsonl` is reproducible and available as a [CI artifact](https://github.com/werg/tracing-js-self/actions/runs/39934287261), rather than duplicating ~7 MB of generated JSONL in the git history.

## Reproduce on current `main`

```sh
npm ci
npm run corpus:generate -- --per-function 12 --max-events 2400 \
  --output corpus/out/traces.jsonl --report corpus/out/report.json \
  --review corpus/out/review.md
npm run corpus:audit -- --input corpus/out/traces.jsonl \
  --output corpus/out/quality.json --review corpus/out/quality.md --examples 30
npm run corpus:owned-coverage -- --input corpus/out/traces.jsonl \
  --output corpus/out/owned-coverage.json --per-function 2
```

These are a **dated baseline**; newer runtime and compiler changes can alter coverage. Training splits are by function, but only three test function families span the current test set, and both projects appear in training; expand project/module-level holdouts before claiming cross-project generalization.
