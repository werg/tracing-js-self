# Language-expansion evidence

## Current v8 qualification

Evidence directories name their exact measured revisions. The current complete
population, physical-cost, component and split-bound dataset gates use producer
`012c9fe49a082319bf98ac0c571596da925741a4` and consumer
`39c4036564428e44cc89caf261f517d856482695`, with the expanded 26-case
interoperability contract. Both frozen checkouts remained clean. The independent
reference benchmark checks the producer only; native component, corpus and
model results keep their separate scopes.

| Evidence | Measured result | Scope |
| --- | --- | --- |
| [Complete source/native populations and exact costs](native-v8-012c9fe-all/README.md) | 665/665 expansion, 26/26 interoperability and 11/11 gallery cases passed source/native admission and exact token metering; 244 native component tests passed without skips | All source/admitted artifacts, exact native inputs/receipts, serializer/token records, reference evidence and matched historical costs retained. Ordinary and independent streaming costs agree byte-for-byte across all 665 expansion artifacts. |
| [Current complete Node 24 producer CI](ci-node24-7855394/README.md) | 1,836 passes, eight explicit skips, zero failures/cancellations out of 1,844 tests; all subsequent contract/fixture/demo checks passed | PR head `7855394` and actual merge checkout `e461fab` have identical complete trees; source tree equals qualification producer `012c9fe`. Includes both timing fixes and the expanded 26-case inventory test. |
| [Isolated real native coordinator follow-up](native-orchestration-isolated-012c9fe/README.md) | All five optional real native coordinator gates passed, with zero failures/cancellations/skips and every original deadline unchanged | Exact clean `012c9fe` / `39c4036`, one test process after the six broad-admission workers exited. Retains the exact compatible served bundle and original-failure analysis; it does not relabel the original failed full regression or establish learned success. |
| [Expanded-contract targeted checks](producer-contract-012c9fe/README.md) | Original six-file run: 42 passes, one timing failure, one timeout cancellation; all 5 contract checks passed. Separate two-file timing follow-up: 24/24 passed. | Original clean `012c9fe` failure retained. Follow-up identity is coordinator-reported patch subsequently published as `c0524b4`, not an instrumented clean-commit run. |
| [Current production dataset](dataset-v8-012c9fe/README.md) and [independent replication](dataset-v8-012c9fe-independent/README.md) | 37 freshly admitted episodes, 1,021 complete examples and 33,850 generated tokens including EOS; actual tokenizer re-encoding, masks and frozen component splits checked | Exact `012c9fe` / `39c4036`; both separate fresh exports retain their own qualification reports and execution receipts. Candidates, datasets and all 37 native input/receipt pairs are byte-identical. This is one 37-episode inventory, not 74 episodes; zero optimizer steps. |

Focused protocol populations have separate exact receipts and do not change
those corpus denominators. The current rows below were freshly measured under
the final expanded contract:

| Supplementary evidence | Measured result | Scope |
| --- | --- | --- |
| [Direct and nested Number callback throws](number-abrupt-012c9fe/README.md) | 2/2 fresh source/native/token admissions | Producer `012c9fe`, consumer `39c4036`; final contract, exact abrupt completions and suppressed fallback. The earlier [3a1992b pair](number-abrupt-3a1992b/README.md) retains its own historical receipts. |
| [Number callback catch/finally](number-completion-012c9fe/README.md) | 13 declared: 12 fresh source/native/token admissions and one explicit Symbol cleanup refusal | Producer `012c9fe`, consumer `39c4036`; the current suite removes the former loop-target refusal. The earlier [14-case ddaac82 population](number-completion-ddaac82/README.md) remains historical. |
| [Flat iterable bindings](iterable-binding-012c9fe/README.md) | 17 declared: 14 fresh source/native/token admissions and three explicit source refusals | Producer `012c9fe`, consumer `39c4036`; flat initialized variable ArrayPatterns, elision, defaults, rest, cached next and cleanup behavior |
| [Synchronous custom iterators](custom-iterator-012c9fe/README.md) | 20 declared: 16 fresh source/native/token admissions and four explicit source refusals | Producer `012c9fe`, consumer `39c4036`; exact acquisition/cached-next/close behavior, nested labeled cleanup and completion precedence; explicit 300-second native bound |

All eight former enumeration refusals and the previous generator continuation
failure pass in the final full run. The independent consumer passed 244 component
tests without skips at the same exact pair. Expansion coverage contains 458
compact-containing episodes and 207 wholly detailed episodes; detailed targets
remain 86.58% of generated
tokens. On 42 exactly matched historical cases, total flat tokens decrease
90.21% (13,139,870 to 1,286,652) and generated tokens decrease 4.12%
(34,554 to 33,132). Eight individual cases cost more; the full comparison
preserves them. The population denominators are separate and may contain
overlapping source cases.

These source/native/data receipts do not establish learned generalization,
broader accuracy, serving efficiency or default promotion. Model experiments
have separate declared inputs, runs and limits.

## Measured native model experiments

| Experiment | Retained result | Scope and cost evidence |
| --- | --- | --- |
| [Four-step fitting and serving diagnostics](../../docs/evidence/semantic-v8-diagnostic-pilot/2026-11-20/README.md) | Two independently initialized models, four optimizer updates each; each frozen study completed 0/2 executions | Full weights and malformed outputs retained. Corrected split-role study: 67 verified generated tokens and 341 bytes, zero unknown-cost attempts; exploratory, with no success or generalization gain. |
| [Audited current-contract study](native-v8-fit-39c4036/independent-audit/README.md) | Reported 256-step model: 3/3 source-qualified optimized-input executions, 0/3 excluded-input executions; zero-update baseline 0/6 | Producer `012c9fe`, consumer `39c4036`. Fitted 405 verified tokens; baseline 344 verified tokens plus two unknown-cost attempts. All twelve result digests/private-source scores and fifteen emitted fragments independently rechecked. |

The latter study uses one increment program and two inputs. Both artifacts have
the same family-hash **train** identity; “held-out input” means exclusion from
optimization and early stopping, not an unseen program or family. Original
native-compute and rollout timing measurements are retained, but their runtime
conditions do not establish a controlled serving-efficiency comparison or cache
benefit. The two baseline invalid-UTF8 attempts preserve 220 additional
native-reported token IDs; they are not added to the 344 verified-token count.

The independent audit verifies preserved output bytes, identities and private
source validity without repeating training or inference. Its named 43,360,285-byte
historical checkpoint archive is unavailable in the repository and has no
retrieval URL, so that audit cannot independently hash/reload those weights,
inspect tensor changes or establish that those absent weights generated the
outputs. The [earlier 256-step audit](native-v8-fit-23cd478/independent-audit/README.md)
retains the original training evidence and stale-source failures separately.
Neither audit merges its denominators with the four-step diagnostics.

External-model comprehension remains unmeasured; generalized learned execution,
controlled serving benefits and default promotion remain unqualified. v6 stays
the production default.

## Historical qualifications

The original reports below are unchanged. Their failures, refusals, skips and
measured pins describe those runs; the newer qualification does not rewrite them.

| Evidence | Measured result | Scope |
| --- | --- | --- |
| [Original zero-skip producer regression](producer-regression-012c9fe/README.md) | Original `012c9fe` run: 1,840 passes, three failures and one cancellation, zero skips; all five contracts and eight references passed | Preserves the stale 23-case inventory assertion, callback timeout and two optional native lifecycle deadline outcomes. Passing current CI and scoped follow-ups do not rewrite this failed full run. |
| [Earlier complete source/native populations](native-v8-b66c19b-all/README.md) | 665/665 expansion, 23/23 interoperability and 11/11 gallery admissions and physical costs | Exact producer `b66c19b` / consumer `6adf99f`; separate from the final expanded contract and current whole-population rerun |
| [Earlier 34-episode production dataset](dataset-v8-492328f/README.md) | 34 freshly admitted episodes and 898 complete examples | Producer `492328f`, consumer `cb311db`; earlier split-bound admissions are not assigned to the current 37-episode export |
| [Previous-contract qualification and components](native-v8-562f6f2-superseded/README.md) | Producer `562f6f2` / consumer `d26afd9`: 168/665 expansion admissions before interruption, complete original 23+11 populations/costs; partial supplements and earlier 220/221/242/244-test native runs retained | Four verified archives preserve all original scopes; the final expanded contract requires new 26+11 qualification |
| [Superseded qualification attempts](native-v8-3a1992b-interrupted/README.md) | Producer `3a1992b` / consumer `418385b`: complete 23-case interoperability and 11-case gallery admissions/costs; 594/665 expansion admissions before interruption, with 71 untested or uncommitted | Retains exact artifacts/inputs, original failures and supersession receipts; the custom-iterator timeout and other earlier prefixes are separate historical scopes |
| [Complete earlier local producer regression](producer-regression-9d4f6b3/README.md) | 1,834 passed, six conditional skips, zero failures; 5/5 contracts and 8/8 references passed | Exact `9d4f6b3`; separate targeted 24/24 checks at `562f6f2` and interrupted 800 history retained |
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
