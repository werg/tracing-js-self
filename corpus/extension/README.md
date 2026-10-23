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

The [External JS/TS corpus acquisition workflow](../../.github/workflows/external-corpus.yml) automatically audits the pinned snapshots and publishes their acquisition-only JSONL manifests. In **Actions → External JS/TS corpus acquisition (non-admitted) → Run workflow**, set `full_sources=true` to fetch the three full pinned upstream repositories (Test262, Exercism specifications and JSON Schema Test Suite) and upload full candidate catalogs. This opt-in task performs no guest JS execution and makes no owned-trace claims. It was not run as part of the initial change; do not equate estimated upstream suite size with measured acquired case counts.

Initial opt-in adversarial CI smoke has measured **28/28 independently matching native-V8 final outcomes** across all 14 new families (10,776 observation events; 4,526 recorded heap changes). The workflow checks for all 28 matches, not merely 28 attempts. These remain diagnostic only.
