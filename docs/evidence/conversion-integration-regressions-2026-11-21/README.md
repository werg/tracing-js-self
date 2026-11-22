# Conversion integration: failed attempts and corrective checks

`manifest.json` records the exact uncompressed and XZ hashes for every retained
log. The original failed runs remain failures. Later scoped checks do not turn
them into a clean full-suite result.

## Complete frozen producer attempt

Local `6adcacf750273ec9fc17780cce0ff9c898f1c70b` has the identical Git tree
`c7f99a328a36bf1ee48007555ad9b85ad13d2d01` as published `042dfee`. The clean
worktree's `npm test` run reports **2,495 passed, ten failed and six skipped out
of 2,511 tests**, in 483.159 seconds. The chained reference fixture command did
not run because the test command failed.

| Failure group | Count | Disposition |
| --- | ---: | --- |
| Complete release-drill clone cannot fit on the local disk | 4 | Original `ENOSPC` errors retained. Complete checkout/drill requires hosted capacity; no test is disabled. |
| Archived test data omitted from sparse checkout | 2 | Materialized the exact two committed JSON files; the affected archive/gallery selection passes 12/12 at published `321935b`. |
| Public entry uses the previous contract's native policy | 2 | Policy now binds consumer `5ea3eb3` and the regenerated contract/interoperability hashes. |
| Promise-only source-profile expectations predate conversion composition | 2 | Keep original source and source/context-tamper checks; expect the composed profile for computed array accesses and explicitly verify that scalar indices emit no guest conversion continuation. |

The affected Promise/public-entry selection passes **19/19** in working
integration, zero failures/skips, in 22.650 seconds. The exact published
`321935b` reference fixtures were run separately and pass **8/8**. The six
asset-dependent skips in the original broad run remain recorded as skips; they
are not included in these passing counts.

The `e4de45e` hosted V8 interoperability job
[137005537033](https://github.com/werg/tracing-js-self/actions/runs/44956436354)
failed the byte-for-byte producer/consumer contract comparison because its policy
still selected `1ddcc61`. Its source/native/token/packing/lifecycle gates were
skipped. The subsequent exact consumer policy is a separate pushed increment.

## Installed-package and published support evidence

The installed-tool development selection first passes six bounded controls and
then **8/8** after review adds the required original-population failure gate and
independent canonical expected-value check. These use a complete small fixture
repository for npm packaging plus real public source/callback/module workers.
The actual complete producer package is 656.8 MiB before packing and cannot fit
the local free-space budget. Full **665 original / 66 selected** qualification is
required in CI; the local controls are not that full result.

Supporting native packets were regenerated and reproduced using clean published
producer `e4de45e`, with **20/20** supporting native checks passing. Their consumer
commit is `5ea3eb3`. Only two producer-revision metadata fields changed from the
prior local-pin packets; decoded public/context/source data is identical. The
first private sparse-worktree attempt lacked `catalog/operations.json`, failed
before fixture writes, and remains retained. Adding that committed catalog
allowed the exact published-pin generation.

The V8 contract generator's complete `--check` succeeds after installed tooling
is added, preserving contract digest
`75b4b47cccd0b137e00f477e45572d9d160acbb63f70af4f506e8003359e32cc` and
interoperability digest
`f5c2d5fd15ad3b84e9b17de771d2f72a58f3c7dee4969ded8a7eb9c3c449f661`.
