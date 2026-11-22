# Owned Promise mutation profile: exact hosted follow-up

The mandatory paired gate passed at producer
`83194bc2b947fdd7ace630b0854c6e94f4d8211d` (tree
`be2f7db7181932d604c5f3705c289e7943c9df33`) and native consumer
`03a9e33866207b5b0c4105297c6050dacadcf85f` (tree
`0531e702beb88c5421907d6c41d078169ccd00b5`). The producer implementation is
identical to the four-path source increment
`b31d3de5e4a30260d98c0a619efb3c62fe343523`; the 831 successor adds local
evidence and the exact-pair workflow. This archive does not qualify a later
composition of either repository.

- Run: [45041480241](https://github.com/werg/tracing-js-self/actions/runs/45041480241).
- Job: `137266680799`; conclusion `success`; completed 2026-11-22 at 16:07 UTC.
- Artifact: `14761493213`, `owned-promise-lookup-profile-exact-pair`, 362,867 bytes.
- Original ZIP SHA-256:
  `d0aef9ebc6b03a541d1c8847b9575278c902bb12ea387659b3cfdcf7d24e773e`.
- Native: **104 passed, zero failures, errors or skips**, in 122.70 seconds.
- Producer: **144 passed, zero failures, errors or skips**, in 90.06 seconds.
- The native test names are unchanged from the original 907 hosted gate. All
  original 119 producer test names remain present, with 25 additional distinct
  controls.

The hosted job installed locked dependencies, including pytest 8.4.2, checked
all six interoperability payloads plus the contract, freshly rebuilt the
source contract, required both exact test populations and verified clean
checked-out trees. Both JUnit files, the complete raw job log, all nine
artifact members and the original ZIP are retained here. The counts above
were independently parsed from those downloaded JUnit files.

## Concrete defect and correction

Four independently run original programs return `gt2` in uninstrumented Node:
a literal own `then` accessor, a computed binding, a computed expression and
an alias of the Promise object. Before this correction, the exported direct
`compileProtocolSourceV8` entry returned a guest `TypeError` artifact for those
programs. Complete independent source admission already refused them because
the Promise had modified own state. That existing refusal prevented an
end-to-end source/data/native admission claim; it did not make the lower-level
compiler result correct.

The correction refuses the unsupported operation before either direct
compiler returns an artifact. It inspects the replay-validated before-stack
of the original `call.enter` event: the actual callable must be intrinsic
`Object.defineProperty`, and the evaluated target must be an owned Promise.
It also expands evaluated spread arguments. This avoids dependence on the
property key's spelling, the variable's name or a failed call's empty operand
list. The refusal has category `unsupported.promise-source-mutation` and
explains that a declared Promise mutation source profile is required.

The literal accessor program was taken from a published external fixture;
the computed and alias variants were derived independently. The exact
unpublished external regression program was unavailable. These results do
not establish the behavior of that separate candidate or its contract.

## What the additional controls establish

The 25 additional leaf controls cover **24 original programs** plus their
eligible actual-native replay aggregate:

| Population | Count | Result |
| --- | ---: | --- |
| Unsupported mutation programs | 19 | Direct and complete source refusal; no exported artifact is sent to native |
| Eligible programs | 5 | Uninstrumented Node, direct compilation and independent source admission agree |
| Actual native positive replays | 5 | All 96 generated contexts and final shared state match under JSON roundtrip replay |

The eligible controls include the normal owned-Promise return, an unrelated
ordinary-object write, a shadowed ordinary-object `Promise.resolve`
parameter, a shadowed `Object.defineProperty` method and the existing
synchronous ordinary-object descriptor profile. They demonstrate that the
guard follows the actual resolved callable and target rather than rejecting
legitimate shadowed names. Unsupported assignment, computed keys, aliases,
descriptor operations, spread arguments, caught descriptor errors, prototype
changes and non-`then` own Promise state remain bounded refusals.

The earlier original-source Promise packet is unchanged byte-for-byte:
**15 sources, 15 actual native replays, 65 restored cuts and 423 generated
contexts**, SHA-256
`b4f0d99ecdccc50e60361a2c6286a6faf8d421fac8d4d278cd8d1fd3e01a4252`.
The separate public construction still checks two invocation owners and 19
contexts. It is not a retained executor capability source claim. These
populations have different purposes and are not added together.

The contract definition remains
`fd1e64f60ad5b6bb9431db3cd34513a5bd34041cdf7e710a99c5df1205502bf4`;
the interoperability digest remains
`b004c2bde15007278d0c26189560ac0362530585f8b7d49d5b1999525fcce975`.
Native source and the seven shared payloads did not change in this follow-up.
Module admission and training admission remain false; optimizer updates are
zero. Production denominators, packing limits and model deadlines are unchanged.

## Limits and retained corrections

This is an explicit refusal for unsupported Promise mutation. It does not
implement callable thenables, accessor invocation, modified Promise
prototypes, proxies, retained cross-invocation executor resolution or async
reaction callback activation. The original owned-Promise profile limitations
remain in force.

The earlier review initially expected a legitimate shadowed ordinary object
to refuse. Its raw failed expectation and the corrected unchanged-source
19-case review remain in
`../owned-promise-adoption-then-review-20261122/`. The local follow-up initially
used an ordinary-object descriptor control in an already unsupported async
profile; its raw two-failure run is preserved under
`../owned-promise-lookup-profile-local-20261122/`. The corrected control uses
the existing synchronous descriptor profile, and the exact hosted run above
checks the corrected 144-case population. Neither earlier failure is erased
or counted as a product success.

## Exact promotion map and retained bytes

`producer-combined-promotion-map.json` covers all **78 unique paths** from
the Promise source baseline through the qualified follow-up. It records each
baseline, 907, b31 and 831 Git blob, so an integrator can apply each scoped
increment without replacing later recovery, service, terminal, router,
target, release or evidence changes:

| Increment | Changed paths | Scope |
| --- | ---: | --- |
| `90756c5` | 60 | 27 source/test/payload paths, paired policy, investigation workflow and 31 earlier evidence paths |
| `b31d3de` | 4 | Three source guard modifications and one new 25-control test file |
| `83194bc` | 17 | Sixteen local evidence paths and one exact-pair investigation workflow |

The three modified guard paths overlap the earlier source increment, which
is why those increment counts are not summed as unique paths. The baseline
is published `ae5fa0f13fc8e8d8996cb6ff360c209ae2f83fa8`; each local equivalent
revision and exact tree is recorded in the map. The policy must be composed
against the final native revision instead of restoring this older isolated
03a pin. A combined main source tree still requires its own qualification.

`manifest.json` records original and stored hashes for every downloaded file,
the exact checkouts, parsed counts and the four `gt2` source hashes. Large
JSON files, the raw job log and the ZIP use gzip plus base64; decode with
`gzip.decompress(base64.b64decode(bytes))` and verify the original manifest
hash. The frozen feature and qualification branches are unchanged by this
documentation increment.
