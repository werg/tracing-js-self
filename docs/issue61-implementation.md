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
- [x] Repair the second semantic review findings in reflection, async cleanup,
  await dependencies, getter unwind authority, retained intrinsic state,
  source receivers/updates, captured adoption methods and native observation.
- [x] Canonically regenerate the three stale native fixtures from unchanged
  original sources; all 20 tests in the affected complete files pass.
- [x] Execute the latest original 40 variants at clean producer `f3f24579`:
  parse, owned and independent reference each pass 40/40. Completed resume is
  byte-identical; final packet verification is tracked in its retained report.
- [ ] Finish native regression qualification and final live admission/packing.
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
| `f3f245798b3ac5de615c7aaf2cc2c472ea3d7abc` | 40 passed | 40 passed | 40 passed | `artifacts/conformance/issue61-qualified-final/` |

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
The second review again changed runtime and reference-launcher fingerprints;
the final `f3f24579` campaign executes the same complete population afresh and
also passes all three stages. Gate checkpoint `2ace1440` changes required
inventories and receipt checking, not that campaign's implementation.

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

The first expanded Promise gate selected 266 producer leaves across 22 files
and 179 native leaves across 11 files. The final `2ace1440` gate adds all second
review controls: **304 producer leaves across 27 files** and **191 native leaves
across 12 files**. Its per-file JUnit counts, missing-test checks and zero-skip
requirement remain strict. The dedicated interoperability workflow requires
119 leaves across 12 files. These expectations alone do not count as an
executed gate result.

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

## Second review corrections and final qualification

Producer reflection checkpoint `8bf97b73`, runtime checkpoint `310ee639` and
source/observer checkpoint `f3f24579` address the second set of concrete review
counterexamples. Native checkpoints `913afe46` and `acd86c65` independently
enforce the corresponding adoption and retained-invocation boundaries.

- Script global reflection reads the actual object-backed var/function binding
  cells, including updates after declaration. Top-level lexical bindings remain
  absent from the global object. Lazy function name/length presence checks do
  not require an observable value read. Promise prototype lookup follows owned
  function data and inherited ordinary accessors with the original receiver.
  The independent `in` validator recognizes the same Promise storage. A private
  on-demand heap view avoids copying every Promise row for each property read.
- Async `finally` callbacks preserve the cleanup getter's active continuation
  when the callback suspends or throws. Await records name the actual selected
  Promise or new wrapper and the synchronous then-getter invocation. Generator
  constructor/species getters refuse before entry; arrow getters preserve their
  lexical receiver while the property lookup retains its Promise receiver.
- Queued thenable entry authenticates the invocation cause, active frame and
  captured environment. Constructor rejection authority derives from the
  pre-event active unwind chain, including ordinary helper calls and explicit
  nested constructor continuations. Every traversed frame newly throws the
  exact completion, and the current destination must newly reject with the
  exact reason. A historical getter or unrelated frame cannot authorize it.
- Resolution captures the selected intrinsic then before queuing adoption.
  Later target mutations cannot replace that selection during replay or
  restoration. Constructor lookup remains live at its correct later step.
  Newly retained invocations derive only an initialization marker from the
  complete validated intrinsic group; they do not copy old frames, counters or
  continuations. Generic restoration still rejects a missing marker.
- Source projection checks actual `hasOwnProperty` method receivers and
  primitive numeric Promise updates through read, conversion, arithmetic and
  committed write, including BigInt, inherited data and prefix/postfix results.
  Accessor and object-coercing updates remain explicit source refusals.
- The observer no longer uses inspector property descriptions. On locked
  Node 24.22.3, inspector access can invoke an unrelated Error.stack getter.
  The trusted worker now uses native Promise slots, preserving actual result
  identity with zero stack/then/constructor/species calls. Unavailable slot
  access refuses outside guest catches; there is no inspector fallback.

`artifacts/conformance/issue61-second-review/` retains 20 separate executed
JUnit reports, their logs, original failures and corrective runs, original
runtime counterexample archives, native fixture regeneration, and the new
source/public packets. Its verifier checks every encoded and decoded hash,
recomputes every JUnit count, and compares the originals when available. The
working-tree receipts are explicitly not relabeled as clean revision runs.

Final focused results include runtime 76/76, reflection 24/24, source/public
15/15 with actual native validation, existing source 26/26 with actual native
validation, and observer 8/8 including the real namespace worker. Native
adoption/async/scheduler controls pass 40/40, retained detail 11/11, and the
three canonically refreshed fixture files 20/20. Gate policy and release-driver
controls pass 24/24. These runs overlap; they are not added as unique coverage.

The eight additional source cases retain 196 contexts, and two direct public
artifacts retain 30 contexts plus both invocation owners' checked shared states.
Together with the initial 20 new source cases, this gives 28 issue-specific
source examples and 729 contexts. The canonical installed fixture population
remains 51; the eight review sources are a separately named control population.
The final gate binds each receipt to its case, exact context count, successful
native checks and, for direct artifacts, both retained invocation owners.

The final clean component pair is producer
`2ace1440ebeac3b2ffac5a0061684bfcdfac1370` and native
`acd86c6513ec7af8b50365517f4bff9b7e2aad5a`. Installed-wheel replay and all
304 producer / 191 native Promise leaves are being executed on this pair.
`npm run contracts:check` passed at the final implementation checkpoint
`f3f24579`; the subsequent gate checkpoint changes no contract payloads.
Live CLI admission at clean `f3f24579` / `acd86c65` passes 29/29; actual
tokenizer-backed module packing and final component retention are in progress.
The unchanged full attestation still stops at the unavailable real kernel
time namespace, and its original failure is retained separately.

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
- **Broader accessor/conversion and ordinary storage:** primitive Promise
  updates are source-qualified, while accessor updates and object-coercing
  updates need explicit bounded continuations. Generator constructor/species
  getters refuse before invocation. General owned Object.prototype writes and
  descriptor mutation remain ordinary-storage boundaries; public/native
  mutable-prototype controls do not imply owned source support for those paths.
  Continue under [#49](https://github.com/werg/tracing-js-self/issues/49) and
  [#51](https://github.com/werg/tracing-js-self/issues/51).

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

The first repair used inspector `Runtime.getProperties`. The second review
demonstrated that even with previews disabled, describing Error-valued results
or properties can invoke Error.stack. That approach is now replaced rather than
treated as observationally neutral.

The worker drains the actual native microtask queue under its existing parent
deadline and reads the native util binding's Promise slots on the locked Node
runtime. Only the exact trusted protocol worker receives `--expose-internals`,
including its Linux namespace launch. No binding, require, process or additional
global is exposed to the guest realm. Actual result references preserve aliases
and primitive edge values without guest property reads or descriptions. Missing
slot support produces `unsupported.native-promise-observer` outside guest
catches. Rejection remains a guest throw; a root still pending at quiescence is
an explicit resource limit. Unrelated unhandled rejections remain failures.

Promise metadata likewise tracks ordinary descriptors, accessor identities,
extensibility and prototype references. `Promise.prototype` is observed as one
mutable shared object. Callable intrinsic identities remain explicit, and
unsupported callable mutations or unregistered Proxy state are refused before
guest getters or traps can run.
