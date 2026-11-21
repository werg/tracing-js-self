# Native conditional capture admission

`effectful-tracks-events-capture-cohort.json` is a current canonical cohort
declaration for the read-only V6 conditional capture. It was rebuilt with the
pinned consumer's `freeze_cohort` from the cases, requests, reference outcomes,
and thresholds in the historical `effectful-tracks-events-cohort.json`. The
older file remains unchanged as historical evidence.

The older file contains a top-level `historicalBaselinePending: false` release
annotation. That annotation is outside the cohort schema: `freeze_cohort`
accepts only the declared fields, and `verify_cohort` requires the frozen object
to equal that canonical form. The current capture declaration therefore omits
that annotation and has its own digest. This is a declaration-only rebuild; it
does not rerun the evaluator, change any case or expected outcome, or claim new
baseline measurements.

The probe uses that cohort with the existing
`semantic-engineering-completion.json` through the consumer's real
`SemanticExperimentConfig.preflight(phase="SE")`. It builds a temporary
one-example SE config only to admit preparation of the already source-certified
V6 episode. The probe remains read-only and reports zero optimizer steps. This
capture binding is not a new engineering qualification or training result.
