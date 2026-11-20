# Superseded v8 qualification attempts

This package preserves the exact interrupted producer
`3a1992b4462e8e2affa6baa04e9075ba3b01d04a` / consumer
`418385b6880077b58bb5ae8f7ffeb7353a108d5d` run and the other superseded attempts.
Later shared protocol paths and iterable-destructuring frontend changes required
an independently executed complete final pair. The coordinator stopped this
older run with exit code 130 to prioritize that final qualification.

## Recorded 3a1992b results

| Population | Declared | Source qualified | Native admitted | Exact flat-token measurements | Remaining |
| --- | ---: | ---: | ---: | ---: | ---: |
| Interoperability | 23 | 23 | 23 | 23 | 0 |
| Original gallery | 11 | 11 | 11 | 11 | 0 |
| Expansion prefix | 665 | 594 | 594 | 0 | 71 untested or uncommitted |

There were zero recorded native failures in the 594 committed expansion
attempts. This is not a complete expansion pass. The remaining 71 case IDs are
listed in [superseded.json](superseded.json); any in-flight source artifacts do
not increase the committed count. No further expansion-cost, reference,
comparison or dataset stages were run after interruption.

The completed interoperability/gallery reports and exact physical costs remain
valid only at their recorded original pair. All source/admitted artifacts,
native receipts, token arrays, masks, progress journals and exact inputs are
retained in `original-3a1992b.tar.xz`. Native transport bytes for the 594 committed
prefix cases were reconstructed from the retained source artifacts and checked
against every live source-recheck receipt SHA-256. This integrity reconstruction
is not a new admission run.

The original [run.json](run.json) is unchanged, including its last in-progress
state. [superseded.json](superseded.json) explicitly records the termination,
replacement pair, completed counts, untested inventory and hash of that original
receipt. No historical command status was silently rewritten as a pass.

## Other preserved attempts

| Attempt | Exact scope and disposition |
| --- | --- |
| `f2fc630` startup | Failed during preflight because a dependency symlink appeared as an untracked source-tree entry; no population pass is claimed. |
| `f2fc630` / `7b36617` | Ten committed interoperability admissions before interruption when abrupt Number changes arrived; the remaining declared cases were not completed. |
| `62eb943` / `e52a135` | Twelve committed expansion admissions before interruption when the substantive native intrinsic-property guard change arrived; 653 cases were untested or uncommitted. |
| Custom iterators at `653fd1b` / `a393a1c` | Fourteen positive source/native/token admissions completed; the fifteenth source case verified but native admission exceeded its 120-second deadline. The final positive case and four declared source refusals did not run. |

The custom-iterator timeout occurred on `continue-outer-closes-inner-only`.
Its exact source result/artifact and exception are retained with all 14 completed
receipts and costs. No semantic pass is inferred for the timed-out native call,
and no unexecuted refusal is claimed. A later current-pair rerun uses its own
explicit bound and receipts; it does not replace this failed attempt.

## Retention and integrity

[archive.json](archive.json) binds every compressed archive and all uncompressed
members by byte length and SHA-256. Every member was rechecked after
decompression. The retained packaging helper and native-input reconstruction
helper reproduce those integrity checks. `SHA256SUMS` covers the complete
package. Integrity verification does not perform fresh native admission.

All completed and partial results remain attached to their exact source and
consumer commits. They are excluded from every final-pair population and dataset
denominator. The previously retained complete `b66c19b` qualification remains a
separate historical full run; this partial attempt does not overwrite it.
