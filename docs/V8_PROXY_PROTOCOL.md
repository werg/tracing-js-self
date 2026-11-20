# Ordinary data Proxy protocol

`ordinary-data-proxy/1` is a bounded shared-state component for Proxy allocation,
data access and synchronous owned get/set traps. A proxy retains separate target and handler
references; it does not copy target properties into independent storage.

| Record | Fields after `kind` | Checked behavior |
| --- | --- | --- |
| `proxy.create` | `name`, `target`, `handler` | Allocate a fresh Proxy identity over already published object identities. |
| `proxy.get` | `object`, `key`, `result` | Read the current target data through a handler with no active traps. |
| `proxy.set` | `object`, `key`, `value`, `success` | Apply the shared ordinary assignment operation to the same target. |
| `proxy.get.call` | `id`, `object`, `key`, `child` | Select the live getter trap and enter its shared call frame with target, key and Proxy receiver. |
| `proxy.set.call` | `id`, `object`, `key`, `value`, `child` | Select the live setter trap with the additional assignment value argument. |
| `proxy.finish` | `id`, `completion` | Consume exactly the returned callback, check the live target invariant, and preserve the property completion value. |

Target and handler are ordinary objects with ordinary or null prototypes and
data descriptors. Get/set traps may be owned closures; all other recognized
traps must be absent, undefined or null.
The same checks run at allocation, each operation and checkpoint validation.
Arrays, nested proxies, custom prototypes, accessors, callable proxies and
revocation require their own explicit protocol extensions.

Public Proxy nodes have exactly `kind`, `target`, `handler` and an empty
`properties` map. Their target's descriptors, values, extensibility and aliases
remain in the existing authoritative heap. A write through either alias is
visible through the other. A proxy value stored in its target preserves the
proxy's own identity. False read or assignment claims are rejected before
the staged state is committed.

`proxyCalls` retains the selected callback, caller/child frames, target/handler
identities, property key and assignment operand. The shared call machinery
owns function source identity, capture aliases, arguments and effective receiver;
arrow functions keep their lexical receiver. A changed handler does not replace
an already selected callback. Once it returns, a matching `proxy.finish` is
mandatory before other records or compact work can proceed. Checkpoint restore
validates the complete retained call against the shared stack and argument cells.

Get results and successful set operands must satisfy nonconfigurable,
nonwritable target data using SameValue. These checks inspect the live target
after callback effects. A thrown callback retains its thrown value. A false
setter result and invariant violations need an explicit abrupt completion
extension and are refused by this public component. The owned runtime separately
models those failures as caller TypeErrors after the callback has returned.

Component tests compare native Proxy alias behavior, check nonwritable and
nonextensible targets, and reject invalid traps, accessor targets, invented
proxy storage and forged target identities. They also exercise nested callbacks,
live trap replacement, arrow receivers, thrown values and exact frozen-data
invariants, including `-0`, `NaN` and reference identity.

## Source and independent metadata

`ordinary-data-proxy-source/1` binds the records to direct owned `new Proxy`
allocations and get/set events. It checks the allocated target and handler
identities and the complete retained Proxy node after every owned transition.
Trap entries additionally bind the selected source code, closure environment,
effective receiver and declared parameter values to the native call argument
order. The source adapter checks retained target/key/value and caller/child
identities until the callback completes. Qualified source traces retain compact
computations around the Proxy boundary, Symbol keys, target-alias mutations,
null/undefined traps, live handler replacement and nested trap callbacks.
The independent assignment observer reads committed target storage, so an
unchanged assignment-expression result cannot hide a dropped target write.
For a setter trap, the assignment expression keeps its original right-hand
value while independent metadata checks the actual effects on target storage.

The native metadata adapter registers only actual source `new Proxy` results
with their original target and handler in a private WeakMap. A private handler
observer lets native Proxy select each operation and apply its invariants. It
calls each selected source trap with the original handler as receiver and the
actual native target, key, value and source Proxy arguments. Absent get/set traps
forward through native `Reflect.get`/`Reflect.set` with the same receiver. The
target and source handler remain unchanged, and guest code cannot access the
private observation handler. The shared observer dispatcher composes callback
invocations with other declared protocol observers.

At every metadata snapshot the adapter checks the ordinary-data and bounded
trap profile, derives visible descriptors from the
actual target, and records distinct target/handler identities. It performs no
get, ownKeys, getPrototypeOf or other internal method on the Proxy itself.
Unregistered Proxies fail before any trap or unrelated metadata adapter runs.
Separate ordered receipts cover creation, live trap selection, callback method,
receiver and argument identities, and returned or thrown values. The owned
receipt collector reads raw journal frames and environments independently of
the public component and source compiler; it rejects a different callback
source, closure, receiver or declared argument even when the final scalar agrees.

Source tests independently compare original execution, operations, branches,
completions and identity/descriptor snapshots. They reject a target-swapping
teacher mutation despite an identical scalar outcome and verify exact JSON
checkpoint resumption during a live setter without repeating target writes.
Tests cover method replacement order, nested get calls, lexical receivers,
Number conversion inside traps and scalar thrown values. Arrays, custom
prototypes, accessor targets or handlers, proxies used directly as targets,
callable or revoked proxies, async/generator traps, traps other than get/set,
false setters and invariant-triggered TypeErrors remain explicit source refusals.
Independent native-consumer admission is a separate gate and is not implied
by these source tests.
