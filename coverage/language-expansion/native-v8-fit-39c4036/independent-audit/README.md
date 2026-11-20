# Independent audit at the final contract pair

This follow-up verifies the evidence added in producer commit
`6bfa59ee4eaa0b3405cad6b1bd5bb3a7003a8108`. It checks the retained results at
producer `012c9fe49a082319bf98ac0c571596da925741a4` and native
`39c4036564428e44cc89caf261f517d856482695`, including current private source
authority. It does not run model inference or repeat training.

The independent source-scoring replay reproduces **3/3 qualified executions on
the fitted training input**, **0/3 on the fitted held-out input**, and **0/6 for
the baseline**. The measured program remains
`"use strict";function run(x){return x+1;}`: input `6` was optimized, while input
`8` was excluded from optimization and early stopping. Both artifacts retain
the same family-hash train identity. These are input-level outcomes for one
program, not evidence of unseen-family or broader language generalization.

## Checks performed

- Verified the summary, all three compressed archives, and all 39 retained
  members against their declared SHA-256 and byte sizes. Original archive and
  member identities are retained in [retained-audit.json](retained-audit.json).
- Checked the exact producer/native revisions, contract digest, source artifact
  byte hashes, six native admission checks per input, and equality of the
  original training and renewed public/context inputs.
- Validated both frozen studies, every declared case/seed, public request hash,
  private artifact hash, and all twelve original selected-result digests.
- Reran `scoreSelectedRegionExecution` on all twelve recorded results using a
  clean producer `012c9fe`, Node `24.22.3`, V8 `13.6.233.17-node.63`, and
  `TZ=Europe/Berlin`. The private artifact was independently source-checked;
  qualified completion required the exact complete public projection and
  contexts. [private-score-recheck.json](private-score-recheck.json) retains
  every outcome.
- Decoded all fifteen original prediction fragments using the production
  codec from clean native `39c4036`. Original emitted IDs reproduce the exact
  retained bytes, including both invalid UTF-8 fragments.
- Recomputed prediction and token totals, source-completion denominators and
  native-compute totals, and checked the retained JUnit result of 244 tests,
  zero failures, errors or skips. This audit verifies that saved native test
  receipt; it does not rerun the complete native suite.

The paired contract digest is
`344f7e99aeed605a1965c70f0e0d8829707d6891437ba43dd743fa304cd777dc`.
The production tokenizer SHA-256 is
`40fb9d7d7795b8bd305aeff39ce9963f3f450915b9553f2938e009be9a1fed60`;
the codec fingerprint is
`7f52faca2fe82273a889023defd2f1a6fd6080a21096ec77e97f4798a0a370b2`.

## Verified retained outcomes and costs

| Final-contract model | Declared rollouts | Training completions | Held-out completions | Original predictions | Verified generated tokens | Unknown-cost attempts |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Zero-update | 6 | 0 / 3 | 0 / 3 | 6 | 344 | 2 |
| Fitted | 6 | 3 / 3 | 0 / 3 | 9 | 405 | 0 |

The baseline contains 564 native-reported original emitted IDs and 3,981 raw
fragment bytes. Its two invalid UTF-8 attempts each preserve 110 IDs. Those
220 IDs remain separately reported: the original conservative outcome is
**344 verified tokens plus two unknown-cost attempts**. Byte verification
does not rewrite that provenance verdict. The fitted study retains 405 IDs
and 1,289 fragment bytes. Every unsuccessful first prediction remains in the
declared denominator, original output, costs, and source-scoring result.

The baseline records 27.111184017987398 seconds of native RPC compute and
39,516.97625300001 milliseconds summed rollout time. The fitted model records
60.49960370398185 seconds and 73,655.82600900003 milliseconds respectively.
These are preserved measurements of these particular runs, not a controlled
performance comparison. They differ from the earlier model study's timings.

The frozen baseline study digest is
`e66140bbbaed1840a29fd327cc4215485cbd2218de822749ac11cb36d59aba6a`;
the fitted study digest is
`908ed9a01ae0005d8f628ada9477ce0ac8cd888c7fcd0bc3fbfa5fc79a6d8d1a`.
Public study requests contain only already observed program/input information
and the declared fixture. The expected source projection remains private to
the post-rollout scorer.

## Repeating this audit

Install the locked dependencies into clean checkouts of the exact producer and
native revisions above. Use Node `24.22.3`, the native Python environment and
the pinned production tokenizer. The scripts load no model weights and make
no inference or optimizer call.

```sh
audit_package=/path/to/tracing-js-self/coverage/language-expansion/native-v8-fit-39c4036
audit_producer=/path/to/clean-producer-012c9fe
audit_native=/path/to/clean-native-39c4036
audit_python=/path/to/native-venv/bin/python
audit_tokenizer=/path/to/pinned-tokenizer.json
audit_output=/path/to/new-audit-output

PYTHONPATH="$audit_native/src" "$audit_python" \
  "$audit_package/independent-audit/audit-retained.py" \
  --native "$audit_native" --tokenizer "$audit_tokenizer" \
  --output "$audit_output"

TZ=Europe/Berlin node "$audit_package/independent-audit/recheck-score.mjs" \
  --producer "$audit_producer" --retained "$audit_output/retained" \
  --output "$audit_output/private-score-recheck.json"
```

Both scripts passed and produced the neighboring receipts. `SHA256SUMS` pins
the audit scripts, documentation and output receipts. The prior
[256-step historical audit](../../native-v8-fit-23cd478/independent-audit/README.md)
preserves the original training evidence and stale-source failures; this
follow-up does not replace or combine their denominators. The separate
four-step diagnostics remain separate experiments.

## Weight-file limitation remains

The reports consistently retain baseline model identity
`2a7eefffb21e8901150e6932ccd3d7f048fa2efb0ed4d9ebc9072feab43f0452` and fitted
identity `fce915db7e521f905bea44cb559c05b3fa1cce25403621e3019b1351cf7ce2a3`
before and after execution, and report zero additional optimizer steps.

The named 43,360,285-byte archive
`native-v8-fit-be453ab-fce915db.tar.zst`, SHA-256
`56bfb096255f810729ec46c0e0d4c050ef035bb1c0d3bfa89a9350eebbd5d5c8`, is still
absent from the repository package and has no published retrieval URL. This
audit did not access those model/checkpoint/optimizer bytes. Consequently it
does not independently verify their hashes, inspect tensor differences, reload
the historical model, regenerate neural emissions, repeat measured runtime
costs, or resume the exact optimizer checkpoint.

The verified result is consistency and independent private-source validity of
the preserved outputs at the current contract pair. Verification that absent
weights generated those outputs remains outside this audit. No training,
inference, generalization or default-promotion claim is added by the audit.
