"""Freshly bind, independently admit, verify and retain the 37-episode dataset."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time
import datetime
import hashlib
BASE = Path('/workspace/scratch/d11743e0247b')
OUT = BASE / 'v8-final-dataset-run-012c9fe'
ROOT = BASE / 'v8-final-producer'
CONSUMER = BASE / 'v8-final-native'
PYTHON = BASE / 'native-venv/bin/python'
TOKENIZER = BASE / 'tokenizer.json'
REVISION = '012c9fe49a082319bf98ac0c571596da925741a4'
CONSUMER_REVISION = '39c4036564428e44cc89caf261f517d856482695'
QUALIFICATION = BASE / 'v8-final-qualification-012c9fe'
OUT.mkdir(exist_ok=False)
(OUT / 'tmp').mkdir()
def stamp():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()
def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()
def identity(path):
    def git(*args):
        return subprocess.check_output(['git', '-C', str(path), *args], text=True).strip()
    return {'revision': git('rev-parse', 'HEAD'), 'tree': git('rev-parse', 'HEAD^{tree}'),
            'trackedChanges': git('status', '--porcelain')}
print(json.dumps({'event': 'waiting-for-complete-source-populations'}), flush=True)
while not all((QUALIFICATION / ('native-' + name) / 'report.json').exists()
              for name in ['interoperability', 'gallery']):
    time.sleep(5)


RUN = OUT / 'v8-dataset-final-012c9fe'
TOOLS = BASE / 'v8-final-dataset-tools'
RETAINED = BASE / 'tracing-js-self/coverage/language-expansion/dataset-v8-012c9fe'
env_overrides = {'TRACING_JS_SELF_ROOT': str(ROOT), 'MEGATOKEN_ROOT': str(CONSUMER),
                 'MEGATOKEN_PYTHON': str(PYTHON), 'MEGATOKEN_TOKENIZER_JSON': str(TOKENIZER),
                 'MEGATOKEN_NATIVE_SOURCE_PRODUCER': str(ROOT), 'PYTHONPATH': str(CONSUMER / 'src'),
                 'SEMANTIC_V8_NATIVE_POLICY': str(ROOT / 'contracts/semantic-native-policy-v8.json'),
                 'V8_DATASET_CAPTURE': str(RUN / 'native-inputs'),
                 'TMPDIR': str(OUT / 'tmp'), 'OMP_NUM_THREADS': '1', 'MKL_NUM_THREADS': '1'}
env = {**os.environ, **env_overrides}
receipt = {'schema': 'semantic-v8-dataset-run/1', 'status': 'running', 'startedAt': stamp(),
           'pinsBefore': {'producer': identity(ROOT), 'consumer': identity(CONSUMER)},
           'environmentOverrides': env_overrides, 'commands': [],
           'scope': 'Fresh production dataset admission after global split binding; zero optimizer steps.'}
assert receipt['pinsBefore']['producer']['revision'] == REVISION
assert receipt['pinsBefore']['consumer']['revision'] == CONSUMER_REVISION
assert not receipt['pinsBefore']['producer']['trackedChanges']
assert not receipt['pinsBefore']['consumer']['trackedChanges']

def save():
    (OUT / 'dataset-run.json').write_text(json.dumps(receipt, indent=2) + '\n')

def run(name, command, stdout_name=None):
    stdout = OUT / (stdout_name or ('dataset-' + name + '.stdout.log'))
    stderr = OUT / ('dataset-' + name + '.stderr.log')
    row = {'name': name, 'command': [str(v) for v in command], 'cwd': str(ROOT), 'startedAt': stamp(), 'status': 'running'}
    receipt['commands'].append(row)
    save()
    print(json.dumps({'event': 'started', 'name': name}), flush=True)
    start = time.monotonic()
    with stdout.open('wb') as out, stderr.open('wb') as err:
        completed = subprocess.run(row['command'], cwd=ROOT, env=env, stdout=out, stderr=err)
    row.update({'finishedAt': stamp(), 'durationSeconds': time.monotonic() - start,
                'exitCode': completed.returncode, 'status': 'passed' if completed.returncode == 0 else 'failed'})
    for key, path in [('stdout', stdout), ('stderr', stderr)]:
        row[key] = {'path': path.name, 'sha256': sha(path), 'bytes': path.stat().st_size}
        if RUN.exists() and name != 'pack':
            shutil.copyfile(path, RUN / path.name)
    save()
    print(json.dumps({'event': 'finished', 'name': name, 'status': row['status'], 'durationSeconds': row['durationSeconds']}), flush=True)
    if completed.returncode:
        receipt['status'] = 'failed'
        save()
        raise SystemExit(completed.returncode)

run('prepare', ['node', TOOLS / 'prepare-v8-dataset.mjs', ROOT, RUN,
                QUALIFICATION / 'native-interoperability', QUALIFICATION / 'native-gallery'])
for name in ['prepare-v8-dataset.mjs', 'v8-native-capture.mjs']:
    shutil.copyfile(TOOLS / name, RUN / name)
run('export', ['node', ROOT / 'tools/export-semantic-v8.mjs', '--input', RUN / 'candidates.jsonl',
               '--tokenizer-module', ROOT / 'tools/semantic-v8-tokenizer-adapter.mjs',
               '--native-module', RUN / 'v8-native-capture.mjs', '--max-context', '1048576',
               '--max-examples', '4096', '--seed', '17', '--out', RUN / 'dataset'])
run('verify', [PYTHON, TOOLS / 'verify.py', RUN, '--producer-revision', REVISION,
               '--consumer-revision', CONSUMER_REVISION, '--codec-source', CONSUMER / 'src/megatoken/generation/codec.py',
               '--tokenizer-json', TOKENIZER], 'dataset-verification.json')
run('check-inputs', [PYTHON, TOOLS / 'verify-qualification-inputs.py', RUN,
                     '--qualification', QUALIFICATION / 'native-interoperability', '--qualification', QUALIFICATION / 'native-gallery',
                     '--producer-revision', REVISION, '--consumer-revision', CONSUMER_REVISION], 'dataset-input-check.json')
receipt['pinsAfterExport'] = {'producer': identity(ROOT), 'consumer': identity(CONSUMER)}
assert receipt['pinsAfterExport'] == receipt['pinsBefore']
save()
shutil.copyfile(OUT / 'dataset-run.json', RUN / 'dataset-run-before-retention.json')
shutil.copyfile(Path(__file__), RUN / 'run_dataset.py')
run('pack', [PYTHON, TOOLS / 'pack-retained-dataset.py', '--run', RUN, '--output', RETAINED,
             '--prefix', RUN.name, '--interoperability-report', QUALIFICATION / 'native-interoperability/report.json',
             '--gallery-report', QUALIFICATION / 'native-gallery/report.json', '--verification', OUT / 'dataset-verification.json',
             '--input-check', OUT / 'dataset-input-check.json', '--helpers', TOOLS,
             '--producer-revision', REVISION, '--consumer-revision', CONSUMER_REVISION])
receipt['status'] = 'passed'
receipt['finishedAt'] = stamp()
receipt['pinsAfter'] = {'producer': identity(ROOT), 'consumer': identity(CONSUMER)}
assert receipt['pinsAfter'] == receipt['pinsBefore']
save()
shutil.copyfile(OUT / 'dataset-run.json', RETAINED / 'run-receipt.json')
shutil.copyfile(Path(__file__), RETAINED / 'run_dataset.py')
for row in receipt['commands']:
    if row['name'] == 'pack':
        for stream in ['stdout', 'stderr']:
            path = OUT / row[stream]['path']
            shutil.copyfile(path, RETAINED / path.name)
paths = sorted(p for p in RETAINED.iterdir() if p.is_file() and p.name != 'SHA256SUMS')
(RETAINED / 'SHA256SUMS').write_text(''.join(f'{sha(p)}  {p.name}\n' for p in paths))
print(json.dumps({'event': 'completed', 'status': 'passed', 'output': str(RETAINED),
                  'archiveBytes': (RETAINED / 'run.tar.xz').stat().st_size,
                  'archiveWithinFiveMiB': (RETAINED / 'run.tar.xz').stat().st_size <= 5 * 1024 * 1024}), flush=True)
