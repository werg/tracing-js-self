# Owned async iteration and source correspondence

`for await...of` now uses the owned compiler, ordinary callable frames, Promise
jobs, and retained cleanup handlers. It does not execute generated source text
in the host. Parser acceptance follows the installed Acorn parser's current
grammar; recorded parser provenance includes its actual package version.

## Iterator selection and completion

The loop evaluates its iterable once, selects `Symbol.asyncIterator` before
falling back to `Symbol.iterator`, retains the selected iterator receiver, and
reads `next` once. A genuine async iterator's next result is awaited and checked
as an object. Its `value` is passed to the loop without another Promise unwrap.
An exhausted async result does not read `value`.

Sync fallback uses two language-created async helper frames for the
AsyncFromSyncIterator `next` and `return` operations. These frames retain the
original sync iterator and cached next method, read `done` before `value`, and
await `value` even when `done` is true. The wrapper reaction and the outer loop's
await remain separate jobs. A rejected yielded value closes the sync iterator
when it is not already done; a rejected completion value does not close it.

Break, return, throw, and failures while binding the loop variable enter the
same cleanup machinery used by ordinary `try`/`finally`. Cleanup looks up
`return` at that point, preserves its receiver, and awaits the required result.
A pending throw retains precedence over a throwing getter, throwing return
method, rejected cleanup, or invalid cleanup result. Cleanup failure replaces a
normal exit. Continue within the same loop does not close it. Labelled exits,
per-iteration lexical bindings, destructuring, live array reads, holes, and
Unicode string iteration continue through the existing owned paths.

These rules follow the current specification's
[AsyncFromSyncIterator methods and continuation](https://tc39.es/ecma262/multipage/control-abstraction-objects.html#sec-asyncfromsynciteratorcontinuation),
[AsyncIteratorClose](https://tc39.es/ecma262/multipage/abstract-operations.html#sec-asynciteratorclose),
and [ForIn/OfBodyEvaluation](https://tc39.es/ecma262/multipage/ecmascript-language-statements-and-declarations.html#sec-runtime-semantics-forinofbodyevaluation-lhs-stmt-iterator-lhskind-labelset).

## Public source checking and recovery

The source bridge reuses existing async-call, builtin-iterator, property, call,
and cleanup records. It records ordinary object definitions and Symbol keys,
receiver-aware reads, accessor calls, cached methods, iterator steps, and
cleanup. The bridge compares the resulting public object descriptions with the
current owned state after every affected heap transition.

The sync helpers have the source identities
`async-from-sync-next:<start>:<end>` and
`async-from-sync-return:<start>:<end>`. Both offsets must identify the exact
original awaited `ForOfStatement`; a synchronous loop or an invented span does
not grant that callable identity. Exact archive replay checks the deterministic
helper instructions before projection. The source sidecar is rebuilt during
source rechecking, so changing a public helper role or its claims cannot acquire
source correspondence by changing a digest. Helper captures expose their
checked iterator, cached callable, and receiver cells rather than unrelated
environments or private bytecode.

Suspension retains cleanup obligations in the continuation's `pending` field.
An async continuation owns only its invocation's handler and loop-target scopes.
While an async body is running, `resumeScope` saves its caller or idle receiver,
capture aliases, and pending completion. Detachment restores that saved state.
This also preserves a completed root result while detached async children
finish. JSON recovery checks exact public history and retained state before
resuming, and rejects changed handler owners, missing scopes, and altered
completion values.

For an explicitly requested returned-Promise completion policy, the independent
reference worker observes after a host turn boundary. This lets all finite
queued microtasks finish, including detached work after a scalar root return.
It does not guess a fixed number of Promise turns; the existing subprocess
deadline still bounds unending work.

## Evidence and remaining boundaries

`test/training-async-iteration.test.js` compares original source with owned
execution, checks Promise-job ordering and completion precedence, and restores
owned snapshots around next and close suspension. It also checks exact replay
and forged continuation rejection.

`test/semantic-async-iteration-source-v8.test.js` independently checks authored
source, public projection, and public replay. The current fixture population
includes arrays containing Promises, lookup getters and receiver identity,
unwrapped async values, throw precedence, cleanup replacing return, sync-value
rejection, sibling cleanup, and detached work preserving the root completion.
The native portion of this test runs when `MEGATOKEN_ROOT` selects an actual
consumer checkout. These are source and interoperability checks, not evidence
of training admission or model performance.

`test/semantic-async-iteration-bindings-v8.test.js` covers array binding headers
with holes, default initializers, and rest elements. A loop header has no
declarator initializer, so its exact pattern must still be included in the
source inventory. The composed source path retains the same pattern and
cleanup declarations as the direct adapters. Rest appends keep their own
checked array operation rather than being treated as an ordinary keyed write.
The tests also exercise a default that throws while both iterators need closing,
and a default that awaits while the inner and outer cleanup scopes are retained.
They compare original source, recheck public evidence, and restore the latter
suspension before finishing the trace; the native replay check is enabled by
the same `MEGATOKEN_ROOT` setting.

Source publication also distinguishes a current event's fresh allocations from
the already committed owned heap. A generator function and its prototype can
refer to one another within their allocation event. The shared bridge accepts
those authenticated current-event identities while continuing to reject
references absent from both the committed heap and that event.

One current reference discrepancy remains explicit. Node v24.22.3 with V8
13.6.233.17-node.63 calls a sync iterator's `return` when its `next` throws,
returns a non-object, or its result's `done` or `value` getter throws. The current
specification rejects those operations before the continuation's
close-on-rejection path. The owned engine follows that specification. Tests
record the actual engine version and observation, and source admission rejects
disagreement. They also permit a reference engine that agrees with the current
specification; the historical Node observation is not a required future result.

The compiler supports callable thenables through its existing owned Promise
machinery. Public source projection of those thenables still requires its own
qualified resolving-function protocol and remains a refusal. Async generators,
Symbol-valued cleanup completions, malformed intrinsic-error projection, and
additional nested or assignment-target source combinations also require
further source/public qualification. Runtime success alone does not remove any
of those boundaries.
