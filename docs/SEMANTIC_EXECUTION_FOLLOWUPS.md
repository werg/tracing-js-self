# Semantic execution follow-up implementation and evidence

This follow-up adds a wider source-certified benchmark, preparation and analysis for all five experiment formats, real launch-input qualification, serving measurements and cleanup, long-session fault checks, trace inspection, and a selected-execution pilot in the existing Natlang workflow application. The changes are implemented across the three repositories. The evidence below establishes engineering behavior; trained-model quality, training memory fit, and production recovery under load remain unmeasured.

## Tested implementation revisions

| Repository | Implementation revision | Pull request |
| --- | --- | --- |
| tracing-js-self | `8a1ef48a0399f9440208d293e5625d42b1051294` | [#33](https://github.com/werg/tracing-js-self/pull/33) |
| megatoken | `50ed039f8dbd4f8016d0e081fa5f9495e89f17df` | [#28](https://github.com/werg/megatoken/pull/28) |
| natlang | `f02ed2ed651f35f6fc91037644ea752a3374ad20` | [#2](https://github.com/werg/natlang/pull/2) |

These are final implementation pins. Source collection and preparation used tracer `1952ee3ae3bb24b8d2c9d975ca3ed7e86e18ab38` with Megatoken `50ed039f8dbd4f8016d0e081fa5f9495e89f17df`. The later tracer change corrects only evaluation fixture construction and result comparison; it does not change training-corpus generation, source verification, admission or preparation. Final evaluation fixtures and reports use tracer `8a1ef48a0399f9440208d293e5625d42b1051294`. Natlang's dependency remains its tested tracer `1952ee3` revision.

A subsequent documentation/evidence commit may carry this ledger while retaining these implementation pins. The existing v4 integration lock and completion receipt remain unchanged. The follow-up has its own [integration lock](evidence/semantic-followups/integration-lock.json) and [engineering receipt](evidence/semantic-followups/engineering-completion.json). The receipt's `repositories` identifies immutable artifact producer/consumer lineage; `implementationRepositories` and `evaluationRevisions` identify the final code used for the later checks. The launch qualifier records actual runtime checkouts separately from artifact lineage. No old artifact is relabeled.

The execution, trace, context, continuation and prepared-data contracts remain v4. The separate benchmark, analysis, serving-profile and launch-qualification reports have their own versioned schemas. The outcome-only array fix converts the already-verified source graph's tuple properties into the named-property objects required by the existing v4 output contract; it does not loosen that contract.

## Wider benchmark and complete preparation

The `benchmark-v1` catalogue contains **42 algorithm families** covering bounded arithmetic, state and array programs. Each family supplies one pure case, one callback/recovery case and one repeated-invocation session. Two additional source-certified lifecycle children provide training and validation supply. Each projection therefore contains **126 primary cases plus two lifecycle children**.

The seed-17 family hash fixes **32 training, seven validation and three test families** before expansion. All authored families remain in the catalogue. Normalized-AST checks report zero duplicates within the new catalogue and zero duplicates against the previous recipe. Shared ancestry stays on one side of the split.

Both explicit and compact native collections admitted **128/128** outputs at the collection revisions above. Source execution, independent reference agreement, replay and native physical admission remain separate checks. All 256 [native admission receipts](evidence/semantic-followups/benchmark-native-receipts.json) retain their producing revisions and original source-artifact hashes. The original `training-v4` recipe remains available and unchanged.

The final [controlled evaluation matrix](evidence/semantic-followups/controlled-matrix-summary.json) has the following results:

| Format | Prepared primary episodes | Held-out cases correct | Valid traces | Report |
| --- | ---: | ---: | ---: | --- |
| Pure, explicit | 42 | 3 / 3 | 3 / 3 | [Explicit](evidence/semantic-followups/common-explicit.report.json) |
| Pure, compact | 42 | 3 / 3 | 3 / 3 | [Compact](evidence/semantic-followups/common-compact.report.json) |
| Pure, outcome only | 42 | 3 / 3 | 3 / 3 | [Outcome only](evidence/semantic-followups/common-outcome-only.report.json) |
| Effectful, explicit | 84 | 6 / 6 | 6 / 6 | [Explicit](evidence/semantic-followups/effectful-explicit.report.json) |
| Effectful, compact | 84 | 6 / 6 | 6 / 6 | [Compact](evidence/semantic-followups/effectful-compact.report.json) |

These are **21 task-format attempts across nine distinct tasks from three held-out algorithm families**, all at seed 17. They use controlled reference selections. There are zero recorded future-observation leaks, unauthorized effects, untracked native fallbacks, false admissions or replayed effects. They establish consistency of the instrumented execution and evaluation pipeline, not learned quality or population-level generalization.

The [preparation receipt](evidence/semantic-followups/experiment-preparation.json) includes four actual native lifecycle admissions: training and validation for both explicit and compact formats. Each pure training format has 32 training and seven validation episodes; each effectful format has 65 training and 15 validation episodes after including lifecycle supply. The held-out test families are excluded from those training and validation counts. Five analysis reports retain family-level outcomes, source-length bands and measured cost coverage. The current catalogue sidecars declare family ancestry and roles; undeclared behavior categories remain explicitly unknown in the analyses.

The widened corpus exposed an actual conversion failure: 26 array cases passed source/native admission but were refused when preparing outcome-only examples because the source graph and output graph use different property encodings. [The original refusals](evidence/semantic-followups/outcome-array-refusals-before-fix.json) are retained. The conversion fix preserves roots, object identities and properties, validates the resulting graph with the unchanged strict validator, and leaves original source evidence in the audit. A real collected array example and the full preparation/evaluation regressions pass after the fix.

The end-to-end evaluation exposed the same conversion omission at its own boundary: two array-bearing held-out cases were refused in the [initial outcome-only evaluation](evidence/semantic-followups/outcome-array-evaluation-before-fix.json). Evaluation now normalizes both frozen expectations and actual observable state consistently, including coordinated child tasks, while retaining original native progress bytes. A separate regression verifies that an unobservable completed value still produces an evaluation report with its episode and effect receipts. Final cohorts were regenerated after this correction; the earlier failed cohort and report remain distinct historical artifacts.

The new analysis command validates cohort and case identity, reports family-level outcomes, source-length bands, declared behavior groups and cost distributions with their measurement scopes. Failed runner attempts remain in success denominators. Missing per-case gates and costs are reported as unmeasured, including coverage counts; they are never converted to zero cost or discarded attempts. Controlled and initialized-weight runs cannot claim learned success.

## Long sessions, faults and readable traces

The [session campaign](evidence/semantic-followups/session-campaign.json) executes and certifies a source-derived session with **32 distinct invocations, 64 asynchronous results and 705 public records**. It checks reversed result completion, duplicate invocation delivery, duplicate result delivery, checkpoint restoration with uncertain work, refusal to redispatch that work, cancellation and a matching late result. The cancelled invocation stays closed, and the uncertain result is reconciled without replaying the effect.

The complete public episode is retained as [session-episode.json](evidence/semantic-followups/session-episode.json), alongside a generated [standalone HTML inspector](evidence/semantic-followups/session-viewer.html). Its read-only inspector replay is valid. The inspector can render invocation and track ownership, source events, request/result/await links, selected state changes and the first structural difference against an expected trace. Partial or malformed traces remain visible. The self-contained HTML escapes trace content and requires no external assets.

Campaign timings identify the first replay after source certification and the subsequent warm replay samples separately. These are local controlled replay measurements; they are not model-generation latency. The report also records actual process resident memory and resource inventories.

## Real model serving and buffer cleanup

The [serving profile](evidence/semantic-followups/serving-profile.json) and [original attempts](evidence/semantic-followups/serving-attempts.json) come from five bounded CPU calls to the existing frozen bundle, with seed 17 and two OpenMP/MKL threads. The bundle identity and tokenizer are attested by the actual server. All five attempts are retained: the controller rejected the first four text outputs, and the fifth attempt was refused during rendering because it did not produce one complete valid text action. They are engineering evidence of the model path and rejection handling, not successful learned execution.

After cancellation, the measured runtime has **zero active invocations, zero pending rendering, zero retained selected-generation groups and zero reserved output bytes**, and its final profile records `runtimeClosed: true`. Causal history and completed action receipts remain available. The fix retains physical generations while asynchronous native commitment may still need them, including after a later prefix acknowledgment, and releases them on completion, rejection or cancellation.

The optional serving report measures model/runtime load time, per-operation first and warm latency, process resident memory and actual CUDA peaks when available. Successful RPC responses are distinguished from semantic task success. Origin is a caller declaration; checkpoint identity is recorded separately. The original attempts retain the actual model-selection receipts and decoder evidence; these rejected profile rows do not claim successful selection authority. CPU runs report GPU memory as null. Serving memory does not establish training memory fit.

## Natlang workflow pilot and browser verification

The pilot compiles the existing order-policy source and calls the production `WorkflowService.apply` through the selected environment. Its seven [controlled journeys](evidence/semantic-followups/natlang-controlled.json) cover ordinary success, definite rejection, lost acknowledgment, an unresolved request after restart, cancellation, refund before release and repeated events after settlement. Both restart journeys construct a fresh service instance. The run records 22 controlled projections and 15 local simulated effects.

Controlled selected records are explicitly return-value projections. The pilot enforces the exact application source before compilation, compares owned execution with independent compiled-source execution where supported, and records the precise unsupported-operation reason when the controlled fixture uses compiled-source execution. These projections are not full source traces or admitted training labels. The model route does not use them and stops subsequent model journeys after the first refusal, including a refusal during reconciliation.

The [fixed-checkpoint pilot](evidence/semantic-followups/natlang-fixed.json) preserved the actual first-module refusal: the source did not fit that small checkpoint's declared history. It applied zero effects, marked later journeys as not run, and shut down gracefully. Its [profile](evidence/semantic-followups/natlang-serving-profile.json) and [run identities](evidence/semantic-followups/natlang-verification.json) retain their actual producing revisions: the pilot used Megatoken `9470de7fee27481856ec6dc59fce0932e45534d1`, while the separate five-call serving probe above used `50ed039f8dbd4f8016d0e081fa5f9495e89f17df`. The intervening change touched only offline outcome preparation and its regression test; serving components were unchanged.

Actual Chromium passes the interpreter/adaptation, board/DOM and playground checks. Browser adaptation fixtures are generated for the browser compiler. The browser build now includes the SQLite workers needed by its same-origin storage path. Stale adaptation identities continue to be refused.

Portable historical tests explicitly skip when the exact preserved external files are absent. The separate [strict historical gate](evidence/semantic-followups/strict-history.log) fails before running those tests when any required file is missing or its path/hash/length identity differs. Four required historical inputs are absent in this workspace; no replacement bytes were generated and that gate is not reported as passed.

## Launch qualification and remaining production inputs

The new read-only preflight verifies clean code pins, frozen cohorts and referenced engineering-evidence hashes, the exact production tokenizer, every prepared semantic record, model geometry, donor tensor content/layout, each hindsight window and target tensor, and an exact committed checkpoint. Checkpoints are shape-checked against the real architecture on the meta device, actual tensors are scanned for nonfinite values in bounded chunks, and FP32 masters must cover the complete source optimizer-owner set. New donor owners are derived separately for a new-stage coordinator bootstrap.

A new coordinator initialization writes a separate provenance receipt after success. Qualification compares the checkpoint state and metadata hashes, destination parameter layout, coordinator manifest and the hash of the live downloaded bootstrap artifact. A same-run worker resume uses its full optimizer/cursor/RNG/coordinator state and follows a separate check. The checker sends no lease, worker registration, gradient or update.

The [generated training matrix](evidence/semantic-followups/training-matrix/matrix.json) contains **45 validated configurations**: five formats, three seeds (17, 29 and 43), and three budget comparisons (the same number of examples, the same number of tokens, or a measured compute budget). The planner checked the real tokenizer, both frozen cohorts and all five prepared stage supplies before materializing these configurations. It performed zero optimizer steps and created no learner output directory.

At matrix-generation time the new engineering receipt was explicitly incomplete and was used only for its immutable data-producing revisions. That original status is retained in the [benchmark run record](evidence/semantic-followups/benchmark-verification.json). After the actual engineering checks completed, a separate complete receipt was finalized with hashes of its evidence, and the [read-only launch qualification](evidence/semantic-followups/launch-qualification.json) was run against one of the new effectful configurations. The older check against archived inputs remains separately recorded as [launch-qualification-archived-inputs.json](evidence/semantic-followups/launch-qualification-archived-inputs.json).

The actual launch report remains blocked by unavailable production inputs: immutable donor assets, hindsight targets, the required previous-stage checkpoint, a live coordinator binding and its initialization receipt, and CUDA. The configured learner output directory was not created. Training memory fit, recovery under load, learned capability and deployment acceptance remain unmeasured.

That check did pass configuration validation, all three clean runtime revisions, all 126 referenced engineering-evidence hashes, model geometry, the exact tokenizer, and the complete effectful stage supply of 65 training and 15 validation episodes. It performed zero optimizer steps, started no learner, and made zero coordinator mutations. The optional read-only coordinator probe was not requested while its address and assets remained unbound.

## Validation and reproduction

[Validation results and unaltered logs](evidence/semantic-followups/validation.json) distinguish the complete local development suite from final focused regressions. The local Megatoken CPU run passed 2,837 tests with 28 GPU/optional-integration skips; the final graph-conversion/data-analysis/recipe set passed 28 tests using the exact production tokenizer. Tracer's final implementation suite passed 817 cases with six native-runtime environment skips, plus its reference fixture; separate diagnostics and actual browser checks also passed. Natlang's final selected-runtime checks passed [37 cases across six files](evidence/semantic-followups/natlang-selected-runtime-tests.json), its five workflow tests passed, and its required quick check passed 12 Python ratchets and TypeScript checking.

The [GitHub CI record](evidence/semantic-followups/github-ci.json) separately records the published revisions. Megatoken's complete CPU suite at `50ed039` passed **2,828 tests with 43 skips on each of Python 3.11 and 3.12**. Those skips cover GPU-only checks, optional media/ICU/donor dependencies, and exact-tokenizer checks assigned to the dedicated workflow; the separate i18n, pinned selected bridge and source/native admission workflows passed. CI job URLs and the sanitized CPU logs preserve the detailed scope. All six tracer workflows passed at its final implementation revision. Natlang's selected-evaluator integration passed; its broader training-tools job was still running when this evidence was published and is not marked passed. A fixed [CI snapshot at qualification](evidence/semantic-followups/github-ci-at-qualification.json) is hashed by the engineering receipt; later CI updates are recorded separately without changing that snapshot.

Use the stated collection revisions to reproduce source data and preparation, and the final evaluator revision to reproduce frozen evaluation fixtures and reports. The production tokenizer SHA is `40fb9d7d7795b8bd305aeff39ce9963f3f450915b9553f2938e009be9a1fed60`; its identity and origin are in the integration lock. Use a fresh output directory for each recorded run. Dataset and launch paths in the captured reports identify the execution workspace; regenerate bindings for another machine.

From the tracer checkout, collect both representations with `tools/generate-effectful-training.mjs --recipe benchmark-v1 --representation explicit` and then `compact`, supplying `--require-native`, the adjacent Megatoken checkout, its Python executable and the production tokenizer. From Megatoken, use `scripts/prepare_semantic_experiments.py --recipe benchmark-v1` with both corpus directories and the exact producer/consumer revisions. This creates all five forms, actual native lifecycle supply, stage-supply checks and dataset bindings without starting an optimizer.

Pair the two collected representations with [build_paired_benchmark_corpus.py](evidence/semantic-followups/build_paired_benchmark_corpus.py), then freeze the paired held-out declarations with `tools/freeze-selected-evaluation.mjs --benchmark-v1 --metadata-output FILE`, using `--common-support` for the pure cohort. The pairing helper was run against the actual collected outputs and reproduced the original merged manifest and its frozen digest exactly. The [benchmark run record](evidence/semantic-followups/benchmark-verification.json) retains the full working directories, argument arrays, pins and outputs for collection, preparation, pairing, freezing, evaluation, analysis and matrix generation. Evaluate the three common-support forms and two effectful forms with `scripts/evaluate_semantic.py`, then run `scripts/analyze_semantic_evaluation.py` with each frozen cohort/report pair. Use the new follow-up engineering receipt when materializing the 45-config matrix; the archived receipt keeps its original data pins.

For the session campaign and inspector:

```sh
node tools/semantic-session-campaign.mjs --out /work/session-campaign --invocations 32 --iterations 7
node tools/inspect-selected-harness.mjs docs/evidence/semantic-followups/session-episode.json --report /work/session-viewer
```

For the application pilot, follow [Natlang's pilot instructions](https://github.com/werg/natlang/blob/f02ed2ed651f35f6fc91037644ea752a3374ad20/applications/workflow/PILOT.md). For real assets, checkpoint/resume semantics and optional serving-profile flags, follow [Megatoken's operational guide](https://github.com/werg/megatoken/blob/50ed039f8dbd4f8016d0e081fa5f9495e89f17df/docs/SEMANTIC_FOLLOWUP_OPERATIONS.md).
