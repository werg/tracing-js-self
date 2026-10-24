# Semantic execution training: active v3 implementation ledger

The one active public representation is
[semantic-execution/3 and semantic-trace/3](EFFECTIVE_TRACE.md).
The raw owned journal is separately versioned. This ledger describes **actual
working and missing paths**, not a claim that the complete redesign is done.

## Implemented

- The bounded `training-js/1` language profile uses a pinned Acorn parser,
  direct function entry and owned state; exact journal reconstruction/replay
  is an independent invariant from observable JavaScript agreement.
- Descriptor-only data graph import/reference observation preserves aliases,
  cycles, sparse holes, present undefined, array length, and null prototypes.
  Unsupported custom descriptors and exotic boundary values refuse explicitly.
- Static source inventory is published before execution. The compiler removes
  selected private bookkeeping, emits typed bounded primitive computations and
  choices, carries captured iteration-cell identities, represents ordinary
  mutations/allocations/guest calls and source-verified completion transfers.
  Private certificates identify actual contributing journal events; compiler
  output is independently checked after serialization.
- The sole v3 codec/scheduler/visibility/controller/exporter are
  `src/training/{format,schedule,visibility,controller,export}.js`. The
  controller processes selected public records transactionally, including
  no-repair arithmetic/witness violations, data mutations, checked shared-cell
  copies, owned job FIFO rules, deterministic seeded RNG, and immutable
  fixture-matched external requests. A bounded committed-state packet is
  `semantic-continuation/3`. Unrepresentable state refuses rather than
  truncating.
- `src/training/rollout.js` evaluates selected observable outcomes separately
  from witness consistency and reference-trace text differences.
  `causal-audit.js` validates public visibility without oracle sidecar, while
  `render.js` displays effective committed work.
- `src/training/admit.js` retains independent V8 outcome, executed primitive
  and branch checks. `npm run training:generate` generates candidate JSONL,
  `npm run training:recheck` recomputes private evidence and
  `npm run training:inspect` separates raw public, pretty output and private
  audit facts. Every refusal is counted, and `admitted=0` remains explicit.
- The paired `werg/megatoken` Python parser, native Episode import, physical
  UTF-8 checks, meridian/loss ownership, and committed logical-record
  dependencies use *only v3*. The workflow pins a specific paired revision;
  the native diagnostic byte codec is not a production-tokenizer measurement.
- Permanent owned boundary/ten-source readability fixtures include arithmetic,
  captured loops, aliases, callbacks, returned cleanup, caught exceptions,
  sparse data and source-context integrity. V3 generated cases are regression
  checked against independent observable reference outcomes.

## Still not complete

These are explicit delivery requirements, **not optional legacy execution
routes**:

- Full source-normalized coercion, accessor/proxy dispatch and every supported
  callback pattern, including evaluated values and all effective effects.
- Complete external-effects observation and independent trusted source
  schedules for ordered calls, out-of-order replies, rejection and cleanup.
  A standalone controller's typed operations do not imply admitted examples.
- Owned async Promise adoption/reaction/await/suspended continuation and
  quiescence policy integration through exporter, controller and native model
  recurrence, including legal microtask scheduling and required pending work.
- Automatic causal continuation when model history is full, with true
  production tokenizer budgets, exact real model prediction groups and
  selected-state-only semantic liveness.
- Independently admitted production/closure corpus candidates across all
  claimed supported families and complete refusal/accounting dashboards.
- Actual selected-model training and test runs across seeds 17, 29 and 43,
  the pinned historical baseline, v3 granularity policies and output-only
  controls. No learning quality or compute improvement is established yet.

The absence of these features remains a fail-closed projection or corpus
refusal; it is **not** a reason to reintroduce a v2 producer, serving controller,
schema compatibility fallback or a default-format option.

## Commands and evidence

```sh
npm ci
npm test
npm run training:generate -- --seed 42 --count 16 \
  --output training-local.jsonl --manifest training-manifest.json
npm run training:recheck -- training-local.jsonl
npm run training:inspect -- training-local.jsonl training-inspection.json
npm run training:evaluate -- \
  --selected actual-selected.jsonl \
  --reference training-local.jsonl \
  --output model-evaluation.json
```

**Caution:** the last command measures a *model* only when selected JSONL
really comes from a free-running model using prior committed context. Feeding
teacher records to the evaluator tests the deterministic evaluator, not
learned execution. Large open-ended programs are not safely sandboxed by Node
`vm` alone. Actual model training, tokenizer and accelerator resource receipts
must be supplied externally rather than invented.

The [governing plan](SEMANTIC_TRACE_REDESIGN_PLAN.md) contains the complete
acceptance checklist; see also the
[v3 implementation record](SEMANTIC_TRACE_V3_IMPLEMENTATION.md).
