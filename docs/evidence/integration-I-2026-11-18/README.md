# Fresh I unit and native coordinator integration — 2026-11-18

All requested integration gates passed at frozen producer `c2a64424d052f9b90a340a59a8d74cf5564e47aa`, using consumer `6e27a7c6529aa0778c5ea818432461db7cd05ea7` except for the explicitly historical C checkpoint checks.

| Gate | Actual result |
| --- | --- |
| Full `npm test` Node suite | 945 passed, zero failures, cancellations or skips |
| Reference fixture, included in `npm test` | 8 checks passed |
| OS confinement and isolated original/instrumented source gates | Both executed and passed |
| Native coordinator tests, enabled in the full Node invocation | All 5 executed and passed |
| Independent new-consumer RPC validator | All 5 fresh evidence files passed: 2 controlled completions and 3 expected refusals |
| Full Python native-consumer tool tests | 56 passed |
| Full Python release regressions | 85 passed, 6 explicitly skipped artifact-dependent cases |
| Separate retained-checkpoint artifact regressions | 14 passed, zero skips; includes all six artifact-dependent cases |

The full Node/reference process took 159.88 seconds. It recorded 536,412,160 bytes as the maximum child-process lifetime RSS, not aggregate concurrent process memory. Each gate retains its exact command, environment, exit status, duration, raw log hash and actual imported consumer path.

## Reused H model dependency

The five native coordinator gates use the unchanged initialized engineering model originally created under producer H `881664b98ec9d484f9f4775d0b40a3a2b1b81174` and consumer `6b4382b9af3bef120ca3a95ae24d35154d4cd66b`. Its served checkpoint identity is `c7d9040ec72553cf84d1030bd8481b0f03dcfaeb989b2e347239aee135aa0943`, seed 17. The ten retained initialization/served payloads matched their original H receipt hashes before execution and remained byte-identical afterward. No initialization or optimizer update of the reused H model occurred.

The current executions and independent validation use consumer `6e27a7c...`. Four cases use explicitly controlled selections to check completion, cancellation and rejection behavior. The fifth uses the actual initialized model, retains its rejected selected bytes and cost, and is an expected refusal. These results do not claim useful learned coordination or generalization.

The before/after inventories reference the existing H artifact bundle; model binaries are not duplicated in the I integration evidence. The process receipt records `MEGATOKEN_ORCHESTRATION_SERVED`, `MEGATOKEN_ORCHESTRATION_EVIDENCE_DIR`, `MEGATOKEN_PYTHON`, `MEGATOKEN_REPOSITORY`, `MEGATOKEN_ROOT`, tokenizer path and `PYTHONPATH` explicitly.

## Original C artifact regression boundary

The 14 artifact checks use I's validation implementation against the unchanged original C checkpoint and served bundle in `release-evidence/optimization-full-epoch`. They retain original model producer `c4296c271eec32c2f2ab4cd34c30fd8b61e6ba39`, original consumer `277edd4a2983e81f5e2a71b34a7ce29348e4e7a0`, and its original Python environment. I is recorded only as the tool revision.

The tests verify genuine original artifacts and reject copied/rehashed tampering with tokenizer, configuration, transducer bank, model version and claimed training membership. Original checkpoint, served files, report and training configuration hashes are unchanged after execution. The broad release test's six omissions remain explicitly reported; the separate original-environment run supplies their actual results.

## Temporary regression fixture and retrospective H scope

The requested full Python release suite includes `test/test_learning_artifacts.py`. Its module-scoped fixture creates a temporary tiny model and synthetic 256-token tokenizer, then performs **TWO UPDATES PER SYNTHETIC FIXTURE** using the sum of the first parameter tensor as its loss. Twenty tests using this fixture passed. These operations create artifacts for integrity/tamper regressions; they are not semantic-learning experiments or measurements of useful model execution. Aggregate fixture initialization/update counts were not instrumented and are left null. The receipt does not infer a process-wide total from the fixture’s per-instance update count.

The preserved H broad Python receipt also used this identical fixture source and its JUnit records twenty passing fixture tests. Its global `optimizerSteps: 0` field must not be interpreted as an accurate process-wide optimizer count. The new `integration-scope-clarification.json` records that retrospective correction and binds the original H receipt, JUnit and source hashes. No original H file or delivered archive was modified. The separate H/C fourteen-test artifact module does not invoke this synthetic fixture; statements that the retained H and C models were unchanged remain accurate.

## Evidence and limits

`integration-qualification-v2.json` is the canonical summary. The raw `release-evidence-I/integration-file-index-v2.json` authenticates 29 completed integration files totaling 2,539,950 bytes, plus the index itself. The first receipt and index are retained unchanged; v2 corrects the first receipt’s overbroad global initialization field and explicitly accounts for temporary regression fixtures. These include full logs, JUnit results, reproducible runners, five RPC files and model dependency inventories. Temporary test directories and external model binaries are excluded.

Qualification SHA-256: `658cda766d75aec907b3b4ae3f5a9521499623d90fd53fb9fe087806528f070c`.

Index SHA-256: `a79821543a8b12ae3789d1dc3693d6b472ffcad56c45056f0792c2b1532cc1d2`.

The fresh I finite native capability ladder is a separate qualification. These integration results do not requalify the historical D/F corpora, change prior model experiment outcomes, or substitute for production training/held-out evaluation evidence.
