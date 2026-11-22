# V8 source-bound dataset and causal training export

V8 combines compact algorithm regions, compact local regions, and detailed
records in one shared execution. Its dataset exporter freezes source relations
before splitting, rechecks complete source evidence, and retains every input
candidate in a disposition table. The default export path requires a fresh
independent native-consumer receipt. `allowLocal: true` produces an explicitly
unadmitted diagnostic dataset.

These APIs prepare and verify data. They perform zero optimizer steps and make
no claim about learned execution or standard-format promotion. Existing v6/v7
artifacts, policies, registries, and model interfaces retain their own versions.

## Contracts and source identity

| Data | Version |
| --- | --- |
| Public execution | `semantic-execution/8` |
| Generated records | `semantic-trace/8` |
| Public prediction context | `semantic-context/8` |
| Pure algorithm core | `semantic-algorithm/2` |
| Dataset manifest | `semantic-training-dataset/8` |
| Family registry | `semantic-region-family-registry/1` |
| Split identity | `semantic-region-split-identity/1` |
| Relation policy | `semantic-region-family-components/1` |
| Artifact binding | `semantic-region-dataset-binding/1` |
| Causal serializer | `semantic-causal-lm/4` |

The [v8 family registry](../src/semantic/family-registry-v8.js) builds connected
components using declared family and ancestor IDs, identical source bytes, and
identical source-derived `/2` algorithm cores. All members of one component
receive the same split. An explicit holdout of any member family, exact source,
or normalized core holds out the entire component as `test`. Other components
use the explicit seed and a deterministic 80/10/10 train/validation/test hash
assignment.

Core identities come from
`defineRegionProgram({ source, entry }).program.algorithm`. A detailed-only
source has no normalized-core edge. A refused source definition also has no
normalized-core edge; its exact source, family, and ancestry still participate.
Unrelated detailed programs therefore do not collapse into one component
through a shared null digest. Eligibility never executes the source to infer
its algorithm identity.

The registry contains complete source membership and exact source text. Split
verification rebuilds the source cores and every relation; changing a component
and recomputing its hash does not authorize a different assignment. Bound
artifacts can be exported as a subset while retaining their original complete
registry. A new seed, changed holdout list, different registry, altered lineage,
or mixture of bound and new unbound sources is rejected. A v7 registry is not a
v8 registry and is never silently migrated.

## Candidate input

Each candidate is either a v8 artifact `{ public, contexts, sidecar }`, a result
containing that artifact under `exported`, or a source-refusal record containing
its original `source`, `entry`, `family`, and status. Preserve the fixture
metadata when collecting verification results:

```js
import { verifyRegionTrainingCase } from 'tracing-js-self/semantic/v8';

const fixture = {
  id: 'ordered-map',
  family: 'ordered-map',
  ancestorIds: ['element-transform'],
  source: '"use strict";function run(xs){return xs.map(x=>x*2);}',
  entry: 'run',
  args: [[2, 3, 4]],
  fixture: { calls: [] },
};

const candidate = { ...fixture, ...await verifyRegionTrainingCase(fixture) };
```

For bare source failures, the exporter verifies the failure payload hash and
reads exact source and lineage from `failure.original`. Wrapper labels cannot
replace that original evidence.

For qualified artifacts, the authoritative source, entry, family, and ancestors
come from `sidecar.sourceArtifact.sidecar`. Labels on a wrapper must agree with
that evidence. A failure that contains no exact source metadata still gets a
disposition row, with any available original family preserved. It cannot
receive an invented source membership or training example.

The outer v8 split identity is separate from historical split metadata inside
the original source evidence. Binding v8 data does not rewrite the underlying
source artifact. The binding covers the public execution, actual contexts,
complete source artifact, source identity, component, registry, and split.
`verifyRegionDatasetBinding(artifact, { expectedSplit })` is the common
serializer check. It throws on invalid evidence and returns `valid: true` only
for an exact bound artifact.

## Programmatic export

The [dataset module](../src/semantic/dataset-v8.js) exports:

- `prepareRegionFamilyRegistry(candidates, options)` and
  `resolveRegionFamilyRegistry(members, options)` to freeze the complete input
  source relation before export.
- `regionFamilyMembership(candidate, index)` to extract exact source membership.
- `bindRegionFamilySplit(candidate, membership, registry)` to bind an artifact
  without mutating its original evidence.
- `buildRegionDataset(candidates, options)` to return the registry, manifest,
  complete bound artifacts, causal examples, assignments, and dispositions.
- `exportRegionDatasetJSONL(candidates, { outputDirectory, ...options })` to
  write those outputs to a new directory and return the same data.

```js
const dataset = await buildRegionDataset(candidates, {
  seed: 17,
  families: ['held-out-family'],
  tokenizer,
  tokenizerEvidence,
  eosTokenId,
  maxContextTokens: 32768,
  maxExamplesPerEpisode: 4096,
  nativePolicy,
  nativeConsumer,
});
```

`sourceDigests` and `coreDigests` are additional explicit holdout lists. A seed
is required for a new inventory; a pre-bound inventory can omit it and reuse its
existing seed. Supplied holdout options must exactly match the frozen lists
when reexporting bound artifacts.

The tokenizer must expose a pinned 64-character SHA-256 `identity`, `encode`,
and `decode`. The serializer checks exact byte round trips for each complete
prompt and target and requires an explicit EOS token ID. Optional tokenizer
qualification evidence is retained in the manifest and must identify the same
codec. Production native policy also pins the tokenizer identity and bytes.
There is no byte-to-token estimate and no context truncation.

The causal serializer independently checks original source evidence,
reconstructs every prediction context from the actual public prefix, and emits
loss only for the canonical generated line and one EOS. Routing envelopes,
program definitions, observations, input graphs, and visible state are prompt
context. The artifact's source oracle, future result, private receipts, and
split identity do not enter the prompt.

An oversized context, failed native check, stale binding, malformed target,
or per-episode example-cap violation refuses the entire episode. Previously
constructed examples for that episode are not exported as a partial success.

## Native admission

The admission command runs bounded source workers and the exact pinned native
consumer, retaining every declared case and its disposition:

```sh
PYTHONPATH=/absolute/path/megatoken/src npm run semantic:v8:admit -- \
  --out /absolute/path/new-native-report \
  --population interoperability \
  --megatoken /absolute/path/megatoken \
  --python /absolute/path/venv/bin/python \
  --tokenizer /absolute/path/tokenizer.json
```

`--population gallery` and `--population interactions` select the frozen
broader inventories. Module interactions go through original ESM reference
execution and the evaluated-module adapter. `--prepare-only` explicitly
collects source-qualified artifacts without native admission. A non-preparation
run exits unsuccessfully when any declared case is not admitted.

The [retained base run](../coverage/language-expansion/native-v8-adb74d3/README.md)
admitted all three interoperability fixtures using the pinned independent
consumer. These receipts cover their exact producer, consumer, contract, and
tokenizer revisions. They do not qualify later protocol extensions.

`allowLocal` defaults to `false`. Production export runs the
[v8 evidence gate](../src/semantic/compiler-v8.js), then invokes the supplied
native consumer against the already bound artifact. The
[native validator](../src/semantic/native-v8.js) requires the exact v8 contract
and fixture digests, pinned consumer revision, tokenizer identity and bytes,
source and dataset binding, and passed replay/context/continuation/mask gates.
A historical receipt or `{ admitted: true }` is insufficient.

The consumer receives a transport copy so it cannot change the previously
checked source artifact through the callback argument. The validated receipt
is retained under the exported artifact's `sidecar.nativeAdmission`. Native
admission is rerun for subsequent production exports; a stored receipt does
not replace that check.

The supplied `tools/semantic-v8-native-adapter.mjs` connects the exporter to
these pinned-client helpers. Set `MEGATOKEN_ROOT`, `MEGATOKEN_TOKENIZER_JSON`
and `MEGATOKEN_PYTHON` to the same verified checkout, tokenizer and Python used
for qualification. The adapter defaults to the repository's v8 native policy;
`SEMANTIC_V8_NATIVE_POLICY` selects an explicit alternative policy. It creates
and removes its own temporary subdirectory under `SEMANTIC_NATIVE_TEMP` or the
system temporary directory, keeping the producer checkout clean for live source
verification. Pass it as `--native-module tools/semantic-v8-native-adapter.mjs`.

The module's checkout, installed Python package, tokenizer file, and policy
must identify the same pinned consumer. The generic tokenizer meter accepts
the corresponding consumer/tokenizer pins; a module using it should export
`tokenizer`, `eosTokenId`, and `tokenizerEvidence` for the selected v8 policy.

## JSONL command and outputs

The [CLI](../tools/export-semantic-v8.mjs) accepts nonblank JSONL candidate rows:

```sh
node tools/export-semantic-v8.mjs \
  --input candidates.jsonl \
  --tokenizer-module tools/semantic-v8-tokenizer-adapter.mjs \
  --native-module tools/semantic-v8-native-adapter.mjs \
  --max-context 32768 \
  --seed 17 \
  --out /absolute/path/new-v8-dataset
```

`--holdout-family`, `--holdout-source`, and `--holdout-core` can be repeated.
`--max-examples` changes the complete-episode cap. `--allow-local` explicitly
requests an unadmitted diagnostic dataset. Omitting native admission without
that flag produces export refusals; it does not silently enable local mode.

| File | Contents |
| --- | --- |
| `train.jsonl`, `validation.jsonl`, `test.jsonl` | Exact causal examples and loss masks |
| `train-artifacts.jsonl`, `validation-artifacts.jsonl`, `test-artifacts.jsonl` | Complete bound executions, contexts, source evidence, and retained native receipt when admitted |
| `dispositions.jsonl` | Exactly one row per input candidate, including duplicates and refusals |
| `failures.jsonl` | Source-refused and duplicate disposition rows |
| `refusals.jsonl` | Source-qualified episodes refused by admission or serialization |
| `family-registry.json` | Complete frozen registry, or `null` when no source identity was available |
| `manifest.json` | Split counts, source denominator, pins, scope, and exact output-file hashes |

Malformed nonblank JSONL lines count as candidates and produce `invalid-jsonl`
dispositions with their physical line numbers. Duplicate exact candidate IDs
produce explicit duplicate rows and do not contribute repeated training data.
The manifest reports candidates, exact source variants, declared families,
registered members, components, complete exported episodes, example counts,
and generated tokens separately. A subset export retains the full original
registry while reporting its own input denominator.

The output directory must be new. The manifest is written last as the
completion marker; a directory without it is an incomplete export. File hashes
cover the actual UTF-8 bytes written, including final newlines. The in-memory
builder and CLI currently cap an inventory at 20,000 candidate rows. The CLI
also caps each input row at 256 MiB. These are bounded preparation tools, not
an unbounded streaming corpus service.

## Qualification scope

The [dataset tests](../test/semantic-v8-dataset.test.js) cover genuine source
qualification, `/2` core equivalence, lineage and exact-source relations,
immutable holdouts, null-core separation, detailed/source refusals, local
causal masks, whole-artifact JSONL round trips, exact file hashes, and atomic
episode refusal. Native receipt transport has an explicitly labeled unit
fixture; that fixture is not an independent native-consumer execution and
does not produce a retained admission artifact. Actual native qualification
and model execution require their own pinned run evidence.

The [complete-population source/native qualification](../coverage/language-expansion/native-v8-012c9fe-all/README.md)
retains actual production-tokenizer and native-packing receipts for all 665
expansion cases, 26 interoperability cases and 11 original-gallery cases at
producer `012c9fe` / consumer `39c4036`. Every physical expansion-cost artifact
also agrees byte for byte between complete ordinary and independent streaming
measurements at that pair.

The independently verified
[current production dataset](../coverage/language-expansion/dataset-v8-012c9fe/README.md)
contains **37 episodes and 1,021 complete causal examples** at producer `012c9fe`
and consumer `39c4036`. All 26 interoperability and 11 gallery cases were freshly
source/native-qualified at those exact revisions, then independently readmitted
after the global split registry was frozen. Historical receipts were not reused
for this export. Its 34 components do not cross train, validation or test splits.

| Split | Episodes | Complete examples | Generated tokens, including EOS |
| --- | ---: | ---: | ---: |
| Train | 26 | 646 | 21,555 |
| Validation | 7 | 239 | 8,056 |
| Test | 4 | 136 | 4,239 |
| Total | 37 | 1,021 | 33,850 |

All 1,021 prompts and targets were re-encoded and byte-round-tripped with the
pinned actual tokenizer. Generated tokens and EOS are supervised, while prompt
labels remain `-100`; the 33,850 generated tokens include exactly 1,021 EOS tokens.
The retained verifier also checks every causal context, complete target, native
input and receipt binding, attention mask, and component assignment. The complete
archive was built twice with identical bytes and checked after decompression.
No optimizer steps were performed on this dataset, so this export makes no
learned-success claim. The separately retained
[bounded native model experiment](../coverage/language-expansion/native-v8-fit-39c4036/README.md)
used its own declared one-input training slice and separate evaluation input.

A second [independent export](../coverage/language-expansion/dataset-v8-012c9fe-independent/README.md)
repeated all 37 fresh source/native admissions after split binding. Its entire
dataset, registry, candidates and all 37 native input/receipt pairs are
byte-identical to the first export. Both original execution receipts and
prerequisite qualification hashes remain separate. This is reproducibility
evidence for the same 37 episodes, not a larger training population.

Earlier [34-episode export at `492328f`](../coverage/language-expansion/dataset-v8-492328f/README.md),
[34-episode export at `b66c19b`](../coverage/language-expansion/dataset-v8-b66c19b/README.md),
[33-episode](../coverage/language-expansion/dataset-v8-8d1f7b5/README.md)
and [11-episode](../coverage/language-expansion/dataset-v8-9d76176/README.md)
exports retain their own exact pins and evidence. Their receipts are not reused
to admit the changed dataset or later producer/consumer revisions.
