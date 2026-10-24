# Bounded virtual Int32 shared-memory agents

`tracing-js-self/agent-model` provides a deterministic **scripted agent**
model with shared signed Int32 cells and a serializable operation log. It does
not launch workers, allocate real `SharedArrayBuffer`, evaluate arbitrary
guest JS or implement Test262's `$262.agent` host harness.

```js
import {executeBoundedAgents,verifyBoundedAgents} from 'tracing-js-self/agent-model';
const trace=executeBoundedAgents({
  buffers:[{id:'memory',length:1,initial:[0]}],
  agents:[
    {id:'a',steps:[{op:'add',buffer:'memory',index:0,value:1}]},
    {id:'b',steps:[{op:'add',buffer:'memory',index:0,value:1}]}
  ],
  schedule:['b','a']
});
verifyBoundedAgents(trace); // {valid:true,events:2}
console.log(trace.buffers.memory); // [2]
```

The model supports `load`, `store`, `add`, `sub`, `and`, `or`,
`xor`, `exchange`, `compareExchange`, `wait` and `notify`. Int32
overflow wraps, read-modify-write returns the old cell value, and
`compareExchange` writes only when the expected value matches.

Waiters queue FIFO per shared location. A wait with the wrong expected
value reports `not-equal` immediately. Zero timeout reports `timed-out`;
other timeouts use a deterministic virtual clock when no agent can run.
A permanent wait produces `blocked`, not a false success.

An explicit `schedule` fixes a prefix of runnable agent turns; the
remaining turns use deterministic round-robin. Events include agent IDs,
program counters, virtual clock, before/after cell values, returns and
awakenings. `verifyBoundedAgents` recomputes every event and final cell from
the original declaration. It is not an independent ECMAScript oracle.

Limits: 8 agents, 4 buffers, 64 Int32 cells per buffer, 1,024 atomic steps,
2,048 total logged events, and 100,000 virtual milliseconds per wait.
Inputs are inspected as plain data (no proxies, getters, sparse arrays or
unknown operations).

This is an isolated **diagnostic model**, not an owned execution of JavaScript
agent source. Real worker parallelism, `Atomics.waitAsync`, message ports,
nondeterministic memory ordering, non-atomic accesses, `SharedArrayBuffer`
aliasing, `$262.agent` and host scheduling integration remain out of scope.
It does not produce locally verified JS traces or admit training episodes.
