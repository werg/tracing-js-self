# Ordinary data Proxy protocol

`ordinary-data-proxy/1` is the bounded shared-state protocol for Proxy allocation,
synchronous `get`, `set`, `has` and `deleteProperty` operations, revocation, and
their retained call scopes. A Proxy keeps its target and handler identities; it
does not copy target properties into independent storage. The separate
`proxy-reflection/1` profile covers seven reflective operations listed below.

## Records

All records use the canonical `protocol ` line prefix. Fields below omit `kind`.
Each record has the exact listed shape; `proxy.has` may additionally carry `id`
when it resumes a selected `has` GetMethod continuation.

| Record | Fields after `kind` | Checked behavior |
| --- | --- | --- |
| `proxy.create` | `name, target, handler` | Allocate a fresh Proxy over published target and handler identities. |
| `proxy.revocable` | `proxy, revoke, result, target, handler` | Allocate the Proxy, stable revoker and wrapper object from one retained event. |
| `proxy.revoke` | `object` | Clear the retained target and handler slots; repeated revocation is idempotent. |
| `proxy.getMethod.begin` | `id, operation, object, target, handler, receiver, key, child, getter` | Retain a synchronous getter selected for the handler's `has` method. |
| `proxy.getMethod.finish` | `id, completion` | Retain the getter's exact return or thrown completion before continuing GetMethod. |
| `proxy.revoked.fault` | `object, operation, error` | Allocate the operation-specific TypeError from a revoked Proxy state. |
| `proxy.get` | `object, key, result, route` | Check the getter result against the retained route and live target invariant. |
| `proxy.set` | `object, key, value, success, route` | Check assignment success and target effects on the retained route. |
| `proxy.has` | `object, key, result, route`; optional `id` | Check the Boolean membership result and the retained route/GetMethod continuation. |
| `proxy.delete` | `object, key, success, route` | Check deletion success against the live target and retained route. |
| `proxy.get.call` | `id, object, owner, receiver, key, child, route` | Call the retained get trap with target, key and original Proxy receiver. |
| `proxy.set.call` | `id, object, owner, receiver, key, value, child, strict, route` | Call the retained set trap with target, key, value and original Proxy receiver. |
| `proxy.has.call` | `id, object, owner, receiver, key, child, route` | Call the retained has trap with target and key. |
| `proxy.delete.call` | `id, object, owner, receiver, key, child, strict, route` | Call the retained deleteProperty trap with target and key. |
| `proxy.delete.fault` | `object, key, error, route` | Derive the direct strict-delete TypeError when the trap is absent and the live target property is nonconfigurable. |
| `proxy.fault` | `id, error` | Derive an operation fault from the retained trap completion and live target state. |
| `proxy.finish` | `id, completion` | Consume the exact callback completion and check the live operation result or invariant. |

A Proxy heap node retains exactly its kind, target, handler and empty own-property
map. Revocation clears its target and handler slots; the ordinary wrapper and
revoker retain their own identities. Target and handler effects remain in the
authoritative shared heap, so writes through aliases are visible through the
Proxy.

## Retained calls, routes and faults

Targets and handlers are ordinarily bounded objects. The get, set, has and
deleteProperty traps can be selected as synchronous owned closures. The has
GetMethod path also retains an accessor getter when it returns a supported
synchronous callable; its receiver, return/throw completion, mutation effects
and any revocation are checked before the selected trap proceeds. Other
accessor-based trap selection is not implied by that extension.

Transparent nested routes are supported when outer Proxy links have an absent
or null trap for the operation and forwarding reaches at most one active inner
trap. The retained route identifies the original Proxy, every transparent
outer link and the selected inner owner. Chains requiring multiple active trap
calls or composed nested target-invariant dispatch remain outside this profile.

The call state retains the selected callback, caller and child frames, route,
target/handler, arguments, effective receiver and strictness. Shared call
validation binds source identity, capture aliases, arguments and receiver.
Checkpoint restore checks the complete route and call frame. A changed handler
does not replace a selected callback; the matching finish or fault record must
consume that completion before another operation proceeds.

Faults are operation-derived. Source-qualified cases include revoked
get/set/has/deleteProperty operations, strict false set/delete results, direct
strict delete with no active trap, and selected live-target has/delete
invariants. Get/set invariant faults remain outside source admission until
qualified by their own source evidence. Trap-thrown guest values keep their
identity. These bounded records do not license a throw solely because a claim
says an operation failed.

## Proxy reflection

`proxy-reflection/1` retains separate call/direct/finish/fault records for
`getPrototypeOf`, `setPrototypeOf`, `isExtensible`, `preventExtensions`,
`getOwnPropertyDescriptor`, `ownKeys` and `defineProperty`.

| Record | Fields after kind | Checked behavior |
| --- | --- | --- |
| `proxy.reflect.call` | `id, object, operation, caller, arguments, child, route, descriptorObject` | Retain the selected reflection callback and descriptor conversion state. |
| `proxy.reflect.direct` | `object, operation, caller, arguments, result, route` | Check direct forwarding through the retained target route. |
| `proxy.reflect.finish` | `id, completion` | Check the exact callback completion and post-callback target state. |
| `proxy.reflect.fault` | `id, error` | Allocate the derived reflection invariant TypeError. |

It checks the caller form, arguments, selected trap, target effects, descriptor/list values
and the corresponding Proxy invariant after callback effects. Callback frames
retain the exact ToPropertyDescriptor result for defineProperty. Descriptor and
key-list objects whose required property reads invoke unqualified getters are
refused; an arbitrary reflection trap is not accepted merely because it returns
the expected scalar.

## Source and independent metadata

`ordinary-data-proxy-source/1` binds `new Proxy` and `Proxy.revocable`
allocations to original source, target/handler identities and the public heap.
It qualifies synchronous get/set/has/deleteProperty operations, the selected
has-getter continuation, transparent nested routes, revocation and the bounded
operation-derived faults above. It retains compact source work around those
boundaries and checks effect order, receiver, key conversion, aliases and
partial effects.

The native metadata adapter registers only Proxy values and revokers created at
an inventoried source allocation. A private handler observer lets native Proxy
select the actual trap and apply its algorithm without replacing the guest
target or handler. It tracks the original target/handler, wrapper and stable
revoker identities, plus revoked state; unregistered Proxies are refused before
any trap or unrelated metadata adapter runs. The observer records the native
trap receiver and arguments and never performs an internal method on the Proxy
itself.

Source tests compare original execution, operations, branches, completions and
identity/descriptor snapshots. They cover has/delete ordering, retained getter
selection, receiver preservation, transparent nested routes, revocation,
operation-derived errors and live target changes.
`test/semantic-protocol-proxy-source-v8.test.js` and
`test/semantic-protocol-proxy-reflection-source-v8.test.js` are the focused
source suites. Independent native-consumer admission remains a separate gate.

Arrays, custom prototypes, accessor targets, handler accessors outside the
bounded has GetMethod path, callable Proxy targets and apply/construct trap
behavior, asynchronous or generator traps, and nested routes with multiple
active trap calls or composed invariant dispatch remain outside these source
profiles. The seven operations in proxy-reflection/1 do not imply support for
every exotic Proxy behavior.
