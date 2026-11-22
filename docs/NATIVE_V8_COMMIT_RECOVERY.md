# Exact native commit recovery

## Producer request foundation

`DurableNativeV8RequestJournal`, exported by `tracing-js-self/storage/node`,
records the original semantic or coordinator commit JSONL bytes together with
the entire immediately preceding native transport checkpoint. Each request
names its session, stream, positive generation, immutable ordinal, operation,
checkpoint, tokenizer and optional training identity.

Publication synchronizes a private temporary file, atomically links it to an
ordinal slot without replacement, synchronizes the containing directory, and
independently rereads the exact bytes. Only the original publisher receives a
new dispatch acknowledgement. An existing ordinal never authorizes another
dispatch. The next request must extend the complete ordinal sequence. Reading
an older request with `latest: true` refuses when any later intent exists,
whether or not that later request has a known native outcome.

`inspect(ordinal)` independently validates and synchronizes a retained intent
and returns its bytes and receipt after a caller loses its original return
value. It does not report a native outcome, grant a retry or authorize host work.
`list()` describes stored ordinals only. Generation is an external supervisor
authority; choosing an old generation does not discover or invalidate later
work in another generation.

Every input is snapshotted before the first storage await. Stored data must
retain the exact pending model selection and full precommit identity. Changed
models, altered request or checkpoint bytes, duplicate JSON fields, malformed
UTF-8, gaps, unsafe paths, nonprivate files and exceeded bounds refuse.

The kernel execution lease now has a private runtime brand. A plain object
that implements similarly named methods cannot impersonate an acquired lease.
The original lease must remain live and bind the same session and stream.
This is still trusted local Linux filesystem/process exclusion, not a remote
lease service or distributed ownership protocol.

## Validation of the first increment

Eight producer-journal controls and all six existing cross-process kernel-lock
controls pass locally, with zero skips. They cover reopen and readback, caller
mutation during storage, duplicate/concurrent ordinal publication, stale
recovery, altered bytes and receipts, malformed request frames, filesystem
refusals, authentic leases, crashed holders and outliving inherited children.

The first local run caught a real caller-mutation error: validation used a
snapshot, while a later ordinal check still read the caller-owned identity.
Every later ordinal use now comes from that snapshot. The sandbox also lacked
`/tmp` and maps system executable owners to `nobody`; local tests use a writable
temporary directory and an owner-private copy of the same `flock` executable.
The test-only `TRACING_TEST_FLOCK` setting selects that executable. Production
ownership requirements are unchanged, and ordinary CI uses `/usr/bin/flock`.

## Guarded producer/native transport

The process and Python selector factories accept `durableRequests: {journal,
executionLease}`. Both objects must be the original objects issued by the
storage implementations. Each lease can launch exactly one child. A replacement
must release the parent descriptor and acquire a fresh lease; acquisition stays
blocked while an outliving child retains the original descriptor.

Before each semantic or coordinator commit the transport freezes its exact
request, captures the native precommit checkpoint, publishes and independently
rereads the producer intent, then calls the native durable commit endpoint.
The complete interval is serialized, including storage waits before any native
dispatch. A concurrent initialization, checkpoint, cancellation or commit cannot
alter the in-progress request. Unrelated requests keep their normal protocol.

The native reply must carry the exact original response bytes and full
postcheckpoint. The producer independently compares its model/settings,
randomness, session population, closed tombstones, opening records and sibling
state to the saved precheckpoint. Its original target attempt must be the sole
attempt changed from pending to committed. The exact native receipt must agree
with the committed public/context state or the native coordinator decision.
A missing, changed or uncertain reply fences the process and preserves an
unknown acknowledgement; it does not make the commit a failed/no-effect action.

After obtaining a fresh execution lease and native process, use
`select.recoverCommit({receipt})`, where `receipt` is the independently retained
producer receipt or a freshly validated result of `journal.inspect(ordinal)`.
The fresh process is not initialized separately. Native recovery independently
reads its matching completed journal slot, reconstructs the whole saved adapter
through ordinary model reexecution, and compares every restored field before
returning the exact original reply. The producer then reconstructs its matching
accepted attempt, child ownership and original selection fragments. It does not
select or dispatch new work during reconciliation.

```js
import {DurableNativeV8RequestJournal,DurableSelectedOrchestrationExecutionLock}
  from 'tracing-js-self/storage/node';
import {createNativeV8PythonSelector} from 'tracing-js-self/semantic/v8';

const journal = new DurableNativeV8RequestJournal({
  directory, sessionId, streamId, sessionGeneration: 1,
});
const lock = new DurableSelectedOrchestrationExecutionLock({
  directory, sessionId, streamId,
});
const executionLease = await lock.acquire();
const select = createNativeV8PythonSelector({
  python, megatokenRepository, servedBundle,
  durableRequests: {journal, executionLease},
});
try {
  const recovered = await select.recoverCommit({receipt});
  // Exact native commit outcome only. Reconcile the independent host/history
  // boundary before deciding whether the application may continue.
  console.log(recovered.result, recovered.hostRecoveryAuthorized); // false
} finally {
  if (!select.status().closed) await select.shutdown();
  await executionLease.release();
}
```

The result deliberately reports `hostRecoveryAuthorized: false`. Recovering one
native commit does not reconstruct the host driver, seal a composite history cut,
reconcile remote service effects, or transfer external history-head authority.
The existing automatic composite restore path is not enabled by this API.

## Refusal boundaries

The native process freezes the same session, stream and generation as the
producer journal. A fresh process with retained history in that exact scope
must reconcile it before any application mutation. Ordinary checkpoint restore
is refused in durable mode; it cannot substitute an earlier native checkpoint
for the journal's latest committed state. Selecting a new generation is an
explicit supervisor decision, not an inferred takeover of older work.

Every later application mutation, including selection, bootstrap, completion,
rejection and cancellation, durably supersedes the previous recoverable commit
before it runs. A crash in that interval cannot restore the older native state.
A new completed durable commit establishes a new recoverable boundary. Read-only
status, metrics and checkpoint inspection preserve the current boundary. Clean
process EOF only disposes in-memory objects; it does not create an acknowledged
application cancellation or invalidate an otherwise exact checkpoint.

An intent without its native outcome is permanently unknown to this primitive.
A producer-only intent does not prove that native work ran and cannot authorize
retry. Any later intent or native supersession marker refuses stale recovery.
Tampered receipts, altered original bytes, pending sibling selections, changed
whole-adapter state, lease reuse and wrong generation also refuse.

## Remaining application integration boundary

The request journal is only the producer prerequisite. A positive reply must
also be durably owned on the native side, bind its exact postcommit checkpoint,
and independently reexecute to that entire checkpoint, including sibling
sessions, budgets, original model fragments and randomness. An unresolved
native outcome must remain unknown. Saved selection replies cannot restore
abandoned speculative model state. Automatic composite host/history recovery
still needs its own exact continuation and external-service reconciliation.
