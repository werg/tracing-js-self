# Actual-model closed-session recovery and complete consumer tests

## Canonical published run

Producer `dc7595e9a4764a3f6fceb4218fd01aa3192222e4` (tree
`ee558234987e0697b40ff0081ead1a43ce97eae7`) and consumer
`1ddcc6110d70703f6b08244d53ec461047677bec` (tree
`c5dd2b212fc82c1d18c3852a0be6a10ec12f9128`) were clean.

Session A's first original model record was validated against the live producer
state and acknowledged by the native service. The same service then sampled
session B from a separately replayed public source/input prefix. B emitted
**18 original model tokens**. Its malformed output was refused by the producer,
then B was cancelled without semantic acknowledgement.

The checkpoint retains **one active session A, one closed session B, two original
opening receipts, and both consumed attempts**. A fresh ordinary service restores
the complete active/closed state, original attempt and cost evidence, RNG state
and continuation fingerprints. Reusing B's request is refused before sampling and
does not alter the native checkpoint. A's next output is the same exact,
provenance-bound **refusal** before and after restart; it is never acknowledged.

Independent original-source, projection and public-prefix checks pass. There are
**zero host dispatches**, one acknowledged nonterminal A record, zero acknowledged
B records, no new training, and no full-program, held-out or generalization claim.
Durable terminal cancellation after the independently trusted head, distributed
ownership and general live-service recovery remain separate requirements.

Complete inputs, emitted bytes, original failures/refusals, cancellation receipts,
native checkpoints, service profiles, commands, identities and output reports
are under `published-dc7595e-1ddcc61/`.

## Costs without double-counting restored history

The canonical run records **12 measured RPCs**, **10.338629592995858 reported
compute seconds**, and **528,011,264 peak process bytes** across both service
lifetimes after subtracting inherited checkpoint RPC/compute totals. These
figures stop at the last recorded transport metrics; shutdown occurs afterward,
and historical model training is excluded.

Native attempt/token profiles retain prior consumed history on restore. They
cannot be summed as fresh token generation across process lifetimes.
`metadata/results.json` retains original, saved/inherited, restored/cumulative,
new-restore-process and combined totals explicitly.

## Exploratory run and exact source retention

The earlier clean exploratory producer `1a6f03e4dcbcbf25002fbd4b0366014e60f398cf`
was based on published `19eba4f`, with the same consumer `1ddcc61`. It also
passed, with the same actual acceptance/refusal boundaries. It is retained under
`exploratory-1a6f03e/` and is not relabeled as a test of `dc7595e`.

That original report used `siblingCandidatesReturned: 0` because the producer
transport refused B's malformed bytes. The native checkpoint proves B emitted
18 tokens. Follow-up commit `818a15f` added separate native-emission and producer
decode/refusal fields plus payload identity checks; the canonical published run
includes that correction. Original exploratory report bytes remain unchanged.

`metadata/exploratory-producer.bundle` preserves both local qualifier commits
exactly, with published producer `19eba4f` as its sole prerequisite. After
checking out that prerequisite, `git bundle verify` and `git fetch` can recover
the exact exploratory commit and its follow-up. The canonical tool is directly
available in published producer `dc7595e`.

## Complete repaired consumer selection

At clean consumer `1ddcc61`, using clean producer `19eba4f`, the complete
installed semantic selection passed **625 tests, zero failures or skips**, in
623.17 seconds. It includes every `test_*v8*.py` file plus
`test_algorithm_v7.py` and `test_protocol_properties.py`, with the actual
pinned tokenizer and CPU dependencies. The full log and JUnit results are under
`logs/`. This selection is distinct from the repository's whole general CPU suite.

The previous consumer `39d5212` run remains **611 passed / one failed**, retained
in the preceding automatic-history evidence bundle. Its numeric opening-receipt
regression was fixed without losing the concurrent source-binding changes.
Neither that failure nor any earlier skip is relabeled by this passing run.

## Shared assets and reproduction

Both actual-model runs reuse the six fitted model/tokenizer files in the
515-file archive committed at producer
`5eeddef47caeb8300094211a9b4cb6020c60ab70`. Their exact archive member paths,
lengths, SHA-256 hashes, parent inventory Git blob and archive SHA-256 are in
`metadata/shared-dependencies.json`. Every member was independently verified.
The model SHA-256 is
`65c6dc55068bcb103180ed2f38c3115bb15d3740cd7416d864d58c7c5910c3a9`.
These are historical 32-step fitted weights, not a new ordinary-training result.

Restore those assets and this bundle. Use clean checkouts at the exact published
pair, install the producer's hash-locked native consumer dependencies, and run:

```sh
node tools/qualify-v8-closed-sessions.mjs \
  --megatoken /absolute/path/to/consumer-1ddcc61 \
  --python /absolute/path/to/venv/bin/python \
  --served /absolute/path/to/restored-fitted-bundle \
  --source /absolute/path/to/this-bundle/published-dc7595e-1ddcc61/original-source.json \
  --request /absolute/path/to/this-bundle/published-dc7595e-1ddcc61/selection-request.json \
  --out /absolute/path/to/new-output \
  --seed 17 --max-tokens 18 --max-fragments 1
```

The tool records exact imports and runtime versions, refuses dirty checkouts or
an existing output directory, and obtains source correspondence only after
actual output selection/validation/acknowledgement.

## Verify or restore this archive

```sh
python3 tools/restore-retained-evidence.py --inventory docs/evidence/semantic-v8-closed-session-dc7595e-1ddcc61/inventory.json
python3 tools/restore-retained-evidence.py --inventory docs/evidence/semantic-v8-closed-session-dc7595e-1ddcc61/inventory.json --out /absolute/path/to/new-directory
```

Every compressed part, complete archive, member path and file hash is checked.
Archive members are file counts, not independent tests or accepted model records.
