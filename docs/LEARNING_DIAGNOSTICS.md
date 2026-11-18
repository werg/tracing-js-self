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
