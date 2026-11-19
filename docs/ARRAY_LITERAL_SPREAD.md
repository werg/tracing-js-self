# Bounded array literal spread

The training frontend accepts array literals that mix ordinary elements and
spread elements, such as `[0, ...xs, 3, ...ys]`. The owned runtime executes
them and the existing production `semantic-trace/5` controller replays their
allocations, reads and writes. No experimental summary record is introduced.

| Input or construct | Current behavior |
| --- | --- |
| Ordinary dense owned array with its original array prototype | Copies each value in index order; reference values keep their identity. |
| Primitive string | Copies Unicode code points. A surrogate pair produces one element; an unpaired surrogate remains one code unit. |
| Empty array or string | Appends no elements. |
| Mixed elements and spreads | Evaluates each expression once, from left to right. |
| Sparse literal or sparse spread input | Explicit refusal; holes are not silently converted into invented data. |
| Accessors, custom/null array prototypes, proxies or other iterators | Explicit refusal until their iterator behavior has an owned implementation. |
| Resource bounds | At most four spreads in a source array literal or call; at most 10,000 expanded values per spread, result array or call. |

## Evaluation order is part of the meaning

The same bounded spread operation serves array literals, ordinary calls and
optional calls. It captures values when the spread is evaluated, before the
next element or argument can change the input. This repairs a demonstrated
existing call-order defect:

```js
"use strict";
function run() {
  const collect = (...ys) => ys;
  const xs = [1, 2];
  return collect(...xs, xs.push(3));
}
```

The correct result is `[1, 2, 3]`. Previously, the runtime expanded `xs` only
after evaluating `xs.push(3)` and returned `[1, 2, 3, 3]`. The independent
source gate detected that mismatch and refused the example. The repaired
path captures `[1, 2]` first and then evaluates the final argument.

Captured values are a private machine snapshot, not a guest array or a new
model target. Object identities inside the snapshot remain shared: changing
an object's property later also changes that object when reached through the
copied reference. Every array source read retains its property version and
supplying event. Array creation and appends project through the current
production allocation, read and mutation records. Arrays without spreads keep
their existing compilation path.

## Evidence and reproduction

```sh
node --test test/training-array-spread.test.js \
  test/training-rest-spread-corpus.test.js \
  test/training-array-callback-extensions.test.js \
  test/training-effectful-v4.test.js
```

The tests compare actual owned results with independent V8 execution, recheck
the serialized source evidence, validate exact journal replay and replay the
public production trace. The full admission path also checks independently
observed intermediate completions and an external store operation after an
array copy. Regression cases cover mutations after a spread, multiple spreads,
one-time evaluation, aliasing, string code points, an altered read receipt,
resource limits and explicit out-of-profile refusals.

The capability ledger includes separate probes for array literal spread,
string code-point spread and call-spread evaluation order. Their native and
model-learning stages remain untested until those actual gates execute; local
source/replay success does not establish either stage.
