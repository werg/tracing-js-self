# Modified Promise lookup review on the frozen qualified pair

This read-only review ran against unchanged producer
`90756c533ee04afc2a41d8890d979e94456f9243` (local equivalent
`a9a2df84d81da5106a4c39258f46324e1c2b04e9`, tree
`1652a93ff2e99d02a962d95f0c856317c02bb2fe`) and native
`03a9e33866207b5b0c4105297c6050dacadcf85f`. Both source trees were clean before
and after the probe. It is additional review evidence, separate from the
104-native/119-producer hosted qualification.

**The direct compiler has a reproduced limitation.** Four modified-Promise
accessor programs are accepted by `compileProtocolSourceV8` as a guest
`TypeError`, while unmodified Node returns `gt2`. The cases use a literal
property key, a computed binding, a computed expression, and an alias of the
Promise object. The returned artifact records an interpreter profile limit as
if it were a JavaScript guest outcome. A new isolated source correction is
required before claiming that direct compiler boundary is sound for them.

**The complete source admission path already refuses all four.** Independent
metadata observation rejects the modified Promise own state, so
`verifyProtocolRegionTrainingCase` returns no exported artifact. The review
does not demonstrate a successful end-to-end data or native admission bypass.
It keeps direct compilation and independent source admission distinct.

The corrected probe contains 19 programs:

- 16 actual Promise mutation cases: all 16 refused by full source admission.
  Four of those 16 expose the direct compiler limitation above. Other cases
  cover literal/computed writes, aliasing `Object` or `defineProperty`, method
  destructuring, `Object.assign`, `Reflect.set`, `defineProperties`, prototype
  mutation and a `Promise.resolve` alias.
- Three valid controls: an ordinary async owned-Promise return, an unrelated
  ordinary-object write, and an ordinary object passed through a parameter
  named `Promise`. Each matched independently executed Node, passed source
  recheck, and replayed all its contexts with the actual pinned native consumer.

The first probe incorrectly categorized the legitimate shadowed ordinary-object
parameter as requiring refusal. That run exited 1 even though it matched Node
and native replay. Its exact source, raw log and JSON remain under
`promise-then-lookup-initial-shadow-expectation.*`. The corrected probe changed
only that expectation, reran the same 19 programs, and exited 0. It does not
claim the direct compiler issue was fixed. Product sources are unchanged.

The literal accessor was read from the published external async-return
candidate `7fe5a9d57fbf456f0165534f089116b4b5db7279`, in
`test/semantic-async-call-source-v8.test.js`. Computed and alias variants here
are explicitly derived from that published case. The separate external
computed-key regression's exact unpublished program was unavailable, so these
are not represented as that exact program or as qualification of the external
candidate. Every probe source and its SHA-256 are in the retained JSON.

Run the retained `.mjs` probe from the original workspace with the recorded
checkouts. Its imports and Python path deliberately preserve the exact original
execution locations. The script executes each source in a fresh Node process,
compiles the owned archive, invokes the complete independent source admission,
and calls native `validate_v8_artifact` plus whole-state roundtrip replay for
each exported positive. Refused sources produce no artifact to send to native.
`manifest.json` records every retained file hash.

## Read-only composition inventory

The three retained composition maps record exact old/new Git blobs; they are
not a combined test result.

- Producer Promise candidate: 59 of 60 paths match their baseline in current
  main `69ff5edd`, combined service/terminal source `a3bbbd31`, and committed
  release source `ade3618e`. The sole divergence is the paired native policy,
  which must name the finally composed native source and contract. All 27
  Promise implementation/test/payload paths have no conflicting changes in
  those compared targets.
- Native Promise candidate: all 14 paths match their baseline in native main
  `622c37c2`, unified recovery `15844c00`, input relocation `b85a3301`, and
  verifier baseline `7741c003`. Applying only these paths preserves the
  recovery guard. The normalized guard must come from the unified recovery
  source, not from an older relocation/verifier branch tree.
- Causal bootstrap `e5` versus combined producer `a3`: 12 of its 22 mapped
  paths are identical. Ten differ through terminal/service additions, fixture
  changes or the paired policy. The exact bootstrap builder and receipt
  validator remain identical; the shared transport retains its
  `publicationAttempted` fence. Those overlapping terminal paths must be
  composed from the current combined candidate, not overwritten by `e5`.

The target verifier's separately reported strict JSON/read-only correction was
still in progress at this inventory. No release assets or main branch were
changed by this review.
