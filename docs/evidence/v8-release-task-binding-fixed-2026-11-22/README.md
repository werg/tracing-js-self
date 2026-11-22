# Original task binding correction

Source commit: local `17b49c2951b78584d726ced6922519d9fec16424`, tree
`704836c11a16ce49350157b2813c5c0677c4cd24`. Publication may use a different
commit identity with this exact tree. The native release verifier is unchanged
at the previously published `d4afac5bb7261aa7ef85c1d65d3ae6dcaf6caeef`.

## Observed controls

| Boundary | Result | Evidence |
| --- | --- | --- |
| Campaign history plus original task binding | 59 executable leaves passed, zero failures/errors/skips; Node reports 70 including parent containers | `node.log`, `node.xml` |
| Archive/wrapper controls after pinning the new binding helper | 17 passed, zero failures/errors/skips | `archive.log`, `archive.xml` |
| Unchanged original frozen 64-task packet | Verified, all 64 source-qualified attempts and current sources bound to their original task and registry member | `original-packet-control.json` |
| Previously accepted actual-artifact swap | Refused before source/native replay; adversarial journal bytes unchanged | `original-packet-control.json` |

The original-packet control uses exactly the preserved positive and negative
synthetic journals from `../v8-release-task-binding-red-2026-11-22/`. No asset
bytes or frozen task were rewritten to make the positive pass. Original source
artifacts are from the independently retained 175,381,869-byte primary archive
with SHA-256
`6dc909ecc1c1ed7401fa5ceb1cba7006c07641d530a1550f16a7870af3e483af`.
The red reproduction script records their extraction/reconstruction procedure.

The new Node controls independently generate actual pure, callback, repeated
session, child-teacher, direct protocol, mixed host protocol and module source
artifacts. They verify positive bindings and refuse changed source, entry,
argument, boolean/number type, family, ancestry, producer, task ID, RNG seed,
host fixture, teacher requirement, session order/omission/callback outcome,
registry relabeling, module graph/entry/export/plan-switch and module aliases
or ordered-call arguments. A campaign-level control reseals hashes and journal
results while returning a different source; its artifact mapping is refused.

The helper compares the task's semantic request before artifact replay. It
imports only neutral data-graph utilities; the isolated snapshot test passes
with all semantic compilers and old release tools absent. All registered tasks
must match their own complete frozen source/split identity. Distinct
`originalReferenceSource` transformations currently fail closed because the
transformed proof does not independently bind that original source.

An initial development control refused valid module artifacts because its
module-source ancestry used JSON-quoted string hashing. The source convention
hashes source strings as raw UTF-8; the correction uses that exact convention.
Both the initial failure and corrected module-control logs are retained. This
was a false refusal while implementing the fix; it was never a passing
qualification or published acceptance result.

Local runtime was Node 24.22.3 and Python 3.12.14, with the locked Python
dependencies. These controls do not assert the complete release environment:
the hosted workflow separately installs exact npm 11.9.0 and verifies all
runtime identities. The snapshot controls perform zero fresh source replay,
native admission, decoder forward passes or optimizer updates; the separate
Node source tests perform source execution only. Actual complete production
tokenizer package/restore qualification remains a separate frozen hosted gate.
