# Sparse and live Array map source projection

The ordinary array map source adapter uses the existing public property, call,
return and throw operations. It retains the original length and result identity,
then examines each index in the current owned array immediately before invoking
the next callback. A callback can change a later value, fill a later hole, shorten
the input or append elements. Appended elements beyond the original length are
not visited. Shortening the input does not shorten the allocated result.

A missing index emits a checked `property.hasOwn` false record and leaves the
matching result index absent. An own element whose value is `undefined` still
invokes the callback. Existing dense projections do not gain redundant records;
their property reads and callback arguments are unchanged. Array mutation is
represented by its existing checked public writes before the next visit. No
callback output or future input value is used to predict the continuation.

The same adapter participates in the shared Promise/protocol projection. Every
event still has one owner, and failed source-event validation rolls back the
public state and retained adapter state together. A checkpoint after a callback
mutation retains the public array shape and original result. Recovery consumes
the remaining public operations, including any checked holes, without running
an already completed callback again.

## Evidence and boundaries

Focused tests compare original source behavior, recheck source evidence and
recover from JSON checkpoints. A substituted own-property claim must fail
without changing the live state. Cases cover holes versus undefined, all-hole
inputs, generator callbacks, nested maps, filled holes, changed later elements,
length truncation, appends and Promise composition. The recurring qualification
population adds `map-sparse-live-mutation` and `promise-map-sparse-truncate`.
Independent native admission and token costs remain separate measured gates.

The profile still requires an ordinary array and the original map/species
selection at entry, a bounded initial length of at most 4096, and synchronous
owned callbacks (including generator creation). Indexed accessors, changed
prototypes and custom species are not admitted by this increment. Those need
their own observable lookup/construction continuations; a hole cannot be
silently treated as absent in a prototype chain with inherited indexed values.
