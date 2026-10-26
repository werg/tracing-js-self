# Canonical semantic source curriculum

Every executable source family is independently checked and emitted through
the same `semantic-execution/5` / `semantic-trace/5` selected harness.
There are **no alternative representation controls**.

The two source recipe catalogues remain useful for covering genuinely
different computations and effects: `training-v4` supplies authored source
expressions with callback, suspension, recovery and repeated invocation
cases; `benchmark-v1` supplies distinct algorithms and source-family
split metadata. The catalogue names describe input diversity, not trace
versions or teacher representations.

```sh
npm ci
node tools/generate-effectful-training.mjs --recipe training-v4 \
  --jobs 4 --out /tmp/semantic-training \
  --megatoken ../megatoken --python python3 \
  --tokenizer /path/to/tokenizer.json --require-native

node tools/generate-effectful-training.mjs --recipe benchmark-v1 \
  --jobs 4 --out /tmp/semantic-benchmark \
  --megatoken ../megatoken --python python3 \
  --tokenizer /path/to/tokenizer.json --require-native
```

Each source family is assigned to train/validation/test before input
variations, callback schedules or retries. Every descendant keeps that
split and source ancestry. Raw owned interpreter events and the original
V8 reference are **private** receipts. A real external effect must be
dispatched only after the selected request is validated; external arrival
and callback events are observed rather than synthesized.

Local verification does not imply native training admission. A candidate
is admitted only after independent source/outcome/effect checks, exact
journal replay, model-visible witness replay, pinned tokenizer and
native consumer visibility/loss checks. All failures and unsupported
source profiles remain explicit refusals.

See [semantic reasoning traces](SEMANTIC_REASONING_TRACE.md) and
[the current harness](SEMANTIC_HARNESS_V4_IMPLEMENTATION.md).
