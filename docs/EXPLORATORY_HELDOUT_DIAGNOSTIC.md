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
  --consumer-root /path/to/exact-megatoken-checkout \
  --tokenizer-json /path/to/tokenizer.json \
  --python /path/to/native-environment/python \
  --registry /path/to/frozen-source-registry.json \
  --corpus /path/to/engineering \
  --corpus /path/to/training-v4 \
  --corpus /path/to/benchmark-v1 \
  --output /path/to/new-frozen-diagnostic-cohort.json
```

The builder reconstructs the global source registry, authenticates every
training member against the exact producer implementation, and independently
loads the actual checkpoint's training configuration. The native inventory helper
reads its checksummed prepared index and episode shards, matches every full native
episode and lineage to the declared source exports, and rebuilds the exact native
stream fingerprint bound by the saved checkpoint cursor. Omitting a source from
the report cannot remove its component from the exclusion set. The builder excludes
every prepared training component, including members that a short optimizer cap did
not sample. This bounded helper supports the synchronous single-root P1 diagnostic
profile and refuses other training modes. It authenticates test candidates against that same registry and
requires the recorded native consumer and tokenizer identities to match the
completed training run. A renamed source or wrapper cannot become an independent
component merely by changing its case ID.

One representative is selected per test component: the smallest measured
generated-token count, then public byte count and case ID. With an explicit cap,
families are taken in alphabetical order. The policy is fixed before held-out
model inference and does not inspect model outputs. The cohort records the exact
source exports, private expectations, request envelopes, component membership,
training report, actual native inventory, source manifests, registry, seed, and decoding caps. The initial
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
that each served model matches its checkpoint tensors, geometry, global step,
tokenizer bytes and identity, and transducer bank attachment. Native export's
single bank cache-version increment is checked explicitly.

Both models then run through the real selected driver with the frozen seed and
the same token/time caps. The evaluator receives only source, invocation inputs,
and the broker fixture. Expected outcomes stay outside it; teacher-selected
actions are removed. Original emitted bytes, token IDs, first failure, hard
gates, effect/cleanup state, and serving costs are retained after each rollout.

The report gives both family-weighted and episode-weighted whole-task observable
correctness. Success requires the complete source-derived return/throw, graphs,
ordered effects/callbacks, and cleanup outcome, with no integrity-gate failure.
All five hard-gate counters and all three cleanup counters must be present as
nonnegative integers. The exact case, origin, representation, seed, checkpoint,
and tokenizer identities must match, and the serving profile must record complete
execution with a closed runtime. An empty gate object cannot pass.
A process failure counts as an unsuccessful attempt and never becomes missing
data or an assumed zero gate count. This one-seed representative sample receives
no confirmatory uncertainty interval or broad transfer claim. Zero successes
remain a valid measured outcome.

The hardened builder emits `exploratory-heldout-diagnostic-cohort/2`; the runner
requires that version. Original version-1 experiments remain historical artifacts.
A later inventory or score audit must be saved separately, explicitly labeled
retrospective, and must never rewrite the original frozen cohort or model outputs.

```sh
/path/to/native-environment/python tools/audit-exploratory-evidence.py \
  --training-run /path/to/completed-optimization-smoke \
  --cohort /path/to/original-frozen-diagnostic-cohort.json \
  --heldout-run /path/to/original-diagnostic-comparison \
  --tracer-root /path/to/immutable-producer \
  --consumer-root /path/to/exact-megatoken-checkout \
  --tokenizer-json /path/to/tokenizer.json \
  --output /path/to/new-retrospective-audit
```

The audit executes no optimizer or model inference. It rebuilds cohort membership
from the actual checkpoint inventory, authenticates each served bundle and
original admission receipt, rescores the retained paired raw outputs, and binds
the audit to their unchanged hashes. Historical raw artifacts stay intact even
if verification fails; failures are not rewritten into successful measurements.
Run in the original pinned source environment, including its timezone. The
retained November 18 baseline uses `TZ=UTC LC_ALL=C.UTF-8`; the identity guard
correctly refuses those source exports under a different resolved timezone.

The standard Python tests exercise missing gates and substituted identities.
Additional tests against actual retained checkpoint files are enabled with
`TRACING_DIAGNOSTIC_RUN=/path/to/completed-optimization-smoke` and
`TRACING_DIAGNOSTIC_CONSUMER=/path/to/exact-megatoken-checkout`, with the native
checkout's `src` on `PYTHONPATH`. They deliberately rehash altered tokenizer,
model-configuration, and transducer files, and omit a declared training input;
all such substitutions must be refused.

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
