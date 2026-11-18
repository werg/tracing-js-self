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
  --checkpoint-steps 16,64 \
  --train-examples 32 --validation-cases 16 --test-cases 32
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

The file fixes optimizer seeds, a separate initialization seed, a separate decoder
seed, checkpoint steps, a practical improvement threshold, a maximum critical
slice regression, a bootstrap RNG seed and the confirmatory component minimum.
It is written exclusively and must not be rewritten after seeing model results.
The optimization report binds its exact SHA-256 before constructing the model.

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
  --rollout-cases 4 --rollout-tokens 128 --train-timeout 900
```

The requested example count must equal the frozen training selection, and the
step cap must equal the last frozen checkpoint step. The runner verifies every
training file hash and immutable candidate identity before native preparation.
It retains all declared checkpoint candidates using the companion's supported
checkpoint interval and retention settings, capped at 100 periodic snapshots.
Without an experiment, the standalone smoke retains its existing every-step
checkpoint policy and the companion's bounded default retention.

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
  --rollout-tokens 128 --rollout-timeout 120
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
failed case and remains in the denominator. The process group is terminated;
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

Pure code/input-to-outcome transfer remains a distinct, untested endpoint in
this runner. New inputs for known training sources and counterfactual observation
schedules need explicitly frozen auxiliary cohorts. They must not be inferred
from the unseen-source selected-execution score. Pretrained-contamination absence
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
