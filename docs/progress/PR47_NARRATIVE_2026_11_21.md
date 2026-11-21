# PR 47 historical progress narrative

This is an unchanged snapshot of the full PR description before its current-progress consolidation on 21 November 2026. Later measurements are recorded in the live PR and implementation ledger. Historical statements retain their original revisions and time of writing.

---

## Verified progress — 21 November 2026

**Published implementation/evidence: producer `455b44d06e3b6fddb5f3ed39b5a3f3be0a1c91a9`; consumer `1ddcc6110d70703f6b08244d53ec461047677bec`. Both PRs remain drafts. 0 of 17 complete acceptance packages are closed.**

The complete remaining-work tally below is retained. Measurements name their exact revisions; evidence on an earlier tree does not automatically qualify later changes.

### Latest implemented recovery and scope increment

Producer `19eba4f` preserves all concurrent implementation/evidence and adds:

- **Automatic durable selection boundaries:** opt-in saving of the initial cut, each acknowledged selection, consumed stale attempt and native completion. Independent journal rereading and the application's durable head acknowledgement finish before another prediction, external dispatch or successful completion. Storage/read/head failures stop execution; a lost acknowledgement recovers from the independently retained head.
- **Cancellation ordering and truthful outcomes:** selection, commit, stale rejection and completion settle before native cancellation. Driver and runner cleanup share one cancellation; bounded cleanup closes the transport. A late positive commit remains accepted, while an unreturned commit is explicitly unknown, including immediate forced-close accounting. Neither permits a late external dispatch.
- **Executed controls:** the earlier integrated set passed **96/96**; the final transport/driver/durability selection passed **44/44** after the unknown-outcome refinement. Following concurrent binding/journal integration, **45/45** affected controls passed. Counts overlap and are not additive. New actual-model automatic-boundary mode is implemented; the exact `19eba4f` / `9c557a7` run below now passes, retaining the malformed next-output refusal.
- **Source-based edition audit:** **8/8** integrated controls pass. All **102,994** catalog rows remain. Among 104 selected `import-defer`-tagged modules, 93 unexpected parse errors, two successful parse-negative tests and nine actual source parses remain distinct. Exact bytes identify 103 proposal-shaped cases and one ordinary default binding named `defer`; all membership remains unclassified and no denominator rows are removed.
- **Preserved concurrent repairs:** canonical legacy journal/input-wire recovery and source-ordered bindings are retained. The journal additionally rejects getters before consuming supplied checkpoints, with positive reordered-JSON and corruption controls.

The automatic mode does not cover arbitrary mutations, failed output, cancellation after the trusted cut, distributed ownership or log rotation. Incoming callbacks and external actions still require their durable mechanisms. These new controls use disclosed supplied decoders; the actual-service gates below retain their original measured revisions.

### Latest integrated regression results

The complete producer suite at exact `19eba4f` finished **2,404 passed, zero failed, six asset-dependent skips (2,410 tests)**; the separate reference fixture passed **8/8**. The six skipped legacy tokenizer/coordinator gates were then run separately with verified assets: **3/3 tokenizer controls** at policy-pinned consumer `3a0eb90` and **13/13 coordinator controls** at consumer `1ddcc61`, with zero failures/skips. The latter includes four controlled native engineering cases and an actual initialized-weight refusal control. Counts overlap; the original full run retains its skips.

The complete consumer selection at `39d5212` finished **611 passed, one failed, zero skipped**, in 805.66 seconds. It exposed a closed-session opening-receipt regression: valid JSON `1.0` was rejected where `1` is accepted. Consumer `1ddcc6110d70703f6b08244d53ec461047677bec` preserves the concurrent `9c557a7` binding repair and restores ECMAScript numeric equivalence, while rejecting boolean/fractional/negative/unsafe counts and invalid opening times before native allocation. **38 focused authority, closed-session and binding controls pass** on the integrated patch. The original failed full run remains retained; the complete selection is running on clean repaired consumer `1ddcc61` against producer `19eba4f`.

### Actual-model closed/sibling recovery qualified

The [published qualifier](https://github.com/werg/tracing-js-self/blob/dc7595e9a4764a3f6fceb4218fd01aa3192222e4/tools/qualify-v8-closed-sessions.mjs) passes on exact producer `dc7595e9a4764a3f6fceb4218fd01aa3192222e4` / consumer `1ddcc6110d70703f6b08244d53ec461047677bec`. A has **one actual producer/native-acknowledged record**. B emits **18 model tokens**, is refused for malformed output, and is cancelled without acknowledgement. A fresh service restores the complete active A and closed B cuts, all attempts/openings/RNG and costs. Reusing B's request is refused without model sampling or native-state mutation. A's next output is exactly the same provenance-bound **refusal**, never acknowledged. Original-source/projection/public replay checks pass; **zero host dispatches**, no new training, complete-program or held-out claim. Complete original artifacts are being retained. Restored cost totals include inherited checkpoint costs and must not be added without subtraction.

### Latest exact-pair verification — producer `19eba4f` / consumer `9c557a7`

The binding-order repair is published in producer `29e802f379b03375ed893dc133baf25dd15a4ba9` and consumer `9c557a7f1f509656ac231a0a08b17d2369763f96`. Both preserve declared parameter positions and use matching UTF-16 ordering for extra captured names; producer recovery canonicalizes the private delivery digest and preserves `__proto__` as an ordinary lexical name. The consumer preserves `39d5212`'s closed-session authority. Its three-case fixture is freshly source-rechecked at exact producer `29e802f`; the binding adaptation is separate from new source admission.

- **Full recurring population completed:** exact clean producer `19eba4f4ef273e15c126d6a35cb38db05156e2d1` / consumer `9c557a7f1f509656ac231a0a08b17d2369763f96` passes **47/47 source, 47/47 independent native, 47/47 exact-token and 47/47 packing checks**, covering 44 scripts and three original module graphs. Both trees stayed clean. There are 34 compact / 1,755 detailed records; detailed work consumes 55,388 of 56,597 generated tokens (97.86%). Flat context/observed tokens are 2,951,658, terminal tokens 1,789 and total tokens 3,010,044. Native packing has 6,920 physical chunks / 1,948 logical records and 3,013,123 context/observed tokens.
- **Fresh ordinary lifecycle completed on the same exact pair:** all 47 source/input candidates were frozen before execution. Prepare, train, fresh-process resume, export and real service restoration pass with **exactly two normal optimizer updates**. All 315 optimizer moment owners persist; 311 advance and 300 master tensors change. Omitted/null/substituted lineage is refused. Seven next-selection fields match after restore; one consumed attempt is restored with zero reselections or host dispatches. The original one-token output is an unterminated fragment and is **refused**: zero acknowledged model records, `learnedSuccess:null`. All 46 files / 157,778,439 bytes of fresh assets are being retained.
- **Actual-service explicit and automatic histories both pass on that pair:** each retains one acknowledged original model record and two complete cuts, closes the original service and restores from packet position 1 in a fresh service using independently retained head position 2. Complete host/native state, attempts and output evidence match; costs are monotonic and independent source/projection/public-prefix checks pass. The next output is **identical but malformed and refused**, unacknowledged, with zero host dispatch. Only the automatic run exercises automatic acknowledged-boundary durability; arbitrary mutations and unsaved cancellation remain separate.
- **Regression evidence stays revision-specific:** producer `29e802f` passes **106/106** integration controls plus fixture/contract checks. The consumer binding patch on prior `7ecda66` passes **125/125** focused controls. Combined published `9c557a7` then yields **34 passed / one failed**, exposing the valid-`1.0` opening-count regression. Authoritative published repair `1ddcc6110d70703f6b08244d53ec461047677bec` passes our **45/45** combined binding, closed-session, model-authority and actual-model restore controls, with zero skips. The failure and superseded parallel patch remain retained; earlier C9 measurements are not relabeled as C1dd.
- **Hosted evidence:** the `f652fb2` PR run passes **94/94 selected tests and 1/1 real Chromium test** on actual merge `cacb32263d164a483fef60277710e984521e719e`. Consumer `7ecda66` / producer `18e9ebf` passes **604/604**, all47 interoperability and separate11 gallery gates, and the ordinary five-stage/two-update lifecycle. General CPU jobs each pass **3,546 tests with 82 retained skips**, on their recorded merge revision.

**Public V8 entry is published in `455b44d06e3b6fddb5f3ed39b5a3f3be0a1c91a9`.** `tracing-js-self/semantic/v8` avoids the eager legacy aggregate; the unchanged typed-value formatter is shared neutrally. Its tested patch passes **34/34** controls, including an actual installed direct projection/replay/continuation with legacy clients absent. The actual installed full-source test exposed npm's omitted root dependency lock. A separate canonical shrinkwrap repair is being verified; the original missing-lock failure remains evidence and installed full-source acceptance is not yet claimed for the API-only commit.

**Original665 preservation is verified:** historical `012c9fe` / `39c4036` evidence published unchanged in baseline `f32c6fc` and current P19 have identical ordered **665 = 663 scripts + two modules**, exact source/input graphs and fixture metadata, excluding only producer revision. Zero additions, removals or changed fixtures; shared content digest `7713717c1d4e7df92adc30db90dfeef4c561d7864a2c901abd8673d3a2c5ef94`. The separate complete utility inventory stays78, of which27 are selected and51 are unselected. This preserves the denominator; a fresh full665 source/native/token/packing gate is next after the package repair. Internal neutral/source implementation is delivered, while complete population/lifecycle preservation and installed-package acceptance still prevent closing packages3/4.

### Newly completed measurements

| Gate and exact revisions | Result | What remains unproved |
| --- | --- | --- |
| Full installed consumer semantic selection: `0351fe9`, clean fixture producer `9fc1935` | **604 passed, zero failed/errors/skips**, using actual CPU dependencies and the production tokenizer. Earlier `84dee6a`: **579/579 passed**, separately retained. | Complete release/default routing and later runtime changes. |
| Full recurring population: producer `090e634` / consumer `0351fe9` | **47/47 passed in each source, independent native, exact-token and packing gate**; 44 scripts and three original module graphs, clean source trees. | Learned execution and serving performance were unmeasured. |
| Actual-model older-packet recovery: producer `070bad4` / consumer `0351fe9` | **One acknowledged model record, two saved cuts**. A fresh ordinary service restores the later cut using the older packet and independently retained later head; complete host/native state and consumed attempts match, costs are monotonic, and original-source/projection/public replay passes. | The exact next output is malformed and **refused**. It is not acknowledged; zero host dispatch; no full-program, held-out or generalization success. |
| Full producer suite: `090e634` | **2,353 passed, one failed, six skipped**, from 2,360 tests. Reference fixture **8/8 passed**. The failed legacy-journal case is retained. | This run remains failed after later repair; six external prerequisites have separate historical asset-backed runs. |
| Published journal repair: `b074e0e` | Tested patch `559193c` passes the exact hosted selected-harness list **94/94**, plus **25 canonical/history controls**, zero failures/skips. Canonical inner checksums and established input-wire field order now survive storage. | Current-head hosted browser/broker and complete release qualification remain separate gates. |

For the new 47-case pair, detailed records use **55,388 of 56,597 generated tokens (97.86%)**. Flat observed/context cost is **2,951,658**, with **1,789 terminal tokens** and **3,010,044 total tokens**. Native packing records **6,920 physical chunks / 1,948 logical records**, **3,013,123 observed/context tokens**, and no terminal tokens. The population contains 34 compact / 1,755 detailed records, with 22 mixed cases and 25 wholly detailed cases. These are exact representation costs, not quality claims.

The actual-history diagnostic uses retained fitted weights without new training, shuts down the original service, and restores in a fresh service. It retains the original malformed next-output bytes and compares the complete refusal evidence, excluding timing fields. Its earlier `18e9ebf` attempt stopped on that refusal before restoration and remains failed evidence. The separate ordinary run at producer `35be3b7` / consumer `f25fa32` completed prepare, exactly **two normal optimizer updates across fresh-process resume**, export and service restore, but acknowledged **zero model records**. The fitted one-record diagnostic used **32 decoder-only updates** and does not replace ordinary training or held-out qualification.

### Complete evidence is pushed

- [48-file automatic-history and integration supplement](https://github.com/werg/tracing-js-self/tree/e393fd0194c8284a38eafee6df70a4179846a8db/docs/evidence/semantic-v8-automatic-19eba4f-39d5212): actual automatic recovery on exact `19eba4f` / `39d5212`, complete producer run, original 611/1 consumer failure, correction and 38 passing controls, and the separate asset-backed gates. One actual model record and two cuts recover exactly; the next output remains refused. All archive members and 11 shared model/tokenizer dependencies were hash-verified.
- [515-file ordinary/model/paired bundle](https://github.com/werg/tracing-js-self/tree/5eeddef47caeb8300094211a9b4cb6020c60ab70/docs/evidence/semantic-v8-final47-pair-934a111-f25fa32): actual model, optimizer and tokenizer assets, historical complete gates and failed attempts.
- [Full 843-variant module campaign](https://github.com/werg/tracing-js-self/tree/4aa63fbe35a98a59230004b603ef6d39aaa9fea6/docs/evidence/module-campaign-35be3b7): 1,067 archive members, original selected inputs, all 2,231 attempts, complete triage, exact prior-campaign comparison and separate grammar-scope report.
- [474-file current measurement supplement](https://github.com/werg/tracing-js-self/tree/5ec5e61d6a8f46a4d8b852fc54567acec6c6bb2c/docs/evidence/semantic-v8-final47-pair-090e634-0351fe9-supplement): fresh all-47 gates, both actual-history attempts, passing 579/604 consumer runs and failed full producer run. Shared model/tokenizer dependencies are pinned by archive member path and hash.

Every archive member and compressed part has been verified. Archive counts are file counts, not independent test totals.

### Active work, hardest first

1. Automatic saving and cancellation ordering are implemented, published and backed by actual-model recovery plus complete producer integration. The actual accepted-session/cancelled-sibling diagnostic now passes; finish the repaired consumer's complete run. Durable terminal cancellation authority is the next implementation task; distributed ownership remains open.
2. Consumer cancellation/surviving-session recovery is implemented in `39d5212` with **32 passing controls**, including sequential one-session capacity, interleaved accepted histories and real CPU sampling with zero acknowledged semantic outputs. Its actual fitted-weight sibling diagnostic now passes. Complete the module namespace integration and fresh full module campaign.
3. The fresh P19/C9 all47, ordinary two-update and explicit/automatic history gates are complete. Publish their complete retained assets, finish the installed dependency-lock repair, then run the preserved full665 population on a new clean exact pair. Earlier passes stay attached to their original revisions.
4. Continue the 17-package scope below, including distributed ownership/rotation, complete edition applicability, production parity, held-out model studies and coordinated default/release cutover.

**Lessons:** canonical storage must preserve derived identities and wire bytes as well as outer checksums. Matching a restored malformed model output proves recovery equality but remains a model refusal. A targeted regression repair never converts the earlier full-suite failure into a pass. Complete recovery evidence includes original failures and actual model assets.

---

## Concurrent implementation checkpoint — 21 November 2026

**Implementation milestone: producer `21fc226db0feece2f88f4a86b1c4635965521651` / consumer `0351fe9607735898da441458fdf7182e20a9ace5`. 0 of 17 complete acceptance packages are closed.** Starting heads were producer `4fda1a4` / consumer `84dee6a`. Concurrent upstream commits were inspected and preserved before publishing; their existing recovery API is retained.

### Delivered and measured in this continuation

- Producer `21fc226` implements per-module `import.meta` identity, mutation, null prototype and retained JSON restoration; modules without metadata keep their prior source/allocation order. **50 integrated module, original-source and population checks pass, zero failures/skips.** General namespace/dynamic-import/public admission remain separate gates.
- Concurrent producer `18e9ebf` / `070bad4` supplies an actual-model explicit-history diagnostic that retains malformed next-output refusals and complete state/cost evidence. Its code and completed exact-pair execution are preserved in the evidence supplement above; the malformed next output remains refused.
- Producer `98b1f0d` adds strict checkpoint-data and native-cost validation **before native state opens**, plus complete recovery controls for a completed external write, consumed private callbacks and a separately acknowledged later input tail. **50 integrated recovery tests pass, zero failures or skips.** Eight malformed-cost cases and one accessor case failed before the correction; Node counts the failing parent too (initial new selection: 3 passed / 10 failed from 13 tests). These supplied-decoder controls do not claim learned quality or source admission.
- Concurrent producer `41ee8c1` canonicalizes nested lifecycle integrity, and `090e634` connects explicit durable checkpoint history to driver recovery. All recorded driver/public/host cuts and input-chain ancestry are checked before restoring the final native continuation. The final native service independently reconstructs model state; earlier private RNG/cache snapshots are retained evidence, not individually reexecuted model proofs.
- Concurrent producer `5820da1`, `6a9dbff`, `3bdc1fb` add and harden exact-source/frozen-spec scope annotations; consumer `0351fe9` repairs canonical comparison at replayed selection boundaries. These were already published during this session and are preserved, not overwritten or counted as independent duplicate implementations.

### Current work, hardest first

| Work | Status | Remaining concrete acceptance evidence |
| --- | --- | --- |
| Later acknowledged selected history | Explicit-cut recovery implemented and integrated; automatic durability before proceeding past acknowledged selections is being implemented | Real-model/current-pair qualification, saving/refusal controls, cancellation after the trusted head, distributed ownership and rotation. |
| Consumer cancellation and surviving-session recovery | Reproducing loss of sibling-session recovery when a cancelled session's opening/attempt evidence outlives its live session | Explicit closed-session authority, retained budgets/evidence, no revival, actual CPU reconstruction and refusal controls. |
| Module metadata and namespace semantics | Metadata implemented and published with 50 integrated passes; namespace object semantics in progress | Original SourceTextModule differentials and JSON restore, then separate source/public/native promotion; dynamic import/exotics remain open. |
| Frozen-edition scope reconciliation | Extending newly published audit with parsed counterexamples to tag-only exclusion | Distinguish ordinary `import defer from` bindings from proposal syntax across frozen source/dependency inputs; retain every original row/status and leave unsupported applicability unclassified. |
| Integration and paired qualification | Recovery tests complete; clean worktrees and verified production tokenizer ready | Complete producer suite, consumer semantic selection, current exact-pair source/native/token/packing and ordinary lifecycle, retained assets and actual-head hosted results. |

### Lessons and evidence boundaries

Nested checksums must use the durable serialization's canonical JSON. A single saved cut still needs value/type validation even without a later cut for comparison. Validation must reject accessors before cloning supplied data. The trusted history head authorizes only explicitly recorded cuts and original inputs. Cancellations and external operations beyond that head need separate durable authority. Historical results below retain their exact revisions and do not qualify new code.

---

 Language expansion and V8 cutover: implementation status

This PR is the main work ledger for the two plans supplied on 20 November 2026. It tracks **representation cutover**, **language coverage**, and **qualified learned execution** separately. None is complete. **0 of 17 acceptance packages are closed.** Delivered increments and passing bounded tests do not close a package's full exit gate.

## Branches and authoritative scope

- Producer: `werg/tracing-js-self`, `codex/language-coverage-v8-cutover`; base `f32c6fcf4e11ef2c18592a04d9ff108ad74913dc`.
- Consumer: `werg/megatoken`, same branch; base `24f4a7c16edf4603cbf5ea6863db1f6a8cc67e37`; paired [PR #38](https://github.com/werg/megatoken/pull/38).
- Authoritative plans: [language expansion](https://github.com/werg/tracing-js-self/blob/codex/language-coverage-v8-cutover/docs/plans/language-coverage-expansion.md) and [coverage and complete cutover](https://github.com/werg/tracing-js-self/blob/codex/language-coverage-v8-cutover/docs/plans/language-coverage-and-v6-cutover.md).
- Complete committed history, original evidence pins, failed attempts and earlier lessons: [implementation ledger](https://github.com/werg/tracing-js-self/blob/codex/language-coverage-v8-cutover/docs/LANGUAGE_COVERAGE_V8_CUTOVER_STATUS.md). The detailed historical entries remain there; this description presents the current state and complete remaining-work tally.

## Active continuation — 21 November 2026

Resumed from producer `1965c3767cfb4ff1719c90ecf3a0d71ff3142e39` and consumer `de58ef4a59cfa0967fa63b937077dd61dec1a4c4`. That earlier checkpoint reached producer `934a111cf952e084b599ddff6932ce34849550b6` and consumer `f25fa325def722c5ec7d6ed7f9300ac235cf6e1a`. **0 of 17 complete acceptance packages are closed.** Exact earlier evidence does not qualify later code.

### Published and measured in this continuation

| Revision / exact pair | Delivered behavior or measurement | Evidence and remaining boundary |
| --- | --- | --- |
| Consumer `72e9945` | Preserve shared heap/captured cells across closure-backed and ordinary retained calls; allocate parameter cells by actual invocation order. Independently validate source, realm, parent, graph and receiver identities before import. | 11 new and 65 related controls pass. Three producer-pinned fixture episodes / 26 selected records. Engineering controls do not claim original-source admission or model success. |
| Producer `5d095e8` | Preserve inferred module function/class names before static initialization, including assignments, defaults and `__proto__`. | Four original-ESM controls fail before/pass after; 59 integrated controls pass. Existing native disagreements retain failed status. |
| Producer `4bff56f`; consumer `1d9d62c` | Bind each event and callback activation to the exact handler, source, owner, realm, track, trigger, closure, task revision and argument policy. Preserve discarded arrival identities. Independently replay host-owned registrations and fresh/retained deliveries in Python. | 56 producer and 103 consumer integrated controls pass. Consumer artifact: seven pinned episodes / 52 selected records. Broader recovery and original-source native composition remain open. |
| Producer `035951c`, `28261b8` | Extend module declarations to classes, synchronous generators, anonymous defaults and destructured live cells. Preserve shorthand default property names and cyclic/live-binding semantics. Add recurring `module-destructured-live-cells`. | 51 module integration controls pass. Population now **47 = 44 scripts + 3 original module graphs**. New case passes original-source/public recheck. Class/private and generator-reflection public projection still refuse explicitly; async generators remain unsupported. |
| Producer `929ff9f`, `9c7d6b6` | Validate reconciled results before acknowledging receipts; require correct owner and immediately matching public result. Preserve closing handlers across JSON restore and refuse revoked callback reattachment. Preserve isolated source-projection cloning. | 29 lifecycle/recovery, 8 reconciliation/realm and 10 source/host composition controls pass. Full contract generator check passes with unchanged digest. An intermediate clone-brand failure was found and corrected. |
| Producer `0276f62`, `9fc1935` | Atomically claim durable actions before adapter execution; recover later source-bound intents behind old checkpoints without repeating effects. Validate complete checkpoint authority against public replay, canonicalize duplicate input identities, and preserve callback retirement/resource loss. Returning callback names no longer consume notification counters. | 14 durable-action and 156 integrated checkpoint/lifecycle/ingress/driver controls pass, including 97 checkpoint-authority controls; counts overlap. Real fsync files, fresh-process restoration, competing claims, lost acknowledgments, substituted private metadata and late results are exercised. Full contract generator check passes unchanged. |
| Consumer `a76ba08`, `e771398`, `9a1d915` | Independently replay explicit reconciliation, truthful non-dispatch retries, unresolved losses and subscription reattachment. Exercise durable owned return callbacks with aliased receiver/input and retained capture. Bind registrations exactly, preserve retirement after late results, separate invocation names from allocation counters. | Latest 172 focused controls pass; earlier overlapping integrated runs passed 178 and 109. Eleven recovery/registration episodes / 51 records and eight retained-handler episodes / 58 records are pinned to producer `9fc1935`, with source/model admission unclaimed. |
| Consumer `f25fa32` | Bind native-action receipts to the committed invocation/effect, operation, payload, owner and witness digest; retain complete plain JSON metadata in reconstructed obligations. Explicit null, malformed data, cycles, nonfinite values and substituted bindings refuse atomically. | 128 focused controls pass, including 34 new receipt controls. Twelve recovery/action episodes / 54 records. A controlled receipt/signature does not authenticate a model. Producer policy now pins this exact consumer. |
| Producer `98afb48`, `00be9f9` | Resolve imported namespace reexports to their original target module, including star diamonds; retain distinct identities for different modules. Support source-owned static namespace `typeof` with lexical-shadowing, ordinary-cell TDZ and side-effect controls. | Both unchanged original Test262 cases now pass owned execution, archive validation and exact replay. Node 24.22.3 still fails their original linking. The source/public adapter preserves that failure and does not export/admit either case. A separate native-agreeing graph passes source/public checks and fresh rechecking. |
| Producer `f1aa197`, `eb5e22a` | Refresh obsolete tests for supported module declarations, exact callback bindings/owners, independently checked durable input and in-flight dispatch acknowledgment. | The complete run at `9fc1935` remains recorded as **2,294 pass / 7 fail / 6 externally gated skip, out of 2,307 tests**. All seven failed assumptions are corrected; 46 affected lifecycle/generator controls, three module controls and five integration controls pass (overlapping runs). Fresh full-suite results are pending. |
| Starting pair `1965c37` / `de58ef4` | Full recurring qualification of **46 = 44 scripts + 2 original module graphs**, including all four return-callback cases. | **46/46 source checks, 46/46 independent native admissions, 46/46 exact tokenizer measurements and 46/46 native packing receipts pass.** Complete inputs/tokenizer/policy/receipts/logs are published in `36829c8` ([198-file bundle](https://github.com/werg/tracing-js-self/tree/36829c83343bf67449f86df9e5b67d9a76a581bc/docs/evidence/semantic-v8-pair-1965c37-de58ef4)). No optimizer update or learned-success claim. |

Measured starting-pair costs: 34 compact and 1,703 detailed records; 53,901 of 55,110 generated text tokens are detailed (97.81%). Twenty-two cases contain some compact records and 24 are wholly detailed. Native packing accounts for 6,753 physical chunks, 1,893 logical records and 2,944,197 observed/context tokens. This is representation cost, not a model-learning result.

The complete **843-module campaign at producer `28261b8`** is published in `5ae71ba`: [1,064-member retained evidence bundle](https://github.com/werg/tracing-js-self/tree/5ae71ba805fdaa50888235b1564a912b0eb591a3/docs/evidence). It retains all **102,994 catalog rows**, original inputs, resources, logs and failed setup attempts. There are **2,231 attempts**. Parse: **750 passed / 93 failed**. Owned execution: **275 passed / 16 failed / 212 unsupported / 42 environment-unavailable / 205 not-run / 93 blocked**. Native reference: **664 passed / 102 failed / 77 environment-unavailable**. Zero infrastructure errors or resource-limited outcomes. Fourteen owned failures are dependency parses; the two namespace failures motivated the fixes above. Source correspondence/public/native admission remain unrun or blocked. Later fixes do not rewrite this historical result.

### Current work, hardest first

| Workstream | Current status | Remaining acceptance evidence |
| --- | --- | --- |
| Durable dispatch and checkpoint authority | Stale-checkpoint, competing-claim, rewritten-private-state, lost-acknowledgment and retired-callback defects repaired and pushed. | Full integration at current pins; wider later-public-history and distributed resource ownership remain open. No guessed service results or native-handle continuity. |
| Paired native recovery | Reconciliation, reattachment, owned callback recovery, exact registration, retirement/allocation and source-bound action receipts are published. Full consumer semantic CI selection is running with actual CPU dependencies. | Exact-pair admission and complete integration; existing fixture signatures are not model authentication. |
| Modules and edition reconciliation | Full historical 843 campaign retained; both namespace gaps repaired using unchanged upstream cases. A narrow scope-evidence audit is being developed for syntax absent from the pinned annual edition. | Fresh affected/full campaign evidence; complete module scheduling/exotics/source correspondence. Scope annotations must preserve all original rows and failures; proposal tags alone cannot remove tests. |
| Missing later acknowledged public history | Later durable action intents can be recovered behind old checkpoints; checked durable input/return-callback tails exist. | General later selected-history recovery with independently retained causal records, complete state restoration and distributed/log-rotation policy. |
| Exact-pair qualification and ordinary lifecycle | Frozen producer `934a111` / consumer `f25fa32`; all47 source/native/token/packing checks and ordinary two-update lifecycle are starting. Producer full suite/reference fixture and consumer full semantic selection are running in separate clean checkouts. | Complete results and retained assets; no quality claim from two training updates. First ordinary preflight correctly refused Python imports from another checkout; retained and rerun with exact import root. |
| Hosted CI | Consumer source-authority pin now `9fc1935`; producer native policy now `f25fa32`. The prior consumer run failed its exact contract comparison at stale `f04f1be` before admission. | Collect exact-current-head workflow/job results and fix concrete failures. Preserve the failed historical run. |

### Lessons recorded

- Invocation-name spelling cannot stand in for execution order when allocating captured cells.
- Event receipts and handler closure must retain exact ownership and account for discarded private arrivals.
- Module rewriting must preserve names during evaluation, before static initializers observe them.
- Resource loss does not restore an expired callback capability.
- Invalid reconciliation must not leave a successful public receipt behind.
- A checkpoint hash alone is not authority for private state that contradicts public receipts.
- Idempotent journal append alone does not grant permission to repeat an external operation.
- Namespace identity follows the resolved module; a specification check, an owned pass and a native reference result are distinct evidence.
- A receipt's request binding and its actual model authentication are different checks.

The complete 17-package tally below remains authoritative. Full edition coverage, ordinary learned usefulness, default cutover and deployment/rollback remain open.

## Earlier continuation — 21 November 2026

Resumed from producer `45ea3e78a4aa9d44b2ba5100acd81ce55bccba12` and consumer `edf83bc3f23c15d0bd1f41cf471c06c8893d3874`. All nine producer and all four consumer hosted workflows passed at those starting heads. Those are baseline results, not qualification for later commits. **0 of 17 full acceptance packages are closed.**

| Published revision | Delivered increment | Executed evidence / remaining boundary |
| --- | --- | --- |
| Producer `de44a01e3548ed426b07b76b9163c0cb1185e56a` | Capture receiver and arguments in one graph; preserve aliases/cycles, reject unknown receivers before mutation, and dequeue only after child admission succeeds. | Seven focused callback/recovery controls pass. |
| Producer `1864b92851f25b6472b83d5e79d36f4e008e493c` | Persist return-value callback arrivals before enqueue; restore queued/active/completed children, shared arrival order and exact return/throw; retain uncertain external parents for explicit reconciliation. | 49 integrated callback/ingress/driver/lifecycle controls pass, including fresh-process depth-two child/host recovery. These controls use selected records; original-source recovery is a separate gate. |
| Producer `e22d2a83c4b75cff0a4c2ec6b2fcb8ade3900083` | Connect the original owned runtime and native driver to typed callbackGraph arrivals, exact callback return/throw and async settlement; preserve shared receiver/argument graphs and exact replay. | 31 integrated original-runtime/native-driver/service controls pass. Synchronous host calls requiring return-valued asynchronous reentry refuse explicitly. Ordinary source projection/fixture/native correspondence and recovery are being completed. |
| Producer `ebb4758d08e25e2cc22f1b7a855cd625398a58e0` | Distinguish missing, ambiguous and resolved exports; propagate ambiguity through star graphs; support bounded namespace forwarding/chained reads. | 50 namespace/module/synchronous tests pass. Two specification controls disagree with Node 24.22.3 and remain failed native differentials. |
| Producer `8c7368914fd2d044279392fff5fda02361b79cc4` | Original-source module preflight resolves star/forwarded/imported-local exports and quoted external names without executing the module. | 38 original-runner/resolution/campaign/reference controls pass; early failures record executionPerformed=false. |
| Producer `4c1a4a42ca21fb1a958b2ed9305372c04833fe3a` | Use a two-pass lexical binding index for namespace reads, parameters/defaults/body vars, blocks/catch/loop/switch and named expressions; isolate module-scoped vars and preserve constructor evaluation grouping. | 81 integrated controls plus a distinct constructor differential pass. Two small synchronous module fixtures also pass original-source/public verification. Independent native admission is next; the complete 843-module campaign is running at this exact clean pin. Scheduled/exotic module support is not inferred. |
| Producer `13ecde5dab4403d2b1d2f6092d64d3084059788b` + consumer `1a8b941df70efe365c467c3db8b8eac5d8ed21c7` | Compose Promise.allSettled in producer and independent native consumer; preserve input order, aliases, reaction-time entries and post-fulfillment mutation. Pair durable callback contracts/fixtures. Recurring population increases from 37 to 40 sources. | 26 producer and 46 independent consumer controls pass; lint and fixture regeneration pass. Contract digest `5c5583fe37dd851dc6f008ee14271c66a605d79d14ce21415a9208ba9fee3b5d`. Full source/native/cost qualification remains to be refreshed after integration. Promise.any / full AggregateError remains open. |
| Consumer `22611c50600bba62debe825b7a808fa0d2130fe6`, `70e8b9e2f09a1115620c895e46dde1e8accc129a`, `37c60669256228bf05988b32e96f5166c843f021` | Preserve ordinary prepared lineage/chunking, correctly count fitted prefixes, restore acknowledged actual decoder state in a fresh standard service, and bound capture to the requested prefix without changing the full prepared episode. | Focused suites pass (15, 18 and 12 controls, overlapping); 19 actual CPU model/history/chunking regressions pass. Injected unit boundaries remain disclosed. The first full 56-record capture was interrupted after 614 seconds without an optimizer checkpoint; original logs remain failures/incomplete. |

### Current actual model evidence

At clean producer **`13ecde5` / consumer `1a8b941`**, the ordinary command regenerated the complete **40-source frozen registry**, prepared the predeclared train source, performed **exactly two normal optimizer updates** across fresh-process resume, exported the real model and passed serving-state restore/next-output equality. **Zero ordinary model records were acknowledged.**

The separate bounded in-sample decoder experiment then performed **32 decoder-only updates, 18 target tokens per update**, and independently generated/acknowledged the exact first Promise-create record. Fresh standard-service restoration passed full acknowledged-state equality and identical next original output; zero host dispatch; the next probe was not acknowledged. **One nonterminal training-prefix record, not complete program execution.** Independent producer original-source/projection/public replay confirms exact accepted prefix, context and decoder payload. A separate fresh actual-service rollout accepts one record then intentionally reports resource_limited at the predeclared one-record cap; its full-source status remains incomplete. Complete tensors, tokenizer, selections, transcripts and unsuccessful attempts are retained locally and will be published as a checked evidence bundle. This establishes no held-out quality, generalization or production readiness.

### Additional published checkpoints

- Producer `0a81e5a340fed757dfede7b78e2a1c344af15c84` connects ordinary original-source return callbacks to existing public records, with exact callback-derived host outcomes and four independent source modes. Forty-two integrated controls pass. Producer `96550666eefe22e82a238060c6471b65f01f33dc` authenticates the complete saved callback queue and restores source-derived nested host/callback work in a fresh process;24 controls pass. External parents remain uncertain until independently retained receipts reconcile them.
- Producer `4198e131ba4c5f93b9e18adaf31c674e22c99128` and consumer `406253d178c774c3586c1684bc99c03eaafd40b5` bind retained closure code and observed entry to the same unique immutable function site before mutation. Producer root/source/population controls pass9/9; consumer focused identity/observation controls pass32/32. A valid declared-name/function-site alias remains allowed; ambiguity or another function refuses.
- Producer `1c96dd7ec3bd4c1010d9567dfccdc7f6ae366c80` rejects a forged rest-parameter alias to an imported input object. The regression failed before correction and all8 focused callback controls now pass.
- Recurring qualification is now **46 cases:44 scripts +2 original module graphs**. Both modules independently pass source/native admission at producer `9655066` /consumer `1a8b941`; the other44 cases were explicitly untested in that selected run. Full46-case admission/costs awaits the consumer owned-graph callback request repair.
- Full module campaign at clean `4c1a4a4`: **843 selected /102,994 complete variants**. Parse750passed/93failed. Owned228passed/34failed/268unsupported/13environment-unavailable/2infrastructure-errors/205parse-negatives-not-run/93blocked. Native672passed/104failed/67environment-unavailable. No resource limits. Source correspondence226not-run/617blocked; zero passes. The two infrastructure errors exposed an unsupported-completion validation bug and an explicit-boundary classifier omission; corrections and a fresh campaign are pending. Producer `8f1e292d08b42927fdd94ffde214e2a974a6fa88` separately corrects typed-loader capability gates, including import attributes and accurate executionPerformed receipts (35controls pass).

### Work underway, hardest first

1. **Original-source callback continuation and durable recovery:** finish deterministic ordinary host fixtures and source projection, original/native correspondence, and fresh-process recovery across callback arrival, child execution and return without repeating external work.
2. **Module coverage measurement and admission:** execute the full 843-module denominator at `4c1a4a4`, retain unsupported/failure categories and both native disagreements, and independently admit the two bounded synchronous module cases into recurring qualification.
3. **Actual accepted-record source authority:** independently recheck the fitted prefix against original source and public replay; retain full model assets and all failures. Full-source and held-out learned execution remain separate work.
4. **Fresh integrated qualification:** run the expanded source/native/cost population and affected ordinary lifecycle at exact published pairs, test the integrated producer and consumer, inspect current-head hosted CI, and preserve complete reproduction inputs.
5. **Remaining semantic work:** general Promise/async scheduling (including any/AggregateError), scheduled module public admission, shared environments/realms/dynamic code, optional profiles, full edition denominator and eventual coordinated default cutover remain in the complete 17-package table below.

### Lessons from this continuation

- Receiver and arguments must be serialized as one graph; separate clones silently break cross-root aliases.
- Durable guest callback completion and an external adapter's process-local continuation are distinct. A recovered guest result does not prove that an external parent settled.
- Scope-aware namespace rewriting needs actual binding identity. Parameter defaults, body vars, block bindings and restored closures cannot be handled by a whole-function name blacklist.
- Module export ambiguity must propagate separately from a missing export. Native-engine disagreements remain visible alongside specification controls.
- allSettled entries become mutable guest objects after fulfillment; checkpoint validation must preserve that transition.
- A bounded fitting request must bound target capture as well as optimizer steps. Exact first-prefix tensor parity preserves provenance while avoiding unnecessary capture.
- Accepted-prefix recovery requires actual decoder output, complete state and a fresh standard service. Even a passed in-sample prefix remains distinct from complete source execution and held-out learning.

## Previous continuation — 21 November 2026

### Published increments

| Revision | Delivered behavior | Executed evidence and limits |
| --- | --- | --- |
| Producer `1240d009ceba524ed53092b7a93a40d8ef0ca410` | Sparse/live Array map projection: absent slots stay holes, present undefined values invoke callbacks, later writes/filled holes use current state, appended elements respect captured length, truncation preserves result length. Nested maps, generator creation and Promise composition use the existing checked operations. | 15 integrated source/transaction/population tests and 12 overlapping cross-feature tests pass, zero failures/skips; original-source comparisons, fresh rechecks and JSON recovery execute. A fabricated hole claim refuses without state changes. Contract regeneration is byte-identical. Recurring inventory is **37 sources**, adding `map-sparse-live-mutation` and `promise-map-sparse-truncate`. Fresh exact-pair qualification at producer `1240d009ceba524ed53092b7a93a40d8ef0ca410` / consumer `edf83bc3f23c15d0bd1f41cf471c06c8893d3874` now passes **37/37 original-source checks and 37/37 independent native admissions**. Exact cost/packing measurement is running; all output artifacts and original logs are being retained. [Behavior and boundaries](https://github.com/werg/tracing-js-self/blob/1240d009ceba524ed53092b7a93a40d8ef0ca410/docs/SEMANTIC_V8_LIVE_ARRAY_MAP.md). |
| Producer `31fea631d964d718fd55477af3e279b09b9e8cd9` | Exposes a completed return-value callback's retained return or throw after JSON restoration, without recreating an in-process adapter promise or redispatching the parent. | Five focused host recovery tests pass. This is an outcome-retrieval primitive; pre-enqueue durability and the complete child-continuation gate are still being implemented. [Recovery contract and open gates](https://github.com/werg/tracing-js-self/blob/31fea631d964d718fd55477af3e279b09b9e8cd9/docs/SEMANTIC_V8_DURABLE_CALLBACK_CONTINUATIONS.md). |
| Consumer `edf83bc3f23c15d0bd1f41cf471c06c8893d3874` | Fits V8 decoder diagnostics from exactly one verified ordinary prepared training row. Retains frozen source-family/split provenance through grouped boundary capture and supplies the strict V8 policy to the normal trainer. Removes fabricated success/verification labels. | Four focused preparation/membership/capture tests pass; Ruff and whitespace checks pass. Unit tests disclose their injected source-audit boundary. A fresh ordinary command run at `1240d009` / `edf83bc3` regenerated the 37-source registry, prepared its predeclared train source, performed exactly two normal optimizer updates, exported and restored the real service. Zero ordinary model records were acknowledged. The fitted diagnostic's lineage and prefix accounting are being tightened before its accepted-record experiment. |
| Producer `0fd386400a97c6a411e3d3377d0170ba1ae51c9f` | Replaces an obsolete refusal assertion for map-callback throws with a positive original-source/recheck/checkpoint test of the exact thrown value. | 15 enumeration/source-transaction controls pass. At the starting head `274d327`, the full Node 20/22/24 matrix failed this obsolete assertion; eight other producer workflows passed. |

### Hardest work in progress

1. **Durable return-value callback intake and continuation.** Reuse the existing private arrival store/journal, preserve the exact receiver/argument graph and retained identities before execution, restore queued and active child work once, expose exact guest return/throw, and keep an interrupted external parent uncertain until explicitly reconciled. Review is checking partial-mutation refusal, graph aliases, queued-vs-active boundaries and no premature publication.
2. **Original module namespaces and export resolution.** Correct missing and ambiguous property reads, preserve ambiguity through re-export graphs, prevent lexical shadowing from changing lowered results, and add bounded namespace re-exports. Tests distinguish pinned-specification behavior from native-engine differentials; no parser/owned pass is promoted automatically to source or native admission.
3. **Actual V8 accepted-record restoration.** Run the repaired fitter from a clean published consumer and verified ordinary train data, preserve complete tensors and failed attempts, validate actual decoder output publicly and independently, then restore acknowledged state in a new process. A fitted training record is a diagnostic, not held-out quality.
4. **Exact-pair recurring qualification.** Recheck all 37 declared source cases, independent native replay, exact tokenizer costs and packing after integration, followed by ordinary optimizer/resume/export/service restoration. Paired contract changes must be mirrored before these gates run.

### Lessons from the current implementation

- A callback's owned guest continuation and its external caller's process-local promise are different recovery obligations. Persisting the guest state alone cannot justify rerunning a host effect or claiming that an adapter stack survived.
- Training membership and provenance must reach the actual grouped trainer. Validating an admitted row and then replacing it with a newly constructed, unregistered episode loses the proof.
- Array map reads each visited element from current state while retaining its entry length. A hole is distinct from an own element containing undefined; recovery must retain that distinction.
- Export resolution needs a distinct ambiguous result. Treating ambiguity as a missing name can incorrectly allow a different star-export path to supply a value.
- Passing the same implementation through two wrappers is not independent evidence. Owned execution, original source comparison, native replay, training eligibility and model success remain separately reported.

### Current evidence baseline

- **Fresh locally completed qualification, full publication in progress:** producer `1240d009ceba524ed53092b7a93a40d8ef0ca410` / consumer `edf83bc3f23c15d0bd1f41cf471c06c8893d3874`: **37/37 source and native checks**; normal preparation, exactly two optimizer updates, export and fresh-process service restoration pass. The complete 37-source inventory is frozen before selecting its declared train source. Exact tokenizer costs are running. Zero accepted ordinary model records; no held-out or learned-success claim. Failed environment/provenance attempts remain failures and are retained.

- **Latest fully retained and directly identified paired bundle:** producer `7b2a75621233dd86b2c5c13616df479cf443effb` / consumer `31e5688f81cd951384d9b6bcafc1421d43babdff`: 32/32 source and native checks, all 32 cost/packing measurements, exactly two ordinary optimizer updates, fresh-process resume, export and real service restoration. **Zero semantic records acknowledged.** Complete tensors, tokenizer, prepared data and original logs: [retained bundle](https://github.com/werg/tracing-js-self/tree/codex/language-coverage-v8-cutover/docs/evidence/semantic-v8-pair-7b2a756-31e5688). The archive and selected input members were hash-verified during this continuation.
- **Later results recorded in the committed ledger:** producer `20fca49` / consumer `18a55a8` reports 35/35 source/native/cost/packing and ordinary lifecycle success, still zero acknowledged records. Earlier `aa07a2b` / `8772c0d` reports 34 source / 33 native passes; the anonymous-generator admission failure remains failed. These reports retain their original pins and are not evidence for the new implementation.
- **Recorded full module campaign:** producer `f04f1be` retains the 102,994-variant denominator, including 843 selected modules. Owned: 147 passed, 34 failed, 351 unsupported, 13 environment-unavailable, 205 parse negatives not run, 93 blocked by parse failures; zero infrastructure errors. Native reference: 672 passed, 104 failed, 67 unavailable. Source correspondence has zero passes. Current changes require a new campaign.
- **Edition inventory:** actual ECMA-262 17th-edition HTML is retained and hashed; the 102,994-variant Test262 catalog is frozen. The source-reference audit covers 53,616 original tests and 198 feature tags without excluding absent/renamed references. Edition membership/applicability, optional profiles and full conformance remain open.
- **Hosted baseline:** at producer `274d327`, eight workflows succeeded and the three-version test matrix failed the obsolete map-throw assertion. At consumer `18a55a8`, three semantic workflows succeeded and general CI was cancelled. Current published heads have their own checks; baseline results do not qualify them.

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
| 1 | Frozen scope, denominator, parity inventory | In progress | ECMA-262 17th edition HTML bytes and the full Test262 catalog are pinned; edition membership and applicability remain unclassified. Reconcile suite/variant and real-source inventories, parser/host/resource identities; preserve unselected rows; map every production V6 route to a replacement test. |
| 2 | Qualified Test262 runner | In progress | Original scripts, isolated native references and bounded original-module owned lowering retain pinned inputs and negative/async/TLA controls. Remaining: full module semantics and source correspondence, fresh realms/agents, separate early-error qualification and complete applicability/failure reconciliation. |
| 3 | Neutral JS execution state | Internal implementation delivered; acceptance pending | Neutral typed values/controller/lifecycle and V8-only public entry are implemented. Original665 fixtures are preserved exactly. Remaining: fresh complete population and lifecycle behavior, installed absence, and all production-route parity; client equivalence alone is insufficient. |
| 4 | Direct V8 detail and source certification | Internal implementation delivered; acceptance pending | Direct detail/context/checkpoint schemas and source compilation are implemented without legacy episode replay. Remaining: full665 original-source/native qualification, complete installed package with exact dependency evidence, and remaining source-family ownership. |
| 5 | Independent native V8 semantics | In progress | Direct detail, observation, effect and primitive paths plus installed import controls are delivered. Remaining: complete contract ownership and paired language-family semantics, broader malformed-state controls, final current-pair absence/replay proof. |
| 6 | Composable source projections | In progress | Unique event ownership and atomic private/public rollback are implemented for current adapters; map callbacks now compose finally/throw and generator creation/yield. Bounded mapped-generator IteratorClose is delivered. Remaining: broader abrupt/async cleanup, cross-family ownership and exact source/native qualification of the expanded population. |
| 7 | Protocol/effect/lifecycle composition | In progress | Protocol → effect → callback → protocol, reentrancy, guest errors, cancellation and restore with independent source/native checks. Coordinated driver/model/host recovery now preserves acknowledged history and budgets. |
| 8 | Ordinary V8 training admission | In progress | Strict preparation, ordinary readiness, recipe/loader/config/stage/resume gates are implemented. Remaining: fresh command-level qualification of the expanded source population and production recipes with the exact final assets; source eligibility remains distinct from learned outcomes. |
| 9 | Canonical selected serving and live restore | In progress | Private arrivals/callbacks, later-history recovery, automatic acknowledged-selection durability and cancellation ordering are implemented. Actual fitted weights recover one accepted record across two cuts; the same next output remains refused. Native closed/sibling-session recovery and numeric receipt correction are implemented; actual fitted sibling restoration passes at `dc7595e` / `1ddcc61`. Remaining: complete-program recovery, unsaved terminal authority, rotation/distributed ownership and final source/native/no-redispatch operational proof. |
| 10 | References, coercion and abrupt operations | In progress | General references, property keys, guest error objects, partial effects, nested binding and cleanup; source/public/native/restore cases. |
| 11 | Promises, async and scheduler | In progress | Adoption order, repeated thenables, getter/throw/first-call/finally behavior; public/native transitions; combinators, async functions/generators and module interactions. |
| 12 | Collections, construction, Proxy and iteration | In progress (bounded families) | Sparse/effectful arrays, collections, internal methods, private accessors, iterator consumers/delegation and checkpoint behavior. |
| 13 | Modules, persistent sessions, TS and host graphs | In progress | Per-module evaluation and sibling TLA scheduling, cycles/live bindings/namespaces/imports, persistent restore, emitted-JS provenance and host graph/lifecycle parity. |
| 14 | Binary memory, RegExp and remaining intrinsics | In progress (bounded families) | Resizing/detachment/transfer/species/coercion, complete selected text/numeric families and iterator helpers, declared resource boundaries. |
| 15 | Edition long tail and separate profiles | Not started | Dynamic eval and realms, applicable Annex B/Intl, weak references/finalization, shared agents and memory constraints; separately pinned later additions. |
| 16 | Data, ordinary model lifecycle and studies | In progress | All 47 recurring sources are readmitted on exact measured pairs; a two-update ordinary lifecycle and one-record fitted diagnostic have complete retained assets. Remaining: expanded production corpus/recipes, final-pair ordinary lifecycle, frozen held-out/comprehension studies and learned-quality/cost gates. |
| 17 | Coordinated default cutover and operational proof | Not started | Complete parity first; change defaults/remove legacy; freeze final pair; actual-head CI, installed absence tests, release restore, effect-safe rollback/deployment qualification. |


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




## Current published heads

- Producer: `dc7595e9a4764a3f6fceb4218fd01aa3192222e4`.
- Consumer: `1ddcc6110d70703f6b08244d53ec461047677bec`.
- Both PRs remain drafts. Full edition coverage, default cutover, deployment/rollback and learned-usefulness gates remain open.
