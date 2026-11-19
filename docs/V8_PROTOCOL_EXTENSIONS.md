# V8 protocol extension interfaces

Three separate static registries preserve the independent worker boundary:
`protocol-source-extensions-v8.js`, `protocol-machine-extensions-v8.js`, and
`protocol-observation-extensions-v8.js`. The last contains metadata and source
observers only and cannot import the owned runtime or public evaluator. The
`protocol-extensions-v8.js` facade is for administration; execution paths import
their specific registry. Registering a source,
observation, or machine adapter is a reviewed code change, accompanied by an
explicit public operation domain and an independent native implementation.
An artifact or model response cannot install an adapter. Empty registries retain
the Symbol/property profile and its existing public targets and contexts.

## Source projection adapters

`PROTOCOL_SOURCE_ADAPTERS_V8` contains objects or factories
`({bundle, source}) => adapter`. Every used adapter has a distinct versioned `id`.
The compiler records the sorted used IDs. A projection using extensions has
profile `protocol-source-extensions/1`; its source artifact records
`compiler.extensions`, and the outer evidence records `protocolExtensions`.
Fresh source rechecking requires the same registered extensions and exact claims.

Optional hooks are:

| Hook | Meaning |
| --- | --- |
| `syntax(node)` | Admit an otherwise refused source AST form. |
| `program(program)` | Admit otherwise refused function-program metadata. |
| `functionDefinition(instruction, inventory)` | Supply `{code?, node}` for an exact owned source function definition. |
| `heapFields(node)` | Return the additional allowed field names, or `null` when this adapter does not own this node. |
| `frameFields(frame)` | Return additional continuation field names, or `null`. |
| `setup(ctx)` | Initialize adapter-local source mappings before entry bindings. |
| `allocate(ctx, node, event)` | Publish a node with checked operations; return true when handled. |
| `event(ctx, event, normalizedRow)` | Handle an owned event with checked operations; return true when handled. |
| `completeFrame(ctx, change, event)` | Handle a completed/thrown frame before default completion projection. |
| `checkHeap(ctx, node)` | Compare all adapter-owned state against the public controller; must return true. |
| `checkFrame(ctx, frame, event)` | Compare all adapter-owned continuation state; must return true. |

Declaring heap or frame fields requires its corresponding complete comparison.
Ordinary heap descriptor/prototype/value checks still run after extension checks.
Unknown heap kinds require an adapter that compares the complete representation.
An event adapter consumes the generic binding/operation handler, so it must emit
any corresponding cell updates itself. Completing a frame is a separate hook.
Unknown operations, undeclared metadata, and unprojected heap mutations refuse.

The context exposes `bundle`, `source`, `inventory`, `state`/`beforeState` (the
owned state before the event), `controller`, `claims`, and `extensionState` Map.
It also exposes:

- `emit(record, event, rule, {detail=false})`, which validates and executes every
  claim before recording it; no adapter can append a trusted state snapshot.
- `bind`, `tag`, `cell`, `frame`, `codeFor`, `publish`, `baseAllocate`,
  `baseCheckHeap`, `key`, `descriptor`, `prototype`, `orderedKeys`.
- `functionCodes`, `functionNodes`, `published`, `pendingAccessors`,
  `markPublished(id)`, `publicInvocation`, and `getOwnedFrame(id)`.
- `refuse`, `copy`, and `eq`.

`checkHeap` receives the post-transition node explicitly. The owned context state
advances only after all public transitions and comparisons for that event.
New public record kinds must also be declared in the codec and machine registry;
source hooks alone do not admit them.

## Independent metadata adapters

`PROTOCOL_METADATA_ADAPTERS_V8` contains objects or factories
`({side, bundle?}) => adapter`, where `side` is `native` or `owned`.
Adapters can implement `nativeNode(value, ctx)` and `ownedNode(tag, ctx)`.
Return `null` to defer to the next adapter and ordinary metadata inspection.
The native observer rejects Proxies before calling any adapter.

A handled node has this private observation shape:

```js
{
  kind,
  prototype, // explicit intrinsic name, null, or native object / owned ref tag
  extensible,
  properties: [{key, descriptor}],
  annotations: [{name, values: [/* native values or owned tags */], data: {}}]
}
```

`annotations` is optional. Keys and data/accessor descriptor values use raw native
values in the independent process and owned tags in the teacher observer. The
core maps every reference and Symbol through the same canonical observation
identities, including annotation values. Annotation `data` must be plain,
canonical JSON; accessor properties, Proxies, cycles and hidden non-JSON values
are rejected without evaluating getters. Observations are private evidence,
never public targets.

`ctx.defaultNode(value, {includeFunctions:true})` performs descriptor-only ordinary
inspection, including function own properties when explicitly requested.
Unextended functions remain identity leaves, and owned function own-state is
refused unless an adapter handles it. Native context also supplies
`intrinsicPrototype(value)`. Owned context supplies `bundle` and a live `state`
getter. Both expose `fail(message)`.

## Source-assisted metadata observation

`PROTOCOL_OBSERVATION_ADAPTERS_V8` contains objects or factories
`({source, mode, side, bundle}) => adapter`. An adapter provides:

```js
{
  id,
  instrument(alreadyInstrumentedSource),
  globals: {__tracingProtocolRegister: trustedObserverFunction},
  metadataAdapter: {nativeNode, ownedNode}
}
```

These factories run only in completion-observation mode. Original, operation,
and branch executions retain their original instrumentation paths. The
extension instrumentation runs **after** ordinary completion instrumentation,
so inserted registration statements do not create extra source completion
sites. Reserved observer globals must start `__tracingProtocol` and must be
distinct. They cannot replace operation, branch, completion, argument, or result
hooks. Source programs are already forbidden from naming the reserved namespace.

This interface permits lexical private-field readers or backing-memory observers
without adding guest object properties. Each extension still has to prove that
its observer does not invoke guest getters/methods, and that the source gate
rejects a teacher metadata mutation with an unchanged final scalar result.

## Public machine adapters

`PROTOCOL_MACHINE_ADAPTERS_V8` contains statically pinned objects:

```js
{
  id,
  recordFields, // exact kind -> field-name array, cannot override a base kind
  validateRecord(record, {value}), // true only for a valid declared record
  applyRecord(controller, record, api), // true after executing its checked meaning
  stateField, // optional; initialized to null in every protocol state
  restoreState(controller, snapshotOrNull, api), // must return {valid:true}
  reservedIdentities(controller), // optional extra identities, e.g. private brands
  hasRichState(node), // optional; excludes the node from ordinary compact/detail access
  assertNext(controller, record, api), // optional, true after continuation checks
  assertCall(controller, callee, internalOptions, api), // optional, true after capability checks
  hasSourceCallable(source, code) // optional exact source inventory for synthetic callables
}
```

The codec validates a record's exact data fields before calling its validator.
The machine executes each operation on a staged copy of the same controller
heap, cells, receiver, capture aliases and stack; a failure commits nothing.
`assertNext` runs before both protocol and detailed transitions, preventing a
pending constructor or iterator continuation from being skipped. `assertCall`
also runs for accessor calls and internal component calls. Its options are an
internal interface only: no public record can inject a construction capability.
`hasSourceCallable` supplements ordinary source function membership for explicit
class constructor or field-initializer identities. It must parse the immutable
source and check the exact declared code identity; it cannot consult teacher
archives or treat an arbitrary code string as an executable function.

`PROTOCOL_MACHINE_API_V8` supplies the existing raw operations, whose controller
argument is explicit: `require`, `fail`, `copy`, `eq`, `state`, `known`,
`knownKey`, `heapNode`, `ownDescriptor`, `installDescriptor`, `order`, `fresh`,
`call`, `allocate`, `setLocal`, and `truthy`. `heapNode` deliberately accepts only
ordinary objects, arrays and owned closures. A specialized memory or iterator
component validates its own heap kinds before accessing them.

An adapter with a `stateField` must validate its non-null snapshot. Null state
cannot accompany heap nodes for which that adapter reports rich state.
Adapters without a state field still validate their heap representation during
restore. All extension-reserved identities share the object/Symbol namespace;
duplicates across extensions are rejected. Unknown heap kinds cannot be silently
restored. The independent source worker's static dependency graph is tested to
exclude source compilers, machine registries, and public protocol evaluators.

Registering a nonempty state extension changes activated protocol contexts even
before its first operation (`construction:null`, for example). That requires a
new pinned contract digest, regenerated fixtures, and native consumer parity.
An empty registry leaves the existing Symbol/profile artifacts unchanged.
