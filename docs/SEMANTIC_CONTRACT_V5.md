# Version 5 semantic artifact boundary

The current public execution envelope and witness are `semantic-execution/5`
and `semantic-trace/5`. The shared declaration is
`contracts/semantic-harness-v5.json` with schema `semantic-harness-contract/5`.
Selected contexts and controller continuations use `semantic-context/5` and
`semantic-continuation/5`; selected harness checkpoints use `semantic-checkpoint/5`.

Program publication carries an optional unsigned 32-bit deterministic seed.
Each random draw is a separate checked computation. Every selected-state
snapshot contains `randomState`, which is either an unsigned 32-bit integer or
explicit `null` for an unseeded realm. The snapshot uses the realm's current
stream position, including draws made by children while a parent is suspended.
This preserves the information needed for the next draw after older records
leave bounded model history. Replay reconstructs that position from the seed
and committed random computations and rejects forged snapshots.

Public v4 envelopes are rejected, including unseeded examples and local imports
that do not request production admission. Old controller continuations and
harness checkpoints are rejected before restoration. Changing a label alone
does not rebuild an artifact's evidence: admission, saved model continuations,
and evaluation reports must also match the newly generated schema and fixture
digests and the unchanged host-operation catalog identity.

Regenerate prepared episodes from their original source inputs with the current
producer, recheck source and execution evidence, and readmit them with the
current native consumer. Recollect model actions and rebuild model-bound data
where required. Existing original recordings and unchanged donor assets may be
used only after their normal exact identity checks. There is no v4 import or
checkpoint migration path.

The generator is `node tools/generate-semantic-contract.mjs`; `npm run
contracts:check` verifies that its checked-in bytes match the executable
declaration. Megatoken carries identical contract bytes and independently
validates the positive and negative fixtures, including old-version and random
state rejection. Current cross-repository workflows pin exact producer and
consumer commits.

The selected execution profile, host-operation catalog, native action payloads,
and supervision authority formats retain their existing versions because those
contracts did not change. Source recipe family names and historical module
filenames also retain their identities. They do not enable older artifact
versions.

The earlier engineering ledger, integration lock, and files under
`docs/evidence/semantic-v4` remain historical evidence tied to their original
commits. Their hashes and scores are not relabeled as v5 results. Current CI
records the v5 verification artifacts separately.
