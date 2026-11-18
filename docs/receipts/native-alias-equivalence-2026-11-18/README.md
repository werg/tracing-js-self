# Complete native episode equivalence for exact public aliases

These independent native adaptation receipts verify every field of each
`Episode.to_dict()` after removing **only `lineage.task_id`**. They retain all
other lineage, payloads, masks, dependencies, supervision, provenance, and tracks.
They use each campaign's exact producer verifier, consumer, and actual tokenizer.
Neither receipt creates an admission or changes an original campaign or export.

| Campaign | Raw admissions | Exact public representatives | Aliases checked | Alias groups | Native consumer |
| --- | ---: | ---: | ---: | ---: | --- |
| D real source | 987 | 965 | 22 | 16 | `b88073dcb5a8e438a711d494a5fd592e773798f5` |
| E capture requalification | 12 | 4 | 8 | 4 | `1cee21dd07a687b0a824abff1bbd5ef9a13149ab` |

Both comparisons passed. The only permitted difference is a candidate-specific
private task identifier. The strengthened selector also binds the source family,
ordered ancestor IDs, parent episode, frozen source component, and split before
choosing the lexicographically first representative. Cross-component, split,
family, ancestry, or other native metadata differences fail closed.

The complete D campaign has 1,171 candidates. Its 184 original nonadmissions stay
in the audit. Selection excludes those 184 plus 22 task aliases, producing 965
unchanged exports: 848 train, 48 validation, and 69 test. Native preparation must
still independently re-admit them; this receipt is not a prepared-corpus claim.

The first D selector attempt used a current verifier and a different timezone;
all 987 historical admissions correctly failed their environment binding. That
failed selection remains in its original directory. `D-verifier-routing-probe.json`
demonstrates that the exact D verifier at UTC accepts the untouched case while
the current verifier refuses it. A separate `selected-v2` run uses the exact
producer `83e0d5742e63dc4439b68d6296f323cb7a3aafdc` at UTC. No environment or source
identity check was relaxed.

E's original successful four-representative package predates the stronger
selection policy. This read-only retrospective comparison proves that its eight
aliases satisfy the stronger policy and complete native field equality. The
original package, report, and twelve raw admissions therefore remain unchanged.
Its native preparation separately retained two rows and reported two ordinary
native duplicate dispositions, as recorded in the adjacent
`exact-public-selection-2026-11-18` receipt directory.

Reproduction uses the committed tools, with the original complete audit campaign
and selected directory named in `file-index.json`:

```sh
TZ=UTC LC_ALL=C.UTF-8 OMP_NUM_THREADS=1 MKL_NUM_THREADS=1 \
TMPDIR=/workspace/scratch/23f61543c052/test-temp \
node tools/verify-exact-public-aliases.mjs \
  --input ORIGINAL_CAMPAIGN --selection SELECTED_DIRECTORY \
  --tracer-root EXACT_PRODUCER --consumer-root EXACT_CONSUMER \
  --tokenizer-json /workspace/scratch/23f61543c052/tokenizer.json \
  --python EXACT_CONSUMER_PYTHON --out NEW_PROOF_DIRECTORY
```

The verification tools are in commit `88ce11fca203c5cfae83789594ee67e544059fd8`.
Their focused tests cover full native metadata mismatches. These receipts record
zero model inference calls and zero optimizer steps and make no learning claim.
