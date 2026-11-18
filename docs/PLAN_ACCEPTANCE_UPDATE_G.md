# Acceptance update after the D/F releases and G semantic repairs

## Scope and current conclusion

This is an **additive update** to [the original acceptance audit](PLAN_ACCEPTANCE_AUDIT.md).
That audit's earlier cutoff and unresolved findings remain historical evidence.
This update inspected completed release receipts and source/replay review results
available on **18 November 2026, approximately 14:46 UTC**. The
[compact evidence snapshot](evidence/plan-acceptance-update-G-2026-11-18.json)
binds the inspected files, hashes, population counts, and measured outcomes.
The supplied plan's SHA-256 remains
`5e3c7ab5d2e7afbb94ae3725d1c78647a92594ed8265bce6edcb36eabc1ec562`.

**The full D native release, a materialized component-capped D subset, and the F
requalification package are complete.** The new parameter and async replay
repairs have targeted independent review evidence. They do not close the actual
learning acceptance gap: both model arms still score **0/4 held-in and 0/8
held-out**, with no positive transfer result. No additional optimizer run or model
inference was performed for this audit.

The final source qualification is still a live closeout item. Producer G is
`a088ad60028a02e1d595dfc1afe7b6379cd0998a`. Its fresh unit run records **870 tests:
864 pass, one failure, five skips**. The failure is the old assertion that genuine
later/self-parameter TDZ throws cannot be locally verified; those throws now
have an authenticated positive-label path. The failed log and process receipt
are retained. A corrected expectation and fresh H qualification are pending;
G's native 44-probe run had not been launched after the unit failure. Neither a
planned repair nor the verified native environment is a passing final gate.

## Completed release populations

The table keeps candidate admission, representative selection, native
deduplication and training selection distinct. All original failures remain in
their original campaigns.

| Population | Completed measured result | Meaning |
| --- | --- | --- |
| D original real-source census | **1,171 attempted; 987 admitted; 184 non-admissions** | Original D producer/consumer results, including the original capture, precision and timeout failures. |
| D exact-public selection | **965 representatives; 22 retained aliases** | The independent native-equivalence check verifies that the aliases differ only in the permitted task identifier. |
| D full native preparation | **965/965 re-admitted; 541 accepted; 424 native duplicates; zero refusals** | Actual final prepared inventory, not the larger admission denominator. Splits are 462 train, 27 validation and 52 test. |
| D capped native subset | **211 accepted; zero duplicates or quarantines** | Materialized and readable native dataset: 132 train, 27 validation, 52 test. All 79 accepted evaluation rows remain unchanged. |
| F repaired-source campaign | **60/60 admitted after two serial retries** | The initial 58 admissions and two timed-out attempts remain intact. The two later successes use the same campaign identity and bounds. |
| F selected native package | **52/52 re-admitted; 22 accepted; 30 native duplicates; zero refusals** | Eight exact-public aliases were retained separately before native preparation. |

The D full release uses producer
`83e0d5742e63dc4439b68d6296f323cb7a3aafdc` and consumer
`b88073dcb5a8e438a711d494a5fd592e773798f5`. The F package uses producer
`22eaac6a46e262b00986c63b4fc66f6240016252` and consumer
`1cee21dd07a687b0a824abff1bbd5ef9a13149ab`. G/H changes do not relabel those
receipts. F overlaps D; adding 22 to 541 does not establish a new independent
corpus without a separately checked union and deduplication.

The [D prepared-release receipt](evidence/semantic-v5/real-source-prepared-release-D-2026-11-18.json)
records 541 native rows across 89 declared families and 32 conservative
components, with **546,670 generated/scored tokens**. Its training portion spans
21 components and has a largest component share of **44.5945%**. The full
qualification release is intentionally retained as the uncapped audit census.

The [D capped-release receipt](evidence/semantic-v5/real-source-native-capped-release-D-2026-11-18.json)
closes the earlier audit's feasible selection/materialization gap. The policy is
**10,000 generated tokens per training component and at most 20% of training
generated tokens from one component**, using the conservative transitive union
of frozen source components and native resolved families. It excludes 330
accepted training rows while preserving evaluation membership. The result has
**139,145 training generated tokens**, 47 declared training families across 21
components, a maximum of **9,983 tokens** from one component and a maximum share
of **7.17453%**. All 211 complete native episodes, token IDs, masks and lineage
checks match the accepted parent inventory; native family labels did not change.

This is an actual prepared subset, beyond a metadata-only cap report. It has
**zero optimizer steps**. A later sampler can change realized exposure through
weights or repetition and must retain its own counts; the current cap is not a
claim about an unexecuted training run.

| Verified archive | Bytes | SHA-256 |
| --- | ---: | --- |
| D full native release | 1,688,252,285 | `ac4e88a3fba5f046ad44501e5751560806b1cdeaf701deb46fd6eea80aff9558` |
| D capped native subset and original audit | 77,464,260 | `e59a167d4192efbdb499a382ee3108425503e6d268544d6dbb78cbe867eef25c` |
| F native requalification | 102,268,413 | `dd6097d6b309e630cab1088809fdfce71706eed650f5f2c57c40da396b42dddc` |

Archive verification checks complete member inventories. The release owner has
confirmed durable saving of the D full and capped archives. The final delivery
index remains the authoritative place for user-facing links and reconstruction
parts; local verification and durable delivery are separate receipts.

## W01–W14 acceptance checklist

“Bounded” means the explicitly declared source and semantic profile. It does not
expand a native receipt to an untested feature, revision or model stage.

| Work | Current implementation and evidence | Remaining acceptance or handover boundary |
| --- | --- | --- |
| **W01: reproducible baseline and ledger** | Reproducible baseline command, isolated oracle/npm lock, hashed Python lock, finite capability reporting and exact producer/consumer/tokenizer policy. G's native environment is verified. | Final H unit/reference/native qualification and exact publication CI remain pending. Keep G's failed run. Other source profiles and feature-level model stages remain untested. |
| **W02: array defaults and async declarations** | Boundary repairs and differential/replay tests; F has actual representative native admissions. G also repairs a synchronous root using an async helper. The [independent review](receipts/parameter-projection-review-2026-11-18.md) rejects forged async bytecode/source and preserves disabled async and host boundaries. | The new composition's final native gate is pending with G/H. No arbitrary built-in equivalence is inferred from representative probes. |
| **W03: parameter scope, TDZ and captures** | Separate parameter/body environments and ordered initialization are implemented. Genuine parameter TDZ errors now carry prior-state-authenticated completion facts; bounded forward closure deferral is independently reviewed, including aliases, mutations, early calls and escapes. | The earlier concrete projection gaps are repaired in code and targeted local checks; final native qualification is pending. Deferral across effects, early reads/calls, new allocations, self-capture or other unapproved operations remains explicitly unsupported. |
| **W04: descriptor boundaries** | Unsupported descriptor arguments and array accessor combinations fail explicitly; supported omissions preserve behavior. | Met through the plan's explicit-refusal option. General descriptor/prototype support remains outside the declared profile. |
| **W05: immutable admission identity** | Single/session reconstruction binds source, ancestry, split, provenance and native policy. The [actual C native tamper receipt](evidence/native-provenance-C-2026-11-18.json) accepts both controls and refuses all 30 mutations. | End-to-end evidence is C-specific. Trusted release anchors and source/native rechecks remain mandatory; hashes are not signatures authenticating arbitrary assertions. No unsupported fresh G/H tamper claim is made. |
| **W06: throws and failure classification** | Positive primitive and declared Error/TypeError completion paths, structured failure records and original-preserving minimization exist. Genuine parameter TDZ is now an additional bounded implicit-error path. Internal/resource failures remain distinct. | Final new TDZ native gate pending. Callback failures, unhandled rejections and broader Error/prototype/stack/cause/subclass semantics stay explicit refusals/backlog. |
| **W07: real-source native bridge** | Complete D census, fresh native preparation and full audit package are measured. F separately requalifies selected repaired families. | Bounded bridge acceptance is demonstrated. Refused or precision-unsafe inputs are retained, not coerced into positive labels. Broader source coverage remains feature work. |
| **W08: global components and evaluation** | Frozen clone/ancestor registry prevents split crossings; source and composition holdouts precede expansion. Eight actual held-out diagnostic components are disjoint from the actual training inventory. D now has a materialized component-capped subset with unchanged evaluation rows. | Intended larger diversity is not reached. D's 21 training and nine test components must not be inflated by declared-family or alias counts. Public source holdouts do not prove pretraining cleanliness. |
| **W09: native CI and durable evidence** | Engineering, training-v4 and benchmark-v1 workflows use actual consumer gates. D baseline and generated-program receipts, completed D/F native packages and full original failures are retained. | Final H/exact-head CI still needs its own successful receipt or explicit actionable refusal. G's one stale-test failure is retained. CI retention alone is not indefinite archival storage. |
| **W10: actual optimization and held-in execution** | Actual 49-update CPU epoch consumes all 32 prepared examples/29 families and 9,379 supervised lexical targets; masks, gradients, changed parameters and exact checkpoint/served reloads are checked. | **Execution acceptance fails empirically: base 0/4, trained 0/4.** Optimizer mechanics passing does not meet the complete held-in execution condition. |
| **W11: base-versus-trained evaluation** | Strict comparator and artifact/qualification checks exist. Actual frozen eight-component exploratory evaluation gives family/episode results, original emitted bytes, costs and hard-gate counters. | **Exploratory comparison completed; useful/confirmatory learning is not established: base 0/8, trained 0/8, one seed.** Full production qualification, three-seed confirmation and the wider transfer matrix are not measured. |
| **W12: resume and cost profiling** | Durable campaigns resume with unchanged identities and preserved attempts. Worker bounds, measured storage/costs, static timeout exclusions and actual native window/history costs are retained. | No hard aggregate process-tree CPU/RSS quota or qualified OS isolation for untrusted guest input. Tokenizer/window measurements do not give an unmeasured flat lexical equivalent of recurrent state. |
| **W13: demand-driven language growth** | Actual refused source families drove bounded array callbacks, scalar conversion, canonical precision handling, native capture validation and parameter projection improvements. Native receipts show useful admitted coverage at their own revisions. | Final new native gate pending; all feature-level model-success stages remain untested. The current learner's first-action failures do not justify arbitrary language expansion. |
| **W14: release and maintenance** | Explicit release gates, conservative branch triage, source notices, native archives, hashes/reconstruction instructions and historical v4 evidence are retained. Full D, capped D and F packages are complete. | Finish exact final-gate/delivery indexing. Public redistribution needs an explicit owner license policy. No branch deletion, issue closure or protection change was inferred from read-only maintenance triage. |

## Handover by cause

### Empirical negative results requiring diagnosis

The [complete optimization receipt](receipts/optimization-full-epoch-2026-11-18/summary.json)
and [held-out receipt](receipts/exploratory-heldout-2026-11-18/summary.json)
report actual model outputs. The trained checkpoint changes 311 parameter tensors
and 315 optimizer owners, yet every evaluated task fails at its first candidate
action. The eight-family episode- and family-weighted change is zero. The
retrospective audit checks all 24 original held-in/held-out outputs without
changing them or running more inference.

The next learning investigation is to diagnose those retained first failures and
establish successful held-in execution with the actual selected driver. More
compute, a larger dataset or passing comparator tests cannot be described as a
solution already demonstrated. Zero integrity and cleanup counters describe
these refusal paths, not learned effect/error/cleanup competence.

The [bounded D-timeout recovery](BOUNDED_TIMEOUT_RECOVERY_F.md) also remains
negative: two fresh serial F attempts still hit the authorized 240-second wall
ceiling; four other D candidates have conservative compiler step lower bounds
above the unchanged 20,000-step budget and were not relaunched. These six D
cases are distinct from F's two smaller knapsack retries that later succeeded.

### Missing assets and runner capabilities

Qualified production SE/SC needs an eligible preceding-stage or same-stage base,
the ordered pinned donor profiles, checksummed hindsight targets, coordinator
and worker checkpoint qualification, and actual required stage-supply coverage.
Those complete assets were not available. The successful CPU diagnostic uses a
newly initialized tiny P1 model; renaming its stage or receipts would not satisfy
the production contracts. See the exact prerequisites in
[the optimization handover](OPTIMIZATION_HANDOVER.md).

The environment has CPU torch and no CUDA. Production fit/throughput is
unmeasured; this does not erase the actual CPU negative result or prove that
every possible further CPU experiment is impossible. Ordinary workers lack a
qualified OS isolation boundary and delegated aggregate resource quotas.
Trusted-source restrictions must remain. Local browser launch failed, while
external browser CI supplies its own measured alternative; no blanket browser
impossibility is claimed.

### Deliberate profile limits and feasible future engineering

Conservative refusals remain for unsupported descriptor/prototype behavior,
broader Error/lifecycle completion, unsafe deferred closures, general BigInt,
and broader host/language features. Partial source-coordinate maps retain exact
bytes and conservative spans rather than inventing mappings. Other declared
source profiles, TypeScript and larger Test262 slices need their own complete
harness and gate denominators. These are bounded feature/coverage decisions,
not all sandbox blockers and not full language conformance.

The original plan says: **“Use input generation to reach uncovered paths and
challenging boundaries.”** It does not specifically require an adaptive
feedback algorithm. Existing verified executed-path novelty selection, seeded
generation and boundary inputs satisfy portions of that objective. A narrow
future increment can freeze additional supported boundary inputs and measure
new executed paths under the same registry and admission gates. Adaptivity is
an optional technique, not an invented unmet criterion.

The proposed 5,000–20,000 episodes, 100–300 training clusters and roughly 100
held-out families are explicitly planning targets in the plan. The present
smaller, one-seed comparison is valid exploratory evidence with a negative
outcome. It does not establish a practical improvement or the unmeasured
new-project/composition/schedule/long-run/pure-output transfer slices.

### Final closeout checks, without repeating completed experiments

1. Retain the failed G unit receipt and append the actual corrected H
   unit/reference/native result and final publication CI identity. The G reference
   fixture did not run after the unit failure. Do not infer
   these from local source review or an environment check.
2. Keep the D full, D capped and F archive hashes in the final delivery index,
   including reconstruction parts where used. Preserve complete original
   campaigns and distinguish original failures, aliases, native duplicates and
   cap exclusions.
3. State that the capped dataset is available but unconsumed by an optimizer;
   retain actual source/token exposure if it is later trained.
4. Keep W10's failed held-in criterion and W11's exploratory zero-improvement
   result prominent. Bind future comparisons to actual qualified assets,
   predeclared thresholds/cohorts/slices and matching training exposure.

This update closes concrete packaging, balancing and bounded projection work
from the earlier audit. It does not grant an “all W01–W14 complete” status or a
positive learned-execution claim.
