# References, objects and collection semantics — issue #51

Current completed scope and receipts are in **Checkpoint 6** below. Earlier
checkpoint descriptions apply only to their recorded revisions.

Working implementation record for <https://github.com/werg/tracing-js-self/issues/51>.
The paired consumer is <https://github.com/werg/megatoken>. This document records
what is actually implemented and checked; the umbrella issue remains open until
its broader construction, Proxy, collection and interaction work is complete.

## Starting point

- Producer main: `f7696e63258913e7bb8a450c67a708b70c3232ee`.
- Consumer main: `b432f97` (the merged Promise-object follow-up).
- Working branch in both repositories: `codex/issue-51-object-semantics`.
- No open PR existed in either repository when this work began.
- Current Promise reflection support is already present. Extend the same runtime,
  source projection, public trace and independent native checker in place.
- Learned execution and model training are deferred by the current direction in
  issue #48; ordinary source/native checks and data preparation remain in scope.

## Implementation checklist

- [x] Carry ordinary inherited property existence through a shared `property.has`
  operation, including symbols, accessors without getter invocation, prototype
  traversal, absent versus undefined values, and authenticated source operands.
- [x] Extend owned `Reflect.has` and check target validation/key conversion order.
- [x] Support deletion and addition during ordinary `for…in`: retain the captured
  candidate sequence, skip deleted candidates, preserve inherited fallback, and
  never repeat a completed cursor. Keep unsupported prototype/enumerability
  mutations explicit rather than claiming a native result without evidence.
- [x] Mirror these transitions in the independent consumer, with forged result,
  receiver, key and restored-state refusal tests.
- [x] Exercise original-source/native agreement, replay, interrupted restoration,
  and affected ordinary preparation/contract paths across both repositories.
- [x] Regenerate current affected contracts/data and record exact test receipts.
- [x] Document remaining method/interaction gaps and continuation commands in
  both PRs, without describing partial umbrella coverage as completion.

## Recovery and coordination

Commit completed increments and push them promptly. The PR descriptions and
checkpoint comments are the durable work log; this file records implementation
decisions that need to survive a session interruption. Do not overwrite another
working tree or reset uncommitted changes from another contributor.

The producer runtime and its structural validator, the public semantic/source
path, and the native consumer must agree. Tests must independently execute
original source and must not accept unsupported execution as a guest exception.

Initial useful commands (run from the producer):

```sh
npm ci --ignore-scripts --no-audit --no-fund
node --test test/training-for-in.test.js test/semantic-protocol-enumeration-v8.test.js
node --experimental-vm-modules --test test/semantic-protocol-enumeration-source-v8.test.js
npm run contracts:check
```

All results below must be attributed to their actual code and inputs. Starting
point observations above are not verification of later changes.

## Checkpoint 1 — shared existence and live enumeration

Producer PR: <https://github.com/werg/tracing-js-self/pull/64>.
Consumer PR: <https://github.com/werg/megatoken/pull/46>.

The public machine now derives `property.has` from the same descriptor/prototype
lookup used by ordinary access, without invoking a getter. Known intrinsic
existence does not need a fabricated callable value. Unknown symbols, receiver
identities, false outcomes and uninitialized Promise prototype claims refuse.
Enumeration reuses that operation while retaining its original candidate order.
This matters when deleting an own `toString`: the inherited Object.prototype
property still keeps that captured name present, even though it is not enumerable.

The direct public-machine test file `test/semantic-protocol-enumeration-v8.test.js`
passes 9 tests, covering order/shadowing, existence, mutation, sticky exhaustion,
restoration and malformed state. Native PR #46 has separately executed 66 focused
tests; these counts describe separate checks and must not be summed as unique
language coverage.

Work still in progress at this checkpoint:

- Owned delete syntax, `Reflect.has`, and `Reflect.deleteProperty`, including
  configurable descriptors, property-key conversion and validation.
- Original-source cases and their exact native observation audits.
- Complete fixture/interoperability regeneration. The contract definition has
  been bootstrapped for the new record; this intermediate definition alone is
  not a passing `contracts:check` or native admission receipt.
- Actual-tokenizer ordinary preparation on clean paired revisions.

## Checkpoint 2 — original-source coverage and shared runtime

The owned runtime now lowers member deletion, handles ordinary `Reflect.has`
and `Reflect.deleteProperty`, and resumes an object-valued `in` key through the
existing property-key continuation after validating the right operand. For-in
rechecks captured candidates against live ordinary storage. Promise composition
uses the same public existence/deletion/enumeration operations.

The complete source selection is `fixtures/semantic-regions/objects-issue51.js`:
18 intended supported originals and 3 explicit refusal controls. Every selected
member belongs to the shared `issue51-original-objects` ancestor before splitting.
`node tools/export-issue51-evidence.mjs` exports original inputs, a full registry,
per-member dispositions, and method counts. The current working-tree run passed
all 18 originals and retained all 3 refusals (zero unexpected failures). Its
operation counts are 24 `property.has`, 16 `property.delete`, 7 enumeration
creations, 22 enumeration advances, and 5 conversion records. These are event
counts from this cohort, not percentages of JavaScript support.

The issue-specific source test file passes 10 tests, including an altered
allocated receiver whose existence result remains true but whose original
source claim is false. The affected runtime/public regression command passes
77 tests across owned key conversion, calls, Proxy behavior, Promise objects,
derived construction, super properties and for-in. Source observations still
explicitly refuse the invalid-`in`-RHS intrinsic error object even though the
owned/native executions agree on TypeError before the key hook runs.

Before this checkpoint is review-ready: finish the deletion validator audit
for null/undefined keys, Reflect argument counts/primitive targets and lazy
function descriptors; regenerate the full canonical artifacts; synchronize the
consumer; run clean paired admission and actual-tokenizer preparation. Proxy
`has` and `deleteProperty` traps remain outside this increment.

## Checkpoint 3 — deletion audit and cross-feature keys

Deletion now records its pre-delete descriptor and origin before mutation. Its
independent validator checks actual stack operands, omitted/extra Reflect
arguments and aliases, null/undefined keys, no-op state preservation, strict
versus non-strict behavior, and the exact newly allocated TypeError identity.
A primitive Reflect target throws before an object key can run its hook. An
unmaterialized function name/length/prototype remains an explicit refusal;
deleting an absent ordinary function property no longer creates lazy metadata.
Existing immutable module-namespace Reflect deletion remains checked.

The audit also exposed owned NUL-prefixed key escaping in deletion and `in`
validation, and an internal Symbol storage key leaking into the Promise source
projection as a string. The public projection now uses the shared property
records for Symbol/escaped keys and a proper definition for literal properties.
This allows object-key conversion with a Promise receiver and preserves the
distinction between a Symbol and a lookalike guest string. Both counterexamples
are retained as additional original positives: the final selection now contains
20 intended supported originals and 3 explicit refusal controls. The earlier
21-member results above remain historical checkpoints, not relabeled counts.

The immediate direct runtime/public selection passes 22 tests. Full canonical
source regeneration, a final affected regression run, contract checks and clean
paired native preparation are the remaining gates at this checkpoint. Host
interoperability regeneration passed all 4 examples without byte changes.

## Remaining operations and combinations

- `in` and computed deletion use the retained ordinary object-key conversion.
  Direct Reflect calls now retain object-valued keys with ordinary receivers.
  Aliased calls have owned-runtime support but still need explicit public
  builtin callable identity; spread calls and unsupported exotic receivers
  remain outside this source profile. Invalid targets throw before key hooks.
- Owned TypeError outcomes and their identities are checked, but the invalid
  `in`-RHS source control still refuses the intrinsic error-object projection.
  That refusal is retained in the source population; it is not an admitted
  public guest-exception example.
- Proxy `has` and `deleteProperty` traps/invariants, Proxy enumeration, and
  ordinary enumeration after captured prototype replacement or a surviving
  descriptor's enumerability change remain explicit boundaries. An implicit
  intrinsic prototype with enumerable keys must be represented explicitly at
  enumeration creation.
- Deleting lazy function name/length/prototype metadata requires represented
  owned storage. This increment does not establish complete construction,
  private-brand, builtin/exotic-inheritance, Map/Set, nested destructuring or
  abrupt iterable-cleanup coverage. Existing affected behaviors are regression
  checked; broader work remains under the issue #51 umbrella and its linked
  iteration/source-runner work.

The final affected regression selection passed **127 tests with zero failures
or skips**. After review, the forged allocated-receiver test was tightened: its
canonical line is decoded successfully, the alternate receiver is proven to
accept the same true result in the public machine, and fresh original-source
rechecking still rejects the changed claim. Its earlier version also had a
duplicated protocol prefix, so that earlier negative test did not isolate source
correspondence. The corrected targeted test passes. A separate 11-test owned
run includes both Reflect target checks with a `Symbol.toPrimitive` hook and
confirms that the hook never runs for a primitive target.

## Checkpoint 4 — clean cross-repository gate and retained Reflect calls

The baseline producer `c3e1a55f19eb04fc17957dd8fdea01031ca35ecd` passed
`npm run contracts:check` on Node v24.22.3: 71 source-qualified protocol
examples, 4 mixed host/protocol examples and 6 region examples. Clean source
export reproduced all 20 supported originals and 3 explicit refusals without
unexpected failures. The consumer synchronized the byte-identical contract in
`c3df6a32436233f714b365c3a7b2f3e5ce967b5c`, passed 68 focused native tests,
and retained the complete original cohort with 25 independent replay,
context, continuation and forgery/restoration tests in `4c8ee314`.

Ordinary preparation on those exact clean revisions admitted 20/20 originals
with zero preparation refusals, 8192 positions, 1024 history, zero optimizer
steps and no learning claim. The frozen registry includes the three refused
source identities. Receipt:

- Contract: `9e5946f6745460ad45698eed882641cbc8bb171feb58a98ee53b60984ba23658`.
- Fixture: `56f7f36d3b25b3b11a208be3de337e637b9782e6759faea1e1ec107b0a90f0ce`.
- Interoperability: `813034bfdedd09a779cc6f45109099fe8231621baac8b770f23379329fbd9218`.
- Registry: `e24d9baecb211cf77479b5d81daab0a775936dd6dc6a05c365bc41d8570b22f6`.
- Manifest fingerprint: `5d279e992f64ecd1ab2b3e1089d7356670614c0b7af2afe5c06ee0769d1fc5ec`.
- Pinned Ling tokenizer SHA256:
  `40fb9d7d7795b8bd305aeff39ce9963f3f450915b9553f2938e009be9a1fed60`;
  codec identity `7f52faca2fe82273a889023defd2f1a6fd6080a21096ec77e97f4798a0a370b2`.

Producer `5fea23aa` extends the existing retained PropertyKey continuation to
the actual selected Reflect.has or Reflect.deleteProperty call with ordinary
target and non-spread argument list. The original stack, including evaluated
target, extra arguments and key, is retained across the getter/callback. Target
validation precedes conversion, and a thrown hook preserves guest identity and
partial effects. The structural validator checks the selected call independently.
All 13 focused owned runtime tests passed.

Producer `152b8f50` extends the independent native conversion observer to
direct syntactic Reflect.has/deleteProperty calls. It resolves the real method
before arguments, compares its identity against the captured realm builtin,
and only observes object-key conversion for valid object targets. Shadowed
Reflect calls receive the original key unchanged. The observer verifies the
owned source anchor, selected callee and exact original stack key, and uses
the guest realm's actual ToPropertyKey behavior. All 22 conversion-observation
tests passed, including abrupt completion, symbol identity, shadowing,
invalid targets and stale computed-deletion expectation correction.

Direct source projection reuses the existing conversion/property records,
including Promise targets with string keys. Aliased Reflect methods are
supported at the owned runtime boundary, but currently fail closed in source
projection because builtin callable identity is not represented. Spread calls,
Proxy/exotic target traps and Promise/Symbol composition requiring additional
allocation ownership are not promoted by this work. These are continuation
targets, not successful admitted exceptions. The broader #51 umbrella remains
open.

Reproduction commands: see `docs/issue51-object-semantics.md` in megatoken for
the exact clean paired preparation invocation. Producer commands:

```sh
node --experimental-vm-modules --test test/owned-issue51-runtime.test.js test/owned-property-key-conversion.test.js test/semantic-primitive-conversion-observations-v8.test.js test/semantic-issue51-source-v8.test.js
node tools/generate-protocol-source-fixtures.mjs
node tools/generate-semantic-region-contract.mjs
npm run contracts:check
node tools/export-issue51-evidence.mjs --out /tmp/issue51-cohort.json
```

Do not reuse an older preparation manifest as a receipt for a later code
revision or a larger source population. Synchronize generated contract bytes
and the full frozen source registry before rechecking ordinary preparation.


## Checkpoint 5 — full expanded baseline verified

The unmodified `npm run contracts:check` passed at producer
`87f92b7bb1c4bca5af5830fa9d178c609ca8e53f` with Node v24.22.3. It independently
rechecked all 74 canonical protocol sources, 6 region examples and 4 host
examples. The expanded interoperability digest is
`809f6b29878f3f8321e082463acb825e76946b2371f5d8e2f5cfc0c91df60f66`.

The complete object cohort now retains 26 declared originals: 23 successful
source exports and 3 explicit refusal controls. Its frozen registry digest is
`342b81dd173f2b713d3f9bd38bfd16d3bbe36ef973ba3d08acde68c979b53daa`.
Consumer `ce04621455a3e06a22714347e49293a854ea77e1` passed all 31 cohort tests,
including independent replay/context/continuation checks and atomic rejection
of forged Reflect conversion results, Promise receivers and restored cursors.

Ordinary preparation on these exact clean revisions admitted all 23 supported
originals with zero preparation refusals, using the pinned Ling tokenizer,
8192 positions and 1024 history. The manifest fingerprint is
`e5d21b943228999bd39b9882a64c53e261e03037227b0288893d3b075bbe8664`.
The operation performs zero optimizer steps and makes no learning claim.
The three source refusal identities remain in the declared registry.

Evidence: `docs/evidence/issue51-20261124/reflect-contracts.log` and
`docs/evidence/issue51-20261124/reflect-preparation.json`. These receipts describe
the exact revisions above; later Proxy, error and construction work must receive
its own regenerated contract, original-source and consumer evidence.

The next implementation work is prioritized by semantic uncertainty: retained
Proxy traps with late invariant checks, genuine intrinsic-error identity and
partial effects, and constructor arrows retaining live `this`/`new.target`.
The issue remains open; this checkpoint is not complete #51 language coverage.


## Checkpoint 6 — Proxy faults, constructor captures and shared object state

The completed paired implementation is producer `6b0d8f5bd18de39c85046babed02b4afba0578fd` and
consumer `13ce89795a4625c0e124171f61a0e8bbd45d88e1`. The full unmodified `npm run contracts:check`
passed after regenerating all affected fixtures. It independently rechecked
**93 canonical protocol sources, 6 region examples and 4 host sources**. All
74 prior canonical source inputs retain their exact source, entry, arguments,
family and ancestry. Their generated operation counts are unchanged.

### Behavior established

- Source-qualified `in` and `delete` expressions use Proxy `has` and
  `deleteProperty` traps while retaining the selected synchronous function, its
  arguments and effective receiver even if the handler changes during the call.
  Results use Boolean normalization. Target descriptors and extensibility are
  checked after the trap returns, including traps that freeze a property,
  prevent extensions or delete the property first. Strict false deletion and
  invariant failures create distinct operation-derived TypeErrors. The source
  adapter authenticates the caller's strictness, the retained return token,
  fresh allocation, source origin and derived message. A guest throw retains
  its own identity. Frozen `get`/`set` invariants also agree between the public
  JS and independent Python machines; this is not a broader source-qualified
  frozen-get/set diagnostic claim.
- Derived-constructor arrows captured before `super()` retain the live receiver
  cell and actual `new.target` when invoked after initialization. Private access
  continues to operate on that initialized original instance. They keep this
  receiver when the constructor returns a substitute object. This also works when the arrow later serves as a Proxy
  `has` trap or a primitive-conversion callback.
- Invalid `in` derives a TypeError before attempting property-key conversion,
  preserving earlier operand effects and caught error identity/name. The former
  refusal control is now accepted without changing its source or identity.
  Intrinsic Error brands are paired with retained allocation records; ordinary
  writes to own `name` and `message` remain possible. Restoration verifies the
  allocation registry and active call's callee, receiver and captured aliases.
- Promise property operations retain fresh Symbol identities, registered Symbol
  aliases and Symbols returned by captured helper functions. Matching Symbol
  descriptions do not merge distinct identities.

### Evidence and preparation

The complete frozen issue cohort contains **48 declared originals: 42 supported
and 6 explicit refusals**, with zero unexpected export failures. All 26 original
cohort inputs retain their source, entry, arguments, family and ancestry. The
registry includes every supported and refused member under
`issue51-original-objects`.

| Verification | Result |
| --- | --- |
| Producer integration tests | 120 passed |
| Independent Python regression and recovery tests | 323 passed |
| Whole-cohort replay, context, continuation and forgery tests | 55 passed |
| Actual pinned-tokenizer preparation | 42 attempted, 42 admitted, 0 refusals |

The generator-close, enumeration and controlled host-recovery archives were
also regenerated from the clean producer. The first two have source checks;
the controlled host-recovery scenario proves one dispatch and recovery without
redispatch, and is not promoted to source-qualified evidence.

Ordinary preparation ran on the exact clean revisions above with the pinned
Ling tokenizer, 8192 positions and 1024 history. It performs **zero optimizer
steps** and makes no learning claim. The six refused source identities remain
in the registry but have no artifact in the preparation input stream.

- Core contract: `39a27911db67db3d1848a503a4d743f3c1cc9b699b6d2404d363dc37ce8d0a9d`.
- Fixture: `56f7f36d3b25b3b11a208be3de337e637b9782e6759faea1e1ec107b0a90f0ce`.
- Interoperability: `62e5f6862fc1498a3b56b823b5d7f5a6573a09bb0831075786d0ea92226a22f7`.
- Frozen registry: `04f60979f58d56b3949fca79f0b9ebd7f4da6f5b7a10f241d84b08ecba814e3e`.
- Preparation manifest: `3b6bd2bae822c1b417f6ca3f0de8c8dbeabc42e7fca3fa362f3b9953177987ef`.
- Tokenizer SHA256: `40fb9d7d7795b8bd305aeff39ce9963f3f450915b9553f2938e009be9a1fed60`.

The durable receipt is
`docs/evidence/issue51-20261124/objects-verification.json`, with the full standard
contract, producer, native and cohort test outputs alongside it. The separate
`objects-preparation.json` records the exact clean-revision preparation result.
These receipts supersede Checkpoint 5 for current scope; older receipts remain
historical evidence for their own revisions.

### Reproduction

```sh
# Producer at 6b0d8f5bd18de39c85046babed02b4afba0578fd, Node v24.22.3.
npm run contracts:check
node tools/export-issue51-evidence.mjs --out /tmp/issue51-objects.json
# Consumer at 13ce89795a4625c0e124171f61a0e8bbd45d88e1; extract non-null artifacts as JSONL.
python - /tmp/issue51-objects.json /tmp/issue51-artifacts.jsonl <<'PY'
import json, sys
with open(sys.argv[2], "w") as output:
    for row in json.load(open(sys.argv[1]))["cases"]:
        if row["artifact"] is not None:
            print(json.dumps(row["artifact"]), file=output)
PY
PYTHONPATH=src python -m pytest -q tests/test_issue51_object_source_v8.py
PYTHONPATH=src python scripts/prepare_semantic_v8.py \
  --input /tmp/issue51-artifacts.jsonl --output /tmp/issue51-prepared \
  --producer-root /path/to/tracing-js-self \
  --producer-revision 6b0d8f5bd18de39c85046babed02b4afba0578fd \
  --consumer-revision 13ce89795a4625c0e124171f61a0e8bbd45d88e1 \
  --tokenizer-json /path/to/pinned/tokenizer.json \
  --source-recheck-timeout-seconds 90
```

### Explicit remaining boundaries

Reading the initial invalid-`in` error `message`, Error descriptor/prototype/
`instanceof` operations, and invocation of a derived arrow while `this` is
uninitialized are not source-qualified here. The invalid-`in` thrown outcome,
TypeError identity and name are admitted. Constructor arrows in scheduled
jobs or unauthenticated adoption continuations are refused. Proxy revocation,
nested targets or handlers, trap getters, callable targets, strict false-set
caller errors, Proxy enumeration and other trap families remain outside this
bounded profile. Captured prototype replacement and enumerability mutation,
broader collections, destructuring and abrupt iterator cleanup remain issue51
work. The standard contract gate and paired native evidence are complete for
this checkpoint; this is not a claim that the separate full combined CI gate
or the entire issue51 language scope is complete. Neither paired draft is merged.
