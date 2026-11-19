# Pure regions in semantic execution v8

`src/semantic/algorithm-v8.js` implements the candidate `semantic-algorithm/2`
core under `ecmascript-pure-regions/1`. This is a new semantic contract, not a
version-label change to admitted v7 artifacts. Source recognition, owned source
agreement, native admission, and model qualification are separate gates.

## Core and evaluation interface

A core contains exactly `schema`, `profile`, `inputs`, and `steps`. Inputs have
`id` and `type`: `value`, `scalar`, `number`, `dense-number-array`,
`dense-primitive-array`, `data`, or `nullable-data`. `value` permits a scalar or
ordinary anchored reference; `data` requires an ordinary reference;
`nullable-data` additionally permits null and undefined. A pure core has ordered compute steps
(`kind`, `id`, `term`), followed by return/throw (`kind`, `value`). Effects and
continuation routing belong to the surrounding shared region controller.

Values retain the v7 scalar tags and explicit object references. No inline
array-by-value encoding erases identity. `evaluateAlgorithmV8(core, args,
{heap, inputGraph, allocator})` validates and clones the heap before evaluation;
`inputGraph`, when present, contains `roots` and `objects` and supplies both
arguments and heap. The result includes `completion`, ordered `claims`, `graph`
(input roots followed by completion root), `heap`, `allocator`, and semantic
`work`. All aliases remain shared in the returned graph.

`evaluateTermV8(term, {inputs, values, heap, allocator, scopes, budget})` is the
lower-level interface for a controller's speculative state transaction. It
mutates only the supplied heap/allocator and must receive a speculative copy
until the controller accepts a claim. Allocation uses `{prefix, next}` and
chooses `prefix:next`, incrementing until an unused identity is found. The
surrounding controller must retain the allocator in checkpoints. Pure terms
cannot dispatch requests, invoke guest code, or alter an existing object.

## Terms

Existing literal/input/ref/project, primitive operation, lazy select/and/or/
coalesce, and numeric fold terms retain their meanings. New forms are:

| Form | Fields and meaning |
| --- | --- |
| `bound` | `depth`, `index`: a lexical value from an enclosing binder; zero is the innermost binder. |
| `default_undefined` | `args: [value, fallback]`: evaluate fallback only for the undefined tag. |
| `get` | `object`, `key`: evaluate object before primitive key, then read ordinary own data; unsupported inherited behavior refuses. |
| `array` | `items`: evaluate in order and allocate a fresh dense array identity. |
| `object` | `properties: [{key, value}]`: evaluate in order and allocate a fresh ordinary data identity. |
| `let` | `bindings`, `body`: one lexical scope, sequential eager bindings; binding i can reference only bindings 0 through i−1. |
| `traverse` | `mode`, `input`, `initial`, `callback`, `profile`, `order`, described below. |

Every structure has an exact field set. Extra fields, invalid identifiers,
future references, accessor records, proxy records, malformed arrays, cycles,
and exceeded budgets are rejected before running the semantic operation.

Traversal uses `profile: 'dense-primitive-array/1'` and `order: 'ascending'`.
The input must be an ordinary, dense array with only length and own scalar
entries, at most 128 elements, no accessors, custom iterator, proxy, extra
properties, or custom/null array prototype. `dense-number-array` inputs add the
existing finite Number element guard. The initial value is mandatory for fold
and scan and exactly null for other modes.

A callback is `{arity, body}`. Fold/scan use arity 4, binding accumulator,
element, index, and input array. Other modes use arity 3, binding element,
index, and input array. Unused parameters do not change the operation identity.
The body is checked pure core meaning, not executable source or a callable
host function. Enclosing lexical values are reachable by greater `depth`.

| Mode | Result and stopping behavior |
| --- | --- |
| fold | Final accumulator; initial value when empty. |
| scan | New array of the accumulator after each step; empty array when empty. |
| map | New array of callback results, in input order. |
| filter | New array of original items whose callback result is truthy. |
| find | First matching original item; undefined if absent. |
| find_index | First matching index; −1 if absent. |
| some | Stop at the first truthy result; false on empty input. |
| every | Stop at the first falsy result; true on empty input. |

The evaluator preserves ordered Number operations, signed zero, nonfinite
results, primitive concatenation, BigInt exceptions, and lazy paths. It never
reassociates arithmetic. A narrower source-certified profile may reject BigInt
or potentially throwing callbacks before execution; the generic core does not
rewrite such failures to an invented scalar value.

## Current qualification

Core tests cover every traversal mode, empty and rounding-sensitive inputs,
lexical capture, eager aliases, early stopping, defaults, forged claims,
nonobserving malformed-data rejection, and allocation/work bounds. Source
lowering and source-correspondence tests are maintained with the recognizer.
Native consumption and full model cost/comprehension require exact v8 receipts;
this document alone does not admit data or promote the production default.


## Source lowering and qualification boundaries

`lowerJavaScriptV8({source, entry, inputTypes})` recognizes explicitly strict,
closed synchronous functions. The recognizer covers arbitrary ordered numeric
fold steps, multiple private accumulators, pure array callbacks, immutable
captures/helpers, scalar mutable branch joins, logical assignment, defaults,
ordinary property bindings, and lazy optional reads. It preserves live input
aliases and fresh returned object identities through eager lexical bindings.
Source names become input positions or lexical binder positions, not data keys.

The source tests compare these cores to independent V8 execution over empty,
signed-zero, rounding-sensitive, nullish, aliasing, and ordinary finite inputs.
Owned-source admission is also required for supported runtime/frontend slices.
Existing owned gaps (at this commit: find/findIndex/every, parameter patterns,
logical-assignment source receipts, and a helper inside a retained array
callback) remain separate admission failures; accepting source into a pure core
does not bypass those checks. Shared mutation, accessors/proxies, arbitrary
receivers, sparse traversal, uncaught callback control, and resource overflow
retain detailed fallback dispositions.
