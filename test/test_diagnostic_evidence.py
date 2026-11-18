"""Fail-closed diagnostic scoring and optional real-checkpoint tamper checks."""
import copy
import importlib.util
import json
import os
from pathlib import Path
import shutil
import tempfile
import unittest

TOOLS = Path(__file__).resolve().parents[1] / 'tools'


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, TOOLS / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


smoke = load('optimization_diagnostic', 'run-optimization-smoke.py')
holdout = load('heldout_diagnostic', 'run-exploratory-holdout.py')
inventory = load('diagnostic_inventory', 'diagnostic_training_inventory.py')


class RolloutEvidence(unittest.TestCase):
    def setUp(self):
        self.bundle = {'model_sha256': 'a' * 64, 'codec_fingerprint': 'b' * 64}
        identity = {'schema': 'semantic-inference-identity/4', 'seed': 17,
                    'checkpointIdentity': 'a' * 64, 'tokenizerIdentity': 'b' * 64}
        outcome = {'completion': {'kind': 'return', 'value': ['number', 1]}, 'state': {},
                   'effects': [], 'callbacks': [], 'cleanup': dict.fromkeys(smoke.CLEANUP_NAMES, 0)}
        self.case = {'id': 'case-a', 'envelope': {'schema': 'semantic-evaluation-request/4',
                     'caseId': 'case-a', 'seed': 17, 'representation': 'compact'}, 'expected': outcome}
        self.actual = {'schema': 'semantic-evaluation-result/4', 'origin': 'trained',
                       'representation': 'compact', 'checkpointIdentity': 'a' * 64,
                       'inferenceIdentity': copy.deepcopy(identity), 'outcome': copy.deepcopy(outcome),
                       'failure': None, 'hardGates': dict.fromkeys(smoke.HARD_GATE_NAMES, 0),
                       'episode': {'sidecar': {'sourceLineage': 'evaluation:case-a',
                       'selectionOrigin': 'actual-model-selected', 'evidenceKind': 'model-evaluation'}}}
        self.profile = {'schema': 'semantic-serving-profile/1', 'complete': True,
                        'runtimeClosed': True, 'optimizerSteps': 0, 'initialization': identity,
                        'declaredOrigin': 'trained', 'identity': {'modelSha256': 'a' * 64,
                        'tokenizerIdentity': 'b' * 64}}

    def score(self):
        return smoke.score_rollout(self.actual, self.case, 'trained', self.bundle, self.profile)

    def test_only_complete_bound_execution_can_pass(self):
        self.assertTrue(self.score())
        self.actual['failure'] = {'category': 'SemanticSelectionError'}
        self.assertFalse(self.score())

    def test_empty_missing_extra_boolean_or_negative_gate_counters_refuse(self):
        original = copy.deepcopy(self.actual['hardGates'])
        for invalid in [{}, None, {**original, 'unexpected': 0},
                        {**original, 'falseAdmissions': False}, {**original, 'falseAdmissions': -1}]:
            with self.subTest(invalid=invalid):
                self.actual['hardGates'] = invalid
                with self.assertRaisesRegex(ValueError, 'Hard gates'):
                    self.score()

    def test_reported_gate_or_cleanup_failure_cannot_pass(self):
        self.actual['hardGates']['falseAdmissions'] = 1
        self.assertFalse(self.score())
        self.actual['hardGates']['falseAdmissions'] = 0
        self.actual['outcome']['cleanup']['pendingEffects'] = 1
        self.case['expected']['cleanup']['pendingEffects'] = 1
        self.assertFalse(self.score())

    def test_missing_cleanup_and_failure_evidence_refuse(self):
        self.actual['outcome']['cleanup'] = {}
        with self.assertRaisesRegex(ValueError, 'Cleanup'):
            self.score()
        self.setUp()
        del self.actual['failure']
        with self.assertRaisesRegex(ValueError, 'failure evidence'):
            self.score()

    def test_result_cannot_be_substituted_from_another_case_seed_model_or_codec(self):
        changes = [('origin', 'fixed-weights'), ('representation', 'expanded'),
                   ('checkpointIdentity', 'c' * 64), ('schema', 'semantic-evaluation-result/3')]
        for field, value in changes:
            with self.subTest(field=field):
                self.setUp(); self.actual[field] = value
                with self.assertRaisesRegex(ValueError, 'identity differs'):
                    self.score()
        for field, value in [('seed', 29), ('checkpointIdentity', 'c' * 64), ('tokenizerIdentity', 'c' * 64)]:
            with self.subTest(field=field):
                self.setUp(); self.actual['inferenceIdentity'][field] = value
                with self.assertRaisesRegex(ValueError, 'identity differs'):
                    self.score()
        self.setUp(); self.actual['episode']['sidecar']['sourceLineage'] = 'evaluation:case-b'
        with self.assertRaisesRegex(ValueError, 'identity differs'):
            self.score()

    def test_incomplete_or_wrong_serving_profile_refuses(self):
        for field, value in [('complete', False), ('runtimeClosed', False), ('optimizerSteps', True)]:
            with self.subTest(field=field):
                self.setUp(); self.profile[field] = value
                with self.assertRaisesRegex(ValueError, 'serving profile'):
                    self.score()

    def test_boolean_does_not_equal_integer_in_an_outcome(self):
        self.actual['outcome']['state'] = {'value': False}
        self.case['expected']['state'] = {'value': 0}
        self.assertFalse(self.score())


class InventoryEvidence(unittest.TestCase):
    def test_omitted_extra_duplicate_or_changed_native_episode_is_not_authenticated(self):
        prepared = {'episode-a': {'episodeSha256': 'a'}, 'episode-b': {'episodeSha256': 'b'}}
        inventory.require_inventory_match(prepared, copy.deepcopy(prepared))
        for declared in [{'episode-a': prepared['episode-a']},
                         {**prepared, 'episode-c': {'episodeSha256': 'c'}},
                         {**prepared, 'episode-b': {'episodeSha256': 'altered'}}]:
            with self.subTest(declared=declared), self.assertRaises(ValueError):
                inventory.require_inventory_match(prepared, declared)


@unittest.skipUnless(os.environ.get('TRACING_DIAGNOSTIC_RUN'),
                     'Requires an actual retained diagnostic checkpoint via TRACING_DIAGNOSTIC_RUN')
class ActualBundleTampering(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.training = json.loads((Path(os.environ['TRACING_DIAGNOSTIC_RUN']) / 'report.json').read_text())

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)
        original = Path(self.training['trainedBundle']['bundle'])
        for source in original.iterdir():
            if source.name == 'model.safetensors':
                (self.directory / source.name).symlink_to(source)
            elif source.is_file():
                shutil.copyfile(source, self.directory / source.name)
        self.info = {**self.training['trainedBundle'], 'bundle': str(self.directory)}

    def verify(self):
        return holdout.verify_bundle(self.info, self.training['checkpointVerification']['checkpoint'],
                                     self.training['checkpointVerification']['stateSha256'],
                                     self.training['tokenizerSha256'], self.training['tokenizerIdentity'])

    def update_manifest(self, **changes):
        path = self.directory / 'manifest.json'
        value = json.loads(path.read_text()); value.update(changes)
        path.write_text(json.dumps(value))

    def test_actual_original_bundle_passes(self):
        receipt = self.verify()
        self.assertTrue(receipt['tensorsExact'])
        self.assertTrue(receipt['transducerBankExact'])

    def test_rehashed_served_tokenizer_cannot_replace_frozen_codec(self):
        path = self.directory / 'tokenizer.json'
        path.write_text(path.read_text() + ' ')
        self.update_manifest(tokenizer_sha256=smoke.sha256(path))
        with self.assertRaisesRegex(ValueError, 'tokenizer differs'):
            self.verify()

    def test_rehashed_model_config_cannot_replace_checkpoint_config(self):
        path = self.directory / 'model_config.json'
        value = json.loads(path.read_text()); value['checkpoint_stages'] = True
        path.write_text(json.dumps(value)); self.update_manifest(config_sha256=smoke.sha256(path))
        with self.assertRaisesRegex(ValueError, 'model config differs'):
            self.verify()

    def test_rehashed_transducer_bank_cannot_replace_checkpoint_bank(self):
        import torch
        path = self.directory / 'transducer.pt'
        value = torch.load(path, weights_only=True, map_location='cpu')
        value['bank']['version'] += 1
        torch.save(value, path); self.update_manifest(transducer_sha256=smoke.sha256(path))
        with self.assertRaisesRegex(ValueError, 'transducer bank differs'):
            self.verify()

    def test_model_version_cannot_be_relabelled(self):
        self.update_manifest(model_version=0)
        with self.assertRaisesRegex(ValueError, 'checkpoint version'):
            self.verify()

    @unittest.skipUnless(os.environ.get('TRACING_DIAGNOSTIC_CONSUMER'), 'Requires the exact companion checkout')
    def test_declared_input_subset_cannot_omit_an_actual_training_member(self):
        training_root = Path(os.environ['TRACING_DIAGNOSTIC_RUN'])
        report = copy.deepcopy(self.training); report['inputIdentities'].pop()
        (self.directory / 'report.json').write_text(json.dumps(report))
        (self.directory / 'train-config.json').symlink_to(training_root / 'train-config.json')
        # The source revision has already been pinned by the genuine run. The
        # companion checkout is explicitly supplied for this optional integration test.
        consumer = Path(os.environ['TRACING_DIAGNOSTIC_CONSUMER'])
        tokenizer = Path(json.loads((training_root / 'train-config.json').read_text())['codec'])
        with self.assertRaisesRegex(ValueError, 'actual prepared native inventory'):
            inventory.inspect_training_inventory(self.directory, consumer, tokenizer)


if __name__ == '__main__':
    unittest.main()
