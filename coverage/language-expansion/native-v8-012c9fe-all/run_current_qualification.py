#!/usr/bin/env python3
"""Collect the final expansion and adopt independently completed same-pair populations before dataset admission."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import time


def stamp():
    return datetime.now(timezone.utc).isoformat()


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def identity(path):
    def git(*args):
        return subprocess.check_output(['git', '-C', str(path), *args], text=True).strip()
    return {'path': str(path), 'revision': git('rev-parse', 'HEAD'),
            'tree': git('rev-parse', 'HEAD^{tree}'),
            'trackedChanges': git('status', '--porcelain=v1', '--untracked-files=no'),
            'untrackedChanges': git('ls-files', '--others', '--exclude-standard')}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ['producer', 'consumer', 'python', 'tokenizer', 'output']:
        parser.add_argument('--' + name, required=True, type=Path)
    for name in ['producer-revision', 'consumer-revision']:
        parser.add_argument('--' + name, required=True)
    parser.add_argument('--independent-populations', required=True, type=Path)
    parser.add_argument('--workers', type=int, default=4)
    args = parser.parse_args()
    root, consumer, python, tokenizer, out = [getattr(args, key).resolve()
                                             for key in ['producer', 'consumer', 'python', 'tokenizer', 'output']]
    # Keep the venv launcher path: resolving its symlink can select the base
    # interpreter and silently bypass the locked native dependencies.
    python = args.python.absolute()
    helpers = Path(__file__).resolve().parent
    require(not out.exists(), 'Evidence output must be new')
    require(1 <= args.workers <= 16, 'Worker count')
    pins = {'producer': identity(root), 'consumer': identity(consumer)}
    require(pins['producer']['revision'] == args.producer_revision and not pins['producer']['trackedChanges'] and
            not pins['producer']['untrackedChanges'], 'Exact clean producer')
    require(pins['consumer']['revision'] == args.consumer_revision and not pins['consumer']['trackedChanges'] and
            not pins['consumer']['untrackedChanges'], 'Exact clean consumer')
    policy = json.loads((root / 'contracts/semantic-native-policy-v8.json').read_bytes())
    require(policy['consumerRevision'] == args.consumer_revision, 'Producer policy consumer pin')
    require(sha(tokenizer) == policy['tokenizerSha256'], 'Exact tokenizer bytes')
    out.mkdir()
    (out / 'tmp').mkdir()
    dataset = out / ('v8-dataset-' + args.producer_revision[:7])
    overrides = {'TRACING_JS_SELF_ROOT': str(root), 'MEGATOKEN_NATIVE_SOURCE_PRODUCER': str(root),
                 'MEGATOKEN_ROOT': str(consumer), 'MEGATOKEN_PYTHON': str(python),
                 'PYTHONPATH': str(consumer / 'src'), 'MEGATOKEN_TOKENIZER_JSON': str(tokenizer),
                 'SEMANTIC_V8_NATIVE_POLICY': str(root / 'contracts/semantic-native-policy-v8.json'),
                 'V8_DATASET_CAPTURE': str(dataset / 'native-inputs'), 'TMPDIR': str(out / 'tmp'),
                 'OMP_NUM_THREADS': '1', 'MKL_NUM_THREADS': '1'}
    env = {**os.environ, **overrides}
    runtime = json.loads(subprocess.check_output([str(python), '-c',
        'import sys,json,tokenizers,megatoken;print(json.dumps({"python":sys.version,"tokenizers":tokenizers.__version__,"megatoken":megatoken.__file__}))'],
        env=env, text=True))
    runtime['node'] = subprocess.check_output(['node', '--version'], env=env, text=True).strip()
    require(Path(runtime['megatoken']).resolve().is_relative_to(consumer), 'Consumer import routing')
    receipt = {'schema': 'semantic-v8-current-qualification-run/1', 'status': 'running', 'startedAt': stamp(),
               'pinsBefore': pins, 'environmentOverrides': overrides, 'runtime': runtime,
               'tokenizer': {'path': str(tokenizer), 'sha256': sha(tokenizer), 'bytes': tokenizer.stat().st_size},
               'workers': args.workers, 'commands': [],
               'scope': 'Fresh expansion source/native admission and exact costs; same-pair interoperability/gallery executed independently and adopted by exact hash checks; fresh combined split-bound dataset. Zero optimizer steps, no model or serving claim.'}

    def save():
        (out / 'run.json').write_text(json.dumps(receipt, indent=2) + '\n')

    def run(name, command, stdout_name=None):
        row = {'name': name, 'command': [str(part) for part in command], 'cwd': str(root),
               'startedAt': stamp(), 'status': 'running'}
        receipt['commands'].append(row)
        save()
        print(json.dumps({'event': 'started', 'name': name}), flush=True)
        stdout, stderr = out / (stdout_name or (name + '.stdout.log')), out / (name + '.stderr.log')
        started = time.monotonic()
        with stdout.open('wb') as output, stderr.open('wb') as errors:
            completed = subprocess.run(row['command'], cwd=root, env=env, stdout=output, stderr=errors)
        row.update({'finishedAt': stamp(), 'durationSeconds': time.monotonic() - started,
                    'exitCode': completed.returncode, 'status': 'passed' if completed.returncode == 0 else 'failed',
                    'pinsAfter': {'producer': identity(root), 'consumer': identity(consumer)}})
        for key, path in [('stdout', stdout), ('stderr', stderr)]:
            row[key] = {'path': path.name, 'sha256': sha(path), 'bytes': path.stat().st_size}
        save()
        print(json.dumps({'event': 'finished', 'name': name, 'status': row['status'], 'durationSeconds': row['durationSeconds']}), flush=True)
        require(row['pinsAfter'] == pins, 'Source identity changed during ' + name)
        require(completed.returncode == 0, name + ' failed; retain logs and failure dispositions')

    try:
        save()
        for population in ['all']:
            qualified, costs = out / ('native-' + population), out / ('costs-' + population)
            run('native-' + population, ['node', 'tools/qualify-semantic-v8.mjs', '--out', qualified,
                '--population', population, '--inputs', 'all', '--workers', args.workers,
                '--megatoken', consumer, '--tokenizer', tokenizer, '--python', python,
                '--native-policy', 'contracts/semantic-native-policy-v8.json'])
            qualification = json.loads((qualified / 'report.json').read_bytes())
            require(qualification['declared'] == qualification['sourceQualified'] == qualification['nativeAdmitted'],
                    'Incomplete ' + population + ' qualification')
            run('costs-' + population, ['node', 'tools/measure-semantic-v8.mjs', '--qualification', qualified,
                '--out', costs, '--tokenizer-module', 'tools/semantic-v8-tokenizer-adapter.mjs'])
            cost = json.loads((costs / 'report.json').read_bytes())
            require(cost['summary']['flat']['tokenMeasuredEpisodes'] == qualification['declared'] and
                    cost['summary']['nativePacking']['measuredEpisodes'] == qualification['declared'],
                    'Incomplete ' + population + ' physical token measurement')
            run('retain-inputs-' + population, ['node', helpers / 'retain-native-inputs.mjs', qualified])
        for population in ['interoperability', 'gallery']:
            run('adopt-' + population, [python, helpers / 'adopt_current_populations.py',
                '--qualification', args.independent_populations / population,
                '--costs', args.independent_populations / (population + '-costs'),
                '--output', out, '--population', population, '--producer', root,
                '--producer-revision', args.producer_revision, '--consumer-revision', args.consumer_revision])
        independent_receipts = out / 'independent-population-runs'
        independent_receipts.mkdir()
        for path in sorted(args.independent_populations.iterdir()):
            if path.is_file():
                shutil.copyfile(path, independent_receipts / path.name)
        receipt['independentPopulationRuns'] = {
            'source': str(args.independent_populations),
            'files': [{'path': str(path.relative_to(out)), 'bytes': path.stat().st_size, 'sha256': sha(path)}
                      for path in sorted(independent_receipts.iterdir()) if path.is_file()]}
        save()
        run('reference', ['node', 'tools/language-expansion-benchmark.mjs', '--out', out / 'reference',
            '--mode', 'reference', '--trace-version', '8', '--population', 'all', '--inputs', 'all'])
        baseline = out / 'historical-costs'
        baseline.mkdir()
        baseline_archive = root / 'coverage/language-expansion/baseline-token-costs-135bd1f/artifacts.tar.xz'
        baseline_index = json.loads(baseline_archive.with_name('archive.json').read_bytes())['archive']
        require(sha(baseline_archive) == baseline_index['sha256'], 'Historical cost archive bytes')
        with tarfile.open(baseline_archive, 'r:xz') as archive:
            archive.extractall(baseline, filter='data')
        for item in baseline_index['files']:
            path = baseline / item['name']
            require(path.stat().st_size == item['bytes'] and sha(path) == item['sha256'],
                    'Historical cost member bytes: ' + item['name'])
        comparison_inputs = {'schema': 'semantic-cost-comparison-inputs/1', 'populations': [
            {'id': population, 'costs': 'costs-' + population, 'qualification': 'native-' + population}
            for population in ['all', 'gallery', 'interoperability']]}
        (out / 'comparison-inputs.json').write_text(json.dumps(comparison_inputs, indent=2) + '\n')
        run('comparison', ['node', 'tools/compare-serving-costs.mjs', '--before', baseline,
            '--after-manifest', out / 'comparison-inputs.json', '--out', out / 'paired-serving-costs.json'])
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
        shutil.copyfile(Path(__file__), dataset / Path(__file__).name)
        receipt['status'] = 'passed'
    except BaseException as error:
        receipt['status'], receipt['failure'] = 'failed', str(error)
        raise
    finally:
        receipt['finishedAt'] = stamp()
        receipt['pinsAfter'] = {'producer': identity(root), 'consumer': identity(consumer)}
        receipt['identityUnchanged'] = receipt['pinsAfter'] == pins
        save()
        print(json.dumps({'event': 'completed', 'status': receipt['status'], 'output': str(out)}), flush=True)


if __name__ == '__main__':
    main()
