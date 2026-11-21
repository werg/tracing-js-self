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
