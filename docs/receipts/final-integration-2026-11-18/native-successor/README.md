# Completed hosted native qualification — 18 November 2026

All five lanes of [native run 44321402524](https://github.com/werg/tracing-js-self/actions/runs/44321402524)
passed. Each lane's retained identity record binds actual producer checkout
`1e2e6a0de8952c4349edbeef46ab70c4a06f8157` and consumer
`6b4382b9af3bef120ca3a95ae24d35154d4cd66b`. The separate workflow trigger is
synthetic merge `3497ee3454ea75715db1bc50c3e7cfc35ecc0fc2`. Merged main
`0c307781fea0fa3fca58f1dec037c8653cc921e0` has exactly the producer's tree.
The [completion summary](summary.json) preserves each lane's separate population.

| Recipe | Attempted | Admitted / freshly qualified | Training selected / excluded | Held-out supplied | Distinct prepared within release | Retained duplicate aliases |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Engineering | 25 | 25 / 25 | 19 / 0 | 6 | 25 | 0 |
| Generated-v1 | 64 | 64 / 64 | 44 / 0 | 20 | 61 | 3 |
| Training-v4 | 50 | 50 / 50 | 43 / 0 | 7 | 50 | 0 |
| Benchmark-v1 | 128 | 128 / 128 | 94 / 0 | 34 | 128 | 0 |
| Real-source | 210 | 190 / 190 | 71 / 81 | 38 | 100 | 9 |

The lanes sum to **477 attempts, 457 admissions and fresh qualifications, and
364 within-release distinct prepared examples**. A deduplicated union across
recipes was not measured. Family/component counts overlap and must not be
summed as independent global coverage. Training cap exclusions retain their
original admitted disposition; all held-out inputs are supplied unchanged.
Real-source retains **18 unsupported and two source-unsupported refusals**.
Training-v4 includes 48 authored fixtures and two admitted lifecycle children.

The engineering lane passed all **17 capability probes** at the six measured
source/owned/reference/projection/native stages. Its model-evaluation stage
remained untested for all 17. Its eight controlled selected-execution cases
were correct and trace-valid, its five native orchestration cases passed, and
its hard-gate violation counts were zero. These engineering measurements had
zero optimizer steps and `learnedSuccess: null`; they are separate from the
failed free-running trained-model experiments.

## Original logs and separate diagnostic workflows

[index.json](index.json) binds all 18 unchanged copied files by size and
SHA-256: the five complete native job logs and parsed summaries, the complete
Node 24 unit log and summary, and the complete Exercism diagnostic log and
summary, plus the complete real-world observation/audit logs and summaries. The logs preserve the original command lines, installation/runtime
output, per-step results, source identities and release verification output.
The GitHub artifact ZIPs and their member-level receipts are preserved
separately; a copied successful log is not a replacement for its artifact.

The Node 24 job in [unit run 44321402701](https://github.com/werg/tracing-js-self/actions/runs/44321402701)
tested synthetic merge `3497ee3`, with **909 tests: 902 passed, seven skipped,
zero failed**. Two skips came from the hosted runner's UID-map `EPERM`; five
required the native orchestration environment. The native lane executed those
five cases, and [separate exact current local isolation](../isolation-1e2e6a0.json)
passed 3/3 with zero skips. These separate results retain their own denominators.

[Exercism run 44321402501](https://github.com/werg/tracing-js-self/actions/runs/44321402501)
passed as a diagnostic: **361 attempted, 132 locally verified, 229 refused,
zero newly admitted**, with 20 attempted and ten verified exercises. Novelty
selection rechecked all 132 rows and retained 61 distinct paths across ten
families. Its older diagnostic profile still refuses JSON BigInt outcomes and
abrupt completions. Those categories do not override the separately proven
native Grains/valid-error capability or become native admissions.

The real-world corpus workflow subsequently passed its observation job, all
six verification partitions and final audit. It accepted **936 invocations
across 78 functions**, with zero mismatches/throws/errors, 27,039 observation
events and 3,656 mutation events. The initial owned subset verified 156/156
invocations; the final audit verified **936/936 locally** with no refusal rows.
These remain diagnostic local results, not native admissions or model outcomes.
The original observation and audit logs and parsed summaries are included here.

The [final hosted snapshot](final-hosted-snapshot.json) records all seven
producer-head workflows completed successfully at 14:44:48 UTC, together with
the separate successful benchmark byte-preservation workflow and dated PR
metadata. The initial snapshot's queued state remains historical evidence of
when it was taken. The original failed
`aa7b843` native matrix and exact temporary producer remain in the
[failure receipt](../native-aa7b-failure/README.md). This successful successor
does not overwrite those failures or attribute its repaired implementation to
their original runs.

The later [final repository snapshot](final-repository-snapshot.json) at
14:56:41 UTC records PR40 ready/open/mergeable, PR31 merged, and the active
independent PR39 still open/unmerged/conflicted. It does not replace the earlier
workflow snapshot or relabel any producing revision.
