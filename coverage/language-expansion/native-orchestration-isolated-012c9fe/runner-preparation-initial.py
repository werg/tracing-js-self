"""Retain a narrow unchanged-bound native lifecycle diagnostic; never edit the pair."""

import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import time

ROOT = Path('/workspace/scratch/754a49249d01')
PRODUCER = ROOT / 'native-producer-current-012c9fe'
CONSUMER = ROOT / 'native-consumer-39c4036'
SERVED = ROOT / 'native-v8-cli-smoke/served'
OUTPUT = ROOT / 'native-orchestration-isolated-012c9fe-39c4036'
PRODUCER_SHA = '012c9fe49a082319bf98ac0c571596da925741a4'
CONSUMER_SHA = '39c4036564428e44cc89caf261f517d856482695'
ORIGINAL = ROOT / 'tracing-js-self/coverage/language-expansion/producer-regression-012c9fe'
RECORDED_MANIFEST = ROOT / 'native-v8-external-evidence-audit/retained/training/baseline/manifest.json'
TEST_PATH = 'test/training-orchestration-evaluation.test.js'
PATTERN = '^(native |actual initialized-weight native coordinator)'


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def file_identity(path):
    return {'path': str(path), 'bytes': path.stat().st_size,
            'sha256': hashlib.sha256(path.read_bytes()).hexdigest()}


def snapshot(path):
    def git(*args):
        return subprocess.check_output(['git', '-C', str(path), *args], text=True).strip()
    return {'path': str(path), 'revision': git('rev-parse', 'HEAD'),
            'tree': git('rev-parse', 'HEAD:'),
            'status': git('status', '--porcelain=v1', '--untracked-files=all')}


def served_identity():
    return {str(path.relative_to(SERVED)): file_identity(path)
            for path in sorted(SERVED.rglob('*')) if path.is_file()}


def capture():
    pins = {'producer': snapshot(PRODUCER), 'consumer': snapshot(CONSUMER)}
    assert pins['producer']['revision'] == PRODUCER_SHA
    assert pins['consumer']['revision'] == CONSUMER_SHA
    assert all(not pin['status'] for pin in pins.values())
    files = served_identity()
    local = json.loads((SERVED / 'manifest.json').read_text())
    recorded = json.loads(RECORDED_MANIFEST.read_text())
    differences = {key: {'local': local.get(key), 'recorded': recorded.get(key)}
                   for key in sorted(local.keys() | recorded.keys())
                   if local.get(key) != recorded.get(key)}
    assert set(differences) == {'checkpoint_sha256', 'transducer_sha256'}
    for filename, key in [('model.safetensors', 'model_sha256'),
                          ('model_config.json', 'config_sha256'),
                          ('tokenizer.json', 'tokenizer_sha256'),
                          ('transducer.pt', 'transducer_sha256')]:
        assert files[filename]['sha256'] == local[key]
    assert local['model_sha256'] == '2a7eefffb21e8901150e6932ccd3d7f048fa2efb0ed4d9ebc9072feab43f0452'
    return {'pins': pins, 'served': files, 'manifestDifferencesFromOriginal': differences}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--run', action='store_true')
    parser.add_argument('--quiet-window-note')
    args = parser.parse_args()
    OUTPUT.mkdir(exist_ok=True)
    temporary = OUTPUT / 'tmp'
    temporary.mkdir(exist_ok=True)
    native_evidence = OUTPUT / 'native-orchestration'
    command = [shutil.which('node'), '--test', '--test-concurrency=1',
               '--test-name-pattern=' + PATTERN, '--test-reporter=tap', TEST_PATH]
    environment = {
        'TMPDIR': str(temporary), 'PYTHONPATH': str(CONSUMER / 'src'),
        'PYTHONNOUSERSITE': '1', 'PYTHONDONTWRITEBYTECODE': '1',
        'OMP_NUM_THREADS': '1', 'MKL_NUM_THREADS': '1',
        'MEGATOKEN_ROOT': str(CONSUMER), 'MEGATOKEN_REPOSITORY': str(CONSUMER),
        'MEGATOKEN_PYTHON': str(ROOT / 'native-v8-venv/bin/python'),
        'MEGATOKEN_TOKENIZER_JSON': str(ROOT / 'native-v8-tokenizer.json'),
        'MEGATOKEN_NATIVE_SOURCE_PRODUCER': str(PRODUCER),
        'TRACING_JS_SELF_ROOT': str(PRODUCER),
        'SEMANTIC_V8_NATIVE_POLICY': str(PRODUCER / 'contracts/semantic-native-policy-v8.json'),
        'MEGATOKEN_ORCHESTRATION_SERVED': str(SERVED),
        'MEGATOKEN_ORCHESTRATION_EVIDENCE_DIR': str(native_evidence),
    }
    plan = {
        'schema': 'native-orchestration-isolated-diagnostic/1', 'preparedAt': now(),
        'scope': 'Five existing optional native coordinator gates, serially, at unchanged clean source/native revisions. No optimizer, source recollection or semantic code change. This does not overwrite or upgrade the original full-suite failures.',
        'command': command, 'cwd': str(PRODUCER), 'environment': environment,
        'identities': capture(), 'test': file_identity(PRODUCER / TEST_PATH),
        'originalFailureReceipt': file_identity(ORIGINAL / 'summary.json'),
        'originalFailureArchive': file_identity(ORIGINAL / 'native-orchestration.tar.xz'),
        'recordedManifest': file_identity(RECORDED_MANIFEST),
        'substitution': 'The available initialized served bundle has identical model weights, model configuration, production tokenizer, chunking and serving-format identities. Its checkpoint identity and transducer-bank bytes differ from the unavailable original full bundle and are explicitly recorded; this is a compatible-bundle diagnostic, not byte-identical whole-bundle reproduction.',
        'unchangedBounds': {
            'rpcMs': 30000,
            'evaluationMs': {'services': 60000, 'retainedContext': 240000,
                             'budget': 30000, 'invalidChild': 30000, 'modelRejection': 30000},
            'cleanupMs': {'services': 1000, 'retainedContext': 3000,
                          'budget': 1000, 'invalidChild': 1000, 'modelRejection': 1000},
            'testMs': {'default': 120000, 'retainedContext': 290000},
        },
        'runtime': {'node': subprocess.check_output([command[0], '--version'], text=True).strip(),
                    'pythonExecutable': environment['MEGATOKEN_PYTHON']},
        'runner': file_identity(Path(__file__)),
    }
    plan_path = OUTPUT / 'plan.json'
    if not plan_path.exists():
        plan_path.write_text(json.dumps(plan, indent=2) + '\n')
        shutil.copyfile(__file__, OUTPUT / Path(__file__).name)
    if not args.run:
        print(json.dumps({'prepared': True, 'plan': str(plan_path),
                          'command': command, 'manifestDifferences': plan['identities']['manifestDifferencesFromOriginal']}))
        return
    assert args.quiet_window_note, 'Record the observed quiet-window evidence before starting'
    receipt_path = OUTPUT / 'run.json'
    assert not receipt_path.exists(), 'Use a new directory for another attempt'
    original_plan = json.loads(plan_path.read_text())
    assert original_plan['identities'] == plan['identities']
    assert original_plan['test'] == plan['test']
    assert original_plan['runner']['sha256'] == plan['runner']['sha256']
    receipt = {**plan, 'startedAt': now(), 'quietWindowNote': args.quiet_window_note,
               'plan': file_identity(plan_path), 'status': 'running'}
    receipt_path.write_text(json.dumps(receipt, indent=2) + '\n')
    stdout_path, stderr_path = OUTPUT / 'unit.stdout.log', OUTPUT / 'unit.stderr.log'
    started = time.monotonic()
    try:
        with stdout_path.open('wb') as out, stderr_path.open('wb') as err:
            result = subprocess.run(command, cwd=PRODUCER, env={**os.environ, **environment},
                                    stdout=out, stderr=err, timeout=900)
        receipt['exitCode'] = result.returncode
    except subprocess.TimeoutExpired:
        receipt['exitCode'] = None
        receipt['outerTimeoutSeconds'] = 900
    receipt.update(finishedAt=now(), elapsedSeconds=time.monotonic()-started,
                   stdout=file_identity(stdout_path), stderr=file_identity(stderr_path),
                   finalIdentities=capture())
    text = stdout_path.read_text()
    receipt['tapCounts'] = {name: int(value) for name, value in re.findall(
        r'^# (tests|suites|pass|fail|cancelled|skipped|todo) (\d+)$', text, flags=re.MULTILINE)}
    receipt['evidence'] = [file_identity(path) for path in sorted(native_evidence.glob('*.json'))]
    receipt['identityUnchanged'] = receipt['identities'] == receipt['finalIdentities']
    receipt['status'] = 'passed' if (
        receipt['exitCode'] == 0 and receipt['identityUnchanged']
        and receipt['tapCounts'].get('pass') == 5
        and not receipt['tapCounts'].get('fail') and not receipt['tapCounts'].get('cancelled')
        and len(receipt['evidence']) == 5) else 'failed'
    receipt_path.write_text(json.dumps(receipt, indent=2) + '\n')
    print(json.dumps({'status': receipt['status'], 'receipt': str(receipt_path),
                      'counts': receipt['tapCounts'], 'exitCode': receipt['exitCode']}))
    raise SystemExit(0 if receipt['status'] == 'passed' else 1)


if __name__ == '__main__':
    main()
