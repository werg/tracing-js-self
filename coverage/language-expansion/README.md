# Language-expansion evidence

## Current v8 qualification

Evidence directories name their exact measured revisions. The final implemented
candidate was measured at producer `b66c19be960f114b69787746b2487e6f23a73577`
and consumer `6adf99f1301557ee5b95269581a3acd4162496b4`. Later evidence and
documentation commits preserve those identities.

| Evidence | Measured result | Scope |
| --- | --- | --- |
| [Complete source/native populations and exact costs](native-v8-b66c19b-all/README.md) | 665/665 expansion, 23/23 interoperability and 11/11 gallery cases passed source/native admission and exact token metering | All source/admitted artifacts, native receipts, exact inputs, serializer/token records, reference evidence and paired historical comparison retained |
| [Final producer regression](producer-regression-b66c19b/README.md) | 1,778 passed, six conditional skips, zero failures; 5/5 contracts and 8/8 references passed | Exact producer `b66c19b`; full logs and code/test identities retained |
| [Fresh production dataset](dataset-v8-b66c19b/README.md) | 34 freshly admitted episodes and 898 complete examples, with actual tokenizer re-encoding, masks, EOS and frozen component splits checked | Same producer/consumer; zero optimizer steps |

All eight former enumeration refusals and the previous generator continuation
failure pass in this new full run. The independent consumer passed 214 focused
tests without skips. Expansion coverage contains 458 compact-containing episodes
and 207 wholly detailed episodes; detailed targets remain 86.58% of generated
tokens. On 42 exactly matched historical cases, total flat tokens decrease
90.21% and generated tokens decrease 4.12%. Eight individual cases cost more;
the full comparison preserves them. The population denominators are separate
and may contain overlapping source cases.

External-model comprehension and execution, model optimization, native serving
latency/cache behavior and default promotion remain unqualified. These source,
native, tokenizer and dataset results do not establish learned-execution gains.

## Historical qualifications

The original reports below are unchanged. Their failures, refusals, skips and
measured pins describe those runs; the newer qualification does not rewrite them.

| Evidence | Measured result | Scope |
| --- | --- | --- |
| [Native interoperability and gallery](native-v8-8d1f7b5/README.md) | 22/22 interoperability and 11/11 gallery cases passed source/native admission and exact token metering | Producer `8d1f7b5`, consumer `be3a8d7`; all receipts, inputs, masks and costs retained |
| [Full expansion and paired costs](native-v8-8d1f7b5-all/README.md) | 665 attempts: 657 source passes, 656 native admissions, eight source refusals and one native continuation failure; exact tokens for all source passes | Same producer/consumer; 42 matched historical rows have 90.21% lower flat total cost and 4.12% fewer generated tokens |
| [Producer regression](producer-regression-2f9bca8/README.md) | 1,740 passed, six optional skips, zero failures; all eight reference checks passed | Exact producer `2f9bca8`; later policy, adapter, CI and evidence changes have separate checks |
| [Combined production dataset](dataset-v8-8d1f7b5/README.md) | 33 admitted gallery/interoperability episodes, 858 complete examples; independently verified prompts, masks, EOS and frozen splits | Producer `8d1f7b5`, consumer `be3a8d7`; zero optimizer steps |
| [Production gallery dataset](dataset-v8-9d76176/README.md) | 11 admitted episodes, 97 complete examples; independently re-encoded prompts/targets, masks, EOS and split bindings | Exact producer `9d76176`, consumer `5a22bc8`; zero optimizer steps |
| [Interrupted native run](native-v8-2f9bca8-interrupted/README.md) | 153 recorded attempts: 16 admitted, 137 failed; 512 untested | Historical producer `2f9bca8`, consumer `5a22bc8`; failures and exact transport bytes preserved |

The `8d1f7b5` expansion run retains its 657 source passes, 656 native admissions,
eight source refusals and one native failure. Its 458 compact-containing episodes
and 86.03% detailed token share remain historical measurements. The interrupted
`ea4ccff` prefix is separately retained in the new qualification's history archive
with all 102 committed expansion attempts and 563 untested or uncommitted cases.

## Baseline before expansion

`baseline-585caf5-v7.json` and `gallery-585caf5-v7.json` were produced by
`585caf58b38360d7e3b53c861e3c64cb611c0eb3` with Node v24.22.3. The source, input
population, execution contracts, environment digest, and every disposition are
recorded in each receipt. This revision adds measurement and documentation; it
has not yet broadened compact lowering or runtime syntax.

| Population | Declared cases | Source qualified | Compact episodes | Detailed episodes |
| --- | ---: | ---: | ---: | ---: |
| Strict training capability probes | 52 | 43 | 2 | 41 |
| Unchanged regression gallery | 11 | 11 | 6 | 5 |

The capability population additionally records six frontend refusals, two owned
unsupported cases, and one callback-reference failure. These remain in the
52-case denominator. Detailed execution is measured execution coverage and is
not counted as compact recognition. Native admission, actual tokenizer costs,
normalization-pair qualification, and model outcomes were untested in these two
runs. Detailed byte share is a byte measurement, never a token estimate.

Reproduce from the exact revision with:

```sh
node tools/generate-capability-ledger.mjs --out baseline.json --version 7
node tools/generate-capability-ledger.mjs --out gallery.json --version 7 --population gallery
```

The initial repository test run started at
`87700e4230360b4a9e564d939cc194b7a6daeb0e` (only the retained plan differs from
reviewed source `c165dad8e8226167ec1649cbe6d654cf8662aaf8`). `npm test` under
Node v24.22.3 reported 1,224 tests: 1,217 passed, six skipped, one failed.
The failure is the pinned Test262 native-module async-negative-completion
fixture: `test/fixtures/test262-module-reference.mjs:80` expected `unsupported`
and received `failed`. This baseline was not green. Subsequent fixes and fresh
runs must retain their own producer identity.

## Interpretation

Historical reports remain historical. Neither these finite probes nor a
successful native parse establish universal ECMAScript conformance or a model
learning gain. The expansion benchmark freezes source families and interactions
before new results are collected. Later reports should compare identical
population digests and keep unavailable outcomes explicit.
