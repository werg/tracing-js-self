#!/usr/bin/env python3
"""Check final study bytes, unchanged models, native gates and failed-emission costs."""

import hashlib
import json
from pathlib import Path
import tarfile
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parent


def require(condition, reason):
    if not condition:
        raise ValueError(reason)


def sha(data):
    return hashlib.sha256(data).hexdigest()


index = json.loads((ROOT / 'artifact-index.json').read_text())
summary_bytes = (ROOT / 'summary.json').read_bytes()
require(len(summary_bytes) == index['summary']['bytes'], 'Summary size')
require(sha(summary_bytes) == index['summary']['sha256'], 'Summary SHA-256')
summary = json.loads(summary_bytes)
members = {}
for archive in index['archives']:
    data = (ROOT / archive['path']).read_bytes()
    require(len(data) == archive['bytes'] and sha(data) == archive['sha256'], archive['path'])
    with tarfile.open(ROOT / archive['path'], 'r:xz') as source:
        require(source.getnames() == [row['path'] for row in archive['files']], 'Archive inventory')
        for row in archive['files']:
            member = source.getmember(row['path'])
            require(member.isfile(), 'Only regular archive files are permitted')
            data = source.extractfile(member).read()
            require(len(data) == row['bytes'] and sha(data) == row['sha256'], member.name)
            require(member.name not in members, 'Duplicate member')
            members[member.name] = data


def read(name):
    return json.loads(members[name])


pipeline = read('pipeline/receipt.json')
require(summary['pins'] == summary['finalPins'] == pipeline['pins'] == pipeline['finalPins'], 'Clean pins changed')
require(all(pin['status'] == '' for pin in summary['pins'].values()), 'Dirty checkout')
require(summary['additionalOptimizerSteps'] == pipeline['additionalOptimizerSteps'] == 0, 'Additional training')
require(summary['modelIdentitiesBefore'] == summary['modelIdentitiesAfter']
        == pipeline['modelIdentitiesBefore'] == pipeline['modelIdentitiesAfter'], 'Model weights changed')

for case in ['fit-increment', 'heldout-increment']:
    original = read(f'training-source/{case}.source.json')
    current = read(f'source/{case}.source.json')
    native = read(f'source/{case}.native.json')
    require(original['public'] == current['public'], 'Public conditioning changed')
    require(original['contexts'] == current['contexts'], 'Context conditioning changed')
    require(native['admitted'] is True, 'Native admission failed')
    require(set(native['checks']) == {'replay', 'contexts', 'continuation', 'masks', 'sourceBinding', 'tokenizer'}, 'Missing native gate')
    require(set(native['checks'].values()) == {'passed'}, 'Native gate failed')
    require(native['consumerRevision'] == summary['pins']['consumer']['revision'], 'Consumer receipt pin')
    require(native['sourceVerification']['producerRevision'] == summary['pins']['producer']['revision'], 'Source receipt pin')

audit = read('audit/emission-fragments.json')['rows']
fragments = 0
invalid_utf8 = 0
for model in ['baseline', 'fitted']:
    raw = members[f'study/{model}-run/report.json']
    report = json.loads(raw)
    derived = summary['models'][model]
    require(sha(raw) == derived['reportSha256'] == pipeline['reports'][model]['sha256'], 'Report SHA-256')
    require(report['summary'] == derived['originalSummary'], 'Report summary changed')
    require(report['declared'] == report['summary']['attempted'] == len(report['rows']) == 6, 'Incomplete denominator')
    require(report['summary']['untested'] == 0, 'Untested declared case')
    require(report['cleanup'] == {'status': 'completed', 'receipt': {'graceful': True, 'exitCode': 0}}, 'Cleanup failed')
    require(report['checkpointIdentity'] == summary['modelIdentitiesBefore'][model], 'Checkpoint attestation')
    require(report['settings'] == summary['settings'], 'Settings attestation')
    reported = 0
    unverified = 0
    for row in report['rows']:
        for attempt in row['result']['attempts']:
            selected = attempt.get('selection') or (attempt.get('evidence') or {}).get('selection')
            count = sum(len(f['emittedTokenIds']) for f in selected['fragments'])
            require(count == selected['generatedTokens'], 'Native emission count')
            reported += count
            if attempt.get('provenanceValidated') is not True:
                unverified += count
            for number, fragment in enumerate(selected['fragments']):
                checked = next(a for a in audit if a['model'] == model and a['caseId'] == row['caseId']
                               and a['seed'] == row['seed'] and a['attempt'] == attempt['attempt']
                               and a['fragment'] == number)
                payload = bytes.fromhex(fragment['payloadHex'])
                require(sha(payload) == checked['payloadSha256'] == checked['decodedSha256'], 'Audited fragment bytes')
                require(len(fragment['emittedTokenIds']) == checked['nativeEmittedTokenCount'], 'Audited IDs')
                try:
                    payload.decode('utf-8', errors='strict')
                    valid = True
                except UnicodeDecodeError:
                    valid = False
                require(valid == checked['validUtf8'], 'UTF-8 audit')
                invalid_utf8 += not valid
                fragments += 1
    accounting = derived['derivedAccounting']
    require(reported == accounting['nativeReportedGeneratedTokens'], 'Native count total')
    require(unverified == accounting['nativeReportedTokensOnUnverifiedAttempts'], 'Unverified native total')
    require(reported - unverified == accounting['verifiedGeneratedTokens'] == report['summary']['generatedTokens'], 'Verified count total')

validation = read('validation/summary.json')
require(validation['passed'] is True and validation['pins'] == validation['finalPins'] == summary['pins'], 'Native validation pins')
require(sha(members['validation/summary.json']) == summary['nativeValidation']['summarySha256'], 'Native validation identity')
for check in validation['checks']:
    require(check['exitCode'] == 0, 'Native validation command failed')
    require(sha(members['validation/' + Path(check['log']).name]) == check['logSha256'], 'Native validation log')
counts = {name: 0 for name in ['tests', 'failures', 'errors', 'skipped']}
for suite in ET.fromstring(members['validation/semantic-v8-tests.xml']).iter('testsuite'):
    for name in counts:
        counts[name] += int(suite.get(name, 0))
require(counts == {'tests': 244, 'failures': 0, 'errors': 0, 'skipped': 0}, 'Native unit gate')
require(fragments == 15 and invalid_utf8 == 2, 'Fragment disposition')
require(summary['models']['baseline']['originalSummary']['completedExecution'] == 0, 'Baseline result')
require(summary['models']['fitted']['splitResults']['fit-increment']['completedExecution'] == 3, 'In-sample result')
require(summary['models']['fitted']['splitResults']['heldout-increment']['completedExecution'] == 0, 'Held-out result')
print(json.dumps({'status': 'passed', 'archives': len(index['archives']), 'retainedFiles': len(members),
                  'declaredRollouts': 12, 'fragments': fragments, 'invalidUtf8Fragments': invalid_utf8,
                  'nativeTests': counts, 'modelWeightsUnchanged': True, 'additionalOptimizerSteps': 0}, indent=2))
