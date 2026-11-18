# Comparing a frozen base with canonical v5 training

`tools/compare-learning-runs.py` implements the W11 comparison gate. It consumes
the companion's existing `semantic-evaluation-report/5`,
`semantic-evaluation-cohort/4`, `semantic-experiment-budget/4`, native checkpoint,
served export, and production launch qualification. It does not run inference,
change the evaluator, supply expected outcomes to a model, or change the v5
production trace format. Historical v4 measurements remain separate.

There is no learning-performance result in this implementation. Synthetic test
reports exercise the analysis contract. The artifact tests execute two native
optimizer steps on an artificial parameter-sum objective, then use actual native
checkpoint/export loaders to test binding. Those fixtures are not semantic
training, held-out execution performance, or a usable engineering-completion
receipt. The separate P1 optimization smoke has its own scope; its held-in
diagnostic output is not accepted as a W11 evaluation or budget receipt.

## Required evidence

The CLI refuses missing or incompatible evidence before calculating improvement:

- A frozen, independently reference-checked **test-only** cohort. The native
  `verify_cohort` and `analyze_semantic_evaluation` validators remain authoritative.
  Base and trained reports must contain every task exactly once, with identical
  family assignments, seed, cohort, current execution/catalog identities, and
  actual checkpoint/tokenizer identity. Controlled-origin reports are refused.
- A globally frozen source registry. The CLI calls the repository's full
  `verifySourceRegistry` reconstruction, including source fingerprints, clone
  links, ancestry, component membership, and split policy. Every held-out program
  byte string must be present in its declared test component. A caller-supplied
  family count or unverified component map cannot replace this check.
- The actual base served bundle **and** its immutable native checkpoint. File
  hashes, native model geometry, exact model/FP32-master inventories, finite
  tensors, tokenizer bytes, and served tensor values are checked. The transducer
  bank must match the native export's exact reload semantics, including its one
  cache-version increment. All arms use this one frozen starting checkpoint.
- A normalized native training configuration and actual checksummed prepared
  corpus. The inventory scans native train and validation rows, checks their
  family/ancestor components against the global registry, rejects overlap with
  held-out components, runs native stage-supply validation, and binds the exact
  native window-stream fingerprint later saved in the checkpoint. A declared
  empty training-family list is insufficient.
- One planned optimizer/evaluation seed pair per arm. Native registered seeds are
  17, 29, and 43. A confirmatory design plans all three; one or two seeds are
  exploratory. Missing planned seeds, duplicate arms, or mixed seeds are errors.
- An actual trained checkpoint and served bundle for each seed. Its native
  semantic-budget file must match the manifest and be exactly reconstructible
  from the saved native exposure counters. Examples, generated tokens, and
  compute time must be positive; the frozen budget must be completed. The new
  optimizer-step count must be positive **beyond the starting worker counter**, with
  actual finite optimizer-owner state. The served model must have changed and
  must match the native checkpoint tensors. Historical pretraining steps cannot
  be relabeled as new optimization.
- Production or confirmatory runs need a passed
  `semantic-launch-qualification/1` receipt. Its canonical digest, required gates,
  exact resolved configuration, starting checkpoint state/metadata, tokenizer,
  pinned consumer, prepared supply, and held-out cohort are checked. Register the
  receipt before invoking the qualified native launcher with that exact base.
  An explicitly diagnostic exploratory run may omit this receipt, but then the
  `qualifiedNativeLaunches` and confirmatory acceptance gates remain false.

Every case must retain complete hard-gate and cost measurements. Costs use the
original decoder token IDs, including rejected choices; canonical re-encoding
cannot substitute for model cost. Positive success must agree with all native
outcome, trace, cleanup, and hard-gate checks and must have no retained failure.
An explicit terminal invalid-trace failure may lack downstream outcome matches;
that is retained as incomplete outcome coverage, never converted into success.
Missing hard-gate or cost data is refused even for failures.

## Freeze before any training or test-driven tuning

Run these tools in the exact pinned companion Python environment. Commands below
use illustrative paths; choose fresh output paths. The CLI never overwrites a
declaration, launch registration, or comparison.

Prepare `design.json` with the statistical choices and claim scope:

```json
{
  "name": "v5-execution-transfer",
  "mode": "confirmatory",
  "optimizerSeeds": [17, 29, 43],
  "baseKind": "pretrained",
  "minimumPracticalImprovement": 0.05,
  "minimumSeedImprovement": 0,
  "confidenceLevel": 0.95,
  "bootstrapReplicates": 10000,
  "bootstrapSeed": 20261118,
  "minimumIndependentComponents": 20,
  "slices": {
    "effects": {"caseIds": ["effect-case-id"], "maximumRegression": 0},
    "errors": {"caseIds": ["valid-error-case-id"], "maximumRegression": 0},
    "cleanup": {"caseIds": ["cleanup-case-id"], "maximumRegression": 0}
  }
}
```

The example's five-percentage-point threshold is a syntax illustration, **not** a
recommendation or inferred acceptance target. Pick the threshold from the
baseline and intended use before running the comparison. Slice IDs must be real
members of the frozen cohort. A confirmatory design must declare effects, errors,
and cleanup slices, or explicitly exclude individual slices with a nonempty
reason in `excludedCriticalSlices`. An excluded slice is marked out of scope and
cannot support a no-regression claim. Unsupported slices are not silently passed.

```bash
python tools/compare-learning-runs.py freeze \
  --consumer-root ../megatoken \
  --cohort experiment/test-cohort.json \
  --source-registry experiment/source-registry.json \
  --design experiment/design.json \
  --training-config experiment/seed-17.json \
  --base-served models/base-served \
  --base-checkpoint models/base-checkpoint \
  --tokenizer-json assets/tokenizer.json \
  --output experiment/declaration.json
```

The freeze step supplies the verified component map, exact train/validation
inventory, native consumer revision, actual base artifact identities, and native
budget policy. Across replicated runs, `seed`, `output`, and the coordinator's
`run_id`/`coordinator_url` may differ as run identities; each endpoint still needs
its own passed native launch qualification. Changes to phase, geometry, data,
objectives, tokenizer, windowing, donor paths, coordinator topology, budget, or
overshoot allowance require a new experiment. Thus a seed that receives an
adaptively enlarged budget cannot masquerade as another replication.

For each seed, retain the existing native launch qualification and register it:

```bash
python tools/compare-learning-runs.py register \
  --consumer-root ../megatoken \
  --cohort experiment/test-cohort.json \
  --declaration experiment/declaration.json \
  --training-config experiment/seed-17.json \
  --native-launch-qualification experiment/seed-17-launch-qualification.json \
  --base-served models/base-served \
  --base-checkpoint models/base-checkpoint \
  --tokenizer-json assets/tokenizer.json \
  --output experiment/seed-17-registration.json
```

Registration is evidence preparation, not an optimizer launch. Invoke the native
qualified launcher separately with the exact frozen starting checkpoint and
registered configuration, retain its logs, and preserve immutable output
checkpoints. Evaluate each base/trained pair through the existing evaluator's
production model runner. Use `fixed-weights` for the base and `trained` for the
optimized arm. Keep expected outcomes private to evaluation. This tool's bounded
comparison policy uses checkpoints that complete the common frozen budget; it
does not search checkpoints using the test cohort.

Exact worker resume retains the base checkpoint's step and exposure counters;
the comparison subtracts those inherited counters and requires positive new
training exposure. A fresh coordinator bootstrap starts a new worker counter at
zero, so the comparison uses zero only when the native qualification retains the
exact base checkpoint's bootstrap provenance and the independently hashed live
bootstrap artifact. A caller label cannot reset the starting counter.

## Compare actual completed runs

Prepare a `semantic-learning-runs/1` index with exactly one pair per planned seed:

```json
{
  "schema": "semantic-learning-runs/1",
  "pairs": [
    {
      "seed": 17,
      "baseReport": "seed-17/base-report.json",
      "trainedReport": "seed-17/trained-report.json",
      "trainedServed": "seed-17/served",
      "trainedCheckpoint": "seed-17/checkpoint",
      "launchReceipt": "seed-17-registration.json"
    }
  ]
}
```

This one-pair example is sufficient only when the declaration planned one
exploratory seed. Add the 29 and 43 pairs for the confirmatory example above.
Paths resolve relative to the index file. Keep the actual prepared data available:
comparison rescans its checksums and lineage against the preregistered inventory.

```bash
python tools/compare-learning-runs.py compare \
  --consumer-root ../megatoken \
  --cohort experiment/test-cohort.json \
  --declaration experiment/declaration.json \
  --runs experiment/runs.json \
  --base-served models/base-served \
  --base-checkpoint models/base-checkpoint \
  --tokenizer-json assets/tokenizer.json \
  --output experiment/comparison.json
```

Exit code 0 means a valid comparison was written; an honest negative result is
still a successful analysis. `--require-acceptance` returns 2 when the comparison
is valid but the declared improvement gates fail. Invalid or missing evidence
returns 1 and does not write a comparison artifact. Only the CLI sets
`actualArtifactsVerified: true`; the lower-level statistics helper assumes the
caller already supplied verified artifact bindings and is also used by synthetic
unit tests.

## Statistical meaning and limits

The primary score is the unweighted mean of each declared family's whole-task
accuracy, averaged over the planned optimizer seeds. Episode-weighted accuracy
and component-weighted accuracy are reported separately. Repeated inputs cannot
give one family extra primary weight. Reports also include per-family rates,
per-component rates, per-seed effects, all declared slices, generated/observed
tokens, wall time, compute time, and exact retained first-failure evidence. Cost
per correct task is null when no tasks succeeded.

Uncertainty uses a deterministic paired crossed bootstrap. Each replicate
resamples whole frozen source/ancestor components and optimizer seeds. The same
component draw is used for every selected seed; base/trained observations stay
paired. Each selected component carries all its member-family means together,
with the original family weights. Alias names, wrappers, or constant variants
within one component do not create additional independent observations. With
only one component, an uncertainty interval is unidentifiable. Declaring 20
components as a minimum is a bounded eligibility rule, not a power calculation.

Confirmatory acceptance requires the planned confirmatory mode, at least three
optimizer seeds, the declared minimum number of components, verified native
launches, a paired uncertainty interval strictly above zero, a point improvement
at least as large as the frozen practical threshold, an improvement above the
declared minimum at every seed, zero integrity-gate failures, and no declared
slice regression beyond its frozen bound at any seed. The interval uses the
declared confidence level and nearest-rank percentile bootstrap. Three seeds
provide a small empirical sample of optimizer variability; a positive interval
does not eliminate that limitation.

The tool establishes consistency of retained evidence. Checksums and local
timestamps are not signatures or an independent timestamp authority. Preserve
the declaration, launch qualifications, registrations, launcher logs, and input
artifacts in an externally retained immutable run record before execution.
Final weights alone cannot prove their complete causal training history. Source
holdouts also do not establish absence from a pretrained model's pretraining
corpus. Never turn this comparison into a broader claim than its frozen source
inventory, model, supported slices, and measured budget support.

## Regression tests

```bash
MEGATOKEN_ROOT=../megatoken ../native-venv/bin/python -m pytest -q \
  test/test_learning_comparison.py test/test_learning_artifacts.py
```

Tests cover family imbalance, shared-ancestor dependence, seed variation,
exploratory/confirmatory separation, practical thresholds, slice regressions,
missing/duplicate tasks, stale cohorts, false positives, omitted hard gates,
unmetered failures, file and rehash tampering, changed seed/budget/data, actual
native optimizer/checkpoint/export binding, and pre-run ordering. They do not
replace an actual held-out training experiment.
