# Algorithm candidate verification

The complete `npm test` run executed at producer
`e96dd4e51d7977554f05dc1794272d5145c69663` on Node **24.22.3** and exited **0**.
The implementation was frozen throughout the full suite and the concurrent
[paired comparison](../paired-e96dd4e/MEASUREMENTS.md). Subsequent changes add
evidence and clarify documentation; they do not change the measured code.

| Check | Result | Evidence |
| --- | --- | --- |
| Full repository suite | 1,212 tests: **1,206 pass, 0 fail, 6 skipped**, 0 cancelled | [npm-test.log](npm-test.log) |
| Reference fixture, run after the suite | **8/8 checks pass**, expected result preserved | End of `npm-test.log` |
| Supplemental algorithm suite with exact tokenizer | **76/76 pass**, 0 fail, 0 skipped | [algorithm-tests.log](algorithm-tests.log) |
| Supplemental actual pinned tokenizer tests | **3/3 pass**, 0 fail, 0 skipped | [tokenizer-tests.log](tokenizer-tests.log) |
| Host, v6, and candidate contract generation | `npm run contracts:check` exits **0** | [verification.json](verification.json) |
| Paired source/equivalence checks | **98/98** cost cases retained, **87/87** family executions converge, **28/28** negatives pass | [comparison.json](../paired-e96dd4e/comparison.json) |

The full test runner took 367,082 ms. It ran concurrently with the paired
comparison; this duration is a verification result, not an isolated runtime
benchmark. The JSON receipt records log hashes and exact report identities.
The supplemental focused logs predate the documentation/export checkpoint
and do not independently record their producing Git revisions. The complete
suite and paired report bind the final implementation to the revision above.

## Skipped checks and evidence boundaries

Five skipped tests require the existing external native orchestration serving
environment (`MEGATOKEN_ORCHESTRATION_SERVED`, `MEGATOKEN_PYTHON`, and
`MEGATOKEN_REPOSITORY`). They were not run in this verification.

The sixth skip is the actual pinned tokenizer test: the plain `npm test`
invocation did not supply its external asset paths. That exact test passed in
the supplemental focused runs. The final paired comparison also executed the
real pinned tokenizer on every measured target, observation, envelope, and
supplied JavaScript context, with byte-exact decode checks. Its qualification
is token metering only, with native v7 admission explicitly false.

No skipped test is counted as a pass. These checks do not establish native v7
parser/continuation/supervision agreement, complete native serving costs,
external reader comprehension, or learned execution. Those release gates are
listed in the [implementation ledger](../../../SEMANTIC_ALGORITHM_IMPLEMENTATION.md).

## Reproduction

From the repository root, use the committed Node/dependency setup, then run:

```sh
npm test
npm run contracts:check
```

To include the exact token-meter tests, provide the assets required by
`contracts/native-admission-policy-v6.json` through these environment variables:

```sh
SEMANTIC_TOKENIZER_PYTHON=/absolute/path/to/python \
SEMANTIC_TOKENIZER_CONSUMER_ROOT=/absolute/path/to/megatoken \
SEMANTIC_TOKENIZER_JSON=/absolute/path/to/tokenizer.json \
npm run test:semantic-algorithm
```

For a new paired measurement, choose a fresh output directory and use the
comparison command below. The producer implementation must be committed and
must remain unchanged while the runner executes.

```sh
npm run semantic:compare -- \
  --out /absolute/path/to/new-comparison \
  --python /absolute/path/to/python \
  --consumer-root /absolute/path/to/megatoken \
  --tokenizer-json /absolute/path/to/tokenizer.json
```

Keep historical reports immutable. A later run identifies its own producer
revision and cannot inherit native admission from either the baseline or this
byte-exact meter.
