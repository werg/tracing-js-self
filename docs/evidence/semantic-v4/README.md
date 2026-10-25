# Final semantic v4 engineering evidence

These receipts support the [completion ledger](../../SEMANTIC_HARNESS_V4_COMPLETION.md)
and [engineering gate](../../../contracts/semantic-engineering-completion.json).
The [integration lock](../../../contracts/semantic-integration-lock.json) fixes
the three tested implementation revisions and production tokenizer. Later
documentation and workflow changes do not relabel earlier execution receipts.

## Evidence map

| Evidence | What it establishes |
| --- | --- |
| [Verification summary](verification-summary.json) and [log identities](verification-log-identities.json) | Executed regression counts, scope, original log hashes and overlapping-test qualification. |
| [Source/native collection](native-collection.json) | 152 actual collection runs, all admitted, zero refusals, exact producer/consumer/tokenizer identities and paired recipe lineage. |
| [Mixed engineering manifest](engineering-manifest.json) and [compact engineering manifest](engineering-compact-manifest.json) | 27 and 25 source-certified engineering episodes, including prefix-causality checks. |
| [Explicit recipe manifest](recipe-explicit-manifest.json) and [compact recipe manifest](recipe-compact-manifest.json) | Two paired 50-episode views, all 16 authored families retained, with whole-family 40/7/3 train/validation/test allocation. |
| [Admitted counter](admitted-counter.json) and [admitted listener](admitted-persistent-listener.json) | Complete representative source, independent reference, public witness and native-consumer admission evidence. |
| [Native orchestration](native-orchestration.json) | Independent Python validation of six actual native-process cases: three complete scenarios and three expected refusals. Raw-case hashes identify the original execution receipts. |
| [Bounded continuity](state-continuity.json) | Both explicit and compact source episodes accepted with 1,024-record and 128-record histories. |
| [Fixed-weight inference](fixed-inference.json) | Actual initialized-model selection, original invalid token IDs and bytes retained, unchanged weights and zero native effects. |
| [Experiment preparation](experiment-preparation.json) and [dataset bindings](dataset-bindings.json) | 112 prepared source views, four actual native lifecycle roots, and all five train/validation stage-supply checks. |
| [Configuration matrix](training-matrix.json) and [shape validation](training-matrix-validation.json) | Five forms × three seeds × three budgets; real dataset/cohort validation and 45 refusals of an incomplete engineering receipt. |
| [Completed-gate preflight](completion-preflight.json) | The actual engineering preflight accepts the final completion receipt for all 45 configurations and returns every expected frozen cohort digest. |
| [Common-support cohort](common-support-cohort.json) and [effectful cohort](effectful-tracks-events-cohort.json) | Frozen test-only tasks, thresholds and certified representation-specific plans. Expected outcomes and controlled plans are not passed into actual model requests. |
| [Controlled evaluation matrix](controlled-matrix-summary.json) | 18/18 correct and trace-valid controlled runs across five forms, zero hard-gate violations or leaked resources. |
| [Core consumer checks](megatoken-core-tests.json), [integration repairs](megatoken-integration-tests.json) and [consumer readiness](megatoken-readiness.json) | Original and final test identities, separate overlapping results, preparation commands and launch-input qualifications. |

The five detailed evaluation reports are [pure explicit](common-support-explicit.json),
[pure compact](common-support-compact.json), [pure outcome-only](common-support-outcome-only.json),
[interactive explicit](effectful-tracks-events-explicit.json) and
[interactive compact](effectful-tracks-events-compact.json).

## Reading and reproducing the receipts

The manifests cover the complete generated corpus; the two admitted episodes are
representative complete records. The [source recipe guide](../../SEMANTIC_SOURCE_RECIPE.md)
and [implementation guide](../../SEMANTIC_HARNESS_V4_IMPLEMENTATION.md) describe
how to regenerate the full corpus and native orchestration evidence. Dedicated
cross-repository CI retains its full generated receipts as workflow artifacts.
The readable [native parent/child example](../../examples/selected-child-v4.txt)
and its [canonical JSON](../../examples/selected-child-v4.json) come from the final
native service execution.

Absolute paths in copied execution receipts identify the original workspace.
They are not portable launch bindings. Reproduce against the exact code revisions,
then pass the resulting local dataset, tokenizer and cohort paths to the planner.
Do not rewrite an old receipt to claim a new producer or consumer revision.

The configuration-shape run intentionally retained an incomplete engineering
receipt and unbound external assets. Its refusal evidence remains unchanged.
The later positive preflight substitutes only the completed engineering receipt
in memory; it does not create a model, admit donor/hindsight assets, connect a
training coordinator, or start an optimizer. Those deployment inputs still need
their normal admission before a future training launch.

Every score here is controlled engineering evidence. `optimizerSteps: 0` applies
to these semantic implementation checks; `learnedSuccess: null` records that no
learned execution claim was measured. General repository CI is a separate
regression suite and may exercise its pre-existing training unit tests.
