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

Implicit guest faults, including parameter and body TDZ ReferenceErrors, now
allocate one owned error identity at the faulting source operation. The same
value follows synchronous caller unwinding, catches, rethrows, finally, and
async rejection; the compiler emits its allocation before any public use.
Synchronous host rejection remains an observed delivery. Its blocked source
caller supplies the completion owner, and the witness records any subsequent
unwinding or enclosing async rejection without converting the host result into
a generated value.
Primitive-only `BigInt(...)` conversion also retains its actual TypeError,
RangeError, or SyntaxError name/message. `Number(...)` and `BigInt(...)` support
bounded primitive conversion and preserve argument evaluation order. Object
conversion remains an uncaught profile refusal; it never invokes native
ToPrimitive or substitutes a catchable language error for unsupported behavior.
An expression that throws contributes no successful-value instrumentation
receipt. Independent original and instrumented source checks still require
exact observable name/message agreement. Unsupported error messages or richer
Error behavior remain refusals; no broad engine-error compatibility, native
admission, or learned accuracy is inferred from these local checks.
