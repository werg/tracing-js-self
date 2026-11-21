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
  Lexical namespace shadows are explicitly refused instead of silently
  rewriting the local object's property into an unrelated export.
- Destructuring and loop writes cannot mutate an imported live cell.
  Namespace receivers, tags, mutation, reflection, dynamic keys and escaped
  namespace values remain explicit refusals.

## Evidence and its limits

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

## Remaining work

General lexical-scope rewriting, namespace exotic identity/internal methods,
receiver calls, import attributes, dynamic loading, top-level classes and
full module declaration coverage remain open. The original-module Test262
campaign must be rerun on the published implementation with its complete
denominator; historical runner counts do not qualify these changes.
