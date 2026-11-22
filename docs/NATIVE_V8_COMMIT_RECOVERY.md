# Exact native commit recovery

## Producer request foundation

`DurableNativeV8RequestJournal`, exported by `tracing-js-self/storage/node`,
records the original semantic or coordinator commit JSONL bytes together with
the entire immediately preceding native transport checkpoint. Each request
names its session, stream, positive generation, immutable ordinal, operation,
checkpoint, tokenizer and optional training identity.

Publication synchronizes a private temporary file, atomically links it to an
ordinal slot without replacement, synchronizes the containing directory, and
independently rereads the exact bytes. Only the original publisher receives a
new dispatch acknowledgement. An existing ordinal never authorizes another
dispatch. The next request must extend the complete ordinal sequence. Reading
an older request with `latest: true` refuses when any later intent exists,
whether or not that later request has a known native outcome.

`inspect(ordinal)` independently validates and synchronizes a retained intent
and returns its bytes and receipt after a caller loses its original return
value. It does not report a native outcome, grant a retry or authorize host work.
`list()` describes stored ordinals only. Generation is an external supervisor
authority; choosing an old generation does not discover or invalidate later
work in another generation.

Every input is snapshotted before the first storage await. Stored data must
retain the exact pending model selection and full precommit identity. Changed
models, altered request or checkpoint bytes, duplicate JSON fields, malformed
UTF-8, gaps, unsafe paths, nonprivate files and exceeded bounds refuse.

The kernel execution lease now has a private runtime brand. A plain object
that implements similarly named methods cannot impersonate an acquired lease.
The original lease must remain live and bind the same session and stream.
This is still trusted local Linux filesystem/process exclusion, not a remote
lease service or distributed ownership protocol.

## Validation of the first increment

Eight producer-journal controls and all six existing cross-process kernel-lock
controls pass locally, with zero skips. They cover reopen and readback, caller
mutation during storage, duplicate/concurrent ordinal publication, stale
recovery, altered bytes and receipts, malformed request frames, filesystem
refusals, authentic leases, crashed holders and outliving inherited children.

The first local run caught a real caller-mutation error: validation used a
snapshot, while a later ordinal check still read the caller-owned identity.
Every later ordinal use now comes from that snapshot. The sandbox also lacked
`/tmp` and maps system executable owners to `nobody`; local tests use a writable
temporary directory and an owner-private copy of the same `flock` executable.
The test-only `TRACING_TEST_FLOCK` setting selects that executable. Production
ownership requirements are unchanged, and ordinary CI uses `/usr/bin/flock`.

## Remaining integration boundary

The request journal is only the producer prerequisite. A positive reply must
also be durably owned on the native side, bind its exact postcommit checkpoint,
and independently reexecute to that entire checkpoint, including sibling
sessions, budgets, original model fragments and randomness. An unresolved
native outcome must remain unknown. Saved selection replies cannot restore
abandoned speculative model state. Automatic composite host/history recovery
still needs its own exact continuation and external-service reconciliation.
