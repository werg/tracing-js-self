# Shared scheduler state qualification — 22 November 2026

Exact pair producer 0a2c535a63541c2b9b6319d550aae1f413104c86 / native 263b7b9ec921fd43e3d97a8136dee1d1ab433b33 passed run 45006241411. All 32 original-ESM/owned/shared JavaScript controls and five native controls executed with zero skips; both native files passed Ruff check and formatting. Full Actions job is preserved verbatim in state-pass.log, with the raw differential payload and native results in state-evidence.json.

The differential includes 15 accepted cuts, 14 refused cuts and separate malformed-plan refusals. It freshly derives the module plan from actual linker metadata, including dependency file names rather than generated record indices. The initial failed run is preserved separately at ../v8-scheduler28ab-2026-11-22.

This checkpoint adds a private SyntheticModule-backed original-ESM observer and generated scheduler source-site map for further qualification. It does not expose an observer property on the guest global and does not add a Promise or microtask at observed await operands. The bounded DAG profile rejects unsupported observation cases. Runtime validation of these new helper files is pending.

No public/native module scheduler admission is claimed. State comparisons accept caller-supplied frame/Promise/job facts; the next requirement is to derive source-owned joins from actual generator and async helper frames, awaited promises and consumed queue event IDs, then independently replay them in native admission. Original-ESM source-file/site observations cannot stand in for owned-runtime identities.
