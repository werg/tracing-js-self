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
Every candidate undergoes fresh source, journal, replay, and native-consumer
checks before preparation. The report pins both repositories, the tokenizer,
the actual runner files, input files, and the resulting prepared corpus.

Training is capped by `--steps` and `--train-timeout` (900 seconds by default).
The runner reserves up to 30 seconds **inside** that cap for the native engine's
SIGTERM handler to finish its current atomic update and save a paused checkpoint.
If graceful checkpointing cannot finish by the cap, the process group is killed.
Interrupted logged updates and the last durable checkpoint are reported
separately. A paused run that did not reach its declared step count does not pass.
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
The current companion corpus preparer requires a physical capacity of at least
768 because its default soft chunk limit is 768; this runner uses the supported
1024-token capacity and 1024-event history without modifying that consumer.
