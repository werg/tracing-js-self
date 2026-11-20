# Independently admitted v8 dataset at 492328f

This export used exact producer `492328fe387e99487285984b782cd3b402990e2c` and independent
consumer `cb311dba6af44ef241450a87ef530a66aa55c7a3`. It combines the complete
23-case interoperability and
11-case original gallery qualifications at those
same revisions. All **34 episodes** passed fresh source and native
admission after the global split registry was frozen. There were zero source
refusals, export refusals or duplicate candidates.

| Split | Episodes | Complete examples | Generated tokens, including EOS |
| --- | ---: | ---: | ---: |
| Train | 23 | 523 | 17,079 |
| Validation | 7 | 239 | 8,056 |
| Test | 4 | 136 | 4,239 |
| Total | 34 | 898 | 29,374 |

There is one EOS per complete generated record: 898 EOS tokens in total.
The frozen registry has 34 source members and
31 family components assigned with seed 17, with no
component crossing splits. Prompt loss labels are `-100`; generated tokens and
EOS retain their token IDs as labels. The context limit was
1,048,576 tokens and the per-episode limit was 4,096
examples. The verifier confirmed every target in every admitted episode.
Optimizer steps are zero and learned success is untested.

This is evidence for these exact revisions and declared episodes. Earlier
exports and qualification failures remain historical evidence with their original
pins; no historical receipt was relabeled as this run. This export independently
readmits the same complete 34-episode inventory after the producer and consumer
changed. It does not establish unrestricted ECMAScript
coverage, external model comprehension, learned execution, native serving
latency, cache reuse or default promotion.

## Exact retained inputs and independent checks

`run.tar.xz` retains the complete export run: candidates, all source-bound
artifacts, examples and token masks, frozen registry, dispositions, manifest,
export logs, every exact native transport and receipt, their binding index, and
the actual preparation/capture helpers. `inputs.json` binds these prerequisite
qualification reports:

| Population | Episodes | Exact report SHA-256 |
| --- | ---: | --- |
| Interoperability | 23 | `fa6eb6c79e6fa31df657d4f0f7c547f6f714937d262c710a70a01fec578881d6` |
| Gallery | 11 | `fd5fb052dfdd3189d33cab67aeaac499b996f00c9c7f9a553611951ed9f01a06` |

Unchanged copies of both reports, `inputs.json` and the manifest are available
beside the archive. `qualification-input-check.json` independently verifies
their hashes and population identities, all 34 qualified source artifact
hashes and native qualification receipts, and exact equality of each candidate
with its qualification artifact. The reusable checker is retained here as
`verify-qualification-inputs.py`.

`verification.json` records the independent dataset check: every manifest file,
native transport, receipt and source/public/context/dataset-binding digest;
component split isolation; every complete target; causal prompt bytes; EOS,
loss labels, attention masks and token accounting. All **898 prompts and
targets** were re-encoded and byte-round-tripped with the pinned actual tokenizer:

- Tokenizer identity `7f52faca2fe82273a889023defd2f1a6fd6080a21096ec77e97f4798a0a370b2`.
- Tokenizer SHA-256 `40fb9d7d7795b8bd305aeff39ce9963f3f450915b9553f2938e009be9a1fed60`.
- Codec source SHA-256 `98de7394ae3c4f47fe86d2767aaa103b8569de446913135a89de914af7182200`, from the exact
  consumer revision above.
- Python `3.12.14` and `tokenizers`
  `0.23.3`.

The integrity verifier did not rerun native admission; its
`freshNativeExecution: false` describes that subsequent check. The export itself
performed and retains fresh native admission after dataset binding.

The archive uses sorted regular files, USTAR, XZ preset 9, mode `0644`, zero
modification times and UID/GID, and empty owner names. Two independent builds
produced identical archive bytes, and every member was rechecked after
decompression. `archive-index.json` records each member's length and SHA-256;
`SHA256SUMS` covers the packaged files. The packaging helper is also retained.

## Unpack and verify

From this directory:

```sh
sha256sum -c SHA256SUMS
mkdir -p unpacked
tar -xJf run.tar.xz -C unpacked
python3 verify.py unpacked/v8-dataset-final-492328f \
  --producer-revision 492328fe387e99487285984b782cd3b402990e2c \
  --consumer-revision cb311dba6af44ef241450a87ef530a66aa55c7a3
```

To repeat the physical token check with the pinned tokenizer and matching
`tokenizers` version, extract the codec from the exact consumer and add both
arguments:

```sh
git -C /path/to/megatoken show \
  cb311dba6af44ef241450a87ef530a66aa55c7a3:src/megatoken/generation/codec.py \
  > unpacked/codec-cb311db.py
/path/to/python verify.py unpacked/v8-dataset-final-492328f \
  --producer-revision 492328fe387e99487285984b782cd3b402990e2c \
  --consumer-revision cb311dba6af44ef241450a87ef530a66aa55c7a3 \
  --codec-source unpacked/codec-cb311db.py \
  --tokenizer-json /path/to/ling-tokenizer.json
```

The checker requires the original codec and tokenizer hashes before re-encoding.
The qualification-input checker takes the unpacked run, both original complete
qualification directories via repeated `--qualification` arguments, and those
same `--producer-revision` and `--consumer-revision` values. The exact
qualification artifacts are retained in the associated final native evidence.

## Reproduce a fresh export

Use clean producer and consumer checkouts at the full SHAs above with their
locked dependencies and actual pinned tokenizer. Set `TRACING_JS_SELF_ROOT`,
`MEGATOKEN_ROOT`, `MEGATOKEN_PYTHON`, `MEGATOKEN_TOKENIZER_JSON`,
`SEMANTIC_V8_NATIVE_POLICY`, and an existing `TMPDIR`. If the Python environment
has an editable install pointing elsewhere, set `PYTHONPATH` to the frozen
consumer's `src` directory. No source checkout files should be generated by the
run. For a fresh export from the exact retained candidates:

```sh
mkdir reproduced-native-inputs
export V8_DATASET_CAPTURE="$PWD/reproduced-native-inputs"
node "$TRACING_JS_SELF_ROOT/tools/export-semantic-v8.mjs" \
  --input "$PWD/unpacked/v8-dataset-final-492328f/candidates.jsonl" \
  --tokenizer-module "$TRACING_JS_SELF_ROOT/tools/semantic-v8-tokenizer-adapter.mjs" \
  --native-module "$PWD/unpacked/v8-dataset-final-492328f/v8-native-capture.mjs" \
  --max-context 1048576 --max-examples 4096 --seed 17 \
  --out "$PWD/reproduced-dataset"
```

Both output directories must be new. The captured receipts belong to this new
execution; they do not alter the retained archive. The preparation helper can
regenerate candidates from fresh complete interoperability and gallery
qualifications at the same clean producer SHA. Production export freezes the
whole family registry before constructing split-bound artifacts and requesting
fresh native admission. `--allow-local` was not used.
