# Training implementation ledger

This records the first tracer-owned implementation of [the training plan](TRAINING_DATA_PLAN.md). It separates working components from future work. It does not claim full ECMAScript, host integration, megatoken integration, or model rollout correctness.

## Implemented in tracing-js-self

- Versioned training-js/1: Acorn 8.15.0, locked integrity, ES2022 strict scripts, exact positions, positive allowlist, no ambient globals, top-level strict directive and named synchronous function declarations.
- Direct function entry with identity-preserving plain object/array argument graphs, aliases, cycles, property order, input limits and explicit root completion. Exotic inputs, proxies, getters, holes and unimplemented operations fail closed.
- Fixed escaped hex/unicode strings and undefined shadowing; reference truthiness/equality/typeof; canonical array index and length/truncation behavior; explicit guest throw completion; read and mutation versions.
- Canonical source-anchored semantic records from the full journal, with actual read-from links, versioned writes, control decisions, invocation IDs, and validation against that journal.
- Deterministic semantic-trace/1 line grammar, typed scalar/identity values, lossless JSON escaping, bounded fragments and parser/serialization checks.
- Fixed t0 through t7 lanes, one conservative serial generated record per model group, observed input/source separated from generated groups; deterministic assignments do not consult future reference results.
- Predictor-safe source/input context and supervised trace export with private reference/journal sidecar. Explicit group, dependency, loss and fragment validation.
- Independent Node V8 vm reference comparisons on completion and reachable observable graph, plus structural reconstruction and adapter-free exact interpreter replay.
- Deterministic source-family local-fixture generator with lineage splits, seeds, provenance, rejected-run counts, and full diagnostics.

## Limits / incomplete plan milestones

1. The locally verified profile is **synchronous, no effects, no async and no guest exceptions**, with one small source bundle and no detached work. The legacy bounded profile is separate. Unsupported runtime property/coercion families are not silently admitted.
2. Static def-use/liveness pruning and fully compact semantic-target optimization are incomplete. Control and state transitions are preserved conservatively.
3. Lazy code-on-call, reference-codec token counting, parallel-ready independent groups, full segmentation/continuation, serving model-state realization, and unrestricted call parking are not implemented. Oversized input/trace produces a limit diagnostic, not a fabricated completion.
4. A standalone, guarded canonical-json/1 host graph materializer and a bounded fulfilled/pending promise-adoption handler exist and have regression tests, but the training profile does not enable host effects or async yet. Integrating codec schemas with effect dispatch, correct promise reaction scheduling/rejection, catch/finally, real host scheduling and broad spec-backed owned operations remain profile-extension work.
5. The megatoken Python adapter, episode-schema acceptance, teacher-conditioned loss path and generated-state rollout verifier belong to **werg/megatoken**. This repository exports a candidate schema; it does not claim that megatoken can already consume it.
6. **Locally verified is not admitted.** The generator reports admitted=0 until all plan admission gates, including cross-repository megatoken validation and independently checked intermediate semantic coverage, are satisfied. Exact self-replay does not establish JavaScript correctness.

## Reproducible local fixtures

Run npm ci and npm test, then:

~~~sh
npm run training:generate -- --seed 42 --count 16 \
  --output training-local.jsonl --manifest training-manifest.json
~~~

Each JSONL line has a public payload and a **private sidecar** with archived state, reference outcome and provenance. Future targets inside public.groups are training labels, never predictor inputs; only the observed prefix and earlier committed generated groups may be used for conditioning. The sidecar must never enter model attention.
