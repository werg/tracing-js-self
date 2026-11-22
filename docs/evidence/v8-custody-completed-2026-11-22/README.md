# Complete original archive and log custody: observed completion

[Custody run 45048870742](https://github.com/werg/tracing-js-self/actions/runs/45048870742),
job `137289362787`, completed successfully using source
`85773eca01c2a9c8cb0c9ce10a83d947f20f9cf2` (the exact tree of local `fa778f89`).
It downloaded the pinned original Actions ZIPs, retained them as unpublished
draft assets, and independently re-read each uploaded archive. It also retained
and independently re-read every complete original job log and combined receipt.

| Original observation | Preserved conclusion | Unpublished draft | Complete receipt asset |
| --- | --- | ---: | ---: |
| Original348 evaluation, run `45046754653` | **Failure** | `454615292` | `779841215` |
| Historical790 task-binding release gate, run `45044587251` | Success on that earlier frozen pair only | `454615411` | `779842248` |

| Original ZIP | Exact bytes | Exact SHA-256 |
| --- | ---: | --- |
| Failed original348 evaluation, artifact `14763634179` | 16,427,247 | `2d575cbec0b543e329e68e9bb1289e3a7f33988866a145a9fb3c641a41ff91ad` |
| Historical790 release evidence, artifact `14763982452` | 349,428,034 | `9ae36532437b62803b2190759c04b91f8c831c2716305bd788031bd067e7120f` |

The complete failure log is asset `779841154`, 111,317 bytes, SHA-256
`a930ace1e75105681e80c970a8b9fab839f9b78e4fc038c44a9e6b6c02c045ee`.
The complete790 log is asset `779842195`, 413,112 bytes, SHA-256
`faadeb7a306ae4f14b266f2c174449d12b65fa6e78e95d42056f7cf7081f0de5`.

`job.log` is the full original custody workflow output. `results.json` retains its
exact structured result; every retained log's size/hash was independently
compared with the separately pinned plan and original-job size/hash. All matched.
The custody workflow's compact receipt artifact is `14764348108`, 90,815 bytes,
SHA-256 `0b599df3e867c1acd95c7efd00d7e7d811edfb997cea2b00c6082eb7011a83b9`.
`artifacts.json` and `files.json` retain the original metadata and local hashes.

## Separate temporary-input hardening control

Review found that the original companion recomputed a temporary log's identity
before upload without explicitly comparing it again to the original pin. The
retainer's read-back was exact for those uploaded bytes, but a local log changed
after its first verified download could have been rebound. The original source
was reproduced with a same-length mutation in the controlled API fixture and
failed to refuse; `original-temporary-mutation-red.log` preserves that result.

Correction `ae7d1b9612d298818163ea7860d38a35d7a65ff6` checks the original independent
size and hash again immediately before upload and keeps those same pins through
read-back. `corrected-thirteen-controls.log` records all thirteen passing
controls, zero failures or skips, including that exact mutation refusal and safe
reuse without overwrite. This source change does not rewrite the completed
857 workflow or its receipts. The completed run's observed log hashes match
their original pins, so the controlled mutation did not occur in that run.

The failed evaluation remains failed. The earlier790 release mechanics do not
qualify the later composed implementation. No archive was extracted or executed,
no optimizer update was performed, no draft was published, and no new model
quality, serving, production or default-promotion claim follows from custody.
