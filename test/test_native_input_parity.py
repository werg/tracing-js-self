"""Input-boundary regressions. No neural runtime or successful selections are simulated."""
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('native_input_parity', ROOT/'tools/native_input_parity.py')
N = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(N)
PIN = '6e27a7c6529aa0778c5ea818432461db7cd05ea7'


class RetainedBoundaryReceiptTests(unittest.TestCase):
    def test_actual_failed_receipt_retains_original_bytes_and_limits(self):
        receipt = json.loads((ROOT/'docs/evidence/native-input-parity-2026-11-18.json').read_text())
        self.assertEqual(receipt['consumerRevision'], PIN)
        candidate = (ROOT/'docs/evidence/native-input-parity-2026-11-18.candidate.json').read_bytes()
        self.assertEqual(hashlib.sha256(candidate).hexdigest(), receipt['episodeSha256'])
        self.assertEqual(receipt['status'], 'failed')
        self.assertFalse(receipt['controlBytesMatch'])
        self.assertEqual(receipt['training']['control']['bytes'], 0)
        self.assertEqual(receipt['training']['tracks'][1]['description'], '')
        self.assertEqual(
            receipt['serving']['generation']['trackDescriptions'][0]['purpose'],
            'Execute program1.run')
        self.assertEqual(receipt['serving']['generation']['controls'][0]['bytes'], 553)
        for path in ('training', 'serving'):
            for row in receipt[path]['observedRecords']:
                payload = bytes.fromhex(row['payloadHex'])
                self.assertEqual(payload.decode(), row['payloadText'])
                self.assertEqual(hashlib.sha256(payload).hexdigest(), row['sha256'])
        self.assertEqual([row['sameJsonValue'] for row in receipt['observedRecordComparisons']],
                         [True, True, False])
        self.assertEqual([row['sameBytes'] for row in receipt['observedRecordComparisons']],
                         [False, False, False])
        self.assertEqual(receipt['modelSelections'], 0)
        self.assertEqual(receipt['optimizerSteps'], 0)
        self.assertFalse(receipt['nativeAdmissionClaim'])
        self.assertIn('checkpoint identity and conditional logits', receipt['unmeasured'])

    def test_unverified_packet_is_refused_before_optional_native_imports(self):
        for packet, pattern in [({}, 'source-certified'),
                                ({'schema': 'semantic-native-input-probe/1'}, 'source/replay/identity')]:
            with self.assertRaisesRegex(ValueError, pattern): N.inspect_inputs(packet)


@unittest.skipUnless(os.environ.get('MEGATOKEN_REPOSITORY'),
                     'Set MEGATOKEN_REPOSITORY to the real pinned companion checkout')
class ActualPinnedBoundaryTests(unittest.TestCase):
    expected_pin = PIN

    @classmethod
    def setUpClass(cls):
        cls.consumer = Path(os.environ['MEGATOKEN_REPOSITORY']).resolve()
        revision = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=cls.consumer, text=True).strip()
        if revision != cls.expected_pin:
            raise unittest.SkipTest('Regression requires its exact declared companion pin')
        subprocess.run(['git', 'diff', '--quiet', 'HEAD', '--'], cwd=cls.consumer, check=True)
        sys.path.insert(0, str(cls.consumer/'src'))
        with tempfile.TemporaryDirectory() as temporary:
            episode = Path(temporary)/'episode.json'
            # Source certification is executed now; no retained stale admission
            # receipt or synthetic correctness result is admitted by the probe.
            script = '''
import {writeFileSync} from 'node:fs';
import {verifyEffectfulTrainingCase} from './src/training/effectful-admit.js';
const result=await verifyEffectfulTrainingCase({source:'"use strict";function run(a,b){return a&b;}',
entry:'run',args:[6,3],family:'native-input-parity-probe',taskId:'flag-intersection-pure',
license:'repository-fixture',trustTier:'repository-fixture'});
if(result.status!=='locally_verified')throw new Error(JSON.stringify(result));
writeFileSync(process.argv[1],JSON.stringify(result.exported)+'\\n');
'''
            subprocess.run(['node', '--input-type=module', '-e', script, str(episode)], cwd=ROOT,
                           check=True, timeout=120)
            cls.packet = json.loads(subprocess.check_output(
                ['node', str(ROOT/'tools/build-native-probe-input.mjs'), str(episode)], cwd=ROOT,
                text=True, timeout=120))

    def test_real_native_training_and_serving_boundary_disagree(self):
        report = N.inspect_inputs(self.packet)
        self.assertEqual(report['status'], 'failed')
        self.assertEqual(report['training']['control']['text'], '')
        self.assertEqual(report['serving']['generation']['controls'][0]['bytes'], 553)
        self.assertFalse(report['trackPurposeMatch'])
        self.assertEqual(report['trainingTrackPurpose'], '')
        self.assertEqual(report['servingTrackPurpose'], 'Execute program1.run')
        self.assertEqual(len(report['training']['observedRecords']), 2)
        self.assertEqual(len(report['serving']['observedRecords']), 3)
        bootstrap = json.loads(report['serving']['observedRecords'][-1]['payloadText'])
        self.assertEqual(bootstrap['kind'], 'selected-bootstrap')
        self.assertEqual(bootstrap['reason'], 'retained-activation')
        self.assertEqual(report['modelSelections'], 0)

    def test_changed_public_input_and_future_selected_history_fail(self):
        changed = copy.deepcopy(self.packet)
        changed['exported']['public']['timeline'][0]['source'] += ' '
        with self.assertRaisesRegex(ValueError, 'after source certification'): N.inspect_inputs(changed)
        changed = copy.deepcopy(self.packet)
        changed['prefix']['committed'].append({'kind': 'semantic'})
        with self.assertRaisesRegex(ValueError, 'first model prediction'): N.inspect_inputs(changed)
        changed = copy.deepcopy(self.packet)
        changed['prefix']['committed'][0]['source'] += ' '
        with self.assertRaisesRegex(ValueError, 'serving prefix differs'): N.inspect_inputs(changed)
        changed = copy.deepcopy(self.packet)
        changed['sourceAdmission']['effectsValidated'] = False
        with self.assertRaisesRegex(ValueError, 'source/replay/identity'): N.inspect_inputs(changed)
        with self.assertRaisesRegex(ValueError, 'capacity'): N.inspect_inputs(self.packet, max_tokens=2048)


@unittest.skipUnless(os.environ.get('MEGATOKEN_REPOSITORY'),
                     'Set MEGATOKEN_REPOSITORY to the current pinned companion checkout')
class ActualCurrentBoundaryTests(unittest.TestCase):
    expected_pin = json.loads((ROOT/'contracts/native-admission-policy-v5.json').read_text())['consumerRevision']
    # Share only source certification/setup; historical mismatch assertions
    # remain attached to their original revision in the preceding class.
    setUpClass = classmethod(ActualPinnedBoundaryTests.setUpClass.__func__)

    def test_current_first_input_bytes_and_execution_purpose_agree(self):
        report = N.inspect_inputs(self.packet)
        self.assertEqual(report['status'], 'passed')
        self.assertTrue(report['controlBytesMatch'])
        self.assertTrue(report['observedRecordBytesMatch'])
        self.assertEqual(report['training']['control']['bytes'], 580)
        self.assertEqual(len(report['training']['observedRecords']), 2)
        self.assertEqual(len(report['serving']['observedRecords']), 2)
        event = report['training']['event']
        track = next(row for row in report['training']['tracks'] if row['track_id'] == event['track_id'])
        self.assertEqual(track['description'], report['serving']['generation']['trackDescriptions'][0]['purpose'])
        self.assertEqual(report['modelSelections'], 0)
        self.assertEqual(report['optimizerSteps'], 0)
        self.assertIn('checkpoint identity and conditional logits', report['unmeasured'])


if __name__ == '__main__': unittest.main()
