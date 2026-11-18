# Frozen execution-learning pilot

The pilot uses the actual pinned Megatoken optimizer, checkpoints, tokenizer,
selected driver and broker. It compares the initialized base with a checkpoint
chosen using validation source families. It measures free-running execution;
teacher-forced loss is retained as an optimization diagnostic.

## Freeze before optimization

All input campaigns must have been generated from the same clean producer
revision and one global frozen source registry. Every accepted export must have
an actual native admission receipt. The freeze command reruns the independent
source, journal, replay and native receipt binding checks in that producer
checkout. It never promotes local verification to native admission.

```sh
node tools/freeze-learning-experiment.mjs \
  --corpus /path/to/admitted-corpus \
  --tracer-root /path/to/immutable-producer \
  --out /path/to/private-experiment.json \
  --minimum-improvement 0.05 --mode exploratory \
  --optimizer-seeds 17 --initialization-seed 17 --decoder-seed 17 \
  --checkpoint-steps 16,64 --rollout-tokens 32 --rollout-timeout 120 \
  --train-examples 32 --validation-cases 16 --test-cases 32 --auxiliary-cases 32
```

Repeat `--corpus` to combine streams qualified against the same registry.
Compatibility JSON exports must be materialized first when the campaign used
compact storage. Selection visits each authenticated source component before
selecting a second input variant from a component. The frozen file reports both
available and selected episode, source-family and component denominators, and
actual native learner-token counts. Corpus refusal counts remain in its manifest
bindings.

The experiment file is private evidence. Test and validation expectations stay
outside the model; only each case's `envelope` enters the selected evaluator.
Controlled teacher selections are removed. Source, inputs and broker fixtures
retain their normal selected-driver visibility rules.
For a larger admitted corpus, `--verification-concurrency 4` runs independent
source rechecks concurrently (supported range 1–8; default 1). Every admitted
candidate still receives the same immutable producer verification. Output
ordering remains deterministic; any rejection aborts the declaration, and a
file changing during verification is rejected. Concurrency does not discard
failed candidates or change selection membership.

The file fixes optimizer seeds, a separate initialization seed, a separate decoder
seed, checkpoint steps, native training window and wall-time budgets, inference
fragment/time budgets, a practical improvement threshold, a maximum critical
slice regression, a bootstrap RNG seed and the confirmatory component minimum.
It is written exclusively and must not be rewritten after seeing model results.
The optimization report binds its exact SHA-256 before constructing the model.
The selected inference limit is `nativeMaxTokensPerFragment`; the pinned native
adapter allows up to 64 fragments per decision. Its token cap is not a whole-task
or whole-decision limit. Original emissions supply the measured total cost.
Legacy declarations with `tokensPerDecision` remain immutable and receive an
explicit per-fragment interpretation in later measurement reports.

## Optimize and retain the declared checkpoints

```sh
PYTHONPATH=/path/to/megatoken/src /path/to/python tools/run-optimization-smoke.py \
  --corpus /path/to/admitted-corpus \
  --tracer-root /path/to/immutable-producer \
  --consumer-root /path/to/megatoken \
  --tokenizer-json /path/to/tokenizer.json \
  --experiment /path/to/private-experiment.json \
  --output /path/to/new-smoke-output \
  --examples 32 --steps 64 --seed 17 --initialization-seed 17 \
  --rollout-cases 4 --rollout-tokens 32 --train-timeout 900
```

The requested example count must equal the frozen training selection, and the
step cap must equal the last frozen checkpoint step. The runner verifies every
training file hash and immutable candidate identity before native preparation.
It retains all declared checkpoint candidates using the companion's supported
checkpoint interval and retention settings, capped at 100 periodic snapshots.
Without an experiment, the standalone smoke retains its existing every-step
checkpoint policy and the companion's bounded default retention.

The native sampler consumes all windows of each deterministically permuted
episode in sequence. Frozen membership therefore differs from actual training
exposure under a short cap. To run one complete native window per bounded
episode, freeze and pass `--training-window-records 256
--training-window-decisions 256`; check `native-window-plan.json` before claiming
this property. Larger episodes can still require multiple windows. The smoke
requires actual coverage of all selected episodes and records the original
native source counters. The pilot reports exposure and scored tokens at the
**selected checkpoint**, as well as at the end of training. Missing or incomplete
selected-checkpoint exposure prevents a confirmatory pass.

Initialization and optimizer seeds are separate. Keeping initialization fixed
permits multiple optimizer seeds to share the exact same base weights. The
trainer still loads the declared initialized checkpoint and verifies exact
phase-start weights. The final comparison checks the actual served base identity
across seeds rather than inferring equality from declared seeds.

The current runner intentionally uses a newly initialized tiny diagnostic
model. It does not load a pretrained execution model or satisfy production
SE/SC donor, hindsight, coordinator or launch requirements. Completed optimizer
steps do not imply that a complete execution has been learned. The smoke report
continues to record that distinction separately.

## Select on validation; score on test

```sh
PYTHONPATH=/path/to/megatoken/src /path/to/python tools/run-learning-pilot.py \
  --experiment /path/to/private-experiment.json \
  --smoke-report /path/to/new-smoke-output/report.json \
  --consumer-root /path/to/megatoken \
  --output /path/to/new-pilot-output \
  --rollout-tokens 32 --rollout-timeout 120
```

For each frozen optimizer seed, supply one `--smoke-report`. The runner rejects
an old run that did not bind this exact experiment before training, missing
seeds, altered training membership, missing checkpoint candidates, and changed
producer, consumer, tokenizer or served identities.

Every declared checkpoint receives complete validation evaluation. Ranking uses
component-weighted whole-task success, then component-weighted trace validity;
ties prefer the earlier step. All choices are durably sealed before any test
rollout begins. Base and selected trained models then see identical test cases
and decoder seed. No inference retries or injected selections are enabled.

Per-case files preserve the request, private expected result, original evaluator
bytes, original native decoder IDs, failures, cleanup and costs. A timeout is a
failed case and remains in the denominator. A failed decoder RPC without complete
original emission evidence contributes only a retained-token lower bound; a
complete RPC profile does not prove that zero tokens were generated. The process group is terminated;
other cases continue. Partial runs retain their phase, completed measurements,
checkpoint selections and exact artifact identities.

## Metrics and decision gates

The primary metric averages success within each connected source/ancestor
component, then averages the components equally. Input variants and wrappers
therefore do not increase a source family's weight. Episode-weighted scores,
source-family counts, component counts and every seed's score are also reported.
Whole-task success requires the expected completion, reachable state, ordered
effects and callbacks, required cleanup, valid original selections and zero
integrity-gate failures. Rejected selections count as failures even if a later
outcome matches.

The paired percentile bootstrap resamples components. All inputs and optimizer
seed results belonging to a sampled component stay paired; correlated rows do
not masquerade as independent observations. The report records the bootstrap
seed, replicate count and a 95% interval, warns below ten test components, and
reports seed variability separately. No statistical procedure manufactures
additional optimizer runs.

Slices include unseen source components, upstream-project/compositional
holdouts when present, effects, valid errors, cleanup, aliases, mutations,
retained state, generated-token length and heap size. Empty slices remain
`untested`. Costs include wall time and original decoder tokens per correct
task; when no task succeeds the ratio remains null. Incomplete emission evidence
is a token lower bound, not an exact total.

A confirmatory success requires a predeclared confirmatory experiment, at least
three optimizer seeds with the same actual base checkpoint, the declared
minimum test-component count (default 100), useful mean improvement, an interval
above zero, improvement in every seed, measured critical effects/error/cleanup
slices without material regression, and complete zero-failure integrity receipts.
An exploratory pilot still reports all measurements but cannot pass that gate.
These conditions are deliberate experiment rules, not proof of broad JS ability.

Pure code/input-to-outcome transfer has its own adapter and measured report,
described below. It must never be inferred from the selected-execution score.
New inputs for known training sources and counterfactual observation schedules
use separately frozen auxiliary cohorts. Pretrained-contamination absence
is not established by this repository's source registry.

## Checks

```sh
node --test test/training-learning-experiment.test.js test/training-optimization-cases.test.js
python -m unittest discover -s tools/native-consumer -p 'test_learning_evaluation.py'
python -m unittest discover -s tools/native-consumer -p 'test_optimization_measurement.py'
```

Statistical unit tests use clearly synthetic receipts. They verify grouping,
denominators, leakage boundaries, deterministic uncertainty and checkpoint
selection; their passing results are never reported as learned performance.


## Frozen known-source input and schedule slices

The freeze command also reserves up to `--auxiliary-cases` (default 32) eligible
training-split candidates that were **not** selected for optimization. Their
source component remains `train`; they never join the primary unseen-source
score. They are bound to a specific selected training case with the same exact
source, entry and invocation structure.

- `new-inputs-known-source` requires an input graph or declared guest RNG seed
  not present among any selected training case for that exact source.
- `different-observations` keeps source and initial input fixed while changing
  the canonical external fixture (values, outcomes or callback observations).
- `different-schedules` keeps source and initial input fixed and changes the
  normalized asynchronous settlement order. An explicit default order and its
  omitted equivalent have the same identity.

Exact source/input/observation/schedule duplicates are excluded. Different
wrappers do not become "known source" merely because they share an ancestor
component. Auxiliary IDs, membership, matching training case, input/fixture
identities and slice classification are frozen before the optimizer report
binds the experiment. Their private expectations stay outside the model.

After validation selects and seals the checkpoint, the pilot evaluates these
reserved cases with both actual models and the same inference caps. It writes
separate `auxiliarySlices` metrics, preserves every failed case, and reports
unavailable slices as `untested`. Primary held-out membership, scores and
uncertainty remain unchanged. Older frozen declarations without auxiliary
members continue to measure precisely their original scope; an in-flight
experiment is never retroactively expanded.

## Separate pure-output transfer

`pure-output-transfer.mjs` extracts only already frozen, independently qualified,
effect-free single invocations. It explicitly refuses effects, multi-invocation
sessions and bound receivers outside its positional-argument graph contract.
The public request contains exact source, entry, initial input graph, declared
random seed, decoder seed and completion policy. It contains no teacher trace,
future fixture, expected result or final state.

```sh
node tools/pure-output-transfer.mjs freeze \
  --experiment /path/to/private-experiment.json \
  --out /path/to/private-pure-test.json --split test

/path/to/python tools/run-pure-output-transfer.py run \
  --cohort /path/to/private-pure-test.json \
  --model-command /path/to/python \
  --model-args '["/path/to/tracer/tools/native-pure-output-model.py","--consumer-root","/path/to/megatoken","--served","/path/to/served-base","--max-tokens","128"]' \
  --checkpoint-identity ACTUAL_SERVED_MODEL_SHA256 --origin fixed-weights \
  --consumer-root /path/to/megatoken --tokenizer-json /path/to/tokenizer.json \
  --output /path/to/new-pure-base --max-tokens 128 --timeout 120
```

Run the identical frozen cohort and budget with the selected trained served
bundle, its actual checkpoint identity and `--origin trained`. Compare the
complete paired reports:

```sh
/path/to/python tools/run-pure-output-transfer.py compare \
  --base /path/to/new-pure-base/report.json \
  --trained /path/to/new-pure-trained/report.json \
  --output /path/to/pure-comparison.json
```

The supplied native adapter uses the pinned `MultiTrackRuntime` with real loaded
served weights. It removes routing IDs and decoder metadata before constructing
the model context, attests the exact observed field names and payload hash,
and observes only the source/input request and uses the
actual decoder to emit an outcome. It performs no JavaScript execution,
controlled selection, inferred teacher substitution or post-generation repair.
The same model can be evaluated on both endpoints without restoring an old
production trace exporter. The separate task instruction and whole-output token
budget are recorded scope differences; there is no claim of matched compute
with multi-decision selected execution.

An outcome is one JSON object with `kind` (`return` or `throw`) and `graph`.
The graph's roots are the final mutated input arguments in original order,
followed by the returned or thrown value. Nodes use the existing bounded data
codec: canonical scalar tags and `{id, kind, properties}` objects, including
explicit null prototypes and sparse array length. IDs may be renamed. The
scorer establishes a rooted bijection, so it preserves aliasing and cycles and
rejects both copied aliases and collapsed distinct objects. It also compares
mutations, property order, sparse holes, signed zero, prototypes and throw kind.
Only reachable data belongs in the output. Bounded declared Error throws use
the already qualified name/message observation profile.

### Model-command protocol

A model command reads exactly one `semantic-pure-output-request/1` JSON document
on stdin and writes one `semantic-pure-model-response/1` document. The wrapper
contains `modelInputFields`, `modelInputSha256` and an explicit assertion that
routing metadata was excluded from the model context. It also contains the unchanged case ID and SHA-256 of the exact stdin bytes, actual
checkpoint/tokenizer identities, decoder seed, `payloadHex` for original model
bytes, and `emissions`. Each emission has a unique `selectedEventId`,
`payloadHex` and original `emittedTokenIds`. It also declares native generation
validity, terminal status, token cap, failure details, and that neither JavaScript
execution nor teacher traces supplied the answer. The bundled native adapter
fills those fields from the loaded bundle and real generation tape.

The runner independently decodes original token IDs using the hash-pinned
production tokenizer. Concatenated emissions must exactly equal original
output bytes. Duplicate JSON keys, invalid UTF-8, malformed graph data,
identity/seed/budget changes, incorrect decoder tokens and nonterminal or
invalid native generations remain failures. The complete raw response and
payload bytes are retained before scoring. Model process groups have time and
output-file bounds, and receive a minimal environment. No inference retries
occur. External model-command attestations are caller-provided protocol evidence;
only the supplied native adapter binds them to this repository's inspected
actual native runtime. Neither path grants dataset admission.

Pure-output reports use component-weighted whole-task correctness and paired
component uncertainty, retain every failed case in the denominator, and keep
selected-execution results separate. A small newly initialized diagnostic is an
exploratory measurement and cannot establish a confirmatory learning claim.

```sh
node --test test/training-pure-output-transfer.test.js
python -m unittest discover -s tools/native-consumer -p 'test_pure_output_transfer.py'
```
