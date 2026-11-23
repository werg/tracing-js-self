# Living JavaScript coverage and corpus

This is the working record for [issue #48](https://github.com/werg/tracing-js-self/issues/48).
The development target is current JavaScript and useful real programs. A supported
subset, a saved run, or a historical format label does not freeze that target.
Implementation, independent checking, corpus production, preparation, training,
and serving advance together. Earlier observations retain their actual code,
inputs, settings, and outcomes; they do not certify later code.

## Implemented in PR #60

This records the completed implementation increments and observed verification
as of 2026-11-23. The [PR description](https://github.com/werg/tracing-js-self/pull/60)
keeps the live tally, including final CI status. The checkpoints below identify
code changes; each test result retains its actual code and scope. The continuing
language, corpus, and training work remains explicit below.

| Area | Implemented behavior | Published checkpoints |
| --- | --- | --- |
| Async iteration and cleanup | Owned `for await` execution, synchronous-iterator adaptation, method and value observations, abrupt iterator closing, completion precedence, and suspended cleanup are represented in public traces. Array binding patterns include holes, defaults, rest, and awaited defaults with nested cleanup. | [Initial public semantics](https://github.com/werg/tracing-js-self/commit/b317649ee492fb284934b47f323b75e5649590f4), [binding and nested cleanup](https://github.com/werg/tracing-js-self/commit/059dd97794df9ed9cf9b4bc8811dfd1ce468ef45); [supported boundary details](ASYNC_ITERATION.md) |
| Shared source projection | Projection can resolve references allocated in the current authenticated event, including generator function/prototype pairs. Shared adapters retain their declared binding and cleanup capabilities. Array-rest appends use their own checked operation. | [Current-event allocation](https://github.com/werg/tracing-js-self/commit/48bcca066593c0caf40b972260d73bb8a269249b), [adapter declarations](https://github.com/werg/tracing-js-self/commit/059dd97794df9ed9cf9b4bc8811dfd1ce468ef45) |
| Original async completion | Owned and reference execution distinguish the original `$DONE` invocation from printed markers. Error arguments and abrupt callback exits remain failures even if guest code suppresses output or catches an exception. Missing and duplicate completion remain explicit dispositions. | [Completion ownership and failure retention](https://github.com/werg/tracing-js-self/commit/c04cfa49c14a20ab4a452a059a87766989d4eb6f) |
| Guest errors versus implementation limits | Property definition, prototype operations, extensibility, frozen-state inspection, and Proxy construction distinguish actual primitive/type/invariant errors from unmodeled object storage. Unsupported builtin accessors, prototype-named accessor storage, and incomplete function descriptors stop execution outside guest catches. Valid primitive `setPrototypeOf` no-ops and intact Promise frozen-state checks remain supported. | [Property definition](https://github.com/werg/tracing-js-self/commit/5f321f0c634773bbccdb12b9ab6d18f69954f1ef), [Object/reflection guards](https://github.com/werg/tracing-js-self/commit/d9f7984779095b3656cd2ea94150d4c4eea3cea8), [function descriptor guard](https://github.com/werg/tracing-js-self/commit/d5eb323cdb914c8f5bbfa87ce18858644d32e2b3), [Proxy constructor guard](https://github.com/werg/tracing-js-self/commit/ce364792c03998e45a1d01675d85235df8c9e97c) |
| Complete Test262 acquisition | Every original source and harness byte is checked against its acquired Git blob. Retained metadata, required modes, variant identities, and population summaries are reconciled. Module closures are rediscovered from acquired sources before selection, rejecting omitted/extra dependencies and fabricated unresolved states. | [Catalog authentication](https://github.com/werg/tracing-js-self/commit/2657b568a176244906655eefd8bc67db1e0f8747), [dependency-closure reconciliation](https://github.com/werg/tracing-js-self/commit/081b96e839856f6d7e4abc27b2ebb68d02f1c04d) |
| Resumable current campaigns | Current inventories can grow without deleting earlier observations. Source-family shards partition the population; interruption, retry, failure, and unrun stages stay visible. Resume fingerprints include the runner import closure and installed Acorn/TypeScript implementation bytes. | [Current inventory and shards](https://github.com/werg/tracing-js-self/commit/3bd9c1034c41e9d818b0ac6811e9871155b783d2), [runtime dependency fingerprints](https://github.com/werg/tracing-js-self/commit/2657b568a176244906655eefd8bc67db1e0f8747) |
| Source-family separation | Clone checking retains common-fragment evidence and authenticates the complete declared relations. Configurable comparison/index budgets fail visibly instead of silently discarding candidate matches or imposing a fixed population ceiling. | [Complete clone relations](https://github.com/werg/tracing-js-self/commit/0bc92e2286b7332a8da39d93486a42d14a95d6df) |
| Generation accounting | Qualification counts derive from authenticated current populations. Selected cases retain failures, limits, and unrun work. A cancelled attempt cannot be accepted as a completed shard receipt. | [Population-derived accounting](https://github.com/werg/tracing-js-self/commit/4f373d01da1c0d545c8f33c6e39ccb97684239e5), [cancelled-receipt rejection](https://github.com/werg/tracing-js-self/commit/789e75c4ba4077276fb9c3045f19b84203b4b414) |
| Independent native records | The native checker retains the actual operation separately from a completion payload's `kind`. Cleanup transfers are no longer misread as frame returns, and completion payloads cannot hide unfinished async work at `end`. | [Consumer operation/completion repair](https://github.com/werg/megatoken/commit/6006b6cadad7a44e5c2e382ac937057a607e64f0) |
| Current continuation fixtures | Callback, source-session, and recovery controls were regenerated and rechecked from their original source or explicit controlled inputs, including the retained pending-completion scope. Shared producer/consumer callback fixtures have identical bytes. | [Producer callback evidence](https://github.com/werg/tracing-js-self/commit/9a17eb451f5d8ca66b6f2b9075a3b39d3ef18fdb), [consumer continuation controls](https://github.com/werg/megatoken/commit/86e70e72a74fd8eb9a099c18355096086ad5ebb9) |
| Bounded lifecycle population | A single-source preparation is checked against its full frozen registry and exact source/public/context bytes. Independent optimizer-position checks use the authenticated prepared training source IDs. Full support-population checks still require every declared member and split. | [Consumer prepared-population audit](https://github.com/werg/megatoken/commit/aab637f002323a7820759763652df7a5ad50fe04) |
| Current paired CI | Each run resolves the matching development branch, or the current default when the matching branch is absent, to an exact commit. Network/lookup failures do not silently select another revision. The resulting policy is retained separately from the clean checkout. | [Producer per-run policies](https://github.com/werg/tracing-js-self/commit/41553d8296abacb5c852e9734fd4c336b2f652d8), [consumer producer resolution](https://github.com/werg/megatoken/commit/6006b6cadad7a44e5c2e382ac937057a607e64f0) |
| Installed dependency evidence | `npm ci` uses `package-lock.json`; packed execution retains the same bytes as `contracts/npm-lock.json`. Divergence or missing evidence fails verification. Offline package qualification checks archive integrity, installed dependency trees, and package contents under current npm behavior. Direct release wrappers authenticate the updated drivers. | [npm installation and packing](https://github.com/werg/tracing-js-self/commit/c71c5425e8ca84b9e62942990aefadea1a9b7163), [release driver authentication](https://github.com/werg/tracing-js-self/commit/45a1806d99550b9bbc9cdc1e86d4ca41833ae24e) |
| Reproducible regression controls | Edition mutations rehash variant identities before checking semantics. Native replay cases have separate fixed deadlines, and live tests read tracked fixture paths from clean producer checkouts. | [Edition controls](https://github.com/werg/tracing-js-self/commit/d4ceb0744a15b37908c99337a2a320e7185b5b8a), [native replay isolation](https://github.com/werg/megatoken/commit/5a97318ecc77998fb2fc87a3500771b705793ab7), [tracked fixture paths](https://github.com/werg/megatoken/commit/65ebbf6a8eaafe707277eae0d8606b84c9db3ab3), [per-fixture async native deadlines](https://github.com/werg/tracing-js-self/commit/a44621ceb9bcb25b1348b349b70056cdef902d65) |

### Observed verification

The [verification record](evidence/living-javascript-20261123/README.md) retains commands,
logs, identities, environment details, and follow-up outcomes. These are separate
observations, with overlapping tests. Their counts must not be added into a new
suite total or attributed to a later branch head.

#### Clean producer/consumer integration and ordinary lifecycle

The fresh integration run used producer
`5f321f0c634773bbccdb12b9ab6d18f69954f1ef` and consumer
`aab637f002323a7820759763652df7a5ad50fe04`. Before/after metadata confirms that both
checkouts remained clean at those exact commits. The two ordinary lifecycle
observations used the same pair and a Python virtual environment whose child
processes could import the installed dependencies.

| Observation | Result and limit |
| --- | --- |
| Async source/binding and Promise source integration | **66 passed, zero failures, zero skips** across the async iteration source/binding suites and Promise object/mutation source suites. The actual Python consumer independently checked replay, generated contexts, and restored-state equality, including both optional native Promise controls. |
| Default ordinary lifecycle | **All five stages passed**, including preparation, two optimizer updates, checkpoint resume, export, and service restoration. |
| Registered async sibling-cleanup lifecycle | **All five stages passed** in a separate run using the newly registered async sibling-cleanup source, again with two optimizer updates, checkpoint resume, export, and service restoration. |

Both lifecycle reports retain `learnedSuccess: null`,
`fullPopulationQualified: false`, `fullTargetCoverageQualified: false`, and
`acknowledgedModelSelections: 0`. Service restoration preserved rejected and
awaiting-commit attempts; accepted-record recovery remains continuing work.
These runs demonstrate the exercised plumbing and restoration path; they do not
establish learned usefulness or full-population training. In the default bounded
preparation, the command declared 77 candidate
sources and retained a registry with 74 members in 63 components: 57 training,
6 validation, and 11 test sources. Its selected prepared example was one of the
57 training members. The registry, selection, prepared data, and optimizer
positions remain separately authenticated.

#### Broad suites and their targeted follow-ups

| Observation | Original result | Follow-up result and scope |
| --- | --- | --- |
| Producer suite at `9a17eb45` | **3,202 total: 3,106 passed, 10 failed, 86 skipped.** | Six failures came from the sandbox's helper ownership constraint; three affected files passed with **15 passes and 10 optional external skips** using the identical helper bytes in an owned location. Four stale edition-tamper fixtures were corrected at `d4ceb074`; **28 edition/catalog/acquisition controls passed with zero skips**. The original broad result remains recorded as a failing run. |
| Consumer suite at `86e70e72` | **1,152 passed, 2 failed, 3 skipped.** | The native no-legacy replay timeout was addressed by isolating cases under their fixed deadlines at `5a97318`; **71 controls passed**. The other failure was a relocated Torch child-process environment; **its single control passed** in the proper virtual environment. These checks do not constitute a rerun of the full suite. |
| Tracked live-source controls (fix published at `65ebbf6`) | The clean producer fixture lookup used an obsolete path. | The tracked fixture-path correction passed **3 of 3 live controls**. |

These targeted reruns resolved the observed failures without weakening the
production integrity checks. The broad-suite totals above are historical results
at their stated revisions, not a claim that the final branch passed every test.

#### Focused implementation observations

| Observation | Result and limit |
| --- | --- |
| Acquired closure repair | **37 passed, zero skips** across acquisition, catalog, campaign/resume, module-resolution, and independent module-reference controls in the isolated closure-fix worktree. The repair is published at `081b96e8`. |
| Initial property-storage repair | **90 passed, zero failures, two optional consumer checks skipped** across original Test262 execution, ordinary descriptors, and Promise source boundaries in the isolated repair worktree, published at `5f321f0c`. The false runtime-negative and caught-error successes were reproduced before repair. The later exact-pair 66-test observation above ran both skipped native controls. |
| Object/reflection storage guards | **139 passed, zero failures, zero skips** in the isolated increment published at `d9f79847`. This included original negative/catch controls, ordinary object/prototype/accessor and namespace behavior, and both actual native Promise controls. |
| Incomplete frozen-function descriptors | **29 passed, zero failures, zero skips** in the increment published at `d5eb323c`, covering ordinary/async/arrow function refusals, a supported generator-function control, and descriptor, namespace, and frozen-template regressions. |
| Proxy constructor storage | **15 passed, zero failures, zero skips** in the increment published at `ce364792`, preserving primitive errors and supported Proxy routing, trap, and invariant behavior. |
| Per-fixture async native checks | **20 source controls and 7 binding controls passed in separate runs, with zero failures or skips.** These focused test-only candidates were based on `ce364792` with consumer `65ebbf6a`. All eleven native fixtures retain their replay, context, continuation, JSON roundtrip, and full-state equality assertions under separate 120-second child limits. The earlier hosted eight-fixture aggregate timeout remains recorded separately. |
| Direct release Python controls | **110 passed** after correcting the two direct-driver authentication hashes in `45a1806d`. |
| Generated contracts and reference fixture | The earlier `contracts:check` generators passed on producer `5f321f0c`; the earlier reference fixture passed on producer `9a17eb45`. The final recheck also exited successfully at producer `ce364792c03998e45a1d01675d85235df8c9e97c`; producer and consumer were clean at `ce364792` and `65ebbf6a`, respectively. |
| Current continuation fixtures | Producer callback controls: **20 passed**. Independent callback/identity/host controls: **38 passed**; callback-return controls: **15 passed**. These are separate runs, not a deduplicated aggregate. |

The earlier 18-test local async source/binding integration also passed with zero
skips, but it did not capture clean checkout identities at both boundaries. It
remains an unpinned local observation; the later 66-test run supplies exact-pair
evidence without retroactively assigning revisions to that earlier run.

The local ordinary lifecycles used PyTorch **2.14.1+cpu**. CI's hashed dependency
lock specifies **2.10.0+cpu**; local results must retain that difference. The
production tokenizer bytes matched SHA-256
`40fb9d7d7795b8bd305aeff39ce9963f3f450915b9553f2938e009be9a1fed60`.

### Current original-source Test262 observation

The [retained Test262 record](../artifacts/conformance/test262-current-pr60/README.md)
binds producer `5f321f0c634773bbccdb12b9ab6d18f69954f1ef` to upstream revision
`2a1ade303f72d3de80565c921d685222405c32ce`. Acquisition enumerated **103,360 required
variants** without unresolved metadata or missing harness files. Execution
selected **20 original files and all 40 required strict/sloppy variants**; the
other 103,320 variants remain `not_selected`.

| Selected stage | Passed | Unsupported | Failed or resource limited |
| --- | ---: | ---: | ---: |
| Parse/static | 40 | 0 | 0 |
| Owned execution | 30 | 10 | 0 |
| Independent reference | 40 | 0 | 0 |

The three requested stages retained **120 attempts**, with no environment or
infrastructure failures. An exact-policy completed resume kept 120 attempts and
identical complete report bytes. The compact retained packet reconstructed the
**179,435,636-byte JSON report** and **17,316,813-byte gzip report** byte for byte,
with **zero guest executions**. This reconstruction restores historical evidence;
it is not a new execution or a trace-checkpoint qualification.

The ten unsupported variants are five original sources in both modes: two
variants require Promise instance property definition, two encounter the
original async harness's `Object.prototype.hasOwnProperty`, and six require
`Promise.prototype` during three constructor-lookup setups. Their first refusals
precede the intended iteration observations. These outcomes identify Promise
object/prototype and original-harness reflection gaps; they do not establish
iterator-semantic failures. Source correspondence, public/native trace replay,
admission, training, serving, and usefulness remain unrun or blocked in this
campaign ledger. The independent source/native and lifecycle observations above
have different inputs and do not fill those ledger stages.

The earlier `c71c5425` observation retains its original 10,000 ms worker limit,
29 owned passes, 10 unsupported variants, and one resource-limited variant. The
later 60,000 ms run passed that variant under its separately recorded policy;
the earlier exhausted attempt was not overwritten.

### Verification boundaries

- **Current hosted CI is recorded in the [live PR tally](https://github.com/werg/tracing-js-self/pull/60).**
  The completed local observations and targeted repairs above do not assign
  earlier results to a later branch head. The retained packet separately records
  the hosted aggregate timeout, its local repair, and the rerun pending at publication.
- **Continuing implementation and qualification** remain under the issues below:
  missing Promise/harness reflection, broader language and host behavior, safe
  corpus append and preparation across growing populations, full training and
  held-out evaluation, and evidence of learned usefulness. Neither the selected
  original-source campaign nor the bounded lifecycle closes those tasks.

## Reproduction commands

Run from the producer checkout unless stated otherwise. Install the locked
dependencies, provide a writable temporary directory, and use modest test
concurrency when the native checks share a machine:

```sh
npm ci --ignore-scripts --no-audit --no-fund
export TMPDIR=/absolute/path/to/writable-temp
mkdir -p "$TMPDIR"
npm run contracts:check
node fixtures/reference/reference-fixture.mjs
node --experimental-vm-modules --test --test-concurrency=2 \
  test/test262-acquisition.test.js test/test262-catalog.test.js \
  test/test262-campaign.test.js test/test262-module-resolution.test.js \
  test/test262-module-reference.test.js
```

For actual independent async replay, install the consumer and its required
Python dependencies in a virtual environment, then identify the exact checkouts
used for the run. Use the recorded `5f321f0c`/`aab637f0` pair when reproducing that
historical observation; a later pair is a new observation. Keep output outside
both source trees:

```sh
export MEGATOKEN_ROOT=/absolute/path/to/megatoken
export MEGATOKEN_PYTHON=/absolute/path/to/virtualenv/bin/python
export OMP_NUM_THREADS=1 MKL_NUM_THREADS=1
export RUNNER_TEMP=/absolute/path/to/native-evidence
mkdir -p "$RUNNER_TEMP"
git rev-parse HEAD
git status --porcelain --untracked-files=all
git -C "$MEGATOKEN_ROOT" rev-parse HEAD
git -C "$MEGATOKEN_ROOT" status --porcelain --untracked-files=all
node --experimental-vm-modules --test --test-concurrency=1 \
  test/semantic-async-iteration-source-v8.test.js \
  test/semantic-async-iteration-bindings-v8.test.js \
  test/semantic-promise-object-profile-source-v8.test.js \
  test/semantic-promise-mutation-profile-source-v8.test.js
git rev-parse HEAD
git status --porcelain --untracked-files=all
git -C "$MEGATOKEN_ROOT" rev-parse HEAD
git -C "$MEGATOKEN_ROOT" status --porcelain --untracked-files=all
"$MEGATOKEN_PYTHON" -m unittest discover -s tools/native-consumer -p 'test*.py'
```

The later reflection and Proxy guards have their own original-source and
regression controls:

```sh
node --experimental-vm-modules --test --test-concurrency=2 \
  test/test262-original-runner.test.js test/owned-prototypes.test.js \
  test/owned-exotics.test.js test/owned-data-descriptors.test.js \
  test/owned-proxy-null-traps.test.js test/owned-proxy-traps.test.js \
  test/evaluated-module-namespace-exotics.test.js \
  test/training-tagged-templates.test.js
```

For current Test262 execution, `TEST262_ROOT` must be a checkout of the exact
recorded revision. Set `TEST262_PATHS` to the recorded comma-separated original
paths; selection does not remove other variants from population accounting.
Use a fresh directory outside both repositories for `EVIDENCE_ROOT`.

```sh
node tools/catalog-test262.mjs --suite-root "$TEST262_ROOT" \
  --revision 2a1ade303f72d3de80565c921d685222405c32ce \
  --out "$EVIDENCE_ROOT/catalog.json.gz"
node tools/run-test262-campaign.mjs --suite-root "$TEST262_ROOT" \
  --revision 2a1ade303f72d3de80565c921d685222405c32ce \
  --catalog "$EVIDENCE_ROOT/catalog.json.gz" --paths "$TEST262_PATHS" \
  --stages parse,owned,reference --jobs 2 --worker-timeout-ms 60000 \
  --out "$EVIDENCE_ROOT/report.json.gz"
node tools/run-test262-campaign.mjs --check "$EVIDENCE_ROOT/report.json.gz"
node tools/run-test262-campaign.mjs --suite-root "$TEST262_ROOT" \
  --revision 2a1ade303f72d3de80565c921d685222405c32ce \
  --catalog "$EVIDENCE_ROOT/catalog.json.gz" --paths "$TEST262_PATHS" \
  --stages parse,owned,reference --jobs 2 --worker-timeout-ms 60000 \
  --resume "$EVIDENCE_ROOT/report.json.gz" --out "$EVIDENCE_ROOT/report.json.gz"
```

The remaining defaults are 20,000 owned steps, 1,048,576 source bytes, a 300 ms
reference VM budget, and 384 MiB per worker. Changing these limits or the checked
implementation creates a different campaign identity. Preserve the prior report
before retrying terminal failures.

To reconstruct the retained historical report without executing guest sources,
use the recorded producer implementation to reacquire the full catalog, then
pass it to the retained `restore-report.mjs`. Its exact command and expected
hashes are in the [retention instructions](../artifacts/conformance/test262-current-pr60/README.md#compact-retention-and-exact-reconstruction).
The retained `reproduce.sh` additionally runs a new observation and completed
resume, with their actual local environment identities.

For the ordinary lifecycle, retain a new policy bound to the exact consumer and
provide the production tokenizer. Both checkouts must be clean; `LIFECYCLE_OUT`
must be a new directory outside them. The selected Python executable must have
the dependencies installed in its environment: a wrapper that only adds
`PYTHONPATH` is insufficient for service children that reset that variable.

```sh
MEGATOKEN_REF="$(git -C "$MEGATOKEN_ROOT" rev-parse HEAD)" \
  node tools/resolve-native-consumer.mjs --out "$RUN_POLICY"
node tools/qualify-ordinary-v8-lifecycle.mjs --out "$LIFECYCLE_OUT" \
  --megatoken "$MEGATOKEN_ROOT" --python "$MEGATOKEN_PYTHON" \
  --tokenizer "$TOKENIZER_JSON" --native-policy "$RUN_POLICY"
node tools/qualify-ordinary-v8-lifecycle.mjs --out "$ASYNC_LIFECYCLE_OUT" \
  --megatoken "$MEGATOKEN_ROOT" --python "$MEGATOKEN_PYTHON" \
  --tokenizer "$TOKENIZER_JSON" --native-policy "$RUN_POLICY" \
  --source-id source-async-iterator-sibling-cleanup
```

Use a different new directory for `ASYNC_LIFECYCLE_OUT`. Each lifecycle command
performs two optimizer updates to check preparation, resume, export, and service
restoration. Its result must be reported with the
actual selected population and environment. The retained verification record
contains the separate default and registered async sibling-cleanup commands and
their five-stage receipts.

## Continuing work

These areas remain part of the same implementation. They are not a sequence of
scope-selection or release gates, and this increment does not claim to finish
them.

| Area | Continuing work |
| --- | --- |
| [Original sources #49](https://github.com/werg/tracing-js-self/issues/49) | Complete harnesses, strict/sloppy/raw/module variants, phase-correct errors, realms, async jobs, source correspondence, interruption and retry |
| [Async and cleanup #50](https://github.com/werg/tracing-js-self/issues/50) | Promise ownership and species, asynchronous iteration and generators, disposal, resumable cleanup, independent transitions |
| [Objects #51](https://github.com/werg/tracing-js-self/issues/51) | Observable reference and coercion order, Proxy invariants, construction, private state, sparse collections, abrupt partial effects |
| [Modules and sessions #52](https://github.com/werg/tracing-js-self/issues/52) | Loading/linking/evaluation, cyclic live bindings, dynamic import, persistent identities, complete TypeScript provenance |
| [Standard libraries #53](https://github.com/werg/tracing-js-self/issues/53) | Binary memory and aliases, owned RegExp execution, remaining builtin methods, explicit resource accounting |
| [Dynamic code and realms #54](https://github.com/werg/tracing-js-self/issues/54) | Owned eval and constructors, environment semantics, cross-realm identity, proper tail calls |
| [Agents #55](https://github.com/werg/tracing-js-self/issues/55) | Shared memory, atomic ordering, wait/notify, schedule exploration and recoverable worker state |
| [Weak references #56](https://github.com/werg/tracing-js-self/issues/56) | Reachability, keep-alive obligations, collection choices, cleanup reentry and restoration |
| [Hosts #57](https://github.com/werg/tracing-js-self/issues/57) | Node/browser APIs, scheduling, internationalization, explicit time and environment observations |
| [Durability #58](https://github.com/werg/tracing-js-self/issues/58) | Callback ingress after checkpoints, descendants, service ownership, physical-effect reconciliation and process-loss tests |
| [Current implementation #59](https://github.com/werg/tracing-js-self/issues/59) | Consolidate producer, native checker, preparation, exports, serving and restoration; retire obsolete paths as replacements work |
| [Corpus preparation](https://github.com/werg/megatoken/issues/39) | Continuously acquire and independently admit growing source families, preserve causal targets and physical membership, and qualify safe append across growing prepared populations |
| [Training and evaluation](https://github.com/werg/megatoken/issues/40) | Move beyond bounded optimizer/export/serving controls to full training, held-out evaluation, and measured usefulness; use observed model failures to guide implementation |

## Evidence rules

- Record actual source bytes, harness dependencies, tools, commands, and limits.
- Report parsing, owned execution, source correspondence, native checking,
  preparation, and model evaluation separately.
- Keep unsupported behavior, guest exceptions, infrastructure failures,
  resource exhaustion, interruption, and unrun cases distinguishable.
- Use configurable execution budgets to bound work. A budget does not define
  the language target or silently discard the rest of a source population.
- Keep related source families together across training and evaluation. If
  clustering exhausts its budget, fail visibly instead of weakening separation.
- Add regression examples to the ordinary corpus as semantics become usable.

## Lessons while implementing

- A reference process printing a success marker is not proof that the original
  source invoked the async harness completion callback. Observe its invocation,
  error argument, abrupt exit, and output ownership independently.
- A recomputed catalog digest proves internal consistency, not correspondence
  to acquired source. Omitting an existing module dependency can manufacture
  the expected resolution error unless the graph is rediscovered from source.
- Unsupported object storage must remain an implementation refusal. Emitting a
  guest `TypeError` for a valid Promise property operation can falsely pass a
  negative test or disappear inside a guest catch. Incorrect boolean defaults
  can also manufacture a later expected throw: lazy function properties and
  Proxy state cannot prove frozen-object invariants.
- An operation and its completion payload may both have a field named `kind`.
  Keep those meanings separate so a cleanup transfer cannot become a frame
  return and unfinished async work cannot evade the end-of-run check.
- Common source fragments still carry clone evidence. Silently dropping a
  large posting list changes the meaning of a train/evaluation split.
- Async iteration must retain the iterator and its methods across awaits and
  preserve pending-completion precedence during cleanup; parser acceptance alone
  would not establish support.
- Shared source adapters need the same static declarations as direct adapters.
  Allocation can publish mutually referring identities in one event; projection
  may inspect that event's authenticated new nodes without reading future state.
- A frozen registry, a selected cohort, prepared episodes, and optimizer-exposed
  positions describe different populations. Preserve each one explicitly; a
  successful single-source lifecycle cannot qualify the full registry.
- Installed execution needs reproducible dependency evidence after packaging.
  npm's omission of the root lock is handled by an exact-byte packaged copy,
  and wrapper hashes must follow the drivers they authenticate.
- Capture clean checkout identities when a run starts and when it finishes.
  Assigning a later commit to an earlier local test run would overstate the
  evidence even when the relevant semantic source files appear unchanged.
- A child service's Python interpreter must resolve its own dependencies.
  Parent-only environment injection can pass direct validation and still fail
  export/serving restoration when a child intentionally resets that environment.
- Retained source observations can be compact without losing their full
  population: deterministic unselected rows may be reconstructed only when the
  original inventory, ledger, and complete report hashes are checked. Such a
  reconstruction does not create new guest executions or qualification claims.
