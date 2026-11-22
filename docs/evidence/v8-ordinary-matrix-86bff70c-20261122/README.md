# Historical ordinary matrix failure at 86bff70c

The complete original logs for run
<https://github.com/werg/tracing-js-self/actions/runs/45045101499> are preserved
here, with metadata, SHA-256/byte counts, and all nine failure names and original
source locations. This run tested producer
`86bff70c3b333ac307922e440647ad6b17926677`; it is not evidence for a later candidate.

| Node lane | Job | Original outcome | Node-reported total / pass / fail / skip |
| --- | --- | --- | --- |
| 20 | 137278424819 | failure | 3041 / 2948 / 9 / 84 |
| 22 | 137278424908 | failure | 3041 / 2948 / 9 / 84 |
| 24 | 137278424576 | failure | 3041 / 2948 / 9 / 84 |

These are the runner's reported counts, not a separately counted leaf census.
All three lanes failed the same nine test cases. The subsequent contract,
source-interoperability, fixture, demo, and replay steps were skipped after
`npm test` failed. No all-green matrix or zero-skip claim follows from this run.

Three installed-consumer cases stopped at the then-stale population count.
Two Promise join source expectations, three qualification population counts,
and one forwarding-queue error expectation account for the other six failures.
The raw failures remain preserved even when later source changes repair those
expectations. Later candidate tests must be assessed against their own exact
source and observed results.
