# Namespace source-observation probe: retained refusal

Isolated candidate: `6884abf4e9ad59e31ec72ae6d55bb366f996fedb`, on
`codex/v8-namespace-observation-probe-20261122`. It is not the main PR branch and
its blanket namespace-refusal removal was not integrated.
Run: https://github.com/werg/tracing-js-self/actions/runs/44986745849
Job: https://github.com/werg/tracing-js-self/actions/runs/44986745849/job/137098868564

The source-module selection reports **11 tests: 7 passed, 4 failed, zero skips**.
The complete log is retained in `source-probe-failed.log`.

The positive probe inspected namespace keys, prototype, extensibility and an
export descriptor, then updated a live cell and returned ordinary data. It
failed with `Only primitive values may be encoded without a guest identity`.
Direct/nested namespace returns and an exotic receiver did not acquire a passed
original-module reference, contrary to the speculative probe expectations.

The owned runtime already has namespace heap entities and internal live cells.
Those internal facilities do not give the public graph codec a namespace
identity or the independent native interpreter a namespace-state transition.
Even an ordinary final result does not make exotic intermediate operands
publicly representable. Removing the early refusal is therefore insufficient.

Required implementation remains: source-owned module/cell identities and alias
bindings, initialization/TDZ and live updates, namespace identity and exotic
operations in public traces/checkpoints, independently derived Python transitions,
source-event ownership, JSON continuation and positive/malformed-state controls.
Numeric namespace export ordering has a separately retained Node/spec mismatch
and is not silently converted to positive evidence. Existing static import
lowering remains distinct from true namespace admission.

The main PR retains its original namespace refusal. No source/native admission,
training eligibility, or complete package is credited by this failed experiment.

## Corrected diagnosis from retained-stack probes

The initial message did not by itself locate a namespace identity defect.
[Run44989371057](https://github.com/werg/tracing-js-self/actions/runs/44989371057)
at isolated candidate3b1f64afccda8c3f2ffe67f5c43bffa4cf5fb741 retained the
throwing stack: values.encode → graph-codec visit → encodeNativeGraph →
module-region-reference-worker. Reflect.ownKeys returned Symbol.toStringTag in
the ordinary final result; that symbol is outside this result codec. This
corrects the earlier interpretation above without discarding the failed attempt.

The string-only Object.keys candidate1d569df13d1a0aa2aa3d613214bcb9149a135b73
then reached source admission and failed on the generated reserved namespace
intrinsic, in [run44989417490](https://github.com/werg/tracing-js-self/actions/runs/44989417490).
Both diagnostic runs remained7passed/4failed, zero skipped. Debug stack changes
were confined to the isolated branch and were never promoted.

The actual runtime already has internal namespace behavior. A complete public
slice still requires source-bound capability propagation, an owning public
namespace/live-cell transition component, exact retained-state checks and the
independent Python transition family. A separately isolated source-plan/state
experiment does not lift the main refusal or count as native admission.
