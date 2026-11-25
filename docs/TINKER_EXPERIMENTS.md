# Preparing and running a credible execution-learning experiment

This guide covers the complete follow-up work around the Tinker training loop.
The [scope checklist](TINKER_FOLLOWUP_PLAN.md) maps every requested area; the
[validation record](TINKER_VALIDATION.md) distinguishes executed local checks from
live model evidence. Run the commands from `/home/werg/tracing-js-self`.

## Local preparation

Use the repository's pinned Node from `.nvmrc` for reference-contract checks. The
experiment environment is CPU-only; Tinker performs the model computation.

```sh
UV_PROJECT_ENVIRONMENT="$PWD/.venv-tinker" uv sync --project training --locked
source .venv-tinker/bin/activate
npm run test:tinker
python training/run.py --config training/configs/inkling-mini.json check
```

`inkling-mini.json` is the small integration configuration. Its output directory
is `runs/tinker-followup-smoke`, preserving earlier frozen experiments. The
larger prepared experiment is configured in `training/configs/inkling-pilot.json`.
The pilot's learning rates, reward settings and update counts are starting
choices, not measured optima.

The pilot gives each local bridge request a 300-second outer deadline. One
qualified recursive Collatz case took 86 seconds to export in isolation, largely
in runtime snapshot cloning/diffing. The starter keeps its shorter 60-second
limit. Task-level timers are cooperative and cannot interrupt synchronous
snapshot work; the separate bridge process provides the outer wall-time limit.
This setting controls local JavaScript preparation, not model-generation cost.

The expanded, qualified datasets are committed under `training/fixtures/expanded`.
Regenerate them deliberately when changing the corpus:

```sh
node tools/tinker-benchmark.mjs build \
  --seed 17 --jobs 4 --output-dir training/fixtures/expanded
node tools/tinker-benchmark.mjs census \
  --seed 17 --output-dir runs/tinker-census
node tools/tinker-benchmark.mjs fuzz \
  --seed 17 --count 10000 --jobs 4 --output-dir runs/tinker-fuzz
node tools/tinker-supervision.mjs \
  --dataset training/fixtures/expanded/main.jsonl \
  --sample-per-feature 2 --include-messages \
  --output runs/tinker-supervision/audit.json
```

These commands never contact a model service. The fuzz command preserves each
case, observed failures and minimized reproductions. `--resume` requires the
same count, seed and implementation identity. Use a new output directory after
changing the tested implementation. The CI job runs a smaller deterministic
sample on changes; its manual workflow supports the full 10,000-case gate.

### What the datasets mean

| File | Purpose | May train or select checkpoints? |
| --- | --- | --- |
| `main.jsonl` | Explicit training, validation and unseen-family test splits | Training rows fit; validation rows select; test rows only report |
| `familiar-inputs.jsonl` | Withheld inputs for programs used during training | No; separate diagnostic evaluation only |
| `challenge.jsonl` | Longer executions and composed behavior from held-out parent families | No; separate diagnostic evaluation only |
| `evaluation-manifest.json` | Exact case IDs for each main split | Defines the frozen evaluation population |
| `familiar-input-exclusions.jsonl` | Exact training-input duplicates excluded from the novel-input diagnostic | No; retained exclusion evidence |
| `admission.jsonl` | Every considered candidate and its admission/refusal | Evidence of coverage, not model accuracy |
| `manifest.json` | Source/lineage counts, hashes, split policy and qualification scope | Provenance |

Identifier renaming, literal changes and structural variants remain connected
to their generator/template ancestors. The corpus generator also groups a
conservative alpha/literal clone fingerprint before splitting. The Python
exporter independently unions families, sources, templates and declared lineage.
Reports distinguish execution cases, distinct source programs, family names and
independent connected components. Repeated input variants do not create new
independent evaluation units.

Every admitted program is checked against the owned runtime and native reference.
The independent boundary verifier separately checks its declared bounded grammar
without importing the production fixture broker or graph codec. It verifies
observations, final graphs and ordered effects, and rejects deliberately wrong
returns, exceptions, mutations, aliases, call arguments, missing/extra/reordered
effects, scalar distinctions and incomplete executions. Arbitrary narration
changes and omitted internal steps remain positive controls.

The census keeps every candidate in its denominator. Its default inventory is
the enumerated pinned and existing repository program collections; it does not
claim to measure an unseen deployment workload. An additional inventory can be
provided with `census --input tasks-or-trajectories.jsonl`. A trajectory must carry
a complete `executorTask` or `task` to establish executor admission. Original
agent-task success remains unverified unless separately supplied and evaluated.

## Freeze a staged study

```sh
python training/experiment.py plan \
  --config training/configs/inkling-pilot.json \
  --output-dir runs/tinker-study \
  --diagnostic-dataset familiar_inputs=training/fixtures/expanded/familiar-inputs.jsonl \
  --diagnostic-dataset challenge=training/fixtures/expanded/challenge.jsonl
```

Planning executes and freezes source inputs and realized observations, including
diagnostic datasets. It writes `plan.json`, `frozen-input.jsonl`, exact split
selections and a report explicitly stating that model results are not available.
Planning needs local dependencies but no Tinker authentication. A diagnostic
with the wrong split or incomplete scope flags fails during preparation.

The plan binds the implementation, source inputs, split manifest, evaluation
seed and acceptance settings. Training seeds vary independently. Effort and
trace changes reuse the same source programs and controlled environments.
An explicit evaluation manifest keeps its exact IDs and ordering. A configured
cap is sampled once with the runner's seeded tier/family policy and frozen into
the plan; it does not remove training examples or silently truncate an explicit
manifest. The pilot uses every validation and test case.

The default staged matrix is:

1. **Baseline:** effort `0.0`, `0.2`, `0.7`, `0.9`, each with standard and concise
   public instructions. Only validation is sampled.
2. **Learnability gate:** a small training-only set containing an external
   interaction, actual token/logprob scoring, supervised updates and repeated
   complete-execution checks. The initial target is 95% training-set accuracy;
   this is a diagnostic, not generalization evidence.
3. **SFT learning rate:** a small logarithmic sweep at the selected effort.
4. **Trace format:** full, compact and actions-only supervision at the selected
   SFT learning rate.
5. **RL learning rate:** correctness-only updates from the same selected SFT
   optimizer checkpoint.
6. **Objective:** reuse the selected SFT control, then compare correctness-only
   RL and compression RL from that identical SFT starting point.
7. **Repeat:** rerun the selected configuration with seeds 17, 29 and 47 while
   keeping source splits and evaluation seeds fixed. Every seed is reported;
   the first predeclared seed supplies the representative diagnostic checkpoint.
8. **Final:** seal all choices, then evaluate the base/SFT/RL controls and repeated
   seeds on the untouched test population. Familiar-input and challenge scores
   are separately labeled and cannot affect selection.

This staged matrix avoids a full Cartesian product. The plan CLI exposes
`--efforts`, `--rates`, `--rl-rates` and `--seeds`. LoRA rank, weighting, PPO and
reference regularization are explicit configuration choices for targeted
follow-up comparisons.

## Live prerequisites and commands

```sh
tinker auth login
python training/run.py --config training/configs/inkling-mini.json check --live
python training/experiment.py probe \
  --config training/configs/inkling-mini.json \
  --output-dir runs/tinker-contract-probe --live
```

Without `--live`, `probe` and `learnability` only prepare the diagnostic and
render its supervision. The live probe samples actual executions, scores the
original prompt/completion IDs, measures target log probabilities before and
after an update, and saves the resulting checkpoint. Alignment is checked;
sampler/learner floating-point scores are not required to be bitwise equal.

Run the study in stages or use the complete sequence:

```sh
python training/experiment.py run --plan runs/tinker-study/plan.json --stage baseline
python training/experiment.py learnability --plan runs/tinker-study/plan.json --live
python training/experiment.py run --plan runs/tinker-study/plan.json --stage learning-rate
python training/experiment.py run --plan runs/tinker-study/plan.json --stage trace
python training/experiment.py run --plan runs/tinker-study/plan.json --stage rl-learning-rate
python training/experiment.py run --plan runs/tinker-study/plan.json --stage objective
python training/experiment.py run --plan runs/tinker-study/plan.json --stage repeat
python training/experiment.py run --plan runs/tinker-study/plan.json --stage final

# Equivalent staged execution, including the learnability gate when needed:
python training/experiment.py run --plan runs/tinker-study/plan.json --stage all
python training/experiment.py report --plan runs/tinker-study/plan.json
```

The plan-bound diagnostic uses the selected baseline's effort and prompt plus
the plan's exact frozen dataset. Its default budget is 25 updates, evaluated
every five updates; `--updates`, `--evaluate-every`, `--examples` (8–16), and
`--target-accuracy` configure it. A failed learnability gate stops the larger
experiment. Investigate the stored execution failures, masks and loss diagnostics
before spending more samples on harder programs.

The configured model is used exactly. There is no automatic paid-model fallback.
Absent authentication is reported as a live prerequisite, never replaced with
scripted or oracle model results. `--resume` resumes compatible interrupted jobs;
it does not override provenance checks or unresolved optimizer outcomes.

### Recover interrupted optimizer work

Every optimizer call first persists its exact inputs, policy identity and
preceding state in `updates/<attempt>.input.json`, then writes a pending marker
and an append-only, fsynced `update-ledger.jsonl` event. A successful optimizer
return is followed by optimizer and sampler saves. The complete next state,
including RNG state, is checksummed and saved in a recovery receipt before
replacing `state.json` and removing the marker.

On `--resume`, a valid receipt repairs local state without repeating model work.
An unknown optimizer outcome, or a confirmed update without a durable recovery
receipt, stops automatic recovery. Preserve the marker, update inputs, ledger,
state and rollouts. The error identifies the last safe checkpoint; resolve the
original service operation or start a separately recorded recovery lineage
without copying rollouts from the uncertain policy.

Every actual update takes a recovery snapshot, even when `checkpoint_every` is
greater than one. That setting controls publication in the checkpoint audit;
`validation_every` independently controls evaluation cadence. This adds checkpoint
operations per update. RL samples and reused groups bind to the exact persisted
sampler, so recovery cannot reuse samples against reconstructed or different
weights.

Reports distinguish dispatch attempts, confirmed optimizer returns, unknown
outcomes, checkpointed/committed updates, and active or selected model lineage.
A dispatch record alone does not establish server acceptance or billing.
Rollback preserves cumulative attempt accounting, including discarded updates.

Diagnostic preparation also preserves any previous live sampling or update
evidence. Neither an offline command nor a repeated live command can erase an
outstanding update marker. Use a fresh diagnostic directory, or a new study for
plan-bound diagnostics, after inspecting a completed or failed live diagnostic.

## Reward, curriculum and update controls

Failures receive zero success reward. Successful raw rewards use
`1 - length_penalty * min(tokens / length_scale_tokens, 1)`; the length scale is
independent of the hard generation budget. The optimization advantages separate
binary correctness from length centered only among successful executions.
`length_penalty` is applied after normalization, so reducing it really reduces
compression pressure even when every sample succeeds.

`advantage_mode: decoupled` standardizes correctness only. `centered` keeps
correctness on its raw scale. Neither applies a final standardization that would
cancel the compression coefficient. `rl_objective: correctness` disables the
length term. Warmup, ramp and validation accuracy gates control when it becomes
active. Inferior RL validation results restore the selected optimizer checkpoint;
selected steps and cumulative attempted updates are distinct records.

The pilot curriculum teaches increasing tiers with earlier-tier rehearsal. RL
advances only after enough groups and demonstrated successes. Logs show stalled
tiers, all-failure/mixed/all-success groups, zero-advantage groups and useful
groups per thousand generated tokens. Constant task advantages skip an update
when reference regularization is disabled; KL-only updates are explicitly counted
when that optional regularizer is enabled.

SFT and RL learning rates are separate. `sft_weighting: example` normalizes each
rendered datum's weights to one; `token` preserves raw assistant-token weights.
Both exclude program inputs and real observations. Exact forward outputs provide
loss diagnostics by call request/completion, short/long execution, tier and
feature, without additional model compute. Unknown attribution remains labeled.

For PPO, set `rl_loss_fn: ppo` and optionally
`rl_loss_fn_config: {"clip_low_threshold": 0.9, "clip_high_threshold": 1.1}`.
The default remains fresh-sampling importance sampling. Optional
`reference_kl_coef` anchors tokenwise sampled-log-ratio regularization to the
recorded SFT sampler; `reference_kl_clip` bounds that shaping term. The fixed SFT
reference is separate from sampler-to-learner drift, and both are logged.
Checkpoint restore checks cached model/rank identity before accepting a learner.

## Read the evidence

Each job retains configuration, frozen dataset and selection, original sampled
tokens/log probabilities, validation candidates, selected checkpoint, update
metrics and errors. Study summaries are recomputed from matching real backend
records, including cached and reused results. A partial population, changed
checkpoint, altered task, foreign plan, or fixture backend fails validation.
The report identifies the actual model as base or trained. A repeated run that
retains the base model on validation remains explicitly labeled as base.

Read complete execution accuracy alongside all generated tokens, failed-attempt
tokens, tokens per verified success, median/P95 lengths and the failure taxonomy.
Prompt/observation tokens are not generated output; sampled thinking, narration,
action syntax and termination tokens are. Exact TML decomposition is reported
where recoverable; unknown boundaries remain unclassified rather than estimated
by re-tokenizing text.

Paired comparisons require identical tasks and evaluation seeds. Confidence
intervals resample entire connected source-family components. Small populations
or degenerate accuracy distributions remain inconclusive for a noninferiority
claim. The default acceptance settings allow at most two percentage points of
accuracy loss and require at least 10% saving in tokens per verified success,
with at least 30 independent components for the inference gate. These are
predeclared experimental choices, not established performance guarantees.

Changing settings after opening the final test requires a new study with a fresh
held-out population. The seal is an experimental workflow/provenance control;
it does not prevent the repository owner from reading local files.

Teacher trace size reductions, CPU verification, successful packaging and unit
tests are preparation evidence. A useful model result requires actual Tinker
samples and trained checkpoints meeting the stated accuracy/cost criteria on
unseen programs.
