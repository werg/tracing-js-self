# Resumption implementation and evidence handover — 18 November 2026

**Publication draft.** Completed measurements below are durable and tied to their actual revisions. Items marked **PENDING FINALIZATION** are active integration or measurement work; they are not claimed complete and are not automatically sandbox blockers. Replace those entries from finished receipts before treating this file as the final release report.

## Outcome and repository state

The resumption work repairs ordinary JavaScript teacher behavior, authenticates source/split/native identity, bridges real sources into actual native admission, makes collection recoverable and bounded, and implements complete private release verification. It also executes the real native optimizer and measures free-running models. **The completed learning run did not learn complete held-in execution and did not demonstrate generalization improvement.** Its failures, original model bytes, actual exposure, checkpoint choice and costs are preserved.

The implementation is in [werg/tracing-js-self PR38](https://github.com/werg/tracing-js-self/pull/38). Companion input-graph mutation, captured-source-cell parsing and bounded native-preparation repairs are in [werg/megatoken PR31](https://github.com/werg/megatoken/pull/31). [PR37](https://github.com/werg/tracing-js-self/pull/37) merged into main at `2aa694be86a6cda3b9d63fde739957d08f568961` during this work. Its useful array changes were first integrated with attribution; the subsequent main merge reconciles compact campaign storage, source bindings, release staging and separate exploratory learning tools with PR38's stronger integrity gates. Neither branch's original producing evidence is relabeled. See the [content-based branch audit and same-day integration update](BRANCH_TRIAGE_2026-11-18.md).

The production learner representation remains `semantic-execution/5`, `semantic-trace/5`, `semantic-context/5`, `semantic-continuation/5`, carried by `selected-harness/2`. Alternate historical exporters were not restored. This remains a bounded owned execution system with separate profiles, independent references and native admission; it is not a full ECMAScript, browser or Node implementation.

### Revisions are evidence boundaries

| Scope | Producer | Native consumer | Meaning |
| --- | --- | --- | --- |
| Original completed learning run and earlier 50-example training collection | `dac57b163f277085f1ee42f5d1fa0085eeecb556` | `277edd4a2983e81f5e2a71b34a7ce29348e4e7a0` | Immutable original measurements; later fixes do not change their results |
| Completed full local baseline, eight native probes, 210-case real-source pilot, isolated three-case collection | `5753de14760b76754fd1bd49ca7c8bfc6de85831` | `6206b33a55eba3e50f80498f906439221bc289b7` where native admission was run | Exact preserved qualification revision, before later array/capture/conversion work |
| Thirteen later native capability probes | `25f8e905789f811920c138281074a292d4e571c1` | `3d7ffc701a3e692883819fb623a03b1942cd8b5c` | All 13 admitted; fresh environment binds 47 installed packages |
| Final integration and refreshed release | **PENDING FINALIZATION: final producer, policy and full-gate receipts** | Read the exact final `contracts/native-admission-policy-v5.json` | Do not infer full qualification from the smaller probe run |

The tokenizer identity is `7f52faca2fe82273a889023defd2f1a6fd6080a21096ec77e97f4798a0a370b2`; its file SHA-256 is `40fb9d7d7795b8bd305aeff39ce9963f3f450915b9553f2938e009be9a1fed60`. The release environment locks Node 24.22.3, V8 13.6.233.17-node.63, npm 11.9.0, Python 3.12.14, Linux/x64, UTC and C.UTF-8. Actual receipts, including any missing container image identity, take precedence over an assumed portable environment.

## What changed and why

The complete W01–W14 implementation/acceptance table is in [RESUMPTION_IMPLEMENTATION.md](RESUMPTION_IMPLEMENTATION.md). The principal delivered behavior is:

- **Teacher semantics and abrupt outcomes.** Array methods distinguish omitted/undefined/null/NaN bounds; async declarations retain their mode; parameter initialization uses the correct environment and TDZ. Supported accessor updates preserve absent fields and non-configurable invariants. Unsupported descriptor execution refuses explicitly. Primitive, declared Error and implicit guest faults retain completion identity through nested calls, catches, finally and host-rejection paths. Node20 Error observation no longer materializes excluded lazy stacks or invokes message getters while inspecting them.
- **Refusal-driven array expansion.** `Array.some` and `forEach` use owned guest callbacks, live element reads and the initial length. `some` stops on the first truthy result. Throwing callbacks clear pending array continuations before catch/finally or later calls. Sparse `fill` writes selected holes without reading them. Unsupported async callbacks, sparse callback semantics, `thisArg` and inherited setter cases remain explicit refusals. The integrated change passed 20 focused tests and its positive probes subsequently passed native admission.
- **Authenticated data identity.** Single and session candidates bind the exact public episode, source/input/fixture/provenance, ancestry, frozen component/split identity, environment, limits, producer, schema, verifier and expected native policy. Native receipt binding is separate from immutable candidate identity. Mutable registries are fully checked; only privately branded, deeply immutable verified snapshots reuse digest/index work. Neither caller-supplied hashes nor object identity make mutable evidence trusted.
- **Real source and split discipline.** Pinned utilities, Exercism and production helpers use the same owned/reference/replay/public/native gates as authored fixtures. Local status is never promoted by changing a flag. Related variants share one global source component before input/schedule expansion. Project/composition reservations, exact source matching for known-source probes, and component token budgets prevent wrappers and repeated rows from masquerading as independent training families.
- **Recoverable, bounded operation.** Content-addressed source/input/fixture/public/private objects, an fsynced hash-chained log, an OS-held writer lock, read-only shared verification, torn-tail recovery and cancelled-work retry preserve completed work. Resume verifies object filenames/content hashes, nested references, statuses, attempts and finite resource counters. Cache identity includes source/runtime/verifier/policy/environment/isolation. Reports include preparation time and separate coordinator/worker RSS.
- **Native reference isolation and release integrity.** The optional Linux namespace/seccomp launcher removes host files/credentials, denies network and process creation, mounts exact code/runtime read-only, and enforces memory/CPU/files/output/time bounds. Three actual native admissions exercised it. The release packager locks a complete campaign through fresh source/native/environment qualification and archive creation, preserves all original refusals, applies training-only component caps, checks actual prepared rows and streams deterministic archive hashes. Source notices and private distribution status remain explicit.
- **Actual learning measurement.** Frozen experiments bind actual source membership, initialization, optimizer/decoder seeds, checkpoint schedule and budgets before training. Validation alone selects a checkpoint. Primary unseen-component, known-source auxiliary and pure-output measurements stay separate. Original invalid emissions and decoder costs are retained, with lower bounds when emission evidence is incomplete. Actual window/source exposure is checked rather than inferred from prepared membership.

These changes preserve the independent roles of owned journal reconstruction, deterministic replay, original-source observations, intermediate source checks, public selected replay, native parsing/tokenization/visibility/loss gates, and later model evaluation. Passing one layer is not evidence for a layer that was not executed.

## Completed qualification results

[The qualification receipt directory](receipts/resumption-qualification-2026-11-18/README.md) contains exact original logs/JSON and explicitly labeled compact extracts. Its inventories were checked against all copied file hashes and source-manifest denominators.

| Measurement | Result | Scope |
| --- | --- | --- |
| Full local baseline at `5753de1` | **841 passed, five skipped, zero failed**; clean producer identity before/after | 846 Node24 test cases; skips remain visible in original TAP |
| Deterministic fixture, contracts and inspection | Passed | Baseline logs preserve command, output hash and exit status |
| Authored local generation | Engineering 25/25; training-v4 50/50; benchmark-v1 128/128 | **203 local examples, no native admission in this baseline command** |
| Source registry | 508 variants, 199 family labels, 135 connected components; 89 train / 13 validation / 33 test components | Registry inventory, not a claim that all components were used in model training/testing |
| Independent engine262 scalar probes | 12/12 passed | Separate untraced pinned oracle |
| Owned arithmetic comparisons | 1,958/1,958 passed, reconstructed and replayed; 1,433 normal / 525 abrupt | Finite primitive corpus and edge probes |
| Owned Test262 runtime slice | Eight files; six executed non-strict variants passed, two unsupported, eight strict variants omitted; 16 assertions | No full-suite conformance percentage |
| Selected Test262 CLI after its loader fix | 11 selected; four passed, five known failures, two skipped, zero unexpected | Separate selected-execution population |
| Native capability subset at `5753de1` / `6206b33` | 8/8 admitted | Includes scope/TDZ, mutation and valid throw cases |
| Later capability subset at `25f8e90` / `3d7ffc7` | **13/13 admitted** | Adds `some`, `forEach`, sparse fill, input mutation and captured camelCase default |
| Isolated native collection | 3/3 admitted | One source component, actual `linux-namespace/1` execution |
| Isolated release cap smoke | Three original admissions requalified; two selected/prepared, 600 selected generated tokens; archive verified | One-component share allowance 1.0, not the later 0.2-share release |

The 39-case local capability ledger retains six frontend exclusions, two owned descriptor exclusions, a forward-parameter closure projection refusal, and an independently rejected callback-abrupt-obligation probe. Its native/model columns are untested. The later eight- and thirteen-case native ledgers are explicit positive subsets, not retroactive changes to those untested columns.

### Real-source populations and refusals

Two completed collections have different inputs and pins:

| Collection | Attempted | Admitted | Refused | Admitted family labels / components | Admitted generated tokens |
| --- | ---: | ---: | ---: | --- | ---: |
| Earlier broad collection, `dac57b1` / `277edd4a` | 1,177 | 873 | 304 | 80 / 31 | 726,952 |
| Later pilot, `5753de1` / `6206b33` | 210 | 174 | 36 | 88 / 31 | 138,758 |

These are **not matched before/after populations**. The broad run's refusal totals are 138 native rejections, 102 unsupported, 12 canonical mismatches, one worker timeout, 12 projection refusals, 30 teacher failures and nine source exclusions. The later pilot's totals are four native rejections, 20 unsupported, two reference outcome mismatches, four canonical mismatches, four teacher failures and two source exclusions. The compact summaries retain original manifest hashes; the pilot retains every individual original disposition/reason.

The pilot exposed concrete follow-ups: captured source-cell parsing in the companion, primitive Number conversion for Darts, canonical BigInt/absent-argument/empty-array shape preservation, and the owned array methods above. Repairs and fresh rechecks add new evidence. They do not erase these failures from their original cohorts. **PENDING FINALIZATION:** record the final conversion/canonical-fix commits and their fresh per-case/native results.

The pilot used two workers and measured 904,726.565874 ms from process start through final-manifest measurement, including preparation. Coordinator peak RSS was 473,296,896 bytes; maximum worker peak RSS was 203,956,224 bytes. Those independent peaks are not a simultaneous process-tree total. The older broad/training metrics use their original timing definition and are not presented as directly comparable throughput experiments.

## Actual learning outcome and checkpoint evidence

[The preserved learning report](receipts/learning-pilot-2026-11-18/README.md) is authoritative for the completed experiment. It uses a **newly initialized tiny CPU diagnostic model**, not a pretrained execution model or the production SE/SC launch path.

| Question | Observed answer |
| --- | --- |
| Did the actual optimizer run? | Yes: 64 real native updates; 307 parameter tensors changed; observed tokens were masked and generated tokens supervised |
| Did all 32 prepared examples participate? | No: 32 admitted members from 14 components were prepared, but sequential one-record windows visited only **five source IDs**, with 1,743 supervised lexical tokens |
| Were checkpoint and served tensors reloaded exactly? | Yes; actual initialization, checkpoint and served identities are retained |
| Did the trained model complete held-in selected tasks? | **0/4**, with base **0/4**; the empirical optimization smoke failed |
| Which checkpoint was selected? | Step16, using validation only and the predeclared earlier-step tie rule; both step16 and step64 scored zero on four validation episodes |
| What had the selected checkpoint actually seen? | Two source IDs and 416 supervised lexical tokens |
| Did held-out selected execution improve? | Base **0/3**, selected trained model **0/3**, one independent component; family-weighted improvement zero |
| Did pure source/input transfer improve? | Base **0/1**, trained **0/1**, one component; both original outputs were invalid outcome JSON |
| Were failures hidden or repaired? | No: all 22 selected failures and both original pure responses/payloads are retained; no controlled selections or teacher repairs enter model rollouts |

The initialized served base SHA-256 is `4ee47430d82fc7e6065bf8319165faca3d4c0d759039a873ac5f0cdc5e469d67`. The selected step16 served identity is `dd969f909f23feb82a651c03fe3d1fa4911642502fd6b7f8c0bbb0c271d4be29`; its checkpoint-state SHA-256 is `df7901031444fc71ff5bc8c34c55eeb34548b86782c36d141c6caf8143e3d01c`. The [sealed selection](receipts/learning-pilot-2026-11-18/learning-pilot-main/sealed-selections.json), [exposure summary](receipts/learning-pilot-2026-11-18/summary.json), and original optimizer verification bind these to the actual run.

Selected held-out decoding consumed 89 original tokens for base and 70 for trained; the separate pure endpoint consumed 32 and 126. These include invalid emissions and are not comparable task-budget efficiencies when no task succeeds. The selected adapter's original 32-token setting is per native fragment, with up to 64 fragments per logical decision; it was not a 32-token whole-task bound. The pure endpoint separately enforced a 128-token total-output cap.

The reported paired interval `[0,0]` comes from one source component. It does not establish narrow population uncertainty. One optimizer seed and absent primary error/cleanup slices also prevent confirmatory acceptance. Correct masks, changed weights, valid receipt hashes and zero recorded integrity-gate failures do not turn invalid executions into learned success.

### Separate measurements received with PR37

The main integration also preserves two independent diagnostic runs and their original failure bytes. They are additional populations, not replacement receipts for the 64-update experiment above:

| Retained run | Actual optimization/exposure | Held-in complete execution |
| --- | --- | --- |
| [32-update diagnostic](receipts/optimization-32-example-2026-11-18/README.md) | 32 prepared episodes / 29 family labels; three source IDs actually sampled; 865 supervised lexical tokens | Base 0/4, trained 0/4 |
| [95-update partial epoch](receipts/optimization-95-update-partial-epoch-2026-11-18/README.md) | 32 prepared episodes / 29 family labels; 16 source IDs actually sampled over 95 windows; 5,238 supervised lexical tokens | Base 0/4, trained 0/4 |

These runs likewise do not establish useful learned execution. Their source/runner/consumer identities and the corrected sampling forecast remain in their own receipt directories. The integrated [exploratory held-out tools](EXPLORATORY_HELDOUT_DIAGNOSTIC.md) and [strict learning comparator](LEARNING_COMPARISON.md) preserve separate diagnostic and production prerequisites; their availability is not a newly measured held-out score.

### Subsequent declarations and attempts

The first full-episode retry packed all 32 episodes with supported 256-record/decision settings. It was killed by SIGKILL after two actual updates and 913 supervised lexical tokens, with no post-start checkpoint. The signal is observed; a kernel OOM cause was not established. Its [original failure receipts](https://github.com/werg/tracing-js-self/tree/fbcc658459617966898f61d0da06d6f4bc45a2c8/docs/receipts/learning-full-episode-failure-2026-11-18) retain the report, logs, native plan and actual partial exposure. A smaller 32-record/16-decision packing produced a native plan of 56 windows for a complete first epoch and is being tried under a 900-second budget. **PENDING FINALIZATION:** add that retry's actual completion/exposure/checkpoint/rollout results; do not treat its planned epoch as completed training.

A separate [prospective real-source declaration](https://github.com/werg/tracing-js-self/tree/fbcc658459617966898f61d0da06d6f4bc45a2c8/docs/receipts/learning-prospective-real-2026-11-18) rechecked 174 actual native exports and froze 32 training episodes from 21 components, eight validation episodes from two components, 18 test episodes from eight components, and four strict matched known-source/new-input auxiliaries. It has **zero actual optimizer steps** at this draft. Its auxiliary probes and future weights cannot be substituted into the earlier synthetic-source experiment. A successful freeze is a prerequisite, not a model result.

## Durable artifacts and publication

The repository retains compact exact receipts and failure bytes; large private archives hold full campaigns, content-addressed journals, prepared datasets, model weights, original reports and checkpoints. Their intended distribution is private audit use. Public repository URLs must not be used to infer approval to redistribute upstream source or model assets.

| Artifact | Completed identity / status |
| --- | --- |
| Original learning archive, `learning-native-original-run-2026-11-18.tar.gz` | **410,883,378 bytes**; SHA-256 `bf83e1df8144ba821a14806e4fc8b35e98970466a82579b19d6de686f18a1252`; all 600 original files / 1,066,545,269 original bytes verified against archive members; private upload completed |
| Original corpus/baseline archive, `tracing-js-original-corpus-evidence-2026-11-18.tar.zst` | **1,459,041,613 bytes**; SHA-256 `f3ff1cd6a1e9b5a065f331be3dcda6a50deaef938444384142d9c0162a74602c`; 7,641 original files / 7,228,861,076 uncompressed bytes verified; four consecutive parts. [Receipt and reconstruction commands](receipts/resumption-qualification-2026-11-18/ORIGINAL_ARCHIVE.md). **PENDING FINALIZATION: private part-upload completion**; this original pre-fix evidence is not the final dataset release |
| Baseline, native, oracle and isolation receipts | [Committed qualification directory](receipts/resumption-qualification-2026-11-18/README.md); copied files and derived source manifests have independent size/hash inventories |
| Original negative learning receipts | [Committed learning directory](receipts/learning-pilot-2026-11-18/README.md); retains every measured failure without copying large weights |
| Complete corpus/isolated release downloads | **PENDING FINALIZATION:** independently verified artifact names, sizes and hashes; user-facing private download links belong in the delivery response, not private service identifiers in the public repository |
| Real-source capped release | **PENDING FINALIZATION:** fresh native requalification, actual prepared rows, 10,000 generated-token component cap, 0.2 training-token-share cap, archive hash and counts |

Private release verification checks complete campaign dispositions, every referenced object and compatibility export, actual public digests, immutable source/native identity, the fresh environment, actual prepared row/token/split counts, and all archive bytes. Training selection preserves original admissions and all held-out membership. An archive checksum check does not itself rerun semantic admission or create a publisher signature.

## Reproduction commands

Use clean immutable checkouts, new output directories and the exact runtime versions above. The following reproduces the **historical `5753de1` baseline and native populations**; final integration should be measured in another checkout and output directory. Output paths are caller-selected, but revisions and flags here are concrete.

### Baseline and independent oracle

```sh
git clone https://github.com/werg/tracing-js-self.git tracer-5753de1
cd tracer-5753de1
git checkout --detach 5753de14760b76754fd1bd49ca7c8bfc6de85831
npm ci --ignore-scripts --no-audit --no-fund
npm ci --prefix tools/spec-oracle --ignore-scripts --no-audit --no-fund
export TZ=UTC LANG=C.UTF-8 LC_ALL=C.UTF-8 OMP_NUM_THREADS=1 MKL_NUM_THREADS=1
REPRO_ROOT="$(cd .. && pwd)/resumption-reproduction"
export REPRO_ROOT
mkdir -p "$REPRO_ROOT/tmp"
export TMPDIR="$REPRO_ROOT/tmp"
node tools/current-v5-baseline.mjs --out "$REPRO_ROOT/baseline-5753de1" --jobs 2
node scripts/run-spec-probes.mjs > "$REPRO_ROOT/spec-probes.json"
node scripts/run-owned-arithmetic-probes.mjs --output "$REPRO_ROOT/arithmetic.json"
node scripts/run-runtime-conformance.mjs --oracle --output "$REPRO_ROOT/test262-runtime.json"
```

The historical revision's separate selected-Test262 CLI has the stale oracle path diagnosed during this session. Run `node tools/test262-baseline.mjs --output ...` from the later fixed checkout for that CLI; do not silently patch the immutable historical baseline while claiming to reproduce its bytes.

### Locked native environment and actual admission

```sh
git clone https://github.com/werg/megatoken.git "$REPRO_ROOT/megatoken-6206b33"
git -C "$REPRO_ROOT/megatoken-6206b33" checkout --detach 6206b33a55eba3e50f80498f906439221bc289b7
python3.12 -m venv "$REPRO_ROOT/native-venv"
NATIVE_PYTHON="$REPRO_ROOT/native-venv/bin/python"
export NATIVE_PYTHON
"$NATIVE_PYTHON" -m pip install --require-hashes -r tools/native-consumer/requirements.lock
"$NATIVE_PYTHON" -m pip install --no-deps --no-build-isolation -e "$REPRO_ROOT/megatoken-6206b33"
"$NATIVE_PYTHON" - <<'PY'
import hashlib, os, shutil
from pathlib import Path
from huggingface_hub import hf_hub_download
from megatoken.generation.codec import LING_REPOSITORY, LING_REVISION, LING_TOKENIZER_SHA256
source = hf_hub_download(LING_REPOSITORY, 'tokenizer.json', revision=LING_REVISION)
target = Path(os.environ['REPRO_ROOT']) / 'tokenizer.json'
shutil.copyfile(source, target)
assert hashlib.sha256(target.read_bytes()).hexdigest() == LING_TOKENIZER_SHA256
PY
"$NATIVE_PYTHON" tools/native-consumer/check_environment.py \
  --megatoken "$REPRO_ROOT/megatoken-6206b33" --tokenizer "$REPRO_ROOT/tokenizer.json" \
  --out "$REPRO_ROOT/native-environment.json"
node tools/freeze-source-registry.mjs --out "$REPRO_ROOT/source-registry.json" \
  --holdout-projects exercism/javascript --holdout-compositions square/even/maximum/alias/return
node tools/generate-effectful-training.mjs --recipe real-source --per-family 2 \
  --mutations-per-family 0 --jobs 2 --out "$REPRO_ROOT/real-source" \
  --registry "$REPRO_ROOT/source-registry.json" --require-native \
  --megatoken "$REPRO_ROOT/megatoken-6206b33" --python "$NATIVE_PYTHON" \
  --tokenizer "$REPRO_ROOT/tokenizer.json" --native-policy contracts/native-admission-policy-v5.json
node tools/generate-effectful-training.mjs --recipe engineering --limit 3 --jobs 1 \
  --reference-isolation linux-namespace --out "$REPRO_ROOT/isolated-three" \
  --registry "$REPRO_ROOT/source-registry.json" --require-native \
  --megatoken "$REPRO_ROOT/megatoken-6206b33" --python "$NATIVE_PYTHON" \
  --tokenizer "$REPRO_ROOT/tokenizer.json" --native-policy contracts/native-admission-policy-v5.json
```

Resume an interrupted collection by repeating the identical command/output with `--resume`. Add `--retry-failures` only when intentionally reattempting semantic refusals; cancelled work is already retried on plain resume. Changing source, dependency, policy, environment or isolation identity requires a new compatible campaign, not manually editing its header. Linux isolation requires working user namespaces, `unshare`, `mount`, Python3 and libseccomp; unsupported hosts refuse instead of silently falling back.

The later 13-case run uses separate checkouts and a separate virtual environment. Keep the historical editable consumer installation unchanged:

```sh
CURRENT_TRACER_ROOT="$REPRO_ROOT/tracer-25f8e90"
CURRENT_CONSUMER_ROOT="$REPRO_ROOT/megatoken-3d7ffc7"
git clone https://github.com/werg/tracing-js-self.git "$CURRENT_TRACER_ROOT"
git -C "$CURRENT_TRACER_ROOT" checkout --detach 25f8e905789f811920c138281074a292d4e571c1
git clone https://github.com/werg/megatoken.git "$CURRENT_CONSUMER_ROOT"
git -C "$CURRENT_CONSUMER_ROOT" checkout --detach 3d7ffc701a3e692883819fb623a03b1942cd8b5c
cd "$CURRENT_TRACER_ROOT"
npm ci --ignore-scripts --no-audit --no-fund
python3.12 -m venv "$REPRO_ROOT/native-current-venv"
CURRENT_NATIVE_PYTHON="$REPRO_ROOT/native-current-venv/bin/python"
"$CURRENT_NATIVE_PYTHON" -m pip install --require-hashes -r tools/native-consumer/requirements.lock
"$CURRENT_NATIVE_PYTHON" -m pip install --no-deps --no-build-isolation -e "$CURRENT_CONSUMER_ROOT"
"$CURRENT_NATIVE_PYTHON" tools/native-consumer/check_environment.py \
  --megatoken "$CURRENT_CONSUMER_ROOT" --tokenizer "$REPRO_ROOT/tokenizer.json" \
  --out "$REPRO_ROOT/native-environment-current.json"
node tools/generate-capability-ledger.mjs --out "$REPRO_ROOT/native-capabilities-current.json" \
  --cases scalar-arithmetic,slice-undefined-end,parameter-body-scope,later-parameter-tdz,synchronous-primitive-throw,synchronous-declared-error,alias-preserving-mutation,input-array-mutation,array-some-short-circuit,array-for-each-owned-callback,sparse-array-fill,input-graph-mutation,parameter-camelcase-default-capture \
  --megatoken "$CURRENT_CONSUMER_ROOT" --python "$CURRENT_NATIVE_PYTHON" \
  --tokenizer "$REPRO_ROOT/tokenizer.json" --native-policy contracts/native-admission-policy-v5.json
```

Use the final packaging checkout for the current streaming verifier, with the exact historical producer supplied explicitly. For isolated inputs, preserve `TRACING_REFERENCE_ISOLATION=linux-namespace` during requalification. The real-source cap recipe is:

```sh
"$NATIVE_PYTHON" tools/package-semantic-release.py \
  --corpus "$REPRO_ROOT/real-source" --tracer-root /absolute/path/to/tracer-5753de1 \
  --megatoken "$REPRO_ROOT/megatoken-6206b33" --tokenizer "$REPRO_ROOT/tokenizer.json" \
  --environment-receipt "$REPRO_ROOT/native-environment.json" \
  --max-family-tokens 10000 --max-family-share 0.2 --out "$REPRO_ROOT/private-real-release"
"$NATIVE_PYTHON" tools/package-semantic-release.py --verify "$REPRO_ROOT/private-real-release/semantic-v5-release.tar.gz"
```

### Learning reruns

Use the original private archive and its frozen declarations to inspect or reproduce the completed failed experiment; its exact initial/member/checkpoint identities are preserved. Changing packing, budgets, membership, seeds or input/schedule cohorts creates a new declaration. [LEARNING_PILOT.md](LEARNING_PILOT.md) gives the supported freeze/optimization/validation/test commands and [OPTIMIZATION_SMOKE.md](OPTIMIZATION_SMOKE.md) explains actual exposure and fragment budgets.

For a new bounded experiment, use one producer/policy/global registry across all input campaigns, then freeze before optimizing:

```sh
node tools/freeze-learning-experiment.mjs --corpus /absolute/path/to/admitted-corpus \
  --tracer-root /absolute/path/to/immutable-producer --out /absolute/path/to/new-experiment.json \
  --minimum-improvement 0.05 --mode exploratory --optimizer-seeds 17 \
  --initialization-seed 17 --decoder-seed 17 --checkpoint-steps 16,64 \
  --train-examples 32 --validation-cases 16 --test-cases 32 --auxiliary-cases 32 \
  --rollout-tokens 32 --rollout-timeout 120
PYTHONPATH=/absolute/path/to/megatoken/src "$NATIVE_PYTHON" tools/run-optimization-smoke.py \
  --corpus /absolute/path/to/admitted-corpus --tracer-root /absolute/path/to/immutable-producer \
  --consumer-root /absolute/path/to/megatoken --tokenizer-json "$REPRO_ROOT/tokenizer.json" \
  --experiment /absolute/path/to/new-experiment.json --output /absolute/path/to/new-optimization \
  --examples 32 --steps 64 --seed 17 --initialization-seed 17 \
  --rollout-cases 4 --rollout-tokens 32 --train-timeout 900
PYTHONPATH=/absolute/path/to/megatoken/src "$NATIVE_PYTHON" tools/run-learning-pilot.py \
  --experiment /absolute/path/to/new-experiment.json \
  --smoke-report /absolute/path/to/new-optimization/report.json \
  --consumer-root /absolute/path/to/megatoken --output /absolute/path/to/new-pilot \
  --rollout-tokens 32 --rollout-timeout 120
```

Those are executable diagnostic defaults, not a promise that 64 one-record updates expose all sources. Inspect `native-window-plan.json` and require actual complete exposure. The balanced retry uses a separately frozen supported packing schedule; its final exact command and result are **PENDING FINALIZATION**. Pure-output transfer has a separate freeze/run/compare command in the learning guide and must use the same actually selected served checkpoint, not a teacher trace or inferred outcome.

## Hosted gates and finalization record

Two original hosted failures were diagnosed from logs and repaired: Node20 lazy-stack descriptor formatting, and the selected-Test262 CLI's obsolete oracle package path. The original failing runs were [44305588876](https://github.com/werg/tracing-js-self/actions/runs/44305588876) and [44305589113](https://github.com/werg/tracing-js-self/actions/runs/44305589113). Local checks included the exact Node20.20.2 runtime and the actual selected-Test262 command.

At `25f8e90`, [the browser workflow](https://github.com/werg/tracing-js-self/actions/runs/44309531037) and [the pinned spec workflow](https://github.com/werg/tracing-js-self/actions/runs/44309530846) completed successfully. **PENDING FINALIZATION:** final producer full Node20/22/24 unit matrix, all native recipe/package lanes, remaining source/corpus workflows, final learning retry, exact private archive deliveries and PR merge/review disposition. A later source change needs appropriately refreshed evidence; earlier green runs must retain their original head.

The retained companion pin `3d7ffc701a3e692883819fb623a03b1942cd8b5c` separately passed [CPU Python3.11/3.12 and lint CI](https://github.com/werg/megatoken/actions/runs/44309206418), [native qualification](https://github.com/werg/megatoken/actions/runs/44309206394), and [the selected bridge](https://github.com/werg/megatoken/actions/runs/44309206440). These receipts qualify that exact consumer revision; they do not claim that later companion-main changes were incorporated or tested.

## Remaining work, classified correctly

### External resources and owner decisions

- The measured native environment is CPU-only (`cudaAvailable: false`). A newly initialized diagnostic was feasible and was actually run. A useful pretrained production base, compatible donor/hindsight/coordinator assets for the production SE/SC path, and a larger authorized compute allocation were not supplied as completed launch inputs. They cannot be inferred from the old engineering checkpoint. These are requirements for a production-scale experiment, not a reason to skip the implemented diagnostic path.
- The first larger packing attempt terminated with SIGKILL, without a confirmed kernel OOM cause. Smaller supported packing is being attempted; **do not call this a permanent sandbox blocker until that workaround's result is recorded**. A larger host may help the original full-episode setting if memory pressure caused the signal, but that inference is not a measured impossibility for all alternatives.
- The managed host did not expose an immutable container-image digest in its environment receipts. Runtime, OS, packages, source, locks and isolation policies are recorded; a portable container identity is not claimed. Native browser restrictions in the sandbox have a hosted-CI workaround, and the current browser job passed.
- Public corpus/model redistribution needs an explicit licensing/distribution decision. Exact source notices are retained and current bundles are private audit artifacts. `repository-fixture` is provenance, not an SPDX license; successful admission does not grant publication rights.
- Branch protection and required-check enforcement are an administrative choice. Read-only inspection found main unprotected and no inherited repository rulesets; no settings or stale branches were changed. Configure desired enforcement and approve release/merge policy separately rather than implying it was enabled by a successful test run.

### Intentional bounded scope and unmet empirical goals

The plan's unsupported strict-profile targets remain explicit: `this`/general receiver semantics, named function-expression recursion, classes/generators, general object methods/accessors/spread, sparse/spread array literals, general `for-in`, labeled control flow and ordinary switch fallthrough. Supported array constructors/fill, bounded rest/spread, ordinary accessor operations and separate module/runtime adapters do not make all of those source forms accepted. Forward-parameter closure projection and the broader Error stack/cause/prototype surface also retain refusals. Broad RegExp, full modules/host APIs, ECMAScript/Intl/browser/Node/shared-memory compatibility are separate expansions requiring their complete capability ladder.

The completed experiment has not met the plan's useful learned execution goal, three-seed confirmation, broad unseen-program/project/composition transfer, robust valid-error/cleanup slices, or the proposed 5,000–20,000 admitted episodes / 100–300 independent training clusters / at least 100 held-out-family scale. These are empirical and dataset-coverage goals, not missing flags that can honestly be marked done by implementation alone. The actual negative measurements and the untrained prospective declaration make the remaining question testable.

Ordinary code fixes and already running qualification/publication work belong in the finalization record above, not in this external-constraints list. Preserve their original failures and update this handover with completed evidence before delivery.
