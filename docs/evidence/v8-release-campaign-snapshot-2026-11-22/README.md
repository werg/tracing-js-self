# Read-only V8 release campaign snapshot

Source `d5311563f70a37b638dc21e25c8bb11d0d628aa5`, tree
`ad81ea8bd0ad37524bd34a67ecb1839d258e1854`, adds the direct V8 campaign
verifier and its controls. It follows neutral archive source `99472fc4` and
retained equivalence evidence `a4ebf433`, without importing the old semantic
packager, old compiler or old release-campaign verifier. This commit retains
evidence only; executed source remains unchanged.

## Published-tree controls

The final Node 24.22.3 run passed **25 executable leaf cases, zero failures,
errors or skips**: 21 new verifier leaves and four existing progress controls.
Node's TAP summary reports 29 entries because it also counts four parent test
containers; JUnit contains the 25 actual leaves. Every identity and outcome is in
`source-and-cases.json`. The earlier configured and working-tree runs overlap;
they are not added to the published population.

The first invocation had no writable TMPDIR configured. Fixture creation failed
before campaign setup (the unchanged existing progress tests failed for the same
reason). Its raw output and source hashes are retained. Configuring the existing
scratch test directory resolved that environment failure. The first configured
run passed 23 leaves; two additional boundaries (receipt/file equality and a
symbolic-link ancestor) were then added before the final 25-leaf run.

The actual journal/candidate/result CAS, completed artifact hashes, full declared
population and canonical selected IDs must agree. Every committed attempt and
original failed artifact remains accounted for. Unselected cases cannot acquire
admission, and uncommitted orphan files remain explicitly auxiliary bytes.
Changed rows/counts/revisions/contracts/source tasks, missing or changed evidence,
CAS corruption, reordered or torn logs, overwritten historical artifact names,
active writers, symlinks and mismatched native receipt files refuse.

The verifier uses `CampaignStore` in read-only mode with torn-tail recovery
forbidden. It never opens ordinary resume, repairs the log or reruns collection.
Bounds cover metadata, journal, object and aggregate file sizes and member counts.
One fresh-process control copies only the verifier and the neutral CampaignStore:
every semantic compiler and previous release tool is physically absent.

## Genuine retained campaign and transport omission

The completed expanded campaign is producer
`b4157952ed0fc28c5ae1eb8893cd9035ce25bbdb` / native
`2f3e6cf04aad60473e8ecc67e846e81e5b9dec83`, Actions run `45025994295`.
Its original ZIP is **178,270,704 bytes**, SHA-256
`4e4d26f10173d85182af3d189ba0d69a6327c90cdaba7ebd2adc5abc8758087e`.
The uploaded extraction omits the hidden `progress/.campaign.lock`. The new
verifier correctly refuses that original tree rather than creating an authority
file during a read-only check. The exact failure is retained.

A separate staging copy contains identical original bytes plus one explicitly
new, empty local lock file. The original extraction was independently inventoried
before and after and is unchanged. The complete staged snapshot verifies all
**64 declared and selected cases, 64 committed attempts, 64 retained source
qualifications and 64 retained native admissions**. `attempts.jsonl` is preserved
as an auxiliary materialized view; the hash-linked committed journal supplies
authority. The snapshot and the full original/staged inventory reconciliation
are retained losslessly in the two gzip JSONs.

This local lock establishes exclusion only for the staging copy. It does not
recreate original host lock authority, amend the downloaded ZIP, repair history,
or transform this reread into 64 fresh source/native executions. New release
archives must preserve their complete lock/journal inputs and keep shared writer
exclusion through inventory and archive creation.

## Scope and next boundary

This verifier proves integrity and completeness of retained V8 observations.
It performs **zero source replays, native admissions, decoder forwards or optimizer
updates**. It is not full V8 release qualification. Native semantic re-preparation,
all data/token/mask/split equivalence, exact model/optimizer/tokenizer/transducer
roles, current paired source, fresh restored continuation and accepted-history
no-repeat rollback remain separate required checks. Learned quality is null.

The original hosted reports and independently checked training positions belong
to their original frozen source pair, not this later verifier. Raw logs/JUnit and
the report's hashes remain unchanged; `files.json` seals this evidence directory
and `source-and-cases.json` records decompressed proof hashes. The complete ZIP,
model weights and corpus are not represented as embedded in this directory.
