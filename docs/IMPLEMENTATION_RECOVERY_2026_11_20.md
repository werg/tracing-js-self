# Implementation recovery and next hard work

This handoff records the state when the executor disconnected on 20 November
2026. It is not completion evidence. The main PR's 17-package acceptance ledger
and difficulty ranking remain authoritative.

## Durable state

Both repositories use `codex/language-coverage-v8-cutover`.

The producer was published through `0b8e43ea3a55184258bc05bdadbc9508e333bddb`
before disconnection. This handoff's commit additionally preserves the tested
driver recovery policy extension. Earlier pushed increments include direct V8
source certification, Promise projection repair, campaign resume/retry repair,
the shared primitive-conversion kernel, cached property references and coordinated
driver/model/host recovery.

The consumer's ordinary training lineage and formatter follow-up are published
at `9c83827a269965c76e341ae2afd8e53fdbe66680`. The three earlier CI repairs were
published at `40bca9a9e6703c7ada555f959145e0e8e9fb4a7b`.

The local workspaces were:

- `/workspace/scratch/d2b8306051ca/tracing-js-self`
- `/workspace/scratch/d2b8306051ca/megatoken`

Do not discard their uncommitted state when access returns. Remote branches
advanced through the connector after the last successful local fetch. Inspect
and preserve local differences first, then integrate in isolated clean worktrees.

## Highest priority: recover the completed producer composition increment

Local producer commit `d9a3ce4` is titled
“Compose V8 Promise joins with owned host callbacks and recovery.” It is committed
locally but **not published**. Recover that exact commit before recreating work.
Cherry-picking it onto the latest published branch in a clean worktree should
avoid touching the interrupted native changes.

It owns these paths:

- `contracts/semantic-execution-v8.json`
- `docs/SEMANTIC_V8_PROTOCOL_HOST_COMPOSITION.md`
- `fixtures/semantic-regions/host-protocol.js`
- `src/semantic/compiler-v8.js`
- `src/semantic/contract-v8.js`
- `src/semantic/effectful-teacher-v8.js`
- `src/semantic/execution-lifecycle.js`
- `src/semantic/protocol-host-source-v8.js`
- `src/semantic/protocol-promise-join-source-v8.js`
- `src/semantic/protocol-promise-join-v8.js`
- `src/semantic/protocol-state-v8.js`
- `src/semantic/region-harness.js`
- `test/fixtures/semantic-host-protocol-v8.json.gz.b64`
- `test/fixtures/semantic-protocol-region-v8.json`
- `test/fixtures/semantic-regions-v8.json`
- `test/semantic-protocol-host-v8.test.js`
- `test/semantic-protocol-promise-join-source-v8.test.js`
- `tools/generate-protocol-host-fixtures.mjs`
- `tools/generate-semantic-region-contract.mjs`

The three fixtures cover root join → async host result → root join; retained
callback plus host effect; and callback-owned join/reaction jobs plus shared
captured state and host work. Join state now names its owning invocation.
Mixed observed receipts validate against complete mixed state and commit into
the existing live lifecycle, preserving still-running service bindings.

Mixed restoration replays public history before restoring host metadata.
Pure-protocol continuations retain generated/outstanding limits, callback
auto-delivery, and supplied services/journals for a later first host effect.
Unjournaled queued native arrivals remain explicitly refused.

Local verification: 31 focused controls across the final runs; last 14 comprised
six mixed tests, four join-source tests and four driver recovery tests. Seventeen
other direct-source/lifecycle/join controls also passed. These counts overlap
other reported populations and must not be added into a grand unique-test count.
Fresh generation rechecked six base, twenty protocol and three host cases.

Generated local contract:
`a03e20c6ca0954e225c1c058b98a56e3263f39c1a4eba0738629040f42f23f7e`.

Generated local interoperability identity:
`1691b05cba7673981b492fdb32a0672c4017b848e3e44bacaa8110f98b958acb`.

These identities must be regenerated/rechecked after integration; they are not
proof for a later source revision.

## Finish independent native pairing

Interrupted consumer edits are in `src/megatoken/data/native_v8.py`,
`src/megatoken/data/promise_join_v8.py` and
`tests/test_semantic_model_v8.py`. They were not committed. Preserve only those
paths when separating them from root's already-published lineage changes.

The root join/host fixture passes independent replay and checkpoint round-trip.
The retained-callback fixture reaches callback dispatch but fails an obligations
comparison. The callback-owned-job fixture fails with
`Dispatch without one requested intent`.

The last applied fix retains the callback controller at its end record and clears
the active invocation only when that state is absent. The prior unconditional
clear lost the target callback during observed dispatch. Next, inspect obligations
and controller merging when the root's effect result arrives while the callback
is active. Do not weaken independent context/obligation comparisons.

Copy and bind the finalized producer contract and compact fixtures only after
those cases pass. Add owner forgery, cross-invocation job and boundary-restore
controls. Update exact consumer/producer policy pins and rerun source/native
qualification on clean committed checkouts.

## Next: unique source-event ownership and shared pending Promises

The approved next source-composition increment is not implemented:

1. Replace executor/join whole-episode selection with one source teacher coordinator.
2. Each component declares pure ownership predicates for value, allocation,
   event and completion slots.
3. Resolve all claimants before invoking a mutating handler. Ambiguity or an
   unfulfilled claim must fail before any emission/state mutation.
4. Run every applicable independent complete-state observer.
5. Remove the executor's special installation of the join projector and the
   join projector's constructor-based self-disable.
6. Prove a combined executor/join/helper/abrupt-completion case, and duplicate
   claimant controls with zero emitted transitions before refusal.

Separately, multiple owners waiting on the same still-pending Promise require
globally ordered readiness publication across controller-local reaction tables.
The current local fixtures demonstrate independent callback-owned joins, not
that stronger shared-Promise property. Implement and pair it explicitly.

## Training and serving work still open

The new ordinary lineage module and export/reload wiring are published. Before
the outage, four new identity/export controls passed, as did 27 existing normal
training/fresh-process resume/serving tests. The metadata fixture injects its
tokenizer verification boundary and does not prove actual production admission.

Remaining steps:

- Add an optional training-lineage identity to the native model constructor,
  initialization response/request and staged restoration. A normal V8 bundle
  must match the externally expected identity; declared diagnostic bundles can
  retain null. Wire the serving CLI and producer transport/runner consistently.
- Resolve the genuine training/serving history mismatch. With the correctly
  source-bound prepared fixture, training has 38 extra history events; the first
  divergence is index 8, where training has `assistant` and serving has
  `__transducer_query__`. Controls and track descriptions already match.
- Run actual pinned-asset source preparation, normal optimizer update, checkpoint,
  fresh-process resume, export, reload and native selection/recovery. Keep source
  eligibility separate from learned output success.
- The pinned tokenizer was acquired at
  `/workspace/scratch/d2b8306051ca/qualification-assets/ling-tokenizer.json`;
  SHA-256 is
  `40fb9d7d7795b8bd305aeff39ce9963f3f450915b9553f2938e009be9a1fed60`.
  Reacquire by its existing pinned revision if the workspace is gone.

## Async module cycles: concrete design, no implementation yet

Use the pinned ES2026 source
`d89c03f2db8a597bc915b363a6518d0cc8acdbc0` and its Evaluate,
InnerModuleEvaluation, GatherAvailableAncestors and async module completion
algorithms. Existing generated owned async/generator machinery should suffice.

Extend `evaluated-module-scheduler.js` with DFS index, ancestor index, stack,
cycle root and explicit started state. Keep records evaluating until the SCC root
pops the component; synchronous body completion during DFS must not prematurely
mark the record evaluated. Redirect dependencies whose DFS component is closed
to their cycle root before checking errors or registering async parents.

Gather all available ancestors and run them in AsyncEvaluationOrder. Gate
gathering on the parent's cycle-root error. Preserve the original rejection,
let already started unrelated siblings finish, and leave unresolved top-level
evaluation pending. Choose this scheduler for reachable cyclic graphs containing
TLA; preserve the existing all-synchronous path.

Tests should cover self-import, one/two TLA members, external imports of non-root
members, live bindings and TDZ, untaken await branches, errors before/after await,
synchronous DFS failure, independent sibling continuation, unresolved evaluation,
and host results delivered in both orders after restoration.

The scheduler is generated owned source: intermediate field assignments are
individual bytecode steps. Do not validate mid-instruction snapshots with
invariants that only hold after a full scheduler action. A public arbitrary
snapshot restore API would need checked prefix replay or explicit safe boundaries.
Keep source/public/native scheduler promotion refused until independently paired.

## Remaining overall gates

The full 102,994-variant catalog still needs a qualified campaign and edition
classification. Specification-byte retention, production V6 route inventory,
complete protocol/reference/collection/binary/realm/agent coverage, real model
studies, default/removal changes, final exact-pair CI, installed absence checks,
deployment recovery and rollback qualification remain open. None of the 17 full
work packages is closed by the increments above.
