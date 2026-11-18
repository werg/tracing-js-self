# Bounded recovery of the six D worker timeouts

The six original D timeouts have been reviewed: **two received a fresh F attempt
and again timed out at 240 seconds; four were not relaunched because conservative
instruction-count proofs exceed their unchanged 20,000-step limit.** There are
no new admissions. The original D campaign and all six 120-second timeout
records remain intact. The bounded experiment completed in **533.298 seconds**,
well within its 1,500-second ceiling. No optimizer or model was run.

## Frozen inputs and limits

The producer is `22eaac6a46e262b00986c63b4fc66f6240016252` and the consumer is
`1cee21dd07a687b0a824abff1bbd5ef9a13149ab`. The campaign uses the verified F native
environment, production tokenizer, `--require-native`, and the unchanged complete
D source registry, digest
`3518d930f2d486f81e6d914c5233b5475450b149d0036d1bee50364bf43e1498`.

All six source texts and argument lists were compared with the frozen F catalog.
They match the D candidates, and none has an earlier input preflight refusal.
Their candidate limits remain 20,000 owned steps, a 10,000 ms reference timeout,
and a 4,096 generated-record projection bound. The process retains the 768 MiB V8
heap limit and 268,435,456-byte output limit. Only the outer worker timeout rises
from 120,000 to 240,000 ms. One worker is used throughout.

The experiment began at 2026-11-18 13:47:27 UTC with a shared 1,500-second deadline.
Its two-case pilot selected Collatz input `1000000` and sum-of-multiples input
`[[5,6,8],150]`. The original plan was to resume the full six-case selection after
preserving the pilot manifest. During the pilot, a second agent's read-only
analysis of F's exact compiled instructions proved that the other four cases
cannot complete within the existing step budget. The remaining selection was
therefore narrowed at **13:55:30 UTC**, before the pilot finished at **13:55:56
UTC**. The original six-ID file and its hash remain preserved; a separate
timestamped amendment records the reduced selection and exact proof snapshot.

The final resume reused the two pilot receipts and launched **zero** additional
workers. It finished at **13:56:21 UTC**. Both manifests are retained, and the
two complete case rows are equal across them. No case was retried twice, no
larger timeout was used, and the four static exclusions have no invented fresh
worker result.

## Retained evidence

The [execution declaration](evidence/timeout-recovery-F-declaration-2026-11-18.json)
contains all six exact reviewed inputs and expected values, source texts, original
failure records and checksummed candidate/result references, the original D
header and journal digests, the pilot selection, and the limits. It was archived
while the bounded experiment was running; it is not a pre-run statistical
registration or a result claim. The
[final audited receipt](evidence/timeout-recovery-F-result-2026-11-18.json) retains
the execution commands, phase costs, selection amendment, exact bytecode paths,
fresh case entries/results, all file digests, and verification assertions.

Raw campaign files are retained under `release-evidence-F/timeout-retry`. The
supervisor receipt, command arrays, phase logs, and pilot/final manifest snapshots
are retained under `release-evidence-F/timeout-retry-review`. These directories
are release evidence outside the source checkout and are intended for the final
artifact archive.

## Per-case findings

The IDs below omit only the common `real-exercism-` prefix. All six original D
results remain `worker_timeout`; the disposition column describes the new review.

| Case ID | Exact input summary | Fresh F disposition | Conservative instruction lower bound |
| --- | --- | --- | ---: |
| `8b979a00871f99a9f68a610e` | Collatz `1000000` | `worker_timeout`, 240.060 s | No sufficient exclusion established |
| `3c5cba33a7be51917cdfd79f` | Knapsack, capacity 104, eight items | Not relaunched: proven over unchanged step budget | 45,760 |
| `9b519d4b8c7cce2c41f9d66e` | Knapsack, capacity 750, fifteen items | Not relaunched: proven over unchanged step budget | 618,750 |
| `82ce06dd65e96b609fe02b64` | Sum of multiples `[[3,5],1000]` | Not relaunched: proven over unchanged step budget | 21,978 |
| `6892c97747d30be1d93519d9` | Sum of multiples `[[5,6,8],150]` | `worker_timeout`, 240.106 s | 3,278; does not rule out completion |
| `a551ef5f16be427172286722` | Sum of multiples `[[43,47],10000]` | Not relaunched: proven over unchanged step budget | 219,978 |

The exact item arrays, expected values, and source bytes are in the declaration.
The static analysis compiles those exact source bytes with frozen F's frontend;
it does not execute guest code. For each loop it finds a shortest path from the
loop target to its backward jump and counts the instructions on that path.
Knapsack needs at least 55 instructions per inner iteration: `8 × 104 × 55` and
`15 × 750 × 55`. Sum-of-multiples needs at least 16 loop instructions plus the six
straight-line instructions in one mandatory callback invocation. Every supplied
multiples array is nonempty, so its bounds are `(limit − 1) × 22`.

These bounds deliberately omit initialization, additional callback visits,
arithmetic microsteps, callback scheduling, and the final return checks. F's
`Runtime.drive` counts a step before calling `step`; `step` consumes at most one
bytecode instruction. Arithmetic and pending callback transitions add steps.
These sources are synchronous and contain no native effect or `await` that could
return control to the driver and reset a drive budget. Thus any supported normal
completion of the four excluded candidates requires more than 20,000 steps.
Earlier unsupported or other failure outcomes remain possible. The proof does
not assert that an actual worker reached its step-limit exception.

## Verification and measured cost

The audit verified the original D header, complete append-only journal, manifest,
and all six checksummed candidate/failure objects without changing them. For the
two retried cases, the complete rehydrated candidate content and compressed CAS
references are equal between D and F, including inputs, provenance, registry, and
candidate limits. Their campaign-bound cache digests intentionally differ because
F has different producer/consumer pins and a different outer timeout. The
successful cache-only resume independently rebuilt and checked the F cache
identities.

Both F journal entries have attempt number one and a valid chained entry digest.
The pilot and final manifests both retain the full 1,171-candidate registered
catalog and the same source-inventory digest. The final selection contains only
the two pilot cases, as recorded in the amendment. The producer and consumer
tracked trees still match their exact clean pins.

| Measurement | Observed value |
| --- | ---: |
| Overall bounded supervisor wall time | 533.298 s |
| Pilot controller wall time, including startup | 508.764 s |
| Two fresh worker wall times combined | 480.166 s |
| Cache-only resume wall time, including startup | 24.525 s |
| Original D worker wall time for the same two inputs | 240.079 s |
| Original D worker wall time for all six inputs | 720.412 s |
| Fresh candidate executions / cache reuses | 2 / 2 |
| Native admissions / admitted generated tokens | 0 / 0 |
| Optimizer updates / model executions | 0 / 0 |

Both phase exit codes are one, the collector's expected non-admission result.
The supervisor completed normally. Neither terminated worker returned a peak-RSS
receipt; peak RSS and CPU time are **unmeasured**, not zero. The manifest's
fallback aggregate of zero is not treated as an RSS measurement. The V8 heap
limit is not a kernel process-tree memory quota.

The remaining measured limitation is specific: Collatz `1000000` and
sum-of-multiples `[[5,6,8],150]` did not finish the full producer verification
pipeline within 240 seconds. Their partial internal phase/step progress was not
returned, so these receipts do not identify the exact bottleneck or prove a
language mismatch. Further work would require a separately bounded performance
investigation or a changed policy; no additional retries or larger limits were
used here. The four proven-over-budget cases require a different declared step
budget or smaller inputs before they can be candidates for successful normal
completion. Any such later campaign must retain fresh identities and receipts.
