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

## Current checkpoint and active implementation

The work remains incomplete and both PRs remain drafts. The current user
instruction is to tackle **the hardest and least well-defined tasks first**.
The 17 full acceptance packages remain open; increments below do not narrow them.

- Mixed Promise, host-call and retained-callback source execution, shared readiness,
  replay-derived recovery and terminal realm closure are implemented and pushed.
  The full producer V8/region regression run on `a13760d` passed **377 tests,
  zero failures, zero skips**. Exact paired consumer/source admission is next.
- Event-level source ownership is being integrated transactionally: every part
  of an event must have one owner before the live public trace can change.
  An isolated planner alone does not close the composition package.
- Ordinary training-window reconstruction now preserves generated request controls.
  The published consumer fix `821f6b0` has six focused controls and exact state
  comparisons across 35 target positions. Supplied decoder bytes are engineering
  controls, not evidence of learned execution.
- Normal production readiness/recipe admission and distributed checkpoint/export
  lineage remain active work. They must retain strict source, tokenizer and
  preparation identities rather than permit an unverified-data bypass.
- The actual pinned-tokenizer lifecycle has historical evidence for exact producer
  `a4d0a56` / consumer `7da2150`: admission, optimizer update, fresh-process resume,
  export/reload and selection recovery. Its generated output failed; learned
  quality remains unqualified. New combined revisions require fresh qualification.
- Complete edition coverage, production parity, held-out model studies and final
  default cutover remain unfinished. Completed increments are committed and
  published promptly; historical receipts retain their original identities.

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

## Latest published branch heads

- Producer: `a13760d03e084600f6e8875dcae557cd98501bf6`.
- Consumer: `821f6b0ba61299e65ddfcb4da23c4cb11d4886bc`.

These are incremental checkpoints, not a final qualified release pair. Both PRs
remain drafts. Historical local-only composition results are not current evidence.

## Latest hosted-check observation

At producer `892932b`, pinned spec/oracle, trace inspection and selected runtime/
browser lanes passed. The paired V8 lane correctly refused unequal producer/
pinned-consumer contract snapshots; the ongoing mixed-contract publication will
refresh the exact consumer pin. Other lanes were still running at inspection.
At consumer `e84027d`, the controlled selected-harness bridge passed and the
remaining runs were in progress. These are partial observations, not an all-green
final-head or release qualification.
