# Child bootstrap evidence before protocol unification

These are retained results for two earlier, separately frozen implementations,
plus local follow-up diagnostics. Both hosted jobs passed their declared cases.
The corrected, combined producer/native candidate still needs its own mandatory
hosted result. The cohorts overlap and must not be added into a new denominator.

## Exact hosted identities

| Result | Producer | Native | Actual JUnit leaves |
| --- | --- | --- | --- |
| [Original gate 45025181568](https://github.com/werg/tracing-js-self/actions/runs/45025181568), job 137216565066 | `95bcaf60c73c8a47e48e4ef65736c09fe0756665` | `97cfd78c886e039b9cff6b9e677ec01265896235` | 146 producer and 54 native; zero failures, errors, or skips |
| [Alternate gate 45025448089](https://github.com/werg/tracing-js-self/actions/runs/45025448089), job 137217357931 | `86b1ecc633cd2be324c4cac2cb990d409195a1f5` | `8cdec19dbac9af0ba7968ac3b1adb84e53ce0dbc` | 72 producer; zero failures, errors, or skips |

The original gate exercised the explicit predecessor-bound child protocol,
complete create/bootstrap cuts, original Linux clock authority, known outcomes,
unknown-outcome refusals, and repeat process loss. The alternate gate exercised
a separate three-argument bootstrap protocol. Useful assertions from that
implementation were ported into the unified candidate; its source and result
remain intact under their original identities.

The JUnit files were downloaded from the original Actions artifacts and parsed
independently. Archive SHA256 values, artifact IDs, file hashes, and complete raw
log hashes are in [manifest.json](manifest.json). The timestamped job logs are
gzip-compressed with deterministic metadata and then base64-encoded. Decode
them with `gzip.decompress(base64.b64decode(path.read_text()))` in Python.

## Why neither prior success qualifies the corrected candidate

Review found a concrete native integrity gap in the original `97cfd78` source:
the existing-completed durable path could return a rehashed response with an
altered child parent while the actual postcheckpoint remained unchanged. The
producer's independent full-child verifier rejects that response, but the
standalone native path still needed stronger response and live-state binding.
Those corrections and the ported alternate native checks require a new exact
paired run.

A separate producer storage fault was reproduced in all four combinations of
selected commit/child bootstrap and lost publication acknowledgement/failed
independent readback. The original producer intent remained at ordinal 1 or 2,
and the native target operation had not been dispatched. Nevertheless, the
transport stayed live and allowed a later cancellation. The retained
[red diagnostic](storage-ambiguity-red.log) records those observations.

The producer now fences the transport once intent publication has been attempted,
even if storage throws before returning a receipt. The four actual-native
[storage controls](storage-ambiguity-green4.xml) pass with zero skips, and prove
that later mutation is refused without additional native dispatch or costs.
The fix was published in `20bdc7147610b4ffd9a55cd844ad325c82b7d486`.

## Frozen producer follow-up

The follow-up source is published as
`a5f3f42ab4abc2ed7d9d36550687358843933129`, equivalent to local commit
`ab98ca28cbef511e962a371cfd4cded69ab505dc` at tree
`889bc16e240ca0df5f9adc3f9284e5d55a965cb3`.
[followup-source-map17.json](followup-source-map17.json) records every affected
blob and confirms that its earlier baseline matches producer main
`2cb668c233be139e37d3e5a78c8d4ab8a544cd62` on all 17 paths.

The [42 local focused cases](followup-producer42.xml) pass with zero failures or
skips against the original native `97cfd78`. They cover the pure bootstrap
builder, actual bootstrap transport, existing commit transport, the storage
faults, and ported execution/clock/acknowledgement assertions. This local result
does not substitute for the corrected native gate.

The new two-child baseline retains full durable host history and completes two
actual native child executions. It passes in 170.93 seconds here, using an
explicit 300000ms policy that is already within the existing hard limit. Its
[passing log](later-sibling-baseline300s.log) and earlier
[120000ms deadline refusal](later-sibling-initial120s-refusal.log) are retained.
This baseline makes no genuine-clock recovery claim. The two new later-sibling
lost-reply and repeat-loss cases require the hosted Linux clock authority and
remain pending here. Production defaults and limits are unchanged.

The combined producer denominator is expected to be 155 leaf cases: the
original 146 plus four storage controls, three two-child/later-sibling controls,
and two ported builder adversarial controls. Native unification additionally
preserves independent router and terminal-close work. Its final native count
and exact source identity must be frozen before that combined gate is run.

All decoder fixtures in this bundle control original lexical bytes while the
actual native engine owns state transitions and reexecution. These results do
not measure learned model quality, expand training populations, claim generic
unknown-outcome recovery, or establish distributed ownership. Known reported
native costs remain monotone; unobserved CPU in a killed process cannot be
reconstructed. The original immutable clock continues to charge elapsed time.
