# Semantic execution v3 — integrated draft implementation and admission boundaries

This document records exactly what is present on the paired draft branches.
The governing acceptance contract is [SEMANTIC_TRACE_REDESIGN_PLAN.md](SEMANTIC_TRACE_REDESIGN_PLAN.md).
An implemented component is **not** evidence that the complete plan is
finished, and a local demonstration is **not** an admitted corpus example.

## Versions and APIs

The new `./src/training/index.js` exports:

- `analyzeSemanticProgram(source)` — static Acorn sites; source is published
  before execution and never filtered by which source branches executed.
- `compileWitness(bundle,semantic,{maxOperators:1|2|4|8})` — separate
  conservative compiler to typed `semantic-trace/3` lines, with private
  certificates and explicit unsupported projections.
- `encodeWitness`, `decodeWitness`, `validateExpression` — canonical
  operation-name-plus-JSON framing, strict scalar tags, bounded primitive
  expressions (at most 8 operators, at most 32 nodes), and data graph checks.
- `checkWitnessClaim`, `WitnessController` — independent primitive
  consistency checks, selected-state commits, no oracle repair, explicit
  deterministic effect fixtures and owned FIFO job transitions.
- `exportWitnessTraining`, `validateWitnessTrainingExport`,
  `evaluateWitnessTrajectory` — explicit version-three transport and
  artifact/source-outcome checks.
- `renderWitness` / `inspectWitnessPrefix` — public-only rendering
  for allocation, mutation, invocation, completion and control facts.

The version-three envelope declares `semantic-execution/3`,
`semantic-trace/3`, `semantic-context/3`, and
`semantic-supervision/2`. Segment packets use `semantic-continuation/3`.
The private owned archive retains `semantic-tracing-run/2`.
The language profile remains `training-js/1`: a trace grammar revision
does not change source-language coverage.

The old `exportTraining` API and version-two generator remain for regression
comparison. **The version-three path is not yet the single active production
writer or serving path.** Do not represent version-two bytes as version three.

## Observable graph boundary

Inputs and terminal graph comparison use descriptor inspection, never property
reads or `toJSON`. Supported ordinary data objects and arrays are extensible
with enumerable, configurable, writable own data slots. Array length has its
standard descriptor. Sparse holes, present-but-undefined array elements,
identity/alias/cycle topology, insertion order, and `Object.create(null)`
are preserved. Inaccessible custom prototypes, getters, sealed/frozen objects,
nonstandard data-property descriptors and proxy objects are explicitly
unsupported at the observable boundary. Bounded classified errors require a
separate completion contract, not data-object flattening.

## Three correctness categories

**Observable execution correctness** is measured on the selected completion,
reachable graph, ordered requests and effect responses, and pending required
work under the declared environment. It does not require teacher trace bytes.

**Witness consistency** checks claims against previously committed public
values under closed primitive semantics. Incorrect explicit arithmetic is
reported as `firstWitnessViolation` with *no repair*; correct final
observables can coexist with a reasoning violation.

**Artifact integrity** checks verified source execution, exact archived replay,
private transformation certificates, canonical serialization, and independent
V8 final outcomes. Canonical teacher bytes are generator regression evidence
only. `firstReferenceTraceDifference` is an explicitly text-only
diagnostic, distinct from `observableMismatch`.

## Run the currently executable work

From the tracer checkout after `npm ci`:

```sh
node --test test/training-witness-v3.test.js test/training-data-boundary-v3.test.js
node tools/generate-witness-v3.mjs --seed 42 --count 16 \
  --output /tmp/witness-v3.jsonl --manifest /tmp/witness-v3.json
node tools/recheck-witness-v3.mjs /tmp/witness-v3.jsonl
node tools/inspect-witness-v3.mjs /tmp/witness-v3.jsonl /tmp/witness-v3-inspection.json
npm test
```

From a paired `werg/megatoken` checkout:

```sh
python -m pytest -q tests/test_semantic_execution.py tests/test_semantic_execution_v3.py
python scripts/import_semantic_execution.py \
  --input /tmp/witness-v3.jsonl --output /tmp/witness-native.jsonl \
  --diagnostic-byte --allow-local
```

`--diagnostic-byte` is not the production tokenizer. The importer validates
physical bytes, loss masks and native episode conversion. It does **not**
grant training-data admission. Records are marked `locally_verified`, not
`admitted`; failures and unsupported source/effects are retained in the
manifest rather than hidden by dropping candidates.

## Supported execution and admission matrix

| Capability | Owned runtime | Independent evidence | v3 canonical compiler | Selected v3 controller | Corpus admission |
| --- | --- | --- | --- | --- | --- |
| Pure scalar arithmetic/choice | Yes | V8/replay | Conservative supported cases | Yes | Local only |
| Plain data arrays/objects/aliases/sparse holes | Bounded | V8/descriptor graph | Bounded | Bounded | Local only |
| Nested direct guest call/closure identity | Yes | V8/replay | Simple dynamic calls | Nested call/return | Local only |
| Caught throw/finally/completion replacement | Yes | Runtime replay | Not yet certified | Transfer primitive only | Refused |
| Accessor/coercion/proxy callback dispatch | Owned subset | Runtime replay | Not yet certified | Not yet | Refused |
| Registered external effects | Yes | Recorded fixtures | Not yet certified | Fixture-matched requests | Refused |
| Owned promise/await/microtasks | Owned subset | Runtime tests | Not yet certified | Typed FIFO jobs only | Refused |
| Selected rollover while suspended | Owned subset | Not complete | Not yet certified | Bounded state packet | Refused |
| Model-selected recurrence and learning comparison | Not applicable | Requires model runs | Experiment spec required | Offline diagnostics only | Not measured |

The typed schema and controller have broader standalone primitives than the
certified compiler currently emits. **Do not infer dataset support from the
presence of a wire operation or owned runtime feature.**

## Acceptance not yet satisfied

The v3 producer/controller does not yet project all catch/finally, implicit
coercion/accessor, callback traversal, detached Promise, async/effect service,
source code-on-call, and owned quiescence cases. Version-three consumer
selection and continuation do not yet demonstrate complete model-selected
recurrence. The local corpus has not been regenerated and admitted for all
pinned production families. The required matched-policy model experiments
(seeds 17, 29, 43) have no authorized checkpoint/compute configuration and
**no measured results**. Token counts from the production pinned codec,
latency/compute metrics and paired confidence intervals remain unmeasured.

Keep both pull requests as drafts and keep every unchecked acceptance item
unchecked until independent evidence exists. Never equate a byte reduction,
synthetic selected trace, successful parser import, or dry replay with a
learning improvement or a complete version-three delivery.
