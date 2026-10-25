# Follow-up engineering evidence

Start with [the implementation ledger](../../SEMANTIC_EXECUTION_FOLLOWUPS.md). It explains the exact producing revisions, checks, failures found and corrected, and remaining empirical work.

## Main records

| Record | What it establishes |
| --- | --- |
| [integration-lock.json](integration-lock.json) | Final code revisions, separate immutable artifact lineage, unchanged contracts and the exact tokenizer. |
| [engineering-completion.json](engineering-completion.json) | Twelve engineering gates with named evidence and 126 file hashes; production launch assets and learned quality remain unqualified. |
| [benchmark-verification.json](benchmark-verification.json) | Actual collection/preparation/evaluation commands, five final reports and analyses, failure history, and matrix-generation status. |
| [benchmark-native-receipts.json](benchmark-native-receipts.json) | All 256 source/native admission receipts, reference and replay fields, original source-artifact hashes and sizes. |
| [experiment-preparation.json](experiment-preparation.json) | Five prepared formats, four native lifecycle admissions and exact training/validation supply. |
| [controlled-matrix-summary.json](controlled-matrix-summary.json) | Twenty-one controlled task-format attempts, all successful, across nine tasks in three held-out families. |
| [training-matrix/matrix.json](training-matrix/matrix.json) | The 45 generated configurations; no training was started. |
| [launch-qualification.json](launch-qualification.json) | Actual read-only launch check: engineering/data checks passed; unavailable production inputs and CUDA remain blocked. |
| [session-campaign.json](session-campaign.json) | The measured 32-invocation fault campaign; its complete public episode is in [session-episode.json](session-episode.json). |
| [session-viewer.html](session-viewer.html) | A standalone, offline inspector generated from that episode. Download and open locally. |
| [serving-profile.json](serving-profile.json) | Five bounded actual-model attempts and the measured terminal resource state; the original attempts are in [serving-attempts.json](serving-attempts.json). |
| [natlang-controlled.json](natlang-controlled.json) | Seven actual workflow pilot journeys using explicitly controlled return-value projections. |
| [natlang-fixed.json](natlang-fixed.json) | The real checkpoint's source-history-capacity refusal, zero effects and cleanup. |
| [validation.json](validation.json) | Scoped local validation counts and original log hashes. |
| [github-ci.json](github-ci.json) | CI status at the recorded time, with exact heads and job URLs. The qualification-time snapshot is separate and immutable. |

## Reproduction and interpretation

The reports preserve the paths and producing revisions used during execution. Those absolute paths describe the original workspace. On another machine, regenerate source data, prepared datasets and path bindings using the recorded commands; do not simply run the captured configuration paths unchanged. The matrix intentionally contains unresolved production asset and coordinator bindings.

Source collection and preparation used tracer `1952ee3ae3bb24b8d2c9d975ca3ed7e86e18ab38` and Megatoken `50ed039f8dbd4f8016d0e081fa5f9495e89f17df`. Final frozen expectations and evaluations used tracer `8a1ef48a0399f9440208d293e5625d42b1051294`, which corrects only evaluation graph conversion and preserves unobservable-value reports. The source collection/admission path is unchanged. Original model-serving and Natlang runs retain their own producing revisions in their reports.

The large source archives, prepared episode files and per-record audit databases are reproducible from the pinned source recipe. This directory retains the complete compact reports, manifests, lifecycle admissions, immutable identities and extracted verification fields; it does not duplicate those large generated datasets. The extraction report explicitly names its scope. The paired-corpus reproduction helper was executed against the original collected outputs and its manifest exactly matched the one used to freeze the cohorts.

The original array preparation refusal, original outcome-only evaluation failure and its original cohort are retained separately. They are evidence of failures found and repaired, not final passing results. The strict historical gate still fails because four exact external files are absent. Portable-test skips do not qualify that historical gate.

Controlled evaluations establish engineering consistency. Actual initialized-weight serving attempts were refused and establish the model/rejection/cleanup path. Neither result establishes trained-model quality. Every non-test engineering run records zero optimizer steps; no production learner or cloud job was started.
