# engine262 adoption audit and Test262 baseline (2026-10-22)

## Decision and evidence boundary

**Reference candidate pinned, replacement not approved.** The repository retains its owned bytecode runtime as the **only** producer of authoritative semantic traces. engine262 is invoked *out of band* for spec-oriented script parsing and scalar outcome comparison; no engine262 execution is presented as a traced execution, and no engine262-owned activation is resumed from a checkpoint.

- Upstream candidate: [engine262](https://github.com/engine262/engine262), commit `2d7d8d988c77e94473ba0377122cdfccdfe243ba` (MIT); published npm build `@engine262/engine262@0.0.1-2d7d8d988c77e94473ba0377122cdfccdfe243ba`.
- Official suite source: [Test262](https://github.com/tc39/test262), commit `d53ebc8b1931d9f1541e43d59650776e4b766248`. The original 14 **syntax-only** files are pinned in `coverage/test262-slice.lock.json`; an additional 11 selected **execution smoke** files are independently pinned in `conformance/test262-cases.json`. Both runners verify Git blob SHA-1 before any parsing or evaluation. Only the selected execution runner evaluates Test262 source, in the bounded VM and the isolated engine262 reference.
- `profiles/targets.lock.json` is the authoritative revision ledger. CI uses Node.js 24 to run the external oracle; the tracer itself continues to support Node.js 20+ without optional dependencies.
- Reproduction on Node.js 24:
  ```sh
  VERSION="$(node -p "require('./profiles/targets.lock.json').referenceEngine.npmVersion")"
  npm install --no-save --package-lock=false --ignore-scripts --no-audit --no-fund "@engine262/engine262@$VERSION"
  node scripts/run-spec-probes.mjs
  node scripts/run-conformance.mjs --output /tmp/test262-baseline.json
  node tools/test262-baseline.mjs --output /tmp/test262-execution.json
  ```
  The GitHub Actions `Pinned spec oracle and Test262 baseline` job runs these commands and publishes **both** parse and execution reports. This initial slice is a **regression baseline**, not a Test262 conformance percentage. The installed npm package is pinned by an exact published version; an integrity-pinned dependency lockfile is still needed before release.

## Engine substitution feasibility

Upstream surfaces inspected at the pinned code lineage include `src/index.mts`, `src/api.mts`, `src/evaluator.mts`, `src/execution-context/Agent.mts`, and `src/host-defined/engine.mts`. The representative upstream example creates `Agent` and `ManagedRealm` and uses `evaluateScriptSkipDebugger`. engine262 exposes abstract operations and source evaluation hooks. **Those hooks alone are insufficient for a complete trace.**

| Layer | Reuse candidate | Blocking incompatibility with current authoritative trace |
| --- | --- | --- |
| Grammar, early errors, scripts, modules | engine262 parser / `ManagedRealm.compileScript` and `compileModule` | Parser and early-error completeness must be tested; source-site identifiers, parse decisions, and versioned source registry need stable authoritative representation. |
| Execution steps and completion records | `Evaluate` generators, `ScriptEvaluation`, completion classes | JavaScript generator continuations and closures are **not** serializable guest frames; cannot checkpoint, fork or replay the native generator's control state as owned records. |
| Bindings, environments, object internal methods | engine262 environment/value/abstract-operation classes | Mutable object graphs, accessors, descriptors, identities and hidden internal state require a typed state ledger and independently checked mutation events at spec-step granularity. |
| Intrinsics and standard library | `ManagedRealm` intrinsic installation, `src/intrinsics` | Intrinsic identities, nonlocal host functions, time/randomness, GC and proposal features require version pins, deterministic hooks and explicit exception/completion capture. |
| Promises, async jobs, agents | `Agent`, job queue, event loop | Native generator/job ownership, async reentry, cancellation and microtask ordering must be captured as owned frame/queue records, not left in a library object. |
| External Node/browser/ECMA-402 | host hooks, module loaders and host service adapters | ABI conversion, callback reentry, buffers, resources, GC and browser/Node APIs are not supplied by the ECMA-262 interpreter; they remain separate, open profiles. |
| Multi-agent and reproducibility | `surroundingAgent` in engine262 | Process-global active agent prevents naive concurrent reference evaluation; current oracle invokes tests sequentially with a fresh agent and realm. This does **not** prove isolation in a multitenant host. |

### Required migration gates (not yet passed)

1. **Clause and intrinsic inventory:** map supported ECMA-262 operations, early errors and Annex B behavior from a pinned upstream revision to versioned schema entries and explicit pass/fail/untested suite coverage. Do not infer universal support from an interpreter name.
2. **Owned spec continuation:** replace native generator suspension with serializable instruction/phase frames (or produce another independently reconstructible ownership representation). Keep source and spec operation IDs, object graph, environment, heap, completion and queue state fully owned.
3. **Native effects and transitions:** make every host bridge entry, conversion/getter, callback/reentry, throw and buffer mutation observable with typed inputs and logged ownership transitions. No opaque promises as guest continuations.
4. **Independent validation and replay:** compare a trace against an engine-independent oracle and reference observations; require deterministic replay with zero repeated host side effects. Prefix visibility and effect-authority proofs must be independently checked.
5. **Conformance expansion:** execute the actual Test262 harness with correct strict/non-strict/module/async variants, per-test realms, includes, negative phases and timeouts; pin suite, runner and host revisions. Add broad language, ECMA-402, Node and WPT profiles and keep denominators, skip reasons and failure inventories explicit.
6. **Release acceptance:** durability, checkpoints, large-workload performance, resource restoration and learned-model visibility gates all remain unresolved. `releaseEligibility` stays `false`.

## What the new checks prove

**Differential scalar probes** (`coverage/spec-probes.json`): the reference engine independently evaluates fixture-controlled scripts to a primitive result, while the owned bounded interpreter produces the same encoded primitive, a structurally valid trace, and a fully reproducible journal. These are intentionally pure scripts: zero live host effects. A passing result is **not** proof of shared full-language semantics.

**Test262 script syntax slice** (`coverage/test262-slice.lock.json`): official files are SHA-verified and parsed by both engine262 and the bounded front end. The runner checks Test262's `negative: {phase: parse, type: SyntaxError}` metadata; it reports both known bounded-grammar gaps and accepted cases. It distinguishes parser acceptance from compiler support. Cases requiring module, strict-only, async, harness includes or runtime-negative handling are intentionally **not** counted. The 14-file denominator describes the pinned slice only.

**Selected Test262 execution smoke** (`conformance/test262-cases.json`): eleven official, unmodified files are executed against the bounded VM and a separate engine262 realm, with baseline outcomes of four passing runtime-negative TDZ cases, five expected failures and two skips. Each case checks its Git blob, and the runner rejects any unexpected pass, failure, missing expected error, wrong reference result or silently skipped unlisted feature. The runner differentiates syntax rejection from compiler refusal. `tools/test262-baseline.mjs` writes a full JSON report before returning a nonzero exit status for unexpected outcomes; CI uploads it with `if-no-files-found: error`. This is **only one sloppy Script variant**; the full Test262 harness, includes, module goal, strict and async variants, and guest exception ownership are still missing. Positive tests may refer to `Test262Error` on their failure path; no general Test262 harness has been installed.

**Fail-closed policy:** spec oracle integration does not modify `Runtime.start`, the host effect bridge, the journal schema or `completeSemanticTrace: false`. Unsupported grammar must not be executed by Node's `eval`, `vm` or `Function` as a fallback. The untraced oracle cannot be exposed as an owned semantic tracing backend.

## Follow-on engineering

- Land a complete clause/intrinsic audit tied to engine262's exact upstream tree and a coverage generator that refuses unclassified operations; decide how to compile generator-based spec phases to owned frames.
- Build the first spec-backed **owned** operation path end to end (prefer one existing arithmetic/binding operation), with typed mutation commands and independent reference equivalence; only then expand.
- Implement a real Test262 execution harness profile independently of the parse slice and grow coverage without silently reclassifying unsupported or failing cases as passes.
