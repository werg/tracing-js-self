"""Selection integrity tests; fixtures do not claim actual native admission."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from collections import Counter

spec = importlib.util.spec_from_file_location(
    'optimization_smoke', Path(__file__).resolve().parents[1] / 'tools/run-optimization-smoke.py')
smoke = importlib.util.module_from_spec(spec)
spec.loader.exec_module(smoke)


class SelectionIntegrity(unittest.TestCase):
    def test_registry_interning_is_lossless_and_only_combines_exact_equal_values(self):
        registry = {'schema': 'semantic-source-registry/1', 'members': ['a', 'b']}
        value = {'one': registry, 'two': json.loads(json.dumps(registry)),
                 'different': {'schema': 'semantic-source-registry/1', 'members': ['a']},
                 'ordinary': [{'number': -0.0}, ['undefined'], 'source text']}
        before = json.dumps(value)
        cache, counts = {}, Counter()
        result = smoke.intern_registries(value, cache, counts)
        self.assertEqual(json.dumps(result), before)
        self.assertIs(result['one'], result['two'])
        self.assertIsNot(result['one'], result['different'])
        self.assertEqual(len(cache), 2)
        self.assertEqual(counts['registryOccurrences'], 3)

    def make_corpus(self, root, name, rows, revision='1' * 40):
        directory = root / name
        directory.mkdir()
        (directory / 'manifest.json').write_text(json.dumps({
            'producerRevision': revision, 'counts': {'attempted': len(rows)}, 'cases': rows}))
        return directory

    def row(self, name, family, *, split='train', digest=None):
        return {'id': name, 'family': family, 'path': name + '.json',
                'status': 'admitted', 'split': split, 'episodeDigest': digest or name}

    def test_combines_families_without_duplicate_episodes_or_heldout_rows(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            a = self.make_corpus(root, 'a', [self.row('a1', 'alpha'), self.row('a2', 'alpha'),
                                            self.row('holdout', 'heldout', split='test')])
            b = self.make_corpus(root, 'b', [self.row('a1', 'alpha'), self.row('b1', 'beta'),
                                            self.row('c1', 'gamma')])
            inventory, selected = smoke.choose_candidates([a, b], 3)
            self.assertEqual([row['id'] for row, _ in selected], ['a1', 'b1', 'c1'])
            self.assertEqual(len(inventory['sources']), 2)

    def test_refuses_changed_revision_or_conflicting_identity(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            a = self.make_corpus(root, 'a', [self.row('a1', 'alpha')])
            b = self.make_corpus(root, 'b', [self.row('b1', 'beta')], revision='2' * 40)
            with self.assertRaisesRegex(ValueError, 'producer revision'):
                smoke.choose_candidates([a, b], 32)
            c = self.make_corpus(root, 'c', [self.row('a1', 'alpha', digest='changed')])
            with self.assertRaisesRegex(ValueError, 'different public bytes'):
                smoke.choose_candidates([a, c], 32)

    def test_refuses_paths_outside_the_materialized_corpus(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            row = self.row('a1', 'alpha'); row['path'] = '../outside.json'
            corpus = self.make_corpus(root, 'a', [row])
            with self.assertRaisesRegex(ValueError, 'escapes'):
                smoke.choose_candidates([corpus], 32)


if __name__ == '__main__':
    unittest.main()
