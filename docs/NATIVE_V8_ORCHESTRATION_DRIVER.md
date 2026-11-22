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
terminal coordinator, or unsupported ingress cannot be checkpointed. The
ordinary semantic-only checkpoint is not used as a substitute. Durable history,
automatic history, and `restoreLatest` remain unavailable; completed or failed
terminal sessions are not resumable through this API.

The JSONL protocol-peer integration test exercises the JavaScript driver and
transport contract with generated fixture records. It validates binding,
receipt, original-byte, mixed-ledger, zero-dispatch restore, and ordering
checks; it is not a model-quality or production completion qualification.
