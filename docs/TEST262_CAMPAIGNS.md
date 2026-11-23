# Current Test262 campaigns

The original-source runner acquires the complete `test/` and `harness/` Git tree
from the selected local Test262 checkout. Its default revision is that checkout's
actual `HEAD`; updating the checkout grows the next campaign automatically. No
repository snapshot, annual ECMAScript edition, test count or success list caps
the current inventory. The parser uses Acorn's `latest` grammar and records the
installed parser version and content, actual Node/V8 versions, execution settings
and implementation files. Unsupported language and host behavior stays visible.

## Run and retain an observation

```sh
node tools/run-test262-campaign.mjs \
  --suite-root ../test262 \
  --out corpus/out/test262/current.json.gz
```

The default selection is every discovered variant. `--paths`, `--cases` and an
explicit `--limit` are optional workload selections; unselected variants stay in
the report. The default stages are `parse,owned,reference`. Use `--stages parse`
for a parse inventory or `--stages parse,reference` for a native diagnostic run.

Each file is checked against the acquired Git blob before execution. Tests keep
their original text and declared strict, sloppy, raw or module mode. Strict
source adaptation preserves hashbang placement. Original harness files load in
metadata order, and static module dependencies retain their content identities.

Reports embed the acquired catalog, exact source and harness Git/SHA-256
identities, profile, implementation revision and file hashes, resource policy,
worker commands and relevant environment settings. Source bodies can be retained
beside the report from the exact observed commit:

```sh
git -C ../test262 archive --format=tar.gz HEAD test harness LICENSE \
  > corpus/out/test262/source-inputs.tar.gz
```

Run this before updating the checkout; use the report's
`baseCatalog.suiteRevision` instead of `HEAD` to archive a prior observation.
The CI workflows retain this source archive together with the report. A report
by itself records content identities but does not embed every source body.

The catalog builder also accepts the current checkout directly:

```sh
node tools/catalog-test262.mjs --suite-root ../test262 \
  --out corpus/out/test262/catalog.json.gz
```

Use `--revision COMMIT` to require an exact already selected checkout commit.
An explicitly supplied `--snapshot FILE` remains useful for examining retained
inputs; there is no default historical snapshot. Optional
`--specification-file FILE --specification-uri URL` records the actual supplied
specification bytes and their source, without turning them into a fixed target
or claiming that edition membership is certified.

## Shard by source, resume without changing the observation

```sh
node tools/run-test262-campaign.mjs \
  --suite-root ../test262 --stages parse,owned,reference \
  --shard-index 0 --shard-count 8 \
  --out corpus/out/test262/part-0.json.gz
```

Shards hash the original source path. Strict and sloppy variants of one source
stay together; adding another file does not move existing paths between shards.
Every shard retains the full acquired population and its own selected IDs.
`--limit`, if supplied, applies before sharding; it is never an implicit ceiling.

`SIGINT` and `SIGTERM` stop dispatching new workers, cancel active workers and
write an atomic checkpoint. Completed attempts remain recorded. Workers killed
before returning a result are `interrupted`, with `executionPerformed: null`
when execution may have begun. Cases that were never dispatched stay `not_run`.
The exit code is 130 for `SIGINT` or 143 for `SIGTERM`.

Repeat the same command with `--resume REPORT` to run unfinished stages:

```sh
node tools/run-test262-campaign.mjs \
  --suite-root ../test262 --stages parse,owned,reference \
  --shard-index 0 --shard-count 8 \
  --resume corpus/out/test262/part-0.json.gz \
  --out corpus/out/test262/part-0.json.gz
```

The original source revision, contents, parser/runtime/implementation identity,
selection, shard assignment and resource policy must match. Resume does not copy
successful stages onto changed code or sources. Start a new report after an
implementation or input update; the earlier report remains an observation of its
recorded run. Explicit `--retry failed,resource_limited` can repeat those outcomes
within the same observation, retaining every earlier attempt and invalidating
any dependent stages. Interrupted attempts are retried automatically.

```sh
node tools/run-test262-campaign.mjs --check corpus/out/test262/part-0.json.gz
```

`--check` verifies report integrity and the recorded implementation against the
current files. The library's `validateOriginalTest262Report(report)` can inspect
historical report integrity without claiming that the currently installed code
produced that historical observation.

## Merge shard observations without dropping missing inputs

Keep each shard's report named `report.json.gz` in its own directory and merge
against the acquired catalog:

```sh
node tools/merge-test262-campaigns.mjs \
  --catalog corpus/out/test262/catalog.json.gz \
  --directory corpus/out/test262/parts --shard-count 8 \
  --out corpus/out/test262/summary.json.gz
```

The merger checks the exact population, expected source-path shard assignment,
implementation, runtime, policy and attempt history. Duplicate parts, partial
selections presented as complete shards, changed inputs and mixed policies are
rejected before any part contributes results. It processes one complete report
at a time and retains a digest of each input artifact.

Missing shard reports produce an explicit list of missing source variants;
their stages count as `not_run`. A report for every shard sets
`allShardsPresent`, while `requestedWorkFinished` also requires that the requested
stages contain no unrun or interrupted work. Guest errors and resource limits
remain separate terminal outcomes. Neither flag establishes language conformance,
native trace admission or data eligibility.

The current inventory workflow acquires and parses the moving upstream tree.
The manually dispatched native sweep acquires one actual revision for all its
shards, records the container image and toolchain, retains original inputs, and
uses the same campaign and merger. Its operator-selected 16 shards divide work;
they do not cap the source population. The former frozen edition workflow has
been retired; historical evidence remains unchanged.

## Evidence boundaries and remaining work

Parsing, owned execution, reference execution, source correspondence, independent
native trace checking, restoration, data export, training and serving are separate
ledger stages. A native V8 reference result is diagnostic evidence; it does not
establish independent native validation of an owned trace or data admission.
Only stages actually run can pass. Worker failures, guest failures, unsupported
features, unavailable environments, resource exhaustion, interruption and unrun
cases remain distinct.

Async success requires exactly one call to the original `doneprintHandle.js`
`$DONE` function and completion output produced during that call. Replacing
`$DONE`, directly printing a success token, suppressing genuine output and then
forging it, or hiding duplicate calls cannot produce a pass. Retained aliases of
the original function work. The reference monitor delegates to the original
function; the owned monitor uses recorded frame ancestry at the print event.
Both monitors also retain truthy error arguments and abrupt exits from the
original call. A replaced print handle cannot turn `$DONE(error)` into success,
and catching a getter or printer exception cannot erase a failed completion.
Raw plus async remains an explicit unresolved metadata combination because raw
forbids harness evaluation while async requires the original completion harness.

The current runners still have language and host gaps, including fresh guest
realms, dynamic code, agents and parts of module/async behavior. Distinct early
error classification remains unsupported. A catalog or successful reference run
does not qualify those gaps. Current campaign execution does not yet implement
all downstream admission, preparation, training and serving stages; those rows
stay unrun or blocked. Abrupt process loss can discard work since the last atomic
checkpoint, but resume never treats missing observations as successful ones.
