# Current history authority during V8 recovery

An independently retained receipt authenticates a particular history prefix. It
does not establish that no later durable position exists. A later pending-action
marker can survive even when the caller never receives its acknowledgement.
Restoring the earlier active checkpoint in that situation can repeat work whose
outcome is still unknown.

Both selected-driver and coordinator `restoreLatest` entry points therefore
require the history backend's `readLatest(receipt)` operation. The built-in
`DurableSelectedHistoryJournal` checks the stream's immutable published positions
before and after reading and validating the complete supplied chain. Any later
position refuses restoration, including a malformed or unacknowledged later
record. Missing, noncanonical and unexplained positions also refuse. Caller
receipt bytes are captured before the first storage wait.

`readLatest` does not discover or adopt a new acknowledged head. The embedding
must obtain and reconcile the exact independently acknowledged receipt through
its existing head authority. `readAll(receipt)` remains available for historical
inspection, predecessor validation and exact idempotent append readback, but it
cannot satisfy the latest-history restore contract. A custom backend must
implement the explicit freshness contract; restoration has no fallback to a
prefix-only reader.

The motivating regression saves an active coordinator checkpoint, then a later
pending-selection marker while retaining only the earlier acknowledged receipt.
Before the fix, fresh `restoreLatest` returned a runnable driver. After the fix,
it rejects before any native reconstruction or host dispatch. Additional controls
cover a later position appearing during the chain read, receipt mutation,
noncanonical/missing positions, fresh-process completed-effect recovery, and
refusal of a newer unacknowledged cut without repeating the effect.

This is a freshness check during verification, not an execution lease against
future writers. The embedding must still exclude concurrent execution owners.
Distributed ownership, journal/head transactions, pending native/host outcome
reconciliation and automatic resumption after unknown effects remain separate
work. The exact native request journal supplies a different authority: it can
recover a known committed native outcome, but does not by itself reconcile the
composite history or authorize host work.
