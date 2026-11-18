# Bounded recovery of the six D worker timeouts

The complete D campaign recorded six `worker_timeout` outcomes at its 120-second
outer worker limit. A separate F campaign makes one fresh attempt per case at a
240-second worker limit. The original D campaign and its failures remain intact.
This is execution and admission evidence; it runs no optimizer or model.

## Frozen inputs and limits

The producer is `22eaac6a46e262b00986c63b4fc66f6240016252` and the consumer is
`1cee21dd07a687b0a824abff1bbd5ef9a13149ab`. The campaign uses the verified F native
environment, production tokenizer, `--require-native`, and the unchanged complete
D source registry, digest
`3518d930f2d486f81e6d914c5233b5475450b149d0036d1bee50364bf43e1498`.

All six source texts and argument lists were compared with the frozen F catalog.
They match the D candidates, and none has an earlier input preflight refusal.
Their candidate limits remain 20,000 owned steps, a 10,000 ms reference timeout,
and a 4,096 generated-token projection bound. The process retains the 768 MiB V8
heap limit and 268,435,456-byte output limit. Only the outer worker timeout rises
from 120,000 to 240,000 ms. One worker is used throughout.

The experiment began at 2026-11-18 13:47:27 UTC with a shared 1,500-second deadline.
A two-case pilot selects Collatz input `1000000` and sum-of-multiples input
`[[5,6,8],150]`. Its manifest is retained before the same campaign resumes the full
six-case selection. Resume reuses completed pilot receipts; it does not retry
their failures. Each candidate receives at most one fresh F attempt. No larger
timeout or further retry is authorized by this protocol.

## Retained evidence

The [execution declaration](evidence/timeout-recovery-F-declaration-2026-11-18.json)
contains all six exact reviewed inputs and expected values, source texts, original
failure records and checksummed candidate/result references, the original D
header and journal digests, the pilot selection, and the limits. It was archived
while the bounded experiment was running; it is not a pre-run statistical
registration or a result claim.

Raw campaign files are retained under `release-evidence-F/timeout-retry`. The
supervisor receipt, command arrays, phase logs, and pilot/final manifest snapshots
are retained under `release-evidence-F/timeout-retry-review`. These directories
are release evidence outside the source checkout and are intended for the final
artifact archive.

## Result status

The initial documentation commit records the protocol while execution is in
progress. A subsequent evidence increment will record each fresh result, its
actual wall time, the unchanged D checksums, and the final pin checks. No native
admission or recovered case is claimed by this initial record.

An outer timeout shows only that the worker did not finish in that wall-time
budget. It does not prove a language mismatch or completion within the owned-step
budget. Conversely, any newly completed budget/profile refusal remains a refusal.
Available worker peak-RSS receipts will be reported as measured; null values will
remain unmeasured. The V8 heap limit is not a kernel process-tree memory quota.
