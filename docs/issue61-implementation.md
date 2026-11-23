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
- Earlier receipts remain historical. Each receipt below names the producer
  revision it actually executed. A later revision must retain its own evidence;
  unchanged implementation-file hashes do not rename an earlier execution.

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
- [x] Complete source projection for the bounded Promise object and adoption
  getter slice, including original-reference comparison and checked replay.
- [x] Extend independently implemented native transitions and rejection
  controls for receivers, descriptors, prototypes, source bindings and order.
- [x] Regenerate affected contracts and fixtures in place; contract checks pass.
- [x] Rerun all 40 original variants at the first runtime checkpoint and retain
  every outcome/new barrier.
- [x] Record the baseline and first-runtime executed revisions, input hashes,
  budgets and commands.
- [x] Rerun and retain all 40 variants at clean producer `7336d7ba`, including
  the initial runtime constructor/species/finally changes. Its 74 recorded
  implementation-file hashes match integrated producer `d4b049c6`; this
  historical fingerprint does not include the later runtime review fixes.
- [x] Run the initial integrated focused controls: 66 passed, with no skips. Retain source
  and native results separately from the original-script campaign.
- [x] Complete the original 437-file producer regression population and retain
  original failures alongside complete corrective file runs. The reconciled
  population is 3,279 actual leaves: 3,181 passes and 98 optional-native skips.
  This is an accounting of separate runs, not one all-green invocation.
- [x] Repair the five semantic review findings across the runtime and both
  protocol implementations, including unsupported callable restoration.
- [x] Rerun the original 40 variants at clean producer `783cf78f` after the
  finally/species review corrections: parse, owned and reference each pass 40/40.
- [ ] Finish native regression qualification, including the three stale
  retained-fixture assertions exposed by the broader hosted run.
- [ ] Finish the installed combined gate, retaining its exact installed pair
  and final result. Local full attestation is blocked by the unavailable kernel
  time namespace; separate components and hosted CI remain explicitly distinct.
- [ ] Complete the explicitly bounded source-profile follow-ups below; these
  are not inferred from the passing original-script or focused-control results.

## Executed original-input campaigns

The unchanged selection contains 20 files and both required modes for each
file. Each campaign retains 40 parse, 40 owned-execution and 40 independent
Node/V8-reference attempts. All use the exact full-catalog digest
`67799da9e7d4dd08333fe38a75b7d738d9fd14ffc40a2e17d4d00254781a47de`.

| Executed producer | Parse | Owned execution | Independent Node/V8 reference | Retained evidence |
| --- | --- | --- | --- | --- |
| `3d72b27cf626b87d78eb0b883f54ea9e9c5380e8` | 40 passed | 30 passed, 10 unsupported | 40 passed | `artifacts/conformance/issue61-baseline/` |
| `47cd67bc48921b55135f5cde02c49b06e2ab4bd8` | 40 passed | 40 passed | 40 passed | `artifacts/conformance/issue61-runtime/` |
| `7336d7bacdb7e53025cd8e66ed0d844b19c6ab19` | 40 passed | 40 passed | 40 passed | `artifacts/conformance/issue61-current/` |
| `783cf78fb039d1ca97261fc41b086096e343f06b` | 40 passed | 40 passed | 40 passed | `artifacts/conformance/issue61-review-final/` |

The baseline diagnoses identify unsupported Promise own-property storage,
`Object.prototype.hasOwnProperty` in the original async harness, and access to
`Promise.prototype`. No diagnostic invented a guest throw or counted a caught
implementation refusal as success. The first runtime rerun exposed no further
barrier within these 40 variants. Its result applies to that runtime checkpoint,
before the later source, observer and native integration changes. The clean
`7336d7ba` campaign includes the subsequent initial runtime fixes and again
exposes no new barrier. Its 74-file implementation fingerprint matched the
integrated producer payload through `65ce0796`. The review fixes change that
fingerprint, so the separate clean `783cf78f` campaign executes all 40 variants
again and passes all three stages. Neither report is relabeled as a later run.

The retained projections were checked against every original file and harness
hash at the pinned Test262 revision. All selected IDs and variant identities are
unchanged; all 103,320 unselected variants remain explicitly `not_selected`.
The existing reconstruction tool recovers each complete report byte for byte,
and resuming each completed campaign retains exactly the original 120 attempts.
The per-campaign `observation.json`, `verification.json` and `reproduce.sh`
record the exact commands, budgets, source identities and reconstruction hashes.
These Node/V8-reference passes do not assert independent native transition
admission; source and native checks retain their own status. In particular, the
40 original scripts have `sourceCorrespondence: not_run`, with public/native
replay blocked by that unrun stage. No original file or harness was rewritten
to obtain a source-qualified replacement.

## Integrated source and independent native evidence

The integrated producer payload is
`d4b049c6392b7eb5a04465ddac36f1377138c73c`; the paired native payload is
`375063e4aa802f309eda611db289260d60507e4a`. These identify the new
public/source/native integration, rather than relabeling the original-script
campaign above. All seven required shared payload comparisons pass, decoding
34,899,975 bytes; this checks the paired artifacts and does not replace their
execution evidence.

The initial integrated focused run passed all 66 controls with no skips. Its new source
population contains 20 distinct programs and 533 generated contexts:

| Source population | Source cases | Actual native cases | Generated contexts |
| --- | ---: | ---: | ---: |
| Promise object state, reflection, receiver and getter order | 15 | 15 | 320 |
| Constructor getters inside Promise adoption jobs | 5 | 5 | 213 |
| Total | 20 | 20 | 533 |

Each positive source case compares the unmodified fixture program against the
independent original-reference execution, checks source correspondence and
public replay, and independently replays the public operations in the native
consumer. The native final shared state must equal the producer's selected
shared state after JSON restoration. These are separate source artifacts and
public reflection controls; they are not native admission of the 40 complete
Test262 scripts and their harnesses.

The direct Promise object controls reject 23 altered public records and 32
corrupted restored states. The adoption getter source controls additionally
reject 10 altered records and 20 corrupted restored states. Negative controls
cover descriptor and prototype substitutions, actual accessor receivers,
intrinsic identities, changed source bindings, completion order, active job
ownership and retained getter scopes. These results make no module, training
or learned-execution admission claim. Source evidence reports zero optimizer
updates.

The focused tests retain these receipt files through `RUNNER_TEMP`:

- `promise-object-source-evidence.json`
- `promise-object-public-native-evidence.json`
- `promise-adoption-getter-source-evidence.json`

The original-script campaign's exact worker commands, resource budgets,
implementation fingerprint and source/harness hashes remain in each campaign
directory. Broad producer receipts are retained in
`artifacts/conformance/issue61-controls/`; review corrections and exact-pair
qualification have separate receipts below.

## Adoption getter scope and restoration

A constructor getter used by an intrinsic Promise assimilation job has no
ordinary guest caller. It must retain the actual running job while nested
ordinary calls execute. The checked `promise.adopt.get` and
`promise.adopt.finish` records preserve that ownership, the selected getter,
receiver and captures. A normal supported constructor result registers the
forwarding dependency after the getter returns; a thrown value rejects only
the adopter and creates no forwarding job. Promise-valued rejection reasons
remain opaque.

Across the object and adoption source controls, cases cover competing-job FIFO,
the actual inherited/own getter receiver, nested-helper throws and cleanup,
constructor reentry, a pending target settled by a later callback, and
replacement of the getter's descriptor during its activation. Restoration
checks the original selected callable and scope, while respecting that another
invocation sharing the heap has its own frame table. Uninitialized captures,
wrong job/child identities and bypasses through generic return or atomic
adoption remain rejected.

## Review corrections and retained regression evidence

The five semantic review findings are corrected in producer `d25c2734` and
`783cf78f`, with independent native counterparts in `085655fc`:

1. `finally` selects its `then` method after the first constructor/species
   lookup. An intrinsic `then` then performs its own constructor lookup. A
   mutation during that second lookup cannot change the already selected
   method. A first getter that installs an unsupported custom method refuses
   after the getter's effects, before a second lookup or cleanup callback.
2. A species getter reached through a data-valued constructor must authenticate
   that original constructor value. A different object with the same accessor
   function and captures cannot be substituted as the species receiver.
3. Intrinsic callable references used as an ordinary object's `then` cannot
   silently fulfill the destination Promise. Unsupported assimilation requires
   an explicit implementation refusal, as it does for an ordinary closure.
4. An unmodeled Array or Function prototype member cannot fall through to the
   similarly named Object member. Explicit custom prototype chains remain
   valid; shared Object members still use their current descriptors.
5. General primitive conversion and the retained Number component consult
   mutable shared Object prototype state. Live selection, derived faults and
   restored complete/abrupt continuations reject unsupported intrinsic and
   Proxy callable methods instead of treating them as noncallable guest errors.

`artifacts/conformance/issue61-review-controls/` retains four actual producer
executions: runtime focus 17/17, existing runtime regressions 51/51, public
boundaries 83 passes plus one optional-native skip, and Number source controls
7/7. The 11 new shared-intrinsic controls are a subset of the 84-leaf public
run. No standalone log is invented for an earlier unretained execution.
These are working-tree receipts before their checkpoint commits, with the
concurrent-edit limitation of the public run recorded explicitly. Native
review controls separately pass 78/78: properties 31, primitive conversion 19,
Number 15 and host protocol 13.

The expanded required Promise gate selects 266 producer leaves across 22 files
and 179 native leaves across 11 files. Its per-file JUnit counts, missing-test
checks and zero-skip requirement remain strict. The dedicated interoperability
workflow also requires the full 81-leaf object/adoption/runtime/review group.
These expectations do not count as an executed gate result.

The earlier clean pair `65ce0796` / `fb82c671` independently replayed all 51
source fixtures through a noneditable installed native wheel, with all seven
shared payloads byte-identical. The subsequent native group passed 136 of 142
tests; six host controls exposed the same nullable protocol-state bug. The
producer group did not run after that command failed. The original installed
receipt, failures, policy, commands and build logs are retained separately in
`artifacts/conformance/issue61-paired-review/prior-65ce-fb82/`. The native bug
and the missing source-extension inventory are corrected in `085655fc`.

Full local combined attestation stops because this workspace does not expose
`/proc/self/ns/time`. The actual namespace check has not been weakened or
replaced. Separate installed replay and Promise test components do not qualify
the six-lane recovery/Promise gate; hosted CI must produce that complete result.

## Explicit remaining profile boundaries

These remaining cases stop with implementation refusals rather than becoming
guest exceptions or successful negative tests:

- **Original global-object harness source qualification:** the unchanged
  `asyncHelpers.js` reflection path is covered by original-script owned and
  Node/V8-reference execution. The function-entry source profile still refuses
  the unbound `globalThis` identifier, so these receipts do not claim a native
  source-qualified `globalThis` object. Runtime reflection distinguishes script
  `var`/function properties from top-level lexical bindings; general global
  object mutation remains unsupported. Continue original-script qualification
  in [#49](https://github.com/werg/tracing-js-self/issues/49) and global object
  storage/reflection in [#51](https://github.com/werg/tracing-js-self/issues/51).
- **General normal `Promise.prototype.finally` cleanup projection:** runtime
  constructor/species and cleanup ordering are implemented and differentially
  checked. General source projection still needs an explicit cleanup
  continuation retaining the original completion, returned cleanup value,
  selected or wrapped cleanup Promise, pass-through result and subsequent
  adoption jobs. Ordinary source `try`/`finally` cleanup is covered separately.
  Continue this scheduler composition in
  [#50](https://github.com/werg/tracing-js-self/issues/50).
- **Custom species and broader thenable/combinator continuations:** the new
  adoption getter protocol admits the intrinsic `Promise` or `undefined`
  constructor result and exact thrown completions. Other constructor/species
  results require their own checked continuation. Custom species allocation,
  unmodeled constructor/then behavior in combinators, and the remaining mutable
  intrinsic/function/global storage operations are explicitly refused. Keep
  their Promise scheduling work in
  [#50](https://github.com/werg/tracing-js-self/issues/50) and shared object
  operations in [#51](https://github.com/werg/tracing-js-self/issues/51).

An additional shared `Promise.prototype.constructor` getter combined with
async-return adoption source-qualified successfully. The producer audit also
confirmed the `globalThis` source-profile refusal above. Later semantic review
exposed the five counterexamples recorded in the preceding section; their
passing regression controls, rather than the earlier audit, establish the
current supported boundaries.

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
