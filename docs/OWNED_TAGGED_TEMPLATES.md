# Owned tagged template sites

The strict training frontend now evaluates tagged templates through ordinary
owned invocation. It evaluates the tag reference once, retains a member/private
receiver, retrieves the site's template object, evaluates substitutions from
left to right without string coercion, and calls the tag with those values.
A substitution throw prevents the call. This is distinct from untagged template
substitution, which has its own string-conversion operation.

The owned realm retains `control.a0.templateObjects`, indexed by source site.
Repeated calls and different closures created from the same source site receive
the same cooked array and raw array. Distinct sites have distinct identities.
The first access records both arrays in the heap, including invalid escape
sequences whose cooked value is `undefined` while the raw string is preserved.

Both arrays are nonextensible. Index properties are enumerable, readonly and
nonconfigurable; length is nonenumerable, readonly and nonconfigurable. The
cooked array's `raw` property has those same three flags. Ordinary reads,
`Object.isFrozen`, and owned ordinary `Object.getOwnPropertyDescriptor` expose
the modeled state. Indexed/length/extra-property writes and mutators that must
write reject with guest TypeError. A one-element `reverse` remains a valid
no-op. Frozen-array sorting and general data-descriptor redefinition remain
explicit execution refusals pending their ordered continuation semantics.

`src/template-validation.js` independently checks first allocation, cached
identity, raw/cooked values, descriptors, nonextensibility and frozen-storage
immutability. Source operation instrumentation treats a tagged quasi as tag
syntax, avoiding an inserted capture between the tag and backtick. Source
completion instrumentation observes the returned tagged call. The tests compare
those independent receipts, reference results, restore from JSON mid-run, and
reject corrupted frozen contents.

Public v6/v7 projection remains unsupported for this family because descriptors,
nonextensibility and realm template identity are not represented there. A scalar
return does not permit projecting away frozen state. The separate v8 source
projection guard enforces this boundary until a public template-state interface
is added; the owned/archive implementation does not widen old contracts.

The pinned semantic reference is
[ECMAScript 2026 GetTemplateObject and tagged-template evaluation](https://tc39.es/ecma262/2026/multipage/ecmascript-language-expressions.html#sec-gettemplateobject).
