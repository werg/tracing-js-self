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
descriptor state. Construction retains projection refusal even for a scalar
result when the projector cannot represent its prototype/receiver state. The separate
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
own context. The same retained binding represents the initially uninitialized
receiver of a derived constructor.

Owned normal calls, array callbacks, accessor functions, Proxy traps, Promise
callbacks and host/timer callback adapters now consistently select lexical
arrow receivers. `src/receiver-validation.js` checks the capture/continuation
linkage and observed receiver/newTarget value without invoking the runtime.
Tests cover direct construction, defaults, nested arrows, callback/getter/trap
use, JSON restoration after constructor return and a forged captured frame.
Public old-format construction qualification remains unsupported.

## Ordinary derived construction

Local classes can extend an owned constructible function or class, or `null`.
Class evaluation retains separate constructor and instance prototype chains;
static inheritance reads data and accessors using the actual derived receiver.
The class name stays in temporal dead zone while its heritage evaluates. Invalid
primitive heritage and nonconstructible functions throw guest TypeErrors.

A derived frame starts with `constructKind: "derived"`, `constructorId`, the
actual `newTarget`, `constructorArguments`, and `thisInitialized: false`.
`super()` obtains the live parent constructor, runs it with that same newTarget,
then executes a separate `SUPER_BIND` transition. That transition initializes
the lexical receiver and starts derived field initialization before the super
call completes. The retained initializer has `superInitializedResult`, so JSON
restoration resumes the pending completion without repeating initialization.
Default derived constructors forward their original arguments. Explicit super
calls permit the existing bounded dense-array/string spread profile.

Base fields initialize before base parameter defaults. Derived parameters run
before super, and derived fields initialize after the superclass returns its
object. Private identities remain separate across base and derived classes.
An explicit superclass object return becomes the derived receiver, including
ordinary arrays and functions. Owned instance prototype allocation uses the
actual newTarget through multiple levels of inheritance.

Reading `this` before initialization throws a guest ReferenceError, including
through an arrow retained before super. A repeated super call runs the parent
again and then throws when rebinding this. A derived constructor can return an
object before super; returning undefined requires initialized this, and returning
another primitive throws a TypeError after finally handling. Arrow super calls
resolve the same retained constructor binding. Changing a class constructor's
internal prototype affects its next super call.

`src/construction-validation.js` independently checks constructor/newTarget
identity, receiver initialization transitions, initializer continuations and
uninitialized-this failures. `test/training-derived-construction.test.js` checks
outcomes and source operation/branch receipts against V8, checks independent
completion receipts, restores a suspended initializer, and rejects a forged
super binding. This is an owned execution profile, not old-format public/native
qualification.

Super property reads/writes, builtin or Proxy heritage, private accessors and
top-level class evaluation remain outside this slice. Intrinsic heritage is
explicitly refused instead of misreported as a guest error. Spreads with an
overridden iterator are refused before a bounded-array shortcut can bypass the
protocol. Unmodeled exotic returned objects are similarly refused when field or
private initialization would require missing internal methods.
