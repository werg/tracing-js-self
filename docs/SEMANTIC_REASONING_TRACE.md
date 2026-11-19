# Source-grounded semantic reasoning traces

The current production contracts are `semantic-execution/6`,
`semantic-trace/6`, `semantic-context/6`, `semantic-continuation/6` and
`selected-harness/2`. The [language specification](PRODUCTION_TRACE_V6.md)
defines the bytes that both training and serving actually use.

The model predicts a compact account of executing the supplied program.
Admission checks terminal completion, returned and reachable data, ordered
effects, delivered observations, callback execution and pending work. A valid
alternative account need not reproduce a teacher's internal instruction list.

## Predict useful semantic steps

The production compiler combines a bounded, source-proven pure region into one
result. These exact generated lines come from the checked
[target gallery](evidence/semantic-target-gallery-v2/gallery.md):

```text
evaluate run(1, 2, 3, 4) => 22
end return
```

Its source is `function run(a,b,c,d){return (a+b)*(c+d)+1;}` under strict mode.
An acyclic pure helper is included in the same region:

```js
"use strict";
function increment(value) { return value + 1; }
function run(n) { return increment(n); }
```

For input `4`, the production targets are:

```text
evaluate run(4) => 5
end return
```

A dense numeric sum over three items is:

```text
evaluate run(@o2) => 9 over 3 items into total
end return
```

The object reference identifies the already observed array; its elements are
not hidden labels. The public checker proves the supported loop shape from
immutable source and the current ordinary input array. It checks the claimed
result, iteration count and accumulator. Conditional regions also predict the
exact ordered branch decisions, so the same final value cannot conceal the
wrong executed branch.

These summaries are enabled by default, with explicit bounds: at most four
acyclic named helper calls, eight expression operators, 32 expression nodes,
and 128 iterations for dense sums. Unsupported shapes use detailed v6 semantic
steps when the underlying language operation is supported. Mutation, ambient
state, getters, recursion, exceptions and external effects are not silently
absorbed into a pure region.

## Keep state changes and observations explicit

A source variable uses its actual name. Ordinary values do not acquire
synthetic temporary identities. References remain where aliases matter. This
is the complete generated sequence for the gallery's shared-object example:

```text
new @o2 object {}
write @o2["n"] = 2
box = @o2
alias = @o2
read @o2["n"] => 2
compute (2 + 1) => 3 in @invocation1
write @o2["n"] = 3
read @o2["n"] => 3
return 3 in @invocation1
end return
```

Both names refer to the same owned object. The reads remain on their actual
sides of the mutation. Repeated lexical writes of the already committed exact
value can be omitted, with a private certificate; property writes, distinct
aliases and intervening changes remain visible.

An asynchronous request crosses an authority boundary. The following excerpt
comes from the real counter fixture:

```text
request @e1 demo.readAsync("counter") payload ["counter"] promise @p2 in @invocation1 at 57..76
await @p2 as @continuation1 returns @p1 in @invocation1
observe @e1 fulfilled 7
resume @continuation1 fulfilled 7 in @invocation1
current = 7
compute (current + 1) => 8 as next in @invocation1
```

The `observe` line is supplied by the environment and is never a prediction
target. The generated `resume` line may use the result only after that
observation has arrived. Source offsets identify the exact authorized external
call; they do not authorize an effect by themselves. The complete gallery
retains every source, input, target, observation and boundary rather than
presenting this excerpt as the entire episode.

## Compact language, strict meaning

The surface language uses ordinary literals and short verbs. It is still a
canonical protocol: two independent parsers must agree on the complete typed
meaning, and malformed or ambiguous lines are rejected. The canonical grammar
covers strings, Unicode source names, exceptional numbers, bigints, aliases,
captures, external requests, promises, jobs and completion. Generated records
no longer use kind-plus-JSON envelopes. Observed source and input graphs retain
their explicit data structure and ownership checks.

The syntax-only constrained decoder describes forms and tokens; it contains no
source-specific result, preferred branch, expected object identity or teacher
answer. Parsing establishes well-formedness. The selected controller separately
checks the claim against prior committed public state. It never substitutes a
correct teacher answer for a wrong prediction.

Private interpreter journals and independent V8 operation/branch/completion
receipts certify the teacher. They are not model targets. Native admission
additionally verifies production tokenization, causal track/context visibility,
action ownership and supervision masks. Old v5 artifacts are rejected and must
be recollected and prepared under the new paired versions.

## Measure the actual target

Across the same eleven gallery inputs, v6 has 107 generated records, 3,861 UTF-8
target bytes and 1,307 production-tokenizer tokens. The unchanged archived v5
control has 145 records, 12,345 bytes and 3,784 tokens. Both raw target sets use
the same pinned tokenizer, with an exact token/byte round trip for every line.
These counts exclude native framing and observed context.

The result is about 65% fewer target tokens on this engineering gallery.
Whether this improves learned execution remains a separate measured question.
The native conditional and supervision audits must exercise the actual saved
checkpoint, recurrent transitions, decoder output support and token losses;
equal input bytes or a shorter target alone do not establish equal predictions.
