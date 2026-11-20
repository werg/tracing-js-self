# Shared Promise executor protocol

`promise-executor/1` uses the existing public Promise heap and invocation stack
to represent bounded synchronous `new Promise(executor)` calls. Resolving
functions retain explicit identities, their common first-call cell, and the
Promise they control. Their identities can escape through ordinary cells and
closures, and remain callable after the executor has returned.

| Record | Public fields after `kind` | Meaning |
| --- | --- | --- |
| `promise.executor.enter` | `promise, executor, child, resolve, reject` | Allocate a distinct resolving pair for a fresh pending Promise and enter the selected source closure with both identities. |
| `promise.resolver.call` | `resolver, value` | Perform the first resolution or rejection; later calls preserve the already committed state. |
| `promise.executor.finish` | `promise, invocation, completion` | Restore caller scope and return the constructed Promise. An executor throw rejects the Promise only when the resolving pair has not already been used. |

The first Promise identity comes from the ordinary checked `promise create`
record. The two resolving functions are closure nodes with immutable
`promiseResolver: {promise, mode}` metadata. Their public code names are
`Promise.executor.resolve:<promise>` and `Promise.executor.reject:<promise>`.
They can only be invoked through `promise.resolver.call`; ordinary call and
property operations cannot substitute for their protocol. The constructor
record itself calls the executor through the shared receiver and capture
scope and contributes the same continuation state as an ordinary public call.

## Shared state and restoration

The public protocol state gains `promiseExecutors`, initially `null`. Once
active it has the `semantic-promise-executor-state/1` schema and two arrays:

- `capabilities`: `promise, resolve, reject, called, resolution`. `resolution`
  is `null` before the first call, then `{mode, value}`. Once set, this lock
  makes all subsequent resolving calls no-ops, including calls with an owned
  Promise or thenable as their unused argument.
- `executors`: `promise, parent, child, phase, completion`. The running child
  must remain in the live shared call stack. Completed entries retain their
  return or throw so restoration can check settled state and historical frame
  identities without invoking the executor again.

Each array is bounded to 4,096 entries; active calls use the common 64-frame
limit. Restoration verifies unique Promise and resolving identities, exact
resolver metadata, live continuation links, first-call state, and consistent
Promise settlement. Failed claims are staged and leave the original machine
unchanged. A detailed Promise settlement cannot bypass a retained capability.

## Source qualification

The effectful teacher publishes each constructor, resolver call and completion
at its actual owned event. This includes ignored second calls and a throw after
resolution. It checks the public first-call cell, result and continuation against
that event's committed state, without using future settlement to choose an
earlier record.

Independent source instrumentation runs the native Promise constructor and its
actual resolving functions. It records executor identity, the two distinct
resolvers, direct resolving-call order and operands, executor completion, and
the resulting Promise identity. These records are compared with separately
reconstructed owned observations in addition to ordinary branch, operation,
completion, metadata and final-result checks. A changed ignored resolver call
is detectable even when the final result is unchanged.

The source tests cover synchronous execution order, scalar resolution and
rejection, pre-resolution throws, throws after resolution, retained resolving
functions, closure cells, ignored later calls with owned Promise arguments,
composition with `Promise.all`, and compact arithmetic around executor work.
JSON checkpoint tests resume before resolution and reject altered capability,
resolver and continuation state.

The currently declared source profile uses direct `new Promise` constructors,
synchronous source executors and direct identifier calls of resolving functions.
Async executor bodies, executor calls inside active Promise reaction callbacks,
thenable/object resolution, owned Promise adoption, Promise self resolution, modified resolver
properties, and external effects are explicit refusals. They do not become
successful guest behavior or implicit host execution. Independent native
consumer qualification remains an additional gate after the matching consumer
and regenerated interoperability artifacts are pinned.

Resolving with another Promise requires native assimilation jobs even when
that Promise is already settled. The existing controller's direct adoption
transition omits those jobs, so this profile rejects adoption before consuming
the first-call cell. A regression with competing reaction chains distinguishes
the native FIFO order from direct synchronous adoption. Supporting adoption
requires the same explicit jobs in the owned runtime and both public consumers.
