# Actual semantic target gallery

Actual target inspection; no model-learning or native-qualification claim.

| Case | Categories | Generated records | Target UTF-8 bytes | Token count |
| --- | --- | ---: | ---: | ---: |
| compound-pure | expressions | 2 | 40 | 20 |
| branch-1 | branches, async-observations | 10 | 406 | 138 |
| object-alias | object-construction, aliases | 10 | 179 | 81 |
| pure-helper | helper-calls | 2 | 30 | 10 |
| dense-loop | loops | 2 | 56 | 17 |
| throw-finally | throws, finally | 7 | 209 | 68 |
| counter-0 | async-observations | 11 | 437 | 142 |
| rejection-finally | throws, finally, async-observations | 11 | 524 | 169 |
| callback-captured-write | callbacks, captured-state | 20 | 802 | 273 |
| persistent-external-trigger | callbacks, retained-state | 28 | 1130 | 371 |
| redundant-cell-write | local-state | 4 | 48 | 18 |

Byte counts sum the exact generated UTF-8 target lines and exclude transport framing. Token counts, when available, encode each line independently; they do not measure native recurrent context or transport fragments.

## Archived v5 comparison

The archived v5 targets are compared as raw stored lines. They are not decoded or reinterpreted under the v6 grammar.

| Case | v5 records | v6 records | Record change | v5 bytes | v6 bytes | Byte change | v5 tokens | v6 tokens | Token change |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| compound-pure | 7 | 2 | -5 | 601 | 40 | -561 | 192 | 20 | -172 |
| branch-1 | 10 | 10 | 0 | 960 | 406 | -554 | 288 | 138 | -150 |
| object-alias | 10 | 10 | 0 | 642 | 179 | -463 | 210 | 81 | -129 |
| pure-helper | 6 | 2 | -4 | 423 | 30 | -393 | 130 | 10 | -120 |
| dense-loop | 29 | 2 | -27 | 2386 | 56 | -2330 | 775 | 17 | -758 |
| throw-finally | 7 | 7 | 0 | 631 | 209 | -422 | 187 | 68 | -119 |
| counter-0 | 11 | 11 | 0 | 1018 | 437 | -581 | 300 | 142 | -158 |
| rejection-finally | 11 | 11 | 0 | 1072 | 524 | -548 | 315 | 169 | -146 |
| callback-captured-write | 20 | 20 | 0 | 1857 | 802 | -1055 | 562 | 273 | -289 |
| persistent-external-trigger | 28 | 28 | 0 | 2529 | 1130 | -1399 | 751 | 371 | -380 |
| redundant-cell-write | 6 | 4 | -2 | 226 | 48 | -178 | 74 | 18 | -56 |

Overall: 145 → 107 generated records; 12345 → 3861 UTF-8 bytes; 3784 → 1307 tokens.

## compound-pure

```js
"use strict";function run(a,b,c,d){return (a+b)*(c+d)+1;}
```

Qualification: `locally_verified`. Private certificates, source checks and native admission are separate authorities; this gallery grants none.

### Exact generated targets

```text
evaluate run(1, 2, 3, 4) => 22
end return
```

### Readable execution and observation boundaries

- 1 observed: program
- 2 observed: invocation
- 3 generated: evaluate run(1, 2, 3, 4) => 22 — The bounded source region has the stated result and executed path.
- 4 generated: end return — The invocation has the stated completion and no blocking pending work.

### Exact target measurements

```json
{
  "generatedRecords": 2,
  "generatedBytes": 40,
  "generatedTokens": 20,
  "transportFragments": null,
  "observedRows": 2,
  "kinds": {
    "summarize": 1,
    "end": 1
  },
  "byteDefinition": "Sum of the exact generated UTF-8 target lines; excludes transport framing and observed context."
}
```

## branch-1

```js
"use strict";async function run(){const n=await host.readAsync("value");if(n>3){host.store("chosen",n);return n;}host.store("chosen",0);return 0;}
```

Qualification: `locally_verified`. Private certificates, source checks and native admission are separate authorities; this gallery grants none.

### Exact generated targets

```text
promise create @p1
request @e1 demo.readAsync("value") payload ["value"] promise @p2 in @invocation1 at 48..71
await @p2 as @continuation1 returns @p1 in @invocation1
resume @continuation1 fulfilled 8 in @invocation1
n = 8
choose (n > 3) => true -> then in @invocation1
request @e2 demo.store("chosen", 8) payload ["chosen",8] in @invocation1 at 80..102
promise resolve @p1 = 8
return @p1 in @invocation1
end return
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

### Exact target measurements

```json
{
  "generatedRecords": 10,
  "generatedBytes": 406,
  "generatedTokens": 138,
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
  "byteDefinition": "Sum of the exact generated UTF-8 target lines; excludes transport framing and observed context."
}
```

## object-alias

```js
"use strict";function run(){const box={n:2};const alias=box;alias.n=alias.n+1;return box.n;}
```

Qualification: `locally_verified`. Private certificates, source checks and native admission are separate authorities; this gallery grants none.

### Exact generated targets

```text
new @o2 object {}
write @o2["n"] = 2
box = @o2
alias = @o2
read @o2["n"] => 2
compute (2 + 1) => 3 in @invocation1
write @o2["n"] = 3
read @o2["n"] => 3
return 3 in @invocation1
end return
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

### Exact target measurements

```json
{
  "generatedRecords": 10,
  "generatedBytes": 179,
  "generatedTokens": 81,
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
  "byteDefinition": "Sum of the exact generated UTF-8 target lines; excludes transport framing and observed context."
}
```

## pure-helper

```js
"use strict";function increment(value){return value+1;}function run(n){return increment(n);}
```

Qualification: `locally_verified`. Private certificates, source checks and native admission are separate authorities; this gallery grants none.

### Exact generated targets

```text
evaluate run(4) => 5
end return
```

### Readable execution and observation boundaries

- 1 observed: program
- 2 observed: invocation
- 3 generated: evaluate run(4) => 5 — The bounded source region has the stated result and executed path.
- 4 generated: end return — The invocation has the stated completion and no blocking pending work.

### Exact target measurements

```json
{
  "generatedRecords": 2,
  "generatedBytes": 30,
  "generatedTokens": 10,
  "transportFragments": null,
  "observedRows": 2,
  "kinds": {
    "summarize": 1,
    "end": 1
  },
  "byteDefinition": "Sum of the exact generated UTF-8 target lines; excludes transport framing and observed context."
}
```

## dense-loop

```js
"use strict";function run(xs){let total=0;for(let i=0;i<xs.length;i++){total+=xs[i];}return total;}
```

Qualification: `locally_verified`. Private certificates, source checks and native admission are separate authorities; this gallery grants none.

### Exact generated targets

```text
evaluate run(@o2) => 9 over 3 items into total
end return
```

### Readable execution and observation boundaries

- 1 observed: program
- 2 observed: invocation
- 3 generated: evaluate run(&o2) => 9 over 3 items into total — The bounded source region has the stated result and executed path.
- 4 generated: end return — The invocation has the stated completion and no blocking pending work.

### Exact target measurements

```json
{
  "generatedRecords": 2,
  "generatedBytes": 56,
  "generatedTokens": 17,
  "transportFragments": null,
  "observedRows": 2,
  "kinds": {
    "summarize": 1,
    "end": 1
  },
  "byteDefinition": "Sum of the exact generated UTF-8 target lines; excludes transport framing and observed context."
}
```

## throw-finally

```js
"use strict";function run(){let answer=0;try{throw 2;}catch(error){answer=error+1;}finally{answer=answer+4;}return answer;}
```

Qualification: `locally_verified`. Private certificates, source checks and native admission are separate authorities; this gallery grants none.

### Exact generated targets

```text
answer = 0
transfer throw 2 via "catch-or-finally" in @invocation1
error = 2
compute (error + 1) => 3 as answer in @invocation1
compute (answer + 4) => 7 as answer in @invocation1
return 7 in @invocation1
end return
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

### Exact target measurements

```json
{
  "generatedRecords": 7,
  "generatedBytes": 209,
  "generatedTokens": 68,
  "transportFragments": null,
  "observedRows": 2,
  "kinds": {
    "bind": 2,
    "transfer": 1,
    "compute": 2,
    "return": 1,
    "end": 1
  },
  "byteDefinition": "Sum of the exact generated UTF-8 target lines; excludes transport framing and observed context."
}
```

## counter-0

```js
"use strict";async function run(key){const current=await host.readAsync(key);const next=current+1;host.store(key,next);return next;}
```

Qualification: `locally_verified`. Private certificates, source checks and native admission are separate authorities; this gallery grants none.

### Exact generated targets

```text
promise create @p1
key = "counter"
request @e1 demo.readAsync("counter") payload ["counter"] promise @p2 in @invocation1 at 57..76
await @p2 as @continuation1 returns @p1 in @invocation1
resume @continuation1 fulfilled 7 in @invocation1
current = 7
compute (current + 1) => 8 as next in @invocation1
request @e2 demo.store("counter", 8) payload ["counter",8] in @invocation1 at 98..118
promise resolve @p1 = 8
return @p1 in @invocation1
end return
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

### Exact target measurements

```json
{
  "generatedRecords": 11,
  "generatedBytes": 437,
  "generatedTokens": 142,
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
  "byteDefinition": "Sum of the exact generated UTF-8 target lines; excludes transport framing and observed context."
}
```

## rejection-finally

```js
"use strict";async function run(){try{return await host.readAsync("bad");}catch(error){host.store("error",error);return 11;}finally{host.store("cleanup",1);}}
```

Qualification: `locally_verified`. Private certificates, source checks and native admission are separate authorities; this gallery grants none.

### Exact generated targets

```text
promise create @p1
request @e1 demo.readAsync("bad") payload ["bad"] promise @p2 in @invocation1 at 51..72
await @p2 as @continuation1 returns @p1 in @invocation1
resume @continuation1 rejected "missing" in @invocation1
error = "missing"
request @e2 demo.store("error", "missing") payload ["error","missing"] in @invocation1 at 87..112
transfer return 11 via "finally" in @invocation1
request @e3 demo.store("cleanup", 1) payload ["cleanup",1] in @invocation1 at 132..155
promise resolve @p1 = 11
return @p1 in @invocation1
end return
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

### Exact target measurements

```json
{
  "generatedRecords": 11,
  "generatedBytes": 524,
  "generatedTokens": 169,
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
  "byteDefinition": "Sum of the exact generated UTF-8 target lines; excludes transport framing and observed context."
}
```

## callback-captured-write

```js
"use strict";async function run(){let seen=0;await host.withCallback("value",function(n){seen=seen+n;host.store("callback",seen);});host.store("result",seen);return seen;}
```

Qualification: `locally_verified`. Private certificates, source checks and native admission are separate authorities; this gallery grants none.

### Exact generated targets

```text
promise create @p1
seen = 0
new @o2 closure {} code "function:77" captures {seen: seen}
request @e1 demo.withCallback("value", @o2) payload ["value",{"$ownedCallback":"o2"}] promise @p2 in @invocation1 at 51..131
await @p2 as @continuation1 returns @p1 in @invocation1
n = 3
compute (seen + n) => 3 as seen in @event1
request @e2 demo.store("callback", 3) payload ["callback",3] in @event1 at 101..128
return undefined in @event1
end return
n_1 = 4
compute (seen + n_1) => 7 as seen in @event2
request @e3 demo.store("callback", 7) payload ["callback",7] in @event2 at 101..128
return undefined in @event2
end return
resume @continuation1 fulfilled undefined in @invocation1
request @e4 demo.store("result", 7) payload ["result",7] in @invocation1 at 132..157
promise resolve @p1 = 7
return @p1 in @invocation1
end return
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

### Exact target measurements

```json
{
  "generatedRecords": 20,
  "generatedBytes": 802,
  "generatedTokens": 273,
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
  "byteDefinition": "Sum of the exact generated UTF-8 target lines; excludes transport framing and observed context."
}
```

## persistent-external-trigger

```js
"use strict";async function run(){let seen=0;const token=await host.listen("tick",n=>{seen+=n;host.store("event",seen);});await host.readAsync("events-complete");await host.unlisten(token);return seen;}
```

Qualification: `locally_verified`. Private certificates, source checks and native admission are separate authorities; this gallery grants none.

### Exact generated targets

```text
promise create @p1
seen = 0
new @o2 closure {} code "function:82" captures {seen: seen}
request @e1 demo.listen("tick", @o2) payload ["tick",{"$ownedCallback":"o2"}] promise @p2 in @invocation1 at 63..121
await @p2 as @continuation1 returns @p1 in @invocation1
resume @continuation1 fulfilled "callback1" in @invocation1
token = "callback1"
request @e2 demo.readAsync("events-complete") payload ["events-complete"] promise @p3 in @invocation1 at 128..161
await @p3 as @continuation2 in @invocation1
n = 2
compute (seen + n) => 2 in @event1
seen = 2
request @e3 demo.store("event", 2) payload ["event",2] in @event1 at 94..118
return undefined in @event1
end return
n_1 = 3
compute (seen + n_1) => 5 in @event2
seen = 5
request @e4 demo.store("event", 5) payload ["event",5] in @event2 at 94..118
return undefined in @event2
end return
resume @continuation2 fulfilled undefined in @invocation1
request @e5 demo.unlisten("callback1") payload ["callback1"] promise @p4 in @invocation1 at 168..188
await @p4 as @continuation3 in @invocation1
resume @continuation3 fulfilled undefined in @invocation1
promise resolve @p1 = 5
return @p1 in @invocation1
end return
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

### Exact target measurements

```json
{
  "generatedRecords": 28,
  "generatedBytes": 1130,
  "generatedTokens": 371,
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
  "byteDefinition": "Sum of the exact generated UTF-8 target lines; excludes transport framing and observed context."
}
```

## redundant-cell-write

```js
"use strict";function run(n){let value=n;value=n;value=n;return value;}
```

Qualification: `locally_verified`. Private certificates, source checks and native admission are separate authorities; this gallery grants none.

### Exact generated targets

```text
n = 3
value = 3
return 3 in @invocation1
end return
```

### Readable execution and observation boundaries

- 1 observed: program
- 2 observed: invocation
- 3 generated: bind n = 3 — The named source cell has the stated value at this step.
- 4 generated: bind value = 3 — The named source cell has the stated value at this step.
- 5 generated: return 3 — The guest invocation returns the stated value.
- 6 generated: end return — The invocation has the stated completion and no blocking pending work.

### Exact target measurements

```json
{
  "generatedRecords": 4,
  "generatedBytes": 48,
  "generatedTokens": 18,
  "transportFragments": null,
  "observedRows": 2,
  "kinds": {
    "bind": 2,
    "return": 1,
    "end": 1
  },
  "byteDefinition": "Sum of the exact generated UTF-8 target lines; excludes transport framing and observed context."
}
```
