"""Retain an independently executed reference benchmark at the frozen producer."""

import datetime
import hashlib
import json
import os
from pathlib import Path
import subprocess
import time

WORKSPACE = Path('/workspace/scratch/754a49249d01')
ROOT = WORKSPACE / 'qualification-producer-012c9fe'
OUT = WORKSPACE / 'qualification-reference-012c9fe'
RECEIPT = WORKSPACE / 'qualification-reference-012c9fe-run'
REVISION = '012c9fe49a082319bf98ac0c571596da925741a4'
COMMAND = ['node', 'tools/language-expansion-benchmark.mjs', '--out', str(OUT),
           '--mode', 'reference', '--trace-version', '8', '--population', 'all', '--inputs', 'all']


def stamp():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def capture(args):
    return subprocess.check_output(args, cwd=ROOT, text=True).strip()


def identity():
    return {'revision': capture(['git', 'rev-parse', 'HEAD']),
            'tree': capture(['git', 'rev-parse', 'HEAD^{tree}']),
            'statusPorcelain': capture(['git', 'status', '--porcelain=v1'])}


def file_identity(path, base):
    return {'path': str(path.relative_to(base)), 'bytes': path.stat().st_size,
            'sha256': hashlib.sha256(path.read_bytes()).hexdigest()}


def save(data):
    (RECEIPT / 'run.json').write_text(json.dumps(data, indent=2) + '\n')


assert not OUT.exists(), f'Output already exists: {OUT}'
assert not RECEIPT.exists(), f'Receipt already exists: {RECEIPT}'
RECEIPT.mkdir(parents=True)
before = identity()
assert before['revision'] == REVISION and before['statusPorcelain'] == '', before
runtime = json.loads(capture(['node', '-p',
    'JSON.stringify({node:process.version,v8:process.versions.v8,executable:process.execPath,'
    'timeZone:Intl.DateTimeFormat().resolvedOptions().timeZone})']))
run = {'schema': 'frozen-reference-benchmark-run/1',
       'scope': 'Independently execute the complete reference benchmark; no model responses, '
                'optimizer steps, native consumer admission, or token costs are claimed.',
       'status': 'running', 'startedAt': stamp(), 'command': COMMAND, 'cwd': str(ROOT),
       'outputDirectory': str(OUT), 'producerBefore': before, 'runtime': runtime,
       'environmentOverrides': {},
       'runner': file_identity(Path(__file__), Path(__file__).parent)}
save(run)
print(json.dumps({'event': 'started', 'receipt': str(RECEIPT / 'run.json'),
                  'command': COMMAND, 'producer': before}), flush=True)
start = time.perf_counter()
stdout = RECEIPT / 'stdout.log'
stderr = RECEIPT / 'stderr.log'
with stdout.open('wb') as out, stderr.open('wb') as err:
    process = subprocess.run(COMMAND, cwd=ROOT, env=os.environ.copy(), stdout=out, stderr=err)
run.update({'finishedAt': stamp(), 'durationSeconds': time.perf_counter() - start,
            'exitCode': process.returncode, 'producerAfter': identity(),
            'stdout': file_identity(stdout, RECEIPT), 'stderr': file_identity(stderr, RECEIPT),
            'outputFiles': [file_identity(path, OUT) for path in sorted(OUT.rglob('*'))
                            if path.is_file()]})
run['identityUnchanged'] = run['producerBefore'] == run['producerAfter']
run['status'] = 'passed' if process.returncode == 0 and run['identityUnchanged'] else 'failed'
save(run)
print(json.dumps({'event': 'completed', 'status': run['status'], 'exitCode': process.returncode,
                  'durationSeconds': run['durationSeconds'], 'identityUnchanged': run['identityUnchanged'],
                  'files': len(run['outputFiles']), 'receipt': str(RECEIPT / 'run.json')}), flush=True)
raise SystemExit(0 if run['status'] == 'passed' else 1)
