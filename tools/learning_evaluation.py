"""Frozen, paired learning measurements; model outputs never set cohort membership.

Independent source/ancestor components are the resampling unit. Episode repeats
within a component and optimizer seeds are retained together in every draw.
This module scores measured selected executions, not teacher-forced loss.
"""
from __future__ import annotations

from collections import Counter, defaultdict
import math
import random


SCHEMA = 'semantic-learning-experiment/1'
GATES = {'futureObservationLeaks', 'unauthorizedEffects', 'untrackedNativeFallback',
         'falseAdmissions', 'replayNativeEffects'}
CRITICAL_SLICES = ('effects', 'valid-errors', 'cleanup')


def mean(values):
    values = list(values)
    return sum(values) / len(values) if values else None


def require_frozen_experiment(experiment):
    if experiment.get('schema') != SCHEMA:
        raise ValueError('Unsupported frozen learning experiment')
    seeds = experiment.get('optimizerSeeds')
    if not isinstance(seeds, list) or not seeds or len(set(seeds)) != len(seeds) or any(
            seed not in (17, 29, 43) for seed in seeds):
        raise ValueError('Declare unique optimizer seeds before training')
    if experiment.get('mode') not in ('exploratory', 'confirmatory'):
        raise ValueError('Declare exploratory or confirmatory experiment scope')
    if (experiment.get('baseOrigin') != 'newly-initialized' or
            experiment.get('initializationSeed') not in (17, 29, 43) or experiment.get('decoderSeed') not in (17, 29, 43)):
        raise ValueError('Declare supported initialization and decoder identities')
    budget = experiment.get('rolloutBudget')
    if budget is not None and (type(budget.get('tokensPerDecision')) is not int or
            not 1 <= budget['tokensPerDecision'] <= 1024 or type(budget.get('secondsPerCase')) is not int or
            not 1 <= budget['secondsPerCase'] <= 300):
        raise ValueError('Invalid frozen inference budget')
    if experiment['mode'] == 'confirmatory' and budget is None:
        raise ValueError('Confirmatory inference budget must be frozen before training')
    policy = experiment['policy']
    for field in ('minimumUsefulImprovement', 'maximumCriticalSliceRegression'):
        if isinstance(policy[field], bool) or not isinstance(policy[field], (int, float)) or not math.isfinite(policy[field]) or not 0 <= policy[field] <= 1:
            raise ValueError('Invalid declared improvement/regression threshold')
    if policy['minimumUsefulImprovement'] <= 0:
        raise ValueError('A positive useful improvement must be declared before training')
    if policy.get('confidence') != 0.95 or not 100 <= policy['bootstrapReplicates'] <= 100000:
        raise ValueError('Use a bounded 95% paired component bootstrap')
    if not isinstance(policy.get('bootstrapSeed'), int):
        raise ValueError('Freeze the bootstrap RNG seed')
    if not isinstance(policy.get('minimumConfirmatoryTestComponents'), int) or policy['minimumConfirmatoryTestComponents'] < 2:
        raise ValueError('Declare the minimum confirmatory component count')
    steps = experiment.get('checkpointSteps')
    if not isinstance(steps, list) or not steps or any(type(step) is not int or step < 1 for step in steps) or steps != sorted(set(steps)):
        raise ValueError('Freeze unique positive checkpoint steps in ascending order')
    memberships = {}
    identifiers = set()
    for split in ('train', 'validation', 'test'):
        rows = experiment['training'] if split == 'train' else experiment[split]
        if not rows:
            raise ValueError(f'Frozen {split} collection is empty')
        for row in rows:
            if row['id'] in identifiers or row['split'] != split:
                raise ValueError('Duplicate or relabeled frozen episode')
            identifiers.add(row['id'])
            component = row['sourceCluster']
            if not isinstance(component, str) or not component.startswith('component:'):
                raise ValueError('Learning requires authenticated source components')
            if component in memberships and memberships[component] != split:
                raise ValueError('Connected source component spans experiment splits')
            memberships[component] = split
            if not isinstance(row.get('slices'), list) or len(set(row['slices'])) != len(row['slices']):
                raise ValueError('Invalid frozen evaluation slices')
            if split != 'train':
                envelope = row['envelope']
                if (envelope['seed'] != experiment['decoderSeed'] or envelope['caseId'] != row['id'] or
                        'controlledSelectionsByRepresentation' in envelope['request'] or
                        'expected' in envelope or 'expected' in envelope['request']):
                    raise ValueError('Private teacher material or wrong identity in model envelope')
    training = {row['id']: row for row in experiment['training']}
    for row in experiment.get('auxiliary', []):
        if row['id'] in identifiers or row.get('split') != 'train' or row.get('evaluationRole') != 'auxiliary-known-source':
            raise ValueError('Auxiliary variants must remain distinct, reserved training-split inputs')
        identifiers.add(row['id'])
        matched = training.get(row.get('matchedTrainingId'))
        if (matched is None or row['sourceCluster'] != matched['sourceCluster'] or
                row['scenario']['sourceKey'] != matched['scenario']['sourceKey']):
            raise ValueError('Auxiliary source differs from its declared training source')
        same_source = [item for item in training.values() if item['sourceCluster'] == row['sourceCluster'] and
                       item['scenario']['sourceKey'] == row['scenario']['sourceKey']]
        if any(all(item['scenario'][key] == row['scenario'][key] for key in
                   ('inputKey', 'observationKey', 'scheduleKey')) for item in same_source):
            raise ValueError('Auxiliary case duplicates an optimized source/input/schedule')
        if row['scenario']['inputKey'] != matched['scenario']['inputKey']:
            if any(item['scenario']['inputKey'] == row['scenario']['inputKey'] for item in same_source):
                raise ValueError('New-input slice includes an input already selected for training')
            labels = ['new-inputs-known-source']
        else:
            labels = [label for key, label in [('observationKey', 'different-observations'), ('scheduleKey', 'different-schedules')]
                      if row['scenario'][key] != matched['scenario'][key]]
        if not labels or row.get('auxiliarySlices') != labels or 'new-source' in row['slices']:
            raise ValueError('Auxiliary slice classification changed or entered the unseen-source score')
        envelope = row['envelope']
        if (envelope['seed'] != experiment['decoderSeed'] or envelope['caseId'] != row['id'] or
                'controlledSelectionsByRepresentation' in envelope['request'] or 'expected' in envelope or
                'expected' in envelope['request']):
            raise ValueError('Private teacher material or wrong identity in auxiliary envelope')
    return experiment


def validate_measured_rows(cases, measured, *, checkpoint_identity=None):
    expected = {case['id']: case for case in cases}
    actual = {}
    for row in measured:
        if row.get('id') not in expected or row['id'] in actual:
            raise ValueError('Duplicate or foreign evaluation result')
        if checkpoint_identity is not None and row.get('checkpointIdentity') != checkpoint_identity:
            raise ValueError('Measured checkpoint identity differs from declared arm')
        if type(row.get('wholeTaskSuccess')) is not bool or type(row.get('traceValid')) is not bool:
            raise ValueError('Measured execution needs explicit success and trace validity')
        if row['wholeTaskSuccess'] and (not row['traceValid'] or row.get('pipelineFailure') or
                row.get('failure') or row.get('rejections') or row.get('firstSemanticInconsistency') or
                set(row.get('hardGates', {})) != GATES or any(row['hardGates'].values())):
            raise ValueError('A failed/rejected/integrity-violating execution cannot count as success')
        actual[row['id']] = row
    if actual.keys() != expected.keys():
        raise ValueError('Missing evaluation results cannot leave the denominator')
    return actual


def arm_metrics(cases, measured):
    actual = validate_measured_rows(cases, measured)
    components = defaultdict(list)
    traces = defaultdict(list)
    costs = []
    tokens = []
    failures = Counter()
    integrity = Counter()
    complete_gate_receipts = 0
    for case in cases:
        row = actual[case['id']]
        components[case['sourceCluster']].append(int(row['wholeTaskSuccess']))
        traces[case['sourceCluster']].append(int(row['traceValid']))
        failures.update([row.get('pipelineFailure') or (row.get('failure') or {}).get('category') or
                         ('rejected-selection' if row.get('rejections') else
                          'outcome-disagreement' if not row['wholeTaskSuccess'] else 'success')])
        gates = row.get('hardGates', {})
        if set(gates) == GATES and all(type(value) is int and value >= 0 for value in gates.values()):
            complete_gate_receipts += 1
        integrity.update(gates)
        cost = row.get('wallSeconds')
        if isinstance(cost, (float, int)) and not isinstance(cost, bool) and math.isfinite(cost) and cost >= 0:
            costs.append(cost)
        token_cost = row.get('generatedTokenCost')
        if token_cost is not None:
            count = token_cost.get('generatedTokens')
            if type(count) is not int or count < 0:
                raise ValueError('Decoder token cost must be measured nonnegative integer')
            tokens.append(token_cost)
    successes = sum(row['wholeTaskSuccess'] for row in measured)
    total_seconds = sum(costs) if len(costs) == len(cases) else None
    token_lower_bound = sum(row['generatedTokens'] for row in tokens)
    token_complete = len(tokens) == len(cases) and all(row.get('complete') for row in tokens)
    return {'episodes': len(cases), 'sourceFamilies': len({row['family'] for row in cases}),
            'independentComponents': len(components), 'successes': successes,
            'familyWeightedWholeTaskSuccess': mean(mean(rows) for rows in components.values()),
            'episodeWeightedWholeTaskSuccess': successes / len(cases),
            'familyWeightedTraceValidity': mean(mean(rows) for rows in traces.values()),
            'components': {key: mean(rows) for key, rows in sorted(components.items())},
            'failures': dict(sorted(failures.items())), 'integrityFailures': dict(sorted(integrity.items())),
            'completeIntegrityGateReceipts': complete_gate_receipts,
            'wallSeconds': total_seconds,
            'wallSecondsPerCorrectTask': total_seconds / successes if successes and total_seconds is not None else None,
            'generatedTokens': token_lower_bound if token_complete else None,
            'retainedGeneratedTokensLowerBound': token_lower_bound, 'generatedTokenCostComplete': token_complete,
            'generatedTokensPerCorrectTask': token_lower_bound / successes if successes and token_complete else None}


def choose_validation_checkpoint(experiment, candidates):
    """Rank using only complete validation results; ties prefer earlier steps."""
    require_frozen_experiment(experiment)
    if not candidates:
        raise ValueError('No checkpoint candidates')
    steps, identities, evaluated = set(), set(), []
    for candidate in candidates:
        step, identity = candidate['step'], candidate['checkpointIdentity']
        if step not in experiment['checkpointSteps'] or step in steps or identity in identities:
            raise ValueError('Checkpoint candidates differ from the frozen schedule')
        steps.add(step)
        identities.add(identity)
        validate_measured_rows(experiment['validation'], candidate['cases'], checkpoint_identity=identity)
        metrics = arm_metrics(experiment['validation'], candidate['cases'])
        evaluated.append({'step': step, 'checkpointIdentity': identity, 'metrics': metrics})
    if steps != set(experiment['checkpointSteps']):
        raise ValueError('Missing frozen checkpoint candidate')
    ranking = sorted(evaluated, key=lambda item: (-item['metrics']['familyWeightedWholeTaskSuccess'],
        -item['metrics']['familyWeightedTraceValidity'], item['step'], item['checkpointIdentity']))
    return {'schema': 'semantic-validation-selection/1', 'selectionSplit': 'validation',
            'criterion': ['familyWeightedWholeTaskSuccess', 'familyWeightedTraceValidity', 'earliestStep'],
            'checkpointIdentity': ranking[0]['checkpointIdentity'], 'step': ranking[0]['step'],
            'candidates': evaluated, 'testUsedForSelection': False}


def quantile(values, fraction):
    values = sorted(values)
    index = (len(values) - 1) * fraction
    lower, upper = math.floor(index), math.ceil(index)
    return values[lower] + (values[upper] - values[lower]) * (index - lower)


def paired_component_interval(component_deltas, *, seed, replicates):
    components = sorted(component_deltas)
    if not components:
        raise ValueError('No paired components')
    values = [component_deltas[key] for key in components]
    rng = random.Random(seed)
    samples = [sum(values[rng.randrange(len(values))] for _ in values) / len(values)
               for _ in range(replicates)]
    return {'unit': 'connected-source-ancestor-component', 'confidence': 0.95,
            'method': 'paired-percentile-bootstrap', 'replicates': replicates, 'seed': seed,
            'components': len(values), 'lower': quantile(samples, 0.025), 'upper': quantile(samples, 0.975),
            'scope': 'family-resampling-with-all-seeds-and-input-variants-kept-paired',
            'smallSampleWarning': len(values) < 10}


def summarize_learning(experiment, runs):
    require_frozen_experiment(experiment)
    by_seed = {}
    for run in runs:
        seed = run['optimizerSeed']
        if seed not in experiment['optimizerSeeds'] or seed in by_seed:
            raise ValueError('Duplicate or undeclared optimizer seed')
        if type(run.get('optimizerSteps')) is not int or run['optimizerSteps'] < 1:
            raise ValueError('Actual optimizer updates required for a trained comparison')
        selection = run['selection']
        if selection.get('testUsedForSelection') is not False or selection.get('selectionSplit') != 'validation':
            raise ValueError('Test results cannot select a checkpoint')
        rebuilt = choose_validation_checkpoint(experiment, run['validation'])
        if rebuilt != selection:
            raise ValueError('Validation checkpoint selection receipt changed')
        if run['trainedIdentity'] != selection['checkpointIdentity'] or run['baseIdentity'] == run['trainedIdentity']:
            raise ValueError('Actual base and validation-selected trained identities required')
        for key, identity in [('base', run['baseIdentity']), ('trained', run['trainedIdentity'])]:
            validate_measured_rows(experiment['test'], run[key], checkpoint_identity=identity)
        if experiment.get('auxiliary'):
            for key, identity in [('base', run['baseIdentity']), ('trained', run['trainedIdentity'])]:
                validate_measured_rows(experiment['auxiliary'], run.get('auxiliary', {}).get(key, []), checkpoint_identity=identity)
        base, trained = arm_metrics(experiment['test'], run['base']), arm_metrics(experiment['test'], run['trained'])
        by_seed[seed] = {'optimizerSeed': seed, 'optimizerSteps': run['optimizerSteps'],
                         'baseIdentity': run['baseIdentity'], 'trainedIdentity': run['trainedIdentity'],
                         'selectedCheckpointStep': selection['step'], 'base': base, 'trained': trained,
                         'improvement': trained['familyWeightedWholeTaskSuccess'] - base['familyWeightedWholeTaskSuccess']}
    if set(by_seed) != set(experiment['optimizerSeeds']):
        raise ValueError('Missing optimizer seeds cannot leave the experiment denominator')
    component_deltas = {component: mean(row['trained']['components'][component] - row['base']['components'][component]
                                      for row in by_seed.values()) for component in next(iter(by_seed.values()))['base']['components']}
    policy = experiment['policy']
    uncertainty = paired_component_interval(component_deltas, seed=policy['bootstrapSeed'],
                                           replicates=policy['bootstrapReplicates'])
    slices = {}
    for label in sorted(set(CRITICAL_SLICES) | {label for case in experiment['test'] for label in case['slices']}):
        cases = [case for case in experiment['test'] if label in case['slices']]
        if not cases:
            slices[label] = {'status': 'untested', 'episodes': 0, 'independentComponents': 0}
            continue
        identifiers = {case['id'] for case in cases}
        per_seed = []
        for run in runs:
            metrics = {arm: arm_metrics(cases, [row for row in run[arm] if row['id'] in identifiers]) for arm in ('base', 'trained')}
            per_seed.append({'optimizerSeed': run['optimizerSeed'],
                             'base': metrics['base']['familyWeightedWholeTaskSuccess'],
                             'trained': metrics['trained']['familyWeightedWholeTaskSuccess'],
                             'improvement': metrics['trained']['familyWeightedWholeTaskSuccess'] - metrics['base']['familyWeightedWholeTaskSuccess']})
        slices[label] = {'status': 'measured', 'episodes': len(cases),
                         'independentComponents': len({case['sourceCluster'] for case in cases}),
                         'meanImprovement': mean(row['improvement'] for row in per_seed), 'perSeed': per_seed}
    auxiliary = {}
    for label in ('new-inputs-known-source', 'different-observations', 'different-schedules'):
        cases = [case for case in experiment.get('auxiliary', []) if label in case['auxiliarySlices']]
        if not cases:
            auxiliary[label] = {'status': 'untested', 'episodes': 0, 'independentComponents': 0}
            continue
        ids = {case['id'] for case in cases}
        rows = []
        for run in runs:
            arms = {key: arm_metrics(cases, [row for row in run['auxiliary'][key] if row['id'] in ids]) for key in ('base', 'trained')}
            rows.append({'optimizerSeed': run['optimizerSeed'], 'base': arms['base'], 'trained': arms['trained'],
                         'improvement': arms['trained']['familyWeightedWholeTaskSuccess'] - arms['base']['familyWeightedWholeTaskSuccess']})
        auxiliary[label] = {'status': 'measured', 'episodes': len(cases),
            'independentComponents': len({case['sourceCluster'] for case in cases}), 'perSeed': rows,
            'meanImprovement': mean(row['improvement'] for row in rows), 'includedInPrimaryHeldOutScore': False,
            'scope': 'Reserved inputs or fixtures on exact known training sources; components remain in train.'}
    improvement = mean(row['improvement'] for row in by_seed.values())
    requirements = {
        'declaredConfirmatoryExperiment': experiment['mode'] == 'confirmatory',
        'frozenInferenceBudget': experiment.get('rolloutBudget') is not None,
        'atLeastThreeOptimizerSeeds': len(by_seed) >= 3,
        'sameActualBaseCheckpointAcrossSeeds': len({row['baseIdentity'] for row in by_seed.values()}) == 1,
        'declaredTestComponentMinimum': len(component_deltas) >= policy['minimumConfirmatoryTestComponents'],
        'usefulMeanImprovement': improvement >= policy['minimumUsefulImprovement'],
        'pairedFamilyIntervalAboveZero': uncertainty['lower'] > 0,
        'improvementInEveryOptimizerSeed': all(row['improvement'] > 0 for row in by_seed.values()),
        'criticalSlicesMeasured': all(slices[label]['status'] == 'measured' for label in CRITICAL_SLICES),
        'noMaterialCriticalSliceRegression': all(slices[label]['status'] == 'measured' and all(
            item['improvement'] >= -policy['maximumCriticalSliceRegression'] for item in slices[label]['perSeed']) for label in CRITICAL_SLICES),
        'noIntegrityGateFailures': all(row[arm]['completeIntegrityGateReceipts'] == row[arm]['episodes'] and
            not any(row[arm]['integrityFailures'].values()) for row in by_seed.values() for arm in ('base', 'trained')),
    }
    return {'schema': 'semantic-learning-comparison/1', 'mode': experiment['mode'],
            'primaryMetric': 'family-weighted-whole-task-observable-correctness',
            'familyUnit': 'connected-source-ancestor-component', 'meanImprovement': improvement,
            'baseFamilyWeightedSuccess': mean(row['base']['familyWeightedWholeTaskSuccess'] for row in by_seed.values()),
            'trainedFamilyWeightedSuccess': mean(row['trained']['familyWeightedWholeTaskSuccess'] for row in by_seed.values()),
            'uncertainty': uncertainty, 'seeds': [by_seed[seed] for seed in sorted(by_seed)],
            'slices': slices, 'auxiliarySlices': auxiliary, 'requirements': requirements,
            'confirmatoryGatePassed': all(requirements.values()),
            'generalizationClaim': all(requirements.values()),
            'unmetRequirements': [key for key, passed in requirements.items() if not passed],
            'pureOutcomeTransfer': {'status': 'untested', 'reason': 'Run the separate pure-output-transfer adapter and compare its own frozen report; selected execution cannot establish that score.'},
            'teacherForcedLossIsExecutionAccuracy': False,
            'seedScope': 'Optimizer seeds are reported individually; the family bootstrap does not manufacture independent optimizer runs.'}
