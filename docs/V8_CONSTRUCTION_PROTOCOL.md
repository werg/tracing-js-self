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
audit and C++ consumer must all be wired and exercised. Constructor execution,
super binding, retained constructor/newTarget context and initializer completion
transitions are the next component slice. Private accessor continuations and
guest brand-error completions also require their own checked operations; failed
component preconditions are not substituted for guest exceptions.

Pinned semantics: [ECMAScript 2026 class evaluation](https://tc39.es/ecma262/2026/multipage/ecmascript-language-functions-and-classes.html#sec-runtime-semantics-classdefinitionevaluation)
and [private element operations](https://tc39.es/ecma262/2026/multipage/abstract-operations.html#sec-privatefieldadd).
