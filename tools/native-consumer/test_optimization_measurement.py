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
    def test_sampling_metadata_cannot_invent_exposure_without_changing_authenticated_payload(self):
        cursor = {'sampled_source_windows': {'actual': 2}, 'sampled_history_complete': True,
                  'dataset_fingerprint': 'frozen-stream'}
        payload = {'rank_state': [{'cursor': cursor}]}
        native_report = lambda cursors: {'source_windows': dict(cursors[0]['sampled_source_windows']),
            'complete_history': cursors[0]['sampled_history_complete']}
        metadata = {'source_sampling': native_report([cursor])}
        self.assertEqual(SMOKE.authenticated_source_sampling(payload, metadata, native_report,
            stream_fingerprint='frozen-stream'), metadata['source_sampling'])
        metadata['source_sampling']['source_windows']['invented'] = 1
        with self.assertRaisesRegex(ValueError, 'metadata differs'):
            SMOKE.authenticated_source_sampling(payload, metadata, native_report)
        metadata['source_sampling'] = native_report([cursor])
        with self.assertRaisesRegex(ValueError, 'prepared window plan'):
            SMOKE.authenticated_source_sampling(payload, metadata, native_report, stream_fingerprint='different-stream')

    def test_native_plan_inventory_is_recomputed_and_legacy_hashes_remain_immutable(self):
        original = {'sources': [{'sourceId': 'actual', 'windows': 3}], 'preparedIdentity': 'prepared'}
        rebuilt = {**original, 'streamFingerprint': 'native-fingerprint'}
        with patch.object(SMOKE, 'native_window_plan', return_value=rebuilt):
            self.assertEqual(SMOKE.verify_native_window_plan(original, None, None, None), rebuilt)
            self.assertNotIn('streamFingerprint', original)
            with self.assertRaisesRegex(ValueError, 'inventory differs'):
                SMOKE.verify_native_window_plan({**original, 'sources': [{'sourceId': 'actual', 'windows': 1}]}, None, None, None)
        with self.assertRaisesRegex(ValueError, 'duplicate'):
            SMOKE.training_exposure({'sources': [{'sourceId': 'same', 'windows': 1}] * 2},
                {'source_windows': {'same': 2}, 'complete_history': True})

    def test_partial_checkpoint_requires_committed_metadata_and_both_payload_hashes(self):
        with TemporaryDirectory() as root:
            training = Path(root) / 'training'
            checkpoint = training / 'checkpoints/P1-000000002-paused'
            checkpoint.mkdir(parents=True)
            (training / 'metrics.jsonl').write_text('')
            state, bank = checkpoint/'state.pt', checkpoint/'transducer.pt'
            state.write_bytes(b'synthetic-state');bank.write_bytes(b'synthetic-bank')
            metadata = {'checkpoint_name': checkpoint.name, 'state_sha256': SMOKE.sha256(state),
                        'transducer_checkpoint': {'file': bank.name, 'sha256': SMOKE.sha256(bank)}}
            SMOKE.write_json(checkpoint/'metadata.json', metadata)
            SMOKE.write_json(checkpoint.parent/'latest.json', {'checkpoint': checkpoint.name,
                'metadata_sha256': SMOKE.sha256(checkpoint/'metadata.json')})
            receipt = SMOKE.partial_training_receipt(root)
            self.assertTrue(receipt['lastDurableCheckpoint']['checkpointFilesVerified'])
            self.assertFalse(receipt['lastDurableCheckpoint']['nativePayloadLoadVerified'])
            state.unlink()
            self.assertIsNone(SMOKE.partial_training_receipt(root)['lastDurableCheckpoint'])
            state.write_bytes(b'corrupt-state')
            self.assertIsNone(SMOKE.partial_training_receipt(root)['lastDurableCheckpoint'])
            state.write_bytes(b'synthetic-state');bank.write_bytes(b'corrupt-bank')
            self.assertIsNone(SMOKE.partial_training_receipt(root)['lastDurableCheckpoint'])
            bank.write_bytes(b'synthetic-bank')
            metadata['source_sampling'] = {'invented': 1}
            SMOKE.write_json(checkpoint/'metadata.json', metadata)
            self.assertIsNone(SMOKE.partial_training_receipt(root)['lastDurableCheckpoint'])

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

    def run_rollout(self, root, *, rejected=False, timed_out=False, invalid_result=False,
                    missing_tokenizer=False, missing_cleanup=False, missing_profile=False):
        identity = 'a' * 64
        tokenizer = 'b' * 64
        inference = {'schema': 'semantic-inference-identity/4', 'seed': 17,
                     'checkpointIdentity': identity, 'tokenizerIdentity': tokenizer}
        outcome = {'cleanup': {'pendingEffects': 0, 'pendingJobs': 0, 'openHandlers': 0},
                   'completion': {'kind': 'return', 'value': 7},
                   'state': {}, 'effects': [], 'callbacks': []}
        case = {'index': 0, 'id': 'case', 'family': 'source', 'expected': outcome,
                'envelope': {'schema': 'semantic-evaluation-request/4', 'caseId': 'case',
                             'representation': 'compact', 'seed': 17, 'request': {'source': 'public'}}}
        profile = {'schema': 'semantic-serving-profile/1', 'complete': True,
                   'runtimeClosed': True, 'optimizerSteps': 0, 'declaredOrigin': 'trained',
                   'initialization': dict(inference), 'droppedRecords': 0,
                   'identity': {'modelSha256': identity, 'tokenizerIdentity': tokenizer},
                   'records': [{'selectedEventId': 'one', 'emittedTokenIds': [7, 8]}]}
        actual = {'schema': 'semantic-evaluation-result/4', 'origin': 'trained',
                  'representation': 'compact',
                  'checkpointIdentity': identity, 'inferenceIdentity': dict(inference),
                  'episode': {'sidecar': {'sourceLineage': 'evaluation:case',
                                          'selectionOrigin': 'actual-model-selected',
                                          'evidenceKind': 'model-evaluation'}},
                  'failure': None, 'outcome': json.loads(json.dumps(outcome)), 'costs': {'computeSeconds': 1},
                  'rejections': [{'phase': 'semantic-validation'}] if rejected else [],
                  'hardGates': {key: 0 for key in ['futureObservationLeaks', 'unauthorizedEffects',
                    'untrackedNativeFallback', 'falseAdmissions', 'replayNativeEffects']}}
        if missing_tokenizer:
            del actual['inferenceIdentity']['tokenizerIdentity']
        if missing_cleanup:
            del actual['outcome']['cleanup']['openHandlers']

        class FakeProcess:
            def __init__(self, argv, **kwargs):
                self.pid, self.returncode = 123, 0
                self.output = kwargs['stdout']
                self.destination = Path(self.output.name).parent
                if not missing_profile:
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
            result = SMOKE.rollout(case, 'trained', {'bundle': '/bundle', 'model_sha256': identity,
                                                   'codec_fingerprint': tokenizer},
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

    def test_missing_tokenizer_binding_remains_a_failed_original_result(self):
        with TemporaryDirectory() as root:
            result = self.run_rollout(root, missing_tokenizer=True)
            self.assertFalse(result['wholeTaskSuccess'])
            self.assertFalse(result['traceValid'])
            self.assertEqual(result['pipelineFailure'], 'invalid-evaluator-result')
            self.assertIn('tokenizer', result['resultError'])
            self.assertEqual(result['generatedTokenCost']['generatedTokens'], 2)

    def test_missing_cleanup_counter_cannot_become_a_success(self):
        with TemporaryDirectory() as root:
            result = self.run_rollout(root, missing_cleanup=True)
            self.assertFalse(result['wholeTaskSuccess'])
            self.assertFalse(result['traceValid'])
            self.assertEqual(result['pipelineFailure'], 'invalid-evaluator-result')
            self.assertIn('Cleanup', result['resultError'])
            self.assertEqual(result['generatedTokenCost']['generatedTokens'], 2)

    def test_missing_native_profile_preserves_failed_summary_and_unknown_cost(self):
        with TemporaryDirectory() as root:
            result = self.run_rollout(root, missing_profile=True)
            self.assertFalse(result['wholeTaskSuccess'])
            self.assertFalse(result['traceValid'])
            self.assertEqual(result['pipelineFailure'], 'invalid-evaluator-result')
            self.assertIn('serving profile', result['resultError'])
            self.assertIsNone(result['generatedTokenCost'])
            self.assertTrue((Path(root) / 'trained/0000/summary.json').is_file())


if __name__ == '__main__':
    unittest.main()
