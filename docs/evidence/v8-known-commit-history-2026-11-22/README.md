# Known coordinator commit recovery investigation

## First exact hosted attempt: retained failure

Producer `3ae10e3bc0c05d8b17419ce35d62c3fffe3f036c`, native `0066888f733c0d27d7ac7c0e92dc390231575f2e`: [run 45017718366 / job 137193533073](https://github.com/werg/tracing-js-self/actions/runs/45017718366/job/137193533073).

The mandatory Linux clock identity was available. All 62 leaf testcases ran with zero skips: 60 passed and two failed. Both real lost-join/progress reply cases passed, including a second process loss after the new history seal, cumulative accounting, original-prefix reexecution and full continuation. The two failures were test-observation races: the stale-head and expired-clock refusals returned before the replacement peer initialized its decoder log, and the test then tried to read a nonexistent file. The original `ENOENT` failures are retained unchanged; this attempt is not a passed qualification.

The follow-up creates each empty decoder observation file before starting its peer and additionally asserts zero native RPCs in the wrong-scope, stale-head and expired-clock cases. It changes no recovery implementation or authority check. The strict workflow denominator is corrected from the earlier inferred 55 to the actual 62 leaf cases: the existing eight malformed-cost subtests replace their single parent in the XML count. Parents are not additional cases. A fresh complete zero-skip hosted pass remains required.

`first-failure.log.gz` retains the entire original job log after decompression. `first-failure.xml` contains the unchanged JUnit payload extracted by removing the job-log timestamp prefixes.
