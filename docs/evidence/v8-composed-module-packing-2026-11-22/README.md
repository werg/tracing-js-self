# Composed original-module source admission and physical packing

The composed implementation passed an actual hosted gate from original module
source through live source checks, native replay admission and complete physical
packing. The gate ran at producer
`9cf091e6ccc5add960ef0897576d0c391b199a65` and native consumer
`1a69d9da3254b7568c831d12866a629c206cf4fe`, under contract
`a952385535b9b5e19d737206286f6f26c149f7301c51b4b106fe3b1cae5ab55a`.
This evidence belongs to that exact pair. The earlier `7663c11` / `3fa9272`
investigation keeps its own execution identity.

[Hosted run 45023157562](https://github.com/werg/tracing-js-self/actions/runs/45023157562)
completed successfully. Its job, `137210278184`, ran from 12:36:27 to 12:55:07
UTC on 22 November 2026. The observed runtime was Ubuntu 24.04.5, Node 24.22.3,
Python 3.12.14 and the hash-locked CPU PyTorch 2.10.0 distribution. The original
job log, API metadata and exact source entrypoints are retained here.

## What was executed

| Gate | Reported test cases | Result |
| --- | ---: | --- |
| Native admission, source authority and finite deadline controls | 45 | All passed; no failures, errors or skips |
| Original module source checks, ownership and source/plan/outcome tamper controls | 9 | All passed; no failures, errors or skips |
| Fresh original-source artifact through native admission and physical packing | 1 | Passed; no failure, error or skip |

These are three test denominators. The source population was one original
module case, with one isolated family assigned to validation. The gate did not
expand any immutable production population and executed zero optimizer updates.
The source-only controls also remain separately identified from the actual
native admission performed by the final packing test.

The positive case contains 708 logical public contexts and 708 generated
targets. Its bound module scheduler plan has ten owned events and exactly one
initialization target. The retained target-kind census also includes actual
async calls, awaits, resumes and completions, generator activity, and promise
executor/resolver activity. Original source, projection and replay checks all
passed. Native admission separately passed replay, contexts, continuation,
masks, source binding and production tokenizer identity.

## Physical data and mask accounting

| Measured quantity | Observed count |
| --- | ---: |
| Logical contexts / generated targets | 708 / 708 |
| Physical context pieces | 11,679 |
| Physical selected target records | 708 |
| All physical prepared records | 12,438 |
| Observation records, all with zero scored positions | 11,730 |
| Packed windows | 898 |
| Maximum packed window tokens | 8,192 |
| Scored positions in the selected targets | 22,974 |
| Whole contexts larger than 8,192 tokens before splitting | 566 |
| Largest whole context before splitting | 12,300 tokens |

All context and target bytes reassembled exactly, every required public-context
dependency survived, every physical record fit the unchanged 8,192-token bound,
and the window iterator preserved all physical record identities exactly once.
This shows the actual long-context preparation path working without dropping
contexts or raising the window limit.

A separate read-only audit loaded the retained prepared records with the exact
native consumer. It recomputed every number above, verified the index and shard
hashes, checked all 708 target masks against independently reconstructed byte
spans and token boundaries, and reproduced the selected-token/mask digest:

`057829c2c1e4870deec4647f16c42281aa9aab40c8aedc2312a96e05d5bdee73`

The complete canonical receipt is retained in
`selected-token-and-mask-receipt.json.gz`. Its uncompressed 307,644 bytes hash to
that digest. The original source artifact hashes to
`b206c883e8f665af5ff1e959b035f4f009a22aad5dabc2cf6be4cffae13e5615`.
The prepared manifest hashes to
`919a014a1ff4a64e0edda9f17ec03cc79a8a808a20c60e92886970f4700f1bda`.

This is prepared-data mask accounting. No optimizer or decoder ran in this
module gate or its later read-only audit, and neither result measures learned
quality. The complete optimizer-position campaign has its
own source population, run identity and evidence.

## Retention and reproduction

`summary.json` describes the measured result. The three XML reports and
`module-artifact-packing-evidence.json` preserve the exact hosted reports.
`job-137210278184.log.gz` expands to the complete 123,263-byte job log, whose
SHA256 is `1f58eb7f1aa88a935fe925b2b660098e61eb586a8f1c4274101065608667216b`.

`retained-reports-and-source.tar.gz` preserves 12 unique source/report entries,
including both complete original source artifacts, all runtime reports, the
prepared manifest, family receipt and index. The complete Actions artifact is
`14755122783`, named `original-module-source-admission-and-packing`: 74,793,410
bytes, SHA256
`3a919bb9f23ebdaf5ed2637f21952536d6608f60a33cf39584275419135b0754`.
It retains the full prepared shard and deduplication database; its recorded
GitHub expiration is 22 December 2026. Every one of its 21 entries is hashed in
`artifact-member-inventory.json`, including seven byte-identical pytest
`current` aliases. `retention.json` lists the exact archive inclusion and
exclusion decisions.

`source-map.json` binds the two executed repository trees and 31 selected gate,
source-binding, admission, packing and audit entrypoints. The complete trees
identify all remaining dependencies; the selected path list is not presented
as a complete dependency graph.

To repeat the read-only artifact audit, safely extract the original artifact,
use the pinned production tokenizer, and run `verify-artifact.py` with
`--artifact-root`, `--tokenizer` and `--output`. Set `PYTHONPATH` to the `src`
directory of native revision `1a69d9da3254b7568c831d12866a629c206cf4fe`.
This rechecks retained bytes and packing. It does not rerun original JavaScript
source, admission, or model training.
