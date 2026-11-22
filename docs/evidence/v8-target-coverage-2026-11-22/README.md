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


The next direct prepared-data probe caught an observation-only native step with
records and no loss plans. Native `9c68b14f5bc3e2329f0d3f21515fd3d7daa5ecc1`
skips those unscored steps while retaining exact pairing for every actual plan.
Its 21 inventory controls include the complete 64-source traversal with controlled
source/planner boundaries and actual census extraction.

Native `a1d7f83dc46e4829ca4226e4040519cd5835f365` additionally bounds reuse of
complete immutable source admission to eight entries per model. The full episode,
codec instance/fingerprint, policy/registry bytes, geometry and split are all part
of that identity. Window/model/loss state is rebuilt each time. Fifty-three local
controls passed with the actual pinned tokenizer and zero skips, including changed
source proof, physical bytes, policy, registry, geometry, split and codec instances.
The 48-source training split has 348 windows, and repeating identical complete
admission cost about 2.5 seconds per adjacent window in a direct measurement.

The separate coverage fit now writes its checkpoint at the final bounded step,
instead of serializing the entire model after every window. Its objective and every
optimizer update remain unchanged; the original two-step resume test still writes
both required checkpoints. Failed subprocess stages now include their bounded log
tail in the job output while preserving the complete stage log in the artifact.
