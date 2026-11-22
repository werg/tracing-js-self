# Carry verified physical source membership across the release boundary

The composed producer already compares each original task, source artifact,
registry member and recorded native claim, then rebuilds the release descriptor
from that snapshot at package and restore. The earlier absence of an explicit
native expected-source field is **not** a demonstrated bypass of those producer
checks. This change makes that expectation explicit at the standalone native
verifier boundary too.

Producer source `12969e5306e4a6ca4f5cfc9c9d6090269ca27c91` has exact tree
`5a14e3931e17021716a4a882f909f819760e90eb`, equal to tested local commit
`88689782f486409e44eec30916ee9c5e43646b2f`. It obtains `sourceId` only from
the verified `taskArtifactBinding.membership`, requires matching case ownership
and unique nonempty string physical IDs, and emits exact `caseId/sourceId/path`
rows. No fallback from the case label is allowed. An independently named
digest-suffixed physical source remains valid. Missing binding, malformed IDs
and duplicate physical membership refuse.

The paired native source is `74cb4c5117d554b40882a2bf415f1863fd1c32a7`,
based on main `ddda9a7339297e6074765a001743e2bb569e0eb9`; evidence-only head
`72ee95a302859fcbdca0cd556f65a8688f1a4308` retains its exact controls. Only
the descriptor validator, source membership check, their tests and documentation
changed. All other native runtime, Promise, recovery, relocation, ordering and
checkpoint/export functions remain unchanged. The complete comparison and
11-path source/evidence map are retained here, including the inventory of older
candidate evidence that was not part of that source integration.

## Measured results

| Population | Result | Scope |
| --- | --- | --- |
| Producer archive and source-membership methods | 19 passed; zero failures, errors or skips | Exact committed source, Python 3.12.14; zero source/native replay, model calls or optimizer updates |
| Native verifier and ordering cases | 69 passed; zero failures, errors or skips | Exact native source; one pre-existing controlled byte-codec fixture optimizer update; pytest 9.2 deviation explicitly retained |

The producer positive preserves independent case and physical IDs. The additional
producer controls refuse absent/unverified/cross-case membership, nonstring or
empty IDs, and two distinct labels/paths claiming one physical source. The native
controls independently require expected/artifact equality before preparation.
Neither controlled population claims an actual production-tokenizer package,
fresh original-source campaign, learned result or live-history restoration.

The final workflow now expects **88 Python cases** (19 producer and 69 native),
with zero skipped cases. This is a paired format change: the selected producer
must pin the new native implementation before actual qualification. The retained
source checkpoint itself precedes that final policy update and must not be used
as a claim of a qualified package on its inherited older native pin.

The producer command and its complete raw stdout/stderr are retained; the
command was `python -m unittest discover -s tools/native-consumer -p
test_release_v8.py -v`. Ruff passed for all changed Python files. The native
original logs and detailed runtime identity are in its evidence-only commit.
