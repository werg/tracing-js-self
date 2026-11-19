#!/usr/bin/env python3
"""Authenticate the actual native dataset of a bounded P1 optimization diagnostic.

This reads an existing checkpoint and its checksummed prepared rows. It performs
no optimization or inference and does not issue production launch/budget claims.
"""
from __future__ import annotations

import argparse
from dataclasses import asdict
import hashlib
import json
from pathlib import Path
import subprocess
import sys


def file_sha256(path):
    digest = hashlib.sha256()
    with Path(path).open('rb') as source:
        for block in iter(lambda: source.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def value_digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':'),
                                    ensure_ascii=False, allow_nan=False).encode()).hexdigest()


def require_inventory_match(prepared, declared):
    if not prepared or set(prepared) != set(declared):
        raise ValueError('Declared training inputs do not cover exactly the actual prepared native inventory')
    for episode_id, row in prepared.items():
        if row['episodeSha256'] != declared[episode_id]['episodeSha256']:
            raise ValueError('Declared input adaptation differs from the actual prepared episode: ' + episode_id)


def inspect_training_inventory(training_run, consumer_root, tokenizer_json):
    root, consumer, tokenizer = Path(training_run).resolve(), Path(consumer_root).resolve(), Path(tokenizer_json).resolve()
    report_path = root / 'report.json'
    report = json.loads(report_path.read_text())
    if (report.get('schema') != 'optimization-smoke/1' or report.get('status') != 'completed' or
            report.get('purpose') != 'diagnostic' or report.get('generalizationClaim') is not False):
        raise ValueError('Only a completed bounded optimization diagnostic can be inventoried')
    revision = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=consumer, text=True).strip()
    subprocess.run(['git', 'diff', '--quiet', 'HEAD', '--'], cwd=consumer, check=True)
    if revision != report['consumerRevision'] or file_sha256(tokenizer) != report['tokenizerSha256']:
        raise ValueError('Actual inventory consumer or tokenizer differs from the optimization run')
    sys.path.insert(0, str(consumer / 'src'))
    from megatoken.data.semantic_harness_v6 import adapt_selected_harness_v6
    from megatoken.data.storage import PreparedCorpus
    from megatoken.generation.codec import ByteCodec
    from megatoken.training.checkpoint import load_checkpoint
    from megatoken.training.config import TrainConfig
    from megatoken.training.engine import window_config
    from megatoken.training.stream import WindowStream

    codec = ByteCodec.from_tokenizer_json(tokenizer, expected_sha256=report['tokenizerSha256'])
    if codec.fingerprint != report['tokenizerIdentity']:
        raise ValueError('Actual inventory tokenizer identity differs')
    checkpoint = Path(report['checkpointVerification']['checkpoint'])
    payload, metadata = load_checkpoint(checkpoint)
    if (metadata['state_sha256'] != report['checkpointVerification']['stateSha256'] or
            payload.get('global_step') != report['optimizerSteps'] or type(payload.get('global_step')) is not int or
            payload['global_step'] < 1 or payload.get('codec_fingerprint') != codec.fingerprint):
        raise ValueError('Actual training checkpoint identity, tokenizer, or optimizer updates differ')
    config_path = root / 'train-config.json'
    config = payload['train_config']
    if (file_sha256(config_path) != report['resolvedTrainingConfigSha256'] or
            json.loads(config_path.read_text()) != config):
        raise ValueError('Published diagnostic configuration differs from the actual checkpoint configuration')
    if (config.get('phase') != 'P1' or config.get('purpose') != 'diagnostic' or
            config.get('semantic_experiment') is not None or config.get('use_stage_mixture') is not False or
            config.get('decoupled') is not None or len(config.get('datasets', [])) != 1):
        raise ValueError('Inventory helper supports the single-root synchronous P1 diagnostic profile only')
    config = TrainConfig.from_dict(config)
    if file_sha256(config.codec) != report['tokenizerSha256']:
        raise ValueError('Checkpoint configuration refers to a different tokenizer')
    ranks = payload.get('rank_state', [])
    if len(ranks) != 1 or ranks[0]['cursor'].get('world_size') != 1 or ranks[0]['cursor'].get('rank') != 0:
        raise ValueError('Inventory helper requires the actual single-rank diagnostic cursor')
    cursor = ranks[0]['cursor']
    # Retain only the actual configuration/cursor; do not hold model tensors while
    # decoding the original source exports and their repeated source registries.
    del payload
    prepared, manifest_bindings, roots = {}, [], [str(Path(path).resolve()) for path in config.datasets]
    with PreparedCorpus(roots, split=None) as corpus:
        corpus_identity = corpus.identity
        if corpus.codec_fingerprint != codec.fingerprint:
            raise ValueError('Prepared corpus has a different tokenizer')
        for part in corpus.parts:
            manifest = part.manifest
            if manifest['fingerprint'] != report['preparedFingerprint']:
                raise ValueError('Actual checkpoint dataset differs from the reported prepared fingerprint')
            sources = manifest.get('sources', [])
            if len(sources) != 1:
                raise ValueError('Prepared diagnostic requires one bound semantic source receipt')
            pins = sources[0]
            for field, expected in [('schema', 'semantic-preparation/4'), ('representation', 'compact'),
                                    ('producerRevision', report['producerRevision']), ('consumerRevision', revision),
                                    ('tokenizerIdentity', codec.fingerprint)]:
                if pins.get(field) != expected:
                    raise ValueError('Prepared source receipt differs: ' + field)
            manifest_bindings.append({'path': str(part.root / 'manifest.json'),
                                      'sha256': file_sha256(part.root / 'manifest.json'),
                                      'fingerprint': manifest['fingerprint']})
            for index in range(len(part)):
                episode = part[index]
                split = part.index_entry(index)['split']
                if split != 'train' or episode.lineage.frozen_split != split:
                    raise ValueError('Actual P1 diagnostic corpus contains a non-training or inconsistent split')
                if episode.episode_id in prepared:
                    raise ValueError('Actual prepared diagnostic episode identity is duplicated')
                prepared[episode.episode_id] = {'episodeId': episode.episode_id,
                    'episodeSha256': value_digest(episode.to_dict()), 'sourceId': episode.lineage.source_id,
                    'family': episode.lineage.family_id, 'ancestorIds': list(episode.lineage.ancestor_ids),
                    'taskId': episode.lineage.task_id, 'split': split}
    inputs = report.get('inputIdentities')
    if not isinstance(inputs, list) or len(inputs) != len(prepared):
        raise ValueError('Declared training inputs do not cover exactly the actual prepared native inventory')
    declared = {}
    for item in inputs:
        path = Path(item['path'])
        if file_sha256(path) != item['sha256']:
            raise ValueError('Declared original training export bytes changed')
        document = json.loads(path.read_text())
        # The caller independently authenticates each producer admission identity.
        # This native adaptation binds its exact full episode, including family and
        # ancestry, to what the checkpoint actually consumed. It is not admission.
        episode, _ = adapt_selected_harness_v6(document, codec=codec,
            max_positions=pins['maxPositions'], max_history=pins['maxHistory'], admission_verifier=lambda _: True)
        if episode.episode_id in declared:
            raise ValueError('Declared native training episode identity is duplicated')
        declared[episode.episode_id] = {'episodeSha256': value_digest(episode.to_dict()),
                                       'inputPath': str(path.resolve()), 'inputSha256': item['sha256']}
        del document, episode
    require_inventory_match(prepared, declared)
    resolved_window = window_config(config)
    with PreparedCorpus(roots) as corpus:
        stream = WindowStream(corpus, codec, resolved_window, seed=config.seed)
        fingerprint = stream.fingerprint
        if corpus.identity != corpus_identity:
            raise ValueError('Prepared corpus changed between inventory and native stream construction')
        if (cursor.get('dataset_fingerprint') != fingerprint or cursor.get('codec_fingerprint') != codec.fingerprint or
                metadata.get('dataset_fingerprint') != fingerprint or cursor.get('seed') != config.seed):
            raise ValueError('Actual checkpoint cursor does not bind this native prepared stream')
        # The native restore validator also checks the full cursor structure.
        stream.load_state_dict(cursor)
    sampled = cursor.get('sampled_source_windows')
    source_ids = {row['sourceId'] for row in prepared.values()}
    if (cursor.get('sampled_history_complete') is not True or not isinstance(sampled, dict) or not sampled or
            not set(sampled).issubset(source_ids) or
            any(type(count) is not int or count < 1 for count in sampled.values())):
        raise ValueError('Actual checkpoint sampled-source evidence is incomplete or outside the prepared inventory')
    rows = [{**row, **declared[episode_id]} for episode_id, row in sorted(prepared.items())]
    return {'schema': 'optimization-actual-training-inventory/1', 'purpose': 'diagnostic',
            'productionQualification': False, 'trainingReportSha256': file_sha256(report_path),
            'checkpointSha256': metadata['state_sha256'], 'optimizerSteps': report['optimizerSteps'],
            'resolvedTrainingConfigSha256': file_sha256(config_path), 'consumerRevision': revision,
            'tokenizerSha256': report['tokenizerSha256'], 'tokenizerIdentity': codec.fingerprint,
            'datasets': roots, 'manifests': manifest_bindings, 'corpusIdentity': corpus_identity,
            'streamFingerprint': fingerprint, 'resolvedWindowConfig': asdict(resolved_window),
            'preparedExamples': len(rows), 'preparedFamilies': len({row['family'] for row in rows}),
            'actualSampledSources': sampled, 'actualExamplesSampled': len(sampled),
            'rows': rows, 'inventoryDigest': value_digest(rows), 'exactDeclaredInventory': True}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--training-run', type=Path, required=True)
    parser.add_argument('--consumer-root', type=Path, required=True)
    parser.add_argument('--tokenizer-json', type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(inspect_training_inventory(args.training_run, args.consumer_root, args.tokenizer_json)))


if __name__ == '__main__':
    main()
