# Diagnostic training artifact preservation

The first archive attempt, run `45036752674` / job `137252106937`, froze producer `def8f9db97ade0045fc06288dfaca378212a818b`. It verified original run/artifact metadata, then failed before downloading the original ZIP or creating any release. GitHub Actions artifact downloads require a JSON Accept header; the release-asset binary header used for that request received HTTP 415. The complete initial job output is preserved unchanged here.

The correction uses the endpoint-appropriate header and additionally preserves the original full training job log as an asset. It does not change the original artifact, rerun training, replace any existing asset, or publish a release. The archive operation requires a draft, checks every original ZIP member against the committed inventory and independently downloads every uploaded asset to verify its bytes. Completion remains unclaimed until the corrected hosted run succeeds.

The second attempt, run `45037019740` / job `137252915580`, froze `7759b2f80dccc836403eb369822447e04509e475`. It downloaded and fully verified the original ZIP, then GitHub CLI refused the original training job log because it contains terminal escape sequences. No release had been created. The byte-preserving download now explicitly permits those sequences while directing stdout only to a binary file; the raw log is not rendered in a terminal or executed. The complete second failure is retained unchanged.

## Completed preservation

[Run 45037236499](https://github.com/werg/tracing-js-self/actions/runs/45037236499), source `14e7e3932ce9a9d9caf408ed6dba4bc16cc4ba22`, completed successfully. The original 178,270,704-byte ZIP, deterministic audit archive, original complete training job log and checksums are stored as four assets of an **unpublished evidence draft**. Every uploaded asset was independently downloaded again and matched in size and SHA-256. The original ZIP's 593 members and 517,660,755 expanded bytes were matched to the immutable member inventory before upload. No optimizer updates occurred. This preserves existing diagnostic evidence; it does not qualify a production model or learned behavior.

Draft: [https://github.com/werg/tracing-js-self/releases/tag/untagged-fa2b63b98c3bc9c81568](https://github.com/werg/tracing-js-self/releases/tag/untagged-fa2b63b98c3bc9c81568); release ID `454536221`. The owner can review this draft on GitHub.

The exact receipt and uploaded receipt ZIP are retained here, as is the complete successful archive job log. `release-assets.SHA256SUMS` is the manifest attached to the draft; this directory's `SHA256SUMS` covers the retained local proof. Earlier failures above remain historical and are not relabeled as successful runs.
