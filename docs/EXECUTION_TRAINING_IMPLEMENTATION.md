# Execution training roadmap: implementation and remaining gates

This ledger implements the [18 November roadmap](EXECUTION_TRAINING_ROADMAP.md)
from reviewed producer `98bbf84f1f636a5a7a04dcd1be2d6587f4371d91`.
The immediate objective is a small, independently checked execution dataset
and an exact diagnosis of why a model fails to execute it. Bulk collection,
language expansion and a confirmatory training study remain gated on that
diagnosis and successful bounded learning.

The production public representation remains `semantic-execution/5`,
`semantic-trace/5`, `semantic-context/5` and `selected-harness/2`. New source
completion evidence uses `effectful-source-checks/5`. Old admission receipts
retain their original producer, consumer and verification identities.

## Work delivered

| Roadmap work | Implementation | Evidence boundary / next gate |
| --- | --- | --- |
| A1: strict failed assignments | Lexical strictness is compiled per program/function, including directive inheritance. Own and inherited getter-only writes throw in strict functions. Successful/throwing setters, single evaluation and finally overrides have regressions. | General unsupported data descriptors remain explicit refusals. See [strict assignment audit](STRICT_ASSIGNMENT_REQUALIFICATION.md). |
| A2: independent intermediate authority | A separate V8 instrumentation pass checks once-evaluated initializers, assignments, calls, returns, throws and abrupt control markers. Owned values are read from committed storage. Input graph identities are rooted before comparison. | Thirteen implementation mutants target overwritten/dropped writes, catch/finally, helper completion and reference substitution. The [authority matrix](SEMANTIC_AUTHORITY_MATRIX.md) states each category's limits. This is bounded coverage, not complete JS conformance. |
| A3: baseline and affected data | The current baseline runner collects exact producer/policy identities, full unit/reference/contract checks, mutations, paired galleries, summaries, capability probes and three recipes. The affected-row scanner reads historical pre-state descriptors and source strictness. | A source-only run cannot establish native admission. Missing historical private archives remain unaudited/quarantined; old D totals are not a repaired census. |
| B1: locate the learning failure | Native target audits expose bytes, tokens, masks and loss-field categories. The actual paired probe authenticates one physical checkpoint and captures real training/serving Gaussian state before its facet draw. | [Executed native comparison](evidence/native-conditionals-cb67ed1/README.md): failed at producer `cb67ed1…` and consumer `2725842…`, with maximum absolute difference 2.4304623 across 256 mean/log-scale coordinates. Controls agree; metadata, track ownership and lifecycle history differ. This establishes a conditioning blocker, not its sole historical cause or learned execution. |
| B2: bounded convergence | Immutable declarations freeze budgets, membership and restart schedules. The runner reuses actual optimization, exact checkpoint reload and the selected scorer, retaining original emissions and real serving-process launch receipts. | Ten restarts for one case; 16–32 cases and at least 100 first-record trials for the stratified gate. No model pass follows from scorer tests. Native seeded policy sampling is explicitly distinguished from fully greedy inference. See [convergence diagnostics](CONVERGENCE_LADDER.md). |
| B3: separate causal-LM control | A conventional causal-LM exporter uses the actual selected driver's public prefix, generated-only labels, exact tokenizer round trips and explicit EOS. Both unconstrained and syntax-only constrained evaluation feed original emissions to the same semantic scorer. | No pretrained checkpoint or successful optimization is implied by the bridge. The grammar may constrain syntax but cannot supply the correct answer. See [causal-LM diagnostic](CAUSAL_LM_DIAGNOSTIC.md). |
| T1/T2: inspect and simplify actual targets | Paired galleries retain source, actual target bytes, readable records, public-prefix identities and claim counts. Optional cell compaction removes only an already committed, identical lexical assignment. Default target bytes and certificate shape remain unchanged. | The eleven-case gallery falls from 145 records / 12,345 UTF-8 bytes to 143 / 12,267. All 78 saved bytes come from the repeated-cell fixture. These are byte counts, not native tokenizer costs or learning gains. |
| T3/T4: checked summaries | A separate experimental checker accepts bounded scalar pure-helper summaries and dense-array sum summaries, including independently verified loop checkpoints. Incorrect intermediate claims are refused even if the final value agrees. | Detailed private traces and source components remain available. This endpoint has not replaced production v5, migrated the native adapter or been tested for model learning. See [trace abstraction](SEMANTIC_TRACE_ABSTRACTION.md). |
| C1: coverage after preparation | The capped selector authenticates actual prepared inputs, keeps source/admitted/prepared/planned/consumed inventories separate, and balances rare supported features under token/component caps. Evaluation membership is preserved. | Actually consumed coverage requires optimizer-window receipts. The historical D availability report explicitly lacks raw per-row and consumed-target evidence. See [native prepared coverage](NATIVE_PREPARED_COVERAGE.md). |
| C3: split stress audit | The audit probes renamed/wrapped/literal/dead-code relatives, verifies explicit ancestry and holdouts, reports heuristic misses and giant components, and checks benchmark-family exclusion. | A heuristic miss requires review; the audit cannot certify semantic equivalence or unknown pretraining contamination. See [split stress](SOURCE_SPLIT_STRESS.md). |
| E2: bounded execution and shards | The runner checks effective cgroup CPU/memory/PID limits and bounded output/tmp storage before work starts. Deterministic generation shards reuse the global registry, preserve retries/refusals and verify complete merging and resume. | This host cannot qualify the requested aggregate isolation. The retained preflight is `unavailable`, no workload was launched, and no container digest is claimed. See [runner and sharding](AGGREGATE_RUNNER_AND_SHARDING.md). |
| E3: restoration and current navigation | The bounded restore tool authenticates the original archive, locks and producer, then replays every positive attempt with that producer while preserving all other dispositions. CI runs an engineering restore in a separate hosted job, installing its exact locked npm version. This ledger and the expanded baseline distinguish code, executed evidence and historical receipts. | Local release/restore checks passed: 33 Python and 18 Node tests. A completed hosted restore requires its separate job receipt; original-policy native requalification remains explicit. See [restore drill](RELEASE_RESTORE_DRILL.md). Public distribution still requires its own decision and source-rights review. |

## What the native input diagnosis established

The first direct invocation of `run(a,b){ return a & b; }`, with inputs `6,3`,
was freshly source-certified and passed through the real data and serving
adapters at the frozen companion revision. Capture stopped before neural
prediction. The training path supplied no instruction; the serving path
supplied 553 instruction bytes. Both initial observed records had equal JSON
values but different serialized bytes. Serving also added a retained-state
bootstrap to a fresh direct call, giving three initial observations instead
of two. Track metadata was retained for separate comparison.

These are actual path differences, independent of the historical falling
loss curves. Repair requires a new companion artifact contract and freshly
prepared data/checkpoints. A byte-level repair alone does not establish
recurrent state equality, categorical action support, conditional logits,
gradient correctness or convergence. Each must have its own measured result.
The original failed receipt and candidate are preserved as a fixed control.

The [first hosted repaired comparison](evidence/native-input-parity-6b7d895/README.md)
passed for producer checkout `6b7d895…` and companion `548ab7e…`: two identical
observations, a matching 580-byte framed instruction and equal declared
execution purpose. The original artifact bytes and CI identity are retained.
Subsequent companion changes also unify physical context announcements. The
[actual conditional probe](NATIVE_CONDITIONAL_PROBE.md) compares a freshly
compatible checkpoint through the real training and serving paths; it retains
failed or incomplete measurements and never infers full parity from input-byte
agreement. Hosted numerical execution and source/native qualification are
separate checks.

The [completed actual native capture](evidence/native-conditionals-cb67ed1/README.md)
then measured a failed Gaussian comparison at `cb67ed1…` / `2725842…`. Both
paths used the same physical zero-update checkpoint, disabled dropout and
public prefix; their encoded request controls match exactly. Training has ten
committed history events at the captured boundary and serving has eleven,
including its real track-creation observation. Metadata conventions and program
track ownership also differ. The largest difference among 256 mean/log-scale
coordinates was 2.4304623, exceeding absolute/relative tolerances of `1e-6` /
`1e-5`. Both actual model-state hashes remained unchanged.

This is the roadmap's well-localized remaining native conditioning blocker.
No returned semantic selection or optimizer update ran. Serving's earlier
singleton text-modality categorical did execute; capture stops specifically
before the Gaussian facet draw and downstream rendering. Declared length
support differs separately, while the loaded lexical alphabets agree. Resolve
the actual prefix-construction differences and qualify downstream support
before interpreting a new run as a clean convergence experiment.

## Reproduce the bounded evidence

The [frozen baseline receipt](evidence/execution-baseline-7b5ef54/STATUS.md)
applies to producer `7b5ef549c711b9937ab8721ec607f55354047b97`, not later
commits containing it. All fourteen command-level checks passed: 1,004 of
1,009 unit tests passed with zero failures and five explicit native-serving
skips; eight reference fixtures passed; thirteen teacher mutants were caught.
The engineering, training-v4 and benchmark-v1 recipes locally verified
25, 50 and 128 examples respectively (203 total). Native admission and model
optimization were not executed in that run. The capability ledger retains
40 independent-outcome passes, one expected out-of-profile callback refusal
and eight untested probes; a successful ledger command does not convert the
refusal into a supported capability.

The committed evidence includes complete command logs, corpus manifests and
their original identities. It is a compact baseline record, not a complete
private native release. The separate
[historical affected-path inventory](evidence/affected-original-episodes-7b5ef54.json)
scanned two available original archives and found no property-write events.
The unavailable D private archives remain unaudited; no corpus-wide clean or
contamination claim follows from the two available examples.

Use the exact Node version in `.nvmrc` and a clean, immutable checkout:

```sh
npm ci --ignore-scripts
npm run oracle:install
npm run baseline:v5 -- --out ../execution-baseline --jobs 2
```

The output contains `baseline.json`, generated `STATUS.md`, individual check
logs, source receipts, galleries and exact corpus disposition counts. The
runner refuses producer changes during the run. Pass the exact native
consumer, tokenizer and Python environment to execute native gates:

```sh
npm run baseline:v5 -- --out ../execution-native-baseline --jobs 2 \
  --megatoken /path/to/pinned/megatoken \
  --tokenizer /path/to/tokenizer.json --python /path/to/python
```

The [native environment instructions](../tools/native-consumer/README.md)
and [active admission policy](../contracts/native-admission-policy-v5.json)
define those identities. Absence of a native environment is recorded as
unmeasured, never as a native pass. A historical receipt is not reattributed
to the newer commit that contains it.

Individual entry points:

```sh
node tools/audit-teacher-mutations.mjs --out ../teacher-mutations.json
node tools/semantic-trace-gallery.mjs --out ../trace-gallery-control
node tools/semantic-trace-gallery.mjs --out ../trace-gallery-compact --local-state-compaction
node tools/semantic-summary-experiment.mjs --demo --out ../summary-experiment
python tools/diagnose-learning-run.py --help
python tools/run-convergence-ladder.py --help
```

Coverage selection, affected-row scans and split audits require the exact
input manifests named in their linked guides. They are not valid ways to
infer missing historical source or native evidence.

## Explicit stop/go decisions

1. **Teacher qualification:** retain every refusal and use only cases whose
   source, intermediate claims, final behavior and applicable native gates
   agree. Run the mutation audit whenever completion authority changes.
2. **Training path:** compare identical public prefixes, observed bytes,
   instructions, event/track metadata, masks and conditional model outputs
   at the same freshly compatible checkpoint. A mismatch blocks interpreting
   the next run as a convergence-only experiment.
3. **Bounded learning:** predeclare one short episode, a capped budget and
   exact restart/reload evaluation. Keep every original model action. Then
   attempt the 16–32-case feature-stratified gate. Native stochastic policy
   sampling must be labeled even when text rendering uses argmax.
4. **Transfer and collection:** C2, D1 and D2 require a useful held-in or
   causal-LM signal. Preserve known-source input tests separately from
   independent-component/project/composition holdouts. Do not enlarge the
   corpus to disguise a failure at the first model action.
5. **Runtime expansion and release:** E1 follows a fresh native refusal
   census ranked by recovered independent components. A scalable release
   additionally requires a qualified image, real quota-exhaustion evidence,
   complete durable inventory and a fresh-environment restore/replay drill.

The implementation supplies the repair, diagnostics and bounded experiments
needed for these decisions. It does not claim that the six-to-ten-week
research program, model-learning gates or production release gates have
already been achieved.
