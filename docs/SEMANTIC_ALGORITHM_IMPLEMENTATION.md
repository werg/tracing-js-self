# Semantic algorithm refactor: implementation and qualification ledger

Started **19 November 2026** from the supplied “Refactoring tracing-js-self
toward compact algorithmic traces” plan, which reviewed
[`8d11f38619b8443c988f79b177908649338b3897`](https://github.com/werg/tracing-js-self/commit/8d11f38619b8443c988f79b177908649338b3897).
The [semantic contract](SEMANTIC_ALGORITHM_CONTRACT.md) defines the target.
This ledger distinguishes implementation from measured qualification.

## Objective and work policy

Several supported implementations of the same algorithm should share a typed
core. The trace states computations and relevant interactions so a checker can
validate it and a reader can explain it. Exact source/journal evidence remains
available without dominating public tokens.

The first slice is bounded pure arithmetic and ordered numeric summation,
followed by private-object simplification and a narrow async counter. Broad
JavaScript coverage, arbitrary loop discovery, general effect reordering, and
unrestricted prose parsing are outside this refactor.

The project is not yet in use. Existing architecture may be replaced directly;
no backward-compatibility adapters or old-checkpoint migration are required.
Historical evidence remains intact. Completed work is committed and pushed in
small increments so each checkpoint is recoverable.

## Phase ledger

Implementation checkpoints below are executable. The paired comparison and
verification receipts distinguish these checks from native promotion and
external comprehension or learning evidence.

| Phase | Required implementation | Checkpoint status / acceptance evidence |
| --- | --- | --- |
| 0: contract/baseline | Contract, assumption inventory, direction links, frozen eleven-case v6 and equivalence-family baselines | Implemented. `docs/evidence/semantic-algorithm-v7/baseline-v6.json` preserves the exact reviewed gallery; the comparison runner pairs all new source families with detailed execution. |
| 1: typed core | Validation, operation registry/checker, observables, receipts, alpha/temp/helper normalization | Implemented in `src/semantic/`; strict data/identity guards, deterministic/idempotent normalization, truthful alternative claims, and source-evidence regeneration have regression tests. |
| 2: ordered sum | Shared fold for indexed `for`, matching `while`, eligible helper/temp forms, certified `for...of` | Implemented with dense ordinary finite-number input guards, ascending binary64 accumulation, and exhaustive small/edge inputs. `reduce` remains explicitly unproved. |
| 3: private state | Bounded def-use/liveness/escape analysis, object/scalar convergence | Implemented for private ordinary objects and aliases. Returned, captured, effect-exposed, retained, hooked, and input mutations are refused by the abstract profile. |
| 4: counter | Regions across observations, trusted routing, derived payload, narrow async profile, durable resume | Implemented for `serial-scalar-effects/1`. Tests cover exact order/arguments, rejections, future-prefix isolation, false-claim blocking, durable checkpoints, stale intents, reconciliation, and dispatch deduplication. Cleanup/callback/concurrent-request forms retain detailed dispositions. |
| 5: consumers | Codec/GBNF/rendering, controller/harness, context/continuation, admission/contracts, native agreement | JavaScript candidate codec, controlled renderer, serving controller/harness, cached definitions/inputs, live state, contract generator and strict v7 version identities implemented. Independent production native v7 consumer remains a required companion change. |
| 6: promotion | Paired full costs, coverage/refusals/false merges, comprehension, native qualification | Comparison runner and exact pinned-tokenizer meter implemented. Native serving qualification and external comprehension evidence remain open; production default is not promoted. |

Core modules are `src/semantic/ir.js`, `operations.js`, `observables.js`,
`lower-js.js`, `provenance.js`, and `normalize-algorithm.js`. Names are
implemented interfaces. `src/semantic/normalize.js` remains the journal evidence
adapter. The compiler orchestrates components; the controller checks claims and
trusted routing without becoming another general JavaScript interpreter.

## Source-shape assumption inventory

Read from the reviewed v6 implementation. Replacement tests must retain the
underlying protection while removing incidental source-shape requirements.

| Existing assumption | Location | Replacement obligation |
| --- | --- | --- |
| Named private temporaries require separate computations | `test/training-semantic-projection.test.js`: “unrelated equal-valued computations never fuse; bound cells retain identity”; compiler | Eligible private temporaries converge; unrelated equal values never imply a dependency. |
| Source spelling is public identity | `test/training-semantic-source.test.js`: “teacher traces retain source variable names, correct effects and outcome”; `semantic-source.js` | Canonical identities are alpha-invariant; annotated readings may show names. |
| Callback parameters are `n`, `n_1` | `test/training-semantic-source.test.js`: “repeated callback parameters are separate source cells; captures stay shared” | Distinct invocation cells and shared captures remain correct independent of spelling. |
| Every source decision is predicted | `semantic-regions.js`, `format.js`, `test/training-trace-v6.test.js` | Source evidence retains truth; public meaningful selections remain explicit and checked. |
| Sum is an exact zero-initialized `let` accumulator/postfix counted `for` | `semantic-regions.js: inspectSemanticRegion()` | Several recognizers share one ordered fold with separate runtime domain guards. |
| Summary can contain only function name, inputs, answer | `semantic-regions.js`, `trace-text.js`, gallery | Supported summaries expose operation/dependency structure. |
| Summary is legal only at untouched entry | `controller.js: SemanticController.commit()` | Internal regions have explicit live inputs/outputs and cannot cross unseen observations or pending effects. |
| Request predicts invocation, source span, duplicate payload | `format.js`, `trace-text.js`, `controller.js`, source tests | Immutable boundary authorization replaces spans; committed arguments derive payload and legal scope. |
| Promise/job/await/resume mechanics are targets | Compiler, controller, `harness-v4.js` | Hide only proved redundancy under a declared async profile; keep observable order/live obligations. |
| Exact teacher regeneration is the only comparison | `effectful-compiler.js: verifyEffectfulProjection()` | Retain artifact integrity; add validation of alternative valid semantic decompositions. |
| Versions gate parser, context, continuations, admission together | `format.js`, contract generator, admission tooling | Update identities coherently; reject old formats and regenerate/re-admit new artifacts. |

Alias, capture, coercion, exception, cleanup, intermediate-truth, source, and
causal-isolation protections remain requirements. Removing a spelling assertion
does not justify deleting the semantic protection behind it.

## Baseline and measurement

The unchanged baseline is `SEMANTIC_GALLERY_FIXTURES` in
`src/training/semantic-trace-gallery.js`: compound arithmetic, branching, object
alias, pure helper, dense loop, throw/finally, counter, rejection/finally,
captured callback write, persistent external trigger, and redundant local writes.
Pair source, inputs, effect fixture, and schedule exactly. Preserve raw baseline
text and producing revision before projection changes.

Historical v5/v6 token counts describe their original artifacts. They do not
measure new algorithm artifacts. Keep every case in the new comparison,
including refusals, failures, and detailed fallbacks. Report family denominators,
paired totals and distributions (including median/p95 where meaningful):

- Behavioral fidelity, normalization convergence, false merges, explicit
  computation coverage, refusals, failures, and fallbacks.
- Generated tokens; observed source/input/definitions/routing/external tokens;
  framing; peak prefix; cumulative repeated serving context.
- Lowering, normalization, checking, dispatch, and continuation overhead.
- Comprehension and learning as separately measured outcomes.

Exact UTF-8 bytes are useful when tokens are unavailable; they are not token
estimates. Token claims require pinned-tokenizer encoding and round-trip
verification. Moving generated detail into observed context does not alone
establish lower serving cost.

## Equivalence and adversarial checks

Versioned families declare source variants, transformation relationships,
input/effect domains, expected structure, distinct provenance, and a shared
family identity. Keep relatives together in dataset splits; held-out renaming
does not establish a held-out algorithm.

- [x] Alpha/temp/helper variants converge without capture mistakes or
  value-coincidence substitutions.
- [x] Ordered folds converge across supported syntax for empty/singleton,
  signed-zero, large finite, and rounding-sensitive inputs.
- [x] Reverse traversal, holes, coercion, hooks, mutation, custom iteration,
  and unproved built-ins are distinguished or refused.
- [x] Private object/scalar variants converge; returned, captured,
  effect-exposed, retained, and input identities are preserved.
- [x] Changed effect order/count/arguments, cleanup, callbacks, and rejection
  remain visible even when terminal values match.
- [x] Every emitted intermediate claim is checked; false claims block strict
  external requests despite correct terminal answers.
- [x] Throwing, relevant randomness-consuming, and diverging work is not
  erased as dead private work.
- [x] Forged receipts, source correspondence, boundary IDs, fold order, values,
  and generated/observed roles fail closed.
- [x] Normalization is deterministic/idempotent, strict serialization
  round-trips, and independent source/exact replay checks pass.
- [x] Future responses cannot change earlier generated prefixes.
- [x] Checkpoint/resume preserves live state, pending obligations, and the
  intent lifecycle without duplicate dispatch.

The release suite requires zero observed false merges, with its finite domain
and denominator reported.

## Public candidate API and recovery

`tracing-js-self/semantic` exports source lowering, core validation/evaluation,
canonical text and controlled readings, `AlgorithmController`,
`AlgorithmExecutionHarness`, teacher compilation, independent evidence
rechecking, comparison, and token-metering interfaces. `validateAlgorithmTrace`
accepts checked subexpression decompositions without requiring teacher bytes;
`verifyAlgorithmProjection` separately enforces exact artifact regeneration.

The serving definition and immutable input graph are published once per
consumer cache. Every later reference must resolve to an available definition.
Context carries live committed values, needed alternative-expression
definitions, causal prefix identity, and pending/completion state. Checkpoint
replay checks claims, observation roles, exact timeline fields, source/boundary
authorization, dispatch order/multiplicity, and rederived host transport.

`persistCheckpoint()` and `restoreFromJournal()` use the existing durable
`SelectedIntentJournal` store. An intent is persisted before dispatch. A stale
selected checkpoint with an existing durable intent becomes uncertain;
restoration never retries it. A pending selected checkpoint without a durable
journal also restores conservatively as uncertain. Reconciliation requires
explicit external evidence. Settled observations can be restored without
calling services again. Integrity hashes establish consistency, not a signature
or a new authority to forge source or external facts.

`fixtures/semantic-equivalence/comprehension.js` predeclares 12 source-free
tasks and 24 paraphrases. `publicComprehensionTasks()` omits answer keys, while
`scoreComprehensionResponses()` records the full denominator and available
timing. Tests validate these materials; no external reader/model responses
have been collected, so comprehension improvement remains unmeasured.

## Native companion dependency

The independent consumer lives in
[`werg/megatoken`](https://github.com/werg/megatoken), outside this repository.
`tools/native-consumer/` provides setup and qualification scripts, not the
consumer implementation. The starting
`contracts/native-admission-policy-v6.json` pins consumer
`d644e3dfc01a22a14f039a9c063d7b65937d8e8f` and exact tokenizer identities.

Changed wire/context/continuation semantics need coordinated consumer work and
fresh receipts bound to actual revisions. JavaScript round-trips or a new local
Python parser do not qualify the pinned production consumer. If the companion
or tokenizer cannot run, record native admission/token costs as **unavailable**,
continue available implementation and checks, and leave release gates open.

`tools/tokenize-semantic-gallery.py` imports the companion's `ByteCodec` and
pinned tokenizer. Native supervision must verify zero prediction loss on
observations and exclude unseen future responses from model context. Old
receipts/checkpoints retain their original identities.

## Promotion gates and evidence limits

- [ ] All declared positive/negative families pass.
- [ ] Every emitted operation is checkable under its stated profile.
- [ ] Independent source, alias, exception, cleanup, and causal checks pass.
- [ ] Native and JavaScript consumers agree on valid/malformed records.
- [ ] Continuations and generated/observed boundaries are qualified.
- [ ] Full-cost measurements cover the unchanged baseline.
- [ ] Predeclared comprehension tasks show no material regression.
- [ ] Unsupported cases have explicit faithful dispositions.
- [ ] New artifacts are regenerated/admitted under actual identities.

Comprehension covers algorithm identification, dependencies, selection, next
effects, mutation versus copying, and incorrect paraphrases. Renderer snapshots
alone are not a reader study.

Learning requires a separate controlled experiment with fixed
sources/splits/tokenizer, declared model/training settings, matched-example and
matched-token/compute comparisons, and held-out algorithm families. Engineering
checks do not assert or imply improved learned execution.
