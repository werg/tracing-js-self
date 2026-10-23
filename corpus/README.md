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
