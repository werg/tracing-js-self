# Language coverage engineering completion ledger

**Engineering qualification completed, 20 November 2026. V6 remains the
production default. Final branch checks are tracked separately in the two PRs.**

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

## Completed engineering work, hardest first

The implementation, source/native qualification, exact costs, dataset readmission,
and bounded real-model experiments are retained at explicit revisions. Later
changes update tests, documentation and evidence; they do not relabel older runs.
The workstreams below are ranked by implementation and qualification difficulty.

| Workstream | Completed result | Evidence limit |
| --- | --- | --- |
| 1 — Live selected execution and independent native serving | Public APIs, exact entry/state/cutoff checks, frozen generation settings, original emitted bytes/tokens, full acknowledgements, deferred-observation ingestion, callbacks, cancellation and private source scoring are integrated. All five optional native coordinator gates on the existing compact selected-execution path passed an isolated run with the original bounds: four controlled engineering cases and one actual initialized-model rejection. | [The original full run](../coverage/language-expansion/producer-regression-012c9fe/README.md) remains failed. [The isolated follow-up](../coverage/language-expansion/native-orchestration-isolated-012c9fe/README.md) has its own exact compatible served bundle and explicit substitution provenance. Public completion alone does not establish source correspondence. |
| 2 — Protocol correctness | Current supplementary populations passed 2/2 abrupt Number cases, 12 cleanup positives plus one expected refusal, 16 custom-iterator positives plus four refusals, and 14 flat-binding positives plus three refusals. | These are separate declared inventories that may overlap. General patterns, async iteration and other documented exclusions remain outside the qualified profiles. |
| 3 — Complete population and costs | All 665 expansion, 26 interoperability and 11 original-gallery cases passed source qualification, native admission, exact flat-token measurement and native physical packing. Independent ordinary and streaming meters agree on every physical artifact for all 665 expansion cases. | These finite, overlapping populations do not establish unrestricted ECMAScript conformance, model quality, serving latency or cache savings. |
| 4 — Dataset and reproducibility | All 37 episodes were freshly source/native-admitted after global component split binding: 1,021 complete examples and 33,850 generated tokens including EOS. A second independent export reproduced the complete dataset and all 37 native input/receipt pairs byte for byte. | Both exports represent the same 37 episodes, not a doubled population. They performed zero optimizer steps. |
| 5 — Retained model measurement and audit | Current-contract revalidation of the previously fitted 256-step model, with zero additional optimizer updates, records 3/3 source-qualified completions on its sole training input, 0/3 on a separate input of the same program, and 0/6 for the zero-update baseline. Two separate four-step diagnostics each completed 0/2 executions. | External comprehension and general held-out usefulness remain unqualified. The historical 43 MB fitted/checkpoint archive has no published retrieval location; the independent audit verifies retained output and source scoring, without repeating neural inference from that archive. |
| 6 — Regression, contracts and reconciliation | The updated-code Node 20/22/24 matrix passed. The retained Node 24 job has 1,836 passes, eight explicit skips, and no failures/cancellations. The focused native v8 gate passed 244 tests without skips. Contracts, reference checks, profiles, public commands and both PR descriptions are reconciled. | Every result retains its actual tested commit/tree and command. Eight hosted environment-dependent skips are not passes. Final branch checks are tracked in the two PRs and are qualified only by their own observed results. |

The [complete current population packet](../coverage/language-expansion/native-v8-012c9fe-all/README.md),
[production dataset](../coverage/language-expansion/dataset-v8-012c9fe/README.md),
[independent dataset replication](../coverage/language-expansion/dataset-v8-012c9fe-independent/README.md),
and [evidence index](../coverage/language-expansion/README.md) contain the full
inputs, dispositions, costs, original failures, checksums and reproduction commands.

The [independent completion audit](../coverage/language-expansion/completion-audit-6423989/README.md)
rechecks the integrated archives, receipt bindings, masks and complete cost
accounting without repeating native execution or tokenizer encoding. Its
separate fresh local regression passed **1,838 tests with six explicit skips**
and all reference/contract checks; the receipt explains the unchanged executable
inputs across the concurrent documentation/evidence integration.

## Outside this PR: research and default promotion

The candidate-shipping scope in §10.4 excludes the following work from this
PR's completion checklist. These evidence gaps remain recorded and are not
counted as successful qualifications:

- External-model comprehension and a powered notation comparison: no external
  responses exist for the 228-task declaration.
- General held-out-program/family execution and controlled comparisons of
  token cost, latency or cache reuse at matched usefulness: the bounded
  diagnostics do not supply those studies.
- Regenerating the historical 256-step model experiment from its original
  weights: its 43 MB checkpoint archive has no published retrieval location.
  Retained-output decoding and private source scoring remain independently
  verifiable within their documented scope.
- Unrestricted language profiles outside the bounded coverage matrix, including
  async iteration, unrestricted coercion/Proxy/construction/Promise assimilation,
  arbitrary host/DOM behavior, dynamic evaluation, GC observability and
  cross-agent memory.
- M7 coordinated default promotion: **not performed; v6 remains the default**.

These exclusions do not waive correctness, native admission, exact evidence or
explicit refusal accounting for any supported candidate slice.

## Plan milestone mapping

| Plan milestone | Delivered candidate scope | Remaining boundary |
| --- | --- | --- |
| M0 — Current baseline | Frozen family, interaction, real-source, and unchanged gallery inventories; exact old source/native/token reports; per-attempt dispositions and split provenance. The current clean pair is producer `012c9fe` / consumer `39c4036`. | All declared current populations and the dataset passed. Only 27 of 78 available real-source functions belong to the declared real-source slice; the other 51 remain outside this population. |
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

| Required evidence | Current candidate evidence |
| --- | --- |
| Explicit source/profile/domain | The bounded profile matrix and source adapters define supported inputs, limits and exclusions. Dedicated source suites and native supplements qualify custom iteration, flat iterable declarations and ordinary Number cleanup. |
| Owned execution plus independent evidence | Independent V8 source outcome, operation, branch, completion and protocol observations challenge the producer. All 665/26/11 declared populations passed fresh source and independent native gates at the current pair. |
| Checked concise operation/reading | Canonical codec, shared public state, operation definitions and notation views distinguish compact, detailed and protocol records. All five generated-contract checks passed; the hosted v8 source-bound contract recheck passed for all 26 interoperability cases. |
| Equivalent idioms and distinct near-misses | All 624 reference executions across 26 families × 3 idioms × 8 inputs passed their 208 equivalent-input checks; all 52 distinguishing pairs remained distinct. Protocol supplements additionally check order, identity, abrupt precedence and malformed-state refusal. |
| Fallback, exceptions and limits | Local fallback occurs before commitment. Unsupported profiles refuse explicitly. False claims, stale retries, malformed output, deadline failures and cleanup failures remain visible in original reports. |
| Native, contexts, continuation and masks agree | The focused 244-test native gate, all three complete populations, supplementary profiles and freshly rebound dataset pass their declared independent replay, continuation, source, mask and tokenizer checks. Five real native coordinator gates passed their separately identified isolated follow-up. |
| Real-source coverage and total-token costs | The complete 665-case population includes the declared 27-function real-source slice. All 665/26/11 costs are measured. The matched historical comparison retains all 42 rows and all eight individual flat-cost increases. |
| Understanding/execution measured or explicitly untested | The current bounded native model study and its independent retained-output audit are published. The 228-task comprehension declaration has zero external responses. General held-out usefulness and controlled cost/latency benefits remain unqualified. |

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

## Integrated behavior and scoring limits

The completed implementation adds substantive behavior beyond those historical
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

| Item | Exact identity/result | Receipt |
| --- | --- | --- |
| Producer implementation | `012c9fe49a082319bf98ac0c571596da925741a4`; tree `26454c685a6136ab6d6d18636e6073216ee9d195` | [Complete population qualification](../coverage/language-expansion/native-v8-012c9fe-all/README.md), with clean before/after identities |
| Consumer implementation | `39c4036564428e44cc89caf261f517d856482695`; tree `ca55473db0ed3343ad930833a4ee09ad48bf7caf` | Same exact-pair packet; subsequent native CI/docs changes leave its executable files unchanged |
| Contract, tokenizer and codec | Contract `344f7e99aeed605a1965c70f0e0d8829707d6891437ba43dd743fa304cd777dc`; tokenizer `40fb9d7d7795b8bd305aeff39ce9963f3f450915b9553f2938e009be9a1fed60`; tokenizer/codec identity `7f52faca2fe82273a889023defd2f1a6fd6080a21096ec77e97f4798a0a370b2` | [Independently checked bindings](../coverage/language-expansion/native-v8-fit-39c4036/independent-audit/README.md) and current population/dataset receipts |
| Complete updated producer regression | Node 20/22/24 matrix passed. Retained Node 24: **1,836 passes, eight explicit skips, zero failures/cancellations**, out of 1,844 tests | [Complete hosted log](../coverage/language-expansion/ci-node24-7855394/README.md): PR `7855394` and tested merge `e461fab` have identical entire trees. Later documentation does not change that result's identity. |
| Real native coordinator follow-up | Existing compact selected-execution path: four controlled engineering cases and one actual initialized-model rejection. **5/5 passes, zero failures/cancellations/skips** at `012c9fe` / `39c4036`, with original deadline bounds | [Complete follow-up and served bundle](../coverage/language-expansion/native-orchestration-isolated-012c9fe/README.md). Model weights/configuration/tokenizer match the earlier baseline; checkpoint/transducer differences are explicitly recorded. |
| Original failures remain original | Full zero-skip run at `012c9fe`: **1,840 passes, three failures, one cancellation**. Separate six-file run: **42 passes, one failure, one cancellation** | [Original full run](../coverage/language-expansion/producer-regression-012c9fe/README.md) and [targeted run with subsequent 24/24 test follow-up](../coverage/language-expansion/producer-contract-012c9fe/README.md). Overlapping test counts are never added together. |
| Contracts and reference checks | **5/5** contract checks; **8/8** reference fixtures; **624** reference executions, **208/208** equivalent-input checks and **52/52** distinguishing pairs | [Current contract/reference logs](../coverage/language-expansion/producer-regression-012c9fe/README.md) and [complete reference benchmark packet](../coverage/language-expansion/native-v8-012c9fe-all/README.md) |
| Independent native v8 regression | **244 passes, zero failures/errors/skips**; Ruff checking/formatting passed for 532 Python files; workflow lint, diff check and paired contracts passed | [Retained consumer validation](../coverage/language-expansion/native-v8-012c9fe-all/README.md) at the exact clean pair |
| Complete current populations | **665/665 expansion, 26/26 interoperability, 11/11 gallery**: source/native admission, exact flat costs and native physical packing | [Complete population packet](../coverage/language-expansion/native-v8-012c9fe-all/README.md); each inventory retains its own denominator and may overlap others |
| Supplementary protocol populations | **2/2** abrupt Number; **12 positives + 1 refusal** cleanup; **16 positives + 4 refusals** custom iteration; **14 positives + 3 refusals** flat bindings | [Abrupt Number](../coverage/language-expansion/number-abrupt-012c9fe/README.md), [cleanup](../coverage/language-expansion/number-completion-012c9fe/README.md), [custom iteration](../coverage/language-expansion/custom-iterator-012c9fe/README.md), [flat bindings](../coverage/language-expansion/iterable-binding-012c9fe/README.md) |
| Current expansion coverage/cost | **458 compact-containing**, **207 wholly detailed** episodes; detailed targets are **86.58%** of 247,403 generated tokens. Flat total **8,918,256** includes repeated context and EOS | [Exact serializers, masks, tokens and native packing](../coverage/language-expansion/native-v8-012c9fe-all/README.md); ordinary and streaming physical artifacts agree for all 665 cases |
| Matched historical comparison | **42** identical source/input rows: total flat tokens **13,139,870 → 1,286,652** (90.21% lower); generated **34,554 → 33,132** (4.12% lower). **Eight** rows cost more | Same packet retains every matched row and regression. Most savings concern submitted context. This is not a controlled model-serving efficiency comparison. |
| Split-bound production dataset | **37/37 episodes, 1,021 examples, 34 split-isolated components; 33,850 generated tokens including 1,021 EOS** | [Production dataset](../coverage/language-expansion/dataset-v8-012c9fe/README.md) and [independent byte-identical replication](../coverage/language-expansion/dataset-v8-012c9fe-independent/README.md); zero optimizer steps |
| Actual native model experiment | Current contract: **3/3 fitted training-input**, **0/3 fitted separate-input**, **0/6 baseline** source-qualified completions. Separate four-step diagnostics each **0/2** | [Current result and independent audit](../coverage/language-expansion/native-v8-fit-39c4036/README.md); historical 256-step checkpoint archive remains unavailable. The [four-step fitted bundles](evidence/semantic-v8-diagnostic-pilot/2026-11-20/README.md) are fully archived. |
| Associated PRs and review | Producer [#46](https://github.com/werg/tracing-js-self/pull/46) and consumer [#37](https://github.com/werg/megatoken/pull/37) contain the pushed implementation/evidence and current check links. Base consumer [#36](https://github.com/werg/megatoken/pull/36) is merged. All 71 existing review threads were resolved when checked | The two current PRs remain open. Their live final-head check results remain distinct from the retained immutable run receipts. |

External comprehension, general held-out learned execution, controlled cost per
useful execution, latency/cache benefits and coordinated default promotion
remain **unmeasured or unqualified** by these bounded results. Shipping this
candidate under plan §10.4 preserves those separate research/promotion gates and
all declared profile limits without making them blockers for this PR.
