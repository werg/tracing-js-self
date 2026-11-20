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
| 6 | Composable source projections | Not started | Event-level adapters with complete, unique transition ownership; no exclusive whole-episode projector limitation. |
| 7 | Protocol/effect/lifecycle composition | Not started | Protocol → effect → callback → protocol, reentrancy, guest errors, cancellation and restore with independent source/native checks. |
| 8 | Ordinary V8 training admission | In progress | Strict preparation policy and normal recipe/loader/config/stage/resume checks; no verification-flag or unverified-data bypass; source eligibility distinct from learned outcomes. |
| 9 | Canonical selected serving and live restore | Not started | Standard serving route, training/serving byte parity, acknowledged-state restore, random/budget state, callbacks/child work, no redispatch. |
| 10 | References, coercion and abrupt operations | Not started | General references, property keys, guest error objects, partial effects, nested binding and cleanup; source/public/native/restore cases. |
| 11 | Promises, async and scheduler | In progress | Adoption order, repeated thenables, getter/throw/first-call/finally behavior; public/native transitions; combinators, async functions/generators and module interactions. |
| 12 | Collections, construction, Proxy and iteration | Not started | Sparse/effectful arrays, collections, internal methods, private accessors, iterator consumers/delegation and checkpoint behavior. |
| 13 | Modules, persistent sessions, TS and host graphs | In progress | Per-module evaluation and sibling TLA scheduling, cycles/live bindings/namespaces/imports, persistent restore, emitted-JS provenance and host graph/lifecycle parity. |
| 14 | Binary memory, RegExp and remaining intrinsics | Not started | Resizing/detachment/transfer/species/coercion, complete selected text/numeric families and iterator helpers, declared resource boundaries. |
| 15 | Edition long tail and separate profiles | Not started | Dynamic eval and realms, applicable Annex B/Intl, weak references/finalization, shared agents and memory constraints; separately pinned later additions. |
| 16 | Data, ordinary model lifecycle and studies | Not started | Regenerate and independently readmit corpus; optimizer/update/resume/export/reload; complete retained bundles; frozen held-out and comprehension studies; honest quality/cost gates. |
| 17 | Coordinated default cutover and operational proof | Not started | Complete parity first; change defaults/remove legacy; freeze final pair; actual-head CI, installed absence tests, release restore, effect-safe rollback/deployment qualification. |

## Initial regression targets

- [x] Owned-runtime Promise adoption preserves competing microtask order (`dqa`); public/native expansion remains open.
- [x] Owned-runtime repeated thenable identity can fulfill; public/native expansion remains open.
- [ ] Sibling top-level-await modules begin independently (`abAB`).
- [x] A selected capability shard retains every catalog row and marks other rows not selected.
- [ ] Ordinary training rejects unadmitted or policy-mismatched V8 data even when
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
