# Real-world effective execution trace inspection

These are **native V8 diagnostic observations**, not independently admitted
owned semantic-execution/2 trajectories. Every accepted example matches a
second, uninstrumented V8 run on its return/throw and reachable argument/result
graph. Source family (not individual invocation) determines the frozen split.

## Dataset measurements

- Invocations attempted: 936
- Verified completed observations: 936
- Verified distinct source functions: 78
- Instrumentation/reference disagreements: 0
- Guest throws: 0; generation errors: 0
- Median serialized event bytes: 2479
- Median logical events: 22
- Median visible state changes: 1

## Representative executions

### vscode/numbers.ts/clamp

Source: https://github.com/microsoft/vscode/blob/2bc7d5ab6919c62e60379e5e1f840bd80846dbdb/src/vs/base/common/numbers.ts

Invoked with fixture 0; 5 events, 0 state changes, 397 serialized event bytes.

~~~text
enter → clamp
call Math.max(value, min) → -5
call Math.min(Math.max(value, min), max) → -5
return return Math.min(Math.max(value, min), max); → -5
end → -5
~~~

Result graph: {"roots":[["num",-8],["num",-5],["num",5],["num",-5]],"objects":[]}

### vscode/arrays.ts/coalesceInPlace

Source: https://github.com/microsoft/vscode/blob/2bc7d5ab6919c62e60379e5e1f840bd80846dbdb/src/vs/base/common/arrays.ts

Invoked with fixture 0; 49 events, 6 state changes, 4953 serialized event bytes.

~~~text
enter → coalesceInPlace
write to = 0 → 0 (to)
write i = 0 → 0 (i)
read array.length → 6
branch i < array.length → then
read array[i] → -8
branch !!array[i] → then
read array[i] → -8
write array[to] = array[i] → -8
write to += 1 → 1
write i++ → 0 (i)
read array.length → 6
branch i < array.length → then
read array[i] → 0
branch !!array[i] → else
write i++ → 1 (i)
read array.length → 6
branch i < array.length → then
read array[i] → 1
branch !!array[i] → then
read array[i] → 1
write array[to] = array[i] → 1  [&o0.1: 0 → 1]
write to += 1 → 2
write i++ → 2 (i)
read array.length → 6
branch i < array.length → then
read array[i] → 5
branch !!array[i] → then
read array[i] → 5
write array[to] = array[i] → 5  [&o0.2: 1 → 5]
write to += 1 → 3
write i++ → 3 (i)
read array.length → 6
branch i < array.length → then
read array[i] → null
branch !!array[i] → else
… (13 further events)
~~~

Result graph: {"roots":[["ref","o0"],["undefined"]],"objects":[{"id":"o0","kind":"array","properties":[["0",["num",-8]],["1",["num",1]],["2",["num",5]],["3",["num",4]],["length",["num",4]]]}]}

### vscode/strings.ts/trim

Source: https://github.com/microsoft/vscode/blob/2bc7d5ab6919c62e60379e5e1f840bd80846dbdb/src/vs/base/common/strings.ts

Invoked with fixture 0; 66 events, 0 state changes, 6073 serialized event bytes.

~~~text
enter → trim
enter → ltrim
value !haystack → false
value !needle → false
branch !haystack || !needle → else
read needle.length → 1
write needleLen = needle.length → 1 (needleLen)
write offset = 0 → 0 (offset)
branch needleLen === 1 → then
call needle.charCodeAt(0) → 32
write ch = needle.charCodeAt(0) → 32 (ch)
read haystack.length → 18
value offset < haystack.length → true
call haystack.charCodeAt(offset) → 32
value haystack.charCodeAt(offset) === ch → true
branch offset < haystack.length && haystack.charCodeAt(offset) === ch → then
write offset++ → 0 (offset)
read haystack.length → 18
value offset < haystack.length → true
call haystack.charCodeAt(offset) → 32
value haystack.charCodeAt(offset) === ch → true
branch offset < haystack.length && haystack.charCodeAt(offset) === ch → then
write offset++ → 1 (offset)
read haystack.length → 18
value offset < haystack.length → true
call haystack.charCodeAt(offset) → 32
value haystack.charCodeAt(offset) === ch → true
branch offset < haystack.length && haystack.charCodeAt(offset) === ch → then
write offset++ → 2 (offset)
read haystack.length → 18
value offset < haystack.length → true
call haystack.charCodeAt(offset) → 72
value haystack.charCodeAt(offset) === ch → false
branch offset < haystack.length && haystack.charCodeAt(offset) === ch → else
call haystack.substring(offset) → "Hello world  0 "
return return haystack.substring(offset); → "Hello world  0 "
… (30 further events)
~~~

Result graph: {"roots":[["str","   Hello world  0 "],["str"," "],["str","Hello world  0"]],"objects":[]}

### lodash/_arrayMap.js/arrayMap

Source: https://github.com/lodash/lodash/blob/c6e281b878b315c7a10d90f9c2af4cdb112d9625/_arrayMap.js

Invoked with fixture 0; 54 events, 7 state changes, 5653 serialized event bytes.

~~~text
write module.exports = arrayMap → &o3  [&o3.name: absent → "arrayMap"]
enter → arrayMap
value -1 → -1
write index = -1 → -1 (index)
branch array == null → else
read array.length → 5
value array == null ? 0 : array.length → 5
write length = array == null ? 0 : array.length → 5 (length)
call Array(length) → &o4  [&o4.length: absent → 5]
write result = Array(length) → &o4 (result)
write ++index → 0 (index)
branch ++index < length → then
read array[index] → -8
enter → [callback]
value x*x → 64
return (x)=>x*x → 64
call iteratee(array[index], index, array) → 64
write result[index] = iteratee(array[index], index, array) → 64  [&o4.0: absent → 64]
write ++index → 1 (index)
branch ++index < length → then
read array[index] → 1
enter → [callback]
value x*x → 1
return (x)=>x*x → 1
call iteratee(array[index], index, array) → 1
write result[index] = iteratee(array[index], index, array) → 1  [&o4.1: absent → 1]
write ++index → 2 (index)
branch ++index < length → then
read array[index] → 1
enter → [callback]
value x*x → 1
return (x)=>x*x → 1
call iteratee(array[index], index, array) → 1
write result[index] = iteratee(array[index], index, array) → 1  [&o4.2: absent → 1]
write ++index → 3 (index)
branch ++index < length → then
… (18 further events)
~~~

Result graph: {"roots":[["ref","o1"],["ref","o2"],["ref","o4"]],"objects":[{"id":"o1","kind":"array","properties":[["0",["num",-8]],["1",["num",1]],["2",["num",1]],["3",["num",-2]],["4",["num",7]],["length",["num",5]]]},{"id":"o2","kind":"function","properties":[["name",["str",""]]]},{"id":"o4","kind":"array","properties":[["0",["num",64]],["1",["num",1]],["2",["num",1]],["3",["num",4]],["4",["num",49]],["length",["num",5]]]}]}

### lodash/_baseClamp.js/baseClamp

Source: https://github.com/lodash/lodash/blob/c6e281b878b315c7a10d90f9c2af4cdb112d9625/_baseClamp.js

Invoked with fixture 0; 13 events, 1 state changes, 1401 serialized event bytes.

~~~text
write module.exports = baseClamp → &o0  [&o0.name: absent → "baseClamp"]
enter → baseClamp
branch number === number → then
branch upper !== undefined → then
branch number <= upper → then
value number <= upper ? number : upper → -8
write number = number <= upper ? number : upper → -8
branch lower !== undefined → then
branch number >= lower → else
value number >= lower ? number : lower → -3
write number = number >= lower ? number : lower → -3
return return number; → -3
end → -3
~~~

Result graph: {"roots":[["num",-8],["num",-3],["num",3],["num",-3]],"objects":[]}

## Coverage and interpretation

- The measured trace contains source-anchored arithmetic, read, call, branch,
  return and write observations; state differences capture native array methods.
- Some intermediate local values remain implicit; inspect call/return and
  property values together when assessing reasoning sufficiency.
- Accessors and proxy traps are not invoked by the graph snapshot. Proxy
  internals, native module effects and asynchronous host work are incomplete.
- A large event count can indicate over-instrumented reads or repeated
  condition bookkeeping. Causal compaction should be evaluated separately.
- Do not equate uninstrumented-V8 outcome agreement with complete event-level
  verification or model-training admission.
