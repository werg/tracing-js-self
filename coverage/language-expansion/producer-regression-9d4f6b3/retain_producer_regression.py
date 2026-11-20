#!/usr/bin/env python3
"""Retain an exact full producer regression and explicitly scoped later targeted evidence."""
import argparse
import datetime
import hashlib
import json
import re
import shutil
import subprocess
import tarfile
from pathlib import Path


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def read(path):
    return json.loads(path.read_bytes())


parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--run', required=True, type=Path)
parser.add_argument('--output', required=True, type=Path)
parser.add_argument('--runner', required=True, type=Path)
parser.add_argument('--repository', required=True, type=Path)
parser.add_argument('--interrupted', required=True, type=Path)
parser.add_argument('--targeted-log', required=True, type=Path)
parser.add_argument('--targeted-contract-log', required=True, type=Path)
parser.add_argument('--targeted-producer', required=True)
args = parser.parse_args()
r = read(args.run / 'summary.json')
assert r['status'] == 'passed' and r['identityUnchanged']
assert r['producerBefore'] == r['producerAfter'] and not r['producerBefore']['trackedChanges']
for command in r['commands']:
    assert command['status'] == 'passed' and command['exitCode'] == 0 and command['producerAfter'] == r['producerBefore']
    for name in ['stdout', 'stderr']:
        item = command[name]
        assert sha(args.run / item['path']) == item['sha256'] and (args.run / item['path']).stat().st_size == item['bytes']
for key in ['codeManifest', 'testInventory']:
    assert sha(args.run / r[key]['path']) == r[key]['sha256']
unit, contracts, reference = r['commands']
skips = [line for line in (args.run / 'unit.stdout.log').read_text().splitlines() if line.startswith('﹣ ')]
assert skips == unit['skipLines'] and len(skips) == unit['counts']['skipped']
args.output.mkdir(exist_ok=False)
for source in args.run.iterdir():
    if source.is_file():
        shutil.copyfile(source, args.output / source.name)
shutil.copyfile(args.runner, args.output / 'run_validation.py')
shutil.copyfile(__file__, args.output / Path(__file__).name)
shutil.copyfile(args.targeted_log, args.output / 'targeted-562f6f2.stdout.log')
shutil.copyfile(args.targeted_contract_log, args.output / 'targeted-562f6f2.contracts.log')
target_output = args.targeted_log.read_text()
target_counts = {}
for key in ['tests', 'suites', 'pass', 'fail', 'cancelled', 'skipped', 'todo']:
    target_counts[key] = int(re.findall(r'ℹ\s+' + key + r'\s+(\d+)', target_output)[-1])
assert target_counts == {'tests': 24, 'suites': 0, 'pass': 24, 'fail': 0, 'cancelled': 0, 'skipped': 0, 'todo': 0}
target_duration = float(re.findall(r'ℹ\s+duration_ms\s+([\d.]+)', target_output)[-1])
files = ['test/semantic-protocol-iterable-binding-source-v8.test.js', 'test/semantic-protocol-custom-iterator-source-v8.test.js',
         'test/semantic-protocol-iterator-v8.test.js', 'test/semantic-protocol-iterator-source-v8.test.js']
git = lambda *values: subprocess.check_output(['git', '-C', str(args.repository), *values], text=True).strip()
target = {'schema': 'producer-targeted-regression-receipt/1', 'producerRevision': args.targeted_producer,
          'producerTree': git('rev-parse', args.targeted_producer + '^{tree}'),
          'identityEvidence': 'Coordinator-reported: source was aligned to this committed tree and a subsequent status check was clean. No instrumented before/after identity receipt was written for this targeted run.',
          'command': ['node', '--test', '--test-concurrency=2', *files],
          'commandEvidence': 'Exact launch command supplied by the coordinator; numeric results and duration independently read from the retained original Node output.',
          'counts': target_counts, 'reportedDurationMs': target_duration,
          'stdout': {'path': 'targeted-562f6f2.stdout.log', 'sha256': sha(args.targeted_log)},
          'contracts': {'command': ['npm', 'run', 'contracts:check'], 'checks': 5, 'passed': 5,
                        'exitCodeEvidence': 'Coordinator-reported zero exit status; all five generators and final v8 check output are retained.',
                        'log': 'targeted-562f6f2.contracts.log', 'logSha256': sha(args.targeted_contract_log)},
          'sourceChangesFromFullRegression': git('diff', '--name-only', r['producerBefore']['revision'], args.targeted_producer, '--', 'src').splitlines(),
          'scope': 'Later bounded iterable-binding/custom-iterator/builtin-iterator source and public-state tests. Not a full producer regression at the later revision.'}
(args.output / 'targeted-562f6f2.json').write_text(json.dumps(target, indent=2) + '\n')
historical = read(args.interrupted / 'summary.json')
assert historical['status'] == 'interrupted'
archive = args.output / 'interrupted-800a92f.tar.xz'
members = []
with tarfile.open(archive, 'w:xz', format=tarfile.PAX_FORMAT, preset=6) as tar:
    for source in sorted(args.interrupted.iterdir()):
        if not source.is_file():
            continue
        name = 'producer-800a92f/' + source.name
        entry = tarfile.TarInfo(name)
        entry.size, entry.mode, entry.mtime = source.stat().st_size, 0o644, 0
        with source.open('rb') as stream:
            tar.addfile(entry, stream)
        members.append({'path': name, 'bytes': source.stat().st_size, 'sha256': sha(source)})
with tarfile.open(archive, 'r:xz') as tar:
    for row in members:
        data = tar.extractfile(row['path']).read()
        assert len(data) == row['bytes'] and hashlib.sha256(data).hexdigest() == row['sha256']
(args.output / 'interrupted-800a92f.json').write_text(json.dumps({'schema': 'producer-regression-history-archive/1',
    'status': historical['status'], 'producerRevision': historical['producerBefore']['revision'],
    'reason': historical.get('reason'), 'archive': archive.name, 'bytes': archive.stat().st_size,
    'sha256': sha(archive), 'memberHashesRechecked': True, 'members': members}, indent=2) + '\n')
counts = unit['counts']
readme = f'''# Complete producer regression at {r['producerBefore']['revision'][:7]}

The full producer regression passed at
`{r['producerBefore']['revision']}`, Git tree
`{r['producerBefore']['tree']}`, using Node `{r['node']['version']}`
and npm `{r['npmVersion']}`. The instrumented receipt confirms identical clean
tracked trees before and after every command. This run includes iterable
frontend lowering and the live model execution/serving failure-cost changes
present at that revision.

## Full regression results

| Check | Recorded command | Result | Elapsed |
| --- | --- | --- | --- |
| Full Node suite | `node --test --test-concurrency=4 test/*.test.js` | {counts['tests']:,} tests: {counts['pass']:,} passed, {counts['skipped']} skipped, {counts['fail']} failed, {counts['cancelled']} cancelled | {unit['durationSeconds']:.3f} s |
| Generated contracts | `npm run contracts:check` | Five of five checks passed | {contracts['durationSeconds']:.3f} s |
| Reference fixture | `node fixtures/reference/reference-fixture.mjs` | Eight of eight checks passed | {reference['durationSeconds']:.3f} s |

Every command exited with code zero. The run started at `{r['startedAt']}` and
finished at `{r['finishedAt']}`; total elapsed time was
{r['durationSeconds']:.3f} seconds. The recorded temporary directory is
`{r['environmentOverrides']['TMPDIR']}`.

[summary.json](summary.json) retains exact commands, runtimes, timestamps,
counts, Git identities, original skip lines and log hashes. The
[code manifest](code-manifest.json) binds {r['codeManifest']['files']} tracked
source/test/tool/fixture blobs, and [test-files.json](test-files.json) lists all
{r['testInventory']['files']} files selected by the full-suite command. No
implementation bytes changed during the run.

### Conditional skips

The six native-environment-dependent checks remain skipped and are not counted
as passes. One requires explicit external consumer/tokenizer paths; five require
a configured served native orchestration environment. Their original skip lines
are retained in the summary and raw output:

'''
for line in skips:
    readme += '- ' + re.sub(r' \([0-9.]+ms\)', '', line[2:]).replace(' # ', ' — ') + '\n'
readme += f'''
## Subsequent targeted source validation

Producer `{args.targeted_producer}` added four protocol source/state changes
for flat iterable binding and writable Array iterator shadowing after the full
regression above. Its original focused output records **24 of 24 tests passed**,
with zero failures/cancellations/skips, in {target_duration / 1000:.3f} seconds.
The four selected files cover flat iterable bindings, custom `for…of`, builtin
iterator source observations and public iterator state. All five contract
generators also passed at that later revision.

[targeted-562f6f2.json](targeted-562f6f2.json) records the coordinator-supplied
exact command, four changed source paths, raw-log hashes and independently
parsed numeric results. Its producer identity is **coordinator-reported**: the
source was aligned to that commit and a subsequent status check was clean, but
no structured before/after receipt was collected for this focused run. It does
not claim the same identity instrumentation as the full regression, and it does
not relabel the full {counts['tests']:,}-test run as a later-revision run.

The later final contract/fixture update and independent native corpus admission
have their own exact receipts. This package establishes the full regression and
the specifically scoped later source checks above, not model learning or default
promotion.

## Retained logs and interrupted predecessor

| Gate | Standard output | Standard error or combined log |
| --- | --- | --- |
| Full Node suite | [unit.stdout.log](unit.stdout.log) | [unit.stderr.log](unit.stderr.log) |
| Full-run contracts | [contracts.stdout.log](contracts.stdout.log) | [contracts.stderr.log](contracts.stderr.log) |
| Reference fixture | [reference.stdout.log](reference.stdout.log) | [reference.stderr.log](reference.stderr.log) |
| Targeted 562 tests | [targeted-562f6f2.stdout.log](targeted-562f6f2.stdout.log) | Original combined output retained |
| Targeted 562 contracts | [targeted-562f6f2.contracts.log](targeted-562f6f2.contracts.log) | Original combined output retained |

The earlier producer `800a92fcb122148ed8acdd6a5283ee1d3da8a1e5` full-suite attempt
was interrupted when the changed frontend made a fresh regression necessary.
Its raw summary, code/test inventories and incomplete logs are retained in
[interrupted-800a92f.tar.xz](interrupted-800a92f.tar.xz); no complete-suite pass
is inferred from that prefix. The archive/member hashes are in
[interrupted-800a92f.json](interrupted-800a92f.json).

The original [runner](run_validation.py) and [packaging helper](retain_producer_regression.py)
are retained. `files.json` binds all files except itself and `SHA256SUMS`;
`SHA256SUMS` binds the complete package except the checksum file itself.
All original command-log hashes and every decompressed history member were
verified during packaging. Integrity verification does not rerun the tests.
'''
(args.output / 'README.md').write_text(readme)
files = [{'path': p.name, 'bytes': p.stat().st_size, 'sha256': sha(p)} for p in sorted(args.output.iterdir()) if p.is_file()]
(args.output / 'files.json').write_text(json.dumps({'schema': 'producer-regression-file-inventory/1',
    'producerRevision': r['producerBefore']['revision'], 'producerTree': r['producerBefore']['tree'],
    'generatedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'files': files}, indent=2) + '\n')
(args.output / 'SHA256SUMS').write_text(''.join(sha(p) + '  ' + p.name + '\n' for p in sorted(args.output.iterdir()) if p.is_file() and p.name != 'SHA256SUMS'))
print(json.dumps({'output': str(args.output), 'fullCounts': counts, 'targetedCounts': target_counts, 'historyMembersVerified': len(members)}))
