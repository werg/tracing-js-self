# Bounded synchronous custom iterators

The complete declared supplementary population produced **16 source/native/token
admissions** and **4 explicit source refusals** at producer
`012c9fe49a082319bf98ac0c571596da925741a4` and independent consumer
`39c4036564428e44cc89caf261f517d856482695`. Both Git checkouts were clean and unchanged before
and after execution. The run started at `2026-11-20T17:37:59.188Z` and finished at
`2026-11-20T18:00:47.027Z`. The native subprocess deadline was explicitly 300 seconds.

This is a separate **20-case supplementary population**, extracted from
the literal source cases in `test/semantic-protocol-custom-iterator-source-v8.test.js` (SHA-256
`42a177f4b52d6a6554e72cf62fe0078a3273b9f661d28c408096e2840709b044`). It does not add cases to the frozen 665 expansion,
26 interoperability or 11 gallery denominators. Those independently executed
populations retain their own reports; cases may overlap between inventories.

## Qualified behavior

The cases check iterator acquisition with the original receiver, one-time
next lookup, repeated calls of the cached method, live done/value access, and
early return lookup/call with its original receiver. They cover break, return,
body finally, original throws taking precedence over close failure, close
failure replacing a normal break, nested labeled breaks, and continuing an
outer loop while closing only the inner one. A Number callback throw during
close preserves the original pending throw.

The helper checks one next read and three calls with the same method/receiver
for cached-next, zero close observations on step failures and exhaustion, and a
concrete pending target for nested labeled cleanup. Source completion and
extension observations independently agree before native admission.

Every admitted case passed independent native replay, every published context,
checkpoint continuation, generated-only masks, live source binding and actual
production-tokenizer checks. Exact source artifacts, compact JSON native
transports, receipts and completion values are retained.

| Case | Completion | Published contexts |
| --- | --- | --- |
| `cached-next` | `{"kind":"return","value":["str","1112:1"]}` | 122 |
| `acquisition-receiver` | `{"kind":"return","value":["num",8]}` | 70 |
| `break-closes` | `{"kind":"return","value":["str","1c"]}` | 55 |
| `body-finally-before-close` | `{"kind":"return","value":["str","3fc"]}` | 62 |
| `throw-precedes-close-failure` | `{"kind":"return","value":["str","c7"]}` | 59 |
| `break-replaced-by-close-failure` | `{"kind":"return","value":["num",9]}` | 52 |
| `throw-precedes-return-getter-failure` | `{"kind":"return","value":["str","g7"]}` | 58 |
| `next-failure-does-not-close` | `{"kind":"return","value":["str","0:7"]}` | 40 |
| `done-failure-does-not-close` | `{"kind":"return","value":["str","d7"]}` | 52 |
| `value-failure-does-not-close` | `{"kind":"return","value":["str","v7"]}` | 52 |
| `close-getter-and-receiver` | `{"kind":"return","value":["str","g5"]}` | 62 |
| `null-return-is-absent` | `{"kind":"return","value":["num",3]}` | 45 |
| `continue-and-exhaustion-do-not-close` | `{"kind":"return","value":["str","2"]}` | 119 |
| `nested-labeled-break` | `{"kind":"return","value":["str","io"]}` | 109 |
| `continue-outer-closes-inner-only` | `{"kind":"return","value":["str","ii"]}` | 191 |
| `number-throw-during-close` | `{"kind":"return","value":["num",7]}` | 66 |

## Refusals and remaining limits

| Declared refusal | Recorded reason |
| --- | --- |
| `iterator-next-nonobject-refusal` | Protocol source projection: heap kind or metadata needs a declared protocol: object |
| `iterator-return-nonobject-refusal` | Protocol source projection: heap kind or metadata needs a declared protocol: object |
| `iterator-return-noncallable-refusal` | Protocol source projection: heap kind or metadata needs a declared protocol: object |
| `generator-custom-for-of-refusal` | Protocol source projection: construction: callable capability, home or initializer state differs |

Non-object step/close results, noncallable close methods and custom-iterator
cleanup inside generators remain explicit source refusals. Async iteration and
unmodeled intrinsic guest errors remain outside this bounded synchronous
profile. The older 653fd1b attempt retains its 120-second native timeout; this
run uses the explicit bound reported below and does not rewrite that failure.

Refused cases remain in the declared denominator and have no exported artifact,
native admission or token-cost claim. No unexecuted case is counted as supported.

## Exact physical costs

| Case | Generated | Flat EOS | Flat submitted context | Flat total | Native observed/context | Native physical records |
| --- | --- | --- | --- | --- | --- | --- |
| `cached-next` | 4,384 | 122 | 350,989 | 355,495 | 351,887 | 718 |
| `acquisition-receiver` | 2,625 | 70 | 124,262 | 126,957 | 124,800 | 274 |
| `break-closes` | 2,023 | 55 | 94,570 | 96,648 | 95,322 | 213 |
| `body-finally-before-close` | 2,378 | 62 | 104,168 | 106,608 | 104,830 | 237 |
| `throw-precedes-close-failure` | 2,679 | 59 | 94,001 | 96,739 | 94,602 | 220 |
| `break-replaced-by-close-failure` | 2,089 | 52 | 70,555 | 72,696 | 70,864 | 175 |
| `throw-precedes-return-getter-failure` | 2,628 | 58 | 92,556 | 95,242 | 93,178 | 216 |
| `next-failure-does-not-close` | 1,646 | 40 | 58,088 | 59,774 | 58,950 | 144 |
| `done-failure-does-not-close` | 2,094 | 52 | 94,846 | 96,992 | 96,052 | 221 |
| `value-failure-does-not-close` | 2,081 | 52 | 83,755 | 85,888 | 84,609 | 197 |
| `close-getter-and-receiver` | 2,270 | 62 | 111,742 | 114,074 | 112,489 | 251 |
| `null-return-is-absent` | 1,657 | 45 | 63,868 | 65,570 | 64,347 | 156 |
| `continue-and-exhaustion-do-not-close` | 4,404 | 119 | 238,622 | 243,145 | 238,301 | 531 |
| `nested-labeled-break` | 4,184 | 109 | 247,909 | 252,202 | 247,800 | 529 |
| `continue-outer-closes-inner-only` | 7,495 | 191 | 570,273 | 577,959 | 568,750 | 1,160 |
| `number-throw-during-close` | 2,860 | 66 | 102,475 | 105,401 | 102,833 | 243 |

Generated target counts agree between flat serialization and native packing in
every admitted row. Flat `semantic-causal-lm/4` records each include an explicit
EOS; native physical framing records its own observed/context counts and has no
terminal token. These conventions remain separate. There are **14
compact-containing** and **2 wholly detailed/protocol**
executions, and detailed/protocol targets account for **98.52%**
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
node qualify_custom_iterators.mjs "$TRACING_JS_SELF_ROOT" /path/to/new-evidence \
  012c9fe49a082319bf98ac0c571596da925741a4 \
  39c4036564428e44cc89caf261f517d856482695
```

Use the retained packaging helper with `--kind custom-iterator`, the completed
`--run` directory, a new `--output`, and the unchanged `--helper`. Explicit log
paths and an optional enclosing command receipt can be passed separately. The
helper refuses incomplete populations, changed pins, missing native gates,
incorrect transport hashes and mismatched physical-token counts.
