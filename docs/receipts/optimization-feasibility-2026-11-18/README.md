# Preliminary actual optimizer feasibility evidence

This receipt is a two-example, two-update CPU diagnostic, using a newly
initialized tiny model and the exact pinned production tokenizer. It establishes
that the actual native optimizer, masks, checkpoints, and served loader run in
this environment. It does not pass the plan's complete execution smoke.

- Both examples were independently source and native admitted and remained in
  the training split. Preparation rechecked those receipts.
- All 2,654 observed tokens had zero supervised positions. All 606 generated
  tokens had supervised positions in the prepared corpus.
- The two actual training windows supervised 25 generated lexical tokens;
  native metrics separately retain reconstruction and history ingestion costs.
- The optimizer changed 307 parameter tensors. 311 parameter owners have
  actual update moments. Encoder, shared, and model gradient norms were nonzero.
- Reloaded checkpoint tensors and exported/reloaded served tensors matched
  exactly. Base and trained served identities differ.
- The base and trained models both produced an invalid first action. Original
  emitted token IDs and payload bytes remain in their raw `result.json` files.
  No teacher selection was injected.
- Both failed rollouts reported zero unauthorized effects, future-observation
  leaks, native fallback, false admissions, replay effects, and leaked resources.

The source-window exposure receipt shows that these short updates visited only
one of the two corpus members. This is a pipeline feasibility measurement, not
evidence of memorization or generalization. `optimizationSmokePassed` is false.

The runner was under development during this first execution. `index.json`
states that provenance precisely and lists the subsequent reporting/assertion
additions; no claim is made that the recorded parent commit already contained
the runner. The final runner is committed separately and records its source
file digests for future runs.

`index.json` binds every retained evidence file by SHA-256. Large binary
checkpoints are not copied into Git; their hashes and original local paths are
retained in the report, and the deterministic capped experiment is rerunnable.
Absolute paths inside raw receipts describe the original sandbox execution.
