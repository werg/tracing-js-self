# Automatic history and integration evidence

This retained supplement records exact producer `19eba4f4ef273e15c126d6a35cb38db05156e2d1`
and consumer `39d5212bf930d2e3cd159d0a505299893dba2c11` for the actual automatic-history
diagnostic. Separate regression and external-asset gates name their own consumer
pins below. It does not qualify every subsequent code change.

## Actual automatic saved-history run

The ordinary native service used the retained, fitted model with SHA-256
`65c6dc55068bcb103180ed2f38c3115bb15d3740cd7416d864d58c7c5910c3a9`.
There was **one acknowledged original model record and two automatically saved
cuts**. Each save synchronized the history and a separately retained head before
execution could proceed. A fresh service restored the later cut using the older
packet and the independently retained later head. The complete host and native
checkpoints, consumed attempts, contexts and source-checked accepted prefix match.

The next actual output is identical but **malformed and refused**. It is never
acknowledged; there are zero host dispatches and no complete-program, held-out or
generalization result. No training was performed for this run. The historical
weights came from the separately retained 32-step decoder-only fitting diagnostic
at producer `35be3b7` / consumer `f25fa32`; this is not a new ordinary-training result.

Nine service RPCs consumed 11.98079733698978 reported compute seconds, with
537,538,560 peak process bytes. These costs include both lifetimes, native
reconstruction and both refused next-output probes, and exclude historical training.
All original selection/refusal bytes, cuts, head, commands, runtime identities and
service profiles are retained under `actual-automatic/`.

The original report's `historyMode: "automatic"` and
`automaticAcknowledgedBoundaryDurability: true` identify the exercised API.
Its historical generic scope sentence still contains the word "explicit"; the
original bytes are retained. The qualifier's later wording correction does not
alter this result. Arbitrary unsaved transitions, cancellation beyond the trusted
head, distributed ownership and log rotation remain outside this gate.

## Complete producer and separate external-asset gates

At exact producer `19eba4f`, `npm test` passed **2,404 tests, zero failures**,
with **six asset-dependent skips**, from 2,410 tests; the reference fixture passed
**8/8**. The complete log retains all test names and skip reasons.

The six missing-asset controls were then run separately with retained assets:

- The tokenizer file's three controls passed with **zero failures or skips**.
  Its independently pinned legacy consumer is
  `3a0eb90e3e7282e9b3cb2ca0da27454451b50e21`, as required by the producer policy.
- The coordinator file's 13 controls passed with **zero failures or skips** on
  consumer `1ddcc6110d70703f6b08244d53ec461047677bec`. Four native controls use
  disclosed controlled engineering output. The initialized-weight model control
  retains rejected bytes and costs without a fixture fallback. Original native
  outputs are under `external-native-coordinator/`.

These runs overlap with the full suite and are not additive test totals.
The original full run still has six skips; later gates do not rewrite it.

## Retained consumer failure and correction

The complete consumer selection at `39d5212` against producer `19eba4f`
finished **611 passed, one failed, zero skipped**, in 805.66 seconds. The failure
is `test_model_checkpoint_preserves_ecmascript_number_equivalence[path4]`:
closed-session opening validation rejected valid JSON `1.0` while accepting `1`.
The complete log, JUnit results and focused reproduction remain failed evidence.

Consumer `1ddcc6110d70703f6b08244d53ec461047677bec` preserves concurrent binding
repair `9c557a7` and fixes that regression while rejecting boolean, fractional,
negative or unsafe counts and invalid opening times before native allocation.
The combined authority, closed-session and binding selection passes **38/38**,
zero failures/skips, in 19.30 seconds. The tested local commit
`273d26733962519c8da8cad101f4ae728a6f03bf` and published commit have identical
tree `c5dd2b212fc82c1d18c3852a0be6a10ec12f9128`.
The exact patch is retained. One earlier invocation named a nonexistent test file;
its zero-test setup failure is retained separately. The complete repaired-head
selection was still running when this supplement was frozen.

## Shared model and tokenizer bytes

No model or tokenizer bytes are duplicated. All 11 required served-bundle members
were checked against the already committed 515-file archive at producer commit
`5eeddef47caeb8300094211a9b4cb6020c60ab70`, archive SHA-256
`7dd052a8dd72bc90760360aa3de02fcbf62d716cf47a6c10623e9ac44ce4884a`.
`metadata/shared-dependencies.json` binds its exact inventory Git blob and every
required member path, byte count and SHA-256. Six files are the fitted V8 bundle;
five are the initialized-weight bundle for the legacy coordinator controls.
Restore that archive first and use those exact members.

The source artifact is retained in this supplement. Commands and exact producer,
consumer, Node, Python and model identities are recorded in
`actual-automatic/run-input.json` and `metadata/results.json`.
Use clean checkouts at the stated revisions and the producer's hash-locked native
consumer requirements. Set Python imports to the exact checked-out consumer.
Output directories must be new and outside both source checkouts.

## Verify or restore

From this producer repository:

```sh
python3 tools/restore-retained-evidence.py --inventory docs/evidence/semantic-v8-automatic-19eba4f-39d5212/inventory.json
python3 tools/restore-retained-evidence.py --inventory docs/evidence/semantic-v8-automatic-19eba4f-39d5212/inventory.json --out /absolute/path/to/new-directory
```

The verifier checks every compressed part, the complete archive, membership, and
every extracted file before reporting success. The partial hosted-workflow
snapshot is explicitly labeled in progress; it does not assert final CI results.
