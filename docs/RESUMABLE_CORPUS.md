# Collecting, resuming, and releasing a source-backed corpus

The collector rebuilds authored examples, pinned real sources, and bounded
generated programs through the current v5 source, replay, and native admission
gates. A previously successful local check is evidence to revisit a candidate;
it is never an admission receipt.

The workflow below keeps rejected attempts, freezes related sources together,
and separates learner-visible records from compressed private evidence.
Run each campaign from an unchanged, committed producer checkout. Keep that
checkout available for later source rechecks and packaging.

## 1. Freeze sources before expanding inputs

Create one registry spanning all intended recipes. Its default inventory covers
engineering, training-v4, benchmark-v1, real-source, and generated-v1. The
historical recipe names still produce v5 records.

```sh
node tools/freeze-source-registry.mjs \
  --out ../corpus-run/source-registry.json \
  --generated-families 16 \
  --holdout-projects exercism/javascript \
  --holdout-compositions square/even/maximum/alias/return
```

This particular composition belongs to the default generation seed, 73. Unknown
holdout names are errors. Choose the projects and compositions before examining
model performance. The full connected component is held out, including any
related authored wrappers or other sources.

The registry reuses exact and normalized source fingerprints, near-clone
comparison, ancestor identities, literal-insensitive shapes, and stable upstream
project/path relationships. It assigns an entire connected component to one
split. Source changes and renamed wrappers cannot create independent families
merely by changing their names. Conservative grouping may also merge genuinely
different computations; component counts remain heuristic diversity measures.

The default inventory includes all twelve reviewed utility invocation wrappers.
Input expansion may then reuse those exact registered sources. A candidate with
an unregistered transformed source is refused. `--prior-registry FILE` retains
prior distinct source versions and refuses an extension that would reassign an
existing family's frozen split. Resolve such conflicts as a new reviewed
release policy; do not override individual row splits.

## 2. Verify the native environment

Use the exact consumer revision and tokenizer identities in
`contracts/native-admission-policy-v5.json`. The selected Python must import its
consumer package from that checkout. Modified tracked consumer files are
rejected even when its Git revision appears unchanged.

The commands below use deployment-specific variables for three existing paths:
`NATIVE_PYTHON`, `MEGATOKEN_ROOT`, and `TOKENIZER_FILE`.

```sh
export TZ=UTC OMP_NUM_THREADS=1 MKL_NUM_THREADS=1

"$NATIVE_PYTHON" tools/native-consumer/check_environment.py \
  --megatoken "$MEGATOKEN_ROOT" \
  --tokenizer "$TOKENIZER_FILE" \
  --out ../corpus-run/native-environment.json
```

Timezone reaches the JavaScript worker and its reference/native children.
Credential and proxy environment variables are not forwarded to generation
workers. This is a defense against accidental disclosure, not operating-system
isolation for arbitrary untrusted programs.

## 3. Collect a bounded campaign

Start with a small, inspectable cohort. This real-source command attempts two
inputs per utility or exercise and up to two per production helper:

```sh
node tools/generate-effectful-training.mjs \
  --recipe real-source \
  --source-stream utilities,exercism,production \
  --per-family 2 \
  --registry ../corpus-run/source-registry.json \
  --out ../corpus-run/real-source \
  --jobs 2 \
  --worker-memory-mb 768 \
  --worker-timeout-ms 120000 \
  --max-output-bytes 268435456 \
  --compact-storage \
  --megatoken "$MEGATOKEN_ROOT" \
  --tokenizer "$TOKENIZER_FILE" \
  --native-policy contracts/native-admission-policy-v5.json \
  --python "$NATIVE_PYTHON" \
  --require-native
```

Use another output directory for each recipe. Authored fixtures and generated
programs use the same worker and admission path. For example, generated-v1
supports `--generated-families 16 --per-family 4 --generation-seed 73 --input-seed
89`. The reviewed grammar has 144 structural choices, bounded source/AST size,
arrays of at most seven elements, aliases, branches, loops, and planned throws.
Execution supplies every label. These choices are related compositions, not
144 independently invented algorithms.

The real-source bridge locks upstream bytes and retains source/transform
provenance and notices. It independently executes original and transformed
sources before the ordinary owned/source/native checks. Canonical Exercism
returns must match their separately specified value. Canonical error cases
require an actual thrown completion; their language-neutral description need
not equal JavaScript's error message. The comparison scope is recorded, while
the original, transformed, and owned executions must still agree on the exact
JavaScript exception graph.

The first complete manifest contains every attempted disposition. Exit status
1 means at least one candidate failed the requested qualification level; inspect
the retained manifest and failure evidence. Successful rows remain available.
An unsupported source, malformed fixture, oracle failure, resource limit,
semantic disagreement, or native rejection is never a correct training target.

`--per-family 12` inventories 1,171 current real-source attempts: 936 utility
invocations, 201 active canonical exercise cases, and 34 helper invocations. These are
attempt counts, not promised admissions. `--mutations-per-family` adds bounded
exercise input variations. Freeze all required source variants first.

## 4. Resume or retry without changing identity

Repeat the same generation command with `--resume`. Successful receipts are
reused only when the campaign and candidate identities match. Those identities
include producer source/tool bytes, exact source/input/fixture, profile, runtime,
dependency locks, native policy, and consumer environment. A changed producer,
consumer, tokenizer, or input cannot reuse stale proof. Start a new campaign
after such a change.

Use `--retry-failures` together with `--resume` to append new attempts for refused
candidates under the same identity. Earlier attempts remain in the chained log.
Increasing an input limit is possible only when existing candidate identities
remain identical and every new source belongs to the frozen inventory.

Each completed result is written before the collector proceeds. Public and
private objects are checksummed, atomically renamed, and recorded in a chained,
append-only log. A partially written final log line can be preserved and
recovered by resuming collection. Read-only selection and materialization refuse
an incomplete log so they do not edit their original evidence.

SIGINT or SIGTERM cancels active worker process groups and records completed or
cancelled attempts where the controller can finish. After an abrupt process or
machine loss, completed log entries survive; rerun missing work. Use one
controller per output directory. Concurrent writers to the same campaign are
not supported.

## 5. Keep compact evidence, then select training data

With `--compact-storage`, the campaign holds separate public records and
compressed private objects. Repeated frozen registries are stored once under
`objects/registries`. Private references identify exact replacement paths;
rehydration checks stored bytes, expanded size, and the original logical JSON
hash. Registry references never enter public traces or native admission input.

The candidate record uses canonical value graphs, preserving null prototypes,
aliases, undefined, and special numbers. Sources, inputs, and fixtures also have
content-addressed objects. Private failures remain accessible through result
objects and are retained across retries.

Select only native-admitted rows, with caps measured in actual tokenizer output:

```sh
node tools/select-admitted-campaign.mjs \
  --input ../corpus-run/real-source \
  --out ../corpus-run/selected \
  --max-family-tokens 20000 \
  --max-family-share 0.20
```

The caps apply to frozen source components within the training split.
Evaluation tokens cannot subsidize a training component's share. Evaluation
rows remain unless an explicit `--split` filter excludes them. If the requested
share is impossible, selection removes rows rather than silently relaxing the
cap. An empty selection is an error with an exclusion report.

The selection report records each training component's token count and share,
split-level episodes, declared families, source components, and actual token
counts. Component grouping policy is explicit. The complete original campaign
remains necessary for excluded attempts and private audit references.

For a compatibility view without selection:

```sh
node tools/materialize-campaign.mjs ../corpus-run/real-source \
  --out ../corpus-run/materialized
```

This leaves the original campaign unchanged and restores the complete original
export JSON. Omitting `--out` writes compatibility exports into the campaign.
Materialization never changes a row's admission status.

## 6. Recheck and package a private release

The packager accepts a compact complete campaign directly. It stages a copy,
uses the exact producing checkout's materializer, and preserves the original
CAS and refusals in the archive. It then reruns independent source verification
and native preparation before writing the final release manifest.

```sh
"$NATIVE_PYTHON" tools/package-semantic-release.py \
  --corpus ../corpus-run/real-source \
  --tracer-root . \
  --megatoken "$MEGATOKEN_ROOT" \
  --tokenizer "$TOKENIZER_FILE" \
  --environment-receipt ../corpus-run/native-environment.json \
  --out ../corpus-run/private-release
```

When packaging a selected or externally materialized view, also pass
`--audit-campaign ../corpus-run/real-source`. Its original manifest hash and
campaign identity must match the view's declaration. The complete source
campaign is included, so excluding a row does not discard its evidence.

Verify an existing archive without extracting it:

```sh
"$NATIVE_PYTHON" tools/package-semantic-release.py \
  --verify ../corpus-run/private-release/semantic-v5-release.tar.gz
```

Archive verification checks every member and the release identity. It is an
integrity check; the packaging step's fresh source/native receipts establish
qualification. Package document loading and archive hashing/copying stream
bounded chunks. The companion consumer's audit writer also streams complete
private rows atomically; use the consumer revision required by the producer's
current release policy.

The consumer-facing compatibility JSON and prepared audit still retain the full
registry inside each original identity. Disk space must cover that expansion.
The compact campaign avoids repeated persistent compressed registries, but it
does not change the admission schema or conceal this prepared-data overhead.

## Reading measurements and limits

Each successful episode reports actual branch outcomes, loop tests/backedges,
call depth, heap/alias and mutation counts, exceptions, causal async depth,
pending effects, context/public bytes, path signature, and native generated
tokens when available. A loop without an explicit test can report unknown trips;
byte counts are never described as tokenizer counts.

Throughput separates fresh generation from cached work. Campaign wall time,
summed verification time, worker RSS, unique paths, declared source families,
source components, and storage bytes have different denominators. Worker heap
limits do not impose a whole-process-tree RSS or CPU quota. Native/reference
children and the operating system add resources beyond the reported JavaScript
worker RSS.

The [frozen measurement receipt](evidence/semantic-v5/corpus-storage-and-selection-2026-11-18.json)
records a 25-row native release check, compact rehydration and release check,
actual token-cap selection, and byte-equivalent private-registry compression.
Four admitted real-source sidecars decreased from 2,772,950 compressed bytes to
393,984 bytes including the shared registry, an 85.79% reduction. This measures
those four private sidecars, not the size of all prepared data.

Arbitrary untrusted native programs still need operating-system isolation with
controlled network, files, credentials, and process resources. The current
trusted-source restriction remains in force. Source-component holdouts also do
not establish that public code was absent from a model's pretraining data.
