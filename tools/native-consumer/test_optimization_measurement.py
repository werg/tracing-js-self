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
    def test_native_training_time_cap_reserves_graceful_checkpoint_time(self):
        class Process:
            returncode = 0
            pid = 123
            def __init__(self):
                self.calls = []
                self.stopped = False
            def communicate(self, **kwargs):
                self.calls.append(kwargs['timeout'])
                if len(self.calls) == 1:
                    raise subprocess.TimeoutExpired('native', kwargs['timeout'])
            def terminate(self):
                self.stopped = True
        process = Process()
        with TemporaryDirectory() as root, patch.object(SMOKE.subprocess, 'Popen', return_value=process), \
                patch.object(SMOKE.time, 'monotonic', side_effect=[0, 875, 880]):
            receipt = SMOKE.run_logged(['native'], Path(root)/'log', env={}, timeout=900, graceful_checkpoint=True)
        self.assertEqual(process.calls, [870, 25])
        self.assertTrue(process.stopped)
        self.assertTrue(receipt['gracefulCheckpointStopRequested'])
        self.assertEqual(receipt['wallSeconds'], 880)

    def test_interrupted_optimizer_updates_are_not_a_restorable_checkpoint(self):
        with TemporaryDirectory() as root:
            directory = Path(root) / 'training'
            directory.mkdir()
            (directory / 'metrics.jsonl').write_text(json.dumps({'event': 'train', 'global_step': 2,
                'denominators': {'lexical': 99}}) + '\n{"event":')
            receipt = SMOKE.partial_training_receipt(root)
            self.assertEqual(receipt['observedOptimizerSteps'], 2)
            self.assertEqual(receipt['supervisedLexicalTokens'], 99)
            self.assertEqual(receipt['malformedMetricLines'], 1)
            self.assertIsNone(receipt['lastDurableCheckpoint'])
            self.assertTrue(receipt['updatesAreNotDurableCheckpointEvidence'])

    def test_prepared_membership_is_not_actual_optimizer_exposure(self):
        plan = {'sources': [{'sourceId': 'long', 'windows': 64}, {'sourceId': 'short', 'windows': 1}]}
        actual = {'source_windows': {'long': 64}, 'complete_history': True}
        receipt = SMOKE.training_exposure(plan, actual)
        self.assertEqual(receipt['selectedSources'], 2)
        self.assertEqual(receipt['exposedSources'], 1)
        self.assertEqual(receipt['unexposedSourceIds'], ['short'])
        self.assertFalse(receipt['everySelectedSourceExposed'])
        actual['source_windows']['short'] = 1
        self.assertTrue(SMOKE.training_exposure(plan, actual)['everySelectedEpisodeVisitedAllWindows'])
        actual['complete_history'] = False
        self.assertFalse(SMOKE.training_exposure(plan, actual)['everySelectedSourceExposed'])
        actual['source_windows']['foreign'] = 1
        with self.assertRaisesRegex(ValueError, 'foreign'):
            SMOKE.training_exposure(plan, actual)

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

    def test_successful_tokens_come_from_original_selections_and_decode_exactly(self):
        profile = {'complete': True, 'droppedRecords': 0, 'records': [
            {'operation': 'select', 'ok': True, 'selectionAuthority': 'model'}]}
        self.assertFalse(SMOKE.generated_token_cost(profile)['complete'])
        codec = SimpleNamespace(fingerprint='codec', decode=lambda tokens: bytes(tokens))
        actual = {'selections': [{'record': 'ok', 'selection': {
            'modelSelected': True, 'codecFingerprint': 'codec',
            'fragments': [{'selectedEventId': 'first', 'emittedTokenIds': [111, 107], 'payloadHex': '6f6b'}]}}]}
        receipt = SMOKE.generated_token_cost(profile, actual, codec)
        self.assertTrue(receipt['complete'])
        self.assertEqual(receipt['generatedTokens'], 2)
        actual['selections'][0]['selection']['fragments'][0]['emittedTokenIds'] = [0]
        with self.assertRaisesRegex(ValueError, 'reconstruct original'):
            SMOKE.generated_token_cost(profile, actual, codec)

    def test_failed_select_without_original_emissions_is_not_exact_zero(self):
        profile = {'complete': True, 'droppedRecords': 0, 'records': [{
            'operation': 'select', 'ok': False, 'failure': {'category': 'RuntimeError', 'evidence': None}}]}
        receipt = SMOKE.generated_token_cost(profile)
        self.assertEqual(receipt['generatedTokens'], 0)
        self.assertFalse(receipt['complete'])
        self.assertEqual(receipt['scope'], 'retained-native-token-lower-bound')
        profile['records'][0]['failure'] = {'category': 'SemanticSelectionError', 'evidence': {
            'fragments': [{'selectedEventId': 'failed', 'emittedTokenIds': [7], 'payloadHex': '07'}]}}
        self.assertTrue(SMOKE.generated_token_cost(profile)['complete'])

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
