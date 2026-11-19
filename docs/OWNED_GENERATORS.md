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

The owned heap record links `frameId` to a generator frame. Its state is one of
`initializing`, `suspendedStart`, `executing`, `suspendedYield` or `completed`.
The read-only validator checks the frame linkage, status and suspension cursor.
The full operand stack, environment/capture links and handler stack remain
serializable. A test restores a running episode from JSON immediately after a
yield and verifies byte-identical subsequent journal/state output, including a
counter proving completed work was not repeated.

`test/training-generators.test.js` also compares original and instrumented V8
outcomes, source operations/branches, source completion identity receipts,
callback use, reentrancy and generator cleanup. The runtime profile remains
bounded: async generators and `yield*` are explicitly rejected; direct generator
entry requires an ordinary consumer wrapper. General generator prototype
reflection and host transport are not implemented.

Existing detailed/native formats explicitly refuse generator identities and
continuations. Public followup requires typed retained-frame/continuation state,
shared capture identities, pending completion, resume input, yielded output and
cutoff state. A native consumer must execute those transitions and restore them;
rendering a yield label is not evidence of that capability.

Semantic reference: [ECMAScript 2026 Generator Objects](https://tc39.es/ecma262/2026/multipage/control-abstraction-objects.html#sec-generator-objects),
including GeneratorResume, GeneratorResumeAbrupt, GeneratorStart and
GeneratorYield. Cleanup uses the ordinary completion and IteratorClose
semantics documented in [OWNED_ITERATORS.md](OWNED_ITERATORS.md).
