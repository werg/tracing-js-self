#!/usr/bin/env python3
"""Copy an independently completed same-pair population with exact artifact checks."""
import argparse
import hashlib
import json
import shutil
import subprocess
from pathlib import Path


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def read(path):
    return json.loads(path.read_bytes())


parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--qualification', required=True, type=Path)
parser.add_argument('--costs', required=True, type=Path)
parser.add_argument('--output', required=True, type=Path)
parser.add_argument('--population', required=True, choices=['interoperability', 'gallery'])
parser.add_argument('--producer', required=True, type=Path)
parser.add_argument('--producer-revision', required=True)
parser.add_argument('--consumer-revision', required=True)
args = parser.parse_args()
q, c = read(args.qualification / 'report.json'), read(args.costs / 'report.json')
inventory_check = subprocess.check_output(['node', '--input-type=module', '-e', '''
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
const [producer,directory,population,producerRevision]=process.argv.slice(1);
const load=name=>import(pathToFileURL(join(producer,name)));
const {regionQualificationPopulation}=await load('fixtures/semantic-regions/qualification.js');
const {encodeGenerationTask}=await load('src/corpus/generation-process.mjs');
const {readQualificationCostInputs}=await load('src/semantic/qualification-costs-v8.js');
const selected=regionQualificationPopulation({population,allInputs:true});
const tasks=[...selected.scripts,...selected.modules].map(fixture=>encodeGenerationTask({kind:fixture.modules?'module':'source',traceVersion:8,fixture,producerRevision}));
const input=readQualificationCostInputs(directory);
assert.deepEqual(input.population.tasks,tasks,'Qualification inputs differ from the exact frozen producer inventory');
console.log(JSON.stringify({declared:tasks.length,populationDigest:input.report.populationDigest}));
''', str(args.producer), str(args.qualification), args.population, args.producer_revision], text=True)
checked_inventory = json.loads(inventory_check)
count = checked_inventory['declared']
assert q['populationDigest'] == checked_inventory['populationDigest']
assert q['producerRevision'] == c['producerRevision'] == args.producer_revision
assert q['nativePolicy']['consumerRevision'] == args.consumer_revision
assert q['population'] == args.population and q['inputs'] == 'all' and not q['preparationOnly']
assert q['declared'] == q['sourceQualified'] == q['nativeAdmitted'] == len(q['rows']) == count
assert c['qualification']['reportSha256'] == sha(args.qualification / 'report.json')
assert c['summary']['flat']['tokenMeasuredEpisodes'] == c['summary']['nativePacking']['measuredEpisodes'] == count
assert c['tokenizerEvidence']['qualification']['consumerRevision'] == args.consumer_revision
assert all(row['source'] == row['native'] == 'passed' for row in q['rows'])
for directory, report in [(args.qualification, q), (args.costs, c)]:
    for name, checksum in report['artifacts'].items():
        assert Path(name).name == name and sha(directory / name) == checksum
for row in q['rows']:
    receipt = read(args.qualification / (row['id'] + '.native.json'))
    assert receipt == row['nativeReceipt']
    assert receipt['consumerRevision'] == args.consumer_revision
    assert receipt['sourceVerification']['producerRevision'] == args.producer_revision
    assert receipt['sourceVerification']['producerTreeClean']
    assert all(value == 'passed' for value in receipt['checks'].values())
manifest = read(args.qualification / 'native-inputs-manifest.json')
assert manifest['producerRevision'] == args.producer_revision and manifest['consumerRevision'] == args.consumer_revision
assert manifest['retainedNativeInputs'] == len(manifest['rows']) == count
for row in manifest['rows']:
    receipt = read(args.qualification / (row['id'] + '.native.json'))
    assert sha(args.qualification / row['nativeInput']) == row['nativeInputSha256'] == receipt['sourceVerification']['artifactSha256']
files = []
for kind, directory in [('qualification', args.qualification), ('costs', args.costs)]:
    target = args.output / (('native-' if kind == 'qualification' else 'costs-') + args.population)
    assert not target.exists()
    for source in sorted(directory.rglob('*')):
        assert not source.is_symlink()
        if source.is_file():
            files.append({'kind': kind, 'path': source.relative_to(directory).as_posix(), 'bytes': source.stat().st_size, 'sha256': sha(source)})
    shutil.copytree(directory, target)
    for item in files:
        if item['kind'] == kind:
            assert sha(target / item['path']) == item['sha256']
receipt = {'schema': 'semantic-v8-independent-population-adoption/1', 'status': 'passed',
           'producerRevision': args.producer_revision, 'consumerRevision': args.consumer_revision,
           'population': args.population, 'declared': count,
           'qualificationSource': str(args.qualification.resolve()), 'costSource': str(args.costs.resolve()),
           'qualificationReportSha256': sha(args.qualification / 'report.json'), 'costReportSha256': sha(args.costs / 'report.json'),
           'files': files, 'freshNativeExecution': False,
           'scope': 'Integrity and same-pair identity checks on an independently executed complete population. Source/native execution remains established by its original live-source receipts, not this copy operation.'}
(args.output / ('adopted-' + args.population + '.json')).write_text(json.dumps(receipt, indent=2) + '\n')
print(json.dumps({key: receipt[key] for key in ['schema', 'status', 'producerRevision', 'consumerRevision', 'population', 'declared', 'qualificationReportSha256', 'costReportSha256', 'freshNativeExecution']}))
