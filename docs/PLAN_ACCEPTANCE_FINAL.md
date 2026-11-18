# Final acceptance review of the integrated resumption work

The original review cutoff below is preserved. The [subsequent I qualification
and completed hosted CI](#subsequent-i-qualification-and-completed-hosted-ci)
section records the later 945-test qualification, completed delivery and all
eight successful hosted workflows; earlier pending closeout items are historical.

## Scope and conclusion

This read-only review updates the unchanged [initial audit](PLAN_ACCEPTANCE_AUDIT.md)
and [D/F/G cutoff update](PLAN_ACCEPTANCE_UPDATE_G.md). It inspected integrated
files and published follow-up receipts at
`d15ddca47854ebdb92b23598dd720ccd1a18c822`, available at
**18 November 2026, 15:10 UTC**. The qualified semantic producer is H,
`881664b98ec9d484f9f4775d0b40a3a2b1b81174`, with native consumer
`6b4382b9af3bef120ca3a95ae24d35154d4cd66b`. Later documentation and historical
reader fixes have their own commits; they do not change the pins on H or earlier
corpus/model receipts. No full suite, optimization or inference was repeated by
this acceptance review.

**The bounded semantic repairs, native data release, materialized balanced
subset, resumable collection and reference-isolation work have substantial
completed evidence. Learned execution is still unsuccessful.** W10's complete
held-in execution criterion fails empirically; W11 has reproducible exploratory
negative comparisons. This review does not declare all W01–W14 complete.

## Current measured gates and releases

| Evidence | Actual result and scope |
| --- | --- |
| [H unit/reference qualification](evidence/qualification-H-2026-11-18.json) | **937 tests: 932 pass, zero fail, five external served-model skips**, plus all eight reference-fixture scenarios. The failed G stale-expectation run remains historical evidence. |
| H finite capability ladder | **49 probes; 40 actual native admissions; zero native failures.** Eight unsupported probes and one callback-abrupt reference refusal stop earlier. All 49 feature-level model-evaluation stages remain untested. |
| H repaired probes | Later-parameter TDZ, bounded forward-parameter closure and synchronous-root async-helper rejection all have actual retained native-positive receipts. The earlier projection/replay gaps are closed for those declared cases. |
| H Linux namespace boundary | Direct filesystem/network/process confinement and isolated original/instrumented source execution with identity binding **actually pass on this host**. H's capability run separately declares `trusted-process`; its receipts are not relabeled as isolated. |
| [Merged Python boundaries](evidence/python-boundary-regressions-H-2026-11-18.json) | **141 pass; six optional artifact-dependent skips.** The separate [H-validator actual-artifact follow-up](evidence/actual-artifact-regressions-H-2026-11-18.json) passes **14/14 with zero skips**, including all six conditional cases, using original C model bytes and original consumer `277edd4`. No inference or optimization occurs. The [earlier 14/14 receipt](evidence/actual-artifact-regressions-2026-11-18.json) also remains unchanged. |
| [Native coordinator follow-up](evidence/native-orchestration-H-2026-11-18.json) | **All five originally skipped tests pass with zero skips in 67.271 seconds.** Independent native validation confirms two controlled completions, two controlled expected refusals and one actual initialized-weight expected refusal. Initialized weights remain unchanged; zero optimizer steps and no learned-success claim. |
| [D full native release](evidence/semantic-v5/real-source-prepared-release-D-2026-11-18.json) | Original **1,171 attempts → 987 admissions + 184 retained non-admissions**; 22 exact-public aliases leave 965 representatives; **965/965 re-admitted → 541 accepted + 424 native duplicates**, zero refusals. Archive verified and durably saved. |
| [D capped native subset](evidence/semantic-v5/real-source-native-capped-release-D-2026-11-18.json) | **211 materialized native rows: 132 train, 27 validation, 52 test.** All 79 accepted evaluation rows remain unchanged. The declared 10,000-token/component and 20% training-share caps produce an actual maximum share of **7.17453%**. Archive verified and durably saved; zero optimizer steps on this subset. |
| F requalification package | **60 admissions → 52 exact-public representatives → 22 native accepted + 30 native duplicates.** Original timeouts and the two successful serial retries remain separate evidence. Package verified and durably saved; F overlaps D and its rows must not simply be added to D's count. |

The D accepted training inventory has 21 conservative components; its test
inventory has nine. Declared families, aliases, native duplicates and repeated
inputs do not increase those independence denominators. The uncapped D census
and the capped prepared subset remain separate artifacts with complete audit
ancestry. Later sampling weights or repetition require fresh exposure accounting.

The original full-suite logs keep their five coordinator and six artifact skips;
the separate successful follow-ups close those conditional checks without
rewriting their initial denominators. The actual initialized-weight coordinator
refusal is infrastructure evidence, not feature-level model qualification. Final
supplemental archive packing and the last delivery/CI index remain pending
closeout items at this cutoff, not absent implementation.

## W01–W14 acceptance checklist

| Work | Current assessment | Remaining boundary |
| --- | --- | --- |
| **W01 — baseline/environment/ledger** | Reproducible command, exact release policy and locks, current H denominators and raw native receipts are measured. | Other source profiles and feature-level model stages need their own evidence. Final publication CI must name its actual head. |
| **W02 — array defaults/async flags** | Reproduced array-boundary repairs and authenticated async-helper replay pass their declared local/native gates. | Representative probes do not claim arbitrary built-in compatibility. |
| **W03 — parameter scope/TDZ/capture** | Parameter/body scope, ordered initialization, authentic TDZ completion and bounded delayed capture are implemented; the repaired H probes are natively admitted. | Early closure calls/escapes, unresolved captures and operations outside the conservative deferral region remain explicit profile refusals. |
| **W04 — descriptors** | Legal supported descriptor updates preserve invariants; unowned getter observation and unsupported descriptor combinations fail explicitly. | `Object.create` descriptors and array-index accessors remain outside the bounded profile. The plan permits explicit refusal. |
| **W05 — immutable identity** | Single/session identity, split/ancestry/provenance reconstruction and mandatory native pins are implemented. Actual C native tampering rejects all 30 mutations while accepting both controls. | That native tamper receipt retains its C pin. Checksums need trusted release anchors and source/native rechecks; they are not arbitrary-caller authentication. |
| **W06 — exceptions/failures** | Primitive and declared-error completion, general genuine `GuestFault` leaves, synchronous host-rejection routing and bounded implicit errors are implemented with separate internal/resource failure paths. | Callback-abrupt and unhandled-rejection obligations, richer Error descriptors/prototypes/stack/cause/subclasses and unsupported coercion stay explicit. |
| **W07 — real-source bridge** | Full pinned-source D census/preparation and F repaired-family package demonstrate actual native admission with every original refusal retained. | Unsupported source features and precision-unsafe cases are not promoted into positive labels. |
| **W08 — registry/diversity/holdout** | Global clone/ancestor components remain within frozen splits; independent evaluation membership and actual component-capped native data exist. | Proposed larger diversity targets are not reached. Public-source holdouts do not prove pretraining cleanliness. |
| **W09 — native CI/durability** | Engineering, training-v4, benchmark-v1 and wider source recipes have full-gate workflows and retained actual results; completed archives survive CI retention. | Final exact-head CI and supplemental delivery inventory need their final receipts. Earlier failed invocations remain unchanged. |
| **W10 — optimization/held-in rollout** | Actual masks, gradients, parameter updates, full C source exposure and exact reloads are measured. | **Acceptance fails: both base and trained C models complete 0/4 held-in tasks.** A working optimizer is insufficient. |
| **W11 — transfer comparison** | Strict qualified comparison tooling and separate frozen exploratory selected-execution/source-only endpoints are implemented and actually exercised. | All measured comparisons below are negative. Production assets, a useful base, multiple seeds and wider measured transfer are still needed for stronger claims. |
| **W12 — resumability/cost/operation** | Interrupted campaigns resume with bound receipts; storage and native-window/context costs are measured; optional Linux reference confinement now actually passes. | Whole-pipeline untrusted-input isolation and aggregate process-tree CPU/RSS quotas are separate, unresolved operational scope. |
| **W13 — evidence-led features** | Refusals drove supported callbacks/fill, primitive `Number`/`BigInt`/`String`, canonical bindings, capture validation, legal descriptors and genuine implicit-error projection. | General language support is not claimed. Feature-specific model-success stages remain untested; arbitrary expansion is not justified by first-action learner failures. |
| **W14 — release/maintenance** | Source notices, release gates, read-only branch triage, complete archives and historical-format recovery paths are implemented. | Finish supplemental delivery indexing and exact final CI. Public redistribution needs an explicit owner-selected license policy. |

Primitive conversions, general genuine guest faults, the declared descriptor
behavior and the source-only transfer adapter must **not** remain listed as
wholly unimplemented after integration. Their bounded scope and unsuccessful
model results still matter. See [the exception profile](DECLARED_EXCEPTION_PROFILE.md),
[reference isolation](REFERENCE_ISOLATION.md) and [learning pilot](LEARNING_PILOT.md).

## Keep the actual learning experiments separate

| Experiment | Actual training exposure | Actual evaluation |
| --- | --- | --- |
| [C complete prepared epoch](receipts/optimization-full-epoch-2026-11-18/summary.json) | **49 updates; all 32 prepared members/29 declared families; 9,379 supervised lexical targets.** Exact native plan/cursor and checkpoint/served bindings pass. | Base **0/4**, trained **0/4** held-in. The separate [eight-component cohort](receipts/exploratory-heldout-2026-11-18/summary.json) gives base **0/8**, trained **0/8**. One optimizer seed. |
| [Parallel main pilot](receipts/learning-pilot-2026-11-18/README.md) | **64 updates, but only five of 32 prepared sources sampled; 1,743 targets.** Validation selects step 16, which has sampled two sources/416 targets. | Base/final model **0/4** held-in; base/selected step-16 model **0/3** held-out across **one component**. One optimizer seed; all validation executions fail. |
| [Parallel source-only endpoint](receipts/learning-pilot-2026-11-18/pure-output-source-only-comparison-main.json) | Reuses that separately selected pilot checkpoint; no extra optimizer exposure is inferred. | Base **0/1**, trained **0/1** across one component. Both original generated payloads fail the independent outcome-JSON check. |

These rows are not additional optimizer seeds of one experiment. Their datasets,
selection rules, exposure and endpoints differ. Zero family-weighted improvement
and a one-component bootstrap interval of `[0,0]` do not provide useful or tight
population evidence. Zero integrity/cleanup counters describe the observed
refusal paths; they do not establish learned effects, errors or cleanup.

The immediate learning task is to diagnose the preserved first invalid actions
and establish successful complete held-in execution. More scale, a different
machine or passing analysis tests cannot be described as a demonstrated remedy.
Original checkpoints, emissions, failed attempts and retrospective audits remain
available; this review adds no model run.

## Genuine remaining handover items

- **Qualified production assets:** eligible preceding-stage or same-stage base;
  ordered pinned donors, checksummed hindsight targets, coordinator/worker
  ancestry and engineering/cohort identities; actual required train/validation
  behavior supply. The newly initialized P1 diagnostics cannot be renamed into
  production SE/SC qualification. Exact missing prerequisites are retained in
  [the optimization handover](OPTIMIZATION_HANDOVER.md).
- **Useful and confirmatory learning:** actual positive execution performance,
  a predeclared practical threshold, at least three planned optimizer seeds for
  confirmation, and meaningful frozen test components. The plan's 5,000–20,000
  episodes, 100–300 training components and roughly 100 held-out families are
  proposed profiling targets, not a guaranteed statistical sufficiency rule.
- **Remaining evaluation scope:** measure the untested portions of new-project,
  composition, known-source new-input, observation/schedule, long-run/heap and
  pure-output transfer. A source-only adapter and one negative pure task now
  exist; they are not a completed broad transfer matrix. Effects/error/cleanup
  slices must have actual positive eligible tasks and complete gates before a
  broad no-regression claim.
- **Operational scope:** Linux namespaces/seccomp and kernel limits now qualify
  the independent reference boundary on this host. Default operation remains
  trusted-source; acquisition, owned teacher and native consumer do not thereby
  accept arbitrary untrusted code. Per-reference CPU/address-space limits and
  observed worker RSS are not aggregate process-tree quotas. Production GPU
  fit/throughput remains unmeasured in this CPU-only environment.
- **Bounded coverage and provenance:** retain exact bytes/notices and honest
  partial coordinate maps; extend other source profiles and conformance slices
  only with their actual harness and denominators. Original §5 asks input
  generation to reach uncovered paths and boundaries. Existing verified novelty
  selection/seeded boundaries satisfy portions; an adaptive algorithm is not an
  additional requirement invented by this review.
- **Historical recovery and delivery:** use immutable snapshots and the exact
  producing reader/verifier for legacy graph-sensitive journals. The current
  [selection runbook](NATIVE_PREPARATION_SELECTION.md) preserves shared locks,
  source/native checks and original graph commitments without rewriting them.
  Actual F snapshot verification checks all 60 existing admission bindings;
  it is not a new admission or a migration of the frozen campaign. Finish the
  supplemental archive and final delivery/CI index without modifying old pins.

The remaining learning negatives are empirical outcomes; production assets and
whole-pipeline resource isolation are distinct dependencies; supported-profile
refusals are explicit scope choices. Keeping those causes separate is the
remaining acceptance boundary for a truthful bounded engineering/data release.

## Delivery closeout after this review's cutoff

The statements above retain the 15:10 UTC review cutoff. The subsequent
[supplemental audit release](VERIFICATION_AUDIT_SUPPLEMENT.md) is now fully
verified and durably saved: 67,052,493 bytes, 825 archive members, SHA-256
`fab00bb4ec0a30bc8dbf086ac1705d5def9611523516462a5b2ad2ee594170e5`.
It includes the complete H payloads and the separately pinned
[fresh CI alias-routing diagnostic](evidence/ci-real-source-alias-routing-2026-11-18.json).
All twelve completed archives are saved across nineteen binary delivery files;
the private download index supplies their exact links, hashes and reassembly
instructions. This closes the supplemental-delivery item in W09/W14 without
changing any historical experiment, native denominator or learning conclusion.
The [consolidated handover](RESUMPTION_HANDOVER.md) records hosted CI separately
at its observed revision; cancelled and pending workflows are not passes.

## Subsequent I qualification and completed hosted CI

The late upstream capture-alias correction and paired consumer revision have
their own [complete I receipt](evidence/qualification-I-2026-11-18.json): producer
`c2a64424d052f9b90a340a59a8d74cf5564e47aa`, consumer
`6e27a7c6529aa0778c5ea818432461db7cd05ea7`. All 945 unit tests execute and pass
with zero skips, along with eight reference fixtures and five independently
validated coordinator cases. The fresh finite native ladder passes all forty
attempted admissions from 49 probes. The two Python suites pass 56 and 85 tests;
the separate original-C/original-277 run passes all fourteen artifact checks.
The original H and C model bytes remain unchanged.

The canonical integration v2 receipt also records temporary Python test-fixture
initialization and two parameter-sum optimizer updates **per fixture**, with
aggregate counts uninstrumented. An additive clarification corrects H's
overbroad global zero-update field while preserving its original receipt. These
unit fixtures neither constitute a new semantic-learning experiment nor alter
the negative learning conclusions above.

The [I audit archive](QUALIFICATION_I_AUDIT_ARCHIVE.md) is verified and saved;
delivery now comprises thirteen complete archives across twenty binary files.
At the 16:09:26 UTC cutoff, [all eight hosted workflows](evidence/hosted-ci-057e39b-2026-11-18.json)
for head `057e39b4176914f8c3c74967af2491a268b93a53` pass, including all five
native lanes with consumer `6e27a7c…` and all three Node versions. There are
22 successful jobs, one explicit conditional acquisition skip and zero failed
or pending jobs in that frozen run set. Default merge checkout and explicit
head have the same tree; their distinct commit identities remain recorded.
This closes the final delivery/CI items from the earlier review cutoff, without
promoting W10/W11 or the larger diversity/production targets to success.
