#!/usr/bin/env python3
"""Exercise the unchanged release cap check against the actual prepared row."""
import importlib.util
import json
from pathlib import Path

output = Path(__file__).resolve().parent
producer = output.parent / 'tracing-ci-selection-probe'
spec = importlib.util.spec_from_file_location('pinned_release', producer / 'tools/package-semantic-release.py')
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)
manifest = json.loads((output / 'selected-input/manifest.json').read_text())
assert len(manifest['cases']) == 1
case = manifest['cases'][0]
document = json.loads((output / 'selected-input' / case['path']).read_text())
side = document['sidecar']
audits = json.loads((output / 'selected-prepared/semantic-audit.json').read_text())
assert len(audits) == 1 and audits[0]['supervision'] == side
audit = audits[0]
assert audit['native']['admitted'] is True
assert audit['native']['generatedTokens'] == side['nativeAdmission']['generatedTokens']
row = {'id': case['id'], 'episodeId': audit['episodeId'], 'split': side['split'],
       'sourceCluster': side['splitIdentity']['componentId'],
       'generatedTokens': audit['native']['generatedTokens']}
assert row['split'] == 'train'

def check(tokens, share, enabled=True):
    selection = {'preparedCandidateIds': [row['id']], 'heldOutIds': [],
                 'policy': {'enabled': enabled, 'maxFamilyTokens': tokens, 'maxFamilyShare': share}}
    return release.check_prepared_selection(output / 'selected-prepared', [row], selection)

unbudgeted = check(None, None, False)
ci_caps = check(10000, 0.2)
token_cap = check(row['generatedTokens'] - 1, 1)
assert unbudgeted['status'] == 'verified'
assert ci_caps['status'] == 'violated'
assert any('invalidated the component token share' in message for message in ci_caps['violations'])
assert token_cap['status'] == 'violated'
assert any('exceeds its token budget' in message for message in token_cap['violations'])
result = {'schema': 'semantic-ci-native-cap-guard-probe/1', 'status': 'verified',
          'scope': 'Actual native prepared row; positive unbudgeted control is not a balanced CI release.',
          'producerRevision': manifest['producerRevision'],
          'consumerRevision': audit['native']['consumerRevision'],
          'unbudgetedPreparation': unbudgeted, 'unchangedCiCaps': ci_caps,
          'strictTokenBudgetControl': token_cap, 'balancedTrainingReleaseClaim': False,
          'optimizerSteps': 0, 'modelInferenceCalls': 0}
(output / 'final-cap-guard.json').write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps({'status': result['status'], 'ciCapStatus': ci_caps['status'],
                  'tokenBudgetStatus': token_cap['status'], 'generatedTokens': row['generatedTokens']}))
