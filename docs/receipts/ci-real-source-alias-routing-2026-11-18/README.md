# Real-source CI representative selection

This is a fresh integration diagnostic at producer
`d15ddca47854ebdb92b23598dd720ccd1a18c822` and native consumer
`6b4382b9af3bef120ca3a95ae24d35154d4cd66b`. It is separate from the H qualification
and does not regenerate the historical D/F corpora or run a model.

Two registered `utility:vscode/arrays.ts/distinct` cases, input indices 0 and 4
from the supported `perFamily: 12` inventory, have the same public stream under
different task IDs. Both freshly passed source, oracle, replay and individual
native admission. Supplying both to native preparation admitted one and refused
the second with the existing immutable episode-ID metadata error. The original
failure report is retained in `raw-native-refusal.json`.

The existing strict representative selector selected one case and recorded the
other as an alias. The selected input then passed actual native preparation:
one admitted, one accepted, no refusals. The selector requires matching frozen
component, split and native metadata compatibility; retained bytes stay unchanged.
The original campaign manifest was byte-identical to both saved source manifests,
and its full CAS and campaign integrity verification passed after the experiment.

The workflow now runs that selector for the real-source lane and passes both the
selected corpus and the complete original `--audit-campaign` to the packager.
All original admissions still undergo fresh qualification before preparation
selects the representatives. Both the original audit and selection evidence are
retained in CI artifacts. Other recipe routing is unchanged.

## The training caps remain strict

The actual prepared row has 1,379 generated tokens and belongs to one training
component. The unchanged final native cap check:

- Accepts the explicit unbudgeted preparation control.
- Refuses the actual CI policy of 10,000 tokens per component and a 20% maximum
  component share, because this single component supplies all training tokens.
- Refuses a token budget smaller than the actual 1,379 tokens.

These are native preparation and refusal controls, not a balanced training
release. The workflow still uses the original 10,000-token and 20% caps, and its
final native check is unchanged. No cap was loosened to make the probe pass.

## Scope of the CI claim

A separate read-only scan of the default `perFamily: 2` real-source inventory
found no repeated same-family source/input groups among its 210 candidates.
That scan is not a full native execution of those candidates, and this diagnostic
does **not** claim that the current default 210-case lane already encounters a
collision. It establishes the collision and the safe routing for exact aliases
in the supported larger input inventory, including the previously measured E
failure mode.

Four focused tests passed: three execute the actual workflow shell step with
command recorders to check routing, exact caps and failure propagation; the
fourth checks native consumer identity boundaries. Those command recorders are
not native admission evidence. The separate fresh collection and native
preparation provide the actual semantic evidence.

The complete external evidence root is
`release-evidence-ci-selection-2026-11-18/`, with the original compact campaign,
exact source exports, raw and selected native outputs, logs, process receipts,
frozen pins, environment receipt and `file-index.json`. The committed
`check-final-caps.py` is the exact script executed beside those artifacts; it
expects the evidence-root layout and the recorded immutable producer checkout.
There is no nested release archive or dependency cache in this proof.
