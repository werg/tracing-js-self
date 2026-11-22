# Compose the published native source-identity check without losing prior controls

Published source change
[`c253a1e7770ee569d1b2022efadb471a1cc98da2`](https://github.com/werg/megatoken/commit/c253a1e7770ee569d1b2022efadb471a1cc98da2)
requires each release source descriptor to state its expected `sourceId`.
The value must be nonempty and unique and must equal the supplied artifact's
dataset-binding identity before fresh source verification or preparation.
The native reader preserves that expected identity instead of replacing it
with whichever identity the artifact supplied. A case label can still differ
from a legitimate digest-suffixed physical source ID.

All three parent blobs of that published patch exactly matched our existing
release verifier, documentation and tests. The patch was therefore applied
alone, on top of the composed native pair and its separate formatting fix.
Local result `a8cf158882913fcf920f71b4f1efa85270d13e41`, tree
`8698f34329ae2827aff090c05bdfdc2941974d10`, records the original commit in
its cherry-pick provenance. Its parent is formatting-only
`38305a3c1dff10a860e11a102bd9c3b2909104ea`. No older branch tree was merged.

`composition-map.json` records the matching parent and resulting blobs. The
three resulting files are byte-identical to the published source change.
The audit retains all 18 existing test functions, all their parameter
decorators and all 27 original bare assertions. The original 62 cases remain;
seven added cases check missing, empty, non-string, duplicate and extra source
identity fields, early mismatch refusal with unchanged inputs, and a distinct
case label with a digest-suffixed identity.

## Actual local result

The whole affected verifier module passed **69 tests with zero failures,
errors or skips**, in **14.18 seconds**, on Python 3.12.14, Torch 2.10.0+cpu and
pytest 8.4.2. Complete output and JUnit are retained. Ruff 0.17.6 checks and
formatting passed over all 626 Python files, and the shell syntax check passed.
The first local lint invocation had a log-path typo before the formatter ran;
the partial output and exact explanation are retained, followed by the
successful complete required command. Test-generated temporary outputs were
moved out of the worktree after the run; tracked sources remain clean.

One existing test in this module performs **one actual controlled optimizer
update** and compares checkpoint/exported tensors. Its source receipt and byte
codec are injected fixture controls. The seven new identity checks perform no
optimizer updates. This result does not claim a production-tokenizer fit,
fresh source campaign, complete installed release round trip, or learned
quality. The producer must still bind descriptor source identities to their
frozen original tasks, source, arguments, family and ancestry.

## Preserve historical proof scope

Original evidence
[`200da926eef6c90670e5837797c1e72028912741`](https://github.com/werg/megatoken/commit/200da926eef6c90670e5837797c1e72028912741)
retains the published patch's original red/green result, including the earlier
read-only membership review. That historical 69-case run used pytest 9.2.0,
outside the repository's declared `<9` range; it remains its original result.
This composed run independently passes with the locked pytest 8.4.2. The
historical identity calculation and controlled refusal did not perform fresh
source replay or whole-release qualification, and are not relabeled here.

The old combined run `45045811229` remains on its original `7c20124f` producer
and `ddda9a73` native pair. This semantic source-identity increment and its
matching producer descriptor change require the corrected exact pair's own
hosted gate. The separate formatting packet retains the earlier native CI
failure in full.
