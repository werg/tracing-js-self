# Derive a current full native sampler

`tools/derive-native-prepared-sampler.py` produces the full
`semantic-native-prepared-training-sampler/1` input required by the maintained
coverage selector. It reads a **new actual native preparation** and its complete
original campaign. The historical hardwired D derivation and reduced D receipt
remain unchanged.

## Run after current native packaging

Use the exact producing checkout, a tracked-clean companion checkout at that
producer's `contracts/native-admission-policy-v5.json` revision, and the pinned
production tokenizer. The Python environment must already contain the native
data dependencies. This command neither downloads a tokenizer/model nor starts
training.

```sh
python tools/derive-native-prepared-sampler.py \
  --prepared /path/to/new-release/prepared \
  --audit-campaign /path/to/original-campaign \
  --producer-root /path/to/exact-producing-tracing-js-self \
  --megatoken /path/to/pinned-megatoken \
  --tokenizer /path/to/pinned-tokenizer.json \
  --max-family-tokens 10000 \
  --max-family-share 0.20 \
  --out /path/to/new-sampler

node tools/select-native-prepared-coverage.mjs \
  --sampler /path/to/new-sampler/sampler.json \
  --source-manifest /path/to/original-campaign/manifest.json \
  --out /path/to/new-coverage-selection
```

`--producer-root` defaults to this repository. The tooling checkout can differ
from the producing checkout; both revisions and the exact files used are
recorded. The native revision and tokenizer are taken from the producing
checkout's policy, with no inferred compatibility or pin override.

The first command derives the existing identity-ordered token-budget control.
The second computes coverage-aware membership over its **complete**
`acceptedDecisions` population, including accepted rows excluded by the control
budget. Token and share caps apply only to training rows. The coverage selector
can receive explicit replacement budget flags when comparing a separately
declared policy. Neither command changes source splits or prepared bytes.

To materialize the resulting selection through the actual native storage APIs,
use the existing authenticated subset exporter:

```sh
python tools/materialize-native-prepared-subset.py \
  --parent /path/to/new-release/prepared \
  --sampler /path/to/new-coverage-selection/sampler.json \
  --audit-campaign /path/to/original-campaign \
  --megatoken /path/to/pinned-megatoken \
  --tokenizer /path/to/pinned-tokenizer.json \
  --out /path/to/new-native-subset
```

This last command is separate because a membership report is not a newly
exported native dataset. It rechecks the parent identities, actual token IDs and
free masks, final native deduplication, frozen splits, and output budgets.
For current samplers it also reauthenticates the separate candidate and native
task identities against the hash-bound parent audit. Historical samplers that
predate these fields retain their original strict task-equals-candidate check;
they cannot authorize a different native task identity.

## What the derivation verifies

The command runs the maintained complete campaign verifier, including refused
attempts and compact CAS objects. It records exact manifest/header/log/object
hashes, the frozen campaign identity, and source registry identity. Original
documents are rehydrated through `CampaignStore`, so shared registry references
do not need a compatibility JSON export. Every rehydrated frozen split identity
is revalidated against its full source registry, original component, and split.

For the native input it verifies the complete manifest, index and shard hashes,
then opens the actual pinned `PreparedDataset` with checksum verification. It
joins every dedup row to its audit by exact native episode ID. The audit's
source `identityDigest` and public `episodeDigest` must identify exactly one
original campaign candidate. Both receipts, the sidecar identity, source
revision, consumer revision, and tokenizer must agree. `lineage.task_id` must
match the audited sidecar's `taskId`; it is retained as `nativeTaskId` separately
from the campaign candidate `id`. These values can legitimately differ, and
multiple candidates can share a task ID without being collapsed. A task name
is never a fallback for missing or ambiguous content identities.

Every accepted row also joins the entire prepared index. Missing, foreign,
repeated, ambiguous, or unexplained rows fail the command. Native exclusions
retain their duplicate and quarantine reasons.

Each input episode is reconstructed from its exact archived source document
using the pinned `adapt_selected_harness_v5`. The command recomputes actual
native admission with the production tokenizer and preparation geometry,
compares that result to `semantic-audit.json`, and checks the archived source
receipt with the native receipt verifier. It compares full native Episode
bytes, reassembled logical record digests, encoded token IDs, free masks, and
generated/scored/observed counts. The source oracle is not rerun by this
inventory command; its archived source receipt is reconciled to the verified
campaign rather than represented as a fresh source execution.

The audit array is read one object at a time. Each UTF-8 JSON row is limited to
256 MiB, and the maximum row count is the exact dedup database population. The
whole-file 256 MiB limit is removed: a larger campaign can contain many bounded
rows. Duplicate JSON keys, malformed or truncated arrays, trailing data,
nonfinite values, and oversized rows fail. Only the small source/native
receipts, join fields, and a SHA-256 of the **complete** supervision sidecar are
retained. Reconstruction compares that hash with the complete rehydrated
original sidecar, including private witnesses that are absent from the compact
projection. The raw audit file remains hash-bound before and after its use.
This is a serialized-row bound, not a Python process memory quota.

The existing `preparedBudgetGroups` implementation rebuilds the conservative
transitive union of frozen source components and native resolved families.
Cross-split source families or merged components fail before selection.
`balanceFamilyTokens` remains the control selector. Every native-accepted
validation and test episode is retained with its original identity and split.

## Complete populations and earlier omissions

Current release packaging can select training members before native
preparation. Therefore the original campaign can contain admitted candidates
that never entered this native preparation. `upstreamOmissions` enumerates those
exact candidate identities and original splits. It does not guess whether an
omission was an alias, an earlier training cap, or a separately selected input.
Those dispositions remain in the original selection/release evidence.

The report distinguishes:

- Original attempted candidates and original native admissions.
- Inputs recorded in the final native dedup database.
- Native exclusions, including duplicates and quarantine.
- Every native-accepted prepared row.
- New sampler membership and accepted training rows excluded by its budget.
- Original admissions absent from this native preparation.

Repeated `already_present` native inputs are refused. They require an explicit
representative campaign instead of a silently reduced denominator. A native
preparation with refusals is also refused by this release-oriented derivation;
the original failed preparation remains available for diagnosis.

## Output and failure behavior

The output directory must be new and outside the immutable campaign and native
preparation. Successful output contains:

| File | Evidence |
| --- | --- |
| `sampler.json` | Full accepted decisions, immutable source/native identities, token budgets, evaluation membership, native exclusions and upstream omissions. |
| `inventory-verification.json` | Exact input/tool file hashes, pinned revisions, sampler hash, reconstructed row count and scope declarations. |
| `campaign-verification.json` | Complete original campaign verification, including non-admissions. |
| `native-audit-proofs.jsonl` | One compact proof per native input, retaining source/native receipts, both identity domains, and a hash of the full original supervision sidecar. |
| `native-row-verification.jsonl` | One receipt for every native input episode, binding its full Episode, original document, native/source receipts and encoded tokens/masks. |
| `source-documents.jsonl` | Exact selected original documents rehydrated from the campaign; includes the existing private audit sidecars. |

The directory is built under `OUT.building` and renamed only after all checks.
On failure, `failure.json` and any completed row receipts remain in
`OUT.building`. It reports `completeSampler: false`, does not replace a previous
sampler, and exits unsuccessfully.

Manifest, report, index, dedup database, campaign header/log, tokenizer and code
files are bound before their parsed or verified use. Later reads preserve the
first binding and recheck it between phases and before final publication; a
concurrent writer cannot replace an earlier snapshot by being rebound later.

All successful inventories declare `optimizerSteps: 0` and `learnedSuccess:
null`. Coverage membership and static target inventories do not establish
actual optimizer exposure, conditional parity, or learned execution success.
The existing coverage CLI can attach consumed-target accounting only when an
actual optimizer report and its hash-bound native schedule are supplied.

## Local verification and external execution

```sh
python test/test_native_prepared_sampler.py
node --test test/native-prepared-coverage.test.js
```

The focused fixtures exercise different and shared native task IDs, authenticated
candidate joins, complete-sidecar tampering, altered identities/splits/counts,
missing/repeated/foreign/ambiguous rows, stale pins, fragmented records, scored
context, streaming UTF-8 and JSON boundaries, cross-split native/source unions,
sealed SQLite files, materializer identity gates, and the maintained coverage
CLI handoff. Their token counts are explicitly synthetic test inputs.
They are not an actual native admission or learned result. Full production
reconstruction requires the actual current campaign, sealed prepared archive,
pinned consumer, and production tokenizer in the native engineering lane.
