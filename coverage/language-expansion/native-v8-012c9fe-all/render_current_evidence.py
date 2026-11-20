#!/usr/bin/env python3
"""Render the final coordinated fixed-pair populations without relabeling component or prior evidence."""
import argparse
import json
from pathlib import Path


def read(path):
    return json.loads(Path(path).read_bytes())


def table(headers, rows):
    return '\n'.join(['| ' + ' | '.join(headers) + ' |', '| ' + ' | '.join('---' for _ in headers) + ' |',
                      *['| ' + ' | '.join(str(value) for value in row) + ' |' for row in rows]])


def number(value):
    return f'{value:,}'


def percentage(value):
    return f'{100 * value:.2f}%'


def change(before, after):
    return f'{100 * (after / before - 1):+.2f}%' if before else 'undefined'


parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--package', type=Path, required=True)
parser.add_argument('--run', type=Path, required=True)
args = parser.parse_args()
root, run = args.package, args.run
report, receipt, archive = read(root / 'report.json'), read(run / 'run.json'), read(root / 'archive.json')
assert receipt['status'] == 'passed' and receipt['identityUnchanged']
producer, consumer = receipt['pinsBefore']['producer'], receipt['pinsBefore']['consumer']
pops = {row['id']: row for row in report['populations']}
assert set(pops) == {'all', 'gallery', 'interoperability'}
labels = {'all': 'Expansion', 'gallery': 'Gallery', 'interoperability': 'Interoperability'}
for name, row in pops.items():
    assert row['producerRevision'] == producer['revision'] and row['nativePolicy']['consumerRevision'] == consumer['revision']
    assert row['declared'] == row['sourceQualified'] == row['nativeAdmitted'] == row['costs']['flat']['tokenMeasuredEpisodes']
qualification = table(['Population', 'Declared', 'Source qualified', 'Native admitted', 'Token measured'], [
    [labels[key], *(row[name] for name in ['declared', 'sourceQualified', 'nativeAdmitted']), row['costs']['flat']['tokenMeasuredEpisodes']]
    for key, row in pops.items()])
coverage = table(['Population', 'Compact-containing episodes', 'Wholly detailed episodes', 'Compact / detailed regions', 'Detailed generated-token share'], [
    [labels[key], cost['compactEpisodes'], cost['whollyDetailedEpisodes'],
     f"{cost['regionCoverage']['compact']} / {cost['regionCoverage']['detailed']}", percentage(cost['flat']['tokens']['detailedShare'])]
    for key, row in pops.items() for cost in [row['costs']]])
flat = table(['Population', 'Generated', 'EOS', 'Submitted context', 'Flat total', 'Peak context'], [
    [labels[key], *(number(tokens[name]) for name in ['generated', 'terminal', 'observedAndContext', 'total', 'peakContext'])]
    for key, row in pops.items() for tokens in [row['costs']['flat']['tokens']]])
native = table(['Population', 'Generated', 'Observed/context', 'Terminal', 'Physical records', 'Logical records'], [
    [labels[key], *(number(packing[name]) for name in ['generatedTokens', 'observedTokens', 'terminalTokens', 'physicalRecords', 'logicalRecords'])]
    for key, row in pops.items() for packing in [row['costs']['nativePacking']]])
comparison = read(root / 'paired-serving-costs.json')
summary = comparison['summary']
paired = table(['Matched population', 'Pairs', 'Baseline generated', 'Current generated', 'Generated change', 'Baseline flat total', 'Current flat total', 'Flat total change'], [
    [name, row['paired'], number(row['before']['generatedTokens']), number(row['after']['generatedTokens']),
     change(row['before']['generatedTokens'], row['after']['generatedTokens']), number(row['before']['flatTotalTokens']),
     number(row['after']['flatTotalTokens']), change(row['before']['flatTotalTokens'], row['after']['flatTotalTokens'])]
    for name, row in [*comparison['baselinePopulations'].items(), ('All matched rows', summary)]])
regressions = table(['Case', 'Baseline flat total', 'Current flat total', 'Change'], [
    [f"`{row['id']}`", number(row['before']['flatTotalTokens']), number(row['after']['flatTotalTokens']),
     change(row['before']['flatTotalTokens'], row['after']['flatTotalTokens'])]
    for row in comparison['rows'] if row['status'] == 'paired' and row['after']['flatTotalTokens'] > row['before']['flatTotalTokens']])
ref = report['reference']['reference']
cv = read(root / 'consumer-validation.json')
unit = next(row for row in cv['checks'] if row['name'] == 'unit')
tokenizer = archive['populations'][0]['tokenizerEvidence']
text = f"""# Complete final bounded v8 qualification at {producer['revision'][:7]}

This package retains fresh source/native admission and exact physical token
measurements at producer `{producer['revision']}` and independent consumer
`{consumer['revision']}`. Their clean Git trees were
`{producer['tree']}` and `{consumer['tree']}`. The original expansion command retained
its six workers and checked both identities after all 665 admissions completed.
Physical cost measurement and split-bound dataset admission ran independently
in parallel. Interoperability and gallery were also executed independently at
the same exact pair and adopted only after complete artifact/hash checks.
Their original command receipts and logs are retained under
`independent-population-runs/`. The complete [run receipt](run.json) composes
actual executed gates and records their environment routing, logs, time bounds
and before/after identities; the independently executed reference benchmark
checks its producer identity and makes no consumer claim.

These results belong to those exact revisions. Later API, formatting, CI or
serving changes retain their own evidence and do not inherit these receipts.

The original sequential wrapper was stopped after its complete native-all and
ordinary cost stages passed, during downstream input retention, so its reference
and dataset work would not repeat the independently completed stages. The
process-group stop did not execute the wrapper's final receipt update. Its
unchanged last-saved receipt, actual exit130 and explicit coordinator handoff remain in
[coordinated-provenance.tar.xz](coordinated-provenance.tar.xz). No interrupted
command is renamed a pass. The assembly repeats exact native-input retention,
checks all independently completed receipts and exact source/report hashes,
and does not perform new admission. Clean identities after the stop are recorded
separately in the handoff.

The one-worker cost meter consumed only immutable hash-checked committed
campaign artifacts, validated every original native receipt, then bound its
normal final cost/progress schema to the completed qualification report. Its
pilot matched all 11 original-gallery physical cost artifacts byte for byte
against the ordinary frozen CLI. Once the full population completed, the
ordinary CLI also measured all 665 cases, providing a complete independent
cross-check: every physical artifact byte, every summary and every row field
except measured duration matched. Both the [pilot](provenance/cost-equivalence-pilot/equivalence.json)
and [full equality receipt](provenance/source-orchestration/full-cost-equivalence.json)
are retained, along with both complete cost runs and all 665 source/cost
bindings. The ordinary CLI report is used below. Source/native admission counts
come exclusively from the original source-bound receipts.

## Source and independent native qualification

{qualification}

Every admitted case passed independent replay, every published context,
checkpoint continuation, generated-only masks, live source binding and actual
production-tokenizer checks. Exact source inputs, source/admitted artifacts,
native transport bytes and receipts are retained. The expansion denominator
contains 624 executions across 26 families, 12 script interactions, 27 fixed
real-source functions and two evaluated-module interactions. The family cases
cover three equivalent idioms and eight inputs for each of the 26 families.

The original gallery and source interoperability are separate populations;
their inventories overlap with the expansion inventory and are not combined
into a unique-case count. The 27 real-source functions come from the fixed
78-function inventory; the other 51 are not qualified by this run.

Independent reference execution passed {ref['positivePassed']}/{ref['positiveInputs']}
positive inputs across {ref['positiveExecutions']} idiom executions and
{ref['distinguishingPassed']}/{ref['distinguishingPairs']} distinguishing pairs.
The 228 comprehension tasks retain their unmeasured model status.

The separate [37-episode dataset](../dataset-v8-012c9fe-independent/README.md)
freshly re-admitted every interoperability/gallery episode after global
split binding. Its 1,021 complete examples and 33,850 generated tokens including
EOS are byte-identical to the independently [published export](../dataset-v8-012c9fe/README.md).
Both execution receipts are preserved; replication does not double the
population or establish model learning.

The [two abrupt Number cases](../number-abrupt-012c9fe/README.md),
[Number cleanup cases](../number-completion-012c9fe/README.md),
[custom iterator cases](../custom-iterator-012c9fe/README.md), and
[flat iterable-binding cases](../iterable-binding-012c9fe/README.md) have separate
source/native/token receipts at this same exact producer/consumer pair.
Those supplementary results are not added to the three frozen denominators
above; the separate inventories can overlap in source examples. Their explicit
source refusals remain in their own declared inventories. This complete run
independently requalifies the existing populations after the subsequent
iterable-destructuring frontend and contract changes; it does not reuse older
population receipts as final admissions.

## Compact and detailed coverage

{coverage}

An episode can contain compact and detailed regions. The last column counts
actual tokenized detailed targets rather than treating region counts as token
shares. All source refusals, native failures and measurement limits would remain
in each declared denominator; this run has none in those three populations.

## Exact production-tokenizer costs

Tokenizer `{tokenizer['identity']['name']}` at revision
`{tokenizer['identity']['revision']}` has SHA-256
`{tokenizer['identity']['tokenizerSha256']}` and identity
`{tokenizer['identity']['fingerprint']}`. The codec source SHA-256 is
`{tokenizer['qualification']['codecSourceSha256']}`. Runtime identities are
retained with the reports; this run used Node {receipt['runtime']['node']},
Python {receipt['runtime']['python'].split()[0]} and `tokenizers`
{receipt['runtime']['tokenizers']}.

### Flat causal-LM serialization

{flat}

The actual `semantic-causal-lm/4` serializer measures every complete physical
prompt, target and EOS sequence. Submitted context includes repeated
definitions, state and routing. Every generated record contributes one explicit
EOS. The retained token arrays and loss masks bind these counts to actual bytes.

### Native training packing

{native}

These counts come from real native admission and packing, including physical
framing, inserted context records and record fragmentation. This native framing
has no terminal token; its zero terminal count is not substituted for the flat
serializer's EOS count. Neither table measures model accuracy, native serving
latency, cache reuse or cost per successful model execution.

## Paired historical costs

{paired}

The unchanged historical baseline retains 42 physical serializers among 50
declared rows. Matching requires the same source bytes, entry and rooted input
graph, preserving aliases, cycles, property order and null prototypes. Families
and evaluated modules have no retained historical baseline serializers; missing
rows are not assigned zero cost. Every pairing disposition and exact artifact
digest is retained in [paired-serving-costs.json](paired-serving-costs.json).

The aggregate change covers the {summary['paired']} matched rows only. Submitted
context changes by {change(summary['before']['promptTokens'], summary['after']['promptTokens'])};
generated targets change by {change(summary['before']['generatedTokens'], summary['after']['generatedTokens'])}.
All individual increases in flat total cost are retained:

{regressions}

## Separate native component validation

The independent consumer suite passed **{unit['testsRun']} tests**, with
{unit['failures']} failures, {unit['errors']} errors and {unit['skips']} skips, at
consumer `{cv['pins']['consumer']['revision']}` and producer
`{cv['pins']['producer']['revision']}`. Ruff checks and formatting, workflow
validation, paired contract equality and clean identity checks also passed.
[consumer-validation.json](consumer-validation.json) and its original logs
retain those exact commands and pins.

The component suite and all complete source/native populations use the exact
same producer and consumer commits. The retained
[scope receipt](component-validation-scope.json) checks both identities.
The component suite includes the live source-authority regressions for
internally consistent false source evidence and a forged body return after
generator delegation. Its original XML and raw logs remain in the
consumer-validation archive; no earlier component run is relabeled.

## Evidence and reproduction

`archive.json` binds every compressed archive and every uncompressed member by
length and SHA-256. All archived members were rechecked after decompression.
`report.json` retains complete population, family, reference and comparison
summaries. `coordinated-provenance.json` binds every archived original
orchestration, stream-meter, reference, dataset and equivalence-check member.
`SHA256SUMS` covers all package files, including the independently executed
interoperability/gallery command receipts and logs. The earlier
[interrupted 3a1992b qualification](../native-v8-3a1992b-interrupted/README.md)
retains its completed 23-case interoperability and 11-case gallery receipts,
its incomplete 594-case expansion prefix, and the other superseded attempts.
None of those receipts is counted as a final-pair admission.

Use clean checkouts at the exact revisions above, the pinned tokenizer and the
producer's locked native Python dependencies. The detailed source artifacts
record the `Europe/Berlin` timezone; retain that setting when reproducing their
identity. Put outputs outside both checkouts. The retained runner provides explicit `PYTHONPATH`, producer,
consumer, tokenizer and temporary-directory routing:

```sh
export TZ="Europe/Berlin"
python run_current_qualification.py \\
  --producer /path/to/producer --consumer /path/to/consumer \\
  --python /path/to/native-venv/bin/python \\
  --tokenizer /path/to/pinned/tokenizer.json --output /path/to/new-evidence \\
  --producer-revision {producer['revision']} \\
  --consumer-revision {consumer['revision']} --workers 6 \\
  --independent-populations /path/to/completed-same-pair-populations
```

Place the retained dataset, adoption and native-input helpers beside the runner.
It executes the expansion population and its exact costs, verifies and adopts
completed interoperability/gallery qualifications and cost reports from the
same exact producer/consumer pair, runs independent reference cases and the
paired historical comparison, and freshly admits the dataset after component
splits. The independently executed population directory must contain
`interoperability`, `gallery`, `interoperability-costs` and `gallery-costs`,
including complete native-input manifests; its original command receipts and
logs must remain alongside those directories.
Original sources are never substituted with current teachers for the historical
cost comparison. Package construction checks hashes and does not itself perform
new native admission.

This population run performs zero optimizer steps and no model execution.
Separate [four-step native fitting diagnostics](../../../docs/evidence/semantic-v8-diagnostic-pilot/2026-11-20/README.md)
completed zero of two frozen executions in each study. The separately
[audited 256-step current-contract study](../native-v8-fit-39c4036/independent-audit/README.md)
retains three of three source-qualified executions on the optimized input and
zero of three on the input excluded from optimization, for one increment
program. Both inputs carry the same family-hash train split; those results do
not establish held-out-program or family generalization. Its historical weight
archive was unavailable to the independent audit, which checked preserved
output bytes and private source scoring without rerunning inference.

External-model comprehension, generalized learned execution, controlled serving
latency/cache benefits and default promotion remain unqualified. v6 remains the
default. The [candidate-shipping rule](../../../docs/LANGUAGE_COVERAGE_PLAN.md#104-default-promotion-should-be-coordinated)
permits the bounded candidate with these measurement gaps recorded.
"""
(root / 'README.md').write_text(text)
