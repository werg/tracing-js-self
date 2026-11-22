# Owned Promise adoption: initial producer increment

This isolated implementation extends the public source protocol with explicit
intrinsic Promise assimilation and forwarding jobs. It is not yet a qualified
paired native or training release. The branch is based on producer local
`875b6b25c98860892b4c9dc0ce0899dc2c6506f3`, whose tree equals published
`ae5fa0f13fc8e8d8996cb6ff360c209ae2f83fa8`. It does not replace later main,
bootstrap fixture fixes, terminal recovery work, or historical Promise evidence.

## Implemented boundary

An original executor resolving call, scoped async completion, or reaction
completion owns the first resolution intent. Its immediate next public record
must enqueue the exact assimilation job, or derive a fresh self-rejection
error. The first FIFO job registers a forwarding observer. A later FIFO job
forwards the exact fulfilled value or opaque rejection reason. Both jobs use
the existing scheduler, including its shared-realm ordering; there is no
second queue or aggregate adoption protocol table. Promise state retains the
exact cause, owning invocation, target, and both job identities.

The source compiler derives those records from the current original runtime
event, including the exact queued assimilation job and newly registered
forwarding observer. It does not inspect a future event to choose a current
identity. Independent Node execution and source recompilation remain mandatory
for source qualification. First-call authority survives while adoption is still
pending, so later resolve, reject, and executor throw are ignored correctly.

Only owned Promises with the unchanged intrinsic `then` lookup are admitted.
Own `then` data, accessors, changed prototypes, callable thenables, proxies,
and unsupported async reaction activation are outside this slice. Direct self
resolution derives a fresh TypeError-shaped source allocation and rejects
without either job; reflected native Error metadata remains a source refusal.
Distinct mutual adoption stays pending and does not fabricate a cycle error.
Fulfilled forwarding whose value is itself a Promise remains refused.

## Retained local evidence

Commands ran with Node 24.22.3 in this isolated worktree:

```sh
node --test test/semantic-protocol-promise-adoption-v8.test.js test/semantic-protocol-promise-executor-v8.test.js
RUNNER_TEMP=/workspace/scratch/05d92519587f node --experimental-vm-modules --test test/semantic-protocol-promise-adoption-source-v8.test.js
node --experimental-vm-modules --test test/semantic-async-call-source-v8.test.js test/semantic-protocol-promise-executor-source-v8.test.js test/semantic-shared-protocol-source-v8.test.js
```

| Cohort | Result | Scope |
| --- | --- | --- |
| Public adoption and executor controls | 29 passed, zero failed or skipped | Atomic malformed records, first-call authority, self rejection, mutual pending cycles, default-then refusals, FIFO, shared realm, and JSON restoration |
| New original-source controls | 19 passed, one explicit unconfigured-native skip | 14 original sources, 60 restored cuts, 377 generated contexts; exact source recheck and independent Node outcome/Promise observations |
| Existing async/executor/shared-source regression | 35 passed, one explicit unconfigured-native skip | Existing source composition; measured before the later source profile label and four extra public async controls |

The actual independent Node `queueMicrotask` test distinguishes `dqa` from
`qda` after changing source scheduling, and an infinite queued callback is
refused by the unchanged finite process deadline. Earlier async-only producer
`5b7c33f2ad1fe1e9ccce329ce773cf1a67d6de37` remains historical evidence; its
useful result-reaction/await ordering, pending-target, malformed body/target,
and restore assertions were ported to these shared records. Its separate
`async.resolve.*` implementation was not copied.

## Required next work

- Regenerate and independently recheck the six interoperability payloads and
  complete contract manifest. The current definition digest is
  `fd1e64f60ad5b6bb9431db3cd34513a5bd34041cdf7e710a99c5df1205502bf4`;
  the retained old interoperability manifest is deliberately not qualification.
- Align the independent native machine with the exact job fields, cause and
  owner checks, fresh self allocation, and the source compiler's record order.
- Run every source case and restore cut against the exact native revision,
  with a mandatory gate that rejects skips and pins both commits.
- Review and compose only the qualified paths onto current main while retaining
  concurrent bootstrap, service, terminal, router, module, and target work.

Actual native cases in this local bundle: **zero**. Training/data admission,
optimizer updates, production denominator changes, and resource-cap changes:
**none**. Broad thenable assimilation and all Error reflection are not claimed.
