# Frozen source split stress audit

`tools/audit-source-split-stress.mjs` checks the existing conservative source
registry under bounded syntactic perturbations. It leaves the registry,
source-component membership and frozen train/validation/test assignments
unchanged. No generated probe becomes a training example.

```sh
node tools/audit-source-split-stress.mjs \
  --registry FROZEN_SOURCE_REGISTRY.json \
  --max-sources 64 --max-component-share 0.20 \
  --out NEW_SPLIT_STRESS_REPORT.json
```

For each audited source, the tool probes a leading comment, identifier-token
renaming, numeric literal variation, an outer function wrapper, and a dead
block suffix. It parses each result before checking it. Token edits retain
string, template-text and regular-expression data. Identifier/property/builtin
renaming and numeric changes are **syntactic descendants**, not a claim of
behavioral equivalence. The tool does not execute those variants.

Each relation is tested twice: once using the existing lexical heuristic
alone and once with explicit source ancestry. That distinction matters for
short programs and wrapper changes, which a token-shingle heuristic can miss.
The report keeps every heuristic miss for review and verifies that declared
ancestry still connects the known relatives. It never hides a miss by calling
the same-input or renamed program an independent source component.

The default audit covers at most 64 source variants, in stable source-ID order.
The report gives total, audited and unaudited denominators, checked and
unsupported probe counts, and the exact registry digest. A finite passing
slice is not an absence-of-clones result. Components above the chosen fraction
of source variants are listed for over-grouping review; the tool does not
split those components or use evaluation results to alter them.

## Holdouts and explicit benchmark exclusions

Declared project and feature-composition holdouts must remain in the test
split. To check a benchmark-family exclusion inventory, supply a JSON array
of exact family names:

```sh
node tools/audit-source-split-stress.mjs \
  --registry FROZEN_SOURCE_REGISTRY.json \
  --benchmark-families BENCHMARK_FAMILY_IDS.json \
  --out NEW_BENCHMARK_SPLIT_AUDIT.json
```

Missing families and benchmark components assigned to train or validation
fail the exclusion gate. Without an explicit inventory, benchmark coverage is
`not-declared`; the tool does not infer a benchmark exclusion policy from
names or claim that a particular pretrained model never saw these programs.

A tampered registry refuses before probing. A generated report with failed
hard gates exits nonzero; heuristic misses or oversized conservative groups
produce `review_required` with preserved details. Review should strengthen
source ancestry or future acquisition policy, without moving an existing
frozen evaluation cohort after inspecting model results.

The regression suite includes short-wrapper heuristic misses, exact and
renamed/literal relatives, project/composition holdouts, explicit benchmark
leaks, corrupted registries, bounded denominators and immutable input evidence.
