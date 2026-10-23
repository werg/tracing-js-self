# Bounded synchronous JS module facade

`tracing-js-self/evaluated-module-facade` provides synchronous host-callable wrappers for a fully supplied, deterministic subset of TypeScript/ESM modules. Every call recreates the owned interpreter's prior invocation history, validates and exactly replays the resulting semantic archive, and reconciles ordinary returned data aliases before exposing the result.

```js
import {createBoundedModuleFacade} from 'tracing-js-self/evaluated-module-facade';
const module=createBoundedModuleFacade({
  modules:{'main.ts':'export let n=0; export function add(x:number){n+=x;return n;}'},
  entryModule:'main.ts',exportNames:['add']
});
console.log(module.exports.add(2)); // 2
console.log(module.exports.add(3)); // 5
const archive=module.session.lastArchive;
const checkpoint=module.session.snapshot();
module.close();
```

Only named exports selected by the host are exposed. Arguments must be dense, primitive, owned-serializable values. A maximum of 32 sequential calls and the module-session step budget apply. Failed invocations do not commit. The facade's JavaScript function wrappers are **host functions**, not transferable guest functions or executable native callbacks; passing them back into the owned VM is refused. Synchrony requires all guest Promise work to settle without external effects. Source initialization, live exports, snapshot/restore and host-visible object identities follow the bounded evaluated-module-session contract.

**This is not natlang's production callable-folder `setModuleRealm` seam.** It cannot interpret natlang-generated CommonJS package imports, `require`, `__natlang`, `nl`, `iterateOn`, arbitrary native callbacks, Node/browser resource handles or nested guest-to-host reentry. It is a deliberate no-fallback extension to the separately supported bounded ESM graph.
