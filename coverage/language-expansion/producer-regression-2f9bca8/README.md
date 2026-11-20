# Producer regression at 2f9bca8

This is the complete producer regression at exact revision
`2f9bca8c38b0773daccf4f0e97ba8bb2ca7d0bac`, using Node `v24.22.3` in a clean
detached checkout. The checkout had a real, ignored `node_modules` directory and
remained clean after both commands. The retained files are copied without changes
from the completed run; `summary.json` records command results and exact log hashes.

| Command | Result | Duration |
| --- | --- | --- |
| `node --test --test-concurrency=4 test/*.test.js` | 1,746 tests: 1,740 passed, 6 skipped, 0 failed, 0 cancelled | 418.246 seconds |
| `node fixtures/reference/reference-fixture.mjs` | All eight reference checks passed | 0.126 seconds |

The six optional skips are one v7 ByteCodec test without external
consumer/tokenizer paths and five native orchestration tests without the required
served-runtime environment variables. They are recorded verbatim in `summary.json`
and `tests.log`; they are not counted as passes. Native v8 admission and production
tokenizer measurements require their separate qualification evidence.

The reference checks were `getterReadOnce`, `bufferCoherenceAcrossCallback`,
`synchronousThrowPreserved`, `reverseCompletionOrder`, `internalAwaitSuspends`,
`permittedBatchingEquivalent`, `transcriptStoreDoesNotRepeatMockEffect`, and
`duplicateConversionDetected`.

An earlier incomplete attempt encountered a missing sandbox `/tmp`. This retained
run restarted the entire suite with `TMPDIR` pointing to an existing writable
directory; no test or production code was changed for that environment issue.

## Relationship to later commits

These results describe the exact revision above, not a full test run of a later
commit. The subsequent `9d76176` change adds
`tools/semantic-v8-native-adapter.mjs`, an export entry point that calls the existing
native-admission functions, and updates documentation. It does not modify the
producer runtime, compiler, protocol implementation, tests, or fixtures. Later
native-policy repins select an independently qualified consumer; CI, documentation,
and retained-evidence changes likewise do not change those producer semantics.
Their adapter behavior and exact external pins still need their own targeted
checks and native qualification; this historical full run does not substitute for
those checks or for a rerun after any further producer semantic change.

The full output is in `tests.log` and `reference.log`. `summary.json` includes the
exact revision, environment, timestamps, test counts, skip reasons, reference
checks, and SHA-256 digests of both logs.
