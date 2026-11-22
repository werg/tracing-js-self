# Current-history recovery regression

A new regression on producer `e66c7c3` reproduced restoration from an older acknowledged coordinator checkpoint despite a newer durable pending-selection marker. The original code returned a runnable driver instead of rejecting. The corrected latest-history entry points require an explicit current-head read and refuse every later durable position, including unacknowledged ones, before native reconstruction. Historical prefix reads remain available for inspection.

The final local integration run passed **96 JUnit cases with zero failures, errors or skips**, including six actual Python native orchestration recovery cases against exact native `abf4dc6424e3aeaf10f1d2609a2197897c1d42ba`. The source manifest binds the exact modified implementation and test bytes. Tests exercised storage races during reads, receipt mutation, malformed positions, old pending fences, actual coordinator recovery and completed-effect non-repetition.

The initial integration report is also retained: 90 cases, five failures. Four assertions/fixtures still encoded the former prefix-only restore contract (including one unsafe stale-prefix success expectation), and one custom test backend lacked both required read operations after adaptation. They were corrected to require stale-history refusal while preserving historical inspection. The subsequent complete96-case run includes the six actual native cases and passes without skips.

Run with `TMPDIR` pointing to a writable location and `MEGATOKEN_ROOT`, `MEGATOKEN_PYTHON` and `PYTHONPATH` pointing to the exact paired checkout/runtime:

```sh
node --test --test-concurrency=1 --test-reporter=junit \
  test/semantic-selected-history-storage-v8.test.js \
  test/semantic-selected-history-v8.test.js \
  test/semantic-selected-history-tail-v8.test.js \
  test/semantic-selected-history-automatic-v8.test.js \
  test/semantic-service-history-v8.test.js \
  test/semantic-selected-orchestration-checkpoint-v8.test.js \
  test/semantic-native-orchestration-recovery-v8.test.js
```

This verifies freshness during the read. It does not supply a distributed execution lease or atomic journal/head ownership transfer, discover an unacknowledged head, or reconcile unknown native/host work. The embedding must still exclude concurrent execution owners. Zero optimizer updates; no learned-quality claim. See [the recovery contract](../../SELECTED_HISTORY_FRESHNESS_V8.md).

## Focused CI environment correction

The composed `e66c7c3` focused workflow [run 45010107171](https://github.com/werg/tracing-js-self/actions/runs/45010107171), job `137170354756`, picked up the new module tests without enabling Node's original-ESM VM support or checking out the native consumer. Its complete failed log is retained. The original source checks failed with `SourceTextModule is not a constructor`, and the mandatory native comparison was skipped. This was not a successful gate.

The workflow now enables the required VM option, checks out the exact policy-pinned consumer in a sibling directory, installs its locked dependencies, and requires all six original/native module cases and 64 lifecycle transitions with zero skips. No test is removed from the focused gate. The separate paired module gate already used the correct environment and passed; it remains mandatory as well.
