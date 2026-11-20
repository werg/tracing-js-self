# Compositional semantic execution v8

This is an explicitly versioned candidate. It does not change the production
default or relabel v7 artifacts. The experiment uses `semantic-execution/8`,
`semantic-trace/8`, `semantic-context/8`, `semantic-continuation/8` and the
`compositional-regions/1` profile.

## Current bounded coverage and qualification

This matrix records the implementation status on 20 November 2026 against the
work proposed in [the language coverage plan](LANGUAGE_COVERAGE_PLAN.md).
**Implemented** means a checked producer/public-machine path exists.
**Source-qualified** means the linked bounded source suite checks owned execution
against independent source observations and validates its public projection.
Recognition by a parser or pure lowerer alone does not satisfy that gate.

Fresh [native qualification](../coverage/language-expansion/native-v8-8d1f7b5/README.md)
at producer `8d1f7b5` and consumer `be3a8d7` passed all **22 interoperability
cases and 11 retained-gallery cases**, including live source authority, public
replay, contexts, continuation, physical masks and the pinned production
tokenizer. Exact flat costs and native packing are retained for every case.
The separate [665-case expansion run](../coverage/language-expansion/native-v8-8d1f7b5-all/README.md)
retains 657 source passes, 656 native admissions, eight explicit enumeration
refusals and one native continuation failure. Its exact costs and paired
historical comparison are complete; the failure still needs fresh qualification
after repair. These receipts qualify only their recorded revisions and inputs.
**External model
comprehension and execution remain unmeasured**, and the production default
remains unchanged. Exact receipt requirements are in
[the training contract](SEMANTIC_V8_TRAINING.md#native-admission).

| Profile / plan area | Producer and source status | Explicit boundary |
| --- | --- | --- |
| Local primitive blocks and mixed execution (`compositional-regions/1`) | Implemented and source-qualified: local arithmetic, mutable cells, lazy choices, and compact work around checked guest calls, shared captures and cleanup. [Composition tests](../test/semantic-region-composition.test.js) | Calls, allocation, property behavior and cleanup need their checked detailed/protocol boundaries; a local block cannot hide them. |
| Pure algorithms (`ecmascript-pure-regions/1`) | Core and source lowering implemented: ordered folds, map/filter/search/quantifiers/scans, defaults, immutable helpers, ordinary projections and fresh output graphs. Independent equivalence tests and owned admission are separate checks. [Lowering tests](../test/semantic-algorithm-v8-lowering.test.js), [source-region tests](../test/semantic-pure-region-v8.test.js) | Dense traversal is bounded to 128 primitive elements. Sparse/hook-bearing traversal, effectful callbacks and existing-object mutation are outside the pure profile. Some accepted lowerer forms still lack owned/source admission. |
| Symbols, properties and closures (`symbols-ordinary-properties/1`) | Implemented and source-qualified: Symbol identity and keys, descriptors/prototypes, own-key enumeration, accessor calls, receiver restoration and live capture cells. [Source tests](../test/semantic-protocol-source-v8.test.js) also retain exact checkpoint state. Ordinary `push`/`pop` now use these property transitions. [Array mutation tests](../test/protocol-array-mutation-source.test.js) | Unmodeled intrinsic/key/coercion hooks and partial-failure array truncation refuse. A captured cell may be declared early, but calling before initialization still refuses. |
| Classes and private state (`class-private-source/1`) | Implemented and source-qualified: base/derived classes, ordinary function constructors and prototype replacement, fields, methods, private brands/updates, actual newTarget, object substitution and normal/throwing initializers. [Source tests](../test/protocol-construction-source.test.js) | Private accessors, constructor arrows/handlers, super-property references, exotic constructors and invalid derived-return guest errors need further public continuations. |
| Number conversion (`number-conversion-source/1`) | Implemented and source-qualified: direct synchronous `Number` calls, data conversion methods, live fallback selection, nested callbacks and primitive conversion. [Source tests](../test/semantic-protocol-number-source-v8.test.js) | Abrupt conversion, accessor selection, array stringification and async/exotic callbacks remain unqualified. |
| Builtin iteration (`builtin-iterator/1`) | Implemented and source-qualified: explicit array values/keys/entries, Unicode string iteration and standard-array `for…of`, with live length and retained cursor/identity. [Source tests](../test/semantic-protocol-iterator-source-v8.test.js) | General custom-iterator cleanup, index getters, optional iterator calls and captured builtin callable values require further profiles. |
| Synchronous generators (`synchronous-generator-source/1`) | Implemented and source-qualified: sent values, return/throw, catch/finally suspension and `yield*` through builtin iterators or qualified generators; own String/Symbol data properties retain descriptors and aliases across suspension. [Source tests](../test/semantic-protocol-generator-source-v8.test.js) | Async generators, parameter expressions, custom delegation/accessors, absent-delegate-throw TypeErrors and loop-target cleanup remain unqualified. |
| Promise joins (`promise-join/1`, source `promise-joins-source/1`) | Implemented and source-qualified: `all`/`race`, ordered dependencies, rejection, empty inputs and FIFO late no-op reactions. [Source tests](../test/semantic-protocol-promise-join-source-v8.test.js) | `allSettled`/`any`, external effects and unrestricted thenable behavior are outside this slice. |
| Promise executors (`promise-executor/1`, source `promise-executors-source/1`) | Implemented and source-qualified: synchronous direct constructors, retained resolving functions, first-call behavior, scalar resolution/rejection or throws, synchronous helpers and construction inside reaction jobs with retained receivers/captures. [Source tests](../test/semantic-protocol-promise-executor-source-v8.test.js) | Direct identifier resolver calls only; indirect constructor aliases, owned-Promise adoption, object/thenable resolution, self resolution, async/generator executors and host callbacks remain refused. Promise adoption requires a checked assimilation-job boundary to preserve native FIFO order. |
| Proxy get/set (`ordinary-data-proxy-source/1`) | Implemented and source-qualified: ordinary data targets/handlers, live synchronous get/set traps, receiver/capture scope, exact target invariants and aliases. [Source tests](../test/semantic-protocol-proxy-source-v8.test.js) | Arrays, custom prototypes, accessor targets/handlers, callable/revoked proxies, other traps, false setters and invariant-triggered guest TypeErrors need separate profiles. |
| Binary memory (`owned-binary-memory/1`) | Implemented and source-qualified: ordinary/shared buffers, typed views/DataView, aliasing and copies, bounded growth and single-agent atomics. [Source tests](../test/semantic-protocol-memory-source-v8.test.js) | Backing buffers are bounded to 1,024 bytes. Resizable ordinary buffers, detach/transfer, host buffers and cross-agent scheduling are outside the profile. |
| Modules and generated TypeScript (`evaluated-module-regions/1`) | Implemented and source-qualified: live cells, synchronous cycles, acyclic top-level await and ordered export calls; erased types and a runtime-emitting enum are checked separately against native ESM. [Source tests](../test/semantic-module-v8.test.js) | Async dependency cycles, dynamic import, escaping namespaces/namespace receivers and exotic return graphs refuse. Module sessions and unrestricted TypeScript semantics are separate qualifications. |

The plan's waves are therefore partly implemented, with explicit boundaries
remaining in every wave. Features outside these rows do not acquire coverage
through a related runtime builtin or a successful final scalar. In particular,
general async iteration, unrestricted coercion/Proxy/construction, new compact
collection or RegExp profiles, arbitrary host/DOM behavior, dynamic evaluation,
GC observability and cross-agent memory scheduling remain separately scoped.

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

`verifyRegionTrainingCase` is the common v8 source entry point. When historical
detailed projection or its completion observer cannot represent a supported
protocol, it tries the independently checked direct protocol compiler. Each
attempt has an explicit disposition. Existing reference disagreements and
resource failures retain their original evidence. The direct path independently
checks source outcomes, operations, branches, completions and behavioral metadata
before constructing public records and contexts.

`recheckRegionEvidence`, native admission, family binding and dataset export
dispatch on the exact evidence schema and repeat those source checks. Symbol,
descriptor and binary-memory episodes therefore use the same family split,
causal serializer and generated-only training masks as other v8 episodes.
Public APIs, including explicit direct-protocol verification and profile field
tables, are exported from `tracing-js-self/semantic`. Adding a public operation
does not by itself qualify its source adapter or matching native consumer.

Logical protocol choices publish an independently evaluable `logical-test`
over the current left operand. The test determines whether `&&`, `||` or `??`
uses that operand or evaluates the right side. Optional member/call guards
likewise test the current object/callee before computed keys or arguments run.
Future right-side work cannot appear in the earlier decision. Delegated
generator method guards use their already checked method-selection evidence;
they do not introduce a synthetic source branch with a literal answer.

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

The complete 22-case interoperability and 11-case gallery runs have retained
source/native admission, exact tokenizer costs and native packing. The
665-case expansion run and its 42-pair historical comparison are also retained,
including one native failure and eight explicit source refusals. Detailed
targets account for 86.03% of generated expansion tokens. The frozen populations
and reproduction commands are documented in
[the evaluation protocol](LANGUAGE_EXPANSION_EVALUATION.md). The combined
[production dataset export](../coverage/language-expansion/dataset-v8-8d1f7b5/README.md)
retains all 33 gallery/interoperability episodes and 858 complete examples,
exact masks and fresh admission after split binding at its recorded revisions.

External model comprehension, next-step accuracy, completed execution and cost
per successful model execution remain **unmeasured**. Default promotion remains
**unqualified** until the declared correctness, native, dataset, tokenizer and
model gates pass with exact pins and retained denominators. The existing v7
candidate and historical v6/v7 evidence keep their original identities while
these gates are evaluated.
