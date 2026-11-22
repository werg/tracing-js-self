# Direct V8 release boundary review

Review target: producer commit `b4ee5e8645606f91002d10e4953618365fe7746c`, tree `cf44943` (the producer code version with 17 direct release boundary controls). The review read the package driver, restore driver, native environment checker, lock, and native verifier behavior. No production package or restore run is claimed here.

## Findings

No concrete blocking authority or mapping defect was found in the reviewed producer implementation. The release manifest's digest is integrity metadata, not provenance: restore first requires an externally supplied archive SHA-256, then verifies the exact clean producer/native source revisions and producer implementation receipts. It rebuilds the descriptor from the current complete qualification snapshot and requires the saved source selection and provenance to match that journal. Restore freshly rechecks the selected source artifacts, regenerates prepared data, and compares the prepared semantic inventory, checkpoint state and position receipts, and actual served model/transducer state.

The archive boundary uses strict duplicate-key/nonfinite JSON handling for the manifest, bounded tar and extraction limits, no-symlink path checks, regular-file-only extraction, exclusive creation, and post-extraction member hashing. The native checkpoint path uses `weights_only` loading through the ordinary checkpoint loader; it checks the direct checkpoint directory, metadata, training lineage, objective and reconstructed positions. The served export is checked against the loaded checkpoint tensors and the expected transducer cache-version increment.

## Explicit limit

The environment checker parses the hashed dependency lock and checks installed package versions plus locked Python, Node, V8, npm, platform, architecture, timezone, locale, and tokenizer identity. It does not attest installed wheel or package-file hashes. Describe this as exact locked-version/runtime verification, not hermetic binary reproducibility. The package and restore code make no portable-container, live-service recovery, learned-success, or default-promotion claim.

The archived environment receipt is byte-bound as an archive member. Restore reruns the environment gate; its semantic report comparison intentionally does not require runner telemetry such as image label, CUDA availability, or host libc to be identical.

## Evidence status

Root reported 17 release boundary controls and Ruff passing against producer commit `b4ee5e8645606f91002d10e4953618365fe7746c`; this review did not rerun those tests. The hosted custody workflow in the neighboring evidence files verifies preservation of the original failed Actions ZIP only. It does not exercise package creation, archive restoration, or model qualification.
