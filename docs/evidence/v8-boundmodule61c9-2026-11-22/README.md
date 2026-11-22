# Bound original-module lifecycle: exact hosted qualification

[Run 45016987512](https://github.com/werg/tracing-js-self/actions/runs/45016987512),
job `137191304151`, completed successfully on 2026-11-22 at 11:46 UTC. The
complete successful log and the earlier failed candidate's complete log are
retained alongside the machine-readable summary and exact source map.

| Component | Published commit actually checked | Identical local source tree |
| --- | --- | --- |
| Producer | `61c9cacfacad3d5e8fd7bab6c72c8e18b1a5a46b` | Local `79ec42a1ef7be0644a84953067d954453ec92c3b`, tree `7cd17267b3d44d9f51aa94d0d14dae13643a6e4c` |
| Native consumer | `4fd7b561774f4dcda7d08b985909cd08a882df71` | Local `bebe2bbc250ea9d7bd722aa420ca1ea07ca59274`, tree `8a74c801a6449027efc803c63855468cf789385f` |

Both candidate checkouts were verified clean at completion. The workflow
compared the paired contract byte-for-byte and regenerated canonical producer
fixtures without changing the checkout. Contract digest:
`a952385535b9b5e19d737206286f6f26c149f7301c51b4b106fe3b1cae5ab55a`.
All six existing interoperability cases remain unchanged, with digest
`f5c2d5fd15ad3b84e9b17de771d2f72a58f3c7dee4969ded8a7eb9c3c449f661`.

## What the implementation establishes

An immutable observed program can carry a source-bound module scheduler plan.
Its single new initialization record creates a logical scheduler ledger that
cannot escape into guest values or be targeted as a guest object. The plan
binds the exact source, entry, dependency graph, TLA inventory, generated helper
identities and completion callback positions. The public validator does not
import the teacher linker.

Subsequent lifecycle transitions derive from the existing checked public
calls, nested async scopes, execution promises, real reaction dispatches and
detailed returns/throws. The model cannot select a separate stream of lifecycle
facts. Starting a module requires its actual source record, generator, driver
frame and execution promise. Await/resume follows the retained continuation.
Completion dispatch must have the exact source callback and captured module
record. A rejected waiting parent inherits the checked dependency outcome.
The native implementation derives these transitions independently.

Retained-state validation checks active plan ownership, source module-record
properties and dependencies, driver frame identity, promise call ownership,
pending awaits and exact reaction settlement authority. Compact routes are refused for
this profile until they have equivalent lifecycle evidence. Graph completion
cannot bypass unsettled module obligations.

The standalone retained-state invariant checker is not a substitute for causal
replay. In particular, it checks a synchronous historical completion's module
and frame identity, while verified causal replay establishes its actual value.
A subsequent probe could change that value and pass the standalone helper;
that is not evidence of source or native artifact admission. Checkpoint restore
requires exact equality with an independently verified replay boundary. The
public plan does not constrain every synchronous driver body to a fixed return
value, so no inferred `undefined` constraint has been added.

## Exact test populations

The run passed **109 native tests** and **120 Node tests**, with zero failures,
errors or skips. The Node population comprises the existing 40 scheduler/source
controls, 49 shared-generator controls, 20 nested-async controls and 11 new
bound-module controls. These are this focused paired gate's counts, not the
repository-wide test-suite count.

The new original-source population is:

| Original graph | Module occurrences | Public/native contexts | Restored module cuts |
| --- | ---: | ---: | ---: |
| Caught rejection and independent sibling FIFO | 3 | 708 | 10 |
| Child execution rejection propagating to its waiting parent | 3 | 553 | 9 |
| Syntactic TLA with no await actually executed | 3 | 690 | 8 |
| Diamond with one shared synchronous dependency execution | 4 | 887 | 12 |
| Total | 13 | 2,838 | 39 |

Each graph compares original ESM outcome with the owned source execution,
requires uniquely owned lifecycle events, binds their public transactions and
compares lifecycle state at every owned cut. Independent native uninterrupted
replay checks all 2,838 causal contexts and requires exact final shared-state
equality. All 39 module-cut native checkpoints are serialized and restored. The
first 708-context artifact additionally runs the complete native artifact
validator, including its context-by-context continuation checks. This is not a
claim that all 2,838 checkpoints received that additional full-artifact pass.

The new control set refuses ten forged retained states and six forged plans.
It also checks atomic refusal of invalid initialization, compact routes, early
completion and guest escape, plus explicit refusal of cycles, namespace
composition and a larger source publication exceeding the existing record-byte
budget. Default module data admission remains refused at this exact revision.

The earlier original-source probe also passed again: three modules, 2,012 owned
events, 707 public records/contexts, 112 protocol records, 595 detailed records,
ten uniquely owned module cuts and ten independently checked native cuts.
That older probe intentionally has no active public module ledger and remains
engineering-only evidence.

## Defect caught before qualification

The prior pair, producer `aa0b79f878a3caa551d1f719ea7c4f60d4a59f16` and native
`c368bfc2cb0ce1c094979e82f2a6d1336e8112de`, failed
[run 45014789442](https://github.com/werg/tracing-js-self/actions/runs/45014789442).
All four original source cases passed, but the mandatory native comparison
failed during the rejected-dependency case. A waiting parent was bound to its
module record but never entered a driver frame. A later valueless root return
had an empty current stack. Python compared the absent current frame with the
parent's `None` frame and attempted to synthesize a synchronous completion.
The corresponding JavaScript absence values did not compare equal.

The correction requires an actual frame identity before applying synchronous
module completion. Two focused controls retain this absent-frame regression;
the original rejected-dependency graph is the end-to-end regression. The fix
does not manufacture a frame, promise or completion receipt. The successful run
uses the corrected native source and reruns the complete focused paired gate.

## Promotion map and boundaries

`source-map.json` lists all eleven producer paths and six native paths, their
exact Git blob IDs and the source revisions above. The producer delta is
relative to local `cc030fa9851f10d702e952d181b3b68003c294eb`; the native delta is
relative to local `b81eff9033709d79cb9d92d3789f03679718e543`. Later main-branch
recovery or target changes must be preserved when applying those deltas,
especially in the shared harness and native replay implementation. The isolated
investigation workflow is qualification evidence; a main workflow can invoke
the same mandatory commands using its own exact pair.

This revision does **not** establish source/data admission, tokenizer or mask
qualification, a production module population, optimizer updates or learned
success. Those require the separate original-source artifact bridge and its
actual preparation gate. Its schema and lifecycle foundation do not silently
admit ordinary module fixtures.

Cycles, namespace composition, general async adoption and thenables, larger
source programs beyond the existing byte budget, broader original-module
families and cost-qualified training remain separate work. The namespace
profile's existing six operations are unchanged.
