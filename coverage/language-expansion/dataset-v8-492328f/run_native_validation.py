"""Run frozen v8 source/native qualification and exact token measurement."""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time

ROOT = Path('/workspace/scratch/35319cab5bbc/tracing-js-self-492328f')
CONSUMER = Path('/workspace/scratch/35319cab5bbc/megatoken-cb311db')
PYTHON = Path('/workspace/scratch/35319cab5bbc/native-venv/bin/python')
TOKENIZER = Path('/workspace/scratch/35319cab5bbc/tokenizer.json')
OUT = Path('/workspace/scratch/35319cab5bbc/validation-492328f')
REVISION = '492328fe387e99487285984b782cd3b402990e2c'
CONSUMER_REVISION = 'cb311dba6af44ef241450a87ef530a66aa55c7a3'

def stamp():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()

def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def identity(root):
    def capture(*args):
        return subprocess.check_output(['git', '-C', str(root), *args], text=True).strip()
    return {'path': str(root), 'revision': capture('rev-parse', 'HEAD'),
            'tree': capture('rev-parse', 'HEAD^{tree}'),
            'trackedChanges': capture('status', '--porcelain=v1', '--untracked-files=no')}

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--workers', type=int, default=2)
    parser.add_argument('--name', required=True)
    parser.add_argument('populations', nargs='+', choices=['interoperability', 'gallery', 'all'])
    args = parser.parse_args()
    pins = {'producer': identity(ROOT), 'consumer': identity(CONSUMER)}
    assert pins['producer']['revision'] == REVISION and not pins['producer']['trackedChanges']
    assert pins['consumer']['revision'] == CONSUMER_REVISION and not pins['consumer']['trackedChanges']
    assert sha(TOKENIZER) == '40fb9d7d7795b8bd305aeff39ce9963f3f450915b9553f2938e009be9a1fed60'
    overrides = {'PYTHONPATH': str(CONSUMER / 'src'), 'MEGATOKEN_NATIVE_SOURCE_PRODUCER': str(ROOT),
                 'MEGATOKEN_ROOT': str(CONSUMER), 'MEGATOKEN_TOKENIZER_JSON': str(TOKENIZER),
                 'MEGATOKEN_PYTHON': str(PYTHON), 'TMPDIR': '/workspace/scratch/35319cab5bbc/tmp',
                 'OMP_NUM_THREADS': '1', 'MKL_NUM_THREADS': '1'}
    env = {**os.environ, **overrides}
    runtime = subprocess.check_output([str(PYTHON), '-c',
        'import json,sys,tokenizers,megatoken;print(json.dumps({"python":sys.version,"tokenizers":tokenizers.__version__,"megatoken":megatoken.__file__}))'],
        cwd=ROOT, env=env, text=True)
    runtime = json.loads(runtime)
    assert Path(runtime['megatoken']).resolve().is_relative_to(CONSUMER.resolve()), runtime
    receipt = {'schema': 'semantic-v8-validation-run/1', 'startedAt': stamp(), 'status': 'running',
               'pinsBefore': pins, 'environmentOverrides': overrides, 'runtime': runtime,
               'tokenizer': {'path': str(TOKENIZER), 'sha256': sha(TOKENIZER), 'bytes': TOKENIZER.stat().st_size},
               'workers': args.workers, 'populations': args.populations, 'commands': [],
               'scope': 'Fresh source/native admission and exact token metering; no model run or default promotion.'}
    output = OUT / (args.name + '.json')
    def save():
        output.write_text(json.dumps(receipt, indent=2) + '\n')
    save()
    for population in args.populations:
        commands = [
            ('native-' + population, ['node', 'tools/qualify-semantic-v8.mjs', '--out', str(OUT / ('native-' + population)),
                '--population', population, '--inputs', 'all', '--workers', str(args.workers),
                '--megatoken', str(CONSUMER), '--tokenizer', str(TOKENIZER), '--python', str(PYTHON),
                '--native-policy', 'contracts/semantic-native-policy-v8.json']),
            ('costs-' + population, ['node', 'tools/measure-semantic-v8.mjs', '--qualification', str(OUT / ('native-' + population)),
                '--out', str(OUT / ('costs-' + population)), '--tokenizer-module', 'tools/semantic-v8-tokenizer-adapter.mjs']),
        ]
        for name, command in commands:
            row = {'name': name, 'command': command, 'cwd': str(ROOT), 'startedAt': stamp(), 'status': 'running'}
            receipt['commands'].append(row)
            save()
            print(json.dumps({'event': 'started', **row}), flush=True)
            start = time.monotonic()
            stdout, stderr = OUT / (name + '.stdout.log'), OUT / (name + '.stderr.log')
            with stdout.open('wb') as out, stderr.open('wb') as err:
                process = subprocess.run(command, cwd=ROOT, env=env, stdout=out, stderr=err)
            row.update({'finishedAt': stamp(), 'durationSeconds': time.monotonic() - start,
                        'exitCode': process.returncode, 'status': 'passed' if process.returncode == 0 else 'failed',
                        'stdout': {'path': stdout.name, 'sha256': sha(stdout), 'bytes': stdout.stat().st_size},
                        'stderr': {'path': stderr.name, 'sha256': sha(stderr), 'bytes': stderr.stat().st_size},
                        'pinsAfter': {'producer': identity(ROOT), 'consumer': identity(CONSUMER)}})
            report_path = OUT / name / 'report.json'
            if report_path.exists():
                row['report'] = {'path': str(report_path), 'sha256': sha(report_path)}
            save()
            print(json.dumps({'event': 'finished', 'name': name, 'status': row['status'],
                              'durationSeconds': row['durationSeconds'], 'exitCode': row['exitCode']}), flush=True)
    receipt['finishedAt'] = stamp()
    receipt['pinsAfter'] = {'producer': identity(ROOT), 'consumer': identity(CONSUMER)}
    receipt['identityUnchanged'] = receipt['pinsBefore'] == receipt['pinsAfter']
    receipt['status'] = 'passed' if all(row['status'] == 'passed' for row in receipt['commands']) and receipt['identityUnchanged'] else 'failed'
    save()
    print(json.dumps({'event': 'completed', 'status': receipt['status'], 'receipt': str(output)}), flush=True)
    return 0 if receipt['status'] == 'passed' else 1

if __name__ == '__main__':
    sys.exit(main())
