# Exact-public representative selection and actual native preparation

The original E capture requalification contained **12 independently admitted
candidates**, representing **four exact public execution streams**. Each stream
appeared three times with a distinct private task ID. Native episode identity is
derived from the selected payload, so the consumer correctly refused eight
attempts to reuse an immutable episode ID with changed lineage metadata. The
original failed preparation report is preserved here without alteration.

Read-only native adaptation confirmed that the complete episode within each
three-candidate group was identical after removing only `lineage.task_id`.
Records, masks, source family, ancestors, split, and causal training contract
agreed. No consumer guard, native episode ID, admission, source artifact, or
frozen campaign was changed to bypass the refusal.

The new explicit selector option was applied to the complete original campaign:

```sh
TZ=UTC LC_ALL=C.UTF-8 node tools/select-admitted-campaign.mjs \
  --input /workspace/scratch/23f61543c052/release-evidence-E/capture-requalification \
  --out /workspace/scratch/23f61543c052/deliverables/release-E-capture-representatives/selected \
  --deduplicate-exact-public true
```

It selected four representatives and recorded eight `exact_public_alias`
exclusions, each linked to its original immutable candidate/private identity,
task, source ancestry, component, native receipt, and retained representative.
All four exported files were verified byte-identical to their original
materializations. All twelve raw candidates remain admitted in the original
campaign; selection exclusions do not change that history.

Actual native preparation reran source and native admission for each of the four
retained exports, using the exact producer
`1b391c19c3c8137d5b00c5412e53614a568b3704`, consumer
`1cee21dd07a687b0a824abff1bbd5ef9a13149ab`, verified capture environment, and the
actual pinned tokenizer. All four independently re-admitted, with **zero
preparation refusals**. The consumer's existing near-duplicate policy retained
two rows and marked the other two as duplicates with the same causal contract.
Those unchanged native dispositions are recorded in `native-dispositions.json`.

| Stage | Count |
| --- | ---: |
| Original independently admitted candidates | 12 |
| Exact public streams selected unchanged | 4 |
| Private task aliases retained in audit and excluded from preparation | 8 |
| Selected inputs independently re-admitted during preparation | 4 |
| Native duplicate dispositions | 2 |
| Unique accepted native prepared rows | 2 |
| Preparation refusals in the new run | 0 |

The verified archive contains **70 files**, including the complete original
campaign and its CAS objects, the selected corpus and alias mapping, native
prepared data and audit sidecars, environment/lock files, and source notices.
The archive's inventory and every member were rehashed after writing.

- Original archive path:
  `/workspace/scratch/23f61543c052/deliverables/release-E-capture-representatives/package/semantic-v5-release.tar.gz`
- Archive SHA-256:
  `75d09e16491b71741a2d83705a3d74be101378962cf6e68cfdf7754ce169a65a`
- Release identity:
  `4fedb6f9646d8042b54edfe5d8cbfa51e2be1192abb357435228c5d6a83f3196`
- Selector implementation commit:
  `39048f0ebb3dba0036e6379ae2da97b2ff866c4a`

The initial failed package remains at its original separate location. Its eight
immutable-ID refusals are not erased or relabeled. This successful package used
new output directories, no optimizer updates, and no model evaluation. It makes
no learning claim. The complete byte-level archive remains a separate artifact;
this receipt directory commits the small selection, preparation, disposition,
and archive-verification records.
