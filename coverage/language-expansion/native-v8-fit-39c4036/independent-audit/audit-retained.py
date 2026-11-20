"""Recheck archived current-contract evidence without model weights or inference."""

import argparse
import hashlib
import json
import math
import subprocess
import sys
import tarfile
from pathlib import Path

from megatoken.generation.codec import ByteCodec

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--native', type=Path, required=True)
parser.add_argument('--tokenizer', type=Path, required=True)
parser.add_argument('--output', type=Path, required=True)
args = parser.parse_args()
package = Path(__file__).resolve().parent.parent
output = args.output.resolve()
retained = output / 'retained'
sha = lambda data: hashlib.sha256(data).hexdigest()
read = lambda name: json.loads((retained / name).read_text())
index = json.loads((package / 'artifact-index.json').read_text())
raw_summary = (package / 'summary.json').read_bytes()
assert len(raw_summary) == index['summary']['bytes']
assert sha(raw_summary) == index['summary']['sha256']
summary = json.loads(raw_summary)
archives = []
members = []
for archive in index['archives']:
    path = package / archive['path']
    raw = path.read_bytes()
    assert len(raw) == archive['bytes'] and sha(raw) == archive['sha256']
    archives.append({key: archive[key] for key in ['path', 'bytes', 'sha256']})
    with tarfile.open(path, 'r:xz') as stream:
        assert stream.getnames() == [row['path'] for row in archive['files']]
        for row in archive['files']:
            member = stream.getmember(row['path'])
            assert member.isfile() and not Path(member.name).is_absolute()
            assert '..' not in Path(member.name).parts
            raw = stream.extractfile(member).read()
            assert len(raw) == row['bytes'] and sha(raw) == row['sha256']
            target = retained / member.name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(raw)
            members.append(row)
original_verifier = json.loads(subprocess.check_output([sys.executable, str(package / 'verify.py')]))
assert original_verifier['status'] == 'passed'
native_revision = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=args.native).decode().strip()
assert native_revision == '39c4036564428e44cc89caf261f517d856482695'
assert not subprocess.check_output(['git', 'status', '--porcelain'], cwd=args.native).decode().strip()
codec = ByteCodec.from_tokenizer_json(args.tokenizer)
assert sha(args.tokenizer.read_bytes()) == summary['policy']['tokenizerSha256']
assert codec.fingerprint == summary['policy']['tokenizerIdentity']
assert summary['policy']['contractDigest'] == '344f7e99aeed605a1965c70f0e0d8829707d6891437ba43dd743fa304cd777dc'
assert summary['modelIdentitiesBefore'] == summary['modelIdentitiesAfter']

sources = []
for case, argument, expected in [('fit-increment', 6, 7), ('heldout-increment', 8, 9)]:
    current = read(f'source/{case}.source.json')
    original = read(f'training-source/{case}.source.json')
    assert current['public'] == original['public'] and current['contexts'] == original['contexts']
    receipt = read(f'source/{case}.native.json')
    assert receipt['admitted'] and set(receipt['checks'].values()) == {'passed'}
    assert receipt['consumerRevision'] == native_revision
    assert receipt['contractDigest'] == summary['policy']['contractDigest']
    verification = receipt['sourceVerification']
    assert verification['producerRevision'] == '012c9fe49a082319bf98ac0c571596da925741a4'
    assert verification['producerTreeClean']
    assert verification['artifactSha256'] == sha((retained / f'source/{case}.source.json').read_bytes())
    sidecar = current['sidecar']['sourceArtifact']['sidecar']
    assert sidecar['referenceInput']['inputGraph']['roots'] == [['num', argument]]
    assert sidecar['reference']['outcome']['graph']['roots'][-1] == ['num', expected]
    sources.append({'case': case, 'argument': argument, 'expectedReturn': expected, 'sourceArtifactSha256': verification['artifactSha256'], 'familySplit': sidecar['identity']['split']['split'], 'sourceVerification': verification, 'nativeChecks': receipt['checks']})

models = []
for model in ['baseline', 'fitted']:
    report = read(f'study/{model}-run/report.json')
    study = read(f'study/{model}-study/study.json')
    assert study == read(f'study/{model}-run/study.json')
    assert report['studyDigest'] == study['digest']
    assert study['checkpointIdentity'] == summary['modelIdentitiesBefore'][model]
    assert study['declared'] == report['declared'] == 6 and study['seeds'] == [17, 29, 43]
    assert [(r['caseId'], r['seed']) for r in report['rows']] == [(c['id'], seed) for c in study['cases'] for seed in study['seeds']]
    assert report['summary']['untested'] == 0
    counts = {'attempts': 0, 'fragments': 0, 'emittedTokens': 0, 'fragmentBytes': 0, 'invalidUtf8Fragments': 0}
    split_results = {}
    for row in report['rows']:
        result = row['result']
        assert result['checkpointIdentity'] == study['checkpointIdentity']
        assert result['seed'] == row['seed'] and result['generationSettings'] == study['settings']
        assert result['costs']['predictionAttempts'] == len(result['attempts'])
        split = split_results.setdefault(row['caseId'], {'declared': 0, 'publicCompleted': 0, 'sourceValidated': 0, 'completedExecution': 0})
        split['declared'] += 1
        for field in ['publicCompleted', 'sourceValidated', 'completedExecution']:
            split[field] += int(result[field])
        for attempt in result['attempts']:
            selection = attempt.get('selection') or attempt['evidence']['selection']
            assert selection['origin'] == 'actual-model-selected' and selection['modelSelected'] is True
            assert selection['checkpointIdentity'] == study['checkpointIdentity']
            assert selection['codecFingerprint'] == codec.fingerprint
            counts['attempts'] += 1
            fragments = []
            invalid = 0
            token_count = 0
            for fragment in selection['fragments']:
                raw = bytes.fromhex(fragment['payloadHex'])
                assert codec.decode(fragment['emittedTokenIds']) == raw
                assert fragment['tokenIds'] == fragment['emittedTokenIds']
                fragments.append(raw)
                token_count += len(fragment['emittedTokenIds'])
                counts['fragments'] += 1
                counts['fragmentBytes'] += len(raw)
                try:
                    raw.decode('utf-8', errors='strict')
                except UnicodeDecodeError:
                    invalid += 1
            assert token_count == selection['generatedTokens']
            counts['emittedTokens'] += token_count
            counts['invalidUtf8Fragments'] += invalid
            if invalid:
                assert selection['payloadHex'] is None and selection['status'] == 'rejected'
                assert selection['failure'] == 'Native model emitted an invalid v8 text fragment'
            else:
                assert b''.join(fragments).hex() == selection['payloadHex']
    s = report['summary']
    assert counts['attempts'] == s['predictionAttempts']
    for field in ['publicCompleted', 'sourceValidated', 'completedExecution']:
        assert sum(r[field] for r in split_results.values()) == s[field]
    for field in ['generatedTokens', 'unknownGenerationCostAttempts']:
        assert sum(row['result']['costs'][field] for row in report['rows']) == s[field]
    compute = sum(max(0, (row['result'].get('nativeMetricsAfter') or {}).get('runtime', {}).get('computeSeconds', 0) - (row['result'].get('nativeMetricsBefore') or {}).get('runtime', {}).get('computeSeconds', 0)) for row in report['rows'])
    assert math.isclose(compute, s['nativeComputeSeconds'])
    models.append({'model': model, 'studyDigest': study['digest'], 'declared': 6, 'splitResults': split_results, 'emissions': counts, 'verifiedGeneratedTokens': s['generatedTokens'], 'unknownCostAttempts': s['unknownGenerationCostAttempts'], 'nativeComputeSeconds': compute, 'elapsedMs': s['elapsedMs']})

audit = {'status': 'passed', 'artifactCommit': '6bfa59ee4eaa0b3405cad6b1bd5bb3a7003a8108', 'scope': 'Retained evidence integrity and original token-byte audit. No model weights accessed, inference rerun, or optimization.', 'pins': summary['pins'], 'summary': index['summary'], 'archives': archives, 'members': members, 'tokenizerIdentity': codec.fingerprint, 'sourceReceipts': sources, 'models': models, 'recordedModelIdentitiesBefore': summary['modelIdentitiesBefore'], 'recordedModelIdentitiesAfter': summary['modelIdentitiesAfter'], 'additionalOptimizerStepsReported': summary['additionalOptimizerSteps'], 'nativeGateFromRetainedJUnit': original_verifier['nativeTests'], 'unavailableModelArchive': summary['retainedModelArchive']}
(output / 'retained-audit.json').write_text(json.dumps(audit, indent=2) + '\n')
print(json.dumps({'status': 'passed', 'archives': len(archives), 'members': len(members), 'models': models, 'nativeTests': audit['nativeGateFromRetainedJUnit']}, indent=2))
