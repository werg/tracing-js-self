# Isolated native coordinator follow-up

**Passed: all five existing optional native coordinator tests; zero failures,
cancellations, or skips.** The tests ran serially after all six broad native
admission workers had exited. No producer/native source or test was changed,
and every original RPC, execution, cleanup, and test deadline was preserved.

This is a targeted follow-up to the failed full producer run retained in
producer commit `2030f0d85a51bcbc10efa0a7c6565f849006285c`, under
`coverage/language-expansion/producer-regression-012c9fe`. That original run and
its failures remain unchanged. This follow-up does not relabel its 1,840 passes,
three failures, and one cancellation as a successful full-suite result.

## Exact scope and identities

- Producer: `012c9fe49a082319bf98ac0c571596da925741a4`.
- Native consumer: `39c4036564428e44cc89caf261f517d856482695`.
- Node: `v24.22.3`; native Python: `3.12.14`.
- Original test file: `test/training-orchestration-evaluation.test.js`.
- Both checkouts and every served-bundle byte remained unchanged before and
  after the run; the complete identities are in `run.json`.
- Started `2026-11-20T18:17:36.273368+00:00`; finished
  `2026-11-20T18:19:04.614001+00:00`. The Node test runner reported 88.165 seconds;
  the outer command measured 88.340 seconds. These are diagnostic timings, not
  a controlled performance comparison.

The tests use `scripts/serve_selected_semantic.py` and the existing compact
selected-execution/coordinator path. Four use explicit controlled lifecycle
and semantic selections; the fifth retains an actual initialized-model
rejection. They do not establish learned execution or replace v8 corpus
admission, the v8 component suite, or the separate model study.

## Findings

| Original failing gate | Original retained evidence | Unchanged-bound isolated result |
| --- | --- | --- |
| Async, callback, and throwing children | The first 30-second RPC expired; no native reply, coordinator state, child selection, or host dispatch was returned. | Passed all exact whole-task checks; 72 native RPC replies and all six tracks completed. |
| Rejected semantic child | The deliberately invalid `return @missing` was correctly rejected and its bytes retained. Cleanup exceeded its 1-second acknowledgement bound; the last acknowledged state still showed a waiting parent and active child. | The same rejection was retained, followed by acknowledged cancellation; both tracks cancelled and zero pending tracks/resources. |

The original controlled opener sends its first RPC before a separate model
initialization handshake, so that first deadline covers Python/bundle startup
and native prefill of all observed proposals. The original evidence cannot
separate those stages. The original cleanup failure preserves the last
acknowledged state and closes the process; it does not retain a successful
post-cancellation state. Both additional failures are consistent with deadline
pressure under the earlier concurrent run. No lifecycle or semantic defect
reproduced here, and no semantic code change was needed.

The other three original gates also passed: retained callback state, explicit
coordinator budget cancellation, and original initialized-model rejection.
All five retained native receipts report zero leaked resources. Expected
negative-test rejections remain in their original evidence.

## Unchanged limits

Every RPC retains its 30-second limit. The services evaluation retains 60
seconds; the longer retained-context evaluation retains 240 seconds; budget,
invalid-child, and initialized-model evaluations retain 30 seconds each.
Cleanup retains 1 second, except the pre-existing retained-context test's
3-second limit. Outer test limits remain 120 seconds, except that same
retained-context test's existing 290-second limit. The five gates remain
unmodified; only the test runner's file-level concurrency and name selection
scope differ from the complete original run.

## Exact available bundle and substitution

The local zero-update bundle is fully retained in `served-bundle.tar.gz.part-*`.
Its actual model weights exactly match the original reported baseline:

`2a7eefffb21e8901150e6932ccd3d7f048fa2efb0ed4d9ebc9072feab43f0452`.

Model configuration, tokenizer, chunking, format, control, and lifecycle
identities also match the original recorded manifest. The configuration SHA256
is `ed7a2f92ac01415c92ae93b8fc1144c5e260c9bbed8f5ba1da9dc7ff399f910f`.
The production tokenizer SHA256 is
`40fb9d7d7795b8bd305aeff39ce9963f3f450915b9553f2938e009be9a1fed60`.

The full original external bundle was unavailable. Its checkpoint SHA and
transducer-bank bytes differ from this local bundle; both original and local
values are explicitly recorded in `plan.json` and `run.json`. This is a
compatible-bundle diagnostic with identical model weights and configuration,
not a byte-identical reproduction of the original full bundle. It cannot
establish the exact internal state reached after the earlier timed-out calls.

`served-bundle-archive.json` binds every archive part, the combined archive,
and all five served files to their exact byte lengths and SHA256 values. Each
member was re-read and checked after compression. The original checkpoint
archive is not required to load this retained serving bundle.

## Inspect or repeat

Run `python3 verify.py` from this directory to verify every retained file, all
five native evidence members, the joined bundle archive, and each served-bundle
member against the recorded hashes. This integrity check does not rerun the
model or the tests.

The raw original command, relevant environment, clean identities, test-file
hash, unchanged bounds, and original failure-package hashes are in `plan.json`.
`run.json`, `unit.stdout.log`, `unit.stderr.log`, and `native-orchestration.tar.xz` retain the actual run. The archive contains the five original JSON files under `native-orchestration/`; extract it into a new directory before inspecting them. `original-failure-analysis.json`
extracts the two original failure dispositions without modifying their source
archive. Preparation-only predecessor files are retained separately and were
never executed; the final plan clarifies that the unchanged tests prepare
their own source fixtures without restarting broad corpus qualification.

Use clean checkouts of the two exact revisions above with the pinned Node and
locked Python dependencies. Reassemble the parts in numeric order into a new
directory, verify the combined SHA256 against `served-bundle-archive.json`, and
extract the archive. Then set `MEGATOKEN_ORCHESTRATION_SERVED` to that extracted
`served/` directory and use a new evidence directory:

```sh
export MEGATOKEN_REPOSITORY=/path/to/clean-consumer-39c4036
export MEGATOKEN_PYTHON=/path/to/locked-native-python
export MEGATOKEN_ORCHESTRATION_SERVED=/path/to/extracted/served
export MEGATOKEN_ORCHESTRATION_EVIDENCE_DIR=/path/to/new-evidence
export PYTHONPATH="$MEGATOKEN_REPOSITORY/src"
export PYTHONNOUSERSITE=1 PYTHONDONTWRITEBYTECODE=1
export OMP_NUM_THREADS=1 MKL_NUM_THREADS=1
export TMPDIR=/path/to/writable-temporary-directory

cd /path/to/clean-producer-012c9fe
node --test --test-concurrency=1 \
  --test-name-pattern='^(native |actual initialized-weight native coordinator)' \
  --test-reporter=tap test/training-orchestration-evaluation.test.js
```

The absolute paths in the retained runner describe the original execution.
The command above permits equivalent clean local paths while preserving the
test contents, assets, identities, and every original deadline. No optimizer
or model-quality claim is added by this diagnostic.
