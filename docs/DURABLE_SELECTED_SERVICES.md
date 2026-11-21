# Durable selected service boundary

`createDurableSelectedService` prevents a recovered selected action from invoking
the same controlled service twice, including when the original producer resumes
after a successor has reconciled the action as `not-dispatched`. The gate belongs
at the service boundary. Every worker for that service must use the same durable
journal, and callers must not retain another route around the gate.

This is a bounded **at-most-once invocation** mechanism. A durable producer intent
alone cannot provide this property: its numbered attempts can advance while an
older process is paused between acknowledging its intent and calling the service.
The service's claim uses one logical identity across all of those attempts.

For ownership changes or terminal admission control, use the strict
`DurableFencedSelectedServiceJournal` described below. It orders new admissions
and authority changes together. The original `DurableSelectedServiceJournal`
provides at-most-once invocation without choosing which producer may win.

## Register a service

```js
import {SelectedExecutionLifecycleV8,createDurableSelectedService}
  from 'tracing-js-self/semantic/v8';
import {DurableSelectedServiceJournal} from 'tracing-js-self/storage/node';

const journal=new DurableSelectedServiceJournal({
  directory:'/private/service-state/store',
  maxBytes:1024*1024
});
const store=createDurableSelectedService({
  serviceId:'primary-store',
  operation:'demo.store',
  journal,
  service:async([key,value],context)=>{
    // This implementation is reached only by the acknowledged service claimant.
    // The embedding still supplies its normal service authorization and storage.
    await applicationStore.put(key,value);
    return value;
  }
});
const execution=new SelectedExecutionLifecycleV8({
  sessionId:'session1',services:{'demo.store':store}
});
```

The same wrapper works in the `services` registry of `RegionExecutionHarness`
and selected V8 execution. The lifecycle supplies an immutable `selectedAction`
binding containing the original session, invocation, effect, operation,
idempotency key, exact payload and digest, task revision and selected request.
There is no new model output, public replay record or native semantic wire format.

The declared operation must have an invocation lifetime, a scalar result codec
and no callback or subscription behavior. Operations that create live resources,
callback-return operations and subscription closers are refused at registration.
Retaining a handle's scalar spelling would not restore its live ownership.

## Authority and crash behavior

The service journal uses `(serviceId, sessionId, invocationId, effectId)` as its
logical key. It binds the full request separately. Payload, operation, task
revision, request witness or caller idempotency-key changes under that logical
identity are conflicts; they do not allocate another execution right. The
producer's attempt counter is deliberately absent.

The journal publishes immutable claim and outcome files with an atomic
no-replace hard link, file `fsync`, and containing-directory `fsync`. Only the
original acknowledged claimant receives the in-process authority to record the
outcome. Serializing that receipt or reopening the journal does not recreate its
authority. Outcome reads check the request binding, exact fields, canonical bytes
and scalar tags, and refuse final-component symlinks.

| Service state | Next caller's behavior | Actual service calls |
| --- | --- | --- |
| No claim | Atomically claim, then invoke after durable acknowledgement. | At most one winning caller. |
| Claim with retained result | Return the original exact scalar or rejection. | No additional call. |
| Claim without retained result | Throw `SelectedServiceBoundaryError` with `code: 'outcome-unknown'`. | No additional call. |
| Conflicting request or invalid storage | Throw a service boundary error. | No additional call. |

The host lifecycle propagates service boundary errors and marks its dispatched
intent uncertain. It does **not** manufacture a guest rejection or an observed
result. An ordinary service throw/rejected promise is instead an actual observed
rejection; its original `adapter-throw` or `adapter-rejection` classification and
exact scalar value are retained. Undefined, BigInt, negative zero, NaN and
infinities retain their existing lossless scalar encoding.

If the service completes and the outcome acknowledgement is lost, a later caller
can read the retained outcome without running the implementation again. If the
process dies after claiming, after its effect, or before outcome publication,
the result stays unknown. A producer-side `not-dispatched` reconciliation cannot
erase that claim. Cancellation after claiming likewise does not release it.

Every retained outcome read also synchronizes its directory before returning.
A duplicate's earlier claim acknowledgement is insufficient: another worker
can link the outcome afterward and then fail its own directory sync. The
[retained actual-I/O race](evidence/service-fence/README.md) reproduced that gap
in the original basic reader and verifies refusal after the correction.

Normal adapter errors are observed rejections. An adapter that cannot determine
whether a downstream remote operation completed must throw
`SelectedServiceBoundaryError` instead. The gate cannot infer a remote service's
transaction outcome from a transport failure.

## Fenced session admission

`DurableFencedSelectedServiceJournal` adds a strict service-owned admission
authority for one `(serviceId, sessionId)`. Its supervisor methods are separate
from the three-method interface supplied to service workers:

```js
import {createDurableSelectedService} from 'tracing-js-self/semantic/v8';
import {DurableFencedSelectedServiceJournal} from 'tracing-js-self/storage/node';

const supervisor=new DurableFencedSelectedServiceJournal({
  directory:'/private/service-state',
  serviceId:'primary-store',
  sessionId:'session1',
  maxEntries:4096,
  maxEntryBytes:1024*1024,
  maxLogBytes:16*1024*1024
});

// Authenticated supervisor work, completed before enabling the first worker.
const firstOwner=await supervisor.advanceOwner({ownerId:'worker-one'});
const serviceFor=owner=>createDurableSelectedService({
  serviceId:'primary-store',
  operation:'demo.store',
  journal:supervisor.forOwner(owner),
  service:async([key,value])=>{
    await applicationStore.put(key,value);
    return value;
  }
});
const firstService=serviceFor(firstOwner);

// Retain the acknowledged receipt independently and supply it to the successor.
const nextOwner=await supervisor.advanceOwner({
  previous:firstOwner,
  ownerId:'worker-two'
});
const nextService=serviceFor(nextOwner);

// This fences NEW service admissions. Already admitted work may still finish.
const terminalReceipt=await supervisor.terminate({
  owner:nextOwner,
  reason:'cancelled'
});
```

Each service worker can reopen the same directory in a fresh process and call
`forOwner()` with its original owner receipt. That binding captures the receipt;
changing the caller's object does not change its authority. There is no implicit
owner and no unfenced fallback. `claim()` without an owner refuses. A terminal
receipt is not an owner receipt. Supervisor methods must remain behind the
embedding's authenticated control path; a receipt is a durable transition fact,
not a replacement for authentication or an authorization to grant oneself a new
generation. Giving a producer unrestricted supervisor methods defeats the
ownership policy.

### One ordering point for claims and fences

Owner transitions, terminal fences and **new** action claims occupy one contiguous,
hash-linked log for the service session. A command validates against the complete
preceding log, writes and synchronizes its temporary file, and attempts an atomic
no-replace hard link at the next numbered slot. The successful link is its
ordering point. Directory `fsync` must finish before the operation returns an
acknowledgement or invokes the service.

A competing writer cannot append using a stale head. It loses the same slot,
replays the winner and validates its command again. Thus a worker paused after
computing its proposed claim cannot claim a different per-action file after a
successor or terminal fence wins. Claiming and checking current ownership are
one ordered operation. Two different successors using the same expected owner
cannot both succeed; the loser receives `owner-conflict`.

| Durable order | Permitted behavior |
| --- | --- |
| Successor owner before a new old-owner admission | Refuse with `stale-owner`; do not call the service. |
| Terminal before a new admission | Refuse with `session-terminal`; no owner can reopen the session. |
| Admission before successor or terminal | Its original claimant may still invoke and finish the admitted work. |
| Duplicate already admitted action, under any retained valid owner | Return the original outcome or `outcome-unknown`; never grant another execution right. |
| Same logical action with changed bound request bytes | Refuse the conflict, including after ownership changes. |

An admission is ordered when its slot is linked, even if the process pauses
before its directory synchronization or acknowledgement. A later acknowledged
fence includes that preceding slot. It cannot retroactively cancel the admitted
work. The real-process regression pauses at exactly this point, durably advances
ownership and terminates admission, observes an unknown result from another
worker, then allows the original claimant to finish once.

### Lost acknowledgements and retained results

Visible unacknowledged slots remain authoritative; they are never skipped or
reinterpreted as free slots. An exact retry of `advanceOwner()` or `terminate()`
can acknowledge its already recorded transition, but first synchronizes the
containing directory again. `inspect()` validates the full log and performs the
same synchronization before returning retained authority. A failed directory
sync therefore remains a failure on retry or inspection. Reading a file alone
does not prove its directory entry is durable.

An owner retry returns its original transition receipt even if a later owner or
terminal transition now exists. It does not reactivate that owner. Every new
claim independently checks the current replayed authority. The returned receipt
is a historical fact, not a lease promising future admission.

Only the actual successful claim publisher receives the in-process capability
to record its outcome. An identical losing claim, a serialized acknowledgement,
a restarted process, and a later owner cannot recreate that capability. A crash
after claim publication but before invocation can leave an unknown action with
zero effects; a crash after the effect can leave an unknown action with one
effect. Both refuse another invocation. Terminal fencing does not turn either
case into a known cancellation.

Outcomes remain immutable separate files, bound to the full original action.
An admitted claimant may record its result after ownership changes or terminal
fencing. Recovered outcomes are validated and their directory is synchronized
before the wrapper returns an observed completion. Outcome publication failure
leaves unknown work; a lost acknowledgement after successful publication allows
later result recovery without another service call.

### Required supervisor and selected-history ordering

The service admission log and `DurableSelectedHistoryJournal` are separate
authorities. `SelectedServiceAdmissionCoordinator` can order their terminal
boundaries through the selected driver, as described below. It does not
atomically join writes across services or history storage.

For a successor, first verify the selected checkpoint and public history through
the ordinary recovery path. Then durably advance each participating service's
owner before enabling the successor's service registry or authorizing recovery
that may attempt new dispatch. A newer selected-history head alone does not
fence an old process at the service.

For terminal shutdown, stop initiating local selections and obtain every
required service-session terminal acknowledgement **before** acknowledging the
selected-history terminal disposition as a barrier against new service work.
The embedding must arrange this ordering before invoking a driver cancellation
path that records terminal history. An asynchronous abort listener by itself
does not establish the order. If service fencing fails or its acknowledgement
is unavailable, inspect or retry the exact control command; do not report a
successful admission fence. A native selector's close receipt alone supplies
no service admission authority.

### Coordinate selected-driver cancellation and recovery

Use an explicit supervisor-owned coordinator for the complete service set whose
admissions must stop when this driver session is cancelled:

```js
import {SelectedServiceAdmissionCoordinator} from 'tracing-js-self/storage/node';
import {RegionSelectedModelDriver} from 'tracing-js-self/semantic/v8';

const serviceAdmissionCoordinator=new SelectedServiceAdmissionCoordinator({
  sessionId:'session1',
  services:[{journal:supervisor,owner:nextOwner}]
});
const driver=new RegionSelectedModelDriver({
  select,harness,...driverPolicy,serviceAdmissionCoordinator
});
const first=await driver.enableDurableHistory({
  journal:historyJournal,
  acknowledge:retainIndependentHistoryHead
});
```

The coordinator captures the declared service IDs and owner receipts. The driver
binds that sorted service set and session into its checkpoint policy. Retain the
complete expected policy independently, including its `serviceAdmission` field;
recovery cannot silently omit or replace that field. This is an opt-in contract
for the declared registry, not discovery or enforcement of unrelated services.
Keep the coordinator and the underlying supervisor methods outside guest/model
authority, and give service workers only their `forOwner()` interfaces.

Cancellation immediately stops new local model selection, then terminates each
declared service session and independently inspects its durable terminal state.
Only after **every** service acknowledges the exact reason and owner does the
driver append and independently acknowledge its `requested` terminal history
entry. The subsequent `closed` or `unknown` entry retains the same complete
service-fence proof. A positive native close still describes native closure;
the separate service receipts describe admission fencing. Work admitted before
a fence may finish, and an uncertain external result stays uncertain.

If a service write, directory sync or verification fails, no terminal history
entry or native close is initiated by that cancellation attempt. Services already
fenced remain fenced. While the same driver is retained,
`await driver.retryServiceAdmissionCancellation()` retries only this pre-history
failure using the original reason and owner receipts. It cannot retry a lost
history-head acknowledgement or invent a new head. The ordinary service journal
retry path synchronizes any already-visible transition again before acknowledging
it. A history write/acknowledgement failure requires the independently retained
history head and normal recovery instead.

For fresh recovery, pass an independently constructed coordinator over the same
service journals as `serviceAdmissionCoordinator` to `restoreLatest()` or
`restore()`. A terminal history result is returned only after the coordinator
independently replays and syncs each exact service terminal receipt. Rehashing a
forged history and receipt does not replace service authority. Active restoration
checks that every declared service is still active under its supplied owner
before opening native model state. A terminal or partially terminal service set
with only an older active history cut refuses active restoration. It does not
infer a successful native close or erase unknown work. A crash in that interval
still needs supervisor reconciliation; completing cancellation from a different
process without a retained terminal history cut is not claimed here.

These checks establish an ordered boundary, not a cross-store transaction or a
lease. Another supervisor can advance ownership after an active-state read; each
new actual service admission still rechecks ownership atomically in its own log.
Successor ownership coordination, callback/resource completion, incoming-input
atomicity, journal rotation and deployment rollback remain separate obligations.

The service-coordinator and selected-history tests cover partial I/O failure,
same-request retry, owner changes, complete receipt binding, withheld terminal
history/native close, lost history acknowledgements, forged/rehashed receipts,
fresh service-journal reads and refusal before native restoration. Their supplied
model-shaped snapshots are explicit test fixtures; they do not establish learned
execution or production-model recovery.

If service fencing succeeds but selected-history recording later fails, the
service remains fenced and the selected-history result is separately uncertain.
There is no rollback that reopens service admission. With several independent
services, fencing one does not atomically fence the others; the supervisor must
retain and report every required receipt. Already admitted effects and their
unknown results remain explicit in all of these cases.

### Bounds and storage assumptions

Every operation replays all retained slots and verifies exact fields, scope,
position, predecessor receipt, owner generation, terminal monotonicity and
logical action binding. Missing slots, extra malformed position names,
noncanonical bytes, malformed UTF-8, final-component symlinks and invalid state
transitions refuse. Configured entry, per-entry byte and total-log byte limits
fail closed. Exhaustion does not create a terminal fence; exact historical
acknowledgements and existing outcome recovery remain available. Outcomes are
bounded individually and cannot outnumber admitted actions. The log has no
pruning, rotation, expiry, automatic takeover or abandoned-claim reassignment.

The trusted POSIX storage assumptions below still apply. Keep every immutable
entry and outcome across restarts; deleting a tail or restoring an older storage
snapshot can forget an acknowledged fence. Supervisor receipt retention is
necessary operational evidence, but this implementation is not a rollback-proof
storage system. Directory ancestors must be trusted and durably provisioned.
All workers for a fenced session must use the strict binding. Mixing it with
the original unfenced journal, using separate directories or bypassing the
wrapper invalidates the fence guarantee.

## Scope and remaining operational work

The controlled guarantee requires a trusted, persistent service-owned POSIX
filesystem with working atomic hard links and `fsync`. Provision its durable
ancestor directories before use; share the same journal namespace across all
workers and retain it across service restarts. Per-producer directories, deleting
claim files, bypassing the wrapper, restoring a storage snapshot that forgets
claims, and filesystem implementations that violate those primitives invalidate
the guarantee. The journal has an individual-file byte bound and no pruning API.

Neither journal guarantees exactly-once success, remote distributed
transactions, automatic reassignment of abandoned claims, terminal cancellation
of work already admitted by the service, live resource restoration, callback/input
atomicity or safe log rotation. With the original unfenced journal, a delayed
old producer may win the first service claim. The strict journal prevents new
old-owner admission after an acknowledged successor or terminal fence, while
preserving previously admitted work. Authentication, supervisor authorization,
service identity, coordination with selected history and filesystem access remain
embedding responsibilities.

The regression selection exercises two independent service workers racing for a
claim, an old producer paused after its producer intent, a service claimant
paused before invocation, process death after the external append, result recovery
in another process, publication/acknowledgement failures and request/outcome
corruption. These controlled service tests do not establish a learned-model,
production deployment or arbitrary external-provider atomicity claim.

```sh
node --test test/semantic-service-fence-v8.test.js \
  test/semantic-durable-service-v8.test.js \
  test/semantic-durable-action-recovery-v8.test.js \
  test/semantic-host-recovery-v8.test.js test/semantic-lifecycle-v8.test.js \
  test/semantic-region-host-receipt-v8.test.js \
  test/training-selected-intent-journal.test.js \
  test/training-harness-v4.test.js test/training-harness-v4-continuity.test.js
```
