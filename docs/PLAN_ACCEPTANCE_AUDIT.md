# Acceptance audit of the 18 November resumption plan

## Scope and conclusion

This is a read-only acceptance review of the supplied
`tracing-js-self-resumption-plan-2026-11-18.md`, SHA-256
`5e3c7ab5d2e7afbb94ae3725d1c78647a92594ed8265bce6edcb36eabc1ec562`.
The original plan audited producer `55a53c4b884b7d536cfc06220d8838d8cead9236`.
This review inspected the primary checkout at
`bc49b9ef12aae0c1236d4606457ba307390a6c01` and completed evidence available on
18 November 2026, approximately 14:00–14:06 UTC. Later final-package and CI
receipts must be appended to the release ledger rather than assumed here.
Writing this separate report did not change shared source, frozen producer or
consumer checkouts, campaigns, original failures, checkpoints, or model outputs.

**The work establishes a substantially stronger bounded teacher, integrity and
data-production pipeline. It does not satisfy every acceptance criterion in the
plan.** In particular, W10's successful model-generated held-in execution gate
has an actual negative result, and W11 has an exploratory negative comparison
rather than a useful or confirmatory learning result. W12 still lacks the
runner-level isolation and aggregate resource controls requested for untrusted
inputs. Some W03/W06 projection paths remain explicitly unsupported. Final D
batch preparation and the latest F retry/package were still active at this
review's cutoff.

“Implemented” below means code and tests exist. “Measured” identifies an actual
retained run at its stated revision. A test fixture, a controlled selection, an
available command, or an earlier revision's receipt is not promoted into a
current native, model, or release result.

## Work-package acceptance matrix

| Work | Implemented and measured evidence | Acceptance assessment and remaining boundary |
| --- | --- | --- |
| **W01 — current v5 baseline, environment, capability ledger** | [Baseline command](../tools/current-v5-baseline.mjs), [capability index](../coverage/required.json), [measured F ledger](../coverage/current-v5.json), isolated `tools/spec-oracle/package-lock.json`, hashed Python dependency lock, actual native-environment checks, and [release gates](RELEASE_GATES.md). F's unit/fixture log records 858 tests: 853 pass, zero fail, five external-environment skips. F's finite ledger has 43 probes and 32 actual native admissions. | **Met for the declared finite training profile and reporting contract.** Other source profiles and the TypeScript adapter remain explicitly untested in this ladder; all 43 feature-level model stages are untested. The ledger's one independent-outcome failure is the deliberately refused callback-abrupt obligation, not an unexplained admitted wrong label. No full ECMAScript/Test262 or container-image identity is claimed. Final publication CI still needs its own exact-head receipt. |
| **W02 — array defaults and async declarations** | `src/runtime.js` and frontend repairs; [array boundary regressions](../test/training-array-defaults.test.js) compare omitted, undefined, null, NaN, signed zero, infinities, negative, fractional and string bounds with V8, reconstruction and replay. F natively qualifies the three reproduced undefined-end cases and the async-helper declaration probe. | **Met for the reproduced defects and tested bounded cases.** The full scalar-boundary regression matrix is locally differential; the ledger's native rows are the explicit representative probes. Neither evidence set asserts arbitrary built-in compatibility. |
| **W03 — parameter environments, TDZ and closure capture** | [Parameter regressions](../test/training-parameter-environments.test.js) verify body/parameter environment separation, ordered initialization, earlier/later bindings, recursion, aliases and abrupt initialization against independent execution. F natively qualifies the repaired body-scope and ordinary default-closure cases. | **Runtime repairs verified; positive training coverage remains partial.** F's `later-parameter-tdz` executes in the owned runtime but refuses v5 completion projection. `forward-parameter-closure` also executes correctly but refuses an uninitialized captured cell. Their native stages are untested. These are concrete projection work, not sandbox blockers or positive admitted throw labels. |
| **W04 — descriptor semantics** | [Descriptor boundary tests](../test/training-descriptor-boundaries.test.js) and F ledger verify explicit refusal of `Object.create` descriptor arguments and array-index accessor descriptors; omitted/undefined descriptor arguments retain supported behavior. Refusal cannot be hidden by guest `catch`. | **Met through the plan's explicit-refusal option.** Broader descriptors, array accessor invariants and prototypes remain outside the declared profile. Implementing their full semantics is separate feature work; the current behavior no longer silently ignores them. |
| **W05 — immutable single/session identity and split protection** | [Identity contract](ADMISSION_IDENTITY.md), `effectful-admit.js`, `effectful-session.js`, `admission-identity.js`, complete session reconstruction, mandatory producer/native/tokenizer policy, and tamper regressions. [Actual C native preparation](evidence/native-provenance-C-2026-11-18.json) accepts two unchanged controls and refuses all 30 private-metadata mutations with public bytes unchanged. | **Implemented and end-to-end measured at C.** The receipt is C-specific; it is not a fresh F tamper run. Release anchors and source/consumer rechecks remain required. Checksums bind evidence to trusted release identities; they are not signatures authenticating arbitrary caller assertions. Original-source mapping is partial for some adapters, discussed below. |
| **W06 — primitive/declared-Error throws and failure taxonomy** | [Exception profile](DECLARED_EXCEPTION_PROFILE.md), [sync-throw tests](../test/training-synchronous-throws.test.js), structured reference errors, [failure records](../src/training/failure-record.js), original-preserving bounded minimization, callback/unhandled-rejection checks. F admits primitive and explicit declared-Error throws and `finally` replacement cases. | **Met for the declared primitive/Error/TypeError scope; broader paths remain explicit.** Callback failures and unhandled rejections are retained and refused until their completion obligations are supported. Implicit TDZ errors, complete Error descriptors/prototypes/stack/cause/subclasses and broader lifecycle errors are not qualified. An outer worker timeout retains less detail than a completed structured failure because the killed worker returns no partial archive. |
| **W07 — real-source bridge into native v5 releases** | [Trusted source adapters](../src/corpus/trusted-source-candidates.mjs), exact pinned bytes/notices, separate original/transformed reference execution, normal teacher/reference/projection/native gates, and [full D analysis](REAL_SOURCE_D_QUALIFICATION.md). D attempts 1,171 and admits 987; all 184 other outcomes are retained. E separately qualifies twelve capture-fix inputs; F's initial 60-case requalification admits 58 with two timeouts. | **Bridge and fresh candidate admission demonstrated. Final full-D prepared release was pending.** Local flags never substitute for native receipts. The two canonical integer-precision refusals, later consumer fixes and F improvements do not rewrite D. Unsupported inputs and all original failures remain auditable. A qualified pool is not automatically a balanced or deduplicated training corpus. |
| **W08 — global ancestry/clone registry, expanded inputs and held-out families** | [Registry](../src/corpus/source-registry.mjs), [freeze tool](../tools/freeze-source-registry.mjs), clone/ancestry/holdout tests, bounded generated programs and [execution difficulty](../src/corpus/execution-difficulty.mjs). One frozen registry covers 508 variants, 199 declared families and 135 conservative components, split 89/13/33. The Exercism project and a generated composition are held out before input expansion. An actual eight-component test cohort is disjoint from the actual training inventory. | **Met for the bounded registry/isolation mechanism and exploratory cohort; intended scale and coverage remain partial.** The plan's proposed 100–300 training components and roughly 100 held-out families are not achieved. Components are conservative clone/ancestor groups, not proof of algorithmic independence or absence from pretraining. Seeded boundary inputs and existing executed-path novelty selection meet part of the coverage objective; an adaptive feedback algorithm is not explicitly required by the plan. The later [native cost report](NATIVE_CONTEXT_COSTS.md) measures actual window tokens and context event/facet membership, while full lexical context remains undefined/unmeasured for this recurrent model. |
| **W09 — wider native CI and durable artifacts** | [Native workflow](../.github/workflows/megatoken-consumer.yml) has engineering/training-v4/benchmark-v1 matrix jobs, exact pins, full source/native preparation and complete artifact paths. D's engineering/training qualify 25/25 and 50/50; [benchmark recovery](evidence/baseline-recovery-D-2026-11-18.json) reaches 128/128 while preserving its original timeout/cancelled attempt. D generated programs qualify 64/64; their verified release contains 61 native-prepared examples after native deduplication. | **Workflow and broader native qualification demonstrated.** The originally timed-out baseline is not relabeled as a passing invocation. Final exact-head CI, final full-D batch counts and final F retry/package evidence were pending. Ninety-day CI retention is useful but does not itself provide indefinite release durability. |
| **W10 — actual tiny optimization/checkpoint/rollout smoke** | [Full-pass receipts](receipts/optimization-full-epoch-2026-11-18/README.md) show 49 optimizer updates consuming all 32 prepared members/29 families and 9,379 generated lexical targets. Intended masks, nonzero gradients/updates, exact initial/reloaded/served tensor bindings, original model bytes and first failures are retained. The actual run takes 636.95 seconds inside its declared 900-second limit. | **Executed; acceptance failed empirically.** Baseline and trained models each complete 0/4 held-in tasks. The model did not pass the plan's complete-execution criterion without injected selections. This is a bounded newly initialized diagnostic, not qualified production SE/SC training. Successful parameter updates do not close W10. |
| **W11 — held-out training comparison** | [Comparator](LEARNING_COMPARISON.md) binds actual artifacts, native cohorts, complete task/gate/cost records, prepared training components, optimizer budget/seed identities and predeclared thresholds; it reports family/episode/component scores and paired component/seed uncertainty. [Actual exploratory evidence](receipts/exploratory-heldout-2026-11-18/summary.json) freezes eight test families/components before inference and measures base 0/8 versus trained 0/8 at one optimizer seed. A retrospective audit preserves all original bytes and confirms exact training inventory/bundle bindings. | **Exploratory comparison executed; useful/confirmatory learning acceptance is unmet.** There is no improvement, three-seed confirmation, qualified production launch, useful pretrained baseline, or complete evaluation matrix. The smaller diagnostic is allowed exploratory evidence under the plan; it cannot become a positive production result by passing analysis tests. |
| **W12 — resumable generation and measured cost** | [Campaign store](../src/corpus/campaign-store.mjs), bounded worker groups, cancellation, immutable receipt cache, source/input/fixture CAS, compressed private records and streamed preparation. Actual C and D benchmark interruptions recover with original attempts retained. [Storage/cap selection receipt](evidence/semantic-v5/corpus-storage-and-selection-2026-11-18.json) and [bounded timeout review](BOUNDED_TIMEOUT_RECOVERY_F.md) contain actual costs and integrity checks. | **Durable collection/recovery and bounded wall/output/heap measurements demonstrated; the full operational scope is partial.** No hard aggregate process-tree CPU/RSS quota or qualified ordinary-worker OS isolation exists. Worker RSS excludes reference/native descendants; null killed-worker RSS is unmeasured. Four D timeouts have static step-budget exclusions; two fresh F attempts still time out at 240 seconds. The exact runtime/projection bottleneck was not measured. |
| **W13 — evidence-led language expansion** | Actual refusals led to dense `Array.some`/`forEach`, sparse input-array `fill`, scalar `Number` projection, canonical input/output-binding corrections, immutable native graph replay and captured source-binding validation. F natively qualifies representative added features and all twelve darts inputs. [Refusal triage](REAL_SOURCE_REFUSAL_TRIAGE.md), [precision evidence](CANONICAL_INPUT_PRECISION.md), and [capture fix](NATIVE_CAPTURE_BINDING_FIX.md) retain original failures. | **Selected useful coverage gains demonstrated; the literal whole ladder is not complete through model evaluation.** All feature-level model stages remain untested. Learner failures are presently invalid first actions, not evidence for arbitrary further language expansion. Full Unicode source-identifier parity, sparse/async callback generality, BigInt construction, RegExp, classes/generators and broad host compatibility are not claimed. |
| **W14 — release gates, maintenance, licenses and durable audit** | [Release gates](RELEASE_GATES.md), [read-only branch triage](BRANCH_TRIAGE_2026_11_18.md), isolated oracle lock, current navigation, full private packaging, retained source notices, archive/member hashes, [split-archive reconstruction](ARCHIVE_PARTS.md), historical v4 preservation and source-revision-aware selection. No branches/issues/protection settings were changed by the triage. | **Implemented and partly delivered; final release closeout remained pending.** Completed C/model audit archives and smaller prepared releases exist, but final D/F package verification, durable delivery links and final exact-head CI need their own completion receipts. Public redistribution requires an owner-selected license policy. Issue #13's still-open metadata does not mean the oracle-lock implementation is absent. |

## Denominators that must remain separate

The [D qualification analysis](REAL_SOURCE_D_QUALIFICATION.md) is a census of
attempted candidates, not a prepared training set. It records 936 utility,
201 active canonical Exercism and 34 production-helper attempts. Their admitted
counts are 924, 44 and 19, respectively. Across streams, the 987 admissions
cover 89 declared families, 32 frozen components, 372 executed path signatures
and 841,533 actual native generated tokens. Eight end in a thrown completion;
none of these real-source rows exercises an await. Authored async/effect rows
therefore remain a distinct necessary curriculum contribution.

Exact-public representative selection reduces those 987 candidate admissions
to **965 public representatives plus 22 retained aliases**. The independent
native equivalence check compares full native episode dictionaries, removing
only `lineage.task_id`; it is not merely a public-byte comparison. The original
184 non-admissions remain in the source campaign. Native batch preparation can
deduplicate further, so 965 is not a promised final prepared count.

The twelve E capture admissions similarly yield four exact-public streams and
two native-prepared examples in the retained selection/package receipt. D's
64 generated admissions yield 61 prepared examples. These distinctions are
evidence of explicit selection and native deduplication, not lost refusals or
permission to count aliases as independent training exposure. See
[native preparation selection](NATIVE_PREPARATION_SELECTION.md).

The initial F requalification's 58 admissions include all twelve utility
`distinct` inputs and all twelve darts inputs. Its two timed-out knapsack
inputs are different from the two much larger D knapsack timeouts in the
separate [bounded recovery review](BOUNDED_TIMEOUT_RECOVERY_F.md). A running F
retry must not be counted as completed, and any later success leaves the
initial timed-out receipts intact.

## Balance is demonstrated on a small selection, not the full release

There is actual balancing evidence, not just an unused selector:

- The frozen C engineering campaign has 25 native-admitted rows. A selection
  with a **500-native-token component cap** and **25% maximum training-token
  share** retains 15 rows and excludes ten by training budget.
- Its training portion has nine rows, nine families and nine components,
  totaling 2,439 native generated tokens. The largest component contributes
  431 tokens, **17.671%**. The two validation and four test rows are unchanged;
  their tokens do not subsidize a training share.
- The receipt checks the counts against each actual native admission. Its
  separate package-equivalence experiments concern the complete 25-row
  engineering corpus, not a native-prepared release of the 15-row capped view.

These facts are recorded in the
[storage and selection receipt](evidence/semantic-v5/corpus-storage-and-selection-2026-11-18.json).
The full D qualification census is deliberately uncapped: its two largest
training components contribute approximately **44.17% and 25.33%** of original
training generated tokens. Exact-public alias removal does not by itself make
that pool balanced. No final post-preparation capped D training release was
available at this audit cutoff.

The feasible next step is a separately declared component/token selection and
report on the retained full-D evidence, followed by reconciliation against the
actual prepared rows and exposure. Native deduplication can change the
denominator, so a cap verified before preparation must not automatically be
claimed for the resulting training stream. Retain validation/test membership,
every excluded identity and reason, the full source campaign, and the cap
policy. A metadata-only cap analysis is useful while avoiding duplicate large
exports; it is still an analysis until the resulting training selection and
prepared exposure have been bound.

## Remaining criteria by cause

### Empirical negative results

W10 and the useful-learning part of W11 remain open because actual free-running
executions fail, not because optimization was merely unattempted. The final
49-update diagnostic changes the intended parameters, yet both arms score
0/4 held-in and 0/8 held-out. No practical-improvement or uncertainty gate can
pass on that evidence. The original invalid first actions, decoder token costs
and cleanup/gate observations remain available for diagnosis. No additional
model runs were performed for this audit.

Two original D timeout candidates received one fresh F attempt each at the
authorized 240-second ceiling and again timed out. Four others were not
relaunched after frozen-compiler lower bounds proved that normal completion
needs 45,760, 618,750, 21,978 and 219,978 steps, respectively, above the unchanged
20,000-step limit. The complete review takes 533.298 seconds. Static exclusions
are separate from actual worker results; no hypothetical step-limit exception
or semantic mismatch is invented.

### Missing assets or unavailable runner capabilities

Qualified production SE/SC training still needs compatible preceding/same-stage
checkpoint assets, required ordered donor profiles, hindsight/coordinator
inputs and complete experiment identities. The newly initialized diagnostic
checkpoint is not a substitute for those launch qualifications. GPU compute is
not available in this environment; this limited scale and throughput, but it
did not prevent the completed CPU experiment and is not proof that all possible
CPU confirmation is impossible.

The ordinary collector has no qualified OS isolation boundary for arbitrary
untrusted programs, and the workspace does not supply the delegated process-tree
CPU/memory controls needed for hard aggregate quotas. The documented namespace
and local browser launch attempts failed. Trusted-source restrictions must
remain; the existing external real-browser CI is a valid alternative for its
own explicitly reported gate. No broad browser impossibility or full process
sandbox is inferred.

Public corpus redistribution is an owner/policy decision. Exact upstream notices
are retained, but `repository-fixture` is provenance, not a repository/data SPDX
license. This does not block retaining private evidence or publishing the
authorized code changes.

### Bounded profile and feasible implementation work

The following are concrete remaining work, not all environmental blockers:

- Complete the source-grounded v5 projection for implicit TDZ throws and
  closures created before a captured parameter initializes, then rerun the
  whole native ladder on those exact cases.
- The later [native cost report](NATIVE_CONTEXT_COSTS.md) resolves the feasible
  cost-measurement portion for the actual 49-window diagnostic: maximum ingested
  window 5,089 tokenizer tokens; maximum generated-reader history 84 native
  events / 336 facet slots; maximum prepared-text contribution 5,083 token IDs.
  These exact artifact-bound quantities do not fill the producer's
  `maxModelContextTokens: null`: sampled metadata bytes were not saved and
  latent recurrent state has no measured flat lexical equivalent. Other runs
  still require their own exact tokenizer/history measurements.
- Improve provenance mapping where needed. Exercism transformations retain
  conservative unchanged-span maps; utility transformations and production
  extraction retain exact bytes/metadata/spans but do not establish a complete
  original-source coordinate map for every generated site.
- Demonstrate incremental uncovered-path gains from additional supported input
  generation. Original §5 says, “Use input generation to reach uncovered paths
  and challenging boundaries.” It does not specifically require an adaptive
  algorithm. Existing [executed-path novelty selection](../src/corpus/coverage-selection.mjs)
  retains new paths among already verified candidates (the original plan records
  28 paths across seven families); seeded grammar and explicit edge inputs also
  satisfy portions of this objective. A feedback-directed generator would be an
  optional implementation, not an extra acceptance criterion inferred from the
  word “uncovered.” A narrow next increment can freeze a small boundary-input
  extension for known uncovered supported sites and measure added executed paths
  under the same ancestry and admission gates.
- Extend the capability ladder to the other declared source profiles and
  TypeScript adapter with their own denominators. Existing separate regression
  suites cannot fill unexecuted native/model stages automatically.
- Expand Test262 only with the required harness, strict/module/async and
  expected-negative semantics. The retained scalar slice is eight files,
  six passing non-strict variants, two unsupported variants, eight omitted
  strict variants and sixteen executed assertions. It is not full conformance.
- Before stronger learning claims, add the unmeasured evaluation slices:
  new-project transfer, new feature compositions, controlled observation/schedule
  changes, longer runs/heaps and pure code/input-to-output transfer. A source
  holdout declaration is not a measurement of model transfer on that holdout.

Broader language/host features are deliberately deferred profile work. The plan
itself calls for prioritizing them from qualified workload exclusions and
learner errors. Their omission need not block a truthful bounded release, but
must not be summarized as completed full JavaScript support.

## Recommended release closeout order

1. Finish the active D native preparation and F retry/package. Preserve all
   original attempts, confirm exact source/consumer/environment identities,
   verify every archived member, and record actual prepared counts. Do not
   substitute anticipated totals or historical producer revisions.
2. Publish a separate full-D component-cap analysis/selection and reconcile it
   against final native deduplication before calling the release balanced for
   training. Keep the unbalanced qualification census available for audit.
3. Update the main handover to F's **43-probe/32-native-pass** capability result
   and the measured D benchmark recovery. Record final exact-head CI and durable
   artifact locations separately. The old C tamper receipt remains correctly
   scoped; rerun the existing gate if fresh F tamper qualification is claimed.
4. Keep W10 explicitly failed and W11 exploratory/negative. Inspect the retained
   first-action failures before increasing scale or changing the production
   v5 format. A qualified next experiment needs a concrete base/configuration,
   frozen threshold/cohort, actual prepared exposure and the required assets.
5. Treat the feasible projection, context-cost, map and coverage items above as
   explicit backlog. Treat runner isolation, missing production assets and
   public-license policy as their distinct dependencies.

This audit does not grant a blanket “all W01–W14 complete” status. It supports a
reproducible bounded engineering/data release with substantial measured
improvements, retained negative results, and a specific remaining learning and
operations agenda.
