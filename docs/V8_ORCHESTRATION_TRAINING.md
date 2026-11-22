# Source-qualified V8 lifecycle training

`attachSourceQualifiedOrchestrationV8` adds four authored lifecycle targets to a
complete, independently source-checked child artifact. The public semantic
timeline stays canonical. A separately bound transcript records the coordinator
contexts, actions, acknowledgements, child readiness and exact completion.
The ordinary serving driver never imports this teacher or substitutes its
actions for model output.

## Scope and qualification

The first policy is `create-join-publish-complete`. It supports one declared root
call, one source definition, and a complete return or throw. The root may have a
fresh realm or be the first invocation in a retained realm. Reused retained
roots, multiple declared roots, dynamically created child invocations and a
public cut with observations after the child's generated terminal record are
outside this teacher profile. Refusals remain explicit.

The attaching API reruns original-source correspondence, source projection and
public replay before authoring any targets. It only accepts qualified teacher
provenance. A controlled model fixture, a missing original teacher origin on a
nested source artifact, or an explicitly unqualified origin cannot become
teacher evidence by changing a digest. The caller must attach the transcript
before dataset binding or native admission. The input artifact is not mutated.

```js
import {
  verifyRegionTrainingCase,
  attachSourceQualifiedOrchestrationV8,
  buildRegionDataset,
} from 'tracing-js-self/semantic/v8';

const checked = await verifyRegionTrainingCase(sourceFixture);
if (!checked.exported) throw new Error(checked.reason);
const teacher = await attachSourceQualifiedOrchestrationV8(checked.exported);
const dataset = await buildRegionDataset([teacher], {
  tokenizer,
  eosTokenId,
  maxContextTokens,
  nativePolicy,
  nativeConsumer,
});
```

Default dataset admission requires the paired consumer to validate and
materialize this transcript. A consumer that only understands the child public
timeline cannot supply the required receipt. `allowLocal: true` remains an
explicit diagnostic path, with no native-admission or learned-success claim.

`buildOrchestrationTranscriptV8` constructs the structural transcript, and
`validateOrchestrationTranscriptV8` independently reconstructs its lifecycle and
causal contexts. Neither replaces the asynchronous original-source check or the
independent native admission gate.

## Exact transcript

The sidecar field `orchestrationTranscript` has schema
`semantic-orchestration-transcript/1` and origin `source-qualified-teacher`. Its
fixed policy, source/input ingress, terminal child cut and ten ordered events
are hashed. External dataset and admission bindings hash the entire transcript,
including its internal digest; they do not substitute that internal digest.

| Event | Anchor | Evidence |
| --- | --- | --- |
| Create decision | Public row 2 | Exact declared source/input execution binding and coordinator context |
| Create acknowledgement | Public row 2 | Child reservation and issued completion dependency |
| Bootstrap | Public row 2 | Exact child is ready but waiting while the coordinator occupies the active slot |
| Join decision | Public row 2 | Exact issued dependency and pre-join coordinator context |
| Join acknowledgement | Public row 2 | Coordinator waits; the bootstrapped child becomes active |
| Child completion | Terminal public row | Independently replayed return/throw and heap, public/context digests and delivered dependency receipt |
| Progress decision | Terminal public row | Exact serialized child completion and resumed coordinator context |
| Progress acknowledgement | Terminal public row | Exact published invocation and progress |
| Complete decision | Terminal public row | All declared work completed and published |
| Complete acknowledgement | Terminal public row | Terminal coordinator state |

The teacher acknowledgements use `semantic-orchestration-teacher-commit/1`.
They carry no fabricated model selection IDs, token IDs, checkpoint identities
or inference provenance. The native consumer independently replays the actual
track registry rather than trusting these acknowledgements as authority.

## Ordinary serialization and admission

The flat causal serializer interleaves four additional loss-bearing targets at
their exact public anchors. Each target sees its pre-decision coordinator
context. Prompt tokens stay masked; the action's original canonical bytes are
the target. Token and serving-cost audits include all four additional targets.

Dataset binding includes `orchestrationTranscriptDigest`. A child-only artifact
and an augmented artifact with the same public history receive distinct
candidate identities while staying in the same immutable source/family
component and split. They cannot be silently collapsed as duplicate data or
placed on opposite sides of a holdout.

Fresh source receipts must attest `orchestrationValidated: true` and the exact
full transcript digest. Native admission must repeat that digest, pass its
`orchestration` check and report four actual lifecycle records. Missing, changed
or null transcripts and detached orchestration claims are refused. These
requirements supplement the existing exact source, contexts, tokenizer,
physical-mask and native-training checks.

## Ordinary command qualification

`tools/qualify-ordinary-v8-lifecycle.mjs --orchestration-teacher` uses the same
frozen 66-source interoperability inventory and predeclared training member as
the ordinary lifecycle control. It attaches the teacher before family binding,
then runs the normal preparation, optimizer, fresh resume, export and service
restoration commands. No source is selected after observing model performance.

The command needs an exact committed consumer with transcript support and the
real pinned tokenizer. Two optimizer updates test the ordinary command path;
they do not establish exposure to every lifecycle target, learned orchestration
success, held-out quality or production readiness. Full production behavior
coverage and whole-program serving/recovery remain separate acceptance gates.

## Retained controls

The producer teacher/native-receipt/causal-serializer/dataset selection passes
20 tests with zero failures or skips. Controls include exact source rechecking,
the complete ordered lifecycle, terminal heap/result binding, causal anchors,
rehashed provenance/dependency/context/source mutations, conditional native
receipts, duplicate identity and target-only masks. Complete local logs are in
`docs/evidence/v8-orchestration-training-2026-11-22/`. Those logs contain no actual
production-tokenizer, optimizer or learned-model result.
