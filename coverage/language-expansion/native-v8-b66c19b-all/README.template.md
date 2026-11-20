# Bounded v8 qualification at b66c19b

This package retains the completed declared populations produced by
`@@PRODUCER@@` and checked by independent consumer
`@@CONSUMER@@`. The measured producer tree is
`@@PRODUCER_TREE@@`; the consumer tree is
`@@CONSUMER_TREE@@`. Evidence and documentation commits after this freeze
do not change the producing revisions or qualify a later implementation.

## Source and native qualification

Every admitted row has separate passing native checks for replay, contexts,
continuation, masks, live source binding and the pinned tokenizer. The source
recheck records the exact clean producer revision and hashes its complete
transport input. Successful source projection alone does not imply native
admission.

@@QUALIFICATION@@

The expansion denominator consists of the following fixed subpopulations:

@@SUBGROUPS@@

The fixed families comprise three idioms and eight inputs per idiom.
@@FAMILY_SCOPE@@ @@REAL_SOURCE@@ The separate population inventories overlap at @@OVERLAPS@@.
Their denominators are reported separately, without a combined unique-case claim.

@@REFERENCE@@ Reference execution is separate from compact projection, public
replay and native admission.

@@UNQUALIFIED@@

## Compact and detailed coverage

@@COVERAGE@@

An episode can contain both forms. Compact-episode counts and record counts do
not establish the target-token share; the final column comes from actual
tokenized detailed targets.

## Exact production-tokenizer costs

@@TOKENIZER@@ Byte-exact codec qualification establishes the meter; the separate
native receipts establish admission.

### Flat serialized costs

The actual `semantic-causal-lm/4` serializer counts submitted context for every
prediction, including repeated context. Generated targets and explicit EOS
tokens are separate segments. These totals are exact serialized token counts;
they do not measure a cached serving implementation.

@@FLAT@@

### Native training packing

These counts come from retained native admission and packing receipts:

@@PACKING@@

Physical packing includes inserted contexts and framing. Its terminal count is
zero for this native framing and is not substituted for the flat serializer's
EOS count. Neither representation measures serving latency, KV-cache reuse or
learned execution success. Unmeasured cases remain in the declared denominators;
they are not assigned zero cost.

## Paired historical comparison

The [retained historical baseline](../baseline-token-costs-135bd1f/README.md)
contains actual serializer bytes from producer `@@BASELINE_PRODUCER@@`,
metered at `@@BASELINE_METER@@`. The current comparison uses the completed
reports above with the same tokenizer identity and codec. Pairing requires equal
case IDs, exact source bytes, entry points and validated rooted initial input
graphs. Object IDs may be renamed; aliases, cycles, property-array order and null
prototypes remain significant.

@@BASELINE_DENOMINATORS@@ The fixed-family and evaluated-module populations have
no retained historical serializer costs. New interoperability cases have no
inferred baseline. These missing measurements are not assigned zero cost.

Generated targets and total flat costs for each matched population are:

@@COMPARISON@@

The corresponding submitted-context costs are measured separately:

@@CONTEXT_COMPARISON@@

@@PAIRED_CONTEXT@@

These ratios describe the matched subset. The historical serializers did not
independently retain a canonical complete host fixture schedule, so pairing does
not establish a new historical source or model execution qualification.
Ambiguous duplicate current IDs remain ambiguous instead of being selected by
their measured cost. Every comparison row has one of these dispositions:

@@PAIRING_DISPOSITIONS@@

### Every individual flat-total regression

Aggregate totals do not erase per-case increases. This table includes every
matched case with a larger total flat token cost:

@@FLAT_REGRESSIONS@@

[paired-serving-costs.json](paired-serving-costs.json) retains every per-case
generated, detailed, context, terminal, total, peak and byte metric, including all
other increases, together with pairing dispositions and exact artifact hashes.
The comparison includes representation and public-context changes together; it
does not isolate rendering from abstraction or establish better model
comprehension.

## Regression and component validation

@@CONSUMER_VALIDATION@@ This is the selected native-v8 and related component
suite, not the entire consumer repository suite. Exact commands, clean
before/after identities, versions and log hashes are in
[consumer-validation.json](consumer-validation.json); the original logs are
retained in the consumer-validation archive.

@@PRODUCER_VALIDATION@@ The six skips are one environment-gated external
ByteCodec test and five served orchestration tests; they are not presented as
passes. The full independent receipt, logs and code manifest are retained in
[producer-regression-b66c19b](../producer-regression-b66c19b/README.md).
[producer-validation-summary.json](producer-validation-summary.json) also binds
the measured implementation here.

The producer and consumer include checked fixes for bounded custom-prototype
enumeration, generator-close array property ordering agreement, scheduler
resolution boundaries and graph-observation receipt consistency. The
[enumeration profile](../../../docs/V8_ENUMERATION_SOURCE.md) and
[Promise scheduler boundary](../../../docs/V8_PROMISE_SCHEDULER.md) specify the
supported cases and explicit refusals.

## Qualification boundaries

These results establish checked deterministic execution for the retained
populations and profiles. They contain no external model responses, model
next-step accuracy, learned completed-execution measurement or optimizer steps.
Native serving latency and cache savings remain unmeasured. Default promotion
remains `not-qualified`.

The ordinary for-in cursor profile is bounded and checks the relevant owned
object/array prototype walk, shadowing, order and cursor state. General mutable
enumeration, callable/proxy chains and undeclared behavioral profiles are not
qualified by these cases. Promise adoption, callable/accessor thenable resolution
and normal completion of callable Promise `finally` handlers require additional
checked jobs and retain their documented refusal boundaries. A source profile
can be narrower than runtime or public replay capability.

Fresh data-graph observations agree between producer live execution, public
replay and checkpoint restoration, and the independent native observation
component checks the same transition. This does not establish end-to-end native
admission for a graph-returning host request: the required `owned-graph/1`
argument envelope remains outside the current native request payload profile.
The resolution preflights refuse unsupported values and malformed explicit
graphs before mutating execution state or appending a reconciliation receipt.

## Retained bytes and provenance

@@ARCHIVE_COUNTS@@ [archive.json](archive.json) binds each archive and every
uncompressed member by exact SHA-256 and byte length; members were checked after
writing. The archives contain all three inventories, attempts, source/admitted
artifacts, native receipts, exact serving serializers and token segments,
progress identities, journals and objects, comparison inputs, reference evidence,
policy and consumer validation logs.

For each admitted row, `native-inputs-manifest.json` binds the retained
`*.native-input.json` to the live receipt's
`sourceVerification.artifactSha256`. The native CLI input is
`JSON.stringify(source)` plus one newline, reconstructed and checked against
that original receipt. The pretty source artifact is retained separately. This
reconstruction is an integrity operation, not a fresh native execution.

[report.json](report.json) retains all population dispositions, family
breakdowns, costs, reference results and the consumer validation receipt.
[retention-inputs.json](retention-inputs.json) records the report bindings checked
before retention. [package-manifest.json](package-manifest.json) and
`SHA256SUMS` bind review files, helpers and separate history in addition to the
archive inventory. Absolute workspace paths in original reports remain unchanged
provenance fields; the archives retain their original bytes.

### Separate superseded history

[history/ea4ccff-superseded](history/ea4ccff-superseded/README.md) preserves the
verified earlier prefix at producer
`ea4ccffc1ea1c5f57ff9b94b2ad4c51cfc60c709`, stopped after the independently found
graph-observation context and checkpoint bug. Its 102 committed expansion
attempts and completed 23-row interoperability run are superseded evidence,
never added to the final denominators. Its original archive, verification,
dispositions, retained transports and preparation helpers are copied unchanged.
The older [8d1f7b5 evidence](../native-v8-8d1f7b5-all/README.md) also remains
historical and retains its original failure and source refusals.

## Reproduction

Use clean checkouts of the two exact revisions above and the pinned tokenizer.
`PYTHONPATH` is explicit so an installed editable package cannot silently select
another consumer checkout. @@RUNTIME@@

```sh
PRODUCER_CHECKOUT=/absolute/path/to/tracing-js-self-b66c19b
CONSUMER_CHECKOUT=/absolute/path/to/megatoken-6adf99f
PYTHON_EXECUTABLE=/absolute/path/to/consumer-venv/bin/python
TOKENIZER_JSON=/absolute/path/to/pinned/tokenizer.json
EVIDENCE_OUT=/absolute/path/to/new-v8-evidence
mkdir -p "$EVIDENCE_OUT" "$EVIDENCE_OUT/tmp"
export TMPDIR="$EVIDENCE_OUT/tmp"
export PYTHONPATH="$CONSUMER_CHECKOUT/src"
export MEGATOKEN_NATIVE_SOURCE_PRODUCER="$PRODUCER_CHECKOUT"
export MEGATOKEN_ROOT="$CONSUMER_CHECKOUT"
export MEGATOKEN_TOKENIZER_JSON="$TOKENIZER_JSON"
export MEGATOKEN_PYTHON="$PYTHON_EXECUTABLE"
cd "$PRODUCER_CHECKOUT"

for population in all gallery interoperability; do
  node tools/qualify-semantic-v8.mjs \
    --out "$EVIDENCE_OUT/native-$population" \
    --population "$population" --inputs all --workers 4 \
    --megatoken "$CONSUMER_CHECKOUT" --tokenizer "$TOKENIZER_JSON" \
    --python "$PYTHON_EXECUTABLE" \
    --native-policy contracts/semantic-native-policy-v8.json
  node tools/measure-semantic-v8.mjs \
    --qualification "$EVIDENCE_OUT/native-$population" \
    --out "$EVIDENCE_OUT/costs-$population" \
    --tokenizer-module tools/semantic-v8-tokenizer-adapter.mjs
done

node tools/language-expansion-benchmark.mjs \
  --out "$EVIDENCE_OUT/reference" --mode reference \
  --trace-version 8 --population all --inputs all

# Use the retained three-population manifest with this same sibling layout.
cp /absolute/path/to/this-package/comparison-inputs.json "$EVIDENCE_OUT/comparison-inputs.json"
BASELINE_COSTS="$EVIDENCE_OUT/historical-costs"
mkdir -p "$BASELINE_COSTS"
tar -xJf coverage/language-expansion/baseline-token-costs-135bd1f/artifacts.tar.xz \
  -C "$BASELINE_COSTS"
node tools/compare-serving-costs.mjs \
  --before "$BASELINE_COSTS" \
  --after-manifest "$EVIDENCE_OUT/comparison-inputs.json" \
  --out "$EVIDENCE_OUT/paired-serving-costs.json"
```

Qualification or comparison failures must remain visible in resulting reports.
Run the regression/component commands listed in the retained receipts with the
same explicit environment; do not substitute this package's logs for a new run.
The helpers below retain evidence after qualification and metering. They do not
execute models or upgrade failure dispositions.

```sh
# From a copied evidence package, validate all retained bytes.
sha256sum -c SHA256SUMS

# For completed measurements with their own validation paths:
python3 /absolute/path/to/this-package/prepare_native_retention.py \
  --confirm-complete \
  --evidence-root "$EVIDENCE_OUT" \
  --producer-root "$PRODUCER_CHECKOUT" \
  --consumer-validation /absolute/path/to/new-consumer-validation \
  --producer-validation /absolute/path/to/new-producer-validation \
  --history /absolute/path/to/verified-superseded-retention \
  --output /absolute/path/to/new-retained-package
```

The wrapper checks complete rows, exact pins, artifact digests, report bindings,
comparison identities and logs before retention. It then reconstructs exact
native inputs, invokes the unchanged generic archive builder, verifies copied
historical bytes, and renders this README from the measured reports.
[retain-native-inputs.mjs](retain-native-inputs.mjs),
[retain-evidence.py](retain-evidence.py),
[prepare_native_retention.py](prepare_native_retention.py),
[build_native_readme.py](build_native_readme.py) and its
[template](README.template.md) are retained for review.
