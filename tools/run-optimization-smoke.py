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
import math
import os
import resource
import shutil
import signal
import subprocess
import sys
import time
import traceback
import uuid
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


def run_logged(command, path, *, env, timeout, input_text=None, graceful_checkpoint=False):
    """Honor the wall cap, reserving native SIGTERM checkpoint time inside it."""
    grace = min(30, max(1, timeout // 10)) if graceful_checkpoint else 0
    requested_stop = False
    started = time.monotonic()
    with Path(path).open('w') as log:
        process = subprocess.Popen(command, stdin=subprocess.PIPE if input_text is not None else subprocess.DEVNULL,
            text=True, stdout=log, stderr=subprocess.STDOUT, env=env, start_new_session=True)
        try:
            process.communicate(input=input_text, timeout=max(0.01, timeout - grace))
        except subprocess.TimeoutExpired:
            if graceful_checkpoint:
                requested_stop = True
                # The pinned native engine handles SIGTERM by finishing its
                # current atomic update and saving a paused checkpoint. Let its
                # worker processes finish too; kill the group only at the cap.
                process.terminate()
                try:
                    process.communicate(timeout=max(0.01, timeout - (time.monotonic() - started)))
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait()
                    raise
            else:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait()
                raise
    if process.returncode:
        raise RuntimeError(f'Command exited {process.returncode}; retained log: {path}')
    return {'wallSeconds': time.monotonic() - started, 'wallCapSeconds': timeout,
            'reservedCheckpointSeconds': grace, 'gracefulCheckpointStopRequested': requested_stop}


def choose_candidates(corpora, maximum, experiment=None):
    corpora = [Path(corpora).resolve()] if isinstance(corpora, (str, Path)) else [Path(p).resolve() for p in corpora]
    if experiment is not None:
        from learning_evaluation import require_frozen_experiment
        require_frozen_experiment(experiment)
        sources, revisions = [], set()
        for corpus in corpora:
            manifest_path = corpus / 'manifest.json'
            header = json.loads(manifest_path.read_text())
            revisions.add(header['producerRevision'])
            sources.append({'path': str(corpus), 'manifestSha256': sha256(manifest_path),
                            'producerRevision': header['producerRevision'], 'counts': header['counts']})
        if len(revisions) != 1:
            raise ValueError('All smoke corpora must use the same immutable producer revision')
        selected = []
        if maximum != len(experiment['training']):
            raise ValueError('Example cap must equal the frozen training membership')
        for frozen in experiment['training']:
            path = Path(frozen['path']).resolve()
            if not any(path.is_relative_to(corpus) for corpus in corpora):
                raise ValueError('Frozen training path escapes the declared corpora')
            if sha256(path) != frozen['fileSha256']:
                raise ValueError('Frozen training input bytes changed')
            exported = json.loads(path.read_text())
            side = exported['sidecar']
            if (side['admission'] != 'admitted' or side['split'] != 'train' or
                    side['identityDigest'] != frozen['identityDigest'] or
                    side['sourceFamily'] != frozen['family'] or
                    side['splitIdentity']['componentId'] != frozen['sourceCluster']):
                raise ValueError('Frozen training identity, family or split changed')
            selected.append(({'id': frozen['id'], 'family': frozen['family'],
                              'identityDigest': frozen['identityDigest']}, path))
        return {'producerRevision': revisions.pop(), 'sources': sources}, selected
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


def create_initial_checkpoint(root, config, codec, chunking, *, initialization_seed=None):
    from megatoken.loading import build_model, load_model_config
    from megatoken.runtime import seed_everything
    from megatoken.training.checkpoint import save_checkpoint, transducer_attachment
    from megatoken.training.optimizer import MasterAdamW
    from megatoken.training.transducer import TransducerTrainer

    seed_everything(config.seed if initialization_seed is None else initialization_seed, config.deterministic)
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


def checkpoint_receipt(checkpoint, initial_parameters, *, stream_fingerprint=None):
    import torch
    from megatoken.loading import load_trained
    from megatoken.training.checkpoint import load_checkpoint
    from megatoken.training.stream import source_sampling_report

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
            'nativeCursors': [rank['cursor'] for rank in payload['rank_state']],
            'sourceSampling': authenticated_source_sampling(payload, metadata, source_sampling_report,
                stream_fingerprint=stream_fingerprint)}


def authenticated_source_sampling(payload, metadata, native_source_report, *, stream_fingerprint=None):
    """Metadata counters cannot override the checksummed optimizer cursor state."""
    ranks = payload.get('rank_state')
    if not isinstance(ranks, list) or not ranks or any(
            not isinstance(rank, dict) or not isinstance(rank.get('cursor'), dict) for rank in ranks):
        raise ValueError('Checkpoint lacks authenticated native source cursors')
    cursors = [rank['cursor'] for rank in ranks]
    if stream_fingerprint is not None and any(
            cursor.get('dataset_fingerprint') != stream_fingerprint for cursor in cursors):
        raise ValueError('Authenticated native cursor differs from the verified prepared window plan')
    actual = native_source_report(cursors)
    if metadata.get('source_sampling') != actual:
        raise ValueError('Checkpoint source sampling metadata differs from authenticated payload cursors')
    return actual


def native_window_plan(prepared, codec, config):
    """Inspect the actual pinned native packing and sampler before any update."""
    from megatoken.data import PreparedCorpus
    from megatoken.training.engine import window_config
    from megatoken.training.stream import _WindowPlan, WindowStream

    dataset = PreparedCorpus([str(prepared)])
    try:
        window = window_config(config)
        sources = []
        for index in range(len(dataset)):
            episode, _ = dataset.fetch(index)
            plan = _WindowPlan(episode, codec, window)
            sources.append({'sourceId': episode.lineage.source_id, 'episodeId': episode.episode_id,
                            'windows': len(plan), 'scoredTokens': sum(plan[k].P for k in range(len(plan))),
                            'transcriptTokens': sum(plan[k].D for k in range(len(plan)))})
        if len({row['sourceId'] for row in sources}) != len(sources) or any(not row['windows'] for row in sources):
            raise ValueError('Selected prepared episodes need distinct source IDs and scored native windows')
        stream = WindowStream(dataset, codec, window, seed=config.seed)
        order, counts = [], Counter()
        for _ in range(sum(row['windows'] for row in sources)):
            item = stream.next()
            if item is None:
                raise ValueError('Single-worker scored native window plan unexpectedly contains padding')
            source = item.episode.lineage.source_id
            if source not in counts:
                order.append(source)
            counts[source] += 1
        if dict(counts) != {row['sourceId']: row['windows'] for row in sources}:
            raise ValueError('Native first-epoch sampler differs from the inspected packing plan')
        return {'schema': 'native-training-window-plan/1', 'sampler': 'native-sequential-permuted-episodes',
                'seed': config.seed, 'windowConfig': asdict(window), 'preparedIdentity': dataset.identity,
                'streamFingerprint': stream.fingerprint,
                'sources': sources, 'firstEpochSourceOrder': order,
                'firstEpochWindows': sum(counts.values()),
                'eachEpisodeIsOneWindow': all(row['windows'] == 1 for row in sources)}
    finally:
        dataset.close()


def verify_native_window_plan(plan, prepared, codec, config):
    """Rebuild from checksummed prepared shards, including legacy plan receipts."""
    actual = native_window_plan(prepared, codec, config)
    comparable = dict(actual)
    if 'streamFingerprint' not in plan:
        comparable.pop('streamFingerprint')
    if comparable != plan:
        raise ValueError('Frozen native window inventory differs from the actual prepared corpus and configuration')
    return actual


def training_exposure(plan, sampling):
    expected = {row['sourceId']: row['windows'] for row in plan['sources']}
    if len(expected) != len(plan['sources']) or any(type(count) is not int or count < 1 for count in expected.values()):
        raise ValueError('Native window plan has duplicate sources or invalid window counts')
    actual = sampling.get('source_windows', {})
    if (set(actual) - set(expected) or any(type(count) is not int or count < 1 for count in actual.values())):
        raise ValueError('Checkpoint source exposure contains a foreign source or invalid window count')
    complete = sampling.get('complete_history') is True
    missing = sorted(set(expected) - set(actual))
    unfinished = sorted(key for key, count in expected.items() if actual.get(key, 0) < count)
    return {'selectedSources': len(expected), 'exposedSources': len(actual), 'completeHistory': complete,
            'sampledWindows': sum(actual.values()), 'expectedFirstEpochWindows': sum(expected.values()),
            'unexposedSourceIds': missing, 'incompleteEpisodeSourceIds': unfinished,
            'everySelectedSourceExposed': complete and not missing,
            'everySelectedEpisodeVisitedAllWindows': complete and not unfinished,
            'sourceWindowCounts': dict(sorted(actual.items()))}


def partial_training_receipt(root):
    """Retain observed updates after timeout/SIGKILL without inventing a checkpoint."""
    root = Path(root)
    metrics = root / 'training/metrics.jsonl'
    if not metrics.exists():
        return None
    rows, malformed = [], 0
    for line in metrics.read_text().splitlines():
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            malformed += 1
            continue
        if row.get('event') == 'train':
            rows.append(row)
    pointer = root / 'training/checkpoints/latest.json'
    checkpoint, checkpoint_error = None, None
    if pointer.exists():
        try:
            reference = json.loads(pointer.read_text())
            if not isinstance(reference, dict):
                raise ValueError('Invalid native checkpoint pointer object')
            name = reference['checkpoint']
            if not isinstance(name, str) or not name or name in ('.', '..') or Path(name).name != name:
                raise ValueError('Invalid native checkpoint pointer name')
            directory = (pointer.parent / name).resolve()
            if directory.parent != pointer.parent.resolve():
                raise ValueError('Native checkpoint pointer escapes its root')
            metadata = directory / 'metadata.json'
            metadata_sha = sha256(metadata)
            if metadata_sha != reference['metadata_sha256']:
                raise ValueError('Native checkpoint metadata checksum differs from the committed pointer')
            value = json.loads(metadata.read_text())
            if not isinstance(value, dict):
                raise ValueError('Invalid native checkpoint metadata object')
            if (value.get('checkpoint_name') != name or (directory / 'state.pt').resolve().parent != directory or
                    sha256(directory / 'state.pt') != value['state_sha256']):
                raise ValueError('Native checkpoint state is missing, changed or bound to another name')
            transducer = value['transducer_checkpoint']
            if not isinstance(transducer, dict):
                raise ValueError('Invalid native checkpoint transducer receipt')
            filename = transducer['file']
            if (not isinstance(filename, str) or not filename or filename in ('.', '..') or
                    Path(filename).name != filename or (directory / filename).resolve().parent != directory or
                    sha256(directory / filename) != transducer['sha256']):
                raise ValueError('Native checkpoint transducer is missing or changed')
            checkpoint = {'path': str(directory), 'metadataSha256': metadata_sha, 'metadata': value,
                          'checkpointFilesVerified': True, 'nativePayloadLoadVerified': False}
        except (OSError, ValueError, KeyError, TypeError) as error:
            checkpoint_error = {'type': type(error).__name__, 'message': str(error)}
    return {'schema': 'partial-native-optimization/1', 'metricsSha256': sha256(metrics),
            'observedOptimizerSteps': max((row['global_step'] for row in rows), default=0),
            'supervisedLexicalTokens': sum(row['denominators']['lexical'] for row in rows),
            'malformedMetricLines': malformed, 'lastDurableCheckpoint': checkpoint,
            'checkpointVerificationFailure': checkpoint_error,
            'updatesAreNotDurableCheckpointEvidence': True}


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


def source_exposure_receipt(prepared, sampling):
    """Report actual non-padding native windows, not prepared corpus membership."""
    from megatoken.data.storage import PreparedCorpus

    if sampling.get('complete_history') is not True:
        raise ValueError('Actual sampled-source history is incomplete')
    counts = sampling.get('source_windows', {})
    if not counts or any(type(value) is not int or value <= 0 for value in counts.values()):
        raise ValueError('Actual sampled-source windows must be positive integers')
    inventory = {}
    with PreparedCorpus([str(prepared)], split='train') as corpus:
        for episode in corpus.iter_episodes():
            lineage = episode.lineage
            if lineage.source_id in inventory:
                raise ValueError('Prepared source IDs are not unique')
            inventory[lineage.source_id] = {'sourceId': lineage.source_id,
                                            'episodeId': episode.episode_id,
                                            'family': lineage.family_id,
                                            'taskId': lineage.task_id}
    if not set(counts).issubset(inventory):
        raise ValueError('Checkpoint exposure names a source outside the prepared corpus')
    rows = [{**inventory[source], 'windows': count} for source, count in sorted(counts.items())]
    return {'completeHistory': True, 'examplesSampled': len(rows),
            'familiesSampled': len({row['family'] for row in rows}),
            'windowsSampled': sum(counts.values()), 'sources': rows}


def bind_initial_checkpoint(source, root, codec):
    """Copy and load the same immutable zero-update base; do not reseed a substitute."""
    from megatoken.loading import load_trained
    from megatoken.training.checkpoint import load_checkpoint

    payload, _ = load_checkpoint(source)
    if (payload['global_step'] != 0 or payload['optimizer']['moments'] or
            payload['codec_fingerprint'] != codec.fingerprint):
        raise ValueError('Shared diagnostic base must have zero updates and the exact tokenizer')
    del payload
    destination = root / 'initialization/initialized-untrained'
    shutil.copytree(source, destination)
    trained = load_trained(destination, device='cpu')
    if trained.codec.fingerprint != codec.fingerprint:
        raise ValueError('Copied initial checkpoint tokenizer differs')
    return destination, hashes(dict(trained.model.named_parameters()))


def native_optimization_schedule(config, codec):
    """Freeze the real resolved native sampler's windows before optimizer launch."""
    from megatoken.data.storage import PreparedCorpus
    from megatoken.training.engine import window_config
    from megatoken.training.stream import WindowStream

    rows, first_epoch_windows, final_cursor = [], None, None
    with PreparedCorpus(config.datasets) as corpus:
        stream = WindowStream(corpus, codec, window_config(config), seed=config.seed)
        while len(rows) < config.max_steps or first_epoch_windows is None:
            item = stream.next()
            if item is not None:
                if item.episode.lineage.frozen_split != 'train':
                    raise ValueError('Native diagnostic sampler selected a non-training example')
                window = item.window
                rows.append({'sourceId': item.episode.lineage.source_id,
                             'family': item.episode.lineage.family_id,
                             'episodeId': item.episode.episode_id,
                             'windowIndex': window.index, 'start': window.start, 'end': window.end,
                             'recordIds': [row.record.record_id for row in window.records],
                             'scoredTokens': sum(sum(row.free_mask) for row in window.records)})
            if len(rows) == config.max_steps and final_cursor is None:
                final_cursor = stream.state_dict()
            if stream.epoch > 0 and first_epoch_windows is None:
                first_epoch_windows = len(rows)
    selected = rows[:config.max_steps]
    return {'schema': 'optimization-native-window-plan/1',
            'resolvedWindowConfig': asdict(window_config(config)),
            'seed': config.seed, 'requestedWindows': config.max_steps,
            'windowsPerFirstEpoch': first_epoch_windows,
            'expectedExamples': len({row['sourceId'] for row in selected}),
            'expectedFamilies': len({row['family'] for row in selected}),
            'expectedScoredTokens': sum(row['scoredTokens'] for row in selected),
            'expectedSourceWindows': dict(Counter(row['sourceId'] for row in selected)),
            'expectedFinalCursor': final_cursor, 'windows': selected}


def export_checked(checkpoint, destination):
    from megatoken.loading import load_trained
    from megatoken.served import ServedBundle, export_served

    manifest = export_served(checkpoint, destination)
    trained = load_trained(checkpoint, device='cpu')
    served = ServedBundle(destination, device='cpu')
    if hashes(trained.model.served_state_dict()) != hashes(served.model.served_state_dict()):
        raise ValueError('Served reload changed model parameter tensors')
    return {**manifest, 'servedReloadExact': True}


HARD_GATE_NAMES = frozenset({'futureObservationLeaks', 'unauthorizedEffects',
                             'untrackedNativeFallback', 'falseAdmissions', 'replayNativeEffects'})
CLEANUP_NAMES = frozenset({'pendingEffects', 'pendingJobs', 'openHandlers'})


def require_counters(value, names, label):
    if (not isinstance(value, dict) or set(value) != names or
            any(type(count) is not int or count < 0 for count in value.values())):
        raise ValueError(f'{label} must contain exactly the declared nonnegative integer counters')
    return value


def score_rollout(actual, case, origin, bundle, profile):
    """Score complete, identity-bound evidence; absent gates never mean success."""
    if not isinstance(actual, dict) or not isinstance(profile, dict):
        raise ValueError('Diagnostic result and serving profile must be complete objects')
    envelope = case['envelope']
    if (origin not in {'trained', 'fixed-weights'} or envelope.get('caseId') != case['id'] or
            envelope.get('schema') != 'semantic-evaluation-request/4' or
            type(envelope.get('seed')) is not int):
        raise ValueError('Malformed diagnostic case identity')
    identity = {'schema': 'semantic-inference-identity/4', 'seed': envelope['seed'],
                'checkpointIdentity': bundle['model_sha256'],
                'tokenizerIdentity': bundle['codec_fingerprint']}
    episode = actual.get('episode')
    sidecar = episode.get('sidecar') if isinstance(episode, dict) else None
    if not isinstance(sidecar, dict):
        raise ValueError('Diagnostic result lacks its case identity sidecar')
    if (actual.get('schema') != 'semantic-evaluation-result/4' or
            actual.get('origin') != origin or actual.get('representation') != envelope['representation'] or
            actual.get('checkpointIdentity') != bundle['model_sha256'] or
            actual.get('inferenceIdentity') != identity or
            sidecar.get('sourceLineage') != 'evaluation:' + case['id'] or
            sidecar.get('selectionOrigin') != 'actual-model-selected' or
            sidecar.get('evidenceKind') != ('model-evaluation' if origin == 'trained' else 'deterministic-engineering')):
        raise ValueError('Diagnostic result case, origin, model, tokenizer, or seed identity differs')
    gates = require_counters(actual.get('hardGates'), HARD_GATE_NAMES, 'Hard gates')
    outcome = actual.get('outcome')
    if not isinstance(outcome, dict) or set(outcome) != {'completion', 'state', 'effects', 'callbacks', 'cleanup'}:
        raise ValueError('Diagnostic outcome evidence is incomplete')
    cleanup = require_counters(outcome['cleanup'], CLEANUP_NAMES, 'Cleanup')
    if 'failure' not in actual or (actual['failure'] is not None and
            (not isinstance(actual['failure'], dict) or not isinstance(actual['failure'].get('category'), str))):
        raise ValueError('Diagnostic failure evidence is incomplete')
    if (profile.get('schema') != 'semantic-serving-profile/1' or profile.get('complete') is not True or
            profile.get('runtimeClosed') is not True or type(profile.get('optimizerSteps')) is not int or
            profile['optimizerSteps'] != 0 or profile.get('initialization') != identity or
            profile.get('declaredOrigin') != ('trained' if origin == 'trained' else 'fixed') or
            not isinstance(profile.get('identity'), dict) or
            profile.get('identity', {}).get('modelSha256') != bundle['model_sha256'] or
            profile.get('identity', {}).get('tokenizerIdentity') != bundle['codec_fingerprint']):
        raise ValueError('Diagnostic serving profile is incomplete or has a different identity')
    # Canonical JSON avoids Python's bool/int equality accepting malformed values.
    exact_outcome = json.dumps(outcome, sort_keys=True, separators=(',', ':')) == json.dumps(
        case['expected'], sort_keys=True, separators=(',', ':'))
    return actual['failure'] is None and exact_outcome and not any(gates.values()) and not any(cleanup.values())


def generated_token_cost(profile, actual=None, codec=None):
    """Count actual successful/failed decoder tokens once per native event.

    The same failure evidence may be repeated in several receipts. Event IDs
    identify the original decoder emission, not a retry or a rendered byte count.
    Incomplete profiles remain lower bounds instead of invented exact costs.
    """
    events = {}

    def visit(value):
        if isinstance(value, dict):
            event = value.get('selectedEventId')
            tokens = value.get('emittedTokenIds')
            if isinstance(event, str) and isinstance(tokens, list):
                if any(not isinstance(token, int) or isinstance(token, bool) or token < 0 for token in tokens):
                    raise ValueError('Invalid native emitted-token evidence')
                payload = value.get('payloadHex')
                if codec is not None:
                    if not isinstance(payload, str) or codec.decode(tokens) != bytes.fromhex(payload):
                        raise ValueError('Native emitted token IDs do not reconstruct original bytes')
                signature = (tokens, payload)
                if event in events and events[event] != signature:
                    raise ValueError('Conflicting native emitted-token evidence for one event')
                events[event] = signature
            for child in value.values():
                visit(child)
        elif isinstance(value, list):
            for child in value:
                visit(child)

    visit(profile)
    # Successful selection fragments live in evaluator evidence, while profiles
    # retain failed emissions. Do not mistake a successful profile for zero cost.
    if actual is not None:
        for row in [*actual.get('selections', []), *actual.get('rejections', [])]:
            selection = row.get('selection')
            if selection is not None:
                if selection.get('modelSelected') is not True or codec is not None and selection.get('codecFingerprint') != codec.fingerprint:
                    raise ValueError('Token evidence lacks attested actual model selection')
                fragments = selection.get('fragments')
                if not isinstance(fragments, list) or not fragments:
                    raise ValueError('Actual selection omitted native decoder fragments')
                if row.get('record') is not None and b''.join(bytes.fromhex(item['payloadHex']) for item in fragments) != row['record'].encode():
                    raise ValueError('Native fragments do not reconstruct selected record')
                visit(fragments)
        visit((actual.get('failure') or {}).get('evidence'))
    successful_calls = sum(row.get('operation') == 'select' and row.get('ok') is True and
                           row.get('selectionAuthority') is not None for row in profile.get('records', []))
    recorded_selections = len(actual.get('selections', [])) if actual is not None else 0
    failed_calls = [row for row in profile.get('records', []) if row.get('operation') == 'select' and row.get('ok') is False]
    # complete=True in the serving profile only means RPC rows were retained.
    # A runtime/OOM exception may interrupt decoding before original token IDs
    # become a reply. Only the pinned adapter's explicit SemanticSelectionError
    # with complete original fragments closes that failed decoder stream.
    failed_emissions_complete = all(
        (row.get('failure') or {}).get('category') == 'SemanticSelectionError' and
        isinstance(((row.get('failure') or {}).get('evidence') or {}).get('fragments'), list) and
        bool(row['failure']['evidence']['fragments']) and
        all(isinstance(fragment.get('emittedTokenIds'), list) for fragment in row['failure']['evidence']['fragments'])
        for row in failed_calls)
    complete = (profile.get('complete') is True and profile.get('droppedRecords') == 0 and
                recorded_selections >= successful_calls and failed_emissions_complete)
    return {'generatedTokens': sum(len(tokens) for tokens, _ in events.values()),
            'decoderEvents': len(events), 'complete': complete,
            'scope': 'original-native-emitted-token-ids' if complete else 'retained-native-token-lower-bound'}


def rollout(case, origin, bundle, consumer, root, args, env):
    destination = root / origin / f'{case["index"]:04d}'
    destination.mkdir(parents=True)
    write_json(destination / 'request.json', case['envelope'])
    write_json(destination / 'private-expected.json', case['expected'])
    model_args = [str(consumer / 'scripts/serve_selected_semantic.py'), '--served', bundle['bundle'],
                  '--device', 'cpu', '--effort', '1', '--max-tokens', str(args.rollout_tokens),
                  '--profile-output', str(destination / 'serving-profile.json'),
                  '--profile-origin', 'trained' if origin == 'trained' else 'fixed']
    capture_process = getattr(args, 'native_process_receipts', False)
    launch_id = uuid.uuid4().hex if capture_process else None
    if capture_process:
        model_args = [str(Path(__file__).with_name('launch-native-diagnostic.py')),
                      '--receipt', str(destination / 'native-process.json'),
                      '--launch-id', launch_id, *model_args]
    evaluator = getattr(args, 'evaluator_script', Path(__file__).with_name('run-selected-evaluation.mjs'))
    command = ['node', str(evaluator),
               '--origin', origin, '--model-command', sys.executable,
               '--model-args', json.dumps(model_args), '--model-cwd', str(consumer),
               '--checkpoint-identity', bundle['model_sha256'],
               '--timeout-ms', str(args.rollout_timeout * 1000), '--cleanup-timeout-ms', '10000']
    started = time.monotonic()
    summary = {'id': case['id'], 'family': case['family'], 'origin': origin,
               'wholeTaskSuccess': False, 'traceValid': False,
               'checkpointIdentity': bundle['model_sha256'],
               'artifacts': str(destination), 'generatedTokenCost': None}
    if capture_process:
        summary['nativeLaunchId'] = launch_id
    # A process group includes the evaluator's model child. A killed evaluator
    # must not leave a decoder running after the declared case budget.
    with (destination / 'result.json').open('w') as output, (destination / 'stderr.log').open('w') as errors:
        process = subprocess.Popen(command, stdin=subprocess.PIPE, text=True, stdout=output,
                                   stderr=errors, env=env, start_new_session=True)
        if capture_process:
            summary['evaluatorProcess'] = {'pid': process.pid, 'startedWallNs': time.time_ns()}
        try:
            process.communicate(json.dumps(case['envelope']), timeout=args.rollout_timeout + 45)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(process.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                process.wait()
            summary.update(pipelineFailure='evaluator-timeout', returnCode=process.returncode)
        else:
            if process.returncode:
                summary.update(pipelineFailure='evaluator-process-exit', returnCode=process.returncode)
    summary['wallSeconds'] = time.monotonic() - started
    if capture_process:
        try:
            launch = json.loads((destination / 'native-process.json').read_text())
            if (launch.get('launchId') != launch_id or
                    launch.get('scriptSha256') != sha256(consumer / 'scripts/serve_selected_semantic.py')):
                raise ValueError('Native model process launcher identity differs')
            summary['nativeProcess'] = launch
        except (OSError, ValueError) as error:
            summary.update(pipelineFailure='missing-or-invalid-native-process-receipt', processError=str(error))
    profile = None
    profile_path = destination / 'serving-profile.json'
    if profile_path.exists():
        try:
            profile = json.loads(profile_path.read_text())
            summary['servingProfile'] = profile
            summary['generatedTokenCost'] = generated_token_cost(profile)
        except (ValueError, TypeError) as error:
            summary['pipelineFailure'] = 'invalid-native-profile'
            summary['profileError'] = str(error)
    if 'pipelineFailure' not in summary:
        try:
            actual = json.loads((destination / 'result.json').read_text())
            success = score_rollout(actual, case, origin, bundle, profile)
            gates = actual['hardGates']
            rejections = actual['rejections']
            if not isinstance(rejections, list):
                raise ValueError('Diagnostic rejection evidence must be a list')
            trace_valid = (actual['failure'] is None and not rejections and
                           actual.get('firstSemanticInconsistency') is None and not any(gates.values()))
            codec = None
            if bundle.get('codec_file'):
                from megatoken.generation.codec import ByteCodec
                codec = ByteCodec.from_tokenizer_json(Path(bundle['bundle']) / bundle['codec_file'],
                                                      expected_sha256=bundle['tokenizer_sha256'])
            summary['generatedTokenCost'] = generated_token_cost(profile, actual, codec)
            if capture_process:
                from convergence_ladder import first_record_receipt
                summary['firstRecord'] = first_record_receipt(actual, profile)
            summary.update(wholeTaskSuccess=trace_valid and success,
                           traceValid=trace_valid, failure=actual['failure'],
                           rejections=rejections, firstSemanticInconsistency=actual.get('firstSemanticInconsistency'),
                           hardGates=gates, costs=actual['costs'], cleanup=actual['outcome']['cleanup'])
        except (ValueError, TypeError, KeyError) as error:
            summary.update(pipelineFailure='invalid-evaluator-result', resultError=str(error))
    if capture_process:
        summary['artifactBindings'] = {name: sha256(destination / name) for name in
            ('request.json', 'private-expected.json', 'result.json', 'serving-profile.json', 'native-process.json')
            if (destination / name).exists()}
    write_json(destination / 'summary.json', summary)
    return summary


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--corpus', type=Path, action='append', required=True,
                        help='Materialized admitted corpus; repeat to combine independently verified campaigns')
    parser.add_argument('--tracer-root', type=Path, required=True)
    parser.add_argument('--consumer-root', type=Path, required=True)
    parser.add_argument('--tokenizer-json', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--examples', type=int, default=32)
    parser.add_argument('--experiment', type=Path, help='Private membership and rules frozen before optimization')
    parser.add_argument('--convergence-declaration', type=Path,
                        help='Bind a separately frozen L1/L2 convergence gate before any optimizer step')
    parser.add_argument('--initialization-seed', type=int, choices=[17, 29, 43], default=17)
    parser.add_argument('--steps', type=int, default=16)
    parser.add_argument('--base-checkpoint', type=Path,
                        help='Reuse this exact zero-update diagnostic base instead of initializing a new one')
    parser.add_argument('--require-full-epoch', action='store_true',
                        help='Refuse before launch unless the resolved plan visits every prepared target once')
    parser.add_argument('--rollout-cases', type=int, default=4)
    parser.add_argument('--rollout-tokens', type=int, default=128)
    parser.add_argument('--rollout-timeout', type=int, default=120)
    parser.add_argument('--train-timeout', type=int, default=900)
    parser.add_argument('--training-window-records', '--max-window-records', dest='training_window_records', type=int, default=1)
    parser.add_argument('--training-window-decisions', '--scored-decisions', dest='training_window_decisions', type=int, default=2)
    parser.add_argument('--seed', type=int, choices=[17, 29, 43], default=17)
    args = parser.parse_args()
    if min(args.examples, args.steps, args.rollout_cases, args.rollout_tokens, args.train_timeout) < 1:
        parser.error('All caps must be positive')
    if not 1 <= args.rollout_timeout <= 300 or args.rollout_tokens > 1024:
        parser.error('Rollout timeout must be <=300 seconds and token cap <=1024')
    if not all(1 <= value <= 1024 for value in (args.training_window_records, args.training_window_decisions)):
        parser.error('Training window record and decision caps must be 1..1024')
    root = args.output.resolve()
    root.mkdir(parents=True, exist_ok=False)
    report = {'schema': 'optimization-smoke/1', 'status': 'running',
              'evidenceKind': 'newly-initialized-cpu-optimization-diagnostic',
              'stage': 'P1', 'purpose': 'diagnostic', 'split': 'train',
              'generalizationClaim': False, 'injectedSelections': False,
              'candidateSelection': 'round-robin families; smallest generated-token count then public bytes within each family',
              'requestedSteps': args.steps, 'maxWindowRecords': args.training_window_records,
              'scoredDecisions': args.training_window_decisions,
              'fullEpochRequested': args.require_full_epoch,
              'seed': args.seed, 'optimizerSteps': 0}

    def record(**updates):
        report.update(updates)
        write_json(root / 'report.json', report)

    record(phase='initializing')
    try:
        corpora, tracer, consumer = [path.resolve() for path in args.corpus], args.tracer_root.resolve(), args.consumer_root.resolve()
        require_clean_checkout(tracer)
        require_clean_checkout(consumer)
        producer_revision, consumer_revision = git_head(tracer), git_head(consumer)
        experiment = json.loads(args.experiment.read_text()) if args.experiment else None
        if args.convergence_declaration:
            if experiment is None:
                raise ValueError('A convergence declaration requires its frozen learning experiment')
            from convergence_ladder import require_declaration
            declaration = require_declaration(json.loads(args.convergence_declaration.read_text()),
                                              experiment, sha256(args.experiment))
            if args.seed != declaration['optimizerSeed']:
                raise ValueError('Optimizer seed differs from the bounded convergence declaration')
            args.native_process_receipts = True
            record(convergenceDeclarationSha256=sha256(args.convergence_declaration),
                   convergenceDeclarationIdentity=declaration['declarationIdentity'])
        from learning_evaluation import selected_rollout_budget, frozen_training_budget
        budget = selected_rollout_budget(experiment or {})
        if experiment is not None:
            if (args.seed not in experiment['optimizerSeeds'] or args.steps != max(experiment['checkpointSteps']) or
                    args.initialization_seed != experiment['initializationSeed'] or
                    producer_revision != experiment['producerRevision']):
                raise ValueError('Actual training inputs differ from the frozen experiment')
            if experiment.get('rolloutBudget') is not None and (
                    args.rollout_tokens != budget['nativeMaxTokensPerFragment'] or
                    args.rollout_timeout != budget['secondsPerCase']):
                raise ValueError('Actual inference caps differ from the frozen budget')
            training_budget = frozen_training_budget(experiment)
            if training_budget is not None and (args.training_window_records != training_budget['maxWindowRecords'] or
                    args.training_window_decisions != training_budget['maxScoredDecisions'] or
                    args.train_timeout != training_budget['seconds']):
                raise ValueError('Actual native training windows or time cap differ from the frozen budget')
            if args.base_checkpoint and experiment.get('baseCheckpointSha256') != sha256(args.base_checkpoint / 'state.pt'):
                raise ValueError('Reused base bytes must be bound explicitly in the frozen experiment')
            record(experimentSha256=sha256(args.experiment), experimentPath=str(args.experiment.resolve()))
        record(rolloutBudget={**budget, 'nativeMaxTokensPerFragment': args.rollout_tokens,
                              'secondsPerCase': args.rollout_timeout})
        manifest, selected = choose_candidates(corpora, args.examples, experiment)
        record(initializationSeed=args.initialization_seed, optimizerSeed=args.seed,
               baseOrigin='newly-initialized', trainingCandidateIdentities=[item.get('identityDigest') for item, _ in selected])
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
        from learning_diagnostics import native_target_audit
        targets = native_target_audit(prepared, codec)
        write_json(root / 'target-audit.json', targets)
        record(targetAudit={'path': 'target-audit.json', 'sha256': sha256(root / 'target-audit.json'),
                            'episodeIds': [row['episodeId'] for row in targets['episodes']],
                            'tokenizerIdentity': codec.fingerprint,
                            'trainingServingParity': 'unmeasured',
                            'nonlexicalMasks': 'unmeasured', 'perHeadObjectiveGradients': 'unmeasured'})
        record(phase='initializing-checkpoint', preparedFingerprint=prepared_manifest['fingerprint'],
               preparation=preparation, lossMaskCounts=masks['counts'],
               dataLoading={'losslessRegistryInterning': True, **dict(loading_counts)})
        # Preparation and source verification do not need the model runtime.
        # Avoid retaining its memory alongside repeated private audit sidecars.
        import torch
        from megatoken.training.config import TrainConfig
        torch.set_num_threads(1)
        checkpoint_interval = math.gcd(*experiment['checkpointSteps']) if experiment else 1
        checkpoint_retention = args.steps // checkpoint_interval + 1 if experiment else 3
        if checkpoint_retention > 101:
            raise ValueError('Frozen checkpoint schedule would retain more than 100 periodic states')
        config = TrainConfig(purpose='diagnostic', phase='P1', model='tiny',
                             codec=str(args.tokenizer_json.resolve()), datasets=[str(prepared)],
                             output=str(root / 'training'), device='cpu', precision='fp32', seed=args.seed,
                             max_steps=args.steps, microbatch_episodes=1, max_accumulation_windows=1,
                             accumulate_scored=1, accumulate_ingested=16384, max_history_tokens=16384,
                             max_window_records=args.training_window_records, scored_decisions=args.training_window_decisions,
                             max_record_bytes=16384, generated_capacity=1024,
                             model_overrides={'vocab_size': codec.vocab_size, 'max_capacity': 1024,
                                              'max_history_chunks': 1024},
                             effort=1, gradient_checkpointing=False, checkpoint_every=checkpoint_interval,
                             keep_checkpoints=checkpoint_retention, eval_every=0,
                             deterministic=True, use_stage_mixture=False, use_effort_mixture=False)
        config_path = root / 'train-config.json'
        write_json(config_path, asdict(config))
        plan = native_window_plan(prepared, codec, config)
        schedule = native_optimization_schedule(config, codec)
        plan_path = root / 'native-window-plan.json'
        schedule_path = root / 'native-schedule-plan.json'
        write_json(plan_path, plan)
        write_json(schedule_path, schedule)
        record(resolvedTrainingConfigSha256=sha256(config_path), nativeWindowPlanSha256=sha256(plan_path),
               nativeSchedulePlanSha256=sha256(schedule_path),
               nativeWindowPlan={'path': str(plan_path), 'sha256': sha256(plan_path),
                   'firstEpochWindows': plan['firstEpochWindows'],
                   'eachEpisodeIsOneWindow': plan['eachEpisodeIsOneWindow'],
                   **{key: value for key, value in schedule.items() if key not in {'windows', 'expectedFinalCursor'}}})
        if args.require_full_epoch and (args.steps != schedule['windowsPerFirstEpoch'] or
                schedule['expectedExamples'] != len(selected) or
                schedule['expectedScoredTokens'] != masks['counts']['generatedScoredTokens']):
            raise ValueError('Resolved native window plan does not consume exactly one complete prepared epoch')
        if args.base_checkpoint:
            initial, initial_parameters = bind_initial_checkpoint(args.base_checkpoint.resolve(), root, codec)
            record(initialCheckpointSource=str(args.base_checkpoint.resolve()))
        else:
            initial, initial_parameters = create_initial_checkpoint(root, config, codec, masks['chunking'],
                                                                   initialization_seed=args.initialization_seed)
        write_json(root / 'initial-parameter-identities.json', initial_parameters)
        gc.collect()
        base_bundle = export_checked(initial, root / 'served-base')
        record(phase='training', initialCheckpoint=str(initial), baseBundle=base_bundle)
        gc.collect()
        training_process = run_logged([sys.executable, '-m', 'megatoken', 'train', '--config', str(config_path),
                    '--resume', str(initial), '--phase-transition'], root / 'training.log',
                   env=env, timeout=args.train_timeout, graceful_checkpoint=True)
        record(trainingProcess=training_process)
        start_check = verify_training_start(initial, root / 'training/checkpoints/P1-000000000-phase-start')
        pointer = json.loads((root / 'training/checkpoints/latest.json').read_text())
        checkpoint = root / 'training/checkpoints' / pointer['checkpoint']
        checkpoint_check = checkpoint_receipt(checkpoint, initial_parameters, stream_fingerprint=plan['streamFingerprint'])
        exposure = training_exposure(plan, checkpoint_check['sourceSampling'])
        if checkpoint_check['globalStep'] != args.steps:
            raise ValueError('Actual optimizer step count differs from the requested cap')
        source_exposure = source_exposure_receipt(prepared, checkpoint_check['sourceSampling'])
        if source_exposure['windowsSampled'] != args.steps:
            raise ValueError('Actual source exposure differs from the atomic update count')
        if (checkpoint_check['sourceSampling']['source_windows'] != schedule['expectedSourceWindows'] or
                checkpoint_check['nativeCursors'] != [schedule['expectedFinalCursor']]):
            raise ValueError('Actual native source exposure/cursor differs from the frozen resolved window plan')
        metrics = [json.loads(line) for line in (root / 'training/metrics.jsonl').read_text().splitlines()]
        training = [row for row in metrics if row['event'] == 'train']
        write_json(root / 'optimizer-verification.json', checkpoint_check)
        if len(training) != args.steps or not all(row['gradient_norm'] > 0 for row in training):
            raise ValueError('Optimizer updates lack measured nonzero gradients')
        if sum(row['denominators']['lexical'] for row in training) != schedule['expectedScoredTokens']:
            raise ValueError('Actual scored lexical targets differ from the frozen native window plan')
        gradient_domains = ['encoder', 'model', 'shared']
        if not all(any(row.get('gradient_norm_' + domain, 0) > 0 for row in training)
                   for domain in gradient_domains):
            raise ValueError('Intended encoder/model/shared owners lack nonzero gradient evidence')
        trained_bundle = export_checked(checkpoint, root / 'served-trained')
        if base_bundle['model_sha256'] == trained_bundle['model_sha256']:
            raise ValueError('Training did not change the actual served model')
        record(phase='evaluating', optimizerSteps=args.steps, trainedBundle=trained_bundle,
               trainingExposure=exposure,
               initialTrainingState=start_check,
               checkpointVerification={key: value for key, value in checkpoint_check.items()
                                       if key not in {'changedParameters', 'updatedOptimizerOwners'}},
               changedParameterCount=len(checkpoint_check['changedParameters']),
               updatedOptimizerOwnerCount=len(checkpoint_check['updatedOptimizerOwners']),
               sourceExposure=source_exposure,
               nativeWindowPlanMatched=True,
               supervisedLexicalTokens=sum(row['denominators']['lexical'] for row in training),
               trainingSummary=[{'step': row['global_step'], 'gradientNorm': row['gradient_norm'],
                                 'gradientDomains': {domain: row['gradient_norm_' + domain]
                                                     for domain in gradient_domains},
                                 'loss': row['loss'], 'denominators': row['denominators'],
                                 'counters': row['step_counters']} for row in training])
        gc.collect()
        run_logged(['node', str(Path(__file__).with_name('build-optimization-cases.mjs')),
                    str(root / 'inputs.json'), str(root / 'private-cases.json'),
                    str(experiment['decoderSeed'] if experiment else args.seed)],
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
                        'approximately32Examples': len(selected) >= 32,
                        'everySelectedSourceExposed': exposure['everySelectedSourceExposed'],
                        'everySelectedEpisodeVisitedAllWindows': exposure['everySelectedEpisodeVisitedAllWindows'],
                        'approximately32ExamplesSampled': source_exposure['examplesSampled'] >= 32}
        record(status='completed', phase='complete', requirements=requirements,
               optimizationSmokePassed=all(requirements.values()),
               remaining=[] if all(requirements.values()) else [
                   key for key, passed in requirements.items() if not passed])
        print(json.dumps({'report': str(root / 'report.json'), 'requirements': requirements,
                          'optimizerSteps': args.steps}))
        return 0
    except BaseException as error:
        try:
            partial = partial_training_receipt(root)
            if partial is not None:
                write_json(root / 'partial-training-receipt.json', partial)
                record(partialTraining=partial, optimizerSteps=partial['observedOptimizerSteps'],
                       supervisedLexicalTokens=partial['supervisedLexicalTokens'])
        except Exception as evidence_error:
            record(partialEvidenceError={'type': type(evidence_error).__name__, 'message': str(evidence_error)})
        record(status='failed', error={'type': type(error).__name__, 'message': str(error)},
               traceback=traceback.format_exc())
        print(f'Optimization smoke stopped; durable report: {root / "report.json"}', file=sys.stderr)
        raise


if __name__ == '__main__':
    raise SystemExit(main())
