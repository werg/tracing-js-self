#!/usr/bin/env python3
"""Preserve previous-contract qualification attempts and their original identities."""
import argparse
import hashlib
import json
import shutil
import tarfile
from pathlib import Path


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def read(path):
    return json.loads(path.read_bytes())


parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--base', type=Path, required=True)
parser.add_argument('--output', type=Path, required=True)
args = parser.parse_args()
base, out = args.base, args.output
main = base / 'qualification-562f6f2-d26afd9'
binding = base / 'qualification-iterable-binding-562f6f2-d26afd9'
superseded, supplement = read(main / 'superseded.json'), read(binding / 'superseded.json')
assert superseded['status'] == supplement['status'] == 'interrupted-superseded'
assert superseded['recordedAttempts'] == superseded['nativeAdmitted'] == 168
assert superseded['untestedOrUncommitted'] == 497
assert supplement['nativeAdmitted'] == supplement['tokenMeasured'] == 7
assert sha(main / 'run.json') == superseded['runReceiptSha256']
assert sha(binding / 'report.json') == supplement['reportSha256']
inputs = read(main / 'native-all/interrupted-native-inputs/manifest.json')
assert inputs['retainedNativeInputs'] == 168
for row in inputs['rows']:
    assert sha(main / 'native-all/interrupted-native-inputs' / row['nativeInput']) == row['nativeInputSha256']
    assert sha(main / 'native-all' / row['sourceArtifact']) == row['sourceArtifactSha256']

population_summaries = []
for directory in [base / 'native-current-qualification-562f6f2-d26afd9', base / 'native-current-qualification-62eb943']:
    for name, expected in [('interoperability', 23), ('gallery', 11)]:
        q, c = read(directory / name / 'report.json'), read(directory / (name + '-costs') / 'report.json')
        assert q['declared'] == q['sourceQualified'] == q['nativeAdmitted'] == expected
        assert c['summary']['flat']['tokenMeasuredEpisodes'] == c['summary']['nativePacking']['measuredEpisodes'] == expected
        assert c['qualification']['reportSha256'] == sha(directory / name / 'report.json')
        for root, report in [(directory / name, q), (directory / (name + '-costs'), c)]:
            for filename, checksum in report['artifacts'].items():
                assert sha(root / filename) == checksum
        population_summaries.append({'directory': directory.name, 'population': name, 'declared': expected,
            'producerRevision': q['producerRevision'], 'consumerRevision': q['nativePolicy']['consumerRevision'],
            'sourceQualified': expected, 'nativeAdmitted': expected, 'flatTokenMeasured': expected, 'nativePackingMeasured': expected})

components = []
validation_names = ['native-final-validation', 'native-final-validation-9d4456b',
                    'native-final-validation-e52a135', 'native-final-validation-d26afd9-source562']
for name in validation_names:
    directory = base / name
    r = read(directory / 'consumer-validation.json')
    assert r['passed'] and r['pins'] == r['finalPins']
    for row in r['checks']:
        assert row['exitCode'] == 0
        assert sha(directory / Path(row['log']).name) == row['logSha256']
    unit = next(row for row in r['checks'] if row['name'] == 'unit')
    assert unit['failures'] == unit['errors'] == unit['skips'] == 0
    components.append({'directory': name, 'producerRevision': r['pins']['producer']['revision'],
        'consumerRevision': r['pins']['consumer']['revision'], 'testsRun': unit['testsRun'], 'skips': unit['skips']})

old_supplements = []
for report_path in sorted((base / 'native-current-supplements-562f6f2-d26afd9').glob('*/report.json')):
    r = read(report_path)
    for filename, checksum in r['artifacts'].items():
        assert sha(report_path.parent / filename) == checksum
    old_supplements.append({'population': report_path.parent.name, 'recordedStatus': r['status'], 'declared': r['declared'],
        'sourceQualified': sum(row['source'] == 'passed' for row in r['rows']),
        'nativeAdmitted': sum(row['native'] == 'passed' for row in r['rows']),
        'tokenMeasured': sum(row['cost'] == 'passed' for row in r['rows']),
        'recordedRefusals': sum(row['source'] == 'unsupported' for row in r['rows'])})

out.mkdir(exist_ok=False)
shutil.copyfile(main / 'superseded.json', out / 'expansion-superseded.json')
shutil.copyfile(binding / 'superseded.json', out / 'binding-superseded.json')
shutil.copyfile(__file__, out / Path(__file__).name)
shutil.copyfile(base / 'qualification-tools/retain-interrupted-native-inputs.mjs', out / 'retain-interrupted-native-inputs.mjs')
archives = []
groups = [
    ('superseded-562f6f2-populations.tar.xz', [main, binding, base / 'native-current-qualification-562f6f2-d26afd9']),
    ('earlier-62eb943-populations.tar.xz', [base / 'native-current-qualification-62eb943']),
    ('superseded-562f6f2-supplements.tar.xz', [base / 'native-current-supplements-562f6f2-d26afd9']),
    ('historical-native-validation.tar.xz', [base / name for name in validation_names]),
]
for name, directories in groups:
    members = []
    for directory in directories:
        for path in sorted(directory.rglob('*')):
            relative = path.relative_to(directory)
            if not path.is_file() or path.name == '.campaign.lock' or 'tmp' in relative.parts:
                continue
            assert not path.is_symlink()
            members.append({'path': directory.name + '/' + relative.as_posix(), 'source': path,
                            'bytes': path.stat().st_size, 'sha256': sha(path)})
        if directory == binding:
            for suffix in ['stdout.log', 'stderr.log']:
                path = directory.with_suffix('.' + suffix)
                members.append({'path': directory.name + '/' + suffix, 'source': path,
                                'bytes': path.stat().st_size, 'sha256': sha(path)})
    members.sort(key=lambda row: row['path'])
    archive = out / name
    with tarfile.open(archive, 'w:xz', format=tarfile.PAX_FORMAT, preset=6) as tar:
        for row in members:
            entry = tarfile.TarInfo(row['path'])
            entry.size, entry.mode, entry.mtime = row['bytes'], 0o644, 0
            with row['source'].open('rb') as stream:
                tar.addfile(entry, stream)
    with tarfile.open(archive, 'r:xz') as tar:
        assert tar.getnames() == [row['path'] for row in members]
        for row in members:
            data = tar.extractfile(row['path']).read()
            assert len(data) == row['bytes'] and hashlib.sha256(data).hexdigest() == row['sha256']
    archives.append({'file': name, 'bytes': archive.stat().st_size, 'sha256': sha(archive),
                     'memberHashesRechecked': True, 'files': [{key: value for key, value in row.items() if key != 'source'} for row in members]})
    print(json.dumps({'archive': name, 'bytes': archive.stat().st_size, 'verifiedMembers': len(members)}), flush=True)
index = {'schema': 'semantic-v8-contract-supersession-archives/1', 'archives': archives,
         'populationSummaries': population_summaries, 'componentSummaries': components, 'supplementSummaries': old_supplements,
         'freshNativeExecution': False, 'scope': 'Unchanged historical receipts and exact bytes. No partial run is promoted to complete, and no original-contract result is assigned to the final contract.'}
(out / 'archive.json').write_text(json.dumps(index, indent=2) + '\n')
component_table = '\n'.join('| `' + row['producerRevision'][:7] + '` | `' + row['consumerRevision'][:7] + '` | ' + str(row['testsRun']) + ' | 0 |' for row in components)
supplement_table = '\n'.join('| ' + row['population'] + ' | ' + str(row['declared']) + ' | ' + str(row['nativeAdmitted']) + ' | ' + str(row['tokenMeasured']) + ' | ' + row['recordedStatus'] + ' |' for row in old_supplements)
(out / 'README.md').write_text(f'''# Qualification before the final contract update

The synchronized producer `012c9fe49a082319bf98ac0c571596da925741a4` and
consumer `39c4036564428e44cc89caf261f517d856482695` added three real source
interoperability goldens and changed the contract digest. The coordinator
stopped the earlier contract's unfinished runs and requested fresh complete
qualification at that final pair. This package preserves the original bytes
and partial scopes without assigning their receipts to the replacement contract.

## Interrupted producer `562f6f2` / consumer `d26afd9` population

Producer `562f6f2e8e63a0be775acf2e0be145dc6f9f264c` and consumer
`d26afd9d7a901e740cf29d4bce610be755cac640` recorded **168 of 665 expansion
source/native admissions**, all passing, before interruption with exit 130.
The remaining **497 cases are untested or uncommitted**. No complete expansion
pass or expansion token-cost result is claimed. The exact native transports for
all 168 committed admissions were reconstructed and checked against their
original live source-recheck SHA-256 values; this integrity step is not a new
native execution.

The same pair's independent populations completed **23/23 interoperability and
11/11 gallery** source/native admissions and exact flat/native packing costs.
Those 34 cases use the earlier interoperability inventory; they do not establish
the final26+11 population. All original reports, source/admitted artifacts,
transports, costs, masks, progress journals and run receipts are preserved.

The 17-case flat-binding supplement completed seven positive source/native/token
admissions before interruption. It did not reach the remaining positives or any
of its three declared refusals. Original in-progress run/report statuses remain
unchanged; the separate supersession receipts explicitly record why execution
ended and identify the replacement pair.

## Other original-contract supplements

| Supplement | Declared | Native admitted | Token measured | Original report status |
| --- | ---: | ---: | ---: | --- |
{supplement_table}

The abrupt Number pair completed. Number cleanup and custom iterators were
interrupted on the contract update and retain their partial journals plus
separate interruption receipts. Unexecuted refusal cases are not called tested
refusals. The final-contract versions have independent fresh runs.

## Earlier complete populations and component gates

The preceding producer `62eb9436fee07d604a3017f5a8846a1fc786f7dd` and consumer
`e52a13518906cadd970e7f717245a9deae401034` also completed their original 23+11
source/native admissions, exact flat token costs and native packing. Their
artifacts and receipts remain a separate historical archive. Their incomplete
expansion prefix was already retained in the
[previous interrupted-run package](../native-v8-3a1992b-interrupted/README.md).

The following original component gates passed without skips. Each archive
retains its own clean before/after identities, exact commands and hashed logs;
these are separate runs and are not relabeled as final-contract validation.

| Producer | Native consumer | Tests passed | Skips |
| --- | --- | ---: | ---: |
{component_table}

The e52 archive additionally retains two source-authority checks against `62eb943` and
the separately pinned `5629fe6` one-test training/serving state-parity check.
Those supplementary receipts keep their own exact scopes and do not change the
component test counts above. The final `39c4036` / `012c9fe` component gate is retained with
the final complete qualification.

## Retention

[archive.json](archive.json) records every archive and decompressed member's
length and SHA-256. All member hashes were rechecked. The packaging helper
checks original report/artifact links, completed historical population counts,
component log hashes and exact reconstructed native transports. It performs no
new qualification. `SHA256SUMS` covers every package file.

These artifacts preserve work performed before supersession, including
incomplete attempts. They contribute no admissions to the final 665/26/11 or
37-episode training dataset denominators.
''')
(out / 'SHA256SUMS').write_text(''.join(sha(path) + '  ' + path.name + '\n' for path in sorted(out.iterdir()) if path.is_file() and path.name != 'SHA256SUMS'))
print(json.dumps({'output': str(out), 'archives': len(archives), 'verifiedMembers': sum(len(row['files']) for row in archives)}))
