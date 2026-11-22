# Complete installed V8 qualification

`tools/qualify-installed-v8.mjs` measures the actual npm package produced from a
clean committed repository. Its source/public checks run in an installed
application using only `tracing-js-self/semantic/v8`. The historical selected
clients are physically removed before any case executes. No native consumer is
configured; this report cannot establish native admission, model quality or a
default cutover.

## Package and dependency authority

The tool materializes **all tracked files from `git archive HEAD`** before
running `npm pack`. This includes files omitted by a sparse checkout. It does
not construct a curated runtime-only staging directory. Normal npm packaging
rules still determine the actual publishable archive; the full npm pack
manifest is retained alongside the exact tarball, package hash, Git revision,
tree identity and complete tracked-file list.

Production dependencies come from the exact `resolved` URLs in
`npm-shrinkwrap.json`. By default, `npm pack <locked-url> --offline
--ignore-scripts` retrieves the tarball directly from npm's offline cache; it
does not resolve `<name>@<version>` through registry package metadata. A
separate `--dependency-archives DIRECTORY` may supply files named like
`acorn-8.15.0.tgz`. Each URL must be canonical HTTP(S) without credentials or
fragments, and every archive must match the lock's SRI; rearchiving arbitrary
installed bytes is not an integrity substitute. The app installs these
archives offline with scripts disabled and an initially empty install cache.
Its dependency files are then compared with the verified archive contents.

Evidence records the publishable lock hash, application lock hash, archive
hashes, dependency file inventories, complete package file inventories before
and after legacy removal, and the exact removed files. A separate small public
source control checks that the installation works. Changing or removing its
packaged lock must invalidate fresh source rechecking before a native consumer
could be called. These controls are separate from the language population.

## Populations and source evidence

The default `both` population retains two independently counted inventories:

| Population | Scripts | Original module graphs | Total |
| --- | ---: | ---: | ---: |
| `all` | 663 | 2 | 665 |
| `interoperability` | 63 | 3 | 66 |

Every input is retained in `population.json` using canonical graph transport,
including cycles, aliases, sparse arrays, null prototypes, special numbers and
BigInt. Diagnostic `--cases` selections change which rows execute; they never
remove unselected inputs from the denominator. Each input has its own digest
and compressed result artifact. Sources that refuse or fail retain their actual
status, reason and available evidence. They are not rewritten into successful
package qualification.

The installed worker verifies scripts through `verifyRegionTrainingCase` and
original module graphs through `verifyRegionModuleTrainingCase`. The 27 utility
inputs with separately retained original source also receive fresh comparisons
through the public `independentSourceReferenceV8` entry before projection.
Original and transformed reference observations are kept with the result.
Any declared upstream canonical expectation is also checked independently,
including exact BigInt bindings and error-completion semantics. A matching
original/transformed pair cannot bypass a contradictory canonical expectation.

Every exported artifact is freshly source-rechecked and publicly replayed. The
worker restores a terminal JSON checkpoint, compares complete shared state,
then restores an earlier generated-prefix checkpoint and finishes from the
remaining public records. Source certificates describe the installed
implementation after legacy removal. Checkout receipts are never substituted.

## Running and inspecting

The output directory must be outside the repository. Complete extraction and
installation need enough disk for the full repository and package; changing
`--cases` bounds execution work, not package contents.

```bash
npm ci --ignore-scripts --no-audit --no-fund
node tools/qualify-installed-v8.mjs --out /tmp/installed-v8 \
  --population both --workers 4
```

A bounded diagnostic retains all 731 declared rows while executing three
selected inputs and the independent installation control:

```bash
node tools/qualify-installed-v8.mjs --out /tmp/installed-v8-smoke \
  --cases interoperability:key-getter,interoperability:return-callback-receiver-alias,interoperability:module-scoped-var-isolation
```

`--worker-timeout-ms`, `--worker-memory-mb` and `--worker-output-bytes` bound each
isolated process. A timeout or worker failure remains a counted disposition.
`--resume` requires the same committed revision, selection, bounds and exact
installed/package/dependency bytes. A locked hash-linked journal commits each
case only after its compressed evidence has been written. Changed evidence is
rejected, including source result files that otherwise contain valid JSON.

Inspect `report.json` for separate declared, attempted, qualified, unqualified
and untested counts. `coverageComplete` means all declared inputs were attempted;
`sourcePopulationQualified` additionally requires every row to pass source and
public checks. Neither field means native admission. The command fails for
installation/control problems, worker or installed-validation failures, and
**any selected input that fails source/public qualification**, whether it belongs
to the original 665 or the selected 66. A refusal is retained as evidence and
fails the selected population gate; it cannot make an installation regression
green. Diagnostic unselected rows remain explicitly untested.

`package-installation.json`, `package-controls.json`, `population.json`,
`attempts.jsonl`, `cases/*.json.gz`, `archives/*` and the journal contain the
reviewable evidence. The retained `.work/application` is required for resuming
the same installation; it is not a second qualification artifact.

Local tooling tests exercise full Git packaging with a small committed fixture
repository, including a sparse file outside the older curated asset list,
verified dependency archives, suppressed install scripts and dependency
tampering. Separate bounded worker controls use actual source, callback and
module APIs. These tests are not a completed full-package 665/66 measurement;
that claim requires the corresponding generated report and all retained rows.
