# Final 47-case pair and history supplement

This bundle adds the fresh paired qualification at producer `090e634fdb6383a8774f16fab8cce07b696ce6f9` / consumer `0351fe9607735898da441458fdf7182e20a9ace5`, the actual-model checkpoint history proof, both complete consumer CI runs, the full P090 suite result, and focused history logs. It is supplemental to the previously retained 515-file evidence bundle. No model weights or tokenizer are duplicated; `metadata/shared-dependencies.json` pins their exact paths and hashes in that committed archive.

## Fresh exact pair

Producer tree `a13d44b8239f6a38aa9c44300db6c7d0c2b745dd` and consumer tree `e4c12a0d362429c1c64baecab28d67808031868e`. All four gates passed: source admission **47/47**, native admission **47/47**, exact costs **47/47 measured**, and native packing **measured for 47/47**. Flat costs: 56,597 generated tokens, 55,388 detailed tokens (97.86%), 1,789 terminal tokens, and 2,951,658 observed-and-context tokens, for 3,010,044 total tokens. Native packing recorded 6,920 physical and 1,948 logical records, including 3,013,123 observed-and-context tokens and no terminal tokens. Model execution and native serving remain unmeasured; this is not a learned usefulness or default-promotion claim. Full source/native/cost inputs, receipts, and logs are under `fresh47-p090e634-c0351fe9/`.

## Actual-model history proof

Producer `070bad4409b42f54ff43d472c47ace0d72c46210` / consumer `0351fe9607735898da441458fdf7182e20a9ace5`. The proof recorded 1 acknowledged model record and 2 explicit cuts. A fresh service restored the later cut authorized by the independently retained head at position 2, using the older packet from position 1. It matched the complete host checkpoint, complete native checkpoint and all consumed attempts, with monotonic costs and independent source/projection/public replay checks of the exact original source prefix. The next output bytes matched exactly but were **refused**: `nextSelectionExact` is false, it was not acknowledged, and there were zero host dispatches. The earlier failed attempt is retained in full under `actual-history/first-failed-attempt/` and its launch log; it stopped at malformed model bytes. No completeness, held-out, or generalization claim is made.

## Consumer CI

The canonical JSON run at consumer `84dee6ab3da55f164001d6d127ce4bc6f8eaa661` passed 579 tests with no failures, errors, or skips. The final published consumer `0351fe9607735898da441458fdf7182e20a9ace5` passed 604 tests with no failures, errors, or skips. Logs, XML results, identities, and policy files are retained under `consumer-ci/`; pytest temporary model artifacts are omitted.

## Full P090 suite and retained failure

Producer `090e634fdb6383a8774f16fab8cce07b696ce6f9` full suite ended **2,353 passed, 1 failed, 6 skipped** (2,360 total). The reference fixture passed 8/8. The one suite failure is the legacy journal canonical-hash regression, preserved in the full Node test log and hosted selected-journal failure log. These results remain failed historical evidence; they are not promoted to a passing suite.

## Shared model and tokenizer dependencies

The actual-history run and fresh-pair costs refer to bytes in the existing 515-file archive at commit `5eeddef47caeb8300094211a9b4cb6020c60ab70`. Its archive SHA-256 is `7dd052a8dd72bc90760360aa3de02fcbf62d716cf47a6c10623e9ac44ce4884a`. The machine-readable manifest `metadata/shared-dependencies.json` records the Git inventory blob SHA, archive member paths, byte lengths, SHA-256 hashes, and restore instructions. Restore that committed archive first, then use the exact pinned fitted model and tokenizer members there.

## Restore this supplement

Verify the compressed chunks and every archived member with:

```sh
python3 tools/restore-retained-evidence.py --inventory docs/evidence/semantic-v8-final47-pair-090e634-0351fe9-supplement/inventory.json
python3 tools/restore-retained-evidence.py --inventory docs/evidence/semantic-v8-final47-pair-090e634-0351fe9-supplement/inventory.json --out /absolute/path/to/new-directory
```
