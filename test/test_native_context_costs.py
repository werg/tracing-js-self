"""Cost-contract fixtures; these tests are not model-performance evidence."""
import copy
from dataclasses import replace
import json
import os
from pathlib import Path
import sys
from types import SimpleNamespace

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tools'))
sys.path.insert(0, str(Path(os.environ.get('MEGATOKEN_ROOT', ROOT.parent / 'megatoken')) / 'src'))
pytest.importorskip('megatoken')
from megatoken.data.schema import EncodedRecord, Meridian, PhysicalRecord, TrackEvent
from megatoken.data.packing import TrainingWindow
from megatoken.model.config import METADATA_TRACK, TRANSDUCER_QUERY_TRACK
import native_context_costs as costs


def fixture(groups, *, annotations=None, stream='semantic_execution'):
    """Construct different transcript/likelihood meters to detect conflation."""
    rows, meridians = [], []
    for index, group in enumerate(groups):
        events = []
        for entry in group:
            name, track, role, positions, transcript = entry[:5]
            payload = entry[5] if len(entry) > 5 else name.encode()
            record = PhysicalRecord(name, role, payload, policy_mask=role == 'assistant')
            rows.append(EncodedRecord(record, tuple(range(positions)),
                                      (record.policy_mask,) * positions, 'fixture', transcript))
            events.append(TrackEvent(name, track, 'text', index, role))
        meridians.append(Meridian(index, tuple(events)))
    episode = SimpleNamespace(records=tuple(row.record for row in rows), meridians=tuple(meridians),
        stream=stream, episode_id='episode', lineage=SimpleNamespace(source_id='source', family_id='family'),
        supervision=SimpleNamespace(annotations_json=json.dumps(annotations or {
            'semantic_execution': {'continuation': 'teacher_conditioned'}})))
    return episode, tuple(rows)


def model(**updates):
    return SimpleNamespace(**({'context_local_events': 256, 'context_cross_events': 16,
        'max_history_chunks': 1024, 'n_facets': 4, 'transducer_max_lookups': 256} | updates))


def test_exact_internal_events_are_included_without_inventing_metadata_tokens():
    episode, rows = fixture([[('input', 'a', 'user', 3, 7)], [('answer', 'b', 'assistant', 2, 5)]])
    report = costs.context_costs(episode, rows, model(), 2)
    reader = report['groups'][1]['readers'][0]
    assert report['plannedLookups'] == 2
    assert report['finalRetainedEvents'] == report['nativeCommittedEvents'] == 7
    assert reader['directHistoryEvents'] == 6
    assert reader['directHistoryFacetSlots'] == 24
    assert reader['visiblePreparedPayloadTokenIds'] == 3
    assert reader['visiblePreparedTranscriptTokens'] == 7
    assert reader['visibleMetadataEvents'] == 1
    assert reader['visibleLatentRetrievalEvents'] == 4
    assert report['metadataPayloadTokenIds'] is None


def test_simultaneous_generated_peers_are_not_historical_context():
    episode, rows = fixture([[('input', 'a', 'user', 3, 7)],
        [('answer-a', 'a', 'assistant', 2, 5), ('answer-b', 'b', 'assistant', 50, 90)]])
    report = costs.context_costs(episode, rows, model(), 3)
    for reader in report['groups'][1]['readers']:
        assert reader['directHistoryEvents'] == 6
        assert reader['visiblePreparedPayloadTokenIds'] == 3
        assert not {'answer-a', 'answer-b'}.intersection(reader['visibleEventIds'])
    assert report['groups'][1]['unionDirectHistoryEvents'] == 6
    with pytest.raises(ValueError, match='splits a native meridian'):
        costs.context_costs(episode, rows, model(), 2)


def test_track_local_context_is_not_evicted_by_foreign_traffic_or_counted_as_prefix_sum():
    episode, rows = fixture([[('a0', 'a', 'user', 3, 7)], [('b0', 'b', 'user', 40, 50)],
                            [('b1', 'b', 'user', 60, 80)], [('a1', 'a', 'assistant', 2, 5)]])
    report = costs.context_costs(episode, rows, model(context_local_events=1, context_cross_events=0), 4)
    reader = report['groups'][-1]['readers'][0]
    assert reader['visibleEventIds'] == ['a0']
    assert reader['visiblePreparedPayloadTokenIds'] == 3
    assert reader['directHistoryFacetSlots'] == 4


def test_native_budget_reclaims_whole_peer_groups():
    episode, rows = fixture([[('a', 'a', 'user', 3, 7), ('b', 'b', 'user', 4, 8)],
                            [('c', 'c', 'assistant', 2, 5)]])
    report = costs.context_costs(episode, rows, model(max_history_chunks=3), 3)
    reader = report['groups'][-1]['readers'][0]
    assert not {'a', 'b'}.intersection(reader['visibleEventIds'])
    assert report['maximumRetainedEvents'] <= 3


def test_prefix_lookup_reconstruction_is_separate_from_gradient_observations():
    episode, rows = fixture([[('input', 'a', 'user', 3, 7)], [('answer', 'b', 'assistant', 2, 5)]])
    report = costs.context_costs(episode, rows, model(), 2, start=1)
    assert report['plannedLookups'] == 2
    assert report['scoredLookups'] == report['reconstructedLookups'] == 1
    metric = {'generator': {'context_windows': 1, 'context_retained_events_sum': 7,
        'context_cache_bytes_sum': 3584, 'transducer_lookups': 2, 'transducer_observed': 1}}
    assert costs.verify_observed_context(report, metric)['lookupGradientObservations'] == 1


def announcement(pins):
    return json.dumps({'context_window': {'local_events': 2, 'cross_events': 2,
                                         'pinned_events': pins}}).encode()


def test_native_pin_capacity_failure_is_not_reported_as_a_measured_context():
    episode, rows = fixture([[('a', 'a', 'user', 3, 7)],
        [('policy', 'b', 'system', 4, 8, announcement(['a'])), ('answer', 'c', 'assistant', 2, 5)]])
    with pytest.raises(ValueError, match='cannot retain pinned'):
        costs.context_costs(episode, rows, model(max_history_chunks=2), 3)


def test_same_meridian_pin_is_refused_by_native_validator():
    episode, rows = fixture([[('policy', 'a', 'system', 3, 7, announcement(['answer'])),
                             ('answer', 'b', 'assistant', 2, 5)]])
    with pytest.raises(ValueError, match='earlier group'):
        costs.context_costs(episode, rows, model(), 2)


@pytest.mark.parametrize('annotation', [{'native_action_tapes': [{}]}, {'retrieval': {'collections': ['x']}},
                                       {'semantic_execution': {'continuation': 'sampled'}}])
def test_unmodeled_runtime_chronology_is_refused(annotation):
    episode, rows = fixture([[('a', 'a', 'assistant', 3, 7)]], annotations=annotation)
    with pytest.raises(ValueError):
        costs.context_costs(episode, rows, model(), 1)


@pytest.mark.parametrize('track', [METADATA_TRACK, TRANSDUCER_QUERY_TRACK])
def test_physical_track_cannot_shadow_reserved_context(track):
    episode, rows = fixture([[('a', track, 'assistant', 3, 7)]])
    with pytest.raises(ValueError, match='shadow internal'):
        costs.context_costs(episode, rows, model(), 1)


def test_media_features_are_not_counted_as_text_tokens():
    episode, rows = fixture([[('a', 'a', 'assistant', 3, 7)]])
    changed = replace(rows[0].record, media_type='image/png')
    rows = (replace(rows[0], record=changed),)
    episode.records = (changed,)
    with pytest.raises(ValueError, match='Media features'):
        costs.context_costs(episode, rows, model(), 1)


def test_window_units_and_tampered_native_plan_are_distinct():
    episode, rows = fixture([[('a', 'a', 'user', 3, 7)], [('b', 'b', 'assistant', 2, 5)]])
    item = SimpleNamespace(episode=episode, window=TrainingWindow(episode, rows[:1], rows[1:], 1, 2, 1))
    report = costs.window_cost(item)
    assert report['newTranscriptTokensD'] == 5
    assert report['reconstructionTranscriptTokens'] == 7
    assert report['ingestedTranscriptTokensI'] == 12
    assert report['newLikelihoodPositions'] == report['scoredTokens'] == 2
    assert report['reconstructionLikelihoodPositions'] == 3
    assert report['newPayloadBytes'] == 1
    expected = costs.window_identity(item)
    costs.verify_window_identity(item, expected)
    expected['recordIds'] = ['a']
    with pytest.raises(ValueError, match='exact plan'):
        costs.verify_window_identity(item, expected)


@pytest.mark.parametrize('field,value', [('context_retained_events_sum', 5), ('transducer_lookups', 3),
                                        ('transducer_observed', 1), ('context_cache_bytes_sum', False)])
def test_actual_context_metric_mismatch_fails_closed(field, value):
    derived = {'finalRetainedEvents': 7, 'plannedLookups': 2, 'scoredLookups': 2}
    metric = {'generator': {'context_windows': 1, 'context_retained_events_sum': 7,
        'context_cache_bytes_sum': 3584, 'transducer_lookups': 2, 'transducer_observed': 2}}
    assert costs.verify_observed_context(derived, metric) == {'retainedEvents': 7, 'cacheBytes': 3584,
        'plannedLookups': 2, 'lookupGradientObservations': 2}
    tampered = copy.deepcopy(metric)
    tampered['generator'][field] = value
    with pytest.raises(ValueError):
        costs.verify_observed_context(derived, tampered)
