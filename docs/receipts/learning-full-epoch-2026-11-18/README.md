# Complete native epoch, negative execution result

The independently frozen 1,500-second retry **completed all 56 real native
optimizer updates and visited all 32 selected source IDs and every native
window of those episodes**. It supervised 17,574 lexical tokens across 14
independent source components. All 311 changed parameter tensors were finite,
real optimizer moments were retained, and the exact initial, checkpoint, and
served model reload checks passed. The native child finished in 827.66370855
seconds; its reserved checkpoint grace was not needed.

The learned execution requirement still failed. This is completed optimization
infrastructure and an observed negative execution result, **not a full
optimization smoke pass or evidence of generalization**.

| Measurement | Fixed initialized weights | Trained checkpoint 56 | Independent test components |
| --- | ---: | ---: | ---: |
| Complete held-in selected executions | 0 / 4 | 0 / 4 | Training probes |
| Complete validation selected executions | Not used for checkpoint ranking | 0 / 4 | 1 validation component |
| Complete held-out selected executions | 0 / 3 | 0 / 3 | 1 |
| Separate pure source/input outcome task | 0 / 1 | 0 / 1 | 1 |
| Held-in original decoder tokens | 188 | 99 | — |
| Held-out original decoder tokens | 89 | 35 | — |
| Pure endpoint original decoder tokens | 32 | 64 | — |

Every attempted case remains in its denominator. All selected rollouts failed
before completing a valid canonical trace; the trained held-in failures were
missing record separators or invalid JSON in the first model record. Both pure
arms emitted invalid original outcome JSON. Exact original model bytes, emitted
token IDs, requests, private independent expectations, result journals,
profiling records, standard error, and summaries are copied for all 20
measurements. Teacher selections were never injected into serving.

The single-component paired bootstrap interval is `[0, 0]`, accompanied by the
small-sample warning. It does not supply useful population-level uncertainty.
No generated-token or wall-time cost per correct task is defined because no
task succeeded. All complete selected integrity receipts reported zero false
admissions, future-observation leaks, replay-native effects, unauthorized
effects, and untracked fallback. These zero violations do not imply execution
success.

## Frozen identities and authentication

The experiment SHA-256 is
`550f7d516d4f177067cd2c3d0d7324cd4ad1c8545f34d5d47515c54ed2960530`.
It used producer `dac57b163f277085f1ee42f5d1fa0085eeecb556` and native consumer
`277edd4a2983e81f5e2a71b34a7ce29348e4e7a0`. Training ran with original runner
`75a6c7c0bdc3acd416f41dd7a0ff3a382df4ecdf`; the unchanged report retains that
identity. A fresh initialized model was required because the preceding
900-second run saved no trained state. Its failed attempt was not resumed or
rewritten.

The separately frozen pilot ran from immutable runner
`1cdf23cb0ab90a16748ec1370e8244145355684d`. Only checkpoint 56 was eligible;
validation was completed and its choice sealed before test evaluation. The
exact actual initialized base model SHA-256 is
`4ee47430d82fc7e6065bf8319165faca3d4c0d759039a873ac5f0cdc5e469d67`;
the trained model is
`eb8233dc60c56531acb2a6ba59e1a2aff50899ca65061d0d7243c7604f33a8bb`.

The later [authentication recheck](optimization/authenticated-checkpoint-recheck.json)
is explicitly a post-run verification. It recomputes source exposure from the
native cursors inside the checksummed state payload, compares metadata counters,
and binds those cursors to the native stream fingerprint rebuilt from verified
prepared shards and the actual training configuration. It also verifies the
latest pointer, metadata, state, and transducer payload checksums. The selected
pilot checkpoint independently applies those checks. Mutable metadata alone
cannot establish source coverage.

The [frozen experiment](frozen-experiment.json) declares 32 native tokens per
fragment, at most 64 fragments per decision, and 120 seconds per selected case.
The separate [pure cohort](pure/frozen-cohort.json) uses a genuine source/input
model command with a total output cap of 128 tokens. Routing identifiers and
private expected outcomes are excluded from its model context; two non-pure
cases are refused. The pure endpoint is evaluated separately and does not enter
the primary selected-trace score.

## Optimizer settings audit

The [saved-code, log, and tensor audit](optimization/optimizer-settings-assessment.json)
rules out a cold warmup as the explanation: native P1 has zero warmup fraction,
and all 56 updates logged the full `0.0002` learning rate. The vocabulary
projection is nonzero at initialization and trains at the full rate; its
157,184-row embedding is initialized with standard deviation `rank**-0.5` and
trains at half rate. Both have nonzero retained Adam moments and changed weights.
The run uses FP32, AdamW, lexical weight 1, actual scored-position mean loss,
and independent gradient-domain clipping at norm 1. The smallest logged
encoder, model, and shared gradient norms are all positive.

The final window's lexical loss is near the uniform-vocabulary reference of
11.965 nats. First and last training losses are measured on different windows,
so their difference is not a paired learning score. No supported `TrainConfig`
setting increases P1's peak learning rate; shortening its token budget would
advance decay. A new convergence diagnostic must be frozen separately and
cannot change this trial or tune its held-out score.

## Receipt layout and limits

[summary.json](summary.json) connects optimizer checks, actual source exposure,
validation choice, primary test, pure endpoint, exact costs, and limitations.
[optimization/report.json](optimization/report.json), [pilot/report.json](pilot/report.json),
and [pure/comparison.json](pure/comparison.json) are unmodified originals.
[index.json](index.json) binds every original copy and the larger private
artifacts by SHA-256. The native update extract is explicitly derived; its
first and last native metric lines are copied byte-for-byte. Full checkpoints,
prepared shards, original logs, and all failed attempts are retained in the
separate private follow-up archive, outside public Git.

This one-seed tiny model trial leaves the empirical held-in completion gate
unmet. It cannot establish pretrained-model performance, multi-seed
reproducibility, or broad held-out generalization. Valid-error, cleanup,
alternate-observation, alternate-schedule, and matched known-source/new-input
slices are absent in this frozen synthetic cohort. The separately frozen real
source cohort retains its own provenance and prospective status.

The completed follow-up archive is `learning-native-followup-2026-11-18.tar.gz`
(334,503,326 bytes), SHA-256
`321982e54da81cbd7d1de2d72b48053cddc7e4cf7db832088f74e832f04170ca`.
[The archive verification](private-archive-verification.json) checked every one
of its 252 original files (1,248,061,773 uncompressed bytes) against the
[embedded index](private-archive-index.json). It includes both failed
full-coverage attempts, all final checkpoints, prepared shards and original
logs, the complete pilot and pure endpoint, the post-run authentication and
optimizer audit, and the frozen declarations. Its explicit dependency is the
previously retained original-run archive for the unchanged admitted source
corpus; the prospective real-source corpus has its separate qualification and
archive. No historical receipt is rebound to the final merged code.
