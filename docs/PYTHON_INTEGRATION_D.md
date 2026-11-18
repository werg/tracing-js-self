# Final D Python integration verification

The requested integration suites passed **62 tests, with zero failures, errors,
or skips**, using `native-venv-fixed` and the actual imported Megatoken checkout
`b88073dcb5a8e438a711d494a5fd592e773798f5`. Tests ran from the clean primary
tool checkout `dfd36d7e2d77b83339d82ff50c2ecdf874b6e2f3`; hashes of the relevant
tests and tools stayed unchanged throughout the run.

| Suite | Passed |
| --- | ---: |
| `test/test_learning_comparison.py` | 30 |
| `test/test_learning_artifacts.py` | 20 |
| `test/test_optimization_smoke_selection.py` | 5 |
| `tools/native-consumer/test_release_bundle.py` | 7 |
| **Total** | **62** |

Pytest reported 12.13 seconds; the enclosing process took 14.923 seconds.
These are test execution timings. The synthetic artifact fixtures perform two
artificial parameter-sum optimizer updates to exercise checkpoint/budget
binding. They provide no semantic-learning or model-performance evidence.

The bound test receipt is
[`evidence/python-integration-D-2026-11-18.json`](evidence/python-integration-D-2026-11-18.json).
The release evidence directory `python-integration/` retains the concise
`pytest.log`, `junit.xml`, original receipt, and read-only boundary review.

## Read-only source and native boundary review

The frozen D producer remained
`83e0d5742e63dc4439b68d6296f323cb7a3aafdc`, with a clean tracked tree. Its
recomputed execution environment exactly matched the frozen baseline. The
later tested tool checkout has no changes to the producer's `src/` or
independent reference worker. The native consumer remained clean and matched
the policy revision and environment tree; the actual tokenizer bytes and
requirements-lock digest also matched.

All **16 admitted rows in the completed D real-source pilot** were inspected
read-only. Their public and private object checksums matched, public envelopes
contained only the v5 public schema/timeline fields, timeline records did not
contain the checked private audit fields, and private metadata/receipt pins
agreed with the manifest, frozen producer, consumer, and tokenizer. Teacher
evidence retained zero optimizer steps and no learned-success claim.

Code inspection confirmed these specific boundaries:

- Single and session admission rebuild private identity and independently
  recheck source/replay evidence before accepting the bound native receipt.
- The native adapter deep-copies both invocation input graphs and observed
  result graph objects before simulating guest writes.
- Production preparation invokes independent source verification and fresh
  native admission before adaptation. Private supervision goes into a separate
  atomically written audit artifact.
- The release packager checks the actual producer/consumer checkout and native
  import location, validates tokenizer bytes, and recollects production
  preparation evidence.

The code hashes, checks, and inspected pilot identities are retained in
[`evidence/release-boundary-review-D-2026-11-18.json`](evidence/release-boundary-review-D-2026-11-18.json).
No integration defect was found in this scoped verification. This review did
not rerun the full corpus, produce another native admission, or execute a model
rollout. Checksums and revision pins establish consistency for trusted inputs;
they do not provide external authentication or a hostile-code sandbox.
