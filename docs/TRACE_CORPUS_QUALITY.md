# Real-world execution trace coverage and readability

The repository now contains an initial inventory of pinned, unchanged
VS Code TypeScript and Lodash JavaScript functions in `corpus/cases.mjs`.
The invocations are deterministic, and are split by source function rather
than by individual input. Generate and audit them with:

```sh
npm ci
npm run corpus:generate -- --per-function 12 \\
  --output /tmp/real.jsonl --report /tmp/real-report.json --review /tmp/real-review.md
npm run corpus:audit -- --input /tmp/real.jsonl \\
  --output /tmp/quality.json --review /tmp/quality.md --examples 20
```

`corpus:generate` uses instrumented V8, reruns the same program in a
separate uninstrumented V8 execution and compares the observable outcome.
`corpus:audit` performs a **read-only** audit by function: event totals,
state changes, source-expression snippets, bytes, opaque results, missing
source spans, repeated reads, call/return ordering candidates, and no-change
writes. These are review flags, not proof that any event should be omitted.

**Important limit:** this is an **observational diagnostic corpus**, not an
owned-interpreter `semantic-execution/2` training corpus. Agreement on a
final observable outcome does not prove the correctness or completeness of
each intermediate event. Native V8 execution is not a source of authoritative
owned journal events; the native corpus must not be admitted directly to
the megatoken semantic training adapter.

The current owned exporter remains bounded: one strict synchronous entry,
small source bundle, and independently implemented language operations.
Real application imports, timers, effects, callback reentry, and native
builtins may hide information required for execution reasoning. To reach
near-general JS/TS, these need explicit observation of effective work and
independent checks; faithfully executing arbitrary JavaScript is not yet
achieved.

The next gating step is a **coverage bridge**: attempt every pinned corpus
function through the owned interpreter, record exact failure categories and
observed traces side by side, prioritize the feature gaps with the greatest
number of otherwise verified examples, then compare actual model outcomes
before/after any trace compaction.

## Measured initial coverage (pinned run, 2026-10-23)

Across 78 original upstream functions and 936 deterministic invocations, the
native diagnostic pass checked 936/936 final observable outcomes against a
separate V8 execution. It emitted 27,039 events: 4,795 branches, 3,278 call
records, 2,896 read records and 3,656 property-state changes. The median
trace is 22 events and 2,479 serialized event bytes. This is final-outcome
agreement, **not independent proof of every intermediate operation**.

The owned coverage bridge sampled two invocations per function (156 total):
24 locally verified across 12 families; 52 unsupported profile/syntax,
36 runtime failures, 36 nonportable callback fixtures and eight source-bundle
limits. These are **not** 156 admitted examples. See the generated GitHub
Actions artifacts for exact per-function reasons.

A substantial number of observed \`write\` records have **no changed heap
properties**. This category includes ordinary lexical assignments, so it is
not evidence that thousands of writes are redundant. Additionally, a callee's
return can precede the record for the *calling expression*, because the
current instrumenter records the call result after execution. This order
is faithful to hook execution but harder for a reader/model to interpret as
call/return structure. A future representation should distinguish call entry
from call completion without perturbing argument or receiver evaluation.
