# Owned super references and home objects

Local class methods, accessors, constructors, private methods, field initializers
and static blocks retain an owned home object. Object literal methods/accessors
that use super retain their literal object. `homeObject` is an immutable identity
on the function record; a dedicated lexical environment binds it as an
inaccessible constant. Nested arrows capture that environment, including after
the original method returns. Borrowing a method changes its actual receiver but
preserves the definition's home object.

The compiler evaluates `this`, then a computed key, then creates a serializable
`superreference` containing the live home object's prototype, actual receiver,
and unevaluated-key value. Owned reads and method calls use the captured base for
lookup and the actual receiver for calls. Getter/setter continuations preserve
that receiver. Plain and arithmetic compound assignments use the same captured
reference; an inherited writable data property writes to the receiver's own
storage, without invoking an own or inherited receiver setter. Own receiver
accessors and readonly data reject that data write. Super getters without
setters reject assignment. Symbol keys keep their exact identity.

The profile supports ordinary owned prototype chains and a named subset of
Object/Array/Function prototype methods. Null super bases produce guest
TypeErrors. Proxy/exotic super bases, unknown intrinsic methods, object-coercing
keys, update/logical assignment continuations, optional super calls and
destructuring super targets remain explicit unsupported profiles.

`src/super-validation.js` independently checks immutable home identities,
lexical environment linkage, captured references, superclass selection,
accessor receivers and committed data writes. Tests compare supported outcomes,
operation/branch observations and call/assignment completion receipts against
independent V8 execution. They restore arrow home state from JSON and reject a
forged reference base. The old public formats still refuse home/prototype state;
owned execution does not itself qualify the public or native path.

## Pinned order and independent oracle limits

[ECMAScript 2026, super evaluation](https://tc39.es/ecma262/2026/multipage/ecmascript-language-expressions.html#sec-super-keyword-runtime-semantics-evaluation)
selects a super constructor before evaluating arguments, and
[MakeSuperPropertyReference](https://tc39.es/ecma262/2026/multipage/ecmascript-language-expressions.html#sec-makesuperpropertyreference)
captures its base when the left reference is evaluated. This runtime follows
those orders. For a plain assignment, property-key coercion is still deferred
until PutValue; this slice admits scalar/Symbol keys only.

Node v24.22.3's V8 currently selects the parent after argument effects and the
super-assignment base after RHS effects. Both differences are directly reproduced
by `test/training-super-properties.test.js`. The constructor discrepancy also has
an upstream [V8 report](https://issues.chromium.org/issues/42208984).
The tests verify the pinned specification result, separately execute the native
reference, and explicitly report its known disagreement. These two cases are
not reference-qualified, and a source gate must retain `reference_mismatch`
until a suitable independent oracle agrees. They must not be counted among the
ordinary super fixtures with successful independent comparison.
