# Campaign 45025994295 retained fit revalidation

The hosted exact64 ordinary lifecycle/coverage gate completed successfully. The original producer and native optimizer pair remains `b4157952ed0fc28c5ae1eb8893cd9035ce25bbdb` / `2f3e6cf04aad60473e8ecc67e846e81e5b9dec83`. This evidence keeps that runtime identity separate from the stricter read-only consumer at `622c37c23f93c4cc58ff226eb4805c766fee3166` (parent `7f0de371c44add866f463a493ae8f2edbbf372e0`).

## Result

- Source population: 64 unique IDs, split 48 train / 12 validation / 4 test.
- Distinct trajectories: ordinary lifecycle trained one update, resumed to two updates, and stayed explicitly unqualified for full-population coverage. A separate fresh coverage run performed 348 updates from global step 0 to 348. These are not a single 350-update path.
- Target receipt: 696 logical targets and 720 physical target records; original target inventory and exact one-pass receipt re-derived byte-for-byte in the stricter-reader comparison.
- Prepared position/mask audit: independent reconstruction matched the exact prepared positions, positive-weight lexical/reconstruction and categorical label counts, and final checkpoint position receipt. The 348 per-update metric summaries are continuous, monotone and terminate at the unchanged checkpoint receipt. Full receipts are not present on every metric row; they are reconciled against the retained final checkpoint.
- Router: actual per-update balance-recorder row/assignment accounting is complete across all 348 updates and reconciles with the checkpoint. Router coverage remains `unmeasured`; these aggregate counts do not establish independent router position coverage.
- Resume: original lifecycle checkpoint digests remain anchored across the one-to-two update continuation. The two-update lifecycle subset remains not full-population-qualified.
- Audit made zero optimizer updates. `learnedSuccess` remains null.

## Revalidation evidence and source identity

- `campaign-45025994295-strict-revalidation.json` records comparisons, current-reader hashes, all original checkpoint/metrics/config/tokenizer hashes, and no learned-quality claim.
- `source-map.json` hashes every source file changed in the frozen pair commits plus the exact files used by the stricter reader.
- `artifact-inventory.json` records SHA-256 for each of the 593 archive members and the full archive hash. The original hosted artifact SHA-256 is `4e4d26f10173d85182af3d189ba0d69a6327c90cdaba7ebd2adc5abc8758087e`; it expands to 517,660,755 bytes.
- The archive contains all 64 admitted source JSONs, prepared corpus and manifest, exact tokenizer, full-fit and resume checkpoints, served weights/config/lineage, target receipts, and per-update metrics. No donor or hindsight input was configured for this diagnostic tiny-model run.
- Runtime recorded in the retained fit is CPU reference mode (`torch 2.10.0+cpu`, Python `3.12.14`); CUDA behavior, production memory fit and throughput are not established.
- GitHub’s complete job-log endpoint returned `Transport closed` via the connected tool. Exact stage logs from the gate and training are in the artifact.

The archive is kept as a local, uncommitted file at `artifacts/original/semantic-v8-target-inventory-support-45025994295.zip`; it is 178,270,704 bytes. GitHub retains it until `2026-12-22T14:46:38Z`. The checked archive digest and per-member inventory are included here.
