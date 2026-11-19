# Semantic v7 training data

The v7 data path produces new public execution artifacts, independently prepares
them with the pinned native consumer, then encodes causal language-model
examples from their actual contexts. It does not convert a v6 public trace by
renaming its version. The old private source evidence may be replayed to derive
the new projection, but v6 public bytes, schemas, and admission receipts are not
accepted by v7 validation or export.

## Public and private formats

Each public episode uses `semantic-execution/7`, `semantic-trace/7`, and
`semantic-context/7`, and declares one representation for the whole timeline:

| Representation | Profile | Generated record | Context |
| --- | --- | --- | --- |
| `algorithm` | `algorithm-execution/1` | Existing canonical algorithm `newtrace` record | Published algorithm/input definitions and the available selected state |
| `detailed` | `selected-detailed/1` | `detail ` followed by canonical JSON `{ "kind": ..., "fields": ... }` | Full causal `selected-inference-prefix/3` translated to v7 |

The detailed codec validates `kind` and its `fields` using the semantic witness
rules. Its public line is rebuilt from the selected logical record. Old v6
bytes and logical value-fragment records (`value-open`, `value-part`, and
`value-close`) are refused; native physical token fragmentation is a separate
transport concern. Both representations use v7 continuation and state schemas,
and each generated target has a matching context from immediately before that
target. Detailed causal digests are recomputed over the translated prefix.

For native detailed episodes, every physical event is carried on one native
`assistant` track. The source trace's track and invocation identities remain in
the public semantic payload and are checked there against each context and
event. The adapter adds the exact current v7 context records; it emits no old
lifecycle or context-window scaffolding rows.

An unsupported algorithm profile can still have an exported **v7 detailed**
artifact with its explicit detailed-fallback status. It is not only a private
v6 artifact. The private sidecar uses `semantic-algorithm-evidence/2` and keeps
the original source artifact for independent source and replay checks. This
sidecar is evidence, not model input. Public contexts and training prompts are
derived from the v7 public execution state; private evidence, later
observations, and future records are not included.

## Source families and holdouts

Build the complete immutable `semantic-family-registry/1` before assigning any
examples. Registry members bind exact source, entry point, declared family and
ancestors, plus the source-derived normalized algorithm core when available.
Identical family lineage, source bytes, or normalized core joins members into a
connected component. All variants in one component receive the same seeded
split. The resulting `semantic-split-identity/2` carries the registry and is
rechecked against the exact source before export.

Explicit family, exact-source-digest, and normalized-core-digest holdouts send
the whole matching component to test. Holdout names and digests must already
exist in the complete registry; unknown values fail. Mixed, forged, relabeled,
or incomplete assignments fail instead of being repaired. The deterministic
80/10/10 hash buckets are component assignments, not a promise of balanced
example counts. Inspect `family-registry.json`, split counts, refusals, and
failures before using a corpus.

## Qualification, native admission, and export

First, produce a fresh source-qualified candidate inventory and prepare each
candidate with the independent native v7 consumer. The qualification command
also freezes the complete family registry and retains native refusals:

```sh
node tools/qualify-semantic-v7.mjs \
  --out /path/to/new-qualification \
  --megatoken /path/to/pinned-megatoken-checkout \
  --python /path/to/pinned-python \
  --tokenizer /path/to/pinned-Ling-tokenizer.json \
  --native-policy contracts/semantic-native-policy-v7.json \
  --seed 17 --max-positions 8192 --max-history 1024 \
  --holdout-family FAMILY_TO_HOLD_OUT
```

Repeat `--holdout-family`, `--holdout-source`, or `--holdout-core` here to
freeze additional test components. Specify holdouts before the registry is
bound. Exporting an already-bound candidate reuses its complete registry; any
holdout flags supplied to that export must exactly match the bound lists.

The checked-in policy pins native consumer `032274e9b9314e6c8034d421d54d36d3bdac0e00`,
the full v7 contract, and the exact Ling tokenizer identity and file digest.
They are release inputs, not values to infer from a successful local run. The
qualification output includes `family-registry.json`,
`admitted.jsonl`, `refusals.jsonl`, and `report.json`; every admission has a
fresh `semantic-native-admission/7` receipt bound to the v7 public episode,
all public contexts, exact consumer revision, schema/fixture/contract digests,
and tokenizer identity and file digest. The native gate checks loss masks,
visibility, fragmentation, contexts, and continuation semantics with zero
optimizer steps.

The native prepared corpus and the producer-side causal-LM JSONL export are
separate outputs from the same `admitted.jsonl`. Native preparation performs a
fresh source replay and native admission, then writes the actual native
prepared corpus:

```sh
python scripts/prepare_semantic_v7.py \
  --input /path/to/new-qualification/admitted.jsonl \
  --output /path/to/new-native-prepared \
  --tracer-root /path/to/tracing-js-self \
  --producer-revision EXACT_PRODUCER_COMMIT \
  --consumer-revision 032274e9b9314e6c8034d421d54d36d3bdac0e00 \
  --tokenizer-json /path/to/pinned-Ling-tokenizer.json \
  --max-positions 8192 --max-history 1024
```

Run this from the pinned native consumer checkout and its qualified Python
environment. `--input` may be repeated for additional candidate JSONL files;
the output directory must be new. The native corpus report retains refusals
and split counts, and its preparation manifest binds the exact producer,
consumer, contract, tokenizer, geometry, and complete family registry.

Separately, stream the same admitted candidate packets through the causal-LM
exporter. Its bundled tokenizer adapter uses the same pinned Ling byte codec
and exposes the qualified identity evidence, asynchronous lossless
`encode`/`decode`, and exact EOS token ID. Set the three meter environment
variables for the pinned checkout, tokenizer file, and Python environment.
Use the same split seed as qualification; holdouts are already frozen in each
candidate's family registry:

```sh
MEGATOKEN_ROOT=/path/to/pinned-megatoken-checkout \
MEGATOKEN_TOKENIZER_JSON=/path/to/pinned-Ling-tokenizer.json \
MEGATOKEN_PYTHON=/path/to/pinned-python \
node tools/export-algorithm-training.mjs \
  --input /path/to/new-qualification/admitted.jsonl \
  --tokenizer-module tools/semantic-v7-tokenizer-adapter.mjs \
  --max-context 8192 --seed 17 \
  --out /path/to/new-causal-corpus
```

Set `MEGATOKEN_ROOT`, `MEGATOKEN_TOKENIZER_JSON`, and `MEGATOKEN_PYTHON` to the
pinned native checkout, Ling tokenizer JSON, and qualified Python environment
for the command. The bundled adapter reads the exact v7 native policy and
closes its persistent meter on both success and error.

The exporter rechecks private source evidence and native receipt bindings,
reuses the complete bound family registry, and writes streaming
`train.jsonl`, `validation.jsonl`, `test.jsonl`, `refusals.jsonl`, and
`failures.jsonl`, plus the registry and manifest. Review retained refusals and
failures rather than treating a partial successful stream as complete.
It closes its persistent token meter on both successful export and failure.

## Causal-LM encoding and local diagnostics

Preparation and serving call the same v7 prompt builder and exact tokenizer
segment encoder. Each example serializes only its public pre-target context,
then appends one complete generated target record and the explicit EOS token.
Prompt token labels are `-100`; target and EOS tokens are supervised. The
context and target are tokenized independently and their byte-exact identity is
checked by decoding. Context budgeting is strict: examples that exceed the
specified budget are refused, with no truncation or context substitution.

Algorithm public snapshots may publish their full program and input graph once
and refer to them by digest later. The public context object remains unchanged;
the flat causal prompt resolves those references by carrying the checked full
program and input graph directly on every request. The resolver caches only
objects published by this invocation's current or earlier public contexts,
checks program/source/core and input digests, and rejects unresolved or
backwards-moving prefixes. Training and serving use the same resolver and
serializer. A new invocation starts with a fresh cache, and future contexts or
private source evidence never populate it.

There is no fallback tokenizer. The real Ling tokenizer identity, tokenizer
file digest, consumer qualification, EOS ID, and context budget are recorded in
the manifest. The tokenizer's byte-codec meter qualification alone is not
native admission: production rows still require the candidate's matching
native v7 admission receipt.

For candidate diagnostics only, `--allow-local` explicitly bypasses the
production admission requirement. Such output is marked `allowLocal: true`,
`admitted: false`, and `candidate-local-diagnostic`. It cannot be presented as
a native-prepared production corpus. Every exported manifest records
`optimizerSteps: 0` and `learnedSuccess: null`; data preparation is not a claim
that a model was trained or improved.

The production training gate also requires an explicit
`TrainConfig.semantic_v7_policy` with schema `semantic-training-policy/7` and
the exact `producerRevision`, `consumerRevision`, and `registryDigest` for the
prepared corpus. Training must not infer these pins from episode annotations
or accept a missing policy; each row and the actual prepared split are checked
against the configured policy and frozen registry.
