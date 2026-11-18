# Complete native CI artifact preservation

This receipt preserves the **complete original artifact ZIPs** from successful
recipe jobs in [native CI run 44321402524](https://github.com/werg/tracing-js-self/actions/runs/44321402524).
The durable producer is `1e2e6a0de8952c4349edbeef46ab70c4a06f8157` and the
consumer is `6b4382b9af3bef120ca3a95ae24d35154d4cd66b`. Each original native
identity receipt separately retains the actual workflow trigger merge revision;
that transient merge is not substituted for the durable checked-out producer.

Every ZIP is streamed from the authorized GitHub artifact download, checked
against **both the API byte size and SHA-256 digest**, and read member-by-member
without extracting archive paths. Every member's uncompressed byte count, CRC32,
and SHA-256 is verified and retained in its member index. Original small native
identity, source-disposition, and release receipts are copied unchanged beside
the verification record. No signed download URL or private connector file ID is
included in this repository.

Archives over 400 MiB are split into exact 400 MiB binary parts
(with a shorter final part). Their reconstruction indexes retain the whole ZIP
hash, every part hash and offset, and a verified SHA-256 of the parts concatenated
in the listed order. No archive content is repacked, omitted, or substituted.
The complete archives or verified reconstruction parts are retained separately
from GitHub's 90-day CI artifact lifetime and outside public Git.

| Recipe | Original ZIP bytes | ZIP members | Attempted / admitted | Independent admitted components | Preservation |
| --- | ---: | ---: | ---: | ---: | --- |
| [engineering](engineering/verification.json) | 106,834,065 | 215 | 25 / 25 | 20 | Original ZIP |
| [training-v4](training-v4/verification.json) | 319,752,944 | 418 | 50 / 50 | 16 | Original ZIP |
| benchmark-v1 | Pending | Pending | Pending | Pending | Successful lane artifact not yet preserved |
| [real-source](real-source/verification.json) | 494,989,082 | 1,280 | 210 / 190 | 35 | Exact 400 MiB parts |
| [generated-v1](generated-v1/verification.json) | 257,934,132 | 394 | 64 / 64 | 16 | Original ZIP |

## Prepared training data and family caps

Each available `training-selection-summary.json` independently recomputes the
post-deduplication native split counts, training-token denominator, maximum
component token share, cap policy, violations, and retained duplicate aliases.
The original selection JSON files remain unchanged beside that derived summary.
Training / validation / test counts below are distinct accepted examples after
native preparation; duplicate aliases remain in the original disposition files.

| Recipe | Distinct train / validation / test | Retained duplicate aliases | Final train tokens | Maximum component token share | Applied token / share cap | Violations |
| --- | ---: | ---: | ---: | ---: | --- | ---: |
| [engineering](engineering/training-selection-summary.json) | 19 / 2 / 4 | 0 | 7,524 | 20.09569378% | Disabled | 0 |
| [training-v4](training-v4/training-selection-summary.json) | 43 / 4 / 3 | 0 | 24,065 | 8.55599418% | Disabled | 0 |
| [real-source](real-source/training-selection-summary.json) | 67 / 6 / 27 | 9 | 57,746 | 17.23582586% | 10,000 / 20% | 0 |
| [generated-v1](generated-v1/training-selection-summary.json) | 43 / 7 / 11 | 3 | 54,117 | 11.58231240% | 10,000 / 20% | 0 |

[index.json](index.json) binds every preserved archive to its original API
digest, checked-out revisions, exact member inventory, and source dispositions.
Pending rows mean this preservation task is still awaiting a successful lane's
complete artifact; they do not represent a passed or failed qualification.

These archives contain source/native qualification, prepared training data,
release bundles, refusals, and engineering evaluation. Their native receipts
report zero optimizer steps. Controlled engineering fixtures remain engineering
evidence, not learned model execution or generalization. The separately retained
optimization and learning experiment receipts keep their own actual historical
producer and consumer identities.
