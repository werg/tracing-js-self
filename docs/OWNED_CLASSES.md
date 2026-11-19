# Owned base classes and private state

The strict training frontend accepts local base class declarations and class
expressions. Its class evaluation, construction, methods and field initializers
execute owned bytecode. No class body runs through host `eval` or an opaque
callback. `test/training-classes.test.js` compares returned graphs, thrown outcomes,
source operation/branch receipts, private assignment receipts, and archive replay
with independently executed JavaScript.

## Implemented profile

Each class evaluation creates a fresh constructor, prototype and lexical private
name identities. Public methods and accessors live on the prototype and are
nonenumerable. Public fields create enumerable own data properties without
invoking a pre-existing setter. Computed scalar and Symbol keys evaluate once,
in source order, before static initialization; the inner class name remains in
temporal dead zone until definition completes. The inner immutable name remains
bound to the class if the outer declaration binding is reassigned.

Static methods, fields, private elements and blocks use the constructor receiver.
Blocks have separate lexical/var scopes. Static initialization can throw before
the outer class declaration initializes. Constructor `.prototype` is readonly
and nonconfigurable. Class bodies are strict, class calls reject without `new`,
and concise methods/accessors are not constructors.

Construction allocates the receiver using the live owned prototype. Private
methods are installed before fields; then fields initialize in source order,
before constructor parameter defaults and body execution. Field initialization
uses a retained owned frame with an explicit `afterInstanceInitialization`
continuation. An abrupt initializer does not run the constructor body. A leaked
receiver retains exactly the fields initialized before the throw. Constructor
object returns replace the receiver; primitive returns keep it.

Private names are inaccessible hidden lexical constants. Their identities are
fresh for every class evaluation, including repeated evaluations of the same
source. Object/function records retain separate `privateSlots`, `privateKinds`,
and `privateVersions` dictionaries. Private fields are writable; private methods
are readonly and shared by instances of the same class. Reads, writes, updates,
method calls and `#name in value` check that exact brand. Proxies do not forward
private access to their targets. Reflection of ordinary keys never exposes the
private dictionaries.

`src/private-validation.js` independently checks lexical brand resolution,
private completions, readonly/brand failures, slot versions and storage writes.
Ordinary operations cannot mutate private storage. The tests also restore a
partially initialized run from plain JSON and continue it without re-running
field initialization, and reject a corrupted private-slot write.

## Qualification boundaries

The existing detailed v6/v7 formats do not describe constructor prototypes,
class descriptors, private slots or field initializer continuations. These
families remain explicitly unsupported at the detailed/native boundary even
when the owned outcome is scalar. A projection must not qualify by dropping
private or prototype state. The frontier records owned and independent evidence
separately from public/native support.

Derived classes, `super`, `new.target`, private accessors, optional private
chains, object-coercing computed keys and top-level class evaluation remain
outside this profile. Top-level entry setup currently permits static data and
function declarations; local classes execute inside their owned entry function.
General Function descriptor reflection and prototype mutation are separate
bounded profiles. This implementation makes no full-ECMAScript class claim.

## Pinned semantics

- [ECMAScript 2026, class definition and class element evaluation](https://tc39.es/ecma262/2026/multipage/ecmascript-language-functions-and-classes.html#sec-runtime-semantics-classdefinitionevaluation)
- [ECMAScript 2026, ordinary function construction](https://tc39.es/ecma262/2026/multipage/ordinary-and-exotic-objects-behaviours.html#sec-ecmascript-function-objects-construct-argumentslist-newtarget)
- [ECMAScript 2026, InitializeInstanceElements and private operations](https://tc39.es/ecma262/2026/multipage/abstract-operations.html#sec-initializeinstanceelements)
