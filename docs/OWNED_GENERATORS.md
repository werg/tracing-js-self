# Owned synchronous generators

Synchronous generator declarations, expressions and methods compile into the
same owned bytecode, lexical environments, operand stacks and completion
handlers as ordinary functions. Generator bodies never execute through native
`eval`, a host generator or a hidden JavaScript closure.

Calling a generator creates its retained frame and evaluates parameters before
returning the generator identity. A `GENERATOR_START` instruction suspends before
body evaluation. `next()` enters that retained computation; a later `next(value)`
places the sent value on its suspended operand stack. `YIELD` returns an owned
`{value, done:false}` object and detaches the generator frame from its caller.
Normal completion returns `{value, done:true}` and marks the generator complete.

`return(value)` and `throw(value)` enter the existing return/throw routing logic.
They therefore execute pending `finally` clauses, can yield from cleanup, and
retain the earlier completion until cleanup finishes or replaces it. A return
or throw before the body starts completes without running the body. Calling a
running generator produces a guest TypeError. Completed next/return/throw
behavior is handled without resuming its body. A generator is its own iterable,
so the separately tested `for…of` closing path invokes its return behavior.

The owned heap record links `frameId` to a generator frame and `functionId` to
the exact called function identity. Its state is one of
`initializing`, `suspendedStart`, `executing`, `suspendedYield` or `completed`.
The read-only validator checks the frame linkage, status and suspension cursor.
The full operand stack, environment/capture links and handler stack remain
serializable. A test restores a running episode from JSON immediately after a
yield and verifies byte-identical subsequent journal/state output, including a
counter proving completed work was not repeated.

`test/training-generators.test.js` also compares original and instrumented V8
outcomes, source operations/branches, source completion identity receipts,
callback use, reentrancy and generator cleanup. The runtime profile remains
bounded: async generators are explicitly rejected; direct generator
entry requires an ordinary consumer wrapper. Host transport, dynamic
`GeneratorFunction` construction and unowned exotic prototype access remain
explicitly outside this profile.

## Function and instance prototype identity

A generator function owns actual `length`, `name`, and `prototype` properties
in that order. Name and length are nonenumerable, nonwritable and configurable;
prototype is nonenumerable, writable and nonconfigurable. Declared and inferred
names, Symbol method names, default/rest arity and class/private method naming
come from source evaluation. `generatorFunction:true` and
`nonConstructible:true` describe the function's callable capability, and its
initial internal prototype is `GeneratorFunction.prototype`.

Each function gets a distinct ordinary prototype object, initially empty and
inheriting `Generator.prototype`. It has no constructor backlink. Each call
reads the function's current own `prototype` value and stores the resulting
prototype identity on the new generator. An object replacement is retained by
identity; a primitive replacement uses the intrinsic `Generator.prototype`.
Existing instances retain their earlier prototype when the function property
changes. Unsupported exotic replacements and prototype accessor continuations
refuse explicitly. Property lookup follows the actual chain, so replacing it
with an unrelated ordinary object can remove `next`; inherited ordinary getters
run through the same owned call mechanism with the original receiver.

The intrinsic chain is explicit: `GeneratorFunction.prototype` inherits
`Function.prototype`, while `Generator.prototype` inherits `Iterator.prototype`,
which inherits `Object.prototype`. The first two generator intrinsic objects
are ordinary noncallable objects. The iterator identity method is shared with
builtin array/string iterators. `Object.getPrototypeOf`, own keys, own
descriptors, `instanceof`, and nonconstructibility checks observe this state.
No host generator object supplies any owned step.

`test/training-generator-prototypes.test.js` compares these behaviors with
independent V8 execution and source operation/branch receipts. Mutation tests
reject changed descriptor flags, an invented instance prototype, and a lost
callee identity. Generator source/public admission remains separate until its
typed continuation component and independent metadata observer are qualified.

Existing detailed/native formats explicitly refuse generator identities and
continuations. Public followup requires typed retained-frame/continuation state,
shared capture identities, pending completion, resume input, yielded output and
cutoff state. A native consumer must execute those transitions and restore them;
rendering a yield label is not evidence of that capability.

Semantic reference: [ECMAScript 2026 Generator Objects](https://tc39.es/ecma262/2026/multipage/control-abstraction-objects.html#sec-generator-objects),
including GeneratorResume, GeneratorResumeAbrupt, GeneratorStart and
GeneratorYield. Cleanup uses the ordinary completion and IteratorClose
semantics documented in [OWNED_ITERATORS.md](OWNED_ITERATORS.md).

## Delegated synchronous yield

`yield*` acquires the owned synchronous iterator, caches `next` once, and runs
its protocol using visible property reads and calls. The first `next` receives
one explicit `undefined` argument; later normal resumes forward the sent value.
A done result supplies the yield expression value. A non-done result is yielded
by its exact identity without eagerly reading `value` or manufacturing a
replacement result object. Getter counts and identity are independently tested.

A delegated suspension marks its retained frame. Generator next/return/throw
resumption then records the requested kind and value in `delegateResume`,
instead of prematurely unwinding the outer function. The bytecode consumes that
record once, retrieves a fresh `return` or `throw` method when needed, and
forwards the receiver and value. A return method can yield a non-done result and
continue delegation. A done return result returns its value from the outer
generator through ordinary finally handling.

When `throw` is missing, the delegate is closed with a normal completion and
then a guest TypeError is raised. A cleanup getter/call/nonobject-result failure
takes precedence over that missing-method error. Missing `return` propagates the
received return value. Iterator acquisition, next and done failures do not
invent a close call. This follows
[ECMAScript 2026 YieldExpression evaluation](https://tc39.es/ecma262/2026/multipage/ecmascript-language-functions-and-classes.html#sec-generator-function-definitions-runtime-semantics-evaluation).

`test/training-yield-delegation.test.js` covers nested generators, arrays and
Unicode strings, lazy result accessors, argument counts, cleanup precedence,
source completion receipts and JSON restoration at a delegated suspension.
The read-only generator event validator checks exact yielded result identity,
unchanged suspended cursor/stack, intact forwarded completion and single
consumption; a corrupted resume kind is rejected. This remains an owned/runtime
capability, separately recorded from unsupported old detailed/native formats.
