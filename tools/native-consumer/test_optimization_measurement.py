"""Infrastructure regressions use synthetic receipts; they are not learning evidence."""
import importlib.util
import json
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import subprocess
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('optimization_smoke',
    Path(__file__).resolve().parents[1] / 'run-optimization-smoke.py')
SMOKE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SMOKE)


class OptimizationMeasurementTests(unittest.TestCase):
    def test_original_decoder_tokens_are_counted_once_and_incomplete_is_explicit(self):
        event = {'selectedEventId': 'one', 'emittedTokenIds': [7, 8]}
        profile = {'complete': True, 'droppedRecords': 0, 'records': [event, {'failure': event}]}
        measured = SMOKE.generated_token_cost(profile)
        self.assertEqual(measured['generatedTokens'], 2)
        self.assertEqual(measured['decoderEvents'], 1)
        self.assertTrue(measured['complete'])
        profile['droppedRecords'] = 2
        self.assertFalse(SMOKE.generated_token_cost(profile)['complete'])
        profile['records'].append({'selectedEventId': 'one', 'emittedTokenIds': [9]})
        with self.assertRaisesRegex(ValueError, 'Conflicting'):
            SMOKE.generated_token_cost(profile)

    def run_rollout(self, root, *, rejected=False, timed_out=False, invalid_result=False):
        identity = 'a' * 64
        outcome = {'cleanup': {'pendingEffects': 0, 'pendingJobs': 0, 'openHandlers': 0},
                   'completion': {'kind': 'return', 'value': 7}}
        case = {'index': 0, 'id': 'case', 'family': 'source', 'expected': outcome,
                'envelope': {'seed': 17, 'request': {'source': 'public'}}}
        profile = {'complete': True, 'droppedRecords': 0,
                   'identity': {'modelSha256': identity},
                   'records': [{'selectedEventId': 'one', 'emittedTokenIds': [7, 8]}]}
        actual = {'schema': 'semantic-evaluation-result/4', 'origin': 'trained',
                  'checkpointIdentity': identity, 'inferenceIdentity': {'seed': 17},
                  'failure': None, 'outcome': outcome, 'costs': {'computeSeconds': 1},
                  'rejections': [{'phase': 'semantic-validation'}] if rejected else [],
                  'hardGates': {key: 0 for key in ['futureObservationLeaks', 'unauthorizedEffects',
                    'untrackedNativeFallback', 'falseAdmissions', 'replayNativeEffects']}}

        class FakeProcess:
            def __init__(self, argv, **kwargs):
                self.pid, self.returncode = 123, 0
                self.output = kwargs['stdout']
                self.destination = Path(self.output.name).parent
                (self.destination / 'serving-profile.json').write_text(json.dumps(profile))

            def communicate(self, request, timeout):
                # No teacher expectation reaches this evaluator transport.
                assert 'expected' not in json.loads(request)
                self.output.write('{broken' if invalid_result else json.dumps(actual))
                self.output.flush()
                if timed_out:
                    self.returncode = None
                    raise subprocess.TimeoutExpired('node', timeout)

            def wait(self, timeout=None):
                self.returncode = -15

        with patch.object(SMOKE.subprocess, 'Popen', FakeProcess), patch.object(SMOKE.os, 'killpg') as kill:
            result = SMOKE.rollout(case, 'trained', {'bundle': '/bundle', 'model_sha256': identity},
                                   Path('/consumer'), Path(root),
                                   SimpleNamespace(rollout_tokens=8, rollout_timeout=1), {})
            if timed_out:
                kill.assert_called_once()
            return result

    def test_rejected_original_selection_is_failure_even_if_later_outcome_matches(self):
        with TemporaryDirectory() as root:
            result = self.run_rollout(root, rejected=True)
            self.assertFalse(result['wholeTaskSuccess'])
            self.assertFalse(result['traceValid'])
            self.assertEqual(result['generatedTokenCost']['generatedTokens'], 2)
            self.assertEqual(len(result['rejections']), 1)

    def test_timeout_preserves_original_result_profile_and_failed_summary(self):
        with TemporaryDirectory() as root:
            result = self.run_rollout(root, timed_out=True)
            self.assertFalse(result['wholeTaskSuccess'])
            self.assertEqual(result['pipelineFailure'], 'evaluator-timeout')
            self.assertTrue((Path(root) / 'trained/0000/result.json').exists())
            saved = json.loads((Path(root) / 'trained/0000/summary.json').read_text())
            self.assertEqual(saved, result)
            self.assertEqual(saved['generatedTokenCost']['generatedTokens'], 2)

    def test_malformed_original_evaluator_bytes_stay_visible(self):
        with TemporaryDirectory() as root:
            result = self.run_rollout(root, invalid_result=True)
            self.assertEqual(result['pipelineFailure'], 'invalid-evaluator-result')
            self.assertEqual((Path(root) / 'trained/0000/result.json').read_text(), '{broken')

    def test_complete_matching_execution_is_measured_success(self):
        with TemporaryDirectory() as root:
            result = self.run_rollout(root)
            self.assertTrue(result['wholeTaskSuccess'])
            self.assertTrue(result['traceValid'])


if __name__ == '__main__':
    unittest.main()
