# V8 construction and private state protocol

This component adds explicit operations to the v8 shared public heap. It does
not change the v6/v7 detailed formats. `protocol-construction-v8.js` accepts
class/private operations and public values; it never receives an owned runtime
archive, event patch, bytecode instruction or whole-state target.

## Initial executable component

The first component declares callable construction capabilities, immutable
method home objects, class constructor/instance prototype links, instance/static
initializer ownership, lexical private identities, private fields/methods, brand
tests, private reads and private field writes. Each record has exact fields.
Unknown fields and values, conflicting identities, incorrect reads, readonly
private writes and wrong initializer homes reject before the shared transaction
commits.

Callable metadata lives on the existing shared closure node as `callable`, with
`constructorKind`, `classConstructor`, `homeObject`, `instanceInitializer` and
`staticInitializer`. Private elements live on the actual shared object as a
`privateElements` map, retaining element kind, value and update version. The
construction state declares private identities as `{id, owner, name}` records;
the owner is a class identity. Private identities occupy the same reserved
identity namespace as public objects and Symbols. They are never property keys
or guest scalar values.

Class linking validates the parent constructor and its instance prototype,
installs the readonly class `.prototype` property, creates its nonenumerable
constructor backlink, and sets both prototype chains. An `extends null` class
has a null instance prototype parent and the ordinary function prototype parent.
Nonconstructible methods may retain immutable home objects. Initializer records
require the matching instance or static home identity.

Private fields from two classes may have the same spelling while retaining
distinct identities on one receiver. Private methods are readonly. Brand tests
and reads do not create storage, and ordinary property reflection does not see
private elements. Private field versions advance on successful writes.

`test/protocol-construction-component.test.js` verifies exact record fields,
class descriptors and prototype relationships against native JavaScript,
private identity separation and updates, failed-transition rollback, and
forged-state rejection. The component's host interface is intentionally small;
the production shared machine supplies its own transactional staging.

## Integration gates still open

This first component is not yet a source/native qualification claim. The shared
codec/state dispatch hooks, source compiler handlers, independent source metadata
audit and C++ consumer must all be wired and exercised. Private accessor
continuations and guest brand-error completions require their own checked operations; failed
component preconditions are not substituted for guest exceptions.

## Constructor continuation component

`construct.enter` checks declared constructor capabilities, arguments, caller,
newTarget, and receiver identity. A base constructor allocates its receiver from
the actual newTarget's own prototype. A derived constructor starts with an
uninitialized receiver. The operation enters either the base field initializer
or the constructor body through the shared call scope. `construct.body` advances
only after a base initializer has returned to its caller.

`super.select` captures the live parent before argument effects.
`construct.enter` in super mode must use that captured parent and the derived
owner's newTarget. `super.bind` accepts only that completed superclass result,
initializes the lexical receiver once, and runs the derived field initializer
if present. `super.finish` proves that initialization returned with the same
receiver before the super call can complete. These operations retain frame and
call identities, never VM stack snapshots.

`construct.finish` checks the raw body completion against the constructor kind.
Base primitive returns select the allocated receiver; explicit object returns
select that object. Derived undefined returns require initialized this. The
normal result or the body's thrown value is then delivered to the parent.
`construct.target` and `construct.this` validate reads from the active invocation.
Ordinary nested calls and field initializers observe undefined newTarget.

The construction state retains frames with `id`, `parent`, `bodyInvocation`,
`activeChild`, `callee`, `newTarget`, `arguments`, `receiver`, `initialized`,
`phase`, `superParent`, and `selectedSuper`. Phases are `initialize-base`, `body`,
`initialize-derived`, or `complete`. The exact last constructor completion is
kept for super binding. All identities, phase/stack relationships, capabilities,
arguments and receiver states are checked on restoration.

The shared machine must call `assertConstructionNextV8` before every transition
so other records cannot skip a pending initializer/body/super continuation. Its
ordinary call helper must call `assertConstructionCallV8`; only this component
may enter a class constructor with the internal `{construction:true}` option.
This option is never a generated public record field.

The component tests cover actual-newTarget prototype selection, primitive return
substitution, base and derived initializer ordering, retained arguments,
checkpoint validation and rollback of false claims. Arrow lexical constructor
contexts, abrupt initializer propagation, derived invalid-return guest errors
and repeated-super guest errors remain explicit unsupported continuation
profiles here; the owned runtime supports them separately. Until their public
records exist, the source adapter must refuse those executions.

## Source identities for implicit callable bodies

Explicit constructors and methods retain their ordinary `function:<start>`
identity. Source-created bodies without a Function node use exactly
`class:<classStart>:constructor`, `class:<classStart>:instance`, or
`class:<classStart>:static`. The decimal offset is the Class node's start in the
immutable original source, without leading zeroes. An explicit constructor
precludes the synthetic constructor identity. An instance initializer exists
only for instance fields or private instance methods; a static initializer
exists only for static fields, private static methods, or static blocks.

`hasConstructionSourceCallableV8` checks that membership using a source-only
Acorn inventory. It neither grants constructor capabilities nor executes a
body. Private accessor classes are excluded from synthetic membership until
their separate protocol is implemented. The native consumer must check the same
source membership in addition to ordinary call and constructor-state guards.

## Independent class and private metadata evidence

The construction observation adapter inserts a leading static block that
registers the actual native constructor, its prototype and lexical private
brand/read functions. These readers inspect declared private fields and methods
without adding own properties or calling guest getters. Private accessors and
Proxy receivers are refused. Ordinary descriptor inspection still reports the
actual native key order, flags, values, prototype and extensibility; it does not
invent missing names, lengths or prototype identities. Anonymous declarator
class names are preserved through NamedEvaluation before static initialization.

Class, home-object and private-element annotations share the same independent
identity table as ordinary descriptor values. Each private element records its
declaring class identity, spelling, kind, placement and actual value. Repeated
evaluation of one class source and identical private spellings in different
classes remain distinct. The owned observer reads committed heap values and
class registration order from the archive without executing the runtime or
public protocol machine. The source compiler must separately validate private
versions and all retained constructor continuations.

The observer tests compare native and owned receipts for base/derived classes,
private methods, repeated class evaluation and inferred names. A changed owned
private field with unchanged completion receipts is rejected by the independent
metadata comparison. This observer is an evidence component; full source/native
qualification still requires the source adapter and registered public machine.

Pinned semantics: [ECMAScript 2026 class evaluation](https://tc39.es/ecma262/2026/multipage/ecmascript-language-functions-and-classes.html#sec-runtime-semantics-classdefinitionevaluation)
and [private element operations](https://tc39.es/ecma262/2026/multipage/abstract-operations.html#sec-privatefieldadd).
