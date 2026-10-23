# Stateful and adversarial real-source benchmark

This corpus extends the pinned Lodash/VS Code functions with **76 stateful
scenario families** using **eight real production libraries**. Each vendor
file under `upstream/` is copied from a specified Git revision without
editing its source. Corresponding MIT license notices are retained.

| Production library | Behavioral categories |
| --- | --- |
| [mitt](https://github.com/developit/mitt) | Event listeners, wildcard dispatch, callback removal/insertion during emit, recursive delivery, special keys, callback throws |
| [Zustand vanilla](https://github.com/pmndrs/zustand) | Mutable state, subscriber reentry, shallow merge vs replace, changes during notification, identity/no-op updates, async tasks |
| [eventemitter3](https://github.com/primus/eventemitter3) | Once, receiver contexts, listener deletion, recursive emission, exceptions, prototype-hazard event names |
| [yocto-queue](https://github.com/sindresorhus/yocto-queue) | Enqueue/dequeue, clear/reuse, mutation while iterating, partial drain, object reference aliases |
| [quick-lru](https://github.com/sindresorhus/quick-lru) | Eviction callbacks, expiry, promotion, resize, expiration, clear, iteration |
| [koa-compose](https://github.com/koajs/compose) | Request-response middleware, onion ordering, early exits, double-next, missing-await, error unwinding |
| [p-limit](https://github.com/sindresorhus/p-limit) | Queued async work, concurrent updates, rejection, cancellation, concurrency resize and nested work |\n| [Axios interceptors](https://github.com/axios/axios) | Stable handler identity, ejection/clear during traversal, async transforms and error cleanup |

The [Axios](https://github.com/axios/axios) interceptor manager now adds nine\nscenarios covering stable ejection IDs, handler-list mutation during iteration,\nasync request-chain transforms, null-list recovery and exception cleanup.\nThe original Axios implementation and its utility/binding dependencies are\nall vendored with the complete MIT license and pinned hashes.\n\nSix **application** scenarios combine those real implementations into
request handlers, cache-backed routes, notification-driven mutable state,
event queues, concurrent transactions and eviction notifications. Scenarios
are synthetic *drivers* for real library code, **not** additional claims
about unchanged upstream applications. Some cases model in-memory external
effects through explicit return logs. They do not perform real filesystem or
network I/O.

## Run

```sh
npm ci
npm run corpus:stateful -- --per-scenario 12 \
  --output corpus/out/stateful-traces.jsonl \
  --report corpus/out/stateful-report.json \
  --review corpus/out/stateful-review.md
```

This requests **912 executions** across 76 scenario families (12 varied
seeds each); use `--per-scenario 2 --limit 10` for a smoke run. The report
includes every failure, the source family and split, program/module revision
hashes, mutation counts, outcomes, and readability examples. The
`--min-verified` flag fails CI if fewer than the required independently
checked runs finish.

The closed guest module loader resolves **only explicitly supplied vendored
modules**; it cannot call Node `require`, install dependencies, or access
the actual network/filesystem. TypeScript and ESM are lowered by the pinned
TypeScript compiler into guest CommonJS factories; the original upstream
source bytes remain unmodified and SHA256 hashes are included in every
manifest. `Date.now` and `Math.random` use declared deterministic fixture
values, and Koa uses a mocked nonproduction NODE_ENV. Async microtasks use
guest Promises; fixture queues and host service stubs do not claim
real-world scheduling fidelity.

The source-family split is package-oriented: `train` (mitt, Zustand,
yocto-queue), `validation` (eventemitter3, p-limit), and `test`
(quick-lru, koa-compose, mixed application flows). Cross-package test
scenarios deliberately depend on some train modules; the manifest exposes
those dependencies. Future cross-project evaluation should ensure complete
project-level independence when required.

## Evidence boundary

**These are native V8 diagnostic observations, not owned-interpreter traces.**
The instrumented execution is compared to a second *uninstrumented* V8
execution on return/throw and the reachable argument/result graph, including
explicit side-effect logs. This independently checks final effects, not each
intermediate operation. Production libraries are executed by V8, **not** the
owned trace controller. The resulting records are not yet qualified for
`semantic-execution/2` or the megatoken training stream.

The diagnostic trace may still miss private internal operations, prototype
walks, native library side effects, promise timing and other computation
facts. `call` records denote call-expression *completion* and can appear
after callee returns, so inspect events and source together. All mismatches
and observer exceptions must remain visible. Do not suppress mutation or
control events merely to reduce size.

Security: only trusted pinned sources can be executed; Node `vm` is not an
isolation boundary for malicious third-party programs. The corpus is not a
general-purpose arbitrary-code execution service.

## Abrupt-completion adversarial cases

Seven additional cases finish in a **guest throw or rejected root promise**
after a real library callback, middleware or queue operation. These record
explicit console effects before failure, checked in the separate reference
run. An exception is an expected benchmark path, not a successful return;
the observed failure kind and message must still match the reference.
