# Semantic execution v4: implementation and operation

This is the implementation guide for the [M0–M8 roadmap](LLM_SEMANTIC_EXECUTION_HARNESS_ROADMAP.md).
Engineering verification uses source-certified teachers, independent Node/browser references,
controlled selected actions and initialized fixed-weight inference. It does not run an optimizer
or establish learned execution quality. The exact compatible revisions and verification receipts
are recorded in the [integration lock](../contracts/semantic-integration-lock.json) and
[engineering completion ledger](SEMANTIC_HARNESS_V4_COMPLETION.md).

## Public contract and authority

The active production contracts are `semantic-execution/4`, `semantic-trace/4`,
`semantic-context/4`, `semantic-continuation/4` and profile `selected-harness/2`.
`contracts/semantic-harness-v4.json` is generated from the executable JavaScript declarations.
Megatoken ships the same bytes and independently validates the positive and negative examples.
`contracts/host-operations-v4.json` declares every operation's signature, codec, ownership,
callback lifetime, result codec, cancellation, retry and quota policy. Both files are checked in CI.

Source publication, module initialization and invocation are separate events. Invocations carry
their real track, realm, receiver, input graph, trigger, parent, task revision and completion policy.
The model generates semantic records. Source, invocation inputs, external arrivals/results,
subscription deliveries, address allocation and reconciliation are observed, with no generation loss.
The private archive, original fixture future, certificates and reference outcomes never enter a
model prefix. The renderer consumes committed records only and has chronological and per-owner views.

A selected `request` has evaluated arguments and a precise source span within the active function.
The controller checks it before the broker can dispatch. Actual Megatoken selections additionally
cross the native committed-action boundary using their original event, meridian and fragment IDs.
There is one selected request and one derived action, without a second generated argument list.
Partial, speculative, malformed, stale or rejected selections dispatch nothing. Rejection bytes
are retained separately from committed history.

The three completion policies are `call-return`, `await-returned-promise` and `owned-quiescence`.
An async JavaScript call returns its owned result Promise independently of eventual invocation
completion. Creating a Promise-returning request does not implicitly await it. Two requests may
be outstanding before either settles. Promise adoption, then/catch/finally, dual reactions,
queueMicrotask, await/resume and cleanup overriding an earlier completion have independent tests.

## Shared state, callbacks and recovery

Each retained realm owns one heap and cell map. Multiple tracks share those objects under one
legal guest turn; parameter cells remain activation-specific. Captures are live cells, not copied
values. Promise job readiness is ordered across the realm. Native callback trampolines enqueue
owned work, and callback bodies execute through selected semantic records.

Call-lifetime callbacks close after their queued invocations finish. Subscription callbacks can
outlive registration, receive repeated events, and explicitly close. Bounded queues record refusal
or discarded-event dispositions. A browser listener uses the declared passive notification profile;
synchronous cancellation/propagation callbacks are outside that profile. Natlang's registered nested
callback arguments return Promises and run through owned async reentry. A synchronous native
registration may retain such a thunk, but same-dispatch synchronous reentry is refused before work
is queued.

`SelectedIntentJournal` fsyncs an immutable action intent before adapter invocation. Keys bind the
session, invocation, effect, attempt and immutable payload digest. Local duplicate dispatch is
suppressed. A checkpoint reconstructs selected state from public history and checks it before
restoring. Pending effects become uncertain; a lost native subscription stays lost until explicitly
rebound. Source eviction prevents selection until a checked reread restores the same digest.

Recovery does not repeat a possibly completed write. Supply reconciliation evidence for a known
outcome or keep the action unresolved. Cancellation aborts the registered signal and closes owned
resources where the service supports it; it does not assert that a remote write was undone.
There is no global exactly-once guarantee without service support. Exact replay invokes no adapter.
Model restore establishes an explicit observed checkpoint bootstrap with verified source/state;
it does not claim bit-identical reconstruction of discarded hidden activations.

Bounded model history does not discard the authority for a live capture. The teacher and serving
driver publish the same observed state receipt when a retained callback starts, when a parent
regains its realm turn, and after thirty-two selected records in a long turn. Each receipt contains
only the committed controller state, the exact public sequence cutoff and a digest of its preceding
realm history. Public replay and checkpoint restore independently reconstruct and check those
values. The native consumer uses the same retention rule in prepared data and serving; these
receipts have zero prediction loss. A real native test mutates a capture, executes enough callback
work to evict the mutation from a 128-record model history, then resumes the parent with the correct
current value. Private arrivals and final teacher archives never supply that state.

## Capability profile

| Family | Implemented boundary | Evidence |
| --- | --- | --- |
| Fixture/platform | Async read, sync read/write, callbacks, subscriptions, clock, console | Source/reference/effect admission and selected-driver checks |
| HTTP | Scoped origins; request/status/headers; bounded text or pull chunks; response identity; abort/close; redirect validation | Actual loopback HTTP, redirected origins, cancellation, quotas and no refetch |
| Filesystem | Canonical scoped paths; text read/write/list; pull readers and bounded writers; durable close | Actual temporary filesystem, symlink/foreign-handle rejection, streaming/backpressure |
| Sockets | Explicit endpoint grants; bounded pull reads and writes; timeout, EOF/error and close | Actual local TCP, idle timeout, ownership and cleanup |
| DOM | Scoped selection handles; text/attribute mutation; release/remove; passive events and timers | Real Chromium, CSP without eval, event order, navigation and timer cleanup |
| Natlang | Registered call/cell operations; graph arguments/results; retained callback-return bridge | Actual generated module, import, inline/capture, file-resource and log tasks in Natlang |

The JSON API codec deliberately rejects aliases, cycles and non-JSON values. The separate
`owned-graph/1` codec preserves identity, cycles, holes, undefined, BigInt and special numbers.
Graph snapshots inspect data descriptors without invoking getters, proxies, serialization hooks
or guest coercions. Callback markers are decoder-branded; a lookalike data object is not callable.
Graph-valued results are accepted only by operations declaring that result codec. Native arrivals
remain private until delivery; the public identity allocator is identical in collection and serving.

Handles are scoped to session and realm, require declared grants and retain explicit ownership
until close. Package/service access is a registered typed resource, not an ambient generic proxy.
Unknown operations, forged receiver/callsite/handle identities and exceeded bounds fail closed.
The implementation remains a declared JavaScript/TypeScript profile, not general browser or Node
compatibility and not a hostile-code security sandbox.

## Source-certified data collection

`verifyEffectfulTrainingCase` performs these distinct checks:

1. Execute supported source in the owned interpreter against a bounded external fixture broker.
2. Validate the private journal and exact replay, then project source-certified public records.
3. Run original, operation-instrumented and branch-instrumented source in separate Node processes.
   The reference receives source, initial input graph and environment; it receives no teacher
   witness, private final state or expected answer.
4. Compare completion, reachable mutations, ordered effects, callback order and source receipts.
5. Replay the public selected state with no native services.
6. Import exact bytes through the production Megatoken tokenizer, fragmentation, context,
   visibility, loss and native action validators.

Only the final gate can produce `admitted` with `certified_teacher` origin. Without it a candidate
remains `locally_verified`. Refused, unsupported, over-budget, projection and reference failures
remain separate manifest counts. Native-consumer acceptance alone is not source certification.
Serialized admission re-executes the independent checks and binds exact producer/consumer commits,
schema, fixture/catalog digests, tokenizer identity, source family and provenance.

Fixtures include changed external answers with identical earlier prefixes, reversed settlements,
rejection/finally, callback-caused writes, Promise reactions/microtasks, every native capability
family, and cyclic graph feedback followed by an outbound graph mutation. Source-certified
checkpoint cases restore a real selected packet while an effect is pending, evict/reread source,
and reconcile only the causal delivery receipt. Generated work remains byte-identical to the
uninterrupted source episode. `verifyEffectfulSession` composes independently checked fresh outside
invocations into one source-once session, retaining all source ancestry and rechecking every component.
Megatoken's lifecycle collector adds explicit coordinator-teacher decisions and real runtime
allocation/join/restore receipts around individually admitted guest executions.

Pass `--representation explicit` or `--representation compact` to the generator to collect the
entire curriculum in that certified representation, including subscriptions, recovery and repeated
ingress. Without this flag the engineering manifest includes both compact comparison pairs.
Compact projection is bounded to eight operators and thirty-two expression nodes and requires
the exact source spans and operand-producer dependencies. Effect, mutation, callback, suspension
and cleanup boundaries remain visible. Recollecting changes the public witness and admission digest;
changing a sidecar label alone cannot convert a dataset.

Families are assigned before input, schedule, retry and counterfactual expansion. All descendants
remain in that family's split. The production preparer reruns the source verifier and native
consumer, then writes the actual native prepared-data representation. Curriculum supply gates
inspect the records, rather than trusting declared stage labels. Missing stage coverage is a failure.

## Reproducible non-optimizing commands

Install the locked Node dependencies and the paired Megatoken checkout. The tokenizer is
`inclusionAI/Ling-3.0-tiny` at revision `9a98e35fe1c9ee255f78dd64771c7ae15a799481`, SHA256
`40fb9d7d7795b8bd305aeff39ce9963f3f450915b9553f2938e009be9a1fed60`.

```sh
npm ci
npm run contracts:check
npm test
npx playwright install --with-deps chromium
npm run test:browser
node tools/generate-selected-harness-v4.mjs /tmp/two-invocations.json
node tools/generate-selected-continuity-v4.mjs /tmp/continuity
node tools/generate-effectful-training.mjs --out /tmp/semantic-v4 \
  --megatoken ../megatoken --python ../megatoken/.venv/bin/python \
  --tokenizer /path/to/tokenizer.json --require-native
node tools/verify-effectful-admission.mjs /tmp/semantic-v4/counter-0.json
node tools/inspect-selected-harness.mjs /tmp/semantic-v4/counter-0.json
```

`megatoken/scripts/prepare_semantic_corpus.py` takes repeated `--input` files, exact
`--producer-revision`/`--consumer-revision`, `--tracer-root`, `--tokenizer-json` and an output directory.
This exports data without an optimizer. `plan_semantic_training.py` validates the frozen data/config,
curriculum supply, seeds and token/compute budgets before later training. The checked-in semantic
configs declare explicit/compact/outcome-only controls and seeds 17, 29 and 43. Outcome-only controls
are confined to the common-support cohort; they cannot silently replace interactive effects.

```sh
node tools/freeze-selected-evaluation.mjs /tmp/semantic-v4 /tmp/declaration.json
python ../megatoken/scripts/evaluate_semantic.py freeze \
  --declaration /tmp/declaration.json --output /tmp/cohort.json
python ../megatoken/scripts/evaluate_semantic.py run --cohort /tmp/cohort.json \
  --runner-argv '["node","tools/run-selected-evaluation.mjs"]' \
  --origin controlled --seed 17 --tokenizer-json /path/to/tokenizer.json \
  --output /tmp/evaluation.json
```

The same freezer with `--common-support` creates the separate pure held-out cohort and retains
both certified representation plans for each source-identical case. The preserved historical runbook
does not contain measured baseline results. Its conditions and seeds are frozen as pending historical
evidence; learned comparisons require a separately produced historical receipt bound to this exact
cohort. Engineering checks never manufacture a historical score.

The evaluator withholds expected outcomes from the runner, checks whole-task state/effects/callbacks/
cleanup, validates the native trace and reports the first semantic inconsistency. It records actual
tokens, dispatches, memory, time, queues and leaked resources. Controlled injected actions never
produce a learned-success score. Model runs require the actual inference process to attest its
checkpoint digest and initialize the requested seed before any selection. They cannot use the
controlled selection fixture as a model repair path.

The freezer defaults to test families. `--include-validation` is an explicit engineering diagnostic;
learned comparisons require the test cohort. Original model fragment token IDs and rejected bytes
remain in inference receipts. Reports separate actual decoder emission cost from canonical witness
token counts. Timing is case wall time excluding model initialization. Memory is the documented
upper bound obtained by adding the runner's and native model process's measured lifetime peak RSS.

### Coordinator and child evaluation

`--with-orchestration` adds independently referenced coordinator variants to the effectful cohort.
The coordinator and all children share one actual Megatoken process and session. Native lifecycle
actions allocate children, bootstrap their code/input, establish typed completion dependencies,
join, publish observed child completions and finish the parent. The existing selected driver and
broker execute every child. Native active-capacity receipts decide when a child can begin.

The process adapter exposes `openOrchestration`, `stepOrchestration`, `statusOrchestration` and
`cancelOrchestration`. Actual model origins receive source/input proposals and observed receipts;
controlled coordinator actions and child selections are removed before a model runner receives
the request. The server accepts injected engineering actions only with the explicit
`--controlled-lifecycle-fixtures` flag. Those actions still cross native selection, commitment,
allocation and result-routing boundaries and remain labeled as controlled evidence.

`controlledOrchestrationCase` derives its outcome from an independently checked source case.
The native evaluator independently validates original coordinator bytes, action ownership,
creation-before-bootstrap order, typed joins, actual child completion, progress, and final cleanup.
Invalid model output retains its bytes and token IDs; it cannot become an empty successful trace.
Object reference names are normalized only for scoring observable graphs; original native progress
and completion receipts remain unchanged and are checked against each other.

Canonical and readable examples are in `docs/examples/selected-child-v4.json` and `.txt`.
`tools/inspect-selected-harness.mjs` reads both ordinary episodes and orchestration evaluation receipts.
`renderOrchestration` combines native coordinator records with the existing semantic witness renderer
and supports chronological or per-track inspection without executing guest code.

## Migration and integration

The package version is 0.3.0. Active training exports and `training:*` commands use harness/2.
The bounded-pure group writer, historical comparisons and source-corpus analysis remain explicitly
offline under `/training/diagnostic` and `diagnostic:*`. Old v3 serving artifacts and mismatched
catalog/schema/tokenizer pins are rejected; recollect affected trajectories instead of relabeling them.
The immutable historical baseline and frozen common-support comparisons remain separate from the
new effectful/track/event cohort.

CI checks exact shared contracts, real Node/Chromium adapters, source certification, the native
production tokenizer and prepared data, controlled selected rollouts, and actual fixed-weight
inference plumbing. The companion Natlang CI installs the pinned tracer and uses actual compiled
source and the shared failure class. Compatible code pins refer to tested implementation commits;
later documentation/pin-only commits may have different repository head SHAs.

M9 training, trained checkpoints, free-running learned success and deployment acceptance are
separate subsequent measurements. No initialized-model failure is replaced with a reference answer.
