# Ordinary native V8 orchestration transport

`createNativeV8ProcessSelector` and `createNativeV8PythonSelector` expose the
bounded native coordinator over the same JSONL process as ordinary V8 child
selection. Initialize the exact checkpoint, tokenizer, training lineage and seed
before opening a coordinator. The production transport accepts model-selected
coordinator actions; it never supplies a controlled lifecycle record or repairs
an invalid model output.

## Operations and authority

| Method | Input and acknowledgement |
| --- | --- |
| `openOrchestration` | `{session, public, maxActive, childBudget}`. The public cut contains only exact observed V8 programs and declared root calls. The native coordinator returns immutable typed child bindings and its track. |
| `selectOrchestration` | `{session, track}`. Returns the original lifecycle action bytes and native selection evidence bound to the model and exact coordinator context. |
| `commitOrchestration` | `{session, track, record, selection}`. Acknowledges the same candidate. A create receipt binds the exact child execution, parent, reserved track and completion dependency; historical retries retain the same receipt. |
| `bootstrapOrchestrationChild` | `{session, track, childTrack}`. Host acknowledgement publishes the reserved child's exact source/input. Reservation alone does not make the child runnable. |
| `statusOrchestration` | `{session, track}`. Returns the checked coordinator and child state, dependencies and delivered receipts. |
| `cancelOrchestration` | `{session, track, reason}`. Requires the exact terminal cancellation receipt and discards a pending candidate while preserving its attempt evidence. |

Coordinator actions remain original model-selected `track_create`, `track_join`,
`track_progress`, `track_complete`, or `track_cancel` records. Native validation
owns the transition. With one active slot, the coordinator must join the issued
child dependency before the bootstrapped child can execute. Ordinary semantic
`select`, `commit` and `complete` operate on that actual reserved child track.

The transport independently derives child bindings from the observed program and
invocation rows. It checks exact source and input digests, realm/completion policy,
capability grants, and owning coordinator. Selected bytes must equal the original
fragment payloads; fragment token IDs, selected event IDs, native track, numeric
meridian, termination, model identities and context digest remain intact.

## Completion and recovery

An ordinary `complete` response for a coordinator child must include a typed
`semantic-child-completion/8` receipt. The transport binds it to the same child
track, public cut and context digest. If a caller supplies a completion value, it
must equal the independently replayed native result. Exact historical completion
retries after session closure return the retained receipt without reopening or
delivering work again.

`select.checkpoint()` retains the existing transport/native checkpoint envelope.
The native session inside it retains an ordered orchestration journal, including
original acknowledged coordinator and child selections, bootstrap, completion,
cancellation and random-state boundaries. `select.restore()` uses native staged
reexecution before restoring local coordinator bindings. Failed reconstruction
cannot become an active session. Unacknowledged candidates remain excluded from
the restored continuation while their consumed attempts are retained.

The semantic-only `RegionSelectedModelDriver` checkpoint/history format is not a
composite coordinator checkpoint. Coordinator and semantic attempts share a native
ledger, so a future composite host/driver recovery path must validate both; callers
must not claim that ordinary semantic-only history covers an active coordinator.
The coordinator remains a bounded declared-root profile. Dynamic descendants,
callback ownership, authoritative training transcripts, complete deployment
recovery, and learned-quality gates are separate remaining work.

## Verification

`test/semantic-native-orchestration-transport-v8.test.js` uses a real JSONL
subprocess with a deterministic protocol peer for exact acknowledgements,
cancellation, original bytes, malformed receipts and closed-session restoration.
It also compares Python's actual coordinator context, execution binding and hash
with JavaScript, using the paired checkout. These are protocol controls, not
evidence that a model learned the lifecycle actions. Explicit paired environments
must provide the consumer; their contract check cannot silently skip.

The independent native shared-runtime controls remain in the consumer suite.
Current-pair CI runs both suites and retains their exact source/native pins.
