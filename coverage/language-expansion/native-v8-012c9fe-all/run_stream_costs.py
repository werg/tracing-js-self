#!/usr/bin/env python3
"""Run one immutable-artifact token meter with explicit clean-pin command evidence."""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import time
from run_current_qualification import identity, require, sha, stamp


parser = argparse.ArgumentParser(description=__doc__)
for name in ['producer', 'consumer', 'python', 'tokenizer', 'qualification', 'output']:
    parser.add_argument('--' + name, type=Path, required=True)
args = parser.parse_args()
producer, consumer, qualification, out = [getattr(args, key).resolve() for key in ['producer', 'consumer', 'qualification', 'output']]
python, tokenizer = args.python.absolute(), args.tokenizer.resolve()
receipt_root = out.with_name(out.name + '-run')
receipt_root.mkdir(exist_ok=False)
(receipt_root / 'tmp').mkdir()
pins = {'producer': identity(producer), 'consumer': identity(consumer)}
require(all(not p['trackedChanges'] and not p['untrackedChanges'] for p in pins.values()), 'Clean pins')
policy = json.loads((producer / 'contracts/semantic-native-policy-v8.json').read_bytes())
require(policy['consumerRevision'] == pins['consumer']['revision'] and sha(tokenizer) == policy['tokenizerSha256'], 'Exact policy')
helper = Path(__file__).with_name('stream_qualification_costs.mjs')
shutil.copyfile(helper, receipt_root / helper.name)
shutil.copyfile(__file__, receipt_root / Path(__file__).name)
command = ['node', str(receipt_root / helper.name), str(producer), str(qualification), str(out)]
overrides = {'TRACING_JS_SELF_ROOT': str(producer), 'MEGATOKEN_NATIVE_SOURCE_PRODUCER': str(producer),
    'MEGATOKEN_ROOT': str(consumer), 'MEGATOKEN_PYTHON': str(python), 'PYTHONPATH': str(consumer / 'src'),
    'MEGATOKEN_TOKENIZER_JSON': str(tokenizer), 'SEMANTIC_V8_NATIVE_POLICY': str(producer / 'contracts/semantic-native-policy-v8.json'),
    'TMPDIR': str(receipt_root / 'tmp'), 'OMP_NUM_THREADS': '1', 'MKL_NUM_THREADS': '1'}
env = {**os.environ, **overrides}
receipt = {'schema': 'semantic-v8-stream-cost-command/1', 'status': 'running', 'startedAt': stamp(),
    'pinsBefore': pins, 'command': command, 'cwd': str(producer), 'environmentOverrides': overrides,
    'helperSha256': sha(receipt_root / helper.name), 'tokenizerSha256': sha(tokenizer),
    'meterWorkers': 1, 'sourceAdmissionsPerformed': 0, 'nativeAdmissionsPerformed': 0}
(receipt_root / 'run.json').write_text(json.dumps(receipt, indent=2) + '\n')
start = time.monotonic()
stdout, stderr = receipt_root / 'stdout.log', receipt_root / 'stderr.log'
try:
    with stdout.open('wb') as output, stderr.open('wb') as errors:
        result = subprocess.run(command, cwd=producer, env=env, stdout=output, stderr=errors)
    receipt['exitCode'] = result.returncode
    require(result.returncode == 0, 'Streaming meter failed; preserve original error and partial cost journal')
    stream = json.loads((out / 'stream-run.json').read_bytes())
    require(stream['status'] == 'passed', 'Complete cost measurement')
    receipt['streamReceiptSha256'] = sha(out / 'stream-run.json')
    receipt['normalReportSha256'] = sha(out / 'costs/report.json')
    receipt['status'] = 'passed'
except BaseException as error:
    receipt['status'], receipt['failure'] = 'failed', str(error)
    raise
finally:
    receipt['durationSeconds'] = time.monotonic() - start
    receipt['finishedAt'] = stamp()
    receipt['pinsAfter'] = {'producer': identity(producer), 'consumer': identity(consumer)}
    receipt['identityUnchanged'] = receipt['pinsAfter'] == pins
    if not receipt['identityUnchanged']:
        receipt['status'] = 'failed'
    for key, path in [('stdout', stdout), ('stderr', stderr)]:
        if path.exists():
            receipt[key] = {'path': path.name, 'bytes': path.stat().st_size, 'sha256': sha(path)}
    (receipt_root / 'run.json').write_text(json.dumps(receipt, indent=2) + '\n')
    print(json.dumps({'output': str(out), 'receipt': str(receipt_root / 'run.json'), 'status': receipt['status'], 'seconds': receipt['durationSeconds']}), flush=True)
