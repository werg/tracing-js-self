# Production semantic traces, version 6

`semantic-trace/6` is the production model wire language. `encodeWitness` writes
these bytes into generated semantic records, and `decodeWitness` parses these
same bytes before the selected controller applies a claim. This is not a
presentation layer over JSON targets.

For a simple computation the model reads and predicts:

```text
compute (x + 2) => 6 as y in @call1 at 20..25
return 6 in @call1
end return
```

A publicly proven, bounded pure region can be one semantic prediction:

```text
evaluate twice(3) => 6 in @call1
end return
```

These regions are enabled by default in the production compiler. The bounded
profiles cover primitive expression returns, conditional and short-circuit
expressions, and a counted sum over a dense ordinary numeric array. Up to four
acyclic calls to statically named pure helpers are included in the same region;
the complete expression tree is limited to eight operators and 32 nodes. Dense
sums have a production limit of 128 iterations. A three-element sum becomes:

```text
evaluate sum(@o1) => 9 over 3 items into total
end return
```

The model predicts the result and, for control expressions, the exact ordered
executed decisions. The public checker uses only immutable source and current
input arguments. It applies explicit primitive rules without evaluating source
text or calling a guest function. A wrong branch remains wrong even when both
branches return the same value. A whole-region record is permitted only at an
untouched invocation entry; it cannot skip earlier selected work or absorb an
external observation.

The compiler retains the full owned journal and an exact region certificate.
Independent V8 source, operation, branch, and completion checks still gate
training admission. Source shapes with mutation, getters, ambient state,
recursion, exceptions, async work, callbacks or external effects keep their
detailed semantic boundaries. `semanticRegions: false` is an explicit
diagnostic control using the same v6 language. Repeated writes of the exact
already-committed value to the same lexical cell are also omitted by default,
with a private receipt; distinct aliases, property writes and intermediate
changes remain visible.

An object identity appears where aliasing matters:

```text
new @o1 object {"answer": 6}
read @o1["answer"] => 6
write @o1["answer"] = 7
return @o1
end return
```

Numbers, booleans, strings, null and undefined do not receive synthetic value
identities. An `@` name links a heap object, effect, invocation, promise, job,
continuation or transport record. Source bindings retain their source names.

## Contracts and authority

The current contracts are `semantic-trace/6`, `semantic-context/6`,
`semantic-execution/6` and `semantic-continuation/6`. V5 JSON witness records are
rejected. There is no mixed-version parser or compatibility mode. The harness
profile remains `selected-harness/2`; supervision remains
`semantic-supervision/2` because observed versus generated authority is unchanged.

The internal API stays `{kind, fields}`. Each field has the existing checked
meaning; the writer replaces its wire spelling, not its authority. The parser
returns the complete internal claim, validates its exact allowed and required
fields, then re-encodes it and requires byte-for-byte equality. Parsing never
evaluates JavaScript. Source validation, immutable source ownership, public heap
checks, host operation authorization and result consistency are separate checks.
An accepted line is well formed; it is not thereby a true execution claim.

Source and input records are observed context. External observations and harness
envelopes retain their observed authority. Generated records cannot turn a future
observation into a target or invent an owned identity merely by spelling `@id`.

## Lexical rules

Each record is exactly one line with no CR or LF. Keywords and separators below
are literal. Spaces shown in the grammar are required single ASCII spaces;
leading spaces, trailing spaces, tabs, omitted spaces and extra spaces are
rejected. No semicolons, comments or optional JavaScript formatting are accepted.

| Slot | Meaning |
| --- | --- |
| `VALUE` | One scalar or heap reference from the table below. |
| `VALUES` | Zero or more `VALUE`s separated by `, `, inside the displayed parentheses. |
| `NAME` | An ECMAScript source identifier, including Unicode identifier characters, `$` and `_`. |
| `SYMBOL` | A bare source identifier or dotted source identifiers; otherwise a canonical JSON string. Thus `Host.log`, but `"function:76"`. |
| `@ID` | A checked identity. Heap/effect/job/promise/continuation/transport IDs match `[a-z][a-z0-9]*`. |
| `@INV` | A routed invocation or owner identity matching `[a-z][a-z0-9:_-]*`. |
| `START..END` | Safe nonnegative decimal integers with `END > START`, identifying immutable source offsets. |
| `STRING` | A double-quoted canonical `JSON.stringify` string, including its canonical escapes. |
| `JSON` | Compact JSON data with no extra whitespace, duplicate keys or lossy values. Object member order is retained as part of the structured data. |
| `N` | A nonnegative decimal safe integer without leading zeroes. |

`JSON` is used for observed source/input graphs, the already canonical external
payload and opaque host metadata. Semantic claim fields do not use a surrounding
kind-plus-JSON record. Values inside graphs keep the existing tagged graph
representation so alias ownership and graph validation remain explicit.

| Internal tagged value | Production spelling |
| --- | --- |
| `["undefined"]` | `undefined` |
| `["null"]` | `null` |
| `["bool", true]`, `["bool", false]` | `true`, `false` |
| `["str", "text"]` | `"text"` |
| `["num", 6]` | `6` |
| `["num", "-0"]` | `-0` |
| `["num", "NaN"]` | `NaN` |
| `["num", "+Infinity"]`, `["num", "-Infinity"]` | `Infinity`, `-Infinity` |
| `["bigint", "12"]`, `["bigint", "-12"]` | `12n`, `-12n` |
| `["ref", "o1"]` | `@o1` |

Finite numbers use the exact ECMAScript `JSON.stringify` binary64 spelling.
Examples are `0.000001`, `1e-7`, `100000000000000000000` and `1e+21`.
`6.0`, `+6`, `06`, `6e0`, hexadecimal, numeric separators, `1E+21` and
unrounded decimal aliases are rejected. `-0` is distinct from `0`; bigint zero
is `0n`, never `-0n`. Invalid finite overflow is rejected, not converted to an
infinity spelling.

## Expressions

Expressions preserve the public expression tree; parentheses and spaces make
that tree unambiguous without invoking a JavaScript parser or evaluator.

```text
EXPR := VALUE
      | NAME
      | local(STRING)
      | @ID[STRING]
      | random()
      | (UNARY EXPR)
      | (EXPR BINARY EXPR)
```

`local(STRING)` is canonical only for source names that are also scalar keywords:
`undefined`, `null`, `true`, `false`, `NaN` and `Infinity`. Ordinary locals use
their bare name. Unary operators are `!`, `+`, `-`, `~`, `typeof`, `void`; the
space after the operator is required. Thus `(- 1)` is a unary expression and
`(-1 + 2)` has a negative numeric literal as its left operand.

Binary operators are `+ - * / % ** < <= > >= === !== == != & | ^ << >> >>>`.
Every binary operation is fully parenthesized. The existing maximum is 32
expression nodes and eight operators. `random()` is a standalone computation,
not a composable expression operand. Property reads name an existing public
object and a literal string key. Ambient lookups, arbitrary calls, getters and
generated source code are outside this expression grammar.

## Complete record grammar

Square brackets below denote an optional grammar clause, not emitted brackets.
Braces in allocations and captures are emitted literally. `PROPERTIES` is a
sequence of `STRING: VALUE` entries separated by `, `; `CAPTURES` is a sequence
of `NAME: NAME` source-cell relations separated by `, `. Both can be empty.

| Internal kind | Exact line form, before any common suffix |
| --- | --- |
| `code` | `source STRING = STRING sites JSON[ seed N]` |
| `input` | `input JSON[ retained JSON]` |
| `compute` | `compute EXPR => VALUE[ as NAME]` |
| `choose` | `choose EXPR => VALUE -> PATH` |
| `bind` | `NAME = VALUE[ from NAME]` |
| `allocate` | `new @ID KIND {PROPERTIES}[ length N][ code STRING][ captures {CAPTURES}]` |
| `read` | `read @ID[STRING] => VALUE[ absent]` |
| `write` | `write @ID[STRING] = VALUE[ absent]` |
| `call` | `call SYMBOL(VALUES) this VALUE -> @INV` |
| `transfer` | `transfer COMPLETION VALUE via JSON` |
| `return` | `return VALUE` |
| `throw` | `throw VALUE` |
| `request` | `request @ID SYMBOL(VALUES) payload JSON[ promise @ID]` |
| `observe` | `observe @ID STATUS VALUE[ graph JSON]` |
| `job` | `job ACTION @ID for @INV[ result JSON][ closure @ID]` |
| `promise` | See the action forms below. |
| `await` | `await @ID as @ID[ returns @ID]` |
| `resume` | `resume @ID STATUS VALUE` |
| `summarize` | See the region forms below. |
| `end` | `end return` or `end throw` |
| `value-open` | `record @ID type STRING` |
| `value-part` | `part @ID STRING` |
| `value-close` | `close @ID` |

`PATH` is `then`, `else`, `use-left` or `evaluate-right`. Allocation `KIND` is
`object`, `array`, `closure`, `set` or `regexp`; `length` belongs to arrays,
while `code` and `captures` belong to closures. Duplicate property keys or
capture bindings are rejected. Distinct capture bindings can share one cell.
The `from` binding relation cannot name the destination itself.

`COMPLETION` is `return`, `throw` or `cleanup`. `STATUS` is `fulfilled` or
`rejected`. Job `ACTION` is `enqueue`, `dispatch` or `complete`; a job closure
can only appear on `enqueue`. An absent property explicitly has the `absent`
suffix, so a present property whose value is `undefined` remains distinguishable.

The common suffix order is `[ in @INV][ at START..END]`. `in` is allowed for
`compute`, `choose`, `allocate`, `read`, `write`, `bind`, `call`, `transfer`,
`return`, `throw`, `request`, `promise`, `await`, `resume` and `summarize`.
It is required for `request`, `await` and `resume`. `at` is allowed only for
`compute`, `choose` and `request`, and is required for `request`. No record can
silently accept an irrelevant suffix. The call child after `->` is distinct
from the optional active caller after `in`.

Promise action forms are:

```text
promise create @ID
promise resolve @ID = VALUE
promise reject @ID = VALUE
promise adopt @ID -> @ID
promise react @ID REACTION as @ID[ closure @ID][ reject @ID][ target @ID]
```

The first identity is the promise. In `react`, the identity after `as` is the
job and `REACTION` is `then`, `catch` or `finally`. The `reject` closure is
allowed only for `then`. Every action rejects fields belonging to another
action. The common optional invocation suffix follows the complete action.

## Production region claims

Three production forms describe an entire recognized, effect-free entry:

```text
evaluate ENTRY(VALUES) => VALUE
evaluate ENTRY(VALUES) => VALUE choosing START..END:SELECTION, ...
evaluate ENTRY(VALUES) => VALUE over N items into NAME
```

They map respectively to `pure-helper/1`, `pure-control-helper/1` and
`dense-array-sum/1`. `ENTRY` is a source identifier. Arguments, result, entry
and profile are required internally. The optional invocation suffix comes last.

The control form carries a nonempty, ordered list of at most 32 decisions.
`SELECTION` is `consequent`, `alternate`, `left` or `right`. Repeated sites are
valid syntax because separate calls can execute the same helper source.
The source verifier checks the exact executed sequence, including short-circuit
behavior; listing all syntactic branches does not establish a valid claim.

The sum form carries `iterations` and the source accumulator binding. The wire
hard limit is 1024 iterations; admission can impose a smaller execution bound.
The public-source inspector and committed heap determine whether the input is
an allowed dense numeric array and whether the exact source loop is eligible.
All input preservation and absence of effects are properties of that proof,
not model-provided `inputUnchanged` booleans. Each profile rejects the optional
fields belonging to another profile. A terminal `end return` remains a separate
generated record after the region return claim.

## Framing and implementation checks

Records that exceed a configured byte capacity use explicit `record`, `part`
and `close` transport lines. Each part contains a JSON string holding a segment
of the exact semantic line. The transport ID is `r` followed by the complete
line's UTF-8 byte count; the opening type is `"semantic-record"`. Reassembly
checks identity, ordering, closure, byte count and the final strict semantic
parse. It refuses orphaned, interleaved or incomplete frames. Unicode code
points and quoted escapes survive fragmentation without byte substitution.

The checked-in cross-language fixture is
`test/fixtures/semantic-trace-v6.json`. It includes every record kind, promise
action, region profile, primitive spelling, numeric threshold and malformed
alternative used by both JavaScript and the independent native parser.
`test/training-trace-v6.test.js` checks exact bytes and full typed round trips,
irrelevant fields, expression budgets, source-name ambiguity, no evaluation of
untrusted text and transport restoration. The broader controller and source
proof tests establish semantic authority beyond this codec contract.
