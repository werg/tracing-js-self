# Independent audit of the 256-step native v8 evidence

This audit checked the retained package from producer commit
`e91ba6c78f1d3e53947bfdf84c6549ba8e7ddd99` without training or running model
inference again. It verified the three compressed archives and all 53 original
JSON members, independently decoded the original emitted token IDs, validated
the frozen study/private artifact bindings, and reran private source scoring
for all 24 recorded rollouts at the original scoring revision.

The final fitted report has **3/3 qualified executions on the training input**
and **0/3 on the input excluded from optimization**. The zero-update baseline
has **0/6**. The earlier stale-source reports retain **zero qualified
executions**, even though the fitted model had completed three public traces.
The private scorer reproduced that distinction. This is evidence for the
recorded in-sample feasibility result; it establishes no held-out success,
unseen-program generalization, or broader language coverage.

This package concerns the separately collected 256-step increment model. It
does not alter or combine results with the four-step diagnostics in
`docs/evidence/semantic-v8-diagnostic-pilot/2026-11-20/`.

## Exact audit inputs

| Item | Identity |
| --- | --- |
| Original package | producer `e91ba6c78f1d3e53947bfdf84c6549ba8e7ddd99` |
| Training source authority | producer `c65a905cd01ea7b9e8f211b19c02414b1a5dbb0d` |
| Training implementation | native `be453ab44847ea0b84f262909f31ba5c247851fa` |
| Retained final source authority and scorer replay | producer `9d4f6b3fcff97e7f915ae9c7228f7fd75aaaec3c` |
| Retained final native implementation and audit codec | native `23cd47816f9b99bbdb2ec9a32dd455daf68b732b` |
| Scoring runtime | Node `24.22.3`, V8 `13.6.233.17-node.63`, Linux x64, `TZ=Europe/Berlin` |
| Production tokenizer bytes | SHA-256 `40fb9d7d7795b8bd305aeff39ce9963f3f450915b9553f2938e009be9a1fed60` |
| Production codec fingerprint | `7f52faca2fe82273a889023defd2f1a6fd6080a21096ec77e97f4798a0a370b2` |

The original archive and per-member hashes are copied into
[retained-audit.json](retained-audit.json). They are independently recomputed
against the neighboring [artifact index](../artifact-index.json), including
the original summary bytes. The training script bytes at `be453ab` match its
recorded SHA-256 `2e0ca1ebc50464fcdfa66963a055aed278398faf43939719408bdccb468b2cea`.
The model hashes agree across retained manifests, reports, frozen studies and
per-attempt identities. The actual model files were unavailable to this audit.

## What the replay verified

Every study declares the same two input cases and seeds `17`, `29`, and `43`
before the recorded execution. Each of the four reports contains all six
declared rows, with no untested or omitted row. The scorer validated every
result digest, frozen study digest, request digest and private expected-artifact
digest. The public study requests contain only the observed program/invocation
prefix and declared fixture. Their private expectations remain separate.

The replay called the historical producer's `scoreSelectedRegionExecution` on
each retained result. That function independently rechecks the private source
artifact and requires exact complete public projection and contexts in addition
to public acceptance. The six fitted training-input records in the final study
match the source-qualified algorithm result `7` and explicit detailed `end`.
Each training-input rollout therefore has two accepted predictions. The three
held-out-input rollouts each retain a malformed first prediction and no
completed execution.

For the earlier stale-source studies, the historical scorer again rejected
the private source environment identity. All twelve result digests still
validated, while no source qualification was granted. Thus public completion
alone did not become a qualified execution. The full 24-row recheck is in
[private-score-recheck.json](private-score-recheck.json).

| Recorded study | Declared rollouts | Public completions | Source-qualified executions | Prediction attempts |
| --- | ---: | ---: | ---: | ---: |
| Final source, zero-update model | 6 | 0 | 0 | 6 |
| Final source, fitted model | 6 | 3 | 3 | 9 |
| Stale source, zero-update model | 6 | 0 | 0 | 6 |
| Stale source, fitted model | 6 | 3 | 0 | 9 |

The source program is identical for both cases:
`"use strict";function run(x){return x+1;}`. Input `6` was optimized; input `8`
was excluded from the optimization objective and early stopping. Both artifacts
retain the same family-hash **train** identity. Here “held-out input” means the
second input of this one program, not a held-out dataset family. Repeating either
input across three seeds does not create three independent programs.

## Original failures and cost evidence

The audit decoded every original fragment in the 30 prediction attempts across
the four process-study reports. The production codec reproduces each fragment's
original bytes from its emitted token IDs. It also checked every fragment in
the 19 prediction attempts from the 12 original trainer evaluation rollouts,
including the initial baseline, all eight intermediate training checks, and
the final reloaded training/held-out evaluations. Those original evaluations
all failed in the original evaluator, whose entry-envelope defect also
confounded second-record results. Their 1,261 emitted tokens and failure costs
remain recorded. They are not recast as successful runs.

| Final source study | Verified generated tokens | Native-reported emitted tokens | Unknown-cost attempts | Invalid UTF-8 fragments retained |
| --- | ---: | ---: | ---: | ---: |
| Zero-update | 344 | 564 | 2 | 2 |
| Fitted | 405 | 405 | 0 | 0 |

The baseline's two invalid UTF-8 fragments each retain 110 original token IDs
and their exact fragment bytes. Their top-level text payload is null and the
native selection is rejected. Independent byte decoding confirms that the
fragment bytes are intact, but it does not retroactively change the original
provenance verdict. The report therefore remains **344 verified tokens plus
two unknown-cost attempts**, with the additional 220 native-reported IDs shown
separately. All original timing and memory accounting is retained. The audit
recomputed the per-report prediction, token and native-compute aggregates.

The retained training history has 256 consecutive steps, 74 target tokens per
step, and a reported 33 changed decoder parameter owners. The exact training
script uses only the training input for the objective and early-stop check.
Its assertions forbid a reported change outside decoder owners. Rechecking the
actual tensor differences would require the unavailable weight files.

## Repeating the audit

Use clean checkouts at the exact producer and native revisions above. Install
the producer's locked Node dependencies and the native project's locked Python
dependencies. The native Git checkout must also contain the training commit
`be453ab` so the script can verify its bytes. Supply the production tokenizer
with the pinned hash. The following commands write only to the chosen audit
output directory; they load no model weights and run no inference or training.

```sh
# Set these paths for the current machine.
audit_package=/path/to/tracing-js-self/coverage/language-expansion/native-v8-fit-23cd478
audit_producer=/path/to/clean-producer-9d4f6b3
audit_native=/path/to/clean-native-23cd478
audit_python=/path/to/native-venv/bin/python
audit_tokenizer=/path/to/pinned-tokenizer.json
audit_output=/path/to/new-audit-output

PYTHONPATH="$audit_native/src" "$audit_python" \
  "$audit_package/independent-audit/audit-retained.py" \
  --native "$audit_native" --tokenizer "$audit_tokenizer" \
  --output "$audit_output"

TZ=Europe/Berlin node "$audit_package/independent-audit/recheck-score.mjs" \
  --producer "$audit_producer" --retained "$audit_output/retained" \
  --output "$audit_output/private-score-recheck.json"
```

The original package's independent archive verifier can also be run with
`python "$audit_package/verify.py"`. The two scripts in this directory were
executed successfully with the supplied receipts. `SHA256SUMS` pins their exact
bytes and those receipts.

## Limits caused by unavailable model bytes

The neighboring package names a separately retained archive
`native-v8-fit-be453ab-fce915db.tar.zst`, 43,360,285 bytes, SHA-256
`56bfb096255f810729ec46c0e0d4c050ef035bb1c0d3bfa89a9350eebbd5d5c8`.
Its bytes and a retrieval location are absent from the repository package.
This audit did not access or verify that archive.

Consequently, it cannot independently hash the claimed baseline/fitted model
files, inspect their tensors or optimizer state, verify the reported frozen
parameter differences from the checkpoint bytes, reload that historical fitted
model, regenerate its neural emissions, reproduce inference costs, or resume
that exact optimizer checkpoint. The retained manifests establish consistency
of reported identities, not verification of absent files. The byte and private
source checks establish the validity of the preserved output evidence; they do
not independently establish that the unavailable weights generated it.

The pinned training code, source artifacts and tokenizer permit a new training
attempt, with a newly measured identity. Such an attempt would not itself prove
the absent historical archive's bytes and was deliberately outside this audit.
No inference, additional optimization, or promotion claim follows from the
audit.
