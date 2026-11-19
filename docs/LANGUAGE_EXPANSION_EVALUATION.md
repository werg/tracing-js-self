# Language-expansion evaluation

This protocol separates five questions: whether owned execution is correct,
whether compact source idioms converge, whether local detail remains valid,
whether an independent native consumer agrees, and whether a model understands
and executes the format efficiently. A positive answer to one question does
not answer the others.

## Frozen populations

`fixtures/language-expansion/benchmark.js` declares 26 semantic families beyond
the original arithmetic/sum/private-state/counter emphasis. Each family has
three independently authored source idioms, eight edge inputs, and two
executable near misses. The fixtures cover lazy defaults/selections, bindings,
product folds, map/filter/search/quantifiers, counting, multiple accumulators,
scans, mutation, captured cells, receivers, cleanup, getters, enumeration,
BigInt, generators, classes, and symbol identity.

The independent V8 reference validates 624 positive executions and 52
counterexample pairs. These are reference-fixture checks, not evidence of
owned execution, source-operation certificates, or native admission. The
normalization check also rejects any executed semantic counterexample whose
source-derived compact cores are identical. Unsupported recognition remains
separate from failed normalization.

Fourteen interaction groups include getters with computed destructuring,
iterator exits with cleanup, generator delegation, asynchronous captures,
private class state with conversion, module live cells and top-level await,
shared typed views, RegExp replacement state, and closure aliases. Two module
interactions run through the original-module-graph adapter when v8 is selected.
The v7 run records them as unsupported. They remain visible in both denominators.

A frozen real-source slice selects 27 functions from the existing 78-function
pinned utility inventory: eight Lodash entries, eight VS Code array entries,
three VS Code number entries, and eight VS Code string entries. Selection uses
immutable source IDs before outcomes are inspected. Original source revisions,
TypeScript transformation provenance, input graphs, and selected/available
stratum denominators are retained. The original eleven-case gallery remains
unchanged and is a separate regression population.

The existing semantic-family registry assigns whole lineage/normalized-core
components before data variants are exported. Negative relatives stay with
their source family; original and transformed real-source ancestry is retained.
A source-spelling holdout must not be presented as a held-out semantic family.

## Reproduce and measure

Run from a committed producer; output directories must be new:

```sh
node tools/language-expansion-benchmark.mjs --out coverage/new-reference --mode reference
node tools/language-expansion-benchmark.mjs --out coverage/new-real-source --mode coverage --population real-source
node tools/language-expansion-benchmark.mjs --out coverage/new-gallery --mode coverage --population gallery
node tools/language-expansion-benchmark.mjs --out coverage/new-expansion --mode coverage --population all --inputs all
```

Select `--trace-version 8` for the compositional candidate. The runner defaults
to v7 so historical commands retain their original contract. An all-input v8
run declares 663 script attempts (624 family inputs, 12 script interactions,
and 27 real-source functions) plus two module interactions. The unchanged
11-case gallery is a separate population.

Before execution, `population.json` retains each exact source/module task,
canonical input graph, fixture plan, profile, and producer revision. Every
completed attempt, including a frontend refusal, is appended to
`attempts.jsonl`; unrecorded tasks in an interrupted run remain untested.
`source-CASE.json` preserves the complete worker result and source evidence,
while `serving-CASE.json` preserves the exact serializer inputs and costs.
`artifacts.json` hashes the final files' exact UTF-8 bytes. These artifacts
allow a completed population to be checked without regenerating its teacher
or treating a short progress log as the full evidence.

`--inputs first` is a smaller diagnostic, explicitly labeled as such. It does
not replace the all-input release population. Every source attempt stays in
its coverage denominator, including unsupported syntax, independent-reference
mismatches, resource limits, and detailed fallbacks.

`buildCapabilityLedger` defaults to v7, supports explicit historical v6, and
accepts v8 only with its actual source verifier and declared v8 contracts. Mixed
coverage reads the v8 producer's certified `sidecar.regionCoverage`, including
compact/detailed region and record counts. It never manufactures v8 coverage by
changing a version label. Native and model stages require their own evidence.

The native qualification runner uses the same frozen population:

```sh
node tools/qualify-semantic-v8.mjs --out ../v8-native-interoperability \
  --population interoperability --megatoken CONSUMER --tokenizer TOKENIZER_JSON \
  --python PYTHON --native-policy POLICY_JSON
node tools/qualify-semantic-v8.mjs --out ../v8-native-all \
  --population all --inputs all --megatoken CONSUMER --tokenizer TOKENIZER_JSON \
  --python PYTHON --native-policy POLICY_JSON
```

`interoperability` includes the original three mixed examples and every source
golden in `test/fixtures/semantic-protocol-region-v8.json`. It is not an alias
for three examples. The runner saves exact graph-encoded input tasks before
execution and appends completed attempts, including refusals. Native admission
rechecks source correspondence in the exact clean producer checkout and checks
that the returned receipt binds that source, public execution and every context.

## Notation and comprehension

`notation-experiment.js` renders the same validated records as canonical
functional text, formal code/math notation, hybrid notation, and controlled
prose. The canonical decoder remains the only executable spelling. Rendering
changes do not alter abstraction size, argument order, laziness, identities,
request routing, completion, or which facts are environmental observations.

The predeclared taskset contains 228 source-free questions. It combines 208
independently executed semantic scenarios, the original twelve comprehension
tasks, and eight protocol questions about getter invocation, cleanup,
generator input, captured state, optional arguments, concurrent requests,
module live cells, and setters. Public surveys omit answer keys, rationales,
source fixtures, and reference evidence. Reference execution establishes answer
keys; it supplies no model response.

The study preparer requires an exact model revision, settings, prompt, seed,
and cohort before response collection. Four deterministic cohorts rotate
notation assignment and answer order. Each evaluator sees one rendering per
task. Description-only tasks remain useful semantic screens but are explicitly
excluded from notation comparisons until a certified trace stimulus exists.
The default pilot has no noninferiority claim. A confirmatory protocol requires
a predeclared margin, and its power/sample size must be selected using a
separate pilot. A 228-task inventory alone is not evidence of sufficient power.

```sh
node tools/semantic-comprehension-study.mjs --out study.json \
  --model-id MODEL --model-revision EXACT_REVISION \
  --settings settings.json --prompt prompt.txt --cohort 0 --phase pilot
node tools/semantic-comprehension-study.mjs --out score.json \
  --study study.json --responses responses.json
```

Responses bind the frozen study digest, model revision, and settings. Scoring
retains unanswered tasks, per-arm denominators and Wilson accuracy intervals.
It reports supplied evaluator provenance without claiming independent
authentication. `scoreSelectedAlgorithmExecution` separately checks supplied
next-step/full trace candidates through the real selected controller under a
fixed prediction budget; it never repairs a false model claim.

No external comprehension responses or model execution results are fabricated.
Empty response sets remain `unmeasured`. Default promotion stays unqualified
until correctness, native agreement, external comprehension/execution and
fixed-usefulness total costs meet the declared gates.

## Full serving costs

`auditFlatServingCosts` calls the real `causalLmV7Prompt` serializer and, when
configured, the real segment encoder. It measures after immutable definitions
and inputs have expanded, retains exact serialized prompts/targets and optional
token IDs/masks, and counts every repeated prompt and generated EOS. Prompt
component token counts are not added: tokenization can merge across component
boundaries. Only the physical independently encoded prompt/target/EOS segments
are additive on this path.

The meter requires the existing exact tokenizer policy and lossless round-trip
checks. Without that adapter, exact bytes are retained and all token fields
are null. Native framing, fragmentation, caching and serving latency have their
own untested receipt; flat JSON or prompt counts do not stand in for them.

To meter both v7 and v8 with the same real tokenizer, set `MEGATOKEN_ROOT`,
`MEGATOKEN_TOKENIZER_JSON`, and `MEGATOKEN_PYTHON`, and set
`SEMANTIC_V8_TOKENIZER_POLICY` to a JSON file containing `consumerRevision`,
`tokenizerIdentity`, and `tokenizerSha256`. Add
`--tokenizer-module tools/semantic-v8-tokenizer-adapter.mjs` to the benchmark
command for either trace version. This adapter supplies both serializer
interfaces; the tokenizer and exact byte checks are identical. The separate
`serving-costs.json` reports actual measured token totals even though the
source-only capability ladder itself makes no token measurement claim.

The actual v7 selector also records submitted prompt tokens, peak context,
generation/verification time, failed attempts and retries. A runtime failure
with no returned token sequence records unknown generation cost instead of
pretending it generated zero tokens. The aggregate model-cost helper includes
failed/retried attempts in cost per successful execution and uses null when
there are no successful executions.
