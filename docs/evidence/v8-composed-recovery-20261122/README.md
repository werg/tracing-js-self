# Combined causal/bootstrap/service terminal recovery — 22 November 2026

## Preserved failed gate

[Run 45038208676](https://github.com/werg/tracing-js-self/actions/runs/45038208676)
completed with failure on producer `a3bbbd313dc3c92e723a746187679b10c85d884a`
and native `15844c00c095849755ca6f0e1d207f7db79a9264`. Independent parsing of
every original JUnit document establishes **165 native passes and 191 of 193
producer leaf cases passing, two failures, zero errors or skips**. This supersedes
the earlier status that the terminal-history lane was still running.

| Population | Cases | Passes | Failures | Errors | Skips |
| --- | ---: | ---: | ---: | ---: | ---: |
| Native recovery, journal, launch and position receipts | 165 | 165 | 0 | 0 | 0 |
| Producer structural | 123 | 123 | 0 | 0 | 0 |
| Producer transport | 33 | 33 | 0 | 0 | 0 |
| Producer commit history | 9 | 9 | 0 | 0 | 0 |
| Producer bootstrap history | 12 | 12 | 0 | 0 | 0 |
| Producer terminal history | 16 | 14 | 2 | 0 | 0 |

`failed-a3bb/` contains all five byte-original artifact ZIPs, every complete job
log losslessly compressed, the original run/job/artifact metadata and the
independently parsed failures. Each ZIP was verified against GitHub's original
size and SHA-256. `SHA256SUMS.json` inventories the retained files. The ZIPs
include original test manifests, exact checkout identities, runtime inventories,
JUnit, and available streamed test logs. No failed artifact was replaced by a
later result.

The hosted runtime was Node 24.22.3, Python 3.12.14, locked Torch 2.10.0+cpu
and pytest 8.4.2. The actual Linux time namespace identity is retained in each
runtime record. Tests use the actual native adapter with controlled final decoder
bytes; this is recovery engineering evidence, with zero optimizer work and no
learned-quality claim.

## Why the two service-owned cases failed

Both cases reached successful close recovery and then asserted an incorrect
definition of zero work. The native adapter deliberately rebuilds and verifies
retained model state by replaying the original selections. Its restore receipt
separates `reexecutedSelections`, `consumedAttempts` and `hostDispatches`. The
producer likewise preserves the original attempts and cumulative costs instead
of resetting them. The existing non-service close-history tests already verify
the exact original decoder-fragment sequence after reconstruction.

The first failed service case incorrectly expected zero cumulative attempts;
six historical attempts were retained. The second incorrectly expected an empty
decoder log; seven original decoder fragments were replayed. These failures do
not by themselves demonstrate new host dispatch. The correction establishes the
stronger complete boundary rather than removing the checks:

- Full restored attempts equal the retained pre-close or previously closed
  checkpoint; the reported attempt count equals that retained population.
- Decoder fragments equal the original nonempty sequence exactly, including
  indices, offsets, lengths, terminal flags and payload hashes.
- Cumulative RPC count equals the retained count plus exactly one recovery RPC
  and one checkpoint RPC; compute and peak-memory costs cannot decrease.
- Each restore performs one close-recovery operation, zero new terminal-close
  operations, zero host dispatches and grants no host-recovery authority.
- All missing/wrong owner, unavailable synchronization/read/verification,
  stale-history and unknown-acknowledgement refusals still require zero native
  recovery calls, zero RPCs, zero attempts and no decoder output.
- The same exact checks apply after repeated process loss and settled
  cancellation; service termination is not repeated.

Only `test/semantic-known-service-close-history-v8.test.js` changed in the
correction. The published corrected producer is
`9b2e5faef467e962f919aa3b6f2baebca71441a9`; its tree equals the locally reviewed
`fc0ad0c11277e3a640afba41b7d5335bf20fb39f` tree. Production code, native source,
model deadlines, fixture outputs, test populations and the five-lane workflow
are unchanged. [Run 45042073863](https://github.com/werg/tracing-js-self/actions/runs/45042073863)
is the separate corrected qualification; its final result is not inferred from
the preceding failed run.

## Composition audit

`failed-a3bb/native-composition-map.json` compares native main `622c37c2` with
candidate `15844c00`, recording every changed source/test blob and SHA-256. There
are six changed files and no removed test functions. The existing predecessor
controls remain, all four raw-bootstrap separator spellings are guarded before
mutation, and full returned-child/RNG validation, fenced duplicates and exact
supersession controls are retained. API names are changed directly to the
causal `durable-bootstrap-child` / `recover-bootstrap-child` pair.

Producer promotion must use its explicit source/test map, preserving later main
evidence and training-archive tooling. A wholesale checkout of the candidate
would delete unrelated later records. A passing candidate does not automatically
qualify an independently composed later tree.

## Local validation limits

Syntax and whitespace checks passed. An attempted broader local structural run
failed because this restricted workspace has no writable `/tmp`; its original
JUnit is retained. A separate run directed at a workspace temporary directory
was interrupted after making no completed report, so its completed population
is unknown. Neither run qualifies service-close recovery. The local environment
also lacks genuine Linux time-namespace authority and the locked native model
runtime; no fabricated clock or substituted authority was used. The required
complete proof remains the hosted 165-native/193-producer gate with zero skips.

## Remaining acceptance

After the corrected exact gate succeeds, compose the source/test maps into both
main PR branches and verify the resulting paired source. Recovery of unknown
external effects, unsettled or failed child work, dynamic descendants, successor
or distributed ownership, and generic remote atomicity remain distinct open
work. This bounded completed-close proof does not authorize them and does not
establish full production cutover or learned execution quality.
