# Stateful adversarial trace corpus: independently checked baseline

**Snapshot date: 2026-10-23.** Source: [GitHub Actions run 39938544682](https://github.com/werg/tracing-js-self/actions/runs/39938544682), commit [`ff17b8dae116`](https://github.com/werg/tracing-js-self/commit/ff17b8dae116686c6e0ef6839e4dacab0b20a9e2).

## Corpus size and effects

| Metric | Pinned result |
| --- | ---: |
| Real, pinned, MIT-licensed libraries | **7** |
| Stateful adversarial scenario families | **67** |
| Multi-library application scenarios | **6** |
| Independent observed/uninstrumented V8 agreements | **804/804** |
| Terminal successful returns | **720** |
| Terminal throws or rejected promises | **84** |
| Observable property-state changes | **64,414** |
| Captured execution events | **171,737** |
| Median / p90 event count | **173 / 450** |
| Median / p90 serialized event bytes | **24,150 / 58,713** |
| Total serialized event bytes | **24,925,739** |
| Train / validation / test examples | **312 / 204 / 288** |

The existing utility suite contributes **936 further native observations** (78 pinned Lodash and VS Code functions). Thus the two deterministic suites together exercise **1,740 invocations**. The stateful cases are *not* just more input vectors to pure functions: they execute real mutable event emitters, state stores, an LRU cache, linked-list queue, promise limiter, middleware library, and mixed request handling with logged effects.

## Adversarial scenarios and observed computation

- **Listener mutation and reentry:** deregistration/registration while handlers fire, wildcard delivery, once handlers, duplicated listeners, nested emits, special property names, callback errors.
- **Stateful notifications:** nested store updates, identity/no-op handling, listener mutation, state replacement, mutable aliasing, asynchronous updates.
- **Caches and queues:** LRU generational rollover and expiration, resize/eviction callbacks, mutable queue traversal, partial iterator consumption.
- **Request-like execution:** Koa middleware onion ordering, response/context mutations, early returns, double-`next()`, missing `await`, errors and subsequent effects.
- **Async concurrency:** p-limit queued tasks, rejection, queue clearing, concurrency increases, nested scheduling, task-mapping order.
- **Application compositions:** event sourcing into Zustand, cache-backed Koa request processing, event-driven queue draining, concurrent store updates, and eviction notifications propagated through event emitters.
- **Abrupt completion:** seven additional scenario families intentionally produce uncaught guest errors or a rejected root promise; **84 executed terminal failures** match independent reference name/message and observable pre-failure console effects.

## Trace-quality observations

These traces carry far more processing than the older utility corpus (median **173** vs **22** events, and ~**24.2 KB** vs **2.5 KB** event JSON). This is not evidence they are good training targets: callbacks, queue microtasks, repeated reads and helper functions expand the trace considerably. The largest scenario, `application/cache-backed-request`, averages **714 events and ~89 KB** per invocation. Before any compaction, verify that (1) control and data dependencies remain explicit, (2) aliases, mutations and emitted effects remain visible, (3) calls are presented in their actual dynamic context, and (4) error paths include pre-throw effects.

The original `delete object[key]` observer wrongly wrapped the deletion target as an ordinary value read, silently suppressing real property deletion. The EventEmitter3 remove-all/readd case detected this: initially four mismatch cases, all resolved by preserving the reference and recording the deletion as a write. This is concrete evidence that stateful adversarial tests uncover instrumentation defects that pure-function output comparisons can miss.

In the native observer, `call` records describe **completion of a call expression**, not its initiation. They may follow a callee's `return`. A model-facing effective trace should instead make the invocation, input consumption, return and side effects easy to follow without reconstructing the interpreter's internals.

## Provenance and reproducibility

All seven vendor sources are committed under [`../../upstream/`](../../upstream/) together with their original MIT notices. Their exact revisions and SHA256 hashes are now **fail-closed inputs** to `corpus:stateful`, checked before generating any observation. Sources are transpiled into an explicitly limited guest-only module loader. Environment values and the clock are pinned; there is no native `require`, real network, filesystem or worker fallback. This is a benchmark with scenario-authored fixture adapters, *not* a trace of an entire upstream application.

Run:

```sh
npm ci
npm run corpus:stateful -- --per-scenario 12 --min-verified 804 \
  --output corpus/out/stateful-traces.jsonl \
  --report corpus/out/stateful-report.json \
  --review corpus/out/stateful-review.md
```

The full 39 MB JSONL observation corpus and 220 KB readable event review are preserved as a reproducible [CI artifact](https://github.com/werg/tracing-js-self/actions/runs/39938544682) rather than duplicating them in git. The stored [`summary.json`](summary.json) makes all headline metrics available without the artifact.

**Evidence boundary:** Matching V8 execution of an instrumented source and an independent uninstrumented source establishes observable-result agreement, **not** semantic coverage of every hidden host/runtime effect. These are diagnostic observations. They must not be silently passed to the owned-interpreter `semantic-execution/2` serving controller or called admitted megatoken training episodes.

## Remaining benchmark coverage

Expand whole-application source/module graphs, production dependencies and integrations with controlled filesystem/network/tool service boundaries, real timers and workers, cancellation, streaming and nondeterministic external delivery. Add honest unsupported outcomes where deterministic self-contained fixtures cannot represent the service. Expand project-level holdouts and independently verify intermediate effects before treating these as model targets.
