# Exact v5 target and learning diagnosis

The frozen v5 reference arm now has an exact target audit in the existing
`run-optimization-smoke.py` preparation path and a read-only analyzer for retained
learning attempts. Neither tool invents a successful model run or reconstructs
missing logits from aggregate loss.

## Existing-run diagnosis

```sh
python tools/diagnose-learning-run.py \
  --run docs/receipts/learning-one-input-2026-11-18 \
  --out /path/to/new-diagnosis.json
```

[The checked-in derivative](evidence/learning-diagnostics-2026-11-18.json) binds
its exact original inputs by SHA-256. Both retained one-input arms fail at native
action rendering, before semantic execution. The original first emitted token
IDs and byte payloads are preserved. A null semantic inconsistency is not counted
as a semantic pass. The result retains the original optimizer exposure, first
and last per-objective loss, and aggregate gradient-domain measurements, with
zero new optimizer steps or model executions. Original receipts and their
producer/consumer identities are unchanged.

These artifacts do not contain training/serving conditional probes, per-head
objective gradients, or the original exact prepared text/token files. Those
measurements remain **unmeasured**, and the analyzer does not attribute the
failure uniquely to optimization or conditioning.

## Exact targets in the next native diagnostic

After normal fresh source/native preparation, the optimization runner writes
`target-audit.json` for the shortest prepared episode, using that run's actual
native `encode_record` and codec. Its report binds the audit checksum. Every
physical record includes:

- original text, UTF-8 hex and digest, logical record and fragment boundaries;
- actual likelihood token IDs, exact byte segments and lexical loss masks;
- observed/generated masks and transcript-versus-likelihood counts;
- byte categories for record kinds, separators, JSON keys and punctuation,
  source names, reference IDs, literal values and terminal record fields.

Tokens that cross semantic categories stay `mixed`, with exact byte counts;
they are not assigned to whichever category looks most useful. Logical fragments
are joined solely for accounting, without retokenizing or changing the training
rows. Observed tokens carrying loss, generated v5 tokens missing loss, tokenizer
identity drift and inexact decoding all fail before optimization.

Native structure/terminal **action-head masks** are separate from the lexical
bytes spelling an `end` record. `encode_record` does not expose those heads, so
this audit leaves their masks null until an actual native action probe is
captured. The public-record inventory is not a claim that every preceding record
is visible: use [the native context meter](NATIVE_CONTEXT_COSTS.md) for recurrent
visibility, reconstruction and event/facet costs.

## One native episode, token by token

`capture_native_supervision_audit` in `tools/native_supervision_audit.py` runs
the already prepared one-episode batch through the companion's real native
forward path. Call it with the restored model, that episode's prepared native
batch, actual codec, training config, and the run's transducer trainer. It
does not change model weights or `.grad` slots, take an optimizer step, invent
targets, or patch the loss weights. It uses the supplied batch's denominators
and config weights, including the trainer's existing zero weight for router
balance. For one window the global denominators equal that window's actual
counts; pass the actual `window_scale` if the audit is embedded in an
accumulated training transaction.

```python
from native_supervision_audit import capture_native_supervision_audit

audit = capture_native_supervision_audit(
    model, prepared_batch,
    codec=codec,
    config=train_config,
    device=device,
    model_version=current_step,
    transducer=transducer_trainer,
    checkpoint_sha256=checkpoint_sha256,
    decoder_seed=17,
    record_validator=optional_native_record_validator,
)
```

For each generated decision, the report binds actual target token IDs and
lexical masks to the physical record and its fragment boundary. It records the
pre-decision recurrent state fingerprint, earlier physical event IDs, reserved
native control IDs, separate structure and terminal targets, actual loss sums
and counts, and gradients to explicitly enumerated lexical, structure,
terminal, encoder, context, control and shared parameter owners. Each target
must have nonzero gradients at its direct lexical, structure and terminal
heads; the reconstruction target must reach the native input encoder. A
generated record whose policy mask is only partly scored, an observed record
with any lexical loss, a missing structural/terminal gradient, or a state that
contains a current or later physical record fails the audit.

The report retains exact token IDs and Boolean supervision masks for every
physical text record. For each target decision it also records hashes of the
actual modality logits and Gaussian mean/scale used by the native decoder, the
selected action log probability, and per-owner exact gradient tensor hashes
alongside norms. These hashes keep large distributions and gradient tensors
bounded in the artifact while allowing exact same-run canary comparisons.

The helper also runs the native decoder from the same pre-target state using
the declared decoder seed. It preserves the decoder's emitted token IDs and
bytes, requires an exact token-to-byte round trip, and reports the decoder's
own validity and completeness flags separately from the supervision-audit
status. The native tape's valid flag, terminal boundary, complete byte-exact
record status, and v6 parser status are separate fields. The production v6
parser is run on each actual native emission in the CLI; parse validity is not
semantic correctness. A random emission can be invalid or incomplete while
the mask, context, loss, and gradient checks still pass.
For any episode on the `semantic_execution` stream, the emission uses native
`encoded_text` continuation, matching `SelectedSemanticInference` regardless
of whether the input provenance is `teacher_conditioned` or `recorded`. The
provenance and exact mode from the produced tape are both reported. Other
streams keep the diagnostic's default sampled continuation.

When a later observed text record exists in the same episode, the helper
changes one byte of that later row in a counterfactual copy, replays the same
native forward at the same random state, then compares every earlier target's
recurrent state, IDs, masks, structure and terminal labels, losses, gradients,
full earlier modality/Gaussian prior fingerprints, selected action log
probabilities, exact per-owner gradient values, and actual decoder output. This
numerical canary complements the hard check that no current or future physical
record ID is present in the pre-target state. If there is no later observed
text row, the canary is explicitly `unmeasured` and the result is incomplete.

The local byte-model regression exercises masks, boundaries, gradients, the
no-future canary and the actual decoder. It is infrastructure evidence only;
the native result must come from the real selected episode and restored
checkpoint:

```sh
.venv/bin/python test/test_native_supervision_audit.py
```

## Same-checkpoint conditionals

`compare_conditioning_probes` in `tools/learning_diagnostics.py` accepts the two
original `semantic-conditioning-probe/1` records produced by a training and a
serving probe. Each must declare `path` (`training` or `serving`),
`dropoutDisabled: true`, exact `inputTokenIds`, and an `identity` containing
SHA-256 values for `checkpointSha256`, `tokenizerIdentity`,
`publicPrefixSha256` and `targetSha256`. Its `points` contain actual `head`,
`position`, `target`, `scored`, `category` and the complete finite `logits`
vector. Target IDs, masks, positions, source prefix, checkpoint and tokenization
must agree before logits are compared. Empty or duplicate probes fail.

```sh
python tools/diagnose-learning-run.py --run /path/to/run \
  --training-probe /path/to/original-training-probe.json \
  --serving-probe /path/to/original-serving-probe.json \
  --atol 0.000001 --rtol 0.00001 --out /path/to/new-diagnosis.json
```

Numerical divergence records the first differing head/position/token and exits
unsuccessfully. Missing probes return `unmeasured`, never `passed`. The report
computes cross-entropy and top-1/5/10 next-token accuracy by head and target
category, with unscored positions excluded from denominators. A passing probe is
limited to its retained positions and prefixes; it does not establish full
training/serving equivalence.

The `objective_gradient_norms(model, losses, owners)` hook measures each actual
scalar objective against explicitly enumerated native parameter owners using
`torch.autograd.grad`. It retains the graph, does not overwrite `.grad`, and
never steps an optimizer. Lexical, structural/terminal, shared embedding and
context encoder ownership must come from the companion model, not substring
heuristics. Its graph and PyTorch runtime are required; absent hooks are not
reported as zero gradients or a successful diagnosis. Update norms and real
native conditional capture still require integration with the chosen immutable
companion checkout.

## Verification and remaining learning gates

Run `python test/test_learning_diagnostics.py` and
`python tools/native-consumer/test_optimization_measurement.py` for the local
accounting, mismatch and retained-evidence regressions. These use synthetic
codec/conditional fixtures and original retained JSON; they are infrastructure
evidence. Current-source native qualification, an actual paired conditional
capture, and the L1 ten-restart/L2 held-in convergence experiments remain separate
gates requiring their pinned assets and a frozen compute budget.

## Reproduced native input mismatch before neural execution

The [actual native boundary receipt](evidence/native-input-parity-2026-11-18.json)
uses the preserved companion revision
`6e27a7c6529aa0778c5ea818432461db7cd05ea7`, which was also that repository's
current main when checked. Its [original locally verified candidate](evidence/native-input-parity-2026-11-18.candidate.json)
is retained and bound by SHA-256. This candidate is diagnostic material, not a
native-admitted training sample.

The executable probe calls the real companion functions
`megatoken.data.semantic_harness_v5.adapt_selected_harness_v5`,
`megatoken.controls.resolve_event_control`, and
`megatoken.semantic_model_adapter.SelectedSemanticInference.select`. The
serving adapter uses its real track registry. A capture endpoint intercepts
its actual `observe_text` and `generate` arguments and stops **before** any
neural generation. It never injects a successful selection. The source and
initial prefix are freshly rechecked through this repository's independent
source/replay/identity checks before crossing the boundary.

For one first direct invocation of `run(a,b){return a&b;}` with inputs `6,3`,
three concrete input differences were measured:

| Input to the native runtime | Training data path | Serving adapter path |
| --- | --- | --- |
| Semantic instruction bytes | 0 bytes | 553 bytes |
| Initial program and invocation observations | Insertion-order JSON | Sorted-key JSON; equal JSON values, different bytes for both records |
| Observations before the first prediction | Program and invocation | Program, invocation, and an extra retained-activation selected-state bootstrap |

The receipt also retains the exact training track declarations and serving
track description; their recurrent effect remains unmeasured. These input
mismatches are concrete defects to investigate before interpreting loss curves.
They do not establish their numerical effect on logits, nor that they are the
only cause of the failed learning attempts.

```sh
python tools/native_input_parity.py \
  --consumer-root /path/to/immutable/megatoken \
  --episode /path/to/current-source-certified-episode.json \
  --max-capacity 1024 --max-tokens 128 \
  --out /path/to/new-native-input-receipt.json
```

The command requires an unchanged companion checkout and a new output path.
It exits 1 on a measured mismatch, retaining the failed receipt. Original
candidate bytes are never rewritten. Historical candidates whose verifier
identity has changed must be regenerated and freshly certified for a new run;
the retained original receipt is not reclassified. The probe deliberately does
not load a tokenizer, perform physical chunking, assert recurrent visibility,
load a checkpoint, compute logits, or step an optimizer. Each missing layer is
listed explicitly in its result. The current bounded probe covers the first
direct invocation only, not resumed or callback executions.

Run the retained-evidence tests without the companion, or include the exact
pinned companion to execute the real native boundary regression:

```sh
python test/test_native_input_parity.py
MEGATOKEN_REPOSITORY=/path/to/pinned/megatoken python test/test_native_input_parity.py
```

A corrected conditioning experiment must have its own native artifact identity
and regenerated data/model artifacts under the companion repository's contract
rules. Preserve the original pin and failed receipts as the fixed control.
Control text, observation serialization, retained-state publication, physical
fragment instructions, track metadata and categorical action support must all
be checked; fixing two byte differences alone is not a conditional-parity pass.
