#!/usr/bin/env python3
"""Verify retained bytes and the bounded study's summary without a model runtime."""

import hashlib
import json
from pathlib import Path
import tarfile

ROOT = Path(__file__).resolve().parent


def require(condition, message):
    if not condition:
        raise ValueError(message)


def sha256(data):
    return hashlib.sha256(data).hexdigest()


index = json.loads((ROOT / 'artifact-index.json').read_text())
summary_bytes = (ROOT / 'summary.json').read_bytes()
require(len(summary_bytes) == index['summary']['bytes'], 'Summary byte size changed')
require(sha256(summary_bytes) == index['summary']['sha256'], 'Summary digest changed')
summary = json.loads(summary_bytes)
retained = {}
for archive in index['archives']:
    path = ROOT / archive['path']
    data = path.read_bytes()
    require(len(data) == archive['bytes'], f'Archive size changed: {path.name}')
    require(sha256(data) == archive['sha256'], f'Archive digest changed: {path.name}')
    with tarfile.open(path, 'r:xz') as source:
        require(source.getnames() == [row['path'] for row in archive['files']],
                f'Archive inventory changed: {path.name}')
        for row in archive['files']:
            member = source.getmember(row['path'])
            require(member.isfile(), f'Unexpected non-file: {member.name}')
            payload = source.extractfile(member).read()
            require(len(payload) == row['bytes'], f'Member size changed: {member.name}')
            require(sha256(payload) == row['sha256'], f'Member digest changed: {member.name}')
            require(member.name not in retained, f'Duplicate member: {member.name}')
            retained[member.name] = json.loads(payload)

for case in ['fit-increment', 'heldout-increment']:
    old = retained[f'training-source/{case}.source.json']
    current = retained[f'current-source/{case}.source.json']
    require(old['public'] == current['public'], f'Public input changed: {case}')
    require(old['contexts'] == current['contexts'], f'Contexts changed: {case}')
    for prefix in ['training-source', 'current-source']:
        receipt = retained[f'{prefix}/{case}.native.json']
        require(receipt['admitted'] is True, f'Unadmitted source: {prefix}/{case}')
        require(set(receipt['checks']) == {
            'replay', 'contexts', 'continuation', 'masks', 'sourceBinding', 'tokenizer'
        }, f'Native gate inventory changed: {prefix}/{case}')
        require(set(receipt['checks'].values()) == {'passed'}, f'Native gate failed: {prefix}/{case}')

fragment_rows = retained['audit/emission-fragments.json']['rows']
fragment_count = 0
invalid_utf8 = 0
for prefix, report_summary in [
    ('current-source', summary['currentSourceFrozenStudy']['models']),
    ('stale-source-authority', summary['firstSourceAuthorityStudy']['models']),
]:
    for model in ['baseline', 'fitted']:
        report = retained[f'{prefix}/{model}-run/report.json']
        derived = report_summary[model]
        require(report['declared'] == 6 and len(report['rows']) == 6, 'Declared rows changed')
        require(report['summary']['untested'] == 0, 'A declared row is untested')
        require(report['summary'] == derived['originalSummary'], 'Original summary mismatch')
        require(report['cleanup'] == derived['cleanup'], 'Process cleanup changed')
        verified = 0
        native_reported = 0
        unverified_reported = 0
        for row in report['rows']:
            result = row['result']
            verified += result['costs']['generatedTokens']
            for attempt in result['attempts']:
                selected = attempt.get('selection') or (attempt.get('evidence') or {}).get('selection')
                emitted = sum(len(f['emittedTokenIds']) for f in selected['fragments'])
                require(emitted == selected['generatedTokens'], 'Native emission count changed')
                native_reported += emitted
                if attempt.get('provenanceValidated') is not True:
                    unverified_reported += emitted
                if prefix != 'current-source':
                    continue
                for number, fragment in enumerate(selected['fragments']):
                    audit = next(a for a in fragment_rows if a['model'] == model
                                 and a['caseId'] == row['caseId'] and a['seed'] == row['seed']
                                 and a['attempt'] == attempt['attempt'] and a['fragment'] == number)
                    payload = bytes.fromhex(fragment['payloadHex'])
                    require(audit['payloadSha256'] == sha256(payload), 'Audited payload changed')
                    require(audit['nativeEmittedTokenCount'] == len(fragment['emittedTokenIds']),
                            'Audited emission count changed')
                    require(audit['decodedSha256'] == audit['payloadSha256'], 'Codec byte audit failed')
                    try:
                        payload.decode('utf-8', errors='strict')
                        valid_utf8 = True
                    except UnicodeDecodeError:
                        valid_utf8 = False
                    require(valid_utf8 == audit['validUtf8'], 'UTF-8 audit mismatch')
                    invalid_utf8 += not valid_utf8
                    fragment_count += 1
        accounting = derived['derivedAccounting']
        require(verified == accounting['verifiedGeneratedTokens'], 'Verified total changed')
        require(native_reported == accounting['nativeReportedGeneratedTokens'], 'Native total changed')
        require(unverified_reported == accounting['nativeReportedTokensOnUnverifiedAttempts'],
                'Unverified native total changed')

require(fragment_count == 15 and invalid_utf8 == 2, 'Fragment disposition changed')
current = summary['currentSourceFrozenStudy']['models']
require(current['baseline']['originalSummary']['completedExecution'] == 0, 'Baseline outcome changed')
require(current['fitted']['splitResults']['fit-increment']['completedExecution'] == 3,
        'In-sample outcome changed')
require(current['fitted']['splitResults']['heldout-increment']['completedExecution'] == 0,
        'Held-out outcome changed')
require(summary['training']['additionalOptimizerStepsAfterEnvelopeCorrection'] == 0,
        'Correction changed training')
print(json.dumps({
    'status': 'passed', 'archives': len(index['archives']), 'retainedFiles': len(retained),
    'fullySettledStudyReports': 4, 'currentStudyFragments': fragment_count,
    'invalidUtf8FragmentsRetained': invalid_utf8,
    'baselineVerifiedTokens': 344, 'baselineUnknownCostAttempts': 2,
    'fittedVerifiedTokens': 405, 'fittedInSampleCompleted': 3, 'heldoutCompleted': 0,
}, indent=2))
