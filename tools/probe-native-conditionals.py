#!/usr/bin/env python3
"""Capture real training/serving native conditional states at one exact checkpoint.

Use --initialize-tiny with one CURRENT natively admitted episode to prepare and
save an actual zero-update diagnostic checkpoint, or supply --checkpoint and its
--prepared corpus. No optimizer or model selection is executed. Both paths stop
at the first real native conditional Gaussian before the policy draw.
"""
from __future__ import annotations

import argparse
from dataclasses import asdict
import gc
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import time
import traceback

from native_conditional_probe import (capture_prior, compare_priors, decoder_support_comparison,
                                      digest, require_checkpoint_hash)

SPEC = importlib.util.spec_from_file_location('optimization_smoke', Path(__file__).with_name('run-optimization-smoke.py'))
SMOKE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SMOKE)


def read_json(path): return json.loads(Path(path).read_text())


def prepared_identity(episode):
    data = episode.to_dict()
    return digest({key: value for key, value in data.items() if key not in ('lineage', 'supervision')})


def source_bindings(consumer):
    files = ['src/megatoken/data/semantic_harness_v5.py', 'src/megatoken/data/semantic_physical.py',
             'src/megatoken/controls.py', 'src/megatoken/semantic_model_adapter.py',
             'src/megatoken/data/schema.py', 'src/megatoken/data/storage.py',
             'src/megatoken/training/meridians.py', 'src/megatoken/training/engine.py',
             'src/megatoken/model/multitrack.py', 'src/megatoken/model/core.py',
             'src/megatoken/generation/decoder.py', 'src/megatoken/generation/distributions.py',
             'src/megatoken/served.py', 'src/megatoken/training/checkpoint.py']
    return [{'path': name, 'sha256': SMOKE.sha256(consumer/name)} for name in files]


def training_capture(checkpoint, prepared, packet, *, identity, seed):
    from megatoken.loading import load_trained
    trained = load_trained(checkpoint, device='cpu')
    require_checkpoint_hash(trained.metadata.get('state_sha256'), identity['checkpointStateSha256'],
                            origin='Actual training reload')
    import torch
    from megatoken.data.storage import PreparedCorpus
    from megatoken.data.semantic_harness_v5 import adapt_selected_harness_v5
    from megatoken.runtime import seed_everything
    from megatoken.training.config import TrainConfig
    from megatoken.training.engine import prepare_batches, window_config
    from megatoken.training.losses import LossLedger
    from megatoken.training.meridians import forward_meridian_batch
    from megatoken.training.stream import EpisodeWindow, _WindowPlan
    from megatoken.training.transducer import TransducerTrainer
    model, codec = trained.model, trained.codec
    model.eval()
    config = TrainConfig.from_dict(trained.payload['train_config'], expand_data=False)
    expected, _ = adapt_selected_harness_v5(packet['exported'], codec=codec,
        max_positions=model.config.max_capacity, max_history=model.config.max_history_chunks,
        allow_local=False, admission_verifier=lambda document:
            document['sidecar']['identityDigest'] == packet['sourceAdmission']['identityDigest'])
    expected_identity = prepared_identity(expected)
    before = SMOKE.state_identity(model.state_dict())
    with PreparedCorpus([str(prepared)], split='train') as corpus:
        matches = []
        for index in range(len(corpus)):
            episode, assets = corpus.fetch(index)
            if episode.episode_id == expected.episode_id:
                matches.append((episode, assets))
        if len(matches) != 1:
            raise ValueError('Exactly one actual prepared episode must match the source-certified native episode')
        episode, assets = matches[0]
        if prepared_identity(episode) != expected_identity:
            raise ValueError('Prepared native observations, physical targets or causal controls differ from fresh adaptation')
        windows = _WindowPlan(episode, codec, window_config(config))
        if not len(windows): raise ValueError('The native optimizer has no scored window for this episode')
        item = EpisodeWindow(episode, windows[0], assets)
        batches = prepare_batches(model, [item], config)
        if len(batches) != 1: raise ValueError('One exact native first window is required')
        batch = batches[0]
        first = next(entry for step in batch.steps for entry in step.records if entry.record.policy_mask)
        if any(entry.record.policy_mask for step in batch.prefix for entry in step.records):
            raise ValueError('Conditional capture must precede every generated record')
        if not packet['firstTarget']['record'].encode().startswith(first.record.payload):
            raise ValueError('Native first fragment differs from the public first generated target')
        transducer = TransducerTrainer(model.transducer, bank_trainable=config.trainable == 'all',
            teacher_weight=config.hindsight_distill_weight, navigation_weight=config.navigation_weight,
            navigation_examples=config.navigation_examples, navigation_negatives=config.navigation_negatives)
        ledger = LossLedger(dict(batch.counts), dict(batch.counts), config.loss_weights)
        seed_everything(seed, True)
        result = capture_prior(lambda: forward_meridian_batch(model, batch, ledger, config,
            torch.device('cpu'), trained.payload['global_step'], differentiate=False, transducer=transducer),
            model, path='training', identity=identity)
        result.update(preparedCorpusIdentity=corpus.identity, preparedEpisodeId=episode.episode_id,
            preparedInputIdentity=expected_identity, nativeWindow={'start': item.window.start, 'end': item.window.end},
            firstPhysicalTarget={'recordId': first.record.record_id, 'payloadHex': first.record.payload.hex(),
                'tokenIds': list(first.token_ids), 'freeMask': list(first.free_mask),
                'partIndex': first.record.part_index, 'partCount': first.record.part_count},
            trainingConfigSha256=digest(trained.payload['train_config']),
            actualModelTensorIdentity=before)
    if SMOKE.state_identity(model.state_dict()) != before:
        raise ValueError('Read-only training conditional probe changed the native model state')
    result['modelStateUnchanged'] = True
    del model, trained
    gc.collect()
    return result


def serving_capture(bundle_path, packet, *, identity, seed, max_tokens):
    from megatoken.served import ServedBundle
    served = ServedBundle(bundle_path, device='cpu')
    require_checkpoint_hash(served.manifest.get('checkpoint_sha256'), identity['checkpointStateSha256'],
                            origin='Actual served reload')
    from megatoken.model.multitrack import MultiTrackGenerator
    from megatoken.multitrack_runtime import MultiTrackRuntime
    from megatoken.semantic_model_adapter import SelectedSemanticInference
    model = served.model
    before = SMOKE.state_identity(model.state_dict())
    runtime = MultiTrackRuntime(MultiTrackGenerator.of(model), chunking=served.chunking)
    adapter = SelectedSemanticInference(runtime, effort=1, max_tokens=max_tokens,
                                        model_identity=served.manifest['model_sha256'])
    initialization = adapter.initialize(seed=seed, checkpointIdentity=identity['servedModelSha256'])
    try:
        result = capture_prior(lambda: adapter.select(packet['prefix']), model,
                               path='serving', identity=identity)
        result['initialization'] = initialization
        result['sourceVisibilityVerification'] = 'real native runtime enabled'
        result['actualServedTensorIdentity'] = before
        result['runtimeSessionsAtBoundary'] = len(adapter.sessions)
        # This records actual decoder buffers and dimensions, without pretending
        # that downstream decoder heads ran before our deliberate stop.
        bytes_ids = model.decoder.valid_bytes.nonzero().reshape(-1).tolist()
        utf8_ids = model.decoder.valid_utf8.nonzero().reshape(-1).tolist()
        result['decoderBufferInventory'] = {'status': 'measured-buffers-not-decoder-execution',
            'lengthHeadRows': model.decoder.length_codes.num_embeddings,
            'terminalHeadRows': model.decoder.terminal_codes.num_embeddings,
            'bytesAlphabetIds': bytes_ids, 'utf8AlphabetIds': utf8_ids,
            'bytesOnlyIds': sorted(set(bytes_ids) - set(utf8_ids)),
            'utf8OnlyIds': sorted(set(utf8_ids) - set(bytes_ids))}
    finally:
        runtime.close()
    if SMOKE.state_identity(model.state_dict()) != before:
        raise ValueError('Read-only serving conditional probe changed the native model state')
    result['modelStateUnchanged'] = True
    result['runtimeClosed'] = True
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--consumer-root', type=Path, required=True)
    parser.add_argument('--episode', type=Path, required=True)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--initialize-tiny', action='store_true')
    mode.add_argument('--checkpoint', type=Path)
    parser.add_argument('--prepared', type=Path)
    parser.add_argument('--tokenizer-json', type=Path)
    parser.add_argument('--seed', type=int, choices=[17, 29, 43], default=17)
    parser.add_argument('--max-tokens', type=int, default=128)
    parser.add_argument('--atol', type=float, default=1e-6)
    parser.add_argument('--rtol', type=float, default=1e-5)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if args.initialize_tiny and (args.tokenizer_json is None or args.prepared is not None):
        parser.error('--initialize-tiny requires --tokenizer-json and prepares its own exact native corpus')
    if args.checkpoint and (args.prepared is None or args.tokenizer_json is not None):
        parser.error('--checkpoint requires its --prepared corpus and its original embedded tokenizer identity')
    if not 1 <= args.max_tokens <= 1024: parser.error('--max-tokens must be 1..1024')
    if not 0 <= args.atol <= .001 or not 0 <= args.rtol <= .001: parser.error('Numeric tolerance must be 0..0.001')
    root = args.output.resolve(); root.mkdir(parents=True, exist_ok=False)
    report = {'schema': 'semantic-native-conditional-parity/1', 'status': 'running',
              'modelSelections': 0, 'optimizerSteps': 0, 'learnedSuccess': None,
              'scope': 'First generated native Gaussian prior, with real prefix reconstruction and dropout disabled',
              'downstreamLexicalAndActionParity': 'unmeasured'}
    started = time.monotonic()

    def record(**changes):
        report.update(changes); SMOKE.write_json(root/'report.json', report)

    record(phase='source-verification')
    try:
        tracer, consumer = Path(__file__).resolve().parents[1], args.consumer_root.resolve()
        SMOKE.require_clean_checkout(tracer); SMOKE.require_clean_checkout(consumer)
        producer_revision, consumer_revision = SMOKE.git_head(tracer), SMOKE.git_head(consumer)
        packet = json.loads(subprocess.check_output(['node', str(Path(__file__).with_name('build-native-probe-input.mjs')),
                                                    str(args.episode.resolve())], text=True, timeout=120))
        original = read_json(args.episode)
        if SMOKE.sha256(args.episode) != packet['episodeSha256']:
            raise ValueError('Source-certified candidate changed before native capture')
        if (packet['exported']['sidecar']['admission'] != 'admitted' or
                original['sidecar']['split'] != 'train' or
                original['sidecar']['producerRevision'] != producer_revision or
                original['sidecar']['nativePolicy']['consumerRevision'] != consumer_revision):
            raise ValueError('Actual conditional capture requires current source/native-admitted training input')
        SMOKE.write_json(root/'public-probe-input.json', packet)
        record(producerRevision=producer_revision, consumerRevision=consumer_revision,
               episodeSha256=packet['episodeSha256'], sourceIdentityDigest=packet['sourceAdmission']['identityDigest'],
               sourceAdmission=packet['sourceAdmission'], boundarySourceBindings=source_bindings(consumer),
               probeSha256=SMOKE.sha256(__file__), captureHookSha256=SMOKE.sha256(Path(__file__).with_name('native_conditional_probe.py')),
               prefixBuilderSha256=SMOKE.sha256(Path(__file__).with_name('build-native-probe-input.mjs')))
        sys.path.insert(0, str(consumer/'src'))
        import torch
        torch.set_num_threads(1)
        if args.initialize_tiny:
            from megatoken.data.semantic_corpus import prepare_semantic_corpus, source_verifier_for_checkout
            from megatoken.generation.codec import ByteCodec, LING_TOKENIZER_SHA256
            from megatoken.training.config import TrainConfig
            codec = ByteCodec.from_tokenizer_json(args.tokenizer_json.resolve(), expected_sha256=LING_TOKENIZER_SHA256)
            prepared = root/'prepared'
            record(phase='fresh-native-preparation')
            manifest, preparation = prepare_semantic_corpus([original], prepared, codec=codec,
                producer_revision=producer_revision, consumer_revision=consumer_revision,
                source_verifier=source_verifier_for_checkout(tracer, producer_revision),
                max_positions=1024, max_history=1024)
            if preparation['accepted'] != 1: raise ValueError('Fresh native preparation did not admit the exact single candidate')
            masks = SMOKE.mask_receipt(prepared, codec)
            SMOKE.write_json(root/'loss-masks.json', masks)
            config = TrainConfig(purpose='diagnostic', phase='P1', model='tiny',
                codec=str(args.tokenizer_json.resolve()), datasets=[str(prepared)], output=str(root/'unused-training-output'),
                device='cpu', precision='fp32', seed=args.seed, max_steps=1, microbatch_episodes=1,
                max_accumulation_windows=1, accumulate_scored=1, accumulate_ingested=16384,
                max_history_tokens=16384, max_window_records=64, scored_decisions=64,
                max_record_bytes=16384, generated_capacity=1024,
                model_overrides={'vocab_size': codec.vocab_size, 'max_capacity': 1024, 'max_history_chunks': 1024},
                effort=1, gradient_checkpointing=False, eval_every=0, deterministic=True,
                use_stage_mixture=False, use_effort_mixture=False)
            SMOKE.write_json(root/'initialization-config.json', asdict(config))
            checkpoint, _ = SMOKE.create_initial_checkpoint(root, config, codec, masks['chunking'], initialization_seed=args.seed)
            record(preparation=preparation, preparedFingerprint=manifest['fingerprint'],
                   checkpointOrigin='newly-initialized-zero-update-diagnostic')
        else:
            checkpoint, prepared = args.checkpoint.resolve(), args.prepared.resolve()
            record(checkpointOrigin='existing-exact-checkpoint')
        from megatoken.training.checkpoint import load_checkpoint, resolve_checkpoint
        # A root/latest.json reference can advance while a diagnostic runs.
        # Resolve it once, then bind every read/export to this physical snapshot.
        checkpoint_request = str(checkpoint)
        checkpoint = resolve_checkpoint(checkpoint).resolve(strict=True)
        record(phase='checkpoint-verification', checkpointRequest=checkpoint_request,
               checkpoint=str(checkpoint))
        payload, metadata = load_checkpoint(checkpoint)
        checkpoint_step = payload['global_step']; del payload
        bundle = SMOKE.export_checked(checkpoint, root/'served-exact')
        require_checkpoint_hash(bundle.get('checkpoint_sha256'), metadata.get('state_sha256'),
                                origin='Exported served bundle')
        identity = {'checkpointStateSha256': metadata['state_sha256'], 'servedModelSha256': bundle['model_sha256'],
                    'tokenizerIdentity': bundle['codec_fingerprint'], 'publicPrefixSha256': digest(packet['prefix']),
                    'firstTargetSha256': hashlib.sha256(packet['firstTarget']['record'].encode()).hexdigest()}
        record(phase='training-native-conditional', checkpoint=str(checkpoint), checkpointGlobalStep=checkpoint_step,
               identity=identity, servedReloadExact=bundle['servedReloadExact'], seed=args.seed)
        gc.collect()
        training = training_capture(checkpoint, prepared, packet, identity=identity, seed=args.seed)
        SMOKE.write_json(root/'training-conditional.json', training)
        record(phase='serving-native-conditional', trainingCaptureSha256=SMOKE.sha256(root/'training-conditional.json'))
        gc.collect()
        serving = serving_capture(root/'served-exact', packet, identity=identity, seed=args.seed, max_tokens=args.max_tokens)
        SMOKE.write_json(root/'serving-conditional.json', serving)
        comparison = compare_priors(training, serving, atol=args.atol, rtol=args.rtol)
        supports = decoder_support_comparison(consumer/'src/megatoken/generation/decoder.py', serving)
        mismatch = (comparison['status'] == 'failed' or not comparison['encoderCallAuditIdentical'] or
                    supports['status'] == 'source-defined-mismatch')
        SMOKE.write_json(root/'comparison.json', comparison)
        SMOKE.require_clean_checkout(tracer); SMOKE.require_clean_checkout(consumer)
        if (source_bindings(consumer) != report['boundarySourceBindings'] or
                SMOKE.sha256(args.episode) != packet['episodeSha256']):
            raise ValueError('Bound source or native implementation changed during capture')
        record(status='failed' if mismatch else 'measured', phase='complete', comparison=comparison,
               gaussianConditionalStatus=comparison['status'],
               trainingServingParityStatus='failed' if mismatch else 'unmeasured',
               fullConditionalParityClaim=False, decoderSupportComparison=supports,
               servingCaptureSha256=SMOKE.sha256(root/'serving-conditional.json'),
               comparisonSha256=SMOKE.sha256(root/'comparison.json'), wallSeconds=time.monotonic()-started,
               limitations=['Only the first event conditional Gaussian was executed, not downstream lexical or action heads.',
                            'The trainer uses its real eval-mode prefix reconstruction; no synthetic serving state is substituted.',
                            'A match at an untrained checkpoint does not establish equivalence after learning or across other prefixes.',
                            'Categorical decoder supports remain a distinct check; native alphabets and head sizes are retained.'])
        print(json.dumps({'report': str(root/'report.json'), 'status': report['status'],
                          'gaussianConditionalStatus': comparison['status'],
                          'maxAbsoluteDifference': comparison['maximumAbsoluteDifference'],
                          'modelSelections': 0, 'optimizerSteps': 0}))
        return 1 if mismatch else 0
    except BaseException as error:
        record(status='unmeasured', phase='capture-incomplete',
               error={'type': type(error).__name__, 'message': str(error)}, traceback=traceback.format_exc(),
               wallSeconds=time.monotonic()-started)
        raise


if __name__ == '__main__': raise SystemExit(main())
