# Declared exception observation profile

The current v5 producer can certify synchronous primitive/data throws and the
bounded `declared-error/name-message/1` profile. A guest throw is a successful
execution label of kind `throw`; it is not an oracle process failure.

For explicit `new Error(message)` and `new TypeError(message)`, the profile
observes the error's `name` and `message` as a stable data record. The runtime
owns allocation and identity. It supports scalar message conversion, catch
reads of `name`/`message`, identity equality, rethrow, synchronous call
unwinding, and return/throw replacement through `finally`. The private compiler
receipt and independent reference receipt name the exception profile.

This declaration does not claim complete ECMAScript Error objects. Stack
strings, prototype and own-property descriptors, causes, subclasses,
non-scalar message coercion, custom properties, mutation, and Error string
coercion are outside the profile. Such uses are refused. The independent
reference inspects native Error descriptors without invoking getters; it
refuses custom prototypes and extensions and never reads the stack accessor.
Errors escaping within an ordinary returned graph remain outside the ordinary
plain-data boundary.

The original source and both instrumented source runs must agree on kind,
reachable data graph, mutations, effects, and observed operations/branches.
Compilation, instrumentation, fixture broker errors, resource exhaustion,
and oracle process failures remain distinct from guest outcomes. Callback
failures and unhandled rejections are reported separately; positive admission
requires the explicit lifecycle gate, rather than silently discarding them.

Implicit engine errors (for example an uncaught parameter TDZ ReferenceError)
can already execute correctly in the owned runtime, but some still lack the
complete source-grounded v5 completion projection. They remain refusals until
that projection and exact reference comparison qualify them. No native
admission or learned accuracy is inferred from these local checks.
