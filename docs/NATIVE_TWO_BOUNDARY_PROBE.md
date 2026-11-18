# Actual native computation after a semantic selection

This is a bounded diagnostic of the production v6 producer and native consumer.
It exercises the real saved checkpoint, training window, serving adapter,
tokenizer and decoder. It is separate from a held-out learned-execution result.

The [executed v6 evidence](evidence/native-v6-qualification-20261118/README.md)
contains both original boundary captures, exact hashes, the token audit and
saved-checkpoint identity. Every lexical and structural argmax must agree as
well as the conditional probabilities passing their declared numeric bounds.

## What the checks establish

1. The source-certified asynchronous counter is admitted by the pinned native
   consumer and prepared under its current artifact versions.
2. The first native training and serving calls use the same checkpoint weights.
   Their conditional Gaussian, recurrent state, track addresses, public controls,
   decoder length support, terminal support and lexical alphabet are measured.
3. A capped decoder-only fit uses the actual first trainer boundary and native
   optimizer. The other model owners are frozen. The resulting artifact contains
   every model owner and the real optimizer state. Its diagnostic update count is
   recorded separately from ordinary trainer scheduling; it makes no claim that
   the diagnostic is a normal resumable production training run.
4. The checkpoint is exported and independently reloaded. The actual semantic
   serving adapter must emit the complete target. The production JavaScript
   controller then commits those original bytes. No teacher line is substituted
   into the serving history.
5. A second real prediction is measured after that commitment. Both boundaries
   compare the native Gaussian, recurrent tensors, causal track attachments,
   length and terminal probabilities, and every permitted lexical-token
   probability. Actual native modality masks and output-mode support calls must
   separately show that both choices are singleton text with probability one.

For the decoder comparison, the training readout also scores the actual serving
emission as a diagnostic label. This is a read-only calculation after generation,
with zero optimizer updates. It preserves the original emitted token IDs and
structural choices, making their conditional distributions comparable even when
the second emission differs from the demonstration's next target.

Full probability comparison uses the native float32 epsilon at unit probability
scale (1.1920928955078125e-7), maximum total variation 1e-5 per conditional,
and selected joint log-probability difference 1e-4. Original tensor and full
probability hashes are retained even when these numeric bounds pass. A numeric
pass does not imply bitwise equality.

The Gaussian draws are coupled by seeding the genuine sampler at each boundary.
No draw, Gaussian parameter, state tensor or decoded output is replaced. This
removes unrelated differences in earlier random-number consumption without
claiming that two independently scheduled runtimes have identical global random
number streams.

The first fit comparison retains float32 roundoff from the gradient-enabled
trainer prefix versus the no-grad service. It reports original hashes and numeric
deltas; the first sample and prior must agree within an absolute 1e-6, and the
recurrent tensors within the declared 1e-6 absolute / 1e-5 relative tolerance.
The frozen serving prior must remain bitwise unchanged through decoder fitting
and exact checkpoint reload. An untrained selection may need continuation
fragments; the fitted target must be one complete native record.

Native track addresses and causal attachments must match exactly. Reserved
metadata and transducer control IDs may recur at their original chronological
positions; ordinary retained physical event IDs must be unique. Opaque
dataset event IDs and runtime event IDs are retained separately, with their
chronological correspondence shown. They are never rewritten to create a match.
The per-boundary encoder hooks have different intervals: the serving hook may
include prefix replay, while the training hook begins at the chosen supervised
call. Their whole call lists are retained but are not treated as comparable.
The exact current public control bytes and their actual encoded tensors are
compared, alongside the complete accumulated recurrent state. The separate
first-boundary probe still captures both paths from the start of prefix replay.
The model's declared served-state export must match exactly after independent
training and serving loads. All model weights are also checked for accidental
mutation during the read-only measurements.

## Supervision and future observations

The full native audit retains every episode token with its next-token target,
mask, record boundary and causal context. It checks all generated tokens receive
their intended lexical supervision and observed tokens receive none. Length and
terminal decisions are separately scored, with per-owner gradient norms and exact
gradient fingerprints for each loss family.

A complete native text record and a valid semantic record are distinct checks.
The native terminal choice ends one logical record; the semantic line
**end return** ends the guest invocation. A valid UTF-8 action is not counted as a
valid generated v6 record unless the production parser accepts an eligible
generated kind.

The future-observation check changes a canonical numeric result and its matching
observation line together. On the counter fixture it changes the later read from
7 to 8 while preserving the other observation fields. Every earlier decision
must retain the same target masks, recurrent state, conditional distributions,
log probabilities, losses, full gradient fingerprints and actual emitted bytes.
For non-semantic diagnostic fixtures, a separately labeled byte perturbation
may be used; it is not reported as a semantic value change.

## Run the checks

The paired GitHub workflow installs the locked Node, Python, native dependencies
and production tokenizer, then executes:

- tools/probe-native-conditionals.py: exact first-boundary comparison and full
  token supervision audit;
- tools/fit-native-semantic-record.py: bounded real decoder optimization and
  checkpoint export/reload;
- tools/native_two_boundary_probe.py: the actual first semantic commitment and
  the next native prediction;
- the full token audit again against the fitted checkpoint;
- the current v6 source capability ledger.

The **Paired native computation and supervision** workflow preserves the full
checkpoints and reports as a run artifact. A bounded machine-readable evidence
stream in the run log preserves exact report bytes and their hashes for later
review. The reports themselves identify the producer revision, consumer revision,
checkpoint, tokenizer and public prefix.

The measurements cover one admitted asynchronous prefix, two generated
boundaries, CPU float32 execution, disabled dropout and a bounded diagnostic
model. They do not establish whole-episode correctness, unrestricted JavaScript
support, performance on a larger model, or held-out reasoning quality.
