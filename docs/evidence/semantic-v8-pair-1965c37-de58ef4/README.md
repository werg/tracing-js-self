# Current 46-case V8 source/native admission and costs

This evidence bundle records one fresh qualification of the exact producer/consumer pair below. It does not qualify commits made after these revisions.

| Component | Exact revision |
| --- | --- |
| Producer, `werg/tracing-js-self` | `1965c3767cfb4ff1719c90ecf3a0d71ff3142e39` |
| Consumer, `werg/megatoken` | `de58ef4a59cfa0967fa63b937077dd61dec1a4c4` |
| Population | 46 recurring interoperability cases: 44 scripts and 2 module graphs |
| Native policy SHA-256 | `caef9fcf08082a7a4fed1f1e68d35b49ef47ce677a06d6a96206539a1c01ae76` |
| Tokenizer SHA-256 | `40fb9d7d7795b8bd305aeff39ce9963f3f450915b9553f2938e009be9a1fed60` |

The current pair completed **46/46 source qualifications, 46/46 independent native admissions, 46/46 exact tokenizer measurements, and 46/46 native packing measurements**. There were no failures, refusals, or unmeasured cases in this selected population. These checks qualify the listed source fixtures and generated artifacts; they do not measure model learning or promote the production default.

## Exact cost and packing results

| Measurement | Result |
| --- | ---: |
| Compact-containing / wholly detailed cases | 22 / 24 |
| Compact / detailed region records | 34 / 1,703 |
| Generated text tokens | 55,110 |
| Detailed generated text tokens | 53,901 (97.81%) |
| Flat observed and cumulative context tokens | 2,883,888 |
| Peak flat context | 3,597 tokens |
| Native generated / observed tokens | 55,110 / 2,944,197 |
| Native terminal tokens | 0 |
| Native physical / logical records | 6,753 / 1,893 |

Flat-token and physical-packing totals have different scopes and are reported from their respective retained measurements. The reports also retain every case row, artifact digest, native receipt, and per-case packing output.

## Bundle contents and verification

`inventory.json` records the SHA-256 and byte length for every member in the compressed archive, and for each 2 MiB archive part. The compressed archive identity is `2a6f98a6b1e2c6c77708e4404cad8efb26dd429f0dd1f956b7ff5da7a8cf8b23` (13,349,914 bytes); the bundle contains 198 checked files (207,293,411 uncompressed bytes). It includes the selected population inputs, source and admitted exports, all 46 native receipts, per-case cost and packing outputs, full reports, the exact native policy and tokenizer bytes, and the stdout/stderr logs from the source-only, paired-admission, and cost commands.

Verify the complete archive and every part/member without extracting files:

```sh
python3 tools/restore-retained-evidence.py \
  --inventory docs/evidence/semantic-v8-pair-1965c37-de58ef4/inventory.json
```

To verify and restore every archived file to a new directory:

```sh
python3 tools/restore-retained-evidence.py \
  --inventory docs/evidence/semantic-v8-pair-1965c37-de58ef4/inventory.json \
  --out /absolute/path/to/new-directory
```

## Reproduction commands

The run used Node `v24.22.3`, Python `3.12.14`, `tokenizers 0.23.3`, and four source workers. The source-only pass retained the source outcomes before the full paired run. The paired run is authoritative for native admission; the cost run consumed that exact report and its source artifacts.

```sh
PYTHONPATH="$CONSUMER/src" node tools/qualify-semantic-v8.mjs \
  --out "$SOURCE_ONLY" --population interoperability --inputs all --workers 4 --prepare-only

PYTHONPATH="$CONSUMER/src" node tools/qualify-semantic-v8.mjs \
  --out "$ADMISSION" --population interoperability --inputs all --workers 4 \
  --megatoken "$CONSUMER" --python "$PYTHON" --tokenizer "$TOKENIZER" \
  --native-policy "$POLICY"

MEGATOKEN_ROOT="$CONSUMER" MEGATOKEN_PYTHON="$PYTHON" \
  MEGATOKEN_TOKENIZER_JSON="$TOKENIZER" SEMANTIC_V8_NATIVE_POLICY="$POLICY" \
  PYTHONPATH="$CONSUMER/src" node tools/measure-semantic-v8.mjs \
  --qualification "$ADMISSION" --out "$COSTS" \
  --tokenizer-module tools/semantic-v8-tokenizer-adapter.mjs
```

`commands.json` preserves these invocation templates and runtime versions. The exact local output directories, command logs, and reports are also retained in this directory's archive. The source and consumer worktrees used for admission were clean at their stated commits. The tokenizer bytes were copied from the already retained, checksum-verified `semantic-v8-pair-7b2a756-31e5688` bundle; its own 390-file archive inventory was verified before extraction. Its tokenizer hash matches the current native policy.

The full cost report records `model.status: unmeasured`, `nativeServing.status: unmeasured`, and `defaultPromotion: not-qualified`. No model update, model success, serving-latency, or default-promotion claim is attached to this evidence.
