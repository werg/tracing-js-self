# Comprehensive Tinker follow-up validation

Date: 2026-11-25. Device: tick. Repository: `/home/werg/tracing-js-self`.
Branch: `codex/tinker-inkling-training`.

The complete implementation slate is described in [the scope checklist](TINKER_FOLLOWUP_PLAN.md)
and [experiment guide](TINKER_EXPERIMENTS.md). This record covers the finished
follow-up code and its local verification. The [initial infrastructure record](TINKER_VALIDATION_INITIAL.md)
remains available as historical evidence.

No model was sampled or trained during these checks. A fresh capability preflight
failed because tick has neither `TINKER_API_KEY` nor stored Tinker CLI credentials.
The implementation, data, local renderer and launch workflow are ready; model
access, the live contract/learnability gate and actual performance remain unverified.

## Implemented and checked

| Area | Result |
| --- | --- |
| Reward and optimization | Compression pressure remains proportional to its coefficient after correctness normalization; separate SFT/RL rates, example/token weighting, explicit IS/PPO and optional fixed-SFT sampled-log-ratio regularization. |
| Protected evaluation | Explicit/frozen populations, independent split/evaluation/training seeds, validation selection, accuracy gates, rollback, complete token costs and component-cluster paired intervals. |
| Supervision | Causal full/compact/actions-only targets, actual replay audits, divergence-prefix privacy checks, supplied-conversation auditing and zero observation loss under the installed renderer. |
| Curriculum and diagnostics | Tier progression with rehearsal, useful/zero-signal groups, failure taxonomy, exact sampled-token categories, supervised target loss by action/length/tier/feature. |
| Experiment orchestration | Baseline effort/prompt grid; SFT-rate, trace and RL-rate stages; SFT/correctness-RL/compression-RL controls; repeat seeds; immutable final-test seal and evidence validation. |
| Update durability | Exact update inputs and fsynced ledger, pending markers, per-update optimizer/sampler receipts, local receipt repair without reissuing an update, and explicit refusal of unresolved outcomes. |
| Packaging and CI | Locked CPU installation, working `tinker-study` entry point, both SDK and dependency-free test paths, CLI preparation, bounded CI fuzzing and manual full verification. |

The review also fixed runtime/producer defects exposed by the work: String
`codePointAt` support and native String exception conversion; conditional
narration confusing a VM jump decision with the source condition; audit CLI
unwrapping that could discard supplied messages; diagnostic preparation that
could overwrite previous live-work evidence; and named ablations inheriting an
incompatible objective. Regression tests cover each repaired path.

## Final test and preparation results

| Check | Observed result |
| --- | --- |
| JavaScript training/benchmark/audit regressions under pinned Node | 52/52 passed |
| Python suite with installed Tinker SDK and actual renderer | 133/133 passed |
| Python suite without optional SDK dependencies | 127 passed; 6 SDK-specific tests skipped |
| Existing repository contract gate under Node 24.22.3 | Passed |
| New optimizer fault-injection tests | 9/9 passed; included in the Python total |
| Study orchestration/provenance regressions | 22/22 passed; included in the Python total |
| Starter complete local executions | 36/36 passed |
| Starter SFT datums rendered / maximum size | 20 / 981 tokens |
| Starter initial prompts / maximum size | 36 / 707 tokens |
| Standalone probe preparation | 12 rendered examples; no model sampling or updates |
| Actual CLI study planning | Passed; explicit frozen splits and no model results |
| Authenticated capability prerequisite | Blocked by absent credentials; zero model compute |

The Python tests include real Node-worker integrations and installed Inkling
rendering. Model responses and recovery failures in tests are explicitly labeled
fixtures; they cannot be promoted into model-performance reports. The full
contract gate was run after the runtime fix. Later changes affect training and
benchmark tooling, not the contract implementation.

## Qualified corpus and independent verifier

Every one of the 2,137 initial candidates was evaluated. The build admitted
2,103 and retained 34 upstream refusals; all 1,720 authored candidates were
admitted. Input variants and source wrappers remain in their connected lineage.

| Main split | Execution cases | Distinct source programs | Independent source/lineage components |
| --- | ---: | ---: | ---: |
| Training | 758 | 270 | 62 |
| Validation | 495 | 127 | 25 |
| Held-out test | 617 | 185 | 36 |
| **Total** | **1,870** | **582** | **123** |

The test population exceeds the predeclared minimum of 30 components. Its 617
cases are not 617 independent source families. The familiar-program diagnostic
contains 227 novel inputs from training programs, with six exact training-input
duplicates explicitly excluded and recorded. The longer/composed challenge
admits 12 of 14 candidates across 12 components. Two candidates hit the
source-reference deadline; their refusals remain visible and are not treated as
established semantic disagreements. These diagnostics cannot train or select.

The definitive fuzz gate passed all **10,000 cases**, with **zero failed cases**,
**10,000 independent checks**, **30,000 accepted positive controls**, and
**53,781 rejected observable corruptions**. The verifier uses its own readable
decoder, graph snapshot and native boundary recorder instead of the production
fixture broker and graph codec. It checks literal observations as well as final
state, completion and ordered effects.

These are seeded cases from **16 bounded profiles**, not 10,000 independent
program families or a claim to cover arbitrary JavaScript. The negative controls
cover wrong results/kinds/mutations, incompletion, copied aliases, missing/extra/
reordered effects, wrong calls, undefined, array holes and negative zero.
Positive controls accept correct actions with omitted internal steps or changed
narration. Resume checks task/seed identities and the sealed record prefix;
unreceipted tails are preserved and rerun.

All final corpus, fuzz and census receipts record `codeChangedDuringRun: false`
and zero actual model samples. The frozen corpus and its admission/evaluation
manifests are committed in `training/fixtures/expanded/`.

## Workload admission census

The census considered **466 existing candidate executions** from the declared
repository inventories, admitting **390 (83.69%)** and retaining all 76 refusals.
It covers 183 named families; it is a separate coverage denominator from the
expanded generated benchmark.

| Refusal category | Candidates |
| --- | ---: |
| Callback execution profile | 60 |
| Source/runtime profile | 12 |
| Unsupported source | 2 |
| Concurrent observations | 1 |
| Subscriptions | 1 |

Utilities admitted 156/156, Exercism sources 26/40, production sources 14/14,
and existing repository fixtures 194/256. The largest uncovered category is
callback execution. These counts provide a concrete priority signal for later
profile expansion; they do not measure a deployment workload.

No stored real agent trajectories were present in the enumerated inventory.
The census CLI accepts supplied trajectories carrying an attached executable
task. Model execution accuracy and original agent-goal success remain null;
executor admission does not establish either one.

## Expanded supervision audit

A feature-stratified sample of 35 tasks from the final 1,870-case corpus produced
105 audited conversations across all three formats. All replayed successfully.
Three format-specific divergent-prefix checks passed. The audit retains the
actual messages for inspection, including local spot checks of `finally` cleanup,
shared input/result aliases and branches following external observations.

| Format | Conversations | Assistant UTF-8 bytes | Narration lines | Observation bytes |
| --- | ---: | ---: | ---: | ---: |
| Full | 35 | 24,582 | 508 | 2,104 |
| Compact | 35 | 15,183 | 227 | 2,104 |
| Actions only | 35 | 6,578 | 0 | 2,104 |

These are teacher-data byte counts. They do not measure generated model tokens,
learning quality or inference savings. Observations remain identical across
formats; removed narration is absent from the conversation.

## Complete pilot preparation

The full staged study is frozen at `runs/tinker-study/plan.json` on tick. It binds
all 1,870 main cases, 227 familiar-input diagnostic cases and 12 challenge cases.
Selections contain every training, validation and test ID. Validation contains
495 cases and test contains 617; test remains held out and no study job has sampled
a model. Training jobs default to `final_test: false` until final study selection.

| Pilot preflight | Observed result |
| --- | ---: |
| Complete fixture replays | 1870/1870 |
| Actual SFT datums rendered | 758 |
| Largest SFT datum | 19,216 tokens |
| Initial rollout prompts rendered | 1,870 |
| Largest initial prompt | 1,191 tokens |
| Reserved output per turn | 2,048 tokens |
| Configured context budget | 65,536 tokens |
| Local setup ready | true |
| Model samples / optimizer updates | 0 / 0 |

The largest required protocol length (external calls plus completion) is
6 turns in the main corpus,
5 in familiar-input diagnostics and
1 in challenges. All fit the configured
8-turn limit.

Plan hash: `9736288205f08a49e2e1816692dcf7c004323d2c0c2bc49e3f0c2c51fa91fbcf`.
Frozen main-input SHA-256: `7e7f6a15fe90a45f502e93e6d22137cca176ee21b6b1a4a1055775eab6a68aa6`.
Exported main-dataset hash: `e987af586d77be31d5032b086f3a67f9a3738d73c0981e1f6daebfcdbfd6eeeb`.

The [evidence archive](evidence/tinker-followup-20261125/README.md) contains the
exact plan, complete preflight and preparation summary, verifier/census reports,
supervision summary, runtime-budget diagnosis, authentication prerequisite and
test-log digests. `index.json` binds the archived file contents. The original
plan and all full raw records remain on tick; no model-performance report was
substituted for missing live results.


## Runtime budget found by the complete pilot export

The initial full pilot export stopped at its 60-second local bridge deadline on
recursive Collatz `steps(1000000)`. The task had already qualified, with a recorded
126.151-second wall time in the concurrent build. An isolated export then
succeeded in **86.221 seconds**, producing 59,434 serialized bytes and a passing
causal/replay audit. CPU profiling attributed most time to runtime snapshot
cloning, equality and diff operations; serialization took about 0.258 ms.

The pilot now uses **`bridge_timeout_seconds: 300`**. This is an explicit outer
request bound for local preparation. Inner task timers are cooperative and cannot
interrupt synchronous snapshot processing. The evidence archive preserves the
original timeout, successful isolated export and profile digests. Source inputs,
admission decisions and verification semantics were not changed by this budget
adjustment. Complete pilot preparation can take tens of minutes on tick.

## Content identity and reproducibility

The final mini preparation bound 327 runtime, Python and dependency-lock files
to implementation SHA-256
`73d130ae89df1fcb47e18d6076265ce695a9fb052241ffb106bdf662d7ef277d`.
Its exported dataset hash is
`9ce7d892cf5d06611689f0d83802e2fc0c395eac5885f359f5232ffb098ee49f`.
Git commits and documentation changes do not alter this enforced source identity.

The expanded-corpus and fuzz tools additionally bind all enumerated `src/` and
`tools/` sources plus the Node package files. Their final implementation identity is
`d7509068d530f508529249f528aff30dd44e65c1b0a271895d51439723937905`.
Each receipt records its start/end identity, runtime, seed, exact input counts,
output digests and whether sources changed during the run.

The installed environment uses Tinker 0.40.0, tinker-cookbook 0.7.1,
tml-renderers 0.4.2, CPU PyTorch 2.15.0+cpu and renderer `tml_v0` for
`thinkingmachines/Inkling-2-Mini:peft:65536:free`. The reference contract and final
JavaScript suite used the pinned Node 24.22.3. The final corpus, fuzz and census qualification also used Node 24.22.3.
The mini preparation and installed-SDK worker integrations additionally passed
using tick's default Node 22.22.1. The validation index retains runtime
and log digests with the final receipts.

## Reproduce or start the live work

```sh
cd /home/werg/tracing-js-self
UV_PROJECT_ENVIRONMENT="$PWD/.venv-tinker" uv sync --project training --locked
source .venv-tinker/bin/activate
npm exec --yes --package=node@24.22.3 -- npm run test:tinker
python training/run_tests.py
npm exec --yes --package=node@24.22.3 -- npm run contracts:check
python training/run.py --config training/configs/inkling-mini.json check
```

The [experiment guide](TINKER_EXPERIMENTS.md) contains exact corpus generation,
census, 10,000-case fuzz, supervision audit, study planning and staged execution
commands. A prepared plan remains valid only while its recorded source and data
hashes agree; use a new study after changes. Do not overwrite or delete evidence
of an unresolved optimizer operation to make a resume proceed.

After authenticating in tick's experiment shell:

```sh
tinker auth login
python training/run.py --config training/configs/inkling-mini.json check --live
python training/experiment.py probe \
  --config training/configs/inkling-mini.json \
  --output-dir runs/tinker-contract-probe --live
npm exec --yes --package=node@24.22.3 -- python training/experiment.py run \
  --plan runs/tinker-study/plan.json --stage all
```

The final command evaluates baselines, checks the training-only learnability
gate, performs validation-stage comparisons, repeats the selected configuration
and opens the held-out test only after choices are sealed. A useful model claim
requires actual samples and checkpoints meeting the recorded accuracy/cost
criteria. Teacher byte counts, local replay, unit tests and corpus admission
rates establish preparation quality, not learned execution accuracy.
