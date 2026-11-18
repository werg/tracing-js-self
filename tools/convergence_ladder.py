"""Predeclared bounded convergence gates, separate from transport and transfer.

These gates only score identity-bound actual native executions. Their unit-test
fixtures exercise the scorer, never establish achieved model convergence.
"""
from __future__ import annotations

from collections import Counter, defaultdict
from datetime import datetime, timezone
import hashlib
import json
import math
import re

from learning_evaluation import require_frozen_experiment, frozen_training_budget, selected_rollout_budget

SCHEMA = 'semantic-convergence-declaration/1'
GATES = {'futureObservationLeaks', 'unauthorizedEffects', 'untrackedNativeFallback',
         'falseAdmissions', 'replayNativeEffects'}
FEATURES = {'pure-selected', 'effects', 'aliasing', 'mutation', 'valid-errors', 'retained-state', 'cleanup'}
DECODE_POLICY = 'native-greedy-renderer-with-fixed-policy-seed'


def require(condition, message):
    if not condition: raise ValueError(message)


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False,
                                    separators=(',', ':'), allow_nan=False).encode()).hexdigest()


def sha(value):
    return isinstance(value, str) and re.fullmatch('[0-9a-f]{64}', value) is not None


def freeze_declaration(experiment, experiment_sha256, *, stage, optimizer_seed,
                       attempts_per_case=None, maximum_generated_tokens=2048, required_features=()):
    require_frozen_experiment(experiment)
    require(sha(experiment_sha256), 'Exact original experiment SHA-256 required')
    require(stage in ('L1', 'L2'), 'Only bounded learned L1/L2 declarations use this path')
    require(optimizer_seed in experiment['optimizerSeeds'], 'Optimizer seed differs from frozen experiment')
    require(type(maximum_generated_tokens) is int and 1 <= maximum_generated_tokens <= 8192,
            'Freeze a bounded maximum generated-token length for every short case')
    training_budget = frozen_training_budget(experiment)
    require(training_budget is not None and experiment.get('rolloutBudget') is not None,
            'Convergence requires explicit frozen training and inference budgets')
    rows = experiment['training']
    if stage == 'L1':
        require(len(rows) == 1, 'L1 requires one fixed training episode')
        require(not required_features, 'Feature stratification is an L2 declaration')
        attempts_per_case = 10 if attempts_per_case is None else attempts_per_case
        require(type(attempts_per_case) is int and attempts_per_case == 10,
                'L1 requires exactly ten predeclared independent process restarts')
    else:
        require(16 <= len(rows) <= 32, 'L2 requires 16–32 distinct short training cases')
        require(len(set(required_features)) >= 4 and set(required_features) <= FEATURES,
                'L2 requires at least four explicit semantic feature strata')
        attempts_per_case = math.ceil(100 / len(rows)) if attempts_per_case is None else attempts_per_case
        require(type(attempts_per_case) is int and 1 <= attempts_per_case <= 100 and
                len(rows) * attempts_per_case >= 100,
                'L2 needs at least 100 predeclared first-record trials with equal repeats per case')
    members = []
    for row in rows:
        require(type(row.get('generatedTokens')) is int and 1 <= row['generatedTokens'] <= maximum_generated_tokens,
                'A training episode exceeds the declared short-case token limit')
        require(sha(row.get('identityDigest')), 'Exact source-certified training identity required')
        members.append({key: row[key] for key in ('id', 'identityDigest', 'sourceCluster', 'slices', 'generatedTokens')})
    coverage = {feature: [row['id'] for row in rows if feature in row['slices']]
                for feature in sorted(required_features)}
    require(all(coverage.values()), 'A declared feature stratum has no frozen training case')
    attempts = [{'attemptId': f'restart-{repeat:03d}-case-{index:03d}',
                 'caseId': row['id'], 'repeat': repeat}
                for repeat in range(attempts_per_case) for index, row in enumerate(rows)]
    result = {'schema': SCHEMA, 'stage': stage, 'frozenAt': datetime.now(timezone.utc).isoformat(),
        'experimentSha256': experiment_sha256, 'producerRevision': experiment['producerRevision'],
        'nativePolicy': experiment['nativePolicy'], 'optimizerSeed': optimizer_seed,
        'initializationSeed': experiment['initializationSeed'], 'decoderSeed': experiment['decoderSeed'],
        'decodePolicy': DECODE_POLICY, 'decodeQualification':
            'Lexical and structure argmax conditional on native seeded Gaussian policy facets; not a greedy latent policy.',
        'training': members, 'featureStrata': coverage,
        'checkpointSelection': {'rule': 'final-declared-step', 'step': max(experiment['checkpointSteps']),
                                'testUsed': False},
        'budget': {'maximumOptimizerUpdates': max(experiment['checkpointSteps']),
                   'training': training_budget, 'rollout': selected_rollout_budget(experiment),
                   'maximumGeneratedTokensPerCase': maximum_generated_tokens,
                   'maximumAttempts': len(attempts),
                   'maximumEvaluationWallSeconds': len(attempts) * (selected_rollout_budget(experiment)['secondsPerCase'] + 50)},
        'plannedAttempts': attempts, 'thresholds': {'completeHeldInCaseRate': 1.0 if stage == 'L1' else .95,
            'validFirstRecordTrialRate': 1.0 if stage == 'L1' else .99, 'falseAdmissions': 0},
        'stopCondition': 'Stop at the declared update/time caps; retain every planned evaluation failure; no adaptive extension.',
        'wholeCaseRule': 'A case succeeds only if every planned process restart completes it.',
        'firstRecordScope': 'Syntax and semantic acceptance of the original first emission, not native parse alone.',
        'evaluationSplit': 'train', 'testEvaluations': 0,
        'evidenceKind': 'frozen-declaration-only', 'optimizerSteps': 0, 'learnedSuccess': None,
        'independenceClaim': False, 'generalizationClaim': False,
        'limitations': ['Repeated seeded trials measure process repeatability, not 100 independent source cases.',
                       'Passing L1/L2 does not establish new-input or independent-source transfer.']}
    result['declarationIdentity'] = digest(result)
    return result


def require_declaration(value, experiment=None, experiment_sha256=None):
    require(isinstance(value, dict) and value.get('schema') == SCHEMA, 'Unknown convergence declaration')
    body = {key: item for key, item in value.items() if key != 'declarationIdentity'}
    require(value.get('declarationIdentity') == digest(body), 'Convergence declaration bytes or policy changed')
    require(value.get('stage') in ('L1', 'L2') and value.get('decodePolicy') == DECODE_POLICY,
            'Unsupported convergence stage or native decode policy')
    members, attempts = value.get('training'), value.get('plannedAttempts')
    require(isinstance(members, list) and members and isinstance(attempts, list) and attempts,
            'Frozen nonempty members and attempts required')
    identifiers = [row['id'] for row in members]
    require(len(set(identifiers)) == len(identifiers) and
            len({row['attemptId'] for row in attempts}) == len(attempts),
            'Repeated convergence membership or planned attempt')
    require(all(row['caseId'] in identifiers and type(row.get('repeat')) is int and row['repeat'] >= 0
                for row in attempts), 'Frozen attempt names a foreign case or repetition')
    counts = Counter(row['caseId'] for row in attempts)
    require(set(counts) == set(identifiers) and len(set(counts.values())) == 1,
            'Every frozen case requires equal predeclared restarts')
    stage = value['stage']
    require((stage == 'L1' and len(members) == 1 and len(attempts) == 10) or
            (stage == 'L2' and 16 <= len(members) <= 32 and len(attempts) >= 100),
            'Convergence population or independent restart count violates the ladder')
    expected_attempts = [{'attemptId': f'restart-{repeat:03d}-case-{index:03d}',
                          'caseId': row['id'], 'repeat': repeat}
                         for repeat in range(next(iter(counts.values()))) for index, row in enumerate(members)]
    require(attempts == expected_attempts, 'Planned restart schedule changed or reordered')
    features = value.get('featureStrata')
    require(isinstance(features, dict) and
            (stage == 'L1' and not features or stage == 'L2' and len(features) >= 4 and set(features) <= FEATURES),
            'Convergence semantic feature strata are incomplete')
    require(all(ids and ids == [row['id'] for row in members if feature in row['slices']]
                for feature, ids in features.items()), 'Feature strata differ from original case annotations')
    require(value.get('thresholds') == {'completeHeldInCaseRate': 1.0 if stage == 'L1' else .95,
                'validFirstRecordTrialRate': 1.0 if stage == 'L1' else .99, 'falseAdmissions': 0},
            'Ladder thresholds may not be weakened')
    require(value.get('evidenceKind') == 'frozen-declaration-only' and value.get('optimizerSteps') == 0 and
            value.get('learnedSuccess') is None and value.get('testEvaluations') == 0,
            'Declaration is not a pre-optimization, held-in-only artifact')
    if experiment is not None:
        require(experiment_sha256 == value['experimentSha256'], 'Frozen experiment bytes changed')
        expected = freeze_declaration(experiment, experiment_sha256, stage=value['stage'],
            optimizer_seed=value['optimizerSeed'],
            attempts_per_case=len(value['plannedAttempts']) // len(value['training']),
            maximum_generated_tokens=value['budget']['maximumGeneratedTokensPerCase'],
            required_features=tuple(value['featureStrata']))
        ignored = {'frozenAt', 'declarationIdentity'}
        require({k: v for k, v in expected.items() if k not in ignored} ==
                {k: v for k, v in value.items() if k not in ignored},
                'Convergence declaration differs from frozen membership, budgets or thresholds')
    return value


def first_record_receipt(actual, profile):
    """Use original selected bytes and actual committed semantic timeline only."""
    rows = [row for row in (profile or {}).get('records', []) if row.get('operation') == 'select']
    if not rows:
        return {'status': 'unmeasured', 'valid': None, 'reason': 'No original native selection call retained'}
    selections = actual.get('selections', [])
    if rows[0].get('ok') is not True or not selections:
        return {'status': 'measured', 'valid': False, 'syntaxValid': None, 'semanticValid': None,
                'failure': rows[0].get('failure'), 'reason': 'First native call produced no accepted record'}
    first = selections[0]
    selection, record = first.get('selection'), first.get('record')
    require(isinstance(selection, dict) and selection.get('modelSelected') is True and
            selection.get('origin') == 'actual-model-selected' and isinstance(record, str),
            'First record lacks actual original native selection authority')
    fragments = selection.get('fragments')
    require(isinstance(fragments, list) and fragments and
            b''.join(bytes.fromhex(row['payloadHex']) for row in fragments) == record.encode(),
            'First original decoder bytes differ from the record given to the semantic checker')
    committed = [row for row in actual.get('episode', {}).get('public', {}).get('timeline', [])
                 if row.get('kind') == 'semantic' and row.get('mode') == 'generated']
    valid = bool(committed and committed[0].get('line') == record and
                 committed[0].get('invocationId') == first.get('invocationId'))
    return {'status': 'measured', 'valid': valid, 'syntaxValid': True, 'semanticValid': valid,
            'originalRecordHex': record.encode().hex(), 'originalRecordSha256': hashlib.sha256(record.encode()).hexdigest(),
            'originalFragments': fragments, 'committedSequence': committed[0]['sequence'] if valid else None}


def require_optimization_binding(declaration, smoke, declaration_sha256):
    require_declaration(declaration)
    checkpoint = smoke.get('checkpointVerification', {})
    bundle = smoke.get('trainedBundle', {})
    require(smoke.get('schema') == 'optimization-smoke/1' and smoke.get('status') == 'completed' and
            smoke.get('convergenceDeclarationSha256') == declaration_sha256 and
            smoke.get('experimentSha256') == declaration['experimentSha256'],
            'Optimizer run was not bound to this declaration before training')
    require(smoke.get('injectedSelections') is False and smoke.get('generalizationClaim') is False and
            smoke.get('baseOrigin') == 'newly-initialized', 'Convergence requires an actual diagnostic optimization run')
    require(smoke.get('optimizerSeed') == declaration['optimizerSeed'] and
            smoke.get('initializationSeed') == declaration['initializationSeed'] and
            smoke.get('optimizerSteps') == declaration['checkpointSelection']['step'] and
            checkpoint.get('globalStep') == declaration['checkpointSelection']['step'],
            'Actual checkpoint/optimizer budget differs from fixed final checkpoint selection')
    for key in ('producerRevision', 'consumerRevision', 'tokenizerIdentity', 'tokenizerSha256'):
        expected = declaration['producerRevision'] if key == 'producerRevision' else declaration['nativePolicy'][key]
        require(smoke.get(key) == expected, 'Optimizer source/native/tokenizer identity differs: ' + key)
    require(smoke.get('trainingCandidateIdentities') == [row['identityDigest'] for row in declaration['training']],
            'Actual optimized cases differ from the frozen held-in membership')
    require(smoke.get('initialTrainingState', {}).get('exact') is True and checkpoint.get('reloadExact') is True and
            checkpoint.get('allParametersFinite') is True and bundle.get('servedReloadExact') is True and
            sha(checkpoint.get('stateSha256')) and sha(checkpoint.get('modelTensorIdentity')) and
            sha(bundle.get('model_sha256')) and bundle.get('model_sha256') != smoke.get('baseBundle', {}).get('model_sha256'),
            'Exact finite trained checkpoint and served reload evidence required')
    require(smoke.get('trainingExposure', {}).get('everySelectedEpisodeVisitedAllWindows') is True,
            'Every declared generated target must have actual authenticated exposure')
    return bundle


def evaluate_ladder(declaration, smoke, attempts, *, declaration_sha256):
    """Missing or invalid evidence fails a gate; it never shrinks a denominator."""
    require_declaration(declaration)
    if smoke is None:
        return {'schema': 'semantic-convergence-gates/1', 'stage': declaration['stage'],
                'status': 'unmeasured', 'learnedSuccess': None, 'evidenceLevel': 'declaration-only',
                'reason': 'No bound native optimization and process-restart measurements',
                'plannedAttempts': len(declaration['plannedAttempts']), 'completedAttempts': 0,
                'generalizationClaim': False}
    bundle = require_optimization_binding(declaration, smoke, declaration_sha256)
    expected = {row['attemptId']: row for row in declaration['plannedAttempts']}
    observed = {}
    for row in attempts:
        require(row.get('attemptId') in expected and row['attemptId'] not in observed,
                'Unexpected or duplicate process-restart attempt')
        planned = expected[row['attemptId']]
        require(row.get('caseId') == planned['caseId'], 'Attempt case differs from frozen schedule')
        observed[row['attemptId']] = row
    processes, evaluator_processes, launch_ids = set(), set(), set()
    failures, invalid_evidence, valid_first, cases = [], [], 0, defaultdict(list)
    hard = Counter({key: 0 for key in GATES})
    missing_hard = []
    for attempt_id, plan in expected.items():
        row = observed.get(attempt_id)
        issues = []
        if row is None:
            issues.append('missing-process-restart')
            summary = {}
        else:
            summary = row.get('summary', {})
            launch = summary.get('nativeProcess') or {}
            identity = (launch.get('pid'), launch.get('startedWallNs'))
            evaluator = summary.get('evaluatorProcess') or {}
            evaluator_identity = (evaluator.get('pid'), evaluator.get('startedWallNs'))
            if (launch.get('schema') != 'semantic-native-process-launch/1' or
                    type(launch.get('pid')) is not int or launch['pid'] <= 0 or
                    type(launch.get('startedWallNs')) is not int or not launch.get('launchId') or
                    launch.get('launchId') != summary.get('nativeLaunchId') or
                    not sha(launch.get('scriptSha256')) or not sha(launch.get('commandSha256')) or
                    type(evaluator.get('pid')) is not int or evaluator['pid'] <= 0 or
                    type(evaluator.get('startedWallNs')) is not int or
                    identity in processes or evaluator_identity in evaluator_processes or launch.get('launchId') in launch_ids):
                issues.append('missing-or-reused-independent-process')
            processes.add(identity); evaluator_processes.add(evaluator_identity); launch_ids.add(launch.get('launchId'))
            if (row.get('evidenceKind') != 'actual-native-process' or summary.get('origin') != 'trained' or
                    summary.get('id') != plan['caseId'] or summary.get('checkpointIdentity') != bundle['model_sha256'] or
                    row.get('decodePolicy') != DECODE_POLICY or row.get('decoderSeed') != declaration['decoderSeed']):
                issues.append('wrong-model-case-or-decode-authority')
            profile = summary.get('servingProfile') or {}
            if (profile.get('complete') is not True or profile.get('runtimeClosed') is not True or
                    profile.get('droppedRecords') != 0 or
                    profile.get('optimizerSteps') != 0 or profile.get('declaredOrigin') != 'trained' or
                    profile.get('identity', {}).get('modelSha256') != bundle['model_sha256'] or
                    profile.get('identity', {}).get('tokenizerIdentity') != declaration['nativePolicy']['tokenizerIdentity'] or
                    profile.get('initialization', {}).get('checkpointIdentity') != bundle['model_sha256'] or
                    profile.get('initialization', {}).get('tokenizerIdentity') != declaration['nativePolicy']['tokenizerIdentity'] or
                    profile.get('initialization', {}).get('seed') != declaration['decoderSeed']):
                issues.append('missing-fresh-bound-model-initialization')
            evidence = summary.get('artifactBindings') or {}
            if not all(sha(evidence.get(name)) for name in ('request.json', 'private-expected.json',
                                                         'result.json', 'serving-profile.json', 'native-process.json')):
                issues.append('missing-original-artifact-bindings')
            if (summary.get('generatedTokenCost') or {}).get('complete') is not True:
                issues.append('incomplete-original-emissions')
            if summary.get('pipelineFailure'):
                issues.append('pipeline-failure')
        counters = summary.get('hardGates')
        if (not isinstance(counters, dict) or set(counters) != GATES or
                any(type(count) is not int or count < 0 for count in counters.values())):
            missing_hard.append(attempt_id)
            issues.append('missing-hard-gate-measurements')
        else:
            hard.update(counters)
            if any(counters.values()): issues.append('hard-gate-violation')
        first = summary.get('firstRecord', {})
        if issues: invalid_evidence.append(attempt_id)
        if not issues and first.get('status') == 'measured' and first.get('valid') is True:
            valid_first += 1
        complete = (not issues and summary.get('wholeTaskSuccess') is True and summary.get('traceValid') is True and
                    summary.get('rejections') == [] and summary.get('failure') is None)
        cases[plan['caseId']].append(complete)
        if not complete or first.get('valid') is not True:
            failures.append({'attemptId': attempt_id, 'caseId': plan['caseId'],
                             'reasons': issues or ['incomplete-execution' if not complete else 'invalid-first-record']})
    complete_cases = sum(all(values) for values in cases.values())
    complete_rate = complete_cases / len(declaration['training'])
    first_rate = valid_first / len(expected)
    passed = (not invalid_evidence and not missing_hard and not any(hard.values()) and
              complete_rate >= declaration['thresholds']['completeHeldInCaseRate'] and
              first_rate >= declaration['thresholds']['validFirstRecordTrialRate'])
    return {'schema': 'semantic-convergence-gates/1', 'stage': declaration['stage'],
        'status': 'passed' if passed else 'failed', 'learnedSuccess': passed,
        'gateVariant': 'native-seeded-policy', 'roadmapGreedyPolicyGatePassed': False,
        'roadmapGateQualification': 'The native policy samples facets before argmax rendering. This measurement cannot establish an entirely greedy-policy L1 gate.',
        'evidenceLevel': 'bounded-held-in-native-model-measurement',
        'plannedAttempts': len(expected), 'completedAttempts': len(observed),
        'distinctHeldInCases': len(declaration['training']), 'completeHeldInCases': complete_cases,
        'completeHeldInCaseRate': complete_rate, 'validFirstRecordTrials': valid_first,
        'validFirstRecordTrialRate': first_rate, 'hardGates': dict(hard),
        'missingHardGateAttempts': missing_hard, 'invalidEvidenceAttempts': invalid_evidence, 'failures': failures,
        'thresholds': declaration['thresholds'], 'checkpointIdentity': bundle['model_sha256'],
        'checkpointStateSha256': smoke['checkpointVerification']['stateSha256'],
        'decodePolicy': DECODE_POLICY, 'decodeQualification': declaration['decodeQualification'],
        'costs': {'retainedEvaluationWallSeconds': sum(row.get('summary', {}).get('wallSeconds', 0) for row in attempts),
                  'retainedGeneratedTokenLowerBound': sum((row.get('summary', {}).get('generatedTokenCost') or {}).get('generatedTokens', 0)
                                                         for row in attempts),
                  'originalEmissionsComplete': len(observed) == len(expected) and
                      all((row.get('summary', {}).get('generatedTokenCost') or {}).get('complete') is True for row in attempts),
                  'trainingOptimizerSteps': smoke['optimizerSteps'],
                  'trainingSupervisedLexicalTokens': smoke.get('supervisedLexicalTokens'),
                  'trainingProcess': smoke.get('trainingProcess'),
                  'trainingExposure': smoke.get('trainingExposure')},
        'independenceClaim': False, 'generalizationClaim': False,
        'wholeCaseRule': declaration['wholeCaseRule'], 'featureStrata': declaration['featureStrata']}


def transport_gate(receipt):
    """A controlled transport pass can never be promoted to learned L1/L2."""
    required = ('routingValidated', 'observedMasked', 'generatedSupervised', 'semanticValidated', 'terminationValidated')
    passed = (receipt.get('origin') == 'controlled' and receipt.get('optimizerSteps') == 0 and
              all(receipt.get(key) is True for key in required))
    return {'stage': 'L0', 'status': 'passed' if passed else 'failed',
            'evidenceLevel': 'controlled-infrastructure-only', 'learnedSuccess': None,
            'generalizationClaim': False, 'requirements': {key: receipt.get(key) for key in required}}
