#!/usr/bin/env python3
"""Run capped, genuine CPU optimization and selected-driver rollouts on admitted v5 data.

This uses Megatoken's explicit diagnostic training mode. It is not a production
SE/SC launch, pretrained-model experiment, or generalization result. Every
candidate is freshly source/native verified. No controlled selection reaches
the real model process. Reports are updated after each durable phase.
"""

from __future__ import annotations

import argparse
import gc
import hashlib
import json
import os
import resource
import subprocess
import sys
import time
import traceback
from collections import Counter, defaultdict
from dataclasses import asdict
from pathlib import Path


def write_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + '.tmp')
    with temporary.open('w') as handle:
        json.dump(value, handle, indent=2, allow_nan=False)
        handle.write('\n')
        handle.flush()
        os.fsync(handle.fileno())
    temporary.replace(path)


def sha256(path):
    digest = hashlib.sha256()
    with Path(path).open('rb') as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def git_head(path):
    return subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=path, text=True).strip()


def require_clean_checkout(path):
    if subprocess.run(['git', 'diff', '--quiet', 'HEAD', '--'], cwd=path).returncode:
        raise ValueError(f'Pinned source/consumer checkout has tracked changes: {path}')


def run_logged(command, path, *, env, timeout, input_text=None):
    with Path(path).open('w') as log:
        result = subprocess.run(command, input=input_text, text=True, stdout=log,
                                stderr=subprocess.STDOUT, env=env, timeout=timeout)
    if result.returncode:
        raise RuntimeError(f'Command exited {result.returncode}; retained log: {path}')


def choose_candidates(corpora, maximum):
    groups = defaultdict(list)
    sources, revisions, identities, episodes = [], set(), {}, set()
    for corpus in corpora:
        manifest_path = corpus / 'manifest.json'
        manifest = json.loads(manifest_path.read_text())
        revisions.add(manifest['producerRevision'])
        sources.append({'path': str(corpus), 'manifestSha256': sha256(manifest_path),
                        'producerRevision': manifest['producerRevision'], 'counts': manifest['counts']})
        for item in manifest['cases']:
            if item.get('status') == 'admitted' and item.get('split') == 'train' and item.get('path'):
                path = (corpus / item['path']).resolve()
                if not path.is_relative_to(corpus):
                    raise ValueError('Corpus compatibility path escapes its root')
                identity = item['episodeDigest']
                if item['id'] in identities and identities[item['id']] != identity:
                    raise ValueError('A repeated candidate identity names different public bytes')
                identities[item['id']] = identity
                if identity in episodes:
                    continue
                episodes.add(identity)
                groups[item['family']].append((item, path))
    if len(revisions) != 1:
        raise ValueError('All smoke corpora must use the same immutable producer revision')
    selected = []
    def cost(pair):
        item, _ = pair
        tokens = item.get('metrics', {}).get('generatedTokens')
        size = item.get('publicShard', {}).get('uncompressedBytes')
        return (tokens if type(tokens) is int and tokens > 0 else float('inf'),
                size if type(size) is int and size > 0 else float('inf'), item['id'])
    for family in groups:
        groups[family].sort(key=cost)
    while groups and len(selected) < maximum:
        for family in sorted(list(groups)):
            if len(selected) == maximum:
                break
            selected.append(groups[family].pop(0))
            if not groups[family]:
                del groups[family]
    if not selected:
        raise ValueError('No natively admitted training compatibility exports in corpus')
    return {'producerRevision': revisions.pop(), 'sources': sources}, selected


def tensor_hash(tensor):
    value = tensor.detach().cpu().contiguous()
    header = json.dumps([str(value.dtype), list(value.shape)]).encode()
    return hashlib.sha256(header + value.numpy().tobytes()).hexdigest()


def hashes(state):
    return {name: tensor_hash(value) for name, value in sorted(state.items())}


def state_identity(state):
    return hashlib.sha256(json.dumps(hashes(state), sort_keys=True).encode()).hexdigest()


def intern_registries(value, cache, counts):
    """Share only byte-identical decoded registry subtrees; preserve every field."""
    if isinstance(value, dict):
        if value.get('schema') == 'semantic-source-registry/1':
            encoded = json.dumps(value, ensure_ascii=False, separators=(',', ':'), allow_nan=False)
            counts['registryOccurrences'] += 1
            if encoded in cache:
                counts['duplicateRegistrySerializedBytes'] += len(encoded.encode())
            else:
                cache[encoded] = value
            return cache[encoded]
        for key in value:
            value[key] = intern_registries(value[key], cache, counts)
    elif isinstance(value, list):
        for index, item in enumerate(value):
            value[index] = intern_registries(item, cache, counts)
    return value


def mask_receipt(prepared, codec):
    from megatoken.data.schema import encode_record
    from megatoken.data.storage import PreparedCorpus

    counts = Counter()
    rows = []
    with PreparedCorpus([str(prepared)]) as corpus:
        for episode in corpus.iter_episodes():
            for record in episode.records:
                encoded = encode_record(record, codec)
                generated = record.policy_mask
                scored = sum(encoded.free_mask)
                if not generated and scored:
                    raise ValueError('Observed host/input tokens carry loss')
                if generated and (not scored or scored != len(encoded.token_ids)):
                    raise ValueError('Generated v5 computation/action record lacks full supervision')
                kind = 'generated' if generated else 'observed'
                counts[kind + 'Records'] += 1
                counts[kind + 'Tokens'] += len(encoded.token_ids)
                counts[kind + 'ScoredTokens'] += scored
                counts['maxGeneratedTokens'] = max(counts['maxGeneratedTokens'], scored)
                rows.append({'episode': episode.episode_id, 'record': record.record_id,
                             'kind': kind, 'tokens': len(encoded.token_ids), 'scored': scored})
        if not counts['generatedTokens'] or not counts['observedTokens']:
            raise ValueError('Smoke needs both observed inputs and generated supervision')
        return {'validated': True, 'corpusIdentity': corpus.identity,
                'episodes': len(corpus), 'counts': dict(counts), 'records': rows,
                'chunking': corpus.chunking}


def create_initial_checkpoint(root, config, codec, chunking):
    from megatoken.loading import build_model, load_model_config
    from megatoken.runtime import seed_everything
    from megatoken.training.checkpoint import save_checkpoint, transducer_attachment
    from megatoken.training.optimizer import MasterAdamW
    from megatoken.training.transducer import TransducerTrainer

    seed_everything(config.seed, config.deterministic)
    model_config = load_model_config(config.model, **config.model_overrides,
                                    expert_backend=config.expert_backend,
                                    checkpoint_stages=config.gradient_checkpointing)
    model = build_model(model_config, codec, device='cpu', precision='fp32')
    optimizer = MasterAdamW(model, config.schedule.learning_rate(0), config.weight_decay,
                           inner_optimizer=config.inner_optimizer)
    transducer = TransducerTrainer(model.transducer, bank_trainable=True,
                                  teacher_weight=config.hindsight_distill_weight,
                                  navigation_weight=config.navigation_weight,
                                  navigation_examples=config.navigation_examples,
                                  navigation_negatives=config.navigation_negatives)
    # These are genuine unstepped model/optimizer states. The official trainer
    # loads this exact checkpoint with its supported phase-transition path.
    payload = {'model': model.state_dict(), 'optimizer': optimizer.state_dict(),
               'model_config': model_config.to_dict(), 'train_config': asdict(config),
               'codec_fingerprint': codec.fingerprint, 'packs_fingerprint': None,
               'chunking': chunking, 'global_step': 0}
    initial_parameters = hashes(dict(model.named_parameters()))
    checkpoint = save_checkpoint(root / 'initialization', 'initialized-untrained', payload,
                                 {'global_step': 0, 'optimizerSteps': 0,
                                  'origin': 'newly-initialized-tiny-diagnostic'}, pinned=True,
                                 attachments=transducer_attachment(transducer.state_dict))
    optimizer.close()
    return checkpoint, initial_parameters


def checkpoint_receipt(checkpoint, initial_parameters):
    import torch
    from megatoken.loading import load_trained
    from megatoken.training.checkpoint import load_checkpoint

    loaded = load_trained(checkpoint, device='cpu')
    payload, metadata = load_checkpoint(checkpoint)
    original = hashes(payload['model'])
    reloaded = hashes(loaded.model.state_dict())
    if original != reloaded:
        raise ValueError('Reloaded checkpoint tensors differ from the committed model')
    parameters = dict(loaded.model.named_parameters())
    current = hashes(parameters)
    if current.keys() != initial_parameters.keys():
        raise ValueError('Trainable parameter ownership changed')
    changed = [name for name in current if current[name] != initial_parameters[name]]
    if not changed or not all(torch.isfinite(value).all() for value in parameters.values()):
        raise ValueError('Optimizer did not produce finite, changed model parameters')
    moments = payload['optimizer']['moments']
    updated = [name for name, value in moments.items() if float(value.get('step', 0)) > 0]
    if not updated or not set(changed).intersection(updated):
        raise ValueError('Changed weights lack actual optimizer-step evidence')
    return {'checkpoint': str(checkpoint), 'stateSha256': metadata['state_sha256'],
            'modelTensorIdentity': state_identity(payload['model']),
            'globalStep': payload['global_step'], 'reloadExact': True,
            'changedParameters': changed, 'updatedOptimizerOwners': updated,
            'allParametersFinite': True, 'counters': payload['counters'],
            'sourceSampling': metadata['source_sampling']}


def verify_training_start(initial, phase_start):
    from megatoken.training.checkpoint import load_checkpoint

    base, base_metadata = load_checkpoint(initial)
    actual, actual_metadata = load_checkpoint(phase_start)
    if (hashes(base['model']) != hashes(actual['model']) or
            hashes(base['optimizer']['master_weights']) != hashes(actual['optimizer']['master_weights']) or
            actual['optimizer']['moments'] or actual['global_step'] != 0):
        raise ValueError('Trainer phase-start state differs from the declared initialized base')
    return {'exact': True, 'baseCheckpointSha256': base_metadata['state_sha256'],
            'phaseStartCheckpointSha256': actual_metadata['state_sha256'],
            'modelTensorIdentity': state_identity(actual['model']), 'optimizerSteps': 0}


def export_checked(checkpoint, destination):
    from megatoken.loading import load_trained
    from megatoken.served import ServedBundle, export_served

    manifest = export_served(checkpoint, destination)
    trained = load_trained(checkpoint, device='cpu')
    served = ServedBundle(destination, device='cpu')
    if hashes(trained.model.served_state_dict()) != hashes(served.model.served_state_dict()):
        raise ValueError('Served reload changed model parameter tensors')
    return {**manifest, 'servedReloadExact': True}


def rollout(case, origin, bundle, consumer, root, args, env):
    destination = root / origin / f'{case["index"]:04d}'
    destination.mkdir(parents=True)
    write_json(destination / 'request.json', case['envelope'])
    write_json(destination / 'private-expected.json', case['expected'])
    model_args = [str(consumer / 'scripts/serve_selected_semantic.py'), '--served', bundle['bundle'],
                  '--device', 'cpu', '--effort', '1', '--max-tokens', str(args.rollout_tokens),
                  '--profile-output', str(destination / 'serving-profile.json'),
                  '--profile-origin', 'trained' if origin == 'trained' else 'fixed']
    command = ['node', str(Path(__file__).with_name('run-selected-evaluation.mjs')),
               '--origin', origin, '--model-command', sys.executable,
               '--model-args', json.dumps(model_args), '--model-cwd', str(consumer),
               '--checkpoint-identity', bundle['model_sha256'],
               '--timeout-ms', str(args.rollout_timeout * 1000), '--cleanup-timeout-ms', '10000']
    started = time.monotonic()
    with (destination / 'result.json').open('w') as output, (destination / 'stderr.log').open('w') as errors:
        process = subprocess.run(command, input=json.dumps(case['envelope']), text=True,
                                 stdout=output, stderr=errors, env=env,
                                 timeout=args.rollout_timeout + 45)
    if process.returncode:
        return {'id': case['id'], 'origin': origin, 'wholeTaskSuccess': False,
                'pipelineFailure': 'evaluator-process-exit', 'returnCode': process.returncode,
                'artifacts': str(destination), 'wallSeconds': time.monotonic() - started}
    actual = json.loads((destination / 'result.json').read_text())
    gates = actual['hardGates']
    success = actual['failure'] is None and actual['outcome'] == case['expected'] and not any(gates.values())
    profile = json.loads((destination / 'serving-profile.json').read_text())
    return {'id': case['id'], 'origin': origin, 'wholeTaskSuccess': success,
            'checkpointIdentity': actual['checkpointIdentity'], 'failure': actual['failure'],
            'hardGates': gates, 'costs': actual['costs'],
            'cleanup': actual['outcome']['cleanup'], 'servingProfile': profile,
            'artifacts': str(destination), 'wallSeconds': time.monotonic() - started}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--corpus', type=Path, action='append', required=True,
                        help='Materialized admitted corpus; repeat to combine independently verified campaigns')
    parser.add_argument('--tracer-root', type=Path, required=True)
    parser.add_argument('--consumer-root', type=Path, required=True)
    parser.add_argument('--tokenizer-json', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--examples', type=int, default=32)
    parser.add_argument('--steps', type=int, default=16)
    parser.add_argument('--rollout-cases', type=int, default=4)
    parser.add_argument('--rollout-tokens', type=int, default=128)
    parser.add_argument('--rollout-timeout', type=int, default=120)
    parser.add_argument('--train-timeout', type=int, default=900)
    parser.add_argument('--seed', type=int, choices=[17, 29, 43], default=17)
    args = parser.parse_args()
    if min(args.examples, args.steps, args.rollout_cases, args.rollout_tokens, args.train_timeout) < 1:
        parser.error('All caps must be positive')
    if not 1 <= args.rollout_timeout <= 300 or args.rollout_tokens > 1024:
        parser.error('Rollout timeout must be <=300 seconds and token cap <=1024')
    root = args.output.resolve()
    root.mkdir(parents=True, exist_ok=False)
    report = {'schema': 'optimization-smoke/1', 'status': 'running',
              'evidenceKind': 'newly-initialized-cpu-optimization-diagnostic',
              'stage': 'P1', 'purpose': 'diagnostic', 'split': 'train',
              'generalizationClaim': False, 'injectedSelections': False,
              'candidateSelection': 'round-robin families; smallest generated-token count then public bytes within each family',
              'requestedSteps': args.steps, 'seed': args.seed, 'optimizerSteps': 0}

    def record(**updates):
        report.update(updates)
        write_json(root / 'report.json', report)

    record(phase='initializing')
    try:
        corpora, tracer, consumer = [path.resolve() for path in args.corpus], args.tracer_root.resolve(), args.consumer_root.resolve()
        require_clean_checkout(tracer)
        require_clean_checkout(consumer)
        producer_revision, consumer_revision = git_head(tracer), git_head(consumer)
        manifest, selected = choose_candidates(corpora, args.examples)
        if manifest['producerRevision'] != producer_revision:
            raise ValueError('Corpus must match immutable source-verifier checkout')
        sys.path.insert(0, str(consumer / 'src'))
        from megatoken.data.semantic_corpus import prepare_semantic_corpus, source_verifier_for_checkout
        from megatoken.generation.codec import ByteCodec, LING_TOKENIZER_SHA256
        env = {**os.environ, 'PYTHONPATH': str(consumer / 'src'),
               'OMP_NUM_THREADS': '1', 'MKL_NUM_THREADS': '1'}
        codec = ByteCodec.from_tokenizer_json(args.tokenizer_json.resolve(), expected_sha256=LING_TOKENIZER_SHA256)
        paths = [str(path) for _, path in selected]
        write_json(root / 'inputs.json', paths)
        record(phase='preparing', producerRevision=producer_revision, consumerRevision=consumer_revision,
               runnerRevision=git_head(Path(__file__).resolve().parent.parent),
               runnerSha256=sha256(__file__),
               caseBuilderSha256=sha256(Path(__file__).with_name('build-optimization-cases.mjs')),
               sourceCorpora=manifest['sources'],
               tokenizerIdentity=codec.fingerprint, tokenizerSha256=sha256(args.tokenizer_json),
               examples=len(selected), families=sorted({item['family'] for item, _ in selected}),
               inputIdentities=[{'path': str(path), 'sha256': sha256(path)} for _, path in selected])
        prepared = root / 'prepared'
        registries, loading_counts = {}, Counter()
        prepared_manifest, preparation = prepare_semantic_corpus(
            (intern_registries(json.loads(path.read_text()), registries, loading_counts)
             for _, path in selected), prepared, codec=codec,
            producer_revision=producer_revision, consumer_revision=consumer_revision,
            source_verifier=source_verifier_for_checkout(tracer, producer_revision),
            max_positions=1024, max_history=1024)
        for encoded, registry in registries.items():
            if json.dumps(registry, ensure_ascii=False, separators=(',', ':'), allow_nan=False) != encoded:
                raise ValueError('Preparation mutated an immutable shared registry')
        loading_counts['distinctRegistries'] = len(registries)
        loading_counts['processPeakRssBytesBeforeModelRuntime'] = int(
            resource.getrusage(resource.RUSAGE_SELF).ru_maxrss * (1 if sys.platform == 'darwin' else 1024))
        registries.clear()
        gc.collect()
        if preparation['accepted'] != len(selected):
            raise ValueError('Smoke preparation refused/deduplicated candidates; inspect semantic-report.json')
        masks = mask_receipt(prepared, codec)
        write_json(root / 'loss-masks.json', masks)
        record(phase='initializing-checkpoint', preparedFingerprint=prepared_manifest['fingerprint'],
               preparation=preparation, lossMaskCounts=masks['counts'],
               dataLoading={'losslessRegistryInterning': True, **dict(loading_counts)})
        # Preparation and source verification do not need the model runtime.
        # Avoid retaining its memory alongside repeated private audit sidecars.
        import torch
        from megatoken.training.config import TrainConfig
        torch.set_num_threads(1)
        config = TrainConfig(purpose='diagnostic', phase='P1', model='tiny',
                             codec=str(args.tokenizer_json.resolve()), datasets=[str(prepared)],
                             output=str(root / 'training'), device='cpu', precision='fp32', seed=args.seed,
                             max_steps=args.steps, microbatch_episodes=1, max_accumulation_windows=1,
                             accumulate_scored=1, accumulate_ingested=16384, max_history_tokens=16384,
                             max_window_records=1, max_record_bytes=16384, generated_capacity=1024,
                             model_overrides={'vocab_size': codec.vocab_size, 'max_capacity': 1024,
                                              'max_history_chunks': 1024},
                             effort=1, gradient_checkpointing=False, checkpoint_every=1, eval_every=0,
                             deterministic=True, use_stage_mixture=False, use_effort_mixture=False)
        config_path = root / 'train-config.json'
        write_json(config_path, asdict(config))
        initial, initial_parameters = create_initial_checkpoint(root, config, codec, masks['chunking'])
        write_json(root / 'initial-parameter-identities.json', initial_parameters)
        gc.collect()
        base_bundle = export_checked(initial, root / 'served-base')
        record(phase='training', initialCheckpoint=str(initial), baseBundle=base_bundle)
        gc.collect()
        run_logged([sys.executable, '-m', 'megatoken', 'train', '--config', str(config_path),
                    '--resume', str(initial), '--phase-transition'], root / 'training.log',
                   env=env, timeout=args.train_timeout)
        start_check = verify_training_start(initial, root / 'training/checkpoints/P1-000000000-phase-start')
        pointer = json.loads((root / 'training/checkpoints/latest.json').read_text())
        checkpoint = root / 'training/checkpoints' / pointer['checkpoint']
        checkpoint_check = checkpoint_receipt(checkpoint, initial_parameters)
        if checkpoint_check['globalStep'] != args.steps:
            raise ValueError('Actual optimizer step count differs from the requested cap')
        metrics = [json.loads(line) for line in (root / 'training/metrics.jsonl').read_text().splitlines()]
        training = [row for row in metrics if row['event'] == 'train']
        write_json(root / 'optimizer-verification.json', checkpoint_check)
        if len(training) != args.steps or not all(row['gradient_norm'] > 0 for row in training):
            raise ValueError('Optimizer updates lack measured nonzero gradients')
        gradient_domains = ['encoder', 'model', 'shared']
        if not all(any(row.get('gradient_norm_' + domain, 0) > 0 for row in training)
                   for domain in gradient_domains):
            raise ValueError('Intended encoder/model/shared owners lack nonzero gradient evidence')
        trained_bundle = export_checked(checkpoint, root / 'served-trained')
        if base_bundle['model_sha256'] == trained_bundle['model_sha256']:
            raise ValueError('Training did not change the actual served model')
        record(phase='evaluating', optimizerSteps=args.steps, trainedBundle=trained_bundle,
               initialTrainingState=start_check,
               checkpointVerification={key: value for key, value in checkpoint_check.items()
                                       if key not in {'changedParameters', 'updatedOptimizerOwners'}},
               changedParameterCount=len(checkpoint_check['changedParameters']),
               updatedOptimizerOwnerCount=len(checkpoint_check['updatedOptimizerOwners']),
               supervisedLexicalTokens=sum(row['denominators']['lexical'] for row in training),
               trainingSummary=[{'step': row['global_step'], 'gradientNorm': row['gradient_norm'],
                                 'gradientDomains': {domain: row['gradient_norm_' + domain]
                                                     for domain in gradient_domains},
                                 'loss': row['loss'], 'denominators': row['denominators'],
                                 'counters': row['step_counters']} for row in training])
        gc.collect()
        run_logged(['node', str(Path(__file__).with_name('build-optimization-cases.mjs')),
                    str(root / 'inputs.json'), str(root / 'private-cases.json'), str(args.seed)],
                   root / 'build-cases.log', env=env, timeout=60)
        cases = json.loads((root / 'private-cases.json').read_text())['cases'][:args.rollout_cases]
        rollouts = []
        for index, case in enumerate(cases):
            case['index'] = index
            for origin, bundle in [('fixed-weights', base_bundle), ('trained', trained_bundle)]:
                rollouts.append(rollout(case, origin, bundle, consumer, root / 'rollouts', args, env))
                record(rollouts=rollouts)
        trained = [row for row in rollouts if row['origin'] == 'trained']
        requirements = {'optimizerUpdated': True, 'initialBaseLoadedExact': True,
                        'observedMasked': True, 'generatedSupervised': True,
                        'checkpointReloadExact': True, 'servedReloadExact': True,
                        'completeHeldInExecutions': all(row['wholeTaskSuccess'] for row in trained),
                        'approximately32Examples': len(selected) >= 32}
        record(status='completed', phase='complete', requirements=requirements,
               optimizationSmokePassed=all(requirements.values()),
               remaining=[] if all(requirements.values()) else [
                   key for key, passed in requirements.items() if not passed])
        print(json.dumps({'report': str(root / 'report.json'), 'requirements': requirements,
                          'optimizerSteps': args.steps}))
        return 0
    except BaseException as error:
        record(status='failed', error={'type': type(error).__name__, 'message': str(error)},
               traceback=traceback.format_exc())
        print(f'Optimization smoke stopped; durable report: {root / "report.json"}', file=sys.stderr)
        raise


if __name__ == '__main__':
    raise SystemExit(main())
