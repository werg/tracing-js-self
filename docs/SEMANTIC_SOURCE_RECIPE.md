# Source recipe for the semantic training stages

`training-v4` is a deterministic, source-certified recipe for the configured
common-support and effectful stages. Collection, native preparation, lifecycle
collection and supply validation run without an optimizer. It is a small
engineering supply corpus; it does not establish learned execution quality.

## Authored tasks and ancestry

The complete template declaration is `src/training/recipe-fixtures.js`. Its 16
tasks cover geometry, arithmetic transforms, modular time, bit flags, bounds,
piecewise costs and parity. They were authored as distinct source algorithms
before inspecting their split assignments. The recipe retains every template.
It never searches for a family name or seed that moves an input variant into a
desired split.

The existing family hash with seed 17 places 13 families in train, modular-clock
and flag-union in validation, and squared-distance in test. Every input,
representation, callback, checkpoint, repeated activation and child descendant
retains its task family and `source-template:<name>` ancestor. The manifest pins
the full template declaration digest as well as producer, operation and native
consumer identities. A common collection scaffold is not a new independent
task family.

Each family supplies three source executions:

- A pure calculation for explicit and compact common-support traces; its
  independently verified completion also supplies the outcome-only control.
- A read followed by two owned callbacks, captured-cell updates and native
  writes. Collection takes a real selected checkpoint at the first pending
  read, restores it, evicts and rereads source, and reconciles the actual
  delivery without repeating the external operation.
- Two independently checked fresh calls sharing one program publication. The
  combined session retains both original private source checks and distinct
  invocation, realm, track and trigger identities.

The first repeated-session component in each of train and validation is also
native-admitted as a single-root child input. These two files are listed in
`manifest.recipe.lifecycleInputs`; they are genuine source executions with
native read/write effects. Megatoken's lifecycle collector executes the real
create, assign, join, child-completion, wake and restore path around those
children and preserves their frozen source split.

## Collection

Run from the pinned tracer checkout with the paired Megatoken environment and
immutable production tokenizer. Use separate output directories for each
representation:

```sh
node tools/generate-effectful-training.mjs --recipe training-v4 \
  --representation explicit --jobs 4 --out /tmp/semantic-recipe-explicit \
  --megatoken ../megatoken --python ../megatoken/.venv/bin/python \
  --tokenizer ../megatoken/.validation/tokenizer.json --require-native

node tools/generate-effectful-training.mjs --recipe training-v4 \
  --representation compact --jobs 4 --out /tmp/semantic-recipe-compact \
  --megatoken ../megatoken --python ../megatoken/.venv/bin/python \
  --tokenizer ../megatoken/.validation/tokenizer.json --require-native
```

`--jobs` accepts 1 through 8 independent workers and defaults to 1. The manifest
and output case order follow the authored declaration regardless of completion
order. Each representation emits 48 family cases plus two admitted child inputs.
Without native tooling the same command produces only `locally_verified`
candidates, which cannot satisfy production admission.

The existing default `engineering` recipe remains available for capability and
counterfactual regression fixtures. It is separate from this stage-supply
recipe. Both recipes support `--representation explicit|compact`.

## Native preparation and required supply gate

The manifest's `role` distinguishes `common-support`, `effectful` and
`lifecycle-child` inputs. Prepare the common-support explicit and compact data
with their matching representations; prepare outcome-only data from the same
explicit pure cases. Prepare effectful explicit and compact data separately.
Add the real lifecycle collector outputs to their corresponding effectful
representation. Do not mix representations or promote controlled trajectories
into source-certified labels.

The final preflight uses the actual native prepared corpora, not manifest stage
labels. For each configured phase, call
`megatoken.data.recipes.validate_stage_supply(config, corpus, split=split)` for
both `train` and `validation`, where `corpus` is a `PreparedCorpus` opened for
that split. SC requires code/invocation supply; SO requires admitted pure outcome
controls; SE requires code/invocation, tool feedback, async execution, callbacks,
repeated invocation, child lifecycle, source reread and recovery. A missing
family in either split fails. This gate never imports or invokes an optimizer.

Run the source lineage and behavior regression with:

```sh
node --test test/training-source-recipe.test.js
```
