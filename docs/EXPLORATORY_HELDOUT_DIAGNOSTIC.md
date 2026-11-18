# Exploratory held-out measurement of a diagnostic checkpoint

The optimizer smoke can be followed by a small independent test-family
measurement with `tools/build-exploratory-holdout.mjs` and
`tools/run-exploratory-holdout.py`. These tools deliberately use diagnostic
schemas. They do not manufacture a production semantic experiment budget,
SE/SC qualification, or a confirmatory pilot receipt.

## Freeze before inference

```sh
node tools/build-exploratory-holdout.mjs \
  --training-run /path/to/completed-optimization-smoke \
  --tracer-root /path/to/immutable-producer \
  --registry /path/to/frozen-source-registry.json \
  --corpus /path/to/engineering \
  --corpus /path/to/training-v4 \
  --corpus /path/to/benchmark-v1 \
  --output /path/to/new-frozen-diagnostic-cohort.json
```

The builder reconstructs the global source registry, authenticates every
training member against the exact producer implementation, and excludes every
prepared training component, including members that a short optimizer cap did
not sample. It authenticates test candidates against that same registry and
requires the recorded native consumer and tokenizer identities to match the
completed training run. A renamed source or wrapper cannot become an independent
component merely by changing its case ID.

One representative is selected per test component: the smallest measured
generated-token count, then public byte count and case ID. With an explicit cap,
families are taken in alphabetical order. The policy is fixed before held-out
model inference and does not inspect model outputs. The cohort records the exact
source exports, private expectations, request envelopes, component membership,
training report, source manifests, registry, seed, and decoding caps. The initial
purpose is a bounded feasibility measurement across all available test families;
it does not estimate the full input/schedule distribution.

## Run the actual models

```sh
/path/to/python tools/run-exploratory-holdout.py \
  --cohort /path/to/new-frozen-diagnostic-cohort.json \
  --tracer-root /path/to/immutable-producer \
  --consumer-root /path/to/exact-megatoken-checkout \
  --tokenizer-json /path/to/tokenizer.json \
  --output /path/to/new-diagnostic-comparison
```

The runner independently rebuilds the cohort and compares its entire content
except the timestamp, then rechecks each selected example through fresh producer
source/journal/replay and native admission. No test example is relabeled or used
for optimization. It loads the actual base and trained checkpoints and confirms
that each served model matches its checkpoint tensors and immutable identity.

Both models then run through the real selected driver with the frozen seed and
the same token/time caps. The evaluator receives only source, invocation inputs,
and the broker fixture. Expected outcomes stay outside it; teacher-selected
actions are removed. Original emitted bytes, token IDs, first failure, hard
gates, effect/cleanup state, and serving costs are retained after each rollout.

The report gives both family-weighted and episode-weighted whole-task observable
correctness. Success requires the complete source-derived return/throw, graphs,
ordered effects/callbacks, and cleanup outcome, with no integrity-gate failure.
A process failure counts as an unsuccessful attempt and never becomes missing
data or an assumed zero gate count. This one-seed representative sample receives
no confirmatory uncertainty interval or broad transfer claim. Zero successes
remain a valid measured outcome.

## Remaining production prerequisites

The P1 diagnostic configuration explicitly has `purpose: diagnostic`, a newly
initialized tiny model, no `semantic_experiment`, and no qualified production
SE/SC launch. It therefore cannot produce the native
`semantic-experiment-budget/4` required by the strict learning comparator.
The available diagnostic bundles do not establish the production donor imports,
immutable hindsight targets, required SE/SC train and validation stage supply,
or qualified coordinator/bootstrap checkpoint ancestry. A production run must
provide and pass those actual native launch gates, with a declared budget and
the appropriate runtime resources. A confirmatory comparison additionally
requires at least three planned optimizer seeds and its independently frozen
native evaluation cohort. The diagnostic tools do not weaken those requirements.
