# Exact hosted baseline: a494f007 / 776519e

These results belong to producer `a494f007f7373fa4d96b76be88c5610fb815d6e8`
and policy-pinned native executable `776519e69b32b11927edd60eab84c77cebfe2a9c`.
Later checkpoints, including the namespace observer, child bridge and census
repair, require their own qualification. The native CPU run separately uses
`0f572ebb76c67df28195aa46c5e8558f5b0a09ae`, a workflow-only follow-up.

## Completed results

| Gate | Result |
| --- | --- |
| Full producer Node20/22/24 suite | Per version: 2,544 tests, 2,536 pass, zero fail, eight skips. These are overlapping runs, not 7,608 distinct tests. |
| Native V8 component selection | 689 pass, zero fail/skip in each V8 population job. |
| Selected interoperability population | 66/66 original-source checks and independent native admissions; 66/66 exact-token and native-packing measurements. |
| Gallery | Separate 11/11 source/native/token/packing measurements. |
| Ordinary lifecycle on selected66 | Passed prepare, train, fresh resume, export and real service restoration, exactly two optimizer updates. |
| General native CPU CI | Python3.11/3.12 jobs passed; inspected3.12 log has 3,630 passes,83 skips,20 warnings. Accelerator job skipped. |

Producer suite run: https://github.com/werg/tracing-js-self/actions/runs/44959532505

Source/native run: https://github.com/werg/tracing-js-self/actions/runs/44959532480

Native CPU run: https://github.com/werg/megatoken/actions/runs/44959825948

The eight Node skips per version are two unavailable OS namespace controls, one
external V7 tokenizer-path control and five V6 bridge asset controls. They remain
skips. The old failed full-suite attempts remain separate evidence.

For selected66, flat measurement has 77,765 generated tokens, including76,153
detailed tokens (97.9271%), plus2,406 EOS and3,961,593 context/observed tokens.
Native packing has2,603 logical and9,286 physical records,77,765 generated and
4,043,178 observed tokens, with zero terminal tokens. Flat and physical framing
totals are not interchangeable.35 episodes contain compact regions and31 are
wholly detailed. Learned task success, serving latency/cache savings and default
promotion remain unmeasured or unqualified.

## Interrupted original665 attempt

All **665 original-source checks and665 independent native admissions** completed
successfully. A separate producer PR push advanced the remote branch to
`d1e304557f1ef795eb582de197c4b7eedf87f6f1` at23:36 UTC on21 November, and workflow
concurrency cancelled the run during flat token measurement. The job's original
log and all5,038 uploaded files are preserved. No completed flat665 measurement
or installed665+66 qualification is claimed. The latter step did not run.

`v8-all-a494-interrupted.tar.xz` preserves every uploaded member, with a complete
per-file SHA-256 manifest. Its source artifact is14730540879, original ZIP48,103,947
bytes, SHA-256 `856216451e3f2c56730549f6c97e7e49b88cac14072319fd124b3970d5ce70d7`.
Repacked archive:5,558,348 bytes, SHA-256
`1875bcfaaa8ef89824741148e02d933d5c3f0ecf91ec54efb6b7709d7bee8aeb`.
The5,038 member files total742,500,193 uncompressed bytes.

## Retention and reproduction

`v8-interop-a494-proof.tar.xz` preserves579 files containing every source/native/
token/packing record, prepared data, lifecycle report and log from the66-case
job. Its manifest explicitly lists nine excluded model/tokenizer binary paths,
their exact lengths and SHA-256 values. Those binaries remain in original
Actions artifact14729772222; they are **not** claimed as retained in this proof
archive. This is a file-retention distinction, not a change to the recorded job
result. Original ZIP133,348,871 bytes, SHA-256
`5f9d8cd9cd7984b2a11cbd4748ab98428efe9e85946e6a5d566c12836110de81`.
Proof archive2,176,160 bytes, SHA-256
`8e975d97edc3e7bac33c93114a5f33933525a2efb83fcaaef9194ccd4a96c2cf`.

`v8-gallery-a494f007.zip` is the complete original11-case artifact14729427563,
SHA-256 `8adad5596193d06a87f48139ba95dec86f57345966f63dd8bbf9c510b58e1804`.

`tools/repack-v8-ci-evidence.py` reproduces the deterministic XZ tar bytes from a
downloaded ZIP with its recorded checksum. Use `--exclude-model-assets` only for
the66-case proof archive; do not use it for the complete interrupted665 archive.
Every omitted file remains explicit in its generated manifest. Original Actions
artifacts expire under the workflow's retention policy, so durable retention of
the excluded model binary assets remains open. Compressed raw logs and separate
readable reports retain original statuses and identities.

The paired source-reread fixture and native census repair are separate increments
and do not alter these historical receipts.0/17 complete acceptance packages are
closed by this baseline.
