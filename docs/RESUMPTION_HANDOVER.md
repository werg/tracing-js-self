# Resumption implementation handover — 18 November 2026

**Release closeout in progress:** the complete D collection, native preparation,
consumable capped dataset and F recovery are finished, and their complete
archives are durably saved. The bounded parameter-projection and async replay
repairs are published. Their final qualification, the supplemental verification
archive and current-revision CI are being completed.
Completed implementation increments and compact receipts are committed and
pushed immediately; historical failures remain intact.

The implementation branch is `codex/resumption-20261118`, with current review in
[producer PR #39](https://github.com/werg/tracing-js-self/pull/39).
Parallel producer work was merged through PR #38 at
`0c307781fea0fa3fca58f1dec037c8653cc921e0`; the current reconciliation preserves
both implementations and their original evidence. The reconciled consumer was
merged through [companion PR #31](https://github.com/werg/megatoken/pull/31)
at main `9bf32c3fc794c532444d6a84629bfa29599eb49c`. Its exact qualified policy
pin is `6b4382b9af3bef120ca3a95ae24d35154d4cd66b`. Companion PR #30 was closed
unmerged externally; its frozen `1cee21d…` remains the genuine E/F/G consumer.
Earlier producer PRs #36 and #37 were also merged externally. The per-package
[acceptance audit](PLAN_ACCEPTANCE_AUDIT.md) distinguishes code completion from
measured acceptance; it does not grant a blanket pass to W01–W14.

## Outcome and acceptance

The correctness, provenance, global split registry, real-source admission,
native-consumer integration, durable collection, complete private release
packaging, and actual optimization/evaluation paths are implemented. The
production learner contract remains semantic-execution/5, semantic-trace/5,
semantic-context/5, semantic-continuation/5, and selected-harness/2.

**The proposed learning milestone has not passed.** Actual optimization updates
parameters and consumes the intended generated-token supervision. The final
full-pass diagnostic nevertheless completes zero of four held-in executions;
the baseline and trained model each complete zero of eight held-out executions.
The model's original invalid actions, first failures, checkpoint bytes, masks,
training logs, and serving profiles are retained. These results do not support
an execution-learning or generalization improvement claim.

The plan's 5,000–20,000-episode/100–300-training-component pilot and roughly
100-held-out-family target are not achieved. Repeated inputs, wrappers and
renamed functions are not counted as new independent families. The smaller
actual diagnostic is useful negative evidence with a separate schema; it is
not a production SE/SC experiment.

## Immutable evidence revisions

| Evidence set | Producer | Native consumer | Purpose |
| --- | --- | --- | --- |
| Audited starting point | `55a53c4b884b7d536cfc06220d8838d8cead9236` | `277edd4a2983e81f5e2a71b34a7ce29348e4e7a0` | Original supplied audit. |
| C | `c4296c271eec32c2f2ab4cd34c30fd8b61e6ba39` | `277edd4a2983e81f5e2a71b34a7ce29348e4e7a0` | First broad native campaigns, 30 mutation regressions and actual model experiments. |
| D | `83e0d5742e63dc4439b68d6296f323cb7a3aafdc` | `b88073dcb5a8e438a711d494a5fd592e773798f5` | Corrected runtime/canonical bindings, immutable graph replay, streaming preparation and larger real-source sweep. |
| E | `1b391c19c3c8137d5b00c5412e53614a568b3704` | `1cee21dd07a687b0a824abff1bbd5ef9a13149ab` | Fresh qualification of twelve captured-binding failures. |
| F | `22eaac6a46e262b00986c63b4fc66f6240016252` | `1cee21dd07a687b0a824abff1bbd5ef9a13149ab` | Exact canonical-input precision refusal, primitive Number conversion, 60-case fresh recovery, finite capability ledger and timeout review. |
| G, retained failed unit qualification | `a088ad60028a02e1d595dfc1afe7b6379cd0998a` | `1cee21dd07a687b0a824abff1bbd5ef9a13149ab` | Parameter TDZ, bounded forward closure and async-helper repairs. The full unit run exposes one stale refusal assertion; no native ladder or reference fixture was run after that failure. |

E and F qualify their explicit subsets; neither requalifies every D row.
D's original capture-name refusals remain in D. The initial two-step model
feasibility run predates C and uses producer
`3a2178252a370c3d91c85d42751b2a4f82376bd4`; later model attempts use C. Local tested companion commit `3e3d418…` and published `1cee21d…`
have identical Git trees; the historical component receipt keeps its local
commit identity, and E supplies new receipts at the published identity.

The tokenizer file has SHA-256
`40fb9d7d7795b8bd305aeff39ce9963f3f450915b9553f2938e009be9a1fed60`;
its actual native codec identity is
`7f52faca2fe82273a889023defd2f1a6fd6080a21096ec77e97f4798a0a370b2`.
Release receipts bind exact files and environments. A mutable branch name is
not a substitute for those identities.

## Implemented work and measured scope

### W01–W06: trustworthy teacher and evidence

The baseline command records each check and its logs before continuing. Oracle
dependencies now have an isolated committed npm manifest/lock and install with
`npm ci`; the Python native environment locks 47 packages with hashes. Runtime,
parser, locale, timezone, policy, tokenizer, producer and consumer identities are
recorded. No container-image digest was supplied, so the receipt does not claim
one.

The frozen F capability report measures **43** finite `training-js/1` probes.
**32 reach native admission and all 32 pass**; eleven remain untested at that
stage because an earlier profile/gate stops them. The independent-outcome
column retains one deliberately refused callback-abrupt case. All 43
feature-level model stages and the other source-profile ladders remain
explicitly untested. Separate regression suites do not silently fill those
columns.

F's complete unit run has **858 tests: 853 pass, zero fail, five explicit
external-environment skips**, followed by all eight reference-fixture checks
passing. A fresh D/pinned-engine262 comparison passes 1,958 finite arithmetic
cases with reconstruction and replay. The published Node 20/22/24 matrix passes
at `4011c3c1ff3206bdb8a0ba96478514a9fcabdcf2`, confirming the Node 20 canonical
lexeme compatibility repair. Final-revision CI is recorded separately below.
These are bounded regression and probe populations, not full ECMAScript or
Test262 conformance.

The Python release/evidence regression run passes 67 cases with six
artifact-dependent skips. A separate run with the actual retained final
checkpoint passes all fourteen diagnostic-evidence tests, including those six
artifact-dependent cases, with zero skips. Changed served tokenizer/config,
transducer bank, model version and incomplete actual training inventory are
rejected without altering originals or making new model calls.

Semantic repairs include method-specific omitted/undefined array bounds, async
declaration flags, ordered parameter initialization/TDZ and separate body scope,
default-parameter closure capture, positive primitive and declared Error throws,
and explicit descriptor refusals. The merged main additionally retains genuine
implicit owned error completions, supported ordinary descriptor updates and
bounded primitive String/BigInt conversion. The parameter-specific repair
authenticates prior TDZ state and allows forward capture only across a proven
initialization-only interval. Replay of synchronous entries with async helpers
derives async syntax permission from freshly recompiled and compared source.
The Error profile avoids reading accessors or lazy stack state. The Node 20
canonical-data compatibility fix preserves exact
large integer lexemes without relying on newer JSON reviver context; all twenty
pinned source/canonical records remain exactly equal to D under Node 24.

Single episodes and sessions now bind complete private source/lineage/split,
execution, environment and certification identity. The native producer boundary
requires a release policy. Actual C native preparation accepts two unchanged
controls and rejects all thirty private-metadata mutations while public bytes
remain unchanged. Hashes support integrity relative to trusted release anchors;
they are not signatures proving an arbitrary producer's authenticity.

Evidence: [capability index](../coverage/required.json),
[provenance receipt](evidence/native-provenance-C-2026-11-18.json),
[D arithmetic receipt](evidence/owned-arithmetic-D-2026-11-18.json),
[D Python integration](PYTHON_INTEGRATION_D.md), and
[identity contract](ADMISSION_IDENTITY.md).

### W07–W09: real sources, frozen splits and actual admission

All five source streams share a registry of 508 source variants, 199 declared
families and 135 conservative source/ancestor components. Components split
89/13/33 across train/validation/test. An Exercism project holdout and the
declared generated composition holdout are frozen before input expansion.
Exact/normalized/near-clone and ancestor joins are conservative safeguards, not
proof of semantic independence or absence from a pretrained model's history.

| C campaign | Attempts | Native admissions | Admitted declared families | Admitted components | Native generated tokens |
| --- | ---: | ---: | ---: | ---: | ---: |
| Engineering | 25 | 25 | 20 | 20 | 17,044 |
| training-v4 recipe, v5 output | 50 | 50 | 16 | 16 | 27,807 |
| benchmark-v1 recipe, v5 output | 128 | 128 | 42 | 38 | 270,874 |
| Real-source pilot | 210 | 154 | 79 | 30 | 118,075 |
| Generated programs | 64 | 53 | 15 | 15 | 61,954 |

C totals are 477 attempts, 410 admissions and 67 refusals. The union has 172
declared admitted families, 119 frozen components and 410 distinct public
hashes. The original C benchmark collector was killed after 82 completed rows;
its failed baseline remains unchanged and a recovery receipt records the
successful continuation to 128. Do not relabel that first attempt as successful.

D generated programs pass 64/64 across sixteen declared families/components,
with 77,855 actual native generated tokens. Unchanged native deduplication
retains 61 prepared examples and records three duplicates. D engineering,
training-v4 and benchmark now qualify and prepare 25, 50 and 128 examples,
respectively, with no preparation refusals. Their complete verified archives
are saved.

The original D benchmark wrapper hit its 900-second whole-check budget after
87 admissions and one cancelled case. The exact-identity recovery reuses those
87 receipts and finishes 41 fresh rows, reaching **128/128**. The final journal
contains 129 attempt entries for 128 candidates. The failed original baseline
and pre-resume manifest are preserved. Lifetime verification cost includes the
cancelled attempt; the new baseline option supports an explicitly declared
bounded whole-check budget instead of silently changing it.

The full D real-source campaign is complete:

| Source stream | Attempts | Native admissions | Admitted declared families | Frozen components | Native generated tokens |
| --- | ---: | ---: | ---: | ---: | ---: |
| Pinned utilities | 936 | 924 | 77 | 23 | 816,289 |
| Active canonical Exercism inputs | 201 | 44 | 7 | 7 | 22,716 |
| Production helpers | 34 | 19 | 5 | 2 | 2,528 |
| Union | **1,171** | **987** | **89** | **32** | **841,533** |

Its other 184 dispositions are 48 native capture-name refusals, 107 unsupported
cases, two canonical mismatches, six worker timeouts, twelve projection
refusals and nine source-unsupported cases. Every original disposition remains
in the archive. The 987 admissions cover 372 executed path signatures, 5,958
branch evaluations, 1,883 loop trips, 5,982 mutations, eight throws and maximum
call depth eleven. They include zero awaits; authored async/effect data remains
a separate necessary contribution.

The full resumed collection takes 40.448 minutes in addition to the 1.604-minute
pilot; it reuses sixteen pilot rows. Reported peak JavaScript-worker RSS is
444,862,464 bytes. The complete CAS has 5,312 objects and 83,629,653 bytes.
These JS-worker measurements are not whole-process-tree memory quotas.

There are 965 distinct public traces among the 987 admissions. The selector
retains 965 unchanged representatives and maps 22 exact aliases while keeping
the full 1,171-case audit. An independent adapter comparison verifies equality
of every native Episode field except `lineage.task_id` for all 22 aliases
across sixteen groups. The first selection attempt used the wrong verifier
context and is preserved as a failure; corrected selection explicitly routes
through the immutable D producer at UTC. Native preparation can deduplicate
further, so 965 must not be reported as the final prepared count.

All **965 representatives pass fresh source rechecking and native admission**.
The unchanged native duplicate policy retains **541 prepared examples**, records
**424 duplicates**, and introduces zero refusals or quarantines. Its split is
462 train, 27 validation and 52 test, with 546,670 generated/scored tokens in
total. Complete preparation, packaging and member verification take 2,055.309
seconds; peak packager Python RSS is 446,980,096 bytes. The separate descendant
resource measurements do not represent simultaneous process-tree memory.

The qualification census is uncapped: its largest two training components
contribute about 44.17% and 25.33% of original generated tokens. After native
deduplication, the largest component contributes 44.5945% of training targets.
The final sampler applies its predeclared **10,000-token per component / 20%
training share** limits to that actual native accepted inventory. Conservative
budget groups union frozen source components with actual native family joins.

| Native prepared view | Train / validation / test | Training targets | Training declared families | Training components | Largest component share |
| --- | --- | ---: | ---: | ---: | ---: |
| Complete census | 462 / 27 / 52 | 505,181 | 74 | 21 | 44.5945% |
| Capped release | **132 / 27 / 52** | **139,145** | **47** | **21** | **7.1745%** |

The capped release contains **211 native examples**, 180,634 generated/scored
tokens and 673,322 complete transcript tokens. All 79 accepted evaluation rows
remain; 330 accepted training examples are excluded by the caps. Every output
Episode byte sequence, token ID, free mask, lineage and frozen split matches
its authenticated parent. Native family labels also remain unchanged in this
actual subset, with zero new duplicates or quarantines. All 21 training
components remain represented; the reduction from 74 to 47 declared families
is an explicit coverage tradeoff.

The subset is materialized through the consumer's normal storage/dedup/export
APIs and independently read through its ordinary train/validation/test reader.
Three negative cases—changed parent checksum, repeated identity and removed
evaluation member—fail before creating output. Materialization and full readback
take 7.885 seconds. Its verified 77,464,260-byte archive retains every original
1,171-case audit file and is ready to consume. It supplies data, not an optimizer
or learned-accuracy result. See [the native selection runbook](REAL_SOURCE_D_TRAINING_SELECTION.md).

E freshly admits all twelve selected `distinct` cases, representing one declared
family/component and two executed paths, with 16,008 native generated tokens.
The run takes 46.03 seconds with two workers and peaks at 189,661,184 bytes of
reported JavaScript-worker RSS. These twelve input variants are not twelve new
algorithms. Source/oracle/replay/private evidence and fresh native receipts are
all retained.

E's twelve candidate admissions produce four exact-public representatives
plus eight retained aliases. The unchanged native preparation then retains two
examples and records two native duplicates, with no refusals. The earlier
all-twelve preparation correctly refused immutable episode-ID collisions and
is preserved separately; no native identity rule was weakened to make it pass.

F freshly qualifies all **60** cases selected from D's 48 captured-binding and
twelve darts/Number projection refusals. Its original run admits 58 and times
out twice. A single serial retry of those two cases succeeds in 87.035 and
100.700 seconds under the unchanged 120-second limit. All 287 old CAS objects,
the original journal byte prefix, original selection and 58 cached admissions
are checked unchanged. The final campaign has 60 candidates and 62 attempts.

F's verified release retains **52 exact-public representatives**, with eight
mapped aliases across four groups within one family. All 52 pass fresh native
preparation; native deduplication retains **22 unique prepared examples** and
records 30 duplicates, with zero refusals. The prepared split has two train
and twenty test examples across all six families. These are targeted repaired
cases, not a replacement census of all D rows. Preparation, packaging and
member verification take 336.187 seconds and peak at 493,359,104 bytes of
reported process RSS. The complete original 60-case/62-attempt audit is inside
the verified archive.

The six original D worker timeouts receive a separate bounded F review. Two
fresh attempts (Collatz one million and sum-of-multiples 150) time out at
240 seconds. Four others are not relaunched after frozen-compiler lower bounds
prove that normal completion requires at least 45,760, 618,750, 21,978 and
219,978 instructions, above the unchanged 20,000-step budget. Those four are
static budget dispositions, not fabricated worker results. The full review
takes 533.298 seconds; it creates no admissions or training targets.

The native consumer corrections preserve input public graphs across replay,
stream complete private audits rather than duplicating them in memory, and
validate captured cells as source-binding names while retaining strict heap
reference grammar. Full Unicode identifier parity is not claimed.

### W10–W11: real optimization and negative execution results

| Actual attempt | Optimizer updates | Consumed members / families | Supervised generated lexical tokens | Complete held-in executions, baseline → trained |
| --- | ---: | ---: | ---: | --- |
| Initial feasibility | 2 | Tiny diagnostic | 25 | No successful complete execution |
| First 32-example preparation | 0 | Preparation interrupted | 0 | Not run |
| 32-update retry | 32 | 3 / 3 | 865 | 0/4 → 0/4 |
| Longer partial pass | 95 | 16 / 16 | 5,238 | 0/4 → 0/4 |
| Final resolved full pass | 49 | 32 / 29 | 9,379 | 0/4 → 0/4 |

The 95-update attempt's original forecast used an implicit window default; its
actual exposure covered only sixteen members. That error, the corrected
forecast and the original outputs are retained. The final run freezes the
resolved 49-window plan before launch and matches actual member/token exposure.
It takes 636.95 seconds inside its 900-second cap, changes 311 parameter tensors
and updates 315 optimizer owners. Observed generation loss masks are zero, the
generated supervision count is 9,379, and checkpoint reload/served identity
checks pass. Its overall smoke result is false because model execution fails.

The actual eight-family held-out diagnostic freezes test components disjoint
from training before inference, freshly source/native-checks all eight tasks,
and runs sixteen paired baseline/trained rollouts. Both arms score 0/8. It is
one exploratory seed using a small diagnostic initialization, not a useful
pretrained execution baseline. The full evaluation matrix—new project and
feature compositions, varied feedback/schedules, longer horizons/heaps, and
pure code/input-to-output transfer—has not been measured by this small cohort.

Parallel main retains a separate negative experiment: 64 updates visiting five
of 32 prepared source IDs, a selected test with 0/3 successes in both arms from
one independent component, and a pure source/input-to-output test with 0/1 in
both arms. Its original receipts and uninjected outputs remain in
[the separate learning-pilot evidence](receipts/learning-pilot-2026-11-18/README.md).
The integrated source-only transfer adapter is implemented; that one-task result
does not establish the broader transfer matrix. None of these denominators is
added to the 49-update/eight-component experiment above.

The comparison implementation requires complete hard gates, actual artifact
and budget identities, family-weighted scores, component/seed resampling,
declared improvement thresholds and protected slices. Confirmatory acceptance
requires at least three seeds and qualified production inputs. Diagnostic
reports cannot silently become production budget or transfer evidence.

Evidence: [full-pass receipts](receipts/optimization-full-epoch-2026-11-18/README.md),
[optimization guide](OPTIMIZATION_SMOKE.md),
[comparison contract](LEARNING_COMPARISON.md), and
[exploratory scope](EXPLORATORY_HELDOUT_DIAGNOSTIC.md).

### W12–W14: repeatable collection, targeted expansion and releases

The collector now uses atomic checksummed CAS objects, an append-only campaign
log, torn-write recovery, immutable cache identities, explicit resume/retry,
cancellation and bounded workers. Public learner records and compressed private
evidence are separate. Large shared registries are stored once and rehydrated
losslessly before normal admission/native gates. Compatibility exports and
complete private prepared releases remain available.

Reports separate fresh work from reused receipts and record generated tokens,
wall time, summed verification time, families, paths, components, worker RSS and
storage bytes. Token-share selection acts on admitted training components and
retains evaluation rows. A selected release must also include its original
audit campaign so rejected/excluded evidence is not lost.

Refusal-driven additions include dense owned `Array.some` and `forEach`, early
exit/current-heap reads, sparse `fill`, and primitive `Number` conversion.
`Number()` distinguishes omitted from undefined arguments, evaluates extra
arguments in order, and refuses object coercion outside the profile.
Canonical bindings preserve exact integer type for grains, omitted arguments
for two-fer, and active replacements for superseded Exercism cases. Exact raw
integer lexemes detect two Armstrong inputs that cannot survive conversion to
a JavaScript Number; fresh preflight refuses them before execution instead of
rounding them into a different task. D's original mismatches stay unchanged.
Unsupported general BigInt execution remains refused.
These additions increase useful bounded-profile coverage without claiming
unrestricted library or host compatibility.

The integrated main adds bounded primitive BigInt and String conversion with
owned abrupt outcomes; this does not reclassify historical D/F refusals. It
also supplies an optional Linux namespace/seccomp native-reference launcher,
exclusive writer/shared reader campaign locks, validated registry reuse,
drained failed workers and stricter checkpoint/exposure checks. Historical
passes from other hosts retain their recorded producer, consumer and isolation
identity. Final integrated qualification is recorded separately from those
existing receipts.

Complete release archives include public records, private evidence, source
pins/notices, refusals, actual prepared native data and hashed manifests. The
streaming verifier checks every archived member. Archives are private audit
releases; they do not invent permission for public redistribution.

## Work that cannot be completed here, and remaining acceptance work

| Item | Exact limitation | Next concrete action |
| --- | --- | --- |
| Qualified production SE/SC training | No compatible preceding phase-S checkpoint, ordered pinned donors, hindsight/coordinator assets or complete experiment identities were supplied. Native launch validation requires them; diagnostic P1 checkpoints are not substitutes. | Supply compatible phase-S or same-stage resume assets, the pinned donor profiles and complete the declared training configuration. Run validation before spending compute. |
| Production compute and confirmation | This environment has CPU Torch and no CUDA. Actual bounded CPU optimization was completed, but no three-seed production experiment or positive execution result exists. | On a suitable runner, start with the recorded first-action failures, establish held-in execution, then freeze validation/test and run the predeclared multi-seed comparison. |
| OS isolation for arbitrary untrusted code | The earlier ordinary namespace probe fails creating a NETLINK_ROUTE socket. The integrated optional Linux profile confines the native reference only; the owned teacher, acquisition and consumer are separate boundaries. Its host-specific test and explicit skip/failure remain necessary. | Qualify the Linux reference profile on the intended runner and isolate every remaining untrusted execution boundary. Keep the default trusted-source restriction until that complete runner is qualified. |
| Hard aggregate CPU/RSS quotas | Existing wall/output/V8-heap controls and measured RSS do not enforce a whole-process-tree quota. No writable delegated cgroup/qualified container boundary is supplied. | Add and test runner-level process-tree quotas; report native/reference descendants as well as the JS worker. |
| Local browser launch | Playwright download produced an invalid archive and system Chromium launch was denied a Unix socket. | Use the existing GitHub real-browser workflow, which has already passed at published revisions. Final revision status is reported separately; local denial is not a total browser blocker. |
| Public corpus licensing | Source notices and upstream licenses are retained. No owner-selected repository/data redistribution policy was supplied; repository-fixture is not an SPDX license. | Review distribution terms before making a public corpus release. Current archives remain private evidence. |

These are different from supported-profile choices and empirical failures.
Broader descriptors/prototypes, full Error object behavior, early or escaping
captures across uninitialized cells, sparse/async callbacks, general object
coercion beyond bounded primitive conversions, complete
source maps for utility transforms, full strict/module/async Test262 harness
behavior, and the remaining evaluation slices are implementation/research work,
not all sandbox impossibilities. The plan calls for evidence-led expansion;
their absence is declared, not hidden behind a blanket environment claim.

## Reproduction and recovery

Use a clean worktree at the exact producer and a separate clean consumer checkout
for each evidence revision. Install only committed dependency locks. Do not move
an active campaign's editable native checkout or repoint its Python environment.
Verify the actual imported consumer and tokenizer with
`tools/native-consumer/check_environment.py` before generation.

For a new full baseline, use `npm run baseline:v5 -- --out NEW_DIRECTORY` with
the exact native paths and a declared `--check-timeout-ms` appropriate to the
worker count. Freeze the shared source registry before expanding inputs. The
[collection runbook](RESUMABLE_CORPUS.md) contains generation, native admission,
component token caps, complete packaging and interrupted-run recovery commands.

The capture repair is reproduced with E, its policy-pinned consumer, the original
full registry and `--recipe real-source --source-stream utilities,exercism,production
--per-family 12 --case-ids docs/evidence/native-capture-case-ids-D-2026-11-18.json`.
Use a new output directory; the twelve old refusals stay in D.

For every completed release, run `tools/package-semantic-release.py --verify
ARCHIVE` and compare the retained archive SHA-256 and identity digest. An audit
archive and a freshly native-prepared release have separate schemas and claims.

## Verified durable artifacts and current CI

The following complete archives are verified and saved. Private download links
are supplied with the delivery index; they are not embedded in the public
repository. Every archive has a complete member inventory and identity digest.
The C audit, complete model archive and complete D real-source native census use
the checksummed split parts in [ARCHIVE_PARTS.md](ARCHIVE_PARTS.md). All other
listed archives fit in one file.

| Archive | Bytes | Verified members | SHA-256 |
| --- | ---: | ---: | --- |
| C complete historical audit | 1,023,114,187 | 2,909 | `1c48257bfb7713e332a17cb3cb1e5e2b3dc1ec1a4573ae9716981506254953ab` |
| Complete model evidence, all attempts | 678,766,391 | 425 | `662d686473ca07cd81af5ae5e742eba484dfbc502b0a46ad225b932c73f6bce1` |
| D engineering native release | 42,959,698 | 190 | `cf1762e29356c76790edaffd45fde990352bdf08c4575e7c91a0144122300151` |
| D training native release | 128,507,572 | 397 | `aaa61d2b95d4ba862c108120ce00d19f4ca986553d2b48632af05d855d708adb` |
| D benchmark native release | 350,847,115 | 1,026 | `395f9efb6a5ae79066c9c65ec24bad522673ab3d575e88ad3080f3c800499dfd` |
| D generated native release | 103,599,104 | 374 | `02a55c7e6dbc53df2a25479a786f67f3d41f4d982936016d025ae7fcdf6f0631` |
| D complete original real-source audit checkpoint | 69,861,152 | 5,336 | `8fc95f764422b9062c119e46d7218be97e650b63ff04c645f07d33691d1245cc` |
| E capture native release | 7,513,139 | 70 | `75d09e16491b71741a2d83705a3d74be101378962cf6e68cfdf7754ce169a65a` |
| F targeted native release | 102,268,413 | 366 | `dd6097d6b309e630cab1088809fdfce71706eed650f5f2c57c40da396b42dddc` |
| D complete real-source native census | 1,688,252,285 | 6,474 | `ac4e88a3fba5f046ad44501e5751560806b1cdeaf701deb46fd6eea80aff9558` |
| D consumable capped native release | 77,464,260 | 5,339 | `e59a167d4192efbdb499a382ee3108425503e6d268544d6dbb78cbe867eef25c` |

The audit-only archives preserve original attempts and refusals. They do not
claim a new native-preparation run. Native releases include the independently
rechecked prepared data as well as their required original audits. The model
archive includes checkpoints and served weights, not merely summaries of files
that once existed.

Remaining verification logs and current-revision CI are being appended here.
Queued, cancelled, skipped and historical checks remain separate from a pass at
the final revision. The Node 20/22/24 regression matrix and browser/spec gates
already have passing published-revision evidence; final CI must retain its
own exact head and job links.
