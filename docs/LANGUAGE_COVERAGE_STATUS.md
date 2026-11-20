# Language coverage engineering completion ledger

**20 November 2026 — current contract and model receipts are retained; full
population and dataset qualification are in progress.**

This ledger tracks the bounded candidate delivered by
[tracing-js-self PR #46](https://github.com/werg/tracing-js-self/pull/46) and its
paired consumer work against the actual
[language coverage plan](LANGUAGE_COVERAGE_PLAN.md#9-delivery-sequence-and-acceptance-gates).
It separates implemented behavior, retained engineering qualification,
model measurements, and the production-default decision.

The delivery target is the implemented candidate allowed by
[plan §10.4](LANGUAGE_COVERAGE_PLAN.md#104-default-promotion-should-be-coordinated).
That rule explicitly permits shipping supported slices while unavailable model
studies or full serving measurements remain recorded gaps. It does not waive
correctness or native admission for a claimed slice. It also does not declare
every roadmap wave, unrestricted ECMAScript, or standard-format promotion done.
V6 remains the production default.

## Remaining completion work, hardest first

The original hard implementation gaps were addressed before documentation and
packaging. The remaining acceptance work follows this order:

| Rank | Work | Current disposition and completion condition |
| --- | --- | --- |
| 1 — hardest | Model-selected execution, independent native serving, and source correctness | The live v8 runner, native process adapter, frozen configuration, per-record acknowledgements, callback lifecycle, and private source scorer are implemented. A [256-step bounded fit, freshly evaluated at the current contract](../coverage/language-expansion/native-v8-fit-39c4036/README.md), completed the sole training input on **3/3 seeds**, the separate input on **0/3**, and the zero-update baseline on **0/6**. [Independent byte decoding and private source replay](../coverage/language-expansion/native-v8-fit-39c4036/independent-audit/README.md) reproduce those retained outcomes. The original 43 MB fitted/checkpoint archive has no published retrieval location and was unavailable to that audit. Two separate [four-step native diagnostics](evidence/semantic-v8-diagnostic-pilot/2026-11-20/README.md) each measured **0/2 completed executions** and retain their full fitted bundles. External comprehension and general learned execution remain unqualified. |
| 2 | Iterator, pattern, and runtime-protocol correctness | Bounded custom `for…of` acquisition/close, flat iterable bindings, and ordinary abrupt cleanup compose with shared protocol state. Tests cover cached `next`, receiver identity, completion precedence, loop targets, Number callback throws, and checkpoint restoration. The current paired native regression passed **244 tests without skips**; [direct/nested abrupt Number admissions](../coverage/language-expansion/number-abrupt-012c9fe/README.md) passed **2/2**. Broader supplementary population receipts are being retained. General iterator patterns, async iteration, and intrinsic guest-error profiles outside these slices remain explicit refusals or separate work. |
| 3 | Complete exact-head qualification, data readmission, and costs | Repeat the complete 665-case expansion, **26-case interoperability**, and 11-case gallery populations at fixed clean producer/consumer revisions; retain all dispositions and exact costs. Rebind and readmit the **37-episode dataset** under those identities. Historical passing reports cannot qualify the newly changed implementation. Full expansion and dataset runs are **in progress**. |
| 4 — easiest | Public exports, contracts, documentation, and PR reconciliation | Public APIs and the frozen experiment command are integrated; execution/report interpretation is documented. Finish the exact-head contract/reference checks, update bounded profile documentation from the new receipts, and reconcile every associated PR/check. Final receipt links and PR outcomes are **pending**. |

The unmeasured promotion studies below are not silently removed from the plan.
They remain visible without blocking the candidate-shipping option in §10.4.

## Plan milestone mapping

| Plan milestone | Delivered candidate scope | Remaining boundary |
| --- | --- | --- |
| M0 — Current baseline | Frozen family, interaction, real-source, and unchanged gallery inventories; exact old source/native/token reports; per-attempt dispositions and split provenance. The current clean pair is producer `012c9fe` / consumer `39c4036`. | Full expansion and dataset qualification are in progress. Only 27 of 78 available real-source functions belong to the declared real-source slice. |
| M1 — Vocabulary and notation | Checked canonical operations, controlled readings, formal/hybrid/prose comparison machinery, and a predeclared 228-task comprehension inventory with frozen study/scoring tools. | External responses, powered noninferiority results, and a measured winning notation remain unmeasured. Description-only questions do not establish a notation comparison. |
| M2 — Compositional regions | Compact–detailed–protocol execution on shared heap/cells, receiver and capture identities, completion and request state; stale-entry refusal, local precommit fallback, checkpoint/replay, and causal context checks. The live selector now rejects false claims before mutation. | Independent source correspondence remains separate from public consistency. A legal public completion alone cannot prove that the source was followed. |
| M3 — Broad common algorithms | Bounded ordered folds, map/filter/search/quantifiers/scans, lazy selection/defaults, helpers, ordinary projections, and fresh output graphs; equivalent idioms and executed near-misses. | Dense pure traversal is bounded; hook-bearing/sparse traversal and effectful callbacks require their declared detailed/protocol profiles. Source admission is not equivalent to compact coverage. |
| M4 — State, calls, and completions | Ordinary properties, Symbols, descriptors/prototypes, mutation, live captures, receivers, and bounded cleanup. Number conversion now preserves direct/nested callback throws through caller and callback `catch`/`finally`, including overridden and retained pending completions. | Unrepresented coercion hooks, intrinsic errors, and async/exotic callbacks remain unqualified. Each new claim needs its own source and consumer evidence. |
| M5 — Exotic protocols | Bounded iterators and synchronous generators, construction/classes/private state, Promise joins/executors, Proxy get/set, custom-iterator close, and flat variable bindings from supported iterables. | Async generators/iteration, nested or assignment iterable patterns, unrestricted delegation, construction, Proxy traps, Promise assimilation, and other explicit profile exclusions are not completed by related builtin support. |
| M6 — Composition and breadth | Module live cells/synchronous cycles, acyclic top-level await, qualified TypeScript transformations, binary memory, cross-feature fixtures, fixed family splits, and full-denominator cost reporting. | No unrestricted module/TypeScript or cross-agent memory claim. New compact collection/RegExp profiles and arbitrary host/DOM behavior remain separately scoped. |
| M7 — Standard-format promotion | Native admission, exact serialization/masks, split-bound dataset export, and now bounded real-model execution collection/scoring machinery are available. | **Not promoted.** External comprehension, general held-out execution, fixed-usefulness cost/latency comparisons, and the coordinated default change are not established by engineering tests. |

The authoritative feature/profile limits remain in the
[bounded coverage matrix](SEMANTIC_REGIONS_V8.md#current-bounded-coverage-and-qualification)
and its linked protocol documents/tests. This ledger does not widen them.

## Standard feature checklist from plan §9

| Required evidence | Candidate evidence and final-head status |
| --- | --- |
| Explicit source/profile/domain | Profile matrix and source adapters specify supported inputs, bounds, and exclusions. The new custom-iterator and ordinary-cleanup slices have dedicated source regressions. |
| Owned execution plus independent evidence | Independent V8 source outcome, operation, branch, completion, and protocol observations challenge the producer. Public replay is an additional check. Final changed-head population receipts: **pending**. |
| Checked concise operation/reading | Canonical codec, shared public state, operation definitions, and notation views exist; compact, detailed, and protocol records remain distinguishable. Final contract checks: **pending**. |
| Equivalent idioms and distinct near-misses | The frozen benchmark retains 26 families × 3 idioms × 8 inputs and 52 independently executed distinguishing pairs. New protocol tests additionally check order, identity, abrupt precedence, and malformed-state refusal. Final reference/regression run: **pending**. |
| Fallback, exceptions, and limits | Local fallback happens before commitment; unsupported profiles refuse explicitly. False claims, stale retries, malformed native bytes, deadline failures, and cleanup failures remain in reports. |
| Native, contexts, continuation, and masks agree | Historical complete-population and dataset receipts establish their exact revisions. Matching current consumer changes and live acknowledgements are implemented. Final paired validation/readmission: **pending**. |
| Real-source coverage and total-token costs | Historical 27-function real-source and all three declared population costs are retained, including every matched cost increase. Final revised-head costs: **pending**. |
| Understanding/execution measured or explicitly untested | Frozen comprehension and execution tools preserve denominators and provenance. The [current-contract native experiment](../coverage/language-expansion/native-v8-fit-39c4036/README.md) measures **3/3 training-input**, **0/3 separate-input**, and **0/6 baseline** source-qualified completions. Both independently initialized [four-step diagnostics](evidence/semantic-v8-diagnostic-pilot/2026-11-20/README.md) measured **0/2**. External comprehension remains **unmeasured**; general held-out usefulness remains **unqualified**. |

## Retained evidence: historical pins stay historical

The completed
[b66c19b / 6adf99f qualification](../coverage/language-expansion/native-v8-b66c19b-all/README.md)
measures producer `b66c19be960f114b69787746b2487e6f23a73577` and consumer
`6adf99f1301557ee5b95269581a3acd4162496b4`:

| Population | Source qualified / declared | Native admitted / declared | Token/packing coverage |
| --- | ---: | ---: | ---: |
| Expansion | 665 / 665 | 665 / 665 | 665 / 665 |
| Interoperability | 23 / 23 | 23 / 23 | 23 / 23 |
| Original gallery | 11 / 11 | 11 / 11 | 11 / 11 |

These inventories overlap and are reported separately; their counts are not a
combined unique-case claim. Expansion contains 624 family executions, 12 script
interactions, 27 selected real-source functions, and two evaluated-module
interactions. The other 51 available real-source functions are untested by this
population.

At those same pins, the producer recorded 1,778 passes, six conditional skips,
zero failures, five passing contract generators, and eight passing reference
fixtures. The selected independent native suite passed 214 tests without skips.
These results are not assigned to later revisions.

Historical compact coverage was 458/665 expansion episodes with at least one
compact region; 207 remained wholly detailed, and detailed targets accounted
for 86.58% of generated tokens. The 42 matched historical source/input cases
used 90.21% fewer total flat tokens but only 4.12% fewer generated tokens. The
large total reduction primarily concerns submitted context. Gallery generated
tokens increased 22.57%, and all eight individual flat-total cost increases
remain in the linked report. None of these counts measures serving latency,
cache reuse, comprehension, or completed model execution.

The separately
[readmitted 34-episode dataset](../coverage/language-expansion/dataset-v8-492328f/README.md)
belongs to producer `492328fe387e99487285984b782cd3b402990e2c` and consumer
`cb311dba6af44ef241450a87ef530a66aa55c7a3`. Fresh source/native admission followed
global split binding: 34 episodes, 898 complete examples, 31 family components,
and 29,374 generated tokens including 898 EOS tokens. All prompts and targets
were independently re-encoded with the pinned tokenizer; prompt tokens were
unscored and generated/EOS tokens were supervised. It performed zero optimizer
steps. Its successful admission does not establish learned success or qualify
the current changed heads.

## Changes requiring the new final receipts

The current completion work adds substantive behavior beyond those retained
reports:

- A live v8 selected driver and native process bridge with frozen model/settings
  attestation, original-byte/token provenance, per-record acknowledgements,
  causal broker delivery, callbacks, stale rejection, and bounded cleanup.
- A frozen experiment declaration, private source scorer, CLI, and report that
  separates public completion from scoped source qualification. Original failed
  bytes/costs and untested case/seed rows remain visible. See
  [the execution guide](SEMANTIC_V8_EXECUTION.md).
- Ordinary cleanup continuations for abrupt Number callbacks, including ten
  named source cases, malformed-handler refusal, and restoration across every
  retained cleanup boundary. See
  [completion tests](../test/semantic-protocol-completion-source-v8.test.js).
- Custom synchronous `for…of` acquisition and close through ordinary properties
  and calls: sixteen positive cases cover cached `next`, live `return` lookup,
  receivers, abrupt precedence, nested labels, and Number throws during close.
  Unrepresented intrinsic errors and generator cleanup remain refusals. See
  [custom iterator tests](../test/semantic-protocol-custom-iterator-source-v8.test.js).
- Flat iterable variable bindings preserve elisions, defaults, rest/exhaustion,
  cached `next`, receiver identity, early close, and abrupt completion precedence.
  Nested patterns, assignment patterns, and unsupported intrinsic string source
  forms retain explicit refusals. See
  [iterable binding tests](../test/semantic-protocol-iterable-binding-source-v8.test.js).

The execution scorer presently qualifies exact independently source-certified
public/context projections. A different valid decomposition or callback
observation schedule can complete publicly and remain `unqualified-projection`.
That is an explicit evidence limit, not a claim that the alternative is wrong.
Engineering injection controls are labelled `engineering-only`; they cannot
substitute for actual model output.

## Current frozen implementation acceptance record

Replace these entries only with newly retained measurements. A passing old
receipt or a successful narrow diagnostic does not fill a pending row.

| Item | Final identity/result | Receipt |
| --- | --- | --- |
| Clean producer commit and tree | `012c9fe49a082319bf98ac0c571596da925741a4` / `26454c685a6136ab6d6d18636e6073216ee9d195` | [Current-contract source/native/model packet](../coverage/language-expansion/native-v8-fit-39c4036/README.md), with clean before/after identities |
| Clean consumer commit and tree | `39c4036564428e44cc89caf261f517d856482695` / `ca55473db0ed3343ad930833a4ee09ad48bf7caf` | Same exact-pair packet; subsequent CI/docs changes do not alter the measured semantic implementation |
| Native policy, tokenizer, codec identities | Native policy `39c4036`; contract `344f7e99aeed605a1965c70f0e0d8829707d6891437ba43dd743fa304cd777dc`; tokenizer `40fb9d7d7795b8bd305aeff39ce9963f3f450915b9553f2938e009be9a1fed60`; codec `7f52faca2fe82273a889023defd2f1a6fd6080a21096ec77e97f4798a0a370b2` | [Independently checked bindings](../coverage/language-expansion/native-v8-fit-39c4036/independent-audit/README.md) |
| Full producer test suite | [Frozen `9d4f6b3` regression](../coverage/language-expansion/producer-regression-9d4f6b3/README.md): **1,834 passes, six conditional skips, zero failures**; later 24-case iterator check separately retained | Current-head hosted matrix remains **pending**; historical tests are not relabeled as final-head tests |
| Contract generation and reference fixtures | **5/5** contract checks at `012c9fe`; final reference receipt **pending** | Current contract run is being archived with its six-file targeted regression, including its two original timing failures and the subsequent 24/24 passing deadline-test follow-up |
| Independent consumer regression | **244 passes, zero failures/errors/skips** at `39c4036` / `012c9fe`; Ruff checking and formatting passed for 532 Python files | [Current native validation archive](../coverage/language-expansion/native-v8-fit-39c4036/native-validation.tar.xz), independently checked retained JUnit |
| Expansion, interoperability, gallery qualification | **In progress**: 665 / **26** / 11 declared populations | Complete every case and retain exact source/native receipts before marking the full gate passed |
| Exact tokenizer and native packing costs | **In progress** measured/declared coverage | Final serializers, masks, token segments, and summaries pending |
| Split-bound production dataset readmission | **In progress** complete **37-episode** inventory | Regenerated registry, actual example count, exact native inputs and fresh admission pending; old 898-example count is historical |
| Actual native model selection/serving experiment | Current contract: **3/3 fitted training-input**, **0/3 fitted separate-input**, **0/6 baseline** source-qualified completions; two separate four-step diagnostics each **0/2** | [Current result and independent audit](../coverage/language-expansion/native-v8-fit-39c4036/README.md); unavailable 256-step checkpoint bytes remain explicit; [four-step bundles](evidence/semantic-v8-diagnostic-pilot/2026-11-20/README.md) are fully archived |
| Associated PR/check reconciliation | **Pending** final heads and check outcomes | Pending PR/commit links |

External comprehension results, general held-out completed-execution accuracy,
latency/cache benefits, and default promotion remain **unmeasured or
unqualified** unless their own declared studies actually run. Candidate
engineering completion under §10.4 must preserve those dispositions.
