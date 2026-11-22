# Current-main task normalization and read-byte correspondence

**Source:** `182c3f0fa9cce1065d9c4ef6ed10942b6ca2c30b`, tree `cb53cf8afa0b653d614a160b215841ce6d5a8d51`, exact parent `cc0d61e98dc6252749f4a2a4c8b669d79b0f7efa`. Equivalent local source commit: `a3776344603a4d7b476f9cc1e9078bf3d216c710`. Only the four executable paths in `source-map.json` differ from current main; there are no deletions. No native source, workflow, bound, tokenizer, policy or training campaign changed here.

## Reconciliation

The earlier isolated source was `d726bf4381fb78c8852656dce84d55a3ff2785b4`, with retained proof at `45c068f557ce592fc31368dcf883c1670eecf5d6`. Its complete 106-leaf result and initial failing controls remain in `../v8-task-normalization-20261122/`. Main advanced concurrently, so the fixes were ported by a three-way patch and deliberate conflict review, not by replacing current-main files.

The current main's explicit physical source ID requirement and recorded-native binding functions are byte-identical. Its entire `test/v8-release-task-binding.test.js` and qualification-progress test file are unchanged. `preserved-current-authority.json` gives those exact SHA-256 checks. The campaign caller still supplies the committed `result.row.sourceId`; the byte-read check is performed before task correspondence. The new main changed-source-byte control is retained.

The main RNG helper's uint32 and conflict checks, including its diagnostics, are preserved. Its newly added record-only constraint is narrowed to match actual source generation: explicit null seed metadata refuses, while false/zero metadata really qualifies and remains permitted. The new 33-case normalization cohort proves both scalar cases using actual generation. Explicit module-plan execution retains its separate semantics and does not inherit an unrelated ordinary-source seed requirement.

## Measured controls

The four-file run passes **120 executable leaves, zero failures/errors/skips**: all **83 current-main leaves**, all **33 actual-generation normalization leaves**, and **4 immediate read-byte controls**. Node reports 135 tests because it includes 15 parent containers. `count-report.json` independently compares the raw JUnit names with both current-main's 83 and the earlier 69; none is missing. The run tested the four staged file changes, which were subsequently committed and published with identical content. This is local source/test evidence; no hosted current-pair or model/release success is claimed.

```sh
TMPDIR=/writable/scratch RUNNER_TEMP=/writable/output \
node --experimental-vm-modules --test --test-concurrency=1 \
  --test-reporter=spec --test-reporter-destination=/writable/output/tests.log \
  --test-reporter=junit --test-reporter-destination=/writable/output/tests.xml \
  test/qualification-progress.test.js test/v8-release-task-binding.test.js \
  test/v8-release-campaign.test.js test/v8-release-task-normalization.test.js
```

The normalization cases reproduce the actual source/session/module entry points after the real encoded graph boundary. They distinguish omitted defaults from invalid null values, valid falsy host fixtures and seed metadata, ordinary versus protocol ancestry, session component source/ancestry and seed overrides, nullable module plan switches, actual namespace-plan custody/seed semantics, and ordinary/mixed-host refusals.

The read-byte issue was found statically: initial parse hashes had been discarded before later independent inventory hashes. No concurrent substitution is claimed. The correction binds source/admitted/native/registry semantic comparisons to each exact observed read hash immediately, and rechecks the same hashes in final inventory. Four deterministic controls preserve JSON meaning but change raw bytes with whitespace, then require immediate receipt refusal.

## Preserved original packet

The current helper also accepts all **64 original tasks** from the preserved primary packet, using each original report row's explicit source ID. **67 input files / 61,557,347 bytes** retain matching before/after SHA-256 values. `original64-observation.json` and `observe-original64.mjs` record this independent read-only check. It performs **zero fresh source replays, native admissions, optimizer updates or decoder passes**, and does not reconstruct any missing lock/journal. It establishes helper correspondence for original inputs, not complete-history verification or current-pair release qualification.
