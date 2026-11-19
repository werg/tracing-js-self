# Frozen base gallery: complete native admission

Producer: `4d6dace0446e743a80bc4770f59eec33fefd5730`.
Independent consumer: `ae62b491f14b3064fe69ee8c6d78ac7b17a597ce`.

All 11 declared gallery cases passed fresh source qualification and the actual native admission command. Each native receipt passed independent replay, exact contexts, continuation, generated-only masks, source binding, and the pinned real tokenizer.

Contract: `fe1eed56bafa5c0012354b29ebb3b40bbe33f085f063d6990fcb3f26cb261cc2`. This is the frozen base contract; these receipts do not qualify the subsequent protocol-state contract.

The archive preserves all exact source/admitted artifacts, native receipts, the report, and their hashes. Native packing uses physical record boundaries with no EOS token. Flat causal-LM EOS and prompt costs are a separate measurement.

| Case | Generated targets | Physical records | Generated tokens | Observed tokens |
| --- | ---: | ---: | ---: | ---: |
| compound-pure | 2 | 9 | 77 | 3432 |
| branch-1 | 10 | 35 | 356 | 12718 |
| object-alias | 2 | 7 | 74 | 2840 |
| pure-helper | 2 | 7 | 74 | 2760 |
| dense-loop | 2 | 9 | 74 | 3968 |
| throw-finally | 7 | 17 | 255 | 7568 |
| counter-0 | 11 | 40 | 343 | 15983 |
| rejection-finally | 11 | 42 | 389 | 13305 |
| callback-captured-write | 20 | 93 | 709 | 35742 |
| persistent-external-trigger | 28 | 141 | 953 | 57098 |
| redundant-cell-write | 2 | 7 | 74 | 2760 |

No external model was trained or evaluated. Optimizer steps are zero, model success is untested, and default promotion remains unqualified.
