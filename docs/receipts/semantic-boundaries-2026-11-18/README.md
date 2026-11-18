# Semantic boundary qualification — 18 November 2026

Producer: `e71ea3054e304d61a77a33832e733907e06a36bb`. Companion:
`277edd4a2983e81f5e2a71b34a7ce29348e4e7a0`. These are the exact revisions
used for this receipt; later consumer policy changes do not relabel this run.

`native-qualification.json` records 19 diagnostic boundaries. Fourteen positive
cases passed actual native tokenizer, fragmentation, visibility and loss gates,
then fresh independent source/journal/selected replay rechecks. Five cases were
explicitly refused: Object.create descriptors, indexed array accessors,
accessor-based descriptor fields, callback failure and unhandled rejection.
Sources, fixtures, public/identity digests and actual native receipts are retained.
These are engineering boundary cases, not independent corpus-family counts.

The positive cases cover the original array/default-parameter/async-declaration
repairs plus partial accessor descriptor updates, idempotent nonconfigurable
updates, primitive and declared-error throws, implicit TDZ errors, and observed
synchronous host rejection through async cleanup. `native-environment.json`
separately verifies the actual clean consumer, exact tokenizer, Python runtime
and 47 locked packages used here.

The full suite exercised 832 tests. All 48 initial failures were caused by an
absent sandbox `/tmp`; 779 passed and five required the external orchestration
environment. Every affected test file was rerun with an existing workspace
`TMPDIR`: 102/102 tests passed. No source changed between these runs. The final
combined result is 827 distinct passing tests, five explicit skips and zero
remaining failures. The eight-scenario reference fixture and contract checks
also passed. `verification-summary.json` retains the exact counts and log hashes.

Reproduce from the producer revision with a qualified native environment:

```sh
mkdir -p .cache/test-tmp
TMPDIR="$PWD/.cache/test-tmp" node --test --test-concurrency=2 test/*.test.js
node fixtures/reference/reference-fixture.mjs
npm run contracts:check
TZ=UTC LC_ALL=C.UTF-8 OMP_NUM_THREADS=1 MKL_NUM_THREADS=1 \
  node tools/check-semantic-boundaries.mjs --out /path/to/new/receipt.json \
  --megatoken /path/to/pinned/megatoken --python /path/to/locked/python \
  --tokenizer /path/to/tokenizer.json \
  --native-policy contracts/native-admission-policy-v5.json
```

Zero optimizer steps were performed in this qualification. No learned execution
or generalization improvement is claimed.
