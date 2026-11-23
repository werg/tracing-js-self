# PR #60 verification evidence — 23 November 2026

This packet preserves completed original outputs from the PR work, including failed historical runs and their separate focused follow-ups. [manifest.json](manifest.json) records the raw and stored SHA-256, byte count, original workspace path, role, and encoding of every retained proof artifact. Logs and two larger native evidence JSON files use deterministic gzip: level 9, zero timestamp, and no embedded filename.

The observations overlap. Their passing counts must not be added into a unique-test total, and the broad suites below must not be described as zero-failure runs. Exact execution identities are stated where recorded; a published repair commit attached to a focused log identifies the code change, not an invented before/after capture of that test process.

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

## Remaining record boundaries

The completed hosted aggregate timeout and its passing local follow-ups remain separate observations. The per-fixture repair is published in [commit `a44621ce`](https://github.com/werg/tracing-js-self/commit/a44621ceb9bcb25b1348b349b70056cdef902d65). The corresponding hosted rerun was pending when this packet was published. The [live PR tally](https://github.com/werg/tracing-js-self/pull/60) records current hosted status; this packet does not claim that all hosted CI is green. No incomplete output is included. Later completed observations can be appended with their own scope and identities.

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
