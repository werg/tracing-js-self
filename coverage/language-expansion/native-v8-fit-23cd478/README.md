# Actual native v8 fit and source-authoritative execution

The unchanged fitted native model completed the training input on **all three
declared seeds** and failed the held-out input on **all three seeds**. The
zero-update model completed none of its six declared runs. This is a bounded
in-sample feasibility result for one two-record program; it establishes no
held-out generalization or external-model comprehension.

The [machine-readable summary](summary.json) preserves the original aggregate
results and supplies per-attempt costs, raw native emission counts, source
admission identities, and explicit qualifications. Full original reports are
retained byte for byte in the archives, including both earlier confounded
evaluations. No failed generation was replaced with a teacher record.

## Program, training, and fixed revisions

```javascript
"use strict";function run(x){return x+1;}
```

Only input `6` / result `7` participated in optimization. Input `8` / expected
result `9` was held out of both optimization and early stopping. Each reference
execution has an `algorithm` record followed by an explicit detailed `end`.

| Phase | Producer revision | Native consumer revision |
| --- | --- | --- |
| Source admission and 256-step training | [`c65a905`](https://github.com/werg/tracing-js-self/commit/c65a905cd01ea7b9e8f211b19c02414b1a5dbb0d) | [`be453ab`](https://github.com/werg/megatoken/commit/be453ab44847ea0b84f262909f31ba5c247851fa) |
| Final frozen execution and fresh source authority | [`9d4f6b3`](https://github.com/werg/tracing-js-self/commit/9d4f6b3fcff97e7f915ae9c7228f7fd75aaaec3c) | [`23cd478`](https://github.com/werg/megatoken/commit/23cd47816f9b99bbdb2ec9a32dd455daf68b732b) |

The model was native `tiny` with 4,051,928 served parameters, FP32 on CPU with
one PyTorch thread. `MasterAdamW` updated 33 decoder parameter owners for 256
steps at learning rate `0.02` and zero weight decay. Encoder, recurrence, prior,
and native memory stayed frozen. Every update scored 74 admitted generated text
tokens: 61 algorithm tokens and 13 end-record tokens. Native termination uses
physical terminal flags, with zero appended EOS tokens. The actual optimizer
and complete native transducer are retained in the full checkpoints.

Training loss fell from `12.96456527709961` to `0.07884156703948975`. Optimizer
work took `285.3928568228948` seconds; fitting plus intermediate evaluations
took `321.92739702900144` seconds. These numbers describe this diagnostic run,
not production training quality.

The production Ling tokenizer asset is pinned to SHA-256
`40fb9d7d7795b8bd305aeff39ce9963f3f450915b9553f2938e009be9a1fed60`;
the codec fingerprint is
`7f52faca2fe82273a889023defd2f1a6fd6080a21096ec77e97f4798a0a370b2`.

## Final frozen process study

Each model was declared on two inputs and seeds `17`, `29`, and `43` before
inference. The runtime attested `{device: "cpu", maxTokens: 128,
maxFragments: 1, effort: 1}`. Each rollout allowed at most four predictions,
eight generated records, one outstanding request, zero stale retries, and a
30-second timeout. All twelve declared rollouts settled; both processes shut
down gracefully with exit code zero.

| Model / case | Completed and source-validated executions | Actual prediction attempts | Verified generated tokens | Unverified cost attempts |
| --- | ---: | ---: | ---: | ---: |
| Zero-update, training input `6` | 0 / 3 | 3 | 234 | 0 |
| Zero-update, held-out input `8` | 0 / 3 | 3 | 110 | 2 |
| Fitted, training input `6` | 3 / 3 | 6 | 222 | 0 |
| Fitted, held-out input `8` | 0 / 3 | 3 | 183 | 0 |

Every fitted training-input run generated the exact algorithm result `7` and
then the exact explicit `end`. Both independent native replay and the private
source comparison accepted those executions. Every fitted held-out run emitted
malformed algorithm JSON and was rejected on its first attempt. Its original
61 emitted tokens remain recorded in each seed's result.

The aggregate fitted rate is numerically 3/6, but that denominator mixes the
training input with one held-out input. It must not be described as a 50%
generalization score. Repeating one training case across seeds does not add
three distinct source programs or three distinct held-out cases.

Serving received the initial public observations and current contexts; later
contexts were reconstructed from accepted model output. The selector did not
receive the expected record or private source evidence. Every native candidate
was staged separately and advanced only after the producer acknowledged its
committed record. Full checkpoints were saved and reloaded before serving.

## Costs and failed-emission accounting

| Aggregate over six rollouts | Zero-update | Fitted |
| --- | ---: | ---: |
| Verified generated tokens | 344 | 405 |
| Native-reported generated token IDs | 564 | 405 |
| Native-reported tokens on unverified attempts | 220 | 0 |
| Unverified generation-cost attempts | 2 | 0 |
| Published observation tokens | 6,066 | 6,066 |
| Repeated current-context tokens | 4,632 | 7,026 |
| Instruction tokens | 450 | 675 |
| Textual input tokens excluding session metadata | 11,148 | 13,767 |
| Sum of rollout elapsed time | 28.861 seconds | 32.811 seconds |
| Reported native RPC compute time | 19.020 seconds | 23.413 seconds |
| Native peak process memory | 532,385,792 bytes | 524,713,984 bytes |

The two unverified baseline attempts are held-out seeds `17` and `29`. Each
retains 110 original emitted token IDs, its fragment bytes, and its measured
runtime. An independent audit using the production codec confirms that decoding
the IDs reproduces those bytes exactly. The bytes nevertheless contain invalid
UTF-8, so the native text-fragment/provenance gate refuses them. The report's
conservative total remains **344 verified tokens plus two unknown-cost
attempts**. The separately retained native count of 220 is not silently added to
that verified total. This is a validation distinction, not missing attempt logs
or absent raw accounting.

Each successful run incurred 1,011 observation tokens once, then contexts of
772 and 798 tokens, plus 75 instruction tokens for each prediction. It did not
reingest the observations at the second prediction. The post-generation native
cache grew from 15 resident events / 7,680 bytes after the first record to 20
events / 10,240 bytes after the second. The archives retain full context/cache
snapshots and per-attempt preparation, generation, and total timing.

The table's textual input total excludes session metadata and does not assign
artificial token counts to learned controls, retrieval, or tensor operations.
The separate in-process evidence measures 42 session metadata tokens per opened
session. Rollout elapsed time includes process initialization for the first row
and controller work; the six rows are not six independent cold starts. These
CPU timings are not a controlled v6/v8 performance comparison.

## Earlier failures retained without rewriting

1. **Original training evaluator:** it supplied `entry: "run"` instead of the
   canonical host-owned algorithm descriptor. Native validation initially missed
   that defect. The altered prefix confounded second-record evaluation, although
   optimization targets and captured training boundaries were unaffected. The
   original report still says `inSampleExactSuccess: false`, and every
   intermediate generated failure remains archived.
2. **Corrected development reevaluation:** after constructing and independently
   checking the canonical entry, the same final weights completed input `6` and
   failed input `8`. There were no further optimizer updates. Real trainer and
   serving state matched exactly at both fitted prediction boundaries: raw
   state, history key/value tensors, tracks, purposes, and controls. The original
   zero-update first-boundary comparison is also retained.
3. **First JavaScript/process study:** old private source artifacts named the
   earlier producer environment. Its fresh source-identity recheck rejected that
   authority. The fitted model completed three public traces, but the run had
   **zero qualified executions**, and its original reports retain that result.
4. **Final JavaScript/process study:** fresh source artifacts and independent
   native receipts were produced at the final study pins above. Their public
   observations and contexts are identical to the training artifacts, while the
   private source authority changed. All six native admission gates passed for
   both inputs. The study was frozen and rerun without retraining, yielding the
   three qualified in-sample executions reported here.

## Retained files and verification

| File | Contents |
| --- | --- |
| [summary.json](summary.json) | Qualified outcomes, exact pins, identities, costs, per-attempt dispositions, and limitations |
| [artifact-index.json](artifact-index.json) | SHA-256 and byte size for every compressed archive and every original member |
| [training-and-parity.tar.xz](training-and-parity.tar.xz) | Original confounded trainer report, baseline, every intermediate attempt, corrected development replay, real state parity, model/checkpoint metadata, and codec/UTF-8 audit |
| [source-admission.tar.xz](source-admission.tar.xz) | Original training inputs and regenerated current source inputs, manifests, policies, admitted copies, and exact native receipts |
| [studies.tar.xz](studies.tar.xz) | Both models' frozen studies, private cases, settings, identities, and complete original reports for both source-authority runs |
| [verify.py](verify.py) | Read-only archive integrity, source/context equality, admission, outcome, and accounting verification |

Run the standard-library verifier from any working directory:

```sh
python coverage/language-expansion/native-v8-fit-23cd478/verify.py
```

The three archives retain 53 original JSON files. They omit large model weights.
Both served bundles, full checkpoints, optimizer states, transducer attachments,
and production tokenizer are separately retained in
`native-v8-fit-be453ab-fce915db.tar.zst` (43,360,285 bytes), SHA-256
`56bfb096255f810729ec46c0e0d4c050ef035bb1c0d3bfa89a9350eebbd5d5c8`.
No public download location for that retained archive is published here.

| Model artifact | SHA-256 |
| --- | --- |
| Zero-update served model | `2a7eefffb21e8901150e6932ccd3d7f048fa2efb0ed4d9ebc9072feab43f0452` |
| Fitted served model | `fce915db7e521f905bea44cb559c05b3fa1cce25403621e3019b1351cf7ce2a3` |
| Zero-update full checkpoint | `5a221c7debde04a73168e0f0c0abe5fa6e51ff114e0ef73b2b647b403d81bccf` |
| Fitted full checkpoint | `3bb46a876f1bf2a4fa3b744f251385bbebdc97c7af9bca4c9c74e9074543846c` |

To repeat inference, use the exact producer and consumer revisions, restore the
served bundle, and run `tools/run-semantic-v8-experiment.mjs` with the retained
frozen study and private cases. Source admission binds the verifier environment;
a new checkout or runtime may require fresh source authority and a newly frozen
study, as this experiment itself demonstrated. Do not reuse a source-admission
claim after its identity recheck fails. For new optimization, use the companion
consumer's `scripts/fit_semantic_v8.py` with freshly admitted source bytes and
record the resulting model's new identity.

These historical receipts stay attached to the listed revisions and contract;
later implementation changes do not promote them to a different contract. This
folder is distinct from any other diagnostic pilot, and makes no broad language
coverage, external comprehension, ordinary production-training, or serving-cost
advantage claim.
