# Primary hosted campaign: finite timeout, partial evidence retained

[Run 45023684906](https://github.com/werg/tracing-js-self/actions/runs/45023684906), attempt 1, job `137211919487`, failed its required full-pass step. Its exact producer revision is `9cf091e6ccc5add960ef0897576d0c391b199a65`; the actual native optimizer and independent rereader are `1a69d9da3254b7568c831d12866a629c206cf4fe`. Contract `a952385535b9b5e19d737206286f6f26c149f7301c51b4b106fe3b1cae5ab55a` and the production tokenizer remain bound to those original inputs.

## Why the complete gate failed

The child training command hit its declared 7,200-second limit. The original command report records `spawnSync python ETIMEDOUT` and duration 7,224,146 ms. Training handled the termination request and committed `SE-000000314-interrupted`; its last raw metric reports update 314, elapsed 7,221.742692149 seconds, and termination `requested`. It needed 348 updates for the complete pass. No limit was changed, no attempt was rerun, and this failed experiment is not converted into a passing result.

All 64 sources had passed source replay and native admission, with the same 48 training / 12 validation / 4 test membership. The separate two-update ordinary resume/export/service lifecycle also passed before the fresh complete-pass attempt. The final checkpoint belongs to the interrupted coverage trajectory; the served export belongs to the separate two-update trajectory.

| Quantity | Required full population | Actually recorded before timeout |
| --- | ---: | ---: |
| Coverage optimizer updates | 348 | 314 |
| Training sources with any recorded target | 48 | 44 |
| Logical targets with recorded loss | 696 | 628 |
| Physical target records with recorded loss | 720 | 650 |
| Lexical positions | 26,027 | 23,519 |
| Reconstruction positions | 26,027 | 23,519 |
| Structure categorical labels | 2,880 | 2,600 |
| Terminal categorical labels | 1,440 | 1,300 |
| Modality categorical labels | 720 | 650 |

The independent prepared-data comparison leaves **70 physical targets missing** and the required training schedule **34 updates short**. For the observed records, there are no invented targets, changed prepared oracles, duplicate occurrences or target/window census mismatches. Partial consistency is narrower than complete coverage. Hidden routing positions and learned success remain unmeasured.

The original driver writes its final coverage count only after success, so its unchanged command report says `{lifecycle:2, coverage:0, total:2}`. The actual raw metrics and committed checkpoint prove 314 additional updates. Derived evidence therefore records **2 + 314 = 316 actual updates across separate trajectories**, while preserving the original report and explaining the discrepancy. The two counts are not silently reconciled by editing evidence.

## Read-only checkpoint revalidation

`independent-partial-audit.json` uses the exact native optimizer reader, independently reconstructs all 720 expected physical targets and positions from the unchanged prepared data, verifies three checkpoint metadata and lineage bindings, reproduces the separate one-to-two-update continuation comparison, and checks the actual interrupted state. It performs zero optimizer updates and zero decoder forward passes. Original path-bound configuration strings and all receipts remain unchanged.

The interrupted checkpoint SHA-256 is `93828a840122cc2e209e1c448396324595adef476d610770384291847fdc8499`. The first local reader attempt used a later optional API argument that the exact historical reader does not accept; its raw error is retained in `initial-reader-api-attempt.log`. The final helper uses the exact historical signature and explicitly verifies each metadata position digest. This setup error changed no original artifact and is separate from the hosted timeout.

## Original bytes retained

Original GitHub artifact `14759987389`, named `semantic-v8-target-inventory-support`, is **175,381,869 bytes**, SHA-256 `6dc909ecc1c1ed7401fa5ceb1cba7006c07641d530a1550f16a7870af3e483af`. It contains 591 files totaling 472,784,236 uncompressed bytes. Every original member is listed and hashed in `original-artifact-members.json`; the untouched original ZIP is retained locally and through the run's artifact until its recorded expiry, 22 December 2026.

`original-reports.tar.xz` losslessly retains raw stage logs, complete reports, journal/CAS entries, configurations, checkpoint metadata and metrics. `retained-reports.json` lists every retained member. Large generated checkpoints, weights and bulk source/prepared data remain in the original ZIP and are bound by the complete member manifest.

The complete decoded GitHub job log is retained as `complete-job.log`, including its original leading BOM: **208,237 bytes**, SHA-256 `870014e9756f439bc66062ea7ad4172ef4658ddec9bae579bcc938c5a8f29241`. Actions omitted the hidden campaign lock, and the extracted original has not been repaired.

This failed run and the separately completed [expanded campaign](../expanded-b415-2f3/README.md) retain distinct source identities and results. The latter supplies its own successful full-pass evidence; it does not change this attempt's status or qualify later source, production compute, live recovery, default cutover or learned quality.
