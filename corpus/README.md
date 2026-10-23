# Real-source observation corpus

This directory holds unmodified, pinned open-source JS/TS utility source
snapshots for extracting individual production functions. The code is not a
synthetic exercise. The invocations in cases.mjs are deterministic fixtures.

## Provenance

- VS Code by Microsoft: MIT, revision
  2bc7d5ab6919c62e60379e5e1f840bd80846dbdb. Original files:
  src/vs/base/common/numbers.ts, arrays.ts and strings.ts.
  Original terms in upstream/vscode/LICENSE.txt.
- Lodash by the OpenJS Foundation and other contributors: MIT-compatible
  notice with additional attribution, revision
  c6e281b878b315c7a10d90f9c2af4cdb112d9625. Twenty-one original
  helper implementation files and upstream/lodash/LICENSE.

Keep copyright notices and origin/license information when redistributing.
Training use and source terms still require review.

## Generate

  npm ci
  npm run corpus:generate -- --per-function 12 --output /tmp/traces.jsonl \
    --report /tmp/corpus-report.json --review /tmp/corpus-review.md

The result is a DIAGNOSTIC effective-observation/1 corpus, produced by
instrumenting trusted V8 executions. Each example also runs uninstrumented
in a second V8 realm. The tool compares return/throw and the observable graph
of arguments plus result. Unsupported features, mismatches, and budget failures
are counted rather than hidden.

Do not feed these observations into the semantic-execution/2 training importer.
The native observation profile is not the owned interpreter: it does not
provide authoritative journal replay, public controller validation or
independently certified intermediate values.

The source family, not the input, determines the frozen split; the recorded
source revision and whole-file SHA256 permit reproducibility. Guest setup
callbacks are explicitly marked and are not instrumented. Keep the full
initial fixture available to any model that will later train on these examples.

## Locally verified owned trace candidates

The native observation JSONL is **not training data**. A separate, fail-closed
bridge can attempt real-source functions through the owned interpreter, with
independent V8 outcome, operation and branch checks, exact archive replay,
public-controller evaluation and rechecking after serialization:

```sh
npm run corpus:owned-coverage -- \
  --input corpus/out/traces.jsonl \
  --output corpus/out/owned-coverage.json \
  --per-function 2 --min-owned-verified 89 \
  --local-episodes corpus/out/owned-locally-verified.jsonl
```

This optional JSONL contains **only** cases marked `locally_verified` after
evidence recheck. Its `public` member is the canonical model-visible
`semantic-execution/2` trajectory; its `sidecar` is strictly private
supervision/audit evidence, **not** predictor context. A lineage and provenance
receipt records source family, upstream revision and whole-file SHA256, license,
fixture index, and the frozen function-level split. Native and owned producers
share the exact upstream-source extraction. The bridge rejects mismatched
pinned source bytes, revision, license, URL and split rather than treating
diagnostic V8 success as sufficient.

These are **locally verified candidates only**. They remain non-admitted until
the independent megatoken schema, teacher-conditioning, model-serving and
execution-validation gates pass. The optional floor guards against regressions
relative to the original dated 24/156 owned baseline (the current verified floor is 89/156); it is not a completeness claim.
Unsupported syntax, unsafe guest callbacks, oversized source, effectful
programs and reference disagreement remain explicit coverage failures.

## Missing paths before near-general trace generation

1. Native/third-party imports, ESM initialization, and TS source-site mapping
   with explicit coverage of dependency work.
2. Async ordering, scheduling, timers, workers, and observable host effects.
3. Accurate Map/Set, typed array, RegExp, Date and exotic-object representations,
   plus semantics of property accessors, prototypes and proxy traps.
4. Independent operation-level checks for effectful executions, beyond final
   observable outcome equality, and bounds on instrumentation perturbation.
5. A serving controller that can commit selected effective observations without
   running guest JavaScript or inventing missing state.

The current code is NOT capable of faithfully tracing pretty much any program.
It adds a broad diagnostic lens to prioritize and eventually close those gaps.

## Committed findings

The pinned 936-invocation V8 observation analysis and 156-invocation owned-interpreter coverage assessment, with representative traces and full per-function reasons, are in [findings/2026-10-23](findings/2026-10-23/README.md). These are diagnostic reports, not admitted training data.

## Stateful adversarial programs

The separate [stateful benchmark](stateful/README.md) adds **76 real-library
scenario families** exercised across eight pinned MIT-licensed production
libraries (mitt, Zustand, eventemitter3, yocto-queue, quick-lru, koa-compose,
p-limit and Axios interceptors). It includes mutable subscriptions, reentrant callbacks,
middleware request paths, cache eviction, queued work, asynchronous failures
and six cross-library application integrations.

```sh
npm run corpus:stateful -- --per-scenario 12 \
  --output corpus/out/stateful-traces.jsonl \
  --report corpus/out/stateful-report.json \
  --review corpus/out/stateful-review.md
```

The expected full run attempts **912 stateful invocations** in addition to
the initial 936 utility invocations. Family splits are package-oriented.
These runs are independently compared at **final observable state and explicit
side effects**, not independently audited operation-by-operation. Like the
original utility benchmark, they remain **native V8 diagnostics**, not
admitted owned `semantic-execution/2` training data. The original
vendor source and licenses are under `stateful/upstream/`.

The [dated 912-run findings and trace-quality assessment](stateful/findings/2026-10-23/README.md)
record exact coverage and remaining evidence limitations.
