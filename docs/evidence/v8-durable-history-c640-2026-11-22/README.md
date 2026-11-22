# Explicit durable composite history: hosted controls

Exact producer: `c640f2b1dfed112d5e2bc5f60195234a40c3dec1`.
Hosted run: https://github.com/werg/tracing-js-self/actions/runs/44986959001
Exact job: https://github.com/werg/tracing-js-self/actions/runs/44986959001/job/137099515250

The focused continuation selection passed **98 tests, zero failures and zero
skips**. It includes existing source-session/module/history controls and the new
composite durable journal, sparse latest-cut restoration, failed acknowledgement,
caller-alias mutation and live-clock checks. These 98 are one combined selection;
the new tests are included and must not be added again.

`focused-98.log` preserves the complete job log and JUnit output. The control
uses real durable filesystem storage and fresh JSONL protocol fixture processes.
It does not establish learned model success or replace the mandatory real Python
native checkpoint/recovery and full-population gates. Those gates retain their
own exact code revisions. The tested implementation supports explicit quiescent
cuts; automatic in-flight fencing and terminal recovery are separate work.

Review identified an additional automatic-persistence requirement: an
independently acknowledged work-start marker must precede every dispatch. A
crash after child side effects but before its completion checkpoint cannot allow
restoration of the old child-ready cut as if no work had occurred. Unknown work
must remain fenced pending proof or supervisor reconciliation.
