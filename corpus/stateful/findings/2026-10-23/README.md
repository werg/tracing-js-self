# Stateful adversarial trace corpus: independently checked baseline

**Snapshot date: 2026-10-23.** Source: [GitHub Actions run 39940081334](https://github.com/werg/tracing-js-self/actions/runs/39940081334), commit [`cacabd374d5a`](https://github.com/werg/tracing-js-self/commit/cacabd374d5a73646cffacd28b45033f775fdc67).

## Corpus size and effects

| Metric | Pinned result |
| --- | ---: |
| Real, pinned, MIT-licensed libraries | **8** (10 pinned source modules) |
| Stateful adversarial scenario families | **76** |
| Multi-library application scenarios | **6** |
| Independent observed/uninstrumented V8 agreements | **912/912** |
| Terminal successful returns | **828** |
| Terminal throws or rejected promises | **84** |
| Observable property-state changes | **130,294** |
| Captured execution events | **236,741** |
| Median / p90 event count | **181 / 593** |
| Median / p90 serialized event bytes | **26,106 / 130,237** |
| Total serialized event bytes | **39,941,782** |
| Train / validation / test examples | **420 / 204 / 288** |

The existing utility suite contributes **936 further native observations** (78 pinned Lodash and VS Code functions). Thus the two deterministic suites together exercise **1,848 invocations**. The stateful cases are *not* just more input vectors to pure functions: they execute real mutable event emitters, state stores, an LRU cache, linked-list queue, promise limiter, middleware library, the real Axios interceptor manager, and mixed request handling with logged effects.

## Adversarial scenarios and observed computation

- **Listener mutation and reentry:** deregistration/registration while handlers fire, wildcard delivery, once handlers, duplicated listeners, nested emits, special property names, callback errors.
- **Stateful notifications:** nested store updates, identity/no-op handling, listener mutation, state replacement, mutable aliasing, asynchronous updates.
- **Caches and queues:** LRU generational rollover and expiration, resize/eviction callbacks, mutable queue traversal, partial iterator consumption.
- **Request-like execution:** Koa middleware onion ordering, response/context mutations, early returns, double-`next()`, missing `await`, errors and subsequent effects.
- **Async concurrency:** p-limit queued tasks, rejection, queue clearing, concurrency increases, nested scheduling, task-mapping order.
- **Application compositions:** event sourcing into Zustand, cache-backed Koa request processing, event-driven queue draining, concurrent store updates, and eviction notifications propagated through event emitters.
- **Abrupt completion:** seven additional scenario families intentionally produce uncaught guest errors or a rejected root promise; **84 executed terminal failures** match independent reference name/message and observable pre-failure console effects.

## Trace-quality observations

Nine additional authentic Axios interceptor scenarios stress stable handler identities, ejection and re-registration during iteration, async interceptor transformations, null-handler recovery, and `try/finally` cleanup. Their real dependency module and its util/bind helpers are all pinned. One focused Axios smoke run independently matched **9/9 outcomes** before the 912-case full run.

These traces carry far more processing than the older utility corpus (median **181** vs **22** events, and ~**26.1 KB** vs **2.5 KB** event JSON). This is not evidence they are good training targets: callbacks, queue microtasks, repeated reads and helper functions expand the trace considerably. Axios interceptor scenarios are currently the largest: `axios/nested-enumeration` averages **881 events and ~169 KB** per invocation, and `axios/eject-during-iteration` averages **609 events and ~141 KB**. Some of this is **module-initialization and helper setup**, not computation that directly contributes to the scenario response. `application/cache-backed-request` averages about **709 events and ~87 KB**. This is a strong reason to separate source/program setup from the model's dynamic reasoning trace. Before any compaction, verify that (1) control and data dependencies remain explicit, (2) aliases, mutations and emitted effects remain visible, (3) calls are presented in their actual dynamic context, and (4) error paths include pre-throw effects.

The original `delete object[key]` observer wrongly wrapped the deletion target as an ordinary value read, silently suppressing real property deletion. The EventEmitter3 remove-all/readd case detected this: initially four mismatch cases, all resolved by preserving the reference and recording the deletion as a write. This is concrete evidence that stateful adversarial tests uncover instrumentation defects that pure-function output comparisons can miss.

In the native observer, `call` records describe **completion of a call expression**, not its initiation. They may follow a callee's `return`. A model-facing effective trace should instead make the invocation, input consumption, return and side effects easy to follow without reconstructing the interpreter's internals.

## Provenance and reproducibility

All eight vendor libraries (ten source modules) are committed under [`../../upstream/`](../../upstream/) together with their original MIT notices. Their exact revisions and SHA256 hashes are now **fail-closed inputs** to `corpus:stateful`, checked before generating any observation. Sources are transpiled into an explicitly limited guest-only module loader. Environment values and the clock are pinned; there is no native `require`, real network, filesystem or worker fallback. This is a benchmark with scenario-authored fixture adapters, *not* a trace of an entire upstream application.

Run:

```sh
npm ci
npm run corpus:stateful -- --per-scenario 12 --min-verified 912 \
  --output corpus/out/stateful-traces.jsonl \
  --report corpus/out/stateful-report.json \
  --review corpus/out/stateful-review.md
```

The full approximately 61 MB JSONL observation corpus and 255 KB readable event review are preserved as a reproducible [CI artifact](https://github.com/werg/tracing-js-self/actions/runs/39940081334) rather than duplicating them in git. The stored [`summary.json`](summary.json) makes all headline metrics available without the artifact.

A previous 67-family/804-run snapshot has been superseded by these 76-family/912-run figures; the machine-readable [`summary.json`](summary.json) and the full CI report reflect the final expanded corpus. The six mixed application scenarios depend on some modules that also appear in training/validation families, so the package-oriented split does not prove independent-project generalization. No real filesystem, network or native worker side effects were executed.

**Evidence boundary:** Matching V8 execution of an instrumented source and an independent uninstrumented source establishes observable-result agreement, **not** semantic coverage of every hidden host/runtime effect. These are diagnostic observations. They must not be silently passed to the owned-interpreter `semantic-execution/2` serving controller or called admitted megatoken training episodes.

## Remaining benchmark coverage

Expand whole-application source/module graphs, production dependencies and integrations with controlled filesystem/network/tool service boundaries, real timers and workers, cancellation, streaming and nondeterministic external delivery. Add honest unsupported outcomes where deterministic self-contained fixtures cannot represent the service. Expand project-level holdouts and independently verify intermediate effects before treating these as model targets.
