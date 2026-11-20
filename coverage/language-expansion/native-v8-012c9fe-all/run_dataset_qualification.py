#!/usr/bin/env python3
"""Independently admit a split-bound dataset from completed exact-pair source populations."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import time

from run_current_qualification import identity, require, stamp


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


parser = argparse.ArgumentParser(description=__doc__)
for name in ['producer', 'consumer', 'python', 'tokenizer', 'output', 'independent-populations']:
    parser.add_argument('--' + name, required=True, type=Path)
for name in ['producer-revision', 'consumer-revision']:
    parser.add_argument('--' + name, required=True)
args = parser.parse_args()
root, consumer, tokenizer, out = [getattr(args, key).resolve() for key in ['producer', 'consumer', 'tokenizer', 'output']]
python = args.python.absolute()
helpers = Path(__file__).resolve().parent
require(not out.exists(), 'Dataset evidence output must be new')
pins = {'producer': identity(root), 'consumer': identity(consumer)}
require(pins['producer']['revision'] == args.producer_revision and pins['consumer']['revision'] == args.consumer_revision, 'Exact pins')
require(all(not row['trackedChanges'] and not row['untrackedChanges'] for row in pins.values()), 'Clean checkouts')
policy = json.loads((root / 'contracts/semantic-native-policy-v8.json').read_bytes())
require(policy['consumerRevision'] == args.consumer_revision and policy['tokenizerSha256'] == sha(tokenizer), 'Committed native policy')
out.mkdir()
(out / 'tmp').mkdir()
dataset = out / ('v8-dataset-' + args.producer_revision[:7])
overrides = {'TRACING_JS_SELF_ROOT': str(root), 'MEGATOKEN_NATIVE_SOURCE_PRODUCER': str(root),
    'MEGATOKEN_ROOT': str(consumer), 'MEGATOKEN_PYTHON': str(python), 'PYTHONPATH': str(consumer / 'src'),
    'MEGATOKEN_TOKENIZER_JSON': str(tokenizer), 'SEMANTIC_V8_NATIVE_POLICY': str(root / 'contracts/semantic-native-policy-v8.json'),
    'V8_DATASET_CAPTURE': str(dataset / 'native-inputs'), 'TMPDIR': str(out / 'tmp'), 'OMP_NUM_THREADS': '1', 'MKL_NUM_THREADS': '1'}
env = {**os.environ, **overrides}
runtime = json.loads(subprocess.check_output([str(python), '-c',
    'import sys,json,tokenizers,megatoken;print(json.dumps({"python":sys.version,"tokenizers":tokenizers.__version__,"megatoken":megatoken.__file__}))'], env=env, text=True))
runtime['node'] = subprocess.check_output(['node', '--version'], text=True).strip()
require(Path(runtime['megatoken']).resolve().is_relative_to(consumer), 'Native module routing')
receipt = {'schema': 'semantic-v8-independent-dataset-run/1', 'status': 'running', 'startedAt': stamp(),
    'pinsBefore': pins, 'environmentOverrides': overrides, 'runtime': runtime, 'commands': [],
    'tokenizer': {'path': str(tokenizer), 'bytes': tokenizer.stat().st_size, 'sha256': sha(tokenizer)},
    'nativeExportWorkers': 1, 'scope': 'Independent fresh native dataset admission after frozen component splits, using completed exact-pair source/native populations. Runs in parallel with expansion qualification. No optimization or model execution.'}


def save():
    (out / 'run.json').write_text(json.dumps(receipt, indent=2) + '\n')


def run(name, command, stdout_name=None):
    row = {'name': name, 'command': [str(value) for value in command], 'cwd': str(root), 'startedAt': stamp(), 'status': 'running'}
    receipt['commands'].append(row)
    save()
    print(json.dumps({'event': 'started', 'name': name}), flush=True)
    stdout, stderr = out / (stdout_name or name + '.stdout.log'), out / (name + '.stderr.log')
    start = time.monotonic()
    with stdout.open('wb') as output, stderr.open('wb') as errors:
        result = subprocess.run(row['command'], cwd=root, env=env, stdout=output, stderr=errors)
    row.update({'finishedAt': stamp(), 'durationSeconds': time.monotonic() - start, 'exitCode': result.returncode,
        'status': 'passed' if result.returncode == 0 else 'failed', 'pinsAfter': {'producer': identity(root), 'consumer': identity(consumer)}})
    for key, path in [('stdout', stdout), ('stderr', stderr)]:
        row[key] = {'path': path.name, 'bytes': path.stat().st_size, 'sha256': sha(path)}
    save()
    print(json.dumps({'event': 'finished', 'name': name, 'status': row['status'], 'seconds': row['durationSeconds']}), flush=True)
    require(row['pinsAfter'] == pins, 'Changed identity during ' + name)
    require(result.returncode == 0, name + ' failed')


try:
    save()
    for population in ['interoperability', 'gallery']:
        run('adopt-' + population, [python, helpers / 'adopt_current_populations.py',
            '--qualification', args.independent_populations / population, '--costs', args.independent_populations / (population + '-costs'),
            '--output', out, '--population', population, '--producer', root,
            '--producer-revision', args.producer_revision, '--consumer-revision', args.consumer_revision])
    independent = out / 'independent-population-runs'
    independent.mkdir()
    for path in sorted(args.independent_populations.iterdir()):
        if path.is_file():
            shutil.copyfile(path, independent / path.name)
    receipt['independentPopulationRuns'] = {'source': str(args.independent_populations),
        'files': [{'path': str(path.relative_to(out)), 'bytes': path.stat().st_size, 'sha256': sha(path)} for path in sorted(independent.iterdir())]}
    save()
    run('dataset-prepare', ['node', helpers / 'prepare-v8-dataset.mjs', root, dataset,
        out / 'native-interoperability', out / 'native-gallery'])
    for name in ['prepare-v8-dataset.mjs', 'v8-native-capture.mjs']:
        shutil.copyfile(helpers / name, dataset / name)
    run('dataset-export', ['node', 'tools/export-semantic-v8.mjs', '--input', dataset / 'candidates.jsonl',
        '--tokenizer-module', 'tools/semantic-v8-tokenizer-adapter.mjs', '--native-module', dataset / 'v8-native-capture.mjs',
        '--max-context', '1048576', '--max-examples', '4096', '--seed', '17', '--out', dataset / 'dataset'])
    run('dataset-verify', [python, helpers / 'verify.py', dataset, '--producer-revision', args.producer_revision,
        '--consumer-revision', args.consumer_revision, '--codec-source', consumer / 'src/megatoken/generation/codec.py',
        '--tokenizer-json', tokenizer], 'dataset-verification.json')
    run('dataset-check-inputs', [python, helpers / 'verify-qualification-inputs.py', dataset,
        '--qualification', out / 'native-interoperability', '--qualification', out / 'native-gallery',
        '--producer-revision', args.producer_revision, '--consumer-revision', args.consumer_revision], 'dataset-input-check.json')
    for path in out.glob('dataset-*.log'):
        shutil.copyfile(path, dataset / path.name)
    for name in ['run_dataset_qualification.py', 'run_current_qualification.py', 'adopt_current_populations.py']:
        shutil.copyfile(helpers / name, dataset / name)
    receipt['status'] = 'passed'
except BaseException as error:
    receipt['status'], receipt['failure'] = 'failed', str(error)
    raise
finally:
    receipt['finishedAt'] = stamp()
    receipt['pinsAfter'] = {'producer': identity(root), 'consumer': identity(consumer)}
    receipt['identityUnchanged'] = receipt['pinsAfter'] == pins
    save()
    if dataset.exists():
        shutil.copyfile(out / 'run.json', dataset / 'run.json')
    print(json.dumps({'event': 'completed', 'status': receipt['status'], 'output': str(out)}), flush=True)
