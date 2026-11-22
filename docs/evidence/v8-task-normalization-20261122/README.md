# Original-task normalization and exact read-byte binding

This isolated work starts at producer `7c20124f3d89dfe1a8d5e892238e7b7f92589720` (tree `13a2497fdd19ca5de94c86ba24a54f04251e808f`). Source corrections are published separately: normalization `b2360be949eb14c8439c575e590b7818951102a3`; read-byte binding `d726bf4381fb78c8852656dce84d55a3ff2785b4` (tree `fc2431497aca275ef1edf89029ddcd81664a1c19`, equivalent local `0799b39709ad35a32fc4439f31d270185ea838c9`). `source-map.json` gives exact baseline and changed blobs.

## Retained failing observations

`initial-red/` preserves the unchanged helper's first run and exact test source: **25 leaves, 7 passed, 18 failed, 0 skipped**. Seventeen failures demonstrate correspondence mismatches. One was an invalid positive test: reading a statically known namespace property did not activate the direct namespace profile, so actual generation rejected null custody. That invalid positive is explicitly excluded from the defect count.

`controlled-red/` replaces that fixture with an actual namespace operation and adds profile-specific controls. Against the unchanged helper it records **33 leaves, 12 passed, 21 failed, 0 skipped**. Each case encodes and decodes the fixture through the real generation boundary and calls the actual source/module producer. Positive cases must really export an artifact; refusal cases must really fail generation before the helper is checked. This is not a set of invented source receipts.

## Source correction

Ordinary source custody, split seed and seed metadata use undefined-only defaults; explicit invalid null values and contradictory guest RNG declarations refuse. Valid false/zero/empty-string host fixture values retain the producer's empty-fixture behavior. Ordinary source ignores the protocol-only ancestry alias, whereas direct protocol source keeps its existing alias/null behavior.

Ordered sessions take their source, entry and ancestry from the ordered component calls. Outer metadata ignored by the actual session producer stays ignored; the explicit session seed overrides component seeds. Null session IDs and seeds do not acquire omitted defaults. Module null plan switches and null host fixtures retain their real defaults. Actual namespace-plan execution preserves its distinct nullable custody and ignored split-seed metadata, while a merely statically lowered namespace import still goes through ordinary source preflight.

## Separate read-byte correction

Static review found that the snapshot caller discarded `readJSON.sha256` while interpreting registry/source/admitted/native JSON, then checked independently reread bytes later. No concurrent substitution was executed or demonstrated. The correction compares each interpreted read's SHA-256 immediately to the committed artifact receipt and checks that exact digest again during final inventory. Existing single-read stability and complete-inventory checks remain.

Four deterministic controls first verify the unchanged controlled journal, append whitespace to one source/admitted/native/registry JSON file, establish unchanged parsed meaning, then require refusal at the immediate read-byte check. The registry positive uses the real family-registry builder and identity/binding helpers. The controlled campaign fixtures are explicitly not real source/native qualification. No flaky concurrent mutation test is claimed.

## Qualification and scope

The final four-file run passes **106 executable leaves, zero failures/errors/skips**: all **69** historical leaves plus **33** actual-generation normalization leaves and **4** read-byte leaves. Node's reporter includes 13 parent containers and reports 119 tests. `count-report.json` independently compares all original 69 names against the final JUnit population; none is missing. The earlier three-file run in `fixed-union/` had 98 leaves because it omitted the four qualification-progress leaves; it is retained as a partial run, not the complete denominator.

```sh
TMPDIR=/writable/scratch RUNNER_TEMP=/writable/output \
node --experimental-vm-modules --test --test-concurrency=1 \
  --test-reporter=spec --test-reporter-destination=/writable/output/tests.log \
  --test-reporter=junit --test-reporter-destination=/writable/output/tests.xml \
  test/qualification-progress.test.js test/v8-release-task-binding.test.js \
  test/v8-release-campaign.test.js test/v8-release-task-normalization.test.js
```

`original64-observation.json` checks the preserved primary packet's **64 original encoded tasks** at producer `9cf091e6ccc5add960ef0897576d0c391b199a65` against their original source files and registry. All **67 read files / 61,557,347 bytes** retain equal before/after SHA-256 values. The observer does not reconstruct a missing lock or journal; it makes **zero fresh source replays, native admissions, optimizer updates or decoder passes**. This is helper-only original correspondence, not current-pair release qualification. `observe-original64.mjs` records the read-only procedure.

Main concurrently advanced to `cc0d61e98dc6252749f4a2a4c8b669d79b0f7efa` with additional physical-source identity and RNG controls. This older exact proof is retained independently; its source must be ported narrowly onto that successor before integration. No main branch, native source, production bound, model deadline, workflow or training campaign was changed here.
