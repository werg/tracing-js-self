# References, objects and collection semantics — issue #51

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

- [ ] Carry ordinary inherited property existence through a shared `property.has`
  operation, including symbols, accessors without getter invocation, prototype
  traversal, absent versus undefined values, and authenticated source operands.
- [ ] Extend owned `Reflect.has` and check target validation/key conversion order.
- [ ] Support deletion and addition during ordinary `for…in`: retain the captured
  candidate sequence, skip deleted candidates, preserve inherited fallback, and
  never repeat a completed cursor. Keep unsupported prototype/enumerability
  mutations explicit rather than claiming a native result without evidence.
- [ ] Mirror these transitions in the independent consumer, with forged result,
  receiver, key and restored-state refusal tests.
- [ ] Exercise original-source/native agreement, replay, interrupted restoration,
  and affected ordinary preparation/contract paths across both repositories.
- [ ] Regenerate current affected contracts/data and record exact test receipts.
- [ ] Document remaining method/interaction gaps and continuation commands in
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
