# Completed ordinary Node test matrix

Exact producer `12d0b4b90d6de3a883271af762dcb58c9fdabca0` passed
[run 45019417849](https://github.com/werg/tracing-js-self/actions/runs/45019417849)
on Node 20, 22 and 24. Each version reports **2,742 tests: 2,715 passed,
zero failed, 27 skipped**. These are three executions of the same overlapping
population, not 8,226 independently covered cases. The skips remain explicit;
this ordinary matrix is not a zero-skip language qualification.

All three complete original logs are retained as gzip files, with raw and
compressed byte counts and SHA-256 digests in `qualification.json`. The
preceding evidence directory retains the failures that motivated the Node
module flag and staging fault-injection corrections and the 21 focused
zero-skip passes. Later module, recovery and conformance changes retain their
own exact source identities and need their own current CI results.
