# Real-source trace quality audit

**Native V8 diagnostic only — not independently admitted training data.**

## Coverage
- observations: 936
- verified: 936
- functions: 78
- events: 27039
- reads: 2896
- calls: 3278
- branches: 4795
- mutations: 3656
- bytes: 2860237
- sourceBytes: 1251264
- opaqueResults: 0
- repeatedReadCandidates: 0
- sameValueWriteCandidates: 4039
- returnedCallCandidates: 1284
- unmappedSiteCandidates: 0
- limitations: 936

## Event types
- enter: 2679
- call: 3278
- return: 2583
- end: 936
- value: 4527
- branch: 4795
- read: 2896
- write: 5060
- loop: 263
- control: 22

## Inspection candidates

Flags identify noisy or underspecified observations. A same-value write may still be semantically important; do not delete events on these metrics alone.

### vscode/arrays.ts/quickSelect #7

Source: https://github.com/microsoft/vscode/blob/2bc7d5ab6919c62e60379e5e1f840bd80846dbdb/src/vs/base/common/arrays.ts

Verified final state: true; 153 events / 16767 bytes.
Candidate flags: {"sameValueWriteCandidates":16,"returnedCallCandidates":12}

```text
enter export function quickSelect<T>(nth: number, data: T[], compare: Compare<T>): T { nth = nth | 0; if ( → ["undefined"]
value nth | 0 → ["num",2]
write nth = nth | 0 → ["num",2]
read data.length → ["num",5]
branch nth >= data.length → ["bool",false]
read data.length → ["num",5]
call Math.random() → ["num",0.2523451747838408]
value data.length * Math.random() → ["num",1.2617258739192039]
call Math.floor(data.length * Math.random()) → ["num",1]
read data[Math.floor(data.length * Math.random())] → ["num",8]
write pivotValue = data[Math.floor(data.length * Math.random())] → ["num",8]
write lower: T[] = [] → ["ref","o3"] [effects: 1]
```

### vscode/arrays.ts/quickSelect #11

Source: https://github.com/microsoft/vscode/blob/2bc7d5ab6919c62e60379e5e1f840bd80846dbdb/src/vs/base/common/arrays.ts

Verified final state: true; 143 events / 15887 bytes.
Candidate flags: {"sameValueWriteCandidates":16,"returnedCallCandidates":12}

```text
enter export function quickSelect<T>(nth: number, data: T[], compare: Compare<T>): T { nth = nth | 0; if ( → ["undefined"]
value nth | 0 → ["num",1]
write nth = nth | 0 → ["num",1]
read data.length → ["num",5]
branch nth >= data.length → ["bool",false]
read data.length → ["num",5]
call Math.random() → ["num",0.2523451747838408]
value data.length * Math.random() → ["num",1.2617258739192039]
call Math.floor(data.length * Math.random()) → ["num",1]
read data[Math.floor(data.length * Math.random())] → ["num",12]
write pivotValue = data[Math.floor(data.length * Math.random())] → ["num",12]
write lower: T[] = [] → ["ref","o3"] [effects: 1]
```

### lodash/_baseSum.js/baseSum #9

Source: https://github.com/lodash/lodash/blob/c6e281b878b315c7a10d90f9c2af4cdb112d9625/_baseSum.js

Verified final state: true; 69 events / 6683 bytes.
Candidate flags: {"sameValueWriteCandidates":18,"returnedCallCandidates":5}

```text
write module.exports = baseSum → ["ref","o3"] [effects: 1]
enter function baseSum(array, iteratee) { var result, index = -1, length = array.length; while (++index <  → ["undefined"]
value -1 → ["num",-1]
write index = -1 → ["num",-1]
read array.length → ["num",5]
write length = array.length → ["num",5]
write ++index → ["num",0]
branch ++index < length → ["bool",true]
read array[index] → ["num",-15]
enter (x)=>x → ["undefined"]
return (x)=>x → ["num",-15]
call iteratee(array[index]) → ["num",-15]
```

### lodash/_baseSum.js/baseSum #11

Source: https://github.com/lodash/lodash/blob/c6e281b878b315c7a10d90f9c2af4cdb112d9625/_baseSum.js

Verified final state: true; 69 events / 6681 bytes.
Candidate flags: {"sameValueWriteCandidates":18,"returnedCallCandidates":5}

```text
write module.exports = baseSum → ["ref","o3"] [effects: 1]
enter function baseSum(array, iteratee) { var result, index = -1, length = array.length; while (++index <  → ["undefined"]
value -1 → ["num",-1]
write index = -1 → ["num",-1]
read array.length → ["num",5]
write length = array.length → ["num",5]
write ++index → ["num",0]
branch ++index < length → ["bool",true]
read array[index] → ["num",11]
enter (x)=>x → ["undefined"]
return (x)=>x → ["num",11]
call iteratee(array[index]) → ["num",11]
```

### lodash/_baseSum.js/baseSum #7

Source: https://github.com/lodash/lodash/blob/c6e281b878b315c7a10d90f9c2af4cdb112d9625/_baseSum.js

Verified final state: true; 69 events / 6679 bytes.
Candidate flags: {"sameValueWriteCandidates":18,"returnedCallCandidates":5}

```text
write module.exports = baseSum → ["ref","o3"] [effects: 1]
enter function baseSum(array, iteratee) { var result, index = -1, length = array.length; while (++index <  → ["undefined"]
value -1 → ["num",-1]
write index = -1 → ["num",-1]
read array.length → ["num",5]
write length = array.length → ["num",5]
write ++index → ["num",0]
branch ++index < length → ["bool",true]
read array[index] → ["num",-10]
enter (x)=>x → ["undefined"]
return (x)=>x → ["num",-10]
call iteratee(array[index]) → ["num",-10]
```

### lodash/_baseSum.js/baseSum #10

Source: https://github.com/lodash/lodash/blob/c6e281b878b315c7a10d90f9c2af4cdb112d9625/_baseSum.js

Verified final state: true; 69 events / 6678 bytes.
Candidate flags: {"sameValueWriteCandidates":18,"returnedCallCandidates":5}

```text
write module.exports = baseSum → ["ref","o3"] [effects: 1]
enter function baseSum(array, iteratee) { var result, index = -1, length = array.length; while (++index <  → ["undefined"]
value -1 → ["num",-1]
write index = -1 → ["num",-1]
read array.length → ["num",5]
write length = array.length → ["num",5]
write ++index → ["num",0]
branch ++index < length → ["bool",true]
read array[index] → ["num",-2]
enter (x)=>x → ["undefined"]
return (x)=>x → ["num",-2]
call iteratee(array[index]) → ["num",-2]
```

### lodash/_baseSum.js/baseSum #5

Source: https://github.com/lodash/lodash/blob/c6e281b878b315c7a10d90f9c2af4cdb112d9625/_baseSum.js

Verified final state: true; 69 events / 6674 bytes.
Candidate flags: {"sameValueWriteCandidates":18,"returnedCallCandidates":5}

```text
write module.exports = baseSum → ["ref","o3"] [effects: 1]
enter function baseSum(array, iteratee) { var result, index = -1, length = array.length; while (++index <  → ["undefined"]
value -1 → ["num",-1]
write index = -1 → ["num",-1]
read array.length → ["num",5]
write length = array.length → ["num",5]
write ++index → ["num",0]
branch ++index < length → ["bool",true]
read array[index] → ["num",-5]
enter (x)=>x → ["undefined"]
return (x)=>x → ["num",-5]
call iteratee(array[index]) → ["num",-5]
```

### lodash/_baseSum.js/baseSum #0

Source: https://github.com/lodash/lodash/blob/c6e281b878b315c7a10d90f9c2af4cdb112d9625/_baseSum.js

Verified final state: true; 69 events / 6673 bytes.
Candidate flags: {"sameValueWriteCandidates":18,"returnedCallCandidates":5}

```text
write module.exports = baseSum → ["ref","o3"] [effects: 1]
enter function baseSum(array, iteratee) { var result, index = -1, length = array.length; while (++index <  → ["undefined"]
value -1 → ["num",-1]
write index = -1 → ["num",-1]
read array.length → ["num",5]
write length = array.length → ["num",5]
write ++index → ["num",0]
branch ++index < length → ["bool",true]
read array[index] → ["num",-8]
enter (x)=>x → ["undefined"]
return (x)=>x → ["num",-8]
call iteratee(array[index]) → ["num",-8]
```

### lodash/_baseSum.js/baseSum #2

Source: https://github.com/lodash/lodash/blob/c6e281b878b315c7a10d90f9c2af4cdb112d9625/_baseSum.js

Verified final state: true; 69 events / 6673 bytes.
Candidate flags: {"sameValueWriteCandidates":18,"returnedCallCandidates":5}

```text
write module.exports = baseSum → ["ref","o3"] [effects: 1]
enter function baseSum(array, iteratee) { var result, index = -1, length = array.length; while (++index <  → ["undefined"]
value -1 → ["num",-1]
write index = -1 → ["num",-1]
read array.length → ["num",5]
write length = array.length → ["num",5]
write ++index → ["num",0]
branch ++index < length → ["bool",true]
read array[index] → ["num",-13]
enter (x)=>x → ["undefined"]
return (x)=>x → ["num",-13]
call iteratee(array[index]) → ["num",-13]
```

### lodash/_baseSum.js/baseSum #6

Source: https://github.com/lodash/lodash/blob/c6e281b878b315c7a10d90f9c2af4cdb112d9625/_baseSum.js

Verified final state: true; 69 events / 6671 bytes.
Candidate flags: {"sameValueWriteCandidates":18,"returnedCallCandidates":5}

```text
write module.exports = baseSum → ["ref","o3"] [effects: 1]
enter function baseSum(array, iteratee) { var result, index = -1, length = array.length; while (++index <  → ["undefined"]
value -1 → ["num",-1]
write index = -1 → ["num",-1]
read array.length → ["num",5]
write length = array.length → ["num",5]
write ++index → ["num",0]
branch ++index < length → ["bool",true]
read array[index] → ["num",8]
enter (x)=>x → ["undefined"]
return (x)=>x → ["num",8]
call iteratee(array[index]) → ["num",8]
```

### lodash/_baseSum.js/baseSum #4

Source: https://github.com/lodash/lodash/blob/c6e281b878b315c7a10d90f9c2af4cdb112d9625/_baseSum.js

Verified final state: true; 69 events / 6669 bytes.
Candidate flags: {"sameValueWriteCandidates":18,"returnedCallCandidates":5}

```text
write module.exports = baseSum → ["ref","o3"] [effects: 1]
enter function baseSum(array, iteratee) { var result, index = -1, length = array.length; while (++index <  → ["undefined"]
value -1 → ["num",-1]
write index = -1 → ["num",-1]
read array.length → ["num",5]
write length = array.length → ["num",5]
write ++index → ["num",0]
branch ++index < length → ["bool",true]
read array[index] → ["num",13]
enter (x)=>x → ["undefined"]
return (x)=>x → ["num",13]
call iteratee(array[index]) → ["num",13]
```

### lodash/_baseSum.js/baseSum #8

Source: https://github.com/lodash/lodash/blob/c6e281b878b315c7a10d90f9c2af4cdb112d9625/_baseSum.js

Verified final state: true; 69 events / 6667 bytes.
Candidate flags: {"sameValueWriteCandidates":18,"returnedCallCandidates":5}

```text
write module.exports = baseSum → ["ref","o3"] [effects: 1]
enter function baseSum(array, iteratee) { var result, index = -1, length = array.length; while (++index <  → ["undefined"]
value -1 → ["num",-1]
write index = -1 → ["num",-1]
read array.length → ["num",5]
write length = array.length → ["num",5]
write ++index → ["num",0]
branch ++index < length → ["bool",true]
read array[index] → ["num",3]
enter (x)=>x → ["undefined"]
return (x)=>x → ["num",3]
call iteratee(array[index]) → ["num",3]
```

### lodash/_baseSum.js/baseSum #1

Source: https://github.com/lodash/lodash/blob/c6e281b878b315c7a10d90f9c2af4cdb112d9625/_baseSum.js

Verified final state: true; 69 events / 6661 bytes.
Candidate flags: {"sameValueWriteCandidates":18,"returnedCallCandidates":5}

```text
write module.exports = baseSum → ["ref","o3"] [effects: 1]
enter function baseSum(array, iteratee) { var result, index = -1, length = array.length; while (++index <  → ["undefined"]
value -1 → ["num",-1]
write index = -1 → ["num",-1]
read array.length → ["num",5]
write length = array.length → ["num",5]
write ++index → ["num",0]
branch ++index < length → ["bool",true]
read array[index] → ["num",5]
enter (x)=>x → ["undefined"]
return (x)=>x → ["num",5]
call iteratee(array[index]) → ["num",5]
```

### lodash/_baseSum.js/baseSum #3

Source: https://github.com/lodash/lodash/blob/c6e281b878b315c7a10d90f9c2af4cdb112d9625/_baseSum.js

Verified final state: true; 69 events / 6660 bytes.
Candidate flags: {"sameValueWriteCandidates":18,"returnedCallCandidates":5}

```text
write module.exports = baseSum → ["ref","o3"] [effects: 1]
enter function baseSum(array, iteratee) { var result, index = -1, length = array.length; while (++index <  → ["undefined"]
value -1 → ["num",-1]
write index = -1 → ["num",-1]
read array.length → ["num",5]
write length = array.length → ["num",5]
write ++index → ["num",0]
branch ++index < length → ["bool",true]
read array[index] → ["num",0]
enter (x)=>x → ["undefined"]
return (x)=>x → ["num",0]
call iteratee(array[index]) → ["num",0]
```

### lodash/_arrayFilter.js/arrayFilter #7

Source: https://github.com/lodash/lodash/blob/c6e281b878b315c7a10d90f9c2af4cdb112d9625/_arrayFilter.js

Verified final state: true; 70 events / 7435 bytes.
Candidate flags: {"sameValueWriteCandidates":17,"returnedCallCandidates":5}

```text
write module.exports = arrayFilter → ["ref","o3"] [effects: 1]
enter function arrayFilter(array, predicate) { var index = -1, length = array == null ? 0 : array.length,  → ["undefined"]
value -1 → ["num",-1]
write index = -1 → ["num",-1]
branch array == null → ["bool",false]
read array.length → ["num",5]
value array == null ? 0 : array.length → ["num",5]
write length = array == null ? 0 : array.length → ["num",5]
write resIndex = 0 → ["num",0]
write result = [] → ["ref","o4"] [effects: 1]
write ++index → ["num",0]
branch ++index < length → ["bool",true]
```

### vscode/arrays.ts/quickSelect #4

Source: https://github.com/microsoft/vscode/blob/2bc7d5ab6919c62e60379e5e1f840bd80846dbdb/src/vs/base/common/arrays.ts

Verified final state: true; 118 events / 12763 bytes.
Candidate flags: {"sameValueWriteCandidates":12,"returnedCallCandidates":9}

```text
enter export function quickSelect<T>(nth: number, data: T[], compare: Compare<T>): T { nth = nth | 0; if ( → ["undefined"]
value nth | 0 → ["num",4]
write nth = nth | 0 → ["num",4]
read data.length → ["num",5]
branch nth >= data.length → ["bool",false]
read data.length → ["num",5]
call Math.random() → ["num",0.2523451747838408]
value data.length * Math.random() → ["num",1.2617258739192039]
call Math.floor(data.length * Math.random()) → ["num",1]
read data[Math.floor(data.length * Math.random())] → ["num",5]
write pivotValue = data[Math.floor(data.length * Math.random())] → ["num",5]
write lower: T[] = [] → ["ref","o3"] [effects: 1]
```

### vscode/arrays.ts/quickSelect #10

Source: https://github.com/microsoft/vscode/blob/2bc7d5ab6919c62e60379e5e1f840bd80846dbdb/src/vs/base/common/arrays.ts

Verified final state: true; 110 events / 12122 bytes.
Candidate flags: {"sameValueWriteCandidates":12,"returnedCallCandidates":9}

```text
enter export function quickSelect<T>(nth: number, data: T[], compare: Compare<T>): T { nth = nth | 0; if ( → ["undefined"]
value nth | 0 → ["num",0]
write nth = nth | 0 → ["num",0]
read data.length → ["num",5]
branch nth >= data.length → ["bool",false]
read data.length → ["num",5]
call Math.random() → ["num",0.2523451747838408]
value data.length * Math.random() → ["num",1.2617258739192039]
call Math.floor(data.length * Math.random()) → ["num",1]
read data[Math.floor(data.length * Math.random())] → ["num",11]
write pivotValue = data[Math.floor(data.length * Math.random())] → ["num",11]
write lower: T[] = [] → ["ref","o3"] [effects: 1]
```

### lodash/_arrayFilter.js/arrayFilter #10

Source: https://github.com/lodash/lodash/blob/c6e281b878b315c7a10d90f9c2af4cdb112d9625/_arrayFilter.js

Verified final state: true; 68 events / 7099 bytes.
Candidate flags: {"sameValueWriteCandidates":16,"returnedCallCandidates":5}

```text
write module.exports = arrayFilter → ["ref","o3"] [effects: 1]
enter function arrayFilter(array, predicate) { var index = -1, length = array == null ? 0 : array.length,  → ["undefined"]
value -1 → ["num",-1]
write index = -1 → ["num",-1]
branch array == null → ["bool",false]
read array.length → ["num",5]
value array == null ? 0 : array.length → ["num",5]
write length = array == null ? 0 : array.length → ["num",5]
write resIndex = 0 → ["num",0]
write result = [] → ["ref","o4"] [effects: 1]
write ++index → ["num",0]
branch ++index < length → ["bool",true]
```

### lodash/_arrayFilter.js/arrayFilter #0

Source: https://github.com/lodash/lodash/blob/c6e281b878b315c7a10d90f9c2af4cdb112d9625/_arrayFilter.js

Verified final state: true; 68 events / 7095 bytes.
Candidate flags: {"sameValueWriteCandidates":16,"returnedCallCandidates":5}

```text
write module.exports = arrayFilter → ["ref","o3"] [effects: 1]
enter function arrayFilter(array, predicate) { var index = -1, length = array == null ? 0 : array.length,  → ["undefined"]
value -1 → ["num",-1]
write index = -1 → ["num",-1]
branch array == null → ["bool",false]
read array.length → ["num",5]
value array == null ? 0 : array.length → ["num",5]
write length = array == null ? 0 : array.length → ["num",5]
write resIndex = 0 → ["num",0]
write result = [] → ["ref","o4"] [effects: 1]
write ++index → ["num",0]
branch ++index < length → ["bool",true]
```

### lodash/_arrayFilter.js/arrayFilter #5

Source: https://github.com/lodash/lodash/blob/c6e281b878b315c7a10d90f9c2af4cdb112d9625/_arrayFilter.js

Verified final state: true; 68 events / 7093 bytes.
Candidate flags: {"sameValueWriteCandidates":16,"returnedCallCandidates":5}

```text
write module.exports = arrayFilter → ["ref","o3"] [effects: 1]
enter function arrayFilter(array, predicate) { var index = -1, length = array == null ? 0 : array.length,  → ["undefined"]
value -1 → ["num",-1]
write index = -1 → ["num",-1]
branch array == null → ["bool",false]
read array.length → ["num",5]
value array == null ? 0 : array.length → ["num",5]
write length = array == null ? 0 : array.length → ["num",5]
write resIndex = 0 → ["num",0]
write result = [] → ["ref","o4"] [effects: 1]
write ++index → ["num",0]
branch ++index < length → ["bool",true]
```

### lodash/_arrayFilter.js/arrayFilter #9

Source: https://github.com/lodash/lodash/blob/c6e281b878b315c7a10d90f9c2af4cdb112d9625/_arrayFilter.js

Verified final state: true; 68 events / 7092 bytes.
Candidate flags: {"sameValueWriteCandidates":16,"returnedCallCandidates":5}

```text
write module.exports = arrayFilter → ["ref","o3"] [effects: 1]
enter function arrayFilter(array, predicate) { var index = -1, length = array == null ? 0 : array.length,  → ["undefined"]
value -1 → ["num",-1]
write index = -1 → ["num",-1]
branch array == null → ["bool",false]
read array.length → ["num",5]
value array == null ? 0 : array.length → ["num",5]
write length = array == null ? 0 : array.length → ["num",5]
write resIndex = 0 → ["num",0]
write result = [] → ["ref","o4"] [effects: 1]
write ++index → ["num",0]
branch ++index < length → ["bool",true]
```

### lodash/_arrayFilter.js/arrayFilter #3

Source: https://github.com/lodash/lodash/blob/c6e281b878b315c7a10d90f9c2af4cdb112d9625/_arrayFilter.js

Verified final state: true; 68 events / 7081 bytes.
Candidate flags: {"sameValueWriteCandidates":16,"returnedCallCandidates":5}

```text
write module.exports = arrayFilter → ["ref","o3"] [effects: 1]
enter function arrayFilter(array, predicate) { var index = -1, length = array == null ? 0 : array.length,  → ["undefined"]
value -1 → ["num",-1]
write index = -1 → ["num",-1]
branch array == null → ["bool",false]
read array.length → ["num",5]
value array == null ? 0 : array.length → ["num",5]
write length = array == null ? 0 : array.length → ["num",5]
write resIndex = 0 → ["num",0]
write result = [] → ["ref","o4"] [effects: 1]
write ++index → ["num",0]
branch ++index < length → ["bool",true]
```

### lodash/_arrayFilter.js/arrayFilter #11

Source: https://github.com/lodash/lodash/blob/c6e281b878b315c7a10d90f9c2af4cdb112d9625/_arrayFilter.js

Verified final state: true; 66 events / 6751 bytes.
Candidate flags: {"sameValueWriteCandidates":15,"returnedCallCandidates":5}

```text
write module.exports = arrayFilter → ["ref","o3"] [effects: 1]
enter function arrayFilter(array, predicate) { var index = -1, length = array == null ? 0 : array.length,  → ["undefined"]
value -1 → ["num",-1]
write index = -1 → ["num",-1]
branch array == null → ["bool",false]
read array.length → ["num",5]
value array == null ? 0 : array.length → ["num",5]
write length = array == null ? 0 : array.length → ["num",5]
write resIndex = 0 → ["num",0]
write result = [] → ["ref","o4"] [effects: 1]
write ++index → ["num",0]
branch ++index < length → ["bool",true]
```

### lodash/_arrayFilter.js/arrayFilter #2

Source: https://github.com/lodash/lodash/blob/c6e281b878b315c7a10d90f9c2af4cdb112d9625/_arrayFilter.js

Verified final state: true; 66 events / 6745 bytes.
Candidate flags: {"sameValueWriteCandidates":15,"returnedCallCandidates":5}

```text
write module.exports = arrayFilter → ["ref","o3"] [effects: 1]
enter function arrayFilter(array, predicate) { var index = -1, length = array == null ? 0 : array.length,  → ["undefined"]
value -1 → ["num",-1]
write index = -1 → ["num",-1]
branch array == null → ["bool",false]
read array.length → ["num",5]
value array == null ? 0 : array.length → ["num",5]
write length = array == null ? 0 : array.length → ["num",5]
write resIndex = 0 → ["num",0]
write result = [] → ["ref","o4"] [effects: 1]
write ++index → ["num",0]
branch ++index < length → ["bool",true]
```

### lodash/_arrayFilter.js/arrayFilter #6

Source: https://github.com/lodash/lodash/blob/c6e281b878b315c7a10d90f9c2af4cdb112d9625/_arrayFilter.js

Verified final state: true; 66 events / 6745 bytes.
Candidate flags: {"sameValueWriteCandidates":15,"returnedCallCandidates":5}

```text
write module.exports = arrayFilter → ["ref","o3"] [effects: 1]
enter function arrayFilter(array, predicate) { var index = -1, length = array == null ? 0 : array.length,  → ["undefined"]
value -1 → ["num",-1]
write index = -1 → ["num",-1]
branch array == null → ["bool",false]
read array.length → ["num",5]
value array == null ? 0 : array.length → ["num",5]
write length = array == null ? 0 : array.length → ["num",5]
write resIndex = 0 → ["num",0]
write result = [] → ["ref","o4"] [effects: 1]
write ++index → ["num",0]
branch ++index < length → ["bool",true]
```

### lodash/_arrayFilter.js/arrayFilter #1

Source: https://github.com/lodash/lodash/blob/c6e281b878b315c7a10d90f9c2af4cdb112d9625/_arrayFilter.js

Verified final state: true; 66 events / 6743 bytes.
Candidate flags: {"sameValueWriteCandidates":15,"returnedCallCandidates":5}

```text
write module.exports = arrayFilter → ["ref","o3"] [effects: 1]
enter function arrayFilter(array, predicate) { var index = -1, length = array == null ? 0 : array.length,  → ["undefined"]
value -1 → ["num",-1]
write index = -1 → ["num",-1]
branch array == null → ["bool",false]
read array.length → ["num",5]
value array == null ? 0 : array.length → ["num",5]
write length = array == null ? 0 : array.length → ["num",5]
write resIndex = 0 → ["num",0]
write result = [] → ["ref","o4"] [effects: 1]
write ++index → ["num",0]
branch ++index < length → ["bool",true]
```

### lodash/_arrayFilter.js/arrayFilter #4

Source: https://github.com/lodash/lodash/blob/c6e281b878b315c7a10d90f9c2af4cdb112d9625/_arrayFilter.js

Verified final state: true; 66 events / 6742 bytes.
Candidate flags: {"sameValueWriteCandidates":15,"returnedCallCandidates":5}

```text
write module.exports = arrayFilter → ["ref","o3"] [effects: 1]
enter function arrayFilter(array, predicate) { var index = -1, length = array == null ? 0 : array.length,  → ["undefined"]
value -1 → ["num",-1]
write index = -1 → ["num",-1]
branch array == null → ["bool",false]
read array.length → ["num",5]
value array == null ? 0 : array.length → ["num",5]
write length = array == null ? 0 : array.length → ["num",5]
write resIndex = 0 → ["num",0]
write result = [] → ["ref","o4"] [effects: 1]
write ++index → ["num",0]
branch ++index < length → ["bool",true]
```

### vscode/arrays.ts/quickSelect #3

Source: https://github.com/microsoft/vscode/blob/2bc7d5ab6919c62e60379e5e1f840bd80846dbdb/src/vs/base/common/arrays.ts

Verified final state: true; 110 events / 11884 bytes.
Candidate flags: {"sameValueWriteCandidates":11,"returnedCallCandidates":8}

```text
enter export function quickSelect<T>(nth: number, data: T[], compare: Compare<T>): T { nth = nth | 0; if ( → ["undefined"]
value nth | 0 → ["num",3]
write nth = nth | 0 → ["num",3]
read data.length → ["num",5]
branch nth >= data.length → ["bool",false]
read data.length → ["num",5]
call Math.random() → ["num",0.2523451747838408]
value data.length * Math.random() → ["num",1.2617258739192039]
call Math.floor(data.length * Math.random()) → ["num",1]
read data[Math.floor(data.length * Math.random())] → ["num",4]
write pivotValue = data[Math.floor(data.length * Math.random())] → ["num",4]
write lower: T[] = [] → ["ref","o3"] [effects: 1]
```

### vscode/arrays.ts/quickSelect #5

Source: https://github.com/microsoft/vscode/blob/2bc7d5ab6919c62e60379e5e1f840bd80846dbdb/src/vs/base/common/arrays.ts

Verified final state: true; 102 events / 11240 bytes.
Candidate flags: {"sameValueWriteCandidates":11,"returnedCallCandidates":8}

```text
enter export function quickSelect<T>(nth: number, data: T[], compare: Compare<T>): T { nth = nth | 0; if ( → ["undefined"]
value nth | 0 → ["num",0]
write nth = nth | 0 → ["num",0]
read data.length → ["num",5]
branch nth >= data.length → ["bool",false]
read data.length → ["num",5]
call Math.random() → ["num",0.2523451747838408]
value data.length * Math.random() → ["num",1.2617258739192039]
call Math.floor(data.length * Math.random()) → ["num",1]
read data[Math.floor(data.length * Math.random())] → ["num",6]
write pivotValue = data[Math.floor(data.length * Math.random())] → ["num",6]
write lower: T[] = [] → ["ref","o3"] [effects: 1]
```

### vscode/arrays.ts/quickSelect #0

Source: https://github.com/microsoft/vscode/blob/2bc7d5ab6919c62e60379e5e1f840bd80846dbdb/src/vs/base/common/arrays.ts

Verified final state: true; 102 events / 11235 bytes.
Candidate flags: {"sameValueWriteCandidates":11,"returnedCallCandidates":8}

```text
enter export function quickSelect<T>(nth: number, data: T[], compare: Compare<T>): T { nth = nth | 0; if ( → ["undefined"]
value nth | 0 → ["num",0]
write nth = nth | 0 → ["num",0]
read data.length → ["num",5]
branch nth >= data.length → ["bool",false]
read data.length → ["num",5]
call Math.random() → ["num",0.2523451747838408]
value data.length * Math.random() → ["num",1.2617258739192039]
call Math.floor(data.length * Math.random()) → ["num",1]
read data[Math.floor(data.length * Math.random())] → ["num",1]
write pivotValue = data[Math.floor(data.length * Math.random())] → ["num",1]
write lower: T[] = [] → ["ref","o3"] [effects: 1]
```
