# Training implementation ledger

This records the first tracer-owned implementation of [the training plan](TRAINING_DATA_PLAN.md). It separates working components from future work. It does not claim full ECMAScript, host integration, megatoken integration, or model rollout correctness.

## Implemented in tracing-js-self

- Versioned training-js/1: Acorn 8.15.0, locked integrity, ES2022 strict scripts, exact positions, positive allowlist, no ambient globals, top-level strict directive and named synchronous function declarations.
- The shared owned arithmetic path records primitive conversion, type checks, scalar arithmetic leaves and completions as serializable spec phases. Training entries keep the `training-js/1` language profile while their journal and exact replay use `/2`; see [owned arithmetic and its domain limits](OWNED_ARITHMETIC.md).
- Direct function entry with identity-preserving plain object/array argument graphs, aliases, cycles, property order, input limits and explicit root completion. Exotic inputs, proxies, getters, holes and unimplemented operations fail closed.
- Fixed escaped hex/unicode strings and undefined shadowing; reference truthiness/equality/typeof; canonical array index and length/truncation behavior; explicit guest throw completion; read and mutation versions.
- Common strict control flow: conditional expressions, for-let or expression-header loops, do-while, break/continue and prefix/postfix local-identifier updates. Updates have an owned primitive ToNumeric calculation, typed numeric step and versioned binding mutation, with independent V8 source-expression receipts for pre/post numeric results. Object-valued update coercion, member updates, labelled control flow and captured per-iteration for-let bindings are rejected, not approximated.
- Canonical source-anchored semantic records from the full journal, with actual read-from links, versioned writes, control decisions, invocation IDs, and validation against that journal.
- Deterministic semantic-trace/1 line grammar, typed scalar/identity values, lossless JSON escaping, bounded fragments and parser/serialization checks.
- Fixed t0 through t7 lanes, one conservative serial generated record per model group, observed input/source separated from generated groups; deterministic assignments do not consult future reference results.
- Predictor-safe source/input context and supervised trace export with private reference/journal sidecar. Explicit group, dependency, loss and fragment validation.
- Independent Node V8 vm reference comparisons on completion and reachable observable graph, plus structural reconstruction and adapter-free exact interpreter replay.
- Executed scalar-producing unary, binary and supported compound-assignment source expressions are also observed, in source order, by a separately run, source-instrumented V8 reference. Typed intermediate results and source spans are compared with normalized committed journal events, including repeated loops and overwritten temporaries. The reference run must preserve the uninstrumented observable graph. `reference-operations/1` counters and remaining unverified semantic families stay in the private sidecar; this is not a full intermediate-state oracle or corpus admission.
- Deterministic source-family local-fixture generator with lineage splits, seeds, provenance, rejected-run counts, and full diagnostics.
- Model-visible input graph handles now retain owned journal identities, with static function/code identity published before generation. A bounded serving-side `SemanticController` validates model-selected semantic values, reads, writes, branches, calls, and completions against committed state without running JavaScript or repairing model output. Its exact committed-prefix packet and a versioned live-state `semantic-continuation/2` packet support bounded handoff between fresh model sessions from model-committed heap/cells/activations, without golden replay or new semantic identities. These controller packets are diagnostics; the dataset exporter does not yet automatically segment into new megatoken Episodes.
- `src/training/rollout.js` and `tools/evaluate-training.mjs` verify actual selected output after commit, report the first divergence and observable returned/input graph correctness, and reject invalid model events without substituting the reference trajectory. Model-selected commits now roll back the entire bounded controller state on rejection, including partial allocation/completion/fragment mutations; an episode missing its terminal `end` is an invalid incomplete rollout, not a valid trajectory.
- The cross-repository megatoken `semantic-execution/1` adapter now exists on `werg/megatoken/main`, with explicit causal episode validation, codec-bound import, fixed lanes, teacher-conditioned supervised recurrence, a local diagnostic converter, and a pinned CI contract test using actual tracer-generated episodes. Large source and request records preserve their logical identity and action/result linkage across physical fragments.
- The `bounded-js-subset/2` mock host bridge now prepares versioned `canonical-json/1` request snapshots before dispatch, gives adapters only frozen JSON argument data, records exact payload bytes and graph-version provenance, and independently verifies the payload against the committed heap at the request boundary. The causal and semantic projections expose the complete materialized payload, not a symbolic external argument.

## Limits / incomplete plan milestones

1. The locally verified profile is **synchronous, no effects, no async and no guest exceptions**, with one small source bundle and no detached work. The legacy bounded profile is separate. Unsupported runtime property/coercion families are not silently admitted.
2. Static def-use/liveness pruning and fully compact semantic-target optimization are incomplete. Control and state transitions are preserved conservatively.
3. Lazy code-on-call, reference-codec token counting on the tracer side, parallel-ready independent groups, multi-segment history eviction, full serving integration with real selected latent model representations, and unrestricted call parking are not implemented. The bounded controller can reconstruct a committed prefix and detect divergence but does not solve all serving semantics. Oversized input/trace produces a limit diagnostic, not a fabricated completion.
4. The demo host operations now use guarded, schema-checked JSON materialization **before dispatch**, with independent journal validation and tests for aliases, cycles, unsupported scalars, tampering, and replay without repeat effects. This is currently the separate `bounded-js-subset/2` mock host path; strict `training-js/1` remains synchronous and effect-free. Real host services, broader registered codecs, promise rejection/reaction scheduling, catch/finally, async admission, and general native transport remain profile-extension work.
5. The megatoken Python adapter, strict episode-schema validation, an explicit teacher-conditioned recurrence path, and a JSONL converter are now implemented on **werg/megatoken/main**. End-to-end actual *model* rollouts and scored serving compute remain open; the tracer's selected-trajectory validator is a deterministic diagnostic, not evidence of learned execution quality.
6. **Locally verified is not admitted.** The generator reports admitted=0 until all plan admission gates, including independent operation-level reference coverage and end-to-end *model-selected* rollout validity, are satisfied. Exact self-replay does not establish JavaScript correctness.

## Reproducible local fixtures

Run npm ci and npm test, then:

~~~sh
npm run training:generate -- --seed 42 --count 16 \
  --output training-local.jsonl --manifest training-manifest.json
~~~

Each JSONL line has a public payload and a **private sidecar** with archived state, reference outcome and provenance. Future targets inside public.groups are training labels, never predictor inputs; only the observed prefix and earlier committed generated groups may be used for conditioning. The sidecar must never enter model attention.

## Model-selected evaluation

After generating a local verified JSONL reference corpus, supply a separate JSONL of **actual model-selected** episode `groups` to `npm run training:evaluate -- --selected selected.jsonl --reference training-local.jsonl --output report.json`. The evaluator commits each selected group before consulting the reference and reports exact state/return correctness and the first inconsistent category. Re-using reference groups as selected input checks only the deterministic verifier, **not a model's ability to execute**.
