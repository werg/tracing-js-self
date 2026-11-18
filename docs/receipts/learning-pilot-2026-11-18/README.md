# Actual native optimization and exploratory transfer receipts

**This run did not demonstrate learned execution or generalization.** The real
native optimizer changed finite model parameters and the serving identities
reloaded exactly. Every measured selected execution failed. Both measured pure
source/input transfer outputs failed the independent JSON outcome check.

## Observations

| Measurement | Actual result |
| --- | --- |
| Prepared training membership | 32 admitted episodes, 14 independent source components |
| Original optimizer run | 64 real native P1 diagnostic steps; 307 parameters changed |
| Actual training exposure | **5 of 32 prepared source IDs**, 64 scored windows, 1,743 supervised lexical tokens |
| Selected checkpoint | Step 16, chosen using validation only; 2 source IDs and 416 supervised lexical tokens at that checkpoint |
| Held-in selected execution | Base 0/4; final step-64 trained model 0/4 |
| Validation | Four episodes from one component at each of steps 16 and 64; all failed |
| Held-out selected execution | Base 0/3; selected step-16 model 0/3; one independent component |
| Selected held-out decoder cost | Base 89 tokens; trained 70 tokens, including invalid original emissions |
| Separate pure source/input transfer | Base 0/1; selected step-16 model 0/1; one independent component |
| Pure output decoder cost | Base 32 tokens; trained 126 tokens, including invalid original emissions |
| Integrity gates | All recorded leakage, unauthorized-effect, fallback, false-admission, and replay-effect counts zero |

The first experiment selected 32 corpus members but used the pinned native
sampler's sequential episode windows with `max_window_records: 1`. It finished
all scored windows of an episode before advancing. Thus the completed 64-step
run **did not train on all 32 prepared examples**. The source-window counts and
the selected checkpoint's narrower exposure are preserved in [summary.json](summary.json).
A later full-episode packing experiment is a separate declaration and cannot
retroactively change these observations.

Both validation criteria were zero at both declared checkpoints, so the frozen
earlier-step tie rule selected step 16. Test data did not participate in that
choice. [The sealed selection](learning-pilot-main/sealed-selections.json)
and [the held-out comparison](learning-pilot-main/comparison.json) preserve the
actual model identities and all denominators. The family-weighted improvement
was zero. The reported paired bootstrap interval `[0, 0]` has only one source
component and an explicit small-sample warning; it is not evidence of tight
population uncertainty. One optimizer seed and unmeasured critical error and
cleanup slices also prevent a confirmatory conclusion.

The [pure comparison](pure-output-source-only-comparison-main.json) is a
separate endpoint. The model observed only source, entry, input graph, guest RNG
seed, completion policy, and public outcome contract. Routing identifiers and
private expected graphs were excluded from the native model context. One pure
case qualified; two session/effectful cases were refused. The endpoint retained
the native decoder's original bytes and token IDs. Its independent scorer
requires matching return/throw behavior and a rooted graph bijection preserving
aliases, cycles, input mutations, sparse arrays, property order, and prototypes.
Both actual generated payloads were invalid outcome JSON. Deterministic adapter
unit tests are infrastructure checks, separate from these measurements.

## Exact provenance and budgets

The producer was `dac57b163f277085f1ee42f5d1fa0085eeecb556`; the native consumer
was `277edd4a2983e81f5e2a71b34a7ce29348e4e7a0`. The real production tokenizer
SHA-256 was `40fb9d7d7795b8bd305aeff39ce9963f3f450915b9553f2938e009be9a1fed60`.
The base was newly initialized, with initialization, optimizer, and decoder
seeds 17. It was not a pretrained checkpoint. The initialized base's served
model SHA-256 was `4ee47430d82fc7e6065bf8319165faca3d4c0d759039a873ac5f0cdc5e469d67`.

The experiment was frozen before optimization with SHA-256
`d3fd66ec5ff889649d9e0f58bf107e0d6d76dc2625f462c6642b7f72e75b1ee5`.
The original field `rolloutBudget.tokensPerDecision` was poorly named: the
pinned native `--max-tokens 32` setting is **32 tokens per fragment**, with up
to 64 fragments per logical decision. The case wall limit was 120 seconds and
the training limit was 900 seconds. Actual measured token totals were always
computed from original native emission receipts. The original declaration is
unchanged; later tooling records the field's actual legacy interpretation and
uses explicit per-fragment names in new declarations. The separate pure adapter
enforced a true total-output budget of 128 tokens per case.

## What is retained here

[index.json](index.json) lists SHA-256 hashes and byte lengths. The copied
originals are byte-for-byte unchanged: all 22 selected execution results,
requests, private expected outcomes, stderr files, serving profiles, both pure
model protocol responses and generated payloads, the actual training config,
optimizer verification, selection receipt, and comparisons. No failed case has
been dropped from the denominator. Absolute paths inside original receipts
identify the original run; they are not claimed to be portable.

[training-metrics.json](training-metrics.json) is an explicitly labeled extract
of all 64 real optimizer-step metrics. It retains measured loss, gradient
domains, denominators, and counters. [summary.json](summary.json) is a derived
compact summary, not an edited original report. Large native checkpoint and
served weight files, prepared corpus, full logs, full frozen declarations, and
unabridged reports are retained in the separate private run archive. The index
pins the source receipts used for the extracts. None of the preserved negative
results establishes a production launch or a learning-success milestone.
