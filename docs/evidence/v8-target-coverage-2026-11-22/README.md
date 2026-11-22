# Exact64 support optimizer coverage: retained failure and corrected continuation

The first actual full-target campaign ran producer `0694fa9280712fa1364ead46a477c757a0ca4bfa`
and native `dbc89dcd52cb93d1d9fdca2989fab64b85e5d427`:
[run 45005718379, job 137156743990](https://github.com/werg/tracing-js-self/actions/runs/45005718379/job/137156743990).
Its complete job log is retained as `original-job45005718379.log.gz` (ordinary gzip,
UTF-8 log on decompression); its complete command report and failing stage log
are adjacent. GitHub retained 546 input/evidence files in artifact `14747074516`,
archive SHA-256 `aa58746ea26d49a67333f7e7812e1cad585c6fbc2d0093592d6fb39dc1c3f792`.

That campaign passed every one of the 64 original-source/native, production-tokenizer
and packing checks and prepared the frozen 48 training / 12 validation / 4 test split.
It failed in inventory before the first optimizer update. No full-target training
or lifecycle success is inferred from those preparation results.

The native planner used `episode.lineage.source_id`, which is a shared adapter name,
instead of the individual program ID in the checked semantic source annotation.
Native `bba8cb0569740e0d8260d913db4d883423bd3376` aligns the inventory with the actual
optimizer census's source/registry/split binding. Twenty inventory controls passed
locally with zero skips, including distinct source programs with the same adapter
lineage and refusals for substituted source, registry or split.

The corrected campaign is pinned to that exact native commit. It still requires
a fresh actual 64-source qualification, the ordinary two-update resume/export/restore
route, and a separate complete ordinary window pass whose checkpoint matches every
positive-weight logical/physical target, scored occurrence, window set and per-loss
denominator. Merely having every source in prepared input does not satisfy that gate.
Token/mask-position coverage and learned quality are independently unmeasured.
