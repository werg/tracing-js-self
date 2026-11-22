# Ordinary coordinator driver controls — 22 November 2026

The complete process-selector, coordinator transport and driver selection passes
**26/26, zero failures or skips**. This selection overlaps and supersedes the
21-control transport selection; those counts must not be added.

The new driver cases exercise two fresh declared roots, exact native readiness
and join gating, native child completion before the next coordinator selection,
original failed model bytes, normalized Unicode cancellation, one-shot use,
post-commit bootstrap failure accounting, and explicit refusal of child-only
recovery APIs. A subprocess JSONL peer exercises the ordinary process selector
and ordinary child driver together. Peer output is supplied engineering data;
these results do not establish learned execution, model quality or production
completion.

Review removed an invented selection-level `track` field and an invented native
identity `sourceAdmissionClaim` requirement. Ownership comes from each original
fragment's native `modelTrack`. A positive commit remains acknowledged after a
later host failure; post-commit failures have their own count instead of being
reported as rejected model actions. The host deadline is cooperative, and the
selector owns the independent RPC deadline.

Reproduce with the paired checkout available as `MEGATOKEN_ROOT` and its `src`
on `PYTHONPATH`:

```sh
node --test --test-reporter=tap test/semantic-native-process-v8.test.js test/semantic-native-orchestration-transport-v8.test.js test/semantic-selected-orchestration-v8.test.js
```

`SHA256.json` records the complete encoded and decoded log hashes and the local
consumer working-tree limitation. The paired hosted workflow separately runs
these controls against its exact committed consumer pin with zero skips.
Composite coordinator/child checkpoints and durable history remain unavailable;
the driver refuses those APIs explicitly.
