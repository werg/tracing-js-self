# Shared Promise join protocol

The first combinator slice defines profile `promise-join/1` and supports
`Promise.all` and `Promise.race`. It uses the controller's existing Promise
heap nodes, reaction jobs, ready queue, and scheduler. It does not create a
second heap or represent a private execution frame. Promise source admission
and native admission remain separate gates.

## Exact records

All records use the canonical `protocol ` line prefix.

| Kind | Exact fields after `kind` | Meaning |
| --- | --- | --- |
| `promise.join` | `mode, result, inputs, jobs, output, error` | Attach an aggregate reaction to each input Promise in the declared input order. |
| `promise.join.step` | `result, job, entry, output, error, status, value` | Consume the queued reaction for one settled input and check the aggregate's resulting settlement. |

`mode` is `all` or `race`. `result` is an existing fresh pending Promise;
`inputs` are existing Promises and `jobs` are fresh identities with one job per
input. For nonempty input, registration uses `output:null,error:null`; this
avoids disclosing future allocation identities before the reactions run.
Empty `all` allocates its empty result array at registration; empty `race`
remains pending. Unsupported modes and unused allocation identities are
rejected.

For a step, `job` must be the ready-queue head and the JavaScript stack must be
empty. A race settles from the first queued input. `all` preserves input order,
rejects on the first queued rejection, and allocates its output array only when
all fulfillments have been observed. The `output` identity is therefore fresh
at that final step only. `entry` and `error` are reserved and must be `null` in
this slice. `status` is the aggregate Promise's actual state after the step;
`value` is `null` while pending and otherwise the exact tagged settlement.
Once settled, later queued reactions are still consumed as explicit no-op
steps, preserving the scheduler's FIFO history.

## Scheduler and rollback

Every protocol record is evaluated on a staged controller copy. The stage
includes the heap, jobs, ready queue, scheduler counters, and continuations;
any false claim or invalid identity discards all of those changes. Generic job
dispatch cannot consume a join reaction. The registered adapter exposes
capabilities for the v8 lifecycle harness to recognize internal scheduler
records, allow the stack-free `promise.join.step`, and retain ordinary legacy
closure calls without permitting protocol-managed calls to bypass restoration.

The shared-state restore check validates the aggregate state against all input
identities, per-input observations, registered jobs, queue lifecycle, output
allocations, and the aggregate Promise's settlement. Unsupported or malformed
continuations are rejected rather than inferred.
