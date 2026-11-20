# Bounded Promise scheduling in v8

The v8 producer and independent consumer preserve the order in which declared
jobs and resumptions become runnable. A shorter record cannot silently replace
the jobs required by JavaScript Promise resolution.

## Supported boundaries

Ordinary and arrow callbacks run with their checked receiver, captures and
arguments. Primitive fulfillment and rejection are supported. An ordinary
object reference can fulfill a Promise only after descriptor-only inspection
proves that reading `then` does not invoke a getter and that the selected value
is not callable. The check follows the owned prototype chain and never invokes
guest code. Ordinary array results and nonthenable data graphs remain supported.
Promise rejection reasons remain opaque values, including Promise references.

Executor capabilities and join results each retain exclusive settlement
ownership. Generic detailed settlement cannot bypass their public operations.
An already settled or adoption-locked Promise cannot be settled again. Empty
`Promise.all` is fulfilled immediately and cannot be restored as pending;
empty `Promise.race` remains pending. Generator functions and resolving functions
cannot be dispatched as ordinary scheduler callbacks.

## Explicitly unavailable scheduling profiles

Bare Promise adoption, fulfillment with a Promise or callable thenable, and
normal completion of a callable `Promise.prototype.finally` handler require
additional checked jobs. They are refused before the selected transition changes
state. A throwing `finally` handler can reject directly; a missing handler passes
through its original completion, with the same nonthenable check on fulfillment.
JavaScript `try/finally` statements are unaffected by this callback boundary.

Sorting ready reactions by their original registration order does not model
adoption. For example, resolving one Promise to another can leave a direct
reaction and a queued microtask ahead of the adopting Promise's reaction.
Even a `finally` handler returning a primitive introduces cleanup Promise jobs;
its downstream reaction can run after a nested microtask. Native JavaScript
distinguishing tests retain both orders. These cases are not admitted by
pretending that the missing work is an instantaneous settlement.

The same checks apply to model-selected detail, reaction forwarding and
observed-result import or explicit delivery. An observed result cannot smuggle
an existing Promise identity into an ordinary fulfillment. Failed checks leave
the prior execution state and public receipt prefix unchanged.

The bounded source executor profile remains narrower: its first resolver call
accepts primitive resolution and explicitly declared rejection, while general
object/thenable resolution requires a separate source profile. Runtime support,
public replay and source/native admission remain distinct qualifications.

Tests: [scheduler boundaries](../test/semantic-scheduler-boundaries-v8.test.js),
[observed resolution](../test/semantic-scheduler-resolution-v8.test.js),
[executor boundaries](../test/semantic-protocol-promise-executor-v8.test.js) and
[join boundaries](../test/semantic-protocol-promise-join-v8.test.js).
