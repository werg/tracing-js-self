"""Run real Promise checks without claiming the unavailable recovery attestation."""
import importlib.metadata
import importlib.util
import json
import os
from pathlib import Path
import platform
import re
import subprocess
import sys
from types import SimpleNamespace

base = Path('/workspace/scratch/65ba865519f3')
producer = base / 'tracing-js-self-issue61-qualified'
native = base / 'megatoken-issue61-qualified'
out = base / 'issue61-evidence/paired-promise-local'
out.mkdir(parents=True, exist_ok=True)
policy = base / 'issue61-evidence/paired-promise-policy.json'
producer_revision = '65ce0796569bb6ecf71441dc78f7ce491a322898'
native_revision = 'fb82c671276a1b68404ad14b8fcafc3b390b4c69'
spec = importlib.util.spec_from_file_location('gate', producer / 'tools/verify-combined-v8-gate.py')
gate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate)
pair = gate.identity(producer, native, producer_revision, native_revision, policy)
environment = gate.read(producer / 'profiles/release-environment.lock.json')
node = subprocess.check_output(['node', '--version'], text=True).strip().removeprefix('v')
gate.require(platform.python_version() == environment['python'], 'Python differs from lock')
gate.require(node == environment['node'] == (producer / '.nvmrc').read_text().strip(), 'Node differs from lock')
lock = producer / 'tools/native-consumer/requirements.lock'
expected = dict(re.findall(r'^([A-Za-z0-9_.-]+)==([^\s\\]+)', lock.read_text(), re.M))
packages = {name: importlib.metadata.version(name) for name in expected}
gate.require(packages == expected, 'Dependency versions differ from hashed lock')
for suffix in ('', '.resolution.json'):
    target = out / ('semantic-native-policy-v8.json' + suffix)
    with target.open('xb') as stream:
        stream.write(Path(str(policy) + suffix).read_bytes())
gate.retained_policy(out, policy)
receipt = {
    'schema': 'issue61-local-promise-checks/1',
    'pair': pair,
    'completeCombinedGate': 'not-qualified',
    'strictAttestation': 'blocked: /proc/self/ns/time is not exposed in this workspace',
    'kernelTimeNamespaceAvailable': Path('/proc/self/ns/time').is_symlink(),
    'runtime': {'node': node, 'python': platform.python_version(), 'packages': packages,
                'requirementsLockSha256': gate.sha(lock)},
    'payloads': gate.payload_parity(producer, native),
    'installed': gate.installed_consumer(producer, native, True),
}
gate.write(out / 'installed-replay.json', receipt)
print(json.dumps({'installedSourceCases': len(receipt['installed']['sourceReceipts']),
                  'completeCombinedGate': receipt['completeCombinedGate']}), flush=True)
args = SimpleNamespace(producer=producer, native=native, out=out, native_policy=policy)
env = gate.lane_environment(args)
results = {}
for kind in ('native', 'producer'):
    files = gate.SPEC['lanes']['promise'][kind]
    xml = out / (kind + '.xml')
    if kind == 'native':
        argv = [sys.executable, '-m', 'pytest', '-q', *files,
                '--junitxml=' + str(xml), '--basetemp=' + str(out / 'pytest')]
    else:
        argv = ['node', '--experimental-vm-modules', '--test', '--test-concurrency=1',
                '--test-timeout=600000', '--test-reporter=spec', '--test-reporter-destination=stdout',
                '--test-reporter=junit', '--test-reporter-destination=' + str(xml), *files]
    gate.command(argv, native if kind == 'native' else producer, out / (kind + '.log'), env)
    results[kind] = gate.verify_junit(xml, kind, files)
packets = gate.verify_promise_packets(out)
gate.require(pair == gate.identity(producer, native, producer_revision, native_revision, policy),
             'Exact pair changed during execution')
gate.retained_policy(out, policy)
gate.write(out / 'local-promise-result.json', {
    'schema': 'issue61-local-promise-result/1', 'pair': pair, 'promiseTests': results,
    'sourcePopulations': packets, 'installedReplaySha256': gate.sha(out / 'installed-replay.json'),
    'completeCombinedGate': 'not-qualified', 'strictAttestation': receipt['strictAttestation'],
    'moduleAdmission': False, 'trainingAdmission': False, 'optimizerUpdates': 0,
})
print(json.dumps({'promiseTests': results, 'completeCombinedGate': 'not-qualified'}), flush=True)
