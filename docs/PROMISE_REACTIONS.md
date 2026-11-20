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

The bounded owned runtime supports Promise construction/executors, `resolve`,
`reject`, `then`, `catch`, `finally`, `all`, `race`, `any`, `allSettled`,
`withResolvers`, and owned thenable assimilation. These claims describe the
bounded script/runtime profile at baseline `c165dad8e8226167ec1649cbe6d654cf8662aaf8`;
strict `training-js/1` exposure and independently checked training admission are
separate gates. The constructor/executor and thenable tests are
`test/owned-promise-executors.test.js`,
`test/owned-promise-thenables-combinators.test.js`,
`test/owned-thenable-assimilation.test.js`, and
`test/owned-promise-with-resolvers.test.js`.

This is a bounded implementation. Species, subclassing, arbitrary iterable
inputs, native rejection hooks, and full host job/agent semantics are not
qualified by these tests. The current capability ledger records strict frontend
acceptance and source/native admission independently of runtime support.

`test/promise-reactions.test.js` exercises ordering, pass-through,
rejection, synchronous and async callbacks, host-delivery postponement,
structural reconstruction and exact replay. Independent engine differential
scheduling probes and official Test262 Promise tests remain open.

## Bounded owned queueMicrotask scheduling

The owned machine accepts queueMicrotask(callback) for a guest-owned callable
function. It enqueues a serialized microtask job in the **same FIFO job queue**
as Promise reaction and await-resumption jobs, so scheduling and callback
invocation are replayable as ordinary owned state transitions. Callbacks run
after the current stack unwinds and can enqueue further guest microtasks.
A noncallable callback fails with an owned TypeError, and at most 256 queued
microtasks are permitted at once. An uncaught synchronous guest callback throw
is a terminal guest failure; asynchronous callback failures are guest Promise
rejections, not automatically modeled host unhandled-rejection notifications.

The independent structural validator checks that each microtask entry consumes
the next scheduled function identity, preserves the queue suffix and records
its owned invocation. test/owned-microtask-scheduling.test.js covers Promise
reaction interleaving, nested callbacks, invalid callback types and forged
queues with exact replay.

**Scope:** This is a single-agent guest microtask subset only. No wall-clock
timers, Node nextTick priority, browser render checkpoints, rejection events,
cross-realm host callbacks, task queues, SharedArrayBuffer or worker agents are
modeled by this addition.

## Owned bounded Promise array combinators and virtual task turns (2026-10-24)

`Promise.all` and `Promise.race` now accept dense owned arrays of up to 64
entries. Values and owned Promises subscribe to explicit queued settlement jobs;
`all` preserves input order, waits for all fulfillment, and rejects on first
rejection; `race` settles on the first processed reaction. Empty `all`
fulfills with an owned array while empty `race` remains pending. There is
no arbitrary iterator protocol or species/subclassing support in this array
profile. Subsequent owned-runtime slices added executors, thenable assimilation,
`any`, `allSettled`, and `withResolvers` as described above.

`setTimeout`, `clearTimeout`, `setInterval`, and `clearInterval` accept
owned callbacks and explicit bounded virtual millisecond delays. They use an
ordered, serialized **virtual** task queue: all currently queued microtasks
drain before the next timer turn and after every timer callback. Timers do
not sample real wall time or access host resources. Each task turn and
its guest invocation are journaled, independently checked for clock/order
invariants, and exactly replayed. Limits: 128 task turns, 128 pending timers,
1024 lifetime timer IDs, at most 10,000 ms requested delay. Intervals are
clamped to one virtual millisecond. Hitting the turn limit refuses execution
rather than claiming completion.

This is **not** an implementation of Node/browser event loops, nested timer
throttling, host I/O, workers, actual concurrent agents, complete ECMAScript
Promises, or official Test262 host semantics.
