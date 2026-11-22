# Completed local diagnostic target exposure

The local retained-input fit completed all **348 optimizer updates**. Its final
checkpoint passed a fresh complete inventory comparison: 48 training sources,
696 of 696 logical targets, 720 of 720 physical targets and all 720 expected scored
occurrences. Every per-target window set and positive-weight denominator matched;
all missing, unexpected and mismatch lists are empty.

The complete raw inventory, coverage census, optimizer metrics and output,
qualification output, configurations, runtime, checkpoint metadata/hashes and
independent prepared-target audit are retained in
[native evidence at 4793e31](https://github.com/werg/megatoken/tree/4793e31d1ee69dc33d3f8b1f7a5abb00072936c5/docs/evidence/v8-target-local-full-fit-2026-11-22).
The adjacent machine-readable reference preserves the exact source, runtime,
policy and report identities, as well as the variant and loss-denominator counts.

This diagnostic used the unchanged prepared corpus from original producer
`0694fa9280712fa1364ead46a477c757a0ca4bfa` / native admission
`dbc89dcd52cb93d1d9fdca2989fab64b85e5d427`. Its actual optimizer source tree was
identical to `a1d7f83dc46e4829ca4226e4040519cd5835f365`, running CPU fp32 with
torch 2.14.1 and seed 17. The fit took 5,607.900659478999 seconds. The old
admitted-input policy was preserved in the raw checkpoint and reports; it does
not claim that this local fit executed the original native admission revision.

The separate supplemental audit executed the retained procedure
`../v8-target-coverage-2026-11-22/verify-retained-policy-targets.py`. It admitted all
64 prepared sources, independently enumerated all 720 training policy targets,
and found exact equality with both planned and actual optimizer targets and every
retained window/occurrence/denominator row. It performed zero additional optimizer
updates. A first attempt reached every comparison but failed to seal its runtime
report because torch's version object is a string subclass; converting it to an
ordinary string fixed that report-only issue. The full failed log and successful
rerun report are retained alongside the native evidence.

This is completed local exposure evidence for retained inputs and the original
`0df03130...` contract. Fresh hosted producer/native qualification, qualification
of the later expanded asynchronous contract, and production launch are separate
results. Token/mask-position coverage is unmeasured and learned success is null.
