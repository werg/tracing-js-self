> **Immutable historical engineering evidence.** This document and its hash-pinned
> evidence describe the specific frozen M0–M8 experiment revisions, including
> comparisons that are **no longer executable as current training modes**.
> The sole active trace is [source-grounded semantic-trace/4](SEMANTIC_REASONING_TRACE.md).
> Historical artifacts here are retained only to substantiate the published
> engineering receipt; do not import them as today's training data.

# Semantic execution v4: engineering completion ledger

The M0–M8 implementation in the [current execution scope](STATUS.md)
is complete across tracing-js-self, Megatoken and Natlang. This ledger records
engineering evidence for the declared execution and capability profile. No semantic
training, fine-tuning or optimizer-driven capability experiment was run. M9 learned
quality, trained checkpoints and deployment acceptance remain unmeasured.

## Compatible implementation revisions

| Repository | Tested code revision | Integration |
| --- | --- | --- |
| tracing-js-self | [`b238fb48e6dc2b3a97e8c1280d4b961c0593466c`](https://github.com/werg/tracing-js-self/commit/b238fb48e6dc2b3a97e8c1280d4b961c0593466c) | [PR #32](https://github.com/werg/tracing-js-self/pull/32) |
| Megatoken | [`95115e7cb08b8681cae9769b1a134bf4ee9ca70e`](https://github.com/werg/megatoken/commit/95115e7cb08b8681cae9769b1a134bf4ee9ca70e) | [PR #27](https://github.com/werg/megatoken/pull/27) |
| Natlang | [`ffdcf5a0d3d871bf600626627fa44dbf324039e3`](https://github.com/werg/natlang/commit/ffdcf5a0d3d871bf600626627fa44dbf324039e3) | [PR #1](https://github.com/werg/natlang/pull/1) |

The [machine-readable lock](../contracts/semantic-integration-lock.json) records
the exact Git trees, protocol identities and tokenizer. Later documentation and
workflow-only commits are separate from these implementation pins. Collection
receipts keep the revisions that actually produced and consumed them; they are
never relabeled to a newer branch head. Natlang's package and lockfile install the
listed tracer revision directly.

The active contracts are `semantic-execution/4`, `semantic-trace/4`,
`semantic-context/4`, `semantic-continuation/4` and `selected-harness/2`.
The shared schema digest is
`83036b29b7c117e6d947b1b5e5b8b30acb773efeeb538f33c8862966bb086206`;
the shared fixture digest is
`bef4c96b9713a7f9cfc21a2afb287fc3f8920bc53a4a951f20f5e86d1a673072`.
The operation catalog digest is
`a8a05569d1ace3600afd77070274fd1295e1d1c0cb1c4f78f0b5a04a3e04244d`.
The complete contract file has its own, distinct SHA-256 in the lock.

Production tokenization uses `inclusionAI/Ling-3.0-tiny` revision
`9a98e35fe1c9ee255f78dd64771c7ae15a799481`, tokenizer SHA-256
`40fb9d7d7795b8bd305aeff39ce9963f3f450915b9553f2938e009be9a1fed60`,
and codec identity
`7f52faca2fe82273a889023defd2f1a6fd6080a21096ec77e97f4798a0a370b2`.

## Milestones and production paths

| Milestone | Delivered behavior | Executable evidence |
| --- | --- | --- |
| M0: profile and examples | Operation inventory, authority boundaries, chronological and per-owner reading views; source once, two invocations; real coordinator and child transcript. | [Counter example](examples/selected-counter-v4.txt), [native child example](examples/selected-child-v4.txt), [implementation guide](SEMANTIC_HARNESS_V4_IMPLEMENTATION.md). |
| M1: paired protocol | Versioned source, invocation, effects, events and dynamic owners; independent JavaScript/Python validators; old artifacts reject; future observations remain inaccessible. | Shared [contract](../contracts/semantic-harness-v4.json); tracer harness/continuity tests and Megatoken contract/bridge tests. |
| M2: complete tool interaction | Source-certified teacher and independent reference; selected request validation; one committed request derives one native action; observed result resumes the same invocation. | [Admitted counter](evidence/semantic-v4/admitted-counter.json), source/reference/replay admission, actual process-selector and selected-driver regressions. |
| M3: execution tracks | Native coordinator allocates and bootstraps children, joins typed completion dependencies, receives return/throw, publishes progress and closes. Capacity, cancellation, revision and lifetime ownership are enforced. | [Native orchestration receipt](evidence/semantic-v4/native-orchestration.json); native lifecycle and coordinator tests include more than eight lifetime tracks. |
| M4: events and async ownership | Persistent listeners, outside triggers, live captures, Promise adoption/reactions/finally, microtasks, reversed settlements and shared-realm turn ownership. | [Admitted persistent listener](evidence/semantic-v4/admitted-persistent-listener.json); subscription, callback, continuation and Promise regressions. |
| M5: continuity and recovery | Durable intent before dispatch, uncertain-outcome reconciliation, source eviction/reread, checkpoint restoration, explicit lost-resource reattachment and replay-verified current-state context. | Intent-journal, checkpoint and native recurrence tests; actual 128-record history-eviction case in the orchestration receipt. |
| M6: Natlang integration | Actual generated async entry/modules, sibling and cyclic imports, retained caches/live captures, typed file/folder/service resources, ordered events and shared failure identity. | Natlang's [integration guide at its tested revision](https://github.com/werg/natlang/blob/ffdcf5a0d3d871bf600626627fa44dbf324039e3/ts-host/SELECTED_SEMANTIC_INTEGRATION.md); 208 runtime checks and 12 supporting checks. |
| M7: capabilities and data | Real HTTP, filesystem, streams/sockets, Chromium DOM/passive events/timers and Natlang resources; independent source admission, exact native tokenizer, whole-family splits and prepared data. | [152-run collection receipt](evidence/semantic-v4/native-collection.json), real Node/browser tests and [prepared experiment receipt](evidence/semantic-v4/experiment-preparation.json). |
| M8: completion and consolidation | Active v4 production path, historical diagnostics separated, native inference, scoped checkpoint/budget accounting, all comparison forms, migration, CI and operational documentation. | [Engineering gate](../contracts/semantic-engineering-completion.json), [evaluation matrix](evidence/semantic-v4/controlled-matrix-summary.json), [configuration validation](evidence/semantic-v4/training-matrix-validation.json). |

## Executed verification

| Gate | Result and scope |
| --- | --- |
| Tracer regression suite | **811 passed, zero skips**, including the actual native process integration; deterministic reference fixture also passed. |
| Real Chromium | **1 passed** against Chromium 151, checking actual DOM changes, alias identity, passive event order, CSP and teardown. |
| Final native coordinator | **14 passed, zero skips**, including six actual native scenarios; independent Python validation accepted **6/6** receipts. Three complete scenarios and three expected refusals remain distinct. |
| Megatoken core | **146 passed, two CUDA-only skips**, plus one forward-only continuation regression. |
| Megatoken final integration repairs | **37 passed, one CUDA-only skip**; exact cohort-file persistence, checkpoint round trips, stage/example inventory and preparation fixtures. This overlaps the core suite and is not an additional disjoint total. Ruff passed across 443 files. |
| Natlang | **208 passed, zero skips**, after clean installation of the pinned tracer; **12 Python supporting checks**, source-review manifest, TypeScript checks, Node build, browser export types and layering also passed. |
| Source/native admission | **152/152 admitted, zero refusals** at the exact producer and consumer pins. Every admission includes independent reference agreement, replay, native parsing, fragmentation, visibility and loss validation. |
| Controlled held-out evaluation | **18/18 correct and trace-valid** across five forms; every hard-gate count and leaked-resource count is zero. |

The native coordinator's positive service scenarios each complete three roots
(return `8`, mutate a capture through two callbacks and return `7`, and throw
`"missing"` after cleanup). Every one of their eight external calls crosses the
original native commitment boundary. The history case resumes a parent with
capture value `3` after the original mutation has left the model's 128-record
visible history. A checked public state receipt supplies only committed state.
Cancellation, an invalid selected child and invalid initialized-model output
retain their original bytes and close their owned resources.

The [fixed-weight inference receipt](evidence/semantic-v4/fixed-inference.json)
attests seed 17, tokenizer and actual model identity
`c7d9040ec72553cf84d1030bd8481b0f03dcfaeb989b2e347239aee135aa0943`.
Its output is invalid and is recorded as such. The original token IDs and bytes
are preserved, no external effect occurs, and the weights remain unchanged.
This tests inference plumbing and failure handling without claiming learned
execution. The dedicated engineering workflows do not instantiate an optimizer;
the repositories' pre-existing general CI suites remain separate regression gates.

### Cross-repository CI and an external test-data dependency

The dedicated [tracer source/native workflow](https://github.com/werg/tracing-js-self/actions/runs/40198586070),
[Megatoken source/native workflow](https://github.com/werg/megatoken/actions/runs/40198750235),
[Megatoken selected bridge](https://github.com/werg/megatoken/actions/runs/40198750526)
and [Natlang selected integration](https://github.com/werg/natlang/actions/runs/40198061803)
all passed. All seven tracer workflows also passed at the workflow revision
`a212edb0889d073799cb5525dc3320e4c7b0f886`.

Natlang's [general Test run](https://github.com/werg/natlang/actions/runs/40198061798)
passed its runtime, application and conformance step, then failed during Python
test collection. Its missing `zstandard` and Triton dependency setup is corrected
in the [workflow-only follow-up](https://github.com/werg/natlang/commit/745f9a9c674818f8806e9fde16e0a693de92ae27).
The pre-existing `test_teacher_helper_continuation.py` additionally requires exact
historical observation, authority and source-closure files under external machine
data roots. Those files are absent from the hosted environment and are not tracked
or retrievable through a repository-supplied path. The test remains required and
needs those exact bound assets to pass. The workflow now runs browser checks when
their runtime and installation prerequisites pass, even if the separate Python
step fails. The follow-up passed the 12 quick Python checks and TypeScript check.
General CI status remains visible in each linked pull request; these external
training-recovery assets are an explicit environment dependency.

## Admitted data, comparisons and launch configuration

| Collection | Admitted episodes | Generated tokens | Observed tokens | Native actions |
| --- | ---: | ---: | ---: | ---: |
| Engineering, mixed representation | 27 | 18,693 | 56,964 | 70 |
| Engineering, compact | 25 | 17,799 | 54,668 | 68 |
| Paired recipe, explicit | 50 | 33,345 | 138,678 | 132 |
| Paired recipe, compact | 50 | 30,215 | 138,663 | 132 |

These are collection runs, including paired views of the same source tasks;
152 is not a count of unrelated task families. Both recipe views retain all
16 authored families, each with 40 train, 7 validation and 3 test episodes.
Their template digest and ordered lineage tuples match. Descendants, callbacks,
retries, repeated invocations and lifecycle wrappers inherit the source split.
The paired compact recipe uses about 9.4% fewer generated tokens on these teacher
fixtures. That measures representation cost, not learned task quality.

Preparation exports three pure-task forms (explicit, compact and outcome-only,
16 source episodes each), two interactive forms (32 source episodes each), and
four real native lifecycle roots. Required train/validation supply passes:
13/2 episodes per pure form and 27/5 per interactive form including lifecycle
teaching. Missing supply, wrong representation, changed provenance or context
geometry fails before optimizer setup.

The frozen common-support cohort contains two test tasks. The separate effectful
cohort contains six test tasks: graph feedback, callbacks and repeated ingress,
each with its ordinary and native-coordinator form. Both explicit and compact
certified plans are retained. Expected outcomes remain outside model prefixes;
controlled plans are removed from actual model requests. The 18 successful runs
are explicitly controlled engineering evaluations, with `learnedSuccess: null`.

The completed planner validates **45 configuration variants**: five comparison
forms, seeds 17/29/43, and fixed-example, fixed-generated-token and measured-compute
budgets. Dataset, cohort and stage-supply checks are real. These generated training
configurations remain unbound to external donor assets, immutable hindsight targets
and a live training coordinator. The engineering coordinator was exercised
separately by the native orchestration gates. The configuration-shape receipt identifies
those launch bindings explicitly; placeholder bindings are not presented as an
admitted training launch. An incomplete engineering receipt is rejected before
training; the [positive preflight receipt](evidence/semantic-v4/completion-preflight.json)
also verifies that all 45 configurations accept the completed engineering gate
without treating the separate launch assets as admitted. Training checkpoint format 18 preserves exact semantic exposure and
cohort identity only for configured semantic experiments; older payloads reject.

Historical common-support conditions and seeds are preserved from the original
runbook. That runbook contains no measured baseline for this new frozen cohort.
Historical measurements remain pending, and learned comparisons require a real,
matching historical receipt. No historical score has been invented.

## Reproduction, migration and operating boundaries

Use the exact code checkouts in the integration lock when reproducing these
revision-bound receipts. Run the tracer generator from its own checkout; its
producer identity and the native consumer's identity come from their actual Git
HEADs. Retain this published completion receipt as a separate input to the later
training planner. A newly collected revision receives new receipts.

The [implementation guide](SEMANTIC_HARNESS_V4_IMPLEMENTATION.md) gives install,
collection, inspection and evaluation commands. The two dedicated cross-repository
workflows install the immutable tokenizer, compare shared contract bytes, recheck
source/native admission, prepare all forms, run actual fixed-weight inference and
native coordinator cases, and require controlled evaluation success. They retain
machine-readable receipts as GitHub artifacts. The checked-in evidence directory
contains manifests, representative admitted episodes and the final summaries;
the generator reproduces the full corpus. Absolute paths in execution receipts
describe the verification workspace and are not portable launch bindings.

The selected production package is 0.3.0. Active training and serving use v4;
historical bounded-group tooling is explicitly offline under diagnostic exports.
Old serving contracts, schema/catalog mismatches and tokenizer mismatches reject.
Recollect or reprepare changed artifacts instead of relabeling them.

The supported boundary remains explicit. DOM events use the passive notification
profile; same-dispatch synchronous native callbacks that require an immediate
selected result are refused before work is queued. Registered asynchronous callback
returns are supported. Native resources require scoped typed grants. The JSON
codec and identity-preserving graph codec are distinct. These execution tools do
not claim arbitrary V8 compatibility or a hostile-code security sandbox.

Composition of separately certified sources requires globally unique certified
ingress, invocation and subscription identities; collisions are refused without
renaming witness bytes after certification. A single live harness supports multiple
subscriptions normally. See the [source recipe guide](SEMANTIC_SOURCE_RECIPE.md).

Recovery never silently repeats a possibly completed non-idempotent write.
Uncertain effects require reconciliation; lost native listeners require explicit
reattachment. Cancellation records what was stopped or closed and does not assert
that a remote side effect was undone. Exact replay calls no live adapter.

M9 starts from this completed engineering implementation. Trained checkpoints,
free-running learned success, equal-budget learning comparisons and deployment
quality must be measured separately through the completed interfaces.
