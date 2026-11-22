# Native V8 orchestration driver

`RegionSelectedOrchestrationDriver` runs the bounded V8 coordinator through the
ordinary native model selector and runs each joined child through
`RegionSelectedModelDriver`. The coordinator's lifecycle record is the original
model output: the driver passes its exact UTF-8 bytes and selection evidence to
`commitOrchestration`. It does not construct, repair, or substitute lifecycle
actions.

## Use

Use a selector created for the native V8 model and pass the frozen model,
tokenizer, training-lineage, seed, and generation-setting identities that the
loaded model must attest:

```js
import {
  createNativeV8PythonSelector,
  runSelectedRegionOrchestrationV8,
} from 'tracing-js-self/semantic/v8';

const select = createNativeV8PythonSelector({
  python: 'python3',
  megatokenRepository,
  servedBundle,
  device: 'cpu',
});

let result;
try {
  result = await runSelectedRegionOrchestrationV8({
    initialPublic,
    select,
    checkpointIdentity,
    tokenizerIdentity,
    trainingIdentity,
    seed,
    generationSettings,
    maxActive: 1,
    childBudget: 128,
    harnessOptions: { services: productionServices },
  });
} finally {
  // The driver closes the native session; the caller owns the subprocess.
  select.close();
}
```

`generationSettings` must match the loaded selector settings exactly. The
`harnessOptions` object configures ordinary host services on the region
harness. The driver has no fixture broker, teacher answer, or controlled
lifecycle input. Source execution and learned coverage are separate checks;
the returned result keeps `sourceValidated: false` and
`defaultPromotion: false`.

The class form is available when the caller needs to retain the one-shot
driver object:

```js
import { RegionSelectedOrchestrationDriver } from 'tracing-js-self/semantic/v8';

const driver = new RegionSelectedOrchestrationDriver(options);
const result = await driver.run({ signal });
```

The initial public cut contains observed source definitions and one to sixteen
root call inputs. It must pass the same public-prefix replay that the native
consumer applies. One retained root is allowed. A multi-root cohort requires
distinct fresh realms. Callback invocations, nested invocations, and dynamic
descendants are outside this bounded profile.

## Action and child ordering

The native coordinator selects only the bounded lifecycle profile: `track_create`,
`track_join`, `track_progress`, `track_complete`, or `track_cancel`. Each
selection is checked against the current native coordinator context and its
checkpoint, tokenizer, lineage, session, public-cut, fragment, and byte
identities before the exact selection is committed.

After an acknowledged `track_create`, the driver matches the returned track
and completion dependency to the declared invocation, then obtains the native
bootstrap receipt. The host does not run that invocation at creation time. It
waits for the coordinator's original `track_join` action and checks that the
joined child is active and bootstrapped before calling
`RegionSelectedModelDriver.runInvocation` for that exact root. The ordinary
semantic selections and commits run on the native child track. The child
driver's `complete` call must return a typed native completion receipt bound to
the exact public cut, contexts, child invocation, track, and result before the
coordinator may select its next action.

This gates root execution on native reservation, bootstrap, and join receipts.
Public root rows remain in their original canonical order. The root scheduler
only accepts cohorts that the native public-prefix validator also accepts.

## Attempts, cancellation, and time limits

The returned `coordinatorAttempts` retain each original coordinator record,
selection evidence, commit receipt, and later bootstrap or child-completion
outcome. `childAttempts` retain the ordinary semantic selections. A positive
native commit receipt remains counted as acknowledged even if a later host
step fails. Unknown acknowledgements remain distinct from rejected selections.

On a failure or caller cancellation, the driver normalizes one cancellation
reason at a UTF-8 code-point boundary to at most 4096 bytes. It uses that same
reason for coordinator cancellation, native session close, and the returned
disposition. If the model selects `track_cancel`, its native cancellation
receipt supplies the disposition reason.

`timeoutMs` is a cooperative host-execution deadline. It aborts child execution
and waits for any in-flight native request to settle before cleanup so an
acknowledgement is not mistaken for a rejection. The native selector's own
request timeout bounds an in-flight JSONL RPC; `timeoutMs` does not interrupt
that request.

The driver is one-shot. It initializes and closes one native session, and a
driver instance cannot be reopened. A new run requires a fresh driver and
session identity.

## Recovery boundary

Composite checkpoints are available only at a requested quiescent pause. Use
`run({ stopAt: { phase, coordinatorSelections } })`; `phase` is
`coordinator-ready` or `child-ready`, and the selection count names the exact
coordinator prefix. A `coordinator-ready` cut follows opening, exact
create-plus-bootstrap, an acknowledged child completion, or progress. A
`child-ready` cut follows the exact acknowledged join and precedes all child
execution. With `maxActive` above one, other created and bootstrapped roots may
already occupy active slots; the driver still runs only the root named by the
acknowledged join. Roots must remain in the bounded ingress profile described
above.

The checkpoint joins the immutable source ingress, host bridge and causal
contexts, original coordinator and child bytes, positive receipts, rejected
child selections, native attempt/replay/operation history, and an explicit
next-action phase. Restore independently verifies that mixed ledger before
asking a fresh native selector to replay the native checkpoint. The native
restore receipt must report zero host dispatch. The restored selector status
and attempt ledger are then compared with the same composite packet before the
child driver receives its recovery state.

An acknowledged stale child prediction is retained as a rejected native
attempt, with its original selection, rejection reason, retry count, and host
preflight rejection row. It does not appear as a semantic replay operation or
add a generated public row. Restore checks that its native `semantic-rejected`
status and transport `rejected` status both bind the same original selection
and refusal reason.

Pause returns the packet as `result.checkpoint` and leaves the selector process
open. The caller closes that process, creates a fresh selector with the same
frozen model settings, and restores the packet with the same initial public
cut, policy, and live host services:

```js
let paused;
const policy = {
  checkpointIdentity, tokenizerIdentity, trainingIdentity, seed, generationSettings,
  maxActive: 1, childBudget: 128, maxCoordinatorSelections: 128, maxPredictions: 4096,
  maxGenerated: 16384, maxOutstanding: 64, maxStaleRetries: 8, timeoutMs: 15000,
  automaticDelivery: true,
};
const first = createNativeV8PythonSelector({ python: 'python3', megatokenRepository, servedBundle });
try {
  paused = await runSelectedRegionOrchestrationV8({
    initialPublic, select: first, ...policy,
    stopAt: { phase: 'coordinator-ready', coordinatorSelections: 2 },
    harnessOptions: { services: productionServices },
  });
} finally {
  first.close();
}

const resumedSelect = createNativeV8PythonSelector({ python: 'python3', megatokenRepository, servedBundle });
try {
  const resumed = await RegionSelectedOrchestrationDriver.restore(paused.checkpoint, {
    initialPublic, select: resumedSelect, policy, harnessOptions: { services: productionServices },
  });
  result = await resumed.run();
} finally {
  resumedSelect.close();
}
```

`policy` must contain the exact checkpoint, tokenizer, training, seed,
generation, host-limit, callback-delivery, and timeout fields used to create
the original driver. The native selector's per-request timeout bounds each
JSONL RPC. `timeoutMs` is a cooperative active-run budget; the checkpoint keeps
the consumed `elapsedMs`, and restored execution receives only the remaining
budget. The timer is stopped while the caller holds a paused packet.

An in-flight or unknown acknowledgement, running child, unsettled host intent,
terminal coordinator, or unsupported ingress cannot produce an active checkpoint.
Successful coordinator completion has a separate, nonresumable disposition described
below. The ordinary semantic-only checkpoint is not used as a substitute. Explicit
durable history, automatic pre-action fences and `restoreLatest` preserve this
distinction. Failed or cancelled orchestration reconciliation remains outside this
profile.

The JSONL protocol-peer integration test exercises the JavaScript driver and
transport contract with generated fixture records. It validates binding,
receipt, original-byte, mixed-ledger, zero-dispatch restore, and ordering
checks; it is not a model-quality or production completion qualification.

## Independently acknowledged durable composite history

After an explicit quiescent pause, `driver.checkpointDurableHistory({journal,
acknowledge,previous})` appends the exact verified composite packet to
`DurableSelectedHistoryJournal`. It independently rereads and validates the
complete chain before asking the application's `acknowledge({receipt,previous})`
callback to durably retain that exact head. The callback must return the same
receipt after its own durable compare-and-swap succeeds. It must not merely echo
the argument without independent storage. A failed or different acknowledgement
leaves the driver without a new reusable receipt.

The journal retains full cuts, so selection counts may be nonconsecutive. Every
cut must be a true extension of the prior public, coordinator, child and native
histories. An acknowledged join may acquire its verified child completion;
original selection bytes, receipts and already recorded completion evidence
cannot change. Initial inputs, policies, native identities and random opening
state are immutable; consumed work, costs and elapsed time cannot roll back.
The ordinary semantic-only history format remains accepted on its existing path,
and semantic/composite cuts cannot be mixed in one chain.

`RegionSelectedOrchestrationDriver.restoreLatest(packet,{historyJournal,
historyReceipt,initialPublic,select,policy,harnessOptions})` requires an
independently retained expected head. It reads the complete chain, finds the
supplied packet in that chain, validates every cut against the external source
and policy, then restores its latest acknowledged cut. A matching older packet
is only an anchor; it never authorizes replay of work acknowledged later. The
application must supply its current independently acknowledged head under sole
supervisor ownership. Supplying an older valid receipt verifies only that older
prefix; this API cannot discover that the application's external head is stale. Native
restoration must still report zero host dispatch. A partial chain, altered
predecessor, absent packet or changed policy is refused before native restoration.
A valid completed terminal head follows the separate closed-session verification
path below; it cannot become active work. Caller-owned data arguments are snapshotted before storage
awaits; live host clock/service functions remain supplied through `harnessOptions`.

Automatic history can be started before execution with
`driver.startAutomaticHistory({journal,acknowledge,previous})`. At each
quiescent coordinator boundary the driver writes and rereads the full composite
cut, then waits for the independent head acknowledgement before taking another
coordinator action. Before every coordinator selection it also acknowledges a
`coordinator-selection` pending marker. Before a joined child starts
host execution, it acknowledges a `child-dispatch` marker bound to
that exact join dependency. An explicitly requested `child-ready` pause writes
a complete cut without arming the child marker; resumed execution must first
acknowledge the marker before dispatch. A later verified cut seals the marker
only when it contains exactly one committed coordinator action, or only the
joined child's completed result without another coordinator selection. The
journal's independent readback must contain the exact pending marker before
that head can be acknowledged. A lost or mismatched acknowledgement stops the live driver.

A latest pending marker means the action may have started after the saved cut.
`restoreLatest` refuses that head before native restoration, so it
cannot replay a possibly dispatched child. Successful coordinator completion may
seal its exact pending selection with the independently verified closed-session
disposition below. Cancellation, failed or unknown outcomes remain fenced at the
pending selection marker. In-flight continuation, external reconciliation and
distributed transactionality are not implemented.
It does not coordinate service owners, discover unacknowledged files, or permit
a second process to resume from a stale independently retained head. Supervisor
ownership remains required. The new controls use fresh JSONL fixture peers and
actual durable storage. The successful real-native result is recorded below;
new executable revisions still require their own paired qualification.

## Validation scope for the automatic-history increment

The first hosted automatic run exposed two fixture-deadline failures. After
removing redundant full-cut replay inside already independently checked chains,
validation candidate `ac85e028b35ce9757186be746b677698a3b4232d` passed all 105
individual JUnit cases, zero skips, in run 44988575827. The two-child sparse-cut
control covers two declared fresh roots and zero repeated child selection after
restore. Durable-storage tests use an explicit 60-second policy to accommodate
fsync and runner contention; live deadline accounting/defaults are unchanged.
The public standalone extension validator still fully verifies both cuts, and
every chain read verifies every entry plus all action/prefix constraints.

Actual Python/shared-runtime controls exercise automatic positive restore and
lost acknowledgement before coordinator selection and after child completion.
At candidate `e32b412e86e8ececf2e025c8ccaffd23e1f17c53`, paired with native
`e9817ad637f57ba82e370770420f6f3ef877c7b3`, all 77 paired transport controls passed
with zero skips in [run 44991390261](https://github.com/werg/tracing-js-self/actions/runs/44991390261).
This includes positive automatic restore, closed-session completion, and lost
acknowledgements. Their final lexical decoder is an explicit deterministic fixture,
so a pass does not qualify learned model quality, arbitrary external side effects
or distributed ownership.


### Composite terminal disposition

Automatic composite history supports a nonresumable terminal disposition for
`track_complete`, and a service-aware terminal disposition for a committed
`track_cancel` only when every declared host invocation is already completed and
the composite is at a quiescent boundary. The service-aware path records an intent
with the exact configured service-owner snapshot and reason, verifies the intent's
independent history acknowledgement, fences and rereads the same service set, then
closes native state and records a final disposition. The no-coordinator successful
`track_complete` path retains its existing behavior.

After native close, the final history event contains the transport checkpoint with
no open session and the exact closed-session tombstone from the validated terminal
snapshot. `restoreLatest` reexecutes that tombstone and requires zero restored active
sessions, zero host dispatches, and exact attempt consumption. It returns a terminal
disposition; it does not restore completed or cancelled orchestration as active work.

An acknowledged service-aware intent that is interrupted remains nonresumable. A
reconciliation attempt must present the same retained owner snapshot and reason.
It may repeat the same service fence idempotently and close only the validator-proved
terminal native snapshot; it performs no new selection or host dispatch. A partial
service fence or lost acknowledgement remains fenced until the same owner can verify
it. Owner substitution, running host work, unknown acknowledgements, failed host
actions, and unsettled cancellation are refused. This does not provide successor
takeover or distributed ownership.

A terminal disposition records coordinator completion or committed cancellation and
the native closed-session tombstone. It does not assert source correspondence, source
validation, or promotion: `sourceValidated` remains false and
`qualification.defaultPromotion` remains false.

### Terminal evidence and failure boundaries

The exact promoted implementation passed 108 individual JUnit test cases with zero
skips in [focused run 44991390200](https://github.com/werg/tracing-js-self/actions/runs/44991390200).
Node's outer summary also counts four test-suite containers; the 108-case count
excludes those containers. Controls cover changed base/pending identity, completed
host state, completion receipts, closed-session contents, consumed native attempts,
lost close and history acknowledgements, and cancellation after journal reading
before any native RPC. The paired gate above includes the actual Python checkpoint
reexecution. [Complete success and failure logs](evidence/v8-composite-terminal-2026-11-22/README.md)
are retained in git.

The application must still provide its independently retained current journal head
under sole supervisor ownership. This API cannot discover a newer head in another
owner's store. Settled `track_cancel` is supported only with the exact configured
service-owner set, an acknowledged intent, independently verified service fences,
and no running or unsettled host work. Failed host actions, cancellation of an
unsettled child, unknown acknowledgements, dynamic descendants, successor-owner
handoff, takeover and distributed ownership remain separate acceptance work. A
two-process deterministic test is not a learned-program result.


The fault-injection gate distinguishes retained bytes from a returned fence acknowledgement.
A directory synchronization failure can occur after the terminal transition file is visible.
The driver still refuses every native restore until the full service-fence set is independently
verified. A fresh journal reader synchronizes and validates those exact bytes; this establishes
current durable readback, without inventing an acknowledgement from the failed writer.
