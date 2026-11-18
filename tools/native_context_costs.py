"""Derive exact native window and direct-history costs without running a model.

The supported input is an existing completed, single-rank P1 diagnostic whose
saved native window plan matches its actual checkpoint cursor. Historical
payload-token footprints describe represented text, not a flat model prompt.
"""
from __future__ import annotations

import argparse
from collections import Counter
from dataclasses import asdict
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import time


def digest_file(path):
    digest = hashlib.sha256()
    with Path(path).open('rb') as source:
        for block in iter(lambda: source.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def require(condition, message):
    if not condition:
        raise ValueError(message)


def binding(path):
    path = Path(path).resolve()
    return {'path': str(path), 'sha256': digest_file(path), 'bytes': path.stat().st_size}


def window_identity(item):
    window = item.window
    return {'sourceId': item.episode.lineage.source_id,
            'family': item.episode.lineage.family_id, 'episodeId': item.episode.episode_id,
            'windowIndex': window.index, 'start': window.start, 'end': window.end,
            'recordIds': [row.record.record_id for row in window.records],
            'scoredTokens': sum(sum(row.free_mask) for row in window.records)}


def verify_window_identity(item, expected):
    require(window_identity(item) == expected, 'Native window differs from the saved exact plan')


def window_cost(item):
    window = item.window
    prefix, records = tuple(window.prefix), tuple(window.records)
    return {**window_identity(item),
            'newTranscriptTokensD': sum(row.tokens for row in records),
            'reconstructionTranscriptTokens': sum(row.tokens for row in prefix),
            'ingestedTranscriptTokensI': sum(row.tokens for row in (*prefix, *records)),
            'newLikelihoodPositions': sum(row.positions for row in records),
            'reconstructionLikelihoodPositions': sum(row.positions for row in prefix),
            'newPayloadBytes': sum(len(row.payload) for row in records),
            'ingestedPayloadBytes': sum(len(row.payload) for row in (*prefix, *records)),
            'newPhysicalRecords': len(records), 'reconstructionPhysicalRecords': len(prefix),
            'largestRecordLikelihoodPositions': max((row.positions for row in (*prefix, *records)), default=0)}


def context_costs(episode, encoded, model_config, end, *, start=0):
    """Use native visibility/retention rules, preserving simultaneous groups.

    This reports direct historical reads only. Recurrent summaries, description
    controls, decoder state and latent information are not lexical prompt tokens.
    Native action tapes and media need distinct chronology/units and are refused.
    """
    from megatoken.data.context import context_announcement, validate_context_announcements
    from megatoken.model.context import ContextPolicy, retained_context_events
    from megatoken.model.config import KNOWLEDGE_TRACK, METADATA_TRACK, TRANSDUCER_QUERY_TRACK, RESERVED_TRACKS
    from megatoken.model.core import ROLE_IDS
    from megatoken.model.transducer import completed_turn, real_boundary
    from megatoken.training.transducer import Meridian, plan_boundaries

    annotations = json.loads(episode.supervision.annotations_json)
    require(not annotations.get('native_action_tapes'), 'Native action-tape context is outside this meter')
    require(not annotations.get('retrieval') and episode.stream == 'semantic_execution'
            and annotations.get('semantic_execution', {}).get('continuation') == 'teacher_conditioned',
            'Only teacher-conditioned semantic episodes without mounted retrieval sources are metered')
    require(bool(episode.meridians), 'Explicit native meridians are required')
    require(len(encoded) == len(episode.records), 'Complete episode tokenization is required')
    rows = {row.record.record_id: row for row in encoded}
    positions = {record.record_id: i for i, record in enumerate(episode.records)}
    require(len(rows) == len(encoded), 'Duplicate physical record identity')
    require(all(row.record.media_type.split('/', 1)[0] not in {'audio', 'image', 'video'}
                and row.record.media_type != 'application/vnd.megatoken.media-reference+json'
                for row in encoded), 'Media features cannot be reported as lexical context tokens')
    validate_context_announcements(episode)
    require(type(end) is int and 1 <= end <= len(encoded), 'Invalid physical window end')
    require(type(start) is int and 0 <= start < end, 'Invalid physical window start')
    groups, offset = [], 0
    for group in episode.meridians:
        if offset >= end:
            break
        groups.append(group)
        offset += len(group.events)
    require(offset == end, 'Window end splits a native meridian')
    boundaries = []
    for group in groups:
        names = tuple(event.track_id for event in group.events)
        require(not set(names).intersection(RESERVED_TRACKS), 'Physical tracks cannot shadow internal transducer tracks')
        roles = tuple(ROLE_IDS[event.role] for event in group.events)
        complete = tuple(rows[event.record_id].record.part_index + 1 == rows[event.record_id].record.part_count
                         for event in group.events)
        boundaries.append(Meridian(names, roles, tuple(event.modality for event in group.events),
                                   real_boundary(roles, complete), completed_turn(roles, complete, 'user')))
    # The pinned trainer calls this public planner with generator=None even in
    # training. Bank-only successful lookups commit exactly query then knowledge;
    # mounted collection reads and native action tapes are explicitly excluded.
    lookups = plan_boundaries(boundaries, max_lookups=model_config.transducer_max_lookups, generator=None)
    policy = ContextPolicy(local_events=model_config.context_local_events,
                           cross_events=model_config.context_cross_events)
    event_ids, tracks, history_positions, sizes = (), (), (), ()
    seen, cursor, maximum_retained, scored_lookups = 0, 0, 0, 0
    costs = []
    def commit(ids, names):
        nonlocal event_ids, tracks, history_positions, sizes, seen, maximum_retained
        kept, retained_sizes, _ = retained_context_events(policy=policy, tracks=tracks,
            positions=history_positions, event_ids=event_ids, meridian_sizes=sizes,
            seen=seen, new_tracks=names, budget=model_config.max_history_chunks)
        event_ids = (*(event_ids[i] for i in kept), *ids)
        tracks = (*(tracks[i] for i in kept), *names)
        history_positions = (*(history_positions[i] for i in kept), *range(seen, seen + len(ids)))
        sizes = (*retained_sizes, len(ids))
        seen += len(ids)
        maximum_retained = max(maximum_retained, len(event_ids))
    # Metadata always commits one event. Its randomly dropped field payload was
    # not logged; count its native event/facets, never invent its lexical tokens.
    commit((METADATA_TRACK,), (METADATA_TRACK,))
    for group, before in zip(groups, lookups, strict=True):
        ids = tuple(event.record_id for event in group.events)
        names = tuple(event.track_id for event in group.events)
        require(tuple(positions[key] for key in ids) == tuple(range(cursor, cursor + len(ids))),
                'Meridian must cover the next complete chronological record group')
        require(all(event.modality == 'text' for event in group.events), 'Only text context is metered')
        for name, key in zip(names, ids, strict=True):
            record = rows[key].record
            announcement = context_announcement(record.payload, record.role)
            if announcement is not None:
                require(all(type(announcement[key]) is int and
                            0 <= announcement[key] <= model_config.max_history_chunks
                            for key in ('local_events', 'cross_events')),
                        'Context announcement exceeds actual model event capacity')
                policy = policy.configure(name, **announcement)
                require(all(event_ids.count(key) == 1 for _, key in policy.pins),
                        'Context pin must name one retained earlier event')
        for _ in range(before):
            commit((TRANSDUCER_QUERY_TRACK,), (TRANSDUCER_QUERY_TRACK,))
            commit((KNOWLEDGE_TRACK,), (KNOWLEDGE_TRACK,))
        if cursor >= start:
            scored_lookups += before
        visible = [policy.visible(name, tracks, history_positions, event_ids, seen) for name in names]
        union = {i for mask in visible for i, allowed in enumerate(mask) if allowed}
        readers = []
        for name, key, mask in zip(names, ids, visible, strict=True):
            selected = [event_ids[i] for i, allowed in enumerate(mask) if allowed]
            readers.append({'track': name, 'recordId': key,
                'generated': bool(rows[key].record.policy_mask),
                'visibleEventIds': selected, 'directHistoryEvents': len(selected),
                'directHistoryFacetSlots': len(selected) * model_config.n_facets,
                'visiblePreparedPayloadTokenIds': sum(rows[old].positions for old in selected if old in rows),
                'visiblePreparedTranscriptTokens': sum(rows[old].tokens for old in selected if old in rows),
                'visibleMetadataEvents': selected.count(METADATA_TRACK),
                'visibleLatentRetrievalEvents': sum(old in {TRANSDUCER_QUERY_TRACK, KNOWLEDGE_TRACK} for old in selected)})
        costs.append({'meridianId': group.meridian_id, 'start': cursor, 'end': cursor + len(ids),
                      'readers': readers, 'unionDirectHistoryEvents': len(union),
                      'unionDirectHistoryFacetSlots': len(union) * model_config.n_facets,
                      'unionPreparedPayloadTokenIds': sum(rows[event_ids[i]].positions for i in union if event_ids[i] in rows)})
        commit(ids, names)
        cursor += len(ids)
    require(cursor == end, 'Native context chronology omitted physical records')
    return {'groups': costs, 'plannedLookups': sum(lookups), 'scoredLookups': scored_lookups,
            'reconstructedLookups': sum(lookups) - scored_lookups, 'finalRetainedEvents': len(event_ids),
            'maximumRetainedEvents': maximum_retained, 'nativeCommittedEvents': seen,
            'metadataPayloadTokenIds': None,
            'metadataTokenReason': 'Actual training metadata fields were randomly dropped and their payload was not logged.'}


def summarize(windows):
    fields = ['newTranscriptTokensD', 'reconstructionTranscriptTokens', 'ingestedTranscriptTokensI',
              'newLikelihoodPositions', 'reconstructionLikelihoodPositions', 'newPayloadBytes',
              'ingestedPayloadBytes', 'newPhysicalRecords', 'reconstructionPhysicalRecords', 'scoredTokens']
    totals = {key: sum(row[key] for row in windows) for key in fields}
    maxima = {key: max((row[key] for row in windows), default=0) for key in fields}
    generated = [reader for row in windows for group in row['contextGroups']
                 for reader in group['readers'] if reader['generated']]
    context_fields = ['directHistoryEvents', 'directHistoryFacetSlots',
                      'visiblePreparedPayloadTokenIds', 'visiblePreparedTranscriptTokens',
                      'visibleMetadataEvents', 'visibleLatentRetrievalEvents']
    maxima.update({key: max((row[key] for row in generated), default=None) for key in context_fields})
    maxima['generatedMeridianUnionHistoryFacetSlots'] = max((group['unionDirectHistoryFacetSlots']
        for row in windows for group in row['contextGroups']
        if any(reader['generated'] for reader in group['readers'])), default=None)
    maxima['recordLikelihoodPositions'] = max((row['largestRecordLikelihoodPositions'] for row in windows), default=0)
    maxima['nativeRetainedEvents'] = max(row['nativeContext']['maximumRetainedEvents'] for row in windows)
    maxima['observedWindowEndRetainedEvents'] = max(row['observedContext']['retainedEvents'] for row in windows)
    maxima['observedWindowEndCacheBytes'] = max(row['observedContext']['cacheBytes'] for row in windows)
    return {'windows': len(windows), 'episodes': len({row['episodeId'] for row in windows}),
            'families': len({row['family'] for row in windows}),
            'generatedRecordReads': len(generated), 'totals': totals, 'maxima': maxima,
            'maxFlatModelPromptTokens': None,
            'maxFullHistoricalPayloadTokenIds': None,
            'flatPromptMeaning': 'Not a flat-prompt model: recurrent facets directly read prior event blocks. '
                'Prepared payload token footprint excludes unlogged metadata and nonlexical query/knowledge events; '
                'it is not the attention sequence length or all retained information.'}


def verify_observed_context(derived, metric):
    observed = metric['generator']
    require(observed.get('context_windows') == 1, 'Exactly one observed context window is required')
    for key in ('context_retained_events_sum', 'context_cache_bytes_sum', 'transducer_lookups', 'transducer_observed'):
        value = observed.get(key)
        require(type(value) in (int, float) and value >= 0 and int(value) == value,
                'Actual context metric must be a nonnegative integer: ' + key)
    require(observed['context_retained_events_sum'] == derived['finalRetainedEvents'],
            'Derived native history differs from the actual final context metric')
    require(observed['transducer_lookups'] == derived['plannedLookups']
            and observed['transducer_observed'] == derived['scoredLookups'],
            'Derived lookup chronology differs from actual planned/scored lookup metrics')
    return {'retainedEvents': int(observed['context_retained_events_sum']),
            'cacheBytes': int(observed['context_cache_bytes_sum']),
            'plannedLookups': int(observed['transducer_lookups']),
            'lookupGradientObservations': int(observed['transducer_observed'])}


def inspect_run(training_run, consumer_root, tokenizer_json, *, maximum_windows=10000, timeout_seconds=120):
    start = time.monotonic()
    root, consumer, tokenizer = map(lambda value: Path(value).resolve(),
                                   (training_run, consumer_root, tokenizer_json))
    def check_deadline():
        require(time.monotonic() - start < timeout_seconds, 'Read-only profiling deadline exceeded')
    require(type(maximum_windows) is int and 1 <= maximum_windows <= 100000, 'Invalid window bound')
    require(0 < timeout_seconds <= 600, 'Invalid read-only profiling deadline')
    report_path, config_path, plan_path = (root / name for name in
                                         ('report.json', 'train-config.json', 'native-window-plan.json'))
    report, raw_config, plan = (json.loads(path.read_text()) for path in (report_path, config_path, plan_path))
    require(report.get('schema') == 'optimization-smoke/1' and report.get('status') == 'completed'
            and report.get('purpose') == 'diagnostic' and report.get('nativeWindowPlanMatched') is True,
            'A completed diagnostic with an actual matched native window plan is required')
    require(digest_file(config_path) == report['resolvedTrainingConfigSha256']
            and digest_file(plan_path) == report['nativeWindowPlanSha256'], 'Saved config/window plan bytes changed')
    require(plan.get('schema') == 'optimization-native-window-plan/1'
            and type(plan.get('requestedWindows')) is int
            and 1 <= plan['requestedWindows'] <= maximum_windows, 'Saved plan exceeds the explicit window bound')
    revision = subprocess.check_output(['git', '-C', str(consumer), 'rev-parse', 'HEAD'], text=True).strip()
    subprocess.run(['git', '-C', str(consumer), 'diff', '--quiet', 'HEAD', '--'], check=True)
    require(revision == report['consumerRevision'], 'Consumer revision differs from the actual training run')
    require(digest_file(tokenizer) == report['tokenizerSha256'], 'Tokenizer file differs from the actual training run')
    sys.path.insert(0, str(consumer / 'src'))
    from megatoken.data.schema import encode_episode
    from megatoken.data.storage import PreparedCorpus
    from megatoken.generation.codec import ByteCodec
    from megatoken.model.config import ModelConfig
    from megatoken.training.checkpoint import load_checkpoint
    from megatoken.training.config import TrainConfig
    from megatoken.training.engine import window_config
    from megatoken.training.stream import WindowStream
    import megatoken.training.stream as native_stream
    require(Path(native_stream.__file__).resolve().is_relative_to(consumer), 'Imported consumer is not the pinned checkout')
    config = TrainConfig.from_dict(raw_config)
    require(config.purpose == 'diagnostic' and config.phase == 'P1' and config.semantic_experiment is None
            and not config.use_stage_mixture and not config.use_effort_mixture and config.decoupled is None
            and config.max_accumulation_windows == 1 and config.microbatch_episodes == 1
            and config.navigation_weight == 0,
            'Only a single-rank, one-window-per-update diagnostic is metered')
    require(config.max_steps == plan['requestedWindows'] and len(plan['windows']) == config.max_steps,
            'Configuration and saved window count disagree')
    require(digest_file(config.codec) == report['tokenizerSha256'], 'Configured tokenizer differs')
    codec = ByteCodec.from_tokenizer_json(tokenizer, expected_sha256=report['tokenizerSha256'])
    require(codec.fingerprint == report['tokenizerIdentity'], 'Native tokenizer identity differs')
    checkpoint = Path(report['checkpointVerification']['checkpoint']).resolve()
    require((checkpoint / 'state.pt').is_file() and not list(checkpoint.glob('.superseded-*')),
            'A concrete immutable checkpoint directory without recovery state is required')
    payload, metadata = load_checkpoint(checkpoint)
    require(metadata['state_sha256'] == report['checkpointVerification']['stateSha256']
            and payload['train_config'] == raw_config and payload['codec_fingerprint'] == codec.fingerprint,
            'Actual checkpoint/config/tokenizer binding differs')
    require(type(payload['global_step']) is int and payload['global_step'] == config.max_steps,
            'Actual checkpoint step count differs from the saved diagnostic plan')
    require(len(payload['rank_state']) == 1, 'A single actual rank cursor is required')
    cursor = payload['rank_state'][0]['cursor']
    require(cursor.get('rank') == 0 and cursor.get('world_size') == 1,
            'Distributed cursors are outside this meter')
    require(cursor == plan['expectedFinalCursor'] == report['checkpointVerification']['nativeCursors'][0],
            'Actual checkpoint cursor differs from saved exposure')
    model_config = ModelConfig.from_dict(payload['model_config'])
    counters = dict(payload['counters'])
    del payload
    metrics_path = root / 'training/metrics.jsonl'
    metrics_binding = binding(metrics_path)
    metrics = [json.loads(line) for line in metrics_path.read_text().splitlines()]
    train_metrics = [row for row in metrics if row.get('event') == 'train']
    require([row['global_step'] for row in train_metrics] == list(range(1, config.max_steps + 1)),
            'Missing, duplicated or reordered actual training step metrics')
    require(train_metrics[-1]['counters'] == counters, 'Final logged counters differ from actual checkpoint')
    require(all(row.get('batch_sizes') == [1] for row in train_metrics), 'Observed training batch shape differs')
    require(all(row.get('generator', {}).get('causal_student_windows') == 1
                and not row.get('generator', {}).get('teacher_assisted_windows') for row in train_metrics),
            'Only actual causal-student windows without hindsight overlays are metered')
    resolved_window = window_config(config)
    require(asdict(resolved_window) == plan['resolvedWindowConfig'], 'Native window defaults changed')
    windows, contexts, manifests, source_counts = [], {}, [], Counter()
    with PreparedCorpus(config.datasets) as corpus:
        require(corpus.codec_fingerprint == codec.fingerprint, 'Prepared tokenizer differs')
        for part in corpus.parts:
            manifests.append(binding(part.root / 'manifest.json'))
            require(part.manifest['fingerprint'] == report['preparedFingerprint'], 'Prepared fingerprint differs')
        stream = WindowStream(corpus, codec, resolved_window, seed=config.seed)
        require(stream.fingerprint == cursor['dataset_fingerprint'] == metadata['dataset_fingerprint'],
                'Actual prepared/native stream fingerprint differs')
        for expected, metric in zip(plan['windows'], train_metrics, strict=True):
            check_deadline()
            item = stream.next()
            require(item is not None and item.episode.lineage.frozen_split == 'train', 'Unexpected padding or non-training episode')
            verify_window_identity(item, expected)
            if item.episode.episode_id not in contexts:
                contexts[item.episode.episode_id] = encode_episode(item.episode, codec)
            row = window_cost(item)
            derived = context_costs(item.episode, contexts[item.episode.episode_id], model_config,
                                    row['end'], start=row['start'])
            row['observedContext'] = verify_observed_context(derived, metric)
            row['contextGroups'] = [group for group in derived.pop('groups')
                                    if row['start'] <= group['start'] and group['end'] <= row['end']]
            row['nativeContext'] = derived
            windows.append(row)
            source_counts[item.episode.lineage.source_id] += 1
        require(stream.state_dict() == cursor, 'Reconstructed stream cursor differs from the actual checkpoint')
    summary = summarize(windows)
    totals = summary['totals']
    for native, measured in [('D', 'newTranscriptTokensD'), ('I', 'ingestedTranscriptTokensI'),
                             ('reconstruction_tokens', 'reconstructionTranscriptTokens'),
                             ('G', 'newPhysicalRecords'), ('reconstruction_records', 'reconstructionPhysicalRecords')]:
        require(counters[native] == totals[measured], 'Derived costs disagree with actual checkpoint meter ' + native)
    require(totals['scoredTokens'] == plan['expectedScoredTokens'] == report['supervisedLexicalTokens'],
            'Generated supervision differs from the actual run')
    require(dict(source_counts) == plan['expectedSourceWindows'] == cursor['sampled_source_windows'],
            'Source window exposure differs')
    require(summary['episodes'] == plan['expectedExamples'] and summary['families'] == plan['expectedFamilies'],
            'Prepared example/family coverage differs')
    for item in manifests:
        require(digest_file(item['path']) == item['sha256'], 'Prepared manifest changed during profiling')
    require(digest_file(metrics_path) == metrics_binding['sha256'], 'Actual training metrics changed during profiling')
    subprocess.run(['git', '-C', str(consumer), 'diff', '--quiet', 'HEAD', '--'], check=True)
    check_deadline()
    sources = ['data/packing.py', 'data/schema.py', 'data/context.py', 'training/engine.py',
               'training/stream.py', 'training/meridians.py', 'training/transducer.py',
               'model/context.py', 'model/multitrack.py', 'model/transducer.py', 'memory/transducer.py']
    return {'schema': 'native-window-context-costs/1', 'derived': True,
        'consumerRevision': revision, 'producerRevision': report['producerRevision'],
        'tokenizerIdentity': codec.fingerprint, 'tokenizer': binding(tokenizer),
        'inputs': {'report': binding(report_path), 'configuration': binding(config_path), 'plan': binding(plan_path),
                   'checkpointMetadata': binding(checkpoint / 'metadata.json'),
                   'checkpointStateSha256': metadata['state_sha256'], 'preparedManifests': manifests,
                   'actualTrainingMetrics': metrics_binding},
        'nativeImplementation': [binding(consumer / 'src/megatoken' / name) for name in sources],
        'profileImplementation': binding(__file__), 'sourceExposure': dict(source_counts),
        'streamFingerprint': cursor['dataset_fingerprint'], 'actualCursorAndCountersMatched': True,
        'configuredLimits': {'window': asdict(resolved_window),
            'historyEvents': model_config.max_history_chunks, 'facetsPerEvent': model_config.n_facets,
            'defaultLocalEvents': model_config.context_local_events,
            'defaultCrossEvents': model_config.context_cross_events,
            'generatedRecordPositions': config.generated_capacity},
        'summary': summary, 'windows': windows,
        'costOfThisReadOnlyPass': {'wallSeconds': time.monotonic() - start, 'maximumSeconds': timeout_seconds},
        'newOptimizerSteps': 0, 'newModelExecutions': 0, 'newAdmissions': 0,
        'limitations': ['Prepared historical text footprint is not a flat lexical model prompt or latent cache memory in bytes.',
            'Visible event/facet counts describe direct reads, not information already summarized in recurrent state.',
            'Native metadata and query/knowledge event chronology is included and checked against actual per-window metrics.',
            'Metadata tokens are unmeasured because the randomly dropped training fields were not logged; query/knowledge events have no lexical payload.',
            'Observed cache bytes are window-end measurements, not the maximum within-window allocation or process RSS.',
            'Track-description controls and within-record decoder state are separate from historical payload footprint.',
            'No previous producer difficulty fields, training results or admission receipts are rewritten.',
            'Only text teacher episodes without native action tapes and the declared single-rank diagnostic are supported.']}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--training-run', type=Path, required=True)
    parser.add_argument('--consumer-root', type=Path, required=True)
    parser.add_argument('--tokenizer-json', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--maximum-windows', type=int, default=10000)
    parser.add_argument('--timeout-seconds', type=float, default=120)
    args = parser.parse_args()
    output = args.out.resolve()
    require(not output.exists(), 'Output already exists; derived reports never overwrite evidence')
    for protected in (args.training_run.resolve(), args.consumer_root.resolve()):
        require(not output.is_relative_to(protected), 'Derived report must be outside immutable input roots')
    result = inspect_run(args.training_run, args.consumer_root, args.tokenizer_json,
                         maximum_windows=args.maximum_windows, timeout_seconds=args.timeout_seconds)
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open('x') as target:
        json.dump(result, target, indent=2, allow_nan=False)
        target.write('\n')
    print(json.dumps({'output': str(output), 'sha256': digest_file(output),
                      'summary': result['summary'], 'cost': result['costOfThisReadOnlyPass']}))


if __name__ == '__main__':
    main()
