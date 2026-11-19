# Bounded semantic summary prototype

These predictions are authored-diagnostic. The report measures independent checking and target bytes, not model learning or native qualification.

| Case | Verdict | Detailed records | Detailed bytes | Summary bytes |
| --- | --- | ---: | ---: | ---: |
| pure-helper | experimental_verified | 4 | 286 | 123 |
| dense-sum-coarse | experimental_verified | 29 | 2386 | 225 |
| dense-sum-checkpoints | experimental_verified | 29 | 2386 | 326 |
| false-intermediate | rejected | — | — | — |
| pure-control-helper | experimental_verified | 7 | 512 | 242 |
| false-control-with-correct-result | rejected | — | — | — |

Each evidence JSON retains the original prediction and context; accepted cases retain the detailed v5 execution archive and independent V8 original/operation/branch receipts. Rejected predictions are preserved without a corrected answer.

The summary context is supplied as a separate region task. Target bytes exclude its source, input graph, region metadata and other observed context; detailed target bytes likewise exclude their observed context. Native tokens, full-context costs and learned performance are unmeasured.
