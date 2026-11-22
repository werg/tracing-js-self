# Previous standalone scheduler qualification

The complete GitHub job log is retained without excerpting its failed or skipped
scopes. Run [45006241411](https://github.com/werg/tracing-js-self/actions/runs/45006241411),
job [137158364683](https://github.com/werg/tracing-js-self/actions/runs/45006241411/job/137158364683)
tested producer `0a2c535a63541c2b9b6319d550aae1f413104c86` and native
`263b7b9ec921fd43e3d97a8136dee1d1ab433b33`.

The recorded result is 32 original-ESM/owned/standalone/cross-language Node test
cases and 5 native state test cases, zero skips. It does not prove the later
source-ownership implementation or public/data admission. The later source
integration exposed missing distinctions for synchronous execution, settled
await operands, and caught rejection; their fixes require separate evidence.

The preceding 27/32 failure remains in `../v8-scheduler28ab-2026-11-22`.
