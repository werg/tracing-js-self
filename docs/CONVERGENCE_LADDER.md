# Bounded native convergence diagnostics

The convergence tools freeze a new diagnostic before optimization and reuse
`run-optimization-smoke.py`, its exact checkpoint verification/export, and the
existing selected-execution scorer. They do not introduce another trainer.
No new native model convergence has been measured locally by this implementation.
The retained old 256-update attempt remains a failed attempt under its original
identities and cannot be retroactively relabeled as a new experiment.

## What each result can establish

| Gate | Required evidence | Claim boundary |
| --- | --- | --- |
| Controlled transport (L0) | Explicit controlled origin; routing, observed masks, generated masks, semantic validation and termination checks | Infrastructure only; `learnedSuccess` remains null |
| One-case native diagnostic | One fixed short natively admitted training episode; exact trained checkpoint reload; ten predeclared fresh model processes; every complete execution succeeds using original emissions | Repeatable held-in success under the declared native policy |
| Small-set native diagnostic | 16–32 short natively admitted cases; at least four declared semantic feature strata; at least 100 first-record trials distributed equally across cases | At least 95% distinct cases complete on **every** scheduled repeat, at least 99% accepted first records, zero false admissions |

The current native model samples Gaussian policy facets before its structural
and lexical argmax renderer. Accordingly these declarations and reports identify
`native-greedy-renderer-with-fixed-policy-seed`, and their
`roadmapGreedyPolicyGatePassed` is explicitly false. A passing result here cannot
be described as the roadmap's entirely greedy-policy L1 result. It would show
complete selected execution under a fixed seeded native policy. A genuinely
greedy latent policy needs its own supported native implementation, declaration
and comparison. No mode is inferred from repeated identical outputs.

One hundred repeated first-record trials are not one hundred independent sources.
The report always includes the distinct case count, keeps repeats together in
whole-case success, and makes no statistical independence or generalization
claim. L3–L5 transfer evidence remains the responsibility of the existing frozen
validation/test pilot.

## Freeze before training

Start with a newly qualified native corpus and use the existing
`freeze-learning-experiment.mjs` to freeze source-component membership,
initialization/optimizer/decoder seeds, checkpoint schedule, native identities,
and training/inference budgets. Select the shortest currently admitted episode
for the one-case diagnostic; do not reuse stale admission evidence after source
or native contract changes. For an isolated diagnostic corpus, retain its
independent validation and test members so the existing experiment contract
remains intact; the convergence runner does not evaluate those members.

For example, after choosing a current one-episode training membership and a
**separately declared** 512-update cap, one can freeze the engineering gate:

```sh
python tools/run-convergence-ladder.py freeze \
  --experiment /path/to/new-private-experiment.json \
  --stage L1 --optimizer-seed 17 --maximum-generated-tokens 512 \
  --out /path/to/new-private-convergence.json
```

The command requires explicit training and inference budgets in the original
experiment. It freezes exactly ten process restarts and selects only the final
declared checkpoint. A 256-update alternative must have its own experiment and
declaration. Nothing extends a budget in response to observed loss or a failed
selection. Outputs are exclusive-create.

For the small-set gate, declare at least four semantic strata that are actually
present in the frozen training rows:

```sh
python tools/run-convergence-ladder.py freeze \
  --experiment /path/to/new-small-set-experiment.json \
  --stage L2 --optimizer-seed 17 --maximum-generated-tokens 2048 \
  --feature pure-selected --feature effects --feature aliasing --feature mutation \
  --out /path/to/new-small-set-convergence.json
```

The other supported semantic feature strata are `valid-errors`, `retained-state`
and `cleanup`. Length labels alone cannot satisfy semantic feature coverage.
With 16 cases, the default schedule has seven repeats per case (112 trials).
With 32 cases, it has four repeats (128 trials). These are declared engineering
thresholds, not significance tests.

## Train through the existing verified path

Pass the declaration to the normal optimizer command before any update. All
ordinary flags still have to match the original experiment. For a declared
512-update, one-episode, one-hour diagnostic with the explicit windows below:

```sh
python tools/run-optimization-smoke.py \
  --corpus /path/to/current-admitted-corpus \
  --tracer-root /path/to/clean/tracing-js-self \
  --consumer-root /path/to/clean/pinned/megatoken \
  --tokenizer-json /path/to/qualified/tokenizer.json \
  --experiment /path/to/new-private-experiment.json \
  --convergence-declaration /path/to/new-private-convergence.json \
  --examples 1 --steps 512 --seed 17 --initialization-seed 17 \
  --rollout-cases 1 --rollout-tokens 128 --rollout-timeout 120 \
  --training-window-records 64 --training-window-decisions 64 \
  --train-timeout 3600 --output /path/to/new-optimization-run
```

The declaration's SHA-256 is recorded before preparation/training. A later
request cannot attach new gates to an already completed historical run. The
optimizer retains its original target audit, masks, actual exposure, losses,
checkpoints, training wall cost, initial-state equality and tensor reload checks.
Its preliminary held-in evaluation is not part of the ten-restart denominator.
The frozen decoder seed is used even when it differs from the optimizer seed.
The known input mismatch and unmeasured conditional-logit parity described in
[the learning diagnosis](LEARNING_DIAGNOSTICS.md) remain distinct prerequisites
for interpreting any new result. Do not treat this runner as a repair of them.

## Evaluate the exact saved checkpoint

```sh
python tools/run-convergence-ladder.py run \
  --declaration /path/to/new-private-convergence.json \
  --experiment /path/to/new-private-experiment.json \
  --smoke-report /path/to/new-optimization-run/report.json \
  --consumer-root /path/to/clean/pinned/megatoken \
  --output /path/to/new-convergence-run
```

The runner reopens the exact trained checkpoint, verifies tensor identity and
optimizer exposure, and reexports/reloads the served bundle without changing
weights. Every scheduled attempt invokes the existing evaluator in a fresh
process, which launches its own native serving process. The launcher records
its actual PID, parent PID, start times, unique invocation ID, script digest and
command digest, then uses `exec` to replace itself with the official native
server in the **same process**. The serving profile separately attests actual
model/tokenizer initialization and runtime closure. A launcher receipt alone
is not a model-load or inference pass.

Original request, private expected outcome, evaluator result, native serving
profile and model-process receipt are retained and checksum-bound for every
attempt. No teacher expectation is sent to the model process. Native original
fragments must reconstruct the exact emitted record; only a matching first
record committed by the semantic checker counts as a valid first record.
Native parsing alone cannot satisfy that metric. Missing semantic inspection
remains null in the per-layer diagnosis, while an absent valid record fails the
first-record trial.

Missing, duplicate or reused processes, wrong identities/seeds, missing original
emissions or missing hard-gate counters invalidate the evidence set. Timeouts
and failed runs stay in the planned denominator. Any false admission or other
hard-gate violation fails the whole gate. All outputs are retained after each
attempt, with a fixed aggregate evaluation wall cap. Errors preserve the failed
run directory and explicitly distinguish unmeasured from partial measurements.
No final test set is used and no checkpoint is selected using these results.

Without a native run, `inspect` emits an honest unmeasured receipt:

```sh
python tools/run-convergence-ladder.py inspect \
  --declaration /path/to/new-private-convergence.json \
  --experiment /path/to/new-private-experiment.json \
  --out /path/to/new-unmeasured-gates.json
```

## Verification

```sh
python test/test_convergence_ladder.py
python tools/native-consumer/test_optimization_measurement.py
```

The gate tests use explicitly synthetic model measurements. They cover the ten
restart requirement, distinct-case and first-record denominators, threshold
weakening, feature coverage, process reuse, checkpoint mismatch, controlled
origin, missing/altered original bytes, false admissions and missing evidence.
The launcher regression executes two ordinary Python processes and verifies
that the recorded PID survives `exec`; it performs no neural execution. Neither
test suite establishes a trained model pass.
