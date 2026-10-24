# Bounded browser VM entry

The package root resolves to `src/browser.js` under the `browser` export
condition; the explicit `tracing-js-self/browser` entry is also available.
The browser entry exposes `createRuntime`, `encode`, `decode` and
`causalPrefix`. It deliberately does **not** export the Node-only
`validateBundle`, `replayExact`, native-service driver, retained sessions or
natlang bridge.

```js
import {createRuntime} from 'tracing-js-self/browser';
const runtime=createRuntime({maxSteps:10000});
runtime.start('let answer=2+3;');
const progress=runtime.drive();
const candidate=runtime.exportRun();
// Send candidate to a Node validator/replayer before admitting training data.
```

The browser import path uses the pinned owned guest bytecode interpreter and
Acorn grammar; it does **not** execute guest text with `eval` or
`Function`. The generic VM's native adapter registry is replaced by a frozen,
non-reassignable empty record. Unlike Node, browsers cannot reliably detect
arbitrary transparent JavaScript Proxy objects: **host object or array entry
arguments are rejected** before traversing their properties. Primitive
arguments remain supported. Objects created inside the guest are owned and may
be traced. No Node or browser APIs are installed in the guest realm; journaled
native effects, browser events, timers tied to the host clock, module loading,
DOM, worker, package resolution, host callbacks and Promise integration are
not supported by this entry. Guest virtual timer semantics are distinct from
native browser scheduling.

The Node executable and original package entry continue to use
`node:util.types.isProxy` for ordinary-data graph imports. Browser conditional
resolution is exercised by a Node `--conditions=browser` smoke test; this is
a module-graph/entry smoke test, **not** WPT, browser engine conformance, a
browser-bundler integration matrix, or a production natlang realm.
Every candidate archive still requires independent server-side structural
validation, exact replay, conformance and training admission.
