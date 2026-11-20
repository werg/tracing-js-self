import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import subprocess
import time

parser = argparse.ArgumentParser()
parser.add_argument('population', choices=['interoperability', 'gallery'])
args = parser.parse_args()
root = Path('/workspace/scratch/754a49249d01')
producer = root / 'native-producer-current-012c9fe'
consumer = root / 'native-consumer-39c4036'
base = root / 'native-current-qualification-012c9fe-39c4036'
base.mkdir(exist_ok=True)
population = args.population
qualification = base / population
costs = base / (population + '-costs')
receipt_path = base / (population + '-receipt.json')
assert not qualification.exists() and not costs.exists() and not receipt_path.exists()


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def snapshot(path):
    def git(*values):
        return subprocess.check_output(['git', '-C', str(path), *values], text=True).strip()
    return {'path': str(path), 'revision': git('rev-parse', 'HEAD'),
            'tree': git('rev-parse', 'HEAD:'),
            'status': git('status', '--porcelain', '--untracked-files=all')}


pins = {'consumer': snapshot(consumer), 'producer': snapshot(producer)}
assert pins['consumer']['revision'] == '39c4036564428e44cc89caf261f517d856482695'
assert pins['producer']['revision'] == '012c9fe49a082319bf98ac0c571596da925741a4'
assert not pins['consumer']['status'] and not pins['producer']['status']
policy_path = producer / 'contracts/semantic-native-policy-v8.json'
policy = json.loads(policy_path.read_text())
assert policy['consumerRevision'] == pins['consumer']['revision']
environment = {**os.environ,
               'PYTHONPATH': str(consumer / 'src'),
               'TMPDIR': str(root / 'native-v8-tmp'),
               'MEGATOKEN_ROOT': str(consumer),
               'MEGATOKEN_PYTHON': str(root / 'native-v8-venv/bin/python'),
               'MEGATOKEN_TOKENIZER_JSON': str(root / 'native-v8-tokenizer.json'),
               'SEMANTIC_V8_NATIVE_POLICY': str(policy_path),
               'OMP_NUM_THREADS': '1', 'MKL_NUM_THREADS': '1'}
receipt = {'schema': 'current-native-qualification-run/1', 'startedAt': now(),
           'population': population, 'pins': pins, 'policy': policy,
           'checks': [], 'optimizerSteps': 0, 'learningClaim': None}
receipt_path.write_text(json.dumps(receipt, indent=2) + '\n')

commands = [
    ('qualification', ['node', 'tools/qualify-semantic-v8.mjs', '--population', population,
                       '--inputs', 'all', '--workers', '2', '--out', str(qualification),
                       '--megatoken', str(consumer), '--python', environment['MEGATOKEN_PYTHON'],
                       '--tokenizer', environment['MEGATOKEN_TOKENIZER_JSON'],
                       '--native-policy', str(policy_path)]),
    ('costs', ['node', 'tools/measure-semantic-v8.mjs', '--qualification', str(qualification),
              '--out', str(costs), '--tokenizer-module', 'tools/semantic-v8-tokenizer-adapter.mjs']),
]
for name, command in commands:
    check = {'name': name, 'command': command, 'cwd': str(producer), 'startedAt': now()}
    start = time.monotonic()
    log = base / (population + '-' + name + '.log')
    with log.open('wb') as stream:
        completed = subprocess.run(command, cwd=producer, env=environment, stdout=stream,
                                   stderr=subprocess.STDOUT, timeout=3600)
    check.update(finishedAt=now(), durationSeconds=time.monotonic() - start,
                 exitCode=completed.returncode, log=str(log),
                 logSha256=hashlib.sha256(log.read_bytes()).hexdigest())
    receipt['checks'].append(check)
    receipt_path.write_text(json.dumps(receipt, indent=2) + '\n')
    print(json.dumps(check), flush=True)
    if completed.returncode:
        raise SystemExit(completed.returncode)

admitted = json.loads((qualification / 'report.json').read_text())
measured = json.loads((costs / 'report.json').read_text())
inventory = json.loads((qualification / 'population.json').read_text())
declared = inventory['declared']
assert declared == len(inventory['tasks']) == len(inventory['selectedCaseIds']) == len(admitted['rows'])
assert admitted['declared'] == declared
assert admitted['sourceQualified'] == admitted['nativeAdmitted'] == declared
assert not admitted['preparationOnly']
summary = measured['summary']
assert measured['tokenizerEvidence'] and summary['declared'] == declared
assert summary['flat']['measured'] == summary['flat']['tokenMeasuredEpisodes'] == declared
assert summary['flat']['tokenMeasurement'] == 'passed'
assert summary['nativePacking']['measuredEpisodes'] == declared
receipt.update(finishedAt=now(), finalPins={'consumer': snapshot(consumer), 'producer': snapshot(producer)},
               counts={'declared': declared, 'sourceQualified': admitted['sourceQualified'],
                       'nativeAdmitted': admitted['nativeAdmitted'],
                       'flatTokenMeasured': summary['flat']['tokenMeasuredEpisodes'],
                       'nativePackingMeasured': summary['nativePacking']['measuredEpisodes']},
               qualificationReport=str(qualification / 'report.json'),
               qualificationReportSha256=hashlib.sha256((qualification / 'report.json').read_bytes()).hexdigest(),
               costReport=str(costs / 'report.json'),
               costReportSha256=hashlib.sha256((costs / 'report.json').read_bytes()).hexdigest())
receipt['passed'] = receipt['finalPins'] == pins and all(check['exitCode'] == 0 for check in receipt['checks'])
receipt_path.write_text(json.dumps(receipt, indent=2) + '\n')
print(json.dumps({'passed': receipt['passed'], 'receipt': str(receipt_path), 'counts': receipt['counts']}), flush=True)
raise SystemExit(0 if receipt['passed'] else 1)
