# Resumption implementation handover — 18 November 2026

**Working checkpoint:** final D collection, release packaging, final CI and
durable artifact links are still being completed. This report will be updated
with their final results. All completed implementation increments have been
pushed; historical failures remain in the evidence.

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
| E | `1b391c19c3c8137d5b00c5412e53614a568b3704` | `1cee21dd07a687b0a824abff1bbd5ef9a13149ab` | Fresh full qualification of the twelve captured-binding failures. |

The E subset does not requalify all D rows. D's original capture-name refusals
remain in D. Local tested companion commit `3e3d418…` and published `1cee21d…`
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

The current capability report measures 42 finite `training-js/1` probes.
Thirty-one reach native admission and all 31 pass; eleven remain untested at
that stage because an earlier profile/gate stops them. Model evaluation is
untested in this feature ledger. The other source profiles are explicitly
untested there, even where separate regression suites exist. D's unit run has
842 tests: 837 pass, zero fail, five external-environment skips. A fresh pinned
engine262 comparison passes 1,958 finite arithmetic cases with reconstruction
and replay. This is not full ECMAScript or Test262 conformance.

Semantic repairs include method-specific omitted/undefined array bounds, async
declaration flags, ordered parameter initialization/TDZ and separate body scope,
default-parameter closure capture, positive primitive and declared Error throws,
and explicit descriptor refusals. The Error profile avoids reading accessors or
lazy stack state. The Node 20 canonical-data compatibility fix preserves exact
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
with 77,855 actual native generated tokens. D engineering and training-v4 pass
25/25 and 50/50. D's benchmark wrapper reached its 900-second whole-check budget
after 87 admissions and one cancelled case; the durable collector is being
resumed with the original identities. The new baseline option records a larger
declared bounded budget when needed.

E freshly admits all twelve selected `distinct` cases, representing one declared
family/component and two executed paths, with 16,008 native generated tokens.
The run takes 46.03 seconds with two workers and peaks at 189,661,184 bytes of
reported JavaScript-worker RSS. These twelve input variants are not twelve new
algorithms. Source/oracle/replay/private evidence and fresh native receipts are
all retained.

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
exit/current-heap reads, and sparse `fill`. Canonical bindings preserve exact
integer type for grains, omitted arguments for two-fer, and active replacements
for superseded Exercism cases. Unsupported BigInt execution remains refused.
These additions increase useful bounded-profile coverage without claiming
unrestricted library or host compatibility.

Complete release archives include public records, private evidence, source
pins/notices, refusals, actual prepared native data and hashed manifests. The
streaming verifier checks every archived member. Archives are private audit
releases; they do not invent permission for public redistribution.

## Work that cannot be completed here, and remaining acceptance work

| Item | Exact limitation | Next concrete action |
| --- | --- | --- |
| Qualified production SE/SC training | No compatible preceding phase-S checkpoint, ordered pinned donors, hindsight/coordinator assets or complete experiment identities were supplied. Native launch validation requires them; diagnostic P1 checkpoints are not substitutes. | Supply compatible phase-S or same-stage resume assets, the pinned donor profiles and complete the declared training configuration. Run validation before spending compute. |
| Production compute and confirmation | This environment has CPU Torch and no CUDA. Actual bounded CPU optimization was completed, but no three-seed production experiment or positive execution result exists. | On a suitable runner, start with the recorded first-action failures, establish held-in execution, then freeze validation/test and run the predeclared multi-seed comparison. |
| OS isolation for arbitrary untrusted code | The ordinary namespace attempt fails creating a NETLINK_ROUTE socket. The sandbox cannot provision the required isolation boundary. | Provide an isolated runner with network/files/credentials restricted and hard process-tree CPU/memory limits. Keep current trusted-source restrictions until qualified. |
| Hard aggregate CPU/RSS quotas | Existing wall/output/V8-heap controls and measured RSS do not enforce a whole-process-tree quota. No writable delegated cgroup/qualified container boundary is supplied. | Add and test runner-level process-tree quotas; report native/reference descendants as well as the JS worker. |
| Local browser launch | Playwright download produced an invalid archive and system Chromium launch was denied a Unix socket. | Use the existing GitHub real-browser workflow, which has already passed at published revisions. Final revision status is reported separately; local denial is not a total browser blocker. |
| Public corpus licensing | Source notices and upstream licenses are retained. No owner-selected repository/data redistribution policy was supplied; repository-fixture is not an SPDX license. | Review distribution terms before making a public corpus release. Current archives remain private evidence. |

These are different from supported-profile choices and empirical failures.
Broader descriptors/prototypes, full Error object behavior, captured TDZ
projection, sparse/async callbacks, general BigInt construction, complete
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

## Final artifact and CI index

Final D real-source results, benchmark recovery, E package, complete model
archives, durable download links and final revision CI are being appended here.
The complete C audit archive is already verified: 2,909 files, 1,023,114,187 bytes,
SHA-256 `1c48257bfb7713e332a17cb3cb1e5e2b3dc1ec1a4573ae9716981506254953ab`.
It contains all 477 original attempts and is explicitly an audit bundle, not
a newly native-prepared release.
