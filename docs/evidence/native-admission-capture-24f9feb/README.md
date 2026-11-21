# Explicit native admission throughout the V6 capture diagnostics

This run uses clean producer `24f9febbba473bbdb5f36b81cb108cc3e0c6310a`
and the policy-pinned consumer `3a0eb90e3e7282e9b3cb2ca0da27454451b50e21`.
It retains the original reports for all five stages of the native-conditioning
workflow, using the actual production tokenizer and CPU model weights.

The read-only captures explicitly declare the existing frozen V6 cohort and
engineering receipt. The separately labeled one-record decoder fit keeps the
saved ordinary trainer configuration and global step unchanged. No admission
guard was disabled, and no generated record was replaced with a teacher record
in the serving path.

| Stage | Actual result |
| --- | --- |
| Fresh source/native admission | One asynchronous training episode admitted at the exact pair |
| Initial native conditional and supervision audit | Gaussian, recurrent state, actual decoder support and token-mask audit passed |
| One-record decoder diagnostic | Exact first target `promise create @p1` emitted after 16 diagnostic optimizer updates |
| Two-boundary comparison | Both boundaries passed; one actual returned record passed the public controller; recurrent differences were zero |
| Fitted supervision audit | Passed, including the future-observation canary changing the later numeric result from 7 to 8 |

These are bounded diagnostic results. They do not establish ordinary optimizer
resume, whole-episode execution, held-out learning, generalization, or default
cutover readiness. The capture stages perform zero optimizer updates; the fit
performs 16 explicitly recorded diagnostic updates.

## Reproduction and retained evidence

`summary.json` records the exact revisions, commands and key measurements.
`reports.tar.gz` retains **54 original JSON/JSONL reports and logs**, totaling
12,327,556 uncompressed bytes. Every member was decompressed and checked against
its original SHA-256 and length. `inventory.json` records the archive hash and
every included or omitted file. Reports retain their original absolute paths
and identities; they were not rewritten to resemble another revision.

The archive excludes model tensors, duplicate tokenizer files and SQLite stores.
Those files are enumerated by their original digests, but this report archive is
**not a complete retained model bundle**. The complete-model-bundle acceptance
gate remains open. The sequence is reproducible from the exact revisions with
the commands already defined in `.github/workflows/native-conditioning-parity.yml`
and the locked dependencies in `tools/native-consumer/requirements.lock`.

The initial failed attempts are retained separately. `initial-import-refusal.log`
shows the Python environment correctly refusing a different consumer checkout.
`initial-two-boundary-refusal.log` shows the second capture missing its explicit
policy at producer `72f0011`. The hosted run
<https://github.com/werg/tracing-js-self/actions/runs/44889618046>
failed at the same point. These failures are not counted as successful evidence.

To inspect the retained reports without changing any source checkout:

```sh
mkdir restored-reports
tar -xzf reports.tar.gz -C restored-reports
```

The original serving emissions, including invalid emissions before fitting,
remain in the archive. A successful first record is not a successful program.
