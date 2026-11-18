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


def same_tensors(left, right):
    import torch
    if isinstance(left, torch.Tensor) or isinstance(right, torch.Tensor):
        return isinstance(left, torch.Tensor) and isinstance(right, torch.Tensor) and left.dtype == right.dtype and torch.equal(left, right)
    if type(left) is not type(right):
        return False
    if isinstance(left, dict):
        return left.keys() == right.keys() and all(same_tensors(value, right[key]) for key, value in left.items())
    if isinstance(left, (list, tuple)):
        return len(left) == len(right) and all(same_tensors(a, b) for a, b in zip(left, right))
    return left == right


def verify_bundle(info, checkpoint, expected_state, tokenizer_sha256, tokenizer_identity):
    """Bind every served attachment to both the actual checkpoint and cohort codec."""
    import torch
    from safetensors import safe_open
    from megatoken.generation.codec import ByteCodec
    from megatoken.model.config import ARCHITECTURE_VERSION
    from megatoken.controls import CONTROL_SCHEMA_VERSION
    from megatoken.lifecycle import LIFECYCLE_VERSION
    from megatoken.model.multitrack import GROUP_TAPE_VERSION
    from megatoken.training.checkpoint import load_checkpoint

    directory, checkpoint = Path(info['bundle']), Path(checkpoint)
    payload, metadata = load_checkpoint(checkpoint)
    if metadata['state_sha256'] != expected_state:
        raise ValueError('Diagnostic checkpoint bytes changed')
    manifest = json.loads((directory / 'manifest.json').read_text())
    for filename, field in [('model.safetensors', 'model_sha256'), ('model_config.json', 'config_sha256'),
                            ('transducer.pt', 'transducer_sha256'), ('tokenizer.json', 'tokenizer_sha256')]:
        if smoke.sha256(directory / filename) != manifest.get(field):
            raise ValueError(f'Diagnostic served {filename} bytes differ from its manifest')
    for field, value in [('format_version', ARCHITECTURE_VERSION), ('control_schema_version', CONTROL_SCHEMA_VERSION),
                         ('lifecycle_version', LIFECYCLE_VERSION), ('tape_version', GROUP_TAPE_VERSION),
                         ('event_addressing', 'independent_peer_events'), ('codec_file', 'tokenizer.json')]:
        if manifest.get(field) != value:
            raise ValueError(f'Diagnostic served {field} is incompatible')
    if (manifest.get('training_heads') is not False or manifest.get('model_sha256') != info['model_sha256'] or
            manifest.get('checkpoint_sha256') != expected_state or
            type(manifest.get('model_version')) is not int or
            manifest['model_version'] != payload.get('global_step')):
        raise ValueError('Diagnostic served model does not match its actual checkpoint version')
    if (manifest.get('tokenizer_sha256') != tokenizer_sha256 or
            manifest.get('codec_fingerprint') != tokenizer_identity or
            payload.get('codec_fingerprint') != tokenizer_identity):
        raise ValueError('Diagnostic served/checkpoint tokenizer differs from the frozen cohort')
    codec = ByteCodec.from_tokenizer_json(directory / 'tokenizer.json', expected_sha256=tokenizer_sha256,
                                         expected_vocab_size=payload['model_config']['vocab_size'])
    if codec.fingerprint != tokenizer_identity:
        raise ValueError('Actual diagnostic tokenizer identity differs')
    expected_config = {**payload['model_config'], 'checkpoint_stages': False}
    if json.loads((directory / 'model_config.json').read_text()) != expected_config:
        raise ValueError('Diagnostic served model config differs from its actual checkpoint')
    with safe_open(directory / 'model.safetensors', framework='pt', device='cpu') as saved:
        if not saved.keys() or set(saved.keys()) != set(payload['model']):
            raise ValueError('Diagnostic served tensor inventory differs from its checkpoint')
        for name in saved.keys():
            if not same_tensors(saved.get_tensor(name), payload['model'][name]):
                raise ValueError('Diagnostic served tensor differs from its actual checkpoint: ' + name)
    native_bank = torch.load(checkpoint / metadata['transducer_checkpoint']['file'], weights_only=True, map_location='cpu')
    expected_bank = native_bank.get('bank')
    if not isinstance(expected_bank, dict) or type(expected_bank.get('version')) is not int:
        raise ValueError('Diagnostic checkpoint transducer bank is missing')
    # Native export reload increments only the bank cache-invalidation version.
    expected_bank = {**expected_bank, 'version': expected_bank['version'] + 1}
    served_bank = torch.load(directory / 'transducer.pt', weights_only=True, map_location='cpu')
    if set(served_bank) != {'bank'} or not same_tensors(served_bank['bank'], expected_bank):
        raise ValueError('Diagnostic served transducer bank differs from its actual checkpoint')
    return {'modelSha256': manifest['model_sha256'],
            'checkpointSha256': expected_state, 'tensorsExact': True,
            'modelConfigExact': True, 'transducerBankExact': True,
            'tokenizerIdentity': codec.fingerprint, 'tokenizerSha256': tokenizer_sha256,
            'modelVersion': payload['global_step'],
            'manifestSha256': smoke.sha256(directory / 'manifest.json')}


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
              'runnerSha256': smoke.sha256(__file__),
              'optimizerHelperSha256': smoke.sha256(Path(__file__).with_name('run-optimization-smoke.py'))}

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
                             training['initialTrainingState']['baseCheckpointSha256'],
                             cohort['tokenizerSha256'], cohort['tokenizerIdentity'])
        trained = verify_bundle(training['trainedBundle'], training['checkpointVerification']['checkpoint'],
                                training['checkpointVerification']['stateSha256'],
                                cohort['tokenizerSha256'], cohort['tokenizerIdentity'])
        if base['modelSha256'] == trained['modelSha256']:
            raise ValueError('Actual trained and base models are identical')
        record(phase='evaluating', bundles={'fixed-weights': base, 'trained': trained})
        gc.collect()
        args.rollout_tokens = cohort['limits']['modelTokens']
        args.rollout_timeout = cohort['limits']['caseTimeoutSeconds']
        args.evaluator_script = tracer / 'tools/run-selected-evaluation.mjs'
        record(evaluatorRevision=cohort['producerRevision'],
               evaluatorScriptSha256=smoke.sha256(args.evaluator_script))
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
