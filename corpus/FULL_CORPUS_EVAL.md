# Exhaustive corpus evaluation and verified training candidates

**Reproducible pinned baseline (2026-10-23; PR #16 follow-up).**
This evaluates *every original utility fixture* and *every adversarial
stateful scenario*, while distinguishing model-servable owned traces from
native V8 diagnostics. The underlying source files remain unchanged.

## Entire utility corpus: 936 invocations

78 pinned Lodash and VS Code source functions × 12 deterministic inputs:

| Independently checked owned outcome | Executions |
| --- | ---: |
| **Locally verified owned `semantic-execution/2` candidates** | **558** |
| Unsupported training profile | 216 |
| Owned runtime failures | 114 |
| Whole original source bundle beyond configured model budget | 48 |
| **Total** | **936** |

The initial two-input smoke still verifies **93/156**. Extrapolating that
smoke count to the other inputs would have hidden the input-specific failure
in VS Code `formatTokenCount`. Bounded owned `Number.prototype.toString` and
`toFixed` now resolve that last observed scalar formatting gap, with
independent V8 operation/control checks, archive replay and controller
verification.

Outstanding exact categories across **all twelve** input vectors:

| Category | Invocations |
| --- | ---: |
| RegExp literals and matching | 84 |
| Top-level declarations and module-like source | 72 |
| Unmodeled ordinary/exotic property lookup | 66 |
| Whole helper bundle exceeds source budget | 48 |
| Constructors (`new`) | 48 |
| Array length expansion, holes and descriptors | 24 |
| Array-constructor/uncallable owned builtin | 24 |
| Parameter patterns (including rest) | 12 |
| **Unverified** | **378** |

The last four figures are not necessarily disjoint *semantic capabilities*:
this ledger reports the **first failure encountered** per invocation.
Solving an early blocker may reveal later ones. Do not assume the count is
a linear estimate of implementation work.

### Full 936-case verification

The PR workflow generates all 936 independently matching native V8 outcomes,
then launches six complete owned partitions with inputs `0..1`, `2..3`,
`4..5`, `6..7`, `8..9`, and `10..11` for every one of the 78 families.
Each partition rejects duplicates, missing family/index identities, source
tampering and failed serialized evidence rechecks. Its optional
`owned-N-local.jsonl` contains **only locally verified candidates** with
their immutable pinned lineage, public groups and private audit sidecars.
The merge job requires a 936/936 identity inventory and a measured minimum of
558 locally verified cases; it publishes a per-family report and every
remaining refusal reason.

To reproduce from a native corpus generated at `--per-function 12`:

```sh
for start in 0 2 4 6 8 10; do
  end=$((start+2))
  npm run corpus:owned-coverage -- \
    --input corpus/out/traces.jsonl --per-function 12 \
    --index-start "$start" --index-end "$end" --require-complete \
    --output "corpus/out/owned-$start.json" \
    --local-episodes "corpus/out/owned-$start-local.jsonl"
done
npm run corpus:owned-merge -- \
  --require-complete --min-owned-verified 558 \
  --output corpus/out/owned-all-summary.json \
  --review corpus/out/owned-all-review.md \
  corpus/out/owned-{0,2,4,6,8,10}.json
```

The owned execution gate *does not admit episodes into megatoken*. Its
`public.groups` provide the only model-visible trajectory. A separate
versioned consumer/schema/serving/teacher-conditioning gate is required;
`sidecar` remains private.

## Entire stateful corpus: 912 invocations

76 scenario families (12 each), spanning MIT-licensed production modules in
mitt, Zustand, eventemitter3, yocto-queue, quick-lru, koa-compose, p-limit,
Axios and multi-library applications:

| Diagnostic observation | Measured |
| --- | ---: |
| Independent uninstrumented-V8 observable agreement | **912/912** |
| Returns / throws or rejections | 828 / 84 |
| Observed execution events | 236,741 |
| Observable heap-property changes | 130,294 |
| Invalid/out-of-range source sites | 0 |
| Opaque result tokens (e.g. symbol/unknown) | 840 |
| Vendor implementation source-site events | 175,917 |
| Authored driver source-site events | 32,396 |
| Module loader source-site events | 27,504 |

**Important:** Vendor source-site events frequently execute *during* a
driver invocation; they are not necessarily initialization noise. They
should not be removed based on source location alone. The 840 opaque
results are explicit diagnostic limitations and should not be treated as
independently checked intermediate training targets.

```sh
npm run corpus:stateful -- --per-scenario 12 --min-verified 912 \
  --output corpus/out/stateful-traces.jsonl \
  --report corpus/out/stateful-report.json \
  --review corpus/out/stateful-review.md
npm run corpus:stateful:audit -- \
  --input corpus/out/stateful-traces.jsonl --require-complete \
  --min-verified 912 \
  --output corpus/out/stateful-quality.json \
  --review corpus/out/stateful-quality.md
```

The separate audit verifies every scenario index/seed, vendored module hash,
frozen split, event/heap accounting, source range, and declared side-effect
receipt. On pull requests touching this pipeline, CI runs the complete
stateful diagnostic job and publishes its quality report.

These **912 V8 observations are diagnostic, not owned traces**. The independent
reference checks observable final completion/graph and explicit side
effects, **not every getter, proxy trap, hidden Map/Set effect, async
microtask, or intermediate event**. This work deliberately does not label
those observations eligible for supervised trace prediction.

## Next semantic priorities

Owned array constructors and hole-aware array operations; resuming ordinary
callback operations (`map`, `filter`, `reduce`); RegExp state and
`lastIndex`; pinned source module initialization; rest/spread and new
constructors; and a model-visible dependency/module context format. Each
feature requires independent operation-level evidence and a repeatable
case-specific regression before its traces may be counted as locally verified.

Preserve upstream copyrights and licenses; evaluate distribution terms before
training on original vendor source.
