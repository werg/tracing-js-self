"""Freshly bind, independently admit, verify and retain the 34-episode dataset."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time
from run_native_validation import OUT, ROOT, CONSUMER, PYTHON, TOKENIZER, REVISION, CONSUMER_REVISION, identity, sha, stamp

RUN = OUT / 'v8-dataset-final-492328f'
TOOLS = OUT / 'dataset-tools'
RETAINED = OUT.parent / 'dataset-v8-492328f'
env_overrides = {'TRACING_JS_SELF_ROOT': str(ROOT), 'MEGATOKEN_ROOT': str(CONSUMER),
                 'MEGATOKEN_PYTHON': str(PYTHON), 'MEGATOKEN_TOKENIZER_JSON': str(TOKENIZER),
                 'MEGATOKEN_NATIVE_SOURCE_PRODUCER': str(ROOT), 'PYTHONPATH': str(CONSUMER / 'src'),
                 'SEMANTIC_V8_NATIVE_POLICY': str(ROOT / 'contracts/semantic-native-policy-v8.json'),
                 'V8_DATASET_CAPTURE': str(RUN / 'native-inputs'),
                 'TMPDIR': '/workspace/scratch/35319cab5bbc/tmp', 'OMP_NUM_THREADS': '1', 'MKL_NUM_THREADS': '1'}
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
                OUT / 'native-interoperability', OUT / 'native-gallery'])
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
                     '--qualification', OUT / 'native-interoperability', '--qualification', OUT / 'native-gallery',
                     '--producer-revision', REVISION, '--consumer-revision', CONSUMER_REVISION], 'dataset-input-check.json')
receipt['pinsAfterExport'] = {'producer': identity(ROOT), 'consumer': identity(CONSUMER)}
assert receipt['pinsAfterExport'] == receipt['pinsBefore']
save()
shutil.copyfile(OUT / 'dataset-run.json', RUN / 'dataset-run-before-retention.json')
shutil.copyfile(Path(__file__), RUN / 'run_dataset.py')
run('pack', [PYTHON, TOOLS / 'pack-retained-dataset.py', '--run', RUN, '--output', RETAINED,
             '--prefix', RUN.name, '--interoperability-report', OUT / 'native-interoperability/report.json',
             '--gallery-report', OUT / 'native-gallery/report.json', '--verification', OUT / 'dataset-verification.json',
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
