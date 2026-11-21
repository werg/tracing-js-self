# Durable return-value callback continuations in V8

## Current boundary

`SelectedExecutionLifecycleV8.enqueueClosure` creates a selected callback child
and returns a process-local Promise to the native adapter. The child invocation
and its selected controller state are included in a lifecycle checkpoint. The
Promise waiter is deliberately not restored: after a process restart there is no
live adapter stack to receive its settlement. `callbackOutcome(invocationId)`
exposes a completed child's exact tagged completion for an adapter that owns a
separate durable continuation. A guest throw is returned as `rejected` with the
same tagged completion; it is not converted to a normal result.

This read path is not callback-arrival durability. The pending-ingress snapshot
and append-only host ingress journal currently cover registered event arrivals
only. They refuse while a return-value callback is queued because recovering a
child without an authenticated arrival would invent host authority.

The parent native intent also remains uncertain after a crash once dispatch
began. `dispatch` does not retry an uncertain intent. The embedding must use
`reconcile` with independent external evidence before that parent can continue.
An adapter's Promise continuation is never serialized or reconstructed by the
runtime.

## Required durable callback contract

A completed implementation can extend the existing ingress journal with a
typed callback-return arrival. The entry must bind the session, exact public
prefix, parent invocation and effect, owned closure, callback child ID, receiver
and argument graphs, and global arrival order. Append and readback must complete
before the child enters the live queue. A duplicate is accepted only when all
those bytes match. Recovery validates the full chain and all owner, closure,
graph, and ordering evidence before staging any child. Recovery never invokes
the native adapter.

The child is resumed from its saved selected state or admitted once from its
durable arrival. Its completion remains separately queryable with
`callbackOutcome`. The parent intent stays uncertain until the adapter's own
continuation recovery produces an externally evidenced result and calls
`reconcile`; the runtime does not infer that result from the guest callback
alone. This preserves throw/return ordering without duplicating external work.

## Acceptance controls

- Interrupt after durable callback arrival but before child admission; restore
  admits the same child once and does not repeat the adapter call.
- Interrupt while the child is running; restore continues its selected
  controller state without repeating committed guest work.
- Recover both a guest return and guest throw and compare the exact tagged
  completion and parent settlement ordering.
- Reject a changed parent effect, closure identity, owner binding, input graph,
  receiver, prefix, arrival order, or callback completion.
- Reconcile a parent only with explicit external evidence; confirm that a
  restored uncertain intent cannot be dispatched again.
- Exercise reentrant callbacks and callback results containing owned graphs.

Until these controls pass for the typed arrival journal and adapter-owned
continuation protocol, general durable return-value callback recovery remains
unsupported. The `callbackOutcome` read path alone does not close that gate.
