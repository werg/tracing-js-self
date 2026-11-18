# Complete current diagnostic CI evidence — 2026-11-18

This bundle preserves all eight original ZIP artifacts from real-corpus workflow 44321402482 and the complete original Exercism ZIP from workflow 44321402501. All nine ZIPs remain unchanged. They total 26,762,547 bytes and contain 25 original file members. API byte counts and SHA-256 digests match, and every ZIP member was streamed through its CRC check and separately hashed. No original ZIP was extracted.

Both workflows were triggered for durable pull-request head `1e2e6a0de8952c4349edbeef46ab70c4a06f8157`. Their actual integration checkout was synthetic merge `3497ee3454ea75715db1bc50c3e7cfc35ecc0fc2`, verified in all nine job logs. These diagnostics are distinct from the native workflow, which explicitly checked out the durable head.

Real-corpus completed all eight jobs successfully. It requested, accepted and verified 936 observations across 78 original functions, with zero mismatches, throws or errors. The observation audit counted 27,039 events and 3,656 mutation events. Its initial owned subset verified 156/156 invocations. The six complete partitions and final audit verified all 936/936 owned invocations, with status `locally_verified` and no refusal rows.

Exercism attempted 361 cases across 20 exercises: 132 locally verified and 229 explicitly refused. Ten exercises yielded verified cases. Its novelty selector rechecked all 132 local episodes and selected 61 distinct paths across ten families. The complete original report, all refusal classifications, retained local episodes and novelty selection remain inside its unchanged ZIP. Its diagnostic profile still refuses some values and completions supported by the separately qualified native pipeline; these labels must not be conflated.

This bundle makes no native-admission or learned-success claim. The two workflows and every original artifact identity are recorded in `artifact-index.json`; the full decoded GitHub job logs and parsed summaries are included. The index checksums every other bundle file, and its own bytes are bound by the separately reported archive SHA-256. There are no signed download URLs or private file-library identifiers in the index.

After unpacking this outer archive, run `python3 verify_bundle.py` to recheck every indexed file and all original ZIP-member hashes and CRCs without extracting those ZIPs.
