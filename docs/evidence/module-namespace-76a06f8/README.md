# Owned module namespace increment: original failures and focused verification

Published producer: `76a06f88b744e121f0ce406bcc4a5496929f0da4`.
Exact tree: `100e9ece346e14fd65899f073cc20009b1b40b4b`.
Node reference: `v24.22.3` / V8 `13.6.233.17-node.63`.

This supplement retains the original broad failures, their assertion corrections,
the independent cyclic-module TDZ disagreement and its correction, focused
checkpoint/replay controls, and exact source commits for unpublished test trees.
The published probe independently agrees with all six native TDZ outcomes.

The integrated module selection passed 47/47 on local `0683bd3`; the separate
uncaught-freeze control passed 1/1 on local `79cd420`. The focused correction
passed 11/11. These test selections overlap and are not additive. The original
broad 134/2 and population 4/1 runs remain failures; their corrected boundary
and population selections passed 4/4 and 5/5 respectively. Before-commit working
tree assertion patches are retained explicitly. `metadata/results.json` maps
each log to its exact scope and provenance.

The actual failing source probe is `probes/probe-namespace-integrity-tdz.mjs`.
Run it with `node --experimental-vm-modules <probe> <producer-checkout>` and a
writable `TMPDIR`. Its before/after JSON retains the complete original two-module
graph and both result vectors. The published result names the exact published
commit and tree. The numeric-looking namespace export-name ordering discrepancy
between the specification and Node24 remains in the retained test source.

`source/namespace-tested-increments.bundle` preserves the unpublished source
history. Fetch the prerequisites named in `metadata/bundle-verification.txt`
from the producer repository, then verify/fetch this bundle into a local clone.
`metadata/source-identities.json` gives the exact tested commit/tree pairs.
The public repository also retains the complete published implementation.

The original missing-`/tmp` installed-package test invocation and its nine-pass
rerun with a valid `TMPDIR` are included as separately scoped environment evidence.
They remain attached to producer `9d85e30`, not this later runtime revision.

This increment does not qualify namespace state for public/source/native training
admission or host output. The original Test262 module-initialization route still
refuses observed namespaces; its bridge and the full 843-variant campaign remain
open. Plural reflection, Proxy combinations and dynamic import also remain open.
The full producer suite on published `76a06f8` was still running when this
supplement was assembled and is deliberately excluded from its pass counts.
No complete acceptance package is closed by these bounded tests.

Restore/verify every retained member with the repository's
`tools/restore-retained-evidence.py --inventory <inventory.json>` command.
The adjacent inventory verifies every compressed part and original member.
