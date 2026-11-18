# Coverage after native preparation and sampling

The coverage-aware selector operates on the **final accepted native index**.
It derives a new `semantic-native-prepared-training-sampler/1` membership file,
which the existing native subset materializer can consume. It does not
regenerate a witness, change a frozen split, repair a target, or issue an
admission receipt.

## Complete input and selection

```sh
node tools/select-native-prepared-coverage.mjs \
  --sampler FULL_NATIVE_PREPARED_SAMPLER.json \
  --source-manifest ORIGINAL_CAMPAIGN/manifest.json \
  --max-family-tokens 10000 --max-family-share 0.20 \
  --max-training-tokens 250000 --out NEW_SELECTION_DIR
```

Create the complete sampler with the maintained
[current native derivation](NATIVE_PREPARED_SAMPLER.md). Its report contains
every `acceptedDecisions` row; the reduced historical D receipt is insufficient
for a new selection.
The source manifest must match the exact bytes, producer, campaign and
registry named by that sampler. Every final native row is joined to its
original admitted candidate, including identities, family, frozen split,
conservative source component, and observed/generated token counts. Missing
semantic measurements refuse a coverage-aware training selection.

Budget groups are recomputed as the transitive union of source components and
native resolved families. A cross-split union, invented budget component,
repeated native identity, changed token count or missing accepted row refuses
the operation. Validation and test examples bypass training selection, and
their exact accepted episode IDs are retained.

Within training, the deterministic selector prefers uncovered execution
features supported by fewer independent components. Family and component
representation also count; ties prefer shorter examples, then candidate ID.
Share enforcement removes rows with the least lost unique feature weight per
removed token. Absolute per-component, total-training and final proportional
caps remain hard. This is a bounded greedy policy: conflicting budgets can
still remove a rare feature. The report lists every lost feature and family,
and compares with the unchanged identity-ordered selector under the component
caps. The identity-ordered control does not apply the optional new global
training-token cap and is labeled separately by its counts.

Coverage features come from the original measured execution difficulty:
executed operations, branch outcomes, loop trips, exceptions, mutations,
aliases, callbacks, awaits, nested calls, repeated invocations, and supported
interactions among these signals. Features not present in that measurement
schema remain explicitly unmeasured; object count alone, for example, does not
establish whether a returned graph contains holes or getters.

`NEW_SELECTION_DIR/coverage.json` keeps separate candidate, admitted,
native-prepared and planned-selection inventories. `sampler.json` can then be
passed to the existing `tools/materialize-native-prepared-subset.py`. That
materializer rechecks actual native Episode bytes, tokens and loss masks and
enforces the optional global token cap during final readback. A selector
report alone is not proof that the new native subset has been materialized.

## Actual consumed targets are a separate population

The existing optimizer runner can supply a completed `report.json` and its
exact `native-schedule-plan.json`:

```sh
node tools/select-native-prepared-coverage.mjs \
  --sampler FULL_NATIVE_PREPARED_SAMPLER.json \
  --source-manifest ORIGINAL_CAMPAIGN/manifest.json \
  --optimization-report RUN/report.json \
  --native-schedule RUN/native-schedule-plan.json \
  --out NEW_SELECTION_WITH_EXPOSURE
```

Consumed-target reporting requires the same prepared fingerprint, exact
checkpoint reload, complete source-window history, matching schedule digest,
observed-token masking, and agreement among schedule, actual optimizer step,
source-window and scored-token totals. Evaluation episodes cannot appear in
this population. Repeated windows retain their repeated scored exposure.

The report exposes original native record IDs and scored-target totals. It
does not label every feature of an exposed episode as supervised: a partial
window may not contain the records expressing that feature. Exact per-feature
loss exposure needs a record-to-feature mapping and remains unmeasured until
that evidence is supplied. The consumed inventory describes the separate
optimizer run, not the newly selected membership.

## What can be measured from the committed D receipts

```sh
node tools/select-native-prepared-coverage.mjs \
  --sampler docs/evidence/semantic-v5/real-source-prepared-sampler-D-2026-11-18.json \
  --out NEW_AVAILABILITY_REPORT
```

This produces a `partial_inventory` report and **no new sampler**. The
committed receipt retains 1,171 attempted and 987 admitted candidates,
541 final native-prepared episodes, and 211 enumerated selected episodes.
The selected training membership has 132 episodes and 139,145 generated
tokens. The historical cap reduced training family labels from 74 to 47.
These are historical populations at their original pins, not a repaired
producer census.

The reduced receipt does not contain all 541 per-row native metadata records,
the original executed difficulty, or an optimizer exposure log. It cannot
reveal which semantic features the historical cap lost. The generated
[availability report](evidence/semantic-v5/coverage-availability-D-2026-11-18.json)
preserves these missing measurements explicitly and binds the input receipt's
SHA-256. The original D receipt remains unchanged.
