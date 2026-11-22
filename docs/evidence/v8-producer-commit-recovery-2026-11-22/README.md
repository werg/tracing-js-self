# Exact producer/native commit recovery controls

This local regression ran the exact producer source in published commit `e7f8fd60b6f286a667ddf708e17a0963aec78211` (identical Git tree to local `bc0f8b4fe820e1e72eea903bf3a58af0a658c7aa`) against native commit `350c1e69efd30ef59d5de5115b9ba60e7009ff23`. The retained JUnit report contains **43 cases, zero failures, zero errors and zero skips**. This is local paired execution, not a claim about a hosted run. The manifest binds the exact source blobs and report bytes.

The 43 cases comprise seven new durable commit controls, 22 existing native transport controls, eight producer journal controls and six execution-lock controls. The separate native regression has 83 cases plus eight pytest subtests; its focused 46-case run overlaps those 83 and must not be added. Tests use supplied or controlled lexical output. There are zero optimizer updates and no learned-quality claim.

The new cases recover a known exact committed reply; preserve acknowledgement-unknown after a lost reply; refuse missing native intent and changed reply bytes; refuse a completed commit after later application mutation; hold serialization across durable storage waits; and refuse sharing or reusing a live execution lease between native processes. Unknown outcomes are never retried automatically. Fresh initialization and ordinary restore cannot bypass the retained journal generation.

Reproduction (with the named exact checkouts and native dependencies installed):

```sh
MEGATOKEN_ROOT=/path/to/megatoken \
MEGATOKEN_PYTHON=/path/to/python \
node --test --test-concurrency=1 --test-reporter=junit \
  test/semantic-native-durable-commit-v8.test.js \
  test/semantic-native-process-v8.test.js \
  test/semantic-native-orchestration-transport-v8.test.js \
  test/native-request-journal-v8.test.js \
  test/selected-orchestration-execution-lock.test.js
```

The local sandbox maps the system `flock` owner to an untrusted UID. The tests used `TRACING_TEST_FLOCK` pointing to a private, executable copy of the same system binary and a writable `TMPDIR`; the production trusted-executable checks remain enabled and unchanged. Python was 3.12.14 with CPU Torch 2.14.1 and pytest 9.2.0.

This enables explicit native commit reconciliation only. Automatic host/history continuation, unknown external effects, dynamic descendants, distributed ownership and learned execution remain open. No full acceptance package is closed by this increment.
