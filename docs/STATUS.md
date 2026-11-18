# Current execution tracing status

**Only model-facing execution representation:** `semantic-execution/5`,
`semantic-trace/5`, `semantic-context/5`, `semantic-continuation/5`,
`selected-harness/2`.

The canonical target is a **source-grounded semantic account**: calculations
are checked expressions paired with the value computed at that point;
source cell names are reused where available; anonymous intermediate pure
calculations have no synthetic identity. Model-selected work must preserve
observable completion, reachable graph, ordered external side effects,
deliveries, event/callback execution and required pending-work disposition.
A valid alternative reasoning decomposition need not match teacher bytes.

The runtime is a bounded JavaScript/TypeScript execution profile, not a
general native Node.js/browser compatibility layer. Unsupported cases fail
closed. The private journal and independent V8 reference verify owned
source execution, but are not learner trace targets.

## Active code and evidence

The [execution-training implementation ledger](EXECUTION_TRAINING_IMPLEMENTATION.md)
tracks the current strict-assignment repair, independent completion checks,
teacher mutation audit, native input diagnosis, causal-LM bridge, checked
trace abstractions, coverage selection and bounded generation tools. Use
`npm run baseline:v5` to generate an exact-revision manifest and status page.
Code availability, a locally verified sample, native admission and successful
model learning are separate evidence levels.

The [executed roadmap baseline](evidence/execution-baseline-7b5ef54/STATUS.md)
records fourteen passed command checks at `7b5ef54…`: 1,004 unit passes,
five explicit native-serving skips, zero failures, all thirteen teacher
mutants detected, and 203 locally verified recipe examples. That source-only
run does not assert native admission or model learning.

The [completed hosted roadmap qualification](evidence/roadmap-hosted-53daa93/README.md)
applies to producer `53daa939dba0a0202402dc980a17a6682e719b37` and companion
`9a9dd3593c6887d63012dd5c953e914557dca386`. All six primary workflows passed,
including the five source/native corpus jobs and a separate engineering
archive restore. Each Node 20/22/24 suite passed 1,006 tests with seven skips;
both companion CPU suites passed 2,906 tests with 50 skips. The receipt names
the actual PR merge checkouts and verifies their source-tree equality.

Prepared inventories contain engineering 25, training-v4 50, benchmark-v1
128, real-source 100 and generated-v1 61 rows. These are separate recipe
denominators. Every exclusion is accounted for; the larger benchmark and
real-source archives exceed the available reader's size limit, so their
detailed final coverage membership remains unavailable in the compact receipt.
The separate restore verified 200 files and replayed all 25 positive attempts
with the exact original producer and runtime. Native requalification during
that restore remains untested.

The same hosted run repeated the actual model measurement and again
**failed Gaussian parity**, with maximum absolute difference 2.4304623.
No optimizer updates or successful learned execution are claimed. The next
native learning gate is to resolve the measured model-prefix and action-support
differences, then execute the declared convergence experiments. The later
commit containing these receipts adds documentation and compact artifact
uploads; it does not reattribute the measurements to a new producer revision.

The retained [I qualification](evidence/qualification-I-2026-11-18.json)
is **historical evidence at its recorded producer and consumer**: 945 unit
passes, eight reference fixtures and forty attempted native probes. Its
hosted workflow results belong to the exact revision in the
[historical handover](RESUMPTION_HANDOVER.md), not a later containing commit.
Historical learning diagnostics have zero successful held-in or held-out
executions. The [new input-boundary diagnosis](LEARNING_DIAGNOSTICS.md)
identifies unequal training/serving instructions and observations; it does
not establish successful learning. The instruction/observation repair passed
its hosted byte comparison. The subsequent
[actual native conditional capture](evidence/native-conditionals-cb67ed1/README.md)
**failed parity** at producer `cb67ed1…` and consumer `2725842…`: the same
zero-update checkpoint and public prefix reached different conditional state
through the two real paths. Metadata, track ownership and lifecycle history
remain different. No new learned-execution success is claimed.

The November resumption adds an explicit [capability index](../coverage/required.json),
[measured v5 probes](../coverage/current-v5.json), and
[implementation/evidence ledger](RESUMPTION_IMPLEMENTATION.md). Source-profile
limits remain explicit: unsupported descriptors and array accessors are refused;
the declared Error observation profile covers name/message without flattening
stacks, causes, custom prototypes, or accessors. Synchronous primitive and
declared-Error throws can be positive execution labels. Callback failures and
unhandled rejection obligations remain admission refusals.

- `src/training/effectful-compiler.js`: sole source-certified witness producer
- `src/training/format.js`: sole public codec and strict v5 validator
- `src/training/harness-v4.js`, `controller.js`, `model-driver.js`:
  selected execution, state, external effects and observed continuations
- `src/training/source-check.js`: synchronous trusted-source verification
  through the **same** v5 producer; does not grant admitted training status
- `src/training/effectful-admit.js`: independent source/effect/replay gates
  and optional pinned Megatoken native admission
- `src/training/completion-reference.js`: once-evaluated independent source
  completion observations and committed-state comparisons
- `src/training/semantic-source.js`: independently checked, bounded source
  expressions
- `tools/inspect-semantic-reasoning.mjs`: actual generated-trace inspection
- `src/training/admission-identity.js`: immutable source, split, lineage,
  environment, and native-receipt bindings for single and session inputs
- `src/corpus/source-registry.mjs`: frozen cross-stream ancestor/clone components
- `src/corpus/campaign-store.mjs`: atomic checksummed campaign checkpoints,
  private evidence compression, and lossless shared registry storage
- `tools/current-v5-baseline.mjs`: one-command exact-revision evidence collection
- `tools/package-semantic-release.py`: complete private release and native
  preparation with an independently verifiable archive inventory
- `tools/run-optimization-smoke.py`: actual CPU updates, masks, checkpoint reload,
  and original model-selected rollouts without teacher correction

The separate source-language frontend, graph codec, host payload codec and
private interpreter archive are necessary **trust boundaries**, not old
model-visible training formats.

## Deliberately retained non-model machinery

| Component | Why it is necessary |
| --- | --- |
| Owned private interpreter journal and exact replay | Detect omissions, incorrect effects and invented outcomes in the teacher without exposing interpreter noise to the model |
| Independent V8 reference and source/branch/operation instrumentation | Compare guest behavior to a separately executed authority; never permit a reference sidecar to repair generated reasoning |
| Native selected model tape/group transport | Commit and validate the one selected text record with native event/track provenance; this is a transport envelope, not a second JS trace grammar |
| Host operation and graph codecs | Distinguish authorized effect payloads from identity-preserving ordinary data, and prevent unsafe implicit coercion |
| Hash-pinned old engineering evidence | Records the actual old revision and source/native admission receipts in `contracts/semantic-engineering-completion.json`. It must not be reinterpreted as current schema or executable support; see original Git commits for prior implementations |

There is no public `training/diagnostic` subpath, `diagnostic:*` CLI,
v3 group-shaped writer, explicit-vs-compact selection switch, or
outcome-only interactive training mode. Old formats can be recovered
only by checking out their historical Git revision.

## Admission and readiness

Local source validation is not the same as native data admission. A
production training sample must additionally pass complete selected
record replay, strict observable reference agreement, pinned native
tokenizer, native action/visibility/loss checks, and family/split
provenance. Schema changes require coordinated migration of the
separately versioned Megatoken consumer. No model-learning improvement
is claimed from compactness alone; learned quality must be measured
with genuine held-out model runs.

For commands and examples see [semantic reasoning traces](SEMANTIC_REASONING_TRACE.md),
[implementation](SEMANTIC_HARNESS_V4_IMPLEMENTATION.md) and
[source recipe](SEMANTIC_SOURCE_RECIPE.md).
