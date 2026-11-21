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

Normal adapter errors are observed rejections. An adapter that cannot determine
whether a downstream remote operation completed must throw
`SelectedServiceBoundaryError` instead. The gate cannot infer a remote service's
transaction outcome from a transport failure.

## Scope and remaining operational work

The controlled guarantee requires a trusted, persistent service-owned POSIX
filesystem with working atomic hard links and `fsync`. Provision its durable
ancestor directories before use; share the same journal namespace across all
workers and retain it across service restarts. Per-producer directories, deleting
claim files, bypassing the wrapper, restoring a storage snapshot that forgets
claims, and filesystem implementations that violate those primitives invalidate
the guarantee. The journal has an individual-file byte bound and no pruning API.

This does not guarantee exactly-once success, remote distributed transactions,
execution by only the newest producer, automatic reassignment of abandoned
claims, terminal cancellation of work already admitted by the service, live
resource restoration, callback/input atomicity or safe log rotation. A delayed
old producer may be the one winning service claimant; subsequent callers receive
its retained result or an unknown disposition. Authentication, service identity
and filesystem access remain embedding responsibilities.

The regression selection exercises two independent service workers racing for a
claim, an old producer paused after its producer intent, a service claimant
paused before invocation, process death after the external append, result recovery
in another process, publication/acknowledgement failures and request/outcome
corruption. These controlled service tests do not establish a learned-model,
production deployment or arbitrary external-provider atomicity claim.

```sh
node --test test/semantic-durable-service-v8.test.js \
  test/semantic-durable-action-recovery-v8.test.js \
  test/semantic-host-recovery-v8.test.js test/semantic-lifecycle-v8.test.js \
  test/semantic-region-host-receipt-v8.test.js \
  test/training-selected-intent-journal.test.js \
  test/training-harness-v4.test.js test/training-harness-v4-continuity.test.js
```
