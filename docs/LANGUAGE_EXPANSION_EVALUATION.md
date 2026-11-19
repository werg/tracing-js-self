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
interactions require a module adapter and are reported as untested by the
strict script runner. They remain visible in the declared interaction count.

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

`--inputs first` is a smaller diagnostic, explicitly labeled as such. It does
not replace the all-input release population. Every source attempt stays in
its coverage denominator, including unsupported syntax, independent-reference
mismatches, resource limits, and detailed fallbacks.

`buildCapabilityLedger` defaults to v7, supports explicit historical v6, and
accepts v8 only with its actual source verifier and declared v8 contracts. Mixed
coverage reads the v8 producer's certified `sidecar.regionCoverage`, including
compact/detailed region and record counts. It never manufactures v8 coverage by
changing a version label. Native and model stages require their own evidence.

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

The actual v7 selector also records submitted prompt tokens, peak context,
generation/verification time, failed attempts and retries. A runtime failure
with no returned token sequence records unknown generation cost instead of
pretending it generated zero tokens. The aggregate model-cost helper includes
failed/retried attempts in cost per successful execution and uses null when
there are no successful executions.
