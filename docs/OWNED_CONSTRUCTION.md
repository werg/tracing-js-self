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
Constructor spread, `new.target`, general function reflection/call adapters and
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
