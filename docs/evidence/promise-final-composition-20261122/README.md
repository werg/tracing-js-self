# Frozen Promise composition and async-only assertion reconciliation

The implementation uses one shared Promise resolution procedure and one FIFO.
The canonical `promise.adopt.enqueue`, `promise.adopt.enter` and
`promise.adopt.forward` records handle the relevant resolution causes. The
earlier `async.resolve.*` proposal is not a second queue in this composition.

The frozen source maps contain exactly **30 producer paths** at
`3062bf64284f049735fb6f409f78600cc5340687` and **14 native paths** at
`6a8c27e0afb3b038d0f1431e87a821ca4f4c7dc7`. Every mapped producer target
blob matched its baseline at `7dc23f9d15d9fc0b4ed434ab90a8b1635e7e3982`;
every mapped native target blob matched its baseline at
`622c37c23f93c4cc58ff226eb4805c766fee3166`. Recheck these comparisons at
integration, preserve independent recovery/release changes, and bind the
producer policy to the finally composed native commit.

The native candidate changes only `tests/test_async_call_v8.py` relative to
canonical native `03a9e33866207b5b0c4105297c6050dacadcf85f`. The latest
producer additions preserve assertions in existing/new tests; product source
remains that of the published object guard
`95907736f46488662bc4f2bb5625abb9459d0f86`. Neither the seven shared payloads
nor the canonical digests change during assertion reconciliation.

## What was retained from the async-only proposal

The audit compared producer
`7fe5a9d57fbf456f0165534f089116b4b5db7279` and native
`859f7763c63afee48f40ec78bd280b0811bd9046`. The old native file contained
four resolution-specific tests in addition to the existing async base; the
old producer public file contained six resolution-specific tests. Test counts
from those alternative implementations are historical evidence and must not
be added to canonical counts.

| Original assertion | Disposition in the shared procedure |
| --- | --- |
| A returned owned Promise remains pending through assimilation; earlier direct reactions and ordinary jobs precede forwarding, while result reactions precede a later await. | Existing public async adoption ordering tests, common native adoption/FIFO tests, the native async returned-Promise test and original-source continuation replay exercise the shared procedure. |
| A pending target registers its observer before settlement and preserves reaction registration order. | Existing public pending-target async test and common native pending adoption test preserve the ordering; restored source cuts additionally replay the resulting states. |
| Wrong body/target, skipped turns, premature settlement, generic dispatch, and forged status/value cannot mutate state. | Existing public async completion/adoption and forged-adoption tests, native async forged-resume tests and shared resolution-intent/guard tests retain the distinct invariants. The original async body is now carried by the retained adoption cause instead of repeated `async.resolve.*` fields. |
| An external Promise or modified intrinsic `then` is refused before adopting it. | Common intrinsic-Promise ownership checks are shared by async completion and resolver calls. Public negative intrinsic tests and native executor controls cover external/own-property/prototype boundaries; source mutation controls prevent unmodeled lookup. |
| Future settlement identities cannot collide with ordinary jobs or a second async return. | The old format reserved a second identity at enqueue. The shared format first publishes the forwarding identity at `promise.adopt.enter`. Two new public/native controls check atomic collision refusal against an ordinary job, either assimilation job and another adopter's published forwarding job, with restoration between turns. The nonexistent old `reserved` phase is not restored. |
| Throwing an owned Promise keeps it as an opaque rejection reason. | Two new public/native controls complete an async body with `throw ref`, restore its state, verify no adoption or jobs, reject invented adoption atomically and preserve the target's value. |
| Restored cuts retain body, observer, job ownership and exact metadata. | Existing public restored-async and malformed-adoption controls check body, owner, cause, target, phase, FIFO sequence and extra metadata. Native shared adoption state validation checks queued/observing/ready/final states, changed targets and noncanonical retained job fields. The old reserved-row checks apply to existing canonical adoption/forwarding rows, not a retained alternate representation. |
| Direct self-resolution should not silently adopt itself. | The old proposal refused async self-resolution as unsupported. Canonical resolution instead has the explicit `promise.adopt.self` TypeError transition, source correspondence and native/public checks; distinct mutually adopting Promises remain pending. The old refusal expectation is intentionally superseded by this qualified semantic behavior. |

The ten original baseline async source programs remain unchanged in
`test/semantic-async-call-source-v8.test.js`, along with the existing
ownership, rehashing, observer rollback, receiver/capture and callable-thenable
refusal assertions. The two additional original `qa` and `dqa` ordering
programs are preserved byte-for-byte in
`test/semantic-async-return-adoption-composition-source-v8.test.js`.
The separate original-source map records both SHA-256 hashes, obtained by
parsing and comparing the literal case arrays. These two programs contribute
nine restored cuts and 78 actual-native contexts. The binding control names
the original async body/target and both shared job identities and explicitly
excludes `async.resolve.*` records.

The old lookup-control family is reconciled separately. Own `then` assignment
and accessor, prototype mutation and `Promise.resolve` replacement remain
refused through the existing computed-key/alias descriptor cohort. A local
parameter named `Promise` is an ordinary binding; the old blanket shadowing
refusal was not a sound ownership rule. Its original program is a positive
source/native control in that cohort. Plain async values and unrelated object
writes remain positive through the baseline async cases and the unrelated
write controls. Those equivalent positive assertions are retained; the two
old plain-write literal programs are not represented as exact original-source
replays. The original getter source and new derived computed/alias programs
are identified separately in the earlier source packet.

## Evidence and the required combined gate

The exact hosted object guard gate `45042386283` passed 167 producer and 104
native cases with zero skips. Its downloaded original artifact and complete
log are in `../promise-object-profile-hosted-20261122/`.

The additional original-source composition group passed all four local tests,
with zero skips. After the two final public-boundary controls were added to
each implementation, the producer adoption group passed **20/20** and the
native async group passed **10/10**, again with zero failures, errors or skips.
The test files were run uncommitted and then committed unchanged; these are
focused local results, not a clean-tree whole-pair hosted result. Their raw
logs and JUnit files are retained under
`../async-return-adoption-composition-20261122/` and hashed by this packet.

The required final Promise union is therefore **173 producer / 106 native**.
The final combined pair also needs the independent recovery and release
groups. These maps deliberately mark final combined qualification as pending;
they cannot promote an older 167/104 run to the new combined revisions.

Named source cohorts remain separate: canonical adoption 15 programs/65
cuts/423 contexts; earlier descriptor guard 24 programs/19 refusals/96 native
contexts from five positives; new object guard 22 programs/17 refusals/51
native contexts from five positives; two exact original async-return sources
with nine cuts/78 contexts. Overlap is not converted into corpus or admission
coverage. Public shared-realm FIFO evidence also remains its distinct
two-owner/19-context packet.

Queued callable thenables and retained resolver calls across owners are still
separate contract work. The current controller-local resolver capabilities
cannot be described as a complete shared ownership protocol merely because
the Promise heap is shared. This composition makes no such claim and adds no
optimizer updates, data/module admission or learned-quality claim.
