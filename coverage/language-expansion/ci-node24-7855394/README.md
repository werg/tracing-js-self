# Complete updated Node 24 producer CI

The complete Node 24 job passed on the updated producer implementation:
**1,836 passing tests, zero failures or cancellations, and eight explicit
skips out of 1,844 tests**. The subsequent typed algorithm contract, expanded
v8 source/contract recheck, canonical semantic fixtures, demo generation and
demo replay steps also passed. This is the
[original GitHub Actions job](https://github.com/werg/tracing-js-self/actions/runs/44787055093/job/136464735150)
from workflow run `44787055093` and job `136464735150`.

## Tested identities

| Identity | Value |
| --- | --- |
| PR | `werg/tracing-js-self#46` |
| PR head | `785539497a7e9cc2c39e0b789814c49ab1e501e8` |
| Actual checkout, GitHub PR merge commit | `e461fab55d58db727bf488993ac1585b88c0ed24` |
| Merge base parent | `9fcfc5b753ee880e37e22403f673c1aa77218768` |
| Complete tree, identical for PR head and tested merge | `96a368e5166976ff9743d42fbe0f6fc7af0bd0a7` |
| Runtime | Node `24.22.3`, npm `11.19.1` |
| Full `npm test` duration | `374765.573046` milliseconds |

The checked-out merge commit is distinct from the PR head. Both commits were
fetched and their **entire Git trees compared equal**, in addition to comparing
the source, binary entry points, tests, fixtures, tools, contracts, workflows
and package files individually. [receipt.json](receipt.json) retains those
identities, original counts, exact skipped test names, contract results and
successful job steps. Its source tree is also identical to qualification
producer `012c9fe49a082319bf98ac0c571596da925741a4`.

The tested head includes both corrected test increments:

- `c0524b444e8ab8db2a3c1d6b06e5f64327bf77ca`: request-deadline tests isolate the
  intended stalled operation from process startup and source preparation.
- `fb1b672e8e4022deb21858f3e347e24389e25794`: the interoperability inventory
  freezes 26 cases and explicitly retains the three newly added fixtures.

Their ancestry was checked before retaining this receipt. The v8 contract
check passed with digest
`344f7e99aeed605a1965c70f0e0d8829707d6891437ba43dd743fa304cd777dc` and
interoperability digest
`ef962002482fbf7adb6698fc435535dfa202b12848907a29ee0e5fbb5683a7c7`,
rechecking six mixed fixtures and all twenty protocol source cases.

## The eight skips remain explicit

| Skipped test | Reason recorded by the job |
| --- | --- |
| OS confinement survives direct access to Node filesystem, networking and process APIs | Unprivileged namespaces unavailable; `unshare` could not write `/proc/self/uid_map`. |
| isolated original and instrumented references pass the source gate and bind the executed policy | The same unprivileged-namespace restriction. |
| actual pinned ByteCodec reproduces the frozen gallery and meters exact v7/context bytes | Exact external consumer/tokenizer paths were not supplied. |
| native compact coordinator runs async, callback and throwing children in one process with exact whole-task receipts | Optional native runtime environment/assets were not supplied. |
| native bounded context resumes the exact captured cell despite compact callback history | Optional native runtime environment/assets were not supplied. |
| native coordinator budget cancellation leaves no selected guest, effect, or live track | Optional native runtime environment/assets were not supplied. |
| native rejected semantic child preserves its committed bytes and cancels its waiting parent | Optional native runtime environment/assets were not supplied. |
| actual initialized-weight native coordinator preserves rejected bytes and token costs with no fixture fallback | Optional native runtime environment/assets were not supplied. |

These skips are not counted as passes. The five coordinator cases require
`MEGATOKEN_ORCHESTRATION_SERVED`, `MEGATOKEN_PYTHON` and
`MEGATOKEN_REPOSITORY`. Dedicated paired native gates and their exact external
assets are documented separately. The two namespace skips explain why this
hosted job has eight skips where a local environment may report six.

## Retained evidence and verification

| File | Contents |
| --- | --- |
| [node24.log.gz](node24.log.gz) | Losslessly compressed complete decoded UTF-8 job log, including checkout identity, test names/results and later contract/demo steps |
| [source-metadata.json](source-metadata.json) | Original connector run/job metadata and retrieval identity |
| [receipt.json](receipt.json) | Parsed counts and skips, exact commit/tree identities, job steps and expanded contract results |
| [verify.py](verify.py) | Read-only file/hash/log validation, with optional Git-object comparison |
| [SHA256SUMS](SHA256SUMS) | SHA-256 for every retained file above and this README |

```sh
python coverage/language-expansion/ci-node24-7855394/verify.py
```

To repeat the Git comparison, fetch the two recorded commits into a checkout
and add `--repository /path/to/tracing-js-self`. The verifier does not fetch or
modify repository state. The decompressed log contains 267,599 UTF-8 bytes with
SHA-256 `c3b51275ffb57b0cb10fa9e3776dfa972009de4be2cdc996e575c46d53480ed7`.

This receipt covers one complete Node 24 job. The Node 20/22 matrix and native
Python matrix have their own results. A superseded run cancelled by a newer
push is not counted as a test failure. Later evidence-only commits do not
change this run's recorded identity; compare their relevant trees and consult
the live final-head checks separately.
