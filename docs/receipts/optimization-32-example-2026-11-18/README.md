# Actual 32-example optimizer diagnostic

The actual native CPU optimizer completed 32 updates from a newly initialized
tiny model. The optimizer, masks, checkpoint reload, and served reload checks
passed. **The complete-execution smoke did not pass:** both the initialized base
and its trained checkpoint completed zero of four held-in evaluation tasks.

## What was measured

The preparation gate independently rechecked and admitted 32 examples spanning
29 source families. Selection was deterministic: round robin across families,
with the smallest generated-token example first within each family. The inputs
were existing release-C engineering and training-v4 exports; source and native
receipts were not modified. This feasibility selection does not estimate the
full corpus distribution.

The native sampler visited only three prepared examples during the capped
32-window run: promise-reaction (17 windows), absolute-distance repeated
(10 windows), and unit-conversion pure (five windows). It supervised 865 lexical
tokens. The 32 examples and 29 families describe the prepared corpus, **not**
32 independently trained examples or 29 families of actual update exposure.

The prepared corpus contained 40,690 observed tokens with zero scored positions
and 9,379 generated tokens with supervised positions. Every actual update had
nonzero encoder, shared, and model gradients. The optimizer changed 307 parameter
tensors; 311 parameter owners had positive update moments. The actual native
phase-start checkpoint matched the declared initial base model and optimizer
master tensors exactly, with zero initial steps and moments. Final checkpoint
reload and both served model reloads matched tensor-for-tensor.

The native trainer took 137.38 seconds. Step times ranged from 1.43 to 7.07 seconds
(median 4.00 seconds); optimizer kernels accounted for 0.74 seconds in total.
Native `peak_memory_bytes: 0` is a GPU allocator counter and does not measure CPU
memory. The runner separately recorded a 1.165 GB peak RSS before importing the
model runtime. Serving profiles retain process RSS measurements.

## Actual free-running results

Four corpus members were evaluated with each fixed checkpoint through the real
selected driver and native served model. No controlled selection or expected
answer entered the inference request. All eight attempts failed on their first
candidate action. Four failed in the native renderer with
`SemanticSelectionError`; four reached trace validation and failed with
`TypeError` for invalid JSON or a missing record separator. All original emitted
token IDs and payload bytes remain in the unmodified `result.json` and
`serving-profile.json` artifacts. These failures are model/protocol failures,
not intentional guest throws.

Every failed rollout reported zero future-observation leaks, unauthorized
effects, native fallback, false admissions, replayed effects, leaked resources,
pending effects, pending jobs, and open handlers. With no successful action,
this checks the refusal and cleanup paths; it does not establish successful
effect execution or exception handling by the trained model.

## Provenance and interruption

The source-verifier checkout was immutable producer
`c4296c271eec32c2f2ab4cd34c30fd8b61e6ba39`; the consumer was
`277edd4a2983e81f5e2a71b34a7ce29348e4e7a0`; the runner was
`d8f582b5fe6a2d1c44187bbfa6378e7eaa560667`. This records the consumer used at the
time. The later immutable-input consumer repair does not retroactively change
these receipts. Exact tokenizer, package, and environment receipts are included.

An earlier 32-example attempt was killed with exit 137 during preparation,
before any optimizer step. Its original incomplete report and separate external
termination observation remain under `interrupted-attempt`. Memory pressure was
suspected but no kernel OOM proof was available. The successful retry delayed
the model-runtime import and interned only byte-identical decoded source
registries; it did not change serialized source/native evidence.

`index.json` hashes the copied evidence. `full-artifact-index.json` hashes every
file in the complete 443,866,841-byte output, including the original binary
checkpoints, served bundles, and prepared corpus. Those complete artifacts are
retained at the original output path for separate packaging; large binaries are
not stored in Git. Absolute paths in raw receipts identify this execution.

This is one seed, a newly initialized small model, a step-limited diagnostic,
and unsuccessful held-in execution. It is neither a production SE/SC
qualification nor a completed transfer pilot. It has no native
`semantic-experiment-budget/4` and must not be supplied to the qualified held-out
comparison tool as if it did. `optimizationSmokePassed` remains false.
