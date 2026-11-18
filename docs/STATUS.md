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

## Active code

The latest frozen [I qualification](evidence/qualification-I-2026-11-18.json)
passes 945 unit tests with zero skips, eight reference fixtures and all forty
attempted native probes. All eight hosted workflows pass at the exact revision
recorded in the [handover](RESUMPTION_HANDOVER.md). The completed learning
diagnostic still has zero successful held-in or held-out executions; its
acceptance criteria remain unmet.

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
