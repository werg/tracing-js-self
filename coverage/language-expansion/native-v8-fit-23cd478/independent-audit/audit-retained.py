import argparse
import hashlib
import json
import math
import subprocess
import tarfile
from pathlib import Path

from megatoken.generation.codec import ByteCodec

parser = argparse.ArgumentParser(description='Audit retained native v8 evidence without loading model weights or running inference')
parser.add_argument('--package', type=Path, default=Path(__file__).resolve().parent.parent)
parser.add_argument('--native', type=Path, required=True, help='Clean native checkout at 23cd478')
parser.add_argument('--tokenizer', type=Path, required=True)
parser.add_argument('--output', type=Path, required=True)
args = parser.parse_args()
ROOT = args.output.resolve()
ROOT.mkdir(parents=True, exist_ok=True)
RETAINED = ROOT / 'retained'
PACKAGE = args.package.resolve()
NATIVE = args.native.resolve()
TOKENIZER = args.tokenizer.resolve()
read = lambda name: json.loads((RETAINED / name).read_text())
sha = lambda payload: hashlib.sha256(payload).hexdigest()
index = json.loads((PACKAGE / 'artifact-index.json').read_text())
summary_bytes = (PACKAGE / 'summary.json').read_bytes()
assert len(summary_bytes) == index['summary']['bytes']
assert sha(summary_bytes) == index['summary']['sha256']
summary = json.loads(summary_bytes)
archive_hashes = []
member_hashes = []
for entry in index['archives']:
    archive = PACKAGE / entry['path']
    payload = archive.read_bytes()
    assert len(payload) == entry['bytes'] and sha(payload) == entry['sha256']
    archive_hashes.append({key: entry[key] for key in ['path', 'bytes', 'sha256']})
    with tarfile.open(archive, 'r:xz') as source:
        assert source.getnames() == [row['path'] for row in entry['files']]
        for row in entry['files']:
            member = source.getmember(row['path'])
            assert member.isfile() and not Path(member.name).is_absolute()
            assert '..' not in Path(member.name).parts
            payload = source.extractfile(member).read()
            assert len(payload) == row['bytes'] and sha(payload) == row['sha256']
            target = RETAINED / member.name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(payload)
            member_hashes.append(row)
assert subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=NATIVE).decode().strip() == '23cd47816f9b99bbdb2ec9a32dd455daf68b732b'
codec = ByteCodec.from_tokenizer_json(TOKENIZER)
assert sha(TOKENIZER.read_bytes()) == summary['tokenizer']['assetSha256']
assert codec.fingerprint == summary['tokenizer']['codecFingerprint']

def check_selection(selection, origin='actual-model-selected'):
    assert selection['origin'] == origin and selection['modelSelected'] is True
    assert selection['codecFingerprint'] == codec.fingerprint
    total = 0
    payloads = []
    invalid = 0
    for fragment in selection['fragments']:
        payload = bytes.fromhex(fragment['payloadHex'])
        assert codec.decode(fragment['emittedTokenIds']) == payload
        assert fragment['tokenIds'] == fragment['emittedTokenIds']
        total += len(fragment['emittedTokenIds'])
        payloads.append(payload)
        try:
            payload.decode('utf-8', errors='strict')
        except UnicodeDecodeError:
            invalid += 1
    assert total == selection['generatedTokens']
    if invalid:
        assert selection['payloadHex'] is None and selection['status'] == 'rejected'
        assert selection['failure'] == 'Native model emitted an invalid v8 text fragment'
    else:
        assert b''.join(payloads).hex() == selection['payloadHex']
    return total, sum(map(len, payloads)), invalid

training = read('training/report.json')
script = subprocess.check_output(['git', 'show', summary['measuredRevisions']['trainingNativeConsumer'] + ':scripts/fit_semantic_v8.py'], cwd=NATIVE)
assert sha(script) == training['scriptSha256']
assert training['consumerRevision'] == summary['measuredRevisions']['trainingNativeConsumer']
assert sha((RETAINED / 'training-source/fit-increment.source.json').read_bytes()) == training['artifactSha256']
assert training['optimizerSteps'] == 256
assert [r['step'] for r in training['history']] == list(range(1, 257))
assert len(training['changedModelOwners']) == 33
assert all(name.startswith('decoder.') for name in training['changedModelOwners'])
assert [e['optimizerSteps'] for e in training['evaluations']] == [0, 32, 64, 96, 128, 160, 192, 224, 256]
assert all('heldout' not in e for e in training['evaluations'][1:])
for model in ['baseline', 'fitted']:
    identity = summary['identities'][model]
    manifest = read(f'training/{model}/manifest.json')
    assert manifest['model_sha256'] == identity['servedModelSha256']
    assert manifest['checkpoint_sha256'] == identity['fullCheckpointSha256']
    assert manifest['transducer_sha256'] == identity['transducerSha256']
    assert manifest['codec_fingerprint'] == codec.fingerprint

source_rows = []
for prefix, producer, consumer in [
    ('training-source', summary['measuredRevisions']['trainingSourceProducer'], summary['measuredRevisions']['trainingNativeConsumer']),
    ('current-source', summary['measuredRevisions']['frozenStudySourceProducer'], summary['measuredRevisions']['frozenStudyNativeConsumer']),
]:
    for case, arg, result in [('fit-increment', 6, 7), ('heldout-increment', 8, 9)]:
        source = read(f'{prefix}/{case}.source.json')
        receipt = read(f'{prefix}/{case}.native.json')
        assert receipt['consumerRevision'] == consumer
        verification = receipt['sourceVerification']
        assert verification['producerRevision'] == producer
        assert verification['producerTreeClean'] is True
        assert verification['artifactSha256'] == sha((RETAINED / f'{prefix}/{case}.source.json').read_bytes())
        assert receipt['admitted'] is True and set(receipt['checks'].values()) == {'passed'}
        reference = source['sidecar']['sourceArtifact']['sidecar']
        assert reference['referenceInput']['inputGraph']['roots'] == [['num', arg]]
        assert reference['reference']['outcome']['graph']['roots'][-1] == ['num', result]
        source_rows.append({'phase': prefix, 'case': case, 'producer': producer, 'consumer': consumer, 'input': arg, 'expectedReturn': result, 'datasetFamilySplit': reference['identity']['split']['split']})
        if prefix == 'current-source':
            old = read(f'training-source/{case}.source.json')
            assert old['public'] == source['public'] and old['contexts'] == source['contexts']

training_evaluations = []
for stage_index, stage in enumerate(training['evaluations'] + [training['final']]):
    for split, evaluations in [('train', [stage['train']]), ('heldout', stage.get('heldout', []))]:
        for evaluation in evaluations:
            metrics = evaluation['metrics']
            assert metrics['predictionAttempts'] == len(metrics['attempts'])
            counts = [check_selection(attempt, 'actual-model-selected') for attempt in metrics['attempts']]
            assert sum(x[0] for x in counts) == metrics['generatedTokens']
            training_evaluations.append({'stage': stage_index, 'steps': stage['optimizerSteps'], 'split': split, 'completed': evaluation['completed'], 'attempts': len(counts), 'tokens': sum(x[0] for x in counts), 'bytes': sum(x[1] for x in counts), 'invalidUtf8Fragments': sum(x[2] for x in counts), 'seconds': evaluation['seconds']})

study_rows = []
for phase in ['current-source', 'stale-source-authority']:
    for model in ['baseline', 'fitted']:
        report = read(f'{phase}/{model}-run/report.json')
        study = read(f'{phase}/{model}-study/study.json')
        assert report['studyDigest'] == study['digest']
        assert study == read(f'{phase}/{model}-run/study.json')
        assert report['declared'] == study['declared'] == 6
        assert study['seeds'] == [17, 29, 43]
        assert [(r['caseId'], r['seed']) for r in report['rows']] == [(c['id'], seed) for c in study['cases'] for seed in study['seeds']]
        assert study['checkpointIdentity'] == summary['identities'][model]['servedModelSha256']
        assert report['summary']['untested'] == 0 and report['cleanup']['receipt']['exitCode'] == 0
        attempts = 0
        total_tokens = 0
        invalid_utf8 = 0
        split_rows = {}
        for row in report['rows']:
            result = row['result']
            assert result['checkpointIdentity'] == study['checkpointIdentity']
            assert result['seed'] == row['seed']
            assert result['generationSettings'] == study['settings']
            assert result['costs']['predictionAttempts'] == len(result['attempts'])
            assert row['completedExecution'] == result['completedExecution']
            assert row['sourceValidated'] == result['sourceValidated']
            split = split_rows.setdefault(row['caseId'], {'declared': 0, 'publicCompleted': 0, 'sourceValidated': 0, 'completedExecution': 0})
            split['declared'] += 1
            for field in ['publicCompleted', 'sourceValidated', 'completedExecution']:
                split[field] += int(result[field])
            for attempt in result['attempts']:
                selection = attempt.get('selection') or attempt['evidence']['selection']
                assert selection['checkpointIdentity'] == study['checkpointIdentity']
                counts = check_selection(selection)
                attempts += 1
                total_tokens += counts[0]
                invalid_utf8 += counts[2]
        s = report['summary']
        assert attempts == s['predictionAttempts']
        for field in ['publicCompleted', 'sourceValidated', 'completedExecution']:
            assert sum(x[field] for x in split_rows.values()) == s[field]
        assert sum(r['result']['costs']['generatedTokens'] for r in report['rows']) == s['generatedTokens']
        assert sum(r['result']['costs']['unknownGenerationCostAttempts'] for r in report['rows']) == s['unknownGenerationCostAttempts']
        native_seconds = sum(max(0, (r['result'].get('nativeMetricsAfter') or {}).get('runtime', {}).get('computeSeconds', 0) - (r['result'].get('nativeMetricsBefore') or {}).get('runtime', {}).get('computeSeconds', 0)) for r in report['rows'])
        assert math.isclose(native_seconds, s['nativeComputeSeconds'])
        study_rows.append({'phase': phase, 'model': model, 'studyDigest': study['digest'], 'splitResults': split_rows, 'attempts': attempts, 'verifiedGeneratedTokens': s['generatedTokens'], 'nativeEmittedTokens': total_tokens, 'unknownCostAttempts': s['unknownGenerationCostAttempts'], 'invalidUtf8Fragments': invalid_utf8, 'nativeComputeSeconds': native_seconds, 'elapsedMs': s['elapsedMs']})

audit = {'status': 'passed', 'artifactCommit': 'e91ba6c78f1d3e53947bfdf84c6549ba8e7ddd99', 'scope': 'Independent retained-file, tokenizer-byte, identity and accounting audit; no checkpoint weights available and no model generation or training rerun', 'summary': index['summary'], 'archives': archive_hashes, 'members': member_hashes, 'tokenizerIdentity': codec.fingerprint, 'sources': source_rows, 'training': {'optimizerSteps': training['optimizerSteps'], 'historyRows': len(training['history']), 'changedDecoderOwnersReported': len(training['changedModelOwners']), 'scriptSha256': training['scriptSha256'], 'evaluationRows': training_evaluations}, 'studies': study_rows, 'unavailableModelArchive': summary['retainedModelArchive']}
(ROOT / 'retained-audit.json').write_text(json.dumps(audit, indent=2) + '\n')
print(json.dumps({'status': audit['status'], 'studies': study_rows, 'trainingEvaluationRows': len(training_evaluations), 'trainingEvaluationAttempts': sum(x['attempts'] for x in training_evaluations), 'trainingEvaluationTokens': sum(x['tokens'] for x in training_evaluations)}, indent=2))
