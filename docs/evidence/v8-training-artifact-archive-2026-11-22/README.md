# Diagnostic training artifact preservation

The first archive attempt, run `45036752674` / job `137252106937`, froze producer `def8f9db97ade0045fc06288dfaca378212a818b`. It verified original run/artifact metadata, then failed before downloading the original ZIP or creating any release. GitHub Actions artifact downloads require a JSON Accept header; the release-asset binary header used for that request received HTTP 415. The complete initial job output is preserved unchanged here.

The correction uses the endpoint-appropriate header and additionally preserves the original full training job log as an asset. It does not change the original artifact, rerun training, replace any existing asset, or publish a release. The archive operation requires a draft, checks every original ZIP member against the committed inventory and independently downloads every uploaded asset to verify its bytes. Completion remains unclaimed until the corrected hosted run succeeds.
