# Causal bootstrap gate evidence — run 45030773600

This directory retains the completed hosted run and its exact uploaded artifact for the causal bootstrap/recovery gate. It is evidence of a failed candidate gate, not evidence that all controls passed. No rerun was performed for this record.

## Candidate identity and runtime

- Workflow source: `source-pins/workflow.yml`, from producer `ae5fa0f13fc8e8d8996cb6ff360c209ae2f83fa8`.
- Paired native checkout: `werg/megatoken` at `56cce3b80423b0cb70c3a096d867561066e3a211`.
- Run: `45030773600`, attempt 1, branch `codex/v8-bootstrap-causal-unified-20261122`; job `137233651896` (`paired-bootstrap-recovery`).
- Runtime observed in the complete job log: Ubuntu 24.04 runner image `20261116.376.1`, Node `24.22.3`, npm `11.19.1`, Python `3.12.14`, Torch `2.10.0+cpu`, pytest `8.4.2`. The workflow required the kernel time namespace, and native / host test gates required non-skipped execution.
- Exact workflow action pins and package/runtime inputs are copied into `source-pins/`.

## Result as retained

- Native JUnit: 151 test cases, 0 failures, 0 errors, 0 skips; job log reports `151 passed`.
- Host JUnit: 170 `<testcase>` elements, 4 failures, 0 errors, 0 skipped. The complete job log embeds Node reporter comments of `tests 175`, `pass 171`, `fail 4`, `skip 0`. The five additional entries in the Node summary are passing parent `<testsuite>` containers, not additional leaf cases: 170 leaves + five parents = 175 reported tests, and 166 passing leaves + five passing parents = 171 reported passes. Qualification counts the 170 individual leaf cases; both raw views are preserved unchanged.
- Three host failures are in later-sibling/create-bootstrap fixture paths. Each reaches the fixture server and fails because `_fixture_records(final_action)` passes an argument to a zero-argument lambda, raising `TypeError: main.<locals>.<lambda>() takes 0 positional arguments but 1 was given`.
- The fourth failure is the actual Python `track_cancel` reconciliation test, which reports `Native v8 process already closed`. This record does not infer that this is caused by the three fixture errors.
- The workflow required every native and host control to pass with zero skips, so the overall run conclusion is failure.

## Preserved raw evidence

- `durable-bootstrap-history-controls.zip` is the original downloaded GitHub artifact. Its SHA-256 matches the upload digest printed by the job log: `4fefbefa16d67a6022ff8c46e6df65c1c8811aeb26c6c9e45cf4f18b39bfaf3b`.
- `complete-job-log.txt` is the complete job log byte stream.
- `native-bootstrap.xml` and `host-bootstrap-history.xml` are the exact JUnit files extracted from the uploaded artifact.
- `run-metadata.json`, `failure-summary.json`, and `SHA256SUMS` record source identity, raw result views, and file integrity.

The workflow artifact was configured for 90-day retention (expiration `2027-02-20T14:04:01Z`).
