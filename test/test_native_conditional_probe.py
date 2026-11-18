"""Synthetic finite-vector fixtures test comparison only, never claim model parity.

The optional native test executes a real tiny model's conditional hook with a
built-in byte codec, then stops before the Gaussian facet draw. It is not source qualification,
complete training/serving equivalence, or a learned execution result.
"""
import copy
from contextlib import ExitStack
import importlib.util
import inspect
import json
import os
from pathlib import Path
import sys
import tempfile
from types import ModuleType, SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT/'tools'))
import native_conditional_probe as P

CLI_SPEC = importlib.util.spec_from_file_location('conditional_probe_cli', ROOT/'tools/probe-native-conditionals.py')
CLI = importlib.util.module_from_spec(CLI_SPEC)
CLI_SPEC.loader.exec_module(CLI)


def fixture(path):
    return {'schema': P.SCHEMA, 'path': path, 'dropoutDisabled': True,
        'capturedBeforePolicyDraw': True, 'modelSelections': 0, 'optimizerSteps': 0,
        'identity': {key: 'a'*64 for key in ('checkpointStateSha256', 'servedModelSha256',
                                            'tokenizerIdentity', 'publicPrefixSha256', 'firstTargetSha256')},
        'conditional': {'mean': {'shape': [1, 1, 2, 2], 'values': [.1, -.2, .3, -.4]},
                        'logScale': {'shape': [1, 1, 2, 2], 'values': [-2.0]*4}},
        'encoderCallSha256': 'b'*64}


class ComparisonTests(unittest.TestCase):
    def test_actual_vector_layout_and_first_numeric_difference_are_explicit(self):
        a, b = fixture('training'), fixture('serving')
        result = P.compare_priors(a, b)
        self.assertEqual(result['status'], 'passed')
        self.assertEqual(result['comparedCoordinates'], 8)
        self.assertEqual(result['downstreamLexicalAndActionParity'], 'unmeasured')
        b['conditional']['mean']['values'][2] += .01
        result = P.compare_priors(a, b)
        self.assertEqual(result['status'], 'failed')
        self.assertEqual(result['firstDivergence']['field'], 'mean')
        self.assertEqual(result['firstDivergence']['flatIndex'], 2)

    def test_identity_dropout_missing_and_nonfinite_never_become_parity(self):
        a, b = fixture('training'), fixture('serving')
        self.assertEqual(P.compare_priors(a, None)['status'], 'unmeasured')
        for mutate, pattern in [
            (lambda p: p['identity'].update(publicPrefixSha256='c'*64), 'identity differs'),
            (lambda p: p.update(dropoutDisabled=False), 'disabled-dropout'),
            (lambda p: p.update(capturedBeforePolicyDraw=False), 'Gaussian facet draw'),
            (lambda p: p['conditional']['mean']['values'].append(1), 'shape'),
            (lambda p: p['conditional']['mean']['values'].__setitem__(0, float('nan')), 'finite')]:
            changed = copy.deepcopy(b); mutate(changed)
            with self.assertRaisesRegex(ValueError, pattern): P.compare_priors(a, changed)
        for tol in (float('nan'), float('inf'), -.1, .01):
            with self.assertRaisesRegex(ValueError, 'tolerance'): P.compare_priors(a, b, atol=tol)

    def test_shape_mismatch_fails_and_input_drift_is_not_hidden_by_equal_gaussians(self):
        a, b = fixture('training'), fixture('serving')
        b['conditional']['logScale']['shape'] = [1, 1, 1, 4]
        self.assertEqual(P.compare_priors(a, b)['firstDivergence']['reason'], 'shape')
        b = fixture('serving'); b['encoderCallSha256'] = 'c'*64
        result = P.compare_priors(a, b)
        self.assertEqual(result['status'], 'passed', 'Numerical state equality alone is the narrow metric')
        self.assertFalse(result['encoderCallAuditIdentical'])
        self.assertEqual(result['downstreamLexicalAndActionParity'], 'unmeasured')

    def test_changed_native_decoder_body_leaves_support_unmeasured(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory)/'decoder.py'
            source.write_text('class Decoder:\n    def _teacher_raw_impl(self, core, context, plan):\n        return {}\n')
            result = P.decoder_support_comparison(source, {})
            self.assertEqual(result['status'], 'unmeasured')
            self.assertIn('implementation changed', result['reason'])
            source.write_text('class Decoder:\n    pass\n')
            self.assertEqual(P.decoder_support_comparison(source, {})['status'], 'unmeasured')


class CheckpointBindingTests(unittest.TestCase):
    """Exercise identity orchestration with native I/O doubles, without model claims."""

    def run_existing_checkpoint(self, *, different_export=False):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            consumer = root/'consumer'; consumer.mkdir()
            checkpoints = root/'checkpoints'; checkpoints.mkdir()
            first, second = checkpoints/'first', checkpoints/'second'
            first.mkdir(); second.mkdir()
            latest = checkpoints/'latest.json'
            latest.write_text(json.dumps({'checkpoint': 'first'}))
            episode_path = root/'episode.json'
            episode = {'sidecar': {'admission': 'admitted', 'split': 'train',
                'producerRevision': '1'*40, 'nativePolicy': {'consumerRevision': '2'*40}}}
            episode_path.write_text(json.dumps(episode))
            packet = {'exported': episode, 'episodeSha256': CLI.SMOKE.sha256(episode_path),
                'sourceAdmission': {'identityDigest': 'e'*64}, 'prefix': {'case': 'checkpoint-binding'},
                'firstTarget': {'record': 'semantic target'}}
            resolutions, reads = [], []

            def physical(path):
                path = Path(path)
                return path/json.loads((path/'latest.json').read_text())['checkpoint'] \
                    if (path/'latest.json').is_file() else path

            def resolve(path):
                resolutions.append(str(path))
                return physical(path)

            def load(path):
                selected = physical(path)
                reads.append(('metadata', str(selected)))
                # A concurrent trainer advances latest after the first read.
                latest.write_text(json.dumps({'checkpoint': 'second'}))
                return {'global_step': 17}, {'state_sha256': ('a' if selected == first else 'b')*64}

            def export(path, destination):
                selected = physical(path)
                reads.append(('export', str(selected)))
                return {'checkpoint_sha256': ('b' if different_export or selected != first else 'a')*64,
                    'model_sha256': 'c'*64, 'codec_fingerprint': 'd'*64, 'servedReloadExact': True}

            def training(path, prepared, source, *, identity, seed):
                reads.append(('training', str(physical(path))))
                result = fixture('training'); result['identity'] = identity
                return result

            def serving(path, source, *, identity, seed, max_tokens):
                result = fixture('serving'); result['identity'] = identity
                return result

            native = ModuleType('megatoken.training.checkpoint')
            native.resolve_checkpoint, native.load_checkpoint = resolve, load
            fake_torch = ModuleType('torch'); fake_torch.set_num_threads = lambda count: None
            output = root/'report'
            argv = ['probe-native-conditionals.py', '--consumer-root', str(consumer),
                '--episode', str(episode_path), '--checkpoint', str(checkpoints),
                '--prepared', str(root/'prepared'), '--output', str(output)]
            error = None
            with ExitStack() as stack:
                stack.enter_context(patch.object(sys, 'argv', argv))
                stack.enter_context(patch.object(sys, 'path', list(sys.path)))
                stack.enter_context(patch.dict(sys.modules, {'torch': fake_torch,
                    'megatoken.training.checkpoint': native}))
                stack.enter_context(patch.object(CLI.SMOKE, 'require_clean_checkout'))
                stack.enter_context(patch.object(CLI.SMOKE, 'git_head',
                    side_effect=lambda path: ('2' if path == consumer else '1')*40))
                stack.enter_context(patch.object(CLI.subprocess, 'check_output', return_value=json.dumps(packet)))
                stack.enter_context(patch.object(CLI, 'source_bindings', return_value=[]))
                stack.enter_context(patch.object(CLI.SMOKE, 'export_checked', side_effect=export))
                stack.enter_context(patch.object(CLI, 'training_capture', side_effect=training))
                stack.enter_context(patch.object(CLI, 'serving_capture', side_effect=serving))
                stack.enter_context(patch.object(CLI, 'decoder_support_comparison', return_value={'status': 'unmeasured'}))
                stack.enter_context(patch('builtins.print'))
                try:
                    result = CLI.main()
                except ValueError as caught:
                    result, error = None, str(caught)
            return {'exit': result, 'error': error, 'resolutions': resolutions, 'reads': reads,
                'first': str(first), 'request': str(checkpoints),
                'latest': json.loads(latest.read_text())['checkpoint'],
                'report': json.loads((output/'report.json').read_text())}

    def test_moving_latest_is_resolved_once_before_all_checkpoint_reads(self):
        result = self.run_existing_checkpoint()
        self.assertEqual(result['exit'], 0, result['error'])
        self.assertEqual(result['latest'], 'second', 'The fixture must actually advance the pointer')
        self.assertEqual(result['resolutions'], [result['request']])
        self.assertEqual(result['reads'], [(kind, result['first']) for kind in ('metadata', 'export', 'training')])
        report = result['report']
        self.assertEqual(report['checkpoint'], result['first'])
        self.assertEqual(report['checkpointRequest'], result['request'])
        self.assertEqual(report['identity']['checkpointStateSha256'], 'a'*64)
        self.assertEqual(report['status'], 'measured')
        self.assertFalse(report['fullConditionalParityClaim'])

    def test_changed_export_is_incomplete_before_any_capture(self):
        result = self.run_existing_checkpoint(different_export=True)
        self.assertIn('Exported served bundle checkpoint identity differs', result['error'])
        self.assertEqual([kind for kind, _ in result['reads']], ['metadata', 'export'])
        self.assertEqual(result['report']['status'], 'unmeasured')
        self.assertEqual(result['report']['phase'], 'capture-incomplete')
        self.assertEqual(result['report']['modelSelections'], 0)
        self.assertEqual(result['report']['optimizerSteps'], 0)

    def test_actual_reload_metadata_must_match_before_native_capture(self):
        loading, served = ModuleType('megatoken.loading'), ModuleType('megatoken.served')
        identity = {'checkpointStateSha256': 'a'*64}
        for actual in ('b'*64, None):
            with self.subTest(actual=actual):
                loading.load_trained = lambda *args, **kwargs: SimpleNamespace(metadata={'state_sha256': actual})
                served.ServedBundle = lambda *args, **kwargs: SimpleNamespace(manifest={'checkpoint_sha256': actual})
                with patch.dict(sys.modules, {'megatoken.loading': loading, 'megatoken.served': served}):
                    with self.assertRaisesRegex(ValueError, 'Actual training reload.*checkpoint'):
                        CLI.training_capture('checkpoint', 'prepared', {}, identity=identity, seed=17)
                    with self.assertRaisesRegex(ValueError, 'Actual served reload.*checkpoint'):
                        CLI.serving_capture('served', {}, identity=identity, seed=17, max_tokens=128)


@unittest.skipUnless(importlib.util.find_spec('torch') and os.environ.get('MEGATOKEN_REPOSITORY'),
                     'Actual conditional hook requires local Torch and an explicit companion checkout')
class ActualNativeHookTests(unittest.TestCase):
    def test_real_native_prior_is_captured_before_gaussian_draw_and_hook_is_restored(self):
        sys.path.insert(0, str(Path(os.environ['MEGATOKEN_REPOSITORY']).resolve()/'src'))
        import torch
        from megatoken.generation.codec import ByteCodec
        from megatoken.generation.structure import ActionSpec
        from megatoken.loading import build_model, load_model_config
        from megatoken.model.multitrack import MultiTrackGenerator
        torch.set_num_threads(1); torch.manual_seed(17)
        codec = ByteCodec.byte_fallback()
        model = build_model(load_model_config('tiny', vocab_size=codec.vocab_size), codec)
        model.eval()
        multi = MultiTrackGenerator.of(model)
        state = multi.tracks.initial_state(1, device='cpu')
        original = inspect.getattr_static(MultiTrackGenerator, '_sample_policy')
        def operation():
            multi.select_group(state, tracks=('task',), controls=(b'public instruction',),
                               specs=(ActionSpec(max_tokens=16),), effort=1)
            self.fail('The hook must stop before the Gaussian facet draw or returned selection')
        result = P.capture_prior(operation, model, path='serving', identity=fixture('serving')['identity'])
        self.assertIs(inspect.getattr_static(MultiTrackGenerator, '_sample_policy'), original)
        self.assertEqual(result['conditional']['mean']['shape'], [1, 1, 4, 32])
        self.assertEqual(result['modelSelections'], 0)
        self.assertTrue(result['capturedBeforePolicyDraw'])
        self.assertTrue(result['encoderCalls'])
        model.train()
        with self.assertRaisesRegex(ValueError, 'dropout disabled'):
            P.capture_prior(operation, model, path='serving', identity=fixture('serving')['identity'])


if __name__ == '__main__': unittest.main()
