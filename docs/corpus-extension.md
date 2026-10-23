# Expanding `tracing-js-self` into a massive JS/TS execution corpus

## Executive recommendation

After inspecting the repository, I think the best approach is to combine **large existing test suites, real-world open-source projects, automatically extracted test inputs, and generated input variations**.

The most promising opportunity is not simply collecting millions of JavaScript and TypeScript files. It is collecting millions of **reproducible executions** in which we know:

1. The original source code and its dependencies.
2. The precise entry point.
3. The input arguments and initial program state.
4. The expected return value, exception, mutations, and external effects.
5. Enough environmental information to reproduce the execution.
6. The provenance and license of the source.

Your existing corpus architecture is particularly well suited to this.

### What you already have

I inspected `corpus/README.md`, `corpus/cases.mjs`, `corpus/FULL_CORPUS_EVAL.md`, the stateful benchmark, and the training-data design.

Your current baseline is:

| Corpus | Programs / scenario families | Executions | Evidence |
|---|---:|---:|---|
| VS Code + Lodash | 78 functions | 936 | 558 locally verified owned traces |
| Eight production libraries | 76 scenario families | 912 | 912 independently checked V8 diagnostic executions |
| **Combined** | **154 families** | **1,848** | Two distinct verification levels |

The eight-library benchmark covers event emitters, state management, queues, caches, middleware, concurrency, and Axios interceptors.

Importantly, your repository already contains much of the infrastructure needed for expansion:

- Pinned upstream revisions and source-file hashes.
- Original-source extraction and TypeScript lowering.
- Deterministic invocation fixtures.
- Independent V8 outcome comparisons.
- Project-level train/validation/test separation.
- A bounded owned interpreter with explicit coverage refusals.
- A separate diagnostic observation pipeline for code that the owned interpreter cannot yet execute.

The distinction between **diagnostic V8 observations** and **locally verified owned semantic traces** is essential. I would preserve it throughout expansion.

### The opportunity

I would pursue four complementary acquisition strategies:

| Strategy | Potential scale | Principal value |
|---|---|---|
| Import established JS/TS test suites | Tens to hundreds of thousands of tests | Explicit assertions and semantic edge cases |
| Mine production repositories together with their tests | Hundreds of thousands to millions of invocations | Realistic code, dependencies, mutations, application behavior |
| Import algorithm/problem collections | Thousands to tens of thousands of programs | Input/output diversity, loops, recursion, algorithms |
| Generate structured input variations for collected programs | Millions of execution attempts | Branch, boundary, state and trace diversity |

These are planning ranges, not measured yields.

**My proposed target would be 100,000 distinct executable program families and 1–10 million reproducible executions**, while separately tracking how many can pass your stronger owned-trace verification requirements.

The crucial design principle is:

> Acquire programs and inputs much faster than the owned interpreter gains language coverage, but never confuse the resulting diagnostic executions with verified semantic-trace training examples.

This would give you both a large dataset and a continually expanding set of concrete implementation targets.

---

## 1. Highest-priority sources

These are the sources I would investigate first, ranked by their usefulness to your specific project.

### Tier A: Existing executable tests and production code

| Priority | Source | What to extract | Why it matters | Main obstacle |
|---|---|---|---|---|
| **1** | [Test262](https://github.com/tc39/test262?utm_source=chatgpt.com) | Standalone JS tests, assertions, harness inputs | Enormous semantic coverage | Test harness adaptation |
| **2** | [Lodash](https://github.com/lodash/lodash?utm_source=chatgpt.com) | Entire library and test suite | Direct extension of your existing corpus | Internal dependencies |
| **3** | [Deno Standard Library](https://github.com/denoland/std?utm_source=chatgpt.com) | TS implementations and unit tests | Broad practical utilities | Runtime API dependencies |
| **4** | [TypeScript compiler tests](https://github.com/microsoft/TypeScript?utm_source=chatgpt.com) | TS/JS/TSX source fixtures | Exceptional syntax coverage | Many tests aren't executable programs |
| **5** | [Exercism JavaScript](https://github.com/exercism/javascript?utm_source=chatgpt.com) | Reference solutions and test vectors | Clean program/input/output triples | Relatively small program count |
| **6** | [Exercism TypeScript](https://github.com/exercism/typescript?utm_source=chatgpt.com) | TS reference solutions and tests | Algorithmic TS with real inputs | Relatively small program count |
| **7** | [JSON Schema Test Suite](https://github.com/json-schema-org/JSON-Schema-Test-Suite?utm_source=chatgpt.com) | Schemas, example documents, expected validity | High-quality structured inputs | Needs actual JS validator implementations |
| **8** | [Node.js tests](https://github.com/nodejs/node/tree/main/test?utm_source=chatgpt.com) | JS test programs and fixtures | Host APIs, modules, streams, buffers | Node host semantics |
| **9** | [Web Platform Tests](https://github.com/web-platform-tests/wpt?utm_source=chatgpt.com) | Browser JS, DOM tests, API fixtures | Browser coverage | Requires browser environment |
| **10** | [V8 mjsunit](https://chromium.googlesource.com/v8/v8.git/+/main/test/mjsunit/?utm_source=chatgpt.com) | JS regression tests and assertions | Difficult language edge cases | V8-specific intrinsics |

The first three are particularly attractive because they offer a realistic path to automated extraction rather than manually authoring hundreds of new scenarios.

### 1.1 Test262: the obvious large multiplier

Test262 is probably the single best existing source for expanding **semantic coverage**.

The project's documentation reports over **50,000 individual test files as of May 2025**. Each contains one or more test cases, with metadata describing language features, execution modes, and dependencies. [GitHub](https://github.com/tc39/test262/blob/main/README.md?utm_source=chatgpt.com)

For your use case, I would build a general Test262 importer rather than manually selecting individual tests.

The importer should understand:

- Test source and associated harness files.
- Strict versus non-strict execution.
- Script versus module execution.
- Positive tests and expected failures.
- Parse-time versus runtime errors.
- Feature requirements.
- Synchronous and asynchronous completion.
- Explicit assertions and expected observable behavior.

Test262's frontmatter already exposes much of this information, including `features`, `flags`, `includes`, and `negative` declarations. [Chromium Go Source](https://chromium.googlesource.com/external/github.com/tc39/test262.git/%2B/65a7ace1cb5488c2a1c5b8b2685334cd8408b56d/CONTRIBUTING.md?utm_source=chatgpt.com)

**Important distinction:** Test262 tests generally supply their inputs inside the test program itself. Many should therefore be represented as zero-argument executable entry programs, rather than trying to extract a separate function and invent arguments.

For example, a test containing several assertions may give you one complete executable program, or multiple independently extractable invocations if the harness semantics permit separation.

That makes Test262 especially useful for:

- Language conformance testing.
- Discovering unsupported interpreter operations.
- Building precisely categorized regression suites.
- Training on genuine language semantics once individual traces pass your owned verification gates.

It does not replace production-library examples, because spec tests tend to be small and intentionally focused.

**Recommendation:** Import the full suite into a catalog, execute supported subsets, and retain unsupported cases as explicit future coverage targets.

### 1.2 Complete Lodash tests, rather than more manually chosen helpers

You have already done the difficult provenance and function-extraction work for Lodash.

Currently, only 21 Lodash helper implementations appear in your real-source inventory.

I would expand to the full library, including public APIs and their dependency closures.

The important improvement is to extract test inputs from upstream tests, rather than manually defining every input family in `corpus/cases.mjs`.

Consider APIs such as:

| Function family | Interesting input variations |
|---|---|
| `get`, `set`, `has` | Deep paths, missing properties, arrays, numeric keys |
| `merge`, `defaultsDeep` | Nested objects, conflicting values, aliases |
| `cloneDeep` | Cycles, repeated references, special objects |
| `sortBy`, `orderBy` | Stable sorting, comparators, heterogeneous values |
| `groupBy`, `keyBy` | Callbacks, property selectors, collisions |
| `debounce`, `throttle` | Timers, cancellation, reentrancy |
| `template` | String parsing, interpolation, generated functions |
| `curry`, `partial`, `flow` | Closures, rest arguments, dynamic calls |

Some require substantial interpreter improvements, but that is useful information rather than a reason not to acquire them.

I would also include [Ramda](https://github.com/ramda/ramda?utm_source=chatgpt.com) and similar functional libraries.

They provide a substantial expansion into higher-order functions, closures, currying, partial application, and callback composition.

### 1.3 Deno Standard Library: exceptionally useful TypeScript

This is one of my strongest recommendations for practical TS coverage.

Deno's standard library provides modular implementations of common functionality, including paths, dates, encodings, and other utilities, with little dependency overhead compared with typical application frameworks. [Deno](https://docs.deno.com/runtime/reference/std/?utm_source=chatgpt.com)

Its components can be harvested independently:

| Domain | Representative programs |
|---|---|
| Collections | Filtering, grouping, sorting, transformations |
| Strings | Formatting, similarity, case conversion |
| Paths | Normalize, resolve, join, relative |
| Encoding | Base64, hex, text encodings |
| CSV | Parsing, escaping, serialization |
| JSON | Parsing utilities, JSONC handling |
| Date/time | Parsing, comparison, formatting |
| Async utilities | Delays, pooling, cancellation |
| Data structures | Queues, stacks, priority queues |

The attraction is the combination of **real TypeScript implementations and test inputs**.

Your existing TypeScript lowering support means much of the extraction machinery can be reused, even when the owned interpreter subsequently refuses the lowered program.

I would start with pure, deterministic modules and reserve environment-dependent modules for later.

### 1.4 Exercism: unusually clean program/input pairs

Exercism currently advertises 159 JavaScript exercises and 108 TypeScript exercises. Its language repositories include example solutions and runnable tests. [Exercism](https://exercism.org/tracks/javascript/?utm_source=chatgpt.com)

The more interesting resource is [exercism/problem-specifications](https://github.com/exercism/problem-specifications?utm_source=chatgpt.com).

Many exercises have `canonical-data.json` files containing structured test inputs and expected results. [github.com](https://github.com/exercism/problem-specifications?utm_source=chatgpt.com)

Conceptually, this is close to your desired dataset:

```json
{
  "source": "original exercise solution",
  "entry": "solve",
  "args": [3, 5],
  "expected": 8
}
```

Exercism provides a clean route to:

- Recursion and iteration.
- Mathematical algorithms.
- String and array transformations.
- Searching and sorting.
- Data structures.
- Parsing and combinatorics.
- Class-based designs.

For exercises with canonical test vectors and reference solutions, acquisition can be largely automatic.

I would prioritize this as an early importer because the input-generation problem is already substantially solved.

### 1.5 JSON Schema: one dataset, many JS execution families

This is an especially interesting multiplication opportunity.

The [JSON Schema Test Suite](https://github.com/json-schema-org/JSON-Schema-Test-Suite?utm_source=chatgpt.com) provides cases structured as:

```json
{
  "schema": {"type": "string"},
  "tests": [
    {"data": "hello", "valid": true},
    {"data": 15, "valid": false}
  ]
}
```

The official suite covers multiple JSON Schema specification versions, with expected validity for each input document. [GitHub](https://github.com/json-schema-org/JSON-Schema-Test-Suite?utm_source=chatgpt.com)

Now execute those inputs using several independent JavaScript implementations:

- [Ajv](https://github.com/ajv-validator/ajv?utm_source=chatgpt.com)
- [Zod](https://github.com/colinhacks/zod?utm_source=chatgpt.com)
- [TypeBox](https://github.com/sinclairzx81/typebox?utm_source=chatgpt.com)
- [jsonschema](https://github.com/tdegrunt/jsonschema?utm_source=chatgpt.com)

The important qualification is that these libraries don't all implement the same API or specification. The standardized JSON Schema cases apply directly only to compatible validators; Zod would need its own schema fixtures or an explicitly validated conversion.

Nevertheless, this suggests a powerful general strategy:

**Take one structured collection of inputs and run it against multiple real implementations of the same abstraction.**

The resulting traces differ substantially even when their observable outputs agree.

That is useful for learning alternative computational strategies rather than repeatedly observing the same implementation with minor input changes.

---

### 1.6 Structured language test suites: a particularly efficient source

I would add an entire category of **language-independent test datasets executed against real JavaScript implementations**.

These are attractive because the inputs and expected outputs are already machine-readable.

| Dataset | JavaScript implementations to exercise | Input → expected output |
|---|---|---|
| [CommonMark specification](https://github.com/commonmark/commonmark-spec?utm_source=chatgpt.com) | commonmark.js, markdown-it, micromark, marked | Markdown → HTML |
| [YAML Test Suite](https://github.com/yaml/yaml-test-suite?utm_source=chatgpt.com) | yaml, js-yaml | YAML → data, events, or error |
| [TOML Test Suite](https://github.com/toml-lang/toml-test?utm_source=chatgpt.com) | smol-toml, other TOML parsers | TOML → structured values |
| [JSONata Test Suite](https://github.com/jsonata-js/jsonata/tree/master/test/test-suite?utm_source=chatgpt.com) | JSONata | Expression + JSON → result |
| [JSON Schema Test Suite](https://github.com/json-schema-org/JSON-Schema-Test-Suite?utm_source=chatgpt.com) | Ajv, compatible validators | Schema + document → validity |

CommonMark alone contains more than 500 embedded test examples and exposes a JSON representation of them. The YAML suite contains inputs, expected representations, event streams, and error cases. JSONata provides reusable input datasets alongside expression tests. [GitHub](https://github.com/commonmark/commonmark-spec?utm_source=chatgpt.com)

This category offers an interesting advantage over ordinary unit tests: **you can vary the implementation independently of the input dataset**.

For example:

```text
YAML test case 107
    |
    +-- yaml package implementation
    |
    +-- js-yaml implementation
    |
    +-- alternative parser implementation
```

Each implementation exercises different algorithms and data structures while processing the same input.

It also makes differential testing straightforward, provided that configuration differences and legitimate implementation-specific behavior are accounted for.

---

## 2. Broader sources organized by the kinds of computation they exercise

To maximize diversity, I would explicitly target different computational domains.

A million traces of arithmetic and array transformations are much less useful than a smaller but diverse collection covering closures, modules, state machines, parsing, exceptions, asynchronous operations, and real application logic.

### Recommended source families

| Domain | Candidate repositories | Interesting computation |
|---|---|---|
| Functional programming | Lodash, Ramda, Underscore | Callbacks, closures, composition |
| Algorithms | trekhleb/javascript-algorithms, Exercism | Recursion, sorting, graph algorithms |
| Math | mathjs, decimal.js, big.js | Numerical algorithms, precision |
| Dates | date-fns, Luxon | Date arithmetic, parsing, formatting |
| Text | string.js, change-case, diff | String algorithms, Unicode |
| Regular expressions | XRegExp, regexp-tree | RegExp construction and matching |
| Validation | Ajv, Zod, Yup, Valibot | Recursive object traversal, errors |
| Serialization | superjson, devalue, flatted | Cycles, references, structured values |
| Parsers | yaml, json5, JSONata, marked | Tokenization, parsing, AST construction |
| Routing | path-to-regexp, find-my-way | Pattern matching, parameter extraction |
| URLs | qs, query-string, WHATWG URL tests | Parsing, encoding, normalization |
| Filesystem paths | Node path, Deno std/path | Platform-sensitive string semantics |
| Collections | Immutable.js, Immer | Structural sharing, immutable updates |
| State management | Redux, Zustand, XState | State transitions, subscriptions |
| Reactive programming | RxJS | Scheduling, event streams, cancellation |
| Async coordination | p-limit, p-queue, async | Promises, ordering, concurrency |
| Events | mitt, eventemitter3, EventEmitter | Reentrancy, callbacks, listener mutation |
| HTTP | Axios, undici, node-fetch | Request construction, headers, retries |
| Servers | Express, Koa, Fastify, Hono | Middleware, routing, request lifecycles |
| UI frameworks | React, Vue, Svelte | Closures, rendering, component state |
| Compilers | TypeScript, Babel, SWC, esbuild | AST transformations, scope, symbol tables |

I would score these by two independent dimensions:

**Value to the eventual full tracer:** Does this exercise important real-world computation?

**Immediate owned-interpreter compatibility:** Can your current interpreter verify it without substantial new runtime functionality?

For example, `date-fns` offers excellent real-world utility coverage, but much of it depends on correct `Date` semantics. A simple string-processing library may be less interesting overall but far more productive for immediate owned-trace generation.

That suggests keeping two import queues rather than rejecting difficult sources.

### Specialized corpus candidates

Several less obvious collections deserve attention.

**JavaScript engine regression suites**

Beyond Test262:

- [V8 mjsunit](https://chromium.googlesource.com/v8/v8.git/+/main/test/mjsunit/?utm_source=chatgpt.com)
- [SpiderMonkey non262 and jit-tests documentation](https://firefox-source-docs.mozilla.org/js/index.html?utm_source=chatgpt.com)
- [JavaScriptCore JSTests](https://github.com/WebKit/WebKit/tree/main/JSTests?utm_source=chatgpt.com)

These contain difficult cases involving prototypes, accessors, arrays, numeric edge cases, closures, exceptions, and engine regressions.

They are excellent sources for discovering semantic gaps, although many tests use engine-specific harnesses or intrinsics that must be filtered or adapted. [Chromium Go Source](https://chromium.googlesource.com/v8/v8.git/%2B/main/test/mjsunit/?utm_source=chatgpt.com)

**Compiler and formatter fixtures**

I would independently acquire:

- [TypeScript](https://github.com/microsoft/TypeScript?utm_source=chatgpt.com)
- [Babel](https://github.com/babel/babel?utm_source=chatgpt.com)
- [Prettier](https://github.com/prettier/prettier?utm_source=chatgpt.com)
- [ESLint](https://github.com/eslint/eslint?utm_source=chatgpt.com)
- [Biome](https://github.com/biomejs/biome?utm_source=chatgpt.com)

There is an important distinction here.

A compiler fixture often contains valid or intentionally invalid JS/TS **source text**, with expected diagnostics or transformed output. That is not automatically a runnable execution fixture.

I would import these into a separate source-fixture catalog, then promote compilable and meaningfully executable examples into the runtime corpus.

This could be particularly valuable for TS features such as decorators, private fields, class inheritance, generators, destructuring, ESM, and JSX.

**Algorithms with existing tests**

The [JavaScript Algorithms repository by trekhleb](https://github.com/trekhleb/javascript-algorithms?utm_source=chatgpt.com) includes implementations and Jest tests spanning data structures, sorting, searching, graph algorithms, dynamic programming, cryptography, and more. It is MIT-licensed. [GitHub](https://github.com/trekhleb/javascript-algorithms?utm_source=chatgpt.com)

I would prefer it over collections containing solutions without tests, because extracting known-good input/output pairs is considerably easier.

Another candidate is TheAlgorithms/JavaScript, although its GPL-3.0 license deserves a separate distribution and training-use review.

**Browser and user-interface execution**

Web Platform Tests are the most interesting large-scale source here.

Their JavaScript tests use the `testharness.js` framework and cover browser APIs. [web-platform-tests.org](https://web-platform-tests.org/writing-tests/testharness.html?utm_source=chatgpt.com)

Potential execution episodes include:

- DOM creation and mutation.
- Event dispatch and propagation.
- Form validation.
- Fetch requests and responses.
- Browser storage.
- Timers and microtasks.
- Message channels.
- Web Workers.
- Streams.

These require substantial host-environment support, so I would initially treat them as future-coverage examples and independently executed browser diagnostics.

---

# 3. The largest opportunity: mine GitHub projects together with their tests

This is where I expect the greatest increase in real-world program diversity.

Rather than choosing individual libraries, build a system that identifies suitable open-source JS/TS projects and extracts their runnable tests automatically.

## 3.1 Mine tests, not just functions

Imagine acquiring 5,000 permissively licensed JavaScript/TypeScript repositories.

Suppose that, after filtering, each contributes an average of 100 executable test cases.

That gives:

**5,000 repositories × 100 cases = 500,000 initial executions.**

With ten useful deterministic input or state variations per case:

**500,000 × 10 = 5 million execution attempts.**

These are illustrative calculations, not verified availability or acceptance estimates.

The key is that existing tests provide much of the missing information:

- Which functions are intended to be called.
- How the program is initialized.
- Which argument combinations are meaningful.
- Which callbacks should be supplied.
- What results and side effects are expected.
- Which errors are intentional.

This avoids the fundamental problem with using arbitrary source-code datasets: most source files do not come with meaningful entry points or inputs.

## 3.2 Which test frameworks should the importer support?

Start with the common patterns:

| Framework | Input extraction opportunity |
|---|---|
| Jest | `test`, `it`, `test.each`, mocks, expectations |
| Vitest | Similar patterns, often TypeScript |
| Mocha | `describe`, `it`, hooks |
| Node test runner | `node:test`, `assert` |
| AVA | `test`, assertions, asynchronous tests |
| Tape | Explicit tests and completion |
| Deno test runner | `Deno.test`, assertions |
| Custom tests | AST extraction or execution-based recording |

There are two viable extraction approaches.

### Static extraction

For simple tests:

```js
test.each([
  [1, 2, 3],
  [5, 7, 12],
  [-3, 8, 5]
])('addition', (a, b, expected) => {
  expect(add(a, b)).toBe(expected);
});
```

An importer can recover the original implementation, entry point, three argument tuples, and expected results.

This is relatively straightforward.

### Dynamic extraction

For complex tests, static AST inspection is insufficient.

Tests frequently construct objects, assign callbacks, set up state, and invoke the same function repeatedly.

I would build a **test-driven invocation recorder**:

1. Run an upstream test in an isolated reference environment.
2. Observe calls crossing selected production API boundaries.
3. Record the source-backed callable identity and exact argument graph.
4. Record relevant initialization and subsequent calls.
5. Record the observable result, mutations, and external effects.
6. Replay the extracted invocation independently.
7. Accept only reproducible observations.

This is closely aligned with your existing observational pipeline.

One important detail: recording only the entry function's arguments is insufficient when tests exercise stateful APIs. The recorder must preserve the sequence of operations, callback identities, and reachable mutable state.

For complicated cases, retain the original test as a deterministic scenario driver rather than forcing it into a single-function abstraction.

## 3.3 Package selection should maximize diversity

I would not simply rank GitHub repositories by stars.

That would overrepresent popular frameworks and their dependencies.

Instead, sample across:

- npm package categories.
- JavaScript versus TypeScript.
- ESM versus CommonJS.
- Functional versus object-oriented code.
- Small versus large dependency graphs.
- Browser versus Node targets.
- Pure versus stateful behavior.
- Synchronous versus asynchronous execution.
- Distinct AST and API feature combinations.

The npm registry metadata API exposes package versions, dependencies, repository information, and tarball integrity information, making it useful for building a reproducible acquisition index. [GitHub](https://github.com/npm/registry/blob/main/docs/responses/package-metadata.md?utm_source=chatgpt.com)

For source-plus-test acquisition, the linked source repository will often be more useful than the published npm tarball, because tests are frequently excluded from release packages.

I would begin with several hundred well-tested, permissively licensed projects, measure extraction yield, and then expand the crawler.

---

# 4. Another multiplier: generate inputs intelligently

Your current utility fixtures generally provide twelve deterministic inputs per function.

That is a useful starting point, but I would replace the fixed-count approach with **coverage-directed input generation**.

The most useful tooling candidate is [fast-check](https://fast-check.dev/?utm_source=chatgpt.com), a property-based testing framework supporting generated values, deterministic seeds, and shrinking. [fast-check.dev](https://fast-check.dev/docs/introduction?utm_source=chatgpt.com)

## 4.1 Generate diverse values

For every function, generate values from a structured domain appropriate to its parameters.

| Input category | Variations |
|---|---|
| Numbers | Zero, negative zero, boundaries, fractions, NaN, infinities |
| Strings | Empty, ASCII, Unicode, surrogate pairs, long strings |
| Arrays | Empty, singleton, nested, sparse, aliased |
| Objects | Missing fields, nested values, unusual keys, circular references |
| Maps/Sets | Empty, populated, object keys, mutation |
| Functions | Callbacks that return, mutate, reenter, or throw |
| Promises | Immediate, delayed, rejection, chained adoption |
| Dates | Epoch, leap days, timezone boundaries |
| State machines | Valid and invalid action sequences |

Not every value is serializable in JSON.

For your project, generators should construct identity-preserving initial object graphs, with a deterministic guest setup mechanism for callbacks, promises, symbols, and other special values.

This fits the representation direction already described in your training-data plan.

## 4.2 Prefer new execution paths over new random seeds

I would measure novelty using:

- Branch-decision signatures.
- Distinct function-call paths.
- Recursion depth and loop behavior.
- Observable mutation patterns.
- Allocation and aliasing patterns.
- Exception paths.
- Scheduling and asynchronous ordering.
- Source operations exercised.

If 100 different inputs all take the same branch path and produce structurally similar traces, retaining all 100 may provide little additional value.

Conversely, a single carefully chosen input that activates an unusual error path can be extremely valuable.

A useful generation loop would be:

```text
Original test inputs
        |
        v
Input-domain inference
        |
        v
Generate candidate variations
        |
        v
Independent reference execution
        |
        v
Compare observable behavior
        |
        v
Measure path / trace novelty
        |
        +---- No new behavior --> discard or downsample
        |
        +---- New behavior ----> retain
                                   |
                                   v
                         Attempt owned verification
```

This would reduce both storage requirements and the amount of repetitive training data.

### 4.3 Generate stateful command sequences

For libraries such as queues, event emitters, caches, state stores, and middleware systems, I would go further.

Generate **sequences of operations**, not isolated inputs.

For a cache, for example:

```text
set("a", 1)
set("b", 2)
get("a")
delete("b")
set("c", 3)
get("b")
clear()
set("a", 4)
```

Each sequence can include observable assertions after every operation.

Then vary:

- Operation order.
- Repeated keys.
- Capacity and eviction settings.
- Object identities.
- Callback reentrancy.
- Exceptions.
- Timer behavior.

This offers much greater control-flow diversity than repeatedly calling a single helper.

fast-check's model-based testing capabilities are worth investigating for this.

---

# 5. Additional unconventional sources

Several other ideas could provide useful diversity, although I would prioritize them after the main acquisition pipeline.

| Source | Opportunity | Caveat |
|---|---|---|
| [Fuzzilli](https://github.com/googleprojectzero/fuzzilli?utm_source=chatgpt.com) | Generate complex, feature-rich JS programs | No automatic semantic oracle; harness adaptation needed |
| [CodeSearchNet](https://github.com/github/CodeSearchNet?utm_source=chatgpt.com) | Mine real utility function candidates | Code usually lacks invocation inputs |
| [The Stack v2](https://huggingface.co/datasets/bigcode/the-stack-v2?utm_source=chatgpt.com) | Discover enormous numbers of source families | Licensing, provenance, duplication, missing tests |
| [Google Coding Competitions Archive](https://github.com/google/coding-competitions-archive?utm_source=chatgpt.com) | Obtain algorithmic problems and test material | Must separately match licensed JS/TS solutions |
| GitHub bug-fix PRs | Find real regression tests and edge cases | Reproducing historic environments |
| Documentation examples | Extract example calls and expected results | Outputs may be incomplete or illustrative |
| Cross-implementation tests | Run identical inputs against different libraries | APIs and semantics may not be identical |
| Metamorphic tests | Generate new inputs from known invariants | Invariants require validation |

Fuzzilli is particularly interesting as a longer-term source of structurally unusual JavaScript. It uses mutation and generation to produce programs intended to explore engine behavior. [GitHub](https://github.com/googleprojectzero/fuzzilli/blob/main/Docs/HowFuzzilliWorks.md?utm_source=chatgpt.com)

I would use it initially for **coverage exploration**, not automatically as training supervision.

Likewise, CodeSearchNet and The Stack are best understood as discovery reservoirs. A large collection of code is not automatically a large collection of meaningful execution examples. CodeSearchNet's original dataset spans roughly two million function/comment pairs across several languages, while The Stack v2 is vastly larger but has substantial provenance and deduplication considerations. [GitHub](https://github.com/wandb/codesearchnet/blob/master/README.md?plain=1\&utm_source=chatgpt.com)

### One especially promising idea: mine regression-test history

For each suitable bug-fix pull request:

1. Identify the regression test added by the PR.
2. Recover the input that triggered the bug.
3. Execute it against the buggy commit and the fixed commit.
4. Record both outcomes.
5. Pin the source and input to the respective revisions.

This creates paired examples where a relatively small source change produces a meaningful behavioral difference.

Such cases could be unusually valuable for evaluating whether a model predicts actual program semantics rather than merely recognizing common code patterns.

---

# 6. How I would integrate all of this into your repository

I would avoid expanding `corpus/cases.mjs` into an enormous manually maintained inventory.

Instead, introduce a generic acquisition and normalization layer.

## 6.1 A common program-and-fixture manifest

Something conceptually like:

```json
{
  "schema": "corpus-case/2",

  "source": {
    "repository": "example/library",
    "revision": "<pinned-commit>",
    "files": ["src/utility.ts"],
    "license": "MIT"
  },

  "program": {
    "language": "typescript",
    "entry": "calculate",
    "modules": ["src/utility.ts"]
  },

  "fixture": {
    "kind": "function-call",
    "args": [12, 7],
    "environment": {
      "randomSeed": 42,
      "clock": 1700000000000,
      "timezone": "UTC"
    }
  },

  "expected": {
    "completion": {
      "kind": "return",
      "value": 19
    }
  },

  "provenance": {
    "inputOrigin": "upstream-test",
    "testId": "calculate/basic",
    "generatorSeed": null
  }
}
```

This illustrates the normalized representation, not a proposal to replace your existing semantic-execution or trace schemas.

Real fixtures would need additional tagged encodings for special JS values, graph identity, and mutation evidence.

The goal is to support multiple input sources without writing a separate execution engine for every corpus.

## 6.2 Different acquisition adapters

I would implement these adapters independently:

| Adapter | Purpose |
|---|---|
| `test262` | Interpret conformance tests and harness metadata |
| `exercism` | Import reference solutions and canonical input/output data |
| `table-driven` | Import JSON/YAML structured conformance datasets |
| `jest-vitest` | Extract upstream tests and parameterized inputs |
| `node-deno-tests` | Execute runtime-specific test scenarios |
| `function-miner` | Identify suitable exported functions |
| `invocation-recorder` | Extract calls from actual test executions |
| `property-generator` | Generate and shrink additional fixtures |
| `state-machine-generator` | Generate stateful command sequences |
| `regression-miner` | Import reproducible before/after bug cases |

All should produce records using the same canonical fixture interface.

## 6.3 Maintain separate evidence levels

I would preserve your existing verification boundaries and make them explicit in the manifest.

| Level | Meaning | Eligible for semantic-trace training? |
|---|---|---|
| **Source fixture** | Source and candidate input acquired | No |
| **Reference verified** | Reproducible observable behavior independently checked | Not by itself |
| **Diagnostic observed** | Native V8 observation collected | No |
| **Owned locally verified** | Owned execution passes independent checks, replay, and controller verification | Candidate only |
| **Admitted** | All required downstream training gates pass | Yes |

A case can have both reference-verification and diagnostic-observation evidence; those are not mutually exclusive stages.

This separation is important because the scale of imported source code will initially grow much faster than the coverage of your owned interpreter.

## 6.4 Preserve programs outside the Git repository

At millions of executions, I would store:

- A small Git-tracked catalog of source revisions and fixture definitions.
- Content-addressed source bundles.
- Compressed execution records in external storage.
- Verification receipts and dataset indices.
- Small representative traces and regression cases in Git.

This avoids turning your project repository into an enormous collection of redundant traces.

Since many executions share the same source bundle, content-addressed storage could eliminate substantial duplication.

---

# 7. Your current implementation gaps should influence acquisition priorities

Your `FULL_CORPUS_EVAL.md` already provides a valuable guide.

Of the 936 utility invocations, 378 were not locally verified in the documented baseline. The reported blockers include:

| Existing blocker | Unverified invocations attributed to first failure |
|---|---:|
| RegExp matching | 84 |
| Top-level declarations | 72 |
| Property lookup semantics | 66 |
| Source-bundle budget | 48 |
| Constructors | 48 |
| Array holes and length behavior | 24 |
| Array-constructor/builtin behavior | 24 |
| Rest parameter patterns | 12 |

These counts describe first failures, not necessarily independent capabilities.

This has an important consequence for corpus acquisition:

**I would optimize the first wave for both coverage and executable yield.**

For example:

- Extract pure numeric, string, array, and object utilities for immediate owned-trace candidates.
- Import RegExp-heavy suites to drive the RegExp implementation backlog.
- Import class-heavy code for constructors, prototypes, and inheritance.
- Import async/stateful scenarios for scheduler and effect-model development.
- Import ESM/TS projects for dependency initialization and source-map coverage.

Some of the most valuable future examples are precisely those your interpreter currently rejects.

Retaining them gives you a measurable roadmap for expanding semantic coverage.

---

# 8. Suggested acquisition roadmap

I would organize implementation into four waves.

### Wave 1 — High-quality program/input pairs

Start with:

1. Full Test262 acquisition.
2. Exercism JS and TS.
3. Complete Lodash test harvesting.
4. Deno Standard Library pure functions.
5. JSONata, CommonMark, YAML, and JSON Schema fixtures.
6. A first batch of additional pure libraries such as Ramda and string utilities.

**Goal:** Prove that several different source formats can be normalized and independently executed without manual fixture authoring.

Success means demonstrating new distinct programs, diverse inputs, and valid evidence—not just increasing JSONL row counts.

### Wave 2 — Automated repository mining

Build a crawler and test importer for permissively licensed JS/TS projects.

Start with hundreds of repositories across deliberately different domains.

Measure:

- Repositories discovered.
- Repositories with usable tests.
- Extractable program families.
- Reproducible invocations.
- Distinct runtime features.
- Reference disagreements.
- Owned verification success.
- Storage cost per useful example.

Use the results to determine which categories are worth scaling.

### Wave 3 — Coverage-directed multiplication

Add:

- Structured input generation.
- Path-novelty selection.
- Stateful sequence generation.
- Differential validation.
- Failure shrinking.
- Trace deduplication.

At this stage, millions of execution attempts become a reasonable engineering target.

### Wave 4 — Full applications and complex runtime behavior

Gradually add projects requiring:

- Complex module graphs.
- Node filesystem and network APIs.
- Browser DOM APIs.
- Realistic timers.
- Promise and microtask scheduling.
- Workers.
- Application-level effects.

This is where your corpus becomes representative of substantially more general JS/TS execution.

---

# 9. How to measure whether the expansion is actually useful

I would make the following distinction central:

**Raw execution count measures scale. Coverage diversity measures value.**

For every acquisition source, track at least these dimensions:

| Metric | Why it matters |
|---|---|
| Distinct original source functions | Avoids seed-driven inflation |
| Distinct projects | Measures real-world diversity |
| Distinct AST feature combinations | Measures language coverage |
| Distinct branch-path signatures | Measures dynamic diversity |
| Distinct mutation patterns | Captures heap semantics |
| Distinct call-graph structures | Captures interprocedural complexity |
| Module-graph size and depth | Measures program complexity |
| Observable effect types | Measures host interaction |
| Independent verification success | Measures correctness |
| Owned-trace verification success | Measures training readiness |

I would also maintain **separate diversity statistics for source code and executions**.

For example, one implementation of quicksort with 10,000 random inputs is still one source program.

Ten independent sorting implementations with 100 carefully chosen inputs each offer much greater source diversity even though the execution count is identical.

For training, I would additionally distinguish semantic trace diversity from mere source and input diversity.

### Critical safeguards

Three concerns become increasingly important at this scale.

First, **license and provenance**. Pin source revisions, preserve notices, audit transitive dependencies, and verify that redistribution and intended training uses are permitted. MIT, BSD, Apache, and GPL sources should not silently be treated as interchangeable.

Second, **execution isolation**. Your repository correctly notes that Node's `vm` is not a security boundary. Automatically acquired untrusted repositories should be executed in dedicated sandboxed containers or stronger isolation, without credentials, external network access, or unrestricted filesystem access.

Third, **evaluation leakage**. Keep splits at least project-level where possible, and use source-family clustering to detect near-duplicates across forks, copies, and package versions. Cross-implementation examples sharing specifications or test inputs should have explicit grouping rules.

---

# 10. The five investments I would prioritize

If I were choosing where to spend engineering effort, I would rank the work as follows:

| Rank | Investment | Why |
|---|---|---|
| **1** | Generic Jest/Vitest/Node test-to-fixture extraction | Unlocks potentially thousands of real repositories |
| **2** | Full Test262 importer | Large, highly structured semantic test collection |
| **3** | Structured conformance-dataset importer | Turns machine-readable inputs into many real-library executions |
| **4** | Coverage-directed, deterministic input generation | Multiplies examples without multiplying source acquisition |
| **5** | Automated repository discovery and qualification | Provides the long-term path toward millions of diverse cases |

I would implement the first three as one coherent ingestion system rather than three unrelated generators.

## A concrete initial experiment

Before building a large crawler, I would take these five sources:

- Test262
- Exercism JS/TS
- Full Lodash tests
- Deno Standard Library
- YAML Test Suite using two JS parser implementations

Then measure how many distinct executable cases can be extracted automatically, how many pass an independent V8 reference check, and how many pass your existing owned-verification pipeline.

That gives you a direct estimate of acquisition efficiency across five quite different categories.

It would also expose exactly which generic importer features are needed before scaling up.

---

## Final perspective

There are really **three different corpora** worth building:

**A. The semantic conformance corpus.** Test262, engine tests, compiler fixtures, and language edge cases. Its purpose is precise JavaScript and TypeScript semantics.

**B. The real-world computation corpus.** Thousands of actual libraries and their tests. Its purpose is broad, realistic execution across algorithms, applications, modules, objects, callbacks, and stateful behavior.

**C. The generated execution corpus.** Large numbers of verified, coverage-selected input variations and stateful scenarios. Its purpose is to expose alternative execution paths and produce sufficient training volume.

All three are necessary.

Test262 alone can provide tens of thousands of cases, but won't adequately represent production computation. Arbitrary GitHub source alone provides code without necessarily supplying executable examples. Generated inputs alone can inflate the dataset without much additional semantic diversity.

**The highest-leverage idea is to turn the enormous body of existing JS/TS unit tests into a machine-readable source of executable program/input pairs.**

Combined with your existing observational and owned-verification infrastructure, that offers a credible route from roughly 1,800 current executions to millions of reproducible execution attempts, while preserving a strict distinction between acquired examples, diagnostic observations, and genuinely verified training trajectories.


---

## Implementation status — 2026-10-23

This section is a **measured implementation ledger**. The sections above are
the original proposal; aspirations about millions of episodes are **not**
completion claims. The acquisition pathway now deliberately separates
discovered fixtures from reference execution, V8 observation, owned trace
verification and downstream training admission.

### Implemented in this change

- [x] Generic, offline, streaming `external-corpus-fixture/1` acquisition:
  full source-relative paths, original-file SHA-256, pinned upstream commits,
  exact expected data, deterministic project-level splits, explicit non-admission,
  static hardness tags and JSONL/summary output.
- [x] Test262 importer with original source, strict/sloppy/raw/module variants,
  flags/features/includes and declared negative phases. **Harness execution is
  not yet implemented**; Test262 expected outcomes are not execution evidence.
- [x] Recursive Exercism canonical-data importer; exports structured input,
  expected result, property and test IDs without claiming a runnable solution.
- [x] JSON Schema Test Suite importer with schema/data/validity contracts,
  dialect grouping and expected validity. No validator is implicitly supplied.
- [x] CommonMark `spec.json` importer (requires a separately generated,
  pinned spec export) and literal Jest/Vitest `test.each` and `it.each` parser.
  No dynamic upstream test code is evaluated in acquisition.
- [x] Exact SHA-1 Git blob locks for **92 original upstream snapshot files**:
  **42 Test262 tests**, **26 JSON Schema suite files**, and **24 Exercism
  canonical-data files**, plus their original upstream LICENSE files.
- [x] **14 new adversarial scenario families** built on previously pinned,
  unmodified production libraries. The existing stateful baseline remains
  untouched; `--suite adversarial` and `--suite combined` are opt-in.
- [x] Unit and snapshot-integrity regression tests; existing generator/auditor
  defaults retained.

### Verification status (keep denominators separate)

| Item | Acquired / implemented | Independently executed | Owned verified | Admitted |
| --- | ---: | ---: | ---: | ---: |
| Pinned external source/data snapshot files | 92 | 0 by this importer | 0 | 0 |
| New adversarial real-library scenario families | 14 | Run via opt-in diagnostic command | 0 claimed | 0 |
| Existing utility corpus (unchanged) | 78 families / 936 invocations | 936 V8 checks in prior ledger | 684 in updated gap ledger | 0 |
| Existing stateful baseline (unchanged) | 76 families / 912 invocations | 912 V8 checks in prior ledger | 0 | 0 |

"42 Test262 tests" means 42 upstream **files**, potentially multiple strict
variants, not 42 verified executions. Structured test-data files can contain
multiple input cases. Do not add source-file counts to runnable episode counts.

### Remaining work / NOT IMPLEMENTED

- [ ] Automatically acquire full upstream suites in CI or a sandboxed worker.
  The importer supports exact, clean, pinned local checkouts; repository
  discovery, networking and large-dataset storage orchestration are not done.
- [ ] Complete official Test262 harness, parse/early/runtime negative oracle,
  async completion, module resolution and independent reference observations.
- [ ] Bind Exercism canonical inputs to genuine pinned JS/TS reference solutions.
- [ ] Pair JSON Schema / CommonMark inputs with separately pinned and verified
  real JS implementation APIs; no schema/parser execution currently occurs.
- [ ] A general dynamic Jest/Vitest/Node test invocation recorder with effects
  and dependency closures; current `test.each` support is literal-data only.
- [ ] Fuzz / mutate inputs subject to a real reference oracle, state-model
  sequence generation, failure shrinking and path-based deduplication.
- [ ] Admit any new external records as owned `semantic-execution/2`. The new
  V8 adversarial drivers remain diagnostic; no unverified observations are
  promoted to training data.
- [ ] Independently certify intermediate operations, especially Proxy traps,
  accessor side effects, async scheduling and Map/Set internal semantics.
- [ ] Quantitatively measure trace *readability and succinctness*, not merely
  terminal result agreement or event counts.

### Further adversarial source priorities

Prefer difficult **real execution** paths, not just tiny spec checks. Potential
upstream test suites for subsequent pinned acquisition:

| Source | Hard cases to target | Current status |
| --- | --- | --- |
| [Immer](https://github.com/immerjs/immer) | Nested Proxy drafts, patch generation, structural sharing, frozen originals | Candidate; not imported |
| [MobX](https://github.com/mobxjs/mobx) | Reactions, transactions, dynamic dependency graphs, computed cycles | Candidate; not imported |
| [RxJS](https://github.com/ReactiveX/rxjs) | Hot/cold streams, reentrant emissions, schedulers, cancellation, error teardown | Candidate; not imported |
| [XState](https://github.com/statelyai/xstate) | Parallel/history states, entry/exit effects, delayed transitions, actors | Candidate; not imported |
| [Yjs](https://github.com/yjs/yjs) | CRDT concurrency, shared references, transaction ordering, merges | Candidate; not imported |
| [Automerge](https://github.com/automerge/automerge) | Merges, causal histories, immutable snapshots; WASM boundary | Candidate; not imported |
| [ProseMirror](https://github.com/ProseMirror/prosemirror-state) | Transaction steps, mapped positions, plugin callbacks, editor invariants | Candidate; not imported |
| [SolidJS](https://github.com/solidjs/solid) | Fine-grained reactive computations, scheduling and dependency tracking | Candidate; not imported |
| [Effector](https://github.com/effector/effector) | Event graph composition and asynchronous effect ordering | Candidate; not imported |
| [JSONata](https://github.com/jsonata-js/jsonata) | Recursive queries, higher-order functions, closures, regex and errors | Candidate; not imported |
| [Ajv](https://github.com/ajv-validator/ajv) | Dynamic schemas/ref resolution, generated functions, mutation/coercion | Candidate; not imported |
| [fast-check](https://github.com/dubzzz/fast-check) | Stateful command shrinking, generators, lazy streams, failing seeds | Candidate; not imported |
| [Temporal polyfill](https://github.com/js-temporal/temporal-polyfill) | Calendars, time zones, exotic comparisons and exception paths | Candidate; not imported |
| [Node streams](https://github.com/nodejs/node) | Backpressure, retries, abort signals, async iterators, deferred cleanup | Candidate; not imported |
| [React reconciler](https://github.com/facebook/react) | Reentrant updates, scheduler priorities, effect lifecycle, tearing | Candidate; not imported |
| [Svelte runtime](https://github.com/sveltejs/svelte) | Reactive scheduling, generated compiled JS, dynamic invalidation | Candidate; not imported |
| [TypeScript language services](https://github.com/microsoft/TypeScript) | Incremental caches, symbol resolution, graph invalidation, huge bundles | Candidate; not imported |

For future acceptance, evaluate **semantic compression quality** explicitly:
dependency depth, irreversible side effects, alias graphs, nested callback
ordering, branch/value provenance, intermediate-event oracle coverage, and how
many causally necessary events remain after lossless normalization. A short
trace that omits observable getters, proxy calls, or microtask ordering is not
a successful succinct trace.

Reproduction commands, lock format, scope and warnings are in
[`corpus/extension/README.md`](../corpus/extension/README.md).

### Validation and scale-out update (2026-10-23)

- [x] Initial 14-family adversarial CI smoke: **28/28 independently matched V8 final observables**, 10,776 diagnostic events and 4,526 recorded heap changes, no observer errors. These are **not owned traces**. CI now enforces a 28-case floor, and the existing 912-case stateful baseline remains separately enforced.
- [x] Prototype test suite passes on Node.js 20, 22 and 24 after fixing Test262 negative-phase metadata parsing (the initial CI failure was addressed in a follow-up commit).
- [x] A separate [external corpus acquisition workflow](../.github/workflows/external-corpus.yml) validates all pinned snapshots and uploads acquisition artifacts. Its **manually dispatched full-source mode** clones all three exact upstream commits and streams their complete recognized source/input inventories into non-admitted JSONL artifacts. Full-source mode is implemented but **has not been executed or measured in this change**.
- [ ] Still required: create independently verified JS/TS solution/validator execution adapters, operation-level evidence, and actual large owned semantic-trace exports; acquisition count must never be presented as semantic-trace count.

### Measured acquisition result and automation (2026-10-23)

- [x] The new snapshot acquisition workflow **passed** and generated **1,453 distinct source/input fixture rows** from **92 pinned upstream files**: 82 Test262 source/mode variants, 464 Exercism canonical input cases, and 907 JSON Schema validity cases. These have **zero** independent runtime verifications, **zero** owned traces and **zero** admitted training examples. This is concrete acquisition scale, not evidence of execution semantics.
- [x] Full pinned-source acquisition is configured to run on pushes affecting acquisition code, snapshots or its workflow, and can also be manually dispatched. It produces source/input catalogs as CI artifacts, not checked-in trace JSONL. **Full-catalog results are pending an actual successful run**; do not infer their counts from suite publicity.

### Full upstream acquisition — successful CI measurement (2026-10-23)

The pinned full-checkout acquisition job **completed successfully** in [Actions run 39968633575](https://github.com/werg/tracing-js-self/actions/runs/39968633575). It acquired these source/input records (not semantic traces):

| Full pinned source | Source files | Candidate fixture records | Independent reference executions | Owned verified | Training admitted |
| --- | ---: | ---: | ---: | ---: | ---: |
| Test262 (`tc39/test262`) | **53,910** | **103,582** (strict/sloppy/module variants) | 0 | 0 | 0 |
| Exercism problem specifications | **143** | **2,330** | 0 | 0 | 0 |
| JSON Schema Test Suite | **434** | **11,861** | 0 | 0 | 0 |
| **Total** | **54,487** | **117,773** | **0** | **0** | **0** |

These full inventories are hosted as the run's downloadable **`full-pinned-source-catalog-only`** artifact (compressed size approximately **8.9 MB**). The accompanying source repositories are reproducible from exact upstream SHA pins. A successful full acquisition does **not** imply runnable JS solutions for every Exercism case or valid implementation/harness execution for Test262/JSON Schema. Owned trace generation, independent execution verification, semantic readability metrics and training admission remain **open**.

The existing 1,848-execution diagnostic baseline plus the 28 initial adversarial smoke executions must not be added to acquired candidate counts as though they were a single evidence type. The result exceeds the earlier target for **candidate acquisition**, not the target for *millions of verified execution traces*.


### Wave 2 — Real-source canonical-input owned verification (2026-10-23)

- [x] Pinned **20 original Exercism JavaScript reference implementations** from
  `exercism/javascript@ff04f35158cdf61eebfdf18a774010495a1fd6d9`, with
  separate SHA-locked **20 canonical-data sources** from
  `exercism/problem-specifications@650bebeb39ad40439175288042aece982b0a90a9`.
  Copyright licenses and individual original Git blob identities are retained.
- [x] Added `src/corpus/owned-exercism.mjs`: explicit original export/API-to-canonical
  property/argument mappings, family-level frozen splits, complete per-file
  provenance, and a conservative parser-based conversion of function-only
  ESM to the existing owned `training-js/1` direct-function-entry profile.
  Modules with classes, imports, top-level effects, or potentially lexical
  arrow receiver/arguments semantics are deliberately refused.
- [x] Added `tools/verify-exercism-owned.mjs`: executes each original
  SHA-locked proof and its conservative projection independently in controlled
  V8 realms; checks canonical expected return *and initial input mutations*
  for agreement; only then attempts owned training verification. Successful
  trajectories undergo complete independent evidence recheck after
  JSON serialization. All failures retain explicit categorization.
- [x] Output includes source-pinned, family-separated, local-only
  `semantic-execution/2` trace candidates with private audit sidecars,
  readable preview lines, and non-admission quality metrics
  (generated groups/bytes, journal event counts). These metrics do *not*
  prove minimal causal traces.
- [x] Dedicated CI pipeline `.github/workflows/owned-exercism.yml` tests
  source pinning and checks a positive floor for genuinely owned and
  independently rechecked cases.
- [ ] Measured counts, verification refusals and trace-quality distributions
  are to be populated from the actual CI run, not estimated.
- [ ] **Full 117,773 acquired Test262/Exercism/JSON Schema records** are *not*
  themselves semantically verified. This experiment attempts a curated,
  pinned real-JS subset only. Full suite harness/validator execution, exotic
  native effects, adversarial operation-level evidence and admission remain open.

This source-projection phase should be distinguished from general ESM execution:
original module source is never passed off as unchanged in the strict owned
runtime, and independent original-versus-lowered V8 checks must succeed for
each successful candidate.


### First verified Exercism JS corpus measurement (2026-10-23)

The initial exact-canonical run [CI job 120540220232](https://github.com/werg/tracing-js-self/actions/runs/39990355300) **passed**:

| Measure | Actual result |
| --- | ---: |
| Pinned original JS proof files / matching canonical-data files | 20 / 20 |
| Canonical executions independently attempted | 207 |
| Locally owned verified, independently rechecked `semantic-execution/2` | **34** |
| Explicitly refused | 173 |
| Distinct proof families yielding owned traces | **7** |
| Owned original journal events across successes | 2,961 |
| Generated semantic-trace groups across successes | 989 |
| Generated semantic-trace record bytes across successes | 155,985 |
| Actually admitted to training | **0** |

Successful families: **leap 9**, **raindrops 12**, **binary-search 6**,
**collatz-conjecture 3**, **two-fer 2**, **sum-of-multiples 1**, and
**largest-series-product 1**. The exact failure ledger includes
unsupported spread, RegExp, classes, getters, runtime property lookup,
expected exceptional completions, source/projected reference mismatches,
generated-chunk limits, and unrepresentable scalar or graph outcomes.
The 34 successes passed independent original JS/V8 comparisons, canonical
expected result, owned reference outcome, source-executed primitive
operation and branch receipts, controller evaluation, archive replay, and
post-serialization evidence recheck. Neither the 34 successes nor the
approximately 1,000 generated groups have been admitted to megatoken.

This release adds opt-in **deterministic canonical-seeded input variants**,
with explicit `generated/` identifiers and oracle-derived expected results
from the original pinned JS proof implementation. They are **not**
represented as additional official Exercism canonical tests. Each must
again agree with the conservatively lowered V8 program and owned reference
checks before retention. The next CI run gates the original 34 verified
candidates and evaluates bounded new variants. Novelty metrics remain
imperfect; new seeds are not claimed to be new source functions.


### Verified real-source input-variation results (2026-10-23)

[CI run 39991150068](https://github.com/werg/tracing-js-self/actions/runs/39991150068)
**passed** with complete independent post-serialization checks:

| Evidence measurement | Actual count |
| --- | ---: |
| Original canonical input attempts | 207 |
| Deterministic original-input-derived variants attempted | 160 |
| **Total attempted** | **367** |
| **Locally owned verified semantic-execution/2** | **71** |
| Canonical verified / generated verified | **34 / 37** |
| Explicitly refused | 296 |
| Distinct upstream JS source functions/families yielding owned evidence | 7 |
| Raw owned journal events in verified episodes | 5,809 |
| Model-generated semantic trace groups in verified episodes | 1,930 |
| Generated semantic record bytes in verified episodes | 301,108 |
| Training episodes admitted | **0** |

The verifier retains all unsupported cases and original-code or expected-result
disagreements. Retained generated variants are identified as **oracle-labeled,
non-canonical**. Important refusal categories include missing/unsupported
intrinsics, spread syntax, exotic property access, RegExp use, classes, arrays
with unsupported operations, expected throws, and chunk-budget overflow.

The verified traces average **27.18 generated groups** and **81.82 journal
events** per execution. These raw size metrics are **not** a demonstration
that the semantic target omits no causally necessary events; the optional
generated Markdown review shows real source-anchored public semantic lines
and ranks substantial cases for inspection. This verification subset is
real execution evidence, but does not automatically convert the
**117,773 candidate fixtures** into owned traces. The remaining acquired
sources require additional host/module/async capabilities, implementation
bindings and operation-level evidence.

- [x] Retain full source, input ancestry and independent original/lowered V8
  receipts for every candidate; no generated input is labeled canonical.
- [x] Gate the current independently rechecked owned floor at **71** examples.
- [x] Produce a human-reviewable semantic trace sample report and categorized
  refusal ledger as CI artifacts.
- [ ] Add broad source types, genuine module effect profiles, JSON Schema and
  Test262 reference/owned adapters; resolve existing declared interpreter
  refusals without substituting native-V8 diagnostics for owned traces.
