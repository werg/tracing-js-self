# Owned construction profile

Ordinary user function construction now evaluates the callee and arguments in
order, obtains its live owned prototype, allocates an owned receiver, and calls
the constructor body in an owned frame. Parameter defaults and inherited
method/accessor behavior use the existing machinery. An explicit object return
replaces the receiver; a primitive return leaves the receiver as the result.
Throws preserve an escaped receiver and follow normal completion routing.

Default function prototype objects are materialized on the first construction
or prototype read. Their constructor back-reference retains the function's
identity and is nonenumerable. Replacing a function's prototype affects later
constructions. A nonobject prototype selects the ordinary Object prototype.
Arrows, async functions, generators and concise methods reject construction.
Constructor spread, general function reflection/call adapters and
nonordinary prototype objects are separate unsupported domains.

The runtime checks agree with independent V8 execution and replay in
`test/training-constructors.test.js`. General public/native qualification is
still open: the old detailed allocation vocabulary lacks prototype and data
descriptor state. A scalar own-property constructor example may project, but
that does not prove general constructor/prototype semantics; prototype-method
and escaping-instance examples retain projection refusal. The separate
`ordinary-user-constructors` frontier row therefore remains unsupported for the
full detailed/native family until that representation is provided.

Semantic reference: [ECMAScript 2026 ordinary function [[Construct]](https://tc39.es/ecma262/2026/multipage/ordinary-and-exotic-objects-behaviours.html#sec-ecmascript-function-objects-construct-argumentslist-newtarget).

## new.target and lexical constructor context

`new.target` now reads the actual retained constructor frame identity. An
ordinary call returns undefined. Constructor aliases preserve the identity of
the invoked target; parameter defaults can observe it. Field initializers run
in their own owned functions and therefore observe undefined.

An arrow created in a constructor retains `lexicalThisFrameId`, linking to that
constructor's owned frame instead of copying a construction context into a host
closure. Arrow invocation records `thisBindingFrameId`; `this` and `new.target`
reads resolve through that frame, even after the constructor completes. Nested
arrows preserve the same identity. Ordinary nested functions establish their
own context. This retained binding will also represent the initially
uninitialized receiver of a derived constructor.

Owned normal calls, array callbacks, accessor functions, Proxy traps, Promise
callbacks and host/timer callback adapters now consistently select lexical
arrow receivers. `src/receiver-validation.js` checks the capture/continuation
linkage and observed receiver/newTarget value without invoking the runtime.
Tests cover direct construction, defaults, nested arrows, callback/getter/trap
use, JSON restoration after constructor return and a forged captured frame.
Public old-format construction qualification remains unsupported.
