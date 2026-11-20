#!/usr/bin/env python3
"""Assemble independently executed exact-pair gates after a recorded orchestration handoff."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import time

from run_current_qualification import identity, require, sha, stamp


def read(path):
    return json.loads(path.read_bytes())


def check_logs(directory, row):
    for key in ['stdout', 'stderr']:
        record = row[key]
        path = directory / record['path']
        require(path.stat().st_size == record['bytes'] and sha(path) == record['sha256'], 'Original ' + key + ' bytes')


def copy_files(source, destination):
    destination.mkdir(exist_ok=False)
    for path in sorted(source.iterdir()):
        if path.is_file():
            shutil.copyfile(path, destination / path.name)


parser = argparse.ArgumentParser(description=__doc__)
for name in ['source-run', 'stream-run', 'stream-validation', 'reference', 'reference-run',
             'dataset-run', 'independent-populations', 'output']:
    parser.add_argument('--' + name, type=Path, required=True)
args = parser.parse_args()
source = read(args.source_run / 'run.json')
handoff = read(args.source_run / 'parallel-stage-handoff.json')
stream_root = args.stream_run.with_name(args.stream_run.name + '-run')
stream = read(stream_root / 'run.json')
meter = read(args.stream_run / 'stream-run.json')
dataset = read(args.dataset_run / 'run.json')
reference = read(args.reference_run / 'run.json')
equivalence = read(args.stream_validation / 'equivalence.json')
pins = source['pinsBefore']
producer = Path(pins['producer']['path'])
consumer = Path(pins['consumer']['path'])
python = Path(source['environmentOverrides']['MEGATOKEN_PYTHON'])
helpers = Path(__file__).resolve().parent
require(handoff['status'] == 'coordinator-handoff' and handoff['sourceRunSha256'] == sha(args.source_run / 'run.json'), 'Explicit original handoff')
require(handoff['identityUnchanged'] and handoff['pinsBefore'] == handoff['pinsAfter'] == pins, 'Unchanged post-stop source identities')
require(handoff['observedExitCode'] == 130 and handoff['interruptedStage'] == 'retain-inputs-all', 'Actual coordinator stop')
native_command = source['commands'][0]
require(native_command['name'] == 'native-all' and native_command['status'] == 'passed' and native_command['exitCode'] == 0, 'Complete original native population gate')
require(native_command['pinsAfter'] == pins, 'Native population identities')
require([row['name'] for row in source['commands'][1:]] == ['costs-all', 'retain-inputs-all'], 'Exact downstream command dispositions')
serial_cost_command = source['commands'][1]
require(serial_cost_command['status'] == 'passed' and serial_cost_command['exitCode'] == 0 and serial_cost_command['pinsAfter'] == pins, 'Complete ordinary cost CLI')
require(source['commands'][2]['status'] == 'running', 'Retain original interrupted last-saved entry')
check_logs(args.source_run, native_command)
check_logs(args.source_run, serial_cost_command)
full_equivalence = read(args.source_run / 'full-cost-equivalence.json')
require(full_equivalence['passed'] and full_equivalence['qualifiedCases'] == 665 and full_equivalence['everyPhysicalArtifactByteIdentical'], 'Complete ordinary/stream physical equality')
require(full_equivalence['ordinaryCliRunReceiptSha256'] == sha(args.source_run / 'run.json'), 'Full equivalence receipt binding')
require(full_equivalence['ordinaryReportSha256'] == sha(args.source_run / 'costs-all/report.json') and full_equivalence['streamReportSha256'] == sha(args.stream_run / 'costs/report.json'), 'Full equivalence report bindings')
qualification = read(args.source_run / 'native-all/report.json')
require(qualification['declared'] == qualification['sourceQualified'] == qualification['nativeAdmitted'] == 665, 'Complete expansion')
require(sha(args.source_run / 'native-all/report.json') == handoff['qualificationReportSha256'], 'Handoff report binding')
require(stream['status'] == 'passed' and stream['exitCode'] == 0 and stream['identityUnchanged'], 'Complete independent cost command')
require(stream['pinsBefore'] == stream['pinsAfter'] == pins, 'Exact streamed-cost pair')
check_logs(stream_root, stream)
require(meter['status'] == 'passed' and meter['declared'] == meter['measured'] == 665, 'Complete immutable-artifact measurements')
require(stream['streamReceiptSha256'] == sha(args.stream_run / 'stream-run.json'), 'Stream receipt hash')
require(meter['qualificationReportSha256'] == sha(args.source_run / 'native-all/report.json'), 'Final cost qualification binding')
costs = read(args.stream_run / 'costs/report.json')
require(costs['schema'] == 'semantic-v8-population-costs/1', 'Normal population-cost report schema')
require(costs['qualification']['reportSha256'] == meter['qualificationReportSha256'], 'Normal report input binding')
require(costs['summary']['flat']['tokenMeasuredEpisodes'] == costs['summary']['nativePacking']['measuredEpisodes'] == 665, 'All exact physical costs')
require(equivalence['passed'] and equivalence['qualifiedCases'] == 11 and equivalence['everyPhysicalArtifactByteIdentical'], 'Ordinary CLI equivalence')
require(equivalence['producerRevision'] == pins['producer']['revision'] and equivalence['consumerRevision'] == pins['consumer']['revision'], 'Equivalence exact pair')
require(dataset['status'] == 'passed' and dataset['identityUnchanged'] and dataset['pinsBefore'] == dataset['pinsAfter'] == pins, 'Complete exact-pair dataset')
for command in dataset['commands']:
    require(command['status'] == 'passed' and command['exitCode'] == 0 and command['pinsAfter'] == pins, 'Dataset commands')
    check_logs(args.dataset_run, command)
require(reference['status'] == 'passed' and reference['exitCode'] == 0 and reference['identityUnchanged'], 'Independent reference benchmark')
require(reference['producerBefore'] == reference['producerAfter'], 'Reference producer unchanged')
require(reference['producerBefore']['revision'] == pins['producer']['revision'] and reference['producerBefore']['tree'] == pins['producer']['tree']
        and not reference['producerBefore']['statusPorcelain'], 'Reference exact source identity')
check_logs(args.reference_run, reference)
for artifact in reference['outputFiles']:
    path = args.reference / artifact['path']
    require(path.stat().st_size == artifact['bytes'] and sha(path) == artifact['sha256'], 'Reference output bytes')

out = args.output.resolve()
out.mkdir(exist_ok=False)
(out / 'tmp').mkdir()
provenance = out / 'provenance'
provenance.mkdir()
for source_dir, name in [(args.source_run, 'source-orchestration'), (stream_root, 'stream-cost-command'),
                         (args.reference_run, 'reference-command'), (args.dataset_run, 'dataset-command')]:
    copy_files(source_dir, provenance / name)
shutil.copytree(args.stream_run / 'costs', provenance / 'independent-stream-costs')
for name in ['stream-run.json', 'source-bindings.json']:
    shutil.copyfile(args.stream_run / name, provenance / ('stream-cost-' + name))
shutil.copytree(args.stream_validation, provenance / 'cost-equivalence-pilot')
shutil.copytree(args.stream_validation.with_name(args.stream_validation.name + '-run'), provenance / 'cost-equivalence-command',
                ignore=shutil.ignore_patterns('tmp'))
for name in ['run_current_qualification.py', 'run_dataset_qualification.py', 'run_stream_costs.py',
             'stream_qualification_costs.mjs', 'finish_current_qualification.py', 'run_reference_012c9fe.py',
             'record_qualification_handoff.py']:
    shutil.copyfile(helpers / name, provenance / name)

def imported_command(row, prefix, name=None):
    imported = json.loads(json.dumps(row))
    if name:
        imported['name'] = name
    for key in ['stdout', 'stderr']:
        imported[key]['path'] = prefix + '/' + imported[key]['path']
    imported['executedIndependently'] = True
    return imported

commands = [imported_command(native_command, 'provenance/source-orchestration')]
commands.append(imported_command(serial_cost_command, 'provenance/source-orchestration'))
cost_command = imported_command(stream, 'provenance/stream-cost-command', 'stream-costs-all')
cost_command.pop('environmentOverrides', None)
commands.append(cost_command)
for row in dataset['commands']:
    commands.append(imported_command(row, 'provenance/dataset-command', 'parallel-' + row['name']))
overrides = {**source['environmentOverrides'], 'TMPDIR': str(out / 'tmp')}
env = {**os.environ, **overrides}
receipt = {'schema': 'semantic-v8-coordinated-qualification-run/1', 'status': 'running', 'startedAt': source['startedAt'],
    'assemblyStartedAt': stamp(), 'pinsBefore': pins, 'environmentOverrides': overrides, 'runtime': source['runtime'],
    'tokenizer': source['tokenizer'], 'workers': source['workers'], 'commands': commands,
    'scope': 'Complete independently executed source/native, exact physical costs, reference and split-bound dataset gates at one frozen pair. Original six source/native workers were unchanged; costs and dataset admission ran independently in parallel. Assembly performs no new source/native admission.',
    'sourceOrchestration': {'receipt': 'provenance/source-orchestration/run.json', 'sha256': sha(args.source_run / 'run.json'),
        'status': source['status'], 'handoff': 'provenance/source-orchestration/parallel-stage-handoff.json',
        'handoffSha256': sha(args.source_run / 'parallel-stage-handoff.json'),
        'scope': 'All665 admissions and ordinary physical-cost measurements completed before coordinator interruption of downstream input-retention orchestration. The original last-saved running receipt is unchanged; the separate handoff records actual exit130 and clean post-stop identities. Input retention is rerun during assembly.'},
    'streamedCosts': {'receipt': 'provenance/stream-cost-command/run.json', 'sha256': sha(stream_root / 'run.json'),
        'bindings': 'provenance/stream-cost-source-bindings.json', 'bindingsSha256': sha(args.stream_run / 'source-bindings.json'),
        'ordinaryCliEquivalence': 'provenance/cost-equivalence-pilot/equivalence.json',
        'ordinaryCliEquivalenceSha256': sha(args.stream_validation / 'equivalence.json'),
        'fullOrdinaryCliEquivalence': 'provenance/source-orchestration/full-cost-equivalence.json',
        'fullOrdinaryCliEquivalenceSha256': sha(args.source_run / 'full-cost-equivalence.json')},
    'independentReferenceRun': {'receipt': 'provenance/reference-command/run.json', 'sha256': sha(args.reference_run / 'run.json'),
        'consumerUsed': False, 'scope': 'Actual reference benchmark checks the frozen producer only; no consumer gate or model response is inferred.'},
    'independentDatasetRun': {'receipt': 'provenance/dataset-command/run.json', 'sha256': sha(args.dataset_run / 'run.json'),
        'datasetDirectory': str(args.dataset_run / ('v8-dataset-' + pins['producer']['revision'][:7])),
        'freshNativeExecution': True, 'nativeExportWorkers': 1}}


def save():
    (out / 'run.json').write_text(json.dumps(receipt, indent=2) + '\n')


def run(name, command):
    row = {'name': name, 'command': [str(value) for value in command], 'cwd': str(producer), 'startedAt': stamp(), 'status': 'running'}
    receipt['commands'].append(row)
    save()
    print(json.dumps({'event': 'started', 'name': name}), flush=True)
    stdout, stderr = out / (name + '.stdout.log'), out / (name + '.stderr.log')
    start = time.monotonic()
    with stdout.open('wb') as output, stderr.open('wb') as errors:
        result = subprocess.run(row['command'], cwd=producer, env=env, stdout=output, stderr=errors)
    row.update({'finishedAt': stamp(), 'durationSeconds': time.monotonic() - start, 'exitCode': result.returncode,
        'status': 'passed' if result.returncode == 0 else 'failed', 'pinsAfter': {'producer': identity(producer), 'consumer': identity(consumer)}})
    for key, path in [('stdout', stdout), ('stderr', stderr)]:
        row[key] = {'path': path.name, 'bytes': path.stat().st_size, 'sha256': sha(path)}
    save()
    require(row['pinsAfter'] == pins, 'Changed assembly identity')
    require(result.returncode == 0, name + ' failed')


try:
    save()
    shutil.copytree(args.source_run / 'native-all', out / 'native-all')
    shutil.copytree(args.source_run / 'costs-all', out / 'costs-all')
    run('retain-inputs-all', ['node', helpers / 'retain-native-inputs.mjs', out / 'native-all'])
    for population in ['interoperability', 'gallery']:
        run('adopt-' + population, [python, helpers / 'adopt_current_populations.py',
            '--qualification', args.independent_populations / population, '--costs', args.independent_populations / (population + '-costs'),
            '--output', out, '--population', population, '--producer', producer,
            '--producer-revision', pins['producer']['revision'], '--consumer-revision', pins['consumer']['revision']])
    independent = out / 'independent-population-runs'
    copy_files(args.independent_populations, independent)
    receipt['independentPopulationRuns'] = {'source': str(args.independent_populations),
        'files': [{'path': str(path.relative_to(out)), 'bytes': path.stat().st_size, 'sha256': sha(path)} for path in sorted(independent.iterdir())]}
    for population in ['interoperability', 'gallery']:
        require(sha(out / ('native-' + population) / 'report.json') == sha(args.dataset_run / ('native-' + population) / 'report.json'), 'Exact dataset prerequisite report equality')
    shutil.copytree(args.reference, out / 'reference')
    baseline = out / 'historical-costs'
    baseline.mkdir()
    archive_path = producer / 'coverage/language-expansion/baseline-token-costs-135bd1f/artifacts.tar.xz'
    index = read(archive_path.with_name('archive.json'))['archive']
    require(sha(archive_path) == index['sha256'], 'Historical baseline archive')
    with tarfile.open(archive_path, 'r:xz') as archive:
        archive.extractall(baseline, filter='data')
    for row in index['files']:
        path = baseline / row['name']
        require(path.stat().st_size == row['bytes'] and sha(path) == row['sha256'], 'Historical baseline members')
    comparison = {'schema': 'semantic-cost-comparison-inputs/1', 'populations': [
        {'id': name, 'costs': 'costs-' + name, 'qualification': 'native-' + name} for name in ['all', 'gallery', 'interoperability']]}
    (out / 'comparison-inputs.json').write_text(json.dumps(comparison, indent=2) + '\n')
    run('comparison', ['node', 'tools/compare-serving-costs.mjs', '--before', baseline,
        '--after-manifest', out / 'comparison-inputs.json', '--out', out / 'paired-serving-costs.json'])
    receipt['provenanceFiles'] = [{'path': str(path.relative_to(out)), 'bytes': path.stat().st_size, 'sha256': sha(path)}
        for path in sorted(provenance.rglob('*')) if path.is_file()]
    receipt['status'] = 'passed'
except BaseException as error:
    receipt['status'], receipt['failure'] = 'failed', str(error)
    raise
finally:
    receipt['finishedAt'] = stamp()
    receipt['pinsAfter'] = {'producer': identity(producer), 'consumer': identity(consumer)}
    receipt['identityUnchanged'] = receipt['pinsAfter'] == pins
    if not receipt['identityUnchanged']:
        receipt['status'] = 'failed'
    save()
    print(json.dumps({'event': 'completed', 'status': receipt['status'], 'output': str(out)}), flush=True)
