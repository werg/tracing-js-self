# Current v5 identity and failure evidence

The production `verifyEffectfulTrainingCase` and `verifyEffectfulSession` paths
bind `semantic-candidate-identity/1` in the private sidecar before native
qualification. Public semantic prediction records remain unchanged.

## Immutable payload and receipt boundary

`sidecar.identityDigest` is SHA-256 over recursively key-sorted JSON of
`sidecar.identity`. Arrays preserve order. The payload binds:

- The exact public episode digest, original source/input/fixture references,
  caller-supplied upstream/transform/license provenance, source family, lineage,
  ancestors, task and fixture family.
- Split policy/version/seed, frozen component membership, project/compositional
  holdouts, and the full private source registry when one is supplied.
- Profile and v5 contract versions, projection options, executed capability
  profile, step/time/projection limits, and separate generation/input/guest RNG/
  schedule/split/optimizer seeds. Unknown seeds are explicit `null`.
- Exact Node/V8, OS/architecture/timezone, installed parser/TypeScript versions,
  npm lock digest and implementation digest of producer source and reference
  worker bytes.
- Producer revision, catalog/schema/fixture digests, private journal, replay,
  source-check/effect receipts and, for sessions, each component identity.
- Deterministic engineering evidence kind, zero optimizer steps and the absence
  of a learned-success measurement. Training results belong to separate runs.
- The expected native consumer revision, tokenizer identity and tokenizer-file
  SHA-256 whenever native qualification is requested.

The immutable payload excludes native receipts and admission status. After an
actual consumer accepts the episode, `bindNativeAdmission` separately binds the
receipt digest, policy digest, episode digest and immutable identity digest in
`sidecar.nativeBinding`. There is no self-referential receipt hash.

`recheckEffectfulAdmission` replays the exact private/public evidence, checks
metadata consistency and the runtime identity, recomputes the split, reruns the
three independent reference modes, and validates the native binding when
admission is required. Composed sessions apply the same invariant to every
component and the complete session. A changed implementation or environment
requires fresh collection/verification; the old identity is not relabeled.

Checksums establish integrity against a trusted external identity; they are
not digital signatures. A release must freeze its candidate identity digests
and shard hashes in an independently retained manifest. Pass that expected
digest to recheck rather than trusting a replacement file to declare its own
release membership:

```js
await recheckEffectfulAdmission(episode, {
  expectedIdentityDigest: releaseRow.identityDigest,
  nativePolicy: releasePolicy
});
```

The pinned companion's `semantic-native-admission/4` receipt still authenticates
public bytes and its existing native gates. The additional identity binding is
made by the producer and returned as `identityDigest`/`identityValidated` in the
source-admission receipt. No new companion-native signing or receipt schema is
claimed. Real native qualification must invoke the pinned consumer; synthetic
receipt fixtures in tests establish only boundary behavior.

## Split and provenance rules

The legacy family hash is explicitly `family-hash/1`. It keeps existing authored
fixture assignments. A supplied `source-components/1` identity is checked against
the full frozen registry: exact/normalized/literal-shape/near-clone relationships,
ancestor connections, pinned source bytes, holdouts and membership are rebuilt.
An episode must belong to its declared source family and every ancestor must be
in the frozen component. Renaming metadata does not bypass these checks.

Caller provenance describes origin; it is retained verbatim as private metadata,
not independently vouched for merely because the caller supplied it. Source
adapters must independently verify pinned original bytes, transformations and
license notices before requesting distribution. The identity makes those
assertions immutable and auditably connected to the actual executed source.

## Native API and deterministic randomness

Supplying `nativeConsumer` requires `nativePolicy` with all three exact fields:
`consumerRevision`, `tokenizerIdentity`, and `tokenizerSha256`. The producer
also requires an exact producer revision before native qualification or local
promotion. It rejects incomplete policies before calling the consumer. Tokenizer file hashes
and revision identities are compared exactly. Session components inherit the
same policy; lifecycle children use `bindNativeAdmission` for promotion.

The dataset split seed is `seed`; it is separate from `randomSeed` or
`seeds.guestRng`. The latter explicitly configures the existing deterministic
Math.random fixture in the owned runtime, original/instrumented reference
workers and selected program declaration. The actual guest seed is checked
against the journal. A missing guest seed refuses Math.random execution, and a
metadata seed that differs from the executed fixture is rejected. Different
seeds of the same source remain one source family but have distinct immutable
program declarations in a repeated session.

## Failure evidence and minimization

Failed production candidates return `failure` with schema
`semantic-candidate-failure/1`. Its immutable `original` retains exact source,
encoded input graph, fixture/schedule, provenance, seeds, limits, environment,
producer/policy identities, archive digest, reason and error details. Owned,
original-source, operation-instrumented and branch-instrumented observations
remain separate. The streaming collector retains these records as private
failure artifacts; they are not correct training targets.

Categories distinguish unsupported source, teacher/resource/deadline failures,
projection refusal, independent timeout/output/process/instrumentation failures,
outcome/computation/branch disagreement, identity rejection and native rejection.
Nonempty callback failures or unhandled rejections are refused explicitly until
the selected evaluation contract scores these completion obligations. A valid
root return alone is insufficient.

Reduce a retained failure without overwriting its original:

```sh
node tools/minimize-admission-failure.mjs failure.json minimized.json \
  --max-attempts 32 --timeout-ms 30000
```

The reducer deletes statements from trusted source and accepts a proposal only
when the production verifier reproduces the same first failure category and
phase. It preserves the original immutable record and attaches the reduced
source plus its fresh complete failure evidence. It reports a fixed case as
`not_reproduced`, and reports budget exhaustion honestly. It does not claim
global minimality or diagnosis of the underlying bug. The scheduling deadline
is checked between verifier attempts; each attempt also retains its own step
and timeout bounds. Native/process/resource failures are left for their proper
external diagnostic path instead of being represented as source reductions.

All native reference execution retains the existing trusted-source restriction.
The Node VM and a child process are not an OS security boundary for hostile
programs.

## Actual native provenance regression

`tools/check-native-provenance.py` is an opt-in integration gate that calls the
pinned companion's production preparation function with a real tokenizer and
fresh producer source rechecks. It requires one admitted single episode and
one admitted repeated session, and rejects dirty tracked producer/consumer
checkouts. It preserves all test inputs, source/native receipts, refusal reasons
and prepared control shards in its output directory.

```sh
TZ=UTC ../native-venv/bin/python tools/check-native-provenance.py \
  --corpus artifacts/engineering \
  --tracer-root ../immutable-producer-checkout \
  --consumer-root ../megatoken --tokenizer-json ../tokenizer.json \
  --output artifacts/native-provenance-regression
```

Use the exact timezone stored in the candidate environment. `--session` can
supply a separately admitted session when testing a small single-only corpus.
The output directory must be new to avoid reusing dedup state.

The [18 November 2026 measured receipt](evidence/native-provenance-2026-11-18.json)
records a successful real run: two untampered single/session controls prepared,
all thirty private metadata mutations rejected with public execution bytes
unchanged, and zero optimizer steps. The controls were generated at producer
`3a2178252a370c3d91c85d42751b2a4f82376bd4` and tested with consumer
`277edd4a2983e81f5e2a71b34a7ce29348e4e7a0`. This is a scoped regression receipt,
not a native qualification claim for every later producer revision. Subsequent
releases should rerun this gate at their own immutable revision.
