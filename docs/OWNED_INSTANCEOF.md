# Owned instanceof and Symbol.hasInstance

The strict frontend evaluates the left operand and right operand once, in that
order. It requires an object on the right, retrieves `Symbol.hasInstance` with
owned property/getter semantics, invokes a present method with the right-hand
receiver and left-hand value, and applies ToBoolean to the result. Nullish hooks
use the ordinary callable fallback. Noncallable hooks and invalid right-hand
operands produce guest TypeErrors; getter/method exceptions propagate normally.

Ordinary functions expose the inherited owned `Function.prototype.hasInstance`
method. It checks live constructor prototype identity and walks the owned
prototype chain without host evaluation. The primitive candidate fast path
precedes prototype validation, matching arrow functions and constructors with a
primitive `.prototype`. Object/Array intrinsic prototype chains are included.
Class static methods or accessors can define custom hooks. Strict assignment to
an absent own function hook cannot overwrite the inherited readonly method.

`test/training-instanceof.test.js` compares independent outcomes and source
operation/branch receipts for constructor prototype replacement, null-prototype
objects, classes, custom/getter/inherited hooks, truthy object results, receiver
identity, evaluation order, throws and primitive near-misses. Direct calls of
the inherited method also preserve its noncallable-receiver false result.

Proxy GetPrototypeOf, bound functions, and default prototype walks for exotic
intrinsic constructors remain explicit execution refusals. Their absence is
not replaced by guessed false results. General public/native qualification
requires the Symbol/prototype state interfaces; the existing v6/v7 formats are
not widened by this runtime profile.

Pinned references:
[ECMAScript 2026 InstanceofOperator](https://tc39.es/ecma262/2026/multipage/ecmascript-language-expressions.html#sec-instanceofoperator)
and [OrdinaryHasInstance](https://tc39.es/ecma262/2026/multipage/abstract-operations.html#sec-ordinaryhasinstance).
