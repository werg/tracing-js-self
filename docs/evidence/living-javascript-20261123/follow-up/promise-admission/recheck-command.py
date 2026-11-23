"""Recheck the exact seven source artifacts refused by hosted attempt 2."""

import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import zipfile

BASE = Path('/workspace/scratch/0952c3151b8f')
PRODUCER = BASE / 'producer-admission-evidence'
CONSUMER = BASE / 'megatoken-promise-admission'
ARCHIVE = BASE / 'validation/consumer-65ebbf-interop-attempt2.zip'
TOKENIZER = BASE / 'semantic-v8-tokenizer.json'
OUTPUT = BASE / 'validation/promise-admission-candidate'
EXPECTED_IDS = {
    'source-promise-join-rejection-finally',
    'source-promise-executor-retained-resolution',
    'source-promise-executor-abrupt',
    'source-promise-adoption-executor',
    'source-promise-adoption-async-return',
    'source-promise-adoption-reaction-return',
    'promise-allsettled-nested-executor',
}


def identity(root):
    def git(*args):
        return subprocess.check_output(['git', '-C', str(root), *args], text=True).strip()
    state = {
        'root': str(root),
        'revision': git('rev-parse', 'HEAD'),
        'tree': git('rev-parse', 'HEAD:'),
        'status': git('status', '--porcelain', '--untracked-files=all'),
    }
    assert not state['status'], state
    return state


OUTPUT.mkdir(exist_ok=False)
before = {'producer': identity(PRODUCER), 'consumer': identity(CONSUMER)}
assert before['producer']['revision'] == 'a6e9c6ccf6f2b8b3d7bd7d75d0b5550d9c41fd2b'
assert before['consumer']['revision'] == '0028cce9c23ca33563a74c06e9a5bb4a033dc27e'
assert hashlib.sha256(TOKENIZER.read_bytes()).hexdigest() == '40fb9d7d7795b8bd305aeff39ce9963f3f450915b9553f2938e009be9a1fed60'
report = {
    'schema': 'hosted-promise-admission-recheck/1',
    'hostedRun': 45128882436,
    'hostedJob': 137551653560,
    'hostedArtifact': 14801430145,
    'archiveSha256': hashlib.sha256(ARCHIVE.read_bytes()).hexdigest(),
    'before': before,
    'runtime': {'python': sys.version, 'executable': sys.executable,
                'torch': importlib.metadata.version('torch'),
                'tokenizers': importlib.metadata.version('tokenizers')},
    'checks': [],
}
env = {**os.environ, 'PYTHONPATH': str(CONSUMER / 'src'),
       'TMPDIR': str(BASE / 'tmp'), 'OMP_NUM_THREADS': '1', 'MKL_NUM_THREADS': '1'}
try:
    with zipfile.ZipFile(ARCHIVE) as archive:
        original = json.loads(archive.read('_temp/v8-admitted/report.json'))
        failures = [row for row in original['rows'] if row['native'] == 'failed']
        assert {row['id'] for row in failures} == EXPECTED_IDS
        assert len(failures) == 7
        assert original['sourceQualified'] == original['declared'] == 77
        assert original['nativeAdmitted'] == 70
        for row in failures:
            source_name = row['sourceArtifact']
            assert Path(source_name).name == source_name
            raw = archive.read('_temp/v8-admitted/' + source_name)
            source = OUTPUT / source_name
            source.write_bytes(raw)
            receipt_path = OUTPUT / (row['id'] + '.receipt.json')
            command = [sys.executable, str(CONSUMER / 'scripts/admit_semantic_v8.py'),
                       '--input', str(source), '--output', str(receipt_path),
                       '--consumer-revision', before['consumer']['revision'],
                       '--producer-root', str(PRODUCER),
                       '--producer-revision', before['producer']['revision'],
                       '--tokenizer-json', str(TOKENIZER)]
            started = time.monotonic()
            result = subprocess.run(command, cwd=CONSUMER, env=env, capture_output=True,
                                    text=True, timeout=120, check=False)
            (OUTPUT / (row['id'] + '.stdout.log')).write_text(result.stdout)
            (OUTPUT / (row['id'] + '.stderr.log')).write_text(result.stderr)
            receipt = json.loads(receipt_path.read_text()) if receipt_path.exists() else None
            passed = result.returncode == 0 and receipt is not None and (
                receipt['admitted'] is True
                and all(value == 'passed' for value in receipt['checks'].values())
                and receipt['consumerRevision'] == before['consumer']['revision']
                and receipt['sourceVerification']['producerRevision'] == before['producer']['revision']
                and receipt['sourceVerification']['producerTreeClean'] is True
                and receipt['sourceVerification']['sourceValidated'] is True
                and receipt['sourceVerification']['projectionValidated'] is True
                and receipt['sourceVerification']['replayValidated'] is True
                and receipt['counts']['generatedTokens'] > 0
            )
            check = {'id': row['id'], 'sourceSha256': hashlib.sha256(raw).hexdigest(),
                     'command': command, 'returncode': result.returncode,
                     'durationSeconds': time.monotonic() - started, 'passed': passed,
                     'receipt': str(receipt_path)}
            report['checks'].append(check)
            print(json.dumps(check), flush=True)
finally:
    report['after'] = {'producer': identity(PRODUCER), 'consumer': identity(CONSUMER)}
    report['unchangedIdentities'] = report['after'] == report['before']
    report['passed'] = (len(report['checks']) == 7
                        and all(check['passed'] for check in report['checks'])
                        and report['unchangedIdentities'])
    (OUTPUT / 'command-report.json').write_text(json.dumps(report, indent=2) + '\n')
assert report['passed'], 'One or more exact hosted Promise source artifacts did not pass admission'
print('All seven exact hosted source artifacts passed source recheck, native admission and tokenizer packing.', flush=True)
