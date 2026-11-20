#!/usr/bin/env python3
"""Retain exact Number catch/finally source/native evidence and the failed predecessor."""
import argparse
import hashlib
import json
import shutil
import tarfile
from pathlib import Path


def sha(data):
    return hashlib.sha256(data).hexdigest()


def read(path):
    return json.loads(path.read_bytes())


parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--run', required=True, type=Path)
parser.add_argument('--failed-run', required=True, type=Path)
parser.add_argument('--output', required=True, type=Path)
parser.add_argument('--helper', required=True, type=Path)
args = parser.parse_args()
r = read(args.run / 'report.json')
f = read(args.failed_run / 'report.json')
assert r['status'] == 'passed' and r['identityUnchanged']
assert (r['declared'], r['sourceQualified'], r['nativeAdmitted'], r['expectedSourceRefusals'], r['tokenMeasured']) == (14, 12, 12, 2, 12)
assert f['status'] == 'failed' and f['nativeAdmitted'] == 0 and f['sourceQualified'] == 1
assert f['producerRevision'] == r['producerRevision'] and f['consumerRevision'] != r['consumerRevision']
assert 'unsupported or mismatched extensions' in f['failure']
for source, report in [(args.run, r), (args.failed_run, f)]:
    for name, digest in report['artifacts'].items():
        assert sha((source / name).read_bytes()) == digest
    assert sha((source / report['externalPolicy']['file']).read_bytes()) == report['externalPolicy']['sha256']
for row in r['rows']:
    if row['native'] != 'passed':
        assert row['expectedRefusal'] and row['source'] == 'unsupported' and row['cost'] == 'untested'
        continue
    receipt = read(args.run / row['nativeReceipt'])
    assert receipt['consumerRevision'] == r['consumerRevision']
    assert receipt['sourceVerification']['producerRevision'] == r['producerRevision']
    assert receipt['sourceVerification']['artifactSha256'] == sha((args.run / row['nativeInput']).read_bytes())
    assert all(value == 'passed' for value in receipt['checks'].values())
    assert receipt['optimizerSteps'] == 0 and receipt['admitted']
    assert row['flatTokens']['generated'] == row['nativeCounts']['generatedTokens']
    assert 0 <= row['flatTokens']['detailedShare'] <= 1
args.output.mkdir(exist_ok=False)
for name in ['report.json', 'native-policy.json']:
    shutil.copyfile(args.run / name, args.output / name)
shutil.copyfile(args.helper, args.output / args.helper.name)
shutil.copyfile(__file__, args.output / Path(__file__).name)
for suffix in ['stdout.log', 'stderr.log']:
    shutil.copyfile(args.run.with_suffix('.' + suffix), args.output / suffix)


def archive(directory, label, filename):
    files = [(p.name, p) for p in sorted(directory.iterdir()) if p.is_file()]
    if label:
        files = [(label + '/' + name, p) for name, p in files]
    if label:
        files += [(label + '/' + suffix, directory.with_suffix('.' + suffix)) for suffix in ['stdout.log', 'stderr.log']]
    files.sort()
    target = args.output / filename
    records = []
    with tarfile.open(target, 'w:xz', format=tarfile.USTAR_FORMAT, preset=6) as tar:
        for name, path in files:
            data = path.read_bytes()
            entry = tarfile.TarInfo(name)
            entry.size, entry.mode, entry.mtime = len(data), 0o644, 0
            with path.open('rb') as stream:
                tar.addfile(entry, stream)
            records.append({'path': name, 'bytes': len(data), 'sha256': sha(data)})
    with tarfile.open(target, 'r:xz') as tar:
        assert tar.getnames() == [row['path'] for row in records]
        for row in records:
            data = tar.extractfile(row['path']).read()
            assert len(data) == row['bytes'] and sha(data) == row['sha256']
    return {'file': filename, 'bytes': target.stat().st_size, 'sha256': sha(target.read_bytes()), 'memberHashesRechecked': True, 'files': records}


archives = [archive(args.run, '', 'artifacts.tar.xz'), archive(args.failed_run, 'failed-1967695', 'failed-1967695.tar.xz')]
index = {'schema': 'semantic-v8-supplementary-completion-archive/1', 'producerRevision': r['producerRevision'],
         'consumerRevision': r['consumerRevision'], 'archives': archives, 'freshNativeExecution': False,
         'scope': 'Packaging checks retained bytes. Fresh admission is established only by the exact source-bound receipts inside the successful run.'}
(args.output / 'archive.json').write_text(json.dumps(index, indent=2) + '\n')
positive = [row for row in r['rows'] if row['native'] == 'passed']
negative = [row for row in r['rows'] if row['source'] == 'unsupported']
compact = sum(row['nativeCounts']['regionRecords'] + row['nativeCounts']['algorithmRecords'] > 0 for row in positive)
detailed_share = sum(row['flatTokens']['generated'] * row['flatTokens']['detailedShare'] for row in positive) / sum(row['flatTokens']['generated'] for row in positive)
result_rows = '\n'.join('| `' + row['id'] + '` | `' + json.dumps(row['completion']['value']) + '` | ' + str(row['nativeCounts']['contexts']) + ' |' for row in positive)
cost_rows = '\n'.join('| `' + row['id'] + '` | ' + ' | '.join(f'{value:,}' for value in [row['flatTokens']['generated'], row['flatTokens']['terminal'], row['flatTokens']['observedAndContext'], row['flatTokens']['total'], row['nativeCounts']['observedTokens'], row['nativeFraming']['physicalRecords']]) + ' |' for row in positive)
refusal_rows = '\n'.join('| `' + row['id'] + '` | ' + row['reason'] + ' |' for row in negative)
readme = f'''# Source and native qualification of Number callback cleanup

The declared focused suite passed **12 positive source/native/token cases** and
preserved **two explicit source refusals** at producer
`{r['producerRevision']}` and independent consumer
`{r['consumerRevision']}`. Both checkouts were clean and unchanged before and
after execution. The run started at `{r['startedAt']}` and completed at
`{r['finishedAt']}`.

The positive cases exercise Number callback throws across caller and callback
`catch`/`finally`, overrides, nested conversions and cleanup, guest helpers,
suppressed fallback after a throw, and later independent conversions. They
retain `ordinary-completions-source/1` alongside the Number conversion profile.
The source suite is `{r['sourceSuite']['path']}` with SHA-256
`{r['sourceSuite']['sha256']}`. The helper reads its ten declared literal cases
and checks that the four additional positive/refusal bodies also occur in that
same frozen suite; it does not invent replacements for failed cases.

This is a separate **14-case supplementary population**: 12 native admissions
and two expected source refusals. It does not increase or replace the frozen
665 expansion, 23 interoperability or 11 gallery denominators, and it does not
assign older population evidence to this newer completion profile.

## Positive results

All rows below passed independent source execution, source projection, public
replay, every published context, checkpoint continuation, generated-only masks,
live source binding and the actual tokenizer. The independent extension and
completion observation audits agreed. Native replay returned each exact tagged
value below.

| Case | Returned tagged value | Published contexts |
| --- | --- | ---: |
{result_rows}

### Explicit source boundaries

| Declared refusal | Recorded reason |
| --- | --- |
{refusal_rows}

Both returned `unsupported` without an export. Native admission and costs remain
untested for those two cases; expected refusal is not reported as supported
JavaScript. Intrinsic conversion TypeErrors, accessor selection, array
stringification, async/exotic callbacks and unrestricted cleanup remain separate
unqualified boundaries.

## Exact physical costs

| Case | Generated | Flat EOS | Flat submitted context | Flat total | Native observed/context | Native physical records |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
{cost_rows}

Generated target counts agree between flat serialization and native packing in
every row. Flat costs use `semantic-causal-lm/4` with one EOS per generated
record. Native physical framing adds no terminal token and retains its own
observed/context count; the two accounting conventions are not combined.
{compact} executions contain compact regions and {len(positive) - compact} are
wholly detailed/protocol. Detailed/protocol targets account for
{100 * detailed_share:.2f}% of generated tokens across the 12 admitted cases.
Exact bytes, token arrays and loss masks are retained. These measurements establish token accounting, not
model accuracy, serving latency or cache reuse. Optimizer steps are zero and
default promotion remains unqualified.

The pinned tokenizer SHA-256 is
`{r['nativePolicy']['tokenizerSha256']}`, with identity
`{r['nativePolicy']['tokenizerIdentity']}`. The report also retains the exact
codec, consumer, Python and tokenizer-library identities.

## Policy binding and failed predecessor

The producer's committed policy still names consumer
`{r['sourcePolicy']['consumerRevision']}`. This run supplied a separate external
policy, retained as [native-policy.json](native-policy.json), binding the tested
consumer `{r['consumerRevision']}` and the contract, fixture and interoperability
digests from the byte-equivalent paired execution contracts. No committed
source file was changed to run this qualification. The report retains both
policies and the override's SHA-256.

The first attempt used the same producer and consumer
`{f['consumerRevision']}`. Its first `caller-catch` source case verified, but the
native CLI rejected the missing completion-extension admission entry. No case
was natively admitted and the remaining cases did not run. Its original failed
report, source result/artifact, external policy and stderr are preserved in
[failed-1967695.tar.xz](failed-1967695.tar.xz). The consumer fix admits the explicit
completion profile and adds coverage; the successful run above was executed
fresh at its own later pin. The failure is not relabeled as a pass.

## Retained evidence and reproduction

[artifacts.tar.xz](artifacts.tar.xz) contains all source results, source-bound
public artifacts, admitted artifacts, exact compact JSON native transport
bytes, receipts, physical token records and masks, policies and the complete
report. [archive.json](archive.json) binds both archives and every uncompressed
member by length and SHA-256; every member was rechecked after decompression.
The package [checksums](SHA256SUMS) cover all retained top-level files.

Use clean checkouts at the successful pins above and the pinned tokenizer. Set
`TRACING_JS_SELF_ROOT`, `MEGATOKEN_ROOT`, `MEGATOKEN_PYTHON`,
`MEGATOKEN_TOKENIZER_JSON`, `MEGATOKEN_NATIVE_SOURCE_PRODUCER` and an existing
writable `TMPDIR`. Set `PYTHONPATH` to the consumer's `src` directory. The helper
constructs its external policy in the new output directory before loading the
admission and tokenizer adapters:

```sh
node qualify_number_completions.mjs "$TRACING_JS_SELF_ROOT" /path/to/new-evidence \\
  {r['producerRevision']} \\
  {r['consumerRevision']}
```

The package helper checks all retained hashes, receipt pins and exact native
input bindings. Packaging does not itself run new native admission. Later
serving/API changes and external-model work require separate measurements.
'''
(args.output / 'README.md').write_text(readme)
(args.output / 'SHA256SUMS').write_text(''.join(sha(p.read_bytes()) + '  ' + p.name + '\n' for p in sorted(args.output.iterdir()) if p.name != 'SHA256SUMS'))
print(json.dumps({'output': str(args.output), 'admitted': len(positive), 'refused': len(negative),
                  'archives': [{k: value for k, value in archive.items() if k != 'files'} for archive in archives],
                  'verifiedMembers': sum(len(archive['files']) for archive in archives)}))
