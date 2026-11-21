# Complete paired V8 admission, costs and ordinary model lifecycle

This archive retains the complete run at clean producer
`7b2a75621233dd86b2c5c13616df479cf443effb` and clean consumer
`31e5688f81cd951384d9b6bcafc1421d43babdff`. The producer includes private callback
arrival ordering, the updated recovery contract and the published ordinary
lifecycle runner. Both checkouts remained at these exact revisions throughout.

## Measured outcomes

| Gate | Actual result |
| --- | --- |
| Regenerated contract and source fixtures | Passed |
| Declared interoperability source cases | 32 |
| Independent source checks | 32 passed |
| Independent native admissions | 32 passed |
| Exact flat token and native packing measurements | 32 passed each |
| Compact-containing / wholly detailed cases | 15 / 17 |
| Compact / detailed generated records | 27 / 1,266 |
| Generated text tokens | 40,869 |
| Detailed generated text tokens | 39,890 (97.60%) |
| Flat observed and repeated context tokens | 2,231,289 |
| Native physical / logical records | 5,143 / 1,391 |
| Ordinary preparation | One independently admitted training source |
| Normal optimizer and fresh-process resume | Global steps 1 then 2 |
| Retained optimizer moment owners | 315 |
| Moment owners advancing from step 1 to step 2 | 311 |
| Changed master-weight tensors | 300 |
| Normal export and real service restoration | Passed |
| Next selection after restoration | All seven compared fields identical |
| Acknowledged semantic model records | 0 |
| Held-out quality / whole-program learned success | Unmeasured |

The ordinary runner freezes the complete 32-source interoperability inventory
and family registry before executing its predeclared training source,
`promise-number-proxy-memory-join`. It uses the actual 157,184-entry production
tokenizer, normal prepared data, CPU optimizer, checkpoint loader, export command
and JSONL service. The first checkpoint is retained independently before resume;
the unchanged one-update configuration and latest-checkpoint pointer prove
exactly two updates. Serving refuses omitted, null and substituted training
lineage identities before legitimate initialization.

The selected output is an incomplete original model emission, not a valid
acknowledged semantic record. Restoration therefore proves initial-state/RNG
continuation after a consumed attempt; it does **not** establish recovery of an
accepted model record or a successful execution. A separate diagnostic addresses
that gate. These engineering outcomes do not qualify all 665 expansion inputs,
the full language edition, production-scale training or a default cutover.

## Complete assets and historical attempts

`run/` contains all **317 original current-pair files / 305,939,844 bytes**,
including source exports and exact inputs, native receipts, token/packing rows,
prepared shards and databases, both optimizer checkpoints, the independent
first-checkpoint copy, exported model tensors, tokenizer bytes, lineage, service
transcripts/profiles and every command log. No current-pair tensor or database
is omitted. The orchestration script is retained alongside its exact commands.

`historical-attempts/` preserves the earlier ordinary runner failure, its corrected
local run, a held-out-source refusal and an actual-model first-record refusal.
The first ordinary attempt mistakenly treated `max_steps` as a global cap,
performed three updates and lost its first live checkpoint. Its original report
is retained as written; its planned two-update field is not an actual measured
count. The corrected attempt used two updates. Historical tensors and databases
are not duplicated here; `omittedHistoricalFiles` lists their original sizes,
hashes and retention scope. Those historical runs are report archives, whereas
the current pair has its complete assets.

The archive contains **390 files / 342,660,952 uncompressed bytes** in 45 parts.
Byte-identical files use tar hard links to reduce duplication; restoration
materializes every original path. The joined gzip is **92,979,863 bytes** with
SHA-256 `82550713b802bcedc5adcd66dc47fbdac1ae3aeb403bc694dcdc5a1fac9cd034`.
Every member and part is verified against `inventory.json` by the restore tool.

From the producer checkout, verify without restoring:

```sh
python3 tools/restore-retained-evidence.py \
  --inventory docs/evidence/semantic-v8-pair-7b2a756-31e5688/inventory.json
```

Add `--out /absolute/path/to/new-directory` to materialize the complete archive.
The output must be new. The verifier checks archive membership, original bytes
and hashes before creating files; it does not extract arbitrary archive paths.

## Reproduction

Install the exact dependency lock from the pinned producer and select Python
with the pinned consumer's `src` on `PYTHONPATH`. Original commands, paths and
durations are in `run/run.json`; the archived orchestration script shows the
full environment. Use new output directories when rerunning.

```sh
node tools/qualify-semantic-v8.mjs --population interoperability --inputs all \
  --workers 2 --out "$ADMISSION" --megatoken "$CONSUMER" \
  --python "$PYTHON" --tokenizer "$TOKENIZER"
MEGATOKEN_ROOT="$CONSUMER" MEGATOKEN_PYTHON="$PYTHON" \
  MEGATOKEN_TOKENIZER_JSON="$TOKENIZER" node tools/measure-semantic-v8.mjs \
  --qualification "$ADMISSION" --out "$COSTS" \
  --tokenizer-module tools/semantic-v8-tokenizer-adapter.mjs
node tools/qualify-ordinary-v8-lifecycle.mjs --out "$ORDINARY" \
  --megatoken "$CONSUMER" --python "$PYTHON" --tokenizer "$TOKENIZER"
```

The native contract digest is
`1be6863d4c4fd4d67698be2d92023db55ea624f6cf8ff9139117d5f48df2cbac`.
The tokenizer SHA-256 is
`40fb9d7d7795b8bd305aeff39ce9963f3f450915b9553f2938e009be9a1fed60`.
Original receipts retain their original identities. A subsequent executable
change needs its own qualification.
