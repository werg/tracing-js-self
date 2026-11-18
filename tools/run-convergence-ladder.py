#!/usr/bin/env python3
"""Freeze or execute a bounded L1/L2 gate using the existing native optimizer/rollout path.

This command does not download models or launch paid compute. Training is the
existing run-optimization-smoke.py --convergence-declaration path. The run
subcommand executes only the declared held-in evaluations of its exact trained
checkpoint, in independent model processes; it never evaluates the test set.
"""
from __future__ import annotations

import argparse
import gc
import importlib.util
import json
import os
from pathlib import Path
import sys
import time
import traceback

from convergence_ladder import (DECODE_POLICY, freeze_declaration, require_declaration,
                                require_optimization_binding, evaluate_ladder)

SPEC = importlib.util.spec_from_file_location('optimization_smoke', Path(__file__).with_name('run-optimization-smoke.py'))
SMOKE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SMOKE)


def read_json(path): return json.loads(Path(path).read_text())


def freeze(args):
    experiment = read_json(args.experiment)
    value = freeze_declaration(experiment, SMOKE.sha256(args.experiment), stage=args.stage,
        optimizer_seed=args.optimizer_seed, attempts_per_case=args.attempts_per_case,
        maximum_generated_tokens=args.maximum_generated_tokens,
        required_features=tuple(args.feature or ()))
    args.out.parent.mkdir(parents=True, exist_ok=True)
    with args.out.open('x') as handle:
        json.dump(value, handle, indent=2, allow_nan=False); handle.write('\n')
    print(json.dumps({'declaration': str(args.out), 'sha256': SMOKE.sha256(args.out),
                      'stage': value['stage'], 'plannedAttempts': len(value['plannedAttempts']),
                      'learnedSuccess': None, 'optimizerSteps': 0}))
    return 0


def run(args):
    declaration = require_declaration(read_json(args.declaration), read_json(args.experiment),
                                      SMOKE.sha256(args.experiment))
    declaration_sha = SMOKE.sha256(args.declaration)
    smoke = read_json(args.smoke_report)
    recorded_bundle = require_optimization_binding(declaration, smoke, declaration_sha)
    root = args.output.resolve()
    root.mkdir(parents=True, exist_ok=False)
    report = {'schema': 'semantic-convergence-run/1', 'status': 'running',
              'stage': declaration['stage'], 'declarationSha256': declaration_sha,
              'experimentSha256': SMOKE.sha256(args.experiment),
              'smokeReportSha256': SMOKE.sha256(args.smoke_report),
              'runnerSha256': SMOKE.sha256(__file__),
              'scorerSha256': SMOKE.sha256(Path(__file__).with_name('convergence_ladder.py')),
              'rolloutSha256': SMOKE.sha256(Path(__file__).with_name('run-optimization-smoke.py')),
              'launcherSha256': SMOKE.sha256(Path(__file__).with_name('launch-native-diagnostic.py')),
              'plannedAttempts': len(declaration['plannedAttempts']), 'completedAttempts': 0,
              'optimizerSteps': 0, 'learnedSuccess': None, 'testEvaluations': 0,
              'generalizationClaim': False, 'decodePolicy': DECODE_POLICY}
    attempts = []

    def record(**changes):
        report.update(changes)
        SMOKE.write_json(root/'report.json', report)

    record(phase='validating-original-checkpoint')
    # Bind every declaration before model loading. Failure keeps this directory
    # and its phase/error receipt; a partial retry cannot overwrite its outputs.
    SMOKE.write_json(root/'declaration.json', declaration)
    try:
        consumer = args.consumer_root.resolve()
        tracer = Path(__file__).resolve().parents[1]
        SMOKE.require_clean_checkout(consumer); SMOKE.require_clean_checkout(tracer)
        if (SMOKE.git_head(consumer) != declaration['nativePolicy']['consumerRevision'] or
                SMOKE.git_head(tracer) != declaration['producerRevision']):
            raise ValueError('Actual source/native checkout differs from the frozen training identities')
        sys.path.insert(0, str(consumer/'src'))
        import torch
        torch.set_num_threads(1)
        checkpoint = Path(smoke['checkpointVerification']['checkpoint']).resolve()
        if SMOKE.sha256(checkpoint/'state.pt') != smoke['checkpointVerification']['stateSha256']:
            raise ValueError('Original trained checkpoint bytes changed')
        initial_parameters = read_json(args.smoke_report.parent/'initial-parameter-identities.json')
        plan = read_json(args.smoke_report.parent/'native-window-plan.json')
        if SMOKE.sha256(args.smoke_report.parent/'native-window-plan.json') != smoke['nativeWindowPlan']['sha256']:
            raise ValueError('Original native window/exposure plan changed')
        reloaded = SMOKE.checkpoint_receipt(checkpoint, initial_parameters, stream_fingerprint=plan['streamFingerprint'])
        for key in ('stateSha256', 'modelTensorIdentity', 'globalStep'):
            if reloaded[key] != smoke['checkpointVerification'][key]:
                raise ValueError('Fresh native checkpoint reload differs: ' + key)
        SMOKE.write_json(root/'reloaded-checkpoint.json', reloaded)
        bundle = SMOKE.export_checked(checkpoint, root/'served-reloaded')
        for key in ('model_sha256', 'codec_fingerprint', 'tokenizer_sha256'):
            if bundle[key] != recorded_bundle[key]:
                raise ValueError('Fresh served export differs from the trained identity: ' + key)
        experiment = read_json(args.experiment)
        paths = []
        for row in experiment['training']:
            if SMOKE.sha256(row['path']) != row['fileSha256']:
                raise ValueError('Frozen source-certified input bytes changed')
            paths.append(row['path'])
        SMOKE.write_json(root/'inputs.json', paths)
        env = {**os.environ, 'PYTHONPATH': str(consumer/'src'), 'OMP_NUM_THREADS': '1', 'MKL_NUM_THREADS': '1'}
        SMOKE.run_logged(['node', str(Path(__file__).with_name('build-optimization-cases.mjs')),
                          str(root/'inputs.json'), str(root/'private-cases.json'), str(declaration['decoderSeed'])],
                         root/'build-cases.log', env=env, timeout=60)
        cases = read_json(root/'private-cases.json')['cases']
        if [row['id'] for row in cases] != [row['id'] for row in declaration['training']]:
            raise ValueError('Held-in evaluation cases differ from the frozen training identities')
        by_id = {case['id']: {**case, 'index': index} for index, case in enumerate(cases)}
        args.rollout_tokens = declaration['budget']['rollout']['nativeMaxTokensPerFragment']
        args.rollout_timeout = declaration['budget']['rollout']['secondsPerCase']
        args.native_process_receipts = True
        record(phase='independent-process-evaluation', trainedBundle=bundle,
               reloadedCheckpointSha256=SMOKE.sha256(root/'reloaded-checkpoint.json'))
        gc.collect()
        evaluation_started = time.monotonic()
        evaluation_deadline = evaluation_started + declaration['budget']['maximumEvaluationWallSeconds']
        for planned in declaration['plannedAttempts']:
            if evaluation_deadline - time.monotonic() < args.rollout_timeout + 45:
                raise TimeoutError('Aggregate frozen evaluation wall budget exhausted; remaining attempts are unmeasured')
            summary = SMOKE.rollout(by_id[planned['caseId']], 'trained', bundle, consumer,
                                    root/'attempts'/planned['attemptId'], args, env)
            attempts.append({**planned, 'evidenceKind': 'actual-native-process',
                             'decodePolicy': DECODE_POLICY, 'decoderSeed': declaration['decoderSeed'],
                             'summary': summary})
            SMOKE.write_json(root/'attempts.json', attempts)
            record(completedAttempts=len(attempts), attemptsSha256=SMOKE.sha256(root/'attempts.json'),
                   evaluationWallSeconds=time.monotonic() - evaluation_started)
        gates = evaluate_ladder(declaration, smoke, attempts, declaration_sha256=declaration_sha)
        SMOKE.write_json(root/'gates.json', gates)
        record(status='completed', phase='complete', gatesSha256=SMOKE.sha256(root/'gates.json'),
               learnedSuccess=gates['learnedSuccess'], gates=gates)
        print(json.dumps({'report': str(root/'report.json'), 'status': gates['status'],
                          'learnedSuccess': gates['learnedSuccess'], 'completedAttempts': len(attempts)}))
        return 0 if gates['status'] == 'passed' else 1
    except BaseException as error:
        record(status='failed', error={'type': type(error).__name__, 'message': str(error)},
               traceback=traceback.format_exc(), learnedSuccess=None,
               measurementStatus='incomplete' if attempts else 'unmeasured')
        raise


def inspect(args):
    declaration = require_declaration(read_json(args.declaration), read_json(args.experiment),
                                      SMOKE.sha256(args.experiment))
    value = evaluate_ladder(declaration, None, [], declaration_sha256=SMOKE.sha256(args.declaration))
    with args.out.open('x') as handle:
        json.dump(value, handle, indent=2, allow_nan=False); handle.write('\n')
    print(json.dumps({'status': value['status'], 'learnedSuccess': None, 'out': str(args.out)}))
    return 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='operation', required=True)
    frozen = commands.add_parser('freeze', help='Freeze engineering gates before training')
    frozen.add_argument('--experiment', type=Path, required=True)
    frozen.add_argument('--stage', choices=['L1', 'L2'], required=True)
    frozen.add_argument('--optimizer-seed', type=int, choices=[17, 29, 43], required=True)
    frozen.add_argument('--attempts-per-case', type=int)
    frozen.add_argument('--maximum-generated-tokens', type=int, default=2048)
    frozen.add_argument('--feature', action='append', help='Repeat for at least four L2 semantic feature strata')
    frozen.add_argument('--out', type=Path, required=True)
    execute = commands.add_parser('run', help='Run the exact declared native model process restarts')
    for command in (execute,):
        command.add_argument('--declaration', type=Path, required=True)
        command.add_argument('--experiment', type=Path, required=True)
    execute.add_argument('--smoke-report', type=Path, required=True)
    execute.add_argument('--consumer-root', type=Path, required=True)
    execute.add_argument('--output', type=Path, required=True)
    inspection = commands.add_parser('inspect', help='Report explicitly unmeasured gates without native execution')
    inspection.add_argument('--declaration', type=Path, required=True)
    inspection.add_argument('--experiment', type=Path, required=True)
    inspection.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    return {'freeze': freeze, 'run': run, 'inspect': inspect}[args.operation](args)


if __name__ == '__main__': raise SystemExit(main())
