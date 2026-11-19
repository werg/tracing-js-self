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
  --native-policy /path/to/semantic-native-policy-v7.json \
  --seed 17 --max-positions 8192 --max-history 1024
```

The policy file and its consumer revision must match the exact v7 contract and
tokenizer pins. They are release inputs, not values to infer from a successful
local run. The qualification output includes `family-registry.json`,
`admitted.jsonl`, `refusals.jsonl`, and `report.json`; every admission has a
fresh `semantic-native-admission/7` receipt bound to the v7 public episode,
all public contexts, exact consumer revision, schema/fixture/contract digests,
and tokenizer identity and file digest. The native gate checks loss masks,
visibility, fragmentation, contexts, and continuation semantics with zero
optimizer steps.

Then stream admitted candidate packets through the causal-LM exporter. Supply a
tokenizer adapter backed by the same pinned Ling byte codec and expose its
qualified identity evidence, asynchronous lossless `encode`/`decode`, and exact
EOS token ID:

```sh
node tools/export-algorithm-training.mjs \
  --input /path/to/new-qualification/admitted.jsonl \
  --tokenizer-module /path/to/pinned-Ling-tokenizer-adapter.mjs \
  --max-context 8192 --seed 17 \
  --holdout-family FAMILY_TO_HOLD_OUT \
  --out /path/to/new-causal-corpus
```

Repeat `--holdout-family`, `--holdout-source`, or `--holdout-core` for additional
explicit test holdouts. Omit them only when no additional holdout was declared;
the seed-based assignment still groups related sources. The exporter
rechecks private source evidence and native receipt bindings, rebuilds the
family registry from the complete input inventory, and writes streaming
`train.jsonl`, `validation.jsonl`, `test.jsonl`, `refusals.jsonl`, and
`failures.jsonl`, plus the registry and manifest. Review retained refusals and
failures rather than treating a partial successful stream as complete.

## Causal-LM encoding and local diagnostics

Preparation and serving call the same v7 prompt builder and exact tokenizer
segment encoder. Each example serializes only its public pre-target context,
then appends one complete generated target record and the explicit EOS token.
Prompt token labels are `-100`; target and EOS tokens are supervised. The
context and target are tokenized independently and their byte-exact identity is
checked by decoding. Context budgeting is strict: examples that exceed the
specified budget are refused, with no truncation or context substitution.

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
