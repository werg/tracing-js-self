# F targeted campaign: one serial retry at the original limits

The targeted frozen-F campaign originally admitted 58 of its 60 candidates. Two
small knapsack cases reached the declared 120-second outer worker deadline under
two-worker collection. After preserving the complete initial manifest, journal,
campaign identity, original log, case selection, and all 287 stored object hashes,
we retried only those two failures once with one worker. The campaign identity,
60-case selection, producer, consumer, and all declared bounds stayed unchanged.

| Candidate | Original disposition | Second attempt | Wall time | Peak worker RSS |
| --- | --- | --- | ---: | ---: |
| `real-exercism-0e73ec6590286b1234d675be` | `worker_timeout` | `admitted` | 87.035 seconds | 439,095,296 bytes |
| `real-exercism-5bde2c9a9a957ff0cc18af5e` | `worker_timeout` | `admitted` | 100.700 seconds | 446,873,600 bytes |

The final campaign is **60 attempted, 60 admitted**. It contains 62 append-only
attempt records: the original 60 and exactly two second attempts. The original
journal is an exact byte prefix of the final journal. The initial 58 admitted
manifest rows are identical; every old CAS object retains its original digest.
The two candidate identities and source/input references are unchanged.

Bounds remain 120,000 milliseconds per outer worker, 768 MiB worker heap,
268,435,456 output bytes, and the candidates' 20,000 owned-step budget. No timeout
or step limit was increased. These two cases each have five items and capacity
ten; they are distinct from the larger knapsack inputs excluded by the separate
compiler-only step-budget review. No claim is made that increasing concurrency
or rerunning other timeout cases will succeed.

Exact pins:

- Producer: `22eaac6a46e262b00986c63b4fc66f6240016252`.
- Consumer: `1cee21dd07a687b0a824abff1bbd5ef9a13149ab`.
- Campaign identity: `216249912eaafeaaae49654d73834229521560795c78b0583f6f5977f3a41732`.
- Tokenizer file: `40fb9d7d7795b8bd305aeff39ce9963f3f450915b9553f2938e009be9a1fed60`.

The resumed command, run from the immutable F checkout, was:

```sh
TZ=UTC LC_ALL=C.UTF-8 OMP_NUM_THREADS=1 MKL_NUM_THREADS=1 \
TMPDIR=/workspace/scratch/23f61543c052/release-evidence-F/tmp \
node tools/generate-effectful-training.mjs \
  --recipe real-source --source-stream utilities,exercism,production \
  --per-family 12 --jobs 1 --compact-storage \
  --registry ../release-evidence-D/source-registry.json \
  --case-ids ../release-evidence-D/fresh-F-case-ids.json \
  --out ../release-evidence-F/requalification \
  --megatoken ../megatoken-capture-bindings \
  --python ../native-venv-capture/bin/python --tokenizer ../tokenizer.json \
  --native-policy contracts/native-admission-policy-v5.json --require-native \
  --resume --retry-failures
```

The original process had completed before retry. Inspection of the durable
journal and `CampaignStore.cached` established that exactly the two timeout rows
were eligible; the command reused all 58 admissions. A post-run audit verified
the hashes, original row equality, new entry IDs, unchanged candidate digests,
attempt numbers, bounds, case selection, and campaign identity. Its complete
result and initial snapshot are committed here. The final original campaign,
including both failed attempts and both admitted retries, remains at
`release-evidence-F/requalification` and accompanies native packaging as the
required audit campaign.

Before selection, the current selector's five focused tests and the full-native
equivalence tool's four focused tests passed. An initial test invocation lacked
a writable `TMPDIR`; its first test failed with `/tmp` unavailable. That log is
preserved alongside the successful run using the workspace temporary directory.
No code or test expectations changed to obtain the pass.

This is source/runtime/native admission evidence. It uses no model inference or
optimizer updates and establishes no learning result. Native preparation and
archive verification are recorded separately when complete.
