# Expansion baseline at e882191

Producer: `e88219121d1a09a6f93d161038f162e6b0f6ef54`.
Runtime: Node v24.22.3. No external model, native admission or tokenizer was
configured. All token fields are null; these are actual serializer **bytes**.

## Fixed populations and source outcomes

| Population | Declared | Source qualified | Compact episodes | Detailed episodes |
| --- | ---: | ---: | ---: | ---: |
| Unchanged gallery | 11 | 11 | 6 | 5 |
| Stratified pinned real source | 27 | 27 | 2 | 25 |
| Script interaction cases | 12 | 4 | 0 | 4 |

Two additional module interactions are declared separately and untested by this
strict script runner. The twelve script interactions include six frontend
refusals, one projection refusal, and one owned unsupported case. No refusal
was removed from its denominator. The real-source population selects 27 distinct
functions from a frozen 78-function inventory, with four declared strata and
unchanged original/transformed-source provenance.

The frozen reference population contains 26 new semantic families, three source
idioms per family, and eight inputs per family. All 624 independently executed
positive reference cases agreed, and all 52 independently executed near-miss
pairs differed. These reference checks validate fixture meaning; they do not
qualify unsupported owned syntax, unimplemented compact lowering, or native
consumption. The comprehension inventory has 228 predeclared questions and zero
supplied evaluator responses.

## Actual flat serving serializer

| Source-qualified population | Predictions | Generated target bytes | Expanded prompt bytes across predictions |
| --- | ---: | ---: | ---: |
| Gallery | 89 | 9,379 | 1,388,651 |
| Real source | 916 | 98,666 | 38,363,937 |
| Script interactions | 70 | 6,491 | 918,942 |

These counts come after the real flat context resolver and serializer. Repeated
source definitions, immutable inputs, state, routing and prompt framing are
included at every prediction. The real-source prompt total is much larger than
the generated target total; reducing target text alone therefore does not
establish a serving-cost win. No byte-to-token conversion or native cache
saving is inferred. Latency, model failures/retries, next-step accuracy and
completed model execution remain unmeasured.

## Exact retained artifacts

`summary.json` records population/manifest/registry identities, dispositions,
aggregate costs, and SHA-256 hashes for every retained file. The deterministic
archives retain each generated JSON file byte-for-byte:

- `reference.tar.xz`: frozen manifest, family registry, taskset lock and all
  positive/negative independent reference outcomes.
- `gallery.tar.xz`: the unchanged gallery coverage ladder, notation views,
  exact per-prediction serialized prompts/targets, and aggregate costs.
- `real.tar.xz`: the stratified real-source ladder and exact serialized inputs.
- `interactions.tar.xz`: script interaction coverage and exact serialized inputs.

Extract an archive with `tar -xf ARCHIVE.tar.xz -C NEW_DIRECTORY` after creating
the new directory. The archived reports record their original scratch output
paths only as run locations; those paths are not required for rechecking.

These receipts precede the new runtime, compact `/2` lowering and v8 region
integration. They must remain identified as this baseline. Fresh integrated
results need their own producer/consumer/tokenizer pins and cannot overwrite
these files or inherit their success flags.
