# Pinned real-source refusal triage

The original C campaign remains immutable. Its four `canonical_mismatch` and
four `teacher_failed` results were investigated against the pinned upstream
bytes. A fresh diagnostic on producer
`48e28f289a05746d5deb4c243a167d78475a2f13` yielded **five locally verified
cases, two explicitly unsupported cases, and one superseded canonical case**.
This diagnostic supplied no native consumer, did no optimization, and makes no
native-admission or learned-execution claim.

The machine-readable receipt is
[`evidence/real-source-refusal-triage-2026-11-18.json`](evidence/real-source-refusal-triage-2026-11-18.json).
It binds the original C manifest, campaign identity, log head, individual
historical candidate/results, new environment, and compressed fresh results.
The complete result objects are retained in the release bundle's
`real-source-triage-local/objects/` directory. The seven executed rechecks took
18.339 seconds of combined worker wall time and produced 4,268,799 compressed
evidence bytes. These are diagnostic measurements for these inputs, not a
throughput forecast.

## Canonical adapters

| Original case | Historical result | Cause and correction | Fresh disposition |
| --- | --- | --- | --- |
| `grains/9fbde8de-36b2-49de-baf2-cd42d6f28405` | `canonical_mismatch` | The JavaScript proof returns `1n`; neutral JSON represents the mathematical expectation as `1`. A versioned grains-only binding now requires an actual BigInt result equal to the exact pinned decimal lexeme. | Canonical check agrees; owned compilation refuses the unbound `BigInt` global. |
| `grains/ee1f30c2-01d8-4298-b25d-c677331b5e6d` | `canonical_mismatch` | The same exact-type binding applies to `2n`. | Canonical check agrees; owned compilation refuses the unbound `BigInt` global. |
| `knapsack/a4d7d2f0-ad8a-460c-86f3-88ba709d41a7` | `canonical_mismatch` | The pinned neutral input really contains `items: {}`. Case `3993a824-c20e-493d-b3c9-ee8a7753ee59` explicitly reimplements it with `items: []`. Selection now honors active reimplementations and records the retired identity and replacement. | `superseded_canonical_case`; no replay of an obsolete input. |
| `two-fer/1cf3e15a-a3d7-4a87-aeb3-ba1b43bc8dce` | `canonical_mismatch` | The neutral “no name given” case really contains `name: null`. The pinned JavaScript API uses a default parameter, so its declared language binding omits the argument. The neutral input and versioned binding remain in provenance. | `locally_verified`. |

Neither the null nor the object in these canonical inputs was a transport
corruption. The fix does not convert arbitrary objects into arrays, change a
source result to match an expected value, or treat Number and BigInt as
interchangeable. Number and string returns fail the grains binding. Large
expectations use the original JSON integer lexeme: the total
`18446744073709551615` is retained exactly even though ordinary JSON Number
parsing rounds it. Invalid or misrouted bindings fail closed.

Pinned inputs remain at problem-specifications revision
`650bebeb39ad40439175288042aece982b0a90a9`; JavaScript proofs remain at
`ff04f35158cdf61eebfdf18a774010495a1fd6d9`. Their source files and Git-blob
checksums were not edited. The independently implemented canonical
error-completion gate remains intact: language-neutral error prose does not
replace the original/transformed/owned exact JavaScript exception comparison.

## Bounded array semantics

| Original case | Historical cause | Implemented behavior | Fresh disposition |
| --- | --- | --- | --- |
| `knapsack/3993a824-c20e-493d-b3c9-ee8a7753ee59` | `fill` shared an unnecessary dense-element pre-read, rejecting the holes created by `Array(length)`. | `fill` writes the selected slots directly and preserves holes outside the range. | `locally_verified`. |
| `roman-numerals/19828a3a-fbf7-4661-8ddd-cbaeee0e2178` | `forEach` was not a modeled array method. | Dense, bounded synchronous callbacks execute in owned guest frames; the method ignores callback returns and returns `undefined`. | `locally_verified`. |
| `roman-numerals/f088f064-2d35-4476-9a41-f576da3f7b03` | Same `forEach` gap. | Same owned continuation path. | `locally_verified`. |
| `sum-of-multiples/361e4e50-c89b-4f60-95ef-5bc5c595490a` | `some` was not a modeled array method. | Dense, bounded synchronous callbacks stop at the first truthy result and return a Boolean. | `locally_verified`. |

The new callback methods snapshot the initial length, read each visited value
from the current owned heap, preserve callback argument/array identity, and
support nested callbacks. Guest exceptions remove the array continuation before
propagating through catch/finally; this also repairs stale continuation state
for the existing callback methods. Empty arrays do not invoke a callback.

The profile remains bounded: at most 10,000 array elements, synchronous owned
callbacks, no callback `thisArg`, no sparse callback iteration or accessor
slots, and no inherited setter chain for `fill`. Async callbacks are an
explicit profile refusal, not an invented catchable guest error. The existing
refusals for other sparse array operations remain in place. No generic native
callback fallback or general BigInt constructor was added.

## Source provenance and verification

The Exercism bridge now retains maps for provably unchanged original source
spans. Generated wrapper syntax has no guessed upstream coordinate. If the
existing mapper cannot establish a span map, provenance records the explicit
unavailable reason. This is partial source mapping, not a claim that every
generated token has an original position.

Validation completed for the two implementation increments:

- Canonical adapter/provenance suites: **16/16 passed**, including exact large
  integers, wrong-type rejection, supersession, two-fer omission, independent
  original/transformed checks, and the existing canonical exception gate.
- Array callback/mutation/default/string/exotic/descriptor suites: **40/40
  passed**, including V8 result comparison, structural validation, exact replay,
  independent v5 local admission, callback early exit and exceptions, aliases,
  sparse fill, and refusal of unsupported behavior.
- Actual pinned historical cases: all four former teacher failures and the
  two-fer case passed fresh independent local verification. Both grains cases
  retained a precise unsupported reason after passing the canonical gate.

The fresh diagnostic rebuilt candidate inputs and expectations from the pinned
sources and retained each unchanged source's original frozen global component
assignment. It verified the selected historical object hashes and complete
campaign log chain before reading archived fixtures. It wrote each fresh
result and manifest increment durably and checked that the producer revision
and environment did not change during the run.

Reproduce against an archived C campaign from a checkout containing the fixes:

```sh
TZ=UTC node tools/recheck-real-source-refusals.mjs \
  --campaign /path/to/original-C-real-source \
  --out /path/to/new-triage-output
```

Use a new output directory. The tool deliberately does not overwrite or amend
the historical campaign. If the sandbox has no `/tmp`, set `TMPDIR` to an
existing writable workspace directory before running the tests or tool.

A release using these source/runtime changes needs its own frozen producer
identity and fresh pinned native-consumer admission. The historical C native
receipts apply to C; these local rechecks cannot promote themselves into
training-ready records. The remaining general BigInt, sparse-callback,
accessor, async-callback, and inherited-setter support stays outside this
increment's declared profile.
