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

There is no resumable orchestration checkpoint or durable history API in this
increment. `checkpoint`, `checkpointDurableHistory`, automatic history, and
restore entry points refuse the request. The ordinary
`semantic-selected-driver-checkpoint/8` schema only verifies semantic attempts
and cannot represent a mixed coordinator and child attempt ledger. The native
model can replay its orchestration operations, but a host/native composite
checkpoint and independently retained history chain have not been implemented
for this driver. A failed active run is cancelled and returned as terminal
evidence; it must not be resumed from a child-only checkpoint.

The JSONL protocol-peer integration test exercises the driver and native
transport contract with generated fixture records. It validates binding,
receipt, original-byte, and ordering checks; it is not a model-quality or
production completion qualification.
