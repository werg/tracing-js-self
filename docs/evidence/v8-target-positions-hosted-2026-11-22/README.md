# Hosted prepared-position coverage campaigns

Two separate frozen campaigns are running. No completed full-pass result is claimed by this preparation checkpoint.

| Campaign | Producer revision | Native optimizer revision | Separate update requirements |
| --- | --- | --- | --- |
| [45023684906](https://github.com/werg/tracing-js-self/actions/runs/45023684906) | `9cf091e6ccc5add960ef0897576d0c391b199a65` | `1a69d9da3254b7568c831d12866a629c206cf4fe` | Ordinary lifecycle 2; fresh complete coverage fit 348 |
| [45025994295](https://github.com/werg/tracing-js-self/actions/runs/45025994295) | `b4157952ed0fc28c5ae1eb8893cd9035ce25bbdb` | `2f3e6cf04aad60473e8ecc67e846e81e5b9dec83` | Ordinary lifecycle 2; fresh complete coverage fit 348 |

Both use the expanded `a952385535b9b5e19d737206286f6f26c149f7301c51b4b106fe3b1cae5ab55a` contract and exact production tokenizer. They are distinct executions with separately retained identities and results. The second additionally records balance-recorder eligible internal-router rows and expert assignments. Those counts do not independently establish exhaustive internal-router position coverage.

At the last recorded observation (22 November 2026, 13:46:12 UTC), both jobs had passed source admission for all 64 original support sources, complete production-tokenizer packing and strict preparation, and were in the ordinary lifecycle/full-pass training step. The workflow status does not expose a current optimizer update count. Their result fields therefore remain null in `campaign-checkpoint.json`.

`audit-retained-hosted-positions.py` prepares an additional read-only check of the completed artifacts. It preserves original configuration and receipt identities, independently reconstructs the prepared text labels/masks from local retained inputs, verifies checkpoint bindings and the separate two-update resume history, and checks recorder-counter increments where the frozen runtime captured them. This script has only been syntax/lint checked at this checkpoint; execution and success are not claimed. It performs no optimizer updates or decoder forward passes and cannot supply missing hosted training evidence.

Full prepared-text position coverage remains distinct from source-preparation correctness, exhaustive hidden-router coverage, unsupported media/structured objectives, real production compute, and learned behavior. None of the latter is inferred from these diagnostic support runs.
