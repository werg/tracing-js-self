# Actual 95-update partial epoch

This separate diagnostic completed 95 real native optimizer updates in 636.20
seconds. The actual native source receipt records **16 sampled examples from
16 families and 5,238 supervised lexical targets**. The prepared corpus still
contains 32 admitted examples from 29 families. This run did not complete an
epoch over that corpus.

The native packing helper defaults to four decisions per window, whereas the
resolved diagnostic training configuration defaults to two. An initial manual
profile used the helper default and forecast 95 windows for the whole corpus.
The actual configuration retained two. That profiling mistake was found while
training was running; the original run was allowed to finish unchanged and its
actual scope is reported here. The directory name `optimization-diverse-epoch`
reflects the initial intended experiment, not a successful full-epoch claim.

The original manual profile and its corrected two-decision profile are both
preserved. The corrected plan needs 170 windows to visit every target with the
actual two-decision cap. A later explicit 32-decision/16-record native plan
requires 49 windows. That subsequent attempt is separate evidence. The runner
was updated to profile its fully resolved configuration, freeze exact window
and record identities, and compare actual source counts, scored targets, and
checkpoint cursor before reporting success. It also supports copying the exact
original zero-update checkpoint bytes for the next run.

This run used the same initialized base model tensor identity and identical
served-model bytes as the preceding 32-update diagnostic. Its checkpoint
container metadata includes its distinct training configuration and output
paths. Each run's actual native phase-start state was independently compared to
its declared initial checkpoint. All intended gradient domains, finite changed
weights, actual optimizer moments, masks, checkpoint reload, and served reload
checks passed.

Both base and trained models completed zero of the four held-in tasks. Every
failure occurred on the first candidate action and retained original model
bytes and decoder token IDs. All measured hard gates and cleanup counters were
zero. `optimizationSmokePassed` is false for both incomplete sample exposure
and unsuccessful complete executions. No held-out result or production SE/SC
qualification is claimed.

The original raw receipts are unchanged. `index.json` checksums the copied
evidence; `full-artifact-index.json` checksums the entire output, including binary
checkpoints and served bundles retained for separate packaging. This run uses
producer `c4296c271eec32c2f2ab4cd34c30fd8b61e6ba39` and consumer
`277edd4a2983e81f5e2a71b34a7ce29348e4e7a0`; the later companion repair does not
retroactively change its provenance.
