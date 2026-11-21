# Source, native admission and cost checks, 21 November 2026

These are bounded engineering runs on clean exact producer/consumer revisions,
using the actual pinned tokenizer. They retain the complete declared 30-case
interoperability population. No model generation or optimizer work occurred.
They do not qualify later revisions, complete edition coverage, ordinary model
training, learned execution, deployment or the default cutover.

## Results and boundaries

| Run | Exact code pair | Source | Independent native | Causal cost measurement |
| --- | --- | --- | --- | --- |
| Initial | Producer `13070721a02b8e052112d2b259eb8de8a5400c4f`; consumer `3a0eb90e3e7282e9b3cb2ca0da27454451b50e21` | 30 / 30 | 26 / 30 | Not run |
| Corrected admission | Producer `6888ca122460d3456f275dee4add9b61ba56b6f9`; consumer `c0ac528a5db70de51fb77f38ead88974c0fa386c` | 30 / 30 | 30 / 30 | 28 / 30 measured; two failed |

The initial four refusals are `join-host-join`, `join-retained-callback`,
`callback-owned-join`, and `callback-owned-join-awaited`. Python source recheck,
native replay and tokenizer checks completed, but the producer receipt boundary
still required the older nested source-artifact wrapper. Producer `1227eb8`
accepts direct source evidence only when its exact identity and fresh independent
verification match. It rejects missing, changed or dual source authority. The
second run independently regenerates all candidates; no receipt was relabelled.

The subsequent cost run retained all 30 cases. All 30 have native physical-packing
receipts, but `callback-owned-join` and `callback-owned-join-awaited` failed flat
causal reconstruction with `public row differs from checked replay`. The meter
was synthesizing a live handler-close observation when it replayed a callback
completion, before consuming the recorded host observation. Producer `9a9c270`
uses the normal replay mode while reconstructing each prefix. Eleven focused
controls pass, including both real source cases, exact context/target counts and
forged observation/context refusals. This archive intentionally retains the
original failed measurement; it is not a corrected cost receipt.

The corrected admission has contract digest
`15f330f8bc5038d9bccd65f6b9594e9a97b1e621a4920c042b0db403b3d244b0`, fixture digest
`56f7f36d3b25b3b11a208be3de337e637b9782e6759faea1e1ec107b0a90f0ce`, and
interoperability digest
`d74f0ad0e25093303d8b06e2a274d338fc026cc0134678c11282159a29472e30`.

## Complete evidence

- `initial-complete.tar.gz`: every file from the original 30-source / 26-native
  qualification directory, including population, source candidates, accepted
  receipts, worker outputs and the append-only progress record.
- `corrected-admission-and-costs.tar.gz`: every file from the 30-source / 30-native
  admission directory under `admission/`, and every file from the separate
  28-measured / two-failed cost run under `costs/`.
- The three reports and command logs are also directly readable beside the
  archives. `inventory.json` records exact byte counts and SHA-256 identities.

The archives retain source input and complete outcomes for unsuccessful cases.
Optional preparation attempts that failed before qualification because of the
workspace's absent default temporary directory, Python import path, or an
untracked dependency-directory symlink are environment failures. They did not
admit any cases and are not substituted for either exact-pair run above.

## Reproduce

Use separate clean checkouts of the chosen exact pair. Install the producer with
`npm ci --ignore-scripts --no-audit --no-fund` into an actual ignored directory;
an untracked dependency symlink correctly fails the clean-checkout rule. Use the
producer's hash-locked `tools/native-consumer/requirements.lock` with CPU Torch.
The recorded Node runtime is `24.22.3`. Run outputs and the tokenizer must be
outside both checkouts.

Acquire `tokenizer.json` from `inclusionAI/Ling-3.0-tiny` at revision
`9a98e35fe1c9ee255f78dd64771c7ae15a799481`. Required file SHA-256:
`40fb9d7d7795b8bd305aeff39ce9963f3f450915b9553f2938e009be9a1fed60`;
codec identity:
`7f52faca2fe82273a889023defd2f1a6fd6080a21096ec77e97f4798a0a370b2`.

Copy the producer's `contracts/semantic-native-policy-v8.json` outside its clean
checkout and set only `consumerRevision` to the exact selected consumer commit.
The original contract, fixture, interoperability and tokenizer pins remain
mandatory. In this example, all variables are absolute paths and `work` is an
external output directory:

```sh
cd "$producer"
TMPDIR="$work/tmp" PYTHONPATH="$consumer/src" OMP_NUM_THREADS=1 MKL_NUM_THREADS=1 \
  node tools/qualify-semantic-v8.mjs \
  --population interoperability --inputs all --workers 2 \
  --out "$work/admission" --megatoken "$consumer" --python "$python" \
  --tokenizer "$tokenizer" --native-policy "$work/native-policy.json"

TMPDIR="$work/tmp" PYTHONPATH="$consumer/src" OMP_NUM_THREADS=1 MKL_NUM_THREADS=1 \
  MEGATOKEN_ROOT="$consumer" MEGATOKEN_TOKENIZER_JSON="$tokenizer" \
  MEGATOKEN_PYTHON="$python" SEMANTIC_V8_NATIVE_POLICY="$work/native-policy.json" \
  node tools/measure-semantic-v8.mjs --qualification "$work/admission" \
  --out "$work/costs" --tokenizer-module tools/semantic-v8-tokenizer-adapter.mjs
```

The original initial admission and corrected-pair cost commands exit with a
failure status. Reproducing that status is expected on their recorded revisions.
Every declared case remains in each report, including all refusals.
