import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import time
import sys

ROOT = Path(sys.argv[1]).resolve()
OUT = Path(sys.argv[2]).resolve()
TMPDIR = Path('/workspace/scratch/754a49249d01/producer-validation-tmp')
REVISION = sys.argv[3]
OUT.mkdir(parents=True, exist_ok=True)
TMPDIR.mkdir(parents=True, exist_ok=True)

def stamp():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()

def capture(args):
    return subprocess.check_output(args, cwd=ROOT, text=True).strip()

def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def write(name, data):
    (OUT / name).write_text(json.dumps(data, indent=2, ensure_ascii=False) + '\n')

def identity():
    entries = []
    for line in capture(['git', 'ls-tree', 'HEAD']).splitlines():
        metadata, path = line.split('\t', 1)
        mode, kind, oid = metadata.split()
        entries.append({'path': path, 'mode': mode, 'kind': kind, 'oid': oid})
    return {
        'revision': capture(['git', 'rev-parse', 'HEAD']),
        'tree': capture(['git', 'rev-parse', 'HEAD^{tree}']),
        'trackedChanges': capture(['git', 'status', '--porcelain=v1', '--untracked-files=no']),
        'topLevelTreesAndBlobs': entries,
    }

before = identity()
assert before['revision'] == REVISION and not before['trackedChanges'], before
code_paths = ['src', 'test', 'tools', 'scripts', 'bin', 'fixtures', 'package.json', 'package-lock.json']
manifest = []
for line in capture(['git', 'ls-tree', '-r', 'HEAD', '--', *code_paths]).splitlines():
    metadata, path = line.split('\t', 1)
    mode, kind, oid = metadata.split()
    manifest.append({'path': path, 'mode': mode, 'kind': kind, 'oid': oid})
write('code-manifest.json', {'revision': REVISION, 'includedPaths': code_paths, 'files': manifest})
test_files = sorted(str(path.relative_to(ROOT)) for path in (ROOT / 'test').glob('*.test.js'))
write('test-files.json', test_files)

summary = {
    'schema': 'producer-regression-receipt/1',
    'scope': 'Full producer regression, generated-contract checks, and eight native reference-fixture checks; not source/native consumer admission.',
    'status': 'running',
    'startedAt': stamp(),
    'worktree': str(ROOT),
    'producerBefore': before,
    'node': {'version': capture(['node', '--version']), 'executable': capture(['node', '-p', 'process.execPath'])},
    'npmVersion': capture(['npm', '--version']),
    'environmentOverrides': {'TMPDIR': str(TMPDIR)},
    'codeManifest': {'path': 'code-manifest.json', 'sha256': digest(OUT / 'code-manifest.json'), 'files': len(manifest)},
    'testInventory': {'path': 'test-files.json', 'sha256': digest(OUT / 'test-files.json'), 'files': len(test_files)},
    'commands': [],
}
write('summary.json', summary)
environment = os.environ.copy()
environment['TMPDIR'] = str(TMPDIR)
commands = [
    ('unit', 'node --test --test-concurrency=4 test/*.test.js'),
    ('contracts', 'npm run contracts:check'),
    ('reference', 'node fixtures/reference/reference-fixture.mjs'),
]
overall_start = time.perf_counter()
for name, command in commands:
    stdout = OUT / (name + '.stdout.log')
    stderr = OUT / (name + '.stderr.log')
    row = {'name': name, 'command': command, 'cwd': str(ROOT), 'startedAt': stamp(), 'status': 'running'}
    summary['commands'].append(row)
    write('summary.json', summary)
    print(json.dumps({'event': 'started', **row}), flush=True)
    started = time.perf_counter()
    with stdout.open('wb') as out, stderr.open('wb') as err:
        process = subprocess.run(command, shell=True, executable='/bin/bash', cwd=ROOT, env=environment, stdout=out, stderr=err)
    row.update({'finishedAt': stamp(), 'durationSeconds': round(time.perf_counter() - started, 6), 'exitCode': process.returncode,
                'status': 'passed' if process.returncode == 0 else 'failed',
                'stdout': {'path': stdout.name, 'sha256': digest(stdout), 'bytes': stdout.stat().st_size},
                'stderr': {'path': stderr.name, 'sha256': digest(stderr), 'bytes': stderr.stat().st_size}})
    output = stdout.read_text(errors='replace')
    if name == 'unit':
        counts = {}
        for field in ('tests', 'suites', 'pass', 'fail', 'cancelled', 'skipped', 'todo'):
            found = re.findall(r'(?:ℹ|#)\s+' + field + r'\s+(\d+)', output)
            if found:
                counts[field] = int(found[-1])
        row['counts'] = counts
        row['failureLines'] = [line for line in output.splitlines() if line.startswith(('not ok ', '✖ '))]
        row['skipLines'] = [line for line in output.splitlines() if '# SKIP' in line or line.startswith('﹣ ')]
    elif name == 'reference':
        try:
            result = json.loads(output)
            row['counts'] = {'checks': len(result['passed']), 'passed': len(result['passed']), 'failed': 0}
            row['checks'] = result['passed']
            row['result'] = result['result']
        except (ValueError, KeyError, TypeError):
            row['counts'] = None
    else:
        row['checks'] = [
            'tools/generate-host-contract.mjs --check',
            'tools/generate-semantic-contract.mjs --check',
            'tools/generate-semantic-algorithm-contract.mjs --check',
            'tools/generate-semantic-execution-contract.mjs --check',
            'tools/generate-semantic-region-contract.mjs --check',
        ]
        row['counts'] = {'checks': 5, 'passed': 5 if process.returncode == 0 else None}
    row['producerAfter'] = identity()
    write('summary.json', summary)
    print(json.dumps({'event': 'finished', 'name': name, 'status': row['status'], 'exitCode': row['exitCode'],
                      'durationSeconds': row['durationSeconds'], 'counts': row.get('counts')}), flush=True)

summary['finishedAt'] = stamp()
summary['durationSeconds'] = round(time.perf_counter() - overall_start, 6)
summary['producerAfter'] = identity()
summary['identityUnchanged'] = summary['producerBefore'] == summary['producerAfter']
summary['status'] = 'passed' if all(row['status'] == 'passed' for row in summary['commands']) and summary['identityUnchanged'] else 'failed'
write('summary.json', summary)
print(json.dumps({'event': 'completed', 'status': summary['status'], 'durationSeconds': summary['durationSeconds'],
                  'identityUnchanged': summary['identityUnchanged'], 'summary': str(OUT / 'summary.json')}), flush=True)
