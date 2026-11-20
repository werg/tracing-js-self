# Owned synchronous iterator profile

The strict frontend lowers `for…of` through ordinary lookup, call, selection,
binding and completion instructions. The iterable is evaluated once. A custom
`Symbol.iterator` method is invoked with the original receiver, its result must
be an object, and its `next` method is retained once for the loop. Each result
must be an object; `done` is read before `value` and coerced only for the test.

The loop retains an owned cleanup obligation after successfully obtaining a
value. Break, return, binding failure, body throw and outward labelled exits
close the iterator. `continue` on that same loop does not. Failed `next`, `done`
or `value` evaluation does not invent a closing obligation. Iterator closing
looks up `return` at close time; null/undefined means absent. A prior throw wins
over a throwing getter/call or a nonobject close result; without a prior throw,
those failures replace the pending completion. All of this state is in owned
environments, handler records and frames, and survives ordinary JSON replay.

Ordinary standard arrays retain the previous indexed lowering only after a
guard proves that the standard iterator is selected. An own iterator method or
custom prototype takes the general protocol path. Array `values`, `keys` and
`entries`, plus Unicode code-point string iteration, have explicit owned
iterator records and `next` transitions. Array iterator length is live; once
done, the iterator remains done. Complex index accessors on explicitly created
builtin iterator objects remain a refusal; normal array `for…of` retains its
existing owned getter path.

Nested declaration patterns in loop headers reuse the existing binding
compiler, including object rest, array rest and defaults. Array patterns inside
those bindings still have their separately recorded standard-array domain.
Async iteration, generator delegation and general iterator consumption by
spread/destructuring are separate followup slices, not implied by this one.

The standard-array path remains covered by detailed source projection and
replay. General protocol execution is independently checked against V8 and its
source operation, branch and completion receipts. Existing detailed/native
formats cannot encode general iterator state or Symbol keys, so general
protocol projection is explicitly refused. `test/training-iterator-protocol.test.js`
tests acquisition caching, receivers, live mutation, holes, code points,
lexical TDZ, cleanup ordering, abrupt precedence and this boundary.

Pinned semantic references:

- [ECMAScript 2026 iterator abstract operations](https://tc39.es/ecma262/2026/multipage/abstract-operations.html#sec-operations-on-iterator-objects).
- [IteratorClose](https://tc39.es/ecma262/2026/multipage/abstract-operations.html#sec-iteratorclose).
- [ForIn/OfBodyEvaluation](https://tc39.es/ecma262/2026/multipage/ecmascript-language-statements-and-declarations.html#sec-runtime-semantics-forinofbodyevaluation-lhs-stmt-iterator-lhskind-labelset).
