"""Synthetic protocol fixtures only; these tests never claim model learning."""
import importlib.util
import hashlib
import json
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
SPEC = importlib.util.spec_from_file_location('pure_runner', Path(__file__).resolve().parents[1] / 'run-pure-output-transfer.py')
PURE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PURE)


class PureOutputProtocolTests(unittest.TestCase):
    def test_duplicate_and_non_json_values_remain_invalid_original_bytes(self):
        for raw in [b'{"kind":"return","kind":"throw"}', b'{"value":NaN}']:
            with self.assertRaises(ValueError):
                PURE.strict_json(raw)

    def test_actual_original_emissions_bind_request_identity_tokens_and_bytes(self):
        codec = SimpleNamespace(fingerprint='codec', decode=lambda ids: bytes(ids))
        fields = ['source', 'entry', 'inputGraph', 'randomSeed', 'completionPolicy', 'outputContract']
        public = {'source': 'function run(){return 7}', 'entry': 'run', 'inputGraph': {'roots': [], 'objects': []},
                  'randomSeed': None, 'completionPolicy': 'await-returned-promise', 'outputContract': 'pure-observable-outcome/1'}
        case = {'id': 'case', 'envelope': {'decoderSeed': 17, **public}}
        public_sha = hashlib.sha256(json.dumps(public, ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()
        policy = {'tokenizerSha256': 'tokenizer', 'consumerRevision': 'consumer'}
        response = {'schema': 'semantic-pure-model-response/1', 'caseId': 'case', 'requestSha256': 'request',
            'checkpointIdentity': 'weights', 'decoderSeed': 17, 'tokenizerIdentity': 'codec',
            'tokenizerSha256': 'tokenizer', 'origin': 'actual-native-model', 'consumerRevision': 'consumer',
            'javascriptExecutedAtInference': False, 'teacherTraceProvided': False,
            'generation': {'maxTokens': 8}, 'payloadHex': '6f6b',
            'modelInputSha256': public_sha, 'modelInputFields': fields, 'routingMetadataInModelContext': False,
            'emissions': [{'selectedEventId': 'one', 'emittedTokenIds': [111, 107], 'payloadHex': '6f6b'}]}
        kwargs = dict(checkpoint='weights', policy=policy, maximum=8, case=case)
        self.assertEqual(PURE.original_tokens(response, codec, 'request', **kwargs), (b'ok', 2))
        for change in [{'requestSha256': 'different'}, {'checkpointIdentity': 'different'},
                       {'teacherTraceProvided': True}, {'javascriptExecutedAtInference': True},
                       {'payloadHex': '6e6f'}, {'generation': {'maxTokens': 100}}, {'routingMetadataInModelContext': True}]:
            with self.assertRaises(ValueError):
                PURE.original_tokens({**response, **change}, codec, 'request', **kwargs)
        response['emissions'][0]['emittedTokenIds'] = [0]
        with self.assertRaisesRegex(ValueError, 'do not decode'):
            PURE.original_tokens(response, codec, 'request', **kwargs)

    def test_repeated_variants_do_not_dominate_pure_output_score(self):
        rows = [{'sourceCluster': 'many', 'wholeTaskSuccess': True, 'validOutput': True,
                 'wallSeconds': 1, 'generatedTokens': 10} for _ in range(10)]
        rows.append({'sourceCluster': 'single', 'wholeTaskSuccess': False, 'validOutput': False,
                     'wallSeconds': 2, 'generatedTokens': None})
        score = PURE.metrics(rows)
        self.assertEqual(score['familyWeightedWholeTaskSuccess'], 0.5)
        self.assertEqual(score['episodeWeightedWholeTaskSuccess'], 10 / 11)
        self.assertIsNone(score['generatedTokens'])
        self.assertEqual(score['retainedGeneratedTokensLowerBound'], 100)


if __name__ == '__main__':
    unittest.main()
