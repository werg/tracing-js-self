# Actual native conditional mismatch

The real paired diagnostic **failed training/serving parity** at producer
`cb67ed15750760267d1bb6edd53b4190d349885c` and consumer
`272584270a00409cee6c7c49078c775faf24d16b`. The
[hosted engineering job](https://github.com/werg/tracing-js-self/actions/runs/44384520028/job/135085742048)
completed the numerical capture, then later failed in the separate prepared
coverage inventory. That later failure does not turn this completed diagnostic
into an incomplete measurement or a passing parity result.

## Measured result

The probe freshly source-checked and natively prepared `compound-pure`, saved a
real tiny checkpoint with seed 17 and **zero optimizer updates**, and reloaded
that same checkpoint through training and serving. It checked the physical
checkpoint identity at the initial read, export and both reloads. Dropout was
disabled. The observed public prefix and first target identities were equal.

| Measurement | Result |
| --- | --- |
| Diagnostic phase | Complete |
| Gaussian conditional comparison | Failed |
| Mean/log-scale coordinates compared | 256 |
| Absolute / relative tolerance | `1e-6` / `1e-5` |
| Maximum absolute coordinate difference | `2.4304623007774353` |
| First mean coordinate, training | `-0.24988460540771484` |
| First mean coordinate, serving | `0.02719087339937687` |
| Exact encoded request-control tensor | Identical |
| Full encoder-call audit | Different |
| Returned semantic selections / optimizer updates | 0 / 0 |
| Full conditional parity or learned execution claim | Neither |

The checkpoint state SHA-256 is
`1395a9cccf9b905bd621327c29f15ee7a0c99e6ae1f63af52e775f8605e89647`.
The served model SHA-256 is
`df2726f03886ffb07148e8ab62feccf9b402e551b87431af7c996e394166323e`.
Both actual model-state checks report unchanged weights.

## Inputs that agree and inputs that differ

The two original observed program/invocation records, the 580-byte framed
instruction, declared execution purpose, and 79-byte physical context-window
announcement agree. The complete real native paths still differ:

| Boundary | Training capture | Serving capture |
| --- | --- | --- |
| Session task metadata | `semantic_execution` | `semantic-execution/5` |
| Session modality metadata | Array `["text"]` | String `"text"` |
| Session version metadata | `v12` | `null` |
| Program ownership | Host track | Execution track |
| Invocation and generated-record ownership | Worker track | Execution track |
| Track-creation system observation | Absent from this prepared prefix | Present before program/invocation; 692 bytes |
| Committed history events at captured boundary | 10 | 11 |
| Encoder calls captured | 29 | 33 |

The original records retain track descriptions, purpose tensors, retrieval
events, positions and context policies. The event windows both use 1,024 local
and cross-track events for their execution track. A different track address
alone is not evidence of a learned-label defect; the observed ownership,
purpose, metadata and event-history differences are the relevant distinctions.

Ordinary training's random metadata omission is a separate declared
augmentation. This eval-mode capture uses all available training metadata, so
the table is not a random missing-field result. The serving lifecycle event is
real runtime behavior; this evidence does not justify removing lifecycle or
source-visibility checks to force agreement.

The separately bound decoder-source audit reports length support of **0–1024
in training versus 1–128 in this serving request**. Terminal supports agree.
The loaded lexical token-ID alphabets also agree, despite the labels `bytes`
and `utf8`; UTF-8 adds whole-payload validation. The downstream length,
terminal and lexical heads were not executed by this probe.

## Exact stopping point and limits

The hook stopped before the **Gaussian facet draw**, generated-target neural
encoding, downstream rendering, or a returned semantic selection. Serving
already evaluated and drew its singleton text-modality categorical. The
unchanged original report uses broader phrases such as “only ... Gaussian
was executed” and “before ... policy draw”; interpret those phrases with this
explicit qualification. They do not establish the absence of every earlier
internal categorical operation.

The mismatch establishes unequal actual conditional state at this checkpoint
and prefix. It does not identify one difference as the sole cause, explain all
historical failed learning, establish gradient correctness, or measure learned
execution. The earlier `dabca552…` capture obtained the same numeric comparison
before checkpoint-alias hardening; that repeat is an integration verification,
not an independent training seed or learning replicate.

The next native gate is shared, authenticated prefix construction that accounts
for metadata, lifecycle observations, public track ownership and context.
Rerun this actual comparison after that repair, then extend it to later and
callback prefixes before treating a new optimization run as a clean convergence
experiment. Gaussian agreement alone would still leave downstream action
support to qualify.

## Retained original evidence

`provenance.json` binds the workflow/job/artifact, original ZIP checksum and
each retained file. `report.json`, `comparison.json`, `training-conditional.json`,
the input-byte comparison, run identity and checkpoint/export manifests are
the original artifact bytes. The full serving capture and original repository
fixture are losslessly compressed as `serving-conditional.json.gz` and
`compound-pure.json.gz`; decompression must match the original byte counts and
SHA-256 values in the provenance. No large alphabet array was discarded.

`boundary-summary.json` is a derived, readable view of those captures. It is
not a replacement for the original vectors and byte records. The checkpoint
weights and complete five-recipe release are not committed here; this is a
bounded diagnostic evidence package, not a new dataset release. The hosted
artifact retains the checkpoint and full engineering job outputs under its
declared retention period. Reproduction uses the exact producer, consumer,
locked tokenizer/environment, seed and command in
[the diagnostic guide](../../NATIVE_CONDITIONAL_PROBE.md).
