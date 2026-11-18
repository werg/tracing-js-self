# Actual CPU optimization and selected execution diagnostic

`tools/run-optimization-smoke.py` runs the paired Megatoken model, its real
optimizer and checkpoint format, and the production selected execution driver.
It uses the companion's explicit `purpose: diagnostic` configuration and a newly
initialized tiny model with the pinned production tokenizer. It does not claim
that the starting model is pretrained or that a completed pipeline has learned
to execute JavaScript.

## Run

The Python environment must contain the dependencies of the pinned companion
checkout, including its supported PyTorch version, `safetensors`, and tokenizer
and native data dependencies. Use a clean companion checkout and a clean,
immutable tracing checkout at the corpus's exact producer commit. The corpus
must contain compatibility JSON exports with actual positive native admission.

```sh
PYTHONPATH=/path/to/megatoken/src /path/to/python tools/run-optimization-smoke.py \
  --corpus /path/to/admitted-corpus \
  --tracer-root /path/to/immutable-tracing-checkout \
  --consumer-root /path/to/megatoken \
  --tokenizer-json /path/to/tokenizer.json \
  --output /path/to/new-smoke-output \
  --examples 32 --steps 16 --rollout-cases 4 --rollout-tokens 128
```

The output directory must be new. Candidate selection cycles through source
families, uses only the training split, and never relabels held-out examples.
Within each family it selects the smallest measured generated-token example
first, breaking ties by public bytes and identity. This is a deliberately bounded
feasibility sample, not an estimate of the full training distribution.
Repeat `--corpus` to combine materialized authored, generated, and real-source
campaigns at the same producer revision. Identical public episodes are selected
only once; a repeated candidate identity with different bytes is rejected.
Every candidate undergoes fresh source, journal, replay, and native-consumer
checks before preparation. The report pins both repositories, the tokenizer,
the actual runner files, input files, and the resulting prepared corpus.
During streaming input reads, byte-identical decoded frozen-registry subtrees
share memory; all original fields and serialized evidence are preserved and
checked for mutation. The model runtime loads after preparation. This avoids
holding its memory alongside repeated large private registries. The report
records registry counts and the preparation process's measured peak RSS.

Training is capped by `--steps` and `--train-timeout` (900 seconds by default).
The runner reserves up to 30 seconds **inside** that cap for the native engine's
SIGTERM handler to finish its current atomic update and save a paused checkpoint.
If graceful checkpointing cannot finish by the cap, the process group is killed.
Interrupted logged updates and the last durable checkpoint are reported
separately. A paused run that did not reach its declared step count does not pass.

`--training-window-records` (alias `--max-window-records`) controls the supported
native atomic-window record cap (default 1). `--training-window-decisions`
(alias `--scored-decisions`) controls its decision cap (default 2). Both accept
explicit bounds up to 1,024; the resolved native plan and actual resource budget
remain authoritative. The native sampler finishes all causal windows of one
permuted episode before advancing to the next. With a one-record cap, a short
run can repeatedly train a few sources. A larger record cap groups records
and complete atomic meridians, preserving the same records, targets, and causal
boundaries. It does not interleave episodes or rewrite the training format.
For the recorded 32-example release-C corpus, one epoch takes 320 updates at
record cap 1 and decision cap 2; 170 at caps 16 and 2; 95 at caps 16 and 4; and
49 at caps 16 and 32. An early manual profile used the packing helper's default
decision cap 4 instead of the resolved diagnostic cap 2; it incorrectly forecast
95 updates for the cap-16 run. That run and correction remain separate evidence.
The runner now profiles the **fully resolved** native configuration before
launch. `native-window-plan.json` retains the complete episode inventory, and
`native-schedule-plan.json` retains expected window indices, record IDs, source
membership, scored targets, and final cursor. After training it requires exact native cursor,
source-count, and scored-target agreement. Native per-window order is derived
from its deterministic cursor contract; the engine does not independently log
each window ID. `--require-full-epoch` refuses before launch unless every prepared
target will be consumed once. These counts are specific to that exact prepared
corpus. Do not assume 32 updates visit 32
examples. `sourceExposure` maps actual checkpoint window counts to prepared
source identities and families and refuses unknown or incomplete histories.
Rollouts are independently capped by `--rollout-timeout` (120 seconds by
default) and `--rollout-tokens` **per native fragment**. The pinned selected
adapter may emit up to 64 fragments for one logical decision; this flag is not
a whole-decision or whole-task token cap. All emitted tokens, including invalid
fragments, enter measured cost. The underlying selected transport also retains
its 30-second per-RPC limit. The standalone native diagnostic checkpoints every optimizer
step. A frozen learning experiment instead retains its declared checkpoint
schedule and binds exact training membership before optimization; see
[the learning pilot](LEARNING_PILOT.md). Each completed phase and each rollout updates `report.json` atomically;
partial runs retain checkpoints, logs, and the last completed phase.

## What is measured

1. **Mask application.** `loss-masks.json` records every prepared physical
   record's token and scored-token counts. Observed host/input records must
   score zero tokens. Every generated computation/action record must score all
   of its generated tokens. This uses the actual companion `encode_record`
   function, including its production tokenizer and mask construction.
2. **An exact starting checkpoint.** The runner creates real initialized model,
   optimizer, and transducer state with zero updates. The official trainer
   loads that checkpoint through its supported phase-transition API. This
   binds the base weights directly; it does not infer their identity from a
   seed alone. The trainer also saves its phase-start checkpoint.
   `--base-checkpoint` instead copies and loads the exact existing zero-update
   base, allowing later diagnostic configurations to share identical checkpoint
   bytes. A stepped checkpoint is refused for this option. With `--experiment`,
   the declaration must additionally bind those exact state bytes in
   `baseCheckpointSha256` before training.
3. **Real optimization.** The configured native training engine performs the
   requested updates. Committed weights must be finite, parameter ownership
   must match initialization, changed parameters must have optimizer moments,
   and encoder, shared, and model gradient domains must have measured nonzero
   gradients. Training logs retain losses, denominators, token costs, and
   source-window exposure. A training-corpus member is not necessarily visited
   during a very short cap; the report retains the actual exposure receipt.
   Before updates, `native-window-plan.json` records the pinned native packing,
   first-epoch order, scored tokens, and windows for every prepared source.
   `trainingExposure` distinguishes selected membership, actual visited sources,
   and completion of every selected episode's windows.
4. **Checkpoint and served identity.** The committed checkpoint is reloaded and
   every model tensor is compared. Both base and trained checkpoints are
   exported with the official served exporter. Reloaded served tensors must
   exactly match the checkpoint's served tensors, and optimization must change
   the served model identity.
   Source exposure is recomputed from the checksummed checkpoint's native rank
   cursors and compared with metadata and the prepared stream fingerprint.
   Partial-run receipts validate the committed metadata pointer plus state and
   transducer file checksums; they separately disclose whether native payload
   loading has been verified.
5. **Actual free-running rollouts.** Base and trained models generate their own
   decisions through `run-selected-evaluation.mjs` and
   `serve_selected_semantic.py`. Private expectations are scored outside that
   evaluator process. Teacher selections are removed before the evaluator
   receives its envelope. No controlled lifecycle or selection mode is used.

Each rollout retains its request, private expected result, raw evaluator
result, stderr, and native serving profile. Invalid generated bytes and token
IDs stay in the original failure evidence. Cleanup state, first failure, rejected selections, hard
gates, wall time, and native decoder costs remain visible. Rejected selections
count as model failures even if a later completion happens to match. Original
native event IDs deduplicate decoder-token receipts, including tokens emitted
before an invalid record. Incomplete profiles report a lower bound explicitly.

Each rollout also saves an atomic `summary.json`. A timeout terminates the
evaluator and its model process group, records the failed case, and continues
to measure the other requested cases. Malformed output and missing or invalid
identity/profile receipts remain explicit pipeline failures; their original
bytes stay in the case directory. Serving profiles
correctly report zero optimizer steps for their serving-only scope; the
training report independently records actual optimizer steps.

## Interpreting the report

`status: completed` means the measurement pipeline finished. The separate
`optimizationSmokePassed` flag requires all checks, at least 32 admitted
training examples, actual complete exposure of every selected episode, and successful complete selected executions for every
requested trained rollout. A failure to render a valid first record is a
measured learning failure, even when optimization and checkpoint checks pass.
Neither flag establishes generalization: these are held-in corpus examples.

The initial sandbox feasibility run used two admitted counter examples and two
real optimizer steps. It demonstrated finite parameter updates, correct loss
masks, and exact checkpoint/served reloads. Both base and trained model
rollouts failed on their first generated record. This is not evidence of
learned execution. Run receipts, rather than this feasibility description,
are authoritative for subsequent experiments.

The native sampler permutes episodes deterministically, then visits every
scored window of one episode before moving to the next. One-record windows can
therefore spend a short run on only a few selected sources. A separately frozen
full-episode diagnostic can use `--training-window-records 256
--training-window-decisions 256` and at least one step per episode, provided the
native plan confirms each episode fits in one window. These are supported
native packing settings; no alternate optimizer or sampler is substituted.
They increase per-step work and must fit the declared time and memory budget.
The original 32-candidate/64-step sandbox run visited only **five** prepared
source IDs and scored 1,743 lexical tokens. Its corpus membership is not evidence
that all 32 episodes were trained. Original declarations and receipts remain
unchanged when a follow-up experiment changes packing or budgets.

The diagnostic uses the companion's P1 recurrent training engine over verified
v5 records. Production SE/SC launch gates, frozen experiment receipts,
donor/hindsight assets, and coordinator requirements remain intact. A larger
production experiment still needs those assets and its own explicit budget.
The diagnostic report is not itself a held-out evaluation report or a native
semantic experiment budget receipt. The production comparator
`compare-learning-runs.py` requires configured SE/SC experiment receipts and a
separately frozen evaluation cohort. The distinct `run-learning-pilot.py`
workflow supports an explicitly scoped P1 exploratory comparison when its exact
experiment was frozen before optimization. These evidence classes remain separate.
The current companion corpus preparer requires a physical capacity of at least
768 because its default soft chunk limit is 768; this runner uses the supported
1024-token capacity and 1024-event history without modifying that consumer.
The CPU trainer currently records zero for its GPU allocator peak-memory
counter. That counter does not measure CPU training memory. The native serving
profiles separately retain observed process memory; neither quantity is a
claim that a larger training configuration fits in memory.
