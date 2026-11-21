# Mixed V8 Promise, host and callback execution

This increment makes declared Promise joins, ordinary selected operations and
external host work use one authoritative realm. It is a bounded engineering
capability within the larger language-coverage plan, not a default cutover or a
claim that all Promise, host or recovery behavior is implemented.

## State and scheduling

Every retained invocation shares the realm's exact heap, lexical-cell map and
scheduler object. Protocol records are validated on a staged controller before
commit; committing copies into those existing shared objects rather than
detaching one callback's heap. A join records its owning invocation. Other
controllers may observe the shared result but cannot execute its jobs.

One settlement can release reactions, joins and await continuations belonging
to different retained invocations. Eligibility is discovered across the realm,
then newly ready dependencies are published in original registration order.
Already queued work keeps its position. An explicit microtask retains its enqueue
order. Dispatch, resume and join steps require the global ready head and cannot
take the turn while another invocation still has an unfinished Promise job,
including the interval after a reaction callback returns and before its explicit
job-completion record.

The native host driver yields at guest microtask boundaries. It preserves a
current guest job across synchronous host transport and preserves the initial
FIFO group of external callbacks before running descendant jobs. The owned
runtime's cumulative step bound still applies across all yields. The independent
original-source runner is unchanged and remains the comparison authority.

## Source certification

`protocol-host-source-v8.js` uses the direct V8 source projection and the neutral
source admission authority. It separately checks the original program outcome,
host effects, callback order, operations, branches and completions. It then
rebuilds every public record and causal context from the owned event archive.
Source archives and reference outcomes remain private evidence, never model
inputs. A mismatch refuses the case; it cannot be repaired from expected output.

The four retained fixtures exercise distinct observable orders:

| Fixture | Root result | Behavior checked |
| --- | ---: | --- |
| `join-host-join` | 12 | A join, asynchronous host read and a later join share values and lifecycle state. |
| `join-retained-callback` | 7 | Two retained callbacks mutate one captured cell and store 3 then 7 before the root's final join. |
| `callback-owned-join` | 0 | Returning a Promise from a callback does not force the host's returned Promise to wait for that callback. Its later callback work stores 6. |
| `callback-owned-join-awaited` | 6 | The root explicitly awaits the captured callback Promise before reading the changed cell. |

`tools/generate-protocol-host-fixtures.mjs` freshly certifies those sources and
stores stable public/context bytes in the compressed interoperability fixture.
`tools/generate-semantic-region-contract.mjs` independently checks those bytes
again before including them in the contract's interoperability manifest. A
fixture's source-check label is not native admission, tokenizer qualification or
learned execution evidence.

Direct mixed-source evidence has schema
`semantic-protocol-host-region-evidence/1`. Its immutable source split is retained
inside `sourceAdmission`; the outer `split` and `splitIdentity` belong to the
ordinary complete-family dataset binding. The binding has
`sourceArtifactDigest: null` and the exact `sourceIdentityDigest`, because this
path has no nested legacy source artifact. Fresh preparation must recheck that
identity and require `identityValidated: true`; metadata assertions alone cannot
admit it. Relabelling the source proof or dataset split is rejected.

## Public receipts and recovery

An external result may publish multiple observations, for example a result
followed by callback-handler retirement. Source correspondence identifies the
actual returned receipt by its observed ordinal and exact fields, including when
protocol records change its public sequence. It never assumes that the last
published row is the result. Duplicate result or handler-close calls refer to the
original receipt. Reconciliation retains its own evidence and result identities.

Observed result obligations use public mixed-timeline sequences and the public
owner-track count. Native arrivals still waiting in unjournaled queues are absent
from causal model context. A protocol checkpoint refuses such arrivals until an
explicit durable ingress receipt exists; it does not silently discard them.

Registered queued event callbacks can now be sealed at the checkpoint boundary
with an independently read durable ingress receipt; see the
[queued callback recovery API](SEMANTIC_V8_RECOVERY.md#queued-callback-inputs-at-the-checkpoint-boundary).
Their values stay private until delivery. Unsealed input, return-value callbacks
and arrivals outside the saved boundary still require further recovery work.

Protocol checkpoints bind exact invocation state and the generated-record,
outstanding-effect and automatic-delivery policies. Replay retains supplied live
service bindings without invoking them. Restored acknowledged outstanding work
is uncertain and requires explicit reconciliation. Existing subscriptions become
lost and require verified reattachment rather than registration replay.

The focused controls cover forged results, foreign join ownership, global
readiness, shared map identity, custom host limits, retained services, uncertain
effects and subscription reattachment. Closed realms, automatic callback
sequence recovery and duplicate-result identity receive separate fault controls;
the main implementation ledger records their current qualification status.

## Remaining acceptance work

- Extend the new [unique source event ownership](SEMANTIC_V8_SOURCE_OWNERSHIP.md)
  beyond the executor, join and ordinary-source components. Those components
  now reserve all slots and stage each event before publication; the remaining
  protocol-family source projector still needs the same migration.
- Complete broader Promise adoption, finally, thenable, async-function,
  async-generator and module source/public/native transitions.
- Qualify reentrant effects, cancellation, delayed callbacks, durable ingress,
  child work and every acknowledged host/model recovery boundary together.
- Recollect ordinary source/native/tokenizer admission on an exact clean paired
  revision after contract changes; historical receipts keep their original pins.
- Extend ordinary training recipes and production readiness, and measure learned
  correctness and cost on frozen held-out populations. Engineering fixture
  agreement and optimizer updates do not satisfy those quality gates.
- Finish production parity, defaults, legacy removal, installed absence tests,
  deployment and effect-safe rollback before release qualification.

The complete 17-package tally remains in
`docs/LANGUAGE_COVERAGE_V8_CUTOVER_STATUS.md` and producer PR 47.
