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
reported as zero gradients or a successful diagnosis. Per-objective native
gradient attribution and update norms still require measured integration with
the chosen immutable companion checkout.

The [actual native conditional probe](NATIVE_CONDITIONAL_PROBE.md) now captures
the Gaussian mean and log-scale through both real model paths at one authenticated
physical checkpoint. The [completed measurement at `cb67ed1…` / `2725842…`](evidence/native-conditionals-cb67ed1/README.md)
**failed parity**: the maximum absolute difference across 256 compared
coordinates was 2.4304623. Encoded request controls agree, but metadata, track
ownership and lifecycle history differ. Capture stops before the Gaussian facet
draw and downstream rendering;
serving has already evaluated its singleton text-modality categorical. This
measurement localizes a conditioning blocker. It does not establish downstream
categorical parity, per-objective gradients or successful learned execution.

## Verification and remaining learning gates

Run `python test/test_learning_diagnostics.py` and
`python tools/native-consumer/test_optimization_measurement.py` for the local
accounting, mismatch and retained-evidence regressions. These use synthetic
codec/conditional fixtures and original retained JSON; they are infrastructure
evidence. The completed actual Gaussian comparison has its own exact source,
consumer and checkpoint identities. The
[hosted qualification at `53daa93…` / `9a9dd35…`](evidence/roadmap-hosted-53daa93/README.md)
completed all five source/native corpus jobs and repeated the failed Gaussian
measurement. Downstream categorical comparisons and the L1 ten-restart/L2
held-in convergence experiments remain separate gates requiring their own
pinned assets and, for optimization, a frozen compute budget. Resolve the
measured conditioning differences before interpreting a later run as a
convergence-only experiment.

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
