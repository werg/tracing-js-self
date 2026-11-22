# Bounded complete-evidence custody controls

Source `fa778f890db03795c9aa0b74f2d2f83df899daec` adds the reusable explicit
custody plan, companion driver, scoped workflow and twelve controls. It changes
no producer/native runtime or semantic artifact. The existing generic archive
retainer remains unchanged and is checked against source SHA-256
`3d14450be68d245c381857f3083ac871944d7fda85adab354839b07dc82ad122` before loading.

`tests.log` retains all twelve passing controls, zero failures or skips. The
controls cover exact failed-conclusion preservation, strict input types and byte
bounds, duplicate authorities, complete job membership, exact source/attempt/
workflow/conclusion/artifact metadata, pre-mutation log refusal, published or
retargeted draft refusal, changed retained asset refusal, full asset rereads and
safe rerun without overwrite. Network operations and draft assets are simulated
in these tests; no source run is relabeled as successful.

`observed-metadata.json` separately retains live read-only GitHub responses for
the failed original348 evaluation run `45046754653` and successful historical
790 task-binding run `45044587251`. The new validator accepted each exact
source head, attempt, workflow, conclusion, artifact ID/name/size/SHA-256 and
complete original job membership. Log pins come from the separately retained
complete original decoded UTF-8 API logs and are required to match the actual
downloaded bytes before any draft mutation.

No original ZIP was downloaded locally and no draft was created during this
preflight. A future hosted custody result must include independent read-back
receipts for the complete original ZIP, every complete job log and the combined
receipt. `proof.json` makes that pending status explicit and records exact hashes
of the retained local controls and API observations.
