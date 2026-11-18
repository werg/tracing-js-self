# Semantic trace abstraction experiments

The production `semantic-trace/5` codec and default compiler remain the control.
This work inspects actual predicted records and adds a deliberately narrow,
opt-in compatible reduction. A readable rendering is never counted as the
model's target, and byte savings are not described as token or learning gains.

## Reproduce the paired gallery

```sh
node tools/semantic-trace-gallery.mjs --out /tmp/trace-control
node tools/semantic-trace-gallery.mjs --out /tmp/trace-compact --local-state-compaction
node --test test/semantic-trace-gallery.test.js test/semantic-local-state-compaction.test.js
```

Each directory contains a JSON audit and a readable Markdown gallery. Eleven
locally verified executions cover expressions, decisions, object construction,
alias mutation, helper calls, dense loops, caught throws, finally, asynchronous
observations, repeated callbacks, captured cells, retained subscriptions, and
repeated lexical writes. Every target row includes its exact bytes, readable
view, claim description, private certificate rule, and digest of only the public
prefix before that row. Observations appear in causal order and are labeled as
observed rather than generated.

Checked-in evidence is under
[`evidence/semantic-target-gallery-v1/control/gallery.md`](evidence/semantic-target-gallery-v1/control/gallery.md)
and
[`evidence/semantic-target-gallery-v1/local-cell-idempotence/gallery.md`](evidence/semantic-target-gallery-v1/local-cell-idempotence/gallery.md).
These are local engineering fixtures, not a native-admitted training release.

| Arm | Executions | Generated records | Actual generated UTF-8 bytes | Native tokens |
| --- | ---: | ---: | ---: | --- |
| Default v5 control | 11 | 145 | 12,345 | Unavailable |
| `local-cell-idempotence/1` | 11 | 143 | 12,267 | Unavailable |
| Difference | 0 | -2 | -78 | Unmeasured |

The difference comes entirely from the repeated lexical-write fixture: two
identical `bind` records are removed. The other ten cases retain their target
records. This is a small measured compactness improvement; there is no claim
of improved comprehension, complete model execution, transfer, or native cost.

## What the byte accounting means

The audit partitions the canonical target bytes exactly into the record kind
and separating space, top-level JSON keys and colons, punctuation, and field
values. Nested expressions remain within their top-level value. It also counts
field occurrences, source-spelled cell bindings, repeated equal cell bindings,
record kinds, and observed rows. These are inspection metrics, not assertions
that every repeated key or identity is dispensable. Repeated same-valued writes
are counted as candidates; only the compiler's stricter rule can omit them.

Without a tokenizer adapter, token counts and native transport-fragment counts
are `null`, with an explicit unavailable status. An optional module passed with
`--tokenizer-module` must export a pinned `identity`, `encode(text)` and
`decode(ids)`. Every line must round-trip exactly. Its counts cover independently
encoded lines only. They do not measure native fragmentation, recurrent
historical context, masks, or a consumer's complete ingestion cost. The native
target/loss audit remains the authority for those measurements.

## T2: idempotent committed lexical writes

Enable the experiment with the compiler/admission projection option
`localStateCompaction: true`. The option is a boolean and defaults to false;
the default arm's bytes and certificate structure remain unchanged.

An omitted record must meet every condition below:

1. It is a normal owned `binding.write`, projected as a `cell-write` `bind`.
2. Its exact public lexical-cell identity already exists.
3. Its tagged value exactly equals that cell's committed value, including
   distinctions between reference identities and special numeric values.
4. It carries no iteration-cell `from` identity link.
5. Pending computations have already been committed before testing equality.

The compiler retains an `owned-idempotent-cell-write/1` private receipt with the
owned journal event, cell and value, and reports the number removed. Exact
reprojection validates that receipt. The ordinary selected controller then
replays the shorter public account and checks the same declared outcome.

This rule does not remove a declaration/initialization, property write, setter,
guest computation, call, read, external effect, observation, job, throw, handler
transfer, finally path or callback. Captured closures still refer to the same
cell; shadowed cells have different identities. A transient write followed by a
restoration is retained whenever the transient value differs. Consequently,
compression cannot repair or conceal the strict-accessor defect by treating
the erroneous intermediate value as redundant.

Tests exercise actual byte reduction and certificate tampering, default-arm
equivalence, transient writes, equal-looking but different aliases, same-valued
property writes, captured and shadowed cells, caught exceptions and finally.
Local agreement and same-interpreter replay do not replace independent
intermediate-claim authority; the separate assignment/completion workstream
owns that gate.

## T3/T4 independently checked experimental summaries

A new summary is not a production v5 record. The experimental contract binds the
exact source function/region and already committed entry state, requires a model
prediction of the result/completion and any stated state delta, retains detailed
private evidence, and checks the prediction independently. The checker rejects
an incorrect claim; it never repairs generated bytes or emits a teacher result
as though the model supplied it.

`src/training/semantic-summary-experiment.js` implements two bounded profiles:
`pure-helper/1` is one primitive expression return over committed scalar
parameters (at most eight operators and 32 nodes). `dense-array-sum/1` is an
exactly recognized zero-initialized accumulator and counted loop over an
ordinary dense array of finite numbers (128 iterations by default, at most
1,024). An observed context binds the exact source, source digest, entry name,
function region and input graph/digest. It is constructed from the public
source and entry input; the result remains a generated claim.

The model-facing summary states the completion and unchanged-input claim. A
loop summary also states its iteration count, accumulator transition, and zero
or more explicit intermediate checkpoints. Independent V8 source execution
checks completion and unchanged input. Separate instrumented V8 executions
check the loop's test sequence and every stated accumulator checkpoint; their
outcomes and effects must agree with the ordinary run. Both a coarse summary
and a finer sequence of checkpoints can pass. A false intermediate sum fails
even when the final result is correct.

Calls/getters, arbitrary coercions, proxies,
sparse arrays, mutated iteration inputs, early exits, exception/finally paths,
callbacks, async and external effects require explicit detailed boundaries and
are outside these initial summaries. Multiple accepted derivations must keep
the same source lineage/split identity. A fixed v5 execution remains available
as the detailed control. `buildSemanticSummaryExperiment` retains that full
private v5 episode plus independent reference receipts, and binds both forms to
the same source family and split identity. An experiment is accepted only when
the independently checked summary and the detailed control both pass.

```sh
node tools/semantic-summary-experiment.mjs --demo --out /tmp/summary-prototype
node --test test/semantic-summary-experiment.test.js
```

The demo uses **authored diagnostic predictions**, never simulated learned
outputs. It preserves a pure-helper example, coarse and checkpointed loop
examples, and an incorrect intermediate claim that is expected to be refused.
For an actual supplied prediction, use `--context <context.json> --summary
<summary.json> --family <source-lineage> --out <directory>`. The JSON schema is
demonstrated in the retained demo evidence. Incorrect predictions remain
unchanged; refusals do not return replacement targets.

The checked-in [prototype report](evidence/semantic-summary-prototype-v1/README.md)
records these actual byte counts:

| Authored diagnostic | Detailed target records | Detailed target bytes | Summary target bytes | Independent result |
| --- | ---: | ---: | ---: | --- |
| Scalar increment helper | 4 | 286 | 123 | Verified |
| Three-element sum, coarse | 29 | 2,386 | 225 | Verified |
| Same sum, three checkpoints | 29 | 2,386 | 326 | Verified |
| Correct final sum, false intermediate sum | — | — | — | Rejected |

This is a separately supplied function-region task, not integrated selected
execution. Pure-helper and loop target byte costs exclude observed source/input
context, just as the detailed control's target costs do. A shorter record is
only compactness evidence; full-context token cost, human comprehension, native
serving and learned execution remain unmeasured.

Production promotion requires coordinated codec, controller, source-certificate,
native-consumer and loss/visibility support, independent adversarial checks,
actual token/comprehension measurements, and a separate learning comparison.
None of those later gates is implied by this gallery or compatible reduction.
