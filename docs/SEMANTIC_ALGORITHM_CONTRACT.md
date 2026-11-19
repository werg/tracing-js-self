# Semantic algorithm and observation contract

Contract revision: **1**, introduced 19 November 2026. This contract defines the
bounded algorithm representation after the v6 baseline. The
[implementation ledger](SEMANTIC_ALGORITHM_IMPLEMENTATION.md) records executable
work and open qualification gates. A specification here is an obligation, not a
claim that a release has passed its gates.

## Purpose and independent authorities

The public trace describes computations, relevant state changes, and external
interactions. Source names, private temporaries, helper frames, loop bookkeeping,
and private allocations may disappear under a checked rule. The trace must
retain enough structure to explain and check the result. An opaque
`evaluate function(inputs) => result` is insufficient for a supported arithmetic
or fold region.

```text
observable(source_execution(program, inputs, external_interaction))
  = observable(semantic_execution(core, inputs, external_interaction))
```

This equality concerns an admitted execution and its declared domain. One
passing input or observed schedule does not establish equivalence over all
inputs or future responses. Every normalization rule states its applicability
conditions; finite regression results are not a universal proof.

| Question | Required evidence |
| --- | --- |
| Behavioral correctness | Completion, rooted visible state, ordered effects, observations, and continuation agree with independent source execution. |
| Normalization | Related source variants converge under a declared rule and supported input domain. |
| Explanatory adequacy | The trace retains operations, dependencies, relevant selection, and effect order needed to explain behavior. |

The owned runtime and journal remain the detailed execution authority. Exact
replay validates the archive. Independent source, operation, branch, and
completion checks establish source truth. The semantic checker validates
emitted claims against committed public state. Native qualification checks the
actual consumer, tokenizer, visibility, and supervision. These are separate
obligations; see the [authority matrix](SEMANTIC_AUTHORITY_MATRIX.md).

## Observation contract

The initial observation schema is `semantic-observables/1`. Implementations
preserve the following distinctions or explicitly refuse an unsupported profile.

| Category | Required distinctions |
| --- | --- |
| Completion | Return, guest throw, and live suspension; unsupported execution and internal runtime failure are separate dispositions. |
| Visible state | Input and returned objects, retained resources, captured state, and any state affecting later work. Absent properties differ from present `undefined`. |
| Effects | Authorized operation, evaluated arguments, dispatch order, multiplicity, argument snapshot at dispatch, and correlation. |
| Observations | Results, rejections, callbacks, external event order, and delivery order. A protocol acknowledgment differs from an actual `undefined` value where the host contract distinguishes them. |
| Continuation | Live values, relevant heap/capture state, pending effects, completion obligations, and dependencies required to resume. |
| Identity | Input identity, aliasing, ownership, and retained resources where behavior depends on them. |

Graph comparison is rooted and preserves aliases. Fresh internal identities may
be consistently renamed; input roots and their relationships remain anchored.
Comparing only contents, terminal values, or raw allocation labels is
insufficient. Mutating an input alias differs from returning an equal copy.

Effects and deliveries are ordered sequences, not multisets. Callback failures,
finally cleanup, and unhandled rejection obligations cannot disappear because
the successful final scalar matches. Continuation equivalence covers the state
needed for every permitted next observation under the declared profile.

## Typed core and evidence boundaries

The initial core schema is `semantic-algorithm/1`: validated JavaScript data
structures with explicit dependencies and ordered steps. The initial vocabulary
covers scalar/reference terms, typed primitive transformations, selection,
ordered folds, visible state, requests, observations, completion, and suspension.
Unsupported forms have an explicit refusal or faithful detailed disposition.

| Layer | Contents | Authority |
| --- | --- | --- |
| Semantic core | Operations, dependencies, relevant state, effects, selection, completion | Meaning to evaluate and explain |
| Trusted execution envelope | Program/region identity, capability grants, active scope, legal effect boundary, dispatch correlation, observation delivery | Routing and authorization |
| Private evidence | Source spans/digests, event IDs, internal versions, normalization receipts, independent reference results, exact replay | Source correspondence and rechecking |

Canonical identities follow scope and dependency order, never source spelling
or offsets. Optional annotations may retain readable names but are excluded
from canonical comparison. Property keys, storage keys, and capability names
are behavioral data and are not alpha-renamed.

A transformation receipt identifies its rule/version, input/output fragments,
source and journal correspondence, domain guards, live inputs/outputs, and
preserved effect boundaries. It is bound to actual evidence and recheckable;
a rule name alone is not proof. Receipts do not become predicted proof text.

## Numeric and evaluation profiles

`binary64-ordered/1` means JavaScript Number operations with binary64 semantics
and the original left-to-right evaluation/accumulation order. It does not
authorize associative sums or integer arithmetic. Encodings preserve signed
zero, NaN, and infinities without JSON's lossy conversions. Finite inputs can
overflow during accumulation and that outcome is preserved.

Numeric addition, string concatenation, and BigInt arithmetic have separate
applicability conditions. A numeric profile refuses coercive operands. A broader
primitive operation implements its declared coercion and exceptional behavior
exactly. No reassociation, commutation, or familiar algebraic identity is
implicitly permitted.

Evaluators have explicit node, operator, helper-call, and iteration bounds.
Exceeding a bound is an unsupported/profile-limit disposition, not guest throw.
The initial ordered fold starts at numeric positive zero and traverses a dense
ordinary numeric array in increasing index order. Source recognition and input
domain guards are separate checks.

## Bounded normalization rules

Pass order and budgets are deterministic. Normalization is idempotent: applying
it to normalized input preserves canonical serialization. Rules are bounded
transformations, not a general JavaScript optimizer.

| Rule | Preconditions | Permitted omission | Required negative cases |
| --- | --- | --- | --- |
| Lexical alpha normalization | Capture-aware resolution; unchanged data/capability keys | Local spelling and incidental numbering | Shadowing, changed capture, renamed data key |
| Private value propagation | Def-use link, purity, liveness, preserved evaluation | Copies and eligible temporaries | Equal unrelated producers, mutable captures, effect barriers |
| Bounded helper expansion | Known ordinary helper, checked arity/arguments/order/scope/receiver, acyclic bounded body | Frames and parameter copies | Recursion, ambient reads, `this`, unknown calls, effects, discarded throwing arguments |
| Pure expression composition | Typed operations, preserved dependencies/order/coercion/failures | Eligible intermediate records | Reassociation, hooks, observable reads, changed exceptions |
| Dead private work removal | No effects, visible failures, relevant RNG draws, hooks, or nontermination | Irrelevant unused work | Throwing, randomness-consuming, effectful, or diverging work |
| Private object scalarization | Fresh ordinary data, known local aliases, complete bounded access analysis, nonescape | Allocation and field bookkeeping | Returned/input/effect-exposed/captured/retained objects; hooks |
| Ordered fold recognition | Equivalent traversal/initial state/step, array domain, ownership, no hooks/mutation | Index/test/accumulator bookkeeping | Reverse traversal, holes, strings, overwritten methods, custom iterators, mutation |
| Private transition coalescing | No observer or continuation distinguishes intermediate states | Overwritten private state | Effect/callback reads of intermediates |
| Effect transport derivation | Immutable authorized boundary and committed arguments | Duplicate payloads and predicted source coordinates | Forged boundary, skipped/duplicate effects, changed arguments/capability |

Unknown calls, shared mutations, effects, hooks, and potentially observable
exceptions are region boundaries until an explicit rule proves a narrower case.
Future observations cannot justify an earlier public compression. Liveness
retains everything any permitted unresolved continuation may need.

## First complete slices

Supported arithmetic retains its computational structure:

```text
answer = add(multiply(add(input1, input2), add(input3, input4)), 1) => 22
return answer
```

The initial sum family includes indexed `for`, matching `while`, and proved
temporary/helper variants. Eligible `for...of` requires certified ordinary-array
iterator behavior; `reduce` requires a separately certified built-in/callback
rule. All admitted variants share ordered-fold meaning:

```text
total = fold_left(input1, 0, add) => 9
return total
```

The controlled reading retains order and initialization: “Starting at zero,
add each number in order. Return 9.” Empty/singleton arrays, signed zeros, large
finite values, and rounding-sensitive inputs belong in the test domain.
Holes, hooks, extra observable properties, custom iteration, mutation, and
unsupported element types are distinguished or refused. Exact syntax is an
implementation decision measured with the production tokenizer; these examples
state meaning.

The private-object example may collapse to scalar computation only when its
identity does not escape. The async counter exposes read, observed value,
increment, store, and completion. Its narrow scheduling profile preserves order
and resumability; `await` and `.then` are not assumed equivalent.

## Claims, causal regions, and authorized effects

An omitted temporary makes no public assertion. An emitted intermediate value,
predicate, selection, or mutation must be true even if the final answer matches.
Independent source evidence retains omitted source decisions/computations.
False predictions remain diagnosable and cannot authorize strict effects.

A region interface names committed live inputs/state, a bounded operation,
claimed outputs/visible delta, completion, and next continuation/effect boundary.
Validation uses only the public prefix. No region may skip pending effects or
absorb unseen responses.

Before dropping predicted source sites, bind each semantic boundary to immutable
source/capability authorization. Check the legal continuation, operation,
arguments, and ownership, then derive one payload using the existing host codec.
Preserve the dispatch snapshot and correlation. If several boundaries are
otherwise indistinguishable, retain a compact boundary identifier rather than
guessing a callsite. Restore the intent lifecycle to avoid duplicate dispatch.

Observations are environmental context with zero prediction loss. Hiding
promise/job mechanics preserves rejection, cleanup, callbacks, outstanding
obligations, and continued execution. Unsupported scheduling retains detailed
boundaries. Perturbing future responses leaves earlier generated prefixes
unchanged.

## Rendering, context, versions, and release

One operation registry aligns validation, evaluation, compact text, and
controlled language templates. Prose is a reading, not an unchecked execution
format. Strict parse/re-encode equality provides one canonical spelling;
teacher re-projection checks artifact integrity. Separate semantic validation
may accept alternative valid decompositions without teacher byte equality.

Publish immutable definitions once and reference them only after the consumer
can access them. Boundary context retains required live state and source
context. Include cache/retrieval, framing, observed data, peak context, and
cumulative repeated context in costs. Moving tokens out of predictions is not
automatically a total-cost reduction.

The intended successor wire version is `semantic-trace/7`; context, execution,
continuation, contract, and admission identities change with their semantics.
Old artifacts keep their identities. No compatibility decoder, checkpoint
migration, or dual-format production support is required. New artifacts are
regenerated and re-admitted.

Promotion requires positive/negative regressions, checked claims, independent
source/replay protections, native/JavaScript agreement, full paired cost evidence
for the unchanged baseline, and predeclared comprehension checks. Observe zero
false merges on the release suite and state its finite scope. Engineering
qualification does not establish learning gains; those need controlled training
and held-out algorithm-family experiments.
