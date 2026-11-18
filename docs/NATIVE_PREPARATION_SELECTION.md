# Selecting exact public representatives before native preparation

Independent candidate admission and native training-set preparation have different
denominators. Several candidate IDs can describe the same exact public execution
stream while retaining different private task IDs or input-generation indices.
Every original candidate and admission receipt remains useful audit evidence.
Feeding those aliases directly to the native store can correctly fail: the native
adapter derives one episode ID from the execution payload, while its immutable
episode guard refuses changed lineage metadata under that ID.

The optional selector mode resolves these aliases before preparation:

```sh
TZ=UTC LC_ALL=C.UTF-8 node tools/select-admitted-campaign.mjs \
  --input /path/to/complete-campaign \
  --out /path/to/new-selected-corpus \
  --tracer-root /path/to/exact-producing-checkout \
  --deduplicate-exact-public true
```

The option defaults to `false`. It does not rewrite any candidate identity,
source, selected token, observed byte, frozen split, native admission receipt, or
private task ID. The representative is the lexicographically smallest candidate
ID among compatible aliases, regardless of source manifest iteration order.
Exact equality uses the existing SHA-256 over the exact serialized public
document; this is not a source-similarity or near-duplicate heuristic.

For a historical campaign, `--tracer-root` loads its exact immutable producer's
CAS reader and native-admission identity verifier. The current selection tool
can then apply its stronger selection rule without substituting newer runtime
implementation bytes into the original verifier environment. The producing Git
revision must match the manifest and tracked files must be clean. Original
environment checks, including the recorded timezone, remain mandatory; this
option does not relax them. Without the option the selector uses its own checkout.

## Required compatibility and audit evidence

Aliases must use the same authenticated source-component policy, frozen registry,
component, and split. Their producer environment, native consumer, tokenizer,
native policy, semantic contracts, representation, license/trust tier, token
counts, and physical-record counts must agree. Every private metadata input
consumed by the v5 native adapter must also agree: source family/lineage,
ancestor IDs in their actual native order, parent episode ID, frozen split,
admission, reference status, representation, and selection provenance. The only
permitted native episode difference is `lineage.task_id`. Different native
families or ancestors are refused even inside the same frozen component.
A collision across components, splits, native metadata, or native contracts fails the selection and writes a separate
`selection-conflicts.json`; it cannot silently choose one side. Collision checks
run before an optional train/validation/test filter so a hidden excluded split
cannot bypass them.

`selection-report.json` records each exact-public group, its public digest,
representative ID and private identity digest, declared source families, and all
alias IDs. Each alias exclusion separately retains its immutable candidate and
durable-entry digests, private result reference, task ID, source family,
ancestors, frozen component/registry/split, provenance digest, native receipt
digest, and representative linkage. It also records whether the representative
survived a later token budget or split selection.

Selected exports retain their original complete bytes. Aliases remain admitted
in the original campaign; `exact_public_alias` is a selection exclusion, not a
changed admission result. All source families and ancestry remain recoverable
from the archived original campaign when an identical stream has more than one
private task/provenance record with the same native lineage. Selected-family counts describe representatives
only and do not count excluded aliases as separate training exposure.

The full original campaign is mandatory when packaging a selected corpus:

```sh
/path/to/pinned-native-python tools/package-semantic-release.py \
  --corpus /path/to/new-selected-corpus \
  --audit-campaign /path/to/complete-campaign \
  --tracer-root /path/to/exact-producing-checkout \
  --megatoken /path/to/exact-native-checkout \
  --tokenizer /path/to/tokenizer.json \
  --environment-receipt /path/to/verified-native-environment.json \
  --out /path/to/new-release
```

Use the original source runtime environment, including its recorded timezone.
The packager checks the original campaign digest and manifest, archives its CAS
objects and refusals, and independently reruns source and native admission for
each selected representative. It does not accept a changed source revision to
match a newer selector revision.

## Native deduplication still applies

The consumer's immutable episode-ID guard and exact/near-duplicate policies are
unchanged. For the November 18 capture requalification example, twelve admitted
candidates form four public streams. Representative selection therefore retains
four exports and records eight aliases. The native consumer may then classify
two of those four distinct streams as near duplicates with the same causal
training contract, leaving two prepared rows. Report all three counts and the
native dispositions; do not present twelve successful admissions as twelve
unique prepared training examples.

The strengthened rule is recorded as `exact-public-within-frozen-component/2`.
Version-1 selections remain historical outputs. A later verification must compare
complete actual native episode dictionaries, removing only `lineage.task_id`,
and preserve the original selected corpus while recording its result separately.

The original failed preparation and its explicit immutable-ID refusal report
remain historical evidence. A new selected preparation belongs in a new output
directory and receives its own manifest, fingerprint, and archive receipt.
