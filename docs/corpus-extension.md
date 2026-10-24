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


### Source-site fidelity limitation and final validation (2026-10-23)

The 71 owned trajectories above are independently rechecked relative to a
**conservative, generated strict function-entry projection** of the original
upstream proof. The original proof is also executed in V8 with only its ESM
`export` keywords removed and its result/input graph compared against the
lowered V8 execution. This establishes independently checked agreement in
the accepted function-only profile, **not complete ESM module initialization,
load-time effects or arbitrary JavaScript equivalence**. The public semantic
trace sites currently refer to the **lowered source**, with exact SHA-pinned
original proof provenance attached; reverse source-site mapping to original
file positions is an outstanding requirement for original-file-anchored
training/evaluation. Intermediate V8 source-operation/branch checks are
performed on the lowered source, not the unmodified ESM module.
This limitation is material for trace readability and causal source fidelity.

- [x] [Latest comprehensive CI run](https://github.com/werg/tracing-js-self/actions/runs/39991640430):
  independent owned-candidate pipeline **passed**, writing 71 locally
  verified, non-admitted trajectories plus a categorized refusal report
  and Markdown readability preview.
- [x] The other six workflows on commit
  `bd696d0fe5aecce554932cf3b83e7ae0cb6fd696` also passed.
- [ ] Implement certified source-site correspondence from strict owned
  lowering to original JS/TS sources, ESM initialization traces,
  tests for original module environment semantics, and more complete
  independent intermediate-effect evidence before higher assurance
  or wider upstream automatic execution.


---

## 2026-10-23 — Exhaustive source-catalog disposition and original-site provenance

### Implemented

- [x] Added `src/corpus/original-sites.mjs`: an independently auditable,
  exact-token source-site mapping from strict function-entry projection back
  to SHA-locked upstream JavaScript. The map exposes original positions ONLY
  for byte-identical spans (original function bodies and parameters).
  Synthetic `function`, `return`, strict-mode and wrapper tokens are
  explicitly unmappable; **original-position equivalence is never invented**.
- [x] Each new locally verified Exercism episode gets a private
  `owned-source-site-audit/1` record with per-semantic-event original span
  receipts, verified source hashes, and explicitly unanchored event counts.
  Existing public `semantic-execution/2` uses the actual lowered source, so
  a further schema/source-context upgrade is required to expose these original
  spans as model-visible source coordinates.
- [x] Added fail-closed full-corpus conversion disposition
  (`tools/convert-full-corpus.mjs`). It streams every acquired Test262,
  Exercism and JSON Schema record, assigning **exactly one** verifiable result
  or specific refusal, with stable source identity, project split, per-input
  provenance and deterministic ledger hash. It can join only the independently
  rechecked, original-source-matched Exercism proofs; anything else stays
  explicitly unconverted.
- [x] CI `full-acquisition` runs the pinned 20-proof owned verification
  **before** the exhaustive disposition, retaining a compact report, audited
  original-site traces and an exhaustive refusal JSONL.
- [x] Added negative/forgery tests: no unsupported Test262 harness or JSON
  Schema contract may masquerade as an owned semantic-execution trace.
- [ ] **Not yet solved:** arbitrary Test262 harness execution, phase-accurate
  early/runtime/async/module completions, real pinned JSON Schema validators
  traced by the owned interpreter, general ESM module semantics, host services,
  Proxy/accessor/iterator interleavings, unbounded execution chunking, and
  full-scope independent operation-level oracles. Conversion of all acquired
  fixtures cannot honestly be claimed until these are implemented.
- [ ] Await actual CI-run totals for original-site receipts and complete
  disposition. Maintain the distinction between exhaustive accounting and
  complete executable verification.

Converting a JSON Schema *document* or an Exercism *expected result* to a
JSONL row is not semantic execution. An unsupported script, an invalid
source-module projection, a native V8 diagnostic, or a self-replayed but
independently unchecked owned trace may **never** count as a verified
`semantic-execution/2` training candidate.


### Exhaustive conversion disposition: verified CI evidence (2026-10-23)

The full checked-out-source run in
[GitHub Actions 39994536985](https://github.com/werg/tracing-js-self/actions/runs/39994536985)
successfully classified **117,773/117,773** individually acquired fixtures
with no missing or duplicate candidate identity:

| Origin | Acquired | Locally verified owned `semantic-execution/2` | Explicit refusals |
| --- | ---: | ---: | ---: |
| Test262 | 103,582 | 0 | 103,582 |
| Exercism canonical | 2,330 | **34** | 2,296 |
| JSON Schema | 11,861 | 0 | 11,861 |
| **All** | **117,773** | **34** | **117,739** |

The original Exercism pilot also yielded **37 additional verified synthetic
input variants**, for **71 independent owned episodes in total**, 34 of which
join uniquely and exactly to the full acquired catalog. The remaining 37 are
outside the canonical record denominator. Every positive match requires
full upstream file SHA provenance, canonical expectation agreement, a
post-serialization independent owned check, and an original-token mapping
audit. **All training-admitted counts remain zero**.

Breakdown of major Test262 refusals: 58,123 missing full owned harness,
24,694 unmodeled extra harness includes, 10,815 async cases, 8,487
phase-sensitive negative cases, 873 module/raw variants and 590 metadata
review cases. The **entire 11,861-case JSON Schema inventory** still
requires real version-matched JS implementations that can be executed
and traced by the owned machine; the expectation-only schema datasets
contain no such implementation.

- [x] Full 1:1 conversion/refusal ledger complete with deterministic identities,
  auditable source IDs and no false admissions.
- [x] Original JS byte-preserving source spans audited for the verified
  function-entry corpus; synthesized tokens explicitly unmapped.
- [ ] **Full conversion NOT achieved**. Only 34 of 117,773 acquired fixtures
  currently have a locally verified owned semantic-execution training candidate.
- [ ] Extend the full Test262 official harness and source-level native
  reference to a complete owned implementation; the added bounded scalar
  reference runner is a **diagnostic** not a training example producer.
- [ ] Introduce independently checked owned validators/parsers and full
  module/async/proxy/host-runtime semantics before attempting to certify
  the remaining inventory.


### Test262 real execution and function-entry bridge (2026-10-23)

The selected owned-script and independent native-V8 scalar smoke in
[Actions 39995361249](https://github.com/werg/tracing-js-self/actions/runs/39995361249)
measured **7 owned/V8 assertion+replay agreements out of 217 attempted
Test262 programs**, with **210 explicit unsupported**. This is **not**
general Test262 conformance or training readiness.

To attempt true `semantic-execution/2` training candidates for this
bounded subset, `src/corpus/test262-training.mjs` wraps the original
Test262 body *verbatim* in an owned strict function-entry harness that
counts SameValue/notSameValue assertions. Promotion requires (i) original
native Test262 scalar assertion success, (ii) function-wrapped native
V8 behavior matching the original, (iii) complete `training-js/1`
interpreter verification, executed branch/operation receipts, model-visible
controller rollout and after-serialization independent recheck, and
(iv) original Test262 test-body source-site receipts. The wrapper is
**not** an implementation of the official full harness, strict/module
variants, `$DONE` async or negative-phase semantics. Cases whose
functionalization changes any observed scalar behavior are refused.

- [x] Independently checked bounded original Test262 scalar diagnostics,
  retaining detailed refused status and source hashes.
- [x] Implemented fail-closed Test262 strict function-entry training bridge,
  with original-body-only byte-preserving source-site mapping.
- [x] Full-inventory disposition can join only actual rechecked, original
  SHA-matched Test262 wrapper traces for their *specific sloppy variant*.
- [ ] Measure number of Test262 `semantic-execution/2` training candidates
  promoted by actual CI execution and update the measured full ledger.
- [ ] Official harness, asynchronous/host semantics, arbitrary program
  initialization and full conformance remain open.


### Final measured bounded Test262 promotion and exhaustive accounting (2026-10-23)

[Full pipeline run 39996374782](https://github.com/werg/tracing-js-self/actions/runs/39996374782)
successfully rechecked **6 Test262 scalar function-entry semantic-execution/2
episodes** out of **7 Test262 owned-script/native-V8 diagnostic agreements**
(217 source files attempted, 210 unsupported). The seventh case refused
training conversion. Test262 successes underwent original-source scalar
assertions, independently checked function-wrapper outcomes,
`training-js/1` source-operation/branch audits, controller rollout, exact
owned-journal replay, serialization recheck, and original Test262-body
source-site receipts. No official comprehensive Test262 harness support is
implied.

The resulting **complete 117,773-row acquisition disposition** now reports:

| Source | Input fixtures | Locally verified owned `semantic-execution/2` | Explicitly refused |
| --- | ---: | ---: | ---: |
| Test262 | 103,582 | **6** | 103,576 |
| Exercism canonical | 2,330 | **34** | 2,296 |
| JSON Schema | 11,861 | **0** | 11,861 |
| **Total acquired catalog** | **117,773** | **40** | **117,733** |

Separately, **37** generated Exercism variants passed owned checks but are
*outside* this canonical catalog, giving **77 locally verified episode
candidates across the work**, all explicitly **non-admitted**. Generated
variations and duplicate Test262 strict/sloppy variants are not counted as
new upstream functions. Exhaustive accounting is complete; **full
conversion is not**.

- [x] Promoted six Test262 original-source scalar scripts to real,
  independently checked, source-mapped local owned training candidates.
- [x] Distinguished true local owned episodes from script-only diagnostics,
  canonical declarations, and unsupported guest/host execution.
- [x] CI now enforces a 40-case total owned result in the full conversion
  ledger and six Test262 locally verified bounded scalar cases.
- [ ] Implement full harness, complete ECMAScript owned semantics, compatible
  real JSON Schema validator internal execution, rich host/async effects,
  general module graph and independently checked exotic/proxy operations
  before remaining 117,733 cases can be considered for promotion.
- [ ] Independent downstream megatoken data admission is **still zero** and
  remains gated by actual consumer/model evaluation.


### Additional offline test-mining groundwork (2026-10-23)

- [x] Added an opt-in static `test-catalog` importer for normal tests, literal table rows, disabled declarations, `Deno.test`, suite ancestry and original source offsets, without evaluating any upstream code.
- [x] Dynamic/nonportable tables, nonstatic suites and empty tables receive explicit non-execution statuses. Regression tests exercise malicious expressions, provenance, disabled cases and duplicate identities.
- [ ] This is **not** the full executable Jest/Vitest/Node/Deno adapter or dynamic recorder. Isolated runner-specific setup, side-effect capture, independent replay, owned verification and training admission are still required. The prior 117,773 acquired / 40 canonically owned / 37 generated owned / zero admitted measurements are unchanged.


### Additional native Test262 reference diagnostic adapter (2026-10-23)

- [x] Added an explicit opt-in, pinned-checkout native-V8 harness-backed Test262
  script adapter with sloppy/strict execution, expected parse/runtime error
  checks, genuine error-constructor matching and categorized refusals.
- [x] Added focused regression tests for mode differences, spoofed error names,
  phase mismatches, timeouts, missing harness includes and non-admission.
- [ ] Not a complete official Test262 runner: module, async, early/resolution
  phases, host-dependent tests and cross-engine semantics remain unsupported.
  No newly verified owned traces or training-admitted episodes are claimed.
  The existing 117,773 acquired / 40 canonically owned / 37 generated owned /
  zero admitted ledger remains unchanged.


### Bounded native Test262 module diagnostics (2026-10-23)

- [x] Added an opt-in experimental Node VM **static ESM native reference**
  adapter. It loads pinned relative test-tree fixtures and real harness files,
  distinguishes parse/resolution/runtime negative errors by genuine guest
  constructors, and places deadlines on module linking/evaluation.
- [x] Explicit refusals cover unsafe or absent import paths, imported fixture
  parse failures, dynamic imports, unsupported flags, unresolvable top-level
  await, and missing experimental module support. Dedicated subprocess tests
  exercise phase mismatches, forged errors, and module scoping.
- [ ] These are **native-V8 diagnostic observations only**: not owned JS
  execution, independently checked intermediate events, or training records.
  Previous acquired/owned/admitted measurements remain unchanged, and no
  full-upstream module reference yield has yet been measured.
- [ ] Full official Test262 module/async host semantics, early-phase
  distinction, cross-engine checks, isolated bulk execution, owned module
  tracing, JSON Schema validators and megatoken admission remain open.

### Bounded native Test262 asynchronous script diagnostics (2026-10-23)

- [x] The opt-in pinned-checkout reference runner now routes `flags: [async]` *scripts* through a bounded `$DONE` diagnostic adapter for sloppy/strict modes. VM-local promise microtasks are drained; positive and parse/runtime-negative outcomes are separated, duplicate/missing completions and unhandled rejections are checked, and forged `{name: ...}` errors never match genuine error constructors.
- [x] Focused offline regression tests cover completion, strictness, incomplete/malicious metadata, missing/unsafe harness includes, native timeouts and rejection-after-completion. This is **native V8 diagnostic evidence only** (`verifiedOwned: false`, `admitted: false`).
- [ ] Full official Test262 async completion across timers/host callbacks/event-loop turns, async modules, and comprehensive upstream suite yield remain **unmeasured/unimplemented**. In-process `node:vm` remains unsafe for untrusted sources; isolated workers are still required. Previously measured 117,773 acquired / 40 canonical owned / 37 generated owned / zero admitted remain unchanged.

### Opt-in pinned structured-suite execution bridge (2026-10-23)

- [x] Implemented a generic **native-JS diagnostic** bridge for JSON Schema
  and CommonMark acquisition rows. Each binding declares the original input
  repository SHA, JS implementation repository SHA, license, module SHA-256,
  named API export, and exact supported JSON Schema dialects.
- [x] Individual acquired input sources are SHA-256 rechecked against a clean
  pinned checkout before execution. A bounded single-use Node worker checks
  actual native JS validity/HTML outputs against upstream contract labels.
  Disagreements, incompatible dialects, stale code, duplicates, exceptions
  and timeouts cannot produce reference agreement. Regression tests use
  synthetic pinned implementations; **no production Ajv/CommonMark yield**
  has been measured by this new runner.
- [x] All results are **native-v8-diagnostic-only**, verifiedOwned: false,
  admitted: false. The explicit --trusted-execution requirement is not a
  security boundary: Node child processes with memory/deadline limits are
  not isolated from host files, network or credentials. Untrusted upstream
  packages require externally provisioned restricted sandboxes.
- [ ] Pair and measure real pinned implementation packages, verify their
  version-specific compatibility and independently own-trace their internal
  computations. Previous 117,773 acquired / 40 canonical locally owned /
  37 generated locally owned / zero admitted figures remain unchanged.

Example for **trusted local** clean pinned checkouts:

~~~sh
node tools/verify-structured-contracts.mjs \
  --trusted-execution --binding /path/to/pinned-binding.json \
  --input corpus/out/full/json-schema.jsonl \
  --inputs-root /path/to/pinned/input-suite \
  --implementation-root /path/to/pinned/js-implementation \
  --max 100 --timeout-ms 500 \
  --output corpus/out/structured-reference.jsonl \
  --report corpus/out/structured-reference-report.json
~~~

Binding format: structured-corpus-binding/1 with kind, inputRepository,
inputRevision, and implementation fields repository, revision, license, file,
sha256 and entry. JSON Schema requires an explicit dialects array and its
export must implement validate(schema, data) -> boolean. CommonMark uses
kind commonmark-contract and render(markdown) -> string without dialects.
These are compatibility-shim contracts, not assumptions about package APIs.

### Rechecked owned-episode path novelty and diversity (2026-10-23)

- [x] Added opt-in post-verification selection of owned Exercism episodes.
  Each candidate is independently rechecked from its serialized sidecar,
  then read for **executed** source-site branch decisions and original journal
  operation transitions. Greedy coverage selection favors genuinely new
  pinned source families, branch paths, operations and mutation operation
  types. Different random seeds alone do not create unique source families.
- [x] Mixed train/validation/test split assignments within an exact source
  family, duplicate case identifiers, malformed journals and forged evidence
  are explicitly refused. The selection output is a small metadata report,
  not an automatically approved training collection.
- [x] The owned Exercism workflow now runs this selector on **its own** locally
  verified, non-admitted episode JSONL artifact, and uploads the report.
- [ ] Cross-fork and near-duplicate source-family clustering, actual caller
  graph equivalence, independent shrinking, real state-machine generation and
  richer scheduling/heap effects remain future work. This selector does not
  increase the acquired/owned/admitted episode denominators.

Example: npm run corpus:owned:novelty -- --input
  corpus/out/exercism-owned-locally-verified.jsonl
  --output corpus/out/exercism-owned-novelty.json --limit 64

### Full-checkout Test262 reference yield collection (2026-10-23)

- [x] Full-source acquisition CI now executes a bounded, opt-in **native V8**
  Test262 diagnostic sample from the exact pinned source revision. It enables
  experimental static VM modules and routes async scripts to the limited
  $DONE adapter. The report enforces 800 actual attempted execution variants
  and explicit passed/failed/unsupported counts and zero owned/admitted.
- [x] [Successful full upstream CI run 40010391704](https://github.com/werg/tracing-js-self/actions/runs/40010391704)
  measured **800** bounded original Test262 variant attempts: **406 passed**,
  **87 failed**, **307 explicitly unsupported**, **0 newly owned verified**,
  **0 admitted**. This is a native-V8 diagnostic sample, **not** full Test262
  conformance or a new owned semantic training yield. The same run kept the
  original complete 117,773-row acquisition ledger at **40 canonical owned
  locally verified / 117,733 explicitly refused / zero admitted**.

### Pinned additional project test mining (2026-10-23)

- [x] Extended the offline test catalog to capture Deno `*_test.ts`,
  conventional Mocha `test/*.js` files, and QUnit.test declarations,
  retaining original source spans, source SHA-256, pinned project revisions,
  nonportable titles and explicit non-execution statuses. The importer never
  runs test expressions or framework hooks.
- [x] Added a separate source-locked GitHub Actions acquisition job for
  lodash/lodash@2b5e6f7399a7b48005140b5d5c6bc6c0e62919a8,
  denoland/std@f834d0223364361169314833e3c7a8f62ce11d58 and
  ramda/ramda@f4b2e35ff433e18c751326b82acc3c6ab3585e18.
  It emits independent JSONL catalogs and disposition/status summaries,
  checking counts and rejecting any falsely verified/admitted fixtures.
- [x] [Successful cross-project mining CI run 40011171530](https://github.com/werg/tracing-js-self/actions/runs/40011171530)
  measured **7,913** additional static test declarations across **762**
  original source files: Lodash **1,892 / 3 files** (1,402 requires-runner,
  490 dynamic), Deno Standard Library **4,774 / 484 files** (4,757
  requires-runner, 16 dynamic, one upstream-disabled), Ramda **1,247 / 275
  files** (1,237 requires-runner, ten dynamic). All entries remain
  **acquired-only, zero executed/owned/admitted by this job**. These 7,913
  declarations are outside, and must not be added as verified episodes to,
  the previous 117,773-row catalog.
- [ ] Full test framework setup, dependency graphs, dynamic parameterization,
  real side-effect capture and independently checked owned execution remain
  prerequisites for promoting these sources.


### Additional owned-source clone and quantitative quality guards (2026-10-23)

- [x] Added bounded token fingerprints of independently rechecked owned JS
  executions. Identical and consistently identifier-renamed source clones,
  plus high-overlap shingle matches, group across repositories and paths.
  Cross-split matches refuse selection; within-split clones share the same
  source-family novelty weight. Token heuristics are not a semantic oracle.
- [x] Added post-verification, non-admitted trace-quality diagnostics for
  generated record bytes, group/event compression proxies, reported
  original-site source receipts, quantiles and a manual inspection queue.
- [x] Added regression tests and CI enforcement in the owned-Exercism workflow.
- [ ] This does not complete Test262 conformance, arbitrary module/async/host
  runtime support, JSON Schema owned validator execution, comprehensive source
  equivalence detection, independent human readability assessments, or
  downstream megatoken training admission. The previously measured owned and
  admitted episode denominators are not increased by this analysis.


### Reproducible native mismatch shrinking (2026-10-23)

- [x] Added opt-in, deterministic, bounded JSON argument shrinking for pinned
  Exercism original-code versus strict-lowering native V8 disagreements.
  Every accepted reduction is rechecked by running **both** sources;
  throws, failed oracles and budget exhaustion never create owned traces.
- [x] Regression tests cover scalar/string/array reductions, non-reproduction,
  predicate exceptions and oracle-call limits, with CI opt-in coverage.
- [ ] General native-to-owned semantic divergence shrinking, stateful command
  minimization and independent interpreter-step adjudication remain open.
  Native mismatch minimization does not change acquired, locally owned or
  training-admitted corpus denominators.


### Opt-in complete pinned Test262 native diagnostic sweep (2026-10-23)

- [x] Added source-locked full-catalog native Test262 execution **infrastructure**:
  16 deterministic shards over the same pinned 103,582-variant acquisition
  JSONL, a SHA-256 identity digest of every acquired row, streamed native
  reference JSONL with per-row source/mode/ordinal receipts, strict counts
  and a fail-closed aggregate that rejects missing, repeated, truncated,
  cross-revision or modified shards.
- [x] Added a manual full-sweep GitHub Actions workflow using isolated,
  read-only, no-network, unprivileged Docker workers with memory and process
  caps. All upstream sources are fetched at the exact pinned revision and
  individually SHA checked before native execution. No upstream npm install
  occurs in the execution sandbox.
- [x] Added synthetic-pinned end-to-end two-shard execution/aggregation tests
  and adversarial ledger integrity tests.
- [ ] **Full-suite run has not been measured by this commit**. This makes a
  source-complete diagnostic accounting run possible, not a complete Test262
  harness or a semantically verified training corpus. Unsupported async
  modules, timers, exotic host services, early-error distinctions, engine
  comparisons and intermediate owned semantics still require implementation.
  Real full-sweep pass/fail/refusal totals must come from a successful workflow
  artifact, never from a forecast. The pre-existing 117,773 acquired / 40
  locally verified canonical owned / 37 additional owned / zero admitted
  figures remain the last measured full-catalog evidence.

To run manually select *Full pinned Test262 native-reference sweep (diagnostic
only)* in Actions. The workflow has no automatic bulk execution trigger. Its
aggregate status is accepted only when all 103,582 pinned input variants
appear exactly once, and no row claims owned verification or admission.


### Native-reference raw scripts and sample accounting correction (2026-10-23)

- [x] The native Test262 script diagnostic now supports `flags: [raw]`
  without implicitly loading harness files or adding a strict directive.
  Declared parse/runtime errors still require genuine V8 error constructors.
  Raw fixtures declaring harness includes or unsupported mixed flags refuse.
- [x] Corrected sample/shard accounting so **each execution ordinal** is
  counted once; source identity duplicates remain separately rejected.
  Prefix `--max` execution retains its previous bounded sampling behavior,
  while explicit full-inventory sharding still inventories every record.
- [ ] Raw native success cannot independently certify unasserted execution,
  official harness conformance or owned training semantics.


### Bounded opt-in Test262 asynchronous virtual host turns (2026-10-23)

- [x] Added a deterministic native-V8 async-script *diagnostic* host model
  for `setTimeout`, `clearTimeout`, `setInterval`, `clearInterval`
  and `queueMicrotask`. Guest timer callbacks run inside the VM timeout
  boundary; only 64 virtual timer turns are permitted per test. Duplicate
  `$DONE` calls, callback exceptions, incomplete completions and
  unhandled rejections remain explicit failure/refusal evidence.
- [x] The separately opt-in full-source native Test262 sweep now uses
  `--host-timers`; the normal bounded sample stays unchanged.
  Focused tests cover completion, cancellation, late failure, interval
  exhaustion and forged negative-error objects.
- [ ] This virtual clock is not real wall-clock scheduling, host event-loop
  conformance, async ESM completion, `$262.agent`, network/filesystem
  semantics or a complete official Test262 harness. It does not
  independently certify intermediate owned scheduling events, and cannot
  turn native diagnostics into semantic-execution training records.


### Production helper owned checks, real Ajv reference, bounded async modules (2026-10-23)

- [x] Added a SHA-locked, unchanged-token extraction bridge for independently
  verifying selected pure helper function bodies from the **real pinned Axios**
  vendor source. Each execution is passed through the owned machine, native
  V8 outcome/operation/branch oracle, model-visible rollout, post-serialization
  recheck and a source-span receipt. Unrepresentable functions are explicit
  refusals; all results remain non-admitted. This is a bounded projection of
  individual production function bodies, **not full library initialization,
  module graph or arbitrary event-emitter internals**.
- [x] Added an optional real production **Ajv 8.17.1** reference adapter
  for the locked JSON Schema Test Suite snapshots. It executes Ajv-compiled
  validators inside a restricted CI container, retains input SHA/commit and
  the package tarball integrity, records generated validation-code hashes,
  and separates agreements/disagreements/unsupported schemas. These are
  **native V8 diagnostics, not owned-traced validator internals**.
- [x] Added bounded native ESM module `flags: [module, async]` reference
  execution with guest-realm `$DONE`, duplicate/missing completion checks,
  native error-constructor matching, and top-level-await deadlines.
- [ ] **Still open:** owned execution of general Ajv code generation,
  complex production-library initialization/closures, full Promise/host
  task scheduling, complete module loader and CJS/ESM interop, Test262
  `$262.agent`/real timers/environmental capabilities, and admission of
  large-scale verified semantic traces. Native V8 output agreement or
  generated-code hashes are never treated as a verified owned journal.
  Full ECMAScript/host conformance is not established by these additions.


### Measured real production code and validator outcomes (2026-10-23)

The production-helper pipeline has now completed its expanded CI check:
[run 40019121072](https://github.com/werg/tracing-js-self/actions/runs/40019121072)
verified **19/23** independently rechecked, SHA-pinned original Axios
interceptor and utility function-entry executions using the owned runtime.
Four executions explicitly refused; **zero** were admitted.

[Ajv run 40018572124](https://github.com/werg/tracing-js-self/actions/runs/40018572124)
measured **822 / 907** real Ajv 8.17.1 native-reference agreements across
26 pinned JSON Schema Test Suite source files, plus 29 disagreements and
56 unsupported cases. These **907 remain native diagnostics** with **zero
owned validator-internal traces** and **zero training admission**. Original
schema input hashes and generated Ajv code hashes are included in the
diagnostic records.

The Test262 experimental native ESM async adapter now also detects late,
unhandled promise rejections after successful `$DONE`. Dedicated
module regressions are run in a VM-modules-enabled child process with
an exact expected test count. This supports a bounded native reference
subset, not general owned async ESM or complete host scheduling.

**Unfinished:** arbitrary production-library class/closure/module
initialization in the owned interpreter, tracing Ajv-generated validation
operations with independent owned verification, full ECMAScript
module/Promise/event-loop conformance, native service and agent semantics,
and downstream corpus admission.


### Original Axios closures, generated Ajv verifier, ESM/Promise checks (2026-10-24)

- [x] Extended source-locked Axios verification with the **actual unchanged
  nested typeOfTest closure-factory expression** from pinned utils.js,
  executed inside an owned guest entry as a closure allocation and captured
  callback call. The exact source span, whole-vendor SHA-256, independent
  V8 outcome, operation/branch audits, model-visible training projection and
  post-serialization evidence recheck are all required for local verification.
- [x] [Successful owned production run 40083313258](https://github.com/werg/tracing-js-self/actions/runs/40083313258)
  measured **11/11 additional locally verified original Axios closure-entry
  executions**, zero refusals, zero admissions. These are separate from the
  existing **19/23** locally verified original Axios helper executions.
  This is an original closure-expression entry projection, **not** complete
  Axios module instantiation or InterceptorManager class execution.
- [x] Added opt-in Ajv 8.17.1 generated-code owned attempts alongside, and
  separate from, the original native reference run. The verifier hashes,
  parses and checks the generated function, refuses referenced native scope
  captures, supports only audited pure omitted-context parameter defaults,
  independently checks original generated V8 output against real Ajv output,
  and demands owned intermediate operation/branch evidence plus serialized
  recheck. Source hashes or agreement alone never certify a trace.
- [x] [Real Ajv run 40084271389](https://github.com/werg/tracing-js-self/actions/runs/40084271389)
  tried **12 distinct generated validators from 12 original locked JSON Schema
  source files**: **0 locally owned verified / 12 explicit refusals /
  0 admitted**. Independent native diagnostic totals remained **822 reference
  agreements, 29 disagreements and 56 unsupported** out of 907. Most rejected
  generated code requires scope/context not owned by the interpreter.
- [x] Added owned ESM regression coverage for one-time shared closure
  initialization and for top-level-await Promise reaction ordering across
  dependencies, including native ESM outcome comparison and exact replay.
  This is a narrow test of existing bounded semantics, not full conformance.
- [ ] **Full remaining roadmap is still open**: general production-library
  class initialization, package and dependency loaders, Ajv generated
  validators requiring native scope, complete ESM/CJS interop, Promise
  executors/combinators/thenables, real host scheduling, worker agents and
  SharedArrayBuffer semantics, cross-engine conformance, and downstream
  megatoken training admission.

The separate Ajv owned-attempt path is opt-in using --owned-max (CI uses 12)
and retains both refusals and independently checked local candidates. It
executes only in the trusted, source-locked restricted CI environment, and
does not treat native V8 as an owned interpreter.


### Owned single-agent microtask queue and Promise FIFO integration (2026-10-24)

- [x] Implemented a bounded guest-owned queueMicrotask(callback) operation.
  It queues original guest function identities alongside owned Promise
  reactions in the same serialized FIFO job queue. Each microtask callback
  runs as an owned invocation after the current activation unwinds, and may
  queue another microtask.
- [x] The independent trace validator now checks FIFO consumption, queued
  callback identity and invocation evidence, rather than trusting the
  interpreter or accepting forged job ordering. New focused tests exercise
  Promise interleaving, nested callbacks, invalid callbacks, and tampered
  archives with exact replay.
- [ ] This models **only single-agent owned microtasks**. It does not implement
  native timeouts, interval cancellation, process.nextTick, platform event
  loop checkpoints, unhandled-rejection hooks, worker agents, Atomics,
  SharedArrayBuffer, or the official Test262 agent service. Full host
  scheduling and multi-agent conformance remain future work.


### Bounded virtual scheduling and scripted shared-memory diagnostics (2026-10-24)

- [x] Added replayable **owned** `Promise.all` and `Promise.race` over dense
  arrays up to 64 entries, with explicit Promise observation jobs. General
  iterators, thenables, executors, species/subclassing, `any`, and
  `allSettled` are not implemented.
- [x] Added an owned deterministic virtual-clock `setTimeout` /
  `setInterval` task queue with cancellation. It drains existing Promise and
  queued-microtask jobs before every timer turn, logs owned callback execution
  and checks task-time/order receipts during replay. It is not a real platform
  event loop or full Test262 host harness.
- [x] Added a **separate scripted agent diagnostic**, `bounded-agents/1`,
  that simulates sequentially consistent shared Int32 cells, `Atomics`-like
  load/store/read-modify-write/compare-exchange and FIFO wait/notify with
  bounded virtual timeouts. It is deterministic and replays its transcript.
  Unlike owned bytecode execution, it does **not** interpret worker JavaScript
  and is **not** an owned guest trace or training example.

- [x] The owned bytecode machine now additionally models **single-agent**
  `SharedArrayBuffer`/shared-`Int32Array` identities and bounded `Atomics`
  load/store/read-modify-write, compare-exchange, zero-timeout wait and
  notify. Its cell mutations and aliasing are archived and replayed, with
  selected native-V8 outcome probes. This is not true shared native memory,
  agent concurrency, general typed arrays or a cross-agent owned trace.
- [ ] Full outstanding roadmap: general module resolution and ESM/CJS
  interoperability, arbitrary production-library initialization, Promise
  constructors/executors and thenable assimilation, all Promise combinators,
  real host tasks and environment capabilities, genuine workers,
  `SharedArrayBuffer`-backed guest memory and agent memory ordering,
  Test262 `$262.agent` integration, real production Ajv owned-trace yield,
  cross-engine verification and megatoken training admission.
  Previous measured corpus denominators are unchanged by these new
  bounded capability regressions.


### Actual parallel native workers: separate diagnostic facility (2026-10-24)

- [x] Added an opt-in, Node-only trusted-source `runNativeWorkerAgents`
  diagnostic using genuine `worker_threads`. Agents receive the same native
  SharedArrayBuffers and execute in parallel V8 agents; `Atomics` byte-level
  aliasing, integer coercion, read-modify-write, wait/notify and native memory
  ordering are supplied by the engine rather than a scripted model. Focused
  tests cover concurrent Int32 increments, a blocking cross-agent notification
  and BigInt64 atomic updates.
- [ ] These native outcomes **are not** owned bytecode journals or independently
  verified semantic traces. The interface is only safe with **trusted** worker
  source; it must never execute automatically acquired untrusted programs.
  Owned worker scheduling, arbitrary guest shared-memory typed arrays, full
  Test262 agents, and cross-engine memory-order validation remain unfinished.
  No owned/admitted corpus yield is claimed.


### Bounded owned Promise constructors (2026-10-24)

- [x] `new Promise(executor)` invokes synchronous guest executor frames with
  first-call-wins resolve/reject functions. Executor throws reject the
  constructed Promise unless resolution has already occurred. Regression
  tests check journal reconstruction and exact replay.
- [ ] Async executors, general thenable assimilation, species/subclassing
  and full combinators are not modeled. This does not change corpus counts.


### Owned Promise thenable assimilation (2026-10-24)

- [x] Added bounded ordinary-object `then` getter assimilation, serialized
  FIFO callback execution, original receiver, first-call-wins resolving
  functions, thrown then callbacks, and nested Promise adoption.
  The owned interpreter now shares this path across `Promise.resolve`,
  `await` and existing dense combinators. Verification includes new
  source-level tests, journal validation and replay checks.
- [ ] Species/subclassing, exotic and Proxy getters, general iterables,
  complete Promise and host scheduling conformance still remain open.


### Integrated Promise, byte-backed shared memory and worker evidence (2026-10-24)

This integration connects **owned byte-addressed memory**, the guest parser,
Promise scheduling, real native worker diagnostics, runtime validation and
differential regression tests. It is deliberately not a claim that the JS
interpreter now executes native workers or that the entire roadmap is finished.

- [x] Extended the bounded parser to accept anonymous function expressions
  supplied to `new Promise`, ordinary owned thenable properties and Promise
  reactions; executor tests now exercise parsed guest functions rather than
  failing before execution.
- [x] Owned Promise resolution now has queued ordinary data-property thenable
  assimilation, first-settlement-wins capabilities, nested Promise adoption,
  bounded cycle refusals and catchable executor/thenable throws. Expanded
  dense-array combinator support to `Promise.allSettled` and `Promise.any`,
  including ordered outcome records and AggregateError-shaped rejection data.
  All interpreter jobs are logged with FIFO causal receipts and exact replay.
- [x] Replaced the former owned Int32-cell-only shared buffer with serializable
  **byte storage** and typed views across Int8/Uint8/Int16/Uint16/Int32/Uint32,
  BigInt64/BigUint64 and Float32/Float64, with offsets, shared aliasing,
  direct indexed stores, subarray and buffer slice, and integer Atomics
  on the supported typed array classes. The same bytes are reconstructed from
  the journal and tested against independent native V8 observations.
- [x] Kept the distinct native `worker_threads` pathway for **actual parallel
  V8 workers** sharing live `SharedArrayBuffer` objects, including blocking
  Atomics.wait/notify and BigInt64 updates. Native concurrent results remain
  trusted-input **diagnostics**, never owned semantic traces.

**Explicit remaining gaps:** General ECMAScript iterators, Promise species and
subclasses, proxy/accessor thenable continuation, unhandled-rejection host
hooks, async executor corner cases, real timers and task host integration,
arbitrary package loaders, true multi-agent owned-worker bytecode journals,
the complete ECMAScript SharedArrayBuffer memory model, growable buffers,
Test262 `$262.agent`, cross-engine interleaving adjudication, arbitrary
production application initialization, and training admission. None of the
previous owned/admitted corpus totals is changed by diagnostic worker results.


### Typed-array atomic store return semantics (2026-10-24)

- [x] `Atomics.store` returns the converted input integer/BigInt, without
  narrowing that return value to the typed lane's width. The shared bytes
  still truncate/wrap as specified. Differential cases cover seven native
  integer typed-array classes.


### Bounded growable SharedArrayBuffer guest semantics (2026-10-24)

- [x] Added owned growable SAB `new SharedArrayBuffer(n,{maxByteLength:m})`
  state, observable growability/maxByteLength, synchronous `grow(n)`,
  zero-filling of new bytes, length-tracking typed views and
  length-tracking `subarray` slices. Explicit-length views stay fixed.
  Tests require state-journal integrity, exact replay and native V8
  differential values wherever the installed Node version supports GSAB.
- [ ] Shared-memory agents remain single-agent inside the owned bytecode
  machine; native worker threads provide actual parallel shared-memory
  diagnostics. Full agent memory-order interleavings, native host effects,
  cross-engine evidence and general ECMAScript conformance remain open.


### Owned async Promise executor continuations (2026-10-24)

- [x] Asynchronous Promise constructor executors may now run guest `await`,
  resume on owned jobs and settle the separately constructed Promise by their
  captured resolver. The constructor disregards the async executor's returned
  Promise; its later throw/rejection must not replace a settled constructor.
  Tests cover replay and unresolved constructor promises.
- [ ] Unhandled-rejection reporting and complete async-host conformance remain
  unsupported; pending promises are not silently treated as fulfilled.


### Concurrent native worker memory-order evidence (2026-10-24)

- [x] Strengthened genuine native Worker tests with a two-agent rendezvous
  that cannot finish under a serial-only worker scheduler, plus ordinary
  byte writes published across agents via atomic synchronization and read
  through an independently typed native DataView.
- [ ] These native V8 executions remain trusted-source diagnostics; they do
  **not** constitute owned multi-agent semantic journals, independent
  cross-engine atomics proofs, or complete Test262 agent conformance.


### DataView views over owned shared byte memory (2026-10-24)

- [x] Added the bounded `new DataView(sharedBuffer[,offset[,length]])`
  constructor and all ten numeric/BigInt get/set pairs over the same
  archived shared bytes as typed arrays. Both endiannesses, fixed and
  length-tracking views, byte offset/length and underlying buffer
  properties have replayed owned guest operations, with independent
  native V8 output checks and explicit out-of-bounds tests.
- [ ] DataView is a single-agent byte-accurate owned subset, **not** a
  complete multi-agent shared-memory order or executable-worker model.
  Native worker diagnostics remain separate, and corpus admission
  numbers are unchanged.


### Owned Promise.withResolvers and deferred capability scheduling (2026-10-24)

- [x] Added bounded `Promise.withResolvers()` returning an owned promise and
  callable resolve/reject functions. The same first-settlement-wins behavior,
  queued thenable assimilation, virtual-timer delivery, journal validation and
  exact replay apply as for constructor-created capabilities. Focused tests
  exercise observable ordering and later settlement.
- [ ] This is intrinsic-Promise-only; species/subclasses, exotic `then`
  and complete host scheduling semantics remain open. No new training
  admission is claimed.


### Real parallel waitAsync and growable native shared memory (2026-10-24)

- [x] Extended the *trusted-only native worker diagnostic* to accept bounded
  growable SAB maximum lengths. Genuine independent workers now exercise
  `Atomics.waitAsync` plus cross-agent `notify`, and grow shared bytes
  concurrently with atomic publication; regression tests inspect native
  outputs and the final shared byte snapshot. Native feature availability
  is checked explicitly for compatibility with supported Node releases.
- [ ] Real worker diagnostics are still native V8 executions, not owned
  multi-agent bytecode events or a proof of cross-engine memory-model
  conformance. Do not automatically run acquired untrusted source here.

### Pinned stateful command oracle and counterexample reduction (2026-10-24)

- [x] Added a bounded deterministic stateful command-sequence generator,
  actual pinned `yocto-queue` V8 execution, and an independently implemented
  array-backed oracle comparing return values, size and ordered state after
  each operation. New `corpus:stateful:differential` CLI reports observed
  agreements/disagreements with source SHA-256 receipts, CI gating and no
  automatic training admission.
- [x] Added fail-closed stateful sequence delta-debugging with independent
  oracle rechecks, failure-signature consistency, hard execution budgets,
  and payload reduction. Regression tests cover successful minimization,
  malformed commands, oracle exceptions, flakiness and evidence segregation.
- [ ] This does not complete the full roadmap: general cross-project dynamic
  capture, Test262 conformance, original-source owned coverage for broad
  production modules, multi-agent guest semantics and certified training
  admission still require separate implementations and measurements.
