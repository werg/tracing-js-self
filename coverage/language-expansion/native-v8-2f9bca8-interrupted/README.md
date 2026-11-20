# Interrupted full-population native qualification

This is a failed diagnostic, retained before its fixes and replacement run.
It does not qualify the later consumer or fill in the unexecuted population.

- Producer: `2f9bca8c38b0773daccf4f0e97ba8bb2ca7d0bac`.
- Consumer: `5a22bc8d7b8bfb0253496642e0ce19837dfaa32e`.
- Frozen population: all 665 family, script interaction, real-source and module
  cases, with all inputs and four independent workers.
- Recorded attempts: 153. Sixteen passed actual native admission; 137 failed.
- Remaining 512 cases: explicitly untested in this interrupted run.

The recorded native failures comprised 76 positional-let schema rejections,
eight initial parameter-cell disagreements, six reference-comparison/coercion
rejections, four detailed lazy-witness rejections, and one signed-zero traversal
rejection. Another 42 attempts failed the live source gate while an unrelated
worktree was accidentally nested inside the otherwise immutable producer
checkout. That nested checkout was moved out; these infrastructure failures
are preserved and are not relabeled as semantic failures or successful retries.

The run was interrupted after the independent consumer exposed these gaps.
Their fixes and fresh measurements have their own revisions and receipts.
Neither a source-only pass nor a successful replay from a later consumer changes
these recorded outcomes.

`report.json` records the complete failed-case inventory and the untested
denominator. `archive.json` binds the deterministic archive and every member's
exact bytes. The archive contains the full frozen input inventory, recorded
attempts, retained source/admitted artifacts, native receipts, policy and logs.
Any staged source artifact without a completed attempt remains untested.

For each of the 16 admitted rows, `native-input-bindings.json` links the exact
native CLI input to its retained source and receipt. The compact JSON input was
reconstructed with the same Node serialization and verified against the actual
`sourceVerification.artifactSha256` before retention; the pretty-printed source
artifact is retained separately. No model response, learned execution or serving
latency was measured.
