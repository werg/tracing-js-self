# Bounded native Node service transport

`tracing-js-self/native` exposes `executeWithNativeServices`. This is a
transport layer around the owned bytecode machine, **not** Node/JavaScript
execution fallback or complete native host integration.

```js
import {executeWithNativeServices} from 'tracing-js-self/native';
const {progress,bundle}=await executeWithNativeServices({
  text:"async function work(){let value=await host.readAsync('A');host.store('answer',value+1);}work();",
  services:{
    'demo.readAsync':async ({args,signal})=>readFromService(args[0],signal),
    'demo.store':({args})=>save(args[0],args[1])
  }
});
if(progress.kind!=='terminated')throw new Error(progress.kind);
```

### Strict owned function-entry transport

The same driver can execute a TypeScript-lowered, Acorn-validated strict
function bundle instead of the legacy bounded script:

```js
const {progress,bundle,runtime} = await executeWithNativeServices({
  entry:{
    text:'"use strict"; async function entry(self){return (await host.readAsync("k"))+self.base;}',
    functionName:'entry',url:'app://entry.js',args:[{base:2}]
  },
  services:{'demo.readAsync':async ()=>5}
});
// progress.kind === 'terminated'; guest root promise is fulfilled with 7.
```

The `host` binding is granted **only** to this explicit native-driver entry.
Ordinary training entries lack the host binding; no arbitrary native method
is exposed by a property read. The exact replay reconstructs this capability
from the archived initial state and verifies every committed effect and input.
The entry arguments must be portable owned data graphs, subject to the same
bounded graph codec and strict TypeScript/ES2022 grammar. Native resource
handles, arbitrary `require` and unjournaled host callbacks are not exported.

The only allowed operation names remain `demo.readAsync`, `demo.readNumber`
and `demo.store`, with the existing versioned `host-request/1` and canonical
JSON argument codec. Native handlers receive frozen, materialized JSON argument
trees and a frozen request, not guest object handles. Their primitive return
values are converted to owned input tokens. Native rejections and nonprimitive
results become guest-visible abrupt completions with a string reason.

The driver dispatches each committed effect once, records service settlement
as `external.input.arrive`, separately records `external.input.deliver`, then
resumes the owned guest interpreter. Asynchronous services can complete out
of dispatch order. The completed archive is structurally validated and exact-
replayed without adapters (native services are not called during replay).

An `AbortSignal` can interrupt the wait but does **not** magically cancel an
underlying native resource: services must honor the signal themselves. This
driver does not itself implement callable-folder module realms, general
native callback reentry, arbitrary host objects,
streaming, crash recovery or physical native activation ownership. The opt-in natlang adapter can synchronize data-only `__live` graphs after
replay; the native driver remains independent of arbitrary live host objects.
Native promises **never** become guest frames, promises or continuations.
