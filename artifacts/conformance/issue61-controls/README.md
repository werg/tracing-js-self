# Issue #61 regression control receipts

This directory preserves the original failed broad runs and their separately
executed corrective runs. It does **not** describe one all-green full invocation.
The original logs remain intact, including every failure and skip. Exact clean
producer/consumer qualification is a separate receipt.

## Semantic tests: complete original population

The initial command selected all 156 root-level `test/semantic-*.test.js` files,
used Node `v24.22.3`, `--experimental-vm-modules`, and test concurrency 4. It
explicitly unset `MEGATOKEN_ROOT` and `MEGATOKEN_PYTHON`, retaining the normal
optional-native skips. The configured temporary directory and trusted flock
helper are recorded in `execution-inputs.json`.

| Counting convention | Passed | Failed | Skipped | Total |
| --- | ---: | ---: | ---: | ---: |
| Actual JUnit testcase leaves | 1,279 | 8 | 90 | 1,377 |
| Node summary, including parent tests | 1,293 | 8 | 90 | 1,391 |

The 14 additional passing Node counts are parent tests represented as JUnit
`testsuite` entries, not testcase leaves. `semantic-summary.json` names all 14
parents, retains each file's actual leaf results, and identifies every original
failure. The run took 811.996 seconds.

`semantic-selected-files.txt` is the original selected-file list.
`semantic-start.json` preserves the starting revision
`c1b48444fc6576d07562e9e03b8b5a1fb6fa5cbd`, dirty-tree status, and 1,049 input
file hashes. This was a working-tree run; it is not relabeled as a clean revision
result. The summary also records inputs changed while the concrete regressions
were being corrected.

### Corrective runs retained separately

| Executed controls | Passed | Failed | Skipped | Receipt |
| --- | ---: | ---: | ---: | --- |
| Three corrected join/reference/shared-protocol files | 15 | 0 | 0 | Spec and JUnit |
| Observer and reference controls | 19 | 0 | 0 | Original spec only |
| Promise object source controls with actual native checking | 17 | 0 | 0 | Spec and JUnit |
| Module declarations and original ESM correspondence | 11 | 0 | 0 | Spec and JUnit |
| Module scheduler admission and fresh source rechecking | 9 | 0 | 0 | Spec, JUnit and 712-context summary |
| Host source rechecking from a clean producer checkout | 7 | 0 | 0 | Spec and JUnit |

The 15-leaf corrective run preserves every case in
`semantic-protocol-promise-join-source-v8.test.js`,
`semantic-protocol-reference-failure-v8.test.js`, and
`semantic-shared-protocol-source-v8.test.js`. It replaces five failed leaves
from the original run. Exact extension/profile assertions were updated for the
registered Promise components without removing original sources, ownership,
checkpoint, recovery, or tamper controls.

The observer correction preserves a recorded metadata-cap diagnostic before
classifying a root Promise left pending by that observer failure. The original
module source and metadata limits remain unchanged. A genuinely pending root
retains its explicit `resource_limited` result. The 19-control run also checks
getter isolation, descriptor identity, alias preservation and genuine guest
rejection. Its original invocation emitted no JUnit; none is synthesized here.

The 17-test native-enabled run independently replays **15 actual source
artifacts**, alongside the source-binding tamper test and the aggregate native
check. A passing component check does not assert full training admission.
This separate run does not silently replace optional-native skips in the
original default-environment tally.

The module scheduler receipt retains one original-source artifact with **712
contexts**, fresh source/projection/replay validation, and ten scheduler-owned
events. Its four added contexts publish the Promise intrinsic, bind its captured
identity, and check two `.then` property reads. The unchanged source and all
source/plan tamper controls remain in the nine-test run. The concise
`module-admission-summary.json` is extracted from the original receipt; its
manifest entry records the byte identity of the larger source packet, which is
not copied here. Native admission remains false and optimizer updates remain
zero.

The module declaration correction compares direct protocol evidence through
its declared outcome representation and requires fresh original ESM checking
whenever module evidence is present. The original class refusal remains. The
same generator-name source now has positive source/public checks, alongside
changed-source, changed-outcome and malformed-proof refusals. These two module
runs are working-tree receipts; no clean execution revision or missing input
fingerprint is inferred from the later checkpoint.

The seven host controls ran from clean producer
`65ce0796569bb6ecf71441dc78f7ce491a322898`. Their original failure explicitly
reported a dirty producer; the later clean result does not erase it. The two
immutable-payload-digest error stacks retained in the passing clean-host spec
are intentional missing/altered-identity rejection controls. All seven actual
JUnit leaves pass.

These final receipts resolve the three failures still listed as pending in
the historical `semantic-summary.json`. That original summary is unchanged.
`final-replacement-summary.json` performs whole-file replacement for six
semantic files: their original **34 passing and 8 failed leaves** are replaced
by **42 actually passing leaves**. Therefore the reconciled semantic population
is **1,287 passed, 0 failed and 90 skipped: 1,377 actual leaves**, with 14 parent
tests reported separately. It names every replaced file and every original
failure, including the three renamed controls, and checks that no leaf is
dropped from a replaced file.

### Separate native generator replay

`module-generator-native-replay.log.gz` preserves the actual helper output.
It independently passed replay, context and continuation checking for the
exact 24-context source packet: seven protocol records and 17 detailed records.
Masks, source binding and tokenizer checks remain explicitly `untested`; this
is not full native admission.

The 253,634-byte input packet is retained as
`module-generator-source-artifact.json.gz`.
`module-generator-native-receipt.json` binds its SHA-256 and byte length to the
owner-identified helper input. The raw helper output does not embed an input
digest or execution revisions; those omissions remain explicit, and no later
checkout revision is assigned to this execution.

## Nonsemantic tests: transparent replacement accounting

The initial owner-reported selection covered the other 281 root-level test
files. Its original spec report contains 1,891 Node rows: 1,876 passed,
7 failed and 8 skipped. No initial revision, input fingerprint manifest, or
JUnit was captured, so the original receipt retains working-tree/log-only
provenance.

Two files failed to import during contract regeneration and appeared as one
failed placeholder each. Five other failures came from the environment's
flock executable ownership checks. The intermediate four-file rerun executed
43 tests: 42 passed and one exposed a stale inherited-descriptor refusal
expectation. The final four-file JUnit records **43 actual passing leaves**,
zero failures and zero skips.

| Replaced file | Initial reported rows | Final executed leaves | Increase |
| --- | ---: | ---: | ---: |
| `capability-ledger.test.js` | 1 failed import placeholder | 11 | 10 |
| `evaluated-module-namespace-exotics.test.js` | 1 failed import placeholder | 18 | 17 |
| `native-request-journal-v8.test.js` | 8 | 8 | 0 |
| `selected-orchestration-execution-lock.test.js` | 6 | 6 | 0 |
| **Total replaced** | **16** | **43** | **27** |

The replaced initial rows comprised 9 passes and all 7 failures. Therefore:

- Reported population: `1,891 - 16 + 43 = 1,918` Node rows.
- Reported passes: `1,876 - 9 + 43 = 1,910`, with 8 skips and no remaining
  failed rows after replacement.
- The original spec also contains 16 passing parent tests. Removing those
  parent summaries gives **1,902 actual leaves: 1,894 passed and 8 skipped**.

The additional 27 leaves are the tests hidden behind the two import-failure
placeholders. They are not invented successes or additional selection.
`nonsemantic-summary.json` retains the original, intermediate and final counts,
every final test name, the four file replacements and all 16 parent names.
This is an accounting of separate executions, not a new broad-run receipt.

## Final combined replacement accounting

| Population | Selected files | Passed leaves | Failed leaves | Skipped leaves | Actual leaves | Parent tests, separate |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Semantic | 156 | 1,287 | 0 | 90 | 1,377 | 14 |
| Nonsemantic | 281 | 1,894 | 0 | 8 | 1,902 | 16 |
| **Combined** | **437** | **3,181** | **0** | **98** | **3,279** | **30** |

These totals reconcile the retained original reports and complete corrective
file runs. They do not describe one all-green invocation. Separate native and
observer reruns are not added again to the leaf population or used to replace
the original optional-native skips.

The local full combined attestation is separately blocked by the missing
required kernel time namespace. Its receipt, independent installed checks and
the hosted CI gate are tracked outside this regression packet. No passing full
combined gate or training result is claimed here.

## Retention and inspection

Spec and JUnit logs are stored as deterministic gzip files. Plain JSON summaries
preserve the counting and provenance distinctions. The small generator source
packet is retained with its native helper output; the larger module admission
packet remains outside this directory with its exact byte hash recorded.

`final-execution-inputs.json` records the actual module commands, the separately
identified clean-host checkout, and the explicit native/gate evidence limits.
All 17 receipts from the earlier manifest retain their original byte identity.

`manifest.json` records every retained receipt's compressed identity and its
original byte length and SHA-256. `retention-verification.json` records the
completed decompression/hash and count checks. For example:

```sh
gzip -dc semantic-original-spec.log.gz
gzip -dc semantic-original-junit.xml.gz
gzip -dc nonsemantic-corrected-junit.xml.gz
gzip -dc semantic-module-admission-junit.xml.gz
gzip -dc semantic-clean-host-junit.xml.gz
```

The original semantic failure report, the focused original failure diagnostics,
and the intermediate nonsemantic failure are retained alongside their later
passing corrections. No original evidence was rewritten.
