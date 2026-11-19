# V8 protocol extension interfaces

`protocol-extensions-v8.js` is a static producer registry. Registering a source,
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
