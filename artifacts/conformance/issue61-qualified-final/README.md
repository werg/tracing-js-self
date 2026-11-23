# Issue #61: final original-script campaign after the second review

This fresh campaign executes the unchanged original Test262 selection from clean
producer `f3f245798b3ac5de615c7aaf2cc2c472ea3d7abc`. The checkpoint includes the runtime
constructor/continuation validation fixes, shared reflection fixes, and source
observer/correspondence review corrections. It has its own new execution receipts
and import-closure fingerprint; all historical packets remain separate.

## Exact population and observed results

Test262 revision: `2a1ade303f72d3de80565c921d685222405c32ce`.
The newly acquired full catalog contains **103,360 variants** and retains digest
`67799da9e7d4dd08333fe38a75b7d738d9fd14ffc40a2e17d4d00254781a47de`.
The original **20 paths / 40 strict and sloppy variants** are unchanged, including
the original test bodies, harness files, and assertions. The selected path-list
SHA-256 is `0e79198a78fca057027c89e9644e454d4222200cde3031131be8336e33cfcb0d`.

| Executed stage | Passed | Unsupported | Failed | Resource limited | Infrastructure error |
| --- | ---: | ---: | ---: | ---: | ---: |
| Parse/static | 40 | 0 | 0 | 0 | 0 |
| Owned execution | 40 | 0 | 0 | 0 | 0 |
| Independent Node/V8 reference | 40 | 0 | 0 | 0 | 0 |

All **120 attempts** are retained with their evidence and worker commands.
The other 103,320 catalog variants remain explicitly `not_selected` in the full
ledger. All 40 owned traces were structurally validated and exactly replayed.
The diagnostic list is empty: this run found no new first barrier.

## Revisions, policy, and verification

The producer ran in a new detached clean worktree with a physical copy of its
Node dependencies. The Test262 checkout was also clean. The runner checked its
implementation import-closure identity throughout execution. Its code digest is
`d7787dbceaf3435fdb8e78f4f5cd6737e1e4353ee0c5f9ec8e393bae6d322b8a`.

The unchanged policy uses Node `v24.22.3`, V8
`13.6.233.17-node.63`, two workers, 60,000 ms worker wall timeout,
384 MiB worker heap, 20,000 owned steps, 1,048,576 source bytes, and a 300 ms
reference VM timeout. Parent Node commands use a 2,048 MiB heap cap.
`execution-inputs.json` captures the actual revisions, selection, environment,
and command arguments before the run.

`verification.json` and the original command logs record these completed checks:

- The full original report passes the campaign validator.
- Resuming the completed campaign preserves its gzip bytes exactly and leaves
  the attempt count at 120 to 120.
- The **new** compact selected report reconstructs the identical full report,
  including the full unselected ledger; both JSON and gzip identities match.
- All 25 original test/harness files match pinned Git bytes, SHA-256 values, and
  Git blob identities. The 40 selected variant identities equal the baseline.
- All 40 owned traces bind the original harness and runner-prepared strict/sloppy
  source digests. The runner's declared strict preparation remains the only
  strict-mode transformation checked here.
- All 94 previously retained files captured before this campaign remain
  byte-identical; `historical-preservation.json` identifies those files.

The full report gzip SHA-256 is `bdc6e95d7d734a70e14091568034b41c5922e1040a41d6e55b0d9f4ce1f3c8f0`.
The full report JSON SHA-256 is `94571d01c65bfc9928767a7448270266293f399eb360f1f08d54514977ed1988`.
The compact projection records full artifact sizes and both hashes. Reconstruction
and retained-input verification perform no guest execution.

## Reproduction and packet checks

Run `reproduce.sh` from a clean checkout of the recorded producer revision, with
`TEST262_SUITE_ROOT` pointing to the exact clean Test262 checkout and
`TEST262_OUTPUT_ROOT` pointing to a fresh output directory outside producer
source. The script acquires a fresh catalog, executes the same selection and
budgets, performs the byte-identical completed resume, validates the full report,
retains and reconstructs that **new** run, and verifies its original input bytes.
Use physical dependency files within that checkout, as in this campaign.

`verify-original-inputs.mjs --suite-root <suite>` independently validates the
recorded original bytes and selected evidence from the clean recorded producer.
Its optional `--retained-root` selects another newly retained report, while the
baseline comparison remains bound to the sibling `issue61-baseline` packet.
`python3 verify-retained-files.py` checks every packet file against the SHA-256
manifest and checks the retained accounting; it executes no guests. The manifest
covers every packet file except itself.

## Evidence boundaries

The executed stages are original-script parsing, owned execution, and independent
Node/V8 reference. Source correspondence remains `not_run`; public replay,
consumer replay, and downstream admission/training stages remain blocked in this
campaign ledger. Source-artifact correspondence, native replay, broad regression,
and installed-consumer acceptance require their own separately recorded inputs
and receipts. This packet is not a full combined-gate attestation.

Native revision `acd86c6513ec7af8b50365517f4bff9b7e2aad5a` was supplied as contextual information.
This campaign did not inspect, execute, or certify that consumer checkout.
The original 40-script passes therefore carry no claim of native Test262 script
admission or broad Promise conformance.

Historical packets, including `issue61-baseline`, `issue61-runtime`,
`issue61-current`, `issue61-review-final`, and the separate control packets retain
their original revisions, logs, failures, and qualification boundaries.
