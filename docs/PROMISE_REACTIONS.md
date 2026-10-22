# Owned Promise reaction jobs (bounded profile)

The owned runtime registers `Promise.prototype.then`, `catch` and `finally`
against serialized guest Promise identities. Both `await` and reaction handlers
share one ordered observer list and one explicit job queue. Registering on an
already settled Promise enqueues a job instead of invoking a callback
synchronously. Guest callback frames and result-Promise adoption are logged;
replay never executes host adapters.

A missing/non-callable handler propagates the original fulfillment or rejection.
`finally` gets no arguments, and adopts any Promise it returns. A thrown or
rejected cleanup overrides the original result; successful cleanup preserves
it. A handler returning its own result Promise rejects with a guest `TypeError`.

## Scope and remaining limitations

This is **not** a complete Promise implementation. It does not provide the
Promise constructor/executor, arbitrary thenable assimilation, species and
subclassing, combinators (`all`, `race`, `any`, `allSettled`), native
rejection hooks, native scheduling or complete job/agent semantics. The bounded
source parser only accepts named guest functions as callback sources. Proxy
interference and inherited accessor/prototype methods remain unsupported.

`test/promise-reactions.test.js` exercises ordering, pass-through,
rejection, synchronous and async callbacks, host-delivery postponement,
structural reconstruction and exact replay. Independent engine differential
scheduling probes and official Test262 Promise tests remain open.
