#!/usr/bin/env python3
"""Retain a complete fixed-pair supplementary population and its explicit refusals."""
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


def table(headers, rows):
    return '\n'.join(['| ' + ' | '.join(headers) + ' |',
                      '| ' + ' | '.join('---' for _ in headers) + ' |',
                      *['| ' + ' | '.join(str(value) for value in row) + ' |' for row in rows]])


PROFILES = {
    'number-abrupt': {
        'title': 'Direct and nested Number callback throws',
        'positive': 2, 'negative': 0,
        'behavior': '''The direct callback throws before fallback selection. The nested callback
preserves both conversion operations and their exact abrupt result. The helper
checks that every conversion ends in the abrupt phase with no primitive result,
then independently admits all published contexts and continuations.''',
        'limits': '''These two cases qualify synchronous data conversion callbacks. Accessor
selection, implicit conversion TypeErrors, array stringification and asynchronous
or exotic callbacks remain outside this measured population.''',
    },
    'number-completion': {
        'title': 'Number callbacks through catch and finally',
        'positive': 12, 'negative': 1,
        'behavior': '''The declared synchronous cases retain pending completions through caller and
callback catch/finally blocks, nested conversion calls, helper throws, cleanup
overrides and handler scopes. Original source completion and extension
observations agree before independent native admission. The helper also retains
the two source-suite controls for cleanup boundaries and handler scope.''',
        'limits': '''The current suite explicitly refuses Symbol cleanup. The former loop-target
refusal was removed after bounded loop cleanup became supported; it remains an
honest historical refusal in the earlier ddaac82 package. This population does
not qualify asynchronous cleanup or arbitrary exotic conversion behavior.''',
    },
    'custom-iterator': {
        'title': 'Bounded synchronous custom iterators',
        'positive': 16, 'negative': 4,
        'behavior': '''The cases check iterator acquisition with the original receiver, one-time
next lookup, repeated calls of the cached method, live done/value access, and
early return lookup/call with its original receiver. They cover break, return,
body finally, original throws taking precedence over close failure, close
failure replacing a normal break, nested labeled breaks, and continuing an
outer loop while closing only the inner one. A Number callback throw during
close preserves the original pending throw.

The helper checks one next read and three calls with the same method/receiver
for cached-next, zero close observations on step failures and exhaustion, and a
concrete pending target for nested labeled cleanup. Source completion and
extension observations independently agree before native admission.''',
        'limits': '''Non-object step/close results, noncallable close methods and custom-iterator
cleanup inside generators remain explicit source refusals. Async iteration and
unmodeled intrinsic guest errors remain outside this bounded synchronous
profile. The older 653fd1b attempt retains its 120-second native timeout; this
run uses the explicit bound reported below and does not rewrite that failure.''',
    },
    'iterable-binding': {
        'title': 'Flat iterable bindings and iterator cleanup',
        'positive': 14, 'negative': 3,
        'behavior': '''The supported source position is an initialized VariableDeclarator with a
flat ArrayPattern containing identifiers, identifier defaults, identifier rest
or elisions. Cases cover early close, an empty pattern, own Array iterator
overrides, one-time next lookup, elision without value access, rest exhaustion,
throwing defaults, step/done/value failures, active Array growth, permanent
completion, skipped reads after done, and a Number callback throw in a default.

The helper checks that an empty pattern never calls next, an elision avoids its
value read, and exhaustion or step failures do not close the iterator. Independent
source completion observations agree before all native gates. These checks
specifically qualify this source profile; parsing an ArrayPattern alone is not
counted as execution support.''',
        'limits': '''Nested binding patterns, assignment destructuring and captured String builtin
binding retain explicit source refusals. Other source positions, asynchronous
iteration, arbitrary intrinsic guest errors and unrestricted iterator protocols
are not qualified by these flat declaration cases.''',
    },
}

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--kind', choices=PROFILES, required=True)
parser.add_argument('--run', type=Path, required=True)
parser.add_argument('--output', type=Path, required=True)
parser.add_argument('--helper', type=Path, required=True)
parser.add_argument('--receipt', type=Path)
parser.add_argument('--stdout', type=Path)
parser.add_argument('--stderr', type=Path)
parser.add_argument('--combined-log', type=Path)
args = parser.parse_args()
profile = PROFILES[args.kind]
r = read(args.run / 'report.json')
assert r['status'] == 'passed' and r['identityUnchanged']
assert r['pinsBefore'] == r['pinsAfter']
assert all(not pin['status'] for pin in r['pinsBefore'].values())
positive = [row for row in r['rows'] if row['native'] == 'passed']
negative = [row for row in r['rows'] if row['source'] == 'unsupported']
assert len(positive) == r['sourceQualified'] == r['nativeAdmitted'] == r['tokenMeasured'] == profile['positive']
assert len(negative) == r.get('expectedSourceRefusals', 0) == profile['negative']
assert r['declared'] == len(r['cases']) == len(r['rows']) == len(positive) + len(negative)
assert [row['id'] for row in r['rows']] == [row['id'] for row in r['cases']]
assert r['optimizerSteps'] == 0
if args.receipt:
    command_receipt = read(args.receipt)
    assert command_receipt['passed'] and command_receipt['exitCode'] == 0
    assert command_receipt['pins'] == command_receipt['finalPins']
    assert command_receipt['helperSha256'] == sha(args.helper.read_bytes())
    assert command_receipt['reportSha256'] == sha((args.run / 'report.json').read_bytes())
    assert command_receipt['pins']['producer']['revision'] == r['producerRevision']
    assert command_receipt['pins']['consumer']['revision'] == r['consumerRevision']
    assert args.combined_log and command_receipt['logSha256'] == sha(args.combined_log.read_bytes())
for name, digest in r['artifacts'].items():
    assert sha((args.run / name).read_bytes()) == digest
if 'externalPolicy' in r:
    assert sha((args.run / r['externalPolicy']['file']).read_bytes()) == r['externalPolicy']['sha256']
    assert r['sourcePolicy'] == r['nativePolicy'], 'Final-pair qualification uses the committed policy unchanged'
for row in positive:
    assert row['source'] == row['native'] == row['cost'] == 'passed'
    native = read(args.run / row['nativeReceipt'])
    assert native['consumerRevision'] == r['consumerRevision']
    assert native['sourceVerification']['producerRevision'] == r['producerRevision']
    assert native['sourceVerification']['artifactSha256'] == sha((args.run / row['nativeInput']).read_bytes())
    assert read(args.run / row['nativeInput']) == read(args.run / row['sourceArtifact'])
    assert native['checks'] == row['nativeChecks'] and all(value == 'passed' for value in native['checks'].values())
    assert native['optimizerSteps'] == 0 and native['admitted']
    assert native['counts'] == row['nativeCounts'] and native['framing'] == row['nativeFraming']
    assert read(args.run / row['costArtifact'])['tokens'] == row['flatTokens']
    assert row['flatTokens']['generated'] == native['counts']['generatedTokens']
    assert 0 <= row['flatTokens']['detailedShare'] <= 1
for row in negative:
    assert row['expectedRefusal'] and row['native'] == row['cost'] == 'untested'
    result = read(args.run / row['sourceResult'])
    assert result['status'] == 'unsupported' and not result.get('exported')

out = args.output
out.mkdir(exist_ok=False)
for name in ['report.json', 'native-policy.json']:
    if (args.run / name).exists():
        shutil.copyfile(args.run / name, out / name)
shutil.copyfile(args.helper, out / args.helper.name)
shutil.copyfile(__file__, out / Path(__file__).name)
if args.combined_log:
    assert not args.stdout and not args.stderr
    shutil.copyfile(args.combined_log, out / 'combined.log')
else:
    for flag, name in [('stdout', 'stdout.log'), ('stderr', 'stderr.log')]:
        source = getattr(args, flag) or args.run.with_suffix('.' + name)
        shutil.copyfile(source, out / name)
if args.receipt:
    shutil.copyfile(args.receipt, out / 'run-receipt.json')

archive = out / 'artifacts.tar.xz'
records = []
paths = [path for path in sorted(args.run.rglob('*')) if path.is_file()]
with tarfile.open(archive, 'w:xz', format=tarfile.PAX_FORMAT, preset=6) as tar:
    for path in paths:
        assert not path.is_symlink()
        name, data = path.relative_to(args.run).as_posix(), path.read_bytes()
        entry = tarfile.TarInfo(name)
        entry.size, entry.mode, entry.mtime = len(data), 0o644, 0
        with path.open('rb') as stream:
            tar.addfile(entry, stream)
        records.append({'path': name, 'bytes': len(data), 'sha256': sha(data)})
with tarfile.open(archive, 'r:xz') as tar:
    assert tar.getnames() == [row['path'] for row in records]
    for row in records:
        data = tar.extractfile(row['path']).read()
        assert len(data) == row['bytes'] and sha(data) == row['sha256']
index = {'schema': 'semantic-v8-supplementary-archive/1', 'population': args.kind,
         'producerRevision': r['producerRevision'], 'consumerRevision': r['consumerRevision'],
         'archive': {'file': archive.name, 'bytes': archive.stat().st_size, 'sha256': sha(archive.read_bytes())},
         'memberHashesRechecked': True, 'files': records, 'freshNativeExecution': False,
         'scope': 'Packaging verifies retained bytes; fresh execution is established by the exact source-bound receipts in the successful run.'}
(out / 'archive.json').write_text(json.dumps(index, indent=2) + '\n')
compact = sum(row['nativeCounts']['regionRecords'] + row['nativeCounts']['algorithmRecords'] > 0 for row in positive)
generated = sum(row['flatTokens']['generated'] for row in positive)
detailed_share = sum(row['flatTokens']['generated'] * row['flatTokens']['detailedShare'] for row in positive) / generated
results = table(['Case', 'Completion', 'Published contexts'], [
    ['`' + row['id'] + '`', '`' + json.dumps(row['completion'], separators=(',', ':')) + '`', row['nativeCounts']['contexts']]
    for row in positive])
costs = table(['Case', 'Generated', 'Flat EOS', 'Flat submitted context', 'Flat total', 'Native observed/context', 'Native physical records'], [
    ['`' + row['id'] + '`', *(f'{value:,}' for value in [row['flatTokens']['generated'], row['flatTokens']['terminal'],
       row['flatTokens']['observedAndContext'], row['flatTokens']['total'], row['nativeCounts']['observedTokens'], row['nativeFraming']['physicalRecords']])]
    for row in positive])
refusals = table(['Declared refusal', 'Recorded reason'], [['`' + row['id'] + '`', row['reason']] for row in negative]) if negative else 'This two-case population declares no refusal examples.'
bound = r.get('nativeTimeoutMs', r.get('nativeDeadlineMs'))
assert isinstance(bound, int) and bound > 0
readme = f'''# {profile['title']}

The complete declared supplementary population produced **{len(positive)} source/native/token
admissions** and **{len(negative)} explicit source refusals** at producer
`{r['producerRevision']}` and independent consumer
`{r['consumerRevision']}`. Both Git checkouts were clean and unchanged before
and after execution. The run started at `{r['startedAt']}` and finished at
`{r['finishedAt']}`. The native subprocess deadline was explicitly {bound / 1000:g} seconds.

This is a separate **{r['declared']}-case supplementary population**, extracted from
the literal source cases in `{r['sourceSuite']['path']}` (SHA-256
`{r['sourceSuite']['sha256']}`). It does not add cases to the frozen 665 expansion,
26 interoperability or 11 gallery denominators. Those independently executed
populations retain their own reports; cases may overlap between inventories.

## Qualified behavior

{profile['behavior']}

Every admitted case passed independent native replay, every published context,
checkpoint continuation, generated-only masks, live source binding and actual
production-tokenizer checks. Exact source artifacts, compact JSON native
transports, receipts and completion values are retained.

{results}

## Refusals and remaining limits

{refusals}

{profile['limits']}

Refused cases remain in the declared denominator and have no exported artifact,
native admission or token-cost claim. No unexecuted case is counted as supported.

## Exact physical costs

{costs}

Generated target counts agree between flat serialization and native packing in
every admitted row. Flat `semantic-causal-lm/4` records each include an explicit
EOS; native physical framing records its own observed/context counts and has no
terminal token. These conventions remain separate. There are **{compact}
compact-containing** and **{len(positive) - compact} wholly detailed/protocol**
executions, and detailed/protocol targets account for **{100 * detailed_share:.2f}%**
of generated tokens. Every physical prompt, target, EOS and loss mask is retained.

The tokenizer SHA-256 is `{r['nativePolicy']['tokenizerSha256']}` and its identity
is `{r['nativePolicy']['tokenizerIdentity']}`. The report binds the actual codec,
Python and tokenizer-library identities. This population measures admission and
physical tokens, not model accuracy, serving latency or cache reuse. Its own
optimizer-step count is zero; separate model studies do not change this scope.

## Policy, evidence and reproduction

The producer's committed policy pins the exact tested consumer and synchronized
contract, fixture and interoperability digests. If a `native-policy.json` copy
is present here, packaging independently checked that its parsed policy equals
the committed policy recorded by the run; it does not override a stale pin.
No source checkout file was modified to obtain these receipts.

[report.json](report.json) retains all declared inputs and dispositions.
[artifacts.tar.xz](artifacts.tar.xz) contains every source result/artifact,
admitted artifact, native receipt, exact native transport, physical serializer,
token array and mask. [archive.json](archive.json) binds archive and member
lengths and SHA-256 hashes; every member was rechecked after decompression.
`SHA256SUMS` covers the package, including the unchanged helper and raw logs.
Packaging verifies retained bytes and does not execute a new native admission.

Use clean checkouts at the exact revisions above and the pinned tokenizer. Set
`TRACING_JS_SELF_ROOT`, `MEGATOKEN_ROOT`, `MEGATOKEN_PYTHON`,
`MEGATOKEN_TOKENIZER_JSON`, `MEGATOKEN_NATIVE_SOURCE_PRODUCER` and a writable
`TMPDIR`. Set `PYTHONPATH` to the frozen consumer's `src` directory, then run:

```sh
node {args.helper.name} "$TRACING_JS_SELF_ROOT" /path/to/new-evidence \\
  {r['producerRevision']} \\
  {r['consumerRevision']}
```

Use the retained packaging helper with `--kind {args.kind}`, the completed
`--run` directory, a new `--output`, and the unchanged `--helper`. Explicit log
paths and an optional enclosing command receipt can be passed separately. The
helper refuses incomplete populations, changed pins, missing native gates,
incorrect transport hashes and mismatched physical-token counts.
'''
(out / 'README.md').write_text(readme)
(out / 'SHA256SUMS').write_text(''.join(sha(path.read_bytes()) + '  ' + path.relative_to(out).as_posix() + '\n'
                                      for path in sorted(out.rglob('*')) if path.is_file() and path.name != 'SHA256SUMS'))
print(json.dumps({'output': str(out), 'declared': r['declared'], 'admitted': len(positive), 'refused': len(negative),
                  'archiveBytes': archive.stat().st_size, 'verifiedMembers': len(records)}))
