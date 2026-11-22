# Independent read-only review of the original348 failures

The historical evaluation remains **failed**, with **zero complete programs out
of all 16 predeclared pure programs**. Its measurement status remains
`measurement-incomplete`. This review confirms two different failure classes;
it does not turn either into a successful learned execution.

| Failure class | Cases | Original model provenance | Source oracle |
| --- | ---: | --- | --- |
| Emitted UTF-8 text does not begin with a permitted generated-record prefix | 8 | Validated | Completed |
| Final fragment is invalid UTF-8 and the native error's aggregate omits that fragment | 8 | Unvalidated in the original run | Completed |

No source-oracle exception, subprocess failure, or exhausted runtime/selection
budget explains these 16 failures. There is a concrete native evidence bug in
the second group, already corrected separately on current native main. That
correction does not make the model's invalid bytes executable.

## Scope and exact identities

- Reviewed producer snapshot: `02add9d951aa05f46d040f55cd53b05ec7b91279`.
- Reviewed native snapshot: `33031866fc7e2d20156a454064aeafd4ef79ccf3`.
- Original failed evaluation: [run 45046754653](https://github.com/werg/tracing-js-self/actions/runs/45046754653),
  attempt 1, job `137282942375`, artifact `14763634179`.
- Historical evaluation driver: `f4bcf1e0bfde2dee398df3df692246b3e93dadef`.
- Original execution pair: producer `9cf091e6ccc5add960ef0897576d0c391b199a65`
  and native `1a69d9da3254b7568c831d12866a629c206cf4fe`.
- Complete original evaluation ZIP: 16,427,247 bytes, SHA256
  `2d575cbec0b543e329e68e9bb1289e3a7f33988866a145a9fb3c641a41ff91ad`.

The original reports, logs, studies, private source cases, and rejected bytes
remain in the sibling
[`v8-original348-pure-evaluation-20261122`](../v8-original348-pure-evaluation-20261122/README.md)
directory. No original file was rewritten. No large archive was downloaded,
model loaded, inference performed, or optimizer updated by this review.

[`review.py`](review.py) independently verified all **111 retained text
members / 15,057,539 uncompressed bytes** against the original archive's member
inventory. The three omitted members are the original served weights,
transducer, and tokenizer binaries. The tokenizer was already available in the
preserved original campaign and was checked against its exact SHA256.

The script read the complete 64-artifact original population and confirmed that
the 16 selected pure artifacts are byte-identical to those used for evaluation,
with the original **12 train / 3 validation / 1 test** split. It decoded all
**1,957 original token IDs / 29 fragments / 12,475 bytes** directly from the
pinned tokenizer's ByteLevel lexical mapping. This check neither performs a
UTF-8 replacement nor an encode/decode round trip. All **70 filesystem inputs**
were rehashed unchanged after review. The compact result and source blob map
are in [`review.json`](review.json).

## Classification of every case

`Grammar` means the original producer authenticated the emitted bytes and
refused them with `Causal LM v8: unknown generated record or observation in loss`.
The exact original decoder accepts `algorithm `, `region `, `detail `, or
`protocol ` prefixes; none of these eight outputs begins with one. Its source
blob is identical between original producer `9cf091e…` and reviewed `02add9d…`.

`UTF-8 / evidence` means the final fragment fails strict UTF-8 decoding. The
original native response retained that fragment's bytes and token IDs, but its
aggregate payload contained only the earlier fragments or was null. The
producer correctly refused inconsistent aggregate provenance. These raw token
counts are independently reproduced observations, **not retroactively verified
hosted cost**. The hosted result recorded zero verified tokens and one unknown
generation-cost attempt for each of those eight cases.

| Pure family | Split | Failure class | Fragments | Retained original token IDs | All fragment bytes | Original aggregate bytes |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| absolute-distance | validation | UTF-8 / evidence | 3 | 258 | 1,564 | 811 |
| capped-budget | train | Grammar | 1 | 110 | 757 | 757 |
| flag-intersection | test | UTF-8 / evidence | 1 | 59 | 369 | null |
| flag-union | train | Grammar | 1 | 38 | 209 | 209 |
| inventory-shortfall | train | UTF-8 / evidence | 1 | 29 | 196 | null |
| midpoint | train | UTF-8 / evidence | 1 | 44 | 230 | null |
| modular-clock | train | Grammar | 1 | 20 | 140 | 140 |
| overtime-rate | train | Grammar | 4 | 258 | 1,627 | 1,627 |
| parity-adjustment | train | UTF-8 / evidence | 1 | 73 | 491 | null |
| rectangle-perimeter | train | UTF-8 / evidence | 3 | 167 | 1,122 | 543 |
| rectangular-capacity | train | UTF-8 / evidence | 1 | 19 | 92 | null |
| relative-growth | train | UTF-8 / evidence | 5 | 483 | 3,037 | 2,264 |
| squared-distance | validation | Grammar | 1 | 21 | 134 | 134 |
| triangular-series | train | Grammar | 1 | 81 | 541 | 541 |
| unit-conversion | validation | Grammar | 1 | 104 | 673 | 673 |
| weighted-average | train | Grammar | 3 | 193 | 1,293 | 1,293 |

Every case has one prediction attempt, zero accepted generated records, zero
host dispatches, and an observed cancellation after rejection. Every private
source scorer completed without an exception. That is distinct from
`result.sourceValidated`, which is correctly **false** for every failed model
execution. The existing independently executed source audit replays all 16
original source artifacts and checks exact scored-result equality. This review
checks its result digests and original report correspondence; it does not count
another 16 source reexecutions.

All 16 case processes exited zero without timing out. Live execution took
5,703.86–7,103.57 ms against a 300,000 ms limit. Each used 1–5 fragments against
the limit of 8, and the largest fragment had 127 lexical tokens against the
limit of 128. Each stopped on its first failed selection, before the 32-request
or 128-generated-record limits could be exhausted. Increasing those limits
does not address the observed cause.

## Checkpoint and loaded identity

| Identity | Exact SHA256 / digest |
| --- | --- |
| Final original training state, step 348 | `854c37716597b0cb13cece65805ad646ffe837d2ca64bc6de99331bf1bce703a` |
| Exported served model weights | `88c4b86fdfcdc0032a3813b59317fdc0a240dbf434b06e63362b495fccf3940e` |
| Tokenizer file | `40fb9d7d7795b8bd305aeff39ce9963f3f450915b9553f2938e009be9a1fed60` |
| Codec identity | `7f52faca2fe82273a889023defd2f1a6fd6080a21096ec77e97f4798a0a370b2` |
| Training lineage | `8d7a1c8252bb239e4e18dd62902aa9265b2ceb992c71cf48b1a7c2afbc12545e` |
| Serving lineage | `74bb51e8757fc3f6a6119e52a5a2ace1b9a484533350dd81fc0f0b085de14d92` |

The retained checkpoint metadata, export receipt, serving manifest/lineage,
frozen studies, aggregate report, and all 16 inference attestations/selections
bind those identities. The training-state hash and serving-weight hash name
different files and are supposed to differ. This is the original final348
state, not the earlier two-update served bundle or another 348-update campaign.

The prior retained binary audit loaded that exact training checkpoint and
compared every served tensor's key, dtype, and value: **407 tensors / 4,039,640
elements**, with an exactly matching transducer snapshot. Its implementation
and receipt are retained in the sibling directory and were reviewed here.
That is **prior exact-binary evidence**, not a new binary comparison by this
review. The original state and served-weight files are not available in this
review workspace; three existing other-campaign step348 state files were
checked and correctly found to have different hashes. None was substituted.

There is a historical driver distinction worth preserving. The actual `f4bcf1e…`
driver has Git blob `3e2dfd008f0e5c02af3b66a56aefd406270f3bc8` and SHA256
`91bc6c596787bfd2ccc68c775f9215f3f918ad9ff50ffca9b06684ff5e467779`.
Current driver blob `988a21ddacb6e5ad17fe1178126bc9c6efc81589` additionally
records private scorer failures and requires `sourceScoringComplete` for a
measurement-complete outcome. That stricter current gate was not present in the
historical driver. All 16 historical source scorers nevertheless completed, as
shown by their original full reports and subsequent independent source audit.

## Existing native correction and its limits

Native `f6adad8028c050ee5716f96bedd6379d16ec4142`, retained with proof by
`33031866fc7e2d20156a454064aeafd4ef79ccf3`, moves full raw-byte aggregation before
runtime-invalid fragment rejection. Aggregate provenance is retained only for
the expected single text output whose original lexical IDs reproduce its bytes.
Malformed cardinality, wrong track, or token/byte disagreement leaves that
authority absent. The rejected record is neither committed nor source-admitted.

This review checked that all eight new regression fixtures preserve the
original payloads, original emitted IDs, terminal flags, incomplete original
aggregate, and original false provenance flags. It also checked the retained
JUnit populations: **17 native cases and 2 original-producer boundary cases,
zero failures/errors/skips**, plus the exact source hashes named by that proof.
Those tests were not rerun here. The eight fixture regressions deliberately use
the explicit fake runtime and byte-fallback IDs; the real original IDs remain
retained and independently decoded by this review.

The correction closes a demonstrated evidence-accounting defect. It is not a
new learned-model quality measurement. Any future run of the old checkpoint
must use an explicitly identified inference revision compatible with its old
contract; broader current language code must not bypass a lineage mismatch.

## Hardest next bounded diagnosis: first training/serving decoder target

The next useful step is a deterministic, read-only diagnostic on **one
predeclared training case**, `se-support-capped-budget-pure`, chosen before any
new results. Its first expected record begins with `algorithm `; the retained
learned output has no generated-record prefix. The original source target hash
is recorded in `review.json`.

1. **Bind the real target and its physical training rows.** Use the original348
   checkpoint, original admitted artifact, original prepared-corpus manifest,
   and original tokenizer. Verify the source ID, split, first logical target,
   physical part order, payload bytes, cached lexical IDs, loss masks, roles,
   terminal labels, and public `ActionSpec`. Reassemble the first logical
   target from its original physical rows and compare it to the independently
   source-qualified `algorithm …` record. Refuse unavailable or different
   checkpoint/prepared-corpus inputs rather than silently regenerating a new
   training supply.
2. **Compare the actual pre-target states.** On the frozen original pair, use
   `scripts/fit_semantic_v8.py::capture_boundaries(..., max_boundaries=1)` with
   no gradients, then intercept the serving runtime immediately before its
   first `generate` call. Compare raw state, KV history, ordered event IDs and
   tracks, track descriptions, context policy, session metadata, control bytes,
   effort, and allowed output support. Preserve RNG state and use the exact
   original seed 17. No selected output or teacher answer should be committed
   to a serving session. Current unit coverage demonstrates such equality for
   a controlled initialized model, but does not measure this particular trained
   checkpoint and original target.
3. **Separate prediction from reconstruction.** The native grouped objective
   explicitly scores both sampled **prior facets** and encoded-target
   **reconstruction facets**. Capture both first-target teacher-forced loss
   paths and keep them distinct. Report first lexical-token probability/rank,
   permitted record-prefix probabilities, lexical cross-entropy over the
   bounded first target, and the mode/length/terminal losses. Use the exact
   original lexical mask and public supports. Good reconstruction with poor
   prior-conditioned likelihood points toward learned prediction; poor results
   in both paths points toward target realization/learning. A state or target
   mismatch must be resolved before interpreting either as model quality.
4. **Freeze the result before expanding scope.** Keep weights, optimizer,
   transducer, prepared corpus, and all original artifacts unchanged; record
   zero updates and no free-running rollout. Only then decide whether the next
   measured increment is an initialized-model comparison, a larger diagnostic
   population, or more training. None is implied to have happened here.

The original state records `phase_consumed: 52054`. One completed 348-window
census is not evidence that the model learned these programs, and the absent
initialized baseline prevents attributing its quality to training. The other
48 callback/session/teacher profiles remain unmeasured. These are remaining
measurement and learning questions, not reasons to dilute the original failures.

## Reproduce this compact review

```sh
python docs/evidence/v8-original348-readonly-review-20261122/review.py \
  --producer /path/to/tracing-js-self \
  --native /path/to/megatoken \
  --original-admitted /path/to/original/v8-admitted \
  --tokenizer /path/to/original/v8-support-lifecycle/served/tokenizer.json \
  --out /path/to/new-review.json
```

Both repositories must contain the exact reviewed source objects. The command
reads existing small evidence and the original tokenizer/artifacts; it does not
install dependencies, instantiate the model, download archives, or run source
replay. The observed execution took **1.87 seconds**, with no runtime source
change. The output is a review result, not a replacement for the original
evaluation artifact or a new quality gate.
