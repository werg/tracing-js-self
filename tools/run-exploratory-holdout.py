#!/usr/bin/env python3
"""Measure frozen test components with actual diagnostic base/trained bundles.

This intentionally emits no production pilot report, SE/SC qualification, or
native semantic experiment budget. It is a one-seed exploratory measurement.
"""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
import gc
import importlib.util
import json
import os
from pathlib import Path
import sys
import traceback

spec = importlib.util.spec_from_file_location('optimization_smoke',
                                             Path(__file__).with_name('run-optimization-smoke.py'))
smoke = importlib.util.module_from_spec(spec)
spec.loader.exec_module(smoke)


def verify_bundle(info, checkpoint, expected_state):
    from megatoken.loading import load_trained
    from megatoken.served import ServedBundle
    from megatoken.training.checkpoint import load_checkpoint

    payload, metadata = load_checkpoint(checkpoint)
    if metadata['state_sha256'] != expected_state:
        raise ValueError('Diagnostic checkpoint bytes changed')
    del payload
    loaded = load_trained(checkpoint, device='cpu')
    bundle = ServedBundle(info['bundle'], device='cpu')
    if (bundle.manifest['model_sha256'] != info['model_sha256'] or
            bundle.manifest['checkpoint_sha256'] != expected_state or
            smoke.hashes(loaded.model.served_state_dict()) != smoke.hashes(bundle.model.served_state_dict())):
        raise ValueError('Diagnostic served model does not match its actual checkpoint')
    return {'modelSha256': bundle.manifest['model_sha256'],
            'checkpointSha256': expected_state, 'tensorsExact': True,
            'tokenizerIdentity': bundle.codec.fingerprint,
            'manifestSha256': smoke.sha256(Path(info['bundle']) / 'manifest.json')}


def summarize(rows):
    arms = {}
    for origin in ['fixed-weights', 'trained']:
        selected = [row for row in rows if row['origin'] == origin]
        families = defaultdict(list)
        for row in selected:
            families[row['family']].append(row['wholeTaskSuccess'])
        per_family = {family: sum(values) / len(values) for family, values in sorted(families.items())}
        gate_names = ['futureObservationLeaks', 'unauthorizedEffects', 'untrackedNativeFallback',
                      'falseAdmissions', 'replayNativeEffects']
        cleanup_names = ['pendingEffects', 'pendingJobs', 'openHandlers']
        def totals(field, names):
            return {name: sum(row[field][name] for row in selected)
                    if all(type(row.get(field, {}).get(name)) is int for row in selected) else None
                    for name in names}
        arms[origin] = {'episodes': len(selected), 'families': len(per_family),
                        'wholeTaskSuccesses': sum(row['wholeTaskSuccess'] for row in selected),
                        'episodeWeightedCorrectness': sum(row['wholeTaskSuccess'] for row in selected) / len(selected),
                        'familyWeightedCorrectness': sum(per_family.values()) / len(per_family),
                        'familyScores': per_family,
                        'failureCategories': dict(Counter((row.get('failure') or {}).get('category',
                                                         row.get('pipelineFailure', 'none')) for row in selected)),
                        'hardGateTotals': totals('hardGates', gate_names),
                        'cleanupTotals': totals('cleanup', cleanup_names),
                        'originalEmittedTokens': sum(row['originalEmittedTokens'] for row in selected)
                        if all(row.get('originalEmittedTokens') is not None for row in selected) else None,
                        'wallSeconds': sum(row['wallSeconds'] for row in selected)}
    return {'arms': arms, 'familyWeightedChange': arms['trained']['familyWeightedCorrectness'] -
            arms['fixed-weights']['familyWeightedCorrectness'],
            'uncertainty': 'Descriptive one-seed bounded sample; no confirmatory interval or broad transfer claim.'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--cohort', type=Path, required=True)
    parser.add_argument('--consumer-root', type=Path, required=True)
    parser.add_argument('--tracer-root', type=Path, required=True)
    parser.add_argument('--tokenizer-json', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    root, consumer, tracer = args.output.resolve(), args.consumer_root.resolve(), args.tracer_root.resolve()
    root.mkdir(parents=True, exist_ok=False)
    report = {'schema': 'exploratory-heldout-diagnostic-report/1', 'status': 'running',
              'purpose': 'diagnostic', 'confirmatory': False, 'productionQualification': False,
              'injectedSelections': False, 'generalizationClaim': False,
              'cohortPath': str(args.cohort.resolve()), 'cohortSha256': smoke.sha256(args.cohort),
              'runnerRevision': smoke.git_head(Path(__file__).resolve().parent.parent),
              'runnerSha256': smoke.sha256(__file__)}

    def record(**changes):
        report.update(changes)
        smoke.write_json(root / 'report.json', report)

    record(phase='authenticating')
    try:
        cohort = json.loads(args.cohort.read_text())
        if (cohort.get('schema') != 'exploratory-heldout-diagnostic-cohort/1' or
                cohort.get('confirmatory') is not False or cohort.get('productionQualification') is not False):
            raise ValueError('Only a frozen exploratory diagnostic cohort is accepted')
        smoke.require_clean_checkout(consumer)
        smoke.require_clean_checkout(tracer)
        if (smoke.git_head(consumer) != cohort['consumerRevision'] or
                smoke.git_head(tracer) != cohort['producerRevision'] or
                smoke.sha256(args.tokenizer_json) != cohort['tokenizerSha256']):
            raise ValueError('Frozen producer, consumer, or tokenizer bytes differ')
        training_path = Path(cohort['trainingReport']['path'])
        if smoke.sha256(training_path) != cohort['trainingReport']['sha256']:
            raise ValueError('Bound training report changed after holdout freeze')
        training = json.loads(training_path.read_text())
        env = {**os.environ, 'PYTHONPATH': str(consumer / 'src'),
               'OMP_NUM_THREADS': '1', 'MKL_NUM_THREADS': '1'}
        rebuilt = root / 'rechecked-cohort.json'
        command = ['node', str(Path(__file__).with_name('build-exploratory-holdout.mjs')),
                   '--training-run', str(training_path.parent), '--tracer-root', str(tracer),
                   '--registry', cohort['registry']['path'], '--output', str(rebuilt),
                   '--maximum', str(len(cohort['cases'])), '--seed', str(cohort['seed'])]
        for source in cohort['sourceCorpora']:
            command.extend(['--corpus', source['path']])
        smoke.run_logged(command, root / 'cohort-recheck.log', env=env, timeout=120)
        rebuilt_value = json.loads(rebuilt.read_text())
        if ({key: value for key, value in cohort.items() if key != 'createdAt'} !=
                {key: value for key, value in rebuilt_value.items() if key != 'createdAt'}):
            raise ValueError('Frozen holdout membership, private expectations, or request bytes changed')
        sys.path.insert(0, str(consumer / 'src'))
        from megatoken.data.semantic_corpus import source_verifier_for_checkout, verify_admission
        from megatoken.data.semantic_admission import native_admission
        from megatoken.generation.codec import ByteCodec, LING_TOKENIZER_SHA256
        codec = ByteCodec.from_tokenizer_json(args.tokenizer_json.resolve(), expected_sha256=LING_TOKENIZER_SHA256)
        source_verifier = source_verifier_for_checkout(tracer, cohort['producerRevision'])
        record(phase='rechecking-source-native', producerRevision=cohort['producerRevision'],
               consumerRevision=cohort['consumerRevision'], tokenizerIdentity=codec.fingerprint,
               independentTestComponents=len(cohort['testComponents']), families=cohort['families'],
               optimizerSteps=training['optimizerSteps'], trainingReportSha256=cohort['trainingReport']['sha256'],
               sampleScope=cohort['selectionPolicy'], limits=cohort['limits'])
        admissions = []
        for index, case in enumerate(cohort['cases']):
            path = Path(case['inputPath'])
            if smoke.sha256(path) != case['inputSha256']:
                raise ValueError('Frozen holdout source export bytes changed')
            document = json.loads(path.read_text())
            source = source_verifier(document)
            native = native_admission(document, codec=codec,
                                      consumer_revision=cohort['consumerRevision'],
                                      max_positions=1024, max_history=1024)
            verify_admission(document, source, native, producer_revision=cohort['producerRevision'],
                             consumer_revision=cohort['consumerRevision'], codec=codec)
            if document['sidecar']['split'] != 'test':
                raise ValueError('A held-out source was relabeled during verification')
            receipt = {'id': case['id'], 'sourceCluster': case['sourceCluster'],
                       'inputSha256': case['inputSha256'], 'source': source, 'native': native}
            smoke.write_json(root / 'admission' / f'{index:04d}.json', receipt)
            admissions.append({'id': case['id'], 'sourceCluster': case['sourceCluster'], 'admitted': True})
            record(admissions=admissions)
            del document
            gc.collect()
        record(phase='verifying-checkpoints')
        import torch
        torch.set_num_threads(1)
        base = verify_bundle(training['baseBundle'], training['initialCheckpoint'],
                             training['initialTrainingState']['baseCheckpointSha256'])
        trained = verify_bundle(training['trainedBundle'], training['checkpointVerification']['checkpoint'],
                                training['checkpointVerification']['stateSha256'])
        if base['modelSha256'] == trained['modelSha256']:
            raise ValueError('Actual trained and base models are identical')
        record(phase='evaluating', bundles={'fixed-weights': base, 'trained': trained})
        gc.collect()
        args.rollout_tokens = cohort['limits']['modelTokens']
        args.rollout_timeout = cohort['limits']['caseTimeoutSeconds']
        rows = []
        for index, case in enumerate(cohort['cases']):
            case = {**case, 'index': index}
            for origin, bundle in [('fixed-weights', training['baseBundle']), ('trained', training['trainedBundle'])]:
                result = smoke.rollout(case, origin, bundle, consumer, root / 'rollouts', args, env)
                token_count = None
                if 'pipelineFailure' not in result:
                    raw = json.loads((Path(result['artifacts']) / 'result.json').read_text())
                    fragments = [fragment for decision in raw.get('selections', [])
                                 for fragment in decision.get('selection', {}).get('fragments', [])]
                    fragments += ((raw.get('failure') or {}).get('evidence') or {}).get('fragments', [])
                    unique = {json.dumps(fragment, sort_keys=True): fragment for fragment in fragments}
                    token_count = sum(len(fragment['emittedTokenIds']) for fragment in unique.values())
                result['originalEmittedTokens'] = token_count
                rows.append({**result, 'family': case['family'], 'sourceCluster': case['sourceCluster']})
                record(rollouts=rows)
        record(status='completed', phase='complete', summary=summarize(rows),
               limitations=cohort['limitations'] + [
                   'Native masks/checkpoints are real, but no production SE/SC qualification or semantic budget exists.',
                   'Failure at a first action does not establish successful learned effects, errors, or cleanup.'])
        print(json.dumps({'report': str(root / 'report.json'), 'summary': report['summary']}))
    except BaseException as error:
        record(status='failed', error={'type': type(error).__name__, 'message': str(error)},
               traceback=traceback.format_exc())
        raise


if __name__ == '__main__':
    main()
