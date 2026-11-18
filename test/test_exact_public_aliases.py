"""Only private task IDs may differ in an otherwise identical native episode."""
import copy
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('native_aliases',
    Path(__file__).resolve().parents[1] / 'tools/verify-exact-public-aliases.py')
aliases = importlib.util.module_from_spec(spec)
spec.loader.exec_module(aliases)


class CompleteNativeEquivalence(unittest.TestCase):
    def setUp(self):
        self.episode = {'episode_id': 'semantic:example',
            'lineage': {'task_id': 'candidate-a', 'family_id': 'family',
                        'ancestor_ids': ['family', 'ancestor'], 'parent_episode_id': None,
                        'source_id': 'source', 'revision': 'revision', 'frozen_split': 'train'},
            'records': [{'payload': 'original-bytes', 'policy_mask': True, 'provenance': 'teacher'}],
            'dependencies': [], 'tracks': [{'id': 'track'}], 'supervision': {'outcome': 'success'}}

    def test_task_alias_passes_without_mutating_either_episode(self):
        other = copy.deepcopy(self.episode); other['lineage']['task_id'] = 'candidate-b'
        before = copy.deepcopy(other)
        aliases.require_equivalent(self.episode, other)
        self.assertEqual(other, before)
        self.assertEqual(self.episode['lineage']['task_id'], 'candidate-a')

    def test_native_family_ancestors_parent_split_and_revision_cannot_differ(self):
        for field, value in [('family_id', 'other'), ('ancestor_ids', ['family', 'other']),
                             ('ancestor_ids', ['ancestor', 'family']), ('parent_episode_id', 'parent'),
                             ('frozen_split', 'test'), ('revision', 'other'), ('task_revision', 'new-native-field')]:
            with self.subTest(field=field):
                other = copy.deepcopy(self.episode); other['lineage'][field] = value
                with self.assertRaisesRegex(ValueError, 'beyond lineage.task_id'):
                    aliases.require_equivalent(self.episode, other)

    def test_every_record_mask_provenance_and_causal_field_is_retained(self):
        for field, value in [('payload', 'different-bytes'), ('policy_mask', False), ('provenance', 'student')]:
            with self.subTest(field=field):
                other = copy.deepcopy(self.episode); other['records'][0][field] = value
                with self.assertRaises(ValueError):
                    aliases.require_equivalent(self.episode, other)
        other = copy.deepcopy(self.episode); other['dependencies'] = [{'writer': 'a', 'reader': 'b'}]
        with self.assertRaises(ValueError):
            aliases.require_equivalent(self.episode, other)

    def test_boolean_and_integer_masks_are_not_equivalent(self):
        other = copy.deepcopy(self.episode); other['records'][0]['policy_mask'] = 1
        with self.assertRaises(ValueError):
            aliases.require_equivalent(self.episode, other)


if __name__ == '__main__':
    unittest.main()
