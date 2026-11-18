# Hosted registry persistence regression at aa7b843

[Native workflow 44317350987](https://github.com/werg/tracing-js-self/actions/runs/44317350987)
failed at exact producer `aa7b8432761df110df53fc95664b7d767b2eeba0` and consumer
`6b4382b9af3bef120ca3a95ae24d35154d4cd66b`. All five recipe lanes reached the
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
