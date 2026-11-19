"""Actual native pre-sampling conditional capture and finite-vector comparison.

The hook runs the real trainer or serving runtime until its actual
MultiTrackGenerator._sample_policy boundary, records the already computed
Gaussian, then stops before its facet draw or target encoding. It supplies no model
choice, teacher continuation, replacement state, or successful execution.
"""
from __future__ import annotations

from contextlib import ExitStack
import ast
from dataclasses import asdict
import hashlib
import json
import math
from pathlib import Path
from unittest.mock import patch

SCHEMA = 'semantic-native-conditional-capture/2'
RAW_DECODER_SOURCE_SHA256 = '676cb1fd344aac3d9579cb30b4136f4d1609930e0c767dbf76c5ef89b920cc12'


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False,
                                    separators=(',', ':'), allow_nan=False).encode()).hexdigest()


def require(condition, message):
    if not condition: raise ValueError(message)


def require_checkpoint_hash(actual, expected, *, origin):
    """Bind every actual load/export to the first authenticated checkpoint state."""
    require(all(isinstance(value, str) and len(value) == 64 and
                all(char in '0123456789abcdef' for char in value)
                for value in (actual, expected)),
            f'{origin} requires exact checkpoint SHA-256 identities')
    require(actual == expected, f'{origin} checkpoint identity differs from pinned checkpoint')


class NativeConditionalCaptured(BaseException):
    """Stop before the Gaussian facet draw; deliberately not an ordinary model error."""


def tensor_record(value, *, maximum_elements=1048576, allow_empty=False):
    import torch
    require((0 if allow_empty else 1) <= value.numel() <= maximum_elements,
            'Native conditional tensor exceeds capture budget')
    require(bool(torch.isfinite(value).all()), 'Actual native conditional tensor is not finite')
    tensor = value.detach().cpu().float().contiguous()
    raw = tensor.numpy().tobytes()
    return {'shape': list(value.shape), 'sourceDtype': str(value.dtype),
            'storedDtype': 'float32', 'float32Sha256': hashlib.sha256(raw).hexdigest(),
            'values': tensor.reshape(-1).tolist()}


def recurrent_state_record(state, prediction):
    """Retain the actual recurrent tensors, including empty startup histories.

    Addresses and chronology are retained separately in ``boundary``. No track
    remapping or state reconstruction is performed by this measurement.
    """
    tensors = {'raw': state.raw, 'final': state.final,
               'historyKeys': state.history.keys, 'historyValues': state.history.values,
               'historyMask': state.history.mask, 'historyTrackIds': state.history_tracks,
               'frontierRoles': state.frontier_roles, 'prediction': prediction}
    if state.adapters is not None:
        tensors.update(adapterLogits=state.adapters.logits,
                       adapterStrength=state.adapters.strength,
                       adapterContext=state.adapters.context)
    return {name: None if value is None else tensor_record(value, allow_empty=True)
            for name, value in tensors.items()}


def compare_recurrent_states(training, serving, *, atol=1e-6, rtol=1e-5):
    """Compare captured state without substituting equal inputs for equal state."""
    left, right = training.get('recurrentState'), serving.get('recurrentState')
    if left is None or right is None:
        return {'status': 'unmeasured', 'reason': 'Both actual recurrent states are required'}
    require(math.isfinite(atol) and math.isfinite(rtol) and 0 <= atol <= .001 and 0 <= rtol <= .001,
            'Native parity tolerance must be finite, nonnegative and at most 0.001')
    first, maximum, count = None, 0.0, 0
    for field in sorted(set(left) | set(right)):
        a, b = left.get(field), right.get(field)
        if a is None or b is None:
            if a != b or (field in left) != (field in right):
                first = first or {'field': field, 'reason': 'presence'}
            continue
        for value in (a, b):
            require(isinstance(value.get('shape'), list) and
                    all(type(n) is int and n >= 0 for n in value['shape']) and
                    math.prod(value['shape']) == len(value.get('values', [])) <= 1048576 and
                    all(type(n) in (int, float) and math.isfinite(n) for n in value['values']),
                    'Actual recurrent tensor shape or finite values invalid')
        if a['shape'] != b['shape'] or a.get('sourceDtype') != b.get('sourceDtype'):
            first = first or {'field': field, 'reason': 'shape-or-dtype',
                              'trainingShape': a['shape'], 'servingShape': b['shape']}
            continue
        for index, (x, y) in enumerate(zip(a['values'], b['values'], strict=True)):
            difference = abs(x - y); maximum = max(maximum, difference); count += 1
            if difference > atol + rtol * abs(x):
                first = first or {'field': field, 'flatIndex': index, 'training': x,
                                  'serving': y, 'absoluteDifference': difference}
    return {'status': 'passed' if first is None else 'failed',
            'comparedCoordinates': count, 'maximumAbsoluteDifference': maximum,
            'firstDivergence': first, 'absoluteTolerance': atol, 'relativeTolerance': rtol,
            'scope': 'Actual frontier, history, adapter, and prospective prediction tensors'}


def capture_prior(operation, model, *, path, identity, maximum_input_bytes=16777216,
                  execute_decoder=False):
    """Run real native code and intercept the first Gaussian facet draw."""
    import torch
    from megatoken.model.core import FacetedCore
    from megatoken.model.multitrack import MultiTrackCore, MultiTrackGenerator
    from megatoken.multitrack_runtime import MultiTrackRuntime
    require(path in ('training', 'serving'), 'Unknown native conditional path')
    require(all(not module.training for module in model.modules()), 'All native modules must have dropout disabled')
    result = {'schema': SCHEMA, 'path': path, 'identity': identity, 'dropoutDisabled': True,
              'modelSelections': 0, 'optimizerSteps': 0, 'encoderCalls': [], 'modalityCalls': [], 'boundary': None}
    observed_bytes = 0
    original_encode = FacetedCore.encode_chunk
    original_control = FacetedCore.encode_control
    original_prior = MultiTrackGenerator._prior
    original_modality = MultiTrackCore.modality_logits
    original_train = MultiTrackGenerator.supervised_meridian
    original_generate = MultiTrackRuntime.generate
    original_sample = MultiTrackGenerator._sample_policy
    if execute_decoder:
        from megatoken.generation.decoder import DeterministicDecoder
        from native_decoder_capture import observe_decoder, emission_scoring_replay
        original_teacher = DeterministicDecoder.teacher_raw
        original_render = DeterministicDecoder.forward

    def encoded(kind, original):
        def capture(core, values, lengths=None, **kwargs):
            nonlocal observed_bytes
            sizes = [values.shape[1]] * values.shape[0] if lengths is None else lengths.detach().cpu().tolist()
            payloads = []
            for row, size in zip(values.detach().cpu().tolist(), sizes, strict=True):
                require(type(size) is int and 0 <= size <= len(row), 'Actual native encoder byte length is invalid')
                data = bytes(row[:size]); observed_bytes += len(data)
                require(observed_bytes <= maximum_input_bytes, 'Actual native encoder input exceeds capture byte budget')
                payloads.append({'hex': data.hex(), 'sha256': hashlib.sha256(data).hexdigest(),
                                 'bytes': len(data), 'text': data.decode('utf-8', errors='replace')})
            result['encoderCalls'].append({'operation': kind, 'payloads': payloads,
                'trackIds': kwargs['track_ids'].detach().cpu().tolist() if kwargs.get('track_ids') is not None else None,
                'trackSemantics': tensor_record(kwargs['track_semantics']) if kwargs.get('track_semantics') is not None else None})
            return original(core, values, lengths, **kwargs)
        return capture

    def modality(core, state, tracks, control=None, legal=None):
        logits = original_modality(core, state, tracks, control, legal)
        if core.core is model.core:
            rows = []
            for row in logits.detach().float().reshape(-1, logits.shape[-1]):
                support = torch.isfinite(row).nonzero().reshape(-1)
                require(support.numel() > 0, 'Actual native modality support is empty')
                values = row.index_select(0, support)
                rows.append({'support': support.cpu().tolist(),
                             'logits': values.cpu().tolist(),
                             'probabilities': values.softmax(-1).cpu().tolist()})
            result['modalityCalls'].append({
                'tracks': list(tracks),
                'legalMask': None if legal is None else legal.detach().cpu().tolist(),
                'rows': rows,
            })
        return logits

    def prior(multi, mean, state, tracks, control=None):
        require(result['boundary'] is None, 'Unexpected earlier native generated policy boundary')
        result['recurrentState'] = recurrent_state_record(state, mean)
        result['boundary'] = {'tracks': list(tracks), 'modelVersion': state.model_version,
            'trackRegistry': list(state.track_registry), 'trackDescriptions': list(state.track_descriptions),
            'eventsSeen': state.events_seen.detach().cpu().tolist(),
            'meridiansSeen': state.meridians_seen.detach().cpu().tolist(),
            'historyEventIds': list(state.history_event_ids), 'historyTracks': list(state.history_event_tracks),
            'historyPositions': list(state.history_positions), 'contextDropped': list(state.context_dropped),
            'frontierTracks': list(state.frontier_tracks),
            'frontierEventIds': list(state.frontier_event_ids),
            'frontierModalities': list(state.frontier_modalities),
            'meridianSizes': list(state.meridian_sizes), 'contextSeen': state.context_seen,
            'contextPolicy': json.loads(state.context_policy.to_json()),
            'encodedControl': tensor_record(control) if control is not None else None}
        return original_prior(multi, mean, state, tracks, control)

    def sample(distribution, names, generator):
        require(result['boundary'] is not None and 'conditional' not in result,
                'Native capture did not pass through the real prior boundary')
        result['conditional'] = {'eventIds': list(names), 'mean': tensor_record(distribution.mean),
                                 'logScale': tensor_record(distribution.log_scale)}
        result['policyInputEncoderCallCount'] = len(result['encoderCalls'])
        if execute_decoder:
            selected = original_sample(distribution, names, generator)
            result['actualSampledFacets'] = tensor_record(selected)
            return selected
        raise NativeConditionalCaptured()

    def teacher(decoder, core, context, plan):
        if path != 'training' or decoder is not model.decoder:
            return original_teacher(decoder, core, context, plan)
        with observe_decoder(model) as heads:
            losses = original_teacher(decoder, core, context, plan)
        result['decoderExecution'] = {'path': 'actual-prior-teacher', **heads,
            'losses': {name: {'sum': float(value.detach()), 'count': count}
                       for name, (value, count) in losses.items()}}
        raise NativeConditionalCaptured()

    def render(decoder, core, context, spec, teacher=None):
        if path != 'serving' or decoder is not model.decoder:
            return original_render(decoder, core, context, spec, teacher)
        with observe_decoder(model) as heads:
            action = original_render(decoder, core, context, spec, teacher)
        result['decoderExecution'] = {'path': 'actual-renderer', **heads,
            'originalEmission': {'payloadHex': action.payload.hex(),
                'tokenIds': list(action.emitted_ids), 'terminal': action.terminal,
                'valid': action.valid, 'error': action.error}}
        result['decoderScoringReplay'] = emission_scoring_replay(model, context, spec, action, heads)
        raise NativeConditionalCaptured()

    def train(multi, state, **kwargs):
        result['trainingCall'] = {'tracks': list(kwargs['tracks']),
            'eventIds': list(kwargs['event_ids']), 'effort': kwargs['effort'],
            'teacherForcedContinuation': kwargs['teacher_forced_action'],
            'controlHex': [value.hex() for value in kwargs['control_payloads']],
            'targetPlans': [{'ids': [list(row) for row in plan.ids],
                             'freeMasks': [list(row) for row in plan.free_masks],
                             'terminals': list(plan.terminals), 'capacities': list(plan.capacities),
                             'modeSpecs': [None if value is None else asdict(value)
                                           for value in plan.mode_specs],
                             'payloadHex': [value.hex() for value in plan.payloads]}
                            for plan in kwargs['plans']]}
        return original_train(multi, state, **kwargs)

    def generate(runtime, session, **kwargs):
        result['servingCall'] = {'tracks': list(kwargs['tracks']), 'effort': kwargs['effort'],
            'controlHex': [value.hex() for value in kwargs['controls']],
            'specs': [asdict(value) for value in kwargs['specs']]}
        return original_generate(runtime, session, **kwargs)

    with ExitStack() as stack:
        stack.enter_context(patch.object(FacetedCore, 'encode_chunk', encoded('encode_chunk', original_encode)))
        stack.enter_context(patch.object(FacetedCore, 'encode_control', encoded('encode_control', original_control)))
        stack.enter_context(patch.object(MultiTrackCore, 'modality_logits', modality))
        stack.enter_context(patch.object(MultiTrackGenerator, '_prior', prior))
        stack.enter_context(patch.object(MultiTrackGenerator, '_sample_policy', staticmethod(sample)))
        stack.enter_context(patch.object(MultiTrackGenerator, 'supervised_meridian', train))
        stack.enter_context(patch.object(MultiTrackRuntime, 'generate', generate))
        if execute_decoder:
            stack.enter_context(patch.object(DeterministicDecoder, 'teacher_raw', teacher))
            stack.enter_context(patch.object(DeterministicDecoder, 'forward', render))
        with torch.no_grad():
            try: operation()
            except NativeConditionalCaptured: pass
            else: raise ValueError('Native path returned without the declared conditional capture boundary')
    require('conditional' in result, 'Native conditional state was not captured')
    boundary = result.pop('policyInputEncoderCallCount')
    result['postPolicyEncoderCalls'] = result['encoderCalls'][boundary:]
    result['encoderCalls'] = result['encoderCalls'][:boundary]
    result['encoderCallSha256'] = digest(result['encoderCalls'])
    # This flag names the Gaussian policy draw, not earlier modality categoricals.
    result['capturedBeforePolicyDraw'] = not execute_decoder
    result['capturedBeforeTrainingTargetEncoding'] = path == 'training' and not execute_decoder
    result['decoderExecuted'] = execute_decoder and 'decoderExecution' in result
    if execute_decoder:
        require(result['decoderExecuted'], 'Actual first native decoder was not reached')
    result['scope'] = ('First generated event Gaussian, actual sampled facets, and native decoder execution; '
                      'no returned semantic selection or optimizer step' if execute_decoder else
                      'First generated event conditional Gaussian before its facet draw; no lexical realization, returned semantic selection or optimizer step')
    return result


def compare_priors(training, serving, *, atol=1e-6, rtol=1e-5):
    """Equal public/checkpoint identities first; then original finite model tensors."""
    if training is None or serving is None:
        return {'status': 'unmeasured', 'reason': 'Both real native conditional captures are required'}
    require(type(atol) in (int, float) and type(rtol) in (int, float) and
            math.isfinite(atol) and math.isfinite(rtol) and 0 <= atol <= .001 and 0 <= rtol <= .001,
            'Native parity tolerance must be finite, nonnegative and at most 0.001')
    for value, path in ((training, 'training'), (serving, 'serving')):
        require(value.get('schema') == SCHEMA and value.get('path') == path and
                value.get('dropoutDisabled') is True and
                (value.get('capturedBeforePolicyDraw') is True or value.get('decoderExecuted') is True) and
                value.get('modelSelections') == 0 and value.get('optimizerSteps') == 0,
                'Original disabled-dropout pre-sampling capture before the Gaussian facet draw required')
        require(all(isinstance(v, str) and len(v) == 64 and all(c in '0123456789abcdef' for c in v)
                    for v in value.get('identity', {}).values()) and
                set(value.get('identity', {})) == {'checkpointStateSha256', 'servedModelSha256', 'tokenizerIdentity',
                                                   'publicPrefixSha256', 'firstTargetSha256'},
                'Exact checkpoint, tokenizer, prefix and target SHA-256 identities required')
    require(training['identity'] == serving['identity'], 'Training and serving checkpoint/public prefix identity differs')
    first, maximum, count = None, 0.0, 0
    for field in ('mean', 'logScale'):
        left, right = training['conditional'][field], serving['conditional'][field]
        for item in (left, right):
            require(isinstance(item.get('shape'), list) and item['shape'] and
                    all(type(n) is int and n > 0 for n in item['shape']) and
                    math.prod(item['shape']) == len(item.get('values', [])) <= 1048576 and
                    all(type(v) in (int, float) and math.isfinite(v) for v in item['values']),
                    'Native conditional tensor shape, size or finite values invalid')
        if left['shape'] != right['shape']:
            first = first or {'field': field, 'reason': 'shape', 'training': left['shape'], 'serving': right['shape']}
            continue
        for index, (a, b) in enumerate(zip(left['values'], right['values'], strict=True)):
            difference = abs(a - b); maximum = max(maximum, difference); count += 1
            if difference > atol + rtol * abs(a) and first is None:
                first = {'field': field, 'flatIndex': index, 'training': a, 'serving': b, 'absoluteDifference': difference}
    encoder_match = training.get('encoderCallSha256') == serving.get('encoderCallSha256')
    return {'status': 'passed' if first is None else 'failed', 'identity': training['identity'],
            'absoluteTolerance': atol, 'relativeTolerance': rtol, 'comparedCoordinates': count,
            'maximumAbsoluteDifference': maximum, 'firstDivergence': first,
            'encoderCallAuditIdentical': encoder_match,
            'scope': 'Only the first-event native policy Gaussian for this exact checkpoint and public prefix',
            'downstreamLexicalAndActionParity': 'unmeasured',
            'interpretation': 'A Gaussian mismatch establishes divergent native conditional state. Agreement does not establish equal lexical/terminal decoding or learned execution.'}


def decoder_support_comparison(source_path, serving):
    """Bind a narrow source-defined support audit; do not infer unknown revisions.

    The original raw trainer body directly normalizes over all length rows and
    valid_bytes. A changed body invalidates that interpretation instead of
    silently carrying it forward to a new architecture.
    """
    source = Path(source_path).read_text()
    methods = [node for node in ast.walk(ast.parse(source))
               if isinstance(node, ast.FunctionDef) and node.name == '_teacher_raw_impl']
    if len(methods) != 1:
        return {'status': 'unmeasured', 'reason': 'Unknown native raw-decoder source boundary'}
    body_sha = hashlib.sha256(ast.get_source_segment(source, methods[0]).encode()).hexdigest()
    if body_sha != RAW_DECODER_SOURCE_SHA256:
        return {'status': 'unmeasured', 'reason': 'Raw-decoder implementation changed; recapture actual support',
                'nativeMethodSha256': body_sha}
    inventory = serving['decoderBufferInventory']
    specs = serving['servingCall']['specs']
    require(len(specs) == 1 and specs[0]['text_kind'] == 'utf8' and not specs[0]['schemas'],
            'Support audit is limited to the actual plain UTF-8 semantic action')
    spec = specs[0]
    training_length = [0, inventory['lengthHeadRows'] - 1]
    serving_length = [spec['min_tokens'], min(spec['max_tokens'], inventory['lengthHeadRows'] - 1)]
    training_terminal = list(range(inventory['terminalHeadRows']))
    serving_terminal = [0, 1] if spec['require_terminal'] is None else [int(spec['require_terminal'])]
    lexical_match = not inventory['bytesOnlyIds'] and not inventory['utf8OnlyIds']
    match = training_length == serving_length and training_terminal == serving_terminal and lexical_match
    return {'status': 'source-defined-agreement' if match else 'source-defined-mismatch',
            'nativeMethodSha256': body_sha, 'trainingLengthInclusive': training_length,
            'servingLengthInclusive': serving_length, 'trainingTerminalIds': training_terminal,
            'servingTerminalIds': serving_terminal, 'lexicalAlphabetSupportMatches': lexical_match,
            'trainingLexicalAlphabet': 'bytes', 'servingLexicalAlphabet': spec['text_kind'],
            'scope': 'Exact bound trainer source, actual loaded head/alphabet buffers and actual serving request; downstream head execution not measured'}
