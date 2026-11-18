"""All model results in these scorer tests are synthetic and are not convergence evidence.

The process-launch test actually execs an ordinary Python process only. It tests
process accounting, not a neural model, native qualification, or learning.
"""
import copy
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT/'tools'))
import convergence_ladder as C

A, B, D = 'a'*64, 'b'*64, 'd'*64
FEATURES = ['pure-selected', 'effects', 'aliasing', 'mutation']


def experiment(count=1):
    def row(index, split):
        identifier = split + str(index)
        return {'id': identifier, 'identityDigest': hashlib.sha256(identifier.encode()).hexdigest(),
            'sourceCluster': 'component:' + identifier, 'split': split, 'generatedTokens': 48,
            'slices': FEATURES.copy(), 'envelope': {'caseId': identifier, 'seed': 17, 'request': {}}}
    return {'schema': 'semantic-learning-experiment/1', 'mode': 'exploratory', 'optimizerSeeds': [17],
        'decoderSeed': 17, 'initializationSeed': 17, 'baseOrigin': 'newly-initialized', 'checkpointSteps': [32, 64],
        'producerRevision': 'c'*40, 'nativePolicy': {'consumerRevision': 'e'*40,
        'tokenizerIdentity': A, 'tokenizerSha256': D},
        'rolloutBudget': {'nativeMaxTokensPerFragment': 128, 'maximumFragmentsPerDecision': 64, 'secondsPerCase': 120},
        'trainingBudget': {'sampler': 'native-sequential-permuted-episodes', 'maxWindowRecords': 64,
                          'maxScoredDecisions': 64, 'maxWindowTokens': 16384, 'seconds': 900},
        'policy': {'minimumUsefulImprovement': .1, 'maximumCriticalSliceRegression': .05,
                   'confidence': .95, 'bootstrapReplicates': 200, 'bootstrapSeed': 89,
                   'minimumConfirmatoryTestComponents': 2},
        'training': [row(index, 'train') for index in range(count)],
        'validation': [row(0, 'validation')], 'test': [row(0, 'test')]}


def declaration(count=1):
    return C.freeze_declaration(experiment(count), A, stage='L1' if count == 1 else 'L2',
                                optimizer_seed=17, required_features=() if count == 1 else FEATURES)


def synthetic_measurements(decl):
    smoke = {'schema': 'optimization-smoke/1', 'status': 'completed',
        'convergenceDeclarationSha256': D, 'experimentSha256': A,
        'injectedSelections': False, 'generalizationClaim': False, 'baseOrigin': 'newly-initialized',
        'optimizerSeed': 17, 'initializationSeed': 17, 'optimizerSteps': 64,
        'producerRevision': decl['producerRevision'], **decl['nativePolicy'],
        'trainingCandidateIdentities': [row['identityDigest'] for row in decl['training']],
        'initialTrainingState': {'exact': True},
        'checkpointVerification': {'globalStep': 64, 'reloadExact': True, 'allParametersFinite': True,
                                   'stateSha256': A, 'modelTensorIdentity': B},
        'baseBundle': {'model_sha256': A}, 'trainedBundle': {'model_sha256': B, 'servedReloadExact': True},
        'trainingExposure': {'everySelectedEpisodeVisitedAllWindows': True}}
    attempts = []
    for index, planned in enumerate(decl['plannedAttempts']):
        launch_id = f'{index:032x}'
        attempts.append({**planned, 'evidenceKind': 'actual-native-process', 'decoderSeed': 17,
            'decodePolicy': C.DECODE_POLICY, 'summary': {'id': planned['caseId'], 'origin': 'trained',
            'checkpointIdentity': B, 'nativeLaunchId': launch_id,
            'nativeProcess': {'schema': 'semantic-native-process-launch/1', 'pid': 2000 + index,
                             'startedWallNs': 2000000 + index, 'launchId': launch_id,
                             'scriptSha256': A, 'commandSha256': A},
            'evaluatorProcess': {'pid': 1000 + index, 'startedWallNs': 1000000 + index},
            'servingProfile': {'complete': True, 'runtimeClosed': True, 'optimizerSteps': 0,
                'declaredOrigin': 'trained', 'droppedRecords': 0,
                'identity': {'modelSha256': B, 'tokenizerIdentity': A},
                'initialization': {'checkpointIdentity': B, 'tokenizerIdentity': A, 'seed': 17}},
            'artifactBindings': {name: A for name in ['request.json', 'private-expected.json',
                'result.json', 'serving-profile.json', 'native-process.json']},
            'hardGates': {key: 0 for key in C.GATES}, 'generatedTokenCost': {'complete': True},
            'firstRecord': {'status': 'measured', 'valid': True}, 'wholeTaskSuccess': True,
            'traceValid': True, 'rejections': [], 'failure': None}})
    return smoke, attempts


def score(decl, smoke, attempts):
    return C.evaluate_ladder(decl, smoke, attempts, declaration_sha256=D)


class DeclarationTests(unittest.TestCase):
    def test_one_case_freezes_exactly_ten_restarts_and_no_test_or_learned_claim(self):
        value = declaration()
        self.assertEqual(len(value['plannedAttempts']), 10)
        self.assertEqual(value['testEvaluations'], 0)
        self.assertIsNone(value['learnedSuccess'])
        self.assertEqual(value['budget']['maximumOptimizerUpdates'], 64)
        self.assertEqual(value['checkpointSelection']['rule'], 'final-declared-step')
        self.assertIn('seeded Gaussian', value['decodeQualification'])
        self.assertEqual(C.require_declaration(value, experiment(), A), value)
        absent = C.evaluate_ladder(value, None, [], declaration_sha256=D)
        self.assertEqual(absent['status'], 'unmeasured')
        self.assertIsNone(absent['learnedSuccess'])
        with self.assertRaisesRegex(ValueError, 'ten'):
            C.freeze_declaration(experiment(), A, stage='L1', optimizer_seed=17, attempts_per_case=9)

    def test_l2_population_coverage_budget_and_first_record_denominator_are_frozen(self):
        value = declaration(16)
        self.assertEqual(len(value['plannedAttempts']), 112)
        self.assertEqual(len(value['featureStrata']), 4)
        for count in (2, 15, 33):
            with self.assertRaisesRegex(ValueError, '16–32'): declaration(count)
        with self.assertRaisesRegex(ValueError, 'four'):
            C.freeze_declaration(experiment(16), A, stage='L2', optimizer_seed=17)
        with self.assertRaisesRegex(ValueError, '100'):
            C.freeze_declaration(experiment(16), A, stage='L2', optimizer_seed=17,
                                 required_features=FEATURES, attempts_per_case=1)
        changed = experiment(16); changed['training'][0]['generatedTokens'] = 2049
        with self.assertRaisesRegex(ValueError, 'token limit'):
            C.freeze_declaration(changed, A, stage='L2', optimizer_seed=17, required_features=FEATURES)

    def test_tampered_or_rehashed_weaker_thresholds_and_changed_membership_refuse(self):
        value = declaration()
        changed = copy.deepcopy(value); changed['thresholds']['completeHeldInCaseRate'] = .1
        with self.assertRaisesRegex(ValueError, 'bytes or policy'): C.require_declaration(changed)
        changed['declarationIdentity'] = C.digest({k: v for k, v in changed.items() if k != 'declarationIdentity'})
        with self.assertRaisesRegex(ValueError, 'thresholds'): C.require_declaration(changed)
        changed = experiment(); changed['training'][0]['identityDigest'] = D
        with self.assertRaisesRegex(ValueError, 'membership'): C.require_declaration(value, changed, A)
        changed = copy.deepcopy(value); changed['plannedAttempts'][0]['repeat'] = 9
        changed['declarationIdentity'] = C.digest({k: v for k, v in changed.items() if k != 'declarationIdentity'})
        with self.assertRaisesRegex(ValueError, 'schedule'): C.require_declaration(changed)


class GateTests(unittest.TestCase):
    def test_l0_controlled_transport_is_never_learned_evidence(self):
        good = {'origin': 'controlled', 'optimizerSteps': 0, **{key: True for key in
            ('routingValidated', 'observedMasked', 'generatedSupervised', 'semanticValidated', 'terminationValidated')}}
        result = C.transport_gate(good)
        self.assertEqual(result['status'], 'passed')
        self.assertIsNone(result['learnedSuccess'])
        self.assertEqual(result['evidenceLevel'], 'controlled-infrastructure-only')
        good['terminationValidated'] = None
        self.assertEqual(C.transport_gate(good)['status'], 'failed')

    def test_l1_all_ten_required_missing_attempts_stay_in_denominator(self):
        d = declaration(); smoke, rows = synthetic_measurements(d)
        self.assertEqual(score(d, smoke, rows)['status'], 'passed')
        result = score(d, smoke, rows[:-1])
        self.assertEqual(result['status'], 'failed')
        self.assertEqual(result['plannedAttempts'], 10)
        self.assertEqual(result['validFirstRecordTrialRate'], .9)
        self.assertEqual(result['completeHeldInCaseRate'], 0)
        with self.assertRaisesRegex(ValueError, 'duplicate'): score(d, smoke, rows + rows[:1])

    def test_invalid_process_identity_raw_evidence_origin_reload_and_gates_never_pass(self):
        d = declaration(); smoke, rows = synthetic_measurements(d)
        for mutate in [
            lambda r: r[1]['summary'].update(nativeProcess=copy.deepcopy(r[0]['summary']['nativeProcess'])),
            lambda r: r[1]['summary'].update(evaluatorProcess=copy.deepcopy(r[0]['summary']['evaluatorProcess'])),
            lambda r: r[0].update(evidenceKind='synthetic'),
            lambda r: r[0]['summary'].update(origin='controlled'),
            lambda r: r[0]['summary']['artifactBindings'].pop('result.json'),
            lambda r: r[0]['summary']['hardGates'].pop('falseAdmissions'),
            lambda r: r[0]['summary']['hardGates'].update(falseAdmissions=1),
            lambda r: r[0]['summary']['servingProfile']['initialization'].update(seed=29),
            lambda r: r[0]['summary']['generatedTokenCost'].update(complete=False),
            lambda r: r[0]['summary'].update(pipelineFailure='timeout')]:
            changed = copy.deepcopy(rows); mutate(changed)
            self.assertEqual(score(d, smoke, changed)['status'], 'failed')
        for mutate in [lambda s: s.pop('convergenceDeclarationSha256'),
                       lambda s: s['checkpointVerification'].update(reloadExact=False),
                       lambda s: s['trainingExposure'].update(everySelectedEpisodeVisitedAllWindows=False)]:
            changed = copy.deepcopy(smoke); mutate(changed)
            with self.assertRaises(ValueError): score(d, changed, rows)

    def test_l2_rates_use_distinct_cases_and_all_restarts_not_just_successful_rows(self):
        d = declaration(32); smoke, rows = synthetic_measurements(d)
        rows[0]['summary'].update(wholeTaskSuccess=False, traceValid=False, failure={'category': 'SemanticSelectionError'})
        result = score(d, smoke, rows)
        self.assertEqual(result['status'], 'passed')
        self.assertEqual(result['completeHeldInCaseRate'], 31/32)
        self.assertEqual(result['plannedAttempts'], 128)
        self.assertFalse(result['independenceClaim'])
        rows[0]['summary']['firstRecord']['valid'] = False
        self.assertEqual(score(d, smoke, rows)['status'], 'passed')
        rows[32]['summary']['firstRecord']['valid'] = False
        self.assertEqual(score(d, smoke, rows)['status'], 'failed')
        rows[32]['summary']['firstRecord']['valid'] = True
        rows[1]['summary']['artifactBindings'].pop('result.json')
        # Even one invalid evidence record invalidates the whole gate, although
        # a 127/128 reported first-record rate would exceed 99%.
        self.assertEqual(score(d, smoke, rows)['status'], 'failed')

    def test_native_parse_alone_does_not_count_as_valid_first_semantic_record(self):
        line = 'return {"value":["num",7]}'
        fragment = {'payloadHex': line.encode().hex(), 'emittedTokenIds': list(line.encode())}
        actual = {'selections': [{'record': line, 'invocationId': 'call',
            'selection': {'origin': 'actual-model-selected', 'modelSelected': True, 'fragments': [fragment]}}],
            'episode': {'public': {'timeline': []}}}
        profile = {'records': [{'operation': 'select', 'ok': True}]}
        self.assertFalse(C.first_record_receipt(actual, profile)['valid'])
        actual['episode']['public']['timeline'].append({'kind': 'semantic', 'mode': 'generated',
            'line': line, 'invocationId': 'call', 'sequence': 3})
        result = C.first_record_receipt(actual, profile)
        self.assertTrue(result['valid'])
        self.assertEqual(result['originalRecordHex'], line.encode().hex())
        actual['selections'][0]['record'] += ' '
        with self.assertRaisesRegex(ValueError, 'original decoder bytes'): C.first_record_receipt(actual, profile)
        missing = C.first_record_receipt({}, {'records': [{'operation': 'select', 'ok': False}]})
        self.assertFalse(missing['valid'])
        self.assertIsNone(missing['semanticValid'])


class RealProcessAccountingTests(unittest.TestCase):
    def test_launcher_receipt_records_exec_process_and_refuses_overwrite(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            script = root/'ordinary_process.py'; script.write_text('import os; print(os.getpid())\n')
            receipts = []
            for index in range(2):
                output = root/f'launch-{index}.json'
                command = [sys.executable, str(ROOT/'tools/launch-native-diagnostic.py'), '--receipt', str(output),
                           '--launch-id', f'{index:032x}', str(script)]
                pid = int(subprocess.check_output(command, text=True))
                receipt = json.loads(output.read_text())
                self.assertEqual(receipt['pid'], pid)
                self.assertEqual(receipt['scriptSha256'], hashlib.sha256(script.read_bytes()).hexdigest())
                receipts.append(receipt)
            self.assertNotEqual((receipts[0]['pid'], receipts[0]['startedWallNs']),
                                (receipts[1]['pid'], receipts[1]['startedWallNs']))
            before = output.read_bytes()
            repeat = subprocess.run(command, capture_output=True)
            self.assertNotEqual(repeat.returncode, 0)
            self.assertEqual(before, output.read_bytes())


if __name__ == '__main__': unittest.main()
