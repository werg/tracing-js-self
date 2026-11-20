"""Verify the retained complete Node 24 job without starting tests or CI."""

import argparse
import hashlib
import json
import re
import subprocess
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--repository', type=Path, help='Optional checkout containing both recorded Git commits')
args = parser.parse_args()
root = Path(__file__).resolve().parent
for line in (root / 'SHA256SUMS').read_text().splitlines():
    expected, name = line.split('  ', 1)
    assert Path(name).name == name
    assert hashlib.sha256((root / name).read_bytes()).hexdigest() == expected, name
receipt = json.loads((root / 'receipt.json').read_text())
source = json.loads((root / 'source-metadata.json').read_text())
raw = (root / receipt['log']['path']).read_bytes()
assert len(raw) == receipt['log']['bytes']
assert hashlib.sha256(raw).hexdigest() == receipt['log']['sha256']
lines = [re.sub(r'^\d{4}-\d{2}-\d{2}T\S+Z ', '', line) for line in raw.decode('utf-8').splitlines()]
counts = {}
for line in lines:
    match = re.fullmatch(r'ℹ (tests|suites|pass|fail|cancelled|skipped|todo|duration_ms) ([0-9.]+)', line)
    if match:
        assert match[1] not in counts
        counts[match[1]] = float(match[2]) if match[1] == 'duration_ms' else int(match[2])
assert counts == receipt['npmTest']
assert counts['tests'] == counts['pass'] + counts['fail'] + counts['cancelled'] + counts['skipped'] + counts['todo']
assert counts['tests'] == 1844 and counts['pass'] == 1836 and counts['fail'] == counts['cancelled'] == 0
skips = []
for line in lines:
    if line.startswith('﹣ '):
        match = re.fullmatch(r'﹣ (.*) \(([0-9.]+)ms\) # (.*)', line)
        assert match
        skips.append({'test': match[1], 'reason': match[3]})
assert skips == receipt['skips'] and len(skips) == counts['skipped'] == 8
assert 'node: v' + receipt['runtime']['node'] in lines
assert 'npm: ' + receipt['runtime']['npm'] in lines
assert receipt['testedMergeSha'] in lines
assert source['headSha'] == receipt['prHeadSha']
assert source['mergeShaFromPr'] == receipt['testedMergeSha']
assert source['job']['id'] == receipt['jobId']
assert source['job']['conclusion'] == receipt['jobConclusion'] == 'success'
assert all(step['conclusion'] == 'success' for step in receipt['successfulJobSteps'])
assert receipt['headTree'] == receipt['testedTree']
assert all(pair['head'] == pair['testedMerge'] for pair in receipt['pathIdentities'].values())
assert receipt['interoperabilityCasesRechecked'] == 26
assert receipt['v8ContractCheck']['valid'] is True
git_verified = False
if args.repository:
    def git(*parts):
        return subprocess.check_output(['git', *parts], cwd=args.repository).decode().strip()
    assert git('rev-parse', receipt['prHeadSha'] + '^{tree}') == receipt['headTree']
    assert git('rev-parse', receipt['testedMergeSha'] + '^{tree}') == receipt['testedTree']
    assert git('show', '-s', '--format=%P', receipt['testedMergeSha']).split() == receipt['testedMergeParents']
    for ancestor in receipt['includedFixAncestors']:
        subprocess.run(['git', 'merge-base', '--is-ancestor', ancestor, receipt['prHeadSha']], cwd=args.repository, check=True)
    for path, pair in receipt['pathIdentities'].items():
        assert git('rev-parse', receipt['prHeadSha'] + ':' + path) == pair['head']
        assert git('rev-parse', receipt['testedMergeSha'] + ':' + path) == pair['testedMerge']
    assert git('rev-parse', receipt['semanticQualificationSourceRevision'] + ':src') == receipt['pathIdentities']['src']['head']
    git_verified = True
print(json.dumps({'status': 'passed', 'tests': counts['tests'], 'passed': counts['pass'], 'failed': counts['fail'], 'skipped': counts['skipped'], 'gitObjectsCompared': git_verified, 'jobId': receipt['jobId']}, indent=2))
