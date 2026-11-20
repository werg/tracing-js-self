# Independently admitted v8 dataset at 8d1f7b5

This export used exact producer
`8d1f7b5b24d385ce067e9a3d64cce37140a26a56` and independent consumer
`be3a8d789f2ea8c76a77c7f2f14eff717960d64e`. It combines the complete 22-case
interoperability and 11-case gallery qualifications at those same revisions.
All **33 episodes** passed fresh source and native admission during export;
there were zero source refusals, export refusals, or duplicate candidates.

| Split | Episodes | Complete examples | Generated tokens, including EOS |
| --- | ---: | ---: | ---: |
| Train | 23 | 523 | 17,079 |
| Validation | 6 | 199 | 6,785 |
| Test | 4 | 136 | 4,239 |
| Total | 33 | 858 | 28,103 |

The total includes 858 EOS tokens, one per complete generated record. The frozen
registry has 33 source members and 30 family components, assigned with seed 17;
components do not cross splits. Each prompt token has loss label `-100`; generated
tokens and EOS retain their original token IDs as labels. The context limit was
1,048,576 tokens and the per-episode limit was 4,096 examples. Complete episode
coverage was verified. Optimizer steps are zero and learned success is untested.

This evidence describes those two exact revisions and the declared 33 episodes.
The earlier 11-episode export at producer `9d76176` / consumer `5a22bc8` is retained
separately; its historical receipts were not relabeled as this run.

## Exact retained inputs and independent checks

`run.tar.xz` contains the entire completed run: candidates, all examples and token
masks, complete source-bound artifacts, registry, dispositions, manifest, export
log, all 33 exact native transport inputs and receipts, and their binding index.
It also retains the actual `prepare-v8-dataset.mjs` and `v8-native-capture.mjs`
helpers and `inputs.json`, which binds the two prerequisite qualification reports:

| Population | Episodes | Exact report SHA-256 |
| --- | ---: | --- |
| Interoperability | 22 | `d882fcac517b7697b48934dce559920670c3bf1f2f2e04bc6635926e00a7b552` |
| Gallery | 11 | `55dc919f6acc1f729fa8442e2f34b13cee3c450c958b62d28966ee8d693e3f35` |

Unchanged copies of both reports, `inputs.json`, and the dataset manifest are also
available beside the archive. `qualification-input-check.json` records an
independent match of both report hashes and population digests, all 33 qualified
source artifact hashes, and each exact input candidate against its qualification
artifact. Each report declares complete source and native admission at the pins
above.

`verification.json` records the independent dataset check. It verified all ten
manifest file hashes, every captured native input against its receipt, retained
public/source/context and dataset-binding digests, frozen splits, complete target
coverage, causal prompt bytes, masks, and token accounting. All **858 prompts and
targets** were re-encoded and round-tripped using the pinned actual tokenizer:

- Ling `inclusionAI/Ling-3.0-tiny`, revision `9a98e35fe1c9ee255f78dd64771c7ae15a799481`.
- Tokenizer SHA-256 `40fb9d7d7795b8bd305aeff39ce9963f3f450915b9553f2938e009be9a1fed60`.
- Codec source SHA-256 `98de7394ae3c4f47fe86d2767aaa103b8569de446913135a89de914af7182200`, extracted from consumer commit `be3a8d7`.
- Python `3.12.14` and `tokenizers` `0.23.3`.

The verifier did not rerun native admission: its `freshNativeExecution: false`
describes that subsequent integrity check. The original export's freshly executed
source/native receipts are retained verbatim. `archive-index.json` indexes all
archive members by length and SHA-256; `SHA256SUMS` covers the packaged files.

## Unpack and verify

From this directory:

```sh
sha256sum -c SHA256SUMS
mkdir -p unpacked
tar -xJf run.tar.xz -C unpacked
python3 verify.py unpacked/v8-dataset-final-8d1f7b5 \
  --producer-revision 8d1f7b5b24d385ce067e9a3d64cce37140a26a56 \
  --consumer-revision be3a8d789f2ea8c76a77c7f2f14eff717960d64e
```

To repeat the physical token check, use the pinned tokenizer asset and Python
with `tokenizers==0.23.3`:

```sh
git -C /path/to/megatoken show \
  be3a8d789f2ea8c76a77c7f2f14eff717960d64e:src/megatoken/generation/codec.py \
  > unpacked/codec-be3a8d7.py
/path/to/python3.12.14 verify.py unpacked/v8-dataset-final-8d1f7b5 \
  --producer-revision 8d1f7b5b24d385ce067e9a3d64cce37140a26a56 \
  --consumer-revision be3a8d789f2ea8c76a77c7f2f14eff717960d64e \
  --codec-source unpacked/codec-be3a8d7.py \
  --tokenizer-json /path/to/ling-tokenizer.json
```

The reusable verifier checks codec and tokenizer hashes before re-encoding. The
archive uses sorted regular files, USTAR, XZ preset 9, mode `0644`, zero modification
times and UID/GID, and empty owner names. Two independent builds produced identical
archive bytes, and all archived member hashes were checked after decompression.

## Reproduce a new export

Use separate clean checkouts at the full producer and consumer revisions above,
installed producer dependencies, the hashed native requirements from
`tools/native-consumer/requirements.lock`, and that exact consumer installed into
the Python environment with `--no-deps --no-build-isolation`. Keep output outside
the source checkout and use a real ignored `node_modules` directory. Then:

```sh
producer=/path/to/clean/tracing-js-self-8d1f7b5
export TRACING_JS_SELF_ROOT="$producer"
export MEGATOKEN_ROOT=/path/to/clean/megatoken-be3a8d7
export MEGATOKEN_PYTHON=/path/to/python3.12.14
export MEGATOKEN_TOKENIZER_JSON=/path/to/ling-tokenizer.json
export SEMANTIC_V8_NATIVE_POLICY="$producer/contracts/semantic-native-policy-v8.json"
mkdir reproduced-native-inputs
export V8_DATASET_CAPTURE="$PWD/reproduced-native-inputs"
node "$producer/tools/export-semantic-v8.mjs" \
  --input "$PWD/unpacked/v8-dataset-final-8d1f7b5/candidates.jsonl" \
  --tokenizer-module "$producer/tools/semantic-v8-tokenizer-adapter.mjs" \
  --native-module "$PWD/unpacked/v8-dataset-final-8d1f7b5/v8-native-capture.mjs" \
  --max-context 1048576 --max-examples 4096 --seed 17 \
  --out "$PWD/reproduced-dataset"
```

Both reproduction output directories must be new. This performs new source/native
admission and captures exact transports without modifying the retained run. To
regenerate the candidate inventory itself, the retained preparation helper accepts
the clean producer path, a new run directory, and complete interoperability and
gallery qualification directories; it validates their exact report and source
artifact hashes before writing candidates.
