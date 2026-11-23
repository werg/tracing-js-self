# PR #60 verification evidence — 23 November 2026

This packet preserves completed original outputs from the PR work, including failed historical runs and their separate focused follow-ups. [manifest.json](manifest.json) records the raw and stored SHA-256, byte count, original workspace path, role, and encoding of every retained proof artifact. Logs and two larger native evidence JSON files use deterministic gzip: level 9, zero timestamp, and no embedded filename.

The observations overlap. Their passing counts must not be added into a unique-test total. The original producer `9a17` and consumer `86e7` broad runs remain failures; later hosted unit-suite passes belong to their separately recorded merge checkouts. Exact execution identities are stated where recorded; a published repair commit attached to a focused log identifies the code change, not an invented before/after capture of that test process. Original JSON records retain their original filenames; the manifest maps those source paths to the retained, sometimes compressed files.

## Completed checks

| Check | Original result | Scope and retained proof |
| --- | --- | --- |
| Broad producer suite | 3,202 total: 3,106 passed, 10 failed, 86 skipped | Stable producer `9a17`, as recorded during the session; no Git boundary capture in the [original log](producer/full-suite.log.gz). Six failures concerned the helper ownership environment; four concerned stale edition-fixture identities. |
| Helper environment follow-ups | 14/14 passed; separate larger group 15 passed, 10 optional skips | [Focused check](producer/kernel-helper-focused.log.gz) and [larger check](producer/kernel-helper-complete.log.gz). The [earlier 9-pass/5-fail diagnostic](historical/kernel-helper-ownership.log.gz) remains unchanged. |
| Edition-fixture identity controls | 28/28 passed, no skips | [Original log](producer/test262-edition-identities.log.gz), associated with published repair `d4ceb074`. |
| Broad consumer suite | 1,152 passed, 2 failed, 3 skipped; 2,570.15 s | Consumer `86e7`, as recorded during the session; [original log](consumer/full-contract-suite.log.gz). The failures were an aggregate child deadline and a fresh interpreter missing Torch. Three live-source checks lacked their required environment. |
| No-legacy replay/recovery follow-up | 71/71 passed; 732.24 s | [Original log](consumer/no-legacy-cases.log.gz). All seven fixture populations use a fresh child per case with the unchanged 240-second child bound. |
| Relocation and live-source follow-ups | 1/1 passed in 28.91 s; separately 3/3 passed in 51.00 s | [Proper-environment relocation](consumer/input-relocation-venv.log.gz) and [actual-source controls](consumer/live-source-controls.log.gz). These resolve the historical failure/skip cases without rewriting the broad result. |
| Hosted interoperability aggregate | 77 transport controls passed; one aggregate timed out | [Completed hosted log](historical/hosted-interop-aggregate-timeout.log.gz), producer `0b9ca73c` / consumer `65ebbf6a`. All eight original async source cases passed before their shared native replay child exceeded its 120-second deadline. |
| Per-fixture async replay follow-ups | Source: 20/20 passed; binding: 7/7 passed; no skips | [Source log](producer/async-source-per-case.log.gz) and [binding log](producer/async-binding-per-case.log.gz). The test-only worktree was based on producer `ce364792` with consumer `65ebbf6a`; these focused runs did not capture clean Git boundaries. Each native child retains the 120-second deadline and all replay/context/continuation/roundtrip assertions. The slowest native cases took 28.81 and 34.10 seconds, respectively. |
| Native source controls | 66/66 passed, no skips | [Log](paired-native/tests.log.gz), [before capture](paired-native/before.json), [after capture](paired-native/after.json). The exact clean producer/consumer pair below remained unchanged. |
| Reflection/storage guards | 139/139 passed, no skips | [Log](producer/object-reflection-storage.log.gz); published repair `d9f7984779095b3656cd2ea94150d4c4eea3cea8`. |
| Incomplete function storage | 29/29 passed, no skips | [Log](producer/frozen-function-storage.log.gz); published repair `d5eb323cdb914c8f5bbfa87ce18858644d32e2b3`. |
| Unsupported Proxy storage | 15/15 passed, no skips | [Log](producer/proxy-storage-refusal.log.gz); published repair `ce364792c03998e45a1d01675d85235df8c9e97c`. |
| Contracts after those runtime repairs | Passed; command exited 0 | [Original contracts log](producer/contracts-ce364792.log.gz), attributed to exact producer `ce364792c03998e45a1d01675d85235df8c9e97c` by the coordinator. The earlier [5f321 check](producer/contracts-5f321.log.gz) is also retained. |
| Reference fixture after those repairs | Eight named checks passed; command exited 0 | [Original reference output](producer/reference-ce364792.log.gz), attributed to producer `ce364792`; the [earlier output](producer/reference-fixture.log.gz) remains separate. |
| Direct-release Python controls | 110 passed | [Original log](producer/direct-release-python.log.gz). This local driver-repair tree was associated with `45a1806d`; exact execution Git boundaries were not captured. |

## Two bounded ordinary lifecycles

Both completed lifecycles record producer **`5f321f0c634773bbccdb12b9ab6d18f69954f1ef`** and consumer **`aab637f002323a7820759763652df7a5ad50fe04`**. These are also the exact revisions independently captured before and after the 66 native source controls. Later guard commits were verified separately; this packet does not claim that a later HEAD ran those earlier controls.

| Selected source | Reports | Recorded result |
| --- | --- | --- |
| `promise-number-proxy-memory-join` | [Command report](lifecycles/ordinary-lifecycle-venv/command-report.json), [qualification](lifecycles/ordinary-lifecycle-venv/qualification/summary.json) | Preparation, two optimizer updates with checkpoint resume, export, and service restoration passed. The first selection was `rejected`. |
| `source-async-iterator-sibling-cleanup` | [Command report](lifecycles/ordinary-async-lifecycle/command-report.json), [qualification](lifecycles/ordinary-async-lifecycle/qualification/summary.json) | The same bounded lifecycle passed. The first selection was `awaiting-commit`. |

Each run prepared **one source** from 77 declared candidates, resumed optimizer step 1 to step 2, and restored the exact next selection. Both record `acknowledgedModelSelections: 0`, `fullPopulationQualified: false`, `fullTargetCoverageQualified: false`, and `learnedSuccess: null`. Accepted-record recovery, complete-population target exposure, and learned semantic success are not established by these runs. The retained metadata identifies the local bundles; this packet contains no reusable model bundle.

The local [ordinary runtime](lifecycles/ordinary-lifecycle-venv/fit/runtime.json) and [async runtime](lifecycles/ordinary-async-lifecycle/fit/runtime.json) used CPU Torch **2.14.1+cpu**. The [CI dependency reference](environment/ci-requirements.lock), copied from exact producer `5f321`, pins **2.10.0+cpu**. These local runs do not qualify that different CI environment or GPU behavior.

A previous wrapper-based attempt failed when the fresh service interpreter could not import Torch. Its [failed command report](historical/python-wrapper/command-report.json) and [original service stderr](historical/python-wrapper/service-stderr.log.gz) are preserved. The later proper-environment runs are distinct passing observations.

## Original current-Test262 evidence

The separate [retained Test262 packet](../../../artifacts/conformance/test262-current-pr60/README.md) contains the selected catalog, original outcomes, completed-resume check, diagnostics, and deterministic reconstruction recipe. It is linked rather than duplicated here. At producer `5f321` and Test262 `2a1ade303f72d3de80565c921d685222405c32ce`, the 20-file/40-variant cohort recorded 40 parse passes, 30 owned passes, 10 owned unsupported outcomes, and 40 reference passes. The unsupported rows remain visible. This selected cohort does not establish whole-suite conformance.

## Follow-up checks and hosted outcomes

These observations supplement the earlier packet without replacing its failed runs or assigning later revisions to earlier executions.

| Observation | Recorded result | Evidence |
| --- | --- | --- |
| Hosted producer, Node 24.22.3 on merge `849a81cf` (PR head `a6e9c6cc`) | **3,224 total: 3,129 passed, 0 failed, 95 skipped**; the entire job passed | [Original full log](follow-up/hosted-producer/job-137550495934-node24.log.gz), [hosted job](https://github.com/werg/tracing-js-self/actions/runs/45132316588/job/137550495934) |
| Hosted producer, Node 22.23.5 on merge `849a81cf` (PR head `a6e9c6cc`) | **3,224 total: 3,126 passed, 3 failed, 95 skipped** | [Original failing log](follow-up/hosted-producer/job-137550496393-node22.log.gz) |
| Hosted producer, Node 20.20.2 on merge `849a81cf` (PR head `a6e9c6cc`) | **Superseded and incomplete**; cancellation after 2,220 reported top-level tests | [Original partial log](follow-up/hosted-producer/job-137550496269-node20-cancelled.log.gz). No completed suite total is assigned. |
| Focused async reference repair | **52 passed, 0 failed, 0 skipped on each of Node 20.20.2, 22.23.5, and 24.22.3** | [Node 20](follow-up/node-reference/node20.log.gz), [Node 22](follow-up/node-reference/node22.log.gz), [Node 24](follow-up/node-reference/node24.log.gz), plus their original before/after JSON metadata in the manifest. These are overlapping focused tests. |
| Installed qualification at `a6e9c6cc` | Both populations completed: **665/665** and **77/77** source-qualified. The job then **failed** because its workflow assertion still expected 69 interoperability cases. | [Original hosted failure](follow-up/installed-gate/job-137550648216.log.gz) |
| Installed workflow gate repair | **14 passed, 0 failed, 0 skipped** on the recorded local candidate | [Focused log](follow-up/installed-gate/focused-tests.log.gz), [original repair record](follow-up/installed-gate/repair-evidence.json). Published repair: `938b8043`; the local check was not a new complete installed sweep. |
| Consumer CPU matrix, Python 3.11 and 3.12 | Both jobs exhausted their reported **45-minute job budget**; neither produced a completed suite result | [Python 3.11](follow-up/hosted-consumer/consumer-65ebbf-hosted-cpu311-timeout.log.gz), [Python 3.12](follow-up/hosted-consumer/consumer-65ebbf-hosted-cpu312-timeout.log.gz) |
| Consumer gallery | **1,282 Python checks passed**; **11/11** declared gallery sources were source-qualified and native-admitted | [Original successful log](follow-up/hosted-consumer/consumer-65ebbf-hosted-gallery-success.log.gz). Producer `0b9ca73`, consumer `65ebbf6`; model usefulness and native serving latency remain unmeasured. |

The three hosted producer matrix jobs checked out `refs/remotes/pull/60/merge`, executing **`849a81cfd05a3635a2e4088f6aa434bfceda6567`**, which merges PR head **`a6e9c6ccf6f2b8b3d7bd7d75d0b5550d9c41fd2b`** into **`fc372fac62480310c6539f0669bd5106ef7cfce2`**. Their full-suite outcomes belong to that merge checkout. The installed qualification job separately checked out the exact PR head.

The async repair is published as [`764665dc`](https://github.com/werg/tracing-js-self/commit/764665dc5d4ad18645580603252f63052445d0b8). Current owned semantics still close a rejected synchronous-iterator value exactly once and preserve the original error. Node 20 and 22 omit that close: each focused run retains **seven fresh source agreements and one explicit reference refusal**, while all eight native replay controls pass. The refused case uses its authenticated committed artifact solely for explicitly historical replay. Their 31-case committed source rechecks retain 30 validations and one refusal. Node 24 retains eight fresh agreements and all 31 source validations. Passing refusal controls do not create fresh source admission.

Node 20 ran on clean local commit `d382d93510d77d1462fd0f93e86affa17f023838` before and after. Node 22/24 metadata records base `a6e9c6cc` and unchanged candidate-file hashes. All used consumer `65ebbf6`. These execution identities remain distinct from the published repair. The original [three-failure reproduction](follow-up/node-reference/node22-before-repair.log.gz) and [installed-gate failure reproduction](follow-up/installed-gate/gate-before.log.gz) remain unchanged.

The CPU jobs executed PR merge commit **`8986bb82818b78fdbf45dd5b7afdd1ad60f22c18`**, merging branch `65ebbf6` into `dd80bb0c4ec0f6b7d6a14f87bd9f0ba806882c56`; they did not directly execute the branch-head checkout used by gallery/interop. The CPU-only 45-to-60-minute job-budget adjustment is now published as [`2a35902a`](https://github.com/werg/megatoken/commit/2a35902ac93f4bf27adbfe255900091a90942aa4). The old timed-out jobs remain incomplete observations.

## Completed interoperability retry and Promise admission repair

The completed consumer interoperability retry [job 137551653560](https://github.com/werg/megatoken/actions/runs/45128882436/job/137551653560) used exact clean producer `a6e9c6cc` and consumer `65ebbf6a`. The namespace artifact control, **85 transport controls**, and **1,282 native replay tests** passed, and **77/77 sources qualified**. Native admission then failed for seven Promise sources, leaving **70/77 admitted and packed**; both lifecycle checks were skipped. The [original failed log](follow-up/hosted-consumer/consumer-65ebbf-hosted-interop-attempt2.log.gz) retains this outcome. It follows the separately retained [earlier aggregate timeout](historical/hosted-interop-aggregate-timeout.log.gz) and per-fixture repair [`a44621ce`](https://github.com/werg/tracing-js-self/commit/a44621ceb9bcb25b1348b349b70056cdef902d65).

Consumer repair [`b3a6e254`](https://github.com/werg/megatoken/commit/b3a6e25417db57a2968b2839dccdbccb54e4abe4) aligns specialized Promise inventories with the producer while retaining strict source verification. The seven exact formerly refused artifact files separately passed complete admission and packing on clean local consumer **`0028cce9c23ca33563a74c06e9a5bb4a033dc27e`** paired with producer `a6e9c6cc`. The [command report](follow-up/promise-admission/command-report.json) records unchanged before/after identities and local Torch **2.14.1+cpu**, distinct from the hashed hosted dependency lock. The [candidate log](follow-up/promise-admission/candidate.log.gz), [exact recheck command](follow-up/promise-admission/recheck-command.py), and seven receipts retain replay, contexts, continuations, masks, source binding, and tokenizer results. Separate selected admission controls passed **9** and **2** tests in [two](follow-up/promise-admission/focused-admission-tests.log.gz) [runs](follow-up/promise-admission/focused-profile-boundaries.log.gz).

The earlier 70 passes and separate seven-case repair do not form a fresh 77-case qualification. Subsequent hosted outcomes at `b3a6e254` are tracked in the live PR tally and are not inferred from these candidate checks. This packet includes no hosted artifact ZIP, tokenizer, source dataset, or model payload.

## Completed producer checks after the test repair

The [completed workflow/job enumeration](follow-up/hosted-producer-764665dc/completed-workflows-and-jobs.json) records **11 completed workflows: 10 succeeded and one failed**, with **25 completed jobs: 23 succeeded and two failed**, for PR head `764665dc`. The two failures were the Node 20/22 source-contract phases after successful unit suites. These status totals are not a deduplicated test count or a common checkout identity.

| Observation | Recorded result | Evidence |
| --- | --- | --- |
| Node 20.20.2 | Unit suite **3,226 total: 3,131 passed, 0 failed, 95 skipped**; typed contracts passed. The later source-contract command failed with `reference_mismatch`. | [Observation](follow-up/hosted-producer-764665dc/node20-observation.json), [full failed-job log](follow-up/hosted-producer-764665dc/node20-job-137564793020.log.gz) |
| Node 22.23.5 | Unit suite **3,226 total: 3,131 passed, 0 failed, 95 skipped**; typed contracts passed. The later source-contract command failed with `reference_mismatch`. | [Observation](follow-up/hosted-producer-764665dc/node22-observation.json), [full failed-job log](follow-up/hosted-producer-764665dc/node22-job-137564793295.log.gz) |
| Node 24.22.3 | Unit suite **3,226 total: 3,131 passed, 0 failed, 95 skipped**. Typed/source contracts, reasoning, demo, and replay also passed; the whole job succeeded. | [Observation](follow-up/hosted-producer-764665dc/node24-observation.json), [full successful log](follow-up/hosted-producer-764665dc/node24-job-137564793447.log.gz) |
| Installed source qualification | **665/665** all-population and **77/77** interoperability sources qualified; both authenticated inventory assertions passed. Native/model remained `untested`. | [Observation](follow-up/hosted-producer-764665dc/installed-v8-observation.json), [full successful log](follow-up/hosted-producer-764665dc/installed-v8-job-137564985589.log.gz) |
| Native admission workflow | All **five population jobs** and the separate restore job succeeded. Population-specific skipped steps remain explicit. | [Original job/step observation](follow-up/hosted-producer-764665dc/native-admission-observation.json) |
| Engineering release restore | Original archive inventory and positive source replay verified in a separate hosted job. **`freshMachineQualification: false`; native requalification `untested`.** | [Original restore log](follow-up/hosted-producer-764665dc/native-restore-job-137577513537.log.gz) |

The three Node matrix jobs executed merge **`d0df0d6cbb858bc0be1a75dd917f769c73b0a637`**, merging PR head **`764665dc5d4ad18645580603252f63052445d0b8`** into **`fc372fac62480310c6539f0669bd5106ef7cfce2`**. The installed qualification and restore logs separately record direct checkout of exact `764665dc`. The native population observation supplies recorded job and step conclusions, not downloaded population datasets or a new learned-success claim.

### Source-reference runtime phase repair

The workflow-only repair published as [`bdbe4072`](https://github.com/werg/tracing-js-self/commit/bdbe40726c6dc6cb8646a2e299b955dd1f7425fb) keeps unit tests and typed contracts on every supported Node matrix version. It selects the runtime declared in `.nvmrc` for fresh source-contract agreement and canonical reasoning, then restores the matrix runtime for demo and replay. No existing command was removed or allowed to fail.

The [original repair record](follow-up/ci-reference-runtime/repair-evidence.json) belongs to clean local candidate **`38cc672dfe384414c663d6107789223bb65708b9`**, based on `764665dc`, using **Node 24.22.3**. Its [workflow phase/order check](follow-up/ci-reference-runtime/workflow-phase-check.json) passed. The [source-contract command](follow-up/ci-reference-runtime/semantic-v8-contract.log.gz) validated **6 region examples, 31 protocol sources, and 4 host sources**, and [canonical reasoning](follow-up/ci-reference-runtime/semantic-reasoning.log.gz) passed **8 fixtures**. Publication at `bdbe4072` is separate from that execution identity. This local validation is not a hosted workflow pass at the published revision.

## Remaining record boundaries

The [live PR tally](https://github.com/werg/tracing-js-self/pull/60) records subsequent hosted status. This packet does not claim that all hosted CI is green or that later heads ran the earlier 66 native controls, 40 Test262 variants, or bounded lifecycles. Terminally cancelled logs are retained as explicitly incomplete historical observations; still-running logs are excluded. Later completed observations can be appended with their own scope and identities.

Model weights, tokenizer contents, training datasets and indexes, and the complete frozen source registry are intentionally excluded. The command reports, qualification summaries, runtime records, preparation reports, export manifests, checkpoint metadata, and stage logs retain the evidence needed to assess the bounded lifecycle claims.

## Verify retained bytes

Run this from the directory containing this README and the manifest. It checks every retained proof against both stored and decompressed hashes; it does not rerun tests or fetch assets.

```sh
python - <<'PY'
import gzip, hashlib, json
from pathlib import Path

root = Path('.')
manifest = json.loads((root / 'manifest.json').read_text())
for item in manifest['artifacts']:
    stored = (root / item['path']).read_bytes()
    raw = gzip.decompress(stored) if item['encoding'] == 'gzip' else stored
    for name, data in [('stored', stored), ('raw', raw)]:
        assert len(data) == item[name]['bytes'], item['path']
        assert hashlib.sha256(data).hexdigest() == item[name]['sha256'], item['path']
print(f"Verified {len(manifest['artifacts'])} retained artifacts")
PY
```
