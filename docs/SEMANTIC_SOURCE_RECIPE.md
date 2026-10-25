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

Session composition keeps each independently collected root in a distinct realm.
Owned callbacks retain that root's realm, source, and declared parent; they are
activated by their certified event ingress rather than proposed again as roots.
Composition requires globally unique invocation, subscription, and event-ingress
identities. Independently collected components that both allocated `event1` or
`callback1` are refused explicitly: composition never renames already certified
selected bytes. This is a limit of combining separate collections; a single live
harness allocates unique identities for multiple subscriptions normally. Fixture
call indices, including callbacks targeting an earlier subscription and its close
receipt, are rebased into the combined external environment.
Observed state-refresh cutoffs and digests are reconstructed by replaying the
composed public prefix, because envelope sequence numbers change during
composition. Original component source certificates and every selected witness
byte remain unchanged; the composed receipt contains only the state justified
by the combined prior public history.

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

## Expanded benchmark fixtures

`benchmark-v1` is a separate authored engineering fixture catalogue. It does not
change `training-v4`, any archived cohort, or the semantic protocol version.
The declarations in `src/training/recipe-fixtures.js` each specify a distinct
source algorithm; the generator derives external fixture observations from
those declarations, then the ordinary owned execution, independent Node
reference, projection/replay and optional native-consumer gates produce labels.
The declarations are engineering fixtures, not learned or model-generated
data. Family splits use the existing seed-17 family hash policy and are
reported as observed; the catalogue retains every family without tuning names
or seeds to force a desired split.

The initial catalogue declares 42 loop, state and array algorithms, including
Euclidean GCD/LCM, iterative factorial and Fibonacci, bit operations, integer
square root, prime counting, array reductions/search, inversion counting,
maximum subarray, and stock profit. Their bounded inputs are fixed in the
catalogue. Normalized AST checks reject duplicate algorithms within this
catalogue and against the original `training-v4` pure-source families. With the
current seed-17 hash this yields 32 train, 7 validation and 3 test families.
Each family expands to one pure case, one retained-callback recovery case and
one composed repeated-invocation session containing two separately checked
inputs. This is 126 primary outputs per representation, plus two source-derived
lifecycle child inputs (one from train and one from validation). A family is
counted once regardless of its input variants, callback activations or
representation. The generated manifest includes per-family split and
normalized source-AST digests, the split counts, role coverage and ancestry.

Generate explicit or compact candidates with the same native preparation
arguments documented above, replacing `training-v4` with `benchmark-v1` and
using a fresh output path. The manifest lists all algorithm declarations,
family identities, source ancestors and actual family-hash splits. Every pure,
callback and repeated-invocation variant inherits its source algorithm family;
input variants and representations never increase the independent-family
count. The benchmark regression is:

```sh
node --test test/training-benchmark-recipe.test.js
```

Freeze a benchmark test declaration and its versioned source-family metadata
sidecar separately from the v4 cohort contract:

```sh
node tools/freeze-selected-evaluation.mjs /tmp/semantic-benchmark-explicit \
  /tmp/benchmark-test-declaration.json --benchmark-v1 \
  --metadata-output /tmp/benchmark-test-metadata.json

node tools/freeze-selected-evaluation.mjs /tmp/semantic-benchmark-explicit \
  /tmp/benchmark-common-test-declaration.json --benchmark-v1 --common-support \
  --metadata-output /tmp/benchmark-common-test-metadata.json
```

The declaration retains the existing Megatoken evaluation schema. The sidecar
pins the source manifest and declaration digests and lists each held-out family,
algorithm, ancestor, fixed split, observed case roles and normalized AST digest.
The freezer refuses a non-benchmark corpus and does not modify the frozen v4
cohorts or their split policy.
