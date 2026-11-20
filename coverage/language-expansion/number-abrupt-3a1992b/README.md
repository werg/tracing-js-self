# Source and native admission of abrupt Number callbacks

Both supplementary cases passed fresh source qualification, independent native
admission and exact production-tokenizer measurement at producer
`3a1992b4462e8e2affa6baa04e9075ba3b01d04a` and consumer
`418385b6880077b58bb5ae8f7ffeb7353a108d5d`. The source cases are the two throwing
examples from the frozen `test/semantic-protocol-number-source-v8.test.js`;
[report.json](report.json) binds that file's SHA-256 and retains both exact inputs.

This is a separate two-case regression population. Its cases are not added to
the frozen 665-case expansion, 23-case interoperability or 11-case gallery
denominators, and they do not establish new corpus coverage.

| Case | Source / native / tokens | Completion | Retained abrupt conversions | Published contexts |
| --- | --- | --- | ---: | ---: |
| `number-abrupt-direct` | Passed / passed / passed | Throw numeric `7` | 1 | 14 |
| `number-abrupt-nested` | Passed / passed / passed | Throw numeric `5` | 2 | 22 |

The direct case throws from `valueOf` and never falls back to the throwing
`toString`. The nested case propagates the inner callback's exact throw through
both conversion continuations. Source observation checks the actual throwing
callbacks; independent native replay checks public records, every published
context, checkpoint continuation, generated-only masks, live source binding and
the pinned tokenizer. All six native admission checks passed for both cases.
The retained continuations contain the abrupt completion and no numeric result.

## Physical costs

| Case | Flat generated | Flat EOS | Flat submitted context | Flat total | Native generated | Native observed/context | Native physical records |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Direct | 442 | 14 | 13,529 | 13,985 | 442 | 14,240 | 40 |
| Nested | 662 | 22 | 23,852 | 24,536 | 662 | 24,533 | 64 |

Flat costs use the actual `semantic-causal-lm/4` serializer with one EOS per
generated record. Native counts come from independently checked packing
receipts; that framing has no terminal token. These counts measure serialized
tokens and physical packing, not model accuracy, serving latency or cache reuse.
Both cases remain wholly detailed/protocol executions. Optimizer steps are zero
and default promotion remains unqualified.

The actual Ling tokenizer has SHA-256
`40fb9d7d7795b8bd305aeff39ce9963f3f450915b9553f2938e009be9a1fed60`
and identity
`7f52faca2fe82273a889023defd2f1a6fd6080a21096ec77e97f4798a0a370b2`.
The report retains its exact codec, consumer, Python and `tokenizers` identities.

## Retained evidence and reproduction

`artifacts.tar.xz` contains both complete source results, source-bound public
artifacts, admitted artifacts, exact compact JSON native transport bytes, native
receipts, physical prompt/target/EOS token records and masks, and the report.
[archive.json](archive.json) records every member's length and SHA-256; all
members were rechecked after decompression. `SHA256SUMS` binds the package files.
Archive verification is an integrity check; fresh native execution is recorded
by the source-bound receipts inside the archive.

Use clean checkouts at the two exact revisions above and the pinned tokenizer.
Set `TRACING_JS_SELF_ROOT`, `MEGATOKEN_ROOT`, `MEGATOKEN_PYTHON`,
`MEGATOKEN_TOKENIZER_JSON`, `MEGATOKEN_NATIVE_SOURCE_PRODUCER`,
`SEMANTIC_V8_NATIVE_POLICY`, and an existing writable `TMPDIR`. Set
`PYTHONPATH` to the frozen consumer's `src` directory so an editable installation
cannot select another checkout. Then run the retained helper with a new output:

```sh
node qualify_abrupt_number.mjs "$TRACING_JS_SELF_ROOT" /path/to/new-evidence \
  3a1992b4462e8e2affa6baa04e9075ba3b01d04a \
  418385b6880077b58bb5ae8f7ffeb7353a108d5d
```

The helper refuses changed source fixtures or dirty/mismatched checkouts,
checks the exact thrown completions and native-input digest, and retains
source/native failures instead of replacing a false result with a teacher value.
Intrinsic conversion TypeErrors, accessor selection, array stringification and
async/exotic conversion callbacks retain their separate unsupported boundaries.
