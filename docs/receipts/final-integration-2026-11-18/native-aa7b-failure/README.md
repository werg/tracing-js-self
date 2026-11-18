# Hosted registry persistence regression at aa7b843

[Native workflow 44317350987](https://github.com/werg/tracing-js-self/actions/runs/44317350987)
was triggered for PR head `aa7b8432761df110df53fc95664b7d767b2eeba0`.
All five job logs confirm actual producer checkout
`3850539e1038f3cd19c19c446403444b96281797`, GitHub's synthetic merge of that
head into base `2aa694be86a6cda3b9d63fde739957d08f568961`. The explicitly pinned
consumer checkout was `6b4382b9af3bef120ca3a95ae24d35154d4cd66b`. All five recipe lanes reached the
source/native generation step and failed while persisting a registry-bound
candidate. The native environment setup passed in every lane. The engineering
lane's merged learning tests and all 17 native capability probes passed before
collection hit this separate integration defect.

| Recipe | Job | Result |
| --- | ---: | --- |
| engineering | 134846879903 | Candidate persistence failed; subsequent artifact ZIP also failed while a temporary receipt disappeared |
| generated-v1 | 134846880630 | Candidate persistence failed; upload reported disappearing temporary-file warnings |
| training-v4 | 134846880668 | Candidate persistence failed; upload reported disappearing temporary-file warnings |
| benchmark-v1 | 134846880725 | Candidate persistence failed; upload reported disappearing temporary-file warnings |
| real-source | 134846880770 | Candidate persistence failed |

Every original job log reports `Campaign candidate must encode non-JSON values
before storage` at `CampaignStore.record`, called by the generation coordinator.
The first compact receipt used the triggering head as the producer label; the
checkout fields now distinguish those identities using each original log's
`git log -1 --format=%H` output. No original log bytes changed.

The full log files here are the exact UTF-8 encoding of GitHub's decoded log
responses, including their original timestamps. [index.json](index.json) binds
all five complete logs and the [job/step metadata](jobs.json). This receipt does
not label skipped preparation or release steps successful.

## Diagnosed cause

The source registry contains component membership arrays. `frozenSplitIdentity`
also exposes the same array as `splitIdentity.members`, while retaining the
registry itself. The candidate identity encoder tracks shared object
references, but plain JSON serialization duplicates those metadata references.
Consequently the pre-storage identity and the JSON-roundtrip identity differ
even when every leaf is valid JSON and no `undefined` value exists. Sessions
can additionally share a split identity across several cases.

A minimal reproduction using the actual registry builder confirms that
`splitIdentity.members === registry.components[0].members` is true before
serialization and false after it. This is metadata reference topology, not a
change to the guest's argument graph. A correction must preserve the encoded
guest aliases and special values while giving persistable metadata a stable
structural identity. Dropping the integrity check or silently deleting values
would not be a valid fix.

The early rejected `Promise.all` also let sibling generation workers continue
touching temporary `.native` files while the next CI step uploaded the corpus.
Shutdown must abort and drain those workers before failure is returned. The
observed ZIP error and warnings are retained as consequences of this lifetime
defect, not attributed to an unexplained GitHub outage.

The corrective commit and its subsequent successful qualification belong in
the [handover](../../../RESUMPTION_HANDOVER_2026-11-18.md) as new evidence. This
failed workflow and the independently successful local/probe receipts retain
their original producing identities and outcomes.

## Original downloadable failure artifacts

The run-artifacts API returned exactly four available ZIPs. Each was downloaded
and verified against GitHub's advertised byte size and SHA-256; every ZIP member
passed its CRC check. [artifacts.json](artifacts.json) retains the original
public metadata. Temporary signed download URLs and private file-service IDs
are excluded.

| Recipe | Original ZIP bytes | SHA-256 |
| --- | ---: | --- |
| real-source | 1,759,963 | `e5ef855876bdff06c825c4ce6fd8c906b2b86ae40dbff172da5ca07738ad91cc` |
| benchmark-v1 | 1,092,572 | `33e608f9cc86673be52d8e16b0a38eeb4db5646dda92c10ed5a335a5b9bd88d6` |
| generated-v1 | 1,090,915 | `654ec32827447c19a1bef9a488dcf7c7dce146f041cda20a8b53b25bf2a2ad6b` |
| training-v4 | 2,448,467 | `9ed2e174f4d0faa99f1fd9c54c5e0e92ec3a5734ad874cf1c3f72f2e6d5008f8` |

The engineering upload failed before an artifact was published. Its complete
original log is retained, but there is no fifth ZIP to download or reconstruct
as original evidence. A later successful rerun is a new measurement.

The unchanged four ZIPs, all five complete logs and the receipt snapshot are
bundled in `native-aa7b-failure-evidence-2026-11-18.tar.gz`: **6,455,182 bytes**,
SHA-256 `b14dfcc222940f316db9933a1003daa4bd0542adbb280fe7fc7e95378d5d3b02`.
The [verification receipt](private-archive-receipt.json) records 14 archive
members: 13 individually checksummed payload files (6,713,814 bytes) and the
embedded [archive index](private-archive-index.json). Every archived member was
read back and checked. These are partial failed-campaign artifacts, not
completed corpora or qualified releases. The archive's embedded receipt files
are the unchanged snapshot taken when it was built; later documentation adds
new evidence without rewriting that snapshot.
