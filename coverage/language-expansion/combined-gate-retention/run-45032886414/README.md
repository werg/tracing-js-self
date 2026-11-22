# Cancelled causal recovery run 45032886414

This is a separate, incomplete run retained because its source pins match the older causal candidate. It is not a completed 151-native/170-Node proof.

- Producer commit: `e5d53e47b39ccc1699db6da0c6f53bb703b3dce2`.
- Native consumer commit: `56cce3b80423b0cb70c3a096d867561066e3a211`.
- Job `137240150945` (`paired-bootstrap-recovery`) was cancelled by GitHub Actions.
- Node runtime: `v24.22.3`; Python runtime: `3.12.14`.
- GitHub artifact `14759329444` (`durable-bootstrap-history-controls`), size 4,067 bytes, digest `sha256:a55a5f35dbc344097afc07e524d5e3fd4dc9911855070b99ebc49538ed8295a`.

## Retained outcomes

The native artifact has a complete JUnit file with **151 passed, 0 failed, 0 skipped**:

| Native test module | Pass | Fail | Skip |
|---|---:|---:|---:|
| `test_semantic_bootstrap_recovery_v8` | 17 | 0 | 0 |
| `test_semantic_close_recovery_v8` | 9 | 0 | 0 |
| `test_semantic_commit_recovery_v8` | 42 | 0 | 0 |
| `test_semantic_launch_v8` | 16 | 0 | 0 |
| `test_semantic_request_journal_v8` | 12 | 0 | 0 |
| `test_semantic_v8_position_receipts` | 55 | 0 | 0 |

The hosted Node command listed 14 test files and expected 170 leaves. It started at `2026-11-22T14:38:33.789Z`; the workflow was cancelled at `2026-11-22T15:06:52.530Z`. The retained `host-bootstrap-history.xml` contains only the XML declaration and opening `<testsuites>` element, with no testcase rows or closing element. It is an incomplete capture, not a valid completed test report. No Node leaf outcomes are counted here.

`complete-job-log.txt` is the original retained job log. The ZIP is the original uploaded artifact and its SHA-256 matches GitHub's artifact metadata. No tests were rerun during retention.
