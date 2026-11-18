# Optimization and exploratory learning handover

## Completed and measured

The repository now has a real bounded native optimization runner, an exact native
window forecast, source-exposure accounting, a frozen diagnostic holdout builder,
an actual-model selected-driver evaluator, and a read-only retrospective audit.
These tools preserve original emitted bytes and failures. They do not inject
teacher selections or claim training from prepared examples the optimizer never
visited.

The final CPU diagnostic consumed all **32 admitted examples from 29 families**,
all **9,379 supervised lexical targets**, in **49 optimizer updates**. Native
optimizer wall time was **636.95 seconds**, below the 900-second cap. The actual
checkpoint cursor, source counts, and scored-token denominator matched the
resolved pre-run native window plan. The 40,690 observed corpus tokens had zero
scored positions. There were 311 changed parameter tensors and 315 updated
optimizer owners, with finite parameters and nonzero model/encoder/shared
gradient domains. Actual checkpoint and served exports reloaded exactly.

The task-execution acceptance condition did **not** pass. The initialized base
and trained checkpoint each completed **0 of 4 held-in tasks**. A separately
frozen exploratory cohort of eight disjoint test components then produced
**0 of 8 complete tasks for both models**. The observed family-weighted change
was zero. Every attempt failed at the first candidate action. Zero reported
integrity and cleanup counters establish the measured refusal paths, not learned
effect, callback, error-handling, or generalization success.

The native P1 stage's normal budget was not completed; its metrics truthfully
report `termination: step_limit`. The completed epoch refers only to this small
prepared corpus. This was one seed, a newly initialized tiny model, and a bounded
CPU experiment, not production SE/SC training.

## Evidence to preserve

The final full-pass experiment, the preceding 32-/95-update attempts and the
held-out diagnostic use immutable producer
`c4296c271eec32c2f2ab4cd34c30fd8b61e6ba39`. The initial two-step feasibility
attempt instead uses producer `3a2178252a370c3d91c85d42751b2a4f82376bd4`.
All use native consumer `277edd4a2983e81f5e2a71b34a7ce29348e4e7a0`.
The complete archive records those per-attempt identities. Later consumer
repairs require new receipts for another experiment; old evidence is not
relabelled.

| Evidence | Repository receipt directory |
| --- | --- |
| Initial two-example feasibility attempt | `docs/receipts/optimization-feasibility-2026-11-18` |
| 32-update attempt, only three sources actually sampled | `docs/receipts/optimization-32-example-2026-11-18` |
| 95-update partial epoch, 16 sources actually sampled | `docs/receipts/optimization-95-update-partial-epoch-2026-11-18` |
| Final 49-update complete prepared epoch | `docs/receipts/optimization-full-epoch-2026-11-18` |
| Eight-family exploratory held-out measurement and audit | `docs/receipts/exploratory-heldout-2026-11-18` |

The original 32-example preparation that was terminated with exit 137 has a
separate external-termination record. It made no optimizer updates and must not
be counted as a training run. Its likely memory-pressure explanation remains an
inference; no kernel diagnostic was available to prove the cause.

Full original checkpoints, served bundles, prepared native files, and logs remain
under the original workspace's `release-evidence/optimization-full-epoch` and
the preceding attempt directories. The complete binary archive is now verified and durably delivered, including
the initial feasibility, interrupted preparation, both retries, final full pass,
held-out rollouts and retrospective audit. Its filename is
`tracing-js-self-optimization-evidence-2026-11-18.tar.gz`, size **678,766,391 bytes**,
SHA-256 `662d686473ca07cd81af5ae5e742eba484dfbc502b0a46ad225b932c73f6bce1`.
Its 425 archived files include the actual checkpoint/served/native data bytes.
The [ordered parts manifest](evidence/durable-archive-parts-2026-11-18.json) and
[reconstruction guide](ARCHIVE_PARTS.md) describe the two delivery parts. Compact raw evaluation outputs,
requests, private expectations, profiles, and source/native admission receipts
are committed. Absolute original paths in these receipts describe provenance;
artifact archives must retain their relative directory layout for relocation.

## Review hardening and its timing

The final diagnostic tools require all five nonnegative integer hard-gate
counters and all three cleanup counters, exact case/origin/seed/model/tokenizer
identity, and a complete closed serving profile. Served tokenizer bytes, model
configuration/version/tensors, and the checkpoint's transducer bank are bound
explicitly. A rehashed alternate attachment is refused.

The holdout builder loads the actual checkpoint training configuration and
checksummed native prepared inventory. Every full adapted episode and source
lineage must match its original declared export, and the reconstructed native
stream fingerprint must match the checkpoint cursor. An omitted declared source
cannot evade the test-component exclusion. Future frozen diagnostic cohorts use
schema 2 and require this evidence before inference.

The original experiment used schema 1. A **separate retrospective audit** passed
all these stricter checks, confirmed all 32 actual prepared/sampled members, and
reproduced the original eight test components unchanged. It checked all 24
original held-in and held-out raw outputs without additional model inference or
optimization. Original results and frozen cohort bytes remain unmodified. The
audit is not a substitute for a pre-run production qualification.

The later [actual-artifact regression run](evidence/actual-artifact-regressions-2026-11-18.json)
passes all fourteen tests with zero skips, including six checks using copies
of the actual final checkpoint bundle. It rejects changed tokenizer, model
configuration, transducer bank, model version and incomplete actual training
inventory. This is separate from the 67-pass general Python boundary run whose
six artifact-dependent cases were initially skipped. Neither run performs new
optimization or inference.

The later integrated H validator also repeats all fourteen actual-artifact
checks successfully against those same original C assets and original consumer.
Its [separate receipt](evidence/actual-artifact-regressions-H-2026-11-18.json)
binds the H tool revision without changing the original model provenance.
Complete raw verification and model-context measurements are now retained in
the [delivered audit supplement](VERIFICATION_AUDIT_SUPPLEMENT.md).

## Work that remains before a production learning claim

1. **Obtain and bind an eligible actual base.** Native SE and SC require the
   preceding S-stage checkpoint or an eligible same-stage resume. The diagnostic
   P1 checkpoint cannot be renamed into an eligible production checkpoint. The
   same frozen base and served artifact must be bound across the planned arms.
2. **Supply the real production dependencies.** Native stage configuration
   requires ordered pinned donors `deepseek-v4.1-flash-1017` and
   `qwen3.8-flash-next`, their verified metadata/checksums, immutable hindsight
   targets bound to actual data, and the qualified coordinator/bootstrap/worker
   checkpoint arrangement. The supplied example SE configuration still contains
   `PIN_` placeholders for corpus, codec, targets, donors, coordinator, cohort,
   and engineering receipt. These were not available as a qualified asset set
   in this session. Random replacements would not satisfy those contracts.
3. **Meet actual stage supply and launch gates.** SC requires invocation behavior
   in train and validation. SE additionally requires tool feedback, async,
   callbacks, repeated invocation, child execution, source rereads, and recovery
   in both splits. The native launch qualifier must bind the real repository
   revisions, tokenization, data, checkpoint ancestry, and runtime hardware.
   This sandbox supplied CPU torch and no GPU; production fit and throughput
   were not measured.
4. **Run the declared production budget and preserve native receipts.** The
   diagnostic config has `purpose: diagnostic`, phase P1, and no
   `semantic_experiment`; it cannot issue a genuine
   `semantic-experiment-budget/4`. The comparator needs positive new optimizer
   updates, native token/time accounting, actual prepared inventories, and the
   matching changed checkpoint and served export. Historical pretraining steps
   must not count as new experiment exposure.
5. **Evaluate with the native frozen design.** The strict comparator requires
   actual `semantic-evaluation-report/5` reports and the same independently
   frozen `semantic-evaluation-cohort/4`. The diagnostic report schema is
   intentionally incompatible. A confirmatory comparison additionally requires
   at least three planned optimizer seeds and all production qualification and
   statistical gates. The eight-family one-seed zero-success measurement remains
   a descriptive exploratory negative result.

These prerequisites could not be replaced by the available P1 diagnostic without
changing what the experiment claims to measure. The implemented diagnostic is the
genuine sandbox-compatible check; it does not resolve the production asset,
qualification, resource, or behavioral-success requirements.

For commands and contracts, see `docs/OPTIMIZATION_SMOKE.md`,
`docs/EXPLORATORY_HELDOUT_DIAGNOSTIC.md`, and the strict comparator's
`docs/LEARNING_COMPARISON.md` after integration. The bounded runtime's separately
declared exception and descriptor limitations remain documented in its semantic
profile documents and the consolidated project handover.
