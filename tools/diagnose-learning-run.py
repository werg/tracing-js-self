#!/usr/bin/env python3
"""Diagnose retained optimizer/rollout artifacts without model inference or edits."""
import argparse
import hashlib
import json
from pathlib import Path

from learning_diagnostics import SCHEMA, compare_conditioning_probes, first_action_diagnosis


def diagnose(run, *, training_probe=None, serving_probe=None, atol=1e-6, rtol=1e-5):
    run = Path(run).resolve()
    bindings = []

    def read(path):
        raw = path.read_bytes()
        try: name = str(path.relative_to(run))
        except ValueError: name = path.name
        bindings.append({'path': name, 'sha256': hashlib.sha256(raw).hexdigest(), 'bytes': len(raw)})
        return json.loads(raw)

    report = read(run / 'report.json')
    rollout_files = sorted((run / 'rollouts').glob('*/[0-9]*/summary.json'))
    rollouts = [first_action_diagnosis(read(path)) for path in rollout_files]
    # Older retained layouts keep all rollouts inside the unchanged report.
    if not rollout_files:
        rollouts = [first_action_diagnosis(row) for row in report.get('rollouts', [])]
    parity = compare_conditioning_probes(read(Path(training_probe)) if training_probe else None,
                                        read(Path(serving_probe)) if serving_probe else None,
                                        atol=atol, rtol=rtol)
    training = report.get('trainingSummary', [])
    missing = []
    target_file = run / 'target-audit.json'
    target = read(target_file) if target_file.exists() else None
    if target is None: missing.append('exact target bytes, tokenizer segmentation and per-position masks')
    if parity['status'] == 'unmeasured': missing.append('same-checkpoint training/serving conditionals')
    missing += ['objective-specific per-head gradients and update norms', 'free-running exact-reload convergence ladder']
    layers = ', '.join(sorted({row['firstFailureLayer'] for row in rollouts})) or 'unmeasured'
    return {'schema': SCHEMA, 'scope': 'read-only diagnosis of original retained evidence',
            'producerRevision': report.get('producerRevision'), 'consumerRevision': report.get('consumerRevision'),
            'runnerRevision': report.get('runnerRevision'), 'tokenizerIdentity': report.get('tokenizerIdentity'),
            'optimizerSteps': report.get('optimizerSteps'), 'supervisedLexicalTokens': report.get('supervisedLexicalTokens'),
            'trainingExposure': report.get('trainingExposure'), 'lossMaskCounts': report.get('lossMaskCounts'),
            'firstTrainingUpdate': training[0] if training else None,
            'lastTrainingUpdate': training[-1] if training else None,
            'gradientScope': 'Original aggregate encoder/model/shared norms; no per-objective inference',
            'exactTargetAudit': {'status': 'retained' if target else 'unmeasured',
                                 'tokenizerIdentity': target.get('tokenizerIdentity') if target else None},
            'trainingServingParity': parity, 'rollouts': rollouts,
            'unmeasured': missing,
            'diagnosis': ('Observed execution layers: ' + layers + '. Retained evidence does not isolate '
                          'optimization from training/serving conditioning until conditional probes are captured.'),
            'inputBindings': bindings, 'newOptimizerSteps': 0, 'newModelExecutions': 0,
            'learningClaim': False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run', type=Path, required=True)
    parser.add_argument('--training-probe', type=Path)
    parser.add_argument('--serving-probe', type=Path)
    parser.add_argument('--atol', type=float, default=1e-6)
    parser.add_argument('--rtol', type=float, default=1e-5)
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    result = diagnose(args.run, training_probe=args.training_probe, serving_probe=args.serving_probe,
                      atol=args.atol, rtol=args.rtol)
    with args.out.open('x') as output:
        json.dump(result, output, indent=2, ensure_ascii=False, allow_nan=False)
        output.write('\n')
    print(json.dumps({'output': str(args.out), 'rollouts': len(result['rollouts']),
                      'parity': result['trainingServingParity']['status'], 'newOptimizerSteps': 0}))
    if result['trainingServingParity']['status'] == 'failed': raise SystemExit(1)


if __name__ == '__main__': main()
