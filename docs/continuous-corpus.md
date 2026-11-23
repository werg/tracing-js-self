# Continuous corpus generation and source-family checking

The direction in [issue #48](https://github.com/werg/tracing-js-self/issues/48)
is continuing growth of the same implementation and corpus. An execution run
records an exact set of inputs and settings. That record describes what ran;
it is not a permanent ceiling on the supported language, the corpus, or the
next run.

## Related sources stay together in the current export path

The current [family registry](../src/semantic/family-registry-v8.js) derives
relations from original source text before assigning training, validation and
test splits. Its connected components include declared families and ancestry,
identical source bytes, source-derived normalized cores, and lexical clones.
An explicit holdout applies to the entire connected component, including
related sources that themselves have no holdout label.

Lexical fingerprints retain exact-token and consistently renamed-token hashes
and sorted, unique sets of five-token shingles. The clone check uses a complete
prefix filter for the configured Jaccard threshold, followed by an exact set
intersection. Frequent shingles are included. The old behavior that discarded
postings shared by more than 128 sources could miss all near-clone relations
in a growing population; it has been removed. Source labels such as
`__proto__` are ordinary identities and do not alter the lookup table.

The completeness statement concerns this lexical rule, not semantic
equivalence or absence from a model's pretraining data. Tokenization failures
and empty token streams are listed in `diagnostics.cloneAudit.unassessedSources`,
make its `complete` field false, and are conservatively connected to one another.
They do not acquire a fabricated normalized core or a successful execution
status. Syntax that the execution compiler refuses can still have a valid
lexical fingerprint and participate in clone checking.

Input and scheduling expansions of one exact source are compared once. All
original source members remain in the registry; deduplicating comparison work
does not drop candidate executions or change their original inputs. The registry
binds derived fingerprints, their assessment status, the actual clone threshold,
the work budget, and measured work. Rebuilding it rejects changed fingerprints,
relations, assignments and accounting even if the caller recalculates its hash.
The independent consumer also rebuilds the graph and work counts after the
producer's fresh original-source check authenticates the lexical claims.

## Resource budgets belong to individual jobs

The current dataset reader and family registry have no fixed 20,000-candidate
limit. The shared source registry and shard planner have no fixed 10,000-member
limit; the planner also has no fixed 64-shard limit. Finite runs remain subject
to their actual worker, input-transport and clone-analysis budgets.

The clone audit has these adjustable defaults:

| Setting | Default | Work that is counted |
| --- | ---: | --- |
| `maxComparisons` | 1,000,000 | Unique candidate pairs passed to exact Jaccard comparison |
| `maxCandidateVisits` | 10,000,000 | Posting entries visited while finding candidate pairs |
| `maxIndexEntries` | 2,000,000 | Prefix posting entries added to the index |

The algorithm keeps candidate pairs for the current source, rather than
accumulating a quadratic pair table. These operation counts do not claim to
measure whole-process memory. Source text, fingerprints, the frequency table,
and the complete input inventory still occupy memory; worker and transport
limits remain separate measurements.

When a budget is exhausted, the operation raises
`SourceCloneResourceError` with status `resource_exhausted`, the exhausted
resource, the configured budget, exact completed counters, and `complete:false`.
It does not return a partially checked registry or silently reduce the source
population. Increase the job budget or divide execution work while retaining
the complete source relation inventory, then retry.

The current exporter exposes the settings directly:

```sh
node tools/export-semantic-v8.mjs \
  --input candidates.jsonl \
  --tokenizer-module tokenizer.mjs \
  --native-module native-consumer.mjs \
  --max-context 32768 --seed 17 \
  --clone-threshold 0.92 \
  --clone-max-comparisons 2000000 \
  --clone-max-candidate-visits 20000000 \
  --clone-max-index-entries 4000000 \
  --out corpus/out/current-export
```

The tokenizer and native modules supply the actual selected tokenizer and
independent consumer. Default export still requires native admission; an
explicit `--allow-local` run is a diagnostic and does not admit training data.
Source execution, native admission and causal serialization remain distinct
outcomes.

On clone-budget exhaustion, the CLI writes `OUT.failure.json` with the original
candidates, exact input-file SHA256 and byte count, command, runtime, settings,
and work counters. Its `admitted` field is false, and no completed dataset
manifest is written. Successful CLI manifests retain the same input-file
identity and execution settings. Malformed JSONL lines retain their literal
original text in refusal dispositions; parsing failure does not erase an input
from the denominator.

The source-registry CLI exposes the three work-budget flags too. On exhaustion,
it retains original sources and settings in `OUT.failure.json`. Its successful
registry records the complete audit, so a later verifier checks the same
declared budget and the work actually performed.

## Shards retain the entire planned population

The [shard planner](../tools/generation-shards.mjs) partitions candidate work
after the global registry has assigned source-family splits. Shards never
partition the authority for those splits.

`plan --limit N` now records a maximum of N new execution attempts per worker
invocation. It does not truncate the plan to its first N inputs. Every candidate
retains its original task, source-family membership, input digest and shard
assignment. A receipt lists attempted results and every unrun candidate with
its identity, task digest and split. A stopped invocation therefore cannot
look like a smaller completed corpus.

Resume reuses successful or explicitly cached dispositions without spending
the new-attempt budget, then continues unfinished work. Retry attempts remain
in the durable journal. Complete shard merges require exact attempted/unrun
accounting; rehashing a receipt cannot turn an unexplained missing candidate
into a completed input. Partial shard receipts remain useful progress evidence,
while final complete-run equivalence checks continue to require all shards.

## Current paired code and per-run policy

The V8 native, continuation, original-module, direct-release and combined
recovery/Promise CI jobs resolve the consumer once before checkout.
`tools/resolve-native-consumer.mjs` selects the
matching branch in `werg/megatoken` when it exists, otherwise the repository's
current default head. `MEGATOKEN_REF` explicitly selects a branch or commit;
an absent explicit branch or a network failure is an error. A historical policy
that already contains `consumerRevision` continues to require that exact code.

Each run retains a policy snapshot with the observed 40-character revision and
a resolution record outside the source checkout. Checkout, admission and
preparation then use that immutable observation. The checked-in development
policy binds the current contract, fixtures and tokenizer without freezing the
companion repository to one old commit. Contract regeneration also updates the
policy digests, and its check mode rejects stale policy evidence.

The combined recovery/Promise workflow resolves its policy in one prerequisite
job and distributes those exact bytes to all six lanes and the final aggregate.
The verifier checks the retained policy digest with each lane's source trees,
contract and fixture evidence; it does not resolve a moving branch separately
for each lane. Compressed source fixtures are read from their tracked paths and
compared with the independently checked consumer payloads.

Local commands that already take an explicit consumer checkout bind an unpinned
development policy to that checkout's actual clean revision. An explicitly
recorded revision remains a constraint and cannot be silently replaced. The
direct-release driver retains the original declaration, resolved policy and
selection record outside the inputs it later relocates for restoration.

Support-source and lifecycle counts in those jobs are derived from the actual
authenticated registry. The complete source-ID set must match the qualification
rows and the prepared inventory; a past corpus size is not an acceptance rule.

## Current artifacts and historical observations

The schema labels evolve in place during pre-release development. Current
registry fields change component identities because they are part of the
authenticated source evidence. This can change the deterministic split assigned
to a newly generated registry, even if its authored source population is
unchanged. Counts from an earlier run are historical observations, not a
required distribution for future runs.

Generate new source-bound artifacts and native receipts with the current code.
Do not rewrite a historical receipt to claim that a later implementation ran,
or transplant a new registry into an old admitted artifact. The current source
and native checks should refuse an obsolete or changed binding. Dated evidence
under `docs/evidence` retains its original bytes and meaning.

Active fixture builders construct registries from original source membership;
they should be rerun along with their consumers when the registry changes.
For example, the current support fixture can be reconstructed with
`buildSemanticRegionSupportCohortV8` in
`fixtures/semantic-regions/support-cohort.js`. This is a finite regression
fixture, not a corpus-size target. Tests check the assignments it actually
derives and their preservation through transport, without enforcing a past
run's split counts.

## Work still open

- Appending newly related sources to an already prepared dataset while
  preserving all earlier split assignments needs authenticated predecessor
  assignments and explicit handling of newly discovered cross-split relations.
  Mixing bound and unbound inventories remains refused; this check has not been
  weakened to make incremental preparation appear complete.
- Older parallel generation and release tools still contain fixed selections
  and format-specific paths. The changes above apply to the current dataset
  exporter, current family registry, shared clone checking and shard planner;
  they do not claim the entire stack has already been consolidated.
- Lexical similarity remains one conservative guard alongside provenance and
  declared ancestry. It cannot establish semantic independence of arbitrary
  programs or comprehensive JavaScript support.
- Larger corpus production, ordinary native preparation, training and serving
  must keep adding actual executions and preserving their failures and costs.
  Passing these integrity tests is not evidence of learned execution quality.

Regression coverage lives in `test/source-clusters.test.js`,
`test/source-registry.test.js`, `test/generation-shards.test.js`,
`test/semantic-v8-dataset.test.js`, and
`test/semantic-region-support-cohort.test.js`.
