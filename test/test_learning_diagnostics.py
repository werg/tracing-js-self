"""Synthetic diagnostic fixtures do not establish model or native qualification."""
import copy
import importlib.util
import json
import sys
from pathlib import Path
from types import SimpleNamespace, ModuleType
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('learning_diagnostics',
    Path(__file__).resolve().parents[1] / 'tools/learning_diagnostics.py')
D = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(D)


class ByteCodec:
    fingerprint = 'a' * 64
    def decode(self, ids): return bytes(ids)


def encoded(payload, generated=True):
    payload = payload.encode('utf-8')
    return SimpleNamespace(record=SimpleNamespace(payload=payload, policy_mask=generated,
        record_id='record1', logical_id='logical1', part_index=0, part_count=1,
        role='assistant' if generated else 'user'), token_ids=tuple(payload),
        free_mask=(generated,) * len(payload), codec_fingerprint='a' * 64,
        transcript_tokens=len(payload))


def probe(path):
    return {'schema': 'semantic-conditioning-probe/1', 'path': path,
            'identity': {key: 'a'*64 for key in
                         ('checkpointSha256', 'tokenizerIdentity', 'publicPrefixSha256', 'targetSha256')},
            'dropoutDisabled': True, 'inputTokenIds': [1, 2],
            'points': [{'head': 'lexical', 'position': 0, 'target': 1, 'scored': True,
                        'category': 'record-kind', 'logits': [-1.0, 2.0, 0.0]},
                       {'head': 'terminal', 'position': 0, 'target': 0, 'scored': True,
                        'category': 'terminal-structure', 'logits': [1.0, 0.0]}]}


class LearningDiagnosticsTests(unittest.TestCase):
    def test_exact_unicode_names_tagged_references_and_masks(self):
        value = encoded('bind {"name":"résultat","value":["ref","o1"],"invocation":"call1"}')
        audit = D.exact_record_audit(value, ByteCodec())
        self.assertEqual(bytes.fromhex(audit['payloadHex']), value.record.payload)
        self.assertEqual(b''.join(bytes.fromhex(t['hex']) for t in audit['tokens']), value.record.payload)
        self.assertEqual(len(audit['tokens']), len(value.record.payload))
        self.assertEqual(set(t['category'] for t in audit['tokens']),
                         {'record-kind', 'separator', 'json-key', 'json-structure', 'source-name',
                          'literal-value', 'reference-id'})
        self.assertIsNone(audit['structuralMask'])
        self.assertIsNone(audit['terminalMask'])
        self.assertTrue(all(audit['lexicalMask']))
        observed = D.exact_record_audit(encoded('{"input":7}', False), ByteCodec())
        self.assertFalse(any(observed['lexicalMask']))
        self.assertTrue(all(observed['observedMask']))

    def test_cross_category_tokens_are_not_falsely_assigned(self):
        value = encoded('return {"value":["num",7]}')
        value.token_ids = (1,)
        value.free_mask = (True,)
        codec = SimpleNamespace(fingerprint='a'*64, decode=lambda ids: value.record.payload)
        row = D.exact_record_audit(value, codec)['tokens'][0]
        self.assertEqual(row['category'], 'mixed')
        self.assertEqual(sum(row['categoryBytes'].values()), len(value.record.payload))

    def test_native_unfragmented_records_with_empty_logical_id_stay_separate(self):
        observed, generated = encoded('{"public":7}', False), encoded('return {"value":["num",7]}')
        observed.record.logical_id = generated.record.logical_id = ''
        observed.record.record_id, generated.record.record_id = 'context', 'target'
        rows = [observed, generated]
        episode = SimpleNamespace(episode_id='episode', records=[r.record for r in rows],
            lineage=SimpleNamespace(source_id='source', family_id='family', frozen_split='train'))
        class Corpus:
            identity = 'prepared'
            def __init__(self, *args): pass
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def iter_episodes(self): return iter([episode])
        schema, storage = ModuleType('schema'), ModuleType('storage')
        schema.encode_record = lambda record, codec: next(row for row in rows if row.record is record)
        storage.PreparedCorpus = Corpus
        with patch.dict(sys.modules, {'megatoken.data.schema': schema, 'megatoken.data.storage': storage}):
            audit = D.native_target_audit('/synthetic', ByteCodec())
            self.assertEqual([r['recordId'] for r in audit['episodes'][0]['records']], ['context', 'target'])
            self.assertEqual(audit['trainingServingParity']['status'], 'unmeasured')
            with self.assertRaisesRegex(ValueError, 'byte budget'):
                D.native_target_audit('/synthetic', ByteCodec(), maximum_bytes=1)

    def test_mask_bytes_codec_and_segment_drift_are_refused(self):
        value = encoded('return {"value":["num",7]}')
        for mutation, pattern in [
            (lambda v: setattr(v, 'free_mask', (False,) * len(v.token_ids)), 'fully supervised'),
            (lambda v: setattr(v, 'codec_fingerprint', 'b'*64), 'tokenizer'),
            (lambda v: setattr(v, 'token_ids', (0,)*len(v.token_ids)), 'reconstruct')]:
            changed = copy.deepcopy(value)
            mutation(changed)
            with self.assertRaisesRegex(ValueError, pattern): D.exact_record_audit(changed, ByteCodec())
        changed = encoded('context', False)
        changed.free_mask = (True,)*len(changed.token_ids)
        with self.assertRaisesRegex(ValueError, 'masked'): D.exact_record_audit(changed, ByteCodec())

    def test_fragment_accounting_is_explicit_and_complete_group_labels_can_be_supplied(self):
        fragment = encoded('bind {"name":')
        self.assertEqual(set(D.target_byte_categories(fragment.record.payload)), {'fragment-or-transport'})
        labels = D.target_byte_categories(b'bind {"name":"x","value":["num",7]}')
        exact = D.exact_record_audit(fragment, ByteCodec(), byte_categories=labels[:len(fragment.record.payload)])
        self.assertIn('json-key', {t['category'] for t in exact['tokens']})
        with self.assertRaisesRegex(ValueError, 'span'): D.exact_record_audit(fragment, ByteCodec(), byte_categories=[])

    def test_parity_checks_identity_tokens_masks_and_disabled_dropout(self):
        train, serve = probe('training'), probe('serving')
        result = D.compare_conditioning_probes(train, serve)
        self.assertEqual(result['status'], 'passed')
        self.assertEqual(result['training']['byHead']['lexical']['topKAccuracy']['1'], 1)
        for mutate, pattern in [
            (lambda p: p['identity'].update(checkpointSha256='b'*64), 'checkpoint'),
            (lambda p: p['inputTokenIds'].append(3), 'tokenization'),
            (lambda p: p.update(dropoutDisabled=False), 'dropout'),
            (lambda p: p['points'][0].update(scored=False), 'alignment'),
            (lambda p: p['points'][0].update(logits=[float('nan')]), 'finite')]:
            changed = copy.deepcopy(serve)
            mutate(changed)
            with self.assertRaisesRegex(ValueError, pattern): D.compare_conditioning_probes(train, changed)

    def test_parity_numerics_report_first_divergence_and_missing_is_not_pass(self):
        train, serve = probe('training'), probe('serving')
        serve['points'][0]['logits'][0] += 1e-7
        self.assertEqual(D.compare_conditioning_probes(train, serve)['status'], 'passed')
        serve['points'][0]['logits'][1] = -20
        result = D.compare_conditioning_probes(train, serve)
        self.assertEqual(result['status'], 'failed')
        self.assertEqual(result['firstDivergence']['tokenId'], 1)
        self.assertEqual(result['serving']['byCategory']['record-kind']['topKAccuracy']['1'], 0)
        self.assertEqual(D.compare_conditioning_probes(train, None)['status'], 'unmeasured')

    def test_conditional_metrics_keep_observed_positions_out_of_denominators(self):
        points = probe('training')['points']
        points.append({'head': 'lexical', 'position': 1, 'category': 'literal-value',
                       'target': 2, 'scored': False, 'logits': [1000, -1000, 0]})
        result = D.conditional_statistics(points)
        self.assertEqual(result['unscoredPositions'], 1)
        self.assertEqual(result['byHead']['lexical']['positions'], 1)
        self.assertNotIn('literal-value', result['byCategory'])
        points[0]['logits'] = [1000, -1000, 0]
        self.assertAlmostEqual(D.conditional_statistics(points)['byHead']['lexical']['meanCrossEntropy'], 2000)

    def test_original_failed_action_is_kept_and_unparsed_is_not_semantic_failure(self):
        raw = {'selectedEventId': 'first', 'payloadHex': b'wrong'.hex(), 'emittedTokenIds': [7, 8]}
        summary = {'id': 'case', 'origin': 'trained', 'wholeTaskSuccess': False,
                   'firstSemanticInconsistency': None,
                   'servingProfile': {'records': [{'operation': 'select', 'ok': False,
                     'failure': {'message': 'Model did not render one complete valid text action',
                                 'evidence': {'valid': [False], 'fragments': [raw]}}}]}}
        result = D.first_action_diagnosis(summary)
        self.assertEqual(result['firstFailureLayer'], 'native-action-rendering')
        self.assertIsNone(result['firstRecordSemanticsValid'])
        self.assertEqual(result['originalFragments'], [raw])
        self.assertEqual(result['originalEmittedTokens'], 2)
        self.assertEqual(summary['servingProfile']['records'][0]['failure']['evidence']['fragments'], [raw])

    def test_end_records_have_terminal_categories_and_duplicate_probes_fail(self):
        self.assertIn('terminal-structure', D.target_byte_categories(b'end {"kind":"return"}'))
        a, b = probe('training'), probe('serving')
        a['points'].append(a['points'][0].copy())
        with self.assertRaisesRegex(ValueError, 'Duplicate'): D.compare_conditioning_probes(a, b)


if __name__ == '__main__': unittest.main()
