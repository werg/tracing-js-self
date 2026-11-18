# Actual semantic target gallery

Actual target inspection; no model-learning or native-qualification claim.

| Case | Categories | Generated records | Target UTF-8 bytes | Token count |
| --- | --- | ---: | ---: | ---: |
| compound-pure | expressions | 7 | 601 | unavailable |
| branch-1 | branches, async-observations | 10 | 960 | unavailable |
| object-alias | object-construction, aliases | 10 | 642 | unavailable |
| pure-helper | helper-calls | 6 | 423 | unavailable |
| dense-loop | loops | 29 | 2386 | unavailable |
| throw-finally | throws, finally | 7 | 631 | unavailable |
| counter-0 | async-observations | 11 | 1018 | unavailable |
| rejection-finally | throws, finally, async-observations | 11 | 1072 | unavailable |
| callback-captured-write | callbacks, captured-state | 20 | 1857 | unavailable |
| persistent-external-trigger | callbacks, retained-state | 28 | 2529 | unavailable |
| redundant-cell-write | local-state | 6 | 226 | unavailable |

Byte counts exclude transport framing and observed context. Token counts, when available, encode each line independently; they do not measure native recurrent context or transport fragments.

## compound-pure

```js
"use strict";function run(a,b,c,d){return (a+b)*(c+d)+1;}
```

Qualification: `locally_verified`. Private certificates, source checks and native admission are separate authorities; this gallery grants none.

### Exact generated targets

```text
bind {"name":"a","value":["num",1]}
bind {"name":"b","value":["num",2]}
bind {"name":"c","value":["num",3]}
bind {"name":"d","value":["num",4]}
compute {"expr":{"op":"binary","operator":"+","left":{"op":"binary","operator":"*","left":{"op":"binary","operator":"+","left":{"op":"local","name":"a"},"right":{"op":"local","name":"b"}},"right":{"op":"binary","operator":"+","left":{"op":"local","name":"c"},"right":{"op":"local","name":"d"}}},"right":{"op":"literal","value":["num",1]}},"result":["num",22],"invocation":"invocation1"}
return {"value":["num",22],"invocation":"invocation1"}
end {"kind":"return"}
```

### Readable execution and observation boundaries

- 1 observed: program 
- 2 observed: invocation 
- 3 generated: bind a = 1 — The named source cell has the stated value at this step.
- 4 generated: bind b = 2 — The named source cell has the stated value at this step.
- 5 generated: bind c = 3 — The named source cell has the stated value at this step.
- 6 generated: bind d = 4 — The named source cell has the stated value at this step.
- 7 generated: compute (((a + b) * (c + d)) + 1) -> 22 — The stated expression evaluates to the result in committed public state.
- 8 generated: return 22 — The guest invocation returns the stated value.
- 9 generated: end return — The invocation has the stated completion and no blocking pending work.

### Byte and field accounting

```json
{
  "generatedRecords": 7,
  "generatedBytes": 601,
  "recordKindBytes": 39,
  "punctuationBytes": 21,
  "keyBytes": 117,
  "valueBytes": 424,
  "generatedTokens": null,
  "transportFragments": null,
  "observedRows": 2,
  "kinds": {
    "bind": 4,
    "compute": 1,
    "return": 1,
    "end": 1
  },
  "topLevelValueBytes": {
    "name": 12,
    "value": 46,
    "expr": 322,
    "result": 10,
    "invocation": 26,
    "kind": 8
  },
  "topLevelKeyOccurrences": {
    "name": 4,
    "value": 5,
    "expr": 1,
    "result": 1,
    "invocation": 2,
    "kind": 1
  },
  "distinctCells": 4,
  "exactSourceNamedBindingRecords": 4,
  "repeatedEqualCellBindingRecords": 0,
  "overheadDefinition": "Record kind, top-level keys and punctuation are byte accounting, not dispensable semantic overhead."
}
```

## branch-1

```js
"use strict";async function run(){const n=await host.readAsync("value");if(n>3){host.store("chosen",n);return n;}host.store("chosen",0);return 0;}
```

Qualification: `locally_verified`. Private certificates, source checks and native admission are separate authorities; this gallery grants none.

### Exact generated targets

```text
promise {"action":"create","promise":"p1"}
request {"effect":"e1","operation":"demo.readAsync","arguments":[["str","value"]],"invocation":"invocation1","site":{"start":48,"end":71},"payload":"[\"value\"]","promise":"p2"}
await {"promise":"p2","continuation":"continuation1","invocation":"invocation1","returnPromise":"p1"}
resume {"continuation":"continuation1","invocation":"invocation1","result":["num",8],"status":"fulfilled"}
bind {"name":"n","value":["num",8]}
choose {"expr":{"op":"binary","operator":">","left":{"op":"local","name":"n"},"right":{"op":"literal","value":["num",3]}},"decision":["bool",true],"path":"then","invocation":"invocation1"}
request {"effect":"e2","operation":"demo.store","arguments":[["str","chosen"],["num",8]],"invocation":"invocation1","site":{"start":80,"end":102},"payload":"[\"chosen\",8]"}
promise {"action":"resolve","promise":"p1","value":["num",8]}
return {"value":["ref","p1"],"invocation":"invocation1"}
end {"kind":"return"}
```

### Readable execution and observation boundaries

- 1 observed: program 
- 2 observed: invocation 
- 3 generated: create owned Promise &p1 — The stated owned Promise transition occurs.
- 4 generated: request e1 demo.readAsync("value") in invocation1 @48:71 -> Promise &p2 — The stated source call requests this external operation and arguments.
- 5 observed: dispatch 
- 6 generated: await Promise &p2; suspend invocation1 as continuation1; call returns owned Promise &p1 — The invocation suspends on this Promise with this continuation.
- 7 observed: observe e1 fulfilled 8 
- 8 generated: resume invocation1 via continuation1 with fulfilled 8 — The invocation resumes with the already observed settlement.
- 9 generated: bind n = 8 — The named source cell has the stated value at this step.
- 10 generated: choose (n > 3) = true -> then — The condition has the stated value and selects the stated path.
- 11 generated: request e2 demo.store("chosen", 8) in invocation1 @80:102 — The stated source call requests this external operation and arguments.
- 12 observed: dispatch 
- 13 observed: observe e2 fulfilled undefined 
- 14 generated: resolve Promise &p1 8 — The stated owned Promise transition occurs.
- 15 generated: return &p1 — The guest invocation returns the stated value.
- 16 generated: end return — The invocation has the stated completion and no blocking pending work.

### Byte and field accounting

```json
{
  "generatedRecords": 10,
  "generatedBytes": 960,
  "recordKindBytes": 68,
  "punctuationBytes": 45,
  "keyBytes": 363,
  "valueBytes": 484,
  "generatedTokens": null,
  "transportFragments": null,
  "observedRows": 6,
  "kinds": {
    "promise": 2,
    "request": 2,
    "await": 1,
    "resume": 1,
    "bind": 1,
    "choose": 1,
    "return": 1,
    "end": 1
  },
  "topLevelValueBytes": {
    "action": 17,
    "promise": 16,
    "effect": 8,
    "operation": 28,
    "arguments": 45,
    "invocation": 78,
    "site": 43,
    "payload": 29,
    "continuation": 30,
    "returnPromise": 4,
    "result": 9,
    "status": 11,
    "name": 3,
    "value": 30,
    "expr": 106,
    "decision": 13,
    "path": 6,
    "kind": 8
  },
  "topLevelKeyOccurrences": {
    "action": 2,
    "promise": 4,
    "effect": 2,
    "operation": 2,
    "arguments": 2,
    "invocation": 6,
    "site": 2,
    "payload": 2,
    "continuation": 2,
    "returnPromise": 1,
    "result": 1,
    "status": 1,
    "name": 1,
    "value": 3,
    "expr": 1,
    "decision": 1,
    "path": 1,
    "kind": 1
  },
  "distinctCells": 1,
  "exactSourceNamedBindingRecords": 1,
  "repeatedEqualCellBindingRecords": 0,
  "overheadDefinition": "Record kind, top-level keys and punctuation are byte accounting, not dispensable semantic overhead."
}
```

## object-alias

```js
"use strict";function run(){const box={n:2};const alias=box;alias.n=alias.n+1;return box.n;}
```

Qualification: `locally_verified`. Private certificates, source checks and native admission are separate authorities; this gallery grants none.

### Exact generated targets

```text
allocate {"name":"o2","kind":"object","properties":[]}
write {"object":"o2","key":"n","present":true,"value":["num",2]}
bind {"name":"box","value":["ref","o2"]}
bind {"name":"alias","value":["ref","o2"]}
read {"object":"o2","key":"n","present":true,"value":["num",2]}
compute {"expr":{"op":"binary","operator":"+","left":{"op":"literal","value":["num",2]},"right":{"op":"literal","value":["num",1]}},"result":["num",3],"invocation":"invocation1"}
write {"object":"o2","key":"n","present":true,"value":["num",3]}
read {"object":"o2","key":"n","present":true,"value":["num",3]}
return {"value":["num",3],"invocation":"invocation1"}
end {"kind":"return"}
```

### Readable execution and observation boundaries

- 1 observed: program 
- 2 observed: invocation 
- 3 generated: allocate &o2 object {} — A fresh identity with the stated kind and initial properties exists.
- 4 generated: write &o2["n"] = 2 — The named property changes to the stated presence and value.
- 5 generated: bind box = &o2 — The named source cell has the stated value at this step.
- 6 generated: bind alias = &o2 — The named source cell has the stated value at this step.
- 7 generated: read &o2["n"] -> 2 — The property has the stated presence and value at this step.
- 8 generated: compute (2 + 1) -> 3 — The stated expression evaluates to the result in committed public state.
- 9 generated: write &o2["n"] = 3 — The named property changes to the stated presence and value.
- 10 generated: read &o2["n"] -> 3 — The property has the stated presence and value at this step.
- 11 generated: return 3 — The guest invocation returns the stated value.
- 12 generated: end return — The invocation has the stated completion and no blocking pending work.

### Byte and field accounting

```json
{
  "generatedRecords": 10,
  "generatedBytes": 642,
  "recordKindBytes": 60,
  "punctuationBytes": 39,
  "keyBytes": 246,
  "valueBytes": 297,
  "generatedTokens": null,
  "transportFragments": null,
  "observedRows": 2,
  "kinds": {
    "allocate": 1,
    "write": 2,
    "bind": 2,
    "read": 2,
    "compute": 1,
    "return": 1,
    "end": 1
  },
  "topLevelValueBytes": {
    "name": 16,
    "kind": 16,
    "properties": 2,
    "object": 16,
    "key": 12,
    "present": 16,
    "value": 69,
    "expr": 115,
    "result": 9,
    "invocation": 26
  },
  "topLevelKeyOccurrences": {
    "name": 3,
    "kind": 2,
    "properties": 1,
    "object": 4,
    "key": 4,
    "present": 4,
    "value": 7,
    "expr": 1,
    "result": 1,
    "invocation": 2
  },
  "distinctCells": 2,
  "exactSourceNamedBindingRecords": 2,
  "repeatedEqualCellBindingRecords": 0,
  "overheadDefinition": "Record kind, top-level keys and punctuation are byte accounting, not dispensable semantic overhead."
}
```

## pure-helper

```js
"use strict";function increment(value){return value+1;}function run(n){return increment(n);}
```

Qualification: `locally_verified`. Private certificates, source checks and native admission are separate authorities; this gallery grants none.

### Exact generated targets

```text
bind {"name":"n","value":["num",4]}
call {"child":"guest1","callee":"increment","receiver":["undefined"],"arguments":[["num",4]]}
compute {"expr":{"op":"binary","operator":"+","left":{"op":"literal","value":["num",4]},"right":{"op":"literal","value":["num",1]}},"result":["num",5],"invocation":"guest1"}
return {"value":["num",5],"invocation":"guest1"}
return {"value":["num",5],"invocation":"invocation1"}
end {"kind":"return"}
```

### Readable execution and observation boundaries

- 1 observed: program 
- 2 observed: invocation 
- 3 generated: bind n = 4 — The named source cell has the stated value at this step.
- 4 generated: call increment(4) -> guest1 — The named guest call begins with the stated receiver and arguments.
- 5 generated: compute (4 + 1) -> 5 — The stated expression evaluates to the result in committed public state.
- 6 generated: return 5 — The guest invocation returns the stated value.
- 7 generated: return 5 — The guest invocation returns the stated value.
- 8 generated: end return — The invocation has the stated completion and no blocking pending work.

### Byte and field accounting

```json
{
  "generatedRecords": 6,
  "generatedBytes": 423,
  "recordKindBytes": 36,
  "punctuationBytes": 20,
  "keyBytes": 133,
  "valueBytes": 234,
  "generatedTokens": null,
  "transportFragments": null,
  "observedRows": 2,
  "kinds": {
    "bind": 1,
    "call": 1,
    "compute": 1,
    "return": 2,
    "end": 1
  },
  "topLevelValueBytes": {
    "name": 3,
    "value": 27,
    "child": 8,
    "callee": 11,
    "receiver": 13,
    "arguments": 11,
    "expr": 115,
    "result": 9,
    "invocation": 29,
    "kind": 8
  },
  "topLevelKeyOccurrences": {
    "name": 1,
    "value": 3,
    "child": 1,
    "callee": 1,
    "receiver": 1,
    "arguments": 1,
    "expr": 1,
    "result": 1,
    "invocation": 3,
    "kind": 1
  },
  "distinctCells": 1,
  "exactSourceNamedBindingRecords": 1,
  "repeatedEqualCellBindingRecords": 0,
  "overheadDefinition": "Record kind, top-level keys and punctuation are byte accounting, not dispensable semantic overhead."
}
```

## dense-loop

```js
"use strict";function run(xs){let total=0;for(let i=0;i<xs.length;i++){total+=xs[i];}return total;}
```

Qualification: `locally_verified`. Private certificates, source checks and native admission are separate authorities; this gallery grants none.

### Exact generated targets

```text
bind {"name":"xs","value":["ref","o2"]}
bind {"name":"total","value":["num",0]}
bind {"name":"i","value":["num",0]}
bind {"name":"i_1","value":["num",0],"from":"i"}
read {"object":"o2","key":"length","present":true,"value":["num",3]}
choose {"expr":{"op":"binary","operator":"<","left":{"op":"local","name":"i_1"},"right":{"op":"read","object":"o2","key":"length"}},"decision":["bool",true],"path":"then","invocation":"invocation1"}
read {"object":"o2","key":"0","present":true,"value":["num",2]}
compute {"expr":{"op":"binary","operator":"+","left":{"op":"local","name":"total"},"right":{"op":"literal","value":["num",2]}},"result":["num",2],"invocation":"invocation1"}
bind {"name":"total","value":["num",2]}
bind {"name":"i_2","value":["num",0],"from":"i_1"}
bind {"name":"i_2","value":["num",1]}
read {"object":"o2","key":"length","present":true,"value":["num",3]}
choose {"expr":{"op":"binary","operator":"<","left":{"op":"local","name":"i_2"},"right":{"op":"read","object":"o2","key":"length"}},"decision":["bool",true],"path":"then","invocation":"invocation1"}
read {"object":"o2","key":"1","present":true,"value":["num",3]}
compute {"expr":{"op":"binary","operator":"+","left":{"op":"local","name":"total"},"right":{"op":"literal","value":["num",3]}},"result":["num",5],"invocation":"invocation1"}
bind {"name":"total","value":["num",5]}
bind {"name":"i_3","value":["num",1],"from":"i_2"}
bind {"name":"i_3","value":["num",2]}
read {"object":"o2","key":"length","present":true,"value":["num",3]}
choose {"expr":{"op":"binary","operator":"<","left":{"op":"local","name":"i_3"},"right":{"op":"read","object":"o2","key":"length"}},"decision":["bool",true],"path":"then","invocation":"invocation1"}
read {"object":"o2","key":"2","present":true,"value":["num",4]}
compute {"expr":{"op":"binary","operator":"+","left":{"op":"local","name":"total"},"right":{"op":"literal","value":["num",4]}},"result":["num",9],"invocation":"invocation1"}
bind {"name":"total","value":["num",9]}
bind {"name":"i_4","value":["num",2],"from":"i_3"}
bind {"name":"i_4","value":["num",3]}
read {"object":"o2","key":"length","present":true,"value":["num",3]}
choose {"expr":{"op":"binary","operator":"<","left":{"op":"local","name":"i_4"},"right":{"op":"read","object":"o2","key":"length"}},"decision":["bool",false],"path":"else","invocation":"invocation1"}
return {"value":["num",9],"invocation":"invocation1"}
end {"kind":"return"}
```

### Readable execution and observation boundaries

- 1 observed: program 
- 2 observed: invocation 
- 3 generated: bind xs = &o2 — The named source cell has the stated value at this step.
- 4 generated: bind total = 0 — The named source cell has the stated value at this step.
- 5 generated: bind i = 0 — The named source cell has the stated value at this step.
- 6 generated: bind i_1 = 0 — The named source cell has the stated value at this step.
- 7 generated: read &o2["length"] -> 3 — The property has the stated presence and value at this step.
- 8 generated: choose (i_1 < &o2["length"]) = true -> then — The condition has the stated value and selects the stated path.
- 9 generated: read &o2["0"] -> 2 — The property has the stated presence and value at this step.
- 10 generated: compute (total + 2) -> 2 — The stated expression evaluates to the result in committed public state.
- 11 generated: bind total = 2 — The named source cell has the stated value at this step.
- 12 generated: bind i_2 = 0 — The named source cell has the stated value at this step.
- 13 generated: bind i_2 = 1 — The named source cell has the stated value at this step.
- 14 generated: read &o2["length"] -> 3 — The property has the stated presence and value at this step.
- 15 generated: choose (i_2 < &o2["length"]) = true -> then — The condition has the stated value and selects the stated path.
- 16 generated: read &o2["1"] -> 3 — The property has the stated presence and value at this step.
- 17 generated: compute (total + 3) -> 5 — The stated expression evaluates to the result in committed public state.
- 18 generated: bind total = 5 — The named source cell has the stated value at this step.
- 19 generated: bind i_3 = 1 — The named source cell has the stated value at this step.
- 20 generated: bind i_3 = 2 — The named source cell has the stated value at this step.
- 21 generated: read &o2["length"] -> 3 — The property has the stated presence and value at this step.
- 22 generated: choose (i_3 < &o2["length"]) = true -> then — The condition has the stated value and selects the stated path.
- 23 generated: read &o2["2"] -> 4 — The property has the stated presence and value at this step.
- 24 generated: compute (total + 4) -> 9 — The stated expression evaluates to the result in committed public state.
- 25 generated: bind total = 9 — The named source cell has the stated value at this step.
- 26 generated: bind i_4 = 2 — The named source cell has the stated value at this step.
- 27 generated: bind i_4 = 3 — The named source cell has the stated value at this step.
- 28 generated: read &o2["length"] -> 3 — The property has the stated presence and value at this step.
- 29 generated: choose (i_4 < &o2["length"]) = false -> else — The condition has the stated value and selects the stated path.
- 30 generated: return 9 — The guest invocation returns the stated value.
- 31 generated: end return — The invocation has the stated completion and no blocking pending work.

### Byte and field accounting

```json
{
  "generatedRecords": 29,
  "generatedBytes": 2386,
  "recordKindBytes": 163,
  "punctuationBytes": 115,
  "keyBytes": 721,
  "valueBytes": 1387,
  "generatedTokens": null,
  "transportFragments": null,
  "observedRows": 2,
  "kinds": {
    "bind": 13,
    "read": 7,
    "choose": 4,
    "compute": 3,
    "return": 1,
    "end": 1
  },
  "topLevelValueBytes": {
    "name": 70,
    "value": 192,
    "from": 18,
    "object": 28,
    "key": 41,
    "present": 28,
    "expr": 794,
    "decision": 53,
    "path": 24,
    "invocation": 104,
    "result": 27,
    "kind": 8
  },
  "topLevelKeyOccurrences": {
    "name": 13,
    "value": 21,
    "from": 4,
    "object": 7,
    "key": 7,
    "present": 7,
    "expr": 7,
    "decision": 4,
    "path": 4,
    "invocation": 8,
    "result": 3,
    "kind": 1
  },
  "distinctCells": 7,
  "exactSourceNamedBindingRecords": 6,
  "repeatedEqualCellBindingRecords": 0,
  "overheadDefinition": "Record kind, top-level keys and punctuation are byte accounting, not dispensable semantic overhead."
}
```

## throw-finally

```js
"use strict";function run(){let answer=0;try{throw 2;}catch(error){answer=error+1;}finally{answer=answer+4;}return answer;}
```

Qualification: `locally_verified`. Private certificates, source checks and native admission are separate authorities; this gallery grants none.

### Exact generated targets

```text
bind {"name":"answer","value":["num",0]}
transfer {"kind":"throw","value":["num",2],"handler":"catch-or-finally","invocation":"invocation1"}
bind {"name":"error","value":["num",2]}
compute {"expr":{"op":"binary","operator":"+","left":{"op":"local","name":"error"},"right":{"op":"literal","value":["num",1]}},"result":["num",3],"invocation":"invocation1","bind":"answer"}
compute {"expr":{"op":"binary","operator":"+","left":{"op":"local","name":"answer"},"right":{"op":"literal","value":["num",4]}},"result":["num",7],"invocation":"invocation1","bind":"answer"}
return {"value":["num",7],"invocation":"invocation1"}
end {"kind":"return"}
```

### Readable execution and observation boundaries

- 1 observed: program 
- 2 observed: invocation 
- 3 generated: bind answer = 0 — The named source cell has the stated value at this step.
- 4 generated: transfer throw 2 via catch-or-finally — The stated abrupt completion transfers to the stated handler.
- 5 generated: bind error = 2 — The named source cell has the stated value at this step.
- 6 generated: answer = (error + 1) -> 3 — The stated expression evaluates to the result in committed public state.
- 7 generated: answer = (answer + 4) -> 7 — The stated expression evaluates to the result in committed public state.
- 8 generated: return 7 — The guest invocation returns the stated value.
- 9 generated: end return — The invocation has the stated completion and no blocking pending work.

### Byte and field accounting

```json
{
  "generatedRecords": 7,
  "generatedBytes": 631,
  "recordKindBytes": 46,
  "punctuationBytes": 26,
  "keyBytes": 168,
  "valueBytes": 391,
  "generatedTokens": null,
  "transportFragments": null,
  "observedRows": 2,
  "kinds": {
    "bind": 2,
    "transfer": 1,
    "compute": 2,
    "return": 1,
    "end": 1
  },
  "topLevelValueBytes": {
    "name": 15,
    "value": 36,
    "kind": 15,
    "handler": 18,
    "invocation": 52,
    "expr": 221,
    "result": 18,
    "bind": 16
  },
  "topLevelKeyOccurrences": {
    "name": 2,
    "value": 4,
    "kind": 2,
    "handler": 1,
    "invocation": 4,
    "expr": 2,
    "result": 2,
    "bind": 2
  },
  "distinctCells": 2,
  "exactSourceNamedBindingRecords": 4,
  "repeatedEqualCellBindingRecords": 0,
  "overheadDefinition": "Record kind, top-level keys and punctuation are byte accounting, not dispensable semantic overhead."
}
```

## counter-0

```js
"use strict";async function run(key){const current=await host.readAsync(key);const next=current+1;host.store(key,next);return next;}
```

Qualification: `locally_verified`. Private certificates, source checks and native admission are separate authorities; this gallery grants none.

### Exact generated targets

```text
promise {"action":"create","promise":"p1"}
bind {"name":"key","value":["str","counter"]}
request {"effect":"e1","operation":"demo.readAsync","arguments":[["str","counter"]],"invocation":"invocation1","site":{"start":57,"end":76},"payload":"[\"counter\"]","promise":"p2"}
await {"promise":"p2","continuation":"continuation1","invocation":"invocation1","returnPromise":"p1"}
resume {"continuation":"continuation1","invocation":"invocation1","result":["num",7],"status":"fulfilled"}
bind {"name":"current","value":["num",7]}
compute {"expr":{"op":"binary","operator":"+","left":{"op":"local","name":"current"},"right":{"op":"literal","value":["num",1]}},"result":["num",8],"invocation":"invocation1","bind":"next"}
request {"effect":"e2","operation":"demo.store","arguments":[["str","counter"],["num",8]],"invocation":"invocation1","site":{"start":98,"end":118},"payload":"[\"counter\",8]"}
promise {"action":"resolve","promise":"p1","value":["num",8]}
return {"value":["ref","p1"],"invocation":"invocation1"}
end {"kind":"return"}
```

### Readable execution and observation boundaries

- 1 observed: program 
- 2 observed: invocation 
- 3 generated: create owned Promise &p1 — The stated owned Promise transition occurs.
- 4 generated: bind key = "counter" — The named source cell has the stated value at this step.
- 5 generated: request e1 demo.readAsync("counter") in invocation1 @57:76 -> Promise &p2 — The stated source call requests this external operation and arguments.
- 6 observed: dispatch 
- 7 generated: await Promise &p2; suspend invocation1 as continuation1; call returns owned Promise &p1 — The invocation suspends on this Promise with this continuation.
- 8 observed: observe e1 fulfilled 7 
- 9 generated: resume invocation1 via continuation1 with fulfilled 7 — The invocation resumes with the already observed settlement.
- 10 generated: bind current = 7 — The named source cell has the stated value at this step.
- 11 generated: next = (current + 1) -> 8 — The stated expression evaluates to the result in committed public state.
- 12 generated: request e2 demo.store("counter", 8) in invocation1 @98:118 — The stated source call requests this external operation and arguments.
- 13 observed: dispatch 
- 14 observed: observe e2 fulfilled undefined 
- 15 generated: resolve Promise &p1 8 — The stated owned Promise transition occurs.
- 16 generated: return &p1 — The guest invocation returns the stated value.
- 17 generated: end return — The invocation has the stated completion and no blocking pending work.

### Byte and field accounting

```json
{
  "generatedRecords": 11,
  "generatedBytes": 1018,
  "recordKindBytes": 74,
  "punctuationBytes": 48,
  "keyBytes": 376,
  "valueBytes": 520,
  "generatedTokens": null,
  "transportFragments": null,
  "observedRows": 6,
  "kinds": {
    "promise": 2,
    "bind": 2,
    "request": 2,
    "await": 1,
    "resume": 1,
    "compute": 1,
    "return": 1,
    "end": 1
  },
  "topLevelValueBytes": {
    "action": 17,
    "promise": 16,
    "name": 14,
    "value": 47,
    "effect": 8,
    "operation": 28,
    "arguments": 48,
    "invocation": 78,
    "site": 43,
    "payload": 32,
    "continuation": 30,
    "returnPromise": 4,
    "result": 18,
    "status": 11,
    "expr": 112,
    "bind": 6,
    "kind": 8
  },
  "topLevelKeyOccurrences": {
    "action": 2,
    "promise": 4,
    "name": 2,
    "value": 4,
    "effect": 2,
    "operation": 2,
    "arguments": 2,
    "invocation": 6,
    "site": 2,
    "payload": 2,
    "continuation": 2,
    "returnPromise": 1,
    "result": 2,
    "status": 1,
    "expr": 1,
    "bind": 1,
    "kind": 1
  },
  "distinctCells": 3,
  "exactSourceNamedBindingRecords": 3,
  "repeatedEqualCellBindingRecords": 0,
  "overheadDefinition": "Record kind, top-level keys and punctuation are byte accounting, not dispensable semantic overhead."
}
```

## rejection-finally

```js
"use strict";async function run(){try{return await host.readAsync("bad");}catch(error){host.store("error",error);return 11;}finally{host.store("cleanup",1);}}
```

Qualification: `locally_verified`. Private certificates, source checks and native admission are separate authorities; this gallery grants none.

### Exact generated targets

```text
promise {"action":"create","promise":"p1"}
request {"effect":"e1","operation":"demo.readAsync","arguments":[["str","bad"]],"invocation":"invocation1","site":{"start":51,"end":72},"payload":"[\"bad\"]","promise":"p2"}
await {"promise":"p2","continuation":"continuation1","invocation":"invocation1","returnPromise":"p1"}
resume {"continuation":"continuation1","invocation":"invocation1","result":["str","missing"],"status":"rejected"}
bind {"name":"error","value":["str","missing"]}
request {"effect":"e2","operation":"demo.store","arguments":[["str","error"],["str","missing"]],"invocation":"invocation1","site":{"start":87,"end":112},"payload":"[\"error\",\"missing\"]"}
transfer {"kind":"return","value":["num",11],"handler":"finally","invocation":"invocation1"}
request {"effect":"e3","operation":"demo.store","arguments":[["str","cleanup"],["num",1]],"invocation":"invocation1","site":{"start":132,"end":155},"payload":"[\"cleanup\",1]"}
promise {"action":"resolve","promise":"p1","value":["num",11]}
return {"value":["ref","p1"],"invocation":"invocation1"}
end {"kind":"return"}
```

### Readable execution and observation boundaries

- 1 observed: program 
- 2 observed: invocation 
- 3 generated: create owned Promise &p1 — The stated owned Promise transition occurs.
- 4 generated: request e1 demo.readAsync("bad") in invocation1 @51:72 -> Promise &p2 — The stated source call requests this external operation and arguments.
- 5 observed: dispatch 
- 6 generated: await Promise &p2; suspend invocation1 as continuation1; call returns owned Promise &p1 — The invocation suspends on this Promise with this continuation.
- 7 observed: observe e1 rejected "missing" 
- 8 generated: resume invocation1 via continuation1 with rejected "missing" — The invocation resumes with the already observed settlement.
- 9 generated: bind error = "missing" — The named source cell has the stated value at this step.
- 10 generated: request e2 demo.store("error", "missing") in invocation1 @87:112 — The stated source call requests this external operation and arguments.
- 11 observed: dispatch 
- 12 observed: observe e2 fulfilled undefined 
- 13 generated: transfer return 11 via finally — The stated abrupt completion transfers to the stated handler.
- 14 generated: request e3 demo.store("cleanup", 1) in invocation1 @132:155 — The stated source call requests this external operation and arguments.
- 15 observed: dispatch 
- 16 observed: observe e3 fulfilled undefined 
- 17 generated: resolve Promise &p1 11 — The stated owned Promise transition occurs.
- 18 generated: return &p1 — The guest invocation returns the stated value.
- 19 generated: end return — The invocation has the stated completion and no blocking pending work.

### Byte and field accounting

```json
{
  "generatedRecords": 11,
  "generatedBytes": 1072,
  "recordKindBytes": 78,
  "punctuationBytes": 52,
  "keyBytes": 426,
  "valueBytes": 516,
  "generatedTokens": null,
  "transportFragments": null,
  "observedRows": 8,
  "kinds": {
    "promise": 2,
    "request": 3,
    "await": 1,
    "resume": 1,
    "bind": 1,
    "transfer": 1,
    "return": 1,
    "end": 1
  },
  "topLevelValueBytes": {
    "action": 17,
    "promise": 16,
    "effect": 12,
    "operation": 40,
    "arguments": 79,
    "invocation": 91,
    "site": 66,
    "payload": 53,
    "continuation": 30,
    "returnPromise": 4,
    "result": 17,
    "status": 10,
    "name": 7,
    "value": 49,
    "kind": 16,
    "handler": 9
  },
  "topLevelKeyOccurrences": {
    "action": 2,
    "promise": 4,
    "effect": 3,
    "operation": 3,
    "arguments": 3,
    "invocation": 7,
    "site": 3,
    "payload": 3,
    "continuation": 2,
    "returnPromise": 1,
    "result": 1,
    "status": 1,
    "name": 1,
    "value": 4,
    "kind": 2,
    "handler": 1
  },
  "distinctCells": 1,
  "exactSourceNamedBindingRecords": 1,
  "repeatedEqualCellBindingRecords": 0,
  "overheadDefinition": "Record kind, top-level keys and punctuation are byte accounting, not dispensable semantic overhead."
}
```

## callback-captured-write

```js
"use strict";async function run(){let seen=0;await host.withCallback("value",function(n){seen=seen+n;host.store("callback",seen);});host.store("result",seen);return seen;}
```

Qualification: `locally_verified`. Private certificates, source checks and native admission are separate authorities; this gallery grants none.

### Exact generated targets

```text
promise {"action":"create","promise":"p1"}
bind {"name":"seen","value":["num",0]}
allocate {"name":"o2","kind":"closure","properties":[],"code":"function:77","captures":[{"binding":"seen","cell":"seen"}]}
request {"effect":"e1","operation":"demo.withCallback","arguments":[["str","value"],["ref","o2"]],"invocation":"invocation1","site":{"start":51,"end":131},"payload":"[\"value\",{\"$ownedCallback\":\"o2\"}]","promise":"p2"}
await {"promise":"p2","continuation":"continuation1","invocation":"invocation1","returnPromise":"p1"}
bind {"name":"n","value":["num",3]}
compute {"expr":{"op":"binary","operator":"+","left":{"op":"local","name":"seen"},"right":{"op":"local","name":"n"}},"result":["num",3],"invocation":"event1","bind":"seen"}
request {"effect":"e2","operation":"demo.store","arguments":[["str","callback"],["num",3]],"invocation":"event1","site":{"start":101,"end":128},"payload":"[\"callback\",3]"}
return {"value":["undefined"],"invocation":"event1"}
end {"kind":"return"}
bind {"name":"n_1","value":["num",4]}
compute {"expr":{"op":"binary","operator":"+","left":{"op":"local","name":"seen"},"right":{"op":"local","name":"n_1"}},"result":["num",7],"invocation":"event2","bind":"seen"}
request {"effect":"e3","operation":"demo.store","arguments":[["str","callback"],["num",7]],"invocation":"event2","site":{"start":101,"end":128},"payload":"[\"callback\",7]"}
return {"value":["undefined"],"invocation":"event2"}
end {"kind":"return"}
resume {"continuation":"continuation1","invocation":"invocation1","result":["undefined"],"status":"fulfilled"}
request {"effect":"e4","operation":"demo.store","arguments":[["str","result"],["num",7]],"invocation":"invocation1","site":{"start":132,"end":157},"payload":"[\"result\",7]"}
promise {"action":"resolve","promise":"p1","value":["num",7]}
return {"value":["ref","p1"],"invocation":"invocation1"}
end {"kind":"return"}
```

### Readable execution and observation boundaries

- 1 observed: program 
- 2 observed: invocation 
- 3 generated: create owned Promise &p1 — The stated owned Promise transition occurs.
- 4 generated: bind seen = 0 — The named source cell has the stated value at this step.
- 5 generated: allocate &o2 closure {} — A fresh identity with the stated kind and initial properties exists.
- 6 generated: request e1 demo.withCallback("value", &o2) in invocation1 @51:131 -> Promise &p2 — The stated source call requests this external operation and arguments.
- 7 observed: dispatch 
- 8 observed: handler 
- 9 generated: await Promise &p2; suspend invocation1 as continuation1; call returns owned Promise &p1 — The invocation suspends on this Promise with this continuation.
- 10 observed: event 
- 11 observed: invocation 
- 12 observed: source-read 
- 13 observed: model-context 
- 14 generated: bind n = 3 — The named source cell has the stated value at this step.
- 15 generated: seen = (seen + n) -> 3 — The stated expression evaluates to the result in committed public state.
- 16 generated: request e2 demo.store("callback", 3) in event1 @101:128 — The stated source call requests this external operation and arguments.
- 17 observed: dispatch 
- 18 observed: observe e1 fulfilled undefined 
- 19 observed: observe e2 fulfilled undefined 
- 20 generated: return undefined — The guest invocation returns the stated value.
- 21 generated: end return — The invocation has the stated completion and no blocking pending work.
- 22 observed: event 
- 23 observed: invocation 
- 24 observed: source-read 
- 25 observed: model-context 
- 26 generated: bind n_1 = 4 — The named source cell has the stated value at this step.
- 27 generated: seen = (seen + n_1) -> 7 — The stated expression evaluates to the result in committed public state.
- 28 generated: request e3 demo.store("callback", 7) in event2 @101:128 — The stated source call requests this external operation and arguments.
- 29 observed: dispatch 
- 30 observed: observe e3 fulfilled undefined 
- 31 generated: return undefined — The guest invocation returns the stated value.
- 32 generated: end return — The invocation has the stated completion and no blocking pending work.
- 33 observed: handler-close 
- 34 observed: source-read 
- 35 observed: model-context 
- 36 generated: resume invocation1 via continuation1 with fulfilled undefined — The invocation resumes with the already observed settlement.
- 37 generated: request e4 demo.store("result", 7) in invocation1 @132:157 — The stated source call requests this external operation and arguments.
- 38 observed: dispatch 
- 39 observed: observe e4 fulfilled undefined 
- 40 generated: resolve Promise &p1 7 — The stated owned Promise transition occurs.
- 41 generated: return &p1 — The guest invocation returns the stated value.
- 42 generated: end return — The invocation has the stated completion and no blocking pending work.

### Byte and field accounting

```json
{
  "generatedRecords": 20,
  "generatedBytes": 1857,
  "recordKindBytes": 134,
  "punctuationBytes": 86,
  "keyBytes": 654,
  "valueBytes": 983,
  "generatedTokens": null,
  "transportFragments": null,
  "observedRows": 22,
  "kinds": {
    "promise": 2,
    "bind": 3,
    "allocate": 1,
    "request": 4,
    "await": 1,
    "compute": 2,
    "return": 3,
    "end": 3,
    "resume": 1
  },
  "topLevelValueBytes": {
    "action": 17,
    "promise": 16,
    "name": 18,
    "value": 74,
    "kind": 33,
    "properties": 2,
    "code": 13,
    "captures": 34,
    "effect": 16,
    "operation": 55,
    "arguments": 118,
    "invocation": 113,
    "site": 91,
    "payload": 93,
    "continuation": 30,
    "returnPromise": 4,
    "expr": 202,
    "result": 31,
    "bind": 12,
    "status": 11
  },
  "topLevelKeyOccurrences": {
    "action": 2,
    "promise": 4,
    "name": 4,
    "value": 7,
    "kind": 4,
    "properties": 1,
    "code": 1,
    "captures": 1,
    "effect": 4,
    "operation": 4,
    "arguments": 4,
    "invocation": 11,
    "site": 4,
    "payload": 4,
    "continuation": 2,
    "returnPromise": 1,
    "expr": 2,
    "result": 3,
    "bind": 2,
    "status": 1
  },
  "distinctCells": 3,
  "exactSourceNamedBindingRecords": 4,
  "repeatedEqualCellBindingRecords": 0,
  "overheadDefinition": "Record kind, top-level keys and punctuation are byte accounting, not dispensable semantic overhead."
}
```

## persistent-external-trigger

```js
"use strict";async function run(){let seen=0;const token=await host.listen("tick",n=>{seen+=n;host.store("event",seen);});await host.readAsync("events-complete");await host.unlisten(token);return seen;}
```

Qualification: `locally_verified`. Private certificates, source checks and native admission are separate authorities; this gallery grants none.

### Exact generated targets

```text
promise {"action":"create","promise":"p1"}
bind {"name":"seen","value":["num",0]}
allocate {"name":"o2","kind":"closure","properties":[],"code":"function:82","captures":[{"binding":"seen","cell":"seen"}]}
request {"effect":"e1","operation":"demo.listen","arguments":[["str","tick"],["ref","o2"]],"invocation":"invocation1","site":{"start":63,"end":121},"payload":"[\"tick\",{\"$ownedCallback\":\"o2\"}]","promise":"p2"}
await {"promise":"p2","continuation":"continuation1","invocation":"invocation1","returnPromise":"p1"}
resume {"continuation":"continuation1","invocation":"invocation1","result":["str","callback1"],"status":"fulfilled"}
bind {"name":"token","value":["str","callback1"]}
request {"effect":"e2","operation":"demo.readAsync","arguments":[["str","events-complete"]],"invocation":"invocation1","site":{"start":128,"end":161},"payload":"[\"events-complete\"]","promise":"p3"}
await {"promise":"p3","continuation":"continuation2","invocation":"invocation1"}
bind {"name":"n","value":["num",2]}
compute {"expr":{"op":"binary","operator":"+","left":{"op":"local","name":"seen"},"right":{"op":"local","name":"n"}},"result":["num",2],"invocation":"event1"}
bind {"name":"seen","value":["num",2]}
request {"effect":"e3","operation":"demo.store","arguments":[["str","event"],["num",2]],"invocation":"event1","site":{"start":94,"end":118},"payload":"[\"event\",2]"}
return {"value":["undefined"],"invocation":"event1"}
end {"kind":"return"}
bind {"name":"n_1","value":["num",3]}
compute {"expr":{"op":"binary","operator":"+","left":{"op":"local","name":"seen"},"right":{"op":"local","name":"n_1"}},"result":["num",5],"invocation":"event2"}
bind {"name":"seen","value":["num",5]}
request {"effect":"e4","operation":"demo.store","arguments":[["str","event"],["num",5]],"invocation":"event2","site":{"start":94,"end":118},"payload":"[\"event\",5]"}
return {"value":["undefined"],"invocation":"event2"}
end {"kind":"return"}
resume {"continuation":"continuation2","invocation":"invocation1","result":["undefined"],"status":"fulfilled"}
request {"effect":"e5","operation":"demo.unlisten","arguments":[["str","callback1"]],"invocation":"invocation1","site":{"start":168,"end":188},"payload":"[\"callback1\"]","promise":"p4"}
await {"promise":"p4","continuation":"continuation3","invocation":"invocation1"}
resume {"continuation":"continuation3","invocation":"invocation1","result":["undefined"],"status":"fulfilled"}
promise {"action":"resolve","promise":"p1","value":["num",5]}
return {"value":["ref","p1"],"invocation":"invocation1"}
end {"kind":"return"}
```

### Readable execution and observation boundaries

- 1 observed: program 
- 2 observed: invocation 
- 3 generated: create owned Promise &p1 — The stated owned Promise transition occurs.
- 4 generated: bind seen = 0 — The named source cell has the stated value at this step.
- 5 generated: allocate &o2 closure {} — A fresh identity with the stated kind and initial properties exists.
- 6 generated: request e1 demo.listen("tick", &o2) in invocation1 @63:121 -> Promise &p2 — The stated source call requests this external operation and arguments.
- 7 observed: dispatch 
- 8 observed: handler 
- 9 generated: await Promise &p2; suspend invocation1 as continuation1; call returns owned Promise &p1 — The invocation suspends on this Promise with this continuation.
- 10 observed: observe e1 fulfilled "callback1" 
- 11 generated: resume invocation1 via continuation1 with fulfilled "callback1" — The invocation resumes with the already observed settlement.
- 12 generated: bind token = "callback1" — The named source cell has the stated value at this step.
- 13 generated: request e2 demo.readAsync("events-complete") in invocation1 @128:161 -> Promise &p3 — The stated source call requests this external operation and arguments.
- 14 observed: dispatch 
- 15 generated: await Promise &p3; suspend invocation1 as continuation2 — The invocation suspends on this Promise with this continuation.
- 16 observed: event 
- 17 observed: invocation 
- 18 observed: source-read 
- 19 observed: model-context 
- 20 generated: bind n = 2 — The named source cell has the stated value at this step.
- 21 generated: compute (seen + n) -> 2 — The stated expression evaluates to the result in committed public state.
- 22 generated: bind seen = 2 — The named source cell has the stated value at this step.
- 23 generated: request e3 demo.store("event", 2) in event1 @94:118 — The stated source call requests this external operation and arguments.
- 24 observed: dispatch 
- 25 observed: observe e2 fulfilled undefined 
- 26 observed: observe e3 fulfilled undefined 
- 27 generated: return undefined — The guest invocation returns the stated value.
- 28 generated: end return — The invocation has the stated completion and no blocking pending work.
- 29 observed: event 
- 30 observed: invocation 
- 31 observed: source-read 
- 32 observed: model-context 
- 33 generated: bind n_1 = 3 — The named source cell has the stated value at this step.
- 34 generated: compute (seen + n_1) -> 5 — The stated expression evaluates to the result in committed public state.
- 35 generated: bind seen = 5 — The named source cell has the stated value at this step.
- 36 generated: request e4 demo.store("event", 5) in event2 @94:118 — The stated source call requests this external operation and arguments.
- 37 observed: dispatch 
- 38 observed: observe e4 fulfilled undefined 
- 39 generated: return undefined — The guest invocation returns the stated value.
- 40 generated: end return — The invocation has the stated completion and no blocking pending work.
- 41 observed: source-read 
- 42 observed: model-context 
- 43 generated: resume invocation1 via continuation2 with fulfilled undefined — The invocation resumes with the already observed settlement.
- 44 generated: request e5 demo.unlisten("callback1") in invocation1 @168:188 -> Promise &p4 — The stated source call requests this external operation and arguments.
- 45 observed: dispatch 
- 46 generated: await Promise &p4; suspend invocation1 as continuation3 — The invocation suspends on this Promise with this continuation.
- 47 observed: observe e5 fulfilled undefined 
- 48 observed: handler-close 
- 49 generated: resume invocation1 via continuation3 with fulfilled undefined — The invocation resumes with the already observed settlement.
- 50 generated: resolve Promise &p1 5 — The stated owned Promise transition occurs.
- 51 generated: return &p1 — The guest invocation returns the stated value.
- 52 generated: end return — The invocation has the stated completion and no blocking pending work.

### Byte and field accounting

```json
{
  "generatedRecords": 28,
  "generatedBytes": 2529,
  "recordKindBytes": 183,
  "punctuationBytes": 120,
  "keyBytes": 936,
  "valueBytes": 1290,
  "generatedTokens": null,
  "transportFragments": null,
  "observedRows": 24,
  "kinds": {
    "promise": 2,
    "bind": 6,
    "allocate": 1,
    "request": 5,
    "await": 3,
    "resume": 3,
    "compute": 2,
    "return": 3,
    "end": 3
  },
  "topLevelValueBytes": {
    "action": 17,
    "promise": 32,
    "name": 37,
    "value": 111,
    "kind": 33,
    "properties": 2,
    "code": 13,
    "captures": 34,
    "effect": 20,
    "operation": 68,
    "arguments": 131,
    "invocation": 178,
    "site": 112,
    "payload": 110,
    "continuation": 90,
    "returnPromise": 4,
    "result": 63,
    "status": 33,
    "expr": 202
  },
  "topLevelKeyOccurrences": {
    "action": 2,
    "promise": 8,
    "name": 7,
    "value": 10,
    "kind": 4,
    "properties": 1,
    "code": 1,
    "captures": 1,
    "effect": 5,
    "operation": 5,
    "arguments": 5,
    "invocation": 16,
    "site": 5,
    "payload": 5,
    "continuation": 6,
    "returnPromise": 1,
    "result": 5,
    "status": 3,
    "expr": 2
  },
  "distinctCells": 4,
  "exactSourceNamedBindingRecords": 5,
  "repeatedEqualCellBindingRecords": 0,
  "overheadDefinition": "Record kind, top-level keys and punctuation are byte accounting, not dispensable semantic overhead."
}
```

## redundant-cell-write

```js
"use strict";function run(n){let value=n;value=n;value=n;return value;}
```

Qualification: `locally_verified`. Private certificates, source checks and native admission are separate authorities; this gallery grants none.

### Exact generated targets

```text
bind {"name":"n","value":["num",3]}
bind {"name":"value","value":["num",3]}
bind {"name":"value","value":["num",3]}
bind {"name":"value","value":["num",3]}
return {"value":["num",3],"invocation":"invocation1"}
end {"kind":"return"}
```

### Readable execution and observation boundaries

- 1 observed: program 
- 2 observed: invocation 
- 3 generated: bind n = 3 — The named source cell has the stated value at this step.
- 4 generated: bind value = 3 — The named source cell has the stated value at this step.
- 5 generated: bind value = 3 — The named source cell has the stated value at this step.
- 6 generated: bind value = 3 — The named source cell has the stated value at this step.
- 7 generated: return 3 — The guest invocation returns the stated value.
- 8 generated: end return — The invocation has the stated completion and no blocking pending work.

### Byte and field accounting

```json
{
  "generatedRecords": 6,
  "generatedBytes": 226,
  "recordKindBytes": 31,
  "punctuationBytes": 17,
  "keyBytes": 88,
  "valueBytes": 90,
  "generatedTokens": null,
  "transportFragments": null,
  "observedRows": 2,
  "kinds": {
    "bind": 4,
    "return": 1,
    "end": 1
  },
  "topLevelValueBytes": {
    "name": 24,
    "value": 45,
    "invocation": 13,
    "kind": 8
  },
  "topLevelKeyOccurrences": {
    "name": 4,
    "value": 5,
    "invocation": 1,
    "kind": 1
  },
  "distinctCells": 2,
  "exactSourceNamedBindingRecords": 4,
  "repeatedEqualCellBindingRecords": 2,
  "overheadDefinition": "Record kind, top-level keys and punctuation are byte accounting, not dispensable semantic overhead."
}
```

