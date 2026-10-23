# External JS/TS corpus acquisition (2026-10-23)

This directory keeps **original third-party source/test data** and a small,
reproducible acquisition layer, separate from the owned interpreter and its
existing 936-case utility / 912-case stateful baselines.

## What has actually been imported

The committed snapshots are genuine upstream, byte-for-byte Git blobs:

| Snapshot | Upstream repository | Pinned commit | Files |
| --- | --- | --- | ---: |
| `snapshots/test262` | tc39/test262 | `d53ebc8b1931d9f1541e43d59650776e4b766248` | 42 tests |
| `snapshots/exercism` | exercism/problem-specifications | `650bebeb39ad40439175288042aece982b0a90a9` | 24 canonical-data files |
| `snapshots/json-schema` | json-schema-org/JSON-Schema-Test-Suite | `89e83a74014617ffbe79a56d83d14d054cd11417` | 26 test-data files |

Each snapshot preserves the original LICENSE and a `snapshot.lock.json` of
Git *blob* SHA-1s. The importer verifies every consumed file against the
lock before writing a record. Each emitted record additionally carries a
SHA-256 of the original file bytes and the full pinned upstream revision.

The targeted Test262 slice is deliberately difficult: Proxy traps and
invariants, promise/thenable assimilation, Array.sort comparator/getter
effects, abrupt for-of completions, exception handling, and weak collections.
The JSON Schema data includes dynamic references, recursive and conditional
schemas, unevaluated properties/items and differing dialects. Exercism inputs
cover algorithms, search, parsers and stateful exercise contracts.

**Do not report these as executed or verified traces.** Test262 needs the full
harness; Exercism needs actual independently pinned JS/TS solution sources;
JSON Schema cases need real matching validator implementations. They are
acquired source/input/expectation fixtures only. Existing owned
`semantic-execution/2` and native V8 diagnostics retain their stronger,
separate evidence boundaries.

## Generate acquisition manifests

After `npm ci`, from repository root:

```sh
node tools/import-external-corpus.mjs \
  --format test262 --root corpus/extension/snapshots/test262 \
  --repository tc39/test262 --license BSD-3-Clause \
  --revision d53ebc8b1931d9f1541e43d59650776e4b766248 \
  --snapshot --lock corpus/extension/snapshots/test262/snapshot.lock.json \
  --output corpus/out/test262-fixtures.jsonl \
  --report corpus/out/test262-report.json

node tools/import-external-corpus.mjs \
  --format json-schema --root corpus/extension/snapshots/json-schema \
  --repository json-schema-org/JSON-Schema-Test-Suite --license MIT \
  --revision 89e83a74014617ffbe79a56d83d14d054cd11417 \
  --snapshot --lock corpus/extension/snapshots/json-schema/snapshot.lock.json \
  --output corpus/out/json-schema-fixtures.jsonl \
  --report corpus/out/json-schema-report.json

node tools/import-external-corpus.mjs \
  --format exercism --root corpus/extension/snapshots/exercism \
  --repository exercism/problem-specifications --license MIT \
  --revision 650bebeb39ad40439175288042aece982b0a90a9 \
  --snapshot --lock corpus/extension/snapshots/exercism/snapshot.lock.json \
  --output corpus/out/exercism-fixtures.jsonl \
  --report corpus/out/exercism-report.json
```

The same importer handles **full local upstream checkouts** (not just snapshots):

```sh
node tools/import-external-corpus.mjs \
  --format test262 --root /path/to/test262 \
  --repository tc39/test262 --license BSD-3-Clause \
  --revision <exact-40-character-upstream-head> \
  --output corpus/out/full-test262-fixtures.jsonl
```

For ordinary checkout mode the importer requires a matching HEAD and clean
tracked working tree. In snapshot mode an exact per-file Git blob SHA lock is
mandatory. Neither mode downloads code, installs packages or evaluates guest
JavaScript. Source-side input programs retain exact source paths and modes.
The source *family*, not each example, determines the deterministic split.

Additional supported formats:

- `--format commonmark`: a local CommonMark `spec.json` export containing
  Markdown/HTML examples (must be generated/pinned separately).
- `--format jest-each`: statically extract **literal** `test.each([...])`
  and `it.each([...])` rows from an existing pinned JS/TS repository.
  Dynamic values and nonliteral tables are refused, not evaluated.

`--max N` bounds the number of records; reports explicitly indicate
truncation. No "expected result" is interpreted as an independently observed
execution. "hardness" is an **AST/static prioritization heuristic**, not a
measure of actual dynamic semantic trace quality. Non-code conformance data
does not receive an AST hardness score.

## Additional adversarial real-library diagnostics

The 14 new scenario families in `corpus/stateful/extension-cases.mjs` execute
the **unchanged pinned production packages** already under
`corpus/stateful/upstream/`; only the scenario drivers are authored here.
They stress callbacks mutating subscription sets while dispatching, accessors
with observable side effects, cross-store notification recursion, linked-list
iteration under mutation, eviction callback cascades, async error/finally
unwinding, unawaited middleware, thenable assimilation, and integration flows.

```sh
npm run corpus:stateful -- --suite adversarial --per-scenario 12 \
  --output corpus/out/adversarial-traces.jsonl \
  --report corpus/out/adversarial-report.json \
  --review corpus/out/adversarial-review.md

npm run corpus:stateful:audit -- --suite adversarial \
  --input corpus/out/adversarial-traces.jsonl --require-complete \
  --output corpus/out/adversarial-audit.json \
  --review corpus/out/adversarial-audit.md
```

The old default `--suite baseline` is unchanged. `--suite combined` runs both
inventories together. The adversarial runs are still native V8 diagnostics:
a matching final observable graph and explicit side-effect log is **not**
an independent oracle for intermediate calls, property traps, promises, or
scheduling, and cannot be admitted to `semantic-execution/2` on that basis.

## Safety and admitted-data boundaries

Do not run untrusted GitHub repositories inside the in-process Node VM:
`node:vm` is not a security boundary. Bulk third-party test execution needs
an isolated, resource-restricted worker with no network or credentials.
Preserve third-party license notices and review distribution/training rights.
Use project-level splits and avoid cross-project dependency leakage.
Acquisition records must never flow into the megatoken training importer
without independently checked owned traces and the downstream admission gates.

## CI acquisition at full upstream scale

The [External JS/TS corpus acquisition workflow](../../.github/workflows/external-corpus.yml) automatically audits the pinned snapshots and publishes their acquisition-only JSONL manifests. On relevant `main` pushes it also runs full-source acquisition; for manual runs, in **Actions → External JS/TS corpus acquisition (non-admitted) → Run workflow**, set `full_sources=true` to fetch the three full pinned upstream repositories (Test262, Exercism specifications and JSON Schema Test Suite) and upload full candidate catalogs. This opt-in task performs no guest JS execution and makes no owned-trace claims. It was not run as part of the initial change; do not equate estimated upstream suite size with measured acquired case counts.

Initial opt-in adversarial CI smoke has measured **28/28 independently matching native-V8 final outcomes** across all 14 new families (10,776 observation events; 4,526 recorded heap changes). The workflow checks for all 28 matches, not merely 28 attempts. These remain diagnostic only.

Measured snapshot CI acquisition: **82 Test262 variants + 464 Exercism cases + 907 JSON Schema cases = 1,453 acquisition fixtures**, zero new verified or admitted semantic traces.

### First complete pinned run (measured)

[Actions run 39968633575](https://github.com/werg/tracing-js-self/actions/runs/39968633575) completed successfully: **103,582 Test262 variants from 53,910 files**, **2,330 Exercism cases from 143 files**, **11,861 JSON Schema cases from 434 files**; **117,773 non-admitted candidate fixtures total**. The downloadable `full-pinned-source-catalog-only` artifact contains the exact JSONL catalogs and reports. No full-source owned semantic verification or independent reference execution has yet taken place.


## Locally verified owned Exercism JS reference-solution pilot

The directory `snapshots/exercism-js/` contains **20 original pinned
production-grade exercise reference solutions**; `snapshots/exercism-js-inputs/`
contains their **20 independent canonical input/expected-output sources**.
Each snapshot has a per-file original Git blob lock and upstream LICENSE.

The curated adapter evaluates the pinned original proof **with only its ESM export keywords removed** under strict V8 script semantics, alongside an explicit,
conservative function-only source lowering to strict owned function entry.
An independently executed V8 comparison of the original proof's function-body behavior,
transformed function semantics, canonical expected output and observed
argument mutations gates each owned attempt. A successful owned run must
also pass `verifyTrainingCase`, model-visible trajectory evaluation, and
`recheckIndependentTrainingEvidence` on the serialized archive. This is a
small real-code subset and is **not** full Test262 or ESM conformance.

```sh
npm ci
npm run corpus:exercism:owned -- \
  --per-family 12 --max-cases 240 --min-owned 1 \
  --output corpus/out/exercism-owned-report.json \
  --local-episodes corpus/out/exercism-owned-locally-verified.jsonl
```

The report contains complete per-case statuses and trace-size/causal-chunk
proxies. **Only `locally_verified` records are written to the episode JSONL**.
The `exported.sidecar` is *private evidence*, not predictor context. The
`exported.public` is the source/initial-state and generated-trace projection.
Both remain non-admitted until independent megatoken training gates pass.

CI executes the bounded pilot and retains its report/episodic archive as an
artifact; it never uploads newly admitted training data. The input cases with
throws, classes, nonstatic top-level declarations, unsupported RegExp, too-long
trace budgets, or original-versus-expected disagreements remain explicit
refusals, not silently missing entries.


### First measured owned verification

[The CI run](https://github.com/werg/tracing-js-self/actions/runs/39990355300)
confirmed **34/207** SHA-locked canonical JS/TS evaluation attempts as
locally verified **owned** `semantic-execution/2` trajectories. The
other **173** have explicit categorized refusals. **Zero** are admitted
training examples. This is separate from the 117,773 acquisition-only
catalog entries.

The `--mutations-per-family N` option additionally generates bounded,
reproducible variants of canonical input shapes. Those generated probes have
their own IDs, original-input ancestry and independent original-solution
V8-derived expected outputs. They are never mislabeled as official
canonical tests. Each must pass the same owned evidence recheck before
it is written to the episode artifact.


### Deterministic-input pilot results (verified)

[Run 39991150068](https://github.com/werg/tracing-js-self/actions/runs/39991150068):
**367 attempts = 207 pinned canonical + 160 synthetic input variants**;
**71 independently rechecked owned trace candidates**, **296 refusals**,
**zero admitted**. Across the retained episodes: **5,809 raw owned journal
events**, **1,930 generated semantic groups**, and **301,108 generated
semantic record bytes**. This is seven distinct source families—not
71 independent upstream implementations.

Pass `--review corpus/out/exercism-owned-review.md` to produce a
source-linked, bounded Markdown semantic-trace sample for manual readability
inspection, alongside all top-level refusal reasons. Neither this preview
nor group/event ratios prove lossless semantic compression.

**Source-site limitation:** The `semantic-execution/2` records reference the strict function-entry *lowered* source, not yet certified offsets in the original ESM proof file. The original proof path/revision/SHA is retained for provenance, and the original-without-export-keywords behavior is independently compared in V8, but neither general ESM execution nor original-position mappings are proven. This remains an explicit extension-plan task.


## Full-catalog disposition (every acquired fixture)

The full pinned acquisition pipeline now also runs
`tools/convert-full-corpus.mjs`, which emits a deterministic one-record-per-
original-fixture **conversion/refusal** JSONL, plus an aggregate quality report.
It verifies exact candidate identity, requires joined pinned original-source
plus independently rechecked owned results, and never pretends that Test262
programs or JSON Schema data are already owned-traceable JS functions.

The `owned-original-sites/1` map and `owned-source-site-audit/1` per-event
receipts now link exact preserved source tokens to original JS byte positions
for verified Exercism examples. Synthetic compiler tokens or source spans
crossing a transformation boundary remain explicitly unmapped. These receipts
are private audit data; the public trace still uses the lowered source context.

This provides exhaustive **accounting** at 117,773 known acquired candidates,
but not complete owned **execution**. All unresolved cases stay in the
documented refusal ledger. Artifacts from the full-source workflow distinguish
the rechecked owned subset from the total acquisition inventory.


### Exhaustive disposition (CI measurement)

[Actions run 39994536985](https://github.com/werg/tracing-js-self/actions/runs/39994536985)
audited **all 117,773** acquired input records. Exactly **34 canonical
Exercism records** join to real locally verified owned traces; the other
**117,739** remain explicit, categorized refusals. There are also
**37 independent verified input variants** outside the original acquisition
denominator. All admitted training counts remain zero.

A separate `tools/verify-test262-scalar.mjs` checks a small, bounded
Test262 scalar slice in the owned script interpreter and an independent
Node V8 scalar reference. Passing this is **not** equivalent to an official
Test262 harness or an owned `semantic-execution/2` episode. It makes
no claim about modules, host effects, async or syntactic negative tests.


The bounded Test262 scalar smoke additionally attempts **actual locally
verified strict function-entry trajectories** using an exact original-body
wrapper, original-vs-wrapped native V8 check and independent
`semantic-execution/2` gate. Only successfully rechecked cases, with
explicit source-body byte receipts, can join their exact Test262 *sloppy*
acquisition records. This is a small, explicitly incomplete profile;
strict/module/async/negative/full-harness candidates remain refused.


### Updated complete-pipeline result

[Run 39996374782](https://github.com/werg/tracing-js-self/actions/runs/39996374782)
independently rechecked **six** Test262 scalar script bodies as true
`semantic-execution/2` local owned candidates, in addition to **34**
canonical Exercism candidates. Thus the acquired 117,773-case inventory
contains **40 owned locally verified** and **117,733 explicit refusals**.
The separate **37** verified generated variations yield **77 local owned
episodes overall**, none training-admitted. The complete source-disposition
and refusal ledger remains available in the same full-acquisition artifact.

## Offline JS/TS test declaration catalog (opt-in)

The `test-catalog` format scans an exact clean, pinned source checkout for test/spec files and `__tests__` files, **without running guest code**. It inventories ordinary `test`/`it`/`specify`, `Deno.test`, literal Jest/Vitest `.each` rows, disabled declarations and suite ancestry. Source spans are original UTF-16 offsets, with upstream SHA-256 provenance and frozen project splits. Nonliteral tables, tagged tables and parameterized suites remain explicit `requires-dynamic-recording` candidates; skipped/todo declarations are `disabled-upstream`, and empty tables have `no-instantiated-rows`.

Example: `node tools/import-external-corpus.mjs --format test-catalog --root /path/to/pinned-checkout --repository owner/repo --revision FULL_40_CHARACTER_SHA --license MIT --output corpus/out/tests.jsonl --report corpus/out/tests.json`

The inventory does **not** resolve which runner is used, prove a callable production boundary, capture effects or create valid independent execution evidence. Every record has `authority: acquired-fixture-only`, `verified: false`, and `admitted: false`. Execute unknown upstream tests only in isolated sandboxes, then independently recheck replay and owned semantics before any training use.


## Opt-in native-V8 Test262 reference diagnostics (not owned traces)

A bounded **real harness-based script reference adapter** is available in
`src/corpus/test262-reference-execution.mjs`. It uses the pinned Test262
`sta.js` and `assert.js` files plus explicit extra includes, tests both
sloppy/strict script modes, separates parse errors from runtime throws, checks
the actual thrown constructor instead of its spoofable error name, and refuses
unsupported module, raw, async, early/resolution and host-flag variants.
An opt-in CLI requires an **exact, clean, locally pinned** Test262 checkout:

```sh
npm run corpus:test262:reference -- \
  --root /path/to/trusted/test262 \
  --revision d53ebc8b1931d9f1541e43d59650776e4b766248 \
  --max 500 --timeout-ms 250 \
  --output corpus/out/test262-reference-diagnostics.json
```

This runs guest JS locally and must not be used on untrusted source;
`node:vm` is **not** a security isolation boundary. It performs no downloads
or network calls and is **not** enabled on the acquisition-only workflow.
Reported `passed` cases are V8 **diagnostic** observations, not owned
`semantic-execution/2` trajectories, training-admitted examples, or
independent cross-engine conformance proof. It does not implement complete
Test262 harness semantics, feature-gating or async/module resolution. No
full-suite result counts are claimed until a trusted pinned run is measured.

## Opt-in Test262 native static-module reference diagnostics

The normal native reference command continues to handle scripts without
experimental flags. To enable bounded native static ESM from a **trusted,
clean, exact pinned Test262 checkout**, run:

```sh
npm run corpus:test262:reference:modules -- \
  --root /path/to/pinned-test262 \
  --revision <exact-upstream-40-character-commit> \
  --max 1000 --output corpus/out/test262-native-reference.json
```

The runner checks the pinned checkout HEAD, clean tracked tree and each
program SHA-256 before executing it. Only relative local module imports
within `test/` are allowed; escaping symlinks and missing fixture files
are refused. The real upstream harness is loaded. Native parse, resolution
and runtime errors are checked against actual guest error constructors.
Unresolved top-level-await has a deadline rather than a success response.

This is **native-V8 diagnostic execution**, not owned tracing or training
admission. Module-async `$DONE`, dynamic imports, early-error phase
distinctions, runtime host APIs and full Test262 harness conformance
remain unsupported. Node requires `--experimental-vm-modules`. Node VM
is not a security boundary; do not execute arbitrary untrusted sources
without OS-level isolation and credential/network restrictions.


## Cross-fork owned-source clone guards and quantitative trace review

The owned-episode novelty selector now independently rechecks each serialized
owned execution and tokenizes the actual lowered, owned JavaScript source.
Identical token sequences, consistent identifier-renamed copies, and high-overlap
token-shingle matches are clustered across repository/path boundaries. A
detected clone spanning train/validation/test **aborts** selection. Clones
inside one split share source-novelty weight rather than inflating source
diversity. These are bounded lexical heuristics, not semantic equivalence
proofs: substantially rewritten or short clones can be missed.

The same JSON report now contains distinctSourceClusters,
sourceCloneClusters, sourceNearPairs and traceQuality. Quantiles summarize
raw journal event counts, semantic event counts, model-visible generated group
sizes and serialized record bytes. A bounded inspection queue prioritizes
high events-per-group cases for *manual* review. The original-site source
coverage statistic is reported from the existing original-site receipt audit
and cannot be independently mapped without access to original pinned bytes.

Run the existing command:

    npm run corpus:owned:novelty -- --input corpus/out/exercism-owned-locally-verified.jsonl --output corpus/out/exercism-owned-novelty.json --limit 64

No newly acquired records or V8 diagnostics become owned verification through
these heuristics. All output remains explicitly non-admitted. These metrics
do not certify human readability or intermediate-operation completeness.


### Optional bounded native-reference failure minimization

The pinned Exercism original-versus-lowered V8 comparison can now be run
with --shrink-reference-mismatches. Only an actually reproduced native
reference disagreement is eligible for deterministic counterexample
simplification. The shrinker changes JSON-valued *arguments*, preserves
the exact function entry and requires the original and projected programs to
continue disagreeing at each accepted step. Its 24-attempt budget includes
refusals and oracle errors. A minimized case is a diagnostic debugging
artifact, not a new canonical test, owned verification or admitted training
episode. A non-reproducible mismatch is explicitly labeled not-reproduced.


## Full Test262 native reference sweep (opt-in, diagnostic only)

`tools/verify-test262-reference.mjs` also accepts a previously acquired
full pinned Test262 JSONL manifest (`--input`), exact ordinal sharding
(`--shard-index`/`--shard-count`), bounded streaming output
(`--rows-output`) and an exact `--expect-enumerated` assertion.
The importer/runner reject foreign sources, dirty revisions, escaped source
paths and mismatched file SHA-256s. Each shard hashes the *same* entire
catalog identity, but executes only its selected ordinal residue class.
All rows contain source IDs, ordinals, statuses and non-admission flags.

The manual workflow `.github/workflows/test262-native-full.yml`
acquires and executes the pinned 103,582 variants in 16 separate no-network,
read-only, unprivileged Docker workers with resource caps. The strict
`tools/aggregate-test262-native.mjs` merge requires all shards and all
ordinals, checks per-shard content hashes/status counts, and refuses any
verified-owned or admitted assertions. A green full sweep is **native
diagnostic inventory accounting**, *not* official conformance, complete
harness semantics, owned intermediate traces, or training admission.
Neither native VM nor Docker should be treated as a perfect security barrier.

For an already acquired and trusted pinned checkout, a manual shard looks
like:

```sh
node --experimental-vm-modules tools/verify-test262-reference.mjs \
  --root /path/to/pinned/test262 \
  --revision d53ebc8b1931d9f1541e43d59650776e4b766248 \
  --input /path/to/test262.jsonl \
  --shard-index 0 --shard-count 16 \
  --max 10000 --expect-enumerated 103582 \
  --rows-output /path/to/rows.jsonl --output /path/to/report.json
```

Run only trusted pinned sources in a restricted external sandbox, never
unknown upstream JavaScript on an unrestricted developer machine.
