# Measured native window and context costs

The completed 49-update diagnostic has an exact, tokenizer-specific cost report.
The largest new training window contains **2,163 native transcript tokens**; the
largest window including its reconstructed prefix contains **5,089**. A generated
physical record directly reads at most **84 historical native events / 336 facet
slots** in this run. The maximum prepared-text contribution to a generated
record's visible history is **5,083 token IDs**. These are different measurements;
none is a replacement for a flat lexical prompt length.

[The compact receipt](evidence/native-context-costs-2026-11-18.json) binds the
complete 1,470,931-byte derived report, the original training artifacts, exact
native implementation files and tokenizer. The original run's model results
remain unchanged: these measurements do not establish learned semantic success.

## Exact input and validation scope

The input is the already completed `optimization-full-epoch` diagnostic:
32 actual prepared examples, 29 families, 49 native windows and 9,379 supervised
lexical token positions. Its producer is
`c4296c271eec32c2f2ab4cd34c30fd8b61e6ba39`; its consumer is
`277edd4a2983e81f5e2a71b34a7ce29348e4e7a0`.

The read-only [profiler](../tools/native_context_costs.py) uses the existing native
`PreparedCorpus`, `ByteCodec`, `WindowStream`, `window_config`, context policy,
retention rule and transducer boundary planner. It checks the concrete checkpoint
state checksum, exact configuration, tokenizer identity, prepared corpus and
stream fingerprints, each saved window's record IDs and offsets, actual final
stream cursor, and source exposure. Totals reproduce the actual checkpoint's
`D`, `I`, reconstruction tokens and physical-record counters exactly.

For this pinned trainer, bank-only retrieval deterministically inserts one
metadata event and a query/knowledge pair at each native planned lookup. The
profiler includes these events in history ownership and age. It verifies every
window's final retained-event count, planned lookup count and gradient-observed
lookup count against the actual recorded metrics. Reconstructed-prefix lookups
are separated from scored-window gradient observations. Metadata field dropout
changes its payload, not this event chronology.

The tool refuses native action tapes, media, mounted collection retrieval,
non-teacher-conditioned continuations, reserved physical track collisions,
unsupported training configurations and inconsistent saved evidence. It uses the
native policy to reject future/same-group pins, insufficient pinned-history
capacity and split meridians. It does not instantiate a model or run an optimizer.

## Actual measurements and configured limits

| Quantity | Actual measurement | Meaning / configured limit |
| --- | ---: | --- |
| New transcript tokens, all windows (`D`) | 50,069 | Physical source and generated records consumed as new data |
| Reconstructed prefix transcript tokens | 36,383 | Previously consumed records re-encoded under updated weights |
| Total ingested transcript tokens (`I`) | 86,452 | New plus reconstructed tokens; a workload total, not context length |
| Supervised lexical positions | 9,379 | Actual policy-scored positions; native `P` also charges a separate reconstruction objective |
| Maximum new tokens per window | 2,163 | Configured new-window limit: 16,384 |
| Maximum reconstructed prefix tokens | 4,954 | A replayed prefix; distinct from the new-window limit |
| Maximum window plus prefix tokens | 5,089 | Actual maximum across 49 windows, not the sum of separate maxima |
| Maximum generated positions per window | 357 | Sum of scored positions in that window |
| Maximum physical-record likelihood positions | 908 | Configured generated-record capacity: 1,024 positions |
| Maximum new / reconstructed physical records per window | 16 / 48 | New-record limit: 16; reconstruction is separate |
| Maximum history directly visible to a generated record | 84 events / 336 facet slots | Includes metadata and latent retrieval events; four facets/event |
| Maximum visible prepared-record text contribution | 5,083 token IDs | Excludes unlogged metadata tokens and nonlexical query/knowledge values |
| Maximum retained native history | 85 events | Derived from native rules; configured global capacity: 1,024 events |
| Maximum observed window-end retained history | 85 events | Exactly matches all 49 actual endpoint metrics |
| Maximum observed window-end KV-cache bytes | 43,520 bytes | Actual native key/value tensor storage at window end; neither process RSS nor within-window peak allocation |
| Maximum new / ingested payload bytes per window | 6,303 / 15,812 bytes | Original-byte measures, separate from tokenizer counts |

The actual configuration uses 256 local history events and a 16-global-event
foreign-history window. The policy applies those limits by reader track and
retains whole native groups; summing all preceding payloads would not implement
that visibility rule.

## What remains unmeasured

`maxFlatModelPromptTokens` and `maxFullHistoricalPayloadTokenIds` remain `null`.
The model directly reads recurrent event facets, and information already
summarized in those facets has no measured equivalent flat lexical prompt.
Training also randomly drops metadata fields without saving each resulting
payload; therefore its exact historical tokenizer contribution cannot be
recovered from these artifacts. Query and knowledge events are latent values,
not lexical records. Track-description controls and within-record decoder state
are separate again.

The 5,083-token value is the **prepared-text contribution under the actual native
history membership**, not an invented complete-context number. The report leaves
the producer's historical `maxModelContextTokens: null` difficulty field intact.
It covers this completed diagnostic and cannot automatically supply context
measurements for a different tokenizer, model geometry, runtime policy or corpus.

## Reproduce without new training

Use the exact consumer checkout and the original run's compatible locked Python
environment. The output must be a new path outside the immutable run and consumer
roots; the profiler never overwrites a report.

```sh
PYTHONDONTWRITEBYTECODE=1 TZ=UTC OMP_NUM_THREADS=1 MKL_NUM_THREADS=1 \
  ../native-venv/bin/python tools/measure-native-context-costs.py \
  --training-run ../release-evidence/optimization-full-epoch \
  --consumer-root ../megatoken \
  --tokenizer-json ../tokenizer.json \
  --maximum-windows 49 --timeout-seconds 120 \
  --out ../release-evidence/native-context-costs/new-report.json
```

The measured pass took **4.97 seconds** within the declared 120-second limit,
with zero new optimizer steps, model executions or admissions. The 18 focused
[contract tests](../test/test_native_context_costs.py) passed. They exercise
internal events, same-group visibility, local versus foreign history, whole-group
retention, pins, exact window identities, distinct token/byte meters and rejected
metric tampering; their synthetic inputs are not learning evidence.
