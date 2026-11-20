# Source and native qualification of Number callback cleanup

The declared focused suite passed **12 positive source/native/token cases** and
preserved **two explicit source refusals** at producer
`ddaac8229c28e2d8ad54aedfce423f7cdff4d357` and independent consumer
`91aea0d6dd4c3700cfaa1a30bce0d3441436cc78`. Both checkouts were clean and unchanged before and
after execution. The run started at `2026-11-20T16:49:54.881Z` and completed at
`2026-11-20T16:52:13.688Z`.

The positive cases exercise Number callback throws across caller and callback
`catch`/`finally`, overrides, nested conversions and cleanup, guest helpers,
suppressed fallback after a throw, and later independent conversions. They
retain `ordinary-completions-source/1` alongside the Number conversion profile.
The source suite is `test/semantic-protocol-completion-source-v8.test.js` with SHA-256
`5751dab6032ec683a13300de3516f7cd859097f90d7564f264632dc3531ead69`. The helper reads its ten declared literal cases
and checks that the four additional positive/refusal bodies also occur in that
same frozen suite; it does not invent replacements for failed cases.

This is a separate **14-case supplementary population**: 12 native admissions
and two expected source refusals. It does not increase or replace the frozen
665 expansion, 23 interoperability or 11 gallery denominators, and it does not
assign older population evidence to this newer completion profile.

## Positive results

All rows below passed independent source execution, source projection, public
replay, every published context, checkpoint continuation, generated-only masks,
live source binding and the actual tokenizer. The independent extension and
completion observation audits agreed. Native replay returned each exact tagged
value below.

| Case | Returned tagged value | Published contexts |
| --- | --- | ---: |
| `caller-catch` | `["num", 8]` | 18 |
| `caller-finally-override` | `["num", 11]` | 15 |
| `callback-finally-override` | `["num", 5]` | 17 |
| `callback-finally-throws` | `["num", 10]` | 20 |
| `nested-conversion-cleanup` | `["str", "if5"]` | 36 |
| `nested-catch-preserves-outer-return` | `["num", 2]` | 22 |
| `callback-catches-helper` | `["num", 3]` | 25 |
| `no-fallback-after-throw` | `["str", "v7"]` | 24 |
| `normal-cleanup` | `["num", 13]` | 21 |
| `later-conversion` | `["num", 3]` | 29 |
| `retained-cleanup-boundaries` | `["num", 2]` | 26 |
| `handler-scope-control` | `["num", 7]` | 17 |

### Explicit source boundaries

| Declared refusal | Recorded reason |
| --- | --- |
| `loop-target-refusal` | Protocol source projection: ordinary completion: loop-target cleanup requires its declared target profile |
| `symbol-cleanup-refusal` | Protocol source projection: ordinary completion: Symbol catch requires a protocol transfer |

Both returned `unsupported` without an export. Native admission and costs remain
untested for those two cases; expected refusal is not reported as supported
JavaScript. Intrinsic conversion TypeErrors, accessor selection, array
stringification, async/exotic callbacks and unrestricted cleanup remain separate
unqualified boundaries.

## Exact physical costs

| Case | Generated | Flat EOS | Flat submitted context | Flat total | Native observed/context | Native physical records |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `caller-catch` | 657 | 18 | 18,453 | 19,128 | 19,135 | 52 |
| `caller-finally-override` | 520 | 15 | 14,917 | 15,452 | 15,558 | 43 |
| `callback-finally-override` | 571 | 17 | 17,115 | 17,703 | 17,726 | 49 |
| `callback-finally-throws` | 889 | 20 | 21,081 | 21,990 | 21,812 | 59 |
| `nested-conversion-cleanup` | 1,429 | 36 | 53,447 | 54,912 | 54,437 | 131 |
| `nested-catch-preserves-outer-return` | 1,027 | 22 | 23,283 | 24,332 | 23,953 | 65 |
| `callback-catches-helper` | 855 | 25 | 27,808 | 28,688 | 28,506 | 73 |
| `no-fallback-after-throw` | 903 | 24 | 35,679 | 36,606 | 36,915 | 88 |
| `normal-cleanup` | 738 | 21 | 25,408 | 26,167 | 26,246 | 64 |
| `later-conversion` | 976 | 29 | 38,941 | 39,946 | 39,713 | 90 |
| `retained-cleanup-boundaries` | 1,406 | 26 | 28,836 | 30,268 | 29,600 | 77 |
| `handler-scope-control` | 605 | 17 | 17,189 | 17,811 | 17,808 | 49 |

Generated target counts agree between flat serialization and native packing in
every row. Flat costs use `semantic-causal-lm/4` with one EOS per generated
record. Native physical framing adds no terminal token and retains its own
observed/context count; the two accounting conventions are not combined.
3 executions contain compact regions and 9 are
wholly detailed/protocol. Detailed/protocol targets account for
99.12% of generated tokens across the 12 admitted cases.
Exact bytes, token arrays and loss masks are retained. These measurements establish token accounting, not
model accuracy, serving latency or cache reuse. Optimizer steps are zero and
default promotion remains unqualified.

The pinned tokenizer SHA-256 is
`40fb9d7d7795b8bd305aeff39ce9963f3f450915b9553f2938e009be9a1fed60`, with identity
`7f52faca2fe82273a889023defd2f1a6fd6080a21096ec77e97f4798a0a370b2`. The report also retains the exact
codec, consumer, Python and tokenizer-library identities.

## Policy binding and failed predecessor

The producer's committed policy still names consumer
`418385b6880077b58bb5ae8f7ffeb7353a108d5d`. This run supplied a separate external
policy, retained as [native-policy.json](native-policy.json), binding the tested
consumer `91aea0d6dd4c3700cfaa1a30bce0d3441436cc78` and the contract, fixture and interoperability
digests from the byte-equivalent paired execution contracts. No committed
source file was changed to run this qualification. The report retains both
policies and the override's SHA-256.

The first attempt used the same producer and consumer
`1967695e1de7596a256d078b7e8e76cafbc06e6a`. Its first `caller-catch` source case verified, but the
native CLI rejected the missing completion-extension admission entry. No case
was natively admitted and the remaining cases did not run. Its original failed
report, source result/artifact, external policy and stderr are preserved in
[failed-1967695.tar.xz](failed-1967695.tar.xz). The consumer fix admits the explicit
completion profile and adds coverage; the successful run above was executed
fresh at its own later pin. The failure is not relabeled as a pass.

## Retained evidence and reproduction

[artifacts.tar.xz](artifacts.tar.xz) contains all source results, source-bound
public artifacts, admitted artifacts, exact compact JSON native transport
bytes, receipts, physical token records and masks, policies and the complete
report. [archive.json](archive.json) binds both archives and every uncompressed
member by length and SHA-256; every member was rechecked after decompression.
The package [checksums](SHA256SUMS) cover all retained top-level files.

Use clean checkouts at the successful pins above and the pinned tokenizer. Set
`TRACING_JS_SELF_ROOT`, `MEGATOKEN_ROOT`, `MEGATOKEN_PYTHON`,
`MEGATOKEN_TOKENIZER_JSON`, `MEGATOKEN_NATIVE_SOURCE_PRODUCER` and an existing
writable `TMPDIR`. Set `PYTHONPATH` to the consumer's `src` directory. The helper
constructs its external policy in the new output directory before loading the
admission and tokenizer adapters:

```sh
node qualify_number_completions.mjs "$TRACING_JS_SELF_ROOT" /path/to/new-evidence \
  ddaac8229c28e2d8ad54aedfce423f7cdff4d357 \
  91aea0d6dd4c3700cfaa1a30bce0d3441436cc78
```

The package helper checks all retained hashes, receipt pins and exact native
input bindings. Packaging does not itself run new native admission. Later
serving/API changes and external-model work require separate measurements.
