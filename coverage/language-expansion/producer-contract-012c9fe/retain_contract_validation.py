#!/usr/bin/env python3
"""Retain the failed exact-contract targeted run and its separately scoped timing follow-up."""
import argparse
import hashlib
import json
import re
import shutil
import subprocess
from pathlib import Path


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--base', type=Path, required=True)
parser.add_argument('--repository', type=Path, required=True)
parser.add_argument('--output', type=Path, required=True)
args = parser.parse_args()
original = args.base / 'final-validation/producer-contract-012c9fe'
receipt = json.loads((original / 'summary.json').read_bytes())
assert receipt['status'] == 'failed' and receipt['identityUnchanged']
assert receipt['producerBefore'] == receipt['producerAfter']
assert receipt['producerBefore']['revision'] == '012c9fe49a082319bf98ac0c571596da925741a4'
unit = next(row for row in receipt['commands'] if row['name'] == 'unit')
contract = next(row for row in receipt['commands'] if row['name'] == 'contracts')
assert unit['counts'] == {'tests': 44, 'suites': 0, 'pass': 42, 'fail': 1, 'cancelled': 1, 'skipped': 0, 'todo': 0}
assert unit['exitCode'] == 1 and contract['exitCode'] == 0 and contract['counts'] == {'checks': 5, 'passed': 5}
assert receipt['testInventory']['files'] == 6
for row in receipt['commands']:
    assert row['producerAfter'] == receipt['producerBefore']
    for name in ['stdout', 'stderr']:
        log = original / row[name]['path']
        assert log.stat().st_size == row[name]['bytes'] and sha(log) == row[name]['sha256']
for name in ['codeManifest', 'testInventory']:
    assert sha(original / receipt[name]['path']) == receipt[name]['sha256']
fixed_log = args.base / 'final-validation/serving-deadline-regressions.log'
text = fixed_log.read_text()
counts = {}
for name in ['tests', 'suites', 'pass', 'fail', 'cancelled', 'skipped', 'todo']:
    found = re.findall(r'(?:ℹ|#) ' + name + r' (\d+)', text)
    assert len(found) == 1, (name, found)
    counts[name] = int(found[0])
assert counts == {'tests': 24, 'suites': 0, 'pass': 24, 'fail': 0, 'cancelled': 0, 'skipped': 0, 'todo': 0}
duration = re.findall(r'(?:ℹ|#) duration_ms ([\d.]+)', text)
assert len(duration) == 1
revision = 'c0524b444e8ab8db2a3c1d6b06e5f64327bf77ca'
changed = subprocess.check_output(['git', '-C', str(args.repository), 'diff-tree', '--no-commit-id', '--name-only', '-r', revision], text=True).splitlines()
assert changed == ['test/semantic-native-process-v8.test.js', 'test/semantic-selected-execution-v8.test.js']
fixed = {'schema': 'semantic-v8-timing-followup/1', 'status': 'passed', 'counts': counts,
    'durationSeconds': float(duration[0]) / 1000,
    'command': 'node --test --test-concurrency=2 test/semantic-native-process-v8.test.js test/semantic-selected-execution-v8.test.js',
    'cwd': str(args.base / 'tracing-js-self'), 'log': {'path': 'deadline-followup.log', 'bytes': fixed_log.stat().st_size, 'sha256': sha(fixed_log)},
    'identity': {'kind': 'coordinator-reported-working-tree', 'subsequentCommit': revision,
        'instrumentedCleanBeforeAfter': False,
        'scope': 'The coordinator reports execution in the primary checkout containing the two-file deadline patch subsequently published at this commit. This is not automatic exact-commit certification.'},
    'changedFiles': changed,
    'scope': 'Two affected test files only. This does not relabel the earlier six-file failure as a passing run and is not a full producer regression.'}
out = args.output
out.mkdir(exist_ok=False)
shutil.copytree(original, out / 'original-012c9fe')
shutil.copyfile(fixed_log, out / 'deadline-followup.log')
shutil.copyfile(__file__, out / Path(__file__).name)
(out / 'deadline-followup.json').write_text(json.dumps(fixed, indent=2) + '\n')
(out / 'README.md').write_text(f'''# Final-contract source checks and timing follow-up

The instrumented targeted run at exact producer
`012c9fe49a082319bf98ac0c571596da925741a4` **did not pass**: its six selected
test files recorded **42 passes, one failure and one cancellation**, with no
skips, out of44 tests. All **five generated-contract checks passed** at the
same clean, unchanged source identity. The original failed receipt and logs are
retained unchanged under [original-012c9fe](original-012c9fe/summary.json).

The subsequent deadline-harness follow-up passed **24/24 tests**, with zero
failures, cancellations or skips, in {fixed['durationSeconds']:.3f} seconds.
Its identity is **coordinator-reported**, not an instrumented clean-commit run:
the primary checkout contained the two-file patch later published as
`{revision}`. [deadline-followup.json](deadline-followup.json) retains that
distinction, the exact command and the original log hash.

## Original scope and failures

The six selected files cover causal serialization, native process transport,
ordinary completion source behavior, custom iterator source behavior, flat
iterable-binding source behavior and selected execution. The original runner's
scope string says all fixture consumers; the actual retained six-file inventory
is authoritative and is **not exhaustive fixture-consumer coverage**.

The malformed-UTF-8/deadline transport test failed while its fake server was
still initializing under contention. The selected-execution callback test was
cancelled by its outer test timeout during preparation. Their original failure
messages and stack traces remain in `unit.stdout.log`; no candidate semantic
pass is inferred from either failed check.

The later patch makes the request deadline deterministic after real server
initialization by advancing a mocked monotonic clock, and gives the callback
test a30-second outer preparation budget while retaining its one-second
execution deadline. It changes only the two test files listed in the follow-up
receipt. Production execution and deadline behavior are unchanged by that patch.

## Separately executed follow-up

```sh
{fixed['command']}
```

[deadline-followup.log](deadline-followup.log) contains the original24 passing
results. Those tests overlap the earlier six-file selection, so their counts
must not be added to create a combined test denominator. The passing follow-up
does not turn the original44-test run into44 passes, and neither is presented
as the complete producer regression. The [complete9d regression](../producer-regression-9d4f6b3/README.md)
and later hosted current-tree CI retain their own exact scopes.

The final-contract665/26/11 source/native populations and244-test native
component suite are independent gates. This package retains source tests and
contract generation, not native admission or model execution.

## Integrity

`SHA256SUMS` covers every copied original file, the separate follow-up log and
receipt, and the packaging helper. The helper checked all original command-log
hashes, code/test inventory hashes, unchanged identities, exact numeric results
and the two-file patch inventory. These integrity checks do not rerun tests.
'''.replace('out of44', 'out of 44').replace('a30-second', 'a 30-second').replace('original24', 'original 24').replace('original44-test', 'original 44-test').replace('into44', 'into 44').replace('complete9d', 'complete 9d').replace('final-contract665/26/11', 'final-contract 665/26/11').replace('and244-test', 'and 244-test'))
(out / 'SHA256SUMS').write_text(''.join(sha(path) + '  ' + path.relative_to(out).as_posix() + '\n'
                                      for path in sorted(out.rglob('*')) if path.is_file() and path.name != 'SHA256SUMS'))
print(json.dumps({'output': str(out), 'originalCounts': unit['counts'], 'contracts': contract['counts'],
                  'followupCounts': counts, 'followupIdentity': fixed['identity']['kind']}))
