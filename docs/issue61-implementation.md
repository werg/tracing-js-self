# Promise object state and original async sources (#61)

This is the implementation record for
[issue #61](https://github.com/werg/tracing-js-self/issues/61). The pull request
description is the current progress tally; this document retains the design and
the evidence locations needed to resume the work.

## Starting revisions and required evidence

- Producer baseline: `3d72b27cf626b87d78eb0b883f54ea9e9c5380e8`.
- Independent consumer baseline: `6eb4fc4b1c10e2f2b576fd04c21d88c24ed3a558`.
- Original Test262 inputs: `2a1ade303f72d3de80565c921d685222405c32ce`.
- Selection: the unchanged 20 paths in
  `artifacts/conformance/test262-current-pr60/selected-paths.txt`, including all
  40 required strict/sloppy variants and the original harness bytes.
- Earlier receipts remain historical. Each new receipt below names the producer
  revision it actually executed; later changes require a fresh campaign.

## Hardest questions first

Promise settlement and ordinary property storage initially followed different
paths. Merely accepting `Object.defineProperty` would leave observable
constructor getters, inherited identity, and Promise job ordering incorrect.
Promise objects now use the same descriptor and prototype operations as ordinary
objects, while retaining their Promise identity and settlement state.

The owned Promise row holds ordinary property fields directly. The public
controller and independent consumer already represent each Promise in their
shared heap; they must check the same property changes there. A second object
identity or a compatibility representation is unnecessary.

Mutable intrinsic prototypes need one identity per realm. A lookup must keep
its original receiver even when a getter is inherited. Constructor lookups at
Promise resolution, await, and reaction creation must preserve synchronous
getter effects, reentry, abrupt completion, and FIFO job behavior.

## Work and acceptance ledger

- [x] Reproduce current-clean first barriers on the exact original inputs.
- [x] Implement shared Promise descriptors, prototype identity and reflection.
- [x] Implement observable constructor lookup and getter/call sequencing.
- [x] Add ordinary and adversarial runtime controls, preserving genuine guest
  errors and explicit implementation refusals.
- [x] Extend original-reference observation for descriptors, shared prototypes,
  accessor receivers and actual Promise assignment storage.
- [ ] Complete source projection integration and all existing source controls.
- [ ] Extend independently implemented native state transitions and rejection
  controls for receivers, descriptors, prototypes, source bindings and order.
- [ ] Regenerate affected contracts and fixtures in place.
- [x] Rerun all 40 original variants at the first runtime checkpoint and retain
  every outcome/new barrier.
- [x] Record the baseline and first-runtime executed revisions, input hashes,
  budgets and commands.
- [ ] Rerun and retain all 40 variants at the final integrated revision, with
  separately recorded source/native results where actually executed.
- [ ] Run the required regression gates and record any unresolved work in the
  main PR description.

## Executed original-input campaigns

The unchanged selection contains 20 files and both required modes for each
file. Each campaign retains 40 parse, 40 owned-execution and 40 independent
Node/V8-reference attempts. Both use the exact full-catalog digest
`67799da9e7d4dd08333fe38a75b7d738d9fd14ffc40a2e17d4d00254781a47de`.

| Executed producer | Parse | Owned execution | Independent Node/V8 reference | Retained evidence |
| --- | --- | --- | --- | --- |
| `3d72b27cf626b87d78eb0b883f54ea9e9c5380e8` | 40 passed | 30 passed, 10 unsupported | 40 passed | `artifacts/conformance/issue61-baseline/` |
| `47cd67bc48921b55135f5cde02c49b06e2ab4bd8` | 40 passed | 40 passed | 40 passed | `artifacts/conformance/issue61-runtime/` |

The baseline diagnoses identify unsupported Promise own-property storage,
`Object.prototype.hasOwnProperty` in the original async harness, and access to
`Promise.prototype`. No diagnostic invented a guest throw or counted a caught
implementation refusal as success. The first runtime rerun exposed no further
barrier within these 40 variants. Its result applies to that runtime checkpoint,
before the later source, observer and native integration changes.

The retained projections were checked against every original file and harness
hash at the pinned Test262 revision. All selected IDs and variant identities are
unchanged; all 103,320 unselected variants remain explicitly `not_selected`.
The existing reconstruction tool recovers each complete report byte for byte,
and resuming each completed campaign retains exactly the original 120 attempts.
The per-campaign `observation.json`, `verification.json` and `reproduce.sh`
record the exact commands, budgets, source identities and reconstruction hashes.
These Node/V8-reference passes do not assert independent native transition
admission; source and native checks retain their own status.

## Evidence boundaries

Owned execution, original reference execution, source correspondence and native
transition checking are distinct results. Each is reported only when executed.
Unsupported behavior must stop outside guest exception handling; it cannot
satisfy a negative test or become a caught-error success. Newly exposed semantic
barriers remain visible instead of changing the harness or dropping a variant.

Training and learned-execution evaluation are outside this issue's acceptance.

## Independent observation lesson: returned Promise boundaries

The source-reference worker's host `await` previously added a `constructor`
lookup to a guest Promise. A shared `Promise.prototype.constructor` getter
therefore ran once more, with the returned root Promise as receiver, than it did
in the owned source execution. This was an observer effect, not an iteration or
Promise-resolution defect. A minimal probe also demonstrated that inspector
`Runtime.awaitPromise` performs the same extra lookup; substituting it would not
repair the evidence boundary.

The worker now drains the actual native microtask queue under its existing
parent deadline and reads V8's `[[PromiseState]]` and `[[PromiseResult]]` through
descriptor-only inspector `Runtime.getProperties`. It transfers the real result
reference into a private host record, preserving aliases and primitive edge
values, without calling guest `then`, `constructor`, species or tag getters and
without modifying source or prototypes. Rejection remains a guest throw; a root
still pending at quiescence is an explicit resource limit. Unrelated unhandled
rejections remain failures. No inspector network listener is opened.

Promise metadata likewise tracks ordinary descriptors, accessor identities,
extensibility and prototype references. `Promise.prototype` is observed as one
mutable shared object. Callable intrinsic identities remain explicit, and
unsupported callable mutations or unregistered Proxy state are refused before
guest getters or traps can run.
