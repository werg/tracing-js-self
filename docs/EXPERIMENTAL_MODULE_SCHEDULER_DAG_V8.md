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
general source compiler does not yet bind module lifecycle records and namespace
source cells to the shared controller. The source owner
refuses incomplete/unsettled module graphs and unsupported failure ownership.
Reports explicitly retain `publicAdmission:false`, `trainingAdmission:false` and
zero optimizer updates. No production denominator changes.

## Shared generator and Promise composition

The shared source compiler can now use the existing synchronous generator
protocol inside a Promise executor or reaction and across a root async await.
Generator definitions and their prototype capabilities publish together in the
same event transaction. The direct and composed compilers use the same exact
heap/descriptor shape checks. Generator frames have their own ownership and
retained-state comparison; Promise peer frames keep their existing checks.

Completion normalization distinguishes a generator's initial/yield suspension
from a final return, and the iterator result identity from its source return
value. An injected throw that enters a generator catch stays with that generator;
an uncaught throw exits the generator and executor in the actual caller order.
Tests cover six independently executed source cases, reverse component ordering,
exact JSON checkpoint recovery, ambiguous ownership before preparation, and
observer-failure rollback. The actual Python public consumer replays every
generated context and compares the complete final shared state. This new
foundation does not add fixtures to a production corpus or change its denominator.

At the qualified shared-generator revision, original linked module execution reached:
`Promise source helper requires a synchronous owned closure`. The public scoped
call engine needs an explicit nested async call protocol that detaches the child
at its first await, restores caller aliases and receiver, binds the actual
execution Promise, and later resumes/completes the same child independently.
Treating an async helper as an ordinary synchronous call would retain the wrong
call scope and permit false completion/FIFO evidence. The nested async foundation
below addresses that boundary. Shared yield delegation remains refused; existing
direct synchronous delegation stays supported.

## Nested async source calls

The new public protocol attaches a retained source call to the actual execution
Promise. Its first await removes only the child call frame and restores the
parent receiver and captured-cell aliases. The caller immediately receives the
execution Promise and keeps its own active Promise job. Later resumptions require
the same child's latest continuation and the next turn in both the invocation
and shared-realm ready queues. Repeated awaits detach that turn again. Immediate
and later child completion settle the execution Promise without overwriting the
parent's return or exception.

The independent Python evaluator implements the same transitions directly.
Snapshot validation checks execution-Promise ownership, frame identity, phase,
receiver, captured cells, continuation order and settled completion. Generic
call, return, await, resume and Promise settlement cannot bypass this owner.
Execution state is retained on the Promise node; existing protocol snapshots do
not gain a redundant global state table.

Ten original source cases compare independent execution, fresh source projection,
public replay, JSON checkpoint continuation and actual native replay of all 231
generated contexts. They include immediate and delayed rejection, caught rejected
awaits, repeated sibling awaits, nested children, live capture mutation, method
receivers, detachment inside an existing Promise reaction, ordinary reference
completion and a generator yielding a child execution Promise. Negative controls
check active-turn/FIFO authority, wrong Promise or settled input, duplicate event
ownership before preparation, observer-failure rollback and rehashed source
completion forgery. Async Promise callbacks, Promise-return adoption and thenable
assimilation retain explicit refusals.

An initial original three-module probe containing caught rejected TLA and a
sibling TLA now compiles its full 2,012-event owned execution into 707 public
records (112 protocol and 595 detailed). This compiler result is a prerequisite,
not module admission: original ESM/public/native module lifecycle binding still
requires its own exact evidence. The production module admission gate continues
to refuse async scheduler graphs. The public contract and paired native copy are
updated together for this isolated candidate; the six existing interoperability
example payloads and their digest are unchanged, and production native policy
pins and training populations remain untouched.

Still required before public admission: public module scheduler operations and
active-program plan binding; composition with the shared source compiler; independent
native replay of those records; actual source/native/token/packing qualification.
Cycles, dynamic import, realms, persistent module restoration, production corpus
exposure and learned quality are outside this first DAG foundation. No optimizer
updates are performed and no acceptance package is closed by these state tests.
