# Full pinned Test262 edition audit evidence

The final hosted audit is [GitHub Actions run 45011367784](https://github.com/werg/tracing-js-self/actions/runs/45011367784)
at clean producer revision `d1b35fa850b8ef72b5eb664755cbf76233b05cc0`. It
checked Test262 commit `d53ebc8b1931d9f1541e43d59650776e4b766248` against the
retained ECMA-262 17th edition HTML: 8,348,904 bytes, SHA-256
`5df49e088c2b5c7a3dfd4a330414b92897fb4535cb62fc5936cad101a6c2304a`.

## Frozen denominator and audit output

| Measure | Count |
| --- | ---: |
| Acquired Test262 files | 53,974 |
| Original test source files | 53,616 |
| Strict/sloppy/raw/module variants | 102,994 |
| Sloppy / strict / raw / module variants | 52,065 / 50,056 / 30 / 843 |
| Normal / negative expected outcomes | 94,235 / 8,759 |
| Parse / runtime / resolution negatives | 8,659 / 66 / 34 |
| Exact resolved anchors / absent anchors / missing `esid` | 58,589 / 23,474 / 20,931 |
| Annex B / core-or-extension / separate ECMA-402 scope-review rows | 1,377 / 94,853 / 6,764 |
| Edition membership unclassified | 102,994 variants / 53,616 source files |
| Required for this release | 0 variants |
| Test execution in catalog command | 0 |

Catalog digest: `87554d6d1c4f5f2fa1f4108501148a0b6adfd2fab357383594ea3ea60aca5045`.
Final audit digest: `e4538babc0ec161e1774cadfc6e53e3b2ccbcdaefbc1ba9edcaf3bd431bcec96`.
The report explicitly leaves `editionMembershipCertified`,
`applicabilityCertified`, and `conformance` false. Reference and scope counts
are review evidence only. No row was removed or reclassified from an anchor,
path, feature tag, or execution result.

## Files

The compressed bare catalog (`test262-catalog.json.xz`) and full audit report
(`test262-edition-audit.json.xz`) are stored directly in this directory with
the catalog/audit logs, exact denominator check, toolchain and npm logs.
`SHA256SUMS` verifies these seven files. `job-run-45011367784.log` is the
complete decoded GitHub Actions job log. The four `failed-run-*.log` files
preserve the full logs for earlier implementation attempts. `SHA256SUMS.external`
also verifies the reports, full job logs, failure logs, and this README.

The original complete GitHub Actions artifact, including the catalog-run
wrapper, remains available as [artifact 14750355381](https://github.com/werg/tracing-js-self/actions/runs/45011367784/artifacts/14750355381)
through 20 February 2027. Its original 36,114,407-byte ZIP SHA-256 is
`b1120a4da1a9227c7c1f93449f3da12b0a345fa0da1a564c3787459fd1cc631a`.

## Failed attempts retained

| Run | Producer revision | Failure and correction |
| --- | --- | --- |
| [45010232509](https://github.com/werg/tracing-js-self/actions/runs/45010232509) | `9bd1f96e450cf57542a2fd1285e4ae0828ec5937` | The workflow addressed the sibling Test262 checkout as `producer/test262`; changed the suite path to `../test262`. |
| [45010347326](https://github.com/werg/tracing-js-self/actions/runs/45010347326) | `dae7e40ed6adfa4e09b7af55b0aef8bc9a0286a8` | The full compressed catalog expanded beyond the audit CLI's 256 MiB child-process buffer; raised the limit to 1 GiB. |
| [45010424190](https://github.com/werg/tracing-js-self/actions/runs/45010424190) | `4054538e8106f4d256e48f39ae302479181f14d4` | Same 256 MiB decompression limit; retained as a failed attempt. |
| [45010759064](https://github.com/werg/tracing-js-self/actions/runs/45010759064) | `8562208b9661e00e229203b26cbc0763ca015bbe` | The catalog command outputs a `{catalog,campaign,summary}` wrapper while the audit CLI requires the bare catalog; extracted and retained both. |

The final run additionally binds both reports to the exact clean producer
revision and verifies the retained specification URI and digest. Its repository
changes are documented in `docs/TEST262_EDITION_RECONCILIATION.md` and
`docs/V6_TO_V8_PRODUCTION_ROUTE_MATRIX.md`. The latter is explicitly a partial
four-category route inventory; acceptance package 1 remains open.
