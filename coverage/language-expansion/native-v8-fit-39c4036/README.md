# Final-revision native model execution

The unchanged fitted model completed the training input on **all three declared
seeds** and failed the held-out input on **all three seeds**, now using the final
contract/frontend pair. The zero-update model completed none of its six runs.
All twelve declared rollouts finished and both native processes shut down
gracefully. The complete native test gate also passed: **244 tests, zero
failures, errors, or skips**.

This packet is a fresh exact-revision check of the previously retained bounded
fit. It establishes in-sample execution of one two-record program. It provides
no held-out generalization, external comprehension, broad learned language
coverage, or v6/v8 performance advantage claim.

## Exact inputs and identities

| Component | Revision |
| --- | --- |
| Producer/frontend/source authority | [`012c9fe49a082319bf98ac0c571596da925741a4`](https://github.com/werg/tracing-js-self/commit/012c9fe49a082319bf98ac0c571596da925741a4) |
| Native consumer and serving code | [`39c4036564428e44cc89caf261f517d856482695`](https://github.com/werg/megatoken/commit/39c4036564428e44cc89caf261f517d856482695) |

The paired contract digest is
`344f7e99aeed605a1965c70f0e0d8829707d6891437ba43dd743fa304cd777dc`.
Both checkouts were clean before and after native tests and model execution.

```javascript
"use strict";function run(x){return x+1;}
```

Input `6` / result `7` was the sole training example. Input `8` / expected result
`9` was held out of the optimizer and early stopping. Reference executions have
one `algorithm` record and one explicit detailed `end`. New source artifacts
received all six independent native admission passes: replay, contexts,
continuation, masks, source binding, and production tokenizer. Their public
observations and contexts are exactly equal to the original training inputs;
the renewed private source authority is distinct.

The baseline and fitted served-model SHA-256 identities remained unchanged
before and after this run:

- Baseline: `2a7eefffb21e8901150e6932ccd3d7f048fa2efb0ed4d9ebc9072feab43f0452`.
- Fitted: `fce915db7e521f905bea44cb559c05b3fa1cce25403621e3019b1351cf7ce2a3`.

The original fit performed 256 actual decoder optimizer updates. This
revalidation performed **zero additional optimizer updates** and used the same
saved and reloaded bundles. The production tokenizer asset SHA-256 is
`40fb9d7d7795b8bd305aeff39ce9963f3f450915b9553f2938e009be9a1fed60`;
its codec fingerprint is
`7f52faca2fe82273a889023defd2f1a6fd6080a21096ec77e97f4798a0a370b2`.

## Frozen outcomes

Both models used inputs `6` and `8`, seeds `17`, `29`, and `43`, and the attested
settings `{device: "cpu", maxTokens: 128, maxFragments: 1, effort: 1}`. Each
rollout allowed four predictions, eight generated records, one outstanding
request, zero stale retries, and a 30-second timeout. The same declared limits
were used for the earlier study.

| Model / input | Completed and source-validated | Actual predictions | Verified generated tokens | Unknown-cost attempts |
| --- | ---: | ---: | ---: | ---: |
| Baseline, training input `6` | 0 / 3 | 3 | 234 | 0 |
| Baseline, held-out input `8` | 0 / 3 | 3 | 110 | 2 |
| Fitted, training input `6` | 3 / 3 | 6 | 222 | 0 |
| Fitted, held-out input `8` | 0 / 3 | 3 | 183 | 0 |

All three fitted training-input runs generated the exact algorithm result `7`
and explicit `end`, with both native replay and private source comparison
passing. Every fitted held-out run emitted malformed algorithm JSON and was
rejected on its first prediction. Neither teacher targets nor repaired
candidates were supplied to serving. Subsequent contexts came only from actual
accepted model output, with explicit native commit acknowledgements.

The combined fitted result is numerically 3/6, but it mixes one training input
with one held-out input. It is not a 50% generalization score. There are zero
held-out successes, and the three successful seeds repeat one source/input case.

## Measured work at these revisions

| Total across six rollouts | Baseline | Fitted |
| --- | ---: | ---: |
| Verified generated tokens | 344 | 405 |
| Native-reported original token IDs | 564 | 405 |
| Native-reported tokens on unverified attempts | 220 | 0 |
| Observation / context / instruction tokens | 6,066 / 4,632 / 450 | 6,066 / 7,026 / 675 |
| Text input tokens excluding session metadata | 11,148 | 13,767 |
| Sum of rollout elapsed time | 39.517 seconds | 73.656 seconds |
| Reported native RPC compute time | 27.111 seconds | 60.500 seconds |
| Native peak process memory | 527,986,688 bytes | 528,179,200 bytes |

The two unknown-cost baseline attempts preserve 110 emitted token IDs each,
raw fragment bytes, and timing. The fresh independent codec audit reproduces
all 15 fragments byte for byte from their original IDs. Those two fragments
contain invalid UTF-8, so their text/provenance validation fails. The verified
baseline total remains **344 plus two unknown-cost attempts**; the separately
retained native count of 220 is not silently added to it. Raw cost evidence was
preserved even when the candidate could not qualify.

Each successful rollout ingested 1,011 observation tokens once, followed by
contexts of 772 and 798 tokens and 75 instruction tokens per prediction. Native
post-generation cache snapshots contain 15 events / 7,680 bytes after the first
record and 20 events / 10,240 bytes after the second. Full per-attempt preparation,
generation, total timing, original IDs/bytes, and cache snapshots are archived.

Textual counts exclude session metadata and do not assign artificial token
counts to native controls, retrieval, or tensor work. First-row elapsed time
includes initialization; six rollouts are not six independent cold starts.
These are fresh measured timings, which differ from the earlier study. They
are not a controlled performance comparison or a claim of improvement.

## Full native regression gate

At the same clean pins, the workflow-selected suite passed **244 tests across
27 modules**, including the live source-authority tests, with zero skips.
Pytest reported 383.57 seconds. Full Ruff lint passed, all 532 checked Python
files were already formatted, and `git diff --check` passed. The retained
summary binds every command, log, JUnit result, environment setting, policy,
tokenizer, and before/after checkout identity.

The actual native runtime used Python 3.12.14, PyTorch 2.10.0+cpu, tokenizers
0.23.3, Ruff 0.17.6, and Node v24.22.3. Both observation and model evidence refer
to these measured revisions, rather than later documentation or workflow commits.

## Retention and independent verification

| File | Retained evidence |
| --- | --- |
| [summary.json](summary.json) | Exact pins, unchanged model hashes, complete outcomes, per-attempt costs, and limitations |
| [artifact-index.json](artifact-index.json) | SHA-256 and byte sizes for every archive and member |
| [source-admission.tar.xz](source-admission.tar.xz) | Fresh source/native/admitted artifacts, original training inputs for exact comparison, policy, and preparation script/log |
| [model-study.tar.xz](model-study.tar.xz) | Frozen declarations, private cases, full unchanged reports, original failed emissions, identity receipt, scripts/logs, and codec/UTF-8 audit |
| [native-validation.tar.xz](native-validation.tar.xz) | Full native test, lint, formatting, clean-checkout and JUnit evidence |
| [verify.py](verify.py) | Standard-library verification of all retained bytes, source/context equality, gate results, and cost accounting |

```sh
python coverage/language-expansion/native-v8-fit-39c4036/verify.py
```

The three deterministic archives preserve 39 members. The
[earlier immutable experiment packet](https://github.com/werg/tracing-js-self/tree/e91ba6c78f1d3e53947bfdf84c6549ba8e7ddd99/coverage/language-expansion/native-v8-fit-23cd478)
remains unchanged. It retains the original confounded trainer evaluation, real
trainer/serving state parity, corrected development replay, failed first source
authority run, and first successful fresh-authority run. This packet adds the
final-revision result without replacing those historical outcomes.

Large weights are separately retained in
`native-v8-fit-be453ab-fce915db.tar.zst` (43,360,285 bytes), SHA-256
`56bfb096255f810729ec46c0e0d4c050ef035bb1c0d3bfa89a9350eebbd5d5c8`.
That archive includes both served bundles, full checkpoints and optimizer state,
native transducers, production tokenizer, and original training evidence.
No public download location is published here.
