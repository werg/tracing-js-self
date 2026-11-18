"""Synthetic finite-vector fixtures test comparison only, never claim model parity.

The optional native test executes a real tiny model's conditional hook with a
built-in byte codec, then stops before sampling. It is not source qualification,
complete training/serving equivalence, or a learned execution result.
"""
import copy
import importlib.util
import inspect
import os
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT/'tools'))
import native_conditional_probe as P


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
            (lambda p: p.update(capturedBeforePolicyDraw=False), 'pre-sampling'),
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


@unittest.skipUnless(importlib.util.find_spec('torch') and os.environ.get('MEGATOKEN_REPOSITORY'),
                     'Actual conditional hook requires local Torch and an explicit companion checkout')
class ActualNativeHookTests(unittest.TestCase):
    def test_real_native_prior_is_captured_before_sampling_and_hook_is_restored(self):
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
            self.fail('The hook must stop before any native policy selection')
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
