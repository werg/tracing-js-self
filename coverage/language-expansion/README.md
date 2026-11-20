# Language-expansion evidence

## Current v8 qualification

Evidence directories describe their exact measured revisions; a later commit
containing a report does not change its source or consumer identity.

| Evidence | Measured result | Scope |
| --- | --- | --- |
| [Native interoperability and gallery](native-v8-8d1f7b5/README.md) | 22/22 interoperability and 11/11 gallery cases passed source/native admission and exact token metering | Producer `8d1f7b5`, consumer `be3a8d7`; all receipts, inputs, masks and costs retained |
| [Producer regression](producer-regression-2f9bca8/README.md) | 1,740 passed, six optional skips, zero failures; all eight reference checks passed | Exact producer `2f9bca8`; later policy, adapter, CI and evidence changes have separate checks |
| [Production gallery dataset](dataset-v8-9d76176/README.md) | 11 admitted episodes, 97 complete examples; independently re-encoded prompts/targets, masks, EOS and split bindings | Exact producer `9d76176`, consumer `5a22bc8`; zero optimizer steps |
| [Interrupted native run](native-v8-2f9bca8-interrupted/README.md) | 153 recorded attempts: 16 admitted, 137 failed; 512 untested | Historical producer `2f9bca8`, consumer `5a22bc8`; failures and exact transport bytes preserved |

The separate 665-case expansion population and paired historical cost comparison
are being completed. External-model comprehension, completed model execution,
native serving latency/cache behavior and default promotion remain unqualified.

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
