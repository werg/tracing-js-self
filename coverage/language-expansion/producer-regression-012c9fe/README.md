# Frozen producer regression at 012c9fe

**Status: failed.** This receipt measures exact producer
[`012c9fe49a082319bf98ac0c571596da925741a4`](https://github.com/werg/tracing-js-self/commit/012c9fe49a082319bf98ac0c571596da925741a4)
and tree `26454c685a6136ab6d6d18636e6073216ee9d195`. It retains the full producer test suite, all five
contract checks, and the eight native reference-fixture checks. It is distinct
from complete corpus source/native admission and learned model execution.

**Superseded run.** The original run was allowed to settle without changing its checkout. [SUPERSEDED.json](SUPERSEDED.json) identifies the later test-only fixes and replacement test revision. Its original outcomes and raw logs are retained unchanged; it is not the final current-test qualification.

## Results

| Check | Exact command | Result | Elapsed |
| --- | --- | --- | --- |
| unit | `node --test --test-concurrency=4 test/*.test.js` | failed: 1844 tests: 1840 passed, 3 failed, 0 skipped, 1 cancelled | 1489.713 s |
| contracts | `npm run contracts:check` | passed: 5 / 5 checks passed | 105.198 s |
| reference | `node fixtures/reference/reference-fixture.mjs` | passed: 8 / 8 checks passed | 0.509 s |

The run started at `2026-11-20T17:32:15.343806+00:00` and finished at
`2026-11-20T17:58:52.397083+00:00`. Total measured command time was
1596.073 seconds. Node was `v24.22.3`;
its exact executable, npm version, commands, UTC timings, stdout/stderr hashes,
and clean identities are in [summary.json](summary.json).

## Actual conditional native gates

The actual ByteCodec test used its policy-pinned consumer
`7b36617a446fafe21b5f28ae5ec73956e246f7bf` in a separate clean checkout,
with the real tokenizer `40fb9d7d7795b8bd305aeff39ce9963f3f450915b9553f2938e009be9a1fed60`. This is the consumer
required by `contracts/native-admission-policy-v6.json`; it is not relabelled as
the current v8 native admission pin.

All five served native orchestration gates were enabled against clean consumer
`39c4036564428e44cc89caf261f517d856482695` and the actual zero-update native Tiny bundle
`2a7eefffb21e8901150e6932ccd3d7f048fa2efb0ed4d9ebc9072feab43f0452`. Four are explicit controlled
lifecycle/validation tests; the fifth checks original initialized-model rejection
and cost evidence. These are engineering gates, not learned-success evidence.
The original bundle is not modified by the run. Its exact manifest and model
configuration hashes are retained in [setup.json](setup.json).

No tests were skipped. All six conditional external-tokenizer/native-serving tests were enabled.

The original failed test output is retained; it is not reclassified as passing.

- ✖ interoperability includes all source goldens and returns fresh mutable guest inputs (1033.301903ms)
- ✖ automatically started callbacks share the execution deadline while awaiting completion acknowledgement (5620.350274ms)
- ✖ native compact coordinator runs async, callback and throwing children in one process with exact whole-task receipts (39346.371942ms)
- ✖ native rejected semantic child preserves its committed bytes and cancels its waiting parent (22394.209662ms)
- ✖ failing tests:
- ✖ interoperability includes all source goldens and returns fresh mutable guest inputs (1033.301903ms)
- ✖ automatically started callbacks share the execution deadline while awaiting completion acknowledgement (5620.350274ms)
- ✖ native compact coordinator runs async, callback and throwing children in one process with exact whole-task receipts (39346.371942ms)
- ✖ native rejected semantic child preserves its committed bytes and cancels its waiting parent (22394.209662ms)

The native tests wrote 5 original evidence files. They are retained
byte-for-byte in [native-orchestration.tar.xz](native-orchestration.tar.xz), with
member lengths and SHA-256 hashes in
[native-orchestration-index.json](native-orchestration-index.json). Every archive
member was checked after compression. The bundle itself is separately retained
by the model experiment; this receipt binds its identity and configuration.

## Clean setup and provenance

Validation ran from an isolated detached producer worktree. `npm ci --no-audit
--no-fund` installed its own dependency directory; no `node_modules` symlink was
used. The installation logs and lockfile hash are retained. The source checkout
kept identical commit/tree and empty tracked-change status before and after
every command. Independent consumer, policy-pinned tokenizer checkout, and served
manifest/configuration identities remained unchanged as recorded in
[native-final-identities.json](native-final-identities.json).

- [environment.json](environment.json) records the explicit paths, policy, native
  source binding, temporary directory, and CPU thread settings used by subprocesses.
- [code-manifest.json](code-manifest.json) binds every tracked repository file by
  Git mode/type/blob identity at the measured revision.
- [test-files.json](test-files.json) lists all 301
  files included by `test/*.test.js`.
- [run_validation.py](run_validation.py) retains the exact command/receipt procedure.
- [files.json](files.json) and `SHA256SUMS` bind the retained review files and archive.

| Check | Standard output | Standard error |
| --- | --- | --- |
| Dependency installation | [npm-ci.stdout.log](npm-ci.stdout.log) | [npm-ci.stderr.log](npm-ci.stderr.log) |
| Full tests | [unit.stdout.log](unit.stdout.log) | [unit.stderr.log](unit.stderr.log) |
| Contracts | [contracts.stdout.log](contracts.stdout.log) | [contracts.stderr.log](contracts.stderr.log) |
| Reference fixtures | [reference.stdout.log](reference.stdout.log) | [reference.stderr.log](reference.stderr.log) |

Evidence/documentation commits containing this package do not change the measured
producer or consumer identities. Preserve any failure/skip dispositions when
using the receipt; it does not establish unrestricted ECMAScript support,
external comprehension, serving-cache benefit, or default promotion.
