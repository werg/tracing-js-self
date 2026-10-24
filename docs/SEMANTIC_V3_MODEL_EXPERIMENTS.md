# Reproducible model-learning comparison (not a smoke test)

This runbook implements the **required recording and analysis contract** for
[the redesign experiment plan](SEMANTIC_TRACE_REDESIGN_PLAN.md). It does not
assert that a model has been trained or that measured learning results exist.
The experiment runner refuses an absent seed, candidate, checkpoint, history
or metering field rather than synthesizing outcomes from teacher traces.

## Historical baseline without a production v2 reader

Version two is **not** a supported production transport. Its baseline must be
run in a separately pinned historical checkout and evaluated there against the
same frozen common-capability cohort. Import only the historical evaluator's
explicit scored receipt, containing the pinned historical Git revision and a
SHA-256 of its independent evaluator receipt. No old wire-format decoder,
format switch or compatibility generator belongs in the active v3 process.

The prespecified conditions are:

| ID | Comparison |
| --- | --- |
| `historical-v2` | Pinned external historical benchmark (isolated) |
| `v3-fine` | Fine effective computation with mechanical metadata removed |
| `v3-fused` | Implicit reads, fused computation/binding/choice |
| `v3-expr-2` | Up to two operators per pure expression region |
| `v3-expr-4` | Up to four operators |
| `v3-expr-8` | Up to eight operators |
| `v3-collections` | Supported collection primitive versus callback expansion |
| `v3-outcome-only` | No optional reasoning records, but all required effects and observations |

Run seeds **17, 29 and 43 for every condition**. Use a fixed frozen
test-family inventory and actual model-selected output for each. Common
capability refusal counts must be frozen **before** results are examined;
unsupported new capabilities are reported separately.

## Required on-disk structure

```text
pinned-manifest.json
frozen-test.jsonl
selected/
  historical-v2/
    17.json
    29.json
    43.json
  v3-fine/
    17.json
    ...
  v3-fused/
  v3-expr-2/
  v3-expr-4/
  v3-expr-8/
  v3-collections/
  v3-outcome-only/
```

The manifest schema is `semantic-learning-experiment/1`; it requires exact
40-hex Git commits for tracer, megatoken and historical baseline, SHA-256
tokenizer, checkpoint and frozen cohort digests, training architecture,
optimizer, budgets and hardware, and train/validation/test family partitions
with SHA-256 content hashes. Split families cannot overlap. The cohort hash is
SHA-256 of JSON-stringified sorted `experimentCaseId(reference)` values,
where each case ID hashes exactly the observed source/input public prefix.

Each of the 24 run JSON files has `condition`, `seed`, and `cases`, one
entry per frozen reference case. Each v3 case must contain `caseId`, actual
`groups`, a `provenance` declaration
`{ "source":"free-running-model", "checkpointSha256":"..." }`,
and six **actual measured** `measurements` fields:
`generatedTokens`, `observedTokens`, `predictionGroups`,
`latencyMilliseconds`, `computeFlops`, and `peakMemoryBytes`.
Historical cases instead need
`{ "source":"pinned-historical-runner", "historicalCommit":"...",
"evaluationReceiptSha256":"..." }` and an
`externalAdjudication.correctness` of correct/incorrect/invalid/incomplete.

The aggregator enforces the same cohort across seeds/conditions, checks all
v3 selected trajectories using the sole public `SemanticController` and
`evaluateSelectedTrajectory`, reports witness consistency separately from
task correctness, computes model token/FLOP totals from supplied receipts,
and generates **family-clustered deterministic bootstrap intervals** for
correctness differences from the pinned historical baseline.

```sh
npm run training:experiment -- \
  --manifest pinned-manifest.json \
  --references frozen-test.jsonl \
  --runs selected \
  --output paired-model-report.json
```

The evaluator does **not** train a model, attest an external checkpoint,
validate the existence of independent historical source execution beyond its
declared receipt, or invent an inaccessible accelerator benchmark. A report
of supplied measurements must not be promoted to an independently verified
training result without checkpoint artifacts, training logs, tokenizer and
hardware receipts. If no authorized model execution capacity is connected,
the required model-training experiment remains **unmet**.

Unit tests exercise its deterministic scoring and missing-data rejection
using synthetic arithmetic fixtures. Those fixtures are **not model results**.

The native megatoken converter uses the sole semantic-execution/3 format;
`tools/evaluate-training-experiments.mjs` is deliberately an offline scoring
tool, not an alternate public tracer or historical v2 serving code path.
