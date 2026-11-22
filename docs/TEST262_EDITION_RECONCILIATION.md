# Reconciling Test262 references with the frozen edition

The annual ECMA-262 17th edition and the pinned Test262 checkout describe
different inventories. A test's `esid` may point to a current clause, an older
name, a draft-only addition, a grammar anchor repeated in an annex, or another
standard. Resolving that reference is useful scope evidence; it does not decide
whether the complete test belongs to the annual edition.

`tools/audit-test262-edition.mjs` reads every original test in the retained
catalog and reconciles its descriptive specification reference against the
actual pinned HTML. It preserves the catalog's variant IDs, strict/sloppy/module
modes, feature tags and existing classifications. It does not run tests, copy
execution passes, reduce the denominator, or change release requirements.

```sh
node tools/audit-test262-edition.mjs \
  --catalog artifacts/conformance/test262-d53ebc8b-frozen-catalog.json.xz \
  --suite-root /absolute/path/to/the/pinned/test262 \
  --out /absolute/path/outside/the/checkout/edition-audit.json.xz
```

The suite must be at the exact catalog commit with its original Git blobs. The
tool checks the complete acquired file inventory and the original bytes of
every test. Rehashed catalogs with missing variant modes or changed source
metadata are refused. The annual specification is independently verified
against its retained byte count and SHA-256 before HTML extraction.

The extractor uses Python's standard HTML parser. It records actual anchors,
their occurrence counts, enclosing clauses, clause ancestry, titles and
explicit normative-optional attributes. Text inside scripts and comments is
not interpreted as markup. Duplicate IDs remain ambiguous even when repeated
inside one clause. Annex ancestry is retained without assuming all annexes
share one applicability rule. `es5id` and `es6id` are retained for review but are
never guessed into current anchors.

| Reference disposition | Meaning |
| --- | --- |
| `resolved_anchor` | Exactly one occurrence of the named anchor exists in the pinned specification. |
| `ambiguous_anchor` | The same anchor occurs more than once. All enclosing clauses remain visible. |
| `anchor_absent` | No exact anchor exists; review renames and edition/addition membership. |
| `missing_metadata` | No `esid` is provided; legacy references remain visible separately. |
| `unresolved_metadata` | The reference cannot be interpreted by the conservative scalar reader. |
| `external_reference` | A URL points elsewhere or is not an exact reference to the retained page. |

The report includes all variants and a feature index with overlapping counts.
Intl tests are labeled for a separate ECMA-402 pin, Annex B paths for explicit
applicability review, and other paths for core-or-extension review. These labels
organize the work; they do not exclude tests or establish edition membership.

The summary also tallies each row's existing `classification.membership`
(`edition`, `extension`, `outside_profile`, or `unclassified`) and its explicit
`requiredForThisRelease` boolean. A scope-review-by-membership cross-tab makes
unresolved counts directly visible for the full denominator. An absent
classification still means `unclassified`; it is never inferred from paths,
feature tags, or reference outcomes. These counts report declared decisions,
not independently certified applicability, and all catalog variants remain in
the report.

The audit also reconciles unique test source files separately from execution
variants, counts execution modes, and counts ordinary versus negative expected
outcomes by phase. The source denominator uses one classification per path;
variants retain their distinct strict, sloppy, raw and module identities. The
catalog refuses duplicate variant IDs (`validateTest262Catalog`), and this audit
requires every source's declared mode set to be present, so dropping or
duplicating a variant cannot reduce the audited denominator. Every test file is
read and SHA-256 checked against the catalog before it is included.

## Full hosted audit — 22 November 2026

The push-triggered [full audit run](https://github.com/werg/tracing-js-self/actions/runs/45011367784)
checked exact Test262 revision `d53ebc8b1931d9f1541e43d59650776e4b766248`
against the retained ECMA-262 17th edition HTML (`8,348,904` bytes; SHA-256
`5df49e088c2b5c7a3dfd4a330414b92897fb4535cb62fc5936cad101a6c2304a`). The
clean producer revision was `d1b35fa850b8ef72b5eb664755cbf76233b05cc0`.
Catalog digest: `87554d6d1c4f5f2fa1f4108501148a0b6adfd2fab357383594ea3ea60aca5045`.
Audit digest: `e4538babc0ec161e1774cadfc6e53e3b2ccbcdaefbc1ba9edcaf3bd431bcec96`.

The acquired tree contains **53,616 test files and 102,994 strict/sloppy/raw/
module variants**. The mode totals are sloppy 52,065, strict 50,056, raw 30, and
module 843. Expected outcomes are 94,235 normal and 8,759 negative variants:
8,659 parse, 66 runtime, and 34 resolution. All 102,994 variants remain
unclassified for edition membership; zero are marked required for this release.
The audit leaves edition membership, applicability, and conformance claims
false. Reference review reports 58,589 exact resolved anchors, 23,474 absent
anchors, and 20,931 missing `esid` values. Scope-review labels count 1,377
Annex B, 94,853 core-or-extension, and 6,764 separate-ECMA-402 variants. These
are review counts, not exclusions or applicability findings.

The complete compressed catalog runner output, bare catalog, full audit report,
logs, toolchain record, and `SHA256SUMS` are retained in [workflow artifact
14750355381](https://github.com/werg/tracing-js-self/actions/runs/45011367784/artifacts/14750355381)
for 90 days. Artifact ZIP SHA-256:
`b1120a4da1a9227c7c1f93449f3da12b0a345fa0da1a564c3787459fd1cc631a`.

Implementation source hashes, exact producer revision, tracked and untracked
dirty status, Node version and Python version accompany the complete report.
The complete wrapper is hashed, and the deterministic reconciliation content
also has its own digest. Publish receipts from a clean committed checkout;
dirty exploratory runs retain that fact and cannot qualify a later revision.

Remaining work is to review feature semantics against the pinned clauses,
record explicit edition/addition and optionality decisions, freeze separate
host/Intl profiles where required, and then bind those decisions into a new
catalog. A resolved reference is not a conformance pass. An unreferenced clause
is not automatically untested because a test may cite a parent or omit `esid`.

## Narrow source-form review for `import-defer`

`tools/annotate-test262-scope.mjs` adds a separate review record for every
catalog variant tagged `import-defer`. It scans exact test bytes and each
catalogued module dependency that is available, with SHA-256 and Git-blob
checks. The token scan distinguishes proposal-shaped `import defer *` and
`import.defer(...)` forms from a normal default import binding named `defer`.
The annual-grammar observation is tied to the retained HTML production hashes
for `ImportDeclaration`, `ImportClause`, `ImportedDefaultBinding`,
`ImportedBinding`, `BindingIdentifier`, `Identifier`, and `ReservedWord`; the
dynamic form is tied to `ImportCall` and `ImportMeta`. In the pinned reserved
word production, `defer` is absent.

Each review record includes the original campaign parse disposition and an
interpretation of that specific attempt: a source accepted by the parser, an
expected parse-negative error, an unexpected parse error, or an unobserved
stage. This is necessary because Test262 `passed` can mean “expected
SyntaxError observed” as well as “ordinary source parsed.” The report carries
the original catalog and campaign rows and attempt histories intact. It never
changes `classification`, adds no edition-membership claim, and reports zero
removed denominator rows. A source-form observation is only a review cue; it
does not settle a test's complete edition applicability.

Replaying the retained 843-module bundle at producer `28261b8` with its exact
catalog, report, triage, consumed source files, and pinned annual HTML found
104 selected `import-defer` variants: 93 unexpected parse failures, two
expected parse-negative successes, and nine source-parse successes. The nine
include eight cases whose direct fixture dependency contains a proposal-shaped
form and one ordinary `import defer from` binding test. Across the selected
104, 103 source closures contain a proposal-shaped form and one contains only
the annual default-binding form. All 104 original statuses and unclassified
memberships remain; zero rows are removed. These figures describe the retained
historical run, not a qualification of later producer revisions.
