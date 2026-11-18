# Training selection from the native-prepared D census

The real-source D campaign produced **541 native-prepared examples** after
native deduplication. The separately derived training selection keeps **211
examples: 132 training, 27 validation and 52 test**. It retains every accepted
evaluation example and every training source component while limiting the
largest component to 7.175% of selected training generated tokens.

The [machine-readable sampler receipt](evidence/semantic-v5/real-source-prepared-sampler-D-2026-11-18.json)
contains every included candidate, native episode and prepared entry ID; every
training-cap exclusion; every native duplicate; before/after distributions;
and exact source, native index, codec, policy and manifest identities. The full
private report and its derivation script are bound by SHA-256 in that receipt.

## Distinct release stages

| Stage | Count | Meaning |
| --- | ---: | --- |
| Original attempted candidates | 1,171 | The complete qualification census, including refusals |
| Original native-admitted candidates | 987 | Per-candidate admission under producer D and consumer `b88073d` |
| Exact-public aliases | 22 | Retained original candidates represented by an equivalent public stream |
| Selected representatives | 965 | All independently rechecked and re-admitted during native preparation |
| Native duplicates | 424 | Removed by the native preparation deduplicator; identities remain explicit |
| Native-prepared examples | 541 | Accepted final native index entries; zero new refusals or quarantines |
| Capped selection | 211 | A derived membership list over those 541 entries |
| Accepted training examples excluded by caps | 330 | Retained in the unchanged full prepared census |

The exact-public representative proof compared the complete actual native
Episode projection for all 22 aliases across 16 groups, allowing only the
private task ID to differ. Its SHA-256 is
`d54d7e92a003547e1c29279583d97a65d6f3589fc0186ef802b277f7e45c63c3`.
The [original campaign report](REAL_SOURCE_D_QUALIFICATION.md) preserves the
initial 184 non-admissions independently of later requalification work.

## Declared policy and measured effect

Before measuring the final prepared selection, the policy was fixed at
**10,000 native generated tokens per training component** and **20% maximum
training component share**. The existing deterministic `balanceFamilyTokens`
implementation from frozen producer D computed the membership. Validation and
test examples bypass training caps and remain unchanged.

| Split and measurement | Full native-prepared inventory | Capped selection |
| --- | ---: | ---: |
| Training examples | 462 | 132 |
| Training generated/scored tokens | 505,181 | 139,145 |
| Training declared families | 74 | 47 |
| Training conservative components | 21 | 21 |
| Largest training component share | 44.5945% | 7.1745% |
| Validation examples | 27 | 27 |
| Validation generated/scored tokens | 3,310 | 3,310 |
| Test examples | 52 | 52 |
| Test generated/scored tokens | 38,179 | 38,179 |
| All examples | 541 | 211 |
| All generated/scored tokens | 546,670 | 180,634 |

The strict token cap reduces the number of declared training families from 74
to 47. All 21 conservative training components remain represented. The largest
selected component contains 9,983 generated tokens; the 20% share condition is
therefore comfortably satisfied. These counts expose the diversity tradeoff
rather than implying that caps preserve every source variant.

Budget groups are the transitive union of frozen source-component membership
and native resolved-family membership. Any merged group crossing frozen splits
would refuse selection. For this inventory there are 32 groups overall,
including 21 training, two validation and nine test groups. These are
conservative relationship groups, not counts of independent algorithms.

## Verified accounting

The derivation maps every one of the 965 native deduplication records to its
original candidate through `lineage.task_id`. It recomputes native episode
IDs from reassembled logical payloads, checks the pinned codec on physical
records, and distinguishes that native digest from the producer's
whole-public-JSON digest.

For every record, the original admission receipt's generated-token count
equals both native `assistant_tokens` and `scored_positions`. This equality
is checked for this strict v5 mask profile; it is not assumed for other
corpora. Observed tokens equal total transcript tokens minus generated tokens.
The derivation never uses total transcript length as a proxy for learner
targets. The complete prepared inventory contains 1,941,188 transcript tokens,
of which 546,670 are eligible targets and 1,394,518 are observed/context tokens.

Accepted index membership, entry IDs, native resolved family, frozen split,
transcript tokens and scored positions are cross-checked against the final
native deduplication database. The index checksum, prepared fingerprint,
manifest, deduplication database and native report are bound in the sampler
receipt. All accepted evaluation IDs are compared before and after selection.

## Scope and reproducibility

The full report is
`release-evidence-D/real-source-native-prepared-sampler.json`, SHA-256
`73bee1222cd372d595c98863e727142bba7f800f234047d77751523b1a0e97f6`.
The read-only derivation is
`release-evidence-D/derive-prepared-training-selection.py`. A committed
[reproduction script](evidence/semantic-v5/derive-real-source-D-sampler.py)
accepts `--workspace /path/to/release-workspace` and produces the same report.
It uses the final
prepared SQLite inventories, immutable producer D, and its existing balance
function. It creates no duplicate exports and does not modify any campaign,
selected document, native data, admission receipt or split.

This is a static reproducible sampler membership list. No optimizer or model
sampler was executed for it. The reported shares describe one pass through the
included native generated-token inventory; repetition or later sampling
weights can change actual training exposure. Earlier pre-preparation cap
calculations are separate audit artifacts and are not the final prepared
selection reported here.

## Directly consumable native subset

The membership was subsequently materialized as a **211-example native-prepared
dataset**. The [native subset release receipt](evidence/semantic-v5/real-source-native-capped-release-D-2026-11-18.json)
records all per-episode checks, exact archive hashes and three refusal probes.
Its splits and tokens match the capped selection above exactly. There are zero
additional duplicates or quarantines, and every native family label remains
unchanged.

The materializer uses the pinned consumer's normal `PreparedDataset`,
`DedupStore.add`, `freeze` and `export_prepared` APIs. It checks the authenticated
parent, original campaign, codec and selection before writing into a fresh
staging directory. It then reopens every output example through the native
reader and compares complete serialized Episode bytes, token IDs, free masks,
lineage, frozen split and token totals against the parent. A changed parent
manifest, repeated subset identity or removed evaluation example refuses
before creating output. SQLite indexes and manifests are generated by the
native API; the tool does not edit them directly.

The prepared directory occupies 39,250,178 bytes. Materialization and complete
readback took 7.885 seconds with peak Python process RSS of 410,202,112 bytes.
The resulting prepared fingerprint is
`315569ccbe98f95f46ae0551819fa2c1ffe0833d0c38f0fd4c98e000abcb3443`.

The private archive
`deliverables/release-D-real-source-capped/semantic-native-capped-release.tar.gz`
is 77,464,260 bytes, SHA-256
`e59a167d4192efbdb499a382ee3108425503e6d268544d6dbb78cbe867eef25c`.
All 5,339 files were verified. It includes all 5,315 original audit-campaign
files and all 1,171 original candidate dispositions; their inventory matches
the complete D release byte for byte. The bundle also retains source notices,
locks, native environment, parent release and preparation receipts, selection
and alias proofs, materializer, and sampler. Its release identity is
`b2d73fa8ad35bda0fd18107599b505133cb84eee35719213d75647df71484b4b`.

After extracting the archive, the pinned native environment can consume its
`prepared` directory directly:

```python
from megatoken.data.storage import PreparedCorpus

with PreparedCorpus(["/path/to/extracted/prepared"], split="train") as training:
    assert len(training) == 132
    episode, assets = training.fetch(0)
```

The actual `PreparedCorpus` reader was checked separately for all three splits:
132 training, 27 validation and 52 test examples. To reproduce native subset
materialization from the full D parent and the complete sampler report:

```sh
TZ=UTC /path/to/pinned-native-python tools/materialize-native-prepared-subset.py \
  --parent /path/to/full-D-package/prepared \
  --sampler /path/to/real-source-native-prepared-sampler.json \
  --audit-campaign /path/to/original-D-real-source-campaign \
  --megatoken /path/to/clean-b88073d-consumer \
  --tokenizer /path/to/tokenizer.json \
  --out /path/to/new-native-capped-prepared
```

This release inherits source admission from the independently rechecked parent;
it introduces no new source executions or admissions. It adds a fully verified
native storage artifact to the earlier sampler report. No optimizer update or
learned-success result is attributed to this subset.
