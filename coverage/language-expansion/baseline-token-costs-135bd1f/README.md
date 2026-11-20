# Exact token costs for the retained pre-expansion baseline

The original source producer is `e88219121d1a09a6f93d161038f162e6b0f6ef54`.
The meter is `135bd1fcf58e4abf1685008899b815160676dd30`, with codec consumer
`761c1e3ca5fdbc440ab6abe246b6f1f47e9b9d6a`. The exact tokenizer identity and
source hash are recorded in both JSON receipts.

This run tokenizes the unchanged v7 prompt/target bytes retained in
`coverage/language-expansion/expansion-e882191`. It verifies the original
archive and file hashes, then encodes whole prompts and whole targets as
separate physical segments followed by one EOS. Exact segments and generated-only
loss mask runs are retained in the compressed archive. Original prompt strings
remain in the separately hash-bound historical archives; no current source
producer or serializer was substituted.

| Historical population | Declared | Token measured | Prompt tokens | Target tokens | EOS | Total flat tokens |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Real source | 27 | 27 | 12,358,809 | 29,870 | 916 | 12,389,595 |
| Gallery | 11 | 11 | 451,622 | 2,756 | 89 | 454,467 |
| Script interactions | 12 | 4 | 293,810 | 1,928 | 70 | 295,808 |
| Retained populations | 50 | 42 | 13,104,241 | 34,554 | 1,075 | 13,139,870 |

The other eight script interactions retain their original source dispositions
and have no measured baseline cost. The 624 family reference executions and two
module interactions have no retained baseline serializer costs. No zero-cost
value is imputed for any missing baseline.

`report.json` is the complete aggregate receipt. `archive.json` binds every
uncompressed file and the deterministic `artifacts.tar.xz`. Extract the latter
into a new directory to recover all 42 per-case token receipts and the exact
aggregate report. The source and entry digests and rooted input identities are
available for explicit matched-subset comparisons; the original full graph
digests and unreachable internal node counts remain separately recorded.

These are retrospective serializer token counts. Historical source admission
is unchanged; native serving, cache reuse, learned execution, next-step accuracy,
latency and model comprehension remain unmeasured. Default promotion remains
not qualified.
