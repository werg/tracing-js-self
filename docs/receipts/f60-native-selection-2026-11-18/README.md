# F exact-public selection and complete native equivalence

All 60 frozen-F candidates were admitted after the separately recorded same-bound
serial retry. The strengthened selector retained **52 unchanged representatives**
and explicitly mapped eight private task aliases across four groups. These are
four exact-public groups within the twelve distinct-function candidates;
the remaining 48 candidates have distinct public execution streams.

The retained split is four training examples from one source component and 48
test examples from five components, with no validation examples. The frozen
registry and splits were not changed. This targeted repair cohort is not a
balanced training corpus, and selection is not evidence of model learning.

The actual pinned native adapter independently compared every field of each
alias episode with its representative. Only `lineage.task_id` was removed for
comparison. **All eight aliases passed**, including equality of every record,
mask, lineage ancestor/family/split field, supervision field, dependency, and
provenance field. The original 60 admissions and all 62 attempt records remain
in the complete original audit campaign.

Both tools ran at `TZ=UTC LC_ALL=C.UTF-8`, using the exact F producer verifier
`22eaac6a46e262b00986c63b4fc66f6240016252`, consumer
`1cee21dd07a687b0a824abff1bbd5ef9a13149ab`, and the actual pinned tokenizer.
The producer and consumer tracked files were clean. The selected export files
total 281,688,021 bytes; preparation uses the same unmodified bytes.

Original locations:

- Audit campaign: `/workspace/scratch/23f61543c052/release-evidence-F/requalification`.
- Selected corpus: `/workspace/scratch/23f61543c052/deliverables/release-F-requalification/selected`.
- Native equivalence proof: `/workspace/scratch/23f61543c052/release-evidence-F/exact-public-native-equivalence/native-equivalence.json`.

The exact selector options were `--deduplicate-exact-public true --tracer-root
../tracing-release-F`, with the complete campaign as input and a new output
directory. The independent proof used `tools/verify-exact-public-aliases.mjs`
with the exact producer, consumer, selected corpus, tokenizer, and capture Python
environment. The complete reports, logs, and file digests are retained here.

Native preparation is a separate subsequent gate; its outcome is not asserted
by this selection receipt. No admission, consumer guard, raw source, original
history, or model output was modified. There were no optimizer updates or model
inference calls.
