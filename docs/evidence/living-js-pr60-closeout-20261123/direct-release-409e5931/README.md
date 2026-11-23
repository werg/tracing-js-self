# Completed direct V8 release on the recorded source pair

This packet retains original receipts and logs from the complete local release
qualification executed at producer `409e5931c4a9289909d57008008a8ea5b4a491fc`
and consumer `21b7c80718244073dbf13263771da533d4ecbc25`. The default policy path
was exercised without `--native-policy`. The source checkouts were clean and
unchanged before and after the run. A later documentation or evidence commit is
not this run's execution revision.

## Observed result

All eight outer stages reached their required outcomes. The current 64-source
cohort passed source qualification and native admission, independent membership
verification, original task binding, and complete preparation. Its authenticated
split counts were 52 training, 8 validation and 4 test sources. The ordinary
lifecycle performed exactly two optimizer updates with checkpoint resume,
export, and real service restoration. Packaging and restoration performed zero
optimizer updates and zero decoder forward passes.

The verified archive contained 351 files and was 73,179,925 bytes. Its SHA-256
was `8336b51933e6427514cf0606f1fcc1a2e0882168b79c400caf2df5e64b0edb7d`.
The wrong external checksum was refused before creating either restoration
destination. The successful restore ran after the original runtime asset and
package payload paths were removed, freshly checked source/native preparation,
and compared actual checkpoint and served state. Restored member bytes totaled
322,998,155.

Full target coverage remains false, accepted-history recovery remains
unmeasured, learned success remains null, and no default promotion was made.
The separate combined recovery gate is not qualified by this release result.

| Stage | Outcome | Seconds |
| --- | --- | ---: |
| `qualify-64` | passed | 325.703 |
| `verify-current-support-population` | passed | 0.418 |
| `bind-original-64-source-tasks` | passed | 3.784 |
| `prepare-64` | passed | 264.322 |
| `ordinary-two-update-lifecycle` | passed | 913.662 |
| `package` | passed | 446.653 |
| `refuse-wrong-external-checksum` | refused-as-required | 0.169 |
| `restore-with-original-locators-absent` | passed | 417.340 |

## Retention and verification

- [Final qualification](run/qualification-result.json) records the exact scope.
- [Original stage commands](run/stages.json) retain commands and outcomes.
- [Before](before.json) and [after](after.json) retain clean source identities.
- [Package result](run/package/package-result.json) and
  [restore result](run/restored-verification/restore-result.json) retain the
  archive and restoration claims.
- [Manifest](manifest.json) maps every retained original to its raw and stored
  byte counts and SHA-256. Large text files use deterministic gzip with mtime 0;
  decoding recovers each original byte stream exactly.
- `complete-file-inventory.json.gz` hashes all 1,131 files in the completed run,
  totaling 1,126,073,344 bytes, including hidden files. The full archive, model,
  checkpoint, tokenizer and prepared data bytes are not included in this packet.
  The inventory does not reconstruct excluded bytes or claim they are durably
  available here.

The packet also retains all 64 original native admission receipts, complete
population and registry reports, original lifecycle and service receipts,
checkpoint/export metadata, both package/restore environment and native
verification reports, the whole command console, and all outer stage logs.
Recorded absolute paths are original execution observations; some deliberately
refer to runtime locations that were later removed by the restoration test.
