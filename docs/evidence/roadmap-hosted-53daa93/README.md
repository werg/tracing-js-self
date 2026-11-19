# Hosted roadmap qualification at `53daa93`

All six primary workflows passed for producer
`53daa939dba0a0202402dc980a17a6682e719b37`, paired with consumer
`9a9dd3593c6887d63012dd5c953e914557dca386`. The five native corpus jobs and
the separate engineering archive restore completed successfully. The actual
model diagnostic also completed and **failed conditional parity**. Its
scientific verdict remains a blocker to interpreting a later run as a clean
convergence experiment; workflow success does not establish learned execution.

The [machine-readable qualification](qualification.json) and
[file inventory](inventory.json) bind the original receipts, logs and exact
checkouts. These results belong to the tested revisions below, not later
commits that contain this evidence. The initial roadmap milestone permits a
well-localized remaining model/interface blocker; later learning, transfer,
scale and public-release gates remain separate.

## Exact source identities

| Execution | Checkout | Source tree |
| --- | --- | --- |
| Primary native corpus, paired input and restore | `53daa939dba0a0202402dc980a17a6682e719b37` | `47b2d97cfd7e6197a08a82274e8a701041a8d36e` |
| Primary unit and auxiliary workflows | PR merge `6b9acf98e14f73a5865b4b38ac0390f119f101ab` | `47b2d97cfd7e6197a08a82274e8a701041a8d36e` |
| Companion CPU workflows | PR merge `b216f13dc1cbb7209b0fc6028a26db62120cf1fe` | `36cc04b9bfdcb038cabf63cda96839839e4748ce` |
| Pinned companion head | `9a9dd3593c6887d63012dd5c953e914557dca386` | `36cc04b9bfdcb038cabf63cda96839839e4748ce` |

Both merge objects were fetched and their tree equality was independently
checked. The original job logs retain the actual checkout revisions. See
[identities.json](identities.json).

## Executed checks

| Check | Result | Original run |
| --- | --- | --- |
| Node 20.20.2, 22.23.4 and 24.22.2 | Each: 1,013 tests; 1,006 passed, zero failed, seven skipped | [44390718006](https://github.com/werg/tracing-js-self/actions/runs/44390718006) |
| Native release/diagnostic Python regressions | 132 passed, eight skipped | [44390718053](https://github.com/werg/tracing-js-self/actions/runs/44390718053) |
| Native capability subset | 19/19 probes admitted under the pinned consumer and production tokenizer | [44390718053](https://github.com/werg/tracing-js-self/actions/runs/44390718053) |
| Selected runtime and browser | 94 adapter tests and one actual Chromium test passed | [44390717993](https://github.com/werg/tracing-js-self/actions/runs/44390717993) |
| Trace inspection and independent teacher mutations | Node batches 15/15 and 56/56; Python batches 10/10 and 9/9; 13/13 mutants caught; eight source-trace inspections | [44390718021](https://github.com/werg/tracing-js-self/actions/runs/44390718021) |
| Reference/scalar arithmetic | 12/12 reference probes and 1,958/1,958 arithmetic probes reconstructed and replayed | [44390718113](https://github.com/werg/tracing-js-self/actions/runs/44390718113) |
| Paired adapter inputs | Actual observed bytes, framed controls and declared track purpose match before neural execution | [44390717908](https://github.com/werg/tracing-js-self/actions/runs/44390717908) |
| Companion CPU suites | Python 3.11 and 3.12 each: 2,906 passed, zero failed, 50 skipped; lint, package/CLI and locale checks passed | [44386208384](https://github.com/werg/megatoken/actions/runs/44386208384) |

The reference workflow retains its expected Test262 gaps: 11 selected,
nine executed, four passed, five known failures, two skipped, zero unexpected
results. The separate scalar variants have six passes, two unsupported cases
and eight omitted strict variants. This is bounded conformance evidence.
The optional companion Blackwell hardware job was skipped.

The engineering selected-harness cohort also completed 8/8 whole cases with
valid traces. Its original report explicitly says `origin: controlled`,
`acceptance: false` and `learnedSuccess: null`; this is an infrastructure check.

## Native corpus and coverage accounting

Every row below passed the source/native, packaging, complete native
reconstruction and coverage workflow. Each recipe is its own denominator;
their rows, families and components must not be summed as unique programs.

| Recipe | Source attempts | Native admitted | Omissions before preparation | Native preparation inputs | Native exclusions | Prepared accepted |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| engineering | 25 | 25 | 0 | 25 | 0 | 25 |
| training-v4 | 50 | 50 | 0 | 50 | 0 | 50 |
| benchmark-v1 | 128 | 128 | 0 | 128 | 0 | 128 |
| real-source | 210 | 180 | 71 | 109 | 9 | 100 |
| generated-v1 | 64 | 64 | 0 | 64 | 3 | 61 |

Real-source retains 30 source nonadmissions: ten independent completion
mismatches, 18 unsupported cases and two unsupported source cases. Its full
accounting is `210 - 30 = 180`, `180 - 71 = 109`, `109 - 9 = 100`. The 71
omissions are relative to the admitted population, before native preparation.
Generated-v1's three native exclusions are duplicates. Admitted
family/component counts are engineering 20/20, training-v4 16/16,
benchmark-v1 42/38, real-source 90/35 and generated-v1 16/16.

Directly retained original coverage reports establish:

| Recipe | Prepared training rows | Coverage-selected training rows | Scored training positions | Evaluation rows preserved |
| --- | ---: | ---: | ---: | ---: |
| engineering | 19 | 18 | 7,218 | 6 |
| training-v4 | 43 | 43 | 24,065 | 7 |
| generated-v1 | 43 | 43 | 54,117 | 18 |

These selections lose no measured training feature or family. Engineering
retains all 55 measured training features and 15 training families. The
equally sized identity-ordered control retains 52 features with 6,918 scored
positions; the coverage selection preserves repeated invocation and its
interactions with await/pending. Both controls have explicit token budgets;
this comparison does not establish optimizer exposure or a learning gain.

Benchmark and real-source completed their coverage jobs, but their full
artifacts are 1,027,025,111 and 844,662,195 bytes respectively, above the
artifact reader's 536,870,912-byte limit. Their original job logs, emitted
JSON receipts and artifact identities are retained. Detailed final coverage
membership is **unavailable in this compact receipt** and remains `null`.
Earlier-run or pre-deduplication selection counts were not substituted.
The containing follow-up adds separate compact-report uploads for future
workflow runs; it does not retroactively recover these two reports.

All recipes have zero optimizer updates. Actually consumed target coverage
remains unavailable. See [engineering](engineering),
[corpus receipts](corpora), and the aggregate [qualification](qualification.json).

## Actual model measurement

The [original final report](engineering/native-conditional-probe--report.json)
and [comparison](engineering/native-conditional-probe--comparison.json)
repeat the earlier `cb67ed1` diagnosis at the current producer/consumer pair:

- The same physical, zero-update seed-17 checkpoint is authenticated across
  both paths; served reload is exact and dropout is disabled.
- All 256 Gaussian mean/log-scale coordinates are compared at absolute and
  relative tolerances of `1e-6` and `1e-5`.
- Maximum absolute difference is **2.4304623007774353**. The first mean differs
  from `-0.24988460540771484` in training to `0.02719087339937687` in serving.
- Encoded request controls match, but the actual metadata, track ownership
  and lifecycle histories differ. The
  [earlier boundary analysis](../native-conditionals-cb67ed1/README.md) localizes
  those differences; a repaired byte interface alone does not make model
  conditioning equal.
- Capture stops before the Gaussian facet draw and downstream rendering.
  Serving already executes its earlier singleton text-modality categorical.
- Declared length support also differs: training `0..1024`, serving `1..128`.
  Loaded lexical alphabets agree; downstream categorical execution remains
  unmeasured.

Zero semantic selections were returned and no optimizer update ran. This is
an integration repeat at the same seed/checkpoint, not an independent
learning seed. The complete original source and serving capture are stored
losslessly in [engineering-full-conditionals](engineering-full-conditionals),
alongside original training vectors, checkpoint metadata and export identity
in [engineering](engineering). No vector entries were discarded.

## Separate hosted archive restore

[Restore job 135118194072](https://github.com/werg/tracing-js-self/actions/runs/44390718053/job/135118194072)
downloaded the engineering artifact in a separate GitHub-hosted job and
verified archive SHA-256
`9a1f040d53682b65e9f698aeaa34ee8eb321a6f5b7e7dc7452811837e5e80b05`.
All **200 files / 312,325,944 bytes** passed the inventory check. All **25
positive attempts** passed original-producer replay, with zero failures and
no admission or artifact mutation.

The runtime matched Node 24.22.3, V8 13.6.233.17-node.63, npm 11.9.0,
Linux/x64, UTC and C.UTF-8. The mismatch map is empty. Original receipts are
[restore.json](restore/restore.json) and
[hosted-job.json](restore/hosted-job.json).

The restorer alone leaves `freshMachineQualification: false`; the separate
hosted-job receipt supplies the external runner/job identity. Prepared data
is checked as an archive inventory, and original-policy native
requalification remains explicitly `untested`. This does not qualify an
aggregate production runner or immutable container image.

## Retention and evidence boundaries

The [inventory](inventory.json) maps each committed payload to its decoded
size and SHA-256. Large JSON and log payloads are losslessly gzip-compressed.
Normalized GitHub API snapshots are labeled separately from original decoded
job logs and original artifact members. Incidental restore compile caches
are omitted.

The small paired-input and restore ZIPs were downloaded in full and their
SHA-256 values independently checked. Selected engineering/generated/training
artifact members were obtained through bounded range reads, checked by ZIP
CRC and their own measured SHA-256; the whole ZIP digests for those partial
downloads remain explicitly API-reported. No complete-download claim follows
from a partial read.

Complete private audit archives remain attached to the native workflow with
90-day retention, expiring on 16 February 2027. Compact receipts and logs are
committed here. The paired-input artifact has a 30-day retention period; its
complete original candidate and report are also retained here. None of this
authorizes public dataset distribution or turns a controlled fixture or
failed model comparison into a learned-execution result.
