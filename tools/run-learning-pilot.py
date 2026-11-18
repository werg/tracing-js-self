#!/usr/bin/env python3
"""Evaluate a predeclared v5 transfer pilot using real native served models.

Run freeze-learning-experiment.mjs BEFORE run-optimization-smoke.py --experiment.
Each checkpoint is ranked on validation only; only its chosen identity and the
same initialized base are then evaluated on the frozen test source components.
"""
from __future__ import annotations

import argparse
import gc
import importlib.util
import json
import os
from pathlib import Path
import sys
import traceback

from learning_evaluation import require_frozen_experiment, choose_validation_checkpoint, summarize_learning, selected_rollout_budget

SPEC = importlib.util.spec_from_file_location('optimization_smoke', Path(__file__).with_name('run-optimization-smoke.py'))
SMOKE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SMOKE)


def exact_bundle(recorded):
    from megatoken.served import ServedBundle
    bundle = ServedBundle(recorded['bundle'], device='cpu')
    manifest = bundle.manifest
    for key in ('model_sha256', 'transducer_sha256', 'codec_fingerprint', 'tokenizer_sha256'):
        if manifest[key] != recorded[key]:
            raise ValueError(f'Served {key} differs from optimizer receipt')
    del bundle
    gc.collect()
    return recorded


def locate_checkpoint(smoke_path, step):
    roots = smoke_path.parent / 'training/checkpoints'
    matches = []
    for path in roots.glob('*/metadata.json'):
        metadata = json.loads(path.read_text())
        if metadata.get('global_step') == step:
            matches.append(path.parent)
    if not matches:
        raise ValueError(f'Frozen step {step} checkpoint missing; retention must preserve the declared schedule')
    # Periodic and pinned run-end snapshots of one step carry the same model;
    # selecting one by path cannot inspect a test score.
    return sorted(matches)[0]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--experiment', type=Path, required=True)
    parser.add_argument('--smoke-report', type=Path, action='append', required=True)
    parser.add_argument('--consumer-root', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--rollout-tokens', type=int)
    parser.add_argument('--rollout-timeout', type=int)
    args = parser.parse_args()
    if (args.rollout_tokens is not None and not 1 <= args.rollout_tokens <= 1024 or
            args.rollout_timeout is not None and not 1 <= args.rollout_timeout <= 300):
        parser.error('Rollout tokens must be 1..1024 and timeout 1..300 seconds')
    root = args.output.resolve()
    root.mkdir(parents=True, exist_ok=False)
    report = {'schema': 'semantic-learning-pilot/1', 'status': 'running',
              'phase': 'initializing', 'generalizationClaim': False, 'injectedSelections': False,
              'experimentSha256': SMOKE.sha256(args.experiment), 'completedRollouts': 0,
              'runnerSha256': SMOKE.sha256(__file__), 'runnerRevision': SMOKE.git_head(Path(__file__).parent.parent),
              'scoringSha256': SMOKE.sha256(Path(__file__).with_name('learning_evaluation.py')),
              'rolloutImplementationSha256': SMOKE.sha256(Path(__file__).with_name('run-optimization-smoke.py'))}

    def record(**changes):
        report.update(changes)
        SMOKE.write_json(root / 'report.json', report)

    record()
    try:
        experiment = require_frozen_experiment(json.loads(args.experiment.read_text()))
        budget = selected_rollout_budget(experiment)
        args.rollout_tokens = args.rollout_tokens if args.rollout_tokens is not None else budget['nativeMaxTokensPerFragment']
        args.rollout_timeout = args.rollout_timeout if args.rollout_timeout is not None else budget['secondsPerCase']
        if experiment.get('rolloutBudget') is not None and (args.rollout_tokens != budget['nativeMaxTokensPerFragment'] or
                args.rollout_timeout != budget['secondsPerCase']):
            raise ValueError('Actual inference caps differ from the frozen budget')
        consumer = args.consumer_root.resolve()
        SMOKE.require_clean_checkout(consumer)
        if SMOKE.git_head(consumer) != experiment['nativePolicy']['consumerRevision']:
            raise ValueError('Actual native consumer differs from the frozen policy')
        sys.path.insert(0, str(consumer / 'src'))
        import torch
        torch.set_num_threads(1)
        env = {**os.environ, 'PYTHONPATH': str(consumer / 'src'), 'OMP_NUM_THREADS': '1', 'MKL_NUM_THREADS': '1'}
        runs = []
        smoke_runs = []
        for path in args.smoke_report:
            path = path.resolve()
            smoke = json.loads(path.read_text())
            if (smoke.get('schema') != 'optimization-smoke/1' or smoke.get('status') != 'completed' or
                    smoke.get('experimentSha256') != report['experimentSha256'] or
                    smoke['producerRevision'] != experiment['producerRevision'] or
                    smoke['consumerRevision'] != experiment['nativePolicy']['consumerRevision'] or
                    smoke['tokenizerIdentity'] != experiment['nativePolicy']['tokenizerIdentity'] or
                    smoke['tokenizerSha256'] != experiment['nativePolicy']['tokenizerSha256'] or
                    smoke['optimizerSteps'] != max(experiment['checkpointSteps']) or
                    smoke['initializationSeed'] != experiment['initializationSeed'] or
                    smoke['trainingCandidateIdentities'] != [row['identityDigest'] for row in experiment['training']] or
                    smoke.get('baseOrigin') != experiment['baseOrigin'] or
                    not smoke['initialTrainingState']['exact'] or not smoke['checkpointVerification']['reloadExact']):
                raise ValueError('Optimizer receipt does not bind this predeclared experiment and exact starting model')
            smoke_runs.append((path, smoke))
        if sorted(smoke['optimizerSeed'] for _, smoke in smoke_runs) != sorted(experiment['optimizerSeeds']):
            raise ValueError('One actual optimizer run required for each frozen seed')
        record(phase='validation', smokeReports=[{'path': str(path), 'sha256': SMOKE.sha256(path)} for path, _ in smoke_runs],
               population=experiment['population'], baseOrigin=experiment['baseOrigin'],
               decoderSeed=experiment['decoderSeed'], optimizerSeeds=experiment['optimizerSeeds'],
               rolloutBudget=budget)
        selected = []
        # Finish every validation decision and durably seal selections before
        # running ANY test case. Test outcomes cannot influence checkpoint choice.
        for smoke_path, smoke in smoke_runs:
            seed = smoke['optimizerSeed']
            destination = root / f'seed-{seed}'
            candidates, bundles, checkpoint_receipts = [], {}, {}
            for step in experiment['checkpointSteps']:
                checkpoint = locate_checkpoint(smoke_path, step)
                bundle = SMOKE.export_checked(checkpoint, destination / f'served-step-{step}')
                if bundle['codec_fingerprint'] != experiment['nativePolicy']['tokenizerIdentity']:
                    raise ValueError('Actual checkpoint tokenizer differs from the frozen policy')
                from megatoken.training.checkpoint import load_checkpoint
                payload, metadata = load_checkpoint(checkpoint)
                if (payload['global_step'] != step or payload['train_config']['seed'] != seed or
                        payload['train_config']['datasets'] != [str(smoke_path.parent / 'prepared')] or
                        payload['codec_fingerprint'] != experiment['nativePolicy']['tokenizerIdentity']):
                    raise ValueError('Checkpoint is not from this declared optimizer/data run')
                checkpoint_receipts[step] = {'checkpointStateSha256': metadata['state_sha256'],
                    'globalStep': step, 'sourceSampling': metadata['source_sampling']}
                del payload
                bundles[step] = bundle
                gc.collect()
                measurements = []
                for index, frozen_case in enumerate(experiment['validation']):
                    case = {**frozen_case, 'index': index}
                    measured = SMOKE.rollout(case, 'trained', bundle, consumer,
                                            destination / 'validation' / f'step-{step}', args, env)
                    measurements.append(measured)
                    record(completedRollouts=report['completedRollouts'] + 1)
                candidates.append({'step': step, 'checkpointIdentity': bundle['model_sha256'],
                                   'checkpointReceipt': checkpoint_receipts[step], 'cases': measurements})
                SMOKE.write_json(destination / 'validation-results.json', candidates)
            choice = choose_validation_checkpoint(experiment, candidates)
            SMOKE.write_json(destination / 'selection.json', choice)
            selected.append((smoke, candidates, choice, bundles[choice['step']], checkpoint_receipts[choice['step']]))
        SMOKE.write_json(root / 'sealed-selections.json', {'experimentSha256': report['experimentSha256'],
            'testUsedForSelection': False, 'selections': [{'optimizerSeed': smoke['optimizerSeed'],
                'selection': choice} for smoke, _, choice, _, _ in selected]})
        record(phase='test', sealedSelectionsSha256=SMOKE.sha256(root / 'sealed-selections.json'))
        for smoke, candidates, choice, trained, selected_receipt in selected:
            seed = smoke['optimizerSeed']
            base = exact_bundle(smoke['baseBundle'])
            if base['model_sha256'] == trained['model_sha256']:
                raise ValueError('Optimization did not change actual served identity')
            run = {'optimizerSeed': seed, 'optimizerSteps': smoke['optimizerSteps'],
                   'baseIdentity': base['model_sha256'], 'trainedIdentity': trained['model_sha256'],
                   'selection': choice, 'validation': candidates, 'base': [], 'trained': [],
                   'auxiliary': {'base': [], 'trained': []},
                   'trainingExposure': smoke['checkpointVerification']['sourceSampling'],
                   'trainingSupervisedTokens': smoke['supervisedLexicalTokens'],
                   'selectedCheckpointReceipt': selected_receipt,
                   'selectedCheckpointSupervisedTokens': sum(row['denominators']['lexical'] for row in
                       smoke['trainingSummary'] if row['step'] <= choice['step'])}
            runs.append(run)
            for index, frozen_case in enumerate(experiment['test']):
                case = {**frozen_case, 'index': index}
                for arm, origin, bundle in [('base', 'fixed-weights', base), ('trained', 'trained', trained)]:
                    run[arm].append(SMOKE.rollout(case, origin, bundle, consumer,
                        root / f'seed-{seed}' / 'test', args, env))
                    SMOKE.write_json(root / 'measured-runs.json', runs)
                    record(completedRollouts=report['completedRollouts'] + 1)
            for index, frozen_case in enumerate(experiment.get('auxiliary', [])):
                case = {**frozen_case, 'index': index}
                for arm, origin, bundle in [('base', 'fixed-weights', base), ('trained', 'trained', trained)]:
                    run['auxiliary'][arm].append(SMOKE.rollout(case, origin, bundle, consumer,
                        root / f'seed-{seed}' / 'auxiliary', args, env))
                    SMOKE.write_json(root / 'measured-runs.json', runs)
                    record(completedRollouts=report['completedRollouts'] + 1)
        comparison = summarize_learning(experiment, runs)
        SMOKE.write_json(root / 'comparison.json', comparison)
        record(status='completed', phase='complete', comparisonSha256=SMOKE.sha256(root / 'comparison.json'),
               comparison=comparison, generalizationClaim=comparison['generalizationClaim'])
        print(json.dumps({'report': str(root / 'report.json'), 'comparison': str(root / 'comparison.json'),
                          'meanImprovement': comparison['meanImprovement'],
                          'confirmatoryGatePassed': comparison['confirmatoryGatePassed']}))
        return 0
    except BaseException as error:
        record(status='failed', error={'type': type(error).__name__, 'message': str(error)}, traceback=traceback.format_exc())
        raise


if __name__ == '__main__':
    raise SystemExit(main())
