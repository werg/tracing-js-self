# Execution-training baseline

This receipt applies only to producer `7b5ef549c711b9937ab8721ec607f55354047b97` (tree `e2894385051fdc57401dec5affac4f1ce26a2b39`).
Overall local status: **passed**. Native admission: **untested**.
No model optimization or learned execution is asserted by this baseline.

| Check | Result | Seconds |
| --- | --- | ---: |
| unit | passed | 233.66 |
| reference-fixture | passed | 0.07 |
| host-contract | passed | 0.08 |
| semantic-contract | passed | 0.11 |
| semantic-inspection | passed | 3.00 |
| teacher-mutations | passed | 8.12 |
| target-gallery | passed | 4.69 |
| target-gallery-compact | passed | 4.77 |
| summary-prototype | passed | 2.18 |
| capability-ledger | passed | 14.93 |
| source-registry | passed | 1.85 |
| corpus-engineering | passed | 26.35 |
| corpus-training-v4 | passed | 55.39 |
| corpus-benchmark-v1 | passed | 199.58 |

Each check retains its own stdout/stderr hashes and the producer identity before and after execution in `baseline.json`.
Original I/D/learning receipts retain their original revisions; the manifest binds their current bytes without transferring their qualification.
The next model experiment must first pass the native input/conditional parity gates and use newly qualified artifacts after any conditioning change.
