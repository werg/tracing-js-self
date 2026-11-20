# Complete producer regression at 9d4f6b3

The full producer regression passed at
`9d4f6b3fcff97e7f915ae9c7228f7fd75aaaec3c`, Git tree
`f16c35ab90b847f502b450f2a46cfe055dc089dd`, using Node `v24.22.3`
and npm `11.19.1`. The instrumented receipt confirms identical clean
tracked trees before and after every command. This run includes iterable
frontend lowering and the live model execution/serving failure-cost changes
present at that revision.

## Full regression results

| Check | Recorded command | Result | Elapsed |
| --- | --- | --- | --- |
| Full Node suite | `node --test --test-concurrency=4 test/*.test.js` | 1,840 tests: 1,834 passed, 6 skipped, 0 failed, 0 cancelled | 691.802 s |
| Generated contracts | `npm run contracts:check` | Five of five checks passed | 44.379 s |
| Reference fixture | `node fixtures/reference/reference-fixture.mjs` | Eight of eight checks passed | 0.275 s |

Every command exited with code zero. The run started at `2026-11-20T17:09:35.278551+00:00` and
finished at `2026-11-20T17:21:52.557315+00:00`; total elapsed time was
736.717 seconds. The recorded temporary directory is
`/workspace/scratch/754a49249d01/producer-validation-tmp`.

[summary.json](summary.json) retains exact commands, runtimes, timestamps,
counts, Git identities, original skip lines and log hashes. The
[code manifest](code-manifest.json) binds 733 tracked
source/test/tool/fixture blobs, and [test-files.json](test-files.json) lists all
300 files selected by the full-suite command. No
implementation bytes changed during the run.

### Conditional skips

The six native-environment-dependent checks remain skipped and are not counted
as passes. One requires explicit external consumer/tokenizer paths; five require
a configured served native orchestration environment. Their original skip lines
are retained in the summary and raw output:

- actual pinned ByteCodec reproduces the frozen gallery and meters exact v7/context bytes — Exact external consumer/tokenizer paths were not supplied
- native compact coordinator runs async, callback and throwing children in one process with exact whole-task receipts — Set MEGATOKEN_ORCHESTRATION_SERVED, MEGATOKEN_PYTHON and MEGATOKEN_REPOSITORY for native runtime gates
- native bounded context resumes the exact captured cell despite compact callback history — Set MEGATOKEN_ORCHESTRATION_SERVED, MEGATOKEN_PYTHON and MEGATOKEN_REPOSITORY for native runtime gates
- native coordinator budget cancellation leaves no selected guest, effect, or live track — Set MEGATOKEN_ORCHESTRATION_SERVED, MEGATOKEN_PYTHON and MEGATOKEN_REPOSITORY for native runtime gates
- native rejected semantic child preserves its committed bytes and cancels its waiting parent — Set MEGATOKEN_ORCHESTRATION_SERVED, MEGATOKEN_PYTHON and MEGATOKEN_REPOSITORY for native runtime gates
- actual initialized-weight native coordinator preserves rejected bytes and token costs with no fixture fallback — Set MEGATOKEN_ORCHESTRATION_SERVED, MEGATOKEN_PYTHON and MEGATOKEN_REPOSITORY for native runtime gates

## Subsequent targeted source validation

Producer `562f6f2e8e63a0be775acf2e0be145dc6f9f264c` added four protocol source/state changes
for flat iterable binding and writable Array iterator shadowing after the full
regression above. Its original focused output records **24 of 24 tests passed**,
with zero failures/cancellations/skips, in 56.747 seconds.
The four selected files cover flat iterable bindings, custom `for…of`, builtin
iterator source observations and public iterator state. All five contract
generators also passed at that later revision.

[targeted-562f6f2.json](targeted-562f6f2.json) records the coordinator-supplied
exact command, four changed source paths, raw-log hashes and independently
parsed numeric results. Its producer identity is **coordinator-reported**: the
source was aligned to that commit and a subsequent status check was clean, but
no structured before/after receipt was collected for this focused run. It does
not claim the same identity instrumentation as the full regression, and it does
not relabel the full 1,840-test run as a later-revision run.

The later final contract/fixture update and independent native corpus admission
have their own exact receipts. This package establishes the full regression and
the specifically scoped later source checks above, not model learning or default
promotion.

## Retained logs and interrupted predecessor

| Gate | Standard output | Standard error or combined log |
| --- | --- | --- |
| Full Node suite | [unit.stdout.log](unit.stdout.log) | [unit.stderr.log](unit.stderr.log) |
| Full-run contracts | [contracts.stdout.log](contracts.stdout.log) | [contracts.stderr.log](contracts.stderr.log) |
| Reference fixture | [reference.stdout.log](reference.stdout.log) | [reference.stderr.log](reference.stderr.log) |
| Targeted 562 tests | [targeted-562f6f2.stdout.log](targeted-562f6f2.stdout.log) | Original combined output retained |
| Targeted 562 contracts | [targeted-562f6f2.contracts.log](targeted-562f6f2.contracts.log) | Original combined output retained |

The earlier producer `800a92fcb122148ed8acdd6a5283ee1d3da8a1e5` full-suite attempt
was interrupted when the changed frontend made a fresh regression necessary.
Its raw summary, code/test inventories and incomplete logs are retained in
[interrupted-800a92f.tar.xz](interrupted-800a92f.tar.xz); no complete-suite pass
is inferred from that prefix. The archive/member hashes are in
[interrupted-800a92f.json](interrupted-800a92f.json).

The original [runner](run_validation.py) and [packaging helper](retain_producer_regression.py)
are retained. `files.json` binds all files except itself and `SHA256SUMS`;
`SHA256SUMS` binds the complete package except the checksum file itself.
All original command-log hashes and every decompressed history member were
verified during packaging. Integrity verification does not rerun the tests.
