# Historical v8 dataset export at 9d76176

This package retains the completed gallery export from producer
`9d76176d850ae43fd3bbd5904e8a812f731b3232` and independent consumer
`5a22bc8d7b8bfb0253496642e0ce19837dfaa32e`. All 11 declared episodes were exported
with source-bound native admission. There were no refused or duplicate candidates.

| Split | Episodes | Complete examples | Generated tokens, including EOS |
| --- | ---: | ---: | ---: |
| Train | 7 | 63 | 2,266 |
| Validation | 1 | 2 | 76 |
| Test | 3 | 32 | 1,133 |
| Total | 11 | 97 | 3,475 |

The total includes 97 EOS tokens, one for each complete generated record. Family
components were frozen before export with seed 17. Prompt tokens have loss label
`-100`; generated tokens and EOS retain their exact token IDs as labels. The context
limit was 1,048,576 tokens and the per-episode limit was 4,096 examples. No episode
was truncated. Optimizer steps are zero; this is dataset engineering evidence and
does not establish training or learned success.

## Retained bytes and independent verification

`run.tar.xz` contains the entire original run, including candidates, all split
examples and artifacts, the frozen registry, manifest, dispositions, export log,
capture adapter, and all 11 exact native inputs with their original receipts and
binding index. `manifest.json` and `independent-token-check.json` are unchanged
copies of the original files. `archive-index.json` lists every archive member's
length and SHA-256; `SHA256SUMS` covers the packaged files.

`verification.json` records a subsequent independent integrity check of these
retained bytes. It checked all ten manifest file hashes, every raw native input
against its receipt, the public/source/context and dataset-binding digests, frozen
component splits, complete episode target coverage, causal prompt bytes, masks,
and token accounting. It also re-encoded all 97 prompts and targets and checked
both byte round trips with the exact original codec source and tokenizer:

- Ling `inclusionAI/Ling-3.0-tiny`, revision `9a98e35fe1c9ee255f78dd64771c7ae15a799481`.
- Tokenizer SHA-256 `40fb9d7d7795b8bd305aeff39ce9963f3f450915b9553f2938e009be9a1fed60`.
- Codec source SHA-256 `98de7394ae3c4f47fe86d2767aaa103b8569de446913135a89de914af7182200`, read directly from consumer commit `5a22bc8`.
- Python `3.12.14` and `tokenizers` `0.23.3`.

This verification did **not** rerun native admission. The archive is historical
evidence for the two exact revisions above. It is separate from qualification at
producer `8d1f7b5` and consumer `be3a8d7`; neither those newer revisions nor any
later source changes are qualified by this historical export.

## Unpack and check

From this directory:

```sh
sha256sum -c SHA256SUMS
mkdir -p unpacked
tar -xJf run.tar.xz -C unpacked
python3 verify.py unpacked/v8-dataset-gallery-run \
  --producer-revision 9d76176d850ae43fd3bbd5904e8a812f731b3232 \
  --consumer-revision 5a22bc8d7b8bfb0253496642e0ce19837dfaa32e
```

The last command checks hashes, receipts, causal bytes, masks, and splits without
needing the external tokenizer. To repeat the physical token check, obtain the
pinned tokenizer above and use Python with the recorded `tokenizers` version:

```sh
git -C /path/to/megatoken show \
  5a22bc8d7b8bfb0253496642e0ce19837dfaa32e:src/megatoken/generation/codec.py \
  > unpacked/codec-5a22bc8.py
/path/to/python3.12.14 verify.py unpacked/v8-dataset-gallery-run \
  --producer-revision 9d76176d850ae43fd3bbd5904e8a812f731b3232 \
  --consumer-revision 5a22bc8d7b8bfb0253496642e0ce19837dfaa32e \
  --codec-source unpacked/codec-5a22bc8.py \
  --tokenizer-json /path/to/ling-tokenizer.json
```

The verifier is reusable for another complete admitted v8 run: counts and splits
come from its checked manifest, and the optional revision arguments enforce the
expected execution pins. Both codec and tokenizer hashes are verified before
re-encoding. The archive uses
sorted regular files, USTAR, XZ preset 9, mode `0644`, zero modification times and
UID/GID, and empty owner names. Two independent archive builds produced identical
bytes; every archived member was then read back and checked against its source.

## Reproduce a new export at the historical pins

Prepare separate clean producer and consumer checkouts at the full revisions
above, install the producer dependencies and the hashed native requirements from
`tools/native-consumer/requirements.lock`, and install that exact consumer into the
Python environment with `--no-deps --no-build-isolation`. Keep dependencies and
output outside the tracked source tree, with a real ignored `node_modules` directory.
With the retained candidates unpacked, run:

```sh
producer=/path/to/clean/tracing-js-self-9d76176
export MEGATOKEN_ROOT=/path/to/clean/megatoken-5a22bc8
export MEGATOKEN_PYTHON=/path/to/python3.12.14
export MEGATOKEN_TOKENIZER_JSON=/path/to/ling-tokenizer.json
export SEMANTIC_V8_NATIVE_POLICY="$producer/contracts/semantic-native-policy-v8.json"
node "$producer/tools/export-semantic-v8.mjs" \
  --input "$PWD/unpacked/v8-dataset-gallery-run/candidates.jsonl" \
  --tokenizer-module "$producer/tools/semantic-v8-tokenizer-adapter.mjs" \
  --native-module "$producer/tools/semantic-v8-native-adapter.mjs" \
  --max-context 1048576 --max-examples 4096 --seed 17 \
  --out "$PWD/reproduced-dataset"
```

The output directory must not already exist. This command performs new source and
native admission, retaining its receipts in the exported artifact rows. The
original transport inputs and receipts remain unchanged in the archive.
