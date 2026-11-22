# Preflight for the separately sourced original348 follow-up

The original evaluation remains a failed measurement: 16 declared cases,
16 private source checks, eight provenance-qualified selections, and zero
complete programs. This preflight performs no inference or optimizer updates.

The follow-up keeps original producer
`9cf091e6ccc5add960ef0897576d0c391b199a65`, the actual step-348 served weights and
their complete original training lineage. Its inference consumer is
`99f018e045e760d802ff65f69bac1435985068aa`, based directly on original consumer
`1a69d9da3254b7568c831d12866a629c206cf4fe` with only the rejected-fragment
implementation, its regression tests, and the retained original eight-case
fixture changed. The driver checks that exact parent, all three paths and their
SHA-256 hashes before running.

The current broader language contract correctly refuses the old checkpoint's
lineage. Its contract digest is `fd1e64f6…`; the original checkpoint uses
`a9523855…`, and the interoperability digest also differs. The refusal is
retained in `current-contract-refusal.json`. No loader or lineage check is
relaxed. The minimal patch on the old source parent successfully loaded the
unmodified real bundle. That local patch and published consumer have the exact
same Git tree, recorded in `source-publication.json`; the initial local load
receipt retains its actual local commit identity.

`byte-identical-study-freeze.json` records a fresh local freeze of all three
studies under the original producer and UTC environment. All **six** study and
private-case files matched the original files byte for byte, preserving every
one of the **12 training / 3 validation / 1 test** cases. The model's input
prefixes and empty host environment therefore remain the original ones. All
**26 driver guard tests passed**, with zero failures or skips.

The hosted workflow will verify all 17 native boundary tests before inference,
then run every predeclared case with the original seed 17 and identical bounds.
It retains all failures and raw reports, separates source-scoring completion
from model-selection provenance and complete source-program success, and keeps
the other 48 profiles and an initialized reference baseline unmeasured. A
successful measurement gate would mean that all 16 attempts have usable
evidence; the independently scored number of complete programs can still be
zero. No new measurement is claimed by this preflight.
