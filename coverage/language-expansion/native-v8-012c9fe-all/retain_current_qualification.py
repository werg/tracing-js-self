#!/usr/bin/env python3
"""Package the final coordinated population run and separately pinned component validation."""
import argparse
import hashlib
import json
import shutil
import subprocess
import sys
import tarfile
import tempfile
from pathlib import Path


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def read(path):
    return json.loads(path.read_bytes())


parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--run', required=True, type=Path)
parser.add_argument('--output', required=True, type=Path)
parser.add_argument('--consumer-validation', required=True, type=Path)
parser.add_argument('--helpers', required=True, type=Path)
args = parser.parse_args()
r = read(args.run / 'run.json')
assert r['status'] == 'passed' and r['identityUnchanged']
assert r['pinsBefore'] == r['pinsAfter']
assert all(row['status'] == 'passed' and row['exitCode'] == 0 and row['pinsAfter'] == r['pinsBefore'] for row in r['commands'])
for row in r['commands']:
    for key in ['stdout', 'stderr']:
        entry = row[key]
        path = args.run / entry['path']
        assert path.stat().st_size == entry['bytes'] and sha(path) == entry['sha256']
cv = read(args.consumer_validation / 'consumer-validation.json')
assert cv['pins']['consumer']['revision'] == r['pinsBefore']['consumer']['revision']
assert cv['passed'] and cv['finalPins'] == cv['pins']
assert cv['pins']['producer']['revision'] == r['pinsBefore']['producer']['revision']
for row in cv['checks']:
    assert row['exitCode'] == 0
    path = args.consumer_validation / Path(row['log']).name
    assert sha(path) == row['logSha256']

with tempfile.TemporaryDirectory(prefix='qualification-retention-', dir=args.run.parent) as staging:
    validation = Path(staging) / 'consumer-validation'
    shutil.copytree(args.consumer_validation, validation)
    shutil.copyfile(validation / 'consumer-validation.json', validation / 'summary.json')
    command = [sys.executable, str(args.helpers / 'retain-evidence.py'), '--output', str(args.output),
               '--comparison', str(args.run / 'paired-serving-costs.json'),
               '--comparison-inputs', str(args.run / 'comparison-inputs.json'),
               '--reference', str(args.run / 'reference'),
               '--policy', str(Path(r['pinsBefore']['producer']['path']) / 'contracts/semantic-native-policy-v8.json'),
               '--validation', str(validation), '--max-archive-bytes', '48000000']
    for population in ['all', 'gallery', 'interoperability']:
        command += ['--population', f'{population}:{args.run / ("native-" + population)}:{args.run / ("costs-" + population)}']
    subprocess.run(command, check=True)

out = args.output
shutil.copyfile(args.run / 'run.json', out / 'run.json')
for row in r['commands']:
    for key in ['stdout', 'stderr']:
        name = row[key]['path']
        (out / name).parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(args.run / name, out / name)
for name in ['consumer-validation.json']:
    shutil.copyfile(args.consumer_validation / name, out / name)
helpers = ['run_current_qualification.py', 'run_dataset_qualification.py', 'run_stream_costs.py',
           'stream_qualification_costs.mjs', 'finish_current_qualification.py', 'run_reference_012c9fe.py',
           'record_qualification_handoff.py',
           'retain_current_qualification.py', 'render_current_evidence.py', 'adopt_current_populations.py',
           'retain-evidence.py', 'retain-native-inputs.mjs', 'prepare-v8-dataset.mjs',
           'v8-native-capture.mjs', 'verify.py', 'verify-qualification-inputs.py', 'pack-retained-dataset.py']
helper_files = []
for name in helpers:
    source = args.helpers / name
    shutil.copyfile(source, out / name)
    helper_files.append({'path': name, 'bytes': source.stat().st_size, 'sha256': sha(source)})
(out / 'helpers.json').write_text(json.dumps({'schema': 'semantic-v8-qualification-helpers/1', 'files': helper_files}, indent=2) + '\n')

for entry in r['independentPopulationRuns']['files']:
    source = args.run / entry['path']
    assert source.stat().st_size == entry['bytes'] and sha(source) == entry['sha256']
shutil.copytree(args.run / 'independent-population-runs', out / 'independent-population-runs')
for population in ['interoperability', 'gallery']:
    shutil.copyfile(args.run / ('adopted-' + population + '.json'), out / ('adopted-' + population + '.json'))
component_scope = {
    'schema': 'semantic-v8-component-validation-scope/1',
    'populationProducerRevision': r['pinsBefore']['producer']['revision'],
    'populationConsumerRevision': r['pinsBefore']['consumer']['revision'],
    'componentProducerRevision': cv['pins']['producer']['revision'],
    'componentConsumerRevision': cv['pins']['consumer']['revision'],
    'producerChangedPaths': subprocess.check_output(['git', '-C', r['pinsBefore']['producer']['path'], 'diff', '--name-only',
        cv['pins']['producer']['revision'], r['pinsBefore']['producer']['revision'], '--', 'src', 'test', 'tools', 'contracts'], text=True).splitlines(),
    'scope': 'Native component tests and complete final source/native populations are distinct executed gates at the exact same producer and consumer revisions. Earlier receipts retain their own pins and are not relabeled.'}
(out / 'component-validation-scope.json').write_text(json.dumps(component_scope, indent=2) + '\n')
if r.get('provenanceFiles'):
    members = []
    for entry in r['provenanceFiles']:
        source = args.run / entry['path']
        assert source.stat().st_size == entry['bytes'] and sha(source) == entry['sha256']
        members.append(entry)
    archive_path = out / 'coordinated-provenance.tar.xz'
    with tarfile.open(archive_path, 'w:xz', format=tarfile.PAX_FORMAT, preset=6) as archive:
        for entry in members:
            member = tarfile.TarInfo(entry['path'])
            member.size, member.mode, member.mtime = entry['bytes'], 0o644, 0
            with (args.run / entry['path']).open('rb') as stream:
                archive.addfile(member, stream)
    with tarfile.open(archive_path, 'r:xz') as archive:
        assert archive.getnames() == [row['path'] for row in members]
        for entry in members:
            data = archive.extractfile(entry['path']).read()
            assert len(data) == entry['bytes'] and hashlib.sha256(data).hexdigest() == entry['sha256']
    index = {'schema': 'semantic-v8-coordinated-provenance/1', 'archive': {'path': archive_path.name,
        'bytes': archive_path.stat().st_size, 'sha256': sha(archive_path)}, 'files': members,
        'memberHashesRechecked': True, 'freshNativeExecution': False,
        'scope': 'Unchanged original command receipts, explicit interruption of downstream input retention after completed native and ordinary-cost gates, streamed source/artifact bindings and complete independent costs, 11-case pilot and full665-case ordinary CLI equivalence, and independent reference/dataset execution evidence.'}
    (out / 'coordinated-provenance.json').write_text(json.dumps(index, indent=2) + '\n')
    exposed = ['provenance/source-orchestration/run.json', 'provenance/source-orchestration/parallel-stage-handoff.json',
               'provenance/source-orchestration/full-cost-equivalence.json',
               'provenance/stream-cost-command/run.json', 'provenance/stream-cost-stream-run.json',
               'provenance/stream-cost-source-bindings.json', 'provenance/reference-command/run.json',
               'provenance/dataset-command/run.json', 'provenance/dataset-command/dataset-verification.json',
               'provenance/dataset-command/dataset-input-check.json', 'provenance/cost-equivalence-pilot/equivalence.json']
    for name in exposed:
        (out / name).parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(args.run / name, out / name)
subprocess.run([sys.executable, str(args.helpers / 'render_current_evidence.py'), '--package', str(out), '--run', str(args.run)], check=True)
(out / 'SHA256SUMS').write_text(''.join(sha(path) + '  ' + path.relative_to(out).as_posix() + '\n' for path in sorted(out.rglob('*')) if path.is_file() and path.name != 'SHA256SUMS'))
print(json.dumps({'output': str(out), 'files': len([path for path in out.rglob('*') if path.is_file()]),
                  'producer': r['pinsBefore']['producer']['revision'], 'consumer': r['pinsBefore']['consumer']['revision'],
                  'consumerValidation': cv['pins']['consumer']['revision']}))
