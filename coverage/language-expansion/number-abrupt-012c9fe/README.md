# Direct and nested Number callback throws

The complete declared supplementary population produced **2 source/native/token
admissions** and **0 explicit source refusals** at producer
`012c9fe49a082319bf98ac0c571596da925741a4` and independent consumer
`39c4036564428e44cc89caf261f517d856482695`. Both Git checkouts were clean and unchanged before
and after execution. The run started at `2026-11-20T17:38:03.821Z` and finished at
`2026-11-20T17:38:51.547Z`. The native subprocess deadline was explicitly 120 seconds.

This is a separate **2-case supplementary population**, extracted from
the literal source cases in `test/semantic-protocol-number-source-v8.test.js` (SHA-256
`bce2c163874b275aa37186992ecf9b0b63f24fa7d7fe3aede7ff2ca8b56f32b1`). It does not add cases to the frozen 665 expansion,
26 interoperability or 11 gallery denominators. Those independently executed
populations retain their own reports; cases may overlap between inventories.

## Qualified behavior

The direct callback throws before fallback selection. The nested callback
preserves both conversion operations and their exact abrupt result. The helper
checks that every conversion ends in the abrupt phase with no primitive result,
then independently admits all published contexts and continuations.

Every admitted case passed independent native replay, every published context,
checkpoint continuation, generated-only masks, live source binding and actual
production-tokenizer checks. Exact source artifacts, compact JSON native
transports, receipts and completion values are retained.

| Case | Completion | Published contexts |
| --- | --- | --- |
| `number-abrupt-direct` | `{"kind":"throw","value":["num",7]}` | 14 |
| `number-abrupt-nested` | `{"kind":"throw","value":["num",5]}` | 22 |

## Refusals and remaining limits

This two-case population declares no refusal examples.

These two cases qualify synchronous data conversion callbacks. Accessor
selection, implicit conversion TypeErrors, array stringification and asynchronous
or exotic callbacks remain outside this measured population.

Refused cases remain in the declared denominator and have no exported artifact,
native admission or token-cost claim. No unexecuted case is counted as supported.

## Exact physical costs

| Case | Generated | Flat EOS | Flat submitted context | Flat total | Native observed/context | Native physical records |
| --- | --- | --- | --- | --- | --- | --- |
| `number-abrupt-direct` | 442 | 14 | 13,529 | 13,985 | 14,240 | 40 |
| `number-abrupt-nested` | 662 | 22 | 23,852 | 24,536 | 24,533 | 64 |

Generated target counts agree between flat serialization and native packing in
every admitted row. Flat `semantic-causal-lm/4` records each include an explicit
EOS; native physical framing records its own observed/context counts and has no
terminal token. These conventions remain separate. There are **0
compact-containing** and **2 wholly detailed/protocol**
executions, and detailed/protocol targets account for **100.00%**
of generated tokens. Every physical prompt, target, EOS and loss mask is retained.

The tokenizer SHA-256 is `40fb9d7d7795b8bd305aeff39ce9963f3f450915b9553f2938e009be9a1fed60` and its identity
is `7f52faca2fe82273a889023defd2f1a6fd6080a21096ec77e97f4798a0a370b2`. The report binds the actual codec,
Python and tokenizer-library identities. This population measures admission and
physical tokens, not model accuracy, serving latency or cache reuse. Its own
optimizer-step count is zero; separate model studies do not change this scope.

## Policy, evidence and reproduction

The producer's committed policy pins the exact tested consumer and synchronized
contract, fixture and interoperability digests. If a `native-policy.json` copy
is present here, packaging independently checked that its parsed policy equals
the committed policy recorded by the run; it does not override a stale pin.
No source checkout file was modified to obtain these receipts.

[report.json](report.json) retains all declared inputs and dispositions.
[artifacts.tar.xz](artifacts.tar.xz) contains every source result/artifact,
admitted artifact, native receipt, exact native transport, physical serializer,
token array and mask. [archive.json](archive.json) binds archive and member
lengths and SHA-256 hashes; every member was rechecked after decompression.
`SHA256SUMS` covers the package, including the unchanged helper and raw logs.
Packaging verifies retained bytes and does not execute a new native admission.

Use clean checkouts at the exact revisions above and the pinned tokenizer. Set
`TRACING_JS_SELF_ROOT`, `MEGATOKEN_ROOT`, `MEGATOKEN_PYTHON`,
`MEGATOKEN_TOKENIZER_JSON`, `MEGATOKEN_NATIVE_SOURCE_PRODUCER` and a writable
`TMPDIR`. Set `PYTHONPATH` to the frozen consumer's `src` directory, then run:

```sh
node qualify_abrupt_number.mjs "$TRACING_JS_SELF_ROOT" /path/to/new-evidence \
  012c9fe49a082319bf98ac0c571596da925741a4 \
  39c4036564428e44cc89caf261f517d856482695
```

Use the retained packaging helper with `--kind number-abrupt`, the completed
`--run` directory, a new `--output`, and the unchanged `--helper`. Explicit log
paths and an optional enclosing command receipt can be passed separately. The
helper refuses incomplete populations, changed pins, missing native gates,
incorrect transport hashes and mismatched physical-token counts.
