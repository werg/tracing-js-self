# Bounded v8 population qualification and cost comparison

This evidence measures producer `8d1f7b5b24d385ce067e9a3d64cce37140a26a56` with independently pinned consumer `be3a8d789f2ea8c76a77c7f2f14eff717960d64e`.
The complete 665-row run has 657 source passes, 656 native admissions, 1 source-qualified native failure, and 8 explicit source refusals.
Evidence and documentation commits after this freeze do not change the measured revisions. Later consumer revisions require their own qualification; this run is not a receipt for them.

## Source and native qualification

| Population | Declared rows | Source qualified | Native admitted | Source refusals |
| --- | ---: | ---: | ---: | ---: |
| Fixed families | 624 | 616 | 616 | 8 |
| Script interactions | 12 | 12 | 11 | 0 |
| Real source | 27 | 27 | 27 | 0 |
| Evaluated modules | 2 | 2 | 2 | 0 |
| Full expansion population | 665 | 657 | 656 | 8 |

The separate [11-case gallery and 22-case interoperability qualification](../native-v8-8d1f7b5/README.md) retains all 33 actual source/native admissions, exact native inputs, token costs and consumer validation logs. `typed-views-shared-backing` appears in both the expansion and interoperability inventories, so the three population denominators are reported separately.

The full expansion population contains 26 fixed semantic families, three idioms per family and eight inputs per idiom (624 executions), 12 script interactions, 27 frozen real-source selections and two evaluated-module interactions. The real-source manifest selects 27 of 78 available functions by its fixed per-stratum rule; the other 51 were not tested by this population.

Independent reference checks at the same producer passed all 208 positive inputs across 624 idiom executions and all 52 distinguishing pairs. Reference execution checks the declared answers and counterexamples; it is separate from compact projection and native admission.

### Native admission failure

This completed run is not a fully passing native qualification. The following source-qualified case failed the independently checked continuation and remains failed in every retained report:

- `generator-delegation-close`: native `failed`; megatoken.data.native_v8.NativeV8Error: Public continuation differs from independently replayed shared state at 55 fields ['heap'].

For `generator-delegation-close`, the failure is the order of array `o6` property rows after an explicit length assignment: the producer publishes `[0, length]`, while this consumer retains `[length, 0]`. Both retain the same separate `keyOrder`, values and descriptors. A three-record reproducer allocates an empty array, writes index `0`, then writes `length = 1`. This is a real producer/consumer continuation mismatch; a later consumer fix does not retroactively admit this row.

Its source-qualified flat serializer is still measured, while native packing is unavailable for this row. The archived attempted transport input is explicitly labeled unadmitted and has no successful source-verification receipt.

### Explicit unsupported boundary

- `enumeration-own-keys-idiom-1-input-0`: `projection_refused`; Effectful teacher projection: guest custom/null prototype state requires an explicit v8 behavioral-state profile. Native `untested`.
- `enumeration-own-keys-idiom-1-input-1`: `projection_refused`; Effectful teacher projection: guest custom/null prototype state requires an explicit v8 behavioral-state profile. Native `untested`.
- `enumeration-own-keys-idiom-1-input-2`: `projection_refused`; Effectful teacher projection: guest custom/null prototype state requires an explicit v8 behavioral-state profile. Native `untested`.
- `enumeration-own-keys-idiom-1-input-3`: `projection_refused`; Effectful teacher projection: guest custom/null prototype state requires an explicit v8 behavioral-state profile. Native `untested`.
- `enumeration-own-keys-idiom-1-input-4`: `projection_refused`; Effectful teacher projection: guest custom/null prototype state requires an explicit v8 behavioral-state profile. Native `untested`.
- `enumeration-own-keys-idiom-1-input-5`: `projection_refused`; Effectful teacher projection: guest custom/null prototype state requires an explicit v8 behavioral-state profile. Native `untested`.
- `enumeration-own-keys-idiom-1-input-6`: `projection_refused`; Effectful teacher projection: guest custom/null prototype state requires an explicit v8 behavioral-state profile. Native `untested`.
- `enumeration-own-keys-idiom-1-input-7`: `projection_refused`; Effectful teacher projection: guest custom/null prototype state requires an explicit v8 behavioral-state profile. Native `untested`.

These cases exercise `for...in` over a custom prototype. The bounded source profile does not publish the mutable enumeration cursor and prototype-walk state needed for that behavior. The [enumeration source profile](../../../docs/V8_ENUMERATION_SOURCE.md) distinguishes it from supported snapshot-style enumeration. The refusal rows and full failed source payloads remain in the archive and in every cost denominator. They are not assigned a zero token cost or a successful native disposition.

The qualification command exits nonzero when any declared row is not natively admitted. Its complete report, rather than exit status alone, distinguishes these explicit source refusals from a native semantic failure. The historical [interrupted native qualification](../native-v8-2f9bca8-interrupted/README.md) remains separately retained with its original failures and untested rows.

## Exact production-tokenizer costs

Costs use `inclusionAI/Ling-3.0-tiny` tokenizer revision `9a98e35fe1c9ee255f78dd64771c7ae15a799481`, tokenizer SHA256 `40fb9d7d7795b8bd305aeff39ce9963f3f450915b9553f2938e009be9a1fed60`, codec SHA256 `98de7394ae3c4f47fe86d2767aaa103b8569de446913135a89de914af7182200`, and `tokenizers` 0.23.3. The full identity and byte-roundtrip evidence is retained in each cost report.

Flat serving costs use the actual `semantic-causal-lm/4` serializer. Submitted context is counted for every prediction, including repeated context; generated targets and explicit EOS tokens are separate segments. These are exact serialized costs, not measured cached serving latency.

Among 657 source-qualified expansion episodes, 458 contain compact regions and 199 are wholly detailed. The retained execution has 471 compact records and 6839 detailed records. Detailed targets account for 86.03% of generated tokens; compact-episode counts alone do not describe the remaining token footprint.

| Population | Token measured / declared | Generated | EOS | Submitted context | Flat total | Detailed share of generated tokens |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Expansion | 657/665 | 237,530 | 7,310 | 8,246,669 | 8,491,509 | 86.03% |
| Gallery | 11/11 | 3,378 | 97 | 139,863 | 143,338 | 86.29% |
| Interoperability | 22/22 | 23,867 | 761 | 1,217,943 | 1,242,571 | 96.42% |

Native training packing counts come directly from the validated native admission receipts:

| Population | Native measured / declared | Generated | Observed/context | Terminal | Physical records | Logical records |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Expansion | 656/665 | 235,429 | 8,900,199 | 0 | 22,334 | 8,572 |
| Gallery | 11/11 | 3,378 | 158,551 | 0 | 407 | 169 |
| Interoperability | 22/22 | 23,867 | 1,244,727 | 0 | 2,848 | 809 |

Physical packing includes inserted contexts and framing. Its terminal count is zero for this native framing; it is not substituted for the flat serializer's EOS count. The two representations are reported separately and neither provides a native serving latency or cache-reuse measurement.

## Paired historical comparison

The [retained baseline costs](../baseline-token-costs-135bd1f/README.md) meter actual historical serializer bytes from producer `e88219121d1a09a6f93d161038f162e6b0f6ef54`, with meter revision `135bd1fcf58e4abf1685008899b815160676dd30`. Tokenizer identity and codec implementation match these measurements. Pairing requires the same case ID, exact source, entry and rooted input graph; aliases, cycles, property order and null prototypes are preserved when renaming object IDs.

The baseline retains 50 declared rows and 42 measured serializers (27 real-source, 11 gallery, 4 script interactions). Eight baseline script interactions remain unmeasured. The 624 fixed-family executions and two module cases have no retained historical serializer costs. No baseline count is inferred for them or for new interoperability cases.

| Matched population | Pairs | Baseline generated | Measured generated | Generated change | Baseline flat total | Measured flat total | Total change |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Real source | 27 | 29,870 | 27,815 | -6.88% | 12,389,595 | 1,080,585 | -91.28% |
| Gallery | 11 | 2,756 | 3,378 | +22.57% | 454,467 | 143,338 | -68.46% |
| Script interactions | 4 | 1,928 | 1,939 | +0.57% | 295,808 | 62,729 | -78.79% |
| All matched rows | 42 | 34,554 | 33,132 | -4.12% | 13,139,870 | 1,286,652 | -90.21% |

Across the 42 matched rows, submitted context changes from 13,104,241 to 1,252,510 tokens (-90.44%), while generated targets change from 34,554 to 33,132 (-4.12%). The total reduction is chiefly a context-cost change. Detailed targets remain 96.07% of generated tokens on this matched subset.

All 42 matched rows have successful current native admission. The failed `generator-delegation-close` case has an unmeasured historical baseline and is excluded from these paired ratios.

These ratios describe only the listed measured pairs, not all declared populations. Historical full host schedules were not independently retained in a canonical form, so source/entry/rooted-input matching does not claim a new historical source or model execution qualification. Duplicate current IDs are reported as ambiguous instead of choosing a favorable match.

### Individual flat-cost regressions

Aggregate totals do not remove individual increases. Every matched case whose total flat cost increased is listed below:

| Case | Baseline total | Measured total | Change |
| --- | ---: | ---: | ---: |
| `real-utilities-61b4b4c012b0705b0a6b660a` | 1,470 | 1,947 | +32.45% |
| `real-utilities-4dd52bb7e01ee8083fe45cd2` | 1,420 | 1,957 | +37.82% |
| `compound-pure` | 1,484 | 2,166 | +45.96% |
| `object-alias` | 1,283 | 1,615 | +25.88% |
| `pure-helper` | 1,279 | 1,694 | +32.45% |
| `dense-loop` | 1,480 | 2,393 | +61.69% |
| `counter-0` | 3,935 | 14,802 | +276.16% |
| `redundant-cell-write` | 579 | 1,711 | +195.51% |

Per-case prompt, generated, detailed and terminal counts, peak contexts, pairing decisions and exact artifact hashes are retained in `paired-serving-costs.json`. This end-to-end comparison includes both representation and public-context changes; it does not isolate rendering from abstraction. A lower aggregate serialized cost does not establish better model comprehension or successful learned execution.

## Retention and reproduction

`archive.json` binds every deterministic archive and each uncompressed member's exact SHA256 and byte count. Archives contain the complete 665-task frozen inventory, every attempt, all source/admitted artifacts and native receipts, source refusal payloads, exact serving serializer strings and token segments, progress journals, the policy, reference evidence, and the paired comparison with its exact input manifest. Archive parts are bounded below 8 MB for reliable transport.

For every admitted row, `native-inputs-manifest.json` binds the retained `*.native-input.json` to `nativeReceipt.sourceVerification.artifactSha256`. The native CLI receives compact `JSON.stringify(source)` plus a newline; that exact byte string is reconstructed and verified against the live receipt, while the original pretty source artifact remains separately retained. Archive generation rechecks all report artifact hashes and input/receipt bindings.

The accompanying [native input retention helper](retain-native-inputs.mjs) and [archive builder](retain-evidence.py) preserve these bindings. The builder verifies every measured artifact and checks each archive member after writing, including all 5,977 retained members in this evidence set. The largest compressed archive is 7,630,004 bytes. The separate gallery/interoperability archives linked above are not duplicated here.

Run qualification and metering from a clean checkout of the measured producer, with a clean checkout of the pinned consumer and the pinned tokenizer:

```sh
node tools/qualify-semantic-v8.mjs --out ../v8-native-all \
  --population all --inputs all --workers 4 \
  --megatoken CONSUMER --tokenizer TOKENIZER_JSON --python PYTHON \
  --native-policy contracts/semantic-native-policy-v8.json
MEGATOKEN_ROOT=CONSUMER MEGATOKEN_TOKENIZER_JSON=TOKENIZER_JSON \
  MEGATOKEN_PYTHON=PYTHON node tools/measure-semantic-v8.mjs \
  --qualification ../v8-native-all --out ../v8-costs-all \
  --tokenizer-module tools/semantic-v8-tokenizer-adapter.mjs
node tools/language-expansion-benchmark.mjs --out ../v8-reference \
  --mode reference --trace-version 8 --population all --inputs all
```

The [evaluation guide](../../../docs/LANGUAGE_EXPANSION_EVALUATION.md) describes baseline tokenization and comparison manifests. Python must import the chosen clean consumer checkout (for example through its `src` directory on `PYTHONPATH`). A new output directory preserves the original run; resume requires the exact unchanged producer, policy, inputs, environment and bounds.

## Remaining promotion gates

The native continuation failure above requires a fix and fresh qualification; the eight enumeration cases remain outside the supported source profile. The 228-task comprehension set has no external model responses; next-step prediction, complete learned execution, optimizer training, native serving latency and cache savings remain unmeasured. No model credentials were available for those experiments. The default format remains unpromoted, and `defaultPromotion` remains `not-qualified` in all measured reports.
