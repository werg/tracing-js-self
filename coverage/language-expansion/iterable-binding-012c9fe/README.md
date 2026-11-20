# Flat iterable bindings and iterator cleanup

The complete declared supplementary population produced **14 source/native/token
admissions** and **3 explicit source refusals** at producer
`012c9fe49a082319bf98ac0c571596da925741a4` and independent consumer
`39c4036564428e44cc89caf261f517d856482695`. Both Git checkouts were clean and unchanged before
and after execution. The run started at `2026-11-20T17:26:44.248Z` and finished at
`2026-11-20T17:46:24.475Z`. The native subprocess deadline was explicitly 300 seconds.

This is a separate **17-case supplementary population**, extracted from
the literal source cases in `test/semantic-protocol-iterable-binding-source-v8.test.js` (SHA-256
`500470b7b1291d5b3f2be1955d6ac3f2f54c903a2951af5f820ab56a4d6936ae`). It does not add cases to the frozen 665 expansion,
26 interoperability or 11 gallery denominators. Those independently executed
populations retain their own reports; cases may overlap between inventories.

## Qualified behavior

The supported source position is an initialized VariableDeclarator with a
flat ArrayPattern containing identifiers, identifier defaults, identifier rest
or elisions. Cases cover early close, an empty pattern, own Array iterator
overrides, one-time next lookup, elision without value access, rest exhaustion,
throwing defaults, step/done/value failures, active Array growth, permanent
completion, skipped reads after done, and a Number callback throw in a default.

The helper checks that an empty pattern never calls next, an elision avoids its
value read, and exhaustion or step failures do not close the iterator. Independent
source completion observations agree before all native gates. These checks
specifically qualify this source profile; parsing an ArrayPattern alone is not
counted as execution support.

Every admitted case passed independent native replay, every published context,
checkpoint continuation, generated-only masks, live source binding and actual
production-tokenizer checks. Exact source artifacts, compact JSON native
transports, receipts and completion values are retained.

| Case | Completion | Published contexts |
| --- | --- | --- |
| `early-close` | `{"kind":"return","value":["str","3c"]}` | 55 |
| `empty-pattern` | `{"kind":"return","value":["str","agc"]}` | 48 |
| `array-override` | `{"kind":"return","value":["num",9]}` | 50 |
| `cached-next` | `{"kind":"return","value":["str","11:12:1:2:1"]}` | 107 |
| `elision` | `{"kind":"return","value":["str","1ndndvc"]}` | 93 |
| `rest-exhaustion` | `{"kind":"return","value":["num",3]}` | 109 |
| `throwing-default` | `{"kind":"return","value":["str","c7"]}` | 69 |
| `next-failure` | `{"kind":"return","value":["str","0:7"]}` | 42 |
| `done-failure` | `{"kind":"return","value":["str","0:7"]}` | 50 |
| `value-failure` | `{"kind":"return","value":["str","0:7"]}` | 53 |
| `completed-array-stays-done` | `{"kind":"return","value":["num",5]}` | 30 |
| `active-array-observes-growth` | `{"kind":"return","value":["num",3]}` | 51 |
| `done-skips-further-next` | `{"kind":"return","value":["str","7:1:0"]}` | 64 |
| `default-number-throw` | `{"kind":"return","value":["num",7]}` | 71 |

## Refusals and remaining limits

| Declared refusal | Recorded reason |
| --- | --- |
| `nested-binding-refusal` | Protocol source projection: array iteration guard lacks its qualified synchronous loop or binding pattern |
| `assignment-binding-refusal` | Protocol source projection: array iteration guard lacks its qualified synchronous loop or binding pattern |
| `string-builtin-binding-refusal` | Protocol source projection: observable ToPropertyKey requires a coercion protocol |

Nested binding patterns, assignment destructuring and captured String builtin
binding retain explicit source refusals. Other source positions, asynchronous
iteration, arbitrary intrinsic guest errors and unrestricted iterator protocols
are not qualified by these flat declaration cases.

Refused cases remain in the declared denominator and have no exported artifact,
native admission or token-cost claim. No unexecuted case is counted as supported.

## Exact physical costs

| Case | Generated | Flat EOS | Flat submitted context | Flat total | Native observed/context | Native physical records |
| --- | --- | --- | --- | --- | --- | --- |
| `early-close` | 1,891 | 55 | 96,140 | 98,086 | 96,871 | 214 |
| `empty-pattern` | 1,706 | 48 | 81,252 | 83,006 | 82,149 | 185 |
| `array-override` | 1,664 | 50 | 90,826 | 92,540 | 91,777 | 198 |
| `cached-next` | 3,694 | 107 | 284,708 | 288,509 | 286,010 | 586 |
| `elision` | 3,275 | 93 | 218,189 | 221,557 | 218,814 | 468 |
| `rest-exhaustion` | 3,808 | 109 | 201,108 | 205,025 | 200,663 | 451 |
| `throwing-default` | 2,896 | 69 | 116,123 | 119,088 | 116,607 | 264 |
| `next-failure` | 1,610 | 42 | 61,466 | 63,118 | 62,265 | 150 |
| `done-failure` | 1,893 | 50 | 77,924 | 79,867 | 78,678 | 185 |
| `value-failure` | 2,016 | 53 | 84,410 | 86,479 | 85,165 | 197 |
| `completed-array-stays-done` | 955 | 30 | 32,996 | 33,981 | 33,617 | 92 |
| `active-array-observes-growth` | 1,683 | 51 | 49,760 | 51,494 | 49,850 | 142 |
| `done-skips-further-next` | 2,180 | 64 | 127,176 | 129,420 | 128,342 | 285 |
| `default-number-throw` | 2,929 | 71 | 110,729 | 113,729 | 110,885 | 260 |

Generated target counts agree between flat serialization and native packing in
every admitted row. Flat `semantic-causal-lm/4` records each include an explicit
EOS; native physical framing records its own observed/context counts and has no
terminal token. These conventions remain separate. There are **12
compact-containing** and **2 wholly detailed/protocol**
executions, and detailed/protocol targets account for **98.19%**
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
node qualify_iterable_bindings.mjs "$TRACING_JS_SELF_ROOT" /path/to/new-evidence \
  012c9fe49a082319bf98ac0c571596da925741a4 \
  39c4036564428e44cc89caf261f517d856482695
```

Use the retained packaging helper with `--kind iterable-binding`, the completed
`--run` directory, a new `--output`, and the unchanged `--helper`. Explicit log
paths and an optional enclosing command receipt can be passed separately. The
helper refuses incomplete populations, changed pins, missing native gates,
incorrect transport hashes and mismatched physical-token counts.
