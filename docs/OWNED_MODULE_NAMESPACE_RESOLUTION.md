# Bounded original-module namespace resolution

The evaluated-module lowering now separates three export-resolution outcomes:
a binding, a missing/circular path, and an ambiguous result. It follows the
retained ECMA-262 17th-edition
[ResolveExport](https://tc39.es/ecma262/2026/multipage/ecmascript-language-scripts-and-modules.html#sec-resolveexport),
[GetModuleNamespace](https://tc39.es/ecma262/2026/multipage/ecmascript-language-scripts-and-modules.html#sec-getmodulenamespace)
and
[InitializeEnvironment](https://tc39.es/ecma262/2026/multipage/ecmascript-language-scripts-and-modules.html#sec-source-text-module-record-initialize-environment)
algorithms. The exact specification bytes and digest are retained in
`artifacts/conformance/ecma262-17.0-index.html.xz` and its adjacent manifest.

## Delivered behavior

- Missing and ambiguous static namespace properties read `undefined`.
  An explicit named import or indirect export of the same name still fails
  linking, even when unused. `void 0` preserves the missing value when a
  guest lexical binding shadows the identifier `undefined`.
- An ambiguous star resolution stays ambiguous through another star graph.
  A later path cannot replace it with one of the conflicting bindings.
  Recursive star visits share the visited module/name pairs to bound cyclic
  and diamond traversal.
- `export * as cells`, local namespace exports and forwarding aliases support
  static chained reads. Their final values retain live lexical bindings,
  including reads through the retained asynchronous module scheduler.
  Direct namespace re-exports compare the target module/namespace pair;
  local namespace export bindings preserve their distinct defining origins.
- Ordinary property names are distinguished from identifier references.
  A property called `ns` does not accidentally read an imported namespace.
  A scope pass distinguishes module bindings from parameter, body-variable,
  block, loop, switch, catch, named-function and class bindings before any
  rewrite. Parameter defaults are resolved outside body variable bindings.
  Lexical namespace shadows remain ordinary local objects and preserve their
  receivers; they cannot silently read or mutate an unrelated export.
- Module `var` declarations, including ones nested in top-level blocks and
  loops, have their own renamed module cells. Repeated declarations share
  that cell and cyclic imports can read its instantiated `undefined` value.
  Nested functions and class static blocks keep their separate variable scopes.
- Destructuring and loop writes cannot mutate an imported live cell.
  Namespace receivers, tags, mutation, reflection, dynamic keys and escaped
  namespace values remain explicit refusals.

## Evidence and its limits

The original Test262 preflight now constructs static module binding records
directly from the original parsed source, without compiling an evaluated
entry. It resolves named and quoted imports, local/indirect exports, namespace
re-exports, star diamonds, cycles and destructuring-export bound names. Every
explicit import/indirect export is checked even when unused. The runner profile
records `staticResolution: "original-module-records/1"` and campaign
fingerprinting includes the resolver's actual source bytes.

This removes the old blanket refusal for any star or forwarding declaration.
A resolution-negative test can pass only when this source-only phase finds
a real missing or ambiguous binding; a later owned parser/compiler refusal
cannot satisfy it. Supported valid graphs continue into actual owned
evaluation with the original harness. Resolution of an unimplemented body,
such as a destructuring module declaration, does not claim that the body can
execute. Quoted external names are now also supported by the evaluated
lowering; local bindings still use source identifiers.

`test/evaluated-module-namespace.test.js` executes original source graphs with
Node's native ESM loader independently of the owned lowering. Missing values,
direct ambiguity, same-origin ordinary binding diamonds, live namespace
forwarding and alias chains run in both concatenated and retained-scheduler
representations. Each owned result is structurally validated and exactly
replayed. Other controls prove link-time refusal of invalid or unrepresented
uses without running module effects.

Two additional cases are **specification controls, with separately reported
native-reference outcomes**. Node 24.22.3 disagreed during implementation:

| Original graph | Retained specification / owned result | Observed Node 24.22.3 result |
| --- | --- | --- |
| A barrel first stars an ambiguous `x`, then stars a leaf exporting `x=1`; its namespace is read. | The nested ambiguous result propagates; `ns.x` is `undefined`. | The native loader returned `1`. |
| Two modules each `export * as cells` from the same leaf; a barrel stars both and imports `cells.x`. | Both resolutions identify the same target module and namespace binding; the read is `23`. | The native loader threw `SyntaxError` for conflicting star exports. |

The test diagnostics record the exact Node/V8 versions, original reference
return or throw, expected value and `nativeDifferential` result. The owned
specification assertion can pass while that native result is **failed**.
Neither discrepancy is counted as a successful native differential. A future
engine which matches the normative result will instead report a native pass.

These checks exercise owned original-source lowering. They do not qualify
first-class Module Namespace Exotic Objects, complete original-source
correspondence, public V8 transitions, independent Python replay, data
admission, a full Test262 campaign or complete ESM conformance. The new
scheduler cases retain the scheduler's existing public-admission refusal.

`test/evaluated-module-bindings.test.js` separately compares original ESM for
lexical shadows, hoisting, parameter defaults, lexical and parameter TDZ,
destructuring, switches, loops, named functions/classes and local receivers.
The combined shadow graph runs through both evaluation representations.
A suspended owned async call also restores its captured local namespace-like
object and mutable shadow cell from JSON and produces the identical complete
archive without rebinding the actual module import.
Original-source controls also distinguish identically named block/loop vars
in independent modules and cyclic reads before a var export's evaluation.

## Host module loader boundary

Original static module requests carrying import attributes, or targeting source
types outside the declared JavaScript profile, are `environment_unavailable`
until their host loader is implemented. The owned preflight must not parse
JSON, text or binary module bytes as ECMAScript and then call a missing export
or parser error a successful resolution-negative test. Entry parse expectations
are checked first, before dependent loader capabilities.

The native reference also checks attributes supplied to Node's static-link
and dynamic-import callbacks. A VM `SourceTextModule` callback is the host
loader boundary; ignoring those attributes can silently reinterpret a typed
request as ordinary JavaScript even when every source byte is pinned. See the
[Node VM callback contract](https://nodejs.org/download/release/v24.22.1/docs/api/vm.html#modulelinklinker).
Dynamic refusals retain `executionPerformed: true` when the original module
body already started, including when guest code catches the request error.
They remain unavailable-host outcomes, not successful reference executions.

This guard was identified during the full module campaign at producer
`4c1a4a42ca21fb1a958b2ed9305372c04833fe3a`. That earlier campaign is retained
unchanged; its typed-module failures are evidence of the missing guard, not
results for the later correction. Focused original-harness controls exercise
JSON/text bytes, attributed requests for `.js` files, resolution negatives,
parse-negative ordering, static re-exports and caught dynamic imports.

## Remaining work

Namespace exotic identity/internal methods,
receiver calls, import attributes, dynamic loading, top-level classes and
full module declaration coverage remain open. The original-module Test262
campaign must be rerun on the published implementation with its complete
denominator; historical runner counts do not qualify these changes.
