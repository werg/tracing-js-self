# Received main validation review — 18 November 2026

This directory retains all six unchanged files from the independent review of
received main `53180e0b0dfbf6c9544b680f854a442db53bb0ab`. The
[original review receipt](review-receipt.json) binds the other five files by
size and SHA-256 and records the exact commands, source scope and workflow IDs.

| Check | Measured result |
| --- | --- |
| Source/projection/parameter suites on Node 24.22.3 | 17 passed, zero failed/skipped |
| Complete closure-name source/reference/projection/JSON-roundtrip/recheck probes | Eight attempted, eight locally verified; no native-admission claim |
| Hosted Node 20/22/24 unit matrix, run 44330593327 | All three jobs passed |
| Retained Node 24 job 134893620958 | Actual checkout `53180e0`; 912 tests, 905 passed, zero failed, seven skipped |
| Coverage workflow 44330593873 | Passed |
| Oracle workflow 44330593333 | Passed |

The [complete original Node 24 log](hosted-node24-job.log) also retains the
canonical reasoning fixtures, deterministic reference fixture and demo replay
steps. The [closure probe script](closure-name-smoke.mjs) accepts the source
root and output path as arguments; its [original output](closure-name-smoke.json)
retains each case's local source/reference/projection/recheck outcome.

At the original snapshot, the five-lane native run **44330593504** was in
progress and real-world corpus run **44330593597** was queued. No successful completion,
new native release, or new corpus result is claimed from those automatic runs.
The complete native releases at producer `1e2e6a0` / consumer `6b4382b` and all
older experiment populations remain bound to their original producing revisions.
The narrow inherited validator change required no further source fix.
