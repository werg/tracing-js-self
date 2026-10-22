# Pinned engine262 source inventory

`coverage/engine262-inventory.json` makes the **source-discovered denominator**
explicit at upstream commit `2d7d8d988c77e94473ba0377122cdfccdfe243ba`, tree
`b8d38453eb58fdcee168fddd839d05cc60e1eeb4`. The exact commit remains controlled by
`profiles/targets.lock.json`. This inventory does not execute engine262 and does
not introduce it as a tracing backend.

| Discovered category | Count | What is counted |
| --- | ---: | --- |
| Tracked `src/` files | 377 | Every tracked blob, including 375 TypeScript modules, one configuration file and one placeholder |
| Named function declaration candidates | 2,028 | Column-zero declaration lines; overloads count separately |
| Specification references | 1,845 | Distinct literal `https://tc39.es/` URLs with fragments, including proposal references |
| Intrinsic name literals | 157 | Distinct quoted, percent-delimited names observed in source text |

All file identities, declaration locations, specification-reference occurrences
and intrinsic-literal occurrences are checked in. Each has an explicit ownership
classification and `execution: "untested"`. This field is deliberately a
**conformance-evidence boundary**: regression tests for the new arithmetic path
do not establish Test262 execution coverage for an entire source declaration or
specification clause.

## Reproduction

The offline classification check is dependency-free and runs in `npm test`:

```sh
node scripts/audit-engine262.mjs
```

It checks the schema, revision alignment, uniqueness, complete classification
and bounded ownership mappings. Its report says `upstreamVerified: false`; it
cannot independently verify source bytes without an upstream checkout.

For full regeneration and comparison:

```sh
git clone https://github.com/engine262/engine262.git /tmp/engine262-source
git -C /tmp/engine262-source checkout --detach 2d7d8d988c77e94473ba0377122cdfccdfe243ba
node scripts/audit-engine262.mjs --engine-source /tmp/engine262-source
```

The verifier requires the expected checkout revision, reads **committed Git
objects**, checks each blob hash and compares every regenerated entry. Local
working-tree edits cannot supply the reference bytes. Git replacement objects
are disabled. Missing or extra files, changed hashes, missing declarations,
changed reference locations and unclassified entries fail the audit. A successful
full comparison reports `upstreamVerified: true`.

The report never emits a JavaScript-conformance percentage. Its counts are
denominators for this extraction rule, and `completeEcma262` stays `false`.

## Updating the pin or extractor

The checked-in baseline initially classifies every unmapped source item as
`unowned`, not implemented. To inspect a changed upstream pin, update the profile
deliberately, check out that revision, and produce a separate review candidate:

```sh
node scripts/audit-engine262.mjs --engine-source /tmp/engine262-source --candidate /tmp/engine262-candidate.json
```

Only entries with unchanged discovery evidence retain previous classifications.
Added and changed entries become `unclassified`, which the verifier rejects.
Changing any source blob also invalidates classifications of declarations and
references in that file, even if their names and line numbers stay the same.
Removed mapping targets also require review. The candidate command does not
overwrite the checked-in inventory and does not assert that the candidate passed.
Do not mass-upgrade classifications to implemented merely because engine262 has
an operation with that name.

An ownership mapping must list exact entries, implementation files, an explicit
supported domain and exclusions. The initial `owned-primitive-arithmetic/1`
mapping covers **parts** of five declaration candidates and seventeen clause
references for `ApplyStringOrNumericBinaryOperator`, primitive conversion and
Number/BigInt arithmetic. Objects, Symbol conversion, full exception propagation
and all intrinsic identities remain open. No upstream source file is classified
as wholly owned by this tracer.

## What remains unproved

This is a deterministic **textual source inventory**, not a TypeScript AST,
complete specification clause index, call graph, intrinsic installation graph,
feature matrix or Test262 execution report. In particular:

- The declaration rule retains overloads, excludes methods, anonymous functions,
  arrows and non-column-zero declarations, and may include text in comments that
  matches its declared rule. Clause-reference occurrences separately capture
  annotated methods, without inferring an algorithm mapping.
- Literal specification links can be stale or refer to proposals. A link does
  not establish that the corresponding algorithm is implemented correctly, nor
  that every current normative clause has a source annotation.
- Intrinsic literals include references and declarations. Computed/template
  names and all reachable property names are not expanded. No claim of a complete
  ECMA-262 intrinsic identity catalog follows from the 157-item list.
- `partial-owned` means the specified domain has an in-repository owned phase
  implementation. It does not mean the upstream generator or its continuation
  has been serialized, and it does not pass the full engine-substitution gate.

The remaining migration gates in [the adoption audit](ENGINE262_ADOPTION.md)
still require a complete normative clause/intrinsic mapping, semantic coverage,
owned continuations beyond this first path, independent conformance execution,
host ownership, and release acceptance.
