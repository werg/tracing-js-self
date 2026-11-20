# Owned call and apply adapters

`Function.prototype.call`, `Function.prototype.apply`, and `Reflect.apply`
invoke the original owned closure through the ordinary call-frame machinery.
They preserve strict `this` values and lexical arrow receivers. The source
projector emits the existing detailed call record with the effective argument
list; no additional serving protocol, scheduler, or native builtin execution is
introduced.

The archive retains the evaluated source operands. For apply, it separately
records the `length` read followed by each indexed read. Read-only validation
checks those observations against the owned pre-call heap, the source stack,
the new closure activation, its receiver, and its positional/rest parameters.
Own or inherited user-defined `call` and `apply` properties retain ordinary
property dispatch and take precedence over the builtin adapters.

The apply slice accepts ordinary arrays and data-only ordinary array-like
objects, including holes and inherited indexed data. It uses scalar Number
conversion and integer truncation for length, with a maximum of 10,000
arguments. It does not consult `Symbol.iterator`. Function `apply` treats null
or undefined as an empty argument list; `Reflect.apply` requires an object.
Noncallable targets are rejected before reading the argument list.

Accessor/proxy argument-list reads, object coercion of length, and builtin or
host function targets remain explicit profile refusals. They are not converted
into guest exceptions or native fallback behavior. Invalid scalar argument
lists and scalar length conversions that JavaScript forbids remain guest
TypeErrors.

`test/owned-call-adapters.test.js` compares owned execution with independent
JavaScript and rejects tampered archive evidence.
`test/semantic-call-adapters-source-v8.test.js` exercises source qualification,
rechecking, and public checkpoint replay for the receiver corpus idioms and
rest-argument forwarding. These tests are local qualification evidence; native
consumer admission remains a separate gate.
