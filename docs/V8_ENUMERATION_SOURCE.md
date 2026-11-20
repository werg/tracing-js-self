# Ordinary value enumeration and source map expansion

The direct v8 source compiler supports `Object.entries` and `Object.values`
on owned ordinary objects and arrays with data properties. Enumeration uses
the existing `property.keys` operation to check own enumerable string-key
order. Each selected value then receives an explicit `property.get`.
Entries allocate fresh two-element arrays while retaining the original value
references. Symbols, nonenumerable properties, and inherited properties do
not enter the result.

The result array first contains the checked key list and is then populated
with values or entry pairs. These are public lowering steps within the same
owned source operation; the complete shared result is checked against the
owned heap before the next source operation. No native property enumeration
is used by serving.

The `ordinary-array-map-source/1` producer adapter expands bounded dense
ordinary `Array.prototype.map` calls into the existing public property reads,
owned closure calls, returns, and result writes. Every callback receives its
actual value, index, source-array identity, and `thisArg`; arrow functions
retain their lexical receiver. Callback closure cells remain shared. The
adapter independently checks the private continuation at each source event,
including the original callback, fixed initial length, next index, waiting
frame, and result identity.

No new public record or checkpoint fields are required. During a callback,
the public call stack and shared heap retain the original function and the
partially populated result. Between callbacks, all earlier reads and writes
are already committed. The next callback uses another checked input read.

The declared map slice requires an ordinary prototype, unchanged builtin map
and species selection, dense own data elements, and at most 4,096 elements.
Mutating the source array during a callback, accessor elements, custom
species/prototypes, and abrupt callback completion remain explicit source
refusals. Other callback-local data work and shared closure-cell writes use
the ordinary source operations.

`test/semantic-enumeration-source-v8.test.js` independently checks source
outcomes and metadata, own-key ordering, shared references, callback arguments
and captures, nested map calls, source refusals, and checkpoint replay between
callbacks. The frozen `Object.entries(object).map(pair => pair[0])` idiom now
uses this path. Native consumer admission remains a separate gate over the
unchanged public operations.

## Stable ordinary for-in

The `ordinary-for-in/1` source and public machine profile owns bounded
`for...in` enumeration over ordinary objects, arrays, and primitive values.
`enumeration.create` derives the complete key/prototype snapshot from the
shared heap. Own integer keys precede other string keys; prototype levels are
visited in order; a nonenumerable own key shadows the same inherited key;
Symbol keys are omitted. Primitive strings contribute UTF-16 index keys.
Other primitive sources, including `null` and `undefined`, are empty.

`enumeration.next` checks the current key/prototype structure against that
snapshot, selects the next key, and allocates the exact `{value, done}` result
identity. The cursor, its snapshot, position and completion flag stay in the
same public heap as the loop body. Value writes, body calls, nested loops,
`break`, `continue`, `return` and primitive throws retain their ordinary
source semantics. `property.hasOwn` checks the current own descriptor without
invoking a getter or consulting prototypes; it represents the common filter
that keeps only own keys from a prototype walk.

The profile permits at most 128 prototype levels and 4,096 distinct keys.
Functions, callable prototype-chain members, Proxies, complex loop binding
patterns, and mutable enumeration semantics remain explicit refusals. A
changed key set, enumerability or prototype causes the next cursor step to
refuse. A checkpoint immediately after such a write remains a legitimate
prefix, including a loop that then breaks. Restore validates the stored
snapshot's shape, key order, shadowing, links and cursor bounds; exact public
prefix replay binds its provenance. The next step checks the live structure.

Independent native observations inspect descriptors without invoking getters
and record each key actually yielded by the source's own `for...in` loop. The
observer does not use the owned runtime or public enumeration evaluator.
Snapshots and yielded keys are compared even when the loop discards its keys
and returns an unchanged scalar. Source tests cover the eight frozen own-key
inputs, descriptor/prototype shadowing, lexical shadowing, abrupt exits,
checkpoint continuation, false-key rejection and explicit mutation refusals.
The paired native consumer must independently replay these new records before
an expanded source artifact can be admitted for production training.
