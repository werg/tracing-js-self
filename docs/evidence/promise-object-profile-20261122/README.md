# Promise object operations: direct source compilation must refuse unsupported storage

Published source `95907736f46488662bc4f2bb5625abb9459d0f86` closes adjacent
direct-compiler gaps found after the computed-descriptor correction at
`83194bc2b947fdd7ace630b0854c6e94f4d8211d`. The local source commit
`0a8276245743a86e6eeb2d1911fe88f9a63b2183` has the exact same tree
`221cceb4067adb2efe05451546b763be3fff4640`. Native remains the unchanged
`03a9e33866207b5b0c4105297c6050dacadcf85f` peer.

## Reproduced behavior and correction

Direct protocol compilation and shared source compilation accepted unsupported
Promise prototype operations as guest `TypeError` outcomes even though original
Node completed normally. Catching that implementation error could also certify
a catch that never happens in JavaScript. `Object.isExtensible(p)` returned
`false` for a fresh Promise, where original Node returned `true`;
`Object.preventExtensions(p)` silently omitted the mutation. An ordinary
object with a Promise as its new prototype or property descriptor had the same
incorrect guest-error problem.

The unchanged full independent source admission already refused these inputs
through source outcome, operation/completion or metadata comparison. This is a
direct compiler soundness correction, not a demonstrated complete data/native
admission bypass. The raw twelve-program differential probe retains the exact
old results in `promise-prototype-probe.jsonl`. Its script was executed from
`session/promise-prototype-probe.mjs` in the recorded workspace; its original
relative imports are preserved rather than relabeled as a new execution.

The guard binds the actual resolved intrinsic and evaluated arguments from
the validated source CALL's before-stack. It expands already-evaluated spread
operands. It is independent of spelling, computed keys, variable names and
ordinary shadowed methods. A Promise can occupy the prototype or descriptor
argument, so guarding only the first argument is insufficient.

| Exposed intrinsic family | Current boundary |
| --- | --- |
| `Object.defineProperty` | Original Promise-target refusal preserved; Promise descriptor operand also refuses. |
| `Object.create`, `Object.setPrototypeOf`, `Object.getPrototypeOf` | Promise target, prototype or descriptor-map operands refuse before projection. |
| `Object.preventExtensions`, `Object.isExtensible` | Promise object-storage assumptions refuse before projection. |
| `Object.getOwnPropertyDescriptor`, `Object.hasOwn`, keys/values/entries, own-name/symbol enumeration, `Object.assign` | Existing owned execution already refuses unmodeled Promise storage; no new guest result is introduced. |
| `Object.freeze`, `Object.seal`, `Object.isSealed`, supported Reflect storage operations | Existing owned execution already refuses the Promise profile. |
| `Object.is`, `Object.isFrozen` | Identity and the pristine extensible Promise's unfrozen state remain supported; explicit positive controls protect both. |

Unexposed intrinsic methods and arbitrary thenable storage are not newly
supported. The Promise resolution queue, public contract, native implementation
and canonical fixture payloads are unchanged.

## Retained local validation

| Run | Leaf cases | Result |
| --- | ---: | --- |
| Before correction, new focused cohort | 23 | 17 missing-refusal failures, five positive passes, one explicitly unconfigured native skip. |
| Corrected focused cohort | 23 | All passed; zero failures, errors or skips. |
| Complete producer union | 167 | All passed; zero failures, errors or skips; 121.562 seconds. |
| Exact native regression | 104 | All passed; zero failures, errors or skips; 144.48 seconds. |

The new cohort contains **22 original programs**: 17 explicit source refusals
and five independently checked positive programs, with all **51 generated
contexts** replayed and compared by the actual native consumer. The additional
native aggregate case is a test, not another original program. The original
adoption cohort remains 15 programs / 65 serialized cuts / 423 contexts, and the
earlier descriptor cohort remains 24 programs / 19 refusals / five native
positives / 96 contexts. These populations are not added as a novel corpus.

Runtime was Node 24.22.3, Python 3.12.14, locked Torch 2.10.0+cpu and pytest
8.4.2, with one OpenMP and MKL thread. The contract generator rechecked all 23
canonical source examples. Definition and interoperability digests remain
`fd1e64f60ad5b6bb9431db3cd34513a5bd34041cdf7e710a99c5df1205502bf4` and
`b004c2bde15007278d0c26189560ac0362530585f8b7d49d5b1999525fcce975`.
No optimizer update, data admission, module admission or learned-quality claim
is made.

The complete local union launched on `0a827624`; only its separately committed
workflow changed during execution. Alignment to the published identical tree
changed commit metadata only. All tested implementation/test/native blobs
remained fixed. Untracked evidence files and the shared dependency symlink
were present; this is not described as a clean whole-checkout hosted run.

## Hosted qualification and composition

Workflow `132b1d10b4de69d766ebc7969c6d4f0a9ed9b668` requires all 104 native
and 167 producer leaves, zero failures/errors/skips, exact checked-out source,
all seven shared payloads and complete source/context receipts. Its original
run is [45042386283](https://github.com/werg/tracing-js-self/actions/runs/45042386283);
hosted evidence is retained separately on completion.

`producer-composition-map.json` binds the 29 implementation/test/payload paths
against the earlier Promise baseline and records the observed main target.
Recheck every target blob before applying. Update the native policy only for
the final composed native source. `native-composition-map.json` retains the
earlier 14-path native map without changing its historical comparison claims.
Preserve current recovery, release, training and historical evidence paths.

All raw logs, JUnits, compressed full source packets, original differential
observations and exact path maps are covered by `manifest.json`. Decode
`.gz.b64` using base64 then gzip and verify its original and stored hashes.
Final composed-pair qualification, generic queued thenables, cross-invocation
retained resolver ownership, production admission and learned quality remain
separate open gates.
