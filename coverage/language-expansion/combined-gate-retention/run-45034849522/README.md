# Combined recovery hosted run 45034849522

Frozen producer: `9a69dfc5b33c5e0eafec737a302e941f869bb5a1`  
Frozen native consumer: `15844c00c095849755ca6f0e1d207f7db79a9264`  
Workflow branch: `codex/v8-causal-terminal-composed-20261122`

This directory preserves the original hosted evidence for the four-lane combined recovery run. It keeps each lane's XML, runtime identity, test manifest, and original artifact ZIP where uploaded. All four artifacts are verified against the SHA-256 digests returned by GitHub. The runner logs are retained byte-for-byte as UTF-8, including their final newlines; the transport runner log was copied from the original retained run evidence.

## Lane outcomes at this evidence increment

| Lane | Producer/consumer tests | Outcome | Artifacts |
|---|---:|---|---|
| Structural | 123 Node; 165 native | 123 Node pass and 165 native pass; 0 failures/skips in either population | `structural.zip`, `structural-complete-job-log.txt` |
| Transport | 33 Node | 28 pass, 5 fail, 0 skip | `transport.zip`, `transport-complete-job-log.txt` |
| Terminal history | 16 Node | 14 pass, 2 fail, 0 skip | `terminal-history.zip`, `terminal-complete-job-log.txt` |
| Bootstrap history | 21 Node | 20 pass, 1 fail, 0 skip | `bootstrap-history.zip`, `bootstrap-history-complete-job-log.txt` |

The transport denominator is the original hosted run. Its five failures remain recorded: four producer-fault controls passed unsupported `--fault none` through the fixture enum and failed before the intended storage ambiguity; the fifth expected the older `selected-commit producer request` wording while the stricter zero-RPC guard correctly refused the wrong recovery operation. The five selected local controls after the two-line correction are retained separately under `corrected-five-local-controls/`; they do not change the hosted 28/33 result.

The two terminal failures are both in `semantic-known-service-close-history-v8.test.js`:

- `service-owned known close recovers only after exact same-owner authority and preserves it across process loss`
- `service-owned settled cancellation preserves its exact owner and terminal fence`

Both reach `buildRecoveredTerminalCloseV8`, which revalidates the frozen checkpoint with the raw caller policy. The checkpoint includes the retained `serviceAdmission` owner snapshot, while the raw policy passed to the builder does not. The exact failure and stack are preserved in the terminal XML and runner log. This is a producer recovery-path mismatch; no source was changed in this evidence worktree.

The single bootstrap-history failure is `bootstrap recovery refuses changed owner scope, absent clock or mixed recovery authority before native RPC`. At `semantic-known-bootstrap-history-v8.test.js:289`, the control expected `/distinct exact native boundaries/`, but the implementation rejected both supplied recovery authorities earlier with `one exact native recovery operation is required`. This is a refusal-message expectation mismatch. The exact XML and stack are preserved. The lane completed normally in about 27 minutes with exit code 1; it did not time out.

The slowest complete bootstrap-history cases were the baseline two-child fixture (190.591 s), later-sibling create recovery (296.024 s), and later-sibling bootstrap recovery (307.295 s). All 21 JUnit testcase rows are present. These timings show expensive end-to-end native-history cases; they do not identify which sub-operation accounts for the runtime.

The separate cancelled causal run `45032886414` reached the workflow's 35-minute job limit: its job began at `14:31:41.2207914Z` and the runner cancelled it at `15:06:52.5301245Z`. Its Node command had started at `14:38:33.7891740Z`, and the partial XML contains no leaf outcomes. The present bootstrap-history lane has a complete XML with 21 testcase rows, so that earlier cancellation is not evidence of a blocked test latch. Static inspection of both history test files found no latch/deferred/event waits; the test runner had no per-test timeout, and JUnit-only reporting retained no intermediate leaf output.

## Leaf counts by test file

### Structural Node controls

| File | Pass | Fail | Skip |
|---|---:|---:|---:|
| `native-request-journal-v8.test.js` | 8 | 0 | 0 |
| `selected-orchestration-clock.test.js` | 5 | 0 | 0 |
| `semantic-known-bootstrap-builder-v8.test.js` | 26 | 0 | 0 |
| `semantic-known-commit-builder-v8.test.js` | 6 | 0 | 0 |
| `semantic-selected-history-automatic-v8.test.js` | 21 | 0 | 0 |
| `semantic-selected-history-tail-v8.test.js` | 13 | 0 | 0 |
| `semantic-selected-history-v8.test.js` | 20 | 0 | 0 |
| `semantic-selected-orchestration-checkpoint-v8.test.js` | 20 | 0 | 0 |
| `semantic-selected-orchestration-v8.test.js` | 4 | 0 | 0 |

### Structural native controls

| Test module | Pass | Fail | Skip |
|---|---:|---:|---:|
| `test_semantic_bootstrap_recovery_v8` | 30 | 0 | 0 |
| `test_semantic_close_recovery_v8` | 9 | 0 | 0 |
| `test_semantic_commit_recovery_v8` | 42 | 0 | 0 |
| `test_semantic_launch_v8` | 16 | 0 | 0 |
| `test_semantic_request_journal_v8` | 13 | 0 | 0 |
| `test_semantic_v8_position_receipts` | 55 | 0 | 0 |

### Transport controls

| File | Pass | Fail | Skip |
|---|---:|---:|---:|
| `semantic-native-durable-bootstrap-v8.test.js` | 4 | 5 | 0 |
| `semantic-native-durable-close-v8.test.js` | 7 | 0 | 0 |
| `semantic-native-durable-commit-v8.test.js` | 11 | 0 | 0 |
| `semantic-native-orchestration-recovery-v8.test.js` | 6 | 0 | 0 |

### Terminal history controls

| File | Pass | Fail | Skip |
|---|---:|---:|---:|
| `semantic-known-close-builder-v8.test.js` | 5 | 0 | 0 |
| `semantic-known-close-history-v8.test.js` | 9 | 0 | 0 |
| `semantic-known-service-close-history-v8.test.js` | 0 | 2 | 0 |

### Bootstrap and commit history controls

| File | Pass | Fail | Skip |
|---|---:|---:|---:|
| `semantic-known-commit-history-v8.test.js` | 9 | 0 | 0 |
| `semantic-known-bootstrap-history-v8.test.js` | 11 | 1 | 0 |

## GitHub artifact identities

- Structural: artifact `14759945273`, 10,303 bytes, SHA-256 `08b5b596462e6a9d3ee14801367d62773a8bffb51661f154d3c9858930889333`.
- Transport: artifact `14759137172`, 4,102 bytes, SHA-256 `949b591492d62353bba5b0d2d494671db2e6bba429414c8bf28e5516cb3a4bc0`.
- Terminal: artifact `14759806877`, 2,805 bytes, SHA-256 `9b5480ecf7eb4bdf109f588428d5f4623ff6248c6dfa93a897a31308c6d3adc6`.
- Bootstrap history: artifact `14760630501`, 2,973 bytes, SHA-256 `f0cb516823b131aefe84231ff409a8f006fff505ce071be589a75dc1d8ad33ec`.

`SHA256SUMS` records the current file hashes. Raw test XML and runner logs are retained as received; the per-lane README counts are derived by reading those XML files. No hosted tests were rerun as part of retention.
