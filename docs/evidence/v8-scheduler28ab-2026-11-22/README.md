# First async module DAG state probe

Exact producer `28ab980abd5f1e4abcc2374a578284a3cbb9180f` / native
`d1d369b3ff1a7e851d2f0adad5a4f9d7d7f5d076`.
[Run 45005330514](https://github.com/werg/tracing-js-self/actions/runs/45005330514).

The Node manifest completed in about 215 seconds: **27 passed / 5 failed**.
Every failing state/source comparison refused at plan construction because
actual linker dependency metadata contains source file strings, while the
prototype assumed internal generated numeric indices. The corrected builders
now validate exact file identities. Native fixture edges and the cycle refusal
fixture use the same actual metadata shape. Python formatting was also corrected.

This failed run is retained in full. The existing owned scheduler and original
ESM controls do not by themselves admit public module scheduling. Exact source
event ownership, public records and native artifact replay remain separate work.
