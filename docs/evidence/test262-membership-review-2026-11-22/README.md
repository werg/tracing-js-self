# Exact source-bound Test262 membership review

The isolated `a9591311` implementation passed **22 controls, zero failures,
errors or skips**. The compressed XML preserves the complete result, including
the deliberately refused duplicate-clause extractor case.

An independent root recheck fetched the original multiplication line-terminator
test and default `assert.js` / `sta.js` harness directly from official
`tc39/test262` revision `d53ebc8b1931d9f1541e43d59650776e4b766248`.
Their Git blob IDs and SHA-256 values match the retained pilot and full catalog.
Rebuilding the mini-catalog from those bytes reproduces its exact digest.
The current audit verifies the retained ECMA-262 17 HTML and all cited clauses.
`pilot-root-recheck.json` records the exact source revision/tree, catalog and
audit digests, two edition-classified variants of one original test, and all
unchanged false applicability/conformance claims.

Review corrected three source-evidence gaps: a referenced `_FIXTURE` file is a
valid dependency input; a non-unknown decision requires complete dependency
closure and resolved routing metadata; and the audit must hash the actual
fixture bytes, not merely compare declared hashes. Re-sealed unresolved
closures and changed fixture bytes refuse. An edition decision also cannot
require an external addition/profile obligation at the same time. Synthetic
module controls exercise those boundaries without creating new real-source
membership decisions.

The original one-file pilot remains in the edition audit evidence directory.
The full retained catalog still has 53,616 test files and 102,994 unclassified
variants; this separate pilot does not rewrite that artifact, declare either
mode release-required, execute a conformance test or certify complete edition
membership.
