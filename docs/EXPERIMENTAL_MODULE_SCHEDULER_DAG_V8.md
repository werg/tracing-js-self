# Experimental async module DAG state foundation

This isolated foundation is not connected to public or native artifact admission.
It validates a bounded acyclic module dependency graph and module-body start,
await, resume, completion, rejection and dependency-failure propagation. Plans
derive source digests and dependency edges from evaluated-module linker metadata;
start order is derived from observed transitions, not prescribed sibling order.

Runtime frame, execution-Promise, awaited-Promise and reaction-job identities must
agree. Promise/job outcomes must agree for both fulfillment and rejection.
State is checked before and after transitions. Completed dependency edges and
propagated failure origins require settled dependency authority. The state helper
alone cannot establish the source provenance of caller-supplied facts. The source
owner below derives those facts from actual execution; neither component alone
owns a public event or grants data admission.

The paired probe runs original vm.SourceTextModule behavior, existing owned
scheduler regressions, standalone state controls and an actual Python comparison
at every accepted/refused JavaScript snapshot. The cross-language fixture and
complete logs are retained as workflow artifacts. Before those runs finish,
syntax checks are not execution evidence.

## Original source lifecycle ownership

`deriveModuleSchedulerSourceCutsV8` recompiles the original module request and
requires identical generated source, bytecode, sites, entry and initial state.
The complete owned archive must validate and replay. Module record allocations
are matched to the exact generated source ranges, indexed source dependency
edges and actual generator environments. Lifecycle actions then use the actual
driver frame, execution Promise, await continuation, queued reaction and callback
closure. Every emitted action owns one unique runtime event and the exact current
instruction; native replay compares the resulting state at every cut.

The source controls execute unmodified original ESM in Node and independently
observe original start/await/body-completion order. An observation callback returns
each await operand unchanged and creates no Promise or extra reaction. The observed
and unmodified executions must have the same outcome. This comparison covers
already-settled awaits, caught rejection, nested awaits and finally, shared and
synchronous dependencies, syntactic TLA that does not suspend, and async failure
before/after an await while an already-started sibling finishes. Changed source,
dependencies and bytecode refuse ownership.

Actual source execution exposed three invalid assumptions in the earlier helper:
synchronous modules have no execution Promise; await accepts already-fulfilled or
rejected Promises; and a rejected await resumes with a throw which source catch or
finally may handle. A module fails only when its own execution settles as rejected.
The corrected JavaScript and Python controllers preserve these distinctions and
refuse invented synchronous Promises or mismatched synchronous frame completions.

**This is a source-ownership qualification, not public artifact admission.** The
general source compiler does not yet compose the module generator environments,
namespace source cells and async shared-controller components. The source owner
refuses incomplete/unsettled module graphs and unsupported failure ownership.
Reports explicitly retain `publicAdmission:false`, `trainingAdmission:false` and
zero optimizer updates. No production denominator changes.

Still required before public admission: public module scheduler operations and
active-program plan binding; composition with the shared source compiler; independent
native replay of those records; actual source/native/token/packing qualification.
Cycles, dynamic import, realms, persistent module restoration, production corpus
exposure and learned quality are outside this first DAG foundation. No optimizer
updates are performed and no acceptance package is closed by these state tests.
