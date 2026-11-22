# Direct compiler refusal for unmodeled Promise descriptor mutations

Source increment `b31d3de5e4a30260d98c0a619efb3c62fe343523` fixes the direct
compiler limitation reproduced against the earlier qualified producer `90756c`.
Its local equivalent is `2975668f773f0f3ba68f9f652adfe67dbc1bd880`, tree
`07ca352d9607068cba23fe181cd9b6e8f36a0001`. The native implementation remains
the exact `03a9e33866207b5b0c4105297c6050dacadcf85f` peer.

Four original-source accessor forms previously compiled into an incorrect
guest `TypeError` outcome while unmodified Node returned `gt2`: literal key,
computed binding, computed expression and Promise alias. Complete source
admission already refused them through independent Promise metadata
observation. The correction closes the earlier direct compiler boundary; it
does not claim that a full data/native admission bypass had existed. The exact
frozen probes and their initial mistaken shadow expectation are retained in the
separate `owned-promise-adoption-then-review-20261122` evidence bundle.

## Change and authority

Both protocol compilation and shared source projection now refuse the actually
observed unsupported descriptor operation with
`unsupported.promise-source-mutation`. The guard runs after archive validation
and exact replay. It uses the source call's original instruction and before
stack to bind the resolved intrinsic `Object.defineProperty` and its evaluated
Promise target. It expands already evaluated spread arguments. A failed
intrinsic call can have an empty event operand list, so inspecting only that
list would miss the demonstrated case.

This decision does not depend on source variable names or a syntactic spelling
of `then`. Ordinary objects, shadowed `Promise` parameters, and a shadowed
`Object.defineProperty` method retain their existing supported behavior.
Promise own descriptors, including a non-`then` own property, still require a
separate profile. Catching the interpreter's unsupported mutation does not
turn it into an admissible guest completion. This increment adds no support
for arbitrary thenables or modified Promise lookup.

## Local results

- Complete required producer union: **144 passed, zero failures, errors or
  skips**, with the actual immutable native checkout, in 116.44 seconds.
- New focused cohort: **25 passed, zero skips**. It contains 24 programs plus
  one actual-native replay test: **19 refused source mutations** and **five
  eligible source/native controls, 96 contexts**.
- The four reproduced accessor cases, an evaluated spread, a caught mutation
  and a non-`then` own property require the explicit profile refusal in both
  direct compiler entry points and full source admission.
- The five eligible programs cover ordinary async adoption, an unrelated
  ordinary-object write, a shadowed ordinary-object `Promise.resolve`, a
  shadowed `Object.defineProperty`, and the existing synchronous ordinary
  descriptor profile. Every eligible source is independently rechecked and its
  entire public state/context continuation is replayed by native `03a9`.
- Existing adoption evidence remains **15 original sources, 65 restored cuts
  and 423 contexts**. Its complete JSON is byte-identical to the successful
  hosted `90756c/03a9` packet, SHA-256
  `b4f0d99ecdccc50e60361a2c6286a6faf8d421fac8d4d278cd8d1fd3e01a4252`.
- Contract recheck passed with all 23 canonical source examples. Definition
  digest remains `fd1e64f60ad5b6bb9431db3cd34513a5bd34041cdf7e710a99c5df1205502bf4`;
  interoperability digest remains
  `b004c2bde15007278d0c26189560ac0362530585f8b7d49d5b1999525fcce975`.

The unchanged native eight-file population previously passed 104 hosted cases.
This local run does not relabel that earlier native result as a new native
run. The separate follow-up workflow requires all **104 native and 144
producer** cases against its exact checked-out pair and refuses skips. Its
hosted result is pending at this documentation commit.

## Preserved initial failure

The first new 25-case test run had 23 passes and two failures. One proposed
positive control placed ordinary descriptors inside an async profile that the
unchanged baseline already refuses. Its aggregate native test then observed
four eligible artifacts instead of five. The control was moved to its existing
synchronous descriptor profile; the implementation was not broadened. The
initial test source, raw log, JUnit and partial evidence are preserved here.
The final focused 25-case run and complete 144-case union both passed.

The three additional refusal programs were also checked against unchanged
`90756c`: spread, caught mutation and non-`then` property all already failed
complete independent source admission. That baseline result is retained in
`promise-mutation-added-baseline-refusals.json`.

## Files and scope

`source-map.json` contains all four changed implementation/test paths and their
exact old/new Git blobs relative to `90756c`. The new investigation workflow
and this documentation are separate from those source changes. The earlier
qualified feature branch and its raw hosted evidence remain unchanged.

`manifest.json` records exact file hashes and leaf counts. Compressed `.gz.b64`
files decode with `gzip.decompress(base64.b64decode(bytes))` and must match the
manifest's original SHA-256. This increment changes no public record schema,
canonical fixture bytes, native implementation, packing limit, production
denominator or model deadline. It performs zero optimizer updates and makes no
training or module admission claim.
