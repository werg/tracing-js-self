# Original frozen V8 trajectory: 314 + 34 = 348

The original interrupted trajectory now completes its full, bounded one-pass
target and prepared-text position census. [Run 45043236761](https://github.com/werg/tracing-js-self/actions/runs/45043236761)
completed successfully, including the frozen native independent census. A second
read-only audit loaded the retained original and final checkpoints through the
original native reader, verified their hashes and histories, and independently
reconstructed the prepared text positions again. That audit performed **zero
optimizer updates** and passed without stderr.

This closes the original 314/348 target/position gap. It does not establish learned
success, evaluate held-out quality, export or serve the 348-update weights, cover
internal router positions, or promote a default. The separate two-update lifecycle
and the later router-aware fresh-fit campaign remain distinct evidence.

## Exact source and runtime

| Role | Identity |
| --- | --- |
| Continuation driver | `2dd1d31d717e89c2121d0cd8c2de9915464b4e45` |
| Original producer | `9cf091e6ccc5add960ef0897576d0c391b199a65` |
| Original native training and independent reader | `1a69d9da3254b7568c831d12866a629c206cf4fe` |
| Original interrupted run | [45023684906](https://github.com/werg/tracing-js-self/actions/runs/45023684906) |
| Successful continuation | [45043236761](https://github.com/werg/tracing-js-self/actions/runs/45043236761), attempt 1, job `137272106443` |
| Locked runtime | Python 3.12.14, Torch 2.10.0+cpu, NumPy 2.5.5, safetensors 0.8.0, tokenizers 0.23.3; workflow Node 24.22.3 |

The driver verified the original archive, exact source checkouts, original Python
and package versions, original path locators, immutable prepared input bytes,
optimizer state, cursor, sampler and RNG state before training. The normalized
configuration differs only in the per-invocation `max_steps` cap: 348 becomes 34.
The frozen native engine applies that cap to `updates_this_run`, while resuming
the original global step and history. Both target and position objective identity
exclude this administrative invocation cap.

The local audit used the same Python and package versions with the exact clean
native reader. Its Linux platform differs from the hosted execution and is
recorded explicitly in `independent-audit.json`. It did not perform optimization
or claim a bitwise replay of the training computation.

## Accounting verified against actual saved state

| Population | Original checkpoint | Added by continuation | Final checkpoint |
| --- | ---: | ---: | ---: |
| Optimizer updates in this trajectory | 314 | 34 | 348 |
| Training sources with target receipts | 44 | 4 | 48 |
| Logical targets | 628 | 68 | 696 |
| Physical target records | 650 | 70 | 720 |
| Lexical positions | 23,519 | 2,508 | 26,027 |
| Reconstruction positions | 23,519 | 2,508 | 26,027 |
| Structure labels | 2,600 | 280 | 2,880 |
| Terminal labels | 1,300 | 140 | 1,440 |
| Modality labels | 650 | 70 | 720 |

Lexical and reconstruction positions overlap. These are objective-specific
denominators, not disjoint populations to sum into a unique-position total.
All 720 physical targets have verified prepared-text position receipts, with
zero missing, unexpected, unmeasured, repeated-window, occurrence, oracle or
denominator mismatches in the applicable comparisons. The 64-source cohort
retains its 48/12/4 train/validation/test split; this fit covers the 48 training
sources and makes no held-out accuracy claim.

The complete original metrics prefix remains byte-identical. Exactly 34 appended
`train` rows have global steps 315 through 348 in order. The final saved checkpoint
is `SE-000000348-periodic`, resolved through its checksummed latest pointer.
All 650 prior physical target and position rows are unchanged; the final history
adds exactly the missing 70 records. There is no phase transition or history reset.

The audit additionally observed 310 changed optimizer master tensors among 404
retained owners. All 315 pre-existing moment owners remain, with no new moment
owners: 272 counters advance by 34, 39 by 8, and 4 by 4. Per-parameter counters
differ because not every parameter participates in every training window. These
facts corroborate actual continued optimization and do not measure learned
quality.

The training command completed in 594.414 seconds; the frozen independent target
and position qualification completed in 134.339 seconds. Both receipts have exit
code 0, no timeout, no stream errors and no exception. All 14 driver refusal and
accounting controls passed without skips.

The final native metric correctly records `complete: false` and
`termination: "step_limit"`: the bounded census consumes 52,054 P-units against a
200,000,000-unit phase budget. The successful claim is completion of the exact
one-pass target/position census, not exhaustion of the full phase budget.

## Original failure and byte custody

The original failed command report is retained unchanged and still says
`status: "failed"`. Its `optimizerUpdates: 2` refers to the distinct lifecycle;
its unfinished coverage stage was not retroactively marked successful. The raw
original metrics and checkpoint establish the 314 completed coverage updates.
This continuation supplies a new success receipt without rewriting that history.

| Retained object | Bytes | SHA-256 |
| --- | ---: | --- |
| Original interrupted campaign ZIP | 175,381,869 | `6dc909ecc1c1ed7401fa5ceb1cba7006c07641d530a1550f16a7870af3e483af` |
| Original step-314 state |  | `93828a840122cc2e209e1c448396324595adef476d610770384291847fdc8499` |
| Final step-348 state |  | `854c37716597b0cb13cece65805ad646ffe837d2ca64bc6de99331bf1bce703a` |
| Continuation original Actions ZIP, artifact `14763057413` | 374,757,456 | `c89b297625afe95bff6b378d4338d31e8f45c766ad86ee28350d08822bf22f1c` |
| Nested transport tar.gz | 374,086,580 | `dae1c7c6e0e90cb926368df7c99ac6670a5bb5c8879f42962956debcaee10791` |

The continuation ZIP includes the byte-original failed ZIP, the resumed runtime
copy, full final checkpoint and prepared inputs, all raw command logs and
receipts, and full coverage report. Its nested archive has 78 regular files and
536,831,446 expanded bytes. `independent-audit.json` records every nested file's
size and SHA-256. Durable custody of the unchanged large ZIP is handled by the
repository's unpublished evidence-archive workflow; this directory retains the
compact independently checked receipts and complete compressed logs.

## Retained files and reproduction

- `metadata.json`: complete run metadata, job result and original artifact metadata.
- `complete-job.log.gz`: complete decoded UTF-8 hosted job log, compressed without
  altering its decoded bytes; its raw and compressed hashes are in
  `complete-job-log.json`.
- `driver-controls.log`, the two stage receipt files, `plan.json`, `preflight.json`
  and `result.json`: original hosted outputs without rewritten contents.
- `complete-metrics.jsonl.gz`: complete original-plus-resumed raw metrics.
- `original-failed-command-report.json.gz`: the unchanged original failure report.
- Original and continuation training configurations: the only field change is
  `max_steps`, from 348 to 34.
- `target-position-coverage.json.gz`: the complete frozen native coverage report;
  its semantic digest is
  `ee0f6e2455b53f054a850c66a8a2899aa620e5c13c2f6ade1aacc4899ae45a93`.
- `final-checkpoint-metadata.json`: the actual periodic step-348 checkpoint metadata.
- `audit.py`, `independent-audit.json` and `local-audit-invocation.json`: reproducible
  independent byte, saved-state and prepared-position audit and its observed result.
- `SHA256SUMS.json`: stored-file sizes and hashes for this evidence directory.

Using the original locked Python runtime and clean native checkout at the revision
above, run from the producer repository root with both original ZIPs available:

```sh
PYTHONDONTWRITEBYTECODE=1 OMP_NUM_THREADS=1 MKL_NUM_THREADS=1 \
python docs/evidence/v8-frozen-continuation-20261122/audit.py \
  --artifact /path/to/v8-frozen-continuation-45043236761.zip \
  --metadata docs/evidence/v8-frozen-continuation-20261122/metadata.json \
  --original /path/to/v8-primary-step314-original.zip \
  --native /path/to/original-megatoken-checkout \
  --work /path/to/disposable-audit-copy > independent-audit.json
```

The audit never modifies either ZIP or the frozen native source. Its disposable
directory materializes only the prepared inputs, checksum-bound checkpoints and
tokenizer needed for read-only validation. Repeated runs accept an already
materialized file only when its bytes match exactly.
