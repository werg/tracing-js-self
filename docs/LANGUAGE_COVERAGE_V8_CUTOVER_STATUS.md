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
| 3 | Neutral JS execution state | Not started | Extract typed values and transitions; preserve all current state and lifecycle behavior; equivalence tests. |
| 4 | Direct V8 detail and source certification | Not started | Own detail/context/checkpoint schema and direct compilation; no V6 witness artifact or old episode replay. |
| 5 | Independent native V8 semantics | Not started | Remove V8-to-V6 envelope/receipt conversion and V7 detail-wire calls; retain neutral independent semantic primitives; malformed-state controls. |
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
