# Retained baseline and qualification receipts

These are measured results at the revisions named below. They are not receipts for whichever revision later contains this directory. Original JSON/log files were copied byte-for-byte; [index.json](index.json) and the [baseline inventory](baseline-5753de1/file-inventory.json) record their sizes and SHA-256 digests. The two campaign summaries are explicitly labeled extracts with the hashes of their full source manifests.

## Completed measurements

| Measurement | Exact population and result | Evidence |
| --- | --- | --- |
| Fixed producer baseline | Producer `5753de14760b76754fd1bd49ca7c8bfc6de85831`, clean tree before/after; 841 unit tests passed, five skipped, zero failed | [baseline.json](baseline-5753de1/baseline.json), [original TAP](baseline-5753de1/unit.stdout.log) |
| Deterministic reference and contracts | Reference fixture, host contract, semantic contract and semantic inspection all passed | Original check logs under [baseline-5753de1](baseline-5753de1) |
| Local generated corpora | Engineering 25/25; training-v4 50/50 including lifecycle rows; benchmark-v1 128/128 including lifecycle rows. Total 203 locally verified, **zero native admissions in this baseline command** | `baseline.json` corpora and original corpus logs |
| Global source registry | 508 variants, 199 source-family labels, 135 connected components; component splits 89 train / 13 validation / 33 test | Baseline registry hash and diagnostics; full registry retained separately |
| Local capability ladder | 39 probes: frontend 33 pass / six unsupported; owned evaluation 31 pass / two unsupported / six untested; independent outcome 29 pass / one failure / nine untested. Native/model stages untested | [capabilities.json](baseline-5753de1/capabilities.json) |
| Actual native capability subset | Eight of eight admitted, with visibility, loss-mask and fragmentation receipts; model stage untested | [native-capabilities-fixed.json](native-capabilities-fixed.json) |
| Later native capability extension | Producer `25f8e905789f811920c138281074a292d4e571c1`, consumer `3d7ffc701a3e692883819fb623a03b1942cd8b5c`: 13/13 admitted, including array callbacks, sparse fill, input-graph mutation and captured camelCase default parameter | [native-capabilities-current.json](native-capabilities-current.json), [fresh environment](native-environment-current.json) |
| Independent spec probes | 12/12 passed, with owned reconstruction/replay | [spec-oracle-fixed.log](spec-oracle-fixed.log) |
| Owned arithmetic differential | 1,958/1,958 passed, reconstructed and replayed; 1,433 normal and 525 abrupt | [owned-arithmetic-fixed.json](owned-arithmetic-fixed.json) |
| Owned Test262 runtime slice | Eight files; six executed non-strict variants passed, two unsupported, eight strict variants omitted; 16 assertions executed | [test262-runtime-fixed.json](test262-runtime-fixed.json) |
| Native real-source campaign | 210 attempts from 105 source-family labels; 174 admitted from 88 family labels and 31 source components; 36 explicit refusals | [real-source-5753de1-summary.json](real-source-5753de1-summary.json) |
| Native engineering under OS isolation | Three of three admitted with `linux-namespace/1`; one source family/component | [campaign identity](isolated-three/campaign.json), [manifest](isolated-three/manifest.json) |
| Private release cap smoke | All three original admissions freshly qualified; 600-token family cap selected two for training and retained the third as an excluded admission. Final native preparation accepted both selected episodes; archive verification passed | [selection](release-cap-smoke/training-selection.json), [prepared check](release-cap-smoke/prepared-training-selection.json), [archive receipt](release-cap-smoke/archive-receipt.json) |
| Earlier native training-v4 collection | Producer `dac57b1`, consumer `277edd4a…`; 50/50 admitted across 16 source components. This is a different producing revision | [training-v4-dac57b1-summary.json](training-v4-dac57b1-summary.json) |
| Earlier broad real-source collection | Producer `dac57b1`, consumer `277edd4a…`; 1,177 attempted, 873 admitted, 304 refusals, 80 admitted family labels / 31 components, 726,952 admitted generated tokens | [real-source-dac57b1-broad-summary.json](real-source-dac57b1-broad-summary.json) |

The eight native capability cases are scalar arithmetic, parameter/body scope, later-parameter TDZ, explicit-undefined slice end, alias-preserving mutation, input-array mutation, synchronous primitive throw, and synchronous declared Error. They use producer `5753de1` and consumer **`6206b33a55eba3e50f80498f906439221bc289b7`**. [The native environment receipt](native-environment-fixed.json) binds that consumer, the locked installed dependencies, and the tokenizer identity/bytes. The same policy is recorded in the real-source and isolated campaign summaries.

The complete real-source refusal count is 4 `native_rejected`, 20 `unsupported`, 2 `reference_outcome_mismatch`, 4 `canonical_mismatch`, 4 `teacher_failed`, and 2 `source_unsupported`. Every original case disposition and reason is retained in the summary. Later fixes and fresh qualification must add new evidence; they must not rewrite these 36 original failures into successes.

The earlier broad population is separate: its 304 refusals are 138 `native_rejected`, 102 `unsupported`, 12 `canonical_mismatch`, one `worker_timeout`, 12 `projection_refused`, 30 `teacher_failed`, and nine `source_unsupported`. Its input count and revisions differ from the 210-case pilot, so the two admission ratios are not a matched before/after experiment. The broad extract retains family/status and exact-reason aggregates plus the original complete manifest hash, rather than copying the large corpus.

The local capability ledger intentionally retains unsupported descriptor combinations, forward-parameter closure projection, unsupported strict-profile syntax, and the independently rejected callback-abrupt-obligation probe. A passing baseline command does not mean every probe is supported. Likewise, the Test262 slice is neither a whole-suite pass rate nor full ECMAScript conformance.

## Timing and memory scope

The `5753de1` real-source campaign measured 904,726.565874 ms from process start through final-manifest measurement, including 5,810.921135 ms of preparation. It admitted 138,758 generated learner tokens. Coordinator peak RSS was 473,296,896 bytes and maximum worker peak RSS was 203,956,224 bytes. These separate peaks are **not** a simultaneous process-tree memory total. The measurement used two workers; its local token/hour rate is not a deployment capacity guarantee.

The older `dac57b1` training collection used the earlier timing implementation, which omitted preparation. Its original metrics are preserved for provenance; they should not be compared as though they used the newer end-to-end definition.

## Retention boundary

This directory contains compact logs, manifests, receipts and extracts. Full candidate source/input/fixture objects, compressed private journals, public shards, prepared native datasets and model weights belong to the separately hashed private archives. The 2.6 MB source registry can be regenerated from its recorded producer; its original file hash and internal registry digest are distinct identities and remain recorded. No large corpus or checkpoint was copied into the public source repository for this receipt increment.

The release-cap smoke uses a one-component share allowance of 1.0; it proves the 600-token component cap and preserved original admissions. It does **not** prove the separately running real-source release's 10,000-token cap and 0.2 share limit. The later 13-case native extension has its own exact receipt; final full producer qualification, final hosted CI, the larger release, and the balanced optimizer retry still need their own completed receipts.

Actual negative learning results are retained separately under [learning-pilot-2026-11-18](../learning-pilot-2026-11-18/README.md). None of the checks in this directory performs optimizer updates or establishes learned execution accuracy.
