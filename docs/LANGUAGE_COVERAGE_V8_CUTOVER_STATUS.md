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

## Overall progress

### Difficulty order and active priorities

Per the requested hardest/least-defined-first order, work follows this ranking.
Dependencies and regression repairs are completed within the affected increment;
easy cleanup does not displace the difficult semantic work. The ranking is an
engineering assessment, not a completion percentage or a schedule estimate.

| Priority | Difficulty | Work and uncertainty to resolve | Active next slice |
| --- | --- | --- | --- |
| 1 | Very high | Protocol, host-effect, callback and crash-recovery composition: shared state, unique transition ownership and no repeated external work. | Mixed Promise protocol and authorized host effect; independent native replay and complete restoration before callback expansion. |
| 2 | Very high | Complete continuation semantics: retained references, partially evaluated calls/conversions, cleanup, pending jobs and permitted next actions. | Shared resumable conversion state and cached property keys, with JSON restore and tampered-state rejection. |
| 3 | Very high | General Promise resolution and asynchronous module public/native semantics, including adoption, thenables, sibling ordering and async cycles. | Preserve corrected owned behavior; qualify each newly represented job independently before widening admission. |
| 4 | Very high; separate profiles | Dynamic code/realms, shared-memory agents, weak references and finalization; permitted outcomes and host obligations need explicit definitions. | Retain all obligations in the full target; define a bounded executable slice and observation rules for each before implementation. |
| 5 | High | Direct V8 source certification and neutral execution core: remove old wire/episode dependencies across compilation, replay and lifecycle. | Direct V8 source artifact and recheck, independent source observers and runtime import-absence controls. |
| 6 | High | Real training and live model lifecycle: source/tokenizer/model/optimizer/policy identities and recovery must agree end to end. | Actual-policy preparation, normal optimizer/export/reload and serving provenance; source admission must never imply learned success. |
| 7 | High | Objects, Proxy, construction, coercion, iteration, collections, binary memory and RegExp interact through observable hooks and partial failure. | General mechanisms first, then method-level and cross-feature slices with native counterparts. |
| 8 | Medium to high; dependency-gated | Full qualification, V6 production parity, default routing, installed legacy absence and coordinated release/rollback. | Repair current regressions; retain exact fresh evidence and every unfinished population. Final default/removal changes must precede final qualification. |

The 17-package tally below remains the acceptance ledger. A delivered increment
does not close an entire ranked item or work package.

**0 of 17 work packages complete.** Work packages may contain delivered increments
without satisfying their complete exit gate. The status table must not conflate
owned execution, public representation, independent native admission, training,
serving, and measured learned success.

| # | Work package | Status | Required completion evidence / remaining work |
| --- | --- | --- | --- |
| 1 | Frozen scope, denominator, parity inventory | In progress | Pin specification bytes, suite/variant and real-source inventories, parser/host/resource identities; preserve unselected rows; map every production V6 route to a replacement test. |
| 2 | Qualified Test262 runner | In progress | Fresh realms, official includes, strict/sloppy/raw/module variants, early/runtime errors, async and agent handling; runner fault controls; reconciled full applicable catalog. |
| 3 | Neutral JS execution state | In progress | Extract typed values and transitions; preserve all current state and lifecycle behavior; equivalence tests. |
| 4 | Direct V8 detail and source certification | In progress | Own detail/context/checkpoint schema and direct compilation; no V6 witness artifact or old episode replay. |
| 5 | Independent native V8 semantics | In progress | Remove V8-to-V6 envelope/receipt conversion and V7 detail-wire calls; retain neutral independent semantic primitives; malformed-state controls. |
| 6 | Composable source projections | In progress | Event-level adapters with complete, unique transition ownership; no exclusive whole-episode projector limitation. Mixed Promise/host source certification is under qualification. |
| 7 | Protocol/effect/lifecycle composition | In progress | Protocol → effect → callback → protocol, reentrancy, guest errors, cancellation and restore with independent source/native checks. Coordinated driver/model/host recovery now preserves acknowledged history and budgets. |
| 8 | Ordinary V8 training admission | In progress | Strict preparation policy and normal recipe/loader/config/stage/resume checks; no verification-flag or unverified-data bypass; source eligibility distinct from learned outcomes. |
| 9 | Canonical selected serving and live restore | In progress | Standard serving route, training/serving byte parity, acknowledged-state restore, random/budget state, callbacks/child work, no redispatch. |
| 10 | References, coercion and abrupt operations | In progress | General references, property keys, guest error objects, partial effects, nested binding and cleanup; source/public/native/restore cases. |
| 11 | Promises, async and scheduler | In progress | Adoption order, repeated thenables, getter/throw/first-call/finally behavior; public/native transitions; combinators, async functions/generators and module interactions. |
| 12 | Collections, construction, Proxy and iteration | Not started | Sparse/effectful arrays, collections, internal methods, private accessors, iterator consumers/delegation and checkpoint behavior. |
| 13 | Modules, persistent sessions, TS and host graphs | In progress | Per-module evaluation and sibling TLA scheduling, cycles/live bindings/namespaces/imports, persistent restore, emitted-JS provenance and host graph/lifecycle parity. |
| 14 | Binary memory, RegExp and remaining intrinsics | Not started | Resizing/detachment/transfer/species/coercion, complete selected text/numeric families and iterator helpers, declared resource boundaries. |
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
  unresolved metadata records and no missing official harness assets. Every
  variant is still unrun and edition classification remains unclassified; the
  specification bytes are not yet pinned. Catalog digest:
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
