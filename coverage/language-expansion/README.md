# Language-expansion evidence

## Current v8 qualification

Evidence directories name their exact measured revisions. The latest retained
complete-population run measured producer `b66c19be960f114b69787746b2487e6f23a73577`
and consumer `6adf99f1301557ee5b95269581a3acd4162496b4`. The later production
dataset independently readmits its complete inventory at producer
`492328fe387e99487285984b782cd3b402990e2c` and consumer
`cb311dba6af44ef241450a87ef530a66aa55c7a3`. Neither evidence set qualifies
unmeasured later implementation changes.

| Evidence | Measured result | Scope |
| --- | --- | --- |
| [Complete source/native populations and exact costs](native-v8-b66c19b-all/README.md) | 665/665 expansion, 23/23 interoperability and 11/11 gallery cases passed source/native admission and exact token metering | All source/admitted artifacts, native receipts, exact inputs, serializer/token records, reference evidence and paired historical comparison retained |
| [Frozen producer regression](producer-regression-9d4f6b3/README.md) | 1,834 passed, six conditional skips, zero failures; 5/5 contracts and 8/8 references passed | Exact producer `9d4f6b3`; full logs and clean identities retained. A subsequent 24/24 targeted run at `562f6f2` has separate coordinator-reported identity and original logs. |
| [Latest production dataset](dataset-v8-492328f/README.md) | 34 freshly admitted episodes and 898 complete examples, with actual tokenizer re-encoding, masks, EOS and frozen component splits checked | Producer `492328f`, consumer `cb311db`; fresh 23-case interoperability and 11-case gallery admission; zero optimizer steps |

Two later focused Number populations have separate exact receipts and do not
change those corpus denominators:

| Supplementary evidence | Measured result | Scope |
| --- | --- | --- |
| [Direct and nested Number callback throws](number-abrupt-3a1992b/README.md) | 2/2 source/native/token admissions | Producer `3a1992b`, consumer `418385b`; exact abrupt completions and suppressed fallback |
| [Number callback catch/finally](number-completion-ddaac82/README.md) | 14 declared: 12 source/native/token admissions and two explicit source refusals | Producer `ddaac82`, consumer `91aea0d`; preserves the failed admission attempt at consumer `1967695` separately |

All eight former enumeration refusals and the previous generator continuation
failure pass in this new full run. The independent consumer passed 214 focused
tests without skips. Expansion coverage contains 458 compact-containing episodes
and 207 wholly detailed episodes; detailed targets remain 86.58% of generated
tokens. On 42 exactly matched historical cases, total flat tokens decrease
90.21% and generated tokens decrease 4.12%. Eight individual cases cost more;
the full comparison preserves them. The population denominators are separate
and may contain overlapping source cases.

External-model comprehension, generalization, controlled model-execution
comparisons, serving efficiency and default promotion remain unqualified by
these source/native/data receipts. A separate [native fitting and frozen-serving
diagnostic](../../docs/evidence/semantic-v8-diagnostic-pilot/2026-11-20/README.md)
performed four optimizer updates for each of two independently initialized
models. Each frozen two-case study completed zero of two executions; actual
weights, malformed outputs and all measured costs are retained. Performing
those bounded diagnostics does not establish learned-execution or generalization
gains.

## Historical qualifications

The original reports below are unchanged. Their failures, refusals, skips and
measured pins describe those runs; the newer qualification does not rewrite them.

| Evidence | Measured result | Scope |
| --- | --- | --- |
| [Superseded qualification attempts](native-v8-3a1992b-interrupted/README.md) | Producer `3a1992b` / consumer `418385b`: complete 23-case interoperability and 11-case gallery admissions/costs; 594/665 expansion admissions before interruption, with 71 untested or uncommitted | Retains exact artifacts/inputs, original failures and supersession receipts; the custom-iterator timeout and other earlier prefixes are separate historical scopes |
| [Earlier producer regression](producer-regression-3a1992b/README.md) | 1,794 passed, six conditional skips, zero failures; 5/5 contracts and 8/8 references passed | Exact producer `3a1992b`; original logs, identities and interrupted predecessor retained |
| [Earlier producer regression](producer-regression-b66c19b/README.md) | 1,778 passed, six conditional skips, zero failures; 5/5 contracts and 8/8 references passed | Exact producer `b66c19b`; original logs and identities retained |
| [Earlier 34-episode production dataset](dataset-v8-b66c19b/README.md) | 34 freshly admitted episodes and 898 complete examples | Producer `b66c19b`, consumer `6adf99f`; its receipts are not reused to admit the later dataset |
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
