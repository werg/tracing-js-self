# Preserve the two original async-return ordering sources in the canonical composition

The canonical shared Promise implementation already retained distinct public
async-return queue and malformed-state assertions. Its source cohort did not
retain the separate async-only branch's two exact original-source ordering
programs. The existing canonical source FIFO pair exercised executor
resolution; that does not replace original async-return source evidence.

Test commit `09e99f0a86f1c3568dff02db26a1386d695cf76f` preserves both original
programs from producer `7fe5a9d57fbf456f0165534f089116b4b5db7279`, without
adding the alternate async-only record family or changing product code.
Parsing the original and new test files with Acorn and comparing each literal
case array proves the source bytes and expected results are identical.
`original-source-map.json` retains those hashes.

| Original program | Original result | Original source SHA-256 |
| --- | --- | --- |
| Async return of `Promise.resolve(1)` with a competing reaction | `qa` | `45767365322a8f4b54c342817db79ebcedcd386dc9eb80dc7fcfaadb76d5d723` |
| Async return of another execution Promise with earlier direct reactions | `dqa` | `118b708d8a825060e4a3e889be4896ee183c64b5f61a7ab532e35098e0f0ced2` |

All **four local test cases passed with zero failures, errors or skips**. Both
unmodified original programs were independently executed in Node, admitted
through source correspondence, rechecked and replayed. All **nine serialized
continuation cuts** restore the same public state. The actual native consumer
replays all **78 generated contexts** from the two programs and compares both
complete final states.

The binding control requires exactly one common enqueue, assimilation and
forwarding sequence for each original async completion. It binds the original
body, target Promise and both job identities, and rejects accidental use of the
alternate `async.resolve.*` family. The source's expected `qa`/`dqa` ordering
therefore remains tested through the one shared Promise resolution procedure.

Product sources are unchanged from published
`95907736f46488662bc4f2bb5625abb9459d0f86`; native is unchanged
`03a9e33866207b5b0c4105297c6050dacadcf85f`. The exact test bytes were run
before committing and committed unchanged afterward. Runtime was Node
24.22.3, Python 3.12.14, Torch 2.10.0+cpu and pytest 8.4.2. The original
167-producer/104-native hosted guard gate remains unchanged. Including these
four additional checks makes a future combined producer union **171 leaves**;
this focused run is not represented as that future whole union.

The source and context packet, complete raw log, JUnit, original source map
and updated 30-path producer composition map are retained and hashed in
`manifest.json`. Decode `source-evidence.json.gz.b64` with base64 then gzip.
There are zero optimizer updates and no data/module/learned-quality admission.
The original 12-program async-only cohort and canonical 15-program adoption
cohort retain their historical counts; this is a two-program composition proof,
not a new union of their populations.
