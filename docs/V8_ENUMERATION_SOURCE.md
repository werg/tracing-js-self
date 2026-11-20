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
the ordinary source operations. General mutable for-in cursors remain a
separate source boundary.

`test/semantic-enumeration-source-v8.test.js` independently checks source
outcomes and metadata, own-key ordering, shared references, callback arguments
and captures, nested map calls, source refusals, and checkpoint replay between
callbacks. The frozen `Object.entries(object).map(pair => pair[0])` idiom now
uses this path. Native consumer admission remains a separate gate over the
unchanged public operations.
