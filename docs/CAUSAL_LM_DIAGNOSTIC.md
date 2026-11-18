# Conventional pretrained causal-LM diagnostic bridge

`src/training/causal-lm-bridge.js` adds a separate experimental conventional
causal-LM arm over the unchanged `semantic-trace/5` records. It shares the
existing source admission, public replay, selected controller, effect broker and
complete-outcome scorer. It does not claim native Megatoken admission or a
successful learning experiment.

## Training examples

`buildCausalLmExamples` freshly rechecks source, journal, replay, effects and
independent reference evidence with `recheckEffectfulAdmission`. Local
certification is sufficient for this separate diagnostic; it does not invent a
native admission. Only frozen training rows are exported. Their exact source
family, component ID, split policy and candidate identity remain metadata
outside the model prompt. A family-hash component is identified by its actual
policy, not relabeled as a conservative clone component.

For each generated record, the bridge replays only the public timeline before
that record and calls the production driver's `prefix` method. The resulting
context contains source, invocation inputs, current public selected state,
previous records and lawful observations. Private sidecars and future
observations cannot enter this replay. The same prompt builder is used at
serving time. The expected next record is retained only as the training target.

A caller supplies an actual lossless tokenizer and explicit end-of-record token.
The bridge encodes the public prefix and target as separate segments, then
concatenates their original IDs. This segmentation is part of the versioned
adapter contract: serving uses exactly the prefix segment IDs; whole-string BPE
retokenization must not move the loss boundary. Every prompt/prior-observation
position has label `-100`; every new generated target token and its explicit
terminator carries loss. Exact tokenizer roundtrips and token budgets are
checked. Context overflow refuses the row; nothing is silently truncated.

```sh
node tools/export-causal-lm-data.mjs \
  --episode /path/to/current-source-certified-training-episode.json \
  --tokenizer-module /path/to/frozen-tokenizer-adapter.mjs \
  --max-context 32768 --out /path/to/new-data-directory
```

The tokenizer module exports `tokenizer` with a SHA-256 `identity`, synchronous
`encode(text)` returning IDs, lossless `decode(ids)` returning UTF-8 bytes, and
`eosTokenId`. The output contains `examples.jsonl` and a checksum manifest. Its
flat prefix-token cost is separate from recurrent Megatoken event/facet costs.
The exporter does not run an optimizer or select a checkpoint.

## Actual model inference

`createCausalLmSelector` receives a runtime exposing:

```js
const runtime = {
  async initialize({checkpointIdentity, tokenizerIdentity, seed, arm}) {
    // Load the pinned actual model and attest the loaded identities and seed.
    return {checkpointIdentity, tokenizerIdentity, seed};
  },
  async generate({inputIds, maxNewTokens, eosTokenId, doSample,
                  arm, grammar, grammarFormat, grammarDigest}) {
    // Return original greedy generated IDs, including the explicit terminator.
    // A syntax-only run must actually apply the supplied GBNF constraint.
    return {tokenIds, stopReason: 'eos', appliedGrammarDigest};
  },
  async close() { /* release the actual model process */ }
};
```

The comments describe adapter obligations; this snippet is an interface, not a
model implementation or successful-run receipt. The adapter must verify hashes
against the weights/tokenizer it loads. The generation request contains only the
public prefix IDs and decoding controls: no answer, teacher next choice,
reference result, fixture schedule or private admission data.

Every original token sequence and byte payload is retained. Missing termination,
invalid UTF-8, context overflow or a changed loaded identity fails explicitly.
The bridge does not trim whitespace, repair JSON, fill fields, retry against the
teacher or replace a wrong result. The original record reaches
`SelectedModelDriver`, which applies the same semantic checker and effect
boundaries. These selections use a distinct conventional-model authority and do
not masquerade as native committed Megatoken action tapes.

For a complete case evaluation, an adapter module exports the tokenizer,
terminator, runtime, and `modelDeclaration` with the actual base `repository`,
immutable 40-character `revision`, `license`, and exact `checkpointIdentity`.
Choose an available appropriately licensed checkpoint and freeze these fields
before training; no checkpoint is selected implicitly by this implementation.

```sh
node tools/run-causal-lm-evaluation.mjs \
  --episode /path/to/current-source-certified-episode.json \
  --adapter /path/to/frozen-model-adapter.mjs \
  --checkpoint CHECKPOINT_SHA256 --origin fixed-weights \
  --arm unconstrained --max-context 32768 --max-new-tokens 512 \
  --timeout-ms 120000 --seed 17 --out /path/to/new-base-result.json
```

Use `--origin trained` for the separately frozen trained weights. The evaluator
compares the complete outcome/graph/effects/cleanup against the independent
expectation outside model generation, requires zero rejections and hard-gate
violations, and exits unsuccessfully on failure. Raw emissions remain in the
report. It refuses an existing output path before loading a model. Training
membership, validation-only checkpoint selection, optimizer exposure, budgets,
seeds and exact weights still need their own frozen experiment declaration.

## Syntax-only control

`--arm syntax-only` supplies a GBNF grammar restricting generated record kinds,
framing and JSON syntax. It includes every generated v5 semantic kind and
arbitrary JSON values. It contains no source-specific next operation, value,
branch or effect payload. Semantic schema details and canonical bytes remain the
unchanged controller's responsibility, so grammar compatibility is not a
semantic pass. The runtime must acknowledge the exact applied grammar digest;
otherwise the constrained arm is refused. Unconstrained and syntax-only results
are labeled separately and never pooled.

## Evidence and remaining gates

`node --test test/training-causal-lm-bridge.test.js` covers fresh certified
examples, exact masks and splits, future-observation canaries, all-record
training/serving prompt parity under controlled transport, unchanged bad bytes,
termination and identity drift, and complete-outcome failure scoring. These are
infrastructure tests with an explicitly synthetic byte tokenizer and controlled
runtime. They establish no pretrained or learned execution success.

A pretrained runtime/weights/tokenizer is not present in the implementation
workspace, so no actual checkpoint qualification, fine-tuning or base-versus-
trained learning comparison was performed. The native frozen v5 arm and its
negative results remain unchanged. Actual model execution and the L1/L2
convergence gates require available pinned assets and a separately declared
compute budget; the bridge is ready for that controlled experiment.
