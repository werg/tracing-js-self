# PR #60 closeout evidence

This packet preserves the original failure observations, focused controls,
completed local and hosted release receipts, and hosted integration evidence
from the PR 60 closeout. Execution identities remain attached to their original
observations. A later evidence-only commit is not a new execution of these gates.

## Completed release and hosted observations

The [local release packet](direct-release-409e5931/README.md) records a complete
default-policy run at clean producer `409e5931` / consumer `21b7c807`, unchanged
before and after execution. All 64 sources passed source/native admission,
current-cohort authentication, original-task binding, complete preparation and
the two-update resume/export/service lifecycle. Packaging passed; restoration
then passed with the original input and package-payload locators absent. The wrong checksum refused
before creating either destination. The archive had 351 members and SHA-256
`8336b51933e6427514cf0606f1fcc1a2e0882168b79c400caf2df5e64b0edb7d`.

The hosted [direct release](https://github.com/werg/tracing-js-self/actions/runs/45151917597)
separately passed at actual producer merge `8b4cbfae` / consumer `21b7c807`.
It passed 105 Python, 140 original campaign and 11 current-population controls,
all without skips. Its complete 64-source release and 351-member restoration
passed, with archive SHA-256
`3db2ab4db811197e251c1c5e5f118d7474b3bdeb64e4b18c52c9c16622c29a69`.
[Unabridged extracted receipts](hosted/producer409-direct-receipts.json) retain
the source pairs, archive identities and exact scope. The full original job log
is retained as a reversible gzip/base64 file; the separate 359,053,551-byte
workflow artifact is identified by its [API metadata](hosted/producer409-direct-artifacts-api.json),
and is not copied into this compact packet.

The current [combined workflow](https://github.com/werg/tracing-js-self/actions/runs/45151917498)
passed all six lanes and aggregation on merge `8b4cbfae` / native `21b7c807`.
The full Node 20/22/24 jobs each passed 3,142 tests, with 95 skips and zero failures.
The original module-packing route passed on direct producer `409e5931` / native
`21b7c807`, preserving all 708 logical contexts/targets in 900 packed windows.
The current continuation route passed 218 controls without skips. The retained
original job logs and captured job API records are below `hosted/`, with their
recorded timestamps and checkout identities. The producer merge and direct head both have tree
`9dcd6fbc3d31927b1b3a419db77d8fcf9bbc38b0`.

The companion's four workflows at `21b7c807` also completed successfully. Each
CPU job passed 4,212 tests with 85 skips and 20 warnings on actual merge
`c9a295c5`. Its gallery and interoperability runs used the earlier producer
`e21651f7` / native `21b7c807`; those are separate observations, not results at
the newer producer checkpoint.

## Supersession and continuing validation

The final all-event record at `409e5931` contains **15 successful workflows and
one cancelled workflow**, with **38 successful jobs and two cancelled jobs**.
Gallery and support completed successfully within that last workflow. Its two
remaining populations were cancelled when concurrent producer commit `bbcb3c56`
arrived, rather than failing an assertion. The retained cancellation logs show
540 emitted native-admission successes out of 665 cases for the larger population,
and four out of 77 for interoperability. These are partial observations, not
completed population qualification. Their original logs and final API records
remain under `hosted/`.

The concurrent producer repair preserves source-clone pairs exactly at the
configured similarity threshold. Five affected producer control files passed
**47 tests, zero failures or skips** at `bbcb3c56`; their command record states
that only the release documentation was modified in the working tree. The
complete support cohort and registry digests remain unchanged. These scoped
controls are retained in `concurrent-bbcb-controls/`; the old release receipts
still describe `409e5931` or merge `8b4cbfae`, not the later implementation.

The companion also advanced to `5631c4a` with threshold, held-out population,
membership lookup, resource-refusal diagnostics, Unicode decoding and pending
scope-validation follow-ups. No combined-selection test or shared fixture file
changed. This packet preserves completed earlier observations and the producer
integration controls. Full validation of the updated source pair remains a
separate execution, tracked in the live PR description.

The retained V6 matrix uses its own consumer pin `3a0eb90e`, separate from the
V8 consumer `21b7c807`. Its successful bounded gates retain upstream training
omissions and source/teacher refusals; they do not claim universal source
admission. The captured V6 receipts preserve those dispositions and identities.

Both release runs authenticate the current split of 52 training, 8 validation
and 4 test sources. Both report exactly two lifecycle optimizer updates, zero
updates during package/restore, incomplete optimizer target coverage, unmeasured
accepted-history recovery and null learned success.

## Focused controls

| Observation | Original result | Files |
| --- | --- | --- |
| Expanded direct-release Python selection | 105 passed, zero failures/errors/skips | `focused/release-python-105.*` |
| Original JavaScript campaign selection | 140 passed, zero failures/errors/skips | `focused/release-javascript-140.*` |
| Current authored population controls | 11 passed, zero failures/errors/skips | `focused/release-population-11.*` |
| Combined policy/custody controls | 12 passed, zero failures/errors/skips | `focused/combined-policy-12.junit.xml` |

These are separate observations, not a deduplicated total. The original focused
JUnit/log files do not record a Git revision or a clean before/after checkout
identity. They retain their original timestamps, test names, paths and outcomes;
this packet does not assign those runs to a later commit. Empty original log
files remain empty. Native collection evidence is also retained; collection is
not test execution.

## Original direct-release failure

`direct-release-1a971f99/` retains the original console, stage record, all three
policy assets, qualification stdout/stderr, and four complete qualification
metadata files. The run used producer
`1a971f99da68dd97d61e30c1149ba1c1a7ded2f9` and consumer
`21b7c80718244073dbf13263771da533d4ecbc25`. Its 64-source qualification stage
passed all 64 source/native admissions. The driver then failed its stale split
assertion: the authenticated report contains **52 training / 8 validation / 4
test**, while that driver's assertion required **48 / 12 / 4**.

The separately retained `later-population-diagnostic.json` verifies the original
metadata against the current authored cohort and preserves the original report
revision. It does not rerun the qualification or turn the failed release into a
pass. Per-source trace artifacts, tokenizer bytes, prepared datasets, campaign
objects and model assets are not copied into this compact packet. The retained
metadata therefore is not a standalone complete campaign or release bundle.

The four bulky metadata files use reversible deterministic gzip plus base64.
Decode base64, then decompress gzip to recover each original JSON file byte for
byte. `inventory.json` records both stored and original sizes and SHA-256 hashes.

## Local combined gate and separate scoped checks

`combined-52b35fb0/` retains original commands, before/after identities, the actual
attestation refusal and the later scoped checks. Both source checkouts were
clean and unchanged at producer `52b35fb0fb121c5fd82d9d70674789516b2cc853` /
consumer `21b7c80718244073dbf13263771da533d4ecbc25`.

Full attestation refused because `/proc/self/ns/time` was unavailable. **Zero
full local lanes were completed.** Separate isolated installed-wheel checks
verified **31 tracked original-source artifacts / 1,746 contexts**, all **seven
payload pairs**, and **268 Python module byte comparisons**. Those scoped
replay/context/continuation observations do not certify the full recovery gate,
new source admission, broader training, or the later hosted combined result.

## Workflow validation

`workflow-validation/` preserves the original actionlint before/after reports,
logs, five before-workflow definitions, and all five environment/resolver smoke
reports with their raw policy, resolution, GITHUB_ENV and GITHUB_OUTPUT files.
The original before/after report records exit codes **1** and **0**. All five
smoke rows record successful environment propagation to the exact consumer
`21b7c80718244073dbf13263771da533d4ecbc25`.

An assembly-time comparison confirms that all five retained before-YAML files
match commit `52b35fb0`. The original reports do not retain a Git clean-state
receipt or complete invocation. The workflow agent reported retrospectively
that after-validation evaluated uncommitted edits atop `52b35fb0`, later
published as `6f3d38db`; this is not a clean-checkout execution claim. The empty
all-workflows log does not independently encode an exit status.

## Inventory and retention

Original files were copied without editing. For `.gz.b64` JSON and log files,
compression uses Python `gzip.GzipFile` with an empty filename, level 9 and
`mtime=0`, followed by unwrapped RFC 4648 base64 and one trailing newline.
The inventory lists every packet file except itself, including the generated
README and summary. The nested local-release manifest separately records the
raw and stored hashes of its deterministic gzip files. Original-source paths
are provenance locators, not portable runtime dependencies. The complete local
run inventory hashes 1,131 files totaling 1,126,073,344 bytes; excluded model,
prepared-data and archive bytes cannot be reconstructed from those hashes.

Final all-event records for the superseded `409e5931` checkpoint are retained.
Subsequent source-pair results must retain their own execution identities.
This packet makes no claim of full training exposure, learned usefulness,
accepted-history recovery, deployment, rollback or default promotion.
