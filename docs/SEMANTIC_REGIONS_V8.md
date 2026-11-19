# Compositional semantic execution v8

This is an explicitly versioned candidate. It does not change the production
default or relabel v7 artifacts. The experiment uses `semantic-execution/8`,
`semantic-trace/8`, `semantic-context/8`, `semantic-continuation/8` and the
`compositional-regions/1` profile.

## One shared selected machine

`RegionExecutionHarness` applies compact and detailed work to the existing
`SelectedExecutionHarness` and `SemanticController`. The two kinds share the
same heap, cells, capture aliases, receiver, frame stack, pending completion,
Promise continuations, requests, jobs and handler lifetimes. A compact result
is not spliced into an independently executed trace.

`defineRegionProgram` derives immutable bounded blocks from source before
execution. Initial local blocks contain primitive declarations, mutable local
assignments, lazy logical/conditional expressions, and returns outside cleanup.
Calls, properties, allocations, patterns, cleanup, ambiguous lexical mappings,
and nested guest frames use checked detailed records. This is a qualification
boundary, not an assertion that those operations are absent from the runtime.

Eligibility uses committed tagged values and owned metadata. It neither reads
guest properties nor calls a coercion hook. The complete local block is staged
against copied state. If any expression throws or exceeds the profile, the
block falls back before committing a binding. Once a boundary has committed,
execution continues from the shared selected state; it never reexecutes source.

## Entry, targets and causal state

The host entry envelope binds an immutable program and region digest, the exact
public cutoff, and a digest of the entire shared continuation. The controller
rejects a stale envelope after any intervening state change or public receipt.
An already consumed block cannot be committed again in the same activation.
Routing hashes are **not** generated target text.

A generated compact line is `region ` followed by canonical JSON with exactly
`region`, `bindings`, `decisions`, and `completion`. Its source-defined
computation is published in the immutable region definition. A detailed line
uses the existing strict typed `detail {"fields":...,"kind":...}` spelling and
witness semantics. There is no parser that accepts an old episode under a new
version label. Inputs and external deliveries remain observed data.

An entire source-certified pure `semantic-algorithm/2` core can also be one
region. Its `algorithm ` target contains independently evaluated claims,
retained fresh allocations, and completion. The definition contains the actual
ordered folds, callback bodies, projections, lazy selections and dependencies.
The region only enters an untouched invocation. Existing input identities stay
anchored; each new core identity maps once, in allocation order, to the first
unused `oN` selected identity. Integer property keys follow ECMAScript own-key
ordering. Allocation and return commit through the same detailed heap and
completion operations, and alias mappings stay in private correspondence
evidence. This permits array/object results without flattening references.

V8 envelopes have exactly `sequence`, `mode`, `kind`, and `fields`. A compact
envelope carries its trusted `entry` beside `line`; consumers supervise only
the line. Definitions, all committed live values and alias-preserving state,
pending completion, request/callback lifetimes, and the public cutoff are in
the context. The initial implementation deliberately retains conservative live
state. Full serializer costs must count that context rather than treating a
short definition reference as free.

The established detailed controller validates its public state transitions.
Its independent source-correspondence checks remain a separate admission gate.
The v8 source projector additionally checks every local replacement against the
entire detailed shared continuation, including live cells, references, pending
completion and obligations. It cannot admit a projection by comparing final
scalars alone. Serving promotion still requires independent native validation
and source/continuation qualification for the declared slice.

## Producer and evidence

`verifyRegionTrainingCase` first runs the owned interpreter and the existing
independent outcome, operation, branch and completion audits with whole-episode
summaries disabled. `projectRegionWitness` uses private source/journal
correspondence to select consecutive local replacements and compare shared
state. Source spans, journals and replacement receipts remain private evidence.
`recheckRegionEvidence` independently rechecks the source artifact and then
rebuilds the complete public projection and contexts.

The public API supplies `RegionExecutionHarness`, `verifyRegionTrainingCase`,
`recheckRegionEvidence`, and `checkRegionCounterfactualPrefixes`. The evidence
records whole-episode disposition, compact/detailed region and record counts,
and actual line bytes. Token shares remain `null` until a tokenizer is supplied;
bytes are not token measurements.

## Restore and effects

A v8 checkpoint contains its public mixed prefix, consumed region cursor and
the existing selected checkpoint. Restore first validates and replays the
mixed public prefix without services, checks the selected history against that
prefix, and restores through the established dispatch-lifecycle machinery.
Already committed work and dispatched intents are not executed again. An
uncertain service dispatch still requires explicit reconciliation.

The release tests cover compact–getter–compact execution, shared captured
mutation, receiver identity, local precommit fallback, false claim rejection,
stale entries, checkpoint continuation, cleanup overriding return, and future
response isolation. These finite tests establish their declared scope, not
universal equivalence or a measured model-comprehension improvement.

## Remaining promotion gates

The v8 candidate needs a matching pinned native consumer, admission and training
export receipts, measured tokenizer costs, and external model results before
default promotion. The existing v7 candidate and historical v6/v7 evidence keep
their original identities while these gates are evaluated.
