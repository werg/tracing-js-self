"""Statistical fixtures are synthetic and never constitute model evidence."""
import copy
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import learning_evaluation as learning


def case(identifier, component, split='test', slices=None):
    return {'id': identifier, 'family': component, 'sourceCluster': 'component:' + component,
            'split': split, 'slices': slices or ['new-source', 'effects', 'valid-errors', 'cleanup'],
            'envelope': {'caseId': identifier, 'seed': 17, 'request': {}}}


def measured(identifier, success, identity='trained'):
    return {'id': identifier, 'wholeTaskSuccess': success, 'traceValid': True,
            'checkpointIdentity': identity, 'hardGates': {key: 0 for key in learning.GATES},
            'wallSeconds': 2, 'generatedTokenCost': {'generatedTokens': 10, 'complete': True}}


def experiment():
    return {'schema': learning.SCHEMA, 'mode': 'confirmatory', 'optimizerSeeds': [17, 29, 43],
            'decoderSeed': 17, 'initializationSeed': 17, 'baseOrigin': 'newly-initialized', 'checkpointSteps': [2, 4],
            'rolloutBudget': {'tokensPerDecision': 32, 'secondsPerCase': 120},
            'policy': {'minimumUsefulImprovement': 0.1, 'maximumCriticalSliceRegression': 0.05,
                       'confidence': 0.95, 'bootstrapReplicates': 200, 'bootstrapSeed': 89,
                       'minimumConfirmatoryTestComponents': 2},
            'training': [case('train', 'train', 'train')],
            'validation': [case('validation', 'validation', 'validation')],
            'test': [case('one', 'one'), case('two', 'two')]}


def run(expt, seed):
    candidates = [{'step': step, 'checkpointIdentity': f'trained-{seed}-{step}',
                   'cases': [measured('validation', step == 4, f'trained-{seed}-{step}')]} for step in (2, 4)]
    chosen = learning.choose_validation_checkpoint(expt, candidates)
    return {'optimizerSeed': seed, 'optimizerSteps': 4, 'baseIdentity': 'base',
            'selectedCheckpointExposureAssessment': {'everySelectedEpisodeVisitedAllWindows': True},
            'trainedIdentity': chosen['checkpointIdentity'], 'validation': candidates,
            'selection': chosen, 'base': [measured(row['id'], False, 'base') for row in expt['test']],
            'trained': [measured(row['id'], True, chosen['checkpointIdentity']) for row in expt['test']]}


class FrozenLearningTests(unittest.TestCase):
    def test_native_fragment_budget_is_not_a_whole_decision_cap(self):
        expt = experiment()
        budget = learning.selected_rollout_budget(expt)
        self.assertEqual(budget['nativeMaxTokensPerFragment'], 32)
        self.assertEqual(budget['maximumFragmentsPerDecision'], 64)
        self.assertEqual(budget['declaration'], 'legacy-tokensPerDecision-meant-per-fragment')
        expt['rolloutBudget'] = {'nativeMaxTokensPerFragment': 16, 'maximumFragmentsPerDecision': 64,
                                 'secondsPerCase': 30}
        self.assertEqual(learning.selected_rollout_budget(expt)['declaration'], 'explicit-per-fragment')
        expt['rolloutBudget']['maximumFragmentsPerDecision'] = 1
        with self.assertRaisesRegex(ValueError, 'inference budget'):
            learning.require_frozen_experiment(expt)

    def test_training_window_policy_is_frozen_and_bounded(self):
        expt = experiment()
        expt['trainingBudget'] = {'sampler': 'native-sequential-permuted-episodes',
            'maxWindowRecords': 256, 'maxScoredDecisions': 256, 'maxWindowTokens': 16384, 'seconds': 900}
        learning.require_frozen_experiment(expt)
        expt['trainingBudget']['sampler'] = 'undeclared-resampling'
        with self.assertRaisesRegex(ValueError, 'sampling policy'):
            learning.require_frozen_experiment(expt)

    def test_family_weighting_keeps_variants_from_dominating(self):
        cases = [case(f'variant-{index}', 'many') for index in range(100)] + [case('single', 'other')]
        rows = [measured(item['id'], item['family'] == 'many') for item in cases]
        metrics = learning.arm_metrics(cases, rows)
        self.assertEqual(metrics['familyWeightedWholeTaskSuccess'], 0.5)
        self.assertEqual(metrics['episodeWeightedWholeTaskSuccess'], 100 / 101)
        self.assertEqual(metrics['independentComponents'], 2)
        self.assertEqual(metrics['generatedTokensPerCorrectTask'], 10.1)

    def test_missing_or_duplicate_results_do_not_leave_denominator(self):
        cases = [case('one', 'one'), case('two', 'two')]
        with self.assertRaisesRegex(ValueError, 'Missing'):
            learning.arm_metrics(cases, [measured('one', True)])
        with self.assertRaisesRegex(ValueError, 'Duplicate'):
            learning.arm_metrics(cases, [measured('one', True), measured('one', False)])

    def test_rejected_or_integrity_violating_success_is_refused(self):
        for change in [{'rejections': [{}]}, {'hardGates': {}}, {'traceValid': False}, {'pipelineFailure': 'timeout'}]:
            row = {**measured('one', True), **change}
            with self.assertRaisesRegex(ValueError, 'cannot count'):
                learning.arm_metrics([case('one', 'one')], [row])

    def test_validation_only_selection_and_frozen_schedule(self):
        expt = experiment()
        candidates = run(expt, 17)['validation']
        selected = learning.choose_validation_checkpoint(expt, candidates)
        self.assertEqual(selected['step'], 4)
        self.assertFalse(selected['testUsedForSelection'])
        candidates[0]['cases'][0]['wholeTaskSuccess'] = True
        self.assertEqual(learning.choose_validation_checkpoint(expt, candidates)['step'], 2)
        candidates[0]['cases'] = [measured('one', True)]
        with self.assertRaisesRegex(ValueError, 'foreign'):
            learning.choose_validation_checkpoint(expt, candidates)
        with self.assertRaisesRegex(ValueError, 'Missing frozen'):
            learning.choose_validation_checkpoint(expt, candidates[1:])

    def test_split_or_teacher_injection_is_rejected(self):
        expt = experiment()
        expt['test'][0]['sourceCluster'] = expt['training'][0]['sourceCluster']
        with self.assertRaisesRegex(ValueError, 'spans'):
            learning.require_frozen_experiment(expt)
        expt = experiment()
        expt['test'][0]['envelope']['request']['controlledSelectionsByRepresentation'] = {}
        with self.assertRaisesRegex(ValueError, 'teacher'):
            learning.require_frozen_experiment(expt)

    def test_paired_bootstrap_is_reproducible_and_groups_variants(self):
        first = learning.paired_component_interval({'a': 1, 'b': -1}, seed=17, replicates=1000)
        second = learning.paired_component_interval({'b': -1, 'a': 1}, seed=17, replicates=1000)
        self.assertEqual(first, second)
        self.assertEqual(first['components'], 2)
        self.assertLess(first['lower'], 0)
        self.assertGreater(first['upper'], 0)

    def test_confirmatory_gate_requires_actual_repeated_improvement_and_critical_slices(self):
        expt = experiment()
        runs = [run(expt, seed) for seed in expt['optimizerSeeds']]
        result = learning.summarize_learning(expt, runs)
        self.assertTrue(result['confirmatoryGatePassed'])
        self.assertEqual(result['meanImprovement'], 1)
        self.assertEqual(result['uncertainty']['lower'], 1)
        self.assertEqual(result['pureOutcomeTransfer']['status'], 'untested')
        self.assertFalse(result['teacherForcedLossIsExecutionAccuracy'])
        runs[0]['selectedCheckpointExposureAssessment'] = None
        self.assertFalse(learning.summarize_learning(expt, runs)['requirements']['completeSelectedCheckpointTrainingExposure'])
        runs[0]['selectedCheckpointExposureAssessment'] = {'everySelectedEpisodeVisitedAllWindows': True}
        runs[1]['baseIdentity'] = 'different-base'
        for row in runs[1]['base']:
            row['checkpointIdentity'] = 'different-base'
        result = learning.summarize_learning(expt, runs)
        self.assertFalse(result['generalizationClaim'])
        self.assertIn('sameActualBaseCheckpointAcrossSeeds', result['unmetRequirements'])

    def test_missing_seed_or_tampered_selection_is_refused(self):
        expt = experiment()
        runs = [run(expt, seed) for seed in expt['optimizerSeeds']]
        with self.assertRaisesRegex(ValueError, 'Missing optimizer'):
            learning.summarize_learning(expt, runs[:1])
        runs[0]['selection']['step'] = 2
        with self.assertRaisesRegex(ValueError, 'selection receipt changed'):
            learning.summarize_learning(expt, runs)

    def test_absent_slices_and_incomplete_token_costs_remain_untested(self):
        expt = experiment()
        for item in expt['test']:
            item['slices'] = ['new-source']
        runs = [run(expt, seed) for seed in expt['optimizerSeeds']]
        for row in runs[0]['trained']:
            row['generatedTokenCost']['complete'] = False
        result = learning.summarize_learning(expt, runs)
        self.assertFalse(result['generalizationClaim'])
        self.assertEqual(result['slices']['valid-errors']['status'], 'untested')
        self.assertIsNone(result['seeds'][0]['trained']['generatedTokens'])
        self.assertEqual(result['seeds'][0]['trained']['retainedGeneratedTokensLowerBound'], 20)

    def test_auxiliary_known_source_score_is_separate_and_keeps_all_reserved_cases(self):
        expt = experiment()
        expt['training'][0]['scenario'] = {'sourceKey': 'source', 'inputKey': 'old',
            'observationKey': 'observed', 'scheduleKey': 'ordered'}
        auxiliary = case('auxiliary', 'train', 'train', ['new-inputs-known-source'])
        auxiliary.update(evaluationRole='auxiliary-known-source', matchedTrainingId='train',
            auxiliarySlices=['new-inputs-known-source'], scenario={**expt['training'][0]['scenario'], 'inputKey': 'new'})
        expt['auxiliary'] = [auxiliary]
        runs = [run(expt, seed) for seed in expt['optimizerSeeds']]
        for item in runs:
            item['auxiliary'] = {'base': [measured('auxiliary', True, item['baseIdentity'])],
                'trained': [measured('auxiliary', False, item['trainedIdentity'])]}
        result = learning.summarize_learning(expt, runs)
        self.assertEqual(result['meanImprovement'], 1)
        extra = result['auxiliarySlices']['new-inputs-known-source']
        self.assertEqual(extra['meanImprovement'], -1)
        self.assertFalse(extra['includedInPrimaryHeldOutScore'])
        self.assertEqual(result['auxiliarySlices']['different-schedules']['status'], 'untested')
        runs[0]['auxiliary']['trained'] = []
        with self.assertRaisesRegex(ValueError, 'Missing evaluation'):
            learning.summarize_learning(expt, runs)
        expt['auxiliary'][0]['scenario']['inputKey'] = 'old'
        with self.assertRaisesRegex(ValueError, 'duplicates an optimized'):
            learning.require_frozen_experiment(expt)

    def test_timeout_without_complete_gate_receipt_blocks_integrity_claim(self):
        expt = experiment()
        runs = [run(expt, seed) for seed in expt['optimizerSeeds']]
        runs[0]['trained'][0] = {'id': 'one', 'wholeTaskSuccess': False, 'traceValid': False,
                                  'checkpointIdentity': runs[0]['trainedIdentity'], 'pipelineFailure': 'timeout'}
        result = learning.summarize_learning(expt, runs)
        self.assertFalse(result['requirements']['noIntegrityGateFailures'])


if __name__ == '__main__':
    unittest.main()
