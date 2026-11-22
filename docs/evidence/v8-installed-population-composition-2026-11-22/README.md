# Installed V8 population composition correction

The composed producer added three original Promise-adoption protocol sources,
but the installed qualification driver, its test, and its workflow still required
66 total interoperability inputs. The actual current population is 69: 66 scripts
and three original module graphs. The separate original population remains 665:
663 scripts and two original module graphs. These populations may overlap and
their 734 rows are not 734 distinct programs or training exposures.

The original failure is retained in `original-hosted-job.log` from
[run 45045726764](https://github.com/werg/tracing-js-self/actions/runs/45045726764),
job `137279808325`, producer `99be4d64842e1eed09ba21543f696320cd1b3245`.
It failed in inventory construction before package installation or guest source
execution. This failure did not demonstrate a runtime semantic mismatch.

The same unchanged guard failed on the later composed producer
`7c20124f3d89dfe1a8d5e892238e7b7f92589720` in
[run 45045817948](https://github.com/werg/tracing-js-self/actions/runs/45045817948),
job `137280068568`. Its complete original log is separately preserved as
`final-pair-7c-original-hosted-job.log`. Both failures precede the accounting
correction; neither is silently replaced by a passing smaller selection.

Local source correction `71466c0da708e32bfa1ae476bde5d2c874df11c5`, based on
the final-pair composition at `296e0116`, updates those three accounting sites
without changing the fixtures or runtime implementation. The test explicitly
requires these three composed sources to remain selected exactly once:

- `source-promise-adoption-executor`
- `source-promise-adoption-async-return`
- `source-promise-adoption-reaction-return`

The protocol composition comparison in `proof.json` confirms that the 20 earlier
protocol fixtures are unchanged, none were removed, and exactly those three
fixtures were added. All five original module graphs across both populations
remain present. Future unreviewed population changes still fail the declared
count guard.

## Controls and scope

Command: `node --test --test-reporter=tap test/semantic-installed-qualification-v8.test.js`.
Node was `v24.22.3`.

| Observation | Passed | Failed | Skipped |
| --- | ---: | ---: | ---: |
| Unmodified composed source, `before-node.log` | 6 | 3 | 0 |
| Corrected source, `after-node.log` | 9 | 0 | 0 |

The corrected public worker control executes and rechecks source, callback,
module and all three Promise-adoption inputs, then continues their checkpoints.
Other controls retain callback-owned join ordering, original-source and canonical
result disagreements, explicit refused-input accounting, and a separate fixture
package that checks complete sparse Git staging, exact locked offline dependency
archives, disabled install scripts, and dependency tamper refusal.

These bounded controls do not substitute for the complete actual installed
package campaign over all 665 + 69 rows. That campaign must run on the final
published producer and retain its own source revision, package bytes, per-case
dispositions and lock tamper controls. Native consumer admission, optimizer
exposure and learned-model behavior remain outside this installed source gate.

`proof.json` preserves the exact byte counts and SHA-256 hashes of all four
unmodified logs. The historical 665/66 installed successes remain true of their
recorded older source and population; they are not relabeled as current 665/69
qualification.
