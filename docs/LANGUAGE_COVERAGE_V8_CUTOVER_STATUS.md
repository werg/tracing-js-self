# Language expansion and V8 cutover: implementation status

This is the durable work ledger for the two design plans supplied on 20 November
2026. It tracks three separate finish lines: representation cutover, language
coverage, and qualified learned execution. None is complete yet. Checked items
must name executable evidence; historical receipts retain their original pins.

## Branches and baseline

- Producer: `werg/tracing-js-self`, `codex/language-coverage-v8-cutover`, based on
  `f32c6fcf4e11ef2c18592a04d9ff108ad74913dc` (merged producer PR 46).
- Consumer: `werg/megatoken`, `codex/language-coverage-v8-cutover`, based on
  `24f4a7c16edf4603cbf5ea6863db1f6a8cc67e37` (merged consumer PR 37).
- Authoritative requested scope: `docs/plans/language-coverage-expansion.md` and
  `docs/plans/language-coverage-and-v6-cutover.md`.
- The producer PR is the main progress report. Paired changes are published in
  small increments. Repository commits and this ledger support session recovery.

## Active continuation — 21 November 2026

- Resumed from actual producer `274d327cf18ecd33fa4a5b524433c8a4526b4fd1`
  and consumer `18a55a8400cbf8c7e9ec220bc323d5dd5b10579a`. At these heads,
  eight producer workflows passed and the full Node 20/22/24 test matrix failed
  on the same obsolete map-throw refusal assertion; the three consumer semantic
  workflows passed, while its general CI was cancelled. The obsolete refusal is
  replaced by a positive original-source/recheck/JSON-checkpoint test of the
  thrown value. All 15 enumeration and source-transaction controls pass locally,
  with zero failures/skips. The four remaining refusal cases are retained.
  Hardest-first work now targets durable return-value callback continuation,
  original module namespace/export semantics, and real V8 decoder fitting from
  strictly admitted ordinary prepared data. All 17 acceptance packages remain
  open; these baseline observations do not qualify subsequent changes.
- Exact published pair **producer `20fca49ca21d3b9d4cfed9e2b439e4e5f288b0fd` / consumer `18a55a8400cbf8c7e9ec220bc323d5dd5b10579a`** passes **35/35 original source checks, 35/35 independent native admissions, all 35 exact-token cost measurements and all 35 native-packing receipts**. Ordinary preparation, exactly two optimizer updates, fresh-process resume, export and real service restoration pass at this pair; zero semantic records are acknowledged. Detailed output is 44,122 of 45,164 measured generated text tokens (97.69%), so broad compact coverage remains open. Both this complete pair and the original 34/33 failed pair are being retained with full tensors/checkpoints/tokenizer/prepared data and exact native input bytes reconstructed and matched to each original receipt.
- The corrected full 843-module campaign at published producer `f04f1beb09e94824a15994625e6e43ec326c53e9` retains all 102,994 variants, including 102,151 unselected. Owned execution: **147 passed, 34 failed, 351 unsupported, 13 environment-unavailable, 205 not-run parse negatives, 93 blocked by parse failures; zero infrastructure errors**. Reference: **672 passed, 104 failed, 67 environment-unavailable**. Parse: 750 passed/93 failed. Every selected-stage denominator sums to 843. Source correspondence has zero passes (146 not run/697 blocked); public/native/checkpoint/data/training/serving stages remain blocked. Full report SHA-256: `98a8ae8e666563fe7cc87255eed0bc2d526f010f4464812c322c400c2899ec7f`. Earlier d4 full and d6 partial attempts retain their original identities.
- A new edition-reference audit checks original test bytes, unchanged variant IDs/modes and exact normative HTML anchors with clause ancestry. It preserves all classifications and counts; anchors do not certify edition membership or test success. Six inventory/specification controls pass, including changed bytes, rehashed missing variants, duplicate anchors, script/comment markup and CR-only headers. A clean implementation preview covers all **102,994 variants / 53,616 tests / 198 feature tags**, with 58,589 resolved exact references, 23,474 absent anchors and 20,931 missing `esid` fields. These are reference-review counts, not exclusions. A fresh report at the published audit revision is required; edition/applicability decisions remain open. See `docs/TEST262_EDITION_RECONCILIATION.md`.
- The separate 16-extra-update ordinary diagnostic at aa07/8772 did not learn a valid first record: lexical loss remained near the vocabulary baseline and actual generation refused before public/native acknowledgement. Its complete trained assets are retained separately. Investigation found the existing V8 record-fitting tool fabricates a training episode without the required frozen source-family registry; the strict trainer correctly refuses it. The fix will use ordinary prepared data and verified train membership. No accepted-record or learned-quality success is claimed.
- Mapped generator callbacks now preserve a live custom-iterator close obligation across suspension and JSON recovery. Closing while a return is pending can throw, and a generator's finally can replace that completion; the checked cases produce the independent native outcomes and execute each cleanup once. The recurring population is now **35 sources**, adding `map-generator-iterator-close`. Fresh source/projection/replay checks and **34 integrated iterator/generator/transaction/population tests** pass. The native policy pins consumer `18a55a8400cbf8c7e9ec220bc323d5dd5b10579a`, which corrects anonymous generator-name metadata and preserves strict object identity/UTF-16 bounds; 33 consumer tests and 68 subtests pass. Fresh 35-case native/cost qualification remains required. Broader async cleanup and return-value host callback recovery remain open.
- The current module-runner increment parses and resolves the original statically reachable module graph, then executes the supported subset through the owned `evaluated-module/1` lowering with the original harness/assertions and no synthetic user export. It records original module hashes and the generated execution-source hash separately; structural replay is not source correspondence or public/native admission. Top-level await, sibling dependency scheduling, module `this`, runtime negatives and original async completion have focused controls. Quoted import names, complex export resolution, dynamic import, namespace exotics, import attributes and unsupported edition syntax remain explicit limitations. Pending top-level await is resource-limited even for runtime-negative tests; parser capability failures do not become infrastructure failures or false negative-test passes. **61 integrated original-runner, evaluated-module and campaign tests pass**, zero failures/skips. A new full 843-module campaign will use this published revision; earlier d4 full and d6 partial attempts retain their actual identities.
- Fresh qualification at producer `aa07a2b0960e24dfa312494dc949b9fc5b98942b` / consumer `8772c0d9d3be16c848365594d0fe49273e328090` measures **34 source passes, 33 native passes, 34 exact-token cost measurements and 33 native-packing receipts**. The anonymous mapped generator exposed a consumer defect: empty function-name metadata was incorrectly validated as a nonempty heap identity. That attempt remains failed; the targeted consumer correction and fresh admission are pending. The same pair's ordinary command runner passes preparation, exactly two optimizer updates, fresh-process resume, export and actual service restoration. Zero records were acknowledged; all seven next-selection fields agree after restoration. The complete assets are being retained before publication.
- Module lessons: static import dependencies must be distinguished from deferred dynamic-import fixture bytes; a pending evaluation is not a completed negative test; and an owned lowering must disclose both original and generated identities. Anonymous function metadata is not an object identity. These distinctions prevent optimistic coverage and admission counts.
- The current source-composition increment adds callback `throw` through `finally` into an outer catch, nested-finally return/throw precedence, and generator callbacks passed to `Array#map`. The public event still has exactly one owner; map delegates only explicit generator creation/start subtransitions, each independently planned for its unique owner inside the same rollback transaction. Recovery controls stop before a callback throw and after generator creation, then consume only the remaining public records. **34 integrated source-transaction, population, generator and completion tests pass**, with zero failures or skips; contract regeneration is byte-identical. The recurring interoperability population is now **34 sources** (`map-callback-finally-throw` and `map-generator-yield` added); it has its own population digest, separate from the unchanged frozen wire manifest. Fresh exact-pair native admission and cost qualification are pending for this increment. Mapped-generator IteratorClose, more general abrupt cleanup and full cross-family composition remain open.
- The durable-intake increment is published at producer `52ea51c92500288535d9845ec31392fb6ce8cc51`; consumer `8ad60100c30a533a24cb12bb7e4d750175deabfa` mirrors the exact private contract and fixtures, with **26 tests and 15 subtests** passing. Consumer `3fcc28f79e014d8021d23b17d5963667a8cd123b` pins that producer in CI. The first hosted CPU jobs for recovery commit `4918b3d` stopped at Ruff formatting, while its three semantic workflows passed. Formatting-only repair `8772c0d9d3be16c848365594d0fe49273e328090` passes the affected Ruff lint/format checks; its hosted full-suite results are pending. The native policy now pins that exact repaired consumer.
- The earlier 16-update record-fitting diagnostic used the **V6** selection path and omitted its fitted tensor bundle. It is not evidence of a V8 accepted-record restore. The current ordinary V8 bundle emits malformed text at the first tested boundary; no record has been acknowledged. A separately labeled, fully retained V8 diagnostic using actual trained tensors and the actual decoder is under implementation. Ordinary quality, accepted-record recovery and held-out results remain distinct gates.
- Current continuation starts from producer `c6d6357a11e8dc9eb35993db45f4e5828914f100` and consumer `31e5688f81cd951384d9b6bcafc1421d43babdff`. All nine producer and four consumer PR workflows at those actual heads completed successfully. These are historical baseline results and do not qualify later changes.
- Per-arrival durable registered input is implemented with immutable, linked and fsynced journal entries, independent expected head receipts, exact graph/owner/public-prefix checks and private queue reconciliation. Later arrivals can be recovered beyond a saved checkpoint without dispatching a host request or opening model state first. A saved journal acknowledgement cannot be replaced by an older head. Conflicting duplicate payloads, stale public history, failed writes and unknown tails refuse. Owner retirement waits for pending intake; exact lost-acknowledgement retries are idempotent after explicit read-only inspection. **62 focused producer controls pass**, covering the new journal/driver recovery, existing private snapshots, lifecycle, selected execution and native callback boundaries. See `docs/SEMANTIC_V8_DURABLE_INGRESS.md` for API, evidence and limits. The private contract digest is `a3ef5979c34f7151495b78bef19315baf6342fd659bb06a597fffba0817242e0`; public fixture/interoperability digests are unchanged. Return-value callback continuations, later missing public history, distributed intake ownership, log rotation and operational deployment/rollback remain open.
- Consumer `4918b3d1c65b8113f9334a8afdc1daf9f129a80d` independently compares all deterministic acknowledged model-selection evidence and reconstructed session-opening metadata during restoration. Rehashed token-accounting, context-visibility and opening-metadata substitutions refuse. Fifteen focused CPU recovery/serving/identity/lineage controls pass, including an actual fresh JSONL service. Wall-clock timings and the expected replay acknowledgement transition are excluded from equality. This does not prove accepted-record selection by an ordinarily trained model or learned execution quality.
- Lessons from this continuation: durable input must be acknowledged before queue visibility, closure must not race an in-flight arrival, and restoring a valid model tensor state alone does not validate saved selection accounting. The previous ledger reports a full 843-module Test262 campaign, but its raw campaign artifact has not been located in this checkout; those counts remain historical reported results, not a recovered original receipt. Fresh full-shard evidence is being rebuilt at explicit current pins.

- The fresh exact pair **producer `7b2a75621233dd86b2c5c13616df479cf443effb` / consumer `31e5688f81cd951384d9b6bcafc1421d43babdff`** passes contract regeneration, **32/32 source checks, 32/32 native admissions, all 32 exact-token/native-packing measurements, and the published ordinary preparation → update → fresh-process resume → export → real service restoration runner**. Exactly two optimizer updates, 315 retained moment owners, 311 advancing owners and 300 changed master tensors are measured; all seven next-selection fields agree after restoration. Zero semantic records were acknowledged, so accepted-record recovery remains open. The complete current-pair assets, including both optimizer checkpoints, model tensors, tokenizer, prepared databases and every report/log, are retained under `docs/evidence/semantic-v8-pair-7b2a756-31e5688/`. The full archive has 390 files including explicitly scoped historical reports; no current-pair asset is omitted.
- The first full **843-module Test262 shard** at producer `7b2a756` and suite `d53ebc8b1931d9f1541e43d59650776e4b766248` is complete. All 102,994 catalog rows remain present and 102,151 are unselected. Parse: 750 passed / 93 failed; independent native reference: 670 passed / 110 failed / 63 environment-unavailable. Owned execution: 545 environment-unavailable, 205 not-run parse negatives and 93 parse-blocked, with zero owned module passes. All 93 parse failures concern `import-defer`; annual-edition membership remains unclassified. The immutable original run is retained while actual runner defects in Test262Error classification, ShadowRealm capability reporting and top-level-await rejection handling are investigated. Sixty-one focused runner controls pass in the clean isolated checkout.
- Producer `f5c44c055c389a78b89fe7ae573ae37986aeb848` preserves arrival order across registered listeners sharing a retained realm, including durable restoration. Private sequences and cursors are checked for duplicates, reversal and substitution before mutation. Twenty-six affected producer controls, 27 paired consumer controls and one installed-wheel absence check pass; contract mirrors are published in consumer `812e8bedf71807de1074a59d072e8048b1698f3c`. The new contract digest is `1be6863d4c4fd4d67698be2d92023db55ea624f6cf8ff9139117d5f48df2cbac`; fixture and interoperability digests are unchanged. Per-arrival broker durability and return-value callback continuations remain open.
- Producer `cb40321a0d9a0682678f0c0a4073efe313bd6742` adds recurring ordinary V8 preparation, one optimizer update, a fresh-process second update, export and actual service restoration to CI. A corrected local runner against producer `a2a2067` / consumer `351c8f7` passes all five stages with exactly two updates, 315 optimizer moment owners, 311 advancing owners and 300 changed master tensors; restored next selection agrees on all seven checked fields. Zero semantic records were acknowledged. The first attempt incorrectly treated `max_steps` as a global cap, performed three updates and pruned the first checkpoint; that failure is retained. The published runner keeps an independent first-checkpoint copy, reuses the unchanged one-update configuration and verifies the latest-checkpoint pointer. A selected held-out source refuses before output creation. Fresh qualification of the published runner/current contract is active; no learned-quality claim is made.
- Consumer `31e5688f81cd951384d9b6bcafc1421d43babdff` refreshes its V8 source-authority checkout to producer `cb40321` and adds the same ordinary lifecycle CI gate. The preceding `812e8be` V8 matrix correctly failed contract comparison against its obsolete producer pin; it is not counted as passing. Producer `c5348ea4b77a84e944ba0892f071c87e143cbae9` now pins this consumer. Current-head CI remains pending.
- The complete fresh pair **producer `a2a2067cc87a36f7636e6d32e603de3bf13beade` / consumer `351c8f7aed56ac400d533156544e34a76ea3e5b5`** passes **32/32 source checks, 32/32 independent native admissions and 32/32 exact-token/native-packing measurements**. Fifteen cases contain compact regions, seventeen are wholly detailed; 39,890 of 40,869 generated text tokens (97.60%) remain detailed. Zero optimizer updates and no learned/latency/default-cutover claim. All 268 original artifacts and logs are committed in producer `edf7ea9ba9d34f358f1f4407cf20657edd8771ad` under `docs/evidence/semantic-v8-admission-a2a2067-351c8f7/`.
- Producer `7b403e8cedb71765301463722e2219aab566834f` executes original Test262 module graphs in isolated native reference processes, forwarding exact dependency bytes and handling static/literal-dynamic imports, resolution/runtime negatives, async completion and TLA. Fifty-nine focused controls pass. Review reproduced and fixed both tracked and statically imported pending-TLA races: a VM `evaluated` status alone cannot certify completion. Owned modules, fresh realms/agents, distinct early-error certification and full upstream qualification remain open.
- The normative ECMA-262 17th edition HTML for ECMAScript 2026 is retained at `artifacts/conformance/ecma262-17.0-index.html.xz`, bound by `artifacts/conformance/ecma262-17.0.json` (8,348,904 uncompressed bytes; SHA-256 `5df49e088c2b5c7a3dfd4a330414b92897fb4535cb62fc5936cad101a6c2304a`). New Test262 campaigns verify these actual retained bytes before creating an edition-bound runner profile. The original full 102,994-variant catalog remains unchanged with its historical unpinned profile and unclassified edition membership. Exact upstream checkout materialization and full 843-module-shard execution remain pending.
- Producer `92145f14ca5669e4c21417f9e39ae85b2a1245ba` now saves registered callback queues against immutable private ingress snapshots and their externally retained receipts. Recovery verifies exact public history and source ownership before model restoration, keeps queued graphs outside model input until delivery, and resumes saved events without registration replay. Eighteen focused lifecycle/driver/ingress controls pass, including fresh-process reconstruction, graph identities, mutation/refusal and write-race controls. Per-arrival broker logging, callback-return continuations and arrivals beyond the saved boundary remain open.
- Consumer `351c8f7aed56ac400d533156544e34a76ea3e5b5` adds an installed-wheel CI gate proving ordinary V8 entrypoints load from the installed package with eight legacy modules blocked. Twenty affected lifecycle/lineage/serving checks plus one isolated wheel check pass with actual pinned tokenizer bytes; test source-verifier injection remains explicitly bounded evidence.
- Producer `72f00114577aff958e2ce67cb2bbe190c96268cb` reuses the validated, explicitly declared read-only V6 capture policy in the record-fitting diagnostic and retains that policy in its boundary/report metadata. The optimizer diagnostic and original saved training configuration remain separately disclosed. Fifteen affected Python controls pass. Fresh exact-pair source/native admission, Gaussian and recurrent-state parity, decoder support and supervision auditing pass. The one-record diagnostic fits the exact target in 16 updates; its first training/serving sample is bit-identical. This is not ordinary model training or learned task success.
- Producer `24f9febbba473bbdb5f36b81cb108cc3e0c6310a` applies the same explicit read-only admission to the two-boundary capture. The initial full hosted follow-up at `72f0011` and its local reproduction refused this missing policy at the second diagnostic stage; 20 focused controls pass. The complete fresh local sequence now passes admission, initial conditional/supervision auditing, the 16-update one-record decoder fit, both native boundaries and the fitted supervision/canary audit. One actual model record passes the public controller; both recurrent-state comparisons have zero difference. The retained report archive explicitly omits model tensors and is not a complete model bundle.
- Producer `a2a2067cc87a36f7636e6d32e603de3bf13beade` composes Promise executors and joins with map callbacks and built-in iterators, alongside Number/Proxy/memory. Sixty-eight focused regression controls and ten final shared-source/population controls pass (overlapping populations). Original-source comparison, fresh recheck, adapter-order determinism and JSON checkpoint recovery pass; unsupported array mutation returns no exported evidence. The recurring interoperability population is **32 sources** and the native policy now pins consumer `351c8f7`. Review also found registration-order delivery across buffered listeners; a global arrival-order fix is active for live and restored queues.
- Fresh clean-checkout source identity verification passes on `92145f1`; contract regeneration also passes with unchanged wire digests. The earlier dirty-checkout refusal remains an actual failed attempt rather than being counted as source proof.
- Resumed from actual producer `f1151a1cb65d5997ba13ba33c5d219ae7eeac19a` and consumer `262cb089b3c0cb035b2c51cdcb342a5271ad25b9`; the older checkpoint sections below remain historical.
- Hardest-first implementation is active in shared Promise/iterator/map source composition, host callback ingress/recovery, original-module conformance execution, and installed ordinary training/serving parity. All 17 acceptance packages remain open.
- Consumer formatting repair is published at `fe027cd429e7368fec4f144f582f71a8597a84ea`. The subsequent full hosted CPU suites at `351c8f7` pass on Python 3.11 and 3.12, as do i18n, installed-wheel checks and all three source/native/bridge workflows. The Blackwell job is skipped, not executed. Fresh local Ruff lint and format checks pass for all 561 selected files. Later commits retain their own CI status.
- Producer hosted V8 qualification at `f1151a1` retained **31 source-qualified / 30 native-admitted** cases, with the new composed example rejected by the older pinned consumer `a237366`. Consumer `6997cae` already adds the required strict extension checks; paired pin refresh and fresh qualification remain required.
- The producer's other hosted failure is the record-fitting diagnostic omitting the required explicit legacy admission policy. The admission guard remains intact while the diagnostic is repaired.
- Consumer `262cb08` contains the prior exact-pair ordinary optimizer/resume/export/serving bundle; it does not qualify later source or consumer changes. New evidence will retain its exact pair and failed attempts.

## Previous checkpoint and implementation record

Continuation on **21 November 2026**. Both PRs remain drafts; **0 of 17 acceptance
packages are complete**. Delivered increments below are bounded evidence. Work
continues in the user's hardest-first order.

- **Atomic source composition is implemented for the current direct adapters.**
  Producer `444e6027d6c9ad6c9159e5083abe0dbfa82d528b` stages all ten adapters'
  public and retained private state together. Producer
  `39009dd2dbd3c34a01a97e834472a75cf7eca40f` freezes ownership declarations and
  requests without executing caller accessors or Proxy traps. Producer
  `6888ca122460d3456f275dee4add9b61ba56b6f9` resolves unique allocation, event and
  exiting-frame owners before publishing any transition. Related controls pass:
  70 transactional/source checks, 13 immutable-policy checks, eight final ownership
  controls, 28 routing/certification checks and 47 broader composition checks
  (overlapping populations; zero failures/skips).
- **Promises now share the execution controller with Number, Proxy and binary
  memory source protocols.** Producer
  `7735421985dc2c71c9817ce4273a75978bf17805` adds the common bridge and a recurring
  Promise-executor → Number → Proxy → memory → join/await source case. Fifty
  targeted checks pass, including independent source comparison, source recheck
  and checkpoint recovery during nested memory work. Six frozen wire examples
  and contract/interoperability digests remain byte-identical. The declared
  interoperability population is now **31 cases**; its fresh full native and cost
  runs are pending. Iterator/map integration is active; construction, generators,
  cleanup, enumeration, general async protocol callers and rich host input remain
  separate qualification work.
- **The complete earlier 30-case admission attempts are preserved.** Producer
  `13070721a02b8e052112d2b259eb8de8a5400c4f` / consumer
  `3a0eb90e3e7282e9b3cb2ca0da27454451b50e21` produced 30 source passes but only 26
  native admissions: four direct Promise/host/callback receipts were rejected.
  Producer `1227eb88e0ed72efa6eb9c62136dc498ecaed2bd` fixes the direct evidence
  identity boundary with 16 refusal/positive controls. The fresh corrected pair
  `6888ca122460d3456f275dee4add9b61ba56b6f9` /
  `c0ac528a5db70de51fb77f38ead88974c0fa386c` then passed **30/30 source checks and
  30/30 native admissions** using the actual pinned tokenizer. This is engineering
  admission with zero optimizer work and no model-learning claim.
- **Cost qualification exposed and fixed a separate callback replay defect.**
  The corrected pair's cost run measured 28/30 cases and retained two failures;
  native packing was measured for all 30. Producer
  `9a9c270ec835e77a5f5b8576f1d4d1f40d0c308f` prevents replay from synthesizing a
  callback closure ahead of its recorded observation. Eleven focused controls
  pass; fresh full-pair costs remain required. Complete failed and corrected
  artifacts, receipts, inputs and logs are committed under
  `docs/evidence/semantic-v8-admission-20261121/` in
  `af36310a3b567cd0ed7baaf019990f57eb697a4c`.
- **Ordinary V8 admission and distributed lineage are implemented.** Consumer
  `c0ac528a5db70de51fb77f38ead88974c0fa386c` applies strict policy, corpus and
  actual-tokenizer checks to ordinary readiness and explicit production recipes;
  57 affected tests pass with zero failures/skips. Consumer
  `a2373660a4653ca5ab485c82bf453f1755e0dc1a` carries admitted corpus and stream
  identity through coordinator initialization, worker HTTP handshake, stage
  bootstrap, resume, export and served reload. The final eight lifecycle, lineage
  and entrypoint controls pass with the real tokenizer, including substituted
  identities and export refusal before weight loading. Unit source-verifier
  boundaries are explicitly injected: full-source ordinary preparation, two real
  optimizer steps, resume, export and serving qualification at the new pair is
  still required; production-scale parity remains open.
- **V8 replay and normal entrypoints no longer require legacy wire imports.**
  Consumer `721748f6c7867bd6eabea81b6b6b5a90a6ed9964` extracts neutral JS primitive
  and heap semantics; 76 core regressions pass. A fresh blocked-import process
  replays **32 fixture examples / 1,181 contexts**, including prefix/checkpoint
  recovery and malformed-state refusal. Consumer `a2373660a4653ca5ab485c82bf453f1755e0dc1a`
  extends absence controls to preparation, fitting, normal training resume,
  export and serving while retaining rejection of unexpected legacy experiment
  checkpoint state. Installed-package absence and complete default cutover remain
  separate gates.
- **Conformance and recurring CI gaps are being closed.** Producer
  `21ad98f1792f9ccb3eab67aa17a1eb461df5d7af` preserves hashbang placement when
  adding strict mode to original Test262 scripts; all 18 runner/campaign controls
  pass, including five JavaScript line terminators. Producer
  `fe1eae67cb1c91295582dc1e40afdaa38dd2c103` derives old-native CI consumer checkouts
  from their checked policy. That exposed an existing conditional-probe capture
  lacking explicit legacy admission; a legitimate pinned cohort/configuration
  repair is active. The V8 workflows are being expanded to select the newly
  named lifecycle, policy, lineage and import-absence tests, with exact current
  paired revisions and their existing zero-skip gate.
- **Remaining finish lines:** complete edition coverage and original-script
  campaigns, general composable protocol/effect/async source support, production
  lifecycle parity, independently readmitted final corpus, frozen held-out model
  studies, durable host ingress, actual-head CI, installed absence, deployment,
  restore and rollback proof. No learned quality, release readiness or default
  cutover is claimed. Historical receipts retain their original identities.

## Overall progress

### Execution order and active priorities

This order follows the user's hardest-first instruction. Dependencies determine
which difficult work can be made concrete now; these priorities are not a
completion percentage or schedule estimate.

| Priority | Difficulty | Work | Next acceptance evidence |
| --- | --- | --- | --- |
| 1 | High to very high | Shared execution state, unique source-event ownership, protocol → host → callback → protocol and effect-safe recovery. | Transactional ownership, mixed shared-state and failure cases, exact independent source/native admission and restore with no duplicate external work. |
| 2 | High to very high | General Promise/async/module scheduling and retained environments, realms, dynamic code, Proxy/internal methods and advanced profiles. | Native differentials and retained-state controls, followed separately by public/source/native promotion; explicit host and observation rules. |
| 3 | High | Ordinary training/serving parity, production admission and distributed checkpoint/export lineage. | Normal recipes and lifecycle commands with real pinned assets, exact causal records and restored state, strict identity refusal controls. |
| 4 | High | Complete edition scope, conformance runner and full-denominator language campaigns. | Retained annual specification bytes, exact suite and execution modes, reconciled applicability and failure inventories, no unsupported rows hidden. |
| 5 | High | Collections, construction, iteration, binary/text intrinsics and remaining edition families. | General mechanisms and cross-feature cases, original-source checks, independently admitted continuations and declared resource boundaries. |
| 6 | Dependency-gated | Regenerated corpus, held-out model studies, default cutover, legacy removal and operational release proof. | Final exact pair, ordinary optimizer/resume/export/reload, measured learned quality/cost, installed absence, deployment/restore and rollback qualification. |

The 17-package tally below remains the acceptance ledger. A delivered increment
does not close an entire ranked item or work package.

**0 of 17 work packages complete.** Work packages may contain delivered increments
without satisfying their complete exit gate. The status table must not conflate
owned execution, public representation, independent native admission, training,
serving, and measured learned success.

| # | Work package | Status | Required completion evidence / remaining work |
| --- | --- | --- | --- |
| 1 | Frozen scope, denominator, parity inventory | In progress | Annual HTML and full Test262 catalog are pinned; a source-reference audit preserves every variant and maps exact anchors/feature tags for review. Edition membership/applicability still require explicit decisions. Reconcile real-source inventories and runtime identities; preserve unselected rows; map every production V6 route to a replacement test. |
| 2 | Qualified Test262 runner | In progress | Original scripts, isolated native references and a bounded original-module owned-lowering path now retain pinned harness/dependency bytes and negative/async/TLA controls. Remaining: complete module semantics and source correspondence, fresh realms/agents, separate early-error qualification and complete upstream applicability/failure reconciliation. |
| 3 | Neutral JS execution state | In progress | Extract typed values and transitions; preserve all current state and lifecycle behavior; equivalence tests. |
| 4 | Direct V8 detail and source certification | In progress | Own detail/context/checkpoint schema and direct compilation; no V6 witness artifact or old episode replay. |
| 5 | Independent native V8 semantics | In progress | Direct detail, observation, effect and primitive paths plus installed import controls are delivered. Remaining: complete contract ownership and paired language-family semantics, broader malformed-state controls, final current-pair absence/replay proof. |
| 6 | Composable source projections | In progress | Unique event ownership and atomic private/public rollback are implemented for current adapters; map callbacks now compose finally/throw and generator creation/yield. Remaining: general IteratorClose/abrupt cleanup, cross-family ownership and exact source/native qualification of the expanded population. |
| 7 | Protocol/effect/lifecycle composition | In progress | Protocol → effect → callback → protocol, reentrancy, guest errors, cancellation and restore with independent source/native checks. Coordinated driver/model/host recovery now preserves acknowledged history and budgets. |
| 8 | Ordinary V8 training admission | In progress | Strict preparation, ordinary readiness, recipe/loader/config/stage/resume gates are implemented. Remaining: fresh command-level qualification of the expanded source population and production recipes with the exact final assets; source eligibility remains distinct from learned outcomes. |
| 9 | Canonical selected serving and live restore | In progress | Acknowledged state, random/budget state, registered private snapshots and per-arrival durable intake with later-tail recovery are implemented. Remaining: accepted-model-record end-to-end recovery, return-value callback continuations, child/reentrant work, missing later public history, bounded log rotation/distributed ownership, and final source/native/no-redispatch operational proof. |
| 10 | References, coercion and abrupt operations | In progress | General references, property keys, guest error objects, partial effects, nested binding and cleanup; source/public/native/restore cases. |
| 11 | Promises, async and scheduler | In progress | Adoption order, repeated thenables, getter/throw/first-call/finally behavior; public/native transitions; combinators, async functions/generators and module interactions. |
| 12 | Collections, construction, Proxy and iteration | In progress (bounded families) | Sparse/effectful arrays, collections, internal methods, private accessors, iterator consumers/delegation and checkpoint behavior. |
| 13 | Modules, persistent sessions, TS and host graphs | In progress | Per-module evaluation and sibling TLA scheduling, cycles/live bindings/namespaces/imports, persistent restore, emitted-JS provenance and host graph/lifecycle parity. |
| 14 | Binary memory, RegExp and remaining intrinsics | In progress (bounded families) | Resizing/detachment/transfer/species/coercion, complete selected text/numeric families and iterator helpers, declared resource boundaries. |
| 15 | Edition long tail and separate profiles | Not started | Dynamic eval and realms, applicable Annex B/Intl, weak references/finalization, shared agents and memory constraints; separately pinned later additions. |
| 16 | Data, ordinary model lifecycle and studies | In progress | Regenerate and independently readmit corpus; optimizer/update/resume/export/reload; complete retained bundles; frozen held-out and comprehension studies; honest quality/cost gates. |
| 17 | Coordinated default cutover and operational proof | Not started | Complete parity first; change defaults/remove legacy; freeze final pair; actual-head CI, installed absence tests, release restore, effect-safe rollback/deployment qualification. |

## Initial regression targets

- [x] Owned-runtime Promise adoption preserves competing microtask order (`dqa`); public/native expansion remains open.
- [x] Owned-runtime repeated thenable identity can fulfill; public/native expansion remains open.
- [x] Bounded acyclic owned top-level-await modules begin independently (`abAB`); public/native scheduler projection remains explicitly unqualified.
- [x] A selected capability shard retains every catalog row and marks other rows not selected.
- [x] Ordinary training rejects unadmitted or policy-mismatched V8 data even when
  the generic unverified-data option is enabled.

## Acceptance and reporting rules

1. Record tests with their exact scope, revisions and result. A parser acceptance
   or owned-runtime pass does not imply public/native/data admission.
2. Mandatory but unimplemented edition features remain inside the full target.
   Intermediate release requirements are separate fields, not a smaller edition.
3. Never relabel a resource limit, unavailable asset, unsupported case or skipped
   test as a pass. Preserve failed attempts and their reproducible inputs.
4. Representation cutover must preserve existing production capabilities. Default
   routing cannot change until replacements pass; learned selection remains
   experimental until its separate quality gates pass.
5. Each contract-changing increment updates paired contracts/fixtures and affected
   consumers. Requalify after executable changes; don't reuse old receipts as new.

## Incremental delivery record

- Initial checkpoint: retained both requested plans, recorded exact merged
  baselines, created paired branches and the full 17-package remaining-work tally.
  No new semantic or conformance result is claimed by this documentation commit.

- Coverage selection increment: capability shards now retain the complete catalog,
  publish separate population/selection identities, reject invalid selections,
  and mark all unselected stages explicitly. `node --test
  test/capability-ledger.test.js`: 11 passed, zero failed/skipped, including the CLI.
  This closes the selected-shard defect, not the full edition inventory or runner.

- Promise runtime increment: actual adoption/reaction jobs, per-assimilation
  resolver ownership, repeated finite thenables, callable finally cleanup jobs,
  and async callback return ordering. 27 existing Promise tests and 11 new
  differential/restoration/malformed-state tests pass. A nonterminating chain
  remains a resource outcome and mutual adoption remains pending. Public/source
  and native admission guards are unchanged; this is owned execution evidence.

- Frozen conformance catalog increment: verifies exact acquisition bytes, expands
  strict/sloppy/module/raw variants before selection, excludes fixture files from
  standalone counts, binds harness/module/resource identities, and retains missing
  assets and malformed metadata. Campaigns retain original failure attempts,
  invalidate downstream evidence on retries, and reject incompatible resumes or
  forged stage histories. `node --test test/test262-catalog.test.js`: 10 passed,
  zero failed/skipped. The retained 42-file snapshot is not the full upstream suite.

- Direct detail foundation: V8 JS encoding/decoding now owns its canonical wire
  client and uses a version-neutral typed operation schema. Legacy JS detail and
  witness clients consume that shared schema without changing their bytes.
  Paired Python extraction separates canonical JSON and typed semantics from old
  wire modules; native V8 detail and observation envelopes validate directly.
  Dedicated absence controls block legacy wire imports in each new codec.
  JS: 27 region/scheduler, 14 detail/causal, 10 historical detail-training checks
  pass; V8 contract regeneration is byte-identical. Python: 39 existing focused
  checks and 12 direct-detail/prefix checks pass (overlapping populations).
  Remaining: selected execution, source certification and effect receipts still
  contain legacy dependencies; this is not a completed representation cutover.

- Promise getter increment: synchronous and reentrant `then` lookup now retains
  the caller, receiver, pending return/await, resolver capability and combinator
  position. Getter/Proxy exceptions become guest rejection, including async
  getter and finally-result interactions. Thirteen new differential and restore
  tests pass; the broader 76-test Promise/runtime/source suite also passed.
  Public/native promotion and arbitrary iterable/species support remain open.

- Owned Test262 runner increment: strict and sloppy scalar variants run without
  wrapping the original test body; directive prologues remain intact. Parse
  negatives cannot pass on compiler refusal; runtime negatives require verified
  guest error completions. Resources and host defects are separate dispositions.
  Combined runner/catalog controls: 32 passed, zero failed/skipped. The official
  harness and broad original-script execution remain a subsequent gate.

- Complete Test262 acquisition increment: exact Git tree/blob checks cover the
  pinned upstream revision `d53ebc8b1931d9f1541e43d59650776e4b766248`.
  The inventory contains 53,616 tests, 294 fixtures, 43 harness files and 21 other
  resources; 102,994 execution variants are frozen before selection, with zero
  unresolved metadata records and no missing official harness assets. At this
  historical catalog checkpoint the specification bytes were not yet pinned;
  every variant remains unrun and edition classification remains unclassified.
  The annual specification pin and byte verification are recorded in the active
  continuation above. Catalog digest:
  `2e1c7727c58d41822edaac2294761baa550a8ad7be8f5dcfedbfc7b779457299`.
  Acquisition/catalog controls: 12 passed, zero failed/skipped.

- Typed selected-state increment: the transactional controller now consumes
  version-neutral typed records. Historical V6 and direct V8 wire clients share
  those transitions without translating V8 records through V6. Continuation
  reconstruction preserves each client's own packet schema and history. Typed
  input rejects accessors/proxies without invoking them, snapshots caller data,
  and preserves shared realm map identity on rollback. Five new parity,
  broker/await, rollback, restore and legacy-import-absence checks plus existing
  controller/lifecycle/wire checks pass: 129 tests, zero failed/skipped.
  The first broad check found a legacy error-label regression from the schema
  extraction; the wire adapter now restores its own diagnostic prefix and that
  check passes. V8 lifecycle/source routing still needs migration to this core.

- Original-script foundation: official pinned `assert.js`, `sta.js` and named
  harness dependencies are retained byte-for-byte with their license and lock.
  Each harness/test script enters separately, preserving source bytes, strictness,
  global lexical cells and declaration timing. The `script.enter` transition has
  an independent structural validator and replay rule; forged source/state/order
  and prior-script failure are covered. The original official assertion harness
  passes a true assertion and produces a guest failure for a false assertion.
  Combined script/selected/Test262-runtime controls: 27 passed, zero failed/skipped.
  Full original-source Test262 runner, async completion and Error-constructor
  identity qualification remain open.

- Official-harness host prerequisites: original `assert.throws` now observes owned
  Error constructor identities; ordinary `in` checks descriptor presence, Symbol
  keys and supported prototype ancestry without calling accessors. Original async
  `doneprintHandle.js` publishes a bounded, independently validated print journal
  after owned Promise jobs. Thirty focused host/script/runner checks pass, with
  zero failed/skipped. These are bounded owned capabilities, not full `in`, async,
  Test262 host, public/native or edition qualification.

- Ordinary V8 training increment (consumer PR 38): exact producer/consumer,
  registry and tokenizer policy; fresh preparation CLI; normal shard/batch checks;
  complete normalized episode reconstruction; resume policy pinning; unknown or
  missing semantic-schema, unverified-target and byte-fallback refusals. Five
  focused checks pass. The positive unit fixture injects source/tokenizer audit
  boundaries explicitly; it is not evidence of real pinned-asset admission.
  A separate bounded CPU optimizer/checkpoint/resume test is being qualified.

- Owned module scheduling increment: acyclic parallel TLA uses retained per-module
  generator environments, dependency counters and ordered async-parent release.
  Native original-ESM differentials cover sibling/diamond/ancestor order, thenable
  jobs, lexical TDZ/live cells and failures before/after await. JSON VM restore
  preserves instantiation, suspension, queued completion and reversed sibling
  host-input delivery without redispatch. Single-chain completion jobs are fixed.
  Original JavaScript now bypasses an observed TypeScript 5.9.3 emitter duplication
  while retaining exact identity maps; typed TS retains pinned lowering/provenance.
  Eighty-five focused module/TS/source tests pass, zero failed/skipped.
  Public/native promotion of the new async scheduler is explicitly refused, even
  if saved metadata lies about the strategy. Async SCC cycles, namespace exotics,
  dynamic imports, host loaders and the durable session API remain open.

- Direct V8 lifecycle and serving increment: selected lifecycle, record rendering
  and model orchestration now share neutral cores. V8 owns its detail, lifecycle,
  continuation and checkpoint clients; compact regions produce typed transitions.
  V8 effect intents preserve original V8 bytes, and result obligations use the
  direct V8 lifecycle envelope. Legacy clients retain their existing behavior.
  Five new tests cover callback reattachment without registration replay, durable
  acknowledgment before effects, uncertain-action restore without redispatch,
  rehashed forged-state rejection, and mixed/live V8 selection with the entire
  old wire stack blocked. Ninety-two combined core/source/lifecycle checks, five
  historical model-driver checks and one callback-boundary check pass (some
  populations overlap). Current six-example and twenty-source interoperability
  fixtures are freshly regenerated; a reproducible callback fixture generator
  reruns source checking without relabeling historical code-pinned receipts.
  Contract digest: `54d9769c22452263005bc9e6a5818ec5a1642325f91ef8d5661a45d71b56d298`.
  Remaining: direct source certification still depends on the historical compiler;
  protocol/effect composition and acknowledged live model-session restoration
  need their own implementation. No default cutover or full parity claim yet.

- Original Test262 runner/campaign increment: original official harness scripts,
  raw bytes, strict/sloppy variants, exact error identity and async completion
  run in fresh owned realms. Independent reference workers use disposable native
  processes with explicit time/heap limits. Missing hosts, unsupported operations,
  wrong assertions, infrastructure faults and resource limits remain separate
  non-pass results. Execution-profile rebinding preserves the full frozen catalog
  and never copies prior qualifications. Batched stage updates retain attempt
  history; campaign resume/check binds source, runner, parser, policy and code
  bytes. Root verification: all 27 original-runner, campaign, catalog and acquisition
  tests pass. The measured full-catalog campaign follows this durable checkpoint;
  this increment alone claims no edition conformance or public/native admission.

- Paired native lifecycle/training increment: direct V8 request and observation
  receipts replace the remaining V6 effect-witness calls. Fresh producer contract
  and region/protocol/callback fixtures are paired with 53 passing consumer tests.
  A bounded normal-loader CPU run saves actual optimizer moments and resumes in
  a fresh process from step one to step two. The test explicitly injects the
  source/tokenizer verification boundary: actual pinned-asset preparation, export,
  reload and learned quality remain unqualified.

- Live native restoration increment: the consumer service can checkpoint all
  acknowledged sessions and reconstruct them in a fresh runtime by rerunning
  the actual model under saved per-selection RNG state. Original fragment tokens,
  bytes, causal identities and a complete committed cache/retrieval/track-state
  fingerprint must match; ordinary native replay checks every accepted commit.
  Consumed attempts and pending/failed output evidence survive, while speculative
  candidates never become accepted restored history. Producer process transport
  now exposes checkpoint/restore, preserves its cost history and rejects false
  recovery receipts (12 transport tests pass). An actual tiny CPU model emits
  identical next tokens after fresh-process recovery; accepted-record and callback
  controls use a declared supplied decoder. Full host-resource recovery through
  the producer driver, actual trained-model/asset qualification and final default
  routing remain open. All six final native recovery controls pass, including
  failure cleanup, tamper refusal, fresh-process recovery and retained callbacks.

- Hosted CI follow-up at producer `ff7d1337d203544c102c053f4f270aa0ae58bd1b`
  and consumer `1a38fe50a7fb4e05a01240794eb6b6209fb0fb49`: 250 of 252 V8 tests
  passed; failures identified a stale V6 receipt reader in a test and a synthetic
  training fixture lacking the now-required family admission. These are being
  migrated without weakening ordinary admission. Selected-source CI also exposes
  the Promise-finally projection regression after owned scheduling was corrected;
  an explicit public-job mapping is required before that existing capability is
  qualified again. Pinned-oracle, real-source, inspection, and V7 CI lanes passed;
  this is not an all-green final-head result.

- Format-neutral source admission checkpoint: independent original-source
  reference checks and source identity authority are extracted from historical
  clients. The original admission/seed/rejection regression suite has 15 passing
  tests. Published producer commit: `a85916ec3f8c32a3374857a5e4c8902fd9bc9f72`.
  Direct V8 compilation and its absence controls are the next part of this work.

- Promise production regression repair: adoption and callable-finally forwarding
  are represented as distinct queued jobs, preserving dependencies and delayed
  settlement. All 14 historical effectful/synchronous-throw regressions and three
  new ordering, boundary-restore and tampering checks pass. Published producer
  commit: `076a5c3f94c1e8574d87efe0f80a161bbe44ddd7`. These preserve existing
  production behavior; general V8 adoption/finally promotion remains refused.

- Campaign recovery repair: resume preserves completed passes and failures and
  executes only unfinished stages. Explicit `--retry` appends new attempts while
  retaining earlier failures; partial path typos fail before overwriting evidence.
  All 17 campaign/catalog controls pass, zero failed/skipped. The first added
  interruption test exposed nondeterministic ordering between independent workers;
  its deterministic one-worker control now checks exact recovery without assuming
  a cross-worker completion order. No full-suite execution claim is made here.

- Direct V8 source certification: compilation, private admission and fresh
  rechecking now use direct V8 lifecycle/detail artifacts and neutral source
  projection. No V6 intermediate witness or legacy admission call is needed.
  Five new direct-source identity, effect/restore, wrong-schema, authority-isolation
  and resolved-import absence controls pass, alongside 37 existing focused
  projection/routing checks. Contract regeneration was byte-identical for this
  increment. Published producer: `9039d715a43f0b7ecd64b10eed9b5548d92d9915`.
  Historical receipts remain historical; affected source evidence must be freshly
  regenerated. Full source-projector composition and default cutover remain open.

- Shared primitive conversion foundation: Number and future PropertyKey conversion
  share an owned resumable ToPrimitive kernel. Getter lookup retains its waiting
  and returned phases; independent validation checks hints, fallback order and
  result binding. Four new getter/nested-call/throw/restore/tamper tests, five
  existing Number tests and 13 arithmetic tests pass. Published producer:
  `220470b19f6e3cbd31a0daf3cdfd112c9f492816`. Cached PropertyKey references and
  their runtime/frontend integration are the next increment; general
  source/public/native promotion is not claimed.

- Coordinated selected-driver recovery: a dedicated native model session and
  host lifecycle checkpoint are bound to the original causal contexts, selected
  bytes/tokens, complete initialization identity and consumed prediction/retry
  budgets. Recovery verifies the external policy and replays public history
  before native restoration; uncertain effects never redispatch and lost
  subscriptions reattach without registering again. Four new supplied-decoder
  orchestration controls pass; the combined driver, transport and lifecycle
  population has 35 passing tests, zero failed/skipped. The identity-binding
  extension was rerun against all four recovery controls. These controls are
  distinct from actual CPU model reconstruction in the consumer and do not
  establish learned quality. Multi-driver atomic recovery, application storage,
  arbitrary external handles and final deployment qualification remain open.

- Retained property references: reads, method calls, simple assignments, compound
  and logical assignments, updates, computed literals and destructuring use the
  shared conversion kernel. Continuations preserve the original base/key/RHS,
  callback receiver, conversion hint and cached primitive key. Independent checks
  cover nested calls, throws/finally, host blocking, JSON restore and forged
  state. Final focused conversion run: 22 passed, zero failed/skipped. A broader
  run's source-refusal failure identified an admission hole, which was fixed and
  rechecked. Published producer: `0b8e43ea3a55184258bc05bdadbc9508e333bddb`.
  Node 24's repeat-conversion discrepancy is recorded separately from pinned
  ES2026 semantics; new PropertyKey source/public/native promotion stays refused.

- Recovery policy review: host generated-record/outstanding-effect limits and
  callback auto-delivery now belong to the externally expected policy. Snapshot
  creation refuses policy mutation; restoration checks retained host limits before
  opening the native model. All four focused recovery controls passed again,
  including custom limits and rehashed host-policy mutations. These exact edits
  were recovered through GitHub after the executor outage. The locally committed
  mixed-protocol changes additionally preserve pure-protocol limits/delivery and
  live service bindings, but those changes remain unpublished.

- Ordinary training lineage: normal V8 checkpoints retain exact preparation
  policy, prepared manifests, corpus/stream, tokenizer, chunking and contract
  identities. Exported serving bundles bind those identities to the training
  checkpoint, weights, configuration, memory bank and step. Reload rejects missing
  or inconsistent proof and generic byte-codec substitution. Four new controls
  plus 27 ordinary-training/resume/serving checks passed before the outage.
  Tokenizer verification is explicitly injected in the metadata unit fixture;
  this is not real-asset or learned-quality qualification. The exact production
  tokenizer was acquired with its expected SHA, but the complete real-asset run
  has not happened. Published consumer:
  `9c83827a269965c76e341ae2afd8e53fdbe66680`. Hosted formatter feedback was applied.
  Native serving identity binding and the known train/serve history mismatch
  remain open.

- Mixed composition checkpoint (local only): three source/public-checked cases
  combine Promise joins, asynchronous host work, retained callbacks and
  callback-owned jobs. Shared heap identity, job ownership, result obligations,
  original live service bindings, callback policies and custom limits survive
  verified replay/restore. Rehashed ownership/history changes and uncertain
  redispatch are refused. Local `d9a3ce4` passed 31 focused controls across the
  final relevant runs and fresh generation of six base, twenty protocol and
  three host cases. Native root join/host replay passes; callback obligations
  and callback-owned dispatch pairing still fail. General shared pending-Promise
  readiness and declarative unique-ownership source composition remain open.

- Invocation-owned native joins: join metadata now binds its owning invocation;
  native validation rejects foreign jobs and cross-owner execution while retaining
  shared-heap joins after a callback returns. Nine focused join tests pass,
  including new owner-forgery controls. Published consumer:
  `9a98149372fe494e7ad84fc712fa62dcf69f4c79`. Mixed fixture regeneration and full
  callback/host replay remain under active qualification.

- Training-to-serving identity binding: normal exported V8 bundles now provide a
  validated training-lineage identity to native initialization, selection and
  staged restoration. The producer requires the externally expected identity and
  retains it in the frozen experiment and recovery policy. Missing, wrong and
  rehashed identities are refused; declared diagnostic bundles retain explicit
  null. Fourteen focused consumer checks and 26 producer transport/study/recovery
  checks pass; these counts describe the separate affected suites. Published
  producer `a4d0a56ef5b5b0ab1c1768ed16b15194630a0e89`, consumer
  `c4900205dd625bef8ba21e36ff21e1f48e832688`. Actual pinned-asset lifecycle and
  training/serving history equivalence remain open.

- Conversion regression maintenance: replaces the obsolete runtime refusal for
  getter-selected Number conversion with independent native-result and archive
  replay checks, while retaining the separate training-projection refusal and
  unsupported Proxy conversion boundary. `node --test
  test/training-number-conversion.test.js test/owned-primitive-conversion.test.js`:
  9 passed, zero failed/skipped. Published producer: `ef4be405c8a41f06eb053c0cf21c9246da7ad219`. This does not widen public/native admission.

- Conformance accounting edge cases (`6cedbe4ee6f34b85d7dc588d23942f7a104217c3`):
  original-byte limits apply before reference parsing, including expected parse
  errors, and the strict directive does not consume the input budget. Capability
  analysis preserves parameter/body, switch/case, static-block and computed-class
  receiver scopes. Fifteen runner/capability checks and seventeen campaign/catalog
  checks pass, zero failed/skipped in each suite. No full-suite conformance claim.

- Cyclic owned module evaluation: `ce1df94b601a4c95429a15b49597f3333b8df366`
  retains DFS indices, SCC roots, dependency order, per-module evaluation state
  and abrupt completion. `e6b9d9150897f3547c714a6010704329617460a6` adds
  JSON suspension and both sibling host-result delivery orders. All 26 scheduler controls pass, including the cyclic, unresolved-evaluation,
  suspension and host-result recovery cases; no failures or skips. Public/native cyclic scheduler projection remains explicitly refused.

- Native mixed-controller and readiness increments: consumer
  `53208e9fe0bf1b5ce3c36010144f98fb361df325` retains callback controllers
  and exact host/callback obligations; `ce3f4304a7b5328d926dc2680257dde6fe327e6e`
  orders shared-realm dependency readiness and enforces the active turn.
  Forty-six focused native controls pass, including shared-readiness and callback
  retirement controls. Two current mixed source examples independently match all
  46 and 43 contexts respectively; this diagnostic excludes tokenizer/mask/source
  admission and does not yet qualify the final three-case artifact.

- Training/serving chunk parity: consumer
  `7da2150adaf5501338d73f82a41a9058a5bd1937` uses the prepared chunk
  policy when serving observations, even when the model has greater capacity.
  An actual CPU comparison with prepared chunks of 128 positions and model
  capacity 512 matches history IDs/tracks, controls and internal state tensors.
  Twenty related model/policy/chunk controls pass; this is distinct from learned
  semantic correctness.

- Native host/microtask ordering: producer
  `892932b56c806a532bba66aaae2a616b0e569ad1` yields between guest
  microtask groups while preserving a current job across synchronous native
  transport. Twenty-three native/callback/subscription and 57 affected
  runtime/replay/source/session controls pass. The original callback-owned join
  correctly returns 0 before its later callback stores 6; explicitly awaiting
  that callback's Promise returns 6. The independent original-source oracle was
  unchanged.

- Direct host-source admission: consumer
  `05dd2f049d5ebf5c828a41b1c1bdecb8e372d624` carries direct source
  identity through ordinary preparation, native admission and the normal loader.
  Rehashed/missing authority and relabelled identities are refused. Twenty-two
  focused metadata/admission/training controls pass; two live-source controls
  were explicitly skipped pending the clean final paired producer. Injected
  verification boundaries in unit fixtures remain labelled.

- Actual pinned-asset ordinary lifecycle: consumer collector
  `ba598055a04c58df020fe3f567698e4e8983ac73` and retained evidence
  `e84027df26943f045fd771831add6cf5f6b9b155` qualify exact producer
  `a4d0a56` / consumer `7da2150`. One family is independently admitted
  with the actual pinned tokenizer, normal diagnostic-purpose training advances
  optimizer step 1 to 2 in separate processes, and ordinary export/reload binds
  the saved lineage. All 315 optimizer moment owners advance and 303 weight
  tensors change. Real service identity controls and fresh-process next-selection
  recovery pass. One attempted paired model execution is rejected; zero executions
  complete or source-validate. Complete transcripts, manifests and reproduction
  commands are committed in
  [the consumer evidence directory](https://github.com/werg/megatoken/tree/e84027df26943f045fd771831add6cf5f6b9b155/docs/evidence/semantic-v8-ordinary-a4d0a56-7da2150).
  This is not held-out quality evidence. The 102.1 MiB complete local binary
  bundles still need durable external publication, and the combined new contract
  needs its own exact-pair qualification.

- Source-fixture repair: producer
  `756251ebcb302d72219e84c342273f7b5abf2929` freshly regenerates all
  twenty protocol source cases, the separate iterator case, six base examples
  and their contract/interoperability manifest without weakening the original
  validators. Source/iterator suites: 24 passed, zero failed/skipped. Full
  `npm run contracts:check` passes in a clean checkout of that revision.
  Paired native fixtures and policy pins require separate current evidence.

- Consumer CI selector repair: `6c6779597d0cf62d385112705b05804e788de970`
  replaces a removed V6 test selector with the existing V8 history parity
  regression. Three parity/chunk controls pass. The unit fixture explicitly
  injects source/tokenizer verification; this selector repair is not new
  actual-asset or learned-quality evidence.

- Callback replay retirement repair (`b190abf387ac5ebdb4b369545d91b4ddf3f77d1f`): result receipts now apply the same
  capability retirement as live execution. Call callbacks and failed
  subscriptions become revoked/closing; successful subscriptions stay active.
  Replay does not invent queued arrivals, handler-close receipts or native
  registration. Seven direct V8/callback checks and 29 historical lifecycle
  checks pass, zero failed/skipped in both suites. The callback interoperability
  fixture is freshly rebuilt from the original source and independently replayed.
  Paired native callback/serving controls pass; final protocol fixture pairing remains open.

- Mixed protocol/host recovery checkpoint: producer
  `a13760d03e084600f6e8875dcae557cd98501bf6`
  four independently checked source cases preserve root results 12, 7, 0 and 6;
  31 focused producer tests pass with no failures or skips. Exact shared maps,
  invocation-owned joins and globally ordered dependencies survive JSON restore.
  Host policy and live service bindings are retained, uncertain effects never
  redispatch, and unjournaled native arrivals explicitly refuse checkpointing.
  Actual receipt mapping handles result-triggered retirement and reconciliation.
  Settled result identity, terminal realm closure and delivered callback counters
  now reconstruct from acknowledged public evidence; queued callback values and
  counters stay outside model context. Native replay independently matches every
  record/context of all four cases and a separate controlled 24-row/10-context
  automatic callback recovery fixture. Real tokenizer masks pass all four source
  examples, but clean exact-pair source admission is still the next gate.
  The broader V8 run found one obsolete blanket host-refusal assertion; it now
  tests malformed authority and an active-realm conflict, and all four controls
  in that file pass. Broad-run completion remains separately reported.
  Details: [mixed host/protocol design](docs/SEMANTIC_V8_MIXED_HOST_PROTOCOL.md).
  Unique declarative event ownership, broader adoption/module promotion,
  durable ingress, general reentrancy and final deployment recovery remain open.

- Existing-consumer closure parity:
  `63b1c6215682bd149233d62e03b98add202e441a` validates explicit
  terminal realm closure in both V6 and detailed V7 paths and rejects reopening,
  unretired handlers, missing cancellations and forged authority. Fifty focused
  tests pass, including six new cross-version closure controls. The V6/V7 shared
  declarations are regenerated together with V8's new lifecycle record.

- Complete continuation-history parity: consumer
  `821f6b0ba61299e65ddfcb4da23c4cb11d4886bc` restores each earlier
  generated record's original request controls while reconstructing an ordinary
  training-window prefix. The new comparison exposed a real callback mismatch
  at prediction 14, the first target of a new training window; the fix makes all
  20 callback predictions agree with live recurrent state. The bounded evidence
  spans 35 physical targets (4 split-record, 11 host-result, 20 callback), rejected
  UTF-8 candidates, acknowledged-cache reconstruction, history eviction and
  window boundaries. The explicitly controlled decoder tests six distinct cases,
  all verified passing after correcting one test-only window-size guard; original
  failure logs and exact before/after scopes are committed. Learned correctness
  is a separate gate. Ordinary V8 production readiness, recipe registration and
  distributed export lineage are the next training implementation tasks.

## Paired consumer PR

https://github.com/werg/megatoken/pull/38

## Published branch checkpoint before this source increment

- Producer: `52ea51c92500288535d9845ec31392fb6ce8cc51`.
- Consumer: `8772c0d9d3be16c848365594d0fe49273e328090`.
- The main PR description records the resulting published producer SHA; the current commit adds source composition and pins the consumer above.
- Latest complete source/native/cost pair: producer
  `7b2a75621233dd86b2c5c13616df479cf443effb` / consumer
  `31e5688f81cd951384d9b6bcafc1421d43babdff`: **32 declared, 32 source-qualified,
  32 native-admitted, 32 exact-token and native-packing measurements**, actual
  pinned tokenizer, plus exactly two ordinary optimizer updates, fresh-process
  resume, export and real service restoration with zero acknowledged semantic
  records. Later executable changes require their own qualification;
  no release/default-cutover or learned task-success gate is closed.

## Historical hosted-check observation

Consumer `351c8f7` completed both Python CPU suites, i18n, installed-wheel absence
checks and source/native/bridge workflows successfully. The GPU Blackwell job
was skipped. Consumer `812e8be` then failed both V8 population jobs at contract
comparison against an older pinned producer; `31e5688` corrects that checkout
and adds ordinary lifecycle qualification. Current-head results remain pending.
These observations do not qualify a later producer/consumer pair automatically.

### Historical hosted-check checkpoint

Observed hosted checks for producer `6888ca122460d3456f275dee4add9b61ba56b6f9`
on 21 November 2026: owned-corpus audits, semantic inspection, selected harness
and specification-reference checks passed; paired V8/V7 and Node suites were
still running. Five older native-import jobs and input parity refused a
consumer revision different from the admission policy; release restore then
had no completed archive to restore. Producer
`fe1eae67cb1c91295582dc1e40afdaa38dd2c103` corrects the two checkout workflows
to read the exact policy revision directly. Extracted workflow steps and all
three release-selection controls pass locally. Hosted requalification remains
required. No all-green final-head or release result is claimed.

## Current paired admission checkpoint — 20 November 2026

- Consumer `328a0c4` retains the regenerated V8 contract and complete source interoperability snapshots. Producer `b16bb26` pins that consumer for V6/V7/V8; corresponding schema, fixture and interoperability digests now agree. Consumer `3a0eb90` updates its three source-check workflows to that producer. These are paired-input fixes, not completed qualification.
- Full producer V8/region regression on `a13760d`: **377 passed, zero failures, zero skips**. Existing selected-runtime CI also exposed one assertion expecting the old validation error; the malformed authority is correctly rejected earlier by the strict schema check, and the assertion is being aligned with that exact refusal.
- Actual mixed-source admission exposed a real entrypoint gap: the new `semantic-protocol-host-region-evidence/1` schema is not yet handled by the native-source CLI and consumer source-binding path. The original refusal is retained; no admission success is claimed. Both paths are being corrected with source-identity and tamper controls before regenerating fresh exact-pair receipts.
- All **17 packages remain open**, including full edition scope, event-level projection integration, production training/export lineage, model quality and final release gates.

## Delivered continuation — 21 November 2026

- Producer `444e6027d6c9ad6c9159e5083abe0dbfa82d528b` — atomic direct-protocol source publication.
  Ten adapters declare and restore their private retained state; Number callback
  frames, array-map aliases, iterator/generator plans, construction, completion,
  Proxy and binary-memory state participate in event staging. Every pre/post
  observer runs even if another rejects. The array-map mutation guard now runs
  before dispatch so an earlier adapter cannot bypass it. Four new controls and
  70 existing source controls passed with zero failures/skips. Original public
  records and source/native admission requirements are preserved. Remaining:
  declarative ownership in this projector, exact-pair native admission and the
  full composition package. Details: [source ownership](docs/SEMANTIC_V8_SOURCE_OWNERSHIP.md).

- Producer `39009dd2dbd3c34a01a97e834472a75cf7eca40f` — immutable ownership declarations,
  safe descriptor-only copying and refusal before caller accessors or Proxy traps.
  Thirteen focused coordinator/composition checks passed.
- Consumer `721748f6c7867bd6eabea81b6b6b5a90a6ed9964` — independent V8 primitive replay:
  neutral helpers, 76 core regressions and a fresh-process import blocker covering
  32 fixture examples / 1,181 contexts with prefix and checkpoint recovery.
- Producer `1227eb88e0ed72efa6eb9c62136dc498ecaed2bd` — accept direct host evidence only
  with exact fresh source-identity verification, rejecting missing, altered or
  dual source authority. Sixteen focused receipt/process controls passed. The
  earlier clean 30-source / 26-native result remains a failed attempt; requalification
  is still required.
- Consumer `c0ac528a5db70de51fb77f38ead88974c0fa386c` — ordinary readiness uses the
  same strict V8 prepared-data policy as training; explicit V8 recipe selection
  and a production launch example retain teaching, evaluation, checkpoint and
  distributed-worker requirements. Fifty-seven affected tests passed with no
  skips; pinned tokenizer checks executed. Complete production parity remains open.

- Producer `6888ca122460d3456f275dee4add9b61ba56b6f9` — direct protocol source
  ownership resolves every current allocation, event and exiting frame before
  preparation or mutation. Missing/ambiguous/declined owners roll back; reversed
  adapter registration produces identical records and certificates. Normalization
  no longer inherits host prototype names as property-version counters. Final
  controls: 8 ownership/transaction, 28 routing/certification, 47 composition,
  all passing with no skips; these populations overlap.
- Exact clean pair `6888ca122460d3456f275dee4add9b61ba56b6f9` /
  `c0ac528a5db70de51fb77f38ead88974c0fa386c` — **30 declared source cases, 30
  source-certified, 30 independently native-admitted** with pinned tokenizer
  bytes. This includes all four direct mixed Promise/host/callback cases that
  failed in the earlier 30/26 attempt. Costs and ordinary lifecycle are separate
  gates; no model generation or optimizer updates occurred in this run.
- Producer `fe1eae67cb1c91295582dc1e40afdaa38dd2c103` — older native CI and input
  parity read their consumer commit from the existing admission policy, removing
  a duplicated stale literal. Exact-revision verification remains enforced.

- Producer `9a9c270ec835e77a5f5b8576f1d4d1f40d0c308f` — reconstruct causal training
  contexts in recorded replay mode, preventing duplicate live handler-close
  observations when callback-owned Promise jobs finish. Eleven causal
  serialization/selection checks pass, including both previously failing real
  sources and forged-host/context refusals. The original 28/30 cost failure is
  preserved; the patch does not relabel it as a pass.
