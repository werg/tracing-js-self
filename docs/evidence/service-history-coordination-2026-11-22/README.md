# Service/history coordination and prior hosted qualification

## Delivered boundary

The service coordinator first published at `d1e304557f1ef795eb582de197c4b7eedf87f6f1`
is connected to selected-driver cancellation and recovery in the enclosing
implementation commit. Checkpoint policy binds the complete declared service
set. Every service terminal is durably acknowledged and independently inspected
before the requested terminal history entry. Both later terminal phases retain
the exact service proof. Terminal recovery reads the actual service journals;
active recovery refuses a partial/full terminal or stale service owner.

An exact live retry is allowed only after a service-fence failure that preceded
terminal history and native close. Lost history acknowledgements cannot use that
retry. This is ordered fail-closed coordination, not distributed atomicity.
Already admitted work may finish. Process death after service fencing but before
terminal history remains an explicitly refused active recovery requiring
supervisor reconciliation; no successful native close is inferred.

## Local verification

`integrated-115.log.gz.b64` records **115 passed, zero failed, zero skipped** on Node
24.22.3 for these complete files:

```sh
TMPDIR=<writable temporary directory> node --test \
  test/semantic-service-coordinator-v8.test.js \
  test/semantic-service-fence-v8.test.js \
  test/semantic-service-history-v8.test.js \
  test/semantic-selected-history-automatic-v8.test.js \
  test/semantic-selected-history-v8.test.js \
  test/semantic-selected-history-tail-v8.test.js \
  test/semantic-selected-history-storage-v8.test.js \
  test/semantic-durable-service-v8.test.js
```

The first invocation used an unavailable system temporary directory; the first
rerun exposed a test setup that tried to mutate a frozen owner receipt. The
mutation control now supplies a mutable receipt copy. An earlier history run
lacked `catalog/operations.json` in the sparse checkout; restoring that tracked
input corrected the environment. All three original failed logs are retained.
The 28-component and 50-integration selections overlap the final 115 and are not
additive. Model-shaped snapshots are supplied test fixtures, not learned output.

## Historical hosted evidence, separately pinned

Run [44959532480](https://github.com/werg/tracing-js-self/actions/runs/44959532480)
used producer `a494f007f7373fa4d96b76be88c5610fb815d6e8` and consumer
`776519e69b32b11927edd60eab84c77cebfe2a9c`. It does not qualify later code.

| Population | Completed evidence | Other dispositions |
| --- | --- | --- |
| Selected 66 | 66 source/native/token/packing passes; 77,765 generated tokens plus 2,406 EOS; 9,286 physical / 2,603 logical packing records; ordinary lifecycle passed at exactly two optimizer updates. | Learned success remains null; installed gate skipped for this matrix member. |
| Gallery 11 | 11 source/native/token/packing passes; 3,378 generated tokens plus 97 EOS; 424 physical / 169 logical packing records. | Ordinary lifecycle and installed gate intentionally skipped for this matrix member. |
| Original 665 | 665 source and native passes; 689 native tests passed earlier in that job. | Job cancelled during token measurement; complete token/packing, lifecycle and installed gates did not complete. |

The populations remain separate; no unique-case sum is claimed. The selected
native test selection also records 689 passes and overlaps the other matrix jobs.
Flat framing and packing-stream observed-token totals are different measurements.

The selected and cancelled original job logs are retained as gzip/base64 text.
Decode a `.log.gz.b64` file with `base64 -d < FILE | gzip -d`; the full original
text is retained, not just the matching summary lines. Gallery
reports were extracted from its downloaded archive after verifying its digest.
The complete large archives remain GitHub Actions artifacts with their original
retention period; this directory is **not** a claim of permanent full archive
retention. Their identities are:

| Artifact | ID | Bytes | ZIP SHA-256 |
| --- | --- | --- | --- |
| Original 665, cancelled | 14730540879 | 48,103,947 | `856216451e3f2c56730549f6c97e7e49b88cac14072319fd124b3970d5ce70d7` |
| Selected 66 | 14729772222 | 133,348,871 | `5f9d8cd9cd7984b2a11cbd4748ab98428efe9e85946e6a5d566c12836110de81` |
| Gallery 11 | 14729427563 | 1,124,336 | `8adad5596193d06a87f48139ba95dec86f57345966f63dd8bbf9c510b58e1804` |

`historical-jobs.json` was observed before cancellation, so its original665 row
still says in progress. The retained final job log records the cancellation.
`SHA256.json` binds the retained input/log/report bytes. Full current-pair hosted
qualification, permanent complete packet retention, coordinated ownership change,
callbacks/resources, incoming-input atomicity, rotation, rollback and learned
quality remain open in the main 17-package ledger.
