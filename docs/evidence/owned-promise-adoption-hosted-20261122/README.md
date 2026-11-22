# Original-source owned Promise adoption: exact hosted pair

The mandatory paired gate passed at producer
`90756c533ee04afc2a41d8890d979e94456f9243` (tree
`1652a93ff2e99d02a962d95f0c856317c02bb2fe`) and native consumer
`03a9e33866207b5b0c4105297c6050dacadcf85f` (tree
`0531e702beb88c5421907d6c41d078169ccd00b5`). This directory retains the
downloaded evidence, independently parsed counts and exact promotion map. It
does not qualify a later composition of either repository.

- Run: [45038584827](https://github.com/werg/tracing-js-self/actions/runs/45038584827).
- Job: `137257755308`; conclusion `success`; completed 2026-11-22 at 15:34 UTC.
- Artifact: `14760992166`, `owned-promise-adoption-exact-pair`, 292,896 bytes.
- Original ZIP SHA-256:
  `3a6f17dfd2751fee907fde165767c33184345dee720d34c0208fe62fea118ed2`.
- Required native controls: **104 passed, zero failures, errors or skips**.
- Required producer controls: **119 passed, zero failures, errors or skips**.
- Original-source coverage: **15 families, 15 actual native replays, 65 restored
  source cuts and 423 generated contexts**.
- Separate shared-realm public construction: **two invocation owners and 19
  contexts**, replayed by the actual native consumer.
- Optimizer updates: **zero**. Module admission and training admission: **false**.

The hosted job installed the locked producer and Python dependencies, checked
all six interoperability payloads plus the contract byte-for-byte, freshly
rechecked the source interoperability contract, required both exact test
populations, and verified that both checked-out trees remained clean. The
JUnit files independently contain 104 and 119 leaf test cases respectively.
The local pytest 9.2 subtest population recorded in the earlier local bundle
is not added to these hosted counts; this job used the locked pytest version.

## What this qualifies

An original executor resolution, async completion or reaction return can adopt
an owned Promise through the public and native shared FIFO. Assimilation and
forwarding remain two distinct queue turns. Source observation ownership,
first-call authority, precise target identities, pending forwarding waiters,
rejection, late resolver calls, ignored self-resolution errors, shared-realm
state and JSON continuation cuts are exercised by the frozen cohort. Native
replay checks every source-generated context and the final shared state;
source recheck independently rebuilds the evidence from the original program.

The two ordering families are deliberately distinct. Their exact original
source bytes and their complete 46-context artifacts are retained in the
compressed source evidence:

| Family suffix | Scheduling difference | Expected result | Original source SHA-256 |
| --- | --- | --- | --- |
| `source-fifo-microtask` | Settle the target before queuing the explicit microtask | `dqa` | `19455ae19e1cd2bc24e49016c2ceea33221b36511e918deb54313084b01d9b31` |
| `pending-forwarding-before-microtask-settlement` | Settle the target inside the explicit microtask, after forwarding has subscribed | `qda` | `c8750f9b72949daa5c4e6757352fbbda405624aa6f041f2bc06bcf5a3f664238` |

The pending case also asserts that forwarding waits while the target is
pending, the earlier direct target reaction precedes forwarding after
settlement, and the adopter reaction precedes its later await continuation.
Both original sources are included in the final dynamic native packet. The
canonical interoperability fixture set remains 23 source examples; these
numbers are different populations and must not be added together.

The contract definition digest is
`fd1e64f60ad5b6bb9431db3cd34513a5bd34041cdf7e710a99c5df1205502bf4`;
the interoperability digest is
`b004c2bde15007278d0c26189560ac0362530585f8b7d49d5b1999525fcce975`.

## Remaining boundary

This slice requires an owned Promise with the modeled intrinsic `then` lookup.
Callable thenables, changed `then` properties or getters, unmodeled prototype
changes, proxies, async reaction callback activation, reflected self-error
metadata and nonterminating mutual adoption remain refused. A fulfilled
forwarding value that itself requires another Promise adoption is not claimed.
Cross-invocation retained executor resolver capabilities still need a shared
first-call authority design; the separate two-owner public control uses an
async origin and does not close that older executor ownership boundary.

No production data denominator, packing cap, training cohort or model deadline
changed. This success supplies semantic/source/native replay evidence; it does
not substitute for qualification of the final combined recovery, target,
release and Promise source tree.

## Retained bytes and promotion

`manifest.json` records the original and stored SHA-256 for each file, exact
checkout identities, JUnit counts, and per-family original-source hashes.
Large JSON documents, the complete raw job log and the original ZIP are stored
as gzip plus base64. Decode with `gzip.decompress(base64.b64decode(bytes))`;
the resulting bytes must match the manifest's original hash. The source JSON
is 4,399,825 bytes with SHA-256
`b4f0d99ecdccc50e60361a2c6286a6faf8d421fac8d4d278cd8d1fd3e01a4252`.

`producer-promotion-map.json` records all 60 changed paths relative to the
Promise branch's source baseline: 27 implementation/test/payload paths, one
paired policy, one isolated investigation workflow, and 31 earlier evidence
paths. Each path has its baseline and qualified Git blob. The published
baseline is `ae5fa0f13fc8e8d8996cb6ff360c209ae2f83fa8`; its equivalent local
commit is recorded in the map. Compare those baseline blobs to the current
target before composing. Preserve later terminal, service, router, target,
release and historical evidence work. The map is a scoped application guide,
not authorization to replace a current branch with this older branch tree.

The frozen feature branch is unchanged by this documentation increment.
