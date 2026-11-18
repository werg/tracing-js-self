"""Inspect real native adapter inputs before neural execution.

This runs the pinned data adapter/control resolver and serving adapter. A capture
endpoint records the serving adapter's actual observe_text/generate arguments
and stops before model execution. It neither emulates a model nor fabricates a
selection. Recurrent states, tokenizer segmentation and logits remain unmeasured.
"""
from __future__ import annotations

import argparse
from dataclasses import asdict
import hashlib
import json
from pathlib import Path
import subprocess
import sys
from threading import RLock
from types import SimpleNamespace


def sha(value):
    return hashlib.sha256(value).hexdigest()


class CapturedGeneration(BaseException):
    pass


class CaptureBoundary:
    def __init__(self, *, max_capacity):
        self.generator = SimpleNamespace(generator=SimpleNamespace(
            config=SimpleNamespace(max_capacity=max_capacity)))
        self.observations, self.generation, self.open_parameters = [], None, None

    def open(self, **kwargs):
        from megatoken.lifecycle import TrackRegistry
        self.open_parameters = kwargs
        return SimpleNamespace(tracks=TrackRegistry(max_active=8, max_waiting=16),
                               completed_events=set(), observations=[], selected_groups={},
                               tool_routes={}, lock=RLock())

    def track_action(self, session, operation, **kwargs):
        if operation != 'create': raise ValueError('Initial probe cannot mutate an existing track')
        return session.tracks.create(**kwargs)

    def observe_text(self, session, track, payload, **kwargs):
        self.observations.append({'track': track, 'role': kwargs['role'],
                                  'payloadHex': payload.hex(), 'payloadText': payload.decode('utf-8'),
                                  'sha256': sha(payload)})
        return len(self.observations)

    def generate(self, session, *, tracks, specs, controls, effort):
        self.generation = {'tracks': list(tracks), 'effort': effort,
            'specs': [asdict(spec) for spec in specs],
            'controls': [{'hex': control.hex(), 'text': control.decode('utf-8'),
                          'sha256': sha(control), 'bytes': len(control)} for control in controls],
            'trackDescriptions': [asdict(session.tracks.tracks[track]) for track in tracks]}
        raise CapturedGeneration()


def inspect_inputs(packet, *, max_capacity=1024, max_tokens=128):
    if packet.get('schema') != 'semantic-native-input-probe/1':
        raise ValueError('Fresh source-certified probe packet required')
    receipt = packet.get('sourceAdmission', {})
    if not all(receipt.get(key) is True for key in
               ['identityValidated', 'journalValidated', 'replayValidated', 'sourceValidated', 'effectsValidated']):
        raise ValueError('Input probe requires full fresh source/replay/identity evidence')
    exported = packet['exported']
    if receipt['identityDigest'] != exported['sidecar']['identityDigest']:
        raise ValueError('Probe source identity differs')
    public_bytes = packet['publicJson'].encode('utf-8')
    if (sha(public_bytes) != receipt['episodeDigest'] or
            json.loads(public_bytes) != exported['public']):
        raise ValueError('Public input changed after source certification')
    prefix = packet['prefix']
    if any(row['kind'] == 'semantic' for row in prefix['committed']):
        raise ValueError('This bounded probe stops at the first model prediction')
    initial = []
    for row in exported['public']['timeline']:
        if row['kind'] == 'semantic': break
        initial.append(row)
    if prefix['committed'] != initial or prefix['realmCommitted'] != initial:
        raise ValueError('Initial serving prefix differs from certified public training history')
    if not 1 <= max_tokens <= max_capacity <= 8192:
        raise ValueError('Invalid declared text action capacity')
    from megatoken.controls import resolve_event_control
    from megatoken.data.semantic_harness_v6 import adapt_selected_harness_v6
    from megatoken.semantic_model_adapter import SelectedSemanticInference
    episode, native = adapt_selected_harness_v6(exported, codec=None, allow_local=True,
        admission_verifier=lambda document: document['sidecar']['identityDigest'] == receipt['identityDigest'])
    first = next(row for row in episode.records if row.policy_mask)
    if first.payload.decode('utf-8') != packet['firstTarget']['record']:
        raise ValueError('Actual native first target differs from source-certified public record')
    event = next(event for group in episode.meridians for event in group.events if event.record_id == first.record_id)
    control = resolve_event_control(episode, event)
    before = list(episode.records[:episode.records.index(first)])
    boundary = CaptureBoundary(max_capacity=max_capacity)
    # Visibility verification depends on neural recurrent history. Disabling it
    # here is explicit and affects only that unmeasured layer, not the captured
    # serialization or control arguments at the actual serving adapter boundary.
    adapter = SelectedSemanticInference(boundary, max_tokens=max_tokens, verify_context=False)
    try:
        adapter.select(prefix)
    except CapturedGeneration:
        pass
    if boundary.generation is None: raise ValueError('Serving adapter did not reach the generation boundary')
    if len(boundary.generation['controls']) != 1: raise ValueError('One fresh prediction is required')
    observed = [{'recordId': row.record_id, 'role': row.role,
                 'payloadHex': row.payload.hex(), 'payloadText': row.payload.decode('utf-8'),
                 'sha256': sha(row.payload)} for row in before]
    serving = boundary.observations
    pairs = []
    for index in range(max(len(observed), len(serving))):
        a = observed[index] if index < len(observed) else None
        b = serving[index] if index < len(serving) else None
        pairs.append({'index': index, 'sameBytes': a is not None and b is not None and a['payloadHex'] == b['payloadHex'],
                      'sameJsonValue': a is not None and b is not None and
                          json.loads(a['payloadText']) == json.loads(b['payloadText']),
                      'trainingSha256': a['sha256'] if a else None,
                      'servingSha256': b['sha256'] if b else None})
    equal_control = control.hex() == boundary.generation['controls'][0]['hex']
    equal_observed = all(row['sameBytes'] for row in pairs)
    # A worker's declared purpose is also supplied to the native model. Equal
    # record bytes and control bytes alone do not establish the same conditions.
    selected_track = next(track for track in episode.tracks if track.track_id == event.track_id)
    serving_purposes = [
        row['purpose'] for row in boundary.generation['trackDescriptions']
    ]
    equal_purpose = (len(serving_purposes) == 1 and
                     selected_track.description == serving_purposes[0])
    return {'schema': 'semantic-native-input-parity/1',
        'status': 'passed' if equal_control and equal_observed and equal_purpose else 'failed',
        'scope': 'Actual data and serving adapter call arguments before neural execution',
        'sourceIdentityDigest': receipt['identityDigest'], 'sourceAdmission': receipt,
        'sourceCandidateAdmission': exported['sidecar']['admission'],
        'nativeAdmissionClaim': False, 'freshDirectCall': True,
        'controlBytesMatch': equal_control, 'observedRecordBytesMatch': equal_observed,
        'trackPurposeMatch': equal_purpose,
        'trainingTrackPurpose': selected_track.description,
        'servingTrackPurpose': serving_purposes[0] if len(serving_purposes) == 1 else None,
        'observedRecordComparisons': pairs,
        'training': {'control': {'hex': control.hex(), 'text': control.decode('utf-8'),
                                'sha256': sha(control), 'bytes': len(control)},
                     'observedRecords': observed, 'event': asdict(event),
                     'tracks': [asdict(track) for track in episode.tracks],
                     'firstTarget': packet['firstTarget'],
                     'dataAdapterReceipt': asdict(native), 'physicalChunking': 'unmeasured: codec not loaded'},
        'serving': {'observedRecords': serving, 'generation': boundary.generation,
                    'openParameters': boundary.open_parameters},
        'unmeasured': ['actual tokenizer IDs', 'recurrent history and track-state equivalence',
                       'checkpoint identity and conditional logits', 'effect of the mismatch on learning'],
        'visibilityVerification': 'not executed: neural context is outside this input-byte probe',
        'modelSelections': 0, 'optimizerSteps': 0,
        'interpretation': ('An input-byte mismatch is a conditioning-path defect to investigate. '
                           'It is not proof that the mismatch is the only cause of failed learning.')}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--consumer-root', type=Path, required=True)
    parser.add_argument('--episode', type=Path, required=True)
    parser.add_argument('--max-capacity', type=int, default=1024)
    parser.add_argument('--max-tokens', type=int, default=128)
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    if args.out.exists(): parser.error('Choose a new immutable output path')
    consumer = args.consumer_root.resolve()
    subprocess.run(['git', 'diff', '--quiet', 'HEAD', '--'], cwd=consumer, check=True)
    revision = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=consumer, text=True).strip()
    builder = Path(__file__).with_name('build-native-probe-input.mjs')
    packet = json.loads(subprocess.check_output(['node', str(builder), str(args.episode.resolve())],
                                               text=True, timeout=120))
    sys.path.insert(0, str(consumer / 'src'))
    result = inspect_inputs(packet, max_capacity=args.max_capacity, max_tokens=args.max_tokens)
    files = ['src/megatoken/data/semantic_harness_v6.py', 'src/megatoken/data/semantic_physical.py',
             'src/megatoken/controls.py', 'src/megatoken/semantic_model_adapter.py', 'src/megatoken/data/schema.py']
    result.update(consumerRevision=revision, episodeSha256=packet['episodeSha256'],
                  firstPublicPrefix=packet['prefix'],
                  inputBindings=[{'path': name, 'sha256': sha((consumer/name).read_bytes())} for name in files],
                  probeImplementationSha256=sha(Path(__file__).read_bytes()), prefixBuilderSha256=sha(builder.read_bytes()))
    with args.out.open('x') as output:
        json.dump(result, output, indent=2, ensure_ascii=False, allow_nan=False)
        output.write('\n')
    print(json.dumps({'status': result['status'], 'controlBytesMatch': result['controlBytesMatch'],
                      'observedRecordBytesMatch': result['observedRecordBytesMatch'],
                      'trackPurposeMatch': result['trackPurposeMatch'], 'modelSelections': 0, 'output': str(args.out)}))
    if result['status'] != 'passed': raise SystemExit(1)


if __name__ == '__main__': main()
