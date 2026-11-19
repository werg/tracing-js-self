# Owned ordinary for-in enumeration

For-in is compiled separately from for-of. It never retrieves Symbol.iterator,
never invokes value getters to discover keys, and never calls an iterator return
method on break/return/throw. Own string keys are considered in integer-index
order followed by insertion order, then the owned prototype chain is visited.
A nonenumerable own key still shadows the same inherited name. Symbol keys are
excluded. String primitives enumerate UTF-16 index keys; null, undefined and
other scalar primitives contribute no keys.

Each loop has an inaccessible owned heap record with `kind: "enumerator"`, a
source value, a prototype/descriptor snapshot `chain`, ordered guest string
`keys`, `nextIndex` and `done`. The snapshot contains descriptors and identities,
not property values. Updating existing data values therefore remains supported.
`FOR_IN_NEXT` checks the stable key/enumerability/prototype profile before each
advance and records a result with the selected key. This first profile refuses
key additions/removals, enumerable changes and prototype changes during active
enumeration, plus Proxy/exotic enumerators. It does not silently reinterpret
those cases as snapshot enumeration.

Declared let/const bindings get a fresh environment for every iteration, and
var bindings use the surrounding function cell. Header temporal dead zone,
object binding patterns, labelled jumps and finally completion routing reuse
the owned binding/completion machinery. Leaving a loop has no iterator-close
obligation.

`src/enumeration-validation.js` reconstructs order, prototype traversal and
nonenumerable shadowing without calling the evaluator. It checks cursor
allocation, advancement and selected-key completion. Tests compare independent
JavaScript outcomes and operation/branch receipts, restore a partially advanced
cursor from JSON, and reject forged key order. Descriptor/prototype mutation
and Proxy near-misses are explicitly tested as refusals.

The current detailed/native formats lack this enumerator/cursor state. This
owned implementation does not claim their qualification; the frontier keeps
those boundaries separately unsupported pending a public enumeration interface.

Pinned reference:
[ECMAScript 2026 EnumerateObjectProperties and CreateForInIterator](https://tc39.es/ecma262/2026/multipage/ecmascript-language-statements-and-declarations.html#sec-enumerate-object-properties).
